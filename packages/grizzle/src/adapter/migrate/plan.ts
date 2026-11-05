import { Array as Arr, Option, Result } from "effect"
import {
	type AppliedEdit,
	AppliedEdited,
	FolderRefused,
	LossesUndecided,
	MarkersUnresolved,
	type MigrateError,
	SnapshotUnreached,
	stopped,
	type UnresolvedLoss,
	type UnresolvedMarker
} from "#adapter/migrate/errors.ts"
import type { ParsedFile, ParsedFolder, ParsedTarget } from "#adapter/migrate/input.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import {
	decideFolder,
	type LedgerState,
	type RecordedFolder
} from "#compiler/deploy/ledger/ledger.ts"
import { lossDecisions, lossText } from "#compiler/deploy/render/folder.ts"
import { findMarkers } from "#compiler/deploy/render/markers.ts"

/**
 * A folder the apply runs: one no apply started, every file of it, or the partially applied one, resumed at the files it
 * has not completed, in ordinal order.
 */
type FolderRun =
	| { readonly kind: "start"; readonly folder: ParsedFolder }
	| {
			readonly kind: "resume"
			readonly folder: ParsedFolder
			readonly files: ReadonlyArray<ParsedFile>
	  }

/**
 * Which files `grizzle migrate` runs, decided before any of them runs.
 *
 * The ledger's state (ledger/ledger.ts ledgerState) says which folders completed, the database's latest target, and
 * the one folder a failed apply left partial. Folders are taken in name order, which is creation order,
 * and each one is decided against the state the earlier ones leave (decideFolder):
 *
 * - a completed folder is skipped;
 * - the partial folder resumes at its first file without a row: a rerun after a failure resumes at the failed file;
 * - a new folder runs every file, but only when no folder is partial, when it sorts after every recorded folder, and
 *   when its source fingerprint is the latest target, which the folders before it in this apply advance; otherwise
 *   the whole apply is refused before any statement runs.
 *
 * Every recorded folder's texts must still be the ones that ran: each row's digest is compared with the SHA-256 of the
 * file of its ordinal, meta.json included, so an applied file edited, renamed or deleted afterwards, or a file added to
 * a folder that completed, is refused with every such file named, before anything else is decided (stage `edited`).
 * The database ran what the ledger records; the repository must say the same, so the fix is to restore it.
 *
 * The chain must end at the snapshot the application knows: after the last folder the latest target is that
 * snapshot's fingerprint, which is what admission then requires of the ledger. Folders that end
 * elsewhere, or a ledger at a target no folder leads from, are refused the same way. Finally every file that will run
 * is searched for unresolved placeholders, and one is refused, with every marker found, before any statement runs;
 * then every loss of stored data a folder that runs drafts must be decided (lossDecisions), its statement written in
 * or left out, and an unresolved one is refused the same way.
 *
 * The files a run runs, in ordinal order.
 */
export const runFiles = (r: FolderRun): ReadonlyArray<ParsedFile> =>
	r.kind === "start" ? r.folder.files : r.files

export interface ApplyPlan {
	readonly schema: string
	readonly before: LedgerState
	readonly runs: ReadonlyArray<FolderRun>
	/** The latest target once every run completed: the known snapshot's fingerprint. */
	readonly after: SchemaFingerprint
}

/**
 * The state once a folder that runs, new or the partial one resumed, completed: the folder decideFolder applies is
 * never a complete one.
 */
const advance = (state: LedgerState, folder: ParsedFolder): LedgerState => {
	const done: RecordedFolder = {
		folder: folder.name,
		source: folder.meta.source,
		target: folder.meta.target,
		files: folder.files.length,
		recorded: [
			{ ordinal: 0, file: "meta.json", digest: folder.metaDigest },
			...Arr.map(folder.files, (f) => ({ ordinal: f.ordinal, file: f.name, digest: f.digest }))
		]
	}
	return { latest: folder.meta.target, complete: [...state.complete, done], partial: undefined }
}

/** The applied files of the recorded folders whose texts are no longer the ones that ran. */
const appliedEdits = (target: ParsedTarget, state: LedgerState): ReadonlyArray<AppliedEdit> => {
	/**
	 * The edits of a recorded folder: its meta.json missing, when the directory no longer holds it; else each row whose
	 * file is missing or edited, and what `beyond` finds of the folder's files beyond its rows.
	 */
	const editsOf = (
		recorded: RecordedFolder,
		beyond: (folder: ParsedFolder) => ReadonlyArray<AppliedEdit>
	): ReadonlyArray<AppliedEdit> => {
		const found = Arr.findFirst(target.folders, (f) => f.name === recorded.folder)
		if (Option.isNone(found)) {
			return [{ folder: recorded.folder, file: "meta.json", kind: "missing" }]
		}
		const folder = found.value
		const at = (file: string, kind: AppliedEdit["kind"]): ReadonlyArray<AppliedEdit> => [
			{ folder: folder.name, file, kind }
		]
		const rows = Arr.flatMap(recorded.recorded, (row): ReadonlyArray<AppliedEdit> => {
			if (row.ordinal === 0) {
				return row.digest === folder.metaDigest ? [] : at("meta.json", "edited")
			}
			const file = Arr.findFirst(folder.files, (f) => f.ordinal === row.ordinal)
			if (Option.isNone(file) || file.value.name !== row.file) {
				return at(row.file, "missing")
			}
			return file.value.digest === row.digest ? [] : at(row.file, "edited")
		})
		return [...rows, ...beyond(folder)]
	}
	/**
	 * A complete folder holds no file beyond its rows; the partial folder's files without a row are the ones it resumes
	 * at.
	 */
	const added = (recorded: RecordedFolder) => (folder: ParsedFolder) =>
		Arr.flatMap(folder.files, (f): ReadonlyArray<AppliedEdit> =>
			Arr.some(recorded.recorded, (r) => r.ordinal === f.ordinal && r.file === f.name)
				? []
				: [{ folder: folder.name, file: f.name, kind: "added" }]
		)
	return [
		...Arr.flatMap(state.complete, (recorded) => editsOf(recorded, added(recorded))),
		...(state.partial === undefined ? [] : editsOf(state.partial, () => []))
	]
}

export const planApply = (
	target: ParsedTarget,
	state: LedgerState
): Result.Result<ApplyPlan, MigrateError> => {
	const schema = target.schema
	const edits = appliedEdits(target, state)
	if (Arr.isReadonlyArrayNonEmpty(edits)) {
		return Result.fail(stopped(new AppliedEdited({ schema, edits })))
	}
	const runs: Array<FolderRun> = []
	let at = state
	for (const folder of target.folders) {
		const decision = decideFolder(at, {
			folder: folder.name,
			source: folder.meta.source,
			target: folder.meta.target,
			ordinals: Arr.map(folder.files, (f) => f.ordinal)
		})
		switch (decision.kind) {
			case "refused":
				return Result.fail(
					stopped(new FolderRefused({ schema, folder: folder.name, refusal: decision.refusal }))
				)
			case "applied":
				continue
			case "start":
				runs.push({ kind: "start", folder })
				break
			case "resume": {
				const run = new Set(decision.run)
				runs.push({
					kind: "resume",
					folder,
					files: Arr.filter(folder.files, (f) => run.has(f.ordinal))
				})
				break
			}
		}
		at = advance(at, folder)
	}
	const known = target.snapshot.fingerprint
	if (at.latest !== known) {
		return Result.fail(
			stopped(
				new SnapshotUnreached({
					schema,
					known,
					reached: at.latest,
					by: runs.length === 0 ? "ledger" : "folders"
				})
			)
		)
	}
	const markers: Array<UnresolvedMarker> = []
	for (const r of runs) {
		for (const f of runFiles(r)) {
			for (const m of findMarkers(f.text)) {
				markers.push({ folder: r.folder.name, file: f.name, kind: m.kind, line: m.line })
			}
		}
	}
	if (Arr.isReadonlyArrayNonEmpty(markers)) {
		return Result.fail(stopped(new MarkersUnresolved({ schema, markers })))
	}
	const losses: Array<UnresolvedLoss> = []
	for (const r of runs) {
		if (r.folder.meta.kind === "drafted") {
			for (const d of lossDecisions(r.folder.meta.record, r.folder.files)) {
				if (d.kind === "unresolved") {
					losses.push({ folder: r.folder.name, file: d.file, loses: lossText(d.loss.loses) })
				}
			}
		}
	}
	if (Arr.isReadonlyArrayNonEmpty(losses)) {
		return Result.fail(stopped(new LossesUndecided({ schema, losses })))
	}
	return Result.succeed({ schema, before: state, runs, after: at.latest })
}
