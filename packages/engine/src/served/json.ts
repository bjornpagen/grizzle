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
import { internedRangeOp, rangeOpNamed } from "#compiler/ir/expr.ts"
import { carriers, Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
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
 * - a bigint `~n:` and its digits;
 * - every ScalarType once, in the file's `types` table, in the order the walk first meets it (a contract's base and a
 *   span's endpoint before the type over them), each occurrence `~t:` and its index, so a refined type is one object
 *   whatever the slots that read it;
 * - a Roster `~roster:` and its declared name, rebuilt at load from the live handles of the codes the file holds for
 *   it (ServedFile rosters);
 * - a range overload `~op:` and its code and carrier, read back as its one instance (ir/expr.ts rangeOp), which the
 *   registry and the host evaluator know an overload by;
 * - a host Decimal `~decimal:`, a host Money `~money:`, and the IR's DecimalText, MoneyText and VectorText `~d:`, `~m:`
 *   and `~v:`, each with its canonical payload;
 * - a Map `{"~map": [[key, value], ...]}`, each key a primitive, and a Set `{"~set": [value, ...]}`, in insertion
 *   order, which the compile that made them fixes.
 *
 * A record holding a revived value at some depth lists, under its key `~`, the keys of its members that hold one, and
 * an array holding one is `{"~a": [item, ...], "~": [index, ...]}`, listing the indices of those items: a load rebuilds
 * exactly the paths to revived values, and every member beside them is the file's own value, read as it is.
 *
 * Nothing else is a served value: a function, a symbol, a class instance of any other kind, a record whose key begins
 * with `~` or holds a symbol is refused, so no member of a form is ever dropped or guessed.
 */

/** The marker keys of a Map's, a Set's and a revived array's JSON forms, and of a revived member's keys or indices. */
const mapKey = "~map"
const setKey = "~set"
const listKey = "~a"
const revivedKey = "~"

/** The tags of the canonical values a served form holds, by what the file spells them under. */
const tags = {
	bigint: "n",
	type: "t",
	roster: "roster",
	rangeOp: "op",
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

/** `~tag:payload`, a canonical value's text. */
const tagged = (tag: string, payload: string): string => `~${tag}:${payload}`

/** The canonical payload of a canonical value. */
const payloadOf = (value: object, path: Path): string =>
	taggedValueOf(value)?.payload ?? unserved(path, "a canonical value with a tag and payload")

/** A value's JSON form, and whether a load revives it: whether it or a value it holds is no JSON value as it is. */
interface Written {
	readonly json: Json
	readonly revived: boolean
}

/** A JSON form read back as it is. */
const plain = (json: Json): Written => ({ json, revived: false })

/** A JSON form a load revives. */
const revived = (json: Json): Written => ({ json, revived: true })

/**
 * One walk of a served form into its JSON form, the types it meets interned into its table (see the header). Records
 * are walked in key order, so a type's index is the same for one form however its records were built.
 */
class ServedWriter {
	readonly types: Array<Json> = []
	readonly #byObject = new Map<ScalarType, number>()
	readonly #byText = new Map<string, number>()
	readonly #path: Array<string | number> = []

	value(value: unknown): Written {
		switch (typeof value) {
			case "string":
				return value.startsWith("~") ? revived(`~${value}`) : plain(value)
			case "boolean":
				return plain(value)
			case "number":
				return Number.isFinite(value)
					? plain(value === 0 ? 0 : value)
					: unserved(this.#path, "a finite number")
			case "bigint":
				return revived(tagged(tags.bigint, value.toString()))
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

	#object(value: object): Written {
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
			return revived(tagged(tags.roster, value.closed))
		}
		if (value instanceof Decimal) {
			return revived(tagged(tags.decimal, payloadOf(value, this.#path)))
		}
		if (value instanceof Money) {
			return revived(tagged(tags.money, payloadOf(value, this.#path)))
		}
		if (value instanceof DecimalText) {
			return revived(tagged(tags.decimalText, payloadOf(value, this.#path)))
		}
		if (value instanceof MoneyText) {
			return revived(tagged(tags.moneyText, payloadOf(value, this.#path)))
		}
		if (value instanceof VectorText) {
			return revived(tagged(tags.vectorText, payloadOf(value, this.#path)))
		}
		const proto: unknown = Object.getPrototypeOf(value)
		if (!isRecord(value) || (proto !== Object.prototype && proto !== null)) {
			return unserved(this.#path, "a plain record, a Map, a Set or a canonical value")
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			return unserved(this.#path, "a record without symbol keys")
		}
		const op = internedRangeOp(value)
		if (op !== undefined) {
			return revived(tagged(tags.rangeOp, `${op.code}:${op.carrier}`))
		}
		return isScalarType(value)
			? revived(tagged(tags.type, String(this.#typeIndex(value))))
			: this.#record(value)
	}

	/** An array's items, and, where some are revived, the array's revived form listing their indices. */
	#array(value: ReadonlyArray<unknown>): Written {
		const items: Array<Json> = []
		const at: Array<number> = []
		for (const [i, item] of value.entries()) {
			const written = this.#at(i, () =>
				item === undefined ? unserved(this.#path, "an element") : this.value(item)
			)
			items.push(written.json)
			if (written.revived) {
				at.push(i)
			}
		}
		return at.length === 0 ? plain(items) : revived({ [listKey]: items, [revivedKey]: at })
	}

	/**
	 * A Map's entries, each key a primitive: a record key reads back as a new object, which no lookup by another finds,
	 * so a Map keyed by one is no served value.
	 */
	#map(value: ReadonlyMap<unknown, unknown>): Written {
		const entries: Array<Json> = []
		for (const [k, v] of value) {
			entries.push(
				this.#at(entries.length, () => [
					typeof k === "object" && k !== null
						? unserved(this.#path, "a Map keyed by primitives")
						: this.value(k).json,
					this.value(v).json
				])
			)
		}
		return revived({ [mapKey]: entries })
	}

	#set(value: ReadonlySet<unknown>): Written {
		const members: Array<Json> = []
		for (const v of value) {
			members.push(this.#at(members.length, () => this.value(v).json))
		}
		return revived({ [setKey]: members })
	}

	/** A record's members in key order, and, where some are revived, the keys of those under `~`. */
	#record(value: Readonly<Record<string, unknown>>): Written {
		const out: Record<string, Json> = {}
		const keys: Array<string> = []
		for (const key of Object.keys(value).toSorted(compareText)) {
			if (key.startsWith("~")) {
				unserved(this.#path, `a key not beginning with ~, not ${key}`)
			}
			const member = value[key]
			if (member !== undefined) {
				const written = this.#at(key, () => this.value(member))
				out[key] = written.json
				if (written.revived) {
					keys.push(key)
				}
			}
		}
		if (keys.length === 0) {
			return plain(out)
		}
		out[revivedKey] = keys
		return revived(out)
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
		const json = this.#record(type).json
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

/**
 * The served file's text of `file` (see the header), ending in a newline; refused where a form holds no served value.
 * Its members are walked as one record, and beside them its rosters and its types table, which a load reads first and
 * by name (servedFile), so the record's `~` lists only the members a load walks to a revived value.
 */
export const servedText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(
		catchRefusal(() => {
			const writer = new ServedWriter()
			const { rosters, ...members } = file
			const { json } = writer.value(members)
			if (typeof json !== "object" || isList(json)) {
				throw defect("a served file's JSON form is a record")
			}
			return { ...json, rosters: writer.value(rosters).json, types: writer.types }
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
 * One walk of a served file's JSON form back into its forms (see the header): only the paths its records and arrays
 * list to revived values, each value beside them the file's own, read as it is; its types read from `types`, each
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
			case tags.rangeOp: {
				const at = payload.lastIndexOf(":")
				return (
					rangeOpNamed(payload.slice(0, at), payload.slice(at + 1)) ??
					defect(`a served range overload's code and carrier name one: ${payload}`)
				)
			}
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
 * trusted as the file `grizzle generate` wrote and `grizzle check` holds equal to the compile: its rosters first, which
 * hold no type or roster, then its types table, each entry over those before it, then its members, each walked only
 * along the paths it lists to revived values, every other value the JSON value's own.
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
