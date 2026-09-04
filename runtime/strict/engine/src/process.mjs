import {spawn} from "node:child_process";

export function runProcess(command, args, {timeoutMs = 120_000, maxBytes = 16 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill("SIGTERM");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: bytes > maxBytes,
      });
    });
  });
}
