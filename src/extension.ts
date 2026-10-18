import * as vscode from 'vscode';
import * as path from 'path';
import {
  askMentor,
  parseMentorReply,
  ChatMessage,
  MentorReply,
  LineNote,
  ReviewFinding,
  MissingApiKeyError,
  testApiConnection
} from './llm';
import {
  initProgress,
  saveConcepts,
  getConcepts,
  clearConcepts
} from './progress';
import {
  MentorConfig,
  DEFAULT_CONFIG,
  loadConfig,
  watchConfigFile,
  createOrOpenConfigFile
} from './config';
import {
  registerPasteDetector,
  PasteEventPayload
} from './paste';

/**
 * Output channel for extension logging.
 * Clean, secret-free diagnostics.
 */
let logChannel: vscode.OutputChannel;

/**
 * Logs sanitized error messages to the "Code Mentor" output channel.
 * Never includes API keys, headers, or full request bodies.
 */
function logError(message: string, error?: any): void {
  const timestamp = new Date().toISOString();
  let detail = '';
  if (error) {
    detail = error.message || String(error);
    // Sanitize any accidental API key patterns (AIza...)
    detail = detail.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]');
  }
  logChannel.appendLine(`[${timestamp}] ERROR: ${message} ${detail}`.trim());
}

/**
 * Checks if a Gemini API key is currently configured in user/workspace settings.
 */
function hasApiKeyConfigured(): boolean {
  const config = vscode.workspace.getConfiguration('mentor');
  const key = (config.get<string>('apiKey', '') || config.get<string>('apikey', '')).trim();
  return key.length > 0;
}

/**
 * Activates the Code Mentor extension.
 * Sets up provider, commands, watchers, and listeners.
 */
export async function activate(context: vscode.ExtensionContext) {
  // 1. Create OutputChannel named "Code Mentor" (Requirement E.1)
  logChannel = vscode.window.createOutputChannel('Code Mentor');
  context.subscriptions.push(logChannel);

  // 2. Initialize concept tracking module with extension globalState
  initProgress(context.globalState);

  // 3. Check onboarding flag in globalState
  const isOnboarded = context.globalState.get<boolean>('mentor.onboarded', false);

  // 4. Load initial instructor configuration (.mentor.json)
  const initialConfig = await loadConfig();

  // 5. Create WebviewViewProvider for the sidebar chat
  const provider = new MentorChatViewProvider(
    context.extensionUri,
    context.globalState,
    initialConfig.config,
    initialConfig.active,
    isOnboarded,
    hasApiKeyConfigured()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mentor.chat',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // 6. Watch for .mentor.json changes
  const configWatcher = watchConfigFile((config, active) => {
    provider.updateConfig(config, active);
  });
  context.subscriptions.push(configWatcher);

  // 7. Watch for mentor configuration changes (API key, model)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mentor.apiKey') || e.affectsConfiguration('mentor.apikey')) {
        provider.notifyApiKeyStatus(hasApiKeyConfigured());
      }
    })
  );

  // 8. Register paste detector
  registerPasteDetector(
    context,
    () => provider.getConfigState(),
    async (payload) => {
      await provider.handlePasteEvent(payload);
    }
  );

  // 9. Register extension commands (checked against package.json)
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.openChat', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
    })
  );

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

      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.explainSelection(fileName, languageId, selectedText);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.reviewActiveFile(editor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.createConfig', async () => {
      await createOrOpenConfigFile();
    })
  );

  // Requirement C.4: "Mentor: Test API Connection" command
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.testConnection', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Code Mentor: Testing Gemini API connection...'
        },
        async () => {
          const res = await testApiConnection();
          if (res.success) {
            vscode.window.showInformationMessage(`Code Mentor: ${res.message}`);
          } else {
            vscode.window.showErrorMessage(`Code Mentor: ${res.message}`);
          }
        }
      );
    })
  );

  // Requirement E.2: "Mentor: Show Logs" command
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.showLogs', () => {
      logChannel.show();
    })
  );
}

export function deactivate() {
  // Cleanup managed by subscriptions
}

/**
 * Provider responsible for creating and managing the Webview in the sidebar.
 * Handles the message-passing lifecycle between the Webview UI and the Extension Host.
 */
class MentorChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  // In-memory conversation history
  private _history: ChatMessage[] = [];

  // Per-task state retained on the extension host
  private _currentLevel: 1 | 2 | 3 | 4 = 1;
  private _currentTaskText: string = '';
  private _currentMode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' = 'task';

  // Active instructor configuration state
  private _currentConfig: MentorConfig;
  private _activeConfig: boolean;

  // Onboarding & API key status
  private _isOnboarded: boolean;
  private _hasApiKey: boolean;

  // Request in-flight tracking & abort controller for cancel/timeout
  private _isRequestInProgress: boolean = false;
  private _currentAbortController: AbortController | null = null;
  private _isUserCancelled: boolean = false;
  private _isTimeout: boolean = false;

  // Last request cache for seamless Retry (Requirement C.2)
  private _lastRequest: {
    content: string;
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check';
    hintLevel: number;
  } | null = null;

  // Webview lifecycle readiness and queued pending requests
  private _isWebviewReady: boolean = false;
  private _pendingExplain: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingReview: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingPasteExplain: PasteEventPayload | null = null;
  private _pendingNotice: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _globalState: vscode.Memento,
    initialConfig: MentorConfig,
    initialActive: boolean,
    initialOnboarded: boolean,
    initialHasApiKey: boolean
  ) {
    this._currentConfig = initialConfig;
    this._activeConfig = initialActive;
    this._isOnboarded = initialOnboarded;
    this._hasApiKey = initialHasApiKey;
  }

  public updateConfig(config: MentorConfig, active: boolean): void {
    this._currentConfig = config;
    this._activeConfig = active;

    this._postMessageToWebview({
      type: 'config',
      config: this._currentConfig,
      active: this._activeConfig
    });
  }

  public notifyApiKeyStatus(hasKey: boolean): void {
    this._hasApiKey = hasKey;
    this._postMessageToWebview({
      type: 'apiKeyStatus',
      hasApiKey: this._hasApiKey
    });
  }

  public getConfigState(): { config: MentorConfig; active: boolean } {
    return {
      config: this._currentConfig,
      active: this._activeConfig
    };
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._isWebviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // =========================================================================
    // MESSAGE PASSING: Listening for messages sent FROM the webview
    // =========================================================================
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready': {
          this._isWebviewReady = true;

          // Deliver initial state to webview
          this._postMessageToWebview({
            type: 'config',
            config: this._currentConfig,
            active: this._activeConfig
          });
          this._postMessageToWebview({
            type: 'apiKeyStatus',
            hasApiKey: this._hasApiKey
          });
          this._postMessageToWebview({
            type: 'onboardedStatus',
            isOnboarded: this._isOnboarded
          });

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
          } else if (this._pendingPasteExplain) {
            const pending = this._pendingPasteExplain;
            this._pendingPasteExplain = null;
            await this._promptPasteCheckInWebview(pending);
          }
          break;
        }

        case 'ask': {
          // Requirement B.4: Prevent double-sends while request in flight
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this._handleUserAsk(message.text, message.hintLevel);
          break;
        }

        case 'needMoreHelp': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._handleNeedMoreHelp(message.hintLevel);
          break;
        }

        case 'reviewFile': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this.reviewActiveFile();
          break;
        }

        case 'explainBack': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._handleExplainBack(message.explanation);
          break;
        }

        case 'submitPasteCheck': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._handlePasteCheck(
            message.fileName,
            message.languageId,
            message.code,
            message.explanation
          );
          break;
        }

        case 'cancelRequest': {
          // Requirement B.2: Cancel button / Escape pressed during loading
          if (this._currentAbortController && this._isRequestInProgress) {
            this._isUserCancelled = true;
            this._currentAbortController.abort();
          }
          break;
        }

        case 'retryLast': {
          // Requirement C.2: Retry resends exactly the last request
          if (this._isRequestInProgress || !this._lastRequest) {
            return;
          }
          await this._executePrompt(
            this._lastRequest.content,
            this._lastRequest.mode,
            this._lastRequest.hintLevel,
            true // isRetry
          );
          break;
        }

        case 'getConcepts': {
          // Requirement F.1: Fetch concepts for Progress Panel
          const concepts = getConcepts(this._globalState);
          this._postMessageToWebview({
            type: 'conceptsData',
            concepts
          });
          break;
        }

        case 'resetConcepts': {
          // Requirement F.2: Reset concepts
          await clearConcepts(this._globalState);
          this._postMessageToWebview({
            type: 'conceptsData',
            concepts: {}
          });
          break;
        }

        case 'newTask':
        case 'clearHistory': {
          // Clears conversation history, resets level to 1, and clears chat UI
          this._history = [];
          this._currentLevel = 1;
          this._currentTaskText = '';
          this._currentMode = 'task';
          this._lastRequest = null;
          this._postMessageToWebview({
            type: 'taskReset'
          });
          break;
        }

        case 'openSettings': {
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
   * Marks the learner as onboarded once their first question or action is sent.
   */
  private async _markOnboarded(): Promise<void> {
    if (!this._isOnboarded) {
      this._isOnboarded = true;
      try {
        await this._globalState.update('mentor.onboarded', true);
      } catch (err) {
        logError('Failed to persist onboarded state to globalState', err);
      }
      this._postMessageToWebview({
        type: 'onboardedStatus',
        isOnboarded: true
      });
    }
  }

  public async handlePasteEvent(payload: PasteEventPayload): Promise<void> {
    await vscode.commands.executeCommand('mentor.chat.focus');

    if (payload.action === 'explain_to_me') {
      await this._markOnboarded();
      this._postMessageToWebview({
        type: 'userMessage',
        text: 'Explaining the pasted code...'
      });

      const prompt = `Mode: explain\nFile: ${payload.fileName} (${payload.languageId})\nSelected code:\n${payload.pastedCode}`;
      await this._executePrompt(prompt, 'explain', 1);
    } else if (payload.action === 'explain_it') {
      if (!this._view || !this._isWebviewReady) {
        this._pendingPasteExplain = payload;
        return;
      }
      await this._promptPasteCheckInWebview(payload);
    }
  }

  private async _promptPasteCheckInWebview(payload: PasteEventPayload): Promise<void> {
    const lines = payload.pastedCode.split(/\r?\n/);
    let displayCode = payload.pastedCode;
    let isTruncated = false;
    if (lines.length > 120) {
      displayCode = lines.slice(0, 120).join('\n') + '\n\n// ... (pasted code truncated to 120 lines)';
      isTruncated = true;
    }

    this._postMessageToWebview({
      type: 'pasteCheckPrompt',
      fileName: payload.fileName,
      languageId: payload.languageId,
      code: payload.pastedCode,
      displayCode: displayCode,
      isTruncated: isTruncated,
      lineCount: lines.length
    });
  }

  private async _handlePasteCheck(
    fileName: string,
    languageId: string,
    code: string,
    explanation: string
  ): Promise<void> {
    this._currentMode = 'paste_check';
    await this._markOnboarded();

    this._postMessageToWebview({
      type: 'userMessage',
      text: 'Checking my understanding of the pasted code...'
    });

    const prompt = `Mode: paste_check\nFile: ${fileName} (${languageId})\nPasted code:\n${code}\nLearner's explanation:\n${explanation}`;
    await this._executePrompt(prompt, 'paste_check', 1);
  }

  public async explainSelection(fileName: string, languageId: string, selectedText: string): Promise<void> {
    const lines = selectedText.split(/\r?\n/);
    let code = selectedText;
    if (lines.length > 150) {
      code = lines.slice(0, 150).join('\n') + '\n\n// ... (selection truncated to 150 lines)';
    }

    if (!this._view || !this._isWebviewReady) {
      this._pendingExplain = { fileName, languageId, code };
      return;
    }

    await this._executeExplain(fileName, languageId, code);
  }

  private async _executeExplain(fileName: string, languageId: string, code: string): Promise<void> {
    this._currentMode = 'explain';
    await this._markOnboarded();

    this._postMessageToWebview({
      type: 'userMessage',
      text: 'Explaining your selection...'
    });

    const prompt = `Mode: explain\nFile: ${fileName} (${languageId})\nSelected code:\n${code}`;
    await this._executePrompt(prompt, 'explain', 1);
  }

  public async reviewActiveFile(editor?: vscode.TextEditor): Promise<void> {
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

    const totalLines = doc.lineCount;
    let code = doc.getText();
    if (totalLines > 300) {
      const endLine = 299;
      const endChar = doc.lineAt(endLine).text.length;
      code = doc.getText(new vscode.Range(0, 0, endLine, endChar)) + '\n\n// ... (file truncated to 300 lines)';
    }

    if (!this._view || !this._isWebviewReady) {
      this._pendingReview = { fileName, languageId, code };
      return;
    }

    await this._executeReview(fileName, languageId, code);
  }

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

  private async _executeReview(fileName: string, languageId: string, code: string): Promise<void> {
    this._currentMode = 'review';
    this._currentTaskText = `Review ${fileName}`;
    await this._markOnboarded();

    this._postMessageToWebview({
      type: 'userMessage',
      text: `Reviewing ${fileName}...`
    });

    const prompt = `Mode: review\nFile: ${fileName} (${languageId})\nCurrent file:\n${code}`;
    await this._executePrompt(prompt, 'review', 1);
  }

  private async _handleExplainBack(learnerExplanation: string): Promise<void> {
    const trimmedExplanation = (learnerExplanation || '').trim();
    if (!trimmedExplanation) {
      return;
    }

    this._currentMode = 'explain_back';
    const task = this._currentTaskText || 'Current coding task';
    await this._markOnboarded();

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

    const prompt = `Mode: explain_back\nTask: ${task}${fileSection}\nLearner's explanation:\n${trimmedExplanation}`;
    await this._executePrompt(prompt, 'explain_back', 1);
  }

  private async _handleUserAsk(userText: string, hintLevel?: number) {
    const trimmedText = userText ? userText.trim() : '';
    if (!trimmedText) {
      return;
    }

    this._currentTaskText = trimmedText;
    const requestedLevel = (hintLevel === 1 || hintLevel === 2 || hintLevel === 3 || hintLevel === 4)
      ? hintLevel
      : 1;

    // CONFIG HINT LEVEL CLAMPING (Requirement A.5)
    const effectiveMax = this._currentConfig.maxHintLevel;
    const clampedLevel = Math.min(requestedLevel, effectiveMax) as 1 | 2 | 3 | 4;
    this._currentLevel = clampedLevel;
    this._currentMode = 'task';

    const contextBlock = this._buildEditorContextBlock();

    let hintLevelLabel = `Requested hint level: ${this._currentLevel}`;
    if (this._activeConfig) {
      hintLevelLabel = `Requested hint level: ${this._currentLevel} (course maximum: ${effectiveMax})`;
    }

    let userMessageContent = `${trimmedText}\n\n${hintLevelLabel}`;
    if (contextBlock) {
      userMessageContent = `${contextBlock}\n\nLearner Question:\n${trimmedText}\n\n${hintLevelLabel}`;
    }

    await this._executePrompt(userMessageContent, 'task', clampedLevel);
  }

  private async _handleNeedMoreHelp(hintLevel?: number) {
    const taskText = this._currentTaskText.trim();
    if (!taskText) {
      return;
    }

    const effectiveMax = this._currentConfig.maxHintLevel;
    const requestedLevel = (hintLevel === 1 || hintLevel === 2 || hintLevel === 3 || hintLevel === 4)
      ? hintLevel
      : Math.min(effectiveMax, this._currentLevel + 1);

    const clampedLevel = Math.min(requestedLevel, effectiveMax) as 1 | 2 | 3 | 4;
    this._currentLevel = clampedLevel;
    this._currentMode = 'task';

    const contextBlock = this._buildEditorContextBlock();

    let hintLevelLabel = `Requested hint level: ${this._currentLevel}`;
    if (this._activeConfig) {
      hintLevelLabel = `Requested hint level: ${this._currentLevel} (course maximum: ${effectiveMax})`;
    }

    let userMessageContent = `${taskText}\n\n${hintLevelLabel}`;
    if (contextBlock) {
      userMessageContent = `${contextBlock}\n\nLearner Question:\n${taskText}\n\n${hintLevelLabel}`;
    }

    await this._executePrompt(userMessageContent, 'task', clampedLevel);
  }

  /**
   * ===========================================================================
   * SHARED PROMPT EXECUTOR: ABORT, TIMEOUT, AND ERROR MAPPING (Requirements B & C)
   * ===========================================================================
   * - Uses AbortController to support immediate user cancellation (Escape / Cancel button).
   * - Sets a 30-second timeout that aborts the fetch and shows a friendly retryable error.
   * - Prevents duplicate requests while in flight.
   * - Maps all error codes to friendly strings without raw traces or leaked credentials.
   * - Retains last request payload to enable zero-retype retry.
   */
  private async _executePrompt(
    userMessageContent: string,
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check',
    hintLevel: number,
    isRetry: boolean = false
  ): Promise<void> {
    if (!this._view) {
      return;
    }

    // Cache the request parameters for seamless Retry (Requirement C.2)
    this._lastRequest = {
      content: userMessageContent,
      mode: mode,
      hintLevel: hintLevel
    };

    // Prevent double-sends (Requirement B.4)
    this._isRequestInProgress = true;
    this._isUserCancelled = false;
    this._isTimeout = false;

    // AbortController setup (Requirement B.2)
    this._currentAbortController = new AbortController();

    // 30 second timeout timer (Requirement B.3)
    const timeoutTimer = setTimeout(() => {
      this._isTimeout = true;
      this._currentAbortController?.abort();
    }, 30000);

    // If this is a retry, show a subtle retry notice in the chat
    if (isRetry) {
      this._postMessageToWebview({
        type: 'userMessage',
        text: 'Retrying last request...'
      });
    }

    // Push into history only if not retrying an already pushed user message
    if (!isRetry) {
      this._history.push({
        role: 'user',
        content: userMessageContent
      });
    }

    this._postMessageToWebview({
      type: 'loading',
      loading: true
    });

    try {
      const rawReply = await askMentor(
        this._history,
        this._currentConfig,
        this._activeConfig,
        this._currentAbortController.signal
      );

      // Check for empty or unusable reply (Requirement C.1)
      if (!rawReply || rawReply.trim().length === 0) {
        throw new Error('EMPTY_RESPONSE');
      }

      this._history.push({
        role: 'assistant',
        content: rawReply
      });

      const structuredReply: MentorReply = parseMentorReply(rawReply);

      // Persist learned concepts in globalState
      if (Array.isArray(structuredReply.concept) && structuredReply.concept.length > 0) {
        await saveConcepts(structuredReply.concept, this._globalState);
      }

      this._postMessageToWebview({
        type: 'reply',
        data: structuredReply,
        mode: mode
      });
    } catch (error: any) {
      clearTimeout(timeoutTimer);

      // Requirement B.2: User cancellation handling
      if (this._isUserCancelled) {
        logError('Request was cancelled by learner');
        // Remove the unanswered turn so user can proceed cleanly
        if (!isRetry) {
          this._history.pop();
        }
        this._postMessageToWebview({
          type: 'requestCancelled'
        });
        return;
      }

      // =======================================================================
      // FRIENDLY ERROR MAPPING (Requirement C.1)
      // Never expose raw stack traces, API keys, or full request payloads.
      // =======================================================================
      let errorMessage = 'An unexpected error occurred. Please try again.';
      let errorAction: 'openSettings' | 'retry' | 'none' = 'none';
      let actionLabel = '';
      let retryCountdown = 0;

      const status = error?.status;
      const msg = error?.message || '';

      if (error instanceof MissingApiKeyError) {
        errorMessage = 'Add your API key to get started.';
        errorAction = 'openSettings';
        actionLabel = 'Set API key';
      } else if (
        status === 400 ||
        status === 401 ||
        status === 403 ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('API key not valid')
      ) {
        errorMessage = 'Your API key was rejected. Check that it is correct and has access to the model.';
        errorAction = 'openSettings';
        actionLabel = 'Open settings';
      } else if (
        status === 404 ||
        msg.includes('models/') ||
        (msg.includes('not found') && !msg.includes('API'))
      ) {
        errorMessage = 'The model name in settings was not found.';
        errorAction = 'openSettings';
        actionLabel = 'Open settings';
      } else if (
        status === 429 ||
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('quota')
      ) {
        errorMessage = "You're sending requests too fast or hit the free limit. Wait a minute and try again.";
        errorAction = 'retry';
        actionLabel = 'Retry';
        retryCountdown = 20; // 20s disabled countdown
      } else if (
        (status >= 500 && status < 600) ||
        msg.includes('500') ||
        msg.includes('503') ||
        msg.includes('Internal Server Error')
      ) {
        errorMessage = 'The AI service had a problem. Try again in a moment.';
        errorAction = 'retry';
        actionLabel = 'Retry';
      } else if (this._isTimeout || msg.includes('timeout') || msg.includes('timed out')) {
        errorMessage = 'That took too long.';
        errorAction = 'retry';
        actionLabel = 'Retry';
      } else if (
        error?.code === 'ENOTFOUND' ||
        error?.code === 'ECONNREFUSED' ||
        msg.includes('fetch failed') ||
        error?.name === 'APIConnectionError'
      ) {
        errorMessage = "Can't reach the AI service. Check your internet connection.";
        errorAction = 'retry';
        actionLabel = 'Retry';
      } else if (msg === 'EMPTY_RESPONSE') {
        errorMessage = "I didn't get a useful answer.";
        errorAction = 'retry';
        actionLabel = 'Retry';
      } else {
        errorMessage = 'The AI service had a problem. Try again in a moment.';
        errorAction = 'retry';
        actionLabel = 'Retry';
      }

      logError(`API call failed: ${errorMessage}`);

      // Remove last unanswered turn so chat history remains uncorrupted
      if (!isRetry && this._history.length > 0) {
        this._history.pop();
      }

      this._postMessageToWebview({
        type: 'friendlyError',
        message: errorMessage,
        action: errorAction,
        actionLabel: actionLabel,
        countdown: retryCountdown
      });
    } finally {
      clearTimeout(timeoutTimer);
      this._isRequestInProgress = false;
      this._currentAbortController = null;
      this._isTimeout = false;
      this._isUserCancelled = false;

      this._postMessageToWebview({
        type: 'loading',
        loading: false
      });
    }
  }

  private _postMessageToWebview(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _buildEditorContextBlock(): string | null {
    const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
    if (!editor || !editor.document) {
      return null;
    }

    const doc = editor.document;
    const filename = path.basename(doc.fileName);
    const languageId = doc.languageId || 'plaintext';

    let selectedCodeSection = '';
    const selection = editor.selection;
    if (selection && !selection.isEmpty) {
      const selectedText = doc.getText(selection).trim();
      if (selectedText) {
        selectedCodeSection = `Selected code:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`;
      }
    }

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

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Code Mentor</title>
  <style>
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

    /* Accessibility focus outlines */
    button:focus-visible,
    textarea:focus-visible,
    summary:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    /* Header Bar */
    .chat-header {
      display: flex;
      flex-direction: column;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.2)));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
      gap: 6px;
    }

    .header-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      gap: 4px;
      flex-wrap: wrap;
    }

    .header-actions button {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 7px;
      border-radius: 3px;
      font-family: inherit;
      transition: background 0.15s ease;
      white-space: nowrap;
    }

    .header-actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .course-badge-row {
      display: none;
    }

    .course-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
      cursor: help;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

    /* =============================================================
       ONBOARDING / WELCOME CARD (Requirement A)
       ============================================================= */
    .welcome-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 6px;
      padding: 12px 14px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .welcome-card h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, inherit);
    }

    .welcome-tagline {
      font-size: 12px;
      opacity: 0.95;
      line-height: 1.45;
    }

    .welcome-bullets {
      font-size: 11.5px;
      padding-left: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      opacity: 0.9;
    }

    .example-chips-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .example-chips-label {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.75;
    }

    .example-chips-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .prompt-chip {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-textLink-foreground, var(--vscode-button-secondaryForeground));
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      border-radius: 12px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      text-align: left;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .prompt-chip:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
      border-color: var(--vscode-focusBorder);
    }

    .welcome-privacy {
      font-size: 10.5px;
      opacity: 0.65;
      line-height: 1.35;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      padding-top: 6px;
    }

    /* Setup Box when no API Key is set */
    .setup-box {
      background: var(--vscode-inputValidation-warningBackground, rgba(255, 165, 0, 0.12));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 165, 0, 0.4));
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .setup-box-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    .setup-box-hint {
      font-size: 11.5px;
      opacity: 0.9;
      line-height: 1.4;
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

    .cancelled-note {
      font-size: 11px;
      font-style: italic;
      opacity: 0.7;
      margin-top: 3px;
      align-self: flex-end;
    }

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

    /* Structured Mentor Card */
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
      max-width: 100%;
      box-shadow: 0 1px 4px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.08));
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .mentor-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      flex-wrap: wrap;
      gap: 4px;
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

    .mentor-message-body {
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

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

    /* Review Findings */
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

    /* Explain Back & Paste Check Cards */
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

    /* Paste Check Panel */
    .paste-check-panel {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.1));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      animation: fadeIn 0.15s ease-in-out;
    }

    .paste-check-header {
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-textLink-foreground, inherit);
    }

    .pasted-code-details {
      background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.2));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 11.5px;
    }

    .pasted-code-details summary {
      cursor: pointer;
      font-weight: 500;
      opacity: 0.85;
      outline: none;
    }

    .pasted-code-details pre {
      margin-top: 6px;
      overflow-x: auto;
      max-height: 180px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.4;
    }

    textarea#paste-explain-input {
      width: 100%;
      min-height: 56px;
      max-height: 130px;
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

    .paste-check-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Code Snippet Block */
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

    /* Concept Chips */
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

    /* Friendly Error Card with Retry Button (Requirement C) */
    .error-card {
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
      border-left: 3px solid var(--vscode-errorForeground, #ff6b6b);
      color: var(--vscode-foreground);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .error-card-text {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn-action {
      align-self: flex-start;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-action:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-action:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Loading & Cancel Section (Requirement B) */
    .loading-row {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 4px;
    }

    .loading-row.visible {
      display: flex;
    }

    .loading-text-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      opacity: 0.9;
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

    .cancel-btn {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
    }

    .cancel-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
    }

    /* Reduced Motion (Requirement B.5) */
    @media (prefers-reduced-motion: reduce) {
      .dots-pulse span {
        animation: none !important;
        opacity: 0.8 !important;
        transform: none !important;
      }
      .mentor-card, .solution-confirm-banner, .paste-check-panel, .explain-back-panel {
        animation: none !important;
      }
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

    .hint-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .hint-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-button-background));
      font-weight: 600;
    }

    .hint-btn:disabled,
    .hint-btn.disabled-by-course {
      opacity: 0.45;
      cursor: not-allowed;
      border-style: dashed;
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

    /* Progress Panel (Requirement F) */
    .progress-panel {
      display: none;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 12px;
      flex-direction: column;
      gap: 10px;
    }

    .progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .progress-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 200px;
      overflow-y: auto;
    }

    .progress-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 8px;
      border-radius: 3px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.06));
      font-size: 11.5px;
    }

    .progress-item-name {
      font-weight: 500;
    }

    .progress-item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0.75;
      font-size: 10.5px;
    }

    .progress-empty-msg {
      font-style: italic;
      font-size: 11.5px;
      opacity: 0.75;
      padding: 6px 0;
    }

    .progress-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      padding-top: 6px;
    }

    .btn-reset-progress {
      background: transparent;
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      color: var(--vscode-foreground);
      font-size: 10.5px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
    }

    .btn-reset-progress:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
    }

    .reset-confirm-box {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }
  </style>
</head>
<body>

  <!-- Sidebar Header -->
  <div class="chat-header">
    <div class="header-top-row">
      <div class="header-title">
        <span>Code Mentor</span>
      </div>
      <div class="header-actions">
        <button id="progress-toggle-btn" title="View your learned concepts" aria-label="View learning progress">📊 Progress</button>
        <button id="review-code-btn" title="Review my current active file" aria-label="Review active file">🔍 Review</button>
        <button id="new-task-btn" title="Clear conversation history and reset level to 1" aria-label="Start new task">+ New task</button>
      </div>
    </div>
    <div class="course-badge-row" id="course-badge-row">
      <span class="course-badge" id="course-badge" title="Course configuration active">
        📚 Course settings active · max hint: <span id="course-max-hint-name">Solution</span>
      </span>
    </div>
  </div>

  <!-- Messages Container (Requirement D.3: role="log" and aria-live="polite") -->
  <div class="messages-container" id="messages-container" role="log" aria-live="polite">

    <!-- Progress Panel Card (Requirement F) -->
    <div class="progress-panel" id="progress-panel">
      <div class="progress-header">
        <span class="progress-title">📊 Concepts Progress</span>
        <button type="button" class="btn-close-panel" id="close-progress-btn" aria-label="Close progress panel">✕</button>
      </div>
      <div class="progress-list" id="progress-list">
        <!-- Rendered dynamically -->
      </div>
      <div class="progress-footer">
        <div class="reset-confirm-box" id="reset-confirm-box">
          <span>Clear all?</span>
          <button type="button" class="btn-action" id="confirm-reset-progress-btn">Yes, reset</button>
          <button type="button" class="cancel-btn" id="cancel-reset-progress-btn">Cancel</button>
        </div>
        <button type="button" class="btn-reset-progress" id="init-reset-progress-btn">Reset progress</button>
      </div>
    </div>

    <!-- Onboarding / Welcome Card (Requirement A) -->
    <div class="welcome-card" id="welcome-card">
      <div id="welcome-normal-content">
        <h3>👋 Welcome to Code Mentor!</h3>
        <p class="welcome-tagline">I help you learn by guiding you, not by writing everything for you.</p>
        <ul class="welcome-bullets" id="welcome-bullets">
          <li>Ask for a plan when starting a task</li>
          <li>Use the hint buttons when you're stuck</li>
          <li>Right-click selected code to have it explained</li>
        </ul>
        <div class="example-chips-container">
          <span class="example-chips-label">Try asking:</span>
          <div class="example-chips-list">
            <button type="button" class="prompt-chip" data-prompt="Build a responsive navbar">Build a responsive navbar</button>
            <button type="button" class="prompt-chip" data-prompt="Make a card with an image and title">Make a card with an image and title</button>
            <button type="button" class="prompt-chip" data-prompt="Explain the code I selected">Explain the code I selected</button>
          </div>
        </div>
        <div class="welcome-privacy">Your current file and selected code are sent to your AI provider to generate replies.</div>
      </div>

      <!-- Setup Box when no API Key is set (Requirement A.2) -->
      <div class="setup-box" id="welcome-setup-box" style="display: none;">
        <div class="setup-box-title">🔑 Set Up Your Gemini API Key</div>
        <div class="setup-box-hint">Get a free API key at Google AI Studio (<a href="https://aistudio.google.com" style="color: inherit;">aistudio.google.com</a>) to begin chatting with your mentor.</div>
        <button type="button" class="btn-action" id="welcome-set-key-btn">Set API key</button>
      </div>
    </div>

  </div>

  <!-- Loading & Cancel Indicator (Requirement B.1 & B.2) -->
  <div class="loading-row" id="loading-row">
    <div class="loading-text-group">
      <div class="dots-pulse" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Mentor is thinking...</span>
    </div>
    <button type="button" class="cancel-btn" id="cancel-request-btn" aria-label="Cancel thinking request">Cancel (Esc)</button>
  </div>

  <!-- Chat Footer -->
  <div class="chat-footer">
    <!-- Explain It Back Section -->
    <div class="explain-back-section" id="explain-back-section" style="display: none;">
      <button type="button" class="finish-feature-btn" id="finish-feature-btn">
        <span>✓ I finished this feature</span>
      </button>
      <div class="explain-back-panel" id="explain-back-panel" style="display: none;">
        <div class="explain-back-panel-header">
          <span>Explain in your own words how this works</span>
          <button type="button" class="btn-close-panel" id="close-explain-panel" aria-label="Close panel">✕</button>
        </div>
        <textarea id="explain-back-input" placeholder="Explain in your own words how this works..."></textarea>
        <div class="explain-back-panel-footer">
          <span class="char-count" id="explain-char-count">0 / 15 chars min</span>
          <button type="button" class="btn-submit-explain" id="submit-explain-btn" disabled>Submit</button>
        </div>
      </div>
    </div>

    <!-- Hint Ladder Section (Requirement D.2: aria-pressed) -->
    <div class="hint-ladder-container">
      <div class="solution-confirm-banner" id="solution-confirm" style="display: none;">
        <div class="solution-confirm-text">Want to try the Structure hint first?</div>
        <div class="solution-confirm-actions">
          <button type="button" class="btn-confirm-action" id="confirm-structure-btn">Try Structure</button>
          <button type="button" class="btn-confirm-action btn-confirm-secondary" id="confirm-solution-btn">Show solution anyway</button>
        </div>
      </div>

      <div class="hint-buttons-row">
        <button type="button" class="hint-btn active" data-level="1" id="hint-btn-1" aria-pressed="true" title="Level 1: Nudge (gentle direction, no code)">Nudge (1)</button>
        <button type="button" class="hint-btn" data-level="2" id="hint-btn-2" aria-pressed="false" title="Level 2: Hint (idea and what to look for)">Hint (2)</button>
        <button type="button" class="hint-btn" data-level="3" id="hint-btn-3" aria-pressed="false" title="Level 3: Structure (outline, skeleton)">Structure (3)</button>
        <button type="button" class="hint-btn" data-level="4" id="hint-btn-4" aria-pressed="false" title="Level 4: Solution (full working code)">Solution (4)</button>
      </div>
    </div>

    <!-- User Input Wrapper -->
    <div class="input-wrapper">
      <textarea id="user-input" placeholder="Ask your mentor a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-controls">
        <span class="hint-label">Editor context included</span>
        <button id="send-btn" aria-label="Send message">Send</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const messagesContainer = document.getElementById('messages-container');
    const welcomeCard = document.getElementById('welcome-card');
    const welcomeNormalContent = document.getElementById('welcome-normal-content');
    const welcomeBullets = document.getElementById('welcome-bullets');
    const welcomeSetupBox = document.getElementById('welcome-setup-box');
    const welcomeSetKeyBtn = document.getElementById('welcome-set-key-btn');

    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const loadingRow = document.getElementById('loading-row');
    const cancelRequestBtn = document.getElementById('cancel-request-btn');
    const newTaskBtn = document.getElementById('new-task-btn');
    const reviewCodeBtn = document.getElementById('review-code-btn');

    // Progress elements
    const progressToggleBtn = document.getElementById('progress-toggle-btn');
    const progressPanel = document.getElementById('progress-panel');
    const closeProgressBtn = document.getElementById('close-progress-btn');
    const progressList = document.getElementById('progress-list');
    const initResetProgressBtn = document.getElementById('init-reset-progress-btn');
    const resetConfirmBox = document.getElementById('reset-confirm-box');
    const confirmResetProgressBtn = document.getElementById('confirm-reset-progress-btn');
    const cancelResetProgressBtn = document.getElementById('cancel-reset-progress-btn');

    // Course settings elements
    const courseBadgeRow = document.getElementById('course-badge-row');
    const courseBadge = document.getElementById('course-badge');
    const courseMaxHintName = document.getElementById('course-max-hint-name');

    // Explain It Back elements
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
    let maxAllowedHintLevel = 4;
    let isCourseActive = false;
    let isLoading = false;
    let hasApiKey = false;
    let isOnboarded = false;
    let hasReplies = false;

    // Notify extension host that webview is ready
    vscode.postMessage({ type: 'ready' });

    // -------------------------------------------------------------------------
    // ONBOARDING & SETUP CARDS (Requirement A)
    // -------------------------------------------------------------------------
    function updateWelcomeCardUI() {
      if (!welcomeCard) return;

      if (!hasApiKey) {
        // Show setup box in place of actions if API key is not configured
        if (welcomeNormalContent) welcomeNormalContent.style.display = 'none';
        if (welcomeSetupBox) welcomeSetupBox.style.display = 'flex';
      } else {
        // Normal welcome card
        if (welcomeSetupBox) welcomeSetupBox.style.display = 'none';
        if (welcomeNormalContent) welcomeNormalContent.style.display = 'block';

        // Requirement A.3: Short version if already onboarded
        if (isOnboarded && welcomeBullets) {
          welcomeBullets.style.display = 'none';
        } else if (welcomeBullets) {
          welcomeBullets.style.display = 'flex';
        }
      }
    }

    if (welcomeSetKeyBtn) {
      welcomeSetKeyBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openSettings' });
      });
    }

    // Example prompt chips: clicking fills input without sending (Requirement A.1)
    document.querySelectorAll('.prompt-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        const promptText = chip.getAttribute('data-prompt') || chip.textContent;
        userInput.value = promptText;
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
        userInput.focus();
      });
    });

    // -------------------------------------------------------------------------
    // INSTRUCTOR CONFIGURATION (Requirement A.6)
    // -------------------------------------------------------------------------
    function applyConfig(config, active) {
      isCourseActive = active;
      maxAllowedHintLevel = (config && config.maxHintLevel) ? config.maxHintLevel : 4;

      if (active && courseBadgeRow && courseBadge) {
        courseBadgeRow.style.display = 'block';
        if (courseMaxHintName) {
          courseMaxHintName.textContent = getHintName(maxAllowedHintLevel);
        }

        let tooltip = 'Instructor Settings (.mentor.json)\\n' +
                      'Mode: ' + config.mode + '\\n' +
                      'Max hint level: ' + maxAllowedHintLevel + ' (' + getHintName(maxAllowedHintLevel) + ')';
        if (Array.isArray(config.learningObjectives) && config.learningObjectives.length > 0) {
          tooltip += '\\n\\nLearning objectives:\\n';
          config.learningObjectives.forEach(function(obj) {
            tooltip += '• ' + obj + '\\n';
          });
        }
        courseBadge.title = tooltip.trim();
      } else if (courseBadgeRow) {
        courseBadgeRow.style.display = 'none';
      }

      for (let i = 1; i <= 4; i++) {
        const btn = hintBtns[i];
        if (btn) {
          if (i > maxAllowedHintLevel) {
            btn.disabled = true;
            btn.title = "Limited by your instructor's .mentor.json";
            btn.classList.add('disabled-by-course');
          } else {
            btn.disabled = false;
            btn.title = 'Level ' + i + ': ' + getHintName(i) + ' ' + getHintDescription(i);
            btn.classList.remove('disabled-by-course');
          }
        }
      }

      if (currentHintLevel > maxAllowedHintLevel) {
        selectHintLevel(maxAllowedHintLevel);
      }
    }

    function selectHintLevel(level) {
      currentHintLevel = Math.min(level, maxAllowedHintLevel);
      for (let i = 1; i <= 4; i++) {
        if (hintBtns[i]) {
          const isActive = (i === currentHintLevel);
          if (isActive) {
            hintBtns[i].classList.add('active');
            hintBtns[i].setAttribute('aria-pressed', 'true');
          } else {
            hintBtns[i].classList.remove('active');
            hintBtns[i].setAttribute('aria-pressed', 'false');
          }
        }
      }
    }

    function showSolutionConfirmation() {
      if (maxAllowedHintLevel >= 4 && solutionConfirmBanner) {
        solutionConfirmBanner.style.display = 'flex';
      }
    }

    function hideSolutionConfirmation() {
      if (solutionConfirmBanner) {
        solutionConfirmBanner.style.display = 'none';
      }
    }

    function handleHintBtnClick(level) {
      if (level > maxAllowedHintLevel || isLoading) {
        return;
      }
      if (level === 4 && currentHintLevel < 3 && maxAllowedHintLevel >= 4) {
        showSolutionConfirmation();
        return;
      }
      hideSolutionConfirmation();
      selectHintLevel(level);
    }

    [1, 2, 3, 4].forEach(function(lvl) {
      if (hintBtns[lvl]) {
        hintBtns[lvl].addEventListener('click', function() {
          handleHintBtnClick(lvl);
        });
      }
    });

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
    // PROGRESS PANEL (Requirement F)
    // -------------------------------------------------------------------------
    if (progressToggleBtn) {
      progressToggleBtn.addEventListener('click', function() {
        const isVisible = (progressPanel.style.display === 'flex');
        if (isVisible) {
          progressPanel.style.display = 'none';
        } else {
          progressPanel.style.display = 'flex';
          vscode.postMessage({ type: 'getConcepts' });
        }
      });
    }

    if (closeProgressBtn) {
      closeProgressBtn.addEventListener('click', function() {
        progressPanel.style.display = 'none';
      });
    }

    if (initResetProgressBtn) {
      initResetProgressBtn.addEventListener('click', function() {
        initResetProgressBtn.style.display = 'none';
        resetConfirmBox.style.display = 'flex';
      });
    }

    if (cancelResetProgressBtn) {
      cancelResetProgressBtn.addEventListener('click', function() {
        resetConfirmBox.style.display = 'none';
        initResetProgressBtn.style.display = 'inline-block';
      });
    }

    if (confirmResetProgressBtn) {
      confirmResetProgressBtn.addEventListener('click', function() {
        resetConfirmBox.style.display = 'none';
        initResetProgressBtn.style.display = 'inline-block';
        vscode.postMessage({ type: 'resetConcepts' });
      });
    }

    function renderProgressList(concepts) {
      progressList.innerHTML = '';
      const entries = Object.entries(concepts || {});

      if (entries.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'progress-empty-msg';
        emptyEl.textContent = 'Concepts you learn will appear here.';
        progressList.appendChild(emptyEl);
        return;
      }

      // Sort by most recent
      entries.sort(function(a, b) {
        const dateA = a[1].lastSeen || '';
        const dateB = b[1].lastSeen || '';
        return dateB.localeCompare(dateA);
      });

      entries.forEach(function(item) {
        const name = item[0];
        const data = item[1];

        const row = document.createElement('div');
        row.className = 'progress-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'progress-item-name';
        nameSpan.textContent = name;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'progress-item-meta';

        const countSpan = document.createElement('span');
        countSpan.textContent = data.count + 'x';

        const dateSpan = document.createElement('span');
        let dateFormatted = '';
        if (data.lastSeen) {
          try {
            dateFormatted = new Date(data.lastSeen).toLocaleDateString();
          } catch {
            dateFormatted = data.lastSeen.slice(0, 10);
          }
        }
        dateSpan.textContent = dateFormatted;

        metaSpan.appendChild(countSpan);
        metaSpan.appendChild(dateSpan);

        row.appendChild(nameSpan);
        row.appendChild(metaSpan);

        progressList.appendChild(row);
      });
    }

    // -------------------------------------------------------------------------
    // HEADER & EXPLAIN BACK ACTIONS
    // -------------------------------------------------------------------------
    if (reviewCodeBtn) {
      reviewCodeBtn.addEventListener('click', function() {
        if (isLoading) return;
        vscode.postMessage({ type: 'reviewFile' });
      });
    }

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

    if (submitExplainBtn) {
      submitExplainBtn.addEventListener('click', function() {
        const text = explainBackInput.value.trim();
        if (text.length < 15 || isLoading) return;

        explainBackPanel.style.display = 'none';
        finishFeatureBtn.style.display = 'inline-flex';
        explainBackInput.value = '';
        submitExplainBtn.disabled = true;
        if (explainCharCount) {
          explainCharCount.textContent = '0 / 15 chars min';
        }

        appendUserMessage('Explaining my understanding:\\n' + text);

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

      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      appendUserMessage(text);

      vscode.postMessage({
        type: 'ask',
        text: text,
        hintLevel: currentHintLevel
      });

      userInput.value = '';
      userInput.style.height = 'auto';
    }

    sendBtn.addEventListener('click', sendMessage);

    // Keyboard handlers (Requirement D.4: Enter sends, Shift+Enter newline, Escape cancels)
    userInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isLoading) {
        e.preventDefault();
        vscode.postMessage({ type: 'cancelRequest' });
      }
    });

    if (cancelRequestBtn) {
      cancelRequestBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancelRequest' });
      });
    }

    userInput.addEventListener('input', function() {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
    });

    newTaskBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'newTask' });
    });

    // -------------------------------------------------------------------------
    // INCOMING: Receiving messages from Extension Host in the Webview
    // -------------------------------------------------------------------------
    window.addEventListener('message', function(event) {
      const message = event.data;

      switch (message.type) {
        case 'apiKeyStatus': {
          hasApiKey = message.hasApiKey;
          updateWelcomeCardUI();
          break;
        }

        case 'onboardedStatus': {
          isOnboarded = message.isOnboarded;
          updateWelcomeCardUI();
          break;
        }

        case 'config': {
          applyConfig(message.config, message.active);
          break;
        }

        case 'reply': {
          renderMentorReplyCard(message.data, message.mode);
          break;
        }

        case 'userMessage': {
          appendUserMessage(message.text);
          break;
        }

        case 'noticeMessage': {
          appendNoticeMessage(message.text);
          break;
        }

        case 'requestCancelled': {
          // Leaves learner's message with a subtle note "Request cancelled." (Requirement B.2)
          appendCancelledNote();
          break;
        }

        case 'friendlyError': {
          // Requirement C.1: Friendly error card with retry / settings button
          renderFriendlyErrorCard(message);
          break;
        }

        case 'conceptsData': {
          renderProgressList(message.concepts);
          break;
        }

        case 'pasteCheckPrompt': {
          renderPasteCheckPrompt(message);
          break;
        }

        case 'loading': {
          setLoading(message.loading);
          break;
        }

        case 'taskReset':
        case 'historyCleared': {
          messagesContainer.innerHTML = '';
          if (progressPanel) {
            progressPanel.style.display = 'none';
            messagesContainer.appendChild(progressPanel);
          }
          if (welcomeCard) {
            welcomeCard.style.display = 'flex';
            messagesContainer.appendChild(welcomeCard);
            updateWelcomeCardUI();
          }
          selectHintLevel(1);
          hideSolutionConfirmation();
          userInput.value = '';
          userInput.style.height = 'auto';

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
    // RENDERING FUNCTIONS
    // -------------------------------------------------------------------------
    function setLoading(loading) {
      isLoading = loading;
      sendBtn.disabled = loading;

      // Disable hint buttons during loading (Requirement B.1)
      for (let i = 1; i <= 4; i++) {
        if (hintBtns[i]) {
          hintBtns[i].disabled = loading || (i > maxAllowedHintLevel);
        }
      }

      // Keep textarea usable (userInput is NOT disabled)
      if (loading) {
        loadingRow.classList.add('visible');
        scrollToBottom(false);
      } else {
        loadingRow.classList.remove('visible');
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
      bubble.textContent = text;

      row.appendChild(bubble);
      messagesContainer.appendChild(row);
      scrollToBottom(true);
    }

    function appendCancelledNote() {
      const note = document.createElement('div');
      note.className = 'cancelled-note';
      note.textContent = 'Request cancelled.';
      messagesContainer.appendChild(note);
      scrollToBottom(true);
    }

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
      scrollToBottom(true);
    }

    /**
     * Requirement C.1: Friendly error card with retry/countdown/settings.
     */
    function renderFriendlyErrorCard(data) {
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row';

      const card = document.createElement('div');
      card.className = 'error-card';

      const textEl = document.createElement('div');
      textEl.className = 'error-card-text';
      textEl.textContent = '⚠️ ' + data.message;
      card.appendChild(textEl);

      if (data.action === 'openSettings') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-action';
        btn.textContent = data.actionLabel || 'Open settings';
        btn.addEventListener('click', function() {
          vscode.postMessage({ type: 'openSettings' });
        });
        card.appendChild(btn);
      } else if (data.action === 'retry') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-action';

        if (data.countdown && data.countdown > 0) {
          let remaining = data.countdown;
          btn.disabled = true;
          btn.textContent = 'Retry (' + remaining + 's)';

          const timer = setInterval(function() {
            remaining--;
            if (remaining > 0) {
              btn.textContent = 'Retry (' + remaining + 's)';
            } else {
              clearInterval(timer);
              btn.disabled = false;
              btn.textContent = 'Retry';
            }
          }, 1000);
        } else {
          btn.textContent = 'Retry';
        }

        btn.addEventListener('click', function() {
          btn.disabled = true;
          vscode.postMessage({ type: 'retryLast' });
        });

        card.appendChild(btn);
      }

      row.appendChild(card);
      messagesContainer.appendChild(row);
      scrollToBottom(true);
    }

    function renderPasteCheckPrompt(data) {
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const panel = document.createElement('div');
      panel.className = 'paste-check-panel';

      const header = document.createElement('div');
      header.className = 'paste-check-header';
      header.textContent = '📋 Big paste detected (' + (data.lineCount || 'several') + ' lines)';
      panel.appendChild(header);

      const details = document.createElement('details');
      details.className = 'pasted-code-details';

      const summary = document.createElement('summary');
      summary.textContent = 'View pasted code in ' + data.fileName + ' (' + (data.isTruncated ? 'first 120 lines' : data.lineCount + ' lines') + ')';
      details.appendChild(summary);

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = data.displayCode || data.code;
      pre.appendChild(code);
      details.appendChild(pre);
      panel.appendChild(details);

      const textarea = document.createElement('textarea');
      textarea.id = 'paste-explain-input';
      textarea.placeholder = 'In your own words, what does this code do?';
      panel.appendChild(textarea);

      const footer = document.createElement('div');
      footer.className = 'paste-check-footer';

      const charCount = document.createElement('span');
      charCount.className = 'char-count';
      charCount.textContent = '0 / 15 chars min';
      footer.appendChild(charCount);

      const submitBtn = document.createElement('button');
      submitBtn.className = 'btn-submit-explain';
      submitBtn.textContent = 'Submit Explanation';
      submitBtn.disabled = true;
      footer.appendChild(submitBtn);

      panel.appendChild(footer);

      textarea.addEventListener('input', function() {
        const text = textarea.value.trim();
        const len = text.length;
        charCount.textContent = len + ' / 15 chars min';
        submitBtn.disabled = len < 15;
      });

      submitBtn.addEventListener('click', function() {
        const text = textarea.value.trim();
        if (text.length < 15 || isLoading) return;

        panel.style.display = 'none';
        appendUserMessage('Explaining my understanding of pasted code:\\n' + text);

        vscode.postMessage({
          type: 'submitPasteCheck',
          fileName: data.fileName,
          languageId: data.languageId,
          code: data.code,
          explanation: text
        });
      });

      row.appendChild(panel);
      messagesContainer.appendChild(row);
      scrollToBottom(true);
      textarea.focus();
    }

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

      hasReplies = true;
      if (explainBackSection) {
        explainBackSection.style.display = 'block';
      }

      const isExplainMode = (mode === 'explain');
      const isReviewMode = (mode === 'review');
      const isExplainBackMode = (mode === 'explain_back');
      const isPasteCheckMode = (mode === 'paste_check');
      const hideLadderControls = isExplainMode || isReviewMode || isExplainBackMode || isPasteCheckMode;

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'mentor-card';

      // 1. Header
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
      } else if (isExplainBackMode || isPasteCheckMode) {
        iconSpan.textContent = '🎯';
        nameSpan.textContent = 'Code Mentor (Understanding Check)';
      } else {
        iconSpan.textContent = '🎓';
        nameSpan.textContent = 'Code Mentor';
      }

      titleGroup.appendChild(iconSpan);
      titleGroup.appendChild(nameSpan);
      header.appendChild(titleGroup);

      if (!hideLadderControls) {
        const hintBadge = document.createElement('span');
        hintBadge.className = 'hint-badge';
        const level = reply.hint_level || 1;
        hintBadge.textContent = 'Hint level: ' + level + '/4';
        hintBadge.title = getHintDescription(level);
        header.appendChild(hintBadge);
      }

      card.appendChild(header);

      // 2. Message explanation
      if (reply.message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'mentor-message-body';
        messageEl.textContent = reply.message;
        card.appendChild(messageEl);
      }

      // 3. Line notes
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

      // 4. Review findings
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

            if (item.area && item.area.trim()) {
              const areaEl = document.createElement('div');
              areaEl.className = 'finding-area';
              areaEl.textContent = item.area.trim();
              itemCard.appendChild(areaEl);
            }

            if (item.observation && item.observation.trim()) {
              const obsEl = document.createElement('div');
              obsEl.className = 'finding-observation';
              obsEl.textContent = item.observation.trim();
              itemCard.appendChild(obsEl);
            }

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

      // 5. Explain Back & Paste Check assessment
      const hasExplainBackData = reply.understanding ||
        (Array.isArray(reply.got_right) && reply.got_right.length > 0) ||
        (Array.isArray(reply.gaps) && reply.gaps.length > 0);

      if (hasExplainBackData) {
        const evalContainer = document.createElement('div');
        evalContainer.className = 'explain-back-container';

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

      // 6. Guiding question
      if (reply.question && reply.question.trim()) {
        const questionBox = document.createElement('div');
        questionBox.className = 'mentor-question-box';

        const questionEm = document.createElement('em');
        questionEm.textContent = reply.question.trim();

        questionBox.appendChild(questionEm);
        card.appendChild(questionBox);
      }

      // 7. "Your next step" box
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

      // 8. Code snippet block
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
        copyBtn.setAttribute('aria-label', 'Copy code snippet to clipboard');

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

      // 9. Concept chips
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
      if (!hideLadderControls) {
        const replyLevel = reply.hint_level || currentHintLevel || 1;
        if (replyLevel < maxAllowedHintLevel) {
          const nextLevel = replyLevel + 1;
          const needHelpBtn = document.createElement('button');
          needHelpBtn.className = 'need-help-btn';
          needHelpBtn.textContent = '💡 Need more help? (' + getHintName(nextLevel) + ')';
          needHelpBtn.title = 'Move up to hint level ' + nextLevel + ' (' + getHintName(nextLevel) + ') and re-ask';

          needHelpBtn.addEventListener('click', function() {
            needHelpBtn.disabled = true;
            selectHintLevel(nextLevel);
            appendUserMessage('Need more help (' + getHintName(nextLevel) + ' ' + nextLevel + ')');
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
      scrollToBottom(false);
    }

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
        // silent
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

    // Requirement D.7: Smart scroll that does not jump if user scrolled up
    function scrollToBottom(force) {
      const threshold = 100;
      const isNearBottom = (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) <= threshold;
      if (force || isNearBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }
  </script>
</body>
</html>`;
  }
}
