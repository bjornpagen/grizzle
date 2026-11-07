import { Array as Arr, Effect, Option, Result } from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { ConfiguredSchema } from "#cli/config.ts"
import {
	type ChainBreak,
	type ChainFault,
	ChainRefused,
	type CliError,
	cliError,
	SnapshotForeign,
	SnapshotUnreadable
} from "#cli/errors.ts"
import type { SchemaTree } from "#cli/files.ts"
import type { CompileError } from "#compiler/plan/common.ts"
import {
	type DeploySnapshot,
	emptyFingerprint,
	emptySnapshot,
	folderTimestamp,
	isFolderName,
	type ReadMeta
} from "#compiler/plan/migration.ts"

/**
 * A schema's committed migration state as the command line reads it: its snapshot.json and its folders.
 *
 * The snapshot is read by the generator's own reader, which trusts it once its fingerprint holds. A schema without snapshot.json is at
 * its empty snapshot, whose fingerprint depends on the installed schema identifier alone (snapshot/build.ts
 * emptySnapshot): the empty snapshot is never a file. The snapshot must be the configured schema's: its PostgreSQL
 * schema and declared name are the configuration's. It names no owner: the migration identity is whoever connects.
 *
 * The snapshot the schema's directory commits, or its empty snapshot when it has no snapshot.json.
 */
export const committedSnapshot = Effect.fn("committedSnapshot")(function* (
	schema: ConfiguredSchema,
	tree: SchemaTree
): Effect.fn.Return<DeploySnapshot, CliError> {
	if (Option.isNone(tree.snapshotText)) {
		return emptySnapshot({ schemaName: schema.declared, schema: schema.ident })
	}
	const read = readSnapshot(tree.snapshotText.value)
	if (Result.isFailure(read)) {
		return yield* cliError(
			new SnapshotUnreadable({
				schema: schema.declared,
				directory: tree.directory,
				error: read.failure
			})
		)
	}
	const snapshot = read.success
	if (snapshot.schema !== schema.ident || snapshot.schemaName !== schema.declared) {
		return yield* cliError(
			new SnapshotForeign({
				schema: schema.declared,
				ident: schema.ident,
				directory: tree.directory,
				found: { schemaName: snapshot.schemaName, schema: snapshot.schema }
			})
		)
	}
	return snapshot
})

/** A committed folder whose meta.json reads, with its name and its files' texts. */
interface CommittedFolder {
	readonly name: string
	readonly meta: ReadMeta
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

/**
 * What a folder's meta.json says to the chain: it does not read (`unreadable`), it is another schema's (`foreign`), it
 * is a placed folder's link that breaks the chain where the walk reaches it (`unlinked`), or none of these (`sound`).
 */
type FolderMeta =
	| { readonly kind: "unreadable"; readonly failure: CompileError }
	| { readonly kind: "foreign" | "unlinked" | "sound"; readonly meta: ReadMeta }

/**
 * A committed folder, read once: its name places it in chain order, the timestamp of `<YYYYMMDDHHMMSS>_<name>`
 * (`placed`), or does not (`misnamed`), and its meta.json, as the chain judges it.
 */
interface ReadFolder {
	readonly name: string
	readonly place: "placed" | "misnamed"
	readonly meta: FolderMeta
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

/**
 * The committed chain as one walk reads it: every folder, read once, in folder order, and the fingerprint the link walk
 * reaches. The walk judges the links of the placed folders in timestamp order, from the empty snapshot, up to the first
 * whose meta.json is not this schema's link from the fingerprint it reached; a misnamed folder has no place in it.
 */
interface CommittedChain {
	readonly folders: ReadonlyArray<ReadFolder>
	readonly reached: string
}

/** The fault a folder's meta.json is to the chain, when it is one. */
const folderFault = (folder: ReadFolder): ChainFault | undefined => {
	const m = folder.meta
	switch (m.kind) {
		case "unreadable":
			return { kind: "unreadableMeta", folder: folder.name, failure: m.failure }
		case "foreign":
			return { kind: "foreignMeta", folder: folder.name, schema: m.meta.schema }
		case "unlinked":
			return { kind: "brokenChain", folder: folder.name }
		case "sound":
			return undefined
	}
}

/** Whether every folder is placed and none is a fault: the chain a draft may continue. */
export const chainWhole = (chain: CommittedChain): boolean =>
	Arr.every(chain.folders, (f) => f.place === "placed" && f.meta.kind === "sound")

/** A folder as it is read, before the walk judges its meta.json. */
interface ReadFolderInput {
	readonly name: string
	readonly place: ReadFolder["place"]
	readonly meta: Result.Result<ReadMeta, CompileError>
	readonly files: ReadFolder["files"]
}

/** The one walk of a schema's committed chain, which `grizzle check` reports and `grizzle generate` continues. */
export const committedChain = (schema: ConfiguredSchema, tree: SchemaTree): CommittedChain => {
	const read = Arr.map(tree.folders, (f): ReadFolderInput => ({
		name: f.name,
		place: isFolderName(f.name) ? "placed" : "misnamed",
		meta: readMeta(f.metaText),
		files: f.files
	}))
	const own = (meta: Result.Result<ReadMeta, CompileError>): ReadMeta | undefined =>
		Result.isSuccess(meta) && meta.success.schema === schema.ident ? meta.success : undefined
	/** The placed folders are in folder order, which is their timestamps' order, the timestamp leading the name. */
	const placed = Arr.filter(read, (f) => f.place === "placed")
	/** The walk from the placed folder at `at`, which the fingerprint `reached` must link: where it stops, and what it reached. */
	const walk = (
		at: number,
		reached: string
	): { readonly stop: ReadFolderInput | undefined; readonly reached: string } => {
		const folder = placed[at]
		const meta = folder === undefined ? undefined : own(folder.meta)
		return meta === undefined || meta.source !== reached
			? { stop: folder, reached }
			: walk(at + 1, meta.target)
	}
	const { stop, reached } = walk(0, emptyFingerprint(schema.ident))
	return {
		folders: Arr.map(read, (f) => ({
			name: f.name,
			place: f.place,
			files: f.files,
			meta: Result.isFailure(f.meta)
				? { kind: "unreadable", failure: f.meta.failure }
				: {
						kind:
							f.meta.success.schema !== schema.ident
								? "foreign"
								: f === stop
									? "unlinked"
									: "sound",
						meta: f.meta.success
					}
		})),
		reached
	}
}

/**
 * The chain a draft continues, whole and reaching snapshot.json's fingerprint, or the refusal of its first break: a
 * misnamed folder before any other fault.
 */
export const continuedChain = Effect.fn("continuedChain")(function* (
	schema: ConfiguredSchema,
	tree: SchemaTree,
	snapshot: DeploySnapshot
): Effect.fn.Return<
	{
		readonly timestamps: ReadonlyArray<string>
		readonly folders: ReadonlyArray<CommittedFolder>
	},
	CliError
> {
	const breaks = (fault: ChainBreak): CliError =>
		cliError(
			new ChainRefused({
				schema: schema.declared,
				ident: schema.ident,
				directory: tree.directory,
				fault
			})
		)
	const chain = committedChain(schema, tree)
	const misnamed = Arr.findFirst(chain.folders, (f) => f.place === "misnamed")
	if (Option.isSome(misnamed)) {
		return yield* breaks({ kind: "misnamed", folder: misnamed.value.name })
	}
	const fault = Arr.findFirst(chain.folders, (f) => Option.fromUndefinedOr(folderFault(f)))
	if (Option.isSome(fault)) {
		return yield* breaks(fault.value)
	}
	const folders = Arr.flatMap(chain.folders, (f): ReadonlyArray<CommittedFolder> =>
		f.meta.kind === "unreadable" ? [] : [{ name: f.name, meta: f.meta.meta, files: f.files }]
	)
	if (chain.reached !== snapshot.fingerprint) {
		const newest = Arr.last(folders)
		return yield* breaks(
			Option.isNone(newest)
				? { kind: "unreached", snapshot: snapshot.fingerprint }
				: {
						kind: "diverged",
						folder: newest.value.name,
						reached: chain.reached,
						snapshot: snapshot.fingerprint
					}
		)
	}
	return { timestamps: Arr.map(folders, (f) => folderTimestamp(f.name)), folders }
})
