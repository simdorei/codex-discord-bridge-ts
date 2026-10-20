#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {runProHelper} from '../lib/pro/main.js';
try {const result=await runProHelper(process.argv.slice(2),fileURLToPath(new URL('..',import.meta.url)));if(result)process.stdout.write(result+'\n');}
catch(error){process.stderr.write((error instanceof Error?error.message:'Pro helper failed')+'\n');process.exitCode=2;}
