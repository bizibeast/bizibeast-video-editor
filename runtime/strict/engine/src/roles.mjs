export const ROLES = Object.freeze([
  "human",
  "coordinator",
  "script-editorial",
  "local-media-technician",
  "story-editor",
  "subject-analyst",
  "asset-resolver",
  "design-director",
  "design-approver",
  "premiere-executor",
  "hyperframes-executor",
  "carousel-lead",
  "carousel-slide-executor",
  "technical-qc-validator",
  "creative-qc-reviewer",
  "release-promoter",
]);

const REVIEWER_ROLES = new Set(["design-approver", "technical-qc-validator", "creative-qc-reviewer"]);

export function assertIndependentReviewer({producerActorId, reviewerActorId, reviewerRole}) {
  if (!REVIEWER_ROLES.has(reviewerRole)) throw new Error(`Role ${reviewerRole} is not a reviewer role`);
  if (typeof producerActorId !== "string" || !producerActorId.trim() || typeof reviewerActorId !== "string" || !reviewerActorId.trim()) {
    throw new Error("Producer and reviewer actors are required");
  }
  if (producerActorId === reviewerActorId) throw new Error("A producer cannot review its own work");
  return true;
}
