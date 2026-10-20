# Polaris

> A guiding-star coding mentor for web developers in training

Built by Team Supernova

---

## The Problem

Modern AI coding assistants (like Copilot and ChatGPT) are designed to generate entire blocks of code on demand. For seasoned engineers, this accelerates development. For beginners, it does the exact opposite: learners copy and paste solutions they do not understand, skip critical cognitive struggle, and fail to build mental models or problem-solving instincts. When tests or technical interviews arrive, they cannot write code without AI assistance.

## What Polaris Does Differently

Polaris acts like a patient human instructor sitting right beside you in VS Code. Instead of writing code for you, it asks guiding questions, explains foundational concepts using plain English analogies, and breaks challenges down into small, digestible steps. It enforces a strict pedagogical rule set: it never dumps full solutions on the first ask, provides a four-level progressive hint ladder, checks your understanding through active recall ("Explain it back"), and gently detects large code pastes to ensure you actually understand what you're placing into your project.

---

## Features

- **Pedagogical Mentor Chat with Structured Replies**: Chat interface delivering cleanly structured cards featuring key concept tags, single next steps, guiding questions, and focused code snippets.
  - *TODO: retake screenshot - Polaris chat interface (`resources/screenshots/chat.png`)*
- **Four-Level Hint Ladder**: Progressively unlock help from Level 1 (conceptual nudge), Level 2 (targeted hint), Level 3 (code structure/skeleton), to Level 4 (complete annotated solution).
  - *TODO: retake screenshot - hint ladder buttons (`resources/screenshots/hint-ladder.png`)*
- **Explain Selection**: Highlight code and right-click to receive an approachable overview, line-by-line concept breakdown notes, and a comprehension check question.
  - *TODO: retake screenshot - Explain Selection view (`resources/screenshots/explain-selection.png`)*
- **Review My Code**: Request a holistic, constructive code review that praises solid structure and surfaces guiding questions instead of rewriting your file.
  - *TODO: retake screenshot - Review My Code cards (`resources/screenshots/code-review.png`)*
- **Explain It Back (Active Recall)**: Test your comprehension by explaining your code back to the mentor, receiving an objective assessment ("solid", "partial", or "shaky") with praise and identified knowledge gaps.
  - *TODO: retake screenshot - Explain It Back evaluation (`resources/screenshots/explain-back.png`)*
- **Non-Intrusive Paste Detection**: Monitors clipboard pastes exceeding threshold limits (e.g. 5+ lines) and prompts you to explain what the code does or have it explained.
  - *TODO: retake screenshot - paste detection prompt (`resources/screenshots/paste-detection.png`)*
- **Instructor Course Configuration (`.mentor.json`)**: Educators can lock maximum hint levels, tune explanation depth, target specific learning objectives, and configure paste sensitivity.
  - *TODO: retake screenshot - .mentor.json in editor (`resources/screenshots/instructor-config.png`)*
- **Concept Tracking**: Automatically extracts core web development concepts covered during sessions and records frequency and timestamps in VS Code's local storage.
  - *TODO: retake screenshot - tracked concepts badge list (`resources/screenshots/concept-tracking.png`)*

---

## How It Works

```text
┌─────────────────────────────────┐
│         Editor Context          │
│ (Active file, selection, lang)  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     Pedagogical Mentor Prompt   │
│ (Pedagogical rules + .mentor.json)
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│        Google Gemini LLM        │
│  (JSON response schema mode)    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│    Structured JSON Validation   │
│  (Sanitization + hint capping)  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│        Sidebar UI Cards         │
│ (Concepts, next steps, prompts) │
└─────────────────────────────────┘
```

**Teaching Rules Enforced by the System:**
The LLM is strictly constrained never to provide complete solutions on initial requests, to explain only one incremental step at a time, and to reference the learner's actual workspace code rather than generic templates. Guiding questions and Socratic nudges replace copy-paste auto-completion.

---

## Install (2 minutes)

1. Download `polaris-0.1.0.vsix` from the [latest release](https://github.com/Mohith824/polaris/releases/latest).
2. In VS Code (or Antigravity, Cursor and other forks): open the Extensions view → click the `...` menu → **Install from VSIX...** → choose the file.
3. Get a free API key from [Google AI Studio](https://aistudio.google.com/).
4. Open Settings, search `mentor.apiKey`, and paste your key. (Optionally set `mentor.model` to a current Flash model ID from AI Studio.)
5. Click the Polaris star in the activity bar and ask for something to build.
6. Run **Polaris: Test API Connection** if anything fails.

---

## Setup

Polaris communicates directly with Google's Gemini API (e.g. `gemini-3.5-flash-lite` or `gemini-flash-lite-latest`), which provides a generous free tier for developers and students.

1. **Get an API Key**:
   - Visit [Google AI Studio](https://aistudio.google.com/).
   - Sign in with your Google account and click **Get API key**.
   - Create a free API key and copy it to your clipboard.
2. **Configure Settings**:
   - In VS Code, open Settings (`Ctrl+,` or `Cmd+,`).
   - Search for `Polaris` (or `mentor.apiKey`).
   - Paste your key into **Polaris: Api Key** (`mentor.apiKey`).
   - *(Optional)* Adjust **Polaris: Model** (`mentor.model`) to your preferred model (default: `gemini-3.5-flash-lite`).
3. **Verify Connection**:
   - Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
   - Run **Polaris: Test API Connection**.
   - You should see a notification confirming: *"Polaris: Successfully connected to gemini-3.5-flash-lite!"*.

---

## Quick Start (Judge 2-Minute Demo)

1. **Open the Mentor Sidebar**: Click the guiding star icon in the Activity Bar or press `Ctrl+Shift+P` / `Cmd+Shift+P` and execute `Polaris: Open Chat`.
2. **Create a Test File**: Create a new file named `app.js` or `index.html`.
3. **Ask a Learning Question**: In the chat box, type:
   > *"How do I center a card horizontally and vertically on my webpage?"*
4. **Step Through the Hint Ladder**:
   - Notice the mentor provides a conceptual nudge (Level 1) and asks a guiding question about CSS layout modes.
   - Click **Hint (Level 2)** or **Structure (Level 3)** to watch the hint ladder scaffold learning without solving it instantly.
5. **Try Explain Selection**:
   - Paste this snippet into `app.js`:
     ```javascript
     const items = [1, 2, 3];
     const doubled = items.map(x => x * 2);
     ```
   - Highlight the lines, right-click, and choose **Polaris: Explain Selection**.
   - Inspect the broken-down line notes, concept badges, and comprehension check question!

---

## Instructor Configuration (`.mentor.json`)

Instructors can customize Polaris for their specific course or assignment by placing a `.mentor.json` file in the root of the student workspace repository.

To generate a sample configuration file, open the Command Palette and run:
`Polaris: Create Course Config (.mentor.json)`

### Sample Configuration

```json
{
  "maxHintLevel": 3,
  "mode": "beginner",
  "learningObjectives": [
    "Understand the CSS box model",
    "Use Flexbox for layout"
  ],
  "pasteDetection": true,
  "pasteMinLines": 5
}
```

### Configuration Fields Explained

| Field | Type | Description |
|---|---|---|
| `maxHintLevel` | `number` (1 to 4) | Caps maximum help available. Setting `3` blocks the full solution (Level 4), requiring students to write the final syntax themselves. |
| `mode` | `string` (`"beginner"` or `"intermediate"`) | Tunes pedagogical depth. `"beginner"` explains all terminology with everyday analogies; `"intermediate"` assumes syntax familiarity and highlights architecture and best practices. |
| `learningObjectives`| `string[]` (max 10) | Explicit course topics. The mentor ties advice directly to these objectives and prevents premature drift into advanced topics. |
| `pasteDetection` | `boolean` | Enables or disables the non-blocking paste detector. |
| `pasteMinLines` | `number` (3 to 50) | The minimum number of lines pasted that will trigger an active recall comprehension check. |

---

## Privacy and Safety

- **Context Sent to Provider**: When you send a message, request an explanation, or review code, only the active file's content or selected snippet is transmitted with your prompt to the configured AI provider.
- **Local Key Storage**: Your API key is stored locally in your VS Code user configuration (`settings.json`). It is never sent to any third-party telemetry server or external backend.
- **In-Memory Paste Inspection**: Code pasted from the clipboard is verified in memory to check line length and SHA-256 hash deduplication. Pasted code is never logged to disk or stored persistently.
- **Provider Data Policies**: When using Google AI Studio free tier, submitted prompts may be processed according to Google's standard developer terms. Users or institutions requiring zero data retention can configure an enterprise API key or commercial endpoint.

---

## Limitations and What's Next

### Current Limitations
- **Client-Side Key Storage**: The API key resides in the student's VS Code user settings, which is ideal for individual learners but requires each student to supply their own key.
- **Direct Client-to-API**: Operates without a middle-tier authentication or proxy server.
- **Frontend & Web Focus**: Pedagogical prompts and paste detection heuristics are currently optimized for HTML, CSS, JavaScript, TypeScript, and React.
- **LLM Non-Determinism**: Guidance quality and adherence to hint bounds depend on the underlying Gemini model's instruction following.

### Roadmap & Next Steps
- **Backend Proxy & Managed Quotas**: Add a lightweight classroom server proxy so instructors can provide centralized API keys with rate and token limits.
- **VS Code SecretStorage**: Migrate API key storage to VS Code's encrypted credential vault (`vscode.SecretStorage`).
- **Instructor Analytics Dashboard**: An opt-in summary dashboard allowing teachers to view concept mastery distributions and recurring student hurdles across classes.
- **Spaced Repetition Practice**: Turn tracked concepts in `globalState` into periodic micro-quizzes directly in the sidebar.

---

## Tech Stack and Project Structure

- **Language & Runtime**: TypeScript 5.6, Node.js (CommonJS, ES2022)
- **Editor API**: VS Code Extension API (`^1.85.0`)
- **AI Integration**: `@google/generative-ai` SDK (Google Gemini models)
- **UI Framework**: Native VS Code Webview API with Vanilla CSS Design System and message-passing architecture

### Repository Structure

```text
AI_MENTOR/
├── .vscode/               # Workspace task runner and launch configurations
├── resources/
│   ├── icon.png           # Extension marketplace icon (128x128)
│   └── mentor-icon.svg    # Activity bar vector icon
├── src/
│   ├── config.ts          # .mentor.json validator, watcher, and default template
│   ├── extension.ts       # Extension lifecycle, webview provider, message bus
│   ├── llm.ts             # Gemini SDK wrapper, JSON parsing, connectivity diagnostics
│   ├── paste.ts           # Non-blocking clipboard paste detector and deduplicator
│   ├── progress.ts        # Concept tracking and persistence in globalState
│   └── prompt.ts          # Pedagogical system prompt and hint level definitions
├── .gitignore             # Git ignore rules (node_modules, out, .env, *.vsix)
├── .vscodeignore          # Packaging ignore rules for vsce
├── CHANGELOG.md           # Release history and feature logs
├── LICENSE                # MIT license terms
├── package.json           # Extension manifest, commands, views, configuration
├── README.md              # Documentation and judge overview
└── tsconfig.json          # TypeScript compiler configuration
```

---

## License

This project is licensed under the [MIT License](LICENSE).
