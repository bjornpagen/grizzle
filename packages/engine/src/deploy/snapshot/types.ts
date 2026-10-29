import type { ColumnIdent, RelationIdent, SchemaFingerprint } from "#compiler/core/ids.ts"
import type {
	ConstraintLaws,
	InstallationManifest,
	Snapshot,
	WorkloadAccess
} from "#compiler/ir/products.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

/** The snapshot file of one declared schema, relative to the migrations directory. */
export const snapshotFileName = "snapshot.json"

/** A field of a stored or closed relation as the snapshot records it: its installed column, the digest of its
 * canonical ScalarType (which is its identity), and whether it is a serial field. */
export interface SnapshotField {
	readonly name: string
	readonly column: ColumnIdent
	readonly type: string
	readonly serial: boolean
}

interface SnapshotRelationOf<K extends "relation" | "closed" | "derived"> {
	readonly kind: K
	/** The table, enum type or materialized view identifier. */
	readonly ident: RelationIdent
	readonly mutable: boolean
	/** The schema level that declares it, and a derived relation's level over what it reads. */
	readonly level: number
}

/** A stored or closed relation's heading in declared order, and its primary key. */
interface SnapshotHeading {
	readonly fields: ReadonlyArray<SnapshotField>
	readonly primaryKey: ReadonlyArray<string>
}

/** A relation of the snapshot's theory, by kind. A derived relation's fields are its view's columns, which its
 * materialized view object records. A closed relation also records its VALUES template fingerprint: a payload change
 * changes it even when the labels do not, which invalidates every compiled artifact that baked the old facts in. */
export type SnapshotRelation =
	| (SnapshotRelationOf<"relation"> & SnapshotHeading)
	| (SnapshotRelationOf<"closed"> & SnapshotHeading & { readonly template: string })
	| SnapshotRelationOf<"derived">

/** A residual law's record: its family and two digests of its ResidualLaw record, the second with every UPDATE event
 * left out, so a change that only declaring or removing `mutable` causes is told apart from any other. */
export interface SnapshotResidual {
	readonly family: string
	readonly digest: string
	readonly withoutUpdates: string
	/** The participating relations, in the record's order. */
	readonly participants: ReadonlyArray<string>
}

/** A law of the snapshot's theory by how it is enforced: natively, by its shape alone, or by a residual law function,
 * with its record. */
export type SnapshotLaw =
	| { readonly kind: "native"; readonly shape: string }
	| { readonly kind: "residual"; readonly shape: string; readonly residual: SnapshotResidual }

export interface SnapshotTheory {
	/** The owned schema's fingerprint, which compiled templates name (TemplateRequirements.schema). */
	readonly schema: SchemaFingerprint
	readonly relations: Readonly<Record<string, SnapshotRelation>>
	readonly laws: Readonly<Record<string, SnapshotLaw>>
}

/** The canonical schema snapshot: the canonical serialization of what an installation is. It holds a summary of the
 * CheckedTheory (its relations, their fields, mutability and closed templates, and its laws), the installation manifest
 * with every object's DDL and justification (a law identity, the workload's access, or the enforcement of a
 * declaration), the constraint-to-law map, each login's workload programs' access (ProgramAccess: the paths and
 * statistics each program reads through, by login and program name) and the access requests they make. The application
 * commits it beside its code as `migrations/<schema>/snapshot.json`, one per declared schema; the next migration is
 * drafted from it, the current schema and the current workloads, never from the live catalog, and DbLayer.make and
 * `grizzle check` compare the workloads' access with it, naming a program whose access moved. A program edit that moves
 * no path leaves it unchanged. It records no history: every name in it is derived from the current schema alone, so a
 * fresh installation and a migrated one are the same snapshot.
 * The fingerprint is SHA-256, in the domain `snapshot`, over the canonical text of everything else, so it covers the
 * manifest and the workload access as well as the owned schema's own fingerprint (`theory.schema`): a program whose
 * access moves is a new snapshot. It is what a folder's meta.json and the migrations ledger record as the source and
 * target of each migration and what admission compares. */
export interface DeploySnapshot extends Snapshot<SqlStatement> {
	readonly fingerprint: SchemaFingerprint
	/** The declared schema name, and the PostgreSQL schema it is installed in. */
	readonly schemaName: string
	readonly schema: string
	readonly theory: SnapshotTheory
	readonly manifest: InstallationManifest<SqlStatement>
	readonly constraintToLaw: ConstraintLaws
	readonly workload: WorkloadAccess
}

/** A snapshot without its fingerprint: what the fingerprint is computed over. */
export type SnapshotContent = Omit<DeploySnapshot, "fingerprint">
