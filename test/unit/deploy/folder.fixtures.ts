/** What the properties of folder.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
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
	weighted,
	type Weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import type { Named } from "#compiler/core/errors.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { type LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import type { Declarations, Rename } from "#compiler/deploy/diff/plan.ts"
import {
	type CustomMeta,
	type DraftedFile,
	type DraftedStep,
	type FolderLaws,
	type MetaFile,
	metaFileName,
	metaSeal,
	type MigrationMeta,
	provedRecord
} from "#compiler/deploy/render/folder.ts"
import { maxMigrationNameLength } from "#compiler/deploy/render/layout.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { daysIn, digitsOf, type Second, secondGen, secondOfDigits } from "#test/support/calendar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

const words = regex("^[a-z0-9]+(?:[_-][a-z0-9]+)*$")

export const isWordsOracle = (text: string): boolean => words.test(text)

/**
 * The values just past a second's field: a year of three digits (written 0999, before the four-digit years), month 00
 * or 13, day 00 or one past its month's last, hour 24, minute or second 60.
 */
const pastValues = (s: Second, field: keyof Second): Arr.NonEmptyReadonlyArray<number> => {
	switch (field) {
		case "year":
			return [999]
		case "month":
			return [0, 13]
		case "day":
			return [0, daysIn(s.year, s.month) + 1]
		case "hour":
			return [24]
		case "minute":
		case "second":
			return [60]
	}
}

/** A second's fourteen digits with one of `fields` moved just past its range (pastValues), every other field its own. */
const pastRangeGen =
	(fields: Arr.NonEmptyReadonlyArray<keyof Second>): Gen<string> =>
	(source) => {
		const s = source.draw(secondGen)
		const field = source.draw(element(fields))
		return digitsOf({ ...s, [field]: source.draw(element(pastValues(s, field))) })
	}

/**
 * Fourteen ASCII digits, or a near miss: a second's digits with one field just past its range (pastRangeGen), a digit
 * too few or too many, or one character that is no ASCII digit.
 */
export const timestampGen: Gen<string> = weighted([
	[4, (source) => digitsOf(source.draw(secondGen))],
	[2, pastRangeGen(["year", "month", "day", "hour", "minute", "second"])],
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
export const nameBound = maxMigrationNameLength

/** Lowercase words: one to four, each of one to six ASCII letters and digits, joined by `_` or `-`. */
const plainWordsGen: Gen<string> = matching(regex("^[a-z0-9]{1,6}(?:[_-][a-z0-9]{1,6}){0,3}$"))

/** Lowercase words, or a near miss: empty, a separator first, last or doubled, an uppercase letter, a space, a dot, a
 * letter outside ASCII; and names around maxMigrationNameLength: one letter short of it, at it, and one past it. */
export const wordsGen: Gen<string> = weighted([
	[4, plainWordsGen],
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

/** The separator after a folder name's timestamp: its own `_`, or a near miss. */
const folderSeparatorGen: Gen<string> = weighted([
	[3, constant("_")],
	[1, constant("-")],
	[1, constant("")],
	[1, constant(" ")],
	[1, constant("__")],
	[1, constant("x")]
])

const folderNameGen: Gen<string> = (source) =>
	`${source.draw(timestampGen)}${source.draw(folderSeparatorGen)}${source.draw(wordsGen)}`

/** The month nearest each month one past its range. */
const nearestMonth: Readonly<Record<string, string>> = { "00": "01", "13": "12" }

/** Whether fourteen digits' month is one past its range, 00 or 13, and its other fields a second's at the nearest month. */
export const monthPastRange = (digits: string): boolean =>
	Option.exists(Rec.get(nearestMonth, Str.slice(4, 6)(digits)), (nearest) =>
		Option.isSome(secondOfDigits(`${Str.slice(0, 4)(digits)}${nearest}${Str.slice(6)(digits)}`))
	)

/**
 * The folder names the grammar's property draws: folderNameGen, and while no case has reached it, a folder name whose
 * timestamp's month is one past its range, its other fields a second's (monthPastRange), which a drawn near miss reaches
 * about one name in two hundred.
 */
export const folderNameSpace = aimed(folderNameGen, [
	[
		"a month one past its range",
		(source) => `${source.draw(pastRangeGen(["month"]))}_${source.draw(plainWordsGen)}`
	]
])

/** The phases a drafted file is named after. */
const draftedPhases = ["structure", "setup", "backfill_rows"] as const

/** A drafted file's name, or a near miss: a one-digit, zero, signed, hexadecimal or non-ASCII ordinal, another
 * separator, a phase that is no words, another extension. */
const fileNameGen: Gen<string> = (source) => {
	const ordinal = source.draw(
		weighted([
			[4, matching(regex("^[0-9]{2,3}$"))],
			[2, element(["1", "9", "00", "000", "+12", "0x1", "1e2", " 12", "١٢"])]
		])
	)
	const separator = source.draw(
		weighted([
			[3, constant("-")],
			[1, constant("_")],
			[1, constant("")]
		])
	)
	const phase = source.draw(
		weighted([
			[3, element(draftedPhases)],
			[1, wordsGen]
		])
	)
	const extension = source.draw(
		weighted([
			[3, constant(".sql")],
			[1, constant(".SQL")],
			[1, constant(".sql.bak")],
			[1, constant("")]
		])
	)
	return `${ordinal}${separator}${phase}${extension}`
}

/** One name a folder holds: a drafted file's, a near miss, or meta.json. */
const folderEntryGen: Gen<string> = weighted([
	[6, fileNameGen],
	[1, constant(metaFileName)]
])

/**
 * A folder holding one ordinal twice: two drafted files of one positive ordinal under phases apart, the second's ordinal
 * spelled as the first's or with one more leading zero, among other drawn names. Each twin is a file's name by the
 * grammar alone, so only the repeated ordinal refuses a folder whose other names are files' too, which independently
 * drawn names hardly ever give.
 */
const ordinalTwiceGen: Gen<ReadonlyArray<string>> = (source) => {
	const ordinal = Str.padStart(2, "0")(String(source.draw(int(1, 99))))
	const first = source.draw(int(0, draftedPhases.length - 1))
	const second = (first + source.draw(int(1, draftedPhases.length - 1))) % draftedPhases.length
	const twins = [
		`${ordinal}-${defined(draftedPhases[first], "a drafted phase")}.sql`,
		`${source.draw(element([ordinal, `0${ordinal}`]))}-${defined(draftedPhases[second], "a drafted phase")}.sql`
	]
	const others = source.draw(array(folderEntryGen, { min: 0, max: 3 }))
	const at = source.draw(int(0, others.length))
	return [...others.slice(0, at), ...twins, ...others.slice(at)]
}

export const fileOrdinalOracle = (name: string): number | undefined => {
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

export type LabelFeature = "a refined payload changed alone" | "a handle appended" | "both at once"

export const labelsGen: Gen<Labels> = (source) => {
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
export const labelSchema = (labels: ReadonlyArray<Slug>) => {
	const Slug = str.regex("^[a-z][a-z0-9-]*$")
	const handles = nonEmpty(Arr.take(tierHandles, labels.length), "Tier's handles")
	const Tier = closed.ordered("Tier", handles)
	const TierLabel = closed.relation(
		"TierLabel",
		{ tier: closedId(Tier), label: Slug },
		["tier"],
		Arr.map(handles, (tier, i) => ({ tier, label: defined(labels[i], "a handle's label") }))
	)
	return schema("Labels", [Tier, TierLabel], [])
}

/** What a meta.json value is short of.
 * A key of meta.json, of either kind of folder. */
type MetaKey =
	| "schemaName"
	| "schema"
	| "source"
	| "target"
	| "laws"
	| "kind"
	| "declared"
	| "files"

/** A drafted record short of its proof, which generate refuses: a statement whose presence decides something, a loss's
 * or a confirmed one, written as another drafted statement, which a review could not tell apart from it. */
export type RecordMiss =
	| "a loss written as another statement"
	| "a confirmed statement written twice"

export type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "not an object"; readonly value: unknown }
	| { readonly kind: "field"; readonly key: MetaKey; readonly value: unknown }
	| { readonly kind: "removed"; readonly key: MetaKey }
	| { readonly kind: "custom with two snapshots" }

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
const abandonedLoss = (statement: string): DraftedStep => ({
	kind: "loss",
	loses: {
		kind: "schema",
		schema: `"repro"`,
		abandoned: [{ schema: `"repro_old"`, directory: "repro_old" }]
	},
	statement
})

/** A draft's files as generate drafts them, every statement by its text: statements spelt each apart from every other,
 * one holding a placeholder, a confirmed group of two, and in Setup the loss of an abandoned schema's rows where the
 * draft starts its schema beside one. */
const draftedOf = (lossDrawn: boolean): ReadonlyArray<DraftedFile> => {
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
				{ kind: "statement", statement: fresh("ADD COLUMN") },
				{ kind: "statement", statement: fresh(`ALTER COLUMN "a" SET DEFAULT ${placeholderToken}`) }
			],
			locks: 1
		},
		{
			name: fileNames[1],
			steps: [
				{ kind: "statement", statement: fresh("OWNER") },
				{ kind: "confirm", statements: [fresh("RENAME ASIDE"), fresh("RENAME ASIDE")] }
			],
			locks: 1
		}
	]
}

/** A draft's record as generate records it (provedRecord). */
const recordOf = (lossDrawn: boolean): ReadonlyArray<MetaFile> =>
	succeeded(provedRecord(draftedOf(lossDrawn)), "a drafted record proved")

/** An installed identifier's spelling: a PostgreSQL schema's, an owner's, a constraint's or a law's. */
const identGen: Gen<string> = matching(regex("^[a-z][a-z0-9_]{0,8}$"))

/** One kind of owner's constraint names, by owner, to the laws each serves, one or two. */
const ownedLawsGen: Gen<
	Readonly<Record<string, Readonly<Record<string, Arr.NonEmptyReadonlyArray<LawId>>>>>
> = (source) =>
	Rec.fromEntries(
		source.draw(
			array(
				(owner) =>
					[
						owner.draw(identGen),
						Rec.fromEntries(
							owner.draw(
								array(
									(named) =>
										[
											named.draw(identGen),
											[
												admittedIdentifier<"law">(named.draw(identGen)),
												...named.draw(
													array((law) => admittedIdentifier<"law">(law.draw(identGen)), {
														min: 0,
														max: 1
													})
												)
											] as const
										] as const,
									{ min: 0, max: 3 }
								)
							)
						)
					] as const,
				{ min: 0, max: 3 }
			)
		)
	)

/** A folder's laws: its levels' schemas and its constraint-to-law map. */
const lawsGen: Gen<FolderLaws> = (source) => ({
	schemas: source.draw(array(identGen, { min: 1, max: 3 })),
	constraintToLaw: { tables: source.draw(ownedLawsGen), domains: source.draw(ownedLawsGen) }
})

/** A custom migration's source and target are one snapshot, and it drafts nothing, so it records no files. */
export const metaGen: Gen<MigrationMeta> = (source) => {
	const fields = {
		schemaName: source.draw(matching(regex("^[A-Z][A-Za-z0-9]{0,8}$"))),
		schema: source.draw(identGen),
		source: SchemaFingerprint(source.draw(fingerprintGen)),
		laws: source.draw(lawsGen)
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
	{ key: "laws", values: [null, {}, [], "laws"] },
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

/** A drafted record's near miss, made from a valid one: the first decision's statement drafted again as a plain
 * statement, or none where the record holds no such decision. */
const missed = (
	files: ReadonlyArray<DraftedFile>,
	miss: RecordMiss
): ReadonlyArray<DraftedFile> | undefined => {
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
		: [{ ...top, steps: [...top.steps, { kind: "statement", statement }] }, ...rest]
}

export const recordMisses: Arr.NonEmptyReadonlyArray<RecordMiss> = [
	"a loss written as another statement",
	"a confirmed statement written twice"
]

/** The faults of a meta: a field holding a wrong value, or one of its keys removed. */
export const faultGen = (meta: MigrationMeta): Gen<Fault> => {
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
	return weighted(arms)
}

/**
 * A meta.json edited by hand: the faulted value in place of the meta, under the seal grizzle wrote for the original,
 * null among its faults.
 */
export const handEdited = (meta: MigrationMeta, value: unknown): string =>
	jsonText(
		trusted<Json>({ meta: value, seal: succeeded(metaSeal(meta), "the original meta's seal") })
	)

/** A custom meta whose source and target are two snapshots, which grizzle never writes: sealed, so its read refuses it. */
export const twoSnapshots = (meta: MigrationMeta): CustomMeta => ({
	kind: "custom",
	schemaName: meta.schemaName,
	schema: meta.schema,
	source: meta.source,
	laws: meta.laws,
	target: SchemaFingerprint(
		meta.source === Str.repeat(64)("0") ? Str.repeat(64)("1") : Str.repeat(64)("0")
	)
})

export const faultedMeta = (
	meta: MigrationMeta,
	fault: Exclude<Fault, { readonly kind: "custom with two snapshots" }>
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

export type MetaFeature = "a drafted meta with a loss, read" | "declarations, read"

export const namesGen = weighted<ReadonlyArray<string>>([
	[4, array(folderEntryGen, { min: 0, max: 5 })],
	[1, ordinalTwiceGen]
])

/** A draft's files, a near miss of its proof planted or none (missed): what generate's proof of a record reads. */
export interface ProofCase {
	readonly files: ReadonlyArray<DraftedFile>
	readonly miss: Option.Option<RecordMiss>
}

/** A draft's files, with a loss or none, a near miss planted where the draft holds the decision it needs. */
export const proofCaseGen: Gen<ProofCase> = (source) => {
	const drafted = draftedOf(source.draw(boolean))
	const planted = source.draw(boolean)
		? Option.some(source.draw(element(recordMisses)))
		: Option.none<RecordMiss>()
	return Option.match(planted, {
		onNone: (): ProofCase => ({ files: drafted, miss: Option.none() }),
		onSome: (miss): ProofCase => {
			const files = missed(drafted, miss)
			return files === undefined
				? { files: drafted, miss: Option.none() }
				: { files, miss: Option.some(miss) }
		}
	})
}

/** A drafted meta of a record: its other fields fixed, as no reader of its record reads them. */
export const draftedMetaOf = (files: ReadonlyArray<MetaFile>): MigrationMeta => ({
	kind: "drafted",
	schemaName: "Repro",
	schema: "repro",
	source: SchemaFingerprint(Str.repeat(64)("0")),
	target: SchemaFingerprint(Str.repeat(64)("1")),
	laws: { schemas: ["repro"], constraintToLaw: { tables: {}, domains: {} } },
	declared: { renames: [], drops: [] },
	files
})

/** A drafted file as a reviewer writes it: every statement in its place, a loss's written in, a confirmed group kept, a
 * placeholder filled by `1`, each ended by a semicolon. */
export const writtenText = (file: DraftedFile): string =>
	Arr.join(
		Arr.flatMap(file.steps, (s): ReadonlyArray<string> => {
			switch (s.kind) {
				case "statement":
					return [Str.replaceAll(placeholderToken, "1")(s.statement)]
				case "loss":
					return [s.statement]
				case "confirm":
					return s.statements
			}
		}),
		";\n"
	)
