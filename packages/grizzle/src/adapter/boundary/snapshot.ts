import { Result } from "effect"
import { readHost, toResult } from "#adapter/engine.ts"
import {
	type CompileError,
	decode,
	isList,
	isRecord,
	malformedArtifact,
	noRevivers,
	trusted
} from "#compiler/plan/common.ts"
import {
	type DeploySnapshot,
	joinedSnapshot,
	type ServedSnapshot,
	servedSnapshot,
	type SnapshotFiles,
	snapshotFingerprint
} from "#compiler/plan/migration.ts"

/**
 * The snapshot a revived JSON value is: the value itself, trusted once its recorded fingerprint is the digest of its
 * content (build.ts snapshotFingerprint), which is total over any value. The generator writes snapshot.json and
 * manifest.json as exactly the value it fingerprints, laid out over the two, so a value whose fingerprint holds is a
 * snapshot the generator wrote, and one whose fingerprint does not (either file hand-edited, corrupted or merged, or
 * one from another snapshot than the other) is refused before anything reads it as a snapshot.
 */
const sealedSnapshot = (value: unknown): Result.Result<DeploySnapshot, CompileError> => {
	if (!isRecord(value)) {
		return Result.fail(malformedArtifact("snapshot", [], "a snapshot object"))
	}
	if (!isList(value["levels"])) {
		return Result.fail(
			malformedArtifact(
				"snapshot",
				["levels"],
				"a snapshot recording its installation's levels, which a grizzle before levels did not write: draft the installation's migrations again"
			)
		)
	}
	return Result.flatMap(toResult(snapshotFingerprint(value)), (computed) =>
		computed === value["fingerprint"]
			? Result.succeed(trusted<DeploySnapshot>(value))
			: Result.fail(
					malformedArtifact(
						"snapshot",
						[],
						"a snapshot whose recorded fingerprint is its content's: this one was edited by hand"
					)
				)
	)
}

/** Parses the snapshot DbLayer.make is given, the value JSON.parse or a JSON import of snapshot.json yields, into what
 * the layer over its level `level` and its Dbs read of it (served.ts servedSnapshot): its recorded fingerprint, the one
 * every Db's prologue guards the database's ledger with, trusted as `grizzle generate` wrote it; and its levels' schemas,
 * the laws of the levels above `level`, its constraint-to-law map and its rosters' codes, their canonical tags revived.
 * Nothing else of it is read or revived, and manifest.json is never read. It is read once at the boundary (readHost), so
 * a getter or a proxy that throws refuses it, and nothing after it reads the caller's value. Whether its content is that
 * fingerprint's is checked where the files are read to draft, check, drift or migrate (readSnapshot), never when an
 * application starts. */
export const parseSnapshot = (
	json: unknown,
	level: number
): Result.Result<ServedSnapshot, CompileError> =>
	readHost(
		malformedArtifact(
			"snapshot",
			[],
			"a snapshot read as data, as an import of snapshot.json yields it"
		),
		() => toResult(servedSnapshot(json, level))
	)

/** Reads a snapshot's two files' texts: each file's JSON parsed and its canonical tags revived (`decode`), the two
 * joined into the one snapshot they lay out (build.ts joinedSnapshot), then trusted once its fingerprint holds. The
 * empty snapshot is no file: a schema without them starts from emptySnapshot. */
export const readSnapshot = (files: SnapshotFiles): Result.Result<DeploySnapshot, CompileError> =>
	Result.flatMap(toResult(decode(files.snapshot, noRevivers)), (runtime) =>
		Result.flatMap(toResult(decode(files.manifest, noRevivers)), (migration) =>
			Result.flatMap(toResult(joinedSnapshot(runtime, migration)), (joined) =>
				sealedSnapshot(joined.content)
			)
		)
	)
