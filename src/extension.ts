import * as vscode from 'vscode';
import * as path from 'path';
import {
  askMentor,
  parseMentorReply,
  ChatMessage,
  MentorReply,
  LineNote,
  ReviewFinding,
  QuizQuestion,
  MissingApiKeyError,
  testApiConnection,
  DEFAULT_MODEL,
  getResolvedModel,
  getResolvedFallbackModel
} from './llm';
import {
  initProgress,
  saveConcepts,
  getConcepts,
  clearConcepts,
  recordQuizResult,
  getQuizResults,
  QuizResult
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
import {
  Session,
  StoredMessage,
  getAllSessions,
  getSessionById,
  getActiveSession,
  setActiveSessionId,
  createNewSession,
  generateSessionId,
  saveSession,
  deleteSession,
  clearAllSessions,
  getMostRecentSession,
  formatRelativeDate,
  extractSessionConcepts
} from './sessions';

/**
 * Returns the human-friendly name for a hint level (1: Nudge, 2: Hint, 3: Structure, 4: Solution).
 */
function getHintName(level: number): string {
  switch (level) {
    case 1: return 'Nudge';
    case 2: return 'Hint';
    case 3: return 'Structure';
    case 4: return 'Solution';
    default: return `Level ${level}`;
  }
}

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
    // Sanitize any accidental API key patterns (AIza..., AQ...)
    detail = detail
      .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
      .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]');
  }
  logChannel.appendLine(`[${timestamp}] ERROR: ${message} ${detail}`.trim());
}

/**
 * Logs API errors to the "Code Mentor" output channel according to Requirement 2:
 * Includes HTTP status, model name used, request mode, and the first 300 characters
 * of the error body (strictly sanitized so API keys are never leaked).
 */
function logApiError(
  status: number | string | undefined,
  modelName: string,
  mode: string,
  error: any
): void {
  const timestamp = new Date().toISOString();
  let body = '';
  if (error?.message) {
    body = error.message;
  } else if (error?.errorDetails) {
    body = typeof error.errorDetails === 'string'
      ? error.errorDetails
      : JSON.stringify(error.errorDetails);
  } else {
    body = String(error || '');
  }

  // Redact potential API keys or secrets (AIza, sk-, AQ., or key= in URLs)
  body = body
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
    .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');

  const truncatedBody = body.slice(0, 300);
  const statusStr = status !== undefined && status !== null ? String(status) : 'unknown';

  logChannel.appendLine(
    `[${timestamp}] API ERROR: status=${statusStr}, model=${modelName}, mode=${mode}, body=${truncatedBody}`
  );
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
            logApiError(res.status, res.modelUsed, 'testConnection', res.errorBody || res.message);
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

  // Requirement 8: "Mentor: Resume Last Session" command
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.resumeLastSession', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.resumeLastSession();
    })
  );

  // Requirement 8: "Mentor: Show Chat History" command
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.showHistory', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.showHistory();
    })
  );

  // Quick Quiz command (Requirement 1): "Mentor: Quiz Me"
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.startQuiz', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.startQuiz();
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
  private _currentMode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' | 'quiz' = 'task';

  // Persistent session management (Requirements 1, 3, 5)
  private _activeSession: Session | null = null;
  private _pendingLearnerVisibleText: string | null = null;
  private _pendingShowHistory: boolean = false;
  private _pendingResumeLastSession: boolean = false;

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
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' | 'quiz';
    hintLevel: number;
    learnerVisibleText?: string;
  } | null = null;

  // Webview lifecycle readiness and queued pending requests
  private _isWebviewReady: boolean = false;
  private _pendingExplain: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingReview: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingPasteExplain: PasteEventPayload | null = null;
  private _pendingStartQuiz: { forceIntermediate?: boolean } | null = null;
  private _pastQuizQuestions: string[] = [];
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

    // Load active session from globalState if present (Requirements 1, 5)
    try {
      this._activeSession = getActiveSession(this._globalState);
      if (this._activeSession) {
        // Clamp restored hint level to config if active (Requirement 9)
        const effectiveMax = this._currentConfig.maxHintLevel;
        this._currentLevel = Math.min(this._activeSession.hintLevel || 1, effectiveMax) as 1 | 2 | 3 | 4;
        this._currentTaskText = this._activeSession.originalTask || '';

        // Rebuild in-memory LLM history from session.messages (Requirement 5)
        this._history = this._activeSession.messages.map(m => ({
          role: m.role,
          content: m.text
        }));

        // Restore mode
        if (this._activeSession.messages.length > 0) {
          const lastMode = this._activeSession.messages[this._activeSession.messages.length - 1].mode;
          if (lastMode === 'explain' || lastMode === 'review' || lastMode === 'explain_back' || lastMode === 'paste_check') {
            this._currentMode = lastMode;
          } else {
            this._currentMode = 'task';
          }
        }
      }
    } catch (err) {
      console.error('Code Mentor: Failed to load active session during provider construction:', err);
    }
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

          // Check command queues first (Requirement 8 & Quick Quiz Entry Point)
          if (this._pendingStartQuiz) {
            const pending = this._pendingStartQuiz;
            this._pendingStartQuiz = null;
            await this.startQuiz(pending.forceIntermediate);
          } else if (this._pendingResumeLastSession) {
            this._pendingResumeLastSession = false;
            await this.resumeLastSession();
          } else if (this._pendingShowHistory) {
            this._pendingShowHistory = false;
            await this.showHistory();
          } else if (this._pendingNotice) {
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
          } else if (this._activeSession && this._activeSession.messages.length > 0) {
            // Restore active session to webview (Requirement 5)
            const effectiveMax = this._currentConfig.maxHintLevel;
            this._activeSession.hintLevel = Math.min(this._activeSession.hintLevel, effectiveMax) as 1 | 2 | 3 | 4;
            this._currentLevel = this._activeSession.hintLevel;
            this._postMessageToWebview({
              type: 'restore',
              session: this._activeSession
            });
          } else {
            // Empty chat: check if past session exists for Welcome Continue Card (Requirement 7)
            this._checkAndPostWelcomeContinueCard();
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

        case 'startQuiz': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this.startQuiz(Boolean(message.forceIntermediate));
          break;
        }

        case 'quizCompleted': {
          if (message.result) {
            await this._handleQuizCompleted(message.result);
          }
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
          if (this._lastRequest.mode === 'quiz') {
            await this._executeQuizPrompt(
              this._lastRequest.content,
              'beginner',
              this._lastRequest.learnerVisibleText,
              true // isRetry
            );
          } else {
            await this._executePrompt(
              this._lastRequest.content,
              this._lastRequest.mode,
              this._lastRequest.hintLevel,
              true, // isRetry
              this._lastRequest.learnerVisibleText
            );
          }
          break;
        }

        case 'getSessions': {
          // Requirement 6: Provide list of past sessions to History panel
          this._postSessionsList();
          break;
        }

        case 'resumeSession': {
          // Requirement 6: Resume a specific session by ID
          if (message.sessionId) {
            await this.resumeSessionById(message.sessionId);
          }
          break;
        }

        case 'deleteSession': {
          // Requirement 6: Delete a session by ID
          if (message.sessionId) {
            await deleteSession(this._globalState, message.sessionId);
            if (this._activeSession && this._activeSession.id === message.sessionId) {
              this._activeSession = null;
              this._history = [];
              this._currentLevel = 1;
              this._currentTaskText = '';
              this._currentMode = 'task';
              this._lastRequest = null;
              this._postMessageToWebview({ type: 'taskReset' });
              this._checkAndPostWelcomeContinueCard();
            }
            this._postSessionsList();
          }
          break;
        }

        case 'clearAllSessions': {
          // Requirement 6: Clear all sessions
          await clearAllSessions(this._globalState);
          this._activeSession = null;
          this._history = [];
          this._currentLevel = 1;
          this._currentTaskText = '';
          this._currentMode = 'task';
          this._lastRequest = null;
          this._postMessageToWebview({ type: 'taskReset' });
          this._postSessionsList();
          break;
        }

        case 'hintLevelChanged': {
          // Requirement 3: Autosave on hint level change
          const lvl = (message.level === 1 || message.level === 2 || message.level === 3 || message.level === 4)
            ? message.level
            : 1;
          this._currentLevel = lvl;
          if (this._activeSession) {
            this._activeSession.hintLevel = lvl;
            await saveSession(this._globalState, this._activeSession);
          }
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
          // Requirement 4: Save current session first, then start fresh empty session, reset level to 1, clear chat UI
          if (this._activeSession && this._activeSession.messages.length > 0) {
            await saveSession(this._globalState, this._activeSession);
          }
          this._activeSession = null;
          await setActiveSessionId(this._globalState, null);
          this._history = [];
          this._currentLevel = 1;
          this._currentTaskText = '';
          this._currentMode = 'task';
          this._lastRequest = null;
          this._postMessageToWebview({
            type: 'taskReset'
          });
          this._checkAndPostWelcomeContinueCard();
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
      await this._executePrompt(prompt, 'explain', 1, false, 'Explaining the pasted code...');
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
    await this._executePrompt(
      prompt,
      'paste_check',
      1,
      false,
      explanation ? `Checking understanding of pasted code: ${explanation}` : 'Checking my understanding of the pasted code...'
    );
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
    await this._executePrompt(prompt, 'explain', 1, false, 'Explaining your selection...');
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
    await this._executePrompt(prompt, 'review', 1, false, `Reviewing ${fileName}...`);
  }

  /**
   * ===========================================================================
   * QUICK QUIZ: ENTRY POINT & QUESTION GENERATION (Requirements 1, 2, 4)
   * ===========================================================================
   * Initiates a 3-question multiple-choice quiz based on the learner's active
   * session concepts and currently open file code.
   *
   * @param forceIntermediate - Set to true when learner requests "Want something harder?" (3/3 score)
   */
  public async startQuiz(forceIntermediate: boolean = false): Promise<void> {
    if (this._isRequestInProgress) {
      return;
    }

    if (!this._view || !this._isWebviewReady) {
      this._pendingStartQuiz = { forceIntermediate };
      return;
    }

    await this._markOnboarded();

    // 1. Session check: if no mentor replies and no active file, show in-chat notice and do NOT call LLM
    const hasMentorReplies = this._history.some(m => m.role === 'assistant') ||
      (this._activeSession?.messages?.some(m => m.role === 'assistant') ?? false);

    const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
    const hasActiveFile = Boolean(editor && editor.document && editor.document.getText().trim().length > 0);

    if (!hasMentorReplies && !hasActiveFile) {
      this._postMessageToWebview({
        type: 'noticeMessage',
        text: 'Learn or build something first, then I can quiz you on it'
      });
      return;
    }

    // 2. Extract concepts so far: unique concept names from this session's assistant replies (max 10)
    const conceptsSet = new Set<string>();
    const sessionMessages = this._activeSession?.messages || [];
    for (const msg of sessionMessages) {
      if (msg.role === 'assistant' && msg.text && msg.mode !== 'quiz') {
        try {
          const parsed = parseMentorReply(msg.text);
          if (Array.isArray(parsed.concept)) {
            for (const c of parsed.concept) {
              const clean = (c || '').trim();
              if (clean) conceptsSet.add(clean);
            }
          }
        } catch {
          // Ignore parse errors on stored turns
        }
      }
    }
    for (const msg of this._history) {
      if (msg.role === 'assistant' && msg.content) {
        try {
          const parsed = parseMentorReply(msg.content);
          if (Array.isArray(parsed.concept)) {
            for (const c of parsed.concept) {
              const clean = (c || '').trim();
              if (clean) conceptsSet.add(clean);
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    const conceptsList = Array.from(conceptsSet).slice(0, 10);

    // 3. Current file read at click time, truncated to ~300 lines or 'none'
    let fileSection = 'none';
    let fileName = '';
    if (editor && editor.document) {
      const doc = editor.document;
      const fullText = doc.getText().trim();
      fileName = path.basename(doc.fileName);
      if (fullText) {
        const totalLines = doc.lineCount;
        let code = doc.getText();
        if (totalLines > 300) {
          const endLine = 299;
          const endChar = doc.lineAt(endLine).text.length;
          code = doc.getText(new vscode.Range(0, 0, endLine, endChar)) + '\n\n// ... (file truncated to 300 lines)';
        }
        fileSection = code;
      }
    }

    // 4. Learner-side line in the chat: "Starting a quiz on <concept names or file name>..."
    let quizTopic = '';
    if (conceptsList.length > 0) {
      quizTopic = conceptsList.slice(0, 3).join(', ');
    } else if (fileName) {
      quizTopic = fileName;
    } else {
      quizTopic = 'your code';
    }
    const learnerVisibleText = `Starting a quiz on ${quizTopic}...`;
    this._postMessageToWebview({
      type: 'userMessage',
      text: learnerVisibleText
    });

    // 5. Build prompt parameters
    const level = forceIntermediate
      ? 'intermediate'
      : (this._currentConfig.mode === 'intermediate' ? 'intermediate' : 'beginner');
    const conceptsStr = conceptsList.length > 0 ? conceptsList.join(', ') : 'none';
    const taskStr = this._currentTaskText || (this._activeSession?.originalTask) || 'none';
    let learningObjectivesStr = 'none';
    if (this._activeConfig && this._currentConfig.learningObjectives && this._currentConfig.learningObjectives.length > 0) {
      learningObjectivesStr = this._currentConfig.learningObjectives.join(', ');
    }
    const doNotRepeatStr = this._pastQuizQuestions.slice(-6).join(' | ') || 'none';

    // Exact prompt structure per Requirement 2
    const prompt = `Mode: quiz\nLevel: ${level}\nConcepts so far: ${conceptsStr}\nTask: ${taskStr}\nLearning objectives: ${learningObjectivesStr}\nDo not repeat these questions: ${doNotRepeatStr}\nCurrent file:\n${fileSection}`;

    await this._executeQuizPrompt(prompt, level, learnerVisibleText, false);
  }

  /**
   * ===========================================================================
   * QUIZ VALIDATION & SANITIZATION (Requirement 4 & Edge Cases)
   * ===========================================================================
   * - Validates exactly 3 items.
   * - Each item has non-empty question, exactly 4 distinct non-empty options,
   *   integer answer_index (0..3), non-empty explanation, non-empty concept.
   * - Truncates "code" to 6 lines, or sets to null if not string.
   * - Edge case: If instructor config is active, rejects items where code or
   *   explanation contains > 12 lines of code.
   */
  private _validateAndSanitizeQuiz(quiz: any[] | undefined): QuizQuestion[] | null {
    if (!Array.isArray(quiz) || quiz.length !== 3) {
      return null;
    }

    const validated: QuizQuestion[] = [];

    for (const item of quiz) {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const question = typeof item.question === 'string' ? item.question.trim() : '';
      if (!question) {
        return null;
      }

      if (!Array.isArray(item.options) || item.options.length !== 4) {
        return null;
      }

      const options: string[] = item.options.map((opt: any) => typeof opt === 'string' ? opt.trim() : '');
      if (options.some((opt: string) => opt.length === 0)) {
        return null;
      }

      // Must be 4 distinct options
      const distinctOptions = new Set(options);
      if (distinctOptions.size !== 4) {
        return null;
      }

      const answer_index = Number(item.answer_index);
      if (!Number.isInteger(answer_index) || answer_index < 0 || answer_index > 3) {
        return null;
      }

      const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : '';
      if (!explanation) {
        return null;
      }

      const concept = typeof item.concept === 'string' ? item.concept.trim() : '';
      if (!concept) {
        return null;
      }

      // Truncate code to 6 lines; ignore if not a string
      let code: string | null = null;
      if (typeof item.code === 'string' && item.code.trim().length > 0) {
        const lines = item.code.split(/\r?\n/);
        code = lines.slice(0, 6).join('\n');
      }

      // Edge case: If instructor config limits help, ensure code/explanation <= 12 lines of code
      if (this._activeConfig) {
        if (code) {
          const codeLines = code.split(/\r?\n/).length;
          if (codeLines > 12) {
            return null;
          }
        }
        const codeBlockMatches = explanation.match(/```[\s\S]*?```/g);
        if (codeBlockMatches) {
          for (const block of codeBlockMatches) {
            const blockLines = block.split(/\r?\n/).length;
            if (blockLines > 12) {
              return null;
            }
          }
        }
      }

      validated.push({
        question,
        code,
        options,
        answer_index,
        explanation,
        concept
      });
    }

    return validated;
  }

  /**
   * ===========================================================================
   * FISHER-YATES SHUFFLE & ANSWER_INDEX REMAPPING (Requirement 4)
   * ===========================================================================
   * Shuffles the four options of each question locally and remaps answer_index
   * to where the correct option landed, because models tend to put the correct
   * answer in position 0. Preserves the original explanation.
   */
  private _shuffleQuizOptions(questions: QuizQuestion[]): QuizQuestion[] {
    return questions.map(q => {
      const correctOption = q.options[q.answer_index];
      const shuffledOptions = [...q.options];

      // Fisher-Yates shuffle algorithm
      for (let i = shuffledOptions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = shuffledOptions[i];
        shuffledOptions[i] = shuffledOptions[j];
        shuffledOptions[j] = temp;
      }

      // Remap answer_index to point to the correct option's new index
      const newAnswerIndex = shuffledOptions.indexOf(correctOption);

      return {
        ...q,
        options: shuffledOptions,
        answer_index: newAnswerIndex
      };
    });
  }

  /**
   * ===========================================================================
   * SHARED QUIZ PROMPT EXECUTOR: RETRY ON INVALID JSON & ERROR MAPPING
   * ===========================================================================
   * Calls askMentor, validates against Quiz schema. If validation fails,
   * automatically retries ONCE with clarification. If it fails again, shows a
   * friendly error card with Retry button.
   */
  private async _executeQuizPrompt(
    userMessageContent: string,
    level: string,
    learnerVisibleText?: string,
    isRetry: boolean = false
  ): Promise<void> {
    if (!this._view) {
      return;
    }

    const stagedUserText = (learnerVisibleText || userMessageContent).trim();

    // Cache request for seamless Retry
    this._lastRequest = {
      content: userMessageContent,
      mode: 'quiz',
      hintLevel: 1,
      learnerVisibleText: stagedUserText
    };

    this._isRequestInProgress = true;
    this._isUserCancelled = false;
    this._isTimeout = false;
    this._currentMode = 'quiz';

    this._currentAbortController = new AbortController();

    const timeoutTimer = setTimeout(() => {
      this._isTimeout = true;
      this._currentAbortController?.abort();
    }, 30000);

    if (isRetry) {
      this._postMessageToWebview({
        type: 'userMessage',
        text: 'Retrying quiz request...'
      });
    }

    this._postMessageToWebview({
      type: 'loading',
      loading: true
    });

    const primaryModel = getResolvedModel();
    let modelUsed = primaryModel;

    try {
      // 1. Initial attempt
      let rawReply: string;
      try {
        rawReply = await askMentor(
          [...this._history, { role: 'user', content: userMessageContent }],
          this._currentConfig,
          this._activeConfig,
          this._currentAbortController.signal,
          primaryModel
        );
      } catch (primaryError: any) {
        const status = primaryError?.status;
        const msg = primaryError?.message || '';
        const fallbackModel = getResolvedFallbackModel();

        const isModelNotFound = (status === 404) && (
          (primaryModel && msg.toLowerCase().includes(primaryModel.toLowerCase())) ||
          msg.toLowerCase().includes('not found for api version')
        );

        if (isModelNotFound && fallbackModel && fallbackModel !== primaryModel) {
          logApiError(status, primaryModel, 'quiz', primaryError);
          logChannel.appendLine(`[${new Date().toISOString()}] INFO: Primary model "${primaryModel}" not found. Retrying quiz with fallback model "${fallbackModel}"...`);

          modelUsed = fallbackModel;
          rawReply = await askMentor(
            [...this._history, { role: 'user', content: userMessageContent }],
            this._currentConfig,
            this._activeConfig,
            this._currentAbortController.signal,
            fallbackModel
          );
        } else {
          throw primaryError;
        }
      }

      if (!rawReply || rawReply.trim().length === 0) {
        throw new Error('EMPTY_RESPONSE');
      }

      let parsedReply = parseMentorReply(rawReply);
      let validated = this._validateAndSanitizeQuiz(parsedReply.quiz);

      // 2. Requirement 4: If validation fails, automatically retry ONCE with clarification
      if (!validated) {
        logChannel.appendLine(`[${new Date().toISOString()}] WARN: Quiz response failed validation on attempt 1. Retrying once with clarification...`);

        const retryClarificationPrompt = `${userMessageContent}\n\nYour previous reply was not valid quiz JSON; return exactly 3 valid questions.`;
        const retryRawReply = await askMentor(
          [...this._history, { role: 'user', content: retryClarificationPrompt }],
          this._currentConfig,
          this._activeConfig,
          this._currentAbortController.signal,
          modelUsed
        );

        parsedReply = parseMentorReply(retryRawReply);
        validated = this._validateAndSanitizeQuiz(parsedReply.quiz);
      }

      // If retry also failed, display friendly error card with Retry button
      if (!validated) {
        clearTimeout(timeoutTimer);
        this._isRequestInProgress = false;
        this._postMessageToWebview({ type: 'loading', loading: false });
        this._postMessageToWebview({
          type: 'friendlyError',
          message: 'The AI service returned an invalid quiz. Click retry to try again.',
          action: 'retry',
          actionLabel: 'Retry'
        });
        return;
      }

      clearTimeout(timeoutTimer);

      // 3. Requirement 4: Shuffle options locally (Fisher-Yates) and remap answer_index
      const shuffledQuestions = this._shuffleQuizOptions(validated);

      // Track questions to avoid repeating
      for (const q of shuffledQuestions) {
        this._pastQuizQuestions.push(q.question);
      }
      if (this._pastQuizQuestions.length > 6) {
        this._pastQuizQuestions = this._pastQuizQuestions.slice(-6);
      }

      this._isRequestInProgress = false;
      this._postMessageToWebview({ type: 'loading', loading: false });

      // Post quiz card prompt to webview
      this._postMessageToWebview({
        type: 'quizPrompt',
        quiz: shuffledQuestions,
        level: level
      });
    } catch (error: any) {
      clearTimeout(timeoutTimer);

      if (this._isUserCancelled) {
        logError('Quiz request was cancelled by learner');
        this._postMessageToWebview({ type: 'requestCancelled' });
        this._isRequestInProgress = false;
        this._postMessageToWebview({ type: 'loading', loading: false });
        return;
      }

      const status = error?.status;
      const msg = error?.message || '';
      logApiError(status, modelUsed, 'quiz', error);

      let errorMessage = 'The AI service had a problem. Try again in a moment.';
      let errorAction: 'openSettings' | 'retry' | 'none' = 'none';
      let actionLabel = '';
      let retryCountdown = 0;

      const isModelNotFound = (status === 404) && (
        (modelUsed && msg.toLowerCase().includes(modelUsed.toLowerCase())) ||
        msg.toLowerCase().includes('not found for api version')
      );

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
      } else if (isModelNotFound) {
        errorMessage = 'The model name in settings was not found.';
        errorAction = 'openSettings';
        actionLabel = 'Open settings';
      } else if (status === 404) {
        let sanitizedSnippet = msg
          .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
          .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
          .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
          .replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
          .slice(0, 100)
          .trim();
        sanitizedSnippet = sanitizedSnippet.replace(/[:\-]+$/, '').trim();

        errorMessage = sanitizedSnippet
          ? `The AI service returned an error (404): ${sanitizedSnippet}`
          : 'The AI service returned an error (404).';
        errorAction = 'retry';
        actionLabel = 'Retry';
      } else if (
        status === 429 ||
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('quota')
      ) {
        errorMessage = "You're sending requests too fast or hit the free limit. Wait a minute and try again.";
        errorAction = 'retry';
        actionLabel = 'Retry';
        retryCountdown = 20;
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
      } else {
        errorMessage = 'The AI service had a problem. Try again in a moment.';
        errorAction = 'retry';
        actionLabel = 'Retry';
      }

      this._isRequestInProgress = false;
      this._postMessageToWebview({ type: 'loading', loading: false });

      this._postMessageToWebview({
        type: 'friendlyError',
        message: errorMessage,
        action: errorAction,
        actionLabel: actionLabel,
        countdown: retryCountdown
      });
    }
  }

  /**
   * ===========================================================================
   * QUIZ COMPLETION: EVIDENCE SAVING & SESSIONS INTEGRATION (Requirements 7 & 8)
   * ===========================================================================
   * Records evidence in globalState "mentor.quizResults" and appends a single
   * compact StoredMessage with mode 'quiz' to the active session.
   */
  private async _handleQuizCompleted(result: {
    total: number;
    correct: number;
    byConcept: Record<string, { correct: number; total: number }>;
    missedConcepts: string[];
  }): Promise<void> {
    try {
      const sessionId = this._activeSession ? this._activeSession.id : generateSessionId();

      // 1. Requirement 7: Save finished quiz evidence in globalState
      const quizResult: QuizResult = {
        ts: new Date().toISOString(),
        sessionId,
        total: 3,
        correct: result.correct,
        byConcept: result.byConcept || {}
      };
      await recordQuizResult(quizResult, this._globalState);

      // 2. Requirement 8: Append one compact StoredMessage to the active session
      if (!this._activeSession) {
        this._activeSession = createNewSession(
          `Quiz (${result.correct}/3)`,
          this._currentLevel,
          this._currentTaskText
        );
        await setActiveSessionId(this._globalState, this._activeSession.id);
      } else if (this._activeSession.messages.length === 0) {
        // Update learner-visible title logic only if session has no other message
        this._activeSession.title = `Quiz (${result.correct}/3)`;
      }

      const summaryPayload = {
        correct: result.correct,
        total: 3,
        missedConcepts: result.missedConcepts || []
      };

      this._activeSession.messages.push({
        role: 'assistant',
        text: JSON.stringify(summaryPayload),
        mode: 'quiz',
        ts: new Date().toISOString()
      });

      await saveSession(this._globalState, this._activeSession);
    } catch (err) {
      console.error('Code Mentor: Failed to handle quiz completion:', err);
    }
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
    await this._executePrompt(prompt, 'explain_back', 1, false, trimmedExplanation);
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

    await this._executePrompt(userMessageContent, 'task', clampedLevel, false, trimmedText);
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

    const hintName = getHintName(clampedLevel);
    await this._executePrompt(
      userMessageContent,
      'task',
      clampedLevel,
      false,
      `Need more help (${hintName} ${clampedLevel})`
    );
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
   * - Persists learner turns and mentor replies to persistent sessions (Requirements 1, 2, 3).
   */
  private async _executePrompt(
    userMessageContent: string,
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check',
    hintLevel: number,
    isRetry: boolean = false,
    learnerVisibleText?: string
  ): Promise<void> {
    if (!this._view) {
      return;
    }

    // Learner-visible representation (Requirement 2: exclude raw file contents/selections from storage)
    const stagedUserText = (learnerVisibleText || userMessageContent).trim();

    // Cache the request parameters for seamless Retry (Requirement C.2)
    this._lastRequest = {
      content: userMessageContent,
      mode: mode,
      hintLevel: hintLevel,
      learnerVisibleText: stagedUserText
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

    const primaryModel = getResolvedModel();
    let modelUsed = primaryModel;
    let usedFallback = false;

    try {
      let rawReply: string;
      try {
        rawReply = await askMentor(
          this._history,
          this._currentConfig,
          this._activeConfig,
          this._currentAbortController.signal,
          primaryModel
        );
      } catch (primaryError: any) {
        const status = primaryError?.status;
        const msg = primaryError?.message || '';
        const fallbackModel = getResolvedFallbackModel();

        // Requirement 3: Check specific model-not-found 404 condition
        const isModelNotFound = (status === 404) && (
          (primaryModel && msg.toLowerCase().includes(primaryModel.toLowerCase())) ||
          msg.toLowerCase().includes('not found for api version')
        );

        // Requirement 4: If main model returns model-not-found 404 and fallback is set, retry ONCE with fallback model
        if (isModelNotFound && fallbackModel && fallbackModel !== primaryModel) {
          logApiError(status, primaryModel, mode, primaryError);
          logChannel.appendLine(`[${new Date().toISOString()}] INFO: Primary model "${primaryModel}" not found. Retrying once with fallback model "${fallbackModel}"...`);

          usedFallback = true;
          modelUsed = fallbackModel;

          rawReply = await askMentor(
            this._history,
            this._currentConfig,
            this._activeConfig,
            this._currentAbortController.signal,
            fallbackModel
          );
        } else {
          throw primaryError;
        }
      }

      // Check for empty or unusable reply (Requirement C.1)
      if (!rawReply || rawReply.trim().length === 0) {
        throw new Error('EMPTY_RESPONSE');
      }

      this._history.push({
        role: 'assistant',
        content: rawReply
      });

      const structuredReply: MentorReply = parseMentorReply(rawReply);

      // Requirement 4: Show small note in the reply if fallback model was used
      if (usedFallback) {
        const note = 'Used fallback model';
        structuredReply.message = structuredReply.message
          ? `${structuredReply.message}\n\n*(${note})*`
          : note;
      }

      // Persist learned concepts in globalState (live replies only)
      if (Array.isArray(structuredReply.concept) && structuredReply.concept.length > 0) {
        await saveConcepts(structuredReply.concept, this._globalState);
      }

      // =======================================================================
      // PERSISTENT SESSION STORAGE (Requirements 1, 2, 3)
      // Save learner message and raw reply JSON to globalState session
      // =======================================================================
      try {
        if (!this._activeSession) {
          // Create new session automatically on first learner message
          this._activeSession = createNewSession(
            stagedUserText,
            this._currentLevel,
            this._currentTaskText
          );
          await setActiveSessionId(this._globalState, this._activeSession.id);
        }

        const storedMode = mode === 'task' ? 'chat' : mode;

        if (!isRetry) {
          this._activeSession.messages.push({
            role: 'user',
            text: stagedUserText,
            mode: storedMode,
            ts: new Date().toISOString()
          });
        }

        this._activeSession.messages.push({
          role: 'assistant',
          text: rawReply,
          mode: storedMode,
          ts: new Date().toISOString()
        });

        this._activeSession.hintLevel = this._currentLevel;
        this._activeSession.originalTask = this._currentTaskText;
        this._activeSession.workspaceName = vscode.workspace.name || '';

        // Autosave after every successful mentor reply (Requirement 3)
        await saveSession(this._globalState, this._activeSession);
      } catch (storageErr) {
        // Storage errors must never disrupt the chat experience
        console.error('Code Mentor: Failed to persist active session turn:', storageErr);
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
      // FRIENDLY ERROR MAPPING (Requirements 2 & 3)
      // Never expose raw stack traces, API keys, or full request payloads.
      // =======================================================================
      const status = error?.status;
      const msg = error?.message || '';

      // Requirement 2: Log HTTP status, model used, mode, and first 300 chars of error body
      logApiError(status, modelUsed, mode, error);

      let errorMessage = 'An unexpected error occurred. Please try again.';
      let errorAction: 'openSettings' | 'retry' | 'none' = 'none';
      let actionLabel = '';
      let retryCountdown = 0;

      // Requirement 3: Only show "model name not found" if status is 404 AND body mentions model name or "not found for API version"
      const isModelNotFound = (status === 404) && (
        (modelUsed && msg.toLowerCase().includes(modelUsed.toLowerCase())) ||
        msg.toLowerCase().includes('not found for api version')
      );

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
      } else if (isModelNotFound) {
        errorMessage = 'The model name in settings was not found.';
        errorAction = 'openSettings';
        actionLabel = 'Open settings';
      } else if (status === 404) {
        // Requirement 3: For any other 404, show "The AI service returned an error (404)" with short snippet and Retry button
        let sanitizedSnippet = msg
          .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
          .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
          .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
          .replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
          .slice(0, 100)
          .trim();
        sanitizedSnippet = sanitizedSnippet.replace(/[:\-]+$/, '').trim();

        errorMessage = sanitizedSnippet
          ? `The AI service returned an error (404): ${sanitizedSnippet}`
          : 'The AI service returned an error (404).';
        errorAction = 'retry';
        actionLabel = 'Retry';
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

  /**
   * Posts formatted session summaries to webview for the History view (Requirement 6).
   */
  private _postSessionsList(): void {
    try {
      const allSessions = getAllSessions(this._globalState);
      const activeId = this._activeSession ? this._activeSession.id : null;
      const formatted = allSessions.map(s => ({
        id: s.id,
        title: s.title,
        relativeDate: formatRelativeDate(s.updatedAt || s.createdAt),
        messageCount: s.messages.length,
        concepts: extractSessionConcepts(s, 3),
        isActive: s.id === activeId
      }));

      this._postMessageToWebview({
        type: 'sessionsList',
        sessions: formatted
      });
    } catch (err) {
      console.error('Code Mentor: Failed to post sessions list:', err);
    }
  }

  /**
   * Posts the most recent previous session to the Welcome screen if current chat is empty (Requirement 7).
   */
  private _checkAndPostWelcomeContinueCard(): void {
    try {
      if (this._activeSession && this._activeSession.messages.length > 0) {
        return;
      }
      const mostRecent = getMostRecentSession(this._globalState);
      if (mostRecent) {
        this._postMessageToWebview({
          type: 'welcomeContinueCard',
          session: {
            id: mostRecent.id,
            title: mostRecent.title,
            relativeDate: formatRelativeDate(mostRecent.updatedAt || mostRecent.createdAt)
          }
        });
      }
    } catch (err) {
      console.error('Code Mentor: Failed to check and post welcome continue card:', err);
    }
  }

  /**
   * Resumes a session by ID (Requirements 5 & 6).
   */
  public async resumeSessionById(sessionId: string): Promise<void> {
    try {
      // 1. Save current session if active and contains messages
      if (this._activeSession && this._activeSession.messages.length > 0) {
        await saveSession(this._globalState, this._activeSession);
      }

      // 2. Fetch targeted session
      const session = getSessionById(this._globalState, sessionId);
      if (!session) {
        this._postMessageToWebview({
          type: 'noticeMessage',
          text: 'Selected session could not be found.'
        });
        return;
      }

      // 3. Mark as active session
      this._activeSession = session;
      await setActiveSessionId(this._globalState, session.id);

      // 4. Restore in-memory state & clamp hint level with instructor config (Requirement 9)
      const effectiveMax = this._currentConfig.maxHintLevel;
      this._activeSession.hintLevel = Math.min(this._activeSession.hintLevel || 1, effectiveMax) as 1 | 2 | 3 | 4;
      this._currentLevel = this._activeSession.hintLevel;
      this._currentTaskText = this._activeSession.originalTask || '';

      // Rebuild in-memory LLM history from session.messages (Requirement 5)
      this._history = this._activeSession.messages.map(m => ({
        role: m.role,
        content: m.text
      }));

      // Restore mode
      if (this._activeSession.messages.length > 0) {
        const lastMode = this._activeSession.messages[this._activeSession.messages.length - 1].mode;
        if (lastMode === 'explain' || lastMode === 'review' || lastMode === 'explain_back' || lastMode === 'paste_check') {
          this._currentMode = lastMode;
        } else {
          this._currentMode = 'task';
        }
      } else {
        this._currentMode = 'task';
      }

      // 5. Post restore message to webview
      this._postMessageToWebview({
        type: 'restore',
        session: this._activeSession
      });
    } catch (err) {
      console.error('Code Mentor: Failed to resume session by ID:', err);
    }
  }

  /**
   * Command: Resume last session (Requirement 8).
   */
  public async resumeLastSession(): Promise<void> {
    if (!this._view || !this._isWebviewReady) {
      this._pendingResumeLastSession = true;
      return;
    }

    try {
      const recent = getMostRecentSession(this._globalState);
      if (recent) {
        await this.resumeSessionById(recent.id);
      } else {
        this._postMessageToWebview({
          type: 'noticeMessage',
          text: 'No past sessions found to resume.'
        });
      }
    } catch (err) {
      console.error('Code Mentor: Failed to resume last session:', err);
    }
  }

  /**
   * Command: Show chat history (Requirement 8).
   */
  public async showHistory(): Promise<void> {
    if (!this._view || !this._isWebviewReady) {
      this._pendingShowHistory = true;
      return;
    }

    this._postMessageToWebview({ type: 'openHistory' });
    this._postSessionsList();
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

    /* History Panel (Requirement 6) */
    .history-panel {
      display: none;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 12px;
      flex-direction: column;
      gap: 10px;
    }

    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .history-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 320px;
      overflow-y: auto;
    }

    .history-empty-msg {
      font-style: italic;
      font-size: 11.5px;
      opacity: 0.75;
      padding: 8px 0;
    }

    .history-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.06));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .history-item.is-active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-selectionBackground, rgba(128, 128, 128, 0.12));
    }

    .history-item-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 6px;
    }

    .history-item-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      word-break: break-word;
      line-height: 1.35;
    }

    .badge-current {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.3));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      padding: 1px 6px;
      border-radius: 8px;
      flex-shrink: 0;
    }

    .history-item-meta {
      font-size: 10.5px;
      opacity: 0.75;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .history-item-concepts {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    .history-concept-chip {
      font-size: 10px;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-badge-foreground, inherit);
      padding: 1px 6px;
      border-radius: 10px;
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }

    .history-item-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 4px;
      flex-wrap: wrap;
    }

    .history-item-actions button {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-resume-session {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
    }

    .btn-resume-session:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-delete-session {
      background: transparent;
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      color: var(--vscode-foreground);
    }

    .btn-delete-session:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
    }

    .delete-confirm-inline {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
    }

    .history-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      padding-top: 8px;
      flex-wrap: wrap;
    }

    .btn-back-chat,
    .btn-clear-all {
      background: transparent;
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      color: var(--vscode-foreground);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
    }

    .btn-back-chat:hover,
    .btn-clear-all:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
    }

    .clear-all-confirm-box {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }

    /* Continue Card on Welcome Screen (Requirement 7) */
    .continue-card {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.1));
      border: 1px solid var(--vscode-focusBorder, rgba(0, 122, 204, 0.4));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 4px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .continue-card-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .continue-card-icon {
      font-size: 14px;
      line-height: 1;
    }

    .continue-card-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11.5px;
      line-height: 1.35;
    }

    .continue-card-prefix {
      font-size: 10.5px;
      opacity: 0.75;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .continue-card-title {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .continue-card-date {
      font-size: 10.5px;
      opacity: 0.7;
    }

    .continue-card-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 2px;
    }

    .continue-fresh-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 11px;
      cursor: pointer;
    }

    .continue-fresh-link:hover {
      text-decoration: underline;
    }

    /* =============================================================
       QUIZ CARD & RESULTS CARD STYLING (Requirements 5, 6, 9)
       ============================================================= */
    .quiz-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      line-height: 1.45;
      max-width: 100%;
      box-sizing: border-box;
    }

    .quiz-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      padding-bottom: 6px;
    }

    .quiz-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, inherit);
      font-size: 12px;
    }

    .quiz-progress-label {
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-badge-foreground, inherit);
      white-space: nowrap;
    }

    .quiz-question-text {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, inherit);
      line-height: 1.4;
    }

    .quiz-code-block {
      background: var(--vscode-editor-background, rgba(0, 0, 0, 0.2));
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      max-width: 100%;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.4;
      white-space: pre;
      margin: 0;
    }

    .quiz-options-group {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-top: 2px;
    }

    .quiz-option {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.12));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      line-height: 1.35;
      outline: none;
      transition: background 0.15s ease, border-color 0.15s ease;
      word-break: break-word;
    }

    .quiz-option:hover:not(.locked) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
      border-color: var(--vscode-focusBorder, rgba(128, 128, 128, 0.5));
    }

    .quiz-option:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: 1px;
    }

    .quiz-option.locked {
      cursor: default;
    }

    .quiz-option-key {
      font-weight: 700;
      font-size: 10.5px;
      background: rgba(128, 128, 128, 0.2);
      border-radius: 3px;
      padding: 1px 5px;
      flex-shrink: 0;
      line-height: 1.2;
      margin-top: 1px;
    }

    .quiz-option-text {
      flex: 1;
    }

    .quiz-option.selected-correct {
      background: rgba(115, 201, 145, 0.15);
      border-color: var(--vscode-testing-iconPassed, #73c991);
    }

    .quiz-option.selected-wrong {
      background: rgba(241, 76, 76, 0.15);
      border-color: var(--vscode-testing-iconFailed, #f14c4c);
    }

    .quiz-option.revealed-correct {
      border-color: var(--vscode-testing-iconPassed, #73c991);
      border-style: dashed;
    }

    .quiz-feedback-box {
      margin-top: 4px;
      padding: 8px 10px;
      border-radius: 4px;
      background: var(--vscode-input-background, rgba(128, 128, 128, 0.1));
      border-left: 3px solid transparent;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .quiz-feedback-box.correct {
      border-left-color: var(--vscode-testing-iconPassed, #73c991);
    }

    .quiz-feedback-box.incorrect {
      border-left-color: var(--vscode-testing-iconFailed, #f14c4c);
    }

    .quiz-feedback-status {
      font-weight: 700;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .quiz-feedback-status.correct {
      color: var(--vscode-testing-iconPassed, #73c991);
    }

    .quiz-feedback-status.incorrect {
      color: var(--vscode-testing-iconFailed, #f14c4c);
    }

    .quiz-feedback-correct-answer {
      font-size: 11.5px;
      opacity: 0.9;
    }

    .quiz-explanation-text {
      font-size: 11.5px;
      line-height: 1.45;
      margin-top: 2px;
    }

    .quiz-footer-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      flex-wrap: wrap;
    }

    .quiz-skip-link {
      font-size: 11px;
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      cursor: pointer;
    }

    .quiz-skip-link:hover {
      text-decoration: underline;
    }

    /* Results Card */
    .quiz-results-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
    }

    .quiz-results-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13.5px;
      font-weight: 700;
      color: var(--vscode-textLink-foreground, inherit);
    }

    .quiz-results-sentence {
      font-size: 12px;
      line-height: 1.45;
    }

    .quiz-revisit-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
    }

    .quiz-revisit-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }

    .quiz-revisit-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .quiz-revisit-chip {
      background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
      color: var(--vscode-textLink-foreground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.3));
      border-radius: 12px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }

    .quiz-revisit-chip:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
    }

    .quiz-results-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 6px;
    }

    .quiz-summary-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 5px;
      padding: 8px 10px;
      font-size: 11.5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Accessibility: prefers-reduced-motion and narrow layout (~250px) */
    @media (prefers-reduced-motion: reduce) {
      * {
        animation: none !important;
        transition: none !important;
      }
    }

    @media (max-width: 270px) {
      .header-actions {
        gap: 2px;
      }
      .header-actions button {
        padding: 2px 5px;
        font-size: 10px;
      }
      .quiz-card {
        padding: 8px 10px;
      }
      .quiz-option {
        padding: 6px 8px;
        font-size: 11.5px;
      }
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
        <button id="history-toggle-btn" title="View past chat sessions" aria-label="View chat history">📜 History</button>
        <button id="progress-toggle-btn" title="View your learned concepts" aria-label="View learning progress">📊 Progress</button>
        <button id="review-code-btn" title="Review my current active file" aria-label="Review active file">🔍 Review</button>
        <button id="quiz-me-btn" title="Take a quick quiz on concepts and your code" aria-label="Take quick quiz">🎯 Quiz me</button>
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

    <!-- History Panel Card (Requirement 6) -->
    <div class="history-panel" id="history-panel" style="display: none;">
      <div class="history-header">
        <span class="history-title">📜 Chat History</span>
        <button type="button" class="btn-close-panel" id="close-history-btn" aria-label="Close history panel">✕</button>
      </div>
      <div class="history-list" id="history-list">
        <!-- Rendered dynamically -->
      </div>
      <div class="history-footer">
        <button type="button" class="btn-back-chat" id="back-to-chat-btn" aria-label="Back to current chat">← Back to chat</button>
        <div class="clear-all-confirm-box" id="clear-all-confirm-box" style="display: none;">
          <span>Clear all history?</span>
          <button type="button" class="btn-action danger" id="confirm-clear-all-btn">Yes, clear all</button>
          <button type="button" class="cancel-btn" id="cancel-clear-all-btn">Cancel</button>
        </div>
        <button type="button" class="btn-clear-all" id="init-clear-all-btn">Clear all history</button>
      </div>
    </div>

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

        <!-- Continue Card on Welcome Screen (Requirement 7) -->
        <div class="continue-card" id="welcome-continue-card" style="display: none;">
          <div class="continue-card-header">
            <span class="continue-card-icon" aria-hidden="true">⏳</span>
            <div class="continue-card-meta">
              <span class="continue-card-prefix">Continue where you left off:</span>
              <span class="continue-card-title" id="continue-card-title"></span>
              <span class="continue-card-date" id="continue-card-date"></span>
            </div>
          </div>
          <div class="continue-card-actions">
            <button type="button" class="btn-action" id="continue-session-btn" aria-label="Continue previous session">Continue</button>
            <a href="#" class="continue-fresh-link" id="continue-start-fresh-btn">Start fresh</a>
          </div>
        </div>

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
        <div class="welcome-privacy">Your current file and selected code are sent to your AI provider to generate replies. Your chat history is saved on this computer only, and you can delete it any time from History.</div>
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
    const quizMeBtn = document.getElementById('quiz-me-btn');

    // Progress elements
    const progressToggleBtn = document.getElementById('progress-toggle-btn');
    const progressPanel = document.getElementById('progress-panel');
    const closeProgressBtn = document.getElementById('close-progress-btn');
    const progressList = document.getElementById('progress-list');
    const initResetProgressBtn = document.getElementById('init-reset-progress-btn');
    const resetConfirmBox = document.getElementById('reset-confirm-box');
    const confirmResetProgressBtn = document.getElementById('confirm-reset-progress-btn');
    const cancelResetProgressBtn = document.getElementById('cancel-reset-progress-btn');

    // History elements (Requirement 6)
    const historyToggleBtn = document.getElementById('history-toggle-btn');
    const historyPanel = document.getElementById('history-panel');
    const closeHistoryBtn = document.getElementById('close-history-btn');
    const historyList = document.getElementById('history-list');
    const backToChatBtn = document.getElementById('back-to-chat-btn');
    const initClearAllBtn = document.getElementById('init-clear-all-btn');
    const clearAllConfirmBox = document.getElementById('clear-all-confirm-box');
    const confirmClearAllBtn = document.getElementById('confirm-clear-all-btn');
    const cancelClearAllBtn = document.getElementById('cancel-clear-all-btn');

    // Welcome Continue Card elements (Requirement 7)
    const welcomeContinueCard = document.getElementById('welcome-continue-card');
    const continueCardTitle = document.getElementById('continue-card-title');
    const continueCardDate = document.getElementById('continue-card-date');
    const continueSessionBtn = document.getElementById('continue-session-btn');
    const continueStartFreshBtn = document.getElementById('continue-start-fresh-btn');

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
      // Autosave on hint level change (Requirement 3)
      vscode.postMessage({ type: 'hintLevelChanged', level: currentHintLevel });
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
        vscode.postMessage({ type: 'hintLevelChanged', level: 3 });
      });
    }

    if (confirmSolutionBtn) {
      confirmSolutionBtn.addEventListener('click', function() {
        hideSolutionConfirmation();
        selectHintLevel(4);
        vscode.postMessage({ type: 'hintLevelChanged', level: 4 });
      });
    }

    // -------------------------------------------------------------------------
    // WELCOME CONTINUE CARD (Requirement 7)
    // -------------------------------------------------------------------------
    if (continueSessionBtn) {
      continueSessionBtn.addEventListener('click', function() {
        const id = welcomeContinueCard.getAttribute('data-session-id');
        if (id) {
          vscode.postMessage({ type: 'resumeSession', sessionId: id });
        }
      });
    }

    if (continueStartFreshBtn) {
      continueStartFreshBtn.addEventListener('click', function(e) {
        e.preventDefault();
        welcomeContinueCard.style.display = 'none';
      });
    }

    // -------------------------------------------------------------------------
    // HISTORY VIEW (Requirement 6)
    // -------------------------------------------------------------------------
    if (historyToggleBtn) {
      historyToggleBtn.addEventListener('click', function() {
        const isVisible = (historyPanel.style.display === 'flex');
        if (isVisible) {
          historyPanel.style.display = 'none';
        } else {
          if (progressPanel) progressPanel.style.display = 'none';
          historyPanel.style.display = 'flex';
          vscode.postMessage({ type: 'getSessions' });
        }
      });
    }

    if (closeHistoryBtn) {
      closeHistoryBtn.addEventListener('click', function() {
        historyPanel.style.display = 'none';
      });
    }

    if (backToChatBtn) {
      backToChatBtn.addEventListener('click', function() {
        historyPanel.style.display = 'none';
      });
    }

    if (initClearAllBtn) {
      initClearAllBtn.addEventListener('click', function() {
        initClearAllBtn.style.display = 'none';
        clearAllConfirmBox.style.display = 'flex';
      });
    }

    if (cancelClearAllBtn) {
      cancelClearAllBtn.addEventListener('click', function() {
        clearAllConfirmBox.style.display = 'none';
        initClearAllBtn.style.display = 'inline-block';
      });
    }

    if (confirmClearAllBtn) {
      confirmClearAllBtn.addEventListener('click', function() {
        clearAllConfirmBox.style.display = 'none';
        initClearAllBtn.style.display = 'inline-block';
        vscode.postMessage({ type: 'clearAllSessions' });
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderSessionsList(sessions) {
      historyList.innerHTML = '';
      if (!Array.isArray(sessions) || sessions.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'history-empty-msg';
        emptyEl.textContent = 'Your past sessions will appear here.';
        historyList.appendChild(emptyEl);
        return;
      }

      sessions.forEach(function(sess) {
        const itemEl = document.createElement('div');
        itemEl.className = 'history-item' + (sess.isActive ? ' is-active' : '');

        const topRow = document.createElement('div');
        topRow.className = 'history-item-top';

        const titleEl = document.createElement('div');
        titleEl.className = 'history-item-title';
        titleEl.textContent = sess.title || 'Untitled session';
        topRow.appendChild(titleEl);

        if (sess.isActive) {
          const currentBadge = document.createElement('span');
          currentBadge.className = 'badge-current';
          currentBadge.textContent = 'Current';
          topRow.appendChild(currentBadge);
        }

        itemEl.appendChild(topRow);

        const metaRow = document.createElement('div');
        metaRow.className = 'history-item-meta';

        const dateSpan = document.createElement('span');
        dateSpan.textContent = sess.relativeDate || '';
        metaRow.appendChild(dateSpan);

        const dotSpan = document.createElement('span');
        dotSpan.textContent = '·';
        metaRow.appendChild(dotSpan);

        const msgCountSpan = document.createElement('span');
        msgCountSpan.textContent = sess.messageCount + ' message' + (sess.messageCount === 1 ? '' : 's');
        metaRow.appendChild(msgCountSpan);

        itemEl.appendChild(metaRow);

        if (Array.isArray(sess.concepts) && sess.concepts.length > 0) {
          const conceptsRow = document.createElement('div');
          conceptsRow.className = 'history-item-concepts';
          sess.concepts.forEach(function(c) {
            const chip = document.createElement('span');
            chip.className = 'history-concept-chip';
            chip.textContent = c;
            conceptsRow.appendChild(chip);
          });
          itemEl.appendChild(conceptsRow);
        }

        const actionsRow = document.createElement('div');
        actionsRow.className = 'history-item-actions';

        if (!sess.isActive) {
          const resumeBtn = document.createElement('button');
          resumeBtn.type = 'button';
          resumeBtn.className = 'btn-resume-session';
          resumeBtn.textContent = 'Resume';
          resumeBtn.setAttribute('aria-label', 'Resume session: ' + (sess.title || 'Untitled session'));
          resumeBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'resumeSession', sessionId: sess.id });
          });
          actionsRow.appendChild(resumeBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-session';
        deleteBtn.textContent = 'Delete';
        deleteBtn.setAttribute('aria-label', 'Delete session: ' + (sess.title || 'Untitled session'));

        const inlineConfirm = document.createElement('span');
        inlineConfirm.className = 'delete-confirm-inline';
        inlineConfirm.style.display = 'none';

        const promptText = document.createElement('span');
        promptText.textContent = 'Delete? ';
        inlineConfirm.appendChild(promptText);

        const yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.className = 'btn-action danger';
        yesBtn.textContent = 'Yes';
        yesBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'deleteSession', sessionId: sess.id });
        });
        inlineConfirm.appendChild(yesBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function() {
          inlineConfirm.style.display = 'none';
          deleteBtn.style.display = 'inline-block';
        });
        inlineConfirm.appendChild(cancelBtn);

        deleteBtn.addEventListener('click', function() {
          deleteBtn.style.display = 'none';
          inlineConfirm.style.display = 'inline-flex';
        });

        actionsRow.appendChild(deleteBtn);
        actionsRow.appendChild(inlineConfirm);

        itemEl.appendChild(actionsRow);
        historyList.appendChild(itemEl);
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
          if (historyPanel) historyPanel.style.display = 'none';
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

    if (quizMeBtn) {
      quizMeBtn.addEventListener('click', function() {
        if (isLoading) return;
        vscode.postMessage({ type: 'startQuiz' });
      });
    }

    // -------------------------------------------------------------------------
    // INCOMING: Receiving messages from Extension Host in the Webview
    // -------------------------------------------------------------------------
    window.addEventListener('message', function(event) {
      const message = event.data;

      switch (message.type) {
        case 'quizPrompt': {
          renderQuizCard(message.quiz, message.level);
          break;
        }

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
          if (historyPanel) {
            historyPanel.style.display = 'none';
            messagesContainer.appendChild(historyPanel);
          }
          if (progressPanel) {
            progressPanel.style.display = 'none';
            messagesContainer.appendChild(progressPanel);
          }
          if (welcomeCard) {
            welcomeCard.style.display = 'flex';
            if (welcomeContinueCard) {
              welcomeContinueCard.style.display = 'none';
            }
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

        case 'restore': {
          // Requirement 5: Rebuild chat using live renderers
          const session = message.session;
          if (!session) break;

          if (historyPanel) historyPanel.style.display = 'none';
          if (progressPanel) progressPanel.style.display = 'none';

          // Clear existing messages from UI
          const rows = messagesContainer.querySelectorAll('.message-row, .cancelled-note, .notice-card');
          rows.forEach(function(r) { r.remove(); });

          if (welcomeCard) {
            welcomeCard.style.display = 'none';
          }

          // Restore hint level buttons
          selectHintLevel(session.hintLevel || 1);

          // Rebuild chat with the SAME card renderers used for live replies
          if (Array.isArray(session.messages)) {
            session.messages.forEach(function(msg) {
              if (msg.role === 'user') {
                appendUserMessage(msg.text);
              } else if (msg.role === 'assistant') {
                if (msg.mode === 'quiz') {
                  renderStoredQuizCard(msg.text);
                } else {
                  let parsed;
                  try {
                    parsed = JSON.parse(msg.text);
                  } catch (e) {
                    // Fallback if stored reply fails to parse
                    parsed = {
                      message: msg.text || '',
                      concept: [],
                      next_step: '',
                      question: null,
                      hint_level: session.hintLevel || 1
                    };
                  }
                  const renderMode = msg.mode === 'chat' ? 'task' : msg.mode;
                  renderMentorReplyCard(parsed, renderMode);
                }
              }
            });
          }

          hasReplies = Array.isArray(session.messages) && session.messages.some(function(m) { return m.role === 'assistant'; });
          if (hasReplies && explainBackSection) {
            explainBackSection.style.display = 'block';
          }

          // Scroll to newest message after restoring (Requirement 5)
          scrollToBottom(true);
          break;
        }

        case 'sessionsList': {
          // Requirement 6: Render history rows
          renderSessionsList(message.sessions);
          break;
        }

        case 'welcomeContinueCard': {
          // Requirement 7: Show continue card on welcome screen if chat is empty
          const session = message.session;
          if (session && welcomeContinueCard && welcomeCard && !hasReplies) {
            if (continueCardTitle) {
              continueCardTitle.textContent = session.title || 'Untitled session';
            }
            if (continueCardDate) {
              continueCardDate.textContent = session.relativeDate ? ' · ' + session.relativeDate : '';
            }
            welcomeContinueCard.setAttribute('data-session-id', session.id);
            welcomeContinueCard.style.display = 'block';
          }
          break;
        }

        case 'openHistory': {
          // Requirement 6 & 8: Open history panel from command or header
          if (progressPanel) progressPanel.style.display = 'none';
          if (historyPanel) historyPanel.style.display = 'flex';
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
      if (quizMeBtn) {
        quizMeBtn.disabled = loading;
      }
      if (reviewCodeBtn) {
        reviewCodeBtn.disabled = loading;
      }

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
      const isQuizMode = (mode === 'quiz');
      const hideLadderControls = isExplainMode || isReviewMode || isExplainBackMode || isPasteCheckMode || isQuizMode;

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
            vscode.postMessage({
              type: 'hintLevelChanged',
              level: nextLevel
            });
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

    /**
     * Requirement 8: Renders a compact summary card for a stored quiz turn on session restore.
     * e.g. "Quiz result: 2 of 3 · Revisit: Flexbox"
     */
    function renderStoredQuizCard(text) {
      let data = { correct: 0, total: 3, missedConcepts: [] };
      try {
        data = JSON.parse(text);
      } catch (e) {}

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'quiz-summary-card';

      const icon = document.createElement('span');
      icon.textContent = '🎯';
      card.appendChild(icon);

      const textSpan = document.createElement('span');
      let label = 'Quiz result: ' + (data.correct != null ? data.correct : 0) + ' of ' + (data.total || 3);
      if (Array.isArray(data.missedConcepts) && data.missedConcepts.length > 0) {
        label += ' · Revisit: ' + data.missedConcepts.join(', ');
      } else if (data.correct === 3) {
        label += ' · All concepts solid!';
      }
      textSpan.textContent = label;
      card.appendChild(textSpan);

      row.appendChild(card);
      messagesContainer.appendChild(row);
    }

    /**
     * Requirements 5 & 6: Renders the interactive 3-question Quick Quiz in the chat.
     * - Card renders 1 question at a time with header progress text.
     * - Code snippet displayed in <pre><code> with horizontal scroll.
     * - Options in role="radiogroup" with role="radio" and aria-checked.
     * - Keyboard navigation: Arrow keys move, Enter/Space selects, 1-4 selects directly.
     * - Selecting an option locks question, reveals text label ("✓ Correct" or "✕ Not quite"),
     *   correct answer when wrong, and explanation.
     * - "Next" button (or "See results" on question 3).
     * - "Skip quiz" link to dismiss without saving.
     * - Results card with score encouragement, concepts to revisit chips (fill input on click),
     *   and Retake / Harder buttons.
     */
    function renderQuizCard(quizQuestions, level) {
      if (!Array.isArray(quizQuestions) || quizQuestions.length !== 3) {
        return;
      }

      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      hasReplies = true;
      if (explainBackSection) {
        explainBackSection.style.display = 'block';
      }

      let currentQuestionIndex = 0;
      let score = 0;
      const byConcept = {};
      const missedConcepts = [];
      let isAnswered = false;

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'quiz-card';
      row.appendChild(card);
      messagesContainer.appendChild(row);

      function renderCurrentQuestion() {
        card.innerHTML = '';
        isAnswered = false;

        const q = quizQuestions[currentQuestionIndex];

        // 1. Header: "Quiz · Question N of 3" and progress text label
        const header = document.createElement('div');
        header.className = 'quiz-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'quiz-title-group';
        const iconSpan = document.createElement('span');
        iconSpan.textContent = '🎯';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = 'Quiz · Question ' + (currentQuestionIndex + 1) + ' of 3';
        titleGroup.appendChild(iconSpan);
        titleGroup.appendChild(titleSpan);
        header.appendChild(titleGroup);

        const progressLabel = document.createElement('span');
        progressLabel.className = 'quiz-progress-label';
        progressLabel.textContent = 'Question ' + (currentQuestionIndex + 1) + ' of 3';
        header.appendChild(progressLabel);

        card.appendChild(header);

        // 2. Question text (escaped)
        const questionText = document.createElement('div');
        questionText.className = 'quiz-question-text';
        questionText.textContent = q.question;
        card.appendChild(questionText);

        // 3. Optional code block (escaped, in <pre><code>, horizontal scroll)
        if (q.code && typeof q.code === 'string' && q.code.trim()) {
          const pre = document.createElement('pre');
          pre.className = 'quiz-code-block';
          const codeEl = document.createElement('code');
          codeEl.textContent = q.code.trim();
          pre.appendChild(codeEl);
          card.appendChild(pre);
        }

        // 4. Four options as role="radiogroup" with role="radio" and aria-checked
        const optionsGroup = document.createElement('div');
        optionsGroup.className = 'quiz-options-group';
        optionsGroup.setAttribute('role', 'radiogroup');
        optionsGroup.setAttribute('aria-label', 'Answer options');

        const optionEls = [];

        q.options.forEach(function(optText, idx) {
          const optionEl = document.createElement('div');
          optionEl.className = 'quiz-option';
          optionEl.setAttribute('role', 'radio');
          optionEl.setAttribute('aria-checked', 'false');
          optionEl.setAttribute('tabindex', idx === 0 ? '0' : '-1');
          optionEl.setAttribute('data-index', String(idx));

          const keyBadge = document.createElement('span');
          keyBadge.className = 'quiz-option-key';
          keyBadge.textContent = String(idx + 1);

          const textSpan = document.createElement('span');
          textSpan.className = 'quiz-option-text';
          textSpan.textContent = optText;

          optionEl.appendChild(keyBadge);
          optionEl.appendChild(textSpan);

          optionEl.addEventListener('click', function() {
            if (!isAnswered) {
              handleOptionSelect(idx);
            }
          });

          optionEls.push(optionEl);
          optionsGroup.appendChild(optionEl);
        });

        card.appendChild(optionsGroup);

        // 5. Container for feedback & navigation
        const feedbackContainer = document.createElement('div');
        feedbackContainer.className = 'quiz-feedback-container';
        card.appendChild(feedbackContainer);

        const footer = document.createElement('div');
        footer.className = 'quiz-footer-actions';

        const skipLink = document.createElement('a');
        skipLink.className = 'quiz-skip-link';
        skipLink.href = '#';
        skipLink.setAttribute('role', 'button');
        skipLink.textContent = 'Skip quiz';
        skipLink.addEventListener('click', function(e) {
          e.preventDefault();
          cleanupListeners();
          row.remove();
        });
        footer.appendChild(skipLink);

        const actionBtnContainer = document.createElement('div');
        footer.appendChild(actionBtnContainer);

        card.appendChild(footer);

        // Keyboard handler for the options
        function handleKeyDown(e) {
          if (isAnswered) return;

          // Keys 1 to 4: direct selection
          if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
            const idx = parseInt(e.key, 10) - 1;
            if (idx >= 0 && idx < 4) {
              e.preventDefault();
              handleOptionSelect(idx);
            }
            return;
          }

          const focusedIndex = optionEls.findIndex(el => el === document.activeElement);

          // Arrow navigation
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            const nextIdx = focusedIndex >= 0 ? (focusedIndex + 1) % 4 : 0;
            optionEls.forEach((el, i) => el.setAttribute('tabindex', i === nextIdx ? '0' : '-1'));
            optionEls[nextIdx].focus();
            return;
          }

          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const prevIdx = focusedIndex >= 0 ? (focusedIndex + 3) % 4 : 3;
            optionEls.forEach((el, i) => el.setAttribute('tabindex', i === prevIdx ? '0' : '-1'));
            optionEls[prevIdx].focus();
            return;
          }

          // Enter or Space to select currently focused option
          if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) {
            e.preventDefault();
            handleOptionSelect(focusedIndex);
            return;
          }
        }

        function cleanupListeners() {
          document.removeEventListener('keydown', handleKeyDown);
        }

        document.addEventListener('keydown', handleKeyDown);

        function handleOptionSelect(chosenIndex) {
          if (isAnswered) return;
          isAnswered = true;
          cleanupListeners();

          const isCorrect = (chosenIndex === q.answer_index);
          const conceptName = q.concept || 'General';

          byConcept[conceptName] = byConcept[conceptName] || { correct: 0, total: 0 };
          byConcept[conceptName].total++;

          if (isCorrect) {
            score++;
            byConcept[conceptName].correct++;
          } else {
            missedConcepts.push(conceptName);
          }

          // Lock options and update visual feedback
          optionEls.forEach(function(el, i) {
            el.classList.add('locked');
            el.setAttribute('tabindex', '-1');
            if (i === chosenIndex) {
              el.setAttribute('aria-checked', 'true');
              if (isCorrect) {
                el.classList.add('selected-correct');
              } else {
                el.classList.add('selected-wrong');
              }
            } else if (!isCorrect && i === q.answer_index) {
              el.classList.add('revealed-correct');
            }
          });

          // Feedback box with explicit TEXT label ("Correct" or "Not quite") and icon
          const feedbackBox = document.createElement('div');
          feedbackBox.className = 'quiz-feedback-box ' + (isCorrect ? 'correct' : 'incorrect');

          const statusLabel = document.createElement('div');
          statusLabel.className = 'quiz-feedback-status ' + (isCorrect ? 'correct' : 'incorrect');
          statusLabel.textContent = isCorrect ? '✓ Correct' : '✕ Not quite';
          feedbackBox.appendChild(statusLabel);

          if (!isCorrect) {
            const correctInfo = document.createElement('div');
            correctInfo.className = 'quiz-feedback-correct-answer';
            correctInfo.innerHTML = 'Correct answer: <strong>' + escapeHtml(q.options[q.answer_index]) + '</strong>';
            feedbackBox.appendChild(correctInfo);
          }

          if (q.explanation) {
            const explanationEl = document.createElement('div');
            explanationEl.className = 'quiz-explanation-text';
            explanationEl.textContent = q.explanation;
            feedbackBox.appendChild(explanationEl);
          }

          feedbackContainer.appendChild(feedbackBox);

          // Navigation button: Next or See results
          const isLastQuestion = (currentQuestionIndex === 2);
          const nextBtn = document.createElement('button');
          nextBtn.type = 'button';
          nextBtn.className = 'btn-action';
          nextBtn.textContent = isLastQuestion ? 'See results →' : 'Next →';
          nextBtn.addEventListener('click', function() {
            if (isLastQuestion) {
              renderResultsCard();
            } else {
              currentQuestionIndex++;
              renderCurrentQuestion();
            }
          });

          actionBtnContainer.appendChild(nextBtn);
          nextBtn.focus();
          scrollToBottom(true);
        }

        scrollToBottom(false);
      }

      function renderResultsCard() {
        card.innerHTML = '';

        const resultsHeader = document.createElement('div');
        resultsHeader.className = 'quiz-results-header';
        resultsHeader.innerHTML = '<span>🏆</span><span>You got ' + score + ' of 3</span>';
        card.appendChild(resultsHeader);

        let sentence = '';
        if (score === 3) {
          sentence = "Outstanding work! You've mastered all the concepts covered so far.";
        } else if (score === 2) {
          sentence = "Great progress! You have a solid grasp on these concepts with just a little review needed.";
        } else {
          sentence = "Good effort! Taking quizzes helps lock in what you've learned. Review the concepts below to build your confidence.";
        }

        const sentenceEl = document.createElement('div');
        sentenceEl.className = 'quiz-results-sentence';
        sentenceEl.textContent = sentence;
        card.appendChild(sentenceEl);

        const uniqueMissed = Array.from(new Set(missedConcepts));
        if (uniqueMissed.length > 0) {
          const revisitSec = document.createElement('div');
          revisitSec.className = 'quiz-revisit-section';

          const revisitLabel = document.createElement('div');
          revisitLabel.className = 'quiz-revisit-label';
          revisitLabel.textContent = 'Concepts to revisit:';
          revisitSec.appendChild(revisitLabel);

          const chipsWrap = document.createElement('div');
          chipsWrap.className = 'quiz-revisit-chips';

          uniqueMissed.forEach(function(concept) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'quiz-revisit-chip';
            chip.textContent = '↻ ' + concept;
            chip.title = 'Ask mentor to explain ' + concept;
            chip.addEventListener('click', function() {
              userInput.value = 'Can you explain ' + concept + ' again?';
              userInput.style.height = 'auto';
              userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
              userInput.focus();
            });
            chipsWrap.appendChild(chip);
          });

          revisitSec.appendChild(chipsWrap);
          card.appendChild(revisitSec);
        }

        const actions = document.createElement('div');
        actions.className = 'quiz-results-actions';

        const retakeBtn = document.createElement('button');
        retakeBtn.type = 'button';
        retakeBtn.className = 'btn-action';
        retakeBtn.textContent = 'Retake with new questions';
        retakeBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'startQuiz' });
        });
        actions.appendChild(retakeBtn);

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'cancel-btn';
        backBtn.textContent = 'Back to chat';
        backBtn.addEventListener('click', function() {
          userInput.focus();
          scrollToBottom(true);
        });
        actions.appendChild(backBtn);

        // Requirement 6: If score is 3/3, show "Nice work. Want something harder?" button
        if (score === 3) {
          const harderBtn = document.createElement('button');
          harderBtn.type = 'button';
          harderBtn.className = 'btn-action';
          harderBtn.textContent = 'Nice work. Want something harder?';
          harderBtn.title = 'Start intermediate level quiz';
          harderBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'startQuiz', forceIntermediate: true });
          });
          actions.appendChild(harderBtn);
        }

        card.appendChild(actions);

        // Requirement 7: Post completed quiz evidence to extension host
        vscode.postMessage({
          type: 'quizCompleted',
          result: {
            total: 3,
            correct: score,
            byConcept: byConcept,
            missedConcepts: uniqueMissed
          }
        });

        scrollToBottom(true);
      }

      // Start by rendering Question 1
      renderCurrentQuestion();
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
