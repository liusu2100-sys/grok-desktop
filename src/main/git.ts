import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
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

export function resolveInside(cwd: string, filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("路径超出项目目录");
  }
  return abs;
}

function gitError(err: unknown): Error {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return new Error(stderr);
  }
  return new Error(err instanceof Error ? err.message : String(err));
}

async function gitOk(cwd: string, args: string[]): Promise<void> {
  try {
    await git(cwd, args);
  } catch (err) {
    throw gitError(err);
  }
}

export async function gitStage(cwd: string, paths?: string[]): Promise<void> {
  if (!paths?.length) {
    await gitOk(cwd, ["add", "-A"]);
    return;
  }
  await gitOk(cwd, ["add", "--", ...paths.map((file) => repoPath(cwd, file))]);
}

function repoPath(cwd: string, filePath: string): string {
  return relative(cwd, resolveInside(cwd, filePath)).split("\\").join("/");
}

export async function gitDiscard(cwd: string, paths?: string[]): Promise<void> {
  if (!paths?.length) {
    try {
      await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
    } catch {
      /* a repository with no commits has nothing to restore */
    }
    let added = "";
    try {
      added = await git(cwd, ["diff", "--cached", "-z", "--name-only", "--diff-filter=A"]);
    } catch {
      added = "";
    }
    for (const file of added.split("\0")) {
      if (!file) continue;
      await gitOk(cwd, ["rm", "-f", "--", repoPath(cwd, file)]);
    }
    await gitOk(cwd, ["clean", "-fd"]);
    return;
  }
  for (const filePath of paths) {
    const rel = repoPath(cwd, filePath);
    let tracked = "";
    try {
      tracked = await git(cwd, ["ls-files", "--", rel]);
    } catch {
      tracked = "";
    }
    let inHead = false;
    try {
      await git(cwd, ["cat-file", "-e", `HEAD:${rel}`]);
      inHead = true;
    } catch {
      inHead = false;
    }
    if (inHead) {
      await gitOk(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", rel]);
    } else if (tracked.trim()) {
      await gitOk(cwd, ["rm", "-f", "--", rel]);
    } else {
      await gitOk(cwd, ["clean", "-f", "--", rel]);
    }
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
