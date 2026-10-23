export function getWebviewStyles(): string {
  return `    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --sn-bg-primary: #0b0f19;
      --sn-bg-surface: #111827;
      --sn-bg-card: #162035;
      --sn-bg-card-hover: #1c2742;
      --sn-border: rgba(255, 255, 255, 0.08);
      --sn-border-focus: #a855f7;
      --sn-purple-primary: #8b5cf6;
      --sn-purple-light: #a78bfa;
      --sn-blue-cyan: #38bdf8;
      --sn-lavender: #c4b5fd;
      --sn-pink-blush: #f472b6;
      --sn-text-bright: #f8fafc;
      --sn-text-muted: #94a3b8;
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

    /* Views visibility manager (Requirement 1) */
    [hidden] {
      display: none !important;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }

    /* Accessibility focus outlines (Requirement 4) */
    button:focus-visible,
    textarea:focus-visible,
    summary:focus-visible,
    .quiz-option:focus-visible,
    [tabindex="-1"]:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    @media (forced-colors: active) {
      button:focus-visible,
      textarea:focus-visible,
      .quiz-option:focus-visible {
        outline: 2px solid Highlight;
      }
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
      position: relative;
    }

    .hamburger-menu-wrapper {
      position: relative;
      display: inline-flex;
      align-items: center;
    }

    .hamburger-btn {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      cursor: pointer;
      padding: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }

    .hamburger-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
      border-color: rgba(168, 85, 247, 0.4);
      color: #a78bfa;
    }

    .hamburger-btn[aria-expanded="true"] {
      background: rgba(99, 102, 241, 0.18);
      border-color: rgba(168, 85, 247, 0.6);
      color: #c4b5fd;
    }

    .hamburger-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 170px;
      background: var(--vscode-menu-background, #1e1e2e);
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, rgba(168, 85, 247, 0.3));
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45), 0 0 1px rgba(255, 255, 255, 0.1);
      padding: 6px;
      z-index: 1000;
      display: none;
      flex-direction: column;
      gap: 2px;
      backdrop-filter: blur(8px);
      animation: menuFadeIn 0.15s ease-out;
    }

    .hamburger-dropdown.open {
      display: flex;
    }

    @keyframes menuFadeIn {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .hamburger-dropdown .menu-item {
      background: transparent;
      border: none;
      border-radius: 5px;
      padding: 7px 10px;
      color: inherit;
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 9px;
      cursor: pointer;
      text-align: left;
      width: 100%;
      white-space: nowrap;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .hamburger-dropdown .menu-item:hover {
      background: var(--vscode-menu-selectionBackground, rgba(99, 102, 241, 0.3));
      color: var(--vscode-menu-selectionForeground, #ffffff);
    }

    .hamburger-dropdown .menu-item.active,
    .hamburger-dropdown .menu-item[aria-pressed="true"] {
      background: rgba(99, 102, 241, 0.22);
      color: #c4b5fd;
      font-weight: 600;
    }

    .hamburger-dropdown .menu-item-icon {
      font-size: 13px;
      width: 16px;
      text-align: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .hamburger-dropdown .menu-divider {
      height: 1px;
      background: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.18));
      margin: 4px 2px;
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

    /* Views (Chat, History, Progress) Layout (Requirement 1 & 5) */
    .view-panel {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .view-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      flex-shrink: 0;
    }

    .view-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .view-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      color: var(--vscode-foreground);
    }

    .view-title:focus {
      outline: none;
    }

    .btn-back-chat {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 3px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      transition: background 0.15s ease;
    }

    .btn-back-chat:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    /* Messages List */
    .messages-container {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    /* =============================================================
       ONBOARDING / WELCOME CARD & CAT MASCOT
       ============================================================= */
    .welcome-card {
      background: var(--vscode-editorWidget-background, rgba(22, 32, 53, 0.95));
      border: 1px solid var(--vscode-widget-border, rgba(168, 85, 247, 0.2));
      border-radius: 12px;
      padding: 14px 16px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }

    /* Cat Mascot Hero & Dialogue */
    .cat-mentor-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 4px 0 2px 0;
      position: relative;
    }

    .cat-avatar-container {
      position: relative;
      width: 120px;
      height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
    }

    .cat-svg {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 8px 20px rgba(139, 92, 246, 0.3));
      transition: transform 0.25s ease;
    }

    .cat-avatar-container:hover .cat-svg {
      transform: scale(1.04);
    }

    /* Idle floating */
    .cat-mascot {
      transform-origin: center bottom;
      animation: cat-float 4s ease-in-out infinite;
    }

    @keyframes cat-float {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-4px) rotate(0.6deg); }
    }

    /* Aura glow breathing */
    .cat-aura {
      animation: aura-glow 3.5s ease-in-out infinite alternate;
      transform-origin: center center;
    }

    @keyframes aura-glow {
      0% { opacity: 0.6; transform: scale(0.95); }
      100% { opacity: 1; transform: scale(1.05); }
    }

    /* Tail swaying */
    .cat-tail {
      transform-origin: 115px 125px;
      animation: tail-sway 4.5s ease-in-out infinite;
    }

    @keyframes tail-sway {
      0%, 100% { transform: rotate(0deg); }
      50% { transform: rotate(10deg); }
    }

    /* Ears gentle twitching */
    .ear-left {
      transform-origin: 45px 68px;
      animation: ear-twitch-left 6s ease-in-out infinite;
    }

    .ear-right {
      transform-origin: 115px 68px;
      animation: ear-twitch-right 6s ease-in-out infinite;
    }

    @keyframes ear-twitch-left {
      0%, 88%, 94%, 100% { transform: rotate(0deg); }
      90% { transform: rotate(-6deg); }
      92% { transform: rotate(3deg); }
    }

    @keyframes ear-twitch-right {
      0%, 85%, 91%, 100% { transform: rotate(0deg); }
      87% { transform: rotate(7deg); }
      89% { transform: rotate(-2deg); }
    }

    /* Periodic Natural Blinking */
    .eyes-normal {
      transform-origin: 80px 75px;
      animation: cat-blink 4.5s infinite;
    }

    @keyframes cat-blink {
      0%, 93%, 97%, 100% { transform: scaleY(1); }
      95% { transform: scaleY(0.08); }
    }

    /* Guiding Star Pulsing */
    .cat-star-pendant {
      animation: star-pulse 2.2s ease-in-out infinite;
      transform-origin: 80px 118px;
    }

    @keyframes star-pulse {
      0%, 100% { transform: scale(1); filter: drop-shadow(0 0 3px rgba(56, 189, 248, 0.7)); }
      50% { transform: scale(1.2); filter: drop-shadow(0 0 8px rgba(168, 85, 247, 0.95)); }
    }

    /* Sparkles Floating */
    .cat-sparkles .sparkle {
      animation: sparkle-float 3s ease-in-out infinite;
      transform-origin: center;
    }

    .sp-2 { animation-delay: 1.5s; }
    .sp-3 { animation-delay: 0.8s; }
    .sp-4 { animation-delay: 2.2s; }

    @keyframes sparkle-float {
      0%, 100% { opacity: 0.3; transform: translateY(0) scale(0.85); }
      50% { opacity: 0.95; transform: translateY(-3px) scale(1.15); }
    }

    /* Happy Celebration Reaction */
    .cat-avatar-container.happy .cat-mascot {
      animation: cat-celebrate 0.8s ease-in-out;
    }

    @keyframes cat-celebrate {
      0%, 100% { transform: translateY(0) scale(1); }
      30% { transform: translateY(-9px) scale(1.08) rotate(-3deg); }
      60% { transform: translateY(-5px) scale(1.04) rotate(3deg); }
    }

    /* Thinking State */
    .cat-avatar-container.thinking .cat-head-group {
      animation: cat-think 2s ease-in-out infinite alternate;
    }

    @keyframes cat-think {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(4deg) translateY(-2px); }
    }

    /* Dialogue Speech Bubble */
    .cat-dialogue-bubble {
      background: var(--vscode-editorWidget-background, #162035);
      border: 1px solid rgba(168, 85, 247, 0.28);
      border-radius: 12px;
      padding: 10px 14px;
      position: relative;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      width: 100%;
      text-align: center;
    }

    .cat-dialogue-bubble::before {
      content: '';
      position: absolute;
      top: -6px;
      left: 50%;
      transform: translateX(-50%) rotate(45deg);
      width: 10px;
      height: 10px;
      background: var(--vscode-editorWidget-background, #162035);
      border-top: 1px solid rgba(168, 85, 247, 0.28);
      border-left: 1px solid rgba(168, 85, 247, 0.28);
    }

    .bubble-tag {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #a78bfa;
      margin-bottom: 4px;
    }

    #cat-speech-text {
      font-size: 12px;
      line-height: 1.45;
      color: var(--vscode-foreground, #f8fafc);
      font-weight: 450;
      margin: 0;
    }

    /* Learning Goal Input Card */
    .goal-input-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: border-color 0.2s ease;
    }

    .goal-input-card:focus-within {
      border-color: rgba(168, 85, 247, 0.45);
    }

    .goal-input-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .goal-icon {
      font-size: 16px;
      line-height: 1.2;
    }

    .goal-title-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .goal-label {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vscode-foreground, #f8fafc);
    }

    .goal-sublabel {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      line-height: 1.35;
    }

    .goal-input-wrapper {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .learning-goal-input {
      width: 100%;
      background: var(--vscode-input-background, #0b0f19);
      color: var(--vscode-input-foreground, #f8fafc);
      border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .learning-goal-input:focus {
      border-color: #a855f7;
      box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.35);
    }

    .learning-goal-input.shake-error {
      border-color: #ef4444;
      animation: shake 0.4s ease-in-out;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-4px); }
      40%, 80% { transform: translateX(4px); }
    }

    .goal-validation-error {
      color: #f87171;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 8px;
      background: rgba(239, 68, 68, 0.12);
      border-radius: 4px;
      border-left: 2px solid #ef4444;
    }

    .btn-start-learning {
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: opacity 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
      box-shadow: 0 4px 14px rgba(124, 58, 237, 0.3);
    }

    .btn-start-learning:hover {
      opacity: 0.95;
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(124, 58, 237, 0.45);
    }

    .btn-start-learning:active {
      transform: translateY(0);
    }

    /* Goal Confirmation Banner */
    .goal-confirmation-banner {
      background: linear-gradient(135deg, rgba(124, 58, 237, 0.18), rgba(56, 189, 248, 0.12));
      border: 1px solid rgba(168, 85, 247, 0.4);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .banner-badge {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: #38bdf8;
    }

    .banner-body {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .banner-star {
      font-size: 16px;
    }

    .banner-details {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .banner-details h4 {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vscode-foreground, #f8fafc);
      margin: 0;
    }

    .banner-details p {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      line-height: 1.35;
      margin: 0;
    }

    .btn-edit-goal {
      background: rgba(255, 255, 255, 0.08);
      color: var(--vscode-foreground, #f8fafc);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s ease;
      align-self: flex-start;
    }

    .btn-edit-goal:hover {
      background: rgba(255, 255, 255, 0.16);
    }

    /* Roadmap Placeholder Card */
    .roadmap-card {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .roadmap-header {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .roadmap-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .roadmap-icon {
      font-size: 14px;
    }

    .roadmap-title {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--vscode-foreground, #f8fafc);
    }

    .roadmap-status-badge {
      font-size: 9.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(168, 85, 247, 0.2);
      color: #c4b5fd;
      border: 1px solid rgba(168, 85, 247, 0.35);
      margin-left: auto;
    }

    .roadmap-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      line-height: 1.35;
    }

    .roadmap-timeline {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 2px;
    }

    .roadmap-step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .step-marker {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(139, 92, 246, 0.2);
      border: 1px solid rgba(139, 92, 246, 0.5);
      color: #c4b5fd;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .step-info {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .step-name {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-foreground, #f8fafc);
    }

    .step-desc {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      line-height: 1.3;
    }

    .header-cat-icon {
      font-size: 13px;
    }

    .cat-mini-thinking-icon {
      font-size: 12px;
      animation: cat-paw-pulse 1.2s ease-in-out infinite;
    }

    @keyframes cat-paw-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.25); }
    }

    /* Accessibility Reduced Motion */
    @media (prefers-reduced-motion: reduce) {
      .cat-mascot,
      .cat-aura,
      .cat-tail,
      .ear-left,
      .ear-right,
      .eyes-normal,
      .cat-star-pendant,
      .cat-sparkles .sparkle,
      .cat-avatar-container.happy .cat-mascot,
      .cat-avatar-container.thinking .cat-head-group,
      .cat-mini-thinking-icon {
        animation: none !important;
        transform: none !important;
      }
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
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-left: 4px solid #f59e0b;
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 4px 16px rgba(245, 158, 11, 0.15);
    }

    .setup-box-header {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .setup-box-icon {
      font-size: 20px;
      line-height: 1;
      filter: drop-shadow(0 2px 6px rgba(245, 158, 11, 0.5));
    }

    .setup-box-text-group {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .setup-box-title {
      font-weight: 700;
      font-size: 13px;
      color: #fbbf24;
      letter-spacing: 0.2px;
    }

    .setup-box-hint {
      font-size: 11.5px;
      color: #e2e8f0;
      opacity: 0.95;
      line-height: 1.45;
    }

    .btn-set-key {
      align-self: flex-start;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 3px 10px rgba(217, 119, 6, 0.35);
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .btn-set-key:hover {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      transform: translateY(-1px);
      box-shadow: 0 5px 14px rgba(217, 119, 6, 0.5);
    }

    .btn-set-key:active {
      transform: translateY(0);
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

    .btn-action.danger {
      background: var(--vscode-statusBarItem-errorBackground, #c72e2e);
      color: var(--vscode-statusBarItem-errorForeground, #ffffff);
    }

    .btn-action.danger:hover:not(:disabled) {
      background: #e03e3e;
    }

    .btn-action.btn-action-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }

    .btn-action.btn-action-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
    }

    .webview-inchat-error-card {
      margin: 8px 0;
    }

    .webview-error-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
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

    /* Plan First Inline Panel (Requirement A.1) */
    .plan-first-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-focusBorder, rgba(0, 122, 204, 0.4));
      border-left: 3px solid var(--vscode-textLink-foreground, #007acc);
      border-radius: 4px;
      margin-bottom: 6px;
      animation: fadeIn 0.15s ease-in-out;
    }

    .plan-first-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .plan-first-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, inherit);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .plan-first-guidance {
      font-size: 11.5px;
      line-height: 1.45;
      opacity: 0.95;
    }

    textarea#plan-first-input {
      width: 100%;
      min-height: 68px;
      max-height: 160px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
      border-radius: 3px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--font-family);
      font-size: 12px;
      resize: vertical;
      outline: none;
      line-height: 1.4;
    }

    textarea#plan-first-input:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
    }

    .plan-first-panel-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .btn-submit-plan {
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

    .btn-submit-plan:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-submit-plan:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* Structure Privacy Consent Card (Requirement B.3) */
    .structure-consent-card {
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      animation: fadeIn 0.15s ease-in-out;
    }

    .structure-consent-header {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-foreground);
    }

    .structure-consent-text {
      font-size: 12px;
      line-height: 1.45;
      opacity: 0.95;
    }

    .structure-consent-actions {
      display: flex;
      gap: 6px;
    }

    /* Quick Helpers / Mentor Action Chips */
    .quick-helpers-bar {
      display: flex;
      gap: 5px;
      overflow-x: auto;
      padding: 2px 0 6px 0;
      scrollbar-width: none;
    }
    .quick-helpers-bar::-webkit-scrollbar {
      display: none;
    }

    .quick-chip-btn {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      border-radius: 14px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }

    .quick-chip-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
      border-color: var(--vscode-focusBorder, #007acc);
      transform: translateY(-1px);
    }

    /* Milestone Progress Tracker */
    .step-progress-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      background: var(--vscode-badge-background, rgba(0, 122, 204, 0.2));
      color: var(--vscode-badge-foreground, #3794ff);
      border: 1px solid var(--vscode-focusBorder, rgba(0, 122, 204, 0.4));
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }

    /* Project Roadmap Box */
    .mentor-roadmap-box {
      margin: 8px 0;
      padding: 8px 12px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.08));
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      border-radius: 4px;
    }

    .mentor-roadmap-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 6px;
    }

    .mentor-roadmap-list {
      margin: 0;
      padding-left: 18px;
      font-size: 11px;
      line-height: 1.6;
      color: var(--vscode-descriptionForeground, #999);
    }

    .mentor-roadmap-list li.current-step {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    /* Bullets Box */
    .mentor-bullets-box {
      margin: 8px 0;
    }

    .mentor-bullets-list {
      margin: 0;
      padding-left: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .mentor-bullet-item {
      position: relative;
      padding-left: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--vscode-foreground);
    }

    .mentor-bullet-item::before {
      content: "•";
      position: absolute;
      left: 4px;
      top: 0;
      color: var(--vscode-textLink-foreground, #3794ff);
      font-weight: bold;
      font-size: 14px;
    }

    /* Keyboard Shortcut Tag <kbd> */
    kbd {
      display: inline-block;
      padding: 1px 5px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      line-height: 1.3;
      color: var(--vscode-foreground);
      background: var(--vscode-keybindingTable-headerBackground, rgba(128, 128, 128, 0.2));
      border: 1px solid var(--vscode-keybindingTable-rowsBackground, rgba(128, 128, 128, 0.4));
      border-radius: 3px;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2);
    }

    /* Pro-tip Box */
    .pro-tip-box {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin: 8px 0;
      padding: 7px 10px;
      background: rgba(255, 193, 7, 0.1);
      border: 1px solid rgba(255, 193, 7, 0.35);
      border-radius: 4px;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--vscode-foreground);
    }

    .pro-tip-icon {
      font-weight: bold;
      color: #ffc107;
      flex-shrink: 0;
    }

    /* Action Chips in Card Footer */
    .action-chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
    }

    .action-chip-btn {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.25));
      border-radius: 12px;
      padding: 4px 11px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
      transition: all 0.15s ease;
    }

    .action-chip-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
      border-color: var(--vscode-focusBorder, #007acc);
      transform: translateY(-1px);
    }

    .action-chip-btn.primary-chip {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-button-background));
      font-weight: 600;
    }

    .action-chip-btn.primary-chip:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .insert-code-btn {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.3));
      border-radius: 3px;
      padding: 2px 7px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
      margin-left: 4px;
    }

    .insert-code-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.35));
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
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: #ffffff;
      border: none;
      padding: 6px 15px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-family: inherit;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
      transition: all 0.2s ease;
    }

    button#send-btn:hover:not(:disabled) {
      background: linear-gradient(135deg, #a78bfa, #818cf8);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.5);
    }

    button#send-btn:active:not(:disabled) {
      transform: translateY(0);
    }

    button#send-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    /* Progress Panel (Requirement F & View Switching) */
    .progress-panel {
      background: transparent;
      border: none;
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
      flex: 1;
      min-height: 0;
    }

    .progress-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 8px;
      border-radius: 3px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.06));
      font-size: 11.5px;
      gap: 6px;
    }

    .progress-item-name {
      font-weight: 500;
    }

    .progress-item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0.85;
      font-size: 10.5px;
      flex-shrink: 0;
    }

    .btn-practice-concept {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
      border: 1px solid var(--vscode-button-border, rgba(128, 128, 128, 0.2));
      color: var(--vscode-textLink-foreground, var(--vscode-button-secondaryForeground));
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-practice-concept:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
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

    /* History Panel (Requirement 6 & View Switching) */
    .history-panel {
      background: transparent;
      border: none;
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
      flex: 1;
      min-height: 0;
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
    }`;
}
