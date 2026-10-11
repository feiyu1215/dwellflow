import { ROOMS, STAGES, type Attachment, type ProjectStage, type RecordItem } from "../../core/domain"
import {
  createIssue,
  createRecord,
  currentProject,
  loadState,
  makeId,
  updateRecord
} from "../../core/store"
import { formatTime } from "../../core/view"
import {
  ORIGIN_CONTEXT_SCHEMA_VERSION,
  parseOriginContext,
  serializeOriginContext,
  type OriginContext
} from "../../core/project-navigation"
import { resolvePatrolEntryContext, spaceIdForRoom } from "../../core/patrol-handoff"
import { RecordInputDraftRepository, WxRecordInputDraftStorage } from "../../core/input-drafts"

const recorder = wx.getRecorderManager()
const inputDrafts = new RecordInputDraftRepository(new WxRecordInputDraftStorage())
let activeStopHandler: ((result: { tempFilePath: string; duration: number }) => void) | undefined
let activeErrorHandler: (() => void) | undefined

recorder.onStop(result => activeStopHandler?.(result))
recorder.onError(() => activeErrorHandler?.())

function persistFile(tempFilePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().saveFile({
      tempFilePath,
      success: output => resolve(output.savedFilePath),
      fail: () => reject(new Error("本地持久化失败"))
    })
  })
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
  if (Number.isNaN(date.getTime())) throw new Error("发生日期不正确")
  return date.toISOString()
}

function toView(record: RecordItem, state: ReturnType<typeof loadState>) {
  const revisions = state.recordRevisions
    .filter(item => item.recordId === record.id)
    .sort((a, b) => b.version - a.version)
  const linkedIssues = state.issues.filter(item => item.recordId === record.id)
  const analyses = state.analyses.filter(item => item.recordId === record.id)
  const aiRecordApplications = state.recordReviewApplications
    .filter(item => item.targetRecordId === record.id)
  const aiImageApplications = state.imageObservationApplications
    .filter(item => item.imageRefs.some(image => image.sourceId === record.id))
  return {
    ...record,
    attachments: record.attachments.map(attachment => ({
      ...attachment,
      evidenceId: state.evidenceAssets.find(item => item.projectId === record.projectId
        && item.sourceAttachmentId === attachment.id)?.id || ""
    })),
    meta: `${record.room} · ${record.stage} · 发生于 ${formatTime(record.occurredAt)}`,
    versionLabel: `v${record.version}`,
    linkedIssueCount: linkedIssues.length,
    analysisCount: analyses.length + aiRecordApplications.length + aiImageApplications.length,
    revisions: revisions.map(item => ({
      ...item,
      timeLabel: formatTime(item.createdAt),
      occurredLabel: formatTime(item.occurredAt),
      attachmentCount: item.attachments.length
    }))
  }
}

type RecordView = ReturnType<typeof toView>
const errorText = (error: unknown) => error instanceof Error ? error.message : "保存失败"

Page({
  data: {
    records: [] as RecordView[],
    hasProject: false,
    projectId: "",
    projectName: "",
    readOnly: false,
    selected: null as RecordView | null,
    showForm: "" as "" | "create" | "edit",
    editingRecordId: "",
    expectedVersion: 0,
    title: "",
    note: "",
    changeReason: "",
    occurredDate: dateValue(),
    roomIndex: 0,
    stageIndex: 0,
    rooms: [...ROOMS] as string[],
    stages: STAGES,
    attachments: [] as Attachment[],
    isRecording: false,
    showDetails: false,
    requestedRecordId: "",
    requestedDraftId: "",
    originLabel: "",
    originSpaceId: ""
  },
  originContext: undefined as OriginContext | undefined,
  requestedCreate: false,
  didOpenRequestedCreate: false,
  onLoad(options: Record<string, string | undefined>) {
    this.originContext = options.origin ? parseOriginContext(options.origin) : undefined
    this.requestedCreate = options.create === "1"
    this.setData({
      requestedRecordId: options.id || "",
      requestedDraftId: options.draftId || ""
    })
    activeStopHandler = async result => {
      try {
        const localPath = await persistFile(result.tempFilePath)
        this.setData({
          isRecording: false,
          attachments: [...this.data.attachments, {
            id: makeId("attachment"),
            name: `现场语音 ${Math.max(1, Math.round(result.duration / 1000))} 秒`,
            type: "audio",
            localPath
          }]
        })
      } catch {
        this.setData({ isRecording: false })
        wx.showToast({ title: "语音未能持久保存，请重试", icon: "none" })
      }
    }
    activeErrorHandler = () => {
      this.setData({ isRecording: false })
      wx.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" })
    }
  },
  onUnload() {
    if (this.data.isRecording) recorder.stop()
    activeStopHandler = undefined
    activeErrorHandler = undefined
  },
  onShow() {
    this.refresh(this.data.selected?.id || this.data.requestedRecordId)
    if (this.requestedCreate && !this.didOpenRequestedCreate && this.data.hasProject && !this.data.readOnly) {
      this.didOpenRequestedCreate = true
      this.openForm()
      this.applyInputDraft()
    }
  },
  noop() {},
  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/dashboard/index" }) })
  },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  refresh(selectedId?: string) {
    const state = loadState()
    const project = currentProject(state)
    const records = project
      ? state.records.filter(item => item.projectId === project.id).map(item => toView(item, state))
      : []
    this.setData({
      records,
      hasProject: Boolean(project),
      projectId: project?.id || "",
      projectName: project?.name || "",
      readOnly: project?.status === "archived",
      selected: selectedId ? records.find(item => item.id === selectedId) || null : null
    })
  },
  entryContext() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) return undefined
    return resolvePatrolEntryContext({
      context: this.originContext,
      projectId: project.id,
      currentStage: project.stage,
      spaces: state.spaces
    })
  },
  openDetail(e: WechatMiniprogram.TouchEvent) {
    this.refresh(e.currentTarget.dataset.id as string)
  },
  closeDetail() {
    this.setData({ selected: null })
  },
  openEvidence(e: WechatMiniprogram.TouchEvent) {
    const evidenceId = e.currentTarget.dataset.evidenceId as string
    const record = this.data.selected
    if (!record || !evidenceId) return
    const origin = serializeOriginContext({
      projectId: record.projectId,
      originView: "patrol",
      spaceId: record.spaceId,
      stageId: record.stage,
      patrolStepId: "record",
      objectRef: { type: "record", id: record.id, version: record.version },
      evidenceId,
      anchorId: `record-${record.id}`,
      returnToken: makeId("return"),
      schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
    })
    wx.navigateTo({ url: `/pages/evidence-viewer/index?evidenceId=${encodeURIComponent(evidenceId)}&origin=${origin}` })
  },
  openForm() {
    const project = currentProject()
    const entry = this.entryContext()
    const stageIndex = entry?.stageIndex ?? (project ? Math.max(0, STAGES.indexOf(project.stage)) : 0)
    this.setData({
      showForm: "create",
      editingRecordId: "",
      expectedVersion: 0,
      title: "",
      note: "",
      changeReason: "",
      occurredDate: dateValue(),
      rooms: entry?.roomOptions || [...ROOMS],
      roomIndex: entry?.roomIndex || 0,
      stageIndex,
      originLabel: entry?.label || "",
      originSpaceId: entry?.spaceId || "",
      attachments: [],
      showDetails: false
    })
  },
  openQuickRecord() {
    wx.navigateTo({ url: "/pages/quick-record/index" })
  },
  applyInputDraft() {
    const draftId = this.data.requestedDraftId
    const project = currentProject()
    if (!draftId || !project || this.data.showForm !== "create") return
    const draft = inputDrafts.getForProject(draftId, project.id)
    if (!draft || draft.status === "saved") {
      wx.showToast({ title: "草稿不可用，已打开人工录入", icon: "none" })
      return
    }
    const rooms = this.data.rooms.includes(draft.room)
      ? this.data.rooms
      : [draft.room, ...this.data.rooms]
    this.setData({
      title: draft.title,
      note: draft.note || draft.originalText,
      occurredDate: draft.occurredDate,
      rooms,
      roomIndex: Math.max(0, rooms.indexOf(draft.room)),
      stageIndex: Math.max(0, STAGES.indexOf(draft.stage)),
      originSpaceId: draft.spaceId || this.data.originSpaceId,
      showDetails: true
    })
  },
  openEdit() {
    const record = this.data.selected
    if (!record) return
    const rooms = ROOMS.includes(record.room as typeof ROOMS[number])
      ? [...ROOMS]
      : [record.room, ...ROOMS]
    this.setData({
      showForm: "edit",
      editingRecordId: record.id,
      expectedVersion: record.version,
      title: record.title,
      note: record.note,
      changeReason: "",
      occurredDate: dateValue(record.occurredAt),
      rooms,
      roomIndex: Math.max(0, rooms.indexOf(record.room)),
      stageIndex: Math.max(0, STAGES.indexOf(record.stage)),
      originLabel: "",
      originSpaceId: record.spaceId || "",
      attachments: record.attachments.map(item => ({ ...item })),
      showDetails: true
    })
  },
  closeForm() {
    if (this.data.isRecording) recorder.stop()
    this.setData({ showForm: "", isRecording: false, attachments: [] })
  },
  onTitle(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }) },
  onNote(e: WechatMiniprogram.TextareaInput) { this.setData({ note: e.detail.value }) },
  onChangeReason(e: WechatMiniprogram.TextareaInput) { this.setData({ changeReason: e.detail.value }) },
  onOccurredDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ occurredDate: String(e.detail.value) })
  },
  onRoom(e: WechatMiniprogram.PickerChange) { this.setData({ roomIndex: Number(e.detail.value) }) },
  onStage(e: WechatMiniprogram.PickerChange) { this.setData({ stageIndex: Number(e.detail.value) }) },
  toggleDetails() { this.setData({ showDetails: !this.data.showDetails }) },
  async chooseImages() {
    try {
      const result = await wx.chooseMedia({
        count: 9,
        mediaType: ["image"],
        sourceType: ["album", "camera"]
      })
      const saved = await Promise.all(result.tempFiles.map(async (file, index) => {
        const localPath = await persistFile(file.tempFilePath)
        return {
          id: makeId("attachment"),
          name: `现场照片 ${this.data.attachments.length + index + 1}`,
          type: "image",
          localPath
        } as Attachment
      }))
      this.setData({ attachments: [...this.data.attachments, ...saved] })
    } catch {
      // 用户取消或持久化失败时，不把临时路径标为已保存附件。
    }
  },
  async chooseFiles() {
    try {
      const result = await wx.chooseMessageFile({ count: 9, type: "file" })
      const files = await Promise.all(result.tempFiles.map(async file => ({
        id: makeId("attachment"),
        name: file.name,
        type: "file" as const,
        localPath: await persistFile(file.path)
      })))
      this.setData({ attachments: [...this.data.attachments, ...files] })
    } catch {
      // 用户取消或持久化失败时，不把临时路径标为已保存附件。
    }
  },
  startRecording() {
    recorder.start({ duration: 60_000, format: "mp3" })
    this.setData({ isRecording: true })
  },
  stopRecording() {
    recorder.stop()
  },
  removeAttachment(e: WechatMiniprogram.TouchEvent) {
    const attachmentId = e.currentTarget.dataset.id as string
    this.setData({
      attachments: this.data.attachments.filter(item => item.id !== attachmentId)
    })
  },
  previewImage(e: WechatMiniprogram.TouchEvent) {
    const current = e.currentTarget.dataset.path as string
    const recordId = e.currentTarget.dataset.record as string | undefined
    const source = recordId
      ? this.data.records.find(item => item.id === recordId)?.attachments || []
      : this.data.attachments
    wx.previewImage({
      current,
      urls: source.filter(item => item.type === "image").map(item => item.localPath)
    })
  },
  openAttachment(e: WechatMiniprogram.TouchEvent) {
    const path = e.currentTarget.dataset.path as string
    const type = e.currentTarget.dataset.type as Attachment["type"]
    if (type === "audio") {
      const audio = wx.createInnerAudioContext()
      audio.src = path
      audio.play()
      audio.onEnded(() => audio.destroy())
      audio.onError(() => {
        audio.destroy()
        wx.showToast({ title: "语音播放失败", icon: "none" })
      })
      return
    }
    wx.openDocument({
      filePath: path,
      showMenu: true,
      fail: () => wx.showToast({ title: "该文件暂不支持预览", icon: "none" })
    })
  },
  submit(e: WechatMiniprogram.TouchEvent) {
    const project = currentProject()
    const nextAction = String(e.currentTarget.dataset.next || "stay")
    const note = this.data.note.trim()
    const fallbackTitle = note
      ? note.replace(/\s+/g, " ").slice(0, 28)
      : this.data.attachments.length ? "现场附件记录" : ""
    const title = this.data.title.trim() || fallbackTitle
    if (!project) return wx.showToast({ title: "请先创建项目", icon: "none" })
    if (!title) return wx.showToast({ title: "先写一句、拍张照片或录段语音", icon: "none" })
    try {
      const occurredAt = dateToIso(this.data.occurredDate)
      const state = loadState()
      const room = this.data.rooms[this.data.roomIndex] || ROOMS[0]
      const spaceId = spaceIdForRoom({
        projectId: project.id,
        roomName: room,
        spaces: state.spaces,
        preferredSpaceId: this.data.originSpaceId || undefined
      })
      if (this.data.showForm === "edit") {
        const next = updateRecord({
          recordId: this.data.editingRecordId,
          expectedVersion: this.data.expectedVersion,
          title,
          note: this.data.note,
          room,
          spaceId,
          stage: STAGES[this.data.stageIndex] as ProjectStage,
          occurredAt,
          attachments: this.data.attachments,
          changeReason: this.data.changeReason
        })
        this.setData({ showForm: "", attachments: [] })
        this.refresh(next.id)
        wx.showToast({ title: "补充内容已保存为新版本" })
        if (nextAction === "ai") {
          wx.navigateTo({ url: `/pages/ai/index?task=record_review&recordId=${encodeURIComponent(next.id)}` })
        }
        return
      }
      const next = createRecord({
        projectId: project.id,
        title,
        note,
        room,
        spaceId,
        stage: STAGES[this.data.stageIndex] as ProjectStage,
        creatorName: project.ownerName,
        occurredAt,
        attachments: this.data.attachments
      })
      if (this.data.requestedDraftId) {
        try {
          inputDrafts.markSaved(this.data.requestedDraftId, project.id, next.id)
        } catch {
          // 正式记录已经成功创建；回执失败不能回滚或触发重复创建。
        }
      }
      this.setData({ showForm: "", attachments: [] })
      this.refresh()
      wx.showToast({ title: "记录已保存" })
      if (nextAction === "ai") {
        wx.navigateTo({ url: `/pages/ai/index?task=record_review&recordId=${encodeURIComponent(next.id)}` })
      }
    } catch (error) {
      wx.showToast({ title: errorText(error), icon: "none" })
    }
  },
  createIssueFromRecord(e: WechatMiniprogram.TouchEvent) {
    const recordId = (e.currentTarget.dataset.id as string) || this.data.selected?.id
    const state = loadState()
    const record = state.records.find(item => item.id === recordId)
    if (!record) return
    if (state.issues.some(item => item.recordId === record.id)) {
      return wx.showToast({ title: "这条记录已经关联待办", icon: "none" })
    }
    createIssue({
      projectId: record.projectId,
      title: record.title,
      description: record.note || "由现场记录创建，等待补充处理要求。",
      room: record.room,
      spaceId: record.spaceId,
      stage: record.stage,
      recordId: record.id,
      status: "pending_confirmation"
    })
    this.refresh(this.data.selected?.id)
    wx.showToast({ title: "已创建问题事项" })
  },
  openRecordAi(e: WechatMiniprogram.TouchEvent) {
    const recordId = (e.currentTarget.dataset.id as string) || this.data.selected?.id
    if (recordId) {
      wx.navigateTo({ url: `/pages/ai/index?task=record_review&recordId=${encodeURIComponent(recordId)}` })
    }
  }
})
