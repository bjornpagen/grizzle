import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import {
	completedFiles,
	type LedgerState,
	type RecordedFolder
} from "#compiler/deploy/ledger/ledger.ts"
import { type ReadMeta, recordsAsWritten } from "#compiler/deploy/render/folder.ts"

/**
 * A pending folder as `grizzle migrate` read it, decided before any statement runs: its name, its meta.json as read and
 * the SHA-256 of its text, and its SQL files in ordinal order, each with its text and whether it runs statement by
 * statement (`-- grizzle: no-transaction`).
 */
export interface FolderToApply {
	readonly name: string
	readonly meta: ReadMeta
	readonly metaDigest: string
	readonly files: ReadonlyArray<{
		readonly ordinal: number
		readonly name: string
		readonly text: string
		readonly noTransaction: boolean
	}>
}

/**
 * Why a pending folder cannot continue the ledger's chain: the ledger recorded it with other fingerprints than its
 * meta.json names (`moved`); it was started with another number of files than it holds now (`resized`); it was redrafted
 * after it started, and its meta.json does not record a file that completed as it ran (`redrafted`), or the file it
 * would resume at runs outside a transaction, so it may have partly run under the draft that started it
 * (`redraftUnverifiable`); another folder is partially applied, and resumes first (`partialFirst`); it sorts before the
 * latest applied folder (`sortsBefore`); or it starts from another snapshot than the database's latest applied target
 * (`source`).
 */
export type FolderRefusal =
	| {
			readonly kind: "moved"
			readonly source: SchemaFingerprint
			readonly target: SchemaFingerprint
	  }
	| { readonly kind: "resized"; readonly started: number; readonly holds: number }
	| { readonly kind: "redrafted"; readonly file: string }
	| { readonly kind: "redraftUnverifiable"; readonly file: string }
	| { readonly kind: "partialFirst"; readonly partial: string }
	| { readonly kind: "sortsBefore"; readonly applied: string }
	| {
			readonly kind: "source"
			readonly source: SchemaFingerprint
			readonly latest: SchemaFingerprint
	  }

/**
 * What a resume under a redraft records of its folder, in the transaction of the file it resumes at (ledger.ts
 * redraftFolder): the SHA-256 of the redraft's meta.json, on the folder row, and the redraft's target, on every row of
 * the folder.
 */
export interface Redraft {
	readonly meta: string
	readonly target: SchemaFingerprint
}

/**
 * How a pending folder continues the ledger's chain: already applied; started, every file; the partial folder resumed
 * at the files `run` it has not completed, under the draft that started it (`resume`) or under a redraft its ledger rows
 * take (`redraft`); or refused.
 */
export type FolderDecision =
	| { readonly kind: "applied" }
	| { readonly kind: "start" }
	| { readonly kind: "resume"; readonly run: ReadonlyArray<number> }
	| { readonly kind: "redraft"; readonly run: ReadonlyArray<number>; readonly record: Redraft }
	| { readonly kind: "refused"; readonly refusal: FolderRefusal }

const refused = (refusal: FolderRefusal): FolderDecision => ({ kind: "refused", refusal })

/** A recorded folder's rows name fingerprints other than the ones its meta.json names. */
const moved = (recorded: RecordedFolder): FolderDecision =>
	refused({ kind: "moved", source: recorded.source, target: recorded.target })

/**
 * How the partial folder resumes. Its identity for a resume is its source and the files that completed, each by the
 * digest of the text that ran, which the apply's `edited` stage has compared with the folder's files already
 * (adapter/migrate/plan.ts appliedEdits), so every completed file is the one that ran. Then:
 *
 * - a folder of another source, or of another number of files, is refused;
 * - one whose meta.json is the one the ledger records resumes under the draft that started it;
 * - one whose meta.json is another, a redraft, resumes under the redraft exactly when its meta.json records every
 *   completed file as it ran (recordsAsWritten) and the file it resumes at runs in a transaction, and the ledger then
 *   takes the redraft's meta.json digest and target in that file's transaction (Redraft). A file that records no such
 *   completed file is refused, naming the first one. So is one that resumes at a no-transaction file: its folder row
 *   was recorded before its first statement and each statement commits alone, so the ledger cannot tell whether the
 *   started draft's version of that file partly ran. Under its own draft the file reruns from its first statement,
 *   which its drafted statements make safe; under a redraft the statements that ran may be another draft's, so the
 *   operator decides: finish the folder under the draft that started it, or settle the catalog by hand.
 */
const resumed = (partial: RecordedFolder, folder: FolderToApply): FolderDecision => {
	if (partial.source !== folder.meta.source) {
		return moved(partial)
	}
	if (partial.files !== folder.files.length) {
		return refused({ kind: "resized", started: partial.files, holds: folder.files.length })
	}
	const done = new Set(completedFiles(partial))
	const run = folder.files.flatMap((f) => (done.has(f.ordinal) ? [] : [f.ordinal]))
	if (partial.meta === folder.metaDigest) {
		return partial.target === folder.meta.target ? { kind: "resume", run } : moved(partial)
	}
	const unrecorded = folder.files.find(
		(f) => done.has(f.ordinal) && !recordsAsWritten(folder.meta, f)
	)
	if (unrecorded !== undefined) {
		return refused({ kind: "redrafted", file: unrecorded.name })
	}
	const next = folder.files.find((f) => !done.has(f.ordinal))
	return next?.noTransaction === true
		? refused({ kind: "redraftUnverifiable", file: next.name })
		: { kind: "redraft", run, record: { meta: folder.metaDigest, target: folder.meta.target } }
}

/**
 * How a pending folder continues the chain the ledger's state `state` records: a complete folder is applied when its
 * rows name its meta.json's fingerprints; the partial folder resumes (resumed); a new folder starts when no folder is
 * partial, when it sorts after every recorded folder, and when its source is the latest target.
 */
export const decideFolder = (state: LedgerState, folder: FolderToApply): FolderDecision => {
	const complete = state.complete.find((f) => f.folder === folder.name)
	if (complete !== undefined) {
		return complete.source === folder.meta.source && complete.target === folder.meta.target
			? { kind: "applied" }
			: moved(complete)
	}
	const partial = state.partial
	if (partial !== undefined && partial.folder === folder.name) {
		return resumed(partial, folder)
	}
	if (partial !== undefined) {
		return refused({ kind: "partialFirst", partial: partial.folder })
	}
	/** Folders apply in name order, which is their creation order: the latest target and the partial
	 * folder are both read by name, so a new folder that sorts before a recorded one is out of order. */
	const last = state.complete.at(-1)
	if (last !== undefined && compareCodePoints(folder.name, last.folder) <= 0) {
		return refused({ kind: "sortsBefore", applied: last.folder })
	}
	if (folder.meta.source !== state.latest) {
		return refused({ kind: "source", source: folder.meta.source, latest: state.latest })
	}
	return { kind: "start" }
}
