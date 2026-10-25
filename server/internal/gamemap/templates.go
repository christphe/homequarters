package gamemap

import (
	"sort"
	"strings"
)

// Template is a starter layout an administrator can give the office. Applying one replaces the whole
// map; only desk assignments carry over (CarryDesks).
type Template struct {
	ID    string
	Name  string
	Build func() *Map
}

// Templates are named after kinds of homes, from the smallest. All layout data is original to this project.
var Templates = []Template{
	{ID: "loft", Name: "Loft", Build: Default},
	{ID: "lodge", Name: "Lodge", Build: Lodge},
	{ID: "manor", Name: "Manor", Build: Manor},
}

// withPCs puts a pc centred on every desk, after the other props.
func withPCs(props []Prop) []Prop {
	for _, p := range props {
		if p.T == "desk" {
			props = append(props, PCOn(p))
		}
	}
	return props
}

// TemplateByID finds a template.
func TemplateByID(id string) (Template, bool) {
	for _, t := range Templates {
		if t.ID == id {
			return t, true
		}
	}
	return Template{}, false
}

// CornerPrefix starts the id of a conversation corner: an open room without walls (sofas, a duo table).
const CornerPrefix = "corner-"

// Summary counts what a map offers, for the template list.
type Summary struct {
	Desks   int `json:"desks"`
	Rooms   int `json:"rooms"`
	Corners int `json:"corners"`
	Offices int `json:"offices"`
}

// Summarize counts desks, rooms (with walls or not, but not desk rooms), conversation corners and
// private offices.
func Summarize(m *Map) Summary {
	var s Summary
	for _, p := range m.Props {
		if p.T == "desk" {
			s.Desks++
		}
	}
	for _, a := range m.Areas {
		switch {
		case a.Kind != KindRoom || a.Auto:
		case a.Access.Mode == AccessOffice:
			s.Offices++
		case strings.HasPrefix(a.ID, CornerPrefix):
			s.Corners++
		default:
			s.Rooms++
		}
	}
	return s
}

// Carry reports what CarryDesks did: how many people kept a desk and how many lost theirs.
type Carry struct {
	Kept int `json:"kept"`
	Lost int `json:"lost"`
}

// CarryDesks gives the people placed in old (desk owners, then private-office owners) desks of next, a
// fresh template map. The owner of old's k-th desk (in map order) takes next's k-th desk; office owners,
// and owners whose number next does not have, then take the free desks in order. When desks run out, the
// highest numbers lose theirs. Desks inside a room of next (a private office's desk) are not given.
func CarryDesks(old, next *Map) Carry {
	var people []int64 // in number order: desks first, then offices
	seen := map[int64]bool{}
	add := func(u int64) {
		if u != 0 && !seen[u] {
			seen[u] = true
			people = append(people, u)
		}
	}
	var wanted []int // per person, the desk number they had (or -1)
	for _, p := range old.Props {
		if p.T == "desk" {
			if p.Assign != 0 && !seen[p.Assign] {
				wanted = append(wanted, deskIndex(old, p))
			}
			add(p.Assign)
		}
	}
	for _, a := range old.Areas {
		if a.Kind == KindRoom && a.Access.Mode == AccessOffice && !a.Auto {
			for _, u := range a.Access.Users {
				if !seen[u] {
					wanted = append(wanted, -1)
				}
				add(u)
			}
		}
	}
	var free []int // indexes into next.Props of the desks people may take, in desk order
	for i, p := range next.Props {
		if p.T == "desk" && !inWalledRoom(next, p.X, p.Y) {
			free = append(free, i)
		}
	}
	taken := make([]bool, len(free))
	got := make([]bool, len(people))
	for k, want := range wanted {
		if want >= 0 && want < len(free) {
			next.Props[free[want]].Assign = people[k]
			taken[want] = true
			got[k] = true
		}
	}
	j := 0
	for k := range people {
		if got[k] {
			continue
		}
		for j < len(free) && taken[j] {
			j++
		}
		if j == len(free) {
			break
		}
		next.Props[free[j]].Assign = people[k]
		taken[j] = true
		got[k] = true
	}
	var c Carry
	for _, g := range got {
		if g {
			c.Kept++
		} else {
			c.Lost++
		}
	}
	return c
}

// deskIndex is the number (from 0) of desk p among old's desks that are not inside a room.
func deskIndex(m *Map, p Prop) int {
	n := 0
	for _, q := range m.Props {
		if q.T != "desk" || inWalledRoom(m, q.X, q.Y) {
			continue
		}
		if q.X == p.X && q.Y == p.Y {
			return n
		}
		n++
	}
	return -1
}

// inWalledRoom reports whether a tile lies in a room drawn by the map's author (not a desk room).
func inWalledRoom(m *Map, x, y int) bool {
	for _, a := range m.Areas {
		if a.Kind == KindRoom && !a.Auto && !strings.HasPrefix(a.ID, CornerPrefix) && x >= a.X && y >= a.Y && x < a.X+a.W && y < a.Y+a.H {
			return true
		}
	}
	return false
}

// Manor is the large wide-office template (85x51): 48 desks in 8 islands, 3 meeting rooms, 7 mini rooms,
// a break room with 12 conversation corners, a welcome area, an arena and a walled-up extension.
func Manor() *Map {
	return wideOffice(wideLayout{islandsPerRow: 4, cornersPerSide: 3, welcomeW: 7, minis: 7, miniW: 8})
}

// Lodge is Manor with one island column less (77x51): 36 desks, 5 wider mini rooms, 8 corners.
func Lodge() *Map {
	return wideOffice(wideLayout{islandsPerRow: 3, cornersPerSide: 2, welcomeW: 8, minis: 5, miniW: 10})
}

type wideLayout struct {
	islandsPerRow  int // islands of 6 desks, two rows of them
	cornersPerSide int // couch and duo corners on each side of the break room's door to the open space
	welcomeW       int // inner width of the welcome area (the break room is what is left, even width)
	minis          int // mini meeting rooms along the bottom hall
	miniW          int // their inner width; the row of minis spans the hall exactly
}

// wideOffice draws Manor and Lodge. Columns, left to right: arena over the walled-up extension, a 2-tile
// corridor, the centre (welcome and break room over the open space), a 2-tile corridor, the meeting
// rooms. A hall runs under it all, with the mini rooms below. Every wall is one tile and every door two.
func wideOffice(l wideLayout) *Map {
	const H = 51
	islandsW := 12*l.islandsPerRow - 3 // 9-wide islands, 3 tiles apart
	cw := islandsW + 2                 // centre inner width: Manor 47
	if l.islandsPerRow == 3 {
		cw = islandsW + 6 // Lodge 39: 3 tiles to each side wall
	}
	const cx0 = 23
	cx1 := cx0 + cw - 1 // last centre column
	rc := cx1 + 2       // right corridor (2 wide)
	mx0 := rc + 3       // meeting rooms, 10 wide
	W := mx0 + 11       // outer wall included
	hallX1 := mx0 + 9   // the hall ends under the meeting rooms
	g := make([][]byte, H)
	for y := range g {
		g[y] = []byte(strings.Repeat("#", W))
	}
	carve := func(x0, y0, w, h int) {
		for y := y0; y < y0+h; y++ {
			for x := x0; x < x0+w; x++ {
				g[y][x] = '.'
			}
		}
	}
	bx0 := cx0 + l.welcomeW + 1 // break room
	bw := cx1 - bx0 + 1
	carve(1, 1, 18, 16)           // arena (the extension below it stays walled up)
	carve(20, 1, 2, 40)           // left corridor
	carve(rc, 1, 2, 40)           // right corridor
	carve(20, 39, hallX1-19, 2)   // hall
	carve(cx0, 1, l.welcomeW, 13) // welcome
	carve(bx0, 1, bw, 13)         // break room
	carve(cx0, 15, cw, 23)        // open space
	carve(mx0, 1, 10, 9)          // meeting rooms
	carve(mx0, 11, 10, 13)
	carve(mx0, 25, 10, 13)
	miniX := func(i int) int { return 21 + i*(l.miniW+1) }
	for i := 0; i < l.minis; i++ {
		carve(miniX(i), 42, l.miniW, 8)
	}
	// doors
	carve(19, 8, 1, 2)             // arena - left corridor
	carve(22, 5, 1, 2)             // left corridor - welcome
	carve(cx0+l.welcomeW, 5, 1, 2) // welcome - break room
	carve(26, 14, 2, 1)            // welcome - open space
	carve(cx1+1, 5, 1, 2)          // break room - right corridor
	breakDoor := bx0 + bw/2 - 1
	carve(breakDoor, 14, 2, 1) // break room - open space
	carve(22, 25, 1, 2)        // open space - corridors
	carve(cx1+1, 25, 1, 2)
	carve(cx0+cw/2-1, 38, 2, 1)          // open space - hall
	for _, y := range []int{4, 16, 30} { // meeting rooms - right corridor
		carve(rc+2, y, 1, 2)
	}
	for i := 0; i < l.minis; i++ {
		carve(miniX(i)+l.miniW/2-1, 41, 2, 1)
	}
	walls := make([]string, H)
	for i := range g {
		walls[i] = string(g[i])
	}

	var props []Prop
	add := func(t string, x, y, w, h int) { props = append(props, Prop{T: t, X: x, Y: y, W: w, H: h}) }
	var areas []Area
	area := func(id, name, kind string, x, y, w, h int, floor string) *Area {
		areas = append(areas, Area{ID: id, Name: name, Kind: kind, X: x, Y: y, W: w, H: h, Floor: floor})
		return &areas[len(areas)-1]
	}
	room := func(id, name string, x, y, w, h int, floor string, capacity int) {
		a := area(id, name, KindRoom, x, y, w, h, floor)
		a.Access = Access{Mode: AccessOpen}
		a.Capacity = capacity
	}

	// Arena: a field in the middle, rows of seats on four sides (people may sit in them), stairs through
	// the seats above and below it, banners and a scoreboard on the wall.
	add("court", 5, 5, 10, 8)
	for _, y := range []int{2, 14} {
		add("bleachers", 4, y, 5, 2)
		add("stairs", 9, y, 2, 2)
		add("bleachers", 11, y, 5, 2)
	}
	for _, x := range []int{2, 16} { // the side stands, stairs in their middle too
		add("bleachers", x, 5, 2, 3)
		add("stairs", x, 8, 2, 2)
		add("bleachers", x, 10, 2, 3)
	}
	add("banner", 5, 0, 0, 0)
	add("scoreboard", 8, 0, 4, 1)
	add("banner", 14, 0, 0, 0)
	add("plant", 1, 1, 0, 0)
	add("plant", 18, 1, 0, 0)
	area("arena", "Arena", "social", 1, 1, 18, 16, "wood_light")

	area("welcome", "Welcome", "reception", cx0, 1, l.welcomeW, 13, "wood_light")
	add("plant", cx0, 1, 0, 0)
	add("plant", cx0+l.welcomeW-1, 1, 0, 0)

	// Break room, mirrored around its door to the open space: duo corners (armchair, small table,
	// armchair, with room around for people watching) along the top, couch corners one row lower than
	// the bottom wall (four couches around a table), a free aisle between them from door to door.
	area("break", "Break room", "social", bx0, 1, bw, 13, "wood_warm")
	for side := 0; side < 2; side++ {
		for j := 0; j < l.cornersPerSide; j++ {
			x := breakDoor - 5 - 6*j  // couch corner, 4 wide
			duo := x                  // duo corner, 3 wide, on the outer edge
			n := l.cornersPerSide - j // numbered from left to right
			if side == 1 {
				x = breakDoor + 3 + 6*j
				duo = x + 1
				n = l.cornersPerSide + j + 1
			}
			add("rug", duo, 2, 3, 3)
			add("armchair", duo, 3, 0, 0)
			add("table", duo+1, 3, 1, 1)
			add("armchair", duo+2, 3, 0, 0)
			room(CornerPrefix+"duo-"+itoa(n), "Duo corner "+itoa(n), duo, 2, 3, 3, "wood_warm", 6)
			add("rug", x, 8, 4, 4)
			add("couch", x+1, 8, 2, 1) // a couch on each side of a 2x2 table, the side ones upright
			add("couch", x, 9, 1, 2)
			add("table", x+1, 9, 2, 2)
			add("couch", x+3, 9, 1, 2)
			add("couch", x+1, 11, 2, 1)
			room(CornerPrefix+"couch-"+itoa(n), "Couch corner "+itoa(n), x, 8, 4, 4, "wood_warm", 8)
		}
	}

	// Open space: two rows of islands; an island is 3x2 zones of 3x3, back to back around their desks.
	area("open", "Open space", "desks", cx0, 15, cw, 23, "carpet_blue")
	ix0 := cx0 + (cw-islandsW)/2
	desk := 1
	for _, y := range []int{18, 29} {
		for i := 0; i < l.islandsPerRow; i++ {
			x := ix0 + 12*i
			for row := 0; row < 2; row++ {
				for c := 0; c < 3; c++ {
					zx := x + 3*c
					if row == 0 {
						props = append(props, Prop{T: "desk", X: zx, Y: y + 2, W: 3, H: 1, Label: "Desk " + itoa(desk), Up: true})
						add("chair", zx+1, y+1, 0, 0)
					} else {
						props = append(props, Prop{T: "desk", X: zx, Y: y + 3, W: 3, H: 1, Label: "Desk " + itoa(desk)})
						add("chair", zx+1, y+4, 0, 0)
					}
					desk++
				}
			}
		}
	}

	area("corridor-left", "Corridor", "social", 20, 1, 2, 38, "wood_light")
	area("corridor-right", "Corridor", "social", rc, 1, 2, 38, "wood_light")
	area("hall", "Hall", "social", 20, 39, hallX1-19, 2, "wood_light")

	// Meeting rooms: a 6x2 table with two free tiles to the side walls, six chairs on each long side.
	for i, r := range []struct {
		y, h  int
		floor string
	}{{1, 9, "carpet_teal"}, {11, 13, "carpet_plum"}, {25, 13, "carpet_green"}} {
		ty := r.y + r.h/2 - 1
		add("table", mx0+2, ty, 6, 2)
		for k := 0; k < 6; k++ {
			add("chair", mx0+2+k, ty-1, 0, 0)
			add("chair", mx0+2+k, ty+2, 0, 0)
		}
		room("meeting-"+itoa(i+1), "Meeting room "+itoa(i+1), mx0, r.y, 10, r.h, r.floor, 12)
	}

	// Mini rooms: a 4x2 table in the middle, four chairs on each long side.
	floors := []string{"carpet_blue", "carpet_teal", "carpet_plum", "carpet_green"}
	for i := 0; i < l.minis; i++ {
		x := miniX(i)
		tx := x + (l.miniW-4)/2
		add("table", tx, 45, 4, 2)
		for k := 0; k < 4; k++ {
			add("chair", tx+k, 44, 0, 0)
			add("chair", tx+k, 47, 0, 0)
		}
		room("mini-"+itoa(i+1), "Mini room "+itoa(i+1), x, 42, l.miniW, 8, floors[i%len(floors)], 8)
	}

	sort.SliceStable(props, func(i, j int) bool { return props[i].T == "rug" && props[j].T != "rug" })
	return &Map{Version: 1, W: W, H: H, Walls: walls, Props: withPCs(props), Areas: areas, Spawn: Point{X: cx0 + (l.welcomeW-1)/2, Y: 7}}
}
