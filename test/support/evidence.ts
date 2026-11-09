import { Array as Arr } from "effect"
import { checkedSchema, derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { derivedKeyConstraints, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import { type Owned } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { type GenSchema, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * The evidence catalog a test compiles or analyzes against, built the production way: a fixture schema is owned once
 * (schema/own.ts), its law model compiled (laws/model) and its derived relations analyzed (analysis/derived), and
 * laws/model/catalog.ts reads the theory's keys, the views' unique indexes and the law model's containments off that
 * one parse, so every constraint is named as the installation installs it. A test never spells a constraint name:
 * where it needs one (to plant a deferrable key), it reads it off the catalog.
 *
 * The catalog of an installation's owned schema and law model: its laws' constraints and its derived relations' unique
 * indexes.
 */
export const installedCatalog = (installation: {
	readonly owned: Owned
	readonly laws: LawModel
}): EvidenceCatalog => {
	const views = Result.map(
		Result.map(checkedSchema(installation.owned), derivedAnalysis),
		derivedKeyConstraints
	)
	if (!views.ok) {
		throw new Error(`the derived analysis refuses the test's schema: ${views.error.message}`)
	}
	return evidenceCatalog({ laws: installation.laws, views: views.value })
}

/**
 * A fixture schema parsed the production way: owned, its law model compiled, its catalog built. Its one failure is the
 * fixture's defect, thrown with ownership's (or the law model's, or the derived analysis's) reason.
 */
export interface OwnedFixture {
	readonly desc: SchemaDesc
	readonly owned: Owned
	readonly laws: LawModel
	readonly catalog: EvidenceCatalog
}

/** The owned fixture of a schema description. */
export const ownedFixture = (desc: SchemaDesc): OwnedFixture => {
	const owned = ownedInput(desc)
	if (!owned.ok) {
		throw new Error(`fixture ${desc.name}: ownership refuses it: ${owned.error.message}`)
	}
	const laws = compileLaws(owned.value, everySlice(owned.value), { kind: "planned" })
	if (!laws.ok) {
		throw new Error(`fixture ${desc.name}: the law model refuses it: ${laws.error.message}`)
	}
	return {
		desc,
		owned: owned.value,
		laws: laws.value,
		catalog: installedCatalog({ owned: owned.value, laws: laws.value })
	}
}

/** A schema value the public builder made (packages/engine/src/schema/schema.ts schemaDescOf), as a fixture. */
export const ownedSchemaFixture = (schema: AnySchema): OwnedFixture => {
	const desc = schemaDescOf(schema)
	if (desc === undefined) {
		throw new Error(`fixture ${schema.name}: the schema builder recorded no description`)
	}
	return ownedFixture(desc)
}

/** The catalog of a generated schema. */
export const genCatalog = (schema: GenSchema): EvidenceCatalog =>
	ownedFixture(schemaDesc(schema)).catalog

/** The installed name of the constraint behind a declared key of a stored relation, as the catalog resolves it. */
export const keyConstraintName = (
	catalog: EvidenceCatalog,
	relation: string,
	columns: KeySet,
	role: "primary" | "candidate"
): ConstraintName => {
	const constraint = catalog.keyConstraint(relation, columns, {
		primary: role === "primary",
		derived: false
	})
	if (constraint === undefined) {
		throw new Error(
			`the catalog installs no constraint for the key (${Arr.join(columns, ", ")}) of ${relation}`
		)
	}
	return constraint.constraint
}
