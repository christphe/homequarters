// Package plugin runs operator-installed plugins: TypeScript (or JavaScript) on the server, run by
// QuickJS, and in a sandboxed iframe in the browser. A plugin is a folder holding a plugin.json
// manifest, optional server code and an optional public/ folder whose files (and only those) are
// served to browsers.
package plugin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// MaxAssetBytes bounds one served file of a plugin's public/ folder.
const MaxAssetBytes = 1 << 20

var nameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// assetTypes lists the file types a plugin may serve, with their content types.
var assetTypes = map[string]string{
	".png":  "image/png",
	".js":   "text/javascript; charset=utf-8",
	".json": "application/json",
	".css":  "text/css; charset=utf-8",
}

type Manifest struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Server      string `json:"server"` // .ts or .js file in the plugin folder, optional
	Client      string `json:"client"` // .ts or .js file in public/, optional
	// AppTokens lets members create a token for this plugin, for routes declared with { token: true }
	AppTokens bool `json:"appTokens"`
}

// Info is one installed plugin. Err is set when it cannot run (broken).
type Info struct {
	Manifest
	Dir   string
	Err   string
	cache *compiled // shared by copies of this Info
}

// Scan reads every subfolder of dir holding a plugin.json. Broken plugins are listed with Err set.
func Scan(dir string) ([]Info, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []Info
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		pd := filepath.Join(dir, e.Name())
		if _, err := os.Stat(filepath.Join(pd, "plugin.json")); err != nil {
			continue
		}
		out = append(out, load(pd))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func load(dir string) Info {
	folder := filepath.Base(dir)
	i := Info{Dir: dir, Manifest: Manifest{Name: folder}}
	fail := func(f string, a ...any) Info {
		i.Err = fmt.Sprintf(f, a...)
		if i.Title == "" {
			i.Title = i.Name // the admin dialog always has a name to show
		}
		return i
	}
	b, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return fail("plugin.json: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return fail("plugin.json: %v", err)
	}
	if !nameRE.MatchString(m.Name) {
		return fail("name %q must match %s", m.Name, nameRE)
	}
	if m.Name != folder {
		return fail("name %q differs from its folder %q", m.Name, folder)
	}
	i.Manifest = m
	if m.Title == "" {
		i.Title = m.Name
	}
	if m.Server == "" && m.Client == "" {
		return fail("the manifest names neither a server or client file")
	}
	if m.Server != "" {
		if !local(m.Server) || !script(m.Server) {
			return fail("server %q must be a .ts or .js file inside the plugin folder", m.Server)
		}
		if strings.HasPrefix(filepath.ToSlash(filepath.Clean(m.Server)), "public/") {
			return fail("server %q must not be in public/: everything there is served to browsers", m.Server)
		}
		if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(m.Server))); err != nil || !st.Mode().IsRegular() {
			return fail("server %s: missing", m.Server)
		}
	}
	if m.Client != "" {
		if !local(m.Client) || !script(m.Client) {
			return fail("client %q must be a .ts or .js file inside public/", m.Client)
		}
		if st, err := os.Stat(filepath.Join(dir, "public", filepath.FromSlash(m.Client))); err != nil || !st.Mode().IsRegular() {
			return fail("client %s: no such file in public/", m.Client)
		}
	}
	if _, err := i.code(); err != nil {
		return fail("%v", err)
	}
	return i
}

func script(p string) bool { e := filepath.Ext(p); return e == ".ts" || e == ".js" }

// local reports whether a manifest path stays inside its folder.
func local(p string) bool {
	return p != "" && filepath.IsLocal(filepath.FromSlash(p)) && !strings.Contains(p, "\\")
}

// Asset resolves a path relative to public/ to a servable file. Hidden files, other types,
// files over MaxAssetBytes and anything resolving outside public/ (.., symlinks) are refused.
func (i *Info) Asset(rel string) (string, bool) {
	if rel == "" || strings.Contains(rel, "\\") || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return "", false
		}
	}
	if _, ok := assetTypes[strings.ToLower(filepath.Ext(rel))]; !ok {
		return "", false
	}
	pub, err := filepath.EvalSymlinks(filepath.Join(i.Dir, "public"))
	if err != nil {
		return "", false
	}
	p, err := filepath.EvalSymlinks(filepath.Join(pub, filepath.FromSlash(rel)))
	if err != nil || !strings.HasPrefix(p, pub+string(filepath.Separator)) {
		return "", false
	}
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() || st.Size() > MaxAssetBytes {
		return "", false
	}
	return p, true
}

// ContentType is the type served for an asset path.
func ContentType(p string) string { return assetTypes[strings.ToLower(filepath.Ext(p))] }
