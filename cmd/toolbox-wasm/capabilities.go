//go:build js && wasm

package main

import (
	"errors"
	"sort"
	"syscall/js"

	"github.com/zc310/ofd/pkg/converter"
)

// 浏览器能力矩阵。转换 Tab 的格式卡片、参数面板显隐和校验 Tab 的可选项
// 全部由这份清单驱动：前端不硬编码任何格式名或参数名，库侧增删格式时
// 界面自动跟随，不需要两处同步。

// wasmFormat 是单个输出格式的描述。
//
// json tag 决定字段在网页侧的键名：界面按小写驼峰取值，而 Go 侧的
// 导出规则会把无 tag 的字段名原样送出去（Name 而不是 name）。两处
// 不一致时报错信息只会是"undefined 是 undefined"，很难定位。
type wasmFormat struct {
	Name       string   `json:"name"`
	Label      string   `json:"label"`
	Kind       string   `json:"kind"`
	Extensions []string `json:"extensions"`
	MIME       string   `json:"mime"`
}

// wasmImportKind 说明某种输入格式在浏览器里能做到哪一步。
type wasmImportKind string

const (
	// importDirect 有纯 Go 实现，可直接转 OFD 或其它注册输出格式。
	importDirect wasmImportKind = "direct"
	// importNeedsTool 需要外部可执行文件（LibreOffice、Chrome、Tesseract），
	// 浏览器里不可用。界面仍展示该输入格式，但目标组合不可选并给出原因。
	importNeedsTool wasmImportKind = "needs_tool"
)

// wasmInputFormat 是单个输入格式的描述。
type wasmInputFormat struct {
	Name       string         `json:"name"`
	Label      string         `json:"label"`
	Extensions []string       `json:"extensions"`
	MIME       string         `json:"mime"`
	Kind       wasmImportKind `json:"kind"`
	// Tools 列出该格式在纯浏览器环境缺失的外部依赖，界面据此提示用户。
	Tools []string `json:"tools"`
	// Targets 是该输入可用的目标格式名；纯浏览器环境里不含 needs_tool 的输入。
	Targets []string `json:"targets"`
}

// formatLabels 给注册名补上界面文案。converter 侧的注册名是英文机器名，
// 直接显示对非技术用户没有意义；这里只覆盖已知的展示名，未覆盖的用注册名。
var formatLabels = map[string]string{
	"pdf":      "PDF 文档",
	"png":      "PNG 图片",
	"jpeg":     "JPG 图片",
	"tiff":     "TIFF 图片",
	"svg":      "SVG 矢量图",
	"eps":      "EPS 矢量图",
	"tex":      "TeX 矢量图",
	"html":     "单文件 HTML",
	"docx":     "Word 文档",
	"text":     "纯文本",
	"markdown": "Markdown",
}

// inputLabels 覆盖输入格式的界面文案。
var inputLabels = map[string]string{
	"ofd":      "OFD 版式文档",
	"pdf":      "PDF 文档",
	"png":      "PNG 图片",
	"jpeg":     "JPG 图片",
	"tiff":     "TIFF 图片",
	"markdown": "Markdown",
	"docx":     "Word 文档",
	"doc":      "Word 文档",
	"odt":      "OpenDocument 文本",
	"rtf":      "RTF 文档",
	"wps":      "WPS 文档",
	"pptx":     "PowerPoint 演示",
	"xlsx":     "Excel 表格",
	"html":     "HTML 网页",
	"mhtml":    "MHTML 网页",
}

// browserUnsupported 是那些依赖外部可执行文件的输入格式，以及各自缺什么。
//
// 这张表与注册表是两回事：没有 import 的 office 与 html 导入器根本不会
// 出现在 converter.ImportFormats() 里，但界面仍然需要知道"拖进来一个 docx
// 会失败、因为要 LibreOffice"。只靠注册表的话，用户只能在失败之后才明白
// 原因，那条提示就失去了意义。
var browserUnsupported = map[string]struct {
	tool   string
	labels []string
}{
	"docx":  {"LibreOffice", []string{".docx"}},
	"doc":   {"LibreOffice", []string{".doc"}},
	"odt":   {"LibreOffice", []string{".odt"}},
	"rtf":   {"LibreOffice", []string{".rtf"}},
	"wps":   {"LibreOffice", []string{".wps"}},
	"pptx":  {"LibreOffice", []string{".pptx"}},
	"xlsx":  {"LibreOffice", []string{".xlsx"}},
	"html":  {"Chrome 或 Chromium", []string{".html", ".htm"}},
	"mhtml": {"Chrome 或 Chromium", []string{".mhtml", ".mht"}},
}

// capabilities 返回浏览器环境下可用的输入与输出格式清单。
//
// 前端只渲染这里列出的组合，不给用户看会失败的选项；这不是保守，而是
// 纯 WASM 的真实边界：libreoffice、chrome、tesseract 都要外部进程。
func (a *wasmApp) capabilities(_ js.Value, args []js.Value) any {
	if len(args) > 0 {
		return errorValue(errors.New("capabilities 不接受参数"))
	}
	// 从注册表读，不维护自己的格式列表：新增编码器或导入器后界面自动出现。
	outputs := make([]wasmFormat, 0, len(converter.Formats()))
	for _, format := range converter.Formats() {
		outputs = append(outputs, wasmFormat{
			Name:       format.Name,
			Label:      formatLabel(format.Name),
			Kind:       formatKindName(format.Kind),
			Extensions: format.Extensions,
			MIME:       format.MIME,
		})
	}

	// OFD 不在编码器注册表里：它不走 encoder，而是走导入器路径（X→OFD，
	// 见 converter.Convert 的 to=="ofd" 分支）。因此要显式补进输出清单，
	// 否则 PDF/图片等输入的目标里根本没有 OFD——转换能力是有的，界面上
	// 却不给这个选项。
	outputs = append(outputs, wasmFormat{
		Name:       "ofd",
		Label:      inputLabels["ofd"],
		Kind:       "document",
		Extensions: []string{".ofd"},
		MIME:       "application/ofd",
	})
	allTargets := outputNames(outputs)

	// OFD 是所有已注册编码器的天然输入，单独作为一项列在最前。
	inputs := []wasmInputFormat{{
		Name:       "ofd",
		Label:      inputLabels["ofd"],
		Extensions: []string{".ofd"},
		MIME:       "application/ofd",
		Kind:       importDirect,
		Targets:    targetsFor("ofd", allTargets),
	}}

	// 已注册且浏览器可用的输入格式。ImportFormats 返回名称，逐个查回扩展名
	// 以便界面按类型过滤文件。
	for _, name := range converter.ImportFormats() {
		importer, ok := converter.ImporterByName(name)
		if !ok {
			continue
		}
		inputs = append(inputs, wasmInputFormat{
			Name:       importer.Name(),
			Label:      inputLabels[importer.Name()],
			Extensions: importer.Extensions(),
			MIME:       importer.MIME(),
			Kind:       importDirect,
			Targets:    targetsFor(importer.Name(), allTargets),
		})
	}

	// 需要外部可执行文件的输入格式也列出来，但不给目标：界面显示一条
	// 说明为什么不可用，而不是让用户拖进来之后才看到一个看不懂的失败。
	for _, name := range sortedUnsupported() {
		entry := browserUnsupported[name]
		inputs = append(inputs, wasmInputFormat{
			Name:       name,
			Label:      inputLabels[name],
			Extensions: entry.labels,
			Kind:       importNeedsTool,
			Tools:      []string{entry.tool},
		})
	}

	return objectValue(map[string]any{
		"inputs":  inputs,
		"outputs": outputs,
		// 单页 TIFF 等格式的界面限制随清单一起下发，避免写死在前端。
		"notes": []string{
			"OFD 导出 PDF 为矢量输出并保持页面物理尺寸，不使用 DPI。",
			"OFD 导出 TXT 与 Markdown 不使用 DPI 和背景颜色。",
			"图片类输出按所选页面逐页导出，多页结果打包为 ZIP。",
			"纯浏览器环境无法运行 LibreOffice、Chrome 和 Tesseract，相关输入格式不可转换。",
			"图片转 OFD 不含 OCR，因此生成的 OFD 只有图像、没有文字层。",
		},
	})
}

// sortedUnsupported 返回需要外部工具的输入格式名，按字典序。
// 顺序稳定才能让界面上的顺序不随 Go 的 map 迭代随机变化。
func sortedUnsupported() []string {
	names := make([]string, 0, len(browserUnsupported))
	for name := range browserUnsupported {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func formatLabel(name string) string {
	if label, ok := formatLabels[name]; ok {
		return label
	}
	return name
}

func inputLabel(name string) string {
	if label, ok := inputLabels[name]; ok {
		return label
	}
	return name
}

func formatKindName(kind converter.Kind) string {
	if kind == converter.KindImage {
		return "image"
	}
	return "document"
}

// targetsFor 返回某个输入可用的目标格式：从全部输出里去掉它自己。
//
// 同格式互转在界面上没有意义（PDF 文件还摆一个"转成 PDF"），用户只会困惑
// 这是不是在做压缩。OFD 也一样：converter 会直接拒绝 OFD→OFD。
func targetsFor(inputName string, all []string) []string {
	targets := make([]string, 0, len(all))
	for _, name := range all {
		if name != inputName {
			targets = append(targets, name)
		}
	}
	return targets
}

func outputNames(outputs []wasmFormat) []string {
	names := make([]string, 0, len(outputs))
	for _, format := range outputs {
		names = append(names, format.Name)
	}
	return names
}
