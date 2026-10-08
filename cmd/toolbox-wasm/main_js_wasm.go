//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"sync"
	"syscall/js"

	// 导入器靠 init 注册。纯浏览器环境只导入不需要外部可执行文件的三类：
	// PDF、图片和 Markdown。缺哪个，capabilities 的清单就少哪一项，
	// 而运行时 Convert 会报"不支持导入格式"，两处不会不一致。
	_ "github.com/zc310/ofd/pkg/converter/import/image"
	_ "github.com/zc310/ofd/pkg/converter/import/markdown"
	_ "github.com/zc310/ofd/pkg/converter/import/pdf"

	"github.com/zc310/ofd/pkg/analyzer"
	"github.com/zc310/ofd/pkg/validator"
)

// wasmApp 持有跨调用共享的状态。WASM 里没有可依赖的全局可变状态，
// 而打开的文档、注册的字体和进行中的任务都要活过单次调用，统一挂在
// app 上由互斥量保护。
type wasmApp struct {
	mu        sync.Mutex
	documents map[uint64]*documentHandle
	fonts     []fontEntry
	jobs      map[uint64]*wasmJob
	// reports 暂存已生成待导出的校验报告。取出即删，避免每跑一次校验
	// 就在 wasm 内存里多留一份 Issue 列表。
	reports map[uint64]validator.Report
	// analyses 暂存分析报告，与 reports 同样只保留最新一份。
	analyses map[uint64]analyzer.Report
	nextID   uint64
}

func newWasmApp() *wasmApp {
	return &wasmApp{
		documents: make(map[uint64]*documentHandle),
		jobs:      make(map[uint64]*wasmJob),
	}
}

func main() {
	app := newWasmApp()
	api := js.Global().Get("Object").New()

	// 所有命令都过 safe：js.FuncOf 的回调里一旦 panic，wasm 实例就整个
	// 死掉，之后每一次调用都是 "Go program has already exited"，已打开的
	// 文档和缓存的报告全部丢失，界面只能整页刷新。第三方库里最容易 panic
	// 的是找不到系统字体的路径（font.FindSystemFonts 在无字体目录的环境
	// 里解引用 nil），这类错误不该让整个会话报废，因此在边界上兜住。
	expose := func(name string, fn wasmCommand) {
		api.Set(name, js.FuncOf(func(this js.Value, args []js.Value) any {
			return safe(name, fn, args)
		}))
	}

	// 能力清单：转换 Tab 的格式卡片和参数面板全部由它驱动。
	expose("capabilities", app.capabilities)

	// 文档载入与预览。openDocument 返回文档 ID，后续调用都带这个 ID，
	// 而不是复用全局当前文档：批量处理时多个文档要能同时存在。
	expose("openDocument", app.openDocument)
	expose("closeDocument", app.closeDocument)
	expose("documentInfo", app.documentInfo)
	expose("renderPage", app.renderPage)
	expose("renderThumbnails", app.renderThumbnails)

	// 字体回退。OFD 内未嵌入字体时用它兜底，否则预览和 PDF 里的
	// 中文会变成方块。
	expose("addFallbackFont", app.addFallbackFont)
	expose("removeFallbackFont", app.removeFallbackFont)
	expose("listFallbackFonts", app.listFallbackFonts)

	// 转换。返回 Promise，进度经 progress 回调上报，产物字节经
	// onChunk 回调分块下发。
	expose("startConvert", app.startConvert)
	expose("cancelJob", app.cancelJob)

	// 内部流转接口，供 worker 使用，不属于网页直接调用的 API：
	// streamAck 确认某一块已经落盘，形成对 wasm 的背压。
	expose("streamAck", app.streamAck)

	// 校验。报告留在 wasm 侧，导出时按报告 ID 取回。
	expose("validateDocument", app.validateDocument)
	expose("validateExport", app.validateExport)

	// 分析。概览与重章节分开取，千页文档不必一次传 1MB JSON。
	expose("analyzeDocument", app.analyzeDocument)
	expose("analyzeSection", app.analyzeSection)
	expose("analyzeExport", app.analyzeExport)

	// 发票抽取。一次调用出结构化结果，无需暂存报告。
	expose("extractInvoice", app.extractInvoice)

	// 水印。产物是一个新的 OFD 包，因此与转换同样走分块 + ACK 的流式路径。
	expose("watermarkInventory", app.watermarkInventory)
	expose("applyWatermark", app.applyWatermark)

	// 合并。同样是"读入多个文档、产出整个 OFD"，复用同一条流式通道。
	expose("mergeDocuments", app.mergeDocuments)

	// 长期保存。预检只读、执行才写，因此是两个命令。
	expose("preservePlan", app.preservePlan)
	expose("preserveApply", app.preserveApply)

	// 诊断。WASM 线性内存只增不减，大文档必须能看到占用。
	expose("memoryStats", app.memoryStats)
	expose("gc", app.gc)

	// 冒烟测试专用：故意 panic，用来确认 safe() 确实兜得住。
	//
	// 真实触发路径是 PDF 报告——validator 会去找系统中文字体，而
	// font.FindSystemFonts 在无字体目录的 WASM 环境里解引用 nil。
	// 这里用 nil map 赋值触发同样的 runtime panic，成本更低且不依赖字体。
	expose("__panicProbe", func(js.Value, []js.Value) any {
		var m map[string]any
		m["boom"] = 1
		return nil
	})

	js.Global().Set("toolbox", api)

	// 控制台横幅。放在 WASM 侧而不是 worker.js 里：只有这里知道引擎的真实
	// 状态——导入器注册齐不齐，JS 侧看不到。
	logBanner()

	// WASM 侧不能返回：返回即终止实例，之后所有调用都是 "instance closed"。
	// 工作生命周期完全由 worker 侧的 onmessage 驱动。
	select {}
}

// 横幅配色，取自 toolbox.css 的自定义属性，跟界面同一套色。
//
// 控制台样式拿不到 CSS 变量：这段代码跑在 Worker 里，没有 document，
// 也读不到页面的深色模式。因此这里写死亮色主题的值——深色下 Console
// 背景本来就是深灰，#667188 仍然读得清。
const (
	bannerAccent = "color:#2476bd;font-weight:700;font-size:15px"
	bannerMuted  = "color:#667188"
	bannerLink   = "color:#2f7d4a;font-weight:600"
)

/**
 * logBanner 在控制台打一条启动横幅。
 *
 * 用 console.log 的 %c 而不是拼 ANSI 转义：转义序列只在支持它的终端里生效，
 * 浏览器控制台会原样显示一堆 ^[ 乱码；%c 由开发者工具自己解析，能取到主题色。
 *
 * 代价是不支持 %c 的引擎（部分旧版 Safari）会把样式串当普通文本打出来，
 * 横幅变成带 %c 的裸文字。内容都是短句，可读性还在，认这个代价。
 *
 * 注意分两次取 console：console 上没有 Call 方法，必须先 Get 到 console 对象。
 */
func logBanner() {
	console := js.Global().Get("console")
	// 分隔线用短横线而不是制表符画的方框：非等宽字体下方框线会错位。
	console.Call("log", "%c────────────────────────────────────────", bannerMuted)
	console.Call("log", "%cOFD 工具箱%c  引擎已就绪", bannerAccent, bannerMuted)
	console.Call("log", "%c基于 Go + WebAssembly 构建 · 全部处理在本机完成，文件不上传", bannerMuted)
	// %c 之间不能靠参数分隔，缺一个空格会粘成"GitHub: https"。
	console.Call("log", "%cGitHub: %chttps://github.com/zc310/ofd-toolbox", bannerMuted, bannerLink)
}

// allocateID 生成文档与任务 ID。0 保留给"无 ID"，因此这里从 1 开始。
func (a *wasmApp) allocateID() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	return a.nextID
}

// parseDocumentID 从参数取出文档 ID。
func parseDocumentID(args []js.Value, name string) (uint64, error) {
	if len(args) != 1 || args[0].Type() != js.TypeNumber {
		return 0, errors.New(name + " 需要一个文档 ID")
	}
	id := uint64(args[0].Int())
	if id == 0 {
		return 0, errors.New(name + " 的文档 ID 无效")
	}
	return id, nil
}

// parseJobID 从参数取出任务 ID。
func parseJobID(args []js.Value, name string) (uint64, error) {
	if len(args) != 1 || args[0].Type() != js.TypeNumber {
		return 0, errors.New(name + " 需要一个任务 ID")
	}
	id := uint64(args[0].Int())
	if id == 0 {
		return 0, errors.New(name + " 的任务 ID 无效")
	}
	return id, nil
}

// wasmCommand 是所有对外命令的签名。
type wasmCommand func(js.Value, []js.Value) any

// safe 在命令边界上兜住 panic，把它变成一条正常的错误结果。
//
// 不这么做的话，任意一次 panic 都会终止整个 wasm 实例：Go 运行时退出后
// 所有后续调用都报 "Go program has already exited"，已经打开的文档、缓存的
// 校验与分析报告、以及正在跑的转换任务一起没了，界面只能整页刷新。
//
// 之所以必须在这里兜而不是让各处自己判断，是因为 panic 来自第三方库：
// 例如 canvas 找不到系统中文字体时 font.FindSystemFonts 会解引用 nil，
// 调用方拿到的是崩溃而不是 error，没法写 if err != nil。
func safe(name string, fn wasmCommand, args []js.Value) (result any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = errorValue(fmt.Errorf("%s 失败：%v", name, recovered))
		}
	}()
	return fn(js.Undefined(), args)
}
