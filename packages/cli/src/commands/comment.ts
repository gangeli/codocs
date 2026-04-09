import type { Command } from 'commander';
import { createClient, spin, withErrorHandler } from '../util.js';

export function registerCommentCommand(program: Command) {
  program
    .command('comment')
    .description('Add a comment to a Google Doc')
    .argument('<docId>', 'Google Doc ID or URL')
    .argument('<text>', 'Comment text')
    .option('--quote <text>', 'Anchor comment to this quoted text in the doc')
    .option('--agent <name>', 'Agent name to prefix the comment with')
    .action(
      withErrorHandler(
        async (
          docId: string,
          text: string,
          opts: { quote?: string; agent?: string },
        ) => {
          const client = createClient();
          docId = extractDocId(docId);

          // Validate quote against document content
          if (opts.quote) {
            const s = spin('Validating quoted text against document...');
            const markdown = await client.readMarkdown(docId);
            const occurrences = countOccurrences(markdown, opts.quote);

            if (occurrences === 0) {
              s.fail('Quoted text not found in document — comment will be unanchored');
            } else if (occurrences > 1) {
              s.succeed(`Quoted text found (${occurrences} occurrences — will anchor to first)`);
            } else {
              s.succeed('Quoted text found');
            }
          }

          const s = spin('Posting comment...');
          const commentId = await client.addComment(docId, {
            content: text,
            quotedText: opts.quote,
            agent: opts.agent ? { name: opts.agent } : undefined,
          });
          s.succeed(`Comment posted (${commentId})`);
        },
      ),
    );
}

function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
