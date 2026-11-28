/**
 * The type cost of a write's guarded inserts that negate bound queries over relation parameters generic helpers declare
 * (query/budget/guards.ts), as edullm's answer write negates the admission in force: each insert reads the reasons in
 * force and the hidden responses, queries over a call of a function of one row whose rows arguments read the posted
 * lists, bound to the rule's own parameters by `<L>(r: Rule<L>)` helpers (TS2589 at the write's `.once` and `clocked`
 * with 44 relation parameters over the Installed level, GRADING-SQL P4-ITEM-2).
 *
 * Properties: the natural form at 8, 16 and 24 inserts over a base of 10 relations and one of 40 typechecks with no
 * diagnostic, each step adds instantiations no faster than linearly (incrementsDoNotGrow), and each step adds
 * exactly as many over the large base as over the small one: an insert's cost is its own, never a walk of the level
 * its relation parameters' headings were written over. One relation parameter read under two headings whose `value`
 * fields differ is refused at the call that passes a value of one: the relation parameter's rows are each heading's,
 * intersected.
 * Oracle: the compiler's own counts and diagnostics (test/support/types/batch/measured.ts), compared step against step and
 * base against base.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import {
	assertClean,
	costGate,
	type Measuring,
	measuredEach
} from "#test/support/types/batch/measured.ts"
import { entriesFrom } from "#test/support/types/query/budget/generate.ts"
import { guardCases } from "#test/types/query/budget/guards.dictionary.ts"
import {
	bases,
	differingSource,
	type GuardCase,
	insertSteps,
	naturalSource
} from "#test/types/query/budget/guards.ts"

/**
 * The natural form at each size over each base, all checked at once: clean, linear in its inserts over each base, and
 * each step's increment the same over both bases.
 */
const insertCost = (at: Measuring) =>
	Effect.gen(function* () {
		const programs = Arr.flatMap(bases, (base) =>
			Arr.map(insertSteps.sizes, (inserts) => ({ base, inserts }))
		)
		const measured = yield* measuredEach(
			at,
			Arr.map(programs, (shape) => ({
				size: shape.inserts,
				source: (entries: PreludeAt) => naturalSource(shape, entries)
			}))
		)
		for (const m of measured) {
			assertClean(m, "a write's guarded inserts")
		}
		const counts = new Map(
			Arr.map(Arr.zip(programs, measured), ([p, m]) => [`${p.base}:${p.inserts}`, m.instantiations])
		)
		const countAt =
			(base: number) =>
			(inserts: number): number =>
				defined(
					counts.get(`${base}:${inserts}`),
					`the program of ${inserts} inserts over ${base} relations`
				)
		const [small, middle, large] = insertSteps.sizes
		for (const base of bases) {
			const count = countAt(base)
			assert.ok(
				count(middle) > count(small),
				`each step adds instantiations over ${base} relations: ${count(small)} at ${small}, ${count(middle)} at ${middle}`
			)
			incrementsDoNotGrow(
				count,
				insertSteps.half,
				`instantiations of the guarded inserts over ${base} relations`
			)
		}
		const [few, many] = bases
		for (const [from, to] of [
			[small, middle],
			[middle, large]
		] as const) {
			assert.equal(
				countAt(many)(to) - countAt(many)(from),
				countAt(few)(to) - countAt(few)(from),
				`the inserts from ${from} to ${to} cost as many instantiations over ${many} relations as over ${few}`
			)
		}
	})

/** The differing rows: one diagnostic, at the once that passes a bigint value. */
const differingRefused = (at: Measuring) =>
	Effect.gen(function* () {
		const [measured] = yield* measuredEach(at, [{ size: 0, source: differingSource }])
		const m = defined(measured, "the differing-rows program")
		assert.deepEqual(
			m.unattributed,
			[],
			"the differing-rows program reports nothing outside itself"
		)
		const lines = Str.split(differingSource(entriesFrom((path) => path)), "\n")
		const once = Arr.findFirstIndex(lines, Str.includes("db.workload.both.once"))
		assert.deepEqual(
			Arr.map(m.errors, (e) => e.line),
			[defined(Option.getOrUndefined(once), "the once of the differing-rows program") + 1],
			"one relation parameter under two headings is refused at the call, and only there"
		)
	})

/** Each case of the box, measured. */
export const guards = costGate(guardCases, {
	box: "a write's guarded inserts negating bound queries over relation parameters generic helpers declare",
	name: (c: GuardCase) =>
		c.kind === "inserts"
			? `guarded inserts at ${Arr.join(
					Arr.map(insertSteps.sizes, (n) => `${n}`),
					", "
				)} over ${Arr.join(
					Arr.map(bases, (n) => `${n}`),
					" and "
				)} base relations`
			: "one relation parameter under two headings",
	measure: (at, c) => (c.kind === "inserts" ? insertCost(at) : differingRefused(at)),
	oracle: {
		kind: "universal",
		name: "the compiler's own counts and diagnostics, compared step against step and base against base"
	},
	kills: [
		{
			file: "packages/engine/src/types/query/terms.ts",
			original: "Row = ParamRow<C>",
			replacement: "Row = FactOfFields<C> & ParamRow<C>",
			why: "A relation parameter's rows hold FactOfFields<C>, a mapped type over the heading C a generic helper wrote, which holds the helper's type parameter bound to the whole level, and a row of each heading is a type of its own: every instantiation of a row walks the level again, and the rows of every insert that reads a relation parameter intersect to a union of every choice of an array or a Stream of each (edullm's answer write, TS2589 at its .once)."
		},
		{
			file: "packages/engine/src/types/query/terms.ts",
			original: "Record<K, FieldHost<C[K]>>",
			replacement: "Record<K, FieldHost<C[K]> | unknown>",
			why: "A relation parameter's rows hold any value at each field: two headings that differ at a field no longer refuse a value of one, so the differing rows typecheck."
		}
	]
})
