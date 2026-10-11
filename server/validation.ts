import {
  AI_SOURCE_KINDS,
  AI_TASKS,
  MATERIAL_CHECK_FIELD_KEYS,
  MATERIAL_CHECK_REQUIRED_FIELD_KEYS,
  PROJECT_SUMMARY_SECTION_KEYS,
  RECORD_REVIEW_EVIDENCE_KINDS,
  type AiInput,
  type AiResult,
  type BudgetHumanReview,
  type ConsultationHumanReview,
  type ImageObservationReview,
  type MaterialCheckReview,
  type MaterialCheckFieldStatus,
  type ProjectSummaryHumanReview,
  type RecordReviewReview,
  type RectificationHumanReview
} from "../miniprogram/core/ai-contract.ts"

export class AppError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code || (
      status === 400 ? "INVALID_INPUT"
        : status === 401 ? "UNAUTHORIZED"
          : status === 403 ? "FORBIDDEN"
            : status === 404 ? "NOT_FOUND"
              : status === 409 ? "STATE_CONFLICT"
                : status === 413 ? "PAYLOAD_TOO_LARGE"
                  : status === 429 ? "RATE_LIMITED"
                    : status >= 500 ? "UPSTREAM_OR_SERVER_ERROR"
                      : "APP_ERROR"
    )
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
const exactKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key))
const uniqueIds = (value: unknown, allowed: Set<string>): value is string[] =>
  Array.isArray(value) && value.length <= 30
  && value.every(item => typeof item === "string" && allowed.has(item))
  && new Set(value).size === value.length
const stringList = (value: unknown, maxItems: number, maxLength: number): value is string[] =>
  Array.isArray(value) && value.length <= maxItems
  && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength)

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + "T00:00:00.000Z")
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validIsoTimestamp(value: string): boolean {
  if (!value || value.length > 40) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

export function validateInput(raw: unknown): AiInput {
  if (!object(raw) || !id(raw.requestId) || !id(raw.projectId)
    || !AI_TASKS.some(task => task.id === raw.task)
    || !text(raw.stage, 50) || !text(raw.question, 4000)
    || !Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 30
    || !Array.isArray(raw.images) || raw.images.length > 4) throw new AppError(400, "任务输入格式不正确")
  const ids = new Set<string>()
  for (const source of raw.sources) {
    if (!object(source) || !id(source.id) || source.id.startsWith("kc_") || ids.has(source.id)
      || !AI_SOURCE_KINDS.includes(source.kind as typeof AI_SOURCE_KINDS[number])
      || !text(source.title, 200) || !text(source.text, 12000) || !text(source.version, 100)) {
      throw new AppError(400, "资料格式或标识不正确")
    }
    const authority = source.authority
    if (authority !== undefined
      && !["project_fact", "approved_agreement", "unapproved_agreement"].includes(String(authority))) {
      throw new AppError(400, "资料权威状态不正确")
    }
    if (source.kind === "agreement"
      && !["approved_agreement", "unapproved_agreement"].includes(String(authority))) {
      throw new AppError(400, "约定资料必须标明是否已经负责人批准")
    }
    if (source.kind !== "agreement" && authority !== undefined && authority !== "project_fact") {
      throw new AppError(400, "非约定资料不能声明为约定基线")
    }
    if (source.relatedMaterialId !== undefined && !id(source.relatedMaterialId)) {
      throw new AppError(400, "资料关联材料标识不正确")
    }
    if (source.relatedConsultationId !== undefined && !id(source.relatedConsultationId)) {
      throw new AppError(400, "资料关联咨询标识不正确")
    }
    if (source.occurredAt !== undefined && !validIsoTimestamp(String(source.occurredAt))) {
      throw new AppError(400, "资料发生时间不正确")
    }
    if (source.updatedAt !== undefined && !validIsoTimestamp(String(source.updatedAt))) {
      throw new AppError(400, "资料更新时间不正确")
    }
    if (source.room !== undefined && !text(source.room, 50)) {
      throw new AppError(400, "资料房间范围不正确")
    }
    if (source.stage !== undefined && !text(source.stage, 50)) {
      throw new AppError(400, "资料工序范围不正确")
    }
    ids.add(source.id)
  }
  const validMode = raw.task === "rectification"
    ? raw.mode === "proposal" || raw.mode === "review"
    : raw.task === "consultation"
      ? raw.mode === "prepare" || raw.mode === "response"
      : raw.mode === undefined
  if (!validMode) throw new AppError(400, "AI 子模式与当前任务不一致")
  if (raw.task === "project_summary") {
    const scope = raw.summaryScope
    if (!object(scope)
      || !exactKeys(scope, [
        "title", "purpose", "audience", "stage", "room", "dateFrom", "dateTo", "cutoffAt"
      ])
      || !text(scope.title, 120) || !scope.title.trim()
      || !text(scope.purpose, 1000) || !scope.purpose.trim()
      || !text(scope.audience, 200) || !scope.audience.trim()
      || !text(scope.stage, 50) || !scope.stage.trim()
      || !text(scope.room, 50) || !scope.room.trim()
      || !text(scope.dateFrom, 10) || !text(scope.dateTo, 10)
      || !validIsoTimestamp(String(scope.cutoffAt))
      || ((scope.dateFrom !== "" || scope.dateTo !== "")
        && (!validIsoDate(String(scope.dateFrom)) || !validIsoDate(String(scope.dateTo))))
      || (scope.dateFrom !== "" && scope.dateFrom > scope.dateTo)) {
      throw new AppError(400, "项目总结的标题、用途、对象或范围不正确")
    }
    for (const source of raw.sources) {
      if (!object(source)
        || typeof source.occurredAt !== "string" || !validIsoTimestamp(source.occurredAt)
        || typeof source.updatedAt !== "string" || !validIsoTimestamp(source.updatedAt)) {
        throw new AppError(400, "项目总结资料必须包含发生时间和更新时间")
      }
      if (["record", "issue"].includes(String(source.kind))) {
        if (typeof source.room !== "string" || !source.room.trim()
          || typeof source.stage !== "string" || !source.stage.trim()) {
          throw new AppError(400, "项目总结的记录和问题必须包含房间与工序范围")
        }
        if ((scope.room !== "全部房间" && source.room !== scope.room)
          || (scope.stage !== "全部工序" && source.stage !== scope.stage)) {
          throw new AppError(400, "项目总结包含范围外的记录或问题")
        }
      }
      if (["record", "purchase", "receipt", "consultation_response"].includes(String(source.kind))
        && scope.dateFrom !== ""
        && (source.occurredAt.slice(0, 10) < scope.dateFrom
          || source.occurredAt.slice(0, 10) > scope.dateTo)) {
        throw new AppError(400, "项目总结包含日期范围外的事件资料")
      }
      if (new Date(source.updatedAt).getTime() > new Date(String(scope.cutoffAt)).getTime()) {
        throw new AppError(400, "项目总结资料晚于本次截止时间")
      }
    }
  } else if (raw.summaryScope !== undefined) {
    throw new AppError(400, "当前任务不应包含项目总结范围")
  }
  const expectedTargetKind = raw.task === "record_review"
    ? "record"
    : raw.task === "rectification"
      ? "issue"
      : raw.task === "consultation" && raw.mode === "response"
        ? "consultation"
        : undefined
  const targetRequired = raw.task === "rectification"
    || (raw.task === "consultation" && raw.mode === "response")
  if (targetRequired && raw.target === undefined) {
    throw new AppError(400, "当前 AI 子模式必须锁定一个业务目标")
  }
  if (raw.target !== undefined) {
    if (!expectedTargetKind || !object(raw.target)
      || !exactKeys(raw.target, ["kind", "id", "version"])
      || raw.target.kind !== expectedTargetKind
      || !id(raw.target.id) || !text(raw.target.version, 100)) {
      throw new AppError(400, "AI 写回目标格式不正确")
    }
    const target = raw.target as Record<string, unknown>
    const targetSource = raw.sources.find(source =>
      object(source) && source.id === target.id)
    if (!object(targetSource) || targetSource.kind !== expectedTargetKind
      || targetSource.version !== target.version) {
      throw new AppError(400, "AI 写回目标必须引用本次所选对象版本")
    }
  }
  if (JSON.stringify(raw.sources).length > 60000) throw new AppError(413, "所选文本过长，请缩小资料范围")
  const imageIds = new Set<string>()
  for (const img of raw.images) {
    if (!object(img) || !ids.has(String(img.sourceId)) || !text(img.dataUrl, 2800000)
      || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(String(img.dataUrl))) {
      throw new AppError(400, "仅接受关联所选资料的 JPEG、PNG 或 WebP 图片")
    }
    if (img.id !== undefined) {
      if (!id(img.id) || imageIds.has(img.id)) throw new AppError(400, "图片标识不正确或重复")
      imageIds.add(img.id)
    }
    const b64 = String(img.dataUrl).split(",")[1]
    const bytes = Buffer.from(b64, "base64")
    const mime = String(img.dataUrl).split(";")[0]
    const valid = mime.endsWith("jpeg") ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime.endsWith("png") ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP"
    if (!valid || bytes.length > 2 * 1024 * 1024) throw new AppError(400, "图片内容与格式不符或超过 2MB")
  }
  if (raw.task === "image_observation"
    && (!raw.images.length || raw.images.some(image => !object(image) || !id(image.id)))) {
    throw new AppError(400, "图片分析需要至少一张带唯一标识的图片")
  }
  if (raw.task === "material_check") {
    const materials = raw.sources.filter(source => object(source) && source.kind === "material")
    const receipts = raw.sources.filter(source => object(source) && source.kind === "receipt")
    if (materials.length !== 1 || receipts.length !== 1) {
      throw new AppError(400, "材料到货核对必须且只能选择一个材料和一个到货批次")
    }
    if (receipts[0].relatedMaterialId !== materials[0].id) {
      throw new AppError(400, "所选到货批次不属于本次核对材料")
    }
  }
  if (raw.task === "rectification") {
    const targetId = object(raw.target) ? raw.target.id : ""
    const issues = raw.sources.filter(source => object(source) && source.kind === "issue")
    if (!issues.some(source => source.id === targetId)) {
      throw new AppError(400, "整改辅助必须包含锁定的问题事项")
    }
  }
  if (raw.task === "consultation" && raw.mode === "prepare") {
    if (!raw.sources.some(source => object(source)
      && (source.kind === "record" || source.kind === "issue"))) {
      throw new AppError(400, "准备咨询至少需要选择一条记录或问题")
    }
  }
  if (raw.task === "consultation" && raw.mode === "response") {
    const consultationId = object(raw.target) ? String(raw.target.id) : ""
    const responses = raw.sources.filter(source =>
      object(source) && source.kind === "consultation_response")
    if (!responses.length || responses.some(source =>
      source.relatedConsultationId !== consultationId)) {
      throw new AppError(400, "整理回复必须选择属于本次咨询的回复")
    }
  }
  return raw as unknown as AiInput
}

function validateRecordReview(raw: unknown, input: AiInput): void {
  if (!object(raw)
    || !exactKeys(raw, ["title", "facts", "time", "opinions", "gaps"])
    || !text(raw.title, 120) || !raw.title.trim()
    || !Array.isArray(raw.facts) || raw.facts.length > 20
    || !Array.isArray(raw.opinions) || raw.opinions.length > 20
    || !stringList(raw.gaps, 20, 500)
    || !object(raw.time)
    || !exactKeys(raw.time, ["originalExpression", "candidateDate", "sourceIds", "note"])) {
    throw new AppError(502, "记录整理结构错误，未保存为有效分析")
  }
  const sourceIds = new Set(input.sources.map(source => source.id))
  for (const fact of raw.facts) {
    if (!object(fact)
      || !exactKeys(fact, ["text", "evidenceKind", "sourceIds", "roomCandidate", "stageCandidate"])
      || !text(fact.text, 1000) || !fact.text.trim()
      || !RECORD_REVIEW_EVIDENCE_KINDS.includes(
        fact.evidenceKind as typeof RECORD_REVIEW_EVIDENCE_KINDS[number])
      || !uniqueIds(fact.sourceIds, sourceIds) || !fact.sourceIds.length
      || !text(fact.roomCandidate, 50) || !text(fact.stageCandidate, 50)) {
      throw new AppError(502, "记录整理事实、分类或引用不正确")
    }
  }
  const time = raw.time
  if (!text(time.originalExpression, 100) || !text(time.candidateDate, 10)
    || (time.candidateDate !== "" && !validIsoDate(time.candidateDate))
    || !uniqueIds(time.sourceIds, sourceIds)
    || !text(time.note, 500)
    || ((time.originalExpression || time.candidateDate) && !time.sourceIds.length)) {
    throw new AppError(502, "记录整理时间候选或引用不正确")
  }
  for (const opinion of raw.opinions) {
    if (!object(opinion)
      || !exactKeys(opinion, ["text", "speaker", "sourceIds"])
      || !text(opinion.text, 1000) || !opinion.text.trim()
      || !text(opinion.speaker, 100) || !opinion.speaker.trim()
      || !uniqueIds(opinion.sourceIds, sourceIds) || !opinion.sourceIds.length) {
      throw new AppError(502, "记录整理意见或引用不正确")
    }
  }
  if (!raw.facts.length && !raw.opinions.length && !raw.gaps.length) {
    throw new AppError(502, "记录整理没有事实、意见或待补信息")
  }
}

function validateImageObservation(
  raw: unknown,
  input: AiInput,
  knowledge: Array<{ id: string }>
): void {
  if (!object(raw)
    || !exactKeys(raw, ["images", "items"])
    || !Array.isArray(raw.images) || raw.images.length !== input.images.length
    || !Array.isArray(raw.items) || raw.items.length > 20) {
    throw new AppError(502, "图片观察结构错误，未保存为有效分析")
  }
  const inputImages = new Map(input.images.map(image => [image.id!, image.sourceId]))
  const covered = new Set<string>()
  for (const image of raw.images) {
    if (!object(image)
      || !exactKeys(image, ["imageId", "sourceId", "visibleScope", "qualityLimitations"])
      || !id(image.imageId) || covered.has(image.imageId)
      || inputImages.get(image.imageId) !== image.sourceId
      || !text(image.visibleScope, 1000) || !image.visibleScope.trim()
      || !stringList(image.qualityLimitations, 10, 500)) {
      throw new AppError(502, "图片观察范围、画质限制或图片引用不正确")
    }
    covered.add(image.imageId)
  }
  if (covered.size !== inputImages.size) throw new AppError(502, "图片观察未覆盖全部所选图片")
  const sourceIds = new Set(input.sources.map(source => source.id))
  const knowledgeIds = new Set(knowledge.map(item => item.id))
  const itemIds = new Set<string>()
  for (const item of raw.items) {
    if (!object(item)
      || !exactKeys(item, [
        "itemId", "imageId", "sourceId", "object", "observation", "region",
        "suspectedExplanation", "limitations", "captureSuggestions", "priority",
        "priorityReason", "knowledgeIds"
      ])
      || !id(item.itemId) || itemIds.has(item.itemId)
      || !id(item.imageId) || inputImages.get(item.imageId) !== item.sourceId
      || !sourceIds.has(String(item.sourceId))
      || !text(item.object, 200) || !item.object.trim()
      || !text(item.observation, 1000) || !item.observation.trim()
      || !text(item.suspectedExplanation, 1000)
      || !stringList(item.limitations, 10, 500)
      || !stringList(item.captureSuggestions, 10, 500)
      || !["high", "medium", "low"].includes(String(item.priority))
      || !text(item.priorityReason, 500) || !item.priorityReason.trim()
      || !uniqueIds(item.knowledgeIds, knowledgeIds)) {
      throw new AppError(502, "图片观察条目、引用或建议格式不正确")
    }
    itemIds.add(item.itemId)
    if (item.region !== undefined) {
      if (!object(item.region)
        || !exactKeys(item.region, ["x", "y", "width", "height"])) {
        throw new AppError(502, "图片观察区域格式不正确")
      }
      const { x, y, width, height } = item.region
      if (typeof x !== "number" || !Number.isFinite(x)
        || typeof y !== "number" || !Number.isFinite(y)
        || typeof width !== "number" || !Number.isFinite(width)
        || typeof height !== "number" || !Number.isFinite(height)
        || x < 0 || y < 0 || width <= 0 || height <= 0
        || x + width > 1 || y + height > 1) {
        throw new AppError(502, "图片观察区域必须位于归一化原图范围内")
      }
    }
  }
}

function validateMaterialCheck(raw: unknown, input: AiInput): void {
  if (!object(raw)
    || !exactKeys(raw, ["materialSourceId", "receiptSourceId", "fields"])
    || !id(raw.materialSourceId) || !id(raw.receiptSourceId)
    || !Array.isArray(raw.fields) || raw.fields.length < 4 || raw.fields.length > 8) {
    throw new AppError(502, "材料核对结构错误，未保存为有效分析")
  }
  const sources = new Map(input.sources.map(source => [source.id, source]))
  if (sources.get(raw.materialSourceId)?.kind !== "material"
    || sources.get(raw.receiptSourceId)?.kind !== "receipt") {
    throw new AppError(502, "材料核对未关联本次所选材料或到货批次")
  }
  const sourceIds = new Set(sources.keys())
  const seen = new Set<string>()
  const statuses = new Set<MaterialCheckFieldStatus>([
    "matches", "differs", "observed_only", "expected_only", "unknown"
  ])
  for (const field of raw.fields) {
    if (!object(field)
      || !exactKeys(field, [
        "key", "label", "observedValue", "expectedValue", "status",
        "observedSourceIds", "expectedSourceIds", "note"
      ])
      || !MATERIAL_CHECK_FIELD_KEYS.includes(field.key as typeof MATERIAL_CHECK_FIELD_KEYS[number])
      || seen.has(String(field.key))
      || !text(field.label, 50) || !field.label.trim()
      || !text(field.observedValue, 500) || !text(field.expectedValue, 500)
      || !statuses.has(field.status as MaterialCheckFieldStatus)
      || !uniqueIds(field.observedSourceIds, sourceIds)
      || !uniqueIds(field.expectedSourceIds, sourceIds)
      || !text(field.note, 1000)) {
      throw new AppError(502, "材料核对字段格式、引用或重复项不正确")
    }
    seen.add(String(field.key))
    const observed = field.observedValue.trim()
    const expected = field.expectedValue.trim()
    const observedIds = field.observedSourceIds as string[]
    const expectedIds = field.expectedSourceIds as string[]
    const status = field.status as MaterialCheckFieldStatus
    const approvedBaseline = expectedIds.some(sourceId => {
      const source = sources.get(sourceId)
      return source?.kind === "agreement"
        && source.authority === "approved_agreement"
        && source.relatedMaterialId === raw.materialSourceId
    })
    if ((observed && !observedIds.length)
      || (!observed && observedIds.length && status !== "unknown" && status !== "expected_only")
      || Boolean(expected) !== Boolean(expectedIds.length)) {
      throw new AppError(502, "材料核对字段值与来源关系不正确")
    }
    if (expected && !approvedBaseline) {
      throw new AppError(502, "材料核对期望值必须引用本材料的已批准约定版本")
    }
    if (status === "matches" || status === "differs") {
      if (!observed || !expected) {
        throw new AppError(502, "一致或差异结论必须同时引用观察资料和已批准约定")
      }
    } else if (status === "observed_only") {
      if (!observed || expected) {
        throw new AppError(502, "仅观察字段必须有观察值且不能伪造期望基线")
      }
    } else if (status === "expected_only") {
      if (observed || !expected) {
        throw new AppError(502, "仅期望字段必须有期望值且现场观察保持为空")
      }
    } else if (!field.note.trim()) {
      throw new AppError(502, "未知字段需说明无法识别或无法比较的原因")
    }
  }
  if (MATERIAL_CHECK_REQUIRED_FIELD_KEYS.some(key => !seen.has(key))) {
    throw new AppError(502, "材料核对缺少品牌、型号、规格或数量核心字段")
  }
}

function validateRectification(
  raw: unknown,
  input: AiInput,
  knowledge: Array<{ id: string }>
): void {
  if (!object(raw) || raw.mode !== input.mode) {
    throw new AppError(502, "整改辅助模式与任务不一致")
  }
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const sourceIds = new Set(sources.keys())
  const knowledgeIds = new Set(knowledge.map(item => item.id))
  const targetId = input.target?.kind === "issue" ? input.target.id : ""
  if (!id(raw.issueSourceId) || raw.issueSourceId !== targetId
    || sources.get(raw.issueSourceId)?.kind !== "issue") {
    throw new AppError(502, "整改辅助未引用本次锁定的问题事项")
  }
  if (raw.mode === "proposal") {
    if (!exactKeys(raw, ["mode", "issueSourceId", "issueSummary", "premises", "gaps", "proposals"])
      || !text(raw.issueSummary, 2000) || !raw.issueSummary.trim()
      || !stringList(raw.premises, 20, 1000)
      || !stringList(raw.gaps, 20, 1000)
      || !Array.isArray(raw.proposals) || raw.proposals.length > 5
      || (!raw.proposals.length && !raw.gaps.length)) {
      throw new AppError(502, "整改预案结构不正确")
    }
    const optionIds = new Set<string>()
    for (const option of raw.proposals) {
      if (!object(option)
        || !exactKeys(option, [
          "optionId", "title", "actions", "applicability", "impacts", "costAndSchedule",
          "verificationEvidence", "sourceIds", "knowledgeIds"
        ])
        || !id(option.optionId) || optionIds.has(option.optionId)
        || !text(option.title, 120) || !option.title.trim()
        || !stringList(option.actions, 10, 1000) || !option.actions.length
        || !stringList(option.applicability, 10, 1000)
        || !stringList(option.impacts, 10, 1000)
        || !text(option.costAndSchedule, 1000)
        || !stringList(option.verificationEvidence, 10, 1000)
        || !uniqueIds(option.sourceIds, sourceIds) || !option.sourceIds.length
        || !uniqueIds(option.knowledgeIds, knowledgeIds)) {
        throw new AppError(502, "整改预案条目、引用或边界不正确")
      }
      optionIds.add(option.optionId)
    }
    return
  }
  if (raw.mode !== "review"
    || !exactKeys(raw, [
      "mode", "issueSourceId", "treatmentId", "evidenceRelation", "checks", "gaps"
    ])
    || !id(raw.treatmentId)
    || !["confirmed_same_location", "uncertain", "different"].includes(String(raw.evidenceRelation))
    || !Array.isArray(raw.checks) || raw.checks.length > 20
    || !stringList(raw.gaps, 20, 1000)
    || (!raw.checks.length && !raw.gaps.length)) {
    throw new AppError(502, "整改复查参考结构不正确")
  }
  const checkIds = new Set<string>()
  for (const check of raw.checks) {
    if (!object(check)
      || !exactKeys(check, [
        "checkId", "requirement", "beforeSourceIds", "afterSourceIds", "status",
        "observation", "limitations", "nextSteps", "knowledgeIds"
      ])
      || !id(check.checkId) || checkIds.has(check.checkId)
      || !text(check.requirement, 1000) || !check.requirement.trim()
      || !uniqueIds(check.beforeSourceIds, sourceIds)
      || !uniqueIds(check.afterSourceIds, sourceIds)
      || !(check.beforeSourceIds.length || check.afterSourceIds.length)
      || !["visible_improved", "concern_remains", "not_verifiable"].includes(String(check.status))
      || !text(check.observation, 1000) || !check.observation.trim()
      || !stringList(check.limitations, 10, 1000)
      || !stringList(check.nextSteps, 10, 1000)
      || !uniqueIds(check.knowledgeIds, knowledgeIds)
      || (check.status === "not_verifiable" && !check.limitations.length)) {
      throw new AppError(502, "整改复查条目、证据或限制不正确")
    }
    checkIds.add(check.checkId)
  }
}

function validFindings(value: unknown, sourceIds: Set<string>): boolean {
  return Array.isArray(value) && value.length <= 20 && value.every(item =>
    object(item) && exactKeys(item, ["text", "sourceIds"])
    && text(item.text, 2000) && item.text.trim()
    && uniqueIds(item.sourceIds, sourceIds) && item.sourceIds.length > 0)
}

function validateConsultation(raw: unknown, input: AiInput): void {
  if (!object(raw) || raw.mode !== input.mode) {
    throw new AppError(502, "咨询整理模式与任务不一致")
  }
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const sourceIds = new Set(sources.keys())
  if (raw.mode === "prepare") {
    if (!exactKeys(raw, [
      "mode", "title", "purpose", "summary", "facts", "timeline", "disputes",
      "gaps", "questions"
    ])
      || !text(raw.title, 120) || !raw.title.trim()
      || !text(raw.purpose, 1000) || !raw.purpose.trim()
      || !text(raw.summary, 3000) || !raw.summary.trim()
      || !validFindings(raw.facts, sourceIds)
      || !validFindings(raw.timeline, sourceIds)
      || !validFindings(raw.disputes, sourceIds)
      || !stringList(raw.gaps, 20, 1000)
      || !Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 15) {
      throw new AppError(502, "咨询准备结构不正确")
    }
    const questionIds = new Set<string>()
    for (const question of raw.questions) {
      if (!object(question)
        || !exactKeys(question, ["questionId", "text", "rationale", "expectedAnswer", "sourceIds"])
        || !id(question.questionId) || questionIds.has(question.questionId)
        || !text(question.text, 1000) || !question.text.trim()
        || !text(question.rationale, 1000) || !question.rationale.trim()
        || !text(question.expectedAnswer, 1000) || !question.expectedAnswer.trim()
        || !uniqueIds(question.sourceIds, sourceIds) || !question.sourceIds.length) {
        throw new AppError(502, "咨询问题、理由或引用不正确")
      }
      questionIds.add(question.questionId)
    }
    return
  }
  const targetId = input.target?.kind === "consultation" ? input.target.id : ""
  if (raw.mode !== "response"
    || !exactKeys(raw, ["mode", "consultationSourceId", "mappings", "gaps"])
    || !id(raw.consultationSourceId) || raw.consultationSourceId !== targetId
    || sources.get(raw.consultationSourceId)?.kind !== "consultation"
    || !Array.isArray(raw.mappings) || raw.mappings.length < 1 || raw.mappings.length > 30
    || !stringList(raw.gaps, 20, 1000)) {
    throw new AppError(502, "咨询回复整理结构不正确")
  }
  const responseIds = new Set(input.sources
    .filter(source => source.kind === "consultation_response")
    .map(source => source.id))
  const issueIds = new Set(input.sources
    .filter(source => source.kind === "issue")
    .map(source => source.id))
  const mappingIds = new Set<string>()
  for (const mapping of raw.mappings) {
    if (!object(mapping)
      || !exactKeys(mapping, [
        "mappingId", "question", "status", "responseSourceIds", "summary", "conditions",
        "conflicts", "followUps", "targetIssueSourceId"
      ])
      || !id(mapping.mappingId) || mappingIds.has(mapping.mappingId)
      || !text(mapping.question, 1000) || !mapping.question.trim()
      || !["answered", "partial", "unanswered", "conflicting"].includes(String(mapping.status))
      || !uniqueIds(mapping.responseSourceIds, responseIds)
      || (mapping.status !== "unanswered" && !mapping.responseSourceIds.length)
      || !text(mapping.summary, 2000)
      || (mapping.status !== "unanswered" && !mapping.summary.trim())
      || !stringList(mapping.conditions, 10, 1000)
      || !stringList(mapping.conflicts, 10, 1000)
      || !stringList(mapping.followUps, 10, 1000)
      || (mapping.status === "unanswered" && !mapping.followUps.length)
      || !text(mapping.targetIssueSourceId, 100)
      || (mapping.targetIssueSourceId !== "" && !issueIds.has(mapping.targetIssueSourceId))) {
      throw new AppError(502, "咨询回复映射、来源或待补问题不正确")
    }
    mappingIds.add(mapping.mappingId)
  }
}

const quantityText = (value: unknown) => typeof value === "string"
  && /^\d+(\.\d{1,3})?$/.test(value) && Number(value) > 0
  && Number.isSafeInteger(Math.round(Number(value) * 1_000))
const wastePercentText = (value: unknown) => typeof value === "string"
  && /^\d+(\.\d)?$/.test(value) && Number(value) >= 0 && Number(value) <= 100
const priceText = (value: unknown) => typeof value === "string"
  && /^\d+(\.\d{1,4})?$/.test(value) && Number(value) >= 0
  && Number.isSafeInteger(Math.round(Number(value) * 10_000))

function validateBudgetParameter(
  raw: unknown,
  sourceIds: Set<string>,
  valueKind: "quantity" | "waste" | "price"
): void {
  if (!object(raw)
    || !exactKeys(raw, ["value", "status", "sourceIds", "note"])
    || !text(raw.value, 50)
    || !["observed", "assumption", "unknown", "conflict"].includes(String(raw.status))
    || !uniqueIds(raw.sourceIds, sourceIds)
    || !text(raw.note, 1000)) {
    throw new AppError(502, "预算参数候选结构不正确")
  }
  const known = raw.status === "observed" || raw.status === "assumption"
  const validValue = valueKind === "quantity"
    ? quantityText(raw.value)
    : valueKind === "waste" ? wastePercentText(raw.value) : priceText(raw.value)
  if ((known && !validValue)
    || (!known && raw.value !== "")
    || (raw.status === "observed" && !(raw.sourceIds as string[]).length)
    || (raw.status !== "observed" && !raw.note.trim())) {
    throw new AppError(502, "预算参数数值、来源或未知说明不正确")
  }
}

function validateBudget(raw: unknown, input: AiInput): void {
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const sourceIds = new Set(sources.keys())
  if (!object(raw)
    || !exactKeys(raw, ["goal", "scenarios", "ledgerNotes", "gaps"])
    || !text(raw.goal, 1000) || !raw.goal.trim()
    || !Array.isArray(raw.scenarios) || raw.scenarios.length > 10
    || !validFindings(raw.ledgerNotes, sourceIds)
    || !stringList(raw.gaps, 20, 1000)
    || (!raw.scenarios.length && !raw.gaps.length)) {
    throw new AppError(502, "预算参数提取结构不正确")
  }
  const scenarioIds = new Set<string>()
  for (const scenario of raw.scenarios) {
    if (!object(scenario)
      || !exactKeys(scenario, [
        "scenarioId", "label", "materialSourceId", "unit", "requiredQuantity",
        "wasteRatePercent", "requirementIncludesWaste", "packageSize",
        "packageUnitPriceYuan", "assumptions", "conflicts", "missingFields"
      ])
      || !id(scenario.scenarioId) || scenarioIds.has(scenario.scenarioId)
      || !text(scenario.label, 120) || !scenario.label.trim()
      || !text(scenario.materialSourceId, 100)
      || (scenario.materialSourceId !== ""
        && sources.get(scenario.materialSourceId)?.kind !== "material")
      || !text(scenario.unit, 30)
      || !stringList(scenario.assumptions, 20, 1000)
      || !stringList(scenario.conflicts, 20, 1000)
      || !stringList(scenario.missingFields, 20, 200)) {
      throw new AppError(502, "预算方案标识、材料关联或说明不正确")
    }
    validateBudgetParameter(scenario.requiredQuantity, sourceIds, "quantity")
    validateBudgetParameter(scenario.wasteRatePercent, sourceIds, "waste")
    validateBudgetParameter(scenario.packageSize, sourceIds, "quantity")
    validateBudgetParameter(scenario.packageUnitPriceYuan, sourceIds, "price")
    const includesWaste = scenario.requirementIncludesWaste
    if (!object(includesWaste)
      || !exactKeys(includesWaste, ["value", "sourceIds", "note"])
      || !["yes", "no", "unknown", "conflict"].includes(String(includesWaste.value))
      || !uniqueIds(includesWaste.sourceIds, sourceIds)
      || !text(includesWaste.note, 1000)
      || (["yes", "no"].includes(String(includesWaste.value))
        && !(includesWaste.sourceIds as string[]).length && !includesWaste.note.trim())
      || (["unknown", "conflict"].includes(String(includesWaste.value))
        && !includesWaste.note.trim())) {
      throw new AppError(502, "预算损耗口径的候选值、来源或说明不正确")
    }
    scenarioIds.add(scenario.scenarioId)
  }
}

function validateProjectSummary(raw: unknown, input: AiInput): void {
  const sourceIds = new Set(input.sources.map(source => source.id))
  if (!object(raw)
    || !exactKeys(raw, ["title", "scopeStatement", "sections", "handoff", "overallGaps"])
    || !text(raw.title, 120) || !raw.title.trim()
    || !text(raw.scopeStatement, 1200) || !raw.scopeStatement.trim()
    || !Array.isArray(raw.sections)
    || raw.sections.length !== PROJECT_SUMMARY_SECTION_KEYS.length
    || !Array.isArray(raw.handoff) || raw.handoff.length > 20
    || !stringList(raw.overallGaps, 20, 1000)) {
    throw new AppError(502, "项目总结结构不正确")
  }
  const sectionKeys = new Set<string>()
  const itemIds = new Set<string>()
  for (const section of raw.sections) {
    if (!object(section)
      || !exactKeys(section, ["key", "title", "items", "gaps"])
      || !PROJECT_SUMMARY_SECTION_KEYS.includes(
        section.key as typeof PROJECT_SUMMARY_SECTION_KEYS[number])
      || sectionKeys.has(String(section.key))
      || !text(section.title, 120) || !section.title.trim()
      || !Array.isArray(section.items) || section.items.length > 20
      || !stringList(section.gaps, 20, 1000)) {
      throw new AppError(502, "项目总结分区不正确")
    }
    for (const item of section.items) {
      if (!object(item)
        || !exactKeys(item, ["itemId", "text", "status", "sourceIds"])
        || !id(item.itemId) || itemIds.has(item.itemId)
        || !text(item.text, 2000) || !item.text.trim()
        || ![
          "completed", "in_progress", "pending_confirmation", "blocked", "information_gap"
        ].includes(String(item.status))
        || !uniqueIds(item.sourceIds, sourceIds) || !(item.sourceIds as string[]).length) {
        throw new AppError(502, "项目总结条目、状态或来源不正确")
      }
      itemIds.add(item.itemId)
    }
    sectionKeys.add(String(section.key))
  }
  if (PROJECT_SUMMARY_SECTION_KEYS.some(key => !sectionKeys.has(key))) {
    throw new AppError(502, "项目总结分区不完整")
  }
  for (const item of raw.handoff) {
    if (!object(item)
      || !exactKeys(item, ["itemId", "text", "status", "sourceIds"])
      || !id(item.itemId) || itemIds.has(item.itemId)
      || !text(item.text, 2000) || !item.text.trim()
      || !["ready", "pending", "missing"].includes(String(item.status))
      || !uniqueIds(item.sourceIds, sourceIds)
      || (item.status !== "missing" && !(item.sourceIds as string[]).length)) {
      throw new AppError(502, "项目交接项、状态或来源不正确")
    }
    itemIds.add(item.itemId)
  }
}

export function validateResult(
  raw: unknown,
  input: AiInput,
  knowledge: Array<{ id: string }> = []
): AiResult {
  const allowed = new Set([...input.sources.map(source => source.id), ...knowledge.map(item => item.id)])
  const topLevel = ["summary", "observations", "differences", "unknowns", "suggestions"]
  if (input.task === "material_check") topLevel.push("materialCheck")
  if (input.task === "record_review") topLevel.push("recordReview")
  if (input.task === "image_observation") topLevel.push("imageObservation")
  if (input.task === "rectification") topLevel.push("rectification")
  if (input.task === "consultation") topLevel.push("consultation")
  if (input.task === "budget") topLevel.push("budget")
  if (input.task === "project_summary") topLevel.push("projectSummary")
  if (!object(raw) || !text(raw.summary, 4000)
    || !exactKeys(raw, topLevel)
    || !Array.isArray(raw.unknowns) || raw.unknowns.length > 20 || !raw.unknowns.every(item => text(item, 2000))) {
    throw new AppError(502, "模型输出格式错误，未保存为有效分析")
  }
  for (const field of ["observations","differences","suggestions"]) {
    const rows = raw[field]
    if (!Array.isArray(rows) || rows.length > 20 || !rows.every(row =>
      object(row) && text(row.text, 2000) && Array.isArray(row.sourceIds) && row.sourceIds.length > 0
      && row.sourceIds.length <= 30 && row.sourceIds.every(ref => typeof ref === "string" && allowed.has(ref))
      && Object.keys(row).every(key => key === "text" || key === "sourceIds")
    )) throw new AppError(502, "模型引用不存在或结果结构错误，需重新分析")
  }
  if (input.task === "material_check") validateMaterialCheck(raw.materialCheck, input)
  if (input.task === "record_review") validateRecordReview(raw.recordReview, input)
  if (input.task === "image_observation") {
    validateImageObservation(raw.imageObservation, input, knowledge)
  }
  if (input.task === "rectification") validateRectification(raw.rectification, input, knowledge)
  if (input.task === "consultation") validateConsultation(raw.consultation, input)
  if (input.task === "budget") validateBudget(raw.budget, input)
  if (input.task === "project_summary") validateProjectSummary(raw.projectSummary, input)
  return raw as unknown as AiResult
}

export function validateMaterialReview(raw: unknown, result: AiResult): MaterialCheckReview {
  const original = result.materialCheck
  if (!original || !object(raw) || !exactKeys(raw, ["fields"])
    || !Array.isArray(raw.fields) || raw.fields.length !== original.fields.length) {
    throw new AppError(400, "材料核对的人工复核结构不正确")
  }
  const originalKeys = new Set(original.fields.map(field => field.key))
  const seen = new Set<string>()
  const statuses = new Set<MaterialCheckFieldStatus>([
    "matches", "differs", "observed_only", "expected_only", "unknown"
  ])
  for (const field of raw.fields) {
    if (!object(field)
      || !exactKeys(field, ["key", "observedValue", "expectedValue", "status", "note"])
      || !originalKeys.has(field.key as typeof MATERIAL_CHECK_FIELD_KEYS[number])
      || seen.has(String(field.key))
      || !text(field.observedValue, 500) || !text(field.expectedValue, 500)
      || !statuses.has(field.status as MaterialCheckFieldStatus)
      || !text(field.note, 1000)) {
      throw new AppError(400, "材料核对的人工复核字段不正确")
    }
    seen.add(String(field.key))
    const observed = field.observedValue.trim()
    const expected = field.expectedValue.trim()
    const status = field.status as MaterialCheckFieldStatus
    if ((status === "matches" || status === "differs") && (!observed || !expected)) {
      throw new AppError(400, "人工判断一致或差异时必须填写观察值和期望值")
    }
    if (status === "observed_only" && (!observed || expected)) {
      throw new AppError(400, "人工仅观察状态的值不完整")
    }
    if (status === "expected_only" && (observed || !expected)) {
      throw new AppError(400, "人工仅期望状态的值不完整")
    }
    if (status === "unknown" && !field.note.trim()) {
      throw new AppError(400, "人工未知状态需填写无法识别或无法比较的原因")
    }
  }
  if (seen.size !== originalKeys.size) throw new AppError(400, "人工复核字段与原结果不一致")
  return raw as unknown as MaterialCheckReview
}

export function validateRecordReviewReview(
  raw: unknown,
  result: AiResult
): RecordReviewReview {
  const original = result.recordReview
  if (!original || !object(raw)
    || !exactKeys(raw, ["title", "room", "stage", "occurredAt", "note", "facts", "opinions"])
    || !text(raw.title, 120) || !raw.title.trim()
    || !text(raw.room, 50) || !raw.room.trim()
    || !text(raw.stage, 50) || !raw.stage.trim()
    || !text(raw.occurredAt, 40) || Number.isNaN(Date.parse(raw.occurredAt))
    || !text(raw.note, 4000)
    || !Array.isArray(raw.facts) || raw.facts.length !== original.facts.length
    || !Array.isArray(raw.opinions) || raw.opinions.length !== original.opinions.length) {
    throw new AppError(400, "记录整理的人工复核结构不正确")
  }
  const validateLines = (value: unknown[], expectedLength: number) => {
    const indexes = new Set<number>()
    for (const line of value) {
      if (!object(line)
        || !exactKeys(line, ["sourceIndex", "included", "text"])
        || !Number.isInteger(line.sourceIndex)
        || Number(line.sourceIndex) < 0 || Number(line.sourceIndex) >= expectedLength
        || indexes.has(Number(line.sourceIndex))
        || typeof line.included !== "boolean"
        || !text(line.text, 1000)
        || (line.included && !line.text.trim())) {
        throw new AppError(400, "记录整理的人工复核条目不正确")
      }
      indexes.add(Number(line.sourceIndex))
    }
    if (indexes.size !== expectedLength) throw new AppError(400, "记录整理的人工复核条目不完整")
  }
  validateLines(raw.facts, original.facts.length)
  validateLines(raw.opinions, original.opinions.length)
  const included = [...raw.facts, ...raw.opinions]
    .some(line => object(line) && line.included === true)
  if (!included && !raw.note.trim()) throw new AppError(400, "记录整理至少保留一条内容或人工说明")
  return raw as unknown as RecordReviewReview
}

export function validateImageObservationReview(
  raw: unknown,
  result: AiResult
): ImageObservationReview {
  const original = result.imageObservation
  if (!original || !object(raw) || !exactKeys(raw, ["items"])
    || !Array.isArray(raw.items) || raw.items.length !== original.items.length) {
    throw new AppError(400, "图片观察的人工复核结构不正确")
  }
  const originalIds = new Set(original.items.map(item => item.itemId))
  const seen = new Set<string>()
  for (const item of raw.items) {
    if (!object(item)
      || !exactKeys(item, [
        "itemId", "disposition", "observation", "suspectedExplanation", "limitations",
        "captureSuggestions", "priority", "priorityReason", "issueTitle"
      ])
      || !id(item.itemId) || !originalIds.has(item.itemId) || seen.has(item.itemId)
      || !["saved", "ignored", "issue"].includes(String(item.disposition))
      || !text(item.observation, 1000) || !item.observation.trim()
      || !text(item.suspectedExplanation, 1000)
      || !stringList(item.limitations, 10, 500)
      || !stringList(item.captureSuggestions, 10, 500)
      || !["high", "medium", "low"].includes(String(item.priority))
      || !text(item.priorityReason, 500) || !item.priorityReason.trim()
      || !text(item.issueTitle, 120)
      || (item.disposition === "issue" && !item.issueTitle.trim())) {
      throw new AppError(400, "图片观察的人工复核条目不正确")
    }
    seen.add(item.itemId)
  }
  if (seen.size !== originalIds.size) throw new AppError(400, "图片观察的人工复核条目不完整")
  return raw as unknown as ImageObservationReview
}

export function validateRectificationReview(
  raw: unknown,
  result: AiResult
): RectificationHumanReview {
  const original = result.rectification
  if (!original || !object(raw) || raw.mode !== original.mode || !text(raw.note, 4000)) {
    throw new AppError(400, "整改辅助的人工复核结构不正确")
  }
  if (original.mode === "proposal") {
    if (!exactKeys(raw, ["mode", "items", "note"])
      || !Array.isArray(raw.items) || raw.items.length !== original.proposals.length) {
      throw new AppError(400, "整改预案的人工复核条目不完整")
    }
    const originalIds = new Set(original.proposals.map(item => item.optionId))
    const seen = new Set<string>()
    for (const item of raw.items) {
      if (!object(item)
        || !exactKeys(item, ["optionId", "included", "title", "content"])
        || !id(item.optionId) || !originalIds.has(item.optionId) || seen.has(item.optionId)
        || typeof item.included !== "boolean"
        || !text(item.title, 120) || !text(item.content, 4000)
        || (item.included && (!item.title.trim() || !item.content.trim()))) {
        throw new AppError(400, "整改预案的人工复核内容不正确")
      }
      seen.add(item.optionId)
    }
    if (!raw.items.some(item => object(item) && item.included === true) && !raw.note.trim()) {
      throw new AppError(400, "请至少保留一个预案或填写仅留档说明")
    }
    return raw as unknown as RectificationHumanReview
  }
  if (!exactKeys(raw, ["mode", "items", "note"])
    || !Array.isArray(raw.items) || raw.items.length !== original.checks.length) {
    throw new AppError(400, "整改复查参考的人工复核条目不完整")
  }
  const originalIds = new Set(original.checks.map(item => item.checkId))
  const seen = new Set<string>()
  for (const item of raw.items) {
    if (!object(item)
      || !exactKeys(item, [
        "checkId", "included", "requirement", "status", "observation", "limitations", "nextSteps"
      ])
      || !id(item.checkId) || !originalIds.has(item.checkId) || seen.has(item.checkId)
      || typeof item.included !== "boolean"
      || !text(item.requirement, 1000) || !text(item.observation, 1000)
      || !["visible_improved", "concern_remains", "not_verifiable"].includes(String(item.status))
      || !stringList(item.limitations, 10, 1000)
      || !stringList(item.nextSteps, 10, 1000)
      || (item.included && (!item.requirement.trim() || !item.observation.trim()))
      || (item.included && item.status === "not_verifiable" && !item.limitations.length)) {
      throw new AppError(400, "整改复查参考的人工复核内容不正确")
    }
    seen.add(item.checkId)
  }
  if (!raw.items.some(item => object(item) && item.included === true) && !raw.note.trim()) {
    throw new AppError(400, "请至少保留一条复查参考或填写仅留档说明")
  }
  return raw as unknown as RectificationHumanReview
}

export function validateConsultationReview(
  raw: unknown,
  result: AiResult,
  allowedIssueIds: Set<string> = new Set()
): ConsultationHumanReview {
  const original = result.consultation
  if (!original || !object(raw) || raw.mode !== original.mode || !text(raw.note, 4000)) {
    throw new AppError(400, "咨询整理的人工复核结构不正确")
  }
  if (original.mode === "prepare") {
    if (!exactKeys(raw, [
      "mode", "title", "purpose", "facts", "timeline", "disputes", "gaps", "questions", "note"
    ])
      || !text(raw.title, 120) || !raw.title.trim()
      || !text(raw.purpose, 1000) || !raw.purpose.trim()
      || !stringList(raw.gaps, 20, 1000)) {
      throw new AppError(400, "咨询草稿的人工复核字段不正确")
    }
    const validateLines = (value: unknown, expectedLength: number) => {
      if (!Array.isArray(value) || value.length !== expectedLength) {
        throw new AppError(400, "咨询草稿的人工复核条目不完整")
      }
      const indexes = new Set<number>()
      for (const line of value) {
        if (!object(line)
          || !exactKeys(line, ["sourceIndex", "included", "text"])
          || !Number.isInteger(line.sourceIndex) || Number(line.sourceIndex) < 0
          || Number(line.sourceIndex) >= expectedLength || indexes.has(Number(line.sourceIndex))
          || typeof line.included !== "boolean" || !text(line.text, 2000)
          || (line.included && !line.text.trim())) {
          throw new AppError(400, "咨询草稿的人工复核条目不正确")
        }
        indexes.add(Number(line.sourceIndex))
      }
    }
    validateLines(raw.facts, original.facts.length)
    validateLines(raw.timeline, original.timeline.length)
    validateLines(raw.disputes, original.disputes.length)
    validateLines(raw.questions, original.questions.length)
    if (!(raw.questions as unknown[]).some(item => object(item) && item.included === true)) {
      throw new AppError(400, "咨询草稿至少需要保留一个希望回答的问题")
    }
    return raw as unknown as ConsultationHumanReview
  }
  if (!exactKeys(raw, ["mode", "mappings", "note"])
    || !Array.isArray(raw.mappings) || raw.mappings.length !== original.mappings.length) {
    throw new AppError(400, "咨询回复的人工复核条目不完整")
  }
  const originalIds = new Set(original.mappings.map(item => item.mappingId))
  const seen = new Set<string>()
  for (const mapping of raw.mappings) {
    if (!object(mapping)
      || !exactKeys(mapping, [
        "mappingId", "disposition", "status", "summary", "conditions", "conflicts",
        "followUps", "targetIssueSourceId", "proposalContent"
      ])
      || !id(mapping.mappingId) || !originalIds.has(mapping.mappingId) || seen.has(mapping.mappingId)
      || !["saved", "ignored", "proposal"].includes(String(mapping.disposition))
      || !["answered", "partial", "unanswered", "conflicting"].includes(String(mapping.status))
      || !text(mapping.summary, 2000)
      || !stringList(mapping.conditions, 10, 1000)
      || !stringList(mapping.conflicts, 10, 1000)
      || !stringList(mapping.followUps, 10, 1000)
      || !text(mapping.targetIssueSourceId, 100)
      || (mapping.targetIssueSourceId !== "" && !allowedIssueIds.has(mapping.targetIssueSourceId))
      || !text(mapping.proposalContent, 4000)
      || (mapping.disposition === "proposal"
        && (!mapping.targetIssueSourceId || !mapping.proposalContent.trim()))) {
      throw new AppError(400, "咨询回复的人工复核内容、目标问题或预案不正确")
    }
    seen.add(mapping.mappingId)
  }
  if (!raw.mappings.some(item => object(item) && item.disposition !== "ignored") && !raw.note.trim()) {
    throw new AppError(400, "请至少保留一条回复整理或填写仅留档说明")
  }
  return raw as unknown as ConsultationHumanReview
}

export function validateBudgetReview(raw: unknown, result: AiResult): BudgetHumanReview {
  const original = result.budget
  if (!original || !object(raw)
    || !exactKeys(raw, ["scenarios", "note"])
    || !Array.isArray(raw.scenarios) || raw.scenarios.length !== original.scenarios.length
    || !text(raw.note, 4000)) {
    throw new AppError(400, "预算参数的人工复核结构不正确")
  }
  const originalById = new Map(original.scenarios.map(item => [item.scenarioId, item]))
  const seen = new Set<string>()
  let included = 0
  for (const scenario of raw.scenarios) {
    if (!object(scenario)
      || !exactKeys(scenario, [
        "scenarioId", "included", "label", "materialSourceId", "unit",
        "requiredQuantity", "wasteRatePercent", "requirementIncludesWaste",
        "packageSize", "packageUnitPriceYuan", "note"
      ])
      || !id(scenario.scenarioId) || !originalById.has(scenario.scenarioId)
      || seen.has(scenario.scenarioId)
      || typeof scenario.included !== "boolean"
      || !text(scenario.label, 120)
      || !text(scenario.materialSourceId, 100)
      || scenario.materialSourceId !== originalById.get(scenario.scenarioId)!.materialSourceId
      || !text(scenario.unit, 30)
      || !text(scenario.requiredQuantity, 50)
      || !text(scenario.wasteRatePercent, 50)
      || !["yes", "no"].includes(String(scenario.requirementIncludesWaste))
      || !text(scenario.packageSize, 50)
      || !text(scenario.packageUnitPriceYuan, 50)
      || !text(scenario.note, 2000)) {
      throw new AppError(400, "预算参数的人工复核方案不正确")
    }
    if (scenario.included) {
      included += 1
      if (!scenario.label.trim() || !scenario.unit.trim()
        || !quantityText(scenario.requiredQuantity)
        || !wastePercentText(scenario.wasteRatePercent)
        || !quantityText(scenario.packageSize)
        || (scenario.packageUnitPriceYuan !== "" && !priceText(scenario.packageUnitPriceYuan))) {
        throw new AppError(400, "请补齐所选预算方案的数量、单位、损耗和包装参数")
      }
    }
    seen.add(scenario.scenarioId)
  }
  if (!included) throw new AppError(400, "请至少选择一个完整方案再保存估算")
  return raw as unknown as BudgetHumanReview
}

export function validateProjectSummaryReview(
  raw: unknown,
  result: AiResult
): ProjectSummaryHumanReview {
  const original = result.projectSummary
  if (!original || !object(raw)
    || !exactKeys(raw, ["title", "scopeStatement", "sections", "handoff", "note"])
    || !text(raw.title, 120) || !raw.title.trim()
    || !text(raw.scopeStatement, 1200) || !raw.scopeStatement.trim()
    || !Array.isArray(raw.sections) || raw.sections.length !== original.sections.length
    || !Array.isArray(raw.handoff) || raw.handoff.length !== original.handoff.length
    || !text(raw.note, 4000)) {
    throw new AppError(400, "项目总结的人工复核结构不正确")
  }
  const sectionKeys = new Set(original.sections.map(section => section.key))
  const reviewedKeys = new Set<string>()
  let includedSections = 0
  for (const section of raw.sections) {
    if (!object(section)
      || !exactKeys(section, ["key", "included", "title", "content"])
      || !sectionKeys.has(section.key as typeof PROJECT_SUMMARY_SECTION_KEYS[number])
      || reviewedKeys.has(String(section.key))
      || typeof section.included !== "boolean"
      || !text(section.title, 120)
      || !text(section.content, 8000)
      || (section.included && (!section.title.trim() || !section.content.trim()))) {
      throw new AppError(400, "项目总结的人工复核分区不正确")
    }
    if (section.included) includedSections += 1
    reviewedKeys.add(String(section.key))
  }
  if (!includedSections) throw new AppError(400, "请至少保留一个项目总结分区")
  const originalHandoff = new Map(original.handoff.map(item => [item.itemId, item]))
  const reviewedHandoff = new Set<string>()
  for (const item of raw.handoff) {
    if (!object(item)
      || !exactKeys(item, ["itemId", "included", "text", "status"])
      || !id(item.itemId) || !originalHandoff.has(item.itemId)
      || reviewedHandoff.has(item.itemId)
      || typeof item.included !== "boolean"
      || !text(item.text, 2000)
      || !["ready", "pending", "missing"].includes(String(item.status))
      || (item.included && !item.text.trim())) {
      throw new AppError(400, "项目总结的人工交接项不正确")
    }
    reviewedHandoff.add(item.itemId)
  }
  return raw as unknown as ProjectSummaryHumanReview
}
