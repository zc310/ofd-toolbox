//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"strings"
	"syscall/js"

	"github.com/zc310/ofd/pkg/webreader"
)

// documentHandle 是一个已打开文档的运行时状态。
//
// 原始字节保留在这里而不是每次转换重新传入：转换 Tab 的典型流程是
// 「打开 → 预览若干次 → 转换 → 再预览产物」，字节在内存里只存一份。
type documentHandle struct {
	id   uint64
	name string
	data []byte
}

// openDocument 载入一个 OFD 文档，返回文档 ID 与基础信息。
//
// 只读页面尺寸和字体清单，不解析全部页面内容：万页文档的完整解析要按
// 百毫秒计，而界面首屏只需要知道有多少页、多大、字体够不够。
func (a *wasmApp) openDocument(_ js.Value, args []js.Value) any {
	if len(args) < 1 || len(args) > 2 {
		return errorValue(errors.New("openDocument 需要字节数据和可选文件名"))
	}
	data, err := bytesFromJS(args[0], "文档数据")
	if err != nil {
		return errorValue(err)
	}
	name := ""
	if len(args) >= 2 {
		name = strings.TrimSpace(args[1].String())
	}

	reader, err := a.newReader(data, name)
	if err != nil {
		return errorValue(err)
	}
	defer func() { _ = reader.Close() }()

	pages, err := reader.Pages()
	if err != nil {
		return errorValue(err)
	}
	fonts, err := reader.FontList()
	if err != nil {
		return errorValue(err)
	}
	info, err := reader.Info()
	if err != nil {
		return errorValue(err)
	}
	stats, err := reader.Stats()
	if err != nil {
		return errorValue(err)
	}

	id := a.allocateID()
	a.mu.Lock()
	a.documents[id] = &documentHandle{id: id, name: name, data: data}
	fontCount := len(a.fonts)
	a.mu.Unlock()

	return objectValue(map[string]any{
		"id":        id,
		"name":      name,
		"size":      len(data),
		"pageCount": len(pages),
		"pages":     pagesInfo(pages),
		"fonts":     fontsInfo(fonts),
		"stats":     statsInfo(stats),
		"info":      info,
		// 字体是否齐备直接决定界面要不要显示警告条：文档声明了字体但
		// 一份都没注册为回退时，PDF 里的中文会是方块。
		"fallbackFonts": fontCount,
	})
}

// closeDocument 释放文档占用的字节。必须显式调用：WASM 线性内存只增不减，
// 批量处理时忘记关闭会一路累积到浏览器杀标签页。
func (a *wasmApp) closeDocument(_ js.Value, args []js.Value) any {
	id, err := parseDocumentID(args, "closeDocument")
	if err != nil {
		return errorValue(err)
	}
	a.mu.Lock()
	_, ok := a.documents[id]
	delete(a.documents, id)
	a.mu.Unlock()
	if !ok {
		return errorValue(fmt.Errorf("文档 %d 未打开", id))
	}
	return nil
}

// documentInfo 返回文档的详细元数据，供信息面板使用。
func (a *wasmApp) documentInfo(_ js.Value, args []js.Value) any {
	id, err := parseDocumentID(args, "documentInfo")
	if err != nil {
		return errorValue(err)
	}
	data, _, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return errorValue(err)
	}
	defer func() { _ = reader.Close() }()

	info, err := reader.Info()
	if err != nil {
		return errorValue(err)
	}
	outline, err := reader.Outline()
	if err != nil {
		return errorValue(err)
	}
	stats, err := reader.Stats()
	if err != nil {
		return errorValue(err)
	}
	preferences, err := reader.Preferences()
	if err != nil {
		return errorValue(err)
	}
	signatures, err := reader.Signatures()
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{
		"info":        info,
		"outline":     outline,
		"stats":       statsInfo(stats),
		"preferences": preferences,
		"signatures":  signatures,
	})
}

// renderPage 渲染单页为 PNG 字节，供预览区显示。
func (a *wasmApp) renderPage(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return errorValue(errors.New("renderPage 需要文档 ID 和页码"))
	}
	id := uint64(args[0].Int())
	index := int(args[1].Int())
	options, err := renderOptions(args, 2)
	if err != nil {
		return errorValue(err)
	}
	data, _, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return errorValue(err)
	}
	defer func() { _ = reader.Close() }()

	page, err := reader.RenderPage(index, options)
	if err != nil {
		return errorValue(err)
	}
	return objectValue(map[string]any{"data": page, "page": index})
}

// renderThumbnails 批量渲染低分辨率缩略图。
//
// 限制 64 页是浏览器侧的内存约束：缩略图在主线程解码后常驻，上千张
// 320px PNG 会把标签页拖垮，因此侧栏改用虚拟列表按需请求。
func (a *wasmApp) renderThumbnails(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return errorValue(errors.New("renderThumbnails 需要文档 ID 和页码数组"))
	}
	const maxThumbnails = 64
	id := uint64(args[0].Int())
	indices, err := jsIndices(args[1], maxThumbnails)
	if err != nil {
		return errorValue(err)
	}
	options, err := renderOptions(args, 2)
	if err != nil {
		return errorValue(err)
	}
	data, _, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	reader, err := a.newReader(data, "")
	if err != nil {
		return errorValue(err)
	}
	defer func() { _ = reader.Close() }()

	// 缩略图统一按低 DPI 渲染而不是缩放已渲染的大图：后者会让矢量内容
	// 走一遍多余的光栅化，而且放大后的位图边缘发虚。
	thumbOptions := options
	thumbOptions.DPI = 36
	thumbs, err := reader.RenderPages(indices, thumbOptions)
	if err != nil {
		return errorValue(err)
	}
	items := make([]any, len(thumbs))
	for index, thumb := range thumbs {
		items[index] = map[string]any{"data": thumb, "page": indices[index]}
	}
	return objectValue(map[string]any{"thumbs": items})
}

// statsInfo 把资源统计转成 JS 值。
//
// webreader.DocumentStats 的字段没有 json tag，直接导出的话网页侧拿到的是
// "Fonts"、"Signatures" 这样的大写键。字段不多，手写映射比给上游加 tag
// 更省事，也不必为了界面改动 ofd 仓库。
func statsInfo(stats webreader.DocumentStats) map[string]any {
	return map[string]any{
		"fonts":           stats.Fonts,
		"attachments":     stats.Attachments,
		"media":           stats.Media,
		"annotationPages": stats.AnnotationPages,
		"signatures":      stats.Signatures,
	}
}

// newReader 用 app 已注册的字体打开一个阅读器。
func (a *wasmApp) newReader(data []byte, name string) (*webreader.Reader, error) {
	reader, err := webreader.Open(data)
	if err != nil {
		if name != "" {
			return nil, fmt.Errorf("打开 %s 失败: %w", name, err)
		}
		return nil, fmt.Errorf("打开文档失败: %w", err)
	}
	a.mu.Lock()
	fonts := append([]fontEntry(nil), a.fonts...)
	a.mu.Unlock()
	for _, entry := range fonts {
		// 单个字体注册失败不能让整个文档打不开：回退链里少一个字体族
		// 仍然可用，剩下的差异只是字形选择。
		_ = reader.UseFallbackFont(entry.family)
	}
	return reader, nil
}

// documentBytes 取已打开文档的字节。
func (a *wasmApp) documentBytes(id uint64) ([]byte, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	handle, ok := a.documents[id]
	if !ok {
		return nil, "", fmt.Errorf("文档 %d 未打开", id)
	}
	return handle.data, handle.name, nil
}

// renderOptions 读取渲染参数。第三个及之后的参数为可选对象。
func renderOptions(args []js.Value, offset int) (webreader.RenderOptions, error) {
	options := webreader.RenderOptions{
		// 预览用透明背景：界面自己提供页面底色，这样深色阅读模式
		// 不需要重渲染。
		Background: transparentBackground(),
		Format:     webreader.RenderPNG,
	}
	if len(args) <= offset || args[offset].Type() != js.TypeObject {
		return options, nil
	}
	value := args[offset]
	if format := optionalString(value, "format"); format != "" {
		switch format {
		case "png":
			options.Format = webreader.RenderPNG
		case "jpg":
			options.Format = webreader.RenderJPG
		case "svg":
			options.Format = webreader.RenderSVG
		default:
			return options, fmt.Errorf("渲染格式 %q 不支持", format)
		}
	}
	dpi, err := optionalFloat(value, "dpi", 96, 1, 600)
	if err != nil {
		return options, err
	}
	if dpi != 96 {
		options.DPI = dpi
	}
	return options, nil
}

// jsIndices 从 JS 数组读页码索引。
func jsIndices(value js.Value, limit int) ([]int, error) {
	if value.Type() != js.TypeObject {
		return nil, errors.New("页码列表必须是数组")
	}
	length := value.Get("length")
	if length.Type() != js.TypeNumber {
		return nil, errors.New("页码列表缺少长度")
	}
	count := length.Int()
	if count <= 0 {
		return nil, errors.New("页码列表为空")
	}
	if count > limit {
		return nil, fmt.Errorf("单次最多处理 %d 页", limit)
	}
	indices := make([]int, 0, count)
	for index := 0; index < count; index++ {
		item := value.Index(index)
		if item.Type() != js.TypeNumber {
			return nil, fmt.Errorf("第 %d 个页码不是数字", index+1)
		}
		indices = append(indices, item.Int())
	}
	return indices, nil
}
