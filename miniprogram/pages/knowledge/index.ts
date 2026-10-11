import { STAGES, type ProjectStage } from "../../core/domain"
import { KNOWLEDGE_CARDS, searchKnowledge, type KnowledgeCard } from "../../core/knowledge"

const STATUS_LABEL = {
  draft: "草稿",
  reference: "可参考经验",
  verified: "已核验",
  retired: "已停用"
}

type CardView = KnowledgeCard & { statusLabel: string; tagText: string }

const toView = (card: KnowledgeCard): CardView => ({
  ...card,
  statusLabel: STATUS_LABEL[card.status],
  tagText: card.tags.join(" · ")
})

Page({
  data: {
    query: "",
    stageIndex: 0,
    stages: ["全部工序", ...STAGES],
    cards: [] as CardView[],
    selectedCard: null as CardView | null
  },
  onLoad() { this.refresh() },
  onQuery(e: WechatMiniprogram.Input) {
    this.setData({ query: e.detail.value })
    this.refresh(e.detail.value)
  },
  onStage(e: WechatMiniprogram.PickerChange) {
    this.setData({ stageIndex: Number(e.detail.value) })
    this.refresh(this.data.query, Number(e.detail.value))
  },
  refresh(query?: string, stageIndex?: number) {
    const actualQuery = query ?? this.data.query
    const actualStageIndex = stageIndex ?? this.data.stageIndex
    const stage = actualStageIndex === 0 ? undefined : this.data.stages[actualStageIndex] as ProjectStage
    this.setData({ cards: searchKnowledge(KNOWLEDGE_CARDS, actualQuery, stage).map(toView) })
  },
  openCard(e: WechatMiniprogram.TouchEvent) {
    const card = KNOWLEDGE_CARDS.find(item => item.id === e.currentTarget.dataset.id)
    if (card) this.setData({ selectedCard: toView(card) })
  },
  closeCard() { this.setData({ selectedCard: null }) },
  noop() {},
  copySource() {
    const sourceUrl = this.data.selectedCard?.sourceUrl
    if (!sourceUrl) return wx.showToast({ title: "此卡来源仍待核验", icon: "none" })
    wx.setClipboardData({ data: sourceUrl })
  }
})
