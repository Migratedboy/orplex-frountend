// file-adapter.ts — Re-exports from split modules
// Backward compatibility barrel — prefer importing from file-utils or file-download directly

export {
  TEXT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_TEXT_SIZE,
  MAX_IMAGE_SIZE,
  getExt,
  isTextFile,
  isImageFile,
  readFileAsDataUrl,
  readFileAsText,
  formatFileSize,
  getFileIcon,
  processFileList,
} from "./file-utils";

export type { ProcessedFile } from "./file-utils";

export {
  downloadFile,
  downloadAsMarkdown,
  downloadCodeBlock,
} from "./file-download";
