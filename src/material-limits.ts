// Shared by upload validation and the browser, so displayed limits stay in sync.
export const MATERIAL_LIMITS = {
  fileBytes: 50 * 1024 * 1024,
  folderBytes: 500 * 1024 * 1024,
  folderFiles: 200,
  textCharacters: 5_000_000,
  pdfPages: 1000,
  chapters: 500,
} as const;
