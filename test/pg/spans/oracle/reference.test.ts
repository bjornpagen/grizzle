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
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Formatter } from "effect"
import { decodeDesc } from "#compiler/ir/desc.ts"
import type { OwnedKey, OwnedRelation } from "#compiler/schema/own.ts"
import { keyLayout } from "#compiler/schema/representability.ts"
import {
	assertLawful,
	caseFeatures,
	cases,
	type PackFeature,
	type PairFeature,
	points,
	runs,
	situations,
	smallSpanGen,
	type SpanCaseFeature,
	spans,
	texts,
	sameRows,
	tableMaskPredicate
} from "#test/pg/spans/oracle/reference.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	defaultSpanCaseLimits,
	endpointLimits,
	overlaps,
	printSpanCase,
	referenceRows,
	rowSet,
	spanCaseGen,
	spanDifference,
	spanIntersection,
	spanPack,
	spanQueryDesc,
	spanRelationNames,
	spanSchemaDesc,
	endpointMaskPredicate,
	referenceSql,
	spanInsert,
	inSpanSchema,
	spanVariantOf,
	spanSchemas
} from "#test/support/oracle/gen/spans.ts"
import { PropertyFailed, seatedOracleProperty } from "#test/support/oracle/runner.ts"
import { ownedInput } from "#test/support/policy.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate, ownerSession } from "#test/support/substrate/substrate.ts"

/**
 * The span reference on the host computes intersection and binary difference as point sets do, over every pair of the [-3, 8] window.
 */
export const theSpanReferenceOnTheHostComputesIntersectionAndBinaryDifferenceAsPointSetsDoOverEveryPairOfThe38Window =
	property.exhaust(
		finite((source) => [source.draw(element(spans)), source.draw(element(spans))] as const),
		{
			needs: {},
			situations: ["apart", "split by b", "covered by b", "cut at one end"] satisfies ReadonlyArray<
				Reached<PairFeature>
			>,
			check:
				(_, c: Case<PairFeature>) =>
				([a, b]) =>
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "the maximal runs of the point sets a ∩ b and a ∖ b"
			},
			box: "every ordered pair of the nonempty half-open spans over [-3, 8]",
			kept: [],
			kills: []
		}
	)

/**
 * The span reference on the host packs as point sets do.
 *
 * Its pre-conversion budget: runs 2000, coverage cases 200 (test/pg/spans/oracle/reference.test.ts at 1d00bf8c2).
 */
export const theSpanReferenceOnTheHostPacksAsPointSetsDo = property.explore(
	array(smallSpanGen, { min: 0, max: 6 }),
	{
		needs: {},
		situations: ["no spans", "spans merged", "spans kept apart"] satisfies ReadonlyArray<
			Reached<PackFeature>
		>,
		check: (_, c: Case<PackFeature>) => (spans) =>
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "the maximal runs of the union of the spans' point sets"
		},
		budget: { runs: 2000, steered: 200 },
		kept: [],
		kills: []
	}
)

/**
 * The span generators generate admissible schemas, decodable queries and lawful facts.
 *
 * Its pre-conversion budget: runs 4 * cases, coverage cases 4 * cases (test/pg/spans/oracle/reference.test.ts at 1d00bf8c2).
 */
export const theSpanGeneratorsGenerateAdmissibleSchemasDecodableQueriesAndLawfulFacts =
	property.explore(spanCaseGen(defaultSpanCaseLimits), {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<SpanCaseFeature>>,
		check: (_, noted: Case<SpanCaseFeature>) => (c) =>
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
			}),
		oracle: {
			kind: "specification",
			name: "the schema's ownership and key layout rules, and each relation's laws over its facts"
		},
		budget: { runs: 4 * cases, steered: 4 * cases },
		kept: [],
		kills: []
	})

/**
 * The span reference against PostgreSQL 19 agrees with handwritten SQL on generated span cases, each case on the
 * worker's seat of its span schema's template (oracle/gen/spans.ts spanSchemaTemplates).
 *
 * Its pre-conversion budget: runs 2000, coverage cases 2000 (test/pg/spans/oracle/reference.test.ts at 1d00bf8c2).
 */
export const theSpanReferenceAgainstPostgreSQL19AgreesWithHandwrittenSQLOnGeneratedSpanCases =
	seatedOracleProperty(spanSchemas, spanVariantOf, spanCaseGen(defaultSpanCaseLimits), {
		situations,
		perturb: "none",
		oracle: {
			kind: "second-implementation",
			name: "handwritten SQL of each generated span case"
		},
		budget: { runs: cases, steered: cases },
		kept: [],
		kills: [],
		show: Formatter.format,
		check: (c, schema) => (sc) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session(ownerSession())
				return yield* inSpanSchema(db, schema, sc, (schema) =>
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
								return yield* fail(`the shipped formula uses lower() or upper(): ${byTable.sql}`)
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
			})
	})
