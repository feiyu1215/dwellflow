import type { RecordItem } from "./domain"
import { KNOWLEDGE_CARDS, type KnowledgeCard } from "./knowledge"

export interface ReferenceDraft {
  observations: string[]
  unknowns: string[]
  suggestions: string[]
  knowledgeCards: KnowledgeCard[]
}

export function suggestKnowledgeForRecord(record: RecordItem): KnowledgeCard[] {
  const text = `${record.title} ${record.note} ${record.room}`.toLowerCase()
  const sameStage = KNOWLEDGE_CARDS.filter(card => card.stage === record.stage)
  const ranked = sameStage
    .map(card => ({
      card,
      score: card.tags.reduce((score, tag) => score + (text.includes(tag.toLowerCase()) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
  const matched = ranked.filter(item => item.score > 0).map(item => item.card)
  return (matched.length ? matched : sameStage).slice(0, 3)
}

export function buildReferenceDraft(record: RecordItem): ReferenceDraft {
  const knowledgeCards = suggestKnowledgeForRecord(record)
  const observations = [
    `用户记录：${record.title}`,
    ...(record.note ? [`补充描述：${record.note}`] : [])
  ]
  const unknowns = [
    ...(record.attachments.length ? [] : ["尚未附现场图片、语音或文件"]),
    "记录未自动证明是否符合合同、厂商要求或适用标准",
    "原因、责任和处理结论仍需负责人或专业人员确认"
  ]
  const suggestions = Array.from(new Set(knowledgeCards.flatMap(card => card.suggestions))).slice(0, 5)
  return { observations, unknowns, suggestions, knowledgeCards }
}
