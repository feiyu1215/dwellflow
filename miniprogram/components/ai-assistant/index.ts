import type { AiTaskKind, AiTaskMode } from "../../core/ai-contract"
import { patrolAiMapping } from "../../core/patrol-ai-map"

const POSITION_KEY = "renovation-r7-dial-position-v1"
const DIAL_SIZE_RPX = 608
const DIAL_RADIUS_RPX = 258
const DIAL_STEP_DEG = 39
const ASSIST_AREA_TOP_RPX = 110
const DIAL_TOP_FROM_TRIGGER_RPX = 328

type DialIcon = "overview" | "patrol" | "evidence" | "attention" | "record" | "issue" | "material" | "ai"

type DialItem = {
  id: string
  label: string
  hint: string
  icon: DialIcon
  action: string
  kind?: "navigation" | "manual" | "ai"
  task?: AiTaskKind
  mode?: AiTaskMode
}

type DialNode = DialItem & {
  visible: boolean
  selected: boolean
  current: boolean
  style: string
}

const OVERVIEW_ITEMS: DialItem[] = [
  { id: "overview", label: "项目概览", hint: "空间、事实缺口与下一步", icon: "overview", action: "overview" },
  { id: "patrol", label: "继续巡场", hint: "返回当前空间与过程", icon: "patrol", action: "patrol" },
  { id: "evidence", label: "证据资料", hint: "查看当前原件与关联", icon: "evidence", action: "evidence" },
  { id: "attention", label: "与你有关", hint: "本人待处理投影", icon: "attention", action: "issues" },
  { id: "ai", label: "AI 对话", hint: "先看上下文，再选任务", icon: "ai", action: "ai" }
]

const MATERIAL_ITEMS: DialItem[] = [
  { id: "material", label: "材料工作台", hint: "当前材料与批次", icon: "material", action: "material" },
  { id: "evidence", label: "证据资料", hint: "到货照片与单据", icon: "evidence", action: "evidence" },
  { id: "check", label: "AI 材料初审", hint: "生成四字段核对草稿", icon: "material", action: "material-ai", kind: "ai", task: "material_check" },
  { id: "issue", label: "相关问题", hint: "查看问题与复查", icon: "issue", action: "issues" },
  { id: "ai", label: "AI 对话", hint: "描述其他材料需求", icon: "ai", action: "ai" }
]

const ISSUE_ITEMS: DialItem[] = [
  { id: "issue", label: "问题时间线", hint: "事实与动作历史", icon: "issue", action: "issues" },
  { id: "evidence", label: "证据资料", hint: "当前问题来源", icon: "evidence", action: "evidence" },
  { id: "assist", label: "AI 整改辅助", hint: "生成预案或复查参考", icon: "issue", action: "issue-ai", kind: "ai", task: "rectification" },
  { id: "record", label: "补充记录", hint: "保存新的现场事实", icon: "record", action: "records" },
  { id: "ai", label: "AI 对话", hint: "描述其他问题需求", icon: "ai", action: "ai" }
]

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const normalize = (value: number, count: number) => ((value % count) + count) % count

function relativeIndex(index: number, selected: number, count: number) {
  let delta = index - selected
  if (delta > count / 2) delta -= count
  if (delta < -count / 2) delta += count
  return delta
}

function patrolItems(stepId: string): DialItem[] {
  const mapping = patrolAiMapping(stepId)
  return [
    { id: "overview", label: "项目概览", hint: "回到项目全局判断", icon: "overview", action: "overview", kind: "navigation" },
    {
      id: `manual-${mapping.stepId}`,
      label: mapping.manualLabel,
      hint: mapping.manualHint,
      icon: mapping.manualIcon,
      action: "work-action",
      kind: "manual"
    },
    ...mapping.shortcuts.map(item => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      icon: item.icon,
      action: "ai-task",
      kind: "ai" as const,
      task: item.task,
      mode: item.mode
    })),
    { id: "ai", label: "AI 对话", hint: "描述需求，再选择对应任务", icon: "ai", action: "ai", kind: "navigation" }
  ]
}

function itemsFor(contextType: string, patrolStepId = "site"): DialItem[] {
  if (contextType === "patrol") return patrolItems(patrolStepId)
  if (contextType === "records") return patrolItems("record")
  if (contextType === "material") return MATERIAL_ITEMS
  if (contextType === "issue") return ISSUE_ITEMS
  return OVERVIEW_ITEMS
}

function defaultIndex(contextType: string) {
  if (contextType === "patrol" || contextType === "records" || contextType === "material" || contextType === "issue") return 2
  return 1
}

function currentAction(contextType: string) {
  if (contextType === "patrol" || contextType === "records") return "work-action"
  if (contextType === "material") return "material"
  if (contextType === "issue") return "issues"
  return "overview"
}

function dialTopFor(y: number, info: WechatMiniprogram.WindowInfo) {
  const pxPerRpx = info.windowWidth / 750
  const preferred = ASSIST_AREA_TOP_RPX * pxPerRpx + y - DIAL_TOP_FROM_TRIGGER_RPX * pxPerRpx
  const dialSize = DIAL_SIZE_RPX * pxPerRpx
  const min = Math.max(info.safeArea?.top || 0, 8)
  const max = Math.max(min, info.windowHeight - dialSize - 8)
  return Math.round(clamp(preferred, min, max))
}

Component({
  properties: {
    projectId: { type: String, value: "" },
    projectName: { type: String, value: "当前项目" },
    contextLabel: { type: String, value: "项目流程概览" },
    contextType: { type: String, value: "overview" },
    objectId: { type: String, value: "" },
    receiptId: { type: String, value: "" },
    issueStatus: { type: String, value: "" },
    patrolStepId: { type: String, value: "site" },
    stageId: { type: String, value: "" },
    spaceName: { type: String, value: "" },
    recordId: { type: String, value: "" },
    materialId: { type: String, value: "" },
    issueId: { type: String, value: "" }
  },
  data: {
    y: 280,
    dialTop: 170,
    open: false,
    selectedIndex: 1,
    nodes: [] as DialNode[],
    selectedLabel: "",
    selectedHint: "",
    selectedPosition: 1,
    ticksStyle: ""
  },
  lifetimes: {
    attached() {
      const info = wx.getWindowInfo()
      const key = `${POSITION_KEY}:${this.properties.projectId || "global"}`
      const saved = wx.getStorageSync<{ y?: number }>(key) || {}
      const y = typeof saved.y === "number" ? saved.y : Math.round(info.windowHeight * .36)
      this.setData({
        y,
        dialTop: dialTopFor(y, info),
        selectedIndex: defaultIndex(this.properties.contextType)
      })
      this.renderDial(0)
    }
  },
  observers: {
    "contextType,objectId,issueStatus,patrolStepId,stageId,spaceName,recordId,materialId,receiptId,issueId"() {
      this.setData({ selectedIndex: defaultIndex(this.properties.contextType) })
      this.renderDial(0)
    }
  },
  methods: {
    noop() {},
    toggle() {
      const interaction = this as unknown as { suppressToggleUntil?: number }
      if ((interaction.suppressToggleUntil || 0) > Date.now()) return
      const open = !this.data.open
      this.setData({ open })
      if (open) this.renderDial(0)
    },
    close() {
      this.setData({ open: false })
    },
    onMove(e: WechatMiniprogram.MovableViewChange) {
      if (e.detail.source !== "touch") return
      const info = wx.getWindowInfo()
      const y = Math.round(e.detail.y)
      ;(this as unknown as { suppressToggleUntil?: number }).suppressToggleUntil = Date.now() + 300
      this.setData({ y, dialTop: dialTopFor(y, info) })
      wx.setStorageSync(`${POSITION_KEY}:${this.properties.projectId || "global"}`, { y })
    },
    renderDial(offsetDeg: number) {
      const items = itemsFor(this.properties.contextType, this.properties.patrolStepId)
      const selectedIndex = normalize(this.data.selectedIndex, items.length)
      const previewIndex = normalize(selectedIndex - Math.round(offsetDeg / DIAL_STEP_DEG), items.length)
      const activeAction = currentAction(this.properties.contextType)
      const nodes: DialNode[] = items.map((item, index) => {
        const angleFromFocus = relativeIndex(index, selectedIndex, items.length) * DIAL_STEP_DEG + offsetDeg
        const radians = (180 + angleFromFocus) * Math.PI / 180
        const x = Math.cos(radians) * DIAL_RADIUS_RPX
        const y = Math.sin(radians) * DIAL_RADIUS_RPX
        const selected = Math.abs(angleFromFocus) < DIAL_STEP_DEG / 2
        return {
          ...item,
          visible: Math.cos(radians) < .25 && Math.abs(angleFromFocus) <= 102,
          selected,
          current: item.action === activeAction,
          style: `transform:translate(-50%,-50%) translate(${x.toFixed(1)}rpx,${y.toFixed(1)}rpx) scale(${selected ? "1.08" : ".92"})`
        }
      })
      const selected = items[previewIndex]
      this.setData({
        nodes,
        selectedLabel: selected.label,
        selectedHint: selected.hint,
        selectedPosition: previewIndex + 1,
        ticksStyle: `transform:rotate(${(-selectedIndex * DIAL_STEP_DEG + offsetDeg).toFixed(1)}deg)`
      })
    },
    onDialStart(e: WechatMiniprogram.TouchEvent) {
      const touch = e.touches[0]
      if (!touch) return
      const interaction = this as unknown as { dialStartY: number; dialOffset: number; dialMoved: boolean }
      interaction.dialStartY = touch.clientY
      interaction.dialOffset = 0
      interaction.dialMoved = false
    },
    onDialMove(e: WechatMiniprogram.TouchEvent) {
      const touch = e.touches[0]
      const interaction = this as unknown as { dialStartY: number; dialOffset: number; dialMoved: boolean }
      if (!touch || typeof interaction.dialStartY !== "number" || Number.isNaN(interaction.dialStartY)) return
      const dy = touch.clientY - interaction.dialStartY
      if (Math.abs(dy) > 4) interaction.dialMoved = true
      if (!interaction.dialMoved) return
      interaction.dialOffset = clamp(dy * .42, -100, 100)
      this.renderDial(interaction.dialOffset)
    },
    onDialEnd() {
      const interaction = this as unknown as {
        dialStartY: number
        dialOffset: number
        dialMoved: boolean
        suppressNodeTapUntil?: number
      }
      const items = itemsFor(this.properties.contextType, this.properties.patrolStepId)
      if (interaction.dialMoved) {
        const selectedIndex = normalize(
          this.data.selectedIndex - Math.round((interaction.dialOffset || 0) / DIAL_STEP_DEG),
          items.length
        )
        interaction.suppressNodeTapUntil = Date.now() + 340
        this.setData({ selectedIndex })
      }
      interaction.dialStartY = NaN
      interaction.dialOffset = 0
      interaction.dialMoved = false
      this.renderDial(0)
    },
    onDialCancel() {
      const interaction = this as unknown as { dialStartY: number; dialOffset: number; dialMoved: boolean }
      interaction.dialStartY = NaN
      interaction.dialOffset = 0
      interaction.dialMoved = false
      this.renderDial(0)
    },
    tapNode(e: WechatMiniprogram.TouchEvent) {
      const interaction = this as unknown as { suppressNodeTapUntil?: number }
      if ((interaction.suppressNodeTapUntil || 0) > Date.now()) return
      const index = Number(e.currentTarget.dataset.index)
      const action = String(e.currentTarget.dataset.action || "")
      const task = String(e.currentTarget.dataset.task || "") as AiTaskKind | ""
      const mode = String(e.currentTarget.dataset.mode || "") as AiTaskMode | ""
      if (Number.isInteger(index)) this.setData({ selectedIndex: index })
      this.activate(action, task, mode)
    },
    activate(action: string, task: AiTaskKind | "" = "", mode: AiTaskMode | "" = "") {
      if (task) {
        const params = [`task=${encodeURIComponent(task)}`]
        const effectiveMode = mode || (task === "rectification" && this.properties.contextType === "issue"
          ? this.properties.issueStatus === "pending_review" ? "review" : "proposal"
          : "")
        if (effectiveMode) params.push(`mode=${encodeURIComponent(effectiveMode)}`)
        const recordId = this.properties.recordId
        const materialId = this.properties.materialId
          || (this.properties.contextType === "material" ? this.properties.objectId : "")
        const issueId = this.properties.issueId
          || (this.properties.contextType === "issue" ? this.properties.objectId : "")
        if ((task === "record_review" || task === "image_observation") && recordId) {
          params.push(`recordId=${encodeURIComponent(recordId)}`)
        }
        if ((task === "material_check" || task === "budget") && materialId) {
          params.push(`materialId=${encodeURIComponent(materialId)}`)
          if (this.properties.receiptId) params.push(`receiptId=${encodeURIComponent(this.properties.receiptId)}`)
        }
        if ((task === "rectification" || task === "consultation") && issueId) {
          params.push(`issueId=${encodeURIComponent(issueId)}`)
        }
        if (task === "project_summary") {
          if (this.properties.stageId) params.push(`stage=${encodeURIComponent(this.properties.stageId)}`)
          if (this.properties.spaceName) params.push(`room=${encodeURIComponent(this.properties.spaceName)}`)
        }
        this.close()
        wx.navigateTo({ url: `/pages/ai/index?${params.join("&")}` })
        return
      }
      if ((this.properties.contextType === "material" && action === "material")
        || (this.properties.contextType === "issue" && action === "issues" && this.properties.objectId)
        || (this.properties.contextType === "records" && action === "work-action")) {
        this.close()
        return
      }
      if (action === "overview" || action === "patrol" || action === "work-action") {
        this.close()
        this.triggerEvent("navigate", { action })
        return
      }
      const routes: Record<string, string> = {
        evidence: "/pages/evidence/index",
        records: "/pages/records/index",
        issues: (this.properties.issueId || this.properties.objectId)
          ? `/pages/issues/index?id=${encodeURIComponent(this.properties.issueId || this.properties.objectId)}`
          : "/pages/issues/index",
        material: (this.properties.materialId || (this.properties.contextType === "material" ? this.properties.objectId : ""))
          ? `/pages/material/index?id=${encodeURIComponent(this.properties.materialId || this.properties.objectId)}`
          : "/pages/ledger/index",
        ai: "/pages/ai/index",
        settings: "/pages/settings/index",
        project: "/pages/project/index",
        camera: "/pages/camera/index",
        ledger: "/pages/ledger/index"
      }
      const url = routes[action]
      if (!url) return
      this.close()
      wx.navigateTo({ url })
    }
  }
})
