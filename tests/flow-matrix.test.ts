import assert from "node:assert/strict"
import test from "node:test"
import { adjacentCoordinate, buildRenovationMatrix, matrixRows, RENOVATION_MODULES } from "../miniprogram/core/flow-matrix"
import { STAGES, type AppState, type Project } from "../miniprogram/core/domain"

const project: Project = {
  id: "project-1",
  name: "测试项目",
  ownerName: "负责人",
  stage: "水电",
  status: "active",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z"
}

const state = {
  currentProjectId: project.id,
  projects: [project],
  records: [{ id: "record-1", projectId: project.id, version: 1, title: "布线", note: "", room: "厨房", stage: "水电", creatorName: "负责人", occurredAt: "", createdAt: "", attachments: [] }],
  issues: [{ id: "issue-1", projectId: project.id, title: "插座", description: "", room: "厨房", stage: "水电", status: "pending_action", proposals: [], createdAt: "", updatedAt: "" }],
  materials: [], agreements: [], receiptBatches: [], costItems: [], paymentFacts: [], refundFacts: [], cameras: []
} as unknown as AppState

test("装修矩阵为每个阶段和模块建立唯一节点", () => {
  const matrix = buildRenovationMatrix(state, project)
  assert.equal(matrix.nodes.length, STAGES.length)
  assert.equal(matrix.nodes[0].length, RENOVATION_MODULES.length)
  assert.equal(matrix.currentStageIndex, STAGES.indexOf("水电"))
  assert.equal(matrix.nodes[2][0].count, 1)
  assert.equal(matrix.nodes[2][3].count, 1)
})

test("默认轴向与交换轴向生成不同的概览行", () => {
  const matrix = buildRenovationMatrix(state, project)
  assert.equal(matrixRows(matrix, false).length, STAGES.length)
  assert.equal(matrixRows(matrix, false)[0].cells.length, RENOVATION_MODULES.length)
  assert.equal(matrixRows(matrix, true).length, RENOVATION_MODULES.length)
  assert.equal(matrixRows(matrix, true)[0].cells.length, STAGES.length)
})

test("四向手势按当前轴向移动并在边界停止", () => {
  const matrix = buildRenovationMatrix(state, project)
  assert.deepEqual(adjacentCoordinate(matrix, { stageIndex: 2, moduleIndex: 2 }, "left", false), { stageIndex: 2, moduleIndex: 3 })
  assert.deepEqual(adjacentCoordinate(matrix, { stageIndex: 2, moduleIndex: 2 }, "up", false), { stageIndex: 3, moduleIndex: 2 })
  assert.deepEqual(adjacentCoordinate(matrix, { stageIndex: 2, moduleIndex: 2 }, "left", true), { stageIndex: 3, moduleIndex: 2 })
  assert.deepEqual(adjacentCoordinate(matrix, { stageIndex: 2, moduleIndex: 2 }, "up", true), { stageIndex: 2, moduleIndex: 3 })
  assert.equal(adjacentCoordinate(matrix, { stageIndex: 0, moduleIndex: 0 }, "right", false), null)
})

