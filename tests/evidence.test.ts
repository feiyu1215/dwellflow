import assert from "node:assert/strict"
import test from "node:test"
import type { AppState, EvidenceAsset } from "../miniprogram/core/domain.ts"
import {
  assertEvidenceLinkAllowed,
  buildLegacyEvidenceCandidates,
  normalizeSha256,
  validateReadyEvidence
} from "../miniprogram/core/evidence.ts"

const timestamp = "2026-10-09T08:00:00.000Z"
const actor = { identityId: "owner-local", displayNameSnapshot: "负责人", mode: "local_demo" as const }
const sha = "a".repeat(64)

function evidence(): EvidenceAsset {
  return {
    id: "e1", projectId: "p1", origin: "manual_upload", category: "image",
    fileName: "现场.jpg", mediaType: "image/jpeg",
    storageRef: { kind: "local_file", localPath: "wxfile://evidence.jpg" },
    actualSizeBytes: 100, actualSha256: sha, receivedAt: timestamp, timeSource: "unknown",
    status: "ready", createdBy: actor, createdAt: timestamp, updatedAt: timestamp, version: 1
  }
}

function state(): AppState {
  return {
    currentProjectId: "p1",
    projects: [{ id: "p1", name: "项目一", stage: "水电", ownerName: "负责人", status: "active", createdAt: timestamp, updatedAt: timestamp }],
    projectLifecycleEvents: [], spaces: [], spaceRelations: [], spaceStageStates: [], legacyRoomMappings: [],
    evidenceAssets: [evidence()], evidenceLinks: [],
    records: [{ id: "r1", projectId: "p1", version: 1, title: "现场", note: "", room: "主卧", stage: "水电",
      creatorName: "负责人", occurredAt: timestamp, createdAt: timestamp,
      attachments: [{ id: "a1", name: "旧图.jpg", type: "image", localPath: "wxfile://old.jpg" }] }],
    recordRevisions: [{ id: "rv1", recordId: "r1", projectId: "p1", version: 1, title: "现场", note: "", room: "主卧",
      stage: "水电", creatorName: "负责人", occurredAt: timestamp,
      attachments: [{ id: "a1", name: "旧图.jpg", type: "image", localPath: "wxfile://old.jpg" }],
      changeReason: "初始", createdAt: timestamp }],
    issues: [], issueWorkflows: [], materials: [], inventory: [], expenses: [], agreements: [], purchaseLines: [], receiptBatches: [],
    unitConversions: [], materialInventoryEvents: [], materialUsageRecords: [], costItems: [], costApprovals: [], paymentFacts: [],
    refundFacts: [], members: [], shares: [], consultations: [], consultationResponses: [], cameras: [], analyses: [], materialChecks: [],
    recordReviewApplications: [], imageObservationApplications: [], rectificationApplications: [], consultationApplications: [],
    budgetEstimateApplications: [], projectSummaryApplications: []
  }
}

test("ready 证据要求持久原件、大小和合法 SHA-256", () => {
  assert.doesNotThrow(() => validateReadyEvidence(evidence()))
  assert.equal(normalizeSha256(sha.toUpperCase()), sha)
  assert.throws(() => validateReadyEvidence({ ...evidence(), actualSha256: "bad" }), /SHA-256/)
  assert.throws(() => validateReadyEvidence({ ...evidence(), storageRef: undefined }), /持久原件/)
})

test("旧记录与同附件历史版本只形成一个待登记候选", () => {
  const candidates = buildLegacyEvidenceCandidates(state(), "p1")
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].attachment.id, "a1")
  assert.equal(candidates[0].sourceType, "record")
})

test("证据关联拒绝不存在目标和跨项目空间，并对重复关联幂等", () => {
  const current = state()
  assert.throws(() => assertEvidenceLinkAllowed(current, { projectId: "p1", evidenceId: "e1",
    target: { type: "record", id: "missing" }, relationKind: "supporting" }), /目标不存在/)
  const linked = { id: "l1", projectId: "p1", evidenceId: "e1", target: { type: "record" as const, id: "r1" },
    relationKind: "supporting" as const, note: "", status: "active" as const, createdBy: actor, createdAt: timestamp, version: 1 }
  current.evidenceLinks.push(linked)
  assert.equal(assertEvidenceLinkAllowed(current, { projectId: "p1", evidenceId: "e1",
    target: { type: "record", id: "r1" }, relationKind: "supporting" })?.id, "l1")
})
