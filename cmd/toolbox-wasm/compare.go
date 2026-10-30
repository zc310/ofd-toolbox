//go:build js && wasm

package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"syscall/js"

	"github.com/zc310/ofd/pkg/compare"
)

// compareDocuments 接收 Worker 挂载后的 paths、原始 names 和比较选项。
// 报告含预览图，使用现有分块 + ACK 通道输出，避免整份 JSON 跨边界复制。
func (a *wasmApp) compareDocuments(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "compareDocuments")
	if err != nil {
		return errorValue(err)
	}
	paths := request.Get("paths")
	if !js.Global().Get("Array").Call("isArray", paths).Bool() || paths.Length() < 2 || paths.Length() > 64 {
		return errorValue(errors.New("比较需要 2–64 个 OFD 文件"))
	}
	inputs := make([]string, paths.Length())
	names := make([]string, paths.Length())
	provided := request.Get("names")
	for i := range inputs {
		if paths.Index(i).Type() != js.TypeString || paths.Index(i).String() == "" {
			return errorValue(errors.New("比较输入路径无效"))
		}
		inputs[i] = paths.Index(i).String()
		names[i] = fmt.Sprintf("输入 %d.ofd", i+1)
		if js.Global().Get("Array").Call("isArray", provided).Bool() && i < provided.Length() && provided.Index(i).Type() == js.TypeString {
			names[i] = provided.Index(i).String()
		}
	}
	options, err := compareOptionsFromJS(request, len(inputs))
	if err != nil {
		return errorValue(err)
	}
	return a.startOutputStream(args, func(ctx context.Context, job *wasmJob) (js.Value, error) {
		job.report(convertProgress{Phase: "comparing"})
		report, err := compare.CompareFiles(ctx, inputs, options)
		if err != nil {
			return js.Undefined(), err
		}
		for i := range report.Inputs {
			report.Inputs[i].Name = names[i]
		}
		if err := ctx.Err(); err != nil {
			return js.Undefined(), err
		}
		id := a.allocateID()
		result, err := writeCompareReport(report, "html", id, job)
		if err != nil {
			return js.Undefined(), err
		}
		a.mu.Lock()
		a.comparisons = map[uint64]*compare.Report{id: report}
		a.mu.Unlock()
		return result, nil
	})
}

func compareOptionsFromJS(request js.Value, count int) (compare.Options, error) {
	options := compare.Options{
		PageMatch: optionalString(request, "pageMatch"), PageMap: optionalString(request, "pageMap"),
		Pages: optionalString(request, "pages"), Visual: optionalBool(request, "visual", false),
		MaxPreviewBytes: 16 << 20, MaxReportBytes: 64 << 20,
		BaselineCacheBytes: 16 << 20, MaxTotalPixels: 100_000_000,
	}
	// 不截断小数或吞掉 NaN；索引和像素参数必须明确有效。
	for _, field := range []struct {
		key             string
		dst             *int
		value, min, max int
	}{
		{"baseline", &options.Baseline, 0, 0, count - 1},
		{"pixelTolerance", &options.PixelTolerance, 0, 0, 255},
		{"minRegionPixels", &options.MinRegionPixels, 1, 1, 10_000_000},
	} {
		value := request.Get(field.key)
		*field.dst = field.value
		if value.IsUndefined() {
			continue
		}
		if !finiteNumber(value) || math.Trunc(value.Float()) != value.Float() || value.Float() < float64(field.min) || value.Float() > float64(field.max) {
			return options, fmt.Errorf("%s 必须为 %d 到 %d 之间的整数", field.key, field.min, field.max)
		}
		*field.dst = value.Int()
	}
	options.DPI = 72
	if value := request.Get("dpi"); !value.IsUndefined() {
		if !finiteNumber(value) || value.Float() < 10 || value.Float() > 300 {
			return options, errors.New("DPI 必须在 10–300 之间")
		}
		options.DPI = value.Float()
	}
	if options.PageMatch == "" {
		options.PageMatch = "auto"
	}
	if options.PageMatch != "auto" && options.PageMatch != "number" {
		return options, errors.New("页面匹配方式必须为 auto 或 number")
	}
	if _, err := compare.ParsePageRanges(options.Pages); err != nil {
		return options, err
	}
	if _, err := compare.ParsePageMap(options.PageMap); err != nil {
		return options, err
	}
	if options.PageMap != "" && options.PageMatch != "auto" {
		return options, errors.New("手工页映射仅适用于自动匹配")
	}
	return options, nil
}

func (a *wasmApp) compareExport(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "compareExport")
	if err != nil {
		return errorValue(err)
	}
	id, err := optionalUint64(request, "reportId")
	if err != nil {
		return errorValue(err)
	}
	a.mu.Lock()
	report := a.comparisons[id]
	a.mu.Unlock()
	if report == nil {
		return errorValue(errors.New("比较报告不存在或已被新报告替换"))
	}
	format := optionalString(request, "format")
	switch format {
	case "html", "json", "markdown", "text":
	default:
		return errorValue(fmt.Errorf("不支持的比较报告格式 %q", format))
	}
	return a.startOutputStream(args, func(ctx context.Context, job *wasmJob) (js.Value, error) {
		return writeCompareReport(report, format, id, job)
	})
}

// startOutputStream 同时保护异步 goroutine，失败和 panic 均清理任务。
func (a *wasmApp) startOutputStream(args []js.Value, run func(context.Context, *wasmJob) (js.Value, error)) any {
	request := args[0]
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("需要产物分块回调"))
	}
	id, err := optionalUint64(request, "jobId")
	if err != nil || id == 0 {
		return errorValue(errors.New("未指定有效任务 ID"))
	}
	streamID, err := optionalUint64(request, "streamId")
	if err != nil {
		return errorValue(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &wasmJob{id: id, cancel: cancel, onChunk: args[1], streamID: streamID,
		acks: make(map[uint64]chan error), cancelCh: make(chan struct{})}
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		job.progress = args[2]
	}
	a.mu.Lock()
	if a.jobs[id] != nil {
		a.mu.Unlock()
		cancel()
		return errorValue(errors.New("任务 ID 已存在"))
	}
	a.jobs[id] = job
	a.mu.Unlock()
	executor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			defer a.finishJob(job)
			defer func() {
				if recovered := recover(); recovered != nil {
					reject.Invoke(fmt.Sprintf("产物生成失败：%v", recovered))
				}
			}()
			result, err := run(ctx, job)
			if err != nil {
				reject.Invoke(err.Error())
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

func writeCompareReport(report *compare.Report, format string, id uint64, job *wasmJob) (js.Value, error) {
	job.report(convertProgress{Phase: "writing"})
	writer := newChunkWriter(job)
	if err := compare.WriteReport(writer, report, format); err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	ext, mime := format, "text/plain"
	switch format {
	case "html":
		mime = "text/html"
	case "json":
		mime = "application/json"
	case "markdown":
		ext, mime = "md", "text/markdown"
	case "text":
		ext = "txt"
	}
	comparisons := make([]any, 0, len(report.Comparisons))
	for _, item := range report.Comparisons {
		comparisons = append(comparisons, map[string]any{
			"name": report.Inputs[item.Target-1].Name, "equal": item.Equal,
			"pagesEqual": item.PagesEqual, "summary": item.Summary,
		})
	}
	job.report(convertProgress{Phase: "done"})
	return objectValue(map[string]any{
		"reportId": id, "name": "comparison." + ext, "mime": mime, "size": writer.written,
		"baseline": report.Inputs[report.Baseline-1].Name, "comparisons": comparisons,
	}), nil
}
