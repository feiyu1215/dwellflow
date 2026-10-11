import { AppError } from "./validation.ts"

export const BUSINESS_COMMAND_TYPES = [
  "project.archive",
  "project.reopen",
  "member.put",
  "owner_transfer.initiate",
  "owner_transfer.accept",
  "agreement.create",
  "agreement.add_draft",
  "agreement.revise",
  "agreement.resolve_conflict",
  "agreement.submit",
  "agreement.approve",
  "agreement.withdraw",
  "agreement.reject",
  "purchase.create",
  "receipt.create",
  "receipt.correct",
  "receipt.allocate",
  "inventory.append",
  "usage.append",
  "issue.create",
  "issue.add_proposal",
  "issue.select_proposal",
  "issue.submit_treatment",
  "issue.review",
  "issue.reopen",
  "cost.approval",
  "payment.create",
  "payment.decide",
  "refund.create",
  "refund.decide",
  "change.approve"
] as const

export type BusinessCommandType = typeof BUSINESS_COMMAND_TYPES[number]

export interface BusinessCommandEnvelope {
  requestId: string
  type: BusinessCommandType
  payload: Record<string, unknown>
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new AppError(400, label + "格式不正确")
  }
  return value
}

export function readText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AppError(400, label + "不能为空或超过长度限制")
  }
  return value.trim()
}

export function readOptionalText(value: unknown, label: string, max = 4000): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max) {
    throw new AppError(400, label + "格式不正确")
  }
  return value.trim() || undefined
}

export function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AppError(400, label + "必须是大于 0 的安全整数")
  }
  return Number(value)
}

export function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(400, label + "必须是非负安全整数")
  }
  return Number(value)
}

export function readStringArray(value: unknown, label: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max
    || !value.every(item => typeof item === "string" && item.length <= 100)) {
    throw new AppError(400, label + "格式不正确")
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

export function validateBusinessCommand(raw: unknown): BusinessCommandEnvelope {
  if (!isObject(raw)) throw new AppError(400, "业务命令格式不正确")
  const requestId = readId(raw.requestId, "requestId")
  if (!BUSINESS_COMMAND_TYPES.includes(raw.type as BusinessCommandType)) {
    throw new AppError(400, "不支持的业务命令")
  }
  if (!isObject(raw.payload)) throw new AppError(400, "业务命令 payload 格式不正确")
  return { requestId, type: raw.type as BusinessCommandType, payload: raw.payload }
}
