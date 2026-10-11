import { assertExpectedVersion, assertPositiveInteger, DomainError } from "./domain-error"

export interface CostApprovalEvent {
  id: string
  requestId: string
  projectId: string
  costItemId: string
  action: "initial" | "increase" | "decrease"
  amountFen: number
  reason: string
  actorId: string
  createdAt: string
}

export type FinancialFactStatus = "pending_confirmation" | "confirmed" | "rejected"

export interface PaymentFact {
  id: string
  requestId: string
  projectId: string
  costItemId: string
  amountFen: number
  status: FinancialFactStatus
  version: number
  submittedBy: string
  occurredAt: string
  createdAt: string
  decidedBy?: string
  decidedAt?: string
}

export interface RefundFact {
  id: string
  requestId: string
  projectId: string
  costItemId: string
  paymentId: string
  amountFen: number
  status: FinancialFactStatus
  version: number
  submittedBy: string
  occurredAt: string
  createdAt: string
  decidedBy?: string
  decidedAt?: string
}

export interface FinanceSummary {
  approvedFen: number
  paidFen: number
  refundedFen: number
  netPaidFen: number
  outstandingFen: number
  overApprovedFen: number
  pendingPaymentFen: number
  pendingRefundFen: number
}

function safeSum(values: number[], label: string): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) throw new DomainError("INVALID_INPUT", label + "超出可用范围")
  return total
}

export function approvedAmountFen(events: CostApprovalEvent[]): number {
  return safeSum(events.map(item => item.action === "decrease" ? -item.amountFen : item.amountFen), "批准金额")
}

export function appendApprovalEvent(
  events: CostApprovalEvent[],
  input: CostApprovalEvent
): CostApprovalEvent[] {
  assertPositiveInteger(input.amountFen, "批准金额")
  const existing = events.find(item => item.requestId === input.requestId)
  if (existing) {
    const same = existing.costItemId === input.costItemId
      && existing.action === input.action
      && existing.amountFen === input.amountFen
    if (!same) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的费用批准")
    return events
  }
  const current = approvedAmountFen(events.filter(item => item.costItemId === input.costItemId))
  if (input.action === "decrease" && input.amountFen > current) {
    throw new DomainError("INSUFFICIENT_QUANTITY", "批准调减不能使费用批准额小于 0")
  }
  return [...events, { ...input, reason: input.reason.trim() }]
}

export function createPaymentFact(input: Omit<PaymentFact, "status" | "version">): PaymentFact {
  assertPositiveInteger(input.amountFen, "付款金额")
  return { ...input, status: "pending_confirmation", version: 1 }
}

export function decidePaymentFact(
  payment: PaymentFact,
  input: {
    decision: "confirmed" | "rejected"
    expectedVersion: number
    actorId: string
    now: string
  }
): PaymentFact {
  assertExpectedVersion(payment.version, input.expectedVersion)
  if (payment.status !== "pending_confirmation") {
    throw new DomainError("STATE_CONFLICT", "只有待确认付款事实可以处理")
  }
  return {
    ...payment,
    status: input.decision,
    version: payment.version + 1,
    decidedBy: input.actorId,
    decidedAt: input.now
  }
}

export function createRefundFact(
  payment: PaymentFact,
  existingRefunds: RefundFact[],
  input: Omit<RefundFact, "status" | "version">
): RefundFact {
  assertPositiveInteger(input.amountFen, "退款金额")
  if (payment.status !== "confirmed") {
    throw new DomainError("STATE_CONFLICT", "只有已确认付款可以登记退款")
  }
  if (payment.id !== input.paymentId || payment.costItemId !== input.costItemId
    || payment.projectId !== input.projectId) {
    throw new DomainError("INVALID_INPUT", "退款必须关联同一项目和费用的原付款")
  }
  const reserved = safeSum(existingRefunds
    .filter(item => item.paymentId === payment.id && item.status !== "rejected")
    .map(item => item.amountFen), "退款金额")
  if (reserved + input.amountFen > payment.amountFen) {
    throw new DomainError("INSUFFICIENT_QUANTITY", "累计退款不能超过所关联付款")
  }
  return { ...input, status: "pending_confirmation", version: 1 }
}

export function decideRefundFact(
  refund: RefundFact,
  input: {
    decision: "confirmed" | "rejected"
    expectedVersion: number
    actorId: string
    now: string
  }
): RefundFact {
  assertExpectedVersion(refund.version, input.expectedVersion)
  if (refund.status !== "pending_confirmation") {
    throw new DomainError("STATE_CONFLICT", "只有待确认退款事实可以处理")
  }
  return {
    ...refund,
    status: input.decision,
    version: refund.version + 1,
    decidedBy: input.actorId,
    decidedAt: input.now
  }
}

export function financeSummary(
  approvals: CostApprovalEvent[],
  payments: PaymentFact[],
  refunds: RefundFact[]
): FinanceSummary {
  const approvedFen = approvedAmountFen(approvals)
  const paidFen = safeSum(payments
    .filter(item => item.status === "confirmed")
    .map(item => item.amountFen), "付款金额")
  const refundedFen = safeSum(refunds
    .filter(item => item.status === "confirmed")
    .map(item => item.amountFen), "退款金额")
  const netPaidFen = paidFen - refundedFen
  return {
    approvedFen,
    paidFen,
    refundedFen,
    netPaidFen,
    outstandingFen: Math.max(approvedFen - netPaidFen, 0),
    overApprovedFen: Math.max(netPaidFen - approvedFen, 0),
    pendingPaymentFen: safeSum(payments
      .filter(item => item.status === "pending_confirmation")
      .map(item => item.amountFen), "待确认付款金额"),
    pendingRefundFen: safeSum(refunds
      .filter(item => item.status === "pending_confirmation")
      .map(item => item.amountFen), "待确认退款金额")
  }
}
