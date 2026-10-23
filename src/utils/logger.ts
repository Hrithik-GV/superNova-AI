import * as vscode from 'vscode';

let logChannel: vscode.OutputChannel;

/**
 * Initializes the extension logger with the dedicated output channel.
 */
export function initLogger(channel: vscode.OutputChannel): void {
  logChannel = channel;
}

/**
 * Returns the active output channel.
 */
export function getLogChannel(): vscode.OutputChannel {
  return logChannel;
}

/**
 * Logs info messages to the output channel.
 */
export function logInfo(message: string): void {
  const timestamp = new Date().toISOString();
  if (logChannel) {
    logChannel.appendLine(`[${timestamp}] INFO: ${message}`);
  }
}

/**
 * Logs warning messages to the output channel.
 */
export function logWarn(message: string): void {
  const timestamp = new Date().toISOString();
  if (logChannel) {
    logChannel.appendLine(`[${timestamp}] WARN: ${message}`);
  }
}

/**
 * Logs sanitized error messages to the output channel.
 * Never includes API keys, headers, or full request bodies.
 */
export function logError(message: string, error?: any): void {
  const timestamp = new Date().toISOString();
  let detail = '';
  if (error) {
    detail = error.message || String(error);
    // Sanitize any accidental API key patterns (AIza..., AQ..., sk-...)
    detail = detail
      .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
      .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]');
  }
  if (logChannel) {
    logChannel.appendLine(`[${timestamp}] ERROR: ${message} ${detail}`.trim());
  } else {
    console.error(`[${timestamp}] ERROR: ${message} ${detail}`);
  }
}

/**
 * Logs API errors to the output channel:
 * Includes HTTP status, model name used, request mode, and the first 300 characters
 * of the error body (strictly sanitized so API keys are never leaked).
 */
export function logApiError(
  status: number | string | undefined,
  modelName: string,
  mode: string,
  error: any
): void {
  const timestamp = new Date().toISOString();
  let body = '';
  if (error?.message) {
    body = error.message;
  } else if (error?.errorDetails) {
    body = typeof error.errorDetails === 'string'
      ? error.errorDetails
      : JSON.stringify(error.errorDetails);
  } else {
    body = String(error || '');
  }

  // Redact potential API keys or secrets (AIza, sk-, AQ., or key= in URLs)
  body = body
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]')
    .replace(/AQ\.[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/sk-[0-9A-Za-z-_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/key=[^&\s]+/gi, 'key=[REDACTED]');

  const truncatedBody = body.slice(0, 300);
  const statusStr = status !== undefined && status !== null ? String(status) : 'unknown';

  if (logChannel) {
    logChannel.appendLine(
      `[${timestamp}] API ERROR: status=${statusStr}, model=${modelName}, mode=${mode}, body=${truncatedBody}`
    );
  } else {
    console.error(`[${timestamp}] API ERROR: status=${statusStr}, model=${modelName}, mode=${mode}, body=${truncatedBody}`);
  }
}
