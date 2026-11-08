package world

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// chatTexts lists the chat frames among frames, as "scope:text".
func chatTexts(frames []string) []string {
	var out []string
	for _, f := range frames {
		if !strings.HasPrefix(f, `{"t":"c"`) {
			continue
		}
		_, sc, _ := strings.Cut(f, `"sc":"`)
		sc, _, _ = strings.Cut(sc, `"`)
		_, x, _ := strings.Cut(f, `"x":"`)
		x, _, _ = strings.Cut(x, `","ts"`)
		out = append(out, sc+":"+x)
	}
	return out
}

func has(list []string, s string) bool {
	return slices.Contains(list, s)
}

// Office chat reaches everybody, trimmed and cut to 500 characters; a direct message reaches only its
// recipient and its sender; conversation chat goes nowhere outside a conversation and only to its
// members inside one; only office chat is kept for the history.
func TestChatScopesReachTheirAudienceTrimmedAndCut(t *testing.T) {
	h := newHarness(t)
	a := h.add(1, "member", sx, sy)
	b := h.add(2, "member", sx+32, sy)
	c := h.add(3, "member", sx-240, sy) // far from a and b: never in their conversation
	var saved []string
	h.w.OnChat = func(_ int64, _ uint32, text string, _ int64) { saved = append(saved, text) }
	chat := func(p *Player, sc string, to uint32, text string) {
		h.w.handle(ev{kind: evChat, p: p, gen: p.gen, s: sc, id: to, info: UserInfo{Name: text}}, h.now)
	}
	for _, p := range []*Player{a, b, c} {
		drain(p)
	}

	chat(a, "o", 0, "  hello office  ")
	chat(a, "o", 0, strings.Repeat("x", 900))
	long := "o:" + strings.Repeat("x", 500)
	for _, p := range []*Player{a, b, c} {
		got := chatTexts(drain(p))
		if !has(got, "o:hello office") || !has(got, long) || len(got) != 2 {
			t.Fatalf("office chat reaches everybody, trimmed and cut to 500 characters: player %d got %.80q", p.ID, got)
		}
	}

	chat(a, "d", b.ID, "secret between A and B")
	ga, gb, gc := chatTexts(drain(a)), chatTexts(drain(b)), chatTexts(drain(c))
	if !has(ga, "d:secret between A and B") || !has(gb, "d:secret between A and B") || len(gc) != 0 {
		t.Fatalf("a direct message reaches only its recipient and its sender: a=%q b=%q c=%q", ga, gb, gc)
	}

	chat(a, "g", 0, "nobody should receive this")
	for _, p := range []*Player{a, b, c} {
		if got := chatTexts(drain(p)); len(got) != 0 {
			t.Fatalf("conversation chat outside a conversation goes nowhere: player %d got %q", p.ID, got)
		}
	}

	h.consent(a, true)
	h.consent(b, true)
	h.consent(c, true)
	h.run(2 * time.Second)
	if a.group == nil || a.group != b.group || c.group != nil {
		t.Fatal("setup: a and b converse, c is alone")
	}
	for _, p := range []*Player{a, b, c} {
		drain(p)
	}
	chat(a, "g", 0, "only for people in the conversation")
	ga, gb, gc = chatTexts(drain(a)), chatTexts(drain(b)), chatTexts(drain(c))
	if !has(ga, "g:only for people in the conversation") || !has(gb, "g:only for people in the conversation") || len(gc) != 0 {
		t.Fatalf("conversation chat reaches the group's members only: a=%q b=%q c=%q", ga, gb, gc)
	}

	// the history (what a newcomer's hello carries, and what is persisted) holds office chat only
	if len(saved) != 2 || saved[0] != "hello office" || len(h.w.hist) != 2 {
		t.Fatalf("only office chat is kept: saved=%.40q hist=%d", saved, len(h.w.hist))
	}
	d := h.add(4, "member", sx, sy+200)
	hello := ""
	for _, f := range drain(d) {
		if strings.HasPrefix(f, `{"t":"hello"`) {
			hello = f
		}
	}
	if !strings.Contains(hello, `"n":"u","x":"hello office"`) || strings.Contains(hello, "secret") || strings.Contains(hello, "conversation") || strings.Contains(hello, "nobody") {
		_, chat, _ := strings.Cut(hello, `"chat"`)
		t.Fatalf("a newcomer gets the office chat, never direct or conversation messages: %.300s", chat)
	}
}
