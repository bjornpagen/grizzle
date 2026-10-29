import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { exploreWrite, required, type WriteSuite } from "#test/support/oracle/write/index.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The runs of each suite's rotating stream.
 *
 * The three-way write oracle as explorations: generated write runs, each a generated schema installed and opened
 * once, whose cases compare db.apply, the conservative realization and the brute-force add-wins result.
 *
 *
 * The oracle is split into suites of their own, each with its own floor stream, which the library derives from its
 * label, so the runner spreads them over its workers; every suite explores the whole distribution and must reach every
 * required feature, which its plain streams reach, so no suite steers. */
const runs = 40

/** The suite `i`: its label, from which the library derives its floor stream. */
export const writeOracleSuite = (i: number): WriteSuite => ({
	suite: `write/oracle-${i}`,
	runs,
	required,
	steering: { kind: "none" }
})

export const writeSuite = (s: WriteSuite, title: string): void =>
	layer(Substrate.layer, { excludeTestServices: true })(title, (it) => {
		it.effect(
			`${s.runs} generated write runs agree three ways: db.apply, add-wins and the conservative realization`,
			(ctx) => searched(ctx, exploreWrite(s)),
			1_800_000
		)
	})
