/**
 * Prompt construction for chat tab conversations.
 */

import type { ChatMessage } from '@codocs/db';

export interface ChatPromptContext {
  /** The agent's name. */
  agentName: string;
  /** The Google Doc ID. */
  documentId: string;
  /** Full chat message history. */
  messages: ChatMessage[];
  /** Current main document content as markdown. */
  documentMarkdown: string;
  /** The new user message to respond to. */
  newMessage: string;
  /** Path to the markdown file the agent can edit for document changes. */
  mdFilePath: string;
}

/**
 * Format chat history into a readable conversation log.
 */
function formatChatHistory(messages: ChatMessage[]): string {
  return messages
    .map((msg) => {
      const label = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Agent';
      return `**${label}:** ${msg.content}`;
    })
    .join('\n\n');
}

/**
 * Build the prompt for a chat tab conversation turn.
 */
export function buildChatPrompt(ctx: ChatPromptContext): string {
  const history = ctx.messages.length > 0
    ? `Here is the conversation so far:\n\n${formatChatHistory(ctx.messages)}\n`
    : '';

  return `You are agent "${ctx.agentName}" in a chat conversation about a shared Google Doc.

${history}
The user's latest message:
> ${ctx.newMessage}

The current document content is in this markdown file: ${ctx.mdFilePath}

## How to respond

1. **Chat response**: Your text output (stdout) will be appended to the chat tab as your reply. Be conversational and helpful.

2. **Document edits**: If the conversation calls for changes to the document, edit ${ctx.mdFilePath} using the Edit or Write tool. Changes will be diffed and applied to the main document tab.

3. **Images and diagrams**: Use mermaid diagrams in fenced code blocks (\`\`\`mermaid) for architecture diagrams, flows, etc. They render as images in the Google Doc.

Keep in mind:
* This is a multi-turn conversation. Reference prior messages naturally.
* You can read and modify the document file at any point during the conversation.
* Be concise in your replies — they appear in a chat view.
* For architecture diagrams, data flows, or relationships, use mermaid diagrams.
`;
}
