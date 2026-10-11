import type { ProjectStage } from "./domain"

export type KnowledgeStatus = "draft" | "reference" | "verified" | "retired"

export interface KnowledgeCard {
  id: string
  title: string
  stage: ProjectStage
  object: string
  tags: string[]
  phenomenon: string
  checkSteps: string[]
  evidence: string[]
  suggestions: string[]
  sourceTitle: string
  sourceUrl: string
  versionDate: string
  status: KnowledgeStatus
}

const CONTRACT_SOURCE = "https://htsfwb.samr.gov.cn/View?id=791da923-1a00-4d42-a278-adb991e71f47"

export const KNOWLEDGE_CARDS: KnowledgeCard[] = [
  {
    id: "kc_demolition_scope",
    title: "拆改前先固定范围和授权",
    stage: "拆改",
    object: "墙体与既有设施",
    tags: ["拆改", "墙体", "确认", "图纸"],
    phenomenon: "现场口头决定扩大拆改范围，后续难以确认责任和费用。",
    checkSteps: ["保存原始户型或现场照片", "标出拟拆改位置", "记录提出人、确认人和确认时间", "涉及结构判断时要求有资质人员复核"],
    evidence: ["拆改前照片", "标注图", "书面确认"],
    suggestions: ["未确认范围先列为待确认事项", "不要用照片外观自行判断承重性质"],
    sourceTitle: "市场监管总局合同示范文本库（字段设计参考）",
    sourceUrl: CONTRACT_SOURCE,
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_demolition_protection",
    title: "拆改前记录保留物和保护状态",
    stage: "拆改",
    object: "门窗、管线和公共区域",
    tags: ["成品保护", "公共区域", "拆改"],
    phenomenon: "保留物、公共区域或既有管线受损后，缺少施工前状态证据。",
    checkSteps: ["逐房间拍摄全景和近景", "列出明确保留的设备和饰面", "记录保护措施完成时间"],
    evidence: ["施工前全景", "保留清单", "保护完成照片"],
    suggestions: ["把未保护区域加入开工前待办"],
    sourceTitle: "项目流程基线（待专业复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "draft"
  },
  {
    id: "kc_electric_hidden_record",
    title: "封闭前保存隐蔽工程定位记录",
    stage: "水电",
    object: "水管、电管和接线位置",
    tags: ["水电", "隐蔽工程", "定位", "照片"],
    phenomenon: "封槽或吊顶后无法仅凭外观恢复管线位置。",
    checkSteps: ["按房间拍摄全景", "对转角、交叉和接点补近景", "画面加入固定参照物或尺寸", "记录拍摄时对应工序"],
    evidence: ["带参照的照片", "房间和墙面方向", "施工方说明"],
    suggestions: ["照片模糊或无方向信息时补拍", "原图保留，不只保存聊天软件压缩图"],
    sourceTitle: "项目流程基线（待专业复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_electric_material",
    title: "到场水电材料对照约定",
    stage: "水电",
    object: "管材、线材和辅件",
    tags: ["材料", "型号", "到货", "水电"],
    phenomenon: "品牌相同但系列、规格或批次与约定不清楚。",
    checkSteps: ["拍摄包装与铭牌完整信息", "逐项对照已确认的品牌、型号、规格和数量", "把无法辨认或未约定字段标为未知"],
    evidence: ["包装照片", "铭牌近照", "采购或到货单", "已确认材料版本"],
    suggestions: ["差异先建立待确认事项", "负责人批准替换后再形成新约定"],
    sourceTitle: "市场监管总局合同示范文本库（材料约定字段参考）",
    sourceUrl: CONTRACT_SOURCE,
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_waterproof_details",
    title: "防水施工先记录基层与细部",
    stage: "泥瓦",
    object: "卫生间防水",
    tags: ["防水", "基层", "管根", "门槛", "泥瓦"],
    phenomenon: "涂层完成后，基层处理和管根等细部过程难以回看。",
    checkSteps: ["施工前记录基层可见状态", "分别拍摄管根、墙地交接和门口位置", "记录材料包装与施工批次", "试验条件和结论由现场责任方记录"],
    evidence: ["基层照片", "细部近照", "材料照片", "试验记录"],
    suggestions: ["缺少细部照片时列为证据不足", "是否合格由适用约定和专业验收决定"],
    sourceTitle: "项目流程基线（待地区标准与工艺复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_tile_batch",
    title: "瓷砖到货先核对型号、色号与批次",
    stage: "泥瓦",
    object: "瓷砖",
    tags: ["瓷砖", "到货", "型号", "色号", "批次"],
    phenomenon: "外观近似的产品混放，铺贴后才发现色差或规格不同。",
    checkSteps: ["拍摄每批包装标识", "记录数量和到货时间", "与批准材料版本对照", "差异批次单独存放并等待确认"],
    evidence: ["包装标签", "到货单", "批准材料版本"],
    suggestions: ["未确认替换不自动计入批准预算", "实际入库与是否批准分开记录"],
    sourceTitle: "市场监管总局合同示范文本库（材料约定字段参考）",
    sourceUrl: CONTRACT_SOURCE,
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_tile_drain",
    title: "铺贴前后记录地漏周边排水观察",
    stage: "泥瓦",
    object: "地面与地漏",
    tags: ["地漏", "排水", "坡向", "积水"],
    phenomenon: "只拍完成面，缺少测试条件和积水位置记录。",
    checkSteps: ["记录测试区域和测试前状态", "拍摄放水过程与水流方向", "标出可见积水位置", "记录测试人和处理意见"],
    evidence: ["测试视频或连续照片", "位置标注", "处理与复查记录"],
    suggestions: ["单张照片无法证明长期排水表现", "异常观察转为待复查事项"],
    sourceTitle: "项目流程基线（待专业复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "draft"
  },
  {
    id: "kc_wood_board",
    title: "板材使用前保留完整标识",
    stage: "木工",
    object: "板材",
    tags: ["板材", "型号", "环保", "木工"],
    phenomenon: "裁切后产品标识丢失，无法回看品牌、型号或声明依据。",
    checkSteps: ["入场时拍摄整包和单板标识", "记录使用房间与数量", "对照批准材料版本", "证书或报告只记录其指向的具体产品"],
    evidence: ["包装和板材标识", "材料版本", "单据或报告"],
    suggestions: ["不要把无法对应型号的报告当作本批材料证明"],
    sourceTitle: "项目流程基线（待厂商资料复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_paint_sample",
    title: "大面积涂刷前固定色样和使用位置",
    stage: "油漆",
    object: "墙面涂料",
    tags: ["涂料", "色样", "批次", "油漆"],
    phenomenon: "仅用聊天中的颜色名称确认，现场光线和批次信息缺失。",
    checkSteps: ["保存色卡或样板编号", "记录确认房间和墙面", "拍摄到场包装批次", "样板确认与大面积施工分开留档"],
    evidence: ["色样编号", "确认记录", "包装批次"],
    suggestions: ["颜色照片受光线影响，只作为辅助记录"],
    sourceTitle: "市场监管总局合同示范文本库（材料约定字段参考）",
    sourceUrl: CONTRACT_SOURCE,
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_paint_observation",
    title: "墙面外观观察要记录光线与距离",
    stage: "油漆",
    object: "墙面完成面",
    tags: ["墙面", "光线", "裂纹", "色差"],
    phenomenon: "不同光线和拍摄角度下，照片呈现差异明显。",
    checkSteps: ["同时记录自然光和常用照明条件", "保存全景与可疑位置近景", "近景加入尺度参照", "记录观察时间和表面是否已干燥"],
    evidence: ["全景", "近景", "光线条件", "尺度参照"],
    suggestions: ["AI或人工仅描述可见现象，不根据单图直接判定原因"],
    sourceTitle: "项目图像记录基线（待专业复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_install_model",
    title: "安装前再次核对设备型号和附件",
    stage: "安装收尾",
    object: "设备与定制品",
    tags: ["安装", "设备", "型号", "附件"],
    phenomenon: "拆包安装后才发现型号、方向或附件与约定不一致。",
    checkSteps: ["拆包前拍摄外箱标签", "核对批准材料版本和安装位置", "清点关键附件", "差异在安装前发起确认"],
    evidence: ["标签照片", "附件清单", "批准版本", "安装位置"],
    suggestions: ["负责人未批准前不把替换项标记为已确认"],
    sourceTitle: "市场监管总局合同示范文本库（材料约定字段参考）",
    sourceUrl: CONTRACT_SOURCE,
    versionDate: "2026-09-24",
    status: "reference"
  },
  {
    id: "kc_handover",
    title: "收尾时建立可复查的交接包",
    stage: "安装收尾",
    object: "项目资料",
    tags: ["交接", "保修", "说明书", "收尾"],
    phenomenon: "完工后凭证、型号、联系人和未完成事项散落。",
    checkSteps: ["汇总未关闭事项", "整理设备型号、说明书和凭证", "记录钥匙、账号或设备权限移交", "导出关键记录和费用事件"],
    evidence: ["未关闭事项列表", "设备资料", "凭证", "交接确认"],
    suggestions: ["项目归档前完成一次恢复测试", "撤销不再需要的成员和设备权限"],
    sourceTitle: "项目交接流程基线（待专业复核）",
    sourceUrl: "",
    versionDate: "2026-09-24",
    status: "reference"
  }
]

export function searchKnowledge(cards: KnowledgeCard[], query: string, stage?: ProjectStage): KnowledgeCard[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return cards.filter(card => {
    if (stage && card.stage !== stage) return false
    if (!tokens.length) return true
    const haystack = [card.title, card.object, card.phenomenon, ...card.tags, ...card.checkSteps, ...card.suggestions].join(" ").toLowerCase()
    return tokens.every(token => haystack.includes(token))
  })
}
