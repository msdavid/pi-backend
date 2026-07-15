/**
 * Files domain barrel (WP-1.12).
 *
 * File CRUD (`file.ts`) + session-outputs slice (`outputs.ts`). Files are
 * independent resources (§21); outputs are read live from an idle session's
 * sandbox (§16.6, §24.8).
 */

export {
  toFile,
  fileObjectKey,
  uploadFile,
  listFiles,
  fetchFileRow,
  getFile,
  downloadFile,
  deleteFile,
  type FileRow,
  type UploadFileInput,
  type ListFilesOptions,
  type DownloadResult,
} from "./file.js";

export {
  listSessionOutputs,
  downloadSessionOutput,
  OUTPUTS_DIR,
  type SessionSandboxResolver,
  type SessionOutputRef,
  type SessionOutputDownload,
} from "./outputs.js";
