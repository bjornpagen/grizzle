import {
	type CompileError,
	isCompileError,
	malformedArtifact,
	malformedDescription,
	within
} from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { enclosedWithin } from "#compiler/core/lines.ts"
import { isSourceLoc, SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { compareQuoted } from "#compiler/core/text.ts"

export const canonicalFormat = "grizzle-canonical"

/** UTF-16 code-unit order: the order canonical text sorts object keys in, and every sorted list of names or keys. */
export const compareText = (a: string, b: string): number => compareStrings(a, b)

export const canonicalTag: unique symbol = Symbol.for("grizzle/canonical")

export interface TaggedValue {
	/** Lowercase ASCII letters and digits, starting with a letter. "n" is reserved for bigint. */
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
 * A container's part of a traversal: a generator that yields each of its members' values in order, receives each
 * member's form back, and returns the container's own form. A traversal that keeps a path has it push a member's
 * segment before it yields the member and pop it once the member's form comes back, so a refusal below names its
 * whole path.
 */
type Members<V, R> = Generator<V, R, R>

/** What a traversal reads at one value: the form of a value that holds no other, or the members of a container. */
type Reading<V, R> =
	| { readonly kind: "form"; readonly form: R }
	| { readonly kind: "members"; readonly members: Members<V, R> }

const formOf = <V, R>(form: R): Reading<V, R> => ({ kind: "form", form })
const membersOf = <V, R>(members: Members<V, R>): Reading<V, R> => ({ kind: "members", members })

/** A container being read, and the container whose member it is. */
interface Opened<V, R> {
	readonly members: Members<V, R>
	readonly parent: Opened<V, R> | undefined
}

/**
 * The form of `root`, folded bottom up by `read`. Every container read is opened onto a stack on the heap, where its
 * members wait while one of them is read, so a value nested to any depth never deepens the call stack. A refusal
 * thrown while reading ends the traversal.
 */
const traverse = <V, R>(root: V, read: (value: V) => Reading<V, R>): R => {
	let reading = read(root)
	let top: Opened<V, R> | undefined
	for (;;) {
		let next: IteratorResult<V, R>
		if (reading.kind === "members") {
			top = { members: reading.members, parent: top }
			next = top.members.next()
		} else if (top === undefined) {
			return reading.form
		} else {
			next = top.members.next(reading.form)
		}
		while (next.done === true) {
			top = top.parent
			if (top === undefined) {
				return next.value
			}
			next = top.members.next(next.value)
		}
		reading = read(next.value)
	}
}

/**
 * What one canonical traversal builds a value's form from, bottom up: a scalar's JSON value (a string already escaped,
 * a finite number with no negative zero, a boolean), an array of its items' forms, and an object of its members' keys
 * and forms in key order. Walk states every check once; a fold only assembles.
 */
interface Fold<R> {
	scalar(value: string | number | boolean): R
	array(items: ReadonlyArray<R>): R
	object(members: ReadonlyArray<readonly [string, R]>): R
}

/**
 * One canonical traversal: every check, in one order, with one refusal each, and the value's canonical form folded by
 * its fold. Keys are visited in the order Object.keys() sorted gives, the UTF-16 code unit order canonical text sorts
 * by, so no fold sorts again. The containers on the path from the root are its ancestors, so a container that holds
 * itself is refused as a cycle, while one that two others share is read once under each. A traversal is used once: a
 * refusal ends it, so its path and ancestors are never read again after one.
 */
class Walk<R> {
	readonly #path: Array<string | number> = []
	readonly #ancestors = new Set<object>()
	readonly #options: EncodeOptions
	readonly #fold: Fold<R>

	constructor(options: EncodeOptions, fold: Fold<R>) {
		this.#options = options
		this.#fold = fold
	}

	/** The form of `root`. */
	of(root: unknown): R {
		return traverse(root, (value: unknown) => this.#read(value))
	}

	#read(value: unknown): Reading<unknown, R> {
		switch (typeof value) {
			case "string":
				checkText(value, this.#path, refuseValue)
				return formOf(this.#fold.scalar(escapeString(value)))
			case "boolean":
				return formOf(this.#fold.scalar(value))
			case "number":
				if (!Number.isFinite(value)) {
					stop(this.#path, "a finite number")
				}
				return formOf(this.#fold.scalar(value === 0 ? 0 : value))
			case "bigint":
				return formOf(this.#fold.scalar(`~n:${value.toString()}`))
			case "object":
				return this.#object(value)
			case "undefined":
			case "function":
			case "symbol":
				return stop(this.#path, `a canonical value, not ${typeof value}`)
		}
	}

	#object(value: object | null): Reading<unknown, R> {
		if (!isRecord(value)) {
			stop(this.#path, "a value, not null")
		}
		const tagged = taggedValueOf(value)
		if (
			tagged === undefined &&
			canonicalTag in value &&
			typeof value[canonicalTag] === "function"
		) {
			stop(this.#path, "a canonical tag and payload")
		}
		if (tagged !== undefined) {
			if (!isTagName(tagged.tag) || tagged.tag === "n") {
				stop(this.#path, `a valid canonical tag, not "${tagged.tag}"`)
			}
			checkText(tagged.payload, this.#path, refuseValue)
			return formOf(this.#fold.scalar(`~${tagged.tag}:${tagged.payload}`))
		}
		if (this.#ancestors.has(value)) {
			stop(this.#path, "an acyclic value")
		}
		this.#ancestors.add(value)
		return membersOf(Array.isArray(value) ? this.#array(value) : this.#record(value))
	}

	*#array(value: ReadonlyArray<unknown>): Members<unknown, R> {
		const items: Array<R> = []
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i]
			if (!(i in value) || item === undefined) {
				stop([...this.#path, i], "an array element, not a hole")
			}
			this.#path.push(i)
			items.push(yield item)
			this.#path.pop()
		}
		this.#ancestors.delete(value)
		return this.#fold.array(items)
	}

	*#record(value: Readonly<Record<string, unknown>>): Members<unknown, R> {
		const proto: unknown = Object.getPrototypeOf(value)
		if (proto !== Object.prototype && proto !== null) {
			stop(this.#path, "a plain object")
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			stop(this.#path, "an object without symbol keys")
		}
		const members: Array<readonly [string, R]> = []
		for (const key of Object.keys(value).toSorted(compareStrings)) {
			const child = value[key]
			if (child === undefined || this.#options.omit(key, child, this.#path)) {
				continue
			}
			this.#path.push(key)
			checkText(key, this.#path, refuseValue)
			members.push([key, yield child])
			this.#path.pop()
		}
		this.#ancestors.delete(value)
		return this.#fold.object(members)
	}
}

/**
 * The fold that builds the JSON form. An object is built from its entries at once (Object.fromEntries), which defines
 * each key as its own property, so "__proto__" stays an ordinary key and never reaches the prototype accessor.
 */
const jsonFold: Fold<Json> = {
	scalar: (value) => value,
	array: (items) => items,
	object: (members) => Object.fromEntries(members)
}

const canonicalTextLoc = SourceLoc("canonical text", [])

/**
 * `open`, the parts joined by `separator`, and `close`, measured before it is built: past V8's longest string the
 * traversal stops with ResourceBound (stringLength). Every enclosure is a substring of the whole text, so the first one
 * past the limit refuses.
 */
const enclosed = (
	open: string,
	parts: ReadonlyArray<string>,
	separator: string,
	close: string
): string => {
	const text = enclosedWithin(
		maxStringLength.value,
		canonicalTextLoc,
		open,
		parts,
		separator,
		close
	)
	if (!text.ok) {
		throw new Refusal(text.error)
	}
	return text.value
}

/** An object member's text, `"key":form`, measured before it is built. */
const memberText = (key: string, form: string): string =>
	enclosed(`${JSON.stringify(key)}:`, [form], "", "")

/**
 * The fold that writes the canonical text: the same bytes as writeCanonicalJson over the JSON form, without building
 * that form.
 */
const textFold: Fold<string> = {
	scalar: (value) => JSON.stringify(value),
	array: (items) => enclosed("[", items, ",", "]"),
	object: (members) =>
		enclosed(
			"{",
			members.map(([key, form]) => memberText(key, form)),
			",",
			"}"
		)
}

/** The JSON form of a canonical value. */
export const toJson = (value: unknown, options: EncodeOptions): Result.Result<Json, CompileError> =>
	catchRefusal(() =>
		value === undefined
			? refuseValue([], "a value, not undefined")
			: new Walk(options, jsonFold).of(value)
	)

/**
 * Array.isArray narrows to a mutable array, which leaves ReadonlyArray<Json> in the other branch; on a Json value an
 * array is a ReadonlyArray<Json>, so this is the same check with the narrowing the Json union needs.
 */
const isJsonArray = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value)

/** A JSON array's items, each written in turn, enclosed. */
function* jsonItems(value: ReadonlyArray<Json>): Members<Json, string> {
	const items: Array<string> = []
	for (const item of value) {
		items.push(yield item)
	}
	return enclosed("[", items, ",", "]")
}

/** A JSON object's members in key order, each written in turn, enclosed. */
function* jsonMembers(value: { readonly [key: string]: Json }): Members<Json, string> {
	const members: Array<string> = []
	for (const [key, item] of Object.entries(value).toSorted(([a], [b]) => compareText(a, b))) {
		members.push(memberText(key, yield item))
	}
	return enclosed("{", members, ",", "}")
}

const readJson = (value: Json): Reading<Json, string> => {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return formOf(JSON.stringify(value))
	}
	return membersOf(isJsonArray(value) ? jsonItems(value) : jsonMembers(value))
}

const writeJson = (value: Json): string => traverse(value, readJson)

/** The canonical text of a JSON form value; ResourceBound (stringLength) past V8's longest string. */
export const writeCanonicalJson = (value: Json): Result.Result<string, CompileError> =>
	catchRefusal(() => writeJson(value))

/** The canonical text of a value. */
const encodeWalk = (value: unknown, options: EncodeOptions): Result.Result<string, CompileError> =>
	catchRefusal(() =>
		value === undefined
			? refuseValue([], "a value, not undefined")
			: new Walk(options, textFold).of(value)
	)

/**
 * The versioned canonical serializer.
 *
 * One canonical text per value, so identity, fingerprints, cache keys and the snapshot are byte-stable: equal content
 * built in any key order, by any process, serializes to the same bytes. The value model is JSON without null (no NULL
 * exists at any layer) plus two extensions that JSON cannot carry:
 *
 * - bigint, carried as the tagged string "~n:<integer>";
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
 * 3.2.2.2 require I-JSON input and an error on such strings, and no UTF8 database could store them), non-finite
 * numbers, functions, symbols, cycles, Maps, Sets, Dates, and any other non-plain object that does not implement the
 * protocol. A value may nest to any depth, in both directions: every traversal keeps the containers it is inside on a
 * stack on the heap, so no nesting deepens the call stack, and a container that holds itself is refused as a cycle.
 *
 * The canonical text: one string per value, whatever the key insertion order. It equals writeCanonicalJson over the
 * value's JSON form (toJson), written in one pass.
 */
export const encode = (
	value: unknown,
	options: EncodeOptions
): Result.Result<string, CompileError> => encodeWalk(value, options)

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

/** A token list built bottom up: a token, or a list of them, flattened once at the root (`flattenTokens`). */
type TokenTree = CanonicalToken | ReadonlyArray<TokenTree>

const isTokenList = (tree: TokenTree): tree is ReadonlyArray<TokenTree> => Array.isArray(tree)

/** A list's parts with a separator between every two. */
const separated = (parts: ReadonlyArray<TokenTree>): ReadonlyArray<TokenTree> =>
	parts.flatMap((part, i) => (i === 0 ? [part] : [itemSeparator, part]))

/** The fold that writes a value's canonical tokens: the canonical text's, token by token, never one text. */
const tokenFold: Fold<TokenTree> = {
	scalar: (value) => value,
	array: (items) => [arrayOpen, separated(items), arrayClose],
	object: (members) => [
		objectOpen,
		separated(members.map(([key, form]): TokenTree => [key, keyColon, form])),
		objectClose
	]
}

/** A token tree's tokens in order, flattened on a stack on the heap, so no nesting deepens the call stack. */
const flattenTokens = (tree: TokenTree): ReadonlyArray<CanonicalToken> => {
	const out: Array<CanonicalToken> = []
	const stack: Array<{ readonly parts: ReadonlyArray<TokenTree>; at: number }> = [
		{ parts: [tree], at: 0 }
	]
	for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
		const part = top.parts[top.at]
		if (part === undefined) {
			stack.pop()
			continue
		}
		top.at += 1
		if (isTokenList(part)) {
			stack.push({ parts: part, at: 0 })
		} else {
			out.push(part)
		}
	}
	return out
}

/**
 * The canonical tokens of a value (`CanonicalToken`): its canonical text's, refused as `encode` refuses, but never for
 * its length, since no text is built. A key over a value's identity is its tokens, in a TupleMap.
 */
export const canonicalTokens = (
	value: unknown,
	options: EncodeOptions
): Result.Result<ReadonlyArray<CanonicalToken>, CompileError> =>
	catchRefusal(() =>
		value === undefined
			? refuseValue([], "a value, not undefined")
			: flattenTokens(new Walk(options, tokenFold).of(value))
	)

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

/** Decoders for extension tags, for example `{ d: Decimal.fromCanonical }`. "n" (bigint) is built in. */
export type Revivers = {
	readonly [tag: string]: (payload: string) => Result.Result<unknown, CompileError>
}

/** No extension tag: a text that holds one is refused. */
export const noRevivers: Revivers = {}

const isCanonicalInteger = (text: string): boolean => {
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
 * One traversal restoring bigints and tagged values from the JSON form, refusing what canonical text never holds: an
 * in-memory value that is no JSON form, a cyclic one included, as well as text no encoding wrote. A traversal is used
 * once: a refusal ends it.
 */
class Revive {
	readonly #path: Array<string | number> = []
	readonly #ancestors = new Set<object>()
	readonly #revivers: Revivers

	constructor(revivers: Revivers) {
		this.#revivers = revivers
	}

	/** The value `root` restores to. */
	of(root: unknown): unknown {
		return traverse(root, (value: unknown) => this.#read(value))
	}

	#read(value: unknown): Reading<unknown, unknown> {
		switch (typeof value) {
			case "boolean":
				return formOf(value)
			case "number":
				return Number.isFinite(value) ? formOf(value) : refuseText(this.#path, "a finite number")
			case "string":
				return formOf(this.#string(value))
			case "object":
				return this.#object(value)
			case "bigint":
			case "undefined":
			case "function":
			case "symbol":
				return refuseText(this.#path, `a JSON value, not ${typeof value}`)
		}
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
		if (tag === "n") {
			return isCanonicalInteger(payload)
				? BigInt(payload)
				: refuseText(this.#path, "a canonical bigint")
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

	#object(value: object | null): Reading<unknown, unknown> {
		if (value === null) {
			return refuseText(this.#path, "a value, not null")
		}
		if (this.#ancestors.has(value)) {
			return refuseText(this.#path, "an acyclic value")
		}
		this.#ancestors.add(value)
		return membersOf(Array.isArray(value) ? this.#array(value) : this.#record(value))
	}

	*#array(value: ReadonlyArray<unknown>): Members<unknown, unknown> {
		const items: Array<unknown> = []
		for (const [i, item] of value.entries()) {
			this.#path.push(i)
			items.push(yield item)
			this.#path.pop()
		}
		this.#ancestors.delete(value)
		return items
	}

	*#record(value: object): Members<unknown, unknown> {
		const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value)
		const members: Array<readonly [string, unknown]> = []
		for (const [key, child] of entries) {
			this.#path.push(key)
			checkText(key, this.#path, refuseText)
			members.push([key, yield child])
			this.#path.pop()
		}
		this.#ancestors.delete(value)
		return Object.fromEntries(members)
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
 * Sorts a set's members by canonical text, the canonical order of a declaration set. Stable for equal
 * texts, which are equal members.
 */
export const canonicalSort = <A>(
	items: ReadonlyArray<A>,
	options: EncodeOptions
): Result.Result<ReadonlyArray<A>, CompileError> =>
	Result.map(canonicalSortKeyed(items, options), (keyed) => keyed.map((k) => k.item))

/**
 * canonicalSort, each member beside its canonical text, so a caller that also needs the texts (to drop repeats) does
 * not encode the members again.
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
