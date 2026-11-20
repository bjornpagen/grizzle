import { astOnly } from "@bjornpagen/devtools/preset"
import { Record } from "effect"
import { defineConfig } from "oxlint"
import ledger from "#cli-generator/ratchet.json" with { type: "json" }
import config from "#oxlint.config.ts"

/**
 * The commit gate's oxlint: the full configuration without its type-aware rules, over every file but those the CLI
 * generator's finding ratchet (packages/cli-generator/scripts/ratchet.ts) holds oxlint findings for. Such a file is held
 * to its count in the ledger, which counts the type-aware rules too, by the package's oxlint task; this check counts
 * nothing per file, so it would refuse every commit that touches one. Every other file comes in clean. The list goes
 * when the ledger's oxlint entry goes.
 */
export default defineConfig({
	...astOnly(config),
	ignorePatterns: [...(config.ignorePatterns ?? []), ...Record.keys(ledger.oxlint.files)]
})
