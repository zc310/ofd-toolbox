module github.com/zc310/ofd-toolbox

go 1.27

// 以下 replace 必须在本项目重新声明：Go 不继承依赖的 replace 指令。
// 漏掉 canvas 会报 cg.Extend undefined（渐变 Extend 字段在修改版 canvas 上）。
// 各 fork 的作用见 README「依赖替换」一节。
replace github.com/tdewolff/font => github.com/zc310/font v0.0.0-20260928001413-b20a21f7a3b5

replace github.com/tdewolff/canvas => github.com/zc310/canvas v0.0.0-20261008081244-a01253362cef

replace github.com/lumifloat/tinyskia => github.com/zc310/tinyskia v0.0.0-20260923132319-d6ae6947b9ac

require github.com/zc310/ofd v0.1.5-0.20261008110233-0f5aece52e22

require (
	codeberg.org/go-latex/latex v0.3.0 // indirect
	codeberg.org/go-pdf/fpdf v0.12.0 // indirect
	github.com/BurntSushi/freetype-go v0.0.0-20160129220410-b763ddbfe298 // indirect
	github.com/BurntSushi/graphics-go v0.0.0-20160129215708-b43f31a4a966 // indirect
	github.com/BurntSushi/toml v1.6.0 // indirect
	github.com/BurntSushi/xgb v0.0.0-20210121224620-deaf085860bc // indirect
	github.com/BurntSushi/xgbutil v0.0.0-20190907113008-ad855c713046 // indirect
	github.com/ByteArena/poly2tri-go v0.0.0-20170716161910-d102ad91854f // indirect
	github.com/Kagami/go-avif v0.1.0 // indirect
	github.com/andybalholm/brotli v1.2.6 // indirect
	github.com/beevik/etree v1.8.1 // indirect
	github.com/benoitkugler/textlayout v0.3.2 // indirect
	github.com/benoitkugler/textprocessing v0.0.6 // indirect
	github.com/clipperhouse/uax29/v2 v2.7.0 // indirect
	github.com/dkrisman/gobig2 v0.0.0-20260513123937-51e39052fde6 // indirect
	github.com/emmansun/gmsm v0.45.0 // indirect
	github.com/go-fonts/latin-modern v0.3.3 // indirect
	github.com/go-text/typesetting v0.3.5 // indirect
	github.com/goccy/go-json v0.11.2 // indirect
	github.com/golang/freetype v0.0.0-20170609003504-e2365dfdc4a0 // indirect
	github.com/h2non/filetype v1.1.3 // indirect
	github.com/hhrutter/tiff v1.0.7 // indirect
	github.com/klauspost/compress v1.20.1 // indirect
	github.com/knroy/go-xml v1.6.0 // indirect
	github.com/kolesa-team/go-webp v1.0.5 // indirect
	github.com/kovidgoyal/go-parallel v1.1.1 // indirect
	github.com/kovidgoyal/go-shm v1.0.0 // indirect
	github.com/kovidgoyal/imaging v1.8.24-0.20261007033220-40391a359a37 // indirect
	github.com/mattn/go-runewidth v0.0.31 // indirect
	github.com/mrjoshuak/go-jpeg2000 v1.5.12 // indirect
	github.com/pdfcpu/pdfcpu v0.16.1 // indirect
	github.com/richardlehane/mscfb v1.0.9 // indirect
	github.com/richardlehane/msoleps v1.0.6 // indirect
	github.com/rwcarlsen/goexif v0.0.0-20190401172101-9e8deecbddbd // indirect
	github.com/srwiley/rasterx v0.0.0-20220730225603-2ab79fcdd4ef // indirect
	github.com/srwiley/scanx v0.0.0-20190309010443-e94503791388 // indirect
	github.com/tdewolff/canvas v0.0.0-20260913163248-dd4999d1c76a // indirect
	github.com/tdewolff/font v0.0.0-20260913163313-54f98bb59ee6 // indirect
	github.com/tdewolff/minify/v2 v2.24.19 // indirect
	github.com/tdewolff/parse/v2 v2.8.16 // indirect
	github.com/tiendc/go-deepcopy v1.7.2 // indirect
	github.com/wcharczuk/go-chart/v2 v2.1.2 // indirect
	github.com/woozymasta/png v1.2.0 // indirect
	github.com/xuri/efp v0.0.2 // indirect
	github.com/xuri/excelize/v2 v2.11.0 // indirect
	github.com/xuri/nfp v0.0.2-0.20250530014748-2ddeb826f9a9 // indirect
	github.com/yuin/goldmark v1.8.6 // indirect
	github.com/zc310/fontfix v0.0.3-0.20261008003548-25f9b65742e4 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/image v0.46.0 // indirect
	golang.org/x/net v0.59.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	gonum.org/v1/plot v0.17.0 // indirect
	modernc.org/knuth v0.6.0 // indirect
	modernc.org/token v1.1.0 // indirect
	star-tex.org/x/tex v0.7.1 // indirect
)
