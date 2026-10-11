import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import test from "node:test"

interface MiniProgramConfig {
  pages: string[]
  permission?: Record<string, unknown>
  tabBar?: { list: Array<{ pagePath: string }> }
  usingComponents?: Record<string, string>
}

const read = (path: string) => readFileSync(path, "utf8")

function assertBalancedWxml(path: string, source: string): void {
  const stack: string[] = []
  const clean = source.replace(/<!--[^]*?-->/g, "")
  const tags = clean.matchAll(/<(\/)?([a-zA-Z][\w-]*)\b[^>]*>/g)
  for (const match of tags) {
    const closing = Boolean(match[1])
    const name = match[2]
    const selfClosing = match[0].endsWith("/>")
    if (selfClosing) continue
    if (closing) {
      assert.equal(stack.pop(), name, `${path} 的 </${name}> 未与最近的开始标签匹配`)
    } else {
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [], `${path} 存在未闭合标签`)
}

test("小程序页面文件完整、WXML 标签闭合且事件处理函数存在", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  for (const page of config.pages) {
    const base = `miniprogram/${page}`
    for (const extension of [".ts", ".wxml", ".wxss", ".json"]) {
      assert.ok(existsSync(base + extension), `${base + extension} 不存在`)
    }
    const wxml = read(base + ".wxml")
    const typescript = read(base + ".ts")
    assertBalancedWxml(base + ".wxml", wxml)
    const bindings = wxml.matchAll(
      /\b(?:bindtap|catchtap|bindinput|bindchange|catchchange)="([A-Za-z_$][\w$]*)"/g
    )
    for (const binding of bindings) {
      const handler = binding[1]
      const escaped = handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      assert.match(
        typescript,
        new RegExp(`\\b${escaped}\\s*\\(`),
        `${base}.wxml 引用了不存在的处理函数 ${handler}`
      )
    }
  }
})

test("微信开发者工具兼容配置不包含非法录音声明或显式 TypeScript 扩展名", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  const projectConfig = JSON.parse(read("project.config.json")) as {
    libVersion?: string
    setting?: { useCompilerPlugins?: string[] }
  }
  assert.equal(config.permission?.["scope.record"], undefined)
  assert.notEqual(projectConfig.libVersion, "trial", "普通小程序不应默认使用灰度基础库")
  assert.ok(projectConfig.setting?.useCompilerPlugins?.includes("typescript"))

  const sources = [
    "miniprogram/app.ts",
    ...readdirSync("miniprogram/core", { recursive: true })
      .map(String)
      .filter(path => path.endsWith(".ts"))
      .map(path => `miniprogram/core/${path.replaceAll("\\\\", "/")}`),
    ...config.pages.map(page => `miniprogram/${page}.ts`)
  ]
  for (const source of sources) {
    assert.doesNotMatch(
      read(source),
      /(?:from\s+|import\s*\()["'][^"']+\.ts["']/,
      `${source} 使用了会被开发者工具编译为 .ts.js 的导入路径`
    )
  }
})

test("场景化产品壳不使用固定 TabBar 或 switchTab", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  assert.equal(config.tabBar, undefined)
  for (const page of config.pages) {
    assert.doesNotMatch(
      read(`miniprogram/${page}.ts`),
      /wx\.switchTab\s*\(/,
      `${page} 仍依赖已经取消的固定 TabBar`
    )
  }
})

test("场景主页使用正式拓扑概览、空间与工作环节巡场并注册可拖动半圆入口", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  assert.equal(config.usingComponents?.["ai-assistant"], "/components/ai-assistant/index")
  const dashboard = read("miniprogram/pages/dashboard/index.wxml")
  assert.doesNotMatch(dashboard, /<swiper\b[^>]*bindchange="onSceneChange"/)
  assert.match(dashboard, /class="page overview-page r7-overview-page"/)
  assert.match(dashboard, /class="r7-overview-intro"/)
  assert.match(dashboard, /class="r7-topology"/)
  assert.match(dashboard, /class="r7-focus-sheet"/)
  assert.match(dashboard, /class="r7-bottom-safe"/)
  assert.match(dashboard, /topologySpaces/)
  assert.match(dashboard, /item\.topologyStyle/)
  assert.doesNotMatch(dashboard, /class="focus-card"/, "R7 概览不保留黑色任务卡")
  assert.doesNotMatch(dashboard, /class="resource-drawer"/, "R7 概览不在首屏堆叠项目抽屉")
  assert.match(dashboard, /class="patrol-canvas \{\{transitionClass\}\} /)
  assert.match(dashboard, /class="patrol-location-bar"/)
  assert.match(dashboard, /class="patrol-axis-readout"/)
  assert.match(dashboard, /class="work-rail"/)
  assert.match(dashboard, /\{\{item\.shortLabel\}\}/)
  assert.match(dashboard, /class="evidence-pin"/)
  assert.match(dashboard, /bindtap="selectPatrolWorkStep"/)
  assert.match(dashboard, /class="patrol-work-panel"/)
  assert.match(dashboard, /纵向切工作环节/)
  assert.match(dashboard, /施工阶段不随手势改变/)
  assert.match(dashboard, /selectedWorkStepId/)
  assert.doesNotMatch(dashboard, /selectedStageLabel|selectedStageIndex|stageTrack/)
  assert.doesNotMatch(dashboard, /纵向切过程/)
  assert.doesNotMatch(dashboard, /class="neighbor /, "巡场画布不应再用黑色浮标遮挡空间画面")
  assert.match(dashboard, /bindtap="openCurrentEvidence"/)
  assert.match(dashboard, /class="patrol-view-switch"/, "巡场应能在现场证据与空间示意之间切换")
  assert.match(dashboard, /selectedSpace\.illustrationPath/, "空间示意必须由空间类型映射，不复用空白方框")
  assert.match(dashboard, /非真实户型 · 不作为现场证据/, "空间示意必须明确披露其事实边界")
  assert.match(dashboard, /bindtap="setPatrolMode"/)
  assert.doesNotMatch(dashboard, /class="context-header"/, "概览不应继续使用旧的深色管理卡片")
  assert.doesNotMatch(dashboard, /class="patrol-heading"/, "巡场坐标应收进紧凑工具栏")
  assert.doesNotMatch(dashboard, /class="patrol-toolbar"/, "巡场应使用 R7 的位置栏与双轴读数")
  assert.doesNotMatch(dashboard, /class="journey-map"/, "项目概览不应继续使用旧阶段棋盘")
  assert.doesNotMatch(dashboard, /class="matrix-board"/, "概览不应退回棋盘式表格")
  assert.doesNotMatch(dashboard, /selectedNode/, "巡场不应继续使用阶段×业务模块节点")
  assert.match(dashboard, /bindtouchstart="onTouchStart"/)
  assert.match(dashboard, /catchtouchmove="onTouchMove"/)
  assert.match(dashboard, /bindtouchend="onTouchEnd"/)
  assert.match(dashboard, /bindtap="showOverview"/)
  assert.match(dashboard, /<ai-assistant\b/)
  assert.match(dashboard, /<ai-assistant\b[^>]*id="ai-assistant-dock"/, "巡场 AI 组件应保留稳定的官方自动化测试锚点")
  const dashboardStyles = read("miniprogram/pages/dashboard/index.wxss")
  assert.match(dashboardStyles, /R8-UI-1A production shell/)
  assert.match(dashboardStyles, /\.topology-shape-0/)
  assert.match(dashboardStyles, /\.work-stop\.selected/)
  assert.match(dashboardStyles, /\.patrol-work-panel/)
  assert.doesNotMatch(dashboardStyles, /:not\(/, "WXSS 不应使用开发者工具无法解析的 :not 选择器")
  assert.doesNotMatch(dashboardStyles, /max-content/, "WXSS 不应依赖开发者工具兼容性不稳定的 max-content")

  const base = "miniprogram/components/ai-assistant/index"
  for (const extension of [".ts", ".wxml", ".wxss", ".json"]) {
    assert.ok(existsSync(base + extension), `${base + extension} 不存在`)
  }
  const wxml = read(base + ".wxml")
  const typescript = read(base + ".ts")
  assertBalancedWxml(base + ".wxml", wxml)
  assert.match(wxml, /<movable-area\b/)
  assert.match(
    wxml,
    /<movable-area\b[^>]*wx:if="\{\{!open\}\}"/,
    "展开半圆导航后应移除侧边把手，避免把手叠在圆盘上并抢占触摸"
  )
  assert.match(wxml, /<movable-view\b[^>]*direction="vertical"[^>]*catchtap="toggle"/)
  assert.match(wxml, /class="half-dial"/, "入口应在当前页面展开 R7 半圆导航")
  assert.match(wxml, /class="dock-node /, "半圆应包含可直接进入的图标节点")
  assert.match(wxml, /catchtouchmove="onDialMove"/, "圆盘应支持拖动选择")
  assert.match(wxml, /class="dial-center"/, "半圆应保留表盘轴心")
  assert.match(wxml, /class="dock-caption"/, "半圆应只显示一个当前节点标签")
  assert.match(wxml, /class="trigger-compass"/, "侧边入口应使用指南针式圆形把手")
  assert.doesNotMatch(wxml, /class="dial-context"|轻点进入/, "圆盘中央不得再出现浮卡或二次进入按钮")
  assert.doesNotMatch(wxml, /assistant-bubble|assistant-star|assistant-mask|assistant-space/, "不得保留星形气泡或全屏 AI 菜单")
  assert.match(typescript, /material-ai/)
  assert.match(typescript, /issue-ai/)
  assert.match(typescript, /patrolAiMapping/)
  assert.match(typescript, /task === "project_summary"/)
  assert.match(typescript, /task === "material_check" \|\| task === "budget"/)
  assert.match(typescript, /task === "rectification" \|\| task === "consultation"/)
  assert.match(wxml, /data-task="\{\{item\.task \|\| ''\}\}"/)
  assert.match(wxml, /class="task-spark"/)
  assert.match(typescript, /triggerEvent\("navigate"/)
  assert.match(dashboard, /bindnavigate="onAssistantNavigate"/)
  assert.match(dashboard, /patrol-step-id="\{\{view === 'patrol' \? selectedWorkStepId : ''\}\}"/)
  assert.match(dashboard, /stage-id="\{\{view === 'patrol' \? project\.stage : ''\}\}"/)
  assert.match(dashboard, /space-name="\{\{view === 'patrol' && selectedSpace \? selectedSpace\.name : ''\}\}"/)
  assert.match(dashboard, /record-id="\{\{assistantTargets\.recordId\}\}"/)
  assert.match(read("miniprogram/pages/material/index.wxml"), /context-type="material"/)
  assert.match(read("miniprogram/pages/issues/index.wxml"), /context-type="issue"/)
  const dialStyles = read("miniprogram/components/ai-assistant/rotary-dial.wxss")
  assert.match(dialStyles, /R7 master/)
  assert.match(dialStyles, /@media \(max-width: 360px\)[\s\S]*\.side-trigger[\s\S]*width: 104rpx/)
  assert.doesNotMatch(dialStyles, /:not\(/)
  assert.doesNotMatch(dialStyles, /max-content/)
  const globalStyles = read("miniprogram/app.wxss")
  assert.match(globalStyles, /--green:\s*#0071e3/i, "全局主操作色应为克制的系统蓝")
  for (const match of wxml.matchAll(/\b(?:bindtap|catchtap|bindchange|bindtouchstart|catchtouchmove|bindtouchend|bindtouchcancel)="([A-Za-z_$][\w$]*)"/g)) {
    assert.match(typescript, new RegExp(`\\b${match[1]}\\s*\\(`))
  }
})

test("证据资料与查看器采用原件优先界面并保留安全返回和对象直达", () => {
  const library = read("miniprogram/pages/evidence/index.wxml")
  const viewer = read("miniprogram/pages/evidence-viewer/index.wxml")
  const viewerLogic = read("miniprogram/pages/evidence-viewer/index.ts")
  const viewerStyles = read("miniprogram/pages/evidence-viewer/index.wxss")
  const recordsLogic = read("miniprogram/pages/records/index.ts")
  const issuesLogic = read("miniprogram/pages/issues/index.ts")
  const materialLogic = read("miniprogram/pages/material/index.ts")

  assert.match(library, /class="evidence-heading"/)
  assert.match(library, /class="evidence-summary"/)
  assert.match(library, /class="[^"]*evidence-card[^"]*"[^>]*bindtap="openViewer"/)
  assert.match(viewer, /class="original-stage/)
  assert.match(viewer, /原件 · 不覆盖/)
  assert.match(viewer, /class="viewer-sheet"/)
  assert.match(viewer, /class="viewer-sheet-heading"/)
  assert.match(viewer, /bindtap="showMore"/)
  assert.doesNotMatch(viewer, /class="viewer-heading"/, "证据标题应位于原件下方的白色信息层")
  assert.match(viewer, /class="truth-note"/)
  assert.match(viewer, /bindtap="toggleMetadata"/)
  assert.match(viewer, /bindtap="openAssociation"/)
  assert.match(viewer, /catchtap="removeAssociation"/)
  assert.match(viewer, /不展示旧缓存/)
  assert.match(viewerLogic, /fallbackToOrigin/)
  assert.match(viewerLogic, /\/pages\/records\/index\?id=/)
  assert.match(viewerLogic, /\/pages\/issues\/index\?id=/)
  assert.match(viewerLogic, /\/pages\/material\/index\?id=/)
  assert.match(recordsLogic, /requestedRecordId/)
  assert.match(issuesLogic, /requestedIssueId/)
  assert.match(materialLogic, /requestedBatchId/)
  assert.match(viewerStyles, /R8-UI-1B evidence viewer/)
  assert.doesNotMatch(viewerStyles, /:not\(/)
  assert.doesNotMatch(viewerStyles, /max-content/)
})

test("巡场人工入口携带空间上下文并在目标页安全预填", () => {
  const dashboard = read("miniprogram/pages/dashboard/index.ts")
  const quickRecord = read("miniprogram/pages/quick-record/index.ts")
  const records = read("miniprogram/pages/records/index.ts")
  const issues = read("miniprogram/pages/issues/index.ts")
  const material = read("miniprogram/pages/material/index.ts")
  const recordPage = read("miniprogram/pages/records/index.wxml")
  const issuePage = read("miniprogram/pages/issues/index.wxml")
  const materialPage = read("miniprogram/pages/material/index.wxml")

  assert.match(dashboard, /pages\/quick-record\/index\?origin=/)
  assert.match(dashboard, /pages\/issues\/index\?\$\{target\}&origin=/)
  assert.match(dashboard, /pages\/material\/index\?id=.*&origin=/)
  assert.match(records, /parseOriginContext/)
  assert.match(quickRecord, /parseOriginContext/)
  assert.match(quickRecord, /resolvePatrolEntryContext/)
  assert.match(quickRecord, /spaceIdForRoom/)
  assert.match(records, /resolvePatrolEntryContext/)
  assert.match(records, /spaceIdForRoom/)
  assert.match(issues, /parseOriginContext/)
  assert.match(issues, /resolvePatrolEntryContext/)
  assert.match(material, /returnLabel: entry\?\.accepted \? "‹ 返回巡场"/)
  assert.match(recordPage, /originLabel/)
  assert.match(issuePage, /originLabel/)
  assert.match(materialPage, /材料仍按项目管理/)
})

test("问题页明确区分事实、预案版本与当前执行引用", () => {
  const page = read("miniprogram/pages/issues/index.wxml")
  const logic = read("miniprogram/pages/issues/index.ts")
  assert.match(page, /class="[^"]*fact-card[^"]*"/)
  assert.match(page, /原因、责任和是否合格未由本事实字段确认/)
  assert.match(page, /class="[^"]*process-rail[^"]*"/)
  assert.match(page, /class="fact-evidence"/)
  assert.match(page, /class="process-rail process-rail-vertical"/)
  assert.match(page, /引用 \{\{selected\.activeProposalRef\}\}/)
  assert.match(page, /执行预案：\{\{item\.activeProposalId\}\}/)
  assert.match(logic, /versionLabel: `预案 \$\{index \+ 1\}`/)
  assert.match(logic, /item\.status === "superseded" \? "已替代"/)
})

test("材料人工核对证据列表使用可与 wx:else 配对的条件块", () => {
  const page = read("miniprogram/pages/material/index.wxml")
  assert.match(
    page,
    /<block wx:if="\{\{manualEvidenceLines\.length\}\}">\s*<view class="evidence-line" wx:for=/,
    "证据列表应由独立 wx:if block 包裹，避免 wx:if 与 wx:for 同节点导致 wx:else 编译失败"
  )
  assert.doesNotMatch(
    page,
    /<view wx:if="\{\{manualEvidenceLines\.length\}\}"[^>]*wx:for=/
  )
})

test("材料工作台以当前批次和四字段核对为主并收起完整账本", () => {
  const page = read("miniprogram/pages/material/index.wxml")
  const logic = read("miniprogram/pages/material/index.ts")
  const styles = read("miniprogram/pages/material/index.wxss")

  assert.match(page, /class="material-topbar"/)
  assert.match(page, /class="[^"]*field-table[^"]*"/)
  assert.match(page, /wx:for="\{\{focusReceipt\.fieldRows\}\}"/)
  assert.match(page, /class="[^"]*check-boundary[^"]*"/)
  assert.match(page, /class="comparison-summary"/)
  assert.match(page, /class="focus-actions object-action-dock"/)
  assert.match(page, /class="ledger-toggle" bindtap="toggleLedger"/)
  assert.match(page, /<block wx:if="\{\{showLedger\}\}">/)
  assert.match(page, /class="manual-workbench"/)
  assert.match(page, /showForm !== 'manual-check'/)
  assert.doesNotMatch(page, /class="hero"/)
  assert.match(logic, /fieldRows:/)
  assert.match(logic, /toggleLedger\(\)/)
  assert.match(styles, /R8-UI-1C material workbench/)
  assert.doesNotMatch(styles, /:not\(/)
  assert.doesNotMatch(styles, /max-content/)
})

test("问题工作台以事实和当前生命周期为主并将历史渐进展开", () => {
  const page = read("miniprogram/pages/issues/index.wxml")
  const logic = read("miniprogram/pages/issues/index.ts")
  const styles = read("miniprogram/pages/issues/index.wxss")

  assert.match(page, /class="issue-workbench"/)
  assert.match(page, /class="[^"]*fact-card[^"]*"/)
  assert.match(page, /class="current-step-panel"/)
  assert.match(page, /selected\.latestTreatment/)
  assert.match(page, /selected\.latestReview/)
  assert.match(page, /class="history-toggle" bindtap="toggleHistory"/)
  assert.match(page, /wx:if="\{\{showHistory\}\}" class="history-section"/)
  assert.match(page, /bindtap="openEvidence"/)
  assert.match(page, /bindtap="backFromIssue"/)
  assert.match(page, /class="fact-evidence"/)
  assert.match(page, /class="process-rail process-rail-vertical"/)
  assert.doesNotMatch(page, /class="hero"/)
  assert.doesNotMatch(page, /selected && !showAction/)
  assert.match(logic, /latestTreatment:/)
  assert.match(logic, /latestReview:/)
  assert.match(logic, /toggleHistory\(\)/)
  assert.match(logic, /openEvidence\(/)
  assert.match(styles, /R8-UI-1D issue workbench/)
  assert.doesNotMatch(styles, /:not\(/)
  assert.doesNotMatch(styles, /max-content/)
})

test("辅助页面统一使用正式视觉头部且不回退到旧 hero", () => {
  const pages = [
    "project",
    "settings",
    "collaboration",
    "camera",
    "backup",
    "consultation",
    "knowledge",
    "ledger",
    "ai",
    "records",
    "analysis",
    "spaces"
  ]
  const globalStyles = read("miniprogram/app.wxss")
  assert.match(globalStyles, /\.utility-header\s*\{/)
  assert.match(globalStyles, /\.utility-header::after\s*\{/)
  assert.match(globalStyles, /\.utility-header-compact\s*\{/)
  for (const page of pages) {
    const source = read(`miniprogram/pages/${page}/index.wxml`)
    if (page === "ai") assert.match(source, /class="ai-context-bar"/, "ai 缺少上下文头部")
    else if (page === "records") assert.match(source, /class="records-context-bar"/, "records 缺少上下文头部")
    else if (page === "settings") assert.match(source, /class="settings-nav"/, "settings 缺少个人设置头部")
    else assert.match(source, /class="[^"]*utility-header[^"]*"/, `${page} 缺少统一头部`)
    assert.doesNotMatch(source, /class="(?:hero|settings-hero)(?:\s|\")/, `${page} 仍使用旧头部`)
  }
  const ai = read("miniprogram/pages/ai/index.wxml")
  assert.match(ai, /class="ai-lens"/)
  assert.match(ai, /class="context-ledger"/)
  assert.match(ai, /class="intent-composer"/)
  assert.match(ai, /class="ai-task-stage ai-request-card"/)
  assert.match(ai, /hasProject && !readOnly && showTaskPanel/)
  assert.match(ai, /bindtap="prepareIntent"/)
  const records = read("miniprogram/pages/records/index.wxml")
  assert.match(records, /class="page records-page"/)
  assert.match(records, /class="capture-stage"/)
  assert.match(records, /class="capture-entry-mark"/)
  assert.match(records, /class="record-timeline"/)
  assert.match(records, /class="record-compose-page"/)
  assert.match(records, /showDetails/)
  assert.match(records, /data-next="ai"/)
  assert.doesNotMatch(records, /class="fab"/)
  const settings = read("miniprogram/pages/settings/index.wxml")
  assert.match(settings, /class="profile-stage"/)
  assert.match(settings, /class="service-stage"/)
  assert.match(settings, /showConnectionDetails/)
  assert.doesNotMatch(settings, /class="utility-header"/)
})

test("全局单行输入框保留足够行高且页面禁止横向漂移", () => {
  const globalStyles = read("miniprogram/app.wxss")
  assert.match(globalStyles, /page\s*\{[^}]*overflow-x:\s*hidden/s)
  assert.match(globalStyles, /\.page\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100vw[^}]*overflow-x:\s*hidden/s)
  assert.match(globalStyles, /input\.input\s*\{[^}]*height:\s*88rpx[^}]*padding:\s*0\s+24rpx[^}]*line-height:\s*88rpx/s)
  assert.match(globalStyles, /\.input-placeholder\s*\{[^}]*line-height:\s*88rpx/s)
})

test("十八个产品入口均已注册且可从首页路径到达", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  const expectedPages = [
    "pages/dashboard/index",
    "pages/spaces/index",
    "pages/evidence/index",
    "pages/evidence-viewer/index",
    "pages/quick-record/index",
    "pages/records/index",
    "pages/issues/index",
    "pages/ledger/index",
    "pages/material/index",
    "pages/collaboration/index",
    "pages/backup/index",
    "pages/consultation/index",
    "pages/knowledge/index",
    "pages/camera/index",
    "pages/analysis/index",
    "pages/ai/index",
    "pages/project/index",
    "pages/settings/index"
  ]
  assert.deepEqual([...config.pages].sort(), [...expectedPages].sort())

  const registered = new Set(config.pages)
  const edges = new Map<string, Set<string>>(config.pages.map(page => [page, new Set<string>()]))
  const routePattern = /\/pages\/[A-Za-z0-9_-]+\/index/g
  for (const page of config.pages) {
    for (const match of read(`miniprogram/${page}.ts`).matchAll(routePattern)) {
      const target = match[0].slice(1)
      if (registered.has(target)) edges.get(page)!.add(target)
    }
  }
  const tabs = (config.tabBar?.list || []).map(item => item.pagePath)
  for (const tab of tabs) tabs.forEach(target => edges.get(tab)?.add(target))

  const reached = new Set<string>()
  const pending = [config.pages[0]]
  while (pending.length) {
    const page = pending.shift()!
    if (reached.has(page)) continue
    reached.add(page)
    for (const target of edges.get(page) || []) pending.push(target)
  }
  assert.deepEqual(
    [...registered].filter(page => !reached.has(page)),
    [],
    "存在已注册但无法从首页或底部导航到达的页面"
  )
})

test("自然语言记录入口先保存项目隔离草稿，再显式转入原有正式记录表单", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  const dashboard = read("miniprogram/pages/dashboard/index.ts")
  const records = read("miniprogram/pages/records/index.ts")
  const recordsView = read("miniprogram/pages/records/index.wxml")
  const quick = read("miniprogram/pages/quick-record/index.ts")
  const quickView = read("miniprogram/pages/quick-record/index.wxml")

  assert.ok(config.pages.includes("pages/quick-record/index"))
  assert.match(dashboard, /\/pages\/quick-record\/index\?origin=/)
  assert.match(recordsView, /bindtap="openQuickRecord"/)
  assert.match(quick, /latestOpen\(project\.id\)/)
  assert.match(quick, /\/pages\/records\/index\?create=1&draftId=/)
  assert.match(records, /getForProject\(draftId, project\.id\)/)
  assert.match(records, /markSaved\(this\.data\.requestedDraftId, project\.id, next\.id\)/)
  assert.match(quickView, /本地草稿/)
  assert.match(quickView, /没有创建正式记录/)
  assert.match(quickView, /人工表单/)
})

test("公共界面契约统一管理弹层并为每个弹层提供显式关闭入口", () => {
  const config = JSON.parse(read("miniprogram/app.json")) as MiniProgramConfig
  const globalStyles = read("miniprogram/app.wxss")
  for (const selector of [
    ".sheet-mask",
    ".sheet",
    ".sheet-toolbar",
    ".sheet-handle",
    ".sheet-close",
    ".text-button"
  ]) {
    assert.ok(globalStyles.includes(`${selector} {`), `全局样式缺少 ${selector}`)
  }
  assert.match(globalStyles, /env\(safe-area-inset-bottom\)/)
  assert.match(globalStyles, /@media \(max-width: 360px\)/)

  for (const page of config.pages) {
    const base = `miniprogram/${page}`
    const wxml = read(base + ".wxml")
    const pageStyles = read(base + ".wxss")
    const sheets = [...wxml.matchAll(/class="sheet(?:\s[^"]*)?"/g)].length
    const toolbars = [...wxml.matchAll(/class="sheet-toolbar"/g)].length
    assert.equal(toolbars, sheets, `${base}.wxml 的弹层缺少显式关闭工具栏`)
    assert.doesNotMatch(
      pageStyles,
      /^\.(?:sheet-mask|sheet|sheet-handle|text-button)\s*\{/m,
      `${base}.wxss 重复定义了应由 app.wxss 管理的公共弹层样式`
    )
  }
})
