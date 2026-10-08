//go:build js && wasm

package main

import (
	"errors"
	"strings"
	"syscall/js"

	"github.com/zc310/ofd/pkg/preserve"
)

// 长期保存 Tab 的 binding。
//
// 依据 GB/T 42133—2022 第 6 章，把档案长期保存要求的若干转换动作施加到文档上。
// 这个工具与其他 Tab 的关键区别是**两步走**：
//
//	预检（Plan）只读输入、算出计划改动，不产出文件；
//	执行（Apply）才写出新文件。
//
// 拆成两步是因为其中一类动作是删除（6.2.1 c) 的无人引用条目），而删除不可逆、
// 且依赖引用闭包是否完整。让用户先看到"会发生什么"再决定，比执行完再解释好。
//
// 预检与执行共用库里的同一份步骤定义（preserve 内部的 step 表），因此预检展示的
// 计划就是执行时真正会做的改动——两者一旦分叉，预检就失去意义。

// preservePlan 预检长期保存转换，返回计划改动而不写出文件。
func (a *wasmApp) preservePlan(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "preservePlan")
	if err != nil {
		return errorValue(err)
	}
	id, err := optionalUint64(request, "documentId")
	if err != nil {
		return errorValue(err)
	}
	if id == 0 {
		return errorValue(errors.New("未指定输入文档"))
	}
	data, name, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	if err := checkOFD(data); err != nil {
		return errorValue(err)
	}

	options, warnings := buildPreserveOptions(request)
	result, err := preserve.Plan(data, options)
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{
		"result":   preserveResultValue(result),
		"warnings": *warnings,
		"name":     name,
	})
}

// preserveApply 执行长期保存转换，产物经分块回调流出。
func (a *wasmApp) preserveApply(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "preserveApply")
	if err != nil {
		return errorValue(err)
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("preserveApply 需要产物分块回调"))
	}
	id, err := optionalUint64(request, "documentId")
	if err != nil {
		return errorValue(err)
	}
	if id == 0 {
		return errorValue(errors.New("未指定输入文档"))
	}

	jobID, err := optionalUint64(request, "jobId")
	if err != nil {
		return errorValue(err)
	}
	if jobID == 0 {
		return errorValue(errors.New("未指定任务 ID"))
	}

	job := &wasmJob{
		id:      jobID,
		onChunk: args[1],
		acks:    make(map[uint64]chan error),
	}
	job.streamID, _ = optionalUint64(request, "streamId")
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		job.progress = args[2]
	}
	job.cancelCh = make(chan struct{})
	job.cancel = func() { job.closeOnce.Do(func() { close(job.cancelCh) }) }

	data, name, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	if err := checkOFD(data); err != nil {
		return errorValue(err)
	}
	options, warnings := buildPreserveOptions(request)

	a.mu.Lock()
	a.jobs[job.id] = job
	a.mu.Unlock()

	executor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, runErr := runPreserve(data, name, options, warnings, job)
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

// buildPreserveOptions 解析转换选项，并返回一个会被 OnWarning 写入的切片。
func buildPreserveOptions(request js.Value) (preserve.Options, *[]string) {
	warnings := &[]string{}
	options := preserve.Options{
		DocType:          strings.TrimSpace(optionalString(request, "docType")),
		Validate:         optionalBool(request, "validate", true),
		DropUnreferenced: optionalBool(request, "dropUnreferenced", false),
		OnWarning: func(message string) {
			*warnings = append(*warnings, message)
		},
	}
	return options, warnings
}

// runPreserve 执行转换并把产物分块写出。
func runPreserve(data []byte, name string, options preserve.Options, warnings *[]string, job *wasmJob) (js.Value, error) {
	job.report(convertProgress{Phase: "rendering"})
	writer := newChunkWriter(job)
	result, err := preserve.Apply(data, writer, options)
	if err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done"})
	return objectValue(map[string]any{
		"size":     writer.written,
		"result":   preserveResultValue(result),
		"warnings": *warnings,
		"name":     suggestPreserveName(name),
	}), nil
}

// preserveResultValue 把转换结果转成界面能直接用的结构。
func preserveResultValue(result preserve.Result) map[string]any {
	changes := make([]any, 0, len(result.Changes))
	for _, change := range result.Changes {
		changes = append(changes, map[string]any{
			"entry":  change.Entry,
			"clause": change.Clause,
			"action": change.Action,
			"count":  change.Count,
		})
	}
	return map[string]any{
		"docType":             result.DocType,
		"entry":               result.Entry,
		"changes":             changes,
		"entries":             result.Entries,
		"beforeErrors":        result.BeforeErrors,
		"unreferenced":        result.Unreferenced,
		"unreferencedDropped": result.UnreferencedDropped,
		"closureIncomplete":   result.ClosureIncomplete,
		"closureReason":       result.ClosureReason,
	}
}

// suggestPreserveName 给出带标记的产物文件名。
func suggestPreserveName(source string) string {
	base := source
	if dot := strings.LastIndex(base, "."); dot > 0 {
		base = base[:dot]
	}
	return base + "-preserved.ofd"
}

// preserveDocTypes 是界面下拉可选的 profile 取值。基础 OFD 不在其中：
// preserve 只对 OFD-A / OFD-H 施加档案转换，选基础 OFD 会直接报"未产生改动"。
// 空串表示按文件声明的 DocType 自动判定。
func preserveDocTypes() []string {
	return []string{"", "OFD-A", "OFD-H"}
}
