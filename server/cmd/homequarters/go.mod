module homequarters/cmd/homequarters

go 1.27.3

require (
	homequarters/internal/config v0.0.0
	homequarters/internal/gamemap v0.0.0
	homequarters/internal/httpapi v0.0.0
	homequarters/internal/media v0.0.0
	homequarters/internal/store v0.0.0
	homequarters/internal/testbed v0.0.0
)

require (
	github.com/coder/websocket v1.8.15 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/evanw/esbuild v0.28.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.48.0 // indirect
	homequarters/internal/auth v0.0.0 // indirect
	homequarters/internal/plugin v0.0.0 // indirect
	homequarters/internal/world v0.0.0 // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/libquickjs v0.13.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
	modernc.org/quickjs v0.25.0 // indirect
	modernc.org/sqlite v1.60.1 // indirect
)

// the libraries of this repository, from their folders (no go.work: decision 0041)
replace (
	homequarters/internal/auth => ../../internal/auth
	homequarters/internal/config => ../../internal/config
	homequarters/internal/gamemap => ../../internal/gamemap
	homequarters/internal/httpapi => ../../internal/httpapi
	homequarters/internal/media => ../../internal/media
	homequarters/internal/plugin => ../../internal/plugin
	homequarters/internal/store => ../../internal/store
	homequarters/internal/testbed => ../../internal/testbed
	homequarters/internal/world => ../../internal/world
)
