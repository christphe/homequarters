package httpapi

import (
	"html/template"
	"net/http"
	"strings"
)

// privacy serves the office's privacy policy at /privacy. It describes what
// this server actually stores, so it follows the configuration (sign-in, demo)
// rather than being a document someone has to keep in sync. Google asks for
// its address when an OAuth client is published.
func (s *Server) privacy(w http.ResponseWriter, r *http.Request) {
	office := s.cfg.OfficeName
	if o, err := s.st.OfficeBySlug(r.Context(), s.cfg.OfficeSlug); err == nil {
		office = o.Name
	}
	contact := s.cfg.Contact
	mail := ""
	if strings.Contains(contact, "@") && !strings.ContainsAny(contact, " :/") {
		mail = contact
	}
	google := false
	for _, p := range s.cfg.AuthProviders {
		google = google || p == "google"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	privacyPage.Execute(w, map[string]any{
		"Office":      office,
		"Operator":    s.cfg.Operator,
		"Contact":     contact,
		"Mail":        mail,
		"SignIn":      s.cfg.AuthEnabled(),
		"Google":      google,
		"Demo":        s.cfg.Demo,
		"DemoHours":   int(s.demoPeriod().Hours()),
		"SessionDays": int(s.cfg.SessionTTL.Hours() / 24),
	})
}

// pageStyle is shared by the server-rendered public pages (/about, /privacy).
const pageStyle = `<style>
:root{color-scheme:light dark;--bg:#f6f4ee;--fg:#1d1d1f;--muted:#5b5b63;--line:#d8d4ca;--link:#1d4ea8}
@media (prefers-color-scheme:dark){:root{--bg:#17171c;--fg:#ececf1;--muted:#a8a8b3;--line:#33333b;--link:#8fb4ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px;padding-top:8px;border-top:1px solid var(--line)}
p.lead{color:var(--muted);margin-top:0}a{color:var(--link)}li{margin:4px 0}
</style>`

var privacyPage = template.Must(template.New("privacy").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy - {{.Office}}</title>
` + pageStyle + `</head>
<body><main>
<p><a href="/">Back to the office</a> · <a href="/about">About this office</a></p>
<h1>Privacy policy</h1>
<p class="lead">{{.Office}}</p>

<p>This office runs on Tilework, open source virtual office software{{if .Operator}}, and is operated by {{.Operator}} ("we"){{end}}. This page says what the office stores about you, why, and who can see it.</p>

<h2>Who is responsible</h2>
{{if .Operator}}<p>{{.Operator}} runs this office and decides what happens to the data described here.</p>{{else}}<p>The organisation that runs this office decides what happens to the data described here.</p>{{end}}
{{if .Contact}}<p>For any question or request about your data: {{if .Mail}}<a href="mailto:{{.Mail}}">{{.Mail}}</a>{{else}}{{.Contact}}{{end}}.</p>{{else}}<p>For any question or request about your data, contact the administrators of this office.</p>{{end}}

<h2>What is stored</h2>
<ul>
<li><strong>Your profile:</strong> the name and avatar you choose here, your role (member or administrator), when you joined, your desk if you have one, and where you stood when you last left.</li>
{{if .SignIn}}<li><strong>Your sign-in account:</strong> {{if .Google}}when you sign in with Google, we ask Google only for your account's identifier and email address (the <code>openid</code> and <code>email</code> permissions). We do not receive your Google name, photo, contacts, calendar, files or password. {{end}}The account identifier given by your sign-in provider connects that account to your member account; its email address lets administrators recognise members and admit people of their organisation.</li>{{end}}
<li><strong>Cookies:</strong> one cookie keeps you signed in for up to {{.SessionDays}} days.{{if .SignIn}} Short-lived cookies protect the sign-in against forged requests.{{end}} Your browser also remembers your preferences (such as your devices and volume) on your own machine. There are no advertising, tracking or analytics cookies.</li>
<li><strong>Messages:</strong> the office-wide chat is stored, up to its last 500 messages. Direct messages and conversation chat are delivered and not stored.</li>
<li><strong>What you add to the office:</strong> whiteboard drawings, and notes, links and images placed on the map by administrators.</li>
<li><strong>Audio, video and screen sharing:</strong> only after you turn them on. They travel through this office's media server to the people in your conversation or room, and are never recorded.</li>
<li><strong>Activity log:</strong> administrators see a log of actions such as joins, sign-ins, role changes and removals (who, what, when; never message content), kept for the last 2,000 entries.</li>
<li><strong>Technical logs:</strong> the server logs technical events with member numbers, never message content, sign-in tokens or email addresses. Network addresses are kept in memory only, briefly, to limit abuse.</li>
</ul>
{{if .Demo}}<p><strong>This is a public demo.</strong> Anyone can join, everything written or drawn here is public, and the office is reset every {{.DemoHours}} hours. Do not share personal information.</p>{{end}}

<h2>How it is used</h2>
<p>Only to run this office: to let you in, show you to the people you meet, and carry your messages, calls and drawings. Nothing is sold, used for advertising or profiling, or shared beyond the people in this office and the servers that run it.</p>
{{if .Google}}
<h2>Data from Google</h2>
<p>The identifier and email address received from Google are used only to sign you in and to let administrators recognise members. They are not used for advertising, not sold, not used to train AI models and not transferred to anyone else. This office's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
{{end}}
<h2>Who can see what</h2>
<p>Members of the office see your name, avatar, status, status note and where you are in the office, the office chat, and what you share in their conversation. Administrators also see {{if .SignIn}}your sign-in email address, {{end}}the member list and the activity log.</p>

<h2>How long it is kept, and deleting it</h2>
<p>{{if .SignIn}}Your profile and sign-in account are{{else}}Your profile is{{end}} kept while you are a member. When an administrator removes you, your sessions{{if .SignIn}} and the link to your sign-in account{{end}} are deleted at once; your name stays attached to your past messages until they leave the office chat history and to entries of the activity log until they are rotated out. To see, correct or delete your data, change your name and avatar in the settings, or ask{{if .Contact}} {{if .Mail}}<a href="mailto:{{.Mail}}">{{.Mail}}</a>{{else}}{{.Contact}}{{end}}{{else}} the administrators{{end}}.</p>
<p>If you live in the European Union, you have the rights given by the GDPR: access, correction, deletion, restriction and objection, and the right to complain to your data protection authority.</p>

<h2>Changes</h2>
<p>This page describes the office as it runs today and changes with it.</p>
</main></body></html>`))
