//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"syscall/js"
)

// 前端与 WASM 之间的取值和回值约定，集中在这里，避免每个 binding 各写一份。
//
// 约定：所有 binding 正常返回 JS 值；出错时返回 {error: string}，不抛异常。
// 流式接口额外返回 Promise，并把控制权交给回调与 streamAck。

// errorValue 是所有 binding 的统一错误回值。网页侧只需检查 result.error。
func errorValue(err error) js.Value {
	message := err.Error()
	value := js.Global().Get("Object").New()
	value.Set("error", message)
	return value
}

// objectValue 把 Go 映射转成 JS 对象。嵌套切片、映射会自动递归转换。
func objectValue(values map[string]any) js.Value {
	value := js.Global().Get("Object").New()
	for key, item := range values {
		value.Set(key, exportValue(item))
	}
	return value
}

// arrayValue 把 Go 切片转成 JS 数组。
func arrayValue(items []any) js.Value {
	array := js.Global().Get("Array").New(len(items))
	for index, item := range items {
		array.SetIndex(index, exportValue(item))
	}
	return array
}

// exportValue 把 Go 值转成对应的 JS 值。
//
// 标量按类型直接转，字节序列转 Uint8Array，切片与映射按元素递归转；
// 其余类型（结构体等）走 JSON。切片和映射用反射而不是穷举类型：
// 新加一个结构体切片时不必在这里补一条 case，漏掉的表现是网页收到
// 一段 JSON 字节而不是数组，很难一眼看出是导出层的问题。
func exportValue(value any) js.Value {
	switch typed := value.(type) {
	case nil:
		return js.Null()
	case js.Value:
		return typed
	case bool:
		return js.ValueOf(typed)
	case string:
		return js.ValueOf(typed)
	case int:
		return js.ValueOf(typed)
	case int32:
		return js.ValueOf(typed)
	case int64:
		return js.ValueOf(typed)
	case uint32:
		return js.ValueOf(typed)
	case uint64:
		return js.ValueOf(typed)
	case float32:
		return js.ValueOf(typed)
	case float64:
		return js.ValueOf(typed)
	case []byte:
		return bytesToJS(typed)
	case []any:
		return arrayValue(typed)
	case map[string]any:
		return objectValue(typed)
	}

	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.String:
		// 具名字符串类型（如枚举）走不到上面的 string 分支，
		// 而 Kind 这类字段正是这种类型。
		return js.ValueOf(reflected.String())
	case reflect.Slice, reflect.Array:
		// []byte 在上面的类型分支已经处理；到这里的切片都是元素型。
		items := make([]any, reflected.Len())
		for index := 0; index < reflected.Len(); index++ {
			items[index] = reflected.Index(index).Interface()
		}
		return arrayValue(items)
	case reflect.Struct:
		// 按字段名展开成对象，而不是退化成一段 JSON：网页要按字段访问，
		// 拿到字节还得自己解一遍 JSON 才能读到 name。
		return structValue(reflected)
	case reflect.Map:
		object := js.Global().Get("Object").New()
		iterator := reflected.MapRange()
		for iterator.Next() {
			key, ok := iterator.Key().Interface().(string)
			if !ok {
				// 非字符串键无法表达成 JS 对象的属性名，交给 JSON。
				return bytesToJS(mustJSON(value))
			}
			object.Set(key, exportValue(iterator.Value().Interface()))
		}
		return object
	default:
		return bytesToJS(mustJSON(value))
	}
}

// structValue 把结构体按导出字段展开成 JS 对象。字段名取 Go 的 JSON tag，
// 没有 tag 时用字段名。
func structValue(reflected reflect.Value) js.Value {
	object := js.Global().Get("Object").New()
	valueType := reflected.Type()
	for index := 0; index < valueType.NumField(); index++ {
		field := valueType.Field(index)
		// 非导出字段无法 Interface()，跳过。
		if field.PkgPath != "" {
			continue
		}
		name := field.Name
		if tag := field.Tag.Get("json"); tag != "" {
			label := tag
			for index := 0; index < len(tag); index++ {
				if tag[index] == ',' {
					label = tag[:index]
					break
				}
			}
			if label == "-" {
				continue
			}
			if label != "" {
				name = label
			}
		}
		object.Set(name, exportValue(reflected.Field(index).Interface()))
	}
	return object
}

// bytesToJS 把字节包装成 Uint8Array。转换后原切片失效由调用方负责。
func bytesToJS(data []byte) js.Value {
	value := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(value, data)
	return value
}

// bytesFromJS 读取 JS 侧的字节数据。
//
// 先按 BYTES_PER_ELEMENT 判定是不是定型数组，再直接拷贝：CopyBytesToGo 对
// 非定型数组会 panic，而 panic 会带崩整个 WASM 实例（之后所有调用都是
// "instance closed"），一个类型判断失误不该换来整页工具不可用。
//
// 不用 slice() 取前 N 字节：slice 返回的是调用方那个 realm 的定型数组，
// 跨 realm 时 syscall/js 的类型检查认不出来。
func bytesFromJS(value js.Value, field string) ([]byte, error) {
	if value.IsUndefined() || value.IsNull() {
		return nil, fmt.Errorf("%s 为空", field)
	}
	if value.Type() != js.TypeObject {
		return nil, fmt.Errorf("%s 必须是 Uint8Array", field)
	}
	elementSize := value.Get("BYTES_PER_ELEMENT")
	if elementSize.Type() != js.TypeNumber || elementSize.Int() != 1 {
		return nil, fmt.Errorf("%s 必须是字节数组", field)
	}
	length := value.Get("length")
	if length.Type() != js.TypeNumber {
		return nil, fmt.Errorf("%s 缺少长度", field)
	}
	size := length.Int()
	if size <= 0 {
		return nil, fmt.Errorf("%s 为空", field)
	}
	result := make([]byte, size)
	js.CopyBytesToGo(result, value)
	return result, nil
}

// requiredObject 取必填对象参数。
func requiredObject(args []js.Value, name string) (js.Value, error) {
	if len(args) == 0 || args[0].Type() != js.TypeObject {
		return js.Undefined(), errors.New(name + " 需要一个对象参数")
	}
	return args[0], nil
}

// optionalString 取可选字符串参数，缺失或类型不符时返回空串。
func optionalString(object js.Value, key string) string {
	value := object.Get(key)
	if value.Type() != js.TypeString {
		return ""
	}
	return strings.TrimSpace(value.String())
}

// optionalBool 取可选布尔参数。
func optionalBool(object js.Value, key string, fallback bool) bool {
	value := object.Get(key)
	if value.Type() != js.TypeBoolean {
		return fallback
	}
	return value.Bool()
}

// finiteNumber 判断一个 JS 值是否为有限数值。syscall/js 没有 IsInf，
// 用 ±Inf 的比较代替。
func finiteNumber(value js.Value) bool {
	if value.Type() != js.TypeNumber || value.IsNaN() {
		return false
	}
	number := value.Float()
	return number > -math.Inf(1) && number < math.Inf(1)
}

// optionalFloat 取可选数值参数，带最小最大值约束。超出范围时返回错误而不是
// 静默夹紧：把用户填错的 DPI 显示成 600 比报错更难排查。
func optionalFloat(object js.Value, key string, fallback, min, max float64) (float64, error) {
	value := object.Get(key)
	if !finiteNumber(value) {
		return fallback, nil
	}
	number := value.Float()
	if number < min || number > max {
		return 0, fmt.Errorf("%s 必须在 %g 到 %g 之间", key, min, max)
	}
	return number, nil
}

// optionalInt 取可选整数参数。
func optionalInt(object js.Value, key string, fallback, min, max int) (int, error) {
	number, err := optionalFloat(object, key, float64(fallback), float64(min), float64(max))
	if err != nil {
		return 0, err
	}
	return int(number), nil
}

// optionalUint64 取可选的非负整数参数，用于资源 ID 一类的字段。
func optionalUint64(object js.Value, key string) (uint64, error) {
	value := object.Get(key)
	if !finiteNumber(value) {
		return 0, nil
	}
	number := value.Float()
	if number < 0 {
		return 0, fmt.Errorf("%s 不能为负", key)
	}
	return uint64(number), nil
}

// mustJSON 把任意值编码为 JSON 字节，失败时返回带错误信息的 JSON 文档，
// 而不是让 panic 穿透到 JS（那会终止整个 wasm 实例）。
func mustJSON(value any) []byte {
	data, err := jsonMarshal(value)
	if err != nil {
		fallback := fmt.Sprintf("{\"error\":%q}", "序列化结果失败: "+err.Error())
		return []byte(fallback)
	}
	return data
}

// marshalJSON 是显式要 JSON 字节时用的编码入口。
func marshalJSON(value any) ([]byte, error) {
	return jsonMarshal(value)
}

// jsonGeneric 把任意值转成遵循其 json tag 的通用 Go 值。
//
// 用于那些字段已经带完整 json tag 的报告模型（analyzer.Report）：整体编一次
// JSON 再解成 map/slice，键名与标签一致，比手写映射少一层出错空间。
// 与 structValue 的区别是后者按 Go 字段名展开，适用于没有 tag 的类型。
func jsonGeneric(value any) (any, error) {
	data, err := jsonMarshal(value)
	if err != nil {
		return nil, err
	}
	var generic any
	if err := jsonUnmarshal(data, &generic); err != nil {
		return nil, err
	}
	return generic, nil
}

// jsonValue 把任意值转成遵循其 json tag 的 JS 值。
func jsonValue(value any) (js.Value, error) {
	generic, err := jsonGeneric(value)
	if err != nil {
		return js.Undefined(), err
	}
	return exportValue(generic), nil
}

// jsonObject 把任意值转成键值映射。值不是对象时返回空映射。
func jsonObject(value any) map[string]any {
	generic, err := jsonGeneric(value)
	if err != nil {
		return map[string]any{}
	}
	object, ok := generic.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return object
}
