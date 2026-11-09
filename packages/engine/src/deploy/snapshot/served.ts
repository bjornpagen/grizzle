import { fromJson, noRevivers } from "#compiler/core/canonical.ts"
import { type CompileError, within } from "#compiler/core/errors.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { usableSchemas } from "#compiler/deploy/admission/roles.ts"
import type { ServedSnapshot, SnapshotLevel } from "#compiler/deploy/snapshot/types.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import { type Codebook, emptyCodebook, type RosterCodec, rosterCodec } from "#compiler/ir/codes.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import type { CreateExtension, Grant, Revoke, SqlStatement } from "#compiler/sql/ast.ts"

/**
 * The codebook of rosters' recorded codes, each under its declared name, in the order given. A snapshot `grizzle
 * generate` wrote records every roster under a name the declared-name rule admits, so one it refuses is a defect of
 * the compiler that wrote it.
 */
export const rosterCodebook = (rosters: ReadonlyArray<readonly [string, RosterCodes]>): Codebook => {
	const book = new Map<DeclaredName, RosterCodec>()
	for (const [name, codes] of rosters) {
		const roster = parseDeclaredName(name)
		if (!roster.ok) {
			throw defect(`the snapshot records roster ${JSON.stringify(name)} under a declared name`)
		}
		book.set(roster.value, rosterCodec(roster.value, codes))
	}
	return book.size === 0 ? emptyCodebook : Object.freeze({ rosters: book })
}

/** A statement of a snapshot's manifest in its JSON form, as the layer reads it: a grant's, a revocation's or an
 * extension's clauses, which hold names and keywords alone, so their JSON form is their value; any other statement by
 * its kind. */
type StatementJson =
	| Grant
	| Revoke
	| CreateExtension
	| { readonly kind: Exclude<SqlStatement["kind"], "grant" | "revoke" | "createExtension"> }

/** A relation of a snapshot's theory in its JSON form, as the layer reads it: a roster's codes, any other by its kind. */
type RelationJson =
	| { readonly kind: "closed"; readonly codes: unknown }
	| { readonly kind: "relation" | "derived" }

/** The members of a snapshot's JSON form the layer reads (ServedSnapshot), as `grizzle generate` writes them. */
interface ServedJson {
	readonly fingerprint: SchemaFingerprint
	readonly levels: unknown
	readonly constraintToLaw: unknown
	readonly theory: { readonly relations: Readonly<Record<string, RelationJson>> }
	readonly manifest: {
		readonly objects: ReadonlyArray<{ readonly ddl: ReadonlyArray<StatementJson> }>
		readonly publicRevokes: ReadonlyArray<StatementJson>
	}
}

/** A member of a snapshot's JSON form at `path`, its canonical tags revived. */
const revived = (value: unknown, path: ReadonlyArray<string>): Result.Result<unknown, CompileError> =>
	Result.mapError(fromJson(value, noRevivers), (e) => within(e, path))

/**
 * The snapshot an application's DbLayer serves, from the JSON form an import of snapshot.json yields, trusted as the
 * snapshot `grizzle generate` wrote, whose content is verified where it is drafted, checked and migrated from
 * (readSnapshot): its recorded fingerprint; its levels and constraint-to-law map, their canonical tags revived
 * (`fromJson`); its rosters' codes, revived; and, read off the manifest's extensions, grants and revocations alone,
 * each extension it creates with its schema and the schemas it grants each role USAGE on (roles.ts usableSchemas).
 * Nothing else of it is read: the rest of the manifest, the theory's other relations and its laws, the logins, the
 * workload access and the access paths are generate's, check's and migrate's.
 */
export const servedSnapshot = (json: unknown): Result.Result<ServedSnapshot, CompileError> => {
	const served = trusted<ServedJson>(json)
	const levels = revived(served.levels, ["levels"])
	if (!levels.ok) {
		return levels
	}
	const constraintToLaw = revived(served.constraintToLaw, ["constraintToLaw"])
	if (!constraintToLaw.ok) {
		return constraintToLaw
	}
	const rosters: Array<readonly [string, RosterCodes]> = []
	for (const [name, relation] of Object.entries(served.theory.relations)) {
		if (relation.kind === "closed") {
			const codes = revived(relation.codes, ["theory", "relations", name, "codes"])
			if (!codes.ok) {
				return codes
			}
			rosters.push([name, trusted<RosterCodes>(codes.value)])
		}
	}
	const statements = [
		...served.manifest.objects.flatMap((o) => o.ddl),
		...served.manifest.publicRevokes
	]
	return Result.ok({
		fingerprint: served.fingerprint,
		levels: trusted<ReadonlyArray<SnapshotLevel>>(levels.value),
		constraintToLaw: trusted<ConstraintLaws>(constraintToLaw.value),
		codes: rosterCodebook(rosters),
		installedExtensions: new Map(
			statements.flatMap((s) => (s.kind === "createExtension" ? [[s.name, s.schema] as const] : []))
		),
		usableSchemas: usableSchemas(
			statements.flatMap((s) => (s.kind === "grant" || s.kind === "revoke" ? [s] : []))
		)
	})
}
