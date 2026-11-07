import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	subarray,
	type Weighted,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import type { Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
import {
	folderName,
	isFolderName,
	type MetaFile,
	type MetaStep,
	type CustomMeta,
	type MigrationMeta,
	maxMigrationNameLength,
	metaFileName,
	metaSeal,
	orderFolderFiles,
	parseMigrationName,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { assert, assertVariant, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftChain,
	draftedAt,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"

import { regex } from "arkregex"
/** A migration folder's name, its files' names and its meta.json, generated: each reader accepts exactly what its
 * grammar allows, judged by an oracle written apart from it, over valid names and values and their near misses.
 *
 * - A folder is `<YYYYMMDDHHMMSS>_<words>`: fourteen ASCII digits, one `_`, and lowercase ASCII letters and digits in
 *   words joined by single `_` or `-`; parseMigrationName admits the words of at most maxMigrationNameLength bytes,
 *   and folderName builds a folder name from a timestamp and a name it admits.
 * - A drafted file is `NN-<words>.sql`, NN two or more ASCII digits and positive; a folder holds such files beside
 *   meta.json, one per ordinal, applied in ordinal order.
 * - meta.json holds four nonempty strings and its kind, drafted or custom; a custom migration's source is its target. A
 *   drafted folder also holds the renames and drops it was drafted under, and its decisions, empty when it has none:
 *   each drafted statement in its place, each group of statements it confirms, one at least, and each loss of stored
 *   data, what it loses and its statement. A value short of any of it is refused as malformed, a decision written as
 *   another recorded statement among it, and a valid one reads back as written, byte for byte when written again.
 * - A drafted folder is named after its change. */
const words = regex("^[a-z0-9]+(?:[_-][a-z0-9]+)*$")
const isWordsOracle = (text: string): boolean => words.test(text)

/** Fourteen ASCII digits, or a near miss: a digit too few or too many, or one character that is no ASCII digit. */
const timestampGen: Gen<string> = weighted([
	[4, matching(regex("^[0-9]{14}$"))],
	[1, matching(regex("^[0-9]{13}$|^[0-9]{15}$"))],
	[
		2,
		(source) => {
			const digits = source.draw(matching(regex("^[0-9]{14}$")))
			const at = source.draw(int(0, 13))
			const ch = source.draw(element(["a", "-", "_", " ", "٣", "+"]))
			return `${Str.slice(0, at)(digits)}${ch}${Str.slice(at + 1)(digits)}`
		}
	]
])

/** The longest migration name, the bound a name is drawn around. */
const nameBound = maxMigrationNameLength.value

/** Lowercase words, or a near miss: empty, a separator first, last or doubled, an uppercase letter, a space, a dot, a
 * letter outside ASCII; and names around maxMigrationNameLength: one letter short of it, at it, and one past it. */
const wordsGen: Gen<string> = weighted([
	[4, matching(regex("^[a-z0-9]{1,6}(?:[_-][a-z0-9]{1,6}){0,3}$"))],
	[
		3,
		(source) => {
			const w = source.draw(matching(regex("^[a-z0-9]{1,6}(?:[_-][a-z0-9]{1,6}){0,2}$")))
			const odd = source.draw(element(["", "_", "-", "__", "_-", "A", " ", ".", "é", "Z9"]))
			const where = source.draw(element(["start", "end", "middle"]))
			return where === "start" ? `${odd}${w}` : where === "end" ? `${w}${odd}` : `${w}${odd}${w}`
		}
	],
	[1, string(codePoint(0x61, 0x7a), { min: nameBound - 1, max: nameBound + 1 })]
])

const folderNameGen: Gen<string> = (source) =>
	`${source.draw(timestampGen)}${source.draw(element(["_", "_", "_", "-", "", " ", "__", "x"]))}${source.draw(wordsGen)}`

/** A drafted file's name, or a near miss: a one-digit, zero, signed, hexadecimal or non-ASCII ordinal, another
 * separator, a phase that is no words, another extension. */
const fileNameGen: Gen<string> = (source) => {
	const ordinal = source.draw(
		weighted([
			[4, matching(regex("^[0-9]{2,3}$"))],
			[2, element(["1", "9", "00", "000", "+12", "0x1", "1e2", " 12", "١٢"])]
		])
	)
	const separator = source.draw(element(["-", "-", "-", "_", ""]))
	const phase = source.draw(
		weighted([
			[3, element(["structure", "setup", "backfill_rows"])],
			[1, wordsGen]
		])
	)
	const extension = source.draw(element([".sql", ".sql", ".sql", ".SQL", ".sql.bak", ""]))
	return `${ordinal}${separator}${phase}${extension}`
}

const fileOrdinalOracle = (name: string): number | undefined => {
	const match = regex("^([0-9]{2,})-(.+)\\.sql$").exec(name)
	if (match === null) {
		return undefined
	}
	const [, digits = "", phase = ""] = match
	if (!isWordsOracle(phase)) {
		return undefined
	}
	const n = Number(digits)
	return n > 0 ? n : undefined
}

/** The refined payloads a closed relation's rows draw. */
const slugs = ["free", "pro-plan", "team", "x1"] as const
type Slug = (typeof slugs)[number]

/** Tier's handles, in their codes' order: a history appends, never reorders. */
const tierHandles = ["Free", "Pro", "Team"] as const

/** The labels of Tier's handles before and after a migration: a payload changed, a handle appended, or both. */
interface Labels {
	readonly before: ReadonlyArray<Slug>
	readonly after: ReadonlyArray<Slug>
}

type LabelFeature = "a refined payload changed alone" | "a handle appended" | "both at once"

const labelsGen: Gen<Labels> = (source) => {
	const before = [source.draw(element(slugs)), source.draw(element(slugs))]
	const relabeled = Arr.map(before, (label) =>
		source.draw(boolean) ? source.draw(element(slugs)) : label
	)
	const grown = source.draw(boolean)
	const after = grown ? [...relabeled, source.draw(element(slugs))] : relabeled
	const same = !grown && Arr.every(Arr.zip(before, after), ([a, b]) => a === b)
	return {
		before,
		after: same ? [...after, source.draw(element(slugs))] : after
	}
}

/** A schema of Tier and TierLabel, a closed relation whose refined payload a slug is, each handle's label `labels`. */
const labelSchema = (labels: ReadonlyArray<Slug>) => {
	const Slug = str.regex("^[a-z][a-z0-9-]*$")
	const handles = nonEmpty(Arr.take(tierHandles, labels.length), "Tier's handles")
	const Tier = closed("Tier", handles)
	const TierLabel = closed.relation(
		"TierLabel",
		{ tier: closedId(Tier), label: Slug },
		["tier"],
		Arr.map(handles, (tier, i) => ({ tier, label: defined(labels[i], "a handle's label") }))
	)
	return schema("Labels", { Tier, TierLabel }, [])
}

describe("migration folders, generated", () => {
	it.effect("a folder name is fourteen ASCII digits, an underscore and lowercase words", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/deploy/folder-names",
					draw: drawn(folderNameGen),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(name) =>
					Effect.sync(() => {
						const expected = regex("^[0-9]{14}_").test(name) && isWordsOracle(Str.slice(15)(name))
						assert.equal(isFolderName(name), expected, Formatter.format(name))
					})
			)
		)
	)

	it.effect(
		"parseMigrationName admits exactly the words of at most maxMigrationNameLength bytes, and folderName builds from each exactly the names isFolderName accepts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/deploy/folder-build",
						draw: drawn((source) => [source.draw(timestampGen), source.draw(wordsGen)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([timestamp, name]) =>
						Effect.sync(() => {
							const parsed = parseMigrationName(name)
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
								assert.equal(built.error.reason._tag, "MalformedDescription")
							}
						})
				)
			)
	)

	it.effect(
		"a folder's files are NN-<words>.sql beside meta.json, one per positive ordinal, in ordinal order",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const namesGen = array(
						weighted([
							[6, fileNameGen],
							[1, constant(metaFileName)]
						]),
						{ min: 0, max: 5 }
					)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/deploy/folder-files",
							draw: drawn(namesGen),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(names) =>
							Effect.sync(() => {
								const files = Arr.filter(names, (n) => n !== metaFileName)
								const ordinals = Arr.map(files, fileOrdinalOracle)
								const valid =
									Arr.every(ordinals, (o) => o !== undefined) &&
									new Set(ordinals).size === ordinals.length
								const ordered = orderFolderFiles(Arr.map(names, (name) => ({ name })))
								assert.equal(ordered.ok, valid, Formatter.format(names))
								if (ordered.ok) {
									assert.deepEqual(
										Arr.map(ordered.value, ({ file, ordinal }) => ({ name: file.name, ordinal })),
										Arr.sort(
											Arr.map(files, (name, i) => ({ name, ordinal: ordinals[i] ?? 0 })),
											Order.mapInput(
												Order.Number,
												(file: { readonly ordinal: number }) => file.ordinal
											)
										)
									)
								}
							})
					)
				})
			)
	)

	it.effect(
		"names a draft after its first change, a closed relation's refined payload changed or a handle appended, in a folder's name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/folder-derived-names",
						draw: drawn(labelsGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the derived name's rule: its change's verb and words, or update, in the folder grammar's words"
						},
						coverage: required<LabelFeature>(
							["a refined payload changed alone", "a handle appended", "both at once"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(l, c) =>
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
						})
				)
			)
	)
})

/** What a meta.json value is short of.
 * A key of meta.json, of either kind of folder. */
type MetaKey = "schemaName" | "schema" | "source" | "target" | "kind" | "declared" | "files"

/** A decision record short of its proof, refused: a statement whose presence decides something, a loss's or a
 * confirmed one, written as another recorded statement, which a review could not tell apart from it. */
type RecordMiss = "a loss written as another statement" | "a confirmed statement written twice"

type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "not an object"; readonly value: unknown }
	| { readonly kind: "field"; readonly key: MetaKey; readonly value: unknown }
	| { readonly kind: "removed"; readonly key: MetaKey }
	| { readonly kind: "custom with two snapshots" }
	| { readonly kind: "record"; readonly miss: RecordMiss }

const fingerprintGen = matching(regex("^[0-9a-f]{64}$"))

const fileNames = ["01-setup.sql", "05-publish.sql"] as const

/** The renames and drops a draft declares, from small pools of each kind (`--rename`, `--drop`). */
const declaredGen: Gen<Declarations> = (source) => ({
	renames: source.draw(
		subarray<Rename>([
			{
				from: { kind: "relation", relation: parsedName("Old") },
				to: { kind: "relation", relation: parsedName("New") }
			},
			{
				from: { kind: "field", relation: parsedName("Kept"), field: parsedName("a") },
				to: { kind: "field", relation: parsedName("Kept"), field: parsedName("b") }
			},
			{
				from: { kind: "handle", roster: parsedName("Kind"), handle: "Low" },
				to: { kind: "handle", roster: parsedName("Kind"), handle: "Lesser" }
			}
		])
	),
	drops: source.draw(
		subarray<Named>([
			{ kind: "relation", relation: parsedName("Gone") },
			{ kind: "field", relation: parsedName("Kept"), field: parsedName("c") },
			{ kind: "handle", roster: parsedName("Kind"), handle: "High" }
		])
	)
})

/** The loss a schema's first migration states when its directory holds an abandoned schema: their rows. */
const abandonedLoss = (statement: string): MetaStep => ({
	kind: "loss",
	loses: {
		kind: "schema",
		schema: `"repro"`,
		abandoned: [{ schema: `"repro_old"`, directory: "repro_old" }]
	},
	statement
})

/** A record of a draft: statements spelt each apart from every other, a confirmed group of two, and in Setup the loss of
 * an abandoned schema's rows where the draft starts its schema beside one. */
const recordOf = (lossDrawn: boolean): ReadonlyArray<MetaFile> => {
	let n = 0
	const fresh = (verb: string): string => {
		n++
		return `ALTER TABLE "repro"."t${n}" ${verb}`
	}
	return [
		{
			name: fileNames[0],
			steps: [
				...(lossDrawn ? [abandonedLoss(`CREATE SCHEMA "repro${n}"`)] : []),
				{ kind: "statement", statement: fresh("ADD COLUMN") }
			]
		},
		{
			name: fileNames[1],
			steps: [
				{ kind: "statement", statement: fresh("OWNER") },
				{ kind: "confirm", statements: [fresh("RENAME ASIDE"), fresh("RENAME ASIDE")] }
			]
		}
	]
}

/** A custom migration's source and target are one snapshot, and it drafts nothing, so it records no files. */
const metaGen: Gen<MigrationMeta> = (source) => {
	const fields = {
		schemaName: source.draw(matching(regex("^[A-Z][A-Za-z0-9]{0,8}$"))),
		schema: source.draw(matching(regex("^[a-z][a-z0-9_]{0,8}$"))),
		source: SchemaFingerprint(source.draw(fingerprintGen))
	}
	const target = SchemaFingerprint(source.draw(fingerprintGen))
	const custom = source.draw(boolean)
	const declared = source.draw(declaredGen)
	const files = recordOf(source.draw(boolean))
	return custom
		? { kind: "custom", ...fields, target: fields.source }
		: { kind: "drafted", ...fields, target, declared, files }
}

/** The values a field must not hold, by field: a custom migration's meta holds no declarations or files at all. */
const wrong: Arr.NonEmptyReadonlyArray<{
	readonly key: MetaKey
	readonly values: Arr.NonEmptyReadonlyArray<unknown>
}> = [
	{ key: "schemaName", values: ["", 7, null, ["Work"]] },
	{ key: "schema", values: ["", false, {}] },
	{ key: "source", values: ["", 1, null] },
	{ key: "target", values: ["", [], null] },
	{ key: "kind", values: ["Drafted", "", true, 0, null] },
	{
		key: "declared",
		values: [
			null,
			{},
			{ renames: [], drops: [{ kind: "type", type: "x" }] },
			{ renames: [{}], drops: [] }
		]
	},
	{ key: "files", values: [null, {}, [{ name: "", steps: [] }], [{ name: "01-setup.sql" }]] }
]

/** A record's near miss, made from a valid record: the first decision's statement recorded again as a plain
 * statement, or none where the record holds no such decision. */
const missed = (
	files: ReadonlyArray<MetaFile>,
	miss: RecordMiss
): ReadonlyArray<MetaFile> | undefined => {
	const decided = Arr.flatMap(files, (f) =>
		Arr.flatMap(f.steps, (step): ReadonlyArray<string> => {
			switch (miss) {
				case "a loss written as another statement":
					return step.kind === "loss" ? [step.statement] : []
				case "a confirmed statement written twice":
					return step.kind === "confirm" ? [step.statements[0]] : []
			}
		})
	)
	const [statement] = decided
	const [top, ...rest] = files
	return statement === undefined || top === undefined
		? undefined
		: [{ name: top.name, steps: [...top.steps, { kind: "statement", statement }] }, ...rest]
}

const recordMisses: Arr.NonEmptyReadonlyArray<RecordMiss> = [
	"a loss written as another statement",
	"a confirmed statement written twice"
]

/** The faults of a meta: a field holding a wrong value, one of its keys removed, or its record, of the form, short of
 * its proof. */
const faultGen = (meta: MigrationMeta): Gen<Fault> => {
	const removable = Arr.filter(wrong, (w) => w.key in meta)
	const arms: Arr.NonEmptyReadonlyArray<Weighted<Fault>> = [
		[3, constant({ kind: "none" })],
		[
			1,
			map(element<unknown>([[], null, 3, "meta"]), (value): Fault => ({
				kind: "not an object",
				value
			}))
		],
		[
			4,
			(source): Fault => {
				const w = source.draw(element(wrong))
				return { kind: "field", key: w.key, value: source.draw(element(w.values)) }
			}
		],
		[
			2,
			Arr.isReadonlyArrayNonEmpty(removable)
				? map(element(removable), (w): Fault => ({ kind: "removed", key: w.key }))
				: constant({ kind: "none" })
		],
		[1, constant({ kind: "custom with two snapshots" })]
	]
	const recordArm: Weighted<Fault> = [
		4,
		map(element(recordMisses), (miss): Fault => ({ kind: "record", miss }))
	]
	return weighted(meta.kind === "drafted" ? Arr.append(arms, recordArm) : arms)
}

/**
 * A meta.json edited by hand: the faulted value in place of the meta, under the seal grizzle wrote for the original,
 * null among its faults.
 */
const handEdited = (meta: MigrationMeta, value: unknown): string =>
	jsonText(
		trusted<Json>({ meta: value, seal: succeeded(metaSeal(meta), "the original meta's seal") })
	)

/** A custom meta whose source and target are two snapshots, which grizzle never writes: sealed, so its read refuses it. */
const twoSnapshots = (meta: MigrationMeta): CustomMeta => ({
	kind: "custom",
	schemaName: meta.schemaName,
	schema: meta.schema,
	source: meta.source,
	target: SchemaFingerprint(
		meta.source === Str.repeat(64)("0") ? Str.repeat(64)("1") : Str.repeat(64)("0")
	)
})

const faulted = (
	meta: MigrationMeta,
	fault: Exclude<
		Fault,
		{ readonly kind: "record" } | { readonly kind: "custom with two snapshots" }
	>
): unknown => {
	const fields: Readonly<Record<string, unknown>> = { ...meta }
	switch (fault.kind) {
		case "none":
			return meta
		case "not an object":
			return fault.value
		case "field":
			return { ...meta, [fault.key]: fault.value }
		case "removed":
			return Rec.fromEntries(Arr.filter(Rec.toEntries(fields), ([k]) => k !== fault.key))
	}
}

type MetaFeature = "a drafted meta with a loss, read" | "declarations, read" | RecordMiss

describe("meta.json, generated", () => {
	it.effect(
		"reads back exactly what it writes, byte for byte, its declarations and every decision, and refuses a value short of the format or its proof",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/deploy/meta",
						draw: drawn((source): readonly [MigrationMeta, Fault] => {
							const meta = source.draw(metaGen)
							return [meta, source.draw(faultGen(meta))]
						}),
						literal: Formatter.format,
						coverage: required<MetaFeature>(
							["a drafted meta with a loss, read", "declarations, read", ...recordMisses],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([meta, fault], c) =>
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
								if (
									Arr.some(meta.files, (f) => Arr.some(f.steps, (step) => step.kind === "loss"))
								) {
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
									? succeeded(
											writeMeta(twoSnapshots(meta)),
											"a sealed custom meta of two snapshots"
										)
									: handEdited(meta, faulted(meta, fault))
							const read = readMeta(text)
							if (Result.isSuccess(read)) {
								assert.fail(`${Formatter.format(fault)} is read`)
							}
							assert.equal(read.failure.reason._tag, "MalformedArtifact")
						})
				)
			)
	)
})
