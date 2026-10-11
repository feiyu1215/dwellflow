import { readFileSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import type {
  AiInput,
  AiResult,
  AiSource,
  AiUsage,
  MaterialCheckField,
  MaterialCheckFieldKey,
  MaterialCheckFieldStatus
} from "../miniprogram/core/ai-contract.ts"
import { MATERIAL_CHECK_FIELD_KEYS } from "../miniprogram/core/ai-contract.ts"
import { validateInput } from "./validation.ts"

const FIELD_STATUSES: MaterialCheckFieldStatus[] = [
  "matches", "differs", "observed_only", "expected_only", "unknown"
]

export interface MaterialEvaluationImage {
  sourceId: string
  path: string
}

export interface MaterialFieldExpectation {
  key: MaterialCheckFieldKey
  statusOneOf?: MaterialCheckFieldStatus[]
  observedIncludesAny?: string[]
  expectedIncludesAny?: string[]
  observedSourceIdsInclude?: string[]
  expectedSourceIdsInclude?: string[]
}

export interface MaterialEvaluationCase {
  id: string
  title: string
  critical: boolean
  tags: string[]
  input: AiInput
  expected: { fields: MaterialFieldExpectation[] }
  imageCount: number
}

export interface MaterialEvaluationDataset {
  version: 1
  name: string
  thresholds: EvaluationThresholds
  cases: MaterialEvaluationCase[]
}

export function selectMaterialEvaluationCases(
  cases: MaterialEvaluationCase[],
  caseIds?: string[],
  maxCases?: number
): MaterialEvaluationCase[] {
  if (maxCases !== undefined && (!Number.isSafeInteger(maxCases) || maxCases < 1)) {
    throw new Error("--max-cases 必须是正整数")
  }
  let selected = cases
  if (caseIds?.length) {
    if (new Set(caseIds).size !== caseIds.length) throw new Error("--case-ids 不能包含重复 ID")
    const byId = new Map(cases.map(item => [item.id, item]))
    selected = caseIds.map(id => {
      const item = byId.get(id)
      if (!item) throw new Error("评测集不存在用例：" + id)
      return item
    })
  }
  return maxCases === undefined ? selected : selected.slice(0, maxCases)
}

export function mergeEvaluationOutcomes(
  expectedCaseIds: string[],
  groups: EvaluationCaseOutcome[][]
): EvaluationCaseOutcome[] {
  const expected = new Set(expectedCaseIds)
  if (expected.size !== expectedCaseIds.length) throw new Error("评测集包含重复用例 ID")
  const selected = new Map<string, EvaluationCaseOutcome>()
  for (const group of groups) {
    for (const outcome of group) {
      if (!expected.has(outcome.id)) throw new Error("报告包含评测集以外的用例：" + outcome.id)
      selected.set(outcome.id, outcome)
    }
  }
  const missing = expectedCaseIds.filter(id => !selected.has(id))
  if (missing.length) throw new Error("合并报告缺少用例：" + missing.join(", "))
  return expectedCaseIds.map(id => selected.get(id)!)
}

export interface EvaluationThresholds {
  contractPassRate: number
  assertionPassRate: number
  criticalCasePassRate: number
}

export interface EvaluationAssertion {
  name: string
  passed: boolean
  expected: string
  actual: string
}

export interface MaterialCaseScore {
  passed: boolean
  passedAssertions: number
  totalAssertions: number
  assertions: EvaluationAssertion[]
}

export interface EvaluationCaseOutcome {
  id: string
  title: string
  critical: boolean
  tags: string[]
  imageCount: number
  contractValid: boolean
  durationMs: number
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
  score: MaterialCaseScore
  result?: {
    summary: string
    unknowns: string[]
    fields: MaterialCheckField[]
  }
  invalidOutputPreview?: string
  error?: string
}

export interface EvaluationSummary {
  caseCount: number
  contractPassed: number
  casesPassed: number
  criticalCases: number
  criticalCasesPassed: number
  passedAssertions: number
  totalAssertions: number
  contractPassRate: number
  assertionPassRate: number
  criticalCasePassRate: number
  gatePassed: boolean
  usage: AiUsage
}

export interface PricingSnapshot {
  currency: string
  effectiveAt: string
  source: string
  cacheHitInputPerMillion: number
  cacheMissInputPerMillion: number
  outputPerMillion: number
}

export interface EvaluationCost {
  currency: string
  estimatedTotal: number
  cacheHitInput: number
  cacheMissInput: number
  output: number
  unclassifiedPromptTokensChargedAsCacheMiss: number
  effectiveAt: string
  source: string
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function strings(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= maxLength)
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "")
}

function includesAny(actual: string, expected: string[]): boolean {
  const normalizedActual = normalize(actual)
  return expected.some(item => normalizedActual.includes(normalize(item)))
}

function inferImageMime(path: string, bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  const suffix = extname(path).toLowerCase()
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const png = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const webp = bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP"
  if ((suffix === ".jpg" || suffix === ".jpeg") && jpeg) return "image/jpeg"
  if (suffix === ".png" && png) return "image/png"
  if (suffix === ".webp" && webp) return "image/webp"
  throw new Error("评测图片扩展名与实际格式不一致：" + path)
}

function parseExpectations(raw: unknown, caseId: string): MaterialFieldExpectation[] {
  if (!object(raw) || !Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > 8) {
    throw new Error("评测用例缺少字段期望：" + caseId)
  }
  const seen = new Set<string>()
  return raw.fields.map((item, index) => {
    if (!object(item)
      || !MATERIAL_CHECK_FIELD_KEYS.includes(item.key as MaterialCheckFieldKey)
      || seen.has(String(item.key))) {
      throw new Error(`评测用例 ${caseId} 的第 ${index + 1} 个字段期望无效或重复`)
    }
    seen.add(String(item.key))
    const expectation: MaterialFieldExpectation = { key: item.key as MaterialCheckFieldKey }
    if (item.statusOneOf !== undefined) {
      if (!Array.isArray(item.statusOneOf) || item.statusOneOf.length < 1
        || !item.statusOneOf.every(status => FIELD_STATUSES.includes(status as MaterialCheckFieldStatus))) {
        throw new Error(`评测用例 ${caseId} 的状态期望无效`)
      }
      expectation.statusOneOf = item.statusOneOf as MaterialCheckFieldStatus[]
    }
    for (const key of [
      "observedIncludesAny", "expectedIncludesAny",
      "observedSourceIdsInclude", "expectedSourceIdsInclude"
    ] as const) {
      if (item[key] !== undefined) {
        if (!strings(item[key], 20, 500)) throw new Error(`评测用例 ${caseId} 的 ${key} 无效`)
        expectation[key] = item[key]
      }
    }
    return expectation
  })
}

function parseThresholds(raw: unknown): EvaluationThresholds {
  const defaults: EvaluationThresholds = {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  }
  if (raw === undefined) return defaults
  if (!object(raw)) throw new Error("评测门槛格式不正确")
  const parsed = { ...defaults }
  for (const key of Object.keys(defaults) as Array<keyof EvaluationThresholds>) {
    if (raw[key] !== undefined) {
      if (!finiteRate(raw[key])) throw new Error("评测门槛必须是 0 到 1 之间的小数：" + key)
      parsed[key] = raw[key]
    }
  }
  return parsed
}

export function loadMaterialEvaluationDataset(datasetPath: string): MaterialEvaluationDataset {
  const absolutePath = resolve(datasetPath)
  const basePath = dirname(absolutePath)
  const raw = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown
  if (!object(raw) || raw.version !== 1 || typeof raw.name !== "string" || !raw.name.trim()
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 50) {
    throw new Error("材料评测集格式不正确")
  }
  const seen = new Set<string>()
  const cases: MaterialEvaluationCase[] = raw.cases.map((item, index) => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || seen.has(item.id) || typeof item.title !== "string" || !item.title.trim()
      || !object(item.input) || !object(item.expected)) {
      throw new Error(`第 ${index + 1} 个材料评测用例格式不正确或 ID 重复`)
    }
    seen.add(item.id)
    const rawImages = item.input.images ?? []
    if (!Array.isArray(rawImages) || rawImages.length > 4) {
      throw new Error("评测图片必须是数组且最多 4 张：" + item.id)
    }
    const images = rawImages.map((image, imageIndex) => {
      if (!object(image) || typeof image.sourceId !== "string" || typeof image.path !== "string"
        || !image.path.trim()) {
        throw new Error(`评测用例 ${item.id} 的第 ${imageIndex + 1} 张图片无效`)
      }
      const path = resolve(basePath, image.path)
      const bytes = readFileSync(path)
      if (bytes.length > 2 * 1024 * 1024) throw new Error("评测图片超过 2MB：" + path)
      const mime = inferImageMime(path, bytes)
      return { sourceId: image.sourceId, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` }
    })
    const input = validateInput({
      requestId: "eval_" + item.id,
      projectId: item.input.projectId,
      task: "material_check",
      stage: item.input.stage,
      question: item.input.question,
      sources: item.input.sources,
      images
    })
    const expectations = parseExpectations(item.expected, item.id)
    const sourceIds = new Set(input.sources.map(source => source.id))
    for (const expectation of expectations) {
      for (const sourceId of [
        ...(expectation.observedSourceIdsInclude ?? []),
        ...(expectation.expectedSourceIdsInclude ?? [])
      ]) {
        if (!sourceIds.has(sourceId)) {
          throw new Error(`评测用例 ${item.id} 的期望引用不属于输入资料：${sourceId}`)
        }
      }
    }
    return {
      id: item.id,
      title: item.title,
      critical: item.critical === true,
      tags: strings(item.tags, 20, 100) ? item.tags : [],
      input,
      expected: { fields: expectations },
      imageCount: images.length
    }
  })
  return {
    version: 1,
    name: raw.name,
    thresholds: parseThresholds(raw.thresholds),
    cases
  }
}

function assertion(name: string, passed: boolean, expected: string, actual: string): EvaluationAssertion {
  return { name, passed, expected, actual }
}

export function scoreMaterialResult(
  expected: MaterialEvaluationCase["expected"],
  result?: AiResult
): MaterialCaseScore {
  const fields = new Map(result?.materialCheck?.fields.map(field => [field.key, field]) ?? [])
  const assertions: EvaluationAssertion[] = []
  for (const wanted of expected.fields) {
    const actual = fields.get(wanted.key)
    assertions.push(assertion(
      `${wanted.key}.exists`, Boolean(actual), "字段存在", actual ? "字段存在" : "字段缺失"
    ))
    if (wanted.statusOneOf) assertions.push(assertion(
      `${wanted.key}.status`, Boolean(actual && wanted.statusOneOf.includes(actual.status)),
      wanted.statusOneOf.join(" | "), actual?.status ?? "字段缺失"
    ))
    if (wanted.observedIncludesAny) assertions.push(assertion(
      `${wanted.key}.observedValue`, Boolean(actual && includesAny(actual.observedValue, wanted.observedIncludesAny)),
      "包含其一：" + wanted.observedIncludesAny.join(" | "), actual?.observedValue ?? "字段缺失"
    ))
    if (wanted.expectedIncludesAny) assertions.push(assertion(
      `${wanted.key}.expectedValue`, Boolean(actual && includesAny(actual.expectedValue, wanted.expectedIncludesAny)),
      "包含其一：" + wanted.expectedIncludesAny.join(" | "), actual?.expectedValue ?? "字段缺失"
    ))
    if (wanted.observedSourceIdsInclude) assertions.push(assertion(
      `${wanted.key}.observedSourceIds`, Boolean(actual
        && wanted.observedSourceIdsInclude.every(id => actual.observedSourceIds.includes(id))),
      "至少包含：" + wanted.observedSourceIdsInclude.join(", "),
      actual?.observedSourceIds.join(", ") ?? "字段缺失"
    ))
    if (wanted.expectedSourceIdsInclude) assertions.push(assertion(
      `${wanted.key}.expectedSourceIds`, Boolean(actual
        && wanted.expectedSourceIdsInclude.every(id => actual.expectedSourceIds.includes(id))),
      "至少包含：" + wanted.expectedSourceIdsInclude.join(", "),
      actual?.expectedSourceIds.join(", ") ?? "字段缺失"
    ))
  }
  const passedAssertions = assertions.filter(item => item.passed).length
  return {
    passed: passedAssertions === assertions.length,
    passedAssertions,
    totalAssertions: assertions.length,
    assertions
  }
}

function addUsage(target: AiUsage, usage?: AiUsage) {
  if (!usage) return
  target.promptTokens += usage.promptTokens
  target.cacheHitPromptTokens += usage.cacheHitPromptTokens
  target.cacheMissPromptTokens += usage.cacheMissPromptTokens
  target.completionTokens += usage.completionTokens
  target.totalTokens += usage.totalTokens
  target.reasoningTokens = (target.reasoningTokens || 0) + (usage.reasoningTokens || 0)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

export function summarizeEvaluation(
  outcomes: EvaluationCaseOutcome[],
  thresholds: EvaluationThresholds
): EvaluationSummary {
  const contractPassed = outcomes.filter(item => item.contractValid).length
  const casesPassed = outcomes.filter(item => item.contractValid && item.score.passed).length
  const critical = outcomes.filter(item => item.critical)
  const criticalCasesPassed = critical.filter(item => item.contractValid && item.score.passed).length
  const passedAssertions = outcomes.reduce((sum, item) => sum + item.score.passedAssertions, 0)
  const totalAssertions = outcomes.reduce((sum, item) => sum + item.score.totalAssertions, 0)
  const usage: AiUsage = {
    promptTokens: 0,
    cacheHitPromptTokens: 0,
    cacheMissPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0
  }
  outcomes.forEach(item => addUsage(usage, item.usage))
  const contractPassRate = ratio(contractPassed, outcomes.length)
  const assertionPassRate = ratio(passedAssertions, totalAssertions)
  const criticalCasePassRate = ratio(criticalCasesPassed, critical.length)
  return {
    caseCount: outcomes.length,
    contractPassed,
    casesPassed,
    criticalCases: critical.length,
    criticalCasesPassed,
    passedAssertions,
    totalAssertions,
    contractPassRate,
    assertionPassRate,
    criticalCasePassRate,
    gatePassed: contractPassRate >= thresholds.contractPassRate
      && assertionPassRate >= thresholds.assertionPassRate
      && criticalCasePassRate >= thresholds.criticalCasePassRate,
    usage
  }
}

export function loadPricingSnapshot(path: string): PricingSnapshot {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown
  if (!object(raw) || typeof raw.currency !== "string" || !raw.currency.trim()
    || typeof raw.effectiveAt !== "string" || !raw.effectiveAt.trim()
    || typeof raw.source !== "string" || !raw.source.trim()) {
    throw new Error("价格快照缺少币种、生效时间或来源")
  }
  for (const key of [
    "cacheHitInputPerMillion", "cacheMissInputPerMillion", "outputPerMillion"
  ] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0) {
      throw new Error("价格快照字段必须是非负数字：" + key)
    }
  }
  return raw as unknown as PricingSnapshot
}

export function calculateEvaluationCost(usage: AiUsage, pricing: PricingSnapshot): EvaluationCost {
  const classifiedPrompt = usage.cacheHitPromptTokens + usage.cacheMissPromptTokens
  const unclassified = Math.max(0, usage.promptTokens - classifiedPrompt)
  const cacheHitInput = usage.cacheHitPromptTokens / 1_000_000 * pricing.cacheHitInputPerMillion
  const cacheMissInput = (usage.cacheMissPromptTokens + unclassified) / 1_000_000
    * pricing.cacheMissInputPerMillion
  const output = usage.completionTokens / 1_000_000 * pricing.outputPerMillion
  return {
    currency: pricing.currency,
    estimatedTotal: cacheHitInput + cacheMissInput + output,
    cacheHitInput,
    cacheMissInput,
    output,
    unclassifiedPromptTokensChargedAsCacheMiss: unclassified,
    effectiveAt: pricing.effectiveAt,
    source: pricing.source
  }
}

export function reportResult(result: AiResult): EvaluationCaseOutcome["result"] {
  return {
    summary: result.summary,
    unknowns: result.unknowns,
    fields: result.materialCheck?.fields ?? []
  }
}

export function modelOutputPreview(output: unknown, maxCharacters = 20_000): string {
  let serialized: string
  try { serialized = JSON.stringify(output) }
  catch { serialized = String(output) }
  const redacted = serialized.replace(
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
    "[redacted-image-data-url]"
  )
  return redacted.length <= maxCharacters
    ? redacted
    : redacted.slice(0, maxCharacters) + `…[truncated ${redacted.length - maxCharacters} characters]`
}
