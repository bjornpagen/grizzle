import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	type Answer,
	at,
	bitsOf,
	expected,
	type Feature,
	Facts,
	factsInstall,
	factsTemplate,
	featureOf,
	features,
	givenOf,
	gone,
	type Sketch,
	sketchGen,
	storedBits
} from "#test/pg/write/fact-sets/fact-sets.fixtures.ts"
import { answered } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A parameter relation's facts are stored with the bits they were written with, on PostgreSQL 19, wherever a write reads
 * it and however many times: a float's -0, NaN and subnormals survive a projection of the relation, its read beside a
 * header, a union of two rules over it, a put's carrier and a deletion beside an insert, and two facts at one key that
 * differ only in a zero's sign are refused as two facts.
 */
export const aParameterRelationsFactsAreStoredWithTheBitsTheyWereWrittenWithWhereverAWriteReadsItAndTwoFactsAtOneKeyAreRefused =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.seat(factsTemplate) },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s: Sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Facts, {}, factsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const given = givenOf(s)
									const call = (() => {
										switch (s.write) {
											case "once":
												return db.workload.once.once({ params: { s: at.s, given }, facts: {} })
											case "twice":
												return db.workload.twice.once({ params: { s: at.s, given }, facts: {} })
											case "thrice":
												return db.workload.thrice.once({ params: { s: at.s, given }, facts: {} })
											case "carried":
												return db.workload.carried.once({ params: { s: at.s, given }, facts: {} })
											case "swap": {
												const stored = { s: at.s, variable: at.variable, field: 1n, value: gone(s) }
												return Effect.flatMap(
													db.workload.load.once({
														params: {},
														facts: { insert: { Arm: [stored] } }
													}),
													() =>
														db.workload.swap.once({
															params: {
																s: at.s,
																gone: [{ variable: at.variable, field: 1n, value: gone(s) }],
																given: [{ variable: at.variable, field: 1n, value: s.first }]
															},
															facts: {}
														})
												)
											}
										}
									})()
									const outcome = yield* answered(call)
									const model = expected(s)
									const stored = yield* Effect.forEach(model.stored, ([name]) =>
										Effect.map(storedBits(o.installed, name), (bits) => [name, bits] as const)
									)
									const answer: Answer = { outcome: outcome.kind, stored }
									assert.deepEqual(
										answer,
										model,
										`${Formatter.format(s)} (written ${Arr.join(
											Arr.map(givenOf(s), (f) => bitsOf(f.value)),
											", "
										)}): answered ${Formatter.format(answer)}, the fact identity gives ${Formatter.format(model)}`
									)
									c.note(featureOf(s))
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the fact identity: a parameter relation is a set of facts by their bits but NaN's, and a write stores each fact it states"
		},
		box: "each write of a parameter relation (read once, twice beside a header, three times by a union and a header, carried by a put, beside a deletion), its facts one, one stated twice or two at one key, each of both zeros, NaN, both least subnormals, the least normal and 1.5",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\twrittenTarget(origin) === undefined ? "values" : "facts"',
				replacement: '\twrittenTarget(origin) === undefined ? "values" : "values"',
				why: "A member root's head and union arms take the canonical zero again, so a projected -0 is stored as +0."
			},
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\tif (signs.length === 0) {\n\t\treturn distinctCore(targets, from, where)",
				replacement: "\tif (signs.length >= 0) {\n\t\treturn distinctCore(targets, from, where)",
				why: "A write deduplicates its facts under PostgreSQL's equality, so two facts at one key that differ in a zero's sign are one, stored with the zero its plan meets first, and accepted."
			},
			{
				file: "packages/engine/src/lower/optimize/dedup/policy.ts",
				original:
					'\tisPinnedDistinct(node) || (node.kind === "Union" && !bounded) ? "distinct" : "plain"',
				replacement: '\tisPinnedDistinct(node) || node.kind === "Union" ? "distinct" : "plain"',
				why: "A member's root union is a set UNION under PostgreSQL's equality, so its arms' -0 and +0 at one key are one fact, accepted."
			},
			{
				file: "packages/engine/src/write/carriers/carriers.ts",
				original: "\t\treturn select(factSet(columns, [wrapped.item], undefined))",
				replacement: "\t\treturn select(distinctCore(targets, [wrapped.item], undefined))",
				why: "A put's carrier holds its member's rows under PostgreSQL's equality, so two facts at one key that differ in a zero's sign are one, accepted."
			},
			{
				file: "packages/engine/src/write/delete/exact.ts",
				original: '\t\tconst facts = except.length === 0 ? "rows" : "facts"',
				replacement: '\t\tconst facts = except.length === 0 ? "rows" : "rows"',
				why: "D EXCEPT A compares under PostgreSQL's equality, so the deletion of a stored -0 beside an insert of +0 deletes nothing and the insert is refused at the stored fact's key."
			}
		]
	})
