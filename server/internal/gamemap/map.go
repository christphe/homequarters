// Package gamemap defines the office map format, validation and the compiled
// collision/area grids shared by the authoritative server. The client receives
// the same JSON and renders/predicts from it.
package gamemap

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	TilePx        = 16
	MaxW          = 200
	MaxH          = 200
	MaxProps      = 4000
	MaxAreas      = 128
	AccessOpen    = "open"
	AccessMembers = "members"
	AccessAdmins  = "admins"
	AccessList    = "list"
	// AccessOffice is a private office: open to anybody while Users is empty; once assigned, only its
	// owners (Users, at most MaxOfficeOwners), admins and visitors an owner lets in may enter.
	AccessOffice    = "office"
	MaxOfficeOwners = 4
	KindRoom        = "room"
)

type Access struct {
	Mode  string  `json:"mode"`
	Users []int64 `json:"users,omitempty"`
}

type Area struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // reception|desks|social|room|zone
	X        int    `json:"x"`
	Y        int    `json:"y"`
	W        int    `json:"w"`
	H        int    `json:"h"`
	Floor    string `json:"floor"`
	Access   Access `json:"access"`
	Capacity int    `json:"capacity,omitempty"`
	// Auto marks a desk room: derived by Compile from an assigned desk, never stored or edited.
	Auto bool `json:"auto,omitempty"`
}

// DeskRoomCapacity is how many people fit in the call of an assigned desk (the owner and visitors),
// and DeskRoomFloor the floor that shows the desk's space.
const (
	DeskRoomCapacity = 4
	DeskRoomFloor    = "desk_mat"
)

type Prop struct {
	T string `json:"t"`
	X int    `json:"x"`
	Y int    `json:"y"`
	W int    `json:"w,omitempty"`
	H int    `json:"h,omitempty"`
	// Assign is the desk's owner (user id). An assigned desk is shown under its owner's current name;
	// Label is its own name ("Desk 3"), shown again once it is free.
	Assign int64  `json:"assign,omitempty"`
	Label  string `json:"label,omitempty"`
	// Up turns a desk around: its seat is above it (back-to-back desks), so its desk room is the
	// desk and the two rows above.
	Up bool `json:"up,omitempty"`
	// Data is the content of an interactive object: note text, or the https URL of an embedded
	// site or image. It is NOT part of the wire map; the server sends it only to a player who is
	// next to the object and allowed in its area (see world.doUse).
	Data string `json:"data,omitempty"`
	// To is the destination tile of a portal.
	To *Point `json:"to,omitempty"`
	// DX, DY shift the drawing by a few pixels (a pc centred on a desk). Visual only: collisions,
	// reach and rooms stay on the prop's tiles.
	DX int `json:"dx,omitempty"`
	DY int `json:"dy,omitempty"`
}

// PropPC is a computer standing on a desk, drawn over it and facing the way the desk does.
const PropPC = "pc"

// MaxPropOffset bounds DX and DY, in pixels: less than a tile either way.
const MaxPropOffset = 15

// PCOn is the pc that sits centred on desk: on the desk tile under its centre, the half tile left
// over (an even width) as DX.
func PCOn(desk Prop) Prop {
	w, _ := desk.Size()
	pc := Prop{T: PropPC, X: desk.X + (w-1)/2, Y: desk.Y}
	if w%2 == 0 {
		pc.DX = TilePx / 2
	}
	return pc
}

// OnDesk reports whether tile (x, y) is part of a desk.
func OnDesk(m *Map, x, y int) bool {
	for _, p := range m.Props {
		if p.T != "desk" {
			continue
		}
		w, h := p.Size()
		if x >= p.X && x < p.X+w && y >= p.Y && y < p.Y+h {
			return true
		}
	}
	return false
}

// Interactive object kinds (press X next to them).
const (
	PropNote       = "note"       // text note
	PropEmbed      = "embed"      // embedded website (https only)
	PropImage      = "image"      // image shown from an https URL
	PropWhiteboard = "whiteboard" // shared drawing board
	PropPortal     = "portal"     // walking onto it teleports to Prop.To
	PropSpotlight  = "spotlight"  // standing on it broadcasts your audio/video to the office
)

const (
	MaxNoteRunes = 500
	MaxURLLen    = 300
)

// IsContent reports whether the prop kind carries hidden Data.
func (p Prop) IsContent() bool { return p.T == PropNote || p.T == PropEmbed || p.T == PropImage }

// Interactive reports whether pressing X next to the prop does something.
func (p Prop) Interactive() bool {
	if _, _, ok := p.PluginKind(); ok {
		return true
	}
	return p.IsContent() || p.T == PropWhiteboard
}

// pluginNameRE matches a plugin name and an object kind (same shape as the plugin catalog's names;
// gamemap does not import the plugin package).
var pluginNameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// MaxPluginPropSide is the largest footprint side of a plugin object, in tiles.
const MaxPluginPropSide = 4

// PluginKind splits a plugin object's type "<plugin>/<kind>". Whether the plugin is installed is
// not the map's business: the prop stays valid and simply does nothing without it.
func (p Prop) PluginKind() (plugin, kind string, ok bool) {
	plugin, kind, found := strings.Cut(p.T, "/")
	if !found || !pluginNameRE.MatchString(plugin) || !pluginNameRE.MatchString(kind) {
		return "", "", false
	}
	return plugin, kind, true
}

// ValidHTTPS accepts only absolute https URLs without credentials.
func ValidHTTPS(s string) bool {
	if len(s) == 0 || len(s) > MaxURLLen {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return false
	}
	for _, r := range s {
		if r < 0x21 || r == 0x7f { // no spaces or control characters
			return false
		}
	}
	return true
}

type Point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Map is the persisted/editable description of an office.
type Map struct {
	Version int      `json:"version"`
	W       int      `json:"w"`
	H       int      `json:"h"`
	Walls   []string `json:"walls"` // H rows of W chars; '#' = wall
	Props   []Prop   `json:"props"`
	Areas   []Area   `json:"areas"`
	Spawn   Point    `json:"spawn"`
}

// propDefaults: footprint and whether it blocks movement.
var propDefaults = map[string]struct {
	W, H  int
	Solid bool
}{
	"desk":           {2, 1, true},
	"chair":          {1, 1, false},
	"plant":          {1, 1, true},
	"couch":          {3, 1, false}, // a seat, like a chair: people sit on it
	"table":          {3, 2, true},
	"reception_desk": {6, 1, true},
	"bookshelf":      {2, 1, true},
	"coffee":         {1, 1, true},
	"whiteboard":     {3, 1, false},
	"rug":            {4, 3, false},
	"lamp":           {1, 1, true},
	"armchair":       {1, 1, false},
	"bleachers":      {4, 2, false},
	"court":          {6, 4, false},
	"stairs":         {2, 2, false},
	"banner":         {1, 1, false},
	"scoreboard":     {4, 1, false},
	PropNote:         {1, 1, true},
	PropEmbed:        {2, 1, true},
	PropImage:        {1, 1, true},
	PropPortal:       {1, 1, false},
	PropSpotlight:    {1, 1, false},
	PropPC:           {1, 1, false},
}

func (p Prop) Size() (int, int) {
	if _, _, ok := p.PluginKind(); ok {
		return p.W, p.H
	}
	d := propDefaults[p.T]
	w, h := p.W, p.H
	if w <= 0 {
		w = d.W
	}
	if h <= 0 {
		h = d.H
	}
	return w, h
}

// Compiled is the read-only runtime form used by the world simulation.
type Compiled struct {
	Map   *Map
	W, H  int
	Solid []bool // W*H, walls + solid props
	// Portals maps a tile (y*W+x) to the destination tile of the portal standing on it.
	Portals map[int]Point
	// Spotlights is the set of tiles (y*W+x) that carry a spotlight pad.
	Spotlights map[int]struct{}
	AreaAt     []int16 // W*H, index into Map.Areas or -1
	JSON       []byte  // wire form sent to clients (Map plus computed solid rows)
}

func (c *Compiled) IsSolidTile(tx, ty int) bool {
	if tx < 0 || ty < 0 || tx >= c.W || ty >= c.H {
		return true
	}
	return c.Solid[ty*c.W+tx]
}

func (c *Compiled) AreaIndexAt(tx, ty int) int {
	if tx < 0 || ty < 0 || tx >= c.W || ty >= c.H {
		return -1
	}
	return int(c.AreaAt[ty*c.W+tx])
}

// Validate checks limits and structure. It never trusts client-provided maps.
func Validate(m *Map) error {
	if m.W < 8 || m.H < 8 || m.W > MaxW || m.H > MaxH {
		return fmt.Errorf("invalid map size %dx%d", m.W, m.H)
	}
	if len(m.Walls) != m.H {
		return errors.New("walls: wrong row count")
	}
	for i, r := range m.Walls {
		if len(r) != m.W {
			return fmt.Errorf("walls: row %d has wrong length", i)
		}
		if strings.Trim(r, "#.") != "" {
			return fmt.Errorf("walls: row %d has invalid characters", i)
		}
	}
	if len(m.Props) > MaxProps {
		return errors.New("too many props")
	}
	for i, p := range m.Props {
		// only objects drawn as sprites can be shifted off their tiles; a pc is the only one so far
		if (p.DX != 0 || p.DY != 0) && p.T != PropPC {
			return fmt.Errorf("prop %d: only a pc takes an offset", i)
		}
		if p.DX < -MaxPropOffset || p.DX > MaxPropOffset || p.DY < -MaxPropOffset || p.DY > MaxPropOffset {
			return fmt.Errorf("prop %d: offset beyond %d px", i, MaxPropOffset)
		}
		if _, _, ok := p.PluginKind(); ok {
			if p.W < 1 || p.H < 1 || p.W > MaxPluginPropSide || p.H > MaxPluginPropSide {
				return fmt.Errorf("prop %d: a plugin object is 1 to %d tiles wide and high", i, MaxPluginPropSide)
			}
			if p.X < 0 || p.Y < 0 || p.X+p.W > m.W || p.Y+p.H > m.H {
				return fmt.Errorf("prop %d out of bounds", i)
			}
			if len(p.Label) > 40 {
				return fmt.Errorf("prop %d: label too long", i)
			}
			if p.Data != "" || p.To != nil {
				return fmt.Errorf("prop %d: %s takes no data", i, p.T)
			}
			continue
		}
		if _, ok := propDefaults[p.T]; !ok {
			return fmt.Errorf("prop %d: unknown type %q", i, p.T)
		}
		w, h := p.Size()
		if w > 32 || h > 32 || p.X < 0 || p.Y < 0 || p.X+w > m.W || p.Y+h > m.H {
			return fmt.Errorf("prop %d out of bounds", i)
		}
		if len(p.Label) > 40 {
			return fmt.Errorf("prop %d: label too long", i)
		}
		switch p.T {
		case PropNote:
			if p.To != nil {
				return fmt.Errorf("prop %d: only portals take a destination", i)
			}
			if len([]rune(p.Data)) > MaxNoteRunes {
				return fmt.Errorf("prop %d: note too long", i)
			}
		case PropEmbed, PropImage:
			if p.To != nil {
				return fmt.Errorf("prop %d: only portals take a destination", i)
			}
			if p.Data != "" && !ValidHTTPS(p.Data) {
				return fmt.Errorf("prop %d: %s needs an https:// URL of at most %d characters", i, p.T, MaxURLLen)
			}
		case PropPortal:
			if p.Data != "" {
				return fmt.Errorf("prop %d: portals take no content", i)
			}
			if p.To == nil || p.To.X < 0 || p.To.Y < 0 || p.To.X >= m.W || p.To.Y >= m.H {
				return fmt.Errorf("prop %d: portal needs a destination inside the map", i)
			}
		case PropPC:
			if p.Data != "" || p.To != nil || p.Assign != 0 || p.Label != "" || p.Up || p.W != 0 || p.H != 0 {
				return fmt.Errorf("prop %d: a pc takes only a place and an offset", i)
			}
			if !OnDesk(m, p.X, p.Y) {
				return fmt.Errorf("prop %d: a pc stands on a desk", i)
			}
		default:
			if p.Data != "" || p.To != nil {
				return fmt.Errorf("prop %d: %s takes no data", i, p.T)
			}
		}
	}
	if len(m.Areas) > MaxAreas {
		return errors.New("too many areas")
	}
	seen := map[string]bool{}
	for i, a := range m.Areas {
		if a.ID == "" || len(a.ID) > 32 || seen[a.ID] {
			return fmt.Errorf("area %d: invalid or duplicate id", i)
		}
		seen[a.ID] = true
		if len(a.Name) > 60 {
			return fmt.Errorf("area %d: name too long", i)
		}
		if a.W <= 0 || a.H <= 0 || a.X < 0 || a.Y < 0 || a.X+a.W > m.W || a.Y+a.H > m.H {
			return fmt.Errorf("area %d out of bounds", i)
		}
		switch a.Access.Mode {
		case "", AccessOpen, AccessMembers, AccessAdmins, AccessList, AccessOffice:
		default:
			return fmt.Errorf("area %d: invalid access mode", i)
		}
		if len(a.Access.Users) > 500 {
			return fmt.Errorf("area %d: access list too large", i)
		}
		if a.Access.Mode == AccessOffice && (len(a.Access.Users) > MaxOfficeOwners || a.Kind != KindRoom) {
			return fmt.Errorf("area %d: an office is a room with at most %d owners", i, MaxOfficeOwners)
		}
	}
	if m.Spawn.X < 0 || m.Spawn.Y < 0 || m.Spawn.X >= m.W || m.Spawn.Y >= m.H {
		return errors.New("spawn out of bounds")
	}
	return nil
}

// Compile validates and builds the runtime grids.
func Compile(m *Map) (*Compiled, error) {
	if err := Validate(m); err != nil {
		return nil, err
	}
	m.Areas = withDeskRooms(m)
	c := &Compiled{Map: m, W: m.W, H: m.H, Solid: make([]bool, m.W*m.H), AreaAt: make([]int16, m.W*m.H),
		Portals: map[int]Point{}, Spotlights: map[int]struct{}{}}
	for y, row := range m.Walls {
		for x := 0; x < m.W; x++ {
			if row[x] == '#' {
				c.Solid[y*m.W+x] = true
			}
		}
	}
	for _, p := range m.Props {
		switch p.T {
		case PropPortal:
			c.Portals[p.Y*m.W+p.X] = *p.To
		case PropSpotlight:
			c.Spotlights[p.Y*m.W+p.X] = struct{}{}
		}
		if !propDefaults[p.T].Solid {
			continue
		}
		w, h := p.Size()
		for y := p.Y; y < p.Y+h; y++ {
			for x := p.X; x < p.X+w; x++ {
				c.Solid[y*m.W+x] = true
			}
		}
	}
	for i := range c.AreaAt {
		c.AreaAt[i] = -1
	}
	// Non-room areas first so rooms take precedence where they overlap.
	for pass := 0; pass < 2; pass++ {
		for i, a := range m.Areas {
			if (a.Kind == KindRoom) != (pass == 1) {
				continue
			}
			for y := a.Y; y < a.Y+a.H; y++ {
				for x := a.X; x < a.X+a.W; x++ {
					c.AreaAt[y*m.W+x] = int16(i)
				}
			}
		}
	}
	if c.Solid[m.Spawn.Y*m.W+m.Spawn.X] {
		return nil, errors.New("spawn is inside a solid tile")
	}
	for at, to := range c.Portals {
		if c.Solid[to.Y*m.W+to.X] {
			return nil, fmt.Errorf("portal at %d,%d leads into a solid tile", at%m.W, at/m.W)
		}
	}
	c.JSON = encodeWire(c)
	return c, nil
}

func encodeWire(c *Compiled) []byte {
	rows := make([]string, c.H)
	for y := 0; y < c.H; y++ {
		b := make([]byte, c.W)
		for x := 0; x < c.W; x++ {
			if c.Solid[y*c.W+x] {
				b[x] = '1'
			} else {
				b[x] = '0'
			}
		}
		rows[y] = string(b)
	}
	return marshalWire(c.Map, rows)
}

// withDeskRooms returns m's areas without stale desk rooms, plus one room per assigned desk: the
// desk and the two rows in front of it (its chair and the tile behind; above it for an Up desk), as wide
// as the desk so the aisles stay open. Whoever sits there and whoever comes over share a call that the neighbouring
// desks do not hear. It is open to anybody; Access.Users names the owner, who alone (with admins)
// may lock it, always walks in, and answers knocks. A desk already inside a room (a private office) gets none: that room is its call.
func withDeskRooms(m *Map) []Area {
	areas := make([]Area, 0, len(m.Areas))
	ids := map[string]bool{}
	for _, a := range m.Areas {
		if !a.Auto {
			areas = append(areas, a)
			ids[a.ID] = true
		}
	}
	inRoom := func(x, y int) bool {
		for _, a := range areas {
			if a.Kind == KindRoom && !a.Auto && x >= a.X && y >= a.Y && x < a.X+a.W && y < a.Y+a.H {
				return true
			}
		}
		return false
	}
	placed := map[int64]bool{} // one place per person: an office owner, or the first desk, wins
	for _, a := range areas {
		if a.Kind == KindRoom && a.Access.Mode == AccessOffice {
			for _, u := range a.Access.Users {
				placed[u] = true
			}
		}
	}
	for _, p := range m.Props {
		if p.T != "desk" || p.Assign == 0 || len(areas) >= MaxAreas || placed[p.Assign] {
			continue
		}
		placed[p.Assign] = true
		w, h := p.Size()
		if inRoom(p.X, p.Y) {
			continue
		}
		id := "desk-" + strconv.Itoa(p.X) + "-" + strconv.Itoa(p.Y)
		if ids[id] {
			continue
		}
		ids[id] = true
		x0, y0 := p.X, p.Y
		x1, y1 := p.X+w, min(p.Y+h+2, m.H)
		if p.Up {
			y0, y1 = max(p.Y-2, 0), p.Y+h
		}
		areas = append(areas, Area{ID: id, Name: "Desk", Kind: KindRoom, X: x0, Y: y0, W: x1 - x0, H: y1 - y0,
			Floor: DeskRoomFloor, Access: Access{Mode: AccessOpen, Users: []int64{p.Assign}}, Capacity: DeskRoomCapacity, Auto: true})
	}
	return areas
}

// OnePlacePerPerson checks that nobody is given two places: at most one assigned desk or one private
// office (as one of its owners) per person. Maps sent by an editor must pass it; maps already stored
// are loaded anyway (withDeskRooms then gives a room to the first place only).
func OnePlacePerPerson(m *Map) error {
	seen := map[int64]string{}
	take := func(uid int64, place string) error {
		if prev, dup := seen[uid]; dup {
			return fmt.Errorf("user %d already has %s; one desk or office per person", uid, prev)
		}
		seen[uid] = place
		return nil
	}
	for _, a := range m.Areas {
		if a.Kind == KindRoom && a.Access.Mode == AccessOffice && !a.Auto {
			for _, u := range a.Access.Users {
				if err := take(u, "office "+a.ID); err != nil {
					return err
				}
			}
		}
	}
	for _, p := range m.Props {
		if p.T == "desk" && p.Assign != 0 {
			if err := take(p.Assign, "a desk at "+strconv.Itoa(p.X)+","+strconv.Itoa(p.Y)); err != nil {
				return err
			}
		}
	}
	return nil
}

// OwnerSep joins an office's own name and its owners' names when it is shown ("Office 2 · Ana").
const OwnerSep = " · "

// Unname drops the owner names that older versions wrote into a stored map: an assigned desk's label
// that names its owner ("Ana's desk") and the suffix of an owned office's name ("Office 2 · Ana"). A place stores only
// its owners' ids; their names are joined when it is shown, so a rename shows at once and a stored map
// never keeps a stale name. It runs once, when an office's map is loaded, so a name an administrator
// gives a room later is kept as typed. It reports whether anything changed.
func Unname(m *Map) bool {
	changed := false
	for i := range m.Props {
		if p := &m.Props[i]; p.T == "desk" && p.Assign != 0 && strings.HasSuffix(p.Label, "'s desk") {
			p.Label = ""
			changed = true
		}
	}
	for i := range m.Areas {
		if a := &m.Areas[i]; a.Access.Mode == AccessOffice && len(a.Access.Users) > 0 {
			if base, _, cut := strings.Cut(a.Name, OwnerSep); cut {
				a.Name = base
				changed = true
			}
		}
	}
	return changed
}

// Owners lists, once each, the members that places of m belong to: desk owners and the owners of
// private offices.
func Owners(m *Map) []int64 {
	seen := map[int64]bool{}
	var out []int64
	add := func(u int64) {
		if u != 0 && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	for _, a := range m.Areas {
		if a.Access.Mode == AccessOffice && !a.Auto {
			for _, u := range a.Access.Users {
				add(u)
			}
		}
	}
	for _, p := range m.Props {
		if p.T == "desk" {
			add(p.Assign)
		}
	}
	return out
}

// KeepOwners frees every desk and office seat whose owner keep refuses (a member who was removed),
// and reports whether anything changed. Props and Areas are copied before they change, so a map
// that shares them with a running world is left alone.
func KeepOwners(m *Map, keep func(uid int64) bool) bool {
	changed := false
	for i, p := range m.Props {
		if p.T == "desk" && p.Assign != 0 && !keep(p.Assign) {
			if !changed {
				m.Props = append([]Prop(nil), m.Props...)
				m.Areas = append([]Area(nil), m.Areas...)
				changed = true
			}
			m.Props[i].Assign = 0
		}
	}
	for i, a := range m.Areas {
		if a.Access.Mode != AccessOffice || a.Auto {
			continue
		}
		users := make([]int64, 0, len(a.Access.Users))
		for _, u := range a.Access.Users {
			if keep(u) {
				users = append(users, u)
			}
		}
		if len(users) == len(a.Access.Users) {
			continue
		}
		if !changed {
			m.Props = append([]Prop(nil), m.Props...)
			m.Areas = append([]Area(nil), m.Areas...)
			changed = true
		}
		if len(users) == 0 {
			users = nil
		}
		m.Areas[i].Access = Access{Mode: AccessOffice, Users: users}
	}
	return changed
}
