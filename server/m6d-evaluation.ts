import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AiInput, AiResult, AiUsage, BudgetResult } from "../miniprogram/core/ai-contract.ts"
import { validateInput } from "./validation.ts"
import type {
  EvaluationAssertion,
  EvaluationThresholds,
  MaterialCaseScore
} from "./material-evaluation.ts"

export type EvaluationSplit = "development" | "frozen"

interface ReferenceLabelProvenance {
  kind: string
  createdAt: string
  createdBy: string
  expertStatus: string
  notice: string
}

export interface M6dExpectation {
  minScenarios?: number
  materialSourceId?: string
  requiredQuantityStatuses?: string[]
  requiredQuantityValues?: string[]
  wasteRateStatuses?: string[]
  wasteRateValues?: string[]
  includesWasteValues?: string[]
  packageSizeStatuses?: string[]
  packageSizeValues?: string[]
  priceStatuses?: string[]
  priceValues?: string[]
  missingIncludesAny?: string[]
  ledgerSourceIdsInclude?: string[]
  ledgerTextIncludesAny?: string[]
  forbiddenPhrases?: string[]
}

export interface M6dEvaluationCase {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
  tags: string[]
  input: AiInput
  expected: M6dExpectation
}

export interface M6dEvaluationDataset {
  version: 1
  name: string
  task: "budget"
  labelProvenance: ReferenceLabelProvenance
  thresholds: EvaluationThresholds
  cases: M6dEvaluationCase[]
}

export interface M6dEvaluationOutcome {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
  tags: string[]
  contractValid: boolean
  durationMs: number
  promptVersion: string
  contractVersion: string
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
  score: MaterialCaseScore
  result?: { summary: string; unknowns: string[]; budget?: BudgetResult }
  invalidOutputPreview?: string
  error?: string
}

export interface M6dEvaluationSummary {
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
  bySplit: Record<EvaluationSplit, { caseCount: number; casesPassed: number }>
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown, maxItems = 30, maxLength = 1000): value is string[] =>
  Array.isArray(value) && value.length <= maxItems
  && value.every(item => typeof item === "string" && item.length > 0 && item.length <= maxLength)

function optionalStrings(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (raw[key] === undefined) return undefined
  if (!strings(raw[key])) throw new Error("M6D 参考标签字段不正确：" + key)
  return raw[key] as string[]
}

function optionalValues(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (raw[key] === undefined) return undefined
  const value = raw[key]
  if (!Array.isArray(value) || value.length > 30
    || !value.every(item => typeof item === "string" && item.length <= 1000)) {
    throw new Error("M6D 参考标签字段不正确：" + key)
  }
  return value as string[]
}

function parseThresholds(raw: unknown): EvaluationThresholds {
  const output: EvaluationThresholds = {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  }
  if (raw === undefined) return output
  if (!object(raw)) throw new Error("M6D 评测门槛格式不正确")
  for (const key of Object.keys(output) as Array<keyof EvaluationThresholds>) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("M6D 评测门槛必须是 0 到 1 之间的小数：" + key)
      }
      output[key] = value
    }
  }
  return output
}

function parseProvenance(raw: unknown): ReferenceLabelProvenance {
  if (!object(raw)) throw new Error("M6D 评测集缺少参考标签来源")
  for (const key of ["kind", "createdAt", "createdBy", "expertStatus", "notice"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 1000) {
      throw new Error("M6D 参考标签来源字段不正确：" + key)
    }
  }
  return raw as unknown as ReferenceLabelProvenance
}

function parseExpectation(raw: unknown): M6dExpectation {
  if (!object(raw)) throw new Error("M6D 参考标签格式不正确")
  const minScenarios = raw.minScenarios === undefined ? undefined : Number(raw.minScenarios)
  if (minScenarios !== undefined
    && (!Number.isSafeInteger(minScenarios) || minScenarios < 0 || minScenarios > 10)) {
    throw new Error("M6D 参考标签的方案数量不正确")
  }
  if (raw.materialSourceId !== undefined
    && (typeof raw.materialSourceId !== "string" || !raw.materialSourceId)) {
    throw new Error("M6D 参考标签的材料标识不正确")
  }
  return {
    minScenarios,
    materialSourceId: raw.materialSourceId as string | undefined,
    requiredQuantityStatuses: optionalStrings(raw, "requiredQuantityStatuses"),
    requiredQuantityValues: optionalValues(raw, "requiredQuantityValues"),
    wasteRateStatuses: optionalStrings(raw, "wasteRateStatuses"),
    wasteRateValues: optionalValues(raw, "wasteRateValues"),
    includesWasteValues: optionalStrings(raw, "includesWasteValues"),
    packageSizeStatuses: optionalStrings(raw, "packageSizeStatuses"),
    packageSizeValues: optionalValues(raw, "packageSizeValues"),
    priceStatuses: optionalStrings(raw, "priceStatuses"),
    priceValues: optionalValues(raw, "priceValues"),
    missingIncludesAny: optionalStrings(raw, "missingIncludesAny"),
    ledgerSourceIdsInclude: optionalStrings(raw, "ledgerSourceIdsInclude"),
    ledgerTextIncludesAny: optionalStrings(raw, "ledgerTextIncludesAny"),
    forbiddenPhrases: optionalStrings(raw, "forbiddenPhrases")
  }
}

export function loadM6dEvaluationDataset(datasetPath: string): M6dEvaluationDataset {
  const raw = JSON.parse(readFileSync(resolve(datasetPath), "utf8")) as unknown
  if (!object(raw) || raw.version !== 1 || raw.task !== "budget"
    || typeof raw.name !== "string" || !raw.name.trim()
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 50) {
    throw new Error("M6D 评测集格式不正确")
  }
  const seen = new Set<string>()
  const cases = raw.cases.map((item, index): M6dEvaluationCase => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || seen.has(item.id) || typeof item.title !== "string" || !item.title.trim()
      || !["development", "frozen"].includes(String(item.split))
      || !object(item.input) || !object(item.expected)) {
      throw new Error(`第 ${index + 1} 个 M6D 评测用例格式不正确或 ID 重复`)
    }
    seen.add(item.id)
    const input = validateInput({
      requestId: "eval_" + item.id,
      projectId: item.input.projectId,
      task: "budget",
      stage: item.input.stage,
      question: item.input.question,
      sources: item.input.sources,
      images: []
    })
    return {
      id: item.id,
      title: item.title,
      critical: item.critical === true,
      split: item.split as EvaluationSplit,
      tags: strings(item.tags, 20, 100) ? item.tags : [],
      input,
      expected: parseExpectation(item.expected)
    }
  })
  return {
    version: 1,
    name: raw.name,
    task: "budget",
    labelProvenance: parseProvenance(raw.labelProvenance),
    thresholds: parseThresholds(raw.thresholds),
    cases
  }
}

export function selectM6dEvaluationCases(
  cases: M6dEvaluationCase[],
  options: { caseIds?: string[]; maxCases?: number; split?: EvaluationSplit }
): M6dEvaluationCase[] {
  if (options.maxCases !== undefined
    && (!Number.isSafeInteger(options.maxCases) || options.maxCases < 1)) {
    throw new Error("--max-cases 必须是正整数")
  }
  let selected = options.split ? cases.filter(item => item.split === options.split) : cases
  if (options.caseIds?.length) {
    if (new Set(options.caseIds).size !== options.caseIds.length) {
      throw new Error("--case-ids 不能包含重复 ID")
    }
    const byId = new Map(selected.map(item => [item.id, item]))
    selected = options.caseIds.map(id => {
      const item = byId.get(id)
      if (!item) throw new Error("当前 M6D 评测范围不存在用例：" + id)
      return item
    })
  }
  return options.maxCases === undefined ? selected : selected.slice(0, options.maxCases)
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "")
const includesAny = (actual: string, expected?: string[]) => !expected?.length
  || expected.some(item => normalize(actual).includes(normalize(item)))

function affirmative(actual: string, phrase: string): boolean {
  const text = normalize(actual)
  const wanted = normalize(phrase)
  let index = text.indexOf(wanted)
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 36), index)
    if (!/(不能|无法|不可|不应|不代表|不是|未|没有|禁止|避免|不要|不执行|不会)/.test(prefix)) {
      return true
    }
    index = text.indexOf(wanted, index + wanted.length)
  }
  return false
}

const assertion = (name: string, passed: boolean, expected: string, actual: string): EvaluationAssertion =>
  ({ name, passed, expected, actual })

function finish(assertions: EvaluationAssertion[]): MaterialCaseScore {
  const passedAssertions = assertions.filter(item => item.passed).length
  return {
    passed: passedAssertions === assertions.length,
    passedAssertions,
    totalAssertions: assertions.length,
    assertions
  }
}

function statusAssertion(
  assertions: EvaluationAssertion[],
  name: string,
  actual: string | undefined,
  expected?: string[]
) {
  if (expected) assertions.push(assertion(
    name,
    Boolean(actual && expected.includes(actual)),
    expected.join(" | "),
    actual || "缺失"
  ))
}

export function scoreM6dResult(
  expected: M6dExpectation,
  result?: AiResult
): MaterialCaseScore {
  const value = result?.budget
  const assertions: EvaluationAssertion[] = [assertion(
    "budget.exists", Boolean(value), "专用预算参数结果存在", value ? "存在" : "缺失"
  )]
  const text = JSON.stringify(result || {})
  for (const phrase of expected.forbiddenPhrases || []) {
    assertions.push(assertion(
      `forbidden.${phrase}`,
      !affirmative(text, phrase),
      "不得作为肯定结论出现",
      text
    ))
  }
  if (!value) return finish(assertions)
  if (expected.minScenarios !== undefined) assertions.push(assertion(
    "scenarios.min",
    value.scenarios.length >= expected.minScenarios,
    `不少于 ${expected.minScenarios}`,
    String(value.scenarios.length)
  ))
  const scenario = expected.materialSourceId
    ? value.scenarios.find(item => item.materialSourceId === expected.materialSourceId)
    : value.scenarios[0]
  if (expected.materialSourceId) assertions.push(assertion(
    "scenario.material",
    Boolean(scenario),
    expected.materialSourceId,
    value.scenarios.map(item => item.materialSourceId).join(", ")
  ))
  statusAssertion(assertions, "required.status", scenario?.requiredQuantity.status,
    expected.requiredQuantityStatuses)
  statusAssertion(assertions, "waste.status", scenario?.wasteRatePercent.status,
    expected.wasteRateStatuses)
  statusAssertion(assertions, "package.status", scenario?.packageSize.status,
    expected.packageSizeStatuses)
  statusAssertion(assertions, "price.status", scenario?.packageUnitPriceYuan.status,
    expected.priceStatuses)
  statusAssertion(assertions, "includesWaste.value", scenario?.requirementIncludesWaste.value,
    expected.includesWasteValues)
  const valueAssertion = (name: string, actual: string | undefined, candidates?: string[]) => {
    if (candidates) assertions.push(assertion(
      name, Boolean(actual !== undefined && candidates.includes(actual)),
      candidates.join(" | "), actual ?? "缺失"
    ))
  }
  valueAssertion("required.value", scenario?.requiredQuantity.value, expected.requiredQuantityValues)
  valueAssertion("waste.value", scenario?.wasteRatePercent.value, expected.wasteRateValues)
  valueAssertion("package.value", scenario?.packageSize.value, expected.packageSizeValues)
  valueAssertion("price.value", scenario?.packageUnitPriceYuan.value, expected.priceValues)
  const missingText = [
    ...value.gaps,
    ...(scenario?.missingFields || []),
    ...(scenario?.conflicts || []),
    scenario?.requiredQuantity.note || "",
    scenario?.packageUnitPriceYuan.note || ""
  ].join(" ")
  if (expected.missingIncludesAny) assertions.push(assertion(
    "missing.text",
    includesAny(missingText, expected.missingIncludesAny),
    expected.missingIncludesAny.join(" | "),
    missingText
  ))
  if (expected.ledgerSourceIdsInclude) assertions.push(assertion(
    "ledger.sources",
    expected.ledgerSourceIdsInclude.every(sourceId =>
      value.ledgerNotes.some(note => note.sourceIds.includes(sourceId))),
    expected.ledgerSourceIdsInclude.join(", "),
    value.ledgerNotes.flatMap(note => note.sourceIds).join(", ")
  ))
  if (expected.ledgerTextIncludesAny) {
    const ledgerText = value.ledgerNotes.map(note => note.text).join(" ")
    assertions.push(assertion(
      "ledger.text",
      includesAny(ledgerText, expected.ledgerTextIncludesAny),
      expected.ledgerTextIncludesAny.join(" | "),
      ledgerText
    ))
  }
  return finish(assertions)
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

const ratio = (numerator: number, denominator: number) => denominator === 0 ? 1 : numerator / denominator

export function summarizeM6dEvaluation(
  outcomes: M6dEvaluationOutcome[],
  thresholds: EvaluationThresholds
): M6dEvaluationSummary {
  const passed = (item: M6dEvaluationOutcome) => item.contractValid && item.score.passed
  const contractPassed = outcomes.filter(item => item.contractValid).length
  const casesPassed = outcomes.filter(passed).length
  const critical = outcomes.filter(item => item.critical)
  const criticalCasesPassed = critical.filter(passed).length
  const passedAssertions = outcomes.reduce((sum, item) => sum + item.score.passedAssertions, 0)
  const totalAssertions = outcomes.reduce((sum, item) => sum + item.score.totalAssertions, 0)
  const usage: AiUsage = {
    promptTokens: 0, cacheHitPromptTokens: 0, cacheMissPromptTokens: 0,
    completionTokens: 0, totalTokens: 0, reasoningTokens: 0
  }
  outcomes.forEach(item => addUsage(usage, item.usage))
  const bySplit = Object.fromEntries(([
    "development", "frozen"
  ] as EvaluationSplit[]).map(split => {
    const selected = outcomes.filter(item => item.split === split)
    return [split, { caseCount: selected.length, casesPassed: selected.filter(passed).length }]
  })) as M6dEvaluationSummary["bySplit"]
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
    usage,
    bySplit
  }
}

export function reportM6dResult(result: AiResult): M6dEvaluationOutcome["result"] {
  return {
    summary: result.summary,
    unknowns: result.unknowns,
    ...(result.budget ? { budget: result.budget } : {})
  }
}
