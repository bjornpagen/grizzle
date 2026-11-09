import {
	catchRefusal,
	compareText,
	type Json,
	type Path,
	Refusal,
	taggedValueOf,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { MoneyText, VectorText } from "#compiler/ir/carriers.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import { carriers, Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { ServedFile } from "#compiler/served/forms.ts"

/**
 * The served file's text: a ServedFile as canonical JSON (core/canonical.ts writeCanonicalJson, keys in code-unit
 * order), so one login compiled twice is the same bytes and `grizzle check` compares them.
 *
 * A value is written as canonical JSON writes it: a string beginning with `~` escaped by a second, a bigint `~n:` and
 * its digits, a record's members in key order, undefined members left out. Beside those:
 *
 * - every ScalarType once, in the file's `types` table, in the order the walk first meets it (a contract's base and a
 *   span's endpoint before the type over them), each occurrence `~t:` and its index, so a refined type is one entry
 *   whatever the slots that read it;
 * - a Roster `~roster:` and its declared name, rebuilt at load from the live handles of the codes the file holds for
 *   it (ServedFile rosters);
 * - a host Decimal `~decimal:`, a host Money `~money:`, and the IR's DecimalText, MoneyText and VectorText `~d:`, `~m:`
 *   and `~v:`, each with its canonical payload;
 * - a Map `{"~map": [[key, value], ...]}` and a Set `{"~set": [value, ...]}`, in insertion order, which the compile
 *   that made them fixes.
 *
 * Nothing else is a served value: a function, a symbol, a class instance of any other kind, a record whose key begins
 * with `~` or holds a symbol is refused, so no member of a form is ever dropped or guessed.
 */

/** The marker keys of a Map's and a Set's JSON form. */
const mapKey = "~map"
const setKey = "~set"

/** The tags of the canonical values a served form holds, by what the file spells them under. */
const tags = {
	bigint: "n",
	type: "t",
	roster: "roster",
	decimal: "decimal",
	money: "money",
	decimalText: "d",
	moneyText: "m",
	vectorText: "v"
} as const

const carrierNames: ReadonlySet<string> = new Set(carriers)

/** Whether a record is a ScalarType: a carrier grizzle admits, and its capability set, which no other form holds both of. */
const isScalarType = (value: unknown): value is ScalarType => {
	if (!isRecord(value)) {
		return false
	}
	const carrier = value["carrier"]
	return typeof carrier === "string" && carrierNames.has(carrier) && isList(value["caps"])
}

/** A value no served form may hold, at `path`: the compile's input is the caller's, so it is refused, never dropped. */
const unserved = (path: Path, what: string): never => {
	throw new Refusal(unsupported(SourceLoc("served workload", path), `a served value, ${what}`))
}

/** A string as canonical JSON writes it: one beginning with `~` escaped by a second. */
const escapedText = (value: string): string => (value.startsWith("~") ? `~${value}` : value)

/** `~tag:payload`, a canonical value's text. */
const tagged = (tag: string, payload: string): string => `~${tag}:${payload}`

/** The canonical payload of a canonical value. */
const payloadOf = (value: object, path: Path): string =>
	taggedValueOf(value)?.payload ?? unserved(path, "a canonical value with a tag and payload")

/**
 * One walk of a served form into its JSON form, the types it meets interned into its table (see the header). Records
 * are walked in key order, so a type's index is the same for one form however its records were built.
 */
class ServedWriter {
	readonly types: Array<Json> = []
	readonly #byObject = new Map<ScalarType, number>()
	readonly #byText = new Map<string, number>()
	readonly #path: Array<string | number> = []

	value(value: unknown): Json {
		switch (typeof value) {
			case "string":
				return escapedText(value)
			case "boolean":
				return value
			case "number":
				return Number.isFinite(value)
					? value === 0
						? 0
						: value
					: unserved(this.#path, "a finite number")
			case "bigint":
				return tagged(tags.bigint, value.toString())
			case "object":
				return value === null ? unserved(this.#path, "not null") : this.#object(value)
			case "undefined":
			case "function":
			case "symbol":
				return unserved(this.#path, `not ${typeof value}`)
		}
	}

	#at<A>(segment: string | number, read: () => A): A {
		this.#path.push(segment)
		const out = read()
		this.#path.pop()
		return out
	}

	#object(value: object): Json {
		if (isList(value)) {
			return this.#array(value)
		}
		if (value instanceof Map) {
			return this.#map(value)
		}
		if (value instanceof Set) {
			return this.#set(value)
		}
		if (value instanceof Roster) {
			return tagged(tags.roster, value.closed)
		}
		if (value instanceof Decimal) {
			return tagged(tags.decimal, payloadOf(value, this.#path))
		}
		if (value instanceof Money) {
			return tagged(tags.money, payloadOf(value, this.#path))
		}
		if (value instanceof DecimalText) {
			return tagged(tags.decimalText, payloadOf(value, this.#path))
		}
		if (value instanceof MoneyText) {
			return tagged(tags.moneyText, payloadOf(value, this.#path))
		}
		if (value instanceof VectorText) {
			return tagged(tags.vectorText, payloadOf(value, this.#path))
		}
		const proto: unknown = Object.getPrototypeOf(value)
		if (!isRecord(value) || (proto !== Object.prototype && proto !== null)) {
			return unserved(this.#path, "a plain record, a Map, a Set or a canonical value")
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			return unserved(this.#path, "a record without symbol keys")
		}
		return isScalarType(value)
			? tagged(tags.type, String(this.#typeIndex(value)))
			: this.#record(value)
	}

	#array(value: ReadonlyArray<unknown>): Json {
		const out: Array<Json> = []
		for (const [i, item] of value.entries()) {
			out.push(
				this.#at(i, () =>
					item === undefined ? unserved(this.#path, "an element") : this.value(item)
				)
			)
		}
		return out
	}

	#map(value: ReadonlyMap<unknown, unknown>): Json {
		const entries: Array<Json> = []
		for (const [k, v] of value) {
			entries.push(this.#at(entries.length, () => [this.value(k), this.value(v)]))
		}
		return { [mapKey]: entries }
	}

	#set(value: ReadonlySet<unknown>): Json {
		const members: Array<Json> = []
		for (const v of value) {
			members.push(this.#at(members.length, () => this.value(v)))
		}
		return { [setKey]: members }
	}

	#record(value: Readonly<Record<string, unknown>>): Json {
		const out: Record<string, Json> = {}
		for (const key of Object.keys(value).toSorted(compareText)) {
			if (key.startsWith("~")) {
				unserved(this.#path, `a key not beginning with ~, not ${key}`)
			}
			const member = value[key]
			if (member !== undefined) {
				out[key] = this.#at(key, () => this.value(member))
			}
		}
		return out
	}

	/** The index of `type` in the table, interned once by its canonical text: its parts first. */
	#typeIndex(type: ScalarType): number {
		const known = this.#byObject.get(type)
		if (known !== undefined) {
			return known
		}
		if (!isRecord(type)) {
			throw defect("a ScalarType is a record")
		}
		const json = this.#record(type)
		const text = writeCanonicalJson(json)
		if (!text.ok) {
			throw new Refusal(text.error)
		}
		const same = this.#byText.get(text.value)
		const index = same ?? this.types.length
		if (same === undefined) {
			this.types.push(json)
			this.#byText.set(text.value, index)
		}
		this.#byObject.set(type, index)
		return index
	}
}

/** The served file's text of `file` (see the header), ending in a newline; refused where a form holds no served value. */
export const servedText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(
		catchRefusal(() => {
			const writer = new ServedWriter()
			const json = writer.value(file)
			if (typeof json !== "object" || isList(json)) {
				throw defect("a served file's JSON form is a record")
			}
			return { ...json, types: writer.types }
		}),
		(json) => Result.map(writeCanonicalJson(json), (text) => `${text}\n`)
	)

/** A roster by its declared name, its live handles in code order: its codes', holes left out. */
const rosterOf = (rosters: ReadonlyMap<string, RosterCodes>, name: string): Roster => {
	const codes = rosters.get(name)
	const parsed = parseDeclaredName(name)
	if (codes === undefined || !parsed.ok) {
		throw defect(`the served file holds the codes of its roster ${name}`)
	}
	const [first, ...rest] = codes.flatMap((slot) => (slot.kind === "live" ? [slot.handle] : []))
	if (first === undefined) {
		throw defect(`roster ${name} holds a live handle`)
	}
	return new Roster(parsed.value, [first, ...rest])
}

/**
 * One walk of a served file's JSON form back into its forms (see the header), its types read from `types`, each
 * occurrence of one index the same object, and its rosters from the codes the file holds for them.
 */
class ServedReader {
	readonly #types: ReadonlyArray<ScalarType>
	readonly #rosters: ReadonlyMap<string, RosterCodes>

	constructor(types: ReadonlyArray<ScalarType>, rosters: ReadonlyMap<string, RosterCodes>) {
		this.#types = types
		this.#rosters = rosters
	}

	value(json: unknown): unknown {
		if (typeof json === "string") {
			return json.startsWith("~") ? this.#tagged(json) : json
		}
		if (typeof json !== "object" || json === null) {
			return json
		}
		if (isList(json)) {
			return json.map((item) => this.value(item))
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
		const out: Record<string, unknown> = {}
		for (const [key, member] of Object.entries(record)) {
			out[key] = this.value(member)
		}
		return out
	}

	#tagged(text: string): unknown {
		if (text.startsWith("~~")) {
			return text.slice(1)
		}
		const colon = text.indexOf(":")
		const tag = text.slice(1, colon)
		const payload = text.slice(colon + 1)
		switch (tag) {
			case tags.bigint:
				return BigInt(payload)
			case tags.type: {
				const type = this.#types[Number(payload)]
				if (type === undefined) {
					throw defect(`the served types table holds type ${payload}`)
				}
				return type
			}
			case tags.roster:
				return rosterOf(this.#rosters, payload)
			case tags.decimal: {
				const decimal = Decimal.fromCanonical(payload)
				if (!decimal.ok) {
					throw defect(`a served decimal's payload is a decimal's one text: ${payload}`)
				}
				return decimal.value
			}
			case tags.money:
				return Money.of(BigInt(payload))
			case tags.decimalText:
				return DecimalText.parse(payload) ?? defect(`a served decimal text: ${payload}`)
			case tags.moneyText:
				return MoneyText.parse(payload) ?? defect(`a served money text: ${payload}`)
			case tags.vectorText:
				return VectorText.parse(payload) ?? defect(`a served vector text: ${payload}`)
			default:
				throw defect(`a served tag grizzle writes, not ${tag}`)
		}
	}
}

/** The JSON form of a served file, as an import of it or JSON.parse yields it: its members, its rosters and its types. */
interface ServedJson {
	readonly types: ReadonlyArray<unknown>
	readonly rosters: unknown
	readonly [member: string]: unknown
}

/**
 * The served file a served file's JSON value holds (what an import of the file, or JSON.parse of its text, yields),
 * trusted as the file `grizzle generate` wrote and `grizzle check` holds equal to the compile: one walk, its rosters
 * first, which hold no type or roster, then its types table, each entry over those before it, then its members.
 */
export const servedFile = (json: unknown): ServedFile => {
	const { types, rosters, ...members } = trusted<ServedJson>(json)
	const codes = trusted<ReadonlyMap<string, RosterCodes>>(
		new ServedReader([], new Map()).value(rosters)
	)
	const table: Array<ScalarType> = []
	for (const entry of types) {
		table.push(trusted<ScalarType>(new ServedReader(table, codes).value(entry)))
	}
	return trusted<ServedFile>({
		...trusted<object>(new ServedReader(table, codes).value(members)),
		rosters: codes
	})
}
