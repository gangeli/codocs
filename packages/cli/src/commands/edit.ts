import type { Command } from 'commander';
import { createClient, readContent, spin, withErrorHandler } from '../util.js';

export function registerEditCommand(program: Command) {
  program
    .command('edit')
    .description('Replace the content of an attributed section')
    .argument('<docId>', 'Google Doc ID or URL')
    .argument('<section>', 'Section name (agent name) to edit')
    .argument('[file]', 'Markdown file to read from (reads stdin if omitted)')
    .option('--agent <name>', 'Attribution for new content (defaults to section name)')
    .action(
      withErrorHandler(
        async (
          docId: string,
          section: string,
          file: string | undefined,
          opts: { agent?: string },
        ) => {
          const client = createClient();
          docId = extractDocId(docId);
          const markdown = await readContent(file);
          const agentName = opts.agent ?? section;

          const s = spin(`Updating section "${section}"...`);
          await client.editSection(docId, section, markdown, {
            name: agentName,
          });
          s.succeed(`Section "${section}" updated (attributed to: ${agentName})`);
        },
      ),
    );
}

function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
