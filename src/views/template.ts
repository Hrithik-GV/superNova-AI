export function getWebviewHtmlBody(): string {
  return `
  <!-- Sidebar Header -->
  <div class="chat-header">
    <div class="header-top-row">
      <div class="header-title">
        <span class="header-cat-icon">🐱</span>
        <span>SUPERNOVA AI</span>
      </div>
      <div class="header-actions">
        <div class="hamburger-menu-wrapper" id="hamburger-menu-wrapper">
          <button id="hamburger-btn" class="hamburger-btn" aria-label="Open navigation menu" aria-expanded="false" title="Menu">
            <svg class="hamburger-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <div class="hamburger-dropdown" id="hamburger-dropdown" role="menu" aria-hidden="true">
            <button id="new-task-btn" class="menu-item" role="menuitem" title="Start new task and reset level">
              <span class="menu-item-icon">➕</span>
              <span class="menu-item-text">New Task</span>
            </button>
            <button id="history-toggle-btn" class="menu-item" role="menuitem" title="View past chat sessions" aria-pressed="false">
              <span class="menu-item-icon">📜</span>
              <span class="menu-item-text">Chat History</span>
            </button>
            <button id="quiz-me-btn" class="menu-item" role="menuitem" title="Take a quick quiz on concepts and your code">
              <span class="menu-item-icon">🎯</span>
              <span class="menu-item-text">Quiz Me</span>
            </button>
            <div class="menu-divider"></div>
            <button id="progress-toggle-btn" class="menu-item" role="menuitem" title="View your learned concepts" aria-pressed="false">
              <span class="menu-item-icon">📊</span>
              <span class="menu-item-text">Progress</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="course-badge-row" id="course-badge-row">
      <span class="course-badge" id="course-badge" title="Course configuration active">
        📚 Course settings active · max hint: <span id="course-max-hint-name">Solution</span>
      </span>
    </div>
  </div>

  <!-- Views (Chat, History, Progress) Layout (Requirement 1 & 5) -->

  <!-- Chat View Container (Messages Container) -->
  <div class="messages-container view-panel" id="messages-container" role="log" aria-live="polite">

    <!-- Onboarding / Welcome Card with Cat Mascot (Requirement A) -->
    <div class="welcome-card" id="welcome-card">
      <div id="welcome-normal-content">

        <!-- Cat Mentor Mascot Hero Section -->
        <div class="cat-mentor-hero">
          <div class="cat-avatar-container" id="cat-avatar-container" role="img" aria-label="Supernova AI Cat Mentor Mascot">
            <svg class="cat-svg" viewBox="0 0 160 160" width="120" height="120" xmlns="http://www.w3.org/2000/svg">
              <title>Supernova AI Cat</title>
              <style>
                .cat-svg .body {
                  animation: catFloat 2.8s ease-in-out infinite;
                  transform-origin: 80px 85px;
                }
                .cat-svg .tail {
                  transform-origin: 112px 105px;
                  animation: catWag 1.8s ease-in-out infinite;
                }
                .cat-svg .eyes-normal {
                  animation: catBlink 4.5s infinite;
                  transform-origin: 80px 76px;
                }
                .cat-svg .sparkle {
                  animation: catTwinkle 2s ease-in-out infinite;
                }
                @keyframes catFloat {
                  0%, 100% { transform: translateY(0); }
                  50% { transform: translateY(-3px); }
                }
                @keyframes catWag {
                  0%, 100% { transform: rotate(-4deg); }
                  50% { transform: rotate(7deg); }
                }
                @keyframes catBlink {
                  0%, 91%, 100% { transform: scaleY(1); }
                  94%, 97% { transform: scaleY(.08); }
                }
                @keyframes catTwinkle {
                  0%, 100% { opacity: 1; transform: scale(1); }
                  50% { opacity: .45; transform: scale(.85); }
                }
                @media (prefers-reduced-motion: reduce) {
                  .cat-svg .body, .cat-svg .tail, .cat-svg .eyes-normal, .cat-svg .sparkle { animation: none; }
                }
              </style>

              <!-- Sparkles -->
              <g class="sparkle" fill="#A78BFA">
                <path d="M24 32 L28 42 L38 46 L28 50 L24 60 L20 50 L10 46 L20 42 Z"/>
                <path d="M132 52 L135 59 L142 62 L135 65 L132 72 L129 65 L122 62 L129 59 Z" fill="#818CF8"/>
              </g>

              <!-- Shadow -->
              <ellipse cx="80" cy="144" rx="37" ry="5" fill="#312E81" opacity=".22"/>

              <!-- Tail -->
              <g class="tail">
                <path d="M103 111 C125 116 137 103 132 89 C129 80 120 83 121 91"
                      fill="none" stroke="#A5B4FC" stroke-width="13" stroke-linecap="round"/>
                <path d="M103 111 C125 116 137 103 132 89"
                      fill="none" stroke="#818CF8" stroke-width="2" stroke-linecap="round" opacity=".7"/>
              </g>

              <g class="body cat-mascot">
                <!-- Ears -->
                <path d="M39 62 L34 22 Q33 15 41 21 L66 40 Z" fill="#E0E7FF"/>
                <path d="M121 62 L126 22 Q127 15 119 21 L94 40 Z" fill="#E0E7FF"/>
                <path d="M43 47 L41 29 L58 43 Z" fill="#F9A8D4"/>
                <path d="M117 47 L119 29 L102 43 Z" fill="#F9A8D4"/>

                <!-- Head -->
                <g class="cat-head-group">
                  <path d="M33 65 C33 43 52 34 80 34 C108 34 127 43 127 65
                           L127 88 C127 112 107 126 80 126 C53 126 33 112 33 88 Z"
                        fill="#F8FAFC" stroke="#C7D2FE" stroke-width="2"/>

                  <!-- Side fur -->
                  <path d="M35 79 Q24 83 35 94 L41 91 Z" fill="#E0E7FF"/>
                  <path d="M125 79 Q136 83 125 94 L119 91 Z" fill="#E0E7FF"/>

                  <!-- Eyes -->
                  <g class="eyes">
                    <g class="eyes-normal">
                      <ellipse cx="61" cy="76" rx="8" ry="11" fill="#3730A3"/>
                      <ellipse cx="99" cy="76" rx="8" ry="11" fill="#3730A3"/>
                      <ellipse cx="63" cy="74" rx="3" ry="4" fill="#FFFFFF"/>
                      <ellipse cx="101" cy="74" rx="3" ry="4" fill="#FFFFFF"/>
                      <circle cx="57" cy="81" r="1.7" fill="#A5B4FC"/>
                      <circle cx="95" cy="81" r="1.7" fill="#A5B4FC"/>
                    </g>
                    <g class="eyes-happy" style="display: none;">
                      <path d="M53 77 Q61 68 69 77" fill="none" stroke="#3730A3" stroke-width="3" stroke-linecap="round"/>
                      <path d="M91 77 Q99 68 107 77" fill="none" stroke="#3730A3" stroke-width="3" stroke-linecap="round"/>
                    </g>
                  </g>

                  <!-- Blush -->
                  <ellipse cx="48" cy="91" rx="8" ry="4" fill="#FDA4AF" opacity=".65"/>
                  <ellipse cx="112" cy="91" rx="8" ry="4" fill="#FDA4AF" opacity=".65"/>

                  <!-- Nose and smile -->
                  <path d="M76 89 Q80 86 84 89 L80 94 Z" fill="#F472B6"/>
                  <path d="M80 94 Q76 101 71 96 M80 94 Q84 101 89 96"
                        fill="none" stroke="#64748B" stroke-width="1.8" stroke-linecap="round"/>
                </g>

                <!-- Hoodie -->
                <path d="M44 111 Q48 105 59 103 L66 100 L94 100 L101 103
                         Q112 105 116 111 L127 135 Q105 143 80 143
                         Q55 143 33 135 Z"
                      fill="#6366F1"/>
                <path d="M60 104 Q80 118 100 104 L94 100 L66 100 Z"
                      fill="#818CF8"/>
                <path d="M64 111 L69 115 M96 111 L91 115"
                      stroke="#C4B5FD" stroke-width="2" stroke-linecap="round"/>

                <!-- Star emblem -->
                <path d="M80 117 L83 124 L91 125 L85 130 L87 137
                         L80 133 L73 137 L75 130 L69 125 L77 124 Z"
                      fill="#FEF3C7"/>

                <!-- Paws -->
                <ellipse cx="52" cy="135" rx="15" ry="8" fill="#F8FAFC"/>
                <ellipse cx="108" cy="135" rx="15" ry="8" fill="#F8FAFC"/>
                <path d="M47 136 L47 139 M53 136 L53 139 M103 136 L103 139 M109 136 L109 139"
                      stroke="#C7D2FE" stroke-width="1.5" stroke-linecap="round"/>
              </g>
            </svg>
          </div>

          <!-- Dialogue Speech Bubble -->
          <div class="cat-dialogue-bubble" id="cat-dialogue-bubble">
            <div class="bubble-tag">SUPERNOVA AI MENTOR</div>
            <p id="cat-speech-text">Hi there! I'm Supernova, your AI coding companion. What exciting project or skill would you like to build today?</p>
          </div>
        </div>

        <!-- Setup Box when no API Key is set (Requirement A.2) -->
        <div class="setup-box" id="welcome-setup-box" style="display: none;">
          <div class="setup-box-header">
            <span class="setup-box-icon">🔑</span>
            <div class="setup-box-text-group">
              <div class="setup-box-title">Gemini API Key Required</div>
              <div class="setup-box-hint">Supernova AI needs a Google Gemini API key to mentor you. Get a free API key at <a href="https://aistudio.google.com" style="color: #38bdf8; text-decoration: underline;">aistudio.google.com</a>.</div>
            </div>
          </div>
          <button type="button" class="btn-set-key" id="welcome-set-key-btn">
            <span>🔑 Set Gemini API Key</span>
          </button>
        </div>

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
            <button type="button" class="prompt-chip" id="welcome-plan-first-chip">📋 Plan it first</button>
            <button type="button" class="prompt-chip" data-prompt="Build a responsive navbar">Build a responsive navbar</button>
            <button type="button" class="prompt-chip" data-prompt="Make a card with an image and title">Make a card with an image and title</button>
            <button type="button" class="prompt-chip" data-prompt="Explain the code I selected">Explain the code I selected</button>
          </div>
        </div>
        <div class="welcome-privacy">Your current file and selected code are sent to your AI provider to generate replies. Your chat history is saved on this computer only, and you can delete it any time from History.</div>
      </div>
    </div>

  </div>

  <!-- History View Panel (Sibling of Chat View, Requirement 1) -->
  <div class="history-panel view-panel" id="history-panel" hidden>
    <div class="view-header history-header">
      <div class="view-header-left">
        <button type="button" class="btn-back-chat" id="history-top-back-btn" aria-label="Back to chat">← Back to chat</button>
        <h2 class="view-title history-title" id="history-heading" tabindex="-1">📜 Chat History</h2>
      </div>
      <button type="button" class="btn-close-panel" id="close-history-btn" title="Back to chat" aria-label="Close history view">✕</button>
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

  <!-- Progress View Panel (Sibling of Chat View, Requirement 1) -->
  <div class="progress-panel view-panel" id="progress-panel" hidden>
    <div class="view-header progress-header">
      <div class="view-header-left">
        <button type="button" class="btn-back-chat" id="progress-top-back-btn" aria-label="Back to chat">← Back to chat</button>
        <h2 class="view-title progress-title" id="progress-heading" tabindex="-1">📊 Concepts Progress</h2>
      </div>
      <button type="button" class="btn-close-panel" id="close-progress-btn" title="Back to chat" aria-label="Close progress view">✕</button>
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

  <!-- Announcer for view accessibility (Requirement 4) -->
  <div id="view-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>

  <!-- Loading & Cancel Indicator (Requirement B.1 & B.2) -->
  <div class="loading-row" id="loading-row">
    <div class="loading-text-group">
      <div class="cat-mini-thinking-icon" aria-hidden="true">🐾</div>
      <div class="dots-pulse" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Supernova is thinking...</span>
    </div>
    <button type="button" class="cancel-btn" id="cancel-request-btn" aria-label="Cancel thinking request">Cancel (Esc)</button>
  </div>

  <!-- Chat Footer -->
  <div class="chat-footer" id="chat-footer">
    <!-- Plan First Inline Panel (Requirement A.1) -->
    <div class="plan-first-panel" id="plan-first-panel" style="display: none;">
      <div class="plan-first-panel-header">
        <span class="plan-first-title">📋 Plan Your Architecture First</span>
        <button type="button" class="btn-close-panel" id="close-plan-panel" aria-label="Close plan panel">✕</button>
      </div>
      <p class="plan-first-guidance">Before writing code, outline your plan: the sections or components, the HTML structure, how you will lay it out with CSS, and what JavaScript behavior you need.</p>
      <textarea id="plan-first-input" placeholder="Outline your plan (components, HTML structure, CSS layout, JS logic)..."></textarea>
      <div class="plan-first-panel-footer">
        <span class="char-count" id="plan-char-count">0 / 30 chars min</span>
        <button type="button" class="btn-submit-plan" id="submit-plan-btn" disabled>Submit Plan</button>
      </div>
    </div>

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

    <!-- Interactive Mentor Action Chips / Quick Helpers -->
    <div class="quick-helpers-bar" id="quick-helpers-bar">
      <button type="button" class="quick-chip-btn" data-action="next_step" data-prompt="Next step: what should I do next in this project?">🚀 Next Step</button>
      <button type="button" class="quick-chip-btn" data-action="show_snippet" data-prompt="Can you give me the code snippet for this step with explanation?">💡 Show Code</button>
      <button type="button" class="quick-chip-btn" data-action="quiz" data-prompt="Mode: quiz">🧠 Quick Quiz</button>
      <button type="button" class="quick-chip-btn" data-action="explain" data-prompt="Can you explain this concept in simple terms?">📖 Explain Concept</button>
      <button type="button" class="quick-chip-btn" data-action="check_code" data-prompt="Can you check my current file and see if I did it right?">✅ Check My Code</button>
    </div>

    <!-- User Input Wrapper -->
    <div class="input-wrapper">
      <textarea id="user-input" placeholder="Ask Supernova AI a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-controls">
        <span class="hint-label">Editor context included</span>
        <button id="send-btn" aria-label="Send message">Send</button>
      </div>
    </div>
  </div>`;
}
