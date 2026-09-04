import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/hyperframes/compositions");

test("every HyperFrames composition is standalone and local-only", async () => {
  for (const name of await readdir(root)) {
    if (!name.endsWith(".html")) continue;
    const body = await readFile(path.join(root, name), "utf8");
    assert.match(body, /data-composition-id=/, name);
    assert.match(body, /data-no-timeline/, name);
    assert.doesNotMatch(body, /\.\.\/assets|https?:\/\//, name);
  }
});
