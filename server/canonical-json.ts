import { createHash } from "node:crypto"

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value))
}

export function commandHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}
