import * as vscode from 'vscode';

/**
 * Storage key for persisting learned concepts in extension globalState.
 */
export const CONCEPTS_STORAGE_KEY = 'mentor.concepts';

/**
 * Record representing a single tracked concept.
 */
export interface ConceptRecord {
  count: number;
  lastSeen: string; // ISO 8601 date string, e.g. "2026-10-17T15:45:00.000Z"
}

/**
 * Stored map of normalized concept names to their tracking data.
 */
export type ConceptsMap = Record<string, ConceptRecord>;

// Module-level reference to VS Code globalState, set on extension activation
let _globalStateRef: vscode.Memento | undefined;

/**
 * Initializes the progress module with the extension globalState.
 * Allows getConcepts() to be invoked without arguments on Day 5.
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
        lastSeen: nowIso
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

