import type { Principal } from "./business-auth.ts"
import {
  evaluateAccess,
  legacyGrant,
  type AccessSubject,
  type PermissionAction,
  type PermissionResource
} from "../miniprogram/core/access-policy.ts"
import {
  type BusinessArea,
  type BusinessMembership,
  type BusinessProject,
  type BusinessRepositoryContract,
  type MemberScopes
} from "./business-repository.ts"
import { AppError } from "./validation.ts"

export const ALL_BUSINESS_AREAS: BusinessArea[] = [
  "records", "agreements", "materials", "issues", "expenses", "ai", "camera"
]

export function ownerScopes(): MemberScopes {
  return { areas: [...ALL_BUSINESS_AREAS] }
}

export interface ProjectAccess {
  project: BusinessProject
  membership: BusinessMembership
}

const AREA_RESOURCE: Record<BusinessArea, PermissionResource> = {
  records: "record",
  agreements: "agreement",
  materials: "material",
  issues: "issue",
  expenses: "expense",
  ai: "ai",
  camera: "camera"
}

function scopedIds(scopes: MemberScopes, area: BusinessArea): string[] | undefined {
  return area === "records" ? scopes.recordIds
    : area === "agreements" ? scopes.agreementIds
      : area === "materials" ? scopes.materialIds
        : area === "issues" ? scopes.issueIds
          : area === "expenses" ? scopes.expenseIds
            : undefined
}

export function businessAccessSubject(access: ProjectAccess): AccessSubject {
  const membership = access.membership
  return {
    mode: "connected",
    identityId: membership.userId,
    projectId: access.project.id,
    projectStatus: access.project.status,
    membershipStatus: membership.status,
    role: membership.role,
    isCurrentOwner: access.project.ownerId === membership.userId,
    grants: membership.scopes.areas.map(area => legacyGrant({
      id: `legacy-connected:${membership.userId}:${area}`,
      resource: AREA_RESOURCE[area],
      objectIds: scopedIds(membership.scopes, area)
    }))
  }
}

export function requireProjectAccess(
  repo: BusinessRepositoryContract,
  principal: Principal,
  projectId: string
): ProjectAccess {
  const project = repo.getProject(projectId)
  const membership = repo.getMembership(projectId, principal.id)
  if (!project || !membership || membership.status !== "active") {
    throw new AppError(404, "项目不存在或无权访问")
  }
  return { project, membership }
}

export function requireOwner(access: ProjectAccess): void {
  const subject = businessAccessSubject(access)
  if (!subject.isCurrentOwner || subject.role !== "owner" || subject.membershipStatus !== "active") {
    throw new AppError(403, "只有当前项目负责人可以执行此操作")
  }
}

export function requireArea(
  access: ProjectAccess,
  area: BusinessArea,
  resourceId?: string
): void {
  requireAreaAction(access, area, "read", resourceId)
}

export function requireAreaAction(
  access: ProjectAccess,
  area: BusinessArea,
  action: Extract<PermissionAction, "read" | "create_draft" | "submit_fact" | "update_own">,
  resourceId?: string
): void {
  const subject = businessAccessSubject(access)
  // BusinessService separately calls requireWritable after authorization so an
  // archived project keeps its existing 409 recovery response. Scope checks use
  // the active equivalent here and still run before any command is dispatched.
  const authorizationSubject = action === "read" || subject.projectStatus !== "archived"
    ? subject
    : { ...subject, projectStatus: "active" as const }
  const decision = evaluateAccess(authorizationSubject, {
    projectId: access.project.id,
    resource: AREA_RESOURCE[area],
    action,
    objectId: resourceId
  })
  if (!decision.allowed) {
    const objectDenied = decision.reason === "scope_not_granted"
    throw new AppError(403, objectDenied
      ? "当前身份没有该对象范围权限"
      : "当前身份没有该资料范围权限")
  }
}

export function requireWritable(access: ProjectAccess): void {
  if (access.project.status === "archived") {
    throw new AppError(409, "项目已归档，需由负责人重新打开后才能修改")
  }
}
