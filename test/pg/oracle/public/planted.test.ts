/**
 * The planted-bug checks of the public-boundary differential (planted.ts): read through a test double that stitches
 * attachment children by the spelling of their parent's key, and with its cell texts checked against a boolean
 * conversion that misreads true, the suite must find a counterexample whose cause is the planted check: the answer
 * comparison for the stitch, the cell check for the conversion. Each runs as a suite of its own.
 */
import { layer } from "@effect/vitest"
import { Run } from "@grizzle/testing/explore"
import { runOfTest } from "@grizzle/testing/vitest/run"
import { Effect, Option } from "effect"
import { asConverted, asDelivered, boolByF, bySpelling } from "#test/pg/oracle/public/planted.ts"
import type { DisagreementCheck } from "#test/pg/oracle/public/run.ts"
import { type Caught, catchPlanted } from "#test/pg/oracle/public/suite.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The exploration found a counterexample whose disagreement is the planted check's. */
const caughtBy = (caught: Caught, check: DisagreementCheck): void => {
	if (caught.kind === "passed") {
		return assert.fail("the planted defect passed")
	}
	assert.equal(
		Option.getOrUndefined(Option.map(caught.last, (disagreement) => disagreement.check)),
		check,
		caught.report
	)
}

layer(Substrate.layer)("the public-boundary differential against a planted defect", (it) => {
	it.effect("finds children stitched by the spelling of their parent's key", (ctx) =>
		Effect.map(
			catchPlanted("public/planted-stitch", bySpelling, asConverted).pipe(
				Effect.provideServiceEffect(Run, runOfTest(ctx))
			),
			(caught) => {
				caughtBy(caught, "answer")
			}
		)
	)

	it.effect(
		"finds a boolean cell whose trusting conversion differs from its strict reading",
		(ctx) =>
			Effect.map(
				catchPlanted("public/planted-conversion", asDelivered, boolByF).pipe(
					Effect.provideServiceEffect(Run, runOfTest(ctx))
				),
				(caught) => {
					caughtBy(caught, "cell")
				}
			)
	)
})
