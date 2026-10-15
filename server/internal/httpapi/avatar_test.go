package httpapi

import "testing"

func TestNormalizeAvatarKeepsValidPetsAndDropsUnknownFields(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"sk":1,"hs":2,"hc":3,"sh":4,"pa":5,"pt":3}`, `{"sk":1,"hs":2,"hc":3,"sh":4,"pa":5,"pt":3}`},
		{`{"sk":1,"pt":99}`, `{"sk":1,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0}`},
		{`{"pt":-1,"evil":"<script>"}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0}`},
		{`not json`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0}`},
		{`{"pt":8}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":8}`},
		// beards, hats and the new hair styles; zero values stay off the wire
		{`{"hs":11,"hc":2,"bd":5,"ht":8,"hk":7}`, `{"sk":0,"hs":11,"hc":2,"sh":0,"pa":0,"pt":0,"bd":5,"ht":8,"hk":7}`},
		{`{"ht":9,"hk":3}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0,"ht":9,"hk":3}`},
		{`{"hs":12,"bd":6,"ht":10,"hk":8}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0}`},
		{`{"bd":-1,"ht":-1,"hk":-1}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0}`},
		{`{"ht":3}`, `{"sk":0,"hs":0,"hc":0,"sh":0,"pa":0,"pt":0,"ht":3}`},
		// the retired cap hairstyle becomes bald + a cap in the hair colour, which draws the same pixels
		{`{"hs":5,"hc":4}`, `{"sk":0,"hs":2,"hc":4,"sh":0,"pa":0,"pt":0,"ht":1,"hk":4}`},
		{`{"hs":5,"hc":4,"ht":6,"hk":1}`, `{"sk":0,"hs":2,"hc":4,"sh":0,"pa":0,"pt":0,"ht":6,"hk":1}`},
	}
	for _, c := range cases {
		if got := string(NormalizeAvatar([]byte(c.in))); got != c.want {
			t.Errorf("NormalizeAvatar(%s) = %s, want %s", c.in, got, c.want)
		}
	}
}
