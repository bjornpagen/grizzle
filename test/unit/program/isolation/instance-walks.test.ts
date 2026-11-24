/**
 * A statement's query CTEs are walked once for each polarity and count they are read at (program/isolation/extract.ts
 * Statement, Template), however many of its writes the sites that read them feed: each instance of one, its arrival at
 * the writes its site feeds, holds that walk's reads, cores and rows, the very lists, and states only its probes' gates
 * and the instances it reads for its own writes. Where each arrival walked the CTE's query again and held reads of its
 * own, a CTE read for k writes through a chain of d CTEs walked d·k queries; on edullm's qti at hub 74dc1011f a
 * learner's answerTestItem held 19,695 instances and 663,064 read facts in 9 statements, 22.6 s of certification
 * (perf/perf-phys/qti-units-factsc). The work is counted (test/support/kernel/calls.ts): the constructions of Walk.
 *
 * The box, constructed: a chain of d query CTEs (d of 1 to 3), the first reading a stored table and each later one the
 * one before it, read by k INSERTs (k of 1 to 4), k - 1 of them data-modifying CTEs and the last the statement's own,
 * each its own write; and, where drawn, the last also reading the chain's end under NOT EXISTS, a second polarity.
 *
 * Oracle: a bound read off the statement: its walks are its body's and one per CTE of the chain for each polarity it is
 * read at, d or 2d, whatever k; its instances' read lists are as many, one per walk; and its instances are one per CTE
 * of the chain for each write that reads it at each polarity, d·k, and d more for the NOT EXISTS.
 *
 * Features: a chain read by several writes; a chain read at two polarities; a chain of several CTEs.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { memberFacts } from "#compiler/program/isolation/extract.ts"
import type { Cte, Insert, OperandSelect, SqlStatement } from "#compiler/sql/ast.ts"
import {
	col,
	core,
	cteRefAs,
	exists,
	lit,
	not,
	objectName,
	operandSelect,
	proved,
	select,
	table,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { NAMES, slotFill } from "#test/unit/program/isolation/extract.fixtures.ts"

type Situation =
	| "a chain read by several writes"
	| "a chain read at two polarities"
	| "a chain of several CTEs"

/** A case: the chain's length, the writes that read its end, and whether the last also reads it under NOT EXISTS. */
interface Drawn {
	readonly depth: 1 | 2 | 3
	readonly writes: 1 | 2 | 3 | 4
	readonly negated: boolean
}

const drawnGen: Gen<Drawn> = (source) => ({
	depth: source.draw(element([1, 2, 3] as const)),
	writes: source.draw(element([1, 2, 3, 4] as const)),
	negated: source.draw(boolean)
})

/** `SELECT q.c_id AS c_id FROM <from> AS q`, where `from` is a CTE's name or app.r. */
const reading = (from: string | undefined): OperandSelect =>
	operandSelect(
		core(
			[targetAs(col("q", "c_id"), "c_id")],
			[from === undefined ? table("app", "r", "q") : cteRefAs(from, "q")],
			undefined
		)
	)

/** An INSERT into app.w of the chain's end `last`, where drawn also reading it under NOT EXISTS. */
const inserting = (last: string, negated: boolean, w: Insert["with"]): Insert => ({
	kind: "insert",
	with: w,
	table: objectName("app", "w"),
	alias: undefined,
	onConflict: undefined,
	returning: [],
	columns: ["c_id"],
	source: {
		kind: "query",
		query: select(
			proved(
				"keyed",
				core(
					[targetAs(col("q", "c_id"), "c_id")],
					[cteRefAs(last, "q")],
					negated
						? not(
								exists(
									operandSelect(
										core(
											[targetAs(lit.int(1, types.integer), "one")],
											[cteRefAs(last, "n")],
											undefined
										)
									)
								)
							)
						: undefined
				)
			)
		)
	}
})

/** The statement of a drawn case: the chain, the data-modifying CTEs reading its end, and the INSERT that ends it. */
const statementOf = (d: Drawn): SqlStatement => {
	const chain = Array.from({ length: d.depth }, (_, i): Cte => ({
		name: `q${i}`,
		materialized: undefined,
		query: reading(i === 0 ? undefined : `q${i - 1}`)
	}))
	const last = `q${d.depth - 1}`
	const writers = Array.from({ length: d.writes - 1 }, (_, i): Cte => ({
		name: `w${i}`,
		materialized: undefined,
		query: inserting(last, false, undefined)
	}))
	return inserting(last, d.negated, {
		recursive: false,
		ctes: nonEmpty([...chain, ...writers], "the chain and its writers")
	})
}

/** A statement's query CTEs are walked once for each polarity and count they are read at, however many writes read them. */
export const aStatementsQueryCtesAreWalkedOnceForEachPolarityAndCountTheyAreReadAtHoweverManyWritesReadThem =
	property.exhaust(finite(drawnGen), {
		needs: {},
		situations: [
			"a chain read by several writes",
			"a chain read at two polarities",
			"a chain of several CTEs"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (d) =>
			Effect.gen(function* () {
				const [facts, counts] = yield* callCounts(
					Effect.sync(() =>
						memberFacts("member", [statementOf(d)], NAMES, (_, n) => slotFill(n), "serializable")
					),
					{ walks: { file: "packages/engine/src/program/isolation/extract.ts", name: "Walk" } }
				)
				const statement = Arr.getUnsafe(facts.statements, 0)
				const polarities = d.negated ? 2 : 1
				assert.equal(
					counts.walks,
					1 + d.depth * polarities,
					"the body's walk and one per CTE of the chain at each polarity"
				)
				assert.equal(
					new Set(Arr.map(statement.ctes, (cte) => cte.reads)).size,
					d.depth * polarities,
					"one read list per walk"
				)
				assert.equal(
					statement.ctes.length,
					d.depth * d.writes + (d.negated ? d.depth : 0),
					"one instance per CTE of the chain for each write reading it at each polarity"
				)
				if (d.writes > 1) {
					c.note("a chain read by several writes")
				}
				if (d.negated) {
					c.note("a chain read at two polarities")
				}
				if (d.depth > 1) {
					c.note("a chain of several CTEs")
				}
			}),
		oracle: {
			kind: "universal",
			name: "a bound: walks and read lists one per CTE of the chain at each polarity, whatever the writes that read it"
		},
		box: "every chain of one to three query CTEs read by one to four writes, at one polarity or two",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\treturn this.#templates.getOrInsertComputed([cte, polarity, counted], () => {\n",
				replacement:
					"\t\treturn ((_key: unknown, walk: () => Template) => walk())([cte, polarity, counted], () => {\n",
				why: "Each arrival walks its CTE's query again, as at 74dc1011f: a chain read by several writes walks once per write and its instances hold read lists of their own, and the property fails."
			}
		]
	})
