#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('mycli')
  .description('Project CLI')
  .version('0.0.1');

program
  .command('hello')
  .description('Say hello')
  .argument('[name]', 'name to greet', 'world')
  .action((name: string) => {
    console.log(chalk.green(`Hello, ${name}!`));
  });

program.parse();
