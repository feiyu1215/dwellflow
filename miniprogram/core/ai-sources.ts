import type { AiSource, AiSourceKind, ProjectSummaryScope } from "./ai-contract"
import type { AppState, Project } from "./domain"
import { financeSummary } from "./finance"

const KIND_LABEL: Record<AiSourceKind, string> = {
  record: "现场记录",
  agreement: "约定版本",
  issue: "问题事项",
  material: "材料",
  purchase: "采购",
  receipt: "到货批次",
  expense: "费用",
  consultation: "咨询版本",
  consultation_response: "咨询回复"
}

const isApprovedAgreementStatus = (status: string) =>
  status === "active" || status === "superseded"

const agreementStatusLabel = (status: string) => {
  if (status === "active") return "已批准生效"
  if (status === "superseded") return "曾批准，已替代"
  return "未生效"
}

export interface AiSourceChoice extends AiSource {
  selected: boolean
  required: boolean
  kindLabel: string
}

export interface AiImageChoice {
  sourceId: string
  id: string
  path: string
  selected: boolean
}

export interface AiSourceRequest {
  task?: string
  recordId?: string
  issueId?: string
  consultationId?: string
  mode?: string
  materialId?: string
  receiptId?: string
  previousSelectedIds?: Set<string>
  previousImageIds?: Set<string>
  summaryScope?: ProjectSummaryScope
  selectAllByDefault?: boolean
}

export interface AiSourcePlan {
  choices: AiSourceChoice[]
  images: AiImageChoice[]
  warning: string
}

function materialResourceVersion(state: AppState, materialId: string, createdAt: string): string {
  const events = state.materialInventoryEvents.filter(item => item.materialId === materialId)
  const usages = state.materialUsageRecords.filter(item => item.materialId === materialId)
  const lines = state.purchaseLines.filter(item => item.materialId === materialId)
  const batches = state.receiptBatches.filter(item => item.materialId === materialId)
  const latest = [...events.map(item => item.createdAt), ...usages.map(item => item.createdAt),
    ...lines.map(item => item.createdAt), ...batches.map(item => item.occurredAt)]
    .sort().at(-1) || createdAt
  return `${createdAt}:${events.length}:${usages.length}:${lines.length}:${batches.length}:`
    + `${batches.reduce((sum, item) => sum + item.version, 0)}:${latest}`
}

function costVersion(state: AppState, costItemId: string, createdAt: string): string {
  const approvals = state.costApprovals.filter(item => item.costItemId === costItemId)
  const payments = state.paymentFacts.filter(item => item.costItemId === costItemId)
  const refunds = state.refundFacts.filter(item => item.costItemId === costItemId)
  const decisionVersion = payments.reduce((sum, item) => sum + item.version, 0)
    + refunds.reduce((sum, item) => sum + item.version, 0)
  return `${createdAt}:${approvals.length}:${payments.length}:${refunds.length}:${decisionVersion}`
}

export function buildAiSourcePlan(
  state: AppState,
  project: Project,
  request: AiSourceRequest = {}
): AiSourcePlan {
  const selectedIds = new Set(request.previousSelectedIds || [])
  const requiredIds = new Set<string>()
  let warning = ""

  const requestedMaterial = request.materialId
    ? state.materials.find(item => item.id === request.materialId && item.projectId === project.id)
    : undefined
  const requestedReceipt = request.receiptId
    ? state.receiptBatches.find(item => item.id === request.receiptId && item.projectId === project.id)
    : undefined
  const fixedMaterialCheck = request.task === "material_check"
    && Boolean(request.materialId || request.receiptId)
  const validMaterialCheckScope = fixedMaterialCheck
    && Boolean(requestedMaterial && requestedReceipt
      && requestedReceipt.materialId === requestedMaterial.id)

  if (fixedMaterialCheck) {
    if (!validMaterialCheckScope || !requestedMaterial || !requestedReceipt) {
      warning = "材料或到货批次已变化，请返回材料页重新发起核对。"
    } else {
      requiredIds.add(requestedMaterial.id)
      requiredIds.add(requestedReceipt.id)
      selectedIds.add(requestedMaterial.id)
      selectedIds.add(requestedReceipt.id)
      if (requestedReceipt.purchaseLineId) selectedIds.add(requestedReceipt.purchaseLineId)
      const purchase = state.purchaseLines.find(item => item.id === requestedReceipt.purchaseLineId)
      const agreementVersionId = purchase?.agreementVersionId
        || state.agreements.find(item => item.agreement.projectId === project.id
          && item.agreement.subject === "material"
          && item.agreement.subjectId === requestedMaterial.id)?.agreement.activeVersionId
      if (agreementVersionId) selectedIds.add(agreementVersionId)
    }
  }

  if (request.task === "budget" && requestedMaterial) {
    selectedIds.add(requestedMaterial.id)
    if (requestedReceipt?.materialId === requestedMaterial.id) selectedIds.add(requestedReceipt.id)
  }

  if (request.recordId && state.records.some(item =>
    item.id === request.recordId && item.projectId === project.id)) {
    selectedIds.add(request.recordId)
  }
  if (request.issueId) {
    const issue = state.issues.find(item =>
      item.id === request.issueId && item.projectId === project.id)
    if (!issue) {
      warning ||= "问题事项已变化，请返回问题页重新发起分析。"
    } else {
      selectedIds.add(issue.id)
      if (request.task === "rectification") requiredIds.add(issue.id)
      if (issue.recordId) selectedIds.add(issue.recordId)
    }
  }
  if (request.consultationId) {
    const consultation = state.consultations.find(item =>
      item.id === request.consultationId && item.projectId === project.id)
    if (!consultation) {
      warning ||= "咨询已变化，请返回咨询页重新发起分析。"
    } else {
      selectedIds.add(consultation.id)
      if (request.task === "consultation" && request.mode === "response") {
        requiredIds.add(consultation.id)
        for (const response of state.consultationResponses.filter(item =>
          item.consultationId === consultation.id
          && item.projectId === project.id
          && item.status === "pending")) {
          selectedIds.add(response.id)
        }
      }
    }
  }

  const choices: AiSourceChoice[] = []
  const ids = new Set<string>()
  const withinSummaryScope = (source: AiSource) => {
    const scope = request.summaryScope
    if (request.task !== "project_summary" || !scope) return true
    if (scope.stage !== "全部工序" && source.stage && source.stage !== scope.stage) return false
    if (scope.room !== "全部房间" && source.room && source.room !== scope.room) return false
    if (!scope.dateFrom && !scope.dateTo) return true
    if (!["record", "purchase", "receipt", "consultation_response"].includes(source.kind)) {
      return true
    }
    const timestamp = source.occurredAt
    if (!timestamp) return true
    const date = timestamp.slice(0, 10)
    return (!scope.dateFrom || date >= scope.dateFrom) && (!scope.dateTo || date <= scope.dateTo)
  }
  const add = (source: AiSource) => {
    if (!withinSummaryScope(source)) return
    if (ids.has(source.id)) return
    ids.add(source.id)
    choices.push({
      ...source,
      selected: selectedIds.has(source.id) || requiredIds.has(source.id)
        || Boolean(request.selectAllByDefault),
      required: requiredIds.has(source.id),
      kindLabel: KIND_LABEL[source.kind]
    })
  }

  for (const material of state.materials.filter(item => item.projectId === project.id)) {
    if (validMaterialCheckScope && material.id !== requestedMaterial?.id) continue
    add({
      id: material.id,
      kind: "material",
      title: material.name,
      text: JSON.stringify({
        name: material.name,
        specification: material.specification,
        unit: material.unit,
        plannedQuantity: material.plannedQuantity,
        wasteRatePercent: (material.wasteRatePermille || 0) / 10,
        requirementIncludesWaste: false,
        packageSize: 1,
        packageUnitPriceYuan: material.unitPriceFen === undefined
          ? null
          : material.unitPriceFen / 100,
        priceScope: "每 1 个材料单位的计划单价；null 表示未记录，0 表示明确记录为零"
      }),
      version: materialResourceVersion(state, material.id, material.createdAt),
      authority: "project_fact",
      occurredAt: material.createdAt,
      updatedAt: material.createdAt
    })
  }
  for (const batch of state.receiptBatches.filter(item => item.projectId === project.id)) {
    if (validMaterialCheckScope && batch.id !== requestedReceipt?.id) continue
    const material = state.materials.find(item => item.id === batch.materialId)
    add({
      id: batch.id,
      kind: "receipt",
      title: `到货 · ${material?.name || "未知材料"} · ${batch.occurredAt}`,
      text: JSON.stringify(batch),
      version: String(batch.version),
      authority: "project_fact",
      relatedMaterialId: batch.materialId,
      occurredAt: batch.occurredAt,
      updatedAt: [...batch.quantityEvents, ...batch.allocationEvents]
        .map(event => event.createdAt).sort().at(-1) || batch.occurredAt
    })
  }
  for (const line of state.purchaseLines.filter(item => item.projectId === project.id)) {
    if (validMaterialCheckScope) {
      const linkedPurchaseLineId = requestedReceipt?.purchaseLineId
      if (linkedPurchaseLineId
        ? line.id !== linkedPurchaseLineId
        : line.materialId !== requestedMaterial?.id) continue
    }
    const material = state.materials.find(item => item.id === line.materialId)
    add({
      id: line.id,
      kind: "purchase",
      title: `采购 · ${material?.name || "未知材料"}`,
      text: JSON.stringify(line),
      version: line.createdAt,
      authority: "project_fact",
      relatedMaterialId: line.materialId,
      occurredAt: line.createdAt,
      updatedAt: line.createdAt
    })
  }
  for (const aggregate of state.agreements.filter(item => item.agreement.projectId === project.id)) {
    if (validMaterialCheckScope
      && (aggregate.agreement.subject !== "material"
        || aggregate.agreement.subjectId !== requestedMaterial?.id)) continue
    for (const version of aggregate.versions) {
      const approved = isApprovedAgreementStatus(version.status)
      add({
        id: version.id,
        kind: "agreement",
        title: `${aggregate.agreement.title} · v${version.revision}（${agreementStatusLabel(version.status)}）`,
        text: JSON.stringify({ status: version.status, terms: version.terms }),
        version: String(version.revision),
        authority: approved ? "approved_agreement" : "unapproved_agreement",
        occurredAt: version.createdAt,
        updatedAt: version.updatedAt,
        ...(aggregate.agreement.subject === "material" && aggregate.agreement.subjectId
          ? { relatedMaterialId: aggregate.agreement.subjectId }
          : {})
      })
    }
  }
  for (const record of state.records.filter(item => item.projectId === project.id)) {
    add({
      id: record.id,
      kind: "record",
      title: record.title,
      text: `${record.note}\n房间：${record.room}；工序：${record.stage}；发生时间：${record.occurredAt}`,
      version: String(record.version || record.createdAt),
      authority: "project_fact",
      occurredAt: record.occurredAt,
      updatedAt: record.createdAt,
      room: record.room,
      stage: record.stage
    })
  }
  for (const issue of state.issues.filter(item => item.projectId === project.id)) {
    const workflow = state.issueWorkflows.find(item => item.id === issue.id)
    add({
      id: issue.id,
      kind: "issue",
      title: issue.title,
      text: JSON.stringify({ issue, workflow }),
      version: `${issue.updatedAt}:${workflow?.version || 0}`,
      authority: "project_fact",
      occurredAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      room: issue.room,
      stage: issue.stage
    })
  }
  for (const expense of state.expenses.filter(item => item.projectId === project.id)) {
    add({
      id: expense.id,
      kind: "expense",
      title: expense.title,
      text: JSON.stringify(expense),
      version: expense.createdAt,
      authority: "project_fact",
      occurredAt: expense.createdAt,
      updatedAt: expense.createdAt
    })
  }
  for (const item of state.costItems.filter(item => item.projectId === project.id)) {
    const approvals = state.costApprovals.filter(event => event.costItemId === item.id)
    const payments = state.paymentFacts.filter(event => event.costItemId === item.id)
    const refunds = state.refundFacts.filter(event => event.costItemId === item.id)
    add({
      id: item.id,
      kind: "expense",
      title: `费用 · ${item.title}`,
      text: JSON.stringify({
        kind: "cost_item_finance_snapshot",
        item,
        finance: financeSummary(approvals, payments, refunds),
        scope: "报价、已批准、付款、退款、待确认分别展示，不相加"
      }),
      version: costVersion(state, item.id, item.createdAt),
      authority: "project_fact",
      relatedMaterialId: item.materialId,
      occurredAt: item.createdAt,
      updatedAt: item.createdAt
    })
  }
  for (const consultation of state.consultations.filter(item => item.projectId === project.id)) {
    const selectedVersionId = consultation.draftVersionId || consultation.activeVersionId
    const selectedVersion = consultation.versions.find(item => item.id === selectedVersionId)
    add({
      id: consultation.id,
      kind: "consultation",
      title: `${consultation.title} · ${selectedVersion ? `第 ${selectedVersion.revision} 版` : "无可用版本"}`,
      text: JSON.stringify({
        id: consultation.id,
        title: consultation.title,
        status: consultation.status,
        version: consultation.version,
        selectedVersion
      }),
      version: String(consultation.version),
      authority: "project_fact",
      occurredAt: consultation.createdAt,
      updatedAt: consultation.updatedAt
    })
  }
  for (const response of state.consultationResponses.filter(item => item.projectId === project.id)) {
    if (request.task === "consultation" && request.mode === "response"
      && response.status !== "pending") continue
    add({
      id: response.id,
      kind: "consultation_response",
      title: `咨询回复 · ${response.respondentName}`,
      text: JSON.stringify({
        consultationId: response.consultationId,
        consultationVersionId: response.consultationVersionId,
        source: response.source,
        respondentName: response.respondentName,
        channel: response.channel,
        receivedAt: response.receivedAt,
        originalText: response.originalText,
        summary: response.summary,
        targetIssueId: response.targetIssueId,
        status: response.status
      }),
      version: `${response.createdAt}:${response.status}:${response.decidedAt || ""}`,
      authority: "project_fact",
      relatedConsultationId: response.consultationId,
      occurredAt: response.receivedAt,
      updatedAt: response.decidedAt || response.createdAt
    })
  }

  choices.sort((left, right) =>
    Number(right.required) - Number(left.required)
    || Number(right.selected) - Number(left.selected))
  const selectedSourceIds = new Set(choices.filter(item => item.selected).map(item => item.id))
  const previousImageIds = request.previousImageIds || new Set<string>()
  const images = state.records
    .filter(record => record.projectId === project.id)
    .flatMap(record => record.attachments
      .filter(file => file.type === "image")
      .map(file => ({
        sourceId: record.id,
        id: file.id,
        path: file.localPath,
        selected: selectedSourceIds.has(record.id) && previousImageIds.has(file.id)
      })))

  return { choices, images, warning }
}
