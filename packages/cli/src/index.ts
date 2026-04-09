import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerReadCommand } from './commands/read.js';
import { registerSectionsCommand } from './commands/sections.js';
import { registerEditCommand } from './commands/edit.js';
import { registerInsertCommand } from './commands/insert.js';
import { registerCommentCommand } from './commands/comment.js';
import { registerServeCommand } from './commands/serve.js';

const program = new Command();

program
  .name('codocs')
  .description('Interact with Google Docs from the command line')
  .version('0.1.0');

registerAuthCommands(program);
registerReadCommand(program);
registerSectionsCommand(program);
registerEditCommand(program);
registerInsertCommand(program);
registerCommentCommand(program);
registerServeCommand(program);

program.parse();
