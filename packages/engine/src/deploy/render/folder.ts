import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { ChunkView, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { isAsciiDigit, isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, everyProperty, Refusal, unwrap } from "#compiler/core/canonical.ts"
import {
	type CompileError,
	malformedArtifact,
	malformedDescription,
	unsupported
} from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import {
	folderSeparator,
	maxMigrationNameLength,
	type TimestampParts,
	timestampLength,
	timestampWidths
} from "#compiler/deploy/render/layout.ts"
import {
	holdsPlaceholder,
	isWords,
	type StatementDigest,
	type StatementToken,
	splitStatements,
	statementDigest,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import { daysInMonth } from "#compiler/ir/date.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"

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

/** One step of a drafted file as meta.json records it, every statement in its place:
 * - `statement`: a drafted statement, the reviewer's to keep, edit or fill, by its text as the file spells it from its
 *   first token: one that holds a placeholder, which a written statement fills by any value (markers.ts writtenAs), as
 *   generate records it;
 * - `digest`: any other drafted statement by the digest of its tokens (markers.ts statementDigest), which a written
 *   statement's tokens give exactly when it is written as drafted;
 * - `loss`: a statement that loses stored data no declaration names, decided by being written in, by its text;
 * - `confirm`: statements kept whole or removed whole, by their texts.
 *
 * Every reader of a statement's text keeps it: a decision's, which `grizzle check` reads a review's decision by
 * (lossDecisions), and one a reviewer fills. Every other is recorded by its digest alone (provedRecord). */
export type MetaStep =
	| { readonly kind: "statement"; readonly statement: string }
	| { readonly kind: "digest"; readonly digest: StatementDigest }
	| { readonly kind: "loss"; readonly loses: MetaLosses; readonly statement: string }
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<string> }

/** One step of a drafted file as generate drafts it, every statement by its text as the file spells it from its first
 * token, a `statement` holding a placeholder or none: what generate proves its decision record over (provedRecord),
 * before meta.json records it (MetaStep). */
export type DraftedStep = Exclude<MetaStep, { readonly kind: "digest" }>

/**
 * A drafted file's steps, in draft order; its lock demand: the most objects one transaction of it holds locked as
 * drafted, the runner's ledger fence and rows among them, counted from its drafted statements (deploy/locks/demand.ts
 * fileLockSets), which `grizzle migrate` holds the server's lock table to before it runs anything (statedLocks); and
 * the plan advice its transaction runs under, its data steps' (render/advise.ts), the text `grizzle migrate` sets as
 * the transaction's first statement (statedAdvice), empty for a file of none. Its steps are meta.json's (MetaStep), or
 * generate's every text (DraftedStep).
 */
interface FileRecord<S> {
	readonly name: string
	readonly steps: ReadonlyArray<S>
	readonly locks: number
	readonly advice: string
}

/** A drafted file as meta.json records it (MetaStep). */
export type MetaFile = FileRecord<MetaStep>

/** A drafted file as generate drafts it, every statement by its text (DraftedStep). */
export type DraftedFile = FileRecord<DraftedStep>

/**
 * The laws a refusal of a folder's statements names, as `grizzle generate` records them in its meta.json once, where it
 * drafts the folder, since `grizzle migrate` compiles nothing and holds only the last folder's snapshot: the PostgreSQL
 * schema of every level the folder's target installs, which a refused constraint's reported owner must lie in, and the
 * law of every constraint the folder builds, under its owner, by each name it builds it under: the target snapshot's
 * constraint-to-law map, each entry under its own name and under every name the diff builds an index under before it
 * swaps it in for the entry's constraint (diff/plan.ts Swap; generate.ts folderLaws). A custom migration builds nothing,
 * so its laws are its snapshot's.
 */
export interface FolderLaws {
	readonly schemas: ReadonlyArray<string>
	readonly constraintToLaw: ConstraintLaws
}

interface MetaFields {
	/** The declared schema name and its PostgreSQL schema. */
	readonly schemaName: string
	readonly schema: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
	readonly laws: FolderLaws
}

/** The meta of a folder the generator drafted: the renames and drops it was drafted under, as `--rename` and `--drop`
 * declared them, and its decision record, every drafted statement of every file in its place in the draft, so each
 * statement's owner is its position, each a decision's or one holding a placeholder by its text and every other by its
 * digest (MetaStep), as generate proved and recorded it (provedRecord). */
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

/** A statement by its text: as the file spells it from its first token, and its tokens, read once (statementTokens). */
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

/** A step of the record, read: each statement recorded by its text read once (Spelled), a digest as recorded. */
type ReadStep =
	| { readonly kind: "statement"; readonly statement: Spelled }
	| { readonly kind: "digest"; readonly digest: StatementDigest }
	| ReadLoss
	| { readonly kind: "confirm"; readonly statements: NonEmptyReadonlyArray<Spelled> }

/** A step of a drafted file, read: every statement by its text read once (Spelled). */
type SpelledStep = Exclude<ReadStep, { readonly kind: "digest" }>

interface RecordBody {
	readonly files: ReadonlyArray<FileRecord<ReadStep>>
}

declare const decisionRecordBrand: unique symbol

/** A drafted folder's decisions, read from its meta.json's record (decisionRecord), which generate proved readable
 * before it recorded it (provedRecord), and the seal carries since: every statement whose presence decides something, a
 * loss's statement or a confirmed statement, is written unlike every other recorded statement, so a review's text
 * tells each decision apart. */
export type DecisionRecord = RecordBody & { readonly [decisionRecordBrand]: true }

const proved = nominal<RecordBody, DecisionRecord>()

/** A recorded statement where it stands, as a refusal names it. */
interface RecordSite {
	readonly file: string
	readonly statement: string
	readonly at: string
}

/** Why a record is unreadable: two statements a review cannot tell apart, one of them deciding something. */
interface RecordFault {
	readonly kind: "indistinct"
	readonly decided: RecordSite
	readonly other: RecordSite
}

/** The rule a record breaks, as a refusal says it. */
const recordFaultText = (fault: RecordFault): string =>
	`${fault.decided.at} in ${fault.decided.file} and ${fault.other.at} in ${fault.other.file} are spelled alike (${fault.decided.statement}), so the reviewed SQL cannot tell the two decisions apart`

/** A decision record that does not read, as the draft's refusal: two decisions spelled alike, which a review cannot
 * tell apart. */
const recordRefusal = (fault: RecordFault): CompileError =>
	unsupported(
		SourceLoc("grizzle generate", []),
		`a draft whose decisions read apart: ${recordFaultText(fault)}; make the changes in two migrations`
	)

/** A drafted step, read: each statement's tokens read once. */
const spellStep = (s: DraftedStep): SpelledStep => {
	switch (s.kind) {
		case "statement":
			return { kind: "statement", statement: spell(s.statement) }
		case "loss":
			return { kind: "loss", loses: s.loses, statement: spell(s.statement) }
		case "confirm":
			return { kind: "confirm", statements: mapNonEmpty(s.statements, (x) => spell(x)) }
	}
}

/** A recorded step, read: each statement recorded by its text spelled (spellStep), a digest as recorded. */
const readStep = (s: MetaStep): ReadStep => (s.kind === "digest" ? s : spellStep(s))

/** A recorded statement where it stands, and whether its presence decides something. */
interface Site extends RecordSite {
	readonly spelled: Spelled
	readonly decides: boolean
}

/** A drafted step's statements where they stand in the file `file` (Site). */
const stepSites = (file: string, s: SpelledStep): ReadonlyArray<Site> => {
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

/** Every drafted statement of a file where it stands (Site). */
const sitesIn = (file: FileRecord<SpelledStep>): ReadonlyArray<Site> =>
	file.steps.flatMap((s) => stepSites(file.name, s))

/** Every statement whose presence decides something is written unlike every other drafted statement, either way
 * round, a placeholder filled by any value; the first pair that is not. */
const indistinct = (files: ReadonlyArray<FileRecord<SpelledStep>>): RecordFault | undefined => {
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

/** A drafted step as meta.json records it (MetaStep): a statement holding a placeholder, and every decision's, by its
 * text; any other statement by its tokens' digest (statementDigest), refused where it has none. */
const recordedStep = (s: SpelledStep): MetaStep => {
	switch (s.kind) {
		case "statement":
			return holdsPlaceholder(s.statement.tokens)
				? { kind: "statement", statement: s.statement.text }
				: { kind: "digest", digest: unwrap(statementDigest(s.statement.tokens)) }
		case "loss":
			return { kind: "loss", loses: s.loses, statement: s.statement.text }
		case "confirm":
			return { kind: "confirm", statements: mapNonEmpty(s.statements, (x) => x.text) }
	}
}

/** The one constructor of meta.json's record, which `grizzle generate` drafts it through: every drafted statement's
 * tokens read once and the record's proof (DecisionRecord) checked over every statement's text, a draft whose record
 * breaks it refused, naming the first pair of statements a review cannot tell apart; then the files as meta.json
 * records them (MetaStep), each statement that is no decision's and holds no placeholder by its digest. The seal of the
 * meta that holds them carries the proof to every reader (writeMeta, the shell's boundary/meta.ts), which reads the
 * record without proving it again (decisionRecord). */
export const provedRecord = (
	files: ReadonlyArray<DraftedFile>
): Result.Result<ReadonlyArray<MetaFile>, CompileError> =>
	catchRefusal(() => {
		const spelled = files.map((f): FileRecord<SpelledStep> => ({
			name: f.name,
			steps: f.steps.map(spellStep),
			locks: f.locks,
			advice: f.advice
		}))
		const fault = indistinct(spelled)
		if (fault !== undefined) {
			throw new Refusal(recordRefusal(fault))
		}
		return spelled.map((f): MetaFile => ({
			name: f.name,
			steps: f.steps.map(recordedStep),
			locks: f.locks,
			advice: f.advice
		}))
	})

/** The decision record of a meta.json's files, which `grizzle check` and `grizzle migrate` read it through: each
 * statement recorded by its text read once, each digest as recorded. Its proof (DecisionRecord) is no check of this
 * reading: generate proved it over every drafted statement's text where it recorded the files (provedRecord), and the
 * meta's seal carries it, since a meta.json is read only once its seal holds (the shell's boundary/meta.ts); a draft's
 * own record is read from the files it recorded. */
export const decisionRecord = (files: ReadonlyArray<MetaFile>): DecisionRecord =>
	proved({
		files: files.map((f) => ({
			name: f.name,
			steps: f.steps.map(readStep),
			locks: f.locks,
			advice: f.advice
		}))
	})

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
	files: ReadonlyArray<{ readonly name: string; readonly text: TextChunks }>
): ReadonlyArray<LossDecided> =>
	record.files.flatMap((file) => {
		const reviewed = files.find((f) => f.name === file.name)
		const held =
			reviewed === undefined
				? []
				: splitStatements(new ChunkView(reviewed.text)).map((x) => statementTokens(x))
		return file.steps.flatMap((s): ReadonlyArray<LossDecided> => {
			if (s.kind !== "loss") {
				return []
			}
			const lost = held.some((h) => writtenAs(s.statement.tokens, h))
			return [{ kind: lost ? "lost" : "unresolved", file: file.name, loss: s }]
		})
	})

/** A recorded statement as a written one is held to: by its text read once (Spelled), or by its tokens' digest. */
type RecordedStatement =
	| { readonly kind: "spelled"; readonly spelled: Spelled }
	| { readonly kind: "digest"; readonly digest: StatementDigest }

/** Every statement a recorded step holds, in its place. */
const stepStatements = (s: ReadStep): ReadonlyArray<RecordedStatement> => {
	switch (s.kind) {
		case "statement":
		case "loss":
			return [{ kind: "spelled", spelled: s.statement }]
		case "digest":
			return [s]
		case "confirm":
			return s.statements.map((x) => ({ kind: "spelled", spelled: x }))
	}
}

/** Whether a written statement, by its tokens, is the recorded one: written as its text (writtenAs: a placeholder
 * filled by any value), or, recorded by its digest, of tokens whose digest it is (statementDigest), which for a
 * statement holding no placeholder is writtenAs exactly. Written tokens with no digest, their canonical text past V8's
 * longest string, are no drafted statement's, whose tokens had one. */
const writtenAsRecorded = (
	recorded: RecordedStatement,
	written: ReadonlyArray<StatementToken>
): boolean => {
	switch (recorded.kind) {
		case "spelled":
			return writtenAs(recorded.spelled.tokens, written)
		case "digest": {
			const digested = statementDigest(written)
			return digested.ok && digested.value === recorded.digest
		}
	}
}

/**
 * Whether a folder's meta records a file exactly as its text holds it: a drafted folder's record holds the file, and the
 * file's statements are the record's every statement of it, in draft order, one for one, each written as its recorded
 * statement (writtenAsRecorded: a placeholder filled by any value). So a loss left out or a confirmed group removed is
 * no file the record states. A custom migration records no statement, so no file.
 */
export const recordsAsWritten = (
	meta: ReadMeta,
	file: { readonly name: string; readonly text: TextChunks }
): boolean => {
	if (meta.kind === "custom") {
		return false
	}
	const recorded = meta.record.files.find((f) => f.name === file.name)
	if (recorded === undefined) {
		return false
	}
	const drafted = recorded.steps.flatMap(stepStatements)
	const written = splitStatements(new ChunkView(file.text))
	return (
		drafted.length === written.length &&
		written.every((w, i) => {
			const d = drafted[i]
			return d !== undefined && writtenAsRecorded(d, statementTokens(w))
		})
	)
}

/**
 * The lock demand of `file`, the most objects one transaction of it holds locked, as its folder's meta records it of
 * its drafted statements (MetaFile): where the record holds the file as written (recordsAsWritten), so the statements
 * it counted are the file's; none for a file edited past its record, whose statements no count read, or a custom
 * migration's, which records none.
 */
export const statedLocks = (
	meta: ReadMeta,
	file: { readonly name: string; readonly text: TextChunks }
): number | undefined =>
	meta.kind === "drafted" && recordsAsWritten(meta, file)
		? meta.record.files.find((f) => f.name === file.name)?.locks
		: undefined

/**
 * The plan advice a file's transaction runs under, statement by statement, as its folder's meta records it of its
 * drafted data steps (MetaFile `advice`): `advice` over each of the file's statements that is a recorded one, and none
 * over each `reviewed`, a reviewer's statement between them, a data step written at a draft's slot.
 */
export interface StatedAdvice {
	readonly advice: string
	readonly reviewed: ReadonlyArray<boolean>
}

/**
 * The plan advice `file`'s transaction runs under (StatedAdvice), of its folder's meta: the record's advice where every
 * statement the record holds of the file still stands in it, in its order, each written as recorded (writtenAsRecorded,
 * a placeholder filled by any value), and every other statement of the file is a reviewer's, between them, which runs
 * under none, as a custom migration's statements do, since grizzle binds none of it; none at all for a file whose
 * recorded statements no longer all stand in order, one deleted, rewritten or moved, or a custom migration's.
 */
export const statedAdvice = (
	meta: ReadMeta,
	file: { readonly name: string; readonly text: TextChunks }
): StatedAdvice => {
	const written = splitStatements(new ChunkView(file.text))
	const none: StatedAdvice = { advice: "", reviewed: written.map(() => false) }
	if (meta.kind === "custom") {
		return none
	}
	const recorded = meta.record.files.find((f) => f.name === file.name)
	if (recorded === undefined) {
		return none
	}
	const drafted = recorded.steps.flatMap(stepStatements)
	let next = 0
	const reviewed = written.map((w) => {
		const d = drafted[next]
		if (d !== undefined && writtenAsRecorded(d, statementTokens(w))) {
			next++
			return false
		}
		return true
	})
	return next === drafted.length ? { advice: recorded.advice, reviewed } : none
}

/** A committed folder's meta.json as readMeta reads it. */
export type ReadMeta =
	| (MetaFields & {
			readonly kind: "drafted"
			readonly declared: Declarations
			readonly record: DecisionRecord
	  })
	| CustomMeta

/** A drafted file of a migration folder: its name, `NN-<phase>.sql`, and its text as its chunks (grizzle-text TextChunks),
 * never joined, which generate writes a chunk at a time and reads its markers from (render/markers.ts findMarkers). */
interface MigrationFile {
	readonly name: string
	readonly text: TextChunks
}

/** A migration folder `migrations/<schema>/<timestamp>_<name>/` and its meta.json.
 *
 * Each declared schema has its own directory `migrations/<schema>/`, holding its snapshot.json and its folders.
 * A folder holds the drafted `NN-<phase>.sql` files and `meta.json`, which records
 * the folder's source and target snapshot fingerprints: `grizzle migrate` refuses a folder whose source is not
 * the database's latest applied target before any statement runs, and records both in the ledger.
 * The CLI supplies the timestamp, the second after the chain's last folder's (the Unix epoch for a schema's first), so a
 * draft is a function of its source and its committed chain: fourteen digits, `YYYYMMDDHHMMSS` in UTC, so folders sort
 * in chain order by name. meta.json also records the folder's kind:
 * drafted, or a custom migration, whose source and target are the same snapshot, and the laws its statements' refusals
 * name (`laws`, FolderLaws), by which `grizzle migrate` names the law a refused constraint reports, each folder by its
 * own. A drafted folder records the renames
 * and drops it was drafted under (`declared`) and its decision record in `files`: every drafted statement of every
 * file in draft order, each group of statements the reviewer confirms as one, and each statement that loses stored
 * data no declaration names, with what it loses, each by its text, as is each statement holding a placeholder, and
 * every other statement by its tokens' digest (MetaStep). So `grizzle check` reads back that every loss is decided
 * (lossDecisions), and `grizzle migrate` that a file stands as recorded (recordsAsWritten), comparing statements as
 * PostgreSQL's scanner reads them (`writtenAs`, statementDigest). A custom migration drafts nothing, so it has no
 * record: grizzle does not read its hand-written statements. */
export interface MigrationFolder {
	/** `<timestamp>_<name>`. */
	readonly name: string
	readonly meta: MigrationMeta
	/** meta.json's text, as its chunks (writeMeta). */
	readonly metaText: TextChunks
	readonly files: ReadonlyArray<MigrationFile>
}

export interface DraftedFolder extends MigrationFolder {
	readonly meta: DraftedMeta
}

/**
 * The least year a timestamp's four digits name: one below it writes a leading zero, which names no four-digit year.
 *
 * @formatConstant a timestamp's four-digit year
 */
const leastYear = 1000

/**
 * The greatest hour, minute and second of a UTC day, past which a field names no time of day: a timestamp writes no
 * leap second.
 *
 * @formatConstant a UTC day's hours, minutes and seconds
 */
const dayTimeMax = { hour: 23, minute: 59, second: 59 } as const

/**
 * The UTC second a timestamp names, its fields read off its digits, or none for a text that names none: fourteen ASCII
 * digits YYYYMMDDHHMMSS, a year from leastYear (four digits, no leading zero), a month, a day of that month in that year
 * of the proleptic Gregorian calendar (ir/date.ts daysInMonth), an hour, a minute and a second of a day. The one grammar
 * of a folder's timestamp: a folder's name is one by it (folderParts), a draft's folder is named by it (folderName), and
 * the CLI reads a folder's instant from the parts it gives and writes the second after its chain's last through
 * timestampText.
 */
export const timestampParts = (text: string): TimestampParts | undefined => {
	if (text.length !== timestampLength || !isAsciiDigits(text, 0, text.length)) {
		return undefined
	}
	let at = 0
	/** The next field's value, `width` digits on from the last field read. */
	const next = (width: number): number => {
		const value = Number(text.slice(at, at + width))
		at += width
		return value
	}
	const parts: TimestampParts = {
		year: next(timestampWidths.year),
		month: next(timestampWidths.month),
		day: next(timestampWidths.day),
		hour: next(timestampWidths.hour),
		minute: next(timestampWidths.minute),
		second: next(timestampWidths.second)
	}
	const days = daysInMonth(parts.year, parts.month)
	return parts.year >= leastYear &&
		days !== undefined &&
		parts.day >= 1 &&
		parts.day <= days &&
		parts.hour <= dayTimeMax.hour &&
		parts.minute <= dayTimeMax.minute &&
		parts.second <= dayTimeMax.second
		? parts
		: undefined
}

/** `value` in at least `width` digits, a leading zero padding it. */
const padded = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * A second's timestamp: each field's value in its width's digits, a leading zero padding it. A year past 9999 writes
 * more than four, a text timestampParts reads as no timestamp, which the draft's folder name refuses (folderName).
 */
export const timestampText = (parts: TimestampParts): string =>
	`${padded(parts.year, timestampWidths.year)}${padded(parts.month, timestampWidths.month)}${padded(parts.day, timestampWidths.day)}${padded(parts.hour, timestampWidths.hour)}${padded(parts.minute, timestampWidths.minute)}${padded(parts.second, timestampWidths.second)}`

/** What a migration folder's name starts with: its timestamp, then the separator. */
const folderPrefix = (timestamp: string): string => `${timestamp}${folderSeparator}`

/**
 * The migration name `name` is, parsed: lowercase ASCII letters and digits in words joined by `_` or `-`, at most
 * maxMigrationNameLength bytes; none for a name of no folder name's shape.
 */
export const parseMigrationName = (name: string): MigrationName | undefined =>
	isWords(name) && utf8Length(name) <= maxMigrationNameLength ? migrationName(name) : undefined

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
		const keep = (ch >= "a" && ch <= "z") || isAsciiDigit(ch.charCodeAt(0))
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
	const room = maxMigrationNameLength - suffix.length
	const cut = head.length <= room ? head : head.slice(0, room)
	return migrationName(`${cut.endsWith("_") ? cut.slice(0, -1) : cut}${suffix}`)
}

/** The folder name of a migration: its timestamp, then `_`, then its name; refused for a timestamp naming no second. */
export const folderName = (
	timestamp: string,
	name: MigrationName
): Result.Result<string, CompileError> =>
	timestampParts(timestamp) !== undefined
		? Result.ok(`${folderPrefix(timestamp)}${name}`)
		: Result.err(
				malformedDescription(
					SourceLoc("migration folder", []),
					`a timestamp YYYYMMDDHHMMSS naming a UTC second, not ${JSON.stringify(timestamp)}`
				)
			)

/**
 * The UTC second a directory name names as a migration folder's, `<YYYYMMDDHHMMSS>_<words>` (timestampParts), or none
 * for a name of no folder: a hand-made folder whose digits name no second is no folder, refused by name where a chain is
 * read (cli/committed.ts, adapter/migrate/input.ts).
 */
export const folderParts = (name: string): TimestampParts | undefined => {
	const timestamp = name.slice(0, timestampLength)
	const prefix = folderPrefix(timestamp)
	return name.startsWith(prefix) && isWords(name.slice(prefix.length))
		? timestampParts(timestamp)
		: undefined
}

/** Whether a directory name is a migration folder's (folderParts). */
export const isFolderName = (name: string): boolean => folderParts(name) !== undefined

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
	if (!isAsciiDigits(digits, 0, digits.length) || !isWords(stem.slice(dash + 1))) {
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
export const writeMeta = (meta: MigrationMeta): Result.Result<TextChunks, CompileError> =>
	Result.flatMap(metaSeal(meta), (seal) => writeJsonText({ meta, seal }))

/** Reads a folder's meta: what its form alone does not say. The shell trusts meta.json's meta once its seal holds
 * (boundary/meta.ts), and hands the meta here. A custom migration's source and target are one snapshot; a drafted
 * folder's files read as its decision record (decisionRecord), proved where generate recorded it (provedRecord) and
 * carried by the seal, so no proof of it runs here. */
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
			return Result.ok({
				kind: "drafted",
				schemaName: meta.schemaName,
				schema: meta.schema,
				source: meta.source,
				target: meta.target,
				laws: meta.laws,
				declared: meta.declared,
				record: decisionRecord(meta.files)
			})
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
