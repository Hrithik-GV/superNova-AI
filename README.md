# Supernova AI

> An intelligent, interactive coding mentor with an animated AI companion for web developers in training.

Built by **Team Supernova**

[![GitHub Release](https://img.shields.io/github/v/release/Hrithik-GV/superNova-AI?color=blue&label=Release)](https://github.com/Hrithik-GV/superNova-AI/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/)

---

## 📦 Releases & Installation

You can install Supernova AI directly into your Visual Studio Code using the pre-built `.vsix` release package.

### Option 1: Install from GitHub Release (.vsix)

1. Head over to the official **[GitHub Releases Page](https://github.com/Hrithik-GV/superNova-AI/releases)**.
2. Download the latest release file: **`supernova-ai-0.1.0.vsix`**.
3. Install it into VS Code in either of two ways:

#### A. Graphical Interface (VS Code UI)
- Open VS Code.
- Go to the **Extensions view** (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
- Click the **`...` (Views and More Actions)** icon at the top-right corner of the Extensions pane.
- Select **Install from VSIX...**
- Browse and select the downloaded `supernova-ai-0.1.0.vsix` file.

#### B. Terminal Command
```bash
code --install-extension supernova-ai-0.1.0.vsix
```

---

### Option 2: Build & Package from Source

If you want to package the `.vsix` file yourself from source:

1. Clone the repository:
   ```bash
   git clone https://github.com/Hrithik-GV/superNova-AI.git
   cd superNova-AI
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile and generate the `.vsix` package:
   ```bash
   npm run compile
   npx @vscode/vsce package --allow-missing-repository --out supernova-ai-0.1.0.vsix
   ```
4. Install the generated `.vsix` directly:
   ```bash
   code --install-extension supernova-ai-0.1.0.vsix
   ```

---

## 💡 The Problem

Conventional AI coding assistants (like Copilot and ChatGPT) are designed to generate complete code solutions on demand. For experienced engineers, this accelerates productivity. For beginners, it does the exact opposite:
- Learners copy and paste code they don't understand.
- They bypass critical cognitive struggle and fail to build robust mental models.
- When technical interviews or real-world tasks arrive, they struggle to write code independently.

---

## 🌟 What Supernova AI Does Differently

Supernova AI is a patient, step-by-step mentor and animated cat companion that lives directly inside VS Code. Instead of writing the code for you:

1. **Interactive Step-by-Step Roadmaps**: When you start a project (e.g. *"I want to build a simple clock app with HTML, CSS, and JS"*), Supernova AI breaks it down into progressive, bite-sized milestones (Step 1: Setup & Linking, Step 2: HTML Skeleton, Step 3: CSS Layout, Step 4: JavaScript Logic) and guides you through **one step at a time**.
2. **Actionable Bullet Points & Shortcuts**: Responses are formatted in clean, scannable bullet points with practical VS Code shortcuts (such as typing `!` and pressing `Tab` for HTML5 boilerplate).
3. **Scaffolded Code Snippets on Demand**: Never leaves beginners stranded without essential syntax. Provides clean, commented snippets for the active step alongside clear explanations of *why* code belongs where it does (e.g., `<link>` in `<head>` vs `<script>` before `</body>`).
4. **Interactive Action Chips**: Contextual pill buttons (`[ 🚀 Next Step ]`, `[ 💡 Show Code ]`, `[ 🧠 Quick Quiz ]`, `[ 📖 Explain Concept ]`, `[ ✅ Check My Code ]`) allow seamless, one-click progression without manual re-typing.
5. **4-Question Interactive Quick Quiz**: Tests your real understanding with 4 multiple-choice questions on foundational web concepts (such as correct stylesheet linking syntax, script placement, and DOM manipulation).
6. **Active Recall & Comprehension Checks**: Supports "Explain it Back" (evaluating your explanation as *solid*, *partial*, or *shaky*) and non-intrusive paste detection.

---

## 🚀 Key Features

- **Interactive Step-by-Step Guidance**: Milestone tracking (`Step 1 of 4: Setup & Linking`) with project roadmaps and structured bullet points.
- **Animated Cat Companion**: An interactive pixel mascot that reacts dynamically with emotional states (Happy, Thinking, Celebrate, Curious, Idle).
- **4-Question Interactive Quiz**: Multiple-choice quizzes directly in the chat with real-time feedback, concept tracking, and mastery results.
- **Quick Helpers Bar**: Instant action chips right above the chat textarea for quick access to next steps, code snippets, quizzes, and code verification.
- **Explain Selection**: Highlight code and right-click to receive an approachable overview, line-by-line concept breakdown, and a comprehension check question.
- **Review My Code**: Constructive, holistic code reviews highlighting solid architecture and offering guiding questions rather than rewriting your file.
- **Explain It Back (Active Recall)**: Articulate how your code works in your own words to get an objective assessment with strengths and concept gaps.
- **Non-Intrusive Paste Detection**: Monitors clipboard pastes exceeding threshold limits (e.g. 5+ lines) and prompts you to explain what the code does.
- **Instructor Course Configuration (`.mentor.json`)**: Educators can tune explanation depth, target learning objectives, and configure paste sensitivity.
- **Concept & Session History**: Persistent session management and concept mastery tracking saved locally in VS Code's storage.

---

## 🏗️ Architecture & How It Works

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        VS Code Workspace                               │
│        (Active file, selection, project files, language)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Supernova AI Extension Host                         │
│         (Pedagogical System Prompt + .mentor.json rules)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Gemini LLM                               │
│       (Step roadmaps, bullets, pro-tips, snippets, quiz)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Webview Frontend UI & Cat Mascot                      │
│        - Milestone Progress Tracker & Roadmaps                         │
│        - Action Chips & Quick Helpers Bar                              │
│        - 4-Question Interactive Quick Quiz                             │
│        - Syntax-highlighted Snippets with Copy Buttons                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start (Developer Setup)

### 1. Installation & Local Run
1. Clone or download the repository:
   ```bash
   git clone https://github.com/Hrithik-GV/superNova-AI.git
   cd superNova-AI
   ```
2. In the project folder, install dependencies:
   ```bash
   npm install
   ```
3. Compile the extension:
   ```bash
   npm run compile
   ```
4. Press `F5` in VS Code to launch the **Extension Development Host**.

### 2. Configure Your Free Gemini API Key
1. Get a free API key from [Google AI Studio](https://aistudio.google.com/).
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
3. Run: **`Supernova: Test Gemini API Connection`** or open the Supernova sidebar chat to enter your key when prompted.
4. Your API key is stored safely in your local VS Code secrets store.

---

## 🛠️ Configuration (`.mentor.json`)

Instructors and learners can place an optional `.mentor.json` configuration file at the root of their workspace:

```json
{
  "mode": "beginner",
  "learningObjectives": [
    "Semantic HTML5 tags",
    "CSS Flexbox and Grid layouts",
    "DOM manipulation and event listeners"
  ],
  "pasteDetection": true,
  "pasteMinLines": 5
}
```

### Configuration Fields

| Field | Type | Description |
|---|---|---|
| `mode` | `string` (`"beginner"` or `"intermediate"`) | Tunes pedagogical depth. `"beginner"` explains all terminology with everyday analogies; `"intermediate"` highlights architecture and best practices. |
| `learningObjectives` | `string[]` (max 10) | Explicit course topics. The mentor connects advice directly to these objectives and avoids premature drift. |
| `pasteDetection` | `boolean` | Enables or disables the non-blocking paste detector. |
| `pasteMinLines` | `number` (3 to 50) | Minimum lines pasted to trigger an active recall comprehension check. |

---

## 🔒 Privacy and Safety

- **Local Storage**: Your API key and conversation sessions are stored locally in your VS Code user settings and local state. Keys are never transmitted to third-party telemetry servers.
- **Sanitized Error Reporting**: Internal diagnostics strictly redact API keys and sensitive tokens before logging.
- **In-Memory Paste Inspection**: Code pasted from the clipboard is verified in memory to check line counts and hash deduplication. Pasted code is never stored on external servers.

---

## 📁 Project Structure

```text
superNova-AI/
├── .vscode/                 # Task runner and debug launch configurations
├── resources/
│   ├── media/               # Animated pixel cat companion assets
│   └── mentor-icon.svg      # Activity bar vector icon
├── src/
│   ├── config.ts            # .mentor.json validator and configuration loader
│   ├── extension.ts         # Extension lifecycle and command registrations
│   ├── llm.ts               # Gemini SDK wrapper, schema parsing, resilience
│   ├── paste.ts             # Clipboard paste detector and active recall trigger
│   ├── progress.ts          # Concept mastery & quiz results persistence
│   ├── prompt.ts            # Pedagogical system prompt (roadmaps, bullets, quiz)
│   ├── providers/
│   │   └── mentorChatViewProvider.ts # Webview provider & session management
│   ├── utils/
│   │   ├── helpers.ts       # Shared formatting and sanitization utilities
│   │   └── logger.ts        # Output channel diagnostic logger
│   └── views/
│       ├── clientScript.ts  # Webview client controller & event handlers
│       ├── index.ts         # Webview HTML document assembler
│       ├── quizScript.ts    # 4-question interactive quiz client module
│       ├── styles.ts        # Vanilla CSS design system & animations
│       └── template.ts      # Webview HTML template & quick helpers bar
├── package.json             # Extension manifest, commands, and views
├── tsconfig.json            # TypeScript compiler configuration
└── README.md                # Project documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
