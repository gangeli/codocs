import type { Command } from 'commander';
import { createClient, spin, truncate, withErrorHandler } from '../util.js';

export function registerSectionsCommand(program: Command) {
  program
    .command('sections')
    .description('List attributed sections of a Google Doc')
    .argument('<docId>', 'Google Doc ID or URL')
    .action(
      withErrorHandler(async (docId: string) => {
        const client = createClient();
        docId = extractDocId(docId);

        const s = spin('Fetching document sections...');
        const attributions = await client.getAttributions(docId);
        s.stop();

        if (attributions.length === 0) {
          console.log('No attributed sections found.');
          return;
        }

        // Sort by start position
        const sorted = [...attributions].sort((a, b) => {
          const aStart = a.ranges[0]?.startIndex ?? 0;
          const bStart = b.ranges[0]?.startIndex ?? 0;
          return aStart - bStart;
        });

        // Calculate column widths
        const nameWidth = Math.max(
          6,
          ...sorted.map((s) => s.agentName.length),
        );

        for (const span of sorted) {
          const rangeStr = span.ranges
            .map((r) => `${r.startIndex}-${r.endIndex}`)
            .join(', ');
          const preview = truncate(span.text, 60);
          const name = span.agentName.padEnd(nameWidth);

          console.log(`${name}  [${rangeStr}]  "${preview}"`);
        }
      }),
    );
}

function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
