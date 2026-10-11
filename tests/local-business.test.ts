import assert from "node:assert/strict"
import test from "node:test"
import { financeSummary } from "../miniprogram/core/finance.ts"
import { inventoryBalanceMilli, receiptSummary } from "../miniprogram/core/material-flow.ts"
import { purchaseLineSummary } from "../miniprogram/core/procurement.ts"
import { buildAiSourcePlan } from "../miniprogram/core/ai-sources.ts"
import {
  addLocalCostApproval,
  addLocalIssueProposal,
  addConsultationResponse,
  addProjectMember,
  allocateMaterialReceipt,
  applyConsultation,
  applyImageObservation,
  applyRecordReview,
  applyRectification,
  archiveProject,
  approveMaterialAgreement,
  closeConsultation,
  consultationPackage,
  convertConsultationResponseToProposal,
  createCameraBinding,
  createConsultation,
  createCostItem,
  createIssue,
  createMaterial,
  createMaterialAgreement,
  createMaterialPurchase,
  createMaterialReceipt,
  createRecord,
  createSpace,
  createSpaceRelation,
  createShareSnapshot,
  createEvidenceLink,
  decideLocalPayment,
  decideLocalRefund,
  decideMaterialReceiptFromCheck,
  dismissConsultationResponse,
  exportProjectBundle,
  loadState,
  mapLegacyRoomLabel,
  purgeExpiredProjects,
  publishConsultation,
  reopenLocalIssue,
  reopenProject,
  restoreTrashedProject,
  restoreProjectBundle,
  registerLocalEvidence,
  reviseConsultation,
  reviewLocalIssueTreatment,
  selectLocalIssueProposal,
  saveMaterialCheckRecord,
  saveManualMaterialCheckRecord,
  saveState,
  sharePackage,
  submitLocalPayment,
  submitLocalRefund,
  submitLocalIssueTreatment,
  submitMaterialAgreement,
  setSpaceStageStatus,
  trashProject,
  updateRecord
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

test("本地展示完整走通约定、采购、到货核对、入库和退货", () => {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({
    projectId: project.id,
    name: "卫生间墙砖",
    specification: "型号 A",
    unit: "片",
    plannedQuantity: 100
  })

  let agreement = createMaterialAgreement({
    projectId: project.id,
    materialId: material.id,
    title: "墙砖采购约定",
    terms: [
      { key: "model", label: "型号", value: "A" },
      { key: "quantity", label: "数量", value: "100 片" }
    ],
    sourceLabel: "合同第 3 页"
  })
  const versionId = agreement.versions[0].id
  agreement = submitMaterialAgreement(agreement.agreement.id, versionId)
  assert.equal(agreement.versions[0].status, "pending_confirmation")
  agreement = approveMaterialAgreement(agreement.agreement.id, versionId)
  assert.equal(agreement.agreement.activeVersionId, versionId)

  const purchase = createMaterialPurchase({
    projectId: project.id,
    materialId: material.id,
    quantity: "100"
  })
  assert.equal(purchase.agreementVersionId, versionId)

  let receipt = createMaterialReceipt({
    projectId: project.id,
    purchaseLineId: purchase.id,
    quantity: "60"
  })
  assert.equal(receiptSummary(receipt).unresolvedMilli, 60_000)
  assert.equal(inventoryBalanceMilli(loadState().materialInventoryEvents, material.id), 0)

  receipt = allocateMaterialReceipt({
    batchId: receipt.id,
    kind: "accepted_available",
    quantity: "40"
  })
  receipt = allocateMaterialReceipt({
    batchId: receipt.id,
    kind: "marked_return",
    quantity: "20"
  })
  assert.deepEqual(receiptSummary(receipt), {
    receivedMilli: 60_000,
    acceptedAvailableMilli: 40_000,
    markedReturnMilli: 20_000,
    returnedSupplierMilli: 0,
    pendingReturnMilli: 20_000,
    unresolvedMilli: 0,
    status: "awaiting_return"
  })
  assert.equal(
    inventoryBalanceMilli(loadState().materialInventoryEvents, material.id),
    40_000
  )

  receipt = allocateMaterialReceipt({
    batchId: receipt.id,
    kind: "completed_return",
    quantity: "20"
  })
  assert.equal(receiptSummary(receipt).status, "resolved")
  const state = loadState()
  assert.deepEqual(
    purchaseLineSummary(purchase, state.receiptBatches, state.unitConversions),
    {
      grossReceivedMilli: 60_000,
      returnedSupplierMilli: 20_000,
      netReceivedMilli: 40_000,
      pendingReviewMilli: 0,
      pendingReturnMilli: 0,
      acceptedAvailableMilli: 40_000,
      remainingToReceiveMilli: 60_000,
      overReceivedMilli: 0,
      unknownQuantityBatchCount: 0,
      status: "partial"
    }
  )
})

test("AI 材料核对写回独立记录且不产生库存事件", () => {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({
    projectId: project.id,
    name: "电线",
    specification: "2.5 平方",
    unit: "卷",
    plannedQuantity: 10
  })
  const purchase = createMaterialPurchase({
    projectId: project.id,
    materialId: material.id,
    quantity: "10"
  })
  const receipt = createMaterialReceipt({
    projectId: project.id,
    purchaseLineId: purchase.id,
    quantity: "9"
  })
  const originalResult = {
    materialSourceId: material.id,
    receiptSourceId: receipt.id,
    fields: [
      { key: "brand" as const, label: "品牌", observedValue: "", expectedValue: "", status: "unknown" as const, observedSourceIds: [], expectedSourceIds: [], note: "图片不清晰" },
      { key: "model" as const, label: "型号", observedValue: "", expectedValue: "", status: "unknown" as const, observedSourceIds: [], expectedSourceIds: [], note: "图片不清晰" },
      { key: "specification" as const, label: "规格", observedValue: "2.5 平方", expectedValue: "", status: "observed_only" as const, observedSourceIds: [material.id], expectedSourceIds: [], note: "" },
      { key: "quantity" as const, label: "数量", observedValue: "9 卷", expectedValue: "", status: "observed_only" as const, observedSourceIds: [receipt.id], expectedSourceIds: [], note: "" }
    ]
  }
  const review = {
    fields: originalResult.fields.map(field => ({
      key: field.key,
      observedValue: field.observedValue,
      expectedValue: field.expectedValue,
      status: field.status,
      note: field.note
    }))
  }
  const currentSources = buildAiSourcePlan(loadState(), project, {}).choices
  const sourceSnapshots = [material.id, receipt.id].map(sourceId => {
    const source = currentSources.find(item => item.id === sourceId)!
    return {
      sourceId: source.id,
      kind: source.kind,
      version: source.version,
      authority: source.authority,
      relatedMaterialId: source.relatedMaterialId
    }
  })
  const record = saveMaterialCheckRecord({
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    aiJobId: "ai_job_material_1",
    model: "fake-vision",
    promptVersion: "test-1",
    summary: "数量为 9 卷，品牌型号仍需补拍",
    sourceSnapshots,
    originalResult,
    review
  })
  const replay = saveMaterialCheckRecord({
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    aiJobId: "ai_job_material_1",
    model: "fake-vision",
    promptVersion: "test-1",
    summary: "数量为 9 卷，品牌型号仍需补拍",
    sourceSnapshots,
    originalResult,
    review
  })
  assert.equal(replay.id, record.id)
  assert.equal(loadState().materialChecks.length, 1)
  assert.equal(loadState().materialInventoryEvents.length, 0)
  assert.equal(receiptSummary(loadState().receiptBatches[0]).unresolvedMilli, 9_000)

  const restored = restoreProjectBundle(exportProjectBundle(project.id))
  const restoredCheck = loadState().materialChecks.find(item => item.projectId === restored.id)!
  assert.ok(restoredCheck)
  assert.notEqual(restoredCheck.materialId, material.id)
  assert.equal(restoredCheck.originalResult.materialSourceId, restoredCheck.materialId)
  assert.equal(restoredCheck.originalResult.receiptSourceId, restoredCheck.receiptBatchId)
  assert.equal(restoredCheck.sourceSnapshots?.find(item => item.kind === "material")?.sourceId, restoredCheck.materialId)
  assert.equal(restoredCheck.sourceSnapshots?.find(item => item.kind === "receipt")?.sourceId, restoredCheck.receiptBatchId)
})

test("R8-3A/3B 人工核对独立保存，负责人再据当前版本决定入库", () => {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({ projectId: project.id, name: "电线", specification: "BV 2.5", unit: "卷", plannedQuantity: 8 })
  let agreement = createMaterialAgreement({
    projectId: project.id, materialId: material.id, title: "电线约定",
    terms: [
      { key: "brand", label: "品牌", value: "远东" },
      { key: "model", label: "型号", value: "BV" },
      { key: "specification", label: "规格", value: "2.5mm²" },
      { key: "quantity", label: "数量", value: "8 卷" }
    ], sourceLabel: "合同"
  })
  const versionId = agreement.versions[0].id
  agreement = submitMaterialAgreement(agreement.agreement.id, versionId)
  approveMaterialAgreement(agreement.agreement.id, versionId)
  const purchase = createMaterialPurchase({ projectId: project.id, materialId: material.id, quantity: "8" })
  const receipt = createMaterialReceipt({ projectId: project.id, purchaseLineId: purchase.id, quantity: "6" })
  const before = loadState()
  const beforeReceipt = receiptSummary(receipt)
  const check = saveManualMaterialCheckRecord({
    requestId: "manual-check-1",
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    agreementVersionId: versionId,
    summary: "数量少 2 卷",
    fields: [
      { key: "brand", observedValue: "远东", expectedValue: "远东", status: "matches", note: "" },
      { key: "model", observedValue: "BV", expectedValue: "BV", status: "matches", note: "" },
      { key: "specification", observedValue: "2.5mm²", expectedValue: "2.5mm²", status: "matches", note: "" },
      { key: "quantity", observedValue: "6 卷", expectedValue: "8 卷", status: "differs", note: "现场清点" }
    ]
  })
  const after = loadState()
  assert.equal(check.method, "manual")
  assert.equal(check.model, "人工录入")
  const duplicate = saveManualMaterialCheckRecord({
    requestId: "manual-check-1", projectId: project.id, materialId: material.id,
    receiptBatchId: receipt.id, agreementVersionId: versionId, summary: "重复点击",
    fields: check.review.fields
  })
  assert.equal(duplicate.id, check.id)
  assert.equal(after.materialInventoryEvents.length, before.materialInventoryEvents.length)
  assert.deepEqual(receiptSummary(after.receiptBatches.find(item => item.id === receipt.id)!), beforeReceipt)
  decideMaterialReceiptFromCheck({
    batchId: receipt.id, checkId: check.id, kind: "accepted_available", quantity: "4"
  })
  const decided = loadState()
  assert.equal(inventoryBalanceMilli(decided.materialInventoryEvents, material.id), 4000)
  assert.equal(decided.materialChecks.find(item => item.id === check.id)?.summary, "数量少 2 卷")
  assert.throws(() => decideMaterialReceiptFromCheck({
    batchId: receipt.id, checkId: check.id, kind: "marked_return", quantity: "1"
  }), /到货批次在核对后已变化/)
})

test("AI 材料核对在到货来源版本变化后要求重新分析", () => {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({
    projectId: project.id,
    name: "水管",
    specification: "20mm",
    unit: "根",
    plannedQuantity: 20
  })
  const purchase = createMaterialPurchase({
    projectId: project.id,
    materialId: material.id,
    quantity: "20"
  })
  const receipt = createMaterialReceipt({
    projectId: project.id,
    purchaseLineId: purchase.id,
    quantity: "10"
  })
  const sourceSnapshots = [
    {
      sourceId: material.id, kind: "material" as const, version: material.createdAt,
      authority: "project_fact" as const
    },
    {
      sourceId: receipt.id, kind: "receipt" as const, version: String(receipt.version),
      authority: "project_fact" as const, relatedMaterialId: material.id
    }
  ]
  const originalResult = {
    materialSourceId: material.id,
    receiptSourceId: receipt.id,
    fields: [
      { key: "brand" as const, label: "品牌", observedValue: "", expectedValue: "", status: "unknown" as const, observedSourceIds: [], expectedSourceIds: [], note: "未提供" },
      { key: "model" as const, label: "型号", observedValue: "", expectedValue: "", status: "unknown" as const, observedSourceIds: [], expectedSourceIds: [], note: "未提供" },
      { key: "specification" as const, label: "规格", observedValue: "20mm", expectedValue: "", status: "observed_only" as const, observedSourceIds: [material.id], expectedSourceIds: [], note: "" },
      { key: "quantity" as const, label: "数量", observedValue: "10 根", expectedValue: "", status: "observed_only" as const, observedSourceIds: [receipt.id], expectedSourceIds: [], note: "" }
    ]
  }
  const review = {
    fields: originalResult.fields.map(field => ({
      key: field.key,
      observedValue: field.observedValue,
      expectedValue: field.expectedValue,
      status: field.status,
      note: field.note
    }))
  }

  allocateMaterialReceipt({ batchId: receipt.id, kind: "marked_return", quantity: "1" })
  assert.throws(() => saveMaterialCheckRecord({
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    aiJobId: "ai_job_stale_material",
    model: "fake-vision",
    promptVersion: "test-1",
    summary: "旧批次快照",
    sourceSnapshots,
    originalResult,
    review
  }), /资料已变化/)
  assert.equal(loadState().materialChecks.length, 0)
})

test("AI 记录整理经人工复核后生成新版本且重复写回幂等", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "厨房现场",
    note: "今天又改了这个",
    room: "厨房",
    stage: "水电",
    creatorName: project.ownerName,
    occurredAt: "2026-09-27T04:00:00.000Z",
    attachments: [{
      id: "image_record_review",
      name: "厨房.jpg",
      type: "image",
      localPath: "wxfile://kitchen.jpg"
    }]
  })
  const originalResult = {
    title: "厨房水电位置调整",
    facts: [{
      text: "用户记录厨房位置发生调整",
      evidenceKind: "user_statement" as const,
      sourceIds: [record.id],
      roomCandidate: "厨房",
      stageCandidate: "水电"
    }],
    time: {
      originalExpression: "今天",
      candidateDate: "2026-09-27",
      sourceIds: [record.id],
      note: "按记录日期解释"
    },
    opinions: [],
    gaps: ["具体调整位置待补"]
  }
  const review = {
    title: "厨房水电位置调整",
    room: "厨房",
    stage: "水电",
    occurredAt: "2026-09-27T04:00:00.000Z",
    note: "待补一张远景照片",
    facts: [{ sourceIndex: 0, included: true, text: "厨房水电位置已经调整" }],
    opinions: []
  }
  const input = {
    projectId: project.id,
    aiJobId: "ai_record_review_1",
    model: "fake-model",
    promptVersion: "record-review-test-1",
    contractVersion: "record-review-contract-1",
    summary: "整理一条现场事实",
    sourceSnapshots: [{
      sourceId: record.id,
      kind: "record" as const,
      version: String(record.version),
      authority: "project_fact" as const
    }],
    imageRefs: [{ id: "image_record_review", sourceId: record.id }],
    originalResult,
    review,
    target: { recordId: record.id, expectedVersion: record.version }
  }
  const applied = applyRecordReview(input)
  assert.equal(applied.record.version, 2)
  assert.match(applied.record.note, /厨房水电位置已经调整/)
  assert.equal(loadState().recordReviewApplications.length, 1)
  const replay = applyRecordReview(input)
  assert.equal(replay.record.version, 2)
  assert.equal(loadState().records.find(item => item.id === record.id)?.version, 2)

  const restored = restoreProjectBundle(exportProjectBundle(project.id))
  const restoredApplication = loadState().recordReviewApplications
    .find(item => item.projectId === restored.id)!
  assert.ok(restoredApplication)
  assert.notEqual(restoredApplication.targetRecordId, record.id)
  assert.equal(restoredApplication.imageRefs[0].sourceId, restoredApplication.targetRecordId)
})

test("AI 图片观察只按人工选择创建待确认问题且重复写回幂等", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "墙面近照",
    note: "发现一条细线",
    room: "客厅",
    stage: "油漆",
    creatorName: project.ownerName,
    occurredAt: "2026-09-27T04:00:00.000Z",
    attachments: [{
      id: "image_wall_line",
      name: "墙面.jpg",
      type: "image",
      localPath: "wxfile://wall.jpg"
    }]
  })
  const originalResult = {
    images: [{
      imageId: "image_wall_line",
      sourceId: record.id,
      visibleScope: "墙面局部",
      qualityLimitations: ["没有尺度参照"]
    }],
    items: [{
      itemId: "wall_line_1",
      imageId: "image_wall_line",
      sourceId: record.id,
      object: "墙面",
      observation: "可见一条细线状痕迹",
      region: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
      suspectedExplanation: "成因待现场核实",
      limitations: ["单张近照无法判断深度"],
      captureSuggestions: ["补拍带尺度的远近景"],
      priority: "high" as const,
      priorityReason: "需要在后续覆盖前留证",
      knowledgeIds: []
    }]
  }
  const review = {
    items: [{
      itemId: "wall_line_1",
      disposition: "issue" as const,
      observation: "墙面有一条需要核实的细线状痕迹",
      suspectedExplanation: "成因待现场核实",
      limitations: ["单张近照无法判断深度"],
      captureSuggestions: ["补拍带尺度的远近景"],
      priority: "high" as const,
      priorityReason: "需要在后续覆盖前留证",
      issueTitle: "客厅墙面线状痕迹待确认"
    }]
  }
  const input = {
    projectId: project.id,
    aiJobId: "ai_image_observation_1",
    model: "fake-model",
    promptVersion: "image-observation-test-1",
    contractVersion: "image-observation-contract-1",
    summary: "发现一条待核实痕迹",
    sourceSnapshots: [{
      sourceId: record.id,
      kind: "record" as const,
      version: String(record.version),
      authority: "project_fact" as const
    }],
    imageRefs: [{ id: "image_wall_line", sourceId: record.id }],
    originalResult,
    review
  }
  const application = applyImageObservation(input)
  assert.equal(application.issueLinks.length, 1)
  const issue = loadState().issues.find(item =>
    item.id === application.issueLinks[0].issueId)!
  assert.equal(issue.status, "pending_confirmation")
  assert.equal(issue.recordId, record.id)
  assert.match(issue.description, /待现场核实/)
  const replay = applyImageObservation(input)
  assert.equal(replay.id, application.id)
  assert.equal(loadState().issues.length, 1)

  const restored = restoreProjectBundle(exportProjectBundle(project.id))
  const restoredApplication = loadState().imageObservationApplications
    .find(item => item.projectId === restored.id)!
  assert.ok(restoredApplication)
  assert.notEqual(restoredApplication.issueLinks[0].issueId, issue.id)
  assert.equal(
    loadState().issues.some(item => item.id === restoredApplication.issueLinks[0].issueId),
    true
  )
})

test("AI 整改辅助只新增待选预案或保存复查参考且重复写回幂等", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "墙面处理照片",
    note: "客厅墙面有裂纹状线条",
    room: "客厅",
    stage: "油漆",
    creatorName: project.ownerName,
    occurredAt: "2026-09-27T02:00:00.000Z",
    attachments: []
  })
  const issue = createIssue({
    projectId: project.id,
    title: "墙面裂纹待处理",
    description: "需要确认处理方向",
    room: "客厅",
    stage: "油漆",
    recordId: record.id,
    status: "pending_confirmation"
  })
  let state = loadState()
  let workflow = state.issueWorkflows.find(item => item.id === issue.id)!
  const issueVersion = `${state.issues.find(item => item.id === issue.id)!.updatedAt}:${workflow.version}`
  const proposalInput = {
    projectId: project.id,
    aiJobId: "ai-rectification-proposal",
    model: "test-model",
    promptVersion: "rectification-proposal-test",
    contractVersion: "rectification-proposal-contract-1",
    summary: "形成一个待选处理方向",
    sourceSnapshots: [{
      sourceId: issue.id, kind: "issue" as const, version: issueVersion,
      authority: "project_fact" as const
    }],
    imageRefs: [],
    originalResult: {
      mode: "proposal" as const,
      issueSourceId: issue.id,
      issueSummary: "墙面裂纹状线条待核实",
      premises: ["原因未知"],
      gaps: ["缺少近景"],
      proposals: [{
        optionId: "option1", title: "补证后确定处理范围",
        actions: ["补拍近景并请施工方现场查看"],
        applicability: ["位置仍可复查"], impacts: ["暂不判断成因"],
        costAndSchedule: "待询价/待确认", verificationEvidence: ["同位置近景"],
        sourceIds: [issue.id], knowledgeIds: []
      }]
    },
    review: {
      mode: "proposal" as const,
      items: [{
        optionId: "option1", included: true, title: "补证后确定处理范围",
        content: "先补拍同位置近景，再由施工方现场查看并给出处理范围。"
      }],
      note: ""
    },
    target: { issueId: issue.id, expectedVersion: workflow.version }
  }
  const first = applyRectification(proposalInput)
  const replay = applyRectification(proposalInput)
  assert.equal(replay.id, first.id)
  state = loadState()
  workflow = state.issueWorkflows.find(item => item.id === issue.id)!
  assert.equal(workflow.status, "pending_confirmation")
  assert.equal(workflow.proposals.length, 1)
  assert.equal(workflow.proposals[0].status, "pending")
  assert.equal(first.proposalLinks.length, 1)

  selectLocalIssueProposal(issue.id, workflow.proposals[0].id)
  submitLocalIssueTreatment({ issueId: issue.id, note: "已按现场确认范围处理" })
  state = loadState()
  workflow = state.issueWorkflows.find(item => item.id === issue.id)!
  const currentIssue = state.issues.find(item => item.id === issue.id)!
  const reviewInput = {
    projectId: project.id,
    aiJobId: "ai-rectification-review",
    model: "test-model",
    promptVersion: "rectification-review-test",
    contractVersion: "rectification-review-contract-1",
    summary: "保存复查参考，不提交复查决定",
    sourceSnapshots: [{
      sourceId: issue.id, kind: "issue" as const,
      version: `${currentIssue.updatedAt}:${workflow.version}`,
      authority: "project_fact" as const
    }],
    imageRefs: [],
    originalResult: {
      mode: "review" as const,
      issueSourceId: issue.id,
      treatmentId: workflow.treatments.at(-1)!.id,
      evidenceRelation: "uncertain" as const,
      checks: [{
        checkId: "check1", requirement: "确认同一位置处理前后变化",
        beforeSourceIds: [issue.id], afterSourceIds: [issue.id],
        status: "not_verifiable" as const,
        observation: "现有资料不能确认是否为同一位置",
        limitations: ["缺少同角度前后图"], nextSteps: ["补拍同角度照片"], knowledgeIds: []
      }],
      gaps: ["前后对应关系待确认"]
    },
    review: {
      mode: "review" as const,
      items: [{
        checkId: "check1", included: true, requirement: "确认同一位置处理前后变化",
        status: "not_verifiable" as const, observation: "现有资料不能确认是否为同一位置",
        limitations: ["缺少同角度前后图"], nextSteps: ["补拍同角度照片"]
      }],
      note: "仅保存参考"
    },
    target: { issueId: issue.id, expectedVersion: workflow.version }
  }
  const reviewApplication = applyRectification(reviewInput)
  assert.equal(reviewApplication.proposalLinks.length, 0)
  assert.equal(loadState().issueWorkflows.find(item => item.id === issue.id)!.status, "pending_review")
  assert.equal(loadState().issueWorkflows.find(item => item.id === issue.id)!.reviews.length, 0)
})

test("AI 咨询准备只建未发布草稿，回复整理仅把人工指定条目转待选预案", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id, title: "墙砖记录", note: "东墙敲击声异常",
    room: "卫生间", stage: "泥瓦", creatorName: project.ownerName,
    occurredAt: "2026-09-27T03:00:00.000Z", attachments: []
  })
  const issue = createIssue({
    projectId: project.id, title: "墙砖处理待确认", description: "需要咨询处理方式",
    room: "卫生间", stage: "泥瓦", recordId: record.id, status: "pending_confirmation"
  })
  let state = loadState()
  const currentIssue = state.issues.find(item => item.id === issue.id)!
  const workflow = state.issueWorkflows.find(item => item.id === issue.id)!
  const prepareInput = {
    projectId: project.id,
    aiJobId: "ai-consultation-prepare",
    model: "test-model",
    promptVersion: "consultation-prepare-test",
    contractVersion: "consultation-prepare-contract-1",
    summary: "生成咨询草稿",
    sourceSnapshots: [
      { sourceId: record.id, kind: "record" as const, version: String(record.version), authority: "project_fact" as const },
      { sourceId: issue.id, kind: "issue" as const, version: `${currentIssue.updatedAt}:${workflow.version}`, authority: "project_fact" as const }
    ],
    imageRefs: [],
    originalResult: {
      mode: "prepare" as const,
      title: "墙砖异常咨询", purpose: "确认如何复核及何时需要返工", summary: "东墙有异常敲击声",
      facts: [{ text: "东墙敲击声异常", sourceIds: [record.id] }],
      timeline: [], disputes: [], gaps: ["范围未知"],
      questions: [{
        questionId: "question1", text: "建议怎样复核？", rationale: "范围未知",
        expectedAnswer: "请给出复核步骤和所需证据", sourceIds: [issue.id]
      }]
    },
    review: {
      mode: "prepare" as const,
      title: "墙砖异常咨询", purpose: "确认如何复核及何时需要返工",
      facts: [{ sourceIndex: 0, included: true, text: "东墙敲击声异常" }],
      timeline: [], disputes: [], gaps: ["范围未知"],
      questions: [{ sourceIndex: 0, included: true, text: "建议怎样复核？" }], note: ""
    }
  }
  const prepared = applyConsultation(prepareInput)
  const replayed = applyConsultation(prepareInput)
  assert.equal(replayed.application.id, prepared.application.id)
  assert.equal(prepared.consultation?.status, "draft")
  assert.equal(prepared.consultation?.activeVersionId, undefined)
  assert.equal(loadState().consultations.length, 1)

  const published = publishConsultation(prepared.consultation!.id, prepared.consultation!.version)
  const response = addConsultationResponse({
    consultationId: published.id, source: "manual_relay", respondentName: "瓦工",
    channel: "微信", recordedBy: project.ownerName,
    receivedAt: "2026-09-27T04:00:00.000Z", originalText: "先确认范围，再决定返工。",
    targetIssueId: issue.id
  })
  state = loadState()
  const responseIssue = state.issues.find(item => item.id === issue.id)!
  const responseWorkflow = state.issueWorkflows.find(item => item.id === issue.id)!
  const responseConsultation = state.consultations.find(item => item.id === published.id)!
  const responseInput = {
    projectId: project.id,
    aiJobId: "ai-consultation-response",
    model: "test-model",
    promptVersion: "consultation-response-test",
    contractVersion: "consultation-response-contract-1",
    summary: "整理咨询回复",
    sourceSnapshots: [
      { sourceId: published.id, kind: "consultation" as const, version: String(responseConsultation.version), authority: "project_fact" as const },
      { sourceId: response.id, kind: "consultation_response" as const, version: `${response.createdAt}:${response.status}:${response.decidedAt || ""}`, authority: "project_fact" as const, relatedConsultationId: published.id },
      { sourceId: issue.id, kind: "issue" as const, version: `${responseIssue.updatedAt}:${responseWorkflow.version}`, authority: "project_fact" as const }
    ],
    imageRefs: [],
    originalResult: {
      mode: "response" as const,
      consultationSourceId: published.id,
      mappings: [{
        mappingId: "mapping1", question: "建议怎样复核？", status: "partial" as const,
        responseSourceIds: [response.id], summary: "先确认范围再决定返工",
        conditions: [], conflicts: [], followUps: ["如何确认范围？"], targetIssueSourceId: issue.id
      }],
      gaps: ["缺少具体复核步骤"]
    },
    review: {
      mode: "response" as const,
      mappings: [{
        mappingId: "mapping1", disposition: "proposal" as const, status: "partial" as const,
        summary: "先确认范围再决定返工", conditions: [], conflicts: [], followUps: ["如何确认范围？"],
        targetIssueSourceId: issue.id, proposalContent: "先现场确认异常范围，再决定是否返工。"
      }],
      note: ""
    },
    target: { consultationId: published.id, expectedVersion: responseConsultation.version }
  }
  const applied = applyConsultation(responseInput)
  assert.equal(applied.application.proposalLinks.length, 1)
  assert.equal(loadState().issueWorkflows.find(item => item.id === issue.id)!.proposals.length, 1)
  assert.equal(loadState().issueWorkflows.find(item => item.id === issue.id)!.proposals[0].status, "pending")
  const convertedResponse = loadState().consultationResponses.find(item => item.id === response.id)!
  assert.equal(convertedResponse.status, "converted_to_proposal")
  assert.equal(convertedResponse.proposalId, applied.application.proposalLinks[0].proposalId)
  assert.deepEqual(applied.application.proposalLinks[0].responseIds, [response.id])
  assert.equal(applyConsultation(responseInput).application.id, applied.application.id)

  const restored = restoreProjectBundle(exportProjectBundle(project.id))
  state = loadState()
  assert.equal(state.rectificationApplications.filter(item => item.projectId === restored.id).length, 0)
  assert.equal(state.consultationApplications.filter(item => item.projectId === restored.id).length, 2)
  const restoredResponseApplication = state.consultationApplications.find(item =>
    item.projectId === restored.id && item.mode === "response")!
  assert.equal(restoredResponseApplication.proposalLinks.length, 1)
  assert.equal(restoredResponseApplication.proposalLinks[0].responseIds.length, 1)
  assert.ok(state.consultationResponses.some(item =>
    item.projectId === restored.id
    && item.id === restoredResponseApplication.proposalLinks[0].responseIds[0]
    && item.status === "converted_to_proposal"))
  assert.ok(state.issueWorkflows.some(item =>
    item.projectId === restored.id
    && item.proposals.some(proposal => proposal.id === restoredResponseApplication.proposalLinks[0].proposalId)))
})

test("本地展示不能把超过实到数量的部分确认为可用", () => {
  storage.clear()
  const project = loadState().projects[0]
  const material = createMaterial({
    projectId: project.id,
    name: "地板",
    specification: "",
    unit: "箱",
    plannedQuantity: 5
  })
  const purchase = createMaterialPurchase({
    projectId: project.id,
    materialId: material.id,
    quantity: "5"
  })
  const receipt = createMaterialReceipt({
    projectId: project.id,
    purchaseLineId: purchase.id,
    quantity: "2"
  })
  assert.throws(() => allocateMaterialReceipt({
    batchId: receipt.id,
    kind: "accepted_available",
    quantity: "3"
  }), /不能超过尚未分配的实到数量/)
  assert.equal(loadState().materialInventoryEvents.length, 0)
})

test("本地展示完整走通问题预案、整改、复查、关闭和重开", () => {
  storage.clear()
  const project = loadState().projects[0]
  const legacyIssue = createIssue({
    projectId: project.id,
    title: "卫生间墙砖空鼓",
    description: "敲击时局部声音异常，需要确认处理方案",
    room: "卫生间",
    stage: "泥瓦",
    status: "pending_confirmation"
  })

  let workflow = addLocalIssueProposal(legacyIssue.id, "标记疑似位置并请瓦工复核")
  const firstProposalId = workflow.proposals[0].id
  workflow = selectLocalIssueProposal(workflow.id, firstProposalId)
  assert.equal(workflow.status, "pending_action")

  workflow = addLocalIssueProposal(workflow.id, "拆下疑似空鼓砖后重新铺贴")
  const replacementId = workflow.proposals.at(-1)!.id
  assert.throws(
    () => selectLocalIssueProposal(workflow.id, replacementId),
    /替换当前处理预案必须填写原因/
  )
  workflow = selectLocalIssueProposal(workflow.id, replacementId, "现场复核确认需要返工")
  assert.equal(workflow.proposals.find(item => item.id === firstProposalId)?.status, "superseded")
  assert.equal(workflow.proposals.find(item => item.id === replacementId)?.status, "active")
  assert.equal(
    workflow.proposals.find(item => item.id === firstProposalId)?.decisionReason,
    "现场复核确认需要返工"
  )
  assert.equal(workflow.proposals.filter(item => item.status === "active").length, 1)

  workflow = submitLocalIssueTreatment({
    issueId: workflow.id,
    note: "已拆下并重新铺贴，等待干燥后复查"
  })
  assert.equal(workflow.status, "pending_review")
  assert.equal(workflow.treatments.at(-1)?.activeProposalId, replacementId)
  workflow = reviewLocalIssueTreatment({
    issueId: workflow.id,
    decision: "returned",
    note: "边角仍有异常声，需要继续处理",
    method: "on_site"
  })
  assert.equal(workflow.status, "pending_action")

  workflow = submitLocalIssueTreatment({
    issueId: workflow.id,
    note: "已完成边角返工并重新养护"
  })
  workflow = reviewLocalIssueTreatment({
    issueId: workflow.id,
    decision: "closed",
    note: "现场复查敲击声正常",
    method: "on_site",
    closeReason: "resolved"
  })
  assert.equal(workflow.status, "closed")
  assert.equal(workflow.treatments.length, 2)
  assert.equal(workflow.reviews.length, 2)

  workflow = reopenLocalIssue(workflow.id, "一周后同位置再次出现异常声")
  assert.equal(workflow.status, "pending_action")
  assert.equal(workflow.reopenings.length, 1)
  assert.equal(
    loadState().issues.find(item => item.id === workflow.id)?.status,
    "pending_action"
  )
})

test("本地展示把报价、批准、付款确认和退款确认分开留档", () => {
  storage.clear()
  const project = loadState().projects[0]
  const cost = createCostItem({
    projectId: project.id,
    title: "全屋水电施工",
    category: "labor",
    quotedAmountFen: 1_200_000,
    note: "含开槽、布管和人工"
  })

  addLocalCostApproval({
    costItemId: cost.id,
    action: "initial",
    amountFen: 1_000_000,
    reason: "按合同首版范围批准"
  })
  assert.throws(() => addLocalCostApproval({
    costItemId: cost.id,
    action: "initial",
    amountFen: 100_000,
    reason: "重复初始批准"
  }), /已有批准金额/)

  let payment = submitLocalPayment({
    costItemId: cost.id,
    amountFen: 400_000
  })
  let state = loadState()
  let summary = financeSummary(state.costApprovals, state.paymentFacts, state.refundFacts)
  assert.equal(summary.paidFen, 0)
  assert.equal(summary.pendingPaymentFen, 400_000)

  payment = decideLocalPayment(payment.id, "confirmed")
  let refund = submitLocalRefund({
    paymentId: payment.id,
    amountFen: 20_000
  })
  assert.throws(() => submitLocalRefund({
    paymentId: payment.id,
    amountFen: 380_001
  }), /不能超过所关联付款/)
  refund = decideLocalRefund(refund.id, "confirmed")
  assert.equal(refund.status, "confirmed")

  addLocalCostApproval({
    costItemId: cost.id,
    action: "increase",
    amountFen: 50_000,
    reason: "负责人确认新增回路"
  })
  state = loadState()
  summary = financeSummary(state.costApprovals, state.paymentFacts, state.refundFacts)
  assert.deepEqual(summary, {
    approvedFen: 1_050_000,
    paidFen: 400_000,
    refundedFen: 20_000,
    netPaidFen: 380_000,
    outstandingFen: 670_000,
    overApprovedFen: 0,
    pendingPaymentFen: 0,
    pendingRefundFen: 0
  })
  assert.equal(state.costItems[0].quotedAmountFen, 1_200_000)
})

test("现场记录补充生成新版本且旧内容保持可追溯", () => {
  storage.clear()
  const project = loadState().projects[0]
  const first = createRecord({
    projectId: project.id,
    title: "卫生间防水第一遍",
    note: "已完成第一遍涂刷",
    room: "卫生间",
    stage: "泥瓦",
    creatorName: "项目负责人",
    occurredAt: "2026-09-24T04:00:00.000Z",
    attachments: [{
      id: "attachment-before",
      name: "施工前照片",
      type: "image",
      localPath: "wxfile://before.jpg"
    }]
  })
  assert.equal(first.version, 1)

  const second = updateRecord({
    recordId: first.id,
    expectedVersion: 1,
    title: "卫生间防水第一遍复查",
    note: "补充墙角涂刷照片",
    room: "卫生间",
    stage: "泥瓦",
    occurredAt: first.occurredAt,
    attachments: [...first.attachments, {
      id: "attachment-after",
      name: "补充照片",
      type: "image",
      localPath: "wxfile://after.jpg"
    }],
    changeReason: "补充当日复查结果"
  })
  assert.equal(second.version, 2)
  const revisions = loadState().recordRevisions
    .filter(item => item.recordId === first.id)
    .sort((a, b) => a.version - b.version)
  assert.equal(revisions.length, 2)
  assert.equal(revisions[0].title, "卫生间防水第一遍")
  assert.equal(revisions[0].attachments.length, 1)
  assert.equal(revisions[1].attachments.length, 2)
  assert.throws(() => updateRecord({
    recordId: first.id,
    expectedVersion: 1,
    title: "过期页面修改",
    note: "",
    room: "卫生间",
    stage: "泥瓦",
    occurredAt: first.occurredAt,
    attachments: [],
    changeReason: "模拟并发"
  }), /记录已更新/)
})

test("本地备份恢复完整保留业务关联且不复活旧成员权限", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "到货照片",
    note: "记录包装标签",
    room: "厨房",
    stage: "安装收尾",
    creatorName: "项目负责人",
    occurredAt: "2026-09-25T04:00:00.000Z",
    attachments: []
  })
  updateRecord({
    recordId: record.id,
    expectedVersion: 1,
    title: "到货照片与清点",
    note: "补充数量清点",
    room: "厨房",
    stage: "安装收尾",
    occurredAt: record.occurredAt,
    attachments: [],
    changeReason: "补充清点结果"
  })
  const issue = createIssue({
    projectId: project.id,
    title: "包装标签待确认",
    description: "型号照片不清晰",
    room: "厨房",
    stage: "安装收尾",
    recordId: record.id,
    status: "pending_confirmation"
  })
  const workflow = addLocalIssueProposal(issue.id, "补拍近照后再核对")
  selectLocalIssueProposal(workflow.id, workflow.proposals[0].id)

  const material = createMaterial({
    projectId: project.id,
    name: "橱柜五金",
    specification: "型号 H",
    unit: "套",
    plannedQuantity: 2
  })
  let agreement = createMaterialAgreement({
    projectId: project.id,
    materialId: material.id,
    title: "五金约定",
    terms: [{ key: "model", label: "型号", value: "H" }],
    sourceLabel: "采购单"
  })
  agreement = submitMaterialAgreement(agreement.agreement.id, agreement.versions[0].id)
  agreement = approveMaterialAgreement(agreement.agreement.id, agreement.versions[0].id)
  const purchase = createMaterialPurchase({
    projectId: project.id,
    materialId: material.id,
    quantity: "2"
  })
  const receipt = createMaterialReceipt({
    projectId: project.id,
    purchaseLineId: purchase.id,
    quantity: "2"
  })
  allocateMaterialReceipt({
    batchId: receipt.id,
    kind: "accepted_available",
    quantity: "2"
  })

  const cost = createCostItem({
    projectId: project.id,
    title: "五金尾款",
    category: "material",
    materialId: material.id,
    quotedAmountFen: 50_000
  })
  addLocalCostApproval({
    costItemId: cost.id,
    action: "initial",
    amountFen: 50_000,
    reason: "负责人确认"
  })
  const payment = decideLocalPayment(submitLocalPayment({
    costItemId: cost.id,
    amountFen: 50_000
  }).id, "confirmed")
  decideLocalRefund(submitLocalRefund({
    paymentId: payment.id,
    amountFen: 5_000
  }).id, "confirmed")
  addProjectMember({
    projectId: project.id,
    name: "临时协作者",
    role: "collaborator",
    scopes: ["records"]
  })

  const backup = exportProjectBundle(project.id)
  assert.match(backup, /renovation-sync-backup-v2/)
  const restored = restoreProjectBundle(backup)
  assert.equal(restored.status, "archived")
  const state = loadState()
  const restoredRecord = state.records.find(item =>
    item.projectId === restored.id && item.title === "到货照片与清点")!
  const restoredIssue = state.issues.find(item =>
    item.projectId === restored.id && item.recordId === restoredRecord.id)!
  const restoredWorkflow = state.issueWorkflows.find(item => item.id === restoredIssue.id)!
  const restoredMaterial = state.materials.find(item =>
    item.projectId === restored.id && item.name === "橱柜五金")!
  const restoredAgreement = state.agreements.find(item =>
    item.agreement.projectId === restored.id)!
  const restoredPurchase = state.purchaseLines.find(item => item.projectId === restored.id)!
  const restoredReceipt = state.receiptBatches.find(item => item.projectId === restored.id)!
  const restoredInventory = state.materialInventoryEvents.find(item => item.projectId === restored.id)!
  const restoredCost = state.costItems.find(item => item.projectId === restored.id)!
  const restoredPayment = state.paymentFacts.find(item => item.projectId === restored.id)!
  const restoredRefund = state.refundFacts.find(item => item.projectId === restored.id)!

  assert.equal(state.recordRevisions.filter(item => item.recordId === restoredRecord.id).length, 2)
  assert.equal(restoredWorkflow.status, "pending_action")
  assert.equal(restoredAgreement.agreement.subjectId, restoredMaterial.id)
  assert.equal(restoredPurchase.agreementVersionId, restoredAgreement.agreement.activeVersionId)
  assert.equal(restoredReceipt.purchaseLineId, restoredPurchase.id)
  assert.equal(
    restoredInventory.sourceReceiptAllocationId,
    restoredReceipt.allocationEvents[0].id
  )
  assert.equal(restoredCost.materialId, restoredMaterial.id)
  assert.equal(restoredPayment.costItemId, restoredCost.id)
  assert.equal(restoredRefund.paymentId, restoredPayment.id)
  assert.equal(
    state.members.find(item => item.projectId === restored.id)?.status,
    "revoked"
  )
})

test("R8-2E 备份恢复空间拓扑、阶段状态与一等证据并重映射全部引用", () => {
  storage.clear()
  const project = loadState().projects[0]
  const kitchen = createSpace({ projectId: project.id, name: "厨房", kind: "kitchen" })
  const balcony = createSpace({ projectId: project.id, name: "生活阳台", kind: "balcony" })
  createSpaceRelation({
    projectId: project.id,
    fromSpaceId: kitchen.id,
    toSpaceId: balcony.id,
    kind: "access",
    directionHint: "right"
  })
  const record = createRecord({
    projectId: project.id,
    title: "厨房水电定位",
    note: "用于恢复巡场坐标",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-10-10T08:00:00.000Z",
    attachments: []
  })
  mapLegacyRoomLabel({ projectId: project.id, sourceLabel: "厨房", spaceId: kitchen.id })
  const evidence = registerLocalEvidence({
    projectId: project.id,
    origin: "manual_upload",
    category: "image",
    fileName: "厨房水电.jpg",
    mediaType: "image/jpeg",
    localPath: "wxfile://r8-2e-kitchen.jpg",
    sizeBytes: 3,
    sha256: "a".repeat(64),
    occurredAt: "2026-10-10T08:00:00.000Z"
  })
  createEvidenceLink({
    projectId: project.id,
    evidenceId: evidence.asset.id,
    target: { type: "record", id: record.id, version: record.version },
    relationKind: "observes",
    spaceId: kitchen.id,
    stageId: "水电",
    note: "现场定位证据"
  })
  const stageState = setSpaceStageStatus({
    projectId: project.id,
    spaceId: kitchen.id,
    stageId: "水电",
    status: "pending_review",
    note: "等待复查",
    expectedVersion: 0
  })
  const stateWithEvidence = loadState()
  saveState({
    ...stateWithEvidence,
    spaceStageStates: stateWithEvidence.spaceStageStates.map(item => item.id === stageState.id
      ? { ...item, sourceEvidenceIds: [evidence.asset.id] }
      : item)
  })

  const restored = restoreProjectBundle(exportProjectBundle(project.id))
  const state = loadState()
  const restoredSpaces = state.spaces.filter(item => item.projectId === restored.id)
  const restoredKitchen = restoredSpaces.find(item => item.name === "厨房")!
  const restoredBalcony = restoredSpaces.find(item => item.name === "生活阳台")!
  const restoredEvidence = state.evidenceAssets.find(item => item.projectId === restored.id)!
  const restoredRecord = state.records.find(item => item.projectId === restored.id && item.title === record.title)!
  const restoredLinks = state.evidenceLinks.filter(item => item.projectId === restored.id)
  const restoredStage = state.spaceStageStates.find(item => item.projectId === restored.id)!

  assert.equal(restored.status, "archived")
  assert.notEqual(restoredKitchen.id, kitchen.id)
  assert.equal(state.spaceRelations.some(item => item.projectId === restored.id
    && item.fromSpaceId === restoredKitchen.id && item.toSpaceId === restoredBalcony.id), true)
  assert.equal(state.legacyRoomMappings.some(item => item.projectId === restored.id
    && item.spaceId === restoredKitchen.id), true)
  assert.equal(restoredRecord.spaceId, restoredKitchen.id)
  assert.notEqual(restoredEvidence.id, evidence.asset.id)
  assert.deepEqual(restoredEvidence.storageRef, { kind: "local_file", localPath: "wxfile://r8-2e-kitchen.jpg" })
  assert.equal(restoredLinks.some(item => item.evidenceId === restoredEvidence.id
    && item.target.type === "record" && item.target.id === restoredRecord.id
    && item.spaceId === restoredKitchen.id && item.stageId === "水电"), true)
  assert.deepEqual(restoredStage.sourceEvidenceIds, [restoredEvidence.id])
})

test("旧版 v1 备份恢复时补建记录版本和可继续处理的问题流程", () => {
  storage.clear()
  const legacy = JSON.stringify({
    schema: "renovation-sync-backup-v1",
    project: {
      id: "legacy-project",
      name: "旧项目",
      stage: "水电",
      ownerName: "旧负责人",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    records: [{
      id: "legacy-record",
      projectId: "legacy-project",
      title: "旧现场记录",
      note: "等待复查",
      room: "厨房",
      stage: "水电",
      creatorName: "旧负责人",
      occurredAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      attachments: []
    }],
    issues: [{
      id: "legacy-issue",
      projectId: "legacy-project",
      title: "旧待办",
      description: "旧版已经推进到待复查",
      room: "厨房",
      stage: "水电",
      recordId: "legacy-record",
      status: "pending_review",
      proposals: [{
        id: "legacy-proposal",
        authorName: "家人",
        authorRole: "family",
        content: "重新固定管线",
        createdAt: "2026-01-01T00:00:00.000Z",
        decision: "accepted",
        decidedAt: "2026-01-01T01:00:00.000Z"
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T02:00:00.000Z"
    }]
  })
  const restored = restoreProjectBundle(legacy)
  const state = loadState()
  const record = state.records.find(item => item.projectId === restored.id)!
  const issue = state.issueWorkflows.find(item => item.projectId === restored.id)!
  assert.equal(record.version, 1)
  assert.equal(state.recordRevisions.filter(item => item.recordId === record.id).length, 1)
  assert.equal(issue.status, "pending_review")
  assert.equal(issue.proposals[0].status, "active")
  assert.equal(issue.treatments.length, 1)
  assert.deepEqual(issue.treatments[0].evidenceSourceIds, [record.id])
})

test("项目归档、重开、回收站恢复和到期清理形成完整生命周期", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "归档前现场记录",
    note: "用于验证项目数据关系",
    room: "客厅",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-25T08:00:00.000Z",
    attachments: []
  })
  const member = addProjectMember({
    projectId: project.id,
    name: "家人",
    role: "family",
    scopes: ["records", "issues"]
  })
  const share = createShareSnapshot({
    projectId: project.id,
    title: "归档前快照",
    recordIds: [record.id],
    issueIds: [],
    allowDownload: false
  })
  const camera = createCameraBinding({
    projectId: project.id,
    provider: "ezviz_hosted",
    displayName: "客厅监控",
    room: "客厅",
    externalDeviceId: ""
  })

  const archived = archiveProject(project.id, "阶段施工完成")
  assert.equal(archived.status, "archived")
  assert.throws(() => createRecord({
    projectId: project.id,
    title: "不应写入",
    note: "",
    room: "客厅",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-25T09:00:00.000Z",
    attachments: []
  }), /项目已归档/)
  assert.throws(() => createCostItem({
    projectId: project.id,
    title: "归档后费用",
    category: "other"
  }), /项目已归档/)
  assert.match(exportProjectBundle(project.id), /projectLifecycleEvents/)

  const reopened = reopenProject(project.id, "继续处理收尾事项")
  assert.equal(reopened.status, "active")
  createCostItem({
    projectId: project.id,
    title: "重开后费用",
    category: "other"
  })

  const trashed = trashProject(project.id, "负责人确认移入回收站")
  assert.equal(trashed.status, "trashed")
  let state = loadState()
  assert.equal(state.currentProjectId, "")
  assert.equal(state.members.find(item => item.id === member.id)?.status, "revoked")
  assert.equal(state.shares.find(item => item.id === share.id)?.status, "revoked")
  assert.equal(state.cameras.find(item => item.id === camera.id)?.status, "revoked")
  assert.throws(() => exportProjectBundle(project.id), /回收站/)

  const restored = restoreTrashedProject(project.id, "发现仍需保留项目")
  assert.equal(restored.status, "archived")
  state = loadState()
  assert.equal(state.currentProjectId, project.id)
  assert.equal(state.members.find(item => item.id === member.id)?.status, "revoked")
  assert.throws(() => createMaterial({
    projectId: project.id,
    name: "恢复后不可直接写入",
    specification: "",
    unit: "件",
    plannedQuantity: 1
  }), /项目已归档/)

  reopenProject(project.id, "负责人确认继续项目")
  trashProject(project.id, "结束验证并等待清理")
  assert.equal(purgeExpiredProjects("2026-09-26T00:00:00.000Z"), 0)
  assert.equal(purgeExpiredProjects("2999-01-01T00:00:00.000Z"), 1)
  state = loadState()
  assert.equal(state.projects.some(item => item.id === project.id), false)
  assert.equal(state.records.some(item => item.projectId === project.id), false)
  assert.equal(state.projectLifecycleEvents.some(item => item.projectId === project.id), false)
})

test("固定分享严格校验范围且摘要不泄露设备路径", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "可分享记录",
    note: "限定正文",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-26T08:00:00.000Z",
    attachments: [{
      id: "share-attachment",
      name: "现场.jpg",
      type: "image",
      localPath: "wxfile://private/device/photo.jpg"
    }]
  })
  assert.throws(() => createShareSnapshot({
    projectId: project.id,
    title: "非法范围",
    recordIds: ["missing-record"],
    issueIds: [],
    allowDownload: true
  }), /不存在或不属于当前项目/)

  const share = createShareSnapshot({
    projectId: project.id,
    title: "给师傅的摘要",
    recordIds: [record.id],
    issueIds: [],
    allowDownload: true
  })
  const payload = sharePackage(share.id)
  assert.match(payload, /可分享记录/)
  assert.match(payload, /允许另行发送原件/)
  assert.doesNotMatch(payload, /wxfile:\/\/private/)
  assert.doesNotMatch(payload, /localPath/)
})

test("移入回收站会关闭咨询，过期项目不能绕过清理直接恢复", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "回收站咨询记录",
    note: "",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-26T08:00:00.000Z",
    attachments: []
  })
  const issue = createIssue({
    projectId: project.id,
    title: "回收站咨询问题",
    description: "需要外部人员提出处理建议",
    room: "厨房",
    stage: "水电",
    recordId: record.id,
    status: "pending_confirmation"
  })
  let consultation = createConsultation({
    projectId: project.id,
    title: "待关闭咨询",
    question: "如何处理？",
    knownFacts: [],
    gaps: [],
    answerQuestions: ["请给出建议"],
    recordIds: [record.id],
    issueIds: [issue.id]
  })
  consultation = publishConsultation(consultation.id, consultation.version)
  trashProject(project.id, "验证旧外发能力不会复活")
  let state = loadState()
  const closed = state.consultations.find(item => item.id === consultation.id)!
  assert.equal(closed.status, "closed")
  assert.match(closed.closeReason || "", /项目移入回收站/)
  assert.throws(() => consultationPackage(consultation.id), /回收站/)

  const saved = storage.get("renovation-sync-state-v1") as ReturnType<typeof loadState>
  storage.set("renovation-sync-state-v1", {
    ...saved,
    projects: saved.projects.map(item => item.id === project.id
      ? { ...item, purgeAfter: "2000-01-01T00:00:00.000Z" }
      : item)
  })
  assert.throws(() => restoreTrashedProject(project.id, "尝试绕过到期清理"), /超过回收站保留期/)
  state = loadState()
  assert.equal(state.projects.find(item => item.id === project.id)?.status, "trashed")
})

test("咨询资料固定版本，转述和本人回复分开留痕并由负责人决定是否转预案", () => {
  storage.clear()
  const project = loadState().projects[0]
  const record = createRecord({
    projectId: project.id,
    title: "墙砖空鼓现场记录",
    note: "卫生间东墙有两处敲击声异常",
    room: "卫生间",
    stage: "泥瓦",
    creatorName: "项目负责人",
    occurredAt: "2026-09-25T08:00:00.000Z",
    attachments: []
  })
  createRecord({
    projectId: project.id,
    title: "未选择的负责人私密合同",
    note: "不应进入咨询资料包",
    room: "全屋",
    stage: "泥瓦",
    creatorName: "项目负责人",
    occurredAt: "2026-09-25T08:05:00.000Z",
    attachments: []
  })
  const issue = createIssue({
    projectId: project.id,
    title: "墙砖空鼓处理待确认",
    description: "需要外部师傅给出返工建议",
    room: "卫生间",
    stage: "泥瓦",
    recordId: record.id,
    status: "pending_confirmation"
  })
  const member = addProjectMember({
    projectId: project.id,
    name: "家人小林",
    role: "family",
    scopes: ["issues"]
  })

  let consultation = createConsultation({
    projectId: project.id,
    title: "卫生间墙砖处理咨询",
    question: "是否需要拆砖重贴？",
    knownFacts: ["东墙两处敲击声异常"],
    gaps: ["尚未现场复核"],
    answerQuestions: ["建议怎样复核？", "什么情况下需要返工？"],
    recordIds: [record.id],
    issueIds: [issue.id]
  })
  consultation = publishConsultation(consultation.id, consultation.version)
  const firstPackage = consultationPackage(consultation.id)
  assert.match(firstPackage, /墙砖空鼓现场记录/)
  assert.match(firstPackage, /不接收匿名回复/)
  assert.doesNotMatch(firstPackage, /未选择的负责人私密合同/)

  updateRecord({
    recordId: record.id,
    expectedVersion: 1,
    title: "现场记录已补充",
    note: "补充了近照",
    room: record.room,
    stage: record.stage,
    occurredAt: record.occurredAt,
    attachments: [],
    changeReason: "补充现场资料"
  })
  assert.doesNotMatch(consultationPackage(consultation.id), /现场记录已补充/)

  const relayed = addConsultationResponse({
    consultationId: consultation.id,
    source: "manual_relay",
    respondentName: "瓦工王师傅",
    channel: "微信",
    receivedAt: new Date(Date.now() - 1000).toISOString(),
    originalText: "先现场复核，确认空鼓范围后再决定是否拆砖。",
    summary: "先复核范围，再决定是否返工",
    recordedBy: "项目负责人",
    targetIssueId: issue.id
  })
  const converted = convertConsultationResponseToProposal(relayed.id)
  assert.equal(converted.status, "converted_to_proposal")
  let state = loadState()
  const workflow = state.issueWorkflows.find(item => item.id === issue.id)!
  assert.equal(workflow.status, "pending_confirmation")
  assert.equal(workflow.proposals.length, 1)
  assert.match(workflow.proposals[0].submittedBy, /微信转述/)

  const direct = addConsultationResponse({
    consultationId: consultation.id,
    source: "member_direct_local",
    memberId: member.id,
    receivedAt: new Date(Date.now() - 500).toISOString(),
    originalText: "我建议先补拍侧光照片再请师傅到场。",
    targetIssueId: issue.id
  })
  assert.equal(direct.respondentName, "家人小林")
  assert.match(direct.channel, /本机演示身份/)
  const dismissed = dismissConsultationResponse(direct.id, "与已纳入预案重复")
  assert.equal(dismissed.status, "dismissed")

  consultation = reviseConsultation({
    consultationId: consultation.id,
    expectedVersion: consultation.version,
    title: consultation.title,
    question: "现场复核后应采用哪一种返工范围？",
    knownFacts: ["东墙两处敲击声异常", "师傅建议先确认范围"],
    gaps: ["空鼓面积仍未知"],
    answerQuestions: ["请给出现场复核步骤"],
    recordIds: [record.id],
    issueIds: [issue.id]
  })
  assert.match(consultationPackage(consultation.id), /是否需要拆砖重贴/)
  consultation = publishConsultation(consultation.id, consultation.version)
  assert.match(consultationPackage(consultation.id), /现场复核后应采用哪一种返工范围/)
  consultation = closeConsultation(consultation.id, consultation.version, "已经收到足够意见")
  assert.equal(consultation.status, "closed")
  assert.throws(() => consultationPackage(consultation.id), /咨询已结束/)

  const backup = exportProjectBundle(project.id)
  const restored = restoreProjectBundle(backup)
  state = loadState()
  const restoredConsultation = state.consultations.find(item =>
    item.projectId === restored.id && item.title === consultation.title)!
  const restoredResponses = state.consultationResponses.filter(item =>
    item.consultationId === restoredConsultation.id)
  const restoredWorkflow = state.issueWorkflows.find(item =>
    item.projectId === restored.id && item.title === workflow.title)!
  assert.equal(restoredConsultation.status, "closed")
  assert.match(restoredConsultation.closeReason || "", /旧外发权限不恢复/)
  assert.equal(restoredResponses.length, 2)
  assert.ok(restoredWorkflow.proposals.some(item =>
    item.id === restoredResponses.find(item => item.status === "converted_to_proposal")?.proposalId))
})
