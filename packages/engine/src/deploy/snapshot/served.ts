import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { fromJson, noRevivers, type Path } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	formatRefused,
	malformedArtifact,
	within
} from "#compiler/core/errors.ts"
import { formatKey, isFormatOf } from "#compiler/core/format.ts"
import type { HeldName } from "#compiler/core/identity.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type {
	LiveDerived,
	ProvedRelation,
	ServedSnapshot,
	SnapshotDerived,
	SnapshotIndex,
	SnapshotTables
} from "#compiler/deploy/snapshot/types.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import { rosterCodebook } from "#compiler/ir/codes.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import type { FkCycles } from "#compiler/laws/model/model.ts"
import type { ReferenceChoice } from "#compiler/laws/model/plan.ts"
import type { LiveSource } from "#compiler/live/notify.ts"
import type { NamedClosed } from "#compiler/physical/ddl/constants.ts"
import type { InstalledParams, TextDomainNames } from "#compiler/physical/ddl/domains.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import type { PlannedGraph } from "#compiler/physical/planned/graph.ts"

/** A level of a snapshot in its JSON form, as the layer reads it: its name, schema and fingerprint, whose JSON form is
 * their value, and its laws. */
interface LevelJson {
	readonly name: string
	readonly schema: string
	readonly fingerprint: SchemaFingerprint
	readonly laws: unknown
}

/** The members of snapshot.json the layer reads (ServedSnapshot), as `grizzle generate` writes them: each roster's
 * codes by its declared name among them, and the derived runtime facts, which a snapshot.json generate did not write
 * may not hold whole (servedDerived). */
interface ServedJson {
	readonly fingerprint: SchemaFingerprint
	readonly levels: ReadonlyArray<LevelJson>
	readonly constraintToLaw: unknown
	readonly rosters: Readonly<Record<string, unknown>>
	readonly derived: unknown
}

/** A snapshot.json without the derived runtime facts the layer reads, whole: one grizzle generate did not write, which it
 * writes again with no migration. */
const underived = (at: Path): CompileError =>
	malformedArtifact(
		"snapshot",
		at,
		"snapshot.json recording the derived runtime facts grizzle generate writes beside the snapshot: run grizzle generate, which drafts no migration"
	)

/**
 * The derived runtime facts snapshot.json records, as one required record of required members, each read as it is
 * (names and numbers alone): refused at the first member it does not record, so no partial record is ever served. It
 * returns SnapshotDerived whole, so a fact added to it is no fact the layer reads until it is read here too.
 */
const servedDerived = (derived: unknown): Result.Result<SnapshotDerived, CompileError> => {
	if (!isRecord(derived)) {
		return Result.err(underived(["derived"]))
	}
	const closed = derived["closed"]
	const fkCycles = derived["fkCycles"]
	const references = derived["references"]
	const judged = derived["judged"]
	const textDomains = derived["textDomains"]
	const library = derived["library"]
	const tables = derived["tables"]
	const live = derived["live"]
	const params = derived["params"]
	const liveDerived = derived["liveDerived"]
	const proved = derived["proved"]
	const planned = derived["planned"]
	if (!isRecord(closed)) {
		return Result.err(underived(["derived", "closed"]))
	}
	if (!isList(fkCycles)) {
		return Result.err(underived(["derived", "fkCycles"]))
	}
	if (!isList(references)) {
		return Result.err(underived(["derived", "references"]))
	}
	if (!isList(judged)) {
		return Result.err(underived(["derived", "judged"]))
	}
	if (!isRecord(textDomains)) {
		return Result.err(underived(["derived", "textDomains"]))
	}
	if (!isList(library)) {
		return Result.err(underived(["derived", "library"]))
	}
	if (!isRecord(tables)) {
		return Result.err(underived(["derived", "tables"]))
	}
	if (!isRecord(live)) {
		return Result.err(underived(["derived", "live"]))
	}
	if (!isRecord(params)) {
		return Result.err(underived(["derived", "params"]))
	}
	if (!isRecord(liveDerived)) {
		return Result.err(underived(["derived", "liveDerived"]))
	}
	if (!isRecord(proved)) {
		return Result.err(underived(["derived", "proved"]))
	}
	if (!isRecord(planned)) {
		return Result.err(underived(["derived", "planned"]))
	}
	return Result.ok({
		closed: new Map(Object.entries(trusted<Readonly<Record<string, NamedClosed>>>(closed))),
		fkCycles: trusted<FkCycles>(fkCycles),
		references: trusted<ReferenceChoice>(references),
		judged: trusted<ReadonlyArray<string>>(judged),
		textDomains: trusted<TextDomainNames>(new Map(Object.entries(textDomains))),
		library: trusted<ReadonlyArray<LibraryFn>>(library),
		tables: trusted<SnapshotTables>(tables),
		live: trusted<LiveSource>(live),
		params: trusted<InstalledParams>(params),
		liveDerived: trusted<Readonly<Record<string, LiveDerived>>>(liveDerived),
		proved: trusted<Readonly<Record<string, NonEmptyReadonlyArray<ProvedRelation>>>>(proved),
		planned: trusted<PlannedGraph>(planned)
	})
}

/** A member of a snapshot's JSON form at `path`, its canonical tags revived. */
const revived = (value: unknown, path: Path): Result.Result<unknown, CompileError> =>
	Result.mapError(fromJson(value, noRevivers), (e) => within(e, path))

/**
 * The snapshot an application's DbLayer serves over its level `level` (its base's, the last of the base's own levels),
 * from the JSON value an import of snapshot.json yields, refused unless it records this grizzle's format
 * (core/format.ts artifactFormat), then trusted as the snapshot `grizzle generate` wrote, whose content is verified
 * where it is drafted, checked and migrated from (readSnapshot): its recorded fingerprint; every level's
 * schema and recorded fingerprint, and the laws of each level above `level`, their canonical tags revived (`fromJson`);
 * its constraint-to-law map and its rosters' codes, revived; and the installation's derived runtime facts
 * (SnapshotDerived), each closed relation's constants as readers address them, the foreign key graph's cycles and the
 * installed tables and their indexes, which hold names and numbers alone, so their JSON form is their value. Nothing else of it is read: the laws of `level` and
 * the levels below it are the layer's own artifacts', and manifest.json, the rest of the snapshot, is generate's,
 * check's, drift's and migrate's.
 */
export const servedSnapshot = (
	json: unknown,
	level: number
): Result.Result<ServedSnapshot, CompileError> => {
	if (!isRecord(json)) {
		return Result.err(malformedArtifact("snapshot", [], "a snapshot.json's JSON form, a record"))
	}
	if (!isFormatOf("snapshot", json[formatKey])) {
		return Result.err(formatRefused("snapshot", json[formatKey]))
	}
	const served = trusted<ServedJson>(json)
	const derived = servedDerived(served.derived)
	if (!derived.ok) {
		return derived
	}
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
	const rosters: Array<readonly [HeldName, RosterCodes]> = []
	for (const [name, recorded] of Object.entries(served.rosters)) {
		const codes = revived(recorded, ["rosters", name])
		if (!codes.ok) {
			return codes
		}
		rosters.push([trusted<HeldName>(name), trusted<RosterCodes>(codes.value)])
	}
	return Result.ok({
		fingerprint: served.fingerprint,
		schemas: served.levels.map((l) => l.schema),
		fingerprints: served.levels.map((l) => l.fingerprint),
		above,
		constraintToLaw: trusted<ConstraintLaws>(constraintToLaw.value),
		codes: rosterCodebook(rosters),
		derived: derived.value
	})
}

/**
 * Each index the installation holds, its key columns and its reasons (SnapshotIndex), by the declared name of the
 * relation whose table holds it, then by the index's name.
 */
export type InstalledIndexes = ReadonlyMap<string, ReadonlyMap<string, SnapshotIndex>>

/**
 * The indexes snapshot.json records the installation holds (InstalledIndexes), read from the JSON value an import of
 * snapshot.json yields, its derived facts read as servedSnapshot reads them: refused where it records none, as no
 * snapshot.json generate writes does. An index's name is one within its table's schema, and a relation's
 * table or view lives in one schema, so a relation and an index name name one index.
 */
export const snapshotIndexes = (json: unknown): Result.Result<InstalledIndexes, CompileError> => {
	if (!isRecord(json)) {
		return Result.err(underived(["derived"]))
	}
	const derived = servedDerived(json["derived"])
	if (!derived.ok) {
		return derived
	}
	const out = new Map<string, ReadonlyMap<string, SnapshotIndex>>()
	for (const tables of Object.values(derived.value.tables)) {
		for (const table of Object.values(tables)) {
			out.set(table.relation, new Map(Object.entries(table.indexes)))
		}
	}
	return Result.ok(out)
}
