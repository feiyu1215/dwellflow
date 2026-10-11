import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  AiInput,
  AiResult,
  AiTaskMode,
  AiUsage,
  ConsultationResult,
  RectificationResult
} from "../miniprogram/core/ai-contract.ts"
import { validateInput } from "./validation.ts"
import type {
  EvaluationAssertion,
  EvaluationThresholds,
  MaterialCaseScore
} from "./material-evaluation.ts"

export type M6cEvaluationTask = "rectification" | "consultation"
export type EvaluationSplit = "development" | "frozen"

interface ReferenceLabelProvenance {
  kind: string
  createdAt: string
  createdBy: string
  expertStatus: string
  notice: string
}

export interface M6cExpectation {
  mode: AiTaskMode
  minItems?: number
  minFacts?: number
  minDisputes?: number
  minFollowUps?: number
  itemTextIncludesAny?: string[]
  gapsIncludeAny?: string[]
  sourceIdsInclude?: string[]
  beforeSourceIdsInclude?: string[]
  afterSourceIdsInclude?: string[]
  statusesOneOf?: string[]
  evidenceRelationOneOf?: string[]
  costIncludesAny?: string[]
  forbiddenPhrases?: string[]
}

export interface M6cEvaluationCase {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
  tags: string[]
  input: AiInput
  expected: M6cExpectation
}

export interface M6cEvaluationDataset {
  version: 1
  name: string
  task: M6cEvaluationTask
  labelProvenance: ReferenceLabelProvenance
  thresholds: EvaluationThresholds
  cases: M6cEvaluationCase[]
}

export interface M6cEvaluationOutcome {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
  tags: string[]
  mode: AiTaskMode
  contractValid: boolean
  durationMs: number
  promptVersion: string
  contractVersion: string
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
  score: MaterialCaseScore
  result?: {
    summary: string
    unknowns: string[]
    rectification?: RectificationResult
    consultation?: ConsultationResult
  }
  invalidOutputPreview?: string
  error?: string
}

export interface M6cEvaluationSummary {
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
  byMode: Record<string, { caseCount: number; casesPassed: number }>
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown, maxItems = 30, maxLength = 1000): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= maxLength)
}

function optionalStrings(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (raw[key] === undefined) return undefined
  if (!strings(raw[key])) throw new Error("参考标签字段不正确：" + key)
  return raw[key] as string[]
}

function optionalCount(raw: Record<string, unknown>, key: string): number | undefined {
  if (raw[key] === undefined) return undefined
  if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0 || Number(raw[key]) > 30) {
    throw new Error("参考标签计数字段不正确：" + key)
  }
  return Number(raw[key])
}

function parseThresholds(raw: unknown): EvaluationThresholds {
  const defaults: EvaluationThresholds = {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  }
  if (raw === undefined) return defaults
  if (!object(raw)) throw new Error("评测门槛格式不正确")
  const output = { ...defaults }
  for (const key of Object.keys(defaults) as Array<keyof EvaluationThresholds>) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("评测门槛必须是 0 到 1 之间的小数：" + key)
      }
      output[key] = value
    }
  }
  return output
}

function parseProvenance(raw: unknown): ReferenceLabelProvenance {
  if (!object(raw)) throw new Error("评测集缺少参考标签来源")
  for (const key of ["kind", "createdAt", "createdBy", "expertStatus", "notice"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 1000) {
      throw new Error("参考标签来源字段不正确：" + key)
    }
  }
  return raw as unknown as ReferenceLabelProvenance
}

function parseExpectation(raw: unknown, task: M6cEvaluationTask): M6cExpectation {
  if (!object(raw)) throw new Error("M6C 参考标签格式不正确")
  const validModes = task === "rectification" ? ["proposal", "review"] : ["prepare", "response"]
  if (!validModes.includes(String(raw.mode))) throw new Error("M6C 参考标签模式不正确")
  return {
    mode: raw.mode as AiTaskMode,
    minItems: optionalCount(raw, "minItems"),
    minFacts: optionalCount(raw, "minFacts"),
    minDisputes: optionalCount(raw, "minDisputes"),
    minFollowUps: optionalCount(raw, "minFollowUps"),
    itemTextIncludesAny: optionalStrings(raw, "itemTextIncludesAny"),
    gapsIncludeAny: optionalStrings(raw, "gapsIncludeAny"),
    sourceIdsInclude: optionalStrings(raw, "sourceIdsInclude"),
    beforeSourceIdsInclude: optionalStrings(raw, "beforeSourceIdsInclude"),
    afterSourceIdsInclude: optionalStrings(raw, "afterSourceIdsInclude"),
    statusesOneOf: optionalStrings(raw, "statusesOneOf"),
    evidenceRelationOneOf: optionalStrings(raw, "evidenceRelationOneOf"),
    costIncludesAny: optionalStrings(raw, "costIncludesAny"),
    forbiddenPhrases: optionalStrings(raw, "forbiddenPhrases")
  }
}

export function loadM6cEvaluationDataset(datasetPath: string): M6cEvaluationDataset {
  const raw = JSON.parse(readFileSync(resolve(datasetPath), "utf8")) as unknown
  if (!object(raw) || raw.version !== 1 || typeof raw.name !== "string" || !raw.name.trim()
    || !["rectification", "consultation"].includes(String(raw.task))
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 50) {
    throw new Error("M6C 评测集格式不正确")
  }
  const task = raw.task as M6cEvaluationTask
  const seen = new Set<string>()
  const cases = raw.cases.map((item, index): M6cEvaluationCase => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || seen.has(item.id) || typeof item.title !== "string" || !item.title.trim()
      || !["development", "frozen"].includes(String(item.split))
      || !object(item.input) || !object(item.expected)) {
      throw new Error(`第 ${index + 1} 个 M6C 评测用例格式不正确或 ID 重复`)
    }
    seen.add(item.id)
    const mode = item.input.mode
    const input = validateInput({
      requestId: "eval_" + item.id,
      projectId: item.input.projectId,
      task,
      mode,
      stage: item.input.stage,
      question: item.input.question,
      sources: item.input.sources,
      images: [],
      ...(item.input.target === undefined ? {} : { target: item.input.target })
    })
    const expected = parseExpectation(item.expected, task)
    if (input.mode !== expected.mode) throw new Error("评测输入模式与参考模式不一致：" + item.id)
    return {
      id: item.id,
      title: item.title,
      critical: item.critical === true,
      split: item.split as EvaluationSplit,
      tags: strings(item.tags, 20, 100) ? item.tags : [],
      input,
      expected
    }
  })
  return {
    version: 1,
    name: raw.name,
    task,
    labelProvenance: parseProvenance(raw.labelProvenance),
    thresholds: parseThresholds(raw.thresholds),
    cases
  }
}

export function selectM6cEvaluationCases(
  cases: M6cEvaluationCase[],
  options: { caseIds?: string[]; maxCases?: number; split?: EvaluationSplit }
): M6cEvaluationCase[] {
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
      if (!item) throw new Error("当前评测范围不存在用例：" + id)
      return item
    })
  }
  return options.maxCases === undefined ? selected : selected.slice(0, options.maxCases)
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "")
}

function includesAny(actual: string, expected?: string[]): boolean {
  if (!expected?.length) return true
  const normalized = normalize(actual)
  return expected.some(item => normalized.includes(normalize(item)))
}

function affirmative(actual: string, phrase: string): boolean {
  const text = normalize(actual)
  const wanted = normalize(phrase)
  let index = text.indexOf(wanted)
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 36), index)
    if (!/(不能|无法|不可|不应|不代表|不是|未|没有|禁止|避免|不要|不宣称|声称|夹带|原文|文字|指令)/.test(prefix)) {
      return true
    }
    index = text.indexOf(wanted, index + wanted.length)
  }
  return false
}

function assertion(name: string, passed: boolean, expected: string, actual: string): EvaluationAssertion {
  return { name, passed, expected, actual }
}

function finish(assertions: EvaluationAssertion[]): MaterialCaseScore {
  const passedAssertions = assertions.filter(item => item.passed).length
  return {
    passed: passedAssertions === assertions.length,
    passedAssertions,
    totalAssertions: assertions.length,
    assertions
  }
}

function count(
  assertions: EvaluationAssertion[],
  name: string,
  actual: number,
  minimum?: number
) {
  if (minimum !== undefined) assertions.push(assertion(
    name,
    actual >= minimum,
    `不少于 ${minimum}`,
    String(actual)
  ))
}

function commonAssertions(
  expected: M6cExpectation,
  result: AiResult | undefined,
  specialized: unknown
): EvaluationAssertion[] {
  const assertions = [
    assertion("specialized.exists", Boolean(specialized), "专用结果存在",
      specialized ? "存在" : "缺失")
  ]
  const text = JSON.stringify(result || {})
  for (const phrase of expected.forbiddenPhrases || []) {
    assertions.push(assertion(
      `forbidden.${phrase}`,
      !affirmative(text, phrase),
      "不得作为肯定结论出现",
      text
    ))
  }
  return assertions
}

function scoreRectification(expected: M6cExpectation, result?: AiResult): MaterialCaseScore {
  const value = result?.rectification
  const assertions = commonAssertions(expected, result, value)
  assertions.push(assertion(
    "mode",
    value?.mode === expected.mode,
    expected.mode,
    value?.mode || "缺失"
  ))
  if (!value) return finish(assertions)
  if (value.mode === "proposal") {
    count(assertions, "proposals.min", value.proposals.length, expected.minItems)
    const proposalText = value.proposals
      .flatMap(item => [item.title, ...item.actions, ...item.applicability, ...item.impacts])
      .join(" ")
    if (expected.itemTextIncludesAny) assertions.push(assertion(
      "proposals.text",
      includesAny(proposalText, expected.itemTextIncludesAny),
      expected.itemTextIncludesAny.join(" | "),
      proposalText
    ))
    if (expected.sourceIdsInclude) assertions.push(assertion(
      "proposals.sources",
      expected.sourceIdsInclude.every(sourceId =>
        value.proposals.some(item => item.sourceIds.includes(sourceId))),
      expected.sourceIdsInclude.join(", "),
      value.proposals.flatMap(item => item.sourceIds).join(", ")
    ))
    if (expected.costIncludesAny) assertions.push(assertion(
      "proposals.cost",
      includesAny(value.proposals.map(item => item.costAndSchedule).join(" "), expected.costIncludesAny),
      expected.costIncludesAny.join(" | "),
      value.proposals.map(item => item.costAndSchedule).join("；")
    ))
    if (expected.gapsIncludeAny) assertions.push(assertion(
      "gaps",
      includesAny(value.gaps.join(" "), expected.gapsIncludeAny),
      expected.gapsIncludeAny.join(" | "),
      value.gaps.join("；")
    ))
    return finish(assertions)
  }
  count(assertions, "checks.min", value.checks.length, expected.minItems)
  if (expected.evidenceRelationOneOf) assertions.push(assertion(
    "evidenceRelation",
    expected.evidenceRelationOneOf.includes(value.evidenceRelation),
    expected.evidenceRelationOneOf.join(" | "),
    value.evidenceRelation
  ))
  if (expected.statusesOneOf) assertions.push(assertion(
    "checks.status",
    value.checks.length > 0 && value.checks.every(item =>
      expected.statusesOneOf!.includes(item.status)),
    expected.statusesOneOf.join(" | "),
    value.checks.map(item => item.status).join(", ")
  ))
  if (expected.beforeSourceIdsInclude) assertions.push(assertion(
    "checks.beforeSources",
    expected.beforeSourceIdsInclude.every(sourceId =>
      value.checks.some(item => item.beforeSourceIds.includes(sourceId))),
    expected.beforeSourceIdsInclude.join(", "),
    value.checks.flatMap(item => item.beforeSourceIds).join(", ")
  ))
  if (expected.afterSourceIdsInclude) assertions.push(assertion(
    "checks.afterSources",
    expected.afterSourceIdsInclude.every(sourceId =>
      value.checks.some(item => item.afterSourceIds.includes(sourceId))),
    expected.afterSourceIdsInclude.join(", "),
    value.checks.flatMap(item => item.afterSourceIds).join(", ")
  ))
  const nextSteps = value.checks.reduce((sum, item) => sum + item.nextSteps.length, 0)
  count(assertions, "checks.nextSteps.min", nextSteps, expected.minFollowUps)
  if (expected.gapsIncludeAny) assertions.push(assertion(
    "gaps",
    includesAny(value.gaps.join(" "), expected.gapsIncludeAny),
    expected.gapsIncludeAny.join(" | "),
    value.gaps.join("；")
  ))
  return finish(assertions)
}

function scoreConsultation(expected: M6cExpectation, result?: AiResult): MaterialCaseScore {
  const value = result?.consultation
  const assertions = commonAssertions(expected, result, value)
  assertions.push(assertion(
    "mode",
    value?.mode === expected.mode,
    expected.mode,
    value?.mode || "缺失"
  ))
  if (!value) return finish(assertions)
  if (value.mode === "prepare") {
    count(assertions, "facts.min", value.facts.length, expected.minFacts)
    count(assertions, "disputes.min", value.disputes.length, expected.minDisputes)
    count(assertions, "questions.min", value.questions.length, expected.minItems)
    const questionText = value.questions.map(item => item.text).join(" ")
    if (expected.itemTextIncludesAny) assertions.push(assertion(
      "questions.text",
      includesAny(questionText, expected.itemTextIncludesAny),
      expected.itemTextIncludesAny.join(" | "),
      questionText
    ))
    if (expected.sourceIdsInclude) assertions.push(assertion(
      "questions.sources",
      expected.sourceIdsInclude.every(sourceId =>
        value.questions.some(item => item.sourceIds.includes(sourceId))),
      expected.sourceIdsInclude.join(", "),
      value.questions.flatMap(item => item.sourceIds).join(", ")
    ))
    if (expected.gapsIncludeAny) assertions.push(assertion(
      "gaps",
      includesAny(value.gaps.join(" "), expected.gapsIncludeAny),
      expected.gapsIncludeAny.join(" | "),
      value.gaps.join("；")
    ))
    return finish(assertions)
  }
  count(assertions, "mappings.min", value.mappings.length, expected.minItems)
  if (expected.statusesOneOf) assertions.push(assertion(
    "mappings.status",
    value.mappings.length > 0 && value.mappings.every(item =>
      expected.statusesOneOf!.includes(item.status)),
    expected.statusesOneOf.join(" | "),
    value.mappings.map(item => item.status).join(", ")
  ))
  if (expected.sourceIdsInclude) assertions.push(assertion(
    "mappings.sources",
    expected.sourceIdsInclude.every(sourceId =>
      value.mappings.some(item => item.responseSourceIds.includes(sourceId))),
    expected.sourceIdsInclude.join(", "),
    value.mappings.flatMap(item => item.responseSourceIds).join(", ")
  ))
  const mappingText = value.mappings
    .flatMap(item => [item.question, item.summary, ...item.followUps, ...item.conflicts])
    .join(" ")
  if (expected.itemTextIncludesAny) assertions.push(assertion(
    "mappings.text",
    includesAny(mappingText, expected.itemTextIncludesAny),
    expected.itemTextIncludesAny.join(" | "),
    mappingText
  ))
  const followUps = value.mappings.reduce((sum, item) => sum + item.followUps.length, 0)
  count(assertions, "mappings.followUps.min", followUps, expected.minFollowUps)
  if (expected.gapsIncludeAny) assertions.push(assertion(
    "gaps",
    includesAny(value.gaps.join(" "), expected.gapsIncludeAny),
    expected.gapsIncludeAny.join(" | "),
    value.gaps.join("；")
  ))
  return finish(assertions)
}

export function scoreM6cResult(
  task: M6cEvaluationTask,
  expected: M6cExpectation,
  result?: AiResult
): MaterialCaseScore {
  return task === "rectification"
    ? scoreRectification(expected, result)
    : scoreConsultation(expected, result)
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

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? 1 : numerator / denominator

export function summarizeM6cEvaluation(
  outcomes: M6cEvaluationOutcome[],
  thresholds: EvaluationThresholds
): M6cEvaluationSummary {
  const passed = (item: M6cEvaluationOutcome) => item.contractValid && item.score.passed
  const contractPassed = outcomes.filter(item => item.contractValid).length
  const casesPassed = outcomes.filter(passed).length
  const critical = outcomes.filter(item => item.critical)
  const criticalCasesPassed = critical.filter(passed).length
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
  const bySplit = Object.fromEntries((["development", "frozen"] as EvaluationSplit[]).map(split => {
    const selected = outcomes.filter(item => item.split === split)
    return [split, { caseCount: selected.length, casesPassed: selected.filter(passed).length }]
  })) as M6cEvaluationSummary["bySplit"]
  const modes = [...new Set(outcomes.map(item => item.mode))]
  const byMode = Object.fromEntries(modes.map(mode => {
    const selected = outcomes.filter(item => item.mode === mode)
    return [mode, { caseCount: selected.length, casesPassed: selected.filter(passed).length }]
  }))
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
    bySplit,
    byMode
  }
}

export function reportM6cResult(result: AiResult): M6cEvaluationOutcome["result"] {
  return {
    summary: result.summary,
    unknowns: result.unknowns,
    ...(result.rectification ? { rectification: result.rectification } : {}),
    ...(result.consultation ? { consultation: result.consultation } : {})
  }
}
