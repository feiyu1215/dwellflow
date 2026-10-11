import assert from "node:assert/strict"
import test from "node:test"
import {
  buildLocalProjectGateway,
  buildProjectGateway,
  type AccessibleProjectSource,
  type ProjectGatewaySource
} from "../miniprogram/core/project-gateway.ts"
import { localMemberIdentity } from "../miniprogram/core/local-access.ts"
import type { AppState, Project, ProjectMember } from "../miniprogram/core/domain.ts"

const NOW = Date.parse("2026-10-08T10:00:00.000Z")

function source(index: number, overrides: Partial<AccessibleProjectSource> = {}): AccessibleProjectSource {
  return {
    kind: "project",
    projectId: `project-${index}`,
    name: `装修项目 ${index}`,
    stage: index % 2 ? "水电" : "泥瓦",
    ownerName: "项目负责人",
    status: "active",
    attentionCount: index,
    updatedAt: new Date(NOW - index * 86_400_000).toISOString(),
    selected: index === 1,
    ...overrides
  }
}

test("0 项目为空态，1 项目直达，2～6 为气泡，7 和 20 项目为列表", () => {
  assert.equal(buildProjectGateway([]).mode, "empty")
  assert.equal(buildProjectGateway([source(1)]).mode, "direct")
  for (const count of [2, 6]) {
    const model = buildProjectGateway(Array.from({ length: count }, (_, index) => source(index + 1)))
    assert.equal(model.mode, "selector")
    assert.equal(model.layout, "bubble")
  }
  for (const count of [7, 20]) {
    const model = buildProjectGateway(Array.from({ length: count }, (_, index) => source(index + 1)))
    assert.equal(model.mode, "selector")
    assert.equal(model.layout, "list")
    assert.equal(model.cards.length, count)
  }
})

test("默认按本人待确认优先，最近更新排序可以切换且结果稳定", () => {
  const sources = [
    source(1, { name: "较新但无待办", attentionCount: 0, updatedAt: "2026-10-08T10:00:00.000Z" }),
    source(2, { name: "较旧且有待办", attentionCount: 3, updatedAt: "2026-10-01T10:00:00.000Z" })
  ]
  assert.equal(buildProjectGateway(sources).cards[0].name, "较旧且有待办")
  assert.equal(buildProjectGateway(sources, {
    text: "", filter: "active", sort: "recent"
  }).cards[0].name, "较新但无待办")
})

test("搜索只匹配已授权项目的名称和阶段，归档筛选明确显示只读", () => {
  const sources: ProjectGatewaySource[] = [
    source(1, { name: "父母家翻新", stage: "水电" }),
    source(2, { name: "旧房资料", status: "archived", stage: "安装收尾" }),
    { kind: "revoked", placeholderKey: "revoked-opaque" }
  ]
  const searched = buildProjectGateway(sources, {
    text: "父母", filter: "all", sort: "recent"
  })
  assert.deepEqual(searched.cards.map(item => item.name), ["父母家翻新"])
  assert.equal(searched.revokedCount, 1)

  const archived = buildProjectGateway(sources, {
    text: "", filter: "archived", sort: "recent"
  })
  assert.equal(archived.cards.length, 1)
  assert.equal(archived.cards[0].readonly, true)
  assert.equal(archived.cards[0].attentionLabel, "资料只读")
})

test("撤权项目只保留不含项目元数据的占位计数", () => {
  const revoked: ProjectGatewaySource = { kind: "revoked", placeholderKey: "revoked-opaque" }
  const model = buildProjectGateway([revoked])
  assert.equal(model.mode, "empty")
  assert.equal(model.revokedCount, 1)
  assert.deepEqual(model.cards, [])
  assert.equal("name" in revoked, false)
  assert.equal("projectId" in revoked, false)
})

test("长名称保留原文交给界面截断，过滤为空不改变真实项目总数", () => {
  const longName = "这是一个用于验证项目入口长名称不会污染其它项目状态的超长装修项目名称"
  const sources = [source(1, { name: longName }), source(2)]
  const model = buildProjectGateway(sources, {
    text: "不存在", filter: "active", sort: "attention"
  })
  assert.equal(model.hasFilteredResults, false)
  assert.equal(model.accessibleCount, 2)
  assert.equal(buildProjectGateway(sources).cards.find(item => item.projectId === "project-1")?.name, longName)
})

test("本地成员入口只返回所属且获准项目，撤权后只保留匿名占位", () => {
  const projects: Project[] = [1, 2].map(index => ({
    id: `project-${index}`,
    name: `不应串项 ${index}`,
    stage: "水电",
    ownerName: "负责人",
    status: "active",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString()
  }))
  const member: ProjectMember = {
    id: "member-1",
    projectId: "project-1",
    name: "家人",
    role: "family",
    scopes: ["records"],
    status: "active",
    createdAt: new Date(NOW).toISOString()
  }
  const state = {
    currentProjectId: "project-1",
    projects,
    members: [member],
    issueWorkflows: [],
    receiptBatches: [],
    agreements: [],
    paymentFacts: [],
    refundFacts: []
  } as unknown as AppState
  const active = buildLocalProjectGateway({
    state,
    identity: localMemberIdentity(member)
  })
  assert.deepEqual(active.accessibleProjectIds, ["project-1"])
  assert.equal(active.cards[0].name, "不应串项 1")

  member.status = "revoked"
  const revoked = buildLocalProjectGateway({
    state,
    identity: localMemberIdentity(member)
  })
  assert.equal(revoked.accessibleCount, 0)
  assert.equal(revoked.revokedCount, 1)
  assert.deepEqual(revoked.cards, [])
})
