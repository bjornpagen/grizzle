import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	malformedArtifact,
	malformedDescription
} from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import type { CandidateRenames } from "#compiler/deploy/diff/plan.ts"
import { isDigit, isWords } from "#compiler/deploy/render/markers.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"

export const metaFileName = "meta.json"

/** How a drafted folder is named: by the name `--name` gives, or by one derived from the change. */
export type FolderNaming =
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "derived" }

/** Where a choice is: at the top of its file, or nested in the alternative of a candidate rename (a field's rename in its
 * relation's), decided only where the reviewer chooses that candidate. */
export type MetaWithin =
	| { readonly kind: "top" }
	| { readonly kind: "within"; readonly candidate: number }

export const topLevel: MetaWithin = { kind: "top" }

/** A statement a candidate rename decides, as a drafted file spells it from its first token (`fromFirstToken`). */
export interface MetaChoice {
	/** The drafted file it is in. */
	readonly file: string
	readonly within: MetaWithin
	/** The statement the reviewer keeps unless choosing; the placeholder token in it stands for the value written there. */
	readonly keep: string
	/** What each offered candidate replaces it with: the candidate's index in `candidates`, and the statements, none when
	 * choosing deletes it. */
	readonly offers: ReadonlyArray<{
		readonly candidate: number
		readonly statements: ReadonlyArray<string>
	}>
}

/** Where a candidate's witness is: the `statement`-th statement of its offer at the choice numbered `choice`. */
export interface MetaWitness {
	readonly choice: number
	readonly statement: number
}

/** A candidate: its label (`the candidate rename of <from> to <to>`), what it renames (the removed name it takes away
 * and the added one it becomes), the candidates, by index, it is chosen only with, and its witness: a statement of its
 * own, which no other candidate's offer holds and no choice keeps, so a reviewed folder holds it exactly when the
 * reviewer chose the candidate (`witnessesOf`). */
interface MetaCandidate {
	readonly label: string
	readonly renames: CandidateRenames
	readonly requires: ReadonlyArray<number>
	readonly witness: MetaWitness
}

/** A group of statements the reviewer confirms under one marker, as a drafted file spells them from their first token:
 * one decision, which the files keep whole, each statement as drafted, or remove whole. */
export interface MetaConfirm {
	/** The drafted file it is in. */
	readonly file: string
	readonly statements: NonEmptyReadonlyArray<string>
}

/** What a loss loses, by printed name: a relation with its rows, a field with its values, or the rows of the abandoned
 * schemas a schema's first migration leaves behind, each with its directory. */
export type MetaLosses =
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "field"; readonly relation: string; readonly field: string }
	| {
			readonly kind: "schema"
			readonly schema: string
			readonly abandoned: NonEmptyReadonlyArray<{
				readonly schema: string
				readonly directory: string
			}>
	  }

/** A statement that loses stored data, which the reviewer decides: the file it is in, where it is (in a rename's
 * alternative, a field the relation's rename drops), what it loses, the statement as the reviewer writes it in to
 * accept the loss, from its first token, and the candidates that carry the data instead, by index. */
export interface MetaLoss {
	readonly file: string
	readonly within: MetaWithin
	readonly loses: MetaLosses
	readonly statement: string
	readonly carriers: ReadonlyArray<number>
}

export interface MetaDecisions {
	/** Each candidate, by index. */
	readonly candidates: ReadonlyArray<MetaCandidate>
	readonly choices: ReadonlyArray<MetaChoice>
	readonly confirms: ReadonlyArray<MetaConfirm>
	readonly losses: ReadonlyArray<MetaLoss>
}

interface MetaFields {
	/** The declared schema name and its PostgreSQL schema. */
	readonly schemaName: string
	readonly schema: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
}

/** The meta of a folder the generator drafted, with the decisions it leaves the reviewer: the candidate renames, the
 * confirmed groups and the losses of stored data. */
export interface DraftedMeta extends MetaFields {
	readonly kind: "drafted"
	readonly decisions: MetaDecisions
}

/** The meta of a custom migration, for hand-written data steps: its source and target are one snapshot. */
export interface CustomMeta extends MetaFields {
	readonly kind: "custom"
}

export type MigrationMeta = DraftedMeta | CustomMeta

/** A candidate as a committed meta.json names it: its label, the candidates it is chosen only with, each one before it
 * in meta.json, and its witness, read as the statement it names and the file of the choice offering it. */
export interface ReadCandidate {
	readonly label: string
	readonly renames: CandidateRenames
	readonly requires: ReadonlyArray<ReadCandidate>
	readonly witness: { readonly file: string; readonly statement: string }
}

/** Where a choice is, nested in the alternative of the candidate it names. */
export type ReadWithin =
	| { readonly kind: "top" }
	| { readonly kind: "within"; readonly candidate: ReadCandidate }

/** What a candidate replaces a statement it decides with. */
export interface ReadOffer {
	readonly candidate: ReadCandidate
	readonly statements: ReadonlyArray<string>
}

/** A statement candidate renames decide, as MetaChoice records it, with each candidate it names read as the candidate. */
export interface ReadChoice {
	readonly file: string
	readonly within: ReadWithin
	readonly keep: string
	readonly offers: NonEmptyReadonlyArray<ReadOffer>
}

/** A loss as MetaLoss records it, with each candidate it names read as the candidate. */
export interface ReadLoss {
	readonly file: string
	readonly within: ReadWithin
	readonly loses: MetaLosses
	readonly statement: string
	readonly carriers: ReadonlyArray<ReadCandidate>
}

/** meta.json's decisions as a committed folder's are read: each candidate number read as the candidate it names. */
export interface ReadDecisions {
	readonly candidates: ReadonlyArray<ReadCandidate>
	readonly choices: ReadonlyArray<ReadChoice>
	readonly confirms: ReadonlyArray<MetaConfirm>
	readonly losses: ReadonlyArray<ReadLoss>
}

/** A committed folder's meta.json as readMeta reads it. */
export type ReadMeta =
	| (MetaFields & { readonly kind: "drafted"; readonly decisions: ReadDecisions })
	| CustomMeta

interface MigrationFile {
	readonly name: string
	readonly text: string
}

/** A migration folder `migrations/<schema>/<timestamp>_<name>/` and its meta.json.
 *
 * Each declared schema has its own directory `migrations/<schema>/`, holding its snapshot.json and its folders.
 * A folder holds the drafted `NN-<phase>.sql` files and `meta.json`, which records
 * the folder's source and target snapshot fingerprints: `grizzle migrate` refuses a folder whose source is not
 * the database's latest applied target before any statement runs, and records both in the ledger.
 * The CLI supplies the timestamp, since the compiler reads no clock: fourteen digits,
 * `YYYYMMDDHHMMSS` in UTC, so folders sort in creation order by name. meta.json also records the folder's kind:
 * drafted, or a custom migration, whose source and target are the same snapshot. A drafted folder records the
 * reviewer's decisions in `decisions`, empty for a folder with none: each statement a choice decides, and what each
 * candidate replaces it with, each candidate's witness, the statement of its own whose presence decides it, what it
 * renames, each group of statements the reviewer confirms as one, and each statement that loses stored data, with
 * what it loses and the candidates that carry it instead, as the files spell them. So `grizzle check` decides each
 * candidate once from its witness and reads back that every file follows the decisions, that no two chosen candidates
 * rename one name, that each group stands whole or is gone whole, and that every loss is decided, its statement
 * written in or a candidate that carries it chosen (`splitRenames`, lossDecisions), comparing statements as
 * PostgreSQL's scanner reads them (`writtenAs`). A custom migration drafts nothing, so it has no `decisions`:
 * grizzle does not read its hand-written statements. */
export interface MigrationFolder {
	/** `<timestamp>_<name>`. */
	readonly name: string
	readonly meta: MigrationMeta
	readonly metaText: string
	readonly files: ReadonlyArray<MigrationFile>
}

export interface DraftedFolder extends MigrationFolder {
	readonly meta: DraftedMeta
}

/** Whether every character of `text` is an ASCII digit. */
const allDigits = (text: string): boolean => {
	for (const ch of text) {
		if (!isDigit(ch)) {
			return false
		}
	}
	return true
}

const isTimestamp = (text: string): boolean => text.length === 14 && allDigits(text)
export const maxMigrationNameLength = 100

/** The folder name of a migration; the name is lowercase ASCII words joined by `_` or `-`. */
export const folderName = (
	timestamp: string,
	name: string
): Result.Result<string, CompileError> => {
	if (!isTimestamp(timestamp)) {
		return Result.err(
			malformedDescription(
				SourceLoc("migration folder", []),
				`a timestamp of fourteen digits YYYYMMDDHHMMSS, not ${JSON.stringify(timestamp)}`
			)
		)
	}
	if (!isWords(name) || name.length > maxMigrationNameLength) {
		return Result.err(
			malformedDescription(
				SourceLoc("migration folder", []),
				`a name of lowercase ASCII letters and digits joined by _ or -, at most ${maxMigrationNameLength} characters, not ${JSON.stringify(name)}`
			)
		)
	}
	return Result.ok(`${timestamp}_${name}`)
}

/** Whether a directory name is a migration folder's: `<14 digits>_<words>`. */
export const isFolderName = (name: string): boolean =>
	isTimestamp(name.slice(0, 14)) && name[14] === "_" && isWords(name.slice(15))

/** A drafted SQL file's ordinal: `NN-<phase>.sql`, or any `NN-<words>.sql` a reviewer adds, NN at least two digits and
 * positive. */
const fileOrdinal = (name: string): number | undefined => {
	if (!name.endsWith(".sql")) {
		return undefined
	}
	const stem = name.slice(0, -".sql".length)
	const dash = stem.indexOf("-")
	if (dash < 2) {
		return undefined
	}
	const digits = stem.slice(0, dash)
	if (!allDigits(digits) || !isWords(stem.slice(dash + 1))) {
		return undefined
	}
	const n = Number(digits)
	return n > 0 ? n : undefined
}

/** The text of meta.json. */
export const writeMeta = (meta: MigrationMeta): Result.Result<string, CompileError> =>
	writeJsonText(meta)

/** The refusal of a folder's decisions that break their form. */
const refused = (): never => {
	throw new Refusal(
		malformedArtifact(
			"meta",
			["decisions"],
			"the candidates, confirmed groups and losses of a drafted folder, each candidate requiring only candidates before it and witnessed by a statement of its own offer, each choice offering one of them at least, and each loss naming only them"
		)
	)
}

/** A drafted folder's decisions, each candidate number read as the candidate it names: a
 * candidate requires only candidates before it, its witness names a statement of its own offer, every choice offers
 * one candidate at least, and a number naming no such candidate, choice or statement is refused. */
export const readDecisions = (
	decisions: MetaDecisions
): Result.Result<ReadDecisions, CompileError> =>
	catchRefusal(() => {
		const read: Array<ReadCandidate> = []
		/** The candidate `n` names among `known`. */
		const named = (n: number, known: ReadonlyArray<ReadCandidate>): ReadCandidate => {
			const candidate = known[n]
			return candidate ?? refused()
		}
		for (const [n, c] of decisions.candidates.entries()) {
			const choice = decisions.choices[c.witness.choice]
			if (choice === undefined) {
				return refused()
			}
			const statement = choice.offers.find((o) => o.candidate === n)?.statements[
				c.witness.statement
			]
			if (statement === undefined) {
				return refused()
			}
			read.push({
				label: c.label,
				renames: c.renames,
				requires: c.requires.map((k) => named(k, read)),
				witness: { file: choice.file, statement }
			})
		}
		const within = (w: MetaWithin): ReadWithin =>
			w.kind === "top" ? { kind: "top" } : { kind: "within", candidate: named(w.candidate, read) }
		const choices = decisions.choices.map((c): ReadChoice => {
			const offers = c.offers.map((o) => ({
				candidate: named(o.candidate, read),
				statements: o.statements
			}))
			if (!isNonEmpty(offers)) {
				return refused()
			}
			return { file: c.file, within: within(c.within), keep: c.keep, offers }
		})
		const losses = decisions.losses.map((l): ReadLoss => ({
			file: l.file,
			within: within(l.within),
			loses: l.loses,
			statement: l.statement,
			carriers: l.carriers.map((k) => named(k, read))
		}))
		return { candidates: read, choices, confirms: decisions.confirms, losses }
	})

/** Reads a folder's decoded meta.json: what its form alone does not say. The shell decodes
 * meta.json's form once, as writeMeta writes it (its boundary decoder), and hands the meta here. A custom migration's
 * source and target are one snapshot; a drafted folder's decisions read (readDecisions). */
export const readDecodedMeta = (meta: MigrationMeta): Result.Result<ReadMeta, CompileError> => {
	switch (meta.kind) {
		case "custom":
			return meta.source === meta.target
				? Result.ok(meta)
				: Result.err(
						malformedArtifact(
							"meta",
							[],
							"a custom migration whose source and target are one snapshot"
						)
					)
		case "drafted":
			return Result.map(readDecisions(meta.decisions), (decisions) => ({ ...meta, decisions }))
	}
}

/** The files of a folder in apply order, each with its ordinal; two files with one ordinal, or a file that is not
 * `NN-*.sql`, is refused. */
export const orderFolderFiles = <F extends { readonly name: string }>(
	files: ReadonlyArray<F>
): Result.Result<ReadonlyArray<{ readonly file: F; readonly ordinal: number }>, CompileError> =>
	catchRefusal(() => {
		const out: Array<{ readonly file: F; readonly ordinal: number }> = []
		for (const file of files) {
			const name = file.name
			if (name === metaFileName) {
				continue
			}
			const parsed = fileOrdinal(name)
			if (parsed === undefined) {
				throw new Refusal(
					malformedArtifact(
						"folder",
						[],
						`files named NN-<phase>.sql beside meta.json; ${name} is not one`
					)
				)
			}
			const ordinal = parsed
			if (out.some((f) => f.ordinal === ordinal)) {
				throw new Refusal(
					malformedArtifact("folder", [], `one file per ordinal; ${ordinal} has two`)
				)
			}
			out.push({ file, ordinal })
		}
		return out.toSorted(mapInput(compareNumbers, (f: { readonly ordinal: number }) => f.ordinal))
	})
