import type { AppState, Project } from "./domain"
import { evaluateAccess } from "./access-policy"
import {
  buildLocalAccessSubject,
  type LocalAccessIdentity
} from "./local-access"
import { receiptSummary } from "./material-flow"

export type ProjectGatewayFilter = "active" | "archived" | "all"
export type ProjectGatewaySort = "attention" | "recent"
export type ProjectGatewayMode = "empty" | "direct" | "selector"
export type ProjectGatewayLayout = "empty" | "bubble" | "list"

export interface ProjectGatewayQuery {
  text: string
  filter: ProjectGatewayFilter
  sort: ProjectGatewaySort
}

export interface AccessibleProjectSource {
  kind: "project"
  projectId: string
  name: string
  stage: string
  ownerName: string
  status: "active" | "archived"
  attentionCount: number
  updatedAt: string
  selected: boolean
}

export interface RevokedProjectSource {
  kind: "revoked"
  placeholderKey: string
}

export type ProjectGatewaySource = AccessibleProjectSource | RevokedProjectSource

export interface ProjectGatewayCard extends AccessibleProjectSource {
  readonly: boolean
  attentionLabel: string
  updatedLabel: string
  bubbleClass: string
}

export interface ProjectGatewayModel {
  mode: ProjectGatewayMode
  layout: ProjectGatewayLayout
  cards: ProjectGatewayCard[]
  accessibleProjectIds: string[]
  accessibleCount: number
  activeCount: number
  archivedCount: number
  revokedCount: number
  hasFilteredResults: boolean
}

export const DEFAULT_PROJECT_GATEWAY_QUERY: ProjectGatewayQuery = {
  text: "",
  filter: "active",
  sort: "attention"
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "更新时间未知"
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN")
}

export function buildProjectGateway(
  sources: readonly ProjectGatewaySource[],
  query: ProjectGatewayQuery = DEFAULT_PROJECT_GATEWAY_QUERY
): ProjectGatewayModel {
  const accessible = sources.filter(
    (source): source is AccessibleProjectSource => source.kind === "project"
  )
  const revokedCount = sources.filter(source => source.kind === "revoked").length
  const normalizedQuery = query.text.trim().toLocaleLowerCase()
  const cards = accessible
    .filter(source => query.filter === "all" || source.status === query.filter)
    .filter(source => !normalizedQuery
      || `${source.name}\n${source.stage}`.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      if (query.sort === "attention" && b.attentionCount !== a.attentionCount) {
        return b.attentionCount - a.attentionCount
      }
      const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated
      return compareText(a.name, b.name)
    })
    .map((source, index): ProjectGatewayCard => ({
      ...source,
      readonly: source.status === "archived",
      attentionLabel: source.status === "archived"
        ? "资料只读"
        : source.attentionCount
          ? `${source.attentionCount} 项需要你确认`
          : "当前无需你确认",
      updatedLabel: formatUpdatedAt(source.updatedAt),
      bubbleClass: `scene-bubble tone-${index % 4}`
    }))

  const accessibleCount = accessible.length
  return {
    mode: accessibleCount === 0 ? "empty" : accessibleCount === 1 ? "direct" : "selector",
    layout: cards.length === 0 ? "empty" : cards.length <= 6 ? "bubble" : "list",
    cards,
    accessibleProjectIds: accessible.map(source => source.projectId),
    accessibleCount,
    activeCount: accessible.filter(source => source.status === "active").length,
    archivedCount: accessible.filter(source => source.status === "archived").length,
    revokedCount,
    hasFilteredResults: cards.length > 0
  }
}

export function ownerAttentionCount(state: AppState, projectId: string): number {
  const issues = state.issueWorkflows.filter(item =>
    item.projectId === projectId
    && (item.status === "pending_confirmation" || item.status === "pending_review")).length
  const receipts = state.receiptBatches.filter(item =>
    item.projectId === projectId && receiptSummary(item).status !== "resolved").length
  const agreements = state.agreements.filter(item =>
    item.agreement.projectId === projectId
    && item.versions.some(version => version.status === "pending_confirmation")).length
  const finance = state.paymentFacts.filter(item =>
    item.projectId === projectId && item.status === "pending_confirmation").length
    + state.refundFacts.filter(item =>
      item.projectId === projectId && item.status === "pending_confirmation").length
  return issues + receipts + agreements + finance
}

function authorizedSource(
  state: AppState,
  identity: LocalAccessIdentity,
  project: Project
): AccessibleProjectSource | RevokedProjectSource | undefined {
  const subject = buildLocalAccessSubject(state, identity, project.id)
  const decision = evaluateAccess(subject, {
    projectId: project.id,
    resource: "project",
    action: "read"
  })
  if (decision.allowed) {
    return {
      kind: "project",
      projectId: project.id,
      name: project.name,
      stage: project.stage,
      ownerName: project.ownerName,
      status: project.status === "archived" ? "archived" : "active",
      attentionCount: subject.isCurrentOwner ? ownerAttentionCount(state, project.id) : 0,
      updatedAt: project.updatedAt,
      selected: state.currentProjectId === project.id
    }
  }
  const revokedMember = identity.memberId
    ? state.members.find(member => member.id === identity.memberId
      && member.projectId === project.id
      && identity.identityId === `local-member:${member.id}`
      && member.status === "revoked")
    : undefined
  return revokedMember
    ? { kind: "revoked", placeholderKey: `revoked:${revokedMember.id}` }
    : undefined
}

export function buildLocalProjectGateway(input: {
  state: AppState
  identity: LocalAccessIdentity
  query?: ProjectGatewayQuery
}): ProjectGatewayModel {
  const sources = input.state.projects
    .filter(project => project.status !== "trashed")
    .map(project => authorizedSource(input.state, input.identity, project))
    .filter((source): source is ProjectGatewaySource => Boolean(source))
  return buildProjectGateway(sources, input.query || DEFAULT_PROJECT_GATEWAY_QUERY)
}
