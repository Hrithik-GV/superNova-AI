# Change Log

All notable changes to the "Code Mentor" extension will be documented in this file.

## [0.1.0] - 2026-10-18

### Initial Release

- **Pedagogical AI Mentor Chat**: Interactive chat interface in the activity bar with structured UI cards (concepts, next steps, guiding questions, code snippets).
- **Four-Level Hint Ladder**: Progressive hint escalation from Nudge (Level 1) to Hint (Level 2), Structure (Level 3), and Solution (Level 4).
- **Explain Selection**: Explains highlighted code with a high-level overview, breakdown into line-by-line notes, core concept tags, and follow-up comprehension checks.
- **Review My Code**: Non-destructive, educational code review identifying strengths and guiding improvement through thoughtful questions instead of automated rewrites.
- **Explain It Back**: Active recall assessments evaluating learner explanations as solid, partial, or shaky, praising correct mental models and highlighting gaps.
- **Paste Detection**: Non-blocking monitoring for substantial code pastes with clipboard verification, cooldown timer, and deduplication to prompt students for comprehension checks.
- **Instructor Configuration (`.mentor.json`)**: Flexible course tuning for hint level caps, explanation depth (beginner/intermediate), learning objectives, and paste sensitivity.
- **Concept Tracking**: Persistent local tracking in `globalState` capturing learned concepts and review frequency.
- **API Diagnostics**: Built-in "Mentor: Test API Connection" and "Mentor: Show Logs" commands for quick troubleshooting.
