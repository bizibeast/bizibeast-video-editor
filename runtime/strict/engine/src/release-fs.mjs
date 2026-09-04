import {execFile, spawn} from "node:child_process";
import {mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const sourcePath = fileURLToPath(new URL("./release-fs.c", import.meta.url));
const execFileAsync = promisify(execFile);
let helperPromise;

async function helperPath() {
  if (!helperPromise) helperPromise = (async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-hub-release-fs-bin-"));
    const binary = join(directory, "release-fs");
    await execFileAsync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", sourcePath, "-o", binary]);
    return binary;
  })();
  return helperPromise;
}

async function run(projectDir, operation, args, input) {
  const root = await realpath(projectDir);
  const binary = await helperPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [operation, root, ...args], {stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]});
    const stdout = [];
    const stderr = [];
    let childClosed = false;
    let exitCode;
    let inputDone = input === undefined;
    let inputError = null;
    let settled = false;
    const settle = () => {
      if (settled || !childClosed || !inputDone) return;
      settled = true;
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (inputError && (inputError.code !== "EPIPE" || exitCode === 0)) reject(inputError);
      else if (exitCode === 0) resolve({stdout: Buffer.concat(stdout), stderr: error});
      else reject(new Error(error || `release-fs ${operation} failed with status ${exitCode}`));
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      childClosed = true;
      exitCode = code;
      settle();
    });
    if (input !== undefined) {
      const finishInput = (error) => {
        inputError ??= error ?? null;
        inputDone = true;
        settle();
      };
      child.stdin.on("error", finishInput);
      child.stdin.end(input, finishInput);
    }
  });
}

function owner(value) {
  const match = /^(\d+) (\d+)$/u.exec(value.trim());
  if (!match) throw new Error("release-fs returned an invalid owner identity");
  return {dev: match[1], ino: match[2]};
}

function ownerArgs(value) {
  if (!/^\d+$/u.test(value?.dev) || !/^\d+$/u.test(value?.ino)) throw new Error("release-fs owner identity is required");
  return [value.dev, value.ino];
}

export async function writeExclusiveFile(projectDir, relativePath, bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("release-fs write bytes must be a Buffer");
  return owner((await run(projectDir, "write-exclusive", [relativePath], bytes)).stdout.toString("utf8"));
}

export async function copyExclusiveFile(projectDir, sourcePath, targetPath) {
  return owner((await run(projectDir, "copy-exclusive", [sourcePath, targetPath])).stdout.toString("utf8"));
}

export async function makeExclusiveDirectory(projectDir, relativePath) {
  return owner((await run(projectDir, "mkdir-exclusive", [relativePath])).stdout.toString("utf8"));
}

export async function makeDirectories(projectDir, relativePath) {
  return owner((await run(projectDir, "mkdirs", [relativePath])).stdout.toString("utf8"));
}

export async function renameExclusive(projectDir, sourcePath, targetPath, ownership) {
  await run(projectDir, "rename-exclusive", [sourcePath, targetPath, ...ownerArgs(ownership)]);
}

export async function readFileNoFollow(projectDir, relativePath) {
  const result = await run(projectDir, "read", [relativePath]);
  return {bytes: result.stdout, owner: owner(result.stderr)};
}

export async function hashFileNoFollow(projectDir, relativePath) {
  const result = (await run(projectDir, "hash", [relativePath])).stdout.toString("utf8").trim();
  const match = /^([a-f0-9]{64}) (\d+) (\d+) (\d+) (-?\d+) (\d+)$/u.exec(result);
  if (!match) throw new Error("release-fs returned invalid file hash metadata");
  const seconds = Number(match[5]);
  const nanoseconds = Number(match[6]);
  const mtimeMs = seconds * 1000 + nanoseconds / 1_000_000;
  if (!Number.isSafeInteger(Number(match[4])) || !Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanoseconds)
    || nanoseconds >= 1_000_000_000 || !Number.isFinite(mtimeMs)) throw new Error("release-fs returned invalid file metadata");
  return {sha256: match[1], owner: {dev: match[2], ino: match[3]}, bytes: Number(match[4]), mtimeMs};
}

export async function acquireProjectLock(projectDir, relativePath) {
  const [root, binary] = await Promise.all([realpath(projectDir), helperPath()]);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["lock", root, relativePath], {stdio: ["pipe", "pipe", "pipe"]});
    const stderr = [];
    let ready = false;
    let stdout = "";
    let settled = false;
    let release;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const closed = new Promise((resolveClose, rejectClose) => {
      child.on("close", (code) => {
        const error = Buffer.concat(stderr).toString("utf8").trim();
        if (!ready) fail(new Error(error || `release-fs lock failed with status ${code}`));
        if (code === 0) resolveClose();
        else rejectClose(new Error(error || `release-fs lock failed with status ${code}`));
      });
    });
    closed.catch(() => undefined);
    child.on("error", fail);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", (error) => {
      if (!ready && error.code !== "EPIPE") fail(error);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout !== "READY\n") return;
      ready = true;
      if (!settled) {
        settled = true;
        resolve({
          release: () => {
            if (!release) {
              release = closed;
              child.stdin.end();
            }
            return release;
          },
        });
      }
    });
  });
}

export async function removeOwnedFile(projectDir, relativePath, ownership) {
  return (await run(projectDir, "remove-file-owned", [relativePath, ...ownerArgs(ownership)])).stdout.toString("utf8").trim() === "1";
}

export async function removeOwnedStage(projectDir, relativePath, ownership) {
  return (await run(projectDir, "remove-stage-owned", [relativePath, ...ownerArgs(ownership)])).stdout.toString("utf8").trim() === "1";
}
