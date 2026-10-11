import assert from "node:assert/strict"
import test from "node:test"
import type {
  BudgetResult,
  BudgetScenarioReview,
  ProjectSummaryHumanReview,
  ProjectSummaryResult,
  ProjectSummaryScope
} from "../miniprogram/core/ai-contract.ts"
import { buildAiSourcePlan } from "../miniprogram/core/ai-sources.ts"
import { calculateBudgetScenario } from "../miniprogram/core/budget.ts"
import type { MaterialInventoryEvent, MaterialUsageRecord } from "../miniprogram/core/material-flow.ts"
import {
  addLocalCostApproval,
  applyBudgetEstimate,
  applyProjectSummary,
  createCostItem,
  createIssue,
  createMaterial,
  createRecord,
  exportProjectBundle,
  loadState,
  restoreProjectBundle,
  saveState
} from "../miniprogram/core/store.ts"

const storage = new Map<string, unknown>()
Object.defineProperty(globalThis, "wx", {
  configurable: true,
  value: {
    getStorageSync<T>(key: string): T | undefined {
      return storage.get(key) as T | undefined
    },
    setStorageSync(key: string, value: unknown): void {
      storage.set(key, structuredClone(value))
    }
  }
})

function reviewedScenario(materialSourceId: string, price = "25"): BudgetScenarioReview {
  return {
    scenarioId: "scenario_1",
    included: true,
    label: "墙砖补货方案",
    materialSourceId,
    unit: "片",
    requiredQuantity: "100",
    wasteRatePercent: "10",
    requirementIncludesWaste: "no",
    packageSize: "10",
    packageUnitPriceYuan: price,
    note: "按十片一箱核算"
  }
}

function seedResourceFacts() {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({
    projectId: project.id,
    name: "墙砖",
    specification: "300×600",
    unit: "片",
    plannedQuantity: 100,
    wasteRatePermille: 100
  })
  const state = loadState()
  const inventoryEvents: MaterialInventoryEvent[] = [{
    id: "received_1", requestId: "received_request_1", projectId: project.id,
    materialId: material.id, unit: "片", action: "adjustment_increase",
    quantityMilli: 40_000, reason: "期初盘点", actorId: "owner", createdAt: "2026-09-27T01:00:00.000Z"
  }, {
    id: "issued_1", requestId: "issued_request_1", projectId: project.id,
    materialId: material.id, unit: "片", action: "issued",
    quantityMilli: 20_000, actorId: "owner", createdAt: "2026-09-27T02:00:00.000Z"
  }]
  const usages: MaterialUsageRecord[] = [{
    id: "usage_1", requestId: "usage_request_1", projectId: project.id,
    materialId: material.id, issuedEventId: "issued_1", quantityMilli: 15_000,
    actorId: "owner", createdAt: "2026-09-27T03:00:00.000Z"
  }]
  saveState({
    ...state,
    materialInventoryEvents: inventoryEvents,
    materialUsageRecords: usages,
    purchaseLines: [{
      id: "purchase_1", projectId: project.id, materialId: material.id,
      orderedQuantityMilli: 30_000, unit: "片", status: "ordered",
      createdAt: "2026-09-27T04:00:00.000Z"
    }]
  })
  return { project, material }
}

test("预算确定性计算先形成含损耗需求，再按已用、库存、在途和待核实领用计算缺口", () => {
  const { project, material } = seedResourceFacts()
  const result = calculateBudgetScenario(
    loadState(), project.id, reviewedScenario(material.id)
  )
  assert.equal(result.totalRequirement.quantityWithWasteMilli, 110_000)
  assert.equal(result.totalRequirement.packageCount, 11)
  assert.equal(result.totalRequirement.amountFen, 27_500)
  assert.deepEqual(result.resourceGap, {
    minimumGapMilli: 40_000,
    maximumGapMilli: 45_000,
    pendingVerificationMilli: 5_000
  })
  assert.equal(result.recommendedPurchase?.packageCount, 5)
  assert.equal(result.recommendedPurchase?.purchaseQuantityMilli, 50_000)
  assert.equal(result.recommendedPurchase?.amountFen, 12_500)
})

test("预算明确区分价格未知和价格为零，缺单位换算时不生成采购建议", () => {
  const { project, material } = seedResourceFacts()
  const unknownPrice = calculateBudgetScenario(
    loadState(), project.id, reviewedScenario(material.id, "")
  )
  assert.equal(unknownPrice.totalRequirement.amountFen, undefined)
  assert.equal(unknownPrice.recommendedPurchase?.amountFen, undefined)

  const zeroPrice = calculateBudgetScenario(
    loadState(), project.id, reviewedScenario(material.id, "0")
  )
  assert.equal(zeroPrice.totalRequirement.amountFen, 0)
  assert.equal(zeroPrice.recommendedPurchase?.amountFen, 0)

  const mismatchedUnit = calculateBudgetScenario(loadState(), project.id, {
    ...reviewedScenario(material.id), unit: "箱", packageSize: "1"
  })
  assert.equal(mismatchedUnit.resourceGap, undefined)
  assert.equal(mismatchedUnit.recommendedPurchase, undefined)
  assert.match(mismatchedUnit.resourceFacts?.warnings.join("；") || "", /缺少.*换算/)
})

test("负责人采纳预算只保存可追溯估算版本，并快照所选费用口径", () => {
  const { project, material } = seedResourceFacts()
  const cost = createCostItem({
    projectId: project.id,
    title: "墙砖采购",
    category: "material",
    materialId: material.id,
    quotedAmountFen: 30_000,
    note: "供应商初次报价"
  })
  addLocalCostApproval({
    costItemId: cost.id,
    action: "initial",
    amountFen: 25_000,
    reason: "负责人批准上限"
  })
  const state = loadState()
  const plan = buildAiSourcePlan(state, project, {})
  const selectedSources = plan.choices.filter(item =>
    item.id === material.id || item.id === cost.id)
  const snapshots = selectedSources.map(source => ({
    sourceId: source.id,
    kind: source.kind,
    version: source.version,
    authority: source.authority,
    relatedMaterialId: source.relatedMaterialId,
    relatedConsultationId: source.relatedConsultationId
  }))
  const originalResult: BudgetResult = {
    goal: "估算墙砖补货",
    scenarios: [{
      scenarioId: "scenario_1", label: "墙砖补货方案", materialSourceId: material.id,
      unit: "片",
      requiredQuantity: { value: "100", status: "observed", sourceIds: [material.id], note: "计划量" },
      wasteRatePercent: { value: "10", status: "observed", sourceIds: [material.id], note: "计划损耗" },
      requirementIncludesWaste: { value: "no", sourceIds: [material.id], note: "损耗单列" },
      packageSize: { value: "10", status: "assumption", sourceIds: [], note: "待负责人确认" },
      packageUnitPriceYuan: { value: "25", status: "observed", sourceIds: [cost.id], note: "所选报价" },
      assumptions: ["每箱 10 片"], conflicts: [], missingFields: []
    }],
    ledgerNotes: [{ text: "报价 300 元，批准上限 250 元，口径分别保留", sourceIds: [cost.id] }],
    gaps: []
  }
  const input = {
    projectId: project.id,
    aiJobId: "budget_job_1",
    model: "fake-model",
    promptVersion: "budget-1",
    contractVersion: "budget-contract-1",
    summary: "墙砖补货参数已由负责人确认",
    sourceSnapshots: snapshots,
    originalResult,
    review: { scenarios: [reviewedScenario(material.id)], note: "保存为第一次估算" }
  }
  const first = applyBudgetEstimate(input)
  assert.equal(first.scenarios.length, 1)
  assert.equal(first.financeSnapshots.length, 1)
  assert.equal(first.financeSnapshots[0].quotedAmountFen, 30_000)
  assert.equal(first.financeSnapshots[0].summary.approvedFen, 25_000)
  assert.equal(loadState().purchaseLines.length, 1)
  assert.equal(loadState().paymentFacts.length, 0)
  assert.equal(applyBudgetEstimate(input).id, first.id)
  assert.equal(loadState().budgetEstimateApplications.length, 1)

  const staleInput = { ...input, aiJobId: "budget_job_2" }
  const changed = loadState()
  saveState({
    ...changed,
    materialInventoryEvents: [...changed.materialInventoryEvents, {
      id: "inventory_new", requestId: "inventory_new_request", projectId: project.id,
      materialId: material.id, unit: "片", action: "adjustment_increase" as const,
      quantityMilli: 1_000, reason: "新盘点", actorId: "owner",
      createdAt: "2026-09-27T08:00:00.000Z"
    }]
  })
  assert.throws(() => applyBudgetEstimate(staleInput), /资料已变化/)

  const restoredProject = restoreProjectBundle(exportProjectBundle(project.id))
  const restoredState = loadState()
  const restoredApplication = restoredState.budgetEstimateApplications.find(item =>
    item.projectId === restoredProject.id)!
  const restoredScenario = restoredApplication.scenarios[0]
  const restoredCost = restoredState.costItems.find(item =>
    item.projectId === restoredProject.id && item.title === cost.title)!
  assert.ok(restoredApplication)
  assert.notEqual(restoredScenario.materialId, material.id)
  assert.equal(
    restoredApplication.originalResult.scenarios[0].materialSourceId,
    restoredScenario.materialId
  )
  assert.equal(
    restoredApplication.review.scenarios[0].materialSourceId,
    restoredScenario.materialId
  )
  assert.equal(
    restoredApplication.sourceSnapshots.find(item => item.kind === "material")?.sourceId,
    restoredScenario.materialId
  )
  assert.equal(restoredApplication.financeSnapshots[0].costItemId, restoredCost.id)
})

test("负责人采纳项目总结只保存报告版本，并随完整备份完成交接映射", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "厨房水电定位复核",
    note: "现场已拍照，仍待工长确认插座高度",
    room: "厨房",
    stage: "水电",
    creatorName: "家人",
    occurredAt: "2026-09-27T04:00:00.000Z",
    attachments: []
  })
  const issue = createIssue({
    projectId: project.id,
    title: "厨房插座高度待确认",
    description: "记录与现场口述存在差异",
    room: "厨房",
    stage: "水电",
    recordId: record.id,
    status: "pending_confirmation"
  })
  const cost = createCostItem({
    projectId: project.id,
    title: "水电增项",
    category: "labor",
    quotedAmountFen: 50_000,
    note: "仅为报价，尚未批准"
  })
  const plan = buildAiSourcePlan(loadState(), project, {})
  const selected = plan.choices.filter(item => [record.id, issue.id, cost.id].includes(item.id))
  const sourceSnapshots = selected.map(source => ({
    sourceId: source.id,
    kind: source.kind,
    version: source.version,
    authority: source.authority,
    relatedMaterialId: source.relatedMaterialId,
    relatedConsultationId: source.relatedConsultationId
  }))
  const scope: ProjectSummaryScope = {
    title: "厨房水电交接",
    purpose: "阶段复盘与交接",
    audience: "家人与工长",
    stage: "水电",
    room: "厨房",
    dateFrom: "2026-09-20",
    dateTo: "2026-09-28",
    cutoffAt: "2026-09-28T12:00:00.000Z"
  }
  const sectionKeys = ["progress", "issues", "materials", "finance", "consultations"] as const
  const originalResult: ProjectSummaryResult = {
    title: scope.title,
    scopeStatement: "仅覆盖厨房水电及所选资料，截止 2026-09-28 12:00 UTC。",
    sections: sectionKeys.map((key, index) => ({
      key,
      title: ["进展", "问题与整改", "材料与资源", "费用与款项", "咨询与协作"][index],
      items: key === "progress" ? [{
        itemId: "progress_1", text: "已保存厨房定位复核记录。",
        status: "in_progress", sourceIds: [record.id]
      }] : key === "issues" ? [{
        itemId: "issue_1", text: "插座高度仍待负责人确认。",
        status: "pending_confirmation", sourceIds: [issue.id]
      }] : key === "finance" ? [{
        itemId: "finance_1", text: "存在 500 元报价，尚未批准。",
        status: "pending_confirmation", sourceIds: [cost.id]
      }] : [],
      gaps: key === "materials" ? ["未选择材料资料"] : []
    })),
    handoff: [{
      itemId: "handoff_1", text: "确认插座高度后再更新问题状态。",
      status: "pending", sourceIds: [issue.id]
    }],
    overallGaps: ["没有材料与咨询资料"]
  }
  const review: ProjectSummaryHumanReview = {
    title: scope.title,
    scopeStatement: originalResult.scopeStatement,
    sections: originalResult.sections.map(section => ({
      key: section.key,
      included: true,
      title: section.title,
      content: section.items.map(item => item.text).join("\n") || section.gaps.join("\n") || "暂无所选事实"
    })),
    handoff: originalResult.handoff.map(item => ({
      itemId: item.itemId, included: true, text: item.text, status: item.status
    })),
    note: "负责人已核对范围"
  }
  const before = loadState()
  const input = {
    projectId: project.id,
    aiJobId: "summary_job_1",
    model: "fake-model",
    promptVersion: "project-summary-1",
    contractVersion: "project-summary-contract-1",
    summary: "厨房水电交接草稿",
    scope,
    sourceSnapshots,
    originalResult,
    review
  }
  const application = applyProjectSummary(input)
  const after = loadState()
  assert.equal(application.issueSnapshots[0].issueId, issue.id)
  assert.equal(application.issueSnapshots[0].status, "pending_confirmation")
  assert.equal(application.financeSnapshots[0].costItemId, cost.id)
  assert.equal(after.issueWorkflows.length, before.issueWorkflows.length)
  assert.equal(after.costApprovals.length, before.costApprovals.length)
  assert.equal(after.paymentFacts.length, before.paymentFacts.length)
  assert.equal(applyProjectSummary(input).id, application.id)

  const restoredProject = restoreProjectBundle(exportProjectBundle(project.id))
  const restored = loadState().projectSummaryApplications.find(item =>
    item.projectId === restoredProject.id)!
  assert.ok(restored)
  assert.notEqual(restored.sourceSnapshots.find(item => item.kind === "record")?.sourceId, record.id)
  assert.notEqual(restored.issueSnapshots[0].issueId, issue.id)
  assert.notEqual(restored.financeSnapshots[0].costItemId, cost.id)
  assert.equal(restored.originalResult.sections[0].items[0].sourceIds[0],
    restored.sourceSnapshots.find(item => item.kind === "record")?.sourceId)
})
