export type DomainErrorCode =
  | "INVALID_INPUT"
  | "VERSION_CONFLICT"
  | "STATE_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "INSUFFICIENT_QUANTITY"

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message: string) {
    super(message)
    this.name = "DomainError"
    this.code = code
  }
}

export function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new DomainError("VERSION_CONFLICT", "数据已被更新，请核对最新版本后重试")
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError("INVALID_INPUT", label + "必须是大于 0 的安全整数")
  }
}
