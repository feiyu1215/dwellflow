export type AccessMode = "local_demo" | "connected"
export type AccessProjectStatus = "active" | "archived" | "trashed" | "missing"
export type AccessMembershipStatus = "active" | "revoked" | "missing"
export type AccessRole = "owner" | "family" | "collaborator" | "visitor"

export type PermissionResource =
  | "project"
  | "space"
  | "record"
  | "evidence"
  | "issue"
  | "material"
  | "expense"
  | "agreement"
  | "consultation"
  | "ai"
  | "camera"
  | "export"
  | "member"
  | "project_settings"

export type PermissionAction =
  | "read"
  | "list_metadata"
  | "search"
  | "read_thumbnail"
  | "create_draft"
  | "submit_fact"
  | "update_own"
  | "manage"
  | "view_stream"
  | "capture_frame"
  | "export_data"
  | "approve_agreement"
  | "confirm_receipt"
  | "close_issue"
  | "confirm_payment"
  | "manage_grants"
  | "transfer_owner"
  | "reopen_project"
  | "trash_project"

export type PermissionScope =
  | { kind: "project" }
  | { kind: "objects"; objectIds: string[] }
  | { kind: "spaces"; spaceIds: string[]; objectIds: string[]; includesFutureObjects: boolean }
  | { kind: "snapshot"; snapshotId: string; objectIds: string[] }

export interface NormalizedPermissionGrant {
  id: string
  resource: PermissionResource
  actions: PermissionAction[]
  scope: PermissionScope
  status: "active" | "revoked"
  version: number
}

export interface AccessSubject {
  mode: AccessMode
  identityId: string
  projectId: string
  projectStatus: AccessProjectStatus
  membershipStatus: AccessMembershipStatus
  role: AccessRole
  isCurrentOwner: boolean
  grants: NormalizedPermissionGrant[]
}

export interface AccessRequest {
  projectId: string
  resource: PermissionResource
  action: PermissionAction
  objectId?: string
  spaceId?: string
  snapshotId?: string
}

export type AccessDenialReason =
  | "project_missing"
  | "project_trashed"
  | "membership_inactive"
  | "project_mismatch"
  | "project_archived"
  | "owner_required"
  | "resource_not_granted"
  | "action_not_granted"
  | "scope_not_granted"

export interface AccessDecision {
  allowed: boolean
  readonly: boolean
  disclosure: "visible" | "masked"
  requiresObjectFilter: boolean
  reason?: AccessDenialReason
  grantId?: string
}

export const OWNER_ONLY_ACTIONS = new Set<PermissionAction>([
  "approve_agreement",
  "confirm_receipt",
  "close_issue",
  "confirm_payment",
  "manage_grants",
  "transfer_owner",
  "reopen_project",
  "trash_project"
])

const READ_ACTIONS = new Set<PermissionAction>([
  "read", "list_metadata", "search", "read_thumbnail"
])

export const LEGACY_SCOPE_ACTIONS: PermissionAction[] = [
  "read",
  "list_metadata",
  "search",
  "read_thumbnail",
  "create_draft",
  "submit_fact",
  "update_own"
]

function denied(
  request: AccessRequest,
  reason: AccessDenialReason,
  readonly: boolean,
  disclosure?: "visible" | "masked"
): AccessDecision {
  return {
    allowed: false,
    readonly,
    disclosure: disclosure || (READ_ACTIONS.has(request.action) ? "masked" : "visible"),
    requiresObjectFilter: false,
    reason
  }
}

function scopeMatches(scope: PermissionScope, request: AccessRequest): {
  matches: boolean
  requiresObjectFilter: boolean
} {
  if (scope.kind === "project") return { matches: true, requiresObjectFilter: false }
  const permitsScopedEnumeration = request.action === "read"
    || request.action === "list_metadata"
    || request.action === "search"
  if (scope.kind === "snapshot") {
    if (!request.snapshotId || request.snapshotId !== scope.snapshotId) {
      return { matches: false, requiresObjectFilter: false }
    }
    if (!request.objectId) return {
      matches: permitsScopedEnumeration,
      requiresObjectFilter: permitsScopedEnumeration
    }
    return { matches: scope.objectIds.includes(request.objectId), requiresObjectFilter: false }
  }
  if (scope.kind === "objects") {
    if (!request.objectId) return {
      matches: permitsScopedEnumeration,
      requiresObjectFilter: permitsScopedEnumeration
    }
    return { matches: scope.objectIds.includes(request.objectId), requiresObjectFilter: false }
  }
  if (!request.spaceId) {
    const isEnumeration = permitsScopedEnumeration && !request.objectId
    return { matches: isEnumeration, requiresObjectFilter: isEnumeration }
  }
  if (!scope.spaceIds.includes(request.spaceId)) return { matches: false, requiresObjectFilter: false }
  if (scope.includesFutureObjects) return { matches: true, requiresObjectFilter: false }
  if (!request.objectId) return {
    matches: permitsScopedEnumeration,
    requiresObjectFilter: permitsScopedEnumeration
  }
  return { matches: scope.objectIds.includes(request.objectId), requiresObjectFilter: false }
}

export function evaluateAccess(subject: AccessSubject, request: AccessRequest): AccessDecision {
  if (subject.projectId !== request.projectId) {
    return denied(request, "project_mismatch", true)
  }
  if (subject.projectStatus === "missing") {
    return denied(request, "project_missing", true)
  }
  if (subject.projectStatus === "trashed") {
    return denied(request, "project_trashed", true)
  }
  if (subject.membershipStatus !== "active") {
    return denied(request, "membership_inactive", true)
  }

  const owner = subject.isCurrentOwner && subject.role === "owner"
  if (OWNER_ONLY_ACTIONS.has(request.action) && !owner) {
    return denied(request, "owner_required", subject.projectStatus !== "active")
  }
  if (subject.projectStatus === "archived") {
    const ownerCanReopen = owner && request.action === "reopen_project"
    if (!READ_ACTIONS.has(request.action) && !ownerCanReopen) {
      return denied(request, "project_archived", true)
    }
  }
  if (owner) {
    return {
      allowed: true,
      readonly: subject.projectStatus !== "active",
      disclosure: "visible",
      requiresObjectFilter: false
    }
  }

  if (request.resource === "project" && READ_ACTIONS.has(request.action)) {
    return {
      allowed: true,
      readonly: subject.projectStatus !== "active",
      disclosure: "visible",
      requiresObjectFilter: false
    }
  }

  const resourceGrants = subject.grants.filter(grant =>
    grant.status === "active" && grant.resource === request.resource)
  if (!resourceGrants.length) {
    return denied(request, "resource_not_granted", subject.projectStatus !== "active")
  }
  const actionGrants = resourceGrants.filter(grant => grant.actions.includes(request.action))
  if (!actionGrants.length) {
    return denied(request, "action_not_granted", subject.projectStatus !== "active")
  }
  for (const grant of actionGrants) {
    const match = scopeMatches(grant.scope, request)
    if (match.matches) {
      return {
        allowed: true,
        readonly: subject.projectStatus !== "active",
        disclosure: "visible",
        requiresObjectFilter: match.requiresObjectFilter,
        grantId: grant.id
      }
    }
  }
  return denied(request, "scope_not_granted", subject.projectStatus !== "active")
}

export function filterAccessibleObjects<T>(input: {
  subject: AccessSubject
  resource: PermissionResource
  action: "read" | "list_metadata" | "search" | "read_thumbnail"
  items: readonly T[]
  projectIdOf: (item: T) => string
  objectIdOf: (item: T) => string
  spaceIdOf?: (item: T) => string | undefined
}): T[] {
  return input.items.filter(item => evaluateAccess(input.subject, {
    projectId: input.projectIdOf(item),
    resource: input.resource,
    action: input.action,
    objectId: input.objectIdOf(item),
    spaceId: input.spaceIdOf?.(item)
  }).allowed)
}

export function legacyGrant(input: {
  id: string
  resource: PermissionResource
  objectIds?: string[]
}): NormalizedPermissionGrant {
  return {
    id: input.id,
    resource: input.resource,
    actions: [...LEGACY_SCOPE_ACTIONS],
    scope: input.objectIds ? { kind: "objects", objectIds: [...input.objectIds] } : { kind: "project" },
    status: "active",
    version: 1
  }
}
