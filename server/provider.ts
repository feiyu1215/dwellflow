import type { AiInput, AiUsage } from "../miniprogram/core/ai-contract.ts"
import type { RecordInputExtractionRequest } from "../miniprogram/core/record-input-contract.ts"
import { systemPrompt, contextText } from "./prompts.ts"
import { recordInputContextText, recordInputSystemPrompt } from "./record-input.ts"
import { AppError } from "./validation.ts"

export interface ProviderRunResult {
  output: unknown
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
}
export class ProviderRunFailure extends AppError {
  providerRequestId?: string
  responseModel?: string
  usage?: AiUsage
  constructor(message: string, metadata: Omit<ProviderRunResult, "output">) {
    super(502, message)
    this.name = "ProviderRunFailure"
    this.providerRequestId = metadata.providerRequestId
    this.responseModel = metadata.responseModel
    this.usage = metadata.usage
  }
}
export interface ModelProvider {
  model: string
  run(input: AiInput, knowledge: unknown[], signal?: AbortSignal): Promise<ProviderRunResult>
  extractRecordInput?(input: RecordInputExtractionRequest, signal?: AbortSignal): Promise<ProviderRunResult>
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

async function runJsonCompletion(input: {
  apiKey: string
  model: string
  system: string
  content: unknown
  signal?: AbortSignal
  fetcher: typeof fetch
}): Promise<ProviderRunResult> {
  if (!input.apiKey) throw new AppError(503, "服务端尚未配置模型密钥，人工功能仍可使用")
  let response: Response
  try {
    response = await input.fetcher("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.content }],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 3000,
        stream: false
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000)
    })
  } catch { throw new AppError(504, "模型请求失败或超时，可稍后重试") }
  if (!response.ok) throw new AppError(502, "模型服务暂不可用（HTTP " + response.status + "）")
  let body: {
    id?: string
    model?: string
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
    usage?: {
      prompt_tokens?: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
      completion_tokens?: number
      total_tokens?: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }
  try { body = await response.json() as typeof body }
  catch { throw new AppError(502, "模型返回内容不完整或不是有效 JSON") }
  const rawUsage = body.usage
  const metadata: Omit<ProviderRunResult, "output"> = {
    providerRequestId: body.id,
    responseModel: body.model,
    ...(rawUsage ? {
      usage: {
        promptTokens: nonNegativeInteger(rawUsage.prompt_tokens),
        cacheHitPromptTokens: nonNegativeInteger(rawUsage.prompt_cache_hit_tokens),
        cacheMissPromptTokens: nonNegativeInteger(rawUsage.prompt_cache_miss_tokens),
        completionTokens: nonNegativeInteger(rawUsage.completion_tokens),
        totalTokens: nonNegativeInteger(rawUsage.total_tokens),
        ...(rawUsage.completion_tokens_details?.reasoning_tokens === undefined ? {} : {
          reasoningTokens: nonNegativeInteger(rawUsage.completion_tokens_details.reasoning_tokens)
        })
      }
    } : {})
  }
  const choice = body.choices?.[0]
  if (choice?.finish_reason !== "stop" || !choice.message?.content) {
    throw new ProviderRunFailure("模型返回内容不完整或不是有效 JSON", metadata)
  }
  try { return { output: JSON.parse(choice.message.content), ...metadata } }
  catch { throw new ProviderRunFailure("模型返回内容不完整或不是有效 JSON", metadata) }
}

export function deepSeekProvider(apiKey: string, model: string, fetcher: typeof fetch = fetch): ModelProvider {
  return {
    model,
    async run(input, knowledge, signal) {
      const content: unknown[] = [{ type: "text", text: contextText(input, knowledge) }]
      for (const image of input.images) content.push(
        {
          type: "text",
          text: image.id
            ? `以下图片 ID 为 ${image.id}，属于资料 ${image.sourceId}`
            : "以下图片属于资料 " + image.sourceId
        },
        { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }
      )
      return runJsonCompletion({ apiKey, model, system: systemPrompt(input.task, input.mode), content, signal, fetcher })
    },
    async extractRecordInput(input, signal) {
      return runJsonCompletion({
        apiKey,
        model,
        system: recordInputSystemPrompt(),
        content: [{ type: "text", text: recordInputContextText(input) }],
        signal,
        fetcher
      })
    }
  }
}
