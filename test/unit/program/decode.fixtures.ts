/** What the properties of decode.test.ts read: the schema decoded, its rows, the faults a case plants, and its space. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	bytes as byteArray,
	characterOf,
	element,
	type Gen,
	int,
	string,
	subset,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Predicate, Record as Rec, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { slotPlace } from "#compiler/codec/fault.ts"
import type { EncodingPlace } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { previewOver } from "#compiler/program/preview.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { closed } from "#compiler/public/dynamic.ts"
import {
	bits,
	bytes,
	closedId,
	contract,
	date,
	Decimal,
	drawn,
	natural,
	pg
} from "#compiler/public/fields.ts"
import { fin, on, ordered, relation, schema, tree } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { NestedShape } from "#compiler/runtime/write/addition.ts"
import { bindWrite, type InsertedStratum } from "#compiler/runtime/write/bind.ts"
import { keptReadings } from "#compiler/runtime/write/decoded.ts"
import type { FlightWrite } from "#compiler/runtime/write/flight.ts"
import { levelNormalizer } from "#compiler/runtime/write/nesting.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type { FactsRefused } from "#compiler/types/changeset/decode.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** The roster the decoded rows' closed ids and sets are of. */
const Tone = closed.ordered("Tone", ["low", "mid", "high"])

const shortKey = Symbol("Short")
/** A text of at most four characters, a contract the host judges, and a word of lower-case letters, a pattern. */
const Short = contract<typeof shortKey>()("Short", str.regex("^.*$", "su"), (v) =>
	Logic.le(Text.charLength(v), 4)
)
const Word = str.regex("^[a-z]+$")

const countKey = Symbol("Count")
/** A count of no fewer than none: an integer under a contract. */
const Count = contract<typeof countKey>()("Count", pg.integer, (v) => Logic.ge(v, 0))

/** A relation inserted flat: a field of each carrier an export's rows hold, a contract, a pattern and a bytes field. */
const Flat = relation(
	"Flat",
	{
		id: Id,
		n: pg.integer,
		big: pg.bigint,
		amount: pg.numeric(5, 2),
		d: date,
		ok: pg.boolean,
		t: Short,
		w: Word,
		tone: closedId(Tone),
		tones: bits(Tone),
		b: bytes
	},
	["id"]
)

/** The owner of an ordered family whose members are inserted nested in it, at `items`. */
const Owner = relation("Owner", { id: Id, label: Short, items: drawn(natural) }, ["id"])

/** The ordered family's member: its owner and position drawn, its word and count its own. */
const Item = relation("Item", { owner: Id, at: drawn(natural), word: Word, qty: Count }, [
	"owner",
	"at"
])

/** A tree's node, each with its children nested in it, to any depth. */
const Node = relation(
	"Node",
	{
		root: Id,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		name: Short,
		tone: closedId(Tone)
	},
	["root", "start"]
)

export const Decoded = schema(
	"Decoded",
	[Tone, Flat, Owner, Item, Node],
	[
		ordered(on(Item, "owner", "at"), fin(Owner, "items")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["root"] })
	]
)

/** The relations insertAll takes at its top level, each decoded, and every stored relation a preview gives rows of. */
export const tops = ["Flat", "Owner", "Node"] as const
export type Top = (typeof tops)[number]
export const stored = [
	["Flat", Flat],
	["Owner", Owner],
	["Item", Item],
	["Node", Node]
] as const

/** The preview every case's rows are bound by, the schema compiled once, under the wire's transport. */
export const preview = succeeded(previewOver(Decoded, inForce(bindFrame)), "the schema compiles")

/** A row as a case writes it, a planted fault's value among its fields. */
type Row = Readonly<Record<string, unknown>>

/** A case's rows, under each top-level relation's name: its array, or the value a fault puts there instead. */
export type Rows = Readonly<Record<Top, unknown>>

/** The rows of no relation. */
const noRows: Readonly<Record<Top, ReadonlyArray<Row>>> = { Flat: [], Owner: [], Node: [] }

/**
 * The member slot a top-level relation's rows are bound in, as the write names it in its refusals: read off the
 * preview's own refusal of rows that are no array there.
 */
const slotOf = (relation: Top): string => {
	const refused = preview({ ...noRows, [relation]: 0 })
	if (refused.ok || refused.error._tag !== "InputRefused") {
		return assert.fail(`the preview refuses ${relation}'s rows that are no array`)
	}
	const { failure } = refused.error
	return failure._tag === "EncodingFailure" && failure.place._tag === "Slot"
		? failure.place.name
		: assert.fail(`the preview refuses ${relation}'s rows at its member slot`)
}
const slots: Readonly<Record<Top, string>> = {
	Flat: slotOf("Flat"),
	Owner: slotOf("Owner"),
	Node: slotOf("Node")
}

/**
 * The fault and place the write refuses a decode refusal's rows by: rows that are no array, and a row's shape, at the
 * relation's member slot; a field at the slot's field, at any depth of the row's nesting, as the write names it.
 */
export const writtenOf = (
	relation: Top,
	refused: Exclude<FactsRefused, { readonly _tag: "DomainRefused" | "Uncompiled" }>
): { readonly fault: string; readonly place: EncodingPlace } => {
	switch (refused._tag) {
		case "RowsRefused":
			return { fault: "factShape", place: slotPlace(slots[relation]) }
		case "ValueRefused":
			return {
				fault: refused.fault,
				place: slotPlace(
					refused.at.kind === "shape" ? slots[relation] : `${slots[relation]}.${refused.at.field}`
				)
			}
	}
}

/** The nth key of a case, each row's its own. */
const idOf = (n: number): string => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

const shortGen = string(characterOf(["a", "b", "é"]), { min: 0, max: 4 })
const wordGen = string(characterOf(["a", "z"]), { min: 1, max: 3 })
const toneGen = element(nonEmpty(Tone.handles, "Tone's handles"))

/** A row of Flat keyed by its nth id, every field inside its type and domain. */
const flatGen =
	(n: number): Gen<Row> =>
	(source) => ({
		id: idOf(n),
		n: int(-3, 3)(source),
		big: BigInt(int(-3, 3)(source)),
		amount: Decimal.of(`${String(int(0, 999)(source))}.25`),
		d: `2024-02-${String(int(10, 29)(source))}`,
		ok: boolean(source),
		t: shortGen(source),
		w: wordGen(source),
		tone: toneGen(source),
		tones: new Set(subset(Tone.handles, { min: 0, max: 3 })(source)),
		b: byteArray({ min: 0, max: 3 })(source)
	})

/** A row of Owner keyed by its nth id, with its items, each inside its domains. */
const ownerGen =
	(n: number): Gen<Row> =>
	(source) => ({
		id: idOf(n),
		label: shortGen(source),
		items: array((s) => ({ word: wordGen(s), qty: int(0, 3)(s) }), { min: 0, max: 2 })(source)
	})

/** A tree's node and its children, to `depth` more levels. */
const nodeGen =
	(depth: number): Gen<Row> =>
	(source) => ({
		name: shortGen(source),
		tone: toneGen(source),
		children: depth === 0 ? [] : array(nodeGen(depth - 1), { min: 0, max: 2 })(source)
	})

/** Each top-level relation's row keyed by its nth key, inside every domain. */
const rowGens: Readonly<Record<Top, (n: number) => Gen<Row>>> = {
	Flat: flatGen,
	Owner: ownerGen,
	Node: (n) => (source) => ({ root: idOf(n), ...nodeGen(2)(source) })
}

/** Between `size.min` and `size.max` rows of each top-level relation, each keyed apart from every other row. */
const rowsGen =
	(size: {
		readonly min: number
		readonly max: number
	}): Gen<Readonly<Record<Top, ReadonlyArray<Row>>>> =>
	(source) => {
		const of = (relation: Top, base: number): ReadonlyArray<Row> =>
			Array.from({ length: int(size.min, size.max)(source) }, (_, i) =>
				rowGens[relation](base + i)(source)
			)
		return { Flat: of("Flat", 0), Owner: of("Owner", 100), Node: of("Node", 200) }
	}

/**
 * Where a planted value sits: a top-level relation's own field, or its nesting's member's (an owner's first item, a
 * root's first child).
 */
interface Site {
	readonly relation: Top
	readonly depth: "own" | "member"
	readonly field: string
}

/** A site with the values the code branches on there: those its field's type refuses, and those its domain does. */
interface SiteValues extends Site {
	readonly typed: Arr.NonEmptyReadonlyArray<unknown>
	readonly domain: ReadonlyArray<unknown>
}

/** Every site, with its values. */
const sites: Arr.NonEmptyReadonlyArray<SiteValues> = [
	{ relation: "Flat", depth: "own", field: "id", typed: ["no uuid", 7], domain: [] },
	{ relation: "Flat", depth: "own", field: "n", typed: [1.5, 2 ** 31, 1n], domain: [] },
	{ relation: "Flat", depth: "own", field: "big", typed: [1, 2n ** 63n], domain: [] },
	{
		relation: "Flat",
		depth: "own",
		field: "amount",
		typed: [Decimal.of("1.234"), 1.5],
		domain: []
	},
	{ relation: "Flat", depth: "own", field: "d", typed: ["2023-02-30", "2024-13-01"], domain: [] },
	{ relation: "Flat", depth: "own", field: "ok", typed: ["yes"], domain: [] },
	{ relation: "Flat", depth: "own", field: "t", typed: ["a\u0000"], domain: ["abcde"] },
	{ relation: "Flat", depth: "own", field: "w", typed: [3], domain: ["A1", "ab c"] },
	{ relation: "Flat", depth: "own", field: "tone", typed: ["purple", 1], domain: [] },
	{
		relation: "Flat",
		depth: "own",
		field: "tones",
		typed: [new Set(["purple"]), ["low"]],
		domain: []
	},
	{ relation: "Flat", depth: "own", field: "b", typed: ["AQI=", [1, 2]], domain: [] },
	{ relation: "Owner", depth: "own", field: "label", typed: [5], domain: ["abcde"] },
	{ relation: "Owner", depth: "member", field: "word", typed: [1], domain: ["Ab"] },
	{ relation: "Owner", depth: "member", field: "qty", typed: [1.5, "1"], domain: [-1] },
	{ relation: "Node", depth: "own", field: "name", typed: ["a\u0000"], domain: ["abcde"] },
	{ relation: "Node", depth: "member", field: "name", typed: [2], domain: ["abcde"] },
	{ relation: "Node", depth: "member", field: "tone", typed: ["purple"], domain: [] }
]

/** What a planted fault does to a row: its whole value, or one key of it. */
type RowFault =
	| "null row"
	| "no record"
	| "extra key"
	| "missing key"
	| "renamed key"
	| "null field"

/** The one fault a case plants in its rows, or none. */
export type Planted =
	| { readonly kind: "none" }
	| { readonly kind: "no array"; readonly relation: Top }
	| {
			readonly kind: "row"
			readonly relation: Top
			readonly depth: Site["depth"]
			readonly row: number
			readonly fault: RowFault
	  }
	| {
			readonly kind: "value"
			readonly site: Site
			readonly row: number
			readonly value: unknown
	  }
	| { readonly kind: "unsplit"; readonly relation: "Owner" | "Node"; readonly row: number }

/** A case: its rows, and the fault planted in them, or none. */
export interface DecodeCase {
	readonly rows: Rows
	readonly planted: Planted
}

/** A row with its key `field` changed as `fault` says, or the row's whole value changed. */
const rowWith = (row: Row, fault: RowFault, field: string): unknown => {
	const without = Rec.filter(row, (_, key) => key !== field)
	switch (fault) {
		case "null row":
			return null
		case "no record":
			return [row]
		case "extra key":
			return { ...row, stray: 1 }
		case "missing key":
			return without
		case "renamed key":
			return { ...without, stray: 1 }
		case "null field":
			return { ...row, [field]: null }
	}
}

/** The field of a level's row a key fault reads: each level's first own field. */
const keyed: Readonly<Record<Top, Readonly<Record<Site["depth"], string>>>> = {
	Flat: { own: "id", member: "id" },
	Owner: { own: "label", member: "word" },
	Node: { own: "name", member: "name" }
}

/** The count field a relation's members are nested at, and a member inside every domain, of each relation that nests. */
const nestings: Readonly<Record<Top, { readonly key: string; readonly member: Row } | undefined>> =
	{
		Flat: undefined,
		Owner: { key: "items", member: { word: "a", qty: 0 } },
		Node: { key: "children", member: { name: "a", tone: "low", children: [] } }
	}

/**
 * `rows` with `relation`'s row at `at`, or at its first member, changed by `change`: rows drawn first where the relation
 * holds too few, keyed apart from the drawn ones, and a member put first in its owner's nesting, so every fault lands.
 */
const changed = (
	source: Parameters<Gen<unknown>>[0],
	rows: Readonly<Record<Top, ReadonlyArray<Row>>>,
	relation: Top,
	at: number,
	depth: Site["depth"],
	change: (row: Row) => unknown
): Rows => {
	const drawn = rows[relation]
	const all = [
		...drawn,
		...Array.from({ length: Math.max(0, at + 1 - drawn.length) }, (_, i) =>
			rowGens[relation](900 + i)(source)
		)
	]
	const nesting = nestings[relation]
	return {
		...rows,
		[relation]: Arr.map(all, (row, i): unknown => {
			if (i !== at) {
				return row
			}
			if (depth === "own" || nesting === undefined) {
				return change(row)
			}
			const members = row[nesting.key]
			const rest: ReadonlyArray<unknown> = Arr.isArray(members) ? Arr.drop(members, 1) : []
			return { ...row, [nesting.key]: [change(nesting.member), ...rest] }
		})
	}
}

const topGen = element(tops)

/** A value planted at a site: one of its type's refused values, or of its domain's where it has some and the draw says. */
const valueAt =
	(site: SiteValues): Gen<Planted> =>
	(source) => {
		const values =
			boolean(source) && Arr.isReadonlyArrayNonEmpty(site.domain) ? site.domain : site.typed
		return {
			kind: "value",
			site: { relation: site.relation, depth: site.depth, field: site.field },
			row: int(0, 3)(source),
			value: values[int(0, values.length - 1)(source)]
		}
	}

/** The faults a case plants in rows that are arrays (Planted), each with its weight: a row's, a value's, a nesting's. */
const inArrays: Arr.NonEmptyReadonlyArray<Weighted<Planted>> = [
	[2, () => ({ kind: "none" })],
	[
		3,
		(s) => ({
			kind: "row",
			relation: topGen(s),
			depth: element(["own", "member"] as const)(s),
			row: int(0, 3)(s),
			fault: element([
				"null row",
				"no record",
				"extra key",
				"missing key",
				"renamed key",
				"null field"
			] as const)(s)
		})
	],
	[4, (s) => valueAt(element(sites)(s))(s)],
	[
		1,
		(s) => ({
			kind: "unsplit",
			relation: element(["Owner", "Node"] as const)(s),
			row: int(0, 3)(s)
		})
	]
]

/** A planted fault (Planted), at a row any of its relation's, or none. */
const plantedGen: Gen<Planted> = weighted<Planted>([
	...inArrays,
	[1, (s) => ({ kind: "no array", relation: topGen(s) })]
])

/** A case of `planted` (DecodeCase): rows drawn small, then the fault planted in them, at its row, or none. */
const caseOf =
	(planted: Gen<Planted>, least: number): Gen<DecodeCase> =>
	(source) => {
		const rows = rowsGen({ min: least, max: 3 })(source)
		const fault = planted(source)
		switch (fault.kind) {
			case "none":
				return { rows, planted: fault }
			case "no array":
				return {
					rows: { ...rows, [fault.relation]: element([0, "rows", {}])(source) },
					planted: fault
				}
			case "row":
				return {
					rows: changed(source, rows, fault.relation, fault.row, fault.depth, (row) =>
						rowWith(row, fault.fault, keyed[fault.relation][fault.depth])
					),
					planted: fault
				}
			case "value":
				return {
					rows: changed(source, rows, fault.site.relation, fault.row, fault.site.depth, (row) => ({
						...row,
						[fault.site.field]: fault.value
					})),
					planted: fault
				}
			case "unsplit": {
				const key = fault.relation === "Owner" ? "items" : "children"
				return {
					rows: changed(source, rows, fault.relation, fault.row, "own", (row) => ({
						...row,
						[key]: 3
					})),
					planted: fault
				}
			}
		}
	}

/** A value planted at `field` of a row of Flat, one of the values listed for it alone. */
const plantedAt =
	(field: string, value: unknown): Gen<Planted> =>
	(source) => ({
		kind: "value",
		site: { relation: "Flat", depth: "own", field },
		row: int(0, 3)(source),
		value
	})

/**
 * The cases (DecodeCase): every fault drawn, and, for each situation few draws reach, cases constructed to reach it:
 * a handle no roster holds, a set of one, a bytes value that is no Uint8Array, a nested member's field and a tree
 * child's.
 */
export const caseSpace: Aimed<DecodeCase, DecodeFeature> = aimed(caseOf(plantedGen, 0), [
	["a handle no roster holds", caseOf(plantedAt("tone", "purple"), 0)],
	["a set of a handle no roster holds", caseOf(plantedAt("tones", new Set(["purple"])), 0)],
	["a bytes field", caseOf(plantedAt("b", "AQI="), 0)],
	[
		"a nested member's field",
		caseOf(
			(source) => ({
				kind: "value",
				site: { relation: "Owner", depth: "member", field: "qty" },
				row: int(0, 3)(source),
				value: -1
			}),
			0
		)
	],
	[
		"a tree's child's field",
		caseOf(
			(source) => ({
				kind: "value",
				site: { relation: "Node", depth: "member", field: "tone" },
				row: int(0, 3)(source),
				value: "purple"
			}),
			0
		)
	],
	[
		"a nesting that does not split",
		caseOf((source) => ({ kind: "unsplit", relation: "Node", row: int(0, 3)(source) }), 0)
	]
])

/** What a case reaches: the faults decode meets and where, the situations its witnesses must reach. */
export type DecodeFeature =
	| "no fault"
	| "rows that are no array"
	| "a row's shape"
	| "a missing field"
	| "a NULL"
	| "a value its type refuses"
	| "a value its domain refuses"
	| "a nested member's field"
	| "a tree's child's field"
	| "a nesting that does not split"
	| "a bytes field"
	| "a handle no roster holds"
	| "a set of a handle no roster holds"

export const decodeFeatures: Arr.NonEmptyReadonlyArray<DecodeFeature> = [
	"no fault",
	"rows that are no array",
	"a row's shape",
	"a missing field",
	"a NULL",
	"a value its type refuses",
	"a value its domain refuses",
	"a nested member's field",
	"a tree's child's field",
	"a nesting that does not split",
	"a bytes field",
	"a handle no roster holds",
	"a set of a handle no roster holds"
]

/** A top-level relation's row with its key the nth: its id, or a tree's root. */
const rekeyed = (relation: Top, row: Row, n: number): Row =>
	relation === "Node" ? { ...row, root: idOf(n) } : { ...row, id: idOf(n) }

/**
 * Rows of each top-level relation, one to three, and twice as many: the same rows, then each again under a key of its
 * own, so the second set decodes exactly the first's work twice over, row for row.
 */
export const doubledGen: Gen<{
	readonly once: Readonly<Record<Top, ReadonlyArray<Row>>>
	readonly twice: Readonly<Record<Top, ReadonlyArray<Row>>>
}> = (source) => {
	const once = rowsGen({ min: 1, max: 3 })(source)
	const twice = (relation: Top): ReadonlyArray<Row> => [
		...once[relation],
		...Arr.map(once[relation], (row, i) => rekeyed(relation, row, 500 + i))
	]
	return { once, twice: { Flat: twice("Flat"), Owner: twice("Owner"), Node: twice("Node") } }
}

/**
 * A value as a caller states it again: every array and plain record in it a copy, every other value its own, so no
 * array of it is one decode admitted.
 */
const undecoded = (value: unknown): unknown =>
	Arr.isArray(value)
		? Arr.map(value, undecoded)
		: Predicate.isObject(value) && Object.getPrototypeOf(value) === Object.prototype
			? Rec.map(value, undecoded)
			: value

/** A case's rows as a caller states them again (`undecoded`), each relation's rows a copy, its values the same. */
export const undecodedRows = (rows: Rows): Rows => Rec.map(rows, undecoded)

/** Rows of each top-level relation that are arrays, as insertAll takes them. */
export type ArrayRows = Readonly<Record<Top, ReadonlyArray<unknown>>>

/** A case's rows where every relation's are an array, as insertAll takes them, or none. */
export const arrayRows = (rows: Rows): ArrayRows | undefined =>
	Arr.isArray(rows.Flat) && Arr.isArray(rows.Owner) && Arr.isArray(rows.Node)
		? { Flat: rows.Flat, Owner: rows.Owner, Node: rows.Node }
		: undefined

/**
 * insertAll over every top-level relation, compiled once, the whole served write, its statements among it, under the
 * schema's first codes, the decoder's.
 */
const insertAll = succeeded(
	compileWrite(
		checking(Decoded),
		descOf(changeSetOver.empty(Decoded).insertAll({ Flat: [], Owner: [], Node: [] })),
		realityWrite(succeeded(testArtifacts(Decoded, testCompile), "the schema compiles"))
	),
	"insertAll compiles"
)

/** Each roster's codes one later, past a hole at the first code: an installation's codes that are not the decoder's. */
const shifted = (codes: Codebook): Codebook => ({
	rosters: new Map(
		Arr.map([...codes.rosters], ([name, codec]) => [
			name,
			rosterCodec(name, [{ kind: "hole" }, ...codec.codes])
		])
	),
	spellings: noSpellings
})

/** Where an insert is bound: under the decoder's own codes, and under an installation's other codes. */
export const codings = ["the decoder's codes", "other codes"] as const

/** The insert's flight under each coding (`codings`). */
export const flights: Readonly<Record<(typeof codings)[number], FlightWrite>> = {
	"the decoder's codes": flightOf(servableWrite(insertAll), insertAll.frontend.codes, noAdvice),
	"other codes": flightOf(servableWrite(insertAll), shifted(insertAll.frontend.codes), noAdvice)
}

/** The transport every insert is bound under: the wire's. */
const transport = inForce(bindFrame)

/**
 * What binding `ChangeSet.empty(Decoded).insertAll(rows)` under `flight` gives before any SQL (runtime/write/bind.ts
 * bindWrite), the write every application runs: every statement's executions, none of one the write skips, or the
 * write's refusal; and the rows it inserts, where it binds.
 */
export const outcomeOf = (flight: FlightWrite, rows: ArrayRows) =>
	Effect.map(
		collectInputs(
			insertAll.binding.groups,
			parsedOf(changeSetOver.empty(Decoded).insertAll(rows)).inputs
		),
		(members) => {
			const bound = bindWrite(flight, { members, params: {}, transport })
			if (!bound.ok) {
				return { outcome: { kind: "refused", refusal: bound.error }, inserted: [] } as const
			}
			const write = bound.value
			switch (write.kind) {
				case "bound":
					return {
						outcome: {
							kind: "bound",
							statements: Arr.map(flight.statements, (statement) =>
								write.skip.has(statement.index) ? undefined : write.chunks(statement, transport)
							)
						},
						inserted: write.inserted()
					} as const
				case "invariant-rejected":
				case "generated-rejected":
					return { outcome: { kind: "rejected", write }, inserted: [] } as const
			}
		}
	)

/** What a case does to its rows once decode has read them: nothing, or a bytes value's buffer detached. */
const afterwards = ["nothing", "a buffer detached"] as const
type Afterward = (typeof afterwards)[number]

/**
 * Detaches the buffer of the first bytes value among Flat's rows, where one is, as a caller may once decode has read
 * it: whether one was.
 */
export const detachedOne = (rows: ArrayRows): boolean => {
	for (const row of rows.Flat) {
		const b: unknown = Predicate.isObject(row) ? row["b"] : undefined
		if (b instanceof Uint8Array && b.buffer instanceof ArrayBuffer) {
			b.buffer.transfer()
			return true
		}
	}
	return false
}

/** Puts a handle no roster holds into every set the rows `inserted` hold, as a caller may: whether one was. */
export const setsChanged = (inserted: ReadonlyArray<InsertedStratum>): boolean => {
	const sets = Arr.flatMap(inserted, (stratum) =>
		Arr.flatMap([...stratum.rows.values()], (rows) =>
			Arr.flatMap(rows, (row) =>
				Arr.filter(Array.from(row.values), (value) => value instanceof Set)
			)
		)
	)
	for (const set of sets) {
		set.add("purple")
	}
	return sets.length > 0
}

/** A case of the insert's differential: its rows and the fault planted in them, and what it does to them after decode. */
interface TakenCase {
	readonly decoded: DecodeCase
	readonly afterward: Afterward
}

/** What a case of the insert's differential reaches. */
export type TakenFeature =
	| "a flat relation's reads taken"
	| "a nested relation's readings taken"
	| "refused alike"
	| "a buffer detached since"
	| "a set taken again"

export const takenFeatures: Arr.NonEmptyReadonlyArray<TakenFeature> = [
	"a flat relation's reads taken",
	"a nested relation's readings taken",
	"refused alike",
	"a buffer detached since",
	"a set taken again"
]

/** A case of `planted` in rows of at least `least` rows each, then `afterward`. */
const takenOf =
	(planted: Gen<Planted>, least: number, afterward: Gen<Afterward>): Gen<TakenCase> =>
	(source) => ({ decoded: caseOf(planted, least)(source), afterward: afterward(source) })

/**
 * The insert's differential's cases (TakenCase): every fault drawn in rows that are arrays, then nothing or a buffer
 * detached; and rows with no fault, each relation's one or more, then a buffer detached, which few draws reach.
 */
export const takenSpace: Aimed<TakenCase, TakenFeature> = aimed(
	takenOf(weighted<Planted>(inArrays), 0, element(afterwards)),
	[
		[
			"a buffer detached since",
			takenOf(
				() => ({ kind: "none" }),
				1,
				() => "a buffer detached"
			)
		]
	]
)

/** Each relation a nested row holds, with the family it owns, by its count field and its member relation, or none. */
const nestedIn: Readonly<
	Record<string, { readonly count: string; readonly member: string } | undefined>
> = {
	Owner: { count: "items", member: "Item" },
	Item: undefined,
	Node: { count: "children", member: "Node" }
}

/** The top-level relations whose rows nest others. */
export const nestedTops = ["Owner", "Node"] as const satisfies ReadonlyArray<Top>

/**
 * The readings decode recorded of `rows`, decoded rows of `relation`, as the insert's own levels take them
 * (runtime/write/decoded.ts keptReadings): each level read under the heading the insert's nesting gives it, under the
 * decoder's codes; none where decode recorded none.
 */
export const keptOf = (relation: (typeof nestedTops)[number], rows: ReadonlyArray<unknown>) => {
	const flight = flights["the decoder's codes"]
	const [nesting] = Arr.flatMap(flight.prepared.groups, (g) =>
		Arr.flatMap(g.inputs, (input) =>
			input.kind === "nested" && input.nesting.relation === relation ? [input.nesting] : []
		)
	)
	if (nesting === undefined) {
		return assert.fail(`the insert nests ${relation}`)
	}
	const level = (of: StoredRelationName, heading: Heading) => ({
		normalize: levelNormalizer(of, heading, relation, flight.codes)
	})
	return keptReadings(rows, {
		own: level(nesting.relation, nesting.own),
		members: new Map(Arr.map(nesting.sequences, (f) => [f.id, level(f.member, f.heading)] as const))
	})?.readings
}

/** A nesting's node as a property compares it: its own keys, its relation, and each family's own keys and members. */
export interface DescribedNode {
	readonly keys: ReadonlyArray<string>
	readonly relation: string
	readonly families: ReadonlyArray<{
		readonly keys: ReadonlyArray<string>
		readonly members: ReadonlyArray<DescribedNode>
	}>
}

/** A kept reading's shape described, node for node (`DescribedNode`). */
export const describedShape = (node: NestedShape): DescribedNode => ({
	keys: Arr.map(Reflect.ownKeys(node), String),
	relation: node.relation,
	families: Arr.map(node.families, (g) => ({
		keys: Arr.map(Reflect.ownKeys(g), String),
		members: Arr.map(g.members, describedShape)
	}))
})

/**
 * What a reading keeps of `row`, a row of `relation`, by the rule: its nesting's shape and nothing more, each node its
 * relation, its slot and its families alone, each family its id and its members, the row's own in order, to any depth.
 */
export const shapeOfRow = (relation: string, row: unknown): DescribedNode => {
	const family = nestedIn[relation]
	return {
		keys: ["relation", "slot", "families"],
		relation,
		families:
			family === undefined
				? []
				: [
						{
							keys: ["family", "members"],
							members: Arr.map(membersOf(row, family.count), (member) =>
								shapeOfRow(family.member, member)
							)
						}
					]
	}
}

/** The members a row states at a count field: its array there, none where it states none. */
const membersOf = (row: unknown, count: string): ReadonlyArray<unknown> => {
	const members: unknown = Predicate.hasProperty(row, count) ? row[count] : undefined
	return Arr.isArray(members) ? members : []
}

/** How many nodes a described nesting holds: one level's read each. */
export const nodesOf = (node: DescribedNode): number =>
	1 + Arr.reduce(node.families, 0, (n, g) => n + Arr.reduce(g.members, 0, (m, x) => m + nodesOf(x)))
