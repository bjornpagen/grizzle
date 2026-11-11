/**
 * Every rewrite of a comparison is three-valued exactly as the comparison's plain meaning is, on PostgreSQL 19rc1:
 * NULL where an operand it reads is NULL, as a closed read at an absent key reads.
 *
 * The lowering decides some comparisons by another form: a text's equation with a concatenation, `t = p || q`, by its
 * lengths, a prefix and a suffix, so that nothing allocates (scalar/compute/lower.ts concatEquation); ends_with as
 * `right(a, char_length(b)) = b`; a match whose pattern is a term by a CASE over the pattern's values; and, in a query,
 * an IEEE 754 division by its guarded form, a zero divisor's infinity or NaN chosen by the dividend's sign. PostgreSQL
 * reads BETWEEN as two comparisons and IN as one per value. A form whose conjuncts read different operands, or whose
 * CASE ends in a constant, gives false or a value where the plain meaning is NULL, and NOT then turns it true; a form
 * that sets two operands that read no row side by side in a comparison or a CASE fails a generation expression's
 * installation with 42P22 (upstream/generated-column-collation-before-planning).
 *
 * Each case draws a roster Kind of one to three handles and Pick, a closed relation of a text t and a double f at a
 * drawn subset of the kinds. An operand is the row's own text, Pick.at("t", kind) at the row's kind, Pick.at at a
 * handle written in the term, or a literal, over the letters a and b, which a pattern reads as themselves. The
 * predicates: a concatenation's equation or inequation with an operand, on either side; starts_with and ends_with; a
 * match against a literal, or Pick's text where Pick holds a row; BETWEEN two operands; IN a list of literals; in a query, whether f over the
 * row's double is below zero; under AND, OR and NOT.
 * Positions, each its own relation: a row check, a generated field `Compute.cond(φ, n, m)`, a containment of a
 * selection into a closed relation, a key over a selection, and a query's filter.
 *
 * The oracle is the plain meaning restated over the drawn values: strict operations NULL at a NULL operand, Kleene's
 * AND, OR and NOT, texts ordered by code point, a pattern of letters matching where the text holds it, IEEE 754's
 * division. The schema must install. A lawful row is accepted
 * and an unlawful one refused by its relation's law; a generated value is n exactly where φ is true; the query returns
 * exactly the rows φ is true of.
 *
 * The planted bug, the concatenation's equation as the conjunction of its three parts (~/.cache/grizzle-release/BR09/
 * plants/null-rewrites-concat-equation-conjunction.patch), accepts the downstream case's row in the containment's check
 * and refuses it in the row check's negation.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Predicate, Term } from "#compiler/types/core/phantom.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { type WriteAnswer, answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

const kindOf = (code: number): string => `k${code}`

/** A text over the letters a and b, of up to three: "", "a", "b", "aa", …, by index. */
const textAt = (i: number): string =>
	i === 0 ? "" : `${textAt(Math.floor((i - 1) / 2))}${i % 2 === 1 ? "a" : "b"}`

const textGen: Gen<string> = (s) => textAt(s.draw(int(0, 14)))

type Operand =
	| { readonly kind: "row" }
	| { readonly kind: "pick" }
	| { readonly kind: "pickAt"; readonly handle: number }
	| { readonly kind: "literal"; readonly text: string }

type Pred =
	| {
			readonly kind: "concat"
			readonly ne: boolean
			readonly mirrored: boolean
			readonly head: Operand
			readonly tail: string
			readonly whole: Operand
	  }
	| { readonly kind: "startsWith" | "endsWith"; readonly a: Operand; readonly b: Operand }
	| { readonly kind: "matches"; readonly subject: Operand; readonly pattern: Operand }
	| { readonly kind: "between"; readonly a: Operand; readonly low: Operand; readonly high: Operand }
	| { readonly kind: "in"; readonly a: Operand; readonly values: NonEmptyReadonlyArray<string> }
	| { readonly kind: "negative" }
	| { readonly kind: "and" | "or"; readonly args: readonly [Pred, Pred] }
	| { readonly kind: "not"; readonly arg: Pred }

interface Item {
	readonly kind: number
	readonly t: string
	readonly x: number
	readonly n: number
	readonly m: number
}

interface Picked {
	readonly t: string
	readonly f: number
}

interface RewriteCase {
	readonly kinds: number
	readonly pick: ReadonlyArray<Picked | undefined>
	readonly allowed: ReadonlyArray<boolean>
	readonly checked: Pred
	readonly generated: Pred
	readonly contained: Pred
	readonly keyed: Pred
	readonly queried: Pred
	readonly items: NonEmptyReadonlyArray<Item>
}

/** Doubles from -2 to 2 by halves: zeros, signs and fractions for a division. */
const doubleGen: Gen<number> = (s) => s.draw(int(-4, 4)) / 2

const operandGen = (kinds: number): Gen<Operand> =>
	oneOf<Operand>([
		() => ({ kind: "row" }),
		() => ({ kind: "pick" }),
		(s) => ({ kind: "pickAt", handle: s.draw(int(0, kinds - 1)) }),
		(s) => ({ kind: "literal", text: s.draw(textGen) })
	])

/**
 * A pattern operand, never the row's own text: a literal, or Pick's text at the row's kind or a written handle where
 * Pick holds a row, since a pattern must take a value the schema states when it compiles.
 */
const patternGen = (kinds: number, held: boolean): Gen<Operand> => {
	const literal: Gen<Operand> = (s) => ({ kind: "literal", text: s.draw(textGen) })
	return held
		? oneOf<Operand>([
				() => ({ kind: "pick" }),
				(s) => ({ kind: "pickAt", handle: s.draw(int(0, kinds - 1)) }),
				literal
			])
		: literal
}

/** A predicate of up to `depth` connectives; a pattern reads Pick only where it `held` a row. */
const predGen = (kinds: number, held: boolean, depth: number, inQuery: boolean): Gen<Pred> => {
	const operand = operandGen(kinds)
	const leaves: NonEmptyReadonlyArray<Gen<Pred>> = [
		(s) => ({
			kind: "concat",
			ne: s.draw(boolean),
			mirrored: s.draw(boolean),
			head: s.draw(operand),
			tail: s.draw(textGen),
			whole: s.draw(operand)
		}),
		(s) => ({
			kind: s.draw(element(["startsWith", "endsWith"] as const)),
			a: s.draw(operand),
			b: s.draw(operand)
		}),
		(s) => ({
			kind: "matches",
			subject: s.draw(operand),
			pattern: s.draw(patternGen(kinds, held))
		}),
		(s) => ({ kind: "between", a: s.draw(operand), low: s.draw(operand), high: s.draw(operand) }),
		(s) => ({
			kind: "in",
			a: s.draw(operand),
			values: [s.draw(textGen), ...s.draw(array(textGen, { min: 0, max: 2 }))]
		}),
		...(inQuery ? [(): Pred => ({ kind: "negative" })] : [])
	]
	const leaf = oneOf<Pred>(leaves)
	return depth === 0
		? leaf
		: weighted<Pred>([
				[2, leaf],
				[
					1,
					(s) => ({
						kind: s.draw(element(["and", "or"] as const)),
						args: [
							s.draw(predGen(kinds, held, depth - 1, inQuery)),
							s.draw(predGen(kinds, held, depth - 1, inQuery))
						]
					})
				],
				[2, (s) => ({ kind: "not", arg: s.draw(predGen(kinds, held, depth - 1, inQuery)) })]
			])
}

const caseGen: Gen<RewriteCase> = (s) => {
	const kinds = s.draw(int(1, 3))
	const item: Gen<Item> = (t) => ({
		kind: t.draw(int(0, kinds - 1)),
		t: t.draw(textGen),
		x: t.draw(doubleGen),
		n: t.draw(int(0, 2)),
		m: t.draw(int(0, 2))
	})
	const pick = upTo(kinds, (): Picked | undefined =>
		s.draw(boolean) ? { t: s.draw(textGen), f: s.draw(doubleGen) } : undefined
	)
	const held = Arr.some(pick, (p) => p !== undefined)
	const pred = predGen(kinds, held, 2, false)
	return {
		kinds,
		pick,
		allowed: upTo(kinds, () => s.draw(boolean)),
		checked: s.draw(pred),
		generated: s.draw(pred),
		contained: s.draw(pred),
		keyed: s.draw(pred),
		queried: s.draw(predGen(kinds, held, 2, true)),
		items: [s.draw(item), ...s.draw(array(item, { min: 0, max: 3 }))]
	}
}

type Truth = "true" | "false" | "unknown"

const truthOf = (holds: boolean): Truth => (holds ? "true" : "false")
const not = (t: Truth): Truth => (t === "unknown" ? t : t === "true" ? "false" : "true")
const both = (a: Truth, b: Truth): Truth =>
	a === "false" || b === "false" ? "false" : a === "true" && b === "true" ? "true" : "unknown"
const either = (a: Truth, b: Truth): Truth => not(both(not(a), not(b)))

/** An operand's text over a row, undefined where it is NULL: a read at a kind Pick holds no row at. */
const textOf = (c: RewriteCase, item: Item, o: Operand): string | undefined => {
	switch (o.kind) {
		case "row":
			return item.t
		case "pick":
			return c.pick[item.kind]?.t
		case "pickAt":
			return c.pick[o.handle]?.t
		case "literal":
			return o.text
	}
}

/** Whether a predicate reads Pick at a kind it holds no row at, over a row: what makes a rewrite's operand NULL. */
const readsAbsent = (c: RewriteCase, item: Item, p: Pred): boolean => {
	const absent = (o: Operand): boolean =>
		o.kind !== "literal" && o.kind !== "row" && textOf(c, item, o) === undefined
	switch (p.kind) {
		case "concat":
			return absent(p.head) || absent(p.whole)
		case "startsWith":
		case "endsWith":
			return absent(p.a) || absent(p.b)
		case "matches":
			return absent(p.subject) || absent(p.pattern)
		case "between":
			return absent(p.a) || absent(p.low) || absent(p.high)
		case "in":
			return absent(p.a)
		case "negative":
			return c.pick[item.kind] === undefined
		case "and":
		case "or":
			return readsAbsent(c, item, p.args[0]) || readsAbsent(c, item, p.args[1])
		case "not":
			return readsAbsent(c, item, p.arg)
	}
}

/** A predicate's plain meaning over a row, by SQL's three-valued logic. */
const truth = (c: RewriteCase, item: Item, p: Pred): Truth => {
	switch (p.kind) {
		case "concat": {
			const head = textOf(c, item, p.head)
			const whole = textOf(c, item, p.whole)
			if (head === undefined || whole === undefined) {
				return "unknown"
			}
			const equal = head + p.tail === whole
			return truthOf(p.ne ? !equal : equal)
		}
		case "startsWith":
		case "endsWith": {
			const a = textOf(c, item, p.a)
			const b = textOf(c, item, p.b)
			return a === undefined || b === undefined
				? "unknown"
				: truthOf(p.kind === "startsWith" ? Str.startsWith(b)(a) : Str.endsWith(b)(a))
		}
		case "matches": {
			const subject = textOf(c, item, p.subject)
			const pattern = textOf(c, item, p.pattern)
			return subject === undefined || pattern === undefined
				? "unknown"
				: truthOf(Str.includes(pattern)(subject))
		}
		case "between": {
			const a = textOf(c, item, p.a)
			const order = (x: string | undefined, y: string | undefined): Truth =>
				x === undefined || y === undefined ? "unknown" : truthOf(x <= y)
			return both(order(textOf(c, item, p.low), a), order(a, textOf(c, item, p.high)))
		}
		case "in": {
			const a = textOf(c, item, p.a)
			return a === undefined ? "unknown" : truthOf(p.values.includes(a))
		}
		case "negative": {
			const f = c.pick[item.kind]?.f
			return f === undefined ? "unknown" : truthOf(f / item.x < 0)
		}
		case "and":
			return both(truth(c, item, p.args[0]), truth(c, item, p.args[1]))
		case "or":
			return either(truth(c, item, p.args[0]), truth(c, item, p.args[1]))
		case "not":
			return not(truth(c, item, p.arg))
	}
}

/** A text of up to three characters: a pattern that bounds its bytes, as a match in a query requires. */
const Short = str.regex("^.{0,3}$", "su")

type TextTerm = Term<string, unknown, unknown, "text", unknown>
type DoubleTerm = Term<number, unknown, unknown, "double precision", unknown>

/** The terms a predicate reads of its row, each built where the row's own type is known. */
interface Reads {
	readonly t: TextTerm
	readonly x: DoubleTerm
	readonly pickT: TextTerm
	readonly pickF: DoubleTerm
	readonly pickAt: (handle: number) => TextTerm
}

/** A predicate over a row's reads, in Compute's vocabulary alone, so a check, a selection and a filter share it. */
const predicateOf = (p: Pred, r: Reads): Predicate => {
	const operand = (o: Operand): TextTerm => {
		switch (o.kind) {
			case "row":
				return r.t
			case "pick":
				return r.pickT
			case "pickAt":
				return r.pickAt(o.handle)
			case "literal":
				return Compute.literal(Short, o.text)
		}
	}
	switch (p.kind) {
		case "concat": {
			const cat = Compute.concat(operand(p.head), p.tail)
			const whole = operand(p.whole)
			return p.mirrored
				? p.ne
					? Compute.ne(whole, cat)
					: Compute.eq(whole, cat)
				: p.ne
					? Compute.ne(cat, whole)
					: Compute.eq(cat, whole)
		}
		case "startsWith":
			return Compute.eq(Compute.startsWith(operand(p.a), operand(p.b)), true)
		case "endsWith":
			return Compute.eq(Compute.endsWith(operand(p.a), operand(p.b)), true)
		case "matches":
			return Compute.matches(operand(p.subject), operand(p.pattern))
		case "between":
			return Compute.between(operand(p.a), operand(p.low), operand(p.high))
		case "in":
			return Compute.in(operand(p.a), p.values)
		case "negative":
			return Compute.lt(Compute.div(r.pickF, r.x), 0)
		case "and":
			return Compute.and(predicateOf(p.args[0], r), predicateOf(p.args[1], r))
		case "or":
			return Compute.or(predicateOf(p.args[0], r), predicateOf(p.args[1], r))
		case "not":
			return Compute.not(predicateOf(p.arg, r))
	}
}

/**
 * The case's schema: Kind, Pick and Allowed, and a relation per position; and its full world's workload, an insert into
 * each written relation of the facts each call gives, and the query whose filter is the case's φ.
 */
const schemaOf = (c: RewriteCase) => {
	const Kind = closed("Kind", [kindOf(0), ...upTo(c.kinds - 1, (i) => kindOf(i + 1))])
	const Pick = closed.relation(
		"Pick",
		{ kind: closedId(Kind), t: Short, f: pg.float8 },
		["kind"],
		Arr.flatMap(c.pick, (p, kind) =>
			p === undefined ? [] : [{ kind: kindOf(kind), t: p.t, f: p.f }]
		)
	)
	const Allowed = closed.relation(
		"Allowed",
		{ kind: closedId(Kind) },
		["kind"],
		Arr.flatMap(c.allowed, (held, kind) => (held ? [{ kind: kindOf(kind) }] : []))
	)
	const fields = {
		id: pg.integer,
		kind: closedId(Kind),
		t: Short,
		x: pg.float8,
		n: pg.integer,
		m: pg.integer
	}
	const itemOf = (name: string) => relation(name, fields, ["id"])
	/** A row's reads, built where the row's own type is known: its text and double, and Pick's at its kind. */
	const readsOf = (t: TextTerm, x: DoubleTerm, pickT: TextTerm, pickF: DoubleTerm): Reads => ({
		t,
		x,
		pickT,
		pickF,
		pickAt: (handle) => Pick.at("t", kindOf(handle))
	})
	const Checked = itemOf("Checked")
	const Contained = itemOf("Contained")
	const Keyed = itemOf("Keyed")
	const Queried = itemOf("Queried")
	const GenCond = relation.generated("GenCond", fields, ["id"], (r) => ({
		g: generated(
			pg.integer,
			Compute.cond(
				predicateOf(c.generated, readsOf(r.t, r.x, Pick.at("t", r.kind), Pick.at("f", r.kind))),
				r.n,
				r.m
			)
		)
	}))
	const statements = [
		check("Holds", Checked, (r) =>
			predicateOf(c.checked, readsOf(r.t, r.x, Pick.at("t", r.kind), Pick.at("f", r.kind)))
		),
		contained(
			on(
				select(Contained, (r) =>
					predicateOf(c.contained, readsOf(r.t, r.x, Pick.at("t", r.kind), Pick.at("f", r.kind)))
				),
				"kind"
			),
			on(Allowed, "kind")
		),
		key(
			on(
				select(Keyed, (r) =>
					predicateOf(c.keyed, readsOf(r.t, r.x, Pick.at("t", r.kind), Pick.at("f", r.kind)))
				),
				"n"
			)
		)
	] as const
	const Rewrites = schema(
		"Rewrites",
		[Kind, Pick, Allowed, Checked, Contained, Keyed, Queried, GenCond],
		statements
	)
	const filtered = query(Rewrites).rule((q) => {
		const r = v(Queried, "r")
		return q
			.match(Queried, { id: r.id, kind: r.kind, t: r.t, x: r.x, n: r.n, m: r.m })
			.where(predicateOf(c.queried, readsOf(r.t, r.x, Pick.at("t", r.kind), Pick.at("f", r.kind))))
			.find({ id: r.id })
	})
	return {
		GenCond,
		Rewrites,
		programs: {
			insertChecked: ChangeSet.empty(Rewrites).insert(Checked, []),
			insertGenCond: ChangeSet.empty(Rewrites).insert(GenCond, []),
			insertContained: ChangeSet.empty(Rewrites).insert(Contained, []),
			insertKeyed: ChangeSet.empty(Rewrites).insert(Keyed, []),
			insertQueried: ChangeSet.empty(Rewrites).insert(Queried, []),
			filtered
		}
	}
}

const betweenPair =
	"a generation expression holds a BETWEEN whose operand and one bound are values that read no row, and whose other bound reads the row" as const
const matchPair =
	"a generation expression holds a match of a text that reads the row against a value that reads no row" as const

type Feature =
	| `${"a check" | "a generated field" | "a containment's selection" | "a key's selection" | "a query's filter"} meets a NULL rewrite operand, unknown`
	| "a predicate is true though a rewrite's operand is NULL"
	| "a concatenation's inequation over a NULL operand"
	| "a concatenation's equation the suffix alone would decide false"
	| "a division by a zero divisor over a NULL dividend"
	| typeof betweenPair
	| typeof matchPair

const positions = [
	"a check",
	"a generated field",
	"a containment's selection",
	"a key's selection",
	"a query's filter"
] as const
type Position = (typeof positions)[number]

const situations: NonEmptyReadonlyArray<Feature> = [
	"a concatenation's inequation over a NULL operand",
	"a concatenation's equation the suffix alone would decide false",
	"a division by a zero divisor over a NULL dividend",
	betweenPair,
	matchPair,
	"a predicate is true though a rewrite's operand is NULL",
	...Arr.map(positions, (at): Feature => `${at} meets a NULL rewrite operand, unknown`)
]

/** Every concatenation's equation of a predicate. */
const concatsOf = (p: Pred): ReadonlyArray<Extract<Pred, { readonly kind: "concat" }>> => {
	switch (p.kind) {
		case "concat":
			return [p]
		case "startsWith":
		case "endsWith":
		case "matches":
		case "between":
		case "in":
		case "negative":
			return []
		case "and":
		case "or":
			return [...concatsOf(p.args[0]), ...concatsOf(p.args[1])]
		case "not":
			return concatsOf(p.arg)
	}
}

/** Whether an operand reads no row: Pick.at at a handle written in the term, or a literal. */
const readsNoRow = (o: Operand): boolean => o.kind === "pickAt" || o.kind === "literal"

/** Whether an operand is a value that reads no row: a literal, or Pick.at at a written handle Pick holds a row at. */
const constantValue = (c: RewriteCase, o: Operand): boolean =>
	o.kind === "literal" || (o.kind === "pickAt" && c.pick[o.handle] !== undefined)

/**
 * The forms of a predicate that set two values that read no row side by side in PostgreSQL's reading of a node that
 * reads the row: BETWEEN's comparisons, and a match's CASE over its pattern. Only a generation expression refuses them
 * (42P22): a generated field, and a key's law column over its selection. A NULL among them is no such pair, since
 * PostgreSQL takes a strict comparison of a NULL constant as NULL without calling it.
 */
const constantPairs = (c: RewriteCase, p: Pred): ReadonlyArray<Feature> => {
	switch (p.kind) {
		case "between":
			return constantValue(c, p.a) &&
				((constantValue(c, p.low) && !readsNoRow(p.high)) ||
					(constantValue(c, p.high) && !readsNoRow(p.low)))
				? [betweenPair]
				: []
		case "matches":
			return !readsNoRow(p.subject) && constantValue(c, p.pattern) ? [matchPair] : []
		case "concat":
		case "startsWith":
		case "endsWith":
		case "in":
		case "negative":
			return []
		case "and":
		case "or":
			return [...constantPairs(c, p.args[0]), ...constantPairs(c, p.args[1])]
		case "not":
			return constantPairs(c, p.arg)
	}
}

/** Whether a predicate reads a quotient. */
const readsQuotient = (p: Pred): boolean => {
	switch (p.kind) {
		case "negative":
			return true
		case "concat":
		case "startsWith":
		case "endsWith":
		case "matches":
		case "between":
		case "in":
			return false
		case "and":
		case "or":
			return readsQuotient(p.args[0]) || readsQuotient(p.args[1])
		case "not":
			return readsQuotient(p.arg)
	}
}

const namesLaw = (law: Law, relation: string): boolean => {
	switch (law.kind) {
		case "check":
		case "generated":
			return law.relation === relation
		case "contained":
			return law.from.relation === relation
		case "key":
			return law.side.relation === relation
		case "primaryKey":
		case "coverage":
		case "family":
		case "tree":
		case "above":
		case "fold":
		case "contract":
		case "pattern":
			return false
	}
}

const verdict = (
	applied: Result.Result<WriteAnswer<WriteOutcome<unknown>>, unknown>,
	relation: string,
	lawful: boolean,
	where: string
): void => {
	if (!Result.isSuccess(applied)) {
		return assert.fail(
			`${where}: the write is an outcome, not ${Formatter.format(applied.failure)}`
		)
	}
	const outcome = applied.success
	if (lawful) {
		return assert.equal(outcome.kind, "accepted", `${where} is lawful`)
	}
	if (outcome.kind !== "refused") {
		return assert.fail(`${where} is unlawful, so refused, not ${outcome.kind}`)
	}
	assert.ok(
		Arr.every(refusedLaws(outcome.refused), (law) => namesLaw(law, relation)),
		`${where} is refused by ${relation}'s law, not ${Formatter.format(refusedLaws(outcome.refused))}`
	)
}

/**
 * The case a witness runs, its generated field aimed, by draws of its own, at a BETWEEN of two literals and the row's
 * text beside a match of the row's text against a literal while no witness has put either in a generation expression
 * (Case.steering): half its cases. A rotating or kept case runs as drawn.
 */
const aimed = (c: RewriteCase, notes: Case<Feature>): RewriteCase => {
	if (
		!Option.exists(
			notes.steering,
			(pending) => pending.has(betweenPair) || pending.has(matchPair)
		) ||
		!notes.draw(boolean)
	) {
		return c
	}
	const value: Operand = { kind: "literal", text: notes.draw(textGen) }
	const bound: Operand = { kind: "literal", text: notes.draw(textGen) }
	const row: Operand = { kind: "row" }
	const between: Pred = notes.draw(boolean)
		? { kind: "between", a: value, low: bound, high: row }
		: { kind: "between", a: value, low: row, high: bound }
	const match: Pred = {
		kind: "matches",
		subject: row,
		pattern: { kind: "literal", text: notes.draw(textGen) }
	}
	return { ...c, generated: { kind: "and", args: [between, match] } }
}

const rewriteCase = (drawnCase: RewriteCase, notes: Case<Feature>) =>
	Effect.gen(function* () {
		const c = aimed(drawnCase, notes)
		const built = schemaOf(c)
		const o = yield* installed(
			built.Rewrites,
			{},
			{ label: "rewrites", extensions: [], programs: built.programs }
		)
		const names = namesOf(o.installed)
		const where = (relation: string, id: number) =>
			`${relation} row ${id} of ${Formatter.format(c)}`
		const fact = (item: Item, id: number) => ({
			id,
			kind: kindOf(item.kind),
			t: item.t,
			x: item.x,
			n: item.n,
			m: item.m
		})
		/** Notes what a position met over a row: a NULL operand of a rewrite, and φ's value there. */
		const met = (at: Position, p: Pred, item: Item) => {
			const t = truth(c, item, p)
			if (readsAbsent(c, item, p) && t === "unknown") {
				notes.note(`${at} meets a NULL rewrite operand, unknown`)
			}
			if (readsAbsent(c, item, p) && t === "true") {
				notes.note("a predicate is true though a rewrite's operand is NULL")
			}
			for (const cat of concatsOf(p)) {
				const head = textOf(c, item, cat.head)
				const whole = textOf(c, item, cat.whole)
				if (cat.ne && (head === undefined || whole === undefined)) {
					notes.note("a concatenation's inequation over a NULL operand")
				}
				if (head === undefined && whole !== undefined && !Str.endsWith(cat.tail)(whole)) {
					notes.note("a concatenation's equation the suffix alone would decide false")
				}
			}
			if (at === "a generated field" || at === "a key's selection") {
				for (const pair of constantPairs(c, p)) {
					notes.note(pair)
				}
			}
			if (readsQuotient(p) && c.pick[item.kind] === undefined && item.x === 0) {
				notes.note("a division by a zero divisor over a NULL dividend")
			}
		}
		const result = yield* Effect.gen(function* () {
			const db = yield* Db.open(o.served.login.roles.app, {})
			const conds: Array<string> = []
			const selected: Array<number> = []
			for (const [id, item] of c.items.entries()) {
				const checked = yield* Effect.result(
					answered(
						db.workload.insertChecked.once({
							params: {},
							facts: { insert: { Checked: [fact(item, id)] } }
						})
					)
				)
				verdict(checked, "Checked", truth(c, item, c.checked) === "true", where("Checked", id))
				met("a check", c.checked, item)
				const gen = yield* Effect.result(
					answered(
						db.workload.insertGenCond.once({
							params: {},
							facts: { insert: { GenCond: [fact(item, id)] } }
						})
					)
				)
				verdict(gen, "GenCond", true, where("GenCond", id))
				conds.push(`${id} ${truth(c, item, c.generated) === "true" ? item.n : item.m}`)
				met("a generated field", c.generated, item)
				const inside = c.allowed[item.kind] === true
				const containedRow = yield* Effect.result(
					answered(
						db.workload.insertContained.once({
							params: {},
							facts: { insert: { Contained: [fact(item, id)] } }
						})
					)
				)
				verdict(
					containedRow,
					"Contained",
					truth(c, item, c.contained) !== "true" || inside,
					where("Contained", id)
				)
				met("a containment's selection", c.contained, item)
				const k = truth(c, item, c.keyed)
				const taken = k === "true" && selected.includes(item.n)
				const keyed = yield* Effect.result(
					answered(
						db.workload.insertKeyed.once({
							params: {},
							facts: { insert: { Keyed: [fact(item, id)] } }
						})
					)
				)
				verdict(keyed, "Keyed", !taken, where("Keyed", id))
				if (k === "true" && !taken) {
					selected.push(item.n)
				}
				met("a key's selection", c.keyed, item)
				const queried = yield* Effect.result(
					answered(
						db.workload.insertQueried.once({
							params: {},
							facts: { insert: { Queried: [fact(item, id)] } }
						})
					)
				)
				verdict(queried, "Queried", true, where("Queried", id))
				met("a query's filter", c.queried, item)
			}
			const rows = yield* rowsOf(db.workload.filtered.once({ params: {}, facts: {} }))
			return { conds, ids: Arr.map(rows, (row) => row.id) }
		}).pipe(Effect.scoped, withLayer(o.served.layer))
		assert.deepEqual(
			Arr.sort(result.ids, Order.Number),
			Arr.filterMap(c.items, (item, id) =>
				truth(c, item, c.queried) === "true" ? Result.succeed(id) : Result.failVoid
			),
			`the filter returns exactly the rows its condition is true of: ${Formatter.format(c)}`
		)
		const s = yield* Substrate
		const owner = yield* s.session(ownerSession())
		const stored = yield* owner.values(
			`SELECT ${names.column(built.GenCond, "id")}::text, ${names.column(built.GenCond, "g")}::text FROM ${names.table(built.GenCond)} ORDER BY ${names.column(built.GenCond, "id")}`,
			[]
		)
		const lines: ReadonlyArray<string> = Arr.map(stored, (row) =>
			Arr.join(Arr.map(row, String), " ")
		)
		assert.deepEqual(
			lines,
			result.conds,
			`GenCond stores n where φ is true: ${Formatter.format(c)}`
		)
	}).pipe(Effect.scoped)

layer(Substrate.layer, { excludeTestServices: true })(
	"a comparison's rewrite over a NULL operand",
	(it) => {
		it.effect("is three-valued as its plain meaning is, in every position", (ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/null-rewrites",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "each comparison's plain meaning over the drawn values: strict operations NULL at a NULL operand, Kleene's AND, OR and NOT, and IEEE 754's division and order"
						},
						coverage: required<Feature>(situations, { cases: 64, sense: notesOnly }),
						kept: [
							{
								note: "GEN-NULL: a comparison over a concatenation decided by lengths, a prefix and a suffix: ne(concat(Pick.at(t, own kind), 'b'), t) at a kind Pick holds no row at, with t '', outside Allowed",
								sketch: {
									kinds: 2,
									pick: [{ t: "a", f: 1 }, undefined],
									allowed: [true, false],
									checked: {
										kind: "concat",
										ne: true,
										mirrored: false,
										head: { kind: "pick" },
										tail: "b",
										whole: { kind: "row" }
									},
									generated: {
										kind: "concat",
										ne: true,
										mirrored: false,
										head: { kind: "pick" },
										tail: "b",
										whole: { kind: "row" }
									},
									contained: {
										kind: "concat",
										ne: true,
										mirrored: false,
										head: { kind: "pick" },
										tail: "b",
										whole: { kind: "row" }
									},
									keyed: {
										kind: "concat",
										ne: true,
										mirrored: false,
										head: { kind: "pick" },
										tail: "b",
										whole: { kind: "row" }
									},
									queried: {
										kind: "concat",
										ne: true,
										mirrored: false,
										head: { kind: "pick" },
										tail: "b",
										whole: { kind: "row" }
									},
									items: [{ kind: 1, t: "", x: 0, n: 0, m: 1 }]
								},
								draws: "",
								reaches: [
									"a concatenation's inequation over a NULL operand",
									"a concatenation's equation the suffix alone would decide false",
									"a check meets a NULL rewrite operand, unknown",
									"a containment's selection meets a NULL rewrite operand, unknown"
								]
							},
							{
								note: "TEST_SEED=3553103864, case 0: a generated field's match of the row's text against Pick.at at a written handle installed as CASE 'a' WHEN 'a' THEN …, a CASE over two constants, which PostgreSQL refused with 42P22",
								sketch: {
									kinds: 2,
									pick: [undefined, { t: "a", f: -1.5 }],
									allowed: [true, false],
									checked: {
										kind: "or",
										args: [
											{
												kind: "not",
												arg: {
													kind: "endsWith",
													a: { kind: "pick" },
													b: { kind: "pickAt", handle: 1 }
												}
											},
											{
												kind: "not",
												arg: {
													kind: "matches",
													subject: { kind: "literal", text: "ba" },
													pattern: { kind: "pick" }
												}
											}
										]
									},
									generated: {
										kind: "matches",
										subject: { kind: "row" },
										pattern: { kind: "pickAt", handle: 1 }
									},
									contained: { kind: "endsWith", a: { kind: "row" }, b: { kind: "row" } },
									keyed: {
										kind: "concat",
										ne: false,
										mirrored: false,
										head: { kind: "row" },
										tail: "",
										whole: { kind: "row" }
									},
									queried: {
										kind: "concat",
										ne: false,
										mirrored: false,
										head: { kind: "row" },
										tail: "",
										whole: { kind: "row" }
									},
									items: [{ kind: 0, t: "", x: -1.5, n: 1, m: 1 }]
								},
								draws: "",
								reaches: [
									"a generation expression holds a match of a text that reads the row against a value that reads no row"
								]
							}
						],
						runs: 24,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					rewriteCase
				)
			)
		)
	}
)
