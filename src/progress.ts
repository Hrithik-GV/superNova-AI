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

// Optional logger hook to stream warnings & errors to the "Code Mentor" output channel
let _logger: ((msg: string, err?: any) => void) | undefined;

/**
 * Sets an external logger callback (e.g. extension logError) for progress diagnostics.
 */
export function setProgressLogger(logger: (msg: string, err?: any) => void): void {
  _logger = logger;
}

function logProgressError(msg: string, err?: any): void {
  console.error(`Code Mentor: ${msg}`, err !== undefined ? err : '');
  if (_logger) {
    _logger(msg, err);
  }
}

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
 * Wraps in try/catch and validates stored data.
 * Migrates legacy data (e.g. numeric counts), skips and logs malformed records,
 * and starts with an empty map if storage or records are corrupt.
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
    const raw = state.get<any>(CONCEPTS_STORAGE_KEY, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      logProgressError('Concepts storage is not an object; defaulting to empty concepts map');
      return {};
    }

    const validConcepts: ConceptsMap = {};
    for (const [key, val] of Object.entries(raw)) {
      try {
        const normalizedKey = normalizeConcept(key);
        if (!normalizedKey) {
          logProgressError(`Skipping concept with empty or invalid name: "${key}"`);
          continue;
        }

        // Legacy format migration: concept value stored as a single numeric frequency count
        if (typeof val === 'number' && !isNaN(val)) {
          validConcepts[normalizedKey] = {
            count: val,
            lastSeen: new Date().toISOString(),
            quizCorrect: 0,
            quizTotal: 0
          };
          continue;
        }

        // Object format validation
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const count = (val as any).count;
          const lastSeen = (val as any).lastSeen;

          if (typeof count !== 'number' || isNaN(count)) {
            logProgressError(`Skipping concept "${key}": missing or invalid numeric count`);
            continue;
          }
          if (typeof lastSeen !== 'string' || !lastSeen) {
            logProgressError(`Skipping concept "${key}": missing or invalid lastSeen timestamp`);
            continue;
          }

          const quizCorrect = typeof (val as any).quizCorrect === 'number' && !isNaN((val as any).quizCorrect)
            ? (val as any).quizCorrect
            : 0;
          const quizTotal = typeof (val as any).quizTotal === 'number' && !isNaN((val as any).quizTotal)
            ? (val as any).quizTotal
            : 0;

          validConcepts[normalizedKey] = {
            count,
            lastSeen,
            quizCorrect,
            quizTotal
          };
        } else {
          logProgressError(`Skipping concept "${key}": record has unexpected shape`);
        }
      } catch (itemErr) {
        logProgressError(`Error validating concept "${key}":`, itemErr);
      }
    }

    return validConcepts;
  } catch (err) {
    // Storage errors must never bubble up and crash consumers
    logProgressError('Failed to retrieve concepts from globalState:', err);
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

    const currentMap: ConceptsMap = { ...getConcepts(state) };
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
    logProgressError('Failed to save concepts to globalState:', err);
  }
}

/**
 * Retrieves all stored quiz results from globalState.
 * Validates each quiz result record, skips and logs corrupted items,
 * and starts with an empty list if loading fails.
 *
 * @param globalState - Optional globalState memento; defaults to the initialized reference
 * @returns Array of valid QuizResult objects (at most 50)
 */
export function getQuizResults(globalState?: vscode.Memento): QuizResult[] {
  try {
    const state = globalState || _globalStateRef;
    if (!state) {
      return [];
    }
    const raw = state.get<any[]>(QUIZ_RESULTS_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      logProgressError('Quiz results storage is not an array; defaulting to empty list');
      return [];
    }

    const validResults: QuizResult[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          logProgressError(`Skipping invalid quiz result at index ${i}: not an object`);
          continue;
        }
        if (typeof item.ts !== 'string' || !item.ts) {
          logProgressError(`Skipping invalid quiz result at index ${i}: missing or invalid "ts"`);
          continue;
        }
        if (typeof item.sessionId !== 'string') {
          logProgressError(`Skipping invalid quiz result at index ${i}: missing or invalid "sessionId"`);
          continue;
        }
        if (typeof item.total !== 'number' || isNaN(item.total)) {
          logProgressError(`Skipping invalid quiz result at index ${i}: missing or invalid "total"`);
          continue;
        }
        if (typeof item.correct !== 'number' || isNaN(item.correct)) {
          logProgressError(`Skipping invalid quiz result at index ${i}: missing or invalid "correct"`);
          continue;
        }
        if (!item.byConcept || typeof item.byConcept !== 'object' || Array.isArray(item.byConcept)) {
          logProgressError(`Skipping invalid quiz result at index ${i}: missing or invalid "byConcept"`);
          continue;
        }

        const validByConcept: Record<string, QuizConceptScore> = {};
        for (const [conceptKey, score] of Object.entries(item.byConcept)) {
          const normalizedConcept = normalizeConcept(conceptKey);
          if (normalizedConcept && score && typeof score === 'object') {
            const c = (score as any).correct;
            const t = (score as any).total;
            if (typeof c === 'number' && !isNaN(c) && typeof t === 'number' && !isNaN(t)) {
              validByConcept[normalizedConcept] = {
                correct: c,
                total: t
              };
            }
          }
        }

        validResults.push({
          ts: item.ts,
          sessionId: item.sessionId,
          total: (item.total === 3 ? 3 : item.total) as 3,
          correct: item.correct,
          byConcept: validByConcept
        });
      } catch (itemErr) {
        logProgressError(`Error validating quiz result at index ${i}:`, itemErr);
      }
    }

    return validResults;
  } catch (err) {
    logProgressError('Failed to retrieve quiz results from globalState:', err);
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
      const currentMap: ConceptsMap = { ...getConcepts(state) };
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
    logProgressError('Failed to record quiz result in globalState:', err);
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
    logProgressError('Failed to clear concepts from globalState:', err);
  }
}

/**
 * Resets all recorded quiz results in globalState.
 */
export async function clearQuizResults(globalState?: vscode.Memento): Promise<void> {
  try {
    const state = globalState || _globalStateRef;
    if (state) {
      await state.update(QUIZ_RESULTS_STORAGE_KEY, []);
    }
  } catch (err) {
    logProgressError('Failed to clear quiz results from globalState:', err);
  }
}
