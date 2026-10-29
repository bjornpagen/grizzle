import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Order,
	Record as Rec,
	Result,
	Schema,
	String as Str
} from "effect"
import { decodeMeta, readMeta } from "#adapter/boundary/meta.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { CandidateRenames } from "#compiler/deploy/diff/plan.ts"
import {
	folderName,
	isFolderName,
	type MetaDecisions,
	type MetaLoss,
	type MetaWithin,
	type MigrationMeta,
	metaFileName,
	orderFolderFiles,
	readDecisions,
	topLevel,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { asDrafted, draftChain, compile, fromEmpty, draftedAt } from "#test/support/migrate/kit.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { plansRepriced } from "#test/unit/deploy/schemas.ts"

import { regex } from "arkregex"
/** A migration folder's name, its files' names and its meta.json, generated: each reader accepts exactly what its
 * grammar allows, judged by an oracle written apart from it, over valid names and values and their near misses.
 *
 * - A folder is `<YYYYMMDDHHMMSS>_<words>`: fourteen ASCII digits, one `_`, and lowercase ASCII letters and digits in
 *   words joined by single `_` or `-`; folderName builds one from a timestamp and a name of at most 100 characters.
 * - A drafted file is `NN-<words>.sql`, NN two or more ASCII digits and positive; a folder holds such files beside
 *   meta.json, one per ordinal, applied in ordinal order.
 * - meta.json holds four nonempty strings and its kind, drafted or custom; a custom migration's source is its target. A
 *   drafted folder also holds its decisions, empty when it has none: each candidate rename's label, what it renames,
 *   those before it that it requires and its witness, and each choice's file, kept statement and offers, every offer
 *   and nesting naming one of them; each group of statements it confirms, with its file and its statements, one at
 *   least; and each loss of stored data, with its file, where it is, what it loses, its statement and the candidates
 *   that carry it. A value short of any of it is refused as malformed, and a valid one reads back as written, byte for
 *   byte when written again.
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

/** Lowercase words, or a near miss: empty, a separator first, last or doubled, an uppercase letter, a space, a dot, a
 * letter outside ASCII; and names around the 100-character limit. */
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
	[1, matching(regex("^[a-z]{98,102}$"))]
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

describe("migration folders, generated", () => {
	it.effect("a folder name is fourteen ASCII digits, an underscore and lowercase words", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/deploy/folder-names",
					draw: drawn(folderNameGen),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
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
		"folderName builds exactly the names isFolderName accepts, its name at most 100 characters",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/folder-build",
						draw: drawn((source) => [source.draw(timestampGen), source.draw(wordsGen)] as const),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([timestamp, name]) =>
						Effect.sync(() => {
							const built = folderName(timestamp, name)
							const valid =
								regex("^[0-9]{14}$").test(timestamp) && isWordsOracle(name) && name.length <= 100
							assert.equal(built.ok, valid, Formatter.format([timestamp, name]))
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
							suite: "unit/deploy/folder-files",
							draw: drawn(namesGen),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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

	it("names a folder whose first change is the refined constants' validation after it", () => {
		const first = defined(draftChain([{ desc: work.PlansDesc, options: asDrafted }], fromEmpty)[0])
		/** The name is generate's own: undefined asks it to derive one. */
		const g = succeeded(
			generateMigration({
				previous: first.snapshot,
				installation: compile(plansRepriced(), asDrafted),
				workload: noWorkload,
				naming: { kind: "derived" },
				timestamp: draftedAt(2),
				abandoned: []
			})
		)
		assert.equal(
			Str.slice("YYYYMMDDHHMMSS_".length)(g.folder.name),
			"change_validate_refined_constants"
		)
	})
})

/** What a meta.json value is short of.
 * A key of meta.json, of either kind of folder. */
type MetaKey = "schemaName" | "schema" | "source" | "target" | "kind" | "decisions"

type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "not an object"; readonly value: unknown }
	| { readonly kind: "field"; readonly key: MetaKey; readonly value: unknown }
	| { readonly kind: "removed"; readonly key: MetaKey }
	| { readonly kind: "custom with two snapshots" }

const fingerprintGen = matching(regex("^[0-9a-f]{64}$"))

const statementGen = matching(regex('^ALTER TABLE "[a-z]{1,4}" [A-Z ]{1,12}$'))

const fileGen = element(["02-structure.sql", "05-publish.sql"])

/** One item and up to `max` more. */
const someOf =
	<A>(item: Gen<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => [source.draw(item), ...source.draw(array(item, { min: 0, max }))]

/** A few groups the reviewer confirms, each of one statement at least. */
const confirmsGen = (min: number): Gen<MetaDecisions["confirms"]> =>
	array(
		(source) => ({ file: source.draw(fileGen), statements: source.draw(someOf(statementGen, 2)) }),
		{ min, max: 2 }
	)

/** A few losses of `n` candidates' folder: a relation's rows, a field's values or abandoned schemas' rows, each at the top
 * of its file or nested in a candidate's alternative, carried by some of the candidates. */
const lossesGen = (n: number, min: number): Gen<ReadonlyArray<MetaLoss>> => {
	const name = matching(regex('^"[a-z]{1,4}"$'))
	const candidate = int(0, Math.max(n - 1, 0))
	const abandonedGen: Gen<{ readonly schema: string; readonly directory: string }> = (source) => ({
		schema: source.draw(name),
		directory: source.draw(matching(regex("^migrations/[a-z]{1,4}$")))
	})
	return array(
		(source): MetaLoss => ({
			file: source.draw(fileGen),
			within: source.draw(
				n === 0
					? constant<MetaWithin>(topLevel)
					: oneOf<MetaWithin>([
							constant(topLevel),
							map(candidate, (c): MetaWithin => ({ kind: "within", candidate: c }))
						])
			),
			loses: source.draw(
				oneOf<MetaLoss["loses"]>([
					(inner) => ({ kind: "relation", relation: inner.draw(name) }),
					(inner) => ({ kind: "field", relation: inner.draw(name), field: inner.draw(name) }),
					(inner) => ({
						kind: "schema",
						schema: inner.draw(name),
						abandoned: inner.draw(someOf(abandonedGen, 1))
					})
				])
			),
			statement: source.draw(statementGen),
			carriers: n === 0 ? [] : source.draw(subarray(indices(n)))
		}),
		{ min, max: 2 }
	)
}

/** No candidate, group or loss; groups or losses alone; or a few candidates, each requiring some of those before it and
 * each choice offering some of them, with groups and losses or none; each candidate witnessed by a statement of its
 * own, at a choice of its own after the others. */
const decisionsGen: Gen<MetaDecisions> = oneOf<MetaDecisions>([
	constant({ candidates: [], choices: [], confirms: [], losses: [] }),
	map(confirmsGen(1), (confirms): MetaDecisions => ({
		candidates: [],
		choices: [],
		confirms,
		losses: []
	})),
	map(lossesGen(0, 1), (losses): MetaDecisions => ({
		candidates: [],
		choices: [],
		confirms: [],
		losses
	})),
	(source): MetaDecisions => {
		const n = source.draw(int(1, 3))
		const candidates = Arr.map(
			source.draw(
				array(
					(inner) => ({
						label: inner.draw(
							matching(regex('^the candidate rename of "[a-z]{1,4}" to "[a-z]{1,4}"$'))
						),
						renames: {
							kind: inner.draw(element<CandidateRenames["kind"]>(["relation", "field", "type"])),
							removed: inner.draw(matching(regex('^"[a-z]{1,4}"$'))),
							added: inner.draw(matching(regex('^"[a-z]{1,4}"$')))
						},
						requires: inner.draw(subarray(indices(n)))
					}),
					{ min: n, max: n }
				)
			),
			(c, i) => ({
				label: c.label,
				renames: c.renames,
				requires: Arr.filter(c.requires, (r) => r < i)
			})
		)
		const witnesses = source.draw(
			array(
				(inner) => ({
					file: inner.draw(fileGen),
					keep: inner.draw(statementGen),
					statement: inner.draw(statementGen)
				}),
				{ min: n, max: n }
			)
		)
		const choices = source.draw(
			array(
				(inner): MetaDecisions["choices"][number] => ({
					file: inner.draw(fileGen),
					/** At the top of its file, or nested in a candidate's alternative. */
					within: inner.draw(
						oneOf<MetaWithin>([
							constant(topLevel),
							map(int(0, n - 1), (candidate): MetaWithin => ({ kind: "within", candidate }))
						])
					),
					keep: inner.draw(statementGen),
					offers: inner.draw(
						array(
							(offer) => ({
								candidate: offer.draw(int(0, n - 1)),
								statements: offer.draw(array(statementGen, { min: 0, max: 2 }))
							}),
							{ min: 1, max: 2 }
						)
					)
				}),
				{ min: 0, max: 3 }
			)
		)
		const confirms = source.draw(confirmsGen(0))
		const losses = source.draw(lossesGen(n, 0))
		return {
			candidates: Arr.map(candidates, (c, i) => ({
				...c,
				witness: { choice: choices.length + i, statement: 0 }
			})),
			choices: [
				...choices,
				...Arr.map(witnesses, (w, i) => ({
					file: w.file,
					within: topLevel,
					keep: w.keep,
					offers: [{ candidate: i, statements: [w.statement] }]
				}))
			],
			confirms,
			losses
		}
	}
])

/** A custom migration's source and target are one snapshot, and it drafts nothing, so it offers no candidate. */
const metaGen: Gen<MigrationMeta> = (source) => {
	const fields = {
		schemaName: source.draw(matching(regex("^[A-Z][A-Za-z0-9]{0,8}$"))),
		schema: source.draw(matching(regex("^[a-z][a-z0-9_]{0,8}$"))),
		source: SchemaFingerprint(source.draw(fingerprintGen))
	}
	const target = SchemaFingerprint(source.draw(fingerprintGen))
	const custom = source.draw(boolean)
	const decisions = source.draw(decisionsGen)
	return custom
		? { kind: "custom", ...fields, target: fields.source }
		: { kind: "drafted", ...fields, target, decisions }
}

/** A candidate's witness at the first statement of the first choice's offer, and what it renames. */
const witness = { choice: 0, statement: 0 }
const renames: CandidateRenames = { kind: "relation", removed: '"r"', added: '"s"' }

/** Decisions whose one choice, at `within`, offers the first candidate a statement. */
const oneChoice = (candidates: ReadonlyArray<unknown>, within: unknown): unknown => ({
	candidates,
	choices: [
		{ file: "01-structure.sql", within, keep: "s", offers: [{ candidate: 0, statements: ["r"] }] }
	],
	confirms: [],
	losses: []
})

/** Decisions of one candidate, its own choice witnessing it, and one loss: the loss as `loss` holds it. */
const oneLoss = (loss: unknown): unknown => ({
	candidates: [{ label: "c", renames, requires: [], witness }],
	choices: [
		{
			file: "01-structure.sql",
			within: topLevel,
			keep: "s",
			offers: [{ candidate: 0, statements: ["r"] }]
		}
	],
	confirms: [],
	losses: [loss]
})

const aLoss = {
	file: "05-publish.sql",
	within: topLevel,
	loses: { kind: "relation", relation: '"r"' },
	statement: 'DROP TABLE "r"',
	carriers: [0]
}

/** The values a field must not hold, by field: a custom migration's meta holds no decisions at all. */
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
		key: "decisions",
		values: [
			null,
			[],
			{
				candidates: ["c"],
				choices: [{ file: "01-structure.sql", keep: "s", offers: [] }],
				confirms: [],
				losses: []
			},
			{
				candidates: ["c"],
				choices: [
					{ file: "01-structure.sql", keep: "s", offers: [{ candidate: 1, statements: [] }] }
				],
				confirms: [],
				losses: []
			},
			{
				candidates: ["c"],
				choices: [{ file: "", keep: "s", offers: [{ candidate: 0, statements: [] }] }],
				confirms: [],
				losses: []
			},
			{ candidates: [""], choices: [], confirms: [], losses: [] },
			{
				candidates: [],
				choices: [],
				confirms: [{ file: "01-setup.sql", statements: [] }],
				losses: []
			},
			{
				candidates: [],
				choices: [],
				confirms: [{ file: "01-setup.sql", statements: [""] }],
				losses: []
			},
			{ candidates: [], choices: [], confirms: [{ file: "", statements: ["s"] }], losses: [] },
			{ candidates: [], choices: [], losses: [] },
			{ candidates: [], choices: [], confirms: [] },
			oneLoss({ ...aLoss, carriers: [1] }),
			oneLoss({ ...aLoss, within: { kind: "within", candidate: 1 } }),
			oneLoss({ ...aLoss, statement: "" }),
			oneLoss({ ...aLoss, file: "" }),
			oneLoss({ ...aLoss, loses: { kind: "schema", schema: '"s"', abandoned: [] } }),
			oneLoss({ ...aLoss, loses: { kind: "table", relation: '"r"' } }),
			oneLoss({
				file: aLoss.file,
				within: aLoss.within,
				loses: aLoss.loses,
				statement: aLoss.statement
			}),
			oneChoice([{ label: "c", renames, requires: [0], witness }], topLevel),
			oneChoice(
				[
					{ label: "c", renames, requires: [1], witness },
					{ label: "d", renames, requires: [], witness: { choice: 1, statement: 0 } }
				],
				topLevel
			),
			oneChoice([{ label: "c", renames, requires: [1], witness }], topLevel),
			oneChoice([{ label: "c", renames, requires: [], witness }], { kind: "within", candidate: 1 }),
			oneChoice([{ label: "c", renames, requires: [] }], topLevel),
			oneChoice(
				[{ label: "c", renames, requires: [], witness: { choice: 1, statement: 0 } }],
				topLevel
			),
			oneChoice(
				[{ label: "c", renames, requires: [], witness: { choice: 0, statement: 1 } }],
				topLevel
			),
			oneChoice(
				[{ label: "c", renames, requires: [], witness: { choice: 0, statement: -1 } }],
				topLevel
			),
			{
				candidates: [
					{ label: "c", renames, requires: [], witness },
					{ label: "d", renames, requires: [], witness }
				],
				choices: [
					{
						file: "01-structure.sql",
						within: topLevel,
						keep: "s",
						offers: [{ candidate: 0, statements: ["r"] }]
					}
				],
				confirms: [],
				losses: []
			}
		]
	}
]

/** The faults of a meta: a field holding a wrong value, or one of its keys removed. */
const faultGen = (meta: MigrationMeta): Gen<Fault> => {
	const removable = Arr.filter(wrong, (w) => w.key in meta)
	return weighted<Fault>([
		[3, constant({ kind: "none" })],
		[
			1,
			map(element<unknown>([[], null, 3, "meta"]), (value): Fault => ({
				kind: "not an object",
				value
			}))
		],
		[
			6,
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
	])
}

/** A value as JSON text, as a hand-edited meta.json holds it. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const faulted = (meta: MigrationMeta, fault: Fault): unknown => {
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
		case "custom with two snapshots":
			return {
				...Rec.fromEntries(Arr.filter(Rec.toEntries(fields), ([k]) => k !== "decisions")),
				kind: "custom",
				target: meta.source === Str.repeat(64)("0") ? Str.repeat(64)("1") : Str.repeat(64)("0")
			}
	}
}

describe("meta.json, generated", () => {
	it.effect(
		"reads back exactly what it writes, byte for byte, and refuses a value short of the format",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/meta",
						draw: drawn((source): readonly [MigrationMeta, Fault] => {
							const meta = source.draw(metaGen)
							return [meta, source.draw(faultGen(meta))]
						}),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([meta, fault]) =>
						Effect.gen(function* () {
							const written = succeeded(writeMeta(meta))
							if (fault.kind === "none") {
								assert.equal(decodeMeta(written).pipe(succeeded, writeMeta, succeeded), written)
								assert.deepEqual(
									readMeta(written),
									Result.succeed(
										meta.kind === "custom"
											? meta
											: { ...meta, decisions: succeeded(readDecisions(meta.decisions)) }
									)
								)
								return
							}
							const read = readMeta(yield* jsonText(faulted(meta, fault)))
							if (Result.isSuccess(read)) {
								assert.fail(`${Formatter.format(fault)} is read`)
							}
							assert.equal(read.failure.reason._tag, "MalformedArtifact")
						})
				)
			)
	)
})
