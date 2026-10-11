import { AppError } from "./validation.ts"
import type { LoginCodeExchange, LoginCodeIdentity } from "./auth-session.ts"

interface WechatSessionResponse {
  openid?: string
  session_key?: string
  unionid?: string
  errcode?: number
  errmsg?: string
}

export class WechatCodeExchange implements LoginCodeExchange {
  private readonly appId: string
  private readonly appSecret: string
  private readonly fetchImpl: typeof fetch

  constructor(
    appId: string,
    appSecret: string,
    fetchImpl: typeof fetch = fetch
  ) {
    if (!appId || !appSecret) throw new Error("微信 AppID 和 AppSecret 均不能为空")
    this.appId = appId
    this.appSecret = appSecret
    this.fetchImpl = fetchImpl
  }

  async exchange(code: string): Promise<LoginCodeIdentity> {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session")
    url.search = new URLSearchParams({
      appid: this.appId,
      secret: this.appSecret,
      js_code: code,
      grant_type: "authorization_code"
    }).toString()
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(8_000)
      })
    } catch {
      throw new AppError(502, "微信登录服务暂时不可用，请稍后重试", "UPSTREAM_ERROR")
    }
    let body: WechatSessionResponse
    try {
      body = await response.json() as WechatSessionResponse
    } catch {
      throw new AppError(502, "微信登录服务响应异常，请稍后重试", "UPSTREAM_ERROR")
    }
    if (!response.ok) {
      throw new AppError(502, "微信登录服务暂时不可用，请稍后重试", "UPSTREAM_ERROR")
    }
    if (body.errcode || !body.openid) {
      throw new AppError(401, "微信登录凭证无效或已使用", "WECHAT_LOGIN_FAILED")
    }
    return {
      provider: "wechat:" + this.appId,
      subject: body.openid
    }
  }
}
