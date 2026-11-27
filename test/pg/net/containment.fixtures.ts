/** What the property of containment.test.ts reads: its space, its terms and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/unit/compute/support.ts"

/** The network types an operand is of. */
export type NetType = "inet" | "cidr"

/** The three containment tests, by the name the catalogue gives each (scalar/compute/registry.ts netContainment). */
export const netFns = ["netWithin", "netStrictlyWithin", "netOverlaps"] as const
export type NetFn = (typeof netFns)[number]

/** An address family and its width in bits. */
type Family = "ipv4" | "ipv6"
const widthOf = { ipv4: 32, ipv6: 128 } as const satisfies Record<Family, number>

/** A network value as drawn: its family, its address's bits (most significant first) and its mask length. */
interface NetValue {
	readonly family: Family
	readonly address: ReadonlyArray<0 | 1>
	readonly bits: number
}

/** An address's bits, each drawn, or a run of zeros or ones, so masks fall on and off set bits. */
const addressOf = (family: Family): Gen<ReadonlyArray<0 | 1>> =>
	weighted([
		[3, (s) => Array.from({ length: widthOf[family] }, () => (s.draw(boolean) ? 1 : 0))],
		[1, () => Array.from({ length: widthOf[family] }, (): 0 | 1 => 0)],
		[1, () => Array.from({ length: widthOf[family] }, (): 0 | 1 => 1)]
	])

/** A mask length: none, the whole width, or anywhere, often on a byte's edge. */
const maskOf = (family: Family): Gen<number> =>
	weighted([
		[1, () => 0],
		[1, () => widthOf[family]],
		[2, (s) => s.draw(int(0, widthOf[family] / 8)) * 8],
		[3, int(0, widthOf[family])]
	])

/** A value of a family, its address cleared past its mask where it is a cidr's. */
const valueOf =
	(family: Family, type: NetType): Gen<NetValue> =>
	(s) => {
		const bits = s.draw(maskOf(family))
		const address = s.draw(addressOf(family))
		return { family, address: type === "cidr" ? cleared(address, bits) : address, bits }
	}

/** An address with every bit past the first `bits` cleared. */
const cleared = (address: ReadonlyArray<0 | 1>, bits: number): ReadonlyArray<0 | 1> =>
	Arr.map(address, (bit, i): 0 | 1 => (i < bits ? bit : 0))

/**
 * A value related to `other`: of its family, its address `other`'s on a drawn prefix and drawn past it, its mask drawn
 * about that prefix and `other`'s own, so the three tests hold and fail near their edges.
 */
const relatedTo =
	(other: NetValue, type: NetType): Gen<NetValue> =>
	(s) => {
		const width = widthOf[other.family]
		const prefix = s.draw(
			element([0, other.bits, Math.min(width, other.bits + 1), s.draw(int(0, width))])
		)
		const tail = s.draw(addressOf(other.family))
		const address = Arr.map(other.address, (bit, i): 0 | 1 => (i < prefix ? bit : (tail[i] ?? 0)))
		const bits = s.draw(
			element([
				prefix,
				other.bits,
				Math.max(0, other.bits - 1),
				Math.min(width, other.bits + 1),
				s.draw(int(0, width))
			])
		)
		return {
			family: other.family,
			address: type === "cidr" ? cleared(address, bits) : address,
			bits
		}
	}

/** One pair: its first operand, and its second, unrelated, related to the first, or of the other family. */
interface Pair {
	readonly a: NetValue
	readonly b: NetValue
}

/** A case: the operands' types, and a batch of pairs. */
export interface Case {
	readonly a: NetType
	readonly b: NetType
	readonly pairs: ReadonlyArray<Pair>
}

const pairOf =
	(ta: NetType, tb: NetType): Gen<Pair> =>
	(s) => {
		const family = s.draw(element(["ipv4", "ipv6"] as const))
		const a = s.draw(valueOf(family, ta))
		const b = s.draw(
			weighted<NetValue>([
				[3, relatedTo(a, tb)],
				[1, valueOf(family, tb)],
				[1, valueOf(family === "ipv4" ? "ipv6" : "ipv4", tb)]
			])
		)
		return { a, b }
	}

export const cases: Gen<Case> = (s) => {
	const a = s.draw(element(["inet", "cidr"] as const))
	const b = s.draw(element(["inet", "cidr"] as const))
	return { a, b, pairs: s.draw(array(pairOf(a, b), { min: 1, max: 48 })) }
}

/** A value's text as PostgreSQL reads it: its dotted octets or its eight words, in full, and always its mask. */
export const textOf = (v: NetValue): string => {
	const groups = v.family === "ipv4" ? 4 : 8
	const size = v.family === "ipv4" ? 8 : 16
	const numbers = Array.from({ length: groups }, (_, g) =>
		Arr.reduce(v.address.slice(g * size, g * size + size), 0, (n, bit) => n * 2 + bit)
	)
	const address =
		v.family === "ipv4"
			? Arr.join(Arr.map(numbers, String), ".")
			: Arr.join(
					Arr.map(numbers, (n) => n.toString(16)),
					":"
				)
	return `${address}/${v.bits}`
}

const columns: { readonly [T in NetType]: LeafBinding } = {
	inet: { kind: "column", type: testPg.inet.scalar },
	cidr: { kind: "column", type: testPg.cidr.scalar }
}

/** The three tests over operands of `a`'s and `b`'s types, each lowered in a query as a filter (lower.ts). */
export const termsOf = (a: NetType, b: NetType): { readonly [F in NetFn]: ScalarExpr } => {
	const termOf = (fn: NetFn): ScalarExpr =>
		succeeded(
			lowerWith(
				"query",
				{
					kind: "compute",
					fn,
					args: [
						{ kind: "var", var: "a" },
						{ kind: "var", var: "b" }
					]
				},
				{ a: columns[a], b: columns[b] },
				true,
				baseParams
			),
			`${fn} over ${a} and ${b} lowers in a query`
		).root.expr
	return {
		netWithin: termOf("netWithin"),
		netStrictlyWithin: termOf("netStrictlyWithin"),
		netOverlaps: termOf("netOverlaps")
	}
}

/** The SQL of the three tests over a batch, each pair's operands read by their types' input functions, in order. */
export const containmentSql = (a: NetType, b: NetType): string => {
	const terms = termsOf(a, b)
	const each = Arr.join(
		Arr.map(netFns, (fn) => `(${renderSql(terms[fn], plainRender)})::text`),
		", "
	)
	return `SELECT ${each} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, a ${a}, b ${b}) ORDER BY r0.ord`
}

/** The host evaluator's value of a test over one pair's texts (scalar/compute/evaluate.ts). */
export const hostHolds = (term: ScalarExpr, a: string, b: string): boolean => {
	const table = predicateTable(term)
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => (ref.name === "a" ? a : b),
				closed: () => undefined,
				param: noParamLeaf
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates a network containment"
	)
	return typeof value === "boolean"
		? value
		: assert.fail(`the host's value is a boolean, not ${Formatter.format(value)}`)
}

export type Feature =
	| `${NetType} and ${NetType}`
	| "within held"
	| "within failed"
	| "strictly within held"
	| "overlap held"
	| "overlap failed"
	| "two families"
	| "no mask"

/** What a pair reaches, by the values PostgreSQL gives its three tests. */
export const featuresOf = (
	pair: Pair,
	within: boolean,
	strictly: boolean,
	overlaps: boolean
): ReadonlyArray<Feature> => [
	within ? "within held" : "within failed",
	...(strictly ? ["strictly within held" as const] : []),
	overlaps ? "overlap held" : "overlap failed",
	...(pair.a.family !== pair.b.family ? ["two families" as const] : []),
	...(pair.a.bits === 0 || pair.b.bits === 0 ? ["no mask" as const] : [])
]
