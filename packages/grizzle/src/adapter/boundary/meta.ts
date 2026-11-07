import { Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import {
	type CompileError,
	decode,
	isRecord,
	malformedArtifact,
	noRevivers,
	trusted
} from "#compiler/plan/common.ts"
import {
	metaSeal,
	type MigrationMeta,
	readDecodedMeta,
	type ReadMeta
} from "#compiler/plan/migration.ts"

/** The refusal of a meta.json grizzle did not write as it stands. */
const unsealed = (): CompileError =>
	malformedArtifact(
		"meta",
		[],
		"a migration's meta.json whose recorded seal is its meta's: this one was edited by hand"
	)

/** The meta a revived meta.json holds: `{ meta, seal }`, the meta trusted once the recorded seal is its own
 * (render/folder.ts metaSeal), which is total over any value. Anything else is refused before its meta is read. */
const sealedMeta = (file: unknown): Result.Result<MigrationMeta, CompileError> => {
	if (!isRecord(file)) {
		return Result.fail(unsealed())
	}
	const meta = file["meta"]
	const computed = metaSeal(meta)
	return computed.ok && computed.value === file["seal"]
		? Result.succeed(trusted<MigrationMeta>(meta))
		: Result.fail(unsealed())
}

/** A folder's meta.json as writeMeta writes it: its JSON parsed (`decode`), then its meta trusted once its seal holds.
 * A meta.json edited or corrupted outside grizzle is refused before anything reads its meta. */
export const decodeMeta = (text: string): Result.Result<MigrationMeta, CompileError> =>
	Result.flatMap(toResult(decode(text, noRevivers)), sealedMeta)

/** Reads a folder's meta.json: its meta trusted once (decodeMeta), then what the meta alone does not say (the engine's
 * readDecodedMeta). */
export const readMeta = (text: string): Result.Result<ReadMeta, CompileError> =>
	Result.flatMap(decodeMeta(text), (meta) => toResult(readDecodedMeta(meta)))
