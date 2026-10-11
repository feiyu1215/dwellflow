import test from "node:test"
import assert from "node:assert/strict"
import {
  acceptProposal,
  advanceIssue,
  budgetSummary,
  inventoryBalance,
  materialEstimate,
  nextIssueStatus,
  reopenIssue,
  validateExpenseEvent,
  validateInventoryEntry,
  type ExpenseEvent,
  type InventoryEntry,
  type Issue
} from "../miniprogram/core/domain.ts"
import { KNOWLEDGE_CARDS, searchKnowledge } from "../miniprogram/core/knowledge.ts"
import { cameraReadiness } from "../miniprogram/core/camera.ts"
import type { CameraBinding } from "../miniprogram/core/domain.ts"

const issue: Issue = {
  id: "i1", projectId: "p1", title: "门框钉位待确认", description: "钉位接近边缘",
  room: "主卧", stage: "木工", status: "pending_confirmation", createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
  proposals: [
    { id: "a", authorName: "家人", authorRole: "family", content: "请木工现场复核", createdAt: "2026-09-24T00:01:00Z", decision: "pending" },
    { id: "b", authorName: "顾问", authorRole: "collaborator", content: "补拍侧面和尺度参照", createdAt: "2026-09-24T00:02:00Z", decision: "pending" }
  ]
}

test("问题按确认、处理、复查、关闭推进", () => {
  assert.equal(nextIssueStatus("pending_confirmation"), "pending_action")
  assert.equal(nextIssueStatus("pending_action"), "pending_review")
  assert.equal(nextIssueStatus("pending_review"), "closed")
  assert.equal(nextIssueStatus("closed"), "closed")
})

test("负责人未采纳预案时不能推进待确认事项", () => {
  assert.throws(() => advanceIssue(issue, "2026-09-24T01:00:00Z"), /采纳一个处理预案/)
})

test("负责人采纳一个预案后，其他待定预案标为未采纳", () => {
  const accepted = acceptProposal(issue, "b", "2026-09-24T01:00:00Z")
  assert.equal(accepted.proposals.find(item => item.id === "b")?.decision, "accepted")
  assert.equal(accepted.proposals.find(item => item.id === "a")?.decision, "rejected")
  assert.equal(advanceIssue(accepted, "2026-09-24T02:00:00Z").status, "pending_action")
  const changed = acceptProposal(accepted, "a", "2026-09-24T01:30:00Z")
  assert.equal(changed.proposals.filter(item => item.decision === "accepted").length, 1)
  assert.equal(changed.proposals.find(item => item.id === "a")?.decision, "accepted")
  assert.equal(changed.proposals.find(item => item.id === "b")?.decision, "rejected")
})

test("不存在的预案不能被采纳", () => {
  assert.throws(() => acceptProposal(issue, "missing", "2026-09-24T01:00:00Z"), /预案不存在/)
})

test("已关闭事项只能通过显式重新打开回到待处理", () => {
  const closed = { ...issue, status: "closed" as const }
  assert.throws(() => advanceIssue(closed, "2026-09-24T03:00:00Z"), /重新打开/)
  assert.equal(reopenIssue(closed, "2026-09-24T03:00:00Z").status, "pending_action")
})

const inventory: InventoryEntry[] = [
  { id: "in1", projectId: "p1", materialId: "m1", action: "received", quantity: 100, note: "", createdAt: "" },
  { id: "out1", projectId: "p1", materialId: "m1", action: "issued", quantity: 30, note: "", createdAt: "" },
  { id: "waste1", projectId: "p1", materialId: "m1", action: "waste", quantity: 8, note: "", createdAt: "" },
  { id: "return1", projectId: "p1", materialId: "m1", action: "returned_site", quantity: 1, note: "", createdAt: "" }
]

test("库存余额由不可变的出入库事件计算", () => {
  assert.equal(inventoryBalance(inventory, "m1"), 63)
})

test("材料估算保留数量、单价和损耗假设", () => {
  assert.deepEqual(materialEstimate({
    plannedQuantity: 100,
    unitPriceFen: 2_500,
    wasteRatePermille: 50
  }), { requiredQuantity: 105, amountFen: 262_500 })
})

test("库存不得因领用或损耗变成负数", () => {
  assert.deepEqual(
    validateInventoryEntry(inventory, { materialId: "m1", action: "issued", quantity: 64 }),
    { valid: false, reason: "本次操作会使库存小于 0，请先核对收货记录" }
  )
  assert.equal(validateInventoryEntry(inventory, { materialId: "m1", action: "issued", quantity: 63 }).valid, true)
})

const expenseBase = {
  projectId: "p1",
  category: "material" as const,
  note: "",
  createdAt: ""
}

const expenseEvents: ExpenseEvent[] = [
  { ...expenseBase, id: "e1", title: "主材报价", action: "quote", amountFen: 1_200_000 },
  { ...expenseBase, id: "e2", title: "首轮批准", action: "approve_increase", amountFen: 1_000_000 },
  { ...expenseBase, id: "e3", title: "批准增项", action: "approve_increase", amountFen: 80_000 },
  { ...expenseBase, id: "e4", title: "核减", action: "approve_decrease", amountFen: 20_000 },
  { ...expenseBase, id: "e5", title: "付款", action: "payment", amountFen: 500_000 },
  { ...expenseBase, id: "e6", title: "退款", action: "refund", amountFen: 30_000 }
]

test("预算、付款与退款分别汇总，不互相覆盖", () => {
  assert.deepEqual(budgetSummary(expenseEvents), {
    quotedFen: 1_200_000,
    approvedFen: 1_060_000,
    paidFen: 500_000,
    refundedFen: 30_000,
    netPaidFen: 470_000
  })
})

test("实际付款允许超过批准额，退款和批准核减仍受边界限制", () => {
  assert.equal(validateExpenseEvent(expenseEvents, { action: "payment", amountFen: 600_001 }).valid, true)
  assert.equal(validateExpenseEvent(expenseEvents, { action: "refund", amountFen: 470_001 }).valid, false)
  assert.equal(validateExpenseEvent(expenseEvents, { action: "approve_decrease", amountFen: 1_060_001 }).valid, false)
  assert.equal(validateExpenseEvent(expenseEvents, { action: "payment", amountFen: 590_000 }).valid, true)
})

test("知识卡可按工序和关键词做确定性检索", () => {
  const waterproof = searchKnowledge(KNOWLEDGE_CARDS, "管根 证据", "泥瓦")
  assert.equal(waterproof.length, 1)
  assert.equal(waterproof[0].id, "kc_waterproof_details")
  assert.equal(searchKnowledge(KNOWLEDGE_CARDS, "不存在的专业词").length, 0)
})

test("监控观看必须同时具备小程序、服务端、供应商和已授权设备", () => {
  const camera: CameraBinding = {
    id: "c1",
    projectId: "p1",
    provider: "ezviz_hosted",
    displayName: "客厅监控",
    room: "客厅",
    externalDeviceId: "device-1",
    status: "ready",
    createdAt: ""
  }
  assert.equal(cameraReadiness(camera).ready, false)
  assert.equal(cameraReadiness(camera).missing.length, 3)
  assert.equal(cameraReadiness(camera, {
    apiBaseUrl: "https://api.example.test",
    miniProgramAppId: "wx-test",
    providerEnabled: { ezviz_hosted: true }
  }).ready, true)
})
