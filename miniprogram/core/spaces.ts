import type {
  ActorRef,
  AppState,
  LegacyRoomMapping,
  ProjectStage,
  Space,
  SpaceKind,
  SpaceRelation,
  SpaceStageState,
  SpaceStageStatus
} from "./domain"

export interface LegacyRoomCandidate {
  projectId: string
  sourceLabel: string
  normalizedLabel: string
  recordCount: number
  issueCount: number
  cameraCount: number
  mappedSpaceId?: string
}

export const SPACE_KIND_OPTIONS: Array<{ value: SpaceKind; label: string }> = [
  { value: "whole_project", label: "全屋" },
  { value: "living_room", label: "客厅" },
  { value: "kitchen", label: "厨房" },
  { value: "bathroom", label: "卫生间" },
  { value: "bedroom", label: "卧室" },
  { value: "balcony", label: "阳台" },
  { value: "corridor", label: "走廊" },
  { value: "other", label: "其他" },
  { value: "custom", label: "自定义" }
]

export const SPACE_STAGE_STATUS_OPTIONS: Array<{ value: SpaceStageStatus; label: string }> = [
  { value: "not_started", label: "尚未开始" },
  { value: "in_progress", label: "进行中" },
  { value: "pending_review", label: "待负责人确认" },
  { value: "confirmed_complete", label: "负责人已确认完成" }
]

export function normalizeRoomLabel(value: string): string {
  return value.trim()
}

export function inferredSpaceKind(name: string): SpaceKind {
  const normalized = normalizeRoomLabel(name)
  if (normalized === "全屋") return "whole_project"
  if (normalized.includes("客厅")) return "living_room"
  if (normalized.includes("厨房")) return "kitchen"
  if (normalized.includes("卫生间") || normalized.includes("卫浴")) return "bathroom"
  if (normalized.includes("卧")) return "bedroom"
  if (normalized.includes("阳台")) return "balcony"
  if (normalized.includes("走廊") || normalized.includes("过道")) return "corridor"
  return "custom"
}

export function validateSpace(input: Space): string[] {
  const errors: string[] = []
  if (!input.id.trim() || !input.projectId.trim()) errors.push("空间 ID 和项目不能为空")
  if (!input.name.trim() || input.name.trim().length > 40) errors.push("空间名称应为 1～40 个字符")
  if (!Number.isSafeInteger(input.order) || input.order < 0) errors.push("空间顺序不正确")
  if (!Number.isSafeInteger(input.version) || input.version < 1) errors.push("空间版本不正确")
  if (input.kind === "whole_project" && input.participatesInTopology) errors.push("全屋不能作为物理拓扑节点")
  return errors
}

export function buildLegacyRoomCandidates(state: AppState, projectId: string): LegacyRoomCandidate[] {
  const byLabel = new Map<string, LegacyRoomCandidate>()
  const mappingByLabel = new Map(state.legacyRoomMappings
    .filter(item => item.projectId === projectId)
    .map(item => [item.normalizedLabel, item]))
  const add = (raw: string, field: "recordCount" | "issueCount" | "cameraCount") => {
    const normalizedLabel = normalizeRoomLabel(raw)
    if (!normalizedLabel || normalizedLabel === "未注明") return
    const current = byLabel.get(normalizedLabel) || {
      projectId,
      sourceLabel: raw.trim(),
      normalizedLabel,
      recordCount: 0,
      issueCount: 0,
      cameraCount: 0,
      mappedSpaceId: mappingByLabel.get(normalizedLabel)?.spaceId
    }
    current[field] += 1
    byLabel.set(normalizedLabel, current)
  }
  state.records.filter(item => item.projectId === projectId && !item.spaceId)
    .forEach(item => add(item.room, "recordCount"))
  state.issues.filter(item => item.projectId === projectId && !item.spaceId)
    .forEach(item => add(item.room, "issueCount"))
  state.cameras.filter(item => item.projectId === projectId && !item.spaceId)
    .forEach(item => add(item.room, "cameraCount"))
  return [...byLabel.values()].sort((a, b) =>
    (b.recordCount + b.issueCount + b.cameraCount) - (a.recordCount + a.issueCount + a.cameraCount)
      || a.normalizedLabel.localeCompare(b.normalizedLabel, "zh-CN"))
}

export function activeSpaces(state: AppState, projectId: string): Space[] {
  return state.spaces.filter(item => item.projectId === projectId && item.status === "active")
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
}

export function assertSpaceRelationAllowed(
  spaces: readonly Space[],
  relations: readonly SpaceRelation[],
  input: Pick<SpaceRelation, "projectId" | "fromSpaceId" | "toSpaceId" | "kind">
): void {
  if (input.fromSpaceId === input.toSpaceId) throw new Error("空间不能与自身建立关系")
  const from = spaces.find(item => item.id === input.fromSpaceId && item.projectId === input.projectId)
  const to = spaces.find(item => item.id === input.toSpaceId && item.projectId === input.projectId)
  if (!from || !to || from.status !== "active" || to.status !== "active") {
    throw new Error("关系两端必须是同一项目中的有效空间")
  }
  const duplicate = relations.some(item => item.projectId === input.projectId
    && item.status === "active"
    && item.kind === input.kind
    && (item.fromSpaceId === input.fromSpaceId && item.toSpaceId === input.toSpaceId
      || input.kind !== "contains"
        && item.fromSpaceId === input.toSpaceId && item.toSpaceId === input.fromSpaceId))
  if (duplicate) throw new Error("相同空间关系已经存在")
  if (input.kind !== "contains") return
  const edges = relations.filter(item => item.projectId === input.projectId
    && item.status === "active" && item.kind === "contains")
  const visits = new Set<string>()
  const reaches = (fromId: string, targetId: string): boolean => {
    if (fromId === targetId) return true
    if (visits.has(fromId)) return false
    visits.add(fromId)
    return edges.filter(item => item.fromSpaceId === fromId)
      .some(item => reaches(item.toSpaceId, targetId))
  }
  if (reaches(input.toSpaceId, input.fromSpaceId)) throw new Error("包含关系不能形成循环")
}

export function buildSpaceStageState(input: {
  id: string
  projectId: string
  spaceId: string
  stageId: ProjectStage
  status: SpaceStageStatus
  note: string
  sourceEvidenceIds?: string[]
  actor: ActorRef
  timestamp: string
  previous?: SpaceStageState
}): SpaceStageState {
  const note = input.note.trim()
  const sourceEvidenceIds = [...new Set(input.sourceEvidenceIds || [])]
  if (note.length > 1000) throw new Error("阶段说明不能超过 1000 字")
  const isConfirmed = input.status === "confirmed_complete"
  if (isConfirmed && sourceEvidenceIds.length === 0 && !note) {
    throw new Error("无证据确认完成时请填写依据说明")
  }
  if (input.previous?.status === "confirmed_complete" && !isConfirmed && !note) {
    throw new Error("回退已确认状态时请填写原因")
  }
  return {
    id: input.previous?.id || input.id,
    projectId: input.projectId,
    spaceId: input.spaceId,
    stageId: input.stageId,
    status: input.status,
    sourceEvidenceIds,
    submittedBy: input.actor,
    submittedAt: input.timestamp,
    confirmedBy: isConfirmed ? input.actor : undefined,
    confirmedAt: isConfirmed ? input.timestamp : undefined,
    note,
    updatedAt: input.timestamp,
    version: (input.previous?.version || 0) + 1
  }
}

export function buildLegacyRoomMapping(input: {
  id: string
  projectId: string
  sourceLabel: string
  spaceId: string
  actor: ActorRef
  timestamp: string
  previous?: LegacyRoomMapping
}): LegacyRoomMapping {
  const normalizedLabel = normalizeRoomLabel(input.sourceLabel)
  if (!normalizedLabel) throw new Error("旧房间标签不能为空")
  return {
    id: input.previous?.id || input.id,
    projectId: input.projectId,
    sourceLabel: input.sourceLabel.trim(),
    normalizedLabel,
    spaceId: input.spaceId,
    confirmedBy: input.actor,
    confirmedAt: input.timestamp,
    version: (input.previous?.version || 0) + 1
  }
}
