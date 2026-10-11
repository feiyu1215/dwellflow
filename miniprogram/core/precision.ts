import { DomainError } from "./domain-error"

export const QUANTITY_SCALE = 1_000
export const UNIT_PRICE_SCALE = 10_000
const FEN_PER_YUAN = 100
const LINE_AMOUNT_DIVISOR = QUANTITY_SCALE * UNIT_PRICE_SCALE / FEN_PER_YUAN

function parseUnsignedDecimal(raw: string, scale: number, label: string): number {
  const value = raw.trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) throw new DomainError("INVALID_INPUT", label + "格式不正确")
  const fraction = match[2] || ""
  const digits = Math.log10(scale)
  if (fraction.length > digits) {
    throw new DomainError("INVALID_INPUT", label + "最多保留 " + digits + " 位小数")
  }
  const scaled = Number(match[1]) * scale + Number(fraction.padEnd(digits, "0"))
  if (!Number.isSafeInteger(scaled)) throw new DomainError("INVALID_INPUT", label + "超出可用范围")
  return scaled
}

export function parseQuantityMilli(raw: string): number {
  return parseUnsignedDecimal(raw, QUANTITY_SCALE, "数量")
}

export function parseUnitPriceTenThousandthYuan(raw: string): number {
  return parseUnsignedDecimal(raw, UNIT_PRICE_SCALE, "单价")
}

export function formatScaledDecimal(value: number, scale: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_INPUT", "数值必须是非负安全整数")
  }
  const digits = Math.log10(scale)
  const whole = Math.floor(value / scale)
  const fraction = String(value % scale).padStart(digits, "0").replace(/0+$/, "")
  return fraction ? whole + "." + fraction : String(whole)
}

export function formatQuantityMilli(value: number): string {
  return formatScaledDecimal(value, QUANTITY_SCALE)
}

export function lineAmountFen(quantityMilli: number, unitPriceTenThousandthYuan: number): number {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 0
    || !Number.isSafeInteger(unitPriceTenThousandthYuan) || unitPriceTenThousandthYuan < 0) {
    throw new DomainError("INVALID_INPUT", "数量和单价必须是非负安全整数")
  }
  const product = quantityMilli * unitPriceTenThousandthYuan
  if (!Number.isSafeInteger(product) || !Number.isSafeInteger(product + LINE_AMOUNT_DIVISOR / 2)) {
    throw new DomainError("INVALID_INPUT", "金额计算超出可用范围")
  }
  return Math.floor((product + LINE_AMOUNT_DIVISOR / 2) / LINE_AMOUNT_DIVISOR)
}
