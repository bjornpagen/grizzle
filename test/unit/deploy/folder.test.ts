import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
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
	type Weighted,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
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
import {
	type CandidatePath,
	type EndsPath,
	type FieldPath,
	samePath
} from "#compiler/deploy/diff/plan.ts"
import {
	folderName,
	isFolderName,
	type MetaFile,
	type MetaPlainOffer,
	type MetaRelationStep,
	type MetaRequires,
	type MetaRootRename,
	type MetaStep,
	type MetaTopOffer,
	type MigrationMeta,
	metaFileName,
	orderFolderFiles,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { asDrafted, draftChain, compile, fromEmpty, draftedAt } from "#test/support/migrate/kit.ts"
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
					coverage: noCoverage,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
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
						coverage: noCoverage,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
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
							coverage: noCoverage,
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
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
type MetaKey = "schemaName" | "schema" | "source" | "target" | "kind" | "files"

/** A decision record short of its form or its proof, each refused: a reference naming no rename offer; two rename offers
 * of one path; a nested field's rename at the top of a file, or a relation's inside an alternative; a field's
 * `requires` naming a relation; a statement whose presence decides something written as another that can stand beside
 * it; a delete offer with statements; a choice offering nothing. */
type RecordMiss =
	| "a dangling path"
	| "two rename offers of one path"
	| "a nested field's rename at the top"
	| "a relation's rename inside an alternative"
	| "requires naming a relation"
	| "a head written as another statement"
	| "a delete offer with statements"
	| "a choice offering nothing"

type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "not an object"; readonly value: unknown }
	| { readonly kind: "field"; readonly key: MetaKey; readonly value: unknown }
	| { readonly kind: "removed"; readonly key: MetaKey }
	| { readonly kind: "custom with two snapshots" }
	| { readonly kind: "record"; readonly miss: RecordMiss }

const fingerprintGen = matching(regex("^[0-9a-f]{64}$"))

const fileNames = ["02-structure.sql", "05-publish.sql"] as const

const name = (n: string): string => `"repro"."${n}"`
const quoted = (n: string): string => `"${n}"`

/** A record's roots as the generator draws them, each with its path and its head: the relations' renames with their
 * nested fields' renames, a type's, a login's and a kept relation's field's. */
interface RelationDraw {
	readonly path: EndsPath<"relation">
	readonly nested: ReadonlyArray<{ readonly removed: string; readonly added: string }>
}

interface Roots {
	readonly relations: ReadonlyArray<RelationDraw>
	readonly type: EndsPath<"type"> | undefined
	readonly login: EndsPath<"login"> | undefined
	readonly field: FieldPath | undefined
}

/** Relations of removed and added names from two small pools, each pair at most once: two removed relations onto one
 * added one are rivals, their nested fields' renames of one pair of fields spelt alike. */
const relationsGen: Gen<ReadonlyArray<RelationDraw>> = (source) => {
	const pairs = source.draw(
		subarray([
			["first", "third"],
			["second", "third"],
			["first", "fourth"]
		] as const)
	)
	return Arr.map(pairs, ([removed, added]) => ({
		path: { kind: "relation", removed: name(removed), added: name(added) },
		nested: source.draw(
			subarray([
				{ removed: quoted("value"), added: quoted("amount") },
				{ removed: quoted("value"), added: quoted("price") }
			])
		)
	}))
}

const rootsGen: Gen<Roots> = (source) => ({
	relations: source.draw(relationsGen),
	type: source.draw(
		oneOf<EndsPath<"type"> | undefined>([
			constant(undefined),
			constant({ kind: "type", removed: name("kind"), added: name("category") })
		])
	),
	login: source.draw(
		oneOf<EndsPath<"login"> | undefined>([
			constant(undefined),
			constant({ kind: "login", removed: quoted("old"), added: quoted("new") })
		])
	),
	field: source.draw(
		oneOf<FieldPath | undefined>([
			constant(undefined),
			constant({ kind: "field", relation: name("kept"), removed: quoted("a"), added: quoted("b") })
		])
	)
})

/** Every path of a record's roots, nested fields' after their relation's. */
const pathsOf = (roots: Roots): ReadonlyArray<CandidatePath> => [
	...Arr.flatMap(roots.relations, (r): ReadonlyArray<CandidatePath> => [
		r.path,
		...Arr.map(r.nested, (n): CandidatePath => ({
			kind: "nested field",
			parent: r.path,
			removed: n.removed,
			added: n.added
		}))
	]),
	...(roots.type === undefined ? [] : [roots.type]),
	...(roots.login === undefined ? [] : [roots.login]),
	...(roots.field === undefined ? [] : [roots.field])
]

/** A record of a draft's roots: each root's rename offer in a choice of its own, a relation's alternative with a
 * statement, its nested fields' renames each in a choice of its own that a placeholder column's DROP DEFAULT follows,
 * and the loss of its dropped field that the nested renames carry; then a plain choice whose replace and delete offers
 * name drawn candidates, a confirmed group and a relation's loss. Every statement is spelt apart from every other but
 * the heads: a nested field's head names its relation's added relation and its two fields, so rivals spell theirs
 * alike. */
const recordOf = (roots: Roots, draw: <A>(gen: Gen<A>) => A): ReadonlyArray<MetaFile> => {
	let n = 0
	const fresh = (verb: string): string => {
		n++
		return `ALTER TABLE "repro"."t${n}" ${verb}`
	}
	const requires: MetaRequires = roots.type ?? { kind: "nothing" }
	const paths = pathsOf(roots)
	const some = (): ReadonlyArray<CandidatePath> => draw(subarray(paths))
	const relationSteps = Arr.map(roots.relations, (r): MetaStep => ({
		kind: "choice",
		keep: fresh(`CREATE ${n}`),
		follows: [],
		offers: [
			{
				kind: "relation rename",
				removed: r.path.removed,
				added: r.path.added,
				head: `ALTER TABLE ${r.path.removed} RENAME TO ${r.path.added}`,
				alternative: [
					{ kind: "statement", statement: fresh("RENAME CONSTRAINT") },
					...Arr.map(r.nested, (x): MetaRelationStep => ({
						kind: "choice",
						keep: fresh("ADD COLUMN"),
						follows: [fresh("ALTER COLUMN DROP DEFAULT")],
						offers: [
							{
								kind: "nested rename",
								removed: x.removed,
								added: x.added,
								requires,
								head: `ALTER TABLE ${r.path.added} RENAME COLUMN ${x.removed} TO ${x.added}`,
								alternative: []
							}
						]
					})),
					{
						kind: "loss",
						loses: { kind: "field", relation: r.path.removed, field: quoted("value") },
						statement: fresh("DROP COLUMN"),
						carriers: Arr.map(r.nested, (x): CandidatePath => ({
							kind: "nested field",
							parent: r.path,
							removed: x.removed,
							added: x.added
						}))
					}
				]
			}
		]
	}))
	const rootStep = (offer: MetaRootRename, keep: string): MetaStep => ({
		kind: "choice",
		keep,
		follows: [],
		offers: [offer]
	})
	const others = [
		...(roots.type === undefined
			? []
			: [
					rootStep(
						{
							kind: "rename",
							renames: {
								kind: "type",
								object: "TYPE",
								removed: roots.type.removed,
								added: roots.type.added
							},
							head: `ALTER TYPE ${roots.type.removed} RENAME TO ${roots.type.added}`,
							alternative: []
						},
						fresh("CREATE TYPE")
					)
				]),
		...(roots.login === undefined
			? []
			: [
					rootStep(
						{
							kind: "rename",
							renames: roots.login,
							head: `ALTER ROLE ${roots.login.removed} RENAME TO ${roots.login.added}`,
							alternative: []
						},
						fresh("CREATE ROLE")
					)
				]),
		...(roots.field === undefined
			? []
			: [
					rootStep(
						{
							kind: "rename",
							renames: { ...roots.field, requires },
							head: `ALTER TABLE ${roots.field.relation} RENAME COLUMN ${roots.field.removed} TO ${roots.field.added}`,
							alternative: []
						},
						fresh("ADD COLUMN")
					)
				])
	]
	const named = some()
	const [replaced, ...deleted] = named
	const plain: ReadonlyArray<MetaStep> =
		replaced === undefined
			? []
			: [
					{
						kind: "choice",
						keep: fresh("DROP CONSTRAINT"),
						follows: [],
						offers: [
							{ kind: "replace", candidate: replaced, statements: [fresh("DROP CONSTRAINT")] },
							...Arr.map(deleted, (candidate): MetaPlainOffer => ({ kind: "delete", candidate }))
						]
					}
				]
	const publish: ReadonlyArray<MetaStep> = [
		{ kind: "statement", statement: fresh("OWNER") },
		{ kind: "confirm", statements: [fresh("RENAME ASIDE"), fresh("RENAME ASIDE")] },
		{
			kind: "loss",
			loses: { kind: "relation", relation: name("gone") },
			statement: fresh("DROP"),
			carriers: some()
		}
	]
	return [
		{ name: fileNames[0], steps: [...relationSteps, ...others, ...plain] },
		{ name: fileNames[1], steps: publish }
	]
}

/** A custom migration's source and target are one snapshot, and it drafts nothing, so it records no files. */
const metaGen: Gen<readonly [MigrationMeta, Roots]> = (source) => {
	const fields = {
		schemaName: source.draw(matching(regex("^[A-Z][A-Za-z0-9]{0,8}$"))),
		schema: source.draw(matching(regex("^[a-z][a-z0-9_]{0,8}$"))),
		source: SchemaFingerprint(source.draw(fingerprintGen))
	}
	const target = SchemaFingerprint(source.draw(fingerprintGen))
	const custom = source.draw(boolean)
	const roots = source.draw(rootsGen)
	const files = recordOf(roots, (gen) => source.draw(gen))
	return [
		custom
			? { kind: "custom", ...fields, target: fields.source }
			: { kind: "drafted", ...fields, target, files },
		roots
	]
}

/** The values a field must not hold, by field: a custom migration's meta holds no files at all. */
const wrong: Arr.NonEmptyReadonlyArray<{
	readonly key: MetaKey
	readonly values: Arr.NonEmptyReadonlyArray<unknown>
}> = [
	{ key: "schemaName", values: ["", 7, null, ["Work"]] },
	{ key: "schema", values: ["", false, {}] },
	{ key: "source", values: ["", 1, null] },
	{ key: "target", values: ["", [], null] },
	{ key: "kind", values: ["Drafted", "", true, 0, null] },
	{ key: "files", values: [null, {}, [{ name: "", steps: [] }], [{ name: "01-setup.sql" }]] }
]

/** A record's near miss, made from a valid record whose roots are `roots`; none where the record has nothing to make
 * it of. */
const missed = (
	files: ReadonlyArray<MetaFile>,
	roots: Roots,
	miss: RecordMiss
): ReadonlyArray<unknown> | undefined => {
	const [top, ...rest] = files
	if (top === undefined) {
		return undefined
	}
	const added = (step: unknown): ReadonlyArray<unknown> => [
		{ name: top.name, steps: [...top.steps, step] },
		...rest
	]
	const [relation] = roots.relations
	switch (miss) {
		case "a dangling path":
			return added({
				kind: "choice",
				keep: "SELECT 1",
				follows: [],
				offers: [
					{ kind: "delete", candidate: { kind: "relation", removed: name("x"), added: name("y") } }
				]
			})
		case "two rename offers of one path": {
			const [own] = Arr.filter(
				top.steps,
				(step) =>
					step.kind === "choice" &&
					Arr.some(
						step.offers,
						(o: MetaTopOffer) => o.kind === "rename" || o.kind === "relation rename"
					)
			)
			return own === undefined ? undefined : added(own)
		}
		case "a nested field's rename at the top":
			return added({
				kind: "choice",
				keep: "SELECT 1",
				follows: [],
				offers: [
					{
						kind: "nested rename",
						removed: quoted("v"),
						added: quoted("w"),
						requires: { kind: "nothing" },
						head: "SELECT 2",
						alternative: []
					}
				]
			})
		case "a relation's rename inside an alternative":
			return relation === undefined
				? undefined
				: [
						{
							name: top.name,
							steps: Arr.map(top.steps, (step) =>
								step.kind === "choice"
									? {
											...step,
											offers: Arr.map(step.offers, (o: MetaTopOffer) =>
												o.kind === "relation rename"
													? {
															...o,
															alternative: [
																...o.alternative,
																{
																	kind: "choice",
																	keep: "SELECT 1",
																	follows: [],
																	offers: [
																		{
																			kind: "relation rename",
																			removed: name("x"),
																			added: name("y"),
																			head: "SELECT 2",
																			alternative: []
																		}
																	]
																}
															]
														}
													: o
											)
										}
									: step
							)
						},
						...rest
					]
		case "requires naming a relation":
			return added({
				kind: "choice",
				keep: "SELECT 1",
				follows: [],
				offers: [
					{
						kind: "rename",
						renames: {
							kind: "field",
							relation: name("other"),
							removed: quoted("c"),
							added: quoted("d"),
							requires: { kind: "relation", removed: name("x"), added: name("y") }
						},
						head: "SELECT 2",
						alternative: []
					}
				]
			})
		case "a head written as another statement":
			return relation === undefined
				? undefined
				: added({
						kind: "statement",
						statement: `ALTER TABLE ${relation.path.removed} RENAME TO ${relation.path.added}`
					})
		case "a delete offer with statements": {
			const [path] = pathsOf(roots)
			return path === undefined
				? undefined
				: added({
						kind: "choice",
						keep: "SELECT 1",
						follows: [],
						offers: [{ kind: "delete", candidate: path, statements: ["SELECT 2"] }]
					})
		}
		case "a choice offering nothing":
			return added({ kind: "choice", keep: "SELECT 1", follows: [], offers: [] })
	}
}

const recordMisses: Arr.NonEmptyReadonlyArray<RecordMiss> = [
	"a dangling path",
	"two rename offers of one path",
	"a nested field's rename at the top",
	"a relation's rename inside an alternative",
	"requires naming a relation",
	"a head written as another statement",
	"a delete offer with statements",
	"a choice offering nothing"
]

/** The faults of a meta: a field holding a wrong value, one of its keys removed, or its record short of its form or
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

/** A value as JSON text, as a hand-edited meta.json holds it. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const faulted = (
	meta: MigrationMeta,
	fault: Exclude<Fault, { readonly kind: "record" }>
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
		case "custom with two snapshots":
			return {
				...Rec.fromEntries(Arr.filter(Rec.toEntries(fields), ([k]) => k !== "files")),
				kind: "custom",
				target: meta.source === Str.repeat(64)("0") ? Str.repeat(64)("1") : Str.repeat(64)("0")
			}
	}
}

type MetaFeature = "two rival relations whose nested heads are spelt alike, read" | RecordMiss

describe("meta.json, generated", () => {
	it.effect(
		"reads back exactly what it writes, byte for byte, every candidate by its path, and refuses a value short of the format or its proof",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/meta",
						draw: drawn((source): readonly [MigrationMeta, Roots, Fault] => {
							const [meta, roots] = source.draw(metaGen)
							return [meta, roots, source.draw(faultGen(meta))]
						}),
						literal: Formatter.format,
						coverage: required<MetaFeature>(
							["two rival relations whose nested heads are spelt alike, read", ...recordMisses],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([meta, roots, fault], c) =>
						Effect.gen(function* () {
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
								const paths = Arr.flatMap(
									read.record.candidates,
									(r): ReadonlyArray<CandidatePath> =>
										r.kind === "relation" ? [r.path, ...Arr.map(r.fields, (x) => x.path)] : [r.path]
								)
								const drawnPaths = pathsOf(roots)
								assert.ok(
									paths.length === drawnPaths.length &&
										Arr.every(drawnPaths, (p) => Arr.some(paths, (q) => samePath(p, q))),
									"every candidate the record offers is read, by its path"
								)
								const rivalNested = Arr.some(roots.relations, (x) =>
									Arr.some(
										roots.relations,
										(y) =>
											x !== y &&
											x.path.added === y.path.added &&
											Arr.some(x.nested, (n) =>
												Arr.some(y.nested, (m) => n.removed === m.removed && n.added === m.added)
											)
									)
								)
								if (rivalNested) {
									c.note("two rival relations whose nested heads are spelt alike, read")
								}
								return
							}
							if (fault.kind === "record") {
								const files =
									meta.kind === "drafted" ? missed(meta.files, roots, fault.miss) : undefined
								if (files === undefined) {
									return
								}
								c.note(fault.miss)
								const read = readMeta(yield* jsonText({ ...meta, files }))
								if (Result.isSuccess(read)) {
									assert.fail(`${fault.miss} is read`)
								}
								assert.equal(read.failure.reason._tag, "MalformedArtifact")
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
