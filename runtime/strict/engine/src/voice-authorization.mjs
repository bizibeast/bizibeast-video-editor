import {randomUUID} from "node:crypto";

import {sha256File} from "./checksum.mjs";
import {readManifest, mutateManifest} from "./manifest.mjs";

export async function authorizeVoice(projectDir, {assetId, subject, basis}, coordinatorContext) {
  if (!subject?.trim() || !basis?.trim()) throw new Error("Voice authorization requires a subject and basis");
  const manifest = await readManifest(projectDir);
  const asset = manifest.assets.find(({id}) => id === assetId);
  if (!asset || asset.kind !== "voice") throw new Error(`Authorization requires an ingested voice asset: ${assetId}`);
  const authorization = {
    id: `voice-authorization-${randomUUID()}`,
    assetId,
    sha256: asset.sha256,
    subject: subject.trim(),
    basis: basis.trim(),
    authorizedAt: new Date().toISOString(),
  };
  await mutateManifest(projectDir, coordinatorContext, (next) => {
    const current = next.assets.find(({id}) => id === assetId);
    if (!current || current.kind !== "voice") throw new Error(`Authorization requires an ingested voice asset: ${assetId}`);
    next.voiceAuthorizations ??= [];
    next.voiceAuthorizations.push(authorization);
    return next;
  });
  return authorization;
}

export async function verifyVoiceAuthorization(projectDir, assetId, referencePath) {
  const manifest = await readManifest(projectDir);
  const asset = manifest.assets.find(({id}) => id === assetId && id.startsWith("voice-"));
  if (!asset || asset.kind !== "voice") throw new Error(`Authorization requires an ingested voice asset: ${assetId}`);
  const checksum = await sha256File(referencePath);
  if (checksum !== asset.sha256) throw new Error("Reference checksum does not match the authorized voice asset");
  const authorization = (manifest.voiceAuthorizations ?? []).find((entry) => entry.assetId === assetId && entry.sha256 === checksum);
  if (!authorization) throw new Error(`No authorization exists for voice asset ${assetId}`);
  return true;
}
