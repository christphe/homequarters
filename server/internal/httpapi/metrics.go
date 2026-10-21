package httpapi

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"runtime"
	"strings"

	"homequarters/internal/media"
	"homequarters/internal/world"
)

// metricsAllowed applies the /metrics policy: a bearer token when one is configured; otherwise open in
// dev and disabled in production (a reverse proxy on the same host would make a loopback check meaningless).
func (s *Server) metricsAllowed(w http.ResponseWriter, r *http.Request) bool {
	tok := s.cfg.MetricsToken
	if tok == "" {
		if s.cfg.Dev() {
			return true
		}
		http.NotFound(w, r)
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(tok)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// metrics renders Prometheus text format without any dependency.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAllowed(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	g := func(name, help string, v any) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %v\n", name, help, name, name, v)
	}
	c := func(name, help string, v any) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %v\n", name, help, name, name, v)
	}
	s.mu.Lock()
	worlds := make([]*world.World, 0, len(s.worlds))
	for _, wd := range s.worlds {
		worlds = append(worlds, wd)
	}
	s.mu.Unlock()
	var players, connected, moving, groups, ticks, tickSum, framesOut, bytesOut, posSent, coalesced, skipped, kicked, plugDropped, inputs, inbox, joins, leaves int64
	var maxNs int64
	var buckets [10]int64
	for _, wd := range worlds {
		st := &wd.St
		players += st.Players.Load()
		connected += st.Connected.Load()
		moving += st.Moving.Load()
		groups += st.Groups.Load()
		ticks += st.Ticks.Load()
		tickSum += st.TickNsSum.Load()
		if m := st.TickNsMax.Load(); m > maxNs {
			maxNs = m
		}
		framesOut += st.FramesOut.Load()
		bytesOut += st.BytesOut.Load()
		posSent += st.PosSent.Load()
		coalesced += st.PosCoalesced.Load()
		skipped += st.Skipped.Load()
		kicked += st.Kicked.Load()
		plugDropped += st.PluginDropped.Load()
		inputs += st.InputMsgs.Load()
		inbox += st.InboxDepth.Load()
		joins += st.GroupJoins.Load()
		leaves += st.GroupLeaves.Load()
		for i := range buckets {
			buckets[i] += st.TickBuckets[i].Load()
		}
	}
	g("hq_players", "Players known to the world (connected or in reconnect grace)", players)
	g("hq_players_connected", "Players with a live WebSocket", connected)
	g("hq_players_moving", "Players currently moving", moving)
	g("hq_conversation_groups", "Active conversation groups", groups)
	g("hq_inbox_depth", "World inbox depth", inbox)
	c("hq_ws_frames_out_total", "WebSocket frames queued to clients", framesOut)
	c("hq_ws_bytes_out_total", "Payload bytes queued to clients", bytesOut)
	c("hq_positions_sent_total", "Entity position records sent", posSent)
	c("hq_positions_coalesced_total", "Stale positions overwritten for slow clients", coalesced)
	c("hq_flush_skipped_total", "Frame flushes skipped due to backpressure", skipped)
	c("hq_clients_kicked_total", "Clients dropped for overflowing reliable queue", kicked)
	c("hq_plugin_frames_dropped_total", "Plugin frames not delivered: recipient queue at least half full or world inbox full", plugDropped)
	c("hq_input_msgs_total", "Movement input messages processed", inputs)
	c("hq_group_joins_total", "Conversation joins", joins)
	c("hq_group_leaves_total", "Conversation leaves", leaves)
	c("hq_tick_seconds_sum", "Total tick processing time", float64(tickSum)/1e9)
	c("hq_tick_seconds_count", "Ticks executed", ticks)
	g("hq_tick_seconds_max", "Max tick processing time", float64(maxNs)/1e9)
	fmt.Fprintf(w, "# TYPE hq_tick_seconds histogram\n")
	var cum int64
	for i, le := range world.TickBucketLE {
		cum += buckets[i]
		if i == len(buckets)-1 {
			fmt.Fprintf(w, "hq_tick_seconds_bucket{le=\"+Inf\"} %d\n", cum)
		} else {
			fmt.Fprintf(w, "hq_tick_seconds_bucket{le=\"%g\"} %d\n", le, cum)
		}
	}
	if s.media != nil {
		c("hq_media_tokens_issued_total", "SFU join tokens issued", s.media.Issued.Load())
		c("hq_media_revocations_total", "SFU participants removed", s.media.Revoked.Load())
		c("hq_media_revoke_errors_total", "SFU revocations that failed", s.media.RevokeErrors.Load())
		c("hq_media_remote_mutes_total", "tracks muted on the SFU at another participant's request", s.media.Muted.Load())
		c("hq_media_remote_mute_errors_total", "remote mutes the SFU did not apply", s.media.MuteErrors.Load())
		c("hq_media_reconcile_removals_total", "SFU participants removed by reconciliation (not members of the room)", media.ReconcileRemovals.Load())
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	g("go_goroutines", "Goroutines", runtime.NumGoroutine())
	g("go_heap_alloc_bytes", "Heap bytes in use", ms.HeapAlloc)
	g("go_sys_bytes", "Bytes obtained from the OS", ms.Sys)
	c("go_gc_cycles_total", "GC cycles", ms.NumGC)
}
