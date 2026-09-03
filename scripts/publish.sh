#!/bin/bash

# Publishes the package to npm from inside the official Node image, so a release
# needs nothing installed locally beyond docker and works identically on any
# machine. The release workflow does the same steps on a tag; this is the manual
# path for a first release or when Actions is not an option.
#
#   NPM_TOKEN=... ./scripts/publish.sh            # publish
#   NPM_TOKEN=... DRY_RUN=1 ./scripts/publish.sh  # rehearse

set -euo pipefail

cd "$(dirname "$0")/.."

: "${NPM_TOKEN:?set NPM_TOKEN to an npm automation token}"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
DRY_RUN="${DRY_RUN:-}"

publish_args="--no-git-checks"
if [ -n "$DRY_RUN" ] ; then
    publish_args="$publish_args --dry-run"
fi

docker run --rm \
    -v "$PWD:/w" -w /w \
    -e NPM_TOKEN="$NPM_TOKEN" \
    "$NODE_IMAGE" sh -euc "
        corepack enable
        npm config set //registry.npmjs.org/:_authToken \"\$NPM_TOKEN\"
        pnpm install --frozen-lockfile
        pnpm run build
        pnpm run test
        pnpm publish $publish_args
    "
