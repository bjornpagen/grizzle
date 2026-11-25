/**
 * What the properties of source-digests.test.ts read: drawn PL/pgSQL functions, each of one to three probes whose
 * queries are print-once's drawn statements (test/unit/sql/print-once.fixtures.ts), each CTE plain, MATERIALIZED, NOT
 * MATERIALIZED or calling a VOLATILE function and read none, one or two times, a probe's message holding a tab or not;
 * ForwardBranchRule's upkeep's shape, kept; a function's record, its CREATE FUNCTION as a drafted file spells it, and
 * the source PostgreSQL stores of it, read off that text's lexemes.
 */

import { appendNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { filed } from "#compiler/deploy/render/filed.ts"
import type { DraftedFile } from "#compiler/deploy/render/folder.ts"
import { recordedObject, type SourceDigest } from "#compiler/deploy/snapshot/recorded.ts"
import type { PlFunction, PlStatement } from "#compiler/sql/ast.ts"
import {
	col,
	core,
	cteRefAs,
	operandSelect,
	qualifiedCall,
	table,
	target
} from "#compiler/sql/build.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	type StatementShape,
	statementGen,
	statementOf
} from "#test/unit/sql/print-once.fixtures.ts"

/** One probe of a drawn function: its query's shape, and whether the message it raises holds a tab. */
export interface ProbeShape {
	readonly query: StatementShape
	readonly tab: boolean
}

/** A drawn function: its probes, in its body's order. */
export interface FunctionShape {
	readonly probes: ReadonlyArray<ProbeShape>
}

/** A box of drawn functions: two to four, and the order they are printed in a second time, a permutation's seed. */
export interface FunctionsShape {
	readonly functions: ReadonlyArray<FunctionShape>
	readonly order: ReadonlyArray<number>
}

const probeGen: Gen<ProbeShape> = (source) => ({
	query: source.draw(statementGen),
	tab: source.draw(boolean)
})

const functionGen: Gen<FunctionShape> = (source) => ({
	probes: source.draw(array(probeGen, { min: 1, max: 3 }))
})

export const functionsGen: Gen<FunctionsShape> = (source) => {
	const functions = source.draw(array(functionGen, { min: 2, max: 4 }))
	return {
		functions,
		order: Arr.map(functions, () => source.draw(int(0, functions.length * 8)))
	}
}

/** A probe's statement: its query read whole, a row of it raising, the message holding a tab where the shape says. */
const probeOf = (probe: ProbeShape, at: number): PlStatement => ({
	kind: "whenFound",
	query: statementOf(probe.query),
	body: [
		{
			kind: "raise",
			message: probe.tab ? `probe ${at}\tfound a row` : `probe ${at} found a row`,
			using: []
		}
	]
})

/** The PL/pgSQL function named `name` whose body is `body`, as grizzle's upkeeps and judges are declared. */
export const plFunction = (name: string, body: ReadonlyArray<PlStatement>): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: { schema: "source_digests", name },
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	returns: "void",
	params: [],
	body: {
		declare: [],
		body: appendNonEmpty(body, { kind: "raise", message: "the probes found no row", using: [] })
	}
})

/** The `at`-th function of a box. */
export const functionOf = (shape: FunctionShape, at: number): PlFunction =>
	plFunction(
		`__probe_${at}`,
		Arr.map(shape.probes, (p, k) => probeOf(p, k))
	)

/** A VOLATILE function of the schema, as a delta's reader is declared: what a MATERIALIZED CTE of an upkeep reads. */
const reader = (name: string) =>
	qualifiedCall({ kind: "qualified", schema: "source_digests", name, volatility: "VOLATILE" }, [])

/**
 * ForwardBranchRule's upkeep's shape (pantry src/qti/overlay-queries/tests.ts:2139, `__upkeep_forward_branch_rule`
 * at qti-pie B'' on grizzle 8ff136e86): a WITH whose first CTE reads a delta's reader, MATERIALIZED, read twice, and
 * whose second, the shared join of the relation's two rules, NOT MATERIALIZED, is read once, which print once prints in
 * place under its reference's alias; the record digested the body with the CTE, the file held it in place, and the
 * drift check refused every database the folder installed.
 */
export const forwardBranchRuleUpkeep: PlFunction = plFunction("__upkeep_forward_branch_rule", [
	{
		kind: "whenFound",
		query: {
			...operandSelect(
				core(
					[target(col("r1957", "c12")), target(col("r1958", "c12"))],
					[cteRefAs("r1954", "r1957"), cteRefAs("r1954", "r1958"), cteRefAs("r1955", "r1959")],
					undefined
				)
			),
			with: {
				recursive: false,
				ctes: [
					{
						name: "r1954",
						columns: ["c12"],
						materialized: "MATERIALIZED",
						query: operandSelect(
							core(
								[target(col("r1956", "c12"))],
								[
									{
										kind: "function",
										call: reader("__reader_news_instance"),
										alias: "r1956",
										columns: { kind: "named", names: ["c12"], ordinality: false },
										lateral: false
									}
								],
								undefined
							)
						)
					},
					{
						name: "r1955",
						columns: ["c674"],
						materialized: "NOT MATERIALIZED",
						query: operandSelect(
							core(
								[target(col("r529", "end"))],
								[table("source_digests", "node", "r529")],
								undefined
							)
						)
					}
				]
			}
		},
		body: [{ kind: "raise", message: "a forward branch rule moved", using: [] }]
	}
])

/** `fn`'s record's source digest, as a committed snapshot records it (snapshot/recorded.ts recordedObject). */
export const recordedSourceOf = (fn: PlFunction): SourceDigest => {
	const [statement] = recordedObject({
		kind: "lawFunction",
		ident: `function:${fn.name.schema}.${fn.name.name}`,
		ddl: [fn],
		reasons: [],
		state: "created",
		phase: "validate"
	}).ddl
	assert.ok(
		statement?.kind === "recordedFunction",
		"a PL/pgSQL function is recorded by its source's digest"
	)
	return statement.source
}

/**
 * The source PostgreSQL stores of a CREATE FUNCTION's text, read off its lexemes apart from generate's reader: the body
 * of its one dollar-quoted constant, the text as the printer writes it before a drafted file respells any constant.
 */
export const storedSourceOf = (text: string): string => {
	const bodies = Arr.flatMap(lexemesOf(text).lexemes, (l) => (l.kind === "dollar" ? [l.body] : []))
	assert.equal(
		bodies.length,
		1,
		"a printed PL/pgSQL function holds one dollar-quoted constant, its body"
	)
	return defined(bodies[0], "the body")
}

/** `fn`'s CREATE FUNCTION as a drafted file spells it (deploy/render/filed.ts), a body holding a tab as an escape string. */
export const filedCreate = (fn: PlFunction): string => filed(printStatement(fn))

/** A drafted folder of one file whose statements are `texts`, as generate records them, in order. */
export const folderOf = (texts: ReadonlyArray<string>): ReadonlyArray<DraftedFile> => [
	{
		name: "04-validate.sql",
		steps: Arr.map(texts, (statement) => ({ kind: "statement" as const, statement })),
		locks: 0
	}
]

/** The permutation of `0..n-1` a box's seeds draw: each index sorted by its seed, ties by index. */
export const permutationOf = (seeds: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.map(
		Arr.sort(
			Arr.map(seeds, (seed, i) => ({ seed, i })),
			Order.combine(
				Order.mapInput(Order.Number, (p: { readonly seed: number; readonly i: number }) => p.seed),
				Order.mapInput(Order.Number, (p: { readonly seed: number; readonly i: number }) => p.i)
			)
		),
		(p) => p.i
	)
