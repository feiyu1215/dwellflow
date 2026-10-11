import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createHash, timingSafeEqual } from "node:crypto"
import { DomainError } from "../miniprogram/core/domain-error.ts"
import { ProviderRunFailure, type ModelProvider } from "./provider.ts"
import { Repository } from "./repository.ts"
import {
  AppError,
  validateBudgetReview,
  validateConsultationReview,
  validateImageObservationReview,
  validateInput,
  validateMaterialReview,
  validateProjectSummaryReview,
  validateRecordReviewReview,
  validateRectificationReview,
  validateResult
} from "./validation.ts"
import type { BusinessAuthenticator } from "./business-auth.ts"
import type { BusinessObjectKind } from "./business-repository.ts"
import type { BusinessService } from "./business-service.ts"
import { isObject, validateBusinessCommand } from "./business-validation.ts"
import type { AuthSessionService } from "./auth-session.ts"
import type { AttachmentService } from "./attachment-service.ts"
import type { AiInput, AiJob } from "../miniprogram/core/ai-contract.ts"
import type { KnowledgeCard } from "../miniprogram/core/knowledge.ts"
import type { RecordInputExtractionResponse } from "../miniprogram/core/record-input-contract.ts"
import {
  recordInputContractVersion,
  recordInputPromptVersion,
  validateRecordInputRequest,
  validateRecordInputResult
} from "./record-input.ts"

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(value))
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12 * 1024 * 1024) throw new AppError(413, "请求过大，请减少图片")
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
  catch { throw new AppError(400, "请求不是有效 JSON") }
}

async function readBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] || 0)
  if (declared > limit) throw new AppError(413, "附件分块超过大小限制")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new AppError(413, "附件分块超过大小限制")
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export interface ApiOptions {
  business?: BusinessService
  businessAuthenticator?: BusinessAuthenticator
  authSessions?: AuthSessionService
  attachments?: AttachmentService
}

function domainHttpError(error: DomainError): AppError {
  const status = error.code === "NOT_FOUND" ? 404
    : ["VERSION_CONFLICT", "STATE_CONFLICT", "IDEMPOTENCY_CONFLICT",
      "INSUFFICIENT_QUANTITY"].includes(error.code) ? 409 : 400
  return new AppError(status, error.message, error.code)
}

export function createApi(
  repo: Repository,
  provider: ModelProvider,
  token: string,
  options: ApiOptions = {}
) {
  if (token.length < 32) throw new Error("AI_SERVICE_TOKEN 至少 32 字符，仅用于本机开发者身份")
  const expected = createHash("sha256").update(token).digest()
  const owner = "local-developer"
  let active = 0
  const runningControllers = new Map<string, AbortController>()

  async function executeJob(
    job: AiJob,
    input: AiInput,
    knowledge: KnowledgeCard[]
  ): Promise<AiJob> {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    active++
    const startedAt = Date.now()
    let run: Awaited<ReturnType<ModelProvider["run"]>> | undefined
    try {
      run = await provider.run(input, knowledge, controller.signal)
      const result = validateResult(run.output, input, knowledge)
      return repo.finish(job.id, result, undefined, {
        durationMs: Date.now() - startedAt,
        providerRequestId: run.providerRequestId,
        responseModel: run.responseModel,
        usage: run.usage
      })
    } catch (error) {
      const failedRun = error instanceof ProviderRunFailure ? error : undefined
      if (controller.signal.aborted) return repo.finish(job.id, undefined, undefined, {
        durationMs: Date.now() - startedAt,
        providerRequestId: run?.providerRequestId || failedRun?.providerRequestId,
        responseModel: run?.responseModel || failedRun?.responseModel,
        usage: run?.usage || failedRun?.usage
      })
      const message = error instanceof AppError ? error.message : "分析失败，请稍后重试"
      return repo.finish(job.id, undefined, message, {
        durationMs: Date.now() - startedAt,
        providerRequestId: run?.providerRequestId || failedRun?.providerRequestId,
        responseModel: run?.responseModel || failedRun?.responseModel,
        usage: run?.usage || failedRun?.usage
      })
    } finally {
      runningControllers.delete(job.id)
      active--
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url || "/", "http://localhost").pathname
      if (path === "/health" && req.method === "GET") return send(res, 200, { status: "ok", mode: "local-development" })
      if (path === "/v1/auth/wechat" && req.method === "POST") {
        if (!options.authSessions) {
          throw new AppError(503, "微信登录尚未配置", "SERVICE_UNAVAILABLE")
        }
        const body = await readBody(req)
        if (!isObject(body)) throw new AppError(400, "登录输入格式不正确", "INVALID_INPUT")
        return send(res, 200, await options.authSessions.login(body.code))
      }
      if (path === "/v1/auth/logout" && req.method === "POST") {
        if (!options.authSessions) {
          throw new AppError(503, "微信登录尚未配置", "SERVICE_UNAVAILABLE")
        }
        options.authSessions.logoutRequest(req)
        return send(res, 200, { status: "logged_out" })
      }
      if (path === "/v1/projects" || path.startsWith("/v1/projects/")) {
        if (!options.business || !options.businessAuthenticator) {
          throw new AppError(503, "业务服务尚未配置", "SERVICE_UNAVAILABLE")
        }
        const principal = options.businessAuthenticator.authenticate(req)
        if (path === "/v1/projects" && req.method === "GET") {
          return send(res, 200, options.business.listProjects(principal))
        }
        if (path === "/v1/projects" && req.method === "POST") {
          const body = await readBody(req)
          if (!isObject(body)) throw new AppError(400, "项目输入格式不正确", "INVALID_INPUT")
          return send(res, 201, options.business.createProject(principal, {
            requestId: body.requestId,
            name: body.name
          }))
        }
        const attachmentListMatch =
          /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/attachments$/.exec(path)
        if (attachmentListMatch && req.method === "POST") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          const body = await readBody(req)
          if (!isObject(body)) throw new AppError(400, "附件输入格式不正确")
          return send(res, 201, options.attachments.reserve(
            principal, attachmentListMatch[1], body
          ))
        }
        if (attachmentListMatch && req.method === "GET") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          const query = new URL(req.url!, "http://localhost").searchParams
          return send(res, 200, options.attachments.list(
            principal,
            attachmentListMatch[1],
            query.get("area"),
            query.get("resourceId")
          ))
        }
        const attachmentChunkMatch =
          /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/attachments\/([a-zA-Z0-9_-]+)\/chunks\/(\d+)$/.exec(path)
        if (attachmentChunkMatch && req.method === "PUT") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          return send(res, 200, options.attachments.putChunk(
            principal,
            attachmentChunkMatch[1],
            attachmentChunkMatch[2],
            {
              index: Number(attachmentChunkMatch[3]),
              offsetBytes: Number(req.headers["x-chunk-offset"]),
              sha256: req.headers["x-chunk-sha256"],
              content: await readBinary(req, 5 * 1024 * 1024)
            }
          ))
        }
        const attachmentCompleteMatch =
          /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/attachments\/([a-zA-Z0-9_-]+)\/complete$/.exec(path)
        if (attachmentCompleteMatch && req.method === "POST") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          const body = await readBody(req)
          if (!isObject(body)) throw new AppError(400, "附件完成输入格式不正确")
          return send(res, 200, options.attachments.complete(
            principal, attachmentCompleteMatch[1],
            attachmentCompleteMatch[2], body
          ))
        }
        const attachmentContentMatch =
          /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/attachments\/([a-zA-Z0-9_-]+)\/content$/.exec(path)
        if (attachmentContentMatch && req.method === "GET") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          const result = options.attachments.readContent(
            principal, attachmentContentMatch[1], attachmentContentMatch[2]
          )
          res.writeHead(200, {
            "Content-Type": result.attachment.mediaType,
            "Content-Length": result.content.length,
            "Content-Disposition": "attachment; filename*=UTF-8''"
              + encodeURIComponent(result.attachment.fileName),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
          })
          res.end(result.content)
          return
        }
        const attachmentMatch =
          /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/attachments\/([a-zA-Z0-9_-]+)$/.exec(path)
        if (attachmentMatch && req.method === "GET") {
          if (!options.attachments) {
            throw new AppError(503, "附件服务尚未配置", "SERVICE_UNAVAILABLE")
          }
          return send(res, 200, options.attachments.get(
            principal, attachmentMatch[1], attachmentMatch[2]
          ))
        }
        const projectMatch = /^\/v1\/projects\/([a-zA-Z0-9_-]+)$/.exec(path)
        if (projectMatch && req.method === "GET") {
          return send(res, 200, options.business.getProject(principal, projectMatch[1]))
        }
        const commandMatch = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/commands$/.exec(path)
        if (commandMatch && req.method === "POST") {
          return send(res, 200, options.business.execute(
            principal, commandMatch[1], validateBusinessCommand(await readBody(req))
          ))
        }
        const objectMatch = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/objects\/([a-z_]+)\/([a-zA-Z0-9_-]+)$/.exec(path)
        if (objectMatch && req.method === "GET") {
          const kinds = new Set<BusinessObjectKind>([
            "agreement", "purchase_line", "receipt", "inventory_ledger",
            "issue", "finance_ledger", "change_request", "owner_transfer"
          ])
          if (!kinds.has(objectMatch[2] as BusinessObjectKind)) {
            throw new AppError(404, "对象类型不存在", "NOT_FOUND")
          }
          return send(res, 200, options.business.getObject(
            principal, objectMatch[1], objectMatch[2] as BusinessObjectKind, objectMatch[3]
          ))
        }
        const listMatch = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/objects\/([a-z_]+)$/.exec(path)
        if (listMatch && req.method === "GET") {
          const kinds = new Set([
            "agreement", "purchase_line", "receipt",
            "inventory_ledger", "issue", "finance_ledger", "change_request"
          ] as const)
          if (!kinds.has(listMatch[2] as never)) {
            throw new AppError(404, "对象类型不存在", "NOT_FOUND")
          }
          const limit = Number(new URL(req.url!, "http://localhost").searchParams.get("limit") || 100)
          return send(res, 200, options.business.listObjects(
            principal,
            listMatch[1],
            listMatch[2] as Exclude<BusinessObjectKind, "owner_transfer">,
            limit
          ))
        }
        const auditMatch = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/audit$/.exec(path)
        if (auditMatch && req.method === "GET") {
          const limit = Number(new URL(req.url!, "http://localhost").searchParams.get("limit") || 100)
          return send(res, 200, options.business.listAudit(principal, auditMatch[1], limit))
        }
        throw new AppError(404, "业务接口不存在", "NOT_FOUND")
      }
      const supplied = req.headers.authorization?.replace(/^Bearer /, "") || ""
      if (!timingSafeEqual(expected, createHash("sha256").update(supplied).digest())) throw new AppError(401, "服务凭证无效")
      if (path === "/v1/input-drafts/record:extract" && req.method === "POST") {
        if (!provider.extractRecordInput) throw new AppError(503, "当前模型连接不支持录入提取")
        if (active >= 2) throw new AppError(429, "正在处理其他分析，请稍后重试")
        const input = validateRecordInputRequest(await readBody(req))
        const startedAt = Date.now()
        active++
        try {
          const run = await provider.extractRecordInput(input)
          const result = validateRecordInputResult(run.output, input)
          const response: RecordInputExtractionResponse = {
            requestId: input.requestId,
            projectId: input.projectId,
            inputRevision: input.inputRevision,
            promptVersion: recordInputPromptVersion(),
            contractVersion: recordInputContractVersion(),
            result,
            metrics: {
              durationMs: Date.now() - startedAt,
              providerRequestId: run.providerRequestId,
              responseModel: run.responseModel
            }
          }
          return send(res, 200, response)
        } finally {
          active--
        }
      }
      if (path === "/v1/ai/jobs" && req.method === "POST") {
        const input = validateInput(await readBody(req))
        if (active >= 2) throw new AppError(429, "正在处理其他分析，请稍后重试")
        const { fresh, job, knowledge } = repo.begin(owner, input, provider.model)
        if (!fresh) return send(res, job.status === "running" ? 202 : 200, job)
        const background = new URL(req.url!, "http://localhost").searchParams.get("async") === "1"
        if (background) {
          void executeJob(job, input, knowledge)
          return send(res, 202, job)
        }
        return send(res, 200, await executeJob(job, input, knowledge))
      }
      if (path === "/v1/ai/jobs" && req.method === "GET") {
        const projectId = new URL(req.url!, "http://localhost").searchParams.get("projectId") || ""
        return send(res, 200, repo.list(owner, projectId))
      }
      const match = /^\/v1\/ai\/jobs\/([a-zA-Z0-9-]+)(\/decision|\/sources|\/cancel|\/retry)?$/.exec(path)
      if (match && req.method === "GET") {
        if (match[2] === "/sources") return send(res, 200, repo.sources(owner, match[1]))
        if (!match[2]) return send(res, 200, repo.get(owner, match[1]))
      }
      if (match?.[2] === "/cancel" && req.method === "POST") {
        const job = repo.cancel(owner, match[1])
        runningControllers.get(job.id)?.abort()
        return send(res, 200, job)
      }
      if (match?.[2] === "/retry" && req.method === "POST") {
        if (active >= 2) throw new AppError(429, "正在处理其他分析，请稍后重试")
        const retried = repo.retry(owner, match[1], provider.model)
        void executeJob(retried.job, retried.input, retried.knowledge)
        return send(res, 202, retried.job)
      }
      if (match?.[2] === "/decision" && req.method === "POST") {
        const body = await readBody(req) as {
          decision?: unknown
          correction?: unknown
          materialReview?: unknown
          recordReviewReview?: unknown
          imageObservationReview?: unknown
          rectificationReview?: unknown
          consultationReview?: unknown
          budgetReview?: unknown
          projectSummaryReview?: unknown
        }
        if (!body || !["accepted", "dismissed"].includes(String(body.decision))
          || typeof body.correction !== "string" || body.correction.length > 4000) throw new AppError(400, "人工决定格式不正确")
        const job = repo.get(owner, match[1])
        if (job.status !== "succeeded") throw new AppError(409, "只有成功的任务可以进行人工决定")
        const materialReview = body.materialReview === undefined
          ? undefined
          : validateMaterialReview(body.materialReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        const recordReviewReview = body.recordReviewReview === undefined
          ? undefined
          : validateRecordReviewReview(body.recordReviewReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        const imageObservationReview = body.imageObservationReview === undefined
          ? undefined
          : validateImageObservationReview(body.imageObservationReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        const rectificationReview = body.rectificationReview === undefined
          ? undefined
          : validateRectificationReview(body.rectificationReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        const allowedIssueIds = body.consultationReview === undefined
          ? new Set<string>()
          : new Set(repo.sources(owner, match[1]).sources
            .filter(source => source.kind === "issue")
            .map(source => source.id))
        const consultationReview = body.consultationReview === undefined
          ? undefined
          : validateConsultationReview(body.consultationReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          }, allowedIssueIds)
        const budgetReview = body.budgetReview === undefined
          ? undefined
          : validateBudgetReview(body.budgetReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        const projectSummaryReview = body.projectSummaryReview === undefined
          ? undefined
          : validateProjectSummaryReview(body.projectSummaryReview, job.result || {
            summary: "", observations: [], differences: [], unknowns: [], suggestions: []
          })
        if ((job.task !== "material_check" && materialReview)
          || (job.task !== "record_review" && recordReviewReview)
          || (job.task !== "image_observation" && imageObservationReview)
          || (job.task !== "rectification" && rectificationReview)
          || (job.task !== "consultation" && consultationReview)
          || (job.task !== "budget" && budgetReview)
          || (job.task !== "project_summary" && projectSummaryReview)) {
          throw new AppError(400, "人工复核类型与当前任务不一致")
        }
        if (body.decision === "dismissed"
          && (materialReview || recordReviewReview || imageObservationReview
            || rectificationReview || consultationReview || budgetReview || projectSummaryReview)) {
          throw new AppError(400, "不采纳任务时不应提交写回复核")
        }
        if (body.decision === "accepted" && job.task === "material_check" && !materialReview) {
          throw new AppError(400, "采纳材料核对前必须逐字段人工复核")
        }
        if (body.decision === "accepted" && job.task === "record_review" && !recordReviewReview) {
          throw new AppError(400, "采纳记录整理前必须确认记录草稿")
        }
        if (body.decision === "accepted" && job.task === "image_observation" && !imageObservationReview) {
          throw new AppError(400, "采纳图片观察前必须逐项选择保存、忽略或转问题")
        }
        if (body.decision === "accepted" && job.task === "rectification" && !rectificationReview) {
          throw new AppError(400, "采纳整改辅助前必须人工复核预案或复查参考")
        }
        if (body.decision === "accepted" && job.task === "consultation" && !consultationReview) {
          throw new AppError(400, "采纳咨询整理前必须人工复核草稿或回复映射")
        }
        if (body.decision === "accepted" && job.task === "budget" && !budgetReview) {
          throw new AppError(400, "采纳预算辅助前必须确认参数和计算范围")
        }
        if (body.decision === "accepted" && job.task === "project_summary" && !projectSummaryReview) {
          throw new AppError(400, "采纳项目总结前必须逐节人工复核")
        }
        return send(res, 200, repo.decide(
          owner,
          match[1],
          body.decision as "accepted" | "dismissed",
          body.correction,
          {
            materialReview, recordReviewReview, imageObservationReview,
            rectificationReview, consultationReview, budgetReview, projectSummaryReview
          }
        ))
      }
      throw new AppError(404, "接口不存在")
    } catch (error) {
      const handled = error instanceof DomainError ? domainHttpError(error) : error
      send(res, handled instanceof AppError ? handled.status : 500,
        {
          error: handled instanceof AppError ? handled.message : "服务内部错误",
          code: handled instanceof AppError ? handled.code : "INTERNAL_ERROR"
        })
    }
  })
  server.requestTimeout = 60000
  return server
}
