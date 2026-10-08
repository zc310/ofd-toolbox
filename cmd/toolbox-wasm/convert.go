//go:build js && wasm

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/color"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/zc310/ofd/pkg/converter"
	"github.com/zc310/ofd/pkg/webreader"
)

// wasmJob 是一次进行中的转换。
type wasmJob struct {
	id     uint64
	cancel context.CancelFunc
	// progress 上报进度，pages 为 0 表示该阶段没有可计数的页。
	progress js.Value
	// onChunk 接收产物字节分块。
	onChunk js.Value
	// streamID 非零时每块写出后等待 worker 的 ACK，用于把背压传给 WASM。
	// 大文档一次性产出时没有这一步，WASM 侧的中间结果会一直堆在内存里。
	streamID  uint64
	ackMu     sync.Mutex
	acks      map[uint64]chan error
	cancelCh  chan struct{}
	closeOnce sync.Once
}

// 产物分块大小。64 KiB 是权衡值：再大则单个 chunk 在 JS 侧解码要等更久，
// 再小则 ACK 往返次数上升，而每次 ACK 都要跨一次 worker 消息边界。
const wasmChunkSize = 64 << 10

// startConvert 启动一次转换，返回 Promise。
//
// 三个参数：请求对象 {jobId, documentId|data, from, to, range, ...选项}、
// 产物分块回调 (chunk, sequence)、进度回调 ({phase, page, pages})。
//
// 两个回调都是位置参数而不是请求对象的字段：函数不能塞进 postMessage
// 的结构化克隆里，worker 要转发它们只能走独立参数。
func (a *wasmApp) startConvert(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "startConvert")
	if err != nil {
		return errorValue(err)
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("startConvert 需要产物分块回调"))
	}

	plan, err := buildConvertPlan(request)
	if err != nil {
		return errorValue(err)
	}
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		plan.progress = args[2]
	}

	ctx, cancel := context.WithCancel(context.Background())
	job := &wasmJob{
		id:       plan.jobID,
		cancel:   cancel,
		progress: plan.progress,
		onChunk:  args[1],
		streamID: plan.streamID,
		acks:     make(map[uint64]chan error),
		cancelCh: make(chan struct{}),
	}
	// 无条件登记任务，不看 streamID：取消是所有转换都该有的能力，
	// 不能因为调用方没启用分块写出就失效。streamID 只决定产物是否走
	// 带 ACK 的背压路径。
	a.mu.Lock()
	a.jobs[job.id] = job
	a.mu.Unlock()

	executor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, runErr := a.runConvert(ctx, plan, job)
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

// cancelJob 取消进行中的转换。
//
// 取消后 convert 已经进入的同步 WASM 调用无法中断，但它的结果不会再
// 写进界面：runConvert 在每页前查一次 ctx.Err()。
func (a *wasmApp) cancelJob(_ js.Value, args []js.Value) any {
	id, err := parseJobID(args, "cancelJob")
	if err != nil {
		return errorValue(err)
	}
	a.mu.Lock()
	job := a.jobs[id]
	a.mu.Unlock()
	if job == nil {
		return errorValue(fmt.Errorf("任务 %d 不存在", id))
	}
	job.cancel()
	job.closeOnce.Do(func() { close(job.cancelCh) })
	return nil
}

// finishJob 清理任务状态。
func (a *wasmApp) finishJob(job *wasmJob) {
	job.cancel()
	job.closeOnce.Do(func() { close(job.cancelCh) })
	a.mu.Lock()
	delete(a.jobs, job.id)
	a.mu.Unlock()
}

// buildConvertPlan 解析并校验转换请求。
func buildConvertPlan(request js.Value) (*convertPlan, error) {
	plan := &convertPlan{
		from:       normalizeFormat(optionalString(request, "from")),
		to:         normalizeFormat(optionalString(request, "to")),
		background: "transparent",
	}
	if plan.to == "" {
		return nil, errors.New("未指定目标格式")
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

	// 输入二选一：优先用已打开文档，字节不再从 JS 侧复制一遍。
	if data := request.Get("data"); !data.IsUndefined() && !data.IsNull() {
		bytes, err := bytesFromJS(data, "输入数据")
		if err != nil {
			return nil, err
		}
		plan.data = bytes
	} else {
		documentID, err := optionalUint64(request, "documentId")
		if err != nil {
			return nil, err
		}
		if documentID == 0 {
			return nil, errors.New("未指定输入文档")
		}
		plan.data = nil
		plan.documentID = documentID
	}

	if plan.from == "" {
		detected, err := detectFormat(plan.data)
		if err != nil {
			return nil, err
		}
		plan.from = detected
	}

	// 页面范围。文档类输出里只有 PDF 支持任意页集合，其余编码器接受
	// 全部页面或单页，因此范围解析失败时降级而不是报错。
	plan.rangeSpec = optionalString(request, "range")
	if plan.rangeSpec == "current" || plan.rangeSpec == "all" || plan.rangeSpec == "" {
		plan.rangeSpec = ""
	}

	if dpi, err := optionalFloat(request, "dpi", 96, 1, 1200); err != nil {
		return nil, err
	} else {
		plan.dpi = dpi
	}
	if background := optionalString(request, "background"); background != "" {
		plan.background = background
	}
	plan.password = optionalString(request, "password")

	// 三个按格式生效的开关。是否展示由前端按 capabilities 决定，
	// 这里读取并校验，未提供时保持库侧默认。
	if plan.to == "markdown" {
		plan.markdownTables = optionalBool(request, "markdownTables", false)
	}
	if plan.to == "docx" {
		plan.docxTables = optionalBool(request, "docxTables", true)
		plan.docxImages = optionalBool(request, "docxImages", true)
		plan.docxAnnotations = optionalBool(request, "docxAnnotations", false)
	}
	if plan.to == "html" {
		plan.htmlTextLayer = optionalBool(request, "htmlTextLayer", true)
		plan.htmlImageFormat = normalizeFormat(optionalString(request, "htmlImageFormat"))
		if plan.htmlImageFormat == "" {
			plan.htmlImageFormat = "png"
		}
	}
	return plan, nil
}

// convertPlan 是一次转换请求的解析结果。
type convertPlan struct {
	jobID      uint64
	streamID   uint64
	progress   js.Value
	documentID uint64
	data       []byte

	from string
	to   string

	// rangeSpec 为空表示全部页面，"1-3,5" 表示自定义页集合。
	rangeSpec  string
	dpi        float64
	background string
	password   string

	markdownTables  bool
	docxTables      bool
	docxImages      bool
	docxAnnotations bool
	htmlTextLayer   bool
	htmlImageFormat string
}

// inputBytes 取出转换输入的字节，必要时从已打开文档取。
func (a *wasmApp) inputBytes(plan *convertPlan) ([]byte, error) {
	if plan.data != nil {
		return plan.data, nil
	}
	data, _, err := a.documentBytes(plan.documentID)
	return data, err
}

// runConvert 按目标格式分派到三条实现路径。
func (a *wasmApp) runConvert(ctx context.Context, plan *convertPlan, job *wasmJob) (js.Value, error) {
	if err := ctx.Err(); err != nil {
		return js.Undefined(), err
	}
	switch {
	case plan.to == "pdf":
		return a.convertToPDF(ctx, plan, job)
	case plan.to == "png" || plan.to == "jpeg" || plan.to == "jpg" || plan.to == "svg":
		return a.convertToImages(ctx, plan, job)
	default:
		return a.convertToDocument(ctx, plan, job)
	}
}

// convertToPDF 走 webreader 的页面选择导出路径。
//
// 不用 converter.Encode 的原因是页集合：converter 的 Page 选项只接受
// 单页或全部，webreader.RenderPDFTo 直接接受页索引数组，自定义范围因此
// 能落到产物里。PDF 不栅格化，options.DPI 固定 72 只用于毫米到点的换算，
// 界面也不应把它暴露给用户。
func (a *wasmApp) convertToPDF(ctx context.Context, plan *convertPlan, job *wasmJob) (js.Value, error) {
	data, err := a.inputBytes(plan)
	if err != nil {
		return js.Undefined(), err
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return js.Undefined(), err
	}
	defer func() { _ = reader.Close() }()

	pages, err := reader.Pages()
	if err != nil {
		return js.Undefined(), err
	}
	indices, err := resolveIndices(len(pages), plan.rangeSpec)
	if err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "rendering", Pages: len(indices)})

	writer := newChunkWriter(job)
	options := webreader.RenderOptions{
		// PDF 走矢量路径，DPI 只决定页面尺寸的换算比例。72 让
		// 毫米按物理尺寸落成 PDF 点（A4 为 595.3 × 841.9 pt）。
		DPI:        72,
		Background: transparentBackground(),
		Format:     webreader.RenderFormat("pdf"),
	}
	if err := reader.RenderPDFTo(writer, indices, options); err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done", Page: len(indices), Pages: len(indices)})
	return objectValue(map[string]any{
		"pages": len(indices),
		"size":  writer.written,
	}), nil
}

// convertToImages 逐页渲染图片，多页打包为 ZIP。
//
// 走 webreader 而不是 converter：reader 内部按页缓存页面，而 converter
// 每次调用都要重新解析整个 OFD，逐页调用会把解析成本乘以页数。
func (a *wasmApp) convertToImages(ctx context.Context, plan *convertPlan, job *wasmJob) (js.Value, error) {
	data, err := a.inputBytes(plan)
	if err != nil {
		return js.Undefined(), err
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return js.Undefined(), err
	}
	defer func() { _ = reader.Close() }()

	pages, err := reader.Pages()
	if err != nil {
		return js.Undefined(), err
	}
	indices, err := resolveIndices(len(pages), plan.rangeSpec)
	if err != nil {
		return js.Undefined(), err
	}
	format := webreader.RenderPNG
	if plan.to == "jpg" || plan.to == "jpeg" {
		format = webreader.RenderJPG
	} else if plan.to == "svg" {
		format = webreader.RenderSVG
	}

	writer := newChunkWriter(job)
	if len(indices) == 1 {
		// 单页直出图片文件，不套 ZIP：用户要的是一张图，不是压缩包。
		job.report(convertProgress{Phase: "rendering", Pages: 1})
		page, err := reader.RenderPage(indices[0], webreader.RenderOptions{
			DPI:        plan.dpi,
			Background: plan.bgColor(),
			Format:     format,
		})
		if err != nil {
			return js.Undefined(), err
		}
		if _, err := writer.Write(page); err != nil {
			return js.Undefined(), err
		}
		if err := writer.finish(); err != nil {
			return js.Undefined(), err
		}
		job.report(convertProgress{Phase: "done", Page: 1, Pages: 1})
		return objectValue(map[string]any{"pages": 1, "size": writer.written, "zipped": false}), nil
	}

	archive := zip.NewWriter(writer)
	extension := "png"
	if format == webreader.RenderJPG {
		extension = "jpg"
	} else if format == webreader.RenderSVG {
		extension = "svg"
	}
	for position, index := range indices {
		if err := ctx.Err(); err != nil {
			return js.Undefined(), err
		}
		job.report(convertProgress{Phase: "rendering", Page: position, Pages: len(indices)})
		page, err := reader.RenderPage(index, webreader.RenderOptions{
			DPI:        plan.dpi,
			Background: plan.bgColor(),
			Format:     format,
		})
		if err != nil {
			return js.Undefined(), fmt.Errorf("渲染第 %d 页失败: %w", index+1, err)
		}
		// 固定时间戳让同样输入得到同样字节，便于比对与缓存。
		entry, err := archive.CreateHeader(&zip.FileHeader{
			Name:     fmt.Sprintf("page-%04d.%s", index+1, extension),
			Method:   zip.Deflate,
			Modified: time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC),
		})
		if err != nil {
			return js.Undefined(), err
		}
		if _, err := entry.Write(page); err != nil {
			return js.Undefined(), err
		}
	}
	// Central Directory 在最后写出，因此必须在全部页面渲染完之前不 flush。
	if err := archive.Close(); err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done", Page: len(indices), Pages: len(indices)})
	return objectValue(map[string]any{"pages": len(indices), "size": writer.written, "zipped": true}), nil
}

// convertToDocument 走 converter 的文档编码器。
func (a *wasmApp) convertToDocument(ctx context.Context, plan *convertPlan, job *wasmJob) (js.Value, error) {
	data, err := a.inputBytes(plan)
	if err != nil {
		return js.Undefined(), err
	}
	if plan.from == "ofd" {
		if err := checkOFD(data); err != nil {
			return js.Undefined(), err
		}
	} else if plan.to == "ofd" {
		if err := checkImporter(plan.from); err != nil {
			return js.Undefined(), err
		}
	}

	options, err := plan.converterOptions()
	if err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "rendering"})

	var buffer bytes.Buffer
	if err := converter.Convert(ctx, plan.from, plan.to, data, &buffer, options...); err != nil {
		// 取消原样返回，不包成"转换失败"：界面上取消不是错误状态。
		return js.Undefined(), err
	}
	writer := newChunkWriter(job)
	if _, err := writer.Write(buffer.Bytes()); err != nil {
		return js.Undefined(), err
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done"})
	return objectValue(map[string]any{"pages": 0, "size": writer.written, "zipped": false}), nil
}

// converterOptions 按目标格式组装 converter 的选项。
func (p *convertPlan) converterOptions() ([]converter.Option, error) {
	// PDF 走 webreader 路径，这里不会收到 pdf。
	image := isImageFormat(p.to)
	options := []converter.Option{converter.WithFormat(p.to)}
	if p.password != "" {
		options = append(options, converter.WithPassword(p.password))
	}
	if image {
		// 文档类输出不接受 DPI 和背景色：TXT、Markdown、HTML、DOCX
		// 里没有页面像素，传入会被静默忽略，界面上也不该出现。
		options = append(options, converter.DPI(p.dpi), converter.BgColor(p.bgColor()))
	}
	if p.to == "markdown" {
		options = append(options, converter.WithMarkdownTables(p.markdownTables))
	}
	if p.to == "docx" {
		options = append(options,
			converter.WithDOCXTables(p.docxTables),
			converter.WithDOCXImages(p.docxImages),
			converter.WithDOCXAnnotations(p.docxAnnotations),
		)
	}
	if p.to == "html" {
		options = append(options, converter.WithHTMLTextLayer(p.htmlTextLayer))
		switch p.htmlImageFormat {
		case "jpg", "jpeg":
			options = append(options, converter.HTMLJPG())
		case "svg":
			options = append(options, converter.HTMLSVG())
		default:
			options = append(options, converter.HTMLPNG())
		}
	}
	return options, nil
}

// bgColor 解析背景色。默认透明：界面自己提供页面底色，深色阅读模式
// 才不必连产物一起重渲染。
func (p *convertPlan) bgColor() color.Color {
	switch p.background {
	case "white":
		return color.RGBA{R: 255, G: 255, B: 255, A: 255}
	case "black":
		return color.RGBA{R: 0, G: 0, B: 0, A: 255}
	default:
		return color.RGBA{}
	}
}

// report 上报一次进度。没有注册回调时是空操作。
func (j *wasmJob) report(progress convertProgress) {
	if j.progress.Type() != js.TypeFunction {
		return
	}
	invokeCallback(j.progress, exportValue(progress))
}

// chunkWriter 把产物字节分块发给 worker，并在启用流 ID 时等待 ACK。
//
// 背压是必需的：54MB 的 wasm 加上一份未及写盘的产物，浏览器会直接
// 杀掉标签页。让 wasm 写完一块就等一次确认，中间结果就不会堆在内存里。
type chunkWriter struct {
	job      *wasmJob
	buffer   bytes.Buffer
	written  int
	sequence uint64
}

func newChunkWriter(job *wasmJob) *chunkWriter {
	return &chunkWriter{job: job}
}

func (w *chunkWriter) Write(data []byte) (int, error) {
	select {
	case <-w.job.cancelCh:
		return 0, errors.New("输出流已取消")
	default:
	}
	written := len(data)
	remaining := data
	for len(remaining) > 0 {
		space := wasmChunkSize - w.buffer.Len()
		count := len(remaining)
		if count > space {
			count = space
		}
		w.buffer.Write(remaining[:count])
		remaining = remaining[count:]
		if w.buffer.Len() == wasmChunkSize {
			if err := w.flush(); err != nil {
				return 0, err
			}
		}
	}
	w.written += written
	return written, nil
}

func (w *chunkWriter) flush() error {
	if w.buffer.Len() == 0 {
		return nil
	}
	payload := make([]byte, w.buffer.Len())
	copy(payload, w.buffer.Bytes())
	w.buffer.Reset()

	chunk := bytesToJS(payload)
	w.sequence++
	sequence := w.sequence

	var ack chan error
	if w.job.streamID != 0 {
		ack = make(chan error, 1)
		w.job.ackMu.Lock()
		w.job.acks[sequence] = ack
		w.job.ackMu.Unlock()
	}
	if err := invokeCallback(w.job.onChunk, chunk, js.ValueOf(sequence)); err != nil {
		w.dropAck(sequence)
		return err
	}
	if ack == nil {
		return nil
	}
	select {
	case err := <-ack:
		w.dropAck(sequence)
		return err
	case <-w.job.cancelCh:
		w.dropAck(sequence)
		return errors.New("输出流已取消")
	}
}

func (w *chunkWriter) dropAck(sequence uint64) {
	w.job.ackMu.Lock()
	delete(w.job.acks, sequence)
	w.job.ackMu.Unlock()
}

// finish 写出剩余字节。
func (w *chunkWriter) finish() error {
	return w.flush()
}

// streamAck 由 worker 调用，确认某一块已经落盘。
func (a *wasmApp) streamAck(_ js.Value, args []js.Value) any {
	if len(args) < 2 || args[0].Type() != js.TypeNumber || args[1].Type() != js.TypeNumber {
		return errorValue(errors.New("streamAck 需要任务 ID 和块序号"))
	}
	jobID, sequence := uint64(args[0].Int()), uint64(args[1].Int())
	// 空串表示成功而不是「一个消息为空的错误」。调用方习惯传第三个数
	// 表示错误原因，成功时顺手传空串；把它当错误会让整个转换以
	// "关闭 PDF 文档失败: " 这种看不出原因的形式结束。
	var ackErr error
	if len(args) >= 3 && args[2].Type() == js.TypeString {
		if message := args[2].String(); message != "" {
			ackErr = errors.New(message)
		}
	}
	a.mu.Lock()
	job := a.jobs[jobID]
	a.mu.Unlock()
	if job == nil {
		return nil
	}
	job.ackMu.Lock()
	ack := job.acks[sequence]
	job.ackMu.Unlock()
	if ack != nil {
		select {
		case ack <- ackErr:
		default:
		}
	}
	return nil
}

// convertProgress 是上报给界面的进度快照。
type convertProgress struct {
	Phase string `json:"phase"`
	Page  int    `json:"page"`
	Pages int    `json:"pages"`
}

// invokeCallback 调用 JS 回调，把 panic 转成错误而不是让 wasm 实例崩掉。
func invokeCallback(callback js.Value, values ...any) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("输出回调失败: %v", recovered)
		}
	}()
	callback.Invoke(values...)
	return nil
}

// resolveIndices 把范围表达式解析成页索引。
//
// 支持 "1-3,5" 这种写法，与阅读器沿用同一套语法，用户不用记两遍。
func resolveIndices(total int, spec string) ([]int, error) {
	if total <= 0 {
		return nil, errors.New("文档没有页面")
	}
	if strings.TrimSpace(spec) == "" {
		indices := make([]int, total)
		for index := range indices {
			indices[index] = index
		}
		return indices, nil
	}
	selected := make([]bool, total)
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		start, end := part, part
		if dash := strings.Index(part, "-"); dash > 0 {
			start = strings.TrimSpace(part[:dash])
			end = strings.TrimSpace(part[dash+1:])
		}
		first, err := strconv.Atoi(start)
		if err != nil {
			return nil, fmt.Errorf("页码 %q 无法解析", part)
		}
		last, err := strconv.Atoi(end)
		if err != nil {
			return nil, fmt.Errorf("页码 %q 无法解析", part)
		}
		if first > last {
			first, last = last, first
		}
		if first < 1 {
			return nil, fmt.Errorf("页码 %q 小于 1", part)
		}
		if last > total {
			return nil, fmt.Errorf("页码 %q 超出范围（共 %d 页）", part, total)
		}
		for page := first; page <= last; page++ {
			selected[page-1] = true
		}
	}
	indices := make([]int, 0, total)
	for index, ok := range selected {
		if ok {
			indices = append(indices, index)
		}
	}
	if len(indices) == 0 {
		return nil, errors.New("所选页码范围内没有页面")
	}
	return indices, nil
}

// detectFormat 按魔数识别输入格式，与 converter 的 sniffing 保持一致。
func detectFormat(data []byte) (string, error) {
	if len(data) >= 5 && string(data[:5]) == "%PDF-" {
		return "pdf", nil
	}
	// OFD 与 DOCX 都是 ZIP 容器，靠是否含 OFD.xml 区分。浏览器环境
	// 没有 Office 导入器，因此不需要再区分其它 ZIP 格式。
	if len(data) >= 4 && string(data[:4]) == "PK\x03\x04" {
		if bytes.Contains(data, []byte("OFD.xml")) {
			return "ofd", nil
		}
		return "", errors.New("无法识别输入格式，请显式指定来源格式")
	}
	return "", errors.New("无法识别输入格式，请显式指定来源格式")
}

// checkOFD 提前校验 OFD 输入，给出比解析器更直接的错误。
func checkOFD(data []byte) error {
	if len(data) < 4 || string(data[:4]) != "PK\x03\x04" {
		return errors.New("不是有效的 OFD 文件（OFD 应为 ZIP 容器）")
	}
	if !bytes.Contains(data, []byte("OFD.xml")) {
		return errors.New("ZIP 包中没有 OFD.xml，可能不是 OFD 文件")
	}
	return nil
}

// checkImporter 在调用 converter 前拦截未注册的导入格式。
//
// 这道检查只是为了让错误信息说得清：真正会拒绝的是 converter 自己的
// 注册表查询，提前判断是为了把「缺 LibreOffice」和「格式不认识」区分开。
func checkImporter(from string) error {
	if _, ok := converter.ImporterByName(from); ok {
		return nil
	}
	if entry, blocked := browserUnsupported[from]; blocked {
		return fmt.Errorf("%s 转换需要 %s，纯浏览器环境无法运行", from, entry.tool)
	}
	return fmt.Errorf("不支持从 %s 转换为 OFD", from)
}

// isImageFormat 判断目标格式是否逐页输出图像。
func isImageFormat(name string) bool {
	format, ok := converter.FormatByName(name)
	if !ok {
		return false
	}
	return format.Kind == converter.KindImage
}

// normalizeFormat 统一格式名的大小写、空格与常见别名。
func normalizeFormat(name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	switch key {
	case "jpg":
		return "jpeg"
	case "txt":
		return "text"
	case "md":
		return "markdown"
	}
	return key
}
