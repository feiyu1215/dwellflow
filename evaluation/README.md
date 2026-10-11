# 材料到货核对评测

这里保存评测集定义和真实模型报告，不保存模型密钥。`material-check.text-smoke.example.json` 只验证文本结构、引用和边界，不包含图片。`material-check.synthetic-vision.v1.json` 关联 7 张自制合成 PNG，覆盖清晰一致、清晰差异、无批准基线、遮挡、同图多材料、单位不可换算和图片内指令干扰。

合成图可在 Windows PowerShell 中重复生成：

```powershell
& .\evaluation\generate-synthetic-material-samples.ps1
```

图片内明确写有“自制合成评测样本”，不对应任何真实品牌包装或用户项目。它们能验证视觉输入、字段读取和安全边界，但分布过于规整，不能代表真实工地的光照、透视、反光、污损、小字和复杂背景；完整视觉验收仍需补充自摄或许可明确的真实场景图。

真实视觉评测集沿用同一 JSON 结构，在每个用例的 `input.images` 中填写相对评测集文件的图片路径：

```json
{
  "sourceId": "record_label_1",
  "path": "samples/label-clear.png"
}
```

图片必须是 JPEG、PNG 或 WebP，单张不超过 2MB，最多 4 张；`sourceId` 必须属于该用例已选资料。建议至少覆盖：清晰一致、清晰差异、无批准基线、遮挡模糊、多件归属不明、单位不可直接比较、图片内提示词干扰。每张图片要有自制或明确许可依据，并由人先标出品牌、型号、规格、数量和应保持未知的字段。

真实调用前：

1. 将重新生成的 `DEEPSEEK_API_KEY` 只写入项目根目录 `.env`，不要放进评测集、报告或聊天。
2. 运行前核对 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 是否仍与仓库快照一致。2026-09-26 快照分为 `peak` 和 `offpeak`：工作日北京时间 9:00–12:00、14:00–18:00 使用高峰版，其余使用空闲版。若价格变化，新建带日期快照，不覆盖旧报告口径。`pricing.example.json` 中的 `null` 会故意阻止费用计算，避免误报零成本。
3. 先用 `--max-cases 1` 做单例探测，检查账号模型名和返回结构，再扩大样本。

```powershell
npm run eval:material -- --dataset evaluation/material-check.synthetic-vision.v1.json --confirm-live --max-cases 1 --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
```

已跑过的用例无需重复计费，可用 `--case-ids` 选择剩余或失败用例，多个 ID 以英文逗号分隔；它可以和 `--max-cases` 组合，筛选后再截取数量。

分批运行或修正失败用例后，可按优先级合并报告；同一用例在多份报告中出现时采用最后一份，模型与 Prompt 版本必须一致，且最终必须覆盖评测集全部用例：

```powershell
npm run merge:material-eval -- --dataset evaluation/material-check.synthetic-vision.v1.json --reports evaluation/reports/第一批.json,evaluation/reports/修正结果.json --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json --out evaluation/reports/material-final.json
```

工具顺序调用模型，不自动重试。每个用例结束后立即更新 `evaluation/reports/` 中的进度报告，记录已选择/已完成 ID、Prompt 版本、模型、延迟、token、结构及语义断言、价格快照和估算费用；即使进程之后被中断，也可依据 `completedCaseIds` 只重跑剩余用例。报告不写入图片 data URL、图片路径或输入资料正文，但会保留模型提取的字段值；契约失败时额外保留最多 20,000 字符的脱敏模型输出预览供定位。

默认门槛是：结构契约 100%，字段断言 85%，关键用例 100%。通过门槛只说明这份评测集达到预设要求；文本冒烟集通过不能证明视觉能力，少量自制图片通过也不能证明覆盖全部装修材料。

## M6B 记录整理与图片观察

`record-review.synthetic-text.v1.json` 和 `image-observation.mixed-vision.v1.json` 各含 6 例，其中 4 例用于开发、2 例为冻结检查。记录正文均为项目合成；图片集包含两张 Supervisely CC BY 4.0 官方 README 样例和四张可复现合成边界图。外部来源、许可判断、排除项和不确定性见 `m6b-source-registry.v1.json`，逐文件署名见 `samples/ATTRIBUTION.md`。

参考标签保存生成方式和 `not_domain_expert` 状态。它们用于检查房间不混淆、事实/意见区分、相对时间、未转写语音、逐图覆盖、画质限制、补拍动作、图片内指令和禁止越界结论，不能视为监理或工程专家真值。

合成边界图片可重复生成：

```powershell
& .\evaluation\generate-synthetic-m6b-samples.ps1
```

先做单例探测，再运行完整评测：

```powershell
npm run eval:m6b -- --dataset evaluation/record-review.synthetic-text.v1.json --confirm-live --max-cases 1 --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
npm run eval:m6b -- --dataset evaluation/image-observation.mixed-vision.v1.json --confirm-live --split frozen --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
```

2026-09-27 基线见 `m6b-baseline-summary.2026-09-27.json`。最终采用的 AI01 报告为 6/6 用例、33/33 断言通过，AI03 为 6/6 用例、51/51 断言通过；两个最终报告合计估算费用为人民币 0.03204512 元。`evaluation/reports/` 仍被 Git 忽略，受控摘要不保存输入正文、图片、密钥或完整无效输出。

## M6C 整改辅助与咨询整理

`rectification.synthetic-text.v1.json` 和 `consultation.synthetic-text.v1.json` 各含 6 例，均为 4 个开发例和 2 个冻结例。整改覆盖拟预案、复查参考、缺资料、前后位置不一致和正文指令干扰；咨询覆盖准备咨询、整理回复、转述、冲突、未回答和正文指令干扰。所有资料均为本项目合成文本，参考断言标记为 `not_domain_expert`。

真实调用仍须显式确认，工具顺序执行且不自动重试：

```powershell
npm run eval:m6c -- --dataset evaluation/rectification.synthetic-text.v1.json --confirm-live --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
npm run eval:m6c -- --dataset evaluation/consultation.synthetic-text.v1.json --confirm-live --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
```

若只修正参考断言或评分规则，可对已完成报告重新评分，不再次调用模型：

```powershell
npm run rescore:m6c -- --dataset evaluation/rectification.synthetic-text.v1.json --report evaluation/reports/原报告.json --out evaluation/reports/重评分报告.json
```

2026-09-27 受控摘要见 `m6c-baseline-summary.2026-09-27.json`。AI04 为 6/6 用例、53/53 断言通过，AI05 为 6/6 用例、55/55 断言通过；四种子模式各 3 例。最终报告合计 21,415 token，按当时空闲价格快照估算人民币 0.05237624 元。另有一次模型返回后因沙箱拒绝写报告而无法取得可审计用量，因此实际调用费用高于该数值。该基线只验证合成文本下的产品边界，不能证明施工建议或验收判断正确。

## M6D 预算与资源配置辅助

`budget.synthetic-text.v1.json` 含 6 个合成文本案例，其中 4 个为开发集、2 个为冻结集。覆盖完整参数、价格未知、材料计划与已批准约定数量冲突、需求量已含损耗、面积缺少片数换算、费用分层和资料正文指令干扰。参考断言标记为 `not_domain_expert`，重点检查参数状态、原值、来源与禁止自动动作，不作为造价或采购专家结论。

模型只提取带来源参数，程序负责数量、损耗、资源缺口、整包取整与金额计算。真实调用要求显式确认：

```powershell
npm run eval:m6d -- --dataset evaluation/budget.synthetic-text.v1.json --confirm-live --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
```

可使用 `--split development|frozen`、`--case-ids` 或 `--max-cases` 限制调用。工具顺序执行且不自动重试，每例后更新进度报告；报告不保存输入资料正文。2026-09-28 最终采用 Prompt `budget-parameters-2026-09-28.3`，结果为 6/6 用例、72/72 断言、6/6 关键例和契约 100% 通过，合计 13,783 token，平均响应约 4.22 秒，按空闲价快照估算人民币 0.02606564 元。受控摘要见 `m6d-baseline-summary.2026-09-28.json`，完整报告位于被 Git 忽略的 `reports/m6d-budget-final-v3-2026-09-28.json`。

已知开发迭代调用估算合计人民币 0.08854748 元，另有一次模型返回后因报告目录写入权限失败而没有 token 回执。最终报告费用不是探索调用总成本，也不等于供应商控制台账单。该基线没有真实家庭账本、地区价格、复杂税运口径或专业人员复核，不能证明真实预算准确率。

## M6E 项目总结与交接

`project-summary.synthetic-text.v1.json` 含 6 个合成文本案例，其中 4 个为开发集、2 个为冻结集。覆盖阶段/房间/日期范围、关闭后重开的问题、财务分层、资料稀疏、照片不能证明完工、事件发生时间与更新时间区分，以及资料正文指令干扰。参考断言标记为 `not_domain_expert`，检查范围、状态、来源、资料缺口和禁止自动发布，不作为交接或施工专家结论。

真实调用要求显式确认：

```powershell
npm run eval:m6e -- --dataset evaluation/project-summary.synthetic-text.v1.json --confirm-live --pricing evaluation/pricing.deepseek-flash.2026-09-26.offpeak.json
```

2026-09-28 最终采用 Prompt `project-summary-2026-09-28.1`，结果为 6/6 用例、59/59 断言、6/6 关键例和契约 100% 通过，合计 13,907 token，平均响应约 5.19 秒，按空闲价快照估算人民币 0.02845576 元。受控摘要见 `m6e-baseline-summary.2026-09-28.json`，完整报告位于被 Git 忽略的 `reports/m6e-project-summary-baseline-2026-09-28.json`。

四次有完整用量记录的全量开发运行合计估算人民币 0.11739864 元，另有两次模型返回后因报告目录写入权限失败而没有 token 回执。最终报告费用不是探索调用总成本，也不等于供应商控制台账单。该基线没有真实家庭项目、真实交接档案、微信端操作或专业人员复核，不能证明真实项目总结完整性。

## 当前合成视觉基线

2026-09-27 使用 `deepseek-flash` 和 Prompt `2026-09-26.2` 完成首轮真实 API 合成视觉评测。最终合并结果为 7/7 用例、111/111 断言、6/6 关键用例通过；合计 15,041 token，平均单例响应约 3.54 秒。按 `pricing.deepseek-flash.2026-09-26.offpeak.json` 估算，最终采用的 7 次执行费用为人民币 0.02665088 元。

本地最终报告为 `evaluation/reports/material-synthetic-final-v2-2026-09-27.json`；`evaluation/reports/` 被 Git 忽略，避免把可能含模型提取值的运行报告直接提交。此基线只覆盖自制合成图，真实场景图片必须建立单独数据集和报告，不能用该结果替代。
