/**
 * Field inference for derived relations: every head term carries its field descriptor (analysis/derived/fields.ts
 * fieldDescOf), so a derived relation's heading needs no restatement.
 *
 * - Declared kinds: over drawn relations of one to four fields of every declarable type (field-sketch.ts: every pg
 *   descriptor, the numeric typmod box, refined and wildcard text, contracts over drawn bases,
 *   spans, closed ids and sets over drawn rosters, vectors), every declared field's descriptor comes back from its
 *   type unchanged. Oracle: the round trip fieldDescOf ∘ scalarOf = id. Features: each kind, each pg member by itself.
 * - Undeclared contracts: over drawn contracts, each declared by a relation or not, and a derived field cast to one
 *   of them, a contract no relation declares has no descriptor, fieldDescOf names it and the derived field is
 *   refused at that field (DerivedRefused, undeclaredContract); a declared one is the derived field's descriptor, as
 *   the relation declaring it holds it. Oracle: that rule, restated. Features: declared, undeclared.
 *
 * That each inferred type is PostgreSQL's own result type, for every aggregate overload, refinement, roster and
 * contract, with its typmod and collation, is the database suite's, against the installed views' catalog.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record } from "effect"
import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	materializedDerived as runtimeDerived,
	closedBuilder,
	relationBuilder
} from "#compiler/schema/relation.ts"
import { schemaBuilder as runtimeSchema } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { Id } from "#test/support/ids.ts"
import { checkedIn, checking } from "#test/support/policy.ts"
import {
	contractCaseGen,
	type DeclaredFeature,
	declaredGen,
	handlesOf,
	nonNegative
} from "#test/unit/derived/fields.fixtures.ts"
import { fieldOf } from "#test/unit/schema/field-sketch.ts"
import { bareContract, rawContract } from "#test/unit/schema/support.ts"

/**
 * Derived field inference gives back the descriptor of every declarable field type.
 *
 * Budget: 100 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/derived/fields.test.ts:106 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedFieldInferenceGivesBackTheDescriptorOfEveryDeclarableFieldType =
	property.explore(declaredGen, {
		needs: {},
		budget: { runs: 100, steered: 200 },
		situations: [
			"pg smallint",
			"pg integer",
			"pg bigint",
			"pg real",
			"pg double precision",
			"pg money",
			"pg boolean",
			"kind numeric",
			"kind uuid",
			"kind text",
			"kind contract",
			"kind span",
			"kind closedId",
			"kind bits",
			"kind vector"
		] satisfies ReadonlyArray<Reached<DeclaredFeature>>,
		check: (_, c: Case<DeclaredFeature>) => (d) =>
			Effect.sync(() => {
				const rosters = Arr.map(d.rosters, (count, i) =>
					closedBuilder(`K${i}`, handlesOf(count), "ordered", [])
				)
				const Line = relation(
					"Line",
					{
						id: Id,
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
					c.note(sketch.kind === "pg" ? `pg ${sketch.member}` : `kind ${sketch.kind}`)
					const declared = defined(line.fields[`f${i}`], `Line.f${i}`).type
					assert.deepEqual(
						succeeded(fieldDescOf(scalarOf(declared, handles), owned.contracts)),
						declared,
						`Line.f${i}`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "fieldDescOf . scalarOf = id on every declared field's descriptor"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/fields.ts",
				original: '\t\t\treturn Result.ok({ kind: "pg", type: "smallint" })',
				replacement: '\t\t\treturn Result.ok({ kind: "pg", type: "integer" })',
				why: "declaredDescOf gives an int2 column integer's descriptor; the declared kinds' round trip fails."
			}
		]
	})

/**
 * Derived field inference refuses a contract the schema declares on no relation, in fieldDescOf and at the derived
 * field cast to it.
 *
 * Budget: 40 runs and 40 steered cases, what its suite stated before it became a property
 * (test/unit/derived/fields.test.ts:186 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedFieldInferenceRefusesAContractTheSchemaDeclaresOnNoRelationInFieldDescOfAndAtTheDerivedFieldCastToIt =
	property.explore(contractCaseGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: ["declared", "undeclared"] satisfies ReadonlyArray<
			Reached<"declared" | "undeclared">
		>,
		check: (_, c: Case<"declared" | "undeclared">) => (k) =>
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
										relationBuilder(`Holder${i}`, { id: Id, price: cents }, ["id"], [])
									] as const
								]
							: []
					)
				)
				const Line = relation("Line", { id: Id, amount: pg.bigint }, ["id"])
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
					checkedIn(runtimeSchema.extend([L], "Level1", [runtimeDerived("T", q, [])], [], [])),
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
				const typeOf = scalarOf(field.contract(`Cents${k.target}`, field.bigint, undefined), {})
				const out = fieldDescOf(typeOf, owned.contracts)
				assert.deepEqual(!out.ok && out.error, {
					kind: "undeclared",
					contract: `Cents${k.target}`
				})
			}),
		oracle: {
			kind: "specification",
			name: "a contract no relation declares has no descriptor; one a relation declares is the derived field's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/fields.ts",
				original: '\t\t\treturn Result.err({ kind: "undeclared", contract: contract.name })',
				replacement: '\t\t\treturn Result.err({ kind: "exact", type: contract.name })',
				why: "A column whose contract is undeclared is refused as an exact field; the undeclared contracts' property fails."
			}
		]
	})
