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
} from '../llm';
import {
  initProgress,
  saveConcepts,
  getConcepts,
  clearConcepts,
  clearQuizResults,
  recordQuizResult,
  getQuizResults,
  QuizResult,
  setProgressLogger
} from '../progress';
import {
  MentorConfig,
  DEFAULT_CONFIG,
  loadConfig,
  watchConfigFile,
  createOrOpenConfigFile
} from '../config';
import {
  registerPasteDetector,
  PasteEventPayload
} from '../paste';
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
  extractSessionConcepts,
  setSessionLogger
} from '../sessions';
import { logError, logApiError, logInfo, logWarn, getLogChannel } from '../utils/logger';
import { getHintName, hasApiKeyConfigured } from '../utils/helpers';
import { getWebviewContent } from '../views';

export class MentorChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  // In-memory conversation history
  private _history: ChatMessage[] = [];

  // Per-task state retained on the extension host
  private _currentLevel: 1 | 2 | 3 | 4 = 1;
  private _currentTaskText: string = '';
  private _currentMode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' | 'quiz' | 'plan_review' | 'architecture' = 'task';

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
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' | 'quiz' | 'plan_review' | 'architecture';
    hintLevel: number;
    learnerVisibleText?: string;
  } | null = null;

  // Webview lifecycle readiness and queued pending requests
  private _isWebviewReady: boolean = false;
  private _pendingExplain: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingReview: { fileName: string; languageId: string; code: string } | null = null;
  private _pendingReviewStructure: boolean = false;
  private _structureConsentSessionId: string | null = null;
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
        if (!Array.isArray(this._activeSession.messages)) {
          logError('Active session has invalid messages array; resetting active session to empty');
          this._activeSession = null;
        } else {
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
            const validModes = ['explain', 'review', 'explain_back', 'paste_check', 'quiz', 'plan_review', 'architecture'];
            if (validModes.includes(lastMode)) {
              this._currentMode = lastMode as any;
            } else {
              this._currentMode = 'task';
            }
          }
        }
      }
    } catch (err) {
      logError('Failed to load active session during provider construction:', err);
      this._activeSession = null;
    }
  }

  /**
   * Resets all in-memory mentor state and reloads the webview view (Requirement 6).
   */
  public async resetAllData(): Promise<void> {
    this._activeSession = null;
    this._history = [];
    this._currentLevel = 1;
    this._currentTaskText = '';
    this._currentMode = 'task';
    this._lastRequest = null;
    this._structureConsentSessionId = null;
    this._isOnboarded = false;

    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
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
        case 'webviewError': {
          // Requirement 2: Log webview error to "Code Mentor" output channel
          const errMsg = message.message || 'Unknown webview error';
          const src = message.source ? ` (${message.source}:${message.line || 0})` : (message.line ? ` (line ${message.line})` : '');
          logError(`Webview error: ${errMsg}${src}`);
          break;
        }

        case 'ready': {
          this._isWebviewReady = true;

          // Deliver initial state to webview
          try {
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
          } catch (initErr) {
            logError('Failed to deliver initial config/apiKeyStatus in ready handler:', initErr);
          }

          let statePosted = false;

          try {
            // Check command queues first (Requirements & Handshakes)
            if (this._pendingReviewStructure) {
              this._pendingReviewStructure = false;
              statePosted = true;
              await this.reviewProjectStructure();
            } else if (this._pendingStartQuiz) {
              const pending = this._pendingStartQuiz;
              this._pendingStartQuiz = null;
              statePosted = true;
              await this.startQuiz(pending.forceIntermediate);
            } else if (this._pendingResumeLastSession) {
              this._pendingResumeLastSession = false;
              statePosted = true;
              await this.resumeLastSession();
            } else if (this._pendingShowHistory) {
              this._pendingShowHistory = false;
              statePosted = true;
              await this.showHistory();
            } else if (this._pendingNotice) {
              const notice = this._pendingNotice;
              this._pendingNotice = null;
              statePosted = true;
              this._postMessageToWebview({
                type: 'noticeMessage',
                text: notice
              });
            } else if (this._pendingExplain) {
              const pending = this._pendingExplain;
              this._pendingExplain = null;
              statePosted = true;
              await this._executeExplain(pending.fileName, pending.languageId, pending.code);
            } else if (this._pendingReview) {
              const pending = this._pendingReview;
              this._pendingReview = null;
              statePosted = true;
              await this._executeReview(pending.fileName, pending.languageId, pending.code);
            } else if (this._pendingPasteExplain) {
              const pending = this._pendingPasteExplain;
              this._pendingPasteExplain = null;
              statePosted = true;
              await this._promptPasteCheckInWebview(pending);
            } else if (this._activeSession && Array.isArray(this._activeSession.messages) && this._activeSession.messages.length > 0) {
              // Restore active session to webview (Requirements 3, 4 & 5)
              try {
                const effectiveMax = this._currentConfig.maxHintLevel;
                this._activeSession.hintLevel = Math.min(this._activeSession.hintLevel || 1, effectiveMax) as 1 | 2 | 3 | 4;
                this._currentLevel = this._activeSession.hintLevel;
                this._postMessageToWebview({
                  type: 'restore',
                  session: this._activeSession
                });
                statePosted = true;
              } catch (restoreErr) {
                logError('Failed to post restore session in ready handler:', restoreErr);
                this._activeSession = null;
                this._history = [];
                this._currentLevel = 1;
                this._currentTaskText = '';
                this._currentMode = 'task';
                statePosted = false;
              }
            }
          } catch (readyActionErr) {
            logError('Error executing pending actions in ready handler:', readyActionErr);
          }

          // Requirements 3 & 5: Ensure ready handler always posts a state message even when restore fails
          if (!statePosted) {
            try {
              this._postMessageToWebview({ type: 'taskReset' });
              this._checkAndPostWelcomeContinueCard();
            } catch (fallbackErr) {
              logError('Failed to post fallback taskReset in ready handler:', fallbackErr);
            }
          }
          break;
        }

        case 'ask': {
          // Requirement B.4: Prevent double-sends while request in flight
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this._handleUserAsk(message.text, message.hintLevel, message.action);
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

        case 'submitPlanReview': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this._handleSubmitPlanReview(message.planText);
          break;
        }

        case 'reviewStructure': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          await this.reviewProjectStructure();
          break;
        }

        case 'confirmReviewStructure': {
          if (this._isRequestInProgress) {
            return;
          }
          await this._markOnboarded();
          if (this._activeSession) {
            this._structureConsentSessionId = this._activeSession.id;
          } else {
            this._structureConsentSessionId = 'consented';
          }
          await this._performStructureReview();
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
          this._structureConsentSessionId = null;
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
   * PLAN FIRST: SUBMIT PLAN REVIEW (Requirement A)
   * ===========================================================================
   * Handles submission of learner's architectural plan before code implementation.
   * Mode: plan_review.
   * Evaluates components, HTML hierarchy, CSS layout strategy, and JS behavior.
   *
   * @param planText - The learner's submitted plan text (min 30 characters).
   */
  private async _handleSubmitPlanReview(planText: string): Promise<void> {
    const trimmedPlan = (planText || '').trim();
    if (trimmedPlan.length < 30) {
      return;
    }

    this._currentMode = 'plan_review';
    await this._markOnboarded();

    // Derive task from current task text, active session originalTask, or first user message
    const taskStr = this._currentTaskText ||
      (this._activeSession?.originalTask) ||
      (this._history.find(m => m.role === 'user')?.content) ||
      'New web project';
    const level = (this._currentConfig.mode === 'intermediate' ? 'intermediate' : 'beginner');

    // Prompt format specified in Requirement A.2
    const prompt = `Mode: plan_review\nTask: ${taskStr}\nLevel: ${level}\nLearner's plan:\n${trimmedPlan}`;

    // Pass trimmedPlan as learnerVisibleText so plan text is saved as a normal user message
    // in session (not file contents), and reply is added to session as usual (Requirement A.4)
    await this._executePrompt(prompt, 'plan_review', 1, false, trimmedPlan);
  }

  /**
   * ===========================================================================
   * REVIEW PROJECT STRUCTURE: ENTRY POINT & PRIVACY (Requirements B.1, B.3, B.6)
   * ===========================================================================
   * Command "mentor.reviewStructure" titled "Mentor: Review Project Structure".
   * Checks for an open workspace folder, requests privacy consent once per session,
   * and dispatches project structure review.
   */
  public async reviewProjectStructure(): Promise<void> {
    if (this._isRequestInProgress) {
      return;
    }

    if (!this._view || !this._isWebviewReady) {
      this._pendingReviewStructure = true;
      return;
    }

    await this._markOnboarded();

    // Requirement B.6: If there is no workspace folder, show friendly in-chat message and do NOT call LLM
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      this._postMessageToWebview({
        type: 'noticeMessage',
        text: 'Please open a project folder in VS Code to review its project structure.'
      });
      return;
    }

    // Ensure an active session exists so consent can be tracked per session
    if (!this._activeSession) {
      this._activeSession = createNewSession(
        'Project Structure Review',
        this._currentLevel,
        'Review project structure'
      );
      await setActiveSessionId(this._globalState, this._activeSession.id);
    }

    // Requirement B.3: PRIVACY - before sending, show inline confirmation once per session
    if (this._structureConsentSessionId === this._activeSession.id) {
      // Already consented in this session: proceed directly
      await this._performStructureReview();
    } else {
      // Ask learner for confirmation once per session
      this._postMessageToWebview({
        type: 'structureConsentPrompt'
      });
    }
  }

  /**
   * ===========================================================================
   * PERFORM STRUCTURE REVIEW: LLM DISPATCH (Requirements B.2, B.4, B.7)
   * ===========================================================================
   * Collects file tree and key file snippets, builds prompt, and dispatches via _executePrompt.
   */
  private async _performStructureReview(): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return;
    }

    const rootFolder = vscode.workspace.workspaceFolders[0];
    const rootUri = rootFolder.uri;

    this._currentMode = 'architecture';

    // Requirement B.7: Learner-side line in chat
    const learnerVisibleText = 'Reviewing your project structure...';
    this._postMessageToWebview({
      type: 'userMessage',
      text: learnerVisibleText
    });

    try {
      // Collect file tree and key files using vscode.workspace.fs (NO shell commands)
      const { treeText, keyFilesText } = await this._collectProjectStructure(rootUri);

      const level = (this._currentConfig.mode === 'intermediate' ? 'intermediate' : 'beginner');

      // Requirement B.2: Truncate everything to about 6000 characters total
      let structureBody = `File tree:\n${treeText}\n\nKey files:\n${keyFilesText}`;
      if (structureBody.length > 6000) {
        structureBody = structureBody.slice(0, 5920) + '\n\n... (project structure truncated to 6000 characters)';
      }

      // Requirement B.4: Prompt structure
      const prompt = `Mode: architecture\nLevel: ${level}\n${structureBody}`;

      // Dispatch request through shared _executePrompt (reuses Day 6 loading, Cancel, timeout, error & retry)
      await this._executePrompt(prompt, 'architecture', 1, false, learnerVisibleText);
    } catch (err: any) {
      logError('Failed to review project structure', err);
      this._postMessageToWebview({
        type: 'noticeMessage',
        text: 'Could not inspect workspace files for structure review.'
      });
    }
  }

  /**
   * ===========================================================================
   * PROJECT STRUCTURE COLLECTION VIA VSCODE.WORKSPACE.FS (Requirement B.2 & B.3)
   * ===========================================================================
   * Traverses workspace directory strictly using vscode.workspace.fs (NO shell commands).
   *
   * FILE COLLECTION AND EXCLUSION RULES:
   * 1. Max Depth: 3 levels from workspace root.
   * 2. Max Entries: 80 entries total across the file tree.
   * 3. Excluded Directories:
   *    - node_modules, .git, .vscode, out, dist, build
   * 4. Excluded Files:
   *    - Hidden files (starting with '.')
   *    - VSIX extension packages (.vsix)
   *    - Image files (.png, .jpg, .jpeg, .gif, .svg, .ico, .webp, .bmp, .tiff, .avif)
   * 5. Privacy & Sensitive Content Filter (Requirement B.3):
   *    - Never read files outside the workspace folder
   *    - Never include .env files (e.g. .env, .env.local, .env.production)
   *    - Never include files matching *secret*, *token*, *.pem, *.key, *.cert, *.crt, *.id_rsa
   * 6. Key Files Collection (First 40 lines of up to 5 files):
   *    - index.html (or first .html found)
   *    - Main CSS file (style.css, styles.css, index.css, app.css, or first .css)
   *    - Main script file (index.js/ts, app.js/ts, main.js/ts, App.jsx/tsx, or first script)
   *    - package.json if present
   *    - Additional key files up to 5 files max
   * 7. Total truncation to ~6000 characters.
   */
  private async _collectProjectStructure(rootUri: vscode.Uri): Promise<{ treeText: string; keyFilesText: string }> {
    const treeLines: string[] = [];
    const discoveredFiles: { name: string; relativePath: string; uri: vscode.Uri }[] = [];
    let totalEntriesCount = 0;
    const maxDepth = 3;
    const maxEntries = 80;

    /**
     * Exclusion & Sensitivity predicate implementing Requirement B.2 and B.3.
     */
    const isExcludedOrSensitive = (name: string): boolean => {
      const lower = name.toLowerCase();

      // Rule: Exclude all hidden files and hidden directories (starting with '.')
      if (name.startsWith('.')) {
        return true;
      }

      // Rule: Exclude common dependency and build output folders
      const excludedFolders = ['node_modules', 'out', 'dist', 'build', '.git', '.vscode'];
      if (excludedFolders.includes(lower)) {
        return true;
      }

      // Rule: Exclude .vsix packages
      if (lower.endsWith('.vsix')) {
        return true;
      }

      // Rule: Exclude static image binary assets
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff', '.avif'];
      if (imageExts.some(ext => lower.endsWith(ext))) {
        return true;
      }

      // Rule: Never include .env files, key files or anything matching *secret*, *token*, *.pem, *.key
      if (lower.startsWith('.env') || lower.endsWith('.env') || lower === 'env') {
        return true;
      }
      if (lower.includes('secret') || lower.includes('token')) {
        return true;
      }
      if (
        lower.endsWith('.pem') ||
        lower.endsWith('.key') ||
        lower.endsWith('.cert') ||
        lower.endsWith('.crt') ||
        lower.endsWith('.id_rsa')
      ) {
        return true;
      }

      return false;
    };

    /**
     * Recursive directory walker using vscode.workspace.fs.readDirectory.
     */
    const walkDirectory = async (currentUri: vscode.Uri, currentRelPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth || totalEntriesCount >= maxEntries) {
        return;
      }

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(currentUri);
      } catch {
        return;
      }

      // Sort directories first, then files alphabetically for consistent tree output
      entries.sort((a, b) => {
        const isDirA = (a[1] & vscode.FileType.Directory) !== 0;
        const isDirB = (b[1] & vscode.FileType.Directory) !== 0;
        if (isDirA && !isDirB) return -1;
        if (!isDirA && isDirB) return 1;
        return a[0].localeCompare(b[0]);
      });

      for (const [name, fileType] of entries) {
        if (totalEntriesCount >= maxEntries) {
          break;
        }

        if (isExcludedOrSensitive(name)) {
          continue;
        }

        const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
        const isFile = (fileType & vscode.FileType.File) !== 0;
        const relPath = currentRelPath ? `${currentRelPath}/${name}` : name;
        const entryUri = vscode.Uri.joinPath(currentUri, name);

        // Security check: strictly verify entry is within workspace folder
        if (!entryUri.fsPath.startsWith(rootUri.fsPath)) {
          continue;
        }

        totalEntriesCount++;
        const indent = '  '.repeat(depth - 1);

        if (isDirectory) {
          treeLines.push(`${indent}${name}/`);
          if (depth < maxDepth && totalEntriesCount < maxEntries) {
            await walkDirectory(entryUri, relPath, depth + 1);
          }
        } else if (isFile) {
          treeLines.push(`${indent}${name}`);
          discoveredFiles.push({
            name,
            relativePath: relPath,
            uri: entryUri
          });
        }
      }
    };

    // Start traversal at workspace root
    await walkDirectory(rootUri, '', 1);

    // Key files collection: first 40 lines of up to 5 key files
    const selectedKeyFiles: { name: string; relativePath: string; uri: vscode.Uri }[] = [];
    const addedPaths = new Set<string>();

    const addKeyFileCandidate = (file?: { name: string; relativePath: string; uri: vscode.Uri }) => {
      if (file && !addedPaths.has(file.relativePath) && selectedKeyFiles.length < 5) {
        addedPaths.add(file.relativePath);
        selectedKeyFiles.push(file);
      }
    };

    // 1. index.html or first .html file
    const indexHtml = discoveredFiles.find(f => f.name.toLowerCase() === 'index.html');
    const firstHtml = discoveredFiles.find(f => f.name.toLowerCase().endsWith('.html'));
    addKeyFileCandidate(indexHtml || firstHtml);

    // 2. Main .css file
    const mainCssNames = ['style.css', 'styles.css', 'index.css', 'app.css', 'main.css'];
    const mainCss = discoveredFiles.find(f => mainCssNames.includes(f.name.toLowerCase()));
    const firstCss = discoveredFiles.find(f => f.name.toLowerCase().endsWith('.css'));
    addKeyFileCandidate(mainCss || firstCss);

    // 3. Main .js/.ts/.jsx/.tsx file
    const mainScriptNames = ['index.js', 'index.ts', 'app.js', 'app.ts', 'main.js', 'main.ts', 'app.jsx', 'app.tsx'];
    const mainScript = discoveredFiles.find(f => mainScriptNames.includes(f.name.toLowerCase()));
    const firstScript = discoveredFiles.find(f => {
      const l = f.name.toLowerCase();
      return (l.endsWith('.js') || l.endsWith('.ts') || l.endsWith('.jsx') || l.endsWith('.tsx')) &&
        !l.endsWith('.d.ts') && !l.endsWith('.test.ts') && !l.endsWith('.spec.ts');
    });
    addKeyFileCandidate(mainScript || firstScript);

    // 4. package.json if present
    const pkgJson = discoveredFiles.find(f => f.name.toLowerCase() === 'package.json');
    addKeyFileCandidate(pkgJson);

    // 5. Fill any remaining slots up to 5 with other discovered code files
    for (const f of discoveredFiles) {
      if (selectedKeyFiles.length >= 5) break;
      addKeyFileCandidate(f);
    }

    // Read first 40 lines of up to 5 key files using vscode.workspace.fs.readFile
    const keyFilesBlocks: string[] = [];
    for (const kf of selectedKeyFiles) {
      try {
        const fileBytes = await vscode.workspace.fs.readFile(kf.uri);
        const fileContent = new TextDecoder('utf-8').decode(fileBytes);
        const first40Lines = fileContent.split(/\r?\n/).slice(0, 40).join('\n');
        keyFilesBlocks.push(`--- ${kf.relativePath} (first 40 lines) ---\n${first40Lines}`);
      } catch (readErr) {
        logError(`Failed to read key file ${kf.relativePath}`, readErr);
      }
    }

    const treeText = treeLines.join('\n') || '(no files found in workspace)';
    const keyFilesText = keyFilesBlocks.join('\n\n') || '(no key files found)';

    return { treeText, keyFilesText };
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

    // Exact prompt structure for 4-question quiz
    const prompt = `Mode: quiz\nTotal questions: 4\nLevel: ${level}\nConcepts so far: ${conceptsStr}\nTask: ${taskStr}\nLearning objectives: ${learningObjectivesStr}\nDo not repeat these questions: ${doNotRepeatStr}\nCurrent file:\n${fileSection}`;

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
    if (!Array.isArray(quiz) || quiz.length < 3) {
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
          logInfo(`Primary model "${primaryModel}" not found. Retrying quiz with fallback model "${fallbackModel}"...`);

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
        logWarn(`Quiz response failed validation on attempt 1. Retrying once with clarification...`);

        const retryClarificationPrompt = `${userMessageContent}\n\nYour previous reply was not valid quiz JSON; return exactly 4 valid questions.`;
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

      if (error instanceof MissingApiKeyError || error?.name === 'MissingApiKeyError') {
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

      const totalQuestions = result.total || 4;
      // 1. Save finished quiz evidence in globalState
      const quizResult: QuizResult = {
        ts: new Date().toISOString(),
        sessionId,
        total: totalQuestions,
        correct: result.correct,
        byConcept: result.byConcept || {}
      };
      await recordQuizResult(quizResult, this._globalState);

      // 2. Append one compact StoredMessage to the active session
      if (!this._activeSession) {
        this._activeSession = createNewSession(
          `Quiz (${result.correct}/${totalQuestions})`,
          this._currentLevel,
          this._currentTaskText
        );
        await setActiveSessionId(this._globalState, this._activeSession.id);
      } else if (this._activeSession.messages.length === 0) {
        // Update learner-visible title logic only if session has no other message
        this._activeSession.title = `Quiz (${result.correct}/${totalQuestions})`;
      }

      const summaryPayload = {
        correct: result.correct,
        total: totalQuestions,
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
      console.error('Polaris: Failed to handle quiz completion:', err);
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

  private async _handleUserAsk(userText: string, hintLevel?: number, action?: string) {
    const trimmedText = userText ? userText.trim() : '';
    if (!trimmedText) {
      return;
    }

    this._currentTaskText = trimmedText;
    this._currentMode = 'task';

    const contextBlock = this._buildEditorContextBlock();

    // Check workspace files to give the mentor awareness of existing files (e.g. index.html, style.css)
    let workspaceInfo = '';
    try {
      const uris = await vscode.workspace.findFiles('**/*.{html,css,js}', '**/node_modules/**', 15);
      if (uris.length > 0) {
        workspaceInfo = 'Project files in workspace: ' + uris.map(u => path.basename(u.fsPath)).join(', ');
      }
    } catch {
      // ignore
    }

    let userMessageContent = trimmedText;
    if (workspaceInfo) {
      userMessageContent = `${workspaceInfo}\n\n${userMessageContent}`;
    }
    if (contextBlock) {
      userMessageContent = `${contextBlock}\n\nLearner Question/Action:\n${trimmedText}`;
    }

    await this._executePrompt(userMessageContent, 'task', 1, false, trimmedText);
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
    mode: 'task' | 'explain' | 'review' | 'explain_back' | 'paste_check' | 'plan_review' | 'architecture',
    hintLevel: number,
    isRetry: boolean = false,
    learnerVisibleText?: string
  ): Promise<void> {
    if (!this._view) {
      return;
    }

    // Immediate API key validation
    if (!hasApiKeyConfigured()) {
      this._isRequestInProgress = false;
      this._postMessageToWebview({
        type: 'apiKeyStatus',
        hasApiKey: false
      });
      this._postMessageToWebview({
        type: 'friendlyError',
        message: 'Add your Gemini API key to get started.',
        action: 'openSettings',
        actionLabel: 'Set API key',
        countdown: 0
      });
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
          logInfo(`Primary model "${primaryModel}" not found. Retrying once with fallback model "${fallbackModel}"...`);

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
        console.error('Polaris: Failed to persist active session turn:', storageErr);
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

      if (error instanceof MissingApiKeyError || error?.name === 'MissingApiKeyError') {
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
      console.error('Polaris: Failed to post sessions list:', err);
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
      console.error('Polaris: Failed to check and post welcome continue card:', err);
    }
  }

  /**
   * Resumes a session by ID (Requirements 5 & 6).
   */
  public async resumeSessionById(sessionId: string): Promise<void> {
    try {
      // 1. Save current session if active and contains messages
      if (this._activeSession && Array.isArray(this._activeSession.messages) && this._activeSession.messages.length > 0) {
        try {
          await saveSession(this._globalState, this._activeSession);
        } catch (saveErr) {
          logError('Failed to save current session before resuming:', saveErr);
        }
      }

      // 2. Fetch targeted session
      const session = getSessionById(this._globalState, sessionId);
      if (!session || !Array.isArray(session.messages)) {
        this._postMessageToWebview({
          type: 'noticeMessage',
          text: 'Selected session could not be found or failed validation.'
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
      logError('Failed to resume session by ID:', err);
      this._postMessageToWebview({ type: 'taskReset' });
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
      console.error('Polaris: Failed to resume last session:', err);
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
    return getWebviewContent();
  }
}
