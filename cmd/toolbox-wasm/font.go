//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"image/color"
	"strings"
	"syscall/js"

	"github.com/zc310/ofd/pkg/webreader"
)

// fontEntry 是已注册的回退字体。
//
// 只保存字体族名而不保存字节：webreader 的字体注册表自己持有数据，
// app 这里记一份只是为了「有哪些字体可用」这个列表能直接回答界面，
// 以及 removeFallbackFont 时能判断是否重复注册。
type fontEntry struct {
	family string
	weight int
	italic bool
	// size 是字节数，界面上用来告诉用户字体一共占了多少内存。
	size int
	// source 标记字体是内置预置还是用户上传。
	source string
}

// addFallbackFont 注册一个回退字体族。
//
// 重复注册同一族是幂等的：阅读器打开文档时会逐个 UseFallbackFont，
// 同名重复只会让注册表越来越大，而界面上的字体管理列表并不需要这种重复。
//
// 必须同时调 webreader.RegisterFallbackFont：app 侧的 a.fonts 只是"记账"，
// 真正让渲染器能取到字体字节的是渲染引擎的全局注册表。少了这一步，
// Reader.UseFallbackFont 会以"回退字体族未注册"失败，而 newReader 又把这个
// 错误吞掉了——注册看起来成功，实际上一个字体都没进去，页面上所有逻辑字体
// 仍然画不出来。
func (a *wasmApp) addFallbackFont(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return errorValue(errors.New("addFallbackFont 需要字体数据和字体族名"))
	}
	data, err := bytesFromJS(args[0], "字体数据")
	if err != nil {
		return errorValue(err)
	}
	family := strings.TrimSpace(args[1].String())
	if family == "" {
		return errorValue(errors.New("字体族名不能为空"))
	}
	weight := 400
	if len(args) >= 3 && args[2].Type() == js.TypeNumber {
		weight = args[2].Int()
	}
	italic := false
	if len(args) >= 4 && args[3].Type() == js.TypeBoolean {
		italic = args[3].Bool()
	}
	source := "upload"
	if len(args) >= 5 && args[4].Type() == js.TypeString {
		if value := strings.TrimSpace(args[4].String()); value != "" {
			source = value
		}
	}

	// 先落到渲染引擎的全局注册表。失败要在这里报出来：注册表是进程级的，
	// 事后无法撤销，因此不能像 newReader 里那样忽略错误。
	if err := webreader.RegisterFallbackFont(webreader.FontSource{
		Data:   data,
		Family: family,
		Weight: weight,
		Italic: italic,
	}); err != nil {
		return errorValue(fmt.Errorf("注册回退字体族 %q 失败: %w", family, err))
	}

	a.mu.Lock()
	registered := false
	for index := range a.fonts {
		if a.fonts[index].family == family {
			// 同族再注册只更新体积，权重与斜体以首次注册为准：
			// 界面上的回退字体按族管理，不区分同一族的多个字重。
			a.fonts[index].size = len(data)
			registered = true
			break
		}
	}
	if !registered {
		a.fonts = append(a.fonts, fontEntry{
			family: family,
			weight: weight,
			italic: italic,
			size:   len(data),
			source: source,
		})
	}
	count := len(a.fonts)
	a.mu.Unlock()

	return objectValue(map[string]any{"count": count})
}

// removeFallbackFont 注销一个字体族。
//
// 从 a.fonts 里去掉后，之后每次渲染新建的 Reader 都不再登记它，画面随即
// 回退到缺字体的样子——这一点有测试守着（注册→渲染变化→移除→渲染复原）。
//
// 但字体字节仍留在渲染引擎的全局注册表里：那一层没有反注册接口，
// 数据由注册表持有引用，不会被回收。反复注册不同字体是实打实的内存增长，
// 界面上把每份字体的体积列出来就是为了让这件事可见。
func (a *wasmApp) removeFallbackFont(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return errorValue(errors.New("removeFallbackFont 需要字体族名"))
	}
	family := strings.TrimSpace(args[0].String())
	a.mu.Lock()
	remaining := a.fonts[:0]
	removed := false
	for _, entry := range a.fonts {
		if entry.family == family {
			removed = true
			continue
		}
		remaining = append(remaining, entry)
	}
	a.fonts = remaining
	count := len(a.fonts)
	a.mu.Unlock()
	if !removed {
		return errorValue(fmt.Errorf("字体族 %q 未注册", family))
	}
	return objectValue(map[string]any{"count": count})
}

// listFallbackFonts 返回已注册的字体族列表。
func (a *wasmApp) listFallbackFonts(_ js.Value, args []js.Value) any {
	if len(args) > 0 {
		return errorValue(errors.New("listFallbackFonts 不接受参数"))
	}
	a.mu.Lock()
	entries := make([]any, 0, len(a.fonts))
	total := 0
	for _, entry := range a.fonts {
		entries = append(entries, map[string]any{
			"family": entry.family,
			"weight": entry.weight,
			"italic": entry.italic,
			"size":   entry.size,
			"source": entry.source,
		})
		total += entry.size
	}
	a.mu.Unlock()
	return objectValue(map[string]any{"fonts": entries, "totalSize": total})
}

// fontsInfo 把阅读器的字体清单转成 JS 值。
func fontsInfo(fonts []webreader.FontInfo) []any {
	items := make([]any, 0, len(fonts))
	for _, font := range fonts {
		items = append(items, map[string]any{
			"id":         font.ID,
			"scope":      font.Scope,
			"name":       font.Name,
			"family":     font.Family,
			"bold":       font.Bold,
			"italic":     font.Italic,
			"serif":      font.Serif,
			"fixedWidth": font.FixedWidth,
			"format":     font.Format,
			"embedded":   font.Embedded,
		})
	}
	return items
}

// pagesInfo 把页面清单转成 JS 值。
func pagesInfo(pages []webreader.PageInfo) []any {
	items := make([]any, 0, len(pages))
	for index, page := range pages {
		items = append(items, map[string]any{
			"index":  index,
			"width":  page.Width,
			"height": page.Height,
		})
	}
	return items
}

// transparentBackground 是预览用的透明背景。
//
// 界面自己画页面底色，这样深色阅读模式切换时不需要重渲染全部页面。
func transparentBackground() color.Color {
	return color.RGBA{R: 0, G: 0, B: 0, A: 0}
}
