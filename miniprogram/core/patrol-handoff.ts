import { ROOMS, STAGES, type ProjectStage, type Space } from "./domain"
import type { OriginContext } from "./project-navigation"

export interface PatrolEntryContext {
  accepted: boolean
  roomOptions: string[]
  roomIndex: number
  stageIndex: number
  spaceId?: string
  spaceName?: string
  label: string
}

function isProjectStage(value: string | undefined): value is ProjectStage {
  return Boolean(value && STAGES.includes(value as ProjectStage))
}

function roomOptions(preferred?: string): string[] {
  if (!preferred || ROOMS.includes(preferred as typeof ROOMS[number])) return [...ROOMS]
  return [preferred, ...ROOMS]
}

/**
 * OriginContext only provides navigation context. The current project and its
 * current space collection remain the source of truth for form prefill.
 */
export function resolvePatrolEntryContext(input: {
  context?: OriginContext
  projectId: string
  currentStage: ProjectStage
  spaces: readonly Space[]
}): PatrolEntryContext {
  const fallbackStageIndex = Math.max(0, STAGES.indexOf(input.currentStage))
  const context = input.context
  if (!context || context.originView !== "patrol" || context.projectId !== input.projectId) {
    return {
      accepted: false,
      roomOptions: [...ROOMS],
      roomIndex: 0,
      stageIndex: fallbackStageIndex,
      label: ""
    }
  }
  const space = context.spaceId
    ? input.spaces.find(item => item.id === context.spaceId
      && item.projectId === input.projectId && item.status === "active")
    : undefined
  if (context.spaceId && !space) {
    return {
      accepted: false,
      roomOptions: [...ROOMS],
      roomIndex: 0,
      stageIndex: fallbackStageIndex,
      label: ""
    }
  }
  const rooms = roomOptions(space?.name)
  const stage = isProjectStage(context.stageId) ? context.stageId : input.currentStage
  return {
    accepted: true,
    roomOptions: rooms,
    roomIndex: space ? Math.max(0, rooms.indexOf(space.name)) : 0,
    stageIndex: Math.max(0, STAGES.indexOf(stage)),
    spaceId: space?.id,
    spaceName: space?.name,
    label: space
      ? `来自巡场 · ${space.name} · ${stage}`
      : `来自巡场 · ${stage}`
  }
}

export function spaceIdForRoom(input: {
  projectId: string
  roomName: string
  spaces: readonly Space[]
  preferredSpaceId?: string
}): string | undefined {
  const preferred = input.preferredSpaceId
    ? input.spaces.find(item => item.id === input.preferredSpaceId
      && item.projectId === input.projectId && item.status === "active")
    : undefined
  if (preferred?.name === input.roomName) return preferred.id
  return input.spaces.find(item => item.projectId === input.projectId
    && item.status === "active" && item.name === input.roomName)?.id
}
