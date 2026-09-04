import assert from "node:assert/strict";
import test from "node:test";

import {assertLiveReport, INSPECT_TIMEOUT_MS, parseToolData, resolveMutationTimeout, timeoutMessage} from "../scripts/premiere.mjs";

test("Premiere edit gate accepts only a live project and active sequence", () => {
  assert.doesNotThrow(() => assertLiveReport({overall: "ready", safeCheck: {readOnly: true}}));
  assert.throws(() => assertLiveReport({overall: "needs_attention"}), /not live-ready/);
});

test("Premiere tool content becomes stable readback data", () => {
  assert.deepEqual(parseToolData({content: [{type: "text", text: '{"success":true,"data":{"name":"Sequence 01"}}'}]}), {name: "Sequence 01"});
  assert.throws(() => parseToolData({content: [{type: "text", text: '{"success":false,"error":"No sequence"}'}]}), /No sequence/);
});

test("Premiere uses short inspection and bounded long mutation timeouts", () => {
  assert.equal(INSPECT_TIMEOUT_MS, 15_000);
  assert.equal(resolveMutationTimeout({}), 1_800_000);
  assert.equal(resolveMutationTimeout({BIZIBEAST_PREMIERE_TIMEOUT_MS: "600000"}), 600_000);
  assert.throws(() => resolveMutationTimeout({BIZIBEAST_PREMIERE_TIMEOUT_MS: "2000"}), /30000.*1800000/);
  assert.match(timeoutMessage("export_sequence", 1_800_000), /may still be running.*readback/i);
});
