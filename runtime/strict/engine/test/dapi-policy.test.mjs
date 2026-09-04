import assert from "node:assert/strict";
import {chmod, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(root, "scripts", "integrations", "dapi-local.sh");

test("DAPI wrapper permits local inspection and blocks hosted analysis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "content-hub-dapi-"));
  const fake = join(dir, "dapi");
  await writeFile(fake, "#!/bin/zsh\nprint -r -- \"$*\"\n");
  await chmod(fake, 0o755);
  const env = {...process.env, CONTENT_HUB_DAPI_BIN: fake};

  assert.equal((await run(wrapper, ["media", "probe", "clip.mp4"], {env})).stdout.trim(), "media probe clip.mp4");
  await assert.rejects(
    run(wrapper, ["media", "listen", "clip.mp4"], {env}),
    (error) => error.code === 2 && /Blocked DAPI media operation/u.test(error.stderr),
  );
});
