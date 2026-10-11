import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import type { Principal } from "./business-auth.ts"
import { AppError } from "./validation.ts"

export interface LoginCodeIdentity {
  provider: string
  subject: string
}

export interface LoginCodeExchange {
  exchange(code: string): Promise<LoginCodeIdentity>
}

interface AuthUser {
  id: string
  provider: string
  subjectDigest: string
  displayName: string
  createdAt: string
  updatedAt: string
}

interface AuthSession {
  tokenDigest: string
  userId: string
  expiresAt: string
  revokedAt?: string
  createdAt: string
}

export interface LoginResult {
  accessToken: string
  expiresAt: string
  user: Principal
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization || ""
  if (!header.startsWith("Bearer ")) throw new AppError(401, "业务身份凭证无效")
  const token = header.slice("Bearer ".length)
  if (token.length < 32 || token.length > 512) {
    throw new AppError(401, "业务身份凭证无效")
  }
  return token
}

export class AuthSessionRepository {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subject_digest TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, subject_digest)
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_digest TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES auth_users(id)
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
        ON auth_sessions(user_id, expires_at);
      INSERT OR IGNORE INTO auth_schema_migrations(version, applied_at)
        VALUES(1, CURRENT_TIMESTAMP);
    `)
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  findUser(provider: string, subjectDigest: string): AuthUser | undefined {
    const row = this.db.prepare(`
      SELECT * FROM auth_users WHERE provider=? AND subject_digest=?
    `).get(provider, subjectDigest)
    if (!row) return undefined
    return {
      id: String(row.id),
      provider: String(row.provider),
      subjectDigest: String(row.subject_digest),
      displayName: String(row.display_name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  createUser(user: AuthUser): void {
    this.db.prepare(`
      INSERT INTO auth_users
        (id,provider,subject_digest,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)
    `).run(user.id, user.provider, user.subjectDigest, user.displayName,
      user.createdAt, user.updatedAt)
  }

  saveSession(session: AuthSession): void {
    this.db.prepare(`
      INSERT INTO auth_sessions
        (token_digest,user_id,expires_at,revoked_at,created_at)
      VALUES(?,?,?,?,?)
    `).run(session.tokenDigest, session.userId, session.expiresAt,
      session.revokedAt || null, session.createdAt)
  }

  resolveSession(tokenDigest: string): { session: AuthSession; user: AuthUser } | undefined {
    const row = this.db.prepare(`
      SELECT
        s.token_digest,s.user_id,s.expires_at,s.revoked_at,s.created_at,
        u.provider,u.subject_digest,u.display_name,u.created_at AS user_created_at,
        u.updated_at AS user_updated_at
      FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_digest=?
    `).get(tokenDigest)
    if (!row) return undefined
    return {
      session: {
        tokenDigest: String(row.token_digest),
        userId: String(row.user_id),
        expiresAt: String(row.expires_at),
        revokedAt: row.revoked_at === null ? undefined : String(row.revoked_at),
        createdAt: String(row.created_at)
      },
      user: {
        id: String(row.user_id),
        provider: String(row.provider),
        subjectDigest: String(row.subject_digest),
        displayName: String(row.display_name),
        createdAt: String(row.user_created_at),
        updatedAt: String(row.user_updated_at)
      }
    }
  }

  revokeSession(tokenDigest: string, revokedAt: string): void {
    this.db.prepare(`
      UPDATE auth_sessions SET revoked_at=?
      WHERE token_digest=? AND revoked_at IS NULL
    `).run(revokedAt, tokenDigest)
  }
}

export class AuthSessionService {
  private readonly repo: AuthSessionRepository
  private readonly codeExchange: LoginCodeExchange
  private readonly sessionTtlMs: number
  private readonly now: () => Date
  private readonly tokenFactory: () => string

  constructor(
    repo: AuthSessionRepository,
    codeExchange: LoginCodeExchange,
    options: {
      sessionTtlMs?: number
      now?: () => Date
      tokenFactory?: () => string
    } = {}
  ) {
    this.repo = repo
    this.codeExchange = codeExchange
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000) {
      throw new Error("业务会话有效期至少为一分钟")
    }
    this.now = options.now || (() => new Date())
    this.tokenFactory = options.tokenFactory
      || (() => randomBytes(32).toString("base64url"))
  }

  async login(codeInput: unknown): Promise<LoginResult> {
    if (typeof codeInput !== "string") throw new AppError(400, "登录凭证格式不正确")
    const code = codeInput.trim()
    if (!code || code.length > 512) throw new AppError(400, "登录凭证格式不正确")
    const identity = await this.codeExchange.exchange(code)
    if (!identity.provider || !identity.subject) {
      throw new AppError(502, "登录服务返回了无效身份", "UPSTREAM_ERROR")
    }
    const now = this.now()
    const nowText = now.toISOString()
    const subjectDigest = digest(identity.provider + "\u0000" + identity.subject)
    const token = this.tokenFactory()
    if (token.length < 32 || token.length > 512) {
      throw new Error("会话令牌生成器返回了无效长度")
    }
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString()
    const user = this.repo.transaction(() => {
      let current = this.repo.findUser(identity.provider, subjectDigest)
      if (!current) {
        current = {
          id: randomUUID(),
          provider: identity.provider,
          subjectDigest,
          displayName: "微信用户",
          createdAt: nowText,
          updatedAt: nowText
        }
        this.repo.createUser(current)
      }
      this.repo.saveSession({
        tokenDigest: digest(token),
        userId: current.id,
        expiresAt,
        createdAt: nowText
      })
      return current
    })
    return {
      accessToken: token,
      expiresAt,
      user: { id: user.id, displayName: user.displayName }
    }
  }

  authenticateRequest(req: IncomingMessage): Principal {
    return this.authenticateToken(bearerToken(req))
  }

  authenticateToken(token: string): Principal {
    const resolved = this.repo.resolveSession(digest(token))
    const now = this.now().getTime()
    if (!resolved || resolved.session.revokedAt
      || new Date(resolved.session.expiresAt).getTime() <= now) {
      throw new AppError(401, "业务身份凭证无效或已过期")
    }
    return { id: resolved.user.id, displayName: resolved.user.displayName }
  }

  logoutRequest(req: IncomingMessage): void {
    const token = bearerToken(req)
    const resolved = this.repo.resolveSession(digest(token))
    if (!resolved || resolved.session.revokedAt) {
      throw new AppError(401, "业务身份凭证无效或已过期")
    }
    this.repo.revokeSession(digest(token), this.now().toISOString())
  }
}
