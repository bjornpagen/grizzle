import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import * as Result from "#compiler/core/result.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { materializedDerived as runtimeDerived } from "#compiler/schema/relation.ts"
import { schema as runtimeSchema } from "#compiler/schema/schema.ts"
import { buildSchema, caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn, checking } from "#test/support/policy.ts"
import {
	type SketchedField,
	fieldOf,
	fieldSketchGen,
	serialMember
} from "#test/unit/schema/field-sketch.ts"
import { bareContract, rawContract } from "#test/unit/schema/support.ts"

/** A declared field's descriptor as a view column carries it: a serial as its plain width.
 *
 * Field inference for derived relations: every head term carries its descriptor, so a
 * derived relation's heading needs no restatement.
 *
 * - Over the derived oracle's generated schemas (every base kind, contracts, rosters, refined text, drawn aggregates
 *   and levels): each derived relation's fields are keyed in its heading's order, each the descriptor
 *   fieldDescOf gives its column's type; and every declared field's descriptor comes back from its type unchanged:
 *   a serial field's type is its integer's, so a view column over one is that integer, never an identity.
 * - Over drawn relations of one to four fields of every declarable type (field-sketch.ts: every pg descriptor, the
 *   numeric typmod box, refined and wildcard text, contracts over drawn bases, spans, closed ids and sets over drawn
 *   rosters, vectors), every declared field's descriptor comes back from its type unchanged.
 * - Over drawn contracts, each declared by a relation or not, and a derived field cast to one of them: a contract no
 *   relation declares has no descriptor, fieldDescOf names it and the derived field is refused at that field; a
 *   declared one is the derived field's descriptor, as the relation declaring it holds it.
 *
 * That each inferred type is PostgreSQL's own result type, for every aggregate overload, refinement, roster and
 * contract, with its typmod and collation, is the database suite's, against the installed views' catalog. */
type FieldFeature =
	| "a derived relation of several columns"
	| "a contract field"
	| "a closed id field"
	| "a refined text field"

/** A relation of drawn fields: each roster's handle count, and its fields' types, each contract named by its field. */
interface DeclaredCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<SketchedField>
}

const handlesOf = (count: number): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Arr.map(Arr.range(1, count - 1), (h) => `h${h}`),
		"h0"
	)

const declaredGen: Gen<DeclaredCase> = (source) => {
	const rosters = nonEmpty(source.draw(array(int(1, 3), { min: 1, max: 2 })), "the rosters")
	const fields = nonEmpty(
		source.draw(array(fieldSketchGen(rosters.length, constant("C")), { min: 1, max: 4 })),
		"the fields"
	)
	return {
		rosters,
		fields: Arr.map(fields, (f, i): SketchedField =>
			f.kind === "contract" ? { ...f, name: `C${i}` } : f
		)
	}
}

type DeclaredFeature = `kind ${SketchedField["kind"]}` | "a serial form"

/** Contracts over bigint, each checked or not, the ones a relation declares, and the one a derived field is cast to. */
interface ContractCase {
	readonly contracts: ReadonlyArray<boolean>
	readonly declared: ReadonlyArray<number>
	readonly target: number
}

/** A contract predicate VALUE >= 0, as Compute's ge records it. */
const nonNegative: OpenExpr = {
	kind: "compare",
	op: "ge",
	left: { kind: "value" },
	right: { kind: "literal", value: 0n, type: undefined }
}

const contractCaseGen: Gen<ContractCase> = (source) => {
	const contracts = source.draw(array(boolean, { min: 1, max: 3 }))
	return {
		contracts,
		declared: source.draw(subarray(Arr.range(0, contracts.length - 1))),
		target: source.draw(int(0, contracts.length - 1))
	}
}

describe("derived field inference", () => {
	it.effect(
		"keys each derived relation's fields in heading order with fieldDescOf's descriptors, and gives every declared descriptor back",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
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
						caseHang
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
								for (const [fieldName, { type: d }] of Record.toEntries(o.desc.fields)) {
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
										d,
										`${o.desc.name}.${fieldName}`
									)
								}
							}
						})
				)
			)
	)

	it.effect("gives back the descriptor of every declarable field type", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/derived/declared-kinds",
					draw: drawn(declaredGen),
					literal: Formatter.format,
					oracle: {
						kind: "universal",
						name: "fieldDescOf . scalarOf = id on every declared field's descriptor"
					},
					coverage: required<DeclaredFeature>(
						[
							"kind pg",
							"kind numeric",
							"kind uuid",
							"kind text",
							"kind contract",
							"kind span",
							"kind closedId",
							"kind bits",
							"kind vector",
							"a serial form"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(d, c) =>
					Effect.sync(() => {
						const rosters = Arr.map(d.rosters, (count, i) => closed(`K${i}`, handlesOf(count)))
						const Line = relation(
							"Line",
							{
								id: uuid,
								...Record.fromEntries(
									Arr.map(d.fields, (f, i) => [`f${i}`, fieldOf(f, rosters)] as const)
								)
							},
							["id"]
						)
						const owned = checking(
							schema(
								"L",
								{ ...Record.fromEntries(Arr.map(rosters, (r, i) => [`K${i}`, r] as const)), Line },
								[]
							)
						).owned
						const handles = Record.fromEntries(
							Arr.map(d.rosters, (count, i) => [`K${i}`, handlesOf(count)] as const)
						)
						const line = defined(owned.relations["Line"], "Line").desc
						assert.ok(line.kind === "relation", "Line is a relation")
						for (const [i, sketch] of d.fields.entries()) {
							c.note(`kind ${sketch.kind}`)
							if (sketch.kind === "pg" && serialMember(sketch.member)) {
								c.note("a serial form")
							}
							const declared = defined(line.fields[`f${i}`], `Line.f${i}`).type
							assert.deepEqual(
								succeeded(fieldDescOf(scalarOf(declared, handles), owned.contracts)),
								declared,
								`Line.f${i}`
							)
						}
					})
			)
		)
	)

	it.effect(
		"refuses a contract the schema declares on no relation, in fieldDescOf and at the derived field cast to it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/undeclared-contract",
						draw: drawn(contractCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a contract no relation declares has no descriptor; one a relation declares is the derived field's"
						},
						coverage: required<"declared" | "undeclared">(["declared", "undeclared"], {
							cases: 40,
							sense: notesOnly
						}),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const contracts = Arr.map(k.contracts, (checked, i) =>
								checked
									? rawContract(`Cents${i}`, pg.bigint, nonNegative)
									: bareContract(`Cents${i}`, pg.bigint)
							)
							const target = defined(contracts[k.target], "the target contract")
							const holders = Record.fromEntries(
								Arr.flatMap(contracts, (cents, i) =>
									Arr.contains(k.declared, i)
										? [
												[
													`Holder${i}`,
													relation(`Holder${i}`, { id: uuid, price: cents }, ["id"])
												] as const
											]
										: []
								)
							)
							const Line = relation("Line", { id: uuid, amount: pg.bigint }, ["id"])
							const L = schema("L", { ...holders, Line }, [])
							const q = queryOver(L).rule((r: RuleValue) => {
								const vars = varsOver(Line, "line")
								return r.match(Line, { id: vars["id"], amount: vars["amount"] }).find({
									id: vars["id"],
									c: computeCore.when(
										computeCore.nonnegative(vars["amount"]),
										(a: unknown) => computeCore.cast(a, target),
										computeCore.literal(target, 0n)
									)
								})
							})
							const analyzed = Result.map(
								checkedIn(runtimeSchema.extend(L, { T: runtimeDerived("T", q, []) }, [], [])),
								derivedAnalysis
							)
							const owned = checking(L).owned
							const holder = owned.relations[`Holder${k.target}`]
							if (holder !== undefined) {
								c.note("declared")
								assert.ok(holder.desc.kind === "relation", "a holder is a relation")
								const declared = defined(holder.desc.fields["price"], "the holder's price").type
								const a = succeeded(analyzed)
								assert.deepEqual(
									defined(
										Option.getOrUndefined(
											Arr.findFirst(defined(a.relations["T"]).heading, (col) => col.name === "c")
										)
									).desc,
									declared
								)
								return
							}
							c.note("undeclared")
							assert.ok(!analyzed.ok && analyzed.error.reason._tag === "DerivedRefused")
							assert.deepEqual(analyzed.error.reason.cause, {
								kind: "undeclaredContract",
								relation: "T",
								field: "c",
								contract: `Cents${k.target}`
							})
							const typeOf = scalarOf(
								field.contract(`Cents${k.target}`, field.bigint, undefined),
								{}
							)
							const out = fieldDescOf(typeOf, owned.contracts)
							assert.deepEqual(!out.ok && out.error, {
								kind: "undeclared",
								contract: `Cents${k.target}`
							})
						})
				)
			)
	)
})
