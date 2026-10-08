# OFD 工具箱

在浏览器里转换与检查 OFD 文档的纯前端工具箱。整个应用编译成一个 WebAssembly
模块，文件不上传，处理全在本机完成——没有服务端，也没有账号。

底层能力来自 [`zc310/ofd`](https://github.com/zc310/ofd) 这个 Go 工具包。
本仓库负责把它包成浏览器可用的形态：WASM 构建、Worker 调度、流式产物传输、
Service Worker 缓存与界面。

在线使用：<https://zc310.github.io/ofd-toolbox/>

## 功能

| 能力 | 说明 |
|------|------|
| **格式转换** | OFD 转 PDF、PNG/JPG/TIFF、SVG、EPS、TeX、单文件 HTML、纯文本、Markdown、Word；PDF、PNG/JPG/TIFF、Markdown 转 OFD |
| **文档校验** | 校验 ZIP、XML、引用关系与 XSD，报告可导出为 JSON / Markdown / 纯文本 |
| **结构分析** | 页面对象、文字、资源、附件、注解、签名与引用关系概览，分章节展开 |
| **发票抽取** | 从增值税电子发票 OFD 中读取结构化附件并输出 JSON |
| **水印** | 在所选页添加、替换或删除文字/图片水印，支持布局、旋转、透明度和字体 |
| **文档合并** | ZIP 级合并产出多文档包（保留原有资源与签名摘要），或模型级拼页产出单文档 |
| **长期保存** | 按 GB/T 42133 第 6 章预检与执行，含删除无人引用条目 |

界面不硬编码任何格式名或参数名——转换 Tab 的格式卡片、参数面板显隐与校验
Tab 的可选项全部由 WASM 侧的 `capabilities` 清单驱动。库里增删格式时界面自动
跟随，不需要两处同步。

## 构建和运行

在仓库根目录执行：

```bash
make build-wasm
python3 -m http.server 8080 --directory cmd/toolbox-wasm/web
```

然后打开 <http://localhost:8080>。浏览器不能通过 `file://` 加载 WASM，必须走
HTTP 服务。

`make build-wasm` 做三件事：编译 `toolbox.wasm`、按需用 `wasm-opt` 优化、从
GOROOT 复制 `wasm_exec.js`，最后按各资源的内容哈希重算 `service-worker.js`
里的缓存名。`wasm-opt` 找不到时会告警并改用未优化版本，不让构建直接失败。

`make help` 列出全部目标。

## 架构

```
cmd/toolbox-wasm/
├── *.go            WASM 侧命令，每个文件带 //go:build js && wasm
└── web/            页面资源（无框架、无构建步骤，直接就是浏览器要的东西）
    ├── index.html  单页，7 个工具 Tab
    ├── app.js      主线程：界面、状态、Worker 消息
    ├── worker.js   Worker：WASM 装载、命令分发、流式产物接收
    └── toolbox.wasm  构建产物，50MB 量级，不入库
```

几个不显眼但影响体验的决定：

**WASM 跑在 Worker 里。** 模块有 50MB 量级，装载和计算都在主线程的话页面会
长时间不可交互——进度条卡住、取消按钮点不动、滚动条卡死。

**产物分块下发，由 Worker 内部确认（ACK）。** WASM 回调给出块，写进接收端后
立刻确认，下一块才生成。这不是优化：少了确认，中间产物会堆在 WASM 内存里，
50MB 的模块再加一份未落盘的产物足以让浏览器直接杀掉标签页。ACK 不经过主
线程，因为主线程此时无事可做，绕一圈只多一次消息投递延迟。

**命令边界统一兜 panic。** 第三方库里最容易崩的是找不到系统字体的路径
（`font.FindSystemFonts` 在无字体目录的环境里解引用 nil），这类错误不是
`error` 而是直接 panic，调用方写不了 `if err != nil`。不在边界上兜住的话，
一次 panic 就终止整个 WASM 实例，已打开的文档、缓存的报告和正在跑的任务
一起丢失，只能整页刷新。

**Service Worker 缓存名由内容哈希算出。** 页面的 HTML、JS 与 WASM 必然是同一
版本，不会出现新 JS 调旧 WASM。代价是换版要用户点一次：新的 Service Worker
只在下次打开时接管。

**字体只取本机或用户上传的文件。** 不联网取字体。OFD 未内嵌字体时可以选多个
本机字体兜底，候选列表会标出哪些能补齐文档缺字、哪些已注册。

## 依赖替换

`go.mod` 里几处 `replace` 必须在**本项目**重新声明——Go 不继承依赖的 replace
指令，漏掉会编译失败或行为不对：

| 依赖 | 换成 | 原因 |
|------|------|------|
| `github.com/tdewolff/font` | `zc310/font` | PDF 输出的字形处理需要 |
| `github.com/tdewolff/canvas` | `zc310/canvas` | 渐变 `Extend` 等字段在修改版上；版本要与 ofd 侧一致 |
| `github.com/lumifloat/tinyskia` | `zc310/tinyskia` | 文本排版 |
| `github.com/kovidgoyal/imaging` | 含 `magick_js.go` 的 pseudo-version | `magick` 子包在 js/wasm 下需要 `go-shm`，上游已合入，等 v1.8.24 发布后可简化为 `v1.8.24` |

`github.com/zc310/ofd` 是普通的线上依赖，没有 replace，因此 CI 不需要额外签出
该仓库。版本目前固定到具体提交而非 tag，等所需改动发版后改回 `v1.x.y`。

## 持续集成与发布

| workflow | 触发 | 做什么 |
|----------|------|--------|
| `.github/workflows/go.yml` | push / PR 到 `main` | `go mod tidy` 漂移检查、`go vet`、js/wasm 构建、`make build-wasm` |
| `.github/workflows/pages.yml` | `main` 上特定路径变化 / 手动 | 装 binaryen 133、优化构建、发布到 GitHub Pages |

两个 workflow 都不跑测试：`cmd/toolbox-wasm/web/test/` 与 `browser-test/`
目前尚未入库，`make test` 在干净检出的仓库里必然失败。测试代码入库后补上。

`go.yml` 不装 binaryen——未优化的 WASM 足够证明能编译，而要发布的才是优化过
的产物。`pages.yml` 装官方 release 的预编译 binaryen，不用 apt 的：noble 源里
只有 108，而 `Makefile` 的 `WASM_OPT_FLAGS` 含三个 108 不认的开关。

## 已知边界

- **Office 与 HTML 输入不可用。** docx/odt/rtf/wps/pptx/xlsx 和 html/mhtml 依赖
  LibreOffice 或 Chrome 命令行，浏览器里没有。界面仍然接受这些文件并说明缺什么，
  免得用户只能在失败之后才明白原因。
- **不提供 XLSX 与 PDF 格式的报告导出。** XLSX 要带 excelize 进来，实测让 WASM
  从 51.3MB 涨到 61.4MB、gzip 多 2MB；PDF 报告要嵌入中文字体，而浏览器里没有
  系统字体目录。校验与分析报告可导出 JSON / Markdown / 纯文本。
- **首次加载要下载 50MB 量级的模块**，之后由 Service Worker 缓存。
- **OFD 支持范围以 [`zc310/ofd` 的文档为准](https://github.com/zc310/ofd/blob/main/docs/OFD-SUPPORT.md)**，
  不同厂商的 OFD 存在扩展差异。