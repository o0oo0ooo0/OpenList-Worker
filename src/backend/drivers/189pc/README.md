# 189CloudPC（天翼云盘客户端）驱动

Cloudflare Workers 适配版，协议移植自 <https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc>。

前端实例名：`189CloudPC`；-worker 注册别名：`189pc` / `189cloudpc` / `cloud189pc` / `189pcloud` / `189pcclient` / `189client` / `ctyunpc`。

> 历史遗留说明：本目录此前存放过一份未注册的半成品实现，其 README 建议删除该文件。
> 现已重写为符合 `StorageDriver` 接口的完整实现，并在 `internal/op/storage.ts` 中注册，请勿再删除。

## 与 Web 版 189（`drivers/189`）的区别

| 维度 | 189Cloud（Web） | 189CloudPC（客户端） |
| --- | --- | --- |
| 登录方式 | Cookie / 网页 SSO，遇到滑动验证码即失效 | 账号密码 + 图片验证码，换取 accessToken / refreshToken |
| 接口域名 | `cloud.189.cn` / `open.e.189.cn` | `api.cloud.189.cn` + `upload.cloud.189.cn`，请求需 HMAC-SHA1 签名 |
| 写操作 | 逐个接口 | 删除 / 移动 / 复制走批处理任务（`batch/createBatchTask.action` + 轮询） |
| 上传 | 加密 params + 单片/会话上传 | `initMultiUpload` / `getMultiUploadUrls` / `commitMultiUploadFile`，支持分片 md5 校验与秒传 |

## 配置项

| 字段 | 说明 |
| --- | --- |
| `login_type` | `password`（默认，Workers 仅支持该方式）；`qrcode` 需要交互式扫码，暂不支持 |
| `username` / `password` | 天翼云盘账号（手机号）与密码 |
| `validate_code` | 图片验证码。登录检测到需要验证码时，驱动会抛出 `need img validate code`，填入后重新保存即可 |
| `access_token` / `refresh_token` | 登录成功后自动写回；清空 `refresh_token` 可切换账号 |
| `type` | `personal`（默认）/ `family` |
| `family_id` | `type=family` 时自动获取，也可手动填写 |
| `root_folder_id` | 个人云默认 `-11`；家庭云必须留空 |
| `order_by` / `order_direction` | `filename` / `filesize` / `lastOpTime`，配合 `asc` / `desc` |
| `upload_thread` | 保留兼容字段，Workers 串行上传，取值 1–32 |

## Workers 适配要点

- 所有加解密复用 `drivers/189/crypto.ts` 的纯 TS 实现（`crypto-js` + BigInt），**不引入 Node `crypto` 裸模块**，因此 `dist` 产物在 Workers / EdgeOne / Node 容器中行为一致；
- 会话（sessionKey / sessionSecret）有时效，请求返回 `InvalidSessionKey` 或 `userSessionBO is null` 时自动刷新会话并重试一次；
- Go 版每 5 分钟一次的 `keepAlive` cron 改为按需刷新，避免 Worker 常驻定时器；
- 上传分片大小遵循 Go 版 `partSize`：≤10GiB 用 10MiB，≤20GiB 用 20MiB，更大的文件按比例放大，避免分片数量超过服务端上限。

## 不支持的能力（相对 Go 版）

- 扫码登录（需要交互式二维码）；
- 家庭云转存（`family_transfer`）、`rapid_upload` 插件链；
- torrent sidecar 生成与追随重命名/移动/复制。

## 测试

```bash
npx tsx --test src/backend/drivers/189pc/driver.test.ts
```

覆盖：登录与令牌持久化、会话过期重试、HMAC 签名、AES params 加解密、列表分页与排序、
路径解析、批处理写操作，以及上传的整文件 / 三段式会话两条链路。
