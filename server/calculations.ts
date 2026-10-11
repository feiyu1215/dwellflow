import type { AiInput } from "../miniprogram/core/ai-contract.ts"

// Derived from selected snapshots only; never interpreted as project-wide totals.
export function calculateSelectedBudget(input: AiInput) {
  const rows: Array<{ sourceId: string; label: string; amountFen: number; requiredQuantity?: number }> = []
  const unknowns: string[] = []
  for (const source of input.sources) {
    if (source.kind !== "material" && source.kind !== "expense") continue
    try {
      const value = JSON.parse(source.text)
      if (source.kind === "expense") {
        if (!Number.isSafeInteger(value.amountFen) || value.amountFen <= 0
          || !["quote", "approve_increase", "approve_decrease", "payment", "refund"].includes(value.action)) throw new Error()
        rows.push({ sourceId: source.id, label: value.action, amountFen: value.amountFen })
      } else {
        if (typeof value.unit !== "string" || !value.unit.trim()
          || !Number.isFinite(value.plannedQuantity) || value.plannedQuantity <= 0
          || !Number.isSafeInteger(value.unitPriceFen) || value.unitPriceFen < 0
          || !Number.isSafeInteger(value.wasteRatePermille) || value.wasteRatePermille < 0
          || value.wasteRatePermille > 1000) throw new Error()
        const requiredQuantity = Math.round(value.plannedQuantity * (1000 + value.wasteRatePermille)) / 1000
        const amountFen = Math.round(requiredQuantity * value.unitPriceFen)
        if (!Number.isSafeInteger(amountFen) || amountFen < 0) throw new Error()
        rows.push({ sourceId: source.id, label: "material_estimate", amountFen, requiredQuantity })
      }
    } catch { unknowns.push(source.id + "：字段缺失或格式无效，未计算；需明确数量、单位、单价及损耗假设") }
  }
  return {
    scope: "所选资料逐条计算，单位为分；报价、批准、付款和材料估算分别展示，不相加，也不代表项目总预算",
    rows, unknowns
  }
}
