import * as vscode from 'vscode';

/**
 * Storage keys for persisting progress in extension globalState.
 */
export const CONCEPTS_STORAGE_KEY = 'mentor.concepts';
export const QUIZ_RESULTS_STORAGE_KEY = 'mentor.quizResults';

/**
 * Maximum number of quiz results preserved in history.
 */
export const MAX_QUIZ_RESULTS = 50;

/**
 * Record representing a single tracked concept.
 * Extended with optional quiz stats to preserve evidence of learning.
 */
export interface ConceptRecord {
  count: number;
  lastSeen: string; // ISO 8601 date string, e.g. "2026-10-17T15:45:00.000Z"
  quizCorrect?: number;
  quizTotal?: number;
}

/**
 * Stored map of normalized concept names to their tracking data.
 */
export type ConceptsMap = Record<string, ConceptRecord>;

/**
 * Score breakdown for an individual concept in a quiz.
 */
export interface QuizConceptScore {
  correct: number;
  total: number;
}

/**
 * Stored record of a completed 3-question quiz.
 */
export interface QuizResult {
  ts: string;
  sessionId: string;
  total: 3;
  correct: number;
  byConcept: Record<string, QuizConceptScore>;
}

// Module-level reference to VS Code globalState, set on extension activation
let _globalStateRef: vscode.Memento | undefined;

/**
 * Initializes the progress module with the extension globalState.
 * Allows getConcepts() and getQuizResults() to be invoked without arguments.
 */
export function initProgress(globalState: vscode.Memento): void {
  _globalStateRef = globalState;
}

/**
 * Normalizes concept names for consistent globalState dictionary keys:
 * - Trims surrounding whitespace
 * - Converts each word to Title Case
 * - Discards empty strings
 *
 * Examples:
 *   "flexbox" -> "Flexbox"
 *   "Flexbox " -> "Flexbox"
 *   "css grid" -> "Css Grid"
 */
export function normalizeConcept(name: string): string {
  if (!name || typeof name !== 'string') {
    return '';
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Retrieves the stored concepts object from globalState.
 * Safe against missing storage or unexpected serialization issues.
 *
 * @param globalState - Optional globalState memento; defaults to the initialized reference
 * @returns ConceptsMap object
 */
export function getConcepts(globalState?: vscode.Memento): ConceptsMap {
  try {
    const state = globalState || _globalStateRef;
    if (!state) {
      return {};
    }
    return state.get<ConceptsMap>(CONCEPTS_STORAGE_KEY, {}) || {};
  } catch (err) {
    // Storage errors must never bubble up and crash consumers
    console.error('Code Mentor: Failed to retrieve concepts from globalState:', err);
    return {};
  }
}

/**
 * Updates context.globalState with concepts extracted from a mentor reply.
 * Increments frequency count and records current ISO timestamp.
 * Preserves existing quizCorrect and quizTotal stats without loss.
 * Wrapped entirely in try/catch so storage errors never disrupt the chat.
 *
 * @param concepts - Array of concept strings from MentorReply.concept
 * @param globalState - Optional globalState memento; defaults to the initialized reference
 */
export async function saveConcepts(
  concepts: string[],
  globalState?: vscode.Memento
): Promise<void> {
  try {
    const state = globalState || _globalStateRef;
    if (!state || !Array.isArray(concepts) || concepts.length === 0) {
      return;
    }

    const currentMap: ConceptsMap = { ...(state.get<ConceptsMap>(CONCEPTS_STORAGE_KEY, {}) || {}) };
    const nowIso = new Date().toISOString();
    let hasUpdates = false;

    for (const raw of concepts) {
      const normalized = normalizeConcept(raw);
      if (!normalized) {
        continue;
      }
      const existing = currentMap[normalized];
      currentMap[normalized] = {
        count: (existing?.count || 0) + 1,
        lastSeen: nowIso,
        quizCorrect: existing?.quizCorrect || 0,
        quizTotal: existing?.quizTotal || 0
      };
      hasUpdates = true;
    }

    if (hasUpdates) {
      await state.update(CONCEPTS_STORAGE_KEY, currentMap);
    }
  } catch (err) {
    // Storage errors must never disrupt the chat or show an error bubble to the learner
    console.error('Code Mentor: Failed to save concepts to globalState:', err);
  }
}

/**
 * Retrieves all stored quiz results from globalState.
 * Safe against missing storage or unexpected serialization issues.
 *
 * @param globalState - Optional globalState memento; defaults to the initialized reference
 * @returns Array of QuizResult objects (at most 50)
 */
export function getQuizResults(globalState?: vscode.Memento): QuizResult[] {
  try {
    const state = globalState || _globalStateRef;
    if (!state) {
      return [];
    }
    const results = state.get<QuizResult[]>(QUIZ_RESULTS_STORAGE_KEY, []) || [];
    if (!Array.isArray(results)) {
      return [];
    }
    return results;
  } catch (err) {
    console.error('Code Mentor: Failed to retrieve quiz results from globalState:', err);
    return [];
  }
}

/**
 * Records a finished quiz in globalState "mentor.quizResults" (max 50 items)
 * and updates "mentor.concepts" with quizCorrect and quizTotal counts per concept.
 * Migrates old concept entries seamlessly without losing existing data.
 * Wrapped entirely in try/catch to protect callers.
 *
 * @param result - QuizResult object containing score and concept breakdown
 * @param globalState - Optional globalState memento; defaults to the initialized reference
 */
export async function recordQuizResult(
  result: QuizResult,
  globalState?: vscode.Memento
): Promise<void> {
  try {
    const state = globalState || _globalStateRef;
    if (!state || !result) {
      return;
    }

    // 1. Save to mentor.quizResults (keep at most MAX_QUIZ_RESULTS = 50)
    const existingResults = getQuizResults(state);
    const updatedResults = [result, ...existingResults].slice(0, MAX_QUIZ_RESULTS);
    await state.update(QUIZ_RESULTS_STORAGE_KEY, updatedResults);

    // 2. Increment quizCorrect and quizTotal for each concept tested
    if (result.byConcept && typeof result.byConcept === 'object') {
      const currentMap: ConceptsMap = { ...(state.get<ConceptsMap>(CONCEPTS_STORAGE_KEY, {}) || {}) };
      let hasUpdates = false;

      for (const [rawConcept, score] of Object.entries(result.byConcept)) {
        const normalized = normalizeConcept(rawConcept);
        if (!normalized || !score) {
          continue;
        }

        const existing = currentMap[normalized];
        const count = existing?.count || 0;
        const lastSeen = existing?.lastSeen || result.ts || new Date().toISOString();
        const quizCorrect = (existing?.quizCorrect || 0) + (score.correct || 0);
        const quizTotal = (existing?.quizTotal || 0) + (score.total || 0);

        currentMap[normalized] = {
          count,
          lastSeen,
          quizCorrect,
          quizTotal
        };
        hasUpdates = true;
      }

      if (hasUpdates) {
        await state.update(CONCEPTS_STORAGE_KEY, currentMap);
      }
    }
  } catch (err) {
    console.error('Code Mentor: Failed to record quiz result in globalState:', err);
  }
}

/**
 * Resets all tracked concepts in globalState.
 */
export async function clearConcepts(globalState?: vscode.Memento): Promise<void> {
  try {
    const state = globalState || _globalStateRef;
    if (state) {
      await state.update(CONCEPTS_STORAGE_KEY, {});
    }
  } catch (err) {
    console.error('Code Mentor: Failed to clear concepts from globalState:', err);
  }
}
