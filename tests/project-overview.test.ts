import assert from "node:assert/strict"
import test from "node:test"
import { buildProjectOverview } from "../miniprogram/core/project-overview.ts"
import type { AppState, Project } from "../miniprogram/core/domain.ts"

const project: Project = {
  id: "project-1",
  name: "父母家翻新",
  stage: "水电",
  ownerName: "负责人",
  status: "active",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z"
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    records: [],
    issueWorkflows: [],
    receiptBatches: [],
    agreements: [],
    paymentFacts: [],
    refundFacts: [],
    materials: [],
    costItems: [],
    members: [],
    consultations: [],
    cameras: [],
    ...overrides
  } as unknown as AppState
}

test("概览按复查、问题决定、到货、约定、财务的顺序选择唯一当前重点", () => {
  const model = buildProjectOverview(state({
    issueWorkflows: [
      { id: "issue-a", projectId: project.id, status: "pending_confirmation" },
      { id: "issue-b", projectId: project.id, status: "pending_review" }
    ] as AppState["issueWorkflows"],
    receiptBatches: [
      { id: "receipt-a", projectId: project.id, version: 1, allocations: [] }
    ] as unknown as AppState["receiptBatches"]
  }), project)
  assert.equal(model.focus.kind, "review")
  assert.equal(model.focus.count, 1)
  assert.equal(model.focus.route, "/pages/issues/index")
})

test("无负责人确认项时引导记录事实，不伪造风险或完成结论", () => {
  const empty = buildProjectOverview(state(), project)
  assert.equal(empty.focus.kind, "record")
  assert.match(empty.focus.title, /第一条|拍照|文字/)
  assert.match(empty.focus.summary, /不会自动推进阶段/)

  const withRecord = buildProjectOverview(state({
    records: [{ id: "record-1", projectId: project.id }] as AppState["records"]
  }), project)
  assert.match(withRecord.focus.title, /水电/)
})

test("流程摘要明确当前阶段只是项目设置，不代表空间完工", () => {
  const moments = buildProjectOverview(state(), project).moments
  assert.deepEqual(moments.map(item => item.label), ["已发生", "现在", "下一步"])
  assert.equal(moments[1].stage, "水电")
  assert.match(moments[1].summary, /不代表所有空间/)
})

test("项目资料提供现有核心能力的稳定入口", () => {
  const resources = buildProjectOverview(state(), project).resources
  assert.deepEqual(resources.map(item => item.id), [
    "spaces", "evidence", "records", "issues", "materials", "finance", "members",
    "consultation", "knowledge", "camera", "backup"
  ])
  assert.equal(new Set(resources.map(item => item.route)).size, resources.length)
})

test("归档项目在概览模型中统一标记只读", () => {
  const archived = buildProjectOverview(state(), { ...project, status: "archived" })
  assert.equal(archived.readonly, true)
  assert.match(archived.statusLabel, /归档|查看/)
})
