import test from "node:test"
import assert from "node:assert/strict"
import {
  addAgreementDraft,
  approveAgreementVersion,
  createAgreement,
  resolveAgreementConflict,
  reviseAgreementDraft,
  submitAgreementVersion,
  withdrawAgreementVersion
} from "../miniprogram/core/agreements.ts"
import {
  appendApprovalEvent,
  createPaymentFact,
  createRefundFact,
  decidePaymentFact,
  decideRefundFact,
  financeSummary,
  type CostApprovalEvent,
  type PaymentFact,
  type RefundFact
} from "../miniprogram/core/finance.ts"
import {
  allocateReceipt,
  appendInventoryEvent,
  appendUsageRecord,
  correctReceiptQuantity,
  createReceiptBatch,
  inventoryBalanceMilli,
  receiptSummary,
  type MaterialInventoryEvent,
  type MaterialUsageRecord
} from "../miniprogram/core/material-flow.ts"
import {
  addIssueProposal,
  createIssueWorkflow,
  reopenIssueWorkflow,
  reviewIssueTreatment,
  selectIssueProposal,
  submitIssueTreatment
} from "../miniprogram/core/issue-flow.ts"
import {
  calculateProcurementEstimate,
  calculateResourceGap,
  createPurchaseLine,
  purchaseLineSummary,
  type UnitConversion
} from "../miniprogram/core/procurement.ts"
import {
  formatQuantityMilli,
  lineAmountFen,
  parseQuantityMilli,
  parseUnitPriceTenThousandthYuan
} from "../miniprogram/core/precision.ts"

const now = "2026-09-25T00:00:00.000Z"

test("数量和四位小数单价使用整数精度计算", () => {
  assert.equal(parseQuantityMilli("10.125"), 10_125)
  assert.equal(formatQuantityMilli(10_125), "10.125")
  assert.throws(() => parseQuantityMilli("1.0001"), /最多保留 3 位小数/)
  const price = parseUnitPriceTenThousandthYuan("10.005")
  assert.equal(lineAmountFen(parseQuantityMilli("1"), price), 1_001)
  assert.equal(lineAmountFen(parseQuantityMilli("3"), price), 3_002)
  assert.equal(1_001 + 3_002, 4_003)
})

test("约定版本送审、批准和替代均保留历史", () => {
  let aggregate = createAgreement({
    id: "agreement-1", versionId: "a-v1", projectId: "p1", subject: "material",
    subjectId: "m1", title: "瓷砖约定", terms: [{ key: "model", label: "型号", value: "A" }],
    actorId: "owner", now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v1", 1, now)
  aggregate = approveAgreementVersion(aggregate, "a-v1", 2, "owner", now)
  assert.equal(aggregate.agreement.activeVersionId, "a-v1")

  aggregate = addAgreementDraft(aggregate, {
    id: "a-v2", expectedVersion: 3,
    terms: [{ key: "model", label: "型号", value: "B" }],
    actorId: "family", now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v2", 4, now)
  aggregate = approveAgreementVersion(aggregate, "a-v2", 5, "owner", now)
  assert.equal(aggregate.versions.find(item => item.id === "a-v1")?.status, "superseded")
  assert.equal(aggregate.versions.find(item => item.id === "a-v2")?.status, "active")
  assert.equal(aggregate.versions.find(item => item.id === "a-v1")?.terms[0].value, "A")
})

test("并发约定草稿不能基于过期生效版本直接批准", () => {
  let aggregate = createAgreement({
    id: "agreement-1", versionId: "a-v1", projectId: "p1", subject: "material",
    title: "材料约定", terms: [{ key: "model", label: "型号", value: "A" }],
    actorId: "owner", now
  })
  aggregate = approveAgreementVersion(
    submitAgreementVersion(aggregate, "a-v1", 1, now), "a-v1", 2, "owner", now
  )
  aggregate = addAgreementDraft(aggregate, {
    id: "a-v2", expectedVersion: 3,
    terms: [{ key: "model", label: "型号", value: "B" }], actorId: "family", now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v2", 4, now)
  aggregate = addAgreementDraft(aggregate, {
    id: "a-v3", expectedVersion: 5,
    terms: [{ key: "model", label: "型号", value: "C" }], actorId: "family", now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v3", 6, now)
  aggregate = approveAgreementVersion(aggregate, "a-v2", 7, "owner", now)
  assert.throws(
    () => approveAgreementVersion(aggregate, "a-v3", 8, "owner", now),
    /生效约定已变化/
  )
})

test("来源冲突需人工选基线，送审后修改必须撤回并形成新版", () => {
  let aggregate = createAgreement({
    id: "agreement-conflict", versionId: "a-v1", projectId: "p1", subject: "material",
    title: "型号约定", terms: [{ key: "model", label: "型号", value: "待确认" }],
    sourceConflicts: [{
      id: "conflict-1", termKey: "model",
      alternatives: [
        { value: "A", sourceIds: ["contract"] },
        { value: "B", sourceIds: ["drawing"] }
      ]
    }],
    actorId: "family", now
  })
  assert.throws(() => submitAgreementVersion(aggregate, "a-v1", 1, now), /来源冲突未确认/)
  aggregate = resolveAgreementConflict(aggregate, {
    versionId: "a-v1", conflictId: "conflict-1", selectedValue: "B",
    reason: "负责人以最新图纸为本项目基线", expectedVersion: 1, actorId: "owner", now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v1", 2, now)
  assert.throws(() => reviseAgreementDraft(aggregate, {
    versionId: "a-v1", expectedVersion: 3,
    terms: [{ key: "model", label: "型号", value: "C" }], now
  }), /需先撤回/)
  aggregate = withdrawAgreementVersion(aggregate, "a-v1", 3, "family", now)
  aggregate = addAgreementDraft(aggregate, {
    id: "a-v2", expectedVersion: 4,
    terms: [{ key: "model", label: "型号", value: "C" }], actorId: "family", now
  })
  aggregate = reviseAgreementDraft(aggregate, {
    versionId: "a-v2", expectedVersion: 5,
    terms: [{ key: "model", label: "型号", value: "D" }],
    sourceIds: ["owner-note"], now
  })
  aggregate = submitAgreementVersion(aggregate, "a-v2", 6, now)
  assert.equal(aggregate.versions.find(item => item.id === "a-v1")?.status, "withdrawn")
  assert.equal(aggregate.versions.find(item => item.id === "a-v2")?.terms[0].value, "D")
  assert.throws(() => approveAgreementVersion(aggregate, "a-v1", 7, "owner", now), /待确认版本/)
})

test("到货数量先待核对，支持部分可用和待退货", () => {
  let batch = createReceiptBatch({
    id: "receipt-1", projectId: "p1", materialId: "m1", unit: "片", occurredAt: now,
    quantity: { id: "q1", requestId: "rq1", quantityMilli: 60_000, actorId: "family", createdAt: now }
  })
  assert.deepEqual(receiptSummary(batch), {
    receivedMilli: 60_000, acceptedAvailableMilli: 0, markedReturnMilli: 0,
    returnedSupplierMilli: 0, pendingReturnMilli: 0, unresolvedMilli: 60_000,
    status: "pending_review"
  })
  const accept = {
    id: "alloc-1", requestId: "ra1", expectedVersion: 1, kind: "accepted_available" as const,
    quantityMilli: 40_000, actorId: "owner", createdAt: now
  }
  batch = allocateReceipt(batch, accept)
  assert.strictEqual(allocateReceipt(batch, accept), batch)
  batch = allocateReceipt(batch, {
    id: "alloc-2", requestId: "ra2", expectedVersion: 2, kind: "marked_return",
    quantityMilli: 20_000, actorId: "owner", createdAt: now
  })
  assert.equal(receiptSummary(batch).status, "awaiting_return")
  assert.throws(() => allocateReceipt(batch, {
    id: "alloc-3", requestId: "ra3", expectedVersion: 3, kind: "accepted_available",
    quantityMilli: 1_000, actorId: "owner", createdAt: now
  }), /尚未分配/)
  batch = allocateReceipt(batch, {
    id: "return-1", requestId: "rr1", expectedVersion: 3, kind: "completed_return",
    quantityMilli: 20_000, actorId: "family", createdAt: now
  })
  assert.equal(receiptSummary(batch).status, "resolved")
  assert.throws(() => correctReceiptQuantity(batch, {
    id: "q2", requestId: "rq2", expectedVersion: 4, quantityMilli: 59_000,
    reason: "复点", actorId: "owner", createdAt: now
  }), /不能小于已处理数量/)
})

test("采购行按实到和实际退货派生待到货，并保留超收事实", () => {
  const line = createPurchaseLine({
    id: "line-1", projectId: "p1", materialId: "m1",
    orderedQuantityMilli: 100_000, unit: "片", createdAt: now
  })
  let first = createReceiptBatch({
    id: "receipt-1", projectId: "p1", purchaseLineId: "line-1",
    materialId: "m1", unit: "片", occurredAt: now,
    quantity: { id: "q1", requestId: "q-r1", quantityMilli: 60_000, actorId: "family", createdAt: now }
  })
  let summary = purchaseLineSummary(line, [first])
  assert.equal(summary.grossReceivedMilli, 60_000)
  assert.equal(summary.pendingReviewMilli, 60_000)
  assert.equal(summary.acceptedAvailableMilli, 0)
  assert.equal(summary.remainingToReceiveMilli, 40_000)

  first = allocateReceipt(first, {
    id: "mark-return", requestId: "mark-return-r", expectedVersion: 1,
    kind: "marked_return", quantityMilli: 60_000, actorId: "owner", createdAt: now
  })
  first = allocateReceipt(first, {
    id: "returned", requestId: "returned-r", expectedVersion: 2,
    kind: "completed_return", quantityMilli: 60_000, actorId: "family", createdAt: now
  })
  summary = purchaseLineSummary(line, [first])
  assert.equal(summary.grossReceivedMilli, 60_000)
  assert.equal(summary.returnedSupplierMilli, 60_000)
  assert.equal(summary.netReceivedMilli, 0)
  assert.equal(summary.remainingToReceiveMilli, 100_000)

  const over = createReceiptBatch({
    id: "receipt-over", projectId: "p1", purchaseLineId: "line-1",
    materialId: "m1", unit: "片", occurredAt: now,
    quantity: { id: "q2", requestId: "q-r2", quantityMilli: 110_000, actorId: "family", createdAt: now }
  })
  summary = purchaseLineSummary(line, [first, over])
  assert.equal(summary.netReceivedMilli, 110_000)
  assert.equal(summary.overReceivedMilli, 10_000)
  assert.equal(summary.status, "over_received")
})

test("跨单位采购汇总必须使用已确认且版本化的换算", () => {
  const line = createPurchaseLine({
    id: "line-1", projectId: "p1", materialId: "m1",
    orderedQuantityMilli: 100_000, unit: "片", createdAt: now
  })
  const batch = createReceiptBatch({
    id: "receipt-box", projectId: "p1", purchaseLineId: "line-1",
    materialId: "m1", unit: "箱", occurredAt: now,
    quantity: { id: "q1", requestId: "q-r1", quantityMilli: 6_000, actorId: "family", createdAt: now }
  })
  assert.throws(() => purchaseLineSummary(line, [batch]), /缺少已确认的单位换算/)
  const conversions: UnitConversion[] = [{
    id: "conversion-1", materialId: "m1", fromUnit: "箱", toUnit: "片",
    numerator: 10, denominator: 1, version: 1
  }]
  const summary = purchaseLineSummary(line, [batch], conversions)
  assert.equal(summary.grossReceivedMilli, 60_000)
  assert.equal(summary.remainingToReceiveMilli, 40_000)
})

test("整包估算区分损耗是否已含，缺价不伪造总额", () => {
  const estimate = calculateProcurementEstimate({
    requiredQuantityMilli: 10_000,
    wasteRatePermille: 100,
    requirementIncludesWaste: false,
    packageSizeMilli: 2_000,
    packageUnitPriceTenThousandthYuan: 1_000_000
  })
  assert.deepEqual(estimate, {
    quantityWithWasteMilli: 11_000,
    packageCount: 6,
    purchaseQuantityMilli: 12_000,
    amountFen: 60_000,
    amountComplete: true
  })
  const alreadyIncludesWaste = calculateProcurementEstimate({
    requiredQuantityMilli: 10_000,
    wasteRatePermille: 100,
    requirementIncludesWaste: true,
    packageSizeMilli: 2_000
  })
  assert.equal(alreadyIncludesWaste.packageCount, 5)
  assert.equal(alreadyIncludesWaste.amountComplete, false)
  assert.equal(alreadyIncludesWaste.amountFen, undefined)
})

test("资源缺口只扣一次已知覆盖，去向未知的领用显示范围", () => {
  assert.deepEqual(calculateResourceGap({
    totalRequirementMilli: 100_000,
    confirmedConsumedMilli: 20_000,
    availableInventoryMilli: 30_000,
    verifiableIssuedUnusedMilli: 10_000,
    validInTransitMilli: 15_000,
    issuedWhereaboutsUnknownMilli: 5_000
  }), {
    minimumGapMilli: 20_000,
    maximumGapMilli: 25_000,
    pendingVerificationMilli: 5_000
  })
})

test("问题预案唯一生效，替换、退回复查和重开均保留历史", () => {
  let issue = createIssueWorkflow({
    id: "issue-1", projectId: "p1", title: "瓷砖型号不一致",
    description: "现场标签与约定不同", createdBy: "family", now
  })
  issue = addIssueProposal(issue, {
    id: "proposal-a", content: "全部退回", expectedVersion: 1, submittedBy: "family", now
  })
  issue = addIssueProposal(issue, {
    id: "proposal-b", content: "确认费用后接受替换", expectedVersion: 2, submittedBy: "collaborator", now
  })
  issue = selectIssueProposal(issue, {
    proposalId: "proposal-a", expectedVersion: 3, actorId: "owner", now
  })
  assert.throws(() => selectIssueProposal(issue, {
    proposalId: "proposal-b", expectedVersion: 4, actorId: "owner", now
  }), /必须填写原因/)
  issue = selectIssueProposal(issue, {
    proposalId: "proposal-b", expectedVersion: 4,
    reason: "商家确认补差价且不影响工期", actorId: "owner", now
  })
  assert.equal(issue.proposals.filter(item => item.status === "active").length, 1)
  assert.equal(issue.proposals.find(item => item.id === "proposal-a")?.status, "superseded")
  assert.throws(() => submitIssueTreatment(issue, {
    id: "treatment-stale", expectedVersion: 4, note: "旧页面提交",
    submittedBy: "collaborator", now
  }), /数据已被更新/)

  issue = submitIssueTreatment(issue, {
    id: "treatment-1", expectedVersion: 5, note: "已更换并清点",
    evidenceSourceIds: ["record-after-1"], submittedBy: "collaborator", now
  })
  issue = reviewIssueTreatment(issue, {
    id: "review-return", treatmentId: "treatment-1", expectedVersion: 6,
    decision: "returned", note: "缺少包装批号近照", method: "evidence",
    actorId: "owner", now
  })
  assert.equal(issue.status, "pending_action")
  issue = submitIssueTreatment(issue, {
    id: "treatment-2", expectedVersion: 7, note: "已补拍批号",
    evidenceSourceIds: ["record-after-2"], submittedBy: "collaborator", now
  })
  assert.throws(() => reviewIssueTreatment(issue, {
    id: "review-invalid", treatmentId: "treatment-2", expectedVersion: 8,
    decision: "closed", note: "现场已复查", method: "on_site",
    actorId: "owner", now
  }), /必须选择关闭原因/)
  issue = reviewIssueTreatment(issue, {
    id: "review-close", treatmentId: "treatment-2", expectedVersion: 8,
    decision: "closed", closeReason: "resolved",
    note: "负责人现场核对型号和数量", method: "on_site",
    actorId: "owner", now
  })
  issue = reopenIssueWorkflow(issue, {
    id: "reopen-1", expectedVersion: 9,
    reason: "后续发现另一箱仍为旧型号", actorId: "owner", now
  })
  assert.equal(issue.status, "pending_action")
  assert.equal(issue.treatments.length, 2)
  assert.equal(issue.reviews.length, 2)
  assert.equal(issue.reopenings.length, 1)
})

test("重复事项关闭必须关联主事项", () => {
  let issue = createIssueWorkflow({
    id: "issue-duplicate", projectId: "p1", title: "重复渗水记录",
    description: "疑似和主事项重复", createdBy: "family", now
  })
  issue = addIssueProposal(issue, {
    id: "proposal", content: "核对主事项", expectedVersion: 1, submittedBy: "family", now
  })
  issue = selectIssueProposal(issue, {
    proposalId: "proposal", expectedVersion: 2, actorId: "owner", now
  })
  issue = submitIssueTreatment(issue, {
    id: "treatment", expectedVersion: 3, note: "已核对为同一位置",
    submittedBy: "family", now
  })
  assert.throws(() => reviewIssueTreatment(issue, {
    id: "review", treatmentId: "treatment", expectedVersion: 4,
    decision: "closed", closeReason: "duplicate",
    note: "确认重复", method: "on_site", actorId: "owner", now
  }), /必须关联主事项/)
})

test("库存、施工使用和现场退回不重复扣减", () => {
  let events: MaterialInventoryEvent[] = []
  let usages: MaterialUsageRecord[] = []
  const add = (input: MaterialInventoryEvent) => { events = appendInventoryEvent(events, usages, input) }
  const base = { projectId: "p1", materialId: "m1", unit: "片", actorId: "owner", createdAt: now }
  add({ ...base, id: "in", requestId: "in-r", action: "available_received",
    quantityMilli: 100_000, sourceReceiptAllocationId: "alloc-1" })
  add({ ...base, id: "issued", requestId: "issued-r", action: "issued", quantityMilli: 30_000 })
  usages = appendUsageRecord(events, usages, {
    ...base, id: "used", requestId: "used-r", issuedEventId: "issued", quantityMilli: 20_000
  })
  add({ ...base, id: "site-return", requestId: "site-return-r", action: "returned_site",
    quantityMilli: 5_000, sourceEventId: "issued" })
  add({ ...base, id: "supplier-return", requestId: "supplier-return-r",
    action: "returned_supplier", quantityMilli: 10_000 })
  add({ ...base, id: "waste", requestId: "waste-r", action: "warehouse_waste", quantityMilli: 2_000 })
  assert.equal(inventoryBalanceMilli(events, "m1"), 63_000)
  assert.throws(() => appendInventoryEvent(events, usages, {
    ...base, id: "too-much", requestId: "too-much-r", action: "returned_site",
    quantityMilli: 6_000, sourceEventId: "issued"
  }), /不能超过原领用数量/)
})

const approval = (
  id: string,
  requestId: string,
  action: CostApprovalEvent["action"],
  amountFen: number
): CostApprovalEvent => ({
  id, requestId, projectId: "p1", costItemId: "cost-1", action, amountFen,
  reason: "", actorId: "owner", createdAt: now
})

test("批准、付款和退款分别计算，超批准付款如实保留", () => {
  let approvals: CostApprovalEvent[] = []
  approvals = appendApprovalEvent(approvals, approval("a1", "ar1", "initial", 1_000_000))
  approvals = appendApprovalEvent(approvals, approval("a2", "ar2", "increase", 80_000))
  approvals = appendApprovalEvent(approvals, approval("a3", "ar3", "decrease", 20_000))
  assert.strictEqual(
    appendApprovalEvent(approvals, approval("duplicate", "ar3", "decrease", 20_000)),
    approvals
  )

  const pending = createPaymentFact({
    id: "pay-1", requestId: "pay-r1", projectId: "p1", costItemId: "cost-1",
    amountFen: 1_200_000, submittedBy: "family", occurredAt: now, createdAt: now
  })
  assert.deepEqual(financeSummary(approvals, [pending], []), {
    approvedFen: 1_060_000, paidFen: 0, refundedFen: 0, netPaidFen: 0,
    outstandingFen: 1_060_000, overApprovedFen: 0,
    pendingPaymentFen: 1_200_000, pendingRefundFen: 0
  })
  const payment = decidePaymentFact(pending, {
    decision: "confirmed", expectedVersion: 1, actorId: "owner", now
  })
  const summary = financeSummary(approvals, [payment], [])
  assert.equal(summary.netPaidFen, 1_200_000)
  assert.equal(summary.overApprovedFen, 140_000)
  assert.equal(summary.outstandingFen, 0)
  assert.throws(() => appendApprovalEvent(
    approvals, approval("too-low", "ar4", "decrease", 1_060_001)
  ), /小于 0/)
})

test("退款必须绑定已确认的原付款并保留确认状态", () => {
  const payment = decidePaymentFact(createPaymentFact({
    id: "pay-1", requestId: "pay-r1", projectId: "p1", costItemId: "cost-1",
    amountFen: 500_000, submittedBy: "family", occurredAt: now, createdAt: now
  }), { decision: "confirmed", expectedVersion: 1, actorId: "owner", now })
  const first = createRefundFact(payment, [], {
    id: "refund-1", requestId: "refund-r1", projectId: "p1", costItemId: "cost-1",
    paymentId: "pay-1", amountFen: 30_000, submittedBy: "family", occurredAt: now, createdAt: now
  })
  const confirmed = decideRefundFact(first, {
    decision: "confirmed", expectedVersion: 1, actorId: "owner", now
  })
  assert.equal(financeSummary([], [payment], [confirmed]).netPaidFen, 470_000)
  assert.throws(() => createRefundFact(payment, [confirmed], {
    id: "refund-2", requestId: "refund-r2", projectId: "p1", costItemId: "cost-1",
    paymentId: "pay-1", amountFen: 470_001, submittedBy: "family", occurredAt: now, createdAt: now
  }), /不能超过所关联付款/)
})
