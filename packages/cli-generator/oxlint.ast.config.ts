import { astOnly } from "@bjornpagen/devtools/preset"
import { Record } from "effect"
import { defineConfig } from "oxlint"
import config from "#oxlint.config.ts"
import ledger from "#ratchet.json" with { type: "json" }

/** The commit gate's oxlint: the full configuration without its type-aware rules, over every file but those the
 * generator's finding ratchet holds oxlint findings for. Such a file is held to its count in the ledger, which counts
 * the type-aware rules too, by the push gate's ratchet; this check counts nothing per file, so it would refuse every
 * commit that touches one. Every other file comes in clean. The list goes when the ratchet's oxlint entry goes. */
export default defineConfig({
	...astOnly(config),
	ignorePatterns: [...(config.ignorePatterns ?? []), ...Record.keys(ledger.oxlint.files)]
})
