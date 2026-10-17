import * as vscode from 'vscode';
import * as path from 'path';
import {
  askMentor,
  parseMentorReply,
  ChatMessage,
  MentorReply,
  LineNote,
  ReviewFinding,
  MissingApiKeyError
} from './llm';
import {
  initProgress,
  saveConcepts,
  getConcepts
} from './progress';

/**
 * Activates the Code Mentor extension.
 * Sets up the WebviewViewProvider for the sidebar chat, initializes concept progress tracking,
 * and registers extension commands.
 */
export function activate(context: vscode.ExtensionContext) {
  // Initialize progress tracking module with extension globalState
  initProgress(context.globalState);

  // 1. Create and register the WebviewViewProvider for the sidebar chat
  const provider = new MentorChatViewProvider(context.extensionUri, context.globalState);

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

  // 4. Register command palette command: "Mentor: Review My Code" (command palette only)
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.reviewFile', async () => {
      // Capture the active editor before focusing the webview so focus change doesn't clear it
      const editor = vscode.window.activeTextEditor;
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.reviewActiveFile(editor);
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
  // Tracks active interaction mode: 'task' (normal ladder), 'explain', 'review', or 'explain_back'
  private _currentMode: 'task' | 'explain' | 'review' | 'explain_back' = 'task';

  // Webview lifecycle readiness and queued pending requests for when sidebar is closed
  private _isWebviewReady: boolean = false;
  private _pendingExplain: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingReview: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingNotice: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento
  ) {}

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

          // Dispatch any actions queued while sidebar was closed
          if (this._pendingNotice) {
            const notice = this._pendingNotice;
            this._pendingNotice = null;
            this._postMessageToWebview({
              type: 'noticeMessage',
              text: notice
            });
          } else if (this._pendingExplain) {
            const pending = this._pendingExplain;
            this._pendingExplain = null;
            await this._executeExplain(pending.fileName, pending.languageId, pending.code);
          } else if (this._pendingReview) {
            const pending = this._pendingReview;
            this._pendingReview = null;
            await this._executeReview(pending.fileName, pending.languageId, pending.code);
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

        case 'reviewFile': {
          // Learner clicked "Review my code" in sidebar header
          await this.reviewActiveFile();
          break;
        }

        case 'explainBack': {
          // Learner submitted their own understanding check
          await this._handleExplainBack(message.explanation);
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
   * Entry point for Review My Code:
   * Gathers active file name, languageId, and content (truncated at ~300 lines).
   * If there is no active editor or file is empty, shows friendly in-chat notice without calling LLM.
   * Reuses the 'ready' handshake and queue when sidebar was closed.
   */
  public async reviewActiveFile(editor?: vscode.TextEditor): Promise<void> {
    // Check passed editor, activeTextEditor, or first visible editor (handles webview focus)
    const targetEditor = editor || vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
    if (!targetEditor || !targetEditor.document) {
      this._handleNoActiveFileForReview();
      return;
    }

    const doc = targetEditor.document;
    const fullText = doc.getText().trim();
    if (!fullText) {
      this._handleNoActiveFileForReview();
      return;
    }

    const fileName = path.basename(doc.fileName);
    const languageId = doc.languageId || 'plaintext';

    // Truncate file at ~300 lines
    const totalLines = doc.lineCount;
    let code = doc.getText();
    if (totalLines > 300) {
      const endLine = 299;
      const endChar = doc.lineAt(endLine).text.length;
      code = doc.getText(new vscode.Range(0, 0, endLine, endChar)) + '\n\n// ... (file truncated to 300 lines)';
    }

    // If webview is not ready yet, queue the review request
    if (!this._view || !this._isWebviewReady) {
      this._pendingReview = { fileName, languageId, code };
      return;
    }

    await this._executeReview(fileName, languageId, code);
  }

  /**
   * Shows a friendly in-chat message when review is triggered without an active/non-empty file.
   * Does NOT call the LLM.
   */
  private _handleNoActiveFileForReview(): void {
    const notice = 'Open a file with some code first';
    if (!this._view || !this._isWebviewReady) {
      this._pendingNotice = notice;
    } else {
      this._postMessageToWebview({
        type: 'noticeMessage',
        text: notice
      });
    }
  }

  /**
   * Executes a review request once the webview is ready.
   */
  private async _executeReview(fileName: string, languageId: string, code: string): Promise<void> {
    this._currentMode = 'review';
    this._currentTaskText = `Review ${fileName}`;

    // Show a short learner-side line in the chat: "Reviewing <file name>..."
    this._postMessageToWebview({
      type: 'userMessage',
      text: `Reviewing ${fileName}...`
    });

    // Build the user message for review mode
    const prompt = `Mode: review\nFile: ${fileName} (${languageId})\nCurrent file:\n${code}`;

    await this._executePrompt(prompt, 'review');
  }

  /**
   * Handles "Explain it back" submission from the learner.
   * Gathers original task text and active file content (truncated to ~300 lines).
   * If there is no active file, sends prompt without the file section.
   */
  private async _handleExplainBack(learnerExplanation: string): Promise<void> {
    const trimmedExplanation = (learnerExplanation || '').trim();
    if (!trimmedExplanation) {
      return;
    }

    this._currentMode = 'explain_back';
    const task = this._currentTaskText || 'Current coding task';

    // Gather active file content if present
    const targetEditor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
    let fileSection = '';
    if (targetEditor && targetEditor.document) {
      const doc = targetEditor.document;
      const fullText = doc.getText().trim();
      if (fullText) {
        const totalLines = doc.lineCount;
        let code = doc.getText();
        if (totalLines > 300) {
          const endLine = 299;
          const endChar = doc.lineAt(endLine).text.length;
          code = doc.getText(new vscode.Range(0, 0, endLine, endChar)) + '\n\n// ... (file truncated to 300 lines)';
        }
        fileSection = `\nCurrent file:\n${code}`;
      }
    }

    // Build user message for explain_back mode
    const prompt = `Mode: explain_back\nTask: ${task}${fileSection}\nLearner's explanation:\n${trimmedExplanation}`;

    await this._executePrompt(prompt, 'explain_back');
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
   * Mode handling:
   * - Tracks current mode ('task' | 'explain' | 'review' | 'explain_back') and delivers it with the reply payload.
   * - Persists learned concepts into context.globalState under "mentor.concepts" after every successful reply.
   */
  private async _executePrompt(
    userMessageContent: string,
    mode: 'task' | 'explain' | 'review' | 'explain_back'
  ): Promise<void> {
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

      // =======================================================================
      // GLOBALSTATE CONCEPT TRACKING (Requirement C)
      // =======================================================================
      // Update globalState under key "mentor.concepts" with normalized concept names.
      // Wrapped in try/catch in saveConcepts so a storage error never breaks the chat.
      if (Array.isArray(structuredReply.concept) && structuredReply.concept.length > 0) {
        await saveConcepts(structuredReply.concept, this._globalState);
      }

      // 5. Deliver structured reply to webview along with the explicit mode
      // Mode controls which UI cards, buttons, badges, and actions display in the webview
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
    const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
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
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
      gap: 6px;
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
      flex-shrink: 0;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
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
      white-space: nowrap;
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

    /* Notice Card (e.g. "Open a file with some code first") */
    .notice-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 4px;
      padding: 10px 12px;
      font-size: 12.5px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-foreground);
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

    /* =============================================================
       REVIEW FINDINGS (Requirement A.5)
       ============================================================= */
    .findings-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 2px;
    }

    .findings-title {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.85;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .findings-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .finding-card {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 0 4px 4px 0;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .finding-area {
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }

    .finding-observation {
      font-size: 12px;
      line-height: 1.45;
      opacity: 0.95;
    }

    .finding-question {
      font-size: 11.5px;
      font-style: italic;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      margin-top: 2px;
    }

    /* =============================================================
       EXPLAIN IT BACK CARDS & BADGES (Requirement B.3)
       ============================================================= */
    .explain-back-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 2px;
    }

    .understanding-badge-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .understanding-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 9px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      letter-spacing: 0.3px;
    }

    /* Theme-aware colored badges with explicit text labels */
    .understanding-badge.badge-solid {
      background: var(--vscode-editorGutter-addedBackground, rgba(46, 160, 67, 0.25));
      color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorGutter-addedBackground, rgba(46, 160, 67, 0.5));
    }

    .understanding-badge.badge-partial {
      background: var(--vscode-editorWarning-background, rgba(210, 153, 34, 0.25));
      color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorWarning-border, rgba(210, 153, 34, 0.5));
    }

    .understanding-badge.badge-shaky {
      background: var(--vscode-editorError-background, rgba(248, 81, 73, 0.25));
      color: var(--vscode-editorError-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorError-border, rgba(248, 81, 73, 0.5));
    }

    .eval-section {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 4px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .eval-section.eval-right {
      border-left: 3px solid var(--vscode-terminal-ansiGreen, #2ea043);
    }

    .eval-section.eval-gaps {
      border-left: 3px solid var(--vscode-editorWarning-foreground, #d29922);
    }

    .eval-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .eval-list {
      margin-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 12px;
      line-height: 1.45;
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
      padding: 8px 12px 10px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* =============================================================
       EXPLAIN IT BACK INLINE PANEL (Requirement B.1)
       ============================================================= */
    .explain-back-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .finish-feature-btn {
      align-self: flex-start;
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s ease;
    }

    .finish-feature-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .explain-back-panel {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.1));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 4px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: fadeIn 0.15s ease-in-out;
    }

    .explain-back-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .btn-close-panel {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.6;
      cursor: pointer;
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 2px;
    }

    .btn-close-panel:hover {
      opacity: 1;
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
    }

    textarea#explain-back-input {
      width: 100%;
      min-height: 54px;
      max-height: 120px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
      border-radius: 3px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--font-family);
      font-size: 12px;
      resize: none;
      outline: none;
      line-height: 1.4;
    }

    textarea#explain-back-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .explain-back-panel-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .char-count {
      font-size: 10.5px;
      opacity: 0.7;
    }

    .btn-submit-explain {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-submit-explain:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-submit-explain:disabled {
      opacity: 0.45;
      cursor: not-allowed;
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
      <!-- Requirement A.1: "Review my code" button in sidebar header -->
      <button id="review-code-btn" title="Review my current active file">🔍 Review my code</button>
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
        <div>• Click <b>🔍 Review my code</b> to get an educational review of your current file</div>
        <div>• Right-click any selected code and choose <b>Mentor: Explain Selection</b></div>
        <div>• Click <b>✓ I finished this feature</b> to explain it in your own words and verify your understanding</div>
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
    <!-- Requirement B.1: "I finished this feature" button and inline explain-back panel -->
    <div class="explain-back-section" id="explain-back-section" style="display: none;">
      <button type="button" class="finish-feature-btn" id="finish-feature-btn">
        <span>✓ I finished this feature</span>
      </button>
      <div class="explain-back-panel" id="explain-back-panel" style="display: none;">
        <div class="explain-back-panel-header">
          <span>Explain in your own words how this works</span>
          <button type="button" class="btn-close-panel" id="close-explain-panel" title="Close panel">✕</button>
        </div>
        <textarea id="explain-back-input" placeholder="Explain in your own words how this works..."></textarea>
        <div class="explain-back-panel-footer">
          <span class="char-count" id="explain-char-count">0 / 15 chars min</span>
          <button type="button" class="btn-submit-explain" id="submit-explain-btn" disabled>Submit</button>
        </div>
      </div>
    </div>

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
    const reviewCodeBtn = document.getElementById('review-code-btn');

    // Explain It Back elements (Requirement B.1)
    const explainBackSection = document.getElementById('explain-back-section');
    const finishFeatureBtn = document.getElementById('finish-feature-btn');
    const explainBackPanel = document.getElementById('explain-back-panel');
    const closeExplainPanelBtn = document.getElementById('close-explain-panel');
    const explainBackInput = document.getElementById('explain-back-input');
    const explainCharCount = document.getElementById('explain-char-count');
    const submitExplainBtn = document.getElementById('submit-explain-btn');

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
    let hasReplies = false; // Tracks if at least one reply has been received

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
    // HEADER & EXPLAIN BACK ACTIONS
    // -------------------------------------------------------------------------
    // Requirement A.1: "Review my code" header button
    if (reviewCodeBtn) {
      reviewCodeBtn.addEventListener('click', function() {
        if (isLoading) return;
        vscode.postMessage({ type: 'reviewFile' });
      });
    }

    // Requirement B.1: "I finished this feature" button toggles inline panel
    if (finishFeatureBtn) {
      finishFeatureBtn.addEventListener('click', function() {
        finishFeatureBtn.style.display = 'none';
        explainBackPanel.style.display = 'flex';
        explainBackInput.focus();
      });
    }

    if (closeExplainPanelBtn) {
      closeExplainPanelBtn.addEventListener('click', function() {
        explainBackPanel.style.display = 'none';
        finishFeatureBtn.style.display = 'inline-flex';
      });
    }

    // Requirement B.1: Disable submit until text has at least 15 characters
    if (explainBackInput) {
      explainBackInput.addEventListener('input', function() {
        const text = explainBackInput.value.trim();
        const len = text.length;
        if (explainCharCount) {
          explainCharCount.textContent = len + ' / 15 chars min';
        }
        if (submitExplainBtn) {
          submitExplainBtn.disabled = len < 15;
        }
      });
    }

    // Requirement B.2: Submit explanation
    if (submitExplainBtn) {
      submitExplainBtn.addEventListener('click', function() {
        const text = explainBackInput.value.trim();
        if (text.length < 15 || isLoading) return;

        // Reset and hide panel
        explainBackPanel.style.display = 'none';
        finishFeatureBtn.style.display = 'inline-flex';
        explainBackInput.value = '';
        submitExplainBtn.disabled = true;
        if (explainCharCount) {
          explainCharCount.textContent = '0 / 15 chars min';
        }

        // Show learner message bubble
        appendUserMessage('Explaining my understanding:\\n' + text);

        // Send to extension host
        vscode.postMessage({
          type: 'explainBack',
          explanation: text
        });
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
          // Received structured MentorReply data:
          // { type: 'reply', data: MentorReply, mode: 'task' | 'explain' | 'review' | 'explain_back' }
          renderMentorReplyCard(message.data, message.mode);
          break;
        }

        case 'userMessage': {
          // Extension emitted a learner message (e.g. "Reviewing app.js..." or "Explaining selection...")
          appendUserMessage(message.text);
          break;
        }

        case 'noticeMessage': {
          // Requirement A.3: Friendly in-chat message when no active file or empty
          appendNoticeMessage(message.text);
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

          // Reset "I finished this feature" visibility
          hasReplies = false;
          if (explainBackSection) {
            explainBackSection.style.display = 'none';
          }
          if (explainBackPanel) {
            explainBackPanel.style.display = 'none';
          }
          if (finishFeatureBtn) {
            finishFeatureBtn.style.display = 'inline-flex';
          }
          if (explainBackInput) {
            explainBackInput.value = '';
          }
          if (submitExplainBtn) {
            submitExplainBtn.disabled = true;
          }
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
     * Appends a friendly in-chat notice card (e.g. "Open a file with some code first").
     */
    function appendNoticeMessage(text) {
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'notice-card';

      const iconSpan = document.createElement('span');
      iconSpan.textContent = 'ℹ️';
      const textSpan = document.createElement('span');
      textSpan.textContent = text;

      card.appendChild(iconSpan);
      card.appendChild(textSpan);
      row.appendChild(card);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    /**
     * renderMentorReplyCard:
     * Renders a structured MentorReply response as a card in the chat.
     * Supports modes:
     * - 'task': Default ladder card with hint badge and "Need more help?" button
     * - 'explain': Explain mode with line notes (hides hint badge & need help button)
     * - 'review': Review mode with findings cards (hides hint badge & need help button)
     * - 'explain_back': Understanding check card with colored badge, got_right, and gaps (hides hint badge & need help button)
     *
     * @param {Object} reply - Structured MentorReply object
     * @param {string} mode - 'task' | 'explain' | 'review' | 'explain_back'
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
          line_notes: undefined,
          findings: undefined,
          understanding: undefined,
          got_right: undefined,
          gaps: undefined
        };
      }

      // Requirement B.1: Show "I finished this feature" once conversation has at least one reply
      hasReplies = true;
      if (explainBackSection) {
        explainBackSection.style.display = 'block';
      }

      const isExplainMode = (mode === 'explain');
      const isReviewMode = (mode === 'review');
      const isExplainBackMode = (mode === 'explain_back');
      // Hide hint ladder badge and "Need more help?" button for non-task modes
      const hideLadderControls = isExplainMode || isReviewMode || isExplainBackMode;

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'mentor-card';

      // 1. Header: Mentor label & optional Hint level badge
      const header = document.createElement('div');
      header.className = 'mentor-card-header';

      const titleGroup = document.createElement('div');
      titleGroup.className = 'mentor-title-group';
      const iconSpan = document.createElement('span');
      const nameSpan = document.createElement('span');

      if (isExplainMode) {
        iconSpan.textContent = '🔍';
        nameSpan.textContent = 'Code Mentor (Explain)';
      } else if (isReviewMode) {
        iconSpan.textContent = '📋';
        nameSpan.textContent = 'Code Mentor (Review)';
      } else if (isExplainBackMode) {
        iconSpan.textContent = '🎯';
        nameSpan.textContent = 'Code Mentor (Check)';
      } else {
        iconSpan.textContent = '🎓';
        nameSpan.textContent = 'Code Mentor';
      }

      titleGroup.appendChild(iconSpan);
      titleGroup.appendChild(nameSpan);
      header.appendChild(titleGroup);

      // Only show Hint level label in standard task mode
      if (!hideLadderControls) {
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

      // 3. Line notes: list of code fragments with note (used in explain mode)
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

      // 4. Requirement A.5: Findings list for review mode
      // Render findings as a list of small cards: area as a bold label, observation as text, the question in italics.
      if (Array.isArray(reply.findings) && reply.findings.length > 0) {
        const validFindings = reply.findings.filter(function(f) {
          return f && (f.area || f.observation || f.question);
        });

        if (validFindings.length > 0) {
          const findingsContainer = document.createElement('div');
          findingsContainer.className = 'findings-container';

          const findingsTitle = document.createElement('div');
          findingsTitle.className = 'findings-title';
          findingsTitle.textContent = '📋 Review Findings';
          findingsContainer.appendChild(findingsTitle);

          const findingsList = document.createElement('div');
          findingsList.className = 'findings-list';

          validFindings.forEach(function(item) {
            const itemCard = document.createElement('div');
            itemCard.className = 'finding-card';

            // Area as bold label
            if (item.area && item.area.trim()) {
              const areaEl = document.createElement('div');
              areaEl.className = 'finding-area';
              areaEl.textContent = item.area.trim();
              itemCard.appendChild(areaEl);
            }

            // Observation as text
            if (item.observation && item.observation.trim()) {
              const obsEl = document.createElement('div');
              obsEl.className = 'finding-observation';
              obsEl.textContent = item.observation.trim();
              itemCard.appendChild(obsEl);
            }

            // Question in italics
            if (item.question && item.question.trim()) {
              const qEl = document.createElement('div');
              qEl.className = 'finding-question';
              const em = document.createElement('em');
              em.textContent = item.question.trim();
              qEl.appendChild(em);
              itemCard.appendChild(qEl);
            }

            findingsList.appendChild(itemCard);
          });

          findingsContainer.appendChild(findingsList);
          card.appendChild(findingsContainer);
        }
      }

      // 5. Requirement B.3: Explain It Back assessment card
      // Badge for understanding (with text label), "What you got right" list, "What to revisit" list
      const hasExplainBackData = reply.understanding ||
        (Array.isArray(reply.got_right) && reply.got_right.length > 0) ||
        (Array.isArray(reply.gaps) && reply.gaps.length > 0);

      if (hasExplainBackData) {
        const evalContainer = document.createElement('div');
        evalContainer.className = 'explain-back-container';

        // Colored badge for understanding (uses VS Code theme variables and explicit text)
        if (reply.understanding) {
          const badgeWrap = document.createElement('div');
          badgeWrap.className = 'understanding-badge-wrapper';

          const badge = document.createElement('span');
          badge.className = 'understanding-badge badge-' + reply.understanding;

          let label = 'Solid Understanding';
          let symbol = '●';
          if (reply.understanding === 'partial') {
            label = 'Partial Understanding';
            symbol = '▲';
          } else if (reply.understanding === 'shaky') {
            label = 'Needs Work (Shaky)';
            symbol = '■';
          }
          badge.textContent = symbol + ' ' + label;
          badgeWrap.appendChild(badge);
          evalContainer.appendChild(badgeWrap);
        }

        // "What you got right" as a list
        if (Array.isArray(reply.got_right) && reply.got_right.length > 0) {
          const rightBox = document.createElement('div');
          rightBox.className = 'eval-section eval-right';

          const rightTitle = document.createElement('div');
          rightTitle.className = 'eval-title';
          rightTitle.textContent = '✓ What you got right:';
          rightBox.appendChild(rightTitle);

          const rightList = document.createElement('ul');
          rightList.className = 'eval-list';
          reply.got_right.forEach(function(item) {
            if (typeof item === 'string' && item.trim()) {
              const li = document.createElement('li');
              li.textContent = item.trim();
              rightList.appendChild(li);
            }
          });
          rightBox.appendChild(rightList);
          evalContainer.appendChild(rightBox);
        }

        // "What to revisit" as a list
        if (Array.isArray(reply.gaps) && reply.gaps.length > 0) {
          const gapsBox = document.createElement('div');
          gapsBox.className = 'eval-section eval-gaps';

          const gapsTitle = document.createElement('div');
          gapsTitle.className = 'eval-title';
          gapsTitle.textContent = '⚠️ What to revisit:';
          gapsBox.appendChild(gapsTitle);

          const gapsList = document.createElement('ul');
          gapsList.className = 'eval-list';
          reply.gaps.forEach(function(item) {
            if (typeof item === 'string' && item.trim()) {
              const li = document.createElement('li');
              li.textContent = item.trim();
              gapsList.appendChild(li);
            }
          });
          gapsBox.appendChild(gapsList);
          evalContainer.appendChild(gapsBox);
        }

        card.appendChild(evalContainer);
      }

      // 6. Guiding question: in italics (if present)
      if (reply.question && reply.question.trim()) {
        const questionBox = document.createElement('div');
        questionBox.className = 'mentor-question-box';

        const questionEm = document.createElement('em');
        questionEm.textContent = reply.question.trim();

        questionBox.appendChild(questionEm);
        card.appendChild(questionBox);
      }

      // 7. "Your next step" box (highlighted, if provided)
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

      // 8. Code snippet: in <pre><code> block with Copy button
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

      // 9. Concept chips at bottom
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

      // 10. "Need more help?" button
      // Only shown when in standard task mode and when hint level is below 4
      if (!hideLadderControls) {
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
