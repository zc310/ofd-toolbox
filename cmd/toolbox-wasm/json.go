//go:build js && wasm

package main

import (
	"encoding/json"
	"time"
)

// jsonMarshal 是全项目唯一的 JSON 编码入口。集中在这里是为了让 WASM 侧的
// 回值行为可预期：网页按 JSON 语义读取报告字段，不需要知道哪些类型走了
// JSON、哪些走了结构化转换。
//
// HTML 转义默认开启是有意的：报告里的 Message 可能包含厂商写进 XML 的
// 文件名和路径，直接拼进 innerHTML 会形成注入面。JS 侧读到字符串后再决定
// 用 textContent 还是 innerHTML。
func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}

// jsonUnmarshal 是 jsonMarshal 的逆操作，供 jsonValue 把编码结果解回通用值。
func jsonUnmarshal(data []byte, target any) error {
	return json.Unmarshal(data, target)
}

// jsonTime 统一时间字段的呈现。Report 里的 StartedAt 等字段用默认 RFC3339
// 即可，但网页端要显示"3 分钟前"这类相对时间，额外给出毫秒时间戳避免
// 自己解析字符串。
type jsonTime = time.Time
