export const PATROL_WORK_STEPS = [
  { id: "site", label: "现场", shortLabel: "现场" },
  { id: "record", label: "记录", shortLabel: "记录" },
  { id: "check", label: "核对", shortLabel: "核对" },
  { id: "resolve", label: "处理", shortLabel: "处理" },
  { id: "review", label: "复查", shortLabel: "复查" }
] as const

export type PatrolWorkStepId = typeof PATROL_WORK_STEPS[number]["id"]
export type PatrolDirection = "next-space" | "previous-space" | "next-step" | "previous-step"
export type PatrolTransition = "enter-left" | "enter-right" | "enter-up" | "enter-down"

export interface PatrolCoordinate {
  spaceIndex: number
  stepIndex: number
}

export interface PatrolMoveResult extends PatrolCoordinate {
  moved: boolean
  transition: PatrolTransition | ""
}

export function patrolAvailable(projectStatus: "active" | "archived" | "trashed", spaceCount: number): boolean {
  return projectStatus === "active" && Number.isSafeInteger(spaceCount) && spaceCount > 0
}

export function isPatrolWorkStepId(value: unknown): value is PatrolWorkStepId {
  return PATROL_WORK_STEPS.some(step => step.id === value)
}

export function patrolDirectionFromDelta(input: {
  dx: number
  dy: number
  minimumDistance?: number
  dominanceRatio?: number
}): PatrolDirection | undefined {
  const minimumDistance = input.minimumDistance ?? 48
  const dominanceRatio = input.dominanceRatio ?? 1.35
  const absX = Math.abs(input.dx)
  const absY = Math.abs(input.dy)
  const primary = Math.max(absX, absY)
  const secondary = Math.min(absX, absY)
  if (primary < minimumDistance || primary < secondary * dominanceRatio) return undefined
  if (absX > absY) return input.dx < 0 ? "next-space" : "previous-space"
  return input.dy < 0 ? "next-step" : "previous-step"
}

export function movePatrolCoordinate(input: {
  current: PatrolCoordinate
  direction: PatrolDirection
  spaceCount: number
  stepCount: number
}): PatrolMoveResult {
  let { spaceIndex, stepIndex } = input.current
  if (input.direction === "next-space") spaceIndex += 1
  if (input.direction === "previous-space") spaceIndex -= 1
  if (input.direction === "next-step") stepIndex += 1
  if (input.direction === "previous-step") stepIndex -= 1

  const inside = spaceIndex >= 0 && spaceIndex < input.spaceCount
    && stepIndex >= 0 && stepIndex < input.stepCount
  if (!inside) return { ...input.current, moved: false, transition: "" }

  const transition: PatrolTransition = input.direction === "next-space" ? "enter-left"
    : input.direction === "previous-space" ? "enter-right"
      : input.direction === "next-step" ? "enter-up"
        : "enter-down"
  return { spaceIndex, stepIndex, moved: true, transition }
}
