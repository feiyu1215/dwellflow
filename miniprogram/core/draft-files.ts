function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error("草稿文件标识格式不正确")
  }
  return value
}

function extension(path: string): string {
  const match = /\.([a-zA-Z0-9]{1,10})$/.exec(path)
  return match ? "." + match[1].toLowerCase() : ""
}

function makeDirectory(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().mkdir({
      dirPath: path,
      recursive: true,
      success: () => resolve(),
      fail: result => reject(new Error(result.errMsg || "创建草稿目录失败"))
    })
  })
}

export async function persistDraftFile(
  draftId: string,
  attachmentId: string,
  sourcePath: string
): Promise<string> {
  const directory = wx.env.USER_DATA_PATH + "/renovation-drafts/"
    + safeId(draftId)
  await makeDirectory(directory)
  const destination = directory + "/" + safeId(attachmentId) + extension(sourcePath)
  await new Promise<void>((resolve, reject) => {
    wx.getFileSystemManager().copyFile({
      srcPath: sourcePath,
      destPath: destination,
      success: () => resolve(),
      fail: result => reject(new Error(result.errMsg || "草稿附件持久化失败"))
    })
  })
  return destination
}

export function removeDraftFiles(draftId: string): Promise<void> {
  const directory = wx.env.USER_DATA_PATH + "/renovation-drafts/"
    + safeId(draftId)
  return new Promise(resolve => {
    wx.getFileSystemManager().rmdir({
      dirPath: directory,
      recursive: true,
      complete: () => resolve()
    })
  })
}
