package gamemap

import "testing"

// Every private office of the starter map must be reachable on foot from the spawn point.
func TestEveryStarterOfficeIsReachable(t *testing.T) {
	cm, err := Compile(Default())
	if err != nil {
		t.Fatal(err)
	}
	m := cm.Map
	seen := make([]bool, m.W*m.H)
	q := [][2]int{{m.Spawn.X, m.Spawn.Y}}
	seen[m.Spawn.Y*m.W+m.Spawn.X] = true
	for len(q) > 0 {
		c := q[0]
		q = q[1:]
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			x, y := c[0]+d[0], c[1]+d[1]
			if x < 0 || y < 0 || x >= m.W || y >= m.H || seen[y*m.W+x] || m.Walls[y][x] == '#' {
				continue
			}
			seen[y*m.W+x] = true
			q = append(q, [2]int{x, y})
		}
	}
	offices := 0
	for _, a := range m.Areas {
		if a.Access.Mode != AccessOffice {
			continue
		}
		offices++
		ok := false
		for y := a.Y; y < a.Y+a.H && !ok; y++ {
			for x := a.X; x < a.X+a.W && !ok; x++ {
				ok = seen[y*m.W+x]
			}
		}
		if !ok {
			t.Errorf("%s cannot be reached from the spawn point", a.ID)
		}
	}
	if offices != 6 {
		t.Fatalf("expected six offices, got %d", offices)
	}
}

func TestAssignedDesksGetTheirOwnRoom(t *testing.T) {
	m := Default()
	at := func(t, x, y int) *Prop {
		for i := range m.Props {
			if m.Props[i].T == "desk" && m.Props[i].X == x && m.Props[i].Y == y {
				return &m.Props[i]
			}
		}
		return nil
	}
	at(0, 20, 3).Assign, at(0, 20, 3).Label = 7, "Desk of Ana"
	at(0, 24, 3).Assign = 8
	at(0, 26, 41).Assign = 9 // the desk of Office 3: its office is already its room
	c, err := Compile(m)
	if err != nil {
		t.Fatal(err)
	}
	var auto []Area
	for _, a := range c.Map.Areas {
		if a.Auto {
			auto = append(auto, a)
		}
	}
	if len(auto) != 2 {
		t.Fatalf("one room per assigned desk outside a room, got %+v", auto)
	}
	if a := auto[0]; a.Name != "Desk of Ana" || a.X != 20 || a.Y != 3 || a.W != 2 || a.H != 3 || a.Kind != KindRoom || a.Access.Mode != AccessOpen || a.Floor != DeskRoomFloor {
		t.Fatalf("desk room: %+v", a)
	}
	room := func(x, y int) string {
		if i := c.AreaIndexAt(x, y); i >= 0 {
			return c.Map.Areas[i].ID
		}
		return ""
	}
	if room(20, 4) != "desk-20-3" || room(21, 5) != "desk-20-3" || room(24, 4) != "desk-24-3" || room(22, 4) != "desks" || room(20, 6) != "desks" || room(28, 4) != "desks" {
		t.Fatalf("chairs sit in their own desk rooms; aisles and unassigned desks do not: %q %q %q %q %q %q", room(20, 4), room(21, 5), room(24, 4), room(22, 4), room(20, 6), room(28, 4))
	}
	// a stored map carrying a stale desk room (desk since unassigned) gets it dropped
	at(0, 24, 3).Assign = 0
	c, err = Compile(c.Map)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, a := range c.Map.Areas {
		if a.Auto {
			n++
		}
	}
	if n != 1 || room(24, 4) != "desks" {
		t.Fatalf("unassigning a desk removes its room: %d rooms", n)
	}
}

func TestOnePlacePerPerson(t *testing.T) {
	m := Default()
	desk := func(x, y int) *Prop {
		for i := range m.Props {
			if m.Props[i].T == "desk" && m.Props[i].X == x && m.Props[i].Y == y {
				return &m.Props[i]
			}
		}
		return nil
	}
	desk(20, 3).Assign = 7
	if err := OnePlacePerPerson(m); err != nil {
		t.Fatalf("one desk is fine: %v", err)
	}
	desk(24, 3).Assign = 7
	if OnePlacePerPerson(m) == nil {
		t.Fatal("two desks for one person are refused")
	}
	desk(24, 3).Assign = 0
	for i := range m.Areas {
		if m.Areas[i].ID == "office-1" {
			m.Areas[i].Access = Access{Mode: AccessOffice, Users: []int64{7}}
		}
	}
	if OnePlacePerPerson(m) == nil {
		t.Fatal("a desk and an office for one person are refused")
	}
	// a map stored before the rule still loads: the office wins, the desk gets no room
	c, err := Compile(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range c.Map.Areas {
		if a.Auto {
			t.Fatalf("an office owner's extra desk gets no room: %+v", a)
		}
	}
}
