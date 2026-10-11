import type { Consultation, ConsultationResponse, ConsultationVersion } from "../../core/domain"
import {
  addConsultationResponse,
  closeConsultation,
  consultationPackage,
  convertConsultationResponseToProposal,
  createConsultation,
  currentProject,
  dismissConsultationResponse,
  loadState,
  publishConsultation,
  reviseConsultation
} from "../../core/store"
import { formatTime } from "../../core/view"

type State = ReturnType<typeof loadState>
type FormMode = "" | "consultation" | "response" | "dismiss" | "close"

const RESPONSE_SOURCES = [
  { value: "manual_relay", label: "我来回填对方回复（转述）" },
  { value: "member_direct_local", label: "项目成员本人填写（本机演示）" }
] as const

function splitLines(value: string): string[] {
  return value.split("\n").map(item => item.trim()).filter(Boolean)
}

function dateValue(iso = new Date().toISOString()): string {
  const value = new Date(iso)
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")
  return `${value.getFullYear()}-${month}-${day}`
}

function dateToIso(value: string): string {
  const parts = value.split("-").map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0)
  if (Number.isNaN(date.getTime())) throw new Error("收到日期不正确")
  return date.toISOString()
}

function displayVersion(item: Consultation): ConsultationVersion | undefined {
  return item.versions.find(version => version.id === item.draftVersionId)
    || item.versions.find(version => version.id === item.activeVersionId)
    || item.versions.at(-1)
}

function responseView(response: ConsultationResponse, state: State) {
  const issue = response.targetIssueId
    ? state.issues.find(item => item.id === response.targetIssueId)
    : undefined
  return {
    ...response,
    sourceLabel: response.source === "manual_relay"
      ? `转述 · ${response.channel} · 由${response.recordedBy}回填`
      : "项目成员本人填写 · 本机演示身份",
    statusLabel: response.status === "pending"
      ? "待负责人决定"
      : response.status === "converted_to_proposal" ? "已转为待选预案" : "未采纳",
    statusClass: response.status === "pending"
      ? "pill pill-amber"
      : response.status === "converted_to_proposal" ? "pill pill-green" : "pill",
    receivedLabel: formatTime(response.receivedAt),
    issueLabel: issue?.title || "",
    canConvert: response.status === "pending" && Boolean(issue)
  }
}

function consultationView(item: Consultation, state: State) {
  const draft = item.versions.find(version => version.id === item.draftVersionId)
  const active = item.versions.find(version => version.id === item.activeVersionId)
  const displayed = draft || active || item.versions.at(-1)!
  const responses = state.consultationResponses
    .filter(response => response.consultationId === item.id)
    .map(response => responseView(response, state))
  const recordLabels = displayed.recordIds.map(recordId =>
    state.records.find(record => record.id === recordId)?.title
      || displayed.recordCopies.find(record => record.id === recordId)?.title
      || "记录已不存在")
  const issueLabels = displayed.issueIds.map(issueId =>
    state.issues.find(issue => issue.id === issueId)?.title
      || displayed.issueCopies.find(issue => issue.id === issueId)?.title
      || "问题已不存在")
  const statusLabel = item.status === "closed"
    ? "已结束"
    : draft
      ? active ? "新草稿待发布" : "草稿"
      : "已发布"
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    statusLabel,
    statusClass: item.status === "closed"
      ? "pill"
      : draft ? "pill pill-amber" : "pill pill-green",
    version: item.version,
    revision: displayed.revision,
    question: displayed.question,
    knownFacts: displayed.knownFacts,
    gaps: displayed.gaps,
    answerQuestions: displayed.answerQuestions,
    recordLabels,
    issueLabels,
    recordCount: displayed.recordIds.length,
    issueCount: displayed.issueIds.length,
    responses,
    pendingResponseCount: responses.filter(response => response.status === "pending").length,
    hasDraft: Boolean(draft),
    hasActive: Boolean(active),
    canRespond: item.status !== "closed" && Boolean(active),
    closedReason: item.closeReason || "",
    meta: `v${displayed.revision} · ${displayed.recordIds.length} 条记录 · ${displayed.issueIds.length} 个问题 · ${responses.length} 条回复`,
    versions: [...item.versions].reverse().map(version => ({
      id: version.id,
      revision: version.revision,
      statusLabel: version.status === "draft"
        ? "草稿"
        : version.status === "published" ? "已发布" : "历史版本",
      timeLabel: formatTime(version.publishedAt || version.createdAt)
    }))
  }
}

type ConsultationView = ReturnType<typeof consultationView>

Page({
  data: {
    hasProject: false,
    projectName: "",
    readOnly: false,
    consultations: [] as ConsultationView[],
    selected: null as ConsultationView | null,
    showForm: "" as FormMode,
    editingId: "",
    expectedVersion: 0,
    title: "",
    question: "",
    knownFactsText: "",
    gapsText: "",
    answerQuestionsText: "",
    recordOptions: [] as Array<{ value: string; title: string; checked: boolean }>,
    issueOptions: [] as Array<{ value: string; title: string; checked: boolean }>,
    selectedResources: [] as string[],
    responseSources: RESPONSE_SOURCES,
    responseSourceIndex: 0,
    respondentName: "",
    responseChannel: "微信",
    receivedDate: dateValue(),
    originalText: "",
    responseSummary: "",
    recordedBy: "项目负责人",
    memberOptions: [] as Array<{ id: string; name: string }>,
    memberIndex: 0,
    targetIssueOptions: [] as Array<{ id: string; name: string }>,
    targetIssueIndex: 0,
    decidingResponseId: "",
    decisionReason: ""
  },
  onShow() {
    this.refresh(this.data.selected?.id)
  },
  noop() {},
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  openAiPrepare() {
    wx.navigateTo({ url: "/pages/ai/index?task=consultation&mode=prepare" })
  },
  openAiResponse() {
    const selected = this.data.selected
    if (!selected) return
    wx.navigateTo({
      url: `/pages/ai/index?task=consultation&mode=response&consultationId=${encodeURIComponent(selected.id)}`
    })
  },
  refresh(selectedId?: string) {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({
        hasProject: false,
        consultations: [],
        selected: null,
        projectName: "",
        readOnly: false,
        showForm: "",
        recordOptions: [],
        issueOptions: [],
        memberOptions: [],
        selectedResources: []
      })
      return
    }
    const consultations = state.consultations
      .filter(item => item.projectId === project.id)
      .map(item => consultationView(item, state))
    this.setData({
      hasProject: true,
      projectName: project.name,
      readOnly: project.status === "archived",
      consultations,
      selected: selectedId
        ? consultations.find(item => item.id === selectedId) || null
        : null,
      recordOptions: state.records
        .filter(item => item.projectId === project.id)
        .map(item => ({ value: `record:${item.id}`, title: item.title, checked: false })),
      issueOptions: state.issues
        .filter(item => item.projectId === project.id)
        .map(item => ({ value: `issue:${item.id}`, title: item.title, checked: false })),
      memberOptions: state.members
        .filter(item => item.projectId === project.id
          && item.status === "active"
          && item.scopes.includes("issues"))
        .map(item => ({ id: item.id, name: item.name }))
    })
  },
  open(e: WechatMiniprogram.TouchEvent) {
    this.refresh(e.currentTarget.dataset.id as string)
  },
  closeDetail() { this.setData({ selected: null }) },
  openCreate() {
    this.setData({
      showForm: "consultation",
      editingId: "",
      expectedVersion: 0,
      title: "",
      question: "",
      knownFactsText: "",
      gapsText: "",
      answerQuestionsText: "",
      selectedResources: [],
      recordOptions: this.data.recordOptions.map(item => ({ ...item, checked: false })),
      issueOptions: this.data.issueOptions.map(item => ({ ...item, checked: false }))
    })
  },
  openEdit() {
    const selected = this.data.selected
    if (!selected) return
    const state = loadState()
    const consultation = state.consultations.find(item => item.id === selected.id)
    if (!consultation) return
    const version = displayVersion(consultation)
    if (!version) return
    const selectedResources = [
      ...version.recordIds.map(item => `record:${item}`),
      ...version.issueIds.map(item => `issue:${item}`)
    ]
    this.setData({
      showForm: "consultation",
      editingId: consultation.id,
      expectedVersion: consultation.version,
      title: consultation.title,
      question: version.question,
      knownFactsText: version.knownFacts.join("\n"),
      gapsText: version.gaps.join("\n"),
      answerQuestionsText: version.answerQuestions.join("\n"),
      selectedResources,
      recordOptions: this.data.recordOptions.map(item => ({
        ...item,
        checked: selectedResources.includes(item.value)
      })),
      issueOptions: this.data.issueOptions.map(item => ({
        ...item,
        checked: selectedResources.includes(item.value)
      }))
    })
  },
  closeForm() {
    this.setData({ showForm: "", decidingResponseId: "", decisionReason: "" })
  },
  onTitle(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }) },
  onQuestion(e: WechatMiniprogram.TextareaInput) { this.setData({ question: e.detail.value }) },
  onKnownFacts(e: WechatMiniprogram.TextareaInput) { this.setData({ knownFactsText: e.detail.value }) },
  onGaps(e: WechatMiniprogram.TextareaInput) { this.setData({ gapsText: e.detail.value }) },
  onAnswerQuestions(e: WechatMiniprogram.TextareaInput) { this.setData({ answerQuestionsText: e.detail.value }) },
  onResources(e: WechatMiniprogram.CheckboxGroupChange) {
    this.setData({ selectedResources: e.detail.value })
  },
  submitConsultation() {
    const project = currentProject()
    if (!project) return
    const common = {
      title: this.data.title,
      question: this.data.question,
      knownFacts: splitLines(this.data.knownFactsText),
      gaps: splitLines(this.data.gapsText),
      answerQuestions: splitLines(this.data.answerQuestionsText),
      recordIds: this.data.selectedResources
        .filter(value => value.startsWith("record:"))
        .map(value => value.slice(7)),
      issueIds: this.data.selectedResources
        .filter(value => value.startsWith("issue:"))
        .map(value => value.slice(6))
    }
    try {
      const editing = Boolean(this.data.editingId)
      const consultation = editing
        ? reviseConsultation({
          consultationId: this.data.editingId,
          expectedVersion: this.data.expectedVersion,
          ...common
        })
        : createConsultation({ projectId: project.id, ...common })
      this.closeForm()
      this.refresh(consultation.id)
      wx.showToast({ title: editing ? "新版草稿已保存" : "咨询草稿已保存" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" })
    }
  },
  publish() {
    const selected = this.data.selected
    if (!selected) return
    try {
      publishConsultation(selected.id, selected.version)
      this.refresh(selected.id)
      wx.showToast({ title: "已发布固定版本" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "发布失败", icon: "none" })
    }
  },
  copyPackage() {
    const selected = this.data.selected
    if (!selected) return
    try {
      wx.setClipboardData({ data: consultationPackage(selected.id) })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "复制失败", icon: "none" })
    }
  },
  openResponse() {
    const selected = this.data.selected
    if (!selected) return
    const state = loadState()
    const consultation = state.consultations.find(item => item.id === selected.id)
    const active = consultation?.versions.find(item => item.id === consultation.activeVersionId)
    if (!active) return
    const targetIssueOptions = [
      { id: "", name: "不关联问题，仅留意见" },
      ...active.issueIds.map(issueId => ({
        id: issueId,
        name: state.issues.find(item => item.id === issueId)?.title || "问题已不存在"
      }))
    ]
    this.setData({
      showForm: "response",
      responseSourceIndex: 0,
      respondentName: "",
      responseChannel: "微信",
      receivedDate: dateValue(),
      originalText: "",
      responseSummary: "",
      recordedBy: "项目负责人",
      memberIndex: 0,
      targetIssueOptions,
      targetIssueIndex: targetIssueOptions.length > 1 ? 1 : 0
    })
  },
  onResponseSource(e: WechatMiniprogram.PickerChange) { this.setData({ responseSourceIndex: Number(e.detail.value) }) },
  onRespondentName(e: WechatMiniprogram.Input) { this.setData({ respondentName: e.detail.value }) },
  onResponseChannel(e: WechatMiniprogram.Input) { this.setData({ responseChannel: e.detail.value }) },
  onReceivedDate(e: WechatMiniprogram.PickerChange) { this.setData({ receivedDate: String(e.detail.value) }) },
  onOriginalText(e: WechatMiniprogram.TextareaInput) { this.setData({ originalText: e.detail.value }) },
  onResponseSummary(e: WechatMiniprogram.TextareaInput) { this.setData({ responseSummary: e.detail.value }) },
  onRecordedBy(e: WechatMiniprogram.Input) { this.setData({ recordedBy: e.detail.value }) },
  onMember(e: WechatMiniprogram.PickerChange) { this.setData({ memberIndex: Number(e.detail.value) }) },
  onTargetIssue(e: WechatMiniprogram.PickerChange) { this.setData({ targetIssueIndex: Number(e.detail.value) }) },
  submitResponse() {
    const selected = this.data.selected
    if (!selected) return
    const source = RESPONSE_SOURCES[this.data.responseSourceIndex].value
    try {
      addConsultationResponse({
        consultationId: selected.id,
        source,
        respondentName: this.data.respondentName,
        channel: this.data.responseChannel,
        receivedAt: dateToIso(this.data.receivedDate),
        originalText: this.data.originalText,
        summary: this.data.responseSummary,
        recordedBy: this.data.recordedBy,
        memberId: source === "member_direct_local"
          ? this.data.memberOptions[this.data.memberIndex]?.id
          : undefined,
        targetIssueId: this.data.targetIssueOptions[this.data.targetIssueIndex]?.id || undefined
      })
      this.closeForm()
      this.refresh(selected.id)
      wx.showToast({ title: "回复已留痕" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" })
    }
  },
  convertResponse(e: WechatMiniprogram.TouchEvent) {
    try {
      convertConsultationResponseToProposal(e.currentTarget.dataset.id as string)
      this.refresh(this.data.selected?.id)
      wx.showToast({ title: "已转为待选预案" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "转换失败", icon: "none" })
    }
  },
  openDismiss(e: WechatMiniprogram.TouchEvent) {
    this.setData({
      showForm: "dismiss",
      decidingResponseId: e.currentTarget.dataset.id as string,
      decisionReason: ""
    })
  },
  openClose() {
    this.setData({ showForm: "close", decisionReason: "" })
  },
  onDecisionReason(e: WechatMiniprogram.TextareaInput) {
    this.setData({ decisionReason: e.detail.value })
  },
  submitDismiss() {
    try {
      dismissConsultationResponse(this.data.decidingResponseId, this.data.decisionReason)
      this.closeForm()
      this.refresh(this.data.selected?.id)
      wx.showToast({ title: "已记录不采纳原因" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" })
    }
  },
  submitClose() {
    const selected = this.data.selected
    if (!selected) return
    try {
      closeConsultation(selected.id, selected.version, this.data.decisionReason)
      this.closeForm()
      this.refresh(selected.id)
      wx.showToast({ title: "咨询已结束" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" })
    }
  }
})
