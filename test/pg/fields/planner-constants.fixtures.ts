/** What the property of planner-constants.test.ts reads: its term grammar, its schema, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { bool, int4 } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as C } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** Any text, the type of the row's text and of every text term. */
const Wild = str.regex("^.*$", "su")

/** The texts a literal or a row holds: orders by code point unlike by case or by UTF-16 unit, the empty text among them. */
const texts = ["", "a", "b", "B", "Z", "é", "ab"] as const

const comparisons = ["eq", "ne", "lt", "le", "gt", "ge"] as const
type Comparison = (typeof comparisons)[number]

/**
 * A text term: a literal, the row's text, a CASE, GREATEST or LEAST of two, and an ASCII case fold, each a collatable
 * function PostgreSQL's planner evaluates where it folds its operands to constants.
 */
export type Text =
	| { readonly t: "lit"; readonly value: string }
	| { readonly t: "row" }
	| { readonly t: "cond"; readonly p: Pred; readonly a: Text; readonly b: Text }
	| {
			readonly t: "extremum"
			readonly op: "greatest" | "least"
			readonly a: Text
			readonly b: Text
	  }
	| { readonly t: "fold"; readonly a: Text }

/**
 * A predicate: a comparison of two texts; a comparison of the row's integer, or of a literal, with a literal, so a
 * CASE's condition is a constant as often as it reads the row; a comparison of the GREATEST or LEAST of two literals
 * with a literal, a constant no builder decides, so an AND or OR beside it is the planner's to decide; and AND, OR and
 * NOT.
 */
export type Pred =
	| { readonly p: "texts"; readonly op: Comparison; readonly a: Text; readonly b: Text }
	| {
			readonly p: "folded"
			readonly op: Comparison
			readonly of: "greatest" | "least"
			readonly pair: readonly [string, string]
			readonly than: string
	  }
	| {
			readonly p: "integer"
			readonly op: Comparison
			readonly left: "row" | number
			readonly right: number
	  }
	| { readonly p: "and" | "or"; readonly a: Pred; readonly b: Pred }
	| { readonly p: "not"; readonly a: Pred }

/**
 * A text term of at most `depth` levels, weighted to the shapes the planner reduces: a GREATEST or LEAST over a CASE and
 * a literal, a CASE between a literal and the row's text.
 */
const textGen = (depth: number): Gen<Text> => {
	const leaf: Gen<Text> = weighted<Text>([
		[2, (s) => ({ t: "lit", value: s.draw(element(texts)) })],
		[1, () => ({ t: "row" })]
	])
	if (depth === 0) {
		return leaf
	}
	const inner = textGen(depth - 1)
	/**
	 * GREATEST or LEAST of a literal and a CASE whose condition is an AND or OR of a `folded` constant and a comparison
	 * of the row's integer: where the constant decides the connective, the planner reads the CASE as the arm it selects.
	 */
	const decided: Gen<Text> = (s) => ({
		t: "extremum",
		op: s.draw(element(["greatest", "least"] as const)),
		a: {
			t: "cond",
			p: {
				p: s.draw(element(["and", "or"] as const)),
				a: s.draw(foldedGen),
				b: s.draw(integerGen(() => "row"))
			},
			a: s.draw(leaf),
			b: s.draw(leaf)
		},
		b: { t: "lit", value: s.draw(element(texts)) }
	})
	return weighted<Text>([
		[1, leaf],
		[2, decided],
		[3, (s) => ({ t: "cond", p: s.draw(predGen(depth - 1)), a: s.draw(inner), b: s.draw(inner) })],
		[
			3,
			(s) => ({
				t: "extremum",
				op: s.draw(element(["greatest", "least"] as const)),
				a: s.draw(inner),
				b: s.draw(inner)
			})
		],
		[1, (s) => ({ t: "fold", a: s.draw(inner) })]
	])
}

/** A comparison of the GREATEST or LEAST of two literals with a literal: a constant no builder decides. */
const foldedGen: Gen<Pred> = (s) => ({
	p: "folded",
	op: s.draw(element(comparisons)),
	of: s.draw(element(["greatest", "least"] as const)),
	pair: [s.draw(element(texts)), s.draw(element(texts))],
	than: s.draw(element(texts))
})

/** A comparison of the row's integer, or of an integer literal, with a literal. */
const integerGen =
	(left: Gen<"row" | number>): Gen<Pred> =>
	(s) => ({
		p: "integer",
		op: s.draw(element(comparisons)),
		left: s.draw(left),
		right: s.draw(int(0, 2))
	})

const predGen = (depth: number): Gen<Pred> => {
	const leaf: Gen<Pred> = oneOf<Pred>([
		integerGen(oneOf<"row" | number>([() => "row", int(0, 2)])),
		foldedGen
	])
	if (depth === 0) {
		return leaf
	}
	const inner = predGen(depth - 1)
	const terms = textGen(depth - 1)
	return weighted<Pred>([
		[1, leaf],
		[
			1,
			(s) => ({ p: "texts", op: s.draw(element(comparisons)), a: s.draw(terms), b: s.draw(terms) })
		],
		[
			3,
			(s) => ({ p: s.draw(element(["and", "or"] as const)), a: s.draw(inner), b: s.draw(inner) })
		],
		[1, (s) => ({ p: "not", a: s.draw(inner) })]
	])
}

/** A row: its text and its integer. */
interface Row {
	readonly t: string
	readonly n: number
}

/** A case: the generated text term, the generated predicate, and the rows written. */
export interface PlannerCase {
	readonly text: Text
	readonly pred: Pred
	readonly rows: ReadonlyArray<Row>
}

export const plannerCaseGen: Gen<PlannerCase> = (s) => ({
	text: s.draw(textGen(3)),
	pred: s.draw(predGen(3)),
	rows: Array.from({ length: s.draw(int(1, 3)) }, () => ({
		t: s.draw(element(texts)),
		n: s.draw(int(0, 2))
	}))
})

export type PlannerFeature =
	| "a CASE whose condition folds"
	| "a CASE a connective's operand decides, beside a literal in GREATEST or LEAST"
	| "a collatable function of folded operands"

/**
 * The truth of a `folded` leaf, restated: its GREATEST or LEAST of two texts compared with a third, every text of the
 * alphabet in the Basic Multilingual Plane, where JavaScript's order of strings is code point order, pg_c_utf8's.
 */
const foldedHolds = (x: Extract<Pred, { readonly p: "folded" }>): boolean => {
	const [a, b] = x.pair
	const v = x.of === "greatest" ? (a > b ? a : b) : a < b ? a : b
	switch (x.op) {
		case "eq":
			return v === x.than
		case "ne":
			return v !== x.than
		case "lt":
			return v < x.than
		case "le":
			return v <= x.than
		case "gt":
			return v > x.than
		case "ge":
			return v >= x.than
	}
}

/**
 * The arm of a CASE whose condition is an AND or OR that a `folded` operand decides beside an operand that reads the
 * row: the THEN arm where the decided value is true, the ELSE arm where false; none for any other CASE.
 */
const decidedArm = (x: Extract<Text, { readonly t: "cond" }>): Text | undefined => {
	const p = x.p
	if (p.p !== "and" && p.p !== "or") {
		return undefined
	}
	const deciding = p.p === "or"
	const decides = (d: Pred, other: Pred): boolean =>
		d.p === "folded" && foldedHolds(d) === deciding && predReads(other)
	return decides(p.a, p.b) || decides(p.b, p.a) ? (deciding ? x.a : x.b) : undefined
}

/** The row's fields as a term builder reads them. */
interface Fields {
	readonly t: unknown
	readonly n: unknown
}

const textTerm = (f: Fields, x: Text): unknown => {
	switch (x.t) {
		case "lit":
			return C.literal(Wild, x.value)
		case "row":
			return f.t
		case "cond":
			return C.cond(predTerm(f, x.p), textTerm(f, x.a), textTerm(f, x.b))
		case "extremum":
			return C[x.op](textTerm(f, x.a), textTerm(f, x.b))
		case "fold":
			return C.lowerAscii(textTerm(f, x.a))
	}
}

const predTerm = (f: Fields, x: Pred): unknown => {
	switch (x.p) {
		case "texts":
			return C[x.op](textTerm(f, x.a), textTerm(f, x.b))
		case "integer":
			return C[x.op](x.left === "row" ? f.n : C.literal(int4, x.left), C.literal(int4, x.right))
		case "folded":
			return C[x.op](
				C[x.of](C.literal(Wild, x.pair[0]), C.literal(Wild, x.pair[1])),
				C.literal(Wild, x.than)
			)
		case "and":
		case "or":
			return C[x.p]([predTerm(f, x.a), predTerm(f, x.b)])
		case "not":
			return C.not(predTerm(f, x.a))
	}
}

/** Whether a term reads the row's fields, at any depth. */
const textReads = (x: Text): boolean => {
	switch (x.t) {
		case "lit":
			return false
		case "row":
			return true
		case "cond":
			return predReads(x.p) || textReads(x.a) || textReads(x.b)
		case "extremum":
			return textReads(x.a) || textReads(x.b)
		case "fold":
			return textReads(x.a)
	}
}

const predReads = (x: Pred): boolean => {
	switch (x.p) {
		case "texts":
			return textReads(x.a) || textReads(x.b)
		case "integer":
			return x.left === "row"
		case "folded":
			return false
		case "and":
		case "or":
			return predReads(x.a) || predReads(x.b)
		case "not":
			return predReads(x.a)
	}
}

/** The shapes a case's terms reach that the planner reduces: each feature with whether some subterm reaches it. */
const reached = (c: PlannerCase): ReadonlyArray<PlannerFeature> => {
	const found = new Set<PlannerFeature>()
	const text = (x: Text): void => {
		switch (x.t) {
			case "lit":
			case "row":
				return
			case "cond":
				if (!predReads(x.p) && (textReads(x.a) || textReads(x.b))) {
					found.add("a CASE whose condition folds")
				}
				pred(x.p)
				text(x.a)
				text(x.b)
				return
			case "extremum": {
				if (!textReads(x.a) && !textReads(x.b)) {
					found.add("a collatable function of folded operands")
				}
				const beside = (k: Text, other: Text): boolean => {
					const arm = k.t === "cond" ? decidedArm(k) : undefined
					return arm?.t === "lit" && other.t === "lit"
				}
				if (beside(x.a, x.b) || beside(x.b, x.a)) {
					found.add("a CASE a connective's operand decides, beside a literal in GREATEST or LEAST")
				}
				text(x.a)
				text(x.b)
				return
			}
			case "fold":
				text(x.a)
				return
		}
	}
	const pred = (x: Pred): void => {
		switch (x.p) {
			case "texts":
				text(x.a)
				text(x.b)
				return
			case "integer":
			case "folded":
				return
			case "and":
			case "or":
				pred(x.a)
				pred(x.b)
				return
			case "not":
				pred(x.a)
				return
		}
	}
	text(c.text)
	pred(c.pred)
	return [...found]
}

/**
 * One case: R, keyed by its id, writing a text and an integer, with a generated text `g` of the drawn text term and a
 * generated boolean `h`, `CASE WHEN` the drawn predicate `THEN true ELSE false END`, a predicate's term, installed through
 * its first migration; each row written by a direct
 * writer, and PostgreSQL's stored `g` and `h` held to the host's (rowEvaluator). The installation must succeed: every
 * subterm PostgreSQL's planner folds is folded on the host, so no collatable function of constants reaches the planner
 * before PostgreSQL assigns the expression's collations.
 */
export const runPlanner = (drawn: PlannerCase, c: Case<PlannerFeature>) =>
	Effect.gen(function* () {
		for (const feature of reached(drawn)) {
			c.note(feature)
		}
		const R = generatedRelation(
			"R",
			{ id: int4, t: Wild, n: int4 },
			["id"],
			(r) => {
				const fields: Fields = { t: r["t"], n: r["n"] }
				return {
					g: generatedField(Wild, textTerm(fields, drawn.text), []),
					h: generatedField(
						bool,
						C.cond(predTerm(fields, drawn.pred), C.literal(bool, true), C.literal(bool, false)),
						[]
					)
				}
			},
			[]
		)
		const S = schema("Planned", [R], [])
		const evaluate = succeeded(rowEvaluator(S), "the case's schema compiles")
		const installed = yield* installMigrated(S, {
			ambient: ordinarySession,
			label: "planner_constants",
			extensions: []
		})
		const names = namesOf(installed)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "planner writer" })
		const table = names.table(R)
		for (const [id, row] of drawn.rows.entries()) {
			yield* session.query(
				`INSERT INTO ${table} (${names.column(R, "id")}, ${names.column(R, "t")}, ${names.column(R, "n")}) VALUES ($1::integer, $2::text, $3::integer)`,
				[id, row.t, row.n]
			)
			const stored = yield* session.values(
				`SELECT ${names.column(R, "g")}, ${names.column(R, "h")} FROM ${table} WHERE ${names.column(R, "id")} = $1::integer`,
				[id]
			)
			const admitted = succeeded(
				evaluate.admit(R, { id, t: row.t, n: row.n }),
				`the host evaluates row ${Formatter.format(row)} of ${Formatter.format(drawn)}`
			)
			const { g, h } = evaluate(R, admitted).generated
			const at = `at row ${Formatter.format(row)} of ${Formatter.format(drawn)}`
			assert.deepEqual(
				stored,
				[[succeeded(g, `the host evaluates g ${at}`), succeeded(h, `the host evaluates h ${at}`)]],
				`PostgreSQL stores what the host computes for row ${Formatter.format(row)} of ${Formatter.format(drawn)}`
			)
		}
	})
