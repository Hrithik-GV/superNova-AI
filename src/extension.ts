import * as vscode from 'vscode';
import * as path from 'path';
import { askMentor, parseMentorReply, ChatMessage, MentorReply, LineNote, MissingApiKeyError } from './llm';

/**
 * Activates the Code Mentor extension.
 * Sets up the WebviewViewProvider for the sidebar chat and registers commands.
 */
export function activate(context: vscode.ExtensionContext) {
  // 1. Create and register the WebviewViewProvider for the sidebar chat
  const provider = new MentorChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mentor.chat',
      provider,
      {
        webviewOptions: {
          // Retain state when the webview is hidden (e.g. user switches sidebar tabs)
          retainContextWhenHidden: true
        }
      }
    )
  );

  // 2. Register command to open / focus the Code Mentor sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.openChat', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
    })
  );

  // 3. Register right-click / palette command: "Mentor: Explain Selection"
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor found to explain selection.');
        return;
      }

      const selection = editor.selection;
      if (!selection || selection.isEmpty) {
        vscode.window.showInformationMessage('Please select some code to explain first.');
        return;
      }

      const doc = editor.document;
      const selectedText = doc.getText(selection).trim();
      if (!selectedText) {
        vscode.window.showInformationMessage('The selected code is empty.');
        return;
      }

      const fileName = path.basename(doc.fileName);
      const languageId = doc.languageId || 'plaintext';

      // Focus the sidebar webview
      await vscode.commands.executeCommand('mentor.chat.focus');

      // Request explanation through the provider
      await provider.explainSelection(fileName, languageId, selectedText);
    })
  );
}

export function deactivate() {
  // Cleanup if needed when extension is deactivated
}

/**
 * Provider responsible for creating and managing the Webview in the sidebar.
 * Handles the message-passing lifecycle between the Webview UI and the Extension Host.
 */
class MentorChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  // In-memory conversation history.
  // Stores learner's plain text and the model's raw JSON replies so LLM retains full context.
  private _history: ChatMessage[] = [];

  // Per-task state retained on the extension host
  private _currentLevel: 1 | 2 | 3 | 4 = 1;
  private _currentTaskText: string = '';
  private _currentMode: 'task' | 'explain' = 'task';

  // Webview lifecycle readiness and queued pending explain requests
  private _isWebviewReady: boolean = false;
  private _pendingExplain: { fileName: string; languageId: string; code: string } | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._isWebviewReady = false;

    // Enable JavaScript in the webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Render the initial HTML
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // =========================================================================
    // MESSAGE PASSING: Listening for messages sent FROM the webview
    // =========================================================================
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready': {
          // Webview has loaded and its message listener is registered
          this._isWebviewReady = true;
          if (this._pendingExplain) {
            const pending = this._pendingExplain;
            this._pendingExplain = null;
            await this._executeExplain(pending.fileName, pending.languageId, pending.code);
          }
          break;
        }

        case 'ask': {
          // User submitted a question from the webview chat input
          await this._handleUserAsk(message.text, message.hintLevel);
          break;
        }

        case 'needMoreHelp': {
          // Learner clicked "Need more help?" to move up one level on the current task
          await this._handleNeedMoreHelp(message.hintLevel);
          break;
        }

        case 'newTask':
        case 'clearHistory': {
          // Clears conversation history, resets level to 1, and clears chat UI
          this._history = [];
          this._currentLevel = 1;
          this._currentTaskText = '';
          this._currentMode = 'task';
          this._postMessageToWebview({
            type: 'taskReset'
          });
          break;
        }

        case 'openSettings': {
          // User clicked the "Configure Gemini API Key" button
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'mentor.apiKey'
          );
          break;
        }
      }
    });
  }

  /**
   * Entry point for the "Mentor: Explain Selection" command.
   * Queues the request if webview isn't loaded yet; otherwise executes immediately.
   */
  public async explainSelection(fileName: string, languageId: string, selectedText: string): Promise<void> {
    // Truncate selections over ~150 lines
    const lines = selectedText.split(/\r?\n/);
    let code = selectedText;
    if (lines.length > 150) {
      code = lines.slice(0, 150).join('\n') + '\n\n// ... (selection truncated to 150 lines)';
    }

    // If webview is not ready yet, queue the request until the 'ready' signal arrives
    if (!this._view || !this._isWebviewReady) {
      this._pendingExplain = { fileName, languageId, code };
      return;
    }

    await this._executeExplain(fileName, languageId, code);
  }

  /**
   * Executes an explain request once the webview is ready.
   */
  private async _executeExplain(fileName: string, languageId: string, code: string): Promise<void> {
    this._currentMode = 'explain';

    // Show a short learner message in the chat so the conversation reads naturally
    this._postMessageToWebview({
      type: 'userMessage',
      text: 'Explaining your selection...'
    });

    // Build the user message for explain mode
    const prompt = `Mode: explain\nFile: ${fileName} (${languageId})\nSelected code:\n${code}`;

    await this._executePrompt(prompt, 'explain');
  }

  /**
   * Processes a learner question from the chat input.
   */
  private async _handleUserAsk(userText: string, hintLevel?: number) {
    const trimmedText = userText ? userText.trim() : '';
    if (!trimmedText) {
      return;
    }

    // Track current task text and hint level per task
    this._currentTaskText = trimmedText;
    const level = (hintLevel === 1 || hintLevel === 2 || hintLevel === 3 || hintLevel === 4)
      ? hintLevel
      : 1;
    this._currentLevel = level as 1 | 2 | 3 | 4;
    this._currentMode = 'task';

    // 1. Build editor context block
    const contextBlock = this._buildEditorContextBlock();

    // 2. Put context in user message and append "Requested hint level: N"
    let userMessageContent = `${trimmedText}\n\nRequested hint level: ${this._currentLevel}`;
    if (contextBlock) {
      userMessageContent = `${contextBlock}\n\nLearner Question:\n${trimmedText}\n\nRequested hint level: ${this._currentLevel}`;
    }

    await this._executePrompt(userMessageContent, 'task');
  }

  /**
   * Handles "Need more help?" by re-asking the same learner task at the next level.
   */
  private async _handleNeedMoreHelp(hintLevel?: number) {
    const taskText = this._currentTaskText.trim();
    if (!taskText) {
      return;
    }

    const level = (hintLevel === 1 || hintLevel === 2 || hintLevel === 3 || hintLevel === 4)
      ? hintLevel
      : Math.min(4, this._currentLevel + 1);
    this._currentLevel = level as 1 | 2 | 3 | 4;
    this._currentMode = 'task';

    // Build editor context block
    const contextBlock = this._buildEditorContextBlock();

    // Append "Requested hint level: N"
    let userMessageContent = `${taskText}\n\nRequested hint level: ${this._currentLevel}`;
    if (contextBlock) {
      userMessageContent = `${contextBlock}\n\nLearner Question:\n${taskText}\n\nRequested hint level: ${this._currentLevel}`;
    }

    await this._executePrompt(userMessageContent, 'task');
  }

  /**
   * Shared prompt executor with complete error handling (missing key, network, API errors, 429 rate limit).
   */
  private async _executePrompt(userMessageContent: string, mode: 'task' | 'explain'): Promise<void> {
    if (!this._view) {
      return;
    }

    // 1. Store learner's message in history
    this._history.push({
      role: 'user',
      content: userMessageContent
    });

    // Notify webview to show loading indicator
    this._postMessageToWebview({
      type: 'loading',
      loading: true
    });

    try {
      // 2. Request response from Google Gemini via askMentor
      const rawReply = await askMentor(this._history);

      // 3. Store raw reply in history for conversational continuity
      this._history.push({
        role: 'assistant',
        content: rawReply
      });

      // 4. Safely parse into structured MentorReply (never throws)
      const structuredReply: MentorReply = parseMentorReply(rawReply);

      // 5. Deliver structured reply to webview along with the mode
      this._postMessageToWebview({
        type: 'reply',
        data: structuredReply,
        mode: mode
      });
    } catch (error: any) {
      // Comprehensive error handling
      let errorMessage = 'An unexpected error occurred while communicating with Code Mentor.';
      let isApiKeyError = false;

      if (error instanceof MissingApiKeyError) {
        isApiKeyError = true;
        errorMessage = error.message;
      } else if (
        error?.status === 400 ||
        error?.status === 401 ||
        error?.status === 403 ||
        error?.message?.includes('API_KEY_INVALID') ||
        error?.message?.includes('API key not valid') ||
        error?.message?.includes('apiKey')
      ) {
        isApiKeyError = true;
        errorMessage = 'Invalid Google Gemini API Key. Please check your key in settings.';
      } else if (
        error?.status === 429 ||
        error?.message?.includes('429') ||
        error?.message?.includes('RESOURCE_EXHAUSTED') ||
        error?.message?.includes('quota')
      ) {
        errorMessage = 'Gemini API rate limit exceeded (429). Please wait a moment before trying again.';
      } else if (
        error?.code === 'ENOTFOUND' ||
        error?.message?.includes('fetch failed') ||
        error?.name === 'APIConnectionError'
      ) {
        errorMessage = 'Network connection failed. Please check your internet connection and try again.';
      } else if (error?.message) {
        errorMessage = `Gemini API error: ${error.message}`;
      }

      // Remove the last unanswered user turn so learner can retry cleanly
      this._history.pop();

      this._postMessageToWebview({
        type: 'error',
        message: errorMessage,
        isApiKeyError: isApiKeyError
      });
    } finally {
      // Always stop the loading indicator
      this._postMessageToWebview({
        type: 'loading',
        loading: false
      });
    }
  }

  /**
   * Helper to safely post typed messages to the webview.
   */
  private _postMessageToWebview(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Builds the editor context block for the current request.
   * Includes:
   * - active file name and language ID
   * - current selection (if any), labeled "Selected code"
   * - full file, truncated to ~300 lines, labeled "Current file"
   */
  private _buildEditorContextBlock(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
      return null;
    }

    const doc = editor.document;
    const filename = path.basename(doc.fileName);
    const languageId = doc.languageId || 'plaintext';

    // 1. Current selection (if any)
    let selectedCodeSection = '';
    const selection = editor.selection;
    if (selection && !selection.isEmpty) {
      const selectedText = doc.getText(selection).trim();
      if (selectedText) {
        selectedCodeSection = `Selected code:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`;
      }
    }

    // 2. Full file truncated to ~300 lines
    const maxLines = 300;
    const totalLines = doc.lineCount;
    const isTruncated = totalLines > maxLines;
    const linesToExtract = isTruncated ? maxLines : totalLines;

    const endLineIndex = linesToExtract - 1;
    const endCharIndex = doc.lineAt(endLineIndex).text.length;
    const range = new vscode.Range(0, 0, endLineIndex, endCharIndex);
    const fileContent = doc.getText(range);

    const currentFileLabel = isTruncated
      ? `Current file (${filename}, truncated to first 300 lines):`
      : `Current file (${filename}):`;

    const currentFileSection = `${currentFileLabel}\n\`\`\`${languageId}\n${fileContent}\n\`\`\``;

    return `Active file: ${filename}\nLanguage ID: ${languageId}\n\n${selectedCodeSection}${currentFileSection}`;
  }

  /**
   * Generates the plain HTML/CSS/JS document for the Webview.
   * Uses only vanilla HTML and JavaScript (no frameworks).
   * All styles use --vscode-* theme variables with zero hardcoded colors.
   */
  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Code Mentor</title>
  <style>
    /* =============================================================
       VS CODE THEME VARIABLES (Zero Hardcoded Colors)
       ============================================================= */
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      font-size: var(--font-size);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header Bar */
    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
    }

    .header-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-sideBarTitle-foreground, inherit);
    }

    .header-actions button {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 3px;
      font-family: inherit;
      transition: background 0.15s ease;
    }

    .header-actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    /* Messages List */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    /* Empty / Welcome Card */
    .welcome-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 6px;
      padding: 14px;
      line-height: 1.5;
    }

    .welcome-card h3 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--vscode-textLink-foreground, inherit);
    }

    .welcome-card p {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 8px;
    }

    .welcome-tips {
      font-size: 11px;
      padding-left: 14px;
      opacity: 0.8;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* Base Message Rows */
    .message-row {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .user-row {
      align-items: flex-end;
    }

    .user-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      max-width: 90%;
      border-radius: 6px;
      border-bottom-right-radius: 2px;
      padding: 8px 12px;
      font-size: 12.5px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* =============================================================
       MENTOR STRUCTURED REPLY CARD STYLING
       ============================================================= */
    .mentor-row {
      align-items: flex-start;
    }

    .mentor-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      border-radius: 6px;
      padding: 12px 14px;
      width: 100%;
      max-width: 98%;
      box-shadow: 0 1px 4px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.08));
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Card Header: Name + Hint Level */
    .mentor-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .mentor-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }

    .hint-badge {
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      letter-spacing: 0.3px;
    }

    /* Explanation Message */
    .mentor-message-body {
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Guiding Question in Italics */
    .mentor-question-box {
      font-style: italic;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.08));
      border-left: 3px solid var(--vscode-textLink-foreground, var(--vscode-focusBorder, #007acc));
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      line-height: 1.45;
    }

    /* Highlighted "Your Next Step" Box */
    .next-step-box {
      background: var(--vscode-welcomePage-tileBackground, var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12)));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
      border-left: 3px solid var(--vscode-focusBorder, var(--vscode-textLink-activeForeground, #007acc));
      border-radius: 4px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .next-step-label {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
    }

    .next-step-content {
      font-size: 12.5px;
      line-height: 1.45;
      color: var(--vscode-foreground);
    }

    /* Line Notes for Explain Selection */
    .line-notes-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 4px;
    }

    .line-notes-title {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .line-notes-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .line-note-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.15));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 0 3px 3px 0;
    }

    .line-note-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-editor-foreground, inherit);
    }

    .line-note-text {
      font-size: 12px;
      line-height: 1.4;
      opacity: 0.95;
    }

    /* Code Snippet Block with Copy Button */
    .code-snippet-container {
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.25));
      overflow: hidden;
    }

    .code-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px;
      background: var(--vscode-editorWidget-headerBackground, rgba(128, 128, 128, 0.1));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .code-lang-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
      opacity: 0.7;
    }

    .copy-code-btn {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
    }

    .copy-code-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
    }

    .copy-code-btn.copied {
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.4));
      color: var(--vscode-badge-foreground, inherit);
    }

    .code-snippet-container pre {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.45;
    }

    .code-snippet-container code {
      font-family: inherit;
      background: transparent;
      padding: 0;
    }

    /* Concept Chips at Bottom */
    .concepts-box {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }

    .concepts-label {
      font-size: 10.5px;
      opacity: 0.7;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .concept-chip {
      display: inline-flex;
      align-items: center;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-badge-foreground, inherit);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
    }

    /* "Need more help?" Button */
    .need-help-btn {
      align-self: flex-start;
      margin-top: 2px;
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-textLink-foreground, var(--vscode-button-secondaryForeground, inherit));
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      border-radius: 3px;
      padding: 5px 11px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s ease;
    }

    .need-help-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .need-help-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Error Card */
    .error-card {
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #ff6b6b));
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.4;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .btn-action {
      align-self: flex-start;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-action:hover {
      background: var(--vscode-button-hoverBackground);
    }

    /* Loading Indicator */
    .loading-indicator {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      opacity: 0.8;
      padding: 4px 6px;
    }

    .loading-indicator.visible {
      display: flex;
    }

    .dots-pulse {
      display: inline-flex;
      gap: 4px;
    }

    .dots-pulse span {
      width: 5px;
      height: 5px;
      background-color: var(--vscode-textLink-foreground, currentColor);
      border-radius: 50%;
      animation: pulse 1.2s infinite ease-in-out both;
    }

    .dots-pulse span:nth-child(1) { animation-delay: -0.32s; }
    .dots-pulse span:nth-child(2) { animation-delay: -0.16s; }

    @keyframes pulse {
      0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* Chat Footer */
    .chat-footer {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Hint Ladder */
    .hint-ladder-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .hint-ladder-label {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.75;
    }

    /* Soft confirmation banner */
    .solution-confirm-banner {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.12));
      border: 1px solid var(--vscode-focusBorder, rgba(0, 122, 204, 0.5));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 4px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: fadeIn 0.15s ease-in-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .solution-confirm-text {
      font-size: 11.5px;
      font-weight: 500;
      line-height: 1.4;
      color: var(--vscode-foreground);
    }

    .solution-confirm-actions {
      display: flex;
      gap: 6px;
    }

    .btn-confirm-action {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-confirm-action:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-confirm-action.btn-confirm-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, inherit);
      border-color: var(--vscode-button-border, rgba(128, 128, 128, 0.2));
    }

    .btn-confirm-action.btn-confirm-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
    }

    .hint-buttons-row {
      display: flex;
      gap: 4px;
      width: 100%;
    }

    .hint-btn {
      flex: 1;
      padding: 5px 2px;
      font-size: 11px;
      font-family: inherit;
      border-radius: 3px;
      cursor: pointer;
      text-align: center;
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      transition: background 0.15s ease, border-color 0.15s ease;
      white-space: nowrap;
    }

    .hint-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .hint-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-button-background));
      font-weight: 600;
    }

    .input-wrapper {
      display: flex;
      flex-direction: column;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.4));
      border-radius: 4px;
      overflow: hidden;
    }

    .input-wrapper:focus-within {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
    }

    textarea#user-input {
      width: 100%;
      min-height: 48px;
      max-height: 140px;
      padding: 8px 10px;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: var(--font-family);
      font-size: 12.5px;
      resize: none;
      outline: none;
      line-height: 1.4;
    }

    textarea#user-input::placeholder {
      color: var(--vscode-input-placeholderForeground, rgba(128, 128, 128, 0.7));
    }

    .input-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px 6px 8px;
      background: transparent;
    }

    .hint-label {
      font-size: 10.5px;
      opacity: 0.65;
    }

    button#send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      font-size: 11.5px;
      font-weight: 500;
      border-radius: 3px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }

    button#send-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    button#send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>

  <!-- Sidebar Header -->
  <div class="chat-header">
    <div class="header-title">
      <span>Code Mentor</span>
    </div>
    <div class="header-actions">
      <button id="new-task-btn" title="Clear conversation history and reset level to 1">+ New task</button>
    </div>
  </div>

  <!-- Chat Messages Container -->
  <div class="messages-container" id="messages-container">
    <div class="welcome-card" id="welcome-card">
      <h3>👋 Welcome to Code Mentor!</h3>
      <p>I'm here to teach you how to code, explain concepts step-by-step, and guide you without writing all the code for you.</p>
      <div class="welcome-tips">
        <div>• Choose your hint ladder level: Nudge (1), Hint (2), Structure (3), or Solution (4)</div>
        <div>• Right-click any selected code and choose <b>Mentor: Explain Selection</b></div>
        <div>• Ask "Need more help?" at any point to step up to the next hint level</div>
      </div>
    </div>
  </div>

  <!-- Loading State -->
  <div class="loading-indicator" id="loading-indicator">
    <div class="dots-pulse">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span>Mentor is thinking...</span>
  </div>

  <!-- Chat Footer -->
  <div class="chat-footer">
    <!-- Hint Ladder Section -->
    <div class="hint-ladder-container">
      <!-- Soft Confirmation Banner for Solution (4) -->
      <div class="solution-confirm-banner" id="solution-confirm" style="display: none;">
        <div class="solution-confirm-text">Want to try the Structure hint first?</div>
        <div class="solution-confirm-actions">
          <button type="button" class="btn-confirm-action" id="confirm-structure-btn">Try Structure</button>
          <button type="button" class="btn-confirm-action btn-confirm-secondary" id="confirm-solution-btn">Show solution anyway</button>
        </div>
      </div>

      <!-- 4 Ladder Buttons -->
      <div class="hint-buttons-row">
        <button type="button" class="hint-btn active" data-level="1" id="hint-btn-1" title="Level 1: Nudge (gentle direction, no code)">Nudge (1)</button>
        <button type="button" class="hint-btn" data-level="2" id="hint-btn-2" title="Level 2: Hint (idea and what to look for)">Hint (2)</button>
        <button type="button" class="hint-btn" data-level="3" id="hint-btn-3" title="Level 3: Structure (outline, skeleton)">Structure (3)</button>
        <button type="button" class="hint-btn" data-level="4" id="hint-btn-4" title="Level 4: Solution (full working code)">Solution (4)</button>
      </div>
    </div>

    <!-- User Input Wrapper -->
    <div class="input-wrapper">
      <textarea id="user-input" placeholder="Ask your mentor a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-controls">
        <span class="hint-label">Editor context included</span>
        <button id="send-btn">Send</button>
      </div>
    </div>
  </div>

  <script>
    // =========================================================================
    // WEBVIEW <-> EXTENSION HOST MESSAGE PASSING BRIDGE
    // =========================================================================
    const vscode = acquireVsCodeApi();

    const messagesContainer = document.getElementById('messages-container');
    const welcomeCard = document.getElementById('welcome-card');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const loadingIndicator = document.getElementById('loading-indicator');
    const newTaskBtn = document.getElementById('new-task-btn');

    // Hint ladder elements
    const hintBtns = {
      1: document.getElementById('hint-btn-1'),
      2: document.getElementById('hint-btn-2'),
      3: document.getElementById('hint-btn-3'),
      4: document.getElementById('hint-btn-4')
    };
    const solutionConfirmBanner = document.getElementById('solution-confirm');
    const confirmStructureBtn = document.getElementById('confirm-structure-btn');
    const confirmSolutionBtn = document.getElementById('confirm-solution-btn');

    let currentHintLevel = 1;
    let isLoading = false;

    // Notify extension host that webview is fully loaded and ready to receive messages
    vscode.postMessage({ type: 'ready' });

    // -------------------------------------------------------------------------
    // HINT LADDER MANAGEMENT
    // -------------------------------------------------------------------------
    function selectHintLevel(level) {
      currentHintLevel = level;
      for (let i = 1; i <= 4; i++) {
        if (hintBtns[i]) {
          if (i === level) {
            hintBtns[i].classList.add('active');
          } else {
            hintBtns[i].classList.remove('active');
          }
        }
      }
    }

    function showSolutionConfirmation() {
      if (solutionConfirmBanner) {
        solutionConfirmBanner.style.display = 'flex';
      }
    }

    function hideSolutionConfirmation() {
      if (solutionConfirmBanner) {
        solutionConfirmBanner.style.display = 'none';
      }
    }

    function handleHintBtnClick(level) {
      // Soft confirmation inside webview when clicking Solution (4) while level is below 3
      if (level === 4 && currentHintLevel < 3) {
        showSolutionConfirmation();
        return;
      }
      hideSolutionConfirmation();
      selectHintLevel(level);
    }

    // Attach listeners to Hint Ladder buttons
    [1, 2, 3, 4].forEach(function(lvl) {
      if (hintBtns[lvl]) {
        hintBtns[lvl].addEventListener('click', function() {
          handleHintBtnClick(lvl);
        });
      }
    });

    // Soft confirmation actions
    if (confirmStructureBtn) {
      confirmStructureBtn.addEventListener('click', function() {
        hideSolutionConfirmation();
        selectHintLevel(3);
      });
    }

    if (confirmSolutionBtn) {
      confirmSolutionBtn.addEventListener('click', function() {
        hideSolutionConfirmation();
        selectHintLevel(4);
      });
    }

    // -------------------------------------------------------------------------
    // OUTGOING MESSAGES
    // -------------------------------------------------------------------------
    function sendMessage() {
      const text = userInput.value.trim();
      if (!text || isLoading) {
        return;
      }

      // Hide welcome card upon first user interaction
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      // Render the user's message immediately in the UI
      appendUserMessage(text);

      // Post message to extension host with the selected hint level
      vscode.postMessage({
        type: 'ask',
        text: text,
        hintLevel: currentHintLevel
      });

      // Clear input field and reset height
      userInput.value = '';
      userInput.style.height = 'auto';
    }

    sendBtn.addEventListener('click', sendMessage);

    // Enter sends message; Shift+Enter creates a new line
    userInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-grow textarea as user enters multiple lines
    userInput.addEventListener('input', function() {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
    });

    // "New task" button: clears history, resets level to 1, clears chat UI
    newTaskBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'newTask' });
    });

    // -------------------------------------------------------------------------
    // INCOMING: Receiving messages from Extension Host in the Webview
    // -------------------------------------------------------------------------
    window.addEventListener('message', function(event) {
      const message = event.data;

      switch (message.type) {
        case 'reply': {
          // Received structured MentorReply data: { type: 'reply', data: MentorReply, mode: 'task' | 'explain' }
          renderMentorReplyCard(message.data, message.mode);
          break;
        }

        case 'userMessage': {
          // Extension emitted a learner message (e.g. "Explaining your selection...")
          appendUserMessage(message.text);
          break;
        }

        case 'loading': {
          setLoading(message.loading);
          break;
        }

        case 'error': {
          appendErrorMessage(message.message, message.isApiKeyError);
          break;
        }

        case 'taskReset':
        case 'historyCleared': {
          // Clear messages
          messagesContainer.innerHTML = '';
          if (welcomeCard) {
            welcomeCard.style.display = 'block';
            messagesContainer.appendChild(welcomeCard);
          }
          // Reset hint level to 1
          selectHintLevel(1);
          hideSolutionConfirmation();
          userInput.value = '';
          userInput.style.height = 'auto';
          break;
        }

        case 'setLevel': {
          selectHintLevel(message.level);
          break;
        }
      }
    });

    // -------------------------------------------------------------------------
    // RENDERING FUNCTIONS (Safe DOM Construction, Zero Raw innerHTML)
    // -------------------------------------------------------------------------
    function setLoading(loading) {
      isLoading = loading;
      sendBtn.disabled = loading;
      if (loading) {
        loadingIndicator.classList.add('visible');
        messagesContainer.appendChild(loadingIndicator);
        scrollToBottom();
      } else {
        loadingIndicator.classList.remove('visible');
      }
    }

    function appendUserMessage(text) {
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row user-row';

      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      bubble.textContent = text; // Safe text insertion

      row.appendChild(bubble);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    /**
     * renderMentorReplyCard:
     * Renders a structured MentorReply response as a card in the chat.
     *
     * @param {Object} reply - Structured MentorReply object
     * @param {string} mode - 'task' | 'explain'
     */
    function renderMentorReplyCard(reply, mode) {
      if (!reply || typeof reply !== 'object') {
        reply = {
          message: String(reply || ''),
          concept: [],
          next_step: '',
          question: null,
          hint_level: 1,
          code_snippet: null,
          line_notes: undefined
        };
      }

      const isExplainMode = (mode === 'explain');

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'mentor-card';

      // 1. Header: Mentor label & optional Hint level badge (hidden in explain mode)
      const header = document.createElement('div');
      header.className = 'mentor-card-header';

      const titleGroup = document.createElement('div');
      titleGroup.className = 'mentor-title-group';
      const iconSpan = document.createElement('span');
      iconSpan.textContent = isExplainMode ? '🔍' : '🎓';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = isExplainMode ? 'Code Mentor (Explain)' : 'Code Mentor';
      titleGroup.appendChild(iconSpan);
      titleGroup.appendChild(nameSpan);
      header.appendChild(titleGroup);

      // In explain mode, do NOT show the Hint level label
      if (!isExplainMode) {
        const hintBadge = document.createElement('span');
        hintBadge.className = 'hint-badge';
        const level = reply.hint_level || 1;
        hintBadge.textContent = 'Hint level: ' + level + '/4';
        hintBadge.title = getHintDescription(level);
        header.appendChild(hintBadge);
      }

      card.appendChild(header);

      // 2. Message explanation: normal text
      if (reply.message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'mentor-message-body';
        messageEl.textContent = reply.message;
        card.appendChild(messageEl);
      }

      // 3. Line notes: list of code fragments with note beside/below it (used in explain mode)
      if (Array.isArray(reply.line_notes) && reply.line_notes.length > 0) {
        const validNotes = reply.line_notes.filter(function(n) {
          return n && (n.code || n.note);
        });

        if (validNotes.length > 0) {
          const notesContainer = document.createElement('div');
          notesContainer.className = 'line-notes-container';

          const titleEl = document.createElement('div');
          titleEl.className = 'line-notes-title';
          titleEl.textContent = '📝 Line-by-Line Breakdown';
          notesContainer.appendChild(titleEl);

          const listEl = document.createElement('div');
          listEl.className = 'line-notes-list';

          validNotes.forEach(function(item) {
            const itemEl = document.createElement('div');
            itemEl.className = 'line-note-item';

            if (item.code && item.code.trim()) {
              const codeEl = document.createElement('code');
              codeEl.className = 'line-note-code';
              codeEl.textContent = item.code.trim();
              itemEl.appendChild(codeEl);
            }

            if (item.note && item.note.trim()) {
              const noteEl = document.createElement('div');
              noteEl.className = 'line-note-text';
              noteEl.textContent = item.note.trim();
              itemEl.appendChild(noteEl);
            }

            listEl.appendChild(itemEl);
          });

          notesContainer.appendChild(listEl);
          card.appendChild(notesContainer);
        }
      }

      // 4. Guiding question: in italics (if present)
      if (reply.question && reply.question.trim()) {
        const questionBox = document.createElement('div');
        questionBox.className = 'mentor-question-box';

        const questionEm = document.createElement('em');
        questionEm.textContent = reply.question.trim();

        questionBox.appendChild(questionEm);
        card.appendChild(questionBox);
      }

      // 5. "Your next step" box (highlighted)
      if (reply.next_step && reply.next_step.trim()) {
        const nextStepBox = document.createElement('div');
        nextStepBox.className = 'next-step-box';

        const nextStepLabel = document.createElement('div');
        nextStepLabel.className = 'next-step-label';
        nextStepLabel.textContent = '👉 Your next step';

        const nextStepContent = document.createElement('div');
        nextStepContent.className = 'next-step-content';
        nextStepContent.textContent = reply.next_step.trim();

        nextStepBox.appendChild(nextStepLabel);
        nextStepBox.appendChild(nextStepContent);
        card.appendChild(nextStepBox);
      }

      // 6. Code snippet: in <pre><code> block with Copy button
      if (reply.code_snippet && reply.code_snippet.trim()) {
        const snippetText = reply.code_snippet.trim();

        const snippetContainer = document.createElement('div');
        snippetContainer.className = 'code-snippet-container';

        const toolbar = document.createElement('div');
        toolbar.className = 'code-toolbar';

        const codeLabel = document.createElement('span');
        codeLabel.className = 'code-lang-label';
        codeLabel.textContent = 'Code Snippet';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy snippet to clipboard';

        copyBtn.addEventListener('click', function() {
          copySnippetToClipboard(snippetText, copyBtn);
        });

        toolbar.appendChild(codeLabel);
        toolbar.appendChild(copyBtn);

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = snippetText;
        pre.appendChild(code);

        snippetContainer.appendChild(toolbar);
        snippetContainer.appendChild(pre);
        card.appendChild(snippetContainer);
      }

      // 7. Concept chips at bottom
      if (Array.isArray(reply.concept) && reply.concept.length > 0) {
        const validConcepts = reply.concept.filter(function(c) {
          return typeof c === 'string' && c.trim().length > 0;
        });

        if (validConcepts.length > 0) {
          const conceptsBox = document.createElement('div');
          conceptsBox.className = 'concepts-box';

          const conceptsLabel = document.createElement('span');
          conceptsLabel.className = 'concepts-label';
          conceptsLabel.textContent = 'Concepts:';
          conceptsBox.appendChild(conceptsLabel);

          validConcepts.forEach(function(conceptName) {
            const chip = document.createElement('span');
            chip.className = 'concept-chip';
            chip.textContent = conceptName.trim();
            conceptsBox.appendChild(chip);
          });

          card.appendChild(conceptsBox);
        }
      }

      // 8. "Need more help?" button
      // Only shown when NOT in explain mode and when hint level is below 4
      if (!isExplainMode) {
        const replyLevel = reply.hint_level || currentHintLevel || 1;
        if (replyLevel < 4) {
          const nextLevel = replyLevel + 1;
          const needHelpBtn = document.createElement('button');
          needHelpBtn.className = 'need-help-btn';
          needHelpBtn.textContent = '💡 Need more help? (' + getHintName(nextLevel) + ')';
          needHelpBtn.title = 'Move up to hint level ' + nextLevel + ' (' + getHintName(nextLevel) + ') and re-ask';

          needHelpBtn.addEventListener('click', function() {
            needHelpBtn.disabled = true;
            // Update webview hint level selector
            selectHintLevel(nextLevel);
            // Append learner row in chat so the request is visually recorded
            appendUserMessage('Need more help (' + getHintName(nextLevel) + ' ' + nextLevel + ')');
            // Ask extension to re-query with the same task at the new level
            vscode.postMessage({
              type: 'needMoreHelp',
              hintLevel: nextLevel
            });
          });

          card.appendChild(needHelpBtn);
        }
      }

      row.appendChild(card);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    /**
     * Copies code snippet text to clipboard with graceful fallback and user feedback.
     */
    function copySnippetToClipboard(text, button) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          showCopied(button);
        }).catch(function() {
          execCommandCopy(text, button);
        });
      } else {
        execCommandCopy(text, button);
      }
    }

    function execCommandCopy(text, button) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showCopied(button);
      } catch (e) {
        console.error('Copy failed:', e);
      }
      document.body.removeChild(textarea);
    }

    function showCopied(button) {
      const originalText = button.textContent;
      button.textContent = '✓ Copied';
      button.classList.add('copied');
      setTimeout(function() {
        button.textContent = originalText;
        button.classList.remove('copied');
      }, 2000);
    }

    function getHintName(level) {
      switch (level) {
        case 1: return 'Nudge';
        case 2: return 'Hint';
        case 3: return 'Structure';
        case 4: return 'Solution';
        default: return 'Level ' + level;
      }
    }

    function getHintDescription(level) {
      switch (level) {
        case 1: return '1/4: Nudge (gentle direction)';
        case 2: return '2/4: Hint (clue or concept reference)';
        case 3: return '3/4: Structure (code shape / syntax skeleton)';
        case 4: return '4/4: Solution (full worked answer)';
        default: return 'Hint level ' + level;
      }
    }

    function appendErrorMessage(errorText, isApiKeyError) {
      const row = document.createElement('div');
      row.className = 'message-row';

      const card = document.createElement('div');
      card.className = 'error-card';

      const textEl = document.createElement('div');
      textEl.textContent = '⚠️ ' + errorText;
      card.appendChild(textEl);

      // Provide direct button to settings for API key configuration
      if (isApiKeyError) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn-action';
        actionBtn.textContent = 'Configure Gemini API Key';
        actionBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'openSettings' });
        });
        card.appendChild(actionBtn);
      }

      row.appendChild(card);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  </script>
</body>
</html>`;
  }
}
