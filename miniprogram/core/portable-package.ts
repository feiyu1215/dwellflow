import type { AppState, Attachment } from "./domain"

export const PORTABLE_PACKAGE_SCHEMA = "renovation-sync-portable-v1" as const
export const PORTABLE_MAX_FILES = 128
export const PORTABLE_MAX_SOURCE_BYTES = 20 * 1024 * 1024
const PORTABLE_MAX_DATA_CHARACTERS = 8 * 1024 * 1024
const PORTABLE_MAX_BUSINESS_OBJECTS = 10_000
const PORTABLE_MAX_NESTING_DEPTH = 64

export type PortablePurpose = "full_backup" | "limited_read"
export type PortableReadError = "missing" | "changed" | "read_failed" | "too_large"

export interface PortableSourceFile {
  sourcePath: string
  packagePath: string
  displayName: string
  attachmentType: Attachment["type"]
  references: string[]
}

export interface PortableExportPlan {
  packageId: string
  purpose: PortablePurpose
  projectId: string
  projectName: string
  createdAt: string
  data: Record<string, unknown>
  sources: PortableSourceFile[]
  reports: Record<string, string>
}

export interface PortableReadResult {
  sourcePath: string
  byteLength?: number
  sha256?: string
  contentBase64?: string
  error?: PortableReadError
}

export interface PortablePackageFile {
  packagePath: string
  displayName: string
  attachmentType: Attachment["type"]
  byteLength: number
  sha256: string
  contentBase64: string
  references: string[]
}

export interface PortableMissingFile {
  packagePath: string
  displayName: string
  reason: PortableReadError
  references: string[]
}

export interface PortablePackage {
  schema: typeof PORTABLE_PACKAGE_SCHEMA
  manifest: {
    packageId: string
    purpose: PortablePurpose
    projectName: string
    createdAt: string
    status: "complete" | "partial"
    restorable: boolean
    fileCount: number
    totalBytes: number
    checksumNotice: string
  }
  data: Record<string, unknown>
  reports: Record<string, string>
  files: PortablePackageFile[]
  missingFiles: PortableMissingFile[]
}

export interface PortableContentPreviewItem {
  key: string
  title: string
  detail: string
  meta: string
}

export interface PortableContentPreviewSection {
  key: string
  title: string
  totalCount: number
  shownCount: number
  omittedCount: number
  items: PortableContentPreviewItem[]
}

interface AttachmentCandidate extends Attachment {
  localPath: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAttachment(value: Record<string, unknown>): value is Record<string, unknown> & AttachmentCandidate {
  return typeof value.id === "string"
    && typeof value.name === "string"
    && (value.type === "image" || value.type === "audio" || value.type === "file")
    && typeof value.localPath === "string"
}

function isEvidenceAssetObject(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.projectId === "string"
    && typeof value.fileName === "string"
    && ["image", "audio", "video", "document"].includes(String(value.category))
    && typeof value.status === "string"
}

function cloneWithPortableAttachments(value: unknown): {
  data: Record<string, unknown>
  sources: PortableSourceFile[]
} {
  const sourcesByPath = new Map<string, PortableSourceFile>()
  const sourceList: PortableSourceFile[] = []

  const registerSource = (input: {
    sourceKey: string
    sourcePath: string
    referencePath: string
    displayName: string
    attachmentType: Attachment["type"]
  }): string => {
    let source = sourcesByPath.get(input.sourceKey)
    if (!source) {
      source = {
        sourcePath: input.sourcePath,
        packagePath: `attachments/file_${String(sourceList.length + 1).padStart(4, "0")}.bin`,
        displayName: input.displayName,
        attachmentType: input.attachmentType,
        references: []
      }
      sourcesByPath.set(input.sourceKey, source)
      sourceList.push(source)
    }
    source.references.push(input.referencePath)
    return `renosync://${source.packagePath}`
  }

  const portableEvidenceRef = (
    value: unknown,
    referencePath: string,
    displayName: string,
    attachmentType: Attachment["type"]
  ): unknown => {
    if (!isObject(value)) return value
    if (value.kind === "local_file" && typeof value.localPath === "string") {
      return {
        kind: "local_file",
        localPath: registerSource({
          sourceKey: value.localPath || `missing:${referencePath}`,
          sourcePath: value.localPath,
          referencePath,
          displayName,
          attachmentType
        })
      }
    }
    if (value.kind === "server_attachment" && typeof value.attachmentId === "string") {
      return {
        kind: "local_file",
        localPath: registerSource({
          sourceKey: `server:${value.attachmentId}`,
          sourcePath: "",
          referencePath,
          displayName,
          attachmentType
        })
      }
    }
    return value
  }

  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (depth > PORTABLE_MAX_NESTING_DEPTH) throw new Error("导出数据嵌套层级过深")
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`, depth + 1))
    if (!isObject(current)) return current
    if (isEvidenceAssetObject(current)) {
      const attachmentType: Attachment["type"] = current.category === "image" ? "image"
        : current.category === "audio" ? "audio" : "file"
      const transformed = {
        ...current,
        storageRef: portableEvidenceRef(current.storageRef, `${path}.storageRef`, String(current.fileName), attachmentType),
        thumbnailRef: portableEvidenceRef(current.thumbnailRef, `${path}.thumbnailRef`, `${String(current.fileName)} · 缩略图`, "image")
      }
      return Object.fromEntries(Object.entries(transformed).map(([key, item]) => [
        key,
        key === "storageRef" || key === "thumbnailRef" ? item : visit(item, `${path}.${key}`, depth + 1)
      ]))
    }
    if (isAttachment(current)) {
      return {
        ...current,
        localPath: registerSource({
          sourceKey: current.localPath || `missing:${current.id}:${path}`,
          sourcePath: current.localPath,
          referencePath: path,
          displayName: current.name || `附件${sourceList.length + 1}`,
          attachmentType: current.type
        })
      }
    }
    return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item, `${path}.${key}`, depth + 1)]))
  }

  const data = visit(value, "$", 0)
  if (!isObject(data)) throw new Error("导出数据格式不正确")
  return { data, sources: sourceList }
}

function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value)
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function csv(rows: unknown[][]): string {
  return `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}`
}

function arrayFrom(data: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = data[key]
  return Array.isArray(value) ? value.filter(isObject) : []
}

function displayText(value: unknown, fallback = "未填写"): string {
  if (typeof value === "string") return value.trim() || fallback
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return fallback
}

function amountLabel(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? `报价 ¥${(value / 100).toFixed(2)}`
    : "未填写报价"
}

function previewSection(
  key: string,
  title: string,
  source: Array<Record<string, unknown>>,
  mapItem: (item: Record<string, unknown>, index: number) => PortableContentPreviewItem,
  limit: number
): PortableContentPreviewSection | undefined {
  if (!source.length) return undefined
  const items = source.slice(0, limit).map(mapItem)
  return {
    key,
    title,
    totalCount: source.length,
    shownCount: items.length,
    omittedCount: Math.max(source.length - items.length, 0),
    items
  }
}

/** Build a readable, bounded preview from the exact fixed data that will be exported. */
export function portablePlanContentPreview(
  plan: PortableExportPlan,
  perSectionLimit = 30
): PortableContentPreviewSection[] {
  if (!Number.isInteger(perSectionLimit) || perSectionLimit < 1 || perSectionLimit > 100) {
    throw new Error("预览条数上限必须在 1 到 100 之间")
  }
  const data = plan.data
  const sections = [
    previewSection("spaces", "空间与进度", arrayFrom(data, "spaces"), (item, index) => {
      const states = arrayFrom(data, "spaceStageStates").filter(state => state.spaceId === item.id)
      const current = states.find(state => state.status === "in_progress")
        || states.find(state => state.status === "pending_review")
      return {
        key: displayText(item.id, `space-${index}`),
        title: displayText(item.name, "未命名空间"),
        detail: current ? `${displayText(current.stageId)} · ${displayText(current.status)}` : "尚无进行中的阶段",
        meta: `${displayText(item.kind)} · ${item.participatesInTopology === false ? "不参与拓扑" : "参与拓扑"} · ${states.length} 个阶段状态`
      }
    }, perSectionLimit),
    previewSection("evidenceAssets", "证据原件", arrayFrom(data, "evidenceAssets"), (item, index) => {
      const links = arrayFrom(data, "evidenceLinks").filter(link => link.evidenceId === item.id && link.status !== "removed")
      return {
        key: displayText(item.id, `evidence-${index}`),
        title: displayText(item.fileName, "未命名原件"),
        detail: `${displayText(item.origin)} · ${displayText(item.category)} · ${displayText(item.status)}`,
        meta: `${displayText(item.occurredAt || item.capturedAt || item.receivedAt, "时间未知")} · ${links.length} 个业务关联`
      }
    }, perSectionLimit),
    previewSection("records", "现场记录", arrayFrom(data, "records"), (item, index) => ({
      key: displayText(item.id, `record-${index}`),
      title: displayText(item.title, "未命名记录"),
      detail: displayText(item.note, "无补充说明"),
      meta: `${displayText(item.room)} · ${displayText(item.stage)} · 版本 ${displayText(item.version, "1")} · ${Array.isArray(item.attachments) ? item.attachments.length : 0} 个附件`
    }), perSectionLimit),
    previewSection("issues", "问题事项", arrayFrom(data, "issues"), (item, index) => ({
      key: displayText(item.id, `issue-${index}`),
      title: displayText(item.title, "未命名问题"),
      detail: displayText(item.description, "无问题说明"),
      meta: `${displayText(item.room)} · ${displayText(item.stage)} · ${displayText(item.status)} · ${Array.isArray(item.proposals) ? item.proposals.length : 0} 个预案`
    }), perSectionLimit),
    previewSection("materials", "材料", arrayFrom(data, "materials"), (item, index) => ({
      key: displayText(item.id, `material-${index}`),
      title: displayText(item.name, "未命名材料"),
      detail: displayText(item.specification, "未填写规格"),
      meta: `计划 ${displayText(item.plannedQuantity, "0")} ${displayText(item.unit, "单位未填")}`
    }), perSectionLimit),
    previewSection("materialChecks", "材料核对记录", arrayFrom(data, "materialChecks"), (item, index) => {
      const review = isObject(item.review) ? item.review : {}
      return {
        key: displayText(item.id, `material-check-${index}`),
        title: `到货核对 · ${displayText(item.materialId, "材料未知")}`,
        detail: displayText(item.summary, "无核对摘要"),
        meta: `${displayText(item.model, "模型未知")} · ${objectList(review.fields).length} 个字段 · ${displayText(item.confirmedAt, "时间未知")}`
      }
    }, perSectionLimit),
    previewSection("agreements", "约定", arrayFrom(data, "agreements"), (item, index) => {
      const agreement = isObject(item.agreement) ? item.agreement : item
      const versions = Array.isArray(item.versions) ? item.versions.filter(isObject) : []
      const active = versions.find(version => version.id === agreement.activeVersionId)
        || versions.find(version => version.status === "pending_confirmation")
        || versions[versions.length - 1]
      const terms = active && Array.isArray(active.terms) ? active.terms.filter(isObject) : []
      return {
        key: displayText(agreement.id, `agreement-${index}`),
        title: displayText(agreement.title, "未命名约定"),
        detail: terms.slice(0, 3).map(term => `${displayText(term.label)}：${displayText(term.value)}`).join("；") || "暂无约定条目",
        meta: `${displayText(active?.status, "暂无版本")} · ${versions.length} 个版本${terms.length > 3 ? ` · 另有 ${terms.length - 3} 个条目` : ""}`
      }
    }, perSectionLimit),
    previewSection("costs", "费用", arrayFrom(data, "costItems"), (item, index) => ({
      key: displayText(item.id, `cost-${index}`),
      title: displayText(item.title, "未命名费用"),
      detail: displayText(item.note, "无补充说明"),
      meta: `${displayText(item.category)} · ${amountLabel(item.quotedAmountFen)}`
    }), perSectionLimit),
    previewSection("consultations", "对外咨询", arrayFrom(data, "consultations"), (item, index) => {
      const versions = Array.isArray(item.versions) ? item.versions.filter(isObject) : []
      const active = versions.find(version => version.id === item.activeVersionId)
        || versions.find(version => version.id === item.draftVersionId)
        || versions[versions.length - 1]
      return {
        key: displayText(item.id, `consultation-${index}`),
        title: displayText(item.title, "未命名咨询"),
        detail: displayText(active?.question, "未填写咨询问题"),
        meta: `${displayText(item.status)} · ${versions.length} 个版本`
      }
    }, perSectionLimit)
  ]
  return sections.filter((section): section is PortableContentPreviewSection => Boolean(section))
}

export function buildPortableReports(data: Record<string, unknown>): Record<string, string> {
  const records = arrayFrom(data, "records")
  const revisions = arrayFrom(data, "recordRevisions")
  const issues = arrayFrom(data, "issues")
  const issueWorkflows = arrayFrom(data, "issueWorkflows")
  const materials = arrayFrom(data, "materials")
  const purchases = arrayFrom(data, "purchaseLines")
  const receipts = arrayFrom(data, "receiptBatches")
  const inventory = arrayFrom(data, "materialInventoryEvents")
  const costs = arrayFrom(data, "costItems")
  const approvals = arrayFrom(data, "costApprovals")
  const payments = arrayFrom(data, "paymentFacts")
  const refunds = arrayFrom(data, "refundFacts")
  const agreements = arrayFrom(data, "agreements")
  const consultations = arrayFrom(data, "consultations")
  const consultationResponses = arrayFrom(data, "consultationResponses")
  const materialChecks = arrayFrom(data, "materialChecks")
  const budgetEstimates = arrayFrom(data, "budgetEstimateApplications")
  const projectSummaries = arrayFrom(data, "projectSummaryApplications")
  const spaces = arrayFrom(data, "spaces")
  const spaceRelations = arrayFrom(data, "spaceRelations")
  const spaceStageStates = arrayFrom(data, "spaceStageStates")
  const evidenceAssets = arrayFrom(data, "evidenceAssets")
  const evidenceLinks = arrayFrom(data, "evidenceLinks")
  const agreementRows = agreements.flatMap(aggregate => {
    if (!isObject(aggregate.agreement)) return []
    const agreement = aggregate.agreement
    const versions = Array.isArray(aggregate.versions) ? aggregate.versions.filter(isObject) : []
    if (!versions.length) return [[agreement.id, agreement.title, agreement.subject, "", "", ""]]
    return versions.map(version => [
      agreement.id,
      agreement.title,
      agreement.subject,
      version.revision,
      version.status,
      Array.isArray(version.terms) ? version.terms.filter(isObject)
        .map(term => `${displayText(term.label)}：${displayText(term.value)}`).join("；") : ""
    ])
  })
  const consultationRows = consultations.flatMap(consultation => {
    const versions = Array.isArray(consultation.versions) ? consultation.versions.filter(isObject) : []
    if (!versions.length) return [[consultation.id, consultation.title, consultation.status, "", "", "", "", ""]]
    return versions.map(version => [
      consultation.id,
      consultation.title,
      consultation.status,
      version.revision,
      version.status,
      version.question,
      Array.isArray(version.recordIds) ? version.recordIds.join("；") : "",
      Array.isArray(version.issueIds) ? version.issueIds.join("；") : ""
    ])
  })
  const materialCheckRows = materialChecks.flatMap(check => {
    const review = isObject(check.review) ? check.review : {}
    return objectList(review.fields).map(field => [
      check.id,
      check.materialId,
      check.receiptBatchId,
      check.model,
      check.promptVersion,
      field.key,
      field.observedValue,
      field.expectedValue,
      field.status,
      field.note,
      check.confirmedBy,
      check.confirmedAt
    ])
  })
  const budgetEstimateRows = budgetEstimates.flatMap(application =>
    objectList(application.scenarios).map(scenario => {
      const total = isObject(scenario.totalRequirement) ? scenario.totalRequirement : {}
      const gap = isObject(scenario.resourceGap) ? scenario.resourceGap : {}
      const purchase = isObject(scenario.recommendedPurchase) ? scenario.recommendedPurchase : {}
      return [
        application.id, scenario.scenarioId, scenario.label, scenario.materialId, scenario.unit,
        total.quantityWithWasteMilli, gap.minimumGapMilli, gap.maximumGapMilli,
        purchase.purchaseQuantityMilli, purchase.packageCount, purchase.amountFen,
        scenario.note, application.model, application.promptVersion, application.appliedBy,
        application.appliedAt
      ]
    }))
  const projectSummaryRows = projectSummaries.flatMap(application => {
    const scope = isObject(application.scope) ? application.scope : {}
    const review = isObject(application.review) ? application.review : {}
    const handoff = objectList(review.handoff)
      .filter(item => item.included !== false)
      .map(item => `[${displayText(item.status)}] ${displayText(item.text)}`).join("\n")
    return objectList(review.sections).map(section => [
      application.id,
      review.title,
      scope.purpose,
      scope.audience,
      scope.stage,
      scope.room,
      scope.dateFrom,
      scope.dateTo,
      scope.cutoffAt,
      section.included,
      section.title,
      section.content,
      handoff,
      review.note,
      application.model,
      application.promptVersion,
      application.appliedBy,
      application.appliedAt
    ])
  })
  return {
    "空间与阶段.csv": csv([
      ["类型", "ID", "空间ID", "名称/阶段", "状态", "关系/说明", "证据ID", "更新时间"],
      ...spaces.map(item => ["空间", item.id, item.id, item.name, item.status, item.kind, "", item.updatedAt]),
      ...spaceRelations.map(item => ["空间关系", item.id, `${displayText(item.fromSpaceId)} → ${displayText(item.toSpaceId)}`,
        item.directionHint, item.status, item.kind, "", item.updatedAt]),
      ...spaceStageStates.map(item => ["空间阶段", item.id, item.spaceId, item.stageId, item.status, item.note,
        Array.isArray(item.sourceEvidenceIds) ? item.sourceEvidenceIds.join("；") : "", item.updatedAt])
    ]),
    "证据原件与关联.csv": csv([
      ["类型", "ID", "证据ID", "文件名/目标", "来源/关系", "状态", "空间ID", "阶段", "时间/说明"],
      ...evidenceAssets.map(item => ["证据原件", item.id, item.id, item.fileName, item.origin, item.status,
        "", "", item.occurredAt || item.capturedAt || item.receivedAt || item.createdAt]),
      ...evidenceLinks.map(item => {
        const target = isObject(item.target) ? item.target : {}
        return ["证据关联", item.id, item.evidenceId, `${displayText(target.type)}:${displayText(target.id)}`,
          item.relationKind, item.status, item.spaceId, item.stageId, item.note]
      })
    ]),
    "记录.csv": csv([
      ["记录ID", "版本", "标题", "说明", "房间", "工序", "记录人", "发生时间", "附件数"],
      ...records.map(item => [item.id, item.version, item.title, item.note, item.room, item.stage,
        item.creatorName, item.occurredAt, Array.isArray(item.attachments) ? item.attachments.length : 0])
    ]),
    "问题.csv": csv([
      ["问题ID", "状态", "标题", "说明", "房间", "工序", "关联记录ID"],
      ...issues.map(item => [item.id, item.status, item.title, item.description, item.room, item.stage, item.recordId])
    ]),
    "记录历史.csv": csv([
      ["历史ID", "记录ID", "版本", "标题", "说明", "房间", "工序", "修改原因", "时间"],
      ...revisions.map(item => [item.id, item.recordId, item.version, item.title, item.note,
        item.room, item.stage, item.changeReason, item.createdAt])
    ]),
    "问题处理历史.csv": csv([
      ["问题ID", "标题", "状态", "版本", "预案数", "整改提交数", "复查数", "重开数"],
      ...issueWorkflows.map(item => [item.id, item.title, item.status, item.version,
        Array.isArray(item.proposals) ? item.proposals.length : 0,
        Array.isArray(item.treatments) ? item.treatments.length : 0,
        Array.isArray(item.reviews) ? item.reviews.length : 0,
        Array.isArray(item.reopenings) ? item.reopenings.length : 0])
    ]),
    "材料.csv": csv([
      ["材料ID", "名称", "规格", "单位", "计划数量"],
      ...materials.map(item => [item.id, item.name, item.specification, item.unit, item.plannedQuantity])
    ]),
    "库存流水.csv": csv([
      ["流水ID", "材料ID", "动作", "数量(千分单位)", "来源到货分配ID", "时间"],
      ...inventory.map(item => [item.id, item.materialId, item.action, item.quantityMilli,
        item.sourceReceiptAllocationId, item.createdAt])
    ]),
    "采购到货.csv": csv([
      ["类型", "ID", "材料ID", "采购行ID", "状态/单位", "数量(千分单位)", "时间"],
      ...purchases.map(item => ["采购行", item.id, item.materialId, item.id, item.status,
        item.orderedQuantityMilli, item.createdAt]),
      ...receipts.map(item => {
        const quantities = Array.isArray(item.quantityEvents) ? item.quantityEvents.filter(isObject) : []
        return ["到货批次", item.id, item.materialId, item.purchaseLineId, item.unit,
          quantities.at(-1)?.quantityMilli, item.occurredAt]
      })
    ]),
    "约定.csv": csv([
      ["约定ID", "标题", "类型", "版本", "状态", "条目"],
      ...agreementRows
    ]),
    "费用.csv": csv([
      ["类型", "ID", "费用ID", "动作/状态", "金额(分)", "关联付款ID", "时间"],
      ...costs.map(item => ["费用主项", item.id, item.id, item.category, item.quotedAmountFen, "", item.createdAt]),
      ...approvals.map(item => ["批准", item.id, item.costItemId, item.action, item.amountFen, "", item.createdAt]),
      ...payments.map(item => ["付款", item.id, item.costItemId, item.status, item.amountFen, "", item.occurredAt]),
      ...refunds.map(item => ["退款", item.id, item.costItemId, item.status, item.amountFen, item.paymentId, item.occurredAt])
    ]),
    "咨询.csv": csv([
      ["咨询ID", "标题", "咨询状态", "版本", "版本状态", "问题原文", "记录ID", "问题ID"],
      ...consultationRows
    ]),
    "咨询回复.csv": csv([
      ["回复ID", "咨询ID", "版本ID", "来源", "回复人", "渠道", "对方原话", "摘要", "处理状态", "收到时间"],
      ...consultationResponses.map(item => [item.id, item.consultationId, item.consultationVersionId,
        item.source, item.respondentName, item.channel, item.originalText, item.summary, item.status, item.receivedAt])
    ]),
    "材料核对.csv": csv([
      ["核对ID", "材料ID", "到货批次ID", "模型", "Prompt版本", "字段", "人工观察值", "人工期望值", "人工状态", "复核说明", "确认人", "确认时间"],
      ...materialCheckRows
    ]),
    "AI估算.csv": csv([
      ["估算版本ID", "方案ID", "方案", "材料ID", "单位", "总需求(千分单位)",
        "最小缺口(千分单位)", "最大缺口(千分单位)", "建议采购(千分单位)",
        "整包数", "估算金额(分)", "人工说明", "模型", "Prompt版本", "确认人", "确认时间"],
      ...budgetEstimateRows
    ]),
    "项目总结.csv": csv([
      ["总结版本ID", "标题", "用途", "阅读对象", "工序范围", "房间范围", "开始日期",
        "结束日期", "截止时间", "是否纳入", "分区", "人工复核内容", "交接清单",
        "复核说明", "模型", "Prompt版本", "确认人", "确认时间"],
      ...projectSummaryRows
    ])
  }
}

export function createFullBackupPlan(input: {
  rawBundle: string
  packageId: string
  createdAt: string
}): PortableExportPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.rawBundle)
  } catch {
    throw new Error("项目备份无法解析")
  }
  if (!isObject(parsed) || parsed.schema !== "renovation-sync-backup-v2" || !isObject(parsed.project)) {
    throw new Error("只能从当前版本项目数据生成完整可移植备份")
  }
  const project = parsed.project
  if (typeof project.id !== "string" || typeof project.name !== "string") throw new Error("项目资料不完整")
  const transformed = cloneWithPortableAttachments(parsed)
  return {
    packageId: input.packageId,
    purpose: "full_backup",
    projectId: project.id,
    projectName: project.name,
    createdAt: input.createdAt,
    data: transformed.data,
    sources: transformed.sources,
    reports: buildPortableReports(transformed.data)
  }
}

export function createLimitedReadPlan(input: {
  state: AppState
  projectId: string
  recordIds: string[]
  issueIds: string[]
  packageId: string
  createdAt: string
}): PortableExportPlan {
  const project = input.state.projects.find(item => item.id === input.projectId)
  if (!project) throw new Error("项目不存在")
  if (project.status === "trashed") throw new Error("项目在回收站中，不能导出资料")
  if (!input.recordIds.length && !input.issueIds.length) throw new Error("请至少选择一条记录或问题")
  const records = input.state.records.filter(item =>
    item.projectId === project.id && input.recordIds.includes(item.id))
  const issues = input.state.issues.filter(item =>
    item.projectId === project.id && input.issueIds.includes(item.id))
  if (records.length !== new Set(input.recordIds).size || issues.length !== new Set(input.issueIds).size) {
    throw new Error("选择中包含不属于当前项目的资料")
  }
  const selectedRecordIds = new Set(records.map(item => item.id))
  const safeIssues = issues.map(item => ({
    ...item,
    recordId: item.recordId && selectedRecordIds.has(item.recordId) ? item.recordId : undefined,
    proposals: item.proposals.map(proposal => ({ ...proposal }))
  }))
  const data = {
    schema: "renovation-sync-read-v1",
    project: { name: project.name, stage: project.stage },
    exportedAt: input.createdAt,
    records: records.map(item => ({ ...item, attachments: item.attachments.map(file => ({ ...file })) })),
    issues: safeIssues
  }
  const transformed = cloneWithPortableAttachments(data)
  return {
    packageId: input.packageId,
    purpose: "limited_read",
    projectId: project.id,
    projectName: project.name,
    createdAt: input.createdAt,
    data: transformed.data,
    sources: transformed.sources,
    reports: buildPortableReports(transformed.data)
  }
}

export function finalizePortablePackage(
  plan: PortableExportPlan,
  readResults: PortableReadResult[]
): PortablePackage {
  const byPath = new Map(readResults.map(item => [item.sourcePath, item]))
  const files: PortablePackageFile[] = []
  const missingFiles: PortableMissingFile[] = []
  for (const source of plan.sources) {
    const result = byPath.get(source.sourcePath)
    if (result?.contentBase64 === undefined || !result.sha256 || !Number.isInteger(result.byteLength)) {
      missingFiles.push({
        packagePath: source.packagePath,
        displayName: source.displayName,
        reason: result?.error || "read_failed",
        references: [...source.references]
      })
      continue
    }
    files.push({
      packagePath: source.packagePath,
      displayName: source.displayName,
      attachmentType: source.attachmentType,
      byteLength: result.byteLength!,
      sha256: result.sha256,
      contentBase64: result.contentBase64,
      references: [...source.references]
    })
  }
  const totalBytes = files.reduce((sum, item) => sum + item.byteLength, 0)
  return {
    schema: PORTABLE_PACKAGE_SCHEMA,
    manifest: {
      packageId: plan.packageId,
      purpose: plan.purpose,
      projectName: plan.projectName,
      createdAt: plan.createdAt,
      status: missingFiles.length ? "partial" : "complete",
      restorable: plan.purpose === "full_backup" && missingFiles.length === 0,
      fileCount: files.length,
      totalBytes,
      checksumNotice: "SHA-256用于发现文件与清单不一致，不证明拍摄真实性或第三方认证。"
    },
    data: plan.data,
    reports: plan.reports,
    files,
    missingFiles
  }
}

function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("附件编码不正确")
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return value.length / 4 * 3 - padding
}

function isSafePackagePath(path: string): boolean {
  return /^attachments\/[A-Za-z0-9._-]+$/.test(path) && !path.includes("..")
}

function validateRestorableData(data: Record<string, unknown>, availablePaths: Set<string>): void {
  if (data.schema !== "renovation-sync-backup-v2" || !isObject(data.project)
    || typeof data.project.id !== "string" || !data.project.id
    || typeof data.project.name !== "string") {
    throw new Error("可恢复包中的项目数据不正确")
  }
  const arrayKeys = [
    "projectLifecycleEvents", "records", "recordRevisions", "issues", "issueWorkflows",
    "materials", "inventory", "expenses", "agreements", "purchaseLines", "receiptBatches",
    "unitConversions", "materialInventoryEvents", "materialUsageRecords", "costItems",
    "costApprovals", "paymentFacts", "refundFacts", "members", "shares", "consultations",
    "consultationResponses", "cameras", "analyses", "materialChecks"
  ]
  const optionalR8ArrayKeys = [
    "spaces", "spaceRelations", "spaceStageStates", "legacyRoomMappings",
    "evidenceAssets", "evidenceLinks"
  ]
  let objectCount = 0
  for (const key of arrayKeys) {
    const value = data[key]
    if (!Array.isArray(value)) throw new Error(`可恢复包缺少 ${key} 数据`)
    objectCount += value.length
    const ids = new Set<string>()
    for (const item of value) {
      if (!isObject(item)) throw new Error(`可恢复包的 ${key} 数据不正确`)
      const candidateId = key === "agreements" && isObject(item.agreement)
        ? item.agreement.id
        : item.id
      if (typeof candidateId !== "string" || !candidateId.trim()) {
        throw new Error(`可恢复包的 ${key} 存在无效 ID`)
      }
      if (ids.has(candidateId)) throw new Error(`可恢复包的 ${key} 存在重复 ID`)
      ids.add(candidateId)
    }
  }
  for (const key of optionalR8ArrayKeys) {
    const value = data[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) throw new Error(`可恢复包的 ${key} 数据不正确`)
    objectCount += value.length
    const ids = new Set<string>()
    for (const item of value) {
      if (!isObject(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) {
        throw new Error(`可恢复包的 ${key} 存在无效或重复 ID`)
      }
      ids.add(item.id)
    }
  }
  for (const key of [
    "recordReviewApplications", "imageObservationApplications",
    "rectificationApplications", "consultationApplications",
    "budgetEstimateApplications", "projectSummaryApplications"
  ]) {
    const value = data[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) throw new Error(`可恢复包的 ${key} 数据不正确`)
    objectCount += value.length
    const ids = new Set<string>()
    for (const item of value) {
      if (!isObject(item) || typeof item.id !== "string" || !item.id.trim()
        || ids.has(item.id)) throw new Error(`可恢复包的 ${key} 存在无效或重复 ID`)
      ids.add(item.id)
    }
  }
  if (objectCount > PORTABLE_MAX_BUSINESS_OBJECTS) throw new Error("业务对象数量超过当前可恢复上限")

  const projectId = data.project.id
  const objects = (key: string) => arrayFrom(data, key)
  const ids = (key: string) => new Set(objects(key).map(item => item.id as string))
  const requiredReference = (
    item: Record<string, unknown>,
    field: string,
    targets: Set<string>,
    label: string
  ): void => {
    const value = item[field]
    if (typeof value !== "string" || !targets.has(value)) throw new Error(`可恢复包的${label}关联不存在`)
  }
  const optionalReference = (
    item: Record<string, unknown>,
    field: string,
    targets: Set<string>,
    label: string
  ): void => {
    if (item[field] === undefined) return
    requiredReference(item, field, targets, label)
  }
  const projectScopedKeys = [
    ...arrayKeys.filter(key => !["agreements", "unitConversions"].includes(key)),
    ...optionalR8ArrayKeys
  ]
  for (const key of projectScopedKeys) {
    for (const item of objects(key)) {
      if (item.projectId !== projectId) throw new Error(`可恢复包的 ${key} 不属于当前项目`)
    }
  }
  const assertEnum = (value: unknown, allowed: readonly string[], label: string): void => {
    if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`可恢复包的${label}状态不正确`)
  }
  const assertSafeInteger = (value: unknown, label: string, allowZero = false): void => {
    if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
      throw new Error(`可恢复包的${label}数量或金额不正确`)
    }
  }
  const assertPositiveVersion = (value: unknown, label: string): void => {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`可恢复包的${label}版本不正确`)
  }
  assertEnum(data.project.status, ["active", "archived", "trashed"], "项目")
  for (const item of objects("records")) {
    assertPositiveVersion(item.version, "记录")
    if (!Array.isArray(item.attachments)) throw new Error("可恢复包的记录附件不正确")
  }
  for (const item of objects("recordRevisions")) {
    assertPositiveVersion(item.version, "记录历史")
    if (!Array.isArray(item.attachments)) throw new Error("可恢复包的记录历史附件不正确")
  }
  for (const item of objects("issues")) {
    assertEnum(item.status, ["pending_confirmation", "pending_action", "pending_review", "closed"], "问题")
    if (!Array.isArray(item.proposals)) throw new Error("可恢复包的问题预案不正确")
  }
  for (const item of objects("materials")) {
    if (typeof item.plannedQuantity !== "number" || !Number.isFinite(item.plannedQuantity)
      || item.plannedQuantity < 0) throw new Error("可恢复包的材料计划数量不正确")
    if (item.unitPriceFen !== undefined) assertSafeInteger(item.unitPriceFen, "材料单价", true)
  }
  for (const item of objects("inventory")) {
    if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error("可恢复包的旧库存数量不正确")
    }
  }
  for (const item of objects("expenses")) assertSafeInteger(item.amountFen, "旧费用")
  for (const item of objects("projectLifecycleEvents")) {
    assertEnum(item.action, ["archived", "reopened", "trashed", "restored"], "项目生命周期")
  }

  const recordIds = ids("records")
  const issueIds = ids("issues")
  const materialIds = ids("materials")
  const purchaseIds = ids("purchaseLines")
  const receiptIds = ids("receiptBatches")
  const costIds = ids("costItems")
  const paymentIds = ids("paymentFacts")
  const memberIds = ids("members")
  const consultationIds = ids("consultations")
  const consultationResponseIds = ids("consultationResponses")
  const spaceIds = ids("spaces")
  const evidenceIds = ids("evidenceAssets")
  const recordRevisionIds = ids("recordRevisions")
  const cameraIds = ids("cameras")

  objects("recordRevisions").forEach(item => requiredReference(item, "recordId", recordIds, "记录历史"))
  objects("issues").forEach(item => optionalReference(item, "recordId", recordIds, "问题记录"))

  const proposalIds = new Set<string>()
  const treatmentIds = new Set<string>()
  const reviewIds = new Set<string>()
  for (const workflow of objects("issueWorkflows")) {
    if (!issueIds.has(workflow.id as string)) throw new Error("可恢复包的问题流程没有对应问题")
    assertEnum(workflow.status, ["pending_confirmation", "pending_action", "pending_review", "closed"], "问题流程")
    assertPositiveVersion(workflow.version, "问题流程")
    if (!Array.isArray(workflow.proposals) || !Array.isArray(workflow.treatments)
      || !Array.isArray(workflow.reviews) || !Array.isArray(workflow.reopenings)) {
      throw new Error("可恢复包的问题流程历史不正确")
    }
    const proposals = Array.isArray(workflow.proposals) ? workflow.proposals.filter(isObject) : []
    const treatments = Array.isArray(workflow.treatments) ? workflow.treatments.filter(isObject) : []
    const reviews = Array.isArray(workflow.reviews) ? workflow.reviews.filter(isObject) : []
    const localProposalIds = new Set<string>()
    const localTreatmentIds = new Set<string>()
    for (const proposal of proposals) {
      const id = proposal.id
      if (typeof id !== "string" || !id || proposalIds.has(id)) throw new Error("可恢复包的问题预案 ID 不正确")
      assertEnum(proposal.status, ["pending", "active", "superseded"], "问题预案")
      proposalIds.add(id)
      localProposalIds.add(id)
    }
    for (const treatment of treatments) {
      const id = treatment.id
      if (typeof id !== "string" || !id || localTreatmentIds.has(id)) throw new Error("可恢复包的整改记录 ID 不正确")
      localTreatmentIds.add(id)
      treatmentIds.add(id)
      requiredReference(treatment, "activeProposalId", localProposalIds, "整改预案")
      if (!Array.isArray(treatment.evidenceSourceIds)
        || !treatment.evidenceSourceIds.every(sourceId => typeof sourceId === "string" && recordIds.has(sourceId))) {
        throw new Error("可恢复包的整改证据关联不存在")
      }
    }
    for (const review of reviews) {
      if (typeof review.id !== "string" || !review.id || reviewIds.has(review.id)) {
        throw new Error("可恢复包的复查记录 ID 不正确")
      }
      reviewIds.add(review.id)
      requiredReference(review, "treatmentId", localTreatmentIds, "复查整改")
      optionalReference(review, "duplicateOfIssueId", issueIds, "重复问题")
      if (!Array.isArray(review.evidenceSourceIds)
        || !review.evidenceSourceIds.every(sourceId => typeof sourceId === "string" && recordIds.has(sourceId))) {
        throw new Error("可恢复包的复查证据关联不存在")
      }
    }
  }

  for (const space of objects("spaces")) {
    assertPositiveVersion(space.version, "空间")
    assertEnum(space.status, ["active", "inactive"], "空间")
    if (!Number.isSafeInteger(space.order) || Number(space.order) < 0
      || typeof space.participatesInTopology !== "boolean") {
      throw new Error("可恢复包的空间顺序或拓扑状态不正确")
    }
  }
  for (const relation of objects("spaceRelations")) {
    assertPositiveVersion(relation.version, "空间关系")
    requiredReference(relation, "fromSpaceId", spaceIds, "空间关系起点")
    requiredReference(relation, "toSpaceId", spaceIds, "空间关系终点")
    if (relation.fromSpaceId === relation.toSpaceId) throw new Error("可恢复包的空间关系不能自关联")
    assertEnum(relation.kind, ["adjacent", "access", "contains", "other"], "空间关系")
    assertEnum(relation.status, ["active", "inactive"], "空间关系")
  }
  for (const mapping of objects("legacyRoomMappings")) {
    assertPositiveVersion(mapping.version, "旧房间映射")
    requiredReference(mapping, "spaceId", spaceIds, "旧房间映射空间")
  }
  for (const asset of objects("evidenceAssets")) {
    assertPositiveVersion(asset.version, "证据")
    assertEnum(asset.category, ["image", "audio", "video", "document"], "证据类别")
    assertEnum(asset.status, ["pending", "ready", "failed", "hidden", "missing"], "证据")
    if (typeof asset.fileName !== "string" || !asset.fileName) throw new Error("可恢复包的证据文件名不正确")
    if (asset.sourceDeviceId !== undefined && !cameraIds.has(String(asset.sourceDeviceId))) {
      throw new Error("可恢复包的证据设备关联不存在")
    }
  }
  for (const stageState of objects("spaceStageStates")) {
    assertPositiveVersion(stageState.version, "空间阶段")
    requiredReference(stageState, "spaceId", spaceIds, "空间阶段空间")
    assertEnum(stageState.status, ["not_started", "in_progress", "pending_review", "confirmed_complete"], "空间阶段")
    if (!Array.isArray(stageState.sourceEvidenceIds)
      || !stageState.sourceEvidenceIds.every(item => typeof item === "string" && evidenceIds.has(item))) {
      throw new Error("可恢复包的空间阶段证据关联不存在")
    }
  }
  const evidenceTargets: Record<string, Set<string>> = {
    project: new Set([projectId]),
    record: recordIds,
    record_revision: recordRevisionIds,
    issue: issueIds,
    material: materialIds,
    receipt_batch: receiptIds,
    issue_treatment: treatmentIds,
    issue_review: reviewIds,
    consultation: consultationIds
  }
  for (const link of objects("evidenceLinks")) {
    assertPositiveVersion(link.version, "证据关联")
    requiredReference(link, "evidenceId", evidenceIds, "证据关联原件")
    optionalReference(link, "spaceId", spaceIds, "证据关联空间")
    assertEnum(link.status, ["active", "removed"], "证据关联")
    if (!isObject(link.target) || typeof link.target.type !== "string" || typeof link.target.id !== "string") {
      throw new Error("可恢复包的证据目标不正确")
    }
    if (link.target.type === "camera_session") {
      if (!link.target.id) throw new Error("可恢复包的监控会话证据目标不正确")
    } else {
      const targets = evidenceTargets[link.target.type]
      if (!targets || !targets.has(link.target.id)) throw new Error("可恢复包的证据目标不存在")
    }
  }

  const agreementVersionIds = new Set<string>()
  for (const aggregate of objects("agreements")) {
    if (!isObject(aggregate.agreement) || aggregate.agreement.projectId !== projectId
      || !Array.isArray(aggregate.versions)) {
      throw new Error("可恢复包的约定数据不正确")
    }
    const agreement = aggregate.agreement
    assertPositiveVersion(agreement.version, "约定")
    assertEnum(agreement.subject, ["material", "construction"], "约定类型")
    if (agreement.subject === "material") optionalReference(agreement, "subjectId", materialIds, "约定材料")
    const localVersionIds = new Set<string>()
    for (const version of aggregate.versions.filter(isObject)) {
      const versionId = version.id
      if (typeof versionId !== "string" || !versionId || agreementVersionIds.has(versionId)
        || version.agreementId !== agreement.id) {
        throw new Error("可恢复包的约定版本关联不正确")
      }
      agreementVersionIds.add(versionId)
      localVersionIds.add(versionId)
      assertPositiveVersion(version.revision, "约定修订")
      assertEnum(version.status, ["draft", "pending_confirmation", "active", "rejected", "withdrawn", "superseded"], "约定版本")
      if (!Array.isArray(version.terms) || !Array.isArray(version.sourceIds)
        || !Array.isArray(version.sourceConflicts)) throw new Error("可恢复包的约定版本内容不正确")
    }
    optionalReference(agreement, "activeVersionId", localVersionIds, "生效约定版本")
    for (const version of aggregate.versions.filter(isObject)) {
      optionalReference(version, "baseActiveVersionId", localVersionIds, "约定基线版本")
    }
  }

  for (const line of objects("purchaseLines")) {
    assertSafeInteger(line.orderedQuantityMilli, "采购")
    assertEnum(line.status, ["ordered", "cancelled"], "采购行")
    requiredReference(line, "materialId", materialIds, "采购材料")
    optionalReference(line, "agreementVersionId", agreementVersionIds, "采购约定版本")
  }
  const receiptAllocationIds = new Set<string>()
  const receiptQuantityIds = new Set<string>()
  for (const batch of objects("receiptBatches")) {
    assertPositiveVersion(batch.version, "到货批次")
    requiredReference(batch, "materialId", materialIds, "到货材料")
    optionalReference(batch, "purchaseLineId", purchaseIds, "到货采购行")
    if (typeof batch.purchaseLineId === "string") {
      const line = objects("purchaseLines").find(item => item.id === batch.purchaseLineId)
      if (line?.materialId !== batch.materialId) throw new Error("可恢复包的到货批次与采购材料不一致")
    }
    if (!Array.isArray(batch.quantityEvents) || !Array.isArray(batch.allocationEvents)) {
      throw new Error("可恢复包的到货事件不正确")
    }
    for (const event of batch.quantityEvents.filter(isObject)) {
      const id = event.id
      if (typeof id !== "string" || !id || receiptQuantityIds.has(id)) {
        throw new Error("可恢复包的到货数量事件 ID 不正确")
      }
      receiptQuantityIds.add(id)
      assertEnum(event.kind, ["submitted", "corrected"], "到货数量事件")
      assertSafeInteger(event.quantityMilli, "到货")
    }
    for (const event of batch.allocationEvents.filter(isObject)) {
      const id = event.id
      if (typeof id !== "string" || !id || receiptAllocationIds.has(id)) {
        throw new Error("可恢复包的到货分配 ID 不正确")
      }
      receiptAllocationIds.add(id)
      assertEnum(event.kind, ["accepted_available", "marked_return", "completed_return"], "到货分配事件")
      assertSafeInteger(event.quantityMilli, "到货分配")
    }
  }
  const materialCheckSourceIds = new Set([
    ...recordIds,
    ...issueIds,
    ...materialIds,
    ...purchaseIds,
    ...receiptIds,
    ...ids("expenses"),
    ...agreementVersionIds,
    ...consultationIds,
    ...consultationResponseIds
  ])
  for (const check of objects("materialChecks")) {
    requiredReference(check, "materialId", materialIds, "材料核对材料")
    requiredReference(check, "receiptBatchId", receiptIds, "材料核对到货批次")
    const batch = objects("receiptBatches").find(item => item.id === check.receiptBatchId)
    if (batch?.materialId !== check.materialId) throw new Error("可恢复包的材料核对与到货材料不一致")
    if (typeof check.aiJobId !== "string" || !check.aiJobId
      || typeof check.model !== "string" || !check.model
      || typeof check.promptVersion !== "string" || !check.promptVersion
      || !isObject(check.originalResult) || !isObject(check.review)
      || !Array.isArray(check.originalResult.fields) || !Array.isArray(check.review.fields)
      || check.originalResult.materialSourceId !== check.materialId
      || check.originalResult.receiptSourceId !== check.receiptBatchId) {
      throw new Error("可恢复包的材料核对记录不正确")
    }
    if (check.sourceSnapshots !== undefined) {
      if (!Array.isArray(check.sourceSnapshots)) throw new Error("可恢复包的材料核对来源快照不正确")
      const snapshotIds = new Set<string>()
      for (const source of check.sourceSnapshots.filter(isObject)) {
        if (typeof source.sourceId !== "string" || !materialCheckSourceIds.has(source.sourceId)
          || snapshotIds.has(source.sourceId)
          || ![
            "record", "agreement", "issue", "material", "purchase", "receipt", "expense",
            "consultation", "consultation_response"
          ].includes(String(source.kind))
          || typeof source.version !== "string" || !source.version) {
          throw new Error("可恢复包的材料核对来源快照不正确")
        }
        snapshotIds.add(source.sourceId)
      }
      if (snapshotIds.size !== check.sourceSnapshots.length
        || !snapshotIds.has(String(check.materialId))
        || !snapshotIds.has(String(check.receiptBatchId))) {
        throw new Error("可恢复包的材料核对来源快照不完整")
      }
    }
    const originalKeys = new Set<string>()
    for (const field of check.originalResult.fields.filter(isObject)) {
      if (typeof field.key !== "string" || !field.key || originalKeys.has(field.key)
        || !Array.isArray(field.observedSourceIds) || !Array.isArray(field.expectedSourceIds)
        || !field.observedSourceIds.every(sourceId => typeof sourceId === "string" && materialCheckSourceIds.has(sourceId))
        || !field.expectedSourceIds.every(sourceId => typeof sourceId === "string" && materialCheckSourceIds.has(sourceId))) {
        throw new Error("可恢复包的材料核对原结果不正确")
      }
      originalKeys.add(field.key)
    }
    const reviewKeys = new Set<string>()
    for (const field of check.review.fields.filter(isObject)) {
      if (typeof field.key !== "string" || !originalKeys.has(field.key) || reviewKeys.has(field.key)) {
        throw new Error("可恢复包的材料核对人工复核不正确")
      }
      assertEnum(field.status, ["matches", "differs", "observed_only", "expected_only", "unknown"], "材料核对")
      reviewKeys.add(field.key)
    }
    if (originalKeys.size !== check.originalResult.fields.length
      || reviewKeys.size !== check.review.fields.length
      || originalKeys.size !== reviewKeys.size) {
      throw new Error("可恢复包的材料核对字段不完整")
    }
  }
  const validateAiSnapshots = (value: unknown, label: string) => {
    if (!Array.isArray(value) || !value.length) throw new Error(`可恢复包的${label}来源快照不正确`)
    const snapshotIds = new Set<string>()
    for (const source of value.filter(isObject)) {
      if (typeof source.sourceId !== "string" || !materialCheckSourceIds.has(source.sourceId)
        || snapshotIds.has(source.sourceId)
        || ![
          "record", "agreement", "issue", "material", "purchase", "receipt", "expense",
          "consultation", "consultation_response"
        ].includes(String(source.kind))
        || typeof source.version !== "string" || !source.version) {
        throw new Error(`可恢复包的${label}来源快照不正确`)
      }
      snapshotIds.add(source.sourceId)
    }
    if (snapshotIds.size !== value.length) throw new Error(`可恢复包的${label}来源快照不完整`)
  }
  const recordAttachments = new Map(objects("records").map(record => [
    String(record.id),
    new Set(objectList(record.attachments).map(file => String(file.id)))
  ]))
  const validateImageRefs = (value: unknown, label: string) => {
    if (!Array.isArray(value)) throw new Error(`可恢复包的${label}图片引用不正确`)
    const imageIds = new Set<string>()
    for (const image of value.filter(isObject)) {
      if (typeof image.id !== "string" || imageIds.has(image.id)
        || typeof image.sourceId !== "string" || !recordIds.has(image.sourceId)
        || !recordAttachments.get(image.sourceId)?.has(image.id)) {
        throw new Error(`可恢复包的${label}图片引用不正确`)
      }
      imageIds.add(image.id)
    }
    if (imageIds.size !== value.length) throw new Error(`可恢复包的${label}图片引用不完整`)
  }
  for (const application of objects("recordReviewApplications")) {
    requiredReference(application, "targetRecordId", recordIds, "记录整理目标")
    if (typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !isObject(application.originalResult) || !isObject(application.review)) {
      throw new Error("可恢复包的记录整理写回不正确")
    }
    validateAiSnapshots(application.sourceSnapshots, "记录整理")
    validateImageRefs(application.imageRefs, "记录整理")
  }
  for (const application of objects("imageObservationApplications")) {
    if (typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !isObject(application.originalResult) || !isObject(application.review)
      || !Array.isArray(application.issueLinks)) {
      throw new Error("可恢复包的图片观察写回不正确")
    }
    validateAiSnapshots(application.sourceSnapshots, "图片观察")
    validateImageRefs(application.imageRefs, "图片观察")
    for (const link of application.issueLinks.filter(isObject)) {
      requiredReference(link, "issueId", issueIds, "图片观察问题")
      if (typeof link.itemId !== "string" || !link.itemId) {
        throw new Error("可恢复包的图片观察条目标识不正确")
      }
    }
  }
  for (const application of objects("rectificationApplications")) {
    if (application.projectId !== projectId) throw new Error("可恢复包的整改辅助不属于当前项目")
    requiredReference(application, "targetIssueId", issueIds, "整改辅助目标问题")
    if (typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !["proposal", "review"].includes(String(application.mode))
      || !isObject(application.originalResult) || !isObject(application.review)
      || !Array.isArray(application.proposalLinks)) {
      throw new Error("可恢复包的整改辅助写回不正确")
    }
    validateAiSnapshots(application.sourceSnapshots, "整改辅助")
    validateImageRefs(application.imageRefs, "整改辅助")
    for (const link of application.proposalLinks.filter(isObject)) {
      requiredReference(link, "proposalId", proposalIds, "整改辅助预案")
    }
  }
  for (const application of objects("consultationApplications")) {
    if (application.projectId !== projectId) throw new Error("可恢复包的咨询整理不属于当前项目")
    if (typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !["prepare", "response"].includes(String(application.mode))
      || !isObject(application.originalResult) || !isObject(application.review)
      || !Array.isArray(application.proposalLinks)) {
      throw new Error("可恢复包的咨询整理写回不正确")
    }
    optionalReference(application, "targetConsultationId", consultationIds, "咨询整理目标")
    optionalReference(application, "createdConsultationId", consultationIds, "咨询整理草稿")
    validateAiSnapshots(application.sourceSnapshots, "咨询整理")
    validateImageRefs(application.imageRefs ?? [], "咨询整理")
    for (const link of application.proposalLinks.filter(isObject)) {
      requiredReference(link, "proposalId", proposalIds, "咨询整理预案")
      requiredReference(link, "issueId", issueIds, "咨询整理问题")
      const responseIds = link.responseIds ?? []
      if (!Array.isArray(responseIds) || responseIds.some(responseId =>
        typeof responseId !== "string" || !consultationResponseIds.has(responseId))) {
        throw new Error("可恢复包的咨询整理回复关联不正确")
      }
    }
  }
  for (const application of objects("budgetEstimateApplications")) {
    if (application.projectId !== projectId
      || typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !isObject(application.originalResult) || !isObject(application.review)
      || !Array.isArray(application.scenarios) || !Array.isArray(application.financeSnapshots)) {
      throw new Error("可恢复包的预算估算版本不正确")
    }
    validateAiSnapshots(application.sourceSnapshots, "预算估算")
    for (const scenario of application.scenarios.filter(isObject)) {
      optionalReference(scenario, "materialId", materialIds, "预算估算材料")
    }
    for (const snapshot of application.financeSnapshots.filter(isObject)) {
      requiredReference(snapshot, "costItemId", costIds, "预算估算费用")
      if (!isObject(snapshot.summary)) throw new Error("可恢复包的预算财务快照不正确")
    }
  }
  for (const application of objects("projectSummaryApplications")) {
    if (application.projectId !== projectId
      || typeof application.aiJobId !== "string" || !application.aiJobId
      || typeof application.promptVersion !== "string" || !application.promptVersion
      || typeof application.contractVersion !== "string" || !application.contractVersion
      || !isObject(application.scope) || !isObject(application.originalResult)
      || !isObject(application.review) || !Array.isArray(application.review.sections)
      || !Array.isArray(application.review.handoff)
      || !Array.isArray(application.issueSnapshots)
      || !Array.isArray(application.financeSnapshots)) {
      throw new Error("可恢复包的项目总结版本不正确")
    }
    validateAiSnapshots(application.sourceSnapshots, "项目总结")
    for (const snapshot of application.issueSnapshots.filter(isObject)) {
      requiredReference(snapshot, "issueId", issueIds, "项目总结问题")
    }
    for (const snapshot of application.financeSnapshots.filter(isObject)) {
      requiredReference(snapshot, "costItemId", costIds, "项目总结费用")
      if (!isObject(snapshot.summary)) throw new Error("可恢复包的项目总结财务快照不正确")
    }
  }
  for (const conversion of objects("unitConversions")) {
    requiredReference(conversion, "materialId", materialIds, "单位换算材料")
    assertSafeInteger(conversion.numerator, "单位换算分子")
    assertSafeInteger(conversion.denominator, "单位换算分母")
    assertPositiveVersion(conversion.version, "单位换算")
  }
  for (const item of objects("inventory")) requiredReference(item, "materialId", materialIds, "库存材料")

  const inventoryEventIds = ids("materialInventoryEvents")
  for (const event of objects("materialInventoryEvents")) {
    requiredReference(event, "materialId", materialIds, "库存流水材料")
    optionalReference(event, "sourceEventId", inventoryEventIds, "库存来源流水")
    optionalReference(event, "sourceReceiptAllocationId", receiptAllocationIds, "库存到货分配")
    assertEnum(event.action, ["available_received", "issued", "returned_site", "returned_supplier", "warehouse_waste", "adjustment_increase", "adjustment_decrease"], "库存流水")
    assertSafeInteger(event.quantityMilli, "库存流水")
  }
  for (const usage of objects("materialUsageRecords")) {
    requiredReference(usage, "materialId", materialIds, "用料材料")
    requiredReference(usage, "issuedEventId", inventoryEventIds, "用料出库流水")
    assertSafeInteger(usage.quantityMilli, "用料")
  }

  for (const cost of objects("costItems")) {
    optionalReference(cost, "materialId", materialIds, "费用材料")
    assertEnum(cost.category, ["material", "labor", "transport", "other"], "费用分类")
    if (cost.quotedAmountFen !== undefined) assertSafeInteger(cost.quotedAmountFen, "费用报价", true)
  }
  for (const approval of objects("costApprovals")) {
    requiredReference(approval, "costItemId", costIds, "费用批准")
    assertEnum(approval.action, ["initial", "increase", "decrease"], "费用批准")
    assertSafeInteger(approval.amountFen, "费用批准")
  }
  for (const payment of objects("paymentFacts")) {
    requiredReference(payment, "costItemId", costIds, "付款费用")
    assertEnum(payment.status, ["pending_confirmation", "confirmed", "rejected"], "付款")
    assertSafeInteger(payment.amountFen, "付款")
    assertPositiveVersion(payment.version, "付款")
  }
  for (const refund of objects("refundFacts")) {
    requiredReference(refund, "costItemId", costIds, "退款费用")
    requiredReference(refund, "paymentId", paymentIds, "退款付款")
    const payment = objects("paymentFacts").find(item => item.id === refund.paymentId)
    if (payment?.costItemId !== refund.costItemId) throw new Error("可恢复包的退款与原付款费用不一致")
    assertEnum(refund.status, ["pending_confirmation", "confirmed", "rejected"], "退款")
    assertSafeInteger(refund.amountFen, "退款")
    assertPositiveVersion(refund.version, "退款")
  }

  const consultationVersionIds = new Set<string>()
  for (const consultation of objects("consultations")) {
    assertEnum(consultation.status, ["draft", "published", "closed"], "咨询")
    assertPositiveVersion(consultation.version, "咨询")
    if (!Array.isArray(consultation.versions)) throw new Error("可恢复包的咨询版本不正确")
    const localVersionIds = new Set<string>()
    for (const version of consultation.versions.filter(isObject)) {
      const versionId = version.id
      if (typeof versionId !== "string" || !versionId || consultationVersionIds.has(versionId)
        || version.consultationId !== consultation.id) {
        throw new Error("可恢复包的咨询版本关联不正确")
      }
      consultationVersionIds.add(versionId)
      localVersionIds.add(versionId)
      assertPositiveVersion(version.revision, "咨询修订")
      assertEnum(version.status, ["draft", "published", "superseded"], "咨询版本")
      if (!Array.isArray(version.recordIds)
        || !version.recordIds.every(recordId => typeof recordId === "string" && recordIds.has(recordId))) {
        throw new Error("可恢复包的咨询记录关联不存在")
      }
      if (!Array.isArray(version.issueIds)
        || !version.issueIds.every(issueId => typeof issueId === "string" && issueIds.has(issueId))) {
        throw new Error("可恢复包的咨询问题关联不存在")
      }
    }
    optionalReference(consultation, "draftVersionId", localVersionIds, "咨询草稿版本")
    optionalReference(consultation, "activeVersionId", localVersionIds, "咨询发布版本")
  }
  for (const response of objects("consultationResponses")) {
    requiredReference(response, "consultationId", consultationIds, "咨询回复")
    requiredReference(response, "consultationVersionId", consultationVersionIds, "咨询回复版本")
    optionalReference(response, "memberId", memberIds, "咨询回复成员")
    optionalReference(response, "targetIssueId", issueIds, "咨询回复问题")
    optionalReference(response, "proposalId", proposalIds, "咨询回复预案")
    assertEnum(response.source, ["manual_relay", "member_direct_local"], "咨询回复来源")
    assertEnum(response.status, ["pending", "converted_to_proposal", "dismissed"], "咨询回复")
  }
  for (const analysis of objects("analyses")) {
    requiredReference(analysis, "recordId", recordIds, "分析记录")
    assertEnum(analysis.source, ["manual", "rule_reference", "ai"], "分析来源")
    assertEnum(analysis.status, ["draft", "accepted", "dismissed", "failed"], "分析")
  }

  const visit = (current: unknown, depth: number): void => {
    if (depth > PORTABLE_MAX_NESTING_DEPTH) throw new Error("可恢复包嵌套层级过深")
    if (Array.isArray(current)) {
      current.forEach(item => visit(item, depth + 1))
      return
    }
    if (!isObject(current)) return
    if (current.kind === "local_file" && typeof current.localPath === "string") {
      if (!current.localPath.startsWith("renosync://")) throw new Error("证据原件引用不是包内路径")
      const packagePath = current.localPath.slice("renosync://".length)
      if (!availablePaths.has(packagePath)) throw new Error("证据原件引用没有对应文件")
      return
    }
    if (isAttachment(current)) {
      if (!current.localPath.startsWith("renosync://")) throw new Error("附件引用不是包内路径")
      const packagePath = current.localPath.slice("renosync://".length)
      if (!availablePaths.has(packagePath)) throw new Error("附件引用没有对应文件")
      return
    }
    Object.values(current).forEach(item => visit(item, depth + 1))
  }
  visit(data, 0)
}

export function parsePortablePackage(raw: string): PortablePackage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("可移植包不是有效 JSON")
  }
  if (!isObject(parsed) || parsed.schema !== PORTABLE_PACKAGE_SCHEMA || !isObject(parsed.manifest)
    || !isObject(parsed.data) || !isObject(parsed.reports)
    || !Array.isArray(parsed.files) || !Array.isArray(parsed.missingFiles)) {
    throw new Error("可移植包格式不正确")
  }
  const pkg = parsed as unknown as PortablePackage
  if (JSON.stringify(pkg.data).length > PORTABLE_MAX_DATA_CHARACTERS
    || JSON.stringify(pkg.reports).length > PORTABLE_MAX_DATA_CHARACTERS) {
    throw new Error("业务数据超过当前可恢复上限")
  }
  if (typeof pkg.manifest.packageId !== "string" || !pkg.manifest.packageId
    || typeof pkg.manifest.projectName !== "string" || typeof pkg.manifest.createdAt !== "string"
    || (pkg.manifest.status !== "complete" && pkg.manifest.status !== "partial")
    || typeof pkg.manifest.restorable !== "boolean"
    || !Number.isInteger(pkg.manifest.fileCount) || !Number.isInteger(pkg.manifest.totalBytes)
    || typeof pkg.manifest.checksumNotice !== "string"
    || (pkg.manifest.purpose !== "full_backup" && pkg.manifest.purpose !== "limited_read")) {
    throw new Error("可移植包用途不正确")
  }
  if (pkg.files.length + pkg.missingFiles.length > PORTABLE_MAX_FILES) {
    throw new Error("附件数量超过当前可恢复上限")
  }
  const paths = new Set<string>()
  let totalBytes = 0
  for (const file of pkg.files) {
    if (!isObject(file) || typeof file.packagePath !== "string" || !isSafePackagePath(file.packagePath)
      || typeof file.displayName !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)
      || typeof file.contentBase64 !== "string" || !Number.isInteger(file.byteLength)
      || file.byteLength < 0 || !Array.isArray(file.references)
      || !file.references.every(reference => typeof reference === "string")
      || (file.attachmentType !== "image" && file.attachmentType !== "audio" && file.attachmentType !== "file")) {
      throw new Error("可移植包附件清单不正确")
    }
    if (paths.has(file.packagePath)) throw new Error("可移植包存在重复附件路径")
    paths.add(file.packagePath)
    if (base64ByteLength(file.contentBase64) !== file.byteLength) throw new Error("附件大小与清单不一致")
    totalBytes += file.byteLength
    if (totalBytes > PORTABLE_MAX_SOURCE_BYTES) throw new Error("附件总量超过当前可恢复上限")
  }
  for (const missing of pkg.missingFiles) {
    if (!isObject(missing) || typeof missing.packagePath !== "string" || !isSafePackagePath(missing.packagePath)
      || typeof missing.displayName !== "string" || !Array.isArray(missing.references)
      || !missing.references.every(reference => typeof reference === "string")
      || !["missing", "changed", "read_failed", "too_large"].includes(missing.reason)) {
      throw new Error("可移植包缺失清单不正确")
    }
    if (paths.has(missing.packagePath)) throw new Error("可移植包存在重复附件路径")
    paths.add(missing.packagePath)
  }
  if (pkg.manifest.fileCount !== pkg.files.length || pkg.manifest.totalBytes !== totalBytes) {
    throw new Error("可移植包统计与文件清单不一致")
  }
  if (pkg.manifest.status === "complete" && pkg.missingFiles.length) throw new Error("完整状态与缺失清单矛盾")
  if (pkg.manifest.restorable && (pkg.manifest.purpose !== "full_backup" || pkg.missingFiles.length)) {
    throw new Error("可恢复状态与资料内容矛盾")
  }
  if (pkg.manifest.restorable && pkg.data.schema !== "renovation-sync-backup-v2") {
    throw new Error("可恢复包中的业务数据版本不正确")
  }
  if (pkg.manifest.restorable) validateRestorableData(pkg.data, paths)
  return pkg
}

export function hydrateRestorableBundle(
  pkg: PortablePackage,
  localPaths: Record<string, string>
): string {
  if (!pkg.manifest.restorable || pkg.manifest.purpose !== "full_backup") {
    throw new Error("该资料包不包含完整可恢复项目")
  }
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > PORTABLE_MAX_NESTING_DEPTH) throw new Error("可恢复包嵌套层级过深")
    if (Array.isArray(current)) return current.map(item => visit(item, depth + 1))
    if (!isObject(current)) return current
    if (current.kind === "local_file" && typeof current.localPath === "string") {
      if (!current.localPath.startsWith("renosync://")) throw new Error("证据原件引用不是包内路径")
      const packagePath = current.localPath.slice("renosync://".length)
      const localPath = localPaths[packagePath]
      if (!localPath) throw new Error("证据原件落盘结果不完整")
      return { ...current, localPath }
    }
    if (isAttachment(current)) {
      if (!current.localPath.startsWith("renosync://")) throw new Error("附件引用不是包内路径")
      const packagePath = current.localPath.slice("renosync://".length)
      const localPath = localPaths[packagePath]
      if (!localPath) throw new Error("附件落盘结果不完整")
      return { ...current, localPath }
    }
    return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, visit(value, depth + 1)]))
  }
  return JSON.stringify(visit(pkg.data, 0))
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function attachmentMime(file: PortablePackageFile): string {
  const extension = file.displayName.toLowerCase().split(".").pop()
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "png") return "image/png"
  if (extension === "webp") return "image/webp"
  if (extension === "pdf") return "application/pdf"
  if (extension === "mp3") return "audio/mpeg"
  if (extension === "m4a") return "audio/mp4"
  return "application/octet-stream"
}

function tableRows(items: Array<Record<string, unknown>>, fields: string[]): string {
  if (!items.length) return '<p class="empty">无</p>'
  return `<table><thead><tr>${fields.map(field => `<th>${escapeHtml(field)}</th>`).join("")}</tr></thead><tbody>${items.map(item =>
    `<tr>${fields.map(field => `<td>${escapeHtml(item[field])}</td>`).join("")}</tr>`).join("")}</tbody></table>`
}

function stringList(value: unknown): string {
  return Array.isArray(value) ? value.filter(item => typeof item === "string").join("；") : ""
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function fenDisplay(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? `¥${(value / 100).toFixed(2)}` : ""
}

function optionalHtmlSection(title: string, rows: Array<Record<string, unknown>>, fields: string[]): string {
  return rows.length ? `<section><h2>${escapeHtml(title)}</h2>${tableRows(rows, fields)}</section>` : ""
}

function attachmentReferenceLabel(reference: string, data: Record<string, unknown>): string {
  const match = reference.match(/^\$\.(records|recordRevisions|shares|consultations|evidenceAssets)\[(\d+)\]/)
  if (!match) return reference.replace(/^\$\./, "")
  const item = arrayFrom(data, match[1])[Number(match[2])]
  if (!item) return reference.replace(/^\$\./, "")
  if (match[1] === "records") return `记录：${displayText(item.title, displayText(item.id))}`
  if (match[1] === "recordRevisions") return `记录历史 v${displayText(item.version)}：${displayText(item.title, displayText(item.recordId))}`
  if (match[1] === "shares") return `资料快照：${displayText(item.title, displayText(item.id))}`
  if (match[1] === "evidenceAssets") return `证据原件：${displayText(item.fileName, displayText(item.id))}`
  return `咨询：${displayText(item.title, displayText(item.id))}`
}

export function renderPortableHtml(pkg: PortablePackage): string {
  const records = arrayFrom(pkg.data, "records")
  const revisions = arrayFrom(pkg.data, "recordRevisions")
  const issues = arrayFrom(pkg.data, "issues")
  const workflows = arrayFrom(pkg.data, "issueWorkflows")
  const materials = arrayFrom(pkg.data, "materials")
  const purchases = arrayFrom(pkg.data, "purchaseLines")
  const receipts = arrayFrom(pkg.data, "receiptBatches")
  const agreements = arrayFrom(pkg.data, "agreements")
  const costs = arrayFrom(pkg.data, "costItems")
  const approvals = arrayFrom(pkg.data, "costApprovals")
  const payments = arrayFrom(pkg.data, "paymentFacts")
  const refunds = arrayFrom(pkg.data, "refundFacts")
  const consultations = arrayFrom(pkg.data, "consultations")
  const responses = arrayFrom(pkg.data, "consultationResponses")
  const materialChecks = arrayFrom(pkg.data, "materialChecks")
  const budgetEstimates = arrayFrom(pkg.data, "budgetEstimateApplications")
  const projectSummaries = arrayFrom(pkg.data, "projectSummaryApplications")
  const spaces = arrayFrom(pkg.data, "spaces")
  const spaceRelations = arrayFrom(pkg.data, "spaceRelations")
  const spaceStageStates = arrayFrom(pkg.data, "spaceStageStates")
  const evidenceAssets = arrayFrom(pkg.data, "evidenceAssets")
  const evidenceLinks = arrayFrom(pkg.data, "evidenceLinks")
  const spaceNames = new Map(spaces.map(item => [item.id, displayText(item.name, displayText(item.id))]))
  const evidenceNames = new Map(evidenceAssets.map(item => [item.id, displayText(item.fileName, displayText(item.id))]))
  const spaceRows = spaces.map(item => ({
    空间: item.name,
    类型: item.kind,
    状态: item.status,
    是否参与拓扑: item.participatesInTopology === false ? "否" : "是",
    排序: item.order
  }))
  const relationRows = spaceRelations.map(item => ({
    起点: spaceNames.get(item.fromSpaceId) || item.fromSpaceId,
    终点: spaceNames.get(item.toSpaceId) || item.toSpaceId,
    关系: item.kind,
    方向提示: item.directionHint,
    状态: item.status
  }))
  const stageStateRows = spaceStageStates.map(item => ({
    空间: spaceNames.get(item.spaceId) || item.spaceId,
    阶段: item.stageId,
    状态: item.status,
    依据原件: Array.isArray(item.sourceEvidenceIds)
      ? item.sourceEvidenceIds.map(id => evidenceNames.get(id) || id).join("；") : "",
    说明: item.note,
    更新时间: item.updatedAt
  }))
  const evidenceRows = evidenceAssets.map(item => ({
    原件: item.fileName,
    类型: item.category,
    来源: item.origin,
    状态: item.status,
    发生或取得时间: item.occurredAt || item.capturedAt || item.receivedAt || item.createdAt,
    时间来源: item.timeSource,
    校验值: item.actualSha256 || item.expectedSha256 || "",
    说明: item.syntheticDisclosure || item.failureCode || ""
  }))
  const evidenceLinkRows = evidenceLinks.map(item => {
    const target = isObject(item.target) ? item.target : {}
    return {
      原件: evidenceNames.get(item.evidenceId) || item.evidenceId,
      关联对象: `${displayText(target.type)}:${displayText(target.id)}`,
      关系: item.relationKind,
      空间: spaceNames.get(item.spaceId) || item.spaceId || "",
      阶段: item.stageId,
      状态: item.status,
      说明: item.note
    }
  })
  const recordRows = records.map(item => ({
    标题: item.title,
    说明: item.note,
    房间: item.room,
    工序: item.stage,
    记录人: item.creatorName,
    发生时间: item.occurredAt,
    版本: item.version,
    附件数: Array.isArray(item.attachments) ? item.attachments.length : 0
  }))
  const revisionRows = revisions.map(item => ({
    记录ID: item.recordId,
    版本: item.version,
    标题: item.title,
    说明: item.note,
    修改原因: item.changeReason,
    时间: item.createdAt
  }))
  const issueRows = issues.map(item => ({
    标题: item.title,
    说明: item.description,
    房间: item.room,
    工序: item.stage,
    状态: item.status,
    预案数: Array.isArray(item.proposals) ? item.proposals.length : 0
  }))
  const workflowRows = workflows.map(item => ({
    问题: item.title,
    状态: item.status,
    版本: item.version,
    预案: objectList(item.proposals).map(proposal => `[${displayText(proposal.status)}] ${displayText(proposal.content)}`).join("\n"),
    整改提交: objectList(item.treatments).map(treatment => displayText(treatment.note)).join("\n"),
    复查: objectList(item.reviews).map(review => `[${displayText(review.decision)}] ${displayText(review.note)}`).join("\n")
  }))
  const materialRows = materials.map(item => ({
    名称: item.name,
    规格: item.specification,
    计划数量: item.plannedQuantity,
    单位: item.unit,
    参考单价: fenDisplay(item.unitPriceFen)
  }))
  const procurementRows = [
    ...purchases.map(item => ({
      类型: "采购行",
      材料ID: item.materialId,
      数量: typeof item.orderedQuantityMilli === "number" ? item.orderedQuantityMilli / 1000 : "",
      单位: item.unit,
      状态: item.status,
      时间: item.createdAt
    })),
    ...receipts.map(item => ({
      类型: "到货批次",
      材料ID: item.materialId,
      数量: objectList(item.quantityEvents).at(-1)?.quantityMilli === undefined
        ? "未登记" : Number(objectList(item.quantityEvents).at(-1)?.quantityMilli) / 1000,
      单位: item.unit,
      状态: `${objectList(item.allocationEvents).length} 次分配`,
      时间: item.occurredAt
    }))
  ]
  const agreementRows = agreements.flatMap(aggregate => {
    if (!isObject(aggregate.agreement)) return []
    const agreement = aggregate.agreement
    const versions = objectList(aggregate.versions)
    return versions.length ? versions.map(version => ({
      标题: agreement.title,
      版本: version.revision,
      状态: version.status,
      条目: objectList(version.terms).map(term => `${displayText(term.label)}：${displayText(term.value)}`).join("\n"),
      来源记录ID: stringList(version.sourceIds)
    })) : [{ 标题: agreement.title, 版本: "", 状态: "暂无版本", 条目: "", 来源记录ID: "" }]
  })
  const costTitles = new Map(costs.map(item => [item.id, displayText(item.title, "未命名费用")]))
  const financeRows = [
    ...costs.map(item => ({ 类型: "报价", 费用: item.title, 状态或动作: item.category, 金额: fenDisplay(item.quotedAmountFen), 说明: item.note, 时间: item.createdAt })),
    ...approvals.map(item => ({ 类型: "批准", 费用: costTitles.get(item.costItemId) || item.costItemId, 状态或动作: item.action, 金额: fenDisplay(item.amountFen), 说明: item.reason, 时间: item.createdAt })),
    ...payments.map(item => ({ 类型: "付款", 费用: costTitles.get(item.costItemId) || item.costItemId, 状态或动作: item.status, 金额: fenDisplay(item.amountFen), 说明: "", 时间: item.occurredAt })),
    ...refunds.map(item => ({ 类型: "退款", 费用: costTitles.get(item.costItemId) || item.costItemId, 状态或动作: item.status, 金额: fenDisplay(item.amountFen), 说明: `原付款 ${displayText(item.paymentId)}`, 时间: item.occurredAt }))
  ]
  const consultationRows = consultations.flatMap(consultation => {
    const versions = objectList(consultation.versions)
    return versions.length ? versions.map(version => ({
      标题: consultation.title,
      咨询状态: consultation.status,
      版本: version.revision,
      版本状态: version.status,
      问题原文: version.question,
      已知事实: stringList(version.knownFacts),
      信息缺口: stringList(version.gaps),
      希望回答: stringList(version.answerQuestions)
    })) : [{ 标题: consultation.title, 咨询状态: consultation.status, 版本: "", 版本状态: "", 问题原文: "", 已知事实: "", 信息缺口: "", 希望回答: "" }]
  })
  const responseRows = responses.map(item => ({
    回复人: item.respondentName,
    来源: item.source === "manual_relay" ? "人工转述" : "成员本人填写",
    渠道: item.channel,
    对方原话: item.originalText,
    摘要: item.summary,
    处理状态: item.status,
    收到时间: item.receivedAt
  }))
  const materialCheckRows = materialChecks.flatMap(check => {
    const review = isObject(check.review) ? check.review : {}
    return objectList(review.fields).map(field => ({
      材料ID: check.materialId,
      到货批次ID: check.receiptBatchId,
      字段: field.key,
      人工观察值: field.observedValue,
      人工期望值: field.expectedValue,
      人工状态: field.status,
      复核说明: field.note,
      模型及版本: `${displayText(check.model)} / ${displayText(check.promptVersion)}`,
      确认时间: check.confirmedAt
    }))
  })
  const budgetEstimateRows = budgetEstimates.flatMap(application =>
    objectList(application.scenarios).map(scenario => {
      const total = isObject(scenario.totalRequirement) ? scenario.totalRequirement : {}
      const gap = isObject(scenario.resourceGap) ? scenario.resourceGap : {}
      const purchase = isObject(scenario.recommendedPurchase) ? scenario.recommendedPurchase : {}
      return {
        方案: scenario.label,
        材料ID: scenario.materialId,
        总需求: typeof total.quantityWithWasteMilli === "number"
          ? `${Number(total.quantityWithWasteMilli) / 1000} ${displayText(scenario.unit)}` : "",
        资源缺口: typeof gap.minimumGapMilli === "number" && typeof gap.maximumGapMilli === "number"
          ? `${Number(gap.minimumGapMilli) / 1000}–${Number(gap.maximumGapMilli) / 1000} ${displayText(scenario.unit)}` : "未形成",
        建议采购: typeof purchase.purchaseQuantityMilli === "number"
          ? `${Number(purchase.purchaseQuantityMilli) / 1000} ${displayText(scenario.unit)}` : "未形成",
        金额: fenDisplay(purchase.amountFen),
        人工说明: scenario.note,
        确认时间: application.appliedAt
      }
    }))
  const projectSummaryRows = projectSummaries.flatMap(application => {
    const scope = isObject(application.scope) ? application.scope : {}
    const review = isObject(application.review) ? application.review : {}
    const handoff = objectList(review.handoff)
      .filter(item => item.included !== false)
      .map(item => `[${displayText(item.status)}] ${displayText(item.text)}`).join("\n")
    return objectList(review.sections)
      .filter(section => section.included !== false)
      .map(section => ({
        报告标题: review.title,
        范围: review.scopeStatement,
        工序和房间: `${displayText(scope.stage)} · ${displayText(scope.room)}`,
        日期: scope.dateFrom || scope.dateTo
          ? `${displayText(scope.dateFrom)} 至 ${displayText(scope.dateTo)}` : "不限日期",
        截止时间: scope.cutoffAt,
        分区: section.title,
        人工复核内容: section.content,
        交接清单: handoff,
        复核说明: review.note,
        确认人: application.appliedBy,
        确认时间: application.appliedAt
      }))
  })
  const reportLinks = Object.entries(pkg.reports).map(([name, content]) =>
    `<a download="${escapeHtml(name)}" href="data:text/csv;charset=utf-8,${encodeURIComponent(content)}">下载 ${escapeHtml(name)}</a>`).join("")
  const attachments = pkg.files.map(file => {
    const mime = attachmentMime(file)
    const href = `data:${mime};base64,${file.contentBase64}`
    const preview = mime.startsWith("image/")
      ? `<img src="${href}" alt="${escapeHtml(file.displayName)}">`
      : ""
    const references = [...new Set(file.references.map(reference => attachmentReferenceLabel(reference, pkg.data)))]
    return `<article>${preview}<a download="${escapeHtml(file.displayName)}" href="${href}">${escapeHtml(file.displayName)}</a><small>${file.byteLength} 字节 · SHA-256 ${escapeHtml(file.sha256)}<br>关联：${escapeHtml(references.join("；") || "未标明")}</small></article>`
  }).join("") || '<p class="empty">无附件</p>'
  const missing = pkg.missingFiles.map(file => {
    const references = [...new Set(file.references.map(reference => attachmentReferenceLabel(reference, pkg.data)))]
    return `<li>${escapeHtml(file.displayName)}（${escapeHtml(file.reason)}；关联：${escapeHtml(references.join("；") || "未标明")}）</li>`
  }).join("")
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pkg.manifest.projectName)}资料</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#20251f;max-width:1100px;margin:auto;padding:24px;background:#f5f2e9}h1,h2{line-height:1.25}section,article{background:#fff;border:1px solid #ddd7ca;border-radius:12px;padding:16px;margin:14px 0}table{border-collapse:collapse;width:100%;overflow:auto;display:block}th,td{border:1px solid #ddd;padding:8px;min-width:100px;text-align:left;vertical-align:top;white-space:pre-wrap}a{display:block;color:#176b5b;margin:8px 0;overflow-wrap:anywhere}img{display:block;max-width:100%;max-height:480px;margin-bottom:10px}small,.meta,.empty{color:#676b64}.warn{color:#9e3f2b}</style></head><body><h1>${escapeHtml(pkg.manifest.projectName)}</h1><p class="meta">生成时间 ${escapeHtml(pkg.manifest.createdAt)} · ${pkg.manifest.purpose === "full_backup" ? "完整项目备份阅读页" : "限定范围阅读页"} · ${pkg.manifest.status === "complete" ? "资料完整" : "资料不完整"}</p><p class="warn">这是生成时的离线副本，外发后无法远程撤回。校验值只能发现文件与本清单不一致，不证明拍摄真实性。</p>${optionalHtmlSection("空间", spaceRows, ["空间", "类型", "状态", "是否参与拓扑", "排序"])}${optionalHtmlSection("空间关系", relationRows, ["起点", "终点", "关系", "方向提示", "状态"])}${optionalHtmlSection("空间 × 阶段进度", stageStateRows, ["空间", "阶段", "状态", "依据原件", "说明", "更新时间"])}${optionalHtmlSection("证据原件清单", evidenceRows, ["原件", "类型", "来源", "状态", "发生或取得时间", "时间来源", "校验值", "说明"])}${optionalHtmlSection("证据业务关联", evidenceLinkRows, ["原件", "关联对象", "关系", "空间", "阶段", "状态", "说明"])}<section><h2>现场记录</h2>${tableRows(recordRows, ["标题", "说明", "房间", "工序", "记录人", "发生时间", "版本", "附件数"])}</section>${optionalHtmlSection("记录版本历史", revisionRows, ["记录ID", "版本", "标题", "说明", "修改原因", "时间"])}<section><h2>问题事项</h2>${tableRows(issueRows, ["标题", "说明", "房间", "工序", "状态", "预案数"])}</section>${optionalHtmlSection("问题处理历史", workflowRows, ["问题", "状态", "版本", "预案", "整改提交", "复查"])}${optionalHtmlSection("材料", materialRows, ["名称", "规格", "计划数量", "单位", "参考单价"])}${optionalHtmlSection("采购与到货", procurementRows, ["类型", "材料ID", "数量", "单位", "状态", "时间"])}${optionalHtmlSection("材料到货核对", materialCheckRows, ["材料ID", "到货批次ID", "字段", "人工观察值", "人工期望值", "人工状态", "复核说明", "模型及版本", "确认时间"])}${optionalHtmlSection("AI 预算估算版本", budgetEstimateRows, ["方案", "材料ID", "总需求", "资源缺口", "建议采购", "金额", "人工说明", "确认时间"])}${optionalHtmlSection("负责人确认的项目总结", projectSummaryRows, ["报告标题", "范围", "工序和房间", "日期", "截止时间", "分区", "人工复核内容", "交接清单", "复核说明", "确认人", "确认时间"])}${optionalHtmlSection("约定及版本", agreementRows, ["标题", "版本", "状态", "条目", "来源记录ID"])}${optionalHtmlSection("费用、批准、付款与退款", financeRows, ["类型", "费用", "状态或动作", "金额", "说明", "时间"])}${optionalHtmlSection("对外咨询版本", consultationRows, ["标题", "咨询状态", "版本", "版本状态", "问题原文", "已知事实", "信息缺口", "希望回答"])}${optionalHtmlSection("咨询回复", responseRows, ["回复人", "来源", "渠道", "对方原话", "摘要", "处理状态", "收到时间"])}<section><h2>可下载表格</h2>${reportLinks}</section><section><h2>原件</h2>${attachments}</section>${missing ? `<section><h2>缺失文件</h2><ul>${missing}</ul></section>` : ""}</body></html>`
}

export function portablePackageSummary(pkg: PortablePackage): {
  projectName: string
  purposeLabel: string
  statusLabel: string
  fileCount: number
  missingCount: number
  totalBytes: number
  recordCount: number
  issueCount: number
  restorable: boolean
} {
  return {
    projectName: pkg.manifest.projectName,
    purposeLabel: pkg.manifest.purpose === "full_backup" ? "完整项目备份" : "限定阅读资料",
    statusLabel: pkg.manifest.status === "complete" ? "完整" : "部分完成",
    fileCount: pkg.files.length,
    missingCount: pkg.missingFiles.length,
    totalBytes: pkg.manifest.totalBytes,
    recordCount: arrayFrom(pkg.data, "records").length,
    issueCount: arrayFrom(pkg.data, "issues").length,
    restorable: pkg.manifest.restorable
  }
}
