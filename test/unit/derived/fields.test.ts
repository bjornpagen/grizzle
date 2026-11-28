/**
 * Field inference for derived relations: every head term carries its field descriptor (schema/field-desc.ts
 * fieldDescOf), so a derived relation's heading needs no restatement.
 *
 * - Declared kinds: over drawn relations of one to four fields of every declarable type (field-sketch.ts: every pg
 *   descriptor, the numeric typmod box, refined and wildcard text, contracts over drawn bases,
 *   spans, closed ids and sets over drawn rosters, vectors), every declared field's descriptor comes back from its
 *   type unchanged. Oracle: the round trip fieldDescOf ∘ scalarOf = id. Features: each kind, each pg member by itself.
 *   The exact fields' round trip, an exact value of any bound among them, is test/unit/scalar/exact-fields.test.ts's.
 * - Cast contracts: over drawn contracts, each declared by a relation or not, and a derived field cast to one of them
 *   under the key its module holds (a cast into a consumer's contract takes its key since 97c8891645, BRAND's, so a
 *   keyless cast is refused before the field is typed), the contract is the schema's either way, a relation's field or the definition's cast declaring it (schema/own.ts
 *   #collectFields, schema/walk.ts queryUses `contracts`), so the derived field's descriptor is the contract's as
 *   declared and fieldDescOf finds it, where a contract only a definition's cast named was refused at the field
 *   (DerivedRefused, undeclared: edullm's LastPresence, cast to LastBeacon). Oracle: that rule, restated.
 *   Features: by a relation, by the cast alone.
 * - Variants: a variant column a derived relation's heading holds, in its definition's head or in the head of a query
 *   it imports, is the schema's declaration of the variant, its arms' checks with it, the descriptor the relation
 *   holding the column declares, where the heading held a variant rebuilt from the column's type, of no check (the
 *   loss records of metis's essay flow met over qti-pie's QtiValue, refused DuplicateIdentity). Oracle: ownership's
 *   variant (own.ts Owned variants). The box is exhausted.
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
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record } from "effect"
import { instant, pg, variant } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { fieldDescOf, ownedDeclarations } from "#compiler/schema/field-desc.ts"
import {
	derivedBuilder as runtimeDerived,
	closedBuilder,
	relationBuilder
} from "#compiler/schema/relation.ts"
import { schemaBuilder as runtimeSchema } from "#compiler/schema/schema.ts"
import type { ArmChecks, FieldBase } from "#compiler/types/fields/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { analysesOf } from "#test/support/derived.ts"
import { f as field } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { Id } from "#test/support/ids.ts"
import { checkedIn, checking } from "#test/support/policy.ts"
import {
	type CastSite,
	contractCaseGen,
	type DeclaredFeature,
	declaredGen,
	handlesOf,
	nonNegative,
	type StoredKind,
	storedKindGen,
	type VariantCase,
	variantCaseGen
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
						succeeded(fieldDescOf(scalarOf(declared, handles), ownedDeclarations(owned))),
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

/** Where a contract's declaration comes from, and where the cast stands. */
type ContractFeature = "by a relation" | "by the cast alone" | CastSite

/**
 * A contract a derived field is cast to is the schema's, whether a relation's field or the definition's cast alone
 * declares it, and the derived field's descriptor is the contract's as declared.
 *
 * Budget: 40 runs and 40 steered cases, what its suite stated before it became a property
 * (test/unit/derived/fields.test.ts:186 at 8cad5bce, its runs and its coverage's cases).
 */
export const aContractADerivedFieldIsCastToIsTheSchemasWhetherARelationOrTheCastAloneDeclaresItAndIsTheFieldsDescriptor =
	property.explore(contractCaseGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"by a relation",
			"by the cast alone",
			"head",
			"max",
			"import"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check: (_, c: Case<ContractFeature>) => (k) =>
			Effect.sync(() => {
				const contracts = Arr.map(k.contracts, (checked, i) =>
					checked
						? rawContract(`Cents${i}`, pg.bigint, nonNegative)
						: bareContract(`Cents${i}`, pg.bigint)
				)
				const target = defined(contracts[k.target], "the target contract")
				/** The key the target's module holds, which a cast into a consumer's contract takes (scalar/contract.ts
				 * admitMintKey, since 97c8891645). */
				const key = Symbol(`Cents${k.target}`)
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
				/** The line's amount cast to the target contract under its key where it is no negative, else the contract's
				 * zero. */
				const cast = (amount: unknown): unknown =>
					computeCore.when(
						computeCore.nonnegative(amount),
						(a: unknown) => computeCore.cast(a, target, key),
						computeCore.literal(target, 0n)
					)
				/** Each line with its cast amount. */
				const lines = queryOver(L).rule((r: RuleValue) => {
					const vars = varsOver(Line, "line")
					return r
						.match(Line, { id: vars["id"], amount: vars["amount"] })
						.find({ id: vars["id"], c: cast(vars["amount"]) })
				})
				const q =
					k.site === "head"
						? lines
						: k.site === "max"
							? queryOver(L).rule((r: RuleValue) => {
									const vars = varsOver(Line, "line")
									return r
										.match(Line, { id: vars["id"], amount: vars["amount"] })
										.find({ c: r.max(cast(vars["amount"])) })
								})
							: queryOver(L).rule((r: RuleValue) => {
									const vars = varsOver(lines, "cast")
									return r
										.match(lines, { id: vars["id"], c: vars["c"] })
										.find({ id: vars["id"], c: vars["c"] })
								})
				c.note(k.site)
				const extended = runtimeSchema.extend([L], "Level1", [runtimeDerived("T", q, [])], [], [])
				const a = succeeded(Result.flatMap(checkedIn(extended), analysesOf))
				const owned = checking(extended).owned
				const name = `Cents${k.target}`
				const declared = defined(owned.contracts[name], `the schema's contract ${name}`)
				c.note(
					owned.relations[`Holder${k.target}`] === undefined ? "by the cast alone" : "by a relation"
				)
				const desc = defined(
					Option.getOrUndefined(
						Arr.findFirst(defined(a.relations["T"]).heading, (col) => col.name === "c")
					)
				).desc
				assert.deepEqual(desc, declared.desc)
				const typeOf = scalarOf(field.contract(name, field.bigint, undefined), {})
				assert.deepEqual(succeeded(fieldDescOf(typeOf, ownedDeclarations(owned))), declared.desc)
			}),
		oracle: {
			kind: "specification",
			name: "a contract a relation's field or a derived definition's cast types a value by is the schema's, and the derived field's descriptor is it as declared"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/derived/fields.test.ts#aContractADerivedFieldIsCastToIsTheSchemasWhetherARelationOrTheCastAloneDeclaresItAndIsTheFieldsDescriptor:-:1.0.0.2"
				),
				reason:
					"A contract only a cast in the head of a query the definition imports names: the ledger's PresentTime, its pieces cast to PieceStart in its import, whose canonical relation was live, its field refused as a contract the schema declares nowhere",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\tfor (const d of queryUses(entry.desc.query).contracts) {",
				replacement:
					"\t\t\t\tfor (const d of queryUses(entry.desc.query).contracts.filter(() => false)) {",
				why: "A contract only a derived definition's cast names is the schema's no longer: the derived field cast to it is refused undeclared, and the cast-alone situation fails."
			},
			{
				file: "packages/engine/src/schema/walk.ts",
				original: '\t\t\tif (d.kind === "contract") {\n\t\t\t\tthis.contracts.push(d)',
				replacement: '\t\t\tif (d.kind === "bits") {\n\t\t\t\tthis.contracts.push(d)',
				why: "A query's casts and typed literals type no value by a contract any more (schema/walk.ts queryUses): the cast-alone situation's contract is undeclared, and the property fails."
			},
			{
				file: "packages/engine/src/schema/walk.ts",
				original: "\t\tfor (const d of inner.contracts) {\n\t\t\tthis.contracts.push(d)\n\t\t}\n",
				replacement: "",
				why: "A query's imports type no value by a contract for the query that imports them: a cast in an imported query's head names a contract the schema declares nowhere, and the import site fails, as the ledger's PresentTime was refused."
			}
		]
	})

/**
 * A variant column a derived relation's heading holds is the schema's declaration of the variant, its arms' checks
 * with it, the descriptor the relation holding the column declares, whichever of its arms state their checks and
 * whether the definition's head finds the column or the head of a query it imports does.
 */
export const aVariantColumnADerivedHeadingHoldsIsTheSchemasDeclarationOfTheVariantItsArmsChecksWithIt =
	property.exhaust(finite(variantCaseGen), {
		box: "a variant of two arms of two fields, each arm stating the check that orders them or not, found in the definition's head or in the head of a query it imports",
		needs: {},
		situations: [],
		check: () => (k: VariantCase) =>
			Effect.sync(() => {
				const Side = closed.unordered("Side", ["least", "most"])
				const [leastChecked, mostChecked] = k.checks
				const arms = {
					least: { low: pg.integer, high: pg.integer },
					most: { from: pg.integer, to: pg.integer }
				}
				/** Each arm's check, which orders its two fields. */
				const orders = {
					least: (a) => a.le(a.low, a.high),
					most: (a) => a.le(a.from, a.to)
				} satisfies ArmChecks<"Mark", typeof arms>
				const Mark = variant("Mark", Side, arms, {
					...(leastChecked ? { least: orders.least } : {}),
					...(mostChecked ? { most: orders.most } : {})
				})
				const Unit = relation("Unit", { id: Id, mark: Mark }, ["id"])
				const L = schema("L", [Side, Unit], [])
				/** Each unit with its mark. */
				const marks = queryOver(L).rule((r: RuleValue) => {
					const vars = varsOver(Unit, "unit")
					return r
						.match(Unit, { id: vars["id"], mark: vars["mark"] })
						.find({ id: vars["id"], mark: vars["mark"] })
				})
				const q =
					k.site === "head"
						? marks
						: queryOver(L).rule((r: RuleValue) => {
								const vars = varsOver(marks, "marked")
								return r
									.match(marks, { id: vars["id"], mark: vars["mark"] })
									.find({ id: vars["id"], mark: vars["mark"] })
							})
				const extended = runtimeSchema.extend([L], "Level1", [runtimeDerived("T", q, [])], [], [])
				const a = succeeded(Result.flatMap(checkedIn(extended), analysesOf))
				const declared = defined(
					checking(extended).owned.variants["Mark"],
					"the schema's variant Mark"
				).desc
				assert.deepEqual(
					Arr.map(declared.arms, (arm) => arm.check !== undefined),
					[leastChecked, mostChecked],
					"Mark's declaration holds the checks its arms state"
				)
				const desc = defined(
					Option.getOrUndefined(
						Arr.findFirst(defined(a.relations["T"]).heading, (col) => col.name === "mark")
					)
				).desc
				assert.deepEqual(desc, declared, `${k.site}: T.mark is Mark as the schema declares it`)
			}),
		oracle: {
			kind: "specification",
			name: "ownership's variant (own.ts Owned variants), the declaration the relation holding the column states"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/field-desc.ts",
				original:
					'\t\tcase "variant":\n\t\t\treturn declaration("variant", type.variant.name, declared.variant(type.variant.name))',
				replacement:
					'\t\tcase "variant": {\n\t\t\tconst found = declared.variant(type.variant.name)\n\t\t\treturn declaration("variant", type.variant.name, found && { ...found, arms: found.arms.map((arm) => ({ ...arm, check: undefined })) })\n\t\t}',
				why: "A derived heading's variant column is a variant rebuilt from the column's type with no arm's check: T.mark is no longer Mark as the schema declares it wherever an arm states its check, at either site."
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
				const described = succeeded(fieldDescOf(type, ownedDeclarations(owned)))
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
