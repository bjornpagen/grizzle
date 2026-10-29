import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { exact, multiset, ordered } from "@grizzle/testing/oracle"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { compileSpanDesc, installSpans, rowsAs, runArtifact } from "#test/pg/spans/allen/support.ts"
import { jsonText } from "#test/support/json.ts"
import {
	printSpanCase,
	referenceRows,
	type SpanEndpointKind,
	type SpanSchema,
	spanCaseGen,
	spanEndpointKinds,
	spanInsert,
	spanQueryDesc,
	spanQueryHeading,
	spanQueryParams,
	spanRelationNames,
	spanSchemaDesc
} from "#test/support/oracle/gen/spans.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const cases = 300

/** The query kinds this suite draws, and what a case reaches: its query kind over its endpoint kind. */
const kinds = ["allenFilter", "allenJoin", "pointIn"] as const
type AllenOracleFeature = `${(typeof kinds)[number]}:${SpanEndpointKind}`

/** One value for a relation that is span-keyed and one for a relation that is not. */
interface ByKeying<A> {
	readonly spanKeyed: A
	readonly interval: A
}

const byKeying = <A>(values: ByKeying<A>, spanKeyed: boolean): A =>
	spanKeyed ? values.spanKeyed : values.interval

const eachKeying = <A, E, R>(
	make: (spanKeyed: boolean) => Effect.Effect<A, E, R>
): Effect.Effect<ByKeying<A>, E, R> => Effect.all({ spanKeyed: make(true), interval: make(false) })

const schemaOf = (endpoint: SpanEndpointKind, left: boolean, right: boolean): SpanSchema => ({
	endpoint,
	relations: { Left: { name: "Left", spanKeyed: left }, Right: { name: "Right", spanKeyed: right } }
})

/** The installation of every schema a case can draw: each endpoint kind, Left and Right each span-keyed or not. */
const installEvery = (endpoint: SpanEndpointKind) =>
	eachKeying((left) =>
		eachKeying((right) =>
			installSpans(spanSchemaDesc(schemaOf(endpoint, left, right)), {
				label: "spanoracle",
				extensions: []
			})
		)
	)

const sameRowSet = multiset(ordered(exact))

layer(Substrate.layer)("generated span queries against the reference", (it) => {
	it.effect(
		`agree with the reference in both artifacts on ${cases} Allen and pointIn cases`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session({ ...ownerSession(), label: "owner" })
					const installed = yield* Effect.all({
						integer: installEvery("integer"),
						bigint: installEvery("bigint"),
						contract: installEvery("contract")
					})
					return yield* oracleCheck(
						drawn(spanCaseGen({ maxRows: 6, kinds, endpoints: spanEndpointKinds })),
						{
							suite: "spans/allen-oracle",
							literal: Formatter.format,
							features: features<AllenOracleFeature>(
								Arr.flatMap(kinds, (k) =>
									Arr.map(spanEndpointKinds, (e): AllenOracleFeature => `${k}:${e}`)
								)
							),
							kept: [],
							runs: cases,
							shrink: completeShrink,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2),
							perturb: "none"
						},
						(sc, c) =>
							Effect.gen(function* () {
								const kind = sc.query.kind
								if (kind !== "allenFilter" && kind !== "allenJoin" && kind !== "pointIn") {
									return yield* PropertyFailed.make({
										report: `${printSpanCase(sc)}\na ${kind} case outside the drawn kinds`
									})
								}
								c.note(`${kind}:${sc.schema.endpoint}`)
								const target = byKeying(
									byKeying(installed[sc.schema.endpoint], sc.schema.relations.Left.spanKeyed),
									sc.schema.relations.Right.spanKeyed
								)
								const template = compileSpanDesc(
									spanQueryDesc(sc),
									spanSchemaDesc(sc.schema),
									target.schema
								)
								const expected = referenceRows(sc)
								const columns = spanQueryHeading(sc.query)
								yield* db.begin
								const outcome = yield* Effect.gen(function* () {
									for (const name of spanRelationNames) {
										if (sc.facts[name].length === 0) {
											continue
										}
										const insert = spanInsert(target.schema, sc, name, sc.facts[name])
										yield* db.query(insert.sql, insert.params)
									}
									const problems: Array<string> = []
									for (const artifact of ["optimized", "conservative"] as const) {
										const spec = template[artifact][0]
										if (spec === undefined || template[artifact].length !== 1) {
											return [`${artifact}: one statement`]
										}
										if (regex("\\b(lower|upper)\\(").test(spec.sql)) {
											problems.push(`${artifact}: lower() or upper()`)
										}
										const [rows] = yield* runArtifact(db, template, artifact, spanQueryParams(sc))
										const got = rowsAs(spec, rows ?? [], columns)
										if (got.repeats > 0) {
											problems.push(`${artifact}: ${got.repeats} repeated rows`)
										}
										const difference = sameRowSet(got.rows, expected)
										if (Option.isSome(difference)) {
											problems.push(
												`${artifact}: ${difference.value}\n  reference  ${jsonText(expected)}\n  postgresql ${jsonText(got.rows)}`
											)
										}
									}
									return problems
								}).pipe(Effect.ensuring(Effect.ignore(db.rollback)))
								if (outcome.length > 0) {
									return yield* PropertyFailed.make({
										report: `${printSpanCase(sc)}\n${Arr.join(outcome, "\n")}`
									})
								}
							})
					)
				})
			),
		900_000
	)
})
