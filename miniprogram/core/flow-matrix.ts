import { STAGES, type AppState, type Project, type ProjectStage } from "./domain"
import { receiptSummary } from "./material-flow"

export type FlowDomainId = "renovation"
export type FlowAxis = "stage" | "module"
export type FlowDirection = "left" | "right" | "up" | "down"
export type FlowModuleId = "records" | "agreements" | "materials" | "issues" | "finance" | "evidence"
export type MatrixNodeStatus = "past" | "current" | "upcoming"
export type ProjectRoleLens = "owner" | "family" | "construction" | "supervisor"

export interface FlowModuleDefinition {
  id: FlowModuleId
  label: string
  shortLabel: string
  description: string
  route: string
  actionLabel: string
}

export interface FlowMatrixNode {
  id: string
  projectId: string
  stageIndex: number
  moduleIndex: number
  stage: ProjectStage
  module: FlowModuleDefinition
  status: MatrixNodeStatus
  statusLabel: string
  count: number
  title: string
  summary: string
  scopeNote: string
}

export interface FlowMatrixRow {
  key: string
  label: string
  status: MatrixNodeStatus | "neutral"
  cells: FlowMatrixNode[]
}

export interface FlowMatrixDefinition {
  domainId: FlowDomainId
  domainLabel: string
  stages: readonly ProjectStage[]
  modules: readonly FlowModuleDefinition[]
  nodes: FlowMatrixNode[][]
  currentStageIndex: number
}

export interface MatrixCoordinate {
  stageIndex: number
  moduleIndex: number
}

export interface RolePresentationPolicy {
  id: ProjectRoleLens
  label: string
  focus: string
  permissions: readonly string[]
  defaultView: "flow" | "supervision"
}

export const RENOVATION_MODULES: readonly FlowModuleDefinition[] = [
  { id: "records", label: "现场记录", shortLabel: "记录", description: "发生了什么、由谁记录、在哪个空间", route: "/pages/records/index", actionLabel: "查看现场记录" },
  { id: "agreements", label: "约定决策", shortLabel: "约定", description: "方案、版本、待确认决策与负责人结论", route: "/pages/ledger/index", actionLabel: "查看约定与决策" },
  { id: "materials", label: "材料资源", shortLabel: "材料", description: "计划、采购、到货、使用与缺口", route: "/pages/material/index", actionLabel: "查看材料资源" },
  { id: "issues", label: "问题整改", shortLabel: "问题", description: "发现、预案、处理、复查与关闭", route: "/pages/issues/index", actionLabel: "查看问题整改" },
  { id: "finance", label: "费用预算", shortLabel: "费用", description: "报价、变更、付款、退款与预算差异", route: "/pages/ledger/index", actionLabel: "查看费用预算" },
  { id: "evidence", label: "监控证据", shortLabel: "证据", description: "照片、单据、时间、版本与设备授权", route: "/pages/camera/index", actionLabel: "查看证据与监控" }
]

export const ROLE_PRESENTATION_POLICIES: Record<ProjectRoleLens, RolePresentationPolicy> = {
  owner: {
    id: "owner",
    label: "负责人",
    focus: "待确认决策、风险、预算变化和下一步",
    permissions: ["记录事实", "提出方案", "确认决策", "关闭问题", "管理成员"],
    defaultView: "flow"
  },
  family: {
    id: "family",
    label: "家人",
    focus: "当前进展、讨论、记录和待补资料",
    permissions: ["记录事实", "参与讨论", "提出方案"],
    defaultView: "flow"
  },
  construction: {
    id: "construction",
    label: "施工人员",
    focus: "本人任务、材料交接、施工留痕和整改反馈",
    permissions: ["查看授权范围", "提交记录", "更新本人任务", "提交整改证据"],
    defaultView: "flow"
  },
  supervisor: {
    id: "supervisor",
    label: "监管者",
    focus: "跨节点风险、证据缺口、待复查事项和多地址状态",
    permissions: ["查看授权范围", "标记风险", "提交复查意见"],
    defaultView: "supervision"
  }
}

function nodeStatus(stageIndex: number, currentStageIndex: number): MatrixNodeStatus {
  if (stageIndex < currentStageIndex) return "past"
  if (stageIndex === currentStageIndex) return "current"
  return "upcoming"
}

function countForNode(state: AppState, project: Project, stage: ProjectStage, moduleId: FlowModuleId): number {
  const isCurrentStage = project.stage === stage
  if (moduleId === "records") {
    return state.records.filter(item => item.projectId === project.id && item.stage === stage).length
  }
  if (moduleId === "issues") {
    return state.issues.filter(item => item.projectId === project.id && item.stage === stage && item.status !== "closed").length
  }
  if (moduleId === "agreements") {
    if (!isCurrentStage) return 0
    return state.agreements.filter(item => item.agreement.projectId === project.id).length
  }
  if (moduleId === "materials") {
    if (!isCurrentStage) return 0
    const materials = state.materials.filter(item => item.projectId === project.id).length
    const pendingReceipts = state.receiptBatches.filter(item =>
      item.projectId === project.id && receiptSummary(item).status !== "resolved").length
    return materials + pendingReceipts
  }
  if (moduleId === "finance") {
    if (!isCurrentStage) return 0
    return state.costItems.filter(item => item.projectId === project.id).length
      + state.paymentFacts.filter(item => item.projectId === project.id && item.status === "pending_confirmation").length
      + state.refundFacts.filter(item => item.projectId === project.id && item.status === "pending_confirmation").length
  }
  const attachments = state.records
    .filter(item => item.projectId === project.id && item.stage === stage)
    .reduce((total, item) => total + item.attachments.length, 0)
  return attachments + (isCurrentStage ? state.cameras.filter(item => item.projectId === project.id).length : 0)
}

function summaryForNode(module: FlowModuleDefinition, count: number, status: MatrixNodeStatus): string {
  if (count > 0) return `${count} 项${module.shortLabel}内容可查看或继续处理。`
  if (status === "upcoming") return `尚未进入该阶段，可先查看检查重点并准备${module.shortLabel}资料。`
  if (status === "past") return `该阶段暂无已归档的${module.shortLabel}内容。`
  return `当前阶段尚无${module.shortLabel}内容，可从人工记录开始。`
}

export function buildRenovationMatrix(state: AppState, project: Project): FlowMatrixDefinition {
  const currentStageIndex = Math.max(0, STAGES.indexOf(project.stage))
  const nodes = STAGES.map((stage, stageIndex) => RENOVATION_MODULES.map((module, moduleIndex) => {
    const status = nodeStatus(stageIndex, currentStageIndex)
    const count = countForNode(state, project, stage, module.id)
    const isProjectScoped = ["agreements", "materials", "finance"].includes(module.id)
    return {
      id: `${project.id}:${stage}:${module.id}`,
      projectId: project.id,
      stageIndex,
      moduleIndex,
      stage,
      module,
      status,
      statusLabel: status === "past" ? "已发生" : status === "current" ? "当前" : "下一步",
      count,
      title: `${stage} · ${module.label}`,
      summary: summaryForNode(module, count, status),
      scopeNote: isProjectScoped
        ? "现有数据按项目保存，暂映射到当前阶段；后续补充阶段字段后可精确归位。"
        : "内容按项目与流程阶段共同定位。"
    }
  }))
  return {
    domainId: "renovation",
    domainLabel: "房屋装修",
    stages: STAGES,
    modules: RENOVATION_MODULES,
    nodes,
    currentStageIndex
  }
}

export function matrixRows(matrix: FlowMatrixDefinition, axesSwapped: boolean): FlowMatrixRow[] {
  if (!axesSwapped) {
    return matrix.stages.map((stage, stageIndex) => ({
      key: `stage:${stage}`,
      label: stage,
      status: matrix.nodes[stageIndex][0].status,
      cells: matrix.nodes[stageIndex]
    }))
  }
  return matrix.modules.map((module, moduleIndex) => ({
    key: `module:${module.id}`,
    label: module.shortLabel,
    status: "neutral",
    cells: matrix.stages.map((_stage, stageIndex) => matrix.nodes[stageIndex][moduleIndex])
  }))
}

export function adjacentCoordinate(
  matrix: FlowMatrixDefinition,
  coordinate: MatrixCoordinate,
  direction: FlowDirection,
  axesSwapped: boolean
): MatrixCoordinate | null {
  let { stageIndex, moduleIndex } = coordinate
  const horizontalDelta = direction === "left" ? 1 : direction === "right" ? -1 : 0
  const verticalDelta = direction === "up" ? 1 : direction === "down" ? -1 : 0
  if (axesSwapped) {
    stageIndex += horizontalDelta
    moduleIndex += verticalDelta
  } else {
    moduleIndex += horizontalDelta
    stageIndex += verticalDelta
  }
  if (stageIndex < 0 || stageIndex >= matrix.stages.length) return null
  if (moduleIndex < 0 || moduleIndex >= matrix.modules.length) return null
  return { stageIndex, moduleIndex }
}

