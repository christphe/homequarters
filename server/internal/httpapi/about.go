package httpapi

import (
	"html/template"
	"net/http"
)

// about serves a public page at /about saying what this office is, who runs it
// and what a sign-in provider is used for, readable without signing in and
// without JavaScript. Google reviews it as the app's home page before it shows
// the app's name and logo on its consent screen.
func (s *Server) about(w http.ResponseWriter, r *http.Request) {
	office := s.cfg.OfficeName
	if o, err := s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug); err == nil {
		office = o.Name
	}
	google := false
	for _, p := range s.cfg.AuthProviders {
		google = google || p == "google"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	aboutPage.Execute(w, map[string]any{
		"Office":   office,
		"Operator": s.cfg.Operator,
		"SignIn":   s.cfg.AuthEnabled(),
		"Domains":  s.cfg.AuthDomains,
		"Google":   google,
		"Demo":     s.cfg.Demo,
	})
}

var aboutPage = template.Must(template.New("about").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Office}} - Home Quarters virtual office</title>
<meta name="description" content="{{.Office}} is a virtual office running Home Quarters: a 2D map where a team meets, talks and works together.">
` + pageStyle + `
<style>.cta{display:inline-block;margin:16px 0 0;padding:10px 18px;border-radius:8px;background:var(--link);color:var(--bg);font-weight:600;text-decoration:none}</style>
</head>
<body><main>
<h1>{{.Office}}</h1>
<p class="lead">A virtual office{{if .Operator}} run by {{.Operator}}{{end}}, built with Home Quarters.</p>

<p>{{.Office}} is where {{if .Operator}}the {{.Operator}} team{{else}}this team{{end}} works together online. Each member has a small pixel-art character on a shared map of the office. Walk up to colleagues to start talking with them by voice or video, step into a meeting room for a private discussion, share your screen, write in the office chat, and see at a glance who is around, busy or away.</p>
<p><a class="cta" href="/">Open the office</a></p>

<h2>What you can do here</h2>
<ul>
<li><strong>Talk by walking up:</strong> people standing close to each other hear and see each other; walk away to leave the conversation.</li>
<li><strong>Meeting rooms:</strong> everyone inside a room is in the same call, and nobody outside hears it.</li>
<li><strong>Chat and screen sharing:</strong> an office-wide chat, direct messages, and screen sharing with the people you are talking to.</li>
<li><strong>Presence:</strong> your status (available, busy, away) and your desk tell colleagues when they can reach you.</li>
</ul>
<p>Your camera and microphone stay off until you turn them on, and nothing is recorded.</p>

<h2>Who can enter</h2>
{{if .Demo}}<p>This is a public demo: anyone can try it, and it is reset regularly.</p>
{{else if .SignIn}}<p>Only members can enter{{if .Domains}}: people with an account of {{range $i, $d := .Domains}}{{if $i}}, {{end}}{{$d}}{{end}}, and people an administrator invited{{else}}, after an administrator invited them{{end}}. Everyone signs in first.</p>
{{else}}<p>Only members can enter, after an administrator invited them.</p>
{{end}}
{{if .Google}}
<h2>Sign in with Google</h2>
<p>When you choose "Continue with Google", {{.Office}} asks Google only for your account's identifier and email address, to recognise you each time you come back and to check that you belong to the organisation. It does not receive your name, photo, contacts, calendar, files or password, and the name you show in the office is the one you choose here.</p>
{{end}}
<h2>More</h2>
<ul>
<li><a href="/privacy">Privacy policy</a>: what is stored, why, who can see it and how to delete it.</li>
<li><a href="https://github.com/christphe/homequarters">Home Quarters</a> is open source software. It is not affiliated with Google.</li>
</ul>
</main></body></html>`))
