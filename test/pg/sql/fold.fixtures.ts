/** What the property of fold.test.ts reads: its space, a sketch's statement and its twin, and the token rule. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import type {
	Expr,
	OperandCore,
	OperandSelect,
	Select,
	SetCore,
	Target
} from "#compiler/sql/ast.ts"
import {
	asc,
	binary,
	call,
	col,
	core,
	countStar,
	cte,
	cteRef,
	derived,
	distinctCore,
	lit,
	ne,
	operandSelect,
	param,
	provedCore,
	qualifiedCall,
	select,
	tableCol,
	target,
	types
} from "#compiler/sql/build.ts"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import { sql } from "#test/pg/sql/print.fixtures.ts"
import type { PgConnection } from "#test/support/pg.ts"

/**
 * A pass-through projection's fold (sql/print.ts passedThrough, foldedCore), drawn: a stack of one to three levels over
 * a VALUES relation of one to three rows of three small integers, each level a core over the one below as a derived
 * table that names its columns, read by the statement through a reader of its rows.
 *
 * - A projection level's targets: a column of the level below (most often, any column, read once, twice or never), a
 *   literal, a placeholder, a column plus one (computed from its row, calling nothing), and the calls abs of a column,
 *   random() (volatile) and generate_series(1, 2) (set-returning).
 * - An aggregating level's: count(*), count of a column, a literal and a placeholder, with no GROUP BY, so it is one
 *   row wherever it aggregates (an aggregate that is NULL over no row, which the audit refuses ungrouped, is none of
 *   them).
 * - The innermost level may filter the VALUES rows.
 * - The readers: the statement's own rows (by name), the same ordered by its columns (the query's ORDER BY reads the
 *   reading core's FROM), the core parenthesized as a body of its own under an ORDER BY of its output names (which is
 *   all PostgreSQL reads there, as it reads a set operation's), and by place: a CTE, which names its columns, and the
 *   subquery of an IN. Every reader but the IN reads the stack's top through a projection
 *   of picked columns, each read once or more, unaliased, so its rows' names are the columns' own.
 *
 * Its twin is the same statement with every core that reads a derived table filtered by WHERE TRUE, which no fold reads
 * through (a pass-through projection has no WHERE) and which keeps every row: what the statement meant before the
 * fold, which PostgreSQL computes.
 */
export type Term =
	| Readonly<{ kind: "column"; at: number }>
	| Readonly<{ kind: "literal"; value: number }>
	| Readonly<{ kind: "placeholder" }>
	| Readonly<{ kind: "plus"; at: number }>
	| Readonly<{ kind: "abs"; at: number }>
	| Readonly<{ kind: "random" }>
	| Readonly<{ kind: "series" }>

/** A target of an aggregating level. */
export type Aggregate =
	| Readonly<{ kind: "count" }>
	| Readonly<{ kind: "counted"; at: number }>
	| Readonly<{ kind: "literal"; value: number }>
	| Readonly<{ kind: "placeholder" }>

/** A level of the stack; each `at` names a column of the level below by place, taken modulo their count. */
export type Level =
	| Readonly<{ kind: "projection"; terms: Arr.NonEmptyReadonlyArray<Term> }>
	| Readonly<{ kind: "aggregate"; terms: Arr.NonEmptyReadonlyArray<Aggregate> }>

/** How the statement reads the stack's top (see the header). */
export type Reader = "statement" | "ordered" | "ordered through parentheses" | "CTE" | "IN"

/** A case: the VALUES rows, the innermost level's filter, the levels innermost first, the reader and its picks. */
export interface FoldSketch {
	readonly rows: Arr.NonEmptyReadonlyArray<readonly [number, number, number]>
	readonly filter: number | undefined
	readonly levels: Arr.NonEmptyReadonlyArray<Level>
	readonly reader: Reader
	readonly picks: Arr.NonEmptyReadonlyArray<number>
}

export type FoldFeature =
	| "a projection folded"
	| "a fold read by name"
	| "a fold read by place"
	| "kept under its query's ORDER BY"
	| "a fold read by name under an ORDER BY through parentheses"
	| "a placeholder folded"
	| "an aggregate kept"
	| "a set-returning call kept"
	| "a volatile call kept"
	| "a column read twice"

const small: Gen<number> = int(0, 3)

const termGen: Gen<Term> = weighted<Term>([
	[6, (source) => ({ kind: "column", at: source.draw(small) })],
	[1, (source) => ({ kind: "literal", value: source.draw(small) })],
	[1, () => ({ kind: "placeholder" })],
	[1, (source) => ({ kind: "plus", at: source.draw(small) })],
	[1, (source) => ({ kind: "abs", at: source.draw(small) })],
	[1, () => ({ kind: "random" })],
	[1, () => ({ kind: "series" })]
])

const aggregateGen: Gen<Aggregate> = weighted<Aggregate>([
	[2, () => ({ kind: "count" })],
	[2, (source) => ({ kind: "counted", at: source.draw(small) })],
	[1, (source) => ({ kind: "literal", value: source.draw(small) })],
	[1, () => ({ kind: "placeholder" })]
])

const levelGen: Gen<Level> = weighted<Level>([
	[
		3,
		(source) => ({
			kind: "projection",
			terms: nonEmpty(source.draw(array(termGen, { min: 1, max: 4 })), "a projection's targets")
		})
	],
	[
		1,
		(source) => ({
			kind: "aggregate",
			terms: nonEmpty(
				source.draw(array(aggregateGen, { min: 1, max: 3 })),
				"an aggregate's targets"
			)
		})
	]
])

const readers = [
	"statement",
	"ordered",
	"ordered through parentheses",
	"CTE",
	"IN"
] as const satisfies ReadonlyArray<Reader>

const rowGen: Gen<readonly [number, number, number]> = (source) => [
	source.draw(int(0, 2)),
	source.draw(int(0, 2)),
	source.draw(int(0, 2))
]

export const foldSketchGen: Gen<FoldSketch> = (source) => ({
	rows: nonEmpty(source.draw(array(rowGen, { min: 1, max: 3 })), "the VALUES rows"),
	filter: source.draw(
		weighted<number | undefined>([
			[2, () => undefined],
			[1, (s) => s.draw(int(0, 2))]
		])
	),
	levels: nonEmpty(source.draw(array(levelGen, { min: 1, max: 3 })), "the levels"),
	reader: source.draw(element(readers)),
	picks: nonEmpty(source.draw(array(small, { min: 1, max: 3 })), "the picks")
})

/** The columns c1 to c`width`, as a level's derived table names them. */
const columnsOf = (width: number): ReadonlyArray<string> =>
	Array.from({ length: width }, (_, i) => `c${i + 1}`)

/** A statement drawn from a sketch: its text, its placeholders' values, and how its rows compare. */
export interface FoldCase {
	readonly text: string
	readonly params: ReadonlyArray<string>
	readonly ordered: boolean
}

/** The guard a twin's every core over a derived table holds: WHERE TRUE, which keeps every row and no fold reads through. */
const guard = (twin: boolean): Expr | undefined => (twin ? lit.bool(true) : undefined)

/**
 * The statement a sketch draws, or its twin (`twin`): its levels innermost first, each a core over the one below as a
 * derived table `r<i>` naming its columns, the innermost over the VALUES `r0`, and the reader over the top as
 * `r<levels>`. Placeholders are numbered from 1 in the order the levels hold them, each bound to its number.
 */
export const foldCase = (sketch: FoldSketch, twin: boolean): FoldCase => {
	let placeholders = 0
	const placeholder = (): Expr => {
		placeholders += 1
		return param(placeholders, types.integer)
	}
	const valuesCore = (terms: (column: (at: number) => Expr) => ReadonlyArray<Target>) =>
		core(
			terms((at) => col("r0", `c${(at % 3) + 1}`)),
			[
				{
					kind: "values",
					rows: Arr.map(sketch.rows, (row) => Arr.map(row, (v) => lit.int(v, types.integer))),
					alias: "r0",
					columns: ["c1", "c2", "c3"]
				}
			],
			sketch.filter === undefined
				? undefined
				: ne(col("r0", "c1"), lit.int(sketch.filter, types.integer))
		)
	const targetsOf =
		(level: Level) =>
		(column: (at: number) => Expr): Arr.NonEmptyReadonlyArray<Target> =>
			level.kind === "projection"
				? Arr.map(level.terms, (term) => target(termExpr(term, column, placeholder)))
				: Arr.map(level.terms, (term) => target(aggregateExpr(term, column, placeholder)))
	const [first, ...above] = sketch.levels
	let top: OperandCore = valuesCore(targetsOf(first))
	let width = first.terms.length
	for (const [i, level] of above.entries()) {
		const alias = `r${i + 1}`
		const below = width
		top = core(
			targetsOf(level)((at) => col(alias, `c${(at % below) + 1}`)),
			[derived(operandSelect(top), alias, columnsOf(below), false)],
			guard(twin)
		)
		width = level.terms.length
	}
	const q = `r${sketch.levels.length}`
	const read = derived(operandSelect(top), q, columnsOf(width), false)
	const picked = Arr.map(sketch.picks, (p) => `c${(p % width) + 1}`)
	const once = nonEmpty(Arr.dedupe(picked), "the picks, each once")
	const reading = (columns: Arr.NonEmptyReadonlyArray<string>): SetCore =>
		distinctCore(
			Arr.map(columns, (c) => target(col(q, c))),
			[read],
			guard(twin)
		)
	const ordering = Arr.map(once, (c) => asc(col(q, c)))
	const byName = Arr.map(once, (c) => asc(tableCol(c)))
	const statement = ((): Select => {
		switch (sketch.reader) {
			case "statement":
				return select(reading(picked))
			case "ordered":
				return { ...select(reading(picked)), orderBy: ordering }
			case "ordered through parentheses":
				return { ...select(select(reading(once))), orderBy: byName }
			case "CTE": {
				const w = `r${sketch.levels.length + 1}`
				const named = columnsOf(once.length)
				return {
					...select(
						distinctCore(
							nonEmpty(
								Arr.map(named, (c) => target(col(w, c))),
								"the CTE's columns"
							),
							[cteRef(w)],
							undefined
						)
					),
					with: { recursive: false, ctes: [cte(w, named, select(reading(once)))] }
				}
			}
			case "IN": {
				const v = `r${sketch.levels.length + 1}`
				const subquery: OperandSelect = operandSelect(
					core([target(col(q, Arr.headNonEmpty(picked)))], [read], guard(twin))
				)
				return select(
					distinctCore(
						[target(col(v, "c1"))],
						[
							{
								kind: "values",
								rows: Arr.map([0, 1, 2, 3] as const, (n) => [lit.int(n, types.integer)]),
								alias: v,
								columns: ["c1"]
							}
						],
						{ kind: "inQuery", expr: col(v, "c1"), query: subquery, not: false }
					)
				)
			}
		}
	})()
	return {
		text: sql(statement),
		params: Array.from({ length: placeholders }, (_, i) => String(i + 1)),
		ordered: sketch.reader === "ordered" || sketch.reader === "ordered through parentheses"
	}
}

const termExpr = (term: Term, column: (at: number) => Expr, placeholder: () => Expr): Expr => {
	switch (term.kind) {
		case "column":
			return column(term.at)
		case "literal":
			return lit.int(term.value, types.integer)
		case "placeholder":
			return placeholder()
		case "plus":
			return binary("+", column(term.at), lit.int(1, types.integer))
		case "abs":
			return call("abs", [column(term.at)])
		case "random":
			return qualifiedCall(
				{ kind: "qualified", schema: "pg_catalog", name: "random", volatility: "VOLATILE" },
				[]
			)
		case "series":
			return call("generate_series", [lit.int(1, types.integer), lit.int(2, types.integer)])
	}
}

const aggregateExpr = (
	term: Aggregate,
	column: (at: number) => Expr,
	placeholder: () => Expr
): Expr => {
	switch (term.kind) {
		case "count":
			return countStar()
		case "counted":
			return call("count", [column(term.at)])
		case "literal":
			return lit.int(term.value, types.integer)
		case "placeholder":
			return placeholder()
	}
}

/** setseed(0.5), so every random() a statement after it calls draws the same values, as its twin's do. */
const seeded = sql(
	select(
		provedCore(
			"oneRow",
			[
				target(
					qualifiedCall(
						{ kind: "qualified", schema: "pg_catalog", name: "setseed", volatility: "VOLATILE" },
						[lit.float(0.5, types.double)]
					)
				)
			],
			[],
			undefined
		)
	)
)

/** A statement's answer: its columns' names and its rows as text, in order where it orders them, else sorted. */
interface Answered {
	readonly names: ReadonlyArray<string>
	readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
}

/** Rows by their cells' texts, a NULL before every text. */
const rowOrder: Order.Order<ReadonlyArray<string | null>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<string | null>) =>
		Arr.join(
			Arr.map(row, (cell) => (cell === null ? "\u0000" : `=${cell}`)),
			"\u0001"
		)
)

/** `c` on `admin` after setseed(0.5), one round trip. */
export const answered = (admin: PgConnection, c: FoldCase) =>
	Effect.gen(function* () {
		const answers = yield* admin.exchange([
			{ sql: seeded, params: [] },
			{ sql: c.text, params: c.params }
		])
		const answer = yield* Effect.fromResult(defined(answers[1], "the statement's answer"))
		const rows = Arr.map(answer.rows, (row) =>
			Arr.map(row, (cell) =>
				cell === null ? null : typeof cell === "string" ? cell : Formatter.format(cell)
			)
		)
		const result: Answered = {
			names: Arr.map(answer.fields, (field) => field.name),
			rows: c.ordered ? rows : Arr.sort(rows, rowOrder)
		}
		return result
	})

/** A token as the rule counts it: its kind and its text, a word's upper-cased. */
const keyOf = (token: Token): string => {
	switch (token.kind) {
		case "word":
			return `word ${token.upper}`
		case "param":
			return `param $${token.index}`
		case "dollar":
			return `dollar ${token.tag}`
		case "quotedIdent":
		case "string":
		case "number":
		case "operator":
		case "punct":
			return `${token.kind} ${token.text}`
	}
}

const tokensOf = (text: string): ReadonlyArray<Token> => {
	const lexed = lex(text)
	assert.equal(lexed.error, undefined, text)
	return lexed.tokens
}

const counts = (tokens: ReadonlyArray<Token>): Map<string, number> => {
	const counted = new Map<string, number>()
	for (const token of tokens) {
		const key = keyOf(token)
		counted.set(key, (counted.get(key) ?? 0) + 1)
	}
	return counted
}

/** The names a text calls: each qualified name before a parenthesis, `"schema"."name"(`, as every call prints. */
const calls = (tokens: ReadonlyArray<Token>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(tokens, (token, i) => {
			const before = tokens[i - 1]
			const after = tokens[i + 1]
			return token.kind === "quotedIdent" &&
				before?.kind === "punct" &&
				before.text === "." &&
				after?.kind === "punct" &&
				after.text === "("
				? [token.text]
				: []
		}),
		Order.String
	)

/**
 * A projection's scaffolding, which a fold takes away or, renaming a target its reader reads by name, adds an AS of:
 * SELECT, FROM, AS and DISTINCT, and the punctuation of lists, parentheses and qualified names.
 */
const scaffolding: ReadonlySet<string> = new Set([
	"word SELECT",
	"word FROM",
	"word AS",
	"word DISTINCT",
	"punct (",
	"punct )",
	"punct ,",
	"punct ."
])

/**
 * What the folded text breaks of the fold's rules against its twin's: it adds no token beyond its scaffolding and a copy
 * of a name or a number its twin holds (a column or a literal read twice), its twin's guards set apart, one WHERE TRUE
 * for each core over a derived table (`guards`); it calls exactly what its twin calls; and it holds its twin's
 * placeholders in their order.
 */
export const tokenViolations = (
	folded: string,
	twin: string,
	guards: number
): ReadonlyArray<string> => {
	const a = tokensOf(folded)
	const b = tokensOf(twin)
	const had = counts(b)
	for (const key of ["word WHERE", "word TRUE"]) {
		had.set(key, (had.get(key) ?? 0) - guards)
	}
	const added = Arr.flatMap([...counts(a)], ([key, n]) => {
		const before = had.get(key) ?? 0
		const copy =
			before > 0 && (Str.startsWith("quotedIdent ")(key) || Str.startsWith("number ")(key))
		return n > before && !copy && !scaffolding.has(key) ? [`adds ${key} x${n - before}`] : []
	})
	const called = Arr.join(calls(a), ",")
	const twinCalled = Arr.join(calls(b), ",")
	const params = Arr.join(
		Arr.flatMap(a, (t) => (t.kind === "param" ? [`$${t.index}`] : [])),
		","
	)
	const twinParams = Arr.join(
		Arr.flatMap(b, (t) => (t.kind === "param" ? [`$${t.index}`] : [])),
		","
	)
	return [
		...added,
		...(called === twinCalled ? [] : [`calls ${called} where its twin calls ${twinCalled}`]),
		...(params === twinParams ? [] : [`placeholders ${params} where its twin's are ${twinParams}`])
	]
}

/** The guards a sketch's twin holds: one for each level over another, and one for the reader's core over the top. */
export const guardsOf = (sketch: FoldSketch): number => sketch.levels.length

/** How many SELECTs a text holds: a fold takes one away. */
export const selects = (text: string): number =>
	Arr.filter(tokensOf(text), (t) => t.kind === "word" && t.upper === "SELECT").length

/** The situations a case reached, `folded` saying whether its text folded a projection its twin holds. */
export const reachedOf = (sketch: FoldSketch, folded: boolean): ReadonlyArray<FoldFeature> => {
	const terms = Arr.flatMap(sketch.levels, (level): ReadonlyArray<Term | Aggregate> => level.terms)
	const holds = (kind: (Term | Aggregate)["kind"]) => Arr.some(terms, (t) => t.kind === kind)
	const widths = [3, ...Arr.map(sketch.levels, (level) => level.terms.length)]
	const top = widths[sketch.levels.length] ?? 3
	const picked = Arr.map(sketch.picks, (p) => p % top)
	const twice =
		Arr.dedupe(picked).length < picked.length ||
		Arr.some(sketch.levels, (level, i) => {
			const width = widths[i] ?? 3
			const terms: ReadonlyArray<Term | Aggregate> = level.terms
			const read = Arr.flatMap(terms, (t) => ("at" in t ? [t.at % width] : []))
			return Arr.dedupe(read).length < read.length
		})
	const reached: Array<FoldFeature> = []
	if (sketch.reader === "ordered") {
		reached.push("kept under its query's ORDER BY")
	}
	if (!folded) {
		return reached
	}
	reached.push("a projection folded")
	if (sketch.reader === "statement") {
		reached.push("a fold read by name")
	}
	if (sketch.reader === "ordered through parentheses") {
		reached.push("a fold read by name under an ORDER BY through parentheses")
	}
	if (sketch.reader === "IN" || sketch.reader === "CTE") {
		reached.push("a fold read by place")
	}
	if (holds("placeholder")) {
		reached.push("a placeholder folded")
	}
	if (holds("count") || holds("counted")) {
		reached.push("an aggregate kept")
	}
	if (holds("series")) {
		reached.push("a set-returning call kept")
	}
	if (holds("random")) {
		reached.push("a volatile call kept")
	}
	if (twice) {
		reached.push("a column read twice")
	}
	return reached
}
