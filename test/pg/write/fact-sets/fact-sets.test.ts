import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { partRuns } from "#adapter/reader/execution.ts"
import { identity } from "#compiler/core/identity.ts"
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
	expectedRead,
	givenOf,
	gone,
	type ReadFeature,
	type ReadSketch,
	readBits,
	readFeatureOf,
	readFeatures,
	readGivenOf,
	reads,
	readSketchSpace,
	storeRec,
	type Sketch,
	sketchSpace,
	storedBits
} from "#test/pg/write/fact-sets/fact-sets.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import {
	compileTemplate,
	declaredOf,
	installedCodes,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { conservativeServedJson, servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"

/**
 * A parameter relation's facts are stored with the bits they were written with, on PostgreSQL 19, by the optimized
 * artifact and by the conservative realization alike, wherever a write reads it and however many times: a float's -0,
 * NaN and subnormals survive a projection of the relation, a region that leaves a field unbound, its read beside a
 * header, a union of two rules over it, a put's carrier and a deletion beside an insert, and two facts at one key that
 * differ only in a zero's sign are refused as two facts; a put over a stored fact that differs from it in a zero's sign
 * alone reads back as a change.
 *
 * Its budget is one case for each situation, the least that reaches them all: the floor's one case, and a steered case
 * for each situation it leaves pending, each of its situation's artifact and write, its values drawn among the pairs
 * that reach it (fact-sets.fixtures.ts sketchSpace). At it every one of its nine kills is killed, 53 cases where the
 * exhaustion of its box ran 784 (`toolchain-test run` of the file, TEST_SEED=2219874524, 2026-11-23); at one floor case
 * and 42 steered, before two facts at one key differing in a zero's sign alone was a situation of its own, the
 * carrier's kill and the conservative region's survived.
 */
export const aParameterRelationsFactsAreStoredWithTheBitsTheyWereWrittenWithByBothArtifactsWhereverAWriteReadsItAndTwoFactsAtOneKeyAreRefused =
	property.explore(sketchSpace, {
		needs: { fixture: Substrate.fresh(factsTemplate) },
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
												.pipe(writeAnswerOf, plain)
										case "dropped":
											return db.workload.dropped
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(writeAnswerOf, plain)
										case "twice":
											return db.workload.twice
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(writeAnswerOf, plain)
										case "thrice":
											return db.workload.thrice
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(writeAnswerOf, plain)
										case "carried":
											return db.workload.carried
												.once({ params: { s: at.s, given }, facts: {} })
												.pipe(writeAnswerOf, plain)
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
														.pipe(writeAnswerOf, plain)
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
														writeAnswerOf(
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
		budget: { runs: 1, steered: features.length - 1 },
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

/**
 * A read of a parameter relation delivers each of its facts, on PostgreSQL 19 by both lowerings: -0 and +0 at otherwise
 * equal fields are two rows, read whole, filtered or joined to a stored fact, each with the bits it was written with;
 * a projection that drops a field is a merge, which delivers +0 for either zero.
 *
 * Its budget is one case for each situation, the least that reaches them all: the floor's one case, and a steered case
 * for each situation it leaves pending, each of its situation's lowering and read, its values drawn among the pairs
 * that reach it (fact-sets.fixtures.ts readSketchSpace). At it every one of its three kills is killed, 33 cases where
 * the exhaustion of its box ran 448 (`toolchain-test run` of the file, TEST_SEED=2219874524, 2026-11-23).
 */
export const aReadOfAParameterRelationDeliversEachOfItsFactsByBothLoweringsAndAProjectionThatDropsAFieldTheCanonicalZero =
	property.explore(readSketchSpace, {
		needs: { fixture: Substrate.fresh(factsTemplate) },
		situations: readFeatures satisfies ReadonlyArray<Reached<ReadFeature>>,
		check:
			({ fixture }, c: Case<ReadFeature>) =>
			(s: ReadSketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const sub = yield* Substrate
								const o = yield* openedIn(Facts, {}, factsInstall, taken)
								yield* storeRec(o.installed)
								const query = reads[s.read]
								const options = {
									...testCompile,
									installation: identity.schema(parsedSchemaName(o.installed.declared)),
									codes: installedCodes(o.installed.names.codes)
								}
								const template = succeeded(
									compileTemplate(query, undefined, options),
									"the read compiles"
								)
								const artifact =
									s.lowering === "optimized" ? template.runs.optimized : template.runs.conservative
								const spec = artifact.statement.spec
								const params = paramTexts(
									spec,
									{ s: at.s, variable: at.variable, given: readGivenOf(s) },
									declaredOf(template, query, undefined, options)
								)
								const rows = yield* sub.admin.queryValues(spec.sql, params)
								const [run] = partRuns(
									artifact.parts,
									outputRows(Arr.map(rows, (row) => Arr.map(row, (cell) => String(cell))))
								)
								const place = Option.getOrThrowWith(
									Arr.findFirstIndex(spec.heading, (h) => h.name === "value"),
									() => new Error("the read's value column")
								)
								const delivered: ReadonlyArray<string> = Arr.sort(
									Arr.map(run ?? [], (cells) =>
										bitsOf(Number(defined(cells[place], "a row's value")))
									),
									Str.Order
								)
								const model = expectedRead(s)
								assert.deepEqual(
									delivered,
									model,
									`${Formatter.format(s)}: delivered ${Formatter.format(delivered)}, the fact identity gives ${Formatter.format(model)}`
								)
								c.note(readFeatureOf(s))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the fact identity: a read delivers each fact of a parameter relation by its bits but NaN's, and a projection's merge the canonical zero"
		},
		budget: { runs: 1, steered: readFeatures.length - 1 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\t\treturn carrier === undefined ? [] : [negativeZero(c.target.expr, carrier)]",
				replacement: "\t\treturn []",
				why: "The conservative read's parameter relation is SELECT DISTINCT under PostgreSQL's equality, so -0 and +0 at otherwise equal fields are one row, whichever its plan meets first."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tfloat8: (v) => floatText(v),",
				replacement: "\tfloat8: (v) => floatText(v === 0 ? 0 : v),",
				why: "The codec holds -0 and +0 one fact of a parameter relation, so neither lowering's read delivers both."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					'\t(props.distinct === "members" && props.columns.every((c) => columns.includes(c)))',
				replacement: "\tfalse",
				why: "Only a key tells a source's rows apart as facts (logical/props.ts identifiesFacts), so a rule's head reading a relation parameter whole, whose facts are a set's members with no key, merges its float through the canonical zero (check/merge.ts pickFree) and the optimized whole read delivers +0 for the fact -0."
			},
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original:
					"\t\t\treturn input.heading.every((c) => copied.has(c.name) || constant(c)) ? props.facts : undefined\n",
				replacement:
					"\t\t\treturn input.heading.every((c) => copied.has(c.name)) ? props.facts : undefined\n",
				why: "A projection that reads the parameter in place of the column a filter fixes at it copies no longer every column (lower/optimize/propagate): its rows are no facts, placement puts a DISTINCT on the filtered read, and -0 and +0 at its variable are one row, as at 3afa2a647."
			}
		]
	})
