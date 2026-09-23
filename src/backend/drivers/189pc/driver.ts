// 天翼云盘客户端（189CloudPC）驱动 —— Cloudflare Workers 适配版
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc
//
// 与 Go 版驱动的能力对照：
//   - 支持个人云 / 家庭云（family）两种视图；
//   - 支持账号密码登录，以及 access_token / refresh_token 续期；
//   - List / Get / Mkdir / Rename / Move / Copy / Remove / Put 全量实现；
//   - 家庭云转存（family_transfer）、迅雷下载插件、torrent 追随等 Go 版高级特性暂不支持。

import {
  FileItem,
  StorageDriver,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { md5Hex } from "../189/crypto"
import { DEFAULT_ROOT_ID, SUBREQUEST_LIMIT } from "./consts"
import type {
  Cloud189PCAddition,
  Cloud189PCFile,
  Cloud189PCFolder,
  Cloud189PCObject,
  PersistedTokens,
  UploadSession,
} from "./types"
import {
  Cloud189PCClient,
  parse189PCTime,
  parseHttpHeader,
  partSize,
} from "./util"

/** 189 会把单引号转义成 \'，展示时需要还原 */
function normalizeName(name: string): string {
  return (name || "").replace(/\\'/g, "'")
}

function toFileItem(obj: Cloud189PCObject): FileItem {
  if (obj.isFolder) {
    const folder = obj as Cloud189PCFolder
    return {
      name: normalizeName(folder.name),
      size: 0,
      is_dir: true,
      modified: parse189PCTime(folder.lastOpTime || folder.createDate),
      sign: folder.id,
      type: 1,
      thumb: "",
      raw_url: "",
    }
  }
  const file = obj as Cloud189PCFile
  return {
    name: normalizeName(file.name),
    size: Number(file.size) || 0,
    is_dir: false,
    modified: parse189PCTime(file.lastOpTime || file.createDate),
    sign: file.id,
    type: calcFileType(file.name, false),
    thumb: file.icon?.smallUrl || file.icon?.largeUrl || "",
    raw_url: "",
    hash: file.md5 || undefined,
    hashes: file.md5 ? { md5: file.md5 } : undefined,
  }
}

export function normalizeCloud189PCAddition(a: any): Cloud189PCAddition {
  const norm = { ...(a || {}) } as any
  norm.username = String(norm.username || "").trim()
  norm.password = String(norm.password || "").trim()
  norm.validate_code = String(norm.validate_code || "").trim()
  norm.access_token = String(norm.access_token || "").trim()
  norm.refresh_token = String(norm.refresh_token || "").trim()
  norm.login_type = norm.login_type || "password"
  norm.type = norm.type === "family" ? "family" : "personal"
  norm.family_id = String(norm.family_id || "").trim()
  norm.order_by = norm.order_by || "filename"
  norm.order_direction = norm.order_direction || "asc"
  norm.upload_method = norm.upload_method || "stream"

  // 家庭云根目录没有 -11，个人云必须显式使用 -11
  if (norm.type === "family") {
    if (!norm.root_folder_id || norm.root_folder_id === DEFAULT_ROOT_ID) {
      norm.root_folder_id = ""
    }
  } else if (!norm.root_folder_id) {
    norm.root_folder_id = DEFAULT_ROOT_ID
  }

  const thread = Number(norm.upload_thread)
  norm.upload_thread =
    Number.isInteger(thread) && thread >= 1 && thread <= 32
      ? String(thread)
      : "3"
  return norm as Cloud189PCAddition
}

function encodeSession(session: UploadSession): string {
  const bytes = new TextEncoder().encode(JSON.stringify(session))
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function decodeSession(token: string): UploadSession {
  try {
    const binary = atob(token)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const session = JSON.parse(new TextDecoder().decode(bytes)) as UploadSession
    if (
      !session?.uploadFileId ||
      !Number.isInteger(session.partCount) ||
      session.partCount < 1
    ) {
      throw new Error("invalid session")
    }
    return session
  } catch {
    throw new Error("[189PC] 上传会话无效或已损坏")
  }
}

function segmentsOf(path: string): string[] {
  return String(path || "")
    .split("/")
    .filter(Boolean)
}

function maybeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
  )
}

export class Cloud189PCDriver implements StorageDriver {
  private client: Cloud189PCClient
  private addition: Cloud189PCAddition
  /** physicalPath -> folderId 缓存 */
  private pathIdCache = new Map<string, string>()
  /** Cloudflare Workers 单次请求的子请求预算 */
  private budget = { used: 0, limit: SUBREQUEST_LIMIT }

  constructor(
    addition: Cloud189PCAddition,
    persistTokens?: (tokens: PersistedTokens) => void | Promise<void>,
  ) {
    this.addition = normalizeCloud189PCAddition(addition)
    this.client = new Cloud189PCClient(this.addition, persistTokens)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  get config() {
    return {
      name: "189CloudPC",
      localSort: false,
      onlyLocal: false,
      onlyProxy: false,
      noCache: false,
      noUpload: false,
      defaultRoot: this.addition.root_folder_id || DEFAULT_ROOT_ID,
    }
  }

  // ------------------------------------------------------------ 路径解析

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.addition.root_folder_id ?? DEFAULT_ROOT_ID
    const clean = "/" + segmentsOf(physicalPath).join("/")
    if (clean === "/" || clean === `/${rootId}`) return rootId

    const segs = segmentsOf(physicalPath)
    let parentId = rootId
    let cachedLen = 0

    for (let i = 0; i < segs.length; i++) {
      const prefix = "/" + segs.slice(0, i + 1).join("/")
      const cached = this.pathIdCache.get(prefix)
      if (cached !== undefined) {
        parentId = cached
        cachedLen = i + 1
      } else {
        break
      }
    }

    for (let i = cachedLen; i < segs.length; i++) {
      const rawName = segs[i]
      const decodedName = maybeDecode(rawName)
      const objects = await this.client.getFiles(parentId)
      const folder = objects.find(
        (obj) =>
          obj.isFolder &&
          (obj.name === rawName ||
            obj.name === decodedName ||
            String(obj.id) === rawName ||
            String(obj.id) === decodedName),
      )
      if (!folder) throw new Error(`[189PC] 目录未找到: ${rawName}`)
      parentId = String(folder.id)
      this.pathIdCache.set("/" + segs.slice(0, i + 1).join("/"), parentId)
    }

    return parentId
  }

  private async resolveObject(physicalPath: string): Promise<{
    object: Cloud189PCObject
    parentId: string
    isDir: boolean
  }> {
    const segs = segmentsOf(physicalPath)
    if (segs.length === 0) throw new Error("[189PC] 路径无效")

    const rawName = segs[segs.length - 1]
    const decodedName = maybeDecode(rawName)
    const parentId = await this.resolveFolderId(
      "/" + segs.slice(0, -1).join("/"),
    )
    const objects = await this.client.getFiles(parentId)

    const matched = objects.find(
      (obj) =>
        obj.name === rawName ||
        obj.name === decodedName ||
        String(obj.id) === rawName ||
        String(obj.id) === decodedName,
    )
    if (!matched) throw new Error(`[189PC] 文件或目录未找到: ${rawName}`)
    return { object: matched, parentId, isDir: matched.isFolder }
  }

  private orderByKey(): string {
    switch (this.addition.order_by) {
      case "filesize":
        return "size"
      case "lastOpTime":
        return "modified"
      default:
        return "name"
    }
  }

  // ------------------------------------------------------------ StorageDriver

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.budget.used = 0
    const folderId = await this.resolveFolderId(physicalPath)
    const objects = await this.client.getFiles(folderId)
    return sortFileItems(
      objects.map(toFileItem),
      this.orderByKey(),
      this.addition.order_direction === "desc" ? "desc" : "asc",
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.budget.used = 0
    const segs = segmentsOf(physicalPath)
    const rootId = this.addition.root_folder_id ?? DEFAULT_ROOT_ID
    if (segs.length === 0 || segs[segs.length - 1] === rootId) {
      return {
        name: rootId,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: rootId,
        type: 1,
        thumb: "",
        raw_url: "",
      }
    }

    const { object } = await this.resolveObject(physicalPath)
    const item = toFileItem(object)
    if (!item.is_dir) {
      try {
        item.raw_url = await this.client.getFileDownloadUrl(item.sign)
        item.raw_url_headers = this.client.getDownloadHeaders()
      } catch (e: any) {
        console.warn(`[189PC] 获取 ${item.name} 下载地址失败:`, e?.message)
        item.raw_url_error = e?.message || "获取下载地址失败"
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.budget.used = 0
    const segs = segmentsOf(physicalPath)
    const dirName = segs.pop() || "新文件夹"
    const parentId = await this.resolveFolderId("/" + segs.join("/"))
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    const { object } = await this.resolveObject(physicalPath)
    await this.client.rename(String(object.id), object.isFolder, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    const { object } = await this.resolveObject(physicalPath)
    await this.client.remove(String(object.id), object.name, object.isFolder)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const { object } = await this.resolveObject(srcPhysical)
    const targetId = await this.resolveFolderId(dstDir)
    await this.client.move(
      String(object.id),
      object.name,
      object.isFolder,
      targetId,
    )
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const { object } = await this.resolveObject(srcPhysical)
    const targetId = await this.resolveFolderId(dstDir)
    await this.client.copy(
      String(object.id),
      object.name,
      object.isFolder,
      targetId,
    )
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const segs = segmentsOf(physicalPath)
    const fileName = segs.pop()
    if (!fileName) throw new Error("[189PC] 上传路径无效")
    const parentId = await this.resolveFolderId("/" + segs.join("/"))
    await this.uploadWholeFile(parentId, fileName, toBytes(content))
  }

  // ------------------------------------------------------------ 上传实现

  /**
   * Worker 侧 put 收到的是完整内容，可以直接算出整文件 md5 与分片校验值，
   * 走「一次 init + 逐片 PUT + commit」（等价于 Go 版 StreamUpload）。
   */
  private async uploadWholeFile(
    parentId: string,
    fileName: string,
    content: Uint8Array,
  ): Promise<void> {
    const size = content.length
    const sliceSize = partSize(size)
    const partCount = Math.max(1, Math.ceil(size / sliceSize))
    const fileMd5 = md5Hex(content).toUpperCase()

    const partMd5s: string[] = []
    for (let i = 1; i <= partCount; i++) {
      const start = (i - 1) * sliceSize
      const chunk = content.subarray(start, Math.min(start + sliceSize, size))
      partMd5s.push(md5Hex(chunk).toUpperCase())
    }
    const sliceMd5 =
      partCount > 1 ? md5Hex(partMd5s.join("\n")).toUpperCase() : fileMd5

    const extra: Record<string, string> = {
      fileMd5,
      sliceMd5,
      lazyCheck: "1",
      opertype: "3",
    }
    if (this.client.isFamily()) extra.familyId = this.client.getFamilyId()

    const init = await this.client.initMultiUpload(
      parentId,
      fileName,
      size,
      sliceSize,
      extra,
    )

    if (init.fileDataExists !== 1) {
      for (let i = 1; i <= partCount; i++) {
        const start = (i - 1) * sliceSize
        const chunk = content.subarray(start, Math.min(start + sliceSize, size))
        const partInfo = this.client.partInfoOf(i, chunk)
        const target = await this.client.getUploadUrls(
          init.uploadFileId,
          i,
          partInfo,
        )
        await this.client.uploadPartRaw(
          target.requestURL!,
          parseHttpHeader(target.requestHeader),
          chunk,
        )
      }
    }

    await this.client.commitMultiUpload(init.uploadFileId, {
      fileMd5,
      sliceMd5,
      lazyCheck: "1",
      opertype: "3",
    })
  }

  /** 服务层 /fs/multipart/* 使用的三段式分片上传 */
  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    md5: string,
  ): Promise<{
    reuse: boolean
    requiresMd5?: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    const totalSize = Math.max(0, Number(size) || 0)
    const sliceSize = partSize(totalSize)
    const normalizedMd5 = String(md5 || "")
      .trim()
      .toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(normalizedMd5)) {
      // initMultiUpload 需要整体 md5 才能做秒传与校验，让前端先算好 md5 再重试，
      // 避免 Worker 侧缓冲整个文件。
      return {
        reuse: false,
        requiresMd5: true,
        partCount: 0,
        chunkSize: sliceSize,
        session: "",
      }
    }

    const fileMd5 = normalizedMd5.toUpperCase()
    const partCount = Math.max(1, Math.ceil(totalSize / sliceSize))
    const parentId = await this.resolveFolderId(physicalDir || "/")
    const extra: Record<string, string> = {
      fileMd5,
      lazyCheck: "1",
      opertype: "3",
    }
    if (this.client.isFamily()) extra.familyId = this.client.getFamilyId()

    const init = await this.client.initMultiUpload(
      parentId,
      fileName,
      totalSize,
      sliceSize,
      extra,
    )

    const commitExtra = {
      fileMd5,
      sliceMd5: fileMd5,
      lazyCheck: "1",
      opertype: "3",
    }
    if (init.fileDataExists === 1) {
      await this.client.commitMultiUpload(init.uploadFileId, commitExtra)
      return { reuse: true, partCount: 0, chunkSize: sliceSize, session: "" }
    }

    return {
      reuse: false,
      partCount,
      chunkSize: sliceSize,
      session: encodeSession({
        uploadFileId: init.uploadFileId,
        fileMd5,
        size: totalSize,
        partCount,
        sliceSize,
        isFamily: this.client.isFamily(),
        familyId: this.client.getFamilyId(),
      }),
    }
  }

  async uploadPart(
    sessionToken: string,
    partNumber: number,
    content: Buffer,
  ): Promise<{ partMd5: string }> {
    const session = decodeSession(sessionToken)
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.partCount
    ) {
      throw new Error(`[189PC] 分片序号无效: ${partNumber}`)
    }
    const bytes = toBytes(content)
    const partInfo = this.client.partInfoOf(partNumber, bytes)
    const target = await this.client.getUploadUrls(
      session.uploadFileId,
      partNumber,
      partInfo,
    )
    await this.client.uploadPartRaw(
      target.requestURL!,
      parseHttpHeader(target.requestHeader),
      bytes,
    )
    return { partMd5: md5Hex(bytes).toLowerCase() }
  }

  async completeUploadSession(
    sessionToken: string,
    partMd5s: string[] = [],
  ): Promise<void> {
    const session = decodeSession(sessionToken)
    const normalized = partMd5s
      .map((part) =>
        String(part || "")
          .trim()
          .toUpperCase(),
      )
      .filter((part) => /^[A-F0-9]{32}$/.test(part))
    if (normalized.length !== session.partCount) {
      throw new Error("[189PC] 分片校验信息不完整，无法提交上传")
    }
    const sliceMd5 =
      session.partCount === 1
        ? session.fileMd5
        : md5Hex(normalized.join("\n")).toUpperCase()
    await this.client.commitMultiUpload(session.uploadFileId, {
      fileMd5: session.fileMd5,
      sliceMd5,
      lazyCheck: "1",
      opertype: "3",
    })
  }
}
