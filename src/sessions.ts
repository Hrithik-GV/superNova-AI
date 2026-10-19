import * as vscode from 'vscode';
import { parseMentorReply } from './llm';

/**
 * Storage keys for persisting sessions in extension globalState.
 */
export const SESSIONS_STORAGE_KEY = 'mentor.sessions';
export const ACTIVE_SESSION_STORAGE_KEY = 'mentor.activeSessionId';

/**
 * Maximum number of sessions preserved in history (oldest dropped).
 */
export const MAX_SESSIONS = 30;

/**
 * Maximum number of messages kept per session (oldest dropped, keeping first).
 */
export const MAX_MESSAGES_PER_SESSION = 200;

/**
 * Single message stored within a persistent session.
 */
export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;            // learner text, or the raw JSON string of the mentor reply
  mode: string;            // chat | explain | review | explain_back | paste_check | quiz | plan_review | architecture
  ts: string;              // ISO date
}

/**
 * Persistent session data model representing a coding mentoring conversation.
 */
export interface Session {
  id: string;              // uuid or timestamp-based
  title: string;           // first learner message, trimmed, max 50 chars; fallback "Untitled session"
  createdAt: string;       // ISO date string
  updatedAt: string;       // ISO date string
  workspaceName: string;   // vscode.workspace.name or ''
  hintLevel: 1 | 2 | 3 | 4;
  originalTask: string;    // the task text the extension already tracks
  messages: StoredMessage[];
}

/**
 * Generates a unique session ID based on timestamp and randomness.
 */
export function generateSessionId(): string {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Formats an ISO date string into a friendly relative label:
 * "Today", "Yesterday", or a short date like "Oct 19" / "Oct 19, 2026".
 */
export function formatRelativeDate(isoDateStr: string): string {
  if (!isoDateStr) return '';
  try {
    const target = new Date(isoDateStr);
    const now = new Date();

    const isSameDay = (d1: Date, d2: Date) =>
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();

    if (isSameDay(target, now)) {
      return 'Today';
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(target, yesterday)) {
      return 'Yesterday';
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[target.getMonth()];
    const day = target.getDate();

    if (target.getFullYear() === now.getFullYear()) {
      return `${month} ${day}`;
    }
    return `${month} ${day}, ${target.getFullYear()}`;
  } catch {
    return isoDateStr.slice(0, 10);
  }
}

/**
 * Extracts up to 3 core concept names from the assistant replies in a session.
 */
export function extractSessionConcepts(session: Session, limit: number = 3): string[] {
  if (!session || !Array.isArray(session.messages)) {
    return [];
  }

  const seen = new Set<string>();
  const concepts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === 'assistant' && msg.text) {
      try {
        const parsed = parseMentorReply(msg.text);
        if (Array.isArray(parsed.concept)) {
          for (const c of parsed.concept) {
            const clean = (c || '').trim();
            if (clean && !seen.has(clean.toLowerCase())) {
              seen.add(clean.toLowerCase());
              concepts.push(clean);
              if (concepts.length >= limit) {
                return concepts;
              }
            }
          }
        }
      } catch {
        // Ignore unparseable entries
      }
    }
  }

  return concepts;
}

/**
 * Retrieves all stored sessions from globalState, sorted newest first by updatedAt.
 * Wrapped in try/catch to protect callers from storage issues.
 */
export function getAllSessions(globalState: vscode.Memento): Session[] {
  try {
    const raw = globalState.get<Session[]>(SESSIONS_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.sort((a, b) => {
      const ta = new Date(b.updatedAt || b.createdAt || 0).getTime();
      const tb = new Date(a.updatedAt || a.createdAt || 0).getTime();
      return ta - tb;
    });
  } catch (err) {
    console.error('Code Mentor: Failed to load sessions from globalState:', err);
    return [];
  }
}

/**
 * Retrieves the currently active session ID from globalState.
 */
export function getActiveSessionId(globalState: vscode.Memento): string | null {
  try {
    return globalState.get<string | null>(ACTIVE_SESSION_STORAGE_KEY, null);
  } catch {
    return null;
  }
}

/**
 * Sets or clears the active session ID in globalState.
 */
export async function setActiveSessionId(globalState: vscode.Memento, sessionId: string | null): Promise<void> {
  try {
    await globalState.update(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } catch (err) {
    console.error('Code Mentor: Failed to update active session ID in globalState:', err);
  }
}

/**
 * Retrieves a single session by ID from globalState.
 */
export function getSessionById(globalState: vscode.Memento, sessionId: string): Session | null {
  try {
    const sessions = getAllSessions(globalState);
    return sessions.find(s => s.id === sessionId) || null;
  } catch {
    return null;
  }
}

/**
 * Retrieves the currently active session from globalState.
 */
export function getActiveSession(globalState: vscode.Memento): Session | null {
  const activeId = getActiveSessionId(globalState);
  if (!activeId) return null;
  return getSessionById(globalState, activeId);
}

/**
 * Creates a new Session object with initial metadata.
 * Title is derived from first user message (max 50 chars), fallback "Untitled session".
 */
export function createNewSession(
  firstLearnerText: string,
  hintLevel: 1 | 2 | 3 | 4 = 1,
  originalTask: string = ''
): Session {
  const now = new Date().toISOString();
  let title = (firstLearnerText || '').trim();
  if (title) {
    // Slice at 50 chars, clean linebreaks
    title = title.replace(/\s+/g, ' ').slice(0, 50).trim();
  }
  if (!title) {
    title = 'Untitled session';
  }

  return {
    id: generateSessionId(),
    title,
    createdAt: now,
    updatedAt: now,
    workspaceName: vscode.workspace.name || '',
    hintLevel,
    originalTask: (originalTask || '').trim(),
    messages: []
  };
}

/**
 * Saves or updates a session in globalState.
 * Enforces constraints:
 * - Max 200 messages per session (dropping oldest, preserving messages[0] for title context)
 * - Max 30 sessions across storage (dropping oldest)
 */
export async function saveSession(globalState: vscode.Memento, session: Session): Promise<void> {
  try {
    if (!session || !session.id) {
      return;
    }

    // Enforce message limits: max 200 messages, keeping the first message for title
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      const firstMessage = session.messages[0];
      const recentMessages = session.messages.slice(session.messages.length - (MAX_MESSAGES_PER_SESSION - 1));
      session.messages = [firstMessage, ...recentMessages];
    }

    session.updatedAt = new Date().toISOString();

    const existingSessions = getAllSessions(globalState);
    const index = existingSessions.findIndex(s => s.id === session.id);

    if (index >= 0) {
      existingSessions[index] = session;
    } else {
      existingSessions.unshift(session);
    }

    // Sort newest first by updatedAt
    existingSessions.sort((a, b) => {
      const ta = new Date(b.updatedAt || b.createdAt || 0).getTime();
      const tb = new Date(a.updatedAt || a.createdAt || 0).getTime();
      return ta - tb;
    });

    // Enforce session limit: keep at most MAX_SESSIONS
    const prunedSessions = existingSessions.slice(0, MAX_SESSIONS);

    await globalState.update(SESSIONS_STORAGE_KEY, prunedSessions);
  } catch (err) {
    console.error('Code Mentor: Failed to save session to globalState:', err);
  }
}

/**
 * Deletes a session by ID from globalState.
 * If the deleted session was the active session, clears active session ID.
 */
export async function deleteSession(globalState: vscode.Memento, sessionId: string): Promise<void> {
  try {
    const existingSessions = getAllSessions(globalState);
    const updated = existingSessions.filter(s => s.id !== sessionId);
    await globalState.update(SESSIONS_STORAGE_KEY, updated);

    const activeId = getActiveSessionId(globalState);
    if (activeId === sessionId) {
      await setActiveSessionId(globalState, null);
    }
  } catch (err) {
    console.error('Code Mentor: Failed to delete session from globalState:', err);
  }
}

/**
 * Clears all persistent sessions and active session state.
 */
export async function clearAllSessions(globalState: vscode.Memento): Promise<void> {
  try {
    await globalState.update(SESSIONS_STORAGE_KEY, []);
    await setActiveSessionId(globalState, null);
  } catch (err) {
    console.error('Code Mentor: Failed to clear all sessions from globalState:', err);
  }
}

/**
 * Returns the most recent session with messages (for the Welcome screen Continue card).
 */
export function getMostRecentSession(globalState: vscode.Memento): Session | null {
  try {
    const sessions = getAllSessions(globalState);
    return sessions.find(s => s.messages && s.messages.length > 0) || null;
  } catch {
    return null;
  }
}
