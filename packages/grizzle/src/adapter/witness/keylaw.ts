import { Array as Arr } from "effect"
import type { InstallNames } from "#compiler/plan/catalog.ts"
import type { Law, TableRelation } from "#compiler/plan/change.ts"
import type {
	ColumnIdent,
	ConstraintName,
	ConstraintOwner,
	DomainName,
	RelationIdent,
	RosterCodec,
	SchemaArtifacts
} from "#compiler/plan/common.ts"
import type { DescribedLaw } from "#compiler/plan/migration.ts"

/** One column a domain types in a table, with the law that column's use of the domain discharges. */
type DomainUse = Extract<
	SchemaArtifacts["constraintLaws"][number],
	{ readonly kind: "domainConstraint" }
>["uses"][number]

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
 * Every table constraint, unique index and domain constraint maps, under the table or domain that owns it, to every
 * law its violation can report (NativeLaws): one native object can discharge several, as a family's axis foreign key
 * does every containment merged into it, and a domain several columns share states each one's law: a text domain each
 * field's pattern law, a contract's domain each contract of its definition's. A native
 * violation names its constraint beside the table or data type it is on, so a name is read only under that owner:
 * every domain's CHECK is `check`, and two tables may each hold a row check of one name. A violation is read only when the owner it reports
 * lies in the installation's schema. The installation lists those constraints, each with its law described where it is
 * built (physical/install Installation.constraintLaws), and the snapshot records their laws (Snapshot.constraintToLaw).
 * An opened Db's artifacts are compiled from the schema whose snapshot the ledger's latest complete folder installed
 * (adapter/db/open.ts), so their table names the installed constraints.
 *
 * Every installed constraint but a roster domain's and a text domain's no stored field types is in the table, a
 * contract's and a stored field's text refinement domain's included, so a constraint the table does not name under its
 * owner reports no law. A constraint name is never parsed, and never read without its owner.
 *
 * A write statement's refusal (write/refusal.ts) raises with the law identity itself as the constraint name and reports
 * no owner: `raised` holds every law of the theory under its identity.
 *
 * A roster's domains are no law's. Its code domain is the range proof of its codes, admitting a live handle's code
 * alone, and its bits domain, which a roster that types a set installs, admits a set of live handles' bits alone; and
 * grizzle's codec writes only live handles, so neither refuses a value grizzle writes. `rosterDomainOf` reads which
 * roster's domain PostgreSQL reports as a violation's data type, so the classifier tells that violation, a defect,
 * from every law's.
 */
export interface KeyLaws {
	/** The PostgreSQL schema the installation lives in: a native violation's reported schema must be it. */
	readonly schema: string
	/** The laws a reported constraint's violation can report, under the reported owner. */
	readonly lawsOf: (constraint: ConstraintName, owner: ConstraintOwner) => NativeLaws | undefined
	/** The table a stored relation of the installation is, by its declared name: what a write statement writes. */
	readonly tableOf: (relation: string) => RelationIdent
	/** Every law of the theory by the constraint name a write statement's refusal raises it under (SQLSTATE 23000),
	 * the law's identity itself. */
	readonly raised: ReadonlyMap<ConstraintName, DescribedLaw>
	/** The roster domain `domain` is, the installation's; undefined for any other domain. */
	readonly rosterDomainOf: (domain: DomainName) => RosterDomain | undefined
	/**
	 * The generated field a column of a table is, as an outcome names its law (types/changeset Law `generated`): what
	 * a NOT NULL violation on it, which only its generation expression's NULL raises, breaks; undefined for any other
	 * column.
	 */
	readonly generatedOf: (table: RelationIdent, column: ColumnIdent) => Law | undefined
}

/**
 * Every law one native constraint's violation can report, each described, in the order the installation lists them;
 * and, for a domain constraint, each column the domain types with its law (a text domain's one law per field), which
 * decide among a shared domain's laws by the table the violating statement wrote and, on the host, by the column of the
 * stated row that breaks it. A table constraint types no column: its uses are none.
 */
export interface NativeLaws {
	readonly laws: Arr.NonEmptyReadonlyArray<DescribedLaw>
	readonly uses: ReadonlyArray<DomainUse>
}

/**
 * A domain the installation types a roster's values by: its code domain, a closed id's, or its bits domain, a set's,
 * with the codes the installation holds for the roster.
 */
export interface RosterDomain {
	readonly carrier: "code" | "bits"
	readonly codec: RosterCodec
}

interface KeyLawInput {
	/** The installation's names: its schema, each relation's table, and each roster's two domains, with the codes the
	 * installation holds for it. */
	readonly names: Pick<
		InstallNames,
		"schema" | "relation" | "codes" | "rosterDomain" | "bitsDomain"
	>
	/** Every installed constraint with its owner and its law, described (physical/install Installation.constraintLaws). */
	readonly constraintLaws: SchemaArtifacts["constraintLaws"]
	/** Every law of the theory, described (physical/install Installation.theoryLaws). */
	readonly theoryLaws: SchemaArtifacts["theoryLaws"]
	/** The stored relations, whose generated fields a NOT NULL violation names. */
	readonly relations: ReadonlyArray<TableRelation>
}

/** The laws of one kind of owner's constraint, under `owner`, created empty on its first constraint. */
const ownedBy = <O>(
	byOwner: Map<O, Map<ConstraintName, NativeLaws>>,
	owner: O
): Map<ConstraintName, NativeLaws> => {
	const found = byOwner.get(owner)
	if (found !== undefined) {
		return found
	}
	const named = new Map<ConstraintName, NativeLaws>()
	byOwner.set(owner, named)
	return named
}

const noUses: ReadonlyArray<DomainUse> = Object.freeze([])

export const keyLaws = (input: KeyLawInput): KeyLaws => {
	const tables = new Map<RelationIdent, Map<ConstraintName, NativeLaws>>()
	const domains = new Map<DomainName, Map<ConstraintName, NativeLaws>>()
	for (const c of input.constraintLaws) {
		switch (c.kind) {
			case "constraint":
				ownedBy(tables, c.owner).set(c.name, { laws: c.laws, uses: noUses })
				break
			case "domainConstraint":
				ownedBy(domains, c.owner).set(c.name, { laws: c.laws, uses: c.uses })
				break
		}
	}
	const rosters = new Map<DomainName, RosterDomain>(
		Arr.flatMap(
			[...input.names.codes.rosters.values()],
			(codec): ReadonlyArray<readonly [DomainName, RosterDomain]> => [
				[input.names.rosterDomain(codec.roster).name, { carrier: "code", codec }],
				[input.names.bitsDomain(codec.roster).name, { carrier: "bits", codec }]
			]
		)
	)
	const generated = new Map(
		Arr.map(input.relations, (r) => [
			r.ident,
			new Map(
				Arr.flatMap(r.fields, (f): ReadonlyArray<readonly [ColumnIdent, Law]> =>
					f.writing.kind === "generated"
						? [[f.column, Object.freeze({ kind: "generated", relation: r.name, field: f.name })]]
						: []
				)
			)
		])
	)
	return {
		schema: input.names.schema,
		lawsOf: (constraint, owner) =>
			owner.kind === "table"
				? tables.get(owner.name)?.get(constraint)
				: domains.get(owner.name)?.get(constraint),
		tableOf: (relation) => input.names.relation(relation).name,
		raised: new Map(
			Arr.map(input.theoryLaws, (l): readonly [ConstraintName, DescribedLaw] => [l.law, l])
		),
		rosterDomainOf: (domain) => rosters.get(domain),
		generatedOf: (table, column) => generated.get(table)?.get(column)
	}
}
