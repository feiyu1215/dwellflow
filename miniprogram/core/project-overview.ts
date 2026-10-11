import { STAGES, type AppState, type Project } from "./domain"
import { receiptSummary } from "./material-flow"

export interface ProjectOverviewFocus {
  kind: "review" | "decision" | "receipt" | "agreement" | "finance" | "record"
  eyebrow: string
  title: string
  summary: string
  actionLabel: string
  route: string
  count: number
}

export interface ProjectFlowMoment {
  kind: "past" | "current" | "next"
  label: string
  stage: string
  summary: string
}

export interface ProjectResourceEntry {
  id: string
  label: string
  description: string
  route: string
  countLabel: string
}

export interface ProjectOverviewModel {
  readonly: boolean
  statusLabel: string
  focus: ProjectOverviewFocus
  moments: ProjectFlowMoment[]
  resources: ProjectResourceEntry[]
}

function projectCount<T extends { projectId: string }>(items: readonly T[], projectId: string): number {
  return items.filter(item => item.projectId === projectId).length
}

function focusFor(state: AppState, project: Project): ProjectOverviewFocus {
  const issues = state.issueWorkflows.filter(item => item.projectId === project.id)
  const reviewCount = issues.filter(item => item.status === "pending_review").length
  if (reviewCount) return {
    kind: "review",
    eyebrow: "现在需要负责人处理",
    title: `${reviewCount} 个问题等待复查`,
    summary: "先核对处理说明和现有证据，再决定关闭或退回。",
    actionLabel: "进入问题复查",
    route: "/pages/issues/index",
    count: reviewCount
  }
  const decisionCount = issues.filter(item => item.status === "pending_confirmation").length
  if (decisionCount) return {
    kind: "decision",
    eyebrow: "现在需要负责人处理",
    title: `${decisionCount} 个问题等待确认预案`,
    summary: "参与者可以提出方案，采用哪一个仍由负责人决定。",
    actionLabel: "查看待确认问题",
    route: "/pages/issues/index",
    count: decisionCount
  }
  const receiptCount = state.receiptBatches.filter(item =>
    item.projectId === project.id && receiptSummary(item).status !== "resolved").length
  if (receiptCount) return {
    kind: "receipt",
    eyebrow: "现在需要核对",
    title: `${receiptCount} 批材料尚未处理完成`,
    summary: "到货记录不会自动进入可用库存，需要核对数量和处理去向。",
    actionLabel: "核对材料到货",
    route: "/pages/material/index",
    count: receiptCount
  }
  const agreementCount = state.agreements.filter(item =>
    item.agreement.projectId === project.id
    && item.versions.some(version => version.status === "pending_confirmation")).length
  if (agreementCount) return {
    kind: "agreement",
    eyebrow: "现在需要负责人处理",
    title: `${agreementCount} 份约定等待确认`,
    summary: "确认前先核对版本、来源和冲突项，批准后才成为当前基线。",
    actionLabel: "查看材料约定",
    route: "/pages/material/index",
    count: agreementCount
  }
  const financeCount = state.paymentFacts.filter(item =>
    item.projectId === project.id && item.status === "pending_confirmation").length
    + state.refundFacts.filter(item =>
      item.projectId === project.id && item.status === "pending_confirmation").length
  if (financeCount) return {
    kind: "finance",
    eyebrow: "现在需要负责人处理",
    title: `${financeCount} 条付款或退款事实等待确认`,
    summary: "报价、批准、付款和退款保持分开，确认前不会改变已批准金额。",
    actionLabel: "查看费用事实",
    route: "/pages/ledger/index",
    count: financeCount
  }
  const recordCount = projectCount(state.records, project.id)
  return {
    kind: "record",
    eyebrow: recordCount ? "继续当前阶段" : "从第一条现场事实开始",
    title: recordCount ? `记录 ${project.stage} 阶段的新变化` : "拍照或文字记录现在发生的事",
    summary: "记录只保存事实和来源，不会自动推进阶段或作出质量判断。",
    actionLabel: recordCount ? "继续记录现场" : "创建第一条记录",
    route: "/pages/records/index",
    count: recordCount
  }
}

function flowMoments(project: Project): ProjectFlowMoment[] {
  const currentIndex = Math.max(0, STAGES.indexOf(project.stage))
  const previous = currentIndex > 0 ? STAGES[currentIndex - 1] : "暂无前序阶段"
  const next = currentIndex < STAGES.length - 1 ? STAGES[currentIndex + 1] : "交付与复盘"
  return [
    {
      kind: "past",
      label: "已发生",
      stage: previous,
      summary: currentIndex > 0 ? "回看此前阶段留下的记录、问题和约定。" : "项目尚未进入正式施工阶段。"
    },
    {
      kind: "current",
      label: "现在",
      stage: project.stage,
      summary: "当前阶段来自项目设置，不代表所有空间已经同步完成。"
    },
    {
      kind: "next",
      label: "下一步",
      stage: next,
      summary: "可提前准备检查项和材料，实际推进仍由负责人确认。"
    }
  ]
}

function resourceEntries(state: AppState, project: Project): ProjectResourceEntry[] {
  const openIssues = state.issueWorkflows.filter(item =>
    item.projectId === project.id && item.status !== "closed").length
  const materials = projectCount(state.materials, project.id)
  const financeFacts = projectCount(state.costItems, project.id)
    + projectCount(state.paymentFacts, project.id)
    + projectCount(state.refundFacts, project.id)
  const activeMembers = state.members.filter(item =>
    item.projectId === project.id && item.status === "active").length
  const consultations = state.consultations.filter(item =>
    item.projectId === project.id && item.status !== "closed").length
  return [
    { id: "spaces", label: "空间与现场", description: "房间身份、顺序、阶段状态和旧标签归属", route: "/pages/spaces/index", countLabel: `${(state.spaces || []).filter(item => item.projectId === project.id && item.status === "active").length} 个空间` },
    { id: "evidence", label: "证据原件", description: "原件完整性、来源状态和业务关联", route: "/pages/evidence/index", countLabel: `${(state.evidenceAssets || []).filter(item => item.projectId === project.id && item.status !== "hidden").length} 项` },
    { id: "records", label: "现场记录", description: "照片、文字、语音与历史版本", route: "/pages/records/index", countLabel: `${projectCount(state.records, project.id)} 条` },
    { id: "issues", label: "问题与复查", description: "事实、预案、处理和负责人决定", route: "/pages/issues/index", countLabel: `${openIssues} 个进行中` },
    { id: "materials", label: "材料与约定", description: "约定、采购、到货、库存与使用", route: "/pages/material/index", countLabel: `${materials} 种材料` },
    { id: "finance", label: "预算与费用", description: "报价、批准、付款和退款分别留档", route: "/pages/ledger/index", countLabel: `${financeFacts} 条事实` },
    { id: "members", label: "成员与协作", description: "角色、资料交接和限定分享", route: "/pages/collaboration/index", countLabel: `${activeMembers} 位参与者` },
    { id: "consultation", label: "外部咨询", description: "固定资料范围、回填回复和采用记录", route: "/pages/consultation/index", countLabel: `${consultations} 个进行中` },
    { id: "knowledge", label: "检查参考", description: "本地知识卡、步骤和来源", route: "/pages/knowledge/index", countLabel: "本地可用" },
    { id: "camera", label: "设备与监控", description: "查看接入条件和设备授权状态", route: "/pages/camera/index", countLabel: state.cameras.some(item => item.projectId === project.id) ? `${projectCount(state.cameras, project.id)} 台` : "尚未接入" },
    { id: "backup", label: "备份与导出", description: "项目备份、限定阅读和恢复预检", route: "/pages/backup/index", countLabel: "项目级" }
  ]
}

export function buildProjectOverview(state: AppState, project: Project): ProjectOverviewModel {
  return {
    readonly: project.status === "archived",
    statusLabel: project.status === "archived" ? "项目已归档，仅可查看历史资料" : "项目进行中",
    focus: focusFor(state, project),
    moments: flowMoments(project),
    resources: resourceEntries(state, project)
  }
}
