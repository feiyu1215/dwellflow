export interface LocalEvidenceFileInfo {
  sizeBytes: number
  sha256: string
}

export function persistEvidenceFile(tempFilePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().saveFile({
      tempFilePath,
      success: result => resolve(result.savedFilePath),
      fail: () => reject(new Error("原件持久化失败"))
    })
  })
}

export function inspectEvidenceFile(localPath: string): Promise<LocalEvidenceFileInfo> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath: localPath,
      digestAlgorithm: "sha256",
      success: result => resolve({ sizeBytes: result.size, sha256: result.digest.toLowerCase() }),
      fail: () => reject(new Error("原件不可读取"))
    })
  })
}
