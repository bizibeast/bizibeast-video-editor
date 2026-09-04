#!/usr/bin/env node

import {verifyVoiceAuthorization} from "../../src/voice-authorization.mjs";

const [projectDir, assetId, referencePath] = process.argv.slice(2);
if (!projectDir || !assetId || !referencePath) {
  throw new Error("Usage: verify-voice.mjs <project-dir> <asset-id> <reference-path>");
}
await verifyVoiceAuthorization(projectDir, assetId, referencePath);
