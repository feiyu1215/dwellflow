import {
  STAGES,
  inventoryBalance,
  validateExpenseEvent,
  validateInventoryEntry,
  type AnalysisNote,
  type AppState,
  type ActorRef,
  type BudgetEstimateApplication,
  type CameraBinding,
  type Consultation,
  type ConsultationApplication,
  type ConsultationResponse,
  type ConsultationVersion,
  type CostItem,
  type ExpenseEvent,
  type EvidenceAsset,
  type EvidenceCategory,
  type EvidenceLink,
  type EvidenceOrigin,
  type EvidenceRelationKind,
  type EvidenceTargetRef,
  type InventoryEntry,
  type Issue,
  type Material,
  type MaterialCheckRecord,
  type RecordReviewApplication,
  type ImageObservationApplication,
  type RectificationApplication,
  type MemberScope,
  type Project,
  type ProjectStage,
  type ProjectLifecycleEvent,
  type ProjectMember,
  type ProjectSummaryApplication,
  type RecordItem,
  type RecordRevision,
  type ShareSnapshot,
  type Space,
  type SpaceKind,
  type SpaceRelation,
  type SpaceStageState,
  type SpaceStageStatus
} from "./domain"
import {
  approveAgreementVersion,
  createAgreement,
  submitAgreementVersion,
  type AgreementAggregate,
  type AgreementTerm
} from "./agreements"
import {
  allocateReceipt,
  appendInventoryEvent,
  createReceiptBatch,
  type MaterialInventoryAction,
  type MaterialInventoryEvent,
  type ReceiptBatch
} from "./material-flow"
import { createPurchaseLine, type PurchaseLine } from "./procurement"
import { parseQuantityMilli } from "./precision"
import {
  addIssueProposal,
  createIssueWorkflow as buildIssueWorkflow,
  reopenIssueWorkflow,
  reviewIssueTreatment,
  selectIssueProposal,
  submitIssueTreatment,
  type IssueCloseReason,
  type IssueWorkflow
} from "./issue-flow"
import {
  appendApprovalEvent,
  createPaymentFact as buildPaymentFact,
  createRefundFact as buildRefundFact,
  decidePaymentFact,
  decideRefundFact,
  type CostApprovalEvent,
  type PaymentFact,
  type RefundFact
} from "./finance"
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
import { buildAiSourcePlan } from "./ai-sources"
import { calculateBudgetScenario, selectedFinanceSnapshots } from "./budget"
import { evaluateLocalAccess, localOwnerIdentity } from "./local-access"
import {
  assertSpaceRelationAllowed,
  buildLegacyRoomMapping,
  buildSpaceStageState,
  inferredSpaceKind,
  normalizeRoomLabel,
  validateSpace
} from "./spaces"
import {
  assertEvidenceLinkAllowed,
  evidenceCategoryForAttachment,
  normalizeSha256,
  validateReadyEvidence
} from "./evidence"
import {
  ACTIVE_STATE_SCHEMA_KEY,
  LEGACY_STATE_STORAGE_KEY,
  V2_STATE_STORAGE_KEY,
  executeR8StateMigration,
  readActiveStateSelection,
  stateSourceFingerprint,
  validateLocalStateV2Envelope,
  type LocalStateV2Envelope,
  type R8MigrationResult
} from "./state-migration"
export const PROJECT_RECYCLE_RETENTION_DAYS = 30

const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const localOwnerActor = (): ActorRef => ({
  identityId: "owner-local",
  displayNameSnapshot: "项目负责人",
  mode: "local_demo"
})

function requireProject(state: AppState, projectId: string): Project {
  const project = state.projects.find(item => item.id === projectId)
  if (!project) throw new Error("项目不存在")
  return project
}

export function isProjectWritable(project?: Project): boolean {
  return project?.status === "active"
}

function assertProjectWritable(state: AppState, projectId: string): Project {
  const project = requireProject(state, projectId)
  if (project.status === "archived") throw new Error("项目已归档，请先重新开启")
  if (project.status === "trashed") throw new Error("项目在回收站中，请先恢复")
  return project
}

function assertProjectReadable(state: AppState, projectId: string): Project {
  const project = requireProject(state, projectId)
  if (project.status === "trashed") throw new Error("项目在回收站中，不能读取或导出资料")
  return project
}

function assertLocalSpaceManagement(state: AppState, projectId: string): void {
  const decision = evaluateLocalAccess(state, localOwnerIdentity(), {
    projectId,
    resource: "space",
    action: "manage"
  })
  if (!decision.allowed) throw new Error("当前身份不能管理项目空间")
}

function assertLocalEvidenceManagement(state: AppState, projectId: string): void {
  const decision = evaluateLocalAccess(state, localOwnerIdentity(), {
    projectId,
    resource: "evidence",
    action: "manage"
  })
  if (!decision.allowed) throw new Error("当前身份不能管理项目证据")
}

function lifecycleEvent(
  projectId: string,
  action: ProjectLifecycleEvent["action"],
  reason: string,
  createdAt: string
): ProjectLifecycleEvent {
  const normalizedReason = reason.trim()
  if (!normalizedReason) throw new Error("请填写操作原因")
  return {
    id: id("project_event"),
    projectId,
    action,
    reason: normalizedReason,
    actorId: "owner-local",
    createdAt
  }
}

function nextSelectableProjectId(projects: Project[], excludedId: string): string {
  return projects.find(item => item.id !== excludedId && item.status === "active")?.id
    || projects.find(item => item.id !== excludedId && item.status === "archived")?.id
    || ""
}

function seedState(): AppState {
  const timestamp = now()
  const project: Project = {
    id: "project_demo",
    name: "我的装修项目",
    stage: "水电",
    ownerName: "项目负责人",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  }
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
    records: [],
    recordRevisions: [],
    issues: [],
    issueWorkflows: [],
    materials: [],
    inventory: [],
    expenses: [],
    agreements: [],
    purchaseLines: [],
    receiptBatches: [],
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

function normalizeStoredState(saved: AppState): AppState {
  const projects = saved.projects.map(item => ({
    ...item,
    status: item.status || "active"
  }))
  const currentProjectId = projects.some(item =>
    item.id === saved.currentProjectId && item.status !== "trashed")
    ? saved.currentProjectId
    : nextSelectableProjectId(projects, "")
  const records = (saved.records || []).map(item => ({
    ...item,
    version: item.version || 1,
    attachments: item.attachments || []
  }))
  const recordRevisions = saved.recordRevisions?.length
    ? saved.recordRevisions.map(item => ({
      ...item,
      attachments: item.attachments || []
    }))
    : records.map(item => ({
      ...item,
      id: `revision_migrated_${item.id}`,
      recordId: item.id,
      changeReason: "从早期本地记录迁移",
      createdAt: item.createdAt
    }))
  return {
    ...saved,
    currentProjectId,
    projects,
    projectLifecycleEvents: saved.projectLifecycleEvents || [],
    spaces: saved.spaces || [],
    spaceRelations: saved.spaceRelations || [],
    spaceStageStates: saved.spaceStageStates || [],
    legacyRoomMappings: saved.legacyRoomMappings || [],
    evidenceAssets: saved.evidenceAssets || [],
    evidenceLinks: saved.evidenceLinks || [],
    records,
    recordRevisions,
    issues: saved.issues || [],
    issueWorkflows: saved.issueWorkflows || [],
    materials: saved.materials || [],
    inventory: saved.inventory || [],
    expenses: saved.expenses || [],
    agreements: saved.agreements || [],
    purchaseLines: saved.purchaseLines || [],
    receiptBatches: saved.receiptBatches || [],
    unitConversions: saved.unitConversions || [],
    materialInventoryEvents: saved.materialInventoryEvents || [],
    materialUsageRecords: saved.materialUsageRecords || [],
    costItems: saved.costItems || [],
    costApprovals: saved.costApprovals || [],
    paymentFacts: saved.paymentFacts || [],
    refundFacts: saved.refundFacts || [],
    members: saved.members || [],
    shares: saved.shares || [],
    consultations: saved.consultations || [],
    consultationResponses: saved.consultationResponses || [],
    cameras: saved.cameras || [],
    analyses: saved.analyses || [],
    materialChecks: saved.materialChecks || [],
    recordReviewApplications: saved.recordReviewApplications || [],
    imageObservationApplications: saved.imageObservationApplications || [],
    rectificationApplications: saved.rectificationApplications || [],
    consultationApplications: (saved.consultationApplications || []).map(item => ({
      ...item,
      imageRefs: item.imageRefs || [],
      proposalLinks: (item.proposalLinks || []).map(link => ({
        ...link,
        responseIds: link.responseIds || []
      }))
    })),
    budgetEstimateApplications: saved.budgetEstimateApplications || [],
    projectSummaryApplications: saved.projectSummaryApplications || []
  }
}

export function activateV2State(): R8MigrationResult {
  return executeR8StateMigration<AppState>({
    freshState: seedState,
    transformLegacyState(value) {
      if (!value || typeof value !== "object" || !Array.isArray((value as AppState).projects)) {
        throw new Error("v1 状态无法转换为 AppState")
      }
      return normalizeStoredState(value as AppState)
    }
  })
}

export function loadState(): AppState {
  const selection = readActiveStateSelection()
  if (selection.status === "blocked") {
    throw new Error(`本地状态读取被阻止：${selection.errors.join("；")}`)
  }
  if (selection.status === "empty") return seedState()
  const saved = selection.effectiveSchema === "v2"
    ? (selection.value as LocalStateV2Envelope<AppState>).state
    : selection.value as AppState
  if (!saved || !Array.isArray(saved.projects)) {
    throw new Error("本地状态格式不正确，已阻止空数据覆盖")
  }
  return normalizeStoredState(saved)
}

export function saveState(state: AppState): void {
  const selection = readActiveStateSelection()
  if (selection.status === "blocked") {
    throw new Error(`本地状态写入被阻止：${selection.errors.join("；")}`)
  }
  if (selection.effectiveSchema !== "v2") {
    wx.setStorageSync(LEGACY_STATE_STORAGE_KEY, state)
    return
  }
  const current = selection.value as LocalStateV2Envelope<AppState>
  const envelope: LocalStateV2Envelope<AppState> = {
    ...current,
    validatedAt: now(),
    state
  }
  const errors = validateLocalStateV2Envelope(envelope)
  if (errors.length) throw new Error(`v2 状态写入校验失败：${errors.join("；")}`)
  wx.setStorageSync(V2_STATE_STORAGE_KEY, envelope)
  const reread = wx.getStorageSync<unknown>(V2_STATE_STORAGE_KEY)
  const rereadErrors = validateLocalStateV2Envelope(reread)
  if (rereadErrors.length
    || stateSourceFingerprint((reread as LocalStateV2Envelope<AppState>).state) !== stateSourceFingerprint(state)) {
    throw new Error(`v2 状态写入后二次校验失败${rereadErrors.length ? `：${rereadErrors.join("；")}` : ""}`)
  }
  if (wx.getStorageSync<unknown>(ACTIVE_STATE_SCHEMA_KEY) !== "v2") {
    throw new Error("v2 写入期间活动 schema 指针发生变化")
  }
}

export function currentProject(state = loadState()): Project | undefined {
  return state.projects.find(item =>
    item.id === state.currentProjectId && item.status !== "trashed")
}

export function createProject(input: Pick<Project, "name" | "stage" | "ownerName">): Project {
  const state = loadState()
  const timestamp = now()
  const project: Project = {
    ...input,
    id: id("project"),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  }
  saveState({ ...state, currentProjectId: project.id, projects: [project, ...state.projects] })
  return project
}

export function updateProjectDetails(input: {
  projectId: string
  name: string
  ownerName: string
  stage: Project["stage"]
}): Project {
  const state = loadState()
  const current = assertProjectWritable(state, input.projectId)
  if (!input.name.trim() || !input.ownerName.trim()) throw new Error("项目和负责人不能为空")
  const next: Project = {
    ...current,
    name: input.name.trim(),
    ownerName: input.ownerName.trim(),
    stage: input.stage,
    updatedAt: now()
  }
  saveState({
    ...state,
    projects: state.projects.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function selectProject(projectId: string): void {
  const state = loadState()
  const project = requireProject(state, projectId)
  if (project.status === "trashed") throw new Error("回收站项目不能设为当前项目")
  saveState({ ...state, currentProjectId: projectId })
}

export function createSpace(input: {
  projectId: string
  name: string
  kind?: SpaceKind
  participatesInTopology?: boolean
}): Space {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalSpaceManagement(state, input.projectId)
  const name = normalizeRoomLabel(input.name)
  const kind = input.kind || inferredSpaceKind(name)
  const timestamp = now()
  const item: Space = {
    id: id("space"),
    projectId: input.projectId,
    name,
    kind,
    order: state.spaces.filter(space => space.projectId === input.projectId).reduce(
      (maximum, space) => Math.max(maximum, space.order), -1) + 1,
    participatesInTopology: kind === "whole_project" ? false : input.participatesInTopology !== false,
    status: "active",
    createdBy: localOwnerActor(),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1
  }
  const errors = validateSpace(item)
  if (errors.length) throw new Error(errors.join("；"))
  saveState({ ...state, spaces: [...state.spaces, item] })
  return item
}

export function updateSpace(input: {
  spaceId: string
  expectedVersion: number
  name: string
  kind: SpaceKind
  participatesInTopology: boolean
}): Space {
  const state = loadState()
  const current = state.spaces.find(item => item.id === input.spaceId)
  if (!current) throw new Error("空间不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalSpaceManagement(state, current.projectId)
  if (current.version !== input.expectedVersion) throw new Error("空间已更新，请重新打开")
  const next: Space = {
    ...current,
    name: normalizeRoomLabel(input.name),
    kind: input.kind,
    participatesInTopology: input.kind === "whole_project" ? false : input.participatesInTopology,
    updatedAt: now(),
    version: current.version + 1
  }
  const errors = validateSpace(next)
  if (errors.length) throw new Error(errors.join("；"))
  saveState({ ...state, spaces: state.spaces.map(item => item.id === next.id ? next : item) })
  return next
}

export function moveSpace(spaceId: string, direction: "up" | "down"): Space[] {
  const state = loadState()
  const current = state.spaces.find(item => item.id === spaceId)
  if (!current) throw new Error("空间不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalSpaceManagement(state, current.projectId)
  const ordered = state.spaces.filter(item => item.projectId === current.projectId && item.status === "active")
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
  const index = ordered.findIndex(item => item.id === spaceId)
  const targetIndex = direction === "up" ? index - 1 : index + 1
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return ordered
  const reordered = [...ordered]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(targetIndex, 0, moved)
  const timestamp = now()
  const orderById = new Map(reordered.map((item, order) => [item.id, order]))
  const spaces = state.spaces.map(item => {
    const nextOrder = orderById.get(item.id)
    return nextOrder !== undefined && nextOrder !== item.order
      ? { ...item, order: nextOrder, updatedAt: timestamp, version: item.version + 1 }
      : item
  })
  saveState({ ...state, spaces })
  return spaces.filter(item => item.projectId === current.projectId && item.status === "active")
    .sort((a, b) => a.order - b.order)
}

export function setSpaceActive(spaceId: string, expectedVersion: number, active: boolean): Space {
  const state = loadState()
  const current = state.spaces.find(item => item.id === spaceId)
  if (!current) throw new Error("空间不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalSpaceManagement(state, current.projectId)
  if (current.version !== expectedVersion) throw new Error("空间已更新，请重新打开")
  const next: Space = {
    ...current,
    status: active ? "active" : "inactive",
    updatedAt: now(),
    version: current.version + 1
  }
  saveState({
    ...state,
    spaces: state.spaces.map(item => item.id === next.id ? next : item),
    spaceRelations: active ? state.spaceRelations : state.spaceRelations.map(item =>
      item.status === "active" && (item.fromSpaceId === spaceId || item.toSpaceId === spaceId)
        ? { ...item, status: "inactive", updatedAt: next.updatedAt, version: item.version + 1 }
        : item)
  })
  return next
}

export function createSpaceRelation(input: {
  projectId: string
  fromSpaceId: string
  toSpaceId: string
  kind: SpaceRelation["kind"]
  directionHint: SpaceRelation["directionHint"]
}): SpaceRelation {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalSpaceManagement(state, input.projectId)
  assertSpaceRelationAllowed(state.spaces, state.spaceRelations, input)
  const timestamp = now()
  const item: SpaceRelation = {
    ...input,
    id: id("space_relation"),
    status: "active",
    confirmedBy: localOwnerActor(),
    confirmedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1
  }
  saveState({ ...state, spaceRelations: [...state.spaceRelations, item] })
  return item
}

export function setSpaceStageStatus(input: {
  projectId: string
  spaceId: string
  stageId: ProjectStage
  status: SpaceStageStatus
  note: string
  expectedVersion: number
}): SpaceStageState {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalSpaceManagement(state, input.projectId)
  const space = state.spaces.find(item => item.id === input.spaceId && item.projectId === input.projectId)
  if (!space || space.status !== "active") throw new Error("只能更新当前项目中的有效空间")
  const previous = state.spaceStageStates.find(item => item.projectId === input.projectId
    && item.spaceId === input.spaceId && item.stageId === input.stageId)
  if (input.expectedVersion !== (previous?.version || 0)) throw new Error("空间阶段状态已更新，请重新打开")
  const next = buildSpaceStageState({
    id: id("space_stage"),
    ...input,
    actor: localOwnerActor(),
    timestamp: now(),
    previous
  })
  saveState({
    ...state,
    spaceStageStates: previous
      ? state.spaceStageStates.map(item => item.id === previous.id ? next : item)
      : [...state.spaceStageStates, next]
  })
  return next
}

export function mapLegacyRoomLabel(input: {
  projectId: string
  sourceLabel: string
  spaceId: string
}): void {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalSpaceManagement(state, input.projectId)
  const space = state.spaces.find(item => item.id === input.spaceId && item.projectId === input.projectId)
  if (!space || space.status !== "active") throw new Error("请选择当前项目中的有效空间")
  const normalizedLabel = normalizeRoomLabel(input.sourceLabel)
  const previous = state.legacyRoomMappings.find(item => item.projectId === input.projectId
    && item.normalizedLabel === normalizedLabel)
  const mapping = previous?.spaceId === input.spaceId ? previous : buildLegacyRoomMapping({
    id: id("room_mapping"), ...input, actor: localOwnerActor(), timestamp: now(), previous
  })
  const matches = (projectId: string, room: string, currentSpaceId?: string) =>
    projectId === input.projectId && !currentSpaceId && normalizeRoomLabel(room) === normalizedLabel
  saveState({
    ...state,
    records: state.records.map(item => matches(item.projectId, item.room, item.spaceId)
      ? { ...item, spaceId: input.spaceId }
      : item),
    recordRevisions: state.recordRevisions.map(item => matches(item.projectId, item.room, item.spaceId)
      ? { ...item, spaceId: input.spaceId }
      : item),
    issues: state.issues.map(item => matches(item.projectId, item.room, item.spaceId)
      ? { ...item, spaceId: input.spaceId }
      : item),
    cameras: state.cameras.map(item => matches(item.projectId, item.room, item.spaceId)
      ? { ...item, spaceId: input.spaceId }
      : item),
    legacyRoomMappings: previous?.spaceId === input.spaceId
      ? state.legacyRoomMappings
      : previous
      ? state.legacyRoomMappings.map(item => item.id === previous.id ? mapping : item)
      : [...state.legacyRoomMappings, mapping]
  })
}

function buildReadyEvidenceAsset(input: {
  projectId: string
  origin: EvidenceOrigin
  category: EvidenceCategory
  fileName: string
  mediaType: string
  localPath: string
  sizeBytes: number
  sha256: string
  sourceAttachmentId?: string
  occurredAt?: string
  capturedAt?: string
  timeSource?: EvidenceAsset["timeSource"]
}): EvidenceAsset {
  const timestamp = now()
  const asset: EvidenceAsset = {
    id: id("evidence"),
    projectId: input.projectId,
    origin: input.origin,
    category: input.category,
    fileName: input.fileName.trim(),
    mediaType: input.mediaType.trim(),
    storageRef: { kind: "local_file", localPath: input.localPath },
    actualSizeBytes: input.sizeBytes,
    actualSha256: normalizeSha256(input.sha256),
    occurredAt: input.occurredAt,
    capturedAt: input.capturedAt,
    receivedAt: timestamp,
    timeSource: input.timeSource || "unknown",
    sourceAttachmentId: input.sourceAttachmentId,
    status: "ready",
    createdBy: localOwnerActor(),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1
  }
  validateReadyEvidence(asset)
  return asset
}

function buildEvidenceLink(input: {
  projectId: string
  evidenceId: string
  target: EvidenceTargetRef
  relationKind: EvidenceRelationKind
  spaceId?: string
  stageId?: ProjectStage
  note?: string
}): EvidenceLink {
  const timestamp = now()
  const note = (input.note || "").trim()
  if (note.length > 500) throw new Error("证据关联说明不能超过 500 字")
  return {
    id: id("evidence_link"),
    projectId: input.projectId,
    evidenceId: input.evidenceId,
    target: { ...input.target },
    relationKind: input.relationKind,
    spaceId: input.spaceId,
    stageId: input.stageId,
    note,
    status: "active",
    createdBy: localOwnerActor(),
    createdAt: timestamp,
    version: 1
  }
}

export function registerLocalEvidence(input: {
  projectId: string
  origin: EvidenceOrigin
  category: EvidenceCategory
  fileName: string
  mediaType: string
  localPath: string
  sizeBytes: number
  sha256: string
  occurredAt?: string
  capturedAt?: string
}): { asset: EvidenceAsset; link: EvidenceLink } {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalEvidenceManagement(state, input.projectId)
  const asset = buildReadyEvidenceAsset(input)
  const target: EvidenceTargetRef = { type: "project", id: input.projectId }
  const withAsset = { ...state, evidenceAssets: [...state.evidenceAssets, asset] }
  assertEvidenceLinkAllowed(withAsset, {
    projectId: input.projectId, evidenceId: asset.id, target, relationKind: "original"
  })
  const link = buildEvidenceLink({
    projectId: input.projectId, evidenceId: asset.id, target, relationKind: "original"
  })
  saveState({ ...withAsset, evidenceLinks: [...state.evidenceLinks, link] })
  return { asset, link }
}

export function registerLegacyAttachmentEvidence(input: {
  projectId: string
  sourceType: "record" | "record_revision"
  sourceId: string
  attachmentId: string
  inspection?: { sizeBytes: number; sha256: string }
}): { asset: EvidenceAsset; link: EvidenceLink; reused: boolean } {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalEvidenceManagement(state, input.projectId)
  const source = input.sourceType === "record"
    ? state.records.find(item => item.id === input.sourceId && item.projectId === input.projectId)
    : state.recordRevisions.find(item => item.id === input.sourceId && item.projectId === input.projectId)
  if (!source) throw new Error("旧附件来源不存在或不属于当前项目")
  const attachment = source.attachments.find(item => item.id === input.attachmentId)
  if (!attachment) throw new Error("旧附件已变化，请刷新后重试")
  const existing = state.evidenceAssets.find(item => item.projectId === input.projectId
    && item.sourceAttachmentId === attachment.id)
  const timestamp = now()
  const asset = existing || (input.inspection ? buildReadyEvidenceAsset({
      projectId: input.projectId,
      origin: "legacy_attachment",
      category: evidenceCategoryForAttachment(attachment.type),
      fileName: attachment.name,
      mediaType: attachment.type === "image" ? "image/*" : attachment.type === "audio" ? "audio/*" : "application/octet-stream",
      localPath: attachment.localPath,
      sizeBytes: input.inspection.sizeBytes,
      sha256: input.inspection.sha256,
      sourceAttachmentId: attachment.id,
      occurredAt: source.occurredAt,
      timeSource: source.occurredAt ? "user_entered" : "unknown"
    }) : {
      id: id("evidence"), projectId: input.projectId, origin: "legacy_attachment",
      category: evidenceCategoryForAttachment(attachment.type), fileName: attachment.name,
      mediaType: attachment.type === "image" ? "image/*" : attachment.type === "audio" ? "audio/*" : "application/octet-stream",
      storageRef: { kind: "local_file", localPath: attachment.localPath },
      occurredAt: source.occurredAt, receivedAt: timestamp,
      timeSource: source.occurredAt ? "user_entered" : "unknown",
      sourceAttachmentId: attachment.id, status: "missing", failureCode: "missing_original",
      createdBy: localOwnerActor(), createdAt: timestamp, updatedAt: timestamp, version: 1
    } satisfies EvidenceAsset)
  const withAsset: AppState = existing ? state : { ...state, evidenceAssets: [...state.evidenceAssets, asset] }
  const sources = [
    ...state.records.filter(item => item.projectId === input.projectId
      && item.attachments.some(file => file.id === attachment.id))
      .map(item => ({ sourceType: "record" as const, source: item })),
    ...state.recordRevisions.filter(item => item.projectId === input.projectId
      && item.attachments.some(file => file.id === attachment.id))
      .map(item => ({ sourceType: "record_revision" as const, source: item }))
  ]
  let evidenceLinks = [...withAsset.evidenceLinks]
  let primaryLink: EvidenceLink | undefined
  for (const entry of sources) {
    const target: EvidenceTargetRef = { type: entry.sourceType, id: entry.source.id, version: entry.source.version }
    const duplicate = assertEvidenceLinkAllowed({ ...withAsset, evidenceLinks }, {
      projectId: input.projectId, evidenceId: asset.id, target, relationKind: "created_from",
      spaceId: entry.source.spaceId
    })
    const link = duplicate || buildEvidenceLink({
      projectId: input.projectId, evidenceId: asset.id, target, relationKind: "created_from",
      spaceId: entry.source.spaceId, stageId: entry.source.stage
    })
    if (!duplicate) evidenceLinks.push(link)
    if (entry.sourceType === input.sourceType && entry.source.id === input.sourceId) primaryLink = link
  }
  if (!primaryLink) throw new Error("旧附件来源在登记前发生变化")
  if (!existing || evidenceLinks.length !== state.evidenceLinks.length) saveState({ ...withAsset, evidenceLinks })
  return { asset, link: primaryLink, reused: Boolean(existing) }
}

export function createEvidenceLink(input: {
  projectId: string
  evidenceId: string
  target: EvidenceTargetRef
  relationKind: EvidenceRelationKind
  spaceId?: string
  stageId?: ProjectStage
  note?: string
}): EvidenceLink {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  assertLocalEvidenceManagement(state, input.projectId)
  const duplicate = assertEvidenceLinkAllowed(state, input)
  if (duplicate) return duplicate
  const link = buildEvidenceLink(input)
  saveState({ ...state, evidenceLinks: [...state.evidenceLinks, link] })
  return link
}

export function removeEvidenceLink(linkId: string, expectedVersion: number): EvidenceLink {
  const state = loadState()
  const current = state.evidenceLinks.find(item => item.id === linkId)
  if (!current) throw new Error("证据关联不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalEvidenceManagement(state, current.projectId)
  if (current.version !== expectedVersion) throw new Error("证据关联已更新，请刷新后重试")
  if (current.status === "removed") return current
  if (current.relationKind === "original" || current.relationKind === "created_from") {
    throw new Error("来源关联用于保留证据来历，不能解除")
  }
  const timestamp = now()
  const next: EvidenceLink = {
    ...current,
    status: "removed",
    removedBy: localOwnerActor(),
    removedAt: timestamp,
    version: current.version + 1
  }
  saveState({ ...state, evidenceLinks: state.evidenceLinks.map(item => item.id === linkId ? next : item) })
  return next
}

export function setEvidenceHidden(evidenceId: string, expectedVersion: number, hidden: boolean): EvidenceAsset {
  const state = loadState()
  const current = state.evidenceAssets.find(item => item.id === evidenceId)
  if (!current) throw new Error("证据不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalEvidenceManagement(state, current.projectId)
  if (current.version !== expectedVersion) throw new Error("证据已更新，请刷新后重试")
  if (hidden && current.status !== "ready") throw new Error("只有可用证据可以隐藏")
  if (!hidden && current.status !== "hidden") throw new Error("只有已隐藏证据可以恢复")
  const next: EvidenceAsset = { ...current, status: hidden ? "hidden" : "ready", failureCode: undefined,
    updatedAt: now(), version: current.version + 1 }
  saveState({ ...state, evidenceAssets: state.evidenceAssets.map(item => item.id === evidenceId ? next : item) })
  return next
}

export function updateEvidenceIntegrity(input: {
  evidenceId: string
  expectedVersion: number
  inspection?: { sizeBytes: number; sha256: string }
}): EvidenceAsset {
  const state = loadState()
  const current = state.evidenceAssets.find(item => item.id === input.evidenceId)
  if (!current) throw new Error("证据不存在")
  assertProjectWritable(state, current.projectId)
  assertLocalEvidenceManagement(state, current.projectId)
  if (current.version !== input.expectedVersion) throw new Error("证据已更新，请刷新后重试")
  if (current.storageRef?.kind !== "local_file") throw new Error("当前证据不是可在本机复核的原件")
  let status: EvidenceAsset["status"] = "ready"
  let failureCode: EvidenceAsset["failureCode"]
  if (!input.inspection) {
    status = "missing"
    failureCode = "missing_original"
  } else {
    const sha256 = normalizeSha256(input.inspection.sha256)
    if (input.inspection.sizeBytes !== current.actualSizeBytes) {
      status = "failed"
      failureCode = "size_mismatch"
    } else if (sha256 !== current.actualSha256) {
      status = "failed"
      failureCode = "checksum_mismatch"
    }
  }
  const next: EvidenceAsset = { ...current, status, failureCode, updatedAt: now(), version: current.version + 1 }
  saveState({ ...state, evidenceAssets: state.evidenceAssets.map(item => item.id === current.id ? next : item) })
  return next
}

export function setProjectTargetBudget(projectId: string, targetBudgetFen: number): void {
  if (!Number.isInteger(targetBudgetFen) || targetBudgetFen < 0) throw new Error("目标预算格式不正确")
  const state = loadState()
  assertProjectWritable(state, projectId)
  saveState({
    ...state,
    projects: state.projects.map(item => item.id === projectId
      ? { ...item, targetBudgetFen, updatedAt: now() }
      : item)
  })
}

export function archiveProject(projectId: string, reason: string): Project {
  const state = loadState()
  const project = requireProject(state, projectId)
  if (project.status !== "active") throw new Error("只有进行中的项目可以归档")
  const timestamp = now()
  const event = lifecycleEvent(projectId, "archived", reason, timestamp)
  const next: Project = {
    ...project,
    status: "archived",
    archivedAt: timestamp,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    projects: state.projects.map(item => item.id === projectId ? next : item),
    projectLifecycleEvents: [event, ...state.projectLifecycleEvents]
  })
  return next
}

export function reopenProject(projectId: string, reason: string): Project {
  const state = loadState()
  const project = requireProject(state, projectId)
  if (project.status !== "archived") throw new Error("只有已归档项目可以重新开启")
  const timestamp = now()
  const event = lifecycleEvent(projectId, "reopened", reason, timestamp)
  const next: Project = {
    ...project,
    status: "active",
    archivedAt: undefined,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    projects: state.projects.map(item => item.id === projectId ? next : item),
    projectLifecycleEvents: [event, ...state.projectLifecycleEvents]
  })
  return next
}

export function trashProject(projectId: string, reason: string): Project {
  const state = loadState()
  const project = requireProject(state, projectId)
  if (project.status === "trashed") throw new Error("项目已在回收站中")
  const timestamp = now()
  const purgeAfter = new Date(
    new Date(timestamp).getTime() + PROJECT_RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()
  const event = lifecycleEvent(projectId, "trashed", reason, timestamp)
  const next: Project = {
    ...project,
    status: "trashed",
    trashedAt: timestamp,
    purgeAfter,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    currentProjectId: state.currentProjectId === projectId
      ? nextSelectableProjectId(state.projects, projectId)
      : state.currentProjectId,
    projects: state.projects.map(item => item.id === projectId ? next : item),
    projectLifecycleEvents: [event, ...state.projectLifecycleEvents],
    members: state.members.map(item =>
      item.projectId === projectId && item.status === "active"
        ? { ...item, status: "revoked", revokedAt: timestamp }
        : item),
    shares: state.shares.map(item =>
      item.projectId === projectId && item.status === "active"
        ? { ...item, status: "revoked", revokedAt: timestamp }
        : item),
    cameras: state.cameras.map(item =>
      item.projectId === projectId && item.status !== "revoked"
        ? { ...item, status: "revoked", revokedAt: timestamp }
        : item),
    consultations: state.consultations.map(item =>
      item.projectId === projectId && item.status !== "closed"
        ? {
          ...item,
          status: "closed",
          version: item.version + 1,
          closeReason: "项目移入回收站，旧外发咨询已关闭",
          closedAt: timestamp,
          updatedAt: timestamp
        }
        : item)
  })
  return next
}

export function restoreTrashedProject(projectId: string, reason: string): Project {
  const state = loadState()
  const project = requireProject(state, projectId)
  if (project.status !== "trashed") throw new Error("只有回收站项目可以恢复")
  const timestamp = now()
  if (project.purgeAfter && new Date(project.purgeAfter).getTime() <= new Date(timestamp).getTime()) {
    throw new Error("项目已超过回收站保留期，不能恢复")
  }
  const event = lifecycleEvent(projectId, "restored", reason, timestamp)
  const next: Project = {
    ...project,
    status: "archived",
    archivedAt: timestamp,
    trashedAt: undefined,
    purgeAfter: undefined,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    currentProjectId: state.currentProjectId || projectId,
    projects: state.projects.map(item => item.id === projectId ? next : item),
    projectLifecycleEvents: [event, ...state.projectLifecycleEvents]
  })
  return next
}

export function purgeExpiredProjects(referenceTime = now()): number {
  const state = loadState()
  const cutoff = new Date(referenceTime).getTime()
  if (!Number.isFinite(cutoff)) throw new Error("清理时间格式不正确")
  const projectIds = new Set(state.projects
    .filter(item => item.status === "trashed"
      && item.purgeAfter
      && new Date(item.purgeAfter).getTime() <= cutoff)
    .map(item => item.id))
  if (!projectIds.size) return 0
  const materialIds = new Set(state.materials
    .filter(item => projectIds.has(item.projectId))
    .map(item => item.id))
  const projects = state.projects.filter(item => !projectIds.has(item.id))
  saveState({
    ...state,
    currentProjectId: projectIds.has(state.currentProjectId)
      ? nextSelectableProjectId(projects, "")
      : state.currentProjectId,
    projects,
    projectLifecycleEvents: state.projectLifecycleEvents.filter(item => !projectIds.has(item.projectId)),
    spaces: state.spaces.filter(item => !projectIds.has(item.projectId)),
    spaceRelations: state.spaceRelations.filter(item => !projectIds.has(item.projectId)),
    spaceStageStates: state.spaceStageStates.filter(item => !projectIds.has(item.projectId)),
    legacyRoomMappings: state.legacyRoomMappings.filter(item => !projectIds.has(item.projectId)),
    evidenceAssets: state.evidenceAssets.filter(item => !projectIds.has(item.projectId)),
    evidenceLinks: state.evidenceLinks.filter(item => !projectIds.has(item.projectId)),
    records: state.records.filter(item => !projectIds.has(item.projectId)),
    recordRevisions: state.recordRevisions.filter(item => !projectIds.has(item.projectId)),
    issues: state.issues.filter(item => !projectIds.has(item.projectId)),
    issueWorkflows: state.issueWorkflows.filter(item => !projectIds.has(item.projectId)),
    materials: state.materials.filter(item => !projectIds.has(item.projectId)),
    inventory: state.inventory.filter(item => !projectIds.has(item.projectId)),
    expenses: state.expenses.filter(item => !projectIds.has(item.projectId)),
    agreements: state.agreements.filter(item => !projectIds.has(item.agreement.projectId)),
    purchaseLines: state.purchaseLines.filter(item => !projectIds.has(item.projectId)),
    receiptBatches: state.receiptBatches.filter(item => !projectIds.has(item.projectId)),
    unitConversions: state.unitConversions.filter(item => !materialIds.has(item.materialId)),
    materialInventoryEvents: state.materialInventoryEvents.filter(item => !projectIds.has(item.projectId)),
    materialUsageRecords: state.materialUsageRecords.filter(item => !projectIds.has(item.projectId)),
    costItems: state.costItems.filter(item => !projectIds.has(item.projectId)),
    costApprovals: state.costApprovals.filter(item => !projectIds.has(item.projectId)),
    paymentFacts: state.paymentFacts.filter(item => !projectIds.has(item.projectId)),
    refundFacts: state.refundFacts.filter(item => !projectIds.has(item.projectId)),
    members: state.members.filter(item => !projectIds.has(item.projectId)),
    shares: state.shares.filter(item => !projectIds.has(item.projectId)),
    consultations: state.consultations.filter(item => !projectIds.has(item.projectId)),
    consultationResponses: state.consultationResponses.filter(item => !projectIds.has(item.projectId)),
    cameras: state.cameras.filter(item => !projectIds.has(item.projectId)),
    analyses: state.analyses.filter(item => !projectIds.has(item.projectId)),
    materialChecks: state.materialChecks.filter(item => !projectIds.has(item.projectId)),
    recordReviewApplications: state.recordReviewApplications.filter(item => !projectIds.has(item.projectId)),
    imageObservationApplications: state.imageObservationApplications.filter(item => !projectIds.has(item.projectId)),
    rectificationApplications: state.rectificationApplications.filter(item => !projectIds.has(item.projectId)),
    consultationApplications: state.consultationApplications.filter(item => !projectIds.has(item.projectId)),
    budgetEstimateApplications: state.budgetEstimateApplications.filter(item => !projectIds.has(item.projectId)),
    projectSummaryApplications: state.projectSummaryApplications.filter(item => !projectIds.has(item.projectId))
  })
  return projectIds.size
}

function recordRevision(item: RecordItem, changeReason: string, createdAt: string): RecordRevision {
  return {
    ...item,
    id: id("revision"),
    recordId: item.id,
    attachments: item.attachments.map(attachment => ({ ...attachment })),
    changeReason,
    createdAt
  }
}

export function createRecord(
  input: Omit<RecordItem, "id" | "version" | "createdAt">
): RecordItem {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const timestamp = now()
  const item: RecordItem = {
    ...input,
    id: id("record"),
    version: 1,
    attachments: input.attachments.map(attachment => ({ ...attachment })),
    createdAt: timestamp
  }
  saveState({
    ...state,
    records: [item, ...state.records],
    recordRevisions: [
      recordRevision(item, "创建记录", timestamp),
      ...state.recordRevisions
    ]
  })
  return item
}

export function updateRecord(input: {
  recordId: string
  expectedVersion: number
  title: string
  note: string
  room: string
  spaceId?: string
  stage: RecordItem["stage"]
  occurredAt: string
  attachments: RecordItem["attachments"]
  changeReason: string
}): RecordItem {
  const state = loadState()
  const current = state.records.find(item => item.id === input.recordId)
  if (!current) throw new Error("记录不存在")
  assertProjectWritable(state, current.projectId)
  if (current.version !== input.expectedVersion) throw new Error("记录已更新，请重新打开后再补充")
  if (!input.title.trim()) throw new Error("记录标题不能为空")
  if (!input.changeReason.trim()) throw new Error("补充记录必须说明修改原因")
  const timestamp = now()
  const next: RecordItem = {
    ...current,
    version: current.version + 1,
    title: input.title.trim(),
    note: input.note.trim(),
    room: input.room,
    spaceId: input.spaceId,
    stage: input.stage,
    occurredAt: input.occurredAt,
    attachments: input.attachments.map(attachment => ({ ...attachment }))
  }
  saveState({
    ...state,
    records: state.records.map(item => item.id === next.id ? next : item),
    recordRevisions: [
      recordRevision(next, input.changeReason.trim(), timestamp),
      ...state.recordRevisions
    ]
  })
  return next
}

export function createIssue(input: Omit<Issue, "id" | "createdAt" | "updatedAt" | "proposals">): Issue {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const timestamp = now()
  const item: Issue = { ...input, id: id("issue"), proposals: [], createdAt: timestamp, updatedAt: timestamp }
  const workflow = buildIssueWorkflow({
    id: item.id,
    projectId: item.projectId,
    title: item.title,
    description: item.description,
    createdBy: "family-local",
    now: timestamp
  })
  saveState({
    ...state,
    issues: [item, ...state.issues],
    issueWorkflows: [workflow, ...state.issueWorkflows]
  })
  return item
}

export function updateIssue(issue: Issue): void {
  const state = loadState()
  assertProjectWritable(state, issue.projectId)
  saveState({ ...state, issues: state.issues.map(item => item.id === issue.id ? issue : item) })
}

function updateIssueWorkflow(next: IssueWorkflow): IssueWorkflow {
  const state = loadState()
  assertProjectWritable(state, next.projectId)
  if (!state.issueWorkflows.some(item => item.id === next.id)) {
    throw new Error("事项不存在")
  }
  saveState({
    ...state,
    issueWorkflows: state.issueWorkflows.map(item => item.id === next.id ? next : item),
    issues: state.issues.map(item => item.id === next.id
      ? { ...item, status: next.status, updatedAt: next.updatedAt }
      : item)
  })
  return next
}

export function addLocalIssueProposal(issueId: string, content: string): IssueWorkflow {
  const issue = loadState().issueWorkflows.find(item => item.id === issueId)
  if (!issue) throw new Error("事项不存在")
  return updateIssueWorkflow(addIssueProposal(issue, {
    id: id("proposal"),
    content,
    expectedVersion: issue.version,
    submittedBy: "family-local",
    now: now()
  }))
}

export function selectLocalIssueProposal(
  issueId: string,
  proposalId: string,
  reason?: string
): IssueWorkflow {
  const issue = loadState().issueWorkflows.find(item => item.id === issueId)
  if (!issue) throw new Error("事项不存在")
  return updateIssueWorkflow(selectIssueProposal(issue, {
    proposalId,
    expectedVersion: issue.version,
    reason,
    actorId: "owner-local",
    now: now()
  }))
}

export function submitLocalIssueTreatment(input: {
  issueId: string
  note: string
  evidenceSourceIds?: string[]
}): IssueWorkflow {
  const issue = loadState().issueWorkflows.find(item => item.id === input.issueId)
  if (!issue) throw new Error("事项不存在")
  return updateIssueWorkflow(submitIssueTreatment(issue, {
    id: id("treatment"),
    expectedVersion: issue.version,
    note: input.note,
    evidenceSourceIds: input.evidenceSourceIds,
    submittedBy: "family-local",
    now: now()
  }))
}

export function reviewLocalIssueTreatment(input: {
  issueId: string
  decision: "returned" | "closed"
  note: string
  method: "evidence" | "on_site" | "reported"
  closeReason?: IssueCloseReason
  duplicateOfIssueId?: string
}): IssueWorkflow {
  const state = loadState()
  const issue = state.issueWorkflows.find(item => item.id === input.issueId)
  if (!issue) throw new Error("事项不存在")
  const treatment = issue.treatments.at(-1)
  if (!treatment) throw new Error("没有可复查的处理结果")
  if (input.duplicateOfIssueId
    && !state.issueWorkflows.some(item =>
      item.id === input.duplicateOfIssueId && item.projectId === issue.projectId)) {
    throw new Error("关联的主事项不存在")
  }
  return updateIssueWorkflow(reviewIssueTreatment(issue, {
    id: id("review"),
    treatmentId: treatment.id,
    expectedVersion: issue.version,
    decision: input.decision,
    note: input.note,
    method: input.method,
    closeReason: input.closeReason,
    duplicateOfIssueId: input.duplicateOfIssueId,
    actorId: "owner-local",
    now: now()
  }))
}

export function reopenLocalIssue(issueId: string, reason: string): IssueWorkflow {
  const issue = loadState().issueWorkflows.find(item => item.id === issueId)
  if (!issue) throw new Error("事项不存在")
  return updateIssueWorkflow(reopenIssueWorkflow(issue, {
    id: id("reopening"),
    expectedVersion: issue.version,
    reason,
    actorId: "owner-local",
    now: now()
  }))
}

export function createMaterial(input: Omit<Material, "id" | "createdAt">): Material {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const item: Material = { ...input, id: id("material"), createdAt: now() }
  saveState({ ...state, materials: [item, ...state.materials] })
  return item
}

export function addInventoryEntry(
  input: Omit<InventoryEntry, "id" | "createdAt">
): InventoryEntry {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const relevantEntries = state.inventory.filter(item => item.projectId === input.projectId)
  const check = validateInventoryEntry(relevantEntries, input)
  if (!check.valid) throw new Error(check.reason)
  const item: InventoryEntry = { ...input, id: id("inventory"), createdAt: now() }
  saveState({ ...state, inventory: [item, ...state.inventory] })
  return item
}

export function materialBalance(materialId: string): number {
  return inventoryBalance(loadState().inventory, materialId)
}

function requireProjectMaterial(
  state: AppState,
  projectId: string,
  materialId: string
): Material {
  const material = state.materials.find(item =>
    item.id === materialId && item.projectId === projectId)
  if (!material) throw new Error("材料不存在或不属于当前项目")
  return material
}

export function createMaterialAgreement(input: {
  projectId: string
  materialId: string
  title: string
  terms: AgreementTerm[]
  sourceLabel?: string
}): AgreementAggregate {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  requireProjectMaterial(state, input.projectId, input.materialId)
  const timestamp = now()
  const aggregate = createAgreement({
    id: id("agreement"),
    versionId: id("agreement_version"),
    projectId: input.projectId,
    subject: "material",
    subjectId: input.materialId,
    title: input.title,
    terms: input.terms,
    sourceIds: input.sourceLabel?.trim()
      ? [`manual:${input.sourceLabel.trim()}`]
      : [],
    actorId: "owner-local",
    now: timestamp
  })
  saveState({ ...state, agreements: [aggregate, ...state.agreements] })
  return aggregate
}

export function submitMaterialAgreement(
  agreementId: string,
  versionId: string
): AgreementAggregate {
  const state = loadState()
  const current = state.agreements.find(item => item.agreement.id === agreementId)
  if (!current) throw new Error("约定不存在")
  assertProjectWritable(state, current.agreement.projectId)
  const next = submitAgreementVersion(
    current,
    versionId,
    current.agreement.version,
    now()
  )
  saveState({
    ...state,
    agreements: state.agreements.map(item =>
      item.agreement.id === agreementId ? next : item)
  })
  return next
}

export function approveMaterialAgreement(
  agreementId: string,
  versionId: string
): AgreementAggregate {
  const state = loadState()
  const current = state.agreements.find(item => item.agreement.id === agreementId)
  if (!current) throw new Error("约定不存在")
  assertProjectWritable(state, current.agreement.projectId)
  const next = approveAgreementVersion(
    current,
    versionId,
    current.agreement.version,
    "owner-local",
    now()
  )
  saveState({
    ...state,
    agreements: state.agreements.map(item =>
      item.agreement.id === agreementId ? next : item)
  })
  return next
}

export function createMaterialPurchase(input: {
  projectId: string
  materialId: string
  quantity: string
}): PurchaseLine {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const material = requireProjectMaterial(state, input.projectId, input.materialId)
  const agreement = state.agreements.find(item =>
    item.agreement.projectId === input.projectId
    && item.agreement.subjectId === input.materialId
    && item.agreement.activeVersionId)
  const line = createPurchaseLine({
    id: id("purchase"),
    projectId: input.projectId,
    materialId: input.materialId,
    agreementVersionId: agreement?.agreement.activeVersionId,
    orderedQuantityMilli: parseQuantityMilli(input.quantity),
    unit: material.unit,
    createdAt: now()
  })
  saveState({ ...state, purchaseLines: [line, ...state.purchaseLines] })
  return line
}

export function createMaterialReceipt(input: {
  projectId: string
  purchaseLineId: string
  quantity: string
  occurredAt?: string
}): ReceiptBatch {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const line = state.purchaseLines.find(item =>
    item.id === input.purchaseLineId && item.projectId === input.projectId)
  if (!line) throw new Error("采购行不存在或不属于当前项目")
  requireProjectMaterial(state, input.projectId, line.materialId)
  const timestamp = now()
  const batch = createReceiptBatch({
    id: id("receipt"),
    projectId: input.projectId,
    purchaseLineId: line.id,
    materialId: line.materialId,
    unit: line.unit,
    occurredAt: input.occurredAt || timestamp,
    quantity: {
      id: id("receipt_quantity"),
      requestId: id("request"),
      quantityMilli: parseQuantityMilli(input.quantity),
      actorId: "family-local",
      createdAt: timestamp
    }
  })
  saveState({ ...state, receiptBatches: [batch, ...state.receiptBatches] })
  return batch
}

export function allocateMaterialReceipt(input: {
  batchId: string
  kind: "accepted_available" | "marked_return" | "completed_return"
  quantity: string
}): ReceiptBatch {
  const state = loadState()
  const current = state.receiptBatches.find(item => item.id === input.batchId)
  if (!current) throw new Error("到货批次不存在")
  assertProjectWritable(state, current.projectId)
  const timestamp = now()
  const allocationId = id("receipt_allocation")
  const quantityMilli = parseQuantityMilli(input.quantity)
  const next = allocateReceipt(current, {
    id: allocationId,
    requestId: id("request"),
    expectedVersion: current.version,
    kind: input.kind,
    quantityMilli,
    actorId: input.kind === "completed_return" ? "family-local" : "owner-local",
    createdAt: timestamp
  })
  let inventoryEvents = state.materialInventoryEvents
  if (input.kind === "accepted_available") {
    const event: MaterialInventoryEvent = {
      id: id("inventory"),
      requestId: id("request"),
      projectId: current.projectId,
      materialId: current.materialId,
      unit: current.unit,
      action: "available_received",
      quantityMilli,
      sourceReceiptAllocationId: allocationId,
      actorId: "owner-local",
      createdAt: timestamp
    }
    inventoryEvents = appendInventoryEvent(
      state.materialInventoryEvents,
      state.materialUsageRecords,
      event
    )
  }
  saveState({
    ...state,
    receiptBatches: state.receiptBatches.map(item =>
      item.id === current.id ? next : item),
    materialInventoryEvents: inventoryEvents
  })
  return next
}

export function decideMaterialReceiptFromCheck(input: {
  batchId: string
  checkId: string
  kind: "accepted_available" | "marked_return"
  quantity: string
}): ReceiptBatch {
  const state = loadState()
  const current = state.receiptBatches.find(item => item.id === input.batchId)
  const check = state.materialChecks.find(item => item.id === input.checkId)
  if (!current || !check || check.projectId !== current.projectId
    || check.materialId !== current.materialId || check.receiptBatchId !== current.id) {
    throw new Error("核对记录与到货批次不一致，请重新打开后处理")
  }
  const receiptSnapshot = check.sourceSnapshots?.find(source => source.sourceId === current.id && source.kind === "receipt")
  if (!receiptSnapshot || receiptSnapshot.version !== `${current.version}`) {
    throw new Error("到货批次在核对后已变化，请基于最新状态重新核对")
  }
  return allocateMaterialReceipt({ batchId: current.id, kind: input.kind, quantity: input.quantity })
}

export function recordMaterialInventory(input: {
  projectId: string
  materialId: string
  action: Exclude<MaterialInventoryAction, "available_received">
  quantity: string
  reason?: string
  sourceEventId?: string
}): MaterialInventoryEvent {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const material = requireProjectMaterial(state, input.projectId, input.materialId)
  const event: MaterialInventoryEvent = {
    id: id("inventory"),
    requestId: id("request"),
    projectId: input.projectId,
    materialId: input.materialId,
    unit: material.unit,
    action: input.action,
    quantityMilli: parseQuantityMilli(input.quantity),
    sourceEventId: input.sourceEventId,
    reason: input.reason,
    actorId: "owner-local",
    createdAt: now()
  }
  const events = appendInventoryEvent(
    state.materialInventoryEvents,
    state.materialUsageRecords,
    event
  )
  saveState({ ...state, materialInventoryEvents: events })
  return event
}

export function createExpenseEvent(
  input: Omit<ExpenseEvent, "id" | "createdAt">
): ExpenseEvent {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const check = validateExpenseEvent(
    state.expenses.filter(item => item.projectId === input.projectId),
    input
  )
  if (!check.valid) throw new Error(check.reason)
  const item: ExpenseEvent = { ...input, id: id("expense"), createdAt: now() }
  saveState({ ...state, expenses: [item, ...state.expenses] })
  return item
}

export function createCostItem(input: {
  projectId: string
  title: string
  category: CostItem["category"]
  quotedAmountFen?: number
  note?: string
  materialId?: string
}): CostItem {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  if (!input.title.trim()) throw new Error("费用事项不能为空")
  if (input.quotedAmountFen !== undefined
    && (!Number.isSafeInteger(input.quotedAmountFen) || input.quotedAmountFen <= 0)) {
    throw new Error("报价金额必须大于 0")
  }
  if (input.materialId
    && !state.materials.some(item =>
      item.id === input.materialId && item.projectId === input.projectId)) {
    throw new Error("关联材料不存在")
  }
  const item: CostItem = {
    id: id("cost"),
    projectId: input.projectId,
    title: input.title.trim(),
    category: input.category,
    materialId: input.materialId,
    quotedAmountFen: input.quotedAmountFen,
    note: input.note?.trim() || "",
    createdAt: now()
  }
  saveState({ ...state, costItems: [item, ...state.costItems] })
  return item
}

export function addLocalCostApproval(input: {
  costItemId: string
  action: CostApprovalEvent["action"]
  amountFen: number
  reason: string
}): CostApprovalEvent {
  const state = loadState()
  const costItem = state.costItems.find(item => item.id === input.costItemId)
  if (!costItem) throw new Error("费用事项不存在")
  assertProjectWritable(state, costItem.projectId)
  const existing = state.costApprovals.filter(item => item.costItemId === costItem.id)
  if (!existing.length && input.action !== "initial") {
    throw new Error("首次批准请使用初始批准")
  }
  if (existing.length && input.action === "initial") {
    throw new Error("已有批准金额，请使用批准增加或批准减少")
  }
  if (input.action !== "initial" && !input.reason.trim()) {
    throw new Error("调整批准金额必须填写原因")
  }
  const event: CostApprovalEvent = {
    id: id("approval"),
    requestId: id("request"),
    projectId: costItem.projectId,
    costItemId: costItem.id,
    action: input.action,
    amountFen: input.amountFen,
    reason: input.reason.trim(),
    actorId: "owner-local",
    createdAt: now()
  }
  const approvals = appendApprovalEvent(state.costApprovals, event)
  saveState({ ...state, costApprovals: approvals })
  return event
}

export function submitLocalPayment(input: {
  costItemId: string
  amountFen: number
  occurredAt?: string
}): PaymentFact {
  const state = loadState()
  const costItem = state.costItems.find(item => item.id === input.costItemId)
  if (!costItem) throw new Error("费用事项不存在")
  assertProjectWritable(state, costItem.projectId)
  const timestamp = now()
  const payment = buildPaymentFact({
    id: id("payment"),
    requestId: id("request"),
    projectId: costItem.projectId,
    costItemId: costItem.id,
    amountFen: input.amountFen,
    submittedBy: "family-local",
    occurredAt: input.occurredAt || timestamp,
    createdAt: timestamp
  })
  saveState({ ...state, paymentFacts: [payment, ...state.paymentFacts] })
  return payment
}

export function decideLocalPayment(
  paymentId: string,
  decision: "confirmed" | "rejected"
): PaymentFact {
  const state = loadState()
  const payment = state.paymentFacts.find(item => item.id === paymentId)
  if (!payment) throw new Error("付款记录不存在")
  assertProjectWritable(state, payment.projectId)
  const next = decidePaymentFact(payment, {
    decision,
    expectedVersion: payment.version,
    actorId: "owner-local",
    now: now()
  })
  saveState({
    ...state,
    paymentFacts: state.paymentFacts.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function submitLocalRefund(input: {
  paymentId: string
  amountFen: number
  occurredAt?: string
}): RefundFact {
  const state = loadState()
  const payment = state.paymentFacts.find(item => item.id === input.paymentId)
  if (!payment) throw new Error("原付款记录不存在")
  assertProjectWritable(state, payment.projectId)
  const timestamp = now()
  const refund = buildRefundFact(payment, state.refundFacts, {
    id: id("refund"),
    requestId: id("request"),
    projectId: payment.projectId,
    costItemId: payment.costItemId,
    paymentId: payment.id,
    amountFen: input.amountFen,
    submittedBy: "family-local",
    occurredAt: input.occurredAt || timestamp,
    createdAt: timestamp
  })
  saveState({ ...state, refundFacts: [refund, ...state.refundFacts] })
  return refund
}

export function decideLocalRefund(
  refundId: string,
  decision: "confirmed" | "rejected"
): RefundFact {
  const state = loadState()
  const refund = state.refundFacts.find(item => item.id === refundId)
  if (!refund) throw new Error("退款记录不存在")
  assertProjectWritable(state, refund.projectId)
  const next = decideRefundFact(refund, {
    decision,
    expectedVersion: refund.version,
    actorId: "owner-local",
    now: now()
  })
  saveState({
    ...state,
    refundFacts: state.refundFacts.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function addProjectMember(input: {
  projectId: string
  name: string
  role: "family" | "collaborator"
  scopes: MemberScope[]
}): ProjectMember {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const item: ProjectMember = {
    ...input,
    id: id("member"),
    status: "active",
    createdAt: now()
  }
  saveState({ ...state, members: [item, ...state.members] })
  return item
}

export function revokeProjectMember(memberId: string): void {
  const state = loadState()
  const member = state.members.find(item => item.id === memberId)
  if (!member) throw new Error("成员不存在")
  assertProjectWritable(state, member.projectId)
  const revokedAt = now()
  saveState({
    ...state,
    members: state.members.map(item => item.id === memberId
      ? { ...item, status: "revoked", revokedAt }
      : item)
  })
}

export function createShareSnapshot(input: {
  projectId: string
  title: string
  recordIds: string[]
  issueIds: string[]
  allowDownload: boolean
  validDays?: number
}): ShareSnapshot {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const recordIds = [...new Set(input.recordIds)]
  const issueIds = [...new Set(input.issueIds)]
  if (!recordIds.length && !issueIds.length) throw new Error("请至少选择一条记录或待办")
  if (!input.title.trim()) throw new Error("请填写分享标题")
  const validDays = input.validDays || 7
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 30) {
    throw new Error("分享有效期应为 1 至 30 天")
  }
  const records = state.records.filter(item => item.projectId === input.projectId && recordIds.includes(item.id))
  const issues = state.issues.filter(item => item.projectId === input.projectId && issueIds.includes(item.id))
  if (records.length !== recordIds.length || issues.length !== issueIds.length) {
    throw new Error("分享范围包含不存在或不属于当前项目的资料")
  }
  const createdAt = now()
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString()
  const item: ShareSnapshot = {
    id: id("share"),
    projectId: input.projectId,
    title: input.title.trim(),
    status: "active",
    expiresAt,
    allowDownload: input.allowDownload,
    recordCopies: records.map(item => ({ ...item, attachments: item.attachments.map(attachment => ({ ...attachment })) })),
    issueCopies: issues.map(item => ({ ...item, proposals: item.proposals.map(proposal => ({ ...proposal })) })),
    createdAt
  }
  saveState({ ...state, shares: [item, ...state.shares] })
  return item
}

export function revokeShareSnapshot(shareId: string): void {
  const state = loadState()
  const share = state.shares.find(item => item.id === shareId)
  if (!share) throw new Error("分享快照不存在")
  assertProjectWritable(state, share.projectId)
  const revokedAt = now()
  saveState({
    ...state,
    shares: state.shares.map(item => item.id === shareId
      ? { ...item, status: "revoked", revokedAt }
      : item)
  })
}

export function sharePackage(shareId: string): string {
  const state = loadState()
  const share = state.shares.find(item => item.id === shareId)
  if (!share) throw new Error("分享快照不存在")
  assertProjectReadable(state, share.projectId)
  if (share.status !== "active") throw new Error("分享已撤销或过期")
  if (new Date(share.expiresAt).getTime() <= Date.now()) throw new Error("分享已过期")
  return JSON.stringify({
    schema: "renovation-sync-share-v1",
    title: share.title,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    allowDownload: share.allowDownload,
    originalFilesIncluded: false,
    originalFilePolicy: share.allowDownload
      ? "负责人允许另行发送原件；本摘要本身不携带原件，请使用可移植资料功能发送。"
      : "本摘要不提供原件。",
    records: share.recordCopies.map(record => ({
      ...record,
      attachments: record.attachments.map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type
      }))
    })),
    issues: share.issueCopies
  }, null, 2)
}

function normalizedLines(lines: string[]): string[] {
  return [...new Set(lines.map(item => item.trim()).filter(Boolean))]
}

function validateConsultationResources(
  state: AppState,
  projectId: string,
  recordIds: string[],
  issueIds: string[]
): void {
  const uniqueRecordIds = new Set(recordIds)
  const uniqueIssueIds = new Set(issueIds)
  if (!uniqueRecordIds.size && !uniqueIssueIds.size) {
    throw new Error("咨询至少需要选择一条记录或问题")
  }
  if ([...uniqueRecordIds].some(recordId =>
    !state.records.some(item => item.id === recordId && item.projectId === projectId))) {
    throw new Error("咨询包含不存在或不属于当前项目的记录")
  }
  if ([...uniqueIssueIds].some(issueId =>
    !state.issues.some(item => item.id === issueId && item.projectId === projectId))) {
    throw new Error("咨询包含不存在或不属于当前项目的问题")
  }
}

function buildConsultationVersion(input: {
  consultationId: string
  revision: number
  question: string
  knownFacts: string[]
  gaps: string[]
  answerQuestions: string[]
  recordIds: string[]
  issueIds: string[]
  createdAt: string
}): ConsultationVersion {
  if (!input.question.trim()) throw new Error("请填写本次咨询的核心问题")
  const answerQuestions = normalizedLines(input.answerQuestions)
  if (!answerQuestions.length) throw new Error("请至少填写一个希望对方回答的问题")
  return {
    id: id("consultation_version"),
    consultationId: input.consultationId,
    revision: input.revision,
    status: "draft",
    question: input.question.trim(),
    knownFacts: normalizedLines(input.knownFacts),
    gaps: normalizedLines(input.gaps),
    answerQuestions,
    recordIds: [...new Set(input.recordIds)],
    issueIds: [...new Set(input.issueIds)],
    recordCopies: [],
    issueCopies: [],
    createdAt: input.createdAt
  }
}

export function createConsultation(input: {
  projectId: string
  title: string
  question: string
  knownFacts: string[]
  gaps: string[]
  answerQuestions: string[]
  recordIds: string[]
  issueIds: string[]
}): Consultation {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  if (!input.title.trim()) throw new Error("请填写咨询标题")
  validateConsultationResources(state, input.projectId, input.recordIds, input.issueIds)
  const timestamp = now()
  const consultationId = id("consultation")
  const version = buildConsultationVersion({
    ...input,
    consultationId,
    revision: 1,
    createdAt: timestamp
  })
  const consultation: Consultation = {
    id: consultationId,
    projectId: input.projectId,
    title: input.title.trim(),
    status: "draft",
    version: 1,
    draftVersionId: version.id,
    versions: [version],
    createdAt: timestamp,
    updatedAt: timestamp
  }
  saveState({ ...state, consultations: [consultation, ...state.consultations] })
  return consultation
}

export function reviseConsultation(input: {
  consultationId: string
  expectedVersion: number
  title: string
  question: string
  knownFacts: string[]
  gaps: string[]
  answerQuestions: string[]
  recordIds: string[]
  issueIds: string[]
}): Consultation {
  const state = loadState()
  const current = state.consultations.find(item => item.id === input.consultationId)
  if (!current) throw new Error("咨询不存在")
  assertProjectWritable(state, current.projectId)
  if (current.status === "closed") throw new Error("已结束的咨询不能再修改")
  if (current.version !== input.expectedVersion) throw new Error("咨询已更新，请重新打开")
  if (!input.title.trim()) throw new Error("请填写咨询标题")
  validateConsultationResources(state, current.projectId, input.recordIds, input.issueIds)
  const timestamp = now()
  const version = buildConsultationVersion({
    ...input,
    consultationId: current.id,
    revision: Math.max(...current.versions.map(item => item.revision), 0) + 1,
    createdAt: timestamp
  })
  const next: Consultation = {
    ...current,
    title: input.title.trim(),
    status: "draft",
    version: current.version + 1,
    draftVersionId: version.id,
    versions: [
      ...current.versions.map(item =>
        item.status === "draft" ? { ...item, status: "superseded" as const } : item),
      version
    ],
    updatedAt: timestamp
  }
  saveState({
    ...state,
    consultations: state.consultations.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function publishConsultation(
  consultationId: string,
  expectedVersion: number,
  validDays = 7
): Consultation {
  const state = loadState()
  const current = state.consultations.find(item => item.id === consultationId)
  if (!current) throw new Error("咨询不存在")
  assertProjectWritable(state, current.projectId)
  if (current.status === "closed") throw new Error("已结束的咨询不能发布")
  if (current.version !== expectedVersion) throw new Error("咨询已更新，请重新打开")
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 30) {
    throw new Error("咨询资料有效期应为 1 至 30 天")
  }
  const draft = current.versions.find(item => item.id === current.draftVersionId)
  if (!draft || draft.status !== "draft") throw new Error("没有可发布的咨询草稿")
  validateConsultationResources(state, current.projectId, draft.recordIds, draft.issueIds)
  const timestamp = now()
  const expiresAt = new Date(
    new Date(timestamp).getTime() + validDays * 24 * 60 * 60 * 1000
  ).toISOString()
  const versions = current.versions.map(version => {
    if (version.id === draft.id) {
      return {
        ...version,
        status: "published" as const,
        recordCopies: state.records
          .filter(item => draft.recordIds.includes(item.id) && item.projectId === current.projectId)
          .map(item => ({
            ...item,
            attachments: item.attachments.map(attachment => ({ ...attachment }))
          })),
        issueCopies: state.issues
          .filter(item => draft.issueIds.includes(item.id) && item.projectId === current.projectId)
          .map(item => ({
            ...item,
            proposals: item.proposals.map(proposal => ({ ...proposal }))
          })),
        publishedAt: timestamp,
        expiresAt
      }
    }
    if (version.id === current.activeVersionId && version.status === "published") {
      return { ...version, status: "superseded" as const }
    }
    return version
  })
  const next: Consultation = {
    ...current,
    status: "published",
    version: current.version + 1,
    activeVersionId: draft.id,
    draftVersionId: undefined,
    versions,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    consultations: state.consultations.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function consultationPackage(consultationId: string): string {
  const state = loadState()
  const consultation = state.consultations.find(item => item.id === consultationId)
  if (!consultation) throw new Error("咨询不存在")
  assertProjectReadable(state, consultation.projectId)
  if (consultation.status === "closed") throw new Error("咨询已结束")
  const version = consultation.versions.find(item => item.id === consultation.activeVersionId)
  if (!version || version.status !== "published") throw new Error("咨询草稿尚未发布")
  if (!version.expiresAt || new Date(version.expiresAt).getTime() <= Date.now()) {
    throw new Error("咨询资料已过期，请修订后重新发布")
  }
  return JSON.stringify({
    schema: "renovation-sync-consultation-v1",
    title: consultation.title,
    revision: version.revision,
    question: version.question,
    knownFacts: version.knownFacts,
    gaps: version.gaps,
    answerQuestions: version.answerQuestions,
    publishedAt: version.publishedAt,
    expiresAt: version.expiresAt,
    replyPolicy: "只读资料包不接收匿名回复，请通过原沟通渠道回复，由项目成员注明转述后回填。",
    records: version.recordCopies.map(record => ({
      ...record,
      attachments: record.attachments.map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type
      }))
    })),
    issues: version.issueCopies
  }, null, 2)
}

export function addConsultationResponse(input: {
  consultationId: string
  source: ConsultationResponse["source"]
  respondentName?: string
  channel?: string
  receivedAt: string
  originalText: string
  summary?: string
  recordedBy?: string
  memberId?: string
  targetIssueId?: string
}): ConsultationResponse {
  const state = loadState()
  const consultation = state.consultations.find(item => item.id === input.consultationId)
  if (!consultation) throw new Error("咨询不存在")
  assertProjectWritable(state, consultation.projectId)
  if (consultation.status === "closed" || !consultation.activeVersionId) {
    throw new Error("只有存在有效发布版本的咨询可以回填回复")
  }
  const version = consultation.versions.find(item => item.id === consultation.activeVersionId)
  if (!version) throw new Error("咨询发布版本不存在")
  if (!input.originalText.trim()) throw new Error("请填写对方原话")
  const receivedAt = new Date(input.receivedAt)
  if (!Number.isFinite(receivedAt.getTime())) throw new Error("收到时间格式不正确")
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new Error("收到时间不能晚于当前时间")
  if (input.targetIssueId && !version.issueIds.includes(input.targetIssueId)) {
    throw new Error("回复只能关联本次咨询范围内的问题")
  }
  let respondentName = input.respondentName?.trim() || ""
  let channel = input.channel?.trim() || ""
  let recordedBy = input.recordedBy?.trim() || ""
  let memberId: string | undefined
  if (input.source === "member_direct_local") {
    const member = state.members.find(item =>
      item.id === input.memberId
      && item.projectId === consultation.projectId
      && item.status === "active"
      && item.scopes.includes("issues"))
    if (!member) throw new Error("请选择仍有问题权限的项目成员")
    respondentName = member.name
    channel = "装修同步成员本人填写（本机演示身份）"
    recordedBy = member.name
    memberId = member.id
  } else {
    if (!respondentName || !channel || !recordedBy) {
      throw new Error("转述回复必须填写声明作者、沟通渠道和回填人")
    }
  }
  const response: ConsultationResponse = {
    id: id("consultation_response"),
    consultationId: consultation.id,
    consultationVersionId: version.id,
    projectId: consultation.projectId,
    source: input.source,
    respondentName,
    channel,
    receivedAt: receivedAt.toISOString(),
    originalText: input.originalText.trim(),
    summary: input.summary?.trim() || "",
    recordedBy,
    memberId,
    targetIssueId: input.targetIssueId,
    status: "pending",
    createdAt: now()
  }
  saveState({
    ...state,
    consultationResponses: [response, ...state.consultationResponses]
  })
  return response
}

export function convertConsultationResponseToProposal(responseId: string): ConsultationResponse {
  const state = loadState()
  const response = state.consultationResponses.find(item => item.id === responseId)
  if (!response) throw new Error("咨询回复不存在")
  assertProjectWritable(state, response.projectId)
  if (response.status !== "pending") throw new Error("该回复已经处理")
  if (!response.targetIssueId) throw new Error("请先把回复关联到本次咨询中的问题")
  const issue = state.issueWorkflows.find(item =>
    item.id === response.targetIssueId && item.projectId === response.projectId)
  if (!issue) throw new Error("关联问题不存在")
  const timestamp = now()
  const proposalId = id("proposal")
  const submittedBy = response.source === "manual_relay"
    ? `${response.respondentName}（${response.channel}转述，由${response.recordedBy}回填）`
    : `${response.respondentName}（项目成员本人填写）`
  const nextIssue = addIssueProposal(issue, {
    id: proposalId,
    content: response.summary || response.originalText,
    expectedVersion: issue.version,
    submittedBy,
    now: timestamp
  })
  const nextResponse: ConsultationResponse = {
    ...response,
    status: "converted_to_proposal",
    proposalId,
    decisionReason: "负责人将该意见纳入待选处理预案",
    decidedAt: timestamp
  }
  saveState({
    ...state,
    issueWorkflows: state.issueWorkflows.map(item => item.id === nextIssue.id ? nextIssue : item),
    consultationResponses: state.consultationResponses.map(item =>
      item.id === nextResponse.id ? nextResponse : item)
  })
  return nextResponse
}

export function dismissConsultationResponse(
  responseId: string,
  reason: string
): ConsultationResponse {
  const state = loadState()
  const response = state.consultationResponses.find(item => item.id === responseId)
  if (!response) throw new Error("咨询回复不存在")
  assertProjectWritable(state, response.projectId)
  if (response.status !== "pending") throw new Error("该回复已经处理")
  if (!reason.trim()) throw new Error("不采纳时必须填写原因")
  const next: ConsultationResponse = {
    ...response,
    status: "dismissed",
    decisionReason: reason.trim(),
    decidedAt: now()
  }
  saveState({
    ...state,
    consultationResponses: state.consultationResponses.map(item =>
      item.id === next.id ? next : item)
  })
  return next
}

export function closeConsultation(
  consultationId: string,
  expectedVersion: number,
  reason: string
): Consultation {
  const state = loadState()
  const current = state.consultations.find(item => item.id === consultationId)
  if (!current) throw new Error("咨询不存在")
  assertProjectWritable(state, current.projectId)
  if (current.status === "closed") throw new Error("咨询已经结束")
  if (current.version !== expectedVersion) throw new Error("咨询已更新，请重新打开")
  if (!reason.trim()) throw new Error("结束咨询必须填写原因")
  const timestamp = now()
  const next: Consultation = {
    ...current,
    status: "closed",
    version: current.version + 1,
    closeReason: reason.trim(),
    closedAt: timestamp,
    updatedAt: timestamp
  }
  saveState({
    ...state,
    consultations: state.consultations.map(item => item.id === next.id ? next : item)
  })
  return next
}

export function exportProjectBundle(projectId: string): string {
  const state = loadState()
  const project = assertProjectReadable(state, projectId)
  const materialIds = new Set(state.materials
    .filter(item => item.projectId === projectId)
    .map(item => item.id))
  return JSON.stringify({
    schema: "renovation-sync-backup-v2",
    exportedAt: now(),
    project,
    projectLifecycleEvents: state.projectLifecycleEvents.filter(item => item.projectId === projectId),
    spaces: state.spaces.filter(item => item.projectId === projectId),
    spaceRelations: state.spaceRelations.filter(item => item.projectId === projectId),
    spaceStageStates: state.spaceStageStates.filter(item => item.projectId === projectId),
    legacyRoomMappings: state.legacyRoomMappings.filter(item => item.projectId === projectId),
    evidenceAssets: state.evidenceAssets.filter(item => item.projectId === projectId),
    evidenceLinks: state.evidenceLinks.filter(item => item.projectId === projectId),
    records: state.records.filter(item => item.projectId === projectId),
    recordRevisions: state.recordRevisions.filter(item => item.projectId === projectId),
    issues: state.issues.filter(item => item.projectId === projectId),
    issueWorkflows: state.issueWorkflows.filter(item => item.projectId === projectId),
    materials: state.materials.filter(item => item.projectId === projectId),
    inventory: state.inventory.filter(item => item.projectId === projectId),
    expenses: state.expenses.filter(item => item.projectId === projectId),
    agreements: state.agreements.filter(item => item.agreement.projectId === projectId),
    purchaseLines: state.purchaseLines.filter(item => item.projectId === projectId),
    receiptBatches: state.receiptBatches.filter(item => item.projectId === projectId),
    unitConversions: state.unitConversions.filter(item => materialIds.has(item.materialId)),
    materialInventoryEvents: state.materialInventoryEvents.filter(item => item.projectId === projectId),
    materialUsageRecords: state.materialUsageRecords.filter(item => item.projectId === projectId),
    costItems: state.costItems.filter(item => item.projectId === projectId),
    costApprovals: state.costApprovals.filter(item => item.projectId === projectId),
    paymentFacts: state.paymentFacts.filter(item => item.projectId === projectId),
    refundFacts: state.refundFacts.filter(item => item.projectId === projectId),
    members: state.members.filter(item => item.projectId === projectId),
    shares: state.shares.filter(item => item.projectId === projectId),
    consultations: state.consultations.filter(item => item.projectId === projectId),
    consultationResponses: state.consultationResponses.filter(item => item.projectId === projectId),
    cameras: state.cameras.filter(item => item.projectId === projectId),
    analyses: state.analyses.filter(item => item.projectId === projectId),
    materialChecks: state.materialChecks.filter(item => item.projectId === projectId),
    recordReviewApplications: state.recordReviewApplications.filter(item => item.projectId === projectId),
    imageObservationApplications: state.imageObservationApplications.filter(item => item.projectId === projectId),
    rectificationApplications: state.rectificationApplications.filter(item => item.projectId === projectId),
    consultationApplications: state.consultationApplications.filter(item => item.projectId === projectId),
    budgetEstimateApplications: state.budgetEstimateApplications.filter(item => item.projectId === projectId),
    projectSummaryApplications: state.projectSummaryApplications.filter(item => item.projectId === projectId)
  }, null, 2)
}

export function restoreProjectBundle(raw: string, options: {
  sourcePackageId?: string
  sourcePackageFingerprint?: string
  restoreOperationId?: string
} = {}): Project {
  const parsed = JSON.parse(raw) as Partial<AppState> & { schema?: string; project?: Project }
  if (!["renovation-sync-backup-v1", "renovation-sync-backup-v2"].includes(parsed.schema || "")
    || !parsed.project?.name) {
    throw new Error("备份格式不正确")
  }
  const state = loadState()
  if (options.sourcePackageId) {
    if (!options.sourcePackageFingerprint) throw new Error("可移植恢复缺少内容指纹")
    const conflictingSource = state.projects.find(item =>
      item.restoredFromPackageId === options.sourcePackageId
      && item.restoredFromPackageFingerprint !== options.sourcePackageFingerprint)
    if (conflictingSource) throw new Error("资料包标识已被另一份内容使用，不能重复恢复")
    const operationId = options.restoreOperationId || options.sourcePackageId
    const existing = state.projects.find(item =>
      item.restoreOperationId === operationId
      || (!item.restoreOperationId && item.restoredFromPackageId === operationId))
    if (existing) {
      if (existing.status === "trashed") throw new Error("该资料包已恢复过，副本目前在回收站中")
      return existing
    }
  }
  const restoredAt = now()
  const sourceProjectId = parsed.project.id
  const newProjectId = id("project")
  const spaceIdMap = new Map((parsed.spaces || []).map(item => [item.id, id("space")]))
  const evidenceIdMap = new Map((parsed.evidenceAssets || []).map(item => [item.id, id("evidence")]))
  const recordIdMap = new Map((parsed.records || []).map(item => [item.id, id("record")]))
  const recordRevisionIdMap = new Map((parsed.recordRevisions || []).map(item => [item.id, id("revision")]))
  const materialIdMap = new Map((parsed.materials || []).map(item => [item.id, id("material")]))
  const issueSourceIds = new Set([
    ...(parsed.issues || []).map(item => item.id),
    ...(parsed.issueWorkflows || []).map(item => item.id)
  ])
  const issueIdMap = new Map([...issueSourceIds].map(itemId => [itemId, id("issue")]))
  const agreementIdMap = new Map((parsed.agreements || [])
    .map(item => [item.agreement.id, id("agreement")]))
  const agreementVersionIdMap = new Map((parsed.agreements || [])
    .flatMap(item => item.versions)
    .map(item => [item.id, id("agreement_version")]))
  const purchaseLineIdMap = new Map((parsed.purchaseLines || [])
    .map(item => [item.id, id("purchase")]))
  const receiptBatchIdMap = new Map((parsed.receiptBatches || [])
    .map(item => [item.id, id("receipt")]))
  const expenseIdMap = new Map((parsed.expenses || [])
    .map(item => [item.id, id("expense")]))
  const receiptAllocationIdMap = new Map((parsed.receiptBatches || [])
    .flatMap(item => item.allocationEvents)
    .map(item => [item.id, id("receipt_allocation")]))
  const inventoryEventIdMap = new Map((parsed.materialInventoryEvents || [])
    .map(item => [item.id, id("inventory")]))
  const costItemIdMap = new Map((parsed.costItems || [])
    .map(item => [item.id, id("cost")]))
  const paymentIdMap = new Map((parsed.paymentFacts || [])
    .map(item => [item.id, id("payment")]))
  const proposalIdMap = new Map((parsed.issueWorkflows || [])
    .flatMap(item => item.proposals)
    .map(item => [item.id, id("proposal")]))
  const treatmentIdMap = new Map((parsed.issueWorkflows || [])
    .flatMap(item => item.treatments)
    .map(item => [item.id, id("treatment")]))
  const reviewIdMap = new Map((parsed.issueWorkflows || [])
    .flatMap(item => item.reviews)
    .map(item => [item.id, id("review")]))
  const consultationIdMap = new Map((parsed.consultations || [])
    .map(item => [item.id, id("consultation")]))
  const consultationVersionIdMap = new Map((parsed.consultations || [])
    .flatMap(item => item.versions)
    .map(item => [item.id, id("consultation_version")]))
  const consultationResponseIdMap = new Map((parsed.consultationResponses || [])
    .map(item => [item.id, id("consultation_response")]))
  const cameraIdMap = new Map((parsed.cameras || []).map(item => [item.id, id("camera")]))
  const cameraSessionIdMap = new Map((parsed.evidenceLinks || [])
    .filter(item => item.target.type === "camera_session")
    .map(item => [item.target.id, id("camera_session")]))
  const project: Project = {
    ...parsed.project,
    id: newProjectId,
    name: `${parsed.project.name}（恢复副本）`,
    status: "archived",
    archivedAt: restoredAt,
    trashedAt: undefined,
    purgeAfter: undefined,
    restoredFromPackageId: options.sourcePackageId,
    restoredFromPackageFingerprint: options.sourcePackageFingerprint,
    restoreOperationId: options.restoreOperationId || options.sourcePackageId,
    createdAt: restoredAt,
    updatedAt: restoredAt
  }
  const restoredLifecycleEvents: ProjectLifecycleEvent[] = [
    lifecycleEvent(newProjectId, "restored", "从本地备份恢复为新副本", restoredAt),
    ...(parsed.projectLifecycleEvents || [])
      .filter(item => item.projectId === sourceProjectId)
      .map(item => ({
        ...item,
        id: id("project_event"),
        projectId: newProjectId
      }))
  ]
  const spaces = (parsed.spaces || [])
    .filter(item => item.projectId === sourceProjectId && spaceIdMap.has(item.id))
    .map(item => ({ ...item, id: spaceIdMap.get(item.id)!, projectId: newProjectId }))
  const evidenceAssets = (parsed.evidenceAssets || [])
    .filter(item => item.projectId === sourceProjectId && evidenceIdMap.has(item.id))
    .map(item => {
      const storageRef = item.storageRef?.kind === "local_file" ? { ...item.storageRef } : undefined
      const thumbnailRef = item.thumbnailRef?.kind === "local_file" ? { ...item.thumbnailRef } : undefined
      const hasRestorableOriginal = Boolean(storageRef)
      return {
        ...item,
        id: evidenceIdMap.get(item.id)!,
        projectId: newProjectId,
        storageRef,
        thumbnailRef,
        sourceDeviceId: item.sourceDeviceId ? cameraIdMap.get(item.sourceDeviceId) : undefined,
        sourceAttachmentId: undefined,
        status: hasRestorableOriginal || item.status === "hidden" ? item.status : "missing" as const,
        failureCode: hasRestorableOriginal || item.status === "hidden" ? item.failureCode : "missing_original" as const
      }
    })
  const spaceRelations = (parsed.spaceRelations || [])
    .filter(item => item.projectId === sourceProjectId
      && spaceIdMap.has(item.fromSpaceId) && spaceIdMap.has(item.toSpaceId))
    .map(item => ({
      ...item,
      id: id("space_relation"),
      projectId: newProjectId,
      fromSpaceId: spaceIdMap.get(item.fromSpaceId)!,
      toSpaceId: spaceIdMap.get(item.toSpaceId)!
    }))
  const legacyRoomMappings = (parsed.legacyRoomMappings || [])
    .filter(item => item.projectId === sourceProjectId && spaceIdMap.has(item.spaceId))
    .map(item => ({
      ...item,
      id: id("legacy_room_mapping"),
      projectId: newProjectId,
      spaceId: spaceIdMap.get(item.spaceId)!
    }))
  const records = (parsed.records || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: recordIdMap.get(item.id)!,
      projectId: newProjectId,
      spaceId: item.spaceId ? spaceIdMap.get(item.spaceId) : undefined,
      version: item.version || 1,
      attachments: (item.attachments || []).map(attachment => ({ ...attachment }))
    }))
  const recordRevisions = parsed.recordRevisions?.length
    ? parsed.recordRevisions
      .filter(item => item.projectId === sourceProjectId && recordIdMap.has(item.recordId))
      .map(item => ({
        ...item,
        id: recordRevisionIdMap.get(item.id)!,
        recordId: recordIdMap.get(item.recordId)!,
        projectId: newProjectId,
        spaceId: item.spaceId ? spaceIdMap.get(item.spaceId) : undefined,
        attachments: (item.attachments || []).map(attachment => ({ ...attachment }))
      }))
    : records.map(item => recordRevision(item, "从旧版备份恢复", restoredAt))
  const issues = (parsed.issues || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: issueIdMap.get(item.id)!,
      projectId: newProjectId,
      spaceId: item.spaceId ? spaceIdMap.get(item.spaceId) : undefined,
      recordId: item.recordId ? recordIdMap.get(item.recordId) : undefined
    }))
  const issueWorkflows = parsed.issueWorkflows?.length
    ? parsed.issueWorkflows
      .filter(item => item.projectId === sourceProjectId && issueIdMap.has(item.id))
      .map(item => {
      return {
        ...item,
        id: issueIdMap.get(item.id)!,
        projectId: newProjectId,
        proposals: item.proposals.map(proposal => ({
          ...proposal,
          id: proposalIdMap.get(proposal.id)!
        })),
        treatments: item.treatments.map(treatment => ({
          ...treatment,
          id: treatmentIdMap.get(treatment.id)!,
          activeProposalId: proposalIdMap.get(treatment.activeProposalId) || treatment.activeProposalId,
          evidenceSourceIds: treatment.evidenceSourceIds
            .map(sourceId => recordIdMap.get(sourceId))
            .filter((sourceId): sourceId is string => Boolean(sourceId))
        })),
        reviews: item.reviews.map(review => ({
          ...review,
          id: reviewIdMap.get(review.id)!,
          treatmentId: treatmentIdMap.get(review.treatmentId) || review.treatmentId,
          evidenceSourceIds: review.evidenceSourceIds
            .map(sourceId => recordIdMap.get(sourceId))
            .filter((sourceId): sourceId is string => Boolean(sourceId)),
          duplicateOfIssueId: review.duplicateOfIssueId
            ? issueIdMap.get(review.duplicateOfIssueId)
            : undefined
        })),
        reopenings: item.reopenings.map(reopening => ({
          ...reopening,
          id: id("reopening")
        }))
      }
      })
    : issues.map(item => {
      const proposals = item.proposals.map(proposal => ({
        id: id("proposal"),
        content: proposal.content,
        status: proposal.decision === "accepted"
          ? "active" as const
          : proposal.decision === "rejected" ? "superseded" as const : "pending" as const,
        submittedBy: proposal.authorName || "历史参与者",
        createdAt: proposal.createdAt,
        decidedBy: proposal.decision === "pending" ? undefined : "历史负责人",
        decidedAt: proposal.decidedAt
      }))
      const activeProposal = proposals.find(proposal => proposal.status === "active")
      const canRestoreReview = item.status === "pending_review" && Boolean(activeProposal)
      return {
        id: item.id,
        projectId: newProjectId,
        title: item.title,
        description: item.description,
        status: item.status === "pending_review" && !activeProposal
          ? "pending_action" as const
          : item.status,
        version: Math.max(1, proposals.length + (canRestoreReview ? 1 : 0)),
        proposals,
        treatments: canRestoreReview ? [{
          id: id("treatment"),
          activeProposalId: activeProposal!.id,
          note: "从旧版备份恢复的待复查状态",
          evidenceSourceIds: item.recordId ? [item.recordId] : [],
          submittedBy: "历史参与者",
          submittedAt: item.updatedAt
        }] : [],
        reviews: [],
        reopenings: [],
        createdBy: "历史参与者",
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }
    })
  const remapEvidenceTarget = (target: EvidenceTargetRef): EvidenceTargetRef | undefined => {
    const mappedId = target.type === "project" && target.id === sourceProjectId ? newProjectId
      : target.type === "record" ? recordIdMap.get(target.id)
        : target.type === "record_revision" ? recordRevisionIdMap.get(target.id)
          : target.type === "issue" ? issueIdMap.get(target.id)
            : target.type === "material" ? materialIdMap.get(target.id)
              : target.type === "receipt_batch" ? receiptBatchIdMap.get(target.id)
                : target.type === "issue_treatment" ? treatmentIdMap.get(target.id)
                  : target.type === "issue_review" ? reviewIdMap.get(target.id)
                    : target.type === "consultation" ? consultationIdMap.get(target.id)
                      : target.type === "camera_session" ? cameraSessionIdMap.get(target.id)
                        : undefined
    return mappedId ? { ...target, id: mappedId } : undefined
  }
  const evidenceLinks = (parsed.evidenceLinks || [])
    .filter(item => item.projectId === sourceProjectId && evidenceIdMap.has(item.evidenceId))
    .flatMap(item => {
      const target = remapEvidenceTarget(item.target)
      if (!target || (item.spaceId && !spaceIdMap.has(item.spaceId))) return []
      return [{
        ...item,
        id: id("evidence_link"),
        projectId: newProjectId,
        evidenceId: evidenceIdMap.get(item.evidenceId)!,
        target,
        spaceId: item.spaceId ? spaceIdMap.get(item.spaceId) : undefined
      }]
    })
  const spaceStageStates = (parsed.spaceStageStates || [])
    .filter(item => item.projectId === sourceProjectId && spaceIdMap.has(item.spaceId))
    .map(item => ({
      ...item,
      id: id("space_stage_state"),
      projectId: newProjectId,
      spaceId: spaceIdMap.get(item.spaceId)!,
      sourceEvidenceIds: item.sourceEvidenceIds
        .map(evidenceId => evidenceIdMap.get(evidenceId))
        .filter((evidenceId): evidenceId is string => Boolean(evidenceId))
    }))
  const materials = (parsed.materials || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({ ...item, id: materialIdMap.get(item.id)!, projectId: newProjectId }))
  const agreements = (parsed.agreements || [])
    .filter(item => item.agreement.projectId === sourceProjectId)
    .map(aggregate => {
      const agreementId = agreementIdMap.get(aggregate.agreement.id)!
      return {
        agreement: {
          ...aggregate.agreement,
          id: agreementId,
          projectId: newProjectId,
          subjectId: aggregate.agreement.subjectId
            ? materialIdMap.get(aggregate.agreement.subjectId)
            : undefined,
          activeVersionId: aggregate.agreement.activeVersionId
            ? agreementVersionIdMap.get(aggregate.agreement.activeVersionId)
            : undefined
        },
        versions: aggregate.versions.map(version => ({
          ...version,
          id: agreementVersionIdMap.get(version.id)!,
          agreementId,
          baseActiveVersionId: version.baseActiveVersionId
            ? agreementVersionIdMap.get(version.baseActiveVersionId)
            : undefined,
          sourceIds: version.sourceIds.map(sourceId => recordIdMap.get(sourceId) || sourceId),
          sourceConflicts: version.sourceConflicts.map(conflict => ({
            ...conflict,
            id: id("conflict"),
            alternatives: conflict.alternatives.map(alternative => ({
              ...alternative,
              sourceIds: alternative.sourceIds
                .map(sourceId => recordIdMap.get(sourceId) || sourceId)
            }))
          }))
        }))
      }
    })
  const purchaseLines = (parsed.purchaseLines || [])
    .filter(item => item.projectId === sourceProjectId && materialIdMap.has(item.materialId))
    .map(item => ({
      ...item,
      id: purchaseLineIdMap.get(item.id)!,
      projectId: newProjectId,
      materialId: materialIdMap.get(item.materialId)!,
      agreementVersionId: item.agreementVersionId
        ? agreementVersionIdMap.get(item.agreementVersionId)
        : undefined
    }))
  const receiptBatches = (parsed.receiptBatches || [])
    .filter(item => item.projectId === sourceProjectId && materialIdMap.has(item.materialId))
    .map(item => ({
      ...item,
      id: receiptBatchIdMap.get(item.id)!,
      projectId: newProjectId,
      purchaseLineId: item.purchaseLineId
        ? purchaseLineIdMap.get(item.purchaseLineId)
        : undefined,
      materialId: materialIdMap.get(item.materialId)!,
      quantityEvents: item.quantityEvents.map(event => ({
        ...event,
        id: id("receipt_quantity"),
        requestId: id("request")
      })),
      allocationEvents: item.allocationEvents.map(event => ({
        ...event,
        id: receiptAllocationIdMap.get(event.id)!,
        requestId: id("request")
      }))
    }))
  const unitConversions = (parsed.unitConversions || [])
    .filter(item => materialIdMap.has(item.materialId))
    .map(item => ({
      ...item,
      id: id("conversion"),
      materialId: materialIdMap.get(item.materialId)!
    }))
  const inventory = (parsed.inventory || [])
    .filter(item => item.projectId === sourceProjectId && materialIdMap.has(item.materialId))
    .map(item => ({ ...item, id: id("inventory"), projectId: newProjectId, materialId: materialIdMap.get(item.materialId)! }))
  const expenses = (parsed.expenses || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({ ...item, id: expenseIdMap.get(item.id)!, projectId: newProjectId }))
  const materialInventoryEvents = (parsed.materialInventoryEvents || [])
    .filter(item => item.projectId === sourceProjectId && materialIdMap.has(item.materialId))
    .map(item => ({
      ...item,
      id: inventoryEventIdMap.get(item.id)!,
      requestId: id("request"),
      projectId: newProjectId,
      materialId: materialIdMap.get(item.materialId)!,
      sourceEventId: item.sourceEventId
        ? inventoryEventIdMap.get(item.sourceEventId)
        : undefined,
      sourceReceiptAllocationId: item.sourceReceiptAllocationId
        ? receiptAllocationIdMap.get(item.sourceReceiptAllocationId)
        : undefined
    }))
  const materialUsageRecords = (parsed.materialUsageRecords || [])
    .filter(item => item.projectId === sourceProjectId
      && materialIdMap.has(item.materialId)
      && inventoryEventIdMap.has(item.issuedEventId))
    .map(item => ({
      ...item,
      id: id("usage"),
      requestId: id("request"),
      projectId: newProjectId,
      materialId: materialIdMap.get(item.materialId)!,
      issuedEventId: inventoryEventIdMap.get(item.issuedEventId)!
    }))
  const costItems = (parsed.costItems || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: costItemIdMap.get(item.id)!,
      projectId: newProjectId,
      materialId: item.materialId ? materialIdMap.get(item.materialId) : undefined,
      note: item.note || ""
    }))
  const costApprovals = (parsed.costApprovals || [])
    .filter(item => item.projectId === sourceProjectId && costItemIdMap.has(item.costItemId))
    .map(item => ({
      ...item,
      id: id("approval"),
      requestId: id("request"),
      projectId: newProjectId,
      costItemId: costItemIdMap.get(item.costItemId)!
    }))
  const paymentFacts = (parsed.paymentFacts || [])
    .filter(item => item.projectId === sourceProjectId && costItemIdMap.has(item.costItemId))
    .map(item => ({
      ...item,
      id: paymentIdMap.get(item.id)!,
      requestId: id("request"),
      projectId: newProjectId,
      costItemId: costItemIdMap.get(item.costItemId)!
    }))
  const refundFacts = (parsed.refundFacts || [])
    .filter(item => item.projectId === sourceProjectId
      && costItemIdMap.has(item.costItemId)
      && paymentIdMap.has(item.paymentId))
    .map(item => ({
      ...item,
      id: id("refund"),
      requestId: id("request"),
      projectId: newProjectId,
      costItemId: costItemIdMap.get(item.costItemId)!,
      paymentId: paymentIdMap.get(item.paymentId)!
    }))
  const members = (parsed.members || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: id("member"),
      projectId: newProjectId,
      status: "revoked" as const,
      revokedAt: restoredAt
    }))
  const shares = (parsed.shares || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({ ...item, id: id("share"), projectId: newProjectId, status: "revoked" as const, revokedAt: restoredAt }))
  const consultations = (parsed.consultations || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: consultationIdMap.get(item.id)!,
      projectId: newProjectId,
      status: "closed" as const,
      version: Math.max(1, item.version),
      draftVersionId: undefined,
      activeVersionId: undefined,
      versions: item.versions.map(version => ({
        ...version,
        id: consultationVersionIdMap.get(version.id)!,
        consultationId: consultationIdMap.get(item.id)!,
        status: "superseded" as const,
        recordIds: version.recordIds
          .map(recordId => recordIdMap.get(recordId))
          .filter((recordId): recordId is string => Boolean(recordId)),
        issueIds: version.issueIds
          .map(issueId => issueIdMap.get(issueId))
          .filter((issueId): issueId is string => Boolean(issueId)),
        recordCopies: (version.recordCopies || [])
          .filter(record => recordIdMap.has(record.id))
          .map(record => ({
            ...record,
            id: recordIdMap.get(record.id)!,
            projectId: newProjectId,
            attachments: (record.attachments || []).map(attachment => ({ ...attachment }))
          })),
        issueCopies: (version.issueCopies || [])
          .filter(issue => issueIdMap.has(issue.id))
          .map(issue => ({
            ...issue,
            id: issueIdMap.get(issue.id)!,
            projectId: newProjectId,
            recordId: issue.recordId ? recordIdMap.get(issue.recordId) : undefined,
            proposals: issue.proposals.map(proposal => ({ ...proposal }))
          })),
        expiresAt: undefined
      })),
      closedAt: restoredAt,
      closeReason: "从备份恢复的历史咨询，旧外发权限不恢复"
    }))
  const consultationResponses = (parsed.consultationResponses || [])
    .filter(item => item.projectId === sourceProjectId
      && consultationIdMap.has(item.consultationId)
      && consultationVersionIdMap.has(item.consultationVersionId))
    .map(item => ({
      ...item,
      id: consultationResponseIdMap.get(item.id)!,
      consultationId: consultationIdMap.get(item.consultationId)!,
      consultationVersionId: consultationVersionIdMap.get(item.consultationVersionId)!,
      projectId: newProjectId,
      memberId: undefined,
      targetIssueId: item.targetIssueId
        ? issueIdMap.get(item.targetIssueId)
        : undefined,
      proposalId: item.proposalId
        ? proposalIdMap.get(item.proposalId)
        : undefined
    }))
  const cameras = (parsed.cameras || [])
    .filter(item => item.projectId === sourceProjectId)
    .map(item => ({
      ...item,
      id: cameraIdMap.get(item.id)!,
      projectId: newProjectId,
      spaceId: item.spaceId ? spaceIdMap.get(item.spaceId) : undefined,
      status: "revoked" as const,
      revokedAt: restoredAt
    }))
  const analyses = (parsed.analyses || [])
    .filter(item => item.projectId === sourceProjectId && recordIdMap.has(item.recordId))
    .map(item => ({
      ...item,
      id: id("analysis"),
      projectId: newProjectId,
      recordId: recordIdMap.get(item.recordId)!,
      status: "draft" as const,
      acceptedAt: undefined
    }))
  const sourceIdMap = new Map<string, string>()
  for (const mapping of [
    recordIdMap,
    issueIdMap,
    materialIdMap,
    agreementVersionIdMap,
    purchaseLineIdMap,
    receiptBatchIdMap,
    expenseIdMap,
    costItemIdMap,
    consultationIdMap,
    consultationResponseIdMap
  ]) {
    for (const [sourceId, targetId] of mapping) sourceIdMap.set(sourceId, targetId)
  }
  const materialChecks = (parsed.materialChecks || [])
    .filter(item => item.projectId === sourceProjectId
      && materialIdMap.has(item.materialId)
      && receiptBatchIdMap.has(item.receiptBatchId)
      && item.originalResult
      && Array.isArray(item.originalResult.fields)
      && item.review
      && Array.isArray(item.review.fields))
    .map(item => ({
      ...item,
      id: id("material_check"),
      projectId: newProjectId,
      materialId: materialIdMap.get(item.materialId)!,
      receiptBatchId: receiptBatchIdMap.get(item.receiptBatchId)!,
      sourceSnapshots: item.sourceSnapshots?.map(source => ({
        ...source,
        sourceId: sourceIdMap.get(source.sourceId) || source.sourceId,
        relatedMaterialId: source.relatedMaterialId
          ? materialIdMap.get(source.relatedMaterialId) || source.relatedMaterialId
          : undefined,
        relatedConsultationId: source.relatedConsultationId
          ? consultationIdMap.get(source.relatedConsultationId) || source.relatedConsultationId
          : undefined
      })),
      originalResult: {
        ...item.originalResult,
        materialSourceId: materialIdMap.get(item.materialId)!,
        receiptSourceId: receiptBatchIdMap.get(item.receiptBatchId)!,
        fields: item.originalResult.fields.map(field => ({
          ...field,
          observedSourceIds: field.observedSourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId),
          expectedSourceIds: field.expectedSourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        }))
      },
      review: {
        fields: item.review.fields.map(field => ({ ...field }))
      }
    }))
  const remapSourceSnapshots = (snapshots: AiSourceSnapshotReference[]) =>
    snapshots.map(source => ({
      ...source,
      sourceId: sourceIdMap.get(source.sourceId) || source.sourceId,
      relatedMaterialId: source.relatedMaterialId
        ? materialIdMap.get(source.relatedMaterialId) || source.relatedMaterialId
        : undefined,
      relatedConsultationId: source.relatedConsultationId
        ? consultationIdMap.get(source.relatedConsultationId) || source.relatedConsultationId
        : undefined
    }))
  const recordReviewApplications = (parsed.recordReviewApplications || [])
    .filter(item => item.projectId === sourceProjectId
      && recordIdMap.has(item.targetRecordId)
      && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("record_review_application"),
      projectId: newProjectId,
      targetRecordId: recordIdMap.get(item.targetRecordId)!,
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      imageRefs: (item.imageRefs || [])
        .filter(image => recordIdMap.has(image.sourceId))
        .map(image => ({ ...image, sourceId: recordIdMap.get(image.sourceId)! })),
      originalResult: {
        ...item.originalResult,
        facts: item.originalResult.facts.map(fact => ({
          ...fact,
          sourceIds: fact.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        })),
        time: {
          ...item.originalResult.time,
          sourceIds: item.originalResult.time.sourceIds
            .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        },
        opinions: item.originalResult.opinions.map(opinion => ({
          ...opinion,
          sourceIds: opinion.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        })),
        gaps: [...item.originalResult.gaps]
      },
      review: {
        ...item.review,
        facts: item.review.facts.map(line => ({ ...line })),
        opinions: item.review.opinions.map(line => ({ ...line }))
      }
    }))
  const imageObservationApplications = (parsed.imageObservationApplications || [])
    .filter(item => item.projectId === sourceProjectId
      && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("image_observation_application"),
      projectId: newProjectId,
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      imageRefs: (item.imageRefs || [])
        .filter(image => recordIdMap.has(image.sourceId))
        .map(image => ({ ...image, sourceId: recordIdMap.get(image.sourceId)! })),
      originalResult: {
        images: item.originalResult.images.map(image => ({
          ...image,
          sourceId: recordIdMap.get(image.sourceId) || image.sourceId,
          qualityLimitations: [...image.qualityLimitations]
        })),
        items: item.originalResult.items.map(observation => ({
          ...observation,
          sourceId: recordIdMap.get(observation.sourceId) || observation.sourceId,
          region: observation.region ? { ...observation.region } : undefined,
          limitations: [...observation.limitations],
          captureSuggestions: [...observation.captureSuggestions],
          knowledgeIds: [...observation.knowledgeIds]
        }))
      },
      review: {
        items: item.review.items.map(observation => ({
          ...observation,
          limitations: [...observation.limitations],
          captureSuggestions: [...observation.captureSuggestions]
        }))
      },
      issueLinks: item.issueLinks
        .filter(link => issueIdMap.has(link.issueId))
        .map(link => ({ ...link, issueId: issueIdMap.get(link.issueId)! }))
    }))
  const rectificationApplications = (parsed.rectificationApplications || [])
    .filter(item => item.projectId === sourceProjectId
      && issueIdMap.has(item.targetIssueId) && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("rectification_application"),
      projectId: newProjectId,
      targetIssueId: issueIdMap.get(item.targetIssueId)!,
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      imageRefs: (item.imageRefs || [])
        .filter(image => recordIdMap.has(image.sourceId))
        .map(image => ({ ...image, sourceId: recordIdMap.get(image.sourceId)! })),
      originalResult: item.originalResult.mode === "proposal"
        ? {
          ...item.originalResult,
          issueSourceId: issueIdMap.get(item.originalResult.issueSourceId)
            || item.originalResult.issueSourceId,
          premises: [...item.originalResult.premises],
          gaps: [...item.originalResult.gaps],
          proposals: item.originalResult.proposals.map(option => ({
            ...option,
            actions: [...option.actions],
            applicability: [...option.applicability],
            impacts: [...option.impacts],
            verificationEvidence: [...option.verificationEvidence],
            sourceIds: option.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId),
            knowledgeIds: [...option.knowledgeIds]
          }))
        }
        : {
          ...item.originalResult,
          issueSourceId: issueIdMap.get(item.originalResult.issueSourceId)
            || item.originalResult.issueSourceId,
          treatmentId: treatmentIdMap.get(item.originalResult.treatmentId)
            || item.originalResult.treatmentId,
          checks: item.originalResult.checks.map(check => ({
            ...check,
            beforeSourceIds: check.beforeSourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId),
            afterSourceIds: check.afterSourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId),
            limitations: [...check.limitations],
            nextSteps: [...check.nextSteps],
            knowledgeIds: [...check.knowledgeIds]
          })),
          gaps: [...item.originalResult.gaps]
        },
      review: item.review.mode === "proposal"
        ? { ...item.review, items: item.review.items.map(reviewed => ({ ...reviewed })) }
        : {
          ...item.review,
          items: item.review.items.map(reviewed => ({
            ...reviewed,
            limitations: [...reviewed.limitations],
            nextSteps: [...reviewed.nextSteps]
          }))
        },
      proposalLinks: item.proposalLinks
        .filter(link => proposalIdMap.has(link.proposalId))
        .map(link => ({ ...link, proposalId: proposalIdMap.get(link.proposalId)! }))
    }))
  const consultationApplications = (parsed.consultationApplications || [])
    .filter(item => item.projectId === sourceProjectId && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("consultation_application"),
      projectId: newProjectId,
      targetConsultationId: item.targetConsultationId
        ? consultationIdMap.get(item.targetConsultationId)
        : undefined,
      createdConsultationId: item.createdConsultationId
        ? consultationIdMap.get(item.createdConsultationId)
        : undefined,
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      imageRefs: (item.imageRefs || [])
        .filter(image => recordIdMap.has(image.sourceId))
        .map(image => ({ ...image, sourceId: recordIdMap.get(image.sourceId)! })),
      originalResult: item.originalResult.mode === "prepare"
        ? {
          ...item.originalResult,
          facts: item.originalResult.facts.map(finding => ({
            ...finding, sourceIds: finding.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          })),
          timeline: item.originalResult.timeline.map(finding => ({
            ...finding, sourceIds: finding.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          })),
          disputes: item.originalResult.disputes.map(finding => ({
            ...finding, sourceIds: finding.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          })),
          gaps: [...item.originalResult.gaps],
          questions: item.originalResult.questions.map(question => ({
            ...question,
            sourceIds: question.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          }))
        }
        : {
          ...item.originalResult,
          consultationSourceId: consultationIdMap.get(item.originalResult.consultationSourceId)
            || item.originalResult.consultationSourceId,
          mappings: item.originalResult.mappings.map(mapping => ({
            ...mapping,
            responseSourceIds: mapping.responseSourceIds
              .map(sourceId => consultationResponseIdMap.get(sourceId) || sourceId),
            conditions: [...mapping.conditions],
            conflicts: [...mapping.conflicts],
            followUps: [...mapping.followUps],
            targetIssueSourceId: mapping.targetIssueSourceId
              ? issueIdMap.get(mapping.targetIssueSourceId) || mapping.targetIssueSourceId
              : ""
          })),
          gaps: [...item.originalResult.gaps]
        },
      review: item.review.mode === "prepare"
        ? {
          ...item.review,
          facts: item.review.facts.map(line => ({ ...line })),
          timeline: item.review.timeline.map(line => ({ ...line })),
          disputes: item.review.disputes.map(line => ({ ...line })),
          gaps: [...item.review.gaps],
          questions: item.review.questions.map(line => ({ ...line }))
        }
        : {
          ...item.review,
          mappings: item.review.mappings.map(mapping => ({
            ...mapping,
            conditions: [...mapping.conditions],
            conflicts: [...mapping.conflicts],
            followUps: [...mapping.followUps],
            targetIssueSourceId: mapping.targetIssueSourceId
              ? issueIdMap.get(mapping.targetIssueSourceId) || mapping.targetIssueSourceId
              : ""
          }))
        },
      proposalLinks: item.proposalLinks
        .filter(link => proposalIdMap.has(link.proposalId) && issueIdMap.has(link.issueId))
        .map(link => ({
          ...link,
          proposalId: proposalIdMap.get(link.proposalId)!,
          issueId: issueIdMap.get(link.issueId)!,
          responseIds: (link.responseIds || [])
            .map(responseId => consultationResponseIdMap.get(responseId))
            .filter((responseId): responseId is string => Boolean(responseId))
        }))
    }))
  const budgetEstimateApplications = (parsed.budgetEstimateApplications || [])
    .filter(item => item.projectId === sourceProjectId && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("budget_estimate_application"),
      projectId: newProjectId,
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      originalResult: {
        ...item.originalResult,
        scenarios: item.originalResult.scenarios.map(scenario => ({
          ...scenario,
          materialSourceId: scenario.materialSourceId
            ? materialIdMap.get(scenario.materialSourceId) || scenario.materialSourceId
            : "",
          requiredQuantity: {
            ...scenario.requiredQuantity,
            sourceIds: scenario.requiredQuantity.sourceIds
              .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          },
          wasteRatePercent: {
            ...scenario.wasteRatePercent,
            sourceIds: scenario.wasteRatePercent.sourceIds
              .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          },
          requirementIncludesWaste: {
            ...scenario.requirementIncludesWaste,
            sourceIds: scenario.requirementIncludesWaste.sourceIds
              .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          },
          packageSize: {
            ...scenario.packageSize,
            sourceIds: scenario.packageSize.sourceIds
              .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          },
          packageUnitPriceYuan: {
            ...scenario.packageUnitPriceYuan,
            sourceIds: scenario.packageUnitPriceYuan.sourceIds
              .map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          },
          assumptions: [...scenario.assumptions],
          conflicts: [...scenario.conflicts],
          missingFields: [...scenario.missingFields]
        })),
        ledgerNotes: item.originalResult.ledgerNotes.map(note => ({
          ...note,
          sourceIds: note.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        })),
        gaps: [...item.originalResult.gaps]
      },
      review: {
        ...item.review,
        scenarios: item.review.scenarios.map(scenario => ({
          ...scenario,
          materialSourceId: scenario.materialSourceId
            ? materialIdMap.get(scenario.materialSourceId) || scenario.materialSourceId
            : ""
        }))
      },
      scenarios: item.scenarios.map(scenario => ({
        ...scenario,
        materialId: scenario.materialId
          ? materialIdMap.get(scenario.materialId) || scenario.materialId
          : undefined,
        resourceFacts: scenario.resourceFacts
          ? { ...scenario.resourceFacts, warnings: [...scenario.resourceFacts.warnings] }
          : undefined,
        resourceGap: scenario.resourceGap ? { ...scenario.resourceGap } : undefined,
        totalRequirement: { ...scenario.totalRequirement },
        recommendedPurchase: scenario.recommendedPurchase
          ? { ...scenario.recommendedPurchase }
          : undefined
      })),
      financeSnapshots: item.financeSnapshots
        .filter(snapshot => costItemIdMap.has(snapshot.costItemId))
        .map(snapshot => ({
          ...snapshot,
          costItemId: costItemIdMap.get(snapshot.costItemId)!,
          summary: { ...snapshot.summary }
        }))
    }))
  const projectSummaryApplications = (parsed.projectSummaryApplications || [])
    .filter(item => item.projectId === sourceProjectId && item.originalResult && item.review)
    .map(item => ({
      ...item,
      id: id("project_summary_application"),
      projectId: newProjectId,
      scope: { ...item.scope },
      sourceSnapshots: remapSourceSnapshots(item.sourceSnapshots || []),
      originalResult: {
        ...item.originalResult,
        sections: item.originalResult.sections.map(section => ({
          ...section,
          items: section.items.map(summaryItem => ({
            ...summaryItem,
            sourceIds: summaryItem.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
          })),
          gaps: [...section.gaps]
        })),
        handoff: item.originalResult.handoff.map(handoffItem => ({
          ...handoffItem,
          sourceIds: handoffItem.sourceIds.map(sourceId => sourceIdMap.get(sourceId) || sourceId)
        })),
        overallGaps: [...item.originalResult.overallGaps]
      },
      review: {
        ...item.review,
        sections: item.review.sections.map(section => ({ ...section })),
        handoff: item.review.handoff.map(handoffItem => ({ ...handoffItem }))
      },
      issueSnapshots: item.issueSnapshots
        .filter(snapshot => issueIdMap.has(snapshot.issueId))
        .map(snapshot => ({ ...snapshot, issueId: issueIdMap.get(snapshot.issueId)! })),
      financeSnapshots: item.financeSnapshots
        .filter(snapshot => costItemIdMap.has(snapshot.costItemId))
        .map(snapshot => ({
          ...snapshot,
          costItemId: costItemIdMap.get(snapshot.costItemId)!,
          summary: { ...snapshot.summary }
        }))
    }))
  saveState({
    ...state,
    currentProjectId: newProjectId,
    projects: [project, ...state.projects],
    projectLifecycleEvents: [...restoredLifecycleEvents, ...state.projectLifecycleEvents],
    spaces: [...spaces, ...state.spaces],
    spaceRelations: [...spaceRelations, ...state.spaceRelations],
    spaceStageStates: [...spaceStageStates, ...state.spaceStageStates],
    legacyRoomMappings: [...legacyRoomMappings, ...state.legacyRoomMappings],
    evidenceAssets: [...evidenceAssets, ...state.evidenceAssets],
    evidenceLinks: [...evidenceLinks, ...state.evidenceLinks],
    records: [...records, ...state.records],
    recordRevisions: [...recordRevisions, ...state.recordRevisions],
    issues: [...issues, ...state.issues],
    issueWorkflows: [...issueWorkflows, ...state.issueWorkflows],
    materials: [...materials, ...state.materials],
    inventory: [...inventory, ...state.inventory],
    expenses: [...expenses, ...state.expenses],
    agreements: [...agreements, ...state.agreements],
    purchaseLines: [...purchaseLines, ...state.purchaseLines],
    receiptBatches: [...receiptBatches, ...state.receiptBatches],
    unitConversions: [...unitConversions, ...state.unitConversions],
    materialInventoryEvents: [...materialInventoryEvents, ...state.materialInventoryEvents],
    materialUsageRecords: [...materialUsageRecords, ...state.materialUsageRecords],
    costItems: [...costItems, ...state.costItems],
    costApprovals: [...costApprovals, ...state.costApprovals],
    paymentFacts: [...paymentFacts, ...state.paymentFacts],
    refundFacts: [...refundFacts, ...state.refundFacts],
    members: [...members, ...state.members],
    shares: [...shares, ...state.shares],
    consultations: [...consultations, ...state.consultations],
    consultationResponses: [...consultationResponses, ...state.consultationResponses],
    cameras: [...cameras, ...state.cameras],
    analyses: [...analyses, ...state.analyses],
    materialChecks: [...materialChecks, ...state.materialChecks],
    recordReviewApplications: [
      ...recordReviewApplications,
      ...state.recordReviewApplications
    ],
    imageObservationApplications: [
      ...imageObservationApplications,
      ...state.imageObservationApplications
    ],
    rectificationApplications: [
      ...rectificationApplications,
      ...state.rectificationApplications
    ],
    consultationApplications: [
      ...consultationApplications,
      ...state.consultationApplications
    ],
    budgetEstimateApplications: [
      ...budgetEstimateApplications,
      ...state.budgetEstimateApplications
    ],
    projectSummaryApplications: [
      ...projectSummaryApplications,
      ...state.projectSummaryApplications
    ]
  })
  return project
}

export function createCameraBinding(
  input: Omit<CameraBinding, "id" | "createdAt" | "status">
): CameraBinding {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const item: CameraBinding = {
    ...input,
    id: id("camera"),
    status: "pending_configuration",
    createdAt: now()
  }
  saveState({ ...state, cameras: [item, ...state.cameras] })
  return item
}

export function revokeCameraBinding(cameraId: string): void {
  const state = loadState()
  const camera = state.cameras.find(item => item.id === cameraId)
  if (!camera) throw new Error("监控设备不存在")
  assertProjectWritable(state, camera.projectId)
  const revokedAt = now()
  saveState({
    ...state,
    cameras: state.cameras.map(item => item.id === cameraId
      ? { ...item, status: "revoked", revokedAt }
      : item)
  })
}

export function createAnalysisNote(
  input: Omit<AnalysisNote, "id" | "createdAt" | "status">
): AnalysisNote {
  const state = loadState()
  assertProjectWritable(state, input.projectId)
  const item: AnalysisNote = {
    ...input,
    id: id("analysis"),
    status: "draft",
    createdAt: now()
  }
  saveState({ ...state, analyses: [item, ...state.analyses] })
  return item
}

export function decideAnalysisNote(analysisId: string, decision: "accepted" | "dismissed"): void {
  const state = loadState()
  const analysis = state.analyses.find(item => item.id === analysisId)
  if (!analysis) throw new Error("分析记录不存在")
  assertProjectWritable(state, analysis.projectId)
  const acceptedAt = decision === "accepted" ? now() : undefined
  saveState({
    ...state,
    analyses: state.analyses.map(item => item.id === analysisId
      ? { ...item, status: decision, acceptedAt }
      : item)
  })
}

function validateAiSourceSnapshots(
  state: AppState,
  project: Project,
  sourceSnapshots: AiSourceSnapshotReference[]
): void {
  if (!sourceSnapshots.length) throw new Error("AI 来源快照未加载，请重新打开任务")
  const ids = new Set<string>()
  for (const source of sourceSnapshots) {
    if (!source.sourceId || ids.has(source.sourceId) || !source.version) {
      throw new Error("AI 来源快照不完整")
    }
    ids.add(source.sourceId)
  }
  const currentSources = new Map(
    buildAiSourcePlan(state, project).choices.map(source => [source.id, source])
  )
  for (const snapshot of sourceSnapshots) {
    const current = currentSources.get(snapshot.sourceId)
    if (!current
      || current.kind !== snapshot.kind
      || current.version !== snapshot.version
      || current.authority !== snapshot.authority
      || current.relatedMaterialId !== snapshot.relatedMaterialId
      || current.relatedConsultationId !== snapshot.relatedConsultationId) {
      throw new Error("分析使用的资料已变化，请基于最新资料重新分析")
    }
  }
}

export function assertAiSourcesCurrent(
  projectId: string,
  sourceSnapshots: AiSourceSnapshotReference[]
): void {
  const state = loadState()
  const project = assertProjectWritable(state, projectId)
  validateAiSourceSnapshots(state, project, sourceSnapshots)
}

export function saveMaterialCheckRecord(input: {
  projectId: string
  materialId: string
  receiptBatchId: string
  aiJobId: string
  model: string
  promptVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  originalResult: MaterialCheckResult
  review: MaterialCheckReview
  metrics?: AiRunMetrics
}): MaterialCheckRecord {
  const state = loadState()
  const existing = state.materialChecks.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) {
    if (existing.materialId !== input.materialId || existing.receiptBatchId !== input.receiptBatchId) {
      throw new Error("同一 AI 任务不能写入另一批材料到货")
    }
    return existing
  }
  const { project, material, receipt } = validateMaterialCheckWritebackContext(state, input)
  if (!input.aiJobId.trim() || !input.model.trim() || !input.promptVersion.trim()) {
    throw new Error("AI 核对任务标识或版本不完整")
  }
  if (input.originalResult.materialSourceId !== material.id
    || input.originalResult.receiptSourceId !== receipt.id) {
    throw new Error("AI 核对结果与当前材料到货不一致")
  }
  const originalKeys = new Set(input.originalResult.fields.map(field => field.key))
  const reviewKeys = new Set(input.review.fields.map(field => field.key))
  if (originalKeys.size !== input.originalResult.fields.length
    || reviewKeys.size !== input.review.fields.length
    || originalKeys.size !== reviewKeys.size
    || [...originalKeys].some(key => !reviewKeys.has(key))) {
    throw new Error("人工复核字段与模型原结果不一致")
  }
  const item: MaterialCheckRecord = {
    id: id("material_check"),
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    method: "ai",
    aiJobId: input.aiJobId,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: input.sourceSnapshots.map(source => ({ ...source })),
    originalResult: {
      materialSourceId: input.originalResult.materialSourceId,
      receiptSourceId: input.originalResult.receiptSourceId,
      fields: input.originalResult.fields.map(field => ({
        ...field,
        observedSourceIds: [...field.observedSourceIds],
        expectedSourceIds: [...field.expectedSourceIds]
      }))
    },
    review: {
      fields: input.review.fields.map(field => ({ ...field }))
    },
    metrics: input.metrics ? { ...input.metrics, usage: input.metrics.usage ? { ...input.metrics.usage } : undefined } : undefined,
    confirmedBy: project.ownerName,
    confirmedAt: now()
  }
  saveState({ ...state, materialChecks: [item, ...state.materialChecks] })
  return item
}

export function saveManualMaterialCheckRecord(input: {
  requestId: string
  projectId: string
  materialId: string
  receiptBatchId: string
  agreementVersionId?: string
  summary: string
  fields: MaterialCheckReview["fields"]
}): MaterialCheckRecord {
  const state = loadState()
  const requestId = input.requestId.trim()
  if (!requestId) throw new Error("人工核对请求标识不能为空")
  const manualJobId = `manual:${requestId}`
  const existing = state.materialChecks.find(item => item.aiJobId === manualJobId)
  if (existing) {
    if (existing.projectId !== input.projectId || existing.materialId !== input.materialId
      || existing.receiptBatchId !== input.receiptBatchId) {
      throw new Error("同一人工核对请求不能写入另一批材料")
    }
    return existing
  }
  const project = assertProjectWritable(state, input.projectId)
  const material = state.materials.find(item => item.id === input.materialId && item.projectId === project.id)
  const receipt = state.receiptBatches.find(item => item.id === input.receiptBatchId
    && item.projectId === project.id && item.materialId === input.materialId)
  if (!material || !receipt) throw new Error("材料或到货批次已变化，请重新打开后核对")
  const requiredKeys = ["brand", "model", "specification", "quantity"] as const
  if (input.fields.length !== requiredKeys.length
    || requiredKeys.some(key => !input.fields.some(field => field.key === key))) {
    throw new Error("品牌、型号、规格和数量必须逐项核对")
  }
  if (input.fields.some(field => !["matches", "differs", "observed_only", "expected_only", "unknown"].includes(field.status))) {
    throw new Error("人工核对状态不正确")
  }
  for (const field of input.fields) {
    const observed = field.observedValue.trim()
    const expected = field.expectedValue.trim()
    const actualStatus = observed && expected
      ? (observed.toLocaleLowerCase() === expected.toLocaleLowerCase() ? "matches" : "differs")
      : observed ? "observed_only" : expected ? "expected_only" : "unknown"
    if (field.status !== actualStatus) throw new Error(`${field.key} 的核对状态与填写值不一致`)
  }
  let agreementVersionExists = false
  if (input.agreementVersionId) {
    agreementVersionExists = state.agreements.some(aggregate =>
      aggregate.agreement.projectId === project.id
      && aggregate.agreement.subject === "material"
      && aggregate.agreement.subjectId === material.id
      && aggregate.versions.some(version => version.id === input.agreementVersionId
        && (version.status === "active" || version.status === "superseded")))
    if (!agreementVersionExists) throw new Error("批准基线已变化，请重新打开后核对")
  }
  const sourceSnapshots: AiSourceSnapshotReference[] = [
    { sourceId: material.id, kind: "material", version: material.createdAt, relatedMaterialId: material.id },
    { sourceId: receipt.id, kind: "receipt", version: `${receipt.version}`, relatedMaterialId: material.id },
    ...(agreementVersionExists && input.agreementVersionId
      ? [{ sourceId: input.agreementVersionId, kind: "agreement" as const, version: input.agreementVersionId,
        authority: "approved_agreement" as const, relatedMaterialId: material.id }]
      : [])
  ]
  const originalFields = input.fields.map(field => ({
    ...field,
    label: ({ brand: "品牌", model: "型号", specification: "规格", quantity: "数量" } as Record<string, string>)[field.key] || field.key,
    observedSourceIds: field.observedValue ? [receipt.id] : [],
    expectedSourceIds: field.expectedValue && input.agreementVersionId ? [input.agreementVersionId] : []
  }))
  const item: MaterialCheckRecord = {
    id: id("material_check"),
    projectId: project.id,
    materialId: material.id,
    receiptBatchId: receipt.id,
    method: "manual",
    aiJobId: manualJobId,
    model: "人工录入",
    promptVersion: "不适用",
    summary: input.summary.trim() || "人工逐字段核对",
    sourceSnapshots,
    originalResult: { materialSourceId: material.id, receiptSourceId: receipt.id, fields: originalFields },
    review: { fields: input.fields.map(field => ({ ...field })) },
    confirmedBy: project.ownerName,
    confirmedAt: now()
  }
  saveState({ ...state, materialChecks: [item, ...state.materialChecks] })
  return item
}

function validateMaterialCheckWritebackContext(
  state: AppState,
  input: {
    projectId: string
    materialId: string
    receiptBatchId: string
    sourceSnapshots: AiSourceSnapshotReference[]
    originalResult: MaterialCheckResult
  }
): { project: Project; material: Material; receipt: ReceiptBatch } {
  const project = assertProjectWritable(state, input.projectId)
  const material = state.materials.find(item =>
    item.id === input.materialId && item.projectId === input.projectId)
  const receipt = state.receiptBatches.find(item =>
    item.id === input.receiptBatchId
    && item.projectId === input.projectId
    && item.materialId === input.materialId)
  if (!material || !receipt) throw new Error("材料或到货批次已变化，不能写入核对记录")
  if (input.originalResult.materialSourceId !== material.id
    || input.originalResult.receiptSourceId !== receipt.id) {
    throw new Error("AI 核对结果与当前材料到货不一致")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  const ids = new Set(input.sourceSnapshots.map(source => source.sourceId))
  const materialSnapshot = input.sourceSnapshots.find(source => source.sourceId === material.id)
  const receiptSnapshot = input.sourceSnapshots.find(source => source.sourceId === receipt.id)
  if (materialSnapshot?.kind !== "material" || receiptSnapshot?.kind !== "receipt") {
    throw new Error("AI 核对来源快照缺少本次材料或到货批次")
  }
  const referencedIds = new Set([
    input.originalResult.materialSourceId,
    input.originalResult.receiptSourceId,
    ...input.originalResult.fields.flatMap(field => [
      ...field.observedSourceIds,
      ...field.expectedSourceIds
    ])
  ])
  if ([...referencedIds].some(sourceId => !ids.has(sourceId))) {
    throw new Error("AI 核对结果引用了未留存版本的资料")
  }
  return { project, material, receipt }
}

export function assertMaterialCheckWritebackCurrent(input: {
  projectId: string
  materialId: string
  receiptBatchId: string
  sourceSnapshots: AiSourceSnapshotReference[]
  originalResult: MaterialCheckResult
}): void {
  validateMaterialCheckWritebackContext(loadState(), input)
}

function cloneSourceSnapshots(value: AiSourceSnapshotReference[]): AiSourceSnapshotReference[] {
  return value.map(source => ({ ...source }))
}

function cloneAiValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validateImageReferences(
  state: AppState,
  projectId: string,
  imageRefs: AiImageReference[]
): void {
  const ids = new Set<string>()
  for (const image of imageRefs) {
    if (!image.id || !image.sourceId || ids.has(image.id)) throw new Error("AI 图片来源不完整")
    ids.add(image.id)
    const record = state.records.find(item =>
      item.id === image.sourceId && item.projectId === projectId)
    if (!record?.attachments.some(file => file.id === image.id && file.type === "image")) {
      throw new Error("分析使用的图片已变化，请基于最新原件重新分析")
    }
  }
}

export function assertAiWritebackCurrent(
  projectId: string,
  sourceSnapshots: AiSourceSnapshotReference[],
  imageRefs: AiImageReference[]
): void {
  const state = loadState()
  const project = assertProjectWritable(state, projectId)
  validateAiSourceSnapshots(state, project, sourceSnapshots)
  validateImageReferences(state, project.id, imageRefs)
}

function validateRecordReviewForApplication(
  original: RecordReviewResult,
  review: RecordReviewReview
): void {
  if (!review.title.trim() || !review.room.trim()
    || !STAGES.includes(review.stage as ProjectStage)
    || Number.isNaN(Date.parse(review.occurredAt))) {
    throw new Error("记录整理草稿的标题、房间、工序或日期不正确")
  }
  const validateLines = (
    lines: RecordReviewReview["facts"],
    length: number
  ) => {
    if (lines.length !== length) throw new Error("记录整理草稿与模型原结果不一致")
    const indexes = new Set<number>()
    for (const line of lines) {
      if (!Number.isInteger(line.sourceIndex) || line.sourceIndex < 0
        || line.sourceIndex >= length || indexes.has(line.sourceIndex)
        || (line.included && !line.text.trim())) {
        throw new Error("记录整理草稿条目不正确")
      }
      indexes.add(line.sourceIndex)
    }
  }
  validateLines(review.facts, original.facts.length)
  validateLines(review.opinions, original.opinions.length)
  if (![...review.facts, ...review.opinions].some(line => line.included)
    && !review.note.trim()) {
    throw new Error("记录整理至少需要保留一条内容或人工说明")
  }
}

function recordReviewNote(review: RecordReviewReview): string {
  const facts = review.facts
    .filter(line => line.included)
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map(line => line.text.trim())
  const opinions = review.opinions
    .filter(line => line.included)
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map(line => `意见：${line.text.trim()}`)
  return [...facts, ...opinions, review.note.trim()].filter(Boolean).join("\n")
}

export function applyRecordReview(input: {
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: RecordReviewResult
  review: RecordReviewReview
  target?: { recordId: string; expectedVersion: number }
}): { application: RecordReviewApplication; record: RecordItem } {
  const state = loadState()
  const existing = state.recordReviewApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) {
    const record = state.records.find(item => item.id === existing.targetRecordId)
    if (!record) throw new Error("已写回的记录不存在")
    if (input.target && input.target.recordId !== record.id) {
      throw new Error("同一 AI 任务不能写入另一条记录")
    }
    return { application: existing, record }
  }
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 记录整理任务标识或版本不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  validateImageReferences(state, project.id, input.imageRefs)
  validateRecordReviewForApplication(input.originalResult, input.review)
  const timestamp = now()
  const note = recordReviewNote(input.review)
  let record: RecordItem
  if (input.target) {
    const current = state.records.find(item =>
      item.id === input.target!.recordId && item.projectId === project.id)
    if (!current) throw new Error("待修订记录不存在")
    if (current.version !== input.target.expectedVersion) {
      throw new Error("记录已更新，请基于最新版本重新整理")
    }
    record = {
      ...current,
      version: current.version + 1,
      title: input.review.title.trim(),
      note,
      room: input.review.room.trim(),
      stage: input.review.stage as ProjectStage,
      occurredAt: new Date(input.review.occurredAt).toISOString(),
      attachments: current.attachments.map(file => ({ ...file }))
    }
  } else {
    const attachments = input.imageRefs.map(image => {
      const source = state.records.find(item => item.id === image.sourceId)!
      return { ...source.attachments.find(file => file.id === image.id)! }
    })
    record = {
      id: id("record"),
      projectId: project.id,
      version: 1,
      title: input.review.title.trim(),
      note,
      room: input.review.room.trim(),
      stage: input.review.stage as ProjectStage,
      creatorName: project.ownerName,
      occurredAt: new Date(input.review.occurredAt).toISOString(),
      createdAt: timestamp,
      attachments
    }
  }
  const application: RecordReviewApplication = {
    id: id("record_review_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    targetRecordId: record.id,
    targetRecordVersion: record.version,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    imageRefs: input.imageRefs.map(image => ({ ...image })),
    originalResult: {
      ...input.originalResult,
      facts: input.originalResult.facts.map(fact => ({ ...fact, sourceIds: [...fact.sourceIds] })),
      time: { ...input.originalResult.time, sourceIds: [...input.originalResult.time.sourceIds] },
      opinions: input.originalResult.opinions.map(opinion => ({ ...opinion, sourceIds: [...opinion.sourceIds] })),
      gaps: [...input.originalResult.gaps]
    },
    review: {
      ...input.review,
      facts: input.review.facts.map(line => ({ ...line })),
      opinions: input.review.opinions.map(line => ({ ...line }))
    },
    appliedBy: project.ownerName,
    appliedAt: timestamp
  }
  saveState({
    ...state,
    records: input.target
      ? state.records.map(item => item.id === record.id ? record : item)
      : [record, ...state.records],
    recordRevisions: [
      recordRevision(
        record,
        input.target ? "采纳 AI 记录整理并人工复核" : "由 AI 记录整理草稿创建",
        timestamp
      ),
      ...state.recordRevisions
    ],
    recordReviewApplications: [application, ...state.recordReviewApplications]
  })
  return { application, record }
}

function validateImageReviewForApplication(
  original: ImageObservationResult,
  review: ImageObservationReview
): void {
  if (review.items.length !== original.items.length) {
    throw new Error("图片观察复核与模型原结果不一致")
  }
  const originalIds = new Set(original.items.map(item => item.itemId))
  const seen = new Set<string>()
  for (const item of review.items) {
    if (!originalIds.has(item.itemId) || seen.has(item.itemId)
      || !["saved", "ignored", "issue"].includes(item.disposition)
      || !item.observation.trim() || !item.priorityReason.trim()
      || (item.disposition === "issue" && !item.issueTitle.trim())) {
      throw new Error("图片观察复核条目不正确")
    }
    seen.add(item.itemId)
  }
}

export function applyImageObservation(input: {
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
}): ImageObservationApplication {
  const state = loadState()
  const existing = state.imageObservationApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) return existing
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 图片观察任务标识或版本不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  validateImageReferences(state, project.id, input.imageRefs)
  validateImageReviewForApplication(input.originalResult, input.review)
  const originals = new Map(input.originalResult.items.map(item => [item.itemId, item]))
  const timestamp = now()
  const issues: Issue[] = []
  const workflows: IssueWorkflow[] = []
  const issueLinks: Array<{ itemId: string; issueId: string }> = []
  for (const reviewed of input.review.items.filter(item => item.disposition === "issue")) {
    const original = originals.get(reviewed.itemId)!
    const sourceRecord = state.records.find(item =>
      item.id === original.sourceId && item.projectId === project.id)
    const issueId = id("issue")
    const description = [
      `可见现象：${reviewed.observation.trim()}`,
      reviewed.suspectedExplanation.trim()
        ? `待核实解释：${reviewed.suspectedExplanation.trim()}` : "",
      reviewed.limitations.length ? `限制：${reviewed.limitations.join("；")}` : "",
      reviewed.captureSuggestions.length
        ? `补证建议：${reviewed.captureSuggestions.join("；")}` : "",
      `来源：AI 图片观察 ${input.aiJobId} / 条目 ${reviewed.itemId}`
    ].filter(Boolean).join("\n")
    const issue: Issue = {
      id: issueId,
      projectId: project.id,
      title: reviewed.issueTitle.trim(),
      description,
      room: sourceRecord?.room || "全屋",
      stage: sourceRecord?.stage || project.stage,
      recordId: sourceRecord?.id,
      status: "pending_confirmation",
      proposals: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }
    issues.push(issue)
    workflows.push(buildIssueWorkflow({
      id: issue.id,
      projectId: issue.projectId,
      title: issue.title,
      description: issue.description,
      createdBy: "family-local",
      now: timestamp
    }))
    issueLinks.push({ itemId: reviewed.itemId, issueId })
  }
  const application: ImageObservationApplication = {
    id: id("image_observation_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    imageRefs: input.imageRefs.map(image => ({ ...image })),
    originalResult: {
      images: input.originalResult.images.map(image => ({
        ...image,
        qualityLimitations: [...image.qualityLimitations]
      })),
      items: input.originalResult.items.map(item => ({
        ...item,
        region: item.region ? { ...item.region } : undefined,
        limitations: [...item.limitations],
        captureSuggestions: [...item.captureSuggestions],
        knowledgeIds: [...item.knowledgeIds]
      }))
    },
    review: {
      items: input.review.items.map(item => ({
        ...item,
        limitations: [...item.limitations],
        captureSuggestions: [...item.captureSuggestions]
      }))
    },
    issueLinks,
    appliedBy: project.ownerName,
    appliedAt: timestamp
  }
  saveState({
    ...state,
    issues: [...issues, ...state.issues],
    issueWorkflows: [...workflows, ...state.issueWorkflows],
    imageObservationApplications: [application, ...state.imageObservationApplications]
  })
  return application
}

function validateRectificationHumanReview(
  original: RectificationResult,
  review: RectificationHumanReview
): void {
  if (original.mode !== review.mode) throw new Error("整改辅助模式与人工复核不一致")
  if (original.mode === "proposal" && review.mode === "proposal") {
    const originalIds = new Set(original.proposals.map(item => item.optionId))
    if (review.items.length !== originalIds.size) throw new Error("整改预案复核条目不完整")
    const seen = new Set<string>()
    for (const item of review.items) {
      if (!originalIds.has(item.optionId) || seen.has(item.optionId)
        || (item.included && (!item.title.trim() || !item.content.trim()))) {
        throw new Error("整改预案复核条目不正确")
      }
      seen.add(item.optionId)
    }
    if (!review.items.some(item => item.included) && !review.note.trim()) {
      throw new Error("请至少保留一个预案或填写仅留档说明")
    }
    return
  }
  if (original.mode === "review" && review.mode === "review") {
    const originalIds = new Set(original.checks.map(item => item.checkId))
    if (review.items.length !== originalIds.size) throw new Error("复查参考复核条目不完整")
    const seen = new Set<string>()
    for (const item of review.items) {
      if (!originalIds.has(item.checkId) || seen.has(item.checkId)
        || (item.included && (!item.requirement.trim() || !item.observation.trim()))
        || (item.included && item.status === "not_verifiable" && !item.limitations.length)) {
        throw new Error("复查参考复核条目不正确")
      }
      seen.add(item.checkId)
    }
    if (!review.items.some(item => item.included) && !review.note.trim()) {
      throw new Error("请至少保留一条复查参考或填写仅留档说明")
    }
    return
  }
  throw new Error("整改辅助模式与人工复核不一致")
}

export function applyRectification(input: {
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: RectificationResult
  review: RectificationHumanReview
  target: { issueId: string; expectedVersion: number }
}): RectificationApplication {
  const state = loadState()
  const existing = state.rectificationApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) {
    if (existing.targetIssueId !== input.target.issueId) {
      throw new Error("同一 AI 任务不能写入另一问题事项")
    }
    return existing
  }
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 整改辅助任务标识或版本不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  validateImageReferences(state, project.id, input.imageRefs)
  validateRectificationHumanReview(input.originalResult, input.review)
  const issue = state.issueWorkflows.find(item =>
    item.id === input.target.issueId && item.projectId === project.id)
  if (!issue) throw new Error("待处理问题不存在")
  if (issue.version !== input.target.expectedVersion) {
    throw new Error("问题事项已更新，请基于最新版本重新分析")
  }
  if (input.originalResult.issueSourceId !== issue.id) {
    throw new Error("整改辅助结果与目标问题不一致")
  }
  const timestamp = now()
  let nextIssue = issue
  const proposalLinks: Array<{ optionId: string; proposalId: string }> = []
  if (input.originalResult.mode === "proposal" && input.review.mode === "proposal") {
    for (const item of input.review.items.filter(candidate => candidate.included)) {
      const proposalId = id("proposal")
      nextIssue = addIssueProposal(nextIssue, {
        id: proposalId,
        content: item.content.trim(),
        expectedVersion: nextIssue.version,
        submittedBy: `${project.ownerName}（AI 草稿，人工复核）`,
        now: timestamp
      })
      proposalLinks.push({ optionId: item.optionId, proposalId })
    }
  } else if (input.originalResult.mode === "review" && input.review.mode === "review") {
    const latestTreatment = issue.treatments.at(-1)
    if (issue.status !== "pending_review" || !latestTreatment
      || latestTreatment.id !== input.originalResult.treatmentId) {
      throw new Error("问题处理结果已变化，请基于最新提交重新分析")
    }
  }
  const application: RectificationApplication = {
    id: id("rectification_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    mode: input.originalResult.mode,
    targetIssueId: issue.id,
    targetIssueVersionBefore: issue.version,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    imageRefs: input.imageRefs.map(image => ({ ...image })),
    originalResult: cloneAiValue(input.originalResult),
    review: cloneAiValue(input.review),
    proposalLinks,
    appliedBy: project.ownerName,
    appliedAt: timestamp
  }
  saveState({
    ...state,
    issueWorkflows: state.issueWorkflows.map(item => item.id === nextIssue.id ? nextIssue : item),
    issues: state.issues.map(item => item.id === nextIssue.id
      ? { ...item, status: nextIssue.status, updatedAt: nextIssue.updatedAt }
      : item),
    rectificationApplications: [application, ...state.rectificationApplications]
  })
  return application
}

function includedReviewText(
  lines: Array<{ sourceIndex: number; included: boolean; text: string }>,
  prefix = ""
): string[] {
  return lines.filter(item => item.included)
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map(item => `${prefix}${item.text.trim()}`)
}

function validateConsultationHumanReview(
  original: ConsultationResult,
  review: ConsultationHumanReview,
  issueIds: Set<string>
): void {
  if (original.mode !== review.mode) throw new Error("咨询整理模式与人工复核不一致")
  if (original.mode === "prepare" && review.mode === "prepare") {
    if (!review.title.trim() || !review.purpose.trim() || !review.questions.some(item => item.included)) {
      throw new Error("咨询草稿必须包含标题、目的和至少一个问题")
    }
    const verify = (lines: typeof review.facts, length: number) => {
      if (lines.length !== length || new Set(lines.map(item => item.sourceIndex)).size !== length
        || lines.some(item => item.sourceIndex < 0 || item.sourceIndex >= length
          || (item.included && !item.text.trim()))) {
        throw new Error("咨询草稿复核条目不正确")
      }
    }
    verify(review.facts, original.facts.length)
    verify(review.timeline, original.timeline.length)
    verify(review.disputes, original.disputes.length)
    verify(review.questions, original.questions.length)
    return
  }
  if (original.mode === "response" && review.mode === "response") {
    const originalIds = new Set(original.mappings.map(item => item.mappingId))
    if (review.mappings.length !== originalIds.size) throw new Error("咨询回复复核条目不完整")
    const seen = new Set<string>()
    for (const mapping of review.mappings) {
      if (!originalIds.has(mapping.mappingId) || seen.has(mapping.mappingId)
        || (mapping.targetIssueSourceId && !issueIds.has(mapping.targetIssueSourceId))
        || (mapping.disposition === "proposal"
          && (!mapping.targetIssueSourceId || !mapping.proposalContent.trim()))) {
        throw new Error("咨询回复复核条目或目标问题不正确")
      }
      seen.add(mapping.mappingId)
    }
    if (!review.mappings.some(item => item.disposition !== "ignored") && !review.note.trim()) {
      throw new Error("请至少保留一条回复整理或填写仅留档说明")
    }
    return
  }
  throw new Error("咨询整理模式与人工复核不一致")
}

export function applyConsultation(input: {
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  imageRefs: AiImageReference[]
  originalResult: ConsultationResult
  review: ConsultationHumanReview
  target?: { consultationId: string; expectedVersion: number }
}): { application: ConsultationApplication; consultation?: Consultation } {
  const state = loadState()
  const existing = state.consultationApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) {
    const consultation = existing.createdConsultationId
      ? state.consultations.find(item => item.id === existing.createdConsultationId)
      : undefined
    return { application: existing, consultation }
  }
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 咨询整理任务标识或版本不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  validateImageReferences(state, project.id, input.imageRefs)
  const issueIds = new Set(input.sourceSnapshots
    .filter(item => item.kind === "issue")
    .map(item => item.sourceId))
  validateConsultationHumanReview(input.originalResult, input.review, issueIds)
  const timestamp = now()
  let createdConsultation: Consultation | undefined
  const proposalLinks: Array<{
    mappingId: string
    proposalId: string
    issueId: string
    responseIds: string[]
  }> = []
  let issueWorkflows = state.issueWorkflows
  if (input.originalResult.mode === "prepare" && input.review.mode === "prepare") {
    const recordIds = input.sourceSnapshots
      .filter(item => item.kind === "record")
      .map(item => item.sourceId)
    const selectedIssueIds = [...issueIds]
    validateConsultationResources(state, project.id, recordIds, selectedIssueIds)
    const consultationId = id("consultation")
    const version = buildConsultationVersion({
      consultationId,
      revision: 1,
      question: input.review.purpose,
      knownFacts: [
        ...includedReviewText(input.review.facts),
        ...includedReviewText(input.review.timeline, "时间线："),
        ...includedReviewText(input.review.disputes, "争议："),
        ...(input.review.note.trim() ? [`人工说明：${input.review.note.trim()}`] : [])
      ],
      gaps: input.review.gaps,
      answerQuestions: includedReviewText(input.review.questions),
      recordIds,
      issueIds: selectedIssueIds,
      createdAt: timestamp
    })
    createdConsultation = {
      id: consultationId,
      projectId: project.id,
      title: input.review.title.trim(),
      status: "draft",
      version: 1,
      draftVersionId: version.id,
      versions: [version],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  } else if (input.originalResult.mode === "response" && input.review.mode === "response") {
    if (!input.target) throw new Error("整理回复缺少目标咨询")
    const consultation = state.consultations.find(item =>
      item.id === input.target!.consultationId && item.projectId === project.id)
    if (!consultation || consultation.version !== input.target.expectedVersion
      || consultation.id !== input.originalResult.consultationSourceId) {
      throw new Error("咨询已更新，请基于最新版本重新整理回复")
    }
    const workflowMap = new Map(issueWorkflows.map(item => [item.id, item]))
    for (const mapping of input.review.mappings.filter(item => item.disposition === "proposal")) {
      const workflow = workflowMap.get(mapping.targetIssueSourceId)
      if (!workflow || workflow.projectId !== project.id) throw new Error("目标问题不存在")
      const originalMapping = input.originalResult.mappings.find(item =>
        item.mappingId === mapping.mappingId)
      if (!originalMapping) throw new Error("咨询回复映射不存在")
      const mappedResponses = originalMapping.responseSourceIds.map(responseId =>
        state.consultationResponses.find(item =>
          item.id === responseId
          && item.projectId === project.id
          && item.consultationId === consultation.id))
      if (mappedResponses.some(response => !response || response.status !== "pending")) {
        throw new Error("咨询回复已经处理，请基于最新状态重新整理")
      }
      const proposalId = id("proposal")
      const next = addIssueProposal(workflow, {
        id: proposalId,
        content: mapping.proposalContent.trim(),
        expectedVersion: workflow.version,
        submittedBy: `${project.ownerName}（AI 整理咨询回复，人工复核）`,
        now: timestamp
      })
      workflowMap.set(next.id, next)
      proposalLinks.push({
        mappingId: mapping.mappingId,
        proposalId,
        issueId: next.id,
        responseIds: [...originalMapping.responseSourceIds]
      })
    }
    issueWorkflows = issueWorkflows.map(item => workflowMap.get(item.id) || item)
  }
  const application: ConsultationApplication = {
    id: id("consultation_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    mode: input.originalResult.mode,
    targetConsultationId: input.target?.consultationId,
    targetConsultationVersionBefore: input.target?.expectedVersion,
    createdConsultationId: createdConsultation?.id,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    imageRefs: input.imageRefs.map(image => ({ ...image })),
    originalResult: cloneAiValue(input.originalResult),
    review: cloneAiValue(input.review),
    proposalLinks,
    appliedBy: project.ownerName,
    appliedAt: timestamp
  }
  const changedIssueIds = new Set(proposalLinks.map(item => item.issueId))
  const convertedResponseLinks = new Map<string, string>()
  for (const link of proposalLinks) {
    for (const responseId of link.responseIds) {
      if (!convertedResponseLinks.has(responseId)) {
        convertedResponseLinks.set(responseId, link.proposalId)
      }
    }
  }
  saveState({
    ...state,
    consultations: createdConsultation
      ? [createdConsultation, ...state.consultations]
      : state.consultations,
    issueWorkflows,
    issues: state.issues.map(item => {
      if (!changedIssueIds.has(item.id)) return item
      const workflow = issueWorkflows.find(candidate => candidate.id === item.id)!
      return { ...item, status: workflow.status, updatedAt: workflow.updatedAt }
    }),
    consultationResponses: state.consultationResponses.map(item => {
      const proposalId = convertedResponseLinks.get(item.id)
      return proposalId
        ? {
          ...item,
          status: "converted_to_proposal" as const,
          proposalId,
          decisionReason: "负责人采纳 AI 整理结果并转为待选预案",
          decidedAt: timestamp
        }
        : item
    }),
    consultationApplications: [application, ...state.consultationApplications]
  })
  return { application, consultation: createdConsultation }
}

export function applyBudgetEstimate(input: {
  projectId: string
  aiJobId: string
  model: string
  promptVersion: string
  contractVersion: string
  summary: string
  sourceSnapshots: AiSourceSnapshotReference[]
  originalResult: BudgetResult
  review: BudgetHumanReview
}): BudgetEstimateApplication {
  const state = loadState()
  const existing = state.budgetEstimateApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) return existing
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 预算任务标识或版本不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  if (input.review.scenarios.length !== input.originalResult.scenarios.length) {
    throw new Error("预算参数复核条目不完整")
  }
  const originalIds = new Set(input.originalResult.scenarios.map(item => item.scenarioId))
  const reviewedIds = new Set(input.review.scenarios.map(item => item.scenarioId))
  if (reviewedIds.size !== originalIds.size
    || [...reviewedIds].some(scenarioId => !originalIds.has(scenarioId))) {
    throw new Error("预算参数复核与原始方案不一致")
  }
  const selected = input.review.scenarios.filter(item => item.included)
  if (!selected.length) throw new Error("请至少选择一个完整方案")
  for (const scenario of input.review.scenarios) {
    const original = input.originalResult.scenarios.find(item =>
      item.scenarioId === scenario.scenarioId)!
    if (scenario.materialSourceId !== original.materialSourceId) {
      throw new Error("预算方案不能在复核时改绑其他材料")
    }
  }
  const scenarios = selected.map(review =>
    calculateBudgetScenario(state, project.id, review))
  const selectedSourceIds = new Set(input.sourceSnapshots.map(item => item.sourceId))
  const application: BudgetEstimateApplication = {
    id: id("budget_estimate_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    originalResult: cloneAiValue(input.originalResult),
    review: cloneAiValue(input.review),
    scenarios,
    financeSnapshots: selectedFinanceSnapshots(state, project.id, selectedSourceIds),
    appliedBy: project.ownerName,
    appliedAt: now()
  }
  saveState({
    ...state,
    budgetEstimateApplications: [application, ...state.budgetEstimateApplications]
  })
  return application
}

export function applyProjectSummary(input: {
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
}): ProjectSummaryApplication {
  const state = loadState()
  const existing = state.projectSummaryApplications.find(item =>
    item.projectId === input.projectId && item.aiJobId === input.aiJobId)
  if (existing) return existing
  const project = assertProjectWritable(state, input.projectId)
  if (!input.aiJobId.trim() || !input.model.trim()
    || !input.promptVersion.trim() || !input.contractVersion.trim()) {
    throw new Error("AI 项目总结任务标识或版本不完整")
  }
  if (!input.scope.title.trim() || !input.scope.purpose.trim()
    || !input.scope.audience.trim() || !input.scope.stage.trim()
    || !input.scope.room.trim() || Number.isNaN(new Date(input.scope.cutoffAt).getTime())) {
    throw new Error("项目总结范围不完整")
  }
  validateAiSourceSnapshots(state, project, input.sourceSnapshots)
  const originalSectionKeys = new Set(input.originalResult.sections.map(item => item.key))
  const reviewedSectionKeys = new Set(input.review.sections.map(item => item.key))
  if (input.review.sections.length !== input.originalResult.sections.length
    || reviewedSectionKeys.size !== originalSectionKeys.size
    || [...reviewedSectionKeys].some(key => !originalSectionKeys.has(key))) {
    throw new Error("项目总结分区复核不完整")
  }
  if (!input.review.sections.some(item => item.included && item.content.trim())) {
    throw new Error("请至少保留一个项目总结分区")
  }
  const originalHandoffIds = new Set(input.originalResult.handoff.map(item => item.itemId))
  const reviewedHandoffIds = new Set(input.review.handoff.map(item => item.itemId))
  if (input.review.handoff.length !== input.originalResult.handoff.length
    || reviewedHandoffIds.size !== originalHandoffIds.size
    || [...reviewedHandoffIds].some(itemId => !originalHandoffIds.has(itemId))) {
    throw new Error("项目总结交接项复核不完整")
  }
  const selectedSourceIds = new Set(input.sourceSnapshots.map(item => item.sourceId))
  const issueSnapshots = state.issueWorkflows
    .filter(item => item.projectId === project.id && selectedSourceIds.has(item.id))
    .map(item => ({
      issueId: item.id,
      title: item.title,
      status: item.status,
      version: item.version
    }))
  const application: ProjectSummaryApplication = {
    id: id("project_summary_application"),
    projectId: project.id,
    aiJobId: input.aiJobId,
    model: input.model.trim(),
    promptVersion: input.promptVersion.trim(),
    contractVersion: input.contractVersion.trim(),
    summary: input.summary.trim(),
    scope: { ...input.scope },
    sourceSnapshots: cloneSourceSnapshots(input.sourceSnapshots),
    originalResult: cloneAiValue(input.originalResult),
    review: cloneAiValue(input.review),
    issueSnapshots,
    financeSnapshots: selectedFinanceSnapshots(state, project.id, selectedSourceIds),
    appliedBy: project.ownerName,
    appliedAt: now()
  }
  saveState({
    ...state,
    projectSummaryApplications: [application, ...state.projectSummaryApplications]
  })
  return application
}

export const makeId = id
