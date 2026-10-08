//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"syscall/js"

	"github.com/zc310/ofd/pkg/invoice"
)

// 发票 Tab 的 binding。
//
// 抽取结果整体过 JSON 往返：invoice.Invoice 的字段带完整 tag，且金额用
// Decimal（MarshalJSON 输出十进制字符串以避免浮点误差）。金额绝不能当数字
// 传给网页——"1130.00" 变成 1130 后再转回文本就少了小数位，财务对账
// 场景下这个差别是事故。

// extractInvoice 从已打开的 OFD 发票中抽取结构化信息。
func (a *wasmApp) extractInvoice(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return errorValue(errors.New("extractInvoice 需要文档 ID"))
	}
	id := uint64(args[0].Int())
	data, name, err := a.documentBytes(id)
	if err != nil {
		return errorValue(err)
	}

	result, err := invoice.Extract(data)
	if err != nil {
		// 附件缺失是最常见的失败，而原因在错误消息里已经写明
		// （"未找到 OFD 发票结构化附件"）。补一句用户能据此判断下一步：
		// 该 OFD 确实不是发票，还是发票但厂商用了别的附件布局。
		if errors.Is(err, invoice.ErrNoAttachment) {
			return errorValue(fmt.Errorf(
				"该文档不含发票结构化附件，可能不是增值税电子发票；"+
					"若确为发票，请确认厂商是否按 Doc_0/Attachs 存放附件：%w", err))
		}
		return errorValue(err)
	}

	generic, err := jsonGeneric(result)
	if err != nil {
		return errorValue(err)
	}
	// 来源文件名放在 source 而不是混进发票字段：那是界面上下文，
	// 不是发票的一部分，导出 JSON 时也不该出现。
	if object, ok := generic.(map[string]any); ok {
		object["source"] = name
	}
	return exportValue(generic)
}
