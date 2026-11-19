/**
 * Span producers on PostgreSQL 19: intersection and difference of spans as rule heads and sources.
 *
 * - Correlated: a difference producer correlated to an outer binding inside a LATERAL source, on drawn fact sets,
 *   delivers for each Left fact exactly the pieces of its span minus its group's Right spans, by brute force.
 * - Generated: span queries with producers, in both artifacts, agree with each other and with the span reference
 *   evaluator, and a head carrying the bound tuple beside its piece delivers each piece once.
 *
 * Features: each correlated outcome; each producer kind and tuple shape, with rows.
 */

import { Effect, Formatter, Option } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { emptyEnv } from "#compiler/lower/conservative/context.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import {
	compileSpanCase,
	compileSpanQuery,
	emitWith,
	onlySql,
	rawRows,
	repeats,
	sameSet,
	spanNames
} from "#test/pg/spans/producers/support.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import {
	inSpanSchema,
	spanSchemas,
	spanVariantOf,
	printSpanCase,
	type RawRow,
	referenceRows,
	rowSet,
	spanCaseGen,
	spanDifference,
	spanEndpointKinds,
	spanSchemaDesc,
	spanTextOf
} from "#test/support/oracle/gen/spans.ts"
import { PropertyFailed, seatedOracleProperty } from "#test/support/oracle/runner.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { plainRegion, Q, T } from "#test/unit/lower/conservative/fixtures.ts"

import {
	spanType,
	relationSpec,
	tupleQuery,
	tupleReference,
	ungroupedPackQuery,
	ungroupedPackReference,
	outcomeOf,
	correlatedCases,
	correlatedRequired,
	kinds,
	cases,
	situations,
	sameRowSet
} from "#test/pg/spans/producers/producers.fixtures.ts"

/**
 * Span producers on PostgreSQL 19 lower a producer correlated to an outer binding inside a LATERAL source, on drawn fact sets.
 *
 * Its pre-conversion budget: runs correlatedCases, coverage cases correlatedCases (test/pg/spans/producers/producers.test.ts at 1d00bf8c2).
 */
export const spanProducersOnPostgreSQL19LowerAProducerCorrelatedToAnOuterBindingInsideALATERALSourceOnDrawnFactSets =
	seatedOracleProperty(
		spanSchemas,
		spanVariantOf,
		spanCaseGen({ maxRows: 6, kinds: ["difference"], endpoints: ["bigint"] }),
		{
			situations: correlatedRequired,
			perturb: "none",
			oracle: {
				kind: "second-implementation",
				name: "the brute-force pieces of each Left span minus its group's Right spans"
			},
			budget: { runs: correlatedCases, steered: correlatedCases },
			kept: [],
			kills: [],
			show: Formatter.format,
			check: (k, schema) => (c) =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session(ownerSession())
					return yield* inSpanSchema(db, schema, c, (schema) =>
						Effect.gen(function* () {
							/**
							 * For each Left fact (g, a): the pieces of a minus each Right span of its group, the Right
							 * side a region whose `a` is the outer binding's span (correlated inputs use a lateral
							 * FROM producer, retaining the complete bound-variable tuple).
							 */
							const q = new Q()
							const during = spanType("bigint")
							const left = q.base(relationSpec(c, "Left"), conservativeMeta)
							const right = q.base(relationSpec(c, "Right"), conservativeMeta)
							const inner = q.regionWith(
								[{ source: right, bind: { group: "g2", during: "b" }, constants: {} }],
								{
									...plainRegion,
									correlated: [{ name: "a", type: during, expr: q.col(left, "during") }]
								}
							)
							const produce = q.node({
								kind: "Produce",
								meta: conservativeMeta,
								loc: undefined,
								input: inner,
								producer: "spanDifference",
								args: [q.col(inner, "a"), q.col(inner, "b")],
								carried: ["g2", "a"],
								out: "piece",
								heading: [
									{ name: "g2", type: T.int4 },
									{ name: "a", type: during },
									{ name: "piece", type: during }
								]
							})
							const outer = q.region([
								{ source: left, bind: { group: "g", during: "a" }, constants: {} },
								{ source: produce, bind: { g2: "g", a: "a", piece: "piece" }, constants: {} }
							])
							const built = q.build(outer)
							/**
							 * The baseline delivers the region; the statement casts its columns to text for the raw
							 * comparison.
							 */
							const program = lowerConservative(conservativeInput(built), {
								names: spanNames(schema),
								params: [],
								subject: { kind: "query" }
							})
							if (!program.ok) {
								throw new Error(program.error.message)
							}
							const sql = emitWith(
								built.dag,
								spanNames(schema),
								[
									{ name: "g", type: T.int4 },
									{ name: "a", type: during },
									{ name: "piece", type: during }
								],
								outer,
								(cx) => cx.lower(outer, emptyEnv)
							).sql
							const expected: Array<RawRow> = []
							const spanText = spanTextOf(c.schema.endpoint)
							for (const l of c.facts.Left) {
								for (const r of c.facts.Right) {
									if (l.group === r.group) {
										for (const p of spanDifference(l.during, r.during)) {
											expected.push([String(l.group), spanText(l.during), spanText(p)])
										}
									}
								}
							}
							const want = rowSet(expected)
							k.note(`correlated:${outcomeOf(want)}`)
							const rows = yield* rawRows(db, sql, [])
							const problem = sameSet("correlated", want, rows)
							if (problem !== undefined) {
								return yield* new PropertyFailed({
									report: `${printSpanCase(c)}\n${problem}\n${sql}`
								})
							}
						})
					)
				})
		}
	)

/**
 * Span producers on PostgreSQL 19 agree with each other and the reference on generated span queries.
 *
 * Its pre-conversion budget: runs cases, coverage cases cases (test/pg/spans/producers/producers.test.ts at 1d00bf8c2).
 */
export const spanProducersOnPostgreSQL19AgreeWithEachOtherAndTheReferenceOnGeneratedSpanQueries =
	seatedOracleProperty(
		spanSchemas,
		spanVariantOf,
		spanCaseGen({ maxRows: 6, kinds, endpoints: spanEndpointKinds }),
		{
			situations: situations,
			perturb: "none",
			oracle: {
				kind: "second-implementation",
				name: "the span reference evaluator, and each producer's artifacts against each other"
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
							const fail = (message: string) =>
								Effect.fail(new PropertyFailed({ report: `${printSpanCase(sc)}\n${message}` }))
							const expected = referenceRows(sc)
							c.note(`${sc.query.kind}:${outcomeOf(expected)}`)
							c.note(`endpoint:${sc.schema.endpoint}`)
							/**
							 * Both artifacts of a template against the expected set: the optimized one delivers no
							 * repeated row and agrees with the conservative one, which agrees
							 * with the reference. Yields the optimized SQL.
							 */
							const agree = (
								label: string,
								template: OracleTemplate,
								want: ReadonlyArray<RawRow>
							) =>
								Effect.gen(function* () {
									const optimizedSql = onlySql(template, "optimized")
									const conservativeSql = onlySql(template, "conservative")
									const optimized = yield* rawRows(db, optimizedSql, [])
									const conservative = yield* rawRows(db, conservativeSql, [])
									if (repeats(optimized) > 0) {
										return yield* fail(
											`${label}: optimized repeats a row\n${optimizedSql}\n${Formatter.format(optimized)}`
										)
									}
									const difference = sameRowSet(rowSet(optimized), rowSet(conservative))
									if (Option.isSome(difference)) {
										return yield* fail(
											`${label}: optimized and conservative differ: ${difference.value}\n${Formatter.format(rowSet(optimized))}\n${Formatter.format(rowSet(conservative))}\n${optimizedSql}`
										)
									}
									const problem = sameSet(`${label}: conservative vs reference`, want, conservative)
									if (problem !== undefined) {
										return yield* fail(`${problem}\n${conservativeSql}`)
									}
									return optimizedSql
								})
							yield* agree(sc.query.kind, compileSpanCase(sc, schema), expected)
							const schemaDesc = spanSchemaDesc(sc.schema)
							if (sc.query.kind === "pack") {
								/** The same relation packed under a head of the pack term alone, across groups. */
								const want = ungroupedPackReference(sc, sc.query.relation)
								c.note(`ungroupedPack:${outcomeOf(want)}`)
								yield* agree(
									"ungrouped pack",
									compileSpanQuery(schemaDesc, ungroupedPackQuery(sc.query.relation), schema),
									want
								)
								return
							}
							/**
							 * The bound-tuple head: the piece uniqueness proof drops the DISTINCT exactly when both
							 * relations are span-keyed; otherwise distinct bindings may produce identical
							 * rows and the DISTINCT collapses them.
							 */
							const kind = sc.query.kind
							if (kind !== "intersection" && kind !== "difference") {
								return yield* fail(`a ${kind} case outside the producer kinds`)
							}
							const { expected: want, duplicates } = tupleReference(sc, kind)
							const proved =
								sc.schema.relations.Left.spanKeyed && sc.schema.relations.Right.spanKeyed
							yield* agree(
								`${kind} bound tuple`,
								compileSpanQuery(schemaDesc, tupleQuery(kind), schema),
								want
							)
							const shape = proved ? "proved" : duplicates > 0 ? "duplicates" : "unproved"
							c.note(`tuple:${kind}:${shape}:${outcomeOf(want)}`)
						})
					)
				})
		}
	)
