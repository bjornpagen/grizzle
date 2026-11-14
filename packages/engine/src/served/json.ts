import {
	type CanonicalObject,
	canonicalOf,
	catchRefusal,
	compareText,
	floatSpecialOf,
	type Json,
	type Outside,
	type Path,
	Refusal,
	type TaggedValue,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { RosterDigest } from "#compiler/core/fingerprint.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type Parts, type SharingFormat, shareRepeated } from "#compiler/core/share.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { MoneyText, VectorText, vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import { internedRangeOp, rangeOpNamed } from "#compiler/ir/expr.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import type { ServedFile } from "#compiler/served/forms.ts"

/**
 * The served file's text: a ServedFile as canonical JSON (core/canonical.ts writeCanonicalJson, keys in code-unit
 * order), so one login compiled twice is the same bytes and `grizzle check` compares them.
 *
 * A value JSON holds as the runtime reads it, a string, a finite number, a boolean, and an array or a plain record of
 * such values, is written as it is, and read back as it is: the value the import of the file yields is the runtime's
 * form, which a load reads in place with no second walk. Every other value is written as a revived one:
 *
 * - a string beginning with `~`, escaped by a second;
 * - a bigint `~n:` and its digits, and NaN and the infinities `~f:` and the word naming each (floatSpecialNames);
 * - a Roster `~roster:` and its canonical payload, its declared name and its handles' digest, rebuilt at load over the
 *   live handles of the file's codes for it (`rosters`, below) with the digest generate took, so a load hashes no
 *   handle;
 * - a range overload `~op:` and its code and carrier, read back as its one instance (ir/expr.ts rangeOp), which the
 *   registry and the host evaluator know an overload by;
 * - a host Decimal `~decimal:`, a host Money `~money:`, a host vector `~vector:`, and the IR's DecimalText, MoneyText
 *   and VectorText `~d:`, `~m:` and `~v:`, each with its canonical payload;
 * - a Map `{"~map": [[key, value], ...]}`, each key a primitive, and a Set `{"~set": [value, ...]}`, in insertion
 *   order, which the compile that made them fixes.
 *
 * A record holding a revived value at some depth lists, under its key `~`, the keys of its members that hold one, and
 * an array holding one is `{"~a": [item, ...], "~": [index, ...]}`, listing the indices of those items: a load rebuilds
 * exactly the paths to revived values, and every member beside them is the file's own value, read as it is.
 *
 * Every shape is written once (core/share.ts): a record, an array, a Map or a Set that stands in the file more than
 * once, and whose text is longer than a reference to it, is an entry of the file's table, `shared`, and each place it
 * stands holds `~s:` and its index, a revived value, so one ScalarType, one heading or one statement's parameters is
 * one entry and one object at load whatever the slots that read it. A shape no longer than its reference stays where it
 * stands. The table lists an entry after every entry it references.
 *
 * Nothing else is a served value: a function, a symbol, a class instance of any other kind, a record whose key begins
 * with `~` or holds a symbol is refused, so no member of a form is ever dropped or guessed. A value is read once by the
 * canonical model (core/canonical.ts canonicalOf) and then by the file's own (servedOf), and the writer and the reader
 * each dispatch on that one reading, the reader's tags the writer's (ServedTag).
 *
 * Beside its members the file holds its table, `shared`, and its rosters' codes, `rosters`, which a load reads first
 * and by name. `rosters` is no served value but the codes' own form: each roster's codes under its declared name,
 * a RosterWire, code c at position c, a live code its handle and a hole `false`, so a roster of live codes alone is its
 * handles in code order. A load reads it once (fileRosters) into the codes ServedFile holds.
 */

/** The marker keys of a Map's, a Set's and a revived array's JSON forms, and of a revived member's keys or indices. */
const mapKey = "~map"
const setKey = "~set"
const listKey = "~a"
const revivedKey = "~"

/** The tags of the canonical values a served form holds, by what the file spells them under. */
const tags = {
	bigint: "n",
	float: "f",
	shared: "s",
	roster: "roster",
	rangeOp: "op",
	decimal: "decimal",
	money: "money",
	vector: "vector",
	decimalText: "d",
	moneyText: "m",
	vectorText: "v"
} as const

/** A tag the file spells a revived scalar under: one of `tags`, which the writer writes and the reader reads. */
type ServedTag = (typeof tags)[keyof typeof tags]

const servedTags: ReadonlySet<string> = new Set<string>(Object.values(tags))

/** Whether text read after a `~` names a served tag. */
const isServedTag = (tag: string): tag is ServedTag => servedTags.has(tag)

/** A value no served form may hold, at `path`: the compile's input is the caller's, so it is refused, never dropped. */
const unserved = (path: Path, what: string): never => {
	throw new Refusal(unsupported(SourceLoc("served workload", path), `a served value, ${what}`))
}

/**
 * A value as a served file holds it (servedOf), beside its JSON scalars, which are their own: a scalar a load revives,
 * spelled `~<tag>:<payload>` under its ServedTag; a string beginning with `~`, escaped by a second; an array; a plain
 * record; a Map; a Set; or a value no served form holds, beside what the file holds in its place.
 */
type ServedObject =
	| { readonly kind: "tagged"; readonly tag: ServedTag; readonly payload: string }
	| { readonly kind: "escaped"; readonly text: string }
	| { readonly kind: "array"; readonly items: ReadonlyArray<unknown> }
	| { readonly kind: "record"; readonly record: Readonly<Record<string, unknown>> }
	| { readonly kind: "map"; readonly map: ReadonlyMap<unknown, unknown> }
	| { readonly kind: "set"; readonly set: ReadonlySet<unknown> }
	| { readonly kind: "unserved"; readonly what: string }

/** A value as a served file holds it, by its kind: a JSON scalar written as it is, or a ServedObject. */
type ServedValue = string | number | boolean | ServedObject

const servedTagged = (tag: ServedTag, payload: string): ServedObject => ({
	kind: "tagged",
	tag,
	payload
})

const notServed = (what: string): ServedObject => ({ kind: "unserved", what })

/**
 * A vector as the file holds it: its components under `~vector:`, in the payload grammar Vector.fromCanonical reads
 * (VectorText, 1..vectorMaxDimensions components), any other count none a load revives.
 */
const servedVector = (components: Float32Array): ServedObject => {
	const text = VectorText.of(components)
	return text.ok
		? servedTagged(tags.vector, text.value.toString())
		: notServed(`a vector of 1 to ${vectorMaxDimensions.value} finite components`)
}

/**
 * A value implementing the protocol as the file holds it, by its class, since a load revives each class as itself: a
 * Roster, a host Decimal and Money and the IR's DecimalText, MoneyText and VectorText by their canonical payloads; a
 * value of any other class is no served value.
 */
const servedClass = (value: object, tagged: TaggedValue): ServedObject => {
	if (value instanceof Roster) {
		return servedTagged(tags.roster, tagged.payload)
	}
	if (value instanceof Decimal) {
		return servedTagged(tags.decimal, tagged.payload)
	}
	if (value instanceof Money) {
		return servedTagged(tags.money, tagged.payload)
	}
	if (value instanceof DecimalText) {
		return servedTagged(tags.decimalText, tagged.payload)
	}
	if (value instanceof MoneyText) {
		return servedTagged(tags.moneyText, tagged.payload)
	}
	return value instanceof VectorText
		? servedTagged(tags.vectorText, tagged.payload)
		: notServed("a plain record, a Map, a Set or a canonical value")
}

/** A plain record as the file holds it: a range overload by its code and carrier, or a record. */
const servedRecord = (record: Readonly<Record<string, unknown>>): ServedObject => {
	const op = internedRangeOp(record)
	return op === undefined
		? { kind: "record", record }
		: servedTagged(tags.rangeOp, `${op.code}:${op.carrier}`)
}

/** A value outside the canonical model as the file holds it: a Map, a Set, or none. */
const servedOutside = (read: Outside): ServedObject => {
	const { value } = read
	if (value instanceof Map) {
		return { kind: "map", map: value }
	}
	return value instanceof Set ? { kind: "set", set: value } : notServed(read.what)
}

/** A canonical object as the file holds it (servedOf). */
const servedObject = (read: CanonicalObject | Outside): ServedObject => {
	switch (read.kind) {
		case "vector":
			return servedVector(read.components)
		case "floatSpecial":
			return servedTagged(tags.float, read.name)
		case "tagged":
			return servedClass(read.value, read.tagged)
		case "array":
			return { kind: "array", items: read.items }
		case "record":
			return servedRecord(read.record)
		case "outside":
			return servedOutside(read)
	}
}

/**
 * The one reading of a value by the served file (ServedValue), over its reading by the canonical model (canonicalOf):
 * well-formed text as it is, or escaped where it begins with `~`; a finite number, -0 as 0; a boolean; a bigint, NaN,
 * an infinity, a vector and a canonical value of a served class under their tags; a range overload, an
 * array and a plain record; a Map and a Set; and nothing else. No reading is undefined, a function or a symbol, so
 * those cases hold none (never).
 */
const servedOf = (value: unknown): ServedValue => {
	const read = canonicalOf(value)
	switch (typeof read) {
		case "string":
			return read.startsWith("~") ? { kind: "escaped", text: `~${read}` } : read
		case "number":
			return read === 0 ? 0 : read
		case "boolean":
			return read
		case "bigint":
			return servedTagged(tags.bigint, read.toString())
		case "object":
			return servedObject(read)
		case "undefined":
		case "function":
		case "symbol":
			return read
	}
}

/** A record's JSON form. */
type JsonRecord = { readonly [key: string]: Json }

/**
 * Whether a load revives a JSON form the writer wrote (see the header): text beginning with `~`, or a record under a
 * Map's, a Set's or a revived member's marker key. Every other form is read back as it is.
 */
const isRevived = (json: Json): boolean => {
	if (typeof json === "string") {
		return json.startsWith("~")
	}
	return (
		typeof json === "object" &&
		!isList(json) &&
		(Object.hasOwn(json, revivedKey) || Object.hasOwn(json, mapKey) || Object.hasOwn(json, setKey))
	)
}

/**
 * One walk of a served form into its JSON form (see the header), each object written once: an object two forms share
 * is one JSON node, which the file's sharing reads once (servedSharing). Records are walked in key order.
 */
class ServedWriter {
	/** Each object's JSON form by the object, so a form two others hold is written once, as one node. */
	readonly #written = new Map<object, Json>()
	readonly #path: Array<string | number> = []

	/** A value's JSON form: an object's written once (#written), any other value's by its served reading (#served). */
	#value(value: unknown): Json {
		if (typeof value !== "object" || value === null) {
			return this.#served(value)
		}
		const known = this.#written.get(value)
		if (known !== undefined) {
			return known
		}
		const json = this.#served(value)
		this.#written.set(value, json)
		return json
	}

	/**
	 * A value's JSON form, by its served reading (servedOf): a JSON scalar as it is, and an object as #object writes it.
	 * No served reading is a bigint, undefined, a function or a symbol, so those cases hold none (never).
	 */
	#served(value: unknown): Json {
		const served = servedOf(value)
		switch (typeof served) {
			case "string":
			case "number":
			case "boolean":
				return served
			case "object":
				return this.#object(served)
			case "bigint":
			case "undefined":
			case "function":
			case "symbol":
				return served
		}
	}

	#at<A>(segment: string | number, read: () => A): A {
		this.#path.push(segment)
		const out = read()
		this.#path.pop()
		return out
	}

	#object(served: ServedObject): Json {
		switch (served.kind) {
			case "tagged":
				return `~${served.tag}:${served.payload}`
			case "escaped":
				return served.text
			case "array":
				return this.#array(served.items)
			case "record":
				return this.record(served.record)
			case "map":
				return this.#map(served.map)
			case "set":
				return this.#set(served.set)
			case "unserved":
				return unserved(this.#path, served.what)
		}
	}

	/** An array's items, and, where some are revived, the array's revived form listing their indices. */
	#array(value: ReadonlyArray<unknown>): Json {
		const items: Array<Json> = []
		for (const [i, item] of value.entries()) {
			items.push(
				this.#at(i, () =>
					item === undefined ? unserved(this.#path, "an element") : this.#value(item)
				)
			)
		}
		return arrayForm(items)
	}

	/**
	 * A Map's entries, each key a primitive: a record key reads back as a new object, which no lookup by another finds,
	 * so a Map keyed by one is no served value.
	 */
	#map(value: ReadonlyMap<unknown, unknown>): Json {
		const entries: Array<Json> = []
		for (const [k, v] of value) {
			entries.push(
				this.#at(entries.length, () => [
					typeof k === "object" && k !== null
						? unserved(this.#path, "a Map keyed by primitives")
						: this.#value(k),
					this.#value(v)
				])
			)
		}
		return { [mapKey]: entries }
	}

	#set(value: ReadonlySet<unknown>): Json {
		const members: Array<Json> = []
		for (const v of value) {
			members.push(this.#at(members.length, () => this.#value(v)))
		}
		return { [setKey]: members }
	}

	/** A record's members in key order, and, where some are revived, the keys of those under `~`. */
	record(value: Readonly<Record<string, unknown>>): JsonRecord {
		const members: Array<readonly [string, Json]> = []
		for (const key of Object.keys(value).toSorted(compareText)) {
			if (key.startsWith("~")) {
				unserved(this.#path, `a key not beginning with ~, not ${key}`)
			}
			const member = value[key]
			if (member !== undefined) {
				members.push([key, this.#at(key, () => this.#value(member))])
			}
		}
		return recordForm(members)
	}
}

/** An array of `items` as the file holds it: as it is, or, where some are revived, its revived form listing them. */
const arrayForm = (items: ReadonlyArray<Json>): Json => {
	const at: Array<number> = []
	for (const [i, item] of items.entries()) {
		if (isRevived(item)) {
			at.push(i)
		}
	}
	return at.length === 0 ? items : { [listKey]: items, [revivedKey]: at }
}

/** A record of `members`, in their order, and, where some are revived, the keys of those under `~`. */
const recordForm = (members: ReadonlyArray<readonly [string, Json]>): JsonRecord => {
	const out: Record<string, Json> = {}
	const keys: Array<string> = []
	for (const [key, member] of members) {
		out[key] = member
		if (isRevived(member)) {
			keys.push(key)
		}
	}
	if (keys.length > 0) {
		out[revivedKey] = keys
	}
	return out
}

/** A Map's entry as the writer writes it: its key and its value. */
const entryOf = (entry: Json): readonly [Json, Json] => {
	if (!isList(entry) || entry.length !== 2) {
		throw defect("a served Map's entry, its key and its value")
	}
	const [key, value] = entry
	if (key === undefined || value === undefined) {
		throw defect("a served Map's entry, its key and its value")
	}
	return [key, value]
}

/** The JSON list under a marker key a revived form holds. */
const listUnder = (record: JsonRecord, key: string): ReadonlyArray<Json> | undefined => {
	const member = record[key]
	return member !== undefined && isList(member) ? member : undefined
}

/** A plain record's member keys, its `~` aside, in code-unit order. */
const memberKeys = (record: JsonRecord): ReadonlyArray<string> =>
	Object.keys(record)
		.filter((key) => key !== revivedKey)
		.toSorted(compareText)

/**
 * The served file's nodes as its sharing reads them (core/share.ts): every array, record, Map and Set a reference may
 * stand in for, each value it holds a slot (an array's items, a revived array's alike, a Map's keys and values in
 * order, a Set's members, a record's members but its `~`); the marker lists beside them are no slot, since each is
 * read off its record's members, and a rebuilt node lists again the members its slots hold revived, a reference among
 * them.
 */
const servedSharing: SharingFormat = {
	parts: (node): Parts | undefined => {
		if (typeof node !== "object") {
			return undefined
		}
		if (isList(node)) {
			return { frame: "[", slots: node }
		}
		const entries = listUnder(node, mapKey)
		if (entries !== undefined) {
			return { frame: "M", slots: entries.flatMap(entryOf) }
		}
		const members = listUnder(node, setKey)
		if (members !== undefined) {
			return { frame: "S", slots: members }
		}
		const items = listUnder(node, listKey)
		if (items !== undefined) {
			return { frame: "[", slots: items }
		}
		const keys = memberKeys(node)
		return {
			frame: `{${JSON.stringify(keys)}`,
			slots: keys.map((key) => defined(node[key], `a record's member ${key}`))
		}
	},
	rebuild: (node, slots) => {
		if (typeof node !== "object") {
			return node
		}
		if (isList(node) || listUnder(node, listKey) !== undefined) {
			return arrayForm(slots)
		}
		if (listUnder(node, mapKey) !== undefined) {
			const entries: Array<Json> = []
			for (let at = 0; at < slots.length; at += 2) {
				entries.push([
					defined(slots[at], "a Map entry's key"),
					defined(slots[at + 1], "a Map entry's value")
				])
			}
			return { [mapKey]: entries }
		}
		if (listUnder(node, setKey) !== undefined) {
			return { [setKey]: slots }
		}
		return recordForm(
			memberKeys(node).map(
				(key, at) => [key, defined(slots[at], `a record's member ${key}`)] as const
			)
		)
	},
	reference: (_, at) => `~${tags.shared}:${at}`
}

/**
 * A roster's codes as the served file holds them (see the header): code c at position c, a live code its handle and a
 * hole `false`, which no handle is, so the list is the roster's code space and a hole is told from a handle by its JSON
 * type alone.
 */
export type RosterWire = ReadonlyArray<string | false>

/** The file's rosters: each roster's codes under its declared name. */
type RostersWire = { readonly [roster: string]: RosterWire }

/** A roster's codes in the served file's form (RosterWire). */
export const rosterWire = (codes: RosterCodes): RosterWire =>
	codes.map((slot) => (slot.kind === "live" ? slot.handle : false))

/** The codes a roster's served form (RosterWire) holds. */
export const rosterCodesOf = (wire: RosterWire): RosterCodes =>
	wire.map((slot): CodeSlot => (slot === false ? { kind: "hole" } : { kind: "live", handle: slot }))

/** The record the file's members are written as: a record, never a reference, since it stands once. */
const membersRecord = (json: Json): JsonRecord => {
	if (typeof json !== "object" || isList(json)) {
		throw defect("a served file's members written as one record")
	}
	return json
}

/**
 * The served file's text of `file` (see the header), ending in a newline; refused where a form holds no served value.
 * Its members are walked as one record, each repeated shape written once in its table (servedSharing), and beside
 * them its rosters in their own form (rosterWire) and its table, which a load reads first and by name (servedFile), so
 * the record's `~` lists only the members a load walks to a revived value.
 */
export const servedText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(
		catchRefusal(() => {
			const { rosters, ...members } = file
			const written = shareRepeated([new ServedWriter().record(members)], servedSharing)
			const wire: RostersWire = Object.fromEntries(
				Array.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])
			)
			const [root] = written.roots
			return {
				...membersRecord(defined(root, "a served file's members")),
				rosters: wire,
				shared: written.table.map((entry) => entry.node)
			}
		}),
		(json) => Result.map(writeCanonicalJson(json), (text) => `${text}\n`)
	)

/**
 * The file's rosters as a load reads them, once (fileRosters): each roster's codes, which ServedFile holds, and its
 * live handles in code order, which every Roster the file names is rebuilt over.
 */
interface FileRosters {
	readonly codes: ReadonlyMap<DeclaredName, RosterCodes>
	readonly handles: ReadonlyMap<DeclaredName, NonEmptyReadonlyArray<string>>
}

/**
 * The file's rosters (RostersWire) read once, each name trusted as the compile wrote it; a roster holds a live handle,
 * since its codes are a declaration's.
 */
const fileRosters = (wire: RostersWire): FileRosters => {
	const codes = new Map<DeclaredName, RosterCodes>()
	const handles = new Map<DeclaredName, NonEmptyReadonlyArray<string>>()
	for (const [roster, slots] of Object.entries(wire)) {
		const name = trusted<DeclaredName>(roster)
		const live = slots.filter((slot) => slot !== false)
		if (!isNonEmpty(live)) {
			throw defect(`roster ${name} holds a live handle`)
		}
		codes.set(name, rosterCodesOf(slots))
		handles.set(name, live)
	}
	return { codes, handles }
}

/**
 * A roster by its canonical payload, its declared name and its handles' digest, each trusted as the compile wrote it,
 * over its live handles the file's rosters hold.
 */
const rosterOf = (
	handles: ReadonlyMap<DeclaredName, NonEmptyReadonlyArray<string>>,
	payload: string
): Roster => {
	const at = payload.lastIndexOf(":")
	const name = trusted<DeclaredName>(payload.slice(0, at))
	return new Roster(
		name,
		defined(handles.get(name), `the served file holds the codes of its roster ${name}`),
		trusted<RosterDigest>(payload.slice(at + 1))
	)
}

/**
 * One walk of a served file's JSON form back into its forms (see the header): only the paths its records and arrays
 * list to revived values, each value beside them the file's own, read as it is; each shared node read from `shared`,
 * every reference to one entry the same object, and its rosters over the live handles the file holds for them.
 */
class ServedReader {
	readonly #shared: ReadonlyArray<unknown>
	readonly #handles: ReadonlyMap<DeclaredName, NonEmptyReadonlyArray<string>>

	constructor(
		shared: ReadonlyArray<unknown>,
		handles: ReadonlyMap<DeclaredName, NonEmptyReadonlyArray<string>>
	) {
		this.#shared = shared
		this.#handles = handles
	}

	value(json: unknown): unknown {
		if (typeof json === "string") {
			return json.startsWith("~") ? this.#tagged(json) : json
		}
		if (typeof json !== "object" || json === null || isList(json)) {
			return json
		}
		const record = trusted<Readonly<Record<string, unknown>>>(json)
		const entries = record[mapKey]
		if (isList(entries)) {
			const map = new Map<unknown, unknown>()
			for (const entry of entries) {
				const [k, v] = trusted<readonly [unknown, unknown]>(entry)
				map.set(this.value(k), this.value(v))
			}
			return map
		}
		const members = record[setKey]
		if (isList(members)) {
			return new Set(members.map((member) => this.value(member)))
		}
		const at = record[revivedKey]
		if (!isList(at)) {
			return json
		}
		const items = record[listKey]
		if (isList(items)) {
			const out = [...items]
			for (const i of trusted<ReadonlyArray<number>>(at)) {
				out[i] = this.value(items[i])
			}
			return out
		}
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(record)) {
			if (key !== revivedKey) {
				out[key] = record[key]
			}
		}
		for (const key of trusted<ReadonlyArray<string>>(at)) {
			out[key] = this.value(record[key])
		}
		return out
	}

	#tagged(text: string): unknown {
		if (text.startsWith("~~")) {
			return text.slice(1)
		}
		const colon = text.indexOf(":")
		const tag = text.slice(1, colon)
		if (!isServedTag(tag)) {
			throw defect(`a served tag grizzle writes, not ${tag}`)
		}
		return this.#revive(tag, text.slice(colon + 1))
	}

	/** The value a served scalar of `tag` and `payload` revives to, the one form the writer wrote under that tag. */
	#revive(tag: ServedTag, payload: string): unknown {
		switch (tag) {
			case tags.bigint:
				return BigInt(payload)
			case tags.float:
				return defined(floatSpecialOf(payload), `a served float named by a word: ${payload}`)
			case tags.shared:
				return defined(
					this.#shared[Number(payload)],
					`the served table holds entry ${payload} before any entry referencing it`
				)
			case tags.roster:
				return rosterOf(this.#handles, payload)
			case tags.rangeOp: {
				const at = payload.lastIndexOf(":")
				return defined(
					rangeOpNamed(payload.slice(0, at), payload.slice(at + 1)),
					`a served range overload's code and carrier name one: ${payload}`
				)
			}
			case tags.decimal:
				return revivedOf(Decimal.fromCanonical(payload), `a served decimal: ${payload}`)
			case tags.money:
				return Money.of(BigInt(payload))
			case tags.vector:
				return revivedOf(Vector.fromCanonical(payload), `a served vector: ${payload}`)
			case tags.decimalText:
				return defined(DecimalText.parse(payload), `a served decimal text: ${payload}`)
			case tags.moneyText:
				return defined(MoneyText.parse(payload), `a served money text: ${payload}`)
			case tags.vectorText:
				return defined(VectorText.parse(payload), `a served vector text: ${payload}`)
		}
	}
}

/** The value a served payload's reviver restores, which revives every payload the writer wrote. */
const revivedOf = <A>(result: Result.Result<A, CompileError>, what: string): A => {
	if (!result.ok) {
		throw defect(`${what} is the one text of its value: ${result.error.message}`)
	}
	return result.value
}

/**
 * The JSON form of a served file, as an import of it or JSON.parse yields it: its members, its rosters and its table.
 */
interface ServedJson {
	readonly shared: ReadonlyArray<unknown>
	readonly rosters: RostersWire
	readonly [member: string]: unknown
}

/**
 * The served file a served file's JSON value holds (what an import of the file, or JSON.parse of its text, yields),
 * trusted as the file `grizzle generate` wrote and `grizzle check` holds equal to the compile: its rosters first, read
 * once (fileRosters), then its table, each entry over those before it, then its members, each walked only along the
 * paths it lists to revived values, every other value the JSON value's own.
 */
export const servedFile = (json: unknown): ServedFile => {
	const { shared, rosters, ...members } = trusted<ServedJson>(json)
	const { codes, handles } = fileRosters(rosters)
	const table: Array<unknown> = []
	const reader = new ServedReader(table, handles)
	for (const entry of shared) {
		table.push(reader.value(entry))
	}
	return trusted<ServedFile>({ ...trusted<object>(reader.value(members)), rosters: codes })
}
