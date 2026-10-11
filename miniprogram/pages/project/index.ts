import { STAGES, type Project, type ProjectStage } from "../../core/domain"
import { receiptSummary } from "../../core/material-flow"
import {
  archiveProject,
  createProject,
  loadState,
  purgeExpiredProjects,
  reopenProject,
  restoreTrashedProject,
  selectProject,
  trashProject,
  updateProjectDetails
} from "../../core/store"

type LifecycleAction = "archive" | "reopen" | "trash" | "restore"

interface ProjectView extends Project {
  selected: boolean
  lifecycleText: string
  purgeText: string
  attentionCount: number
  attentionLabel: string
  updatedText: string
  bubbleClass: string
}

const ACTION_META: Record<LifecycleAction, {
  title: string
  submitLabel: string
  defaultReason: string
}> = {
  archive: {
    title: "归档项目",
    submitLabel: "确认归档",
    defaultReason: "当前装修阶段结束，保留资料查阅"
  },
  reopen: {
    title: "重新开启项目",
    submitLabel: "确认重开",
    defaultReason: "项目继续推进"
  },
  trash: {
    title: "移入回收站",
    submitLabel: "移入回收站",
    defaultReason: "负责人确认不再使用当前项目"
  },
  restore: {
    title: "恢复项目",
    submitLabel: "恢复为只读项目",
    defaultReason: "负责人从回收站恢复项目"
  }
}

function formatDate(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

Page({
  data: {
    activeProjects: [] as ProjectView[],
    archivedProjects: [] as ProjectView[],
    trashedProjects: [] as ProjectView[],
    currentActiveProject: null as ProjectView | null,
    hasCurrentProject: false,
    showForm: "" as "" | "create" | "edit",
    editingProjectId: "",
    name: "",
    ownerName: "项目负责人",
    stageIndex: 0,
    stages: STAGES,
    lifecycleAction: "" as "" | LifecycleAction,
    lifecycleProjectId: "",
    lifecycleProjectName: "",
    lifecycleTitle: "",
    lifecycleSubmitLabel: "",
    lifecycleReason: ""
  },
  onShow() {
    purgeExpiredProjects()
    this.refresh()
  },
  noop() {},
  refresh() {
    const state = loadState()
    const latestEvents = new Map<string, typeof state.projectLifecycleEvents[number]>()
    state.projectLifecycleEvents.forEach(event => {
      if (!latestEvents.has(event.projectId)) latestEvents.set(event.projectId, event)
    })
    const activeProjectIds = state.projects.filter(item => item.status === "active").map(item => item.id)
    const views: ProjectView[] = state.projects.map(item => {
      const event = latestEvents.get(item.id)
      const openIssues = state.issueWorkflows.filter(workflow =>
        workflow.projectId === item.id && workflow.status !== "closed").length
      const pendingReceipts = state.receiptBatches.filter(batch =>
        batch.projectId === item.id && receiptSummary(batch).status !== "resolved").length
      const pendingAgreements = state.agreements.filter(agreement =>
        agreement.agreement.projectId === item.id
        && agreement.versions.some(version => version.status === "pending_confirmation")).length
      const pendingFinance = state.paymentFacts.filter(fact =>
        fact.projectId === item.id && fact.status === "pending_confirmation").length
        + state.refundFacts.filter(fact =>
          fact.projectId === item.id && fact.status === "pending_confirmation").length
      const attentionCount = openIssues + pendingReceipts + pendingAgreements + pendingFinance
      const activeIndex = activeProjectIds.indexOf(item.id)
      return {
        ...item,
        selected: item.id === state.currentProjectId,
        lifecycleText: event
          ? `${formatDate(event.createdAt)} · ${event.reason}`
          : "",
        purgeText: item.purgeAfter ? formatDate(item.purgeAfter) : "",
        attentionCount,
        attentionLabel: attentionCount ? `${attentionCount} 项需要处理` : "当前进展平稳",
        updatedText: formatDate(item.updatedAt),
        bubbleClass: `scene-bubble tone-${Math.max(0, activeIndex) % 4}`
      }
    })
    const activeProjects = views.filter(item => item.status === "active")
    this.setData({
      activeProjects,
      archivedProjects: views.filter(item => item.status === "archived"),
      trashedProjects: views.filter(item => item.status === "trashed"),
      currentActiveProject: activeProjects.find(item => item.selected) || null,
      hasCurrentProject: Boolean(state.currentProjectId)
    })
  },
  openForm() {
    this.setData({
      showForm: "create",
      editingProjectId: "",
      name: "",
      ownerName: "项目负责人",
      stageIndex: 0
    })
  },
  openEdit(e: WechatMiniprogram.TouchEvent) {
    const project = loadState().projects.find(item => item.id === e.currentTarget.dataset.id)
    if (!project || project.status !== "active") return
    this.setData({
      showForm: "edit",
      editingProjectId: project.id,
      name: project.name,
      ownerName: project.ownerName,
      stageIndex: Math.max(0, STAGES.indexOf(project.stage))
    })
  },
  closeForm() { this.setData({ showForm: "" }) },
  onName(e: WechatMiniprogram.Input) { this.setData({ name: e.detail.value }) },
  onOwner(e: WechatMiniprogram.Input) { this.setData({ ownerName: e.detail.value }) },
  onStage(e: WechatMiniprogram.PickerChange) { this.setData({ stageIndex: Number(e.detail.value) }) },
  submit() {
    const name = this.data.name.trim()
    const ownerName = this.data.ownerName.trim()
    const isEditing = this.data.showForm === "edit"
    if (!name || !ownerName) return wx.showToast({ title: "请填写项目和负责人", icon: "none" })
    try {
      if (isEditing) {
        updateProjectDetails({
          projectId: this.data.editingProjectId,
          name,
          ownerName,
          stage: STAGES[this.data.stageIndex] as ProjectStage
        })
      } else {
        createProject({ name, ownerName, stage: STAGES[this.data.stageIndex] as ProjectStage })
      }
      this.setData({ showForm: "", editingProjectId: "", name: "", stageIndex: 0 })
      this.refresh()
      wx.showToast({ title: isEditing ? "项目已更新" : "项目已创建" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" })
    }
  },
  selectScene(e: WechatMiniprogram.TouchEvent) {
    try {
      selectProject(e.currentTarget.dataset.id as string)
      this.refresh()
      wx.navigateBack({
        fail: () => wx.reLaunch({ url: "/pages/dashboard/index" })
      })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "切换失败", icon: "none" })
    }
  },
  select(e: WechatMiniprogram.TouchEvent) {
    this.selectScene(e)
  },
  openLifecycle(e: WechatMiniprogram.TouchEvent) {
    const action = e.currentTarget.dataset.action as LifecycleAction
    const projectId = e.currentTarget.dataset.id as string
    const project = loadState().projects.find(item => item.id === projectId)
    const meta = ACTION_META[action]
    if (!project || !meta) return
    this.setData({
      lifecycleAction: action,
      lifecycleProjectId: projectId,
      lifecycleProjectName: project.name,
      lifecycleTitle: meta.title,
      lifecycleSubmitLabel: meta.submitLabel,
      lifecycleReason: meta.defaultReason
    })
  },
  closeLifecycle() {
    this.setData({ lifecycleAction: "", lifecycleProjectId: "", lifecycleReason: "" })
  },
  onLifecycleReason(e: WechatMiniprogram.Input) {
    this.setData({ lifecycleReason: e.detail.value })
  },
  submitLifecycle() {
    const action = this.data.lifecycleAction
    const projectId = this.data.lifecycleProjectId
    const reason = this.data.lifecycleReason.trim()
    if (!action || !projectId) return
    if (!reason) return wx.showToast({ title: "请填写操作原因", icon: "none" })
    try {
      if (action === "archive") archiveProject(projectId, reason)
      if (action === "reopen") reopenProject(projectId, reason)
      if (action === "trash") trashProject(projectId, reason)
      if (action === "restore") restoreTrashedProject(projectId, reason)
      this.closeLifecycle()
      this.refresh()
      wx.showToast({ title: ACTION_META[action].submitLabel })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" })
    }
  },
  openCollaboration() { wx.navigateTo({ url: "/pages/collaboration/index" }) },
  openKnowledge() { wx.navigateTo({ url: "/pages/knowledge/index" }) },
  openCamera() { wx.navigateTo({ url: "/pages/camera/index" }) }
})
