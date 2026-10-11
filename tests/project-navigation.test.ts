import assert from "node:assert/strict"
import test from "node:test"
import {
  ORIGIN_CONTEXT_SCHEMA_VERSION,
  PROJECT_VIEW_STATE_SCHEMA_VERSION,
  findProjectViewState,
  parseOriginContext,
  restoreOriginContext,
  restoreProjectViewState,
  serializeOriginContext,
  upsertProjectViewState,
  validateProjectViewState,
  type DraftRef,
  type NavigationObjectRef,
  type OriginContext,
  type ProjectNavigationResolver,
  type ProjectViewState,
  type ReferenceAccessResult
} from "../miniprogram/core/project-navigation.ts"

const NOW = "2026-10-08T10:00:00.000Z"

class Resolver implements ProjectNavigationResolver {
  project = new Map<string, "active" | "archived" | "unauthorized" | "missing">()
  spaces = new Set<string>()
  evidence = new Map<string, ReferenceAccessResult>()
  objects = new Map<string, ReferenceAccessResult>()
  stages = new Set(["水电", "泥瓦"])
  drafts = new Set<string>()

  projectAccess(identityId: string, projectId: string) {
    return this.project.get(`${identityId}:${projectId}`) || "missing"
  }

  spaceAccess(identityId: string, projectId: string, spaceId: string) {
    return this.spaces.has(`${identityId}:${projectId}:${spaceId}`) ? "current" as const : "missing" as const
  }

  evidenceAccess(identityId: string, projectId: string, evidenceId: string) {
    return this.evidence.get(`${identityId}:${projectId}:${evidenceId}`) || { state: "missing" as const }
  }

  objectAccess(identityId: string, projectId: string, objectRef: NavigationObjectRef) {
    return this.objects.get(`${identityId}:${projectId}:${objectRef.type}:${objectRef.id}`) || { state: "missing" as const }
  }

  stageExists(_projectId: string, stageId: string) {
    return this.stages.has(stageId)
  }

  draftExists(identityId: string, projectId: string, draftRef: DraftRef) {
    return this.drafts.has(`${identityId}:${projectId}:${draftRef.type}:${draftRef.id}`)
  }
}

function view(overrides: Partial<ProjectViewState> = {}): ProjectViewState {
  return {
    identityId: "owner",
    projectId: "project_a",
    viewKind: "patrol",
    spaceId: "space_kitchen",
    stageId: "水电",
    patrolStepId: "check",
    schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
    updatedAt: NOW,
    ...overrides
  }
}

function activeResolver(): Resolver {
  const resolver = new Resolver()
  resolver.project.set("owner:project_a", "active")
  resolver.project.set("owner:project_b", "active")
  resolver.project.set("family:project_a", "active")
  resolver.spaces.add("owner:project_a:space_kitchen")
  resolver.spaces.add("family:project_a:space_kitchen")
  return resolver
}

test("视图状态按身份和项目隔离，A→B→A 不互相覆盖", () => {
  let states: ProjectViewState[] = []
  states = upsertProjectViewState(states, view({ projectId: "project_a", viewKind: "patrol" }))
  states = upsertProjectViewState(states, view({ projectId: "project_b", viewKind: "material", spaceId: undefined }))
  states = upsertProjectViewState(states, view({ identityId: "family", projectId: "project_a", viewKind: "issue" }))

  assert.equal(states.length, 3)
  assert.equal(findProjectViewState(states, "owner", "project_a")?.viewKind, "patrol")
  assert.equal(findProjectViewState(states, "owner", "project_b")?.viewKind, "material")
  assert.equal(findProjectViewState(states, "family", "project_a")?.viewKind, "issue")

  states = upsertProjectViewState(states, view({ projectId: "project_a", viewKind: "evidence" }))
  assert.equal(states.length, 3)
  assert.equal(findProjectViewState(states, "owner", "project_a")?.viewKind, "evidence")
  assert.equal(findProjectViewState(states, "owner", "project_b")?.viewKind, "material")
})

test("视图集合不暴露可绕过校验的嵌套引用", () => {
  const source = view({ filter: { spaceIds: ["space_kitchen"] } })
  const states = upsertProjectViewState([], source)
  ;(source.filter?.spaceIds as string[]).push("space_private")
  assert.deepEqual(states[0].filter?.spaceIds, ["space_kitchen"])

  const restored = findProjectViewState(states, "owner", "project_a")!
  ;(restored.filter?.spaceIds as string[]).push("space_other")
  assert.deepEqual(states[0].filter?.spaceIds, ["space_kitchen"])
})

test("视图状态拒绝敏感或任意 filter 字段和不兼容 schema", () => {
  assert.ok(validateProjectViewState(view({ filter: { status: "open", sort: "recent" } })).length === 0)
  assert.ok(validateProjectViewState(view({ patrolPresentation: "illustration" })).length === 0)
  assert.ok(validateProjectViewState(view({ patrolStepId: "review" })).length === 0)
  assert.ok(validateProjectViewState({ ...view(), patrolStepId: "水电" }).some(item => /patrolStepId/.test(item)))
  assert.ok(validateProjectViewState({ ...view(), patrolPresentation: "unknown" }).some(item => /patrolPresentation/.test(item)))
  assert.ok(validateProjectViewState(view({ filter: { apiKey: "secret" } })).some(item => /apiKey/.test(item)))
  assert.ok(validateProjectViewState({ ...view(), schemaVersion: 2 }).some(item => /schemaVersion/.test(item)))
})

test("项目撤权返回项目入口，归档返回只读概览", () => {
  const resolver = activeResolver()
  resolver.project.set("owner:project_a", "unauthorized")
  const unauthorized = restoreProjectViewState({
    saved: view(), identityId: "owner", projectId: "project_a", resolver, now: NOW
  })
  assert.equal(unauthorized.destination, "project_entry")
  assert.equal(unauthorized.state, undefined)

  resolver.project.set("owner:project_a", "archived")
  const archived = restoreProjectViewState({
    saved: view(), identityId: "owner", projectId: "project_a", resolver, now: NOW
  })
  assert.equal(archived.destination, "project")
  assert.equal(archived.readonly, true)
  assert.equal(archived.state?.viewKind, "overview")
  assert.equal(archived.state?.objectRef, undefined)
})

test("对象失效回同空间，空间失效再回项目概览", () => {
  const resolver = activeResolver()
  const saved = view({
    viewKind: "issue",
    objectRef: { type: "issue", id: "issue_a", version: 1 }
  })
  const objectMissing = restoreProjectViewState({
    saved, identityId: "owner", projectId: "project_a", resolver, now: NOW
  })
  assert.equal(objectMissing.reason, "object_unavailable")
  assert.equal(objectMissing.state?.viewKind, "patrol")
  assert.equal(objectMissing.state?.spaceId, "space_kitchen")

  resolver.spaces.clear()
  const spaceMissing = restoreProjectViewState({
    saved, identityId: "owner", projectId: "project_a", resolver, now: NOW
  })
  assert.equal(spaceMissing.reason, "space_unavailable")
  assert.equal(spaceMissing.state?.viewKind, "overview")
})

test("对象版本变化加载当前版本，失效阶段和草稿只清除自身", () => {
  const resolver = activeResolver()
  resolver.objects.set("owner:project_a:material:material_a", { state: "stale", currentVersion: 4 })
  const updated = restoreProjectViewState({
    saved: view({
      viewKind: "material",
      stageId: "已删除阶段",
      objectRef: { type: "material", id: "material_a", version: 2 },
      draftRef: { type: "material_check", id: "draft_a" }
    }),
    identityId: "owner",
    projectId: "project_a",
    resolver,
    now: NOW
  })
  assert.equal(updated.state?.objectRef?.version, 4)
  assert.equal(updated.state?.stageId, undefined)
  assert.equal(updated.state?.draftRef, undefined)
  assert.equal(updated.reason, "draft_unavailable")
})

test("证据失效按对象同样逐级回退", () => {
  const resolver = activeResolver()
  const result = restoreProjectViewState({
    saved: view({ viewKind: "evidence", evidenceId: "evidence_missing" }),
    identityId: "owner",
    projectId: "project_a",
    resolver,
    now: NOW
  })
  assert.equal(result.reason, "evidence_unavailable")
  assert.equal(result.state?.viewKind, "patrol")
})

test("OriginContext 可安全序列化，损坏内容不能进入路由恢复", () => {
  const context: OriginContext = {
    projectId: "project_a",
    originView: "patrol",
    spaceId: "space_kitchen",
    stageId: "水电",
    patrolStepId: "check",
    anchorId: "evidence_card_a",
    returnToken: "return_local_1",
    schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
  }
  const serialized = serializeOriginContext(context)
  assert.deepEqual(parseOriginContext(serialized), context)
  assert.equal(parseOriginContext(encodeURIComponent(JSON.stringify({ ...context, patrolStepId: "水电" }))), undefined)
  assert.equal(parseOriginContext("%not-json"), undefined)
})

test("OriginContext 返回时重新判权，returnToken 不被当作授权", () => {
  const resolver = activeResolver()
  const context: OriginContext = {
    projectId: "project_a",
    originView: "patrol",
    spaceId: "space_kitchen",
    patrolStepId: "review",
    anchorId: "evidence_card_a",
    returnToken: "looks-like-an-auth-token-but-is-not",
    schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
  }
  resolver.project.set("owner:project_a", "unauthorized")
  const denied = restoreOriginContext({ context, identityId: "owner", resolver, now: NOW })
  assert.equal(denied.destination, "project_entry")
  assert.equal(denied.reason, "project_unauthorized")

  resolver.project.set("owner:project_a", "active")
  const restored = restoreOriginContext({ context, identityId: "owner", resolver, now: NOW })
  assert.equal(restored.destination, "project")
  assert.equal(restored.state?.patrolStepId, "review")
  assert.equal(restored.state?.scrollAnchor?.anchorId, "evidence_card_a")
})
