import type { AiTaskKind, AiTaskMode } from "./ai-contract"
import { isPatrolWorkStepId, type PatrolWorkStepId } from "./patrol-navigation"

export type PatrolShortcutIcon = "record" | "evidence" | "material" | "issue" | "attention" | "overview"

export interface PatrolAiShortcut {
  id: string
  label: string
  hint: string
  task: AiTaskKind
  mode?: AiTaskMode
  icon: PatrolShortcutIcon
}

export interface PatrolAiMapping {
  stepId: PatrolWorkStepId
  manualLabel: string
  manualHint: string
  manualIcon: PatrolShortcutIcon
  shortcuts: readonly PatrolAiShortcut[]
}

const MAPPINGS: Record<PatrolWorkStepId, PatrolAiMapping> = {
  site: {
    stepId: "site",
    manualLabel: "当前现场",
    manualHint: "查看原件；没有原件时先记录",
    manualIcon: "evidence",
    shortcuts: [
      { id: "site-image", label: "图片辅助分析", hint: "只描述可见现象并提出补拍建议", task: "image_observation", icon: "evidence" },
      { id: "site-record", label: "整理现场资料", hint: "提取事实、来源和待补信息", task: "record_review", icon: "record" }
    ]
  },
  record: {
    stepId: "record",
    manualLabel: "现场记录",
    manualHint: "拍照、语音或文字保存事实",
    manualIcon: "record",
    shortcuts: [
      { id: "record-review", label: "AI 整理记录", hint: "形成可逐项纠正的事实草稿", task: "record_review", icon: "record" },
      { id: "record-image", label: "观察记录图片", hint: "标出疑点，不判断责任或质量", task: "image_observation", icon: "evidence" }
    ]
  },
  check: {
    stepId: "check",
    manualLabel: "材料工作台",
    manualHint: "对照批准基线、到货与库存",
    manualIcon: "material",
    shortcuts: [
      { id: "check-material", label: "AI 材料核对", hint: "整理品牌、型号、规格与数量", task: "material_check", icon: "material" },
      { id: "check-budget", label: "预算与资源", hint: "提取参数后交由程序计算", task: "budget", icon: "attention" }
    ]
  },
  resolve: {
    stepId: "resolve",
    manualLabel: "问题处理",
    manualHint: "查看事实、预案与实际处理",
    manualIcon: "issue",
    shortcuts: [
      { id: "resolve-plan", label: "AI 整改预案", hint: "只生成待选方案，由负责人采用", task: "rectification", mode: "proposal", icon: "issue" },
      { id: "resolve-consult", label: "准备外部咨询", hint: "整理问题与固定资料范围，不自动发送", task: "consultation", mode: "prepare", icon: "attention" }
    ]
  },
  review: {
    stepId: "review",
    manualLabel: "负责人复查",
    manualHint: "核对处理依据并决定退回或关闭",
    manualIcon: "issue",
    shortcuts: [
      { id: "review-reference", label: "AI 复查参考", hint: "区分可见变化与仍待现场核实", task: "rectification", mode: "review", icon: "issue" },
      { id: "review-summary", label: "项目阶段总结", hint: "整理未解决事项与交接缺口", task: "project_summary", icon: "overview" }
    ]
  }
}

export function patrolAiMapping(stepId: string | undefined): PatrolAiMapping {
  return MAPPINGS[isPatrolWorkStepId(stepId) ? stepId : "site"]
}

export function mappedPatrolAiTasks(): AiTaskKind[] {
  return [...new Set(Object.values(MAPPINGS).flatMap(item => item.shortcuts.map(shortcut => shortcut.task)))]
}
