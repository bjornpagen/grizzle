import { Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import {
	type CompileError,
	decode,
	fromJson,
	isList,
	isRecord,
	malformedArtifact,
	noRevivers,
	trusted
} from "#compiler/plan/common.ts"
import { type DeploySnapshot, snapshotFingerprint } from "#compiler/plan/migration.ts"

/**
 * The snapshot a revived JSON value is: the value itself, trusted once its recorded fingerprint is the digest of its
 * content (build.ts snapshotFingerprint), which is total over any value. The generator writes snapshot.json as exactly
 * the value it fingerprints, so a value whose fingerprint holds is a snapshot the generator wrote, and one whose
 * fingerprint does not (hand-edited, corrupted, merged, a value that is no object) is refused before anything reads it
 * as a snapshot.
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

/** Parses the snapshot DbLayer.make is given, the value JSON.parse or a JSON import of snapshot.json yields: its
 * canonical tags revived once (`fromJson`, which refuses what JSON never holds, so a DeploySnapshot already revived is
 * refused: a bigint is no JSON value), then trusted as the snapshot `grizzle generate` wrote, its recorded fingerprint
 * the one every Db's prologue guards the database's ledger with. Whether its content is that fingerprint's is checked
 * where the file is read to draft, check or migrate (readSnapshot), never when an application starts. */
export const parseSnapshot = (json: unknown): Result.Result<DeploySnapshot, CompileError> =>
	Result.map(toResult(fromJson(json, noRevivers)), (value) => trusted<DeploySnapshot>(value))

/** Reads snapshot.json's text: its JSON parsed and its canonical tags revived (`decode`), then trusted once its
 * fingerprint holds. The empty snapshot is never a file: a schema without snapshot.json starts from emptySnapshot. */
export const readSnapshot = (text: string): Result.Result<DeploySnapshot, CompileError> =>
	Result.flatMap(toResult(decode(text, noRevivers)), sealedSnapshot)
