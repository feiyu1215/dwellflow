import {
  evaluateAccess,
  type AccessSubject,
  type PermissionResource
} from "./access-policy"
import type {
  DraftRef,
  NavigationObjectRef,
  ProjectAccessState,
  ProjectNavigationResolver,
  ReferenceAccessResult
} from "./project-navigation"

export interface NavigationResourceDescriptor {
  projectId: string
  resource: PermissionResource
  objectId: string
  version?: number
  spaceId?: string
  status?: "active" | "inactive"
}

export interface PolicyNavigationCatalog {
  subject(projectId: string): AccessSubject
  space(spaceId: string): NavigationResourceDescriptor | undefined
  evidence(evidenceId: string): NavigationResourceDescriptor | undefined
  object(ref: NavigationObjectRef): NavigationResourceDescriptor | undefined
  stageExists(projectId: string, stageId: string): boolean
  draftExists(identityId: string, projectId: string, draftRef: DraftRef): boolean
}

function descriptorAccess(
  identityId: string,
  projectId: string,
  descriptor: NavigationResourceDescriptor | undefined,
  subject: AccessSubject,
  expectedVersion?: number
): ReferenceAccessResult {
  if (!descriptor || descriptor.projectId !== projectId || descriptor.status === "inactive") {
    return { state: "missing" }
  }
  if (subject.identityId !== identityId) return { state: "unauthorized" }
  const decision = evaluateAccess(subject, {
    projectId,
    resource: descriptor.resource,
    action: "read",
    objectId: descriptor.objectId,
    spaceId: descriptor.spaceId
  })
  if (!decision.allowed) return { state: "unauthorized" }
  if (expectedVersion !== undefined && descriptor.version !== undefined
    && expectedVersion !== descriptor.version) {
    return { state: "stale", currentVersion: descriptor.version }
  }
  return { state: "current", currentVersion: descriptor.version }
}

export function createPolicyNavigationResolver(
  identityId: string,
  catalog: PolicyNavigationCatalog
): ProjectNavigationResolver {
  return {
    projectAccess(requestIdentityId, projectId): ProjectAccessState {
      const subject = catalog.subject(projectId)
      if (requestIdentityId !== identityId || subject.identityId !== identityId) return "unauthorized"
      if (subject.projectStatus === "missing") return "missing"
      if (subject.projectStatus === "trashed" || subject.membershipStatus !== "active") return "unauthorized"
      const decision = evaluateAccess(subject, { projectId, resource: "project", action: "read" })
      if (!decision.allowed) return "unauthorized"
      return subject.projectStatus === "archived" ? "archived" : "active"
    },
    spaceAccess(requestIdentityId, projectId, spaceId) {
      const result = descriptorAccess(
        requestIdentityId,
        projectId,
        catalog.space(spaceId),
        catalog.subject(projectId)
      )
      return result.state === "stale" ? "current" : result.state
    },
    evidenceAccess(requestIdentityId, projectId, evidenceId) {
      return descriptorAccess(
        requestIdentityId,
        projectId,
        catalog.evidence(evidenceId),
        catalog.subject(projectId)
      )
    },
    objectAccess(requestIdentityId, projectId, objectRef) {
      return descriptorAccess(
        requestIdentityId,
        projectId,
        catalog.object(objectRef),
        catalog.subject(projectId),
        objectRef.version
      )
    },
    stageExists(projectId, stageId) {
      return catalog.stageExists(projectId, stageId)
    },
    draftExists(requestIdentityId, projectId, draftRef) {
      if (requestIdentityId !== identityId) return false
      const subject = catalog.subject(projectId)
      const resource: PermissionResource = draftRef.type === "record" ? "record"
        : draftRef.type === "issue" ? "issue"
          : draftRef.type === "material_check" ? "material"
            : draftRef.type === "consultation" ? "consultation"
              : "ai"
      return evaluateAccess(subject, {
        projectId,
        resource,
        action: "create_draft",
        objectId: draftRef.id
      }).allowed && catalog.draftExists(identityId, projectId, draftRef)
    }
  }
}

