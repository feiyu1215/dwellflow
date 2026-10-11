import { STAGES, type ProjectStage, type Space, type SpaceKind, type SpaceStageStatus } from "../../core/domain"
import { buildLegacyRoomCandidates, inferredSpaceKind, SPACE_KIND_OPTIONS, SPACE_STAGE_STATUS_OPTIONS } from "../../core/spaces"
import {
  createSpace, createSpaceRelation, currentProject, loadState, mapLegacyRoomLabel, moveSpace,
  setSpaceActive, setSpaceStageStatus, updateSpace
} from "../../core/store"

interface SpaceView extends Space {
  kindLabel: string
  stageStatusLabel: string
  recordCount: number
  issueCount: number
  relationCount: number
}

const RELATION_KIND_OPTIONS = [
  { value: "adjacent", label: "相邻" },
  { value: "access", label: "可通行" },
  { value: "contains", label: "包含" },
  { value: "other", label: "其他" }
] as const

const DIRECTION_OPTIONS = [
  { value: "none", label: "不登记方向" },
  { value: "left", label: "左侧" },
  { value: "right", label: "右侧" },
  { value: "up", label: "上方" },
  { value: "down", label: "下方" }
] as const

Page({
  data: {
    projectName: "", projectId: "", projectStage: "", readonly: false,
    activeSpaces: [] as SpaceView[], inactiveSpaces: [] as SpaceView[],
    candidates: [] as Array<{ sourceLabel: string; summary: string; mappedSpaceId: string; mappedSpaceName: string }>, relations: [] as string[],
    activeSpaceNames: [] as string[],
    showSpaceForm: false, editingSpaceId: "", editingVersion: 0, spaceName: "", kindIndex: 8,
    kindLabels: SPACE_KIND_OPTIONS.map(item => item.label), participatesInTopology: true,
    showStageForm: false, stageSpaceId: "", stageSpaceName: "", stageIndex: 0, stages: STAGES,
    stageStatusIndex: 0, stageStatusLabels: SPACE_STAGE_STATUS_OPTIONS.map(item => item.label),
    stageExpectedVersion: 0, stageNote: "",
    showRelationForm: false, relationFromId: "", relationFromName: "", relationTargetIds: [] as string[],
    relationTargetNames: [] as string[], relationTargetIndex: 0,
    relationKindIndex: 0, relationKindLabels: RELATION_KIND_OPTIONS.map(item => item.label),
    relationDirectionIndex: 0, relationDirectionLabels: DIRECTION_OPTIONS.map(item => item.label)
  },
  onShow() { this.refresh() },
  noop() {},
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({ projectName: "", projectId: "", activeSpaces: [], inactiveSpaces: [], candidates: [] })
      return
    }
    const spaces = state.spaces.filter(item => item.projectId === project.id)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    const nameById = new Map(spaces.map(item => [item.id, item.name]))
    const activeSpaceIdSet = new Set(spaces.filter(item => item.status === "active").map(item => item.id))
    const views: SpaceView[] = spaces.map(space => {
      const stageState = state.spaceStageStates.find(item => item.projectId === project.id
        && item.spaceId === space.id && item.stageId === project.stage)
      return {
        ...space,
        kindLabel: SPACE_KIND_OPTIONS.find(item => item.value === space.kind)?.label || "自定义",
        stageStatusLabel: stageState
          ? SPACE_STAGE_STATUS_OPTIONS.find(item => item.value === stageState.status)?.label || "未登记" : "未登记",
        recordCount: state.records.filter(item => item.projectId === project.id && item.spaceId === space.id).length,
        issueCount: state.issues.filter(item => item.projectId === project.id && item.spaceId === space.id && item.status !== "closed").length,
        relationCount: state.spaceRelations.filter(item => item.projectId === project.id && item.status === "active"
          && (item.fromSpaceId === space.id || item.toSpaceId === space.id)).length
      }
    })
    const candidates = buildLegacyRoomCandidates(state, project.id).map(item => ({
      sourceLabel: item.sourceLabel,
      summary: [item.recordCount ? `${item.recordCount} 条记录` : "", item.issueCount ? `${item.issueCount} 个问题` : "",
        item.cameraCount ? `${item.cameraCount} 台设备` : ""].filter(Boolean).join(" · "),
      mappedSpaceId: item.mappedSpaceId && activeSpaceIdSet.has(item.mappedSpaceId) ? item.mappedSpaceId : "",
      mappedSpaceName: item.mappedSpaceId && activeSpaceIdSet.has(item.mappedSpaceId)
        ? nameById.get(item.mappedSpaceId) || "" : ""
    }))
    const active = views.filter(item => item.status === "active")
    this.setData({
      projectName: project.name, projectId: project.id, projectStage: project.stage, readonly: project.status !== "active",
      activeSpaces: active, inactiveSpaces: views.filter(item => item.status === "inactive"), candidates,
      activeSpaceNames: ["选择已有空间", ...active.map(item => item.name)],
      relations: state.spaceRelations.filter(item => item.projectId === project.id && item.status === "active")
        .map(item => {
          const kind = RELATION_KIND_OPTIONS.find(option => option.value === item.kind)?.label || "其他"
          const direction = DIRECTION_OPTIONS.find(option => option.value === item.directionHint)?.label || "不登记方向"
          return `${nameById.get(item.fromSpaceId) || "未知空间"} · ${kind} · ${nameById.get(item.toSpaceId) || "未知空间"} · ${direction}`
        })
    })
  },
  openCreateSpace() {
    if (this.data.readonly) return
    this.setData({ showSpaceForm: true, editingSpaceId: "", editingVersion: 0, spaceName: "",
      kindIndex: SPACE_KIND_OPTIONS.findIndex(item => item.value === "custom"), participatesInTopology: true })
  },
  openEditSpace(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readonly) return
    const space = loadState().spaces.find(item => item.id === e.currentTarget.dataset.id)
    if (!space) return
    this.setData({ showSpaceForm: true, editingSpaceId: space.id, editingVersion: space.version, spaceName: space.name,
      kindIndex: Math.max(0, SPACE_KIND_OPTIONS.findIndex(item => item.value === space.kind)),
      participatesInTopology: space.participatesInTopology })
  },
  closeSpaceForm() { this.setData({ showSpaceForm: false }) },
  onSpaceName(e: WechatMiniprogram.Input) { this.setData({ spaceName: e.detail.value }) },
  onKindChange(e: WechatMiniprogram.PickerChange) {
    const kindIndex = Number(e.detail.value)
    this.setData({ kindIndex, participatesInTopology: SPACE_KIND_OPTIONS[kindIndex]?.value === "whole_project" ? false : this.data.participatesInTopology })
  },
  onTopologyChange(e: WechatMiniprogram.SwitchChange) { this.setData({ participatesInTopology: e.detail.value }) },
  submitSpace() {
    const editing = Boolean(this.data.editingSpaceId)
    try {
      const kind = SPACE_KIND_OPTIONS[this.data.kindIndex]?.value || "custom"
      if (editing) updateSpace({ spaceId: this.data.editingSpaceId, expectedVersion: this.data.editingVersion,
        name: this.data.spaceName, kind: kind as SpaceKind, participatesInTopology: this.data.participatesInTopology })
      else createSpace({ projectId: this.data.projectId, name: this.data.spaceName, kind: kind as SpaceKind,
        participatesInTopology: this.data.participatesInTopology })
      this.closeSpaceForm(); this.refresh(); wx.showToast({ title: editing ? "空间已更新" : "空间已创建" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" }) }
  },
  moveSpace(e: WechatMiniprogram.TouchEvent) {
    try { moveSpace(e.currentTarget.dataset.id as string, e.currentTarget.dataset.direction as "up" | "down"); this.refresh() }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "排序失败", icon: "none" }) }
  },
  toggleSpace(e: WechatMiniprogram.TouchEvent) {
    const active = e.currentTarget.dataset.active === "true"
    try { setSpaceActive(e.currentTarget.dataset.id as string, Number(e.currentTarget.dataset.version), active); this.refresh(); wx.showToast({ title: active ? "空间已恢复" : "空间已停用" }) }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" }) }
  },
  createAndMap(e: WechatMiniprogram.TouchEvent) {
    const sourceLabel = e.currentTarget.dataset.label as string
    try {
      const space = createSpace({ projectId: this.data.projectId, name: sourceLabel, kind: inferredSpaceKind(sourceLabel) })
      mapLegacyRoomLabel({ projectId: this.data.projectId, sourceLabel, spaceId: space.id })
      this.refresh(); wx.showToast({ title: "已创建并关联" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "整理失败", icon: "none" }) }
  },
  mapToExisting(e: WechatMiniprogram.PickerChange) {
    const space = this.data.activeSpaces[Number(e.detail.value) - 1]
    if (!space) return
    try { mapLegacyRoomLabel({ projectId: this.data.projectId, sourceLabel: e.currentTarget.dataset.label as string, spaceId: space.id }); this.refresh(); wx.showToast({ title: "旧资料已关联" }) }
    catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "关联失败", icon: "none" }) }
  },
  applyConfirmedMapping(e: WechatMiniprogram.TouchEvent) {
    try {
      mapLegacyRoomLabel({ projectId: this.data.projectId, sourceLabel: e.currentTarget.dataset.label as string,
        spaceId: e.currentTarget.dataset.spaceId as string })
      this.refresh(); wx.showToast({ title: "已沿用原归属" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "关联失败", icon: "none" }) }
  },
  openStageForm(e: WechatMiniprogram.TouchEvent) {
    const state = loadState()
    const spaceId = e.currentTarget.dataset.id as string
    const space = state.spaces.find(item => item.id === spaceId)
    const project = state.projects.find(item => item.id === this.data.projectId)
    if (!space || !project) return
    const current = state.spaceStageStates.find(item => item.projectId === project.id
      && item.spaceId === space.id && item.stageId === project.stage)
    this.setData({ showStageForm: true, stageSpaceId: space.id, stageSpaceName: space.name,
      stageIndex: Math.max(0, STAGES.indexOf(project.stage)),
      stageStatusIndex: current ? Math.max(0, SPACE_STAGE_STATUS_OPTIONS.findIndex(item => item.value === current.status)) : 0,
      stageExpectedVersion: current?.version || 0, stageNote: current?.note || "" })
  },
  closeStageForm() { this.setData({ showStageForm: false }) },
  onStageChange(e: WechatMiniprogram.PickerChange) {
    const stageIndex = Number(e.detail.value)
    const state = loadState()
    const current = state.spaceStageStates.find(item => item.projectId === this.data.projectId
      && item.spaceId === this.data.stageSpaceId && item.stageId === STAGES[stageIndex])
    this.setData({ stageIndex,
      stageStatusIndex: current ? Math.max(0, SPACE_STAGE_STATUS_OPTIONS.findIndex(item => item.value === current.status)) : 0,
      stageExpectedVersion: current?.version || 0, stageNote: current?.note || "" })
  },
  onStageStatusChange(e: WechatMiniprogram.PickerChange) { this.setData({ stageStatusIndex: Number(e.detail.value) }) },
  onStageNote(e: WechatMiniprogram.Input) { this.setData({ stageNote: e.detail.value }) },
  submitStage() {
    try {
      setSpaceStageStatus({ projectId: this.data.projectId, spaceId: this.data.stageSpaceId,
        stageId: STAGES[this.data.stageIndex] as ProjectStage,
        status: SPACE_STAGE_STATUS_OPTIONS[this.data.stageStatusIndex].value as SpaceStageStatus,
        note: this.data.stageNote, expectedVersion: this.data.stageExpectedVersion })
      this.closeStageForm(); this.refresh(); wx.showToast({ title: "阶段状态已保存" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" }) }
  },
  openRelationForm(e: WechatMiniprogram.TouchEvent) {
    const fromId = e.currentTarget.dataset.id as string
    const from = this.data.activeSpaces.find(item => item.id === fromId)
    if (!from) return
    const targets = this.data.activeSpaces.filter(item => item.id !== fromId)
    if (!targets.length) return wx.showToast({ title: "至少需要两个有效空间", icon: "none" })
    this.setData({ showRelationForm: true, relationFromId: fromId, relationFromName: from.name,
      relationTargetIds: targets.map(item => item.id), relationTargetNames: targets.map(item => item.name), relationTargetIndex: 0,
      relationKindIndex: 0, relationDirectionIndex: 0 })
  },
  closeRelationForm() { this.setData({ showRelationForm: false }) },
  onRelationTarget(e: WechatMiniprogram.PickerChange) { this.setData({ relationTargetIndex: Number(e.detail.value) }) },
  onRelationKind(e: WechatMiniprogram.PickerChange) { this.setData({ relationKindIndex: Number(e.detail.value) }) },
  onRelationDirection(e: WechatMiniprogram.PickerChange) { this.setData({ relationDirectionIndex: Number(e.detail.value) }) },
  submitRelation() {
    try {
      createSpaceRelation({ projectId: this.data.projectId, fromSpaceId: this.data.relationFromId,
        toSpaceId: this.data.relationTargetIds[this.data.relationTargetIndex],
        kind: RELATION_KIND_OPTIONS[this.data.relationKindIndex].value,
        directionHint: DIRECTION_OPTIONS[this.data.relationDirectionIndex].value })
      this.closeRelationForm(); this.refresh(); wx.showToast({ title: "空间关系已保存" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" }) }
  },
  openRecords() { wx.navigateTo({ url: "/pages/records/index" }) }
})
