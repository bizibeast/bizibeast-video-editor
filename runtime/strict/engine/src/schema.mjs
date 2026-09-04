export const CURRENT_PROJECT_SCHEMA_VERSION = 2;

export function migrateManifestV1ToV2(input, coordinatorActorId = "content-hub-coordinator") {
  if (input.schemaVersion !== 1) throw new Error("Expected project schema version 1");
  return {
    ...structuredClone(input),
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    orchestration: {
      policyVersion: "bizibeast-v1",
      coordinatorActorId,
      workflowStatePath: "Plans/workflow-state.json",
      approvalsPath: "Plans/approvals.jsonl",
      workflowStateSha256: null,
    },
  };
}

export function validateManifestV2(input) {
  if (input?.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) throw new Error(`Unsupported project schema version: ${input?.schemaVersion}`);
  if (input.localOnly !== true) throw new Error("Project manifest must remain local-only");
  if (!input.orchestration?.coordinatorActorId) throw new Error("Project manifest requires coordinator actor ID");
  if (input.orchestration.workflowStatePath !== "Plans/workflow-state.json") throw new Error("Project manifest requires the fixed workflow state path");
  if (input.orchestration.approvalsPath !== "Plans/approvals.jsonl") throw new Error("Project manifest requires the fixed approvals path");
  return input;
}
