import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { Array as Arr, Effect, Option, Result } from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import { type CommittedSnapshot, readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { ConfiguredSchema } from "#cli/config.ts"
import {
	type ChainBreak,
	type ChainFault,
	ChainRefused,
	type CliError,
	cliError,
	SnapshotForeign,
	SnapshotFormat,
	SnapshotUnreadable
} from "#cli/errors.ts"
import type { SchemaTree } from "#cli/files.ts"
import type { CompileError } from "#compiler/plan/common.ts"
import {
	folderParts,
	type ReadMeta,
	type TimestampParts,
	timestampText
} from "#compiler/plan/migration.ts"
import { type DeploySnapshot, emptyFingerprint, emptySnapshot } from "#compiler/plan/serve.ts"

/**
 * What a schema's directory commits: its empty snapshot, before its first migration, which is no file and records no
 * derived facts; or the snapshot its two files lay out, with the derived runtime facts snapshot.json records.
 */
export type Committed =
	| { readonly kind: "empty"; readonly snapshot: DeploySnapshot }
	| ({ readonly kind: "files" } & CommittedSnapshot)

/**
 * A schema's committed migration state as the command line reads it: its snapshot's two files and its folders.
 *
 * The snapshot is read by the generator's own reader, which refuses a pair of another format than this grizzle's
 * (SnapshotFormat, the one refusal check, generate, migrate, drift and names read of it) and trusts the record once its
 * seal holds (boundary/snapshot.ts readSnapshot). A schema without them is at
 * its empty snapshot, whose fingerprint depends on the installed schema identifier alone (snapshot/build.ts
 * emptySnapshot): the empty snapshot is never a file. The snapshot must be the configured schema's: its PostgreSQL
 * schema and declared name are the configuration's. It names no owner: the migration identity is whoever connects.
 *
 * What the schema's directory commits: the snapshot its files lay out and the derived facts they record, or its empty
 * snapshot when it has neither snapshot file.
 */
export const committedSnapshot = Effect.fn("committedSnapshot")(function* (
	schema: ConfiguredSchema,
	tree: SchemaTree
): Effect.fn.Return<Committed, CliError> {
	if (Option.isNone(tree.snapshotFiles)) {
		const empty: Committed = {
			kind: "empty",
			snapshot: emptySnapshot({ schemaName: schema.root, schema: schema.ident })
		}
		return empty
	}
	const read = readSnapshot(tree.snapshotFiles.value)
	if (Result.isFailure(read)) {
		const reason = read.failure.reason
		return yield* cliError(
			reason._tag === "ArtifactFormat"
				? new SnapshotFormat({
						schema: schema.declared,
						directory: tree.directory,
						recorded: reason.recorded,
						expected: reason.expected
					})
				: new SnapshotUnreadable({
						schema: schema.declared,
						directory: tree.directory,
						error: read.failure
					})
		)
	}
	const snapshot = read.success.snapshot
	if (snapshot.schema !== schema.ident || snapshot.schemaName !== schema.root) {
		return yield* cliError(
			new SnapshotForeign({
				schema: schema.declared,
				ident: schema.ident,
				directory: tree.directory,
				found: { schemaName: snapshot.schemaName, schema: snapshot.schema }
			})
		)
	}
	const committed: Committed = { kind: "files", ...read.success }
	return committed
})

/** A committed folder whose meta.json reads, with its name and its files' texts. */
interface CommittedFolder {
	readonly name: string
	readonly meta: ReadMeta
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: TextChunks }>
}

/**
 * What a folder's meta.json says to the chain: it does not read (`unreadable`), it is another schema's (`foreign`), it
 * is a placed folder's link that breaks the chain where the walk reaches it (`unlinked`), or none of these (`sound`).
 */
type FolderMeta =
	| { readonly kind: "unreadable"; readonly failure: CompileError }
	| { readonly kind: "foreign" | "unlinked" | "sound"; readonly meta: ReadMeta }

/**
 * Where a folder's name places it: by the second its `<YYYYMMDDHHMMSS>_<name>` names (`placed`, deploy/render/folder.ts
 * folderParts); nowhere, as a fork (`forked`), where the folder named before it, `previous`, names that second too; or
 * nowhere (`misnamed`), a name of no folder, a hand-made one whose digits name no second among them.
 *
 * A chain's seconds strictly increase: a new folder's is the second after its chain's last folder's (timestamp.ts
 * nextTimestamp), so two folders of one second are two drafts on one chain, a fork, whose order only their names would
 * decide, and whose links a custom migration first, its source its target, would let pass as one chain.
 */
type FolderPlace =
	| { readonly kind: "placed"; readonly timestamp: TimestampParts }
	| { readonly kind: "forked"; readonly previous: string }
	| { readonly kind: "misnamed" }

/** The last folder before a folder whose name names a second: its name, and its second's timestamp. */
interface NamedSecond {
	readonly name: string
	readonly second: string
}

/**
 * Where the folder named `name` is placed (FolderPlace) after `before`, the last folder before it in folder order whose
 * name names a second, and that last folder once it is read.
 */
const placeAfter = (
	before: Option.Option<NamedSecond>,
	name: string
): readonly [Option.Option<NamedSecond>, FolderPlace] => {
	const timestamp = folderParts(name)
	if (timestamp === undefined) {
		return [before, { kind: "misnamed" }]
	}
	const second = timestampText(timestamp)
	const place: FolderPlace =
		Option.isSome(before) && before.value.second === second
			? { kind: "forked", previous: before.value.name }
			: { kind: "placed", timestamp }
	return [Option.some({ name, second }), place]
}

/** A committed folder, read once: where its name places it in chain order, and its meta.json, as the chain judges it. */
interface ReadFolder<F extends FileText = FileText> {
	readonly name: string
	readonly place: FolderPlace
	readonly meta: FolderMeta
	readonly files: ReadonlyArray<F>
}

/** A file of a folder as the walk carries it: its name and text, and whatever its reader read of it besides. */
interface FileText {
	readonly name: string
	readonly text: TextChunks
}

/**
 * The committed chain as one walk reads it: every folder, read once, in folder order, and the fingerprint the link walk
 * reaches. The walk judges the links of the placed folders in timestamp order, from the empty snapshot, up to the first
 * whose meta.json is not this schema's link from the fingerprint it reached; a misnamed or forked folder has no place in
 * it.
 */
interface CommittedChain<F extends FileText = FileText> {
	readonly folders: ReadonlyArray<ReadFolder<F>>
	readonly reached: string
}

/** The break a folder's name is to the chain, when it is one: a name of no folder, or a fork's. */
const placeBreak = (folder: ReadFolder): ChainBreak | undefined => {
	const p = folder.place
	switch (p.kind) {
		case "misnamed":
			return { kind: "misnamed", folder: folder.name }
		case "forked":
			return { kind: "forked", folder: folder.name, previous: p.previous }
		case "placed":
			return undefined
	}
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
	Arr.every(chain.folders, (f) => f.place.kind === "placed" && f.meta.kind === "sound")

/** A folder with its meta.json read, as the walk reads it: what check reads it from (adapter/migrate/input.ts
 * FolderSource), and generate from its texts. */
interface MetaFolder<F extends FileText> {
	readonly name: string
	readonly meta: Result.Result<ReadMeta, CompileError>
	readonly files: ReadonlyArray<F>
}

/** A folder as it is read, before the walk judges its meta.json. */
interface ReadFolderInput<F extends FileText> extends MetaFolder<F> {
	readonly place: ReadFolder["place"]
}

/** The one walk of a schema's committed chain, which `grizzle check` reports and `grizzle generate` continues, over its
 * folders with their meta.json read. */
export const committedChain = <F extends FileText>(
	schema: ConfiguredSchema,
	folders: ReadonlyArray<MetaFolder<F>>
): CommittedChain<F> => {
	const [, read] = Arr.mapAccum(folders, Option.none<NamedSecond>(), (before, f) => {
		const [after, place] = placeAfter(before, f.name)
		const folder: ReadFolderInput<F> = { name: f.name, place, meta: f.meta, files: f.files }
		return [after, folder] as const
	})
	const own = (meta: Result.Result<ReadMeta, CompileError>): ReadMeta | undefined =>
		Result.isSuccess(meta) && meta.success.schema === schema.ident ? meta.success : undefined
	/** The placed folders are in folder order, which is their timestamps' order, the timestamp leading the name. */
	const placed = Arr.filter(read, (f) => f.place.kind === "placed")
	/** The walk from the placed folder at `at`, which the fingerprint `reached` must link: where it stops, and what it reached. */
	const walk = (
		at: number,
		reached: string
	): { readonly stop: ReadFolderInput<F> | undefined; readonly reached: string } => {
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

/** A schema's committed chain read whole (wholeChain): its folders' timestamps, its folders, and what its links reach. */
interface WholeChain {
	readonly timestamps: ReadonlyArray<TimestampParts>
	readonly folders: ReadonlyArray<CommittedFolder>
	readonly reached: string
}

/**
 * A schema's committed chain read whole, and the fingerprint its links reach, or the refusal of its first break: a
 * folder's name, misnamed or a fork's, before any other fault. It reads each folder's meta.json alone; a draft holds the
 * fingerprint it reaches to snapshot.json's (continuedChain).
 */
const wholeChain = Effect.fn("wholeChain")(function* (
	schema: ConfiguredSchema,
	tree: SchemaTree
): Effect.fn.Return<WholeChain, CliError> {
	const breaks = (fault: ChainBreak): CliError =>
		cliError(
			new ChainRefused({
				schema: schema.declared,
				ident: schema.ident,
				directory: tree.directory,
				fault
			})
		)
	const chain = committedChain(
		schema,
		Arr.map(tree.folders, (f) => ({ name: f.name, meta: readMeta(f.metaText), files: f.files }))
	)
	const named = Arr.findFirst(chain.folders, (f) => Option.fromUndefinedOr(placeBreak(f)))
	if (Option.isSome(named)) {
		return yield* breaks(named.value)
	}
	const fault = Arr.findFirst(chain.folders, (f) => Option.fromUndefinedOr(folderFault(f)))
	if (Option.isSome(fault)) {
		return yield* breaks(fault.value)
	}
	const folders = Arr.flatMap(chain.folders, (f): ReadonlyArray<CommittedFolder> =>
		f.meta.kind === "unreadable" ? [] : [{ name: f.name, meta: f.meta.meta, files: f.files }]
	)
	return {
		timestamps: Arr.flatMap(chain.folders, (f) =>
			f.place.kind === "placed" ? [f.place.timestamp] : []
		),
		folders,
		reached: chain.reached
	}
})

/**
 * The chain a draft continues, whole and reaching snapshot.json's fingerprint, or the refusal of its first break: a
 * folder's name, misnamed or a fork's, before any other fault (wholeChain).
 */
export const continuedChain = Effect.fn("continuedChain")(function* (
	schema: ConfiguredSchema,
	tree: SchemaTree,
	snapshot: DeploySnapshot
): Effect.fn.Return<
	{
		readonly timestamps: ReadonlyArray<TimestampParts>
		readonly folders: ReadonlyArray<CommittedFolder>
	},
	CliError
> {
	const { timestamps, folders, reached } = yield* wholeChain(schema, tree)
	if (reached !== snapshot.fingerprint) {
		const newest = Arr.last(folders)
		return yield* cliError(
			new ChainRefused({
				schema: schema.declared,
				ident: schema.ident,
				directory: tree.directory,
				fault: Option.isNone(newest)
					? { kind: "unreached", snapshot: snapshot.fingerprint }
					: {
							kind: "diverged",
							folder: newest.value.name,
							reached,
							snapshot: snapshot.fingerprint
						}
			})
		)
	}
	return { timestamps, folders }
})
