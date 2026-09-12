export interface EditorDocument {
  readonly path: string;
  readonly content: string;
  readonly savedContent: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly conflict: string | null;
}

export const EDITOR_SAVED_STATUS_DURATION_MS = 1_500 as const;

export function updateEditorContent(document: EditorDocument, content: string): EditorDocument {
  return { ...document, content, dirty: content !== document.savedContent };
}

export function markEditorSaved(document: EditorDocument, revision: string): EditorDocument {
  return { ...document, savedContent: document.content, revision, dirty: false, conflict: null };
}

export function markEditorConflict(document: EditorDocument, message: string): EditorDocument {
  return { ...document, dirty: true, conflict: message };
}

export function editorLanguageForPath(relativePath: string): string {
  const basename = relativePath.split("/").at(-1)?.toLowerCase() ?? "";
  if (basename === "dockerfile") return "dockerfile";
  const extension = basename.slice(basename.lastIndexOf("."));
  return ({
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".json": "json", ".css": "css", ".scss": "scss", ".less": "less", ".html": "html", ".htm": "html",
    ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".svg": "xml", ".sh": "shell",
    ".bash": "shell", ".sql": "sql", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".php": "php"
  } as Record<string, string>)[extension] ?? "plaintext";
}
