//go:build js && wasm

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"syscall/js"

	"github.com/zc310/ofd/pkg/invoice"
	webreader "github.com/zc310/ofd/pkg/reader"
)

// 发票 Tab 的 binding。
//
// 抽取结果整体过 JSON 往返：invoice.Batch 的字段带完整 tag，且金额用
// Decimal（MarshalJSON 输出十进制字符串以避免浮点误差）。金额绝不能当数字
// 传给网页——"1130.00" 变成 1130 后再转回文本就少了小数位，财务对账
// 场景下这个差别是事故。

// invoiceBatchOptions 是网页传来的批量抽取参数。
type invoiceBatchOptions struct {
	// Dedup 打开后，发票代码与号码重复的输入只保留第一张。
	Dedup bool
	// SkipBroken 打开后，单个输入抽取失败只记入该条结果并继续。
	// 关着时首个失败即整批报错——一批票里静默少算金额是事故。
	SkipBroken bool
	// Sort 是排序方式，取 invoice.Sort* 常量，空值按输入顺序。
	Sort string
}

// parseInvoiceBatchOptions 从网页传来的对象读参数。
//
// 直接按 optionalBool / optionalString 取值，不走 JSON 往返：往返要先把
// js.Value 序列化成字符串再解回结构体，为两个布尔加一个字符串不值得，
// 而且往返会让类型错误变成静默的零值。
//
// skipBrokenDefault 由调用方给：批量抽取默认容错（跳过失败项、继续汇总），
// 合并 PDF 默认不容错（产物要拿去对账，少一张比停下来问一句更糟）。
func parseInvoiceBatchOptions(value js.Value, skipBrokenDefault bool) invoiceBatchOptions {
	if value.Type() != js.TypeObject {
		return invoiceBatchOptions{SkipBroken: skipBrokenDefault}
	}
	return invoiceBatchOptions{
		Dedup:      optionalBool(value, "dedup", false),
		SkipBroken: optionalBool(value, "skipBroken", skipBrokenDefault),
		Sort:       optionalString(value, "sort"),
	}
}

// extractInvoiceBatch 批量抽取发票并返回汇总。
//
// 入参是来源数组与选项对象，每个来源形如 {name, data}，data 是 OFD 的原始
// 字节。
//
// 刻意收字节而不是文档 ID：发票抽取只需要包内的结构化附件，不需要把文档
// 解析成可渲染的句柄。而文档句柄只有被选中打开过才存在——一次对账是一叠票，
// 让用户先把每张都点开才谈得上批量，是把工具的用法限制在实现细节上。
func (a *wasmApp) extractInvoiceBatch(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeObject {
		return errorValue(errors.New("extractInvoiceBatch 需要来源数组"))
	}
	var options invoiceBatchOptions
	if len(args) >= 2 {
		options = parseInvoiceBatchOptions(args[1], true)
	}

	sources, err := invoiceSources(args[0])
	if err != nil {
		return errorValue(err)
	}
	if len(sources) == 0 {
		return errorValue(errors.New("先把 OFD 文件加入文件队列"))
	}

	batch, err := invoice.ExtractBatch(sources, invoice.BatchOptions{
		SkipBroken: options.SkipBroken,
		Dedup:      options.Dedup,
	})
	if err != nil {
		// 不容错时 ExtractBatch 在首个失败处返回错误，消息里已经有来源文件名，
		// 这里只补上"接下来该怎么办"。
		return errorValue(invoiceError(err))
	}
	// 容错时失败项记在 Item.Error 里，ofd 那边只写了原始错误。那条消息对
	// 界面来说不够用：用户看到"未找到附件"不知道该怀疑文件还是厂商布局，
	// 而逐票清单里每一行都要能自己说明问题，不能靠点开才知道。
	for index := range batch.Items {
		if batch.Items[index].Error != "" {
			batch.Items[index].Error = explainInvoiceError(batch.Items[index].Error)
		}
	}
	if options.Sort != "" && options.Sort != invoice.SortInput {
		if err := invoice.SortItems(batch.Items, options.Sort); err != nil {
			return errorValue(err)
		}
	}

	id := a.storeInvoiceBatch(batch)
	generic, err := jsonGeneric(batch)
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{"batch_id": id, "batch": generic})
}

// invoiceBatchExport 导出批量抽取结果。
//
// json 之外都走 ofd 侧的实现：CSV 自带中文列名、BOM 与合计行，XLSX 自带
// 样式与多工作表，自绘一份只会少这些细节。
//
// xlsx 要 excelize 进产物，代价是实测的：wasm 从 50.4MB 涨到 63.0MB、
// gzip 从 13.1MB 涨到 15.4MB。
//
// 有个容易看错的地方：ofd 的 pkg/invoice/report_xlsx.go 没有 build tag，
// `go list -deps` 里一直查得到 excelize，看着像"体积早就付了"。不是——
// Go 链接器会剔除不可达代码，没人调 WriteXLSX 时那一整块就被扔掉了，
// go.mod 里那个 excelize 依赖是 inDirect 的、但不占产物体积。只有真正
// 调起来，代价才显现。
func (a *wasmApp) invoiceBatchExport(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeNumber {
		return errorValue(errors.New("invoiceBatchExport 需要批次 ID"))
	}
	batchID := uint64(args[0].Int())
	format := "json"
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		format = strings.ToLower(args[1].String())
	}

	batch, ok := a.peekInvoiceBatch(batchID)
	if !ok {
		return errorValue(fmt.Errorf("批次 %d 不存在或已被新批次替换", batchID))
	}

	switch format {
	case "json":
		// 导出给人看的文件多数时候要打开读，缩进比紧凑格式实用。
		data, err := jsonMarshalIndent(batch)
		if err != nil {
			return errorValue(err)
		}
		return objectValue(map[string]any{
			"name": "invoices.json", "mime": "application/json", "data": data,
		})
	case "csv":
		var buffer bytes.Buffer
		if err := invoice.WriteCSV(&buffer, batch); err != nil {
			return errorValue(err)
		}
		return objectValue(map[string]any{
			"name": "invoices.csv", "mime": "text/csv", "data": buffer.Bytes(),
		})
	case "xlsx":
		var buffer bytes.Buffer
		if err := invoice.WriteXLSX(&buffer, batch); err != nil {
			return errorValue(err)
		}
		return objectValue(map[string]any{
			"name": "invoices.xlsx",
			"mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"data": buffer.Bytes(),
		})
	default:
		return errorValue(fmt.Errorf("不支持的发票报表格式 %q", format))
	}
}

// invoiceError 给抽取失败补一句用户能据此判断下一步的话。
//
// 附件缺失是最常见的失败，而原因在错误消息里已经写明
// （"未找到 OFD 发票结构化附件"）。光有这句还不够：该 OFD 确实不是发票，
// 还是发票但厂商用了别的附件布局，两种情况的处理完全不同。来源文件名由
// ofd 侧带上，这里只补这一句。
func invoiceError(err error) error {
	if errors.Is(err, invoice.ErrNoAttachment) {
		return fmt.Errorf(
			"可能不是增值税电子发票；若确为发票，请确认厂商是否按 "+
				"Doc_0/Attachs 存放附件：%w", err)
	}
	return err
}

// explainInvoiceError 给一条纯文本的失败消息补上同样的提示。
//
// 不能复用 invoiceError：Item.Error 只有字符串，错误链在 ofd 侧
// err.Error() 那一步就没了，errors.Is 永远匹配不上，只能比对 ErrNoAttachment
// 的消息文本。两者出自同一次构建，文本一致；万一 ofd 改了这句话，这里退化成
// 不加提示，不会误报。
func explainInvoiceError(text string) string {
	if strings.Contains(text, invoice.ErrNoAttachment.Error()) {
		return fmt.Sprintf("%s；可能不是增值税电子发票，若确为发票请确认厂商是否按 "+
			"Doc_0/Attachs 存放附件", text)
	}
	return text
}

// storeInvoiceBatch 保存一批抽取结果，供导出时取用。
//
// 与 storeReport 同样只保留最新一份：用户不会同时比对两批票，而每份都带着
// 全部明细行。
func (a *wasmApp) storeInvoiceBatch(batch *invoice.Batch) uint64 {
	id := a.allocateID()
	a.mu.Lock()
	if a.invoiceBatches == nil {
		a.invoiceBatches = make(map[uint64]*invoice.Batch)
	}
	a.invoiceBatches = map[uint64]*invoice.Batch{id: batch}
	a.mu.Unlock()
	return id
}

// peekInvoiceBatch 读取一批结果但不移除。
//
// 导出不能"取出即删"：同一批结果往往要同时看 JSON 与 CSV，
// 第一次导出后第二次就没了。
func (a *wasmApp) peekInvoiceBatch(id uint64) (*invoice.Batch, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	batch, ok := a.invoiceBatches[id]
	return batch, ok
}

// invoiceBatchCount 供内存诊断显示已缓存的批次数。
func (a *wasmApp) invoiceBatchCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.invoiceBatches)
}

// invoiceSources 把网页传来的 {name, data} 数组读成 ofd 侧的来源列表。
//
// data 走 bytesFromJS 而不是直接取：Uint8Array 之外的值（少传了、被序列化成
// 普通对象）都要在这里被挡住，否则错误会推迟到 ofd 解析时才暴露成一句
// 无关的失败消息。
func invoiceSources(value js.Value) ([]invoice.Source, error) {
	if value.Type() != js.TypeObject || !value.Get("length").Truthy() {
		return nil, errors.New("需要非空的来源数组")
	}
	length := value.Length()
	sources := make([]invoice.Source, 0, length)
	for index := 0; index < length; index++ {
		item := value.Index(index)
		if item.Type() != js.TypeObject {
			return nil, fmt.Errorf("第 %d 个来源不是对象", index+1)
		}
		name := optionalString(item, "name")
		if name == "" {
			name = fmt.Sprintf("发票 %d", index+1)
		}
		data, err := bytesFromJS(item.Get("data"), "data")
		if err != nil {
			return nil, fmt.Errorf("%s：%w", name, err)
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("%s：文件内容为空", name)
		}
		sources = append(sources, invoice.Source{Name: name, Input: data})
	}
	return sources, nil
}

// ——— 合并 PDF ———

// mergeInvoicePDF 把多张发票合并成一个 PDF，产物经分块回调流出。
//
// 走的是和转换、合并同一条分块 + ACK 的流式通道：几十张票的 PDF 有几十 MB，
// 一次性返回会让中间产物堆在 WASM 内存里，那份体积加上 60MB 量级的模块
// 足以让浏览器杀掉标签页。
//
// 合并用的是 ofd 的 invoice.MergePDF，它自己会重跑一遍抽取与汇总，因此
// 返回的 Batch 才是"真正进了 PDF 的那些票"——去重跳过和抽取失败的都不在
// 里。界面要显示这份汇总，不能拿批量抽取那次的结果凑。
func (a *wasmApp) mergeInvoicePDF(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "mergeInvoicePDF")
	if err != nil {
		return errorValue(err)
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("mergeInvoicePDF 需要产物分块回调"))
	}

	plan, err := buildInvoiceMergePlan(request)
	if err != nil {
		return errorValue(err)
	}

	job := &wasmJob{
		id:       plan.jobID,
		onChunk:  args[1],
		streamID: plan.streamID,
		acks:     make(map[uint64]chan error),
		cancelCh: make(chan struct{}),
	}
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		job.progress = args[2]
	}

	ctx, cancel := context.WithCancel(context.Background())
	job.cancel = func() {
		cancel()
		job.closeOnce.Do(func() { close(job.cancelCh) })
	}

	a.mu.Lock()
	a.jobs[job.id] = job
	a.mu.Unlock()

	executor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, runErr := a.runInvoiceMerge(ctx, plan, job)
			a.finishJob(job)
			if runErr != nil {
				reject.Invoke(js.ValueOf(runErr.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})
	promise := js.Global().Get("Promise").New(executor)
	executor.Release()
	return promise
}

// invoiceMergePlan 是一次发票合并 PDF 请求的解析结果。
type invoiceMergePlan struct {
	jobID    uint64
	streamID uint64

	sources []invoice.Source
	options invoice.MergeOptions
}

// buildInvoiceMergePlan 解析并校验请求。
func buildInvoiceMergePlan(request js.Value) (*invoiceMergePlan, error) {
	plan := &invoiceMergePlan{}

	jobID, err := optionalUint64(request, "jobId")
	if err != nil {
		return nil, err
	}
	if jobID == 0 {
		return nil, errors.New("未指定任务 ID")
	}
	plan.jobID = jobID
	plan.streamID, _ = optionalUint64(request, "streamId")

	sources, err := invoiceSources(request.Get("sources"))
	if err != nil {
		return nil, err
	}
	plan.sources = sources

	// 容错默认关：合并的产物要拿去对账或存档，少合一张票比停下来问一句
	// 要糟。批量抽取那边默认开着，那只是交互式查看，跳过一个失败文件
	// 没有后果。
	batch := parseInvoiceBatchOptions(request, false)
	plan.options.BatchOptions = invoice.BatchOptions{
		Dedup:      batch.Dedup,
		SkipBroken: batch.SkipBroken,
	}
	plan.options.Sort = batch.Sort
	if plan.options.Sort == "" {
		plan.options.Sort = invoice.SortInput
	}
	// 汇总页要 creator 从字体子集化出中文字形，而浏览器里没有系统字体
	// 目录。汇总页因此必须配一个中文字体，见 prepareCoverFont。
	plan.options.Cover = optionalBool(request, "cover", false)
	plan.options.CoverTitle = optionalString(request, "coverTitle")
	if plan.options.Cover {
		if err := prepareCoverFont(optionalString(request, "coverFont")); err != nil {
			return nil, err
		}
	}

	if err := applyMergeLayout(&plan.options, request); err != nil {
		return nil, err
	}
	return plan, nil
}

// invoicePaperSizes 是可选纸张，取自 converter.NamedPaperSizes。
//
// 这里列出而不直接透传给库：拼错时库会报"不支持的纸张 X"，而界面用的是
// 下拉框，值域本来就有限，写死一份能让两边取值一致，也省掉每次猜名字。
var invoicePaperSizes = []string{"A4", "A3", "A5", "B5", "16开", "Letter", "Legal"}

// invoiceNUpOptions 是可选拼版份数，与库的 nupGrids 一致：0 与 1 等价。
var invoiceNUpOptions = []int{1, 2, 3, 4, 6, 8, 9}

// applyMergeLayout 解析合并打印的版面参数。
//
// 取值一律在这里先校验再交给库：库侧报错虽然也清楚，但那时已经开始读文档、
// 做解析了，白白花掉一份大文件的时间与内存。界面上这些值来自下拉框，
// 正常不会传错，校验是给手工构造请求与将来加输入框用的。
func applyMergeLayout(options *invoice.MergeOptions, request js.Value) error {
	options.Pages = optionalString(request, "pages")
	options.Paper = optionalString(request, "paper")
	options.Orientation = optionalString(request, "orientation")
	if err := checkOneOf("取页方式", options.Pages, true,
		[]string{invoice.PagesAll, invoice.PagesFirst, invoice.PagesFace}); err != nil {
		return err
	}
	if err := checkOneOf("方向", options.Orientation, true, []string{
		invoice.OrientationAuto, invoice.OrientationPortrait,
		invoice.OrientationLandscape,
	}); err != nil {
		return err
	}
	if err := checkOneOf("纸张", options.Paper, true, invoicePaperSizes); err != nil {
		return err
	}

	nup, err := optionalInt(request, "nUp", 1, 0, 16)
	if err != nil {
		return err
	}
	if nup != 0 {
		allowed := false
		for _, value := range invoiceNUpOptions {
			if nup == value {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("不支持的拼版份数 %d，可用 %s", nup, joinInts(invoiceNUpOptions))
		}
	}
	options.NUp = nup

	gap, err := optionalFloat(request, "nUpGap", 0, 0, 50)
	if err != nil {
		return err
	}
	options.NUpGap = gap

	options.CellBorder = optionalBool(request, "cellBorder", false)
	// 适配方式目前只有"等比缩放居中补白"一种（"填满裁切"会切掉印章与价税
	// 合计，对发票等于毁票），所以不接受别的值，也不给界面出口。
	if fit := optionalString(request, "fit"); fit != "" && fit != invoice.FitContain {
		return fmt.Errorf("不支持的适配方式 %q，目前只有 %s", fit, invoice.FitContain)
	}
	return nil
}

// checkOneOf 校验一个可选枚举值，空值一律放过（由库侧取默认）。
func checkOneOf(label, value string, allowEmpty bool, allowed []string) error {
	if value == "" && allowEmpty {
		return nil
	}
	for _, candidate := range allowed {
		if value == candidate {
			return nil
		}
	}
	quoted := make([]string, 0, len(allowed))
	for _, candidate := range allowed {
		quoted = append(quoted, candidate)
	}
	return fmt.Errorf("不支持的%s %q，可用 %s", label, value, strings.Join(quoted, "、"))
}

// joinInts 把整数列表拼成「1、2、3」用于报错文案。
func joinInts(values []int) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, strconv.Itoa(value))
	}
	return strings.Join(parts, "、")
}

// coverFontFamily 是汇总页实际会查的族名，必须与 ofd 的 pkg/invoice 里
// coverFont 取值一致（当前是"楷体"）。
//
// ofd 那边只声明逻辑字体名（创建器不碰字形），而用户选的是本机已注册的字体，
// 两者对不上时汇总页就一个字都没有。族名在导出时只是一个查找键，
// 所以把用户选的字节注册成这个名字即可。代价是同一次会话里别处声明这个
// 族名的地方也会用到这份字体——可以接受。
//
// 这是一个会漂移的重复：ofd 改了 coverFont 而这里没跟上，表现是汇总页空白
// 而没有任何报错。要根治得让 ofd 导出这个常量（那边现在是包内私有变量），
// 在那之前改 ofd 记得同步这里。
const coverFontFamily = "楷体"

// registerCoverFont 把某个已注册字体族再注册成汇总页要的那个族名。
//
// 字节从全局注册表里取，而不是让网页再送一份：用户是在右上角「字体」面板
// 里注册的，引擎里已经有一份，再传一遍等于白占一份几百 KB 到十几 MB 的内存。
//
// 没有字体就不让出汇总页，而不是让它生成一页空白：ofd 那边只声明字体名、
// 由创建器去子集化实际字形，浏览器里没有系统字体目录，字形解析不出来。
// 空白页比报错难发现得多——用户会以为汇总就是空的。
func prepareCoverFont(family string) error {
	family = strings.TrimSpace(family)
	if family == "" {
		return errors.New(
			"生成汇总页需要一个中文字体：请先在右上角「字体」里注册一个（如楷体），" +
				"否则汇总页会是空白")
	}
	data, ok := webreader.FallbackFontData(family)
	if !ok || len(data) == 0 {
		return fmt.Errorf("字体族 %q 没有已注册的字形数据，请先在右上角「字体」里注册", family)
	}
	// Weight 与 Italic 要显式给成常规体：留零值时注册表按 (族名, 样式) 建的
	// 键与文档请求的常规体对不上，查找落空，文字照样不画——页面上看不出区别，
	// 只是又变成了空白页。
	if err := webreader.RegisterFallbackFont(webreader.FontSource{
		Data: data, Name: family, Family: coverFontFamily, Weight: 400,
	}); err != nil {
		return fmt.Errorf("注册汇总页字体失败：%w", err)
	}
	return nil
}

// runInvoiceMerge 执行合并并把产物分块写出。
func (a *wasmApp) runInvoiceMerge(ctx context.Context, plan *invoiceMergePlan, job *wasmJob) (js.Value, error) {
	job.report(convertProgress{Phase: "rendering"})

	writer := newChunkWriter(job)
	options := plan.options
	batch, err := invoice.MergePDF(ctx, plan.sources, writer, options)
	if err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done"})

	// 汇总与清单一并留下：界面上要看"哪几张真的进了 PDF"，而这与批量抽取
	// 那次的结果可能不同（去重与容错的作用点在这里）。
	stored := a.storeInvoiceBatch(batch)
	generic, err := jsonGeneric(batch)
	if err != nil {
		return js.Undefined(), err
	}
	active := len(batch.ActiveItems())
	return objectValue(map[string]any{
		"size":     writer.written,
		"name":     "invoices.pdf",
		"batch_id": stored,
		"batch":    generic,
		"merged":   active,
		"inputs":   len(plan.sources),
	}), nil
}
