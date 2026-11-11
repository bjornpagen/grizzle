/**
 * The three-way write oracle as explorations: generated write runs, each a generated schema installed and opened once,
 * whose cases compare db.apply, the conservative realization and the brute-force add-wins result
 * (test/support/oracle/write).
 *
 * The oracle is split into suites of their own, each with its own floor stream, which the library derives from its
 * label, so the runner spreads them over its workers; every suite explores the whole distribution and must reach every
 * required feature (writeSituations) on its floor stream or its steered phase, which spends at most as many runs as the
 * rotating stream.
 *
 * - Property: every generated write's outcome, counts, refusal and stored state agree three ways.
 * - Oracle: a second implementation, the brute-force add-wins transition, and a differential against the conservative
 *   realization.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/write-oracle-removal-keeps-addition.patch, a removal that keeps the
 *   addition it should cancel across strata, must turn the property red.
 */
import { layer } from "@effect/vitest"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { exploreWrite, type WriteSuite, writeSituations } from "#test/support/oracle/write/index.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The runs of each suite's rotating stream. */
const runs = 40

/** The suite `i`: its label, from which the library derives its floor stream. */
export const writeOracleSuite = (i: number): WriteSuite => ({
	suite: `write/oracle-${i}`,
	runs,
	coverage: required(writeSituations, { cases: runs, sense: notesOnly })
})

export const writeSuite = (s: WriteSuite, title: string): void =>
	layer(Substrate.layer, { excludeTestServices: true })(title, (it) => {
		it.effect(
			`${s.runs} generated write runs agree three ways: db.apply, add-wins and the conservative realization`,
			(ctx) => searched(ctx, exploreWrite(s))
		)
	})
