import { isPatrolWorkStepId, type PatrolWorkStepId } from "./patrol-navigation"

export const PROJECT_VIEW_STATE_SCHEMA_VERSION = 1
export const ORIGIN_CONTEXT_SCHEMA_VERSION = 1

export type ProjectViewKind =
  | "overview"
  | "patrol"
  | "evidence"
  | "material"
  | "issue"
  | "attention"
  | "members"
  | "camera"
  | "ai"
  | "settings"

export type PatrolPresentation = "evidence" | "illustration"

export type NavigationObjectType =
  | "project"
  | "space"
  | "record"
  | "record_revision"
  | "evidence"
  | "issue"
  | "material"
  | "receipt_batch"
  | "agreement"
  | "cost_item"
  | "payment_fact"
  | "refund_fact"
  | "consultation"
  | "camera"
  | "ai_job"

export interface NavigationObjectRef {
  type: NavigationObjectType
  id: string
  version?: number
}

export interface ScrollAnchor {
  anchorId: string
  offsetPx: number
}

export interface DraftRef {
  type: "record" | "issue" | "material_check" | "consultation" | "ai_review"
  id: string
}

export type ViewFilterValue = string | number | boolean | string[]
export type ViewFilter = Record<string, ViewFilterValue>

export interface ProjectViewState {
  identityId: string
  projectId: string
  viewKind: ProjectViewKind
  spaceId?: string
  stageId?: string
  patrolStepId?: PatrolWorkStepId
  dateCursor?: string
  evidenceId?: string
  patrolPresentation?: PatrolPresentation
  objectRef?: NavigationObjectRef
  filter?: ViewFilter
  scrollAnchor?: ScrollAnchor
  draftRef?: DraftRef
  schemaVersion: typeof PROJECT_VIEW_STATE_SCHEMA_VERSION
  updatedAt: string
}

export interface OriginContext {
  projectId: string
  originView: ProjectViewKind
  spaceId?: string
  stageId?: string
  patrolStepId?: PatrolWorkStepId
  dateCursor?: string
  objectRef?: NavigationObjectRef
  evidenceId?: string
  anchorId?: string
  returnToken: string
  schemaVersion: typeof ORIGIN_CONTEXT_SCHEMA_VERSION
}

export type ProjectAccessState = "active" | "archived" | "unauthorized" | "missing"
export type ReferenceAccessState = "current" | "stale" | "unauthorized" | "missing"

export type ReferenceAccessResult =
  | { state: "current"; currentVersion?: number }
  | { state: "stale"; currentVersion: number }
  | { state: "unauthorized" }
  | { state: "missing" }

export interface ProjectNavigationResolver {
  projectAccess(identityId: string, projectId: string): ProjectAccessState
  spaceAccess(identityId: string, projectId: string, spaceId: string): Exclude<ReferenceAccessState, "stale">
  evidenceAccess(identityId: string, projectId: string, evidenceId: string): ReferenceAccessResult
  objectAccess(identityId: string, projectId: string, objectRef: NavigationObjectRef): ReferenceAccessResult
  stageExists(projectId: string, stageId: string): boolean
  draftExists(identityId: string, projectId: string, draftRef: DraftRef): boolean
}

export type RestoreReason =
  | "exact"
  | "no_saved_state"
  | "identity_or_project_mismatch"
  | "schema_incompatible"
  | "invalid_state"
  | "project_archived"
  | "project_unauthorized"
  | "project_missing"
  | "space_unavailable"
  | "object_unavailable"
  | "object_updated"
  | "evidence_unavailable"
  | "evidence_updated"
  | "stage_unavailable"
  | "draft_unavailable"

export interface RestoreDestination {
  destination: "project_entry" | "project"
  reason: RestoreReason
  readonly: boolean
  state?: ProjectViewState
}

const VIEW_KINDS = new Set<ProjectViewKind>([
  "overview",
  "patrol",
  "evidence",
  "material",
  "issue",
  "attention",
  "members",
  "camera",
  "ai",
  "settings"
])

const OBJECT_TYPES = new Set<NavigationObjectType>([
  "project",
  "space",
  "record",
  "record_revision",
  "evidence",
  "issue",
  "material",
  "receipt_batch",
  "agreement",
  "cost_item",
  "payment_fact",
  "refund_fact",
  "consultation",
  "camera",
  "ai_job"
])

const ALLOWED_FILTER_KEYS = new Set([
  "status",
  "sort",
  "query",
  "source",
  "mode",
  "dateFrom",
  "dateTo",
  "spaceIds",
  "stageIds",
  "categories",
  "showArchived"
])

const MAX_FILTER_BYTES = 2_048
const MAX_CONTEXT_BYTES = 4_096
const MAX_TEXT_LENGTH = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
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

function validObjectRef(value: unknown): value is NavigationObjectRef {
  if (!isRecord(value) || !OBJECT_TYPES.has(value.type as NavigationObjectType) || !nonEmptyText(value.id)) return false
  return value.version === undefined || (Number.isSafeInteger(value.version) && Number(value.version) > 0)
}

function validDraftRef(value: unknown): value is DraftRef {
  if (!isRecord(value) || !nonEmptyText(value.id)) return false
  return value.type === "record"
    || value.type === "issue"
    || value.type === "material_check"
    || value.type === "consultation"
    || value.type === "ai_review"
}

function validFilterValue(value: unknown): value is ViewFilterValue {
  if (typeof value === "string") return value.length <= MAX_TEXT_LENGTH
  if (typeof value === "boolean") return true
  if (typeof value === "number") return Number.isSafeInteger(value)
  return Array.isArray(value)
    && value.length <= 50
    && value.every(item => typeof item === "string" && item.length <= MAX_TEXT_LENGTH)
}

function filterErrors(value: unknown): string[] {
  if (value === undefined) return []
  if (!isRecord(value)) return ["filter 必须是普通对象"]
  const errors: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_FILTER_KEYS.has(key)) errors.push(`filter.${key} 不允许持久化`)
    else if (!validFilterValue(item)) errors.push(`filter.${key} 格式不正确`)
  }
  if (utf8ByteLength(JSON.stringify(value)) > MAX_FILTER_BYTES) errors.push("filter 超过大小限制")
  return errors
}

export function validateProjectViewState(value: unknown): string[] {
  if (!isRecord(value)) return ["ProjectViewState 不是对象"]
  const errors: string[] = []
  if (!nonEmptyText(value.identityId)) errors.push("identityId 缺失")
  if (!nonEmptyText(value.projectId)) errors.push("projectId 缺失")
  if (!VIEW_KINDS.has(value.viewKind as ProjectViewKind)) errors.push("viewKind 不受支持")
  if (value.schemaVersion !== PROJECT_VIEW_STATE_SCHEMA_VERSION) errors.push("schemaVersion 不兼容")
  if (!validTimestamp(value.updatedAt)) errors.push("updatedAt 不正确")
  for (const key of ["spaceId", "stageId", "dateCursor", "evidenceId"] as const) {
    if (value[key] !== undefined && !nonEmptyText(value[key])) errors.push(`${key} 不正确`)
  }
  if (value.patrolPresentation !== undefined
    && value.patrolPresentation !== "evidence"
    && value.patrolPresentation !== "illustration") {
    errors.push("patrolPresentation 不正确")
  }
  if (value.patrolStepId !== undefined && !isPatrolWorkStepId(value.patrolStepId)) {
    errors.push("patrolStepId 不正确")
  }
  if (value.dateCursor !== undefined && !validTimestamp(value.dateCursor)) errors.push("dateCursor 不正确")
  if (value.objectRef !== undefined && !validObjectRef(value.objectRef)) errors.push("objectRef 不正确")
  if (value.draftRef !== undefined && !validDraftRef(value.draftRef)) errors.push("draftRef 不正确")
  if (value.scrollAnchor !== undefined) {
    if (!isRecord(value.scrollAnchor)
      || !nonEmptyText(value.scrollAnchor.anchorId)
      || !Number.isSafeInteger(value.scrollAnchor.offsetPx)
      || Math.abs(Number(value.scrollAnchor.offsetPx)) > 100_000) {
      errors.push("scrollAnchor 不正确")
    }
  }
  errors.push(...filterErrors(value.filter))
  return errors
}

export function validateOriginContext(value: unknown): string[] {
  if (!isRecord(value)) return ["OriginContext 不是对象"]
  const errors: string[] = []
  if (!nonEmptyText(value.projectId)) errors.push("projectId 缺失")
  if (!VIEW_KINDS.has(value.originView as ProjectViewKind)) errors.push("originView 不受支持")
  if (!nonEmptyText(value.returnToken, 200)) errors.push("returnToken 缺失")
  if (value.schemaVersion !== ORIGIN_CONTEXT_SCHEMA_VERSION) errors.push("schemaVersion 不兼容")
  for (const key of ["spaceId", "stageId", "evidenceId", "anchorId"] as const) {
    if (value[key] !== undefined && !nonEmptyText(value[key])) errors.push(`${key} 不正确`)
  }
  if (value.patrolStepId !== undefined && !isPatrolWorkStepId(value.patrolStepId)) {
    errors.push("patrolStepId 不正确")
  }
  if (value.dateCursor !== undefined && !validTimestamp(value.dateCursor)) errors.push("dateCursor 不正确")
  if (value.objectRef !== undefined && !validObjectRef(value.objectRef)) errors.push("objectRef 不正确")
  return errors
}

export function projectViewStateKey(identityId: string, projectId: string): string {
  if (!nonEmptyText(identityId) || !nonEmptyText(projectId)) throw new Error("身份和项目不能为空")
  return `${encodeURIComponent(identityId)}::${encodeURIComponent(projectId)}`
}

function cloneProjectViewState(state: ProjectViewState): ProjectViewState {
  const filter = state.filter
    ? Object.fromEntries(Object.entries(state.filter).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value
    ])) as ViewFilter
    : undefined
  return {
    ...state,
    objectRef: state.objectRef ? { ...state.objectRef } : undefined,
    filter,
    scrollAnchor: state.scrollAnchor ? { ...state.scrollAnchor } : undefined,
    draftRef: state.draftRef ? { ...state.draftRef } : undefined
  }
}

export function findProjectViewState(
  states: readonly ProjectViewState[],
  identityId: string,
  projectId: string
): ProjectViewState | undefined {
  const key = projectViewStateKey(identityId, projectId)
  const found = states.find(item => projectViewStateKey(item.identityId, item.projectId) === key)
  return found ? cloneProjectViewState(found) : undefined
}

export function upsertProjectViewState(
  states: readonly ProjectViewState[],
  next: ProjectViewState
): ProjectViewState[] {
  const errors = validateProjectViewState(next)
  if (errors.length) throw new Error(errors.join("；"))
  const key = projectViewStateKey(next.identityId, next.projectId)
  const withoutCurrent = states.filter(item => projectViewStateKey(item.identityId, item.projectId) !== key)
  return [cloneProjectViewState(next), ...withoutCurrent]
}

function overviewState(identityId: string, projectId: string, updatedAt: string): ProjectViewState {
  return {
    identityId,
    projectId,
    viewKind: "overview",
    schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
    updatedAt
  }
}

function fallbackToSpace(state: ProjectViewState, reason: RestoreReason): RestoreDestination {
  return {
    destination: "project",
    reason,
    readonly: false,
    state: {
      identityId: state.identityId,
      projectId: state.projectId,
      viewKind: "patrol",
      spaceId: state.spaceId,
      stageId: state.stageId,
      patrolStepId: state.patrolStepId,
      dateCursor: state.dateCursor,
      patrolPresentation: state.patrolPresentation,
      scrollAnchor: state.scrollAnchor,
      schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
      updatedAt: state.updatedAt
    }
  }
}

function projectGate(
  identityId: string,
  projectId: string,
  resolver: ProjectNavigationResolver,
  updatedAt: string
): RestoreDestination | undefined {
  const access = resolver.projectAccess(identityId, projectId)
  if (access === "unauthorized") {
    return { destination: "project_entry", reason: "project_unauthorized", readonly: true }
  }
  if (access === "missing") {
    return { destination: "project_entry", reason: "project_missing", readonly: true }
  }
  if (access === "archived") {
    return {
      destination: "project",
      reason: "project_archived",
      readonly: true,
      state: overviewState(identityId, projectId, updatedAt)
    }
  }
  return undefined
}

export function restoreProjectViewState(input: {
  saved?: ProjectViewState
  identityId: string
  projectId: string
  resolver: ProjectNavigationResolver
  now: string
}): RestoreDestination {
  const gate = projectGate(input.identityId, input.projectId, input.resolver, input.now)
  if (gate) return gate
  if (!input.saved) {
    return {
      destination: "project",
      reason: "no_saved_state",
      readonly: false,
      state: overviewState(input.identityId, input.projectId, input.now)
    }
  }
  if (input.saved.identityId !== input.identityId || input.saved.projectId !== input.projectId) {
    return {
      destination: "project",
      reason: "identity_or_project_mismatch",
      readonly: false,
      state: overviewState(input.identityId, input.projectId, input.now)
    }
  }
  if (input.saved.schemaVersion !== PROJECT_VIEW_STATE_SCHEMA_VERSION) {
    return {
      destination: "project",
      reason: "schema_incompatible",
      readonly: false,
      state: overviewState(input.identityId, input.projectId, input.now)
    }
  }
  if (validateProjectViewState(input.saved).length) {
    return {
      destination: "project",
      reason: "invalid_state",
      readonly: false,
      state: overviewState(input.identityId, input.projectId, input.now)
    }
  }

  let next: ProjectViewState = { ...input.saved }
  let reason: RestoreReason = "exact"
  if (next.spaceId) {
    const access = input.resolver.spaceAccess(input.identityId, input.projectId, next.spaceId)
    if (access !== "current") {
      return {
        destination: "project",
        reason: "space_unavailable",
        readonly: false,
        state: overviewState(input.identityId, input.projectId, input.now)
      }
    }
  }
  if (next.stageId && !input.resolver.stageExists(input.projectId, next.stageId)) {
    next = { ...next, stageId: undefined }
    reason = "stage_unavailable"
  }
  if (next.objectRef) {
    const access = input.resolver.objectAccess(input.identityId, input.projectId, next.objectRef)
    if (access.state === "unauthorized" || access.state === "missing") {
      if (next.spaceId) return fallbackToSpace(next, "object_unavailable")
      return {
        destination: "project",
        reason: "object_unavailable",
        readonly: false,
        state: overviewState(input.identityId, input.projectId, input.now)
      }
    }
    if (access.state === "stale") {
      next = {
        ...next,
        objectRef: {
          ...next.objectRef,
          version: access.currentVersion
        },
        updatedAt: input.now
      }
      reason = "object_updated"
    }
  }
  if (next.evidenceId) {
    const access = input.resolver.evidenceAccess(input.identityId, input.projectId, next.evidenceId)
    if (access.state === "unauthorized" || access.state === "missing") {
      if (next.spaceId) return fallbackToSpace(next, "evidence_unavailable")
      return {
        destination: "project",
        reason: "evidence_unavailable",
        readonly: false,
        state: overviewState(input.identityId, input.projectId, input.now)
      }
    }
    if (access.state === "stale") reason = "evidence_updated"
  }
  if (next.draftRef && !input.resolver.draftExists(
    input.identityId,
    input.projectId,
    next.draftRef
  )) {
    next = { ...next, draftRef: undefined, updatedAt: input.now }
    reason = "draft_unavailable"
  }
  return { destination: "project", reason, readonly: false, state: next }
}

export function serializeOriginContext(context: OriginContext): string {
  const errors = validateOriginContext(context)
  if (errors.length) throw new Error(errors.join("；"))
  const raw = JSON.stringify(context)
  if (utf8ByteLength(raw) > MAX_CONTEXT_BYTES) throw new Error("OriginContext 超过大小限制")
  return encodeURIComponent(raw)
}

export function parseOriginContext(raw: string): OriginContext | undefined {
  if (!raw || raw.length > MAX_CONTEXT_BYTES * 3) return undefined
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as unknown
    return validateOriginContext(value).length ? undefined : value as OriginContext
  } catch {
    return undefined
  }
}

export function restoreOriginContext(input: {
  context?: OriginContext
  identityId: string
  resolver: ProjectNavigationResolver
  now: string
}): RestoreDestination {
  if (!input.context) {
    return { destination: "project_entry", reason: "invalid_state", readonly: true }
  }
  const context = input.context
  const gate = projectGate(input.identityId, context.projectId, input.resolver, input.now)
  if (gate) return gate
  if (context.schemaVersion !== ORIGIN_CONTEXT_SCHEMA_VERSION || validateOriginContext(context).length) {
    return {
      destination: "project",
      reason: "schema_incompatible",
      readonly: false,
      state: overviewState(input.identityId, context.projectId, input.now)
    }
  }
  const saved: ProjectViewState = {
    identityId: input.identityId,
    projectId: context.projectId,
    viewKind: context.originView,
    spaceId: context.spaceId,
    stageId: context.stageId,
    patrolStepId: context.patrolStepId,
    dateCursor: context.dateCursor,
    evidenceId: context.evidenceId,
    objectRef: context.objectRef,
    scrollAnchor: context.anchorId ? { anchorId: context.anchorId, offsetPx: 0 } : undefined,
    schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
    updatedAt: input.now
  }
  return restoreProjectViewState({
    saved,
    identityId: input.identityId,
    projectId: context.projectId,
    resolver: input.resolver,
    now: input.now
  })
}
