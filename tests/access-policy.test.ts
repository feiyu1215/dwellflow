import assert from "node:assert/strict"
import test from "node:test"
import {
  evaluateAccess,
  filterAccessibleObjects,
  legacyGrant,
  type AccessSubject,
  type NormalizedPermissionGrant
} from "../miniprogram/core/access-policy.ts"
import {
  buildLocalAccessSubject,
  localMemberIdentity,
  localOwnerIdentity
} from "../miniprogram/core/local-access.ts"
import {
  createPolicyNavigationResolver,
  type NavigationResourceDescriptor,
  type PolicyNavigationCatalog
} from "../miniprogram/core/policy-navigation-resolver.ts"
import {
  PROJECT_VIEW_STATE_SCHEMA_VERSION,
  restoreProjectViewState,
  type DraftRef,
  type NavigationObjectRef
} from "../miniprogram/core/project-navigation.ts"
import type { AppState, Project, ProjectMember } from "../miniprogram/core/domain.ts"
import { businessAccessSubject } from "../server/business-access.ts"
import type { BusinessMembership, BusinessProject } from "../server/business-repository.ts"

const NOW = "2026-10-08T10:00:00.000Z"

function grant(overrides: Partial<NormalizedPermissionGrant> = {}): NormalizedPermissionGrant {
  return {
    id: "grant-1",
    resource: "record",
    actions: ["read"],
    scope: { kind: "project" },
    status: "active",
    version: 1,
    ...overrides
  }
}

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    mode: "connected",
    identityId: "family-1",
    projectId: "project-1",
    projectStatus: "active",
    membershipStatus: "active",
    role: "family",
    isCurrentOwner: false,
    grants: [],
    ...overrides
  }
}

test("负责人拥有项目动作；普通成员不能执行负责人专属动作", () => {
  const owner = subject({
    identityId: "owner-1",
    role: "owner",
    isCurrentOwner: true
  })
  assert.equal(evaluateAccess(owner, {
    projectId: "project-1", resource: "member", action: "manage_grants"
  }).allowed, true)
  assert.equal(evaluateAccess(subject(), {
    projectId: "project-1", resource: "member", action: "manage_grants"
  }).reason, "owner_required")
})

test("归档项目允许读取与负责人重新打开，禁止继续写入", () => {
  const archivedOwner = subject({
    identityId: "owner-1",
    role: "owner",
    isCurrentOwner: true,
    projectStatus: "archived"
  })
  assert.equal(evaluateAccess(archivedOwner, {
    projectId: "project-1", resource: "record", action: "read"
  }).readonly, true)
  assert.equal(evaluateAccess(archivedOwner, {
    projectId: "project-1", resource: "project", action: "reopen_project"
  }).allowed, true)
  assert.equal(evaluateAccess(archivedOwner, {
    projectId: "project-1", resource: "record", action: "submit_fact"
  }).reason, "project_archived")
})

test("对象范围授权允许过滤后的列表和指定对象，不能借列表或写入访问其他对象", () => {
  const scoped = subject({
    grants: [legacyGrant({ id: "record-scope", resource: "record", objectIds: ["record-a"] })]
  })
  const listDecision = evaluateAccess(scoped, {
    projectId: "project-1", resource: "record", action: "list_metadata"
  })
  assert.equal(listDecision.allowed, true)
  assert.equal(listDecision.requiresObjectFilter, true)
  assert.equal(evaluateAccess(scoped, {
    projectId: "project-1", resource: "record", action: "read", objectId: "record-a"
  }).allowed, true)
  assert.equal(evaluateAccess(scoped, {
    projectId: "project-1", resource: "record", action: "read", objectId: "record-b"
  }).disclosure, "masked")
  assert.equal(evaluateAccess(scoped, {
    projectId: "project-1", resource: "record", action: "submit_fact"
  }).reason, "scope_not_granted")
  assert.equal(evaluateAccess(scoped, {
    projectId: "project-1", resource: "record", action: "submit_fact", objectId: "record-a"
  }).allowed, true)
})

test("数量、搜索和缩略图都基于同一可见对象集合", () => {
  const scoped = subject({
    grants: [legacyGrant({ id: "record-scope", resource: "record", objectIds: ["record-a"] })]
  })
  const items = [
    { id: "record-a", projectId: "project-1" },
    { id: "record-b", projectId: "project-1" },
    { id: "record-a", projectId: "project-2" }
  ]
  for (const action of ["read", "list_metadata", "search", "read_thumbnail"] as const) {
    assert.deepEqual(filterAccessibleObjects({
      subject: scoped,
      resource: "record",
      action,
      items,
      projectIdOf: item => item.projectId,
      objectIdOf: item => item.id
    }), [items[0]])
  }
})

test("空间与快照授权缺少所属上下文时默认拒绝", () => {
  const spaceScoped = subject({
    grants: [grant({
      id: "space-scope",
      scope: {
        kind: "spaces",
        spaceIds: ["space-kitchen"],
        objectIds: ["record-a"],
        includesFutureObjects: false
      }
    })]
  })
  assert.equal(evaluateAccess(spaceScoped, {
    projectId: "project-1", resource: "record", action: "read", objectId: "record-a"
  }).allowed, false)
  assert.equal(evaluateAccess(spaceScoped, {
    projectId: "project-1", resource: "record", action: "read",
    objectId: "record-a", spaceId: "space-kitchen"
  }).allowed, true)

  const snapshotScoped = subject({
    grants: [grant({
      id: "snapshot-scope",
      scope: { kind: "snapshot", snapshotId: "snapshot-a", objectIds: ["record-a"] }
    })]
  })
  assert.equal(evaluateAccess(snapshotScoped, {
    projectId: "project-1", resource: "record", action: "read", objectId: "record-a"
  }).allowed, false)
  assert.equal(evaluateAccess(snapshotScoped, {
    projectId: "project-1", resource: "record", action: "read",
    objectId: "record-a", snapshotId: "snapshot-a"
  }).allowed, true)
})

function localState(memberStatus: ProjectMember["status"] = "active"): {
  state: AppState
  member: ProjectMember
} {
  const project: Project = {
    id: "project-1",
    name: "测试项目",
    stage: "水电",
    ownerName: "同名用户",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  }
  const member: ProjectMember = {
    id: "member-1",
    projectId: project.id,
    name: "同名用户",
    role: "family",
    scopes: ["records", "issues"],
    status: memberStatus,
    createdAt: NOW
  }
  return {
    state: { projects: [project], members: [member] } as unknown as AppState,
    member
  }
}

test("本地模式使用稳定身份而非姓名，并且旧范围不会自动扩大到 AI、证据、监控或导出", () => {
  const { state, member } = localState()
  const owner = buildLocalAccessSubject(state, localOwnerIdentity(), "project-1")
  assert.equal(owner.isCurrentOwner, true)

  const family = buildLocalAccessSubject(state, localMemberIdentity(member), "project-1")
  assert.equal(family.isCurrentOwner, false)
  assert.equal(evaluateAccess(family, {
    projectId: "project-1", resource: "record", action: "read"
  }).allowed, true)
  for (const resource of ["evidence", "ai", "camera", "export"] as const) {
    assert.equal(evaluateAccess(family, {
      projectId: "project-1", resource, action: "read"
    }).allowed, false)
  }

  const forged = buildLocalAccessSubject(state, {
    mode: "local_demo", identityId: "owner-local", memberId: member.id
  }, "project-1")
  assert.equal(forged.isCurrentOwner, false)
  assert.equal(forged.membershipStatus, "missing")
})

test("撤销成员后，旧本地身份立即失去访问权", () => {
  const { state, member } = localState("revoked")
  const revoked = buildLocalAccessSubject(state, localMemberIdentity(member), "project-1")
  assert.equal(evaluateAccess(revoked, {
    projectId: "project-1", resource: "record", action: "read"
  }).reason, "membership_inactive")
})

test("联网旧 scopes 映射为统一权限，但对象范围保持不变", () => {
  const project: BusinessProject = {
    id: "project-1", name: "项目", ownerId: "owner-1", status: "active",
    version: 1, createdAt: NOW, updatedAt: NOW
  }
  const membership: BusinessMembership = {
    projectId: project.id,
    userId: "family-1",
    displayName: "家人",
    role: "family",
    scopes: { areas: ["materials"], materialIds: ["material-a"] },
    status: "active",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  }
  const mapped = businessAccessSubject({ project, membership })
  assert.equal(evaluateAccess(mapped, {
    projectId: project.id, resource: "material", action: "read", objectId: "material-a"
  }).allowed, true)
  assert.equal(evaluateAccess(mapped, {
    projectId: project.id, resource: "material", action: "read", objectId: "material-b"
  }).allowed, false)
})

test("导航恢复复用统一判权：失去对象权限后回退到仍可访问的空间", () => {
  const policySubject = subject({
    grants: [
      grant({ id: "space", resource: "space" }),
      grant({
        id: "issues",
        resource: "issue",
        actions: ["read", "create_draft"],
        scope: { kind: "objects", objectIds: ["issue-a"] }
      })
    ]
  })
  const descriptors = new Map<string, NavigationResourceDescriptor>([
    ["space-kitchen", { projectId: "project-1", resource: "space", objectId: "space-kitchen" }],
    ["issue-a", { projectId: "project-1", resource: "issue", objectId: "issue-a", version: 2 }],
    ["issue-b", { projectId: "project-1", resource: "issue", objectId: "issue-b", version: 1 }]
  ])
  const catalog: PolicyNavigationCatalog = {
    subject: () => policySubject,
    space: id => descriptors.get(id),
    evidence: id => descriptors.get(id),
    object: (ref: NavigationObjectRef) => descriptors.get(ref.id),
    stageExists: () => true,
    draftExists: (_identityId: string, _projectId: string, _draft: DraftRef) => true
  }
  const resolver = createPolicyNavigationResolver("family-1", catalog)
  const exact = restoreProjectViewState({
    saved: {
      identityId: "family-1",
      projectId: "project-1",
      viewKind: "issue",
      spaceId: "space-kitchen",
      objectRef: { type: "issue", id: "issue-a", version: 1 },
      schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
      updatedAt: NOW
    },
    identityId: "family-1",
    projectId: "project-1",
    resolver,
    now: NOW
  })
  assert.equal(exact.reason, "object_updated")
  assert.equal(exact.state?.objectRef?.version, 2)

  const denied = restoreProjectViewState({
    saved: {
      ...exact.state!,
      objectRef: { type: "issue", id: "issue-b", version: 1 }
    },
    identityId: "family-1",
    projectId: "project-1",
    resolver,
    now: NOW
  })
  assert.equal(denied.reason, "object_unavailable")
  assert.equal(denied.state?.viewKind, "patrol")
  assert.equal(denied.state?.spaceId, "space-kitchen")
})
