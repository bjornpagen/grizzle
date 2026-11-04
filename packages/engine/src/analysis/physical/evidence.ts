import { sameMembers } from "#compiler/core/array.ts"
import type { ConstraintName, PremiseObject } from "#compiler/core/ids.ts"
import {
	type ConstraintKind,
	contextAdmits,
	type EvidenceCatalog,
	type EvidenceContext,
	type ExistenceConstraint,
	type Grounds,
	type KeyConstraint,
	type Premise,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

const constraintPremise = (constraint: PremiseObject, kind: ConstraintKind): Premise => ({
	kind: "constraint",
	constraint,
	constraintKind: kind
})

/**
 * What an installed key proves its key with (see the header): its constraint, at every statement.
 *
 * Evidence lifetime: which installed facts may prove physical uniqueness or existence, in which execution context.
 *
 * A declared key's installed constraint proves its key, and a containment the existence of a referenced fact, each
 * with the premises it rests on and the context they hold in (Grounds). A key proves at most one match, never
 * existence, and a containment existence, never uniqueness, so each is asked only for its own proposition:
 *
 * - A PRIMARY KEY or UNIQUE, or a derived relation's unique index (immediate on its materialized view for every
 *   refreshed state), proves its key at every statement, in every execution context (keyEvidence): grizzle installs
 *   every key immediate and validated.
 * - A containment proves existence in the context the theory recorded for it, and a family that holds only at commit (a
 *   deferred or PERIOD foreign key, a residual law) only at commit (containmentEvidence): inside a transaction (a read
 *   inside a write transaction, such as a read-back) it proves nothing, and a `snapshot` read admits it as lawful
 *   committed-snapshot evidence, since committed rows satisfy it. A deferred foreign key so proves no existence inside
 *   a transaction, while the referenced key still proves at most one match there.
 * - Nothing else is a source: an ordinary nonunique index, planner statistics, a TypeScript assertion or an
 *   approximate result has no form here.
 *
 * The catalog that resolves a declared key to its installed constraint is always the schema's theory (theoryCatalog):
 * every constraint is named as ownership installed it, the one place a constraint is spelled. Grizzle lowers every
 * declared key to an immediate constraint, and the database holds the snapshot the schema compiles to (Db.open admits
 * it by the ledger's target), so a template states what the installed constraints prove; it records each premise.
 */
export const keyEvidence = (constraint: KeyConstraint): Grounds => ({
	premises: [constraintPremise(constraint.constraint, constraint.kind)],
	context: "immediate"
})

/** Whether each containment family holds only at commit, whatever context the theory recorded. */
const atCommit: Readonly<Record<ExistenceConstraint["kind"], boolean>> = {
	foreignKey: false,
	deferredForeignKey: true,
	periodForeignKey: true,
	residualLaw: true,
	enum: false
}

/** The premises a containment rests on: its constraint, every unit function of its residual law, or none for an enum
 * type. */
const enforcementPremises = (constraint: ExistenceConstraint): ReadonlyArray<Premise> => {
	const e = constraint.enforcement
	switch (e.kind) {
		case "constraint":
			return [constraintPremise(e.name, constraint.kind)]
		case "residualLaw":
			return e.functions.map((fn) => constraintPremise(fn, constraint.kind))
		case "type":
			return []
	}
}

/**
 * What a containment proves existence with in the execution context (see the header): the premises it rests on,
 * none when its enum type enforces it; nothing inside a transaction when it holds only at commit.
 */
export const containmentEvidence = (
	constraint: ExistenceConstraint,
	execution: TemplateContext
): Grounds | undefined => {
	const context: EvidenceContext =
		atCommit[constraint.kind] &&
		(constraint.context === "immediate" || constraint.context === "descriptor")
			? "committedSnapshot"
			: constraint.context
	if (!contextAdmits(execution, context)) {
		return undefined
	}
	return { premises: enforcementPremises(constraint), context }
}

/**
 * A key the catalog resolves to its installed constraint: a stored relation's declared key and the constraint
 * ownership derived for it, or a derived relation's inherited key and the unique index its view is installed with.
 */
export interface CatalogKey {
	readonly relation: string
	readonly fields: KeySet
	/** The fields compared WITHOUT OVERLAPS (KeyConstraint spans). */
	readonly spans: KeySet
	readonly primary: boolean
	readonly constraint: ConstraintName
}

/**
 * The key and containment evidence of a schema's theory (theory/theory.ts TheoryEvidence), its constraints named as
 * ownership derived them. A key the theory does not list has no constraint.
 */
export const theoryCatalog = (
	evidence: { readonly keys: ReadonlyArray<CatalogKey> },
	options: { readonly containments: ReadonlyArray<ExistenceConstraint> }
): EvidenceCatalog => ({
	keyConstraint: (relation, columns, role) => {
		const k = evidence.keys.find((e) => e.relation === relation && sameMembers(e.fields, columns))
		if (k === undefined) {
			return undefined
		}
		return {
			relation,
			columns,
			spans: k.spans,
			constraint: k.constraint,
			kind: role.derived ? "uniqueIndex" : k.primary ? "primaryKey" : "unique"
		}
	},
	containments: options.containments
})
