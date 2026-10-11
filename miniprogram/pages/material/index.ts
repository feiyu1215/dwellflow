import { inventoryBalanceMilli, receiptSummary } from "../../core/material-flow"
import { formatQuantityMilli } from "../../core/precision"
import { purchaseLineSummary } from "../../core/procurement"
import {
  allocateMaterialReceipt,
  approveMaterialAgreement,
  createMaterialAgreement,
  createMaterialPurchase,
  createMaterialReceipt,
  decideMaterialReceiptFromCheck,
  loadState,
  recordMaterialInventory,
  saveManualMaterialCheckRecord,
  submitMaterialAgreement
} from "../../core/store"
import { formatTime } from "../../core/view"
import { parseOriginContext, type OriginContext } from "../../core/project-navigation"
import { resolvePatrolEntryContext } from "../../core/patrol-handoff"

const AGREEMENT_STATUS: Record<string, string> = {
  draft: "草稿",
  pending_confirmation: "待负责人确认",
  active: "已生效",
  rejected: "已拒绝",
  withdrawn: "已撤回",
  superseded: "已被新版本替代"
}

const RECEIPT_STATUS: Record<string, string> = {
  draft: "待补数量",
  pending_review: "待核对",
  awaiting_return: "待完成退货",
  resolved: "已处理"
}

const PURCHASE_STATUS: Record<string, string> = {
  cancelled: "已取消",
  not_received: "未到货",
  partial: "部分到货",
  received: "已到齐",
  over_received: "超额到货"
}

const CHECK_STATUS: Record<string, string> = {
  matches: "一致（人工复核）",
  differs: "有差异",
  observed_only: "只有现场观察",
  expected_only: "只有期望基线",
  unknown: "未知"
}

const ALLOCATION_ACTIONS = [
  { value: "accepted_available", label: "负责人确认可用入库" },
  { value: "marked_return", label: "标记待退货" },
  { value: "completed_return", label: "登记已退供应商" }
] as const

const INVENTORY_ACTIONS = [
  { value: "issued", label: "领用出库" },
  { value: "warehouse_waste", label: "仓内损耗" },
  { value: "adjustment_increase", label: "盘点增加" },
  { value: "adjustment_decrease", label: "盘点减少" }
] as const

const message = (error: unknown) => error instanceof Error ? error.message : "操作失败"

type ManualCheckStatus = "matches" | "differs" | "observed_only" | "expected_only" | "unknown"

const fieldStatus = (observedValue: string, expectedValue: string): ManualCheckStatus => {
  const observed = observedValue.trim()
  const expected = expectedValue.trim()
  if (observed && expected) return observed.toLocaleLowerCase() === expected.toLocaleLowerCase() ? "matches" : "differs"
  if (observed) return "observed_only"
  if (expected) return "expected_only"
  return "unknown"
}

const statusLabel = (status: string) => ({
  matches: "相符", differs: "不一致", observed_only: "仅现场值",
  expected_only: "仅批准值", unknown: "未知"
}[status] || status)

Page({
  data: {
    materialId: "",
    projectId: "",
    projectName: "",
    readOnly: false,
    material: null as null | {
      id: string
      name: string
      specification: string
      unit: string
      plannedQuantity: number
    },
    overview: {
      available: "0",
      ordered: "0",
      pendingReview: "0",
      pendingReturn: "0"
    },
    nextAction: "",
    focusReceipt: null as null | {
      id: string
      title: string
      statusLabel: string
      baselineLabel: string
      baselineTerms: string
      evidenceLabel: string
      evidenceId: string
      evidencePath: string
      fieldSummary: string
      fieldRows: Array<{
        key: string
        label: string
        expectedValue: string
        observedValue: string
        statusLabel: string
        tone: "neutral" | "match" | "warning"
      }>
      checkId: string
      canDecide: boolean
      unresolved: string
    },
    agreements: [] as Array<{
      id: string
      versionId: string
      title: string
      revision: number
      status: string
      statusLabel: string
      terms: string
      canSubmit: boolean
      canApprove: boolean
    }>,
    purchases: [] as Array<{
      id: string
      title: string
      statusLabel: string
      progress: string
      pending: string
      agreementLabel: string
    }>,
    receipts: [] as Array<{
      id: string
      title: string
      statusLabel: string
      detail: string
      unresolved: string
      pendingReturn: string
      canAllocate: boolean
      canAiCheck: boolean
      checkId: string
      hasCheck: boolean
    }>,
    checks: [] as Array<{
      id: string
      title: string
      meta: string
      summary: string
      fieldLines: string[]
      differenceCount: number
    }>,
    showForm: "" as "" | "agreement" | "purchase" | "receipt" | "allocation" | "inventory" | "manual-check",
    agreementTitle: "",
    agreementSpecification: "",
    agreementQuantity: "",
    agreementNote: "",
    agreementSource: "",
    purchaseQuantity: "",
    receiptPurchaseIndex: 0,
    receiptQuantity: "",
    selectedBatchId: "",
    selectedCheckId: "",
    requestedBatchId: "",
    showLedger: false,
    allocationActionIndex: 0,
    allocationQuantity: "",
    allocationActions: ALLOCATION_ACTIONS,
    inventoryActionIndex: 0,
    inventoryQuantity: "",
    inventoryReason: "",
    inventoryActions: INVENTORY_ACTIONS,
    manualReceiptTitle: "",
    manualAgreementVersionId: "",
    manualBaselineLabel: "无批准基线",
    manualEvidenceLines: [] as string[],
    manualSummary: "",
    manualRequestId: "",
    hasManualConflict: false,
    manualFields: [] as Array<{
      key: "brand" | "model" | "specification" | "quantity"
      label: string
      expectedValue: string
      observedValue: string
      status: "matches" | "differs" | "observed_only" | "expected_only" | "unknown"
      statusLabel: string
      note: string
      conflict: boolean
    }>,
    originLabel: "",
    returnLabel: "‹ 材料费用"
  },
  originContext: undefined as OriginContext | undefined,
  onLoad(options: Record<string, string | undefined>) {
    this.originContext = options.origin ? parseOriginContext(options.origin) : undefined
    this.setData({ materialId: options.id || "", requestedBatchId: options.batchId || "" })
  },
  onShow() {
    this.refresh()
  },
  noop() {},
  refresh() {
    const state = loadState()
    const material = state.materials.find(item =>
      item.id === this.data.materialId && item.projectId === state.currentProjectId)
    if (!material) {
      this.setData({ material: null, projectId: "", projectName: "" })
      return
    }
    const project = state.projects.find(item => item.id === material.projectId)
    const entry = project ? resolvePatrolEntryContext({
      context: this.originContext,
      projectId: project.id,
      currentStage: project.stage,
      spaces: state.spaces
    }) : undefined
    const agreements = state.agreements
      .filter(item => item.agreement.projectId === material.projectId
        && item.agreement.subjectId === material.id)
      .map(item => {
        const version = item.versions.find(candidate =>
          candidate.id === item.agreement.activeVersionId) || item.versions.at(-1)!
        return {
          id: item.agreement.id,
          versionId: version.id,
          title: item.agreement.title,
          revision: version.revision,
          status: version.status,
          statusLabel: AGREEMENT_STATUS[version.status],
          terms: version.terms.map(term => `${term.label}：${term.value}`).join(" · "),
          canSubmit: version.status === "draft",
          canApprove: version.status === "pending_confirmation"
        }
      })
    const materialLines = state.purchaseLines.filter(item =>
      item.projectId === material.projectId && item.materialId === material.id)
    const purchases = materialLines.map((line, index) => {
      const summary = purchaseLineSummary(
        line,
        state.receiptBatches,
        state.unitConversions
      )
      return {
        id: line.id,
        title: `采购 ${index + 1} · ${formatQuantityMilli(line.orderedQuantityMilli)} ${line.unit}`,
        statusLabel: PURCHASE_STATUS[summary.status],
        progress: `净实到 ${formatQuantityMilli(summary.netReceivedMilli)}，可用 ${formatQuantityMilli(summary.acceptedAvailableMilli)}，待到 ${formatQuantityMilli(summary.remainingToReceiveMilli)} ${line.unit}`,
        pending: `待核对 ${formatQuantityMilli(summary.pendingReviewMilli)} · 待退 ${formatQuantityMilli(summary.pendingReturnMilli)} ${line.unit}`,
        agreementLabel: line.agreementVersionId ? "已绑定生效约定" : "下单时无生效约定"
      }
    })
    const materialBatches = state.receiptBatches.filter(item =>
      item.projectId === material.projectId && item.materialId === material.id)
    const receipts = materialBatches.map((batch, index) => {
      const summary = receiptSummary(batch)
      const check = state.materialChecks.find(item => item.receiptBatchId === batch.id
        && item.sourceSnapshots?.some(source => source.sourceId === batch.id
          && source.kind === "receipt" && source.version === `${batch.version}`))
      const received = summary.receivedMilli === undefined
        ? "未知"
        : formatQuantityMilli(summary.receivedMilli)
      return {
        id: batch.id,
        title: `到货批次 ${materialBatches.length - index}`,
        statusLabel: RECEIPT_STATUS[summary.status],
        detail: `实到 ${received} ${batch.unit} · ${formatTime(batch.occurredAt)}`,
        unresolved: formatQuantityMilli(summary.unresolvedMilli || 0),
        pendingReturn: formatQuantityMilli(summary.pendingReturnMilli),
        canAllocate: summary.status !== "resolved",
        canAiCheck: (summary.unresolvedMilli || 0) > 0,
        checkId: check?.id || "",
        hasCheck: Boolean(check)
      }
    })
    const requestedBatch = materialBatches.find(batch => batch.id === this.data.requestedBatchId)
    const focusBatch = requestedBatch || materialBatches.find(batch => (receiptSummary(batch).unresolvedMilli || 0) > 0)
    let focusReceipt: typeof this.data.focusReceipt = null
    if (focusBatch) {
      const batchIndex = materialBatches.findIndex(batch => batch.id === focusBatch.id)
      const purchase = state.purchaseLines.find(item => item.id === focusBatch.purchaseLineId)
      const aggregate = state.agreements.find(item => item.versions.some(version => version.id === purchase?.agreementVersionId))
        || state.agreements.find(item => item.agreement.projectId === material.projectId
          && item.agreement.subject === "material" && item.agreement.subjectId === material.id)
      const baseline = aggregate?.versions.find(item => item.id === purchase?.agreementVersionId)
        || aggregate?.versions.find(item => item.id === aggregate.agreement.activeVersionId)
      const linkedEvidenceIds = state.evidenceLinks.filter(link => link.projectId === material.projectId
        && link.status === "active"
        && ((link.target.type === "receipt_batch" && link.target.id === focusBatch.id)
          || (link.target.type === "material" && link.target.id === material.id)))
        .map(link => link.evidenceId)
      const evidence = state.evidenceAssets.find(asset => linkedEvidenceIds.includes(asset.id))
      const latestCheck = state.materialChecks.find(item => item.receiptBatchId === focusBatch.id
        && item.sourceSnapshots?.some(source => source.sourceId === focusBatch.id
          && source.kind === "receipt" && source.version === `${focusBatch.version}`))
      const conflicts = latestCheck?.review.fields.filter(field => field.status === "differs").length || 0
      const termMap = new Map((baseline?.terms || []).map(term => [term.key, term.value]))
      const received = receiptSummary(focusBatch).receivedMilli
      const latestFields = new Map((latestCheck?.review.fields || []).map(field => [field.key, field]))
      const fieldLabels = { brand: "品牌", model: "型号", specification: "规格", quantity: "数量" } as const
      const fieldRows = (Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).map(key => {
        const checked = latestFields.get(key)
        const expectedValue = checked?.expectedValue || termMap.get(key) || "未约定"
        const observedValue = checked?.observedValue
          || (key === "quantity" && received !== undefined ? `${formatQuantityMilli(received)} ${focusBatch.unit}` : "待观察")
        const status = checked?.status
        return {
          key,
          label: fieldLabels[key],
          expectedValue,
          observedValue,
          statusLabel: status ? (CHECK_STATUS[status] || status) : "待核对",
          tone: status === "matches" ? "match" as const
            : status === "differs" || status === "observed_only" || status === "expected_only" ? "warning" as const
              : "neutral" as const
        }
      })
      focusReceipt = {
        id: focusBatch.id,
        title: `到货批次 ${materialBatches.length - batchIndex}`,
        statusLabel: latestCheck ? "已有核对记录 · 未入库" : "等待核对",
        baselineLabel: baseline ? `${aggregate?.agreement.title || "材料约定"} · v${baseline.revision}` : "缺少批准基线",
        baselineTerms: baseline?.terms.map(term => `${term.label} ${term.value}`).join(" · ") || "只能记录现场观察，不能判断相符",
        evidenceLabel: evidence ? `${evidence.fileName} · ${evidence.status === "ready" ? "原件可用" : "原件" + evidence.status}` : "尚无关联原件，可继续人工记录",
        evidenceId: evidence?.id || "",
        evidencePath: evidence?.status === "ready" && evidence.storageRef?.kind === "local_file" ? evidence.storageRef.localPath : "",
        fieldSummary: latestCheck
          ? `${latestCheck.review.fields.length - conflicts} 项无已确认差异 · ${conflicts} 项不一致`
          : "品牌、型号、规格、数量待逐项核对",
        fieldRows,
        checkId: latestCheck?.id || "",
        canDecide: Boolean(latestCheck && (receiptSummary(focusBatch).unresolvedMilli || 0) > 0),
        unresolved: formatQuantityMilli(receiptSummary(focusBatch).unresolvedMilli || 0)
      }
    }
    const checks = state.materialChecks
      .filter(item => item.projectId === material.projectId && item.materialId === material.id)
      .map(item => {
        const batchIndex = materialBatches.findIndex(batch => batch.id === item.receiptBatchId)
        const originalByKey = new Map(item.originalResult.fields.map(field => [field.key, field]))
        return {
          id: item.id,
          title: batchIndex >= 0 ? `到货批次 ${materialBatches.length - batchIndex} · 人工已复核` : "历史到货核对",
          meta: item.method === "manual"
            ? `${formatTime(item.confirmedAt)} · 人工核对`
            : `${formatTime(item.confirmedAt)} · ${item.model} · Prompt ${item.promptVersion}`,
          summary: item.summary,
          fieldLines: item.review.fields.map(field => {
            const label = originalByKey.get(field.key)?.label || field.key
            const observed = field.observedValue || "未确认"
            const expected = field.expectedValue || "无正式基线"
            return `${label}：现场 ${observed} / 期望 ${expected} · ${CHECK_STATUS[field.status] || field.status}`
          }),
          differenceCount: item.review.fields.filter(field => field.status === "differs").length
        }
      })
    const pendingReviewMilli = materialBatches.reduce(
      (sum, batch) => sum + (receiptSummary(batch).unresolvedMilli || 0),
      0
    )
    const pendingReturnMilli = materialBatches.reduce(
      (sum, batch) => sum + receiptSummary(batch).pendingReturnMilli,
      0
    )
    const orderedMilli = materialLines
      .filter(item => item.status === "ordered")
      .reduce((sum, item) => sum + item.orderedQuantityMilli, 0)
    const hasActiveAgreement = agreements.some(item => item.status === "active")
    const nextAction = pendingReviewMilli > 0
      ? "先处理待核对到货，明确可用、待退或仍未知的数量"
      : pendingReturnMilli > 0
        ? "完成供应商退货并保留实际退货记录"
        : !hasActiveAgreement
          ? "建立材料约定并由负责人批准生效"
          : !materialLines.length
            ? "登记采购数量，后续到货将绑定当前约定版本"
            : "可继续登记到货，或记录领用、损耗与盘点"
    this.setData({
      projectId: material.projectId,
      projectName: project?.name || "当前项目",
      originLabel: entry?.label || "",
      returnLabel: entry?.accepted ? "‹ 返回巡场" : "‹ 材料费用",
      readOnly: state.projects.find(item => item.id === material.projectId)?.status === "archived",
      material: {
        id: material.id,
        name: material.name,
        specification: material.specification,
        unit: material.unit,
        plannedQuantity: material.plannedQuantity
      },
      agreements,
      purchases,
      receipts,
      checks,
      focusReceipt,
      nextAction,
      overview: {
        available: formatQuantityMilli(inventoryBalanceMilli(
          state.materialInventoryEvents,
          material.id
        )),
        ordered: formatQuantityMilli(orderedMilli),
        pendingReview: formatQuantityMilli(pendingReviewMilli),
        pendingReturn: formatQuantityMilli(pendingReturnMilli)
      }
    })
  },
  closeForm() {
    this.setData({ showForm: "", selectedBatchId: "", selectedCheckId: "" })
  },
  toggleLedger() { this.setData({ showLedger: !this.data.showLedger }) },
  returnToLedger() {
    wx.navigateBack({
      fail: () => wx.redirectTo({
        url: this.originContext?.originView === "patrol"
          ? "/pages/dashboard/index"
          : "/pages/ledger/index"
      })
    })
  },
  openAgreement() {
    const material = this.data.material
    if (!material) return
    this.setData({
      showForm: "agreement",
      agreementTitle: `${material.name}约定`,
      agreementSpecification: material.specification,
      agreementQuantity: material.plannedQuantity ? String(material.plannedQuantity) : ""
    })
  },
  openPurchase() {
    this.setData({ showForm: "purchase" })
  },
  openReceipt() {
    if (!this.data.purchases.length) {
      return wx.showToast({ title: "请先登记采购数量", icon: "none" })
    }
    this.setData({ showForm: "receipt", receiptPurchaseIndex: 0 })
  },
  openAllocation(e: WechatMiniprogram.TouchEvent) {
    const unresolved = e.currentTarget.dataset.unresolved as string
    const pendingReturn = e.currentTarget.dataset.pendingReturn as string
    const hasUnresolved = Number(unresolved) > 0
    this.setData({
      showForm: "allocation",
      selectedBatchId: e.currentTarget.dataset.id as string,
      selectedCheckId: (e.currentTarget.dataset.checkId as string) || "",
      allocationActionIndex: hasUnresolved ? 0 : 2,
      allocationQuantity: hasUnresolved ? unresolved : pendingReturn
    })
  },
  openAiCheck(e: WechatMiniprogram.TouchEvent) {
    const material = this.data.material
    const receiptId = e.currentTarget.dataset.id as string
    if (!material || !receiptId || this.data.readOnly) return
    wx.navigateTo({
      url: "/pages/ai/index?task=material_check&materialId="
        + encodeURIComponent(material.id)
        + "&receiptId=" + encodeURIComponent(receiptId)
    })
  },
  openFocusEvidence() {
    if (!this.data.focusReceipt?.evidenceId) return
    wx.navigateTo({ url: `/pages/evidence-viewer/index?evidenceId=${encodeURIComponent(this.data.focusReceipt.evidenceId)}` })
  },
  openManualCheck(e: WechatMiniprogram.TouchEvent) {
    const state = loadState()
    const material = state.materials.find(item => item.id === this.data.materialId && item.projectId === state.currentProjectId)
    const receiptId = e.currentTarget.dataset.id as string
    const receipt = state.receiptBatches.find(item => item.id === receiptId && item.materialId === material?.id)
    if (!material || !receipt || this.data.readOnly) return
    const purchase = state.purchaseLines.find(item => item.id === receipt.purchaseLineId)
    const aggregate = state.agreements.find(item => item.versions.some(version => version.id === purchase?.agreementVersionId))
      || state.agreements.find(item => item.agreement.projectId === material.projectId
        && item.agreement.subject === "material" && item.agreement.subjectId === material.id)
    const agreementVersion = aggregate?.versions.find(item => item.id === purchase?.agreementVersionId)
      || aggregate?.versions.find(item => item.id === aggregate.agreement.activeVersionId)
    const termMap = new Map((agreementVersion?.terms || []).map(term => [term.key, term.value]))
    const received = receiptSummary(receipt).receivedMilli
    const expected: Record<string, string> = {
      brand: termMap.get("brand") || "",
      model: termMap.get("model") || "",
      specification: termMap.get("specification") || "",
      quantity: termMap.get("quantity") || ""
    }
    const observed: Record<string, string> = {
      brand: "", model: "", specification: "",
      quantity: received === undefined ? "" : `${formatQuantityMilli(received)} ${receipt.unit}`
    }
    const labels = { brand: "品牌", model: "型号", specification: "规格", quantity: "数量" } as const
    const manualFields = (Object.keys(labels) as Array<keyof typeof labels>).map(key => {
      const status = fieldStatus(observed[key], expected[key])
      return { key, label: labels[key], expectedValue: expected[key], observedValue: observed[key],
        status, statusLabel: statusLabel(status), note: "", conflict: false }
    })
    const evidenceIds = state.evidenceLinks.filter(link => link.projectId === material.projectId
      && link.status === "active"
      && ((link.target.type === "receipt_batch" && link.target.id === receipt.id)
        || (link.target.type === "material" && link.target.id === material.id)))
      .map(link => link.evidenceId)
    const evidenceLines = state.evidenceAssets.filter(asset => evidenceIds.includes(asset.id))
      .map(asset => `${asset.fileName} · ${asset.status === "ready" ? "原件可用" : "原件" + asset.status}`)
    const batchIndex = state.receiptBatches.filter(item => item.materialId === material.id).findIndex(item => item.id === receipt.id)
    this.setData({
      showForm: "manual-check",
      selectedBatchId: receipt.id,
      manualReceiptTitle: `到货批次 ${batchIndex >= 0 ? batchIndex + 1 : ""}`,
      manualAgreementVersionId: agreementVersion?.id || "",
      manualBaselineLabel: agreementVersion
        ? `${aggregate?.agreement.title || "材料约定"} · v${agreementVersion.revision}` : "无批准基线：只能记录观察值",
      manualEvidenceLines: evidenceLines,
      manualSummary: "",
      manualRequestId: `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      hasManualConflict: false,
      manualFields
    })
  },
  onManualObserved(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index)
    const manualFields = this.data.manualFields.map((field, current) => {
      if (current !== index) return field
      const observedValue = e.detail.value
      const status = fieldStatus(observedValue, field.expectedValue)
      return { ...field, observedValue, status, statusLabel: statusLabel(status) }
    })
    this.setData({ manualFields })
  },
  onManualNote(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ manualFields: this.data.manualFields.map((field, current) =>
      current === index ? { ...field, note: e.detail.value } : field) })
  },
  onManualConflict(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    const manualFields = this.data.manualFields.map((field, current) =>
      current === index ? { ...field, conflict: !field.conflict } : field)
    this.setData({ manualFields, hasManualConflict: manualFields.some(field => field.conflict) })
  },
  onManualSummary(e: WechatMiniprogram.TextareaInput) {
    this.setData({ manualSummary: e.detail.value })
  },
  submitManualCheck() {
    if (this.data.manualFields.some(field => field.conflict)) {
      return wx.showToast({ title: "仍有来源冲突，请先确认采用值", icon: "none" })
    }
    try {
      saveManualMaterialCheckRecord({
        requestId: this.data.manualRequestId,
        projectId: loadState().currentProjectId,
        materialId: this.data.materialId,
        receiptBatchId: this.data.selectedBatchId,
        agreementVersionId: this.data.manualAgreementVersionId || undefined,
        summary: this.data.manualSummary,
        fields: this.data.manualFields.map(field => ({
          key: field.key, observedValue: field.observedValue.trim(), expectedValue: field.expectedValue,
          status: field.status, note: field.note.trim()
        }))
      })
      this.setData({ showForm: "", selectedBatchId: "", manualFields: [], manualSummary: "", manualRequestId: "", hasManualConflict: false })
      this.refresh()
      wx.showToast({ title: "人工核对记录已保存" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  openInventory() {
    this.setData({ showForm: "inventory" })
  },
  onAgreementTitle(e: WechatMiniprogram.Input) {
    this.setData({ agreementTitle: e.detail.value })
  },
  onAgreementSpecification(e: WechatMiniprogram.Input) {
    this.setData({ agreementSpecification: e.detail.value })
  },
  onAgreementQuantity(e: WechatMiniprogram.Input) {
    this.setData({ agreementQuantity: e.detail.value })
  },
  onAgreementNote(e: WechatMiniprogram.TextareaInput) {
    this.setData({ agreementNote: e.detail.value })
  },
  onAgreementSource(e: WechatMiniprogram.Input) {
    this.setData({ agreementSource: e.detail.value })
  },
  onPurchaseQuantity(e: WechatMiniprogram.Input) {
    this.setData({ purchaseQuantity: e.detail.value })
  },
  onReceiptPurchase(e: WechatMiniprogram.PickerChange) {
    this.setData({ receiptPurchaseIndex: Number(e.detail.value) })
  },
  onReceiptQuantity(e: WechatMiniprogram.Input) {
    this.setData({ receiptQuantity: e.detail.value })
  },
  onAllocationAction(e: WechatMiniprogram.PickerChange) {
    this.setData({ allocationActionIndex: Number(e.detail.value) })
  },
  onAllocationQuantity(e: WechatMiniprogram.Input) {
    this.setData({ allocationQuantity: e.detail.value })
  },
  onInventoryAction(e: WechatMiniprogram.PickerChange) {
    this.setData({ inventoryActionIndex: Number(e.detail.value) })
  },
  onInventoryQuantity(e: WechatMiniprogram.Input) {
    this.setData({ inventoryQuantity: e.detail.value })
  },
  onInventoryReason(e: WechatMiniprogram.Input) {
    this.setData({ inventoryReason: e.detail.value })
  },
  submitAgreementDraft() {
    const material = this.data.material
    const title = this.data.agreementTitle.trim()
    const specification = this.data.agreementSpecification.trim()
    const quantity = this.data.agreementQuantity.trim()
    const note = this.data.agreementNote.trim()
    if (!material || !title || (!specification && !quantity && !note)) {
      return wx.showToast({ title: "请填写标题和至少一项约定", icon: "none" })
    }
    const terms = [
      specification ? { key: "specification", label: "品牌/型号/规格", value: specification } : null,
      quantity ? { key: "quantity", label: "约定数量", value: `${quantity} ${material.unit}` } : null,
      note ? { key: "note", label: "施工或验收要求", value: note } : null
    ].filter((item): item is { key: string; label: string; value: string } => Boolean(item))
    try {
      createMaterialAgreement({
        projectId: loadState().currentProjectId,
        materialId: material.id,
        title,
        terms,
        sourceLabel: this.data.agreementSource
      })
      this.setData({
        showForm: "",
        agreementTitle: "",
        agreementSpecification: "",
        agreementQuantity: "",
        agreementNote: "",
        agreementSource: ""
      })
      this.refresh()
      wx.showToast({ title: "约定草稿已保存" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  submitAgreement(e: WechatMiniprogram.TouchEvent) {
    try {
      submitMaterialAgreement(
        e.currentTarget.dataset.id as string,
        e.currentTarget.dataset.versionId as string
      )
      this.refresh()
      wx.showToast({ title: "已提交负责人确认" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  approveAgreement(e: WechatMiniprogram.TouchEvent) {
    try {
      approveMaterialAgreement(
        e.currentTarget.dataset.id as string,
        e.currentTarget.dataset.versionId as string
      )
      this.refresh()
      wx.showToast({ title: "约定已生效" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  submitPurchase() {
    const material = this.data.material
    if (!material) return
    try {
      createMaterialPurchase({
        projectId: loadState().currentProjectId,
        materialId: material.id,
        quantity: this.data.purchaseQuantity
      })
      this.setData({ showForm: "", purchaseQuantity: "" })
      this.refresh()
      wx.showToast({ title: "采购数量已登记" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  submitReceipt() {
    const purchase = this.data.purchases[this.data.receiptPurchaseIndex]
    if (!purchase) return
    try {
      createMaterialReceipt({
        projectId: loadState().currentProjectId,
        purchaseLineId: purchase.id,
        quantity: this.data.receiptQuantity
      })
      this.setData({ showForm: "", receiptQuantity: "" })
      this.refresh()
      wx.showToast({ title: "到货已登记，等待核对" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  submitAllocation() {
    const action = ALLOCATION_ACTIONS[this.data.allocationActionIndex]
    try {
      if ((action.value === "accepted_available" || action.value === "marked_return") && this.data.selectedCheckId) {
        decideMaterialReceiptFromCheck({
          batchId: this.data.selectedBatchId,
          checkId: this.data.selectedCheckId,
          kind: action.value,
          quantity: this.data.allocationQuantity
        })
      } else {
        allocateMaterialReceipt({
          batchId: this.data.selectedBatchId,
          kind: action.value,
          quantity: this.data.allocationQuantity
        })
      }
      this.setData({ showForm: "", selectedBatchId: "", selectedCheckId: "", allocationQuantity: "" })
      this.refresh()
      wx.showToast({
        title: action.value === "accepted_available" ? "已确认可用入库" : "到货状态已更新"
      })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  },
  submitInventory() {
    const material = this.data.material
    const action = INVENTORY_ACTIONS[this.data.inventoryActionIndex]
    if (!material) return
    try {
      recordMaterialInventory({
        projectId: loadState().currentProjectId,
        materialId: material.id,
        action: action.value,
        quantity: this.data.inventoryQuantity,
        reason: this.data.inventoryReason
      })
      this.setData({
        showForm: "",
        inventoryQuantity: "",
        inventoryReason: ""
      })
      this.refresh()
      wx.showToast({ title: "库存事实已保存" })
    } catch (error) {
      wx.showToast({ title: message(error), icon: "none" })
    }
  }
})
