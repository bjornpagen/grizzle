import { Array as Arr, String as Str } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ColumnRef } from "#compiler/ir/expr.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	Decimal,
	drawn,
	natural,
	pg,
	span
} from "#compiler/public/fields.ts"
import { closed, relation } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as C } from "#compiler/scalar/compute/builders.ts"
import { type SqlValue, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import {
	type Item,
	type ListLiteral,
	type Literal,
	type Pred,
	type Sort,
	type StoredSort,
	type Term,
	narrowBound,
	tenthsText,
	floatOf,
	type Val,
	type World
} from "#test/support/null/language.ts"

/** Any text: the pattern every text of the language lies in. */
const Wild = str.regex("^.*$", "su")

export const kindOf = (code: number): string => `k${code}`
const flagOf = (code: number): string => `f${code}`

/** Handles h(0) … h(n − 1). */
const handlesOf = (n: number, h: (code: number) => string): NonEmptyReadonlyArray<string> => [
	h(0),
	...Arr.makeBy(n - 1, (code) => h(code + 1))
]

/** A numeric(3, 1) of `tenths` tenths. */
export const decimalOf = (tenths: number): Decimal => Decimal.of(tenthsText(tenths))

/** The world's rosters and closed relations, each holding the rows the world draws. */
export const closedOf = (w: World) => {
	const Kind = closed("Kind", handlesOf(w.kinds, kindOf))
	const Flag = closed("Flag", handlesOf(w.flags, flagOf))
	const Pick = closed.relation(
		"Pick",
		{
			kind: closedId(Kind),
			flag: closedId(Flag),
			n: pg.integer,
			d: pg.numeric(3, 1),
			t: Wild,
			b: pg.boolean,
			x: pg["double precision"],
			y: pg.real
		},
		["kind"],
		Arr.flatMap(w.pick, (payload, kind) =>
			payload === undefined
				? []
				: [
						{
							kind: kindOf(kind),
							flag: flagOf(payload.flag),
							n: payload.n,
							d: decimalOf(payload.d),
							t: payload.t,
							b: payload.b,
							x: payload.x,
							y: payload.y
						}
					]
		)
	)
	const Wt = closed.relation(
		"Wt",
		{ flag: closedId(Flag), w: pg.integer },
		["flag"],
		Arr.flatMap(w.weight, (weight, flag) =>
			weight === undefined ? [] : [{ flag: flagOf(flag), w: weight }]
		)
	)
	const Next = closed.relation(
		"Next",
		{ from: closedId(Flag), to: closedId(Flag) },
		["from", "to"],
		Arr.flatMap(w.next, (tos, from) =>
			Arr.map(tos, (to) => ({ from: flagOf(from), to: flagOf(to) }))
		)
	)
	const Allowed = closed.relation(
		"Allowed",
		{ kind: closedId(Kind), flag: closedId(Flag) },
		["kind", "flag"],
		Arr.flatMap(w.allowed, (flags, kind) =>
			Arr.map(flags, (flag) => ({ kind: kindOf(kind), flag: flagOf(flag) }))
		)
	)
	return { Kind, Flag, Pick, Wt, Next, Allowed }
}
export type Closed = ReturnType<typeof closedOf>

/**
 * A closed relation's reads as a JavaScript caller makes them, over terms known only at run time: C.at of a payload
 * field at key terms, and C.row of a key prefix. Each relation's typed reads are these, read by method.
 */
interface ClosedReads {
	at(field: string, ...key: ReadonlyArray<unknown>): unknown
	row(...prefix: ReadonlyArray<unknown>): unknown
}

/** The fields of every open relation's row (language.ts Item), under the world's rosters. */
export const itemFields = (c: Closed) => ({
	id: pg.integer,
	kind: closedId(c.Kind),
	flag: closedId(c.Flag),
	flags: bits(c.Flag),
	n: pg.integer,
	m: pg.integer,
	d: pg.numeric(3, 1),
	t: Wild,
	b: pg.boolean,
	x: pg["double precision"],
	y: pg.real,
	s: span(pg.integer)
})

/** An open relation of the row fields. */
export const itemRelation = <const N extends string>(c: Closed, name: N) =>
	relation(name, itemFields(c), ["id"])

/** The family a fold's step reads: owners counting their members, each member a row with its owner and slot. */
export const foldRelations = (c: Closed) => ({
	Owner: relation(
		"Owner",
		{ id: pg.integer, members: drawn(natural), total: accumulated(pg.integer, 0) },
		["id"]
	),
	Member: relation(
		"Member",
		{
			...itemFields(c),
			owner: pg.integer,
			at: drawn(natural),
			before: accumulated(pg.integer, 0),
			after: accumulated(pg.integer, 0)
		},
		["id"]
	)
})

/** A row as a fact of the row fields, at `id`. */
export const itemFact = (c: Closed, item: Item, id: number) => ({
	id,
	kind: kindOf(item.kind),
	flag: flagOf(item.flag),
	flags: Bits.of(c.Flag, Arr.map(item.flags, flagOf)),
	n: item.n,
	m: item.m,
	d: decimalOf(item.d),
	t: item.t,
	b: item.b,
	x: item.x,
	y: item.y,
	s: { start: item.s[0], end: item.s[1] }
})

/** The field type a generated field of a stored sort declares. */
export const storedField = (c: Closed, sort: StoredSort): FieldBase => {
	switch (sort) {
		case "int":
			return pg.integer
		case "big":
			return pg.bigint
		case "num":
			return pg.numeric(3, 1)
		case "text":
			return Wild
		case "code":
			return closedId(c.Flag)
		case "set":
			return bits(c.Flag)
		case "bool":
			return pg.boolean
		case "f8":
			return pg["double precision"]
		case "f4":
			return pg.real
	}
}

/** A literal as a typed term. */
const literalTerm = (c: Closed, literal: Literal): unknown => {
	switch (literal.sort) {
		case "int":
			return C.literal(pg.integer, literal.value)
		case "big":
			return C.literal(pg.bigint, BigInt(literal.value))
		case "num":
			return C.literal(pg.numeric(3, 1), decimalOf(literal.tenths))
		case "text":
			return C.literal(Wild, literal.value)
		case "code":
			return c.Flag.handle(flagOf(literal.code))
		case "set":
			return C.literal(bits(c.Flag), Bits.of(c.Flag, Arr.map(literal.codes, flagOf)))
		case "bool":
			return C.literal(pg.boolean, literal.value)
		case "f8":
			return C.literal(pg["double precision"], literal.value)
		case "f4":
			return C.literal(pg.real, literal.value)
	}
}

/** A list literal as the JavaScript value an IN list holds. */
const listValue = (literal: ListLiteral): unknown => {
	switch (literal.sort) {
		case "int":
		case "f8":
		case "f4":
			return literal.value
		case "exact":
		case "big":
			return BigInt(literal.value)
		case "num":
			return decimalOf(literal.tenths)
		case "text":
			return literal.value
		case "code":
			return flagOf(literal.code)
	}
}

/** A row as a builder reads its fields: a row check's, a generated field's or a query's variables. */
export type Row = Readonly<Record<string, unknown>>

/** A term built through grizzle's untyped Compute (a JavaScript caller's), over a row. */
export const buildTerm = (c: Closed, row: Row, term: Term): unknown => {
	const b = (t: Term): unknown => buildTerm(c, row, t)
	const pick: ClosedReads = c.Pick
	const weight: ClosedReads = c.Wt
	const next: ClosedReads = c.Next
	switch (term.t) {
		case "field":
			return row[term.field]
		case "lit":
			return literalTerm(c, term.literal)
		case "at":
			return pick.at(term.field, term.key.k === "own" ? row["kind"] : kindOf(term.key.code))
		case "weight":
			return weight.at("w", b(term.flag))
		case "row":
			return next.row(b(term.flag))
		case "arith":
		case "farith":
			return C[term.op](b(term.a), b(term.b))
		case "tofloat":
			return C.cast(b(term.e), pg["double precision"])
		case "unary":
			return C[term.op](b(term.a))
		case "extremum":
			return C[term.op](b(term.a), b(term.b))
		case "cond":
			return C.cond(buildPred(c, row, term.p), b(term.a), b(term.b))
		case "divide": {
			const a = b(term.a)
			return C.when(
				C.nonzero(b(term.d)),
				(x: unknown) => (term.op === "div" ? C.div(a, x) : C.mod(a, x)),
				b(term.o)
			)
		}
		case "narrow":
			return C.when(
				C.within(b(term.e), BigInt(-narrowBound), BigInt(narrowBound)),
				(x: unknown) => C.cast(x, pg.integer),
				b(term.o)
			)
		case "widen":
			return C.cast(b(term.e), pg.bigint)
		case "concat":
			return C.concat(b(term.a), b(term.b))
		case "charLength":
			return C.charLength(b(term.a))
		case "affix":
			return C[term.op](b(term.a), b(term.b))
		case "setop":
			return C[term.op](b(term.a), b(term.b))
		case "card":
			return C.cardinality(b(term.a))
		case "settest":
			return C[term.op](b(term.a), b(term.b))
		case "endpoint":
			return C[term.op](row["s"], pg.integer)
	}
}

/** A predicate built through grizzle's untyped Compute, over a row. */
export const buildPred = (c: Closed, row: Row, pred: Pred): unknown => {
	switch (pred.p) {
		case "cmp":
			return C[pred.op](buildTerm(c, row, pred.a), buildTerm(c, row, pred.b))
		case "between":
			return C.between(
				buildTerm(c, row, pred.a),
				buildTerm(c, row, pred.lo),
				buildTerm(c, row, pred.hi)
			)
		case "in":
			return C.in(buildTerm(c, row, pred.a), Arr.map(pred.values, listValue))
		case "and":
		case "or":
			return C[pred.p](buildPred(c, row, pred.args[0]), buildPred(c, row, pred.args[1]))
		case "not":
			return C.not(buildPred(c, row, pred.arg))
	}
}

/** A row's columns as the host evaluator reads them: each field's carrier value, none the row does not hold. */
export const hostColumns = (item: Item, id: number): ((ref: ColumnRef) => SqlValue | undefined) => {
	const columns = new Map<string, SqlValue>([
		["id", BigInt(id)],
		["kind", kindOf(item.kind)],
		["flag", flagOf(item.flag)],
		["flags", new Set(Arr.map(item.flags, flagOf))],
		["n", BigInt(item.n)],
		["m", BigInt(item.m)],
		["d", decimalOf(item.d)],
		["t", item.t],
		["b", item.b],
		["x", item.x],
		["y", item.y],
		["s", { start: BigInt(item.s[0]), end: BigInt(item.s[1]) }]
	])
	return (ref) => columns.get(ref.name)
}

/** A numeric's tenths from its one text, as Decimal and PostgreSQL write it: [-]digits[.digits], one fraction digit at most. */
const tenthsOf = (text: string): bigint => {
	const negative = Str.startsWith("-")(text)
	const [whole, fraction = ""] = Str.split(".")(negative ? Str.slice(1)(text) : text)
	const tenths = BigInt(whole) * 10n + BigInt(fraction === "" ? "0" : Str.slice(0, 1)(fraction))
	return negative ? -tenths : tenths
}

/** A code from its handle, f<code>. */
const codeOfHandle = (handle: string): number => Number(Str.slice(1)(handle))

/** A set's mask from its handles. */
const maskOfHandles = (handles: Iterable<string>): number =>
	Arr.reduce(Arr.fromIterable(handles), 0, (mask, handle) => mask | (1 << codeOfHandle(handle)))

/** A host value as the model's, by the sort it was evaluated at; NULL as null. */
export const fromHost = (sort: Sort, value: SqlValue): Val | null => {
	if (value === sqlNull) {
		return null
	}
	switch (sort) {
		case "int":
		case "exact":
		case "big":
			return typeof value === "bigint" ? value : undefinedValue(sort, value)
		case "num":
			return value instanceof Decimal ? tenthsOf(value.toString()) : undefinedValue(sort, value)
		case "text":
			return typeof value === "string" ? value : undefinedValue(sort, value)
		case "code":
			return typeof value === "string" ? codeOfHandle(value) : undefinedValue(sort, value)
		case "set":
			return value instanceof Set ? maskOfHandles(value) : undefinedValue(sort, value)
		case "bool":
			return typeof value === "boolean" ? value : undefinedValue(sort, value)
		case "f8":
		case "f4":
			return typeof value === "number" ? floatOf(sort, value) : undefinedValue(sort, value)
	}
}

/** A value of another kind than its sort's, which is itself the disagreement a comparison reports. */
const undefinedValue = (sort: Sort, value: unknown): string =>
	`a value no ${sort} is: ${String(value)}`

/** A value PostgreSQL stored, as its column's text: a code as its number, a set as its bits, padded past the roster. */
export const fromStored = (sort: StoredSort, text: unknown): Val | null => {
	if (typeof text !== "string") {
		return null
	}
	switch (sort) {
		case "int":
		case "big":
			return BigInt(text)
		case "num":
			return tenthsOf(text)
		case "text":
			return text
		case "code":
			return Number(text)
		case "set":
			return Arr.reduce(Arr.fromIterable(text), 0, (mask, bit, code) =>
				bit === "1" ? mask | (1 << code) : mask
			)
		case "bool":
			return text === "true"
		case "f8":
		case "f4":
			return floatOf(sort, Number(text))
	}
}

/** A value a query delivered, as the model's, by its sort: a float's zero is 0, never -0. */
export const fromDelivered = (sort: Sort, value: unknown): Val | null => {
	switch (sort) {
		case "int":
			return typeof value === "number" ? BigInt(value) : undefinedValue(sort, value)
		case "exact":
		case "big":
			return typeof value === "bigint" ? value : undefinedValue(sort, value)
		case "num":
			return value instanceof Decimal ? tenthsOf(value.toString()) : undefinedValue(sort, value)
		case "text":
			return typeof value === "string" ? value : undefinedValue(sort, value)
		case "code":
			return typeof value === "string" ? codeOfHandle(value) : undefinedValue(sort, value)
		case "set":
			return value instanceof Set ? maskOfHandles(value) : undefinedValue(sort, value)
		case "bool":
			return typeof value === "boolean" ? value : undefinedValue(sort, value)
		case "f8":
		case "f4":
			return typeof value === "number" && !Object.is(value, -0)
				? value
				: undefinedValue(sort, value)
	}
}
