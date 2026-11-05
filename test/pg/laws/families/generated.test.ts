/**
 * The law-family box (generated.ts) through grizzle: generated write sequences over every point, each step's outcome
 * the host model's (accepted, unchanged, or refused by one of the violated laws with a witness naming a violator) and
 * the committed state the host's, compared as sets. Every trait of a point must meet a refusal by every kind of
 * residual law that point declares.
 *
 * Beside the box, its named invalid points: a capacity whose weight is real, double precision or money, or whose `ref`
 * bound is real or double precision, is refused when its schema compiles, with UnsupportedLawFamily, and installs
 * nothing.
 */

import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Result } from "effect"
import {
	lawBox,
	type RefusedCapacity,
	refusedCapacities
} from "#test/pg/laws/families/generated.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"
import { installLaws } from "#test/pg/laws/families/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

familySuite(lawBox, casesPerTest, "every schema's refusals")

type RefusedFeature = `refused: ${string}`

layer(Substrate.layer, { excludeTestServices: true })(
	"the law-family box's named invalid points",
	(it) => {
		it.effect(
			"a capacity over an inexact weight or a float bound is refused with UnsupportedLawFamily",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "laws/box/refused",
							generator: element(refusedCapacities),
							literal: (r: RefusedCapacity) => r.name,
							limit: refusedCapacities.length,
							coverage: requiredInSpace<RefusedFeature>(
								Arr.map(refusedCapacities, (r): RefusedFeature => `refused: ${r.name}`)
							),
							caseHang
						},
						(r, c) =>
							Effect.gen(function* () {
								const installed = yield* Effect.result(installLaws(r.schema, ordinarySession))
								assert.ok(Result.isFailure(installed), `${r.name} installs`)
								const failure = installed.failure
								assert.ok(
									failure._tag === "CompileError" && failure.reason._tag === "UnsupportedLawFamily",
									`${r.name}: refused with ${failure._tag === "CompileError" ? failure.reason._tag : failure._tag}`
								)
								c.note(`refused: ${r.name}`)
							})
					)
				)
		)
	}
)
