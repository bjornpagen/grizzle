/**
 * What the property of typing.test.ts reads: a space of descriptions over a heading of every carrier the scalar
 * catalogue reads, and each emitted expression's computation written out.
 *
 * A description is drawn as a sketch of plain numbers resolved against the heading (resolve): each choice reduced
 * modulo what there is to choose from, so every sketch resolves and shrinking keeps it valid. Its operations are the
 * catalogue's own (ir/desc.ts computeFns and compareOps), its operands the heading's columns, parameters of their
 * types, bare literals of every kind a literal has and typed literals of the columns' descriptors, so most terms meet
 * an operand of another type and are refused, and the rest are typed. A computeCore.when's guard is drawn with a subject it
 * guards, a number for a fact guard and computeCore.within, a text for a match and a text's byte count for a byte guard,
 * and its branch reads the guard's parameter, and, under a byte guard, the text it counts.
 */

import { replaceMap } from "@bjornpagen/grizzle-text/text"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import {
	compareOps,
	type ComputeFn,
	computeFns,
	type ExprDesc,
	type GuardDesc,
	guardedExpr,
	type LiteralDesc,
	type Spelled
} from "#compiler/ir/desc.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { textOf } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { computeSpecs } from "#compiler/scalar/compute/registry.ts"
import type { TapeEntry, TermTyping, TypedNode } from "#compiler/scalar/compute/typing.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import {
	field,
	type LeafBinding,
	testContract,
	type TestField,
	testPg,
	testSpan
} from "#test/unit/compute/support.ts"

/** The heading's columns, of every carrier the catalogue reads, by name. */
const fields: Readonly<Record<string, TestField>> = {
	s: testPg.smallint,
	i: testPg.integer,
	b: testPg.bigint,
	n: testPg.numericOf(10, 2),
	r: testPg.real,
	d: testPg.double,
	m: testPg.money,
	f: testPg.boolean,
	t: testPg.text,
	w: testPg.regex("^[a-z]{1,8}$", "u"),
	digits: testPg.regex("^[0-9]{1,6}$", "u"),
	u: testPg.uuid,
	day: field({ kind: "pg", type: "date" }, "date"),
	cents: testContract("Cents", testPg.bigint, (x) => computeCore.ge(x, 0n)),
	mood: field({ kind: "closedId", roster: "Mood", only: undefined }, "code"),
	zone: testPg.zone,
	moods: field({ kind: "bits", roster: "Mood" }, "bits"),
	span: testSpan(testPg.integer),
	bin: field({ kind: "bytes" }, "bytea"),
	addr: testPg.inet,
	block: testPg.cidr
}

const names = nonEmpty(Rec.keys(fields), "the heading's columns")

/** A column of the heading by name. */
const fieldOf = (name: string): TestField => defined(fields[name], `the heading's column ${name}`)

/** Every column of the heading, bound as a column of node n0. */
export const vars: Readonly<Record<string, LeafBinding>> = Rec.map(fields, (f) => ({
	kind: "column",
	type: f.scalar
}))

/**
 * The families of value a description's operand is drawn at: a number of each carrier family, a text, a boolean, a set
 * over a roster, a closed id, a span, bytes and the rest, each the columns of the heading of its family.
 */
type Family =
	| "integer"
	| "numeric"
	| "float"
	| "money"
	| "text"
	| "bool"
	| "bits"
	| "code"
	| "span"
	| "bytes"
	| "net"
	| "other"

/** The heading's columns of each family. */
const familyOf = (name: string): Family => {
	switch (fieldOf(name).scalar.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return "integer"
		case "numeric":
			return "numeric"
		case "float4":
		case "float8":
			return "float"
		case "money":
		case "exactMoney":
			return "money"
		case "text":
			return "text"
		case "bool":
			return "bool"
		case "bits":
			return "bits"
		case "code":
			return "code"
		case "range4":
		case "range8":
		case "rangeDate":
			return "span"
		case "bytes":
			return "bytes"
		case "sha256":
		case "inet":
		case "cidr":
			return "net"
		case "variant":
		case "uuid":
		case "date":
		case "vector":
		case "tsvector":
			return "other"
	}
}

/** The families a description is drawn at, its root's among them. */
const families: Arr.NonEmptyReadonlyArray<Family> = [
	"integer",
	"numeric",
	"float",
	"money",
	"text",
	"bool",
	"bits",
	"code",
	"span",
	"bytes",
	"net",
	"other"
]

/** The number families, which arithmetic reads. */
const numberFamilies: Arr.NonEmptyReadonlyArray<Family> = ["integer", "numeric", "float", "money"]

/** The heading's columns of `family`, or every column where it has none of it. */
const columnsOf = (family: Family): Arr.NonEmptyReadonlyArray<string> =>
	Arr.match(
		Arr.filter(names, (name) => familyOf(name) === family),
		{ onEmpty: () => names, onNonEmpty: (columns) => columns }
	)

/**
 * What each scalar function reads and gives, as a family: `same` is the family the call is drawn at, which arithmetic
 * reads and gives; a function's other operands are drawn at the families it reads, in order.
 */
type Signature = { readonly result: Family | "same"; readonly args: ReadonlyArray<Family | "same"> }

const signatures: { readonly [F in ComputeFn]: Signature } = {
	add: { result: "same", args: ["same", "same"] },
	sub: { result: "same", args: ["same", "same"] },
	mul: { result: "same", args: ["same", "same"] },
	div: { result: "same", args: ["same", "same"] },
	mod: { result: "same", args: ["same", "same"] },
	neg: { result: "same", args: ["same"] },
	quot: { result: "numeric", args: ["numeric", "numeric"] },
	rem: { result: "numeric", args: ["numeric", "numeric"] },
	abs: { result: "same", args: ["same"] },
	sign: { result: "same", args: ["same"] },
	round: { result: "numeric", args: ["numeric"] },
	trunc: { result: "numeric", args: ["numeric"] },
	ceil: { result: "numeric", args: ["numeric"] },
	floor: { result: "numeric", args: ["numeric"] },
	gcd: { result: "same", args: ["same", "same"] },
	lcm: { result: "same", args: ["same", "same"] },
	power: { result: "same", args: ["same", "same"] },
	sqrt: { result: "same", args: ["same"] },
	least: { result: "same", args: ["same", "same"] },
	greatest: { result: "same", args: ["same", "same"] },
	widthBucket: { result: "integer", args: ["numeric", "numeric", "numeric", "integer"] },
	minScale: { result: "integer", args: ["numeric"] },
	numeric: { result: "numeric", args: ["integer"] },
	lower: { result: "integer", args: ["span"] },
	upper: { result: "integer", args: ["span"] },
	width: { result: "integer", args: ["span"] },
	charLength: { result: "integer", args: ["text"] },
	octetLength: { result: "integer", args: ["text"] },
	utf16Length: { result: "integer", args: ["text"] },
	concat: { result: "text", args: ["text", "text"] },
	startsWith: { result: "bool", args: ["text", "text"] },
	endsWith: { result: "bool", args: ["text", "text"] },
	contains: { result: "bool", args: ["text", "text"] },
	matches: { result: "bool", args: ["text", "text"] },
	translate: { result: "text", args: ["text"] },
	lowerAscii: { result: "text", args: ["text"] },
	resolveReference: { result: "text", args: ["text", "text"] },
	cutBefore: { result: "text", args: ["text", "text"] },
	cutFrom: { result: "text", args: ["text", "text"] },
	replace: { result: "text", args: ["text", "text", "text"] },
	isXsdPattern: { result: "bool", args: ["text"] },
	collapse: { result: "text", args: ["text"] },
	parseDouble: { result: "float", args: ["text"] },
	parseDecimal: { result: "numeric", args: ["text"] },
	sha256: { result: "other", args: ["bytes"] },
	floatBits: { result: "integer", args: ["float"] },
	cosineDistance: { result: "float", args: ["other", "other"] },
	textDocument: { result: "other", args: ["text"] },
	websearchMatches: { result: "bool", args: ["other", "text"] },
	plainMatches: { result: "bool", args: ["other", "text"] },
	websearchRank: { result: "float", args: ["other", "text"] },
	plainRank: { result: "float", args: ["other", "text"] },
	websearchRankCd: { result: "float", args: ["other", "text"] },
	plainRankCd: { result: "float", args: ["other", "text"] },
	union: { result: "bits", args: ["bits", "bits"] },
	intersection: { result: "bits", args: ["bits", "bits"] },
	difference: { result: "bits", args: ["bits", "bits"] },
	cardinality: { result: "integer", args: ["bits"] },
	subset: { result: "bool", args: ["bits", "bits"] },
	disjoint: { result: "bool", args: ["bits", "bits"] },
	singleton: { result: "bits", args: ["code"] },
	netWithin: { result: "bool", args: ["net", "net"] },
	netStrictlyWithin: { result: "bool", args: ["net", "net"] },
	netOverlaps: { result: "bool", args: ["net", "net"] },
	wall: { result: "integer", args: ["integer", "code"] },
	epochDay: { result: "integer", args: ["other"] },
	dateOfEpochDay: { result: "other", args: ["integer"] }
}

/** The functions whose result is of `family`: arithmetic's at a number family, every other at its own. */
const functionsOf = (family: Family): ReadonlyArray<ComputeFn> =>
	Arr.filter(computeFns, (fn) => {
		const result = signatures[fn].result
		return result === "same" ? Arr.contains(numberFamilies, family) : result === family
	})

/**
 * A description's sketch: each choice a number, resolved against the heading at a family (resolveAt). A `leaf` is a
 * column of its family, or under a computeCore.when the guard's parameter or the text a byte guard counts; a `wild` leaf a
 * column of any family, so an operation meets an operand of another type.
 */
type Sketch =
	| { readonly tag: "leaf"; readonly pick: number }
	| { readonly tag: "wild"; readonly pick: number }
	| { readonly tag: "param"; readonly pick: number }
	| { readonly tag: "bare"; readonly value: number }
	| { readonly tag: "typed"; readonly pick: number; readonly value: number }
	| {
			readonly tag: "compute"
			readonly fn: number
			readonly scale: number
			readonly args: ReadonlyArray<Sketch>
	  }
	| { readonly tag: "compare"; readonly op: number; readonly left: Sketch; readonly right: Sketch }
	| { readonly tag: "between"; readonly arg: Sketch; readonly low: Sketch; readonly high: Sketch }
	| { readonly tag: "in"; readonly arg: Sketch; readonly values: ReadonlyArray<number> }
	| { readonly tag: "connective"; readonly or: boolean; readonly args: ReadonlyArray<Sketch> }
	| { readonly tag: "not"; readonly arg: Sketch }
	| { readonly tag: "cast"; readonly to: number; readonly from: number; readonly arg: Sketch }
	| { readonly tag: "base"; readonly arg: Sketch }
	| {
			readonly tag: "cond"
			readonly pred: Sketch
			readonly onTrue: Sketch
			readonly onFalse: Sketch
	  }
	| {
			readonly tag: "when"
			readonly guard: number
			readonly subject: number
			readonly low: number
			readonly high: number
			readonly proved: Sketch
			readonly otherwise: Sketch
	  }

const leafGen: Gen<Sketch> = weighted<Sketch>([
	[12, (source) => ({ tag: "leaf", pick: source.draw(int(0, 31)) })],
	[1, (source) => ({ tag: "wild", pick: source.draw(int(0, 31)) })],
	[2, (source) => ({ tag: "param", pick: source.draw(int(0, 31)) })],
	[4, (source) => ({ tag: "bare", value: source.draw(int(-3, 12)) })],
	[
		1,
		(source) => ({ tag: "typed", pick: source.draw(int(0, 31)), value: source.draw(int(-3, 12)) })
	]
])

/** Sketches of at most `depth` operations below the root. */
const sketchGen = (depth: number): Gen<Sketch> => {
	if (depth <= 0) {
		return leafGen
	}
	const sub = sketchGen(depth - 1)
	const args =
		(lo: number, hi: number): Gen<ReadonlyArray<Sketch>> =>
		(source) =>
			Array.from({ length: source.draw(int(lo, hi)) }, () => source.draw(sub))
	return weighted<Sketch>([
		[3, leafGen],
		[
			8,
			(source) => ({
				tag: "compute",
				fn: source.draw(int(0, 63)),
				scale: source.draw(int(-1, 3)),
				args: source.draw(args(1, 4))
			})
		],
		[
			2,
			(source) => ({
				tag: "compare",
				op: source.draw(int(0, compareOps.length - 1)),
				left: source.draw(sub),
				right: source.draw(sub)
			})
		],
		[
			1,
			(source) => ({
				tag: "between",
				arg: source.draw(sub),
				low: source.draw(sub),
				high: source.draw(sub)
			})
		],
		[
			1,
			(source) => ({
				tag: "in",
				arg: source.draw(sub),
				values: Array.from({ length: source.draw(int(1, 3)) }, () => source.draw(int(-3, 12)))
			})
		],
		[
			1,
			(source) => ({ tag: "connective", or: source.draw(boolean), args: source.draw(args(1, 3)) })
		],
		[1, (source) => ({ tag: "not", arg: source.draw(sub) })],
		[
			2,
			(source) => ({
				tag: "cast",
				to: source.draw(int(0, 31)),
				from: source.draw(int(0, 15)),
				arg: source.draw(sub)
			})
		],
		[1, (source) => ({ tag: "base", arg: source.draw(sub) })],
		[
			2,
			(source) => ({
				tag: "cond",
				pred: source.draw(sub),
				onTrue: source.draw(sub),
				onFalse: source.draw(sub)
			})
		],
		[
			4,
			(source) => ({
				tag: "when",
				guard: source.draw(int(0, 6)),
				subject: source.draw(int(0, 31)),
				low: source.draw(int(-2, 4)),
				high: source.draw(int(0, 12)),
				proved: source.draw(sub),
				otherwise: source.draw(sub)
			})
		]
	])
}

/** The item `pick` names, modulo the items there are. */
const pickOf = <A>(items: Arr.NonEmptyReadonlyArray<A>, pick: number): A =>
	defined(
		items[((pick % items.length) + items.length) % items.length],
		"an item of a nonempty list"
	)

/** A bare literal of `family`: an integer or a bigint, a Decimal, a Money, a boolean, a string; else an integer. */
const bareValue = (family: Family, value: number): LiteralDesc => {
	switch (family) {
		case "integer":
			return value % 2 === 0 ? value : BigInt(value)
		case "numeric":
		case "float":
			return Decimal.of(`${value}.5`)
		case "money":
			return Money.of(BigInt(value * 100 + 25))
		case "bool":
			return value % 2 === 0
		case "text":
			return Str.slice(0, ((value % 4) + 4) % 4)("abc")
		case "net":
			return `10.${((value % 256) + 256) % 256}.0.0/16`
		case "bits":
		case "code":
		case "span":
		case "bytes":
		case "other":
			return value
	}
}

/**
 * The leaves a sketch's leaf resolves to where it stands: the heading's columns, and under a computeCore.when its
 * parameter and, under a byte guard, the text it counts, each at its family.
 */
type Leaves = ReadonlyArray<{ readonly desc: ExprDesc; readonly family: Family }>

const headingLeaves: Leaves = Arr.map(names, (name) => ({
	desc: { kind: "var", var: name },
	family: familyOf(name)
}))

/** The leaves of `family`, the scope's own first, or the heading's columns of it where none is. */
const leavesOf = (leaves: Leaves, family: Family): Arr.NonEmptyReadonlyArray<ExprDesc> =>
	Arr.match(
		Arr.flatMap(leaves, (l): ReadonlyArray<ExprDesc> => (l.family === family ? [l.desc] : [])),
		{
			onEmpty: () => Arr.map(columnsOf(family), (name): ExprDesc => ({ kind: "var", var: name })),
			onNonEmpty: (found) => found
		}
	)

/** The guard of a when's sketch, over the subject it guards, and the leaves its branch reads besides the heading's. */
const guardOf = (
	s: Extract<Sketch, { readonly tag: "when" }>
): { readonly guard: GuardDesc; readonly subject: ExprDesc; readonly reads: Leaves } => {
	const numberName = pickOf(
		nonEmpty(Arr.flatMap(numberFamilies, columnsOf), "number columns"),
		s.subject
	)
	const number: ExprDesc = { kind: "var", var: numberName }
	const textName = pickOf(columnsOf("text"), s.subject)
	const text: ExprDesc = { kind: "var", var: textName }
	const guarded = (guard: GuardDesc, subject: ExprDesc, family: Family) => ({
		guard,
		subject,
		reads: [{ desc: guardedExpr(guard, subject), family }]
	})
	switch (((s.guard % 7) + 7) % 7) {
		case 0:
			return guarded({ kind: "nonzero" }, number, familyOf(numberName))
		case 1:
			return guarded({ kind: "nonnegative" }, number, familyOf(numberName))
		case 2:
			return guarded({ kind: "positive" }, number, familyOf(numberName))
		case 3:
			return guarded({ kind: "finite" }, number, familyOf(numberName))
		case 4:
			return guarded(
				{ kind: "within", low: BigInt(s.low), high: BigInt(s.low + s.high) },
				number,
				familyOf(numberName)
			)
		case 5: {
			const own = textOf(fieldOf(textName).scalar)
			return guarded(
				{
					kind: "matches",
					pattern: spelled(
						own === undefined || typeof own === "string" ? "^[a-c]*$" : own.patterns[0].source
					)
				},
				text,
				"text"
			)
		}
		default: {
			const guard: GuardDesc = { kind: "within", low: 0, high: s.high % 6 }
			const subject: ExprDesc = { kind: "compute", fn: "octetLength", args: [text] }
			return {
				guard,
				subject,
				reads: [
					{ desc: guardedExpr(guard, subject), family: "integer" },
					{ desc: text, family: "text" }
				]
			}
		}
	}
}

/** The description a sketch resolves to at `family` over `leaves`. */
const resolveAt = (s: Sketch, family: Family, leaves: Leaves): ExprDesc => {
	const at = (x: Sketch, f: Family): ExprDesc => resolveAt(x, f, leaves)
	switch (s.tag) {
		case "leaf":
			return pickOf(leavesOf(leaves, family), s.pick)
		case "wild":
			return { kind: "var", var: pickOf(names, s.pick) }
		case "param": {
			const name = pickOf(columnsOf(family), s.pick)
			return { kind: "param", name: `p${name}`, type: fieldOf(name).desc }
		}
		case "bare":
			return { kind: "literal", value: bareValue(family, s.value) }
		case "typed":
			return {
				kind: "literal",
				value: bareValue(family, s.value),
				type: fieldOf(pickOf(columnsOf(family), s.pick)).desc
			}
		case "compute": {
			const fn = Arr.match(functionsOf(family), {
				onEmpty: () => undefined,
				onNonEmpty: (fns) => pickOf(fns, s.fn)
			})
			if (fn === undefined) {
				return pickOf(leavesOf(leaves, family), s.fn)
			}
			const signature = signatures[fn]
			const wanted = Arr.map(signature.args, (f) => (f === "same" ? family : f))
			const arity = computeSpecs[fn].arity
			const resolved = Array.from(
				{ length: arity === "variadic" ? Math.max(s.args.length, 1) : arity },
				(_, i) => {
					const a = s.args[i]
					const f = wanted[i] ?? wanted[0] ?? family
					return a === undefined ? pickOf(leavesOf(leaves, f), i) : at(a, f)
				}
			)
			const subject = resolved[0] ?? pickOf(leavesOf(leaves, "text"), 0)
			if (fn === "translate") {
				return {
					kind: "compute",
					fn,
					args: [
						subject,
						{ kind: "literal", value: replaceMap.from },
						{ kind: "literal", value: replaceMap.to }
					]
				}
			}
			if (fn === "matches") {
				const own = textOf(fieldOf(pickOf(columnsOf("text"), s.fn)).scalar)
				return {
					kind: "compute",
					fn,
					args: [
						subject,
						{
							kind: "literal",
							value: own === undefined || typeof own === "string" ? "^a" : own.patterns[0].source
						}
					]
				}
			}
			return fn === "round" || fn === "trunc"
				? { kind: "compute", fn, args: resolved, scale: s.scale < 0 ? undefined : s.scale }
				: { kind: "compute", fn, args: resolved }
		}
		case "compare":
		case "between":
		case "in":
		case "connective":
		case "not":
			return family === "bool" ? predicateAt(s, leaves) : pickOf(leavesOf(leaves, family), 0)
		case "cast": {
			const target = pickOf(columnsOf(family), s.to)
			return {
				kind: "cast",
				to: fieldOf(target).desc,
				arg: at(s.arg, pickOf(families, s.from))
			}
		}
		case "base":
			return { kind: "base", arg: at(s.arg, family) }
		case "cond":
			return {
				kind: "cond",
				pred: at(s.pred, "bool"),
				onTrue: at(s.onTrue, family),
				onFalse: at(s.onFalse, family)
			}
		case "when": {
			const { guard, subject, reads } = guardOf(s)
			return {
				kind: "when",
				guard,
				subject,
				proved: resolveAt(s.proved, family, [...reads, ...leaves]),
				otherwise: at(s.otherwise, family)
			}
		}
	}
}

/** A predicate's sketch resolved over `leaves`, its operands at the family its first operand's pick names. */
const predicateAt = (
	s: Extract<Sketch, { readonly tag: "compare" | "between" | "in" | "connective" | "not" }>,
	leaves: Leaves
): ExprDesc => {
	const at = (x: Sketch, f: Family): ExprDesc => resolveAt(x, f, leaves)
	switch (s.tag) {
		case "compare": {
			const f = pickOf(families, s.op)
			return {
				kind: "compare",
				op: pickOf(compareOps, s.op),
				left: at(s.left, f),
				right: at(s.right, f)
			}
		}
		case "between": {
			const f = pickOf(numberFamilies, s.arg.tag.length)
			return { kind: "between", arg: at(s.arg, f), low: at(s.low, f), high: at(s.high, f) }
		}
		case "in":
			return { kind: "in", arg: at(s.arg, "integer"), values: Arr.map(s.values, (v) => BigInt(v)) }
		case "connective":
			return {
				kind: s.or ? "or" : "and",
				args: nonEmpty(
					Arr.map(s.args, (a) => at(a, "bool")),
					"a connective's operands"
				)
			}
		case "not":
			return { kind: "not", arg: at(s.arg, "bool") }
	}
}

/** A sketch and the family of its root, which the properties resolve into a description. */
const rootGen: Gen<ExprDesc> = (source) => {
	const family = pickOf(families, source.draw(int(0, families.length * 2 - 1)))
	return resolveAt(source.draw(sketchGen(3)), family, headingLeaves)
}

/** The descriptions the properties draw: sketches of at most three operations, resolved at a family over the heading. */
export const descriptions: Gen<ExprDesc> = rootGen

/** The features the property notes. */
export type Feature =
	| "a computation recorded twice"
	| "two computations of one kind over one argument list"

/** The nodes a typed term's tape records, in its order: every node its lowering emits. */
export const recorded = (term: TermTyping<Spelled>): ReadonlyArray<TypedNode> =>
	Arr.flatMap(term.tape, (e: TapeEntry<Spelled>): ReadonlyArray<TypedNode> =>
		e.kind === "node" ? [e.node] : []
	)

/**
 * What names a computation of one kind, as its emission states it: a column's node and name, a parameter's identity,
 * a literal's canonical text, an operation's overload, a cast's, a closed read's relation and field; nothing for VALUE,
 * a domain cast or a conditional, which their arguments alone state.
 */
const nameOf = (e: ScalarExpr): string => {
	switch (e.kind) {
		case "column":
			return `${e.column.node}.${e.column.name}`
		case "param":
			return e.param
		case "literal":
			return canonicalTextOf(e.value)
		case "op":
			return describeOp(e.op)
		case "cast":
			return describeOp(e.cast)
		case "closedAt":
			return `${e.relation}.${e.field}`
		case "closedRow":
		case "closedHas":
			return e.relation
		case "call":
			return e.function.name
		case "variant":
		case "value":
		case "domainCast":
		case "cond":
			return ""
	}
}

/** An emitted expression's computation written out: its kind, what names it, and its arguments' keys, in order. */
export const computationKey = (e: ScalarExpr): string => {
	const name = nameOf(e)
	return `${e.kind}:${name.length}:${name}(${Arr.join(Arr.map(e.args, computationKey), ",")})`
}
