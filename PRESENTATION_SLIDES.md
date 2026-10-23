# Idea Submission PPT — Team Supernova
## Problem Statement 2: AI Coding Mentor That Teaches, Not Just Generates

---

## Slide 1: Title Slide (Preserved Template)
* **Team Information:**
  * **Team Name:** Supernova
  * **Team Leader Name:** [Team Leader Name]
  * **College / Institution:** Srinivas Institute of Technology
* **Idea Information:**
  * **Selected Problem Statement:** Problem Statement 2 — AI Coding Mentor That Teaches, Not Just Generates

---

## Slide 2: PROBLEM STATEMENT

### 1. Problem Statement (Explain):
* **What problem are you solving?**
  * Modern AI coding assistants (such as ChatGPT, Copilot, etc.) act as pure "code dispensers." When a beginner asks for help building an application or debugging, these tools dump massive, finished code blocks directly into the chat.
  * This creates a severe **"illusion of competence"**: learners copy and paste working code without understanding the underlying syntax, file linking, or programming logic.
* **Why the problem is important:**
  * Software engineering demands critical problem-solving, debugging skills, and architectural understanding. Passive code generation robs aspiring developers of the opportunity to develop mental models, leading to fragile knowledge that fails in real-world scenarios and technical interviews.
* **Who is affected:**
  * Computer science students, coding bootcamp learners, self-taught developers, and educators who struggle to evaluate authentic comprehension in the age of generative AI.
* **Major limitations in the current approach:**
  * **All-or-Nothing Generation:** Existing models output entire finished files rather than scaffolding the learning process.
  * **Lack of Pedagogical Awareness:** AI does not assess whether the student knows fundamental workflows (e.g., creating files, using VS Code Emmet shortcuts like `!` + `Tab`, or linking CSS/JS).
  * **Zero Active Verification:** There is no mechanism to verify if the student actually absorbed the concept before they move to the next task.

### 2. Problem Gap (Clearly identify):
* **What existing solutions fail to address:**
  * Existing developer tools optimize strictly for *developer speed* and *code completion*, completely ignoring *pedagogy, active learning, and knowledge retention*.
* **Why a better approach is required:**
  * A true mentor does not hand over completed assignments; it provides **Socratic scaffolding**—giving small, achievable steps, targeted conceptual hints, and immediate active quizzes to ensure mastery before progression.

---

## Slide 3: PROPOSED SOLUTION & INNOVATION

### Proposed Solution in One Sentence:
> **Supernova AI** is an intelligent VS Code mentor extension that transforms the coding environment into an active learning workspace by providing step-by-step milestone guidance, on-demand micro-snippets, and in-editor interactive quizzes instead of passive full-code dumps.

### Proposed Solution:
* **How the solution works:**
  * Integrated directly into the VS Code sidebar. When a user requests a project (e.g., *"Build a simple clock app"*), Supernova breaks it into sequential, bite-sized milestones. It guides file creation and editor shortcuts first, provides micro-snippets on demand, and pauses to verify comprehension.
* **Major features:**
  * **Step-by-Step Guided Milestones:** Bullet-point roadmaps detailing *what* to do and *which* editor shortcuts to use.
  * **On-Demand Assistance Bar:** `[ 🚀 Next Step ]`, `[ 💡 Show Code ]`, `[ 📖 Explain Concept ]`, and `[ ✅ Check My Code ]`.
  * **In-Editor 4-Question Concept Quizzes:** Interactive multiple-choice questions right in the webview to validate understanding.
  * **Gamified Progress Bar:** Visual progress tracking reflecting milestone completion.
* **Expected outcome:**
  * Learners actively write their own code, understand the rationale behind every line, and build lasting problem-solving autonomy.

### Innovation:
* **AI/Automation/Data-Driven Approach:** Employs a custom-engineered pedagogical prompt pipeline leveraging **Google Gemini** that deliberately suppresses full solution dumps in favor of progressive disclosure.
* **Real-time Intelligent Scaffolding:** Dynamically generates contextual micro-code snippets and tailored 4-question quizzes based on the current step the user is working on.
* **Improved Accessibility & Efficiency:** Native VS Code webview integration eliminates context switching between browser tutorials and the code editor.
* **Distinct Advantage Over Existing Approaches:** Converts AI from a "crutch that codes for you" into a "private 1-on-1 mentor that teaches you how to code."

### Unique Value Proposition:
* **Why should this solution be developed when existing solutions already exist?**
  * Existing tools make users dependent on AI; **Supernova AI makes users independent developers**. It is built intentionally for education and active retention, filling the critical gap between passive video tutorials and over-automated AI code generators.

---

## Slide 4: SYSTEM ARCHITECTURE & TECHNOLOGY

### System Architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        VS CODE ENVIRONMENT                             │
│                                                                        │
│  ┌──────────────────────┐              ┌────────────────────────────┐  │
│  │   Active Workspace   │              │     Supernova Webview UI   │  │
│  │ (Files, Editor Tabs) │              │ (Chat, Buttons, Quiz View) │  │
│  └──────────┬───────────┘              └─────────────┬──────────────┘  │
│             │                                        │                 │
│             │ (Context)                              │ (postMessage)   │
│             ▼                                        ▼                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              Supernova Extension Core (Extension Host)           │  │
│  │  - Milestone Engine          - Progress & State Tracker          │  │
│  │  - Prompt Orchestrator       - In-Memory Chat Session Manager    │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      │ Secure HTTPS
                                      ▼
                        ┌───────────────────────────┐
                        │     Google Gemini API     │
                        │    (gemini-1.5-flash)     │
                        │  - Pedagogical Reasoning  │
                        │  - Dynamic Quiz Gen       │
                        └───────────────────────────┘
```

### Architecture Flow:
1. **User Request & Action:** User submits a learning prompt or clicks a helper action (`🚀 Next Step`, `💡 Show Code`, `🧠 Quick Quiz`) in the sidebar Webview.
2. **Extension Core Orchestration:** `MentorChatViewProvider` packages the user intent with strict pedagogical system prompts (`prompt.ts`) and milestone state.
3. **AI Reasoning Engine:** Calls Google Gemini via the official `@google/genai` SDK to generate structured step-by-step guidance or interactive quizzes.
4. **Interactive Response & State Update:** The Webview renders interactive bullet points, copy-ready micro-snippets, and functional quiz radio options while updating the live progress bar.

### Technology Stack:
* **IDE Platform:** Visual Studio Code Extension API (`vscode`)
* **Core Language:** TypeScript / JavaScript (Node.js runtime)
* **Frontend / UI:** VS Code Webview API, Vanilla CSS (Glassmorphism & VS Code theme tokens), Vanilla JavaScript
* **AI Engine:** Google Gemini API (`@google/genai` SDK — `gemini-1.5-flash` for high-speed, cost-effective tutoring)
* **Packaging & Distribution:** `@vscode/vsce` (packaged as a `.vsix` extension file)

---

## Slide 5: EXISTING VS PROPOSED SOLUTION

| Parameter | Existing Approach (ChatGPT / Copilot) | Proposed Solution (Supernova AI) |
| :--- | :--- | :--- |
| **Current Method** | Generates entire code files in one single block | Breaks project down into structured, step-by-step milestones |
| **Major Limitation** | Promotes passive copying; zero skill retention | Enforces active coding; withholds full solution until requested |
| **Existing Capability** | Code completion and text explanations | Interactive action buttons (`Show Code`, `Explain`, `Check Code`) |
| **Verification** | No assessment or testing of user understanding | Embedded 4-question interactive quizzes with live score badges |
| **Workflow Learning** | Ignores editor fundamentals | Teaches VS Code shortcuts (`!` + `Tab`), file creation, and linking |

### Impact:
* **User Benefit:** 100% active coding experience; students build their own projects with high confidence and genuine comprehension.
* **Time / Cost Reduction:** Eliminates hours spent switching between fragmented YouTube tutorials, StackOverflow, and code editors.
* **Efficiency:** Faster milestone progression through contextual on-demand hints rather than parsing bloated AI responses.
* **Accuracy:** Teaches clean coding practices, standard boilerplate conventions, and proper script/stylesheet linking from day one.
* **Measurable Outcomes:**
  * **>80% Increase** in user code authoring (vs. 100% copy-paste in generic AI).
  * **4/4 Knowledge Check Validation** before advancing through project phases.
  * **Zero Setup Friction:** Native extension installed directly inside the student's IDE.

---

## Slide 6: PROTOTYPE & IMPLEMENTATION PLAN

### Implementation Plan:
* **Phase 1: Research & Pedagogical Design (Completed)**
  * Defined Socratic mentorship rules, structured milestone triggers, and replaced the rigid 4-tier hint model with an intuitive interactive flow.
* **Phase 2: Core Extension & Webview Development (Completed)**
  * Implemented custom VS Code Webview UI with dynamic action bar (`Next Step`, `Show Code`, `Explain Concept`, `Check My Code`).
* **Phase 3: Quiz Engine & Gemini Integration (Completed)**
  * Engineered `@google/genai` backend prompt orchestration and built the client-side 4-question interactive quiz system with instant scoring.
* **Phase 4: Optimization, Packaging & Multi-Language Support (Ongoing / Next)**
  * Packaging extension into standalone `.vsix` installer, expanding quiz banks, and adding support for Python, React, and backend stacks.

### Prototype Status:
* **Prototype Status:** **Working Prototype** *(Fully functional VS Code extension with live Gemini integration, interactive quick buttons, and embedded quiz system)*
* **GitHub Repository Link:** [https://github.com/Hrithik-GV/superNova-AI.git](https://github.com/Hrithik-GV/superNova-AI.git) *(Branch: `improvement/update-ui`)*
* **Presentation Video Link:** `[Insert Public Google Drive Video Link Here]`
