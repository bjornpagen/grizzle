import { sameMembers } from "@bjornpagen/grizzle-text/base/array"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ConstraintName } from "#compiler/core/ids.ts"
import {
	type ClosedEvidence,
	type ConstraintKind,
	contextAdmits,
	type EvidenceCatalog,
	type ExistenceConstraint,
	type Grounds,
	type KeyConstraint,
	type Premise,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import type { TheoryRelation } from "#compiler/ir/law.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { baseOf, rosterOf } from "#compiler/ir/scalar.ts"

const constraintPremise = (constraint: ConstraintName, kind: ConstraintKind): Premise => ({
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
 * - A PRIMARY KEY or UNIQUE, or a stored derived relation's primary key or unique index (immediate on its table),
 *   proves its key at every statement, in every execution context (keyEvidence): grizzle installs
 *   every key immediate and validated.
 * - A containment law proves existence in the context its discharge holds it in (containmentEvidence): at every
 *   statement where an immediate native holds it, and only at commit where a deferred or PERIOD foreign key or the rule
 *   judge does, so inside a transaction (a read inside a write transaction, such as a read-back) it then proves nothing,
 *   and a `snapshot` read admits it as lawful committed-snapshot evidence, since committed rows satisfy it. Its premise
 *   is the law, whatever discharges it. A deferred containment so proves no existence inside a transaction, while the
 *   referenced key still proves at most one match there.
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

/**
 * What a containment proves existence with in the execution context (see the header): the laws it rests on, its own
 * or those its draw rides on (ir/evidence.ts ExistenceConstraint), in the context it holds in; nothing inside a
 * transaction where it holds only at commit.
 */
export const containmentEvidence = (
	constraint: ExistenceConstraint,
	execution: TemplateContext
): Grounds | undefined =>
	contextAdmits(execution, constraint.context)
		? {
				premises: constraint.laws.map((law): Premise => ({ kind: "law", law })),
				context: constraint.context
			}
		: undefined

/**
 * A key the catalog resolves to its installed constraint: a stored relation's declared key and the constraint
 * ownership derived for it, its primary key's or a unique's, or a derived relation's inherited key and the unique index
 * its view is installed with: the kind it is installed as, stated where the key is made.
 */
export interface CatalogKey {
	readonly relation: string
	readonly fields: KeySet
	/** The fields compared WITHOUT OVERLAPS (KeyConstraint spans). */
	readonly spans: KeySet
	readonly kind: ConstraintKind
	readonly constraint: ConstraintName
}

/**
 * Each closed relation among `relations`, by name, as a query reads it whole: a roster, the closed relation whose one
 * field is a closed id of itself (ir/law.ts ClosedTheoryRelation), or a relation keyed by closed ids, whose key set
 * the installation holds as a constant (physical/ddl/constants.ts).
 */
const closedEvidence = (
	relations: Readonly<Record<string, TheoryRelation>>
): ReadonlyMap<string, ClosedEvidence> => {
	const out = new Map<string, ClosedEvidence>()
	for (const r of Object.values(relations)) {
		if (r.kind !== "closed") {
			continue
		}
		const key = mapNonEmpty(r.primaryFields, (f) => f.name)
		const roster = r.heading.length === 1 && rosterOf(baseOf(r.heading[0].type))?.closed === r.name
		out.set(r.name, {
			kind: roster ? "roster" : "relation",
			key,
			payload: r.heading.flatMap((f) => (key.includes(f.name) ? [] : [f.name])),
			facts: r.rows.length
		})
	}
	return out
}

/**
 * The key, containment and closed relation evidence of a schema's theory (theory/theory.ts TheoryEvidence, and its
 * relations), its constraints named as ownership derived them. A key the theory does not list has no constraint.
 */
export const theoryCatalog = (
	evidence: { readonly keys: ReadonlyArray<CatalogKey> },
	options: {
		readonly containments: ReadonlyArray<ExistenceConstraint>
		readonly relations: Readonly<Record<string, TheoryRelation>>
	}
): EvidenceCatalog => {
	const closed = closedEvidence(options.relations)
	return {
		keyConstraint: (relation, columns) => {
			const k = evidence.keys.find((e) => e.relation === relation && sameMembers(e.fields, columns))
			return k === undefined
				? undefined
				: { relation, columns, spans: k.spans, constraint: k.constraint, kind: k.kind }
		},
		containments: options.containments,
		closed: (relation) => closed.get(relation)
	}
}
