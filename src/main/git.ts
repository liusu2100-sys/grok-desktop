import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitChange, GitSnapshot } from "../shared/types";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const [branchOut, statusOut] = await Promise.all([
      git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(cwd, ["status", "--porcelain", "-uall"]),
    ]);
    const changes: GitChange[] = [];
    for (const line of statusOut.split(/\r?\n/)) {
      if (line.length < 3) continue;
      const xy = line.slice(0, 2);
      const path = line.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop() ?? line.slice(3);
      if (xy[0] !== " " && xy[0] !== "?") {
        changes.push({ path, status: xy[0], staged: true });
      }
      if (xy[1] !== " " && xy[1] !== "?") {
        changes.push({ path, status: xy[1], staged: false });
      }
      if (xy === "??") {
        changes.push({ path, status: "?", staged: false });
      }
    }
    return { branch: branchOut.trim() || "HEAD", changes };
  } catch {
    return { branch: "", changes: [] };
  }
}

export async function gitDiff(cwd: string, filePath?: string): Promise<string> {
  try {
    const args = ["diff", "--no-color"];
    if (filePath) args.push("--", filePath);
    const unstaged = await git(cwd, args);
    const stagedArgs = ["diff", "--cached", "--no-color"];
    if (filePath) stagedArgs.push("--", filePath);
    const staged = await git(cwd, stagedArgs);
    return [staged && `@@ staged @@\n${staged}`, unstaged].filter(Boolean).join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
