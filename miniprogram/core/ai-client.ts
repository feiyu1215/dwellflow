import type { AiInput, AiJob } from "./ai-contract"
import type { RecordInputExtractionRequest, RecordInputExtractionResponse } from "./record-input-contract"
const CONFIG_KEY = "renovation-ai-service"
export interface ServiceConfig { baseUrl: string; token: string }
export function serviceConfig(): ServiceConfig {
  return wx.getStorageSync<ServiceConfig>(CONFIG_KEY) || { baseUrl: "http://127.0.0.1:8787", token: "" }
}
export function saveServiceConfig(config: ServiceConfig) {
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/.test(config.baseUrl)
    && !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.baseUrl)) throw new Error("使用 HTTPS 服务地址或本机回环地址")
  if (config.token.length < 32) throw new Error("请填写服务访问凭证，不是模型密钥")
  wx.setStorageSync(CONFIG_KEY, config)
}
export function apiRequest<T>(path: string, method: "GET" | "POST" = "GET", data?: object): Promise<T> {
  const config = serviceConfig()
  if (!config.token) return Promise.reject(new Error("请先在 AI 工作台配置本机服务连接"))
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.baseUrl + path, method, data,
      header: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
      timeout: 55000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T)
        else reject(new Error((response.data as { error?: string }).error || "服务请求失败"))
      },
      fail: () => reject(new Error("连接中断或超时。请查询任务历史后再决定是否重试"))
    })
  })
}
export const runAi = (input: AiInput) => apiRequest<AiJob>("/v1/ai/jobs?async=1", "POST", input)
export const readAiJob = (id: string) => apiRequest<AiJob>("/v1/ai/jobs/" + id)
export const cancelAiJob = (id: string) => apiRequest<AiJob>("/v1/ai/jobs/" + id + "/cancel", "POST", {})
export const retryAiJob = (id: string) => apiRequest<AiJob>("/v1/ai/jobs/" + id + "/retry", "POST", {})
export const extractRecordInput = (input: RecordInputExtractionRequest) =>
  apiRequest<RecordInputExtractionResponse>("/v1/input-drafts/record:extract", "POST", input)
