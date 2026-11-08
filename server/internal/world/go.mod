module homequarters/internal/world

go 1.27.3

require (
	homequarters/internal/gamemap v0.0.0
	homequarters/internal/media v0.0.0
)

// the libraries of this repository, from their folders (no go.work: decision 0041)
replace (
	homequarters/internal/gamemap => ../../internal/gamemap
	homequarters/internal/media => ../../internal/media
)
