import { dictionary } from "@bjornpagen/testing/dictionary"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { nonEmpty } from "#test/support/assert.ts"
import { entryListing, srcListing } from "#test/unit/deps/deps.fixtures.ts"

/**
 * Every TypeScript module under both packages' src, by its path from the repository's root: the tree the audit holds
 * to its rules. The repository's own files are the domain, never cases a person chose.
 */
export const srcModules = dictionary(
	nonEmpty(
		await Effect.runPromise(Effect.provide(srcListing, NodeServices.layer)),
		"the src/ modules"
	)
)

/**
 * Every entry point the packages' package.json exports and bins name. The packages' own manifests are the domain,
 * never cases a person chose.
 */
export const entryPoints = dictionary(
	nonEmpty(
		await Effect.runPromise(Effect.provide(entryListing, NodeServices.layer)),
		"the packages' entry points"
	)
)
