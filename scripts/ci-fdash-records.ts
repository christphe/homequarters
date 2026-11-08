// CI only: puts into .fdash/cache the fdash records (and the build outputs stored with them) that main's latest
// finished run published as the artifact named in argv, one per CI job: fdash-unit, fdash-integration,
// fdash-e2e-<shard>. Only runs of a push to main publish records, so a pull request cannot add one
// (.github/workflows/ci.yml, decision 0035). A run is used only if its commit is on
// main: a pushed tag named "main" also has "main" as its run's branch. Without such a run, nothing is restored
// and every check runs. Needs GH_TOKEN with actions: read and contents: read, and GITHUB_REPOSITORY.
// Usage: node scripts/ci-fdash-records.ts <artifact name>
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** A run as `gh run list --json databaseId,headSha,headBranch,event` lists it. */
export type Run = { databaseId: number; headSha: string; headBranch: string; event: string };

/** The ids of the runs to take records from, newest first: push runs of main whose commit is on main. */
export function pickRuns(runs: Run[], isOnMain: (sha: string) => boolean): number[] {
  return runs.filter((r) => r.event === "push" && r.headBranch === "main" && isOnMain(r.headSha)).map((r) => r.databaseId);
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const name = process.argv[2];
  const repo = process.env.GITHUB_REPOSITORY;
  if (!name || !repo) {
    console.error("usage: GITHUB_REPOSITORY=owner/repo node scripts/ci-fdash-records.ts <artifact name>");
    return 2;
  }
  fs.mkdirSync(".fdash/cache", { recursive: true });
  let runs: Run[] = [];
  try {
    runs = JSON.parse(gh(["run", "list", "--repo", repo, "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--status", "completed", "--limit", "5", "--json", "databaseId,headSha,headBranch,event"])) as Run[];
  } catch (e) {
    console.log("no records from main (cannot list its runs: " + String((e as Error).message).split("\n")[0] + "): every check runs");
    return 0;
  }
  // a commit is on main when main is ahead of it or is it
  const isOnMain = (sha: string) => {
    try {
      return ["ahead", "identical"].includes(gh(["api", `repos/${repo}/compare/${sha}...main`, "--jq", ".status"]).trim());
    } catch {
      return false;
    }
  };
  for (const id of pickRuns(runs, isOnMain)) {
    try {
      gh(["run", "download", String(id), "--repo", repo, "--name", name, "--dir", ".fdash/cache"]);
      console.log(`records from main's run ${id}: ${fs.readdirSync(".fdash/cache").length}`);
      return 0;
    } catch {
      // that run published no such artifact (a job that did not run, or expired): try an older one
    }
  }
  console.log("no records from main: every check runs");
  return 0;
}

if (import.meta.main) process.exitCode = main();
