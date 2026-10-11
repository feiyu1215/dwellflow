# 装修同步 · UI 转化交付文档

> 适用：原生微信小程序 `renovation-sync-miniprogram`（TypeScript + WXML/WXSS，14 页）
> 目的：把"找 UI 设计图 / 别人的画册 → 转化"这件事落成**可直接落地的规范**。
> 背景：ARDOT 画布因账号登录问题暂不可用，本文档为自包含交付物，不依赖画布文件。
> 交互三原语（冻结，不动）：7×6 工序矩阵 · 四向手势导航 · 悬浮 AI 助手。

---

## 0. 结论（先看这句）

1. **核心是巡查，不是场景选择**。前面把首屏画成"场景选择"是偏差，已纠正。
2. **不要再问"写实还是非写实"** —— 这是我方自己造的二元框，owner 从头到尾没在这个维度上想。正確的取舍标准是：**好的设计不必写实，也不必纠结 2D/3D**。
   - ✅ **可用（方向）**：手绘、插画、素描稿、纸绘线条、轴测（isometric —— 在二维上表现三维感）
   - ❌ **不用 3D 模型**：真实理由是**做好 3D 难度太高、成本不可控**。要用就用网上公开素材，别自己建模
   - 🟡 **卡通风是迫不得已的兜底**，不是目标
3. **空间视觉三层**（`装修同步_空间视觉三层方案.html`）：
   - **① 选户型**（一室一厅 / 二室一厅 / 三室一厅）→ 自动出房间分布预览
   - **② 在这张图上巡场** —— 各房间状态不同（未开始 / 施工中 / 已通过 / 有缺陷）
   - **③ 进到具体房间** → 2D 纸绘风房间，带轴测体积感
4. **巡查节点 ICON 是另外一层**（水电 / 防水 / 泥瓦…），与空间图分开管，别混。
5. **素材策略**：用 `laanlabs/openPlan3D`（MIT）当"资产工厂"生产户型几何 → 导出 SVG → 换成我们自己的纸绘语言。**它不进小程序**（守住禁 WebGL/Three.js 的冻结线）。详见 `装修同步_公开素材调研_2026-10-02.md`。

> ⚠️ 本文件早期版本里"主体场景 = 真实写实 / 必须实拍或写实渲染"的表述**已作废**，请不要沿用。

---

## 1. 巡查的图像条件清单（精确版）

把"图像"拆成 5 类，逐类说清：要不要、用什么画法表达、要什么、从哪转化、落到哪个组件。

| # | 类别 | 画法 | 巡查要不要图 | 要什么 | 转化来源 | 落地组件 |
|---|---|---|---|---|---|---|
| 0 | **户型 / 房间分布**（选几室一厅后自动出） | 二维绘画（轴测/纸绘） | 要 | 能认出房间分布、有空间感的户型预览图 | `openPlan3D`(MIT) 导出 SVG → 换成纸绘语言渲染；或 SVGRepo 的 CC0 矢量房间 | `户型图` 组件（选完户型即显示） |
| 0b | **具体房间**（进入单个房间后） | 二维绘画（纸绘 + 轴测体积感） | 要 | 纸绘感的房间，带家具与巡查点标注 | 同上，生成器出几何 + 手绘渲染 | `房间图` 组件 |

> ⚠️ 早期版本此处写"真实写实 / 用户自家实拍 / 写实渲染"，**已作废**。装修巡查需要的是**成其为房子**，不是照片级真实。用插画 / 手稿 / 纸绘达成即可。
| 1 | 空间定位感（矩阵） | 纯代码 UI | 要，但不必是房子 | 抽象方位感；7×6 矩阵（工序纵轴/模块横轴/时态深度）本身就是空间定位系统 | 矩阵即底图 | `矩阵`(主) |
| 2 | 节点标准 ICON | **二维示意/线描** | 要 | 每节点"合格样 + 缺陷样"示意图标（约 8–12 张） | 施工规范图集 / 家装画册，取"标准做法"语义转统一示意风 | `节点 ICON` 资源库 |
| 3 | 问题标注层 | 不要素材 | — | pin / 严重程度点 / 引线，纯 UI 画 | `标注层` |
| 4 | 状态 / 进度可视化 | 不要素材 | — | 矩阵 / 旅程 / 置信环，数据可视化 | `矩阵` / `旅程` / `置信环` |
| 5 | AI 延迟定型 / 自主度 | 不要素材 | — | provisional type + 置信度 + 青点 | `AI 提议卡` / `自主度徽标` |

→ **"图像条件"收敛为：主体场景写实（房子本身）+ 一组非写实节点 ICON + 其余代码 UI**。前两类才是"图"，且性质相反：场景必须写实，ICON 必须非写实。

### 1.1 关键区分：工地 ≠ 房子
- **房子 / 建筑 / 主体场景 = 装修的主角，必须真实写实**。用户要看的是"我的家"，抽象分割表达不了它——所以这一层"非写实"管不到。
- **工地（施工进行中的现场）= 不是风景、不必写实**。之前"深海是风景、工地不是"只针对工地这层，不要误扩到房子。
- **UGC 现场照**（用户巡查时拍"这里空鼓 / 那里漏水"）= 运行时产生的功能数据，UI 用缩略图框接住即可，设计阶段不碰真实照片、也不强行写实。

---

## 2. 参考来源 → 转化映射

这些是**风格来源标注**（说明视觉语言从哪借），**不是必须逐个去扒的清单**——你已指出不必四处搜罗，实际交付不依赖访问它们。按"工具型 + 空间感 + 信息密度"筛的，来自参考知识库，未实时截图。

| 参考（真实产品 / 画册） | 对口能力 | 转化到本项目的什么 |
|---|---|---|
| **酷家乐 / 住小帮 / MagicPlan** | 空间矢量底图的处理方式：浅灰线稿 + 单一强调色标注 | 「巡查底图」组件（户型线稿 + 绿色标注） |
| **Fieldwire / 施工规范图集 / 筑龙** | 巡检清单 + 节点标准对照图（线性插画） | 「节点标准插画库」+「巡查卡片」 |
| **Buildertrend / 明源云** | 工程进度状态可视化（看板 / 时间线 / 百分比） | 「矩阵 + 旅程」状态层 |
| **Dala / Krea / Immersive Garden**（前轮已真看） | 排版与材质工艺（A/B/C 层）：宋黑字体对撞、留白、纸感、单一视觉原子 | 全局排版与色彩纪律 |

> 四类里，前三类解决"巡查要的图从哪来"（转化对象），第四类解决"图以外 90% 的精细感怎么来"（纪律）。

---

## 3. 设计系统（可直接落 `app.wxss`）

### 3.1 Token（小程序用 rpx，基准 750；括号内为 px 等量，便于设计稿对照）

**间距（4pt 网格，rpx）**
```
--sp-1: 8    --sp-2: 16   --sp-3: 24   --sp-4: 32
--sp-5: 48   --sp-6: 64
```
> 现状病灶：8~34 偶数全用、无网格。全部收口到上面 6 档。

**字阶（rpx，宋黑对撞）**
```
--fs-display: 56   /* 宋体大标题 */
--fs-title:   40   /* 宋体标题 */
--fs-h1:      32   /* 黑体 H1 */
--fs-body:    28   /* 黑体正文 */
--fs-sub:     24   /* 黑体次要 */
--fs-cap:     20   /* 黑体说明 */
```
> 现状病灶：22/23/24/25/26/28/32/43/52 九档挤在 2px 内。收口到 6 级。

**圆角层级（rpx）**
```
--r-sm: 8   --r-md: 16   --r-lg: 24   --r-pill: 999
```
> 现状：20/28/999 无层级。卡片=md(16)，大块=lg(24)，药丸=pill。

**色彩**
```
--bg:         #F6F5F2   /* 纸感暖白，替代纯白 #FFFFFF */
--surface:    #FFFFFF   /* 卡面 */
--ink:        #1C1B19   /* 主文字，非纯黑 */
--sub:        #6F6B63   /* 次级文字（暖灰） */
--faint:      #9C978E   /* 说明 / 图例 */
--line:       #E7E4DE   /* 发丝描边 */
--accent:     #0E7C66   /* 修正后的"绿"——原名 --green 值是蓝 #0071e3，名实不符 */
--accent-soft:#E7F1ED   /* 绿色浅底 */
--learned:    #14B8A6   /* 青点 = AI 已学会自主处理 */
```

**描边 / 阴影**
```
--hairline: 1rpx solid rgba(0,0,0,.06)          /* 替代硬编码 #efede6 */
--shadow-card: 0 8rpx 24rpx rgba(0,0,0,.04)     /* 单层微投影，替代无层级投影 */
```

### 3.2 字体对撞（中文可行方案）
- **宋体（衬线，做 Display / Title）**：设计稿用 `Noto Serif SC` / `思源宋体`；小程序真机用系统 `Songti SC`（iOS）/ `宋体`（Android）。
- **黑体（无衬线，做正文 / 数据）**：设计稿用 `Noto Sans SC` / `思源黑体`；小程序真机用系统 `PingFang SC`。
- **中文无 italic**：用**字重对比**替代（宋体 Bold 大标题 × 黑体 Regular 正文），不靠倾斜。
- 一处对撞即足够，全局不超过"宋体标题 + 黑体正文"两种角色。

### 3.3 单一视觉原子纪律
- 全 app 只有**一种视觉原子 = 绿色圆角方块**（矩阵格 / 焦点 / 状态都用它的变体）。
- 禁止引入第二种装饰语言（无 logo 墙、无渐变卡片、无第二种强调色）。

---

## 4. `app.wxss` 改造（可直接粘贴）

```css
/* ===== 设计令牌（收口版） ===== */
page {
  --sp-1: 8rpx;  --sp-2: 16rpx; --sp-3: 24rpx; --sp-4: 32rpx;
  --sp-5: 48rpx; --sp-6: 64rpx;
  --fs-display: 56rpx; --fs-title: 40rpx; --fs-h1: 32rpx;
  --fs-body: 28rpx; --fs-sub: 24rpx; --fs-cap: 20rpx;
  --r-sm: 8rpx; --r-md: 16rpx; --r-lg: 24rpx; --r-pill: 999rpx;
  --bg: #F6F5F2; --surface: #FFFFFF; --ink: #1C1B19;
  --sub: #6F6B63; --faint: #9C978E; --line: #E7E4DE;
  --accent: #0E7C66; --accent-soft: #E7F1ED; --learned: #14B8A6;
  --hairline: 1rpx solid rgba(0,0,0,.06);
  --shadow-card: 0 8rpx 24rpx rgba(0,0,0,.04);
  background: var(--bg);
  font-family: "PingFang SC", "Noto Sans SC", sans-serif;
  color: var(--ink);
}

/* 卡片：单一圆角 + 发丝描边 + 微投影 */
.card {
  background: var(--surface);
  border-radius: var(--r-md);
  border: var(--hairline);
  box-shadow: var(--shadow-card);
  padding: var(--sp-3);
}

/* 矩阵格：唯一视觉原子 */
.cell {
  width: 80rpx; height: 80rpx;
  border-radius: var(--r-sm);
  background: var(--bg);
  border: var(--hairline);
}
.cell--path  { background: var(--accent-soft); border-color: var(--accent); }
.cell--focus { background: var(--accent); }
.cell--learned::after {
  content: ""; width: 12rpx; height: 12rpx; border-radius: 50%;
  background: var(--learned); /* 青点 = 已学会自主处理 */
}

/* 宋体 Display 标题 */
.display {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-weight: 700; font-size: var(--fs-display); color: var(--ink);
}
```

> 这条 `--green:#0071e3` 名实不符，本改造里直接改名 `--accent:#0E7C66`，顺手修掉。

---

## 5. WXML 结构建议（三处核心，骨架不动）

### 5.1 矩阵（7×6）—— 巡查的主导航
```xml
<!-- 仍是 scroll-view 承载的 7 行 × 6 列，但每格是 .cell 变体，不再用 view 层叠 CSS 画房子 -->
<view class="matrix">
  <view class="matrix__row" wx:for="{{rows}}" wx:for-item="row">
    <view class="cell {{cell.state}}" wx:for="{{row.cells}}" wx:for-item="cell"
          bindtap="onFocusCell">
      <view wx:if="{{cell.learned}}" class="cell__learned" />
    </view>
  </view>
</view>
```
- 手势不变：左右滑切模块 / 上下滑切工序。
- 视觉：格=圆角方块，focus=实心绿，path=绿浅底，learned=青点。

### 5.2 巡查卡片（Reading 层，零探索、15 秒办完）
```xml
<!-- 点任意格 → 其余退场 + 这张卡显示：节点名 / 标准线描 / AI 提议 / 可执行动作 -->
<view class="card inspect-card">
  <view class="display inspect-card__title">{{node.name}}</view>
  <image class="inspect-card__ref" src="{{node.standardLine}}" mode="aspectFit" />
  <view class="ai-proposal">
    <text>AI 建议：{{proposal.type}}（置信 {{proposal.conf}}）</text>
    <view class="confidence-ring" style="--p:{{proposal.conf}}" />
  </view>
  <view class="actions"><button>采纳</button><button>改判</button></view>
</view>
```
- `standardLine` 来自"节点标准线描插画库"（第 1 节 #2），是**线描资源**，不是照片。
- 改判复用四向手势（已定方案），不新增手势。

### 5.3 标注层（覆盖在矢量底图上）
```xml
<!-- 空间矢量底图 + 问题 pin；pin 颜色编码严重程度 -->
<view class="site-map">
  <image class="site-map__plan" src="{{floorPlanSvg}}" mode="widthFix" />
  <view class="pin pin--high"  style="left:{{p.x}};top:{{p.y}}" wx:for="{{pins}}" />
</view>
```
- `floorPlanSvg` 来自酷家乐 / 住小帮导出，是**矢量线稿**，不是照片。

---

## 6. 待你在真机 / 正确账号确认的清单

- [ ] 字体对撞：真机 `Songti SC` 是否可用（Android 回退到 `Noto Serif SC` 需引包？）
- [ ] 绿色 `--accent:#0E7C66` 是否合眼缘（可换更深的 `#0B5E4E`）
- [ ] 矩阵格 80rpx 在 750 基准下 6 列是否拥挤（必要时降到 72rpx）
- [ ] 矢量底图来源：用户能否从酷家乐 / 住小帮导出自家户型 SVG
- [ ] 节点标准线描插画：是否要我按"水电 / 防水 / 泥瓦 / 木工 / 油漆"等画一版统一线描
- [ ] ARDOT 账号登录后可否打开 fileId `731631125247347`（Screen A 已建一半，可续）

---

## 附：本轮回应的偏差修正
1. **首屏不画"场景选择"，核心是巡查** —— 已改。
2. **"工地照片必须真实"删掉，但"房子必须写实"加上** —— 深海是风景、工地不是，所以工地照不必写实；但**房子/建筑/主体场景是装修主角，必须真实写实**。两者别混。
3. **分层：主体场景写实 + 节点 ICON 非写实** —— 房子/建筑/空间必须真实写实（我之前把非写实误用到整个东西、连房子都让别写实，错）；巡查节点小图标才走非写实。矩阵是空间定位系统、节点 ICON 只是 ICON，各管各层。参考工具清单只是风格来源标注，不必四处去扒。
