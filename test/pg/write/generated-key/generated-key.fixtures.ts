/** What the property of generated-key.test.ts reads: the Keys schema and template, its space, and each case. */
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted,
	aimed
} from "@bjornpagen/testing/gen"
import { type Case as PropertyCase } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { type LawId } from "#compiler/core/ids.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Text, Type } from "#compiler/public/compute.ts"
import { drawn as drawnField, generated, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	fin,
	key,
	mutable,
	on,
	ordered,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type ParamMap } from "#compiler/types/core/phantom.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { writeAnswerOf, rowsOf, writeOnce } from "#test/support/calls.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { namesOf, type LawNames, lawNamesOf } from "#test/support/kernel/naming.ts"
import {
	type HostFact,
	type HostLaw,
	type HostOp,
	type HostRelation,
	type HostSchema,
	type HostState,
	refusedBy,
	sameState,
	sameValues,
	sortedStateRows,
	transition,
	type Violation,
	valueText,
	violations
} from "#test/support/laws/model.ts"
import { fixtureTemplate, openedIn } from "#test/support/pg/reads/support.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import type { SubstrateCase } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"
/** A key's text: a one-digit integer behind any leading zeros, its sign spelled or not, at most four bytes. */
const KeyText = str.bytes(4, str.regex("^-?0*[0-9]$", "u"))

/** A typed map key: the integer its text spells, and whether the text spells it with a minus. */
const MapKey = relation.generated(
	"MapKey",
	{ mapping: pg.integer, text: KeyText },
	["mapping", "text"],
	(r) => ({
		value: generated(pg.integer, Type.cast(r.text, pg.integer)),
		negative: generated(pg.boolean, Text.startsWith(r.text, "-"))
	})
)
const typedKey = key(on(MapKey, "mapping", "value", "negative"))

/** A reference to a typed map key. */
const Use = relation(
	"Use",
	{ id: pg.integer, mapping: pg.integer, value: pg.integer, negative: pg.boolean },
	["id"]
)
const useRef = contained(
	on(Use, "mapping", "value", "negative"),
	on(MapKey, "mapping", "value", "negative")
)

/** A tag: at most one of each positive value. */
const Tag = relation.generated("Tag", { id: pg.integer, text: KeyText }, ["id"], (r) => ({
	value: generated(pg.integer, Type.cast(r.text, pg.integer))
}))
const positiveTag = key(
	on(
		select(Tag, (t) => t.gt(t.value, 0)),
		"value"
	)
)

/** A mapping's entries, in order, each named by its text, so a put appends one, and each a typed key of its own. */
const Mapping = relation("Mapping", { id: pg.integer, n: drawnField(natural) }, ["id"])
const Entry = relation.generated(
	"Entry",
	{ mapping: pg.integer, at: drawnField(natural), text: KeyText },
	["mapping", "text"],
	(r) => ({
		value: generated(pg.integer, Type.cast(r.text, pg.integer)),
		negative: generated(pg.boolean, Text.startsWith(r.text, "-"))
	})
)
const entries = ordered(on(Entry, "mapping", "at"), fin(Mapping, "n"))
const entryKey = key(on(Entry, "mapping", "value", "negative"))

const Keys = schema(
	"Keys",
	[MapKey, Use, Tag, Mapping, Entry],
	[
		typedKey,
		useRef,
		positiveTag,
		entries,
		entryKey,
		mutable(MapKey),
		mutable(Tag),
		mutable(Mapping),
		mutable(Entry),
		unit("Map", { mapping: pg.integer }),
		unit("Row", { id: pg.integer })
	]
)

/**
 * The rows of a query over the relation parameter `name`, as a stratum's query write reads them (see the case's
 * stratum): each row's `text` a KeyText, which the write casts to the parameter's own pattern domain.
 */
const paramRows = (name: string) =>
	query(Keys).rule((r) => {
		const rows = r.relation(name, { id: pg.integer, text: KeyText })
		const row = v(rows, "row")
		return r.match(rows, row).find(row)
	})

/**
 * The full world's workload: the stored state's insert, MapKey, Use, Tag and new mappings from each call's facts; each
 * relation's rows as grizzle reads them, generated and drawn fields included; and a Tag insert from the rows of each
 * relation parameter a case's stratum may bind, rows0 to rows2, one per write, so the installation installs the pattern
 * domain of each one's text, the only types a stratum served under its snapshot may cast a parameter to.
 */
const programs = Object.freeze({
	rows0: ChangeSet.empty(Keys).insert(Tag, paramRows("rows0")),
	rows1: ChangeSet.empty(Keys).insert(Tag, paramRows("rows1")),
	rows2: ChangeSet.empty(Keys).insert(Tag, paramRows("rows2")),
	seed: ChangeSet.empty(Keys)
		.insert(MapKey, [])
		.insert(Use, [])
		.insert(Tag, [])
		.insert(Mapping, []),
	mapKeys: query(Keys).rule((r) => {
		const { mapping, text, value, negative } = v(MapKey, "k")
		return r
			.match(MapKey, { mapping, text, value, negative })
			.find({ mapping, text, value, negative })
	}),
	uses: query(Keys).rule((r) => {
		const { id, mapping, value, negative } = v(Use, "u")
		return r.match(Use, { id, mapping, value, negative }).find({ id, mapping, value, negative })
	}),
	tags: query(Keys).rule((r) => {
		const { id, text, value } = v(Tag, "t")
		return r.match(Tag, { id, text, value }).find({ id, text, value })
	}),
	mappings: query(Keys).rule((r) => {
		const { id, n } = v(Mapping, "m")
		return r.match(Mapping, { id, n }).find({ id, n })
	}),
	entries: query(Keys).rule((r) => {
		const { mapping, at, text, value, negative } = v(Entry, "e")
		return r
			.match(Entry, { mapping, at, text, value, negative })
			.find({ mapping, at, text, value, negative })
	})
})

/** The texts a case draws: three values, both signs and two paddings, so two texts often spell one typed key. */
type KeyTextValue = `${"" | "-"}${"" | "0"}${"0" | "1" | "2"}`

interface MapKeyRow {
	readonly mapping: number
	readonly text: KeyTextValue
}
interface TagRow {
	readonly id: number
	readonly text: KeyTextValue
}
interface UseRow {
	readonly id: number
	readonly mapping: number
	readonly value: number
	readonly negative: boolean
}
interface MappingRow {
	readonly id: number
	readonly entries: Arr.NonEmptyReadonlyArray<KeyTextValue>
}
/** An entry appended to a stored mapping, as its put states it: its mapping and its text, its slot drawn by grizzle. */
interface EntryRow {
	readonly mapping: number
	readonly text: KeyTextValue
}

type Edit = "insert" | "put" | "delete"
type Source = "array" | "query"

/** One write of a case's stratum: an edit of MapKey or Tag from an array or a query, an insert of Use or of new
 * mappings with their entries nested, or a put of entries appended to stored mappings. */
type Write =
	| {
			readonly relation: "MapKey"
			readonly edit: Edit
			readonly source: Source
			readonly rows: Arr.NonEmptyReadonlyArray<MapKeyRow>
	  }
	| {
			readonly relation: "Tag"
			readonly edit: Edit
			readonly source: Source
			readonly rows: Arr.NonEmptyReadonlyArray<TagRow>
	  }
	| { readonly relation: "Use"; readonly rows: Arr.NonEmptyReadonlyArray<UseRow> }
	| { readonly relation: "Mapping"; readonly rows: Arr.NonEmptyReadonlyArray<MappingRow> }
	| { readonly relation: "Entry"; readonly rows: Arr.NonEmptyReadonlyArray<EntryRow> }

/** The rows stored before the write, lawful together. */
interface Stored {
	readonly mapKeys: ReadonlyArray<MapKeyRow>
	readonly uses: ReadonlyArray<UseRow>
	readonly tags: ReadonlyArray<TagRow>
	readonly mappings: ReadonlyArray<MappingRow>
}

interface Case {
	readonly stored: Stored
	readonly writes: Arr.NonEmptyReadonlyArray<Write>
}

/** A query write as a member of its stratum: its ChangeSet and the parameter its query binds. */
interface QueryWritten {
	readonly kind: "query"
	readonly changes: unknown
	readonly params: ParamMap
}

/** An array write as a member of its stratum: its op, its relation, its ChangeSet's array member and its rows. */
interface ArrayWritten {
	readonly kind: "array"
	readonly op: Edit
	readonly relation: Write["relation"]
	readonly changes: unknown
	readonly rows: ReadonlyArray<unknown>
}

type Written = QueryWritten | ArrayWritten

/** The integer a key's text spells, as the model reads it, apart from grizzle. */
const valueOf = (text: KeyTextValue): number => Number(BigInt(text))

/** Whether a key's text spells its integer with a minus. */
const negativeOf = (text: KeyTextValue): boolean => Str.startsWith("-")(text)

/** A text of a sign, a padding and a value. */
const textGen: Gen<KeyTextValue> = (source) => {
	const sign = source.draw(element(["", "-"] as const))
	const pad = source.draw(element(["", "0"] as const))
	const digit = source.draw(element(["0", "1", "2"] as const))
	return `${sign}${pad}${digit}`
}

/** Each text's other spelling of its typed key: its value and sign, the other padding. */
const respelling: Readonly<Record<KeyTextValue, KeyTextValue>> = {
	"0": "00",
	"00": "0",
	"1": "01",
	"01": "1",
	"2": "02",
	"02": "2",
	"-0": "-00",
	"-00": "-0",
	"-1": "-01",
	"-01": "-1",
	"-2": "-02",
	"-02": "-2"
}

const mapKeyGen: Gen<MapKeyRow> = (source) => ({
	mapping: source.draw(int(1, 2)),
	text: source.draw(textGen)
})
const tagGen: Gen<TagRow> = (source) => ({ id: source.draw(int(1, 3)), text: source.draw(textGen) })

/** The facts of the model's relations, each with its generated fields computed from its text. */
const mapKeyFact = (r: MapKeyRow): HostFact => ({
	mapping: r.mapping,
	text: r.text,
	value: valueOf(r.text),
	negative: negativeOf(r.text)
})
const tagFact = (r: TagRow): HostFact => ({ id: r.id, text: r.text, value: valueOf(r.text) })
const useFact = (r: UseRow): HostFact => ({
	id: r.id,
	mapping: r.mapping,
	value: r.value,
	negative: r.negative
})
const mappingFacts = (
	r: MappingRow
): { readonly mapping: HostFact; readonly entries: ReadonlyArray<HostFact> } => ({
	mapping: { id: r.id, n: r.entries.length },
	entries: Arr.map(r.entries, (text, at) => ({
		mapping: r.id,
		at,
		text,
		value: valueOf(text),
		negative: negativeOf(text)
	}))
})

/** The laws of Keys as the host states them, each by its installed law id, the family's own law left out: grizzle
 * draws its members' indexes and its count, so no write breaks it. */
interface KeysLaws {
	readonly mapKeyPrimary: LawId
	readonly typedKey: LawId
	readonly usePrimary: LawId
	readonly useRef: LawId
	readonly tagPrimary: LawId
	readonly positiveTag: LawId
	readonly mappingPrimary: LawId
	readonly entryPrimary: LawId
	readonly entryKey: LawId
}

const relationOf = (
	name: string,
	fields: ReadonlyArray<string>,
	keyFields: ReadonlyArray<string>,
	isMutable: boolean
): HostRelation => ({
	name,
	table: name,
	fields: Arr.map(fields, (f) => ({ name: f, column: f })),
	key: keyFields,
	mutable: isMutable
})

const keyLaw = (law: LawId, relationName: string, fields: ReadonlyArray<string>): HostLaw => ({
	kind: "key",
	law,
	relation: relationName,
	fields,
	selection: { kind: "every" }
})

/** Keys as the law model states it. */
const hostOf = (laws: KeysLaws): HostSchema => ({
	relations: [
		relationOf("MapKey", ["mapping", "text", "value", "negative"], ["mapping", "text"], true),
		relationOf("Use", ["id", "mapping", "value", "negative"], ["id"], false),
		relationOf("Tag", ["id", "text", "value"], ["id"], true),
		relationOf("Mapping", ["id", "n"], ["id"], true),
		relationOf("Entry", ["mapping", "at", "text", "value", "negative"], ["mapping", "text"], true)
	],
	laws: [
		keyLaw(laws.mapKeyPrimary, "MapKey", ["mapping", "text"]),
		keyLaw(laws.typedKey, "MapKey", ["mapping", "value", "negative"]),
		keyLaw(laws.usePrimary, "Use", ["id"]),
		{
			kind: "contained",
			law: laws.useRef,
			source: {
				relation: "Use",
				fields: ["mapping", "value", "negative"],
				selection: { kind: "every" }
			},
			target: {
				relation: "MapKey",
				fields: ["mapping", "value", "negative"],
				selection: { kind: "every" }
			}
		},
		keyLaw(laws.tagPrimary, "Tag", ["id"]),
		{
			kind: "key",
			law: laws.positiveTag,
			relation: "Tag",
			fields: ["value"],
			selection: {
				kind: "where",
				holds: (fact) => typeof fact["value"] === "number" && fact["value"] > 0,
				pinned: { value: 1 }
			}
		},
		keyLaw(laws.mappingPrimary, "Mapping", ["id"]),
		keyLaw(laws.entryPrimary, "Entry", ["mapping", "text"]),
		keyLaw(laws.entryKey, "Entry", ["mapping", "value", "negative"])
	]
})

/** The stored state as the model holds it. */
const storedState = (s: Stored): HostState =>
	new Map([
		["MapKey", Arr.map(s.mapKeys, mapKeyFact)],
		["Use", Arr.map(s.uses, useFact)],
		["Tag", Arr.map(s.tags, tagFact)],
		["Mapping", Arr.map(s.mappings, (m) => mappingFacts(m).mapping)],
		["Entry", Arr.flatMap(s.mappings, (m) => mappingFacts(m).entries)]
	])

/**
 * A stratum's appends as the model's ops: its puts of Entry are one array member, a set of rows. A row at a key its
 * mapping stores repeats that entry exactly, which changes nothing; each mapping takes its other rows at the slots after
 * its stored entries in key order (write/family/additions.ts), and is put with its new count.
 */
const appendedOps = (stored: Stored, writes: ReadonlyArray<Write>): ReadonlyArray<HostOp> => {
	const rows = Arr.flatMap(writes, (w) => (w.relation === "Entry" ? w.rows : []))
	const groups = Arr.flatMap(Arr.dedupe(Arr.map(rows, (r) => r.mapping)), (id) => {
		const held = defined(
			Option.getOrUndefined(Arr.findFirst(stored.mappings, (m) => m.id === id)),
			`the stored mapping ${String(id)} an append names`
		).entries
		const texts = Arr.sort(
			Arr.dedupe(
				Arr.map(
					Arr.filter(rows, (r) => r.mapping === id && !held.includes(r.text)),
					(r) => r.text
				)
			),
			Order.String
		)
		return Arr.isReadonlyArrayNonEmpty(texts) ? [{ id, held: held.length, texts }] : []
	})
	return Arr.isReadonlyArrayNonEmpty(groups)
		? [
				{
					relation: "Entry",
					kind: "put",
					facts: Arr.flatMap(groups, (g) =>
						Arr.map(g.texts, (text, i) => ({
							mapping: g.id,
							at: g.held + i,
							text,
							value: valueOf(text),
							negative: negativeOf(text)
						}))
					)
				},
				{
					relation: "Mapping",
					kind: "put",
					facts: Arr.map(groups, (g) => ({ id: g.id, n: g.held + g.texts.length }))
				}
			]
		: []
}

/** A case's writes as the model's ops: a mapping's insert adds its entries too, and the stratum's appends are joined
 * (appendedOps). */
const opsOf = (stored: Stored, writes: ReadonlyArray<Write>): ReadonlyArray<HostOp> => [
	...Arr.flatMap(writes, (w): ReadonlyArray<HostOp> => {
		switch (w.relation) {
			case "MapKey":
				return [{ relation: "MapKey", kind: w.edit, facts: Arr.map(w.rows, mapKeyFact) }]
			case "Tag":
				return [{ relation: "Tag", kind: w.edit, facts: Arr.map(w.rows, tagFact) }]
			case "Use":
				return [{ relation: "Use", kind: "insert", facts: Arr.map(w.rows, useFact) }]
			case "Mapping":
				return [
					{
						relation: "Mapping",
						kind: "insert",
						facts: Arr.map(w.rows, (m) => mappingFacts(m).mapping)
					},
					{
						relation: "Entry",
						kind: "insert",
						facts: Arr.flatMap(w.rows, (m) => mappingFacts(m).entries)
					}
				]
			case "Entry":
				return []
		}
	}),
	...appendedOps(stored, writes)
]

/** Whether one delete of the stratum `ops` states two distinct facts at its relation's primary key. */
const deletedTwice = (host: HostSchema, ops: ReadonlyArray<HostOp>): boolean =>
	Arr.some(ops, (o) => {
		if (o.kind !== "delete") {
			return false
		}
		const r = defined(
			Option.getOrUndefined(Arr.findFirst(host.relations, (x) => x.name === o.relation)),
			`the relation ${o.relation} a delete names`
		)
		const facts = Arr.dedupeWith(o.facts, (a: HostFact, b: HostFact) => sameFact(r.fields, a, b))
		return Arr.some(facts, (f, i) =>
			Arr.some(
				facts,
				(g, j) =>
					i !== j && Arr.every(r.key, (k) => valueText(f[k] ?? "") === valueText(g[k] ?? ""))
			)
		)
	})

/** Whether two facts hold one value at every field. */
const sameFact = (
	fields: ReadonlyArray<{ readonly name: string }>,
	a: HostFact,
	b: HostFact
): boolean => Arr.every(fields, (f) => valueText(a[f.name] ?? "") === valueText(b[f.name] ?? ""))

/** What the model says of a case: refused with the violations a refusal may name, or the state after it. */
type Expected =
	| { readonly kind: "refused"; readonly violations: Arr.NonEmptyReadonlyArray<Violation> }
	| { readonly kind: "applied"; readonly state: HostState; readonly changed: boolean }

const expectedOf = (host: HostSchema, before: HostState, ops: ReadonlyArray<HostOp>): Expected => {
	const after = transition(host, before, ops)
	const refused = refusedBy(violations(host, after))
	return Arr.isReadonlyArrayNonEmpty(refused)
		? { kind: "refused", violations: refused }
		: { kind: "applied", state: after, changed: !sameState(host, before, after) }
}

/** A lawful stored state: each drawn row kept where the rows kept before it leave every law holding. */
const storedGen =
	(host: HostSchema): Gen<Stored> =>
	(source) => {
		const mapKeys = source.draw(array(mapKeyGen, { min: 0, max: 3 }))
		const tags = source.draw(array(tagGen, { min: 0, max: 3 }))
		const mappingTexts = source.draw(array(array(textGen, { min: 1, max: 3 }), { min: 0, max: 1 }))
		let kept: Stored = { mapKeys: [], uses: [], tags: [], mappings: [] }
		const lawful = (s: Stored): boolean => violations(host, storedState(s)).length === 0
		for (const r of mapKeys) {
			const next: Stored = { ...kept, mapKeys: [...kept.mapKeys, r] }
			kept = lawful(next) ? next : kept
		}
		for (const r of tags) {
			const next: Stored = { ...kept, tags: [...kept.tags, r] }
			kept = lawful(next) ? next : kept
		}
		for (const [i, texts] of mappingTexts.entries()) {
			const [first, ...rest] = texts
			if (first !== undefined) {
				const next: Stored = {
					...kept,
					mappings: [...kept.mappings, { id: i + 1, entries: [first, ...rest] }]
				}
				kept = lawful(next) ? next : kept
			}
		}
		const named = source.draw(array(int(0, 3), { min: 0, max: 2 }))
		for (const [i, at] of named.entries()) {
			const target = kept.mapKeys[at]
			if (target !== undefined) {
				const next: Stored = {
					...kept,
					uses: [
						...kept.uses,
						{
							id: i + 1,
							mapping: target.mapping,
							value: valueOf(target.text),
							negative: negativeOf(target.text)
						}
					]
				}
				kept = lawful(next) ? next : kept
			}
		}
		return kept
	}

/** A row near the stored ones: a stored row itself, another spelling of its typed key, or a fresh one. */
const nearGen = <A>(
	stored: ReadonlyArray<A>,
	fresh: Gen<A>,
	respelled: (a: A, text: KeyTextValue) => A
): Gen<A> =>
	Arr.isReadonlyArrayNonEmpty(stored)
		? oneOf([
				fresh,
				element(stored),
				(source) => respelled(source.draw(element(stored)), source.draw(textGen))
			])
		: fresh

const editGen: Gen<Edit> = element(["insert", "put", "delete"] as const)
const sourceGen = (edit: Edit): Gen<Source> =>
	edit === "delete" ? element(["array"] as const) : element(["array", "query"] as const)

const writeGen =
	(stored: Stored, fresh: number): Gen<Write> =>
	(source) => {
		const target = source.draw(
			weighted([
				[2, constant("MapKey" as const)],
				[2, constant("Tag" as const)],
				[1, constant("Use" as const)],
				[1, constant("Mapping" as const)]
			])
		)
		switch (target) {
			case "MapKey": {
				const edit = source.draw(editGen)
				const row = nearGen(stored.mapKeys, mapKeyGen, (r, text) => ({ ...r, text }))
				const [first, ...rest] = source.draw(array(row, { min: 1, max: 3 }))
				return {
					relation: "MapKey",
					edit,
					source: source.draw(sourceGen(edit)),
					rows: [first ?? source.draw(mapKeyGen), ...rest]
				}
			}
			case "Tag": {
				const edit = source.draw(editGen)
				const row = nearGen(stored.tags, tagGen, (r, text) => ({ ...r, text }))
				const [first, ...rest] = source.draw(array(row, { min: 1, max: 3 }))
				return {
					relation: "Tag",
					edit,
					source: source.draw(sourceGen(edit)),
					rows: [first ?? source.draw(tagGen), ...rest]
				}
			}
			case "Use": {
				const use: Gen<UseRow> = (s) => {
					const named = s.draw(mapKeyGen)
					return {
						id: s.draw(int(1, 3)),
						mapping: named.mapping,
						value: valueOf(named.text),
						negative: negativeOf(named.text)
					}
				}
				return { relation: "Use", rows: [source.draw(use)] }
			}
			case "Mapping": {
				const texts = source.draw(array(textGen, { min: 1, max: 3 }))
				const [first, ...rest] = texts
				return {
					relation: "Mapping",
					rows: [{ id: fresh, entries: [first ?? source.draw(textGen), ...rest] }]
				}
			}
		}
	}

/** Entries appended to the stored mappings, each near their entries: one of them, another spelling of its typed key,
 * or a fresh text. */
const appendGen =
	(mappings: Arr.NonEmptyReadonlyArray<MappingRow>): Gen<Write> =>
	(source) => {
		const fresh: Gen<EntryRow> = (s) => ({
			mapping: s.draw(element(mappings)).id,
			text: s.draw(textGen)
		})
		const row = nearGen(
			Arr.flatMap(mappings, (m) => Arr.map(m.entries, (text) => ({ mapping: m.id, text }))),
			fresh,
			(r, text) => ({ ...r, text })
		)
		const [first, ...rest] = source.draw(array(row, { min: 1, max: 3 }))
		return { relation: "Entry", rows: [first ?? source.draw(fresh), ...rest] }
	}

/** A write of a case's stratum: one `writeGen` draws, or, where a mapping is stored, a draw in seven, an append to it. */
const stratumWriteGen = (stored: Stored, fresh: number): Gen<Write> =>
	Arr.isReadonlyArrayNonEmpty(stored.mappings)
		? weighted([
				[6, writeGen(stored, fresh)],
				[1, appendGen(stored.mappings)]
			])
		: writeGen(stored, fresh)

const caseGen =
	(host: HostSchema): Gen<Case> =>
	(source) => {
		const stored = source.draw(storedGen(host))
		const count = source.draw(int(1, 3))
		const writes = nonEmpty(
			upTo(count, (i) => source.draw(stratumWriteGen(stored, 11 + i))),
			"a case writes one to three times"
		)
		return { stored, writes }
	}

/** Another spelling of a text's typed key: its value and sign, the other padding. */
const otherSpelling = (text: KeyTextValue): KeyTextValue => respelling[text]

/** A case of no stored rows writing one typed key in two spellings, from `sources` and by `edits`. */
const twiceSpelledGen =
	(
		sources: Arr.NonEmptyReadonlyArray<Source>,
		edits: Arr.NonEmptyReadonlyArray<"insert" | "put">
	): Gen<Case> =>
	(source) => {
		const row = source.draw(mapKeyGen)
		return {
			stored: { mapKeys: [], uses: [], tags: [], mappings: [] },
			writes: [
				{
					relation: "MapKey",
					edit: source.draw(element(edits)),
					source: source.draw(element(sources)),
					rows: [row, { ...row, text: otherSpelling(row.text) }]
				}
			]
		}
	}

/** A case storing one typed key and putting it in another spelling. */
const respelledPutGen: Gen<Case> = (source) => {
	const row = source.draw(mapKeyGen)
	return {
		stored: { mapKeys: [row], uses: [], tags: [], mappings: [] },
		writes: [
			{
				relation: "MapKey",
				edit: "put",
				source: source.draw(element(["array", "query"] as const)),
				rows: [{ ...row, text: otherSpelling(row.text) }]
			}
		]
	}
}

/** A case storing one typed key, deleting it and inserting it again in another spelling, in one stratum. */
const retakenGen: Gen<Case> = (source) => {
	const row = source.draw(mapKeyGen)
	return {
		stored: { mapKeys: [row], uses: [], tags: [], mappings: [] },
		writes: [
			{ relation: "MapKey", edit: "delete", source: "array", rows: [row] },
			{
				relation: "MapKey",
				edit: "insert",
				source: source.draw(element(["array", "query"] as const)),
				rows: [{ ...row, text: otherSpelling(row.text) }]
			}
		]
	}
}

/** Each text's typed key of the other sign: its value and padding, the other sign, so "0" and "-0" too. */
const negation: Readonly<Record<KeyTextValue, KeyTextValue>> = {
	"0": "-0",
	"-0": "0",
	"00": "-00",
	"-00": "00",
	"1": "-1",
	"-1": "1",
	"01": "-01",
	"-01": "01",
	"2": "-2",
	"-2": "2",
	"02": "-02",
	"-02": "02"
}

/** A case storing one mapping of the entry `stored` and appending the entry `appended` to it, by a put of Entry. */
const appendCase = (stored: KeyTextValue, appended: KeyTextValue): Case => ({
	stored: { mapKeys: [], uses: [], tags: [], mappings: [{ id: 1, entries: [stored] }] },
	writes: [{ relation: "Entry", rows: [{ mapping: 1, text: appended }] }]
})

/** A case appending to a stored entry spelled with a minus its typed key in its other spelling: refused on the entry key
 * against the stored entry. */
const appendedTwiceGen: Gen<Case> = (source) => {
	const text = source.draw(element(["-0", "-00", "-1", "-01", "-2", "-02"] as const))
	return appendCase(text, otherSpelling(text))
}

/** A case appending to a stored entry the typed key of its other sign, which no entry holds: accepted. */
const appendedGen: Gen<Case> = (source) => {
	const text = source.draw(textGen)
	return appendCase(text, negation[text])
}

/** A case storing one tag of a positive value and writing a tag of that value at another id: refused on the positive
 * tag key. */
const positiveTwiceGen: Gen<Case> = (source) => {
	const text = source.draw(element(["1", "01", "2", "02"] as const))
	return {
		stored: { mapKeys: [], uses: [], tags: [{ id: 1, text }], mappings: [] },
		writes: [
			{
				relation: "Tag",
				edit: source.draw(element(["insert", "put"] as const)),
				source: source.draw(element(["array", "query"] as const)),
				rows: [{ id: 2, text: source.draw(element([text, otherSpelling(text)])) }]
			}
		]
	}
}

/** A case storing a typed key of zero and writing zero of the other sign in its mapping: accepted, both stored. */
const signedZerosGen: Gen<Case> = (source) => {
	const row = {
		mapping: source.draw(int(1, 2)),
		text: source.draw(element(["0", "00", "-0", "-00"] as const))
	}
	return {
		stored: { mapKeys: [row], uses: [], tags: [], mappings: [] },
		writes: [
			{
				relation: "MapKey",
				edit: source.draw(element(["insert", "put"] as const)),
				source: source.draw(element(["array", "query"] as const)),
				rows: [{ ...row, text: negation[row.text] }]
			}
		]
	}
}

/** A case storing one tag and deleting it beside another tag at its id, in one member: no refusal, the stored tag
 * deleted. */
const deletedTwiceGen: Gen<Case> = (source) => {
	const stored = source.draw(tagGen)
	return {
		stored: { mapKeys: [], uses: [], tags: [stored], mappings: [] },
		writes: [
			{
				relation: "Tag",
				edit: "delete",
				source: "array",
				rows: [stored, { ...stored, text: otherSpelling(stored.text) }]
			}
		]
	}
}

export type Feature =
	| "typed key refused against a stored row"
	| "typed key refused within the write"
	| "typed key refused for a query's row"
	| "typed key refused for a put"
	| "positive tag refused"
	| "entry key refused within the write"
	| "entry key refused against a stored entry spelled with a minus"
	| "an entry appended to a stored mapping"
	| "a reference refused"
	| "two signs of zero held apart"
	| "a typed key freed and taken again"
	| "two deletions at one key"
	| "accepted"
	| "unchanged"

/** The situations a drawn case reaches rarely, each with a case aimed at it: a witness whose turn aims at one draws
 * that case (aimed), the case it runs, prints and keeps. */
const aims: ReadonlyArray<readonly [Feature, Gen<Case>]> = [
	["typed key refused within the write", twiceSpelledGen(["array", "query"], ["insert", "put"])],
	["typed key refused for a query's row", twiceSpelledGen(["query"], ["insert", "put"])],
	["typed key refused for a put", respelledPutGen],
	["a typed key freed and taken again", retakenGen],
	["two deletions at one key", deletedTwiceGen],
	["positive tag refused", positiveTwiceGen],
	["two signs of zero held apart", signedZerosGen],
	["entry key refused against a stored entry spelled with a minus", appendedTwiceGen],
	["an entry appended to a stored mapping", appendedGen]
]

/** Whether a violation names an entry of a mapping the case does not store, nested under a new mapping, which meets the
 * entry key at its index alone. */
const nestedClash = (c: Case, v: Violation): boolean =>
	Arr.some(
		v.violators,
		(x) =>
			!Arr.some(c.stored.mappings, (m) => valueText(m.id) === valueText(x.values["mapping"] ?? ""))
	)

/** The notes a refused case's violations reach. */
const refusalNotes = (
	c: Case,
	laws: KeysLaws,
	before: HostState,
	refused: ReadonlyArray<Violation>
): ReadonlyArray<Feature> =>
	Arr.flatMap(refused, (v): ReadonlyArray<Feature> => {
		if (v.law === laws.typedKey) {
			const stored = Arr.some(v.violators, (x) =>
				Arr.some(before.get("MapKey") ?? [], (f) =>
					Arr.every(
						["mapping", "value", "negative"],
						(k) => valueText(f[k] ?? "") === valueText(x.values[k] ?? "")
					)
				)
			)
			const writes = Arr.filter(c.writes, (w) => w.relation === "MapKey")
			return [
				stored ? "typed key refused against a stored row" : "typed key refused within the write",
				...(Arr.some(writes, (w) => w.source === "query")
					? (["typed key refused for a query's row"] as const)
					: []),
				...(Arr.some(writes, (w) => w.edit === "put")
					? (["typed key refused for a put"] as const)
					: [])
			]
		}
		if (v.law === laws.entryKey) {
			const met = Arr.filter(before.get("Entry") ?? [], (f) =>
				Arr.some(v.violators, (x) =>
					Arr.every(
						["mapping", "value", "negative"],
						(k) => valueText(f[k] ?? "") === valueText(x.values[k] ?? "")
					)
				)
			)
			return Arr.isReadonlyArrayNonEmpty(met)
				? Arr.some(met, (f) => f["negative"] === true)
					? ["entry key refused against a stored entry spelled with a minus"]
					: []
				: ["entry key refused within the write"]
		}
		return v.law === laws.positiveTag
			? ["positive tag refused"]
			: v.law === laws.useRef
				? ["a reference refused"]
				: []
	})

/** The notes an applied case's state reaches. */
const appliedNotes = (c: Case, after: HostState, changed: boolean): ReadonlyArray<Feature> => {
	const keys = after.get("MapKey") ?? []
	const signs = Arr.some(keys, (a) =>
		Arr.some(
			keys,
			(b) =>
				a["mapping"] === b["mapping"] &&
				a["value"] === 0 &&
				b["value"] === 0 &&
				a["negative"] !== b["negative"]
		)
	)
	const deleted = Arr.flatMap(c.writes, (w) =>
		w.relation === "MapKey" && w.edit === "delete" ? Arr.map(w.rows, mapKeyFact) : []
	)
	const retaken = Arr.some(deleted, (d) =>
		Arr.some(
			keys,
			(k) =>
				k["mapping"] === d["mapping"] &&
				k["value"] === d["value"] &&
				k["negative"] === d["negative"] &&
				k["text"] !== d["text"]
		)
	)
	return [
		changed ? "accepted" : "unchanged",
		...(signs ? (["two signs of zero held apart"] as const) : []),
		...(retaken ? (["a typed key freed and taken again"] as const) : []),
		...(Arr.some(c.writes, (w) => w.relation === "Entry")
			? (["an entry appended to a stored mapping"] as const)
			: [])
	]
}

/** A state's rows as grizzle reads them back, each relation's rows as their values' texts in heading order. */
type ReadRows = ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>

/** The installation of Keys with its full world's workload (programs). */
const keysInstall = { label: "genkey", programs } as const

/**
 * Keys installed once per member as a read fixture (reads/support.ts fixtureTemplate), where its search installed it
 * before its cases; each case takes a clone of its own.
 */
export const keysTemplate = fixtureTemplate(import.meta, Keys, keysInstall)

/** Keys' laws, as `names` names them. */
const lawsOf = (names: LawNames): KeysLaws => ({
	mapKeyPrimary: names.primaryKeyLaw(MapKey),
	typedKey: names.lawOf(typedKey),
	usePrimary: names.primaryKeyLaw(Use),
	useRef: names.lawOf(useRef),
	tagPrimary: names.primaryKeyLaw(Tag),
	positiveTag: names.lawOf(positiveTag),
	mappingPrimary: names.primaryKeyLaw(Mapping),
	entryPrimary: names.primaryKeyLaw(Entry),
	entryKey: names.lawOf(entryKey)
})

/**
 * The cases a write over Keys draws, each lawful stored state and its writes over the host model of Keys' laws as its
 * law model names them (kernel/naming.ts lawNamesOf), which no installation's name moves, aimed at what the drawn cases
 * seldom reach (aims).
 */
export const keyCases = aimed(caseGen(hostOf(lawsOf(lawNamesOf(Keys)))), aims)

/**
 * A write case over the case's clone of Keys (`taken`): the case's stored state written, its writes applied through
 * the served Db it opens, and the rows and outcome held to the law model's.
 */
export const keysCase = (taken: SubstrateCase<Generated>, k: Case, c: PropertyCase<Feature>) =>
	Effect.gen(function* () {
		const o = yield* openedIn(Keys, {}, keysInstall, taken)
		const names = namesOf(o.installed)
		const laws = lawsOf(names)
		const host = hostOf(laws)
		const { serve } = yield* openServedDb(o.installed, o.server.roles.app, {})
		return yield* Effect.gen(function* () {
			const db = yield* Db.open(o.served.login.roles.app, {})
			const S = o.schema
			const texts = (row: ReadonlyArray<unknown>): ReadonlyArray<string> =>
				Arr.map(row, (x) => String(x))
			const readState = Effect.gen(function* () {
				const mapKeys = yield* rowsOf(db.workload.mapKeys.once({ params: {}, facts: {} }))
				const uses = yield* rowsOf(db.workload.uses.once({ params: {}, facts: {} }))
				const tags = yield* rowsOf(db.workload.tags.once({ params: {}, facts: {} }))
				const mappings = yield* rowsOf(db.workload.mappings.once({ params: {}, facts: {} }))
				const entryRows = yield* rowsOf(db.workload.entries.once({ params: {}, facts: {} }))
				const rows: ReadRows = Arr.map(
					[
						Arr.map(mapKeys, (k) => texts([k.mapping, k.text, k.value, k.negative])),
						Arr.map(uses, (u) => texts([u.id, u.mapping, u.value, u.negative])),
						Arr.map(tags, (t) => texts([t.id, t.text, t.value])),
						Arr.map(mappings, (m) => texts([m.id, m.n])),
						Arr.map(entryRows, (e) => texts([e.mapping, e.at, e.text, e.value, e.negative]))
					],
					(relationRows) => Arr.sort(relationRows, Arr.makeOrder(Order.String))
				)
				return rows
			})
			/** The rows of a query over a relation parameter: a write's source the write cannot prove unique. */
			const mapKeySource = (name: string) =>
				query(S).rule((r) => {
					const rows = r.relation(name, { mapping: pg.integer, text: KeyText })
					const row = v(rows, "row")
					return r.match(rows, row).find(row)
				})
			const tagSource = (name: string) =>
				query(S).rule((r) => {
					const rows = r.relation(name, { id: pg.integer, text: KeyText })
					const row = v(rows, "row")
					return r.match(rows, row).find(row)
				})
			/** One write as a member of the case's stratum, its ChangeSet typed. */
			const writeOf = (w: Write, i: number): Written => {
				const name = `rows${String(i)}`
				switch (w.relation) {
					case "MapKey":
						return w.source === "query"
							? {
									kind: "query",
									changes:
										w.edit === "insert"
											? ChangeSet.empty(S).insert(MapKey, mapKeySource(name))
											: ChangeSet.empty(S).put(MapKey, mapKeySource(name)),
									params: { [name]: w.rows }
								}
							: {
									kind: "array",
									op: w.edit,
									relation: w.relation,
									changes:
										w.edit === "insert"
											? ChangeSet.empty(S).insert(MapKey, [])
											: w.edit === "put"
												? ChangeSet.empty(S).put(MapKey, [])
												: ChangeSet.empty(S).delete(MapKey, []),
									rows: w.rows
								}
					case "Tag":
						return w.source === "query"
							? {
									kind: "query",
									changes:
										w.edit === "insert"
											? ChangeSet.empty(S).insert(Tag, tagSource(name))
											: ChangeSet.empty(S).put(Tag, tagSource(name)),
									params: { [name]: w.rows }
								}
							: {
									kind: "array",
									op: w.edit,
									relation: w.relation,
									changes:
										w.edit === "insert"
											? ChangeSet.empty(S).insert(Tag, [])
											: w.edit === "put"
												? ChangeSet.empty(S).put(Tag, [])
												: ChangeSet.empty(S).delete(Tag, []),
									rows: w.rows
								}
					case "Use":
						return {
							kind: "array",
							op: "insert",
							relation: w.relation,
							changes: ChangeSet.empty(S).insert(Use, []),
							rows: w.rows
						}
					case "Mapping":
						return {
							kind: "array",
							op: "insert",
							relation: w.relation,
							changes: ChangeSet.empty(S).insert(Mapping, []),
							rows: Arr.map(w.rows, (m) => ({
								id: m.id,
								n: Arr.map(m.entries, (text) => ({ text }))
							}))
						}
					case "Entry":
						return {
							kind: "array",
							op: "put",
							relation: w.relation,
							changes: ChangeSet.empty(S).put(Entry, []),
							rows: w.rows
						}
				}
			}
			/**
			 * The case's writes as one stratum, its members in the writes' order: each query write's ChangeSet;
			 * one array member per op and relation the array writes hold, as a served call supplies one array
			 * under each op and relation, at the first write of it, its facts every such write's rows in order;
			 * and every parameter the queries bind.
			 */
			const stratumOf = (writes: Arr.NonEmptyReadonlyArray<Write>) => {
				const written = Arr.map(writes, writeOf)
				const arrays = Arr.flatMap(written, (w): ReadonlyArray<ArrayWritten> =>
					w.kind === "array" ? [w] : []
				)
				const slots = Arr.dedupeWith(arrays, (a, b) => a.op === b.op && a.relation === b.relation)
				const members = Arr.filter(
					written,
					(w, i) =>
						w.kind === "query" ||
						!Arr.some(
							Arr.take(written, i),
							(x) => x.kind === "array" && x.op === w.op && x.relation === w.relation
						)
				)
				const changes = Arr.reduce(members, changeSetOver.empty(S), (joined, w) =>
					changeSetOver.union(joined, w.changes)
				)
				const rowsOf = (op: Edit, relation: Write["relation"]): ReadonlyArray<unknown> =>
					Arr.flatMap(
						Arr.filter(arrays, (w) => w.op === op && w.relation === relation),
						(w: ArrayWritten) => w.rows
					)
				const facts = Rec.fromEntries(
					Arr.map(
						Arr.dedupe(Arr.map(slots, (s) => s.op)),
						(op): readonly [Edit, Readonly<Record<string, ReadonlyArray<unknown>>>] => [
							op,
							Rec.fromEntries(
								Arr.map(
									Arr.filter(slots, (s) => s.op === op),
									(s): readonly [string, ReadonlyArray<unknown>] => [
										s.relation,
										rowsOf(op, s.relation)
									]
								)
							)
						]
					)
				)
				const params: ParamMap = Rec.fromEntries(
					Arr.flatMap(written, (w) => (w.kind === "query" ? Rec.toEntries(w.params) : []))
				)
				return { changes, facts, params }
			}
			const seeded = yield* writeAnswerOf(
				db.workload.seed.once({
					params: {},
					facts: {
						insert: {
							MapKey: k.stored.mapKeys,
							Use: k.stored.uses,
							Tag: k.stored.tags,
							Mapping: Arr.map(k.stored.mappings, (m) => ({
								id: m.id,
								n: Arr.map(m.entries, (text) => ({ text }))
							}))
						}
					}
				})
			)
			const none =
				k.stored.mapKeys.length +
					k.stored.uses.length +
					k.stored.tags.length +
					k.stored.mappings.length ===
				0
			assert.equal(seeded.kind, none ? "unchanged" : "accepted", "the stored rows are lawful")
			const before = storedState(k.stored)
			const beforeRows = yield* readState
			assert.deepEqual(beforeRows, sortedStateRows(host, before), "the stored rows are the model's")
			const stratum = stratumOf(k.writes)
			const served = yield* serve({ stratum: stratum.changes })
			const applied = yield* Effect.result(
				writeAnswerOf(
					writeOnce(member(served, "stratum"))({
						params: stratum.params,
						facts: stratum.facts
					})
				)
			)
			if (Result.isFailure(applied)) {
				return assert.fail(
					`a write over keys of generated fields is an outcome: ${applied.failure.kind}: ${applied.failure.message}`
				)
			}
			const outcome = applied.success
			const afterRows = yield* readState
			const ops = opsOf(k.stored, k.writes)
			const expected = expectedOf(host, before, ops)
			if (deletedTwice(host, ops)) {
				c.note("two deletions at one key")
			}
			if (expected.kind === "refused") {
				if (outcome.kind !== "refused") {
					return assert.fail(
						`a write breaking ${Arr.join(
							Arr.map(expected.violations, (v) => v.law),
							", "
						)} is refused, not ${outcome.kind}`
					)
				}
				assert.deepEqual(afterRows, beforeRows, "a refused write changes nothing")
				const named = Arr.map(refusedEntries(outcome.refused), names.reported)
				const [first] = named
				const met = Arr.findFirst(expected.violations, (v) => v.law === first)
				if (Option.isNone(met)) {
					return assert.fail(
						`the refusal names ${Arr.join(named, ", ")}, a law the write breaks: ${Arr.join(
							Arr.map(expected.violations, (v) => v.law),
							", "
						)}`
					)
				}
				const witness = outcome.witness
				if (witness.kind !== "key") {
					assert.ok(
						met.value.violators.length === 0 ||
							(met.value.law === laws.entryKey && nestedClash(k, met.value)),
						`a refusal by ${met.value.law}, whose violators the write names, reports its key`
					)
				} else {
					const named = [...met.value.violators, ...met.value.unmatched]
					assert.ok(
						Arr.some(
							named,
							(x) => x.relation === witness.relation && sameValues(witness.values, x.values)
						),
						`the witness ${Formatter.format(witness)} names a fact breaking ${met.value.law} by its key, one of ${Formatter.format(named)}`
					)
				}
				for (const note of refusalNotes(k, laws, before, [met.value])) {
					c.note(note)
				}
				return
			}
			assert.equal(
				outcome.kind,
				expected.changed ? "accepted" : "unchanged",
				"accepted where the write changed a row"
			)
			assert.deepEqual(
				afterRows,
				sortedStateRows(host, expected.state),
				"the rows after the write are the model's"
			)
			for (const note of appliedNotes(k, expected.state, expected.changed)) {
				c.note(note)
			}
		}).pipe(Effect.scoped, withLayer(o.served.layer))
	})
