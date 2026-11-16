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
 *   data, what it loses and its statement. A value short of any of it is refused as malformed, a decision written as
 *   another recorded statement among it, and a valid one reads back as written, byte for byte when written again.
 * - A drafted folder is named after its change.
 *
 * Features: a folder name accepted and refused; a migration name admitted and refused, a timestamp refused; a folder of
 * no file, files in ordinal order, and a folder refused for a file's name or an ordinal twice; and as the meta and
 * derived-name searches name them.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Order, Result, String as Str } from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import {
	folderName,
	isFolderName,
	metaFileName,
	type MetaStep,
	type MigrationMeta,
	orderFolderFiles,
	parseMigrationName,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	draftChain,
	draftedAt,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import {
	type Fault,
	faultedMeta,
	faultGen,
	fileOrdinalOracle,
	folderNameGen,
	handEdited,
	isWordsOracle,
	type LabelFeature,
	labelSchema,
	labelsGen,
	type MetaFeature,
	metaGen,
	missed,
	nameBound,
	namesGen,
	recordMisses,
	timestampGen,
	twoSnapshots,
	wordsGen
} from "#test/unit/deploy/folder.fixtures.ts"

/** Migration folders, generated a folder name is fourteen ASCII digits, an underscore and lowercase words. */
export const migrationFoldersGeneratedAFolderNameIsFourteenASCIIDigitsAnUnderscoreAndLowercaseWords =
	property.explore(folderNameGen, {
		needs: {},
		situations: ["a folder name", "no folder name"] satisfies ReadonlyArray<
			Reached<"a folder name" | "no folder name">
		>,
		check: (_, c: Case<"a folder name" | "no folder name">) => (name) =>
			Effect.sync(() => {
				const expected = regex("^[0-9]{14}_").test(name) && isWordsOracle(Str.slice(15)(name))
				c.note(expected ? "a folder name" : "no folder name")
				assert.equal(isFolderName(name), expected, Formatter.format(name))
			}),
		oracle: {
			kind: "specification",
			name: "the folder grammar, written apart (isWordsOracle)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original:
					"\treturn isTimestamp(timestamp) && name.startsWith(prefix) && isWords(name.slice(prefix.length))",
				replacement: "\treturn name.startsWith(prefix) && isWords(name.slice(prefix.length))",
				why: "A folder name's timestamp is unread, so any fourteen characters before the separator pass."
			}
		]
	})

/** Migration folders, generated parseMigrationName admits exactly the words of at most maxMigrationNameLength bytes, and folderName builds from each exactly the names isFolderName accepts. */
export const migrationFoldersGeneratedParseMigrationNameAdmitsExactlyTheWordsOfAtMostMaxMigrationNameLengthBytesAndFolderNameBuildsFromEachExactlyTheNamesIsFolderNameAccepts =
	property.explore((source) => [source.draw(timestampGen), source.draw(wordsGen)] as const, {
		needs: {},
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
						regex("^[0-9]{14}$").test(timestamp),
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

/** Migration folders, generated a folder's files are NN-<words>.sql beside meta.json, one per positive ordinal, in ordinal order. */
export const migrationFoldersGeneratedAFoldersFilesAreNNWordsSqlBesideMetaJsonOnePerPositiveOrdinalInOrdinalOrder =
	property.explore(namesGen, {
		needs: {},
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

/** Migration folders, generated names a draft after its first change, a closed relation's refined payload changed or a handle appended, in a folder's name. */
export const migrationFoldersGeneratedNamesADraftAfterItsFirstChangeAClosedRelationsRefinedPayloadChangedOrAHandleAppendedInAFoldersName =
	property.explore(labelsGen, {
		needs: {},
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
		kills: []
	})

/** Meta.json, generated reads back exactly what it writes, byte for byte, its declarations and every decision, and refuses a value short of the format or its proof. */
export const metaJsonGeneratedReadsBackExactlyWhatItWritesByteForByteItsDeclarationsAndEveryDecisionAndRefusesAValueShortOfTheFormatOrItsProof =
	property.explore(
		(source): readonly [MigrationMeta, Fault] => {
			const meta = source.draw(metaGen)
			return [meta, source.draw(faultGen(meta))]
		},
		{
			needs: {},
			situations: [
				"a drafted meta with a loss, read",
				"declarations, read",
				...recordMisses
			] satisfies ReadonlyArray<Reached<MetaFeature>>,
			check:
				(_, c: Case<MetaFeature>) =>
				([meta, fault]) =>
					Effect.sync(() => {
						const written = succeeded(writeMeta(meta))
						if (fault.kind === "none") {
							assert.equal(decodeMeta(written).pipe(succeeded, writeMeta, succeeded), written)
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
						if (fault.kind === "record") {
							if (meta.kind !== "drafted") {
								return
							}
							const files = missed(meta.files, fault.miss)
							if (files === undefined) {
								return
							}
							c.note(fault.miss)
							const text = succeeded(
								writeMeta({ ...meta, files }),
								"a sealed meta short of its record"
							)
							const read = readMeta(text)
							if (Result.isSuccess(read)) {
								assert.fail(`${fault.miss} is read`)
							}
							assert.equal(read.failure.reason._tag, "MalformedArtifact")
							return
						}
						const text =
							fault.kind === "custom with two snapshots"
								? succeeded(writeMeta(twoSnapshots(meta)), "a sealed custom meta of two snapshots")
								: handEdited(meta, faultedMeta(meta, fault))
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
			kills: []
		}
	)
