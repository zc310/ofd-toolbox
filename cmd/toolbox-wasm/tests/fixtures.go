//go:build ignore

// 为 WASM 比较测试生成含嵌入字体的确定性小文档。
package main

import (
	"os"
	"path/filepath"

	"github.com/zc310/ofd/pkg/creator"
	"golang.org/x/image/font/gofont/goregular"
)

func main() {
	for name, texts := range map[string][]string{
		"base": {"alpha", "beta"}, "inserted": {"alpha", "inserted", "beta"},
		"changed": {"alpha", "changed beta"},
	} {
		pages := make([]creator.Page, len(texts))
		for i, text := range texts {
			pages[i].Items = []creator.Item{creator.Text{X: 2, Y: 2, Width: 25, Height: 8, Font: "Go", Size: 3, Value: text}}
		}
		data, err := creator.Marshal(creator.Document{
			ID: "wasm-compare", PageSize: creator.PageSize{Width: 30, Height: 20},
			Fonts: []creator.Font{{Name: "Go", Data: goregular.TTF}}, Pages: pages,
		})
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join(os.Args[1], name+".ofd"), data, 0600); err != nil {
			panic(err)
		}
	}
}
