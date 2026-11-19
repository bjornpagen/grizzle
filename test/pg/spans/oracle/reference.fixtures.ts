/** What the properties of reference.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Formatter, Option, Order } from "effect"
import { AllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { col } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { maskSql } from "#test/support/oracle/allen-sql.ts"
import { classify, type HalfOpen, spanText, windowSpans } from "#test/support/oracle/allen.ts"
import {
	endpointLimits,
	type MaskPredicate,
	overlaps,
	type RawRow,
	referenceRows,
	rowSet,
	type SpanCase,
	type SpanEndpointKind,
	type SpanQueryKind,
	spanQueryKinds,
	spanRelationNames,
	tickContract
} from "#test/support/oracle/gen/spans.ts"

export const points = (span: HalfOpen): ReadonlyArray<bigint> => {
	const out: Array<bigint> = []
	for (let p = span.lo; p < span.hi; p++) {
		out.push(p)
	}
	return out
}

/** The maximal runs of consecutive points of a set. */
export const runs = (set: ReadonlySet<bigint>): ReadonlyArray<HalfOpen> => {
	const sorted = Arr.sort(set, Order.BigInt)
	const out: Array<HalfOpen> = []
	for (const p of sorted) {
		const last = out[out.length - 1]
		if (last?.hi === p) {
			out[out.length - 1] = { lo: last.lo, hi: p + 1n }
		} else {
			out.push({ lo: p, hi: p + 1n })
		}
	}
	return out
}

export const texts = (spans: ReadonlyArray<HalfOpen>): ReadonlyArray<string> =>
	Arr.map(spans, spanText)

export const smallSpanGen: Gen<HalfOpen> = (source) => {
	const lo = source.draw(int(-3, 7))
	const length = source.draw(int(1, 6))
	return { lo: BigInt(lo), hi: BigInt(Math.min(8, lo + length)) }
}

/** What a pack's input reached: no spans, spans the pack merges, or spans it keeps apart. */
export type PackFeature = "no spans" | "spans merged" | "spans kept apart"

/** How two spans of the window meet: apart, or sharing points with b inside a, b covering a, or neither. */
export type PairFeature = "apart" | "split by b" | "covered by b" | "cut at one end"

export const cases = 2000

/** What one case exercises, for the coverage the suite requires. */
export type SpanCaseFeature =
	| `query:${SpanQueryKind}`
	| `endpoint:${SpanEndpointKind}`
	| "span-keyed relation"
	| "id-keyed relation"
	| "span starting at the type minimum"
	| "span ending at the type maximum"
	| "touching neighbours in one group"
	| "overlapping facts in one group"
	| "one span under two identities"
	| "overlap dropped from a span key"
	| `window:${"param" | "literal"}`
	| `point:${"param" | "literal"}`
	| "nonempty result"
	| `relation:${AllenRelation}`

export const caseFeatures = (c: SpanCase): ReadonlyArray<SpanCaseFeature> => {
	const out = new Set<SpanCaseFeature>([`query:${c.query.kind}`, `endpoint:${c.schema.endpoint}`])
	const { min, max } = endpointLimits(c.schema.endpoint)
	for (const name of spanRelationNames) {
		const facts = c.facts[name]
		const keyed = c.schema.relations[name].spanKeyed
		out.add(keyed ? "span-keyed relation" : "id-keyed relation")
		for (const f of facts) {
			if (f.during.lo === min) {
				out.add("span starting at the type minimum")
			}
			if (f.during.hi === max) {
				out.add("span ending at the type maximum")
			}
			for (const g of facts) {
				if (f === g || f.group !== g.group) {
					continue
				}
				if (f.during.hi === g.during.lo) {
					out.add("touching neighbours in one group")
				}
				if (!keyed && overlaps(f.during, g.during)) {
					out.add("overlapping facts in one group")
				}
				if (!keyed && spanText(f.during) === spanText(g.during)) {
					out.add("one span under two identities")
				}
			}
		}
	}
	if (c.dropped.length > 0) {
		out.add("overlap dropped from a span key")
	}
	const q = c.query
	if (q.kind === "allenFilter") {
		out.add(`window:${q.window.kind}`)
		for (const f of c.facts[q.relation]) {
			out.add(`relation:${classify(f.during, q.window.span)}`)
		}
	}
	if (q.kind === "allenJoin") {
		for (const l of c.facts.Left) {
			for (const r of c.facts.Right) {
				if (l.group === r.group) {
					out.add(`relation:${classify(l.during, r.during)}`)
				}
			}
		}
	}
	if (q.kind === "pointIn") {
		out.add(`point:${q.point.kind}`)
	}
	if (referenceRows(c).length > 0) {
		out.add("nonempty result")
	}
	return [...out]
}

export const situations: Arr.NonEmptyReadonlyArray<SpanCaseFeature> = [
	...Arr.map(spanQueryKinds, (k): SpanCaseFeature => `query:${k}`),
	"endpoint:integer",
	"endpoint:bigint",
	"endpoint:contract",
	"endpoint:date",
	"span-keyed relation",
	"id-keyed relation",
	"span starting at the type minimum",
	"span ending at the type maximum",
	"touching neighbours in one group",
	"overlapping facts in one group",
	"one span under two identities",
	"overlap dropped from a span key",
	"window:param",
	"window:literal",
	"point:param",
	"point:literal",
	"nonempty result",
	...Arr.map(allenRelations, (r): SpanCaseFeature => `relation:${r}`)
]

/** The shipped table's formula for a mask, over the two span columns (test/support/oracle/allen-sql.ts). */
export const tableMaskPredicate: MaskPredicate = (mask, left, right) =>
	maskSql(
		AllenMask(mask),
		printExpr(col(left.table, left.column)),
		printExpr(col(right.table, right.column))
	)

const sameRowSet = set(structuralHash, ordered(exact))

export const sameRows = (
	label: string,
	expected: ReadonlyArray<RawRow>,
	actual: ReadonlyArray<RawRow>
): string | undefined => {
	const got = rowSet(actual)
	if (got.length !== actual.length) {
		return `${label}: ${actual.length - got.length} repeated rows`
	}
	const difference = sameRowSet(expected, got)
	return Option.isNone(difference)
		? undefined
		: `${label}: ${difference.value}\n  reference  ${Formatter.format(expected)}\n  postgresql ${Formatter.format(got)}`
}

/**
 * The facts of one relation are lawful: nonempty, inside the endpoint type's range (and the contract's, over a
 * contract endpoint), and, for a span-keyed relation, no two of one group overlapping.
 */
export const assertLawful = (
	c: SpanCase,
	name: (typeof spanRelationNames)[number],
	min: bigint,
	max: bigint
): void => {
	const facts = c.facts[name]
	for (const f of facts) {
		assert.equal(f.during.lo < f.during.hi, true)
		assert.equal(f.during.lo >= min && f.during.hi <= max, true)
		assert.equal(c.schema.endpoint !== "contract" || f.during.lo >= tickContract.low, true)
	}
	const overlapping = Arr.some(facts, (f) =>
		Arr.some(facts, (g) => f !== g && f.group === g.group && overlaps(f.during, g.during))
	)
	assert.equal(c.schema.relations[name].spanKeyed && overlapping, false)
}

export const spans = nonEmpty(windowSpans(), "the window's spans")
