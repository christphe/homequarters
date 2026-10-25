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

hqView.onMessage<{ t: string; n?: number }>((m) => {
  if (m.t === "pong") out.textContent = "pong " + m.n;
  else if (m.t === "flood") out.textContent = "flood " + ++received;
});
hqView.send({ t: "hello", reachedPage });
