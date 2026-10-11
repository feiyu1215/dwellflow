import assert from "node:assert/strict"
import test from "node:test"
import type { Space } from "../miniprogram/core/domain.ts"
import {
  resolvePatrolEntryContext,
  spaceIdForRoom
} from "../miniprogram/core/patrol-handoff.ts"
import {
  ORIGIN_CONTEXT_SCHEMA_VERSION,
  type OriginContext
} from "../miniprogram/core/project-navigation.ts"

const spaces: Space[] = [
  {
    id: "space_kitchen", projectId: "project_a", name: "厨房", kind: "kitchen", order: 0,
    participatesInTopology: true, status: "active",
    createdBy: { identityId: "owner", displayNameSnapshot: "负责人", mode: "local_demo" },
    createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", version: 1
  },
  {
    id: "space_study", projectId: "project_a", name: "书房", kind: "custom", order: 1,
    participatesInTopology: true, status: "active",
    createdBy: { identityId: "owner", displayNameSnapshot: "负责人", mode: "local_demo" },
    createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", version: 1
  }
]

function origin(overrides: Partial<OriginContext> = {}): OriginContext {
  return {
    projectId: "project_a", originView: "patrol", spaceId: "space_kitchen",
    stageId: "水电", patrolStepId: "record", returnToken: "return_1",
    schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION,
    ...overrides
  }
}

test("巡场入口用当前项目空间和阶段预填记录表单", () => {
  const result = resolvePatrolEntryContext({
    context: origin(), projectId: "project_a", currentStage: "泥瓦", spaces
  })
  assert.equal(result.accepted, true)
  assert.equal(result.roomOptions[result.roomIndex], "厨房")
  assert.equal(result.stageIndex, 2)
  assert.equal(result.spaceId, "space_kitchen")
  assert.match(result.label, /厨房/)
})

test("自定义空间进入表单时加入房间选项且不丢失 spaceId", () => {
  const result = resolvePatrolEntryContext({
    context: origin({ spaceId: "space_study" }), projectId: "project_a", currentStage: "水电", spaces
  })
  assert.equal(result.roomOptions[0], "书房")
  assert.equal(spaceIdForRoom({
    projectId: "project_a", roomName: "书房", spaces, preferredSpaceId: result.spaceId
  }), "space_study")
})

test("跨项目或已经失效的空间不能作为表单预填依据", () => {
  const crossProject = resolvePatrolEntryContext({
    context: origin({ projectId: "project_b" }), projectId: "project_a", currentStage: "水电", spaces
  })
  const missingSpace = resolvePatrolEntryContext({
    context: origin({ spaceId: "space_missing" }), projectId: "project_a", currentStage: "水电", spaces
  })
  assert.equal(crossProject.accepted, false)
  assert.equal(missingSpace.accepted, false)
  assert.equal(crossProject.spaceId, undefined)
  assert.equal(missingSpace.roomOptions[0], "全屋")
})
