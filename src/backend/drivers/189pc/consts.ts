// 天翼云盘客户端（PC 协议）常量
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc
// 与 Go 版 drivers/189pc/help.go 保持一致；这些常量参与 HMAC 签名，不可随意修改。

export const ACCOUNT_TYPE = "02"
export const APP_ID = "8025431004"
export const CLIENT_TYPE = "10020"
export const VERSION = "6.2"

export const WEB_URL = "https://cloud.189.cn"
export const AUTH_URL = "https://open.e.189.cn"
export const API_URL = "https://api.cloud.189.cn"
export const UPLOAD_URL = "https://upload.cloud.189.cn"

export const RETURN_URL =
  "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html"

export const PC = "TELEPC"
export const MAC = "TELEMAC"

export const CHANNEL_ID = "web_cloud.189.cn"

/** 错误码：open token 失效，需要用 refreshToken 换新令牌 */
export const USER_INVALID_OPEN_TOKEN_ERROR = "UserInvalidOpenToken"

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** 个人云默认根目录 ID；家庭云必须为空 */
export const DEFAULT_ROOT_ID = "-11"

/** 上传分片大小（10MiB），协议要求在 initMultiUpload 时声明 */
export const UPLOAD_SLICE_SIZE = 10 * 1024 * 1024

/** 列表分页大小，与 Go 版 getFiles 保持一致 */
export const FILE_LIST_PAGE_SIZE = 1000

/** 单次操作的子请求预算，避免长时间循环耗尽 Workers 的 50 次子请求配额 */
export const SUBREQUEST_LIMIT = 45

/** 批处理任务（删除 / 移动 / 复制）轮询参数 */
export const BATCH_TASK_POLL_MS = 300
export const BATCH_TASK_MAX_POLL = 20
