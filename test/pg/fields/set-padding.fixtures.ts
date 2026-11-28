/** What the properties of set-padding.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { aimed, array, boolean, type Gen, int, map, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Bit, bit, closedId, generated, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"

/** The handle of code c of the drawn roster. */
export const handleOf = (code: number): string => `s${code}`

/** One drawn row of R: its code k and its two sets' codes. */
interface Row {
	readonly k: number
	readonly a: ReadonlyArray<number>
	readonly b: ReadonlyArray<number>
}

/** A drawn case: the roster's codes, which pairs (from, to) C holds, row-major, and R's rows. */
export interface Drawn {
	readonly size: number
	readonly pairs: ReadonlyArray<boolean>
	readonly rows: NonEmptyReadonlyArray<Row>
}

/** The cases over a roster of a size `sizes` draws. */
const casesOf =
	(sizes: Gen<number>): Gen<Drawn> =>
	(s) => {
		const size = s.draw(sizes)
		const codes = Array.from({ length: size }, (_, code) => code)
		const row: Gen<Row> = (r) => ({
			k: r.draw(int(0, size - 1)),
			a: r.draw(subarray(codes)),
			b: r.draw(subarray(codes))
		})
		return {
			size,
			pairs: s.draw(array(boolean, { min: size * size, max: size * size })),
			rows: [s.draw(row), ...s.draw(array(row, { min: 0, max: 3 }))]
		}
	}

const cases: Gen<Drawn> = casesOf(int(1, 9))

/**
 * The cases over a roster whose bit text pads `pad` bits (setWidth rounds a set up to whole bytes, eight bits each): of
 * a size `pad` short of one or two bytes.
 */
const paddedBy = (pad: number): Gen<Drawn> => casesOf(map(int(1, 2), (bytes) => 8 * bytes - pad))

/** The cases, aimed: a case whose turn aims at a padding draws a roster of a size that pads that many bits. */
export const space = aimed(cases, [
	["no pad bit", paddedBy(0)],
	["one pad bit", paddedBy(1)],
	["two pad bits", paddedBy(2)],
	["three pad bits", paddedBy(3)],
	["four to seven pad bits", paddedBy(5)]
])

export type Feature =
	| "one pad bit"
	| "two pad bits"
	| "three pad bits"
	| "four to seven pad bits"
	| "no pad bit"
	| "an empty set computed"
	| "a full set computed"

/** The features of a padding of `pad` bits. */
export const padFeature = (pad: number): Feature =>
	pad === 0
		? "no pad bit"
		: pad === 1
			? "one pad bit"
			: pad === 2
				? "two pad bits"
				: pad === 3
					? "three pad bits"
					: "four to seven pad bits"

/**
 * The schema a case declares, its sets over the roster S, and its full world's workload: R's rows written with the facts
 * each call gives, and every row read back with its stored sets and the query's own union and difference of a and b.
 */
export const schemaOf = (d: Drawn) => {
	const handles: NonEmptyReadonlyArray<string> = [
		handleOf(0),
		...Array.from({ length: d.size - 1 }, (_, code) => handleOf(code + 1))
	]
	const S = closed.ordered("S", handles)
	const C = closed.relation(
		"C",
		{ from: closedId(S), to: closedId(S) },
		["from", "to"],
		Arr.flatMap(d.pairs, (held, at) =>
			held ? [{ from: handleOf(Math.floor(at / d.size)), to: handleOf(at % d.size) }] : []
		)
	)
	const R = relation.generated(
		"R",
		{ id: int4, k: closedId(S), a: bit(S), b: bit(S) },
		["id"],
		(r) => ({
			u: generated(bit(S), Bit.union(r.a, r.b)),
			i: generated(bit(S), Bit.intersection(r.a, r.b)),
			d: generated(bit(S), Bit.difference(r.a, r.b)),
			e: generated(bit(S), Bit.difference(Bit.union(r.a, Bit.of(S, handles)), r.a)),
			w: generated(bit(S), C.row(r.k))
		})
	)
	const Sets = schema("SetPadding", [S, C, R], [])
	const programs = {
		write: ChangeSet.empty(Sets).insert(R, []),
		sets: query(Sets).rule((r) => {
			const { id, a, b, u, i, d: diff, e, w } = v(R, "r")
			return r.match(R, { id, a, b, u, i, d: diff, e, w }).find({
				id,
				u,
				i,
				d: diff,
				e,
				w,
				qu: Bit.union(a, b),
				qd: Bit.difference(a, b)
			})
		})
	}
	return { S, R, Sets, programs }
}

/** A set's codes, ascending. */
export const sorted = (codes: Iterable<number>): ReadonlyArray<number> =>
	Arr.sort(Arr.dedupe(Arr.fromIterable(codes)), Order.Number)

/** A read set's codes, ascending, each handle s<c> read back as c. */
export const codesOf = (set: Iterable<string>): ReadonlyArray<number> =>
	sorted(Arr.map(Arr.fromIterable(set), (h) => Number(Str.slice(1)(h))))
