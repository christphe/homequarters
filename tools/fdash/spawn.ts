// How to start a program on every OS. On Windows a command found as a .cmd or .bat (pnpm, npx) only starts
// through the shell, which then parses its arguments: each one is quoted. Nothing else uses a shell.
import fs from "node:fs";
import path from "node:path";

function quoteForCmd(arg: string): string {
  return /^[\w.,:/\\=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Whether `cmd` needs the shell here, and the arguments to give spawn. */
export function spawnSpec(cmd: string, platform: string, pathEnv: string, pathExt: string, args: string[] = []): { shell: boolean; args: string[] } {
  if (platform !== "win32" || /[\\/]/.test(cmd)) return { shell: false, args };
  const exts = path.extname(cmd) ? [""] : pathExt.split(";").filter(Boolean).map((e) => e.toLowerCase());
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, cmd + ext))) {
        const found = (cmd + ext).toLowerCase();
        const shell = found.endsWith(".cmd") || found.endsWith(".bat");
        return { shell, args: shell ? args.map(quoteForCmd) : args };
      }
    }
  }
  return { shell: false, args };
}
