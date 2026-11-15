#!/usr/bin/env bash
# shellcheck disable=SC2016 # the sed scripts write TypeScript template literals, which the shell must leave alone
# tag.sh <tree>: tags every session the test support of the grizzle checkout <tree> opens with the test file its
# process runs, in application_name (`<file>|<label>`, PGAPPNAME for the rest), so the samples attribute each backend
# to its file. A measurement-only edit of test/support/{env,pg}.ts, substrate/substrate.ts and substrate/psql.ts as they
# stand at 0b7b5f31, never committed; it resets those files first.
set -eu
cd "$1"
git checkout HEAD -- test/support/env.ts test/support/pg.ts test/support/substrate/substrate.ts test/support/substrate/psql.ts
cat >>test/support/env.ts <<'EOT'

const measuredWorker: unknown = Reflect.get(globalThis, "__vitest_worker__")
const measuredFile: unknown =
	typeof measuredWorker === "object" && measuredWorker !== null ? Reflect.get(measuredWorker, "filepath") : undefined
/** Measurement only: the test file this process runs, tagged onto every session's application_name. */
export const measuredTag: string =
	typeof measuredFile === "string" ? measuredFile.replace(/^.*?\/test\//, "") : "main"
if (typeof measuredFile === "string") {
	process.env["PGAPPNAME"] = measuredTag
}
EOT
sed -i 's|^import { pgPin } from "#test/support/env.ts"|import { measuredTag, pgPin } from "#test/support/env.ts"|' test/support/pg.ts test/support/substrate/psql.ts
sed -i 's|onSome: (name) => ({ application_name: name })|onSome: (name) => ({ application_name: `${measuredTag}\|${name.replace("grizzle-substrate ", "")}` })|' test/support/pg.ts
sed -i 's|^import { adminUrl, pgPin } from "#test/support/env.ts"|import { adminUrl, measuredTag, pgPin } from "#test/support/env.ts"|' test/support/substrate/substrate.ts
sed -i 's|^\t\t\t\t\tapplication_name: applicationName,|\t\t\t\t\tapplication_name: `${measuredTag}\|su ${applicationName}`,|' test/support/substrate/substrate.ts
sed -i "s|\`application_name='grizzle-substrate psql \${options.label}'\`|\`application_name='\${measuredTag}\|psql \${options.label}'\`|" test/support/substrate/psql.ts
git diff --stat
