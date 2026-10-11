import {
  materialEstimate,
  type BudgetEstimateApplication,
  type CostItem
} from "../../core/domain"
import { financeSummary } from "../../core/finance"
import { inventoryBalanceMilli, receiptSummary } from "../../core/material-flow"
import { formatQuantityMilli } from "../../core/precision"
import {
  addLocalCostApproval,
  createCostItem,
  createMaterial,
  currentProject,
  decideLocalPayment,
  decideLocalRefund,
  loadState,
  setProjectTargetBudget,
  submitLocalPayment,
  submitLocalRefund
} from "../../core/store"
import { formatTime } from "../../core/view"

const CATEGORIES = [
  { value: "material", label: "材料" },
  { value: "labor", label: "人工" },
  { value: "transport", label: "运输" },
  { value: "other", label: "其他" }
] as const

const INITIAL_APPROVAL = [{ value: "initial", label: "初始批准" }] as const
const ADJUST_APPROVALS = [
  { value: "increase", label: "批准增加" },
  { value: "decrease", label: "批准减少" }
] as const

type ApprovalAction = "initial" | "increase" | "decrease"
type CostItemView = ReturnType<typeof toCostView>
type BudgetEstimateView = ReturnType<typeof toBudgetEstimateView>
const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败"

function toBudgetEstimateView(item: BudgetEstimateApplication) {
  return {
    id: item.id,
    timeLabel: formatTime(item.appliedAt),
    appliedBy: item.appliedBy,
    summary: item.summary || "负责人已采纳一版 AI 预算参数",
    financeLabel: item.financeSnapshots.length
      ? `同步留存 ${item.financeSnapshots.length} 项费用口径快照`
      : "本版本未选择费用账本资料",
    scenarios: item.scenarios.map(scenario => {
      const totalLabel = `含损耗需求 ${formatQuantityMilli(
        scenario.totalRequirement.quantityWithWasteMilli
      )} ${scenario.unit}`
      const gapLabel = scenario.resourceGap
        ? scenario.resourceGap.minimumGapMilli === scenario.resourceGap.maximumGapMilli
          ? `资源缺口 ${formatQuantityMilli(scenario.resourceGap.maximumGapMilli)} ${scenario.unit}`
          : `资源缺口 ${formatQuantityMilli(scenario.resourceGap.minimumGapMilli)}–${formatQuantityMilli(
            scenario.resourceGap.maximumGapMilli
          )} ${scenario.unit}`
        : scenario.materialId
          ? "资源数据或单位换算待补，暂不形成缺口"
          : "未关联现有材料，按总需求形成估算"
      const purchaseLabel = scenario.recommendedPurchase
        ? `建议补充 ${scenario.recommendedPurchase.packageCount} 包 · ${formatQuantityMilli(
          scenario.recommendedPurchase.purchaseQuantityMilli
        )} ${scenario.unit} · ${scenario.recommendedPurchase.amountFen === undefined
          ? "金额未知"
          : money(scenario.recommendedPurchase.amountFen)}`
        : "暂不形成采购数量或金额建议"
      return {
        scenarioId: scenario.scenarioId,
        label: scenario.label,
        totalLabel,
        gapLabel,
        purchaseLabel,
        warningLabel: scenario.resourceFacts?.warnings.join("；") || "",
        note: scenario.note
      }
    })
  }
}

function parseMoneyFen(raw: string, allowZero = false): number | undefined {
  const value = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined
  const [yuan, cents = ""] = value.split(".")
  const amount = Number(yuan) * 100 + Number(cents.padEnd(2, "0"))
  if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) return undefined
  return amount
}

function toCostView(item: CostItem, state: ReturnType<typeof loadState>) {
  const approvals = state.costApprovals.filter(event => event.costItemId === item.id)
  const payments = state.paymentFacts.filter(event => event.costItemId === item.id)
  const refunds = state.refundFacts.filter(event => event.costItemId === item.id)
  const summary = financeSummary(approvals, payments, refunds)
  const pendingCount = payments.filter(event => event.status === "pending_confirmation").length
    + refunds.filter(event => event.status === "pending_confirmation").length
  const statusLabel = pendingCount
    ? `${pendingCount} 笔待确认`
    : summary.overApprovedFen > 0
      ? "付款超出批准"
      : summary.approvedFen === 0
        ? "待负责人批准"
        : summary.outstandingFen === 0 && summary.netPaidFen > 0
          ? "已付清"
          : "进行中"
  return {
    id: item.id,
    title: item.title,
    note: item.note || "",
    categoryLabel: CATEGORIES.find(category => category.value === item.category)?.label || "其他",
    materialLabel: item.materialId
      ? state.materials.find(material => material.id === item.materialId)?.name || "关联材料已不存在"
      : "",
    quote: item.quotedAmountFen === undefined ? "未记录" : money(item.quotedAmountFen),
    approved: money(summary.approvedFen),
    paid: money(summary.paidFen),
    refunded: money(summary.refundedFen),
    netPaid: money(summary.netPaidFen),
    outstanding: money(summary.outstandingFen),
    overApproved: money(summary.overApprovedFen),
    pending: money(summary.pendingPaymentFen + summary.pendingRefundFen),
    pendingCount,
    approvalCount: approvals.length,
    statusLabel,
    statusClass: pendingCount || summary.overApprovedFen > 0
      ? "pill pill-amber"
      : summary.outstandingFen === 0 && summary.netPaidFen > 0
        ? "pill pill-green"
        : "pill",
    approvals: approvals.map(event => ({
      ...event,
      actionLabel: event.action === "initial"
        ? "初始批准"
        : event.action === "increase" ? "批准增加" : "批准减少",
      amountLabel: `${event.action === "decrease" ? "−" : "+"}${money(event.amountFen)}`,
      timeLabel: formatTime(event.createdAt)
    })).reverse(),
    payments: payments.map(payment => {
      const reservedRefundFen = refunds
        .filter(refund => refund.paymentId === payment.id && refund.status !== "rejected")
        .reduce((sum, refund) => sum + refund.amountFen, 0)
      return {
        ...payment,
        amountLabel: money(payment.amountFen),
        timeLabel: formatTime(payment.occurredAt),
        statusLabel: payment.status === "pending_confirmation"
          ? "待负责人确认"
          : payment.status === "confirmed" ? "已确认" : "已驳回",
        statusClass: payment.status === "pending_confirmation"
          ? "pill pill-amber"
          : payment.status === "confirmed" ? "pill pill-green" : "pill",
        canDecide: payment.status === "pending_confirmation",
        canRefund: payment.status === "confirmed" && reservedRefundFen < payment.amountFen,
        refundableLabel: money(Math.max(payment.amountFen - reservedRefundFen, 0))
      }
    }),
    refunds: refunds.map(refund => ({
      ...refund,
      amountLabel: money(refund.amountFen),
      timeLabel: formatTime(refund.occurredAt),
      statusLabel: refund.status === "pending_confirmation"
        ? "待负责人确认"
        : refund.status === "confirmed" ? "已确认" : "已驳回",
      statusClass: refund.status === "pending_confirmation"
        ? "pill pill-amber"
        : refund.status === "confirmed" ? "pill pill-green" : "pill",
      canDecide: refund.status === "pending_confirmation"
    }))
  }
}

Page({
  data: {
    activeTab: "materials" as "materials" | "expenses",
    hasProject: false,
    readOnly: false,
    projectName: "",
    materials: [] as Array<{
      id: string
      name: string
      detail: string
      balance: string
      estimate: string
      flow: string
      statusLabel: string
      statusClass: string
    }>,
    budgetEstimates: [] as BudgetEstimateView[],
    budgetEstimateTotal: 0,
    costItems: [] as CostItemView[],
    costMaterialOptions: [] as Array<{ id: string; name: string }>,
    selectedCost: null as CostItemView | null,
    summary: {
      target: "未设置",
      quoted: "¥0.00",
      approved: "¥0.00",
      netPaid: "¥0.00",
      pending: "¥0.00"
    },
    showForm: "" as "" | "budget" | "material" | "cost" | "approval" | "payment" | "refund",
    targetBudget: "",
    materialName: "",
    specification: "",
    unit: "件",
    plannedQuantity: "",
    unitPrice: "",
    wasteRate: "0",
    costTitle: "",
    costQuote: "",
    costNote: "",
    costMaterialIndex: 0,
    categoryIndex: 0,
    approvalActions: INITIAL_APPROVAL as ReadonlyArray<{ value: ApprovalAction; label: string }>,
    approvalActionIndex: 0,
    approvalAmount: "",
    approvalReason: "",
    paymentAmount: "",
    refundPaymentId: "",
    refundPaymentLabel: "",
    refundAmount: "",
    categories: CATEGORIES
  },
  onShow() {
    this.refresh(this.data.selectedCost?.id)
  },
  noop() {},
  refresh(selectedCostId?: string) {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({
        hasProject: false,
        projectName: "",
        readOnly: false,
        materials: [],
        budgetEstimates: [],
        budgetEstimateTotal: 0,
        costItems: [],
        selectedCost: null,
        showForm: "",
        summary: {
          target: "未设置",
          quoted: "¥0.00",
          approved: "¥0.00",
          netPaid: "¥0.00",
          pending: "¥0.00"
        }
      })
      return
    }
    const materials = state.materials.filter(item => item.projectId === project.id)
    const costItems = state.costItems
      .filter(item => item.projectId === project.id)
      .map(item => toCostView(item, state))
    const approvals = state.costApprovals.filter(item => item.projectId === project.id)
    const payments = state.paymentFacts.filter(item => item.projectId === project.id)
    const refunds = state.refundFacts.filter(item => item.projectId === project.id)
    const budgetEstimateApplications = state.budgetEstimateApplications
      .filter(item => item.projectId === project.id)
      .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))
    const costs = financeSummary(approvals, payments, refunds)
    const quotedFen = state.costItems
      .filter(item => item.projectId === project.id)
      .reduce((sum, item) => sum + (item.quotedAmountFen || 0), 0)
    this.setData({
      hasProject: true,
      projectName: project.name,
      readOnly: project.status === "archived",
      materials: materials.map(item => {
        const estimate = materialEstimate(item)
        const lines = state.purchaseLines.filter(line => line.materialId === item.id)
        const batches = state.receiptBatches.filter(batch => batch.materialId === item.id)
        const pendingReviewMilli = batches.reduce(
          (sum, batch) => sum + (receiptSummary(batch).unresolvedMilli || 0),
          0
        )
        const pendingReturnMilli = batches.reduce(
          (sum, batch) => sum + receiptSummary(batch).pendingReturnMilli,
          0
        )
        const hasActiveAgreement = state.agreements.some(agreement =>
          agreement.agreement.subjectId === item.id
          && Boolean(agreement.agreement.activeVersionId))
        const available = inventoryBalanceMilli(state.materialInventoryEvents, item.id) / 1000
        const statusLabel = pendingReviewMilli > 0
          ? "待核对"
          : pendingReturnMilli > 0
            ? "待退货"
            : hasActiveAgreement ? "约定已生效" : "约定待补"
        return {
          id: item.id,
          name: item.name,
          detail: `${item.specification || "未填规格"} · 计划 ${item.plannedQuantity} ${item.unit}`,
          balance: `${available} ${item.unit}`,
          estimate: item.unitPriceFen === undefined
            ? "未设置估算单价"
            : `含损耗需 ${estimate.requiredQuantity} ${item.unit} · 估算 ${money(estimate.amountFen)}`,
          flow: `采购 ${lines.length} 笔 · 到货 ${batches.length} 批 · 待核对 ${formatQuantityMilli(pendingReviewMilli)} ${item.unit}`,
          statusLabel,
          statusClass: pendingReviewMilli > 0 || pendingReturnMilli > 0
            ? "pill pill-amber"
            : hasActiveAgreement ? "pill pill-green" : "pill"
        }
      }),
      budgetEstimates: budgetEstimateApplications.slice(0, 10).map(toBudgetEstimateView),
      budgetEstimateTotal: budgetEstimateApplications.length,
      costItems,
      costMaterialOptions: [
        { id: "", name: "不关联材料" },
        ...materials.map(item => ({ id: item.id, name: item.name }))
      ],
      selectedCost: selectedCostId
        ? costItems.find(item => item.id === selectedCostId) || null
        : null,
      summary: {
        target: project.targetBudgetFen === undefined ? "未设置" : money(project.targetBudgetFen),
        quoted: money(quotedFen),
        approved: money(costs.approvedFen),
        netPaid: money(costs.netPaidFen),
        pending: money(costs.pendingPaymentFen + costs.pendingRefundFen)
      }
    })
  },
  setTab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
  },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  openMaterial() {
    if (!this.data.hasProject || this.data.readOnly) return
    this.setData({ showForm: "material" })
  },
  openMaterialDetail(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/material/index?id=${e.currentTarget.dataset.id as string}` })
  },
  openBudget() {
    const project = currentProject()
    if (!project || this.data.readOnly) return
    this.setData({
      showForm: "budget",
      targetBudget: project?.targetBudgetFen === undefined
        ? ""
        : (project.targetBudgetFen / 100).toFixed(2)
    })
  },
  openCost() {
    if (!this.data.hasProject || this.data.readOnly) return
    this.setData({ selectedCost: null, showForm: "cost", costMaterialIndex: 0 })
  },
  openCostDetail(e: WechatMiniprogram.TouchEvent) {
    this.refresh(e.currentTarget.dataset.id as string)
  },
  closeCostDetail() {
    this.setData({ selectedCost: null })
  },
  openApproval() {
    const selected = this.data.selectedCost
    if (!selected) return
    this.setData({
      showForm: "approval",
      approvalActions: selected.approvalCount ? ADJUST_APPROVALS : INITIAL_APPROVAL,
      approvalActionIndex: 0,
      approvalAmount: "",
      approvalReason: ""
    })
  },
  openPayment() {
    this.setData({ showForm: "payment", paymentAmount: "" })
  },
  openRefund(e: WechatMiniprogram.TouchEvent) {
    this.setData({
      showForm: "refund",
      refundPaymentId: e.currentTarget.dataset.id as string,
      refundPaymentLabel: e.currentTarget.dataset.label as string,
      refundAmount: ""
    })
  },
  closeForm() {
    this.setData({ showForm: "" })
  },
  onTargetBudget(e: WechatMiniprogram.Input) { this.setData({ targetBudget: e.detail.value }) },
  onMaterialName(e: WechatMiniprogram.Input) { this.setData({ materialName: e.detail.value }) },
  onSpecification(e: WechatMiniprogram.Input) { this.setData({ specification: e.detail.value }) },
  onUnit(e: WechatMiniprogram.Input) { this.setData({ unit: e.detail.value }) },
  onPlannedQuantity(e: WechatMiniprogram.Input) { this.setData({ plannedQuantity: e.detail.value }) },
  onUnitPrice(e: WechatMiniprogram.Input) { this.setData({ unitPrice: e.detail.value }) },
  onWasteRate(e: WechatMiniprogram.Input) { this.setData({ wasteRate: e.detail.value }) },
  onCostTitle(e: WechatMiniprogram.Input) { this.setData({ costTitle: e.detail.value }) },
  onCostQuote(e: WechatMiniprogram.Input) { this.setData({ costQuote: e.detail.value }) },
  onCostNote(e: WechatMiniprogram.TextareaInput) { this.setData({ costNote: e.detail.value }) },
  onCostMaterial(e: WechatMiniprogram.PickerChange) {
    this.setData({ costMaterialIndex: Number(e.detail.value) })
  },
  onCategory(e: WechatMiniprogram.PickerChange) { this.setData({ categoryIndex: Number(e.detail.value) }) },
  onApprovalAction(e: WechatMiniprogram.PickerChange) { this.setData({ approvalActionIndex: Number(e.detail.value) }) },
  onApprovalAmount(e: WechatMiniprogram.Input) { this.setData({ approvalAmount: e.detail.value }) },
  onApprovalReason(e: WechatMiniprogram.TextareaInput) { this.setData({ approvalReason: e.detail.value }) },
  onPaymentAmount(e: WechatMiniprogram.Input) { this.setData({ paymentAmount: e.detail.value }) },
  onRefundAmount(e: WechatMiniprogram.Input) { this.setData({ refundAmount: e.detail.value }) },
  submitBudget() {
    const project = currentProject()
    const targetBudgetFen = parseMoneyFen(this.data.targetBudget, true)
    if (!project || targetBudgetFen === undefined) {
      return wx.showToast({ title: "请输入正确的目标预算", icon: "none" })
    }
    try {
      setProjectTargetBudget(project.id, targetBudgetFen)
      this.setData({ showForm: "" })
      this.refresh()
      wx.showToast({ title: "目标预算已更新" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  submitMaterial() {
    const project = currentProject()
    const name = this.data.materialName.trim()
    const unit = this.data.unit.trim()
    const plannedQuantity = Number(this.data.plannedQuantity)
    const unitPriceFen = this.data.unitPrice.trim()
      ? parseMoneyFen(this.data.unitPrice)
      : undefined
    const wasteRatePermille = Math.round(Number(this.data.wasteRate || 0) * 10)
    if (!project || !name || !unit || !Number.isFinite(plannedQuantity) || plannedQuantity < 0
      || (this.data.unitPrice.trim() && unitPriceFen === undefined)
      || !Number.isInteger(wasteRatePermille) || wasteRatePermille < 0 || wasteRatePermille > 1000) {
      return wx.showToast({ title: "请完整填写材料与计划数量", icon: "none" })
    }
    createMaterial({
      projectId: project.id,
      name,
      specification: this.data.specification.trim(),
      unit,
      plannedQuantity,
      unitPriceFen,
      wasteRatePermille
    })
    this.setData({
      showForm: "",
      materialName: "",
      specification: "",
      plannedQuantity: "",
      unitPrice: "",
      wasteRate: "0"
    })
    this.refresh()
    wx.showToast({ title: "材料已新增" })
  },
  submitCost() {
    const project = currentProject()
    const title = this.data.costTitle.trim()
    const quote = this.data.costQuote.trim()
      ? parseMoneyFen(this.data.costQuote)
      : undefined
    if (!project || !title || (this.data.costQuote.trim() && quote === undefined)) {
      return wx.showToast({ title: "请填写费用事项和正确金额", icon: "none" })
    }
    try {
      const item = createCostItem({
        projectId: project.id,
        title,
        category: CATEGORIES[this.data.categoryIndex].value,
        quotedAmountFen: quote,
        note: this.data.costNote,
        materialId: this.data.costMaterialOptions[this.data.costMaterialIndex]?.id || undefined
      })
      this.setData({
        showForm: "",
        costTitle: "",
        costQuote: "",
        costNote: "",
        costMaterialIndex: 0
      })
      this.refresh(item.id)
      wx.showToast({ title: "费用事项已创建" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  submitApproval() {
    const selected = this.data.selectedCost
    const amountFen = parseMoneyFen(this.data.approvalAmount)
    const action = this.data.approvalActions[this.data.approvalActionIndex]?.value
    if (!selected || amountFen === undefined || !action) {
      return wx.showToast({ title: "请输入正确的批准金额", icon: "none" })
    }
    try {
      addLocalCostApproval({
        costItemId: selected.id,
        action,
        amountFen,
        reason: this.data.approvalReason
      })
      this.setData({ showForm: "" })
      this.refresh(selected.id)
      wx.showToast({ title: "批准记录已保存" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  submitPayment() {
    const selected = this.data.selectedCost
    const amountFen = parseMoneyFen(this.data.paymentAmount)
    if (!selected || amountFen === undefined) {
      return wx.showToast({ title: "请输入正确的付款金额", icon: "none" })
    }
    try {
      submitLocalPayment({ costItemId: selected.id, amountFen })
      this.setData({ showForm: "", paymentAmount: "" })
      this.refresh(selected.id)
      wx.showToast({ title: "付款已提交负责人确认" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  decidePayment(e: WechatMiniprogram.TouchEvent) {
    const selected = this.data.selectedCost
    if (!selected) return
    try {
      decideLocalPayment(
        e.currentTarget.dataset.id as string,
        e.currentTarget.dataset.decision as "confirmed" | "rejected"
      )
      this.refresh(selected.id)
      wx.showToast({ title: "付款确认结果已保存" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  submitRefund() {
    const selected = this.data.selectedCost
    const amountFen = parseMoneyFen(this.data.refundAmount)
    if (!selected || amountFen === undefined) {
      return wx.showToast({ title: "请输入正确的退款金额", icon: "none" })
    }
    try {
      submitLocalRefund({
        paymentId: this.data.refundPaymentId,
        amountFen
      })
      this.setData({ showForm: "", refundAmount: "" })
      this.refresh(selected.id)
      wx.showToast({ title: "退款已提交负责人确认" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  decideRefund(e: WechatMiniprogram.TouchEvent) {
    const selected = this.data.selectedCost
    if (!selected) return
    try {
      decideLocalRefund(
        e.currentTarget.dataset.id as string,
        e.currentTarget.dataset.decision as "confirmed" | "rejected"
      )
      this.refresh(selected.id)
      wx.showToast({ title: "退款确认结果已保存" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  }
})
