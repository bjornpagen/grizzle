/**
 * Field inference for derived relations: every head term carries its field descriptor (schema/field-desc.ts
 * fieldDescOf), so a derived relation's heading needs no restatement.
 *
 * - Declared kinds: over drawn relations of one to four fields of every declarable type (field-sketch.ts: every pg
 *   descriptor, the numeric typmod box, refined and wildcard text, contracts over drawn bases,
 *   spans, closed ids and sets over drawn rosters, vectors), every declared field's descriptor comes back from its
 *   type unchanged. Oracle: the round trip fieldDescOf ∘ scalarOf = id. Features: each kind, each pg member by itself.
 *   The exact fields' round trip, an exact value of any bound among them, is test/unit/scalar/exact-fields.test.ts's.
 * - Undeclared contracts: over drawn contracts, each declared by a relation or not, and a derived field cast to one
 *   of them, a contract no relation declares has no descriptor, fieldDescOf names it and the derived field is
 *   refused at that field (DerivedRefused, undeclaredContract); a declared one is the derived field's descriptor, as
 *   the relation declaring it holds it. Oracle: that rule, restated. Features: declared, undeclared.
 *
 * - Stored kinds: over drawn search documents of every configuration, computed numeric bounds, numeric's own limits and
 *   stored instants, a stored field of each is its caller's, and its descriptor and its type each give back the other,
 *   so a records relation's field is of its column's type exactly; numeric's own limits are pg.numeric's one descriptor,
 *   and the database's instant is the database's clock's. Oracle: both round trips. Features: each kind.
 *
 * That each inferred type is PostgreSQL's own result type, for every aggregate overload, refinement, roster and
 * contract, with its typmod and collation, is the database suite's, against the installed views' catalog.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { fieldDescOf } from "#compiler/schema/field-desc.ts"
import {
	storedDerived as runtimeDerived,
	closedBuilder,
	relationBuilder
} from "#compiler/schema/relation.ts"
import { schemaBuilder as runtimeSchema } from "#compiler/schema/schema.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
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
	nonNegative,
	type StoredKind,
	storedKindGen
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
				file: "packages/engine/src/schema/field-desc.ts",
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
				file: "packages/engine/src/schema/field-desc.ts",
				original: '\t\t\treturn Result.err({ kind: "undeclared", contract: contract.name })',
				replacement:
					'\t\t\treturn Result.err({ kind: "undeclared", contract: contract.base.carrier })',
				why: "A column whose contract is undeclared is refused naming its base's carrier for the contract; the undeclared contracts' property fails."
			}
		]
	})

/** The feature a stored kind's case reaches. */
const storedFeature = (k: StoredKind): StoredFeature => {
	switch (k.kind) {
		case "search":
			return "a search document"
		case "bound":
			return "a computed numeric"
		case "own limits":
			return "numeric's own limits"
		case "stored instant":
			return "an instant stored as it is"
	}
}

type StoredFeature =
	| "a search document"
	| "a computed numeric"
	| "numeric's own limits"
	| "an instant stored as it is"

/** The field a stored kind declares. */
const storedField = (k: StoredKind): FieldBase => {
	switch (k.kind) {
		case "search":
			return pg.tsvector(k.configuration)
		case "bound":
			return pg.numeric.within(k.digits, k.scale)
		case "own limits":
			return pg.numeric
		case "stored instant":
			return instant.stored
	}
}

/**
 * A stored field of each kind a records relation keeps of a read's column is of the column's type again: its caller's,
 * and its declared descriptor fieldDescOf's of the type it states, whose type is that type, so a column a read delivers
 * and the field that stores it are of one type and one descriptor; numeric's own limits are pg.numeric's one
 * descriptor, and the database's instant, `instant`, is no caller's.
 *
 * Budget: 60 runs and 40 steered cases, every kind reached at its floor (written with the kinds, lane FIELDS-B).
 */
export const aStoredFieldOfEachKindARecordsRelationKeepsIsOfItsColumnsTypeAgainItsCallersAndOfOneDescriptor =
	property.explore(storedKindGen, {
		needs: {},
		budget: { runs: 60, steered: 40 },
		situations: [
			"a search document",
			"a computed numeric",
			"numeric's own limits",
			"an instant stored as it is"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		check: (_, c: Case<StoredFeature>) => (k) =>
			Effect.sync(() => {
				c.note(storedFeature(k))
				const Kept = relation("Kept", { id: Id, value: storedField(k) }, ["id"])
				const Clocked = relation("Clocked", { id: Id, at: instant }, ["id", "at"])
				const owned = checking(schema("K", [Kept, Clocked], [])).owned
				const kept = defined(owned.relations["Kept"], "Kept").desc
				const clocked = defined(owned.relations["Clocked"], "Clocked").desc
				assert.ok(kept.kind === "relation" && clocked.kind === "relation", "both are relations")
				const declared = defined(kept.fields["value"], "Kept.value")
				assert.equal(declared.writing.kind, "caller", "a stored field is its caller's")
				assert.equal(
					defined(clocked.fields["at"], "Clocked.at").writing.kind,
					"instant",
					"the database's instant is the database's clock's"
				)
				const type = scalarOf(declared.type, {})
				const described = succeeded(fieldDescOf(type, owned.contracts))
				assert.deepEqual(described, declared.type, "the column's type describes the field")
				assert.deepEqual(scalarOf(described, {}), type, "the descriptor types the column again")
			}),
		oracle: {
			kind: "universal",
			name: "fieldDescOf . scalarOf = id, and scalarOf . fieldDescOf = id, on each stored kind"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t\t? { kind: "pg", type: "numeric" }\n\t\t: { kind: "computedNumeric", bound }',
				replacement:
					'\t\t? { kind: "computedNumeric", bound }\n\t\t: { kind: "computedNumeric", bound }',
				why: "numeric's own limits have two descriptors, pg.numeric's and a computed numeric's: a column of pg.numeric is described as no field of it is."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: "\t\t\treturn Result.ok(numericOfBound(desc.bound))",
				replacement: "\t\t\treturn Result.ok(numericOwnLimits)",
				why: "A computed numeric's field is typed at numeric's own limits, so it no longer holds its column's type."
			},
			{
				file: "packages/engine/src/public/fields.ts",
				original: "export const instant: InstantField = clockInstant(instantDescriptor)",
				replacement: "export const instant: InstantField = instantDescriptor",
				why: "The database's instant is declared as its caller's field, the stored copy's writing: one writing for two kinds."
			}
		]
	})
