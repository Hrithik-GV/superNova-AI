import * as vscode from 'vscode';
import * as path from 'path';
import { testApiConnection } from './llm';
import {
  initProgress,
  clearConcepts,
  clearQuizResults,
  setProgressLogger
} from './progress';
import {
  loadConfig,
  watchConfigFile,
  createOrOpenConfigFile
} from './config';
import { registerPasteDetector } from './paste';
import {
  clearAllSessions,
  setSessionLogger
} from './sessions';
import { MentorChatViewProvider } from './providers/mentorChatViewProvider';
import { initLogger, logError, logApiError, getLogChannel } from './utils/logger';
import { hasApiKeyConfigured } from './utils/helpers';

/**
 * Activates the Supernova AI extension.
 * Sets up provider, commands, watchers, and listeners.
 */
export async function activate(context: vscode.ExtensionContext) {
  // 1. Create OutputChannel named "Supernova AI" (Requirement E.1)
  const logChannel = vscode.window.createOutputChannel('Supernova AI');
  context.subscriptions.push(logChannel);
  initLogger(logChannel);

  // Hook up diagnostic loggers to output channel
  setSessionLogger(logError);
  setProgressLogger(logError);

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
          title: 'Supernova AI: Testing Gemini API connection...'
        },
        async () => {
          const res = await testApiConnection();
          if (res.success) {
            vscode.window.showInformationMessage(`Supernova AI: ${res.message}`);
          } else {
            logApiError(res.status, res.modelUsed, 'testConnection', res.errorBody || res.message);
            vscode.window.showErrorMessage(`Supernova AI: ${res.message}`);
          }
        }
      );
    })
  );

  // Requirement E.2: "Mentor: Show Logs" command
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.showLogs', () => {
      const ch = getLogChannel();
      if (ch) {
        ch.show();
      }
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

  // Review Project Structure command (Requirement B.1): "Mentor: Review Project Structure"
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.reviewStructure', async () => {
      await vscode.commands.executeCommand('mentor.chat.focus');
      await provider.reviewProjectStructure();
    })
  );

  // Command: "Mentor: Reset All Data" (Requirement 6)
  context.subscriptions.push(
    vscode.commands.registerCommand('mentor.resetAllData', async () => {
      const selection = await vscode.window.showQuickPick(
        [
          { label: 'Yes, reset all data', description: 'Permanently clears sessions, concepts, quiz results, and onboarding flags' },
          { label: 'Cancel', description: 'Keep current data' }
        ],
        {
          placeHolder: 'Are you sure you want to reset all Supernova AI data? This cannot be undone.'
        }
      );

      if (!selection || selection.label !== 'Yes, reset all data') {
        return;
      }

      try {
        await clearAllSessions(context.globalState);
        await clearConcepts(context.globalState);
        await clearQuizResults(context.globalState);
        await context.globalState.update('mentor.onboarded', false);
        await provider.resetAllData();
        vscode.window.showInformationMessage('Supernova AI: All sessions, concepts, quiz results, and onboarding data have been reset.');
      } catch (err) {
        logError('Failed to reset all data:', err);
        vscode.window.showErrorMessage('Supernova AI: Failed to reset all data.');
      }
    })
  );
}

export function deactivate() {
  // Cleanup managed by subscriptions
}
