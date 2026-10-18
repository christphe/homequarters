package plugin

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
)

// MaxBundleBytes bounds a plugin's compiled server or client code: QuickJS parses it within the 16 MB
// heap cap and the start budget.
const MaxBundleBytes = 256 << 10

// codeFiles are the files a plugin may import.
var codeFiles = map[string]bool{".ts": true, ".tsx": true, ".js": true, ".mjs": true, ".json": true}

// maxPluginFiles bounds the files of one plugin folder looked at for its fingerprint.
const maxPluginFiles = 2000

// compiled is a plugin's code compiled by esbuild, kept with the fingerprint of the plugin's folder:
// a plugin is compiled when the server scans it and again only if a file changed since.
type compiled struct {
	mu     sync.Mutex
	stamp  string
	server string // JavaScript defining the global __plugin (the module's exports); "" without server code
	client []byte // JavaScript for the browser; nil without client code
	err    error
}

// code returns the plugin's compiled code, compiling again if its folder changed.
func (i *Info) code() (*compiled, error) {
	if i.cache == nil {
		i.cache = &compiled{}
	}
	c := i.cache
	c.mu.Lock()
	defer c.mu.Unlock()
	stamp, err := fingerprint(i.Dir)
	if err != nil {
		return nil, err
	}
	if stamp == c.stamp {
		return c, c.err
	}
	c.stamp, c.server, c.client, c.err = stamp, "", nil, nil
	if i.Server != "" {
		js, err := bundle(i.Dir, i.Dir, i.Server, api.FormatIIFE, "__plugin", api.PlatformNeutral)
		if err != nil {
			c.err = err
			return c, err
		}
		c.server = string(js)
	}
	if i.Client != "" {
		pub := filepath.Join(i.Dir, "public")
		js, err := bundle(pub, pub, i.Client, api.FormatIIFE, "", api.PlatformBrowser)
		if err != nil {
			c.err = err
			return c, err
		}
		c.client = js
	}
	return c, nil
}

// fingerprint hashes the names and contents of a plugin's files (an edit that keeps the size and the
// time, as cp -p or rsync -t do, is still seen). node_modules and dot folders are not code the server
// compiles from (imports of packages are refused) and are skipped.
func fingerprint(dir string) (string, error) {
	h := sha256.New()
	n := 0
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != dir && (d.Name() == "node_modules" || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // links are not read here; what an import reaches through one is checked when compiling
		}
		if n++; n > maxPluginFiles {
			return fmt.Errorf("more than %d files in the plugin folder", maxPluginFiles)
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		fmt.Fprintf(h, "%s\x00", p)
		_, err = io.Copy(h, f)
		return err
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// bundle compiles entry (relative to dir) and the files it imports into one script. Imports must be
// relative paths that stay inside root: no packages, nothing outside the plugin's folder.
func bundle(dir, root, entry string, format api.Format, global string, platform api.Platform) ([]byte, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	if dir, err = filepath.Abs(dir); err != nil {
		return nil, err
	}
	confine := api.Plugin{Name: "confine", Setup: func(b api.PluginBuild) {
		b.OnResolve(api.OnResolveOptions{Filter: ".*"}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
			if a.Kind == api.ResolveEntryPoint {
				return api.OnResolveResult{}, nil
			}
			if !strings.HasPrefix(a.Path, "./") && !strings.HasPrefix(a.Path, "../") {
				return api.OnResolveResult{}, fmt.Errorf("import %q: only files of the plugin can be imported", a.Path)
			}
			p := filepath.Clean(filepath.Join(a.ResolveDir, a.Path))
			if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
				return api.OnResolveResult{}, fmt.Errorf("import %q leaves the plugin's folder", a.Path)
			}
			return api.OnResolveResult{}, nil // esbuild resolves it (extensions, index files)
		})
		// what is actually read, after esbuild followed links, package.json main or browser fields:
		// code files inside the folder, nothing else
		b.OnLoad(api.OnLoadOptions{Filter: ".*"}, func(a api.OnLoadArgs) (api.OnLoadResult, error) {
			real, err := filepath.EvalSymlinks(a.Path)
			if err != nil { // a link that cannot be followed (some Windows junctions): refused as well
				return api.OnLoadResult{}, fmt.Errorf("%s is outside the plugin's folder or cannot be resolved", filepath.Base(a.Path))
			}
			if !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
				return api.OnLoadResult{}, fmt.Errorf("%s is outside the plugin's folder", filepath.Base(a.Path))
			}
			if !codeFiles[strings.ToLower(filepath.Ext(real))] {
				return api.OnLoadResult{}, fmt.Errorf("%s: only .ts, .tsx, .js, .mjs and .json files can be imported", filepath.Base(a.Path))
			}
			return api.OnLoadResult{}, nil // esbuild reads it
		})
	}}
	r := api.Build(api.BuildOptions{
		AbsWorkingDir: dir,
		EntryPoints:   []string{entry},
		Bundle:        true,
		Write:         false,
		Format:        format,
		GlobalName:    global,
		Platform:      platform,
		Target:        api.ES2020,
		Charset:       api.CharsetUTF8,
		LogLevel:      api.LogLevelSilent,
		Plugins:       []api.Plugin{confine},
	})
	if len(r.Errors) > 0 {
		return nil, buildError(r.Errors[0])
	}
	if len(r.OutputFiles) == 0 {
		return nil, errors.New("esbuild produced no output")
	}
	out := r.OutputFiles[0].Contents
	if len(out) > MaxBundleBytes {
		return nil, fmt.Errorf("%s: compiled code of %d bytes is over the %d-byte limit", entry, len(out), MaxBundleBytes)
	}
	return out, nil
}

// buildError says where a compile error is: main.ts:2:16: Expected "(" but found "{".
func buildError(m api.Message) error {
	if m.Location == nil {
		return errors.New(m.Text)
	}
	return fmt.Errorf("%s:%d:%d: %s", filepath.ToSlash(m.Location.File), m.Location.Line, m.Location.Column, m.Text)
}
