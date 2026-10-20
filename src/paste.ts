import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { MentorConfig } from './config';

/**
 * Information passed when a large paste event is detected and confirmed.
 */
export interface PasteEventPayload {
  action: 'explain_it' | 'explain_to_me';
  fileName: string;
  languageId: string;
  pastedCode: string;
}

// In-memory state: disabled flag when user selects "Stop asking"
let _stopAsking = false;

// Cooldown timestamp: at most one prompt every 90 seconds (90,000 ms)
let _lastPromptTimestamp = 0;
const COOLDOWN_MS = 90_000;

// In-memory deduplication set: never prompt twice for the same pasted text
const _seenPasteHashes = new Set<string>();

// Supported web programming language identifiers
const SUPPORTED_LANGUAGES = new Set([
  'html',
  'css',
  'scss',
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact'
]);

/**
 * Generates an in-memory SHA-256 hash of the normalized text to prevent re-prompting.
 * Pasted code is kept strictly in memory and never written to disk or globalState.
 */
function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Normalizes line endings (CRLF -> LF) and trims whitespace for accurate clipboard comparison.
 */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Registers the paste detector using vscode.workspace.onDidChangeTextDocument.
 * Non-blocking, non-modal, strictly validates paste authenticity against system clipboard.
 */
export function registerPasteDetector(
  context: vscode.ExtensionContext,
  getConfig: () => { config: MentorConfig; active: boolean },
  onPaste: (payload: PasteEventPayload) => Promise<void>
): vscode.Disposable {
  const disposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    // Fire-and-forget inside async handler so user typing is NEVER blocked
    try {
      const { config } = getConfig();

      // Condition 1: Paste detection enabled and user has not chosen "Stop asking"
      if (!config.pasteDetection || _stopAsking) {
        return;
      }

      // Condition 2: Scheme must be 'file' or 'untitled'
      const doc = event.document;
      if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
        return;
      }

      // Condition 3: Language must be one of the supported frontend web languages
      if (!SUPPORTED_LANGUAGES.has(doc.languageId)) {
        return;
      }

      // Condition 4: Single insertion change and NOT an Undo or Redo operation
      if (event.contentChanges.length !== 1) {
        return;
      }
      if (
        event.reason === vscode.TextDocumentChangeReason.Undo ||
        event.reason === vscode.TextDocumentChangeReason.Redo
      ) {
        return;
      }

      const change = event.contentChanges[0];
      const insertedText = change.text;
      if (!insertedText) {
        return;
      }

      // Condition 5: Inserted text has at least pasteMinLines lines OR at least 200 characters
      const lines = insertedText.split(/\r?\n/);
      const lineCount = lines.length;
      if (lineCount < config.pasteMinLines && insertedText.length < 200) {
        return;
      }

      // =======================================================================
      // CLIPBOARD CHECK (Requirement B.3)
      // =======================================================================
      // Verify text matches clipboard to confirm an authentic paste event and
      // exclude edits made by code formatters, linters, or AI auto-completions.
      // Both strings are normalized (CRLF -> LF, trimmed) before comparing.
      const clipboardRaw = await vscode.env.clipboard.readText();
      const normalizedInserted = normalizeText(insertedText);
      const normalizedClipboard = normalizeText(clipboardRaw);

      if (!normalizedClipboard || normalizedInserted !== normalizedClipboard) {
        // Not a match with clipboard content -> skip
        return;
      }

      // Condition 6: Deduplication check (never prompt twice for identical text in memory)
      const textHash = hashText(normalizedInserted);
      if (_seenPasteHashes.has(textHash)) {
        return;
      }

      // Condition 7: Cooldown period of at most one prompt every 90 seconds
      const now = Date.now();
      if (now - _lastPromptTimestamp < COOLDOWN_MS) {
        return;
      }

      // Mark this paste as seen and update timestamp
      _seenPasteHashes.add(textHash);
      _lastPromptTimestamp = now;

      // Condition 8: Display non-modal information message
      const promptMessage = `That's a big paste (${lineCount} lines). Can you explain what it does?`;
      const choice = await vscode.window.showInformationMessage(
        promptMessage,
        "I'll explain it",
        "Explain it to me",
        "Not now",
        "Stop asking"
      );

      if (!choice || choice === 'Not now') {
        return;
      }

      if (choice === 'Stop asking') {
        // Disable detection until window reloads
        _stopAsking = true;
        return;
      }

      const fileName = path.basename(doc.fileName) || 'untitled';
      const languageId = doc.languageId || 'plaintext';

      if (choice === "I'll explain it") {
        await onPaste({
          action: 'explain_it',
          fileName,
          languageId,
          pastedCode: insertedText
        });
      } else if (choice === 'Explain it to me') {
        await onPaste({
          action: 'explain_to_me',
          fileName,
          languageId,
          pastedCode: insertedText
        });
      }
    } catch (err) {
      // Guard against any unhandled exceptions interrupting the editor
      console.error('Polaris: Error during paste detection:', err);
    }
  });

  context.subscriptions.push(disposable);
  return disposable;
}
