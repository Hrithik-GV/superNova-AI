import { getQuizClientScript } from './quizScript';

export function getWebviewClientScript(): string {
  return `    const vscode = acquireVsCodeApi();

    // -------------------------------------------------------------------------
    // WEBVIEW ERROR MONITORING & RESILIENCE (Requirement 1)
    // -------------------------------------------------------------------------
    function formatBulletText(str) {
      if (!str) return '';
      let escaped = String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Inline code with backticks
      const bTick = String.fromCharCode(96);
      const codeParts = escaped.split(bTick);
      if (codeParts.length >= 3) {
        let res = '';
        for (let i = 0; i < codeParts.length; i++) {
          if (i % 2 === 1) {
            const code = codeParts[i];
            if (code === '!' || code === 'Tab' || code === 'Enter' || code === 'Shift' || code === 'Ctrl' || code === 'Cmd') {
              res += '<kbd>' + code + '</kbd>';
            } else {
              res += '<code>' + code + '</code>';
            }
          } else {
            res += codeParts[i];
          }
        }
        escaped = res;
      }

      // Bold with **
      const boldParts = escaped.split('**');
      if (boldParts.length >= 3) {
        let res = '';
        for (let i = 0; i < boldParts.length; i++) {
          if (i % 2 === 1) {
            res += '<strong>' + boldParts[i] + '</strong>';
          } else {
            res += boldParts[i];
          }
        }
        escaped = res;
      }

      // Newlines to <br>
      escaped = escaped.split(String.fromCharCode(10)).join('<br>');

      return escaped;
    }

    function handleActionChipClick(chip) {
      if (isLoading) return;
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }
      appendUserMessage(chip.label);
      if (chip.action === 'quiz') {
        vscode.postMessage({ type: 'startQuiz' });
        userInput.value = '';
        userInput.style.height = 'auto';
        scrollToBottom(true);
        return;
      }
      const text = chip.payload || chip.label;
      vscode.postMessage({
        type: 'ask',
        text: text,
        action: chip.action
      });
      userInput.value = '';
      userInput.style.height = 'auto';
      scrollToBottom(true);
    }

    function sanitizeErrorString(str) {
      if (!str) return '';
      return String(str)
        .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
        .replace(/AQ\\.[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
        .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
        .replace(/key=[^&\\s]+/gi, 'key=[REDACTED]');
    }

    let isHandlingWebviewError = false;
    function handleWebviewError(rawMessage, rawSource, rawLine) {
      if (isHandlingWebviewError) return;
      isHandlingWebviewError = true;
      try {
        const cleanMsg = sanitizeErrorString(rawMessage || 'Unknown webview error').slice(0, 300);
        const cleanSrc = sanitizeErrorString(rawSource || '').slice(0, 200);
        const cleanLine = typeof rawLine === 'number' ? rawLine : parseInt(rawLine, 10) || 0;

        // Post sanitized error report (never includes chat content or API keys)
        vscode.postMessage({
          type: 'webviewError',
          message: cleanMsg,
          source: cleanSrc,
          line: cleanLine
        });

        renderWebviewErrorCard();
      } catch (e) {
        console.error('Failed to report webview error:', e);
      } finally {
        isHandlingWebviewError = false;
      }
    }

    window.onerror = function(message, source, lineno, colno, error) {
      let msg = message;
      if (error && error.message) {
        msg = error.message;
      }
      handleWebviewError(msg, source, lineno);
      return false;
    };

    window.onunhandledrejection = function(event) {
      let msg = 'Unhandled promise rejection';
      let src = '';
      let line = 0;
      if (event && event.reason) {
        if (event.reason instanceof Error) {
          msg = event.reason.message || String(event.reason);
          src = event.reason.fileName || '';
          line = event.reason.lineNumber || 0;
        } else {
          msg = String(event.reason);
        }
      }
      handleWebviewError(msg, src, line);
    };

    function renderWebviewErrorCard() {
      const container = document.getElementById('messages-container');
      if (!container) return;

      const existing = container.querySelector('.webview-inchat-error-card');
      if (existing) {
        return;
      }

      const welcome = document.getElementById('welcome-card');
      if (welcome) {
        welcome.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row';

      const card = document.createElement('div');
      card.className = 'error-card webview-inchat-error-card';

      const textEl = document.createElement('div');
      textEl.className = 'error-card-text';
      textEl.textContent = 'Something went wrong in the chat view.';
      card.appendChild(textEl);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'webview-error-actions';

      // 1. "Reload chat" button (re-requests state via 'ready')
      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'btn-action';
      reloadBtn.textContent = 'Reload chat';
      reloadBtn.addEventListener('click', function() {
        row.remove();
        vscode.postMessage({ type: 'ready' });
      });
      actionsDiv.appendChild(reloadBtn);

      // 2. "Reset chat history" button (inline confirmation)
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn-action btn-action-secondary';
      resetBtn.textContent = 'Reset chat history';

      const inlineConfirm = document.createElement('span');
      inlineConfirm.className = 'delete-confirm-inline';
      inlineConfirm.style.display = 'none';

      const confirmText = document.createElement('span');
      confirmText.textContent = 'Reset chat history? ';
      inlineConfirm.appendChild(confirmText);

      const confirmYesBtn = document.createElement('button');
      confirmYesBtn.type = 'button';
      confirmYesBtn.className = 'btn-action danger';
      confirmYesBtn.textContent = 'Yes, reset';
      confirmYesBtn.addEventListener('click', function() {
        row.remove();
        vscode.postMessage({ type: 'clearAllSessions' });
      });
      inlineConfirm.appendChild(confirmYesBtn);

      const confirmCancelBtn = document.createElement('button');
      confirmCancelBtn.type = 'button';
      confirmCancelBtn.className = 'btn-action';
      confirmCancelBtn.textContent = 'Cancel';
      confirmCancelBtn.addEventListener('click', function() {
        inlineConfirm.style.display = 'none';
        resetBtn.style.display = 'inline-block';
      });
      inlineConfirm.appendChild(confirmCancelBtn);

      resetBtn.addEventListener('click', function() {
        resetBtn.style.display = 'none';
        inlineConfirm.style.display = 'inline-flex';
      });

      actionsDiv.appendChild(resetBtn);
      actionsDiv.appendChild(inlineConfirm);

      card.appendChild(actionsDiv);
      row.appendChild(card);
      container.appendChild(row);

      try {
        container.scrollTop = container.scrollHeight;
      } catch (e) {}
    }

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
    const planFirstBtn = document.getElementById('plan-first-btn');
    const reviewStructureBtn = document.getElementById('review-structure-btn');
    const welcomePlanFirstChip = document.getElementById('welcome-plan-first-chip');
    const planFirstPanel = document.getElementById('plan-first-panel');
    const closePlanPanelBtn = document.getElementById('close-plan-panel');
    const planFirstInput = document.getElementById('plan-first-input');
    const planCharCount = document.getElementById('plan-char-count');
    const submitPlanBtn = document.getElementById('submit-plan-btn');

    // Layout & View Switching Elements (Requirement 1, 4 & 5)
    const chatFooter = document.getElementById('chat-footer');
    const viewAnnouncer = document.getElementById('view-announcer');

    // Progress elements
    const progressToggleBtn = document.getElementById('progress-toggle-btn');
    const progressPanel = document.getElementById('progress-panel');
    const closeProgressBtn = document.getElementById('close-progress-btn');
    const progressTopBackBtn = document.getElementById('progress-top-back-btn');
    const progressHeading = document.getElementById('progress-heading');
    const progressList = document.getElementById('progress-list');
    const initResetProgressBtn = document.getElementById('init-reset-progress-btn');
    const resetConfirmBox = document.getElementById('reset-confirm-box');
    const confirmResetProgressBtn = document.getElementById('confirm-reset-progress-btn');
    const cancelResetProgressBtn = document.getElementById('cancel-reset-progress-btn');

    // History elements (Requirement 6 & View Switching)
    const historyToggleBtn = document.getElementById('history-toggle-btn');
    const historyPanel = document.getElementById('history-panel');
    const closeHistoryBtn = document.getElementById('close-history-btn');
    const historyTopBackBtn = document.getElementById('history-top-back-btn');
    const historyHeading = document.getElementById('history-heading');
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

    // Cat Mascot & Learning Goal elements
    const catAvatarContainer = document.getElementById('cat-avatar-container');
    const catSpeechText = document.getElementById('cat-speech-text');
    const goalInputCard = document.getElementById('goal-input-card');
    const learningGoalInput = document.getElementById('learning-goal-input');
    const startLearningBtn = document.getElementById('start-learning-btn');
    const goalValidationMsg = document.getElementById('goal-validation-msg');
    const goalConfirmationBanner = document.getElementById('goal-confirmation-banner');
    const confirmedGoalText = document.getElementById('confirmed-goal-text');
    const editGoalBtn = document.getElementById('edit-goal-btn');

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

    // View state & scroll preservation (Requirement 1 & 2)
    let currentView = 'chat';
    let savedChatScrollTop = 0;
    let savedChatWasAtBottom = true;

    function announceLive(message) {
      if (!viewAnnouncer) return;
      viewAnnouncer.textContent = '';
      setTimeout(function() {
        viewAnnouncer.textContent = message;
      }, 50);
    }

    function scrollAndFocusInline(element, focusTarget) {
      if (!element) return;
      const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const behavior = prefersReduced ? 'auto' : 'smooth';
      try {
        element.scrollIntoView({
          behavior: behavior,
          block: 'nearest'
        });
      } catch {
        element.scrollIntoView(false);
      }
      if (focusTarget) {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch {
          focusTarget.focus();
        }
      }
    }

    function showView(viewName) {
      if (viewName !== 'chat' && viewName !== 'history' && viewName !== 'progress') {
        viewName = 'chat';
      }

      if (currentView === viewName) {
        return;
      }

      // 1. If leaving chat view, save scroll position and bottom state (Requirement 2)
      if (currentView === 'chat' && messagesContainer) {
        // TEST NOTE: Save chat scroll position before leaving chat view
        // Record scrollTop and whether user was within 40px of bottom
        const threshold = 40;
        const isAtBottom = (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) <= threshold;
        savedChatScrollTop = messagesContainer.scrollTop;
        savedChatWasAtBottom = isAtBottom;
      }

      currentView = viewName;

      // 2. Update view visibility using hidden attribute (Requirement 1)
      if (messagesContainer) {
        if (viewName === 'chat') {
          messagesContainer.removeAttribute('hidden');
        } else {
          messagesContainer.setAttribute('hidden', '');
        }
      }

      if (historyPanel) {
        if (viewName === 'history') {
          historyPanel.removeAttribute('hidden');
          // TEST NOTE: Non-chat view scrollTop is reset to 0 every time it opens (Requirement 1)
          historyPanel.scrollTop = 0;
        } else {
          historyPanel.setAttribute('hidden', '');
        }
      }

      if (progressPanel) {
        if (viewName === 'progress') {
          progressPanel.removeAttribute('hidden');
          // TEST NOTE: Non-chat view scrollTop is reset to 0 every time it opens (Requirement 1)
          progressPanel.scrollTop = 0;
        } else {
          progressPanel.setAttribute('hidden', '');
        }
      }

      // 3. Hide composer while in History or Progress view (Requirement 1)
      if (chatFooter) {
        if (viewName === 'chat') {
          chatFooter.removeAttribute('hidden');
        } else {
          chatFooter.setAttribute('hidden', '');
        }
      }

      // Hide loading row if not in chat view
      if (loadingRow) {
        if (viewName === 'chat' && isLoading) {
          loadingRow.classList.add('visible');
        } else {
          loadingRow.classList.remove('visible');
        }
      }

      // 4. Update aria-pressed and active classes on header buttons (Requirement 1)
      if (historyToggleBtn) {
        historyToggleBtn.setAttribute('aria-pressed', viewName === 'history' ? 'true' : 'false');
        if (viewName === 'history') {
          historyToggleBtn.classList.add('active');
        } else {
          historyToggleBtn.classList.remove('active');
        }
      }

      if (progressToggleBtn) {
        progressToggleBtn.setAttribute('aria-pressed', viewName === 'progress' ? 'true' : 'false');
        if (viewName === 'progress') {
          progressToggleBtn.classList.add('active');
        } else {
          progressToggleBtn.classList.remove('active');
        }
      }

      // 5. Accessibility & Focus Management (Requirement 4)
      if (viewName === 'history') {
        if (historyHeading) {
          historyHeading.focus({ preventScroll: true });
        }
        announceLive('History opened');
      } else if (viewName === 'progress') {
        if (progressHeading) {
          progressHeading.focus({ preventScroll: true });
        }
        announceLive('Progress opened');
      } else if (viewName === 'chat') {
        // TEST NOTE: Restore chat scroll position upon returning to chat view (Requirement 2)
        // If it was at the bottom (within 40px), scroll to the new bottom; otherwise restore saved scrollTop
        if (savedChatWasAtBottom) {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        } else {
          messagesContainer.scrollTop = savedChatScrollTop;
        }

        if (userInput) {
          userInput.focus({ preventScroll: true });
        }
        announceLive('Chat opened');
      }
    }

    // Notify extension host that webview is ready
    vscode.postMessage({ type: 'ready' });

    // -------------------------------------------------------------------------
    // ONBOARDING & SETUP CARDS (Requirement A)
    // -------------------------------------------------------------------------
    function updateWelcomeCardUI() {
      if (!welcomeCard) return;

      if (!hasApiKey) {
        if (welcomeSetupBox) welcomeSetupBox.style.display = 'flex';
        if (catSpeechText && (!learningGoalInput || !learningGoalInput.value.trim())) {
          catSpeechText.textContent = "Hi! I'm your Supernova AI mentor. To get started, please set up your Gemini API key below! 🔑🐾";
        }
      } else {
        if (welcomeSetupBox) welcomeSetupBox.style.display = 'none';
        if (catSpeechText && (!learningGoalInput || !learningGoalInput.value.trim())) {
          catSpeechText.textContent = "Hi there! I'm Supernova, your AI coding companion. What exciting project or skill would you like to build today?";
        }
      }

      // Requirement A.3: Short version if already onboarded
      if (isOnboarded && welcomeBullets) {
        welcomeBullets.style.display = 'none';
      } else if (welcomeBullets) {
        welcomeBullets.style.display = 'flex';
      }
    }

    // Call update on webview script boot
    updateWelcomeCardUI();

    if (welcomeSetKeyBtn) {
      welcomeSetKeyBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openSettings' });
      });
    }

    // -------------------------------------------------------------------------
    // CAT MASCOT EMOTION CONTROLLER & LEARNING GOAL LOGIC
    // -------------------------------------------------------------------------
    function setCatEmotion(emotion) {
      if (!catAvatarContainer) return;
      const normalEyes = catAvatarContainer.querySelector('.eyes-normal');
      const happyEyes = catAvatarContainer.querySelector('.eyes-happy');

      catAvatarContainer.classList.remove('happy', 'thinking', 'greeting');
      if (normalEyes) normalEyes.style.display = 'block';
      if (happyEyes) happyEyes.style.display = 'none';

      if (emotion === 'happy') {
        catAvatarContainer.classList.add('happy');
        if (normalEyes) normalEyes.style.display = 'none';
        if (happyEyes) happyEyes.style.display = 'block';
      } else if (emotion === 'thinking') {
        catAvatarContainer.classList.add('thinking');
      } else if (emotion === 'greeting') {
        catAvatarContainer.classList.add('greeting');
      }
    }

    // Trigger initial friendly greeting animation
    setTimeout(function() {
      setCatEmotion('greeting');
      setTimeout(function() {
        setCatEmotion('idle');
      }, 2500);
    }, 400);

    // Mascot click reaction
    if (catAvatarContainer) {
      catAvatarContainer.addEventListener('click', function() {
        setCatEmotion('happy');
        if (catSpeechText) {
          catSpeechText.textContent = "Purr! I'm your Supernova AI coding mentor. What challenge can we tackle together?";
        }
        setTimeout(function() {
          setCatEmotion('idle');
        }, 3000);
      });
    }

    // Start Learning Button and Input Validation
    if (startLearningBtn) {
      startLearningBtn.addEventListener('click', function() {
        const goal = learningGoalInput ? learningGoalInput.value.trim() : '';
        if (!goal) {
          if (goalValidationMsg) goalValidationMsg.style.display = 'block';
          if (learningGoalInput) {
            learningGoalInput.classList.add('shake-error');
            learningGoalInput.focus();
            setTimeout(function() {
              learningGoalInput.classList.remove('shake-error');
            }, 600);
          }
          if (catSpeechText) {
            catSpeechText.textContent = "Meow! Please type a learning goal or topic first so I know what to guide you on!";
          }
          return;
        }

        // Hide validation error
        if (goalValidationMsg) goalValidationMsg.style.display = 'none';

        // Show confirmation banner
        if (confirmedGoalText) confirmedGoalText.textContent = goal;
        if (goalConfirmationBanner) goalConfirmationBanner.style.display = 'block';
        if (goalInputCard) goalInputCard.style.display = 'none';

        // Trigger Cat Happy Celebration
        setCatEmotion('happy');

        // Check API key before sending
        if (!hasApiKey) {
          if (welcomeSetupBox) {
            welcomeSetupBox.style.display = 'flex';
            welcomeSetupBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            welcomeSetupBox.classList.add('shake-error');
            setTimeout(function() {
              welcomeSetupBox.classList.remove('shake-error');
            }, 600);
          }
          if (catSpeechText) {
            catSpeechText.textContent = "Great goal! But first, please set your Gemini API key below so I can guide you! 🔑🐾";
          }
          vscode.postMessage({ type: 'openSettings' });
          return;
        }

        if (catSpeechText) {
          catSpeechText.textContent = "Awesome goal! Let's build \\"" + goal + "\\". Starting your mentoring session now! 🌟🐾";
        }

        // Fill user input with starter prompt and automatically send
        userInput.value = "I want to " + goal + ". Where should we start?";
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';

        sendMessage();
      });
    }

    if (learningGoalInput) {
      learningGoalInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (startLearningBtn) startLearningBtn.click();
        }
      });
      learningGoalInput.addEventListener('input', function() {
        if (goalValidationMsg && learningGoalInput.value.trim()) {
          goalValidationMsg.style.display = 'none';
        }
      });
    }

    if (editGoalBtn) {
      editGoalBtn.addEventListener('click', function() {
        if (goalConfirmationBanner) goalConfirmationBanner.style.display = 'none';
        if (goalInputCard) goalInputCard.style.display = 'block';
        if (learningGoalInput) {
          learningGoalInput.focus();
          learningGoalInput.select();
        }
        if (catSpeechText) {
          catSpeechText.textContent = "Feel free to refine your learning goal anytime!";
        }
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

        let tooltip = 'Instructor Settings (.mentor.json)\\\\n' +
                      'Mode: ' + config.mode + '\\\\n' +
                      'Max hint level: ' + maxAllowedHintLevel + ' (' + getHintName(maxAllowedHintLevel) + ')';
        if (Array.isArray(config.learningObjectives) && config.learningObjectives.length > 0) {
          tooltip += '\\\\n\\\\nLearning objectives:\\\\n';
          config.learningObjectives.forEach(function(obj) {
            tooltip += '• ' + obj + '\\\\n';
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
    // HISTORY VIEW (Requirement 6 & View Switching)
    // -------------------------------------------------------------------------
    if (historyToggleBtn) {
      historyToggleBtn.addEventListener('click', function() {
        if (currentView === 'history') {
          showView('chat');
        } else {
          showView('history');
          vscode.postMessage({ type: 'getSessions' });
        }
      });
    }

    if (closeHistoryBtn) {
      closeHistoryBtn.addEventListener('click', function() {
        showView('chat');
      });
    }

    if (historyTopBackBtn) {
      historyTopBackBtn.addEventListener('click', function() {
        showView('chat');
      });
    }

    if (backToChatBtn) {
      backToChatBtn.addEventListener('click', function() {
        showView('chat');
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
            chip.style.cursor = 'pointer';
            chip.title = 'Practice on ' + c;
            chip.setAttribute('aria-label', 'Practice on ' + c);
            chip.addEventListener('click', function() {
              showView('chat');
              userInput.value = 'Can you give me a practice exercise on ' + c + '?';
              userInput.focus({ preventScroll: true });
              scrollToBottom(true);
            });
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
            // Action finishes in chat (Requirement 2): switch view and scroll to bottom
            showView('chat');
            scrollToBottom(true);
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
    // PROGRESS PANEL (Requirement F & View Switching)
    // -------------------------------------------------------------------------
    if (progressToggleBtn) {
      progressToggleBtn.addEventListener('click', function() {
        if (currentView === 'progress') {
          showView('chat');
        } else {
          showView('progress');
          vscode.postMessage({ type: 'getConcepts' });
        }
      });
    }

    if (closeProgressBtn) {
      closeProgressBtn.addEventListener('click', function() {
        showView('chat');
      });
    }

    if (progressTopBackBtn) {
      progressTopBackBtn.addEventListener('click', function() {
        showView('chat');
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
        row.style.cursor = 'pointer';
        row.title = 'Practice on ' + name;
        row.addEventListener('click', function() {
          // Action finishes in chat (Requirement 2): switch view and scroll to bottom
          showView('chat');
          userInput.value = 'Can you give me a practice exercise on ' + name + '?';
          userInput.focus({ preventScroll: true });
          scrollToBottom(true);
        });

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

        const practiceBtn = document.createElement('button');
        practiceBtn.type = 'button';
        practiceBtn.className = 'btn-practice-concept';
        practiceBtn.textContent = 'Practice';
        practiceBtn.title = 'Practice on ' + name;
        practiceBtn.setAttribute('aria-label', 'Practice on ' + name);
        practiceBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          // Action finishes in chat (Requirement 2): switch view and scroll to bottom
          showView('chat');
          userInput.value = 'Can you give me a practice exercise on ' + name + '?';
          userInput.focus({ preventScroll: true });
          scrollToBottom(true);
        });

        metaSpan.appendChild(countSpan);
        metaSpan.appendChild(dateSpan);
        metaSpan.appendChild(practiceBtn);

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
        // Action finishes in chat (Requirement 2): switch view and scroll to bottom
        showView('chat');
        scrollToBottom(true);
        vscode.postMessage({ type: 'reviewFile' });
      });
    }

    if (finishFeatureBtn) {
      finishFeatureBtn.addEventListener('click', function() {
        finishFeatureBtn.style.display = 'none';
        explainBackPanel.style.display = 'flex';
        // Inline panel scroll into view & preventScroll focus (Requirement 3)
        scrollAndFocusInline(explainBackPanel, explainBackInput);
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

        appendUserMessage('Explaining my understanding:\\\\n' + text);

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
      let text = userInput.value.trim();

      // If user typed into the learning goal card instead of the chat textarea:
      if (!text && learningGoalInput && learningGoalInput.value.trim() && goalInputCard && goalInputCard.style.display !== 'none') {
        const goal = learningGoalInput.value.trim();
        if (confirmedGoalText) confirmedGoalText.textContent = goal;
        if (goalConfirmationBanner) goalConfirmationBanner.style.display = 'block';
        if (goalInputCard) goalInputCard.style.display = 'none';
        setCatEmotion('happy');
        text = "I want to " + goal + ". Where should we start?";
      }

      if (!text || isLoading) {
        return;
      }

      // Check API key before sending
      if (!hasApiKey) {
        if (welcomeSetupBox) {
          welcomeSetupBox.style.display = 'flex';
          welcomeSetupBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          welcomeSetupBox.classList.add('shake-error');
          setTimeout(function() {
            welcomeSetupBox.classList.remove('shake-error');
          }, 600);
        }
        if (catSpeechText) {
          catSpeechText.textContent = "Please set your Gemini API key first so I can answer your questions! 🔑🐾";
        }
        vscode.postMessage({ type: 'openSettings' });
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

    const quickHelpersBar = document.getElementById('quick-helpers-bar');
    if (quickHelpersBar) {
      quickHelpersBar.querySelectorAll('.quick-chip-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (isLoading) return;
          const prompt = btn.getAttribute('data-prompt');
          const action = btn.getAttribute('data-action') || 'ask';
          const label = btn.textContent || prompt;
          if (welcomeCard) {
            welcomeCard.style.display = 'none';
          }
          appendUserMessage(label);
          if (action === 'quiz') {
            vscode.postMessage({ type: 'startQuiz' });
            userInput.value = '';
            userInput.style.height = 'auto';
            scrollToBottom(true);
            return;
          }
          vscode.postMessage({
            type: 'ask',
            text: prompt,
            action: action
          });
          userInput.value = '';
          userInput.style.height = 'auto';
          scrollToBottom(true);
        });
      });
    }

    sendBtn.addEventListener('click', sendMessage);

    // Keyboard handlers (Requirement D.4 & Requirement 1: Escape returns to chat or cancels request)
    userInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (currentView !== 'chat') {
          e.preventDefault();
          showView('chat');
          return;
        }
        if (isLoading) {
          e.preventDefault();
          vscode.postMessage({ type: 'cancelRequest' });
        }
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

        // Hamburger Menu controller
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const hamburgerDropdown = document.getElementById('hamburger-dropdown');

    if (hamburgerBtn && hamburgerDropdown) {
      function toggleMenu(forceClose) {
        const isOpen = hamburgerDropdown.classList.contains('open');
        const shouldOpen = forceClose ? false : !isOpen;
        if (shouldOpen) {
          hamburgerDropdown.classList.add('open');
          hamburgerDropdown.setAttribute('aria-hidden', 'false');
          hamburgerBtn.setAttribute('aria-expanded', 'true');
        } else {
          hamburgerDropdown.classList.remove('open');
          hamburgerDropdown.setAttribute('aria-hidden', 'true');
          hamburgerBtn.setAttribute('aria-expanded', 'false');
        }
      }

      hamburgerBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleMenu();
      });

      document.addEventListener('click', function(e) {
        if (!hamburgerDropdown.contains(e.target) && !hamburgerBtn.contains(e.target)) {
          toggleMenu(true);
        }
      });

      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && hamburgerDropdown.classList.contains('open')) {
          toggleMenu(true);
          hamburgerBtn.focus();
        }
      });

      hamburgerDropdown.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', function() {
          toggleMenu(true);
        });
      });
    }

    newTaskBtn.addEventListener('click', function() {
      showView('chat');
      scrollToBottom(true);
      vscode.postMessage({ type: 'newTask' });
    });

    if (quizMeBtn) {
      quizMeBtn.addEventListener('click', function() {
        if (isLoading) return;
        showView('chat');
        scrollToBottom(true);
        vscode.postMessage({ type: 'startQuiz' });
      });
    }

    function openPlanPanel() {
      if (planFirstPanel) {
        showView('chat');
        planFirstPanel.style.display = 'flex';
        // Inline panel scroll into view & preventScroll focus (Requirement 3)
        scrollAndFocusInline(planFirstPanel, planFirstInput);
      }
    }

    function closePlanPanel() {
      if (planFirstPanel) {
        planFirstPanel.style.display = 'none';
      }
    }

    if (planFirstBtn) {
      planFirstBtn.addEventListener('click', function() {
        if (currentView !== 'chat') {
          showView('chat');
          openPlanPanel();
        } else if (planFirstPanel && planFirstPanel.style.display === 'flex') {
          closePlanPanel();
        } else {
          openPlanPanel();
        }
      });
    }

    if (welcomePlanFirstChip) {
      welcomePlanFirstChip.addEventListener('click', function() {
        showView('chat');
        openPlanPanel();
      });
    }

    if (closePlanPanelBtn) {
      closePlanPanelBtn.addEventListener('click', function() {
        closePlanPanel();
      });
    }

    if (planFirstInput) {
      planFirstInput.addEventListener('input', function() {
        const text = planFirstInput.value.trim();
        const len = text.length;
        if (planCharCount) {
          planCharCount.textContent = len + ' / 30 chars min';
        }
        if (submitPlanBtn) {
          submitPlanBtn.disabled = (len < 30) || isLoading;
        }
      });
    }

    if (submitPlanBtn) {
      submitPlanBtn.addEventListener('click', function() {
        const text = planFirstInput.value.trim();
        if (text.length < 30 || isLoading) return;
        closePlanPanel();
        appendUserMessage(text);
        vscode.postMessage({
          type: 'submitPlanReview',
          planText: text
        });
      });
    }

    if (reviewStructureBtn) {
      reviewStructureBtn.addEventListener('click', function() {
        if (isLoading) return;
        showView('chat');
        scrollToBottom(true);
        vscode.postMessage({ type: 'reviewStructure' });
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

        case 'structureConsentPrompt': {
          renderStructureConsentCard();
          break;
        }

        case 'loading': {
          setLoading(message.loading);
          break;
        }

        case 'taskReset':
        case 'historyCleared': {
          messagesContainer.innerHTML = '';
          if (welcomeCard) {
            welcomeCard.style.display = 'flex';
            if (welcomeContinueCard) {
              welcomeContinueCard.style.display = 'none';
            }
            if (goalInputCard) goalInputCard.style.display = 'block';
            if (goalConfirmationBanner) goalConfirmationBanner.style.display = 'none';
            if (learningGoalInput) learningGoalInput.value = '';
            if (confirmedGoalText) confirmedGoalText.textContent = '';
            setCatEmotion('idle');
            if (catSpeechText) {
              catSpeechText.textContent = "Hi there! I'm Supernova, your AI coding companion. What exciting project or skill would you like to build today?";
            }
            messagesContainer.appendChild(welcomeCard);
            updateWelcomeCardUI();
          }
          savedChatScrollTop = 0;
          savedChatWasAtBottom = true;
          showView('chat');
          selectHintLevel(1);
          hideSolutionConfirmation();
          userInput.value = '';
          userInput.style.height = 'auto';

          closePlanPanel();
          if (planFirstInput) {
            planFirstInput.value = '';
          }
          if (submitPlanBtn) {
            submitPlanBtn.disabled = true;
          }
          if (planCharCount) {
            planCharCount.textContent = '0 / 30 chars min';
          }

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
          try {
            // Requirement 5: Rebuild chat using live renderers
            const session = message.session;
            if (!session) {
              showView('chat');
              break;
            }

            // Switch to chat view (Requirement 2)
            showView('chat');

            // Clear existing messages from UI
            const rows = messagesContainer.querySelectorAll('.message-row, .cancelled-note, .notice-card');
            rows.forEach(function(r) { r.remove(); });

            if (welcomeCard) {
              welcomeCard.style.display = 'none';
            }

            // Restore hint level buttons
            selectHintLevel(session.hintLevel || 1);

            // Requirement 4: Rebuild chat with card renderers; unknown modes must render with plain reply card
            const knownModes = ['chat', 'task', 'explain', 'review', 'explain_back', 'paste_check', 'quiz', 'plan_review', 'architecture'];

            if (Array.isArray(session.messages)) {
              session.messages.forEach(function(msg) {
                try {
                  if (!msg || typeof msg !== 'object') {
                    return;
                  }
                  if (msg.role === 'user') {
                    appendUserMessage(msg.text || '');
                  } else if (msg.role === 'assistant') {
                    const effectiveMode = (typeof msg.mode === 'string' && knownModes.indexOf(msg.mode) !== -1)
                      ? msg.mode
                      : 'task';

                    if (effectiveMode === 'quiz') {
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
                      if (!parsed || typeof parsed !== 'object') {
                        parsed = {
                          message: String(msg.text || ''),
                          concept: [],
                          next_step: '',
                          question: null,
                          hint_level: session.hintLevel || 1
                        };
                      }
                      const renderMode = effectiveMode === 'chat' ? 'task' : effectiveMode;
                      renderMentorReplyCard(parsed, renderMode);
                    }
                  }
                } catch (msgErr) {
                  console.error('Error rendering restored message item:', msgErr);
                }
              });
            }

            hasReplies = Array.isArray(session.messages) && session.messages.some(function(m) { return m && m.role === 'assistant'; });
            if (hasReplies && explainBackSection) {
              explainBackSection.style.display = 'block';
            }

            // Scroll to newest message after restoring (Requirement 2 & 5)
            scrollToBottom(true);
          } catch (restoreErr) {
            console.error('Error restoring session in webview:', restoreErr);
            handleWebviewError(restoreErr && restoreErr.message ? restoreErr.message : 'Error restoring session');
          }
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
          showView('history');
          vscode.postMessage({ type: 'getSessions' });
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
      if (reviewStructureBtn) {
        reviewStructureBtn.disabled = loading;
      }
      if (planFirstBtn) {
        planFirstBtn.disabled = loading;
      }
      if (submitPlanBtn) {
        submitPlanBtn.disabled = loading || (planFirstInput && planFirstInput.value.trim().length < 30);
      }

      // Disable hint buttons during loading (Requirement B.1)
      for (let i = 1; i <= 4; i++) {
        if (hintBtns[i]) {
          hintBtns[i].disabled = loading || (i > maxAllowedHintLevel);
        }
      }

      // Keep textarea usable (userInput is NOT disabled)
      if (loading) {
        setCatEmotion('thinking');
        if (catSpeechText) {
          catSpeechText.textContent = "Supernova is pondering your question... I'll guide you in a moment!";
        }
        loadingRow.classList.add('visible');
        scrollToBottom(false);
      } else {
        setCatEmotion('idle');
        loadingRow.classList.remove('visible');
      }
    }

    /**
     * Requirement B.3: Inline privacy confirmation card for structure review.
     * "This sends your file names and the first lines of up to 5 files to your AI provider."
     * with "Send" and "Cancel".
     */
    function renderStructureConsentCard() {
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      const row = document.createElement('div');
      row.className = 'message-row mentor-row';

      const card = document.createElement('div');
      card.className = 'structure-consent-card';

      const header = document.createElement('div');
      header.className = 'structure-consent-header';
      header.innerHTML = '<span>🔒</span> <strong>Project Structure Review</strong>';
      card.appendChild(header);

      const text = document.createElement('div');
      text.className = 'structure-consent-text';
      text.textContent = 'This sends your file names and the first lines of up to 5 files to your AI provider.';
      card.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'structure-consent-actions';

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'btn-action';
      sendBtn.textContent = 'Send';
      sendBtn.addEventListener('click', function() {
        row.remove();
        vscode.postMessage({ type: 'confirmReviewStructure' });
      });
      actions.appendChild(sendBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', function() {
        row.remove();
      });
      actions.appendChild(cancelBtn);

      card.appendChild(actions);
      row.appendChild(card);
      messagesContainer.appendChild(row);
      scrollToBottom(true);
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
      const firstBtn = card.querySelector('button');
      // Inline panel scroll into view & preventScroll focus (Requirement 3)
      scrollAndFocusInline(card, firstBtn || card);
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
        appendUserMessage('Explaining my understanding of pasted code:\\\\n' + text);

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
      // Inline panel scroll into view & preventScroll focus (Requirement 3)
      scrollAndFocusInline(panel, textarea);
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
      const isPlanReviewMode = (mode === 'plan_review');
      const isArchitectureMode = (mode === 'architecture');
      const hideLadderControls = isExplainMode || isReviewMode || isExplainBackMode || isPasteCheckMode || isQuizMode || isPlanReviewMode || isArchitectureMode;

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
        nameSpan.textContent = 'Supernova AI (Explain)';
      } else if (isReviewMode) {
        iconSpan.textContent = '📋';
        nameSpan.textContent = 'Supernova AI (Review)';
      } else if (isPlanReviewMode) {
        iconSpan.textContent = '📋';
        nameSpan.textContent = 'Supernova AI (Plan Review)';
      } else if (isArchitectureMode) {
        iconSpan.textContent = '🏗️';
        nameSpan.textContent = 'Supernova AI (Architecture)';
      } else if (isExplainBackMode || isPasteCheckMode) {
        iconSpan.textContent = '🎯';
        nameSpan.textContent = 'Supernova AI (Understanding Check)';
      } else {
        iconSpan.textContent = '🐱';
        nameSpan.textContent = 'Supernova AI';
      }

      titleGroup.appendChild(iconSpan);
      titleGroup.appendChild(nameSpan);
      header.appendChild(titleGroup);

      if (!hideLadderControls && reply.step_info) {
        const stepBadge = document.createElement('span');
        stepBadge.className = 'step-progress-badge';
        stepBadge.textContent = 'Step ' + reply.step_info.current + ' of ' + reply.step_info.total + (reply.step_info.title ? ': ' + reply.step_info.title : '');
        header.appendChild(stepBadge);
      }

      card.appendChild(header);

      // 2. Message explanation
      if (reply.message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'mentor-message-body';
        messageEl.innerHTML = formatBulletText(reply.message);
        card.appendChild(messageEl);
      }

      // 2b. Project Roadmap
      if (Array.isArray(reply.steps) && reply.steps.length > 0) {
        const roadmapBox = document.createElement('div');
        roadmapBox.className = 'mentor-roadmap-box';
        const roadmapTitle = document.createElement('div');
        roadmapTitle.className = 'mentor-roadmap-title';
        roadmapTitle.textContent = '🗺️ Project Roadmap:';
        roadmapBox.appendChild(roadmapTitle);

        const roadmapList = document.createElement('ol');
        roadmapList.className = 'mentor-roadmap-list';
        reply.steps.forEach(function(s, idx) {
          const li = document.createElement('li');
          li.textContent = s;
          if (reply.step_info && (idx + 1) === reply.step_info.current) {
            li.className = 'current-step';
            li.textContent += '  ◀ (Current Step)';
          }
          roadmapList.appendChild(li);
        });
        roadmapBox.appendChild(roadmapList);
        card.appendChild(roadmapBox);
      }

      // 2c. Bullets List
      if (Array.isArray(reply.bullets) && reply.bullets.length > 0) {
        const bulletsBox = document.createElement('div');
        bulletsBox.className = 'mentor-bullets-box';
        const bulletsList = document.createElement('ul');
        bulletsList.className = 'mentor-bullets-list';
        reply.bullets.forEach(function(b) {
          if (typeof b === 'string' && b.trim()) {
            const li = document.createElement('li');
            li.className = 'mentor-bullet-item';
            li.innerHTML = formatBulletText(b.trim());
            bulletsList.appendChild(li);
          }
        });
        bulletsBox.appendChild(bulletsList);
        card.appendChild(bulletsBox);
      }

      // 2d. Pro Tip
      if (reply.pro_tip && reply.pro_tip.trim()) {
        const proTipBox = document.createElement('div');
        proTipBox.className = 'pro-tip-box';
        const proTipIcon = document.createElement('span');
        proTipIcon.className = 'pro-tip-icon';
        proTipIcon.textContent = '⚡ Pro-tip: ';
        const proTipText = document.createElement('span');
        proTipText.innerHTML = formatBulletText(reply.pro_tip.trim());
        proTipBox.appendChild(proTipIcon);
        proTipBox.appendChild(proTipText);
        card.appendChild(proTipBox);
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
          titleEl.textContent = isArchitectureMode ? '📁 What each file does' : '📝 Line-by-Line Breakdown';
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
          findingsTitle.textContent = isArchitectureMode ? '🏗️ Structure Observations' : (isPlanReviewMode ? '📋 Plan Review Findings' : '📋 Review Findings');
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
        let lbl = 'Code Snippet';
        if (reply.code_target_file) {
          lbl = '📄 ' + reply.code_target_file;
        } else if (reply.code_language) {
          lbl = '💻 ' + reply.code_language.toUpperCase();
        }
        codeLabel.textContent = lbl;

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
            chip.style.cursor = 'pointer';
            chip.title = 'Practice on ' + conceptName.trim();
            chip.setAttribute('aria-label', 'Practice on ' + conceptName.trim());
            chip.addEventListener('click', function() {
              // Action finishes in chat (Requirement 2): switch view and scroll to bottom
              showView('chat');
              userInput.value = 'Can you give me a practice exercise on ' + conceptName.trim() + '?';
              userInput.focus({ preventScroll: true });
              scrollToBottom(true);
            });
            conceptsBox.appendChild(chip);
          });

          card.appendChild(conceptsBox);
        }
      }

      // 10. Interactive Action Chips
      if (!hideLadderControls) {
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'action-chips-container';

        let chipsToRender = [];
        if (Array.isArray(reply.action_chips) && reply.action_chips.length > 0) {
          chipsToRender = reply.action_chips;
        } else {
          // Contextual defaults for beginner progression
          chipsToRender = [
            { label: '🚀 Next Step', action: 'next_step', payload: 'Next step: please guide me through the next part with bullet points and code.' },
            { label: '💡 Show Code Example', action: 'show_snippet', payload: 'Can you show me the code snippet for this step with explanation?' },
            { label: '📖 Explain Concept', action: 'explain', payload: 'Can you explain how this works in detail?' },
            { label: '✅ Check My Code', action: 'check_code', payload: 'Can you check my current file to see if I completed this step correctly?' }
          ];
        }

        chipsToRender.forEach(function(chip) {
          if (!chip || !chip.label) return;
          const chipBtn = document.createElement('button');
          chipBtn.type = 'button';
          chipBtn.className = 'action-chip-btn' + (chip.action === 'next_step' ? ' primary-chip' : '');
          chipBtn.textContent = chip.label;
          chipBtn.addEventListener('click', function() {
            handleActionChipClick(chip);
          });
          chipsContainer.appendChild(chipBtn);
        });

        card.appendChild(chipsContainer);
      }

      row.appendChild(card);
      messagesContainer.appendChild(row);
      setCatEmotion('happy');
      setTimeout(function() {
        setCatEmotion('idle');
      }, 2500);
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
    // Embedded modular 4-Question Quiz Client Script (from quizScript.ts)
${getQuizClientScript()}

    // Requirement D.7: Smart scroll that does not jump if user scrolled up
    function scrollToBottom(force) {
      const threshold = 100;
      const isNearBottom = (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) <= threshold;
      if (force || isNearBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }`;
}
