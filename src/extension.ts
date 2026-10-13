import * as vscode from 'vscode';
import * as path from 'path';
import { askMentor, ChatMessage, MissingApiKeyError } from './llm';

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
          // Retain state when the webview is hidden (e.g., user switches sidebar tabs)
          retainContextWhenHidden: true
        }
      }
    )
  );

  // 2. Register command to open / focus the Code Mentor sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.openChat', async () => {
      // Focuses the registered webview view in the sidebar
      await vscode.commands.executeCommand('mentor.chat.focus');
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
  // Kept here in the extension host so it persists across view re-renders.
  private _history: ChatMessage[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

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
    // The webview sends messages via: vscode.postMessage({ type: '...', ... })
    // We listen to them here in the extension host using onDidReceiveMessage.
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ask': {
          // User asked a question from the webview chat input
          await this._handleUserAsk(message.text);
          break;
        }

        case 'openSettings': {
          // User clicked the "Configure Anthropic API Key" button
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'mentor.apiKey'
          );
          break;
        }

        case 'clearHistory': {
          // User requested clearing conversation memory
          this._history = [];
          this._postMessageToWebview({
            type: 'historyCleared'
          });
          break;
        }
      }
    });
  }

  /**
   * Processes a user question, augments it with current active file context (up to 300 lines),
   * calls the Anthropic LLM, and posts the reply or error back to the webview.
   */
  private async _handleUserAsk(userText: string) {
    if (!this._view) {
      return;
    }

    const trimmedText = userText.trim();
    if (!trimmedText) {
      return;
    }

    // 1. Inspect the currently active editor to extract code context (truncated to ~300 lines)
    const fileContext = this._getActiveFileContext();

    // 2. Format the user prompt for the LLM
    let promptWithContext = trimmedText;
    if (fileContext) {
      promptWithContext =
        `--- Current file: ${fileContext.filename}${fileContext.isTruncated ? ' (truncated to first 300 lines)' : ''} ---\n` +
        '```' + fileContext.languageId + '\n' +
        fileContext.content + '\n' +
        '```\n' +
        `--- End of Current file ---\n\n` +
        `User Question:\n${trimmedText}`;
    }

    // 3. Add user prompt to in-memory history
    this._history.push({
      role: 'user',
      content: promptWithContext
    });

    // =========================================================================
    // MESSAGE PASSING: Extension -> Webview (Notify loading state started)
    // =========================================================================
    this._postMessageToWebview({
      type: 'loading',
      loading: true
    });

    try {
      // 4. Call Anthropic Claude Haiku 5.5 through our standalone llm module
      const mentorReply = await askMentor(this._history);

      // 5. Store assistant reply in memory
      this._history.push({
        role: 'assistant',
        content: mentorReply
      });

      // =======================================================================
      // MESSAGE PASSING: Extension -> Webview (Deliver successful reply)
      // =======================================================================
      this._postMessageToWebview({
        type: 'reply',
        text: mentorReply
      });
    } catch (error: any) {
      // Handle known and unexpected errors gracefully
      let errorMessage = 'An unexpected error occurred while communicating with Code Mentor.';
      let isApiKeyError = false;

      if (error instanceof MissingApiKeyError) {
        isApiKeyError = true;
        errorMessage = error.message;
      } else if (error?.status === 401 || error?.message?.includes('401') || error?.message?.includes('apiKey')) {
        isApiKeyError = true;
        errorMessage = 'Invalid Anthropic API Key (401 Unauthorized). Please check your key in settings.';
      } else if (error?.code === 'ENOTFOUND' || error?.message?.includes('fetch failed') || error?.name === 'APIConnectionError') {
        errorMessage = 'Network connection failed. Please check your internet connection and try again.';
      } else if (error?.message) {
        errorMessage = `Anthropic API error: ${error.message}`;
      }

      // Remove the last un-answered user message from history so the user can re-try cleanly
      this._history.pop();

      // =======================================================================
      // MESSAGE PASSING: Extension -> Webview (Deliver error state)
      // =======================================================================
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
   * Extracts the filename and up to 300 lines of content from the active editor.
   */
  private _getActiveFileContext(): { filename: string; languageId: string; content: string; isTruncated: boolean } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
      return null;
    }

    const doc = editor.document;
    const filename = path.basename(doc.fileName);
    const languageId = doc.languageId || '';
    const totalLines = doc.lineCount;

    // Truncate at ~300 lines
    const maxLines = 300;
    const isTruncated = totalLines > maxLines;
    const linesToExtract = isTruncated ? maxLines : totalLines;

    const endLineIndex = linesToExtract - 1;
    const endCharIndex = doc.lineAt(endLineIndex).text.length;
    const range = new vscode.Range(0, 0, endLineIndex, endCharIndex);

    const content = doc.getText(range);

    return {
      filename,
      languageId,
      content,
      isTruncated
    };
  }

  /**
   * Generates the plain HTML/CSS/JS document for the Webview.
   * Completely styled with VS Code theme variables (--vscode-*).
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
    /* -------------------------------------------------------------
       VS CODE THEME VARIABLES:
       All colors and fonts adapt automatically to any user theme.
       ------------------------------------------------------------- */
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
      background: transparent;
      color: var(--vscode-icon-foreground, inherit);
      border: none;
      cursor: pointer;
      font-size: 11px;
      padding: 3px 6px;
      border-radius: 3px;
      opacity: 0.8;
    }

    .header-actions button:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    }

    /* Messages List */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
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
      padding-left: 16px;
      opacity: 0.8;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* Message Bubbles */
    .message-row {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .message-bubble {
      padding: 10px 12px;
      border-radius: 6px;
      line-height: 1.45;
      font-size: 12.5px;
      word-break: break-word;
    }

    /* User Message */
    .user-row {
      align-items: flex-end;
    }

    .user-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      max-width: 90%;
      border-bottom-right-radius: 2px;
      white-space: pre-wrap;
    }

    /* Mentor Message */
    .mentor-row {
      align-items: flex-start;
    }

    .mentor-header {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .mentor-bubble {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      max-width: 96%;
      border-bottom-left-radius: 2px;
    }

    /* Markdown Styling in Mentor Responses */
    .mentor-bubble p {
      margin-bottom: 8px;
    }

    .mentor-bubble p:last-child {
      margin-bottom: 0;
    }

    .mentor-bubble pre {
      background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.25));
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .mentor-bubble code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.2));
      padding: 2px 4px;
      border-radius: 3px;
    }

    .mentor-bubble pre code {
      background: transparent;
      padding: 0;
    }

    .mentor-bubble ul, .mentor-bubble ol {
      margin-left: 18px;
      margin-bottom: 8px;
    }

    .mentor-bubble li {
      margin-bottom: 4px;
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

    /* Input Footer */
    .chat-footer {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 6px;
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
      <button id="clear-btn" title="Clear conversation history">Clear</button>
    </div>
  </div>

  <!-- Chat Messages Container -->
  <div class="messages-container" id="messages-container">
    <div class="welcome-card" id="welcome-card">
      <h3>👋 Welcome to Code Mentor!</h3>
      <p>I'm here to teach you how to code, explain confusing concepts, and guide you through bugs step-by-step.</p>
      <div class="welcome-tips">
        <div>• Ask "Why does this work?" or "Help me understand this error"</div>
        <div>• Your active file (up to 300 lines) is automatically provided as context</div>
        <div>• Set your Anthropic API key in Settings if you haven't yet</div>
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

  <!-- Input Footer -->
  <div class="chat-footer">
    <div class="input-wrapper">
      <textarea id="user-input" placeholder="Ask your mentor a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-controls">
        <span class="hint-label">Active file included</span>
        <button id="send-btn">Send</button>
      </div>
    </div>
  </div>

  <script>
    // =========================================================================
    // WEBVIEW <-> EXTENSION HOST MESSAGE PASSING
    // =========================================================================
    // In VS Code webviews, the global acquireVsCodeApi() function provides the
    // bridge to communicate with the extension host running in Node.js.
    const vscode = acquireVsCodeApi();

    const messagesContainer = document.getElementById('messages-container');
    const welcomeCard = document.getElementById('welcome-card');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const loadingIndicator = document.getElementById('loading-indicator');
    const clearBtn = document.getElementById('clear-btn');

    let isLoading = false;

    // -------------------------------------------------------------------------
    // 1. OUTGOING: Sending messages from Webview to Extension Host
    // -------------------------------------------------------------------------
    function sendMessage() {
      const text = userInput.value.trim();
      if (!text || isLoading) {
        return;
      }

      // Hide welcome card on first user interaction
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      // Render the user's message immediately in the UI
      appendUserMessage(text);

      // POST MESSAGE TO EXTENSION:
      // Sends a JSON payload { type: 'ask', text: '...' } to the extension host
      vscode.postMessage({
        type: 'ask',
        text: text
      });

      // Clear input field and reset height
      userInput.value = '';
      userInput.style.height = 'auto';
    }

    sendBtn.addEventListener('click', sendMessage);

    // Support Enter to send, Shift+Enter for new line
    userInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-expand textarea as user types
    userInput.addEventListener('input', function() {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
    });

    clearBtn.addEventListener('click', function() {
      // POST MESSAGE TO EXTENSION:
      // Ask extension host to clear conversation memory
      vscode.postMessage({ type: 'clearHistory' });
    });

    // -------------------------------------------------------------------------
    // 2. INCOMING: Receiving messages from Extension Host in the Webview
    // -------------------------------------------------------------------------
    // The extension calls webview.postMessage({...}), which fires a 'message'
    // event on the webview's window object.
    window.addEventListener('message', function(event) {
      const message = event.data; // The JSON payload sent by the extension

      switch (message.type) {
        case 'reply': {
          // Received a mentor reply from Claude Haiku
          appendMentorMessage(message.text);
          break;
        }

        case 'loading': {
          // Received loading state change
          setLoading(message.loading);
          break;
        }

        case 'error': {
          // Received an error notification
          appendErrorMessage(message.message, message.isApiKeyError);
          break;
        }

        case 'historyCleared': {
          // Extension confirmed memory was cleared
          messagesContainer.innerHTML = '';
          if (welcomeCard) {
            welcomeCard.style.display = 'block';
            messagesContainer.appendChild(welcomeCard);
          }
          break;
        }
      }
    });

    // -------------------------------------------------------------------------
    // UI Helpers: Rendering DOM elements
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
      const row = document.createElement('div');
      row.className = 'message-row user-row';

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble user-bubble';
      bubble.textContent = text;

      row.appendChild(bubble);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    function appendMentorMessage(text) {
      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const header = document.createElement('div');
      header.className = 'mentor-header';
      header.innerHTML = '<span>🎓</span><span>Mentor</span>';

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble mentor-bubble';
      // Format markdown-like text (code blocks, bold, lists) safely
      bubble.innerHTML = formatMarkdown(text);

      row.appendChild(header);
      row.appendChild(bubble);
      messagesContainer.appendChild(row);
      scrollToBottom();
    }

    function appendErrorMessage(errorText, isApiKeyError) {
      const row = document.createElement('div');
      row.className = 'message-row';

      const card = document.createElement('div');
      card.className = 'error-card';

      const textEl = document.createElement('div');
      textEl.textContent = '⚠️ ' + errorText;
      card.appendChild(textEl);

      // If missing API key, provide an interactive button that sends 'openSettings'
      // back to the extension host to open settings directly for the user!
      if (isApiKeyError) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn-action';
        actionBtn.textContent = 'Configure Anthropic API Key';
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

    /**
     * Simple, safe markdown formatter for code blocks, inline code, bold, and lists.
     * Escapes raw HTML to prevent any injection.
     */
    function formatMarkdown(raw) {
      if (!raw) return '';

      // 1. Escape HTML
      let escaped = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      // 2. Code blocks
      const codeBlockRegex = new RegExp('\\x60\\x60\\x60([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\\x60\\x60\\x60', 'g');
      escaped = escaped.replace(codeBlockRegex, function(match, lang, code) {
        return '<pre><code>' + code.trim() + '</code></pre>';
      });

      // 3. Inline code
      const inlineCodeRegex = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
      escaped = escaped.replace(inlineCodeRegex, '<code>$1</code>');

      // 4. Bold
      escaped = escaped.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');

      // 5. Italic
      escaped = escaped.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');

      // 6. Line breaks into paragraphs
      const paragraphs = escaped.split(/\\n{2,}/);
      return paragraphs.map(function(p) {
        const trimmed = p.trim();
        if (trimmed.startsWith('<pre>') && trimmed.endsWith('</pre>')) {
          return trimmed;
        }
        return '<p>' + trimmed.replace(/\\n/g, '<br/>') + '</p>';
      }).join('');
    }
  </script>
</body>
</html>`;
  }
}
