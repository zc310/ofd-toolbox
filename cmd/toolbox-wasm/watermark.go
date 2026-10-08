//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"syscall/js"
	"unicode"

	"github.com/zc310/ofd/pkg/creator"
	"github.com/zc310/ofd/pkg/watermark"
	"github.com/zc310/ofd/pkg/webreader"
)

// 水印 Tab 的 binding。
//
// 水印是"改写"而不是"生成"：它在包内页面上写一条 Type="Watermark" 的注解，
// 产物是一个新的 OFD 包。因此走和转换一样的流式输出路径（分块 + ACK），
// 大文档才不会把 wasm 内存顶爆。
//
// 三个语义陷阱，界面上都必须说出来：
//
//  1. 签名。加水印会改动页面内容，已有签名的摘要随即失效。replace.Options
//     的零值等价于 SignatureDrop，也就是**默认删掉签名条目**。对"给一份
//     已签章的合同加机密水印"这种需求，静默删掉签名是不可接受的，因此这里
//     默认改成 Preserve，并把警告透传给界面。
//  2. 只读。既有水印注解的 ReadOnly 缺省是 true（XSD 默认），Replace/Remove
//     会直接被拒。因此这里给新加的水印显式写 ReadOnly=false：本工具加的水印
//     必须能被本工具改掉或删掉，否则用户加完一次就再也动不了，只能每次都
//     去勾"忽略只读"。既有的外部水印仍按文档的声明处理。
//  3. 权限。Permissions/Watermark=false 的文档默认拒绝一切水印编辑，同样
//     需要一个显式的"仍然继续"开关。

// applyWatermark 对已打开的 OFD 执行一次水印操作，产物经分块回调流出。
//
// 参数与 startConvert 同构：请求对象、产物分块回调、进度回调，返回 Promise。
func (a *wasmApp) applyWatermark(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "applyWatermark")
	if err != nil {
		return errorValue(err)
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return errorValue(errors.New("applyWatermark 需要产物分块回调"))
	}

	plan, err := a.buildWatermarkPlan(request)
	if err != nil {
		return errorValue(err)
	}

	job := &wasmJob{
		id:      plan.jobID,
		onChunk: args[1],
		// 水印产物与转换产物同量级，同样走带 ACK 的背压路径。
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
			result, runErr := a.runWatermark(plan, job)
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

// watermarkPlan 是一次水印操作的解析结果。
type watermarkPlan struct {
	jobID      uint64
	streamID   uint64
	documentID uint64

	action string // add / replace / remove
	pages  []int  // 空表示全部页面
	// matchIDs 为空表示匹配全部水印注解；非空时只处理这些 ID。
	matchIDs []uint64
	skipRO   bool
	skipPrv  bool
	// signatures 是签名处理方式，默认 preserve。
	signatures string

	mark watermark.Watermark
	// image 水印图片字节，非空时用图片水印而不是文本水印。
	image []byte
	// pageBox 是首个目标页的物理尺寸（毫米），用于外观布局与注解边界。
	pageBox creator.Box
}

// buildWatermarkPlan 解析并校验水印请求。
func (a *wasmApp) buildWatermarkPlan(request js.Value) (*watermarkPlan, error) {
	plan := &watermarkPlan{
		action:     optionalString(request, "action"),
		skipRO:     optionalBool(request, "skipReadOnly", false),
		skipPrv:    optionalBool(request, "skipPermissions", false),
		signatures: optionalString(request, "signatures"),
	}
	if plan.action == "" {
		plan.action = "add"
	}
	switch plan.action {
	case "add", "replace", "remove":
	default:
		return nil, fmt.Errorf("不支持的水印操作 %q", plan.action)
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

	documentID, err := optionalUint64(request, "documentId")
	if err != nil {
		return nil, err
	}
	if documentID == 0 {
		return nil, errors.New("未指定输入文档")
	}
	plan.documentID = documentID

	if pages := request.Get("pages"); !pages.IsUndefined() && !pages.IsNull() {
		indices, err := jsIndices(pages, maxWatermarkPages)
		if err != nil {
			return nil, fmt.Errorf("页码列表无效: %w", err)
		}
		plan.pages = indices
	}

	if ids := request.Get("matchIds"); !ids.IsUndefined() && !ids.IsNull() {
		// 只对 replace/remove 有意义：add 不匹配任何既有注解。
		if plan.action == "add" {
			return nil, errors.New("添加水印不接受 matchIds，请改用 replace")
		}
		numeric, err := jsUint64List(ids, maxWatermarkMatchIDs)
		if err != nil {
			return nil, err
		}
		if len(numeric) == 0 {
			return nil, errors.New("matchIds 为空数组，无法按 ID 匹配")
		}
		plan.matchIDs = numeric
	}

	// 签名默认保留。加水印会让摘要失效，但删掉签名条目等于抹掉原件上的
	// 签章痕迹——对"给已签合同加机密标记"这种需求，那比留一个失效摘要更糟。
	switch plan.signatures {
	case "", "preserve":
		plan.signatures = "preserve"
	case "drop", "rewrite":
	default:
		return nil, fmt.Errorf("不支持的签名处理方式 %q", plan.signatures)
	}

	// 外观布局区域与注解边界都用首个目标页的真实尺寸，不用硬编码 A4：
	// 平铺与居中按 Boundary 算网格，在非 A4 页面上按 A4 算会溢出或只铺一角。
	pageBox, err := a.firstTargetPageBox(plan)
	if err != nil {
		return nil, err
	}
	plan.pageBox = pageBox

	// 字体 ID 必须来自文档实际声明的字体表，理由见 resolveWatermarkFont。
	fontID, err := a.resolveWatermarkFont(request, plan.documentID)
	if err != nil {
		return nil, err
	}

	mark, err := buildWatermarkMark(request, plan.action, pageBox, fontID)
	if err != nil {
		return nil, err
	}
	plan.mark = mark

	// 注解 <Appearance> 必须带 Boundary，否则渲染器整条跳过：
	// render.Document.annot 的第一个条件就是 annot.Appearance.Boundary == nil。
	// library 的 Watermark.Boundary 注释只说"为空时不写该属性"，没说
	// 不写就画不出来——照字面理解会写出一份"加好了但看不见"的水印。
	plan.mark.Boundary = &creator.Box{
		X: 0, Y: 0, Width: pageBox.Width, Height: pageBox.Height,
	}
	return plan, nil
}

// resolveWatermarkFont 解析水印文字要用的字体 ID。
//
// 必须取自文档实际声明的字体表，不能沿用 library 的默认值 "0"。
// TextAppearance 在 Font 为空时写 Font="0"，而 0 号字体在多数文档里
// 并不存在（999.ofd 声明的是 2~5），于是渲染时 LoadFont(0) 查不到
// 字体、textWithBudget 直接 return——水印写进了包里，页面上什么都没有。
// 这个失败是完全静默的：不报错，产物也校验通过，只有肉眼能发现少了水印。
//
// 因此默认从文档字体表里挑一个：优先内嵌字体，其次名称像中文字体的，
// 再次任意一个。挑不到就返回空串并让上层报错，而不是写一个必然画不出来的 ID。
func (a *wasmApp) resolveWatermarkFont(request js.Value, documentID uint64) (string, error) {
	if explicit := optionalString(request, "font"); explicit != "" {
		return explicit, nil
	}
	data, _, err := a.documentBytes(documentID)
	if err != nil {
		return "", err
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return "", err
	}
	defer func() { _ = reader.Close() }()

	fonts, err := reader.FontList()
	if err != nil {
		return "", err
	}
	if len(fonts) == 0 {
		return "", errors.New(
			"文档没有声明任何字体，无法写入文字水印：" +
				"Font 属性必须指向文档字体表里真实存在的 ID，" +
				"填一个不存在的 ID 会得到一份页面上看不见水印的文件，" +
				"且不报错。可改用图片水印，或先用「转换」把文档内嵌好字体。")
	}
	return pickWatermarkFont(fonts), nil
}

// pickWatermarkFont 从字体表里挑一个最适合当水印字体的。
//
// 顺序是内嵌字体 → 中文名 → 任意。内嵌字体优先是因为它一定能在浏览器里
// 画出来：浏览器没有系统字体，逻辑字体（只有 FontName、没有 FontFile）
// 在 js/wasm 下只能靠已注册的字体回退兜底，用户没注册就画不出来。
func pickWatermarkFont(fonts []webreader.FontInfo) string {
	best := ""
	bestScore := -1
	for _, font := range fonts {
		score := 0
		if font.Embedded {
			score += 4
		}
		if hasCJK(font.Name) || hasCJK(font.Family) {
			score += 2
		}
		if font.Serif {
			// 发票、合同这类文档正文多是宋体一类的衬线字体，
			// 水印跟着正文走更协调。
			score++
		}
		if score > bestScore {
			best, bestScore = strconv.FormatUint(font.ID, 10), score
		}
	}
	return best
}

// hasCJK 判断字体名里是否含中日韩统一表意文字。
func hasCJK(name string) bool {
	for _, r := range name {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// firstTargetPageBox 取首个目标页的物理尺寸。
//
// 用真实页面尺寸而不是硬编码 A4：平铺与居中要按 Boundary 计算网格，
// 在非 A4 页面上按 A4 算会溢出边界或只铺满一角。
func (a *wasmApp) firstTargetPageBox(plan *watermarkPlan) (creator.Box, error) {
	data, _, err := a.documentBytes(plan.documentID)
	if err != nil {
		return creator.Box{}, err
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return creator.Box{}, err
	}
	defer func() { _ = reader.Close() }()

	pages, err := reader.Pages()
	if err != nil {
		return creator.Box{}, err
	}
	if len(pages) == 0 {
		return creator.Box{}, errors.New("文档没有页面")
	}
	index := 0
	if len(plan.pages) > 0 {
		index = plan.pages[0]
		if index < 0 || index >= len(pages) {
			return creator.Box{}, fmt.Errorf("页面下标 %d 超出范围（共 %d 页）", index, len(pages))
		}
	}
	return creator.Box{Width: pages[index].Width, Height: pages[index].Height}, nil
}

// maxWatermarkMatchIDs 单次允许指定的注解 ID 数量上限。
const maxWatermarkMatchIDs = 4096

// jsUint64List 读一个正整数数组。
func jsUint64List(value js.Value, limit int) ([]uint64, error) {
	if value.Type() != js.TypeObject {
		return nil, errors.New("注解 ID 列表必须是数组")
	}
	length := value.Get("length")
	if length.Type() != js.TypeNumber {
		return nil, errors.New("注解 ID 列表缺少长度")
	}
	count := length.Int()
	if count <= 0 {
		return nil, errors.New("注解 ID 列表为空")
	}
	if count > limit {
		return nil, fmt.Errorf("单次最多匹配 %d 个注解", limit)
	}
	result := make([]uint64, 0, count)
	for index := 0; index < count; index++ {
		item := value.Index(index)
		if item.Type() != js.TypeNumber || !finiteNumber(item) {
			return nil, fmt.Errorf("第 %d 个注解 ID 不是数字", index+1)
		}
		number := item.Int()
		// 注解 ID 从 1 开始：0 表示"自动分配"，匹配 0 永远匹配不到东西。
		if number <= 0 {
			return nil, fmt.Errorf("第 %d 个注解 ID 必须大于 0", index+1)
		}
		result = append(result, uint64(number))
	}
	return result, nil
}

// maxWatermarkPages 单次允许指定的页数上限。
//
// 与 renderThumbnails 的 64 同量级：页码数组从网页侧逐项传过来，
// 上限本身是防御性的，避免一次误传传进上万个下标。
const maxWatermarkPages = 4096

// buildWatermarkMark 从请求里组装水印注解及其外观。
//
// remove 不需要外观，因此外观解析失败不应该挡住删除操作。
//
// fontID 由调用方解析好传进来：它必须来自文档实际声明的字体，
// 原因见 resolveWatermarkFont。
func buildWatermarkMark(request js.Value, action string, boundary creator.Box, fontID string) (watermark.Watermark, error) {
	mark := watermark.Watermark{
		Creator: optionalString(request, "creator"),
		Remark:  optionalString(request, "remark"),
	}
	if action != "remove" {
		// 不写 ReadOnly 时 XSD 默认为 true，之后 replace/remove 会被自己
		// 刚加的水印挡住（引擎的 readOnlyBlocked 对缺省值按 true 处理）。
		// 因此显式写 ReadOnly=false，让本工具加的水印保持可改可删。
		//
		// 注意语义是反的：界面上叫"可继续编辑"，落到 XML 里是 ReadOnly=false。
		// 之前这里直接写了 editable，读到的是 ReadOnly="true"，
		// 第一次测试替换就被自己加的水印挡下来了。
		editable := optionalBool(request, "editable", true)
		readOnly := !editable
		mark.ReadOnly = &readOnly
		mark.Visible = new(bool)
		*mark.Visible = optionalBool(request, "visible", true)
	}
	if id, err := optionalUint64(request, "id"); err == nil {
		mark.ID = id
	} else {
		return mark, err
	}

	if kind := optionalString(request, "kind"); kind == "image" {
		data := request.Get("image")
		if data.IsUndefined() || data.IsNull() {
			return mark, errors.New("图片水印缺少图片数据")
		}
		decoded, err := bytesFromJS(data, "水印图片")
		if err != nil {
			return mark, err
		}
		width, err := optionalFloat(request, "imageWidth", 40, 1, 2000)
		if err != nil {
			return mark, err
		}
		height, err := optionalFloat(request, "imageHeight", 0, 0, 2000)
		if err != nil {
			return mark, err
		}
		layout, err := watermarkLayout(request, "imageLayout")
		if err != nil {
			return mark, err
		}
		image := &watermark.Image{
			Data:   decoded,
			Format: optionalString(request, "imageFormat"),
			Width:  width,
			Height: height,
			Layout: layout,
		}
		if image.Format == "" {
			image.Format = "PNG"
		}
		// Opacity 会被烘焙进 PNG 的 alpha 通道，因此只支持 PNG。
		// 其它格式给出明确错误而不是产出一张不透明的图。
		if opacity, ok, err := optionalUint8(request, "imageOpacity"); err != nil {
			return mark, err
		} else if ok {
			if image.Format != "PNG" {
				return mark, fmt.Errorf(
					"图片水印设置不透明度时只支持 PNG，当前格式是 %s", image.Format)
			}
			image.Opacity = &opacity
		}
		mark.Image = image
		return mark, nil
	}

	// 文本水印。remove 时 text 允许为空：那一步只删注解，不需要外观。
	text := optionalString(request, "text")
	if text == "" {
		if action == "remove" {
			return mark, nil
		}
		return mark, errors.New("请填写水印文字")
	}
	size, err := optionalFloat(request, "size", 9, 1, 200)
	if err != nil {
		return mark, err
	}
	rotation, err := optionalFloat(request, "rotation", 0, -360, 360)
	if err != nil {
		return mark, err
	}
	offsetX, err := optionalFloat(request, "x", 0, -2000, 2000)
	if err != nil {
		return mark, err
	}
	offsetY, err := optionalFloat(request, "y", 0, -2000, 2000)
	if err != nil {
		return mark, err
	}
	layout, err := watermarkLayout(request, "layout")
	if err != nil {
		return mark, err
	}
	lineGap, err := optionalFloat(request, "lineGap", 0, 0, 500)
	if err != nil {
		return mark, err
	}
	columnGap, err := optionalFloat(request, "columnGap", 0, 0, 500)
	if err != nil {
		return mark, err
	}
	opacity, hasOpacity, err := optionalUint8(request, "opacity")
	if err != nil {
		return mark, err
	}

	options := watermark.TextOptions{
		Font:      fontID,
		Size:      size,
		Text:      text,
		X:         offsetX,
		Y:         offsetY,
		Rotation:  rotation,
		Layout:    layout,
		LineGap:   lineGap,
		ColumnGap: columnGap,
		Boundary:  boundary,
	}
	if hasOpacity {
		options.Opacity = &opacity
	}
	if color := optionalString(request, "color"); color != "" {
		parsed, err := parseWatermarkColor(color)
		if err != nil {
			return mark, err
		}
		options.Color = parsed
	}
	appearance, err := watermark.TextAppearance(options)
	if err != nil {
		return mark, err
	}
	mark.Appearance = appearance
	return mark, nil
}

// watermarkLayout 解析布局方式。
func watermarkLayout(request js.Value, key string) (watermark.TextLayout, error) {
	switch optionalString(request, key) {
	case "", "manual":
		return watermark.LayoutManual, nil
	case "tile":
		return watermark.LayoutTile, nil
	case "center":
		return watermark.LayoutCenter, nil
	default:
		return watermark.LayoutManual, fmt.Errorf("不支持的布局方式")
	}
}

// parseWatermarkColor 解析 #rgb / #rrggbb 形式的颜色。
func parseWatermarkColor(value string) (*creator.Color, error) {
	text := strings.TrimSpace(value)
	if !strings.HasPrefix(text, "#") {
		return nil, fmt.Errorf("颜色要用 #rrggbb 形式，当前是 %q", value)
	}
	digits := strings.TrimPrefix(text, "#")
	// 短写形式 #abc 展开成 #aabbcc，与 CSS 一致。
	if len(digits) == 3 {
		var expanded strings.Builder
		for _, r := range digits {
			expanded.WriteRune(r)
			expanded.WriteRune(r)
		}
		digits = expanded.String()
	}
	if len(digits) != 6 {
		return nil, fmt.Errorf("颜色要用 #rrggbb 或 #rgb 形式，当前是 %q", value)
	}
	value64, err := strconv.ParseUint(digits, 16, 32)
	if err != nil {
		return nil, fmt.Errorf("颜色 %q 无法解析", value)
	}
	return &creator.Color{
		R: uint8(value64 >> 16),
		G: uint8(value64 >> 8),
		B: uint8(value64),
	}, nil
}

// optionalUint8 读取 0 到 255 的可选整数。
//
// 返回值里的 bool 表示"是否给了值"：0 本身是合法的不透明度，
// 不能靠值是否为零来区分"没填"和"填了 0"。
func optionalUint8(request js.Value, key string) (uint8, bool, error) {
	item := request.Get(key)
	// 没给这个键是正常情况，不能当成"类型不对"——0 本身是合法取值，
	// 区分"没填"和"填了 0"只能看键在不在。
	if item.IsUndefined() || item.IsNull() {
		return 0, false, nil
	}
	if item.Type() != js.TypeNumber {
		return 0, false, fmt.Errorf("%s 必须是数字", key)
	}
	if !finiteNumber(item) {
		return 0, false, fmt.Errorf("%s 不是有限数字", key)
	}
	value := item.Float()
	if value != float64(int(value)) {
		return 0, false, fmt.Errorf("%s 必须是整数", key)
	}
	if value < 0 || value > 255 {
		return 0, false, fmt.Errorf("%s 应在 0 到 255 之间，当前是 %g", key, value)
	}
	return uint8(value), true, nil
}

// runWatermark 执行水印操作并把产物分块写出。
func (a *wasmApp) runWatermark(plan *watermarkPlan, job *wasmJob) (js.Value, error) {
	data, name, err := a.documentBytes(plan.documentID)
	if err != nil {
		return js.Undefined(), err
	}
	if err := checkOFD(data); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "rendering"})

	target := watermark.Target{Document: -1, Pages: plan.pages, MatchIDs: plan.matchIDs}

	// replace.Options 内嵌在 watermark.Options 里，复合字面量不能直接给
	// 内嵌字段赋值，因此先构造再赋进去。
	var warnings []string
	options := watermark.Options{
		SkipPermissionsCheck: plan.skipPrv,
		SkipReadOnlyCheck:    plan.skipRO,
	}
	options.Signatures = creator.SignaturePreserve
	if plan.signatures == "drop" {
		options.Signatures = creator.SignatureDrop
	} else if plan.signatures == "rewrite" {
		options.Signatures = creator.SignatureRewrite
	}
	options.OnWarning = func(message string) {
		warnings = append(warnings, message)
	}

	writer := newChunkWriter(job)
	var runErr error
	switch plan.action {
	case "add":
		runErr = watermark.Add(data, target, plan.mark, writer, options)
	case "replace":
		runErr = watermark.Replace(data, target, plan.mark, writer, options)
	default:
		// Remove 的签名没有 Watermark 参数：它只按 Target 匹配并删除。
		runErr = watermark.Remove(data, target, writer, options)
	}
	if runErr != nil {
		return js.Undefined(), runErr
	}
	if err := writer.finish(); err != nil {
		return js.Undefined(), err
	}
	job.report(convertProgress{Phase: "done"})

	pages := len(plan.pages)
	if pages == 0 {
		pages = -1 // 全部页面，界面据此显示"全部"
	}
	return objectValue(map[string]any{
		"pages":    pages,
		"size":     writer.written,
		"warnings": warnings,
		"name":     suggestWatermarkName(name, plan.action),
	}), nil
}

// suggestWatermarkName 给出带标记的产物文件名。
func suggestWatermarkName(source, action string) string {
	base := source
	if dot := strings.LastIndex(base, "."); dot > 0 {
		base = base[:dot]
	}
	verb := "watermarked"
	switch action {
	case "replace":
		verb = "watermark-replaced"
	case "remove":
		verb = "watermark-removed"
	}
	return base + "-" + verb + ".ofd"
}

// watermarkInventory 列出文档里已有的水印注解。
//
// 替换与删除都需要知道当前有什么可操作，界面上也要显示出来，
// 否则用户只能对着一份不知道内容的文档猜。
func (a *wasmApp) watermarkInventory(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorValue(errors.New("watermarkInventory 需要文档 ID"))
	}
	id := uint64(args[0].Int())
	data, _, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return errorValue(err)
	}
	defer func() { _ = reader.Close() }()

	annotations, err := reader.Annotations()
	if err != nil {
		return errorValue(err)
	}
	items := make([]any, 0, len(annotations))
	for _, annot := range annotations {
		if annot.Type != "Watermark" {
			continue
		}
		items = append(items, map[string]any{
			"id":          annot.ID,
			"page":        annot.Page,
			"scope":       annot.Scope,
			"subtype":     annot.Subtype,
			"creator":     annot.Creator,
			"lastModDate": annot.LastModDate,
			"visible":     annot.Visible,
			"remark":      annot.Remark,
			"boundary":    watermarkBoundary(annot.Boundary),
			// numericID 为 0 表示 ID 不是纯数字，按 ID 精确匹配用不了它，
			// 界面据此禁用"仅替换所选"而不是发一个必然匹配不到的水印操作。
			"numericID": watermarkAnnotationID(annot.ID),
		})
	}
	return objectValue(map[string]any{"items": items})
}

// watermarkBoundary 把注解边界转成带字段名的映射。
//
// 不能直接把结构体丢给 exportValue：AnnotationBoundary 没有 json tag，
// 导出后拿到的是 {"0":110,"1":117,...} 这种下标键，界面上没法用。
func watermarkBoundary(boundary *webreader.AnnotationBoundary) map[string]any {
	if boundary == nil {
		return nil
	}
	return map[string]any{
		"x": boundary.X, "y": boundary.Y,
		"width": boundary.Width, "height": boundary.Height,
	}
}

// watermarkAnnotationID 把注解 ID 文本转成 MatchIDs 需要的整数。
//
// 注解 ID 在 XSD 里是字符串，但引擎的 MatchIDs 是 []uint64，只能匹配数值。
// 解析不出来时返回 0，界面据此提示"该水印无法按 ID 精确匹配"。
func watermarkAnnotationID(text string) uint64 {
	value, err := strconv.ParseUint(strings.TrimSpace(text), 10, 64)
	if err != nil {
		return 0
	}
	return value
}
