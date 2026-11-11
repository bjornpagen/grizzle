/**
 * The span reference (test/support/oracle/spans) and the span generators, on the host and against PostgreSQL 19.
 *
 * - Intersection and difference, exhausted over every ordered pair of the nonempty half-open spans over [-3, 8]: the
 *   maximal runs of the point sets a ∩ b and a ∖ b, and overlaps exactly when the intersection holds a point.
 * - Packing, over drawn lists of small spans: the maximal runs of the union of their point sets.
 * - The generators construct admissible schemas, decodable queries and lawful facts: every relation keyed, every key
 *   laid out, every fact inside its endpoint's range and its relation's laws.
 * - The reference agrees with handwritten SQL on generated span cases, on PostgreSQL.
 *
 * Features: how two spans meet; no spans, spans merged and kept apart; each generated query shape and relation.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): reference-difference-closed.patch (the reference's difference keeping
 * the subtracted span's lower bound).
 */
import { describe, it, layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { exact, ordered, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { AllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import type { OwnedKey, OwnedRelation } from "#compiler/schema/own.ts"
import { keyLayout } from "#compiler/schema/representability.ts"
import { col } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { maskSql } from "#test/support/oracle/allen-sql.ts"
import { classify, type HalfOpen, spanText, windowSpans } from "#test/support/oracle/allen.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	defaultSpanCaseLimits,
	endpointLimits,
	endpointMaskPredicate,
	inSpanCase,
	installSpanSchemas,
	type MaskPredicate,
	overlaps,
	printSpanCase,
	type RawRow,
	referenceRows,
	referenceSql,
	rowSet,
	type SpanCase,
	type SpanEndpointKind,
	type SpanQueryKind,
	spanCaseGen,
	spanDifference,
	spanInsert,
	spanIntersection,
	spanPack,
	spanQueryDesc,
	spanQueryKinds,
	spanRelationNames,
	spanSchemaDesc,
	tickContract
} from "#test/support/oracle/gen/spans.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { ownedInput } from "#test/support/policy.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const points = (span: HalfOpen): ReadonlyArray<bigint> => {
	const out: Array<bigint> = []
	for (let p = span.lo; p < span.hi; p++) {
		out.push(p)
	}
	return out
}

/** The maximal runs of consecutive points of a set. */
const runs = (set: ReadonlySet<bigint>): ReadonlyArray<HalfOpen> => {
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

const texts = (spans: ReadonlyArray<HalfOpen>): ReadonlyArray<string> => Arr.map(spans, spanText)

const smallSpanGen: Gen<HalfOpen> = (source) => {
	const lo = source.draw(int(-3, 7))
	const length = source.draw(int(1, 6))
	return { lo: BigInt(lo), hi: BigInt(Math.min(8, lo + length)) }
}

/** What a pack's input reached: no spans, spans the pack merges, or spans it keeps apart. */
type PackFeature = "no spans" | "spans merged" | "spans kept apart"

/** How two spans of the window meet: apart, or sharing points with b inside a, b covering a, or neither. */
type PairFeature = "apart" | "split by b" | "covered by b" | "cut at one end"

describe("the span reference on the host", () => {
	it.effect(
		"computes intersection and binary difference as point sets do, over every pair of the [-3, 8] window",
		(ctx) => {
			const spans = nonEmpty(windowSpans(), "the window's spans")
			return searched(
				ctx,
				exhaust(
					{
						suite: "spans/intersection-difference-host",
						generator: (source) =>
							[source.draw(element(spans)), source.draw(element(spans))] as const,
						literal: Formatter.format,
						limit: spans.length * spans.length,
						coverage: requiredInSpace<PairFeature>([
							"apart",
							"split by b",
							"covered by b",
							"cut at one end"
						]),
						box: "every ordered pair of the nonempty half-open spans over [-3, 8]",
						oracle: {
							kind: "second-implementation",
							name: "the maximal runs of the point sets a ∩ b and a ∖ b"
						},
						caseHang
					},
					([a, b], c) =>
						Effect.sync(() => {
							const pa = new Set(points(a))
							const pb = new Set(points(b))
							const meet = runs(new Set(Arr.filter([...pa], (p) => pb.has(p))))
							const rest = runs(new Set(Arr.filter([...pa], (p) => !pb.has(p))))
							assert.deepEqual(texts(spanIntersection(a, b)), texts(meet))
							assert.deepEqual(texts(spanDifference(a, b)), texts(rest))
							assert.equal(overlaps(a, b), meet.length > 0)
							c.note(
								meet.length === 0
									? "apart"
									: rest.length === 2
										? "split by b"
										: rest.length === 0
											? "covered by b"
											: "cut at one end"
							)
						})
				)
			)
		}
	)

	it.effect("packs as point sets do", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the maximal runs of the union of the spans' point sets"
					},
					suite: "spans/coverage-host",
					draw: drawn(array(smallSpanGen, { min: 0, max: 6 })),
					literal: Formatter.format,
					coverage: required<PackFeature>(["no spans", "spans merged", "spans kept apart"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(spans, c) =>
					Effect.sync(() => {
						const packed = runs(new Set(Arr.flatMap(spans, points)))
						assert.deepEqual(texts(spanPack(spans)), texts(packed))
						c.note(
							spans.length === 0
								? "no spans"
								: packed.length < spans.length
									? "spans merged"
									: "spans kept apart"
						)
					})
			)
		)
	)
})

const cases = 2000

/** What one case exercises, for the coverage the suite requires. */
type SpanCaseFeature =
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

const caseFeatures = (c: SpanCase): ReadonlyArray<SpanCaseFeature> => {
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

const situations: Arr.NonEmptyReadonlyArray<SpanCaseFeature> = [
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

describe("the span generators", () => {
	it.effect("generate admissible schemas, decodable queries and lawful facts", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the schema's ownership and key layout rules, and each relation's laws over its facts"
					},
					suite: "spans/generators",
					draw: drawn(spanCaseGen(defaultSpanCaseLimits)),
					literal: Formatter.format,
					coverage: required<SpanCaseFeature>(situations, { cases: 4 * cases, sense: notesOnly }),
					kept: [],
					runs: 4 * cases,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, noted) =>
					Effect.sync(() => {
						noted.noteAll(caseFeatures(c))
						const schemaDesc = spanSchemaDesc(c.schema)
						const owned = succeeded(ownedInput(schemaDesc), printSpanCase(c))
						for (const name of spanRelationNames) {
							const relation: OwnedRelation | undefined = owned.relations[name]
							if (relation === undefined) {
								return assert.fail(`${name} has a primary key`)
							}
							const primary = Arr.findFirst(relation.keys, (k) => k.primary)
							if (Option.isNone(primary)) {
								return assert.fail(`${name} has a primary key`)
							}
							const pk: OwnedKey = primary.value
							const layout = keyLayout(
								Arr.map(pk.fields, (field) => ({
									field,
									desc: defined(relation.fields[field]).desc
								}))
							)
							if (!layout.ok) {
								return assert.fail(layout.error.kind)
							}
							assert.equal(
								layout.value.gist?.span,
								c.schema.relations[name].spanKeyed ? "during" : undefined
							)
						}
						const query = spanQueryDesc(c)
						const decoded = decodeDesc("query", query)
						if (!decoded.ok) {
							throw new Error(`${printSpanCase(c)}\n${decoded.error.message}`)
						}
						const { min, max } = endpointLimits(c.schema.endpoint)
						for (const name of spanRelationNames) {
							assertLawful(c, name, min, max)
						}
						for (const d of c.dropped) {
							assert.equal(d.fact.group, d.overlaps.group)
							assert.equal(overlaps(d.fact.during, d.overlaps.during), true)
						}
						/** Set semantics: the reference is a set. */
						const rows = referenceRows(c)
						assert.deepEqual(rowSet(rows), rows)
					})
			)
		)
	)
})

/** The shipped table's formula for a mask, over the two span columns (test/support/oracle/allen-sql.ts). */
const tableMaskPredicate: MaskPredicate = (mask, left, right) =>
	maskSql(
		AllenMask(mask),
		printExpr(col(left.table, left.column)),
		printExpr(col(right.table, right.column))
	)

const sameRowSet = set(structuralHash, ordered(exact))

const sameRows = (
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
const assertLawful = (
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

layer(Substrate.layer)("the span reference against PostgreSQL 19", (it) => {
	it.effect("agrees with handwritten SQL on generated span cases", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session(ownerSession())
				const installations = yield* installSpanSchemas(db, "spans")
				return yield* oracleCheck(
					drawn(spanCaseGen(defaultSpanCaseLimits)),
					{
						suite: "spans/reference",
						oracle: {
							kind: "second-implementation",
							name: "handwritten SQL of each generated span case"
						},
						literal: Formatter.format,
						coverage: required<SpanCaseFeature>(situations, { cases: cases, sense: notesOnly }),
						kept: [],
						runs: cases,
						shrink: completeShrink,
						perturb: "none"
					},
					(sc, c) =>
						inSpanCase(db, installations, sc, (schema) =>
							Effect.gen(function* () {
								c.noteAll(caseFeatures(sc))
								const fail = (message: string) =>
									Effect.fail(new PropertyFailed({ report: `${printSpanCase(sc)}\n${message}` }))
								for (const dropped of sc.dropped) {
									const insert = spanInsert(schema, sc, dropped.relation, [dropped.fact])
									yield* db.query("SAVEPOINT refused", [])
									yield* expectSqlstate(db.query(insert.sql, insert.params), "23P01")
									yield* db.query("ROLLBACK TO SAVEPOINT refused", [])
								}
								const expected = referenceRows(sc)
								const byClassifier = referenceSql(schema, sc, endpointMaskPredicate)
								const rows = yield* db.values(byClassifier.sql, byClassifier.params)
								const classified = Arr.map(rows, (row) => Arr.map(row, String))
								const first = sameRows("endpoint classifier", expected, classified)
								if (first !== undefined) {
									return yield* fail(first)
								}
								if (sc.query.kind === "allenFilter" || sc.query.kind === "allenJoin") {
									const byTable = referenceSql(schema, sc, tableMaskPredicate)
									if (regex("\\b(lower|upper)\\(").test(byTable.sql)) {
										return yield* fail(
											`the shipped formula uses lower() or upper(): ${byTable.sql}`
										)
									}
									const rows = yield* db.values(byTable.sql, byTable.params)
									const tabled = Arr.map(rows, (row) => Arr.map(row, String))
									const second = sameRows("shipped mask table", expected, tabled)
									if (second !== undefined) {
										return yield* fail(second)
									}
								}
							})
						)
				)
			})
		)
	)
})
