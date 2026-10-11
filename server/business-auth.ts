import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { AppError } from "./validation.ts"
import type { AuthSessionService } from "./auth-session.ts"

export interface Principal {
  id: string
  displayName: string
}

export interface BusinessAuthenticator {
  authenticate(req: IncomingMessage): Principal
}

export class SessionBearerAuthenticator implements BusinessAuthenticator {
  private readonly sessions: AuthSessionService

  constructor(sessions: AuthSessionService) {
    this.sessions = sessions
  }

  authenticate(req: IncomingMessage): Principal {
    return this.sessions.authenticateRequest(req)
  }
}

export class CompositeBusinessAuthenticator implements BusinessAuthenticator {
  private readonly authenticators: BusinessAuthenticator[]

  constructor(authenticators: BusinessAuthenticator[]) {
    if (!authenticators.length) throw new Error("至少需要一个业务身份适配器")
    this.authenticators = authenticators
  }

  authenticate(req: IncomingMessage): Principal {
    for (const authenticator of this.authenticators) {
      try {
        return authenticator.authenticate(req)
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 401) throw error
      }
    }
    throw new AppError(401, "业务身份凭证无效或已过期")
  }
}

interface TokenEntry {
  digest: Buffer
  principal: Principal
}

export class StaticBearerAuthenticator implements BusinessAuthenticator {
  private readonly entries: TokenEntry[]

  constructor(entries: Array<{ token: string; principal: Principal }>) {
    if (!entries.length) throw new Error("至少需要一个业务测试身份")
    const principalIds = new Set<string>()
    this.entries = entries.map(entry => {
      if (entry.token.length < 32) throw new Error("业务测试令牌至少 32 字符")
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.principal.id)) {
        throw new Error("业务身份标识格式不正确")
      }
      if (principalIds.has(entry.principal.id)) throw new Error("业务身份标识不能重复")
      principalIds.add(entry.principal.id)
      return {
        digest: createHash("sha256").update(entry.token).digest(),
        principal: { ...entry.principal }
      }
    })
  }

  authenticate(req: IncomingMessage): Principal {
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") || ""
    const digest = createHash("sha256").update(supplied).digest()
    const match = this.entries.find(entry => timingSafeEqual(entry.digest, digest))
    if (!match) throw new AppError(401, "业务身份凭证无效")
    return { ...match.principal }
  }
}
