import assert from "node:assert/strict";
import test from "node:test";

import {parseAlphaStats} from "../scripts/render-smoke.mjs";

test("alpha smoke requires both transparent and opaque pixels", () => {
  assert.deepEqual(parseAlphaStats("lavfi.signalstats.YMIN=0\nlavfi.signalstats.YMAX=255\n"), {min: 0, max: 255, varied: true});
  assert.equal(parseAlphaStats("lavfi.signalstats.YMIN=0\nlavfi.signalstats.YMAX=0\n").varied, false);
  assert.equal(parseAlphaStats("lavfi.signalstats.YMIN=255\nlavfi.signalstats.YMAX=255\n").varied, false);
});
