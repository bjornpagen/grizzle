/**
 * A migration folder's name, its files' names and its meta.json, generated: each reader accepts exactly what its
 * grammar allows, judged by an oracle written apart from it, over valid names and values and their near misses.
 *
 * - A folder is `<YYYYMMDDHHMMSS>_<words>`: fourteen ASCII digits, one `_`, and lowercase ASCII letters and digits in
 *   words joined by single `_` or `-`; parseMigrationName admits the words of at most maxMigrationNameLength bytes,
 *   and folderName builds a folder name from a timestamp and a name it admits.
 * - A drafted file is `NN-<words>.sql`, NN two or more ASCII digits and positive; a folder holds such files beside
 *   meta.json, one per ordinal, applied in ordinal order.
 * - meta.json holds four nonempty strings, its kind, drafted or custom, and its laws, the level schemas and each table's
 *   and domain's constraint names to the laws they report; a custom migration's source is its target. A drafted
 *   folder also holds the renames and drops it was drafted under, and its decisions, empty when it has none:
 *   each drafted statement in its place, each group of statements it confirms, one at least, and each loss of stored
 *   data, what it loses and its statement, each by its text, and every other statement by its tokens' digest, but one
 *   holding a placeholder, by its text. A value short of any of it is refused as malformed, and a valid one reads back
 *   as written, byte for byte when written again, its record as recorded, with no proof of it run again: generate
 *   proved it.
 * - generate proves a draft's record before it records it (provedRecord): a decision written as another drafted
 *   statement is refused; every other record is recorded with each statement that holds no placeholder by its tokens'
 *   digest, and reads back holding each of its files as written, a placeholder filled.
 * - A drafted folder is named after its change.
 *
 * Features: a folder name accepted and refused; a migration name admitted and refused, a timestamp refused; a folder of
 * no file, files in ordinal order, and a folder refused for a file's name or an ordinal twice; and as the meta and
 * derived-name searches name them.
 */

import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, Order, Result, String as Str } from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import {
	type DraftedStep,
	folderName,
	isFolderName,
	type MetaStep,
	type MigrationMeta,
	metaFileName,
	orderFolderFiles,
	parseMigrationName,
	provedRecord,
	recordsAsWritten,
	statedLocks,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import {
	splitStatements,
	statementDigest,
	statementTokens
} from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { failed, succeeded } from "#test/support/assert.ts"
import { secondOfDigits } from "#test/support/calendar.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import {
	asDrafted,
	compile,
	draftChain,
	draftedAt,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import {
	draftedMetaOf,
	type Fault,
	faultedMeta,
	faultGen,
	fileOrdinalOracle,
	folderNameSpace,
	handEdited,
	isWordsOracle,
	type LabelFeature,
	labelSchema,
	labelsGen,
	type MetaFeature,
	metaGen,
	monthPastRange,
	nameBound,
	namesGen,
	proofCaseGen,
	type RecordMiss,
	recordMisses,
	timestampGen,
	twoSnapshots,
	wordsGen,
	writtenText
} from "#test/unit/deploy/folder.fixtures.ts"

/** The situations of a drawn folder name. */
type FolderNameNote =
	| "a folder name"
	| "no folder name"
	| "fourteen digits naming no second"
	| "a month one past its range"

/** Migration folders, generated a folder name is fourteen ASCII digits, an underscore and lowercase words. Its budget is its suite's before it was a property (test/unit/deploy/folder.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const migrationFoldersGeneratedAFolderNameIsFourteenASCIIDigitsAnUnderscoreAndLowercaseWords =
	property.explore(folderNameSpace, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"a folder name",
			"no folder name",
			"fourteen digits naming no second",
			"a month one past its range"
		] satisfies ReadonlyArray<Reached<FolderNameNote>>,
		check: (_, c: Case<FolderNameNote>) => (name) =>
			Effect.sync(() => {
				const shaped = regex("^[0-9]{14}_").test(name) && isWordsOracle(Str.slice(15)(name))
				const expected = shaped && Option.isSome(secondOfDigits(Str.slice(0, 14)(name)))
				if (shaped && !expected) {
					c.note("fourteen digits naming no second")
				}
				if (shaped && monthPastRange(Str.slice(0, 14)(name))) {
					c.note("a month one past its range")
				}
				c.note(expected ? "a folder name" : "no folder name")
				assert.equal(isFolderName(name), expected, Formatter.format(name))
			}),
		oracle: {
			kind: "specification",
			name: "the folder grammar, written apart (isWordsOracle), its timestamp the second day arithmetic reads (secondOfDigits)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\t\t? timestampParts(timestamp)\n",
				replacement: "\t\t? { year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }\n",
				why: "A folder name's timestamp is unread, so any fourteen characters before the separator pass."
			},
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\tconst days = daysInMonth(parts.year, parts.month)\n",
				replacement:
					"\tconst days = daysInMonth(parts.year, Math.min(Math.max(parts.month, 1), 12))\n",
				why: "A month out of 1 to 12 read as the nearest month: a hand-made folder of month 00 or 13 is admitted, its digits naming no second."
			}
		]
	})

/** Migration folders, generated parseMigrationName admits exactly the words of at most maxMigrationNameLength bytes, and folderName builds from each exactly the names isFolderName accepts. Its budget is its suite's before it was a property (test/unit/deploy/folder.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const migrationFoldersGeneratedParseMigrationNameAdmitsExactlyTheWordsOfAtMostMaxMigrationNameLengthBytesAndFolderNameBuildsFromEachExactlyTheNamesIsFolderNameAccepts =
	property.explore((source) => [source.draw(timestampGen), source.draw(wordsGen)] as const, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"a name admitted",
			"a name refused",
			"a timestamp refused"
		] satisfies ReadonlyArray<
			Reached<"a name admitted" | "a name refused" | "a timestamp refused">
		>,
		check:
			(_, c: Case<"a name admitted" | "a name refused" | "a timestamp refused">) =>
			([timestamp, name]) =>
				Effect.sync(() => {
					const parsed = parseMigrationName(name)
					c.note(parsed === undefined ? "a name refused" : "a name admitted")
					assert.equal(
						parsed !== undefined,
						isWordsOracle(name) && name.length <= nameBound,
						Formatter.format(name)
					)
					if (parsed === undefined) {
						return
					}
					const built = folderName(timestamp, parsed)
					assert.equal(
						built.ok,
						Option.isSome(secondOfDigits(timestamp)),
						Formatter.format([timestamp, name])
					)
					if (built.ok) {
						assert.equal(built.value, `${timestamp}_${name}`)
						assert.ok(isFolderName(built.value))
					} else {
						c.note("a timestamp refused")
						assert.equal(built.error.reason._tag, "MalformedDescription")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the words grammar and the name bound, written apart"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original:
					"\tisWords(name) && utf8Length(name) <= maxMigrationNameLength ? migrationName(name) : undefined",
				replacement:
					"\tisWords(name) && utf8Length(name) <= maxMigrationNameLength + 1 ? migrationName(name) : undefined",
				why: "A migration name a byte past maxMigrationNameLength is admitted."
			}
		]
	})

/** Migration folders, generated a folder's files are NN-<words>.sql beside meta.json, one per positive ordinal, in ordinal order. Its budget is its suite's before it was a property (test/unit/deploy/folder.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const migrationFoldersGeneratedAFoldersFilesAreNNWordsSqlBesideMetaJsonOnePerPositiveOrdinalInOrdinalOrder =
	property.explore(namesGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"no file",
			"files in order",
			"a file's name refused",
			"an ordinal twice refused"
		] satisfies ReadonlyArray<
			Reached<"no file" | "files in order" | "a file's name refused" | "an ordinal twice refused">
		>,
		check:
			(
				_,
				c: Case<"no file" | "files in order" | "a file's name refused" | "an ordinal twice refused">
			) =>
			(names) =>
				Effect.sync(() => {
					const files = Arr.filter(names, (n) => n !== metaFileName)
					const ordinals = Arr.map(files, fileOrdinalOracle)
					const named = Arr.every(ordinals, (o) => o !== undefined)
					const valid = named && new Set(ordinals).size === ordinals.length
					c.note(
						!named
							? "a file's name refused"
							: !valid
								? "an ordinal twice refused"
								: files.length === 0
									? "no file"
									: "files in order"
					)
					const ordered = orderFolderFiles(Arr.map(names, (name) => ({ name })))
					assert.equal(ordered.ok, valid, Formatter.format(names))
					if (ordered.ok) {
						assert.deepEqual(
							Arr.map(ordered.value, ({ file, ordinal }) => ({ name: file.name, ordinal })),
							Arr.sort(
								Arr.map(files, (name, i) => ({ name, ordinal: ordinals[i] ?? 0 })),
								Order.mapInput(Order.Number, (file: { readonly ordinal: number }) => file.ordinal)
							)
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the file grammar's ordinals, written apart (fileOrdinalOracle), in order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\t\t\tif (out.some((f) => f.ordinal === ordinal)) {",
				replacement: "\t\t\tif (out.some((f) => f.ordinal === ordinal && f.file.name === name)) {",
				why: "Two files of one ordinal are admitted."
			}
		]
	})

/** Migration folders, generated names a draft after its first change, a closed relation's refined payload changed or a handle appended, in a folder's name. Its budget is its suite's before it was a property (test/unit/deploy/folder.test.ts at 4ca3036a): 60 runs and 100 steered cases. */
export const migrationFoldersGeneratedNamesADraftAfterItsFirstChangeAClosedRelationsRefinedPayloadChangedOrAHandleAppendedInAFoldersName =
	property.explore(labelsGen, {
		needs: {},
		budget: { runs: 60, steered: 100 },
		situations: [
			"a refined payload changed alone",
			"a handle appended",
			"both at once"
		] satisfies ReadonlyArray<Reached<LabelFeature>>,
		check: (_, c: Case<LabelFeature>) => (l) =>
			Effect.sync(() => {
				const changed = Arr.some(l.before, (label, i) => l.after[i] !== label)
				const grown = l.after.length > l.before.length
				c.note(
					changed && grown
						? "both at once"
						: grown
							? "a handle appended"
							: "a refined payload changed alone"
				)
				const first = defined(
					draftChain(
						[{ desc: labelSchema(l.before), options: asDrafted, declared: noDeclarations }],
						fromEmpty
					)[0]
				)
				const g = succeeded(
					generateMigration({
						previous: first.snapshot,
						installation: compile(labelSchema(l.after), asDrafted),
						workload: noWorkload,
						declared: noDeclarations,
						naming: { kind: "derived" },
						timestamp: draftedAt(2),
						abandoned: []
					})
				)
				assert.equal(g.change, "schema")
				const name = Str.slice(15)(g.folder.name)
				assert.ok(isFolderName(g.folder.name), g.folder.name)
				assert.ok(Str.startsWith(`${draftedAt(2)}_`)(g.folder.name), g.folder.name)
				assert.ok(
					name === "update" || regex("^(add|drop|change)_[a-z0-9_-]+$").test(name),
					`${name} leads with its change's verb`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the derived name's rule: its change's verb and words, or update, in the folder grammar's words"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\tif (w.kind !== "lawColumn") {',
				replacement: '\t\t\tif (w.kind === "lawColumn") {',
				why: "Operator mutant aa27faabf2 at packages/engine/src/deploy/diff/diff.ts:1091 in <module>: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Meta.json, generated reads back exactly what it writes, byte for byte, its declarations and every decision, and refuses a value short of the format. Its budget is its suite's before it was a property (test/unit/deploy/folder.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const metaJsonGeneratedReadsBackExactlyWhatItWritesByteForByteItsDeclarationsAndEveryDecisionAndRefusesAValueShortOfTheFormat =
	property.explore(
		(source): readonly [MigrationMeta, Fault] => {
			const meta = source.draw(metaGen)
			return [meta, source.draw(faultGen(meta))]
		},
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: [
				"a drafted meta with a loss, read",
				"declarations, read"
			] satisfies ReadonlyArray<Reached<MetaFeature>>,
			check:
				(_, c: Case<MetaFeature>) =>
				([meta, fault]) =>
					Effect.sync(() => {
						const written = succeeded(writeMeta(meta))
						if (fault.kind === "none") {
							assert.equal(
								joined(decodeMeta(written).pipe(succeeded, writeMeta, succeeded)),
								joined(written)
							)
							const read = succeeded(readMeta(written))
							if (meta.kind === "custom") {
								assertVariant(read, "kind", "custom", "a custom meta reads back custom")
								assert.deepEqual(read, meta)
								return
							}
							assertVariant(read, "kind", "drafted", "a drafted meta reads back drafted")
							assert.deepEqual(read.laws, meta.laws, "the laws read back")
							assert.deepEqual(read.declared, meta.declared, "the declarations read back")
							if (meta.declared.renames.length + meta.declared.drops.length > 0) {
								c.note("declarations, read")
							}
							const kinds = (
								files: ReadonlyArray<{
									readonly steps: ReadonlyArray<MetaStep | { readonly kind: string }>
								}>
							) => Arr.map(files, (f) => Arr.map(f.steps, (step) => step.kind))
							assert.deepEqual(
								kinds(read.record.files),
								kinds(meta.files),
								"every decision, in its place"
							)
							if (Arr.some(meta.files, (f) => Arr.some(f.steps, (step) => step.kind === "loss"))) {
								c.note("a drafted meta with a loss, read")
							}
							return
						}
						const text =
							fault.kind === "custom with two snapshots"
								? succeeded(writeMeta(twoSnapshots(meta)), "a sealed custom meta of two snapshots")
								: chunked(handEdited(meta, faultedMeta(meta, fault)))
						const read = readMeta(text)
						if (Result.isSuccess(read)) {
							assert.fail(`${Formatter.format(fault)} is read`)
						}
						assert.equal(read.failure.reason._tag, "MalformedArtifact")
					}),
			oracle: {
				kind: "universal",
				name: "readMeta ∘ writeMeta = id, byte for byte, each fault refused"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/registry.ts",
					original:
						'(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)',
					replacement: "false",
					why: 'Operator mutant 54e278d231 at packages/engine/src/scalar/registry.ts:260 in isOwnedDescriptor: `(typeof value === "object" || typeof value === "function") && value !== null && owned.has(value)` becomes `false`; the property fails (the census, lane TESTPOLICY2).'
				}
			]
		}
	)

/** What a draft's record comes to as generate proves it (provedRecord). */
type ProofFeature =
	| RecordMiss
	| "a record proved, each statement by its digest"
	| "a placeholder kept by its text"

/** A drafted step as meta.json records it, the rule restated apart from provedRecord: a statement whose text holds no
 * placeholder token by its tokens' digest, every other step as drafted. */
const recordedAs = (s: DraftedStep): MetaStep =>
	s.kind === "statement" && !Str.includes(placeholderToken)(s.statement)
		? {
				kind: "digest",
				digest: succeeded(statementDigest(statementTokens(s.statement)), "a statement's digest")
			}
		: s

/** Generate proves a draft's record before it records it, generated: a draft whose decision is written as another drafted statement is refused, and every other is recorded with each statement that holds no placeholder by its tokens' digest, its record holding each of its files as a reviewer writes it, its placeholder filled. */
export const generateProvesADraftsRecordRefusingADecisionWrittenAsAnotherStatementAndRecordingEveryOtherStatementByItsTokensDigest =
	property.explore(proofCaseGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			...recordMisses,
			"a record proved, each statement by its digest",
			"a placeholder kept by its text"
		] satisfies ReadonlyArray<Reached<ProofFeature>>,
		check:
			(_, c: Case<ProofFeature>) =>
			({ files, miss }) =>
				Effect.sync(() => {
					const proved = provedRecord(files)
					if (Option.isSome(miss)) {
						c.note(miss.value)
						assert.equal(
							failed(proved, `${miss.value} is recorded`).reason._tag,
							"UnsupportedOperation"
						)
						return
					}
					const recorded = succeeded(proved, "a draft whose decisions read apart")
					assert.deepEqual(
						recorded,
						Arr.map(files, (f) => ({ ...f, steps: Arr.map(f.steps, recordedAs) })),
						"each statement recorded as its readers read it"
					)
					const read = succeeded(
						readMeta(succeeded(writeMeta(draftedMetaOf(recorded)), "a drafted meta written")),
						"a drafted meta read"
					)
					for (const f of files) {
						const written = { name: f.name, text: chunked(writtenText(f)) }
						assert.ok(recordsAsWritten(read, written), `${f.name} is recorded as written`)
						assert.equal(statedLocks(read, written), f.locks, `${f.name}'s locks`)
					}
					c.note("a record proved, each statement by its digest")
					if (Arr.some(recorded, (f) => Arr.some(f.steps, (s) => s.kind === "statement"))) {
						c.note("a placeholder kept by its text")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the record's rule restated (recordedAs): a decision written as another statement refused, a statement holding no placeholder by its tokens' digest, every file of the record read back as written"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\t\tconst fault = indistinct(spelled)",
				replacement: "\t\tconst fault = undefined",
				why: "generate records a draft whose decision is written as another drafted statement, which no reader proves again, so a review cannot tell the two apart (lane META8)."
			},
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\t\t\treturn holdsPlaceholder(s.statement.tokens)",
				replacement: "\t\t\treturn holdsPlaceholder([])",
				why: "A statement holding a placeholder is recorded by its digest, which no filled statement gives, so no reviewed file that fills it is recorded as written (lane META8)."
			}
		]
	})

/** A chain of two drafts, its schema's first migration and a change, drafted, then drafted again: each folder's
 * meta.json alike byte for byte, and each file of the redraft, as it is drafted and as a reviewer lays its statements
 * out apart, recorded as written by the first draft's meta.json, with the locks it records. Budget: 20 runs and 20
 * steered cases, each drafting four folders. */
export const aDraftDraftedAgainRecordsAlikeByteForByteAndItsMetaJsonHoldsEveryFileOfTheRedraftAsWritten =
	property.explore(labelsGen, {
		needs: {},
		budget: { runs: 20, steered: 20 },
		situations: [
			"a refined payload changed alone",
			"a handle appended",
			"both at once"
		] satisfies ReadonlyArray<Reached<LabelFeature>>,
		check: (_, c: Case<LabelFeature>) => (l) =>
			Effect.sync(() => {
				const changed = Arr.some(l.before, (label, i) => l.after[i] !== label)
				const grown = l.after.length > l.before.length
				c.note(
					changed && grown
						? "both at once"
						: grown
							? "a handle appended"
							: "a refined payload changed alone"
				)
				const chain = () =>
					draftChain(
						Arr.map([l.before, l.after], (labels) => ({
							desc: labelSchema(labels),
							options: asDrafted,
							declared: noDeclarations
						})),
						fromEmpty
					)
				const drafted = chain()
				const redrafted = chain()
				for (const [i, again] of redrafted.entries()) {
					const first = defined(drafted[i], "the first draft of the redraft's folder")
					assert.equal(
						joined(again.folder.metaText),
						joined(first.folder.metaText),
						`${again.folder.name}'s meta.json`
					)
					assertVariant(first.folder.meta, "kind", "drafted", "a drafted folder's meta")
					const read = succeeded(readMeta(first.folder.metaText), "the first draft's meta.json")
					for (const file of again.folder.files) {
						const locks = Arr.findFirst(first.folder.meta.files, (f) => f.name === file.name)
						const laidOut = {
							name: file.name,
							text: chunked(
								Arr.join(
									Arr.map(splitStatements(new ChunkView(file.text)), (x) => `${x};`),
									"\n\n-- reviewed\n"
								)
							)
						}
						for (const written of [file, laidOut]) {
							assert.ok(recordsAsWritten(read, written), `${file.name} recorded as written`)
							assert.deepEqual(
								Option.fromNullishOr(statedLocks(read, written)),
								Option.map(locks, (f) => f.locks),
								`${file.name}'s locks`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "a draft is a function of its inputs, and its meta.json records each file it writes as written"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original:
					'\t\t\t\t: { kind: "digest", digest: unwrap(statementDigest(s.statement.tokens)) }',
				replacement:
					'\t\t\t\t: { kind: "digest", digest: unwrap(statementDigest(s.statement.tokens.slice(1))) }',
				why: "meta.json records each statement by a digest of fewer tokens than a reader digests, so no redraft's file, nor the draft's own, is recorded as written (lane META8)."
			}
		]
	})
