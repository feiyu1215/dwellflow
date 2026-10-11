import type { AgreementAggregate } from "./agreements"
import type {
  MaterialInventoryEvent,
  MaterialUsageRecord,
  ReceiptBatch
} from "./material-flow"
import type {
  ProcurementEstimate,
  PurchaseLine,
  ResourceGap,
  UnitConversion
} from "./procurement"
import type {
  CostApprovalEvent,
  FinanceSummary,
  PaymentFact,
  RefundFact
} from "./finance"
import type { IssueWorkflow } from "./issue-flow"
import type {
  AiImageReference,
  AiRunMetrics,
  AiSourceSnapshotReference,
  BudgetHumanReview,
  BudgetResult,
  ConsultationHumanReview,
  ConsultationResult,
  ImageObservationResult,
  ImageObservationReview,
  MaterialCheckResult,
  MaterialCheckReview,
  ProjectSummaryHumanReview,
  ProjectSummaryResult,
  ProjectSummaryScope,
  RecordReviewResult,
  RecordReviewReview,
  RectificationHumanReview,
  RectificationResult
} from "./ai-contract"

export const STAGES = ["尚未确定", "拆改", "水电", "泥瓦", "木工", "油漆", "安装收尾"] as const
export const ROOMS = ["全屋", "客厅", "厨房", "卫生间", "主卧", "次卧", "阳台", "其他"] as const

export type ProjectStage = typeof STAGES[number]
export type ProjectStatus = "active" | "archived" | "trashed"
export type MemberRole = "owner" | "family" | "collaborator"
export type IssueStatus = "pending_confirmation" | "pending_action" | "pending_review" | "closed"

export type ActorMode = "local_demo" | "connected"

export interface ActorRef {
  identityId: string
  displayNameSnapshot: string
  mode: ActorMode
}

export type SpaceKind = "whole_project" | "living_room" | "kitchen" | "bathroom"
  | "bedroom" | "balcony" | "corridor" | "other" | "custom"
export type SpaceStatus = "active" | "inactive"
export type SpaceStageStatus = "not_started" | "in_progress" | "pending_review" | "confirmed_complete"

export interface Space {
  id: string
  projectId: string
  name: string
  kind: SpaceKind
  order: number
  participatesInTopology: boolean
  status: SpaceStatus
  createdBy: ActorRef
  createdAt: string
  updatedAt: string
  version: number
}

export interface SpaceRelation {
  id: string
  projectId: string
  fromSpaceId: string
  toSpaceId: string
  kind: "adjacent" | "access" | "contains" | "other"
  directionHint: "left" | "right" | "up" | "down" | "none"
  status: "active" | "inactive"
  confirmedBy: ActorRef
  confirmedAt: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface SpaceStageState {
  id: string
  projectId: string
  spaceId: string
  stageId: ProjectStage
  status: SpaceStageStatus
  sourceEvidenceIds: string[]
  submittedBy?: ActorRef
  submittedAt?: string
  confirmedBy?: ActorRef
  confirmedAt?: string
  note: string
  updatedAt: string
  version: number
}

export interface LegacyRoomMapping {
  id: string
  projectId: string
  sourceLabel: string
  normalizedLabel: string
  spaceId: string
  confirmedBy: ActorRef
  confirmedAt: string
  version: number
}

export type EvidenceOrigin = "camera" | "photo_library" | "file_import" | "voice_recording"
  | "camera_capture" | "manual_upload" | "legacy_attachment" | "generated_demo"
export type EvidenceCategory = "image" | "audio" | "video" | "document"
export type EvidenceStatus = "pending" | "ready" | "failed" | "hidden" | "missing"
export type EvidenceFailureCode = "size_mismatch" | "checksum_mismatch" | "read_failed"
  | "upload_failed" | "provider_failed" | "missing_original"
export type EvidenceTimeSource = "device" | "provider" | "user_entered" | "document" | "imported" | "unknown"

export type EvidenceStorageRef =
  | { kind: "local_file"; localPath: string }
  | { kind: "server_attachment"; attachmentId: string }

export interface EvidenceAsset {
  id: string
  projectId: string
  origin: EvidenceOrigin
  category: EvidenceCategory
  fileName: string
  mediaType: string
  storageRef?: EvidenceStorageRef
  thumbnailRef?: EvidenceStorageRef
  expectedSizeBytes?: number
  expectedSha256?: string
  actualSizeBytes?: number
  actualSha256?: string
  occurredAt?: string
  capturedAt?: string
  receivedAt?: string
  timeSource: EvidenceTimeSource
  sourceDeviceId?: string
  sourceAttachmentId?: string
  status: EvidenceStatus
  failureCode?: EvidenceFailureCode
  syntheticDisclosure?: string
  createdBy: ActorRef
  createdAt: string
  updatedAt: string
  version: number
}

export type EvidenceTargetType = "project" | "record" | "record_revision" | "issue" | "material"
  | "receipt_batch" | "issue_treatment" | "issue_review" | "consultation" | "camera_session"

export interface EvidenceTargetRef {
  type: EvidenceTargetType
  id: string
  version?: number
}

export type EvidenceRelationKind = "original" | "supporting" | "before" | "after"
  | "delivery_document" | "observes" | "created_from" | "other"

export interface EvidenceLink {
  id: string
  projectId: string
  evidenceId: string
  target: EvidenceTargetRef
  relationKind: EvidenceRelationKind
  spaceId?: string
  stageId?: ProjectStage
  note: string
  status: "active" | "removed"
  createdBy: ActorRef
  createdAt: string
  removedBy?: ActorRef
  removedAt?: string
  version: number
}

export interface Project {
  id: string
  name: string
  stage: ProjectStage
  ownerName: string
  status: ProjectStatus
  targetBudgetFen?: number
  archivedAt?: string
  trashedAt?: string
  purgeAfter?: string
  restoredFromPackageId?: string
  restoredFromPackageFingerprint?: string
  restoreOperationId?: string
  createdAt: string
  updatedAt: string
}

export interface ProjectLifecycleEvent {
  id: string
  projectId: string
  action: "archived" | "reopened" | "trashed" | "restored"
  reason: string
  actorId: string
  createdAt: string
}

export interface RecordItem {
  id: string
  projectId: string
  version: number
  title: string
  note: string
  room: string
  spaceId?: string
  stage: ProjectStage
  creatorName: string
  occurredAt: string
  createdAt: string
  attachments: Attachment[]
}

export interface RecordRevision {
  id: string
  recordId: string
  projectId: string
  version: number
  title: string
  note: string
  room: string
  spaceId?: string
  stage: ProjectStage
  creatorName: string
  occurredAt: string
  attachments: Attachment[]
  changeReason: string
  createdAt: string
}

export interface Attachment {
  id: string
  name: string
  type: "image" | "audio" | "file"
  localPath: string
}

export interface Proposal {
  id: string
  authorName: string
  authorRole: MemberRole
  content: string
  createdAt: string
  decision: "pending" | "accepted" | "rejected"
  decidedAt?: string
}

export interface Issue {
  id: string
  projectId: string
  title: string
  description: string
  room: string
  spaceId?: string
  stage: ProjectStage
  recordId?: string
  assigneeName?: string
  dueAt?: string
  status: IssueStatus
  proposals: Proposal[]
  createdAt: string
  updatedAt: string
}

export type InventoryAction =
  | "received"
  | "issued"
  | "returned_site"
  | "returned_supplier"
  | "waste"
  | "correction_increase"
  | "correction_decrease"

export interface Material {
  id: string
  projectId: string
  name: string
  specification: string
  unit: string
  plannedQuantity: number
  unitPriceFen?: number
  wasteRatePermille?: number
  createdAt: string
}

export interface InventoryEntry {
  id: string
  projectId: string
  materialId: string
  action: InventoryAction
  quantity: number
  note: string
  createdAt: string
}

export type ExpenseAction = "quote" | "approve_increase" | "approve_decrease" | "payment" | "refund"

export interface ExpenseEvent {
  id: string
  projectId: string
  title: string
  category: "material" | "labor" | "transport" | "other"
  action: ExpenseAction
  amountFen: number
  note: string
  createdAt: string
}

export interface CostItem {
  id: string
  projectId: string
  title: string
  category: "material" | "labor" | "transport" | "other"
  materialId?: string
  quotedAmountFen?: number
  note: string
  createdAt: string
}

export type MemberScope = "records" | "issues" | "materials" | "expenses"

export interface ProjectMember {
  id: string
  projectId: string
  name: string
  role: "family" | "collaborator"
  scopes: MemberScope[]
  status: "active" | "revoked"
  createdAt: string
  revokedAt?: string
}

export interface ShareSnapshot {
  id: string
  projectId: string
  title: string
  status: "active" | "revoked" | "expired"
  expiresAt: string
  allowDownload: boolean
  recordCopies: RecordItem[]
  issueCopies: Issue[]
  createdAt: string
  revokedAt?: string
}

export type ConsultationStatus = "draft" | "published" | "closed"
export type ConsultationVersionStatus = "draft" | "published" | "superseded"
export type ConsultationResponseSource = "manual_relay" | "member_direct_local"

export interface ConsultationVersion {
  id: string
  consultationId: string
  revision: number
  status: ConsultationVersionStatus
  question: string
  knownFacts: string[]
  gaps: string[]
  answerQuestions: string[]
  recordIds: string[]
  issueIds: string[]
  recordCopies: RecordItem[]
  issueCopies: Issue[]
  createdAt: string
  publishedAt?: string
  expiresAt?: string
}

export interface Consultation {
  id: string
  projectId: string
  title: string
  status: ConsultationStatus
  version: number
  draftVersionId?: string
  activeVersionId?: string
  versions: ConsultationVersion[]
  createdAt: string
  updatedAt: string
  closedAt?: string
  closeReason?: string
}

export interface ConsultationResponse {
  id: string
  consultationId: string
  consultationVersionId: string
  projectId: string
  source: ConsultationResponseSource
  respondentName: string
  channel: string
  receivedAt: string
  originalText: string
  summary: string
  recordedBy: string
  memberId?: string
  targetIssueId?: string
  status: "pending" | "converted_to_proposal" | "dismissed"
  proposalId?: string
  decisionReason?: string
  createdAt: string
  decidedAt?: string
}

export type CameraProviderKey = "ezviz_hosted" | "gb28181_cloud"
export type CameraStatus = "pending_configuration" | "pending_authorization" | "ready" | "offline" | "revoked" | "verification_failed"

export interface CameraBinding {
  id: string
  projectId: string
  provider: CameraProviderKey
  displayName: string
  room: string
  spaceId?: string
  externalDeviceId: string
  status: CameraStatus
  lastVerifiedAt?: string
  createdAt: string
  revokedAt?: string
}

export type AnalysisSource = "manual" | "rule_reference" | "ai"
export type AnalysisStatus = "draft" | "accepted" | "dismissed" | "failed"

export interface AnalysisNote {
  id: string
  projectId: string
  recordId: string
  taskType: "record_review" | "image_observation" | "material_check" | "consultation"
  source: AnalysisSource
  status: AnalysisStatus
  observations: string[]
  unknowns: string[]
  suggestions: string[]
  knowledgeCardIds: string[]
  createdAt: string
  acceptedAt?: string
}

export interface MaterialCheckRecord {
  id: string
  projectId: string
  materialId: string
  receiptBatchId: string
  method?: "manual" | "ai"
  aiJobId: string
  model: string
  promptVersion: string
  summary: string
  sourceSnapshots?: AiSourceSnapshotReference[]
  originalResult: MaterialCheckResult
  review: MaterialCheckReview
  metrics?: AiRunMetrics
  confirmedBy: string
  confirmedAt: string
}

export interface RecordReviewApplication {
  id: string
  projectId: string
  aiJobId: string
  targetRecordId: string
  targetRecordVersion: number
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: RecordReviewResult
  review: RecordReviewReview
  appliedBy: string
  appliedAt: string
}

export interface ImageObservationApplication {
  id: string
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: ImageObservationResult
  review: ImageObservationReview
  issueLinks: Array<{ itemId: string; issueId: string }>
  appliedBy: string
  appliedAt: string
}

export interface RectificationApplication {
  id: string
  projectId: string
  aiJobId: string
  mode: "proposal" | "review"
  targetIssueId: string
  targetIssueVersionBefore: number
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: RectificationResult
  review: RectificationHumanReview
  proposalLinks: Array<{ optionId: string; proposalId: string }>
  appliedBy: string
  appliedAt: string
}

export interface ConsultationApplication {
  id: string
  projectId: string
  aiJobId: string
  mode: "prepare" | "response"
  targetConsultationId?: string
  targetConsultationVersionBefore?: number
  createdConsultationId?: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: ConsultationResult
  review: ConsultationHumanReview
  proposalLinks: Array<{
    mappingId: string
    proposalId: string
    issueId: string
    responseIds: string[]
  }>
  appliedBy: string
  appliedAt: string
}

export interface BudgetResourceFacts {
  confirmedConsumedMilli: number
  availableInventoryMilli: number
  verifiableIssuedUnusedMilli: number
  validInTransitMilli: number
  pendingVerificationMilli: number
  warnings: string[]
}

export interface BudgetScenarioCalculation {
  scenarioId: string
  label: string
  materialId?: string
  unit: string
  requiredQuantityMilli: number
  wasteRatePermille: number
  requirementIncludesWaste: boolean
  packageSizeMilli: number
  packageUnitPriceTenThousandthYuan?: number
  totalRequirement: ProcurementEstimate
  resourceFacts?: BudgetResourceFacts
  resourceGap?: ResourceGap
  recommendedPurchase?: ProcurementEstimate
  note: string
}

export interface BudgetFinanceSnapshot {
  costItemId: string
  title: string
  quotedAmountFen?: number
  summary: FinanceSummary
}

export interface BudgetEstimateApplication {
  id: string
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  originalResult: BudgetResult
  review: BudgetHumanReview
  scenarios: BudgetScenarioCalculation[]
  financeSnapshots: BudgetFinanceSnapshot[]
  appliedBy: string
  appliedAt: string
}

export interface ProjectSummaryIssueSnapshot {
  issueId: string
  title: string
  status: IssueStatus
  version: number
}

export interface ProjectSummaryApplication {
  id: string
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  scope: ProjectSummaryScope
  sourceSnapshots: AiSourceSnapshotReference[]
  originalResult: ProjectSummaryResult
  review: ProjectSummaryHumanReview
  issueSnapshots: ProjectSummaryIssueSnapshot[]
  financeSnapshots: BudgetFinanceSnapshot[]
  appliedBy: string
  appliedAt: string
}

export interface AppState {
  currentProjectId: string
  projects: Project[]
  projectLifecycleEvents: ProjectLifecycleEvent[]
  spaces: Space[]
  spaceRelations: SpaceRelation[]
  spaceStageStates: SpaceStageState[]
  legacyRoomMappings: LegacyRoomMapping[]
  evidenceAssets: EvidenceAsset[]
  evidenceLinks: EvidenceLink[]
  records: RecordItem[]
  recordRevisions: RecordRevision[]
  issues: Issue[]
  issueWorkflows: IssueWorkflow[]
  materials: Material[]
  inventory: InventoryEntry[]
  expenses: ExpenseEvent[]
  agreements: AgreementAggregate[]
  purchaseLines: PurchaseLine[]
  receiptBatches: ReceiptBatch[]
  unitConversions: UnitConversion[]
  materialInventoryEvents: MaterialInventoryEvent[]
  materialUsageRecords: MaterialUsageRecord[]
  costItems: CostItem[]
  costApprovals: CostApprovalEvent[]
  paymentFacts: PaymentFact[]
  refundFacts: RefundFact[]
  members: ProjectMember[]
  shares: ShareSnapshot[]
  consultations: Consultation[]
  consultationResponses: ConsultationResponse[]
  cameras: CameraBinding[]
  analyses: AnalysisNote[]
  materialChecks: MaterialCheckRecord[]
  recordReviewApplications: RecordReviewApplication[]
  imageObservationApplications: ImageObservationApplication[]
  rectificationApplications: RectificationApplication[]
  consultationApplications: ConsultationApplication[]
  budgetEstimateApplications: BudgetEstimateApplication[]
  projectSummaryApplications: ProjectSummaryApplication[]
}

export const STATUS_META: Record<IssueStatus, { label: string; tone: string }> = {
  pending_confirmation: { label: "待确认", tone: "amber" },
  pending_action: { label: "待处理", tone: "amber" },
  pending_review: { label: "待复查", tone: "green" },
  closed: { label: "已关闭", tone: "default" }
}

export function nextIssueStatus(status: IssueStatus): IssueStatus {
  if (status === "pending_confirmation") return "pending_action"
  if (status === "pending_action") return "pending_review"
  if (status === "pending_review") return "closed"
  return "closed"
}

export function canOwnerAdvance(issue: Issue): { allowed: boolean; reason?: string } {
  if (issue.status === "pending_confirmation" && !issue.proposals.some(item => item.decision === "accepted")) {
    return { allowed: false, reason: "负责人需先采纳一个处理预案" }
  }
  return { allowed: true }
}

export function acceptProposal(issue: Issue, proposalId: string, decidedAt: string): Issue {
  if (issue.status !== "pending_confirmation") throw new Error("只有待确认事项可以采纳预案")
  if (!issue.proposals.some(item => item.id === proposalId)) throw new Error("预案不存在")
  return {
    ...issue,
    proposals: issue.proposals.map(item => ({
      ...item,
      decision: item.id === proposalId ? "accepted" : "rejected",
      decidedAt
    })),
    updatedAt: decidedAt
  }
}

export function advanceIssue(issue: Issue, now: string): Issue {
  if (issue.status === "closed") throw new Error("已关闭事项需使用重新打开操作")
  const check = canOwnerAdvance(issue)
  if (!check.allowed) throw new Error(check.reason)
  return { ...issue, status: nextIssueStatus(issue.status), updatedAt: now }
}

export function reopenIssue(issue: Issue, now: string): Issue {
  if (issue.status !== "closed") throw new Error("只有已关闭事项可以重新打开")
  return { ...issue, status: "pending_action", updatedAt: now }
}

const INVENTORY_DIRECTION: Record<InventoryAction, 1 | -1> = {
  received: 1,
  issued: -1,
  returned_site: 1,
  returned_supplier: -1,
  waste: -1,
  correction_increase: 1,
  correction_decrease: -1
}

export function inventoryBalance(entries: InventoryEntry[], materialId: string): number {
  return entries
    .filter(item => item.materialId === materialId)
    .reduce((total, item) => total + INVENTORY_DIRECTION[item.action] * item.quantity, 0)
}

export function materialEstimate(material: Pick<Material, "plannedQuantity" | "unitPriceFen" | "wasteRatePermille">) {
  const wasteRatePermille = material.wasteRatePermille || 0
  const requiredQuantity = Math.round(material.plannedQuantity * (1000 + wasteRatePermille)) / 1000
  const amountFen = Math.round(requiredQuantity * (material.unitPriceFen || 0))
  return { requiredQuantity, amountFen }
}

export function validateInventoryEntry(
  entries: InventoryEntry[],
  input: Pick<InventoryEntry, "materialId" | "action" | "quantity">
): { valid: boolean; reason?: string } {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { valid: false, reason: "数量必须大于 0" }
  }
  const projected = inventoryBalance(entries, input.materialId) + INVENTORY_DIRECTION[input.action] * input.quantity
  if (projected < 0) return { valid: false, reason: "本次操作会使库存小于 0，请先核对收货记录" }
  return { valid: true }
}

export function budgetSummary(events: ExpenseEvent[]) {
  return events.reduce((summary, item) => {
    if (item.action === "quote") summary.quotedFen += item.amountFen
    if (item.action === "approve_increase") summary.approvedFen += item.amountFen
    if (item.action === "approve_decrease") summary.approvedFen -= item.amountFen
    if (item.action === "payment") summary.paidFen += item.amountFen
    if (item.action === "refund") summary.refundedFen += item.amountFen
    summary.netPaidFen = summary.paidFen - summary.refundedFen
    return summary
  }, { quotedFen: 0, approvedFen: 0, paidFen: 0, refundedFen: 0, netPaidFen: 0 })
}

export function validateExpenseEvent(
  events: ExpenseEvent[],
  input: Pick<ExpenseEvent, "action" | "amountFen">
): { valid: boolean; reason?: string } {
  if (!Number.isFinite(input.amountFen) || input.amountFen <= 0) {
    return { valid: false, reason: "金额必须大于 0" }
  }
  const summary = budgetSummary(events)
  if (input.action === "approve_decrease" && input.amountFen > summary.approvedFen) {
    return { valid: false, reason: "批准核减不能超过当前已批准费用" }
  }
  if (input.action === "refund" && input.amountFen > summary.netPaidFen) {
    return { valid: false, reason: "退款不能超过当前净付款" }
  }
  return { valid: true }
}
