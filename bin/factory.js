#!/usr/bin/env node
import { main } from '../src/cli/index.js';

await main(process.argv.slice(2));
