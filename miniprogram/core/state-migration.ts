import type { AppState } from "./domain"

export const LEGACY_STATE_STORAGE_KEY = "renovation-sync-state-v1"
export const V2_STATE_STORAGE_KEY = "renovation-sync-state-v2"
export const ACTIVE_STATE_SCHEMA_KEY = "renovation-sync-active-state-schema"
export const R8_MIGRATION_JOURNAL_KEY = "renovation-sync-migration-r8-v1-to-v2"
export const PRE_R8_EXPORT_REGISTRATION_KEY = "renovation-sync-pre-r8-export"

export type ActiveStateSchema = "v1" | "v2"
export type StateReadStatus = "ready" | "empty" | "blocked"

export interface StateStorageReader {
  getStorageSync<T>(key: string): T
}

export interface StateStorageWriter extends StateStorageReader {
  setStorageSync(key: string, value: unknown): void
  getStorageInfoSync?(): { currentSize?: number; limitSize?: number }
}

export type MigrationStep = "discovered" | "transformed" | "written" | "validated" | "switched" | "failed"

export interface R8MigrationJournal {
  status: MigrationStep
  lastCompletedStep: Exclude<MigrationStep, "failed">
  sourceFingerprint: string
  migrationId: string
  collectionCounts: Record<string, number>
  legacyIdMap: Record<string, unknown>
  warnings: string[]
  error?: string
  updatedAt: string
}

export interface PreR8ExportRegistration {
  sourceKey: typeof LEGACY_STATE_STORAGE_KEY
  sourceFingerprint: string
  estimatedSourceBytes: number
  registeredAt: string
}

export interface R8MigrationResult {
  status: "migrated" | "already_v2" | "blocked"
  activeSchema: ActiveStateSchema
  migrationId?: string
  errors: string[]
}

export interface LocalStateV2Envelope<TState = AppState> {
  schema: "renovation-sync-local-v2"
  schemaVersion: 2
  migrationId: string
  migratedFrom: typeof LEGACY_STATE_STORAGE_KEY | "fresh-v2"
  sourceFingerprint: string
  migratedAt: string
  validatedAt: string
  state: TState
}

export interface ActiveStateSelection {
  requestedSchema: ActiveStateSchema
  effectiveSchema?: ActiveStateSchema
  sourceKey: string
  status: StateReadStatus
  value?: unknown
  errors: string[]
}

export type MigrationFindingCode =
  | "invalid_state"
  | "missing_collection"
  | "cross_project_reference"
  | "missing_original"
  | "legacy_member_scope"
  | "ambiguous_room_label"

export interface MigrationFinding {
  code: MigrationFindingCode
  path: string
  message: string
  blocking: boolean
}

export interface SpaceCandidate {
  projectId: string
  normalizedName: string
  sourceLabels: string[]
  occurrenceCount: number
  kind: "whole_project" | "custom"
  participatesInTopology: boolean
}

export interface MigrationDryRunReport {
  sourceSchema: ActiveStateSchema
  status: "ready" | "blocked" | "empty" | "already_v2"
  sourceKey: string
  sourceFingerprint?: string
  migrationIdCandidate?: string
  estimatedSourceBytes: number
  collectionCounts: Record<string, number>
  spaceCandidates: SpaceCandidate[]
  findings: MigrationFinding[]
  canWriteCandidate: boolean
}

const APP_STATE_COLLECTION_KEYS = [
  "projects",
  "projectLifecycleEvents",
  "spaces",
  "spaceRelations",
  "spaceStageStates",
  "legacyRoomMappings",
  "evidenceAssets",
  "evidenceLinks",
  "records",
  "recordRevisions",
  "issues",
  "issueWorkflows",
  "materials",
  "inventory",
  "expenses",
  "agreements",
  "purchaseLines",
  "receiptBatches",
  "unitConversions",
  "materialInventoryEvents",
  "materialUsageRecords",
  "costItems",
  "costApprovals",
  "paymentFacts",
  "refundFacts",
  "members",
  "shares",
  "consultations",
  "consultationResponses",
  "cameras",
  "analyses",
  "materialChecks",
  "recordReviewApplications",
  "imageObservationApplications",
  "rectificationApplications",
  "consultationApplications",
  "budgetEstimateApplications",
  "projectSummaryApplications"
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function utf8ByteLength(value: string): number {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) length += 1
    else if (code < 0x800) length += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4
        index += 1
      } else length += 3
    } else length += 3
  }
  return length
}

export function stateSourceFingerprint(value: unknown): string {
  return fnv1a32(canonicalJson(value))
}

export function validateLocalStateV2Envelope(value: unknown): string[] {
  if (!isRecord(value)) return ["v2 状态不是对象"]
  const errors: string[] = []
  if (value.schema !== "renovation-sync-local-v2") errors.push("v2 schema 不正确")
  if (value.schemaVersion !== 2) errors.push("v2 schemaVersion 不受支持")
  if (typeof value.migrationId !== "string" || !value.migrationId.trim()) errors.push("v2 migrationId 缺失")
  if (value.migratedFrom !== LEGACY_STATE_STORAGE_KEY && value.migratedFrom !== "fresh-v2") {
    errors.push("v2 migratedFrom 不正确")
  }
  if (typeof value.sourceFingerprint !== "string" || !value.sourceFingerprint.startsWith("fnv1a32:")) {
    errors.push("v2 sourceFingerprint 不正确")
  }
  if (!validTimestamp(value.migratedAt)) errors.push("v2 migratedAt 不正确")
  if (!validTimestamp(value.validatedAt)) errors.push("v2 validatedAt 不正确")
  if (!isRecord(value.state) || !Array.isArray(value.state.projects)) errors.push("v2 state.projects 缺失")
  return errors
}

export function createLocalStateV2Envelope<TState>(input: {
  state: TState
  migrationId: string
  migratedFrom: typeof LEGACY_STATE_STORAGE_KEY | "fresh-v2"
  sourceFingerprint: string
  migratedAt: string
  validatedAt: string
}): LocalStateV2Envelope<TState> {
  const envelope: LocalStateV2Envelope<TState> = {
    schema: "renovation-sync-local-v2",
    schemaVersion: 2,
    ...input
  }
  const errors = validateLocalStateV2Envelope(envelope)
  if (errors.length) throw new Error(errors.join("；"))
  return envelope
}

export function readActiveStateSelection(storage: StateStorageReader = wx): ActiveStateSelection {
  const storedPointer = storage.getStorageSync<unknown>(ACTIVE_STATE_SCHEMA_KEY)
  const requestedSchema: ActiveStateSchema = storedPointer === undefined || storedPointer === ""
    ? "v1"
    : storedPointer === "v1" || storedPointer === "v2"
      ? storedPointer
      : "v1"

  if (storedPointer !== undefined && storedPointer !== "" && storedPointer !== "v1" && storedPointer !== "v2") {
    return {
      requestedSchema,
      sourceKey: ACTIVE_STATE_SCHEMA_KEY,
      status: "blocked",
      errors: ["活动 schema 指针无效，已阻止自动回退"]
    }
  }

  const sourceKey = requestedSchema === "v2" ? V2_STATE_STORAGE_KEY : LEGACY_STATE_STORAGE_KEY
  const value = storage.getStorageSync<unknown>(sourceKey)
  if (value === undefined || value === null || value === "") {
    if (requestedSchema === "v2") {
      return {
        requestedSchema,
        sourceKey,
        status: "blocked",
        errors: ["活动 schema 指向 v2，但 v2 状态缺失，已阻止空数据覆盖"]
      }
    }
    return { requestedSchema, sourceKey, status: "empty", errors: [] }
  }
  if (requestedSchema === "v2") {
    const errors = validateLocalStateV2Envelope(value)
    if (errors.length) return { requestedSchema, sourceKey, status: "blocked", value, errors }
  } else if (!isRecord(value) || !Array.isArray(value.projects)) {
    return {
      requestedSchema,
      sourceKey,
      status: "blocked",
      value,
      errors: ["v1 状态格式不正确，已阻止空数据覆盖"]
    }
  }
  return { requestedSchema, effectiveSchema: requestedSchema, sourceKey, status: "ready", value, errors: [] }
}

function collection(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : []
}

function projectIdOf(value: unknown): string {
  return isRecord(value) && typeof value.projectId === "string" ? value.projectId : ""
}

function roomOf(value: unknown): string {
  return isRecord(value) && typeof value.room === "string" ? value.room.trim() : ""
}

function addSpaceCandidate(
  candidates: Map<string, { projectId: string; normalizedName: string; labels: Set<string>; count: number }>,
  projectId: string,
  rawLabel: string
): void {
  const normalizedName = rawLabel.trim()
  if (!projectId || !normalizedName) return
  const key = `${projectId}\u0000${normalizedName}`
  const existing = candidates.get(key)
  if (existing) {
    existing.labels.add(rawLabel)
    existing.count += 1
    return
  }
  candidates.set(key, {
    projectId,
    normalizedName,
    labels: new Set([rawLabel]),
    count: 1
  })
}

function inspectLegacyState(value: Record<string, unknown>, sourceKey: string): MigrationDryRunReport {
  const findings: MigrationFinding[] = []
  const collectionCounts: Record<string, number> = {}
  for (const key of APP_STATE_COLLECTION_KEYS) {
    if (!Array.isArray(value[key])) {
      findings.push({
        code: "missing_collection",
        path: key,
        message: `${key} 缺失；迁移时按空集合兼容，不覆盖其它事实`,
        blocking: false
      })
    }
    collectionCounts[key] = collection(value, key).length
  }

  const projects = collection(value, "projects")
  const projectIds = new Set(projects
    .filter(isRecord)
    .map(project => typeof project.id === "string" ? project.id : "")
    .filter(Boolean))
  for (const key of APP_STATE_COLLECTION_KEYS) {
    if (key === "projects" || key === "unitConversions") continue
    collection(value, key).forEach((item, index) => {
      const projectId = projectIdOf(item)
      if (projectId && !projectIds.has(projectId)) {
        findings.push({
          code: "cross_project_reference",
          path: `${key}[${index}].projectId`,
          message: `${key} 引用了不存在的项目 ${projectId}`,
          blocking: true
        })
      }
    })
  }

  const candidateMap = new Map<string, { projectId: string; normalizedName: string; labels: Set<string>; count: number }>()
  for (const key of ["records", "recordRevisions", "issues", "cameras"] as const) {
    collection(value, key).forEach(item => addSpaceCandidate(candidateMap, projectIdOf(item), roomOf(item)))
  }

  collection(value, "records").forEach((record, recordIndex) => {
    if (!isRecord(record) || !Array.isArray(record.attachments)) return
    record.attachments.forEach((attachment, attachmentIndex) => {
      if (!isRecord(attachment) || typeof attachment.localPath !== "string" || !attachment.localPath.trim()) {
        findings.push({
          code: "missing_original",
          path: `records[${recordIndex}].attachments[${attachmentIndex}]`,
          message: "附件没有可读取的本地路径；迁移时必须标为 missing",
          blocking: false
        })
      }
    })
  })

  collection(value, "members").forEach((member, index) => {
    if (isRecord(member) && Array.isArray(member.scopes) && member.scopes.length) {
      findings.push({
        code: "legacy_member_scope",
        path: `members[${index}].scopes`,
        message: "旧 scope 只能映射既有资源，不得扩展到证据、AI、监控或导出",
        blocking: false
      })
    }
  })

  const spaceCandidates = [...candidateMap.values()]
    .sort((left, right) => left.projectId.localeCompare(right.projectId)
      || left.normalizedName.localeCompare(right.normalizedName, "zh-CN"))
    .map(candidate => ({
      projectId: candidate.projectId,
      normalizedName: candidate.normalizedName,
      sourceLabels: [...candidate.labels].sort(),
      occurrenceCount: candidate.count,
      kind: candidate.normalizedName === "全屋" ? "whole_project" as const : "custom" as const,
      participatesInTopology: candidate.normalizedName !== "全屋"
    }))
  const canonical = canonicalJson(value)
  const sourceFingerprint = fnv1a32(canonical)
  const blocking = findings.some(finding => finding.blocking)
  return {
    sourceSchema: "v1",
    status: blocking ? "blocked" : "ready",
    sourceKey,
    sourceFingerprint,
    migrationIdCandidate: `r8_${sourceFingerprint.replace(":", "_")}`,
    estimatedSourceBytes: utf8ByteLength(canonical),
    collectionCounts,
    spaceCandidates,
    findings,
    canWriteCandidate: !blocking
  }
}

export function buildR8MigrationDryRun(storage: StateStorageReader = wx): MigrationDryRunReport {
  const selection = readActiveStateSelection(storage)
  if (selection.status === "empty") {
    return {
      sourceSchema: selection.requestedSchema,
      status: "empty",
      sourceKey: selection.sourceKey,
      estimatedSourceBytes: 0,
      collectionCounts: {},
      spaceCandidates: [],
      findings: [],
      canWriteCandidate: false
    }
  }
  if (selection.status === "blocked") {
    return {
      sourceSchema: selection.requestedSchema,
      status: "blocked",
      sourceKey: selection.sourceKey,
      estimatedSourceBytes: 0,
      collectionCounts: {},
      spaceCandidates: [],
      findings: selection.errors.map((message, index) => ({
        code: "invalid_state",
        path: index === 0 ? selection.sourceKey : `${selection.sourceKey}#${index}`,
        message,
        blocking: true
      })),
      canWriteCandidate: false
    }
  }
  if (selection.effectiveSchema === "v2") {
    const canonical = canonicalJson(selection.value)
    return {
      sourceSchema: "v2",
      status: "already_v2",
      sourceKey: selection.sourceKey,
      sourceFingerprint: fnv1a32(canonical),
      estimatedSourceBytes: utf8ByteLength(canonical),
      collectionCounts: {},
      spaceCandidates: [],
      findings: [],
      canWriteCandidate: false
    }
  }
  if (!isRecord(selection.value)) {
    throw new Error("活动 v1 状态在读取后失效")
  }
  return inspectLegacyState(selection.value, selection.sourceKey)
}

function writeJournal(storage: StateStorageWriter, journal: R8MigrationJournal): void {
  storage.setStorageSync(R8_MIGRATION_JOURNAL_KEY, journal)
}

function availableStorageBytes(storage: StateStorageWriter): number | undefined {
  const info = storage.getStorageInfoSync?.()
  if (!info || typeof info.limitSize !== "number" || typeof info.currentSize !== "number") return undefined
  return Math.max(0, (info.limitSize - info.currentSize) * 1024)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function candidateStateFingerprint(envelope: LocalStateV2Envelope): string {
  return stateSourceFingerprint(envelope.state)
}

export function executeR8StateMigration<TState = AppState>(input: {
  storage?: StateStorageWriter
  now?: () => string
  freshState: () => TState
  transformLegacyState?: (value: unknown) => TState
}): R8MigrationResult {
  const storage = input.storage || wx
  const timestamp = input.now || (() => new Date().toISOString())
  const selection = readActiveStateSelection(storage)
  if (selection.status === "blocked") {
    return { status: "blocked", activeSchema: selection.requestedSchema, errors: selection.errors }
  }
  if (selection.effectiveSchema === "v2") {
    const envelope = selection.value as LocalStateV2Envelope<TState>
    const existing = storage.getStorageSync<R8MigrationJournal | undefined>(R8_MIGRATION_JOURNAL_KEY)
    if (!existing || existing.status !== "switched") {
      writeJournal(storage, {
        status: "switched",
        lastCompletedStep: "switched",
        sourceFingerprint: envelope.sourceFingerprint,
        migrationId: envelope.migrationId,
        collectionCounts: existing?.collectionCounts || {},
        legacyIdMap: existing?.legacyIdMap || {},
        warnings: existing?.warnings || [],
        updatedAt: timestamp()
      })
    }
    return { status: "already_v2", activeSchema: "v2", migrationId: envelope.migrationId, errors: [] }
  }

  const dryRun = buildR8MigrationDryRun(storage)
  if (dryRun.status === "blocked") {
    return {
      status: "blocked",
      activeSchema: "v1",
      errors: dryRun.findings.filter(item => item.blocking).map(item => item.message)
    }
  }

  const sourceValue = selection.status === "empty" ? input.freshState() : selection.value
  const sourceFingerprint = dryRun.sourceFingerprint || stateSourceFingerprint(sourceValue)
  const migrationId = dryRun.migrationIdCandidate || `r8_${sourceFingerprint.replace(":", "_")}`
  const migratedFrom = selection.status === "empty" ? "fresh-v2" as const : LEGACY_STATE_STORAGE_KEY
  const warnings = dryRun.findings.filter(item => !item.blocking).map(item => item.message)
  let lastCompletedStep: R8MigrationJournal["lastCompletedStep"] = "discovered"
  const journalBase = {
    sourceFingerprint,
    migrationId,
    collectionCounts: dryRun.collectionCounts,
    legacyIdMap: {},
    warnings
  }

  try {
    writeJournal(storage, { ...journalBase, status: "discovered", lastCompletedStep, updatedAt: timestamp() })
    if (migratedFrom === LEGACY_STATE_STORAGE_KEY) {
      storage.setStorageSync(PRE_R8_EXPORT_REGISTRATION_KEY, {
        sourceKey: LEGACY_STATE_STORAGE_KEY,
        sourceFingerprint,
        estimatedSourceBytes: dryRun.estimatedSourceBytes,
        registeredAt: timestamp()
      } satisfies PreR8ExportRegistration)
    }

    const available = availableStorageBytes(storage)
    const estimatedCandidateBytes = Math.max(dryRun.estimatedSourceBytes, utf8ByteLength(canonicalJson(sourceValue))) + 16 * 1024
    if (available !== undefined && available < estimatedCandidateBytes) {
      throw new Error("本地存储空间不足，未写入 v2 候选或切换活动指针")
    }

    const transformed = selection.status === "empty"
      ? sourceValue as TState
      : input.transformLegacyState
        ? input.transformLegacyState(sourceValue)
        : sourceValue as TState
    lastCompletedStep = "transformed"
    writeJournal(storage, { ...journalBase, status: "transformed", lastCompletedStep, updatedAt: timestamp() })

    const migratedAt = timestamp()
    const envelope = createLocalStateV2Envelope({
      state: transformed,
      migrationId,
      migratedFrom,
      sourceFingerprint,
      migratedAt,
      validatedAt: migratedAt
    })
    const expectedStateFingerprint = stateSourceFingerprint(transformed)
    const existingCandidate = storage.getStorageSync<unknown>(V2_STATE_STORAGE_KEY)
    const reusableCandidate = validateLocalStateV2Envelope(existingCandidate).length === 0
      && (existingCandidate as LocalStateV2Envelope).migrationId === migrationId
      && (existingCandidate as LocalStateV2Envelope).sourceFingerprint === sourceFingerprint
      && candidateStateFingerprint(existingCandidate as LocalStateV2Envelope) === expectedStateFingerprint
    if (!reusableCandidate) storage.setStorageSync(V2_STATE_STORAGE_KEY, envelope)
    lastCompletedStep = "written"
    writeJournal(storage, { ...journalBase, status: "written", lastCompletedStep, updatedAt: timestamp() })

    const reread = storage.getStorageSync<unknown>(V2_STATE_STORAGE_KEY)
    const envelopeErrors = validateLocalStateV2Envelope(reread)
    if (envelopeErrors.length) throw new Error(`v2 二次读取校验失败：${envelopeErrors.join("；")}`)
    if (candidateStateFingerprint(reread as LocalStateV2Envelope) !== expectedStateFingerprint) {
      throw new Error("v2 二次读取内容与待迁移状态不一致")
    }
    lastCompletedStep = "validated"
    writeJournal(storage, { ...journalBase, status: "validated", lastCompletedStep, updatedAt: timestamp() })

    storage.setStorageSync(ACTIVE_STATE_SCHEMA_KEY, "v2")
    const active = readActiveStateSelection(storage)
    if (active.status !== "ready" || active.effectiveSchema !== "v2") {
      throw new Error("活动 schema 切换后复核失败")
    }
    lastCompletedStep = "switched"
    writeJournal(storage, { ...journalBase, status: "switched", lastCompletedStep, updatedAt: timestamp() })
    return { status: "migrated", activeSchema: "v2", migrationId, errors: [] }
  } catch (error) {
    const message = errorMessage(error)
    try {
      writeJournal(storage, {
        ...journalBase,
        status: "failed",
        lastCompletedStep,
        error: message,
        updatedAt: timestamp()
      })
    } catch {
      // 原错误优先；日志写入失败不能掩盖迁移失败。
    }
    const active = readActiveStateSelection(storage)
    return {
      status: "blocked",
      activeSchema: active.effectiveSchema || active.requestedSchema,
      migrationId,
      errors: [message]
    }
  }
}
