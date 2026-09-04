import {readFile} from "node:fs/promises";
import {join} from "node:path";

import {readApprovals} from "./approvals.mjs";
import {validateArtifactEnvelope} from "./artifacts.mjs";
import {verifyCandidateBundle} from "./candidates.mjs";
import {sha256File} from "./checksum.mjs";
import {readManifest} from "./manifest.mjs";
import {confinedProjectPath} from "./paths.mjs";
import {findLockedArtifacts} from "./qc.mjs";
import {validateReleaseProjectState} from "./release.mjs";
import {getWorkItem, readWorkflowState} from "./workflow.mjs";

export async function listFinalDeliverables(projectDir, workItemId) {
  const workflow = await readWorkflowState(projectDir);
  const item = getWorkItem(workflow, workItemId);
  if (item.state !== "RELEASED") throw new Error("Final delivery requires RELEASED state");
  const receiptPath = `QC/${workItemId}/v${String(item.revision).padStart(3, "0")}/release-receipt.json`;
  let verified;
  try {
    verified = await validateReleaseProjectState(projectDir, receiptPath, ["RELEASED"]);
  } catch (error) {
    if (/Final deliverable (?:size|hash) mismatch/u.test(error.message)) throw new Error("Final deliverable hash mismatch");
    throw new Error("Final delivery project-state verification failed");
  }
  const {receipt, sha256} = verified;
  const released = workflow.events.findLast((event) => event.workItemId === workItemId && event.to === "RELEASED");
  if (receipt.modality !== item.modality
    || released?.artifactRef?.id !== `release-receipt:${workItemId}:v${String(item.revision).padStart(3, "0")}`
    || released.artifactRef.sha256 !== sha256) {
    throw new Error("Final delivery is not bound to the exact release receipt");
  }
  const requested = new Set(receipt.requestedDerivatives.map((value) => value.toLowerCase()));
  const files = receipt.files.filter(({finalPath}) => {
    const extension = finalPath.split(".").at(-1).toLowerCase();
    return receipt.modality === "carousel" ? extension === "png" || requested.has(extension) : requested.has(extension);
  });
  if (files.length === 0) throw new Error("Release receipt contains no requested Final deliverables");
  return {
    workItemId: receipt.workItemId,
    modality: receipt.modality,
    bundleHash: receipt.bundleHash,
    files: files.map(({finalPath: path, sha256: fileHash}) => ({path, sha256: fileHash})),
  };
}

function eventFor(workflow, workItemId, state) {
  return workflow.events.findLast((event) => event.workItemId === workItemId && event.to === state) ?? null;
}

async function evidenceStatus(projectDir, item, workflow, state, kind) {
  const event = eventFor(workflow, item.id, state);
  if (!event?.artifactRef) return null;
  const path = `QC/${item.id}/v${String(item.revision).padStart(3, "0")}/${kind}-qc.json`;
  try {
    const absolutePath = await confinedProjectPath(projectDir, path, {type: "file"});
    const artifact = JSON.parse(await readFile(absolutePath, "utf8"));
    validateArtifactEnvelope(artifact);
    const sha256 = await sha256File(absolutePath);
    const current = sha256 === event.artifactRef.sha256 && artifact.artifactId === event.artifactRef.id
      && artifact.workItemId === item.id && artifact.revision === item.revision && artifact.payload?.kind === `${kind}-qc`;
    return {id: event.artifactRef.id, sha256: event.artifactRef.sha256, state: current ? "current" : "tampered", artifact: current ? artifact : null};
  } catch {
    return {id: event.artifactRef.id, sha256: event.artifactRef.sha256, state: "missing", artifact: null};
  }
}

async function workItemStatus(projectDir, manifest, workflow, item) {
  const revision = String(item.revision).padStart(3, "0");
  const candidateEvent = eventFor(workflow, item.id, "CANDIDATE_FROZEN");
  let candidate = candidateEvent?.artifactRef ? {...candidateEvent.artifactRef, state: "missing"} : null;
  if (candidate) {
    try {
      const directory = item.modality === "carousel" ? "Carousels" : "Candidates";
      const bundle = await verifyCandidateBundle(projectDir, `Renders/${directory}/${item.id}/v${revision}/bundle.json`);
      candidate.state = candidate.id === `candidate:${item.id}:v${revision}` && candidate.sha256 === bundle.bundleHash ? "current" : "tampered";
    } catch {
      candidate.state = "missing";
    }
  }
  const [technical, creative] = await Promise.all([
    evidenceStatus(projectDir, item, workflow, "TECH_PASSED", "technical"),
    evidenceStatus(projectDir, item, workflow, "CREATIVE_PASSED", "creative"),
  ]);
  const approvedRef = eventFor(workflow, item.id, "APPROVED")?.artifactRef ?? null;
  const approved = approvedRef ? {
    ...approvedRef,
    state: creative?.state === "current" && approvedRef.id === creative.id && approvedRef.sha256 === creative.sha256 ? "current" : "stale",
  } : null;
  const retryEvent = workflow.events.findLast((event) => event.workItemId === item.id && event.artifactRef?.id.startsWith("retry-decision-"));
  let retry = retryEvent?.artifactRef ? {id: retryEvent.artifactRef.id, sha256: retryEvent.artifactRef.sha256, state: "missing", decision: null, action: null} : null;
  if (retry) {
    try {
      const artifact = (await findLockedArtifacts(projectDir, [{id: retry.id, sha256: retry.sha256}]))[0];
      retry = {...retry, state: "current", decision: artifact.payload, action: artifact.payload?.action ?? null};
    } catch {
      // Missing or changed retry evidence remains explicitly stale.
    }
  }
  let release = {state: "none", receiptHash: null, receiptSha256: null};
  let finalDeliverables = [];
  if (["RELEASED", "DELIVERED"].includes(item.state)) {
    try {
      const verified = await validateReleaseProjectState(projectDir, `QC/${item.id}/v${revision}/release-receipt.json`, [item.state]);
      release = {state: "verified", receiptHash: verified.receipt.receiptHash, receiptSha256: verified.sha256};
      finalDeliverables = verified.receipt.files.map(({finalPath: path, sha256}) => ({path, sha256}));
    } catch (error) {
      release = {state: "stale", receiptHash: null, receiptSha256: null, reason: error.message};
    }
  }
  const gateArtifact = technical?.artifact ?? creative?.artifact;
  return {
    ...item,
    candidate,
    technical: technical && (({artifact: _artifact, ...value}) => value)(technical),
    creative: creative && (({artifact: _artifact, ...value}) => value)(creative),
    approved,
    profileHash: gateArtifact?.payload?.profileHash ?? null,
    policyVersion: gateArtifact?.payload?.policyVersion ?? manifest.orchestration.policyVersion,
    technicalProfileHash: technical?.artifact?.payload?.profileHash ?? null,
    technicalPolicyVersion: technical?.artifact?.payload?.policyVersion ?? null,
    retry,
    retryDecision: retry?.decision ?? null,
    retryAction: retry?.action ?? null,
    release,
    releaseReceiptHash: release.receiptHash,
    releaseState: release.state,
    finalDeliverables,
  };
}

export async function getProjectStatus(projectDir) {
  const manifest = await readManifest(projectDir);
  const workflowPath = join(projectDir, manifest.orchestration.workflowStatePath);
  const [workflow, approvals, workflowStateSha256] = await Promise.all([
    readWorkflowState(projectDir),
    readApprovals(projectDir),
    sha256File(workflowPath),
  ]);
  const supersededWorkItemIds = new Set(workflow.workItems.filter(({state}) => state === "SUPERSEDED").map(({id}) => id));
  const activeArtifactHashes = new Map();
  for (const {workItemId, artifactRef} of workflow.events) {
    if (artifactRef && !supersededWorkItemIds.has(workItemId)) activeArtifactHashes.set(`${workItemId}\0${artifactRef.id}`, artifactRef.sha256);
  }
  const activeApprovals = new Map();
  for (const approval of approvals) {
    if (!supersededWorkItemIds.has(approval.workItemId)) activeApprovals.set(`${approval.kind}\0${approval.workItemId}`, approval);
  }
  const staleArtifacts = new Set();
  const staleApprovals = [];
  for (const approval of activeApprovals.values()) {
    if (approval.decision === "approved"
      && (activeArtifactHashes.get(`${approval.workItemId}\0${approval.subject.artifactId}`) !== approval.subject.sha256
        || approval.policyVersion !== manifest.orchestration.policyVersion)) {
      staleArtifacts.add(approval.subject.artifactId);
      staleApprovals.push(approval.id);
    }
  }
  const workflowStatePointer = manifest.orchestration.workflowStateSha256 !== workflowStateSha256;
  const workItems = await Promise.all(workflow.workItems.map((item) => workItemStatus(projectDir, manifest, workflow, item)));
  return {
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    slug: manifest.slug,
    localOnly: manifest.localOnly,
    mode: manifest.mode,
    editors: manifest.editors,
    format: manifest.format,
    projectState: workflow.projectState,
    workItems,
    stale: {
      workflowStatePointer,
      artifactIds: [...staleArtifacts],
      approvalIds: staleApprovals,
    },
    ready: workflow.projectState === "READY" && !workflowStatePointer && staleArtifacts.size === 0 && staleApprovals.length === 0,
    counts: {
      sources: manifest.sources.length,
      assets: manifest.assets.length,
      renders: manifest.renders.length,
      qc: manifest.qc.length,
      deliverables: manifest.deliverables.length,
    },
  };
}
