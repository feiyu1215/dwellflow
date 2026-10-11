import assert from "node:assert/strict"
import test from "node:test"
import type { AppState, Space, SpaceRelation } from "../miniprogram/core/domain.ts"
import {
  assertSpaceRelationAllowed,
  buildLegacyRoomCandidates,
  buildSpaceStageState,
  inferredSpaceKind,
  normalizeRoomLabel,
  validateSpace
} from "../miniprogram/core/spaces.ts"

const actor = { identityId: "owner-local", displayNameSnapshot: "负责人", mode: "local_demo" as const }
const timestamp = "2026-10-08T10:00:00.000Z"

function state(): AppState {
  return {
    currentProjectId: "p1",
    projects: [{ id: "p1", name: "项目一", stage: "水电", ownerName: "负责人", status: "active", createdAt: timestamp, updatedAt: timestamp }],
    projectLifecycleEvents: [], spaces: [], spaceRelations: [], spaceStageStates: [], legacyRoomMappings: [], evidenceAssets: [], evidenceLinks: [],
    records: [
      { id: "r1", projectId: "p1", version: 1, title: "", note: "", room: " 主卧 ", stage: "水电", creatorName: "负责人", occurredAt: timestamp, createdAt: timestamp, attachments: [] },
      { id: "r2", projectId: "p1", version: 1, title: "", note: "", room: "卧室", stage: "水电", creatorName: "负责人", occurredAt: timestamp, createdAt: timestamp, attachments: [] },
      { id: "r3", projectId: "p1", version: 1, title: "", note: "", room: "主卧", stage: "水电", creatorName: "负责人", occurredAt: timestamp, createdAt: timestamp, attachments: [] }
    ],
    recordRevisions: [], issues: [], issueWorkflows: [], materials: [], inventory: [], expenses: [], agreements: [],
    purchaseLines: [], receiptBatches: [], unitConversions: [], materialInventoryEvents: [], materialUsageRecords: [],
    costItems: [], costApprovals: [], paymentFacts: [], refundFacts: [], members: [], shares: [], consultations: [],
    consultationResponses: [], cameras: [], analyses: [], materialChecks: [], recordReviewApplications: [],
    imageObservationApplications: [], rectificationApplications: [], consultationApplications: [],
    budgetEstimateApplications: [], projectSummaryApplications: []
  }
}

function space(id: string, projectId = "p1"): Space {
  return { id, projectId, name: id, kind: "custom", order: 0, participatesInTopology: true,
    status: "active", createdBy: actor, createdAt: timestamp, updatedAt: timestamp, version: 1 }
}

test("旧标签只去首尾空白，相似房间不自动合并", () => {
  const candidates = buildLegacyRoomCandidates(state(), "p1")
  assert.equal(candidates.length, 2)
  assert.equal(candidates.find(item => item.normalizedLabel === "主卧")?.recordCount, 2)
  assert.equal(candidates.find(item => item.normalizedLabel === "卧室")?.recordCount, 1)
  assert.equal(normalizeRoomLabel(" 主卧 "), "主卧")
  assert.equal(inferredSpaceKind("主卧"), "bedroom")
})

test("全屋不能进入物理拓扑，空间名称和版本受校验", () => {
  const invalid = { ...space("whole"), name: "全屋", kind: "whole_project" as const, participatesInTopology: true }
  assert.match(validateSpace(invalid).join("；"), /全屋不能作为物理拓扑节点/)
})

test("空间关系拒绝跨项目、自关联、反向重复和包含环", () => {
  const spaces = [space("a"), space("b"), space("c"), space("other", "p2")]
  assert.throws(() => assertSpaceRelationAllowed(spaces, [], { projectId: "p1", fromSpaceId: "a", toSpaceId: "a", kind: "adjacent" }), /自身/)
  assert.throws(() => assertSpaceRelationAllowed(spaces, [], { projectId: "p1", fromSpaceId: "a", toSpaceId: "other", kind: "adjacent" }), /同一项目/)
  const relation: SpaceRelation = { id: "rel", projectId: "p1", fromSpaceId: "a", toSpaceId: "b", kind: "adjacent", directionHint: "none", status: "active", confirmedBy: actor, confirmedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, version: 1 }
  assert.throws(() => assertSpaceRelationAllowed(spaces, [relation], { projectId: "p1", fromSpaceId: "b", toSpaceId: "a", kind: "adjacent" }), /已经存在/)
  const contains: SpaceRelation[] = [
    { ...relation, id: "ab", kind: "contains", fromSpaceId: "a", toSpaceId: "b" },
    { ...relation, id: "bc", kind: "contains", fromSpaceId: "b", toSpaceId: "c" }
  ]
  assert.throws(() => assertSpaceRelationAllowed(spaces, contains, { projectId: "p1", fromSpaceId: "c", toSpaceId: "a", kind: "contains" }), /循环/)
})

test("阶段状态使用新版本保留负责人确认与无证据事实", () => {
  assert.throws(() => buildSpaceStageState({ id: "stage", projectId: "p1", spaceId: "a", stageId: "水电",
    status: "confirmed_complete", note: "", actor, timestamp }), /请填写依据说明/)
  const first = buildSpaceStageState({ id: "stage", projectId: "p1", spaceId: "a", stageId: "水电",
    status: "confirmed_complete", note: "现场确认，但尚未补照片", actor, timestamp })
  assert.equal(first.version, 1)
  assert.equal(first.sourceEvidenceIds.length, 0)
  assert.equal(first.confirmedBy?.identityId, "owner-local")
  assert.throws(() => buildSpaceStageState({ id: "ignored", projectId: "p1", spaceId: "a", stageId: "水电",
    status: "in_progress", note: "", actor, timestamp, previous: first }), /请填写原因/)
  const second = buildSpaceStageState({ id: "ignored", projectId: "p1", spaceId: "a", stageId: "水电",
    status: "in_progress", note: "发现遗漏后回退", actor, timestamp, previous: first })
  assert.equal(second.id, first.id)
  assert.equal(second.version, 2)
  assert.equal(second.confirmedBy, undefined)
})
