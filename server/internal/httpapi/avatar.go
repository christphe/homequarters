package httpapi

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Avatar options are small integer indexes into palettes/styles defined by the client
// (web/src/game/art/characters.ts and web/src/game/palette.ts). Colours may also be any "#rrggbb".
const (
	nSkin      = 12
	nHair      = 12 // styles; 5 is the retired cap, see legacyCapStyle
	nHairColor = 16
	nCloth     = 24 // shirt, trousers and hat colours
	nPet       = 9  // 0 = no pet, then cat, dog, bunny, fox, chick, slime, owl, axolotl
	nBeard     = 6  // 0 = none, stubble, moustache, goatee, full, long
	nHat       = 10 // 0 = none, cap, beanie, headphones, bowler, top hat, beret, tricorne, clown, hijab

	legacyCapStyle = 5 // the old "cap" hairstyle, now bald + a cap hat
	baldStyle      = 2
	capHat         = 1
)

// color is a palette index or a "#rrggbb" colour (stored lower case).
type color struct {
	idx int
	hex string
}

// UnmarshalJSON never fails: anything but an integer or a well-formed "#rrggbb" becomes index 0.
func (c *color) UnmarshalJSON(b []byte) error {
	*c = color{}
	var n int
	if json.Unmarshal(b, &n) == nil {
		c.idx = n
		return nil
	}
	var s string
	if json.Unmarshal(b, &s) == nil && isHex(s) {
		c.hex = strings.ToLower(s)
	}
	return nil
}

func (c color) MarshalJSON() ([]byte, error) {
	if c.hex != "" {
		return json.Marshal(c.hex)
	}
	return strconv.AppendInt(nil, int64(c.idx), 10), nil
}

func (c color) clamp(n int) color {
	if c.hex != "" {
		return c
	}
	return color{idx: clamp(c.idx, n)}
}

func (c color) zero() bool { return c.hex == "" && c.idx == 0 }

func isHex(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, r := range s[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return false
		}
	}
	return true
}

type avatar struct {
	Skin      color  `json:"sk"`
	Hair      int    `json:"hs"`
	HairColor color  `json:"hc"`
	Shirt     color  `json:"sh"`
	Pants     color  `json:"pa"`
	Pet       int    `json:"pt"`
	Beard     int    `json:"bd,omitempty"`
	Hat       int    `json:"ht,omitempty"`
	HatColor  *color `json:"hk,omitempty"`
}

func clamp(v, n int) int {
	if v < 0 || v >= n {
		return 0
	}
	return v
}

// NormalizeAvatar never trusts client JSON: it re-serialises a validated struct.
func NormalizeAvatar(raw json.RawMessage) json.RawMessage {
	var in avatar
	_ = json.Unmarshal(raw, &in) // a field of the wrong type stays zero; the others are kept
	a := avatar{Skin: in.Skin.clamp(nSkin), Hair: clamp(in.Hair, nHair), HairColor: in.HairColor.clamp(nHairColor),
		Shirt: in.Shirt.clamp(nCloth), Pants: in.Pants.clamp(nCloth), Pet: clamp(in.Pet, nPet),
		Beard: clamp(in.Beard, nBeard), Hat: clamp(in.Hat, nHat)}
	if in.HatColor != nil {
		hk := in.HatColor.clamp(nCloth)
		a.HatColor = &hk
	}
	if a.Hair == legacyCapStyle {
		// same pixels as before: the cap was drawn in the hair colour over a bald head
		a.Hair = baldStyle
		if a.Hat == 0 {
			hk := a.HairColor
			a.Hat, a.HatColor = capHat, &hk
		}
	}
	if a.Hat == 0 || (a.HatColor != nil && a.HatColor.zero()) {
		a.HatColor = nil
	}
	b, _ := json.Marshal(a)
	return b
}
