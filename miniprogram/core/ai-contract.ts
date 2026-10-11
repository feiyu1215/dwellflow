export const AI_TASKS = [
  { id: "record_review", label: "记录整理", hint: "提取事实、工序和待补信息" },
  { id: "material_check", label: "材料到货核对", hint: "对照选定约定，列出型号规格差异" },
  { id: "image_observation", label: "图片辅助分析", hint: "可见现象、疑点和补拍建议" },
  { id: "rectification", label: "问题与整改", hint: "处理预案、前后变化和复查证据" },
  { id: "consultation", label: "建议与咨询", hint: "整理咨询问题，提供有出处的建议" },
  { id: "budget", label: "预算与资源配置", hint: "解释账本和材料需求，指出缺失参数" },
  { id: "project_summary", label: "项目总结", hint: "阶段进展、未解决事项和交接摘要" }
] as const

export type AiTaskKind = typeof AI_TASKS[number]["id"]
export const AI_SOURCE_KINDS = [
  "record", "agreement", "issue", "material", "purchase", "receipt", "expense",
  "consultation", "consultation_response"
] as const
export type AiSourceKind = typeof AI_SOURCE_KINDS[number]
export type AiSourceAuthority = "project_fact" | "approved_agreement" | "unapproved_agreement"
export interface AiSource {
  id: string
  kind: AiSourceKind
  title: string
  text: string
  version: string
  authority?: AiSourceAuthority
  relatedMaterialId?: string
  relatedConsultationId?: string
  occurredAt?: string
  updatedAt?: string
  room?: string
  stage?: string
}
export interface AiSourceSnapshotReference {
  sourceId: string
  kind: AiSourceKind
  version: string
  authority?: AiSourceAuthority
  relatedMaterialId?: string
  relatedConsultationId?: string
}
export interface AiImage { id?: string; sourceId: string; dataUrl: string }
export interface AiImageReference { id: string; sourceId: string }
export type RectificationMode = "proposal" | "review"
export type ConsultationMode = "prepare" | "response"
export type AiTaskMode = RectificationMode | ConsultationMode
export type AiTarget =
  | { kind: "record"; id: string; version: string }
  | { kind: "issue"; id: string; version: string }
  | { kind: "consultation"; id: string; version: string }
export interface ProjectSummaryScope {
  title: string
  purpose: string
  audience: string
  stage: string
  room: string
  dateFrom: string
  dateTo: string
  cutoffAt: string
}
export interface AiInput {
  requestId: string
  projectId: string
  task: AiTaskKind
  mode?: AiTaskMode
  stage: string
  question: string
  sources: AiSource[]
  images: AiImage[]
  target?: AiTarget
  summaryScope?: ProjectSummaryScope
}
export interface AiFinding { text: string; sourceIds: string[] }

export const MATERIAL_CHECK_FIELD_KEYS = [
  "brand", "model", "specification", "quantity",
  "batch_code", "manufacture_date", "appearance", "other"
] as const
export const MATERIAL_CHECK_REQUIRED_FIELD_KEYS = [
  "brand", "model", "specification", "quantity"
] as const
export type MaterialCheckFieldKey = typeof MATERIAL_CHECK_FIELD_KEYS[number]
export type MaterialCheckFieldStatus =
  | "matches"
  | "differs"
  | "observed_only"
  | "expected_only"
  | "unknown"
export interface MaterialCheckField {
  key: MaterialCheckFieldKey
  label: string
  observedValue: string
  expectedValue: string
  status: MaterialCheckFieldStatus
  observedSourceIds: string[]
  expectedSourceIds: string[]
  note: string
}
export interface MaterialCheckResult {
  materialSourceId: string
  receiptSourceId: string
  fields: MaterialCheckField[]
}
export interface MaterialCheckReviewField {
  key: MaterialCheckFieldKey
  observedValue: string
  expectedValue: string
  status: MaterialCheckFieldStatus
  note: string
}
export interface MaterialCheckReview {
  fields: MaterialCheckReviewField[]
}

export const RECORD_REVIEW_EVIDENCE_KINDS = [
  "visible_in_image", "user_statement", "reported_statement", "document_text"
] as const
export type RecordReviewEvidenceKind = typeof RECORD_REVIEW_EVIDENCE_KINDS[number]
export interface RecordReviewFact {
  text: string
  evidenceKind: RecordReviewEvidenceKind
  sourceIds: string[]
  roomCandidate: string
  stageCandidate: string
}
export interface RecordReviewTimeCandidate {
  originalExpression: string
  candidateDate: string
  sourceIds: string[]
  note: string
}
export interface RecordReviewOpinion {
  text: string
  speaker: string
  sourceIds: string[]
}
export interface RecordReviewResult {
  title: string
  facts: RecordReviewFact[]
  time: RecordReviewTimeCandidate
  opinions: RecordReviewOpinion[]
  gaps: string[]
}
export interface RecordReviewLineReview {
  sourceIndex: number
  included: boolean
  text: string
}
export interface RecordReviewReview {
  title: string
  room: string
  stage: string
  occurredAt: string
  note: string
  facts: RecordReviewLineReview[]
  opinions: RecordReviewLineReview[]
}

export interface NormalizedImageRegion {
  x: number
  y: number
  width: number
  height: number
}
export type ImageObservationPriority = "high" | "medium" | "low"
export interface ImageObservationCoverage {
  imageId: string
  sourceId: string
  visibleScope: string
  qualityLimitations: string[]
}
export interface ImageObservationItem {
  itemId: string
  imageId: string
  sourceId: string
  object: string
  observation: string
  region?: NormalizedImageRegion
  suspectedExplanation: string
  limitations: string[]
  captureSuggestions: string[]
  priority: ImageObservationPriority
  priorityReason: string
  knowledgeIds: string[]
}
export interface ImageObservationResult {
  images: ImageObservationCoverage[]
  items: ImageObservationItem[]
}
export type ImageObservationDisposition = "saved" | "ignored" | "issue"
export interface ImageObservationItemReview {
  itemId: string
  disposition: ImageObservationDisposition
  observation: string
  suspectedExplanation: string
  limitations: string[]
  captureSuggestions: string[]
  priority: ImageObservationPriority
  priorityReason: string
  issueTitle: string
}
export interface ImageObservationReview {
  items: ImageObservationItemReview[]
}

export interface RectificationProposalOption {
  optionId: string
  title: string
  actions: string[]
  applicability: string[]
  impacts: string[]
  costAndSchedule: string
  verificationEvidence: string[]
  sourceIds: string[]
  knowledgeIds: string[]
}
export interface RectificationProposalResult {
  mode: "proposal"
  issueSourceId: string
  issueSummary: string
  premises: string[]
  gaps: string[]
  proposals: RectificationProposalOption[]
}
export type RectificationCheckStatus =
  | "visible_improved"
  | "concern_remains"
  | "not_verifiable"
export type RectificationEvidenceRelation =
  | "confirmed_same_location"
  | "uncertain"
  | "different"
export interface RectificationReviewCheck {
  checkId: string
  requirement: string
  beforeSourceIds: string[]
  afterSourceIds: string[]
  status: RectificationCheckStatus
  observation: string
  limitations: string[]
  nextSteps: string[]
  knowledgeIds: string[]
}
export interface RectificationReviewResult {
  mode: "review"
  issueSourceId: string
  treatmentId: string
  evidenceRelation: RectificationEvidenceRelation
  checks: RectificationReviewCheck[]
  gaps: string[]
}
export type RectificationResult = RectificationProposalResult | RectificationReviewResult
export interface RectificationProposalItemReview {
  optionId: string
  included: boolean
  title: string
  content: string
}
export interface RectificationProposalReview {
  mode: "proposal"
  items: RectificationProposalItemReview[]
  note: string
}
export interface RectificationCheckReview {
  checkId: string
  included: boolean
  requirement: string
  status: RectificationCheckStatus
  observation: string
  limitations: string[]
  nextSteps: string[]
}
export interface RectificationVerificationReview {
  mode: "review"
  items: RectificationCheckReview[]
  note: string
}
export type RectificationHumanReview =
  | RectificationProposalReview
  | RectificationVerificationReview

export interface ConsultationQuestionDraft {
  questionId: string
  text: string
  rationale: string
  expectedAnswer: string
  sourceIds: string[]
}
export interface ConsultationPreparationResult {
  mode: "prepare"
  title: string
  purpose: string
  summary: string
  facts: AiFinding[]
  timeline: AiFinding[]
  disputes: AiFinding[]
  gaps: string[]
  questions: ConsultationQuestionDraft[]
}
export type ConsultationAnswerStatus = "answered" | "partial" | "unanswered" | "conflicting"
export interface ConsultationResponseMapping {
  mappingId: string
  question: string
  status: ConsultationAnswerStatus
  responseSourceIds: string[]
  summary: string
  conditions: string[]
  conflicts: string[]
  followUps: string[]
  targetIssueSourceId: string
}
export interface ConsultationResponseResult {
  mode: "response"
  consultationSourceId: string
  mappings: ConsultationResponseMapping[]
  gaps: string[]
}
export type ConsultationResult = ConsultationPreparationResult | ConsultationResponseResult
export interface ConsultationReviewLine {
  sourceIndex: number
  included: boolean
  text: string
}
export interface ConsultationPreparationReview {
  mode: "prepare"
  title: string
  purpose: string
  facts: ConsultationReviewLine[]
  timeline: ConsultationReviewLine[]
  disputes: ConsultationReviewLine[]
  gaps: string[]
  questions: ConsultationReviewLine[]
  note: string
}
export type ConsultationResponseDisposition = "saved" | "ignored" | "proposal"
export interface ConsultationResponseMappingReview {
  mappingId: string
  disposition: ConsultationResponseDisposition
  status: ConsultationAnswerStatus
  summary: string
  conditions: string[]
  conflicts: string[]
  followUps: string[]
  targetIssueSourceId: string
  proposalContent: string
}
export interface ConsultationResponseReview {
  mode: "response"
  mappings: ConsultationResponseMappingReview[]
  note: string
}
export type ConsultationHumanReview = ConsultationPreparationReview | ConsultationResponseReview

export type BudgetParameterStatus = "observed" | "assumption" | "unknown" | "conflict"
export interface BudgetNumericParameter {
  value: string
  status: BudgetParameterStatus
  sourceIds: string[]
  note: string
}
export interface BudgetBooleanParameter {
  value: "yes" | "no" | "unknown" | "conflict"
  sourceIds: string[]
  note: string
}
export interface BudgetScenarioCandidate {
  scenarioId: string
  label: string
  materialSourceId: string
  unit: string
  requiredQuantity: BudgetNumericParameter
  wasteRatePercent: BudgetNumericParameter
  requirementIncludesWaste: BudgetBooleanParameter
  packageSize: BudgetNumericParameter
  packageUnitPriceYuan: BudgetNumericParameter
  assumptions: string[]
  conflicts: string[]
  missingFields: string[]
}
export interface BudgetResult {
  goal: string
  scenarios: BudgetScenarioCandidate[]
  ledgerNotes: AiFinding[]
  gaps: string[]
}
export interface BudgetScenarioReview {
  scenarioId: string
  included: boolean
  label: string
  materialSourceId: string
  unit: string
  requiredQuantity: string
  wasteRatePercent: string
  requirementIncludesWaste: "yes" | "no"
  packageSize: string
  packageUnitPriceYuan: string
  note: string
}
export interface BudgetHumanReview {
  scenarios: BudgetScenarioReview[]
  note: string
}

export const PROJECT_SUMMARY_SECTION_KEYS = [
  "progress", "issues", "materials", "finance", "consultations"
] as const
export type ProjectSummarySectionKey = typeof PROJECT_SUMMARY_SECTION_KEYS[number]
export type ProjectSummaryItemStatus =
  | "completed"
  | "in_progress"
  | "pending_confirmation"
  | "blocked"
  | "information_gap"
export interface ProjectSummaryItem {
  itemId: string
  text: string
  status: ProjectSummaryItemStatus
  sourceIds: string[]
}
export interface ProjectSummarySection {
  key: ProjectSummarySectionKey
  title: string
  items: ProjectSummaryItem[]
  gaps: string[]
}
export type ProjectSummaryHandoffStatus = "ready" | "pending" | "missing"
export interface ProjectSummaryHandoffItem {
  itemId: string
  text: string
  status: ProjectSummaryHandoffStatus
  sourceIds: string[]
}
export interface ProjectSummaryResult {
  title: string
  scopeStatement: string
  sections: ProjectSummarySection[]
  handoff: ProjectSummaryHandoffItem[]
  overallGaps: string[]
}
export interface ProjectSummarySectionReview {
  key: ProjectSummarySectionKey
  included: boolean
  title: string
  content: string
}
export interface ProjectSummaryHandoffReview {
  itemId: string
  included: boolean
  text: string
  status: ProjectSummaryHandoffStatus
}
export interface ProjectSummaryHumanReview {
  title: string
  scopeStatement: string
  sections: ProjectSummarySectionReview[]
  handoff: ProjectSummaryHandoffReview[]
  note: string
}

export interface AiResult {
  observations: AiFinding[]
  differences: AiFinding[]
  unknowns: string[]
  suggestions: AiFinding[]
  summary: string
  materialCheck?: MaterialCheckResult
  recordReview?: RecordReviewResult
  imageObservation?: ImageObservationResult
  rectification?: RectificationResult
  consultation?: ConsultationResult
  budget?: BudgetResult
  projectSummary?: ProjectSummaryResult
}
export interface AiUsage {
  promptTokens: number
  cacheHitPromptTokens: number
  cacheMissPromptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
}
export interface AiRunMetrics {
  durationMs: number
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
}
export interface AiJob {
  id: string
  task: AiTaskKind
  mode?: AiTaskMode
  status: "running" | "succeeded" | "failed" | "cancelled"
  result?: AiResult
  error?: string
  model: string
  promptVersion: string
  contractVersion: string
  createdAt: string
  finishedAt?: string
  cancelledAt?: string
  retryOfJobId?: string
  decision: "pending" | "accepted" | "dismissed"
  correction?: string
  materialReview?: MaterialCheckReview
  recordReviewReview?: RecordReviewReview
  imageObservationReview?: ImageObservationReview
  rectificationReview?: RectificationHumanReview
  consultationReview?: ConsultationHumanReview
  budgetReview?: BudgetHumanReview
  projectSummaryReview?: ProjectSummaryHumanReview
  metrics?: AiRunMetrics
}
