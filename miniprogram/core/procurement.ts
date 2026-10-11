import { assertPositiveInteger, DomainError } from "./domain-error"
import { lineAmountFen } from "./precision"
import { receiptSummary, type ReceiptBatch } from "./material-flow"

export interface PurchaseLine {
  id: string
  projectId: string
  materialId: string
  agreementVersionId?: string
  orderedQuantityMilli: number
  unit: string
  status: "ordered" | "cancelled"
  createdAt: string
}

export interface UnitConversion {
  id: string
  materialId: string
  fromUnit: string
  toUnit: string
  numerator: number
  denominator: number
  version: number
}

export interface PurchaseLineSummary {
  grossReceivedMilli: number
  returnedSupplierMilli: number
  netReceivedMilli: number
  pendingReviewMilli: number
  pendingReturnMilli: number
  acceptedAvailableMilli: number
  remainingToReceiveMilli: number
  overReceivedMilli: number
  unknownQuantityBatchCount: number
  status: "cancelled" | "not_received" | "partial" | "received" | "over_received"
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_INPUT", label + "必须是非负安全整数")
  }
}

function safeAdd(current: number, value: number, label: string): number {
  const result = current + value
  if (!Number.isSafeInteger(result)) throw new DomainError("INVALID_INPUT", label + "超出可用范围")
  return result
}

export function createPurchaseLine(input: Omit<PurchaseLine, "status">): PurchaseLine {
  assertPositiveInteger(input.orderedQuantityMilli, "订单数量")
  if (!input.unit.trim()) throw new DomainError("INVALID_INPUT", "订单单位不能为空")
  return { ...input, unit: input.unit.trim(), status: "ordered" }
}

export function convertQuantityMilli(
  quantityMilli: number,
  fromUnit: string,
  toUnit: string,
  materialId: string,
  conversions: UnitConversion[]
): number {
  assertNonNegativeSafeInteger(quantityMilli, "换算数量")
  const from = fromUnit.trim()
  const to = toUnit.trim()
  if (!from || !to) throw new DomainError("INVALID_INPUT", "换算单位不能为空")
  if (from === to) return quantityMilli
  const conversion = conversions.find(item => item.materialId === materialId
    && ((item.fromUnit === from && item.toUnit === to)
      || (item.fromUnit === to && item.toUnit === from)))
  if (!conversion) throw new DomainError("STATE_CONFLICT", "缺少已确认的单位换算，不能汇总数量")
  assertPositiveInteger(conversion.numerator, "换算分子")
  assertPositiveInteger(conversion.denominator, "换算分母")
  const direct = conversion.fromUnit === from
  const numerator = direct ? conversion.numerator : conversion.denominator
  const denominator = direct ? conversion.denominator : conversion.numerator
  const product = quantityMilli * numerator
  if (!Number.isSafeInteger(product)) throw new DomainError("INVALID_INPUT", "换算数量超出可用范围")
  if (product % denominator !== 0) {
    throw new DomainError("INVALID_INPUT", "换算结果超出三位小数精度，请调整换算关系")
  }
  return product / denominator
}

export function purchaseLineSummary(
  line: PurchaseLine,
  batches: ReceiptBatch[],
  conversions: UnitConversion[] = []
): PurchaseLineSummary {
  let grossReceivedMilli = 0
  let returnedSupplierMilli = 0
  let pendingReviewMilli = 0
  let pendingReturnMilli = 0
  let acceptedAvailableMilli = 0
  let unknownQuantityBatchCount = 0
  for (const batch of batches.filter(item => item.purchaseLineId === line.id)) {
    if (batch.projectId !== line.projectId || batch.materialId !== line.materialId) {
      throw new DomainError("INVALID_INPUT", "到货批次与采购行不属于同一项目材料")
    }
    const summary = receiptSummary(batch)
    if (summary.receivedMilli === undefined) {
      unknownQuantityBatchCount += 1
      continue
    }
    const convert = (value: number) => convertQuantityMilli(
      value, batch.unit, line.unit, line.materialId, conversions
    )
    grossReceivedMilli = safeAdd(
      grossReceivedMilli, convert(summary.receivedMilli), "累计实到数量"
    )
    returnedSupplierMilli = safeAdd(
      returnedSupplierMilli, convert(summary.returnedSupplierMilli), "累计退货数量"
    )
    pendingReviewMilli = safeAdd(
      pendingReviewMilli, convert(summary.unresolvedMilli || 0), "累计待核对数量"
    )
    pendingReturnMilli = safeAdd(
      pendingReturnMilli, convert(summary.pendingReturnMilli), "累计待退货数量"
    )
    acceptedAvailableMilli = safeAdd(
      acceptedAvailableMilli, convert(summary.acceptedAvailableMilli), "累计确认可用数量"
    )
  }
  const netReceivedMilli = grossReceivedMilli - returnedSupplierMilli
  const remainingToReceiveMilli = line.status === "cancelled"
    ? 0
    : Math.max(line.orderedQuantityMilli - netReceivedMilli, 0)
  const overReceivedMilli = Math.max(netReceivedMilli - line.orderedQuantityMilli, 0)
  const status = line.status === "cancelled"
    ? "cancelled"
    : overReceivedMilli > 0
      ? "over_received"
      : netReceivedMilli === 0
        ? "not_received"
        : remainingToReceiveMilli > 0
          ? "partial"
          : "received"
  return {
    grossReceivedMilli,
    returnedSupplierMilli,
    netReceivedMilli,
    pendingReviewMilli,
    pendingReturnMilli,
    acceptedAvailableMilli,
    remainingToReceiveMilli,
    overReceivedMilli,
    unknownQuantityBatchCount,
    status
  }
}

export interface ProcurementEstimateInput {
  requiredQuantityMilli: number
  wasteRatePermille: number
  requirementIncludesWaste: boolean
  packageSizeMilli: number
  packageUnitPriceTenThousandthYuan?: number
}

export interface ProcurementEstimate {
  quantityWithWasteMilli: number
  packageCount: number
  purchaseQuantityMilli: number
  amountFen?: number
  amountComplete: boolean
}

function ceilDivide(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator)
}

export function calculateProcurementEstimate(
  input: ProcurementEstimateInput
): ProcurementEstimate {
  assertPositiveInteger(input.requiredQuantityMilli, "工程需求量")
  assertPositiveInteger(input.packageSizeMilli, "整包数量")
  assertNonNegativeSafeInteger(input.wasteRatePermille, "损耗率")
  const wasteMultiplier = input.requirementIncludesWaste ? 1_000 : 1_000 + input.wasteRatePermille
  const wasteProduct = input.requiredQuantityMilli * wasteMultiplier
  if (!Number.isSafeInteger(wasteProduct)) {
    throw new DomainError("INVALID_INPUT", "含损耗数量超出可用范围")
  }
  const quantityWithWasteMilli = ceilDivide(wasteProduct, 1_000)
  const packageCount = ceilDivide(quantityWithWasteMilli, input.packageSizeMilli)
  const purchaseQuantityMilli = packageCount * input.packageSizeMilli
  if (!Number.isSafeInteger(purchaseQuantityMilli)) {
    throw new DomainError("INVALID_INPUT", "采购数量超出可用范围")
  }
  if (input.packageUnitPriceTenThousandthYuan !== undefined) {
    assertNonNegativeSafeInteger(input.packageUnitPriceTenThousandthYuan, "整包单价")
  }
  return {
    quantityWithWasteMilli,
    packageCount,
    purchaseQuantityMilli,
    amountFen: input.packageUnitPriceTenThousandthYuan === undefined
      ? undefined
      : lineAmountFen(packageCount * 1_000, input.packageUnitPriceTenThousandthYuan),
    amountComplete: input.packageUnitPriceTenThousandthYuan !== undefined
  }
}

export interface ResourceGap {
  minimumGapMilli: number
  maximumGapMilli: number
  pendingVerificationMilli: number
}

export function calculateResourceGap(input: {
  totalRequirementMilli: number
  confirmedConsumedMilli: number
  availableInventoryMilli: number
  verifiableIssuedUnusedMilli: number
  validInTransitMilli: number
  issuedWhereaboutsUnknownMilli: number
}): ResourceGap {
  for (const [label, value] of Object.entries(input)) {
    assertNonNegativeSafeInteger(value, label)
  }
  const knownCoverage = input.confirmedConsumedMilli
    + input.availableInventoryMilli
    + input.verifiableIssuedUnusedMilli
    + input.validInTransitMilli
  if (!Number.isSafeInteger(knownCoverage)) {
    throw new DomainError("INVALID_INPUT", "资源缺口计算超出可用范围")
  }
  const maximumGapMilli = Math.max(input.totalRequirementMilli - knownCoverage, 0)
  return {
    minimumGapMilli: Math.max(maximumGapMilli - input.issuedWhereaboutsUnknownMilli, 0),
    maximumGapMilli,
    pendingVerificationMilli: input.issuedWhereaboutsUnknownMilli
  }
}
