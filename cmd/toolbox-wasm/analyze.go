//go:build js && wasm

package main

import (
	"bytes"
	"errors"
	"fmt"
	"syscall/js"

	"github.com/zc310/ofd/pkg/analyzer"
)

// 分析 Tab 的 binding。
//
// analyzer.Report 的字段带完整 json tag，可以整体交给 JSON 编码再拆成 JS 值，
// 不必像校验报告那样逐字段手写映射——那是 validator.Report 缺 tag 才需要的
// 绕法。
//
// 但整份报告不一次性送进网页：千页文档加上包目录树后 JSON 有 1MB 上下，
// 而用户多数时候只看概览。因此拆成"概览 + 按需取章节"：概览里是统计、
// 文档体与签名摘要，重的东西（页列表、目录树、引用关系）由界面按需来取。

// maxAnalyzeSignatures 是签名卡片在概览里保留的上限。
//
// 签名的完整字段（含两层证书与摘要逐项校验）很占体积，而概览只需要
// "有几个签名、摘要是否一致、验签是否通过"这几项。
const maxAnalyzeSignatures = 32

// analyzeDocument 分析一个已打开的文档，返回概览与报告 ID。
func (a *wasmApp) analyzeDocument(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorValue(errors.New("analyzeDocument 需要文档 ID"))
	}
	id := uint64(args[0].Int())
	data, name, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}

	source := js.Undefined()
	if len(args) >= 2 {
		source = args[1]
	}
	options := analyzeOptionsFromJS(source)

	// analyzer.Analyze 不接 context：内部没有可取消点，传了也无处用。
	// 超长文档只能整份跑完，这是库侧的限制，不是这里漏了。
	report, err := analyzer.Analyze(data, analyzerOptions(options)...)
	if err != nil {
		return errorValue(err)
	}
	if name != "" {
		report.Input.Path = name
	}
	if report.Input.Size == 0 {
		report.Input.Size = int64(len(data))
	}

	reportID := a.storeAnalysis(report)
	return objectValue(map[string]any{
		"reportId": reportID,
		"report":   analyzeOverview(report),
	})
}

// analyzeSection 按需取报告的一个章节。
//
// 章节单独取而不是一次性全给：千页文档的页列表与目录树合计约 1MB JSON，
// 用户不翻到那一页时就不该为它付出解析与渲染的代价。
func (a *wasmApp) analyzeSection(_ js.Value, args []js.Value) any {
	if len(args) < 2 || args[0].Type() != js.TypeNumber || args[1].Type() != js.TypeString {
		return errorValue(errors.New("analyzeSection 需要报告 ID 和章节名"))
	}
	report, ok := a.peekAnalysis(uint64(args[0].Int()))
	if !ok {
		return errorValue(errors.New("报告不存在或已被新报告替换"))
	}
	section := args[1].String()
	value, err := analysisSection(report, section)
	if err != nil {
		return errorValue(err)
	}
	// 章节走 JSON 往返：这些模型字段都带 json tag，键名要跟着标签走。
	items, err := jsonValue(value)
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{"section": section, "items": items})
}

// analysisSection 取报告的某个章节。
func analysisSection(report analyzer.Report, section string) (any, error) {
	switch section {
	case "tree":
		if report.Package.Tree == nil {
			return nil, errors.New("本次分析未生成包目录树")
		}
		return report.Package.Tree, nil
	case "pages":
		return report.Pages, nil
	case "documents":
		return report.Documents, nil
	case "resources":
		return report.ResourceDetails, nil
	case "attachments":
		return report.Attachments, nil
	case "annotations":
		return report.Annotations, nil
	case "signatures":
		return report.Signatures, nil
	case "fileReferences":
		return report.FileReferences, nil
	case "idReferences":
		return report.IDReferences, nil
	default:
		return nil, fmt.Errorf("未知章节 %q", section)
	}
}

// analyzeExport 导出分析报告。
//
// 只开放 JSON、Markdown 与文本：PDF 需要系统中文字体，浏览器里没有；
// XLSX 对分析报告用处不大（表格已在页面上），带着 excelize 进来也不值。
func (a *wasmApp) analyzeExport(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeNumber {
		return errorValue(errors.New("analyzeExport 需要报告 ID"))
	}
	format := "json"
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		format = normalizeFormat(args[1].String())
	}
	report, ok := a.peekAnalysis(uint64(args[0].Int()))
	if !ok {
		return errorValue(errors.New("报告不存在或已被新报告替换"))
	}

	var buffer bytes.Buffer
	var name, mime string
	var err error
	switch format {
	case "json":
		data, marshalErr := marshalJSON(report)
		err = marshalErr
		buffer.Write(data)
		name, mime = "analysis.json", "application/json"
	case "markdown", "md":
		err = analyzer.RenderMarkdown(&buffer, report)
		name, mime = "analysis.md", "text/markdown"
	case "text", "txt":
		err = analyzer.RenderText(&buffer, report)
		name, mime = "analysis.txt", "text/plain"
	default:
		return errorValue(fmt.Errorf("不支持的报告格式 %q", format))
	}
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{"name": name, "mime": mime, "data": buffer.Bytes()})
}

// analyzeOptions 是分析选项。
type analyzeOptions struct {
	tree        bool
	templates   bool
	annotations bool
	signatures  bool
}

// analyzeOptionsFromJS 读取分析选项。
func analyzeOptionsFromJS(value js.Value) analyzeOptions {
	options := analyzeOptions{
		templates:   true,
		annotations: true,
		signatures:  true,
	}
	if value.Type() != js.TypeObject {
		return options
	}
	options.tree = optionalBool(value, "tree", false)
	options.templates = optionalBool(value, "templates", true)
	options.annotations = optionalBool(value, "annotations", true)
	options.signatures = optionalBool(value, "signatures", true)
	return options
}

// analyzerOptions 翻译成 analyzer 的 Option。
func analyzerOptions(options analyzeOptions) []analyzer.Option {
	return []analyzer.Option{
		analyzer.WithTree(options.tree),
		analyzer.WithTemplates(options.templates),
		analyzer.WithAnnotations(options.annotations),
		analyzer.WithSignatures(options.signatures),
	}
}

// analyzeOverview 取概览：统计、文档体、资源汇总与签名摘要。
func analyzeOverview(report analyzer.Report) map[string]any {
	signatures := report.Signatures
	truncatedSignatures := 0
	if len(signatures) > maxAnalyzeSignatures {
		truncatedSignatures = len(signatures) - maxAnalyzeSignatures
		signatures = signatures[:maxAnalyzeSignatures]
	}
	return map[string]any{
		"schemaVersion":       report.SchemaVersion,
		"tool":                report.Tool,
		"input":               report.Input,
		"status":              string(report.Status),
		"ofd":                 report.OFD,
		"warnings":            report.Warnings,
		"errors":              report.Errors,
		"package":             analyzePackage(report.Package),
		"summary":             report.Summary,
		"objects":             report.Objects,
		"text":                report.Text,
		"documents":           report.Documents,
		"resources":           resourcesBlock(report),
		"signatures":          analyzeSignatures(signatures),
		"signaturesTruncated": truncatedSignatures,
		"counts": map[string]any{
			"documents":      len(report.Documents),
			"pages":          len(report.Pages),
			"resources":      len(report.ResourceDetails),
			"attachments":    len(report.Attachments),
			"annotations":    len(report.Annotations),
			"signatures":     len(report.Signatures),
			"fileReferences": len(report.FileReferences),
			"idReferences":   len(report.IDReferences),
		},
	}
}

// resourcesBlock 取资源统计。
//
// 字体与绘制参数的统计类型内嵌了通用统计结构，没有 json tag，Go 的 JSON
// 编码会把内嵌部分收成一层嵌套对象（{"ResourceSummary": {...}}）。
// 这里过一遍 JSON 往返再摊平，键名与其它统计保持一致，界面上不必为
// 这两种类型各写一套取值。
func resourcesBlock(report analyzer.Report) map[string]any {
	block := map[string]any{}
	for name, value := range map[string]any{
		"images":      report.Images,
		"fonts":       report.Fonts,
		"drawParams":  report.DrawParams,
		"colorSpaces": report.ColorSpaces,
		"templates":   report.Templates,
		"composites":  report.Composites,
		"patterns":    report.Patterns,
		"total":       report.Resources,
	} {
		// 编码失败时 jsonObject 返回空映射：单个统计缺失不该让整块
		// 概览消失，用户仍能看到其余数字。
		merged := jsonObject(value)
		// 内嵌的通用统计被编码成同名子对象，提到外层。
		if inner, ok := merged["ResourceSummary"].(map[string]any); ok {
			for key, item := range inner {
				merged[key] = item
			}
			delete(merged, "ResourceSummary")
		}
		block[name] = merged
	}
	return block
}

// analyzePackage 取包统计。
//
// 目录树不在这里：它可能上千个节点，概览阶段不需要，界面点开时再取。
func analyzePackage(summary analyzer.PackageSummary) map[string]any {
	// 键名跟着 analyzer 的 json tag（compressed_bytes）。包统计整体是
	// 带 tag 的结构体，这里手写映射就得跟 tag 一致；写成驼峰会让界面上
	// 两个 Tab 的字段风格不一致，取值处静默拿到 undefined。
	return map[string]any{
		"entries":            summary.Entries,
		"files":              summary.Files,
		"directories":        summary.Directories,
		"xml_files":          summary.XMLFiles,
		"compressed_bytes":   summary.CompressedBytes,
		"uncompressed_bytes": summary.UncompressedBytes,
		"has_tree":           summary.Tree != nil,
	}
}

// analyzeSignatures 取签名摘要。
//
// 完整签名信息（含两层证书、摘要逐项校验）由 analyzeSection("signatures")
// 按需取；概览只给判据相关的几项。
func analyzeSignatures(signatures []analyzer.SignatureInfo) []any {
	items := make([]any, 0, len(signatures))
	for _, signature := range signatures {
		items = append(items, map[string]any{
			"id":            signature.ID,
			"documentIndex": signature.DocumentIndex,
			"provider":      signature.Provider,
			"company":       signature.Company,
			"method":        signature.Method,
			"date":          signature.Date,
			"pages":         signature.Pages,
			"stampCount":    signature.StampCount,
			// 三项校验各自分开给，而不是合成一个"有效"：合成后用户
			// 看不出是哪一环出的问题，而档案场景要逐项留痕。
			"digestChecked": signature.DigestChecked,
			"digestValid":   signature.DigestValid,
			"verified":      signature.VerificationChecked && signature.VerificationValid,
			"verifyError":   signature.VerificationError,
			"trusted":       signature.Trusted,
			"sealName":      sealName(signature),
		})
	}
	return items
}

// sealName 取印章名称，没有时回退为空串。
func sealName(signature analyzer.SignatureInfo) string {
	if signature.SealInfo == nil {
		return ""
	}
	return signature.SealInfo.Name
}

// storeAnalysis 保存一份分析报告，丢弃此前的。
func (a *wasmApp) storeAnalysis(report analyzer.Report) uint64 {
	id := a.allocateID()
	a.mu.Lock()
	if a.analyses == nil {
		a.analyses = make(map[uint64]analyzer.Report)
	}
	// 只留最新一份：报告带着完整的页列表与目录树，攒着就是在 wasm
	// 内存里留垃圾。
	a.analyses = map[uint64]analyzer.Report{id: report}
	a.mu.Unlock()
	return id
}

// peekAnalysis 读取一份分析报告但不移除。
//
// 与校验报告同样可重复导出：同一份报告常要同时看 JSON 与 Markdown。
func (a *wasmApp) peekAnalysis(id uint64) (analyzer.Report, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	report, ok := a.analyses[id]
	return report, ok
}
