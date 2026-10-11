import type { IssueWorkflow } from "../../core/issue-flow"
import { ROOMS, STAGES, type ProjectStage } from "../../core/domain"
import {
  addLocalIssueProposal,
  createIssue,
  currentProject,
  loadState,
  reopenLocalIssue,
  reviewLocalIssueTreatment,
  selectLocalIssueProposal,
  submitLocalIssueTreatment
} from "../../core/store"
import { formatTime } from "../../core/view"
import { parseOriginContext, type OriginContext } from "../../core/project-navigation"
import { resolvePatrolEntryContext, spaceIdForRoom } from "../../core/patrol-handoff"

const STATUS_META = {
  pending_confirmation: { label: "待确认", className: "pill pill-amber" },
  pending_action: { label: "待处理", className: "pill pill-amber" },
  pending_review: { label: "待复查", className: "pill pill-green" },
  closed: { label: "已关闭", className: "pill" }
} as const

const REVIEW_METHODS = [
  { value: "evidence", label: "根据照片或资料复查" },
  { value: "on_site", label: "负责人现场复查" },
  { value: "reported", label: "根据他人转述复查" }
] as const

const REVIEW_DECISIONS = [
  { value: "returned", label: "退回继续处理" },
  { value: "closed", label: "确认关闭" }
] as const

const CLOSE_REASONS = [
  { value: "resolved", label: "问题已解决" },
  { value: "not_required", label: "确认无需处理" },
  { value: "duplicate", label: "与其他事项重复" },
  { value: "false_positive", label: "确认属于误报" }
] as const

const REVIEW_METHOD_LABELS = {
  evidence: "照片或资料",
  on_site: "负责人现场",
  reported: "他人转述"
} as const

const CLOSE_REASON_LABELS = {
  resolved: "问题已解决",
  not_required: "确认无需处理",
  duplicate: "与其他事项重复",
  false_positive: "确认属于误报"
} as const

type IssueView = ReturnType<typeof toView>
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败"

function toView(issue: IssueWorkflow, state: ReturnType<typeof loadState>) {
  const legacy = state.issues.find(item => item.id === issue.id)
  const meta = STATUS_META[issue.status]
  const activeProposal = issue.proposals.find(item => item.status === "active")
  const currentStep = issue.status === "pending_confirmation" ? 1
    : issue.status === "pending_action" ? 2
      : issue.status === "pending_review" ? 3 : 4
  const linkedEvidenceIds = state.evidenceLinks.filter(link => link.projectId === issue.projectId
    && link.status === "active"
    && ((link.target.type === "issue" && link.target.id === issue.id)
      || (legacy?.recordId && link.target.type === "record" && link.target.id === legacy.recordId)))
    .map(link => link.evidenceId)
  const evidence = state.evidenceAssets.filter(asset => linkedEvidenceIds.includes(asset.id))
  const treatments = issue.treatments.map(item => ({
    ...item,
    timeLabel: formatTime(item.submittedAt),
    evidenceLabel: item.evidenceSourceIds.length
      ? `${item.evidenceSourceIds.length} 条关联记录`
      : "仅文字说明"
  }))
  const reviews = issue.reviews.map(item => ({
    ...item,
    timeLabel: formatTime(item.reviewedAt),
    decisionLabel: item.decision === "closed" ? "已关闭" : "已退回",
    methodLabel: REVIEW_METHOD_LABELS[item.method],
    closeReasonLabel: item.closeReason ? CLOSE_REASON_LABELS[item.closeReason] : ""
  }))
  const evidenceViews = evidence.map(asset => ({
    id: asset.id,
    label: asset.fileName,
    meta: `${asset.origin} · ${asset.status === "ready" ? "原件可用" : "原件" + asset.status}`,
    previewPath: asset.status === "ready" && asset.storageRef?.kind === "local_file"
      ? asset.storageRef.localPath
      : ""
  }))
  return {
    ...issue,
    room: legacy?.room || "",
    spaceId: legacy?.spaceId,
    stage: legacy?.stage,
    statusLabel: meta.label,
    statusClass: meta.className,
    location: legacy ? `${legacy.room} · ${legacy.stage}` : "位置和工序待补",
    schedule: legacy
      ? `${legacy.assigneeName || "未指定执行人"} · ${legacy.dueAt ? `截止 ${formatTime(legacy.dueAt)}` : "未设置期限"}`
      : "执行人和期限待补",
    activeProposalId: activeProposal?.id || "",
    activeProposalText: activeProposal?.content || "",
    activeProposalRef: activeProposal ? `${activeProposal.id} · 问题 v${issue.version}` : "",
    versionLabel: `v${issue.version}`,
    factSourceLabel: legacy?.recordId ? `来源记录 ${legacy.recordId}` : "用户直接记录",
    evidence: evidenceViews,
    primaryEvidence: evidenceViews[0] || null,
    processSteps: [
      { label: "事实", hint: "已记录", state: "done" },
      { label: "预案", hint: issue.proposals.length ? `${issue.proposals.length} 个版本` : "待提出", state: currentStep === 1 ? "current" : currentStep > 1 ? "done" : "upcoming" },
      { label: "处理", hint: issue.treatments.length ? `${issue.treatments.length} 次提交` : "待执行", state: currentStep === 2 ? "current" : currentStep > 2 ? "done" : "upcoming" },
      { label: "复查", hint: issue.reviews.length ? `${issue.reviews.length} 次记录` : "待复查", state: currentStep === 3 ? "current" : currentStep > 3 ? "done" : "upcoming" },
      { label: "结束", hint: issue.status === "closed" ? "已关闭" : "未到达", state: currentStep === 4 ? "current" : "upcoming" }
    ],
    proposalCount: issue.proposals.length,
    proposals: issue.proposals.map((item, index) => ({
      ...item,
      versionLabel: `预案 ${index + 1}`,
      timeLabel: formatTime(item.createdAt),
      authorLabel: item.submittedBy === "owner-local" ? "项目负责人" : "参与者",
      statusLabel: item.status === "active"
        ? "当前执行"
        : item.status === "superseded" ? "已替代" : "待确认",
      canSelect: item.status === "pending"
        && (issue.status === "pending_confirmation" || issue.status === "pending_action")
    })),
    treatments,
    reviews,
    latestTreatment: treatments[treatments.length - 1] || null,
    latestReview: reviews[reviews.length - 1] || null,
    reopenings: issue.reopenings.map(item => ({
      ...item,
      timeLabel: formatTime(item.reopenedAt)
    })),
    canAddProposal: issue.status === "pending_confirmation" || issue.status === "pending_action",
    canTreat: issue.status === "pending_action" && Boolean(activeProposal),
    canReview: issue.status === "pending_review",
    canReopen: issue.status === "closed",
    nextActionLabel: issue.status === "pending_confirmation"
      ? activeProposal ? "负责人确认执行预案" : "先提交处理预案"
      : issue.status === "pending_action"
        ? "提交处理结果"
        : issue.status === "pending_review"
          ? "等待负责人复查"
          : "已结束，可按原因重开"
  }
}

Page({
  data: {
    issues: [] as IssueView[],
    visibleIssues: [] as IssueView[],
    hasProject: false,
    projectId: "",
    projectName: "",
    issueFilter: "active" as "active" | "all",
    issueCounts: { active: 0, review: 0, closed: 0 },
    readOnly: false,
    selected: null as IssueView | null,
    showHistory: false,
    showAction: "" as "" | "create" | "replace" | "treatment" | "review" | "reopen",
    proposalText: "",
    replacementProposalId: "",
    replacementReason: "",
    treatmentNote: "",
    evidenceOptions: [] as Array<{ id: string; label: string }>,
    evidenceIndex: 0,
    reviewMethods: REVIEW_METHODS,
    reviewMethodIndex: 0,
    reviewDecisions: REVIEW_DECISIONS,
    reviewDecisionIndex: 0,
    closeReasons: CLOSE_REASONS,
    closeReasonIndex: 0,
    reviewNote: "",
    duplicateOptions: [] as Array<{ id: string; label: string }>,
    duplicateIndex: 0,
    reopenReason: "",
    createTitle: "",
    createDescription: "",
    createAssignee: "",
    createDueDate: "",
    createRoomIndex: 0,
    createStageIndex: 0,
    rooms: [...ROOMS] as string[],
    stages: STAGES,
    requestedIssueId: "",
    originLabel: "",
    originSpaceId: ""
  },
  originContext: undefined as OriginContext | undefined,
  requestedCreate: false,
  didOpenRequestedCreate: false,
  onLoad(options: Record<string, string | undefined>) {
    this.originContext = options.origin ? parseOriginContext(options.origin) : undefined
    this.requestedCreate = options.create === "1"
    this.setData({ requestedIssueId: options.id || "" })
  },
  onShow() {
    this.refresh(this.data.selected?.id || this.data.requestedIssueId)
    if (this.requestedCreate && !this.didOpenRequestedCreate && this.data.hasProject && !this.data.readOnly) {
      this.didOpenRequestedCreate = true
      this.openCreate()
    }
  },
  noop() {},
  refresh(selectedId?: string) {
    const state = loadState()
    const project = currentProject(state)
    const workflows = project
      ? state.issueWorkflows.filter(item => item.projectId === project.id)
      : []
    const rank = { pending_review: 0, pending_confirmation: 1, pending_action: 2, closed: 3 }
    const issues = workflows
      .map(item => toView(item, state))
      .sort((a, b) => rank[a.status] - rank[b.status])
    const records = project
      ? state.records.filter(item => item.projectId === project.id)
      : []
    const entry = project ? resolvePatrolEntryContext({
      context: this.originContext,
      projectId: project.id,
      currentStage: project.stage,
      spaces: state.spaces
    }) : undefined
    this.setData({
      issues,
      visibleIssues: this.data.issueFilter === "active"
        ? issues.filter(item => item.status !== "closed")
        : issues,
      hasProject: Boolean(project),
      projectId: project?.id || "",
      projectName: project?.name || "",
      rooms: entry?.roomOptions || [...ROOMS],
      originLabel: entry?.label || "",
      originSpaceId: entry?.spaceId || "",
      issueCounts: {
        active: issues.filter(item => item.status !== "closed").length,
        review: issues.filter(item => item.status === "pending_review").length,
        closed: issues.filter(item => item.status === "closed").length
      },
      readOnly: project?.status === "archived",
      selected: selectedId ? issues.find(item => item.id === selectedId) || null : null,
      evidenceOptions: [
        { id: "", label: "不关联记录，仅填写说明" },
        ...records.map(item => ({ id: item.id, label: item.title }))
      ],
      duplicateOptions: workflows
        .filter(item => item.id !== selectedId)
        .map(item => ({ id: item.id, label: item.title }))
    })
  },
  open(e: WechatMiniprogram.TouchEvent) {
    this.setData({ showHistory: false })
    this.refresh(e.currentTarget.dataset.id as string)
  },
  backFromIssue() {
    if (this.data.requestedIssueId && getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    this.close()
  },
  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory })
  },
  openEvidence(e: WechatMiniprogram.TouchEvent) {
    const evidenceId = e.currentTarget.dataset.id as string
    if (!evidenceId) return
    wx.navigateTo({
      url: `/pages/evidence-viewer/index?evidenceId=${encodeURIComponent(evidenceId)}`
    })
  },
  setIssueFilter(e: WechatMiniprogram.TouchEvent) {
    const issueFilter = e.currentTarget.dataset.filter as "active" | "all"
    this.setData({
      issueFilter,
      visibleIssues: issueFilter === "active"
        ? this.data.issues.filter(item => item.status !== "closed")
        : this.data.issues
    })
  },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  openAiProposal() {
    const selected = this.data.selected
    if (!selected) return
    wx.navigateTo({
      url: `/pages/ai/index?task=rectification&mode=proposal&issueId=${encodeURIComponent(selected.id)}`
    })
  },
  openAiReviewReference() {
    const selected = this.data.selected
    if (!selected) return
    wx.navigateTo({
      url: `/pages/ai/index?task=rectification&mode=review&issueId=${encodeURIComponent(selected.id)}`
    })
  },
  close() {
    this.setData({
      selected: null,
      showAction: "",
      showHistory: false,
      proposalText: "",
      replacementReason: ""
    })
  },
  closeAction() {
    this.setData({ showAction: "" })
  },
  openCreate() {
    const project = currentProject()
    const state = loadState()
    const entry = project ? resolvePatrolEntryContext({
      context: this.originContext,
      projectId: project.id,
      currentStage: project.stage,
      spaces: state.spaces
    }) : undefined
    this.setData({
      showAction: "create",
      selected: null,
      createTitle: "",
      createDescription: "",
      createAssignee: "",
      createDueDate: "",
      rooms: entry?.roomOptions || [...ROOMS],
      createRoomIndex: entry?.roomIndex || 0,
      createStageIndex: entry?.stageIndex ?? (project ? Math.max(0, STAGES.indexOf(project.stage)) : 0),
      originLabel: entry?.label || "",
      originSpaceId: entry?.spaceId || ""
    })
  },
  onProposal(e: WechatMiniprogram.TextareaInput) {
    this.setData({ proposalText: e.detail.value })
  },
  onReplacementReason(e: WechatMiniprogram.TextareaInput) {
    this.setData({ replacementReason: e.detail.value })
  },
  onTreatmentNote(e: WechatMiniprogram.TextareaInput) {
    this.setData({ treatmentNote: e.detail.value })
  },
  onEvidence(e: WechatMiniprogram.PickerChange) {
    this.setData({ evidenceIndex: Number(e.detail.value) })
  },
  onReviewMethod(e: WechatMiniprogram.PickerChange) {
    this.setData({ reviewMethodIndex: Number(e.detail.value) })
  },
  onReviewDecision(e: WechatMiniprogram.PickerChange) {
    this.setData({ reviewDecisionIndex: Number(e.detail.value) })
  },
  onCloseReason(e: WechatMiniprogram.PickerChange) {
    this.setData({ closeReasonIndex: Number(e.detail.value) })
  },
  onReviewNote(e: WechatMiniprogram.TextareaInput) {
    this.setData({ reviewNote: e.detail.value })
  },
  onDuplicate(e: WechatMiniprogram.PickerChange) {
    this.setData({ duplicateIndex: Number(e.detail.value) })
  },
  onReopenReason(e: WechatMiniprogram.TextareaInput) {
    this.setData({ reopenReason: e.detail.value })
  },
  onCreateTitle(e: WechatMiniprogram.Input) {
    this.setData({ createTitle: e.detail.value })
  },
  onCreateDescription(e: WechatMiniprogram.TextareaInput) {
    this.setData({ createDescription: e.detail.value })
  },
  onCreateAssignee(e: WechatMiniprogram.Input) {
    this.setData({ createAssignee: e.detail.value })
  },
  onCreateDueDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ createDueDate: String(e.detail.value) })
  },
  onCreateRoom(e: WechatMiniprogram.PickerChange) {
    this.setData({ createRoomIndex: Number(e.detail.value) })
  },
  onCreateStage(e: WechatMiniprogram.PickerChange) {
    this.setData({ createStageIndex: Number(e.detail.value) })
  },
  submitCreate() {
    const project = currentProject()
    const title = this.data.createTitle.trim()
    const description = this.data.createDescription.trim()
    if (!project || !title || !description) {
      return wx.showToast({ title: "请填写事项标题和原因", icon: "none" })
    }
    const state = loadState()
    const room = this.data.rooms[this.data.createRoomIndex] || ROOMS[0]
    const spaceId = spaceIdForRoom({
      projectId: project.id,
      roomName: room,
      spaces: state.spaces,
      preferredSpaceId: this.data.originSpaceId || undefined
    })
    createIssue({
      projectId: project.id,
      title,
      description,
      room,
      spaceId,
      stage: STAGES[this.data.createStageIndex] as ProjectStage,
      assigneeName: this.data.createAssignee.trim() || undefined,
      dueAt: this.data.createDueDate
        ? new Date(`${this.data.createDueDate}T12:00:00+08:00`).toISOString()
        : undefined,
      status: "pending_confirmation"
    })
    this.setData({
      showAction: "",
      createTitle: "",
      createDescription: "",
      createAssignee: "",
      createDueDate: ""
    })
    this.refresh()
    wx.showToast({ title: "事项已创建" })
  },
  submitProposal() {
    const selected = this.data.selected
    const content = this.data.proposalText.trim()
    if (!selected || !content) {
      return wx.showToast({ title: "请填写处理预案", icon: "none" })
    }
    try {
      addLocalIssueProposal(selected.id, content)
      this.setData({ proposalText: "" })
      this.refresh(selected.id)
      wx.showToast({ title: "预案已提交" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  selectProposal(e: WechatMiniprogram.TouchEvent) {
    const selected = this.data.selected
    const proposalId = e.currentTarget.dataset.id as string
    if (!selected) return
    if (selected.activeProposalId) {
      this.setData({
        showAction: "replace",
        replacementProposalId: proposalId,
        replacementReason: ""
      })
      return
    }
    try {
      selectLocalIssueProposal(selected.id, proposalId)
      this.refresh(selected.id)
      wx.showToast({ title: "负责人已采用预案" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  confirmReplacement() {
    const selected = this.data.selected
    if (!selected) return
    try {
      selectLocalIssueProposal(
        selected.id,
        this.data.replacementProposalId,
        this.data.replacementReason
      )
      this.setData({
        showAction: "",
        replacementProposalId: "",
        replacementReason: ""
      })
      this.refresh(selected.id)
      wx.showToast({ title: "执行预案已替换" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  openTreatment() {
    this.setData({ showAction: "treatment", evidenceIndex: 0, treatmentNote: "" })
  },
  submitTreatment() {
    const selected = this.data.selected
    const evidence = this.data.evidenceOptions[this.data.evidenceIndex]
    if (!selected) return
    try {
      submitLocalIssueTreatment({
        issueId: selected.id,
        note: this.data.treatmentNote,
        evidenceSourceIds: evidence?.id ? [evidence.id] : []
      })
      this.setData({ showAction: "", treatmentNote: "", evidenceIndex: 0 })
      this.refresh(selected.id)
      wx.showToast({ title: "处理结果已提交复查" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  openReview() {
    this.setData({
      showAction: "review",
      reviewMethodIndex: 0,
      reviewDecisionIndex: 0,
      closeReasonIndex: 0,
      reviewNote: "",
      duplicateIndex: 0
    })
  },
  submitReview() {
    const selected = this.data.selected
    const decision = REVIEW_DECISIONS[this.data.reviewDecisionIndex].value
    const closeReason = CLOSE_REASONS[this.data.closeReasonIndex].value
    const duplicate = this.data.duplicateOptions[this.data.duplicateIndex]
    if (!selected) return
    try {
      reviewLocalIssueTreatment({
        issueId: selected.id,
        decision,
        note: this.data.reviewNote,
        method: REVIEW_METHODS[this.data.reviewMethodIndex].value,
        closeReason: decision === "closed" ? closeReason : undefined,
        duplicateOfIssueId: decision === "closed" && closeReason === "duplicate"
          ? duplicate?.id
          : undefined
      })
      this.setData({ showAction: "", reviewNote: "" })
      this.refresh(selected.id)
      wx.showToast({
        title: decision === "closed" ? "负责人已关闭事项" : "已退回继续处理"
      })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  openReopen() {
    this.setData({ showAction: "reopen", reopenReason: "" })
  },
  submitReopen() {
    const selected = this.data.selected
    if (!selected) return
    try {
      reopenLocalIssue(selected.id, this.data.reopenReason)
      this.setData({ showAction: "", reopenReason: "" })
      this.refresh(selected.id)
      wx.showToast({ title: "事项已重新打开" })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  }
})
