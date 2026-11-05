import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	malformedArtifact,
	malformedDescription
} from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { derived, published } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import {
	isDigit,
	isWords,
	type StatementToken,
	splitStatements,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"

export const metaFileName = "meta.json"

declare const migrationNameBrand: unique symbol

/**
 * A migration folder's name after its timestamp: lowercase ASCII letters and digits in words joined by `_` or `-`, at
 * most maxMigrationNameLength bytes. Minted only here: by parseMigrationName, from the name `--name` gives, and by
 * changeMigrationName, initMigrationName and updateMigrationName, for a name derived from the change
 * (render/naming.ts derivedMigrationName).
 */
export type MigrationName = string & { readonly [migrationNameBrand]: true }

const migrationName = nominal<string, MigrationName>()

/** How a drafted folder is named: by the name `--name` gives, or by one derived from the change. */
export type FolderNaming =
	| { readonly kind: "named"; readonly name: MigrationName }
	| { readonly kind: "derived" }

/** What a loss loses, by printed name: the rows of the abandoned schemas a schema's first migration leaves behind,
 * each with its directory. */
export interface MetaLosses {
	readonly kind: "schema"
	readonly schema: string
	readonly abandoned: NonEmptyReadonlyArray<{
		readonly schema: string
		readonly directory: string
	}>
}

/** One step of a drafted file, every statement in its place, each as the file spells it from its first token:
 * - `statement`: a drafted statement, the reviewer's to keep or edit;
 * - `loss`: a statement that loses stored data no declaration names, decided by being written in;
 * - `confirm`: statements kept whole or removed whole. */
export type MetaStep =
	| { readonly kind: "statement"; readonly statement: string }
	| { readonly kind: "loss"; readonly loses: MetaLosses; readonly statement: string }
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<string> }

/** A drafted file's steps, in draft order. */
export interface MetaFile {
	readonly name: string
	readonly steps: ReadonlyArray<MetaStep>
}

interface MetaFields {
	/** The declared schema name and its PostgreSQL schema. */
	readonly schemaName: string
	readonly schema: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
}

/** The meta of a folder the generator drafted: the renames and drops it was drafted under, as `--rename` and `--drop`
 * declared them, and its decision record, every drafted statement of every file in its place in the draft, so each
 * statement's owner is its position. */
export interface DraftedMeta extends MetaFields {
	readonly kind: "drafted"
	readonly declared: Declarations
	readonly files: ReadonlyArray<MetaFile>
}

/** The meta of a custom migration, for hand-written data steps: its source and target are one snapshot. */
export interface CustomMeta extends MetaFields {
	readonly kind: "custom"
}

export type MigrationMeta = DraftedMeta | CustomMeta

/** A recorded statement: its text as meta.json records it, and its tokens, read once (statementTokens). */
export interface Spelled {
	readonly text: string
	readonly tokens: ReadonlyArray<StatementToken>
}

const spell = (text: string): Spelled => ({ text, tokens: statementTokens(text) })

export interface ReadLoss {
	readonly kind: "loss"
	readonly loses: MetaLosses
	readonly statement: Spelled
}

/** A step of the record, read. */
export type ReadStep =
	| { readonly kind: "statement"; readonly statement: Spelled }
	| ReadLoss
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<Spelled> }

export interface ReadFile {
	readonly name: string
	readonly steps: ReadonlyArray<ReadStep>
}

interface RecordBody {
	readonly files: ReadonlyArray<ReadFile>
}

declare const decisionRecordBrand: unique symbol

/** A drafted folder's decisions, proved readable by its one constructor (decisionRecord): every statement whose
 * presence decides something, a loss's statement or a confirmed statement, is written unlike every other recorded
 * statement, so a review's text tells each decision apart. */
export type DecisionRecord = RecordBody & { readonly [decisionRecordBrand]: true }

const proved = nominal<RecordBody, DecisionRecord>()

/** A recorded statement where it stands, as a refusal names it. */
export interface RecordSite {
	readonly file: string
	readonly statement: string
	readonly at: string
}

/** Why a record is unreadable: two statements a review cannot tell apart, one of them deciding something. */
export interface RecordFault {
	readonly kind: "indistinct"
	readonly decided: RecordSite
	readonly other: RecordSite
}

/** The rule a record breaks, as a refusal says it. */
export const recordFaultText = (fault: RecordFault): string =>
	`${fault.decided.at} in ${fault.decided.file} and ${fault.other.at} in ${fault.other.file} are spelled alike (${fault.decided.statement}), so the reviewed SQL cannot tell the two decisions apart`

/** A record step, read. */
const readStep = (s: MetaStep): ReadStep => {
	switch (s.kind) {
		case "statement":
			return { kind: "statement", statement: spell(s.statement) }
		case "loss":
			return { kind: "loss", loses: s.loses, statement: spell(s.statement) }
		case "confirm":
			return { kind: "confirm", statements: mapNonEmpty(s.statements, (x) => spell(x)) }
	}
}

/** A recorded statement where it stands, and whether its presence decides something. */
interface Site extends RecordSite {
	readonly spelled: Spelled
	readonly decides: boolean
}

/** A step's recorded statements where they stand in the file `file` (Site). */
const stepSites = (file: string, s: ReadStep): ReadonlyArray<Site> => {
	const site = (spelled: Spelled, at: string, decides: boolean): Site => ({
		file,
		statement: spelled.text,
		at,
		spelled,
		decides
	})
	switch (s.kind) {
		case "statement":
			return [site(s.statement, "a statement", false)]
		case "loss":
			return [site(s.statement, "the statement of a data loss", true)]
		case "confirm":
			return s.statements.map((x) => site(x, "a confirmed statement", true))
	}
}

/** Every recorded statement of a file where it stands (Site). */
const sitesIn = (file: ReadFile): ReadonlyArray<Site> =>
	file.steps.flatMap((s) => stepSites(file.name, s))

/** Every statement whose presence decides something is written unlike every other recorded statement, either way
 * round, a placeholder filled by any value; the first pair that is not. */
const indistinct = (files: ReadonlyArray<ReadFile>): RecordFault | undefined => {
	const sites = files.flatMap((f) => sitesIn(f))
	for (const p of sites) {
		if (!p.decides) {
			continue
		}
		for (const q of sites) {
			if (
				q !== p &&
				(writtenAs(p.spelled.tokens, q.spelled.tokens) ||
					writtenAs(q.spelled.tokens, p.spelled.tokens))
			) {
				return {
					kind: "indistinct",
					decided: { file: p.file, statement: p.statement, at: p.at },
					other: { file: q.file, statement: q.statement, at: q.at }
				}
			}
		}
	}
	return undefined
}

/** The one constructor of a decision record, which `grizzle generate` builds its meta.json through and `grizzle check`
 * and `grizzle migrate` read it through: every statement's tokens read once, and the record's proof (DecisionRecord)
 * checked, or the fault that breaks it. */
export const decisionRecord = (
	files: ReadonlyArray<MetaFile>
): Result.Result<DecisionRecord, RecordFault> => {
	const read = files.map((f): ReadFile => ({ name: f.name, steps: f.steps.map(readStep) }))
	const fault = indistinct(read)
	return fault === undefined ? Result.ok(proved({ files: read })) : Result.err(fault)
}

/** What a loss loses, as a refusal names it. */
export const lossText = (loses: MetaLosses): string =>
	`the rows of ${loses.abandoned.map((a) => `the schema ${a.schema} (${a.directory})`).join(" and ")}, which the configuration no longer lists, left behind as ${loses.schema} starts empty`

/** How the reviewer decided a loss, read from its file: its statement written in, so the data is lost, or left out,
 * unresolved. */
export type LossDecided =
	| { readonly kind: "lost"; readonly file: string; readonly loss: ReadLoss }
	| { readonly kind: "unresolved"; readonly file: string; readonly loss: ReadLoss }

/** Each loss of a record as a reviewed folder decides it (LossDecided): its file's statements read as PostgreSQL's
 * scanner reads them, a file deleted whole holding none. Sound by the record's proof: no other recorded statement is
 * written as a loss's. */
export const lossDecisions = (
	record: DecisionRecord,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadonlyArray<LossDecided> =>
	record.files.flatMap((file) => {
		const reviewed = files.find((f) => f.name === file.name)
		const held =
			reviewed === undefined ? [] : splitStatements(reviewed.text).map((x) => statementTokens(x))
		return file.steps.flatMap((s): ReadonlyArray<LossDecided> => {
			if (s.kind !== "loss") {
				return []
			}
			const lost = held.some((h) => writtenAs(s.statement.tokens, h))
			return [{ kind: lost ? "lost" : "unresolved", file: file.name, loss: s }]
		})
	})

/** A committed folder's meta.json as readMeta reads it. */
export type ReadMeta =
	| (MetaFields & {
			readonly kind: "drafted"
			readonly declared: Declarations
			readonly record: DecisionRecord
	  })
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
 * drafted, or a custom migration, whose source and target are the same snapshot. A drafted folder records the renames
 * and drops it was drafted under (`declared`) and its decision record in `files`: every drafted statement of every
 * file in draft order, each group of statements the reviewer confirms as one, and each statement that loses stored
 * data no declaration names, with what it loses. So `grizzle check` reads back that each group stands whole or is gone
 * whole and that every loss is decided (lossDecisions), comparing statements as PostgreSQL's scanner reads them
 * (`writtenAs`). A custom migration drafts nothing, so it has no record: grizzle does not read its hand-written
 * statements. */
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

/**
 * A migration folder's timestamp, the UTC second it is drafted at, which the CLI reads off its clock (cli/clock.ts)
 * since the compiler reads none: its fields in the order it writes them, each with its width in digits, YYYYMMDDHHMMSS,
 * a four-digit year and two digits for each of the month, the day, the hour, the minute and the second.
 *
 * @formatConstant the digits of each field of a migration folder's timestamp
 */
export const timestampWidths = { year: 4, month: 2, day: 2, hour: 2, minute: 2, second: 2 } as const

/** A timestamp's length: the digits of all its fields. */
export const timestampLength: number = Object.values(timestampWidths).reduce(
	(length: number, width) => length + width,
	0
)

const isTimestamp = (text: string): boolean => text.length === timestampLength && allDigits(text)

/** What a migration folder's name starts with: its timestamp, then `_`. */
const folderPrefix = (timestamp: string): string => `${timestamp}_`

/**
 * The longest file name the operating system states, NAME_MAX: a migration folder is one directory entry, created where
 * it is drafted and wherever its repository is checked out. Darwin's NAME_MAX, whose comment reads "max bytes in a file
 * name", is Linux's too (https://github.com/torvalds/linux/blob/v7.3/include/uapi/linux/limits.h#L12, "#define
 * NAME_MAX         255"). A file system may admit a longer name (pathconf's _PC_NAME_MAX); grizzle writes none longer.
 */
export const fileNameMaxBytes = published({
	value: 255,
	owner: "Darwin (xnu 12377.121.6), and Linux alike",
	unit: "bytes",
	scope: "one file name, a single path component such as a migration folder's name",
	constraint: "compile-time constant",
	source:
		"https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/sys/syslimits.h#L103",
	quote: "#define NAME_MAX                  255",
	verified: "2026-11-05"
})

/**
 * The longest name a migration folder carries after its timestamp: given by `--name` or derived from the change, it
 * ends the folder's one file name.
 */
export const maxMigrationNameLength = derived({
	owner: "grizzle",
	unit: "UTF-8 bytes",
	scope: "the name of one migration folder, after its `<timestamp>_` prefix",
	from: [fileNameMaxBytes],
	derivation:
		"fileNameMaxBytes less the UTF-8 bytes of the prefix folderPrefix writes before every folder's name, written for a timestamp of timestampLength digits, as every timestamp is",
	compute: ([name]) => name.value - utf8Length(folderPrefix("0".repeat(timestampLength)))
})

/**
 * The migration name `name` is, parsed: lowercase ASCII letters and digits in words joined by `_` or `-`, at most
 * maxMigrationNameLength bytes; none for a name of no folder name's shape.
 */
export const parseMigrationName = (name: string): MigrationName | undefined =>
	isWords(name) && utf8Length(name) <= maxMigrationNameLength.value
		? migrationName(name)
		: undefined

/** The name of a schema's first migration, from the empty snapshot. */
export const initMigrationName: MigrationName = migrationName("init")

/** The name of a migration whose change names no object. */
export const updateMigrationName: MigrationName = migrationName("update")

/** What a migration does to the object its name leads with. */
export type ChangeVerb = "add" | "drop" | "change"

/**
 * Lowercase words joined by single underscores: `text` lowercased, each run of characters other than ASCII letters and
 * digits one `_`, none at either end.
 */
const words = (text: string): string => {
	let out = ""
	for (const ch of text.toLowerCase()) {
		const keep = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")
		if (keep) {
			out += ch
		} else if (out.length > 0 && !out.endsWith("_")) {
			out += "_"
		}
	}
	return out.endsWith("_") ? out.slice(0, -1) : out
}

/** What the name of a migration that does more than its first change ends with. */
const andMore = "_and_more"

/**
 * The name of a migration led by one change: `verb`, then the words of `object`, what it changes, cut to fit
 * maxMigrationNameLength, then `_and_more` when `more` changes follow. The verb leads, so the words are never none, and
 * the cut leaves no `_` at its end.
 */
export const changeMigrationName = (
	verb: ChangeVerb,
	object: string,
	more: boolean
): MigrationName => {
	const head = words(`${verb}_${object}`)
	const suffix = more ? andMore : ""
	const room = maxMigrationNameLength.value - suffix.length
	const cut = head.length <= room ? head : head.slice(0, room)
	return migrationName(`${cut.endsWith("_") ? cut.slice(0, -1) : cut}${suffix}`)
}

/** The folder name of a migration: its timestamp, then `_`, then its name. */
export const folderName = (
	timestamp: string,
	name: MigrationName
): Result.Result<string, CompileError> =>
	isTimestamp(timestamp)
		? Result.ok(`${folderPrefix(timestamp)}${name}`)
		: Result.err(
				malformedDescription(
					SourceLoc("migration folder", []),
					`a timestamp of fourteen digits YYYYMMDDHHMMSS, not ${JSON.stringify(timestamp)}`
				)
			)

/** The timestamp a migration folder's name begins with, its first timestampLength characters. */
export const folderTimestamp = (name: string): string => name.slice(0, timestampLength)

/** Whether a directory name is a migration folder's: `<14 digits>_<words>`. */
export const isFolderName = (name: string): boolean => {
	const timestamp = folderTimestamp(name)
	const prefix = folderPrefix(timestamp)
	return isTimestamp(timestamp) && name.startsWith(prefix) && isWords(name.slice(prefix.length))
}

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

/**
 * The seal of a meta.json: the digest of every property of its meta, over the value JSON gave. It is total over any
 * value, so a read meta.json is checked by it before anything reads its meta (the shell's boundary/meta.ts).
 */
export const metaSeal = (meta: unknown): Result.Result<string, CompileError> =>
	digest("meta", meta, everyProperty)

/** The text of meta.json: `{ meta, seal }`, the meta sealed by its seal (metaSeal), so a meta.json edited or corrupted
 * outside grizzle is refused before its meta is read. */
export const writeMeta = (meta: MigrationMeta): Result.Result<string, CompileError> =>
	Result.flatMap(metaSeal(meta), (seal) => writeJsonText({ meta, seal }))

/** Reads a folder's meta: what its form alone does not say. The shell trusts meta.json's meta once its seal holds
 * (boundary/meta.ts), and hands the meta here. A custom migration's source and target are one
 * snapshot; a drafted folder's files read as its decision record (decisionRecord), a fault refused as a malformed
 * meta.json. */
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
			return Result.map(
				Result.mapError(decisionRecord(meta.files), (fault) =>
					malformedArtifact("meta", ["files"], recordFaultText(fault))
				),
				(record) => ({
					kind: "drafted",
					schemaName: meta.schemaName,
					schema: meta.schema,
					source: meta.source,
					target: meta.target,
					declared: meta.declared,
					record
				})
			)
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
