import {createHash, randomUUID} from "node:crypto";
import {mkdir, open, readFile, realpath, rename, writeFile} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, relative, sep} from "node:path";
import {assertCoordinator, mutateManifest, readManifest} from "./manifest.mjs";

const PROJECT_NEXT = Object.freeze({DRAFT: ["BRIEF_APPROVED"], BRIEF_APPROVED: ["READY"], READY: []});
const PREPRODUCTION = Object.freeze({
  "voice-over": ["READY", "SCRIPT_DRAFT", "AWAITING_SCRIPT_APPROVAL", "SCRIPT_APPROVED", "AUDIO_READY", "TRANSCRIPT_READY", "STORY_PLANNED"],
  "raw-video": ["READY", "MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"],
  "multi-clip": ["READY", "MEDIA_INDEXED", "TRANSCRIPTS_READY", "STORY_PLANNED"],
  carousel: ["READY", "COPY_DRAFT", "AWAITING_COPY_APPROVAL", "COPY_APPROVED", "CAROUSEL_PLANNED"],
});
const COMMON_TAIL = Object.freeze([
  "DESIGN_PLANNED", "DESIGN_APPROVED", "EXECUTING", "CANDIDATE_FROZEN",
  "TECH_PASSED", "CREATIVE_PASSED", "APPROVED", "RELEASED", "DELIVERED",
]);
const FAILURE_STATES = new Set(["REVISION_REQUIRED", "SUPERSEDED", "BLOCKED", "REJECTED"]);
const EVIDENCE_STATES = new Set([
  "SCRIPT_APPROVED", "COPY_APPROVED", "DESIGN_APPROVED", "CANDIDATE_FROZEN",
  "TECH_PASSED", "CREATIVE_PASSED", "APPROVED", "RELEASED", "SUPERSEDED",
]);
const TERMINAL_STATES = new Set(["SUPERSEDED", "REJECTED", "DELIVERED"]);
const WORKFLOW_STATE_PATH = "Plans/workflow-state.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const EVENT_KEYS = [
  "actorId", "artifactRef", "createdAt", "eventHash", "from", "id", "previousEventHash",
  "reason", "scope", "to", "workItemId",
];
const workflowQueues = new Map();

function initialWorkflowState() {
  return {schemaVersion: 1, projectState: "DRAFT", workItems: [], events: []};
}

function initialWorkflowContents() {
  return `${JSON.stringify(initialWorkflowState(), null, 2)}\n`;
}

function legacyInitialWorkflowContents() {
  return `${JSON.stringify({projectState: "DRAFT", workItems: [], events: []}, null, 2)}\n`;
}

function sha256Value(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function confinedWorkflowPath(root, createParent = false) {
  const lexicalPath = join(root, WORKFLOW_STATE_PATH);
  if (createParent) await mkdir(dirname(lexicalPath), {recursive: true});
  let directory;
  try {
    directory = await realpath(dirname(lexicalPath));
  } catch (error) {
    if (!createParent && error?.code === "ENOENT") return lexicalPath;
    throw error;
  }
  if (!isWithin(root, directory)) throw new Error("Workflow state path must stay under the real project directory");
  let path = join(directory, basename(lexicalPath));
  try {
    const existing = await realpath(lexicalPath);
    if (!isWithin(root, existing)) throw new Error("Workflow state path must stay under the real project directory");
    path = existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path;
}

async function workflowLocation(projectDir) {
  const root = await realpath(projectDir);
  const manifest = await readManifest(root);
  return {root, manifest, path: await confinedWorkflowPath(root)};
}

function appendEvent(state, eventWithoutHash) {
  const previousEventHash = state.events.at(-1)?.eventHash ?? null;
  const event = {...eventWithoutHash, previousEventHash};
  event.eventHash = sha256Value(event);
  state.events.push(event);
  return event;
}

function assertEvent(event, previousEventHash) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(EVENT_KEYS)) {
    throw new Error("Invalid workflow event shape");
  }
  if (typeof event.id !== "string" || !event.id.trim()
    || !["project", "work-item"].includes(event.scope)
    || (event.scope === "project" ? event.workItemId !== null : typeof event.workItemId !== "string" || !event.workItemId.trim())
    || (event.from !== null && (typeof event.from !== "string" || !event.from))
    || typeof event.to !== "string" || !event.to
    || typeof event.reason !== "string" || !event.reason.trim()
    || typeof event.actorId !== "string" || !event.actorId.trim()
    || typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt))) {
    throw new Error("Invalid workflow event shape");
  }
  if (event.artifactRef !== null && (!event.artifactRef || typeof event.artifactRef !== "object" || Array.isArray(event.artifactRef)
    || JSON.stringify(Object.keys(event.artifactRef).sort()) !== JSON.stringify(["id", "sha256"])
    || typeof event.artifactRef.id !== "string" || !event.artifactRef.id.trim() || !SHA256.test(event.artifactRef.sha256))) {
    throw new Error("Invalid workflow event shape");
  }
  if (event.previousEventHash !== previousEventHash) throw new Error("Broken workflow event hash chain");
  if (!SHA256.test(event.eventHash)) throw new Error("Invalid workflow event hash");
  const {eventHash, ...withoutHash} = event;
  if (sha256Value(withoutHash) !== eventHash) throw new Error("Workflow event hash mismatch");
}

function validateWorkflowState(state) {
  if (state?.schemaVersion === undefined) state.schemaVersion = 1;
  if (!state || typeof state !== "object" || Array.isArray(state)
    || state.schemaVersion !== 1 || !Array.isArray(state.workItems) || !Array.isArray(state.events)
    || !PROJECT_NEXT[state.projectState]) {
    throw new Error("Invalid workflow state");
  }
  for (const item of state.workItems) {
    if (item.revision === undefined) item.revision = 1;
    if (!Number.isInteger(item.revision) || item.revision < 1) throw new Error("Invalid workflow state");
  }
  for (const [index, event] of state.events.entries()) {
    assertEvent(event, index ? state.events[index - 1].eventHash : null);
  }
  return state;
}

async function readWorkflowSnapshot({manifest, path}) {
  try {
    const contents = await readFile(path, "utf8");
    let state;
    try {
      state = JSON.parse(contents);
    } catch {
      throw new Error("Invalid workflow state");
    }
    return {contents, hash: sha256Bytes(contents), state: validateWorkflowState(state)};
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (manifest.orchestration.workflowStateSha256 !== null) throw new Error("Workflow state is missing for its manifest pointer");
    return {contents: null, hash: null, state: initialWorkflowState()};
  }
}

function assertCurrentWorkflowPointer(manifest, snapshot) {
  const pointer = manifest.orchestration.workflowStateSha256;
  if (pointer === null) {
    if (snapshot.contents === null || snapshot.contents === initialWorkflowContents() || snapshot.contents === legacyInitialWorkflowContents()) return;
    throw new Error("Workflow state pointer is uninitialized for non-pristine workflow bytes");
  }
  if (pointer !== snapshot.hash) throw new Error("Workflow state pointer does not match exact workflow bytes");
}

async function writeWorkflowState(root, state) {
  const path = await confinedWorkflowPath(root, true);
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, {encoding: "utf8", mode: 0o600});
  const temporaryHandle = await open(temporary, "r");
  try {
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  await rename(temporary, path);
  const directoryHandle = await open(dirname(path), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return sha256Bytes(contents);
}

async function updateWorkflow(projectDir, coordinatorContext, mutate) {
  const root = await realpath(projectDir);
  return serializeWorkflow(root, async () => {
    const location = await workflowLocation(root);
    assertCoordinator(location.manifest, coordinatorContext);
    const snapshot = await readWorkflowSnapshot(location);
    assertCurrentWorkflowPointer(location.manifest, snapshot);
    const next = structuredClone(snapshot.state);
    const result = await mutate(next);
    const workflowStateSha256 = await writeWorkflowState(root, next);
    await mutateManifest(root, coordinatorContext, (nextManifest) => {
      nextManifest.orchestration.workflowStateSha256 = workflowStateSha256;
      return nextManifest;
    });
    return {state: next, result};
  });
}

function serializeWorkflow(projectDir, operation) {
  const previous = workflowQueues.get(projectDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  workflowQueues.set(projectDir, next);
  return next.finally(() => {
    if (workflowQueues.get(projectDir) === next) workflowQueues.delete(projectDir);
  });
}

function assertReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) throw new Error("Transition reason is required");
}

function assertArtifactRef(to, artifactRef) {
  if (EVIDENCE_STATES.has(to) && (typeof artifactRef?.id !== "string" || !artifactRef.id.trim() || !SHA256.test(artifactRef.sha256))) {
    throw new Error(`${to} requires an artifact reference with SHA-256`);
  }
}

function workItemStates(modality) {
  const preproduction = PREPRODUCTION[modality];
  if (!preproduction) throw new Error(`Unsupported work-item modality: ${modality}`);
  return [...preproduction, ...COMMON_TAIL];
}

function isLegalWorkTransition(item, to, returnTo) {
  if (TERMINAL_STATES.has(item.state)) return false;
  if (item.state === "REVISION_REQUIRED") return to === item.returnTo || to === "BLOCKED";
  if (item.state === "BLOCKED") return to === item.resumeState;
  if (FAILURE_STATES.has(to)) {
    return to !== "REVISION_REQUIRED" || workItemStates(item.modality).includes(returnTo);
  }

  const states = workItemStates(item.modality);
  const fromIndex = states.indexOf(item.state);
  const toIndex = states.indexOf(to);
  return toIndex === fromIndex + 1;
}

export async function readWorkflowState(projectDir) {
  return (await readWorkflowSnapshot(await workflowLocation(projectDir))).state;
}

export function getWorkItem(workflowState, workItemId) {
  const workItem = workflowState.workItems.find((item) => item.id === workItemId);
  if (!workItem) throw new Error(`Unknown work item: ${workItemId}`);
  return workItem;
}

export async function transitionProject(projectDir, coordinatorContext, {to, reason}) {
  assertReason(reason);
  const {state} = await updateWorkflow(projectDir, coordinatorContext, (next) => {
    if (!PROJECT_NEXT[next.projectState]?.includes(to)) throw new Error(`Illegal transition from ${next.projectState} to ${to}`);
    const from = next.projectState;
    next.projectState = to;
    appendEvent(next, {
      id: randomUUID(), scope: "project", workItemId: null, from, to, reason,
      artifactRef: null, actorId: coordinatorContext.actorId, createdAt: new Date().toISOString(),
    });
  });
  return state;
}

export async function createWorkItem(projectDir, coordinatorContext, {id, title, modality}) {
  if (typeof id !== "string" || !id.trim() || typeof title !== "string" || !title.trim()) {
    throw new Error("Work item id and title are required");
  }
  workItemStates(modality);
  const {result} = await updateWorkflow(projectDir, coordinatorContext, (next) => {
    if (next.projectState !== "READY") throw new Error("Project must be READY before creating work items");
    if (next.workItems.some((item) => item.id === id)) throw new Error(`Work item already exists: ${id}`);
    const workItem = {id, title, modality, state: "READY", revision: 1};
    next.workItems.push(workItem);
    appendEvent(next, {
      id: randomUUID(), scope: "work-item", workItemId: id, from: null, to: "READY",
      reason: "work item created", artifactRef: null, actorId: coordinatorContext.actorId, createdAt: new Date().toISOString(),
    });
    return workItem;
  });
  return result;
}

function applyWorkItemTransition(next, coordinatorContext, {workItemId, to, reason, artifactRef, returnTo}) {
  assertReason(reason);
  assertArtifactRef(to, artifactRef);
  const item = getWorkItem(next, workItemId);
  if (to === "REVISION_REQUIRED" && item.state !== "BLOCKED" && !workItemStates(item.modality).includes(returnTo)) {
    throw new Error("REVISION_REQUIRED requires an explicit returnTo state");
  }
  if (!isLegalWorkTransition(item, to, returnTo)) throw new Error(`Illegal transition from ${item.state} to ${to}`);
  const from = item.state;
  item.state = to;
  if (to === "REVISION_REQUIRED") {
    if (from !== "BLOCKED") {
      item.returnTo = returnTo;
      item.revision += 1;
    }
    delete item.resumeState;
  }
  else if (to === "BLOCKED") item.resumeState = from;
  else {
    delete item.returnTo;
    delete item.resumeState;
  }
  appendEvent(next, {
    id: randomUUID(), scope: "work-item", workItemId, from, to, reason,
    artifactRef: artifactRef ?? null, actorId: coordinatorContext.actorId, createdAt: new Date().toISOString(),
  });
}

export async function transitionWorkItem(projectDir, coordinatorContext, transition) {
  const {state} = await updateWorkflow(projectDir, coordinatorContext, (next) => {
    applyWorkItemTransition(next, coordinatorContext, transition);
  });
  return state;
}

export async function transitionWorkItemSequence(projectDir, coordinatorContext, transitions) {
  if (!Array.isArray(transitions) || transitions.length < 1) throw new Error("Work-item transition sequence is required");
  const workItemId = transitions[0]?.workItemId;
  if (typeof workItemId !== "string" || transitions.some((transition) => transition?.workItemId !== workItemId)) {
    throw new Error("Work-item transition sequence must target one work item");
  }
  const {state} = await updateWorkflow(projectDir, coordinatorContext, (next) => {
    for (const transition of transitions) applyWorkItemTransition(next, coordinatorContext, transition);
  });
  return state;
}
