import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { BusinessRepository } from "../server/business-repository.ts"
import { BusinessService } from "../server/business-service.ts"
import {
  AuthSessionRepository,
  AuthSessionService,
  type LoginCodeExchange
} from "../server/auth-session.ts"
import { SessionBearerAuthenticator } from "../server/business-auth.ts"
import { WechatCodeExchange } from "../server/wechat-auth.ts"
import { Repository } from "../server/repository.ts"
import { createApi } from "../server/app.ts"

test("微信登录只下发短期业务会话，登出和过期后立即失效", async () => {
  let now = new Date("2026-09-25T10:00:00.000Z")
  let tokenCounter = 0
  const exchanger: LoginCodeExchange = {
    async exchange(code) {
      if (code !== "one-time-code") throw new Error("unexpected code")
      return { provider: "wechat:test-app", subject: "private-openid" }
    }
  }
  const aiRepo = new Repository(":memory:")
  const businessRepo = new BusinessRepository(":memory:")
  const sessions = new AuthSessionService(
    new AuthSessionRepository(businessRepo.db),
    exchanger,
    {
      sessionTtlMs: 60_000,
      now: () => now,
      tokenFactory: () => ("session-token-" + (++tokenCounter) + "-").padEnd(48, "x")
    }
  )
  const server = createApi(aiRepo, {
    model: "unused",
    async run() { throw new Error("not used") }
  }, "legacy-ai-token-".repeat(3), {
    business: new BusinessService(businessRepo),
    businessAuthenticator: new SessionBearerAuthenticator(sessions),
    authSessions: sessions
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const base = "http://127.0.0.1:" + address.port
  try {
    const loginResponse = await fetch(base + "/v1/auth/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "one-time-code" })
    })
    assert.equal(loginResponse.status, 200)
    const login = await loginResponse.json() as {
      accessToken: string
      expiresAt: string
      user: { id: string; displayName: string }
      openid?: string
      sessionKey?: string
    }
    assert.equal(login.accessToken, "session-token-1-".padEnd(48, "x"))
    assert.equal(login.openid, undefined)
    assert.equal(login.sessionKey, undefined)
    assert.equal(login.user.displayName, "微信用户")

    const auth = { Authorization: "Bearer " + login.accessToken }
    assert.equal((await fetch(base + "/v1/projects", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "session-project", name: "会话项目" })
    })).status, 201)

    const databaseText = JSON.stringify({
      users: businessRepo.db.prepare("SELECT * FROM auth_users").all(),
      sessions: businessRepo.db.prepare("SELECT * FROM auth_sessions").all()
    })
    assert.equal(databaseText.includes("private-openid"), false)
    assert.equal(databaseText.includes(login.accessToken), false)

    assert.equal((await fetch(base + "/v1/auth/logout", {
      method: "POST", headers: auth
    })).status, 200)
    assert.equal((await fetch(base + "/v1/projects", { headers: auth })).status, 401)

    const second = await sessions.login("one-time-code")
    now = new Date("2026-09-25T10:01:00.000Z")
    assert.throws(
      () => sessions.authenticateToken(second.accessToken),
      /无效或已过期/
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
    businessRepo.close()
    aiRepo.close()
  }
})

test("微信 code2Session 适配器不向业务层返回 session_key", async () => {
  let requested = ""
  const exchange = new WechatCodeExchange(
    "test-app-id",
    "server-only-secret",
    (async input => {
      requested = String(input)
      return new Response(JSON.stringify({
        openid: "openid-from-wechat",
        session_key: "must-not-leave-adapter"
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
  )
  assert.deepEqual(await exchange.exchange("single-use-code"), {
    provider: "wechat:test-app-id",
    subject: "openid-from-wechat"
  })
  const url = new URL(requested)
  assert.equal(url.origin, "https://api.weixin.qq.com")
  assert.equal(url.searchParams.get("js_code"), "single-use-code")
  assert.equal(url.searchParams.get("secret"), "server-only-secret")

  const rejected = new WechatCodeExchange(
    "test-app-id",
    "server-only-secret",
    (async () => new Response(JSON.stringify({
      errcode: 40029,
      errmsg: "invalid code"
    }), { status: 200 })) as typeof fetch
  )
  await assert.rejects(
    () => rejected.exchange("used-code"),
    /微信登录凭证无效或已使用/
  )
})
