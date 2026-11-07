// The repository's .env (see .env.example) for the e2e suite and the art scripts: E2E_MAX_PARALLEL, CHROME.
// A worktree without one reads its main checkout's. A variable already in the environment wins over the file.
// Import it before anything that reads those variables.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [path.join(root, ".env")];
try {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  files.push(path.join(path.dirname(common), ".env"));
} catch {}
const file = files.find((f) => fs.existsSync(f));
if (file) process.loadEnvFile(file);

/** The Chrome to drive. Nothing is guessed: without CHROME (in .env or the environment) the script stops. */
export function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  console.error(`CHROME is not set. Copy .env.example to ${path.join(root, ".env")} and set CHROME to your Chrome (the file lists the usual paths), or export CHROME.`);
  process.exit(1);
}
