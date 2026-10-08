//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"syscall/js"

	"github.com/zc310/ofd/pkg/creator"
	"github.com/zc310/ofd/pkg/merge"
)

// 合并 Tab 的 binding。
//
// 库提供两条完全不同的合并路径，界面必须让用户显式选，而不是替他决定：
//
//   - ZIP 级（merge.Sources）：把每个输入的文档体目录原样搬到新的 Doc_N，
//     只重写 OFD.xml 与签名里的包内路径。改动最小，被引用文件的字节不变，
//     签名摘要仍然有效（但 SignedValue 覆盖了签名清单，路径一改就得重签）。
//
//   - 模型级（merge.Pages）：把页面解析成模型后重新生成一个单文档 OFD，
//     支持跨文档拼页，但要重新编号文档级资源，遇到资源冲突会报错。
//
// 两者的产物形态也不同：ZIP 级是多文档体包，模型级是单文档体。选错了
// 用户会拿到一个"打开发现结构不对"的文件，所以界面上把区别写清楚。
//
// 合并产物与转换产物同量级，走同一条分块 + ACK 的流式通道。

// mergeDocuments 合并多个 OFD，产物经分块回调流出。
func (a *wasmApp) mergeDocuments(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "mergeDocuments")
	if err != nil {
		return errorValue(err)
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("mergeDocuments 需要产物分块回调"))
	}

	plan, err := buildMergePlan(request)
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
	job.cancel = func() { job.closeOnce.Do(func() { close(job.cancelCh) }) }

	a.mu.Lock()
	a.jobs[job.id] = job
	a.mu.Unlock()

	executor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, runErr := a.runMerge(plan, job)
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

// mergePlan 是一次合并请求的解析结果。
type mergePlan struct {
	jobID    uint64
	streamID uint64

	mode string // zip / pages

	inputs []merge.Source

	// ZIP 级选项。
	zip merge.Options
	// 模型级选项。
	pages merge.PageOptions

	names []string
}

// maxMergeInputs 单次合并的输入数量上限。
//
// 输入字节要在网页侧一次性读齐、再整体拷进 WASM，几十份文档起步就是
// 几百 MB。这个上限是防御性的。
const maxMergeInputs = 64

// buildMergePlan 解析并校验合并请求。
func buildMergePlan(request js.Value) (*mergePlan, error) {
	plan := &mergePlan{
		mode: optionalString(request, "mode"),
	}
	if plan.mode == "" {
		plan.mode = "zip"
	}
	if plan.mode != "zip" && plan.mode != "pages" {
		return nil, fmt.Errorf("不支持的合并方式 %q", plan.mode)
	}

	jobID, err := optionalUint64(request, "jobId")
	if err != nil {
		return nil, err
	}
	if jobID == 0 {
		return nil, errors.New("未指定任务 ID")
	}
	plan.jobID = jobID
	plan.streamID, _ = optionalUint64(request, "streamId")

	inputs, names, err := mergeInputsFromJS(request)
	if err != nil {
		return nil, err
	}
	if len(inputs) < 2 {
		return nil, errors.New("合并至少需要两个 OFD 文档")
	}
	plan.inputs, plan.names = inputs, names

	// 签名处理方式两种模式共用同一个枚举。默认保留：合并只重写包内路径，
	// 被引用文件的字节不变，直接删掉签名条目等于抹掉原件上的签章痕迹。
	// 模型级合并会把页面解析后重新生成，签名本来就不可能保留，因此
	// 这个选项只对 ZIP 级有意义；模型级仍然接收它，是为了错误信息一致。
	if plan.mode == "zip" {
		switch optionalString(request, "signatures") {
		case "", "preserve":
			plan.zip.Signatures = creator.SignaturePreserve
		case "drop":
			plan.zip.Signatures = creator.SignatureDrop
		case "rewrite":
			plan.zip.Signatures = creator.SignatureRewrite
		default:
			return nil, fmt.Errorf("不支持的签名处理方式")
		}
	}

	if level, err := optionalInt(request, "compressionLevel", 0, 0, 9); err != nil {
		return nil, err
	} else {
		plan.zip.CompressionLevel = level
		plan.pages.CompressionLevel = level
	}
	if mode, err := mergeCompression(optionalString(request, "compression")); err != nil {
		return nil, err
	} else {
		plan.zip.Compression = mode
		plan.pages.Compression = mode
	}
	deterministic := optionalBool(request, "deterministic", false)
	plan.zip.Deterministic = deterministic
	plan.pages.Deterministic = deterministic

	if plan.mode == "zip" {
		orphans, err := mergeOrphans(optionalString(request, "orphans"))
		if err != nil {
			return nil, err
		}
		plan.zip.Orphans = orphans
		return plan, nil
	}

	// 模型级：页序与元数据。
	if spec := optionalString(request, "pages"); spec != "" {
		selectors, err := merge.ParsePageSelection(spec)
		if err != nil {
			return nil, fmt.Errorf("页序表达式无效: %w", err)
		}
		plan.pages.Selectors = selectors
	}
	if concurrency, err := optionalInt(request, "concurrency", 0, 0, 16); err != nil {
		return nil, err
	} else {
		plan.pages.Concurrency = concurrency
	}
	plan.pages.ID = optionalString(request, "id")
	plan.pages.Title = optionalString(request, "title")
	plan.pages.Author = optionalString(request, "author")
	plan.pages.Subject = optionalString(request, "subject")
	return plan, nil
}

// mergeInputsFromJS 读出入参里的输入文档字节。
//
// 网页侧把选中的文件逐个读成 Uint8Array 后一次性传进来，而不是让 WASM
// 自己去取：浏览器里没有文件系统，路径传不进来，只能整体送字节。
func mergeInputsFromJS(request js.Value) ([]merge.Source, []string, error) {
	value := request.Get("inputs")
	if value.Type() != js.TypeObject {
		return nil, nil, errors.New("缺少输入文档")
	}
	length := value.Get("length")
	if length.Type() != js.TypeNumber {
		return nil, nil, errors.New("输入文档列表缺少长度")
	}
	count := length.Int()
	if count <= 0 {
		return nil, nil, errors.New("输入文档列表为空")
	}
	if count > maxMergeInputs {
		return nil, nil, fmt.Errorf("单次最多合并 %d 个文档", maxMergeInputs)
	}

	names := make([]string, 0, count)
	if provided := request.Get("names"); provided.Type() == js.TypeObject {
		providedLength := provided.Get("length").Int()
		for index := 0; index < providedLength; index++ {
			names = append(names, provided.Index(index).String())
		}
	}

	inputs := make([]merge.Source, 0, count)
	for index := 0; index < count; index++ {
		data, err := bytesFromJS(value.Index(index), fmt.Sprintf("第 %d 个输入文档", index+1))
		if err != nil {
			return nil, nil, err
		}
		if len(data) == 0 {
			return nil, nil, fmt.Errorf("第 %d 个输入文档为空", index+1)
		}
		name := fmt.Sprintf("第 %d 个输入文档", index+1)
		if index < len(names) && names[index] != "" {
			name = names[index]
		}
		inputs = append(inputs, merge.Source{Name: name, Data: data})
	}
	return inputs, names, nil
}

// mergeCompression 解析压缩策略。
func mergeCompression(value string) (creator.CompressionMode, error) {
	switch value {
	case "", "auto":
		return creator.CompressionAuto, nil
	case "deflate":
		return creator.CompressionDeflate, nil
	case "store":
		return creator.CompressionStore, nil
	default:
		return "", fmt.Errorf("不支持的压缩策略 %q", value)
	}
}

// mergeOrphans 解析目录外条目的处理方式。
func mergeOrphans(value string) (merge.OrphanMode, error) {
	switch value {
	case "", "error":
		return merge.OrphanError, nil
	case "ignore":
		return merge.OrphanIgnore, nil
	case "preserve":
		return merge.OrphanPreserve, nil
	default:
		return "", fmt.Errorf("不支持的目录外条目处理方式 %q", value)
	}
}

// runMerge 执行合并并把产物分块写出。
func (a *wasmApp) runMerge(plan *mergePlan, job *wasmJob) (js.Value, error) {
	job.report(convertProgress{Phase: "rendering"})

	var warnings []string
	var events []merge.SignatureEvent

	writer := newChunkWriter(job)
	var runErr error
	if plan.mode == "zip" {
		options := plan.zip
		options.OnWarning = func(message string) { warnings = append(warnings, message) }
		options.OnSignature = func(event merge.SignatureEvent) { events = append(events, event) }
		runErr = merge.Sources(plan.inputs, writer, options)
	} else {
		options := plan.pages
		options.OnSignature = func(event merge.SignatureEvent) { events = append(events, event) }
		runErr = merge.Pages(plan.inputs, writer, options)
	}
	if runErr != nil {
		return js.Undefined(), runErr
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done"})

	return objectValue(map[string]any{
		"size":            writer.written,
		"warnings":        warnings,
		"signatureEvents": mergeSignatureEvents(events),
		"mode":            plan.mode,
		"inputs":          len(plan.inputs),
		"name":            "merged.ofd",
	}), nil
}

// mergeSignatureEvents 把签名处理结果转成界面能用的结构。
func mergeSignatureEvents(events []merge.SignatureEvent) []any {
	items := make([]any, 0, len(events))
	for _, event := range events {
		actionLabel := "已保留"
		switch event.Action {
		case merge.SignatureRewritten:
			actionLabel = "已重写路径（签名值失效）"
		case merge.SignatureDropped:
			actionLabel = "已丢弃"
		}
		items = append(items, map[string]any{
			"input":       event.Input,
			"document":    event.DocumentIndex,
			"id":          event.ID,
			"action":      string(event.Action),
			"actionLabel": actionLabel,
		})
	}
	return items
}
