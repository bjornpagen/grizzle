import { layer } from "@effect/vitest"
import { type Case as ExploreCase, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
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
/**
 * Keys over generated fields, against PostgreSQL 19.
 *
 * README, "How a field is written": a key other than the primary key may hold a generated field. PostgreSQL computes
 * the field, and the statement that writes a row compares it there, at its term over the row's written fields, against
 * every other row it writes and every stored row: a write that would store two rows of one value at the key is
 * `invariant-rejected` on the key, its witness the key's values as PostgreSQL stores them; a deletion compares only at
 * keys whose fields it states; a family's member rows meet such a key at its index, refused on the key with an
 * `unreported` witness.
 *
 * Keys holds a typed map key, MapKey (mapping, text), primary key both, whose `value` and `negative` PostgreSQL generates
 * from its text, the integer it spells and whether it is spelled with a minus, keyed by (mapping, value, negative): two
 * spellings of one value in one mapping, "1" and "01", are one key, and "0" and "-0" are two. Use names a typed key by a
 * containment into it. Tag (id, text), mutable, keeps at most one tag of each positive value, a key over a selected
 * side whose term and selection read its generated `value`. Mapping owns an ordered family of Entry rows, each a typed
 * key of its own, keyed by (mapping, value, negative), written nested under a new mapping.
 *
 * Each case stores a lawful state, then applies one stratum of up to three writes: inserts, puts and deletes of MapKey
 * and Tag from an array or a query over a relation parameter, inserts of Use, and inserts of new mappings with their
 * entries nested. The stratum is the one member of a served workload of its own, its array writes of one op and one
 * relation one array member whose call's facts are their rows. Texts are drawn from three values, both signs and two paddings, so writes meet stored rows and each
 * other at every key.
 *
 * The oracle is the law model (test/support/laws/model.ts): the add-wins transition of the stratum over the stored
 * state, its facts' generated values computed from their texts apart from grizzle, and every law's violation over the
 * result, a key's naming its violators by the key's own fields; a deletion's same-key check, restated, compares only at
 * a key of written fields, and a key both it and the result break is one violation, named by either's facts (model.ts
 * refusedBy). A refused write names a violated law, every immediate one before a deferred one, with a witness naming
 * one of its violators, or `unreported` for a containment and for the nested entries' key, and changes nothing; any
 * other write stores exactly the model's state, accepted where it changed a row and no-change otherwise.
 *
 * Through a role (README, "Writing through a role"): Label (id, text), its `value` generated from its text, at most one
 * label of each value, written through Low, the labels below id 5, by an insert or a put of one label beside stored
 * labels inside Low and outside it, its text drawn in the pattern or, a draw in eight, outside it. The oracle is the
 * write restated: outside Low it is outside the world, or the pattern's law where its text breaks that, which the
 * README leaves unpromised; a text outside the pattern is the pattern's law; a stored label at its id the write does
 * not displace is the primary key's, and one of its value at another id, inside Low or outside it, the value key's, the
 * witness the key written in Low's fields, its generated value as PostgreSQL stores it.
 *
 * The planted bug, in a scratch copy only: the statement computing a requested fact's generated key field from another
 * term than its column's (write/insert/unique.ts `buildProbe`) fails the search, at a stored clash it misses or a clash
 * it invents.
 */
import { Db } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { drawn as drawnField, generated, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	fin,
	key,
	login,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { clearRows, installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A key's text: a one-digit integer behind any leading zeros, its sign spelled or not, at most four bytes. */
const KeyText = str.bytes(4, str.regex("^-?0*[0-9]$", "u"))

/** A typed map key: the integer its text spells, and whether the text spells it with a minus. */
const MapKey = relation.generated(
	"MapKey",
	{ mapping: pg.integer, text: KeyText },
	["mapping", "text"],
	(r) => ({
		value: generated(pg.integer, Compute.cast(r.text, pg.integer)),
		negative: generated(pg.boolean, Compute.startsWith(r.text, "-"))
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
	value: generated(pg.integer, Compute.cast(r.text, pg.integer))
}))
const positiveTag = key(
	on(
		select(Tag, (t) => t.gt(t.value, 0)),
		"value"
	)
)

/** A mapping's entries, in order, each a typed key of its own. */
const Mapping = relation("Mapping", { id: pg.integer, n: drawnField(natural) }, ["id"])
const Entry = relation.generated(
	"Entry",
	{ mapping: pg.integer, at: drawnField(natural), text: KeyText },
	["mapping", "at"],
	(r) => ({
		value: generated(pg.integer, Compute.cast(r.text, pg.integer)),
		negative: generated(pg.boolean, Compute.startsWith(r.text, "-"))
	})
)
const entries = ordered(on(Entry, "mapping", "at"), fin(Mapping, "n"))
const entryKey = key(on(Entry, "mapping", "value", "negative"))

const Keys = schema("Keys", { MapKey, Use, Tag, Mapping, Entry }, [
	typedKey,
	useRef,
	positiveTag,
	entries,
	entryKey,
	mutable(Tag)
])

/**
 * The full world's workload: the stored state's insert, MapKey, Use, Tag and new mappings from each call's facts; and
 * each relation's rows as grizzle reads them, generated and drawn fields included.
 */
const programs = {
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
}

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

type Edit = "insert" | "put" | "delete"
type Source = "array" | "query"

/** One write of a case's stratum: an edit of MapKey or Tag from an array or a query, or an insert of Use or of new
 * mappings with their entries nested. */
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
		relationOf("MapKey", ["mapping", "text", "value", "negative"], ["mapping", "text"], false),
		relationOf("Use", ["id", "mapping", "value", "negative"], ["id"], false),
		relationOf("Tag", ["id", "text", "value"], ["id"], true),
		relationOf("Mapping", ["id", "n"], ["id"], false),
		relationOf("Entry", ["mapping", "at", "text", "value", "negative"], ["mapping", "at"], false)
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
		keyLaw(laws.entryPrimary, "Entry", ["mapping", "at"]),
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

/** A case's writes as the model's ops: a mapping's insert adds its entries too. */
const opsOf = (writes: ReadonlyArray<Write>): ReadonlyArray<HostOp> =>
	Arr.flatMap(writes, (w): ReadonlyArray<HostOp> => {
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
		}
	})

/**
 * Two facts one stratum deletes at one value of a key whose every field a deletion states, a primary key here: a key
 * names one fact, so such a deletion is refused before any SQL. A key over a generated field compares no deletion.
 */
const deletedAtOneKey = (host: HostSchema, ops: ReadonlyArray<HostOp>): ReadonlyArray<Violation> =>
	Arr.flatMap(host.relations, (r): ReadonlyArray<Violation> => {
		const law = Arr.findFirst(
			host.laws,
			(l) =>
				l.kind === "key" &&
				l.relation === r.name &&
				l.fields.length === r.key.length &&
				Arr.every(l.fields, (f, i) => r.key[i] === f)
		)
		if (Option.isNone(law)) {
			return []
		}
		const deleted = Arr.dedupeWith(
			Arr.flatMap(ops, (o) =>
				o.relation === r.name && o.kind === "delete" ? o.facts : Arr.empty<HostFact>()
			),
			(a: HostFact, b: HostFact) => sameFact(r.fields, a, b)
		)
		const bad = Arr.filter(deleted, (f, i) =>
			Arr.some(
				deleted,
				(g, j) =>
					i !== j && Arr.every(r.key, (k) => valueText(f[k] ?? "") === valueText(g[k] ?? ""))
			)
		)
		return Arr.isReadonlyArrayNonEmpty(bad)
			? [
					{
						law: law.value.law,
						immediate: true,
						violators: Arr.map(bad, (f) => ({
							relation: r.name,
							values: Rec.fromEntries(Arr.map(r.key, (k) => [k, f[k] ?? ""] as const))
						}))
					}
				]
			: []
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
	const refused = refusedBy(deletedAtOneKey(host, ops), violations(host, after))
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
			element(["MapKey", "MapKey", "Tag", "Tag", "Use", "Mapping"] as const)
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

const caseGen =
	(host: HostSchema): Gen<Case> =>
	(source) => {
		const stored = source.draw(storedGen(host))
		const count = source.draw(int(1, 3))
		const writes = Arr.map(Arr.range(1, count), (i) => source.draw(writeGen(stored, 10 + i)))
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

/** A text whose value is not positive, so no tag of it is held by Tag's positive key. */
const nonPositiveGen: Gen<KeyTextValue> = (source) => {
	const pad = source.draw(element(["", "0"] as const))
	const digit = source.draw(element(["0", "1", "2"] as const))
	return `-${pad}${digit}`
}

/** A case storing one tag, deleting it beside another tag at its id, and inserting two tags at one id, of values Tag's
 * positive key holds none of: Tag's primary key broken by its deletions and by its additions alike. */
const brokenTwiceGen: Gen<Case> = (source) => {
	const stored = source.draw(tagGen)
	const id = source.draw(int(1, 3))
	const text = source.draw(nonPositiveGen)
	return {
		stored: { mapKeys: [], uses: [], tags: [stored], mappings: [] },
		writes: [
			{
				relation: "Tag",
				edit: "delete",
				source: "array",
				rows: [stored, { ...stored, text: otherSpelling(stored.text) }]
			},
			{
				relation: "Tag",
				edit: "insert",
				source: "array",
				rows: [
					{ id, text },
					{ id, text: otherSpelling(text) }
				]
			}
		]
	}
}

type Feature =
	| "typed key refused against a stored row"
	| "typed key refused within the write"
	| "typed key refused for a query's row"
	| "typed key refused for a put"
	| "positive tag refused"
	| "entry key refused"
	| "a reference refused"
	| "two signs of zero held apart"
	| "a typed key freed and taken again"
	| "a key broken by deletions and additions alike"
	| "accepted"
	| "no-change"

/** The situations a drawn case reaches rarely, each with a case aimed at it. */
const aims: ReadonlyArray<readonly [Feature, Gen<Case>]> = [
	["typed key refused within the write", twiceSpelledGen(["array", "query"], ["insert", "put"])],
	["typed key refused for a query's row", twiceSpelledGen(["query"], ["insert", "put"])],
	["typed key refused for a put", respelledPutGen],
	["a typed key freed and taken again", retakenGen],
	["a key broken by deletions and additions alike", brokenTwiceGen]
]

/** The case a witness runs: its drawn one, or, while a situation `aims` reaches is pending, an aimed one. */
const aimedCase = (drawnCase: Case, c: ExploreCase<Feature>): Case => {
	const pending = Option.getOrUndefined(c.steering)
	const aim = Arr.findFirst(aims, ([situation]) => pending?.has(situation) === true)
	return Option.isNone(aim) ? drawnCase : c.draw(aim.value[1])
}

/** Whether two facts a case deletes at one key and two its result holds break one law. */
const brokenTwice = (host: HostSchema, before: HostState, c: Case, law: LawId): boolean => {
	const ops = opsOf(c.writes)
	return (
		Arr.some(deletedAtOneKey(host, ops), (d) => d.law === law) &&
		Arr.some(violations(host, transition(host, before, ops)), (a) => a.law === law)
	)
}

/** The notes a refused case's violations reach. */
const refusalNotes = (
	c: Case,
	laws: KeysLaws,
	host: HostSchema,
	before: HostState,
	refused: ReadonlyArray<Violation>
): ReadonlyArray<Feature> =>
	Arr.flatMap(refused, (v): ReadonlyArray<Feature> => {
		if (brokenTwice(host, before, c, v.law)) {
			return ["a key broken by deletions and additions alike"]
		}
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
		return v.law === laws.positiveTag
			? ["positive tag refused"]
			: v.law === laws.entryKey
				? ["entry key refused"]
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
		changed ? "accepted" : "no-change",
		...(signs ? (["two signs of zero held apart"] as const) : []),
		...(retaken ? (["a typed key freed and taken again"] as const) : [])
	]
}

/**
 * Label (id, text), its `value` generated from its text, at most one label of each value: a declared key over a
 * generated field. The role `writer` writes Low, the labels below id 5, an entry whose head holds the generated `value`
 * beside the fields its writer states; a label at id 5 or above is outside its world.
 */
const Label = relation.generated("Label", { id: pg.integer, text: KeyText }, ["id"], (r) => ({
	value: generated(pg.integer, Compute.cast(r.text, pg.integer))
}))
const labelValue = key(on(Label, "value"))

const labelsAt = (name: string) => {
	const base = schema(name, { Label }, [labelValue])
	const low = query(base).rule((r) => {
		const { id, text, value } = v(Label, "label")
		return r.match(Label, { id, text, value }).where(r.lt(id, 5)).find({ id, text, value })
	})
	const writer = role(base, "writer", { Low: low }, { write: ["Low"] })
	return { base, writer, desk: login(base, "desk", [writer]) }
}

/** A label as written through Low, its text in KeyText's language or outside it, as a JavaScript caller states it. */
interface LabelRow {
	readonly id: number
	readonly text: string
}

/** The labels stored before a write through Low, lawful together, some inside it and some outside; and the label
 * written, its text in KeyText's language or, a draw in eight, outside it. */
interface LabelCase {
	readonly stored: ReadonlyArray<TagRow>
	readonly edit: "insert" | "put"
	readonly written: TagRow
	readonly unmatched: boolean
}

/** The label a case sends: its written label, its text spoiled where the case draws it unmatched. */
const sentOf = (c: LabelCase): LabelRow => ({
	id: c.written.id,
	text: c.unmatched ? `x${c.written.text}` : c.written.text
})

const labelGen: Gen<TagRow> = (source) => ({
	id: source.draw(int(1, 7)),
	text: source.draw(textGen)
})

const labelCaseGen: Gen<LabelCase> = (source) => {
	const drawnRows = source.draw(array(labelGen, { min: 0, max: 3 }))
	const stored = Arr.reduce(drawnRows, Arr.empty<TagRow>(), (kept, r) =>
		Arr.some(kept, (k) => k.id === r.id || valueOf(k.text) === valueOf(r.text))
			? kept
			: [...kept, r]
	)
	const fresh = source.draw(labelGen)
	const near: Gen<TagRow> = Arr.isReadonlyArrayNonEmpty(stored)
		? oneOf([
				(s) => ({ ...s.draw(element(stored)), id: fresh.id }),
				(s) => ({ ...s.draw(element(stored)), text: otherSpelling(s.draw(element(stored)).text) }),
				(s) => ({ ...fresh, text: otherSpelling(s.draw(element(stored)).text) })
			])
		: (s) => s.draw(labelGen)
	const written = source.draw(oneOf([labelGen, near]))
	const unmatched = source.draw(int(0, 7)) === 0
	return {
		stored,
		edit: source.draw(element(["insert", "put"] as const)),
		written,
		unmatched
	}
}

/** Whether a label is inside Low. */
const inLow = (r: { readonly id: number }): boolean => r.id < 5

/**
 * What a write through Low must answer, from its specification (README, "Writing through a role"): a label outside Low
 * whose text the pattern refuses is either, which the README leaves unpromised; any other label outside Low is outside
 * the world; a text outside the pattern is the pattern's law; then a stored label at the written id that the write does
 * not displace, any outside Low and, for an insert, one inside it of another text, is the primary key's law; and a
 * stored label of the written value at another id, inside or outside Low, beside every label the put displaces, is the
 * value key's; an exact repeat inside Low changes nothing; any other write stores the label.
 */
type LabelExpected =
	| { readonly kind: "outsideOrPattern" }
	| { readonly kind: "outside" }
	| { readonly kind: "pattern" }
	| { readonly kind: "refused"; readonly laws: Arr.NonEmptyReadonlyArray<"primary" | "value"> }
	| { readonly kind: "unchanged" }
	| { readonly kind: "stored"; readonly rows: ReadonlyArray<TagRow> }

const labelExpected = (c: LabelCase): LabelExpected => {
	if (!inLow(c.written)) {
		return c.unmatched ? { kind: "outsideOrPattern" } : { kind: "outside" }
	}
	if (c.unmatched) {
		return { kind: "pattern" }
	}
	const atId = Arr.findFirst(c.stored, (s) => s.id === c.written.id)
	if (Option.exists(atId, (s) => s.text === c.written.text)) {
		return { kind: "unchanged" }
	}
	const displaced = c.edit === "put" && Option.exists(atId, inLow)
	const laws: Array<"primary" | "value"> = []
	if (Option.isSome(atId) && !displaced) {
		laws.push("primary")
	}
	if (
		Arr.some(c.stored, (s) => s.id !== c.written.id && valueOf(s.text) === valueOf(c.written.text))
	) {
		laws.push("value")
	}
	const [first, ...rest] = laws
	return first === undefined
		? {
				kind: "stored",
				rows: [...Arr.filter(c.stored, (s) => s.id !== c.written.id), c.written]
			}
		: { kind: "refused", laws: [first, ...rest] }
}

type LabelFeature =
	| "outside Low, its text unmatched"
	| "outside Low"
	| "a text outside the pattern inside Low"
	| "refused by the value key against a label outside Low"
	| "refused by the value key against a label inside Low"
	| "refused by the primary key"
	| "an exact repeat"
	| "stored"

/** A state's rows as grizzle reads them back, each relation's rows as their values' texts in heading order. */
type ReadRows = ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>

layer(Substrate.layer)("keys over generated fields, against PostgreSQL 19", (it) => {
	it.effect(
		"a write meets a key over generated fields at the values PostgreSQL stores, inside it and against every stored row",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(Keys, {}, { label: "genkey", extensions: [], programs })
					const names = namesOf(o.installed)
					const group = installationGroup(names)
					const laws: KeysLaws = {
						mapKeyPrimary: names.primaryKeyLaw(MapKey),
						typedKey: names.lawOf(typedKey),
						usePrimary: names.primaryKeyLaw(Use),
						useRef: names.lawOf(useRef),
						tagPrimary: names.primaryKeyLaw(Tag),
						positiveTag: names.lawOf(positiveTag),
						mappingPrimary: names.primaryKeyLaw(Mapping),
						entryPrimary: names.primaryKeyLaw(Entry),
						entryKey: names.lawOf(entryKey)
					}
					const host = hostOf(laws)
					return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ serve }) =>
						Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							const S = o.schema
							const texts = (row: ReadonlyArray<unknown>): ReadonlyArray<string> =>
								Arr.map(row, (x) => String(x))
							const readState = Effect.gen(function* () {
								const mapKeys = yield* Effect.flatMap(
									db.workload.mapKeys.execute({}),
									(r) => r.collect
								)
								const uses = yield* Effect.flatMap(db.workload.uses.execute({}), (r) => r.collect)
								const tags = yield* Effect.flatMap(db.workload.tags.execute({}), (r) => r.collect)
								const mappings = yield* Effect.flatMap(
									db.workload.mappings.execute({}),
									(r) => r.collect
								)
								const entryRows = yield* Effect.flatMap(
									db.workload.entries.execute({}),
									(r) => r.collect
								)
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
								const slots = Arr.dedupeWith(
									arrays,
									(a, b) => a.op === b.op && a.relation === b.relation
								)
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
							return yield* explore(
								{
									suite: "pg/write/generated-key",
									draw: drawn(caseGen(host)),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the law model's add-wins transition over facts whose generated fields the model computes from their texts"
									},
									kept: [
										{
											note: "qti-pie's typed map key: two spellings of one integer in one mapping, the second against the stored first",
											sketch: {
												stored: {
													mapKeys: [{ mapping: 1, text: "1" }],
													uses: [],
													tags: [],
													mappings: []
												},
												writes: [
													{
														relation: "MapKey",
														edit: "insert",
														source: "array",
														rows: [{ mapping: 1, text: "01" }]
													}
												]
											},
											draws: "",
											reaches: ["typed key refused against a stored row"]
										},
										{
											note: "two deletions at one tag's id and two additions at another's break Tag's primary key alike, and the refusal may name either pair",
											sketch: {
												stored: {
													mapKeys: [],
													uses: [],
													tags: [{ id: 3, text: "0" }],
													mappings: []
												},
												writes: [
													{
														relation: "Tag",
														edit: "insert",
														source: "array",
														rows: [{ id: 2, text: "00" }]
													},
													{
														relation: "Tag",
														edit: "delete",
														source: "array",
														rows: [
															{ id: 3, text: "1" },
															{ id: 3, text: "0" }
														]
													},
													{
														relation: "Tag",
														edit: "insert",
														source: "array",
														rows: [{ id: 2, text: "0" }]
													}
												]
											},
											draws: "",
											reaches: ["a key broken by deletions and additions alike"]
										}
									],
									runs: 80,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"typed key refused against a stored row",
											"typed key refused within the write",
											"typed key refused for a query's row",
											"typed key refused for a put",
											"positive tag refused",
											"entry key refused",
											"a reference refused",
											"two signs of zero held apart",
											"a typed key freed and taken again",
											"a key broken by deletions and additions alike",
											"accepted",
											"no-change"
										],
										{ cases: 120, sense: notesOnly }
									),
									caseHang
								},
								(drawnCase, c) =>
									Effect.gen(function* () {
										const k = aimedCase(drawnCase, c)
										yield* replaceRows(s.admin, group, [])
										const seeded = yield* db.workload.seed.apply(
											{
												insert: {
													MapKey: k.stored.mapKeys,
													Use: k.stored.uses,
													Tag: k.stored.tags,
													Mapping: Arr.map(k.stored.mappings, (m) => ({
														id: m.id,
														n: Arr.map(m.entries, (text) => ({ text }))
													}))
												}
											},
											{}
										)
										const none =
											k.stored.mapKeys.length +
												k.stored.uses.length +
												k.stored.tags.length +
												k.stored.mappings.length ===
											0
										assert.equal(
											seeded.kind,
											none ? "no-change" : "accepted",
											"the stored rows are lawful"
										)
										const before = storedState(k.stored)
										const beforeRows = yield* readState
										assert.deepEqual(
											beforeRows,
											sortedStateRows(host, before),
											"the stored rows are the model's"
										)
										const stratum = stratumOf(k.writes)
										const served = yield* serve({ stratum: stratum.changes })
										const ops = member(served, "stratum")
										const applied = yield* Effect.result(
											ops.kind === "facts"
												? ops.ops.apply(stratum.facts, stratum.params)
												: ops.ops.apply(stratum.params)
										)
										if (Result.isFailure(applied)) {
											return assert.fail(
												`a write over keys of generated fields is an outcome: ${applied.failure._tag}: ${applied.failure.message}`
											)
										}
										const outcome = applied.success
										const afterRows = yield* readState
										const expected = expectedOf(host, before, opsOf(k.writes))
										if (expected.kind === "refused") {
											if (outcome.kind !== "invariant-rejected") {
												return assert.fail(
													`a write breaking ${Arr.join(
														Arr.map(expected.violations, (v) => v.law),
														", "
													)} is refused, not ${outcome.kind}`
												)
											}
											assert.deepEqual(afterRows, beforeRows, "a refused write changes nothing")
											const named = Arr.map(refusedLaws(outcome.refused), names.reported)
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
											if (witness.kind === "unreported") {
												assert.ok(
													met.value.violators.length === 0 || met.value.law === laws.entryKey,
													`a refusal by ${met.value.law}, whose violators the write names, reports its key`
												)
											} else {
												assert.ok(
													Arr.some(
														met.value.violators,
														(x) =>
															x.relation === witness.relation &&
															sameValues(witness.values, x.values)
													),
													`the witness ${Formatter.format(witness)} names a fact breaking ${met.value.law} by its key, one of ${Formatter.format(met.value.violators)}`
												)
											}
											for (const note of refusalNotes(k, laws, host, before, [met.value])) {
												c.note(note)
											}
											return
										}
										assert.equal(
											outcome.kind,
											expected.changed ? "accepted" : "no-change",
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
									})
							)
						})
					).pipe(Effect.scoped, withLayer(o.served.layer))
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"a write through a query entry meets a key over a generated field at every stored row, inside the entry and outside it",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const built: Array<ReturnType<typeof labelsAt>> = []
						const m = yield* migrated({
							label: "labels",
							schemaName: { kind: "unique" },
							first: (name) => {
								const labels = labelsAt(name)
								built.push(labels)
								return { schema: labels.base, logins: [labels.desk] }
							},
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						const { writer, desk } = defined(built[0], "the installed version")
						const names = namesOf(m)
						const primaryLaw = names.primaryKeyLaw(Label)
						const valueLaw = names.lawOf(labelValue)
						const table = names.table(Label)
						const id = names.column(Label, "id")
						const text = names.column(Label, "text")
						const value = names.column(Label, "value")
						/**
						 * A JavaScript caller's writes through Low, an insert and a put of one label from each call's facts,
						 * whose text the types would refuse where it is unmatched.
						 */
						const lowWrites = {
							insert: changeSetOver.empty(writer).insert(writer.relations.Low, []),
							put: changeSetOver.empty(writer).put(writer.relations.Low, [])
						}
						const explored = withServedDb(m, desk.roles.writer, {}, ({ serve }) =>
							Effect.gen(function* () {
								const served = yield* serve(lowWrites)
								return yield* explore(
									{
										suite: "pg/write/generated-key/entry",
										draw: drawn(labelCaseGen),
										literal: Formatter.format,
										oracle: {
											kind: "specification",
											name: "a write through Low restated over the drawn labels: its world, its pattern, then each key"
										},
										kept: [],
										runs: 60,
										shrink: { kind: "bounded", candidates: 100 },
										concurrency: 1,
										steerEvery: 16,
										coverage: required<LabelFeature>(
											[
												"outside Low, its text unmatched",
												"outside Low",
												"a text outside the pattern inside Low",
												"refused by the value key against a label outside Low",
												"refused by the value key against a label inside Low",
												"refused by the primary key",
												"an exact repeat",
												"stored"
											],
											{ cases: 120, sense: notesOnly }
										),
										caseHang
									},
									(c, cx) =>
										Effect.gen(function* () {
											yield* clearRows(m.owner, installationGroup(names))
											if (Arr.isReadonlyArrayNonEmpty(c.stored)) {
												yield* m.sql(
													`INSERT INTO ${table} (${id}, ${text}) VALUES ${Arr.join(
														Arr.map(c.stored, (r) => `(${String(r.id)}, '${r.text}')`),
														", "
													)}`
												)
											}
											const rowsNow = m.owner.values(
												`SELECT ${id}, ${text}, ${value} FROM ${table} ORDER BY 1`,
												[]
											)
											const before = yield* rowsNow
											const ops = member(served, c.edit)
											const facts = { [c.edit]: { Low: [sentOf(c)] } }
											const applied = yield* Effect.result(
												ops.kind === "facts" ? ops.ops.apply(facts, {}) : ops.ops.apply({})
											)
											if (Result.isFailure(applied)) {
												return assert.fail(
													`a write through Low is an outcome: ${applied.failure._tag}: ${applied.failure.message}`
												)
											}
											const outcome = applied.success
											const after = yield* rowsNow
											const expected = labelExpected(c)
											switch (expected.kind) {
												case "outsideOrPattern": {
													assert.ok(
														outcome.kind === "outside-world" ||
															(outcome.kind === "invariant-rejected" &&
																Arr.every(
																	refusedLaws(outcome.refused),
																	(l) => l.kind === "pattern"
																)),
														`a label outside Low whose text the pattern refuses is outside the world or the pattern's, not ${outcome.kind}`
													)
													assert.deepEqual(after, before, "a refused write changes nothing")
													cx.note("outside Low, its text unmatched")
													return
												}
												case "outside": {
													assert.equal(outcome.kind, "outside-world", "a label outside Low")
													assert.deepEqual(after, before, "outside the world, nothing is written")
													cx.note("outside Low")
													return
												}
												case "pattern": {
													if (outcome.kind !== "invariant-rejected") {
														return assert.fail(`an unmatched text is refused, not ${outcome.kind}`)
													}
													assert.deepEqual(
														Arr.map(refusedLaws(outcome.refused), (l) => l.kind),
														["pattern"],
														"the pattern's law"
													)
													assert.deepEqual(after, before, "a refused write changes nothing")
													cx.note("a text outside the pattern inside Low")
													return
												}
												case "unchanged": {
													assert.equal(outcome.kind, "no-change", "an exact repeat")
													assert.deepEqual(after, before, "an exact repeat writes nothing")
													cx.note("an exact repeat")
													return
												}
												case "stored": {
													assert.equal(outcome.kind, "accepted", "a lawful label is stored")
													assert.deepEqual(
														after,
														Arr.map(
															Arr.sort(
																expected.rows,
																Order.mapInput(Order.Number, (r: TagRow) => r.id)
															),
															(r) => [r.id, r.text, valueOf(r.text)]
														),
														"the labels after the write"
													)
													cx.note("stored")
													return
												}
												case "refused": {
													if (outcome.kind !== "invariant-rejected") {
														return assert.fail(
															`a label breaking ${Arr.join(expected.laws, ", ")} is refused, not ${outcome.kind}`
														)
													}
													assert.deepEqual(after, before, "a refused write changes nothing")
													const [law, ...more] = Arr.map(
														refusedLaws(outcome.refused),
														names.reported
													)
													assert.deepEqual(more, [], "a key's refusal names its one law")
													const broken =
														law === primaryLaw ? "primary" : law === valueLaw ? "value" : undefined
													if (broken === undefined || !expected.laws.includes(broken)) {
														return assert.fail(
															`the refusal names ${String(law)}, not one of ${Arr.join(expected.laws, ", ")}`
														)
													}
													assert.deepEqual(
														outcome.witness,
														{
															kind: "key",
															relation: "Low",
															values:
																broken === "primary"
																	? { id: c.written.id }
																	: { value: valueOf(c.written.text) }
														},
														"the witness: the key written, in Low's fields, its generated value as PostgreSQL stores it"
													)
													if (broken === "primary") {
														cx.note("refused by the primary key")
														return
													}
													const outside = Arr.some(
														c.stored,
														(r) =>
															!inLow(r) &&
															r.id !== c.written.id &&
															valueOf(r.text) === valueOf(c.written.text)
													)
													cx.note(
														outside
															? "refused by the value key against a label outside Low"
															: "refused by the value key against a label inside Low"
													)
													return
												}
											}
										})
								)
							})
						)
						return yield* Effect.scoped(explored)
					})
				)
			)
	)
})
