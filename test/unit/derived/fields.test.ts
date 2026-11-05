import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Record } from "effect"
import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { buildSchema, caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { checkedIn, checking } from "#test/support/policy.ts"

/** A declared field's descriptor as a view column carries it: a serial as its plain width.
 *
 * Field inference for derived relations: every head term carries its descriptor, so a
 * derived relation's heading needs no restatement.
 *
 * - Over the derived oracle's generated schemas (every base kind, contracts, rosters, refined text, drawn aggregates
 *   and levels): each derived relation's fields are keyed in its heading's order, each the descriptor
 *   fieldDescOf gives its column's type; and every declared field's descriptor comes back from its type unchanged, a
 *   serial as its plain width, since a view column is never an identity.
 * - A contract no relation declares has no descriptor: fieldDescOf names it, and a derived field cast to it is refused
 *   at that field.
 *
 * That each inferred type is PostgreSQL's own result type, for every aggregate overload, refinement, roster and
 * contract, with its typmod and collation, is the database suite's, against the installed views' catalog. */
const asViewColumn = (d: FieldDesc): FieldDesc =>
	d.kind === "serial"
		? {
				kind: "pg",
				type: d.type === "bigserial" ? "bigint" : d.type === "serial" ? "integer" : "smallint"
			}
		: d

type FieldFeature =
	| "a derived relation of several columns"
	| "a contract field"
	| "a closed id field"
	| "a refined text field"

describe("derived field inference", () => {
	it.effect(
		"keys each derived relation's fields in heading order with fieldDescOf's descriptors, and gives every declared descriptor back",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/fields",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						coverage: required<FieldFeature>(
							[
								"a derived relation of several columns",
								"a contract field",
								"a closed id field",
								"a refined text field"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(sketch, c) =>
						Effect.sync(() => {
							const analysis = succeeded(
								Result.map(checkedIn(buildSchema(sketch, { name: "Gen" }).value), derivedAnalysis)
							)
							const owned = analysis.schema.owned
							const contracts = owned.contracts
							for (const r of analysis.order) {
								const name = r.name
								const names = Arr.map(r.heading, (col) => col.name)
								if (names.length > 1) {
									c.note("a derived relation of several columns")
								}
								for (const col of r.heading) {
									assert.deepEqual(
										col.desc,
										succeeded(fieldDescOf(col.type, contracts)),
										`${name}.${col.name}`
									)
								}
							}
							const rosters = Record.fromEntries(
								Arr.flatMap(
									Record.values(owned.relations),
									(o): ReadonlyArray<readonly [string, Arr.NonEmptyReadonlyArray<string>]> =>
										o.desc.kind === "closed" ? [[o.desc.name, o.desc.handles]] : []
								)
							)
							for (const o of Record.values(owned.relations)) {
								if (o.desc.kind !== "relation") {
									continue
								}
								for (const [fieldName, d] of Record.toEntries(o.desc.fields)) {
									if (d.kind === "contract") {
										c.note("a contract field")
									}
									if (d.kind === "closedId") {
										c.note("a closed id field")
									}
									if (d.kind === "text") {
										c.note("a refined text field")
									}
									assert.deepEqual(
										succeeded(fieldDescOf(scalarOf(d, rosters), contracts)),
										asViewColumn(d),
										`${o.desc.name}.${fieldName}`
									)
								}
							}
						})
				)
			)
	)

	it.effect("gives back the descriptor of every declarable kind", (ctx) =>
		Effect.gen(function* () {
			const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
			const contracts = checking(
				schema("L", { Line: relation("Line", { id: uuid, price: Cents }, ["id"]) }, [])
			).owned.contracts
			const rosters: Readonly<Record<string, Arr.NonEmptyReadonlyArray<string>>> = {
				Tier: ["Free", "Pro"]
			}
			const kinds: Arr.NonEmptyReadonlyArray<FieldDesc> = [
				field.smallint,
				field.integer,
				field.bigint,
				field.pg("real"),
				field.pg("double precision"),
				field.pg("money"),
				field.boolean,
				field.uuid,
				field.unconstrainedNumeric,
				field.numeric(7, 3),
				{ kind: "vector", dimensions: 4 },
				field.span(field.bigint, 7n),
				field.span(field.integer, undefined),
				field.bigserial,
				{ kind: "serial", type: "serial" },
				{ kind: "serial", type: "smallserial" },
				field.wildcard,
				field.regex("^[a-z]+$", "u"),
				field.closedId("Tier"),
				field.contract("Cents", field.bigint, undefined)
			]
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/declared-kinds",
						generator: element(kinds),
						literal: Formatter.format,
						limit: kinds.length,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(d) =>
						Effect.sync(() => {
							const back = succeeded(fieldDescOf(scalarOf(d, rosters), contracts))
							if (d.kind === "contract") {
								assert.deepEqual(back, defined(contracts["Cents"]).desc)
							} else {
								assert.deepEqual(back, asViewColumn(d))
							}
						})
				)
			)
		})
	)

	it.effect(
		"refuses a contract the schema declares on no relation, in fieldDescOf and at the derived field cast to it",
		(ctx) =>
			Effect.gen(function* () {
				const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/derived/undeclared-contract",
							generator: element<"declared" | "undeclared">(["declared", "undeclared"]),
							literal: Formatter.format,
							limit: 2,
							coverage: requiredInSpace<"declared" | "undeclared">(["declared", "undeclared"]),
							caseHang: Duration.minutes(2)
						},
						(declaration, c) =>
							Effect.sync(() => {
								c.note(declaration)
								const Line =
									declaration === "declared"
										? relation("Line", { id: uuid, amount: pg.bigint, price: Cents }, ["id"])
										: relation("Line", { id: uuid, amount: pg.bigint }, ["id"])
								const L = schema("L", { Line }, [])
								const q = query(L).rule((r) => {
									const { id, amount } = v(Line, "line")
									return r.match(Line, { id, amount }).find({
										id,
										c: Compute.when(
											Compute.nonnegative(amount),
											(a) => Compute.cast(a, Cents),
											Compute.literal(Cents, 0n)
										)
									})
								})
								const analyzed = Result.map(
									checkedIn(schema.extend(L, { T: derived("T", q) }, [])),
									derivedAnalysis
								)
								const typeOfCents = scalarOf(field.contract("Cents", field.bigint, undefined), {})
								if (declaration === "declared") {
									const a = succeeded(analyzed)
									assert.deepEqual(
										defined(
											Option.getOrUndefined(
												Arr.findFirst(defined(a.relations["T"]).heading, (col) => col.name === "c")
											)
										).desc,
										succeeded(fieldDescOf(typeOfCents, a.schema.owned.contracts))
									)
									return
								}
								assert.ok(!analyzed.ok && analyzed.error.reason._tag === "DerivedRefused")
								assert.deepEqual(analyzed.error.reason.cause, {
									kind: "undeclaredContract",
									relation: "T",
									field: "c",
									contract: "Cents"
								})
								const owned = checking(L).owned
								const out = fieldDescOf(typeOfCents, owned.contracts)
								assert.deepEqual(!out.ok && out.error, { kind: "undeclared", contract: "Cents" })
							})
					)
				)
			})
	)
})
