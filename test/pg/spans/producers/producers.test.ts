import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { exact, multiset, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { emptyEnv } from "#compiler/lower/conservative/context.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import {
	compileSpanCase,
	compileSpanQuery,
	emitWith,
	installSpanCase,
	onlySql,
	rawRows,
	repeats,
	sameSet,
	spanNames
} from "#test/pg/spans/producers/support.ts"
import {
	decodedQuery,
	type AuthoredExprDesc as ExprDesc,
	type RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { spanText } from "#test/support/oracle/allen.ts"
import {
	printSpanCase,
	type RawRow,
	referenceRows,
	rowSet,
	type SpanCase,
	type SpanEndpointKind,
	type SpanQueryKind,
	spanCaseGen,
	spanDifference,
	spanEndpointKinds,
	spanIntersection,
	spanPack,
	spanSetupStatements,
	spanSchemaDesc,
	tickContract
} from "#test/support/oracle/gen/spans.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { plainRegion, Q, type RelationSpec, T } from "#test/unit/lower/conservative/fixtures.ts"

/** The scalar type of a span field of the case's endpoint, as the checker types it: the registry's. */
const spanType = (endpoint: SpanEndpointKind): ScalarType => {
	switch (endpoint) {
		case "integer":
			return scalarOf(
				{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
				{}
			)
		case "bigint":
			return T.range8
		case "contract":
			return scalarOf(
				{
					kind: "span",
					endpoint: {
						kind: "contract",
						name: tickContract.name,
						base: { kind: "pg", type: "bigint" },
						predicate: undefined,
						facts: []
					},
					width: undefined
				},
				{}
			)
	}
}

const relationSpec = (c: SpanCase, name: "Left" | "Right"): RelationSpec => {
	const during = spanType(c.schema.endpoint)
	return c.schema.relations[name].spanKeyed
		? {
				name,
				heading: [
					{ name: "group", type: T.int4 },
					{ name: "during", type: during }
				],
				primaryKey: ["group", "during"]
			}
		: {
				name,
				heading: [
					{ name: "id", type: T.int4 },
					{ name: "group", type: T.int4 },
					{ name: "during", type: during }
				],
				primaryKey: ["id"]
			}
}

/** A pair rule's head with a producer, and the query over it. */
const variable = (id: string): ExprDesc => ({ kind: "var", var: id })
const pairQuery = (head: RuleDesc["head"]): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "g", origin: { relation: "Left", field: "group" } },
					{ id: "a", origin: { relation: "Left", field: "during" } },
					{ id: "b", origin: { relation: "Right", field: "during" } }
				],
				matches: [
					{
						source: { kind: "relation", name: "Left" },
						bindings: { group: variable("g"), during: variable("a") }
					},
					{
						source: { kind: "relation", name: "Right" },
						bindings: { group: variable("g"), during: variable("b") }
					}
				],
				where: [],
				head,
				interiors: [],
				attach: []
			}
		]
	})

/**
 * The pair query whose head carries the complete bound tuple beside the piece: group, left, right and the producer of
 * the case's kind. The pieces of one binding are told apart by the piece, so the produced heading is unique exactly
 * when (group, left, right) is a key of the pair, which holds when both relations are span-keyed.
 */
const tupleQuery = (kind: "intersection" | "difference"): QueryDesc =>
	pairQuery({
		group: variable("g"),
		left: variable("a"),
		right: variable("b"),
		piece: { kind: "producer", fn: kind, args: [variable("a"), variable("b")] }
	})

/**
 * The bound-tuple query's rows by brute force, in the public heading's code-unit order: group, left, piece, right; and
 * how many binding pieces repeat another, the rows a missing DISTINCT would duplicate.
 */
const tupleReference = (
	c: SpanCase,
	kind: "intersection" | "difference"
): { readonly expected: ReadonlyArray<RawRow>; readonly duplicates: number } => {
	const produce = kind === "intersection" ? spanIntersection : spanDifference
	const bag: Array<RawRow> = []
	for (const l of c.facts.Left) {
		for (const r of c.facts.Right) {
			if (l.group === r.group) {
				for (const p of produce(l.during, r.during)) {
					bag.push([String(l.group), spanText(l.during), spanText(p), spanText(r.during)])
				}
			}
		}
	}
	const expected = rowSet(bag)
	return { expected, duplicates: bag.length - expected.length }
}

/**
 * An ungrouped pack: the head is the pack term alone, so it groups by no other term and yields the maximal components
 * of every span of the relation, whatever its group; an empty relation yields no row.
 */
const ungroupedPackQuery = (relation: "Left" | "Right"): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [{ id: "s", origin: { relation, field: "during" } }],
				matches: [
					{ source: { kind: "relation", name: relation }, bindings: { during: variable("s") } }
				],
				where: [],
				head: { piece: { kind: "producer", fn: "pack", args: [variable("s")] } },
				interiors: [],
				attach: []
			}
		]
	})

const ungroupedPackReference = (c: SpanCase, relation: "Left" | "Right"): ReadonlyArray<RawRow> =>
	rowSet(Arr.map(spanPack(Arr.map(c.facts[relation], (f) => f.during)), (p) => [spanText(p)]))

/**
 * What a generated case reaches: its query kind, the ungrouped pack of a pack case, and a bound-tuple case's uniqueness
 * shape, each with rows or empty.
 */
const outcomes = ["rows", "empty"] as const
const tupleKinds = ["intersection", "difference"] as const
const tupleShapes = ["proved", "duplicates", "unproved"] as const
type Outcome = (typeof outcomes)[number]
type ProducerFeature =
	| `${SpanQueryKind}:${Outcome}`
	| `correlated:${Outcome}`
	| `ungroupedPack:${Outcome}`
	| `tuple:${(typeof tupleKinds)[number]}:${(typeof tupleShapes)[number]}:${Outcome}`
const outcomeOf = (rows: ReadonlyArray<RawRow>): Outcome => (rows.length > 0 ? "rows" : "empty")

layer(Substrate.layer)("span producers on PostgreSQL 19", (it) => {
	/**
	 * The correlated producer is built as IR by hand, which no query builder reaches: a planted structure over drawn
	 * facts, against the brute-force point-set difference.
	 */
	const correlatedCases = 200
	const correlatedRequired: Arr.NonEmptyReadonlyArray<ProducerFeature> = Arr.map(
		outcomes,
		(outcome): ProducerFeature => `correlated:${outcome}`
	)
	it.effect(
		`lower a producer correlated to an outer binding inside a LATERAL source, on ${correlatedCases} drawn fact sets`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ ...freshSchema, label: "producers" })
					const db = yield* s.session(ownerSession())
					for (const statement of spanSetupStatements(schema)) {
						yield* db.query(statement, [])
					}
					return yield* oracleCheck(
						drawn(spanCaseGen({ maxRows: 6, kinds: ["difference"], endpoints: ["bigint"] })),
						{
							suite: "spans/producers/correlated",
							literal: Formatter.format,
							coverage: required<ProducerFeature>(correlatedRequired, {
								cases: correlatedCases,
								sense: notesOnly
							}),
							kept: [],
							runs: correlatedCases,
							shrink: completeShrink,
							caseHang: Duration.minutes(2),
							perturb: "none"
						},
						(c, k) =>
							Effect.gen(function* () {
								yield* installSpanCase(db, schema, c)
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
			)
	)

	const kinds = [
		"intersection",
		"difference",
		"pack"
	] as const satisfies ReadonlyArray<SpanQueryKind>
	const cases = 1000
	const situations: Arr.NonEmptyReadonlyArray<ProducerFeature> = [
		...Arr.flatMap(kinds, (kind) =>
			Arr.map(outcomes, (outcome): ProducerFeature => `${kind}:${outcome}`)
		),
		...Arr.map(outcomes, (outcome): ProducerFeature => `ungroupedPack:${outcome}`),
		...Arr.flatMap(tupleKinds, (kind) =>
			Arr.map(tupleShapes, (shape): ProducerFeature => `tuple:${kind}:${shape}:rows`)
		)
	]
	const sameRowSet = multiset(ordered(exact))

	it.effect(
		`agree with each other and the reference on ${cases} generated span queries`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ ...freshSchema, label: "producers" })
					const db = yield* s.session(ownerSession())
					for (const statement of spanSetupStatements(schema)) {
						yield* db.query(statement, [])
					}
					return yield* oracleCheck(
						drawn(spanCaseGen({ maxRows: 6, kinds, endpoints: spanEndpointKinds })),
						{
							suite: "spans/producers",
							literal: Formatter.format,
							coverage: required<ProducerFeature>(situations, { cases: cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: completeShrink,
							caseHang: Duration.minutes(2),
							perturb: "none"
						},
						(sc, c) =>
							Effect.gen(function* () {
								const fail = (message: string) =>
									Effect.fail(new PropertyFailed({ report: `${printSpanCase(sc)}\n${message}` }))
								yield* installSpanCase(db, schema, sc)
								const expected = referenceRows(sc)
								c.note(`${sc.query.kind}:${outcomeOf(expected)}`)
								/**
								 * Both artifacts of a template against the expected set: the optimized one delivers no
								 * repeated row and agrees with the conservative one, which agrees
								 * with the reference. Yields the optimized SQL.
								 */
								const agree = (
									label: string,
									template: QueryTemplate,
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
										const problem = sameSet(
											`${label}: conservative vs reference`,
											want,
											conservative
										)
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
			),
		900_000
	)
})
