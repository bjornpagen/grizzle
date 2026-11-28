import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { ChunkWriter, readJson, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import {
	jsonText,
	Utf8Writer,
	type WellFormedText,
	WellFormedWriter
} from "@bjornpagen/grizzle-text/utf8"
import {
	type CompileError,
	isCompileError,
	type KeyRefusal,
	malformedArtifact,
	malformedDescription,
	resourceBound,
	unrepresentableKeys,
	within
} from "#compiler/core/errors.ts"
import { isCapturedStack, isSourceLoc, readSite, SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { compareQuoted, type TextsId, textsId, wellFormed } from "#compiler/core/text.ts"

/**
 * The longest string V8 builds, in UTF-16 code units: a statement, drafted file, snapshot.json, meta.json or canonical
 * text that would be longer is refused as ResourceBound (stringLength) before it is built, where building it would
 * throw RangeError "Invalid string length". It is String::kMaxLength on a 64-bit platform, which node:buffer's
 * constants.MAX_STRING_LENGTH reports (test/unit/core/lines.test.ts reads it).
 *
 * @limitKind published
 * @owner V8 14.6, Node 26.13.0's JavaScript engine
 * @unit UTF-16 code units
 * @scope one JavaScript string
 * @constraint compile-time constant
 * @source https://github.com/nodejs/node/blob/v26.13.0/deps/v8/include/v8-primitive.h#L127
 * @quote kApiSystemPointerSize == 4 ? (1 << 28) - 16 : (1 << 29) - 24;
 * @verified 2026-11-05
 */
export const maxStringLength = 2 ** 29 - 24

/**
 * The greatest integer, which is also INT_MAX, a C int's greatest value: PostgreSQL's integer is its int32, and a C
 * int is 32 bits on every platform it builds on.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit an integer value
 * @scope every integer value: a column, a parameter, a literal, an endpoint, a span width
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L380
 * @quote <entry>-2147483648 to +2147483647</entry>
 * @verified 2026-11-20
 */
export const int4Max = 2147483647

export const canonicalFormat = "grizzle-canonical"

export const canonicalTag: unique symbol = Symbol.for("grizzle/canonical")

/**
 * The tag of a vector's canonical text, "~v:[c1,...,cn]": a Float32Array's (canonicalOf), and the IR's VectorText's,
 * which implements the protocol under it (ir/carriers.ts), so a host vector and the IR's vector of its components are
 * one text.
 */
export const vectorTag = "v"

/** The tag of a bigint's canonical text, "~n:<integer>", which the kernel reads itself. */
const bigintTag = "n"

/**
 * The tag of the canonical text of a number named by a word, "~f:<name>" (floatSpecialNames), which the kernel reads
 * itself: a float4 or float8 value PostgreSQL holds and JSON has no number for, -0 among them, which JSON writes as 0.
 */
const floatTag = "f"

/**
 * The floats named by a word, NaN, the infinities and -0, in one order: a literal's names and their canonical texts'.
 * -0 is a value of its own, distinct from 0 as xs:double and IEEE 754 hold it, though equal to it: JSON has no
 * number that keeps its sign.
 */
export const floatSpecialNames = ["NaN", "Infinity", "-Infinity", "-0"] as const
export type FloatSpecialName = (typeof floatSpecialNames)[number]

/** Each float named by a word, as the number it is. */
export const floatSpecials: Readonly<Record<FloatSpecialName, number>> = {
	NaN: Number.NaN,
	Infinity: Number.POSITIVE_INFINITY,
	"-Infinity": Number.NEGATIVE_INFINITY,
	"-0": -0
}

/** Whether a value is the word naming a float (floatSpecialNames). */
export const isFloatSpecialName = (value: unknown): value is FloatSpecialName =>
	typeof value === "string" && Object.hasOwn(floatSpecials, value)

/** The float a word names (floatSpecialNames); undefined for any other text. */
export const floatSpecialOf = (text: string): number | undefined =>
	isFloatSpecialName(text) ? floatSpecials[text] : undefined

/** The word naming a number JSON has none for, one not finite or -0; undefined for any other, which JSON writes as a
 * number. */
export const floatSpecialNameOf = (x: number): FloatSpecialName | undefined =>
	Number.isNaN(x)
		? "NaN"
		: x === Number.POSITIVE_INFINITY
			? "Infinity"
			: x === Number.NEGATIVE_INFINITY
				? "-Infinity"
				: Object.is(x, -0)
					? "-0"
					: undefined

export interface TaggedValue {
	/**
	 * Lowercase ASCII letters and digits, starting with a letter. "n" is reserved for bigint and "f" for NaN and the
	 * infinities; "v" is a vector's, which a value implementing the protocol may carry with a vector's payload.
	 */
	readonly tag: string
	readonly payload: string
}

export interface Canonicalizable {
	readonly [canonicalTag]: () => TaggedValue
}

/**
 * The key under which a stand-in names the one member of its own it stands for: a node that distinguishes a value only
 * for a proof and computes, prints and hashes as that member, a Logic.when branch's parameter (ir/desc.ts
 * guardedExpr). The canonical model reads a stand-in as the member it names (canonicalOf), so every text, digest,
 * fingerprint and comparison of a value holding one is the value's with the member in its place; only a Description's
 * JSON form (transportJson) writes the stand-in itself, for a decode to restore.
 */
export const standInTag: unique symbol = Symbol.for("grizzle/standIn")

/**
 * A stand-in: a record that names under standInTag the key of the member it stands for. The key is data, not the
 * member itself, so a copy that replaces the member (an object spread over the record) stands for the new member.
 */
export interface StandIn<K extends string> {
	readonly [standInTag]: K
}

/** The JSON form: what JSON.stringify and JSON.parse carry. */
export type Json =
	| string
	| number
	| boolean
	| ReadonlyArray<Json>
	| { readonly [key: string]: Json }

export type Path = ReadonlyArray<string | number>

/**
 * Whether an object property is left out of the canonical form, for presentation data excluded from semantic
 * identity: a pure function of the member's key and its value as memberOf reads it, never of where the record stands, so
 * a container has one text wherever it stands, whether a traversal writes it, compares it (sameUnder) or digests it by
 * its token (writeIdentityText).
 */
export type OmitRule = (key: string, value: unknown) => boolean

/**
 * A record's member as the canonical form reads it: a stack a builder captured (core/loc.ts CapturedStack) as the call
 * site it names, which is how a location's site is written, and every other value as it is.
 */
const memberOf = (value: unknown): unknown => (isCapturedStack(value) ? readSite(value) : value)

export interface EncodeOptions {
	readonly omit: OmitRule
}

/**
 * SourceLocs are excluded from semantic identity, and so is a text descriptor's analyzed language, a function of the
 * pattern beside it (ir/scalar.ts TextLanguage), and a pattern value's spelling, one of the spellings of the language
 * its key names (ir/pattern.ts PatternValue). By convention they travel under the properties "loc", "language" and
 * "spelling".
 */
export const omitSourceLocs = (key: string, value: unknown): boolean =>
	(key === "loc" && isSourceLoc(value)) ||
	(key === "language" &&
		isRecord(value) &&
		(value["kind"] === "every" || value["kind"] === "refined")) ||
	(key === "spelling" && typeof value === "string")

/** Every property in the canonical form: the text of the value as it is. */
export const everyProperty: EncodeOptions = { omit: () => false }

/** Every property but the SourceLocs: the text of the value's semantic identity. */
export const withoutSourceLocs: EncodeOptions = { omit: omitSourceLocs }

/** What a protocol method returns, admitted: anyone can forge the registered symbol, so the result is checked. */
const admitTaggedValue = (tagged: unknown): TaggedValue | undefined => {
	if (!isRecord(tagged)) {
		return undefined
	}
	const tag = tagged["tag"]
	const payload = tagged["payload"]
	return typeof tag === "string" && typeof payload === "string" ? { tag, payload } : undefined
}

/**
 * The tagged value a value implementing the protocol encodes to; undefined for any other value, and for a value whose
 * method returns anything but a tag and a payload.
 */
export const taggedValueOf = (value: unknown): TaggedValue | undefined => {
	if (typeof value !== "object" || value === null || !(canonicalTag in value)) {
		return undefined
	}
	const method: unknown = value[canonicalTag]
	if (typeof method !== "function") {
		return undefined
	}
	const tagged: unknown = Reflect.apply(method, value, [])
	return admitTaggedValue(tagged)
}

/** A value implementing the protocol: its method returns a tag and a payload. */
export const isCanonicalizable = (value: unknown): value is Canonicalizable =>
	taggedValueOf(value) !== undefined

const isTagName = (tag: string): boolean => {
	if (tag.length === 0) {
		return false
	}
	for (let i = 0; i < tag.length; i++) {
		const ch = tag.charCodeAt(i)
		const letter = ch >= 0x61 && ch <= 0x7a
		const digit = ch >= 0x30 && ch <= 0x39
		if (!(letter || (digit && i > 0))) {
			return false
		}
	}
	return true
}

/**
 * Internal control flow of the kernel's traversals: thrown deep inside a traversal and caught at the exported
 * boundary, which returns it as a Result failure. It never escapes a kernel function.
 */
export class Refusal extends Error {
	readonly error: CompileError

	constructor(error: CompileError) {
		super()
		this.error = error
	}
}

/** Runs `f`, turning a thrown Refusal into a failure; any other throw is a defect and propagates. */
export const catchRefusal = <A>(f: () => A): Result.Result<A, CompileError> =>
	Result.mapError(Result.catchSignal(Refusal, f), (refusal) => refusal.error)

/**
 * A compile's value, or its CompileError thrown as a Refusal for the catchRefusal around it to return: the inverse of
 * catchRefusal, the one way a step inside a refusal-catching compile reads a Result it cannot go on without.
 */
export const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/**
 * `result`, or, where it is a refusal of another kind and the compile met unrepresentable keys before it, `met`, the
 * refusal naming those keys in its place: the compile met them first. A refusal of keys already names every key met
 * before it, its ledger having started from them (KeyLedger), so it stands as it is.
 */
export const metFirst = <A>(
	met: ReadonlyArray<KeyRefusal>,
	result: Result.Result<A, CompileError>
): Result.Result<A, CompileError> =>
	result.ok || !isNonEmpty(met) || result.error.reason._tag === "UnrepresentableKey"
		? result
		: Result.err(unrepresentableKeys(met))

/**
 * A compile's end: its value where it met no unrepresentable key, else the one refusal naming every key it met, `met`,
 * in the order it met them, or a refusal that stopped it first as metFirst reads it.
 */
export const settled = <A>(
	met: ReadonlyArray<KeyRefusal>,
	result: Result.Result<A, CompileError>
): Result.Result<A, CompileError> => {
	const first = metFirst(met, result)
	return first.ok && isNonEmpty(met) ? Result.err(unrepresentableKeys(met)) : first
}

/**
 * The unrepresentable keys a compile has met, in the order it met them (core/errors.ts KeyRefusal). A check that finds a
 * key or index whose entry no index holds refuses it here and its stage goes on as though the entry fitted, so one
 * compile meets every such key and refuses once, naming them all, where it ends (`settled`), or where a refusal of
 * another kind stops it first, which the keys met before it stand in for (`metFirst`). A stage's ledger starts from the
 * keys the stages before it met, which their values carry (schema/own.ts Owned and laws/model/model.ts LawModel
 * `unrepresentable`), and its own value carries them on with its own.
 */
export class KeyLedger {
	readonly #met: Array<KeyRefusal>

	constructor(earlier: ReadonlyArray<KeyRefusal>) {
		this.#met = [...earlier]
	}

	/**
	 * Records `key`, whose entry no index holds; the caller goes on as though it fitted. A key is met once for each of its
	 * faults: one the ledger holds under the same subject over the same fields for the same fault, which two plans of one
	 * index judge alike (a fold's accumulator on each axis that carries it), is that key, and the refusal names it once;
	 * one refused for another fault is another refusal, as a lookup's two texts of no bound, each undigested, are two
	 * faults of its one key, where the ledger named the first alone.
	 */
	refuse(key: KeyRefusal): void {
		if (
			!this.#met.some(
				(k) =>
					k.subject === key.subject &&
					sameContent(k.key, key.key) &&
					sameContent(k.fault, key.fault)
			)
		) {
			this.#met.push(key)
		}
	}

	/** Every key met so far, in the order met. */
	met(): ReadonlyArray<KeyRefusal> {
		return [...this.#met]
	}

	/** A stage's `result`, run over this ledger, as metFirst reads it against every key met by its end. */
	first<A>(result: Result.Result<A, CompileError>): Result.Result<A, CompileError> {
		return metFirst(this.met(), result)
	}

	/** A compile's `result`, run over this ledger, settled against every key met by its end. */
	settle<A>(result: Result.Result<A, CompileError>): Result.Result<A, CompileError> {
		return settled(this.met(), result)
	}
}

/**
 * Runs a public builder, which throws its CompileError to the JavaScript caller (schema(...), relation(...), the
 * query builder), turning that throw or a kernel Refusal into a failure; any other throw is a defect and propagates.
 */
export const catchCompileError = <A>(f: () => A): Result.Result<A, CompileError> => {
	try {
		return Result.ok(f())
	} catch (caught) {
		if (caught instanceof Refusal) {
			return Result.err(caught.error)
		}
		if (isCompileError(caught)) {
			return Result.err(caught)
		}
		throw caught
	}
}

/** A value the caller built that has no canonical form: the caller's description is malformed at `path`. */
const refuseValue = (path: Path, what: string): never => {
	throw new Refusal(malformedDescription(SourceLoc("canonical value", path), what))
}

/** Canonical text read back that no encoding wrote: the artifact is malformed at `path`. */
const refuseText = (path: Path, what: string): never => {
	throw new Refusal(malformedArtifact("canonical", path, what))
}

const escapeString = (value: string): string => (value.startsWith("~") ? `~${value}` : value)

const wellFormedText = "well-formed Unicode text"

/**
 * Refuses a string or object key with a lone surrogate (RFC 8785 section 3.2.2.2). Checked in both directions, so a
 * text that could not have been encoded never decodes.
 */
const checkText = (
	text: string,
	path: Path,
	refusal: (path: Path, what: string) => never
): void => {
	if (!text.isWellFormed()) {
		refusal(path, wellFormedText)
	}
}

/** The path of a traversal's root: no step from it. */
const rootPath: Path = []

/** refuse, typed so that control flow analysis knows a call to it does not return. */
const stop: (path: Path, capability: string) => never = refuseValue

/**
 * A canonical value that is an object, as canonicalOf reads it: a vector, a Float32Array's components copied out of it
 * through its internal slots, so no method a subclass overrides runs, each finite and -0 held as 0, beside the tagged
 * value its text is (vectorTag, "[c1,...,cn]", each component the text of the number it is, which reads back as exactly
 * that binary32 value); a number that is not finite, by the word naming it, beside the tagged value its text is
 * (floatTag and that word); a value implementing the protocol, beside the tag and payload its method returned; an
 * array; or a plain record, whose prototype is Object's or none and which holds no symbol key.
 */
export type CanonicalObject =
	| {
			readonly kind: "vector"
			readonly components: Float32Array
			readonly tagged: TaggedValue
	  }
	| { readonly kind: "floatSpecial"; readonly name: FloatSpecialName; readonly tagged: TaggedValue }
	| { readonly kind: "tagged"; readonly value: object; readonly tagged: TaggedValue }
	| { readonly kind: "array"; readonly items: ReadonlyArray<unknown> }
	| { readonly kind: "record"; readonly record: Readonly<Record<string, unknown>> }

/** A value outside the canonical model, beside what the model holds in its place. */
export interface Outside {
	readonly kind: "outside"
	readonly value: unknown
	readonly what: string
}

/**
 * A value of the canonical model, by its kind: well-formed text, a finite number, a boolean and a bigint are each its
 * own variant, and every other value of the model, a number that is not finite among them, is a CanonicalObject.
 */
export type CanonicalValue = string | number | boolean | bigint | CanonicalObject

const outside = (value: unknown, what: string): Outside => ({ kind: "outside", value, what })

/** A Float32Array read as a vector (CanonicalObject), or outside the model where a component is not finite. */
const vectorOf = (buffer: Float32Array): CanonicalObject | Outside => {
	const components = new Float32Array(buffer)
	const texts: Array<string> = []
	for (const [i, x] of components.entries()) {
		if (!Number.isFinite(x)) {
			return outside(buffer, "a Float32Array of finite components")
		}
		components[i] = x === 0 ? 0 : x
		texts.push(String(x))
	}
	return { kind: "vector", components, tagged: { tag: vectorTag, payload: `[${texts.join(",")}]` } }
}

/**
 * A value implementing the protocol read with the tag and payload its method returned, or outside the model where the
 * tag is no tag name, is a tag the kernel reads itself ("n", "f"), or the payload is no well-formed text.
 */
const protocolOf = (value: object, tagged: TaggedValue): CanonicalObject | Outside =>
	!isTagName(tagged.tag) || tagged.tag === bigintTag || tagged.tag === floatTag
		? outside(value, `a valid canonical tag, not "${tagged.tag}"`)
		: tagged.payload.isWellFormed()
			? { kind: "tagged", value, tagged }
			: outside(value, wellFormedText)

/**
 * A plain record read as one, or outside the model where its prototype is neither Object's nor none, or it holds a
 * symbol key.
 */
const recordOf = (value: Readonly<Record<string, unknown>>): CanonicalObject | Outside => {
	const proto: unknown = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) {
		return outside(value, "a plain object")
	}
	return Object.getOwnPropertySymbols(value).length > 0
		? outside(value, "an object without symbol keys")
		: { kind: "record", record: value }
}

/**
 * A stand-in read as the member it stands for (standInTag), through every stand-in that member is in turn; outside the
 * model where one names no member it holds, or the chain returns to a stand-in already read.
 */
const standInOf = (value: object): CanonicalValue | Outside => {
	const read = new Set<object>()
	let at: unknown = value
	while (isRecord(at) && standInTag in at) {
		if (read.has(at)) {
			return outside(value, "a stand-in for a member, not for itself")
		}
		read.add(at)
		const key: unknown = at[standInTag]
		if (typeof key !== "string" || !Object.hasOwn(at, key)) {
			return outside(value, "a stand-in naming a member it holds")
		}
		at = at[key]
	}
	return canonicalOf(at)
}

/**
 * An object read by its kind: a Float32Array as a vector, whatever else it holds; a stand-in as the member it stands
 * for; a value whose method returns a tag and a payload as one implementing the protocol, and one whose method returns
 * anything else as a forgery outside the model; an array; and any other object as a plain record, or outside the
 * model. A record whose prototype is Object's or none and which holds no symbol of its own is read by those facts
 * alone (plainRecordOf), the one reading the checks below give it, each made once for the record.
 */
const objectOf = (value: Readonly<Record<string, unknown>>): CanonicalValue | Outside =>
	plainRecordOf(value) ?? kindOf(value)

/** An object read by the checks in their order (objectOf). */
const kindOf = (value: Readonly<Record<string, unknown>>): CanonicalValue | Outside => {
	if (value instanceof Float32Array) {
		return vectorOf(value)
	}
	if (standInTag in value) {
		return standInOf(value)
	}
	if (canonicalTag in value) {
		const method: unknown = value[canonicalTag]
		if (typeof method === "function") {
			const tagged = admitTaggedValue(Reflect.apply(method, value, []))
			return tagged === undefined
				? outside(value, "a canonical tag and payload")
				: protocolOf(value, tagged)
		}
	}
	return isList(value) ? { kind: "array", items: value } : recordOf(value)
}

/**
 * A plain record read as one where its prototype is Object's or none and it holds no symbol of its own, and neither
 * prototype holds the stand-in's or the protocol's symbol: no Float32Array has such a prototype, so the checks of
 * kindOf, in their order, read it as that record; undefined for any other object, which kindOf reads.
 */
const plainRecordOf = (value: Readonly<Record<string, unknown>>): CanonicalObject | undefined => {
	if (isList(value)) {
		return undefined
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return (proto === null || (proto === Object.prototype && !plainPrototypeTagged())) &&
		Object.getOwnPropertySymbols(value).length === 0
		? { kind: "record", record: value }
		: undefined
}

/** Whether Object's prototype holds the stand-in's or the protocol's symbol, which every plain record would inherit. */
const plainPrototypeTagged = (): boolean =>
	standInTag in Object.prototype || canonicalTag in Object.prototype

/** A number read by the canonical model: a finite one but -0 as itself, and NaN, an infinity or -0 by the word naming
 * it. */
const numberOf = (x: number): number | CanonicalObject => {
	const name = floatSpecialNameOf(x)
	return name === undefined
		? x
		: { kind: "floatSpecial", name, tagged: { tag: floatTag, payload: name } }
}

/**
 * The one reading of a value by the canonical model (CanonicalValue), or outside it, with what the model holds in its
 * place: text that is not well-formed (a lone UTF-16 surrogate), null, undefined, a function, a symbol, a vector with a
 * component that is not finite, which pgvector refuses (scalar/values/vector.ts), a forged or misnamed protocol value,
 * and an object that is no plain record. A stand-in (standInTag) is read as the member it stands for. Every number is
 * in the model, as float8 holds every one. Every traversal of the model, and every reader of a value by it, dispatches
 * on this reading, so no kind of the model is read anywhere but here.
 */
export const canonicalOf = (value: unknown): CanonicalValue | Outside => {
	switch (typeof value) {
		case "string":
			return value.isWellFormed() ? value : outside(value, wellFormedText)
		case "number":
			return numberOf(value)
		case "boolean":
		case "bigint":
			return value
		case "object":
			return isRecord(value) ? objectOf(value) : outside(value, "a value, not null")
		case "undefined":
		case "function":
		case "symbol":
			return outside(value, `a canonical value, not ${typeof value}`)
	}
}

/** A reading of values by the canonical model: canonicalOf, or transportedOf. */
type Reading = (value: unknown) => CanonicalValue | Outside

/**
 * A value as a Description's JSON form reads it (transportJson): a stand-in as itself, a record of its own members,
 * from which a decode restores it (ir/desc.ts decodeDesc), and every other value as the canonical model reads it. The
 * form is what crosses a process boundary and is read back as the Description it was; every text, digest and artifact
 * of a value is the canonical model's, which reads a stand-in as its member.
 */
const transportedOf = (value: unknown): CanonicalValue | Outside =>
	isRecord(value) && standInTag in value && !isList(value)
		? { kind: "record", record: value }
		: canonicalOf(value)

/** The pairs of members two canonical objects hold one text exactly when they hold, or undefined where they cannot. */
type MemberPairs = ReadonlyArray<readonly [unknown, unknown]> | undefined

/** The member of a record under one of its keys as a text holds it, read as memberOf reads it; undefined where the
 * text holds none: the member is not stated, or `leftOut` leaves it out. */
const heldMember = (
	record: Readonly<Record<string, unknown>>,
	key: string,
	leftOut: OmitRule
): unknown => {
	const member = memberOf(record[key])
	return member === undefined || leftOut(key, member) ? undefined : member
}

/**
 * A Map or a Set as a comparison reads it where its reading holds collections (`collectedOf`): its entries, each a
 * [key, value] pair, or its members, in their order. No canonical text holds one, so no traversal writes one.
 */
interface Collection {
	readonly kind: "collection"
	readonly of: "map" | "set"
	readonly items: ReadonlyArray<unknown>
}

/** What a comparison reads an object as: the canonical model's object, a collection, or a value outside the model. */
type Compared = CanonicalObject | Collection | Outside

/**
 * A value as a reader that rebuilds Maps and Sets holds it (served/json.ts): a Map's entries and a Set's members in
 * their order (Collection), every other value as the canonical model reads it (canonicalOf).
 */
const collectedOf = (value: unknown): CanonicalValue | Collection | Outside =>
	value instanceof Map
		? { kind: "collection", of: "map", items: [...value] }
		: value instanceof Set
			? { kind: "collection", of: "set", items: [...value] }
			: canonicalOf(value)

/**
 * The tagged value a canonical object is written as: a vector's, a non-finite number's or a protocol value's; undefined
 * for any other.
 */
const writtenTag = (read: Compared): TaggedValue | undefined => {
	switch (read.kind) {
		case "vector":
		case "floatSpecial":
		case "tagged":
			return read.tagged
		case "array":
		case "record":
		case "collection":
		case "outside":
			return undefined
	}
}

/** The items of two arrays of one length, pair by pair; undefined for arrays of two lengths. */
const itemPairs = (x: ReadonlyArray<unknown>, y: ReadonlyArray<unknown>): MemberPairs =>
	x.length === y.length ? x.map((item, i) => [item, y[i]] as const) : undefined

/**
 * The members of two records a text holds under one set of keys, key by key, each as the text holds it (heldMember);
 * undefined for records whose texts hold two sets of keys.
 */
const recordPairs = (
	x: Readonly<Record<string, unknown>>,
	y: Readonly<Record<string, unknown>>,
	leftOut: OmitRule
): MemberPairs => {
	const pairs: Array<readonly [unknown, unknown]> = []
	for (const key of Object.keys(x)) {
		const member = heldMember(x, key, leftOut)
		if (member === undefined) {
			continue
		}
		const other = Object.hasOwn(y, key) ? heldMember(y, key, leftOut) : undefined
		if (other === undefined) {
			return undefined
		}
		pairs.push([member, other])
	}
	let held = 0
	for (const key of Object.keys(y)) {
		if (heldMember(y, key, leftOut) !== undefined) {
			held++
		}
	}
	return held === pairs.length ? pairs : undefined
}

/**
 * What two canonical objects hold one text exactly when, a record's members as `leftOut` leaves them: a vector, a
 * non-finite number or a protocol value beside any of one tag and payload, nothing more; two arrays, their items; two
 * records, their members; two collections of one kind, their items in order; and never a value outside the model.
 */
const memberPairs = (x: Compared, y: Compared, leftOut: OmitRule): MemberPairs => {
	switch (x.kind) {
		case "vector":
		case "floatSpecial":
		case "tagged": {
			const other = writtenTag(y)
			return other !== undefined && other.tag === x.tagged.tag && other.payload === x.tagged.payload
				? []
				: undefined
		}
		case "array":
			return y.kind === "array" ? itemPairs(x.items, y.items) : undefined
		case "record":
			return y.kind === "record" ? recordPairs(x.record, y.record, leftOut) : undefined
		case "collection":
			return y.kind === "collection" && y.of === x.of ? itemPairs(x.items, y.items) : undefined
		case "outside":
			return undefined
	}
}

/**
 * Whether two values have one text under the members `leftOut` leaves out, read by walking both at once and writing
 * neither, each value read by the canonical model (canonicalOf). A scalar is itself, a finite number its value, -0
 * being 0; NaN, an infinity, a vector or a value implementing the protocol its tag and payload, so NaN is the same as
 * NaN; a list its items in order; a record its members by key in any order, a member the text leaves out left out here;
 * and a value outside the model, which no text holds, the same as nothing but itself. One value met twice is one value
 * at once, so a value is read only where it differs from the other. The pairs still to compare wait on a stack on the
 * heap, so no depth of value deepens the call stack.
 */
export const sameUnder = (leftOut: OmitRule): ((a: unknown, b: unknown) => boolean) =>
	sameBy(canonicalOf, leftOut)

/** Whether two values are one under `reading` and `leftOut` (sameUnder), each pair read once as it is met. */
const sameBy =
	(reading: (value: unknown) => CanonicalValue | Collection | Outside, leftOut: OmitRule) =>
	(a: unknown, b: unknown): boolean => {
		const pending: Array<readonly [unknown, unknown]> = [[a, b]]
		for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
			const [x, y] = pair
			if (x === y) {
				continue
			}
			const readX = reading(x)
			const readY = reading(y)
			const pairs =
				typeof readX === "object" && typeof readY === "object"
					? memberPairs(readX, readY, leftOut)
					: undefined
			if (pairs === undefined) {
				return false
			}
			appendAll(pending, pairs)
		}
		return true
	}

/**
 * Whether two values a builder made have one semantic identity: whether the texts withoutSourceLocs writes of them are
 * one text (sameUnder).
 */
export const sameContent: (a: unknown, b: unknown) => boolean = sameUnder(omitSourceLocs)

/**
 * Canonical equality, the one structural identity of the values the compiler owns: whether two values have one
 * canonical text of every property (canonicalTextOf), read by walking both at once rather than writing two texts to
 * compare (sameUnder), so it stops at their first difference and writes nothing.
 */
export const canonicalEquals: (a: unknown, b: unknown) => boolean = sameUnder(() => false)

/**
 * Canonical equality of values a reader rebuilt with Maps and Sets (served/json.ts servedFile): a Map and a Set are one
 * of their kind with the same entries or members in order (Collection), every other value one as canonicalEquals holds
 * it, so the one structural identity reads them too.
 */
export const collectedEquals: (a: unknown, b: unknown) => boolean = sameBy(collectedOf, () => false)

/** A container of a canonical value: an array, or a plain record. */
type ContainerKind = "array" | "object"

/**
 * What one canonical traversal writes a value's form to, in the order of its canonical text: a scalar's JSON value (a
 * string already escaped, a finite number with no negative zero, a boolean), a container's opening, each record
 * member's key before its value, and a container's closing. Walk states every check once; a sink only assembles, so a
 * value's text, its tokens and its JSON form are one traversal's.
 */
interface Sink {
	scalar(value: string | number | boolean): void
	open(kind: ContainerKind): void
	key(key: string): void
	close(kind: ContainerKind): void
}

/**
 * A container a traversal is writing, with the index of its next member: an array, read by index; a plain record, read
 * by its keys in canonical order; or the record Walk.over writes, whose members `written` holds are written from their
 * texts by `write` rather than read.
 */
type Frame =
	| { readonly kind: "array"; readonly value: ReadonlyArray<unknown>; next: number }
	| {
			readonly kind: "object"
			readonly value: Readonly<Record<string, unknown>>
			readonly keys: ReadonlyArray<string>
			next: number
	  }
	| {
			readonly kind: "over"
			readonly value: Readonly<Record<string, unknown>>
			readonly keys: ReadonlyArray<string>
			next: number
			readonly written: ReadonlyMap<string, WellFormedText>
			readonly write: (text: WellFormedText) => void
	  }

/**
 * Containers a traversal writes from texts written before rather than reading them again (writeCanonicalCarrying):
 * each frozen container `texts` holds by the container has that canonical text under the traversal's options, which
 * `write` writes where the container stands. A frozen container's text is its content's for as long as it lives, and
 * it was written whole, so nothing in it is refused or reaches a container outside it.
 */
interface Carried {
	readonly texts: ReadonlyMap<object, WellFormedText>
	readonly write: (text: WellFormedText) => void
}

/** What a traversal carries where it reads every container: nothing. */
const nothingCarried: Carried = { texts: new Map(), write: () => undefined }

/**
 * One canonical traversal: every check, in one order, with one refusal each, and the value's canonical form written
 * to its sink as it is read. Every container read is opened onto a stack of frames on the heap, where its members wait
 * while one of them is read, so a value nested to any depth never deepens the call stack. Keys are visited in the
 * order Object.keys() sorted gives, the UTF-16 code unit order canonical text sorts by. The containers on the path
 * from the root are its ancestors, so a container that holds itself is refused as a cycle, while one that two others
 * share is read once under each. A traversal is used once: a refusal ends it, so its path and ancestors are never read
 * again after one.
 */
class Walk {
	/** The path of the value the traversal begins at: none for a root, a record's key for its member (`member`). */
	readonly #base: Path
	readonly #ancestors = new Set<object>()
	readonly #frames: Array<Frame> = []
	readonly #options: EncodeOptions
	readonly #sink: Sink
	/** How the traversal reads a value: the canonical model's reading (canonicalOf), or a JSON form's (transportedOf). */
	readonly #reading: Reading
	/** The containers written from their texts rather than read (Carried). */
	readonly #carried: Carried

	constructor(options: EncodeOptions, sink: Sink, reading: Reading, base: Path, carried: Carried) {
		this.#options = options
		this.#sink = sink
		this.#reading = reading
		this.#base = base
		this.#carried = carried
	}

	/**
	 * The path of the value being read, for a refusal: the base's, then each open container's member being read, an
	 * array's by its index and a record's by its key, each the one before its frame's next. Built only where a refusal
	 * names it, never as a value is read.
	 */
	#here(): Path {
		const path: Array<string | number> = [...this.#base]
		for (const frame of this.#frames) {
			const at = frame.next - 1
			path.push(
				frame.kind === "array" ? at : defined(frame.keys[at], "a frame's member being read")
			)
		}
		return path
	}

	/** Writes `root`. */
	of(root: unknown): void {
		this.#read(root)
		this.#run()
	}

	/**
	 * Writes `root`, a plain record, each member `written` holds written from its text by `write` where the traversal
	 * would read it, beside which the record's other members are read.
	 */
	over(
		root: unknown,
		written: ReadonlyMap<string, WellFormedText>,
		write: (text: WellFormedText) => void
	): void {
		const read = this.#reading(root)
		if (typeof read !== "object" || read.kind !== "record") {
			return stop(this.#here(), "a plain record")
		}
		this.#ancestors.add(read.record)
		this.#sink.open("object")
		this.#frames.push({
			kind: "over",
			value: read.record,
			keys: keysOf(read.record),
			next: 0,
			written,
			write
		})
		this.#run()
	}

	/**
	 * Writes `value`, a member of `record`, as `over` reads a member of a record it holds no text of: `record` its one
	 * ancestor, under the path the traversal was made with, the member's key (writeIdentityText).
	 */
	member(record: object, value: unknown): void {
		this.#ancestors.add(record)
		this.#read(value)
		this.#run()
	}

	/** Reads the open containers' members until every container is closed. */
	#run(): void {
		const frames = this.#frames
		for (let top = frames[frames.length - 1]; top !== undefined; top = frames[frames.length - 1]) {
			if (top.kind === "array") {
				this.#item(top)
			} else {
				this.#member(top)
			}
		}
	}

	/** An array's next item read, or the array closed after its last. */
	#item(frame: Extract<Frame, { readonly kind: "array" }>): void {
		const i = frame.next
		if (i === frame.value.length) {
			this.#close(frame.value, "array")
			return
		}
		frame.next = i + 1
		const item: unknown = frame.value[i]
		if (item === undefined) {
			stop(this.#here(), "an array element, not a hole")
		}
		this.#read(item)
	}

	/** A record's next member read, or skipped where it is left out, or the record closed after its last. */
	#member(frame: Exclude<Frame, { readonly kind: "array" }>): void {
		const key = frame.keys[frame.next]
		if (key === undefined) {
			this.#close(frame.value, "object")
			return
		}
		frame.next += 1
		const child = memberOf(frame.value[key])
		if (child === undefined || this.#options.omit(key, child)) {
			return
		}
		if (!key.isWellFormed()) {
			stop(this.#here(), wellFormedText)
		}
		this.#sink.key(key)
		if (frame.kind === "over") {
			const text = frame.written.get(key)
			if (text !== undefined) {
				frame.write(text)
				return
			}
		}
		this.#read(child)
	}

	/** The container on top closed: its frame and ancestor left. */
	#close(value: object, kind: ContainerKind): void {
		this.#frames.pop()
		this.#ancestors.delete(value)
		this.#sink.close(kind)
	}

	/**
	 * Reads one value by the canonical model (canonicalOf): a scalar's form is written, and a container is opened onto
	 * the frames, which is true. No reading is undefined, a function or a symbol, so those cases hold none (never).
	 */
	#read(value: unknown): boolean {
		const read = this.#reading(value)
		switch (typeof read) {
			case "string":
			case "number":
			case "boolean":
			case "bigint":
				writeScalar(this.#sink, read)
				return false
			case "object":
				return this.#object(read)
			case "undefined":
			case "function":
			case "symbol":
				return read
		}
	}

	/**
	 * Reads one canonical object: a vector's, a non-finite number's or a protocol value's tagged text is written, and an
	 * array or a record is opened onto the frames, which is true, refused as a cycle where it is one of its own ancestors.
	 */
	#object(read: CanonicalObject | Outside): boolean {
		switch (read.kind) {
			case "vector":
			case "floatSpecial":
			case "tagged":
				writeScalar(this.#sink, read)
				return false
			case "array":
				if (this.#written(read.items)) {
					return false
				}
				this.#enter(read.items)
				this.#sink.open("array")
				this.#frames.push({ kind: "array", value: read.items, next: 0 })
				return true
			case "record":
				if (this.#written(read.record)) {
					return false
				}
				this.#enter(read.record)
				this.#sink.open("object")
				this.#frames.push({
					kind: "object",
					value: read.record,
					keys: keysOf(read.record),
					next: 0
				})
				return true
			case "outside":
				return stop(this.#here(), read.what)
		}
	}

	/** Whether `container` is carried (Carried): its text written where it stands, and it not read. */
	#written(container: object): boolean {
		const text = this.#carried.texts.get(container)
		if (text === undefined) {
			return false
		}
		this.#carried.write(text)
		return true
	}

	/** A container entered as an ancestor of what it holds, refused where it is one already: a cycle. */
	#enter(container: object): void {
		if (this.#ancestors.has(container)) {
			stop(this.#here(), "an acyclic value")
		}
		this.#ancestors.add(container)
	}
}

/** A reading of the canonical model that is no container and no value outside it: what a scalar's text is written of. */
type ScalarReading =
	| string
	| number
	| boolean
	| bigint
	| Extract<CanonicalObject, { readonly kind: "vector" | "floatSpecial" | "tagged" }>

/**
 * A scalar's canonical form written to `sink`, the one spelling every traversal writes it by (Walk, writeIdentityText):
 * a string with its "~" doubled (escapeString), a finite number and a boolean as they are, a bigint as its tagged
 * integer, and a vector, a non-finite number or a protocol value as its tag and payload.
 */
const writeScalar = (sink: Sink, read: ScalarReading): void => {
	switch (typeof read) {
		case "string":
			sink.scalar(escapeString(read))
			return
		case "number":
		case "boolean":
			sink.scalar(read)
			return
		case "bigint":
			sink.scalar(`~${bigintTag}:${read.toString()}`)
			return
		case "object":
			sink.scalar(`~${read.tagged.tag}:${read.tagged.payload}`)
			return
		case "undefined":
		case "function":
		case "symbol":
			return read
	}
}

/** A canonical object that is a container: an array, or a plain record (writeIdentityText). */
export type CanonicalContainer = Extract<CanonicalObject, { readonly kind: "array" | "record" }>

/** Whether a reading of the canonical model is a container (CanonicalContainer). */
export const isCanonicalContainer = (read: CanonicalValue | Outside): read is CanonicalContainer =>
	typeof read === "object" && (read.kind === "array" || read.kind === "record")

/**
 * How an identity text (writeIdentityText) takes and writes the token of each container it holds: a container's token
 * is the one taken for it before (`known`), or taken from its own identity text, written whole into the writer just
 * before (`written`), since a token's message is hashed in the same writer as every other (core/fingerprint.ts
 * IdentityDigests); and it is written where the container stands.
 */
export interface ContainerTokens<T> {
	readonly known: (member: CanonicalContainer) => T | undefined
	readonly written: (member: CanonicalContainer) => T
	readonly write: (out: Utf8Writer, token: T) => void
}

/**
 * A container's identity text under `options` written into `out` (core/fingerprint.ts IdentityDigests): its canonical
 * text with each container it holds written as its token (`tokens`), each scalar as `encode` writes it. The tokens are
 * taken first, a member at a time, in the order the text is written in (an array's items, a record's keys in canonical
 * order), a member whose token was never taken having its own identity text written first and its token taken from it;
 * then `before` writes what precedes the text (a digest's frame), and the text is written. A member outside the
 * canonical model is refused as `encode` refuses it: an array's item as the root of its own text, where its token would
 * stand (path []), a record's member under its key; so is a container that holds itself, a cycle. A member left out by
 * `options` is neither taken nor written. Throws its Refusal, for the catchRefusal around the digest.
 *
 * The containers whose texts are pending are a stack on the heap (Pending), each read up to its first member whose
 * token is not yet taken, that member's text written before its holder's reading goes on, so a container's depth costs
 * the heap one entry and the call stack nothing, where a recursion through each member's token took several frames a
 * level and ran out of stack within a few hundred levels under a small one.
 */
export const writeIdentityText = <T>(
	out: Utf8Writer,
	container: CanonicalContainer,
	options: EncodeOptions,
	tokens: ContainerTokens<T>,
	before: (out: Utf8Writer) => void
): void => {
	const pending: Array<Pending<T>> = [pendingOf(container)]
	/** The containers whose texts are pending, each an ancestor of the next: one met again among them is a cycle. */
	const open = new Set<object>([heldOf(container)])
	for (;;) {
		const top = defined(pending.at(-1), "a pending container")
		const member = readPending(top, options, tokens)
		if (member !== undefined) {
			const held = heldOf(member)
			if (open.has(held)) {
				refuseValue(pathOfNext(top), "an acyclic value")
			}
			open.add(held)
			pending.push(pendingOf(member))
			continue
		}
		pending.pop()
		open.delete(heldOf(top.read))
		const holder = pending.at(-1)
		if (holder === undefined) {
			before(out)
			writePending(out, top, options, tokens)
			return
		}
		writePending(out, top, options, tokens)
		takeToken(holder, top.read, tokens.written(top.read))
	}
}

/**
 * A container whose identity text is pending, its members read in its text's order up to the first whose token is not
 * yet taken: each read member's token, where it is a container written as one, and otherwise its reading. As many
 * members are read as tokens are held, so the next to read is at `taken.length`.
 */
type Pending<T> = PendingArray<T> | PendingRecord<T>

interface PendingArray<T> {
	readonly kind: "array"
	readonly read: Extract<CanonicalContainer, { readonly kind: "array" }>
	readonly taken: Array<T | undefined>
	readonly scalars: Array<ScalarReading | undefined>
}

interface PendingRecord<T> {
	readonly kind: "record"
	readonly read: Extract<CanonicalContainer, { readonly kind: "record" }>
	/** The record's keys in canonical order (keysOf), read once for its tokens and then for its text. */
	readonly keys: ReadonlyArray<string>
	/** Each member's reading as the text holds it (memberOf), undefined where it holds none: unstated, or left out. */
	readonly reads: Array<CanonicalValue | Outside | undefined>
	readonly taken: Array<T | undefined>
}

const pendingOf = <T>(read: CanonicalContainer): Pending<T> =>
	read.kind === "array"
		? { kind: "array", read, taken: [], scalars: [] }
		: { kind: "record", read, keys: keysOf(read.record), reads: [], taken: [] }

/** The object a container reading reads: an array's items, or a record. */
const heldOf = (read: CanonicalContainer): object =>
	read.kind === "array" ? read.items : read.record

/** Where the next member of a pending container is refused: an array's item at the root of its own text, a record's under its key. */
const pathOfNext = <T>(p: Pending<T>): Path =>
	p.kind === "array" ? [] : [keyAt(p.keys, p.taken.length)]

/** The token of the member a pending container stopped at, taken from its text: the member read, the next one next. */
const takeToken = <T>(p: Pending<T>, member: CanonicalContainer, token: T): void => {
	if (p.kind === "array") {
		p.taken.push(token)
		p.scalars.push(undefined)
	} else {
		p.reads.push(member)
		p.taken.push(token)
	}
}

/** A pending container's members read on, to the first container whose token is not yet taken; undefined at its end. */
const readPending = <T>(
	p: Pending<T>,
	options: EncodeOptions,
	tokens: ContainerTokens<T>
): CanonicalContainer | undefined =>
	p.kind === "array" ? readItems(p, tokens) : readMembers(p, options, tokens)

/** An array's items read on (readPending): a container by its token, a scalar by its reading, one outside refused. */
const readItems = <T>(
	p: PendingArray<T>,
	tokens: ContainerTokens<T>
): CanonicalContainer | undefined => {
	const items = p.read.items
	for (let i = p.taken.length; i < items.length; i++) {
		const item: unknown = items[i]
		const read = canonicalOf(item)
		if (typeof read !== "object") {
			p.taken.push(undefined)
			p.scalars.push(read)
			continue
		}
		switch (read.kind) {
			case "array":
			case "record": {
				const token = tokens.known(read)
				if (token === undefined) {
					return read
				}
				p.taken.push(token)
				p.scalars.push(undefined)
				continue
			}
			case "outside":
				return refuseValue([], item === undefined ? "a value, not undefined" : read.what)
			case "vector":
			case "floatSpecial":
			case "tagged":
				p.taken.push(undefined)
				p.scalars.push(read)
				continue
		}
	}
	return undefined
}

/**
 * A record's members read on (readPending), in canonical order: a member the text holds as it stands and that is a
 * container by its token, any other by its reading, written as Walk.over writes it.
 */
const readMembers = <T>(
	p: PendingRecord<T>,
	options: EncodeOptions,
	tokens: ContainerTokens<T>
): CanonicalContainer | undefined => {
	const record = p.read.record
	for (let at = p.taken.length; at < p.keys.length; at++) {
		const key = keyAt(p.keys, at)
		const member: unknown = record[key]
		const child = memberOf(member)
		if (child === undefined || options.omit(key, child)) {
			p.reads.push(undefined)
			p.taken.push(undefined)
			continue
		}
		const read = canonicalOf(child)
		if (child === member && isCanonicalContainer(read)) {
			const token = tokens.known(read)
			if (token === undefined) {
				return read
			}
			p.reads.push(read)
			p.taken.push(token)
			continue
		}
		p.reads.push(read)
		p.taken.push(undefined)
	}
	return undefined
}

/** A pending container's text, every member read: an array's or a record's. */
const writePending = <T>(
	out: Utf8Writer,
	p: Pending<T>,
	options: EncodeOptions,
	tokens: ContainerTokens<T>
): void => {
	if (p.kind === "array") {
		writeIdentityArray(out, p, tokens)
	} else {
		writeIdentityRecord(out, p, options, tokens)
	}
}

/**
 * An array's identity text (writeIdentityText): "[", each item's token or scalar text after a comma from the second,
 * and "]", hashed as it is written and never built, so no length bounds it (ByteSink).
 */
const writeIdentityArray = <T>(
	out: Utf8Writer,
	p: PendingArray<T>,
	tokens: ContainerTokens<T>
): void => {
	const { taken, scalars } = p
	out.ascii("[")
	for (let i = 0; i < taken.length; i++) {
		if (i > 0) {
			out.ascii(",")
		}
		const token = taken[i]
		if (token !== undefined) {
			tokens.write(out, token)
		} else {
			writeScalar(
				new ByteSink(out),
				defined(scalars[i], "an item that is no container is a scalar")
			)
		}
	}
	out.ascii("]")
}

/**
 * A record's identity text (writeIdentityText): `encode`'s text of it, each member a token was taken for written as
 * that token, as Walk.over writes it, hashed as it is written and never built, so no length bounds it (ByteSink).
 */
const writeIdentityRecord = <T>(
	out: Utf8Writer,
	p: PendingRecord<T>,
	options: EncodeOptions,
	tokens: ContainerTokens<T>
): void => {
	const { keys, reads, taken } = p
	const record = p.read.record
	const sink = new ByteSink(out)
	sink.open("object")
	for (let at = 0; at < keys.length; at++) {
		const read = reads[at]
		if (read === undefined) {
			continue
		}
		const key = keyAt(keys, at)
		checkText(key, [key], refuseValue)
		sink.key(key)
		const token = taken[at]
		if (token !== undefined) {
			sink.token(tokens.write, token)
			continue
		}
		if (
			typeof read !== "object" ||
			read.kind === "vector" ||
			read.kind === "floatSpecial" ||
			read.kind === "tagged"
		) {
			writeScalar(sink, read)
		} else if (read.kind === "outside") {
			refuseValue([key], read.what)
		} else {
			new Walk(options, sink, canonicalOf, [key], nothingCarried).member(
				record,
				memberOf(record[key])
			)
		}
	}
	sink.close("object")
}

/**
 * A plain record's keys in canonical order, by UTF-16 code unit (core/order.ts compareStrings): the array Object.keys
 * gives sorted in place by heapsort (sortKeys), where Array.prototype.sort copies the keys into a work array of its own
 * for each record it sorts.
 */
const keysOf = (record: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
	const keys = Object.keys(record)
	sortKeys(keys)
	return keys
}

/**
 * Distinct keys sorted in place by UTF-16 code unit (compareStrings): heapsort (J. W. J. Williams, "Algorithm 232: Heapsort", CACM 7(6),
 * 1964), its heap built bottom-up (R. W. Floyd, "Algorithm 245: Treesort 3", CACM 7(12), 1964), n log n comparisons at
 * most and nothing allocated. Keys are distinct, so no order of equals is asked of it, and heapsort is not stable.
 */
const sortKeys = (keys: Array<string>): void => {
	for (let at = (keys.length >> 1) - 1; at >= 0; at--) {
		siftDown(keys, at, keys.length)
	}
	for (let end = keys.length - 1; end > 0; end--) {
		swapKeys(keys, 0, end)
		siftDown(keys, 0, end)
	}
}

/** The heap below `root`, within the keys before `end`, made a max-heap again: the root's key sunk below every greater. */
const siftDown = (keys: Array<string>, root: number, end: number): void => {
	for (let at = root; ;) {
		let child = 2 * at + 1
		if (child >= end) {
			return
		}
		if (child + 1 < end && compareStrings(keyAt(keys, child), keyAt(keys, child + 1)) < 0) {
			child += 1
		}
		if (compareStrings(keyAt(keys, at), keyAt(keys, child)) > 0) {
			return
		}
		swapKeys(keys, at, child)
		at = child
	}
}

/** The key at a place a sort reads, which is below the keys' length. */
const keyAt = (keys: ReadonlyArray<string>, at: number): string =>
	defined(keys[at], "a sort reads a place below the keys' length")

/** The keys at two places of a sort exchanged. */
const swapKeys = (keys: Array<string>, a: number, b: number): void => {
	const held = keyAt(keys, a)
	keys[a] = keyAt(keys, b)
	keys[b] = held
}

/**
 * A container whose JSON form is being assembled, with the key it is a member under when the container it is written
 * in is a record: an array's items, or a record's members.
 */
type Assembly =
	| { readonly kind: "array"; readonly under: string; readonly items: Array<Json> }
	| {
			readonly kind: "object"
			readonly under: string
			readonly members: Array<readonly [string, Json]>
	  }

/**
 * The sink that assembles the JSON form. An object is built from its members at once (Object.fromEntries), which
 * defines each key as its own property, so "__proto__" stays an ordinary key and never reaches the prototype accessor.
 */
class JsonSink implements Sink {
	/** The root's form, once written. */
	readonly #root: Array<Json> = []
	readonly #open: Array<Assembly> = []
	/** The key of the record member being written. */
	#key = ""

	/** The form of the value written. */
	value(): Json {
		const [root] = this.#root
		return defined(root, "a canonical traversal writes its root")
	}

	scalar(value: string | number | boolean): void {
		this.#add(value, this.#key)
	}

	open(kind: ContainerKind): void {
		this.#open.push(
			kind === "array"
				? { kind, under: this.#key, items: [] }
				: { kind, under: this.#key, members: [] }
		)
	}

	key(key: string): void {
		this.#key = key
	}

	close(): void {
		const done = defined(this.#open.pop(), "a container the traversal opened")
		this.#add(done.kind === "array" ? done.items : Object.fromEntries(done.members), done.under)
	}

	#add(value: Json, key: string): void {
		const top = this.#open.at(-1)
		if (top === undefined) {
			this.#root.push(value)
		} else if (top.kind === "array") {
			top.items.push(value)
		} else {
			top.members.push([key, value])
		}
	}
}

const canonicalTextLoc = SourceLoc("canonical text", [])

/**
 * The sink that writes the canonical text's UTF-8 into a byte writer (grizzle-text Utf8Writer) as it is read: each
 * scalar's and key's JSON literal (Utf8Writer.jsonString, jsonNumber, the ASCII of a boolean), its punctuation and the
 * canonical texts Walk.over writes, each byte written once, in place, with no string built.
 *
 * Its text is never built, so no length bounds it: its bytes stream into a hash (core/fingerprint.ts, a digest, an
 * identity digest) or a template's kept bytes (TemplateSink), and V8's longest string bounds a string that is built
 * (TextSink, boundCanonicalText), never one that is hashed. Each scalar it writes is a string that already exists, so it
 * is within that bound already; a digest over a canonical text longer than any string V8 builds is a digest like any
 * other, where a bound here refused a snapshot's content fingerprint past it (deploy/snapshot/build.ts
 * snapshotFingerprint, metis's installation).
 */
class ByteSink implements Sink {
	readonly #out: Utf8Writer
	/** Whether a value was written in the container being written, so the next item or member follows a comma. */
	#after = false

	constructor(out: Utf8Writer) {
		this.#out = out
	}

	scalar(value: string | number | boolean): void {
		this.#separate()
		if (typeof value === "string") {
			this.#out.jsonString(value)
		} else if (typeof value === "number") {
			this.#out.jsonNumber(value)
		} else {
			this.#out.ascii(value ? "true" : "false")
		}
		this.#after = true
	}

	/** A value whose canonical text is `text`, written as it is (Walk.over). */
	written(text: WellFormedText): void {
		this.#separate()
		this.#out.text(text)
		this.#after = true
	}

	/** A container's token, written by `write` where the container stands (writeIdentityText). */
	token<T>(write: (out: Utf8Writer, token: T) => void, token: T): void {
		this.#separate()
		write(this.#out, token)
		this.#after = true
	}

	open(kind: ContainerKind): void {
		this.#separate()
		this.#out.ascii(kind === "array" ? "[" : "{")
		this.#after = false
	}

	key(key: string): void {
		this.#separate()
		this.#out.jsonString(key)
		this.#out.ascii(":")
		this.#after = false
	}

	close(kind: ContainerKind): void {
		this.#out.ascii(kind === "array" ? "]" : "}")
		this.#after = true
	}

	#separate(): void {
		if (this.#after) {
			this.#out.ascii(",")
		}
	}

	/**
	 * A hole for a value written apart from this text (writeTemplate): the separator before it, where its text will
	 * stand, and the next member after it.
	 */
	hole(): void {
		this.#separate()
		this.#after = true
	}
}

/**
 * The punctuation a canonical text holds beside its JSON scalars, each proved well-formed once, as the module loads
 * (core/text.ts wellFormed): TypeScript holds a literal as a string.
 */
const punctuation = {
	comma: wellFormed(","),
	colon: wellFormed(":"),
	array: { open: wellFormed("["), close: wellFormed("]") },
	object: { open: wellFormed("{"), close: wellFormed("}") }
} as const

/**
 * Refuses a canonical text of which `written` UTF-16 code units are written past `limit`, V8's longest string in
 * production (maxStringLength), as ResourceBound (stringLengthAtLeast): the text is refused as it is written, so its
 * whole length is at least what it holds when it passes the limit, the one true number it states. The bound is for
 * strings that get built: the writer that builds a canonical text checks it (TextSink), and one that streams it into a
 * hash does not (ByteSink), but for ir/dag-digest.ts DagDigests, whose claimed-form digest refuses where `encode` does.
 */
export const boundCanonicalText = (written: number, limit: number): void => {
	if (written > limit) {
		throw new Refusal(
			resourceBound(canonicalTextLoc, { kind: "stringLengthAtLeast", limit, atLeast: written })
		)
	}
}

/** A well-formed string written into `out` as the canonical text writes a plain string: its "~" doubled, then its JSON
 * literal (escapeString, Utf8Writer.jsonString). */
export const writeCanonicalString = (out: Utf8Writer, text: WellFormedText): void => {
	out.jsonString(escapeString(text))
}

/**
 * The canonical text of a value with holes, as its UTF-8 (writeTemplate): the bytes before, between and after its
 * holes, one piece more than it has holes, each a view of one copy of the text's bytes, so filling the template in
 * copies each piece and allocates nothing; each piece's UTF-16 code units; and each hole's number in text order.
 */
export interface CanonicalTemplate {
	readonly pieces: ReadonlyArray<Uint8Array>
	readonly units: ReadonlyArray<number>
	readonly holes: ReadonlyArray<number>
}

/**
 * The sink that writes a template (writeTemplate): the canonical text's bytes (ByteSink), each scalar string `holeOf`
 * reads as a hole left out of them, the text cut there into a piece.
 */
class TemplateSink implements Sink {
	readonly #out: Utf8Writer
	readonly #sink: ByteSink
	readonly #holeOf: (scalar: string) => number | undefined
	/** Where each hole stands, in bytes and in UTF-16 code units, and its number. */
	readonly #at: Array<number> = []
	readonly #unitsAt: Array<number> = []
	readonly #holes: Array<number> = []

	constructor(holeOf: (scalar: string) => number | undefined) {
		this.#out = keptWriter()
		this.#sink = new ByteSink(this.#out)
		this.#holeOf = holeOf
	}

	scalar(value: string | number | boolean): void {
		const hole = typeof value === "string" ? this.#holeOf(value) : undefined
		if (hole === undefined) {
			this.#sink.scalar(value)
			return
		}
		this.#sink.hole()
		this.#at.push(this.#out.length)
		this.#unitsAt.push(this.#out.units)
		this.#holes.push(hole)
	}

	open(kind: ContainerKind): void {
		this.#sink.open(kind)
	}

	key(key: string): void {
		this.#sink.key(key)
	}

	close(kind: ContainerKind): void {
		this.#sink.close(kind)
	}

	/** The template written: its bytes copied out of the writer once, each piece a view of them. */
	template(): CanonicalTemplate {
		const bytes = this.#out.held().slice()
		const cuts = [0, ...this.#at, bytes.length]
		const unitCuts = [0, ...this.#unitsAt, this.#out.units]
		const pieces: Array<Uint8Array> = []
		const units: Array<number> = []
		for (let k = 0; k + 1 < cuts.length; k++) {
			pieces.push(bytes.subarray(defined(cuts[k], "a cut"), defined(cuts[k + 1], "the next cut")))
			units.push(defined(unitCuts[k + 1], "the next cut") - defined(unitCuts[k], "a cut"))
		}
		return { pieces, units, holes: this.#holes }
	}
}

/**
 * The canonical text under `options` of `value` with a hole for each scalar string `holeOf` reads as one (a string as
 * the sink receives it, its "~" doubled), refused as `encode` refuses it: a text written once and filled in again and
 * again, each hole with a value written into its place (ir/dag-digest.ts DagDigests).
 */
export const writeTemplate = (
	value: unknown,
	options: EncodeOptions,
	holeOf: (scalar: string) => number | undefined
): Result.Result<CanonicalTemplate, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new TemplateSink(holeOf)
		new Walk(options, sink, canonicalOf, rootPath, nothingCarried).of(value)
		return sink.template()
	})

/** A writer whose bytes are all kept, a template's (TemplateSink). */
const keptWriter = (): Utf8Writer => new Utf8Writer({ kind: "grow" })

/**
 * Where a TextSink writes its text (TextOut): one string it builds (grizzle-text WellFormedWriter), which V8's longest
 * string bounds, so the traversal stops with ResourceBound (stringLength) before the text is built past it
 * (`builtText`); or a text's chunks (grizzle-text ChunkWriter), never joined into one string, so no length bounds it
 * (`chunkedText`): an artifact's, which is written to its file a chunk at a time.
 */
interface TextOut {
	readonly length: number
	append(piece: WellFormedText): void
}

/** What bounds a text a TextSink writes, measured before each piece is written: V8's longest string, for a text built. */
type TextBound = (written: number) => void

/**
 * The bound of a text built under a stated `limit` of UTF-16 code units, never past V8's longest string
 * (maxStringLength), which every text a canonical writer builds is held to (`builtText`) and which a smaller limit
 * states for a text of a length a test can afford (encodeWithin).
 */
const builtTextUnder = (limit: number): TextBound => {
	const bound = Math.min(limit, maxStringLength)
	return (written) => boundCanonicalText(written, bound)
}

const builtText: TextBound = builtTextUnder(maxStringLength)

/** A text written as chunks is never built, so no length bounds it. */
const chunkedText: TextBound = () => undefined

/**
 * The sink that writes the canonical text a caller reads, appended to its TextOut as it is read: JSON.stringify's
 * scalars and keys (grizzle-text jsonText), its punctuation and the canonical texts Walk.over writes as they are, each
 * well-formed, so the text is a WellFormedText with no check of it. A text whose bytes are hashed is written as them
 * instead (ByteSink); one a caller reads is the platform's strings, with no bytes to decode. Its bound (TextBound) is
 * its TextOut's: past V8's longest string a text it builds stops with ResourceBound (stringLength), measured before the
 * text is built past it, and its chunks are never built.
 */
class TextSink implements Sink {
	readonly #out: TextOut
	readonly #bound: TextBound
	/** Whether a value was written in the container being written, so the next item or member follows a comma. */
	#after = false

	constructor(out: TextOut, bound: TextBound) {
		this.#out = out
		this.#bound = bound
	}

	scalar(value: string | number | boolean): void {
		this.written(jsonText(value))
	}

	/** A value whose canonical text is `text`, written as it is (Walk.over). */
	written(text: WellFormedText): void {
		this.#write(this.#after, text, false)
		this.#after = true
	}

	open(kind: ContainerKind): void {
		this.#write(this.#after, punctuation[kind].open, false)
		this.#after = false
	}

	key(key: string): void {
		this.#write(this.#after, jsonText(key), true)
		this.#after = false
	}

	close(kind: ContainerKind): void {
		this.#write(false, punctuation[kind].close, false)
		this.#after = true
	}

	/**
	 * `piece` written, after a comma where `comma` says and before a colon where `colon` says, refused together where the
	 * text they make passes its bound, before it is written.
	 */
	#write(comma: boolean, piece: WellFormedText, colon: boolean): void {
		this.#bound(this.#out.length + (comma ? 1 : 0) + piece.length + (colon ? 1 : 0))
		if (comma) {
			this.#out.append(punctuation.comma)
		}
		this.#out.append(piece)
		if (colon) {
			this.#out.append(punctuation.colon)
		}
	}
}

/**
 * The canonical text of `value` under `options` written into `out` as its UTF-8 (ByteSink), after whatever `out` holds:
 * `encode`'s text, for a digest's bytes after its frame, drained into the hash as they are written (fingerprint.ts).
 */
export const writeCanonical = (
	out: Utf8Writer,
	value: unknown,
	options: EncodeOptions
): Result.Result<void, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		new Walk(options, new ByteSink(out), canonicalOf, rootPath, nothingCarried).of(value)
	})

/**
 * writeCanonical's text of `value`, each container `texts` holds written from its text where it stands rather than read
 * again (Carried): the caller's texts of frozen parts many values hold, each written once by `encode` under the same
 * options, so a digest of each value reads its own parts and copies the shared ones' text.
 */
export const writeCanonicalCarrying = (
	out: Utf8Writer,
	value: unknown,
	options: EncodeOptions,
	texts: ReadonlyMap<object, WellFormedText>
): Result.Result<void, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new ByteSink(out)
		new Walk(options, sink, canonicalOf, rootPath, {
			texts,
			write: (text) => sink.written(text)
		}).of(value)
	})

/** The JSON form of a canonical value. */
export const toJson = (value: unknown, options: EncodeOptions): Result.Result<Json, CompileError> =>
	jsonBy(value, options, canonicalOf)

/**
 * The JSON form a Description crosses a process boundary in, read back as the Description it was: toJson's, but a
 * stand-in written as itself, its own members, which the decode restores (transportedOf).
 */
export const transportJson = (
	value: unknown,
	options: EncodeOptions
): Result.Result<Json, CompileError> => jsonBy(value, options, transportedOf)

/** The JSON form of `value` under a reading of it. */
const jsonBy = (
	value: unknown,
	options: EncodeOptions,
	reading: Reading
): Result.Result<Json, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new JsonSink()
		new Walk(options, sink, reading, rootPath, nothingCarried).of(value)
		return sink.value()
	})

/**
 * Array.isArray narrows to a mutable array, which leaves ReadonlyArray<Json> in the other branch; on a Json value an
 * array is a ReadonlyArray<Json>, so this is the same check with the narrowing the Json union needs.
 */
const isJsonArray = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value)

/** A JSON form container being written: an array's items, or an object's members in key order. */
type JsonFrame =
	| { readonly kind: "array"; readonly items: ReadonlyArray<Json>; next: number }
	| {
			readonly kind: "object"
			readonly members: ReadonlyArray<readonly [string, Json]>
			next: number
	  }

/** Writes one JSON form value: a scalar's text, or a container opened onto `frames`. */
const writeJsonValue = (sink: TextSink, frames: Array<JsonFrame>, value: Json): void => {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		sink.scalar(value)
	} else if (isJsonArray(value)) {
		sink.open("array")
		frames.push({ kind: "array", items: value, next: 0 })
	} else {
		sink.open("object")
		frames.push({
			kind: "object",
			members: Object.entries(value).toSorted(([a], [b]) => compareStrings(a, b)),
			next: 0
		})
	}
}

/** The canonical text of a JSON form value written into `sink`, its containers opened onto a stack on the heap. */
const writeJson = (sink: TextSink, value: Json): void => {
	const frames: Array<JsonFrame> = []
	writeJsonValue(sink, frames, value)
	for (let top = frames.at(-1); top !== undefined; top = frames.at(-1)) {
		if (top.kind === "array") {
			const item = top.items[top.next]
			top.next += 1
			if (item === undefined) {
				frames.pop()
				sink.close("array")
			} else {
				writeJsonValue(sink, frames, item)
			}
		} else {
			const member = top.members[top.next]
			top.next += 1
			if (member === undefined) {
				frames.pop()
				sink.close("object")
			} else {
				sink.key(member[0])
				writeJsonValue(sink, frames, member[1])
			}
		}
	}
}

/** The canonical text of a JSON form value; ResourceBound (stringLength) past V8's longest string. */
export const writeCanonicalJson = (value: Json): Result.Result<WellFormedText, CompileError> =>
	catchRefusal(() => {
		const out = new WellFormedWriter()
		writeJson(new TextSink(out, builtText), value)
		return out.text()
	})

const newline = wellFormed("\n")

/**
 * The text of a JSON artifact's file: the canonical text of its JSON form value (writeCanonicalJson's), then a newline,
 * as its chunks (grizzle-text TextChunks), written as it is read and never joined into one string, so no length bounds
 * it: a served file's (served/json.ts servedText) and an OpenAPI document's (packages/openapi openApiText).
 */
export const writeArtifactJson = (value: Json): Result.Result<TextChunks, CompileError> =>
	catchRefusal(() => {
		const out = new ChunkWriter()
		writeJson(new TextSink(out, chunkedText), value)
		out.append(newline)
		return out.chunks()
	})

/** The canonical text of a value. */
const encodeWalk = (
	value: unknown,
	options: EncodeOptions,
	bound: TextBound
): Result.Result<WellFormedText, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const out = new WellFormedWriter()
		new Walk(options, new TextSink(out, bound), canonicalOf, rootPath, nothingCarried).of(value)
		return out.text()
	})

/**
 * The versioned canonical serializer.
 *
 * One canonical text per value, so identity, fingerprints, cache keys and the snapshot are byte-stable: equal content
 * built in any key order, by any process, serializes to the same bytes. The value model (canonicalOf) is JSON without
 * null (no NULL exists at any layer) plus four extensions that JSON cannot carry:
 *
 * - bigint, carried as the tagged string "~n:<integer>";
 * - a number that is not finite, carried as "~f:NaN", "~f:Infinity" or "~f:-Infinity" (floatSpecialNames), the words
 *   a float literal names it by, so every value float8 holds has a text;
 * - a vector, a Float32Array of finite components, carried as "~v:[c1,...,cn]" (vectorTag), each component the text of
 *   the number it is, -0 as 0: the shortest text that reads back as exactly that binary32 value;
 * - any value implementing the Canonicalizable protocol below, carried as "~<tag>:<payload>". Numeric (scalar/values)
 *   uses it, so Numeric travels as a tagged string without the kernel importing it.
 *
 * A plain string beginning with "~" is escaped by doubling the "~", so tagged and plain strings never collide and the
 * JSON form decodes back exactly. The text form is the JSON form written with object keys sorted by UTF-16 code
 * units, numbers in ECMAScript shortest round-trip form, and strings in JSON.stringify's well-formed escaping, which is
 * the JSON Canonicalization Scheme (RFC 8785) over that JSON form. -0 writes as 0, as in RFC 8785; a carrier whose
 * sign of zero matters encodes it in its own tagged payload.
 *
 * Rejected as MalformedDescription, with the path of the offending value: null, undefined in an array or at the root,
 * strings and object keys that are not well-formed Unicode text (a lone UTF-16 surrogate; RFC 8785 sections 3.1 and
 * 3.2.2.2 require I-JSON input and an error on such strings, and no UTF8 database could store them), a Float32Array
 * with a component that is not finite (pgvector refuses one), functions, symbols, cycles, Maps, Sets, Dates, and any
 * other non-plain object that does not implement the protocol. A value may nest to any depth, in both directions: every
 * traversal keeps the containers it is inside on a stack on the heap, so no nesting deepens the call stack, and a
 * container that holds itself is refused as a cycle.
 *
 * The canonical text: one string per value, whatever the key insertion order. It equals writeCanonicalJson over the
 * value's JSON form (toJson), written in one pass.
 */
export const encode = (
	value: unknown,
	options: EncodeOptions
): Result.Result<WellFormedText, CompileError> => encodeWalk(value, options, builtText)

/**
 * `encode`'s text of `value` built under a stated `limit` of UTF-16 code units, at most V8's longest string, which is
 * encode's own (builtTextUnder): the same writer, refusing a text past its limit as ResourceBound (stringLengthAtLeast)
 * as it is written, so the bound every built canonical text is held to is shown on texts of a length a test can afford,
 * where one past V8's longest string costs half a gigabyte of string and seconds of a worker's heap.
 */
export const encodeWithin = (
	value: unknown,
	options: EncodeOptions,
	limit: number
): Result.Result<WellFormedText, CompileError> => encodeWalk(value, options, builtTextUnder(limit))

/**
 * The canonical text under `options` of `record`, a plain record each of whose members `written` holds has the
 * canonical text it maps the member to under the same options: `encode`'s text of it, with those members written from
 * their texts rather than encoded again. A record that is no plain record is refused as `encode` refuses it. What
 * `options` omits below a member does not read the member's path, so a member's text at the root is its text inside
 * the record.
 */
export const encodeOver = (
	record: unknown,
	options: EncodeOptions,
	written: ReadonlyMap<string, WellFormedText>
): Result.Result<WellFormedText, CompileError> =>
	catchRefusal(() => {
		const out = new WellFormedWriter()
		const sink = new TextSink(out, builtText)
		new Walk(options, sink, canonicalOf, rootPath, nothingCarried).over(record, written, (text) =>
			sink.written(text)
		)
		return out.text()
	})

/**
 * The canonical text of an array whose items have the canonical texts `items`, in order: what `encode` writes of it,
 * for a text assembled from its parts' (encodeOver).
 */
export const arrayText = (items: ReadonlyArray<WellFormedText>): WellFormedText => {
	const out = new WellFormedWriter()
	out.append(punctuation.array.open)
	for (const [at, item] of items.entries()) {
		if (at > 0) {
			out.append(punctuation.comma)
		}
		out.append(item)
	}
	out.append(punctuation.array.close)
	return out.text()
}

/** The canonical text's opening bracket of an array. */
const arrayOpen: unique symbol = Symbol("[")
/** The canonical text's closing bracket of an array. */
const arrayClose: unique symbol = Symbol("]")
/** The canonical text's opening brace of an object. */
const objectOpen: unique symbol = Symbol("{")
/** The canonical text's closing brace of an object. */
const objectClose: unique symbol = Symbol("}")
/** The canonical text's separator of two items or members. */
const itemSeparator: unique symbol = Symbol(",")
/** The canonical text's colon between a member's key and its value. */
const keyColon: unique symbol = Symbol(":")

/** A punctuation token of the canonical text. */
type Punctuation =
	| typeof arrayOpen
	| typeof arrayClose
	| typeof objectOpen
	| typeof objectClose
	| typeof itemSeparator
	| typeof keyColon

/**
 * One token of a value's canonical text, as JSON's grammar reads it: a string (a value already escaped, or an object
 * key), a number, a boolean, or punctuation. A value's tokens spelled in order are its canonical text (`encode`), so
 * two values hold one token list exactly when they hold one text, and a list is as long as the value has scalars and
 * containers, never as long as its strings: no text is joined.
 */
export type CanonicalToken = string | number | boolean | Punctuation

/** A punctuation token's text. */
const punctuationText = (token: Punctuation): string => {
	switch (token) {
		case arrayOpen:
			return "["
		case arrayClose:
			return "]"
		case objectOpen:
			return "{"
		case objectClose:
			return "}"
		case itemSeparator:
			return ","
		case keyColon:
			return ":"
	}
}

/** The sink that writes a value's canonical tokens: the canonical text's, token by token, never one text. */
class TokenSink implements Sink {
	readonly #tokens: Array<CanonicalToken> = []
	/** Whether a value was written in the container being written, so the next item or member follows a separator. */
	#after = false

	/** The tokens written. */
	tokens(): ReadonlyArray<CanonicalToken> {
		return this.#tokens
	}

	scalar(value: string | number | boolean): void {
		this.#separate()
		this.#tokens.push(value)
		this.#after = true
	}

	open(kind: ContainerKind): void {
		this.#separate()
		this.#tokens.push(kind === "array" ? arrayOpen : objectOpen)
		this.#after = false
	}

	key(key: string): void {
		this.#separate()
		this.#tokens.push(key, keyColon)
		this.#after = false
	}

	close(kind: ContainerKind): void {
		this.#tokens.push(kind === "array" ? arrayClose : objectClose)
		this.#after = true
	}

	#separate(): void {
		if (this.#after) {
			this.#tokens.push(itemSeparator)
		}
	}
}

/**
 * The canonical tokens of a value (`CanonicalToken`): its canonical text's, refused as `encode` refuses, but never for
 * its length, since no text is built. A key over a value's identity is its tokens' (`canonicalTokensId`).
 */
export const canonicalTokens = (
	value: unknown,
	options: EncodeOptions
): Result.Result<ReadonlyArray<CanonicalToken>, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new TokenSink()
		new Walk(options, sink, canonicalOf, rootPath, nothingCarried).of(value)
		return sink.tokens()
	})

/** A scalar token's text: a number's or a boolean's as JSON.stringify writes it, a punctuation token's its own. */
const scalarText = (token: number | boolean | Punctuation): string =>
	typeof token === "symbol" ? punctuationText(token) : JSON.stringify(token)

/**
 * The identity of a token list (core/text.ts TextsId): its shape, the canonical text with each string's literal a lone
 * quote, then each string as it is. No other token's text holds a quote and the canonical text is JSON's grammar, so a
 * shape and its strings spell one list alone; no string is joined, so a set of values by their tokens is a TextsMap,
 * which hashes them by their digest, never V8's hash of a string, which a text past 16,383 units has by its length
 * alone.
 */
export const canonicalTokensId = (tokens: ReadonlyArray<CanonicalToken>): TextsId => {
	const shape: Array<string> = []
	const strings: Array<string> = []
	for (const token of tokens) {
		if (typeof token === "string") {
			shape.push('"')
			strings.push(token)
		} else {
			shape.push(scalarText(token))
		}
	}
	return textsId([shape.join(""), ...strings])
}

/** The first UTF-16 code unit of a token's text: a string's opening quote, or a scalar text's first. */
const firstUnit = (token: CanonicalToken): string =>
	typeof token === "string" ? '"' : scalarText(token).charAt(0)

const quotedOrder = compareQuoted(compareStrings)

/**
 * The UTF-16 code unit order of two token lists' canonical texts (`encode`), without spelling them: equal tokens are
 * skipped, two strings are ordered as JSON string literals (core/text.ts compareQuoted), and any other two tokens by
 * their texts, which are short. Only a number's text can be another's prefix, and a number is followed by punctuation
 * or the end, neither of which a number's text continues with, so the unit after the shorter one decides.
 */
export const compareCanonicalTokens = (
	a: ReadonlyArray<CanonicalToken>,
	b: ReadonlyArray<CanonicalToken>
): number => {
	for (let i = 0; ; i++) {
		const x = a[i]
		const y = b[i]
		if (x === undefined || y === undefined) {
			return x === undefined ? (y === undefined ? 0 : -1) : 1
		}
		if (x === y) {
			continue
		}
		if (typeof x === "string" && typeof y === "string") {
			return quotedOrder(x, y)
		}
		if (typeof x === "string" || typeof y === "string") {
			return compareStrings(firstUnit(x), firstUnit(y))
		}
		const xs = scalarText(x)
		const ys = scalarText(y)
		if (ys.startsWith(xs)) {
			const after = a[i + 1]
			return after === undefined ? -1 : compareStrings(firstUnit(after), ys.charAt(xs.length))
		}
		if (xs.startsWith(ys)) {
			const after = b[i + 1]
			return after === undefined ? 1 : compareStrings(xs.charAt(ys.length), firstUnit(after))
		}
		return compareStrings(xs, ys)
	}
}

/**
 * Decoders for extension tags, for example `{ d: Numeric.fromCanonical }`. "n" (bigint) and "f" (NaN and the
 * infinities) are built in. "v" is the caller's: a host vector's text and the IR's VectorText's are one, so the reader
 * names the form it restores, scalar/values' Vector.fromCanonical a Float32Array.
 */
export type Revivers = {
	readonly [tag: string]: (payload: string) => Result.Result<unknown, CompileError>
}

/** No extension tag: a text that holds one is refused. */
export const noRevivers: Revivers = {}

/** Whether `text` is an integer's one decimal text, as bigint's toString writes it: no leading zero, and no `-0`. */
export const isCanonicalInteger = (text: string): boolean => {
	const digits = text.startsWith("-") ? text.slice(1) : text
	if (digits.length === 0) {
		return false
	}
	for (const ch of digits) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	if (digits.length > 1 && digits.startsWith("0")) {
		return false
	}
	return !(text.startsWith("-") && digits === "0")
}

/**
 * A container being restored, with the key it is a member under when the container holding it is a record: an
 * array's items, or a record's members in the order its entries give them.
 */
type Restoring =
	| {
			readonly kind: "array"
			readonly value: ReadonlyArray<unknown>
			next: number
			readonly under: string
			readonly items: Array<unknown>
	  }
	| {
			readonly kind: "object"
			readonly value: object
			readonly entries: ReadonlyArray<readonly [string, unknown]>
			next: number
			readonly under: string
			readonly members: Array<readonly [string, unknown]>
	  }

/**
 * One traversal restoring bigints and tagged values from the JSON form, refusing what canonical text never holds: an
 * in-memory value that is no JSON form, a cyclic one included, as well as text no encoding wrote. Every container read
 * is opened onto a stack of frames on the heap, as Walk's are, so a value nested to any depth never deepens the call
 * stack. A traversal is used once: a refusal ends it.
 */
class Revive {
	readonly #path: Array<string | number> = []
	readonly #ancestors = new Set<object>()
	readonly #frames: Array<Restoring> = []
	/** The root's restored value, once read. */
	readonly #root: Array<unknown> = []
	readonly #revivers: Revivers

	constructor(revivers: Revivers) {
		this.#revivers = revivers
	}

	/** The value `root` restores to. */
	of(root: unknown): unknown {
		this.#read(root, "")
		for (let top = this.#frames.at(-1); top !== undefined; top = this.#frames.at(-1)) {
			if (top.kind === "array") {
				const i = top.next
				if (i === top.value.length) {
					this.#close(top)
					continue
				}
				top.next = i + 1
				this.#path.push(i)
				this.#read(top.value[i], "")
				continue
			}
			const entry = top.entries[top.next]
			if (entry === undefined) {
				this.#close(top)
				continue
			}
			top.next += 1
			const [key, child] = entry
			this.#path.push(key)
			checkText(key, this.#path, refuseText)
			this.#read(child, key)
		}
		return this.#root[0]
	}

	/**
	 * Reads one value, a member under `key` where the container holding it is a record: a scalar's value is restored
	 * into that container, and a container is opened onto the frames.
	 */
	#read(value: unknown, key: string): void {
		switch (typeof value) {
			case "boolean":
				this.#restored(value, key)
				return
			case "number":
				if (!Number.isFinite(value)) {
					return refuseText(this.#path, "a finite number")
				}
				this.#restored(value, key)
				return
			case "string":
				this.#restored(this.#string(value), key)
				return
			case "object":
				this.#object(value, key)
				return
			case "bigint":
			case "undefined":
			case "function":
			case "symbol":
				return refuseText(this.#path, `a JSON value, not ${typeof value}`)
		}
	}

	/** A member's value restored into its container, and its path segment left; the root's held. */
	#restored(value: unknown, key: string): void {
		this.#add(value, key)
		if (this.#frames.length > 0) {
			this.#path.pop()
		}
	}

	#add(value: unknown, key: string): void {
		const top = this.#frames.at(-1)
		if (top === undefined) {
			this.#root.push(value)
		} else if (top.kind === "array") {
			top.items.push(value)
		} else {
			top.members.push([key, value])
		}
	}

	/** The container on top closed: restored into the container holding it, and its frame and ancestor left. */
	#close(frame: Restoring): void {
		this.#frames.pop()
		this.#ancestors.delete(frame.value)
		this.#restored(
			frame.kind === "array" ? frame.items : Object.fromEntries(frame.members),
			frame.under
		)
	}

	#string(value: string): unknown {
		checkText(value, this.#path, refuseText)
		if (!value.startsWith("~")) {
			return value
		}
		if (value.startsWith("~~")) {
			return value.slice(1)
		}
		const colon = value.indexOf(":")
		const tag = colon < 0 ? "" : value.slice(1, colon)
		const payload = value.slice(colon + 1)
		if (!isTagName(tag)) {
			return refuseText(
				this.#path,
				"a tagged string, ~<tag>:<payload> with a tag of lowercase letters and digits that begins with a letter"
			)
		}
		if (tag === bigintTag) {
			return isCanonicalInteger(payload)
				? BigInt(payload)
				: refuseText(this.#path, "a canonical bigint")
		}
		if (tag === floatTag) {
			return (
				floatSpecialOf(payload) ??
				refuseText(this.#path, "a float named by a word: NaN, Infinity, -Infinity or -0")
			)
		}
		/** Own properties only: an inherited one ("constructor", "toString", ...) is no reviver. */
		const revive = Object.hasOwn(this.#revivers, tag) ? this.#revivers[tag] : undefined
		if (revive === undefined) {
			return refuseText(this.#path, `a reviver for canonical tag "${tag}"`)
		}
		return unwrap(revive(payload))
	}

	#object(value: object | null, key: string): void {
		if (value === null) {
			return refuseText(this.#path, "a value, not null")
		}
		if (this.#ancestors.has(value)) {
			return refuseText(this.#path, "an acyclic value")
		}
		this.#ancestors.add(value)
		this.#frames.push(
			Array.isArray(value)
				? { kind: "array", value, next: 0, under: key, items: [] }
				: {
						kind: "object",
						value,
						entries: Object.entries(value),
						next: 0,
						under: key,
						members: []
					}
		)
	}
}

/** Restores bigints and tagged values from the JSON form. */
export const fromJson = (
	value: unknown,
	revivers: Revivers
): Result.Result<unknown, CompileError> => catchRefusal(() => new Revive(revivers).of(value))

/**
 * Parses canonical (or any JSON) text, a file's, held as its chunks and read as JSON.parse reads the text they make
 * (grizzle-text readJson), and restores tagged values.
 */
export const decode = (
	text: TextChunks,
	revivers: Revivers
): Result.Result<unknown, CompileError> => {
	const parsed = readJson(text)
	if (!parsed.ok) {
		return Result.err(malformedArtifact("canonical", [], "JSON text"))
	}
	return fromJson(parsed.value, revivers)
}

/**
 * The canonical text under `options` of a value the compiler owns, which encodes by construction: a decoded or
 * validated value, or a key built from one (owned).
 */
export const ownedText = (value: unknown, options: EncodeOptions): WellFormedText =>
	owned(encode(value, options))

/** The canonical text of a value the compiler owns (ownedText) written into `out` as its UTF-8 (writeCanonical). */
export const writeOwned = (out: Utf8Writer, value: unknown, options: EncodeOptions): void =>
	owned(writeCanonical(out, value, options))

/**
 * What a canonical writer gives of a value the compiler owns: the one site of the fact that such a value encodes, plain
 * data with well-formed text and no cycle, which no TypeScript type of a value carries, so a failure is a defect of the
 * compiler, never a property of its input.
 */
const owned = <A>(written: Result.Result<A, CompileError>): A => {
	if (!written.ok) {
		defect(`an owned value encodes: ${written.error.message}`)
	}
	return written.value
}

/** The canonical text of every property of a value the compiler owns (ownedText). */
export const canonicalTextOf = (value: unknown): WellFormedText => ownedText(value, everyProperty)

/**
 * A set's members sorted by canonical text, the canonical order of a declaration set, each beside its text. Stable for
 * equal texts, which are equal members.
 */
export const canonicalSortKeyed = <A>(
	items: ReadonlyArray<A>,
	options: EncodeOptions
): Result.Result<ReadonlyArray<{ readonly item: A; readonly text: string }>, CompileError> =>
	catchRefusal(() => {
		const keyed = items.map((item, i) => {
			const text = unwrap(Result.mapError(encode(item, options), (error) => within(error, [i])))
			return { item, text }
		})
		keyed.sort(mapInput(compareStrings, (k: { readonly text: string }) => k.text))
		return keyed
	})
