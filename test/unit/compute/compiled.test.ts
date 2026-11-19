/**
 * The host evaluator compiles an expression's table once, where it is first evaluated (scalar/compute/evaluate.ts
 * compiledExpr): rowEvaluator over a schema of the NULL language evaluates a row's generated field, its row checks and
 * its selection, and every later row, the first one again among them, compiles no table and no expression, its
 * evaluation reading the compiled form alone; and each value is the NULL language's.
 *
 * And an admitted row is read once (runtime/write/witness.ts RowReading): evaluated as a row of Gen and of the
 * selection, its relation's items are computed once for both sources and each of its columns is read at most once,
 * however many of its generated field, its checks and its selection read it; evaluated again, as a row of either source,
 * it reads no column and computes no item, and answers as before.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts), the
 * compile of a table and of each of its expressions, a column of a row read and a row's items computed. Each case draws a world of closed relations over two rosters
 * (language.ts World), one to five of its rows, a generated field of a drawn stored sort, two row checks and a
 * selection's predicate, each in the check vocabulary, two levels deep. Its first row is evaluated as a row of Gen and
 * of the selection, which compiles their tables; then every row is, the first again among them, with no compile at all,
 * each generated value the language's value of its term (language.ts evalTerm), each check holding exactly where the
 * language's truth of its predicate is true (evalPred), and the selection keeping exactly those rows.
 *
 * Features: each truth of a check and of the selection, a generated value and a NULL one, several rows.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { fromHost, itemFact } from "#test/support/null/build.ts"
import { evalPred, evalTerm, type Item, silent, sortOf } from "#test/support/null/language.ts"
import {
	builtOf,
	caseGen,
	type CompiledCase,
	type CompiledFeature,
	compileSites,
	genColumns,
	readingSites
} from "#test/unit/compute/compiled.fixtures.ts"

/** A table is compiled once, where it is first evaluated: every later row's evaluation compiles nothing, and agrees with the NULL language. */
export const aTableIsCompiledOnceWhereItIsFirstEvaluatedEveryLaterRowsEvaluationCompilesNothingAndAgreesWithTheNullLanguage =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a check holds",
			"a check breaks",
			"a generated value",
			"a NULL generated value",
			"a row selected",
			"a row its selection leaves",
			"several rows"
		] satisfies ReadonlyArray<Reached<CompiledFeature>>,
		check: (_, k: Case<CompiledFeature>) => (cc: CompiledCase) =>
			Effect.gen(function* () {
				const built = builtOf(cc)
				const { Gen } = built
				const evaluate = succeeded(rowEvaluator(built.schema), "the case's schema compiles")
				/** Each row evaluated as a row of Gen and of the selection: its generated value, verdicts and selection. */
				const pass = (rows: ReadonlyArray<readonly [number, Item]>) =>
					Arr.map(rows, ([id, item]) => {
						const admitted = evaluate.admit(Gen, itemFact(built.c, item, id))
						if (Result.isFailure(admitted)) {
							return assert.fail(
								`a row of Gen, which no domain refuses: ${Formatter.format(admitted.failure)}`
							)
						}
						const evaluated = evaluate(Gen, admitted.success)
						return {
							item,
							g: evaluated.generated.g,
							checks: [evaluated.checks.Holds0, evaluated.checks.Holds1] as const,
							selected: evaluate(built.selected, admitted.success).selected
						}
					})
				const rows = Arr.map(cc.items, (item, id) => [id, item] as const)
				const [, first] = yield* callCounts(
					Effect.sync(() => pass(rows.slice(0, 1))),
					compileSites
				)
				assert.ok(first.tables > 0, "the first row's evaluation compiles its tables")
				const [answers, later] = yield* callCounts(
					Effect.sync(() => pass(rows)),
					compileSites
				)
				assert.deepEqual(
					later,
					{ tables: 0, expressions: 0 },
					"every row after the first compiles no table and no expression"
				)
				const sort = sortOf(cc.generated.term)
				for (const [id, answer] of answers.entries()) {
					const at = `row ${id} of ${Formatter.format(cc)}`
					const model = evalTerm(cc.world, answer.item, cc.generated.term, silent)
					yield* agree(
						[
							[`the NULL language, g at ${at}`, model],
							[
								"rowEvaluator",
								Result.isSuccess(answer.g)
									? answer.g.success === null
										? null
										: fromHost(sort, answer.g.success)
									: `no value: ${answer.g.failure.why}`
							]
						],
						exact
					)
					k.note(model === null ? "a NULL generated value" : "a generated value")
					for (const [j, [pred, verdict]] of Arr.zip(cc.checks, answer.checks).entries()) {
						const holds = evalPred(cc.world, answer.item, pred, silent) === true
						yield* agree(
							[
								[`the NULL language, Holds${j} at ${at}`, holds ? "holds" : "breaks"],
								[
									"rowEvaluator",
									Result.isSuccess(verdict) ? verdict.success : `no verdict: ${verdict.failure.why}`
								]
							],
							exact
						)
						k.note(holds ? "a check holds" : "a check breaks")
					}
					const selects = evalPred(cc.world, answer.item, cc.selection, silent) === true
					yield* agree(
						[
							[`the NULL language, the selection at ${at}`, selects],
							[
								"rowEvaluator",
								Result.isSuccess(answer.selected)
									? answer.selected.success
									: `unselected: ${answer.selected.failure.why}`
							]
						],
						exact
					)
					k.note(selects ? "a row selected" : "a row its selection leaves")
				}
				if (cc.items.length > 1) {
					k.note("several rows")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the NULL language's evaluation (test/support/null/language.ts evalTerm, evalPred); no compile past the first row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\tconst known = compiledTables.get(table)",
				replacement: "\tconst known: CompiledExpr | undefined = undefined",
				why: "Each evaluation of a table compiles it again, interpreting the table per row: every row after the first compiles its tables and expressions anew, and the property fails."
			}
		]
	})

/** An admitted row is read once: both its sources evaluate it over one reading, each column read and its items computed once. */
export const anAdmittedRowIsReadOnceBothItsSourcesEvaluateItOverOneReadingEachColumnReadAndItsItemsComputedOnce =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a row selected",
			"a row its selection leaves",
			"several rows"
		] satisfies ReadonlyArray<Reached<CompiledFeature>>,
		check: (_, k: Case<CompiledFeature>) => (cc: CompiledCase) =>
			Effect.gen(function* () {
				const built = builtOf(cc)
				const { Gen } = built
				const evaluate = succeeded(rowEvaluator(built.schema), "the case's schema compiles")
				const rows = Arr.map(cc.items, (item, id) => {
					const admitted = evaluate.admit(Gen, itemFact(built.c, item, id))
					return Result.isSuccess(admitted)
						? admitted.success
						: assert.fail(
								`a row of Gen, which no domain refuses: ${Formatter.format(admitted.failure)}`
							)
				})
				/** Each admitted row evaluated as a row of Gen and of the selection. */
				const pass = () =>
					Arr.map(rows, (row) => {
						const whole = evaluate(Gen, row)
						return {
							g: whole.generated.g,
							checks: [whole.checks.Holds0, whole.checks.Holds1] as const,
							selected: evaluate(built.selected, row).selected
						}
					})
				const [first, firstCounts] = yield* callCounts(Effect.sync(pass), readingSites)
				assert.equal(
					firstCounts.items,
					rows.length,
					"each admitted row's items are computed once, for both of its sources"
				)
				assert.ok(
					firstCounts.columns <= rows.length * genColumns(built.c),
					`each column of a row is read at most once: ${firstCounts.columns} reads of ${rows.length} rows of ${genColumns(built.c)} columns`
				)
				const [again, againCounts] = yield* callCounts(Effect.sync(pass), readingSites)
				assert.deepEqual(
					againCounts,
					{ columns: 0, items: 0 },
					"a row evaluated again, as a row of either source, reads no column and computes no item"
				)
				assert.deepEqual(again, first, "a row evaluated again answers as before")
				for (const answer of first) {
					k.note(
						Result.isSuccess(answer.selected) && answer.selected.success
							? "a row selected"
							: "a row its selection leaves"
					)
				}
				if (rows.length > 1) {
					k.note("several rows")
				}
			}),
		oracle: {
			kind: "specification",
			name: "one reading of an admitted row: its items computed once, each column read at most once, none read again"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original: "\t\t\tif (known !== undefined || columns.has(name)) {",
				replacement: "\t\t\tif (false) {",
				why: "A row's reading keeps no column, so each expression over the row reads its columns again: a row evaluated again as a row of its selection reads every column the selection reads."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "items: once(() => itemsOf(relation, reading, answers))",
				replacement: "items: () => itemsOf(relation, reading, answers)",
				why: "An admitted row's items are computed at every evaluation of it, once for each source of its relation and again for each later evaluation, where one computation serves them all."
			}
		]
	})
