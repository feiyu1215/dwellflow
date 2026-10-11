import { buildReferenceDraft } from "../../core/analysis"
import type { AnalysisSource, RecordItem } from "../../core/domain"
import {
  createAnalysisNote,
  decideAnalysisNote,
  loadState
} from "../../core/store"
import { formatTime } from "../../core/view"

const SOURCE_LABEL = {
  manual: "人工意见",
  rule_reference: "知识卡参考草稿",
  ai: "AI 辅助"
}

const STATUS_LABEL = {
  draft: "待决定",
  accepted: "已采纳",
  dismissed: "未采纳",
  failed: "失败"
}

Page({
  data: {
    recordId: "",
    readOnly: false,
    unavailable: false,
    stateMessage: "",
    record: null as RecordItem | null,
    analyses: [] as Array<{ id: string; sourceLabel: string; statusLabel: string; meta: string; observations: string[]; unknowns: string[]; suggestions: string[]; pending: boolean }>,
    showForm: false,
    draftSource: "manual" as AnalysisSource,
    observationsText: "",
    unknownsText: "",
    suggestionsText: "",
    knowledgeCardIds: [] as string[],
    referenceTitles: [] as string[]
  },
  onLoad(options: { recordId?: string }) {
    this.setData({ recordId: options.recordId || "" })
  },
  onShow() { this.refresh() },
  noop() {},
  refresh() {
    const state = loadState()
    const record = state.records.find(item => item.id === this.data.recordId) || null
    const project = record ? state.projects.find(item => item.id === record.projectId) : undefined
    const analyses = state.analyses.filter(item => item.recordId === this.data.recordId)
    this.setData({
      record,
      readOnly: Boolean(record && project?.status !== "active"),
      unavailable: Boolean(record && (!project || project.status === "trashed")),
      stateMessage: !record ? "记录不存在或已被移除。"
        : !project ? "记录所属项目不存在，当前只能查看已保存内容。"
          : project.status === "trashed" ? "记录所属项目已在回收站中，不能新增或决定分析。"
            : project.status === "archived" ? "项目已归档：历史分析可查看，新增、采纳和驳回均已暂停。" : "",
      analyses: analyses.map(item => ({
        id: item.id,
        sourceLabel: SOURCE_LABEL[item.source],
        statusLabel: STATUS_LABEL[item.status],
        meta: `${formatTime(item.createdAt)} · ${item.knowledgeCardIds.length} 个知识引用`,
        observations: item.observations,
        unknowns: item.unknowns,
        suggestions: item.suggestions,
        pending: item.status === "draft"
      }))
    })
  },
  openManual() {
    if (this.data.readOnly || this.data.unavailable) return
    this.setData({
      showForm: true,
      draftSource: "manual",
      observationsText: "",
      unknownsText: "",
      suggestionsText: "",
      knowledgeCardIds: [],
      referenceTitles: []
    })
  },
  openReferenceDraft() {
    if (!this.data.record || this.data.readOnly || this.data.unavailable) return
    const draft = buildReferenceDraft(this.data.record)
    this.setData({
      showForm: true,
      draftSource: "rule_reference",
      observationsText: draft.observations.join("\n"),
      unknownsText: draft.unknowns.join("\n"),
      suggestionsText: draft.suggestions.join("\n"),
      knowledgeCardIds: draft.knowledgeCards.map(item => item.id),
      referenceTitles: draft.knowledgeCards.map(item => item.title)
    })
  },
  closeForm() { this.setData({ showForm: false }) },
  onObservations(e: WechatMiniprogram.TextareaInput) { this.setData({ observationsText: e.detail.value }) },
  onUnknowns(e: WechatMiniprogram.TextareaInput) { this.setData({ unknownsText: e.detail.value }) },
  onSuggestions(e: WechatMiniprogram.TextareaInput) { this.setData({ suggestionsText: e.detail.value }) },
  saveDraft() {
    const record = this.data.record
    if (!record || this.data.readOnly || this.data.unavailable) return
    const lines = (value: string) => value.split("\n").map(item => item.trim()).filter(Boolean)
    const observations = lines(this.data.observationsText)
    if (!observations.length) return wx.showToast({ title: "请至少填写一条观察", icon: "none" })
    try {
      createAnalysisNote({
        projectId: record.projectId,
        recordId: record.id,
        taskType: "record_review",
        source: this.data.draftSource,
        observations,
        unknowns: lines(this.data.unknownsText),
        suggestions: lines(this.data.suggestionsText),
        knowledgeCardIds: this.data.knowledgeCardIds
      })
      this.setData({ showForm: false })
      this.refresh()
      wx.showToast({ title: "分析草稿已保存" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" })
    }
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readOnly || this.data.unavailable) return
    try {
      decideAnalysisNote(e.currentTarget.dataset.id as string, e.currentTarget.dataset.decision as "accepted" | "dismissed")
      this.refresh()
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" })
    }
  },
  requestAi() {
    if (!this.data.record || this.data.readOnly || this.data.unavailable) return
    wx.navigateTo({ url: "/pages/ai/index?task=record_review&recordId=" + this.data.record.id })
  },
  requestImageAi() {
    if (!this.data.record || this.data.readOnly || this.data.unavailable) return
    wx.navigateTo({ url: "/pages/ai/index?task=image_observation&recordId=" + this.data.record.id })
  },
  backToRecords() {
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: "/pages/records/index" })
    })
  }
})
