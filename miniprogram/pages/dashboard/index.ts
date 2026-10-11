import type { AppState, EvidenceAsset, Project, ProjectStage } from "../../core/domain"
import type { AiTaskKind } from "../../core/ai-contract"
import { ROLE_PRESENTATION_POLICIES } from "../../core/flow-matrix"
import { localOwnerIdentity } from "../../core/local-access"
import {
  buildLocalProjectGateway,
  type ProjectGatewayCard,
  type ProjectGatewayFilter,
  type ProjectGatewayModel,
  type ProjectGatewaySort
} from "../../core/project-gateway"
import { buildProjectOverview, type ProjectOverviewModel } from "../../core/project-overview"
import {
  ORIGIN_CONTEXT_SCHEMA_VERSION,
  PROJECT_VIEW_STATE_SCHEMA_VERSION,
  projectViewStateKey,
  serializeOriginContext,
  validateProjectViewState,
  type PatrolPresentation,
  type ProjectViewState
} from "../../core/project-navigation"
import { evidencePreviewState } from "../../core/evidence-viewer"
import { spaceIllustrationFor } from "../../core/space-illustration"
import {
  PATROL_WORK_STEPS,
  movePatrolCoordinate,
  patrolAvailable,
  patrolDirectionFromDelta,
  type PatrolDirection,
  type PatrolWorkStepId
} from "../../core/patrol-navigation"
import { loadState, selectProject } from "../../core/store"

type DashboardView = "scene" | "overview" | "patrol"

interface SpaceSummary {
  id: string
  name: string
  recordCount: number
  issueCount: number
  evidenceCount: number
  illustrationPath: string
  illustrationLabel: string
  stageStatusLabel: string
  topologyClass: string
  topologyStyle: string
  topologyState: "has" | "warn" | "empty"
  previewAvailable: boolean
  previewPath: string
  previewFileName: string
  previewEvidenceId: string
  previewTimeLabel: string
  selected: boolean
}

interface PatrolEvidenceView {
  id: string
  fileName: string
  category: EvidenceAsset["category"]
  previewAvailable: boolean
  previewPath: string
  statusLabel: string
  sourceLabel: string
  timeLabel: string
  version: number
}

interface TopologyRelationView {
  id: string
  label: string
}

interface ResourceCluster {
  id: "site" | "delivery" | "collaboration" | "tools"
  label: string
  summary: string
  orderLabel: string
  entries: ProjectOverviewModel["resources"]
}

type PatrolPrimaryAction = "evidence" | "records" | "material" | "issues"

interface PatrolWorkPanel {
  eyebrow: string
  title: string
  copy: string
  primaryLabel: string
  primaryAction: PatrolPrimaryAction
  aiLabel: string
  aiTaskId: AiTaskKind
  aiMode: "" | "proposal" | "review"
}

interface AssistantTargets {
  recordId: string
  materialId: string
  receiptId: string
  issueId: string
  issueStatus: string
}

interface DashboardData {
  view: DashboardView
  scenes: ProjectGatewayCard[]
  sceneCount: number
  sceneLayout: "empty" | "bubble" | "list"
  activeSceneCount: number
  archivedSceneCount: number
  revokedSceneCount: number
  searchText: string
  gatewayFilter: ProjectGatewayFilter
  gatewaySort: ProjectGatewaySort
  project: Project | null
  currentProjectName: string
  roleLabel: string
  roleFocus: string
  selectedOverviewSpaceId: string
  selectedOverviewSpace: SpaceSummary | null
  topologyRelations: TopologyRelationView[]
  selectedWorkStepIndex: number
  selectedSpaceIndex: number
  selectedSpace: SpaceSummary | null
  selectedWorkStepId: PatrolWorkStepId
  selectedWorkStepLabel: string
  workPanel: PatrolWorkPanel
  assistantTargets: AssistantTargets
  patrolEvidences: PatrolEvidenceView[]
  selectedEvidenceIndex: number
  currentEvidence: PatrolEvidenceView | null
  patrolMode: PatrolPresentation
  transitionClass: string
  overview: ProjectOverviewModel | null
  resourceClusters: ResourceCluster[]
  workStepTrack: Array<{ id: PatrolWorkStepId; label: string; shortLabel: string; selected: boolean }>
  spaces: SpaceSummary[]
  topologySpaces: SpaceSummary[]
  topologyOverflowCount: number
  attentionCount: number
  overviewLead: string
  canChooseScene: boolean
}

let touchStartX = 0
let touchStartY = 0
let transitionTimer: ReturnType<typeof setTimeout> | undefined
let touchTracking = false

const VIEW_STATE_PREFIX = "project-view:"
const STAGE_STATUS_LABEL = {
  not_started: "尚未开始",
  in_progress: "进行中",
  pending_review: "待复查",
  confirmed_complete: "已确认完成"
} as const
const EVIDENCE_STATUS_LABEL: Record<EvidenceAsset["status"], string> = {
  pending: "处理中", ready: "原件可用", failed: "完整性异常", hidden: "已隐藏", missing: "原件缺失"
}

const RESOURCE_CLUSTER_DEFINITIONS: Array<Omit<ResourceCluster, "entries"> & { resourceIds: string[] }> = [
  { id: "site", label: "现场", summary: "空间、证据与正在发生的事", orderLabel: "01", resourceIds: ["spaces", "evidence", "records"] },
  { id: "delivery", label: "履约", summary: "问题、材料和资金事实", orderLabel: "02", resourceIds: ["issues", "materials", "finance"] },
  { id: "collaboration", label: "协作", summary: "成员分工与外部咨询", orderLabel: "03", resourceIds: ["members", "consultation"] },
  { id: "tools", label: "工具", summary: "检查参考、监控与备份", orderLabel: "04", resourceIds: ["knowledge", "camera", "backup"] }
]

function buildResourceClusters(overview: ProjectOverviewModel): ResourceCluster[] {
  const byId = new Map(overview.resources.map(item => [item.id, item]))
  return RESOURCE_CLUSTER_DEFINITIONS.map(({ resourceIds, ...cluster }) => ({
    ...cluster,
    entries: resourceIds.map(id => byId.get(id)).filter((item): item is ProjectOverviewModel["resources"][number] => Boolean(item))
  }))
}

const TOPOLOGY_SLOT_STYLES = [
  "left:5.3%;top:14.8%;width:35.9%;height:28.1%",
  "left:54.1%;top:13.3%;width:38.8%;height:30.4%",
  "left:8.2%;top:61.1%;width:37.1%;height:28.9%",
  "left:55.3%;top:55.6%;width:37.1%;height:32.6%"
]

function shortEvidenceTime(value?: string) {
  if (!value) return "时间未记录"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function buildSpaces(state: AppState, projectId: string, stage: ProjectStage, selectedId?: string): SpaceSummary[] {
  const assetsById = new Map(state.evidenceAssets.map(item => [item.id, item]))
  return state.spaces.filter(item => item.projectId === projectId && item.status === "active")
    .sort((a, b) => a.order - b.order)
    .map((space, index) => {
      const recordCount = state.records.filter(item => item.projectId === projectId && item.spaceId === space.id).length
      const issueCount = state.issues.filter(item => item.projectId === projectId && item.spaceId === space.id && item.status !== "closed").length
      const links = state.evidenceLinks.filter(item => item.projectId === projectId
        && item.spaceId === space.id && item.status === "active")
      const assets = links.map(link => assetsById.get(link.evidenceId))
        .filter((asset): asset is EvidenceAsset => Boolean(asset) && asset?.status !== "hidden")
      const previewAsset = assets.find(asset => asset.category === "image") || assets[0]
      const preview = previewAsset ? evidencePreviewState(previewAsset) : undefined
      const evidenceCount = assets.length
      const illustration = spaceIllustrationFor(space.kind)
      return {
        id: space.id,
        name: space.name,
        recordCount,
        issueCount,
        evidenceCount,
        illustrationPath: illustration.assetPath,
        illustrationLabel: illustration.label,
        stageStatusLabel: STAGE_STATUS_LABEL[state.spaceStageStates.find(item =>
          item.projectId === projectId && item.spaceId === space.id && item.stageId === stage)?.status || "not_started"],
        topologyClass: `topology-shape-${index % 6}`,
        topologyStyle: TOPOLOGY_SLOT_STYLES[index] || "display:none",
        topologyState: issueCount ? "warn" : evidenceCount ? "has" : "empty",
        previewAvailable: Boolean(preview?.available && previewAsset?.category === "image"),
        previewPath: preview?.localPath || "",
        previewFileName: previewAsset?.fileName || "",
        previewEvidenceId: previewAsset?.id || "",
        previewTimeLabel: shortEvidenceTime(previewAsset?.occurredAt || previewAsset?.capturedAt || previewAsset?.createdAt),
        selected: space.id === selectedId
      }
    })
}

function evidenceForCoordinate(state: AppState, projectId: string, spaceId: string, stageId: ProjectStage): PatrolEvidenceView[] {
  const ids = new Set(state.evidenceLinks.filter(link => link.projectId === projectId && link.status === "active"
    && link.spaceId === spaceId && link.stageId === stageId).map(link => link.evidenceId))
  return state.evidenceAssets.filter(asset => asset.projectId === projectId && ids.has(asset.id) && asset.status !== "hidden")
    .map(asset => {
      const preview = evidencePreviewState(asset)
      return {
        id: asset.id, fileName: asset.fileName, category: asset.category,
        previewAvailable: preview.available, previewPath: preview.localPath,
        statusLabel: EVIDENCE_STATUS_LABEL[asset.status],
        sourceLabel: asset.syntheticDisclosure || (asset.origin === "legacy_attachment" ? "旧附件迁移" : "项目资料"),
        timeLabel: shortEvidenceTime(asset.occurredAt || asset.capturedAt || asset.createdAt),
        version: asset.version
      }
    })
}

function buildWorkPanel(
  state: AppState,
  projectId: string,
  space: SpaceSummary,
  stepId: PatrolWorkStepId,
  currentEvidence: PatrolEvidenceView | null
): PatrolWorkPanel {
  if (stepId === "site") {
    return currentEvidence ? {
      eyebrow: "现场原件",
      title: currentEvidence.fileName,
      copy: `取得于 ${currentEvidence.timeLabel}。资料存在不代表施工完成。`,
      primaryLabel: "查看现场原件",
      primaryAction: "evidence",
      aiLabel: "图片辅助分析",
      aiTaskId: "image_observation",
      aiMode: ""
    } : {
      eyebrow: "现场",
      title: `${space.name}还没有现场证据`,
      copy: "保留空间位置，但不使用样板房或 AI 图片冒充现场。",
      primaryLabel: "记录第一份现场",
      primaryAction: "records",
      aiLabel: "整理拍摄需求",
      aiTaskId: "record_review",
      aiMode: ""
    }
  }
  if (stepId === "record") {
    return {
      eyebrow: "记录环节",
      title: space.recordCount ? `${space.name}已有 ${space.recordCount} 条现场记录` : `${space.name}尚无现场记录`,
      copy: "照片、文字和语音转写先保存为事实；房间、时间和工序候选由人确认。",
      primaryLabel: "新增现场记录",
      primaryAction: "records",
      aiLabel: "让 AI 整理",
      aiTaskId: "record_review",
      aiMode: ""
    }
  }
  if (stepId === "check") {
    const materialCount = state.materials.filter(item => item.projectId === projectId).length
    const receiptCount = state.receiptBatches.filter(item => item.projectId === projectId).length
    return {
      eyebrow: "核对环节",
      title: receiptCount ? `${receiptCount} 批到货资料可核对` : "当前没有待核对的到货批次",
      copy: materialCount
        ? `项目已有 ${materialCount} 种材料；批准基线、标签与到货数量分开呈现，核对不会自动入库。`
        : "先建立材料与批准基线；未知内容不会被判为相符。",
      primaryLabel: receiptCount ? "进入材料核对" : "建立材料资料",
      primaryAction: "material",
      aiLabel: "AI 材料核对",
      aiTaskId: "material_check",
      aiMode: ""
    }
  }
  if (stepId === "resolve") {
    return {
      eyebrow: "处理环节",
      title: space.issueCount ? `${space.issueCount} 项事实等待处理` : "当前没有待处理问题",
      copy: "事实、处理预案和负责人决定分开保存；AI 只能准备草稿和疑点。",
      primaryLabel: space.issueCount ? "查看问题" : "记录问题",
      primaryAction: "issues",
      aiLabel: "拟预案或咨询",
      aiTaskId: "rectification",
      aiMode: "proposal"
    }
  }
  const reviewCount = state.issues.filter(item => item.projectId === projectId
    && item.spaceId === space.id && item.status === "pending_review").length
  return {
    eyebrow: "复查环节",
    title: reviewCount ? `${reviewCount} 项处理结果等待复查` : "当前没有待复查事项",
    copy: "前后证据不足时保持待确认；只有负责人可以关闭或退回问题。",
    primaryLabel: reviewCount ? "进入复查" : "查看问题记录",
    primaryAction: "issues",
    aiLabel: "AI 复查参考",
    aiTaskId: "rectification",
    aiMode: "review"
  }
}

function buildAssistantTargets(
  state: AppState,
  projectId: string,
  space: SpaceSummary,
  stepId: PatrolWorkStepId,
  currentEvidence: PatrolEvidenceView | null
): AssistantTargets {
  const linkedRecordId = currentEvidence
    ? state.evidenceLinks.find(link => link.projectId === projectId
      && link.evidenceId === currentEvidence.id && link.status === "active"
      && link.target.type === "record")?.target.id
    : undefined
  const record = state.records.find(item => item.id === linkedRecordId && item.projectId === projectId)
    || state.records.find(item => item.projectId === projectId
      && (item.spaceId === space.id || (!item.spaceId && item.room === space.name)))
  const receipt = state.receiptBatches.find(item => item.projectId === projectId)
  const material = state.materials.find(item => item.id === receipt?.materialId && item.projectId === projectId)
    || state.materials.find(item => item.projectId === projectId)
  const issues = state.issues.filter(item => item.projectId === projectId
    && (item.spaceId === space.id || (!item.spaceId && item.room === space.name)))
  const issue = stepId === "review"
    ? issues.find(item => item.status === "pending_review")
    : issues.find(item => item.status !== "closed")
  return {
    recordId: record?.id || "",
    materialId: material?.id || "",
    receiptId: receipt?.materialId === material?.id ? receipt?.id || "" : "",
    issueId: issue?.id || "",
    issueStatus: issue?.status || ""
  }
}

const OVERVIEW_ROUTES = new Set([
  "/pages/records/index",
  "/pages/spaces/index",
  "/pages/evidence/index",
  "/pages/issues/index",
  "/pages/material/index",
  "/pages/ledger/index",
  "/pages/collaboration/index",
  "/pages/consultation/index",
  "/pages/knowledge/index",
  "/pages/camera/index",
  "/pages/backup/index"
])

Page({
  data: {
    view: "overview",
    scenes: [],
    sceneCount: 0,
    sceneLayout: "bubble",
    activeSceneCount: 0,
    archivedSceneCount: 0,
    revokedSceneCount: 0,
    searchText: "",
    gatewayFilter: "active",
    gatewaySort: "attention",
    project: null,
    currentProjectName: "",
    roleLabel: ROLE_PRESENTATION_POLICIES.owner.label,
    roleFocus: ROLE_PRESENTATION_POLICIES.owner.focus,
    selectedOverviewSpaceId: "",
    selectedOverviewSpace: null,
    topologyRelations: [],
    selectedWorkStepIndex: 0,
    selectedSpaceIndex: 0,
    selectedSpace: null,
    selectedWorkStepId: PATROL_WORK_STEPS[0].id,
    selectedWorkStepLabel: PATROL_WORK_STEPS[0].label,
    workPanel: {
      eyebrow: "现场", title: "尚无巡场位置", copy: "先建立空间。",
      primaryLabel: "记录现场", primaryAction: "records",
      aiLabel: "记录整理", aiTaskId: "record_review", aiMode: ""
    },
    assistantTargets: { recordId: "", materialId: "", receiptId: "", issueId: "", issueStatus: "" },
    patrolEvidences: [],
    selectedEvidenceIndex: 0,
    currentEvidence: null,
    patrolMode: "illustration",
    transitionClass: "",
    overview: null,
    resourceClusters: [],
    workStepTrack: [],
    spaces: [],
    topologySpaces: [],
    topologyOverflowCount: 0,
    attentionCount: 0,
    overviewLead: "",
    canChooseScene: false
  } as DashboardData,
  onLoad() {
    // 开发者工具热重载可能保留旧详情页实例；重新载入首页时先清掉旧壳状态，
    // 再由 refresh 按项目数量决定进入项目入口或项目概览。
    this.setData({ view: "overview", project: null, overview: null, transitionClass: "" })
  },
  onShow() {
    this.refresh()
  },
  refresh() {
    const state = loadState()
    const gateway = this.buildGateway(state)
    const projects = state.projects.filter(item => gateway.accessibleProjectIds.includes(item.id))
    if (!projects.length) {
      this.setGatewayData(gateway)
      this.setData({ project: null, currentProjectName: "", overview: null, view: "scene" })
      return
    }
    const project = projects.find(item => item.id === state.currentProjectId) || projects[0]
    if (project.id !== state.currentProjectId) selectProject(project.id)
    const preserveProject = this.data.project?.id === project.id
    const restoredView = preserveProject ? this.data.view : this.restoreView(project)
    const desiredView: DashboardView = gateway.mode === "direct" ? restoredView : "scene"
    this.applyProject(state, project, gateway, desiredView)
  },
  buildGateway(state: AppState): ProjectGatewayModel {
    return buildLocalProjectGateway({
      state,
      identity: localOwnerIdentity(),
      query: {
        text: this.data.searchText,
        filter: this.data.gatewayFilter,
        sort: this.data.gatewaySort
      }
    })
  },
  setGatewayData(gateway: ProjectGatewayModel) {
    this.setData({
      scenes: gateway.cards,
      sceneCount: gateway.accessibleCount,
      sceneLayout: gateway.layout,
      activeSceneCount: gateway.activeCount,
      archivedSceneCount: gateway.archivedCount,
      revokedSceneCount: gateway.revokedCount,
      canChooseScene: gateway.accessibleCount > 1
    })
  },
  refreshGateway() {
    this.setGatewayData(this.buildGateway(loadState()))
  },
  applyProject(state: AppState, project: Project, gateway: ProjectGatewayModel, view: DashboardView) {
    const activeSpaces = state.spaces.filter(item => item.projectId === project.id && item.status === "active").sort((a, b) => a.order - b.order)
    const resolvedView: DashboardView = view === "patrol" && !patrolAvailable(project.status, activeSpaces.length)
      ? "overview"
      : view
    const stored = this.readStoredView(project.id)
    const storedSpaceIndex = activeSpaces.findIndex(item => item.id === stored?.spaceId)
    const storedWorkStepIndex = PATROL_WORK_STEPS.findIndex(item => item.id === stored?.patrolStepId)
    const spaceIndex = resolvedView === "patrol" && this.data.project?.id === project.id
      ? Math.min(this.data.selectedSpaceIndex, Math.max(0, activeSpaces.length - 1))
      : Math.max(0, storedSpaceIndex)
    const workStepIndex = resolvedView === "patrol" && this.data.project?.id === project.id
      ? this.data.selectedWorkStepIndex
      : storedWorkStepIndex >= 0 ? storedWorkStepIndex : 0
    const workStep = PATROL_WORK_STEPS[workStepIndex] || PATROL_WORK_STEPS[0]
    const selectedSpaceId = activeSpaces[spaceIndex]?.id || ""
    const overviewSpaceId = this.data.project?.id === project.id
      && activeSpaces.some(item => item.id === this.data.selectedOverviewSpaceId)
      ? this.data.selectedOverviewSpaceId : selectedSpaceId
    const spaces = buildSpaces(state, project.id, project.stage, overviewSpaceId)
    const selectedSpace = spaces.find(item => item.id === selectedSpaceId) || null
    const patrolEvidences = selectedSpace ? evidenceForCoordinate(state, project.id, selectedSpace.id, project.stage) : []
    const preferredEvidenceId = resolvedView === "patrol" && this.data.project?.id === project.id
      ? this.data.currentEvidence?.id
      : stored?.evidenceId
    const storedEvidenceIndex = patrolEvidences.findIndex(item => item.id === preferredEvidenceId)
    const evidenceIndex = storedEvidenceIndex >= 0 ? storedEvidenceIndex : 0
    const currentEvidence = patrolEvidences[evidenceIndex] || null
    const storedPatrolMode = stored?.patrolPresentation
    const patrolMode: PatrolPresentation = workStep.id !== "site" || storedPatrolMode === "illustration"
      ? "illustration"
      : currentEvidence ? "evidence" : "illustration"
    const workPanel = selectedSpace
      ? buildWorkPanel(state, project.id, selectedSpace, workStep.id, currentEvidence)
      : this.data.workPanel
    const assistantTargets = selectedSpace
      ? buildAssistantTargets(state, project.id, selectedSpace, workStep.id, currentEvidence)
      : { recordId: "", materialId: "", receiptId: "", issueId: "", issueStatus: "" }
    const spaceName = new Map(activeSpaces.map(item => [item.id, item.name]))
    const topologyRelations = state.spaceRelations.filter(item => item.projectId === project.id && item.status === "active"
      && spaceName.has(item.fromSpaceId) && spaceName.has(item.toSpaceId)).map(item => ({
        id: item.id,
        label: `${spaceName.get(item.fromSpaceId)} → ${spaceName.get(item.toSpaceId)} · ${item.kind === "adjacent" ? "相邻" : item.kind === "access" ? "通行" : item.kind === "contains" ? "包含" : "其他"}`
      }))
    const overview = buildProjectOverview(state, project)
    const selectedOverviewSpace = spaces.find(item => item.id === overviewSpaceId) || null
    const overviewLead = selectedOverviewSpace
      ? `${project.stage}阶段正在发生。${selectedOverviewSpace.name}${selectedOverviewSpace.issueCount
        ? `有 ${selectedOverviewSpace.issueCount} 项待核查`
        : selectedOverviewSpace.evidenceCount ? `已有 ${selectedOverviewSpace.evidenceCount} 份资料` : "尚无现场资料"}。`
      : `${project.stage}阶段正在发生，当前尚未建立空间。`
    wx.setNavigationBarTitle({ title: project.name })
    this.setData({
      view: resolvedView,
      scenes: gateway.cards,
      sceneCount: gateway.accessibleCount,
      sceneLayout: gateway.layout,
      activeSceneCount: gateway.activeCount,
      archivedSceneCount: gateway.archivedCount,
      revokedSceneCount: gateway.revokedCount,
      project,
      currentProjectName: project.name,
      canChooseScene: gateway.accessibleCount > 1,
      selectedOverviewSpaceId: overviewSpaceId,
      selectedOverviewSpace,
      topologyRelations,
      topologySpaces: spaces.slice(0, 4),
      topologyOverflowCount: Math.max(0, spaces.length - 4),
      attentionCount: overview.focus.count,
      overviewLead,
      selectedWorkStepIndex: workStepIndex,
      selectedSpaceIndex: spaceIndex,
      selectedSpace,
      selectedWorkStepId: workStep.id,
      selectedWorkStepLabel: workStep.label,
      workPanel,
      assistantTargets,
      patrolEvidences,
      selectedEvidenceIndex: evidenceIndex,
      currentEvidence,
      patrolMode,
      overview,
      resourceClusters: buildResourceClusters(overview),
      workStepTrack: PATROL_WORK_STEPS.map(item => ({ ...item, selected: item.id === workStep.id })),
      spaces
    })
  },
  chooseScene(e: WechatMiniprogram.TouchEvent) {
    const projectId = e.currentTarget.dataset.id as string
    try {
      selectProject(projectId)
      const state = loadState()
      const gateway = this.buildGateway(state)
      const projects = state.projects.filter(item => gateway.accessibleProjectIds.includes(item.id))
      const project = projects.find(item => item.id === projectId)
      if (!project) return
      this.applyProject(state, project, gateway, "overview")
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "场景切换失败", icon: "none" })
    }
  },
  showSceneSelector() {
    if (!this.data.canChooseScene) return this.manageProject()
    this.setData({ view: "scene" })
  },
  onGatewaySearch(e: WechatMiniprogram.Input) {
    this.setData({ searchText: e.detail.value })
    this.refreshGateway()
  },
  setGatewayFilter(e: WechatMiniprogram.TouchEvent) {
    this.setData({ gatewayFilter: e.currentTarget.dataset.filter as ProjectGatewayFilter })
    this.refreshGateway()
  },
  toggleGatewaySort() {
    this.setData({
      gatewaySort: this.data.gatewaySort === "attention" ? "recent" : "attention"
    })
    this.refreshGateway()
  },
  clearGatewaySearch() {
    this.setData({ searchText: "" })
    this.refreshGateway()
  },
  resetGatewayFilters() {
    const gatewayFilter: ProjectGatewayFilter = this.data.activeSceneCount
      ? "active"
      : this.data.archivedSceneCount ? "archived" : "active"
    this.setData({ searchText: "", gatewayFilter })
    this.refreshGateway()
  },
  readStoredView(projectId: string): ProjectViewState | undefined {
    try {
      const value = wx.getStorageSync(`${VIEW_STATE_PREFIX}${projectViewStateKey(localOwnerIdentity().identityId, projectId)}`) as unknown
      return validateProjectViewState(value).length ? undefined : value as ProjectViewState
    } catch { return undefined }
  },
  restoreView(project: Project): DashboardView {
    const saved = this.readStoredView(project.id)
    return saved?.viewKind === "patrol" ? "patrol" : "overview"
  },
  saveView(viewKind: "overview" | "patrol") {
    const project = this.data.project
    if (!project) return
    const state: ProjectViewState = {
      identityId: localOwnerIdentity().identityId,
      projectId: project.id,
      viewKind,
      // 概览与巡场共享最后一次合法坐标；viewKind 只决定重进项目时先展示哪一层。
      // 这样从巡场返回概览不会抹掉“继续上次巡场”的位置。
      spaceId: this.data.selectedSpace?.id,
      stageId: this.data.selectedSpace ? project.stage : undefined,
      patrolStepId: this.data.selectedSpace ? this.data.selectedWorkStepId : undefined,
      evidenceId: this.data.selectedSpace ? this.data.currentEvidence?.id : undefined,
      patrolPresentation: this.data.selectedSpace ? this.data.patrolMode : undefined,
      schemaVersion: PROJECT_VIEW_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString()
    }
    wx.setStorageSync(`${VIEW_STATE_PREFIX}${projectViewStateKey(state.identityId, project.id)}`, state)
  },
  showOverview() {
    this.setData({ view: "overview", transitionClass: "" })
    this.saveView("overview")
  },
  selectOverviewSpace(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || "")
    const spaces = this.data.spaces.map(item => ({ ...item, selected: item.id === id }))
    this.setData({
      spaces,
      topologySpaces: spaces.slice(0, 4),
      selectedOverviewSpaceId: id,
      selectedOverviewSpace: spaces.find(item => item.id === id) || null
    })
  },
  enterSelectedSpace() {
    const index = this.data.spaces.findIndex(item => item.id === this.data.selectedOverviewSpaceId)
    if (index < 0) return this.openSpaces()
    this.setPatrolCoordinate(index, 0, "enter-up")
  },
  continuePatrol() {
    const stored = this.data.project ? this.readStoredView(this.data.project.id) : undefined
    const spaceIndex = Math.max(0, this.data.spaces.findIndex(item => item.id === stored?.spaceId))
    const workStepIndex = PATROL_WORK_STEPS.findIndex(item => item.id === stored?.patrolStepId)
    this.setPatrolCoordinate(
      spaceIndex,
      workStepIndex >= 0 ? workStepIndex : 0,
      "enter-up",
      stored?.evidenceId
    )
  },
  onTouchStart(e: WechatMiniprogram.TouchEvent) {
    if (e.touches.length !== 1) { touchTracking = false; return }
    const touch = e.touches[0]
    if (!touch) return
    touchTracking = true
    touchStartX = touch.clientX
    touchStartY = touch.clientY
  },
  onTouchEnd(e: WechatMiniprogram.TouchEvent) {
    if (!touchTracking) return
    touchTracking = false
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const direction = patrolDirectionFromDelta({ dx, dy })
    if (direction) this.movePatrol(direction)
  },
  onTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (e.touches.length !== 1) touchTracking = false
  },
  onTouchCancel() { touchTracking = false },
  movePatrol(direction: PatrolDirection) {
    if (this.data.transitionClass) return
    const move = movePatrolCoordinate({
      current: { spaceIndex: this.data.selectedSpaceIndex, stepIndex: this.data.selectedWorkStepIndex },
      direction,
      spaceCount: this.data.spaces.length,
      stepCount: PATROL_WORK_STEPS.length
    })
    if (!move.moved) {
      wx.showToast({ title: "已经到达巡场边界", icon: "none" }); return
    }
    this.setPatrolCoordinate(move.spaceIndex, move.stepIndex, move.transition)
  },
  setPatrolCoordinate(spaceIndex: number, workStepIndex: number, transitionClass = "", preferredEvidenceId?: string) {
    const state = loadState()
    const project = this.data.project
    const selectedSpace = this.data.spaces[spaceIndex]
    const workStep = PATROL_WORK_STEPS[workStepIndex]
    if (!project || !selectedSpace || !workStep) return
    const spaces = buildSpaces(state, project.id, project.stage, selectedSpace.id)
    const patrolEvidences = evidenceForCoordinate(state, project.id, selectedSpace.id, project.stage)
    const preferredEvidenceIndex = patrolEvidences.findIndex(item => item.id === preferredEvidenceId)
    const evidenceIndex = preferredEvidenceIndex >= 0 ? preferredEvidenceIndex : 0
    const currentEvidence = patrolEvidences[evidenceIndex] || null
    const savedMode = this.readStoredView(project.id)?.patrolPresentation
    const stepChanged = workStepIndex !== this.data.selectedWorkStepIndex
    const requestedMode = this.data.view === "patrol" && !stepChanged ? this.data.patrolMode : savedMode
    const patrolMode: PatrolPresentation = workStep.id !== "site"
      ? "illustration"
      : requestedMode === "illustration" ? "illustration" : currentEvidence ? "evidence" : "illustration"
    const selectedSpaceView = spaces[spaceIndex]
    const workPanel = buildWorkPanel(state, project.id, selectedSpaceView, workStep.id, currentEvidence)
    const assistantTargets = buildAssistantTargets(state, project.id, selectedSpaceView, workStep.id, currentEvidence)
    if (transitionTimer) clearTimeout(transitionTimer)
    this.setData({
      view: "patrol", spaces, topologySpaces: spaces.slice(0, 4),
      topologyOverflowCount: Math.max(0, spaces.length - 4),
      selectedSpaceIndex: spaceIndex, selectedSpace: spaces[spaceIndex],
      selectedOverviewSpaceId: selectedSpace.id, selectedOverviewSpace: spaces[spaceIndex],
      selectedWorkStepIndex: workStepIndex, selectedWorkStepId: workStep.id,
      selectedWorkStepLabel: workStep.label, workPanel,
      assistantTargets,
      workStepTrack: PATROL_WORK_STEPS.map(item => ({ ...item, selected: item.id === workStep.id })),
      patrolEvidences, selectedEvidenceIndex: evidenceIndex, currentEvidence, patrolMode,
      transitionClass
    })
    this.saveView("patrol")
    transitionTimer = setTimeout(() => this.setData({ transitionClass: "" }), 220)
  },
  selectEvidence(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    const currentEvidence = this.data.patrolEvidences[index]
    if (!currentEvidence) return
    this.setData({ selectedEvidenceIndex: index, currentEvidence, patrolMode: "evidence" })
    this.saveView("patrol")
  },
  setPatrolMode(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode || "") as PatrolPresentation
    if (mode !== "evidence" && mode !== "illustration") return
    if (this.data.selectedWorkStepId !== "site") {
      wx.showToast({ title: "现场环节才切换原件与空间示意", icon: "none" })
      return
    }
    if (mode === "evidence" && !this.data.currentEvidence) {
      wx.showToast({ title: "当前空间和施工阶段还没有现场证据", icon: "none" })
      return
    }
    this.setData({ patrolMode: mode })
    this.saveView("patrol")
  },
  selectPatrolSpace(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index === this.data.selectedSpaceIndex) return
    this.setPatrolCoordinate(index, this.data.selectedWorkStepIndex, index > this.data.selectedSpaceIndex ? "enter-left" : "enter-right")
  },
  selectPatrolWorkStep(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= PATROL_WORK_STEPS.length || index === this.data.selectedWorkStepIndex) return
    this.setPatrolCoordinate(
      this.data.selectedSpaceIndex,
      index,
      index > this.data.selectedWorkStepIndex ? "enter-up" : "enter-down"
    )
  },
  openCurrentEvidence() {
    const evidence = this.data.currentEvidence
    const project = this.data.project
    if (!evidence || !project || !this.data.selectedSpace) {
      wx.showToast({ title: "当前坐标没有可打开的原件", icon: "none" }); return
    }
    this.saveView("patrol")
    const origin = serializeOriginContext({
      projectId: project.id, originView: "patrol", spaceId: this.data.selectedSpace.id,
      stageId: project.stage, patrolStepId: this.data.selectedWorkStepId, evidenceId: evidence.id,
      anchorId: `evidence-${evidence.id}`, returnToken: `patrol-${Date.now()}`,
      schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
    })
    wx.navigateTo({ url: `/pages/evidence-viewer/index?evidenceId=${encodeURIComponent(evidence.id)}&origin=${origin}` })
  },
  patrolOrigin(anchorId = "patrol-work-panel") {
    const project = this.data.project
    const space = this.data.selectedSpace
    if (!project || !space) return ""
    return serializeOriginContext({
      projectId: project.id,
      originView: "patrol",
      spaceId: space.id,
      stageId: project.stage,
      patrolStepId: this.data.selectedWorkStepId,
      anchorId,
      returnToken: `patrol-${Date.now()}`,
      schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
    })
  },
  openPatrolWorkAction() {
    const action = this.data.workPanel.primaryAction
    if (action === "evidence") return this.openCurrentEvidence()
    const project = this.data.project
    const space = this.data.selectedSpace
    if (!project || !space) return
    this.saveView("patrol")
    const origin = this.patrolOrigin()
    if (action === "records") {
      wx.navigateTo({ url: `/pages/quick-record/index?origin=${origin}` })
      return
    }
    const state = loadState()
    if (action === "material") {
      const receipt = state.receiptBatches.find(item => item.projectId === project.id)
      const material = state.materials.find(item => item.id === receipt?.materialId && item.projectId === project.id)
        || state.materials.find(item => item.projectId === project.id)
      if (!material) {
        wx.navigateTo({ url: "/pages/ledger/index" })
        return
      }
      const batch = receipt?.materialId === material.id ? receipt : state.receiptBatches.find(item => item.materialId === material.id)
      const batchQuery = batch ? `&batchId=${encodeURIComponent(batch.id)}` : ""
      wx.navigateTo({
        url: `/pages/material/index?id=${encodeURIComponent(material.id)}${batchQuery}&origin=${origin}`
      })
      return
    }
    const issues = state.issues.filter(item => item.projectId === project.id && item.spaceId === space.id)
    const issue = this.data.selectedWorkStepId === "review"
      ? issues.find(item => item.status === "pending_review")
      : issues.find(item => item.status !== "closed")
    const target = issue
      ? `id=${encodeURIComponent(issue.id)}`
      : "create=1"
    wx.navigateTo({ url: `/pages/issues/index?${target}&origin=${origin}` })
  },
  openPatrolWorkAi() {
    const { aiTaskId, aiMode } = this.data.workPanel
    const project = this.data.project
    const space = this.data.selectedSpace
    if (!project || !space) return
    this.saveView("patrol")
    const state = loadState()
    const params = [`task=${encodeURIComponent(aiTaskId)}`]
    if (aiMode) params.push(`mode=${encodeURIComponent(aiMode)}`)
    if (aiTaskId === "record_review" || aiTaskId === "image_observation") {
      const evidenceRecordId = this.data.currentEvidence
        ? state.evidenceLinks.find(link => link.projectId === project.id
          && link.evidenceId === this.data.currentEvidence?.id && link.status === "active"
          && link.target.type === "record")?.target.id
        : undefined
      const record = state.records.find(item => item.id === evidenceRecordId && item.projectId === project.id)
        || state.records.find(item => item.projectId === project.id && item.spaceId === space.id)
      if (record) params.push(`recordId=${encodeURIComponent(record.id)}`)
    } else if (aiTaskId === "material_check") {
      const receipt = state.receiptBatches.find(item => item.projectId === project.id)
      const material = state.materials.find(item => item.id === receipt?.materialId && item.projectId === project.id)
        || state.materials.find(item => item.projectId === project.id)
      if (material) params.push(`materialId=${encodeURIComponent(material.id)}`)
      if (receipt && receipt.materialId === material?.id) params.push(`receiptId=${encodeURIComponent(receipt.id)}`)
    } else if (aiTaskId === "rectification") {
      const candidates = state.issues.filter(item => item.projectId === project.id && item.spaceId === space.id)
      const issue = aiMode === "review"
        ? candidates.find(item => item.status === "pending_review")
        : candidates.find(item => item.status !== "closed")
      if (issue) params.push(`issueId=${encodeURIComponent(issue.id)}`)
    }
    wx.navigateTo({ url: `/pages/ai/index?${params.join("&")}` })
  },
  openOverviewRoute(e: WechatMiniprogram.TouchEvent) {
    const route = String(e.currentTarget.dataset.route || "")
    if (!OVERVIEW_ROUTES.has(route)) {
      wx.showToast({ title: "入口暂不可用", icon: "none" })
      return
    }
    wx.navigateTo({ url: route })
  },
  openQuickRecord() { wx.navigateTo({ url: "/pages/quick-record/index" }) },
  openRecords() { wx.navigateTo({ url: "/pages/records/index" }) },
  openEvidenceIndex() { wx.navigateTo({ url: "/pages/evidence/index" }) },
  openSpaces() { wx.navigateTo({ url: "/pages/spaces/index" }) },
  openIssues() { wx.navigateTo({ url: "/pages/issues/index" }) },
  openLedger() { wx.navigateTo({ url: "/pages/ledger/index" }) },
  openMaterial() { wx.navigateTo({ url: "/pages/material/index" }) },
  openCollaboration() { wx.navigateTo({ url: "/pages/collaboration/index" }) },
  openBackup() { wx.navigateTo({ url: "/pages/backup/index" }) },
  openConsultation() { wx.navigateTo({ url: "/pages/consultation/index" }) },
  openKnowledge() { wx.navigateTo({ url: "/pages/knowledge/index" }) },
  openCamera() { wx.navigateTo({ url: "/pages/camera/index" }) },
  openAnalysis() { wx.navigateTo({ url: "/pages/analysis/index" }) },
  openAi() { wx.navigateTo({ url: "/pages/ai/index" }) },
  onAssistantNavigate(e: WechatMiniprogram.CustomEvent<{ action: string }>) {
    if (e.detail.action === "overview") this.showOverview()
    else if (e.detail.action === "patrol") this.continuePatrol()
    else if (e.detail.action === "work-action") this.openPatrolWorkAction()
  },
  openSettings() { wx.navigateTo({ url: "/pages/settings/index" }) },
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) }
})
