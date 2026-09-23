// 天翼云盘客户端（PC 协议）API 客户端
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc
//
// 与 Go 版的差异（Cloudflare Workers 适配）：
//   - 全部 cipher 走 ../189/crypto 的纯 TS 实现（crypto-js + BigInt），不引入 Node `crypto` 裸模块，
//     因此在 Cloudflare Workers / EdgeOne / Node 容器里行为一致；
//   - 去掉 Go 版每 5 分钟的 keepAlive cron（Worker 无常驻定时器），改为会话失效时按需刷新；
//   - 上传改为串行执行，避免耗尽单次请求的子请求配额。

import {
  aes128EcbEncryptHex,
  hmacSha1Hex,
  md5Base64,
  randomUUID189,
  rsaEncode,
} from "../189/crypto"
import {
  ACCOUNT_TYPE,
  API_URL,
  APP_ID,
  AUTH_URL,
  BATCH_TASK_MAX_POLL,
  BATCH_TASK_POLL_MS,
  CHANNEL_ID,
  CLIENT_TYPE,
  FILE_LIST_PAGE_SIZE,
  PC,
  RETURN_URL,
  UPLOAD_URL,
  USER_AGENT,
  USER_INVALID_OPEN_TOKEN_ERROR,
  VERSION,
  WEB_URL,
} from "./consts"
import type {
  AppSessionResp,
  BatchTaskInfo,
  BatchTaskStateResp,
  Cloud189PCAddition,
  Cloud189PCObject,
  Cloud189PCFilesResp,
  EncryptConfResp,
  FamilyInfoListResp,
  InitMultiUploadResp,
  InitMultiUploadResult,
  LoginResp,
  PersistedTokens,
  RespErr,
  UploadUrlsData,
  UploadUrlsResp,
} from "./types"

const MIB = 1024 * 1024

/** 提取用于签名的 RequestURI（等价于 Go 的正则提取） */
export function requestUri(fullUrl: string): string {
  const matched = /:\/\/[^/]+((?:\/[^/\s?#]+)*)/.exec(fullUrl)
  return matched?.[1] ?? ""
}

/** 带 params 的 HMAC-SHA1 会话签名，输出大写十六进制（Go: signatureOfHmac） */
export function signatureOfHmac(
  sessionSecret: string,
  sessionKey: string,
  operate: string,
  fullUrl: string,
  dateOfGmt: string,
  params: string = "",
): string {
  const urlpath = requestUri(fullUrl)
  let data = `SessionKey=${sessionKey}&Operate=${operate}&RequestURI=${urlpath}&Date=${dateOfGmt}`
  if (params) data += `&params=${params}`
  return hmacSha1Hex(data, sessionSecret).toUpperCase()
}

/** 固定请求尾参（Go: clientSuffix） */
export function clientSuffix(): Record<string, string> {
  const rand = `${Math.floor(Math.random() * 1e5)}_${Math.floor(
    Math.random() * 1e10,
  )}`
  return {
    clientType: PC,
    version: VERSION,
    channelId: CHANNEL_ID,
    rand,
  }
}

/** query 加密前的序列化：按键排序、原样拼接（Go: Params.Encode） */
export function encodeParams(
  params?: Record<string, string | number | undefined>,
): string {
  if (!params) return ""
  return Object.keys(params)
    .sort()
    .filter((key) => params[key] !== undefined)
    .map((key) => `${key}=${String(params[key])}`)
    .join("&")
}

/** 计算分片大小：10MiB / 20MiB / 更大，避免分片数量超过服务端上限（Go: partSize） */
export function partSize(size: number): number {
  const DEFAULT = 10 * MIB
  if (size > DEFAULT * 2 * 999) {
    return Math.max(Math.ceil(size / 1999 / DEFAULT), 5) * DEFAULT
  }
  if (size > DEFAULT * 999) return DEFAULT * 2
  return DEFAULT
}

export function toDesc(direction?: string): string {
  return direction === "desc" ? "true" : "false"
}

export function toFamilyOrderBy(orderBy?: string): string {
  switch (orderBy) {
    case "filename":
      return "1"
    case "filesize":
      return "2"
    case "lastOpTime":
      return "3"
    default:
      return "1"
  }
}

export function parseHttpHeader(str?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!str) return headers
  let raw = str
  try {
    raw = decodeURIComponent(raw)
  } catch {}
  for (const item of raw.split("&")) {
    const separator = item.indexOf("=")
    if (separator <= 0) continue
    headers[item.slice(0, separator)] = item.slice(separator + 1)
  }
  return headers
}

/** Go url.QueryEscape 风格：空格编码为 `+` */
export function queryEscape(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+")
}

/**
 * 解析天翼云盘返回的多种时间格式：
 *  "2024-01-15 10:30:00 +08" / "Jan 15, 2024, 10:30:00 AM +08"
 * 时间串里可能含 U+202F / U+00A0，需先归一化为普通空格。
 */
export function parse189PCTime(value?: string): string {
  const fallback = new Date().toISOString()
  if (!value) return fallback
  const raw = String(value)
    .trim()
    .replace(/["']/g, "")
    .replace(/[\u202f\u00a0]/g, " ")

  for (const candidate of [raw, `${raw} +08`]) {
    const numeric = candidate
      .replace(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})/, "$1-$2-$3T$4")
      .replace(
        /\s*([+-])(\d{2}):?(\d{2})?\s*$/,
        (_m, sign, hh, mm) => `${sign}${hh}:${mm ?? "00"}`,
      )
    const numericDate = new Date(numeric)
    if (!isNaN(numericDate.getTime())) return numericDate.toISOString()

    const english = candidate
      .replace(/,/g, "")
      .replace(/\s*([+-])(\d{2}):?(\d{2})?\s*$/, " GMT$1$2:00")
    const englishDate = new Date(english)
    if (!isNaN(englishDate.getTime())) return englishDate.toISOString()
  }
  return fallback
}

function hasError(data: RespErr): boolean {
  const rc = data.res_code
  if (typeof rc === "number") return rc !== 0
  if (typeof rc === "string") return rc !== "" && rc !== "0"
  if (data.code && data.code !== "SUCCESS") return true
  if (data.errorCode) return true
  if (data.error) return true
  return false
}

function errorMessage(data: RespErr, raw: string): string {
  return `[189PC] API 错误: ${
    data.res_message ||
    data.errorMsg ||
    data.msg ||
    data.message ||
    raw.slice(0, 200)
  }`
}

/** int64 的 ID 在 JS 中会丢精度，统一转成字符串处理 */
function parseJsonPreservingIds(text: string): any {
  const protectedText = text.replace(
    /("(?:id|parentId|familyId|userFileId|size|fileSize)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g,
    '$1"$2"',
  )
  return JSON.parse(protectedText)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class Cloud189PCClient {
  private addition: Cloud189PCAddition
  private persistTokens?: (tokens: PersistedTokens) => void | Promise<void>

  tokenInfo: AppSessionResp | null = null
  /** 本次登录使用的图片验证码，登录后立即销毁 */
  validateCode: string = ""

  constructor(
    addition: Cloud189PCAddition,
    persistTokens?: (tokens: PersistedTokens) => void | Promise<void>,
  ) {
    this.addition = addition
    this.persistTokens = persistTokens
  }

  // -------------------------------------------------------------- 基础信息

  isFamily(): boolean {
    return this.addition.type === "family"
  }

  getFamilyId(): string {
    return String(this.addition.family_id || "")
  }

  getRootId(): string {
    return this.addition.root_folder_id ?? "-11"
  }

  private sessionPair(isFamily: boolean): { key: string; secret: string } {
    if (!this.tokenInfo) return { key: "", secret: "" }
    if (isFamily) {
      return {
        key: this.tokenInfo.familySessionKey || "",
        secret: this.tokenInfo.familySessionSecret || "",
      }
    }
    return {
      key: this.tokenInfo.sessionKey || "",
      secret: this.tokenInfo.sessionSecret || "",
    }
  }

  private signatureHeader(
    url: string,
    method: string,
    isFamily: boolean,
  ): Record<string, string> {
    const dateOfGmt = new Date().toUTCString()
    const { key, secret } = this.sessionPair(isFamily)
    return {
      Date: dateOfGmt,
      SessionKey: key,
      "X-Request-ID": randomUUID189(),
      Signature: signatureOfHmac(secret, key, method, url, dateOfGmt),
    }
  }

  /** AES-128-ECB + PKCS7 加密 params，输出大写十六进制 */
  encryptParams(
    params?: Record<string, string | number | undefined>,
    isFamily: boolean = this.isFamily(),
  ): string {
    const plain = encodeParams(params)
    if (!plain) return ""
    const secret = this.sessionPair(isFamily).secret
    // Go 版 AesECBEncrypt 输出大写十六进制，保持一致以确保服务端一致解析
    return aes128EcbEncryptHex(plain, secret.slice(0, 16)).toUpperCase()
  }

  // -------------------------------------------------------------- 登录体系

  async init(): Promise<void> {
    if (this.addition.login_type === "qrcode") {
      throw new Error(
        "[189PC] 扫码登录需要交互式获取二维码，Cloudflare Workers 部署请使用「密码」登录方式",
      )
    }

    if (this.addition.access_token) {
      this.tokenInfo = {
        accessToken: this.addition.access_token,
        refreshToken: this.addition.refresh_token,
      }
      try {
        await this.refreshSession()
        await this.afterSessionReady()
        return
      } catch {
        // accessToken 失效，继续尝试用 refreshToken 刷新
      }
    }

    if (this.addition.refresh_token) {
      this.tokenInfo = { refreshToken: this.addition.refresh_token }
      try {
        await this.refreshToken()
        await this.afterSessionReady()
        return
      } catch {
        // refreshToken 同样失效，回落完整登录
      }
    }

    await this.loginByPassword()
    await this.afterSessionReady()
  }

  /** 家庭云场景下自动补全 family_id */
  private async afterSessionReady(): Promise<void> {
    if (!this.isFamily() || this.addition.family_id) return
    const list = await this.getFamilyInfoList()
    if (list.length === 0) {
      throw new Error("[189PC] 无法自动获取家庭云 ID，请在配置中填写 family_id")
    }
    const loginName = this.tokenInfo?.loginName || ""
    const matched = list.find(
      (info) => info.remarkName && loginName.includes(info.remarkName),
    )
    this.addition.family_id = String((matched ?? list[0]).familyId ?? "")
  }

  async loginByPassword(): Promise<void> {
    this.validateCode = String(this.addition.validate_code || "").trim()
    try {
      const param = await this.initLoginParam()
      if (!this.validateCode && param.captchaRequired) {
        throw new Error(
          "[189PC] need img validate code: 请在存储配置的验证码字段中填写图片验证码后重新保存",
        )
      }

      const loginResp = (await this.requestForm(
        AUTH_URL + "/api/logbox/oauth2/loginSubmit.do",
        {
          appKey: APP_ID,
          accountType: ACCOUNT_TYPE,
          userName: param.rsaUsername,
          password: param.rsaPassword,
          validateCode: this.validateCode,
          captchaToken: param.captchaToken,
          returnUrl: RETURN_URL,
          dynamicCheck: "FALSE",
          clientType: CLIENT_TYPE,
          cb_SaveName: "1",
          isOauth2: "false",
          state: "",
          paramId: param.paramId,
        },
        { REQID: param.reqId, lt: param.lt },
      )) as LoginResp

      if (!loginResp.toUrl) {
        throw new Error(
          `[189PC] 登录失败: ${loginResp.msg || "未获取到 toUrl"}`,
        )
      }
      await this.getSessionForPC(loginResp.toUrl)
    } finally {
      this.validateCode = ""
    }
  }

  /** 抓取 lt / reqId / paramId / captchaToken（Go: initBaseParams） */
  private async initBaseParams(): Promise<{
    captchaToken: string
    lt: string
    paramId: string
    reqId: string
  }> {
    const url = new URL(WEB_URL + "/api/portal/unifyLoginForPC.action")
    for (const [k, v] of Object.entries({
      appId: APP_ID,
      clientType: CLIENT_TYPE,
      returnURL: RETURN_URL,
      timeStamp: String(Date.now()),
    })) {
      url.searchParams.set(k, v)
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json;charset=UTF-8",
        Referer: WEB_URL,
      },
    })
    const html = await res.text()
    const pick = (re: RegExp) => re.exec(html)?.[1] ?? ""
    const result = {
      captchaToken:
        pick(/'captchaToken'\s+value='(.+?)'/) ||
        pick(/captchaToken["']?\s*[:=]\s*["']([^"']+)["']/),
      lt: pick(/lt\s*=\s*["'](.+?)["']/),
      paramId: pick(/paramId\s*=\s*["'](.+?)["']/),
      reqId: pick(/reqId\s*=\s*["'](.+?)["']/),
    }
    if (!result.lt || !result.paramId || !result.reqId) {
      throw new Error("[189PC] 获取登录参数失败，请检查网络或稍后重试")
    }
    return result
  }

  private async initLoginParam(): Promise<{
    captchaToken: string
    lt: string
    paramId: string
    reqId: string
    rsaUsername: string
    rsaPassword: string
    captchaRequired: boolean
  }> {
    const base = await this.initBaseParams()

    const conf = (await this.requestForm(
      AUTH_URL + "/api/logbox/config/encryptConf.do",
      { appId: APP_ID },
    )) as EncryptConfResp
    const pubKey = conf.data?.pubKey
    if (!pubKey) throw new Error("[189PC] 获取 RSA 公钥失败")

    const pre = conf.data?.pre || ""
    const pem = `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`
    const rsaUsername = pre + rsaEncode(this.addition.username || "", pem, true)
    const rsaPassword = pre + rsaEncode(this.addition.password || "", pem, true)

    const needRes = await fetch(
      AUTH_URL + "/api/logbox/oauth2/needcaptcha.do",
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json;charset=UTF-8",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: WEB_URL,
          REQID: base.reqId,
        },
        body: new URLSearchParams({
          appKey: APP_ID,
          accountType: ACCOUNT_TYPE,
          userName: rsaUsername,
        }).toString(),
      },
    )
    const needText = (await needRes.text()).trim()
    return {
      ...base,
      rsaUsername,
      rsaPassword,
      captchaRequired: needText !== "0" && needText !== "",
    }
  }

  /** 用 OAuth 回调地址换取 accessToken / sessionKey */
  private async getSessionForPC(redirectURL: string): Promise<AppSessionResp> {
    const url = new URL(API_URL + "/getSessionForPC.action")
    for (const [k, v] of Object.entries(clientSuffix())) {
      url.searchParams.set(k, v)
    }
    url.searchParams.set("redirectURL", redirectURL)

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json;charset=UTF-8",
      },
    })
    const text = await res.text()
    const data = parseJsonPreservingIds(text) as AppSessionResp & RespErr
    if (hasError(data)) throw new Error(errorMessage(data, text))
    if (data.res_code !== undefined && Number(data.res_code) !== 0) {
      throw new Error(`[189PC] 获取会话失败: ${data.res_message || ""}`)
    }
    await this.applyTokens(data)
    return data
  }

  private async applyTokens(info: AppSessionResp): Promise<void> {
    this.tokenInfo = info
    if (info.accessToken) this.addition.access_token = info.accessToken
    if (info.refreshToken) this.addition.refresh_token = info.refreshToken
    if (this.persistTokens) {
      await this.persistTokens({
        access_token: info.accessToken || this.addition.access_token || "",
        refresh_token: info.refreshToken || this.addition.refresh_token || "",
      })
    }
  }

  /** 刷新会话（sessionKey / sessionSecret 有时效） */
  async refreshSession(): Promise<void> {
    if (!this.tokenInfo?.accessToken) throw new Error("[189PC] 尚未登录")
    const url = new URL(API_URL + "/getSessionForPC.action")
    for (const [k, v] of Object.entries(clientSuffix())) {
      url.searchParams.set(k, v)
    }
    url.searchParams.set("appId", APP_ID)
    url.searchParams.set("accessToken", this.tokenInfo.accessToken)

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json;charset=UTF-8",
        "X-Request-ID": randomUUID189(),
      },
    })
    const text = await res.text()
    const data = parseJsonPreservingIds(text) as AppSessionResp & RespErr

    if (data.errorCode === USER_INVALID_OPEN_TOKEN_ERROR) {
      await this.refreshToken()
      return
    }
    if (hasError(data)) throw new Error(errorMessage(data, text))

    this.tokenInfo = {
      ...(this.tokenInfo || {}),
      sessionKey: data.sessionKey || this.tokenInfo?.sessionKey,
      sessionSecret: data.sessionSecret || this.tokenInfo?.sessionSecret,
      familySessionKey: data.familySessionKey,
      familySessionSecret: data.familySessionSecret,
      loginName: data.loginName || this.tokenInfo?.loginName,
    }
  }

  /** 用 refreshToken 换新令牌 */
  async refreshToken(): Promise<void> {
    const tokenInfo = (await this.requestForm(
      AUTH_URL + "/api/oauth2/refreshToken.do",
      {
        clientId: APP_ID,
        refreshToken: this.tokenInfo?.refreshToken || "",
        grantType: "refresh_token",
        format: "json",
      },
    )) as AppSessionResp

    this.tokenInfo = {
      ...(this.tokenInfo || {}),
      accessToken: tokenInfo.accessToken,
      refreshToken: tokenInfo.refreshToken,
    }
    await this.applyTokens(this.tokenInfo)
  }

  // -------------------------------------------------------------- 通用请求

  private async requestForm(
    url: string,
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<any> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json;charset=UTF-8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    })
    const text = await res.text()
    return JSON.parse(text)
  }

  /**
   * 带签名的资源请求
   * @param params 需要 AES 加密后作为 `params` 传出的参数（上传接口）
   * @param query 明文 query 参数（列表等接口）
   */
  async request(
    url: string,
    method: string,
    options: {
      query?: Record<string, string | number | undefined>
      params?: Record<string, string | number | undefined>
      form?: Record<string, string>
      isFamily?: boolean
      retryCount?: number
    } = {},
  ): Promise<any> {
    const {
      query,
      params,
      form,
      isFamily = this.isFamily(),
      retryCount = 0,
    } = options
    if (!this.tokenInfo) throw new Error("[189PC] login failed")

    const urlObj = new URL(url)
    for (const [k, v] of Object.entries(clientSuffix())) {
      urlObj.searchParams.set(k, v)
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) urlObj.searchParams.set(k, String(v))
      }
    }
    const encrypted = params ? this.encryptParams(params, isFamily) : ""
    if (encrypted) urlObj.searchParams.set("params", encrypted)

    const headers: Record<string, string> = {
      Accept: "application/json;charset=UTF-8",
      "User-Agent": USER_AGENT,
      Referer: WEB_URL,
      ...this.signatureHeader(url, method, isFamily),
    }
    let body: string | undefined
    if (form) {
      headers["Content-Type"] =
        "application/x-www-form-urlencoded; charset=UTF-8"
      body = new URLSearchParams(form).toString()
    }

    const res = await fetch(urlObj.toString(), { method, headers, body })
    const text = await res.text()

    if (
      text.includes("userSessionBO is null") ||
      text.includes("InvalidSessionKey")
    ) {
      if (retryCount >= 1) {
        throw new Error("[189PC] 会话刷新后仍失效，请检查账号配置")
      }
      await this.refreshSession()
      return this.request(url, method, {
        ...options,
        retryCount: retryCount + 1,
      })
    }

    let data: any
    try {
      data = parseJsonPreservingIds(text)
    } catch {
      throw new Error(`[189PC] 非预期响应: ${text.slice(0, 200)}`)
    }
    if (hasError(data as RespErr)) {
      throw new Error(errorMessage(data as RespErr, text))
    }
    return data
  }

  // -------------------------------------------------------------- 文件操作

  async getFiles(folderId: string): Promise<Cloud189PCObject[]> {
    const isFamily = this.isFamily()
    const fullUrl =
      (isFamily ? API_URL + "/family/file" : API_URL) + "/listFiles.action"
    const orderBy = this.addition.order_by || "filename"
    const descending = toDesc(this.addition.order_direction || "asc")
    const result: Cloud189PCObject[] = []

    for (let pageNum = 1; ; pageNum++) {
      const query: Record<string, string> = {
        folderId,
        fileType: "0",
        mediaAttr: "0",
        iconOption: "5",
        pageNum: String(pageNum),
        pageSize: String(FILE_LIST_PAGE_SIZE),
      }
      if (isFamily) {
        query.familyId = this.getFamilyId()
        query.orderBy = toFamilyOrderBy(orderBy)
        query.descending = descending
      } else {
        query.recursive = "0"
        query.orderBy = orderBy
        query.descending = descending
      }

      const resp = (await this.request(fullUrl, "GET", {
        query,
        isFamily,
      })) as Cloud189PCFilesResp
      const ao = resp.fileListAO
      if (!ao || Number(ao.count) === 0) break
      const folders = ao.folderList || []
      const files = ao.fileList || []
      for (const folder of folders) {
        result.push({ ...folder, id: String(folder.id), isFolder: true })
      }
      for (const file of files) {
        result.push({
          ...file,
          id: String(file.id),
          parentId: folderId,
          isFolder: false,
        })
      }
      if (folders.length + files.length < FILE_LIST_PAGE_SIZE) break
    }
    return result
  }

  async getFileDownloadUrl(fileId: string): Promise<string> {
    const isFamily = this.isFamily()
    const fullUrl =
      (isFamily ? API_URL + "/family/file" : API_URL) +
      "/getFileDownloadUrl.action"
    const query: Record<string, string> = { fileId }
    if (isFamily) {
      query.familyId = this.getFamilyId()
    } else {
      query.dt = "3"
      query.flag = "1"
    }
    const resp = (await this.request(fullUrl, "GET", {
      query,
      isFamily,
    })) as { fileDownloadUrl?: string }

    let url = (resp.fileDownloadUrl || "").replace(/&amp;/g, "&")
    if (!url) throw new Error("[189PC] 获取下载地址失败")
    url = url.replace(/^http:\/\//i, "https://")

    // 跟随一次 302 拿到 CDN 直链
    try {
      const probe = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
      })
      const location = probe.headers.get("location")
      if (probe.status === 302 && location) {
        url = location.replace(/^http:\/\//i, "https://")
      }
    } catch {
      // 探测失败时保留原始地址
    }
    return url
  }

  getDownloadHeaders(): Record<string, string> {
    return { "User-Agent": USER_AGENT }
  }

  async mkdir(parentId: string, folderName: string): Promise<void> {
    const isFamily = this.isFamily()
    const fullUrl =
      (isFamily ? API_URL + "/family/file" : API_URL) + "/createFolder.action"
    const query: Record<string, string> = { folderName, relativePath: "" }
    if (isFamily) {
      query.familyId = this.getFamilyId()
      query.parentId = parentId
    } else {
      query.parentFolderId = parentId
    }
    await this.request(fullUrl, "POST", { query, isFamily })
  }

  async rename(id: string, isFolder: boolean, newName: string): Promise<void> {
    const isFamily = this.isFamily()
    const fullUrl =
      (isFamily ? API_URL + "/family/file" : API_URL) +
      (isFolder ? "/renameFolder.action" : "/renameFile.action")
    const query: Record<string, string> = {}
    if (isFamily) query.familyId = this.getFamilyId()
    if (isFolder) {
      query.folderId = id
      query.destFolderName = newName
    } else {
      query.fileId = id
      query.destFileName = newName
    }
    await this.request(fullUrl, "POST", { query, isFamily })
  }

  async move(
    id: string,
    fileName: string,
    isFolder: boolean,
    targetFolderId: string,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "MOVE",
      this.getFamilyId(),
      targetFolderId,
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("MOVE", taskId)
  }

  async copy(
    id: string,
    fileName: string,
    isFolder: boolean,
    targetFolderId: string,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "COPY",
      this.getFamilyId(),
      targetFolderId,
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("COPY", taskId)
  }

  async remove(id: string, fileName: string, isFolder: boolean): Promise<void> {
    const taskId = await this.createBatchTask(
      "DELETE",
      this.getFamilyId(),
      "",
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("DELETE", taskId)
  }

  private async createBatchTask(
    aType: string,
    familyId: string,
    targetFolderId: string,
    taskInfos: BatchTaskInfo[],
  ): Promise<string> {
    const form: Record<string, string> = {
      type: aType,
      taskInfos: JSON.stringify(taskInfos),
    }
    if (targetFolderId) form.targetFolderId = targetFolderId
    if (familyId) form.familyId = familyId
    const resp = (await this.request(
      API_URL + "/batch/createBatchTask.action",
      "POST",
      { form, isFamily: familyId !== "" },
    )) as { taskId?: string }
    if (!resp.taskId) throw new Error("[189PC] 创建批量任务失败")
    return resp.taskId
  }

  private async waitBatchTask(aType: string, taskId: string): Promise<void> {
    for (let i = 0; i < BATCH_TASK_MAX_POLL; i++) {
      const resp = (await this.request(
        API_URL + "/batch/checkBatchTask.action",
        "POST",
        { form: { type: aType, taskId } },
      )) as BatchTaskStateResp
      const status = resp.taskStatus
      if (status === 4) return
      if (status === 2) throw new Error("[189PC] 目标位置存在同名文件")
      await sleep(BATCH_TASK_POLL_MS)
    }
    throw new Error("[189PC] 批量任务执行超时")
  }

  private async getFamilyInfoList(): Promise<
    NonNullable<FamilyInfoListResp["familyInfoResp"]>
  > {
    const resp = (await this.request(
      API_URL + "/family/manage/getFamilyList.action",
      "GET",
      { isFamily: true },
    )) as FamilyInfoListResp
    return resp.familyInfoResp || []
  }

  // -------------------------------------------------------------- 上传

  private uploadBase(isFamily: boolean): string {
    return isFamily ? UPLOAD_URL + "/family" : UPLOAD_URL + "/person"
  }

  /** 初始化分片上传，返回 uploadFileId 与秒传标记 */
  async initMultiUpload(
    parentId: string,
    fileName: string,
    fileSize: number,
    sliceSize: number,
    extra: Record<string, string | number | undefined> = {},
  ): Promise<InitMultiUploadResult> {
    const isFamily = this.isFamily()
    const params: Record<string, string | number | undefined> = {
      parentFolderId: parentId,
      fileName: queryEscape(fileName),
      fileSize: String(fileSize),
      sliceSize: String(sliceSize),
      lazyCheck: "1",
      ...extra,
    }
    if (isFamily && params.familyId === undefined) {
      params.familyId = this.getFamilyId()
    }

    const resp = (await this.request(
      this.uploadBase(isFamily) + "/initMultiUpload",
      "GET",
      { params, isFamily },
    )) as InitMultiUploadResp
    const data = resp.data
    if (!data?.uploadFileId) throw new Error("[189PC] 初始化分片上传失败")
    return {
      uploadFileId: String(data.uploadFileId),
      fileDataExists: data.fileDataExists === 1 ? 1 : 0,
    }
  }

  /** 获取指定分片的上传地址 */
  async getUploadUrls(
    uploadFileId: string,
    partNumber: number,
    partInfo: string,
  ): Promise<UploadUrlsData> {
    const isFamily = this.isFamily()
    const resp = (await this.request(
      this.uploadBase(isFamily) + "/getMultiUploadUrls",
      "GET",
      { params: { uploadFileId, partInfo }, isFamily },
    )) as UploadUrlsResp

    const urls = resp.uploadUrls || {}
    const entry = urls[`partNumber_${partNumber}`] || Object.values(urls)[0]
    if (!entry?.requestURL) throw new Error("[189PC] 获取分片上传地址失败")
    return entry
  }

  /** 上传单个分片：PUT 裸流，头部由服务端下发，不参与会话签名 */
  async uploadPartRaw(
    url: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): Promise<void> {
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: body as unknown as BodyInit,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `[189PC] 分片上传失败: HTTP ${res.status} ${text.slice(0, 200)}`,
      )
    }
  }

  /** 提交分片上传 */
  async commitMultiUpload(
    uploadFileId: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const isFamily = this.isFamily()
    const params: Record<string, string> = {
      uploadFileId,
      isLog: "0",
      opertype: "3",
      lazyCheck: "1",
      ...extra,
    }
    if (isFamily && params.familyId === undefined) {
      params.familyId = this.getFamilyId()
    }
    await this.request(
      this.uploadBase(isFamily) + "/commitMultiUploadFile",
      "GET",
      {
        params,
        isFamily,
      },
    )
  }

  /** 计算 partInfo：`${序号}-${该分片 md5 的 base64}` */
  partInfoOf(partNumber: number, content: Uint8Array): string {
    return `${partNumber}-${md5Base64(content)}`
  }
}
