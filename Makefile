# OFD 工具箱构建。
#
# wasm-opt 是可选的：找不到时用未优化版本并给出警告，不让构建直接失败。
# 有 wasm-opt 时按内容哈希缓存结果——它跑一次约 1 分钟，而输入不变时
# 结果也不变。

GO ?= go
WEB_DIR := cmd/toolbox-wasm/web
BUILD_DIR := /tmp/ofd-toolbox/.build
WASM_RAW := $(BUILD_DIR)/toolbox.raw.wasm
WASM := $(WEB_DIR)/toolbox.wasm
WASM_EXEC := $(WEB_DIR)/wasm_exec.js
# service-worker.js 是生成物：模板入库，缓存名与 SHELL 列表由构建时改写。
SERVICE_WORKER_TEMPLATE := $(WEB_DIR)/service-worker.template.js
SERVICE_WORKER := $(WEB_DIR)/service-worker.js
# wasm-opt 可能只装在 ~/.binaryen 下，而 make 启动的非交互式 shell 不会
# 读 .bashrc 里的 PATH。这里同时查 PATH 与常见安装位置。
WASM_OPT ?= $(firstword $(shell command -v wasm-opt 2>/dev/null) \
	$(wildcard $(HOME)/.binaryen/*/bin/wasm-opt))

# 报体积用的 wc。不用 stat：GNU 与 BSD 的参数不同，而 wc -c 两边一致。
# 少一个字节也要显示出来，否则空产物会被报成 0 字节，看着像构建失败。
COUNT_BYTES = wc -c <

# 跟踪 WASM 需要的所有 Go 源文件：任一改动都让哈希失效。
GO_SOURCES := $(shell find cmd -name '*.go' 2>/dev/null) go.mod go.sum

# ofd 模块是本地 replace，不列进依赖的话，改了 ofd 侧代码再 make 会得到
# "Nothing to be done"——产物还是旧的，而 make 认为它是最新的。这条依赖
# 就是为了让本地 replace 的改动也能触发重编。
OFD_MODULE_DIR := $(shell $(GO) list -m -f '{{.Dir}}' github.com/zc310/ofd 2>/dev/null)
OFD_SOURCES := $(shell find $(OFD_MODULE_DIR) -name '*.go' -not -name '*_test.go' 2>/dev/null)
GO_SOURCES += $(OFD_SOURCES)
# 跟踪需要参与缓存名的 shell 资源：wasm 与 worker 必须同版本，否则页面
# 可能用新 JS 去调旧 wasm。
WEB_SOURCES := $(WEB_DIR)/index.html $(WEB_DIR)/app.js $(WEB_DIR)/worker.js \
	$(WEB_DIR)/toolbox.css $(WEB_DIR)/manifest.webmanifest \
	$(WEB_DIR)/icon.svg $(WEB_DIR)/icon-192.png $(WEB_DIR)/icon-512.png \
	$(WEB_DIR)/icon-maskable-192.png $(WEB_DIR)/icon-maskable-512.png \
	$(WEB_DIR)/apple-touch-icon.png $(WEB_DIR)/favicon-32.png \
	$(WEB_DIR)/wechat-qr.png $(WEB_DIR)/wechat-search.png
# 参与缓存名计算的文件要与 service-worker.js 的 SHELL 列表一致，
# 否则缓存里没有某个资源，换版后那个资源会一直吃旧的。
WEB_SOURCES += $(SERVICE_WORKER_TEMPLATE)

GO_LDFLAGS := -s -w
GO_BUILD_FLAGS := -trimpath -ldflags "$(GO_LDFLAGS)"

# wasm-opt 的功能开关必须与 Go 1.27 的产物匹配：Go 会生成 bulk memory、
# sign extension、nontrapping float to int 等指令，缺一个开关就会在
# 校验阶段报 "memory.copy operations require bulk memory operations"。
# --enable-gc 配合 --disable-gc 以外的场景使用，保留它以便 Go 的类型信息
# 不被过早抹掉。
WASM_OPT_FLAGS := --enable-bulk-memory --enable-bulk-memory-opt \
	--enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
	--enable-simd --enable-reference-types --disable-gc --disable-strings \
	--disable-memory64 --disable-compact-imports -Oz --strip-producers

# 浏览器测试的可执行文件。Chrome 在容器里通常缺 libasound，
# 用 LD_LIBRARY_PATH 指到本地解出来的库，见 browser-test/README.md。
LD_LIBRARY_PATH ?=
export LD_LIBRARY_PATH

.PHONY: all build-wasm serve test test-browser check-browser testdata clean fmt vet check help

all: build-wasm

help:
	@printf '%s\n' 'make build-wasm       构建并优化 WASM，输出到 web/' \
	               'make testdata          生成测试所需的 OFD 样本' \
	               'make serve             启动本地静态服务（浏览器不能通过 file:// 加载 WASM）' \
	               'make test              运行前端脚本与 WASM 测试' \
	               'make testdata          生成测试所需的 OFD 样本' \
	               'make test-browser      在真实 Chrome 里跑一遍页面' \
	               'make fmt vet           格式化与静态检查' \
	               'make check             fmt + vet + build + test' \
	               'make check-browser     check + 浏览器测试' \
	               'make clean             清除构建缓存'

# 本项目只有 js/wasm 一套实现，所有 Go 文件都带 `//go:build js && wasm`。
# 因此 fmt 与 vet 必须在 GOOS=js 下跑，否则会得到"matched no packages"。
GO_TARGET := GOOS=js GOARCH=wasm

fmt:
	@$(GO_TARGET) $(GO) fmt ./...

vet:
	@$(GO_TARGET) $(GO) vet ./...

build-wasm: $(WASM) $(WASM_EXEC) $(WEB_DIR)/service-worker.js

$(BUILD_DIR):
	@mkdir -p "$@"

# 原始 WASM：功能未验证通过前不要跳过优化步骤直接发布。
$(WASM_RAW): $(GO_SOURCES) | $(BUILD_DIR)
	@printf '%s\n' '编译 WASM（未优化）…'
	@CGO_ENABLED=0 GOOS=js GOARCH=wasm $(GO) build $(GO_BUILD_FLAGS) -o "$@" ./cmd/toolbox-wasm
	@printf '%s\n' "  $$($(COUNT_BYTES) "$@" | tr -d ' ') 字节"

# 优化后的大小只写进注释，不做门禁：体积回退要靠对比发现，
# 卡死构建反而会让这条规则被绕过。
$(WASM): $(WASM_RAW)
	@if [ -n "$(WASM_OPT)" ]; then \
		printf '%s\n' '优化 WASM…'; \
		tmp="$$(mktemp -p "$(BUILD_DIR)" opt.XXXXXX.wasm)"; \
		"$(WASM_OPT)" $(WASM_OPT_FLAGS) "$(WASM_RAW)" -o "$$tmp" && mv "$$tmp" "$@" || \
			{ rm -f "$$tmp"; printf '%s\n' '警告：wasm-opt 失败，改用未优化版本。' >&2; cp "$(WASM_RAW)" "$@"; }; \
	else \
		printf '%s\n' '警告：未找到 wasm-opt，使用未优化的 WASM。' >&2; \
		cp "$(WASM_RAW)" "$@"; \
	fi
	@printf '%s\n' "  $$($(COUNT_BYTES) "$@" | tr -d ' ') 字节 → $@"

# wasm_exec.js 是 Go 官方产物，随工具链版本变化，跟着 GOROOT 拷贝。
$(WASM_EXEC):
	@mkdir -p "$(dir $@)"
	@cp "$$(CGO_ENABLED=0 GOOS=js GOARCH=wasm $(GO) env GOROOT)/lib/wasm/wasm_exec.js" "$@"
	@printf '%s\n' "拷贝 wasm_exec.js → $@"

# 缓存名由参与运行的所有资源的内容哈希决定。任一资源变化，缓存名变化，
# 新 Service Worker 安装时清掉旧缓存，页面上的 HTML/JS/WASM 必然同版本。
# 把模板拷出来，按内容哈希改写缓存名。改写发生在副本上，模板保持原样，
# 否则构建一次就把仓库里的文件改了，git status 会一直脏。
$(WEB_DIR)/service-worker.js: $(SERVICE_WORKER_TEMPLATE) $(WEB_SOURCES) $(WASM) $(WASM_EXEC)
	@CACHE_NAME=$$(cat $(WEB_SOURCES) $(WASM) $(WASM_EXEC) 2>/dev/null | sha256sum | cut -c1-16); \
	cp "$(SERVICE_WORKER_TEMPLATE)" "$@"; \
	sed -i.bak "s/^const CACHE_NAME = '.*';\$$/const CACHE_NAME = 'ofd-toolbox_$$CACHE_NAME';/" "$@" \
		&& rm -f "$@.bak"; \
	printf '%s\n' "Service Worker 缓存名 → ofd-toolbox_$$CACHE_NAME"

# 合成测试数据。发票样本、多页样本不在 ofd 仓库里，需要时先生成。
# cmd/make-testdata 目前只在本地、未入库，因此这个目标只在本地可用；
# 测试代码入库时把它一起提交。
testdata:
	@$(GO) run ./cmd/make-testdata testdata

serve: build-wasm
	@printf '%s\n' '服务 http://localhost:8080 …'
	@python3 -m http.server 8080 --directory "$(WEB_DIR)"

# 中文字体：浏览器里没有系统字体，文字水印与页面文字都画不出来，
# 因此"加水印后渲染结果变了"这类断言需要一张真字体才能成立。
# 找不到就跳过字体相关用例，而不是让它们失败。
# 一张带中文字形的 ttf/ttc/otf。浏览器里没有系统字体，文字水印与页面
# 文字都画不出来，"加水印后渲染结果变了"这类断言需要它才成立。
#
# 挑选必须匹配文件名而不是字体族名：用族名做 grep 会撞上无关字体
# （"han" 会匹配到 SitkaItalic），而 woff2 是 canvas 解析不了的格式。
TEST_FONT ?= $(shell fc-list -f '%{file}|%{family}\n' 2>/dev/null \
	| grep -E '\.(ttf|ttc|otf)\|' \
	| grep -iE '\|[^|]*(cjk|hei|song|kai|ming|yahei|simsun|simhei)' \
	| head -1 | cut -d'|' -f1)

test:
	@OFD_TOOLBOX_TEST_FONT="$(TEST_FONT)" node cmd/toolbox-wasm/web/test/run.mjs

# 浏览器测试要真实起 Chrome，比其余测试慢得多，因此不并进 make check：
# 没有可用 Chrome 的环境（CI 精简镜像）里 check 应当照样能过。
# 需要 libasound 时先设 LD_LIBRARY_PATH，见 browser-test/README.md。
test-browser: build-wasm
	@OFD_TOOLBOX_TEST_FONT="$(TEST_FONT)" node browser-test/run.mjs

check: fmt vet build-wasm test

check-browser: check test-browser

clean:
	@rm -rf "$(BUILD_DIR)"
	@printf '%s\n' '已清除构建缓存（web/ 下的产物保留）'
