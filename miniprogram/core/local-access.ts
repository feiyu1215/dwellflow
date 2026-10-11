import type { AppState, MemberScope, ProjectMember } from "./domain"
import {
  evaluateAccess,
  filterAccessibleObjects,
  legacyGrant,
  type AccessDecision,
  type AccessRequest,
  type AccessSubject,
  type PermissionResource
} from "./access-policy"

export const LOCAL_OWNER_IDENTITY_ID = "owner-local"

const LOCAL_SCOPE_RESOURCE: Record<MemberScope, PermissionResource> = {
  records: "record",
  issues: "issue",
  materials: "material",
  expenses: "expense"
}

export interface LocalAccessIdentity {
  mode: "local_demo"
  identityId: string
  memberId?: string
}

export function localMemberIdentity(member: ProjectMember): LocalAccessIdentity {
  return {
    mode: "local_demo",
    identityId: `local-member:${member.id}`,
    memberId: member.id
  }
}

export function localOwnerIdentity(): LocalAccessIdentity {
  return { mode: "local_demo", identityId: LOCAL_OWNER_IDENTITY_ID }
}

export function buildLocalAccessSubject(
  state: AppState,
  identity: LocalAccessIdentity,
  projectId: string
): AccessSubject {
  const project = state.projects.find(item => item.id === projectId)
  if (!project) {
    return {
      mode: "local_demo",
      identityId: identity.identityId,
      projectId,
      projectStatus: "missing",
      membershipStatus: "missing",
      role: "visitor",
      isCurrentOwner: false,
      grants: []
    }
  }
  if (!identity.memberId && identity.identityId === LOCAL_OWNER_IDENTITY_ID) {
    return {
      mode: "local_demo",
      identityId: identity.identityId,
      projectId,
      projectStatus: project.status,
      membershipStatus: "active",
      role: "owner",
      isCurrentOwner: true,
      grants: []
    }
  }
  const member = identity.memberId
    ? state.members.find(item => item.id === identity.memberId && item.projectId === projectId)
    : undefined
  const validIdentity = member && identity.identityId === `local-member:${member.id}`
  return {
    mode: "local_demo",
    identityId: identity.identityId,
    projectId,
    projectStatus: project.status,
    membershipStatus: validIdentity ? member.status : "missing",
    role: validIdentity ? member.role : "visitor",
    isCurrentOwner: false,
    grants: validIdentity && member.status === "active"
      ? member.scopes.map(scope => legacyGrant({
        id: `legacy-local:${member.id}:${scope}`,
        resource: LOCAL_SCOPE_RESOURCE[scope]
      }))
      : []
  }
}

export function evaluateLocalAccess(
  state: AppState,
  identity: LocalAccessIdentity,
  request: AccessRequest
): AccessDecision {
  return evaluateAccess(buildLocalAccessSubject(state, identity, request.projectId), request)
}

export function filterLocalVisibleObjects<T>(input: {
  state: AppState
  identity: LocalAccessIdentity
  projectId: string
  resource: PermissionResource
  action: "read" | "list_metadata" | "search" | "read_thumbnail"
  items: readonly T[]
  projectIdOf: (item: T) => string
  objectIdOf: (item: T) => string
  spaceIdOf?: (item: T) => string | undefined
}): T[] {
  return filterAccessibleObjects({
    subject: buildLocalAccessSubject(input.state, input.identity, input.projectId),
    resource: input.resource,
    action: input.action,
    items: input.items,
    projectIdOf: input.projectIdOf,
    objectIdOf: input.objectIdOf,
    spaceIdOf: input.spaceIdOf
  })
}

