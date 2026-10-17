import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT } from './prompt';

/**
 * Message in conversation history passed to the LLM.
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Individual code fragment explanation note (especially in explain mode).
 */
export interface LineNote {
  code: string;
  note: string;
}

/**
 * Individual review finding in code review mode.
 */
export interface ReviewFinding {
  area: string;
  observation: string;
  question: string;
}

/**
 * Structured response schema expected from Code Mentor.
 */
export interface MentorReply {
  message: string;            // short, friendly explanation, max ~120 words
  concept: string[];          // 1-2 concept names, e.g. ["Flexbox", "Semantic HTML"]
  next_step: string;          // ONE small action the learner should try next
  question: string | null;    // optional guiding or clarifying question
  hint_level: 1 | 2 | 3 | 4;  // 1=nudge 2=hint 3=structure 4=solution
  code_snippet: string | null; // max 5 lines unless hint_level is 4
  line_notes?: LineNote[];    // optional line-by-line notes for explain mode
  findings?: ReviewFinding[]; // optional findings for review mode
  understanding?: 'solid' | 'partial' | 'shaky'; // optional rating for explain_back mode
  got_right?: string[];       // what learner got right in explain_back
  gaps?: string[];            // topics/concepts to revisit in explain_back
}

/**
 * Error thrown when no Google Gemini API key is configured.
 */
export class MissingApiKeyError extends Error {
  constructor(message = 'Google Gemini API key is missing. Please set your API key in settings.') {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

/**
 * parseMentorReply:
 * Safely parses the raw string response from the LLM provider into a structured MentorReply.
 *
 * Steps performed:
 * 1. Checks if input is empty or invalid, returning a safe fallback immediately.
 * 2. Strips Markdown fences (```json ... ``` or ``` ... ```) that the LLM may wrap around the JSON.
 * 3. Attempts to parse the JSON with JSON.parse within a try/catch.
 * 4. If direct parsing fails, attempts to isolate the outermost JSON object between { and }.
 * 5. Sanitizes every field (strings, arrays, hint_level bounded to 1..4, line_notes, findings, understanding, got_right, gaps).
 * 6. NEVER throws an exception on bad/malformed JSON; always returns a compliant fallback object.
 *
 * @param raw - The raw text string returned by the Gemini LLM
 * @returns A guaranteed valid MentorReply object
 */
export function parseMentorReply(raw: string): MentorReply {
  // Safe default fallback object matching the MentorReply interface
  const fallback: MentorReply = {
    message: raw || '',
    concept: [],
    next_step: '',
    question: null,
    hint_level: 1,
    code_snippet: null,
    line_notes: undefined,
    findings: undefined,
    understanding: undefined,
    got_right: undefined,
    gaps: undefined
  };

  if (!raw || typeof raw !== 'string') {
    return fallback;
  }

  try {
    // Step 1: Strip code block fences if the provider or model wrapped the JSON
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      // Remove leading ```json or ```
      cleaned = cleaned.replace(/^```(?:json)?\s*[\r\n]*/i, '');
    }
    if (cleaned.endsWith('```')) {
      // Remove trailing ```
      cleaned = cleaned.replace(/[\r\n]*\s*```$/i, '');
    }
    cleaned = cleaned.trim();

    // Step 2: Parse JSON with fallback boundary detection
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // If direct parse fails, try extracting between first { and last }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        return fallback;
      }
    }

    // Ensure parsed payload is a standard object
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }

    // Step 3: Sanitize each field against the MentorReply schema
    // 3a. Message (string)
    const message = typeof parsed.message === 'string'
      ? parsed.message
      : (parsed.message != null ? String(parsed.message) : '');

    // 3b. Concept (string array)
    let concept: string[] = [];
    if (Array.isArray(parsed.concept)) {
      concept = parsed.concept
        .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        .map((c: string) => c.trim());
    } else if (typeof parsed.concept === 'string' && parsed.concept.trim().length > 0) {
      concept = [parsed.concept.trim()];
    }

    // 3c. Next step (string)
    const next_step = typeof parsed.next_step === 'string'
      ? parsed.next_step
      : (parsed.next_step != null ? String(parsed.next_step) : '');

    // 3d. Question (string or null)
    const question = typeof parsed.question === 'string' && parsed.question.trim().length > 0
      ? parsed.question.trim()
      : null;

    // 3e. Hint level (1 | 2 | 3 | 4, defaults to 1)
    let hint_level: 1 | 2 | 3 | 4 = 1;
    const numLevel = Number(parsed.hint_level);
    if (numLevel === 1 || numLevel === 2 || numLevel === 3 || numLevel === 4) {
      hint_level = numLevel as 1 | 2 | 3 | 4;
    }

    // 3f. Code snippet (string or null)
    const code_snippet = typeof parsed.code_snippet === 'string' && parsed.code_snippet.trim().length > 0
      ? parsed.code_snippet
      : null;

    // 3g. Line notes (optional array of { code, note } objects for explain mode)
    let line_notes: LineNote[] | undefined = undefined;
    if (Array.isArray(parsed.line_notes)) {
      const notes: LineNote[] = [];
      for (const item of parsed.line_notes) {
        if (item && typeof item === 'object') {
          const c = typeof item.code === 'string'
            ? item.code
            : (item.code != null ? String(item.code) : '');
          const n = typeof item.note === 'string'
            ? item.note
            : (item.note != null ? String(item.note) : '');
          if (c.trim().length > 0 || n.trim().length > 0) {
            notes.push({ code: c.trim(), note: n.trim() });
          }
        }
      }
      if (notes.length > 0) {
        line_notes = notes;
      }
    }

    // 3h. Findings (optional array of { area, observation, question } objects for review mode)
    let findings: ReviewFinding[] | undefined = undefined;
    if (Array.isArray(parsed.findings)) {
      const parsedFindings: ReviewFinding[] = [];
      for (const item of parsed.findings) {
        if (item && typeof item === 'object') {
          const area = typeof item.area === 'string' ? item.area.trim() : '';
          const observation = typeof item.observation === 'string' ? item.observation.trim() : '';
          const q = typeof item.question === 'string' ? item.question.trim() : '';
          if (area || observation || q) {
            parsedFindings.push({
              area: area || 'General',
              observation: observation || '',
              question: q || ''
            });
          }
        }
      }
      if (parsedFindings.length > 0) {
        findings = parsedFindings;
      }
    }

    // 3i. Understanding rating (optional "solid" | "partial" | "shaky" for explain_back mode)
    let understanding: 'solid' | 'partial' | 'shaky' | undefined = undefined;
    if (parsed.understanding === 'solid' || parsed.understanding === 'partial' || parsed.understanding === 'shaky') {
      understanding = parsed.understanding;
    }

    // 3j. Got right list (optional string array for explain_back mode)
    let got_right: string[] | undefined = undefined;
    if (Array.isArray(parsed.got_right)) {
      const items = parsed.got_right
        .filter((item: any) => typeof item === 'string' && item.trim().length > 0)
        .map((item: string) => item.trim());
      if (items.length > 0) {
        got_right = items;
      }
    }

    // 3k. Gaps to revisit list (optional string array for explain_back mode)
    let gaps: string[] | undefined = undefined;
    if (Array.isArray(parsed.gaps)) {
      const items = parsed.gaps
        .filter((item: any) => typeof item === 'string' && item.trim().length > 0)
        .map((item: string) => item.trim());
      if (items.length > 0) {
        gaps = items;
      }
    }

    return {
      message,
      concept,
      next_step,
      question,
      hint_level,
      code_snippet,
      line_notes,
      findings,
      understanding,
      got_right,
      gaps
    };
  } catch {
    // If any unexpected error occurs during parsing or sanitization, return fallback
    return fallback;
  }
}

/**
 * Sends conversation history to Google Gemini asking explicitly for JSON output.
 * Reads API key dynamically from settings and returns the raw response text.
 */
export async function askMentor(history: ChatMessage[]): Promise<string> {
  // Read API key and model from VS Code configuration
  const config = vscode.workspace.getConfiguration('mentor');
  const apiKey = (config.get<string>('apiKey', '') || config.get<string>('apikey', '')).trim();
  const modelName = config.get<string>('model', 'gemini-3.5-flash').trim() || 'gemini-3.5-flash';

  if (!apiKey) {
    throw new MissingApiKeyError('No Gemini API key found. Please configure "mentor.apiKey" in your settings.');
  }

  // Initialize Google Generative AI client with user's API key
  const genAI = new GoogleGenerativeAI(apiKey);

  // Configure model with system instruction and JSON output mode
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  // Convert ChatMessage history to Gemini's Content format
  // Gemini expects 'user' and 'model' as roles
  const contents = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  // Request structured JSON response from Gemini
  const response = await model.generateContent({
    contents,
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  return response.response.text();
}
