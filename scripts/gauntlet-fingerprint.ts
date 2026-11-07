// The fingerprint of the working tree that the gauntlet's record names, so a critic can tell whether the
// gates ran on the code under review. It is the content of the files the gates read: the index, the diff
// against HEAD and the untracked files git does not ignore. Files no gate reads (the changelogs, the
// design notes and plans) are left out, so committing one keeps a record current.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EXCLUDED: readonly string[] = ["server/CHANGELOG.md", "desktop/CHANGELOG.md", "docs/superpowers"];

export function fingerprint(root: string): string {
  const spec = ["--", ".", ...EXCLUDED.map((p) => `:(exclude)${p}`)];
  const git = (...args: string[]) => execFileSync("git", [...args, ...spec], { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const h = crypto.createHash("sha1");
  h.update(git("ls-files", "-s"));
  h.update(git("diff", "HEAD"));
  for (const file of git("ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean)) {
    h.update(file + "\0");
    try {
      h.update(crypto.createHash("sha1").update(fs.readFileSync(path.join(root, file))).digest("hex"));
    } catch {
      h.update("missing");
    }
  }
  return h.digest("hex").slice(0, 12);
}
