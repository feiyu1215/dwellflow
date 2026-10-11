import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import type {
  AiInput,
  AiJob,
  AiResult,
  AiRunMetrics,
  BudgetHumanReview,
  ConsultationHumanReview,
  ImageObservationReview,
  ProjectSummaryHumanReview,
  RecordReviewReview,
  MaterialCheckReview,
  RectificationHumanReview
} from "../miniprogram/core/ai-contract.ts"
import { KNOWLEDGE_CARDS, type KnowledgeCard } from "../miniprogram/core/knowledge.ts"
import { AppError } from "./validation.ts"
import { contractVersionFor, promptVersionFor } from "./prompts.ts"
import { calculateSelectedBudget } from "./calculations.ts"

export class Repository {
  db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL,
        request_id TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
        knowledge_json TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(owner, request_id)
      );
      CREATE TABLE IF NOT EXISTS ai_decisions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner TEXT NOT NULL,
        decision TEXT NOT NULL, correction TEXT NOT NULL, created_at TEXT NOT NULL,
        review_json TEXT NOT NULL DEFAULT '{}'
      );
    `)
    const decisionColumns = this.db.prepare("PRAGMA table_info(ai_decisions)").all() as Array<{ name: string }>
    if (!decisionColumns.some(column => column.name === "review_json")) {
      this.db.exec("ALTER TABLE ai_decisions ADD COLUMN review_json TEXT NOT NULL DEFAULT '{}'")
    }
    const upsert = this.db.prepare("INSERT INTO knowledge VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, payload=excluded.payload")
    for (const card of KNOWLEDGE_CARDS) upsert.run(card.id, card.versionDate, JSON.stringify(card))
    // An interrupted external call is not replayed automatically: that could incur a second charge.
    for (const row of this.db.prepare("SELECT id, payload FROM ai_jobs").all()) {
      const job = JSON.parse(String(row.payload)) as AiJob
      if (job.status === "running") this.finish(String(row.id), undefined, "服务重启中断任务；请人工决定是否重试")
    }
  }
  knowledge(input: AiInput): KnowledgeCard[] {
    const query = (input.question + " " + input.sources.map(source => source.title + " " + source.text).join(" ")).toLowerCase()
    return this.db.prepare("SELECT payload FROM knowledge").all()
      .map(row => JSON.parse(String(row.payload)) as KnowledgeCard)
      .filter(card => card.status !== "retired" && card.stage === input.stage)
      .map(card => ({ card, score: card.tags.filter(tag => query.includes(tag.toLowerCase())).length }))
      .sort((a, b) => b.score - a.score).slice(0, 5).map(item => item.card)
  }
  begin(
    owner: string,
    input: AiInput,
    model: string,
    options: { knowledge?: KnowledgeCard[]; retryOfJobId?: string } = {}
  ) {
    const raw = JSON.stringify(input)
    const hash = createHash("sha256").update(raw).digest("hex")
    const existing = this.db.prepare("SELECT input_hash, payload FROM ai_jobs WHERE owner=? AND request_id=?").get(owner, input.requestId)
    if (existing) {
      if (existing.input_hash !== hash) throw new AppError(409, "同一请求标识不能用于不同资料")
      return { fresh: false, job: JSON.parse(String(existing.payload)) as AiJob, knowledge: [] as KnowledgeCard[] }
    }
    const since = new Date().toISOString().slice(0, 10)
    const today = this.db.prepare("SELECT payload FROM ai_jobs WHERE owner=? AND project_id=?").all(owner, input.projectId)
      .map(row => JSON.parse(String(row.payload)) as AiJob).filter(job => job.createdAt.startsWith(since))
    if (today.length >= 20) throw new AppError(429, "该项目今日已发起 20 次分析，请明日再试")
    const knowledge = options.knowledge || this.knowledge(input)
    const job: AiJob = {
      id: randomUUID(), task: input.task, status: "running",
      model,
      mode: input.mode,
      promptVersion: promptVersionFor(input.task, input.mode),
      contractVersion: contractVersionFor(input.task, input.mode),
      createdAt: new Date().toISOString(),
      ...(options.retryOfJobId ? { retryOfJobId: options.retryOfJobId } : {}),
      decision: "pending"
    }
    this.db.prepare("INSERT INTO ai_jobs VALUES(?,?,?,?,?,?,?,?)")
      .run(job.id, owner, input.projectId, input.requestId, hash, raw, JSON.stringify(knowledge), JSON.stringify(job))
    return { fresh: true, job, knowledge }
  }
  finish(id: string, result?: AiResult, error?: string, metrics?: AiRunMetrics) {
    const row = this.db.prepare("SELECT payload FROM ai_jobs WHERE id=?").get(id)!
    const job = JSON.parse(String(row.payload)) as AiJob
    if (job.status === "cancelled") {
      const cancelled = metrics && !job.metrics ? { ...job, metrics } : job
      if (cancelled !== job) {
        this.db.prepare("UPDATE ai_jobs SET payload=? WHERE id=?").run(JSON.stringify(cancelled), id)
      }
      return cancelled
    }
    const next: AiJob = {
      ...job,
      status: result ? "succeeded" : "failed",
      result,
      error,
      finishedAt: new Date().toISOString(),
      ...(metrics ? { metrics } : {})
    }
    this.db.prepare("UPDATE ai_jobs SET payload=? WHERE id=?").run(JSON.stringify(next), id)
    return next
  }
  cancel(owner: string, id: string) {
    const job = this.get(owner, id)
    if (job.status === "cancelled") return job
    if (job.status !== "running") throw new AppError(409, "只有运行中的任务可以取消")
    const cancelledAt = new Date().toISOString()
    const next: AiJob = {
      ...job,
      status: "cancelled",
      cancelledAt,
      finishedAt: cancelledAt,
      error: "任务已取消，模型结果不会保存；供应商请求可能已开始并产生费用"
    }
    this.db.prepare("UPDATE ai_jobs SET payload=? WHERE id=? AND owner=?")
      .run(JSON.stringify(next), id, owner)
    return next
  }
  retry(owner: string, id: string, model: string) {
    const job = this.get(owner, id)
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new AppError(409, "只有失败或已取消的任务可以按原资料重试")
    }
    const row = this.db.prepare(
      "SELECT input_json, knowledge_json FROM ai_jobs WHERE id=? AND owner=?"
    ).get(id, owner)!
    const original = JSON.parse(String(row.input_json)) as AiInput
    const knowledge = JSON.parse(String(row.knowledge_json)) as KnowledgeCard[]
    const input: AiInput = { ...original, requestId: "retry_" + randomUUID() }
    return {
      input,
      ...this.begin(owner, input, model, { knowledge, retryOfJobId: id })
    }
  }
  get(owner: string, id: string): AiJob {
    const row = this.db.prepare("SELECT payload FROM ai_jobs WHERE id=? AND owner=?").get(id, owner)
    if (!row) throw new AppError(404, "任务不存在或无权访问")
    return JSON.parse(String(row.payload)) as AiJob
  }
  list(owner: string, projectId: string): AiJob[] {
    return this.db.prepare("SELECT payload FROM ai_jobs WHERE owner=? AND project_id=? ORDER BY rowid DESC LIMIT 50")
      .all(owner, projectId).map(row => JSON.parse(String(row.payload)) as AiJob)
  }
  sources(owner: string, id: string) {
    this.get(owner, id)
    const row = this.db.prepare("SELECT input_json, knowledge_json FROM ai_jobs WHERE id=? AND owner=?").get(id, owner)!
    const input = JSON.parse(String(row.input_json)) as AiInput
    const knowledge = JSON.parse(String(row.knowledge_json)) as KnowledgeCard[]
    return {
      mode: input.mode,
      sources: input.sources,
      images: input.images
        .filter(image => Boolean(image.id))
        .map(image => ({ id: image.id!, sourceId: image.sourceId })),
      target: input.target,
      summaryScope: input.summaryScope,
      knowledge,
      calculations: calculateSelectedBudget(input)
    }
  }
  decide(
    owner: string,
    id: string,
    decision: "accepted" | "dismissed",
    correction: string,
    reviews: {
      materialReview?: MaterialCheckReview
      recordReviewReview?: RecordReviewReview
      imageObservationReview?: ImageObservationReview
      rectificationReview?: RectificationHumanReview
      consultationReview?: ConsultationHumanReview
      budgetReview?: BudgetHumanReview
      projectSummaryReview?: ProjectSummaryHumanReview
    } = {}
  ) {
    const job = this.get(owner, id)
    if (job.status !== "succeeded") throw new AppError(409, "只有成功的任务可以进行人工决定")
    if (job.decision !== "pending") {
      const same = job.decision === decision
        && (job.correction || "") === correction
        && JSON.stringify({
          materialReview: job.materialReview,
          recordReviewReview: job.recordReviewReview,
          imageObservationReview: job.imageObservationReview,
          rectificationReview: job.rectificationReview,
          consultationReview: job.consultationReview,
          budgetReview: job.budgetReview,
          projectSummaryReview: job.projectSummaryReview
        }) === JSON.stringify(reviews)
      if (same) return job
      throw new AppError(409, "人工决定已经保存；如需重新分析，请发起新任务")
    }
    const next = { ...job, decision, correction, ...reviews }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(`
        INSERT INTO ai_decisions
          (id, job_id, owner, decision, correction, created_at, review_json)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        randomUUID(), id, owner, decision, correction, new Date().toISOString(),
        JSON.stringify(reviews)
      )
      this.db.prepare("UPDATE ai_jobs SET payload=? WHERE id=? AND owner=?").run(JSON.stringify(next), id, owner)
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    return next
  }
  close() { this.db.close() }
}
