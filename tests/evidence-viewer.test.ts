import assert from "node:assert/strict"
import test from "node:test"
import type { AppState, EvidenceAsset } from "../miniprogram/core/domain.ts"
import {
  buildEvidenceAssociationCandidates,
  buildEvidenceAssociations,
  evidencePreviewState
} from "../miniprogram/core/evidence-viewer.ts"

const actor = { identityId: "owner", displayNameSnapshot: "负责人", mode: "local_demo" as const }
const asset: EvidenceAsset = {
  id: "e1", projectId: "p1", origin: "manual_upload", category: "image", fileName: "现场.jpg",
  mediaType: "image/jpeg", storageRef: { kind: "local_file", localPath: "wxfile://photo.jpg" },
  actualSizeBytes: 100, actualSha256: "a".repeat(64), receivedAt: "2026-10-09T08:00:00.000Z",
  timeSource: "imported", status: "ready", createdBy: actor,
  createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z", version: 1
}

function state(): AppState {
  return {
    currentProjectId: "p1",
    projects: [{ id: "p1", name: "家装", stage: "水电", ownerName: "负责人", status: "active",
      createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z" }],
    projectLifecycleEvents: [], spaces: [], spaceRelations: [], spaceStageStates: [], legacyRoomMappings: [],
    evidenceAssets: [asset],
    evidenceLinks: [{ id: "link-project", projectId: "p1", evidenceId: "e1",
      target: { type: "project", id: "p1" }, relationKind: "original", note: "", status: "active",
      createdBy: actor, createdAt: "2026-10-09T08:00:00.000Z", version: 1 }],
    records: [{ id: "r1", projectId: "p1", version: 2, title: "水电记录", note: "", room: "厨房",
      stage: "水电", creatorName: "负责人", occurredAt: "2026-10-09T08:00:00.000Z",
      createdAt: "2026-10-09T08:00:00.000Z", attachments: [] }],
    recordRevisions: [],
    issues: [{ id: "i1", projectId: "p1", title: "插座待确认", description: "", room: "厨房", stage: "水电",
      status: "pending_confirmation", proposals: [], createdAt: "2026-10-09T08:00:00.000Z", updatedAt: "2026-10-09T08:00:00.000Z" }],
    issueWorkflows: [],
    materials: [{ id: "m1", projectId: "p1", name: "电线", specification: "2.5 平方", unit: "卷",
      plannedQuantity: 2, createdAt: "2026-10-09T08:00:00.000Z" }],
    inventory: [], expenses: [], agreements: [], purchaseLines: [],
    receiptBatches: [{ id: "b1", projectId: "p1", materialId: "m1", unit: "卷",
      occurredAt: "2026-10-09T08:00:00.000Z", version: 1, quantityEvents: [], allocationEvents: [] }],
    unitConversions: [], materialInventoryEvents: [], materialUsageRecords: [], costItems: [], costApprovals: [],
    paymentFacts: [], refundFacts: [], members: [], shares: [], consultations: [], consultationResponses: [],
    cameras: [], analyses: [], materialChecks: [], recordReviewApplications: [], imageObservationApplications: [],
    rectificationApplications: [], consultationApplications: [], budgetEstimateApplications: [], projectSummaryApplications: []
  }
}

test("R8-2C 查看器只预览可用的本地原件", () => {
  assert.deepEqual(evidencePreviewState(asset), { available: true, localPath: "wxfile://photo.jpg", reason: "" })
  assert.equal(evidencePreviewState({ ...asset, status: "missing" }).available, false)
  assert.match(evidencePreviewState({ ...asset, status: "failed" }).reason, /完整性/)
  assert.match(evidencePreviewState({ ...asset, storageRef: { kind: "server_attachment", attachmentId: "a1" } }).reason, /服务端/)
})

test("R8-2C 关联候选来自当前项目且过滤已关联对象", () => {
  const current = state()
  const before = buildEvidenceAssociationCandidates(current, "p1", "e1")
  assert.deepEqual(before.map(item => item.target.type), ["record", "issue", "material", "receipt_batch"])
  current.evidenceLinks.push({ id: "link-record", projectId: "p1", evidenceId: "e1",
    target: { type: "record", id: "r1", version: 2 }, relationKind: "supporting", note: "", status: "active",
    createdBy: actor, createdAt: "2026-10-09T08:00:00.000Z", version: 1 })
  const after = buildEvidenceAssociationCandidates(current, "p1", "e1")
  assert.equal(after.some(item => item.target.type === "record" && item.target.id === "r1"), false)
})

test("R8-2C 来源关联受保护并解析业务对象名称", () => {
  const current = state()
  current.evidenceLinks.push({ id: "link-issue", projectId: "p1", evidenceId: "e1",
    target: { type: "issue", id: "i1" }, relationKind: "supporting", note: "", status: "active",
    createdBy: actor, createdAt: "2026-10-09T08:00:00.000Z", version: 1 })
  const links = buildEvidenceAssociations(current, "p1", "e1")
  assert.equal(links.find(item => item.id === "link-project")?.protected, true)
  assert.equal(links.find(item => item.id === "link-issue")?.targetLabel, "插座待确认")
  assert.equal(links.find(item => item.id === "link-issue")?.protected, false)
})

