import type { BudgetScenarioReview } from "./ai-contract"
import type {
  AppState,
  BudgetFinanceSnapshot,
  BudgetResourceFacts,
  BudgetScenarioCalculation
} from "./domain"
import { DomainError } from "./domain-error"
import { financeSummary } from "./finance"
import { inventoryBalanceMilli, receiptSummary } from "./material-flow"
import {
  calculateProcurementEstimate,
  calculateResourceGap,
  convertQuantityMilli,
  purchaseLineSummary,
  type ProcurementEstimate
} from "./procurement"
import { parseQuantityMilli, parseUnitPriceTenThousandthYuan } from "./precision"

function safeAdd(current: number, value: number, label: string): number {
  const next = current + value
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new DomainError("INVALID_INPUT", `${label}超出可用范围`)
  }
  return next
}

export function parseWasteRatePermille(value: string): number {
  const normalized = value.trim()
  if (!/^\d+(\.\d)?$/.test(normalized)) {
    throw new DomainError("INVALID_INPUT", "损耗率最多保留 1 位小数")
  }
  const result = Math.round(Number(normalized) * 10)
  if (!Number.isSafeInteger(result) || result < 0 || result > 1_000) {
    throw new DomainError("INVALID_INPUT", "损耗率必须在 0% 到 100% 之间")
  }
  return result
}

export function parseBudgetScenarioReview(review: BudgetScenarioReview) {
  const label = review.label.trim()
  const unit = review.unit.trim()
  if (!label) throw new DomainError("INVALID_INPUT", "方案名称不能为空")
  if (!unit) throw new DomainError("INVALID_INPUT", "计算单位不能为空")
  if (!review.included) throw new DomainError("INVALID_INPUT", "未选中的方案不能参与计算")
  const requiredQuantityMilli = parseQuantityMilli(review.requiredQuantity)
  const packageSizeMilli = parseQuantityMilli(review.packageSize)
  if (requiredQuantityMilli <= 0) throw new DomainError("INVALID_INPUT", "工程需求量必须大于 0")
  if (packageSizeMilli <= 0) throw new DomainError("INVALID_INPUT", "整包数量必须大于 0")
  const price = review.packageUnitPriceYuan.trim()
    ? parseUnitPriceTenThousandthYuan(review.packageUnitPriceYuan)
    : undefined
  return {
    scenarioId: review.scenarioId,
    label,
    materialId: review.materialSourceId || undefined,
    unit,
    requiredQuantityMilli,
    wasteRatePermille: parseWasteRatePermille(review.wasteRatePercent),
    requirementIncludesWaste: review.requirementIncludesWaste === "yes",
    packageSizeMilli,
    packageUnitPriceTenThousandthYuan: price,
    note: review.note.trim()
  }
}

function zeroPurchaseEstimate(price?: number): ProcurementEstimate {
  return {
    quantityWithWasteMilli: 0,
    packageCount: 0,
    purchaseQuantityMilli: 0,
    amountFen: price === undefined ? undefined : 0,
    amountComplete: price !== undefined
  }
}

function purchaseForGap(
  gapMilli: number,
  packageSizeMilli: number,
  packageUnitPriceTenThousandthYuan?: number
): ProcurementEstimate {
  if (gapMilli === 0) return zeroPurchaseEstimate(packageUnitPriceTenThousandthYuan)
  return calculateProcurementEstimate({
    requiredQuantityMilli: gapMilli,
    wasteRatePermille: 0,
    requirementIncludesWaste: true,
    packageSizeMilli,
    packageUnitPriceTenThousandthYuan
  })
}

function materialResourceFacts(
  state: AppState,
  projectId: string,
  materialId: string,
  scenarioUnit: string
): { facts: BudgetResourceFacts; complete: boolean } {
  const material = state.materials.find(item =>
    item.id === materialId && item.projectId === projectId)
  if (!material) throw new DomainError("NOT_FOUND", "关联材料已不存在")
  const warnings: string[] = []
  let complete = true
  const convert = (quantityMilli: number, fromUnit: string, label: string) => {
    try {
      return convertQuantityMilli(
        quantityMilli,
        fromUnit,
        scenarioUnit,
        materialId,
        state.unitConversions
      )
    } catch {
      complete = false
      warnings.push(`${label}使用“${fromUnit}”，缺少到“${scenarioUnit}”的已确认换算，未计入缺口`)
      return 0
    }
  }

  const confirmedConsumedBase = state.materialUsageRecords
    .filter(item => item.projectId === projectId && item.materialId === materialId)
    .reduce((sum, item) => safeAdd(sum, item.quantityMilli, "已确认使用量"), 0)
  const confirmedConsumedMilli = convert(
    confirmedConsumedBase, material.unit, "已确认施工使用量"
  )
  const availableInventoryMilli = convert(
    inventoryBalanceMilli(state.materialInventoryEvents, materialId),
    material.unit,
    "可用库存"
  )

  let issuedWhereaboutsUnknownMilli = 0
  for (const issued of state.materialInventoryEvents.filter(item =>
    item.projectId === projectId && item.materialId === materialId && item.action === "issued")) {
    const used = state.materialUsageRecords
      .filter(item => item.issuedEventId === issued.id)
      .reduce((sum, item) => safeAdd(sum, item.quantityMilli, "领用后使用量"), 0)
    const returned = state.materialInventoryEvents
      .filter(item => item.action === "returned_site" && item.sourceEventId === issued.id)
      .reduce((sum, item) => safeAdd(sum, item.quantityMilli, "现场退回量"), 0)
    const unresolved = Math.max(issued.quantityMilli - used - returned, 0)
    issuedWhereaboutsUnknownMilli = safeAdd(
      issuedWhereaboutsUnknownMilli,
      convert(unresolved, issued.unit, "去向待核实的领用量"),
      "去向待核实的领用量"
    )
  }

  let validInTransitMilli = 0
  for (const line of state.purchaseLines.filter(item =>
    item.projectId === projectId && item.materialId === materialId && item.status !== "cancelled")) {
    try {
      const summary = purchaseLineSummary(line, state.receiptBatches, state.unitConversions)
      if (summary.unknownQuantityBatchCount > 0) {
        complete = false
        warnings.push("有到货批次尚未填写实到数量，对应采购在途量未计入缺口")
        continue
      }
      validInTransitMilli = safeAdd(
        validInTransitMilli,
        convert(summary.remainingToReceiveMilli, line.unit, "有效在途量"),
        "有效在途量"
      )
    } catch {
      complete = false
      warnings.push("采购或到货单位缺少已确认换算，对应在途量未计入缺口")
    }
  }

  let pendingReceiptMilli = 0
  for (const batch of state.receiptBatches.filter(item =>
    item.projectId === projectId && item.materialId === materialId)) {
    const unresolved = receiptSummary(batch).unresolvedMilli || 0
    pendingReceiptMilli = safeAdd(
      pendingReceiptMilli,
      convert(unresolved, batch.unit, "待核对到货量"),
      "待核对到货量"
    )
  }

  return {
    complete,
    facts: {
      confirmedConsumedMilli,
      availableInventoryMilli,
      verifiableIssuedUnusedMilli: 0,
      validInTransitMilli,
      pendingVerificationMilli: safeAdd(
        issuedWhereaboutsUnknownMilli,
        pendingReceiptMilli,
        "待核实资源量"
      ),
      warnings: Array.from(new Set(warnings))
    }
  }
}

export function calculateBudgetScenario(
  state: AppState,
  projectId: string,
  review: BudgetScenarioReview
): BudgetScenarioCalculation {
  const parsed = parseBudgetScenarioReview(review)
  const totalRequirement = calculateProcurementEstimate({
    requiredQuantityMilli: parsed.requiredQuantityMilli,
    wasteRatePermille: parsed.wasteRatePermille,
    requirementIncludesWaste: parsed.requirementIncludesWaste,
    packageSizeMilli: parsed.packageSizeMilli,
    packageUnitPriceTenThousandthYuan: parsed.packageUnitPriceTenThousandthYuan
  })
  if (!parsed.materialId) {
    return {
      ...parsed,
      totalRequirement,
      recommendedPurchase: totalRequirement
    }
  }
  const resource = materialResourceFacts(
    state, projectId, parsed.materialId, parsed.unit
  )
  if (!resource.complete) {
    return { ...parsed, totalRequirement, resourceFacts: resource.facts }
  }
  const resourceGap = calculateResourceGap({
    totalRequirementMilli: totalRequirement.quantityWithWasteMilli,
    confirmedConsumedMilli: resource.facts.confirmedConsumedMilli,
    availableInventoryMilli: resource.facts.availableInventoryMilli,
    verifiableIssuedUnusedMilli: resource.facts.verifiableIssuedUnusedMilli,
    validInTransitMilli: resource.facts.validInTransitMilli,
    issuedWhereaboutsUnknownMilli: resource.facts.pendingVerificationMilli
  })
  return {
    ...parsed,
    totalRequirement,
    resourceFacts: resource.facts,
    resourceGap,
    recommendedPurchase: purchaseForGap(
      resourceGap.maximumGapMilli,
      parsed.packageSizeMilli,
      parsed.packageUnitPriceTenThousandthYuan
    )
  }
}

export function selectedFinanceSnapshots(
  state: AppState,
  projectId: string,
  selectedSourceIds: Set<string>
): BudgetFinanceSnapshot[] {
  return state.costItems
    .filter(item => item.projectId === projectId && selectedSourceIds.has(item.id))
    .map(item => ({
      costItemId: item.id,
      title: item.title,
      quotedAmountFen: item.quotedAmountFen,
      summary: financeSummary(
        state.costApprovals.filter(event => event.costItemId === item.id),
        state.paymentFacts.filter(event => event.costItemId === item.id),
        state.refundFacts.filter(event => event.costItemId === item.id)
      )
    }))
}
