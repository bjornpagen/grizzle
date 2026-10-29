/**
 * The public-boundary differential (suite.ts): programs generated as calls to grizzle's public builders, installed
 * through their migration, read through Db as the schema's full role, every decoded nested result against the
 * reference evaluator's per-parent delivery.
 */
import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { asConverted, asDelivered } from "#test/pg/oracle/public/planted.ts"
import { cases, explorePublic } from "#test/pg/oracle/public/suite.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)("the public-boundary differential", (it) => {
	it.effect(
		`agrees with the reference on ${cases} generated programs, read through every public form`,
		(ctx) => searched(ctx, explorePublic(asDelivered, asConverted)),
		1_800_000
	)
})
