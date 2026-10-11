import { readFileSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import type {
  AiInput,
  AiResult,
  AiUsage,
  ImageObservationItem,
  RecordReviewFact,
  RecordReviewOpinion
} from "../miniprogram/core/ai-contract.ts"
import { validateInput } from "./validation.ts"
import type {
  EvaluationAssertion,
  EvaluationThresholds,
  MaterialCaseScore
} from "./material-evaluation.ts"

export type M6bEvaluationTask = "record_review" | "image_observation"
export type EvaluationSplit = "development" | "frozen"

interface ReferenceLabelProvenance {
  kind: string
  createdAt: string
  createdBy: string
  expertStatus: string
  notice: string
}

interface RecordLineExpectation {
  textIncludesAny?: string[]
  sourceIdsInclude?: string[]
  evidenceKindOneOf?: string[]
  roomIncludesAny?: string[]
  stageIncludesAny?: string[]
  speakerIncludesAny?: string[]
}

interface RecordReviewExpectation {
  minFacts?: number
  maxFacts?: number
  minOpinions?: number
  maxOpinions?: number
  minStatements?: number
  facts?: RecordLineExpectation[]
  opinions?: RecordLineExpectation[]
  time?: {
    originalIncludesAny?: string[]
    candidateDateEquals?: string
    candidateDateEmpty?: boolean
  }
  gapsIncludeAny?: string[]
  forbiddenPhrases?: string[]
}

interface ImageCoverageExpectation {
  imageId: string
  sourceId: string
  minQualityLimitations?: number
  limitationIncludesAny?: string[]
}

interface ImageItemExpectation {
  imageId: string
  observationIncludesAny?: string[]
  captureSuggestionsIncludeAny?: string[]
  limitationsIncludeAny?: string[]
  priorityOneOf?: string[]
}

interface ImageObservationExpectation {
  minItems?: number
  maxItems?: number
  coverage?: ImageCoverageExpectation[]
  items?: ImageItemExpectation[]
  forbiddenPhrases?: string[]
  forbidMeasurements?: boolean
}

export interface M6bEvaluationCase {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
  tags: string[]
  input: AiInput
  expected: RecordReviewExpectation | ImageObservationExpectation
  imageCount: number
}

export interface M6bEvaluationDataset {
  version: 1
  name: string
  task: M6bEvaluationTask
  labelProvenance: ReferenceLabelProvenance
  thresholds: EvaluationThresholds
  cases: M6bEvaluationCase[]
}

export interface M6bEvaluationOutcome {
  id: string
  title: string
  critical: boolean
  split: EvaluationSplit
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
    recordReview?: AiResult["recordReview"]
    imageObservation?: AiResult["imageObservation"]
  }
  invalidOutputPreview?: string
  error?: string
}

export interface M6bEvaluationSummary {
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

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown, maxItems = 20, maxLength = 500): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= maxLength)
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 20) {
    throw new Error(label + " 必须是 0 到 20 的整数")
  }
  return Number(value)
}

function finiteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
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
    if (raw[key] !== undefined) {
      if (!finiteRate(raw[key])) throw new Error("评测门槛必须是 0 到 1 之间的小数：" + key)
      output[key] = raw[key]
    }
  }
  return output
}

function parseLabelProvenance(raw: unknown): ReferenceLabelProvenance {
  if (!object(raw)) throw new Error("评测集缺少参考标签来源")
  for (const key of ["kind", "createdAt", "createdBy", "expertStatus", "notice"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 1000) {
      throw new Error("参考标签来源字段不正确：" + key)
    }
  }
  return raw as unknown as ReferenceLabelProvenance
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

function optionalStrings(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (raw[key] === undefined) return undefined
  if (!strings(raw[key])) throw new Error("参考标签字段不正确：" + key)
  return raw[key] as string[]
}

function parseRecordLineExpectation(raw: unknown): RecordLineExpectation {
  if (!object(raw)) throw new Error("记录条目参考标签格式不正确")
  return {
    textIncludesAny: optionalStrings(raw, "textIncludesAny"),
    sourceIdsInclude: optionalStrings(raw, "sourceIdsInclude"),
    evidenceKindOneOf: optionalStrings(raw, "evidenceKindOneOf"),
    roomIncludesAny: optionalStrings(raw, "roomIncludesAny"),
    stageIncludesAny: optionalStrings(raw, "stageIncludesAny"),
    speakerIncludesAny: optionalStrings(raw, "speakerIncludesAny")
  }
}

function parseRecordExpectation(raw: unknown): RecordReviewExpectation {
  if (!object(raw)) throw new Error("记录整理参考标签格式不正确")
  let time: RecordReviewExpectation["time"]
  if (raw.time !== undefined) {
    if (!object(raw.time)) throw new Error("记录时间参考标签格式不正确")
    const candidateDateEquals = raw.time.candidateDateEquals
    const candidateDateEmpty = raw.time.candidateDateEmpty
    if (candidateDateEquals !== undefined
      && (typeof candidateDateEquals !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidateDateEquals))) {
      throw new Error("记录日期参考标签格式不正确")
    }
    if (candidateDateEmpty !== undefined && typeof candidateDateEmpty !== "boolean") {
      throw new Error("记录空日期参考标签格式不正确")
    }
    time = {
      originalIncludesAny: optionalStrings(raw.time, "originalIncludesAny"),
      candidateDateEquals: candidateDateEquals as string | undefined,
      candidateDateEmpty: candidateDateEmpty as boolean | undefined
    }
  }
  const facts = raw.facts === undefined ? undefined
    : Array.isArray(raw.facts) ? raw.facts.map(parseRecordLineExpectation)
      : (() => { throw new Error("事实参考标签必须是数组") })()
  const opinions = raw.opinions === undefined ? undefined
    : Array.isArray(raw.opinions) ? raw.opinions.map(parseRecordLineExpectation)
      : (() => { throw new Error("意见参考标签必须是数组") })()
  return {
    minFacts: optionalCount(raw.minFacts, "minFacts"),
    maxFacts: optionalCount(raw.maxFacts, "maxFacts"),
    minOpinions: optionalCount(raw.minOpinions, "minOpinions"),
    maxOpinions: optionalCount(raw.maxOpinions, "maxOpinions"),
    minStatements: optionalCount(raw.minStatements, "minStatements"),
    facts,
    opinions,
    time,
    gapsIncludeAny: optionalStrings(raw, "gapsIncludeAny"),
    forbiddenPhrases: optionalStrings(raw, "forbiddenPhrases")
  }
}

function parseCoverageExpectation(raw: unknown): ImageCoverageExpectation {
  if (!object(raw) || typeof raw.imageId !== "string" || !raw.imageId
    || typeof raw.sourceId !== "string" || !raw.sourceId) {
    throw new Error("图片覆盖参考标签格式不正确")
  }
  return {
    imageId: raw.imageId,
    sourceId: raw.sourceId,
    minQualityLimitations: optionalCount(raw.minQualityLimitations, "minQualityLimitations"),
    limitationIncludesAny: optionalStrings(raw, "limitationIncludesAny")
  }
}

function parseImageItemExpectation(raw: unknown): ImageItemExpectation {
  if (!object(raw) || typeof raw.imageId !== "string" || !raw.imageId) {
    throw new Error("图片观察条目参考标签格式不正确")
  }
  return {
    imageId: raw.imageId,
    observationIncludesAny: optionalStrings(raw, "observationIncludesAny"),
    captureSuggestionsIncludeAny: optionalStrings(raw, "captureSuggestionsIncludeAny"),
    limitationsIncludeAny: optionalStrings(raw, "limitationsIncludeAny"),
    priorityOneOf: optionalStrings(raw, "priorityOneOf")
  }
}

function parseImageExpectation(raw: unknown): ImageObservationExpectation {
  if (!object(raw)) throw new Error("图片观察参考标签格式不正确")
  if (raw.forbidMeasurements !== undefined && typeof raw.forbidMeasurements !== "boolean") {
    throw new Error("forbidMeasurements 必须是布尔值")
  }
  return {
    minItems: optionalCount(raw.minItems, "minItems"),
    maxItems: optionalCount(raw.maxItems, "maxItems"),
    coverage: raw.coverage === undefined ? undefined
      : Array.isArray(raw.coverage) ? raw.coverage.map(parseCoverageExpectation)
        : (() => { throw new Error("图片覆盖参考标签必须是数组") })(),
    items: raw.items === undefined ? undefined
      : Array.isArray(raw.items) ? raw.items.map(parseImageItemExpectation)
        : (() => { throw new Error("图片条目参考标签必须是数组") })(),
    forbiddenPhrases: optionalStrings(raw, "forbiddenPhrases"),
    forbidMeasurements: raw.forbidMeasurements as boolean | undefined
  }
}

export function loadM6bEvaluationDataset(datasetPath: string): M6bEvaluationDataset {
  const absolutePath = resolve(datasetPath)
  const basePath = dirname(absolutePath)
  const raw = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown
  if (!object(raw) || raw.version !== 1 || typeof raw.name !== "string" || !raw.name.trim()
    || !["record_review", "image_observation"].includes(String(raw.task))
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 50) {
    throw new Error("M6B 评测集格式不正确")
  }
  const task = raw.task as M6bEvaluationTask
  const seen = new Set<string>()
  const cases = raw.cases.map((item, index): M6bEvaluationCase => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || seen.has(item.id) || typeof item.title !== "string" || !item.title.trim()
      || !["development", "frozen"].includes(String(item.split))
      || !object(item.input) || !object(item.expected)) {
      throw new Error(`第 ${index + 1} 个 M6B 评测用例格式不正确或 ID 重复`)
    }
    seen.add(item.id)
    const rawImages = item.input.images ?? []
    if (!Array.isArray(rawImages) || rawImages.length > 4) {
      throw new Error("评测图片必须是数组且最多 4 张：" + item.id)
    }
    const imageIds = new Set<string>()
    const images = rawImages.map((image, imageIndex) => {
      if (!object(image) || typeof image.id !== "string" || !image.id
        || imageIds.has(image.id) || typeof image.sourceId !== "string"
        || typeof image.path !== "string" || !image.path.trim()) {
        throw new Error(`评测用例 ${item.id} 的第 ${imageIndex + 1} 张图片无效`)
      }
      imageIds.add(image.id)
      const path = resolve(basePath, image.path)
      const bytes = readFileSync(path)
      if (bytes.length > 2 * 1024 * 1024) throw new Error("评测图片超过 2MB：" + path)
      const mime = inferImageMime(path, bytes)
      return {
        id: image.id,
        sourceId: image.sourceId,
        dataUrl: `data:${mime};base64,${bytes.toString("base64")}`
      }
    })
    const input = validateInput({
      requestId: "eval_" + item.id,
      projectId: item.input.projectId,
      task,
      stage: item.input.stage,
      question: item.input.question,
      sources: item.input.sources,
      images,
      ...(item.input.target === undefined ? {} : { target: item.input.target })
    })
    return {
      id: item.id,
      title: item.title,
      critical: item.critical === true,
      split: item.split as EvaluationSplit,
      tags: strings(item.tags, 20, 100) ? item.tags : [],
      input,
      expected: task === "record_review"
        ? parseRecordExpectation(item.expected)
        : parseImageExpectation(item.expected),
      imageCount: images.length
    }
  })
  return {
    version: 1,
    name: raw.name,
    task,
    labelProvenance: parseLabelProvenance(raw.labelProvenance),
    thresholds: parseThresholds(raw.thresholds),
    cases
  }
}

export function selectM6bEvaluationCases(
  cases: M6bEvaluationCase[],
  options: { caseIds?: string[]; maxCases?: number; split?: EvaluationSplit }
): M6bEvaluationCase[] {
  const { caseIds, maxCases, split } = options
  if (maxCases !== undefined && (!Number.isSafeInteger(maxCases) || maxCases < 1)) {
    throw new Error("--max-cases 必须是正整数")
  }
  let selected = split ? cases.filter(item => item.split === split) : cases
  if (caseIds?.length) {
    if (new Set(caseIds).size !== caseIds.length) throw new Error("--case-ids 不能包含重复 ID")
    const byId = new Map(selected.map(item => [item.id, item]))
    selected = caseIds.map(id => {
      const item = byId.get(id)
      if (!item) throw new Error("当前评测范围不存在用例：" + id)
      return item
    })
  }
  return maxCases === undefined ? selected : selected.slice(0, maxCases)
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "")
}

function includesAny(actual: string, expected?: string[]): boolean {
  if (!expected?.length) return true
  const normalized = normalize(actual)
  return expected.some(item => normalized.includes(normalize(item)))
}

function assertion(name: string, passed: boolean, expected: string, actual: string): EvaluationAssertion {
  return { name, passed, expected, actual }
}

function score(assertions: EvaluationAssertion[]): MaterialCaseScore {
  const passedAssertions = assertions.filter(item => item.passed).length
  return {
    passed: passedAssertions === assertions.length,
    passedAssertions,
    totalAssertions: assertions.length,
    assertions
  }
}

function findFact(
  values: RecordReviewFact[],
  expected: RecordLineExpectation
): RecordReviewFact | undefined {
  return values.find(item =>
    (!expected.sourceIdsInclude || expected.sourceIdsInclude.every(id => item.sourceIds.includes(id)))
    && includesAny(item.text, expected.textIncludesAny))
}

function findOpinion(
  values: RecordReviewOpinion[],
  expected: RecordLineExpectation
): RecordReviewOpinion | undefined {
  return values.find(item =>
    (!expected.sourceIdsInclude || expected.sourceIdsInclude.every(id => item.sourceIds.includes(id)))
    && includesAny(item.text, expected.textIncludesAny))
}

function hasAffirmativePhrase(actual: string, phrase: string): boolean {
  const text = normalize(actual)
  const wanted = normalize(phrase)
  let index = text.indexOf(wanted)
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 10), index)
    if (!/(不能|无法|不可|不应|不代表|未|没有|禁止|避免)/.test(prefix)) return true
    index = text.indexOf(wanted, index + wanted.length)
  }
  return false
}

function addCountAssertion(
  assertions: EvaluationAssertion[],
  name: string,
  actual: number,
  min?: number,
  max?: number
) {
  if (min !== undefined) assertions.push(assertion(name + ".min", actual >= min, `不少于 ${min}`, String(actual)))
  if (max !== undefined) assertions.push(assertion(name + ".max", actual <= max, `不多于 ${max}`, String(actual)))
}

export function scoreRecordReviewResult(
  expected: RecordReviewExpectation,
  result?: AiResult
): MaterialCaseScore {
  const review = result?.recordReview
  const facts = review?.facts || []
  const opinions = review?.opinions || []
  const assertions: EvaluationAssertion[] = [
    assertion("recordReview.exists", Boolean(review), "专用结果存在", review ? "存在" : "缺失")
  ]
  addCountAssertion(assertions, "facts", facts.length, expected.minFacts, expected.maxFacts)
  addCountAssertion(assertions, "opinions", opinions.length, expected.minOpinions, expected.maxOpinions)
  if (expected.minStatements !== undefined) assertions.push(assertion(
    "statements.min",
    facts.length + opinions.length >= expected.minStatements,
    `事实和意见合计不少于 ${expected.minStatements}`,
    String(facts.length + opinions.length)
  ))
  for (const [index, wanted] of (expected.facts || []).entries()) {
    const actual = findFact(facts, wanted)
    assertions.push(assertion(`facts[${index}].exists`, Boolean(actual), "匹配事实存在", actual?.text || "缺失"))
    if (wanted.sourceIdsInclude) assertions.push(assertion(
      `facts[${index}].sourceIds`,
      Boolean(actual && wanted.sourceIdsInclude.every(id => actual.sourceIds.includes(id))),
      wanted.sourceIdsInclude.join(", "),
      actual?.sourceIds.join(", ") || "缺失"
    ))
    if (wanted.evidenceKindOneOf) assertions.push(assertion(
      `facts[${index}].evidenceKind`,
      Boolean(actual && wanted.evidenceKindOneOf.includes(actual.evidenceKind)),
      wanted.evidenceKindOneOf.join(" | "), actual?.evidenceKind || "缺失"
    ))
    if (wanted.roomIncludesAny) assertions.push(assertion(
      `facts[${index}].room`, Boolean(actual && includesAny(actual.roomCandidate, wanted.roomIncludesAny)),
      wanted.roomIncludesAny.join(" | "), actual?.roomCandidate || "缺失"
    ))
    if (wanted.stageIncludesAny) assertions.push(assertion(
      `facts[${index}].stage`, Boolean(actual && includesAny(actual.stageCandidate, wanted.stageIncludesAny)),
      wanted.stageIncludesAny.join(" | "), actual?.stageCandidate || "缺失"
    ))
  }
  for (const [index, wanted] of (expected.opinions || []).entries()) {
    const actual = findOpinion(opinions, wanted)
    assertions.push(assertion(`opinions[${index}].exists`, Boolean(actual), "匹配意见存在", actual?.text || "缺失"))
    if (wanted.sourceIdsInclude) assertions.push(assertion(
      `opinions[${index}].sourceIds`,
      Boolean(actual && wanted.sourceIdsInclude.every(id => actual.sourceIds.includes(id))),
      wanted.sourceIdsInclude.join(", "), actual?.sourceIds.join(", ") || "缺失"
    ))
    if (wanted.speakerIncludesAny) assertions.push(assertion(
      `opinions[${index}].speaker`, Boolean(actual && includesAny(actual.speaker, wanted.speakerIncludesAny)),
      wanted.speakerIncludesAny.join(" | "), actual?.speaker || "缺失"
    ))
  }
  if (expected.time?.originalIncludesAny) assertions.push(assertion(
    "time.originalExpression",
    Boolean(review && includesAny(review.time.originalExpression, expected.time.originalIncludesAny)),
    expected.time.originalIncludesAny.join(" | "), review?.time.originalExpression || "缺失"
  ))
  if (expected.time?.candidateDateEquals !== undefined) assertions.push(assertion(
    "time.candidateDate",
    review?.time.candidateDate === expected.time.candidateDateEquals,
    expected.time.candidateDateEquals, review?.time.candidateDate || "空"
  ))
  if (expected.time?.candidateDateEmpty) assertions.push(assertion(
    "time.candidateDate.empty", review?.time.candidateDate === "", "空字符串", review?.time.candidateDate || "空"
  ))
  if (expected.gapsIncludeAny) assertions.push(assertion(
    "gaps.includes",
    Boolean(review && includesAny(review.gaps.join(" "), expected.gapsIncludeAny)),
    expected.gapsIncludeAny.join(" | "), review?.gaps.join("；") || "空"
  ))
  const reviewText = review
    ? [review.title, ...facts.map(item => item.text), ...opinions.map(item => item.text)].join(" ")
    : ""
  for (const phrase of expected.forbiddenPhrases || []) assertions.push(assertion(
    `forbidden.${phrase}`,
    !hasAffirmativePhrase(reviewText, phrase),
    "不得作为肯定结论出现", reviewText
  ))
  return score(assertions)
}

function findImageItem(
  values: ImageObservationItem[],
  expected: ImageItemExpectation
): ImageObservationItem | undefined {
  return values.find(item => item.imageId === expected.imageId
    && includesAny(item.observation, expected.observationIncludesAny))
}

export function scoreImageObservationResult(
  expected: ImageObservationExpectation,
  result?: AiResult
): MaterialCaseScore {
  const review = result?.imageObservation
  const items = review?.items || []
  const assertions: EvaluationAssertion[] = [
    assertion("imageObservation.exists", Boolean(review), "专用结果存在", review ? "存在" : "缺失")
  ]
  addCountAssertion(assertions, "items", items.length, expected.minItems, expected.maxItems)
  for (const [index, wanted] of (expected.coverage || []).entries()) {
    const actual = review?.images.find(item => item.imageId === wanted.imageId)
    assertions.push(assertion(`coverage[${index}].exists`, Boolean(actual), wanted.imageId, actual?.imageId || "缺失"))
    assertions.push(assertion(
      `coverage[${index}].sourceId`, actual?.sourceId === wanted.sourceId,
      wanted.sourceId, actual?.sourceId || "缺失"
    ))
    if (wanted.minQualityLimitations !== undefined) assertions.push(assertion(
      `coverage[${index}].limitations.min`,
      Boolean(actual && actual.qualityLimitations.length >= wanted.minQualityLimitations),
      `不少于 ${wanted.minQualityLimitations}`,
      String(actual?.qualityLimitations.length ?? 0)
    ))
    if (wanted.limitationIncludesAny) assertions.push(assertion(
      `coverage[${index}].limitations.includes`,
      Boolean(actual && includesAny(actual.qualityLimitations.join(" "), wanted.limitationIncludesAny)),
      wanted.limitationIncludesAny.join(" | "), actual?.qualityLimitations.join("；") || "空"
    ))
  }
  for (const [index, wanted] of (expected.items || []).entries()) {
    const actual = findImageItem(items, wanted)
    assertions.push(assertion(`items[${index}].exists`, Boolean(actual), "匹配观察存在", actual?.observation || "缺失"))
    if (wanted.captureSuggestionsIncludeAny) assertions.push(assertion(
      `items[${index}].captureSuggestions`,
      Boolean(actual && includesAny(actual.captureSuggestions.join(" "), wanted.captureSuggestionsIncludeAny)),
      wanted.captureSuggestionsIncludeAny.join(" | "), actual?.captureSuggestions.join("；") || "空"
    ))
    if (wanted.limitationsIncludeAny) assertions.push(assertion(
      `items[${index}].limitations`,
      Boolean(actual && includesAny(actual.limitations.join(" "), wanted.limitationsIncludeAny)),
      wanted.limitationsIncludeAny.join(" | "), actual?.limitations.join("；") || "空"
    ))
    if (wanted.priorityOneOf) assertions.push(assertion(
      `items[${index}].priority`, Boolean(actual && wanted.priorityOneOf.includes(actual.priority)),
      wanted.priorityOneOf.join(" | "), actual?.priority || "缺失"
    ))
  }
  const observationText = items
    .flatMap(item => [item.observation, item.suspectedExplanation, item.priorityReason])
    .join(" ")
  for (const phrase of expected.forbiddenPhrases || []) assertions.push(assertion(
    `forbidden.${phrase}`,
    !hasAffirmativePhrase(observationText, phrase),
    "不得作为肯定结论出现", observationText
  ))
  if (expected.forbidMeasurements) assertions.push(assertion(
    "measurements.forbidden",
    !/\b\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米|公分)\b/i.test(observationText),
    "没有尺度时不报告精确尺寸", observationText
  ))
  return score(assertions)
}

export function scoreM6bResult(
  task: M6bEvaluationTask,
  expected: M6bEvaluationCase["expected"],
  result?: AiResult
): MaterialCaseScore {
  return task === "record_review"
    ? scoreRecordReviewResult(expected as RecordReviewExpectation, result)
    : scoreImageObservationResult(expected as ImageObservationExpectation, result)
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

export function summarizeM6bEvaluation(
  outcomes: M6bEvaluationOutcome[],
  thresholds: EvaluationThresholds
): M6bEvaluationSummary {
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
  const bySplit = Object.fromEntries((["development", "frozen"] as EvaluationSplit[]).map(split => {
    const selected = outcomes.filter(item => item.split === split)
    return [split, {
      caseCount: selected.length,
      casesPassed: selected.filter(item => item.contractValid && item.score.passed).length
    }]
  })) as M6bEvaluationSummary["bySplit"]
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

export function reportM6bResult(result: AiResult): M6bEvaluationOutcome["result"] {
  return {
    summary: result.summary,
    unknowns: result.unknowns,
    ...(result.recordReview ? { recordReview: result.recordReview } : {}),
    ...(result.imageObservation ? { imageObservation: result.imageObservation } : {})
  }
}
