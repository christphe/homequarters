// The ui-demo plugin's view (e2e/scenarios/plugins.mjs): it says hello with whether it could reach the
// page (it must not), echoes what the client code posts, counts a flood, and floods on request.
let reachedPage = false;
try {
  reachedPage = !!parent.document.body; // an opaque origin: this throws
} catch {
  reachedPage = false;
}
let received = 0;
const out = document.createElement("p");
out.id = "out";
out.textContent = "waiting";
document.body.appendChild(out);

const kind = (v: unknown) => (v instanceof Map ? "Map" : v instanceof ArrayBuffer ? "ArrayBuffer " + v.byteLength : JSON.stringify(v));
hqView.onMessage<{ t: string; n?: number; big?: unknown; buf?: unknown }>((m) => {
  if (m.t === "pong") out.textContent = "pong " + m.n;
  else if (m.t === "raw") out.textContent = "raw big=" + kind(m.big) + " buf=" + kind(m.buf);
  else if (m.t === "flood") out.textContent = "flood " + ++received;
});
hqView.send({ t: "hello", reachedPage });
