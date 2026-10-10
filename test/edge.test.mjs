// Next.js 15 builds middleware for its Edge runtime unless told otherwise, and
// webpack there refuses any `node:` import, a dynamic one included, even on a
// path the middleware never takes. Through 5.4.0 the client imported five.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const dist = new URL('../dist/', import.meta.url).pathname;

test('no built module imports a Node.js builtin', () => {
    const modules = readdirSync(dist, { recursive: true }).filter((file) => file.endsWith('.js'));
    assert.ok(modules.length > 10, `found only ${modules.length} modules in dist`);
    for (const file of modules) {
        const source = readFileSync(join(dist, file), 'utf8');
        const specifiers = source.match(/(?:from|import\s*\(|require\s*\()\s*['"][a-z_:/]+['"]/g) ?? [];
        const builtins = specifiers.filter(
            (spec) => /['"](node:|(fs|stream|crypto|path|os|http|https|url)['"/])/.test(spec),
        );
        assert.deepEqual(builtins, [], `${file} imports a Node.js builtin`);
    }
});
