import type { Command } from 'commander';
import { createClient, readContent, spin, withErrorHandler } from '../util.js';

export function registerInsertCommand(program: Command) {
  program
    .command('insert')
    .description('Insert a new attributed section into a Google Doc')
    .argument('<docId>', 'Google Doc ID or URL')
    .argument('[file]', 'Markdown file to read from (reads stdin if omitted)')
    .requiredOption('--agent <name>', 'Agent name for attribution')
    .option('--after <section>', 'Insert after this section (appends to end if omitted)')
    .action(
      withErrorHandler(
        async (
          docId: string,
          file: string | undefined,
          opts: { agent: string; after?: string },
        ) => {
          const client = createClient();
          docId = extractDocId(docId);
          const markdown = await readContent(file);

          const position = opts.after
            ? `after section "${opts.after}"`
            : 'at end of document';
          const s = spin(`Inserting section ${position}...`);
          await client.insertAfterSection(docId, opts.after, markdown, {
            name: opts.agent,
          });
          s.succeed(`Section inserted ${position} (attributed to: ${opts.agent})`);
        },
      ),
    );
}

function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
