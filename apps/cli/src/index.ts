#!/usr/bin/env node
import { main, report } from './commands/main.js';

main().catch(error => { process.exitCode = report(error); });