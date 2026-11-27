import { Result } from "effect"
import { readHost, toResult } from "#adapter/engine.ts"
import {
	type CompileError,
	decode,
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
	snapshotSeal
} from "#compiler/plan/serve.ts"

/**
 * The committed snapshot a revived JSON value of both files joined is: the value itself, trusted as the snapshot it
 * seals once the seal manifest.json carries is the digest of the whole (build.ts snapshotSeal), which is total over any
 * value. The generator writes snapshot.json and manifest.json as exactly the record it seals, laid out over the two, so
 * a value whose seal holds is a record a generator of this format wrote, and one whose seal does not (either file
 * hand-edited, corrupted or merged, or one from another snapshot than the other) is refused before anything reads it as
 * a snapshot. The seal digests the record under this grizzle's format, whose shape is the digest of DeploySnapshot's
 * type, the roster of every object kind among it (core/format.ts recordShapes), so a sealed record holds only kinds
 * this grizzle installs: a kind's removal is a change of the format, refused before the record is read
 * (build.ts joinedSnapshot).
 */
const sealedSnapshot = (
	value: Readonly<Record<string, unknown>>,
	seal: unknown
): Result.Result<DeploySnapshot, CompileError> =>
	Result.flatMap(toResult(snapshotSeal(value)), (computed) =>
		computed === seal
			? Result.succeed(trusted<DeploySnapshot>(value))
			: Result.fail(
					malformedArtifact(
						"snapshot",
						[],
						"a snapshot whose manifest.json's seal is the digest of both its files: this one was edited by hand"
					)
				)
	)

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

/**
 * A committed snapshot as the command line reads its two files: the record its seal holds, with the derived runtime
 * facts snapshot.json records beside it, as read and outside the seal and the fingerprint, which `grizzle check` and
 * generate hold to the compile's (build.ts derivedHolds) and never read otherwise.
 */
export interface CommittedSnapshot {
	readonly snapshot: DeploySnapshot
	readonly derived: unknown
}

/** Reads a snapshot's two files' texts: each file's JSON parsed and its canonical tags revived (`decode`), the two
 * joined into the one snapshot they lay out (build.ts joinedSnapshot), which refuses a pair of another format than this
 * grizzle's, then trusted once its seal holds, beside the derived facts snapshot.json records. The empty snapshot is no
 * file: a schema without them starts from emptySnapshot. */
export const readSnapshot = (
	files: SnapshotFiles
): Result.Result<CommittedSnapshot, CompileError> =>
	Result.flatMap(toResult(decode(files.snapshot, noRevivers)), (runtime) =>
		Result.flatMap(toResult(decode(files.manifest, noRevivers)), (migration) =>
			Result.flatMap(toResult(joinedSnapshot(runtime, migration)), (joined) =>
				Result.map(sealedSnapshot(joined.content, joined.seal), (snapshot) => ({
					snapshot,
					derived: joined.derived
				}))
			)
		)
	)
