import {
  AI_TASKS,
  type AiImage,
  type AiImageReference,
  type AiInput,
  type AiJob,
  type AiSource,
  type AiSourceSnapshotReference,
  type AiTaskMode,
  type AiTarget,
  type BudgetHumanReview,
  type BudgetScenarioReview,
  type ConsultationAnswerStatus,
  type ConsultationHumanReview,
  type ConsultationResponseDisposition,
  type ImageObservationDisposition,
  type ImageObservationPriority,
  type ImageObservationReview,
  type MaterialCheckFieldStatus,
  type MaterialCheckReview,
  type ProjectSummaryHandoffStatus,
  type ProjectSummaryHumanReview,
  type ProjectSummaryScope,
  type RecordReviewReview,
  type RectificationCheckStatus,
  type RectificationHumanReview
} from "../../core/ai-contract"
import {
  apiRequest,
  cancelAiJob,
  readAiJob,
  retryAiJob,
  runAi,
  serviceConfig
} from "../../core/ai-client"
import { buildAiSourcePlan, type AiSourceChoice } from "../../core/ai-sources"
import { ROOMS, STAGES, type ProjectStage } from "../../core/domain"
import {
  applyConsultation,
  applyBudgetEstimate,
  applyImageObservation,
  applyProjectSummary,
  applyRecordReview,
  applyRectification,
  assertAiWritebackCurrent,
  assertMaterialCheckWritebackCurrent,
  currentProject,
  loadState,
  makeId,
  saveMaterialCheckRecord
} from "../../core/store"
import type { KnowledgeCard } from "../../core/knowledge"
import { calculateBudgetScenario } from "../../core/budget"
import { formatQuantityMilli } from "../../core/precision"

const MATERIAL_STATUS_OPTIONS: Array<{ value: MaterialCheckFieldStatus; label: string }> = [
  { value: "matches", label: "一致（待人工确认）" },
  { value: "differs", label: "有差异" },
  { value: "observed_only", label: "只有现场观察" },
  { value: "expected_only", label: "只有期望基线" },
  { value: "unknown", label: "未知 / 无法比较" }
]

const IMAGE_DISPOSITION_OPTIONS: Array<{ value: ImageObservationDisposition; label: string }> = [
  { value: "saved", label: "保留为观察" },
  { value: "issue", label: "转为待确认问题" },
  { value: "ignored", label: "忽略此条" }
]

const IMAGE_PRIORITY_OPTIONS: Array<{ value: ImageObservationPriority; label: string }> = [
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" }
]

const RECTIFICATION_STATUS_OPTIONS: Array<{ value: RectificationCheckStatus; label: string }> = [
  { value: "visible_improved", label: "画面可见已有改善" },
  { value: "concern_remains", label: "仍有待确认现象" },
  { value: "not_verifiable", label: "现有资料无法复查" }
]

const CONSULTATION_DISPOSITION_OPTIONS: Array<{
  value: ConsultationResponseDisposition
  label: string
}> = [
  { value: "saved", label: "仅保存整理" },
  { value: "proposal", label: "转为待选预案" },
  { value: "ignored", label: "忽略此条" }
]

const CONSULTATION_STATUS_OPTIONS: Array<{ value: ConsultationAnswerStatus; label: string }> = [
  { value: "answered", label: "已回答" },
  { value: "partial", label: "部分回答" },
  { value: "unanswered", label: "未回答" },
  { value: "conflicting", label: "回复有冲突" }
]

const SUMMARY_HANDOFF_STATUS_OPTIONS: Array<{
  value: ProjectSummaryHandoffStatus
  label: string
}> = [
  { value: "ready", label: "资料已备齐" },
  { value: "pending", label: "仍待推进" },
  { value: "missing", label: "资料缺失" }
]

const SUMMARY_ITEM_STATUS_LABEL: Record<string, string> = {
  completed: "已完成（按所选资料）",
  in_progress: "进行中",
  pending_confirmation: "待确认",
  blocked: "受阻",
  information_gap: "信息缺口"
}

type ModeOption = { value: AiTaskMode; label: string; hint: string }

function modeOptions(task: string): ModeOption[] {
  if (task === "rectification") {
    return [
      { value: "proposal", label: "拟处理预案", hint: "整理可选做法，只生成待选预案" },
      { value: "review", label: "复查参考", hint: "对照处理前后资料，只保存人工复查参考" }
    ]
  }
  if (task === "consultation") {
    return [
      { value: "prepare", label: "准备咨询", hint: "把已有资料整理为未发布咨询草稿" },
      { value: "response", label: "整理回复", hint: "把已回填回复逐题整理，按人工选择留档或转预案" }
    ]
  }
  return []
}

const EVIDENCE_KIND_LABEL: Record<string, string> = {
  visible_in_image: "图片可见",
  user_statement: "用户陈述",
  reported_statement: "转述",
  document_text: "文档文字"
}

type MaterialReviewView = MaterialCheckReview["fields"][number] & {
  label: string
  statusIndex: number
  statusLabel: string
  observedSourceIds: string[]
  expectedSourceIds: string[]
  originalObservedValue: string
  originalExpectedValue: string
  originalStatusLabel: string
}

function materialReviewView(job: AiJob | null): MaterialReviewView[] {
  const original = job?.result?.materialCheck
  if (!original) return []
  const reviewed = new Map(job.materialReview?.fields.map(field => [field.key, field]) || [])
  return original.fields.map(field => {
    const current = reviewed.get(field.key) || field
    const statusIndex = Math.max(0, MATERIAL_STATUS_OPTIONS.findIndex(item => item.value === current.status))
    const originalStatus = MATERIAL_STATUS_OPTIONS.find(item => item.value === field.status)?.label || field.status
    return {
      key: field.key,
      label: field.label,
      observedValue: current.observedValue,
      expectedValue: current.expectedValue,
      status: current.status,
      note: current.note,
      statusIndex,
      statusLabel: MATERIAL_STATUS_OPTIONS[statusIndex].label,
      observedSourceIds: [...field.observedSourceIds],
      expectedSourceIds: [...field.expectedSourceIds],
      originalObservedValue: field.observedValue,
      originalExpectedValue: field.expectedValue,
      originalStatusLabel: originalStatus
    }
  })
}

type RecordLineView = RecordReviewReview["facts"][number] & {
  evidence: string
  sourceIds: string[]
}

type RecordReviewView = {
  title: string
  note: string
  roomIndex: number
  stageIndex: number
  occurredDate: string
  targetLabel: string
  facts: RecordLineView[]
  opinions: RecordLineView[]
}

type ImageReviewView = ImageObservationReview["items"][number] & {
  object: string
  imageId: string
  sourceId: string
  regionLabel: string
  dispositionIndex: number
  dispositionLabel: string
  priorityIndex: number
  priorityLabel: string
  limitationsText: string
  captureSuggestionsText: string
  originalObservation: string
  originalExplanation: string
  originalPriorityLabel: string
}

function dateValue(iso = new Date().toISOString()): string {
  const parsed = new Date(iso)
  const value = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")
  return `${value.getFullYear()}-${month}-${day}`
}

function dateToIso(value: string): string {
  const parts = value.split("-").map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0)
  if (parts.length !== 3 || Number.isNaN(date.getTime())) throw new Error("发生日期不正确")
  return date.toISOString()
}

function dateDaysAgo(days: number): string {
  const value = new Date()
  value.setDate(value.getDate() - days)
  return dateValue(value.toISOString())
}

const JOB_STATUS_LABELS: Record<AiJob["status"], string> = {
  running: "分析中",
  succeeded: "待复核",
  failed: "分析失败",
  cancelled: "已取消"
}
const jobStatusLabel = (job: AiJob): string => {
  if (job.status !== "succeeded") return JOB_STATUS_LABELS[job.status]
  if (job.decision === "accepted") return "已采纳"
  if (job.decision === "dismissed") return "未采纳"
  return JOB_STATUS_LABELS.succeeded
}

const jobStatusClass = (job: AiJob): string => {
  if (job.status === "running") return "status-running"
  if (job.status === "failed") return "status-failed"
  if (job.status === "cancelled" || job.decision === "dismissed") return "status-muted"
  if (job.decision === "accepted") return "status-accepted"
  return "status-review"
}

type AiJobView = AiJob & { label: string; statusLabel: string; statusClass: string }
const jobView = (job: AiJob): AiJobView => ({
  ...job,
  label: AI_TASKS.find(task => task.id === job.task)?.label || job.task,
  statusLabel: jobStatusLabel(job),
  statusClass: jobStatusClass(job)
})
const wait = (durationMs: number) => new Promise<void>(resolve => setTimeout(resolve, durationMs))

function lines(value: string): string[] {
  return value.split(/\n|；/).map(item => item.trim()).filter(Boolean)
}

function sourceSnapshots(sources: AiSource[]): AiSourceSnapshotReference[] {
  return sources.map(source => ({
    sourceId: source.id,
    kind: source.kind,
    version: source.version,
    authority: source.authority,
    relatedMaterialId: source.relatedMaterialId,
    relatedConsultationId: source.relatedConsultationId
  }))
}

function recordReviewView(job: AiJob | null, target?: AiTarget): RecordReviewView {
  const original = job?.result?.recordReview
  const reviewed = job?.recordReviewReview
  const factRoom = original?.facts.find(item => item.roomCandidate.trim())?.roomCandidate || ""
  const factStage = original?.facts.find(item => item.stageCandidate.trim())?.stageCandidate || ""
  const room = reviewed?.room || factRoom
  const stage = reviewed?.stage || factStage || currentProject()?.stage || STAGES[0]
  const targetRecord = target
    ? loadState().records.find(item => item.id === target.id)
    : undefined
  return {
    title: reviewed?.title || original?.title || "",
    note: reviewed?.note || "",
    roomIndex: Math.max(0, ROOMS.indexOf(room as typeof ROOMS[number])),
    stageIndex: Math.max(0, STAGES.indexOf(stage as ProjectStage)),
    occurredDate: dateValue(reviewed?.occurredAt || original?.time.candidateDate),
    targetLabel: targetRecord
      ? `修订《${targetRecord.title}》v${target?.version || targetRecord.version}`
      : "创建一条新的现场记录",
    facts: (original?.facts || []).map((item, sourceIndex) => {
      const current = reviewed?.facts.find(line => line.sourceIndex === sourceIndex)
      return {
        sourceIndex,
        included: current?.included ?? true,
        text: current?.text || item.text,
        evidence: EVIDENCE_KIND_LABEL[item.evidenceKind] || item.evidenceKind,
        sourceIds: [...item.sourceIds]
      }
    }),
    opinions: (original?.opinions || []).map((item, sourceIndex) => {
      const current = reviewed?.opinions.find(line => line.sourceIndex === sourceIndex)
      return {
        sourceIndex,
        included: current?.included ?? true,
        text: current?.text || item.text,
        evidence: item.speaker ? `意见方：${item.speaker}` : "意见",
        sourceIds: [...item.sourceIds]
      }
    })
  }
}

function imageReviewView(job: AiJob | null): ImageReviewView[] {
  const original = job?.result?.imageObservation
  if (!original) return []
  const reviewed = new Map(job.imageObservationReview?.items.map(item => [item.itemId, item]) || [])
  return original.items.map(item => {
    const current = reviewed.get(item.itemId)
    const disposition = current?.disposition || "saved"
    const priority = current?.priority || item.priority
    const dispositionIndex = Math.max(0, IMAGE_DISPOSITION_OPTIONS.findIndex(option => option.value === disposition))
    const priorityIndex = Math.max(0, IMAGE_PRIORITY_OPTIONS.findIndex(option => option.value === priority))
    return {
      itemId: item.itemId,
      object: item.object,
      imageId: item.imageId,
      sourceId: item.sourceId,
      regionLabel: item.region
        ? `区域 x ${item.region.x.toFixed(2)} · y ${item.region.y.toFixed(2)} · 宽 ${item.region.width.toFixed(2)} · 高 ${item.region.height.toFixed(2)}`
        : "整张图片",
      disposition,
      dispositionIndex,
      dispositionLabel: IMAGE_DISPOSITION_OPTIONS[dispositionIndex].label,
      observation: current?.observation || item.observation,
      suspectedExplanation: current?.suspectedExplanation || item.suspectedExplanation,
      limitations: current?.limitations || [...item.limitations],
      limitationsText: (current?.limitations || item.limitations).join("\n"),
      captureSuggestions: current?.captureSuggestions || [...item.captureSuggestions],
      captureSuggestionsText: (current?.captureSuggestions || item.captureSuggestions).join("\n"),
      priority,
      priorityIndex,
      priorityLabel: IMAGE_PRIORITY_OPTIONS[priorityIndex].label,
      originalObservation: item.observation,
      originalExplanation: item.suspectedExplanation,
      originalPriorityLabel: IMAGE_PRIORITY_OPTIONS.find(option => option.value === item.priority)?.label || item.priority,
      priorityReason: current?.priorityReason || item.priorityReason,
      issueTitle: current?.issueTitle || `待确认：${item.object || item.observation.slice(0, 18)}`
    }
  })
}

type RectificationProposalView = {
  optionId: string
  included: boolean
  title: string
  content: string
  originalSummary: string
}

type RectificationCheckView = {
  checkId: string
  included: boolean
  requirement: string
  status: RectificationCheckStatus
  statusIndex: number
  statusLabel: string
  observation: string
  limitationsText: string
  nextStepsText: string
  originalSummary: string
}

function rectificationReviewView(job: AiJob | null): {
  proposals: RectificationProposalView[]
  checks: RectificationCheckView[]
  note: string
} {
  const original = job?.result?.rectification
  const review = job?.rectificationReview
  if (!original) return { proposals: [], checks: [], note: "" }
  if (original.mode === "proposal") {
    const saved = review?.mode === "proposal"
      ? new Map(review.items.map(item => [item.optionId, item]))
      : new Map<string, never>()
    return {
      proposals: original.proposals.map(item => {
        const current = saved.get(item.optionId)
        const content = [
          ...item.actions.map(value => `操作：${value}`),
          ...item.applicability.map(value => `适用前提：${value}`),
          ...item.impacts.map(value => `影响：${value}`),
          item.costAndSchedule ? `费用与工期：${item.costAndSchedule}` : "",
          ...item.verificationEvidence.map(value => `复查证据：${value}`)
        ].filter(Boolean).join("\n")
        return {
          optionId: item.optionId,
          included: current?.included ?? true,
          title: current?.title || item.title,
          content: current?.content || content,
          originalSummary: `${item.title} · 来源 ${item.sourceIds.join("、") || "未标明"}`
        }
      }),
      checks: [],
      note: review?.mode === "proposal" ? review.note : ""
    }
  }
  const saved = review?.mode === "review"
    ? new Map(review.items.map(item => [item.checkId, item]))
    : new Map<string, never>()
  return {
    proposals: [],
    checks: original.checks.map(item => {
      const current = saved.get(item.checkId)
      const status = current?.status || item.status
      const statusIndex = Math.max(0,
        RECTIFICATION_STATUS_OPTIONS.findIndex(option => option.value === status))
      return {
        checkId: item.checkId,
        included: current?.included ?? true,
        requirement: current?.requirement || item.requirement,
        status,
        statusIndex,
        statusLabel: RECTIFICATION_STATUS_OPTIONS[statusIndex].label,
        observation: current?.observation || item.observation,
        limitationsText: (current?.limitations || item.limitations).join("\n"),
        nextStepsText: (current?.nextSteps || item.nextSteps).join("\n"),
        originalSummary: `AI 原始状态：${RECTIFICATION_STATUS_OPTIONS.find(option =>
          option.value === item.status)?.label || item.status}`
      }
    }),
    note: review?.mode === "review" ? review.note : ""
  }
}

type ConsultationLineView = {
  sourceIndex: number
  included: boolean
  text: string
  sourceIds: string[]
}

type ConsultationIssueOption = { id: string; title: string }

type ConsultationMappingView = {
  mappingId: string
  question: string
  disposition: ConsultationResponseDisposition
  dispositionIndex: number
  dispositionLabel: string
  status: ConsultationAnswerStatus
  statusIndex: number
  statusLabel: string
  summary: string
  conditionsText: string
  conflictsText: string
  followUpsText: string
  targetIssueSourceId: string
  issueIndex: number
  proposalContent: string
  sourceIds: string[]
}

function consultationReviewView(job: AiJob | null, sources: AiSource[]): {
  title: string
  purpose: string
  facts: ConsultationLineView[]
  timeline: ConsultationLineView[]
  disputes: ConsultationLineView[]
  gapsText: string
  questions: ConsultationLineView[]
  mappings: ConsultationMappingView[]
  issueOptions: ConsultationIssueOption[]
  note: string
} {
  const original = job?.result?.consultation
  const review = job?.consultationReview
  const issueOptions = [
    { id: "", title: "不关联问题" },
    ...sources.filter(source => source.kind === "issue")
      .map(source => ({ id: source.id, title: source.title }))
  ]
  const empty = {
    title: "", purpose: "", facts: [], timeline: [], disputes: [], gapsText: "",
    questions: [], mappings: [], issueOptions, note: ""
  }
  if (!original) return empty
  if (original.mode === "prepare") {
    const saved = review?.mode === "prepare" ? review : undefined
    const reviewLines = (
      values: Array<{ text: string; sourceIds: string[] }>,
      savedLines: Array<{
        sourceIndex: number
        included: boolean
        text: string
      }> | undefined = []
    ): ConsultationLineView[] => values.map((item, sourceIndex) => {
      const current = savedLines?.find(line => line.sourceIndex === sourceIndex)
      return {
        sourceIndex,
        included: current?.included ?? true,
        text: current?.text || item.text,
        sourceIds: [...item.sourceIds]
      }
    })
    return {
      ...empty,
      title: saved?.title || original.title,
      purpose: saved?.purpose || original.purpose,
      facts: reviewLines(original.facts, saved?.facts),
      timeline: reviewLines(original.timeline, saved?.timeline),
      disputes: reviewLines(original.disputes, saved?.disputes),
      gapsText: (saved?.gaps || original.gaps).join("\n"),
      questions: reviewLines(
        original.questions.map(item => ({ text: item.text, sourceIds: item.sourceIds })),
        saved?.questions
      ),
      note: saved?.note || ""
    }
  }
  const saved = review?.mode === "response"
    ? new Map(review.mappings.map(item => [item.mappingId, item]))
    : new Map<string, never>()
  return {
    ...empty,
    gapsText: original.gaps.join("\n"),
    mappings: original.mappings.map(item => {
      const current = saved.get(item.mappingId)
      const disposition = current?.disposition || "saved"
      const status = current?.status || item.status
      const dispositionIndex = Math.max(0,
        CONSULTATION_DISPOSITION_OPTIONS.findIndex(option => option.value === disposition))
      const statusIndex = Math.max(0,
        CONSULTATION_STATUS_OPTIONS.findIndex(option => option.value === status))
      const targetIssueSourceId = current?.targetIssueSourceId || item.targetIssueSourceId
      return {
        mappingId: item.mappingId,
        question: item.question,
        disposition,
        dispositionIndex,
        dispositionLabel: CONSULTATION_DISPOSITION_OPTIONS[dispositionIndex].label,
        status,
        statusIndex,
        statusLabel: CONSULTATION_STATUS_OPTIONS[statusIndex].label,
        summary: current?.summary || item.summary,
        conditionsText: (current?.conditions || item.conditions).join("\n"),
        conflictsText: (current?.conflicts || item.conflicts).join("\n"),
        followUpsText: (current?.followUps || item.followUps).join("\n"),
        targetIssueSourceId,
        issueIndex: Math.max(0, issueOptions.findIndex(option => option.id === targetIssueSourceId)),
        proposalContent: current?.proposalContent || item.summary,
        sourceIds: [...item.responseSourceIds]
      }
    }),
    note: review?.mode === "response" ? review.note : ""
  }
}

const BUDGET_WASTE_OPTIONS: Array<{
  value: BudgetScenarioReview["requirementIncludesWaste"]
  label: string
}> = [
  { value: "no", label: "需求量未含损耗，另行加损耗" },
  { value: "yes", label: "需求量已经含损耗，不重复增加" }
]

type BudgetScenarioView = BudgetScenarioReview & {
  wasteIndex: number
  wasteLabel: string
  originalSummary: string
  totalLabel: string
  gapLabel: string
  purchaseLabel: string
  warningLabel: string
  previewError: string
}

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`

function withBudgetPreview(review: BudgetScenarioReview, originalSummary: string): BudgetScenarioView {
  const wasteIndex = Math.max(0, BUDGET_WASTE_OPTIONS.findIndex(item =>
    item.value === review.requirementIncludesWaste))
  const base = {
    ...review,
    wasteIndex,
    wasteLabel: BUDGET_WASTE_OPTIONS[wasteIndex].label,
    originalSummary,
    totalLabel: "",
    gapLabel: "",
    purchaseLabel: "",
    warningLabel: "",
    previewError: ""
  }
  if (!review.included) return { ...base, previewError: "当前方案未纳入保存" }
  const project = currentProject()
  if (!project) return { ...base, previewError: "当前项目不存在" }
  try {
    const value = calculateBudgetScenario(loadState(), project.id, review)
    const total = value.totalRequirement
    const totalLabel = `含损耗需求 ${formatQuantityMilli(total.quantityWithWasteMilli)} ${value.unit}`
      + ` · 按整包共 ${total.packageCount} 包 / ${formatQuantityMilli(total.purchaseQuantityMilli)} ${value.unit}`
      + ` · ${total.amountFen === undefined ? "单价未知，不计算金额" : money(total.amountFen)}`
    const gapLabel = !value.materialId
      ? "未关联项目材料：本方案不扣除库存、已用和在途量"
      : value.resourceGap
        ? `尚缺 ${formatQuantityMilli(value.resourceGap.minimumGapMilli)}–${formatQuantityMilli(value.resourceGap.maximumGapMilli)} ${value.unit}`
          + ` · 待核实 ${formatQuantityMilli(value.resourceGap.pendingVerificationMilli)} ${value.unit}`
        : "资源单位或到货数据不完整：暂不计算剩余缺口"
    const purchaseLabel = value.recommendedPurchase
      ? `按缺口上限建议 ${value.recommendedPurchase.packageCount} 包 / ${formatQuantityMilli(value.recommendedPurchase.purchaseQuantityMilli)} ${value.unit}`
        + ` · ${value.recommendedPurchase.amountFen === undefined ? "金额未知" : money(value.recommendedPurchase.amountFen)}`
      : "资料未闭合，不生成采购数量建议"
    return {
      ...base,
      totalLabel,
      gapLabel,
      purchaseLabel,
      warningLabel: value.resourceFacts?.warnings.join("；") || ""
    }
  } catch (error) {
    return {
      ...base,
      previewError: error instanceof Error ? error.message : "参数尚不完整"
    }
  }
}

function budgetReviewView(job: AiJob | null): { scenarios: BudgetScenarioView[]; note: string } {
  const original = job?.result?.budget
  if (!original) return { scenarios: [], note: "" }
  const saved = new Map(job.budgetReview?.scenarios.map(item => [item.scenarioId, item]) || [])
  return {
    scenarios: original.scenarios.map(item => {
      const current = saved.get(item.scenarioId)
      const requiredObserved = item.requiredQuantity.status === "observed"
        && item.wasteRatePercent.status === "observed"
        && item.packageSize.status === "observed"
        && ["yes", "no"].includes(item.requirementIncludesWaste.value)
      const hasAssumption = [
        item.requiredQuantity.status,
        item.wasteRatePercent.status,
        item.packageSize.status,
        item.packageUnitPriceYuan.status
      ].includes("assumption") || item.assumptions.length > 0
      const review: BudgetScenarioReview = current || {
        scenarioId: item.scenarioId,
        included: requiredObserved && !hasAssumption && !item.conflicts.length,
        label: item.label,
        materialSourceId: item.materialSourceId,
        unit: item.unit,
        requiredQuantity: item.requiredQuantity.value,
        wasteRatePercent: item.wasteRatePercent.value,
        requirementIncludesWaste: item.requirementIncludesWaste.value === "yes" ? "yes" : "no",
        packageSize: item.packageSize.value,
        packageUnitPriceYuan: item.packageUnitPriceYuan.value,
        note: ""
      }
      const originalSummary = [
        `需求量：${item.requiredQuantity.status}`,
        `损耗率：${item.wasteRatePercent.status}`,
        `损耗口径：${item.requirementIncludesWaste.value}`,
        `包装：${item.packageSize.status}`,
        `单价：${item.packageUnitPriceYuan.status}`,
        item.missingFields.length ? `缺失：${item.missingFields.join("、")}` : "",
        item.conflicts.length ? `冲突：${item.conflicts.join("；")}` : "",
        item.assumptions.length ? `假设：${item.assumptions.join("；")}` : ""
      ].filter(Boolean).join(" · ")
      return withBudgetPreview(review, originalSummary)
    }),
    note: job.budgetReview?.note || ""
  }
}

type ProjectSummarySectionView = ProjectSummaryHumanReview["sections"][number] & {
  originalSummary: string
}

type ProjectSummaryHandoffView = ProjectSummaryHumanReview["handoff"][number] & {
  statusIndex: number
  statusLabel: string
  sourceIds: string[]
}

function projectSummaryReviewView(job: AiJob | null): {
  title: string
  scopeStatement: string
  sections: ProjectSummarySectionView[]
  handoff: ProjectSummaryHandoffView[]
  note: string
} {
  const original = job?.result?.projectSummary
  const review = job?.projectSummaryReview
  if (!original) return { title: "", scopeStatement: "", sections: [], handoff: [], note: "" }
  const reviewedSections = new Map(review?.sections.map(item => [item.key, item]) || [])
  const reviewedHandoff = new Map(review?.handoff.map(item => [item.itemId, item]) || [])
  return {
    title: review?.title || original.title,
    scopeStatement: review?.scopeStatement || original.scopeStatement,
    sections: original.sections.map(section => {
      const saved = reviewedSections.get(section.key)
      const content = [
        ...section.items.map(item => `[${SUMMARY_ITEM_STATUS_LABEL[item.status] || item.status}] ${item.text}`),
        ...section.gaps.map(item => `资料缺口：${item}`)
      ].join("\n")
      return {
        key: section.key,
        included: saved?.included ?? true,
        title: saved?.title || section.title,
        content: saved?.content || content || "本分区暂无可引用事实。",
        originalSummary: `${section.items.length} 条事实 · ${section.gaps.length} 个资料缺口`
      }
    }),
    handoff: original.handoff.map(item => {
      const saved = reviewedHandoff.get(item.itemId)
      const status = saved?.status || item.status
      const statusIndex = Math.max(0,
        SUMMARY_HANDOFF_STATUS_OPTIONS.findIndex(option => option.value === status))
      return {
        itemId: item.itemId,
        included: saved?.included ?? true,
        text: saved?.text || item.text,
        status,
        statusIndex,
        statusLabel: SUMMARY_HANDOFF_STATUS_OPTIONS[statusIndex].label,
        sourceIds: [...item.sourceIds]
      }
    }),
    note: review?.note || ""
  }
}

function localImagePaths(imageRefs: AiImageReference[]): Array<{ id: string; sourceId: string; path: string }> {
  const state = loadState()
  return imageRefs.flatMap(ref => {
    const record = state.records.find(item => item.id === ref.sourceId)
    const image = record?.attachments.find(item => item.id === ref.id && item.type === "image")
    return image ? [{ id: ref.id, sourceId: ref.sourceId, path: image.localPath }] : []
  })
}

Page({
  data: {
    projectId: "", projectName: "", hasProject: false,
    preselectedRecordId: "", preselectedMaterialId: "", preselectedReceiptId: "",
    preselectedIssueId: "", preselectedConsultationId: "",
    requestedSummaryStage: "", requestedSummaryRoom: "",
    fixedTask: false, fixedMode: false, entryWarning: "", serviceReady: false,
    tasks: AI_TASKS, taskIndex: 0, question: "", busy: false, cancelling: false, error: "",
    showTaskPanel: false,
    intentText: "",
    intentSuggestions: [
      { label: "核对材料到货", prompt: "核对今天到货材料的型号、数量、包装和可见异常" },
      { label: "整理现场记录", prompt: "把刚保存的现场资料整理成事实、转述和待补信息" },
      { label: "看看图片疑点", prompt: "观察选中图片里的可见现象，列出待核实项和补拍建议" },
      { label: "准备整改方案", prompt: "基于已记录的问题和证据，整理可选预案与复查重点" }
    ],
    modeOptions: [] as ModeOption[], modeIndex: 0,
    readOnly: false,
    choices: [] as AiSourceChoice[],
    images: [] as Array<{ sourceId: string; path: string; selected: boolean; id: string }>,
    selectedCount: 0, imageCount: 0,
    jobs: [] as AiJobView[], usageSummary: "今日任务 0/20",
    selected: null as AiJob | null, selectedStatusLabel: "", activeJobId: "",
    correction: "",
    materialStatusOptions: MATERIAL_STATUS_OPTIONS,
    materialReviewFields: [] as MaterialReviewView[],
    rooms: ROOMS,
    stages: STAGES,
    recordDraftTitle: "",
    recordDraftNote: "",
    recordRoomIndex: 0,
    recordStageIndex: 0,
    recordOccurredDate: dateValue(),
    recordTargetLabel: "",
    recordFactLines: [] as RecordLineView[],
    recordOpinionLines: [] as RecordLineView[],
    imageDispositionOptions: IMAGE_DISPOSITION_OPTIONS,
    imagePriorityOptions: IMAGE_PRIORITY_OPTIONS,
    imageReviewItems: [] as ImageReviewView[],
    reviewImages: [] as Array<{ id: string; sourceId: string; path: string }>,
    rectificationStatusOptions: RECTIFICATION_STATUS_OPTIONS,
    rectificationProposalItems: [] as RectificationProposalView[],
    rectificationCheckItems: [] as RectificationCheckView[],
    rectificationNote: "",
    consultationDispositionOptions: CONSULTATION_DISPOSITION_OPTIONS,
    consultationStatusOptions: CONSULTATION_STATUS_OPTIONS,
    consultationDraftTitle: "",
    consultationDraftPurpose: "",
    consultationFactLines: [] as ConsultationLineView[],
    consultationTimelineLines: [] as ConsultationLineView[],
    consultationDisputeLines: [] as ConsultationLineView[],
    consultationGapsText: "",
    consultationQuestionLines: [] as ConsultationLineView[],
    consultationMappings: [] as ConsultationMappingView[],
    consultationIssueOptions: [] as ConsultationIssueOption[],
    consultationNote: "",
    budgetWasteOptions: BUDGET_WASTE_OPTIONS,
    budgetScenarioItems: [] as BudgetScenarioView[],
    budgetNote: "",
    summaryStageOptions: ["全部工序", ...STAGES] as string[],
    summaryRoomOptions: ["全部房间", ...ROOMS] as string[],
    summaryStageIndex: 0,
    summaryRoomIndex: 0,
    summaryTitle: "",
    summaryPurpose: "阶段复盘与后续交接",
    summaryAudience: "项目参与者",
    summaryUseDateRange: false,
    summaryDateFrom: dateDaysAgo(30),
    summaryDateTo: dateValue(),
    summaryHandoffStatusOptions: SUMMARY_HANDOFF_STATUS_OPTIONS,
    summaryDraftTitle: "",
    summaryScopeStatement: "",
    summarySectionItems: [] as ProjectSummarySectionView[],
    summaryHandoffItems: [] as ProjectSummaryHandoffView[],
    summaryNote: "",
    baseUrl: "", serviceToken: "", citations: [] as Array<{ id: string; title: string; text: string }>,
    evidenceSources: [] as AiSource[],
    evidenceImages: [] as AiImageReference[],
    evidenceTarget: null as AiTarget | null,
    evidenceSummaryScope: null as ProjectSummaryScope | null,
    applicationNotice: ""
  },
  onLoad(options: {
    recordId?: string
    materialId?: string
    receiptId?: string
    issueId?: string
    consultationId?: string
    task?: string
    mode?: string
    stage?: string
    room?: string
  }) {
    const config = serviceConfig()
    const requestedTaskIndex = AI_TASKS.findIndex(task => task.id === options.task)
    const selectedTask = AI_TASKS[requestedTaskIndex >= 0 ? requestedTaskIndex : 0].id
    const availableModes = modeOptions(selectedTask)
    const requestedModeIndex = availableModes.findIndex(mode => mode.value === options.mode)
    const requestedSummaryStage = STAGES.includes(options.stage as ProjectStage) ? options.stage || "" : ""
    const requestedSummaryRoom = (options.room || "").trim()
    const summaryStageOptions = ["全部工序", ...STAGES]
    const summaryRoomOptions = [
      "全部房间",
      ...(requestedSummaryRoom && !(ROOMS as readonly string[]).includes(requestedSummaryRoom) ? [requestedSummaryRoom] : []),
      ...ROOMS
    ]
    this.setData({
      preselectedRecordId: options.recordId || "",
      preselectedMaterialId: options.materialId || "",
      preselectedReceiptId: options.receiptId || "",
      preselectedIssueId: options.issueId || "",
      preselectedConsultationId: options.consultationId || "",
      taskIndex: requestedTaskIndex >= 0 ? requestedTaskIndex : 0,
      fixedTask: requestedTaskIndex >= 0,
      showTaskPanel: requestedTaskIndex >= 0,
      modeOptions: availableModes,
      modeIndex: requestedModeIndex >= 0 ? requestedModeIndex : 0,
      fixedMode: requestedModeIndex >= 0,
      requestedSummaryStage,
      requestedSummaryRoom,
      summaryStageOptions,
      summaryRoomOptions,
      summaryStageIndex: requestedSummaryStage ? summaryStageOptions.indexOf(requestedSummaryStage) : 0,
      summaryRoomIndex: requestedSummaryRoom ? summaryRoomOptions.indexOf(requestedSummaryRoom) : 0,
      baseUrl: config.baseUrl,
      serviceToken: config.token,
      serviceReady: Boolean(config.token)
    })
  },
  onShow() {
    this.refreshSources()
    this.refreshJobs()
  },
  onUnload() { this.setData({ activeJobId: "" }) },
  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/dashboard/index" }) })
  },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  onIntentInput(e: WechatMiniprogram.TextareaInput) {
    this.setData({ intentText: e.detail.value })
  },
  useIntentSuggestion(e: WechatMiniprogram.TouchEvent) {
    this.setData({ intentText: String(e.currentTarget.dataset.prompt || "") })
  },
  openTaskPanel() {
    this.setData({ showTaskPanel: true })
  },
  closeTaskPanel() {
    if (this.data.fixedTask) return
    this.setData({ showTaskPanel: false })
  },
  prepareIntent() {
    const intent = this.data.intentText.trim()
    if (!intent) {
      wx.showToast({ title: "先描述需要协助的事情", icon: "none" })
      return
    }
    const rules: Array<{ task: string; keywords: string[] }> = [
      { task: "material_check", keywords: ["材料", "到货", "型号", "数量", "包装", "破损"] },
      { task: "image_observation", keywords: ["图片", "照片", "裂缝", "渗水", "现象", "补拍"] },
      { task: "rectification", keywords: ["整改", "问题", "复查", "预案"] },
      { task: "budget", keywords: ["预算", "费用", "金额", "采购", "多少钱"] },
      { task: "consultation", keywords: ["咨询", "请教", "监理", "专业人员"] },
      { task: "project_summary", keywords: ["总结", "复盘", "交接", "报告"] },
      { task: "record_review", keywords: ["记录", "整理", "事实", "语音"] }
    ]
    const matched = rules.find(rule => rule.keywords.some(keyword => intent.includes(keyword)))
    const taskIndex = Math.max(0, AI_TASKS.findIndex(task => task.id === (matched?.task || "record_review")))
    const availableModes = modeOptions(AI_TASKS[taskIndex].id)
    this.setData({
      taskIndex,
      question: intent,
      showTaskPanel: true,
      fixedTask: false,
      fixedMode: false,
      modeOptions: availableModes,
      modeIndex: 0,
      choices: [],
      images: [],
      selectedCount: 0,
      imageCount: 0,
      selected: null,
      citations: [],
      evidenceSources: [],
      evidenceImages: [],
      evidenceTarget: null,
      evidenceSummaryScope: null,
      entryWarning: "",
      applicationNotice: ""
    })
    this.refreshSources()
  },
  refreshSources() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({
        projectId: "",
        projectName: "",
        hasProject: false,
        readOnly: true,
        choices: [],
        images: [],
        entryWarning: "",
        selectedCount: 0,
        imageCount: 0,
        jobs: [],
        selected: null,
        materialReviewFields: [],
        recordFactLines: [],
        recordOpinionLines: [],
        imageReviewItems: [],
        reviewImages: [],
        rectificationProposalItems: [],
        rectificationCheckItems: [],
        rectificationNote: "",
        consultationDraftTitle: "",
        consultationDraftPurpose: "",
        consultationFactLines: [],
        consultationTimelineLines: [],
        consultationDisputeLines: [],
        consultationGapsText: "",
        consultationQuestionLines: [],
        consultationMappings: [],
        consultationIssueOptions: [],
        consultationNote: "",
        budgetScenarioItems: [],
        budgetNote: "",
        summaryDraftTitle: "",
        summaryScopeStatement: "",
        summarySectionItems: [],
        summaryHandoffItems: [],
        summaryNote: "",
        citations: [],
        evidenceSources: [],
        evidenceImages: [],
        evidenceTarget: null,
        evidenceSummaryScope: null,
        applicationNotice: ""
      })
      return
    }
    const projectChanged = this.data.projectId !== project.id
    const selectedMode = this.data.modeOptions[this.data.modeIndex]?.value
    const selectedTask = AI_TASKS[this.data.taskIndex].id
    const summaryScope: ProjectSummaryScope | undefined = selectedTask === "project_summary"
      ? {
        title: this.data.summaryTitle || `${project.name}阶段总结`,
        purpose: this.data.summaryPurpose,
        audience: this.data.summaryAudience,
        stage: this.data.summaryStageOptions[this.data.summaryStageIndex],
        room: this.data.summaryRoomOptions[this.data.summaryRoomIndex],
        dateFrom: this.data.summaryUseDateRange ? this.data.summaryDateFrom : "",
        dateTo: this.data.summaryUseDateRange ? this.data.summaryDateTo : "",
        cutoffAt: new Date().toISOString()
      }
      : undefined
    const plan = buildAiSourcePlan(state, project, {
      task: selectedTask,
      mode: selectedMode,
      recordId: this.data.preselectedRecordId,
      issueId: this.data.preselectedIssueId,
      consultationId: this.data.preselectedConsultationId,
      materialId: this.data.preselectedMaterialId,
      receiptId: this.data.preselectedReceiptId,
      ...(summaryScope ? { summaryScope } : {}),
      selectAllByDefault: selectedTask === "project_summary" && !this.data.choices.length,
      previousSelectedIds: projectChanged
        ? new Set<string>()
        : new Set(this.data.choices.filter(item => item.selected).map(item => item.id)),
      previousImageIds: projectChanged
        ? new Set<string>()
        : new Set(this.data.images.filter(item => item.selected).map(item => item.id))
    })
    this.setData({
      projectId: project.id,
      projectName: project.name,
      hasProject: true,
      readOnly: project.status === "archived",
      choices: plan.choices,
      selectedCount: plan.choices.filter(item => item.selected).length,
      entryWarning: plan.warning,
      selected: projectChanged ? null : this.data.selected,
      materialReviewFields: projectChanged ? [] : this.data.materialReviewFields,
      recordFactLines: projectChanged ? [] : this.data.recordFactLines,
      recordOpinionLines: projectChanged ? [] : this.data.recordOpinionLines,
      imageReviewItems: projectChanged ? [] : this.data.imageReviewItems,
      reviewImages: projectChanged ? [] : this.data.reviewImages,
      rectificationProposalItems: projectChanged ? [] : this.data.rectificationProposalItems,
      rectificationCheckItems: projectChanged ? [] : this.data.rectificationCheckItems,
      rectificationNote: projectChanged ? "" : this.data.rectificationNote,
      consultationDraftTitle: projectChanged ? "" : this.data.consultationDraftTitle,
      consultationDraftPurpose: projectChanged ? "" : this.data.consultationDraftPurpose,
      consultationFactLines: projectChanged ? [] : this.data.consultationFactLines,
      consultationTimelineLines: projectChanged ? [] : this.data.consultationTimelineLines,
      consultationDisputeLines: projectChanged ? [] : this.data.consultationDisputeLines,
      consultationGapsText: projectChanged ? "" : this.data.consultationGapsText,
      consultationQuestionLines: projectChanged ? [] : this.data.consultationQuestionLines,
      consultationMappings: projectChanged ? [] : this.data.consultationMappings,
      consultationIssueOptions: projectChanged ? [] : this.data.consultationIssueOptions,
      consultationNote: projectChanged ? "" : this.data.consultationNote,
      budgetScenarioItems: projectChanged ? [] : this.data.budgetScenarioItems,
      budgetNote: projectChanged ? "" : this.data.budgetNote,
      summaryTitle: projectChanged ? `${project.name}阶段总结` : this.data.summaryTitle,
      summaryStageIndex: projectChanged
        ? Math.max(0, this.data.summaryStageOptions.indexOf(this.data.requestedSummaryStage || project.stage))
        : this.data.summaryStageIndex,
      summaryRoomIndex: projectChanged
        ? Math.max(0, this.data.summaryRoomOptions.indexOf(this.data.requestedSummaryRoom))
        : this.data.summaryRoomIndex,
      summaryDraftTitle: projectChanged ? "" : this.data.summaryDraftTitle,
      summaryScopeStatement: projectChanged ? "" : this.data.summaryScopeStatement,
      summarySectionItems: projectChanged ? [] : this.data.summarySectionItems,
      summaryHandoffItems: projectChanged ? [] : this.data.summaryHandoffItems,
      summaryNote: projectChanged ? "" : this.data.summaryNote,
      citations: projectChanged ? [] : this.data.citations,
      evidenceSources: projectChanged ? [] : this.data.evidenceSources,
      evidenceImages: projectChanged ? [] : this.data.evidenceImages,
      evidenceTarget: projectChanged ? null : this.data.evidenceTarget,
      evidenceSummaryScope: projectChanged ? null : this.data.evidenceSummaryScope,
      applicationNotice: projectChanged ? "" : this.data.applicationNotice,
      images: plan.images,
      imageCount: plan.images.filter(item => item.selected).length
    })
  },
  selectTask(e: WechatMiniprogram.PickerChange) {
    if (this.data.fixedTask) return
    const taskIndex = Number(e.detail.value)
    const availableModes = modeOptions(AI_TASKS[taskIndex].id)
    this.setData({
      taskIndex, modeOptions: availableModes, modeIndex: 0, fixedMode: false,
      preselectedIssueId: "", preselectedConsultationId: "",
      choices: [], images: [], selectedCount: 0, imageCount: 0,
      selected: null, citations: [],
      evidenceSources: [], evidenceImages: [], evidenceTarget: null,
      evidenceSummaryScope: null,
      materialReviewFields: [], recordFactLines: [], recordOpinionLines: [],
      imageReviewItems: [], reviewImages: [],
      rectificationProposalItems: [], rectificationCheckItems: [], rectificationNote: "",
      consultationFactLines: [], consultationTimelineLines: [], consultationDisputeLines: [],
      consultationQuestionLines: [], consultationMappings: [], consultationIssueOptions: [],
      consultationDraftTitle: "", consultationDraftPurpose: "",
      consultationGapsText: "", consultationNote: "",
      budgetScenarioItems: [], budgetNote: "",
      summaryDraftTitle: "", summaryScopeStatement: "",
      summarySectionItems: [], summaryHandoffItems: [], summaryNote: "",
      applicationNotice: ""
    })
    this.refreshSources()
  },
  selectMode(e: WechatMiniprogram.PickerChange) {
    if (this.data.fixedMode) return
    this.setData({
      modeIndex: Number(e.detail.value),
      selected: null,
      citations: [],
      evidenceSources: [],
      evidenceImages: [],
      evidenceTarget: null,
      evidenceSummaryScope: null,
      rectificationProposalItems: [],
      rectificationCheckItems: [],
      consultationFactLines: [],
      consultationTimelineLines: [],
      consultationDisputeLines: [],
      consultationQuestionLines: [],
      consultationMappings: [],
      budgetScenarioItems: [],
      budgetNote: "",
      summaryDraftTitle: "",
      summaryScopeStatement: "",
      summarySectionItems: [],
      summaryHandoffItems: [],
      summaryNote: "",
      applicationNotice: ""
    })
    this.refreshSources()
  },
  onQuestion(e: WechatMiniprogram.TextareaInput) { this.setData({ question: e.detail.value }) },
  onSummaryHeader(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = e.currentTarget.dataset.field as "summaryTitle" | "summaryPurpose" | "summaryAudience"
    if (!["summaryTitle", "summaryPurpose", "summaryAudience"].includes(field)) return
    if (field === "summaryTitle") this.setData({ summaryTitle: e.detail.value })
    else if (field === "summaryPurpose") this.setData({ summaryPurpose: e.detail.value })
    else this.setData({ summaryAudience: e.detail.value })
  },
  onSummaryStage(e: WechatMiniprogram.PickerChange) {
    this.setData({ summaryStageIndex: Number(e.detail.value), choices: [] })
    this.refreshSources()
  },
  onSummaryRoom(e: WechatMiniprogram.PickerChange) {
    this.setData({ summaryRoomIndex: Number(e.detail.value), choices: [] })
    this.refreshSources()
  },
  onSummaryDateRange(e: WechatMiniprogram.SwitchChange) {
    this.setData({ summaryUseDateRange: e.detail.value, choices: [] })
    this.refreshSources()
  },
  onSummaryDate(e: WechatMiniprogram.PickerChange) {
    const field = e.currentTarget.dataset.field as "summaryDateFrom" | "summaryDateTo"
    if (!["summaryDateFrom", "summaryDateTo"].includes(field)) return
    if (field === "summaryDateFrom") {
      this.setData({ summaryDateFrom: String(e.detail.value), choices: [] })
    } else {
      this.setData({ summaryDateTo: String(e.detail.value), choices: [] })
    }
    this.refreshSources()
  },
  selectSources(e: WechatMiniprogram.CheckboxGroupChange) {
    const ids = new Set([
      ...e.detail.value,
      ...this.data.choices.filter(item => item.required).map(item => item.id)
    ])
    const images = this.data.images.map(item => ({ ...item, selected: item.selected && ids.has(item.sourceId) }))
    this.setData({
      choices: this.data.choices.map(item => ({ ...item, selected: ids.has(item.id) })),
      selectedCount: ids.size, images, imageCount: images.filter(item => item.selected).length
    })
  },
  selectImages(e: WechatMiniprogram.CheckboxGroupChange) {
    const ids = new Set(e.detail.value)
    const sourceIds = new Set(this.data.choices.filter(item => item.selected).map(item => item.id))
    const images = this.data.images.map(item => ({ ...item, selected: ids.has(item.id) && sourceIds.has(item.sourceId) }))
    this.setData({ images, imageCount: images.filter(item => item.selected).length })
  },
  async submit() {
    if (this.data.busy) return
    const project = currentProject()
    const sources = this.data.choices
      .filter(item => item.selected)
      .map(({ selected: _selected, required: _required, kindLabel: _kindLabel, ...source }) => source)
    if (!project || project.status !== "active") return wx.showToast({ title: "当前项目不能新建分析", icon: "none" })
    if (!serviceConfig().token) return wx.showToast({ title: "请先配置开发服务连接", icon: "none" })
    if (!sources.length) return wx.showToast({ title: "请明确选择分析资料", icon: "none" })
    const task = AI_TASKS[this.data.taskIndex].id
    const mode = this.data.modeOptions[this.data.modeIndex]?.value
    const summaryScope: ProjectSummaryScope | undefined = task === "project_summary"
      ? {
        title: this.data.summaryTitle.trim(),
        purpose: this.data.summaryPurpose.trim(),
        audience: this.data.summaryAudience.trim(),
        stage: this.data.summaryStageOptions[this.data.summaryStageIndex],
        room: this.data.summaryRoomOptions[this.data.summaryRoomIndex],
        dateFrom: this.data.summaryUseDateRange ? this.data.summaryDateFrom : "",
        dateTo: this.data.summaryUseDateRange ? this.data.summaryDateTo : "",
        cutoffAt: new Date().toISOString()
      }
      : undefined
    if (summaryScope && (!summaryScope.title || !summaryScope.purpose || !summaryScope.audience)) {
      return wx.showToast({ title: "请补齐报告标题、用途和阅读对象", icon: "none" })
    }
    if (summaryScope?.dateFrom && summaryScope.dateFrom > summaryScope.dateTo) {
      return wx.showToast({ title: "总结开始日期不能晚于结束日期", icon: "none" })
    }
    if ((task === "rectification" || task === "consultation") && !mode) {
      return wx.showToast({ title: "请选择具体 AI 场景", icon: "none" })
    }
    if (task === "material_check"
      && (sources.filter(item => item.kind === "material").length !== 1
        || sources.filter(item => item.kind === "receipt").length !== 1)) {
      return wx.showToast({ title: "请选择一个材料和一个到货批次", icon: "none" })
    }
    const issueSources = sources.filter(item => item.kind === "issue")
    if (task === "rectification" && issueSources.length !== 1) {
      return wx.showToast({ title: "整改辅助必须只锁定一个问题", icon: "none" })
    }
    if (task === "rectification") {
      const workflow = loadState().issueWorkflows.find(item => item.id === issueSources[0].id)
      if (mode === "proposal" && (!workflow
        || !["pending_confirmation", "pending_action"].includes(workflow.status))) {
        return wx.showToast({ title: "当前问题阶段不适合生成处理预案", icon: "none" })
      }
      if (mode === "review" && workflow?.status !== "pending_review") {
        return wx.showToast({ title: "只有待复查问题可生成复查参考", icon: "none" })
      }
    }
    const consultationSources = sources.filter(item => item.kind === "consultation")
    if (task === "consultation" && mode === "prepare"
      && !sources.some(item => item.kind === "record" || item.kind === "issue")) {
      return wx.showToast({ title: "准备咨询至少选择一条记录或问题", icon: "none" })
    }
    if (task === "consultation" && mode === "response") {
      if (consultationSources.length !== 1) {
        return wx.showToast({ title: "整理回复必须只锁定一个咨询", icon: "none" })
      }
      if (!sources.some(item => item.kind === "consultation_response"
        && item.relatedConsultationId === consultationSources[0].id)) {
        return wx.showToast({ title: "请选择该咨询的至少一条回复", icon: "none" })
      }
      const responseIds = new Set(sources
        .filter(item => item.kind === "consultation_response")
        .map(item => item.id))
      const staleResponse = loadState().consultationResponses.some(item =>
        responseIds.has(item.id) && item.status !== "pending")
      if (staleResponse) {
        return wx.showToast({ title: "所选回复已经处理，请刷新后重试", icon: "none" })
      }
    }
    if (this.data.entryWarning) return wx.showToast({ title: this.data.entryWarning, icon: "none" })
    const selectedImages = this.data.images.filter(item => item.selected)
    if (selectedImages.length > 4) return wx.showToast({ title: "每次最多 4 张图片", icon: "none" })
    if (task === "image_observation" && !selectedImages.length) {
      return wx.showToast({ title: "图片辅助分析至少需要一张图片", icon: "none" })
    }
    this.setData({
      busy: true, error: "", selected: null, citations: [], evidenceSources: [],
      evidenceImages: [], evidenceTarget: null, evidenceSummaryScope: null, correction: "", applicationNotice: "",
      materialReviewFields: [], recordFactLines: [], recordOpinionLines: [],
      imageReviewItems: [], reviewImages: [], budgetScenarioItems: [], budgetNote: ""
      , summaryDraftTitle: "", summaryScopeStatement: "",
      summarySectionItems: [], summaryHandoffItems: [], summaryNote: ""
    })
    try {
      const images: AiImage[] = await Promise.all(selectedImages.map(item => new Promise<AiImage>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: item.path, encoding: "base64",
          success: res => {
            const base64 = res.data as string
            if (base64.length > 2800000) return reject(new Error("单张图片需小于 2MB，请压缩后重新选择"))
            const mime = base64.startsWith("/9j/") ? "jpeg" : base64.startsWith("iVBOR") ? "png" : "webp"
            resolve({ id: item.id, sourceId: item.sourceId, dataUrl: "data:image/" + mime + ";base64," + base64 })
          }, fail: () => reject(new Error("图片读取失败，请重新保存原件"))
        })
      })))
      const targetRecord = task === "record_review" && this.data.preselectedRecordId
        ? loadState().records.find(item => item.id === this.data.preselectedRecordId && item.projectId === project.id)
        : undefined
      const target: AiTarget | undefined = targetRecord
        ? { kind: "record", id: targetRecord.id, version: String(targetRecord.version) }
        : task === "rectification"
          ? { kind: "issue", id: issueSources[0].id, version: issueSources[0].version }
          : task === "consultation" && mode === "response"
            ? {
              kind: "consultation",
              id: consultationSources[0].id,
              version: consultationSources[0].version
            }
            : undefined
      const input: AiInput = {
        requestId: makeId("request"), projectId: project.id, task,
        stage: project.stage, question: this.data.question, sources, images,
        ...(mode ? { mode } : {}),
        ...(target ? { target } : {}),
        ...(summaryScope ? { summaryScope } : {})
      }
      let job = await runAi(input)
      job = await this.followJob(job)
      this.setData({
        selected: job,
        selectedStatusLabel: jobStatusLabel(job),
        error: job.error || "",
        materialReviewFields: materialReviewView(job),
        rectificationProposalItems: [],
        rectificationCheckItems: [],
        consultationMappings: [],
        budgetScenarioItems: budgetReviewView(job).scenarios,
        budgetNote: budgetReviewView(job).note,
        summarySectionItems: projectSummaryReviewView(job).sections,
        summaryHandoffItems: projectSummaryReviewView(job).handoff,
        summaryDraftTitle: projectSummaryReviewView(job).title,
        summaryScopeStatement: projectSummaryReviewView(job).scopeStatement,
        summaryNote: projectSummaryReviewView(job).note
      })
      await this.refreshJobs()
      if (job.status === "succeeded") await this.loadSources(job.id)
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "分析失败" }) }
    finally { this.setData({ busy: false }) }
  },
  async refreshJobs() {
    const project = currentProject()
    if (!project || !serviceConfig().token) {
      this.setData({ jobs: [], selected: project ? this.data.selected : null })
      return
    }
    try {
      const jobs = await apiRequest<AiJob[]>("/v1/ai/jobs?projectId=" + encodeURIComponent(project.id))
      const today = new Date().toISOString().slice(0, 10)
      const todayJobs = jobs.filter(job => job.createdAt.startsWith(today))
      const recordedTokens = todayJobs.reduce(
        (total, job) => total + (job.metrics?.usage?.totalTokens || 0), 0
      )
      const missingUsage = todayJobs.filter(job =>
        ["failed", "cancelled"].includes(job.status) && !job.metrics?.usage).length
      this.setData({
        jobs: jobs.map(jobView),
        usageSummary: `今日任务 ${todayJobs.length}/20 · 已记录 ${recordedTokens} tokens`
          + (missingUsage ? ` · ${missingUsage} 次无供应商用量回执` : "")
      })
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "历史加载失败" }) }
  },
  async followJob(initial: AiJob): Promise<AiJob> {
    let job = initial
    this.setData({
      selected: job,
      selectedStatusLabel: jobStatusLabel(job),
      activeJobId: job.status === "running" ? job.id : ""
    })
    for (let attempt = 0; job.status === "running" && attempt < 70; attempt++) {
      await wait(1000)
      if (this.data.activeJobId !== job.id) return this.data.selected || job
      job = await readAiJob(job.id)
      this.setData({ selected: job, selectedStatusLabel: jobStatusLabel(job) })
    }
    if (this.data.activeJobId === job.id) this.setData({ activeJobId: "" })
    if (job.status === "running") {
      this.setData({ error: "任务仍在服务端运行，请稍后刷新任务历史；不要重复提交相同资料" })
    }
    return job
  },
  async cancelCurrentJob() {
    const selected = this.data.selected
    if (!selected || selected.status !== "running" || this.data.cancelling) return
    this.setData({ cancelling: true, error: "" })
    try {
      const job = await cancelAiJob(selected.id)
      this.setData({
        selected: job,
        selectedStatusLabel: jobStatusLabel(job),
        activeJobId: "",
        busy: false
      })
      await this.refreshJobs()
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "取消失败，请刷新任务历史" })
    } finally { this.setData({ cancelling: false }) }
  },
  async retrySelectedJob() {
    const selected = this.data.selected
    const project = currentProject()
    if (!selected || !["failed", "cancelled"].includes(selected.status) || this.data.busy) return
    if (!project || project.status !== "active") {
      return wx.showToast({ title: "当前项目不能重试分析", icon: "none" })
    }
    this.setData({ busy: true, error: "", applicationNotice: "" })
    try {
      let job = await retryAiJob(selected.id)
      job = await this.followJob(job)
      this.setData({ selected: job, selectedStatusLabel: jobStatusLabel(job) })
      await this.refreshJobs()
      if (job.status === "succeeded") await this.loadSources(job.id)
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "重试失败" })
    } finally { this.setData({ busy: false }) }
  },
  async openJob(e: WechatMiniprogram.TouchEvent) {
    const job = this.data.jobs.find(item => item.id === e.currentTarget.dataset.id)
    if (!job) return
    this.setData({
      selected: job,
      selectedStatusLabel: jobStatusLabel(job),
      correction: job.correction || "",
      citations: [],
      evidenceSources: [],
      evidenceImages: [],
      evidenceTarget: null,
      evidenceSummaryScope: null,
      materialReviewFields: materialReviewView(job),
      recordFactLines: [],
      recordOpinionLines: [],
      imageReviewItems: [],
      reviewImages: [],
      rectificationProposalItems: [],
      rectificationCheckItems: [],
      rectificationNote: "",
      consultationFactLines: [],
      consultationTimelineLines: [],
      consultationDisputeLines: [],
      consultationQuestionLines: [],
      consultationMappings: [],
      consultationIssueOptions: [],
      consultationNote: "",
      budgetScenarioItems: [],
      budgetNote: "",
      summaryDraftTitle: "",
      summaryScopeStatement: "",
      summarySectionItems: [],
      summaryHandoffItems: [],
      summaryNote: "",
      applicationNotice: ""
    })
    try { await this.loadSources(job.id) }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "来源加载失败" }) }
  },
  async loadSources(id: string) {
    const evidence = await apiRequest<{
      sources: AiSource[]
      images: AiImageReference[]
      target?: AiTarget
      summaryScope?: ProjectSummaryScope
      knowledge: KnowledgeCard[]
    }>("/v1/ai/jobs/" + id + "/sources")
    const recordDraft = recordReviewView(this.data.selected, evidence.target)
    const rectificationDraft = rectificationReviewView(this.data.selected)
    const consultationDraft = consultationReviewView(this.data.selected, evidence.sources)
    const budgetDraft = budgetReviewView(this.data.selected)
    const summaryDraft = projectSummaryReviewView(this.data.selected)
    const scope = evidence.summaryScope
    this.setData({
      evidenceSources: evidence.sources,
      evidenceImages: evidence.images,
      evidenceTarget: evidence.target || null,
      evidenceSummaryScope: scope || null,
      reviewImages: localImagePaths(evidence.images),
      recordDraftTitle: recordDraft.title,
      recordDraftNote: recordDraft.note,
      recordRoomIndex: recordDraft.roomIndex,
      recordStageIndex: recordDraft.stageIndex,
      recordOccurredDate: recordDraft.occurredDate,
      recordTargetLabel: recordDraft.targetLabel,
      recordFactLines: recordDraft.facts,
      recordOpinionLines: recordDraft.opinions,
      imageReviewItems: imageReviewView(this.data.selected),
      rectificationProposalItems: rectificationDraft.proposals,
      rectificationCheckItems: rectificationDraft.checks,
      rectificationNote: rectificationDraft.note,
      consultationDraftTitle: consultationDraft.title,
      consultationDraftPurpose: consultationDraft.purpose,
      consultationFactLines: consultationDraft.facts,
      consultationTimelineLines: consultationDraft.timeline,
      consultationDisputeLines: consultationDraft.disputes,
      consultationGapsText: consultationDraft.gapsText,
      consultationQuestionLines: consultationDraft.questions,
      consultationMappings: consultationDraft.mappings,
      consultationIssueOptions: consultationDraft.issueOptions,
      consultationNote: consultationDraft.note,
      budgetScenarioItems: budgetDraft.scenarios,
      budgetNote: budgetDraft.note,
      summaryTitle: scope?.title || this.data.summaryTitle,
      summaryPurpose: scope?.purpose || this.data.summaryPurpose,
      summaryAudience: scope?.audience || this.data.summaryAudience,
      summaryStageIndex: scope
        ? Math.max(0, this.data.summaryStageOptions.indexOf(scope.stage))
        : this.data.summaryStageIndex,
      summaryRoomIndex: scope
        ? Math.max(0, this.data.summaryRoomOptions.indexOf(scope.room))
        : this.data.summaryRoomIndex,
      summaryUseDateRange: Boolean(scope?.dateFrom && scope.dateTo),
      summaryDateFrom: scope?.dateFrom || this.data.summaryDateFrom,
      summaryDateTo: scope?.dateTo || this.data.summaryDateTo,
      summaryDraftTitle: summaryDraft.title,
      summaryScopeStatement: summaryDraft.scopeStatement,
      summarySectionItems: summaryDraft.sections,
      summaryHandoffItems: summaryDraft.handoff,
      summaryNote: summaryDraft.note,
      citations: [
        ...evidence.sources.map(source => ({ id: source.id, title: source.title, text: source.text })),
        ...evidence.knowledge.map(card => ({ id: card.id, title: card.title + "（" + card.status + "）", text: card.sourceTitle + " " + card.sourceUrl + " 版本：" + card.versionDate }))
      ]
    })
    if (this.data.selected?.decision === "accepted") {
      this.applyAcceptedJob(
        this.data.selected, evidence.sources, evidence.images, evidence.target, evidence.summaryScope
      )
    }
  },
  applyAcceptedJob(
    job: AiJob,
    sources: AiSource[],
    imageRefs: AiImageReference[],
    target?: AiTarget,
    summaryScope?: ProjectSummaryScope
  ) {
    const project = currentProject()
    if (!project || project.id !== this.data.projectId) throw new Error("当前项目与 AI 任务不一致")
    const snapshots = sourceSnapshots(sources)
    if (job.task === "material_check" && job.result?.materialCheck && job.materialReview) {
      const item = saveMaterialCheckRecord({
        projectId: project.id,
        materialId: job.result.materialCheck.materialSourceId,
        receiptBatchId: job.result.materialCheck.receiptSourceId,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        originalResult: job.result.materialCheck,
        review: job.materialReview,
        metrics: job.metrics
      })
      this.setData({ applicationNotice: `人工复核已写入材料到货核对 · ${item.confirmedBy}` })
      return
    }
    if (job.task === "record_review" && job.result?.recordReview && job.recordReviewReview) {
      const applied = applyRecordReview({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        imageRefs,
        originalResult: job.result.recordReview,
        review: job.recordReviewReview,
        ...(target ? { target: { recordId: target.id, expectedVersion: Number(target.version) } } : {})
      })
      this.setData({
        applicationNotice: target
          ? `人工复核已写回《${applied.record.title}》v${applied.record.version}`
          : `人工复核已创建现场记录《${applied.record.title}》`
      })
      return
    }
    if (job.task === "image_observation" && job.result?.imageObservation && job.imageObservationReview) {
      const applied = applyImageObservation({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        imageRefs,
        originalResult: job.result.imageObservation,
        review: job.imageObservationReview
      })
      this.setData({
        applicationNotice: applied.issueLinks.length
          ? `图片观察已留档，并创建 ${applied.issueLinks.length} 条待确认问题`
          : "图片观察已按人工选择留档"
      })
      return
    }
    if (job.task === "rectification" && job.result?.rectification && job.rectificationReview) {
      if (target?.kind !== "issue") throw new Error("整改辅助缺少锁定问题")
      const workflow = loadState().issueWorkflows.find(item =>
        item.id === target.id && item.projectId === project.id)
      if (!workflow) throw new Error("锁定的问题已不存在")
      const application = applyRectification({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        imageRefs,
        originalResult: job.result.rectification,
        review: job.rectificationReview,
        target: { issueId: target.id, expectedVersion: workflow.version }
      })
      this.setData({
        applicationNotice: application.mode === "proposal"
          ? `已创建 ${application.proposalLinks.length} 条待选预案，仍需负责人决定是否采用`
          : "复查参考已留档，问题状态未改变，仍需负责人完成正式复查"
      })
      return
    }
    if (job.task === "consultation" && job.result?.consultation && job.consultationReview) {
      const applied = applyConsultation({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        imageRefs,
        originalResult: job.result.consultation,
        review: job.consultationReview,
        ...(target?.kind === "consultation"
          ? { target: { consultationId: target.id, expectedVersion: Number(target.version) } }
          : {})
      })
      this.setData({
        applicationNotice: applied.consultation
          ? `已创建未发布咨询草稿《${applied.consultation.title}》，需负责人检查后手动发布`
          : applied.application.proposalLinks.length
            ? `回复整理已留档，并创建 ${applied.application.proposalLinks.length} 条待选预案`
            : "回复整理已留档，未发送、未采纳任何方案"
      })
      return
    }
    if (job.task === "budget" && job.result?.budget && job.budgetReview) {
      const application = applyBudgetEstimate({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        sourceSnapshots: snapshots,
        originalResult: job.result.budget,
        review: job.budgetReview
      })
      const unknownAmounts = application.scenarios.filter(item =>
        item.recommendedPurchase?.amountFen === undefined).length
      this.setData({
        applicationNotice: `已保存 ${application.scenarios.length} 个负责人确认的估算方案`
          + (unknownAmounts ? `；其中 ${unknownAmounts} 个因单价或资源口径不完整未形成金额` : "")
          + "。未创建采购、费用批准或付款。"
      })
      return
    }
    if (job.task === "project_summary" && job.result?.projectSummary
      && job.projectSummaryReview) {
      const scope = summaryScope
      if (!scope) throw new Error("项目总结缺少任务范围")
      const application = applyProjectSummary({
        projectId: project.id,
        aiJobId: job.id,
        model: job.metrics?.responseModel || job.model,
        promptVersion: job.promptVersion,
        contractVersion: job.contractVersion,
        summary: job.result.summary,
        scope,
        sourceSnapshots: snapshots,
        originalResult: job.result.projectSummary,
        review: job.projectSummaryReview
      })
      this.setData({
        applicationNotice: `已保存负责人确认的项目总结《${application.review.title}》。`
          + "原始模型结果与来源版本已留存，报告尚未自动发送或改变业务状态。"
      })
    }
  },
  onCorrection(e: WechatMiniprogram.TextareaInput) { this.setData({ correction: e.detail.value }) },
  onMaterialFieldValue(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field as "observedValue" | "expectedValue" | "note"
    if (!Number.isInteger(index) || !["observedValue", "expectedValue", "note"].includes(field)) return
    this.setData({
      materialReviewFields: this.data.materialReviewFields.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: e.detail.value } : item)
    })
  },
  onMaterialStatus(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const statusIndex = Number(e.detail.value)
    const option = MATERIAL_STATUS_OPTIONS[statusIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      materialReviewFields: this.data.materialReviewFields.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: option.value, statusIndex, statusLabel: option.label }
          : item)
    })
  },
  onRecordTitle(e: WechatMiniprogram.Input) { this.setData({ recordDraftTitle: e.detail.value }) },
  onRecordNote(e: WechatMiniprogram.TextareaInput) { this.setData({ recordDraftNote: e.detail.value }) },
  onRecordRoom(e: WechatMiniprogram.PickerChange) { this.setData({ recordRoomIndex: Number(e.detail.value) }) },
  onRecordStage(e: WechatMiniprogram.PickerChange) { this.setData({ recordStageIndex: Number(e.detail.value) }) },
  onRecordDate(e: WechatMiniprogram.PickerChange) { this.setData({ recordOccurredDate: String(e.detail.value) }) },
  onRecordIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const field = e.currentTarget.dataset.field as "facts" | "opinions"
    const included = new Set(e.detail.value.map(String))
    if (field === "facts") {
      this.setData({
        recordFactLines: this.data.recordFactLines.map(item => ({
          ...item,
          included: included.has(String(item.sourceIndex))
        }))
      })
      return
    }
    if (field === "opinions") {
      this.setData({
        recordOpinionLines: this.data.recordOpinionLines.map(item => ({
          ...item,
          included: included.has(String(item.sourceIndex))
        }))
      })
    }
  },
  onRecordLine(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = e.currentTarget.dataset.field as "facts" | "opinions"
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index)) return
    if (field === "facts") {
      this.setData({
        recordFactLines: this.data.recordFactLines.map(item =>
          item.sourceIndex === index ? { ...item, text: e.detail.value } : item)
      })
      return
    }
    if (field === "opinions") {
      this.setData({
        recordOpinionLines: this.data.recordOpinionLines.map(item =>
          item.sourceIndex === index ? { ...item, text: e.detail.value } : item)
      })
    }
  },
  onImageDisposition(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const dispositionIndex = Number(e.detail.value)
    const option = IMAGE_DISPOSITION_OPTIONS[dispositionIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      imageReviewItems: this.data.imageReviewItems.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, disposition: option.value, dispositionIndex, dispositionLabel: option.label }
          : item)
    })
  },
  onImagePriority(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const priorityIndex = Number(e.detail.value)
    const option = IMAGE_PRIORITY_OPTIONS[priorityIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      imageReviewItems: this.data.imageReviewItems.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, priority: option.value, priorityIndex, priorityLabel: option.label }
          : item)
    })
  },
  onImageReviewField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field as
      | "observation" | "suspectedExplanation" | "limitationsText"
      | "captureSuggestionsText" | "priorityReason" | "issueTitle"
    if (!Number.isInteger(index) || ![
      "observation", "suspectedExplanation", "limitationsText",
      "captureSuggestionsText", "priorityReason", "issueTitle"
    ].includes(field)) return
    this.setData({
      imageReviewItems: this.data.imageReviewItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: e.detail.value } : item)
    })
  },
  onRectificationIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const field = e.currentTarget.dataset.field as "proposals" | "checks"
    const included = new Set(e.detail.value.map(String))
    if (field === "proposals") {
      this.setData({
        rectificationProposalItems: this.data.rectificationProposalItems.map(item => ({
          ...item,
          included: included.has(item.optionId)
        }))
      })
      return
    }
    this.setData({
      rectificationCheckItems: this.data.rectificationCheckItems.map(item => ({
        ...item,
        included: included.has(item.checkId)
      }))
    })
  },
  onRectificationField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const kind = e.currentTarget.dataset.kind as "proposal" | "check"
    const field = e.currentTarget.dataset.field as
      "title" | "content" | "requirement" | "observation" | "limitationsText" | "nextStepsText"
    if (!Number.isInteger(index)) return
    if (kind === "proposal" && ["title", "content"].includes(field)) {
      this.setData({
        rectificationProposalItems: this.data.rectificationProposalItems.map((item, itemIndex) =>
          itemIndex === index ? { ...item, [field]: e.detail.value } : item)
      })
      return
    }
    if (kind === "check" && ["requirement", "observation", "limitationsText", "nextStepsText"].includes(field)) {
      this.setData({
        rectificationCheckItems: this.data.rectificationCheckItems.map((item, itemIndex) =>
          itemIndex === index ? { ...item, [field]: e.detail.value } : item)
      })
    }
  },
  onRectificationStatus(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const statusIndex = Number(e.detail.value)
    const option = RECTIFICATION_STATUS_OPTIONS[statusIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      rectificationCheckItems: this.data.rectificationCheckItems.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: option.value, statusIndex, statusLabel: option.label }
          : item)
    })
  },
  onRectificationNote(e: WechatMiniprogram.TextareaInput) {
    this.setData({ rectificationNote: e.detail.value })
  },
  onConsultationHeader(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = e.currentTarget.dataset.field as "title" | "purpose" | "gaps" | "note"
    if (field === "title") this.setData({ consultationDraftTitle: e.detail.value })
    if (field === "purpose") this.setData({ consultationDraftPurpose: e.detail.value })
    if (field === "gaps") this.setData({ consultationGapsText: e.detail.value })
    if (field === "note") this.setData({ consultationNote: e.detail.value })
  },
  onConsultationIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const field = e.currentTarget.dataset.field as "facts" | "timeline" | "disputes" | "questions"
    const included = new Set(e.detail.value.map(String))
    const update = (items: ConsultationLineView[]) => items.map(item => ({
      ...item,
      included: included.has(String(item.sourceIndex))
    }))
    if (field === "facts") this.setData({ consultationFactLines: update(this.data.consultationFactLines) })
    if (field === "timeline") this.setData({ consultationTimelineLines: update(this.data.consultationTimelineLines) })
    if (field === "disputes") this.setData({ consultationDisputeLines: update(this.data.consultationDisputeLines) })
    if (field === "questions") this.setData({ consultationQuestionLines: update(this.data.consultationQuestionLines) })
  },
  onConsultationLine(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = e.currentTarget.dataset.field as "facts" | "timeline" | "disputes" | "questions"
    const index = Number(e.currentTarget.dataset.index)
    const update = (items: ConsultationLineView[]) => items.map(item =>
      item.sourceIndex === index ? { ...item, text: e.detail.value } : item)
    if (field === "facts") this.setData({ consultationFactLines: update(this.data.consultationFactLines) })
    if (field === "timeline") this.setData({ consultationTimelineLines: update(this.data.consultationTimelineLines) })
    if (field === "disputes") this.setData({ consultationDisputeLines: update(this.data.consultationDisputeLines) })
    if (field === "questions") this.setData({ consultationQuestionLines: update(this.data.consultationQuestionLines) })
  },
  onConsultationDisposition(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const dispositionIndex = Number(e.detail.value)
    const option = CONSULTATION_DISPOSITION_OPTIONS[dispositionIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      consultationMappings: this.data.consultationMappings.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, disposition: option.value, dispositionIndex, dispositionLabel: option.label }
          : item)
    })
  },
  onConsultationStatus(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const statusIndex = Number(e.detail.value)
    const option = CONSULTATION_STATUS_OPTIONS[statusIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      consultationMappings: this.data.consultationMappings.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: option.value, statusIndex, statusLabel: option.label }
          : item)
    })
  },
  onConsultationIssue(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const issueIndex = Number(e.detail.value)
    const option = this.data.consultationIssueOptions[issueIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      consultationMappings: this.data.consultationMappings.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, issueIndex, targetIssueSourceId: option.id }
          : item)
    })
  },
  onConsultationMappingField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field as
      "summary" | "conditionsText" | "conflictsText" | "followUpsText" | "proposalContent"
    if (!Number.isInteger(index) || ![
      "summary", "conditionsText", "conflictsText", "followUpsText", "proposalContent"
    ].includes(field)) return
    this.setData({
      consultationMappings: this.data.consultationMappings.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: e.detail.value } : item)
    })
  },
  onBudgetIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const includedIds = new Set(e.detail.value)
    this.setData({
      budgetScenarioItems: this.data.budgetScenarioItems.map(item =>
        withBudgetPreview(
          { ...item, included: includedIds.has(item.scenarioId) },
          item.originalSummary
        ))
    })
  },
  onBudgetField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field as
      "label" | "unit" | "requiredQuantity" | "wasteRatePercent"
      | "packageSize" | "packageUnitPriceYuan" | "note"
    if (!Number.isInteger(index) || ![
      "label", "unit", "requiredQuantity", "wasteRatePercent",
      "packageSize", "packageUnitPriceYuan", "note"
    ].includes(field)) return
    this.setData({
      budgetScenarioItems: this.data.budgetScenarioItems.map((item, itemIndex) => {
        if (itemIndex !== index) return item
        return withBudgetPreview({ ...item, [field]: e.detail.value }, item.originalSummary)
      })
    })
  },
  onBudgetWasteMode(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const option = BUDGET_WASTE_OPTIONS[Number(e.detail.value)]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      budgetScenarioItems: this.data.budgetScenarioItems.map((item, itemIndex) =>
        itemIndex === index
          ? withBudgetPreview({
            ...item,
            requirementIncludesWaste: option.value
          }, item.originalSummary)
          : item)
    })
  },
  onBudgetNote(e: WechatMiniprogram.TextareaInput) {
    this.setData({ budgetNote: e.detail.value })
  },
  onSummaryReviewHeader(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = e.currentTarget.dataset.field as "title" | "scope" | "note"
    if (field === "title") this.setData({ summaryDraftTitle: e.detail.value })
    if (field === "scope") this.setData({ summaryScopeStatement: e.detail.value })
    if (field === "note") this.setData({ summaryNote: e.detail.value })
  },
  onSummarySectionIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const included = new Set(e.detail.value.map(String))
    this.setData({
      summarySectionItems: this.data.summarySectionItems.map(item => ({
        ...item,
        included: included.has(item.key)
      }))
    })
  },
  onSummarySectionField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field as "title" | "content"
    if (!Number.isInteger(index) || !["title", "content"].includes(field)) return
    this.setData({
      summarySectionItems: this.data.summarySectionItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: e.detail.value } : item)
    })
  },
  onSummaryHandoffIncluded(e: WechatMiniprogram.CheckboxGroupChange) {
    const included = new Set(e.detail.value.map(String))
    this.setData({
      summaryHandoffItems: this.data.summaryHandoffItems.map(item => ({
        ...item,
        included: included.has(item.itemId)
      }))
    })
  },
  onSummaryHandoffField(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index)) return
    this.setData({
      summaryHandoffItems: this.data.summaryHandoffItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, text: e.detail.value } : item)
    })
  },
  onSummaryHandoffStatus(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.currentTarget.dataset.index)
    const statusIndex = Number(e.detail.value)
    const option = SUMMARY_HANDOFF_STATUS_OPTIONS[statusIndex]
    if (!Number.isInteger(index) || !option) return
    this.setData({
      summaryHandoffItems: this.data.summaryHandoffItems.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: option.value, statusIndex, statusLabel: option.label }
          : item)
    })
  },
  previewReviewImage(e: WechatMiniprogram.TouchEvent) {
    const current = e.currentTarget.dataset.path as string
    wx.previewImage({ current, urls: this.data.reviewImages.map(item => item.path) })
  },
  buildRecordReview(): RecordReviewReview {
    return {
      title: this.data.recordDraftTitle.trim(),
      room: ROOMS[this.data.recordRoomIndex],
      stage: STAGES[this.data.recordStageIndex],
      occurredAt: dateToIso(this.data.recordOccurredDate),
      note: this.data.recordDraftNote.trim(),
      facts: this.data.recordFactLines.map(item => ({
        sourceIndex: item.sourceIndex,
        included: item.included,
        text: item.text.trim()
      })),
      opinions: this.data.recordOpinionLines.map(item => ({
        sourceIndex: item.sourceIndex,
        included: item.included,
        text: item.text.trim()
      }))
    }
  },
  buildImageReview(): ImageObservationReview {
    return {
      items: this.data.imageReviewItems.map(item => ({
        itemId: item.itemId,
        disposition: item.disposition,
        observation: item.observation.trim(),
        suspectedExplanation: item.suspectedExplanation.trim(),
        limitations: lines(item.limitationsText),
        captureSuggestions: lines(item.captureSuggestionsText),
        priority: item.priority,
        priorityReason: item.priorityReason.trim(),
        issueTitle: item.issueTitle.trim()
      }))
    }
  },
  buildRectificationReview(): RectificationHumanReview {
    const original = this.data.selected?.result?.rectification
    if (!original) throw new Error("整改辅助结果不存在")
    if (original.mode === "proposal") {
      return {
        mode: "proposal",
        items: this.data.rectificationProposalItems.map(item => ({
          optionId: item.optionId,
          included: item.included,
          title: item.title.trim(),
          content: item.content.trim()
        })),
        note: this.data.rectificationNote.trim()
      }
    }
    return {
      mode: "review",
      items: this.data.rectificationCheckItems.map(item => ({
        checkId: item.checkId,
        included: item.included,
        requirement: item.requirement.trim(),
        status: item.status,
        observation: item.observation.trim(),
        limitations: lines(item.limitationsText),
        nextSteps: lines(item.nextStepsText)
      })),
      note: this.data.rectificationNote.trim()
    }
  },
  buildConsultationReview(): ConsultationHumanReview {
    const original = this.data.selected?.result?.consultation
    if (!original) throw new Error("咨询整理结果不存在")
    const reviewedLines = (items: ConsultationLineView[]) => items.map(item => ({
      sourceIndex: item.sourceIndex,
      included: item.included,
      text: item.text.trim()
    }))
    if (original.mode === "prepare") {
      return {
        mode: "prepare",
        title: this.data.consultationDraftTitle.trim(),
        purpose: this.data.consultationDraftPurpose.trim(),
        facts: reviewedLines(this.data.consultationFactLines),
        timeline: reviewedLines(this.data.consultationTimelineLines),
        disputes: reviewedLines(this.data.consultationDisputeLines),
        gaps: lines(this.data.consultationGapsText),
        questions: reviewedLines(this.data.consultationQuestionLines),
        note: this.data.consultationNote.trim()
      }
    }
    return {
      mode: "response",
      mappings: this.data.consultationMappings.map(item => ({
        mappingId: item.mappingId,
        disposition: item.disposition,
        status: item.status,
        summary: item.summary.trim(),
        conditions: lines(item.conditionsText),
        conflicts: lines(item.conflictsText),
        followUps: lines(item.followUpsText),
        targetIssueSourceId: item.targetIssueSourceId,
        proposalContent: item.proposalContent.trim()
      })),
      note: this.data.consultationNote.trim()
    }
  },
  buildBudgetReview(): BudgetHumanReview {
    return {
      scenarios: this.data.budgetScenarioItems.map(item => ({
        scenarioId: item.scenarioId,
        included: item.included,
        label: item.label.trim(),
        materialSourceId: item.materialSourceId,
        unit: item.unit.trim(),
        requiredQuantity: item.requiredQuantity.trim(),
        wasteRatePercent: item.wasteRatePercent.trim(),
        requirementIncludesWaste: item.requirementIncludesWaste,
        packageSize: item.packageSize.trim(),
        packageUnitPriceYuan: item.packageUnitPriceYuan.trim(),
        note: item.note.trim()
      })),
      note: this.data.budgetNote.trim()
    }
  },
  buildProjectSummaryReview(): ProjectSummaryHumanReview {
    return {
      title: this.data.summaryDraftTitle.trim(),
      scopeStatement: this.data.summaryScopeStatement.trim(),
      sections: this.data.summarySectionItems.map(item => ({
        key: item.key,
        included: item.included,
        title: item.title.trim(),
        content: item.content.trim()
      })),
      handoff: this.data.summaryHandoffItems.map(item => ({
        itemId: item.itemId,
        included: item.included,
        text: item.text.trim(),
        status: item.status
      })),
      note: this.data.summaryNote.trim()
    }
  },
  async decide(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.selected || this.data.busy) return
    const project = currentProject()
    if (!project || project.status !== "active") return wx.showToast({ title: "当前项目不能修改分析决定", icon: "none" })
    const decision = e.currentTarget.dataset.decision as "accepted" | "dismissed"
    const materialReview: MaterialCheckReview | undefined = decision === "accepted"
      && this.data.selected.task === "material_check"
      ? {
        fields: this.data.materialReviewFields.map(field => ({
          key: field.key,
          observedValue: field.observedValue.trim(),
          expectedValue: field.expectedValue.trim(),
          status: field.status,
          note: field.note.trim()
        }))
      }
      : undefined
    const recordReviewReview = decision === "accepted"
      && this.data.selected.task === "record_review"
      ? this.buildRecordReview()
      : undefined
    const imageObservationReview = decision === "accepted"
      && this.data.selected.task === "image_observation"
      ? this.buildImageReview()
      : undefined
    const rectificationReview = decision === "accepted"
      && this.data.selected.task === "rectification"
      ? this.buildRectificationReview()
      : undefined
    const consultationReview = decision === "accepted"
      && this.data.selected.task === "consultation"
      ? this.buildConsultationReview()
      : undefined
    const budgetReview = decision === "accepted"
      && this.data.selected.task === "budget"
      ? this.buildBudgetReview()
      : undefined
    const projectSummaryReview = decision === "accepted"
      && this.data.selected.task === "project_summary"
      ? this.buildProjectSummaryReview()
      : undefined
    const snapshots = decision === "accepted" ? sourceSnapshots(this.data.evidenceSources) : []
    if (decision === "accepted" && this.data.selected.result?.materialCheck) {
      try {
        assertMaterialCheckWritebackCurrent({
          projectId: project.id,
          materialId: this.data.selected.result.materialCheck.materialSourceId,
          receiptBatchId: this.data.selected.result.materialCheck.receiptSourceId,
          sourceSnapshots: snapshots,
          originalResult: this.data.selected.result.materialCheck
        })
      } catch (error) {
        this.setData({ error: error instanceof Error ? error.message : "核对资料已变化" })
        return
      }
    }
    if (decision === "accepted"
      && ["record_review", "image_observation", "rectification", "consultation", "budget", "project_summary"]
        .includes(this.data.selected.task)) {
      try {
        assertAiWritebackCurrent(project.id, snapshots, this.data.evidenceImages)
      } catch (error) {
        this.setData({ error: error instanceof Error ? error.message : "分析资料已变化" })
        return
      }
    }
    this.setData({ busy: true })
    try {
      const job = await apiRequest<AiJob>("/v1/ai/jobs/" + this.data.selected.id + "/decision", "POST", {
        decision,
        correction: this.data.correction,
        ...(materialReview ? { materialReview } : {}),
        ...(recordReviewReview ? { recordReviewReview } : {}),
        ...(imageObservationReview ? { imageObservationReview } : {}),
        ...(rectificationReview ? { rectificationReview } : {}),
        ...(consultationReview ? { consultationReview } : {}),
        ...(budgetReview ? { budgetReview } : {}),
        ...(projectSummaryReview ? { projectSummaryReview } : {})
      })
      const recordDraft = recordReviewView(job, this.data.evidenceTarget || undefined)
      const rectificationDraft = rectificationReviewView(job)
      const consultationDraft = consultationReviewView(job, this.data.evidenceSources)
      const budgetDraft = budgetReviewView(job)
      const summaryDraft = projectSummaryReviewView(job)
      this.setData({
        selected: job,
        selectedStatusLabel: jobStatusLabel(job),
        materialReviewFields: materialReviewView(job),
        recordDraftTitle: recordDraft.title,
        recordDraftNote: recordDraft.note,
        recordRoomIndex: recordDraft.roomIndex,
        recordStageIndex: recordDraft.stageIndex,
        recordOccurredDate: recordDraft.occurredDate,
        recordTargetLabel: recordDraft.targetLabel,
        recordFactLines: recordDraft.facts,
        recordOpinionLines: recordDraft.opinions,
        imageReviewItems: imageReviewView(job),
        rectificationProposalItems: rectificationDraft.proposals,
        rectificationCheckItems: rectificationDraft.checks,
        rectificationNote: rectificationDraft.note,
        consultationDraftTitle: consultationDraft.title,
        consultationDraftPurpose: consultationDraft.purpose,
        consultationFactLines: consultationDraft.facts,
        consultationTimelineLines: consultationDraft.timeline,
        consultationDisputeLines: consultationDraft.disputes,
        consultationGapsText: consultationDraft.gapsText,
        consultationQuestionLines: consultationDraft.questions,
        consultationMappings: consultationDraft.mappings,
        consultationIssueOptions: consultationDraft.issueOptions,
        consultationNote: consultationDraft.note,
        budgetScenarioItems: budgetDraft.scenarios,
        budgetNote: budgetDraft.note,
        summaryDraftTitle: summaryDraft.title,
        summaryScopeStatement: summaryDraft.scopeStatement,
        summarySectionItems: summaryDraft.sections,
        summaryHandoffItems: summaryDraft.handoff,
        summaryNote: summaryDraft.note
      })
      if (decision === "accepted") {
        this.applyAcceptedJob(
          job,
          this.data.evidenceSources,
          this.data.evidenceImages,
          this.data.evidenceTarget || undefined,
          this.data.evidenceSummaryScope || undefined
        )
      } else {
        this.setData({ applicationNotice: "本次结果已驳回，未写入业务数据" })
      }
      await this.refreshJobs()
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "保存失败" }) }
    finally { this.setData({ busy: false }) }
  },
  openPersonalSettings() { wx.navigateTo({ url: "/pages/settings/index" }) }
})
