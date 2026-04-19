import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerReadCommand } from './commands/read.js';
import { registerSectionsCommand } from './commands/sections.js';
import { registerEditCommand } from './commands/edit.js';
import { registerInsertCommand } from './commands/insert.js';
import { registerCommentCommand } from './commands/comment.js';
import { registerRepairCommand } from './commands/repair.js';
import { registerServeCommand } from './commands/serve.js';
import { BUILD_VERSION } from './version.js';

const program = new Command();

program
  .name('codocs')
  .description('Interact with Google Docs from the command line')
  .version(BUILD_VERSION);

registerAuthCommands(program);
registerReadCommand(program);
registerSectionsCommand(program);
registerEditCommand(program);
registerInsertCommand(program);
registerCommentCommand(program);
registerRepairCommand(program);
registerServeCommand(program);

program.parse();
