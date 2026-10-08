//go:build js && wasm

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sort"
	"syscall/js"
	"time"

	"github.com/zc310/ofd/pkg/validator"
)

// 校验 Tab 的 binding。
//
// 报告本身由 pkg/validator 生成（含 XSD、引用闭包、签名摘要与 profile 规则），
// 这里只做两件事：把报告转成界面直接可用的结构，以及把校验选项暴露出去。
// 报告的判定逻辑一行都不重写——重写一份就等于多一处会和上游漂移的实现。

// maxValidateIssues 是单份报告在网页侧保留的问题条数上限。
//
// validator 自己有 MaxErrors 限制，但那是"报告里记多少条"；网页还要把它们
// 全塞进 DOM，十万行表格会把标签页拖死。超出的部分只报数量。
const maxValidateIssues = 5000

// validateOptions 是一次校验的界面选项。
type validateOptions struct {
	mode         validator.Mode
	docType      string
	checkXSD     bool
	scanXML      bool
	checkProfile bool
	checkDigest  bool
	failOnWarn   bool
	maxErrors    int
}

// validateDocument 校验一个已打开的文档，返回报告。
func (a *wasmApp) validateDocument(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorValue(errors.New("validateDocument 需要文档 ID"))
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
	options, err := validateOptionsFromJS(source)
	if err != nil {
		return errorValue(err)
	}

	report, err := runValidation(data, name, options)
	if err != nil {
		return errorValue(err)
	}
	// 报告留在 app 里供导出复用：重新跑一次校验去拿导出文件，
	// 会让「屏幕上这份报告」和「下载的那份」来自两次不同的运行。
	reportID := a.storeReport(report)
	return objectValue(map[string]any{
		"reportId": reportID,
		"report":   validateReportValue(report),
	})
}

// validateExport 按指定格式导出已生成的报告。
//
// 格式直接用 validator 侧的 Render*，它们带中文标签转义、表格拼装与字体
// 嵌入，自绘一份只会少这些细节。
func (a *wasmApp) validateExport(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeNumber {
		return errorValue(errors.New("validateExport 需要报告 ID"))
	}
	reportID := uint64(args[0].Int())
	format := "json"
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		format = normalizeFormat(args[1].String())
	}

	report, ok := a.peekReport(reportID)
	if !ok {
		return errorValue(fmt.Errorf("报告 %d 不存在或已被新报告替换", reportID))
	}
	name, mime, data, err := renderReport(report, format)
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{"name": name, "mime": mime, "data": data})
}

// renderReport 把报告渲染成目标格式的字节。
func renderReport(report validator.Report, format string) (name, mime string, data []byte, err error) {
	var buffer bytes.Buffer
	switch format {
	case "json":
		// 缩进输出：这份文件多数时候是给人读的，接进系统时才转成紧凑格式。
		err = validator.RenderJSON(&buffer, report, true)
		name, mime = "validation.json", "application/json"
	case "markdown", "md":
		err = validator.RenderMarkdown(&buffer, report)
		name, mime = "validation.md", "text/markdown"
	case "text", "txt":
		err = validator.RenderText(&buffer, report)
		name, mime = "validation.txt", "text/plain"
	// 不提供 PDF 与 XLSX：
	//   PDF 报告要嵌入中文字体，validator 会遍历系统字体目录，而浏览器里
	//   没有这个目录。font.FindSystemFonts 在这种情况下解引用 nil，WASM
	//   直接 panic——不是返回 error，是整个实例死掉。界面上不能给一个点
	//   下去就崩的按钮，要等字体回退做完（addFallbackFont 已有）再接上。
	//   XLSX 要带 excelize 进来，实测让 wasm 从 51.3MB 涨到 61.4MB、
	//   gzip 多 2MB。对着一张已经在页面上的表格，值不上这个体积。
	default:
		return "", "", nil, fmt.Errorf("不支持的报告格式 %q", format)
	}
	if err != nil {
		return "", "", nil, err
	}
	return name, mime, buffer.Bytes(), nil
}

// runValidation 执行一次校验。
func runValidation(data []byte, name string, options validateOptions) (validator.Report, error) {
	instance, err := validator.New(validatorOptions(options)...)
	if err != nil {
		return validator.Report{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return instance.ValidateReader(ctx, bytes.NewReader(data), name), nil
}

// validatorOptions 把界面选项翻译成 validator 的 Option。
func validatorOptions(options validateOptions) []validator.Option {
	list := []validator.Option{
		validator.WithMode(options.mode),
		validator.WithSkipXSD(!options.checkXSD),
		validator.WithScanXML(options.scanXML),
		validator.WithCheckProfile(options.checkProfile),
		validator.WithCheckDigest(options.checkDigest),
		validator.WithFailOnWarning(options.failOnWarn),
	}
	if options.docType != "" {
		list = append(list, validator.WithDocType(options.docType))
	}
	if options.maxErrors > 0 {
		list = append(list, validator.WithMaxErrors(options.maxErrors))
	}
	return list
}

// validateOptionsFromJS 读取校验选项。
func validateOptionsFromJS(value js.Value) (validateOptions, error) {
	// 默认值与 validator 自身的默认值一致：网页不传选项时，
	// 界面显示的判据应与库默认判据相同。
	options := validateOptions{
		mode:         validator.ModeStrict,
		checkXSD:     true,
		scanXML:      true,
		checkProfile: true,
		checkDigest:  true,
	}
	if value.Type() != js.TypeObject {
		return options, nil
	}
	if mode := optionalString(value, "mode"); mode != "" {
		switch normalizeFormat(mode) {
		case "compat":
			options.mode = validator.ModeCompat
		case "structural":
			options.mode = validator.ModeStructural
		default:
			options.mode = validator.ModeStrict
		}
	}
	options.docType = optionalString(value, "docType")
	options.checkXSD = optionalBool(value, "checkXSD", options.checkXSD)
	options.scanXML = optionalBool(value, "scanXML", options.scanXML)
	options.checkProfile = optionalBool(value, "checkProfile", options.checkProfile)
	options.checkDigest = optionalBool(value, "checkDigest", options.checkDigest)
	options.failOnWarn = optionalBool(value, "failOnWarning", false)
	// 上限缺省为 0 表示用库的默认值；只有显式给出一个更小的数才覆盖，
	// 免得网页侧写死的默认值反而比库更严。
	limit, err := optionalInt(value, "maxErrors", 0, 0, maxValidateIssues)
	if err != nil {
		return options, err
	}
	options.maxErrors = limit
	return options, nil
}

// validateReportValue 把报告转成界面可用的结构。
//
// 逐字段手写而不是整个 json.Marshal：报告要送进 DOM 并支持按条款筛选，
// 网页侧直接按字段访问才不会拿到 Uint8Array 再自己解 JSON。
// 中文标签也在这里补——validator 的 applyChineseLabels 只在 Render* 内部
// 调用，不导出，因此界面看到的标签由这份映射负责。
func validateReportValue(report validator.Report) map[string]any {
	issues := report.Issues
	truncated := 0
	if len(issues) > maxValidateIssues {
		truncated = len(issues) - maxValidateIssues
		issues = issues[:maxValidateIssues]
	}
	return map[string]any{
		"schemaVersion": report.SchemaVersion,
		"tool": map[string]any{
			"name":    report.Tool.Name,
			"version": report.Tool.Version,
		},
		"input": map[string]any{
			"name": report.Input.Path,
			"size": report.Input.Size,
		},
		"status":      string(report.Status),
		"statusLabel": statusLabel(report.Status),
		"profile":     report.Profile,
		"summary": map[string]any{
			"errors":   report.Summary.Errors,
			"warnings": report.Summary.Warnings,
			"infos":    report.Summary.Infos,
			"files":    report.Summary.Files,
		},
		"checks":     checkResults(report.Checks),
		"issues":     issueValues(issues),
		"truncated":  truncated,
		"durationMS": report.DurationMS,
		"startedAt":  report.StartedAt.UTC().Format(time.RFC3339),
		// clauses 是报告里出现过的全部条款号，供界面做筛选下拉。
		// 档案系统按条款统计，先在界面上给出全集比让用户从表格里
		// 自己归纳要直接得多。
		"clauses": clauseList(issues),
	}
}

// checkResults 转成界面可用的阶段列表。
func checkResults(checks []validator.CheckResult) []any {
	items := make([]any, 0, len(checks))
	for _, check := range checks {
		items = append(items, map[string]any{
			"name":        check.Name,
			"nameLabel":   labelOr(check.NameZh, check.Name),
			"status":      check.Status,
			"statusLabel": labelOr(check.StatusZh, check.Status),
		})
	}
	return items
}

// issueValues 转成界面可用的问题列表。
func issueValues(issues []validator.Issue) []any {
	items := make([]any, 0, len(issues))
	for _, issue := range issues {
		item := map[string]any{
			"severity":      string(issue.Severity),
			"severityLabel": severityLabel(issue.Severity),
			"stage":         string(issue.Stage),
			"stageLabel":    stageLabel(issue.Stage),
			"code":          issue.Code,
			"message":       issue.Message,
			"clause":        issue.Clause,
		}
		// 这几个字段只在有值时给出：DOM 里用 "file" in issue 判断，
		// 比拿空字符串去和真路径比较可靠。
		if issue.Hint != "" {
			item["hint"] = issue.Hint
		}
		if issue.File != "" {
			item["file"] = issue.File
		}
		if issue.Path != "" {
			item["xpath"] = issue.Path
		}
		if issue.Line > 0 {
			item["line"] = issue.Line
		}
		if issue.Column > 0 {
			item["column"] = issue.Column
		}
		items = append(items, item)
	}
	return items
}

// clauseList 汇总报告里出现过的条款号，去重且有序。
func clauseList(issues []validator.Issue) []any {
	seen := make(map[string]bool)
	clauses := make([]string, 0, 8)
	for _, issue := range issues {
		for _, clause := range issue.Clause {
			if clause == "" || seen[clause] {
				continue
			}
			seen[clause] = true
			clauses = append(clauses, clause)
		}
	}
	// 条款号形如 "5.2.3"，按字符串排序与按数字排序一致，短的排在前面。
	sort.Strings(clauses)
	items := make([]any, 0, len(clauses))
	for _, clause := range clauses {
		items = append(items, clause)
	}
	return items
}

// statusLabel 把校验结论翻译成界面文案。
func statusLabel(status validator.Status) string {
	switch status {
	case validator.StatusValid:
		return "通过"
	case validator.StatusInvalid:
		return "不通过"
	case validator.StatusPartial:
		return "部分通过"
	case validator.StatusError:
		return "校验失败"
	default:
		return string(status)
	}
}

// severityLabel 把严重程度翻译成界面文案。
func severityLabel(severity validator.Severity) string {
	switch severity {
	case validator.SeverityError:
		return "错误"
	case validator.SeverityWarning:
		return "警告"
	case validator.SeverityInfo:
		return "提示"
	default:
		return string(severity)
	}
}

// stageLabel 把校验阶段翻译成界面文案。
func stageLabel(stage validator.Stage) string {
	switch stage {
	case validator.StageContainer:
		return "容器"
	case validator.StageXML:
		return "XML"
	case validator.StageXSD:
		return "结构规范"
	case validator.StageReference:
		return "引用"
	case validator.StageSemantic:
		return "语义"
	case validator.StageProfile:
		return "Profile"
	case validator.StageDigest:
		return "摘要"
	default:
		return string(stage)
	}
}

// labelOr 取中文标签，缺失时退回英文原值。
func labelOr(zh, fallback string) string {
	if zh != "" {
		return zh
	}
	return fallback
}

// storeReport 保存一份报告，供导出时取用，并丢弃此前的报告。
func (a *wasmApp) storeReport(report validator.Report) uint64 {
	id := a.allocateID()
	a.mu.Lock()
	if a.reports == nil {
		a.reports = make(map[uint64]validator.Report)
	}
	// 只保留最新一份：用户不会同时比对两次校验，而每份报告都带着
	// 完整的 Issue 列表，攒着就是在 wasm 内存里留垃圾。
	a.reports = map[uint64]validator.Report{id: report}
	a.mu.Unlock()
	return id
}

// peekReport 读取一份报告但不移除。
//
// 导出不能"取出即删"：同一份报告往往要同时看 JSON 与 Markdown，
// 第一次导出后第二次就没了。而报告也不会长期堆积——storeReport 只保留
// 最新一份，跑下一次校验就把上一份顶掉，因此常驻内存始终是一份报告。
func (a *wasmApp) peekReport(id uint64) (validator.Report, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	report, ok := a.reports[id]
	return report, ok
}

// reportCount 供内存诊断显示已缓存的报告数。
func (a *wasmApp) reportCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.reports)
}
