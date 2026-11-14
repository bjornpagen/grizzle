import { appendAll } from "#compiler/core/array.ts"
import {
	type CompileError,
	isCompileError,
	malformedArtifact,
	malformedDescription,
	resourceBound,
	within
} from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isCapturedStack, isSourceLoc, readSite, SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { compareQuoted } from "#compiler/core/text.ts"

export const canonicalFormat = "grizzle-canonical"

/** UTF-16 code-unit order: the order canonical text sorts object keys in, and every sorted list of names or keys. */
export const compareText = (a: string, b: string): number => compareStrings(a, b)

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
 * The tag of the canonical text of a number that is not finite, "~f:<name>" (floatSpecialNames), which the kernel reads
 * itself: a float4 or float8 value PostgreSQL holds and JSON has no number for.
 */
const floatTag = "f"

/** The floats named by a word, NaN and the infinities, in one order: a literal's names and their canonical texts'. */
export const floatSpecialNames = ["NaN", "Infinity", "-Infinity"] as const
export type FloatSpecialName = (typeof floatSpecialNames)[number]

/** Each float named by a word, as the number it is. */
export const floatSpecials: Readonly<Record<FloatSpecialName, number>> = {
	NaN: Number.NaN,
	Infinity: Number.POSITIVE_INFINITY,
	"-Infinity": Number.NEGATIVE_INFINITY
}

/** Whether a value is the word naming a float (floatSpecialNames). */
export const isFloatSpecialName = (value: unknown): value is FloatSpecialName =>
	typeof value === "string" && Object.hasOwn(floatSpecials, value)

/** The float a word names (floatSpecialNames); undefined for any other text. */
export const floatSpecialOf = (text: string): number | undefined =>
	isFloatSpecialName(text) ? floatSpecials[text] : undefined

/** The word naming a number that is not finite; undefined for a finite number, which JSON writes as a number. */
export const floatSpecialNameOf = (x: number): FloatSpecialName | undefined =>
	Number.isNaN(x)
		? "NaN"
		: x === Number.POSITIVE_INFINITY
			? "Infinity"
			: x === Number.NEGATIVE_INFINITY
				? "-Infinity"
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
 * identity. A pure function of its arguments.
 */
export type OmitRule = (key: string, value: unknown, path: Path) => boolean

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
 * pattern beside it (ir/scalar.ts TextLanguage). By convention they travel under the properties "loc" and "language".
 */
export const omitSourceLocs: OmitRule = (key, value) =>
	(key === "loc" && isSourceLoc(value)) ||
	(key === "language" &&
		isRecord(value) &&
		(value["kind"] === "every" || value["kind"] === "refined"))

/** Every property in the canonical form: the text of the value as it is. */
export const everyProperty: EncodeOptions = { omit: () => false }

/** Every property but the SourceLocs: the text of the value's semantic identity. */
export const withoutSourceLocs: EncodeOptions = { omit: omitSourceLocs }

/** A record's members as withoutSourceLocs' text holds them: each one stated, read as memberOf reads it, and not omitted. */
const identityMembers = (record: Readonly<Record<string, unknown>>): Map<string, unknown> => {
	const members = new Map<string, unknown>()
	for (const key of Object.keys(record)) {
		const member = memberOf(record[key])
		if (member !== undefined && !omitSourceLocs(key, member, [])) {
			members.set(key, member)
		}
	}
	return members
}

/** JSON text, admitted as an unknown value for the structural decode that follows; undefined for text that is not JSON. */
const parseJsonText = (text: string): Result.Result<unknown, undefined> => {
	try {
		const parsed: unknown = JSON.parse(text)
		return Result.ok(parsed)
	} catch {
		return Result.err(undefined)
	}
}

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

/**
 * The engine's one door from a thrown signal to a Result: runs `f`, and an instance of `signal` it throws is the
 * failure; any other throw is a defect and propagates. A signal is internal control flow, thrown deep inside a
 * traversal and caught at its boundary: the kernel's Refusal, a catalog recognizer's NoMatch, the regex parser's
 * Failure.
 */
export const catchSignal = <A, S>(
	signal: abstract new (...args: never) => S,
	f: () => A
): Result.Result<A, S> => {
	try {
		return Result.ok(f())
	} catch (caught) {
		if (caught instanceof signal) {
			return Result.err(caught)
		}
		throw caught
	}
}

/** Runs `f`, turning a thrown Refusal into a failure; any other throw is a defect and propagates. */
export const catchRefusal = <A>(f: () => A): Result.Result<A, CompileError> =>
	Result.mapError(catchSignal(Refusal, f), (refusal) => refusal.error)

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
 * An object read by its kind: a Float32Array as a vector, whatever else it holds; a value whose method returns a tag
 * and a payload as one implementing the protocol, and one whose method returns anything else as a forgery outside the
 * model; an array; and any other object as a plain record, or outside the model.
 */
const objectOf = (value: Readonly<Record<string, unknown>>): CanonicalObject | Outside => {
	if (value instanceof Float32Array) {
		return vectorOf(value)
	}
	const tagged = taggedValueOf(value)
	if (tagged !== undefined) {
		return protocolOf(value, tagged)
	}
	if (canonicalTag in value && typeof value[canonicalTag] === "function") {
		return outside(value, "a canonical tag and payload")
	}
	return isList(value) ? { kind: "array", items: value } : recordOf(value)
}

/** A number read by the canonical model: a finite one as itself, and NaN or an infinity by the word naming it. */
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
 * and an object that is no plain record. Every number is in the model, as float8 holds every one. Every traversal of the model, and every reader of a value by it, dispatches on this reading,
 * so no kind of the model is read anywhere but here.
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

/** The pairs of members two canonical objects hold one text exactly when they hold, or undefined where they cannot. */
type MemberPairs = ReadonlyArray<readonly [unknown, unknown]> | undefined

/**
 * The tagged value a canonical object is written as: a vector's, a non-finite number's or a protocol value's; undefined
 * for any other.
 */
const writtenTag = (read: CanonicalObject | Outside): TaggedValue | undefined => {
	switch (read.kind) {
		case "vector":
		case "floatSpecial":
		case "tagged":
			return read.tagged
		case "array":
		case "record":
		case "outside":
			return undefined
	}
}

/** The items of two arrays of one length, pair by pair; undefined for arrays of two lengths. */
const itemPairs = (x: ReadonlyArray<unknown>, y: ReadonlyArray<unknown>): MemberPairs =>
	x.length === y.length ? x.map((item, i) => [item, y[i]] as const) : undefined

/** The members of two records under one set of keys, key by key; undefined for records under two. */
const recordPairs = (
	x: Readonly<Record<string, unknown>>,
	y: Readonly<Record<string, unknown>>
): MemberPairs => {
	const membersX = identityMembers(x)
	const membersY = identityMembers(y)
	const pairs: Array<readonly [unknown, unknown]> = []
	for (const [key, member] of membersX) {
		if (!membersY.has(key)) {
			return undefined
		}
		pairs.push([member, membersY.get(key)])
	}
	return membersX.size === membersY.size ? pairs : undefined
}

/**
 * What two canonical objects hold one text exactly when: a vector, a non-finite number or a protocol value beside any
 * of one tag and payload, nothing more; two arrays, their items; two records, their members; and never a value outside
 * the model.
 */
const memberPairs = (x: CanonicalObject | Outside, y: CanonicalObject | Outside): MemberPairs => {
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
			return y.kind === "record" ? recordPairs(x.record, y.record) : undefined
		case "outside":
			return undefined
	}
}

/**
 * Whether two values a builder made have one semantic identity: whether the texts withoutSourceLocs writes of them are
 * one text, read by walking both at once and writing neither, each value read by the canonical model (canonicalOf). A
 * scalar is itself, a finite number its value, -0 being 0; NaN, an infinity, a vector or a value implementing the
 * protocol its tag and payload, so NaN is the same as NaN; a list its items in order; a record its members by key in
 * any order, a member the text leaves out left out here; and a value outside the model, which no text holds, the same
 * as nothing but itself. One value met twice is one value at
 * once, so a value is read only where it differs from the other. The pairs still to compare wait on a stack on the
 * heap, so no depth of value deepens the call stack.
 */
export const sameContent = (a: unknown, b: unknown): boolean => {
	const pending: Array<readonly [unknown, unknown]> = [[a, b]]
	for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
		const [x, y] = pair
		if (x === y) {
			continue
		}
		const readX = canonicalOf(x)
		const readY = canonicalOf(y)
		const pairs =
			typeof readX === "object" && typeof readY === "object" ? memberPairs(readX, readY) : undefined
		if (pairs === undefined) {
			return false
		}
		appendAll(pending, pairs)
	}
	return true
}

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
			readonly written: ReadonlyMap<string, string>
			readonly write: (text: string) => void
	  }

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
	readonly #path: Array<string | number> = []
	readonly #ancestors = new Set<object>()
	readonly #frames: Array<Frame> = []
	readonly #options: EncodeOptions
	readonly #sink: Sink

	constructor(options: EncodeOptions, sink: Sink) {
		this.#options = options
		this.#sink = sink
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
	over(root: unknown, written: ReadonlyMap<string, string>, write: (text: string) => void): void {
		const read = canonicalOf(root)
		if (typeof read !== "object" || read.kind !== "record") {
			return stop(this.#path, "a plain record")
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

	/** Reads the open containers' members until every container is closed. */
	#run(): void {
		for (let top = this.#frames.at(-1); top !== undefined; top = this.#frames.at(-1)) {
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
		if (!(i in frame.value) || item === undefined) {
			stop([...this.#path, i], "an array element, not a hole")
		}
		this.#path.push(i)
		this.#readMember(item)
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
		if (child === undefined || this.#options.omit(key, child, this.#path)) {
			return
		}
		this.#path.push(key)
		checkText(key, this.#path, refuseValue)
		this.#sink.key(key)
		if (frame.kind === "over") {
			const text = frame.written.get(key)
			if (text !== undefined) {
				frame.write(text)
				this.#path.pop()
				return
			}
		}
		this.#readMember(child)
	}

	/** A member read: its path segment is popped once its form is written, at once or when its container closes. */
	#readMember(value: unknown): void {
		if (!this.#read(value)) {
			this.#path.pop()
		}
	}

	/** The container on top closed: its frame and ancestor left, and its path segment, when it is a member. */
	#close(value: object, kind: ContainerKind): void {
		this.#frames.pop()
		this.#ancestors.delete(value)
		this.#sink.close(kind)
		if (this.#frames.length > 0) {
			this.#path.pop()
		}
	}

	/**
	 * Reads one value by the canonical model (canonicalOf): a scalar's form is written, and a container is opened onto
	 * the frames, which is true. No reading is undefined, a function or a symbol, so those cases hold none (never).
	 */
	#read(value: unknown): boolean {
		const read = canonicalOf(value)
		switch (typeof read) {
			case "string":
				this.#sink.scalar(escapeString(read))
				return false
			case "number":
				this.#sink.scalar(read === 0 ? 0 : read)
				return false
			case "boolean":
				this.#sink.scalar(read)
				return false
			case "bigint":
				this.#sink.scalar(`~${bigintTag}:${read.toString()}`)
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
				this.#sink.scalar(`~${read.tagged.tag}:${read.tagged.payload}`)
				return false
			case "array":
				this.#enter(read.items)
				this.#sink.open("array")
				this.#frames.push({ kind: "array", value: read.items, next: 0 })
				return true
			case "record":
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
				return stop(this.#path, read.what)
		}
	}

	/** A container entered as an ancestor of what it holds, refused where it is one already: a cycle. */
	#enter(container: object): void {
		if (this.#ancestors.has(container)) {
			stop(this.#path, "an acyclic value")
		}
		this.#ancestors.add(container)
	}
}

/** A plain record's keys in canonical order. */
const keysOf = (record: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
	const keys = Object.keys(record)
	keys.sort()
	return keys
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
 * The sink that writes the canonical text, appended to one string as it is read: past V8's longest string the
 * traversal stops with ResourceBound (stringLength), measured before the text is built past it.
 */
class TextSink implements Sink {
	#text = ""
	/** Whether a value was written in the container being written, so the next item or member follows a comma. */
	#after = false

	/** The text written. */
	text(): string {
		return this.#text
	}

	scalar(value: string | number | boolean): void {
		this.written(JSON.stringify(value))
	}

	/** A value whose canonical text is `text`, written as it is (Walk.over). */
	written(text: string): void {
		this.#append(this.#after ? `,${text}` : text)
		this.#after = true
	}

	open(kind: ContainerKind): void {
		const bracket = kind === "array" ? "[" : "{"
		this.#append(this.#after ? `,${bracket}` : bracket)
		this.#after = false
	}

	key(key: string): void {
		const quoted = JSON.stringify(key)
		this.#append(this.#after ? `,${quoted}:` : `${quoted}:`)
		this.#after = false
	}

	close(kind: ContainerKind): void {
		this.#append(kind === "array" ? "]" : "}")
		this.#after = true
	}

	#append(text: string): void {
		const needed = this.#text.length + text.length
		if (needed > maxStringLength.value) {
			throw new Refusal(
				resourceBound(canonicalTextLoc, {
					kind: "stringLength",
					limit: maxStringLength.value,
					needed
				})
			)
		}
		this.#text += text
	}
}

/** The JSON form of a canonical value. */
export const toJson = (value: unknown, options: EncodeOptions): Result.Result<Json, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new JsonSink()
		new Walk(options, sink).of(value)
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
			members: Object.entries(value).toSorted(([a], [b]) => compareText(a, b)),
			next: 0
		})
	}
}

/** The canonical text of a JSON form value, its containers opened onto a stack on the heap. */
const writeJson = (value: Json): string => {
	const sink = new TextSink()
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
	return sink.text()
}

/** The canonical text of a JSON form value; ResourceBound (stringLength) past V8's longest string. */
export const writeCanonicalJson = (value: Json): Result.Result<string, CompileError> =>
	catchRefusal(() => writeJson(value))

/** The canonical text of a value. */
const encodeWalk = (value: unknown, options: EncodeOptions): Result.Result<string, CompileError> =>
	catchRefusal(() => {
		if (value === undefined) {
			return refuseValue([], "a value, not undefined")
		}
		const sink = new TextSink()
		new Walk(options, sink).of(value)
		return sink.text()
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
 * - any value implementing the Canonicalizable protocol below, carried as "~<tag>:<payload>". Decimal (scalar/values)
 *   uses it, so Decimal travels as a tagged string without the kernel importing it.
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
): Result.Result<string, CompileError> => encodeWalk(value, options)

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
	written: ReadonlyMap<string, string>
): Result.Result<string, CompileError> =>
	catchRefusal(() => {
		const sink = new TextSink()
		new Walk(options, sink).over(record, written, (text) => sink.written(text))
		return sink.text()
	})

/**
 * The canonical text of an array whose items have the canonical texts `items`, in order: what `encode` writes of it,
 * for a text assembled from its parts' (encodeOver).
 */
export const arrayText = (items: ReadonlyArray<string>): string => `[${items.join(",")}]`

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
 * its length, since no text is built. A key over a value's identity is its tokens, in a TupleMap.
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
		new Walk(options, sink).of(value)
		return sink.tokens()
	})

/** A scalar token's text: a number's or a boolean's as JSON.stringify writes it, a punctuation token's its own. */
const scalarText = (token: number | boolean | Punctuation): string =>
	typeof token === "symbol" ? punctuationText(token) : JSON.stringify(token)

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
 * Decoders for extension tags, for example `{ d: Decimal.fromCanonical }`. "n" (bigint) and "f" (NaN and the
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
				refuseText(this.#path, "a float named by a word: NaN, Infinity or -Infinity")
			)
		}
		/** Own properties only: an inherited one ("constructor", "toString", ...) is no reviver. */
		const revive = Object.hasOwn(this.#revivers, tag) ? this.#revivers[tag] : undefined
		if (revive === undefined) {
			return refuseText(this.#path, `a reviver for canonical tag "${tag}"`)
		}
		const revived = revive(payload)
		if (!revived.ok) {
			throw new Refusal(revived.error)
		}
		return revived.value
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

/** Parses canonical (or any JSON) text and restores tagged values. */
export const decode = (text: string, revivers: Revivers): Result.Result<unknown, CompileError> => {
	const parsed = parseJsonText(text)
	if (!parsed.ok) {
		return Result.err(malformedArtifact("canonical", [], "JSON text"))
	}
	return fromJson(parsed.value, revivers)
}

/**
 * The canonical text under `options` of a value the compiler owns, which encodes by construction: a decoded or
 * validated value, or a key built from one. The one site of the fact that such a value encodes: plain data with
 * well-formed text and no cycle, which no TypeScript type of a value carries, so a
 * failure is a defect of the compiler, never a property of its input.
 */
export const ownedText = (value: unknown, options: EncodeOptions): string => {
	const text = encode(value, options)
	if (!text.ok) {
		throw defect(`an owned value encodes: ${text.error.message}`)
	}
	return text.value
}

/** The canonical text of every property of a value the compiler owns (ownedText). */
export const canonicalTextOf = (value: unknown): string => ownedText(value, everyProperty)

/**
 * Canonical equality: equal canonical text. Values that fail to encode are unequal to everything. A value is equal to
 * itself when it encodes.
 */
export const canonicalEquals = (a: unknown, b: unknown, options: EncodeOptions): boolean => {
	if (a === b) {
		return encode(a, options).ok
	}
	const left = encode(a, options)
	const right = encode(b, options)
	return left.ok && right.ok && left.value === right.value
}

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
			const text = encode(item, options)
			if (!text.ok) {
				throw new Refusal(within(text.error, [i]))
			}
			return { item, text: text.value }
		})
		keyed.sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
		return keyed
	})
