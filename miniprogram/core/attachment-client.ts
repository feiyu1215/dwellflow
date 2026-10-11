import {
  businessRequest,
  businessServiceConfig,
  ensureBusinessSession
} from "./business-client"

const CHUNK_BYTES = 2 * 1024 * 1024

export type AttachmentArea =
  | "records"
  | "agreements"
  | "materials"
  | "issues"
  | "expenses"

export interface RemoteAttachment {
  projectId: string
  id: string
  area: AttachmentArea
  resourceId: string
  fileName: string
  mediaType: string
  category: "image" | "audio" | "document"
  sizeBytes: number
  uploadedBytes: number
  status: "pending_upload" | "ready" | "failed" | "hidden"
  failureCode?: string
  version: number
}

export interface AttachmentUploadInput {
  projectId: string
  attachmentId: string
  reserveRequestId: string
  completeRequestId: string
  area: AttachmentArea
  resourceId: string
  filePath: string
  fileName: string
  mediaType: string
  category: "image" | "audio" | "document"
  durationMs?: number
  occurredAt?: string
  capturedAt?: string
  sha256?: string
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
}

function fileSize(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().stat({
      path,
      success(result) {
        if (Array.isArray(result.stats) || !result.stats.isFile()) {
          reject(new Error("附件本地路径不是文件"))
          return
        }
        resolve(result.stats.size)
      },
      fail() {
        reject(new Error("附件本地文件已丢失，请重新选择"))
      }
    })
  })
}

function readChunk(path: string, position: number, length: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      position,
      length,
      success(result) {
        if (typeof result.data === "string") {
          reject(new Error("附件分块读取格式不正确"))
          return
        }
        resolve(result.data)
      },
      fail() {
        reject(new Error("附件分块读取失败，本地草稿仍保留"))
      }
    })
  })
}

export async function uploadAttachment(
  input: AttachmentUploadInput
): Promise<RemoteAttachment> {
  const sizeBytes = await fileSize(input.filePath)
  const root = "/v1/projects/" + input.projectId
    + "/attachments/" + input.attachmentId
  await businessRequest<RemoteAttachment>(
    "/v1/projects/" + input.projectId + "/attachments",
    "POST",
    {
      requestId: input.reserveRequestId,
      id: input.attachmentId,
      area: input.area,
      resourceId: input.resourceId,
      fileName: input.fileName,
      mediaType: input.mediaType,
      category: input.category,
      sizeBytes,
      durationMs: input.durationMs,
      occurredAt: input.occurredAt,
      capturedAt: input.capturedAt,
      sha256: input.sha256
    }
  )
  let current = await businessRequest<RemoteAttachment>(root)
  if (current.status === "ready") return current

  for (let offset = 0, index = 0; offset < sizeBytes; index++) {
    const length = Math.min(CHUNK_BYTES, sizeBytes - offset)
    const chunk = await readChunk(input.filePath, offset, length)
    await businessRequest<RemoteAttachment>(
      root + "/chunks/" + index,
      "PUT",
      chunk,
      {
        "Content-Type": "application/octet-stream",
        "x-chunk-offset": String(offset)
      }
    )
    offset += length
    input.onProgress?.(offset, sizeBytes)
  }

  current = await businessRequest<RemoteAttachment>(root)
  return businessRequest<RemoteAttachment>(
    root + "/complete",
    "POST",
    {
      requestId: input.completeRequestId,
      expectedVersion: current.version
    }
  )
}

export async function downloadAttachment(
  projectId: string,
  attachmentId: string
): Promise<string> {
  const session = await ensureBusinessSession()
  const config = businessServiceConfig()
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: config.baseUrl + "/v1/projects/" + projectId
        + "/attachments/" + attachmentId + "/content",
      header: { Authorization: "Bearer " + session.accessToken },
      timeout: 55_000,
      success(result) {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.tempFilePath)
          return
        }
        reject(new Error(result.statusCode === 404
          ? "附件不存在或当前身份已无权访问"
          : "附件下载失败，请稍后重试"))
      },
      fail() {
        reject(new Error("附件下载中断，请检查网络后重试"))
      }
    })
  })
}
