// Runs the desktop app on probe.html and reports what its webview can do (WebRTC media included).
// Usage: node e2e/desktop/probe.mjs <app binary> [out dir]
// Writes <out>/probe.json and <out>/window.png; exits non-zero when the page never reported, or when
// REQUIRE_WEBRTC=1 and media did not flow.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const [bin, outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-desktop-probe-out-"))] = process.argv.slice(2);
if (!bin) { console.error("usage: node probe.mjs <app binary> [out dir]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const page = fs.readFileSync(new URL("./probe.html", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let report = null;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { report = JSON.parse(body); res.writeHead(204).end(); });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const office = `http://127.0.0.1:${server.address().port}/`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-desktop-probe-"));
const app = spawn(bin, [`--office=${office}`, `--data-dir=${dataDir}`], { stdio: "inherit" });
let exited = null;
app.on("exit", (code) => { exited = code; });

for (let i = 0; i < 120 && !report && exited === null; i++) await sleep(500);
await sleep(1000); // let the page paint its results before the screenshot
const shot = path.join(outDir, "window.png");
try {
  if (process.platform === "darwin") execFileSync("screencapture", ["-x", shot]);
  else if (process.platform === "linux") execFileSync("import", ["-window", "root", shot]);
  else execFileSync("powershell", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${shot}')`]);
} catch (e) { console.log("# no screenshot: " + e.message); }
app.kill();
server.close();

console.log(JSON.stringify(report ?? { error: exited === null ? "the page never reported" : `the app exited with ${exited}` }, null, 1));
fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(report, null, 1));
if (!report) process.exit(1);
if (report.ipcFromPage !== "refused") { console.log("FAIL the office page can call the shell"); process.exit(1); }
if (!report.app) { console.log("FAIL the page is not told it runs in the desktop app"); process.exit(1); }
if (report.srcdocFrame !== true) { console.log("FAIL a sandboxed srcdoc frame (a plugin's) did not run"); process.exit(1); }
if (process.env.REQUIRE_WEBRTC === "1" && !report.webrtcMedia) { console.log("FAIL no WebRTC media in this webview"); process.exit(1); }
// REQUIRE_APIS=idle,notify: the APIs this system's app must give the office (natively or from the app)
const need = (process.env.REQUIRE_APIS ?? "").split(",").filter(Boolean);
if (need.includes("idle") && !["active", "idle"].includes(report.idleState)) { console.log("FAIL no working IdleDetector: " + report.idleState); process.exit(1); }
if (need.includes("layout") && !/^\S$/.test(report.layoutKeyQ ?? "")) { console.log("FAIL no keyboard layout map: " + report.layoutKeyQ); process.exit(1); }
if (need.includes("notify") && report.Notification !== "granted") { console.log("FAIL notifications not granted: " + report.Notification); process.exit(1); }
