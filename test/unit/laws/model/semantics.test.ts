import { describe, it } from "@effect/vitest"
import { exhaust, explore, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { caseHang } from "#test/support/limits.ts"
/**
 * What the generated records mean, evaluated by the brute-force reference evaluator (test/support/oracle): a generated
 * CHECK accepts exactly the rows the law it replaces holds on, exhaustively over every shape that generates one and
 * every integer or numeric carrier its literals meet. And a schema of closed relations states no law: it installs no
 * native object, residual law or constraint.
 *
 * Both laws are row-local, so a one-row state is the contract: the CHECK accepts the row exactly when the
 * law's violation query names nothing.
 *
 * Closed relations are immutable finite facts with no key law of their own, so a schema of closed relations only,
 * with or without payload, none at all included, has nothing to check.
 */

import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	capacity,
	closed,
	closedWith,
	contained,
	eq,
	f,
	field,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"

import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { owning } from "#test/support/policy.ts"
import { genFactsOf, genSchemaOf, type HostFacts } from "#test/unit/analysis/logical/support.ts"
import { modelOf, schemaOf } from "#test/unit/laws/model/support.ts"

const filterOf = (dag: RelDag, predicate: ScalarExpr): RelNode =>
	Option.getOrThrowWith(
		Arr.findFirst(topoOrder(dag), (n) => n.kind === "Filter" && n.pred === predicate),
		() => new Error("the generated check's Filter")
	)

const evaluate = (m: LawModel, node: RelNode, facts: HostFacts) =>
	Reference.of(m.theory.dag, {
		schema: genSchemaOf(m.theory),
		facts: genFactsOf(m.theory, facts),
		params: {},
		observer: unobserved
	}).eval(node, noBindings).rows

/**
 * The integer and numeric carriers a generated CHECK's literal meets, and the shapes that generate one: a
 * self-capacity's field weight or count against its bounds, a selected source into closed facts by a payload field or by
 * a selector field, and a self-capacity over a span's width, an exact integer, whose literal is a bigint.
 */
type Carrier = "int2" | "int4" | "int8" | "numeric(10,2)"
type CheckCase =
	| {
			readonly shape: "field weight" | "count" | "closed payload" | "closed selector"
			readonly carrier: Carrier
	  }
	| { readonly shape: "span width"; readonly carrier: "int4" | "int8" }

type CheckFeature =
	| `shape ${CheckCase["shape"]}`
	| `carrier ${Carrier}`
	| "accepted row"
	| "refused row"

const carriers: Arr.NonEmptyReadonlyArray<Carrier> = ["int2", "int4", "int8", "numeric(10,2)"]
const carrierShapes = ["field weight", "count", "closed payload", "closed selector"] as const
const space: Gen<CheckCase> = oneOf([
	map(
		(source) => [source.draw(element(carrierShapes)), source.draw(element(carriers))] as const,
		([shape, carrier]): CheckCase => ({
			shape,
			carrier
		})
	),
	map(element<"int4" | "int8">(["int4", "int8"]), (carrier): CheckCase => ({
		shape: "span width",
		carrier
	}))
])

const situations: Arr.NonEmptyReadonlyArray<CheckFeature> = [
	"shape field weight",
	"shape count",
	"shape closed payload",
	"shape closed selector",
	"shape span width",
	"carrier int2",
	"carrier int4",
	"carrier int8",
	"carrier numeric(10,2)",
	"accepted row",
	"refused row"
]

const fieldOf = (carrier: Carrier): FieldDesc => {
	switch (carrier) {
		case "int2":
			return f.smallint
		case "int4":
			return f.integer
		case "int8":
			return f.bigint
		case "numeric(10,2)":
			return f.numeric(10, 2)
	}
}

/**
 * An integer in the host convention of the carrier: a JavaScript number for smallint and integer, a bigint otherwise.
 */
const hostInt = (carrier: Carrier, n: number): number | bigint =>
	carrier === "int2" || carrier === "int4" ? n : BigInt(n)

/** A case's schema, the relation its CHECK is on, and the rows it is checked on, each with a distinct key. */
interface CheckSchema {
	readonly desc: SchemaDesc
	readonly table: string
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
}

const tier = (budget: FieldDesc, of: (n: number) => number | bigint) =>
	closedWith(
		"Tier",
		["Free", "Pro"],
		{ budget },
		{ Free: { budget: of(100) }, Pro: { budget: of(1000) } }
	)

const checkSchema = (k: CheckCase): CheckSchema => {
	const c = fieldOf(k.carrier)
	const at = (n: number) => hostInt(k.carrier, n)
	switch (k.shape) {
		case "field weight":
			return {
				desc: schemaOf(
					[relation("T", { id: f.integer, n: c, m: c }, ["id"])],
					[
						capacity(on("T", ["id"]), on("T", ["id"]), within(0n, "m"), {
							kind: "field",
							field: "n"
						})
					],
					"Laws"
				),
				table: "T",
				rows: Arr.map(
					Arr.flatMap([-1, 0, 2], (n) => Arr.map([0, 2], (m) => ({ n: at(n), m: at(m) }))),
					(r, i) => ({ id: i + 1, ...r })
				)
			}
		case "count":
			return {
				desc: schemaOf(
					[relation("T", { id: f.integer, m: c }, ["id"])],
					[capacity(on("T", ["id"]), on("T", ["id"]), within(0n, "m"), { kind: "count" })],
					"Laws"
				),
				table: "T",
				rows: Arr.map([0, 1, 2], (m, i) => ({ id: i + 1, m: at(m) }))
			}
		case "closed payload":
			return {
				desc: schemaOf(
					[
						tier(c, at),
						relation("Sub", { account: f.integer, budget: c, paid: f.boolean }, ["account"])
					],
					[
						contained(
							onWhere("Sub", ["budget"], eq(field("paid"), literal(true))),
							on("Tier", ["budget"])
						)
					],
					"Laws"
				),
				table: "Sub",
				rows: Arr.map(
					Arr.flatMap([7, 100], (budget) =>
						Arr.map([false, true], (paid) => ({ budget: at(budget), paid }))
					),
					(r, i) => ({ account: i + 1, ...r })
				)
			}
		case "closed selector":
			return {
				desc: schemaOf(
					[
						tier(f.bigint, BigInt),
						relation("Sub", { account: f.integer, budget: f.bigint, level: c }, ["account"])
					],
					[
						contained(
							onWhere("Sub", ["budget"], eq(field("level"), literal(at(1)))),
							on("Tier", ["budget"])
						)
					],
					"Laws"
				),
				table: "Sub",
				rows: Arr.map(
					Arr.flatMap([7n, 100n], (budget) =>
						Arr.map([0, 1], (level) => ({ budget, level: at(level) }))
					),
					(r, i) => ({ account: i + 1, ...r })
				)
			}
		case "span width":
			return {
				desc: schemaOf(
					[relation("T", { id: f.integer, during: f.span(c, undefined) }, ["id"])],
					[
						capacity(on("T", ["id"]), on("T", ["id"]), within(0n, 3n), {
							kind: "duration",
							field: "during"
						})
					],
					"Laws"
				),
				table: "T",
				rows: Arr.map([2, 3, 5], (w, i) => ({
					id: i + 1,
					during: { span: { start: at(0), end: at(w) } }
				}))
			}
	}
}

describe("generated CHECKs accept exactly the lawful rows", () => {
	it.effect(
		"over every generated-CHECK shape and every carrier its literal meets, the CHECK accepts a row iff the law holds on it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/generated-checks",
						generator: space,
						literal: Formatter.format,
						/**
						 * The space's exact size, 4 shapes × 4 carriers + 2 span endpoints: a space grown unnoticed is over-limit.
						 */
						limit: 18,
						coverage: requiredInSpace<CheckFeature>(situations),
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const { desc, table, rows } = checkSchema(k)
							/** The law model compiles the case: a refusal here is a CHECK literal its carrier does not hold. */
							const m = modelOf(desc)
							const checks = Arr.flatMap(m.natives, (n) =>
								n.object.kind === "TableCheck" ? [n.object] : []
							)
							assert.equal(checks.length, 1, "the law's one generated CHECK")
							const check = defined(checks[0], "the generated CHECK")
							const law = Option.getOrThrowWith(
								Arr.findFirst(m.theory.laws, (l) => l.id === check.lawIds[0]),
								() => new Error("the law the CHECK discharges")
							)
							const forbid = law.violation
							if (forbid.kind !== "Forbid") {
								return assert.fail(`the Forbid of ${law.id}`)
							}
							const filter = filterOf(m.theory.dag, check.predicate)
							for (const [i, row] of rows.entries()) {
								const state = { [table]: [row] }
								const accepted = evaluate(m, filter, state).length === 1
								const violated = evaluate(m, forbid.violation, state).length > 0
								assert.equal(accepted, !violated, `row ${i + 1} of ${k.shape} over ${k.carrier}`)
								c.note(accepted ? "accepted row" : "refused row")
							}
							c.note(`shape ${k.shape}`)
							c.note(`carrier ${k.carrier}`)
						})
				)
			)
	)
})

/** A closed relation's payload: none, or one value per handle. */
type Payload =
	| { readonly kind: "none" }
	| { readonly kind: "values"; readonly values: ReadonlyArray<bigint> }

describe("a schema that states no law", () => {
	it.effect("compiles closed relations only to the empty law model, and installs", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/laws/model/no-law",
					draw: sketched(
						array(
							(source) => ({
								handles: source.draw(int(1, 3)),
								payload: source.draw(
									oneOf([
										constant<Payload>({ kind: "none" }),
										map(array(bigint(-5n, 5n), { min: 3, max: 3 }), (values): Payload => ({
											kind: "values",
											values
										}))
									])
								)
							}),
							{ min: 0, max: 3 }
						),
						(rosters) =>
							schemaOf(
								Arr.map(rosters, (r, i) => {
									const handles = ["Low", "Mid", "High"].slice(0, r.handles)
									const name = defined(["Tier", "Rate", "Plan"][i], "a roster's name")
									const payload = r.payload
									return payload.kind === "none"
										? closed(name, handles)
										: closedWith(
												name,
												handles,
												{ n: f.bigint },
												Rec.fromEntries(
													Arr.map(handles, (h, j) => [
														h,
														{ n: defined(payload.values[j], "a fact's value") }
													])
												)
											)
								}),
								[],
								"Laws"
							)
					),
					literal: Formatter.format,
					coverage: required<"no relation" | "handles only" | "payload">(
						["no relation", "handles only", "payload"],
						{ cases: 30, sense: notesOnly }
					),
					kept: [],
					runs: 30,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(desc, n) =>
					Effect.sync(() => {
						if (desc.relations.length === 0) {
							n.note("no relation")
						}
						for (const r of desc.relations) {
							n.note(
								r.kind === "closed" && Rec.keys(r.payload).length > 0 ? "payload" : "handles only"
							)
						}
						const m = modelOf(desc)
						assert.deepEqual(
							[m.theory.laws, m.natives, m.residuals, m.constraints],
							[[], [], [], []]
						)
						const owned = owning(desc)
						succeeded(compileInstallation(owned, installOptions(owned, "owner")))
					})
			)
		)
	)
})
