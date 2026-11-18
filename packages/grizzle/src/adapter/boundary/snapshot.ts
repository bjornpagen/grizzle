import { Result } from "effect"
import { readHost, toResult } from "#adapter/engine.ts"
import {
	type CompileError,
	decode,
	isList,
	malformedArtifact,
	noRevivers,
	trusted
} from "#compiler/plan/common.ts"
import {
	type DeploySnapshot,
	joinedSnapshot,
	recordedSnapshot,
	type ServedSnapshot,
	type SnapshotContent,
	servedSnapshot,
	type SnapshotFiles,
	snapshotFingerprint,
	snapshotSeal
} from "#compiler/plan/serve.ts"

/** A joined value recording its installation's levels, which a grizzle before levels did not write. */
const withLevels = (value: Readonly<Record<string, unknown>>): Result.Result<void, CompileError> =>
	isList(value["levels"])
		? Result.void
		: Result.fail(
				malformedArtifact(
					"snapshot",
					["levels"],
					"a snapshot recording its installation's levels, which a grizzle before levels did not write: draft the installation's migrations again"
				)
			)

/**
 * The committed snapshot a revived JSON value of both files joined is: the value itself, trusted once the seal
 * manifest.json carries is the digest of the whole (build.ts snapshotSeal), which is total over any value. The generator
 * writes snapshot.json and manifest.json as exactly the record it seals, laid out over the two, so a value whose seal
 * holds is a record the generator wrote, and one whose seal does not (either file hand-edited, corrupted or merged, or
 * one from another snapshot than the other) is refused before anything reads it as a snapshot.
 */
const sealedSnapshot = (
	value: Readonly<Record<string, unknown>>,
	seal: unknown
): Result.Result<DeploySnapshot, CompileError> =>
	Result.flatMap(withLevels(value), () =>
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
	)

/**
 * The record of a snapshot an earlier grizzle laid out, whose manifest.json holds every installed statement whole and no
 * seal: the content both files hold, trusted once its recorded fingerprint is the digest of that content (build.ts
 * snapshotFingerprint), as that grizzle's reader trusted it, then recorded (build.ts recordedSnapshot). It is the one
 * conversion of the earlier form, which `grizzle generate` alone reads, once, writing the record in its place.
 */
const earlierSnapshot = (
	value: Readonly<Record<string, unknown>>
): Result.Result<DeploySnapshot, CompileError> =>
	Result.flatMap(withLevels(value), () =>
		Result.flatMap(toResult(snapshotFingerprint(value)), (computed) =>
			computed === value["fingerprint"]
				? Result.succeed(
						recordedSnapshot(trusted<SnapshotContent & Pick<DeploySnapshot, "fingerprint">>(value))
					)
				: Result.fail(
						malformedArtifact(
							"snapshot",
							[],
							"a snapshot whose recorded fingerprint is its content's: this one was edited by hand"
						)
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
 * A committed snapshot as the command line reads its two files, by the form manifest.json holds: the record its seal
 * holds (`recorded`), or the record of one an earlier grizzle laid out, every installed statement whole, its
 * fingerprint holding (`earlier`), which only `grizzle generate` drafts from, writing its record in its place, and every
 * other command refuses; either with the derived runtime facts snapshot.json records beside it, as read and outside the
 * seal and the fingerprint, which `grizzle check` and generate hold to the compile's (build.ts derivedHolds) and never
 * read otherwise.
 */
export interface CommittedSnapshot {
	readonly form: "recorded" | "earlier"
	readonly snapshot: DeploySnapshot
	readonly derived: unknown
}

/** Reads a snapshot's two files' texts: each file's JSON parsed and its canonical tags revived (`decode`), the two
 * joined into the one snapshot they lay out (build.ts joinedSnapshot), then trusted once its seal holds, or, in the
 * earlier form, its fingerprint, beside the derived facts snapshot.json records. The empty snapshot is no file: a schema
 * without them starts from emptySnapshot. */
export const readSnapshot = (
	files: SnapshotFiles
): Result.Result<CommittedSnapshot, CompileError> =>
	Result.flatMap(toResult(decode(files.snapshot, noRevivers)), (runtime) =>
		Result.flatMap(toResult(decode(files.manifest, noRevivers)), (migration) =>
			Result.flatMap(
				toResult(joinedSnapshot(runtime, migration)),
				(joined): Result.Result<CommittedSnapshot, CompileError> => {
					switch (joined.form) {
						case "recorded":
							return Result.map(sealedSnapshot(joined.content, joined.seal), (snapshot) => ({
								form: joined.form,
								snapshot,
								derived: joined.derived
							}))
						case "earlier":
							return Result.map(earlierSnapshot(joined.content), (snapshot) => ({
								form: joined.form,
								snapshot,
								derived: joined.derived
							}))
					}
				}
			)
		)
	)
