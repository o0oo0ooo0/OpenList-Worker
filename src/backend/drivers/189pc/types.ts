// 天翼云盘客户端（PC 协议）类型定义
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc

export interface Cloud189PCAddition {
  login_type?: string // password | qrcode
  username: string
  password: string
  /** 图片验证码结果，需要时由管理员填入 */
  validate_code?: string
  access_token?: string
  refresh_token?: string
  root_folder_id?: string
  order_by?: string // filename | filesize | lastOpTime
  order_direction?: string // asc | desc
  type?: string // personal | family
  family_id?: string
  upload_method?: string // stream | rapid | old
  upload_thread?: string
  family_transfer?: boolean
  rapid_upload?: boolean
  no_use_ocr?: boolean
}

export interface PersistedTokens {
  access_token: string
  refresh_token: string
}

/** 四种错误返回形态之一 */
export interface RespErr {
  res_code?: number | string
  res_message?: string
  error?: string
  code?: string
  message?: string
  msg?: string
  errorCode?: string
  errorMsg?: string
}

export interface EncryptConfResp {
  result?: number
  data?: {
    pre?: string
    pubKey?: string
    upSmsOn?: string
    preDomain?: string
  }
}

export interface LoginResp {
  msg?: string
  result?: number
  toUrl?: string
}

export interface UserSessionResp {
  res_code?: number
  res_message?: string
  loginName?: string
  keepAlive?: number
  getFileDiffSpan?: number
  getUserInfoSpan?: number
  sessionKey?: string
  sessionSecret?: string
  familySessionKey?: string
  familySessionSecret?: string
}

export interface AppSessionResp extends UserSessionResp {
  isSaveName?: string
  accessToken?: string
  refreshToken?: string
}

export interface FamilyInfoResp {
  count?: number
  createTime?: string
  familyId?: number
  remarkName?: string
  type?: number
  useFlag?: number
  userRole?: number
}

export interface FamilyInfoListResp {
  familyInfoResp?: FamilyInfoResp[]
}

export interface Cloud189PCIcon {
  smallUrl?: string
  largeUrl?: string
  max600?: string
  mediumUrl?: string
}

export interface Cloud189PCFile {
  id: string
  name: string
  size: number
  md5?: string
  parentId?: string
  lastOpTime?: string
  createDate?: string
  icon?: Cloud189PCIcon
  isFolder: false
}

export interface Cloud189PCFolder {
  id: string
  name: string
  parentId?: string
  lastOpTime?: string
  createDate?: string
  isFolder: true
}

export type Cloud189PCObject = Cloud189PCFile | Cloud189PCFolder

export interface Cloud189PCFilesResp {
  fileListAO?: {
    count?: number
    fileList?: Array<Omit<Cloud189PCFile, "isFolder">>
    folderList?: Array<Omit<Cloud189PCFolder, "isFolder">>
  }
}

export interface DownResp {
  fileDownloadUrl?: string
}

export interface BatchTaskInfo {
  fileId: string
  fileName: string
  isFolder: number
  srcParentId?: string
  /** 冲突处理：1 跳过 2 保留 3 覆盖 */
  dealWay?: number
  isConflict?: number
}

export interface CreateBatchTaskResp {
  taskId?: string
}

export interface BatchTaskStateResp {
  taskId?: string
  taskStatus?: number // 1 初始化 2 冲突 3 执行中 4 完成
  failedCount?: number
  subTaskCount?: number
  successedCount?: number
}

export interface InitMultiUploadResp {
  data?: {
    uploadType?: number
    uploadHost?: string
    uploadFileId?: string
    fileDataExists?: number
  }
}

export interface UploadUrlsResp {
  code?: string
  uploadUrls?: Record<string, UploadUrlsData>
}

export interface UploadUrlsData {
  requestURL?: string
  requestHeader?: string
}

export interface CommitMultiUploadFileResp {
  file?: {
    userFileId?: string
    fileName?: string
    fileSize?: number
    fileMd5?: string
    createDate?: string
  }
}

export interface InitMultiUploadResult {
  uploadFileId: string
  /** 1 表示服务端已存在相同 md5 的文件（可秒传） */
  fileDataExists: number
}

export interface UploadSession {
  uploadFileId: string
  fileMd5: string
  size: number
  partCount: number
  sliceSize: number
  isFamily: boolean
  familyId?: string
}
