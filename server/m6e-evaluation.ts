import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  PROJECT_SUMMARY_SECTION_KEYS,
  type AiInput,
  type AiResult,
  type AiUsage,
  type ProjectSummaryResult,
  type ProjectSummarySectionKey
} from "../miniprogram/core/ai-contract.ts"
import { validateInput } from "./validation.ts"
import type {
  EvaluationAssertion,
  EvaluationThresholds,
  MaterialCaseScore
} from "./material-evaluation.ts"

export type M6eEvaluationSplit = "development" | "frozen"

interface ReferenceLabelProvenance {
  kind: string
  createdAt: string
  createdBy: string
  expertStatus: string
  notice: string
}

export interface M6eExpectation {
  scopeIncludes?: string[]
  requiredSectionSources?: Partial<Record<ProjectSummarySectionKey, string[]>>
  sectionTextIncludesAll?: Partial<Record<ProjectSummarySectionKey, string[]>>
  minTotalGaps?: number
  requiredHandoffStatuses?: string[]
  excludedSourceIds?: string[]
  forbiddenCompletedSourceIds?: string[]
  forbiddenPhrases?: string[]
}

export interface M6eEvaluationCase {
  id: string
  title: string
  critical: boolean
  split: M6eEvaluationSplit
  tags: string[]
  input: AiInput
  expected: M6eExpectation
}

export interface M6eEvaluationDataset {
  version: 1
  name: string
  task: "project_summary"
  labelProvenance: ReferenceLabelProvenance
  thresholds: EvaluationThresholds
  cases: M6eEvaluationCase[]
}

export interface M6eEvaluationOutcome {
  id: string
  title: string
  critical: boolean
  split: M6eEvaluationSplit
  tags: string[]
  contractValid: boolean
  durationMs: number
  promptVersion: string
  contractVersion: string
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
  score: MaterialCaseScore
  result?: { summary: string; unknowns: string[]; projectSummary?: ProjectSummaryResult }
  invalidOutputPreview?: string
  error?: string
}

export interface M6eEvaluationSummary {
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
  bySplit: Record<M6eEvaluationSplit, { caseCount: number; casesPassed: number }>
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown, maxItems = 30, maxLength = 1000): value is string[] =>
  Array.isArray(value) && value.length <= maxItems
  && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength)

function parseThresholds(raw: unknown): EvaluationThresholds {
  const output: EvaluationThresholds = {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  }
  if (raw === undefined) return output
  if (!object(raw)) throw new Error("M6E 评测门槛格式不正确")
  for (const key of Object.keys(output) as Array<keyof EvaluationThresholds>) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("M6E 评测门槛必须是 0 到 1 之间的小数：" + key)
      }
      output[key] = value
    }
  }
  return output
}

function parseProvenance(raw: unknown): ReferenceLabelProvenance {
  if (!object(raw)) throw new Error("M6E 评测集缺少参考标签来源")
  for (const key of ["kind", "createdAt", "createdBy", "expertStatus", "notice"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 1000) {
      throw new Error("M6E 参考标签来源字段不正确：" + key)
    }
  }
  return raw as unknown as ReferenceLabelProvenance
}

function sectionMap(raw: unknown, label: string): Partial<Record<ProjectSummarySectionKey, string[]>> | undefined {
  if (raw === undefined) return undefined
  if (!object(raw)) throw new Error("M6E 参考标签字段不正确：" + label)
  const output: Partial<Record<ProjectSummarySectionKey, string[]>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!PROJECT_SUMMARY_SECTION_KEYS.includes(key as ProjectSummarySectionKey)
      || !strings(value)) throw new Error("M6E 分区参考标签不正确：" + label)
    output[key as ProjectSummarySectionKey] = value
  }
  return output
}

function optionalStrings(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (raw[key] === undefined) return undefined
  if (!strings(raw[key])) throw new Error("M6E 参考标签字段不正确：" + key)
  return raw[key] as string[]
}

function parseExpectation(raw: unknown): M6eExpectation {
  if (!object(raw)) throw new Error("M6E 参考标签格式不正确")
  const minTotalGaps = raw.minTotalGaps === undefined ? undefined : Number(raw.minTotalGaps)
  if (minTotalGaps !== undefined
    && (!Number.isSafeInteger(minTotalGaps) || minTotalGaps < 0 || minTotalGaps > 100)) {
    throw new Error("M6E 参考标签的缺口数量不正确")
  }
  return {
    scopeIncludes: optionalStrings(raw, "scopeIncludes"),
    requiredSectionSources: sectionMap(raw.requiredSectionSources, "requiredSectionSources"),
    sectionTextIncludesAll: sectionMap(raw.sectionTextIncludesAll, "sectionTextIncludesAll"),
    minTotalGaps,
    requiredHandoffStatuses: optionalStrings(raw, "requiredHandoffStatuses"),
    excludedSourceIds: optionalStrings(raw, "excludedSourceIds"),
    forbiddenCompletedSourceIds: optionalStrings(raw, "forbiddenCompletedSourceIds"),
    forbiddenPhrases: optionalStrings(raw, "forbiddenPhrases")
  }
}

export function loadM6eEvaluationDataset(datasetPath: string): M6eEvaluationDataset {
  const raw = JSON.parse(readFileSync(resolve(datasetPath), "utf8")) as unknown
  if (!object(raw) || raw.version !== 1 || raw.task !== "project_summary"
    || typeof raw.name !== "string" || !raw.name.trim()
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 50) {
    throw new Error("M6E 评测集格式不正确")
  }
  const seen = new Set<string>()
  const cases = raw.cases.map((item, index): M6eEvaluationCase => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || seen.has(item.id) || typeof item.title !== "string" || !item.title.trim()
      || !["development", "frozen"].includes(String(item.split))
      || !object(item.input) || !object(item.expected)) {
      throw new Error(`第 ${index + 1} 个 M6E 评测用例格式不正确或 ID 重复`)
    }
    seen.add(item.id)
    const input = validateInput({
      requestId: "eval_" + item.id,
      projectId: item.input.projectId,
      task: "project_summary",
      stage: item.input.stage,
      question: item.input.question,
      sources: item.input.sources,
      images: [],
      summaryScope: item.input.summaryScope
    })
    return {
      id: item.id,
      title: item.title,
      critical: item.critical === true,
      split: item.split as M6eEvaluationSplit,
      tags: strings(item.tags, 20, 100) ? item.tags : [],
      input,
      expected: parseExpectation(item.expected)
    }
  })
  return {
    version: 1,
    name: raw.name,
    task: "project_summary",
    labelProvenance: parseProvenance(raw.labelProvenance),
    thresholds: parseThresholds(raw.thresholds),
    cases
  }
}

export function selectM6eEvaluationCases(
  cases: M6eEvaluationCase[],
  options: { caseIds?: string[]; maxCases?: number; split?: M6eEvaluationSplit }
): M6eEvaluationCase[] {
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
      if (!item) throw new Error("当前 M6E 评测范围不存在用例：" + id)
      return item
    })
  }
  return options.maxCases === undefined ? selected : selected.slice(0, options.maxCases)
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "")
const containsAll = (actual: string, expected: string[]) =>
  expected.every(item => normalize(actual).includes(normalize(item)))

function affirmative(actual: string, phrase: string): boolean {
  const value = normalize(actual)
  const wanted = normalize(phrase)
  let index = value.indexOf(wanted)
  while (index >= 0) {
    const prefix = value.slice(Math.max(0, index - 36), index)
    const suffix = value.slice(index + wanted.length, index + wanted.length + 60)
    if (!/(不能|无法|不可|不应|不代表|不是|未|没有|禁止|避免|不要|不执行|不会)/.test(prefix)
      && !/(不作为|不构成|不执行|未执行|不能认定|不得|不会|不据此|而非指令|仅为.*文字)/.test(suffix)) {
      return true
    }
    index = value.indexOf(wanted, index + wanted.length)
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

export function scoreM6eResult(expected: M6eExpectation, result?: AiResult): MaterialCaseScore {
  const value = result?.projectSummary
  const assertions: EvaluationAssertion[] = [assertion(
    "projectSummary.exists", Boolean(value), "专用项目总结结果存在", value ? "存在" : "缺失"
  )]
  const resultText = JSON.stringify(result || {})
  for (const phrase of expected.forbiddenPhrases || []) {
    assertions.push(assertion(
      `forbidden.${phrase}`,
      !affirmative(resultText, phrase),
      "不得作为肯定结论出现",
      resultText
    ))
  }
  if (!value) return finish(assertions)
  if (expected.scopeIncludes) assertions.push(assertion(
    "scope.statement",
    containsAll(value.scopeStatement, expected.scopeIncludes),
    expected.scopeIncludes.join(" + "),
    value.scopeStatement
  ))
  const sections = new Map(value.sections.map(section => [section.key, section]))
  for (const [key, sourceIds] of Object.entries(expected.requiredSectionSources || {})) {
    const actual = sections.get(key as ProjectSummarySectionKey)?.items.flatMap(item => item.sourceIds) || []
    assertions.push(assertion(
      `section.${key}.sources`,
      sourceIds.every(sourceId => actual.includes(sourceId)),
      sourceIds.join(", "),
      actual.join(", ")
    ))
  }
  for (const [key, phrases] of Object.entries(expected.sectionTextIncludesAll || {})) {
    const section = sections.get(key as ProjectSummarySectionKey)
    const actual = [
      ...(section?.items.map(item => item.text) || []),
      ...(section?.gaps || [])
    ].join(" ")
    assertions.push(assertion(
      `section.${key}.text`,
      containsAll(actual, phrases),
      phrases.join(" + "),
      actual
    ))
  }
  if (expected.minTotalGaps !== undefined) {
    const count = value.overallGaps.length
      + value.sections.reduce((sum, section) => sum + section.gaps.length, 0)
    assertions.push(assertion(
      "gaps.minimum", count >= expected.minTotalGaps,
      `不少于 ${expected.minTotalGaps}`, String(count)
    ))
  }
  if (expected.requiredHandoffStatuses) {
    const statuses = value.handoff.map(item => item.status)
    assertions.push(assertion(
      "handoff.statuses",
      expected.requiredHandoffStatuses.every(status => statuses.includes(status as never)),
      expected.requiredHandoffStatuses.join(", "),
      statuses.join(", ")
    ))
  }
  const citedSourceIds = [
    ...value.sections.flatMap(section => section.items.flatMap(item => item.sourceIds)),
    ...value.handoff.flatMap(item => item.sourceIds)
  ]
  for (const sourceId of expected.excludedSourceIds || []) {
    assertions.push(assertion(
      `scope.excludes.${sourceId}`,
      !citedSourceIds.includes(sourceId),
      "范围外来源不得进入报告条目",
      citedSourceIds.join(", ")
    ))
  }
  for (const sourceId of expected.forbiddenCompletedSourceIds || []) {
    const completed = value.sections.some(section => section.items.some(item =>
      item.status === "completed" && item.sourceIds.includes(sourceId)))
    assertions.push(assertion(
      `completion.excludes.${sourceId}`,
      !completed,
      "该来源不能支撑已完成状态",
      completed ? "被标为已完成" : "未标为已完成"
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

export function summarizeM6eEvaluation(
  outcomes: M6eEvaluationOutcome[],
  thresholds: EvaluationThresholds
): M6eEvaluationSummary {
  const passed = (item: M6eEvaluationOutcome) => item.contractValid && item.score.passed
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
  ] as M6eEvaluationSplit[]).map(split => {
    const selected = outcomes.filter(item => item.split === split)
    return [split, { caseCount: selected.length, casesPassed: selected.filter(passed).length }]
  })) as M6eEvaluationSummary["bySplit"]
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

export function reportM6eResult(result: AiResult): M6eEvaluationOutcome["result"] {
  return {
    summary: result.summary,
    unknowns: result.unknowns,
    ...(result.projectSummary ? { projectSummary: result.projectSummary } : {})
  }
}
