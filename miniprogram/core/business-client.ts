const BUSINESS_CONFIG_KEY = "renovation-business-service-v1"
const BUSINESS_SESSION_KEY = "renovation-business-session-v1"

export interface BusinessServiceConfig {
  baseUrl: string
}

export interface BusinessSession {
  accessToken: string
  expiresAt: string
  user: {
    id: string
    displayName: string
  }
}

export class BusinessApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "BusinessApiError"
    this.status = status
    this.code = code
  }
}

export function businessServiceConfig(): BusinessServiceConfig {
  return wx.getStorageSync<BusinessServiceConfig>(BUSINESS_CONFIG_KEY)
    || { baseUrl: "http://127.0.0.1:8787" }
}

export function saveBusinessServiceConfig(config: BusinessServiceConfig): void {
  const baseUrl = config.baseUrl.replace(/\/$/, "")
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/.test(baseUrl)
    && !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    throw new Error("使用 HTTPS 服务地址或本机回环地址")
  }
  wx.setStorageSync(BUSINESS_CONFIG_KEY, { baseUrl })
}

export function currentBusinessSession(): BusinessSession | undefined {
  const session = wx.getStorageSync<BusinessSession>(BUSINESS_SESSION_KEY)
  if (!session?.accessToken || !session.expiresAt) return undefined
  return session
}

function requestLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        if (result.code) resolve(result.code)
        else reject(new BusinessApiError(401, "WECHAT_LOGIN_FAILED", "微信登录未返回凭证"))
      },
      fail() {
        reject(new BusinessApiError(0, "NETWORK_ERROR", "微信登录失败，请检查网络后重试"))
      }
    })
  })
}

function rawRequest<T>(input: {
  path: string
  method: "GET" | "POST" | "PUT"
  data?: unknown
  token?: string
  header?: Record<string, string>
}): Promise<T> {
  const config = businessServiceConfig()
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.baseUrl + input.path,
      method: input.method,
      data: input.data as string | object | ArrayBuffer | undefined,
      header: {
        ...(input.token ? { Authorization: "Bearer " + input.token } : {}),
        "Content-Type": "application/json",
        ...input.header
      },
      timeout: 55_000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T)
          return
        }
        const error = response.data as { error?: string; code?: string }
        reject(new BusinessApiError(
          response.statusCode,
          error?.code || "REQUEST_FAILED",
          error?.error || "服务请求失败"
        ))
      },
      fail() {
        reject(new BusinessApiError(
          0, "NETWORK_ERROR", "连接中断，已保留本地内容，请稍后重试"
        ))
      }
    })
  })
}

export async function loginBusiness(): Promise<BusinessSession> {
  const code = await requestLoginCode()
  const session = await rawRequest<BusinessSession>({
    path: "/v1/auth/wechat",
    method: "POST",
    data: { code }
  })
  wx.setStorageSync(BUSINESS_SESSION_KEY, session)
  return session
}

export async function ensureBusinessSession(): Promise<BusinessSession> {
  const current = currentBusinessSession()
  if (current && new Date(current.expiresAt).getTime() > Date.now() + 30_000) {
    return current
  }
  wx.removeStorageSync(BUSINESS_SESSION_KEY)
  return loginBusiness()
}

export async function logoutBusiness(): Promise<void> {
  const current = currentBusinessSession()
  try {
    if (current) {
      await rawRequest({
        path: "/v1/auth/logout",
        method: "POST",
        token: current.accessToken
      })
    }
  } finally {
    wx.removeStorageSync(BUSINESS_SESSION_KEY)
  }
}

export async function businessRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  data?: unknown,
  header?: Record<string, string>
): Promise<T> {
  const session = await ensureBusinessSession()
  try {
    return await rawRequest<T>({
      path, method, data, token: session.accessToken, header
    })
  } catch (error) {
    if (error instanceof BusinessApiError && error.status === 401) {
      wx.removeStorageSync(BUSINESS_SESSION_KEY)
    }
    throw error
  }
}
