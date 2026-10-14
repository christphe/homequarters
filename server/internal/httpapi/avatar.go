package httpapi

import "encoding/json"

// Avatar options are small integer indexes into palettes/styles defined by the client
// (web/src/game/art/characters.ts and web/src/game/palette.ts).
const (
	nSkin  = 6
	nHair  = 12 // styles; 5 is the retired cap, see legacyCapStyle
	nColor = 8
	nPet   = 9 // 0 = no pet, then cat, dog, bunny, fox, chick, slime, owl, axolotl
	nBeard = 6 // 0 = none, stubble, moustache, goatee, full, long
	nHat   = 9 // 0 = none, cap, beanie, headphones, bowler, top hat, beret, tricorne, clown

	legacyCapStyle = 5 // the old "cap" hairstyle, now bald + a cap hat
	baldStyle      = 2
	capHat         = 1
)

type avatar struct {
	Skin      int `json:"sk"`
	Hair      int `json:"hs"`
	HairColor int `json:"hc"`
	Shirt     int `json:"sh"`
	Pants     int `json:"pa"`
	Pet       int `json:"pt"`
	Beard     int `json:"bd,omitempty"`
	Hat       int `json:"ht,omitempty"`
	HatColor  int `json:"hk,omitempty"`
}

func clamp(v, n int) int {
	if v < 0 || v >= n {
		return 0
	}
	return v
}

// NormalizeAvatar never trusts client JSON: it re-serialises a validated struct.
func NormalizeAvatar(raw json.RawMessage) json.RawMessage {
	var a avatar
	_ = json.Unmarshal(raw, &a)
	a = avatar{clamp(a.Skin, nSkin), clamp(a.Hair, nHair), clamp(a.HairColor, nColor), clamp(a.Shirt, nColor), clamp(a.Pants, nColor), clamp(a.Pet, nPet),
		clamp(a.Beard, nBeard), clamp(a.Hat, nHat), clamp(a.HatColor, nColor)}
	if a.Hair == legacyCapStyle {
		// same pixels as before: the cap was drawn in the hair colour over a bald head
		a.Hair = baldStyle
		if a.Hat == 0 {
			a.Hat, a.HatColor = capHat, a.HairColor
		}
	}
	if a.Hat == 0 {
		a.HatColor = 0
	}
	b, _ := json.Marshal(a)
	return b
}
