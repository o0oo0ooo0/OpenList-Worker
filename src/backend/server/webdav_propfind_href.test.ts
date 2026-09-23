import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { webdavRouter } from "./webdav"
import { hashPasswordSHA256 } from "./auth"
import { saveDb } from "../internal/model/db"

/**
 * WebDAV PROPFIND href 前缀回归（对齐 Go server/webdav/webdav.go）：
 *
 *   href := path.Join(h.Prefix, reqPath) // Prefix = /dav
 *   if href != "/" && info.IsDir() { href += "/" }
 *
 * 此前 Worker 版把剥离了 /dav 的内部虚拟路径直接写进 <d:href>：
 * PROPFIND /dav/ 返回 <d:href>/</d:href> 与 <d:href>/local</d:href>。
 * rclone 校验返回的 href 必须位于 WebDAV 根 URL（/dav/）之下，于是报
 * `Item with unknown path received: "/local/", "/dav/"`，列不出任何文件。
 * 目录 href 还缺尾部斜杠（RFC 4918 §5.2 SHOULD，Go 版会补）。
 */

const tmpRoots: string[] = []

function makeLocalRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-dav-href-"))
  fs.writeFileSync(path.join(root, "hello.txt"), "x")
  fs.mkdirSync(path.join(root, "subdir"))
  tmpRoots.push(root)
  return root
}

async function seedDb() {
  const env: any = {}
  const adminHash = await hashPasswordSHA256("admin123")
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: adminHash,
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [
        {
          id: "s1",
          driver: "Local",
          mount_path: "/local",
          addition: JSON.stringify({ root_folder_path: makeLocalRoot() }),
          modified: "2026-01-01T00:00:00.000Z",
          disabled: false,
        },
      ],
      shares: [],
      metas: [],
    },
    env,
  )
}

const appOf = () => {
  // 与 src/backend/index.ts 的挂载一致：app.route("/dav", webdavRouter)
  const app = new Hono()
  app.route("/dav", webdavRouter)
  return app
}

const basicAuth = (): Record<string, string> => ({
  Authorization: "Basic " + Buffer.from("admin:admin123").toString("base64"),
})

const propfind = (p: string) =>
  appOf().request(p, {
    method: "PROPFIND",
    headers: { ...basicAuth(), Depth: "1" },
  })

test("PROPFIND /dav/：自身与挂载点子目录的 href 都必须带 /dav 前缀", async () => {
  await seedDb()
  const res = await propfind("/dav/")
  assert.equal(res.status, 207, "PROPFIND 应返回 207 Multistatus")
  const xml = await res.text()

  assert.ok(
    xml.includes("<d:href>/dav/</d:href>"),
    `根目录自身 href 应为 /dav/，实际：${xml}`,
  )
  assert.ok(
    xml.includes("<d:href>/dav/local/</d:href>"),
    `挂载点子目录 href 应为 /dav/local/（目录带尾部斜杠），实际：${xml}`,
  )
  assert.ok(
    !xml.includes("<d:href>/local"),
    `不应返回缺少 /dav 前缀的 href，实际：${xml}`,
  )
  assert.ok(
    !xml.includes("<d:href>/</d:href>"),
    `不应返回裸根 href /，实际：${xml}`,
  )
})

test("PROPFIND /dav/local/：子项 href 带前缀，文件无斜杠、目录有斜杠", async () => {
  await seedDb()
  const res = await propfind("/dav/local/")
  assert.equal(res.status, 207)
  const xml = await res.text()

  assert.ok(
    xml.includes("<d:href>/dav/local/</d:href>"),
    `目录自身 href 应为 /dav/local/，实际：${xml}`,
  )
  assert.ok(
    xml.includes("<d:href>/dav/local/hello.txt</d:href>"),
    `文件 href 应为 /dav/local/hello.txt（无尾部斜杠），实际：${xml}`,
  )
  assert.ok(
    xml.includes("<d:href>/dav/local/subdir/</d:href>"),
    `子目录 href 应为 /dav/local/subdir/（带尾部斜杠），实际：${xml}`,
  )
})

test("PROPFIND /dav/local（无尾部斜杠）：自身 href 仍规范化为 /dav/local/", async () => {
  await seedDb()
  const res = await propfind("/dav/local")
  assert.equal(res.status, 207)
  const xml = await res.text()

  assert.ok(
    xml.includes("<d:href>/dav/local/</d:href>"),
    `自身 href 应规范化为 /dav/local/，实际：${xml}`,
  )
})

test("cleanup", () => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})
