import { setState } from "./store";

interface Me { authenticated?: boolean; demo?: { resetHours: number; nextReset: number } | null; auth?: string[]; signup?: { email: string }; link?: { name: string } }

/** Asks the server where this browser stands and shows the matching screen, with an optional notice. */
export function loadMe(notice = "") {
  return fetch("/api/me")
    .then((r) => r.json())
    .then((j: Me) => setState({ phase: j.authenticated ? "play" : "join", demo: j.demo ?? null, notice, auth: { providers: j.auth ?? [], signup: j.signup ?? null, link: j.link ?? null } }))
    .catch(() => setState({ phase: "join" }));
}
