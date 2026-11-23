// Writes the package's version where the client reads it to name itself. A module
// importing package.json would reach outside src/, and a Node.js builtin that could
// read it is barred from the package (test/edge.test.mjs).

import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/generated/version.ts', import.meta.url), `export const VERSION = '${version}';\n`);
