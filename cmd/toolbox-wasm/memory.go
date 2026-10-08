//go:build js && wasm

package main

import (
	"errors"
	"runtime"
	"runtime/debug"
	"syscall/js"
)

// memoryStats 返回 Go 运行时的内存快照。
//
// 这套工具箱的 wasm 有 50MB 量级，转换大文档时的内存曲线是真实风险，
// 所以诊断面板要能区分两件事：Go 存活堆高说明文档太大、确实该关；
// 线性内存只增不减则是 wasm 的固有行为，不该被当成泄漏。
// memoryStats 返回 Go 运行时的内存快照。
//
// linearBytes 是可选的 WebAssembly 线性内存字节数，由 JS 侧传入：
// Go 的 syscall/js 拿不到 WebAssembly.Memory 实例，只有宿主能读到它的
// buffer.byteLength。
func (a *wasmApp) memoryStats(_ js.Value, args []js.Value) any {
	if len(args) > 1 {
		return errorValue(errors.New("memoryStats 最多接受一个参数"))
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)

	a.mu.Lock()
	openDocuments := len(a.documents)
	documentBytes := 0
	for _, handle := range a.documents {
		documentBytes += len(handle.data)
	}
	fontBytes := 0
	for _, entry := range a.fonts {
		fontBytes += entry.size
	}
	activeJobs := len(a.jobs)
	reports := len(a.reports)
	analyses := len(a.analyses)
	a.mu.Unlock()

	var linear uint64
	if len(args) == 1 && args[0].Type() == js.TypeNumber {
		linear = uint64(args[0].Float())
	}
	return objectValue(map[string]any{
		"heapAlloc":    stats.HeapAlloc,
		"heapInuse":    stats.HeapInuse,
		"heapSys":      stats.HeapSys,
		"heapReleased": stats.HeapReleased,
		"heapObjects":  stats.HeapObjects,
		"totalAlloc":   stats.TotalAlloc,
		"numGC":        stats.NumGC,
		// linear 是 WebAssembly.Memory 的字节数。WebAssembly 只支持增长，
		// 垃圾回收只把空闲页标记为可复用，不会把地址空间还给浏览器，
		// 因此它大于 heapAlloc 是正常的。为 0 表示宿主未提供该值。
		"linear":            linear,
		"openDocuments":     openDocuments,
		"documentBytes":     documentBytes,
		"fallbackFontBytes": fontBytes,
		"activeJobs":        activeJobs,
		"cachedReports":     reports,
		"cachedAnalyses":    analyses,
	})
}

// gc 主动触发垃圾回收并尝试把空闲内存归还操作系统。
//
// 只回收内存，不关闭任何文档：诊断面板上的「强制回收」不应该有副作用。
// 注意它不会缩小 wasm 线性内存，只是让空闲页可以被后续转换复用。
func (a *wasmApp) gc(_ js.Value, args []js.Value) any {
	if len(args) > 1 {
		return errorValue(errors.New("gc 最多接受一个参数"))
	}
	runtime.GC()
	debug.FreeOSMemory()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	var linear uint64
	if len(args) == 1 && args[0].Type() == js.TypeNumber {
		linear = uint64(args[0].Float())
	}
	return objectValue(map[string]any{
		"heapAlloc":    stats.HeapAlloc,
		"heapInuse":    stats.HeapInuse,
		"heapReleased": stats.HeapReleased,
		"numGC":        stats.NumGC,
		"linear":       linear,
	})
}
