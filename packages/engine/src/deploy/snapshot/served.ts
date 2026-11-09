import { fromJson, noRevivers, type Path } from "#compiler/core/canonical.ts"
import { type CompileError, within } from "#compiler/core/errors.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ServedSnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import { type Codebook, emptyCodebook, type RosterCodec, rosterCodec } from "#compiler/ir/codes.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import type { NamedClosed } from "#compiler/physical/ddl/constants.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"

/**
 * The codebook of rosters' recorded codes, each under its declared name, in the order given. A snapshot `grizzle
 * generate` wrote records every roster under a name the declared-name rule admits, so one it refuses is a defect of
 * the compiler that wrote it.
 */
export const rosterCodebook = (
	rosters: ReadonlyArray<readonly [string, RosterCodes]>
): Codebook => {
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

/** A level of a snapshot in its JSON form, as the layer reads it: its name, schema and fingerprint, whose JSON form is
 * their value, and its laws. */
interface LevelJson {
	readonly name: string
	readonly schema: string
	readonly fingerprint: SchemaFingerprint
	readonly laws: unknown
}

/** The members of snapshot.json the layer reads (ServedSnapshot), as `grizzle generate` writes them: each roster's
 * codes by its declared name among them. */
interface ServedJson {
	readonly fingerprint: SchemaFingerprint
	readonly levels: ReadonlyArray<LevelJson>
	readonly constraintToLaw: unknown
	readonly rosters: Readonly<Record<string, unknown>>
	readonly derived: { readonly closed: Readonly<Record<string, NamedClosed>> }
}

/** A member of a snapshot's JSON form at `path`, its canonical tags revived. */
const revived = (value: unknown, path: Path): Result.Result<unknown, CompileError> =>
	Result.mapError(fromJson(value, noRevivers), (e) => within(e, path))

/**
 * The snapshot an application's DbLayer serves over its level `level` (its base's, the last of the base's own levels),
 * from the JSON value an import of snapshot.json yields, trusted as the snapshot `grizzle generate` wrote, whose content
 * is verified where it is drafted, checked and migrated from (readSnapshot): its recorded fingerprint; every level's
 * schema and recorded fingerprint, and the laws of each level above `level`, their canonical tags revived (`fromJson`);
 * its constraint-to-law map and its rosters' codes, revived; and the installation's derived runtime facts
 * (SnapshotDerived), each closed relation's constants as readers address them, which hold names and numbers alone, so
 * their JSON form is their value. Nothing else of it is read: the laws of `level` and the levels below it are the
 * layer's own artifacts', and manifest.json, the rest of the snapshot, is generate's, check's, drift's and migrate's.
 */
export const servedSnapshot = (
	json: unknown,
	level: number
): Result.Result<ServedSnapshot, CompileError> => {
	const served = trusted<ServedJson>(json)
	const above: Array<{ readonly name: string; readonly laws: ReadonlyArray<DescribedLaw> }> = []
	const first = level + 1
	for (const [i, l] of served.levels.slice(first).entries()) {
		const laws = revived(l.laws, ["levels", first + i, "laws"])
		if (!laws.ok) {
			return laws
		}
		above.push({ name: l.name, laws: trusted<ReadonlyArray<DescribedLaw>>(laws.value) })
	}
	const constraintToLaw = revived(served.constraintToLaw, ["constraintToLaw"])
	if (!constraintToLaw.ok) {
		return constraintToLaw
	}
	const rosters: Array<readonly [string, RosterCodes]> = []
	for (const [name, recorded] of Object.entries(served.rosters)) {
		const codes = revived(recorded, ["rosters", name])
		if (!codes.ok) {
			return codes
		}
		rosters.push([name, trusted<RosterCodes>(codes.value)])
	}
	return Result.ok({
		fingerprint: served.fingerprint,
		schemas: served.levels.map((l) => l.schema),
		levels: served.levels.map((l) => ({ name: l.name, fingerprint: l.fingerprint })),
		above,
		constraintToLaw: trusted<ConstraintLaws>(constraintToLaw.value),
		codes: rosterCodebook(rosters),
		derived: { closed: new Map(Object.entries(served.derived.closed)) }
	})
}
