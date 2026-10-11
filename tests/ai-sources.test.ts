import assert from "node:assert/strict"
import test from "node:test"
import { buildAiSourcePlan } from "../miniprogram/core/ai-sources.ts"
import type { AppState, Project } from "../miniprogram/core/domain.ts"

const project: Project = {
  id: "project1",
  name: "测试项目",
  stage: "水电",
  ownerName: "负责人",
  status: "active",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
}

function state(): AppState {
  return {
    currentProjectId: project.id,
    projects: [project],
    projectLifecycleEvents: [],
    spaces: [],
    spaceRelations: [],
    spaceStageStates: [],
    legacyRoomMappings: [],
    evidenceAssets: [],
    evidenceLinks: [],
    records: [{
      id: "record1", projectId: project.id, version: 2,
      title: "到货照片", note: "拍到材料标签", room: "客厅", stage: "水电",
      creatorName: "负责人", occurredAt: "2026-09-26T01:00:00.000Z",
      createdAt: "2026-09-26T01:00:00.000Z",
      attachments: [{ id: "image1", name: "标签.jpg", type: "image", localPath: "wxfile://private-label.jpg" }]
    }],
    recordRevisions: [],
    issues: [],
    issueWorkflows: [],
    materials: [
      { id: "material1", projectId: project.id, name: "电线", specification: "2.5 平方", unit: "卷", plannedQuantity: 10, createdAt: "2026-09-26T00:00:00.000Z" },
      { id: "material2", projectId: project.id, name: "水管", specification: "20mm", unit: "根", plannedQuantity: 6, createdAt: "2026-09-26T00:00:00.000Z" }
    ],
    inventory: [],
    expenses: [],
    agreements: [{
      agreement: {
        id: "agreement1", projectId: project.id, subject: "material", subjectId: "material1",
        title: "电线约定", activeVersionId: "agreement_version_active", version: 2
      },
      versions: [
        {
          id: "agreement_version_active", agreementId: "agreement1", revision: 1, status: "active",
          terms: [{ key: "brand", label: "品牌", value: "示例牌" }], sourceIds: [], sourceConflicts: [],
          createdBy: "owner", createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z"
        },
        {
          id: "agreement_version_draft", agreementId: "agreement1", revision: 2, status: "draft",
          terms: [{ key: "brand", label: "品牌", value: "候选牌" }], sourceIds: [], sourceConflicts: [],
          createdBy: "owner", createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z"
        }
      ]
    }],
    purchaseLines: [{
      id: "purchase1", projectId: project.id, materialId: "material1",
      agreementVersionId: "agreement_version_active", orderedQuantityMilli: 10000,
      unit: "卷", status: "ordered", createdAt: "2026-09-26T00:00:00.000Z"
    }],
    receiptBatches: [{
      id: "receipt1", projectId: project.id, purchaseLineId: "purchase1", materialId: "material1",
      unit: "卷", occurredAt: "2026-09-26T02:00:00.000Z", version: 1,
      quantityEvents: [{
        id: "quantity1", requestId: "request1", kind: "submitted", quantityMilli: 9000,
        actorId: "owner", createdAt: "2026-09-26T02:00:00.000Z"
      }],
      allocationEvents: []
    }],
    unitConversions: [],
    materialInventoryEvents: [],
    materialUsageRecords: [],
    costItems: [],
    costApprovals: [],
    paymentFacts: [],
    refundFacts: [],
    members: [],
    shares: [],
    consultations: [],
    consultationResponses: [],
    cameras: [],
    analyses: [],
    materialChecks: [],
    recordReviewApplications: [],
    imageObservationApplications: [],
    rectificationApplications: [],
    consultationApplications: [],
    budgetEstimateApplications: [],
    projectSummaryApplications: []
  }
}

test("material check entry locks one material and receipt and preselects their approved basis", () => {
  const plan = buildAiSourcePlan(state(), project, {
    task: "material_check",
    materialId: "material1",
    receiptId: "receipt1",
    recordId: "record1"
  })
  assert.equal(plan.warning, "")
  assert.deepEqual(
    plan.choices.filter(item => item.required).map(item => item.id).sort(),
    ["material1", "receipt1"]
  )
  for (const id of ["material1", "receipt1", "purchase1", "agreement_version_active", "record1"]) {
    assert.equal(plan.choices.find(item => item.id === id)?.selected, true, id)
  }
  assert.equal(plan.choices.find(item => item.id === "agreement_version_active")?.authority, "approved_agreement")
  assert.equal(plan.choices.find(item => item.id === "agreement_version_draft")?.authority, "unapproved_agreement")
  assert.equal(plan.choices.find(item => item.id === "agreement_version_draft")?.selected, false)
  assert.equal(plan.images[0].selected, false, "图片仍需用户逐张勾选")
  assert.doesNotMatch(plan.choices.find(item => item.id === "record1")!.text, /wxfile:/)
})

test("fixed material check excludes unrelated material-domain sources", () => {
  const scenario = state()
  scenario.purchaseLines.push({
    ...scenario.purchaseLines[0],
    id: "purchase2",
    materialId: "material2",
    agreementVersionId: "agreement_version_other"
  })
  scenario.receiptBatches.push({
    ...scenario.receiptBatches[0],
    id: "receipt2",
    purchaseLineId: "purchase2",
    materialId: "material2",
    quantityEvents: []
  })
  scenario.agreements.push({
    agreement: {
      id: "agreement2", projectId: project.id, subject: "material", subjectId: "material2",
      title: "水管约定", activeVersionId: "agreement_version_other", version: 1
    },
    versions: [{
      ...scenario.agreements[0].versions[0],
      id: "agreement_version_other",
      agreementId: "agreement2"
    }]
  })

  const plan = buildAiSourcePlan(scenario, project, {
    task: "material_check",
    materialId: "material1",
    receiptId: "receipt1"
  })
  for (const unrelatedId of [
    "material2", "purchase2", "receipt2", "agreement_version_other"
  ]) {
    assert.equal(plan.choices.some(item => item.id === unrelatedId), false, unrelatedId)
  }
})

test("purchase-bound superseded agreement remains an approved historical baseline", () => {
  const scenario = state()
  const aggregate = scenario.agreements[0]
  const historical = aggregate.versions[0]
  const current = aggregate.versions[1]
  historical.status = "superseded"
  historical.decidedBy = "owner"
  historical.decidedAt = "2026-09-26T00:10:00.000Z"
  current.status = "active"
  current.decidedBy = "owner"
  current.decidedAt = "2026-09-26T00:20:00.000Z"
  aggregate.agreement.activeVersionId = current.id

  const plan = buildAiSourcePlan(scenario, project, {
    task: "material_check",
    materialId: "material1",
    receiptId: "receipt1"
  })
  const historicalChoice = plan.choices.find(item => item.id === historical.id)
  const currentChoice = plan.choices.find(item => item.id === current.id)
  assert.equal(historicalChoice?.authority, "approved_agreement")
  assert.equal(historicalChoice?.selected, true)
  assert.match(historicalChoice?.title || "", /曾批准，已替代/)
  assert.equal(currentChoice?.authority, "approved_agreement")
  assert.equal(currentChoice?.selected, false, "默认沿用采购时绑定的约定版本")
})

test("mismatched material and receipt never become a locked AI scope", () => {
  const plan = buildAiSourcePlan(state(), project, {
    task: "material_check",
    materialId: "material2",
    receiptId: "receipt1"
  })
  assert.match(plan.warning, /已变化/)
  assert.equal(plan.choices.some(item => item.required), false)
})

test("巡场预算入口预选当前材料和匹配批次但不把它们锁死", () => {
  const plan = buildAiSourcePlan(state(), project, {
    task: "budget",
    materialId: "material1",
    receiptId: "receipt1"
  })
  for (const id of ["material1", "receipt1"]) {
    const choice = plan.choices.find(item => item.id === id)
    assert.equal(choice?.selected, true, id)
    assert.equal(choice?.required, false, `${id} 仍允许用户取消选择`)
  }
  assert.equal(plan.choices.find(item => item.id === "material2")?.selected, false)
})

test("selected record images only persist when their record remains selected", () => {
  const selected = buildAiSourcePlan(state(), project, {
    previousSelectedIds: new Set(["record1"]),
    previousImageIds: new Set(["image1"])
  })
  assert.equal(selected.images[0].selected, true)
  const unselected = buildAiSourcePlan(state(), project, {
    previousImageIds: new Set(["image1"])
  })
  assert.equal(unselected.images[0].selected, false)
})

test("rectification and response modes lock versioned issue and consultation sources", () => {
  const scenario = state()
  scenario.issues.push({
    id: "issue1", projectId: project.id, title: "墙面处理待确认", description: "处理后等待复查",
    room: "客厅", stage: "油漆", recordId: "record1", status: "pending_review", proposals: [],
    createdAt: "2026-09-26T02:00:00.000Z", updatedAt: "2026-09-26T03:00:00.000Z"
  })
  scenario.issueWorkflows.push({
    id: "issue1", projectId: project.id, title: "墙面处理待确认", description: "处理后等待复查",
    status: "pending_review", version: 4,
    proposals: [{
      id: "proposal1", content: "补涂后复查", status: "active", submittedBy: "负责人",
      createdAt: "2026-09-26T02:10:00.000Z"
    }],
    treatments: [{
      id: "treatment1", activeProposalId: "proposal1", note: "已补涂",
      evidenceSourceIds: ["record1"], submittedBy: "施工方", submittedAt: "2026-09-26T03:00:00.000Z"
    }],
    reviews: [], reopenings: [], createdBy: "family-local",
    createdAt: "2026-09-26T02:00:00.000Z", updatedAt: "2026-09-26T03:00:00.000Z"
  })
  scenario.consultations.push({
    id: "consultation1", projectId: project.id, title: "墙面复查咨询", status: "published",
    version: 2, activeVersionId: "consultation-version1", versions: [{
      id: "consultation-version1", consultationId: "consultation1", revision: 1,
      status: "published", question: "怎样复查？", knownFacts: ["已补涂"], gaps: [],
      answerQuestions: ["还需哪些证据？"], recordIds: ["record1"], issueIds: ["issue1"],
      recordCopies: [], issueCopies: [], createdAt: "2026-09-26T03:00:00.000Z",
      publishedAt: "2026-09-26T03:10:00.000Z", expiresAt: "2026-10-03T03:10:00.000Z"
    }],
    createdAt: "2026-09-26T03:00:00.000Z", updatedAt: "2026-09-26T03:10:00.000Z"
  })
  scenario.consultationResponses.push({
    id: "response1", consultationId: "consultation1", consultationVersionId: "consultation-version1",
    projectId: project.id, source: "manual_relay", respondentName: "师傅", channel: "微信",
    receivedAt: "2026-09-26T04:00:00.000Z", originalText: "补拍侧光照片。", summary: "",
    recordedBy: "负责人", targetIssueId: "issue1", status: "pending",
    createdAt: "2026-09-26T04:05:00.000Z"
  })

  const rectification = buildAiSourcePlan(scenario, project, {
    task: "rectification", mode: "review", issueId: "issue1"
  })
  const issue = rectification.choices.find(item => item.id === "issue1")!
  assert.equal(issue.required, true)
  assert.match(issue.version, /:4$/)
  assert.match(issue.text, /treatment1/)
  assert.equal(rectification.choices.find(item => item.id === "record1")?.selected, true)

  const consultation = buildAiSourcePlan(scenario, project, {
    task: "consultation", mode: "response", consultationId: "consultation1"
  })
  assert.equal(consultation.choices.find(item => item.id === "consultation1")?.required, true)
  const response = consultation.choices.find(item => item.id === "response1")!
  assert.equal(response.selected, true)
  assert.equal(response.relatedConsultationId, "consultation1")
  assert.match(response.text, /补拍侧光照片/)

  const prepare = buildAiSourcePlan(scenario, project, {
    task: "consultation", mode: "prepare", issueId: "issue1"
  })
  assert.equal(prepare.choices.find(item => item.id === "issue1")?.selected, true)
  assert.equal(prepare.choices.find(item => item.id === "record1")?.selected, true)
  assert.equal(prepare.choices.find(item => item.id === "issue1")?.required, false)
})

test("project summary filters event sources by room and occurred time while retaining current state sources", () => {
  const scenario = state()
  scenario.records.push({
    ...scenario.records[0],
    id: "record_old_kitchen",
    room: "厨房",
    occurredAt: "2026-09-21T01:00:00.000Z",
    createdAt: "2026-09-27T01:00:00.000Z",
    attachments: []
  }, {
    ...scenario.records[0],
    id: "record_current_kitchen",
    room: "厨房",
    occurredAt: "2026-09-27T01:00:00.000Z",
    createdAt: "2026-09-27T02:00:00.000Z",
    attachments: []
  })
  scenario.issues.push({
    id: "issue_kitchen_open", projectId: project.id, title: "厨房旧问题仍待处理",
    description: "当前仍未关闭", room: "厨房", stage: "水电",
    status: "pending_action", proposals: [],
    createdAt: "2026-09-10T01:00:00.000Z", updatedAt: "2026-09-20T01:00:00.000Z"
  }, {
    id: "issue_bathroom", projectId: project.id, title: "卫生间问题",
    description: "不属于厨房范围", room: "卫生间", stage: "水电",
    status: "pending_action", proposals: [],
    createdAt: "2026-09-27T01:00:00.000Z", updatedAt: "2026-09-27T01:00:00.000Z"
  })
  const plan = buildAiSourcePlan(scenario, project, {
    task: "project_summary",
    summaryScope: {
      title: "厨房周报", purpose: "交接", audience: "家人与工长",
      stage: "水电", room: "厨房", dateFrom: "2026-09-25", dateTo: "2026-09-28",
      cutoffAt: "2026-09-28T12:00:00.000Z"
    },
    selectAllByDefault: true
  })
  const ids = new Set(plan.choices.map(item => item.id))
  assert.equal(ids.has("record_current_kitchen"), true)
  assert.equal(ids.has("record_old_kitchen"), false, "记录按 occurredAt 而非补写时间筛选")
  assert.equal(ids.has("record1"), false, "其他房间记录不进入范围")
  assert.equal(ids.has("issue_kitchen_open"), true, "当前未关闭问题不因创建较早而消失")
  assert.equal(ids.has("issue_bathroom"), false)
  assert.equal(ids.has("material1"), true, "材料当前状态资料保留")
  assert.equal(plan.choices.every(item => item.selected), true)
  const record = plan.choices.find(item => item.id === "record_current_kitchen")!
  assert.equal(record.occurredAt, "2026-09-27T01:00:00.000Z")
  assert.equal(record.updatedAt, "2026-09-27T02:00:00.000Z")
})
