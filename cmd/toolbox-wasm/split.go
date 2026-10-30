//go:build js && wasm

package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"math"
	"path"
	"strings"
	"syscall/js"
	"unicode"

	"github.com/zc310/ofd/pkg/creator"
	"github.com/zc310/ofd/pkg/creator/split"
)

// splitDocument 逐份生成 OFD，直接写入外层 ZIP，经现有分块 + ACK 通道下载。
func (a *wasmApp) splitDocument(_ js.Value, args []js.Value) any {
	request, err := requiredObject(args, "splitDocument")
	if err != nil {
		return errorValue(err)
	}
	id, err := optionalUint64(request, "documentId")
	if err != nil || id == 0 {
		return errorValue(errors.New("未指定输入文档"))
	}
	data, name, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}
	selection, options, err := splitOptionsFromJS(request)
	if err != nil {
		return errorValue(err)
	}
	return a.startOutputStream(args, func(ctx context.Context, job *wasmJob) (js.Value, error) {
		session, err := split.Open(ctx, data, options)
		if err != nil {
			return js.Undefined(), err
		}
		defer session.Close()
		parts, err := session.Plan(selection)
		if err != nil {
			return js.Undefined(), err
		}
		// 输入文件名只用作文件名，不允许成为 ZIP 内路径。
		stem := path.Base(strings.ReplaceAll(name, "\\", "/"))
		stem = strings.TrimSuffix(stem, path.Ext(stem))
		stem = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) || strings.ContainsRune(`<>:"|?*`, r) {
				return '_'
			}
			return r
		}, stem)
		stem = strings.Trim(stem, " .")
		if stem == "" {
			stem = "document"
		}
		writer := newChunkWriter(job)
		archive := zip.NewWriter(writer)
		reports := make([]any, 0, len(parts))
		for i, part := range parts {
			if err := ctx.Err(); err != nil {
				return js.Undefined(), err
			}
			job.report(convertProgress{Phase: "splitting", Page: i + 1, Pages: len(parts)})
			filename := fmt.Sprintf("%s_%03d.ofd", stem, i+1)
			// OFD 本身已经压缩，外层只打包，避免重复压缩。
			entry, err := archive.CreateHeader(&zip.FileHeader{Name: filename, Method: zip.Store})
			if err != nil {
				return js.Undefined(), err
			}
			report, err := session.Write(ctx, part, entry)
			if err != nil {
				return js.Undefined(), fmt.Errorf("拆分第 %d 份失败: %w", i+1, err)
			}
			reports = append(reports, map[string]any{
				"name": filename, "document": report.Document, "pages": report.Pages,
				"size": report.Bytes, "dropped": report.Dropped,
				"droppedSignatures": report.DroppedSignatures, "signatures": report.Signatures,
			})
		}
		if err := archive.Close(); err != nil {
			return js.Undefined(), err
		}
		if err := writer.finish(); err != nil {
			return js.Undefined(), err
		}
		job.report(convertProgress{Phase: "done"})
		return objectValue(map[string]any{
			"name": stem + "_拆分结果.zip", "mime": "application/zip",
			"size": writer.written, "parts": reports,
		}), nil
	})
}

func splitOptionsFromJS(request js.Value) (split.Selection, split.Options, error) {
	selection := split.Selection{}
	options := split.Options{
		KeepAttachments: optionalBool(request, "keepAttachments", false),
		DropIntegrity:   optionalBool(request, "dropIntegrity", false),
		Limits:          split.Limits{MaxParts: 1000},
	}
	options.Signatures = creator.SignaturePreserve
	switch optionalString(request, "signatures") {
	case "", "preserve":
	case "drop":
		options.Signatures = creator.SignatureDrop
	default:
		return selection, options, errors.New("不支持的签名处理方式")
	}
	mode := optionalString(request, "mode")
	if mode == "document" {
		selection.ByDocument = true
		return selection, options, nil
	}
	document, err := splitPositiveInt(request, "document", 1, 10000)
	if err != nil {
		return selection, options, err
	}
	selection.Document = document
	switch mode {
	case "", "every":
		selection.Every, err = splitPositiveInt(request, "every", 1, 100000)
	case "groups":
		selection.Groups, err = split.ParseGroups(optionalString(request, "groups"), 100000, 1000)
	default:
		err = errors.New("不支持的拆分方式")
	}
	return selection, options, err
}

func splitPositiveInt(request js.Value, key string, fallback, max int) (int, error) {
	value := request.Get(key)
	if value.IsUndefined() {
		return fallback, nil
	}
	if !finiteNumber(value) || math.Trunc(value.Float()) != value.Float() || value.Float() < 1 || value.Float() > float64(max) {
		return 0, fmt.Errorf("%s 必须为 1 到 %d 之间的整数", key, max)
	}
	return value.Int(), nil
}
