import { Array as Arr } from "effect"
import type { ConstraintName, DomainName, RelationIdent } from "#compiler/core/ids.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import type { DescribedLaw } from "#compiler/physical/install/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"

/** The names a violation reports, as the wire admitted them (wire/failure.ts serverFailure). */
interface ReportedNames {
	readonly schema: string | undefined
	readonly table: RelationIdent | undefined
	readonly dataType: DomainName | undefined
}

/**
 * The owner a violation reports in `schema`, as the constraint table keys it: the table of a table constraint or a
 * unique index, or the data type of a domain constraint, its domain. None when the violation reports another schema, or
 * neither a table nor a data type.
 */
export const reportedOwner = (
	failure: ReportedNames,
	schema: string
): ConstraintOwner | undefined => {
	if (failure.schema !== schema) {
		return undefined
	}
	if (failure.table !== undefined) {
		return { kind: "table", name: failure.table }
	}
	return failure.dataType === undefined ? undefined : { kind: "domain", name: failure.dataType }
}

/**
 * The laws of one installation, keyed by what PostgreSQL reports, each carrying its description as an outcome names it
 * (types/changeset Law), so a violation reads its law and the law's description in one step.
 *
 * Every table constraint, unique index and domain constraint maps, under the table or domain that owns it, to the law
 * its violation reports; an object discharging several laws reports the first. A native violation names its
 * constraint beside the table or data type it is on, so a name is read only under that owner: every domain's CHECK is
 * `check`, and two tables may each hold a row check of one name. A violation is read only when the owner it reports
 * lies in the installation's schema. The installation lists those constraints, each with its law described where it is
 * built (physical/install Installation.constraintLaws), and the snapshot records their laws (Snapshot.constraintToLaw).
 * An opened Db's artifacts are compiled from the schema whose snapshot the ledger's latest complete folder installed
 * (adapter/db/open.ts), so their table names the installed constraints.
 *
 * Every installed constraint is in the table, a contract's and a text refinement domain's included, so a constraint
 * the table does not name under its owner reports no law. A constraint name is never parsed, and never read without its
 * owner.
 *
 * A residual law's function raises with the law identity itself as the constraint name and reports no owner, and so
 * does a write statement's refusal (write/refusal.ts): `raised` holds every law of the theory under its identity.
 */
export interface KeyLaws {
	/** The PostgreSQL schema the installation lives in: a native violation's reported schema must be it. */
	readonly schema: string
	/** The law a reported constraint's violation reports, under the reported owner. */
	readonly lawOf: (constraint: ConstraintName, owner: ConstraintOwner) => DescribedLaw | undefined
	/** Every law of the theory by the constraint name its law function or a write statement's refusal raises it under
	 * (SQLSTATE 23000), the law's identity itself. */
	readonly raised: ReadonlyMap<ConstraintName, DescribedLaw>
}

interface KeyLawInput {
	readonly schema: string
	/** Every installed constraint with its owner and its law, described (physical/install Installation.constraintLaws). */
	readonly constraintLaws: SchemaArtifacts["constraintLaws"]
	/** Every law of the theory, described (physical/install Installation.theoryLaws). */
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
}

/** The laws of one kind of owner's constraint, under `owner`, created empty on its first constraint. */
const ownedBy = <O>(
	byOwner: Map<O, Map<ConstraintName, DescribedLaw>>,
	owner: O
): Map<ConstraintName, DescribedLaw> => {
	const found = byOwner.get(owner)
	if (found !== undefined) {
		return found
	}
	const named = new Map<ConstraintName, DescribedLaw>()
	byOwner.set(owner, named)
	return named
}

export const keyLaws = (input: KeyLawInput): KeyLaws => {
	const tables = new Map<RelationIdent, Map<ConstraintName, DescribedLaw>>()
	const domains = new Map<DomainName, Map<ConstraintName, DescribedLaw>>()
	for (const c of input.constraintLaws) {
		switch (c.kind) {
			case "constraint":
				ownedBy(tables, c.owner).set(c.name, c)
				break
			case "domainConstraint":
				ownedBy(domains, c.owner).set(c.name, c)
				break
		}
	}
	return {
		schema: input.schema,
		lawOf: (constraint, owner) =>
			owner.kind === "table"
				? tables.get(owner.name)?.get(constraint)
				: domains.get(owner.name)?.get(constraint),
		raised: new Map(
			Arr.map(input.theoryLaws, (l): readonly [ConstraintName, DescribedLaw] => [l.law, l])
		)
	}
}
