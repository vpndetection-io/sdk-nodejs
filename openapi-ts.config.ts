import { defineConfig } from '@hey-api/openapi-ts';

// Generates from the PINNED spec in this repo, never from a URL, so a build is
// reproducible and offline and the diff shows which spec version produced it.
// Refresh with scripts/download-spec.sh.
export default defineConfig({
    input: './spec/openapi.yaml',
    output: {
        path: './src/generated',
    },
    plugins: ['@hey-api/client-fetch'],
});
