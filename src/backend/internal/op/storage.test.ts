import assert from "node:assert/strict"
import { test } from "node:test"

import type { StorageDriver } from "../driver/base"
import { getDb, saveDb } from "../model/db"
import {
  getDriver,
  getItem,
  getOrCreateDriver,
  scheduleStoragePersistence,
} from "./storage"
import { Cloud189PCDriver } from "../../drivers/189pc/driver"

test("concurrent driver initialization shares one Promise", async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const driver = {} as StorageDriver
  const cache = new Map<string, Promise<StorageDriver>>()

  const factory = async () => {
    calls++
    await gate
    return driver
  }

  const first = getOrCreateDriver(cache, "189-1", factory)
  const second = getOrCreateDriver(cache, "189-1", factory)
  release()

  assert.equal(await first, driver)
  assert.equal(await second, driver)
  assert.equal(calls, 1)
})

test("Worker persistence is scheduled instead of awaited", async () => {
  let resolvePersistence!: () => void
  const persistence = new Promise<void>(
    (resolve) => (resolvePersistence = resolve),
  )
  let scheduled: Promise<unknown> | undefined

  await scheduleStoragePersistence((task) => {
    scheduled = task
  }, persistence)

  assert.equal(scheduled, persistence)
  resolvePersistence()
  await scheduled
})

test("Node persistence is awaited without waitUntil", async () => {
  let completed = false
  const persistence = Promise.resolve().then(() => {
    completed = true
  })

  await scheduleStoragePersistence(undefined, persistence)
  assert.equal(completed, true)
})

test("mounted storage roots return without initializing the remote driver", async () => {
  // 通过公开 API 写入内存库（无持久化后端时 getDb 使用模块级 memoryDb）
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-root-fast-path",
      driver: "189Cloud",
      mount_path: "/189",
      addition: JSON.stringify({ root_folder_id: "-11" }),
      modified: "2026-08-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)

  const result = await getItem("/189")
  assert.equal(result.provider, "189Cloud")
  assert.equal(result.item.name, "189")
  assert.equal(result.item.is_dir, true)
  assert.equal(result.item.sign, "-11")
})

test("189CloudPC 路由到天翼云盘客户端驱动（而非 Web 版 189）", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ res_code: 0, sessionKey: "sk", sessionSecret: "ss" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch

  try {
    for (const alias of ["189CloudPC", "189pc", "cloud189pc"]) {
      const driver = await getDriver(alias, {
        id: `pc-${alias}`,
        driver: alias,
        addition: JSON.stringify({
          username: "13800138000",
          password: "secret",
          access_token: "at",
        }),
      })
      assert.ok(
        driver instanceof Cloud189PCDriver,
        `驱动别名 ${alias} 应路由到 Cloud189PCDriver`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
