/** What the properties of scalar.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { type Corruption } from "@bjornpagen/testing/lsw"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, float } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, pipe, Record as Rec, String as Str } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { ExprId, NodeId, ParamId } from "#compiler/core/ids.ts"
import { vectorMaxDimensions, MoneyText, VectorText, floatLiteral } from "#compiler/ir/carriers.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import {
	type ExprTable,
	literalProblem,
	type TableExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { admitSpelling } from "#compiler/ir/pattern.ts"
import { baseOf, type Carrier, capsOf, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { compareDecimal, Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { cosineNormMax, cosineNormMin, numericMaxPrecision } from "#compiler/scalar/values/fault.ts"
import { succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { plainType, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"
import { scalarTypes } from "#test/support/unit/ir/fixture.ts"

/** The largest finite 32-bit float. */
export const floatMax = 3.4028234663852886e38

/** A decimal's numeric_out text from its units and scale. */
const decimalText = (units: bigint, scale: number): string => {
	const sign = units < 0n ? "-" : ""
	const abs = pipe((units < 0n ? -units : units).toString(), Str.padStart(scale + 1, "0"))
	return scale === 0
		? `${sign}${abs}`
		: `${sign}${Str.slice(0, -scale)(abs)}.${Str.slice(-scale)(abs)}`
}

/**
 * Every rule of a consistent scalar type a corruption breaks: a corruption names one of these, so a misspelt rule is a
 * compile error.
 */
export type ScalarRule =
	| "text carries its regex metadata"
	| "a code and a set carry their roster"
	| "a span's endpoint is of its carrier"
	| "a numeric typmod has a precision 1-1000 and its scale"
	| "a vector states its dimensions"
	| "a vector has at most 16000 dimensions"
	| "only numeric and vector carry a typmod"
	| "a contract's carrier is its base's"
	| "a set is no contract's base"
	| "a contract's descriptor holds its carrier and the contract alone"
	| "the carrier is one grizzle stores"

/**
 * One rule of a consistent scalar type, broken at every type it applies to: the refusal names where, the type itself.
 */
const breaks = (
	rule: ScalarRule,
	from: "stale" | "wild",
	applies: (t: ScalarType) => boolean,
	broken: (t: ScalarType) => ReadonlyArray<unknown>
): Corruption<ScalarType, string, ScalarRule> => ({
	rule,
	from,
	weight: 1,
	sites: (t) =>
		applies(t)
			? Arr.map(broken(t), (value, i) => ({
					value,
					refusal: "scalar type",
					at: `${t.carrier} ${i}`
				}))
			: []
})

/** A type with its field `key` removed. */
const without = (t: ScalarType, key: string): unknown => {
	const fields: Readonly<Record<string, unknown>> = { ...t }
	return Rec.fromEntries(Arr.filter(Rec.toEntries(fields), ([k]) => k !== key))
}

/** Every rule of a consistent scalar type, broken at each type it applies to. */
export const scalarCorruptions: Arr.NonEmptyReadonlyArray<
	Corruption<ScalarType, string, ScalarRule>
> = [
	breaks(
		"text carries its regex metadata",
		"wild",
		(t) => t.carrier === "text" && t.contract === undefined,
		(t) => [without(t, "text")]
	),
	breaks(
		"a code and a set carry their roster",
		"wild",
		(t) => (t.carrier === "code" || t.carrier === "bits") && t.contract === undefined,
		(t) => [without(t, "roster")]
	),
	breaks(
		"a span's endpoint is of its carrier",
		"stale",
		(t) => (t.carrier === "range4" || t.carrier === "range8") && t.contract === undefined,
		(t) => [
			{
				...t,
				span: { endpoint: { carrier: t.carrier === "range4" ? "int8" : "int4", caps: capsOf(t) } }
			}
		]
	),
	breaks(
		"a numeric typmod has a precision 1-1000 and its scale",
		"wild",
		(t) => t.carrier === "numeric" && t.contract === undefined,
		(t) => [
			{ ...t, typmod: { scale: 2 } },
			{ ...t, typmod: { precision: 5 } },
			{ ...t, typmod: {} },
			{ ...t, typmod: { precision: numericMaxPrecision + 1, scale: 0 } }
		]
	),
	breaks(
		"a vector states its dimensions",
		"wild",
		(t) => t.carrier === "vector" && t.contract === undefined,
		(t) => [without(t, "typmod")]
	),
	breaks(
		"a vector has at most 16000 dimensions",
		"wild",
		(t) => t.carrier === "vector" && t.contract === undefined,
		(t) => [{ ...t, typmod: { dims: vectorMaxDimensions + 1 } }]
	),
	breaks(
		"only numeric and vector carry a typmod",
		"wild",
		(t) =>
			(t.carrier === "int2" ||
				t.carrier === "int4" ||
				t.carrier === "int8" ||
				t.carrier === "bool") &&
			t.contract === undefined,
		(t) => [{ ...t, typmod: { precision: 3 } }]
	),
	breaks(
		"a contract's carrier is its base's",
		"stale",
		(t) => t.contract !== undefined && t.carrier === "int8",
		(t) => [{ ...t, carrier: "int4" }]
	),
	breaks(
		"a set is no contract's base",
		"stale",
		(t) => t.carrier === "bits",
		(t) => [{ carrier: t.carrier, contract: { name: "Picks", base: t, facts: [] } }]
	),
	breaks(
		"a contract's descriptor holds its carrier and the contract alone",
		"stale",
		(t) => t.contract !== undefined,
		(t) => [
			{ ...t, caps: capsOf(t) },
			...numericMembersOf(t),
			...(t.carrier === "code" ? [{ ...t, roster: rosterOf(t) }] : [])
		]
	),
	breaks(
		"the carrier is one grizzle stores",
		"wild",
		(t) => t.carrier === "int8" && t.contract === undefined,
		(t) => Arr.map(["timestamptz", "json", "int8[]", "enum"], (carrier) => ({ ...t, carrier }))
	)
]

/**
 * A contract's descriptor beside the numeric member its base holds, a stale copy the decoder refuses: numeric(p, s)'s
 * typmod, or numeric of no typmod's bound; none for a contract over any other carrier.
 */
function numericMembersOf(t: ScalarType): ReadonlyArray<unknown> {
	const base = baseOf(t)
	if (base.carrier !== "numeric") {
		return []
	}
	return [base.typmod === undefined ? { ...t, bound: base.bound } : { ...t, typmod: base.typmod }]
}

/** The numeric literal of the value `text` spells, display scale or not, at `type`. */
export const at = (text: string, type: ScalarType) =>
	check({ kind: "numeric", value: Decimal.of(text) }, type)

/** The problem a literal has at a type, if any (expr.ts literalProblem). */
export const check = (literal: TypedLiteral, type: ScalarType) => literalProblem(literal, type)

/** numeric(p) is numeric(p, 0). */
export const numeric = (precision: number, scale: number): ScalarType =>
	scalarOf(f.numeric(precision, scale), {})

/**
 * The types a literal is tried at: every carrier, and contracts over a typmod, a roster and a plain base, whose
 * values are their base's.
 */
const types: Arr.NonEmptyReadonlyArray<ScalarType> = [
	plainType("int2"),
	scalarTypes.int4,
	scalarTypes.int8,
	scalarTypes.numeric,
	scalarOf(f.numeric(10, 2), {}),
	plainType("float4"),
	scalarTypes.float8,
	scalarTypes.money,
	scalarTypes.bool,
	scalarTypes.text,
	scalarTypes.uuid,
	plainType("inet"),
	plainType("cidr"),
	scalarTypes.kind,
	scalarOf({ kind: "bits", roster: "Kind" }, { Kind: ["Automatic", "Manual"] }),
	scalarOf(f.span(f.integer, undefined), {}),
	scalarTypes.range8,
	scalarTypes.vector3,
	scalarOf(f.contract("Price", f.numeric(10, 2), undefined), {}),
	scalarOf(f.contract("Pick", f.closedId("Kind"), undefined), { Kind: ["Automatic", "Manual"] }),
	scalarTypes.cents
]

/**
 * The integers around each integer type's bounds: one either side of each power 2^15, 2^31 and 2^63, of either sign.
 */
const powers = Arr.flatMap(
	Arr.flatMap([15n, 31n, 63n], (b) => [2n ** b, -(2n ** b)]),
	(v) => [v - 1n, v, v + 1n]
)

/** A uuid's text: lowercase 8-4-4-4-12 hex, upper-cased, or undashed. */
const uuidGen = map(
	(source) => [source.draw(matching(regex("^[0-9a-f]{32}$"))), source.draw(int(0, 2))] as const,
	([hex, form]) => {
		const dashed = `${Str.slice(0, 8)(hex)}-${Str.slice(8, 12)(hex)}-${Str.slice(12, 16)(hex)}-${Str.slice(16, 20)(hex)}-${Str.slice(20)(hex)}`
		return form === 0 ? dashed : form === 1 ? Str.toUpperCase(dashed) : hex
	}
)

/** A set's handles, from none to a handle twice, out of order or of no roster. */
const handlesGen = map(
	array(element(["Automatic", "Manual", "Gold"]), { min: 0, max: 3 }),
	(handles): TypedLiteral => ({ kind: "handles", handles })
)

/**
 * inet and cidr literals written as inet_out and cidr_out print their values, each its value's one text, which a literal
 * of the type holds; every other spelling the literals property draws (a whole mask stated, a leading zero, an
 * uppercase digit, a host bit right of a cidr's mask, a text that is no address) is no literal of either.
 */
const canonicalInets = ["1.2.3.4", "10.0.0.0/8", "::1", "2001:db8::/32", "::ffff:1.2.3.4"] as const
const canonicalCidrs = ["10.0.0.0/8", "::/0", "1.2.3.4/32", "2001:db8::/32"] as const

/**
 * The literal kinds the literals property draws: every kind but a date and a digest, which no type it tries a literal
 * at holds.
 */
type DrawnKind = Exclude<TypedLiteral["kind"], "date" | "sha256">

/** Each drawn kind's literals: the arms literalGen draws among, and the literals of a case aimed at that kind. */
export const literalArms: { readonly [K in DrawnKind]: Gen<TypedLiteral> } = {
	int: map(
		oneOf([element([0n, ...powers]), bigint(-(2n ** 64n), 2n ** 64n)]),
		(value): TypedLiteral => ({ kind: "int", value })
	),
	float: map(
		oneOf([element([0.5, 0.1, 1e300]), double(-Number.MAX_VALUE, Number.MAX_VALUE)]),
		(value): TypedLiteral => floatLiteral(value)
	),
	floatSpecial: map(element(["NaN", "Infinity", "-Infinity"] as const), (value): TypedLiteral => ({
		kind: "floatSpecial",
		value
	})),
	numeric: (source): TypedLiteral => ({
		kind: "numeric",
		value: Decimal.of(
			decimalText(source.draw(bigint(-(10n ** 12n), 10n ** 12n)), source.draw(int(0, 4)))
		)
	}),
	money: map(bigint(-(2n ** 63n), 2n ** 63n - 1n), (v): TypedLiteral => ({
		kind: "money",
		value: defined(MoneyText.parse(String(v)))
	})),
	bool: map(boolean, (value): TypedLiteral => ({ kind: "bool", value })),
	text: map(
		oneOf([
			element(["a\u0000b", "\ud800", "héllo", "x\udc00y"]),
			string(unicodeScalar, { min: 0, max: 6 })
		]),
		(value): TypedLiteral => ({ kind: "text", value })
	),
	uuid: map(uuidGen, (value): TypedLiteral => ({ kind: "uuid", value })),
	handle: map(element(["Automatic", "Manual", "Gold", "automatic"]), (handle): TypedLiteral => ({
		kind: "handle",
		handle
	})),
	handles: handlesGen,
	span: (source): TypedLiteral => {
		const start = source.draw(oneOf([element(nonEmpty(powers, "the powers")), bigint(-9n, 9n)]))
		return { kind: "span", start, end: start + source.draw(bigint(-9n, 9n)) }
	},
	vector: map(
		weighted([
			[3, array(float(-4, 4), { min: 3, max: 3 })],
			[
				1,
				array(oneOf([element([0, 2 ** -17, 1e9]), float(-floatMax, floatMax)]), {
					min: 1,
					max: 4
				})
			]
		]),
		(xs): TypedLiteral => ({
			kind: "vector",
			value: succeeded(VectorText.of(Float32Array.from(xs)))
		})
	),
	inet: map(
		element([...canonicalInets, "1.2.3.4/32", "010.0.0.0/8", "::0001", "2001:DB8::1", "a.b.c.d"]),
		(value): TypedLiteral => ({ kind: "inet", value })
	),
	cidr: map(
		element([...canonicalCidrs, "10.1.2.3/8", "010.0.0.0/8", "::1/0", "2001:DB8::/32"]),
		(value): TypedLiteral => ({ kind: "cidr", value })
	),
	pattern: map(
		oneOf([
			element(["^a+$", "a|b", "[a-c]*"]),
			string(element(["a", "b", "é"]), { min: 0, max: 3 })
		]),
		(spelling): TypedLiteral => ({ kind: "pattern", value: succeeded(admitSpelling(spelling)) })
	)
}

/** The drawn kinds, in the order literalGen draws them. */
export const drawnKinds: Arr.NonEmptyReadonlyArray<DrawnKind> = [
	"int",
	"float",
	"floatSpecial",
	"numeric",
	"money",
	"bool",
	"text",
	"uuid",
	"handle",
	"handles",
	"span",
	"vector",
	"pattern"
]

/** A literal of any drawn kind. */
const literalGen = oneOf<TypedLiteral>(Arr.map(drawnKinds, (kind) => literalArms[kind]))

/** A literal, and a type it is tried at. */
export type LiteralCase = readonly [TypedLiteral, ScalarType]

/** A literal of any drawn kind at any of the types. */
export const literalCaseGen: Gen<LiteralCase> = (source) =>
	[source.draw(literalGen), source.draw(element(types))] as const

/**
 * The carriers whose types hold a literal of each drawn kind, as admits reads them: a contract's type by its base's
 * carrier.
 */
const carriersOf: { readonly [K in DrawnKind]: Arr.NonEmptyReadonlyArray<Carrier> } = {
	int: ["int2", "int4", "int8"],
	float: ["float4", "float8"],
	floatSpecial: ["float4", "float8"],
	numeric: ["numeric"],
	money: ["money"],
	bool: ["bool"],
	text: ["text"],
	uuid: ["uuid"],
	inet: ["inet"],
	cidr: ["cidr"],
	handle: ["code"],
	handles: ["bits"],
	span: ["range4", "range8"],
	vector: ["vector"],
	pattern: ["text"]
}

/**
 * For each drawn kind, the cases aimed at that kind admitted: a literal of the kind at one of the types whose carrier
 * holds such literals, which most of the kind's literals are a value of.
 */
export const admittedAims: ReadonlyArray<readonly [LiteralFeature, Gen<LiteralCase>]> = Arr.map(
	drawnKinds,
	(kind) => {
		const homes = nonEmpty(
			Arr.filter(types, (t) => Arr.contains(carriersOf[kind], baseOf(t).carrier)),
			`a type holding ${kind} literals`
		)
		return [
			`${kind} admitted`,
			(source): LiteralCase =>
				[source.draw(literalArms[kind]), source.draw(element(homes))] as const
		] as const
	}
)

/** The range of each integer carrier, a span's endpoint carriers among them. */
const ranges: Readonly<Partial<Record<ScalarType["carrier"], readonly [bigint, bigint]>>> = {
	int2: [-(2n ** 15n), 2n ** 15n - 1n],
	int4: [-(2n ** 31n), 2n ** 31n - 1n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n],
	range4: [-(2n ** 31n), 2n ** 31n - 1n],
	range8: [-(2n ** 63n), 2n ** 63n - 1n]
}

/** Whether a value lies in a carrier's range. */
const within = (carrier: ScalarType["carrier"], v: bigint) => {
	const range = ranges[carrier]
	return range !== undefined && v >= range[0] && v <= range[1]
}

/**
 * Whether the literal is a value of the type, by the rules restated: a contract's value is its base's; each literal
 * kind meets its own carriers only; an integer lies in its carrier's range; a float4 is exactly a float32; NaN and
 * the infinities are floats; a numeric literal is one numeric(p, s) stores unchanged; text is well-formed UTF-16
 * without NUL; a uuid is lowercase 8-4-4-4-12 hex; a handle is one of its code's roster's; a set's handles are its
 * roster's, each once, in their declared order, none the empty set; a span has start < end
 * within its endpoint carrier; a vector has the type's dimensions and a norm, summed in double, in the cosine domain
 * [cosineNormMin, cosineNormMax].
 */
export const admits = (literal: TypedLiteral, outer: ScalarType): boolean => {
	const type = baseOf(outer)
	const c = type.carrier
	switch (literal.kind) {
		case "int":
			return (c === "int2" || c === "int4" || c === "int8") && within(c, literal.value)
		case "float":
			return c === "float8" || (c === "float4" && Math.fround(literal.value) === literal.value)
		case "floatSpecial":
			return c === "float4" || c === "float8"
		case "numeric": {
			if (c !== "numeric") {
				return false
			}
			const typmod = type.typmod
			if (typmod === undefined) {
				return true
			}
			const d = Decimal.of(literal.value[canonicalTag]().payload)
			const stored = normalizeNumeric(d, typmod)
			return stored.ok && compareDecimal(stored.value, d) === 0
		}
		case "money":
			return c === "money"
		case "bool":
			return c === "bool"
		case "text":
			return c === "text" && literal.value.isWellFormed() && !Str.includes("\u0000")(literal.value)
		case "sha256":
			return c === "sha256"
		case "uuid":
			return (
				c === "uuid" &&
				regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").test(literal.value)
			)
		case "date":
			return c === "date" && toCalendarDate(literal.value).ok
		case "inet":
			return c === "inet" && Arr.contains<string>(canonicalInets, literal.value)
		case "cidr":
			return c === "cidr" && Arr.contains<string>(canonicalCidrs, literal.value)
		case "handle":
			return c === "code" && type.roster.handles.includes(literal.handle)
		case "handles": {
			if (c !== "bits") {
				return false
			}
			const positions = Arr.map(literal.handles, (h) => type.roster.handles.indexOf(h))
			return Arr.every(positions, (at, i) => at >= 0 && (i === 0 || at > (positions[i - 1] ?? -1)))
		}
		case "span":
			return (
				literal.start < literal.end &&
				within(c, literal.start) &&
				within(c, literal.end) &&
				Str.startsWith("range")(c)
			)
		case "vector": {
			if (c !== "vector") {
				return false
			}
			const xs = [...literal.value.components]
			const norm = Math.sqrt(Arr.reduce(xs, 0, (sum, x) => sum + x * x))
			return xs.length === type.typmod.dims && norm >= cosineNormMin && norm <= cosineNormMax
		}
		case "pattern":
			return (
				c === "text" &&
				literal.value.spelling.isWellFormed() &&
				!Str.includes("\u0000")(literal.value.spelling)
			)
	}
}

/** What a literal at a type reached: each kind admitted and refused, and a type under a contract. */
export type LiteralFeature =
	| `${TypedLiteral["kind"]} ${"admitted" | "refused"}`
	| "under a contract"

/** What a value at numeric(p, s) reached. */
export type TypmodFeature =
	| "an infinity refused"
	| "NaN admitted"
	| "a negative scale"
	| "a scale above the precision"
	| "an overflow refused"
	| "a rounding refused"
	| "a value admitted"

/**
 * The fields every predicate expression shares, each defaulted; a kind's own fields, its arguments and its
 * non-null proof among them, are given.
 */
type Shared = "id" | "volatility" | "deps"

/** A predicate expression's own fields, the shared ones defaulted but its id. */
type PredicateFields = TableExpr extends infer E
	? E extends TableExpr
		? Omit<E, Shared> & Partial<Pick<E, Exclude<Shared, "id">>>
		: never
	: never

/** A predicate expression, its shared fields defaulted. */
const predicateExpr = (id: ExprId, fields: PredicateFields): TableExpr => ({
	id,
	volatility: "immutable",
	deps: { params: [], nodes: [] },
	...fields
})

/** The same predicate under arbitrary allocated ids. */
export const allocated = (ids: readonly [string, string, string]): ExprTable => {
	const [root, value, zero] = [ExprId(ids[0]), ExprId(ids[1]), ExprId(ids[2])]
	return {
		root,
		exprs: {
			[root]: predicateExpr(root, {
				kind: "op",
				op: definedOpOf("int8ge"),
				args: [value, zero],
				type: scalarTypes.bool,
				nonNull: "strict"
			}),
			[value]: predicateExpr(value, {
				kind: "value",
				type: scalarTypes.int8,
				args: [],
				nonNull: "storage"
			}),
			[zero]: predicateExpr(zero, {
				kind: "literal",
				value: { kind: "int", value: 0n },
				type: scalarTypes.int8,
				args: [],
				nonNull: "literal"
			})
		}
	}
}

/** VALUE >= 0 over int8, in normal form. */
export const nonNegative: ExprTable = allocated(["e#0", "e#1", "e#2"])

/** A contract over int8, Cents, whose predicate is the table. */
export const contractOver = (predicate: ExprTable): unknown => ({
	carrier: "int8",
	contract: { name: "Cents", base: scalarTypes.int8, predicate, facts: [] }
})

/** VALUE >= 0 with its entry `key` patched. */
const edited = (key: string, patch: (expr: TableExpr) => TableExpr): ExprTable => ({
	...nonNegative,
	exprs: { ...nonNegative.exprs, [key]: patch(defined(nonNegative.exprs[ExprId(key)])) }
})

/** `table` without its entry `key`, so an argument naming it dangles and no entry is left unreachable. */
const withoutEntry = (table: ExprTable, key: string): ExprTable => ({
	root: table.root,
	exprs: Rec.remove(table.exprs, ExprId(key))
})

/**
 * The rules of a contract predicate (expr.ts predicateProblems), each broken once on VALUE >= 0, and no other rule
 * with it (a dangling argument leaves no entry unreachable): the table is in normal form, so its canonical text cannot
 * depend on allocation; its root and every argument resolve, every entry is reachable and none is its own argument;
 * it reads only VALUE, of the base type, and literals, with no column, no parameter and no dependency; it is
 * immutable and boolean, and no domain cast lies in it; its literals fit the base. A contract decoded with a broken
 * predicate is MalformedDescription.
 */
export const broken: Arr.NonEmptyReadonlyArray<readonly [string, ExprTable]> = [
	["not in normal form", allocated(["e3", "e1", "e2"])],
	["a missing root", { root: ExprId("missing"), exprs: {} }],
	[
		"a dangling argument",
		withoutEntry(
			edited("e#0", (e) => (e.kind === "op" ? { ...e, args: [ExprId("e#1"), ExprId("e#9")] } : e)),
			"e#2"
		)
	],
	[
		"an unreachable entry",
		{
			...nonNegative,
			exprs: {
				...nonNegative.exprs,
				[ExprId("e#3")]: { ...defined(nonNegative.exprs[ExprId("e#1")]), id: ExprId("e#3") }
			}
		}
	],
	[
		"a cycle",
		edited("e#2", (e) => ({
			...e,
			kind: "op",
			op: definedOpOf("int8pl"),
			args: [ExprId("e#0")],
			nonNull: "strict"
		}))
	],
	[
		"a column",
		edited("e#1", (e) => ({
			...e,
			kind: "column",
			column: { node: NodeId("n1"), name: "x" },
			args: [],
			nonNull: "storage"
		}))
	],
	[
		"a parameter",
		edited("e#1", (e) => ({
			...e,
			kind: "param",
			param: ParamId("p"),
			role: "compare",
			args: [],
			nonNull: "codec"
		}))
	],
	["a dependency", edited("e#1", (e) => ({ ...e, deps: { params: [ParamId("p")], nodes: [] } }))],
	["VALUE of another type", edited("e#1", (e) => ({ ...e, type: scalarTypes.int4 }))],
	["a stable root", edited("e#0", (e) => ({ ...e, volatility: "stable" }))],
	["a root that is no boolean", edited("e#0", (e) => ({ ...e, type: scalarTypes.int8 }))],
	[
		"a domain cast",
		edited("e#1", (e) => ({
			...e,
			kind: "domainCast",
			args: [ExprId("e#2")],
			nonNull: "strict",
			proof: [
				{
					precondition: { kind: "contract" },
					premises: [{ kind: "checked", operand: 0, by: "literal" }]
				}
			]
		}))
	],
	[
		"a literal outside the base",
		edited("e#2", (e) => ({ ...e, value: { kind: "int", value: 1n << 70n } }))
	]
]

/** Every spelling of the three entries from a pool of identifiers. */
const pool = ["e1", "e2", "e3", "e12", "e77", "e90"] as const

/** Three distinct identifiers of the pool, as a predicate's root, value and zero. */
export const spellings: Gen<readonly [string, string, string]> = map(
	shuffled(pool, { min: 3, max: 3 }),
	(ids) =>
		[
			defined(ids[0], "a root's spelling"),
			defined(ids[1], "a value's spelling"),
			defined(ids[2], "a zero's spelling")
		] as const
)

/** What a predicate case reached: each broken rule, or an allocation normalized. */
export type PredicateFeature = `broken: ${string}` | "an allocation normalized"

/** A predicate case: an allocation of VALUE >= 0's entries, or the predicate broken at one rule. */
export type PredicateCase =
	| { readonly kind: "allocated"; readonly ids: readonly [string, string, string] }
	| { readonly kind: "broken"; readonly rule: string; readonly table: ExprTable }

/** A decimal's numeric_out text: up to 10^12 units, at a display scale of 0 to 8. */
export const decimal = (source: Source) =>
	decimalText(source.draw(bigint(-(10n ** 12n), 10n ** 12n)), source.draw(int(0, 8)))

/** A value and a typmod numeric(p, s), each of p 1 to 14 and s -4 to 16. */
export type TypmodCase = readonly [string, number, number]

/**
 * A typmod and the least value, of either sign, it cannot store: 10^(p - s), exactly 10^p units at its scale, one past
 * the largest it stores.
 */
export const typmodBoundary: Gen<TypmodCase> = (source) => {
	const precision = source.draw(int(1, 14))
	const scale = source.draw(int(-4, 16))
	const units = 10n ** BigInt(scale >= 0 ? precision : precision - scale)
	return [
		decimalText(source.draw(boolean) ? -units : units, Math.max(scale, 0)),
		precision,
		scale
	] as const
}

/** The special values numeric holds: NaN and the infinities. */
export const special = element(["NaN", "Infinity", "-Infinity"])

/**
 * The texts the decimal payload grammar is tried on: numeric_out's text of a drawn value; that text with a trailing
 * fractional zero, which numeric_out writes at a scale but the IR's payload never holds; the edge cases of the
 * grammar; and printable text.
 */
export const texts = oneOf([
	(source: Source) =>
		decimalText(source.draw(bigint(-(10n ** 20n), 10n ** 20n)), source.draw(int(0, 6))),
	(source: Source) =>
		decimalText(source.draw(bigint(-(10n ** 19n), 10n ** 19n)) * 10n, source.draw(int(1, 6))),
	element([
		"NaN",
		"Infinity",
		"-Infinity",
		"0.0145",
		"-0.0015",
		"",
		"-",
		".",
		"+1",
		"1e",
		"1.2.3",
		" 1",
		"nan",
		"1_000",
		"0x10",
		"123.",
		".5",
		"1e10",
		"1.5E-3",
		"007",
		"-0",
		"-0.00",
		"+Infinity"
	]),
	string(codePoint(0x20, 0x7e), { min: 0, max: 12 })
])
