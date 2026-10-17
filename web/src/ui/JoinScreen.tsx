import { useState } from "react";
import { AvatarEditor } from "./AvatarEditor";
import { loadMe } from "../me";
import { saveAvatar, setState, useStore } from "../store";
import { hasKey, t, type Key } from "../i18n";

export function JoinScreen() {
  const signsIn = useStore((s) => s.auth.providers.length > 0);
  const signedUp = useStore((s) => !!s.auth.signup);
  return signsIn && !signedUp ? <SignInScreen /> : <ProfileForm />;
}

/** With sign-in on: one button per provider. A member from before sign-in sees the same buttons to link an account. */
function SignInScreen() {
  const { providers, link } = useStore((s) => s.auth);
  const notice = useStore((s) => s.notice);
  const q = new URLSearchParams(location.search);
  const code = q.get("auth") ?? "";
  const err = code && hasKey("signin.err." + code) ? t(("signin.err." + code) as Key) : "";
  const invite = q.get("invite") ?? "";
  // the invite travels through the sign-in; login_hint pre-selects an account at the provider
  const pass = new URLSearchParams();
  if (invite) pass.set("invite", invite);
  const hint = q.get("login_hint");
  if (hint) pass.set("login_hint", hint);
  const qs = pass.toString() ? "?" + pass.toString() : "";
  return (
    <main className="join">
      <div className="join-card">
        <h1>{link ? t("signin.link.title", { name: link.name }) : t("join.title")}</h1>
        {notice && <p className="error" role="alert">{notice}</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <p className={invite && !link ? "" : "muted"}>{link ? t("signin.link.body") : invite ? t("signin.invited") : t("signin.subtitle")}</p>
        <div className="signin">
          {providers.map((p) => (
            <a key={p} className="primary" href={`/auth/${encodeURIComponent(p)}/start${qs}`}>
              {hasKey("signin.with." + p) ? t(("signin.with." + p) as Key) : p}
            </a>
          ))}
        </div>
        {link && (
          <button type="button" className="btn signin-out" onClick={() => {
            // a fresh start: drop the previous person's error and login hint, keep an invite
            history.replaceState(null, "", location.pathname + (invite ? "?invite=" + encodeURIComponent(invite) : ""));
            void fetch("/api/signout", { method: "POST" }).then(() => loadMe());
          }}>
            {t("signin.notMe", { name: link.name })}
          </button>
        )}
        <p className="join-foot"><a href="/about" target="_blank" rel="noopener">{t("join.about")}</a> · <a href="/privacy" target="_blank" rel="noopener">{t("join.privacy")}</a></p>
      </div>
    </main>
  );
}

/** Name and avatar: the whole join without sign-in, the last step after it. */
function ProfileForm() {
  const av = useStore((s) => s.myAvatar);
  const [name, setName] = useState(() => localStorage.getItem("tilework.name") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const notice = useStore((s) => s.notice);
  const demo = useStore((s) => s.demo);
  const signup = useStore((s) => s.auth.signup);
  const invite = new URLSearchParams(location.search).get("invite") ?? "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), avatar: av, invite }) });
      if (signup && (r.status === 403 || r.status === 409)) {
        // back to the sign-in buttons, saying why: expired, invite used up, or the account already has a member
        const code = ((await r.json().catch(() => ({}))) as { code?: string }).code ?? "expired";
        history.replaceState(null, "", location.pathname);
        await loadMe(t((hasKey("signin.err." + code) ? "signin.err." + code : "signin.err.expired") as Key));
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      if (location.search) history.replaceState(null, "", location.pathname); // do not keep the invite token in the address bar
      localStorage.setItem("tilework.name", name.trim());
      setState({ phase: "play" });
    } catch {
      setErr(t("join.error"));
      setBusy(false);
    }
  };

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit}>
        <h1>{t("join.title")}</h1>
        {notice && <p className="error" role="alert">{notice}</p>}
        {demo && (
          <div className="demo-note" role="note">
            <strong>{t("demo.title")}</strong>
            <p>{t("demo.join", { hours: demo.resetHours })}</p>
            <p><a href="https://github.com/guhcostan/tilework" target="_blank" rel="noopener noreferrer">{t("demo.repo")}</a></p>
          </div>
        )}
        <p className="muted">{signup ? t("signin.as", { email: signup.email }) : t("join.subtitle")}</p>
        <label className="field">
          <span>{t("join.name")}</span>
          <input autoFocus maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <AvatarEditor value={av} onChange={saveAvatar} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary" disabled={busy || !name.trim()}>{t("join.enter")}</button>
        <p className="join-foot"><a href="/about" target="_blank" rel="noopener">{t("join.about")}</a> · <a href="/privacy" target="_blank" rel="noopener">{t("join.privacy")}</a></p>
      </form>
    </main>
  );
}
