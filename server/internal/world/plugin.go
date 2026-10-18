package world

// Plugins (internal/plugin) see presence through OnPresence and reach browsers through PluginFrame.
// Their frames are never allowed to cost a player the connection: a frame is queued only while the
// recipient's queue is under half full, else dropped and counted.

// PluginFrame queues a ready-made {"t":"plg",...} frame for member to, or every member when to is 0.
// It never blocks: false means the world's inbox is full and the frame was dropped.
func (w *World) PluginFrame(to uint32, frame []byte) bool {
	select {
	case w.inbox <- ev{kind: evPlugin, id: to, data: frame}:
		return true
	default:
		w.St.PluginDropped.Add(1)
		return false
	}
}

func (w *World) deliverPlugin(to uint32, frame []byte) {
	if to != 0 {
		if p := w.players[to]; p != nil {
			w.deliverPluginTo(p, frame)
		}
		return
	}
	for _, p := range w.list {
		w.deliverPluginTo(p, frame)
	}
}

func (w *World) deliverPluginTo(p *Player, frame []byte) {
	if p.out == nil || p.Status == StatusInvisible {
		return
	}
	if len(p.out) >= cap(p.out)/2 {
		w.St.PluginDropped.Add(1)
		return
	}
	w.sendShared(p, frame) // cannot overflow: at least half the queue is free
}

func (w *World) presence(p *Player, online bool) {
	if w.OnPresence != nil {
		w.OnPresence(w.OfficeID, p.ID, p.Name, p.Role, online)
	}
}
