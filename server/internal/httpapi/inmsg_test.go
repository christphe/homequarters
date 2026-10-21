package httpapi

import (
	"encoding/json"
	"testing"
)

// Every inbound frame is decoded into inMsg first; a field shared by two messages with different types
// (the whiteboard's numeric "k", the mute's string "k") must not make the other one invalid.
func TestInMsgDecodesEveryFrameShape(t *testing.T) {
	frames := []string{
		`{"t":"wb","op":"draw","bk":"49,15","i":1,"k":0,"c":0,"w":0,"p":[1,1]}`,
		`{"t":"wb","op":"draw","bk":"49,15","i":2,"k":1,"c":0,"w":0,"p":[1,1],"tx":"hi"}`,
		`{"t":"mute","id":7,"k":"cam"}`,
		`{"t":"in","s":3,"x":1,"y":0}`,
	}
	for _, f := range frames {
		var m inMsg
		if err := json.Unmarshal([]byte(f), &m); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
	}
	var m inMsg
	json.Unmarshal([]byte(`{"t":"mute","id":7,"k":"cam"}`), &m)
	if muteKind(m.K) != "cam" || m.ID != 7 {
		t.Fatalf("mute frame: %+v", m)
	}
	for _, bad := range []string{`{"t":"mute","id":7,"k":1}`, `{"t":"mute","id":7,"k":"all"}`, `{"t":"mute","id":7}`, `{"t":"mute","id":7,"k":["mic"]}`} {
		var m inMsg
		json.Unmarshal([]byte(bad), &m)
		if muteKind(m.K) != "" {
			t.Fatalf("%s must not name a kind", bad)
		}
	}
}
