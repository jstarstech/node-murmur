#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    console.log(packageJson.version);
    process.exit(0);
}

await import('../src/app.js');
