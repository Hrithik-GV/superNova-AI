import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class MissingApiKeyError extends Error {
  constructor(message = 'Anthropic API key is missing. Please set your API key in settings.') {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Sends conversation history to Anthropic Claude Haiku 5.5 and returns the mentor's response text.
 * Reads the API key dynamically from the `mentor.apiKey` VS Code configuration setting.
 *
 * NOTE: For claude-haiku-5-5, temperature, top_p, top_k, and assistant prefill are omitted.
 */
export async function askMentor(history: ChatMessage[]): Promise<string> {
  // Read API key from VS Code settings
  const config = vscode.workspace.getConfiguration('mentor');
  const apiKey = config.get<string>('apiKey', '').trim();

  if (!apiKey) {
    throw new MissingApiKeyError('No Anthropic API key found. Please configure "mentor.apiKey" in your settings.');
  }

  // Initialize Anthropic client with the user's API key
  const anthropic = new Anthropic({
    apiKey: apiKey
  });

  // Call the Anthropic Messages API
  // Only standard parameters: model, max_tokens, system, and messages
  const response = await anthropic.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: history.map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  });

  // Extract text from the response content blocks
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');

  return text;
}
