#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {runLocalRuntimeCli} from './local-runtime.ts';
process.exitCode = await runLocalRuntimeCli(fileURLToPath(import.meta.url), '0.0.0');
