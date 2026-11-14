/**
 * Field inference for derived relations: every head term carries its field descriptor (analysis/derived/fields.ts
 * fieldDescOf), so a derived relation's heading needs no restatement.
 *
 * - Declared kinds: over drawn relations of one to four fields of every declarable type (field-sketch.ts: every pg
 *   descriptor, serials among them, the numeric typmod box, refined and wildcard text, contracts over drawn bases,
 *   spans, closed ids and sets over drawn rosters, vectors), every declared field's descriptor comes back from its
 *   type unchanged. Oracle: the round trip fieldDescOf ∘ scalarOf = id. Plant: fielddesc-int2 (declaredDescOf gives
 *   an int2 column integer's descriptor). Features: each kind, and a serial form.
 * - Undeclared contracts: over drawn contracts, each declared by a relation or not, and a derived field cast to one
 *   of them, a contract no relation declares has no descriptor, fieldDescOf names it and the derived field is
 *   refused at that field (DerivedRefused, undeclaredContract); a declared one is the derived field's descriptor, as
 *   the relation declaring it holds it. Oracle: that rule, restated. Plant: fielddesc-undeclared-as-exact (a column
 *   whose contract is undeclared is refused as an exact field). Features: declared, undeclared.
 *
 * That each inferred type is PostgreSQL's own result type, for every aggregate overload, refinement, roster and
 * contract, with its typmod and collation, is the database suite's, against the installed views' catalog.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
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
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn, checking } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type SketchedField,
	fieldOf,
	fieldSketchGen,
	serialMember
} from "#test/unit/schema/field-sketch.ts"
import { bareContract, rawContract } from "#test/unit/schema/support.ts"

/** A relation of drawn fields: each roster's handle count, and its fields' types, each contract named by its field. */
interface DeclaredCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<SketchedField>
}

const handlesOf = (count: number): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Arr.map(
			upTo(count - 1, (i) => i + 1),
			(h) => `h${h}`
		),
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
	right: { kind: "literal", value: 0n }
}

const contractCaseGen: Gen<ContractCase> = (source) => {
	const contracts = source.draw(array(boolean, { min: 1, max: 3 }))
	return {
		contracts,
		declared: source.draw(subarray(upTo(contracts.length, (i) => i))),
		target: source.draw(int(0, contracts.length - 1))
	}
}

describe("derived field inference", () => {
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
								[
									...Record.values(
										Record.fromEntries(Arr.map(rosters, (r, i) => [`K${i}`, r] as const))
									),
									Line
								],
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
							const L = schema("L", [...Record.values(holders), Line], [])
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
								checkedIn(runtimeSchema.extend(L, "Level1", [runtimeDerived("T", q, [])], [], [])),
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
