import assert from "node:assert/strict";
import test from "node:test";

import {assertLiveReport, parseToolData} from "../scripts/premiere.mjs";

test("Premiere edit gate accepts only a live project and active sequence", () => {
  assert.doesNotThrow(() => assertLiveReport({overall: "ready", safeCheck: {readOnly: true}}));
  assert.throws(() => assertLiveReport({overall: "needs_attention"}), /not live-ready/);
});

test("Premiere tool content becomes stable readback data", () => {
  assert.deepEqual(parseToolData({content: [{type: "text", text: '{"success":true,"data":{"name":"Sequence 01"}}'}]}), {name: "Sequence 01"});
  assert.throws(() => parseToolData({content: [{type: "text", text: '{"success":false,"error":"No sequence"}'}]}), /No sequence/);
});
