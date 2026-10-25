// Package plugin runs operator-installed plugins: TypeScript (or JavaScript) on the server, run by
// QuickJS, and in a sandboxed iframe in the browser. A plugin is a folder holding a plugin.json
// manifest, optional server code and an optional public/ folder whose files (and only those) are
// served to browsers. Plugin folders live in bundled/ (shipped with the image, named hq-*) or
// installed/ (the operator's, never hq-*) under the plugins directory, and are only ever read.
package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// MaxAssetBytes bounds one served file of a plugin's public/ folder.
const MaxAssetBytes = 1 << 20

var nameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// The two sides of the plugins directory, and the name prefix reserved for the bundled side: an
// image update adding a bundled plugin can never take the name of a plugin an office installed.
const (
	Bundled   = "bundled"
	Installed = "installed"
	reserved  = "hq-"
)

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
	Description string `json:"description"` // one line in the admin list, at most maxDescription characters
	// LongDescription explains the plugin in the admin dialog's About modal (paragraphs: blank lines)
	LongDescription string `json:"longDescription"`
	Server          string `json:"server"` // .ts or .js file in the plugin folder, optional
	Client          string `json:"client"` // .ts or .js file in public/, optional
	// AppTokens lets members create a token for this plugin, for routes declared with { token: true }
	AppTokens bool `json:"appTokens"`
	// Settings are the office's choices an administrator makes for this plugin in the admin dialog
	Settings []Setting `json:"settings"`
	// ExternalHosts are the only hosts the plugin's browser code may fetch from (images it cannot ship,
	// say), over https: shown to administrators, enforced in its iframe by a Content Security Policy
	ExternalHosts []string `json:"externalHosts"`
	// Objects are the kinds of map object the plugin provides (props of type <plugin>/<kind>)
	Objects []Object `json:"objects"`
	// Views are extra browser scripts, name to file in public/, run later in a visible sandboxed iframe
	Views map[string]string `json:"views"`
}

// Object is one kind of map object a plugin provides, at the given size in tiles. With a Sprite (a PNG
// of public/, optionally cut from a sheet by Frame) the page draws it; without one (absent or null)
// the plugin's browser code draws it. Dynamic objects also get onObjectUpdate in the browser.
type Object struct {
	Kind    string  `json:"kind"`
	Label   string  `json:"label"`
	Size    [2]int  `json:"size"`
	Sprite  *string `json:"sprite"`
	Frame   *[4]int `json:"frame,omitempty"` // x, y, w, h in the sprite, whole image when absent
	Dynamic bool    `json:"dynamic"`
}

const (
	maxObjects = 8
	maxViews   = 4
)

// Object returns the declared object of a kind.
func (i *Info) Object(kind string) (Object, bool) {
	for _, o := range i.Objects {
		if o.Kind == kind {
			return o, true
		}
	}
	return Object{}, false
}

// checkObjects validates the manifest's objects and views against the files of public/.
func checkObjects(dir string, m Manifest) error {
	pub := filepath.Join(dir, "public")
	regular := func(rel string) bool {
		st, err := os.Stat(filepath.Join(pub, filepath.FromSlash(rel)))
		return err == nil && st.Mode().IsRegular()
	}
	if len(m.Objects) > maxObjects {
		return fmt.Errorf("objects: at most %d", maxObjects)
	}
	seen := map[string]bool{}
	for _, o := range m.Objects {
		switch {
		case !nameRE.MatchString(o.Kind):
			return fmt.Errorf("object kind %q must match %s", o.Kind, nameRE)
		case seen[o.Kind]:
			return fmt.Errorf("object %q is declared twice", o.Kind)
		case strings.TrimSpace(o.Label) == "" || len([]rune(o.Label)) > 40:
			return fmt.Errorf("object %q needs a label of 1 to 40 characters", o.Kind)
		case o.Size[0] < 1 || o.Size[0] > 4 || o.Size[1] < 1 || o.Size[1] > 4:
			return fmt.Errorf("object %q: size is [width, height], each 1 to 4 tiles", o.Kind)
		}
		if sp := o.Sprite; sp != nil {
			switch {
			case !local(*sp) || strings.ToLower(filepath.Ext(*sp)) != ".png":
				return fmt.Errorf("object %q: sprite %q must be a .png file inside public/ (or null when the plugin draws it)", o.Kind, *sp)
			case !regular(*sp):
				return fmt.Errorf("object %q: sprite %s: no such file in public/", o.Kind, *sp)
			}
		}
		if f := o.Frame; f != nil && (f[0] < 0 || f[1] < 0 || f[2] < 1 || f[2] > 128 || f[3] < 1 || f[3] > 128) {
			return fmt.Errorf("object %q: frame is [x, y, width, height] with x, y >= 0 and width, height 1 to 128", o.Kind)
		}
		seen[o.Kind] = true
	}
	if len(m.Views) > maxViews {
		return fmt.Errorf("views: at most %d", maxViews)
	}
	for name, file := range m.Views {
		switch {
		case !nameRE.MatchString(name):
			return fmt.Errorf("view name %q must match %s", name, nameRE)
		case !local(file) || !script(file):
			return fmt.Errorf("view %q: %q must be a .ts or .js file inside public/", name, file)
		case !regular(file):
			return fmt.Errorf("view %q: %s: no such file in public/", name, file)
		}
	}
	return nil
}

var hostRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

const maxExternalHosts = 8

// Setting is one administrator's choice a plugin declares: Home Quarters draws it in the admin dialog,
// checks and stores it, and the plugin reads it (hq.settings()). Only whole numbers for now.
type Setting struct {
	Key     string  `json:"key"`
	Label   string  `json:"label"`
	Type    string  `json:"type"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Default float64 `json:"default"`
	Help    string  `json:"help"` // shown under the field, at most 200 characters
}

const (
	maxSettings        = 16
	maxDescription     = 160
	maxLongDescription = 2000
)

var settingKeyRE = regexp.MustCompile(`^[a-z][a-zA-Z0-9]{0,31}$`)

func whole(v float64) bool { return v == float64(int64(v)) && v >= -1e6 && v <= 1e6 }

// checkSettings validates the manifest's settings.
func checkSettings(list []Setting) error {
	if len(list) > maxSettings {
		return fmt.Errorf("at most %d settings", maxSettings)
	}
	seen := map[string]bool{}
	for _, s := range list {
		switch {
		case !settingKeyRE.MatchString(s.Key):
			return fmt.Errorf("setting key %q must match %s", s.Key, settingKeyRE)
		case seen[s.Key]:
			return fmt.Errorf("setting %q is declared twice", s.Key)
		case strings.TrimSpace(s.Label) == "" || len([]rune(s.Label)) > 40:
			return fmt.Errorf("setting %q needs a label of 1 to 40 characters", s.Key)
		case len([]rune(s.Help)) > 200:
			return fmt.Errorf("setting %q: help is at most 200 characters", s.Key)
		case s.Type != "number":
			return fmt.Errorf("setting %q: type must be \"number\"", s.Key)
		case !whole(s.Min) || !whole(s.Max) || !whole(s.Default) || s.Min > s.Max || s.Default < s.Min || s.Default > s.Max:
			return fmt.Errorf("setting %q needs whole numbers min <= default <= max (within 1,000,000)", s.Key)
		}
		seen[s.Key] = true
	}
	return nil
}

// SettingValues gives every declared setting its value: the stored one, clamped to the manifest's
// range (a newer version may have narrowed it), else the default. Unknown stored keys are dropped.
func (i *Info) SettingValues(stored map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(i.Settings))
	for _, s := range i.Settings {
		v, ok := stored[s.Key]
		if !ok {
			v = s.Default
		}
		out[s.Key] = min(s.Max, max(s.Min, v))
	}
	return out
}

// CheckSetting validates an administrator's new value for a declared setting.
func (i *Info) CheckSetting(key string, v float64) error {
	for _, s := range i.Settings {
		if s.Key == key {
			if !whole(v) || v < s.Min || v > s.Max {
				return fmt.Errorf("%s must be a whole number from %v to %v", s.Label, s.Min, s.Max)
			}
			return nil
		}
	}
	return fmt.Errorf("no setting %q", key)
}

// Info is one plugin folder. Err is set when it cannot run (broken). NameRefused marks a plugin
// refused for its name (the reserved prefix or a duplicate): it is listed but never resolved by
// name, so it can never stand in for the valid plugin it may share a name with.
type Info struct {
	Manifest
	Source      string // Bundled or Installed
	Dir         string
	Err         string
	NameRefused bool
	cache       *compiled // shared by copies of this Info
}

// Scan reads root/bundled and root/installed. Either may be missing or empty; with both missing
// (or root itself), plugins are off and Scan returns a nil catalog. A side that exists but cannot be
// read is skipped and reported in the error, the other side still loads. Broken plugins are listed
// with Err set, bundled before installed, each in name order.
func Scan(root string) ([]Info, error) {
	var out []Info
	var errs []error
	found := false
	for _, side := range []string{Bundled, Installed} {
		list, err := scanDir(filepath.Join(root, side), side)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			continue
		case err != nil:
			errs = append(errs, err)
			continue
		}
		found = true
		out = append(out, list...)
	}
	if !found {
		return nil, errors.Join(errs...)
	}
	if out == nil {
		out = []Info{}
	}
	return dedupe(out), errors.Join(errs...)
}

// FlatLayout reports whether root holds plugin folders directly, the layout before bundled/ and
// installed/: those are not read, and the operator should move them into installed/.
func FlatLayout(root string) bool {
	ents, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if e.IsDir() && e.Name() != Bundled && e.Name() != Installed {
			if _, err := os.Stat(filepath.Join(root, e.Name(), "plugin.json")); err == nil {
				return true
			}
		}
	}
	return false
}

// scanDir reads every subfolder of one side holding a plugin.json, in name order.
func scanDir(dir, source string) ([]Info, error) {
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
		out = append(out, load(pd, source))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// dedupe refuses every plugin of a name claimed twice on one side, so neither wins silently. The
// prefix rule keeps the two sides apart; a plugin already refused for its name does not count.
func dedupe(list []Info) []Info {
	seen := map[string]int{}
	for _, i := range list {
		if !i.NameRefused {
			seen[i.Source+"/"+i.Name]++
		}
	}
	for k := range list {
		i := &list[k]
		if !i.NameRefused && seen[i.Source+"/"+i.Name] > 1 {
			i.NameRefused = true
			i.Err = fmt.Sprintf("two %s plugins claim the same name %q: rename one of them", i.Source, i.Name)
		}
	}
	return list
}

// nameRule is the reserved-prefix rule for a name on one side, or "" when the name may be used.
func nameRule(name, source string) string {
	name = strings.ToLower(name)
	switch {
	case source == Bundled && (!strings.HasPrefix(name, reserved) || len(name) == len(reserved)):
		return fmt.Sprintf("a bundled plugin's name must start with %s: %q does not", reserved, name)
	case source == Installed && strings.HasPrefix(name, reserved):
		return fmt.Sprintf("the %s prefix is reserved for plugins bundled with Home Quarters: rename the installed plugin %q", reserved, name)
	}
	return ""
}

func load(dir, source string) Info {
	folder := filepath.Base(dir)
	i := Info{Dir: dir, Source: source, Manifest: Manifest{Name: folder}}
	fail := func(f string, a ...any) Info {
		i.Err = fmt.Sprintf(f, a...)
		if i.Title == "" {
			i.Title = i.Name // the admin dialog always has a name to show
		}
		return i
	}
	refuse := func(rule string) Info {
		i.NameRefused = true
		return fail("%s", rule)
	}
	// the folder and the manifest name are both checked: routes and assets are served under the
	// manifest's name, so a renamed folder must not get a reserved name past the rule
	if rule := nameRule(folder, source); rule != "" {
		return refuse(rule)
	}
	b, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return fail("plugin.json: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return fail("plugin.json: %v", err)
	}
	if rule := nameRule(m.Name, source); rule != "" {
		return refuse(rule)
	}
	if !nameRE.MatchString(m.Name) {
		return fail("name %q must match %s", m.Name, nameRE)
	}
	if m.Name != folder {
		return fail("name %q differs from its folder %q", m.Name, folder)
	}
	if n := len([]rune(m.Description)); n > maxDescription {
		return fail("description: %d characters, at most %d (put more in longDescription)", n, maxDescription)
	}
	if n := len([]rune(m.LongDescription)); n > maxLongDescription {
		return fail("longDescription: %d characters, at most %d", n, maxLongDescription)
	}
	if len(m.ExternalHosts) > maxExternalHosts {
		return fail("externalHosts: at most %d", maxExternalHosts)
	}
	for _, h := range m.ExternalHosts {
		if len(h) > 253 || !hostRE.MatchString(h) {
			return fail("externalHosts: %q must be a lower-case host name, like raw.githubusercontent.com", h)
		}
	}
	if err := checkSettings(m.Settings); err != nil {
		return fail("settings: %v", err)
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
	if err := checkObjects(dir, m); err != nil {
		return fail("%v", err)
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
