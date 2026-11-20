import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer } from "effect"
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
	readBits,
	type Sketch,
	sketchGen,
	storedBits
} from "#test/pg/write/fact-sets/fact-sets.fixtures.ts"
import { answered } from "#test/support/calls.ts"
import { conservativeServedJson, servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A parameter relation's facts are stored with the bits they were written with, on PostgreSQL 19, by the optimized
 * artifact and by the conservative realization alike, wherever a write reads it and however many times: a float's -0,
 * NaN and subnormals survive a projection of the relation, a region that leaves a field unbound, its read beside a
 * header, a union of two rules over it, a put's carrier and a deletion beside an insert, and two facts at one key that
 * differ only in a zero's sign are refused as two facts; a put over a stored fact that differs from it in a zero's sign
 * alone reads back as a change.
 */
export const aParameterRelationsFactsAreStoredWithTheBitsTheyWereWrittenWithByBothArtifactsWhereverAWriteReadsItAndTwoFactsAtOneKeyAreRefused =
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
								const conservativeJson =
									s.artifact === "conservative"
										? yield* conservativeServedJson(o.installed, o.server, o.server.workload)
										: undefined
								const served =
									conservativeJson === undefined
										? o.served
										: servedFixtureOf(o.installed, o.server, conservativeJson)
								const context = yield* Layer.build(served.layer)
								const db = yield* Db.open(served.login.roles.app, {}).pipe(
									Effect.provideContext(context)
								)
								const given = givenOf(s)
								const first = [{ variable: at.variable, field: 1n, value: s.first }]
								/** A write's answer, its outcome and no read-back. */
								const plain = <O extends { readonly kind: Answer["outcome"] }, E, R>(
									write: Effect.Effect<O, E, R>
								) =>
									Effect.map(write, (o): Pick<Answer, "outcome" | "reads"> => ({
										outcome: o.kind,
										reads: []
									}))
								const read = (() => {
									switch (s.write) {
										case "once":
											return db.workload.once
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(answered, plain)
										case "dropped":
											return db.workload.dropped
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(answered, plain)
										case "twice":
											return db.workload.twice
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(answered, plain)
										case "thrice":
											return db.workload.thrice
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(answered, plain)
										case "carried":
											return db.workload.carried
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(answered, plain)
										case "swap":
											return Effect.flatMap(
												db.workload.loadArm.once({
													params: {},
													facts: {
														insert: {
															Arm: [{ s: at.s, variable: at.variable, field: 1n, value: gone(s) }]
														}
													}
												}),
												() =>
													db.workload.swap
														.once({
															params: {
																s: at.s,
																gone: [{ variable: at.variable, field: 1n, value: gone(s) }],
																given: first
															},
															facts: {}
														})
														.pipe(answered, plain)
											)
										case "replaced":
											return Effect.flatMap(
												db.workload.loadP.once({
													params: {},
													facts: {
														insert: { P: [{ s: at.s, variable: at.variable, value: gone(s) }] }
													}
												}),
												() =>
													Effect.map(
														answered(
															db.workload.replaced.once({
																params: { s: at.s, given: first },
																facts: {}
															})
														),
														(o): Pick<Answer, "outcome" | "reads"> =>
															o.kind === "accepted" || o.kind === "unchanged"
																? {
																		outcome: o.kind,
																		reads: [
																			["added", readBits(o.reads.added)],
																			["removed", readBits(o.reads.removed)]
																		]
																	}
																: { outcome: o.kind, reads: [] }
													)
											)
									}
								})()
								const { outcome, reads } = yield* read
								const model = expected(s)
								const bits = yield* Effect.forEach(model.stored, ([name]) =>
									Effect.map(storedBits(o.installed, name), (b) => [name, b] as const)
								)
								const answer: Answer = { outcome, stored: bits, reads }
								assert.deepEqual(
									answer,
									model,
									`${Formatter.format(s)} (written ${Arr.join(
										Arr.map(givenOf(s), (f) => bitsOf(f.value)),
										", "
									)}): answered ${Formatter.format(answer)}, the fact identity gives ${Formatter.format(model)}`
								)
								c.note(featureOf(s))
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
		box: "each write of a parameter relation (read once, by a region without its field, twice beside a header, three times by a union and a header, carried by a put, beside a deletion, by a put over a stored fact read back as its changes), its facts one, one stated twice or two at one key, each of both zeros, NaN, both least subnormals, the least normal and 1.5, by the optimized artifact and by the conservative realization",
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
			},
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: "\t\t\t\treturn factSpine(this.dag).has(node)",
				replacement: "\t\t\t\treturn false",
				why: "The conservative realization's boundaries on a member's fact spine compare under PostgreSQL's equality, so its head's SELECT DISTINCT keeps one of two facts at one key that differ in a zero's sign, and accepts it."
			},
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: '\t\tcase "ProjectSet":\n\t\tcase "Filter":\n\t\t\treturn [node.input]',
				replacement: '\t\tcase "ProjectSet":\n\t\tcase "Filter":\n\t\t\treturn []',
				why: "A member's region is off its fact spine, so the conservative region that leaves a field unbound keeps one of two facts that differ in a zero's sign, and the write accepts it."
			},
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original:
					'\t\tif (!this.#onFactSpine(node)) {\n\t\t\treturn select(\n\t\t\t\tsetBodyOf(setOp("UNION", arms)',
				replacement:
					'\t\tif (node.kind === "Union") {\n\t\t\treturn select(\n\t\t\t\tsetBodyOf(setOp("UNION", arms)',
				why: "The conservative member's root union is a set UNION under PostgreSQL's equality, so its arms' -0 and +0 at one key are one fact, accepted."
			},
			{
				file: "packages/engine/src/write/carriers/carriers.ts",
				original:
					"\tconst leftOperand = factOperand(left.columns)\n\tconst rightOperand = factOperand(right.columns)",
				replacement:
					"\tconst leftOperand = { targets: mapNonEmpty(left.columns, (c) => c.target), signs: 0 }\n\tconst rightOperand = { targets: mapNonEmpty(right.columns, (c) => c.target), signs: 0 }",
				why: "The conservative realization's state difference compares under PostgreSQL's equality, so a put of +0 over a stored -0 reads back no change."
			}
		]
	})
