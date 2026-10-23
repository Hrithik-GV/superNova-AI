import * as vscode from 'vscode';

/**
 * Returns the human-friendly name for a hint level (1: Nudge, 2: Hint, 3: Structure, 4: Solution).
 */
export function getHintName(level: number): string {
  switch (level) {
    case 1: return 'Nudge';
    case 2: return 'Hint';
    case 3: return 'Structure';
    case 4: return 'Solution';
    default: return `Level ${level}`;
  }
}

/**
 * Checks if a Gemini API key is currently configured in user/workspace settings.
 */
export function hasApiKeyConfigured(): boolean {
  const config = vscode.workspace.getConfiguration('mentor');
  const key = (config.get<string>('apiKey', '') || config.get<string>('apikey', '')).trim();
  return key.length > 0;
}
