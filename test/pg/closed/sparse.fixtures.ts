/** What the property of sparse.test.ts reads: its drawn constants, their installation, their reads' SQL and the model. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import { wholeByteBits } from "#compiler/core/hex.ts"
import {
	cellsDigestOf,
	cellsLiteralOf,
	type Constant,
	type Entry,
	payloadsDigestOf,
	payloadsLiteralOf
} from "#compiler/ir/cells.ts"
import { libraryCreate, libraryRef } from "#compiler/physical/ddl/library.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { cast, col, lit, types } from "#compiler/sql/build.ts"
import {
	cellOfKey,
	type ClosedConstant,
	closedRead,
	type ConstantFunctions,
	pack,
	pairIn
} from "#compiler/sql/constants.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { oracleCells, oraclePayloads, payloadAt, runText } from "#test/support/closed/codes.ts"

/** A drawn closed relation's constant over a product key, and the keys its reads are asked at. */
export interface SparseCase {
	/** Each key coordinate's codes, in key order. */
	readonly key: NonEmptyReadonlyArray<number>
	/** Each payload coordinate's codes, in order, none for a set. */
	readonly payload: ReadonlyArray<number>
	/** The cells held, ascending, each with its payload code. */
	readonly held: ReadonlyArray<Entry>
	/** The keys asked at, each its digits in key order, or NULL in its first digit; and the payload code a pair asks. */
	readonly probes: ReadonlyArray<{
		readonly digits: ReadonlyArray<number | null>
		readonly code: bigint
	}>
}

/** What a case reached. */
export type SparseFeature =
	| "a set"
	| "a function"
	| "a function of two payload coordinates"
	| "a key space past 2^31 cells"
	| "no cell held"
	| "a held key asked"
	| "an absent key asked"
	| "a key past every held one asked"
	| "a key before every held one asked"
	| "a NULL key asked"
	| "a row holding a cell"
	| "a row holding none"

/** The points of a space whose coordinates hold `sizes` codes each: their product. */
const pointsOf = (sizes: ReadonlyArray<number>): bigint =>
	Arr.reduce(sizes, 1n, (product, size) => product * BigInt(size))

/** The digits of `index` in the space of `sizes`, the first most significant. */
const digitsOf = (sizes: ReadonlyArray<number>, index: bigint): ReadonlyArray<number> => {
	const out: Array<number> = []
	let rest = index
	for (const size of Arr.reverse(sizes)) {
		out.unshift(Number(rest % BigInt(size)))
		rest /= BigInt(size)
	}
	return out
}

/** The index of `digits` in the space of `sizes`, row-major, the first most significant. */
const indexOf = (sizes: ReadonlyArray<number>, digits: ReadonlyArray<number>): bigint =>
	Arr.reduce(
		Arr.zip(sizes, digits),
		0n,
		(index, [size, digit]) => index * BigInt(size) + BigInt(digit)
	)

/** A case over the key `key` and the payload `payload`: drawn held cells and the keys its reads are asked at. */
const caseOver =
	(key: NonEmptyReadonlyArray<number>, payload: ReadonlyArray<number>): Gen<SparseCase> =>
	(s) => {
		const cells = pointsOf(key)
		const points = pointsOf(payload)
		const drawn = cells === 0n ? [] : s.draw(array(bigint(0n, cells - 1n), { min: 0, max: 12 }))
		const indexes = Arr.sort(Arr.dedupe(drawn), Order.BigInt)
		const held = Arr.map(indexes, (index): Entry => ({
			index,
			payload: s.draw(bigint(0n, points - 1n))
		}))
		const asked = Arr.dedupe([
			...Arr.flatMap(indexes, (i) => [i - 1n, i, i + 1n]),
			...(cells <= 64n
				? Array.from({ length: Number(cells) }, (_, i) => BigInt(i))
				: cells === 0n
					? []
					: s.draw(array(bigint(0n, cells - 1n), { min: 0, max: 6 }))),
			...(cells === 0n ? [] : [0n, cells - 1n])
		])
		const inSpace = Arr.filter(asked, (i) => i >= 0n && i < cells)
		return {
			key,
			payload,
			held,
			probes: [
				...Arr.map(inSpace, (index) => ({
					digits: digitsOf(key, index),
					code: s.draw(bigint(0n, points - 1n))
				})),
				{ digits: [null, ...Arr.map(key.slice(1), () => 0)], code: 0n }
			]
		}
	}

/** A drawn case: one to three key coordinates, of a few codes or of up to a roster's whole code space, and a payload. */
const drawnCase: Gen<SparseCase> = (s) => {
	const wide = s.draw(
		weighted([
			[4, constant(false)],
			[1, constant(true)]
		])
	)
	const [first, ...rest] = s.draw(array(wide ? int(1, 32_768) : int(1, 6), { min: 1, max: 3 }))
	const key: NonEmptyReadonlyArray<number> = [defined(first, "a key coordinate"), ...rest]
	return s.draw(caseOver(key, s.draw(array(int(1, 4), { min: 0, max: 2 }))))
}

/**
 * The kept wide case: a key of three coordinates of 32,768 codes each, 2^45 cells, far past the 2^31 an integer index
 * counts, a payload of three codes, and five held cells spread over it.
 */
const wideCase: SparseCase = (() => {
	const key: NonEmptyReadonlyArray<number> = [32_768, 32_768, 32_768]
	const cells = pointsOf(key)
	const indexes = [0n, 1n, cells / 3n, cells / 2n + 7n, cells - 1n]
	const held = Arr.map(indexes, (index, n): Entry => ({ index, payload: BigInt(n % 3) }))
	return {
		key,
		payload: [3],
		held,
		probes: [
			...Arr.flatMap(indexes, (i) =>
				Arr.flatMap([i - 1n, i, i + 1n], (j) =>
					j >= 0n && j < cells ? [{ digits: digitsOf(key, j), code: 1n }] : []
				)
			),
			{ digits: [null, 0, 0], code: 0n }
		]
	}
})()

/** A case: mostly drawn, and now and then the wide case, kept. */
export const sparseCases: Gen<SparseCase> = weighted([
	[12, drawnCase],
	[1, constant(wideCase)]
])

/** A case's constant as the engine's encoder states it, its entries the case's held cells. */
const constantOfCase = (c: SparseCase): Constant => {
	const points = pointsOf(c.payload)
	return { cells: pointsOf(c.key), points: points === 0n ? 1n : points, entries: c.held }
}

/** The installed functions of a case's constant, in the session's pg_temp. */
const functions = (c: SparseCase): ConstantFunctions => ({
	cells: { schema: "pg_temp", name: "sparse_cells" },
	payloads:
		constantOfCase(c).points > 1n
			? { kind: "codes", function: { schema: "pg_temp", name: "sparse_payloads" } }
			: { kind: "one" }
})

/** A case's statements: its constant's arrays and the library's closedRow, each created in pg_temp (sql/constants.ts pack). */
export const createSql = (c: SparseCase): ReadonlyArray<string> => {
	const k = constantOfCase(c)
	const f = functions(c)
	const rows = k.entries.length
	return [
		printStatement(
			pack(
				f.cells,
				{ kind: "cells", cells: k.cells },
				{
					text: succeeded(cellsLiteralOf(k, 1 << 20)),
					rows,
					digest: cellsDigestOf(
						k.cells,
						Arr.map(k.entries, (e) => e.index)
					)
				}
			)
		),
		...(f.payloads.kind === "codes"
			? [
					printStatement(
						pack(
							f.payloads.function,
							{ kind: "payloads", points: k.points },
							{
								text: succeeded(payloadsLiteralOf(k, 1 << 20)),
								rows,
								digest: payloadsDigestOf(
									k.points,
									Arr.map(k.entries, (e) => e.payload)
								)
							}
						)
					)
				]
			: []),
		printStatement(libraryCreate("pg_temp", "closedRow"))
	]
}

/** The width of a case's rows: its last key coordinate's codes rounded up to whole bytes, as a set over it is. */
const rowWidth = (c: SparseCase): number => wholeByteBits(Math.max(defined(c.key.at(-1)), 1))

/** The closed relation of a case as a read addresses it (sql/constants.ts ClosedConstant). */
const closedOf = (c: SparseCase): ClosedConstant => {
	const f = functions(c)
	return {
		constant: f,
		key: {
			kind: "product",
			coordinates: [
				{ field: "k0", radix: c.key[0] },
				...Arr.map(c.key.slice(1), (radix, i) => ({ field: `k${i + 1}`, radix }))
			]
		},
		payload: Arr.map(c.payload, (radix, i) => ({
			field: `p${i}`,
			radix,
			dictionary: undefined,
			are: undefined
		})),
		functions: [f.cells]
	}
}

/** A probe's key column `k<i>`. */
const digitColumn = (i: number): Expr => col("r0", `k${i}`)

/**
 * The SQL of a case's reads over its probes, `$1` their JSON in their order: each probe's membership, each payload
 * coordinate's application, its pair with its asked payload code, and the row of its key's prefix, each as text.
 */
export const readSql = (c: SparseCase): string => {
	const closed = closedOf(c)
	const digits = Arr.map(c.key, (_, i) => digitColumn(i))
	const read = (r: Parameters<typeof closedRead>[2], args: ReadonlyArray<Expr>) =>
		succeeded(closedRead(closed, "Sparse", r, args, types.integer))
	const nonEmptyDigits: NonEmptyReadonlyArray<Expr> = [digitColumn(0), ...digits.slice(1)]
	const width = rowWidth(c)
	const terms: ReadonlyArray<Expr> = [
		read({ kind: "has" }, digits),
		...Arr.map(c.payload, (_, i) => read({ kind: "at", field: `p${i}` }, digits)),
		pairIn(closed.constant, cellOfKey(closed.key, nonEmptyDigits), col("r0", "c")),
		cast(
			succeeded(
				closedRead(
					closed,
					"Sparse",
					{
						kind: "row",
						run: libraryRef("pg_temp", "closedRow"),
						empty: lit.bits(Str.repeat(width / 4)("0"), types.bit(width))
					},
					digits.slice(0, -1),
					types.bit(width)
				)
			),
			types.text
		)
	]
	const columns = Arr.join(
		Arr.map(c.key, (_, i) => `k${i} int2`),
		", "
	)
	return `SELECT ${Arr.join(
		Arr.map(terms, (t) => `(${printExpr(t)})::text`),
		", "
	)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, ${columns}, c int8) ORDER BY r0.ord`
}

/** A case's probes as the JSON its SQL reads, each with its place. */
export const probesJson = (c: SparseCase): ReadonlyArray<Record<string, number | string | null>> =>
	Arr.map(c.probes, (p, ord) => ({
		ord,
		c: p.code.toString(),
		...Rec.fromEntries(Arr.map(p.digits, (d, i) => [`k${i}`, d] as const))
	}))

/**
 * The model's answers to a probe, each a read's text as PostgreSQL prints it, NULL as null: membership, each payload
 * coordinate's code, the pair, and the row of the key's prefix, each read off the oracle's scan of the constant's arrays
 * (test/support/closed/codes.ts), at the index the model's own mixed radix gives the probe's digits.
 */
export const modelOf = (
	c: SparseCase,
	probe: SparseCase["probes"][number]
): ReadonlyArray<string | null> => {
	const k = constantOfCase(c)
	const cells = oracleCells(k)
	const payloads = oraclePayloads(k)
	const digits = probe.digits
	const unknown = Arr.some(digits, (d) => d === null)
	const prefixUnknown = Arr.some(digits.slice(0, -1), (d) => d === null)
	const ds = Arr.map(digits, (d) => d ?? 0)
	const payload = payloadAt(cells, payloads, indexOf(c.key, ds))
	const coordinate = (i: number): string | null =>
		payload === undefined
			? null
			: String(digitsOf(c.payload, payload)[i] ?? assert.fail("a payload digit per coordinate"))
	const last = defined(c.key.at(-1))
	const first = indexOf(c.key.slice(0, -1), ds.slice(0, -1)) * BigInt(last)
	return [
		unknown ? null : payload === undefined ? "false" : "true",
		...Arr.map(c.payload, (_, i) => (unknown ? null : coordinate(i))),
		unknown ? null : payload !== undefined && payload === probe.code ? "true" : "false",
		prefixUnknown ? null : Str.padEnd(rowWidth(c), "0")(runText(cells, first, last))
	]
}

/** What a case reached, read off its constant and its probes. */
export const featuresOf = (c: SparseCase): ReadonlyArray<SparseFeature> => {
	const k = constantOfCase(c)
	const cells = oracleCells(k)
	const asked = Arr.flatMap(c.probes, (p) =>
		Arr.some(p.digits, (d) => d === null)
			? []
			: [
					indexOf(
						c.key,
						Arr.map(p.digits, (d) => d ?? 0)
					)
				]
	)
	const held = Arr.map(c.held, (e) => e.index)
	const first = held[0]
	const last = held.at(-1)
	return [
		c.payload.length === 0 ? "a set" : "a function",
		...(c.payload.length === 2 ? ["a function of two payload coordinates" as const] : []),
		...(k.cells > 2n ** 31n ? ["a key space past 2^31 cells" as const] : []),
		...(c.held.length === 0 ? ["no cell held" as const] : []),
		...(Arr.some(asked, (i) => held.includes(i)) ? ["a held key asked" as const] : []),
		...(Arr.some(asked, (i) => !held.includes(i)) ? ["an absent key asked" as const] : []),
		...(last !== undefined && Arr.some(asked, (i) => i > last)
			? ["a key past every held one asked" as const]
			: []),
		...(first !== undefined && Arr.some(asked, (i) => i < first)
			? ["a key before every held one asked" as const]
			: []),
		"a NULL key asked",
		...(Arr.some(c.probes, (p) => {
			const ds = p.digits
			if (Arr.some(ds, (d) => d === null)) {
				return false
			}
			const lastSize = defined(c.key.at(-1))
			const start =
				indexOf(
					c.key.slice(0, -1),
					Arr.map(ds.slice(0, -1), (d) => d ?? 0)
				) * BigInt(lastSize)
			return Str.includes("1")(runText(cells, start, lastSize))
		})
			? ["a row holding a cell" as const]
			: ["a row holding none" as const])
	]
}
