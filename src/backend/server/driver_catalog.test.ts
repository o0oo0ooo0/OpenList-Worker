// 管理端驱动目录（/api/admin/driver/names、/driver/info）的回归测试
import assert from "node:assert/strict"
import { test } from "node:test"
import { DRIVER_NAMES, driverConfigs, normalizeDriver } from "./admin"

test("添加存储页的驱动下拉包含天翼云盘客户端", () => {
  assert.ok(DRIVER_NAMES.includes("189CloudPC"))
  assert.ok(DRIVER_NAMES.includes("189Cloud"))
})

test("normalizeDriver 能区分天翼云盘客户端与 Web 版 189", () => {
  assert.equal(normalizeDriver("189CloudPC"), "189CloudPC")
  assert.equal(normalizeDriver("189pc"), "189CloudPC")
  assert.equal(normalizeDriver("cloud189pc"), "189CloudPC")
  // Web 版不受影响：精确键名命中 189Cloud，遗留别名走 Cloud189
  assert.equal(normalizeDriver("189Cloud"), "189Cloud")
  assert.equal(normalizeDriver("189"), "Cloud189")
  assert.equal(normalizeDriver("ctyun"), "Cloud189")
})

test("189CloudPC 的表单字段与默认配置完整", () => {
  const info = driverConfigs["189CloudPC"]
  assert.ok(info, "driverConfigs 必须包含 189CloudPC")
  assert.equal(info.config.name, "189CloudPC")
  assert.equal(info.config.default_root, "-11")

  const fields = (info.additional || []).map((f: any) => f.name)
  for (const required of [
    "username",
    "password",
    "validate_code",
    "root_folder_id",
    "type",
    "family_id",
    "order_by",
    "order_direction",
    "access_token",
    "refresh_token",
  ]) {
    assert.ok(fields.includes(required), `缺少配置项: ${required}`)
  }

  const byType = Object.fromEntries(
    (info.additional || []).map((f: any) => [f.name, f.type]),
  )
  assert.equal(byType.type, "select")
  assert.equal(byType.order_by, "select")
})
