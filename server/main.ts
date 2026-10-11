import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Repository } from "./repository.ts"
import { createApi } from "./app.ts"
import type { ApiOptions } from "./app.ts"
import { deepSeekProvider } from "./provider.ts"
import {
  CompositeBusinessAuthenticator,
  SessionBearerAuthenticator,
  StaticBearerAuthenticator,
  type BusinessAuthenticator,
  type Principal
} from "./business-auth.ts"
import { BusinessRepository } from "./business-repository.ts"
import { BusinessService } from "./business-service.ts"
import { AuthSessionRepository, AuthSessionService } from "./auth-session.ts"
import { WechatCodeExchange } from "./wechat-auth.ts"
import { AttachmentRepository } from "./attachment-repository.ts"
import { AttachmentService } from "./attachment-service.ts"
import { LocalAttachmentStorage } from "./attachment-storage.ts"

const token = process.env.AI_SERVICE_TOKEN || ""
if (token.length < 32) throw new Error("请先在 .env 设置独立的 AI_SERVICE_TOKEN（至少 32 字符），不要使用模型密钥代替")
const dbPath = resolve(process.env.DATABASE_PATH || "data/renovation.sqlite")
mkdirSync(dirname(dbPath), { recursive: true })
const repo = new Repository(dbPath)
const provider = deepSeekProvider(process.env.DEEPSEEK_API_KEY || "", process.env.DEEPSEEK_MODEL || "deepseek-flash")
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || "127.0.0.1"
let businessRepo: BusinessRepository | undefined
const businessOptions: ApiOptions = {}
const identitiesJson = process.env.BUSINESS_DEV_IDENTITIES_JSON || ""
const wechatAppId = process.env.WECHAT_APP_ID || ""
const wechatAppSecret = process.env.WECHAT_APP_SECRET || ""
if (Boolean(wechatAppId) !== Boolean(wechatAppSecret)) {
  throw new Error("WECHAT_APP_ID 与 WECHAT_APP_SECRET 必须同时配置")
}
if (identitiesJson || wechatAppId) {
  const authenticators: BusinessAuthenticator[] = []
  businessRepo = new BusinessRepository(dbPath)
  businessOptions.business = new BusinessService(businessRepo)
  businessOptions.attachments = new AttachmentService(
    businessRepo,
    new AttachmentRepository(businessRepo.db),
    new LocalAttachmentStorage(resolve(
      process.env.ATTACHMENT_STORAGE_PATH || "data/attachments"
    ))
  )
  if (wechatAppId) {
    const authSessions = new AuthSessionService(
      new AuthSessionRepository(businessRepo.db),
      new WechatCodeExchange(wechatAppId, wechatAppSecret)
    )
    businessOptions.authSessions = authSessions
    authenticators.push(new SessionBearerAuthenticator(authSessions))
  }
  if (identitiesJson) {
    const identities = JSON.parse(identitiesJson) as Array<Principal & { token: string }>
    if (!Array.isArray(identities)) throw new Error("BUSINESS_DEV_IDENTITIES_JSON 必须是数组")
    authenticators.push(new StaticBearerAuthenticator(identities.map(identity => ({
      token: identity.token,
      principal: { id: identity.id, displayName: identity.displayName }
    }))))
  }
  businessOptions.businessAuthenticator = authenticators.length === 1
    ? authenticators[0]
    : new CompositeBusinessAuthenticator(authenticators)
}
const api = createApi(repo, provider, token, businessOptions)
api.listen(port, host, () => console.log("装修同步服务已启动：" + host + ":" + port))
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  api.close(() => {
    repo.close()
    businessRepo?.close()
    process.exit(0)
  })
})
