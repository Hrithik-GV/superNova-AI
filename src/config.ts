import * as vscode from 'vscode';

/**
 * Mentor configuration interface representing the instructor's .mentor.json settings.
 */
export interface MentorConfig {
  maxHintLevel: 1 | 2 | 3 | 4;
  mode: 'beginner' | 'intermediate';
  learningObjectives: string[];
  pasteDetection: boolean;
  pasteMinLines: number;
}

/**
 * Default configuration when .mentor.json is missing or when individual fields are invalid.
 */
export const DEFAULT_CONFIG: MentorConfig = {
  maxHintLevel: 4,
  mode: 'beginner',
  learningObjectives: [],
  pasteDetection: true,
  pasteMinLines: 5
};

/**
 * Sample .mentor.json template created by the "Mentor: Create Course Config" command.
 */
export const SAMPLE_CONFIG_JSON = `{
  "maxHintLevel": 3,
  "mode": "beginner",
  "learningObjectives": [
    "Understand the CSS box model",
    "Use Flexbox for layout"
  ],
  "pasteDetection": true,
  "pasteMinLines": 5
}
`;

/**
 * Loads and validates .mentor.json from the root of the first workspace folder using vscode.workspace.fs.
 *
 * Rules:
 * - File missing: returns DEFAULT_CONFIG and active=false.
 * - Invalid JSON: returns DEFAULT_CONFIG, active=false, and shows ONE warning message.
 * - Validation & clamping:
 *   - maxHintLevel: integer 1-4. Fallback to default.
 *   - mode: 'beginner' | 'intermediate'. Fallback to default.
 *   - learningObjectives: at most 10 strings, each trimmed and sliced at 200 chars.
 *   - pasteDetection: boolean. Fallback to default.
 *   - pasteMinLines: integer clamped to 3-50. Fallback to default.
 *   - Unknown keys are ignored.
 *
 * @returns { config: MentorConfig, active: boolean }
 */
export async function loadConfig(): Promise<{ config: MentorConfig; active: boolean }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { config: { ...DEFAULT_CONFIG }, active: false };
  }

  const rootUri = folders[0].uri;
  const configUri = vscode.Uri.joinPath(rootUri, '.mentor.json');

  let fileBytes: Uint8Array;
  try {
    fileBytes = await vscode.workspace.fs.readFile(configUri);
  } catch {
    // File missing: return default configuration with active=false
    return { config: { ...DEFAULT_CONFIG }, active: false };
  }

  const rawText = new TextDecoder('utf-8').decode(fileBytes);
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    vscode.window.showWarningMessage('Code Mentor: Failed to parse .mentor.json (invalid JSON syntax). Falling back to default settings.');
    return { config: { ...DEFAULT_CONFIG }, active: false };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    vscode.window.showWarningMessage('Code Mentor: .mentor.json must contain a JSON object. Falling back to default settings.');
    return { config: { ...DEFAULT_CONFIG }, active: false };
  }

  // =========================================================================
  // FIELD VALIDATION AND CLAMPING
  // =========================================================================

  // 1. maxHintLevel: integer 1-4
  let maxHintLevel: 1 | 2 | 3 | 4 = DEFAULT_CONFIG.maxHintLevel;
  const parsedLevel = Number(parsed.maxHintLevel);
  if (Number.isInteger(parsedLevel) && parsedLevel >= 1 && parsedLevel <= 4) {
    maxHintLevel = parsedLevel as 1 | 2 | 3 | 4;
  }

  // 2. mode: must be 'beginner' or 'intermediate'
  let mode: 'beginner' | 'intermediate' = DEFAULT_CONFIG.mode;
  if (parsed.mode === 'beginner' || parsed.mode === 'intermediate') {
    mode = parsed.mode;
  }

  // 3. learningObjectives: at most 10 strings, trimmed and cut at 200 chars
  let learningObjectives: string[] = [];
  if (Array.isArray(parsed.learningObjectives)) {
    learningObjectives = parsed.learningObjectives
      .filter((item: any) => typeof item === 'string' && item.trim().length > 0)
      .map((item: string) => item.trim().slice(0, 200))
      .slice(0, 10);
  }

  // 4. pasteDetection: boolean
  let pasteDetection: boolean = DEFAULT_CONFIG.pasteDetection;
  if (typeof parsed.pasteDetection === 'boolean') {
    pasteDetection = parsed.pasteDetection;
  }

  // 5. pasteMinLines: integer 3-50
  let pasteMinLines: number = DEFAULT_CONFIG.pasteMinLines;
  const parsedMinLines = Number(parsed.pasteMinLines);
  if (Number.isFinite(parsedMinLines)) {
    pasteMinLines = Math.max(3, Math.min(50, Math.round(parsedMinLines)));
  }

  const validatedConfig: MentorConfig = {
    maxHintLevel,
    mode,
    learningObjectives,
    pasteDetection,
    pasteMinLines
  };

  return { config: validatedConfig, active: true };
}

/**
 * Creates a FileSystemWatcher for .mentor.json in the workspace root.
 * Listens for creation, change, and deletion events and invokes onConfigChange.
 */
export function watchConfigFile(
  onConfigChange: (config: MentorConfig, active: boolean) => void
): vscode.Disposable {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return new vscode.Disposable(() => {});
  }

  const pattern = new vscode.RelativePattern(folders[0], '.mentor.json');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const reload = async () => {
    const res = await loadConfig();
    onConfigChange(res.config, res.active);
  };

  const d1 = watcher.onDidCreate(reload);
  const d2 = watcher.onDidChange(reload);
  const d3 = watcher.onDidDelete(reload);

  return vscode.Disposable.from(watcher, d1, d2, d3);
}

/**
 * Implements "Mentor: Create Course Config (.mentor.json)".
 * Creates sample .mentor.json if missing, then opens it in the editor.
 */
export async function createOrOpenConfigFile(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder found to create .mentor.json.');
    return;
  }

  const rootUri = folders[0].uri;
  const configUri = vscode.Uri.joinPath(rootUri, '.mentor.json');

  let fileExists = false;
  try {
    await vscode.workspace.fs.stat(configUri);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    const bytes = new TextEncoder().encode(SAMPLE_CONFIG_JSON);
    await vscode.workspace.fs.writeFile(configUri, bytes);
  }

  const doc = await vscode.workspace.openTextDocument(configUri);
  await vscode.window.showTextDocument(doc);
}
