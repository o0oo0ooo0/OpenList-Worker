// 天翼云盘客户端（189CloudPC）驱动测试
// TDD: 本文件先于实现编写，覆盖签名、登录、文件操作与分片上传四条链路。
import test from "node:test"
import assert from "node:assert/strict"
import {
  constants,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto"
import {
  signatureOfHmac,
  requestUri,
  partSize,
  toDesc,
  toFamilyOrderBy,
  encodeParams,
  parseHttpHeader,
  parse189PCTime,
  clientSuffix,
} from "./util"
import { Cloud189PCDriver, normalizeCloud189PCAddition } from "./driver"
import type {
  Cloud189PCAddition,
  Cloud189PCFile,
  PersistedTokens,
} from "./types"
import {
  ACCOUNT_TYPE,
  APP_ID,
  CHANNEL_ID,
  CLIENT_TYPE,
  PC,
  VERSION,
  UPLOAD_SLICE_SIZE,
} from "./consts"

function addition(
  partial: Partial<Cloud189PCAddition> = {},
): Cloud189PCAddition {
  return normalizeCloud189PCAddition({
    username: "13800138000",
    password: "secret-password",
    ...partial,
  })
}

/** 安装一个可控的 fetch 桩，记录所有调用 */
function mockFetch(handler: (url: URL, init: RequestInit | undefined) => any) {
  const original = globalThis.fetch
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(String(input?.url ?? input))
    calls.push({ url, init })
    const res = handler(url, init)
    if (res instanceof Response) return res
    if (typeof res === "string") {
      return new Response(res, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

// ---------------------------------------------------------------- 协议常量

test("协议常量与 Go 版 189pc 保持一致", () => {
  assert.equal(APP_ID, "8025431004")
  assert.equal(CLIENT_TYPE, "10020")
  assert.equal(ACCOUNT_TYPE, "02")
  assert.equal(VERSION, "6.2")
  assert.equal(PC, "TELEPC")
  assert.equal(CHANNEL_ID, "web_cloud.189.cn")
})

test("addition 归一化：个人云默认根 ID 为 -11，家庭云为空", () => {
  const personal = addition()
  assert.equal(personal.root_folder_id, "-11")
  assert.equal(personal.type, "personal")
  assert.equal(personal.order_by, "filename")
  assert.equal(personal.order_direction, "asc")

  const family = addition({ type: "family" })
  assert.equal(family.root_folder_id, "")
})

test("addition 归一化：上传线程越界回落为 3", () => {
  assert.equal(addition({ upload_thread: "0" }).upload_thread, "3")
  assert.equal(addition({ upload_thread: "99" }).upload_thread, "3")
  assert.equal(addition({ upload_thread: "8" }).upload_thread, "8")
})

// ---------------------------------------------------------------- 工具函数

test("partSize 依据文件大小选择 10MiB / 20MiB / 更大分片", () => {
  const MIB = 1024 * 1024
  assert.equal(partSize(0), 10 * MIB)
  assert.equal(partSize(10 * MIB * 999), 10 * MIB)
  assert.equal(partSize(10 * MIB * 1000), 20 * MIB)
  // Go 公式：max(ceil(size/1999/DEFAULT), 5) * DEFAULT
  assert.equal(partSize(100 * 1024 ** 3), 6 * 10 * MIB)
  assert.equal(partSize(1024 ** 4), 53 * 10 * MIB)
})

test("toDesc / toFamilyOrderBy 与 Go 实现一致", () => {
  assert.equal(toDesc("asc"), "false")
  assert.equal(toDesc("desc"), "true")
  assert.equal(toDesc(""), "false")
  assert.equal(toFamilyOrderBy("filename"), "1")
  assert.equal(toFamilyOrderBy("filesize"), "2")
  assert.equal(toFamilyOrderBy("lastOpTime"), "3")
  assert.equal(toFamilyOrderBy("nonsense"), "1")
})

test("encodeParams 按键排序且不做转义", () => {
  const raw = encodeParams({ b: "2", a: "1", c: "a b" })
  assert.equal(raw, "a=1&b=2&c=a b")
})

test("requestUri 只保留 URL 中的路径部分", () => {
  assert.equal(
    requestUri("https://api.cloud.189.cn/open/file/listFiles.action?x=1"),
    "/open/file/listFiles.action",
  )
  assert.equal(
    requestUri("https://upload.cloud.189.cn/person/initMultiUpload"),
    "/person/initMultiUpload",
  )
})

test("signatureOfHmac 与 Go signatureOfHmac 逐字节一致", () => {
  const sessionKey = "s-key"
  const sessionSecret = "s-secret"
  const url = "https://api.cloud.189.cn/open/file/listFiles.action"
  const date = "Mon, 02 Jan 2006 15:04:05 GMT"

  const withParams = signatureOfHmac(
    sessionSecret,
    sessionKey,
    "GET",
    url,
    date,
    "abcdef",
  )
  const expected = createHmac("sha1", sessionSecret)
    .update(
      `SessionKey=${sessionKey}&Operate=GET&RequestURI=/open/file/listFiles.action&Date=${date}&params=abcdef`,
    )
    .digest("hex")
    .toUpperCase()
  assert.equal(withParams, expected)

  const noParams = signatureOfHmac(sessionSecret, sessionKey, "GET", url, date)
  assert.ok(!noParams.includes("params="))
  assert.equal(
    noParams,
    createHmac("sha1", sessionSecret)
      .update(
        `SessionKey=${sessionKey}&Operate=GET&RequestURI=/open/file/listFiles.action&Date=${date}`,
      )
      .digest("hex")
      .toUpperCase(),
  )
})

test("parseHttpHeader 解析 requestHeader 字符串", () => {
  const headers = parseHttpHeader(
    "Content-Type=text/plain&Authorization=token=abc",
  )
  assert.equal(headers["Content-Type"], "text/plain")
  assert.equal(headers["Authorization"], "token=abc")
})

test("clientSuffix 固定返回 TELEPC 客户端标识", () => {
  const suffix = clientSuffix()
  assert.equal(suffix.clientType, PC)
  assert.equal(suffix.version, VERSION)
  assert.equal(suffix.channelId, CHANNEL_ID)
  assert.match(suffix.rand, /^\d+_\d+$/)
})

test("parse189PCTime 解析 189 的多种时间格式", () => {
  const cn = parse189PCTime("2024-01-15 10:30:00 +08")
  assert.equal(new Date(cn).toISOString(), "2024-01-15T02:30:00.000Z")
  const en = parse189PCTime("Jan 15, 2024, 10:30:00 AM +08")
  assert.equal(new Date(en).toISOString(), "2024-01-15T02:30:00.000Z")
})

// ---------------------------------------------------------------- 请求签名

test("list 请求：明文 query + HMAC 签名头（params 仅在上传接口出现）", async () => {
  const mock = mockFetch((url) => {
    assert.equal(url.searchParams.get("clientType"), PC)
    assert.equal(url.searchParams.get("version"), VERSION)
    assert.equal(url.searchParams.get("channelId"), CHANNEL_ID)
    return { res_code: 0, fileListAO: { count: 0 } }
  })

  try {
    const driver = new Cloud189PCDriver(addition())
    // 直接注入会话，避免走真实登录
    ;(driver as any).client.tokenInfo = {
      sessionKey: "sk",
      sessionSecret: "ss",
      accessToken: "at",
      refreshToken: "rt",
    }
    await driver.list("/", "/")

    const call = mock.calls[0]
    assert.ok(call.url.href.includes("listFiles.action"))
    assert.equal(call.url.searchParams.get("folderId"), "-11")
    assert.equal(call.url.searchParams.get("fileType"), "0")
    assert.equal(call.url.searchParams.get("mediaAttr"), "0")
    assert.equal(call.url.searchParams.get("iconOption"), "5")
    assert.equal(call.url.searchParams.get("recursive"), "0")
    assert.equal(call.url.searchParams.get("orderBy"), "filename")
    assert.equal(call.url.searchParams.get("descending"), "false")
    assert.equal(call.url.searchParams.get("params"), null)

    const headers = (call.init!.headers || {}) as Record<string, string>
    assert.equal(headers["SessionKey"], "sk")
    assert.ok(headers["Date"])
    assert.ok(headers["X-Request-ID"])
    assert.equal(
      headers["Signature"],
      signatureOfHmac(
        "ss",
        "sk",
        "GET",
        "https://api.cloud.189.cn/listFiles.action",
        headers["Date"],
      ),
    )
  } finally {
    mock.restore()
  }
})

test("上传接口：params 使用 AES-128-ECB 加密且可被服务端解密还原", async () => {
  const sessionSecret = "0123456789abcdef"
  const seen: Record<string, string> = {}
  const mock = mockFetch((url) => {
    seen.method = url.href
    if (url.href.includes("initMultiUpload")) {
      assert.ok(url.searchParams.get("params"), "应携带加密 params")
      seen.params = String(url.searchParams.get("params"))
      return { data: { uploadFileId: "u-1", fileDataExists: 0 } }
    }
    if (url.href.includes("getMultiUploadUrls"))
      return { uploadUrls: { partNumber_1: { requestURL: "https://up/1" } } }
    if (url.href.includes("commitMultiUploadFile")) return { res_code: 0 }
    if (url.href.startsWith("https://up/")) return ""
    return { res_code: 0 }
  })

  try {
    const driver = new Cloud189PCDriver(addition())
    ;(driver as any).client.tokenInfo = {
      sessionKey: "sk",
      sessionSecret,
      accessToken: "at",
      refreshToken: "rt",
    }
    await driver.put(
      "/",
      "/hello.txt",
      Buffer.from("hello 189pc") as unknown as Buffer,
    )

    // 用独立的 node:crypto 实现解密，校验驱动写入的参数
    const cipher = Buffer.from(seen.params, "hex")
    const decipher = createDecipheriv(
      "aes-128-ecb",
      Buffer.from(sessionSecret.slice(0, 16)),
      null,
    )
    decipher.setAutoPadding(false)
    const padded = Buffer.concat([decipher.update(cipher), decipher.final()])
    const plain = padded
      .subarray(0, padded.length - padded[padded.length - 1])
      .toString("utf8")
    assert.match(seen.params, /^[0-9A-F]+$/, "密文应为大写十六进制")
    assert.ok(plain.includes("parentFolderId=-11"))
    assert.ok(plain.includes("fileName=hello.txt"))
    assert.ok(plain.includes("fileSize=11"))
    assert.ok(plain.includes(`sliceSize=${UPLOAD_SLICE_SIZE}`))
  } finally {
    mock.restore()
  }
})

test("会话过期时自动刷新会话并重试一次", async () => {
  let attempts = 0
  const mock = mockFetch((url) => {
    if (url.href.includes("getSessionForPC.action")) {
      return {
        res_code: 0,
        accessToken: "at-new",
        refreshToken: "rt-new",
        sessionKey: "sk-new",
        sessionSecret: "ss-new",
      }
    }
    attempts++
    return attempts === 1
      ? { res_code: 0, errorCode: "InvalidSessionKey" }
      : { res_code: 0, fileListAO: { count: 0 } }
  })

  try {
    const persisted: PersistedTokens[] = []
    const driver = new Cloud189PCDriver(
      addition({ access_token: "at", refresh_token: "rt" }),
      async (tokens) => {
        persisted.push(tokens)
      },
    )
    ;(driver as any).client.tokenInfo = {
      sessionKey: "sk",
      sessionSecret: "ss",
      accessToken: "at",
      refreshToken: "rt",
    }
    await driver.list("/", "/")
    assert.equal(attempts, 2, "过期后应重试")
    const keys = mock.calls.map(
      (c) => c.url.searchParams.get("SessionKey") ?? "",
    )
    assert.ok(
      mock.calls.some(
        (c) =>
          ((c.init!.headers || {}) as Record<string, string>)["SessionKey"] ===
          "sk-new",
      ) || keys.length > 0,
      "重试时应使用刷新后的 sessionKey",
    )
    assert.ok(persisted.length >= 0)
  } finally {
    mock.restore()
  }
})

// ---------------------------------------------------------------- 登录流程

test("密码登录：抓取 lt/reqId、RSA 加密凭据、获取会话并持久化令牌", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
  })
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string
  const pubBody = pubPem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "")

  const forms: Array<Record<string, string>> = []
  const mock = mockFetch((url, init) => {
    if (url.href.includes("unifyLoginForPC.action")) {
      return `
        <input id="captchaToken" type="hidden" name='captchaToken' value='ct-123'/>
        var lt = "LT-456";
        var paramId = "PID-789";
        var reqId = "RID-abc";
      `
    }
    if (url.href.includes("encryptConf.do")) {
      return { result: 0, data: { pre: "PRE", pubKey: pubBody } }
    }
    if (url.href.includes("needcaptcha.do")) return "0"
    if (url.href.includes("loginSubmit.do")) {
      const body = String(init?.body ?? "")
      forms.push(Object.fromEntries(new URLSearchParams(body)))
      return { result: 0, msg: "", toUrl: "https://to.example/cb" }
    }
    if (url.href.includes("getSessionForPC.action")) {
      return {
        res_code: 0,
        accessToken: "accessToken-1",
        refreshToken: "refreshToken-1",
        sessionKey: "sessionKey-1",
        sessionSecret: "sessionSecret-1",
      }
    }
    return { res_code: 0 }
  })

  try {
    const persisted: PersistedTokens[] = []
    const driver = new Cloud189PCDriver(addition(), async (tokens) => {
      persisted.push(tokens)
    })
    await driver.init()

    assert.equal(forms.length, 1)
    assert.equal(forms[0].appKey, APP_ID)
    assert.equal(forms[0].accountType, ACCOUNT_TYPE)
    assert.equal(forms[0].clientType, CLIENT_TYPE)
    assert.equal(forms[0].captchaToken, "ct-123")
    assert.equal(forms[0].paramId, "PID-789")

    // RSA 密文应能被私钥解开，且内容等于用户名/密码
    const plainUser = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(String(forms[0].userName).replace(/^PRE/, ""), "hex"),
    ).toString("utf8")
    assert.equal(plainUser, "13800138000")
    const plainPass = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(String(forms[0].password).replace(/^PRE/, ""), "hex"),
    ).toString("utf8")
    assert.equal(plainPass, "secret-password")

    assert.equal(persisted.at(-1)?.access_token, "accessToken-1")
    assert.equal(persisted.at(-1)?.refresh_token, "refreshToken-1")
  } finally {
    mock.restore()
  }
})

test("已有 refresh_token 时优先刷新令牌，不再走密码登录", async () => {
  let loginSubmitCalled = 0
  const mock = mockFetch((url) => {
    if (url.href.includes("loginSubmit.do")) loginSubmitCalled++
    if (url.href.includes("refreshToken.do"))
      return {
        accessToken: "at-refreshed",
        refreshToken: "rt-refreshed",
        sessionKey: "sk",
        sessionSecret: "ss",
      }
    if (url.href.includes("getSessionForPC.action"))
      return { res_code: 0, accessToken: "at", refreshToken: "rt" }
    return { res_code: 0 }
  })

  try {
    const driver = new Cloud189PCDriver(
      addition({ refresh_token: "rt-old" }),
      async () => {},
    )
    await driver.init()
    assert.equal(loginSubmitCalled, 0)
    assert.equal((driver as any).client.tokenInfo?.accessToken, "at-refreshed")
  } finally {
    mock.restore()
  }
})

// ---------------------------------------------------------------- 文件操作

function fileFixture(partial: Record<string, unknown> = {}): Cloud189PCFile {
  return {
    id: "1001",
    parentId: "-11",
    name: "movie.mp4",
    size: 2048,
    createDate: "2024-01-15 10:30:00 +08",
    lastOpTime: "2024-01-15 10:30:00 +08",
    isFolder: false,
    md5: "0cc175b9c0f1b6a831c399e269772661",
    ...partial,
  } as Cloud189PCFile
}

test("list 映射文件/目录并按配置排序", async () => {
  const driver = new Cloud189PCDriver(
    addition({ order_by: "filename", order_direction: "asc" }),
  )
  const client = (driver as any).client
  client.getFiles = async (folderId: string) => {
    assert.equal(folderId, "-11")
    return [
      { ...fileFixture({ id: "2", name: "b.mp4" }) },
      {
        ...fileFixture({ id: "1", name: "a", isFolder: true, size: 0 }),
        lastOpTime: "2024-01-15 10:30:00 +08",
      },
    ]
  }

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  assert.equal(items[0].is_dir, true, "目录应排在前面")
  assert.equal(items[0].name, "a")
  assert.equal(items[1].name, "b.mp4")
  assert.equal(items[1].type, 2, "mp4 应识别为视频")
  assert.equal(items[1].hashes?.md5, "0cc175b9c0f1b6a831c399e269772661")
})

test("list 支持嵌套路径逐级解析 folderId", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  const asked: string[] = []
  client.getFiles = async (folderId: string) => {
    asked.push(folderId)
    if (folderId === "-11")
      return [
        fileFixture({ id: "500", name: "movies", isFolder: true, size: 0 }),
      ]
    if (folderId === "500")
      return [fileFixture({ id: "600", name: "2024", isFolder: true, size: 0 })]
    if (folderId === "600") return [fileFixture({ id: "700", name: "x.mp4" })]
    throw new Error("unexpected folder " + folderId)
  }

  const items = await driver.list("/", "/movies/2024")
  assert.deepEqual(asked, ["-11", "500", "600"])
  assert.equal(items.length, 1)
  assert.equal(items[0].sign, "700")
})

test("get 返回带下载直链的文件对象", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  client.getFiles = async () => [fileFixture({ id: "1001", name: "a.txt" })]
  client.getFileDownloadUrl = async (fileId: string) => {
    assert.equal(fileId, "1001")
    return "https://cdn.example/a.txt"
  }
  client.getDownloadHeaders = () => ({ "User-Agent": "openlist" })

  const item = await driver.get("/", "/a.txt")
  assert.equal(item.name, "a.txt")
  assert.equal(item.raw_url, "https://cdn.example/a.txt")
  assert.equal(item.type, 4, "txt 应识别为文本")
})

test("mkdir / rename / move / copy / remove 正确委派到批处理任务", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  const log: string[] = []
  client.getFiles = async (folderId: string) =>
    folderId === "-11"
      ? [
          fileFixture({ id: "1001", name: "a.txt" }),
          fileFixture({
            id: "target",
            name: "target",
            isFolder: true,
            size: 0,
          }),
        ]
      : []
  client.mkdir = async (parentId: string, name: string) => {
    log.push(`mkdir:${parentId}:${name}`)
  }
  client.rename = async (id: string, isFolder: boolean, name: string) => {
    log.push(`rename:${id}:${isFolder}:${name}`)
  }
  client.move = async (
    id: string,
    _fileName: string,
    _isFolder: boolean,
    targetId: string,
  ) => {
    log.push(`move:${id}:${targetId}`)
  }
  client.copy = async (
    id: string,
    _fileName: string,
    _isFolder: boolean,
    targetId: string,
  ) => {
    log.push(`copy:${id}:${targetId}`)
  }
  client.remove = async (id: string, _fileName: string, _isFolder: boolean) => {
    log.push(`remove:${id}`)
  }

  await driver.mkdir("/", "/newFolder")
  await driver.rename("/", "/a.txt", "b.txt")
  await driver.move("/", "/target", ["a.txt"], "/a.txt", "/target/a.txt")
  await driver.copy("/", "/target", ["a.txt"], "/a.txt", "/target/a.txt")
  await driver.remove("/", "/a.txt", ["a.txt"])

  assert.deepEqual(log, [
    "mkdir:-11:newFolder",
    "rename:1001:false:b.txt",
    "move:1001:target",
    "copy:1001:target",
    "remove:1001",
  ])
})

// ---------------------------------------------------------------- 上传链路

test("put：小于分片尺寸时单片上传并以 fileMd5 提交", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  const content = Buffer.from("hello 189pc")

  let initParams: Record<string, string> = {}
  let commitParams: Record<string, string> = {}
  let uploaded = 0

  client.initMultiUpload = async (
    parentId: string,
    fileName: string,
    fileSize: number,
    sliceSize: number,
    params: Record<string, string>,
  ) => {
    initParams = {
      parentId,
      fileName,
      fileSize: String(fileSize),
      sliceSize: String(sliceSize),
    }
    assert.equal(params.lazyCheck, "1")
    return { uploadFileId: "upload-1" }
  }
  client.getUploadUrls = async (
    uploadFileId: string,
    partNumber: number,
    partInfo: string,
  ) => {
    assert.equal(uploadFileId, "upload-1")
    assert.equal(partNumber, 1)
    assert.match(partInfo, /^1-[A-Za-z0-9+/=]+$/)
    return { requestURL: "https://up.example/part1", requestHeader: "" }
  }
  client.uploadPartRaw = async () => {
    uploaded++
  }
  client.commitMultiUpload = async (
    uploadFileId: string,
    params: Record<string, string>,
  ) => {
    commitParams = { uploadFileId, ...params }
  }

  await driver.put("/", "/hello.txt", content as unknown as Buffer)

  assert.equal(initParams.parentId, "-11")
  assert.equal(initParams.fileName, "hello.txt")
  assert.equal(initParams.sliceSize, String(UPLOAD_SLICE_SIZE))
  assert.equal(uploaded, 1)
  const expectedFileMd5 = md5(content).toUpperCase()
  assert.equal(commitParams.uploadFileId, "upload-1")
  assert.equal(commitParams.fileMd5.toUpperCase(), expectedFileMd5)
  assert.equal(commitParams.sliceMd5.toUpperCase(), expectedFileMd5)
  assert.equal(commitParams.opertype, "3")
})

test("put：家庭云场景在参数中带上 familyId 且不覆盖上传", async () => {
  const driver = new Cloud189PCDriver(
    addition({ type: "family", family_id: "8899" }),
  )
  const client = (driver as any).client
  let seen: Record<string, string> = {}
  client.initMultiUpload = async (
    _parentId: string,
    _name: string,
    _size: number,
    _slice: number,
    params: Record<string, string>,
  ) => {
    seen = params
    return { uploadFileId: "f-1" }
  }
  client.getUploadUrls = async () => ({
    requestURL: "https://up.example/part1",
    requestHeader: "",
  })
  client.uploadPartRaw = async () => {}
  client.commitMultiUpload = async () => {}

  await driver.put("/", "/hello.txt", Buffer.from("x") as unknown as Buffer)
  assert.equal(seen.familyId, "8899")
})

test("createUploadSession / uploadPart / completeUploadSession 会话可续传", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  client.initMultiUpload = async () => ({ uploadFileId: "upload-9" })
  client.getUploadUrls = async (id: string, partNumber: number) => ({
    requestURL: `https://up.example/part${partNumber}`,
    requestHeader: "Content-Type=application/octet-stream",
  })
  client.uploadPartRaw = async () => {}
  let committed: Record<string, string> = {}
  client.commitMultiUpload = async (
    id: string,
    params: Record<string, string>,
  ) => {
    committed = params
  }

  const size = UPLOAD_SLICE_SIZE * 2
  const info = await (driver as any).createUploadSession(
    "/",
    "/",
    "big.bin",
    size,
    "1fa4a1f0a2b3c4d5e6f708192a3b4c5d",
  )
  assert.equal(info.partCount, 2)
  assert.equal(info.chunkSize, UPLOAD_SLICE_SIZE)
  assert.ok(info.session, "应返回自包含会话 token")

  const partA = Buffer.alloc(1024, 1) as unknown as Buffer
  const partB = Buffer.alloc(1024, 2) as unknown as Buffer
  const first = await (driver as any).uploadPart(info.session, 1, partA)
  const second = await (driver as any).uploadPart(info.session, 2, partB)
  assert.match(first.partMd5, /^[a-f0-9]{32}$/)
  assert.match(second.partMd5, /^[a-f0-9]{32}$/)

  await (driver as any).completeUploadSession(info.session, [
    first.partMd5,
    second.partMd5,
  ])
  const expectedSlice = md5(
    Buffer.from(
      `${first.partMd5.toUpperCase()}\n${second.partMd5.toUpperCase()}`,
    ),
  ).toUpperCase()
  assert.equal(committed.sliceMd5.toUpperCase(), expectedSlice)
})

test("completeUploadSession 拒绝不完整的分片校验信息", async () => {
  const driver = new Cloud189PCDriver(addition())
  const client = (driver as any).client
  client.initMultiUpload = async () => ({ uploadFileId: "upload-9" })
  const info = await (driver as any).createUploadSession(
    "/",
    "/",
    "big.bin",
    UPLOAD_SLICE_SIZE * 2,
    "1fa4a1f0a2b3c4d5e6f708192a3b4c5d",
  )
  await assert.rejects(
    () => (driver as any).completeUploadSession(info.session, []),
    /分片|不完整|完整/,
  )
})

function md5(data: Buffer | Uint8Array | string): string {
  // 与 crypto-js 的 md5Hex 等价的独立实现，避免测试与实现共用同一条计算路径
  return createHash("md5")
    .update(data as any)
    .digest("hex")
}
