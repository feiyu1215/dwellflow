import { STAGES, type ProjectStage } from "../../core/domain"
import {
  RecordInputDraftRepository,
  WxRecordInputDraftStorage,
  type RecordInputDraft
} from "../../core/input-drafts"
import { parseOriginContext, type OriginContext } from "../../core/project-navigation"
import { resolvePatrolEntryContext, spaceIdForRoom } from "../../core/patrol-handoff"
import { currentProject, loadState, makeId } from "../../core/store"

const drafts = new RecordInputDraftRepository(new WxRecordInputDraftStorage())

function dateValue(iso = new Date().toISOString()): string {
  const value = new Date(iso)
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")
  return `${value.getFullYear()}-${month}-${day}`
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "草稿保存失败"

Page({
  data: {
    hasProject: false,
    readOnly: false,
    projectId: "",
    projectName: "",
    screen: "editing" as "editing" | "review",
    draftId: "",
    originalText: "",
    title: "",
    note: "",
    occurredDate: dateValue(),
    rooms: [] as string[],
    roomIndex: 0,
    stages: STAGES,
    stageIndex: 0,
    originLabel: "",
    sourceHint: "本地草稿 · 尚未创建正式记录"
  },
  originContext: undefined as OriginContext | undefined,
  originRaw: "",
  requestedDraftId: "",
  suspendPersist: false,
  didPersistForExit: false,
  onLoad(options: Record<string, string | undefined>) {
    this.originRaw = options.origin || ""
    this.originContext = this.originRaw ? parseOriginContext(this.originRaw) : undefined
    this.requestedDraftId = options.draftId || ""
  },
  onShow() {
    this.suspendPersist = false
    this.didPersistForExit = false
    this.restore()
  },
  onHide() {
    this.persistForExit()
  },
  onUnload() {
    this.persistForExit()
  },
  persistForExit() {
    if (this.didPersistForExit || this.suspendPersist || this.data.readOnly || !this.data.originalText.trim()) return
    this.didPersistForExit = true
    try {
      if (this.data.screen === "review" && this.data.draftId) this.saveReview()
      else this.persistEditing()
    } catch {
      // 页面隐藏时只做尽力保存；用户再次进入时仍会回到最近一次有效草稿。
    }
  },
  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/dashboard/index" }) })
  },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  restore() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({ hasProject: false, projectId: "", projectName: "" })
      return
    }
    const entry = resolvePatrolEntryContext({
      context: this.originContext,
      projectId: project.id,
      currentStage: project.stage,
      spaces: state.spaces
    })
    const fallbackRooms = entry.roomOptions.length ? entry.roomOptions : ["全屋"]
    const restored = this.requestedDraftId
      ? drafts.getForProject(this.requestedDraftId, project.id)
      : drafts.latestOpen(project.id)
    const roomIndex = restored
      ? Math.max(0, fallbackRooms.indexOf(restored.room))
      : entry.roomIndex
    this.setData({
      hasProject: true,
      readOnly: project.status === "archived",
      projectId: project.id,
      projectName: project.name,
      screen: restored?.status === "review" ? "review" : "editing",
      draftId: restored?.id || "",
      originalText: restored?.originalText || "",
      title: restored?.title || "",
      note: restored?.note || "",
      occurredDate: restored?.occurredDate || dateValue(),
      rooms: fallbackRooms,
      roomIndex,
      stageIndex: restored ? Math.max(0, STAGES.indexOf(restored.stage)) : entry.stageIndex,
      originLabel: entry.label || `${fallbackRooms[roomIndex] || fallbackRooms[0]} · ${project.stage}`,
      sourceHint: restored ? `本地草稿 v${restored.revision} · 已恢复` : "本地草稿 · 尚未创建正式记录"
    })
  },
  onOriginalInput(e: WechatMiniprogram.TextareaInput) {
    this.setData({ originalText: e.detail.value, sourceHint: "本地草稿 · 正在编辑" })
  },
  onTitleInput(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }) },
  onNoteInput(e: WechatMiniprogram.TextareaInput) { this.setData({ note: e.detail.value }) },
  onOccurredDate(e: WechatMiniprogram.PickerChange) { this.setData({ occurredDate: String(e.detail.value) }) },
  onRoom(e: WechatMiniprogram.PickerChange) { this.setData({ roomIndex: Number(e.detail.value) }) },
  onStage(e: WechatMiniprogram.PickerChange) { this.setData({ stageIndex: Number(e.detail.value) }) },
  persistEditing(): RecordInputDraft | undefined {
    const project = currentProject()
    if (!project || project.id !== this.data.projectId) return undefined
    const text = this.data.originalText.trim()
    if (!text) return undefined
    const state = loadState()
    const room = this.data.rooms[this.data.roomIndex] || "全屋"
    const spaceId = spaceIdForRoom({
      projectId: project.id,
      roomName: room,
      spaces: state.spaces,
      preferredSpaceId: this.originContext?.spaceId
    })
    const draft = drafts.saveEditing({
      id: this.data.draftId || makeId("input-draft"),
      projectId: project.id,
      originalText: text,
      occurredDate: this.data.occurredDate,
      room,
      spaceId,
      stage: STAGES[this.data.stageIndex] as ProjectStage,
      origin: this.originRaw || undefined
    })
    this.setData({ draftId: draft.id, sourceHint: `本地草稿 v${draft.revision} · 已保存` })
    return draft
  },
  prepareReview() {
    if (this.data.readOnly) return wx.showToast({ title: "归档项目只能查看", icon: "none" })
    if (!this.data.originalText.trim()) return wx.showToast({ title: "先描述现在发生的事", icon: "none" })
    try {
      const editing = this.persistEditing()
      if (!editing) throw new Error("当前项目已变化，请返回后重试")
      const draft = drafts.prepareReview(editing.id, editing.projectId)
      this.setData({
        screen: "review",
        title: draft.title,
        note: draft.note,
        sourceHint: `本地草稿 v${draft.revision} · 等待检查`
      })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  backToEditing() {
    this.setData({ screen: "editing" })
  },
  saveReview(): RecordInputDraft | undefined {
    const project = currentProject()
    if (!project || project.id !== this.data.projectId || !this.data.draftId) return undefined
    const state = loadState()
    const room = this.data.rooms[this.data.roomIndex] || "全屋"
    return drafts.updateReview({
      id: this.data.draftId,
      projectId: project.id,
      title: this.data.title,
      note: this.data.note,
      occurredDate: this.data.occurredDate,
      room,
      spaceId: spaceIdForRoom({
        projectId: project.id,
        roomName: room,
        spaces: state.spaces,
        preferredSpaceId: this.originContext?.spaceId
      }),
      stage: STAGES[this.data.stageIndex] as ProjectStage
    })
  },
  continueManual() {
    if (this.data.readOnly) return wx.showToast({ title: "归档项目只能查看", icon: "none" })
    try {
      const draft = this.data.screen === "review" ? this.saveReview() : this.persistEditing()
      if (!draft) return wx.showToast({ title: "先写下要记录的事", icon: "none" })
      const origin = draft.origin ? `&origin=${draft.origin}` : ""
      this.suspendPersist = true
      wx.navigateTo({ url: `/pages/records/index?create=1&draftId=${encodeURIComponent(draft.id)}${origin}` })
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  }
})

