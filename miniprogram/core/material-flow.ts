import { assertExpectedVersion, assertPositiveInteger, DomainError } from "./domain-error"

export interface ReceiptQuantityEvent {
  id: string
  requestId: string
  kind: "submitted" | "corrected"
  quantityMilli: number
  reason?: string
  actorId: string
  createdAt: string
}

export interface ReceiptAllocationEvent {
  id: string
  requestId: string
  kind: "accepted_available" | "marked_return" | "completed_return"
  quantityMilli: number
  actorId: string
  createdAt: string
}

export interface ReceiptBatch {
  id: string
  projectId: string
  purchaseLineId?: string
  materialId: string
  unit: string
  occurredAt: string
  version: number
  quantityEvents: ReceiptQuantityEvent[]
  allocationEvents: ReceiptAllocationEvent[]
}

export interface ReceiptSummary {
  receivedMilli?: number
  acceptedAvailableMilli: number
  markedReturnMilli: number
  returnedSupplierMilli: number
  pendingReturnMilli: number
  unresolvedMilli?: number
  status: "draft" | "pending_review" | "awaiting_return" | "resolved"
}

type ReceiptEvent = ReceiptQuantityEvent | ReceiptAllocationEvent

function sameReceiptEvent(
  event: ReceiptEvent,
  input: { kind: ReceiptEvent["kind"]; quantityMilli: number }
): boolean {
  return event.kind === input.kind && event.quantityMilli === input.quantityMilli
}

function replayedReceiptCommand(
  batch: ReceiptBatch,
  input: { requestId: string; kind: ReceiptEvent["kind"]; quantityMilli: number }
): boolean {
  const event = [...batch.quantityEvents, ...batch.allocationEvents]
    .find(item => item.requestId === input.requestId)
  if (!event) return false
  if (!sameReceiptEvent(event, input)) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的到货操作")
  }
  return true
}

export function createReceiptBatch(input: {
  id: string
  projectId: string
  purchaseLineId?: string
  materialId: string
  unit: string
  occurredAt: string
  quantity?: {
    id: string
    requestId: string
    quantityMilli: number
    actorId: string
    createdAt: string
  }
}): ReceiptBatch {
  if (!input.unit.trim()) throw new DomainError("INVALID_INPUT", "到货单位不能为空")
  const quantityEvents: ReceiptQuantityEvent[] = []
  if (input.quantity) {
    assertPositiveInteger(input.quantity.quantityMilli, "实到数量")
    quantityEvents.push({ ...input.quantity, kind: "submitted" })
  }
  return {
    id: input.id,
    projectId: input.projectId,
    purchaseLineId: input.purchaseLineId,
    materialId: input.materialId,
    unit: input.unit.trim(),
    occurredAt: input.occurredAt,
    version: 1,
    quantityEvents,
    allocationEvents: []
  }
}

export function currentReceiptQuantityMilli(batch: ReceiptBatch): number | undefined {
  return batch.quantityEvents.at(-1)?.quantityMilli
}

export function receiptSummary(batch: ReceiptBatch): ReceiptSummary {
  const receivedMilli = currentReceiptQuantityMilli(batch)
  const acceptedAvailableMilli = batch.allocationEvents
    .filter(item => item.kind === "accepted_available")
    .reduce((sum, item) => sum + item.quantityMilli, 0)
  const markedReturnMilli = batch.allocationEvents
    .filter(item => item.kind === "marked_return")
    .reduce((sum, item) => sum + item.quantityMilli, 0)
  const returnedSupplierMilli = batch.allocationEvents
    .filter(item => item.kind === "completed_return")
    .reduce((sum, item) => sum + item.quantityMilli, 0)
  const pendingReturnMilli = markedReturnMilli - returnedSupplierMilli
  const unresolvedMilli = receivedMilli === undefined
    ? undefined
    : receivedMilli - acceptedAvailableMilli - markedReturnMilli
  const status = receivedMilli === undefined
    ? "draft"
    : unresolvedMilli! > 0
      ? "pending_review"
      : pendingReturnMilli > 0
        ? "awaiting_return"
        : "resolved"
  return {
    receivedMilli,
    acceptedAvailableMilli,
    markedReturnMilli,
    returnedSupplierMilli,
    pendingReturnMilli,
    unresolvedMilli,
    status
  }
}

export function correctReceiptQuantity(
  batch: ReceiptBatch,
  input: {
    id: string
    requestId: string
    expectedVersion: number
    quantityMilli: number
    reason: string
    actorId: string
    createdAt: string
  }
): ReceiptBatch {
  assertPositiveInteger(input.quantityMilli, "实到数量")
  if (replayedReceiptCommand(batch, { ...input, kind: "corrected" })) return batch
  assertExpectedVersion(batch.version, input.expectedVersion)
  if (!input.reason.trim()) throw new DomainError("INVALID_INPUT", "提交后的数量更正必须填写原因")
  const summary = receiptSummary(batch)
  const allocated = summary.acceptedAvailableMilli + summary.markedReturnMilli
  if (input.quantityMilli < allocated) {
    throw new DomainError("INSUFFICIENT_QUANTITY", "更正后的实到数量不能小于已处理数量")
  }
  const event: ReceiptQuantityEvent = {
    id: input.id,
    requestId: input.requestId,
    kind: "corrected",
    quantityMilli: input.quantityMilli,
    reason: input.reason.trim(),
    actorId: input.actorId,
    createdAt: input.createdAt
  }
  return {
    ...batch,
    version: batch.version + 1,
    quantityEvents: [...batch.quantityEvents, event]
  }
}

export function allocateReceipt(
  batch: ReceiptBatch,
  input: {
    id: string
    requestId: string
    expectedVersion: number
    kind: "accepted_available" | "marked_return" | "completed_return"
    quantityMilli: number
    actorId: string
    createdAt: string
  }
): ReceiptBatch {
  assertPositiveInteger(input.quantityMilli, "处理数量")
  if (replayedReceiptCommand(batch, input)) return batch
  assertExpectedVersion(batch.version, input.expectedVersion)
  const summary = receiptSummary(batch)
  if (summary.receivedMilli === undefined) {
    throw new DomainError("STATE_CONFLICT", "实到数量未知，不能处理到货数量")
  }
  if (input.kind === "completed_return") {
    if (input.quantityMilli > summary.pendingReturnMilli) {
      throw new DomainError("INSUFFICIENT_QUANTITY", "实际退货数量不能超过待退货数量")
    }
  } else if (summary.unresolvedMilli === undefined || input.quantityMilli > summary.unresolvedMilli) {
    throw new DomainError("INSUFFICIENT_QUANTITY", "处理数量不能超过尚未分配的实到数量")
  }
  const event: ReceiptAllocationEvent = {
    id: input.id,
    requestId: input.requestId,
    kind: input.kind,
    quantityMilli: input.quantityMilli,
    actorId: input.actorId,
    createdAt: input.createdAt
  }
  return {
    ...batch,
    version: batch.version + 1,
    allocationEvents: [...batch.allocationEvents, event]
  }
}

export type MaterialInventoryAction =
  | "available_received"
  | "issued"
  | "returned_site"
  | "returned_supplier"
  | "warehouse_waste"
  | "adjustment_increase"
  | "adjustment_decrease"

export interface MaterialInventoryEvent {
  id: string
  requestId: string
  projectId: string
  materialId: string
  unit: string
  action: MaterialInventoryAction
  quantityMilli: number
  sourceEventId?: string
  sourceReceiptAllocationId?: string
  reason?: string
  actorId: string
  createdAt: string
}

export interface MaterialUsageRecord {
  id: string
  requestId: string
  projectId: string
  materialId: string
  issuedEventId: string
  quantityMilli: number
  actorId: string
  createdAt: string
}

const INVENTORY_DIRECTION: Record<MaterialInventoryAction, 1 | -1> = {
  available_received: 1,
  issued: -1,
  returned_site: 1,
  returned_supplier: -1,
  warehouse_waste: -1,
  adjustment_increase: 1,
  adjustment_decrease: -1
}

export function inventoryBalanceMilli(events: MaterialInventoryEvent[], materialId: string): number {
  return events
    .filter(item => item.materialId === materialId)
    .reduce((sum, item) => sum + INVENTORY_DIRECTION[item.action] * item.quantityMilli, 0)
}

function sameInventoryCommand(
  existing: MaterialInventoryEvent,
  input: MaterialInventoryEvent
): boolean {
  return existing.projectId === input.projectId
    && existing.materialId === input.materialId
    && existing.unit === input.unit.trim()
    && existing.action === input.action
    && existing.quantityMilli === input.quantityMilli
    && existing.sourceEventId === input.sourceEventId
    && existing.sourceReceiptAllocationId === input.sourceReceiptAllocationId
    && (existing.reason || "") === (input.reason?.trim() || "")
    && existing.actorId === input.actorId
}

function sameUsageCommand(
  existing: MaterialUsageRecord,
  input: MaterialUsageRecord
): boolean {
  return existing.projectId === input.projectId
    && existing.materialId === input.materialId
    && existing.issuedEventId === input.issuedEventId
    && existing.quantityMilli === input.quantityMilli
    && existing.actorId === input.actorId
}

function consumedIssuedQuantityMilli(
  events: MaterialInventoryEvent[],
  usages: MaterialUsageRecord[],
  issuedEventId: string
): number {
  const returned = events
    .filter(item => item.action === "returned_site" && item.sourceEventId === issuedEventId)
    .reduce((sum, item) => sum + item.quantityMilli, 0)
  const used = usages
    .filter(item => item.issuedEventId === issuedEventId)
    .reduce((sum, item) => sum + item.quantityMilli, 0)
  return returned + used
}

export function appendInventoryEvent(
  events: MaterialInventoryEvent[],
  usages: MaterialUsageRecord[],
  input: MaterialInventoryEvent
): MaterialInventoryEvent[] {
  assertPositiveInteger(input.quantityMilli, "库存数量")
  const existing = events.find(item => item.requestId === input.requestId)
  if (existing) {
    if (!sameInventoryCommand(existing, input)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的库存操作")
    }
    return events
  }
  if (!input.unit.trim()) throw new DomainError("INVALID_INPUT", "库存单位不能为空")
  if (input.action === "available_received" && !input.sourceReceiptAllocationId) {
    throw new DomainError("INVALID_INPUT", "确认可用入库必须关联到货处理记录")
  }
  if ((input.action === "adjustment_increase" || input.action === "adjustment_decrease")
    && !input.reason?.trim()) {
    throw new DomainError("INVALID_INPUT", "盘点调整必须填写原因")
  }
  if (input.action === "returned_site") {
    const issued = events.find(item => item.id === input.sourceEventId
      && item.action === "issued" && item.materialId === input.materialId)
    if (!issued) throw new DomainError("NOT_FOUND", "现场退回必须关联原领用记录")
    const remaining = issued.quantityMilli - consumedIssuedQuantityMilli(events, usages, issued.id)
    if (input.quantityMilli > remaining) {
      throw new DomainError("INSUFFICIENT_QUANTITY", "现场退回和已使用数量不能超过原领用数量")
    }
  }
  const projected = inventoryBalanceMilli(events, input.materialId)
    + INVENTORY_DIRECTION[input.action] * input.quantityMilli
  if (projected < 0) throw new DomainError("INSUFFICIENT_QUANTITY", "库存操作会使可用数量小于 0")
  return [...events, { ...input, reason: input.reason?.trim() }]
}

export function appendUsageRecord(
  events: MaterialInventoryEvent[],
  usages: MaterialUsageRecord[],
  input: MaterialUsageRecord
): MaterialUsageRecord[] {
  assertPositiveInteger(input.quantityMilli, "使用数量")
  const existing = usages.find(item => item.requestId === input.requestId)
  if (existing) {
    if (!sameUsageCommand(existing, input)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的使用记录")
    }
    return usages
  }
  const issued = events.find(item => item.id === input.issuedEventId
    && item.action === "issued" && item.materialId === input.materialId)
  if (!issued) throw new DomainError("NOT_FOUND", "施工使用必须关联原领用记录")
  const remaining = issued.quantityMilli - consumedIssuedQuantityMilli(events, usages, issued.id)
  if (input.quantityMilli > remaining) {
    throw new DomainError("INSUFFICIENT_QUANTITY", "施工使用和现场退回不能超过原领用数量")
  }
  return [...usages, input]
}
