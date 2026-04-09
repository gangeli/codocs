import type { Command } from 'commander';
import { createClient, spin, withErrorHandler } from '../util.js';

export function registerReadCommand(program: Command) {
  program
    .command('read')
    .description('Read a Google Doc as markdown')
    .argument('<docId>', 'Google Doc ID or URL')
    .option('--agent <name>', 'Read only content from this agent')
    .action(
      withErrorHandler(async (docId: string, opts: { agent?: string }) => {
        const client = createClient();
        docId = extractDocId(docId);

        const s = spin('Fetching document...');
        let markdown: string;
        if (opts.agent) {
          markdown = await client.getAgentContent(docId, opts.agent);
        } else {
          markdown = await client.readMarkdown(docId);
        }
        s.stop();

        process.stdout.write(markdown);
      }),
    );
}

/**
 * Extract document ID from a URL or return as-is.
 * Handles: https://docs.google.com/document/d/DOC_ID/edit
 */
function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
