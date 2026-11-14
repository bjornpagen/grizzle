/**
 * The public-boundary differential (suite.ts): programs generated as calls to grizzle's public builders, installed
 * through their migration, read through Db as the schema's full role in every public form, every decoded nested result
 * against the reference evaluator's per-parent delivery, every cell text's trusting conversion against its strict
 * reading, and every read read again, exactly as it first answered, over its facts stored otherwise.
 *
 * Oracle: the reference evaluator's per-parent delivery, the kernel's strict reader of each cell, and the read itself
 * under another storage order and spelling.
 *
 * Plants: public-parent-key-spelling (the reader stitches children to parents by the parent key cell's spelling, so a
 * parent whose key PostgreSQL stored otherwise gets none), public-bool-read-f (the trusting conversion reads a boolean
 * true only from f), public-delivered-order-dropped (a delivered root drops its ORDER BY, so a root take's rows arrive
 * out of the take's order).
 *
 * Features: suite.ts's situations, every program form and identifier kind, and each decline of the reference.
 */
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { cases, explorePublic } from "#test/pg/oracle/public/suite.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)("the public-boundary differential", (it) => {
	it.effect(
		`agrees with the reference on ${cases} generated programs, read through every public form`,
		(ctx) => searched(ctx, explorePublic)
	)
})
