import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	isCanonicalizable,
	maxNestingDepth,
	type Path,
	Refusal,
	taggedValueOf
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, resourceBound } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defect } from "#compiler/core/invariant.ts"
import { parseSourceLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type CanonicalFloat, canonicalZero } from "#compiler/ir/carriers.ts"

export type { Path }

/**
 * The path of the value a decode is reading, from the root: one stack per decode, onto which each container pushes a
 * child's key while it reads that child, so a refusal names where it happened without a copy of the path per step.
 * The key is popped when the child's read ends, whether it returns or throws.
 */
class DecodePath {
	readonly #keys: Array<string | number> = []

	/** What the decode decodes: the label of the location `located` gives a node its input leaves unlocated. */
	readonly subject: string

	/** The containers on the path of the decode, so a value already on it is refused as a cycle. */
	readonly onPath = new Set<object>()

	/**
	 * The containers on the path of the conformance (conformWith), outermost first: container i stands at depth i. It is
	 * read only when the nesting bound is reached, to tell a cycle from depth.
	 */
	readonly conformPath: Array<object> = []

	constructor(subject: string) {
		this.subject = subject
	}

	/** The number of containers above the value: its nesting depth. */
	get depth(): number {
		return this.#keys.length
	}

	/** The keys from the root to the value, a copy. */
	get keys(): Path {
		return [...this.#keys]
	}

	/** `read` run on the child at `key`. */
	at<A>(key: string | number, read: () => A): A {
		this.#keys.push(key)
		try {
			return read()
		} finally {
			this.#keys.pop()
		}
	}
}

/** The keys of a path a refusal names. */
const keysOf = (at: Path | DecodePath): Path => (at instanceof DecodePath ? at.keys : [...at])

/**
 * Structural decoders for the Description boundary and the IR.
 *
 * The compiler rejects malformed runtime descriptions even when they appear to have the expected TypeScript type, so every Description and every IR value therefore has a Shape: a decoder from unknown input to an owned, frozen
 * copy, or a MalformedDescription naming the path of the first offending value. A Shape is written beside the
 * interface it decodes and annotated with it, so the type checker keeps the two in step.
 *
 * Shapes are strict: an object with a property its shape does not name is refused, so a misspelled optional field is
 * an error rather than a silently ignored one. No shape accepts null, which exists at no layer.
 *
 * An in-memory value can be nested arbitrarily deep or be cyclic, which its text or JSON form cannot. The decoders
 * therefore bound the nesting as the kernel does: a container nested deeper than maxNestingDepth is ResourceBound,
 * and a container that contains itself is refused as cyclic, so the in-memory path fails exactly where
 * the text path does and never overflows the stack.
 *
 * Decoding is idempotent: every container shape returns a fresh frozen copy built only from its fields' decoded values,
 * and every check it makes reads only the decoded value, so decoding that copy again with the same shape accepts it and
 * yields an equal fresh copy, key order included. No shape recognises its own output: each decode reads the whole
 * value, and a caller holding a decoded value keeps it rather than decoding it again.
 */
export interface Shape<A> {
	/** What the shape accepts, for diagnostics. */
	readonly expected: string
	/** Decodes `value` found at `path`, throwing a Mismatch on the first mismatch. Only `decodeWith` catches it. */
	readonly parse: (value: unknown, path: DecodePath) => A
	/**
	 * What a tagged union's case reads of `value`, the property `skip` (the union's discriminator) passed over: a
	 * struct's fields read from `value` itself, the same checks in the same order as `parse` makes after its object
	 * checks (the struct shapes and a located struct); any other shape's parse of a copy without `skip` (plain).
	 */
	readonly fields: (value: Readonly<Record<string, unknown>>, path: DecodePath, skip: string) => A
	/**
	 * Whether `value`, a value of the decoded type this package's own code built, is its own decoded form (conformWith):
	 * the checks `parse` makes, in its order, refusing where it refuses, over every container, with no copy. True when
	 * each container in `value` holds what its decoded copy would hold, key order aside, so `value` is an A; each
	 * container is then frozen. False, at the first member in parse's order whose decoded form is not itself (a copy
	 * that differs: a member's own decoded form differs, a stated member is left out, an optional one is stated
	 * undefined, a symbol key a copy drops), for the caller to decode in full; nothing after that member is checked
	 * here, so every refusal is the one parse makes first. A shape whose decoded form is never its input (a located
	 * node, a normalized value) is "decoded": no value is its own decoded form there (conforms).
	 */
	readonly conform: ((value: unknown, path: DecodePath) => value is A) | "decoded"
	/**
	 * conform of a tagged union's case read from `value` itself, the discriminators `skip` passed over, as `fields` reads
	 * a struct: a struct's, and a tagged union's, so a union can be the case of another. Any other shape is never shown
	 * its own decoded form as a case (notInPlace), since parse decodes such a case from a copy without the discriminator.
	 */
	readonly conformFields: (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: ReadonlyArray<string>
	) => boolean
}

/** One shape per property of R: the fields of a struct, the cases of a tagged union, the members of a union. */
export type ShapesOf<R> = { readonly [K in keyof R]: Shape<R[K]> }

/** The keys of a record of shapes, in its order, each a key of the shapes' type, which Object.keys types as any string. */
const stringKeys = <R>(shapes: ShapesOf<R>): ReadonlyArray<keyof R & string> =>
	Object.keys(shapes).filter((key): key is keyof R & string => Object.hasOwn(shapes, key))

export const malformedAt = (subject: string, path: Path, capability: string): CompileError =>
	malformedDescription(SourceLoc(subject, path), capability)

/**
 * Internal control flow: thrown at the first mismatch deep inside a decode and caught by decodeWith (or by a union
 * trying its next alternative). It never escapes this module's exported functions.
 */
class Mismatch extends Error {
	readonly path: Path
	readonly capability: string

	constructor(fields: { readonly path: Path; readonly capability: string }) {
		super()
		this.path = fields.path
		this.capability = fields.capability
	}
}

/** conformFields of a shape that is no struct or tagged union. */
export const notInPlace = (): boolean => false

/** Whether `value` is its own decoded form under `shape` (Shape.conform): never under a "decoded" shape. */
const conforms = <A>(shape: ShapeParts<A>, value: unknown, path: DecodePath): value is A =>
	shape.conform !== "decoded" && shape.conform(value, path)

/** A shape but for what a tagged union's case reads of it (fields): the parts plain completes. */
export type ShapeParts<A> = Omit<Shape<A>, "fields">

/**
 * A shape that is no struct, whose fields as a tagged union's case are its parse of a copy without the discriminator:
 * the copy is a fresh object, so the caller's value stands on the path for it.
 */
export const plain = <A>(shape: ShapeParts<A>): Shape<A> => ({
	...shape,
	fields: (value, path, skip) => {
		const rest: Record<string, unknown> = {}
		for (const k of Object.keys(value)) {
			if (k !== skip) {
				setOwn(rest, k, value[k])
			}
		}
		return shape.parse(rest, path)
	}
})

export const refuse = (at: Path | DecodePath, capability: string): never => {
	throw new Mismatch({ path: keysOf(at), capability })
}

/**
 * Internal control flow for a refusal no alternative can repair (a resource bound, a cycle): a union does not try its
 * next alternative on it, so it reaches decodeWith unchanged.
 */
class Abort extends Error {
	readonly path: Path
	readonly why: AbortCause

	constructor(fields: { readonly path: Path; readonly why: AbortCause }) {
		super()
		this.path = fields.path
		this.why = fields.why
	}
}

/** Why a decode stopped where no alternative repairs it: a container nested too deep, or a value malformed for `what`. */
type AbortCause =
	| { readonly kind: "nesting" }
	| { readonly kind: "malformed"; readonly what: string }

const abort = (at: DecodePath | Path, cause: AbortCause): never => {
	throw new Abort({ path: keysOf(at), why: cause })
}

const nested: AbortCause = { kind: "nesting" }
const cyclic: AbortCause = { kind: "malformed", what: "an acyclic value" }

/**
 * Decodes the container `value` at `path` with `f`: refused past maxNestingDepth or when `value` is already on the
 * path. The path holds one segment per container above this one, so its length is the nesting depth.
 */
const within = <A>(value: object, path: DecodePath, f: () => A): A => {
	if (path.onPath.has(value)) {
		abort(path, cyclic)
	}
	if (path.depth >= maxNestingDepth) {
		abort(path, nested)
	}
	path.onPath.add(value)
	try {
		return f()
	} finally {
		path.onPath.delete(value)
	}
}

/**
 * conform's `within`: the container `value` at `path`, refused past maxNestingDepth. A value built bottom up never
 * contains itself, so the cycle check `within` makes on every container waits for the bound, which a cycle always
 * reaches: there the first container that is already on the path is refused, at the path where `within` refuses it.
 */
const conformWithin = <A>(value: object, path: DecodePath, f: () => A): A => {
	if (path.depth >= maxNestingDepth) {
		const containers = [...path.conformPath, value]
		for (const [i, c] of containers.entries()) {
			if (containers.indexOf(c) !== i) {
				abort(path.keys.slice(0, i), cyclic)
			}
		}
		abort(path, nested)
	}
	path.conformPath.push(value)
	try {
		return f()
	} finally {
		path.conformPath.pop()
	}
}

/**
 * Runs `work` as a decode at the root, as a Result, on a path of its own: its path set, conformance path and subject.
 * `what` names what is being decoded in the error location ("query description at arms[0].head.total").
 */
const atRoot = <A>(what: string, work: (path: DecodePath) => A): Result.Result<A, CompileError> => {
	try {
		return Result.ok(work(new DecodePath(what)))
	} catch (caught) {
		if (caught instanceof Mismatch) {
			return Result.err(malformedAt(what, caught.path, caught.capability))
		}
		if (caught instanceof Abort) {
			const at = SourceLoc(what, caught.path)
			return Result.err(
				caught.why.kind === "nesting"
					? resourceBound(at, { kind: "nesting", limit: maxNestingDepth })
					: malformedDescription(at, caught.why.what)
			)
		}
		if (caught instanceof Refusal) {
			return Result.err(caught.error)
		}
		throw caught
	}
}

/**
 * Runs a shape at the root, as a Result. `what` names what is being decoded in the error location
 * ("query description at arms[0].head.total").
 */
export const decodeWith = <A>(
	shape: Shape<A>,
	value: unknown,
	what: string
): Result.Result<A, CompileError> => atRoot(what, (path) => shape.parse(value, path))

/**
 * The decoded form of `value`, a value of the decoded type that this package's own code built: what decodeWith gives
 * for it, up to key order. Its static type is the proof that no caller's code built it, so no read of it runs a caller's
 * proxy or getter; the shape's checks still run over every container. A value that is its own decoded form (conform)
 * is kept as it is, frozen throughout, with no copy; any other is decoded. A refusal, at the first offending value in
 * parse's order as decodeWith names it, is the builder's defect, never a refusal of anyone's input.
 */
export const conformWith = <A>(shape: Shape<A>, value: A, what: string): A => {
	const shown = atRoot(what, (path) => conforms(shape, value, path))
	if (shown.ok && shown.value) {
		return value
	}
	const decoded = Result.flatMap(shown, () => decodeWith(shape, value, what))
	if (!decoded.ok) {
		throw defect(`a value this package built has its shape: ${decoded.error.message}`)
	}
	return decoded.value
}

/**
 * Reads the caller's value at `path`. A read runs the caller's code (a proxy's traps, a getter), and its throw refuses
 * the value there (core/host.ts hostRead), which no union alternative repairs. Every read of a value being decoded goes
 * through here, so a throw anywhere else in a decode is the decoder's own and escapes decodeWith as the defect it is.
 */
const unreadable = "a value whose reading throws nothing: no refusing proxy or getter"
const readAt = <A>(path: DecodePath, read: () => A): A => {
	const r = hostRead(unreadable, () => Result.ok(read()))
	return r.ok ? r.value : abort(path, { kind: "malformed", what: r.error })
}

const describe = (value: unknown, path: DecodePath): string =>
	readAt(path, () => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value))

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * A caller's plain object, read once: a fresh copy of its own string-keyed properties in key order, and whether it
 * holds a symbol key. Decoding reads only the copy, so the caller's code runs here and nowhere else; the object itself
 * (`container`) stands on the path, for the cycle check.
 */
type ObjectRead =
	| {
			readonly kind: "object"
			readonly container: object
			readonly copy: Readonly<Record<string, unknown>>
			readonly symbols: boolean
	  }
	| { readonly kind: "other" }

const readObject = (value: unknown, path: DecodePath): ObjectRead =>
	readAt(path, (): ObjectRead => {
		if (!isPlainObject(value)) {
			return { kind: "other" }
		}
		const copy: Record<string, unknown> = {}
		for (const key of Object.keys(value)) {
			setOwn(copy, key, value[key])
		}
		return {
			kind: "object",
			container: value,
			copy,
			symbols: Object.getOwnPropertySymbols(value).length > 0
		}
	})

/** A caller's array, read once: its items in order, or the first hole, or no array. */
type ArrayRead =
	| { readonly kind: "array"; readonly container: object; readonly items: ReadonlyArray<unknown> }
	| { readonly kind: "hole"; readonly at: number }
	| { readonly kind: "other" }

const readArray = (value: unknown, path: DecodePath): ArrayRead =>
	readAt(path, (): ArrayRead => {
		if (!Array.isArray(value)) {
			return { kind: "other" }
		}
		const items: Array<unknown> = []
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) {
				return { kind: "hole", at: i }
			}
			items.push(value[i])
		}
		return { kind: "array", container: value, items }
	})

/**
 * Own enumerable string-keyed properties, defined so that "__proto__" stays an ordinary key. Every target is a fresh
 * plain object that is frozen once filled (or a scratch copy never written again), so an ordinary assignment, whose
 * property freezing makes read-only and non-configurable, is the same property; only "__proto__" needs defining,
 * because assigning it would set the prototype.
 */
const setOwn = <T extends object, K extends keyof T & string>(
	target: T,
	key: K,
	value: T[K]
): void => {
	if (key === "__proto__") {
		Object.defineProperty(target, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: false
		})
	} else {
		target[key] = value
	}
}

/**
 * A source location as a decode keeps it: frozen with its path and call site, so a value holding one is frozen
 * throughout. A path or call site already frozen is shared, since it cannot change.
 */
const keptLoc = (loc: SourceLoc): SourceLoc =>
	Object.freeze({
		path: Object.isFrozen(loc.path) ? loc.path : Object.freeze(loc.path.slice()),
		label: loc.label,
		site:
			loc.site === undefined || Object.isFrozen(loc.site)
				? loc.site
				: Object.freeze({ ...loc.site })
	})

/** A SourceLoc, kept: excluded from identity, retained for diagnostics. */
export const sourceLoc: Shape<SourceLoc> = plain({
	expected: "a source location",
	parse: (value, path) =>
		readAt(path, () => {
			const loc = parseSourceLoc(value)
			return loc === undefined ? undefined : keptLoc(loc)
		}) ?? refuse(path, "a source location"),
	/**
	 * A location this package built is its own, so it is frozen where it stands, with its path and call site, rather
	 * than copied: the same content, frozen throughout.
	 */
	conform: (value, path): value is SourceLoc => {
		const loc = parseSourceLoc(value)
		if (loc === undefined) {
			return refuse(path, "a source location")
		}
		Object.freeze(loc.path)
		if (loc.site !== undefined) {
			Object.freeze(loc.site)
		}
		Object.freeze(value)
		return true
	},
	conformFields: notInPlace
})

/**
 * A shape of a value that is no container: its decode hands the value itself back, so a value it accepts is its own
 * decoded form.
 */
const leaf = <A>(expected: string, parse: (value: unknown, path: DecodePath) => A): Shape<A> =>
	plain({
		expected,
		parse,
		conform: (value, path): value is A => {
			parse(value, path)
			return true
		},
		conformFields: notInPlace
	})

/** A property no value states: as a stated field it decodes to undefined, and any value there is refused. */
export const nothing: Shape<never> = leaf("no value", (value, path) =>
	refuse(path, `no value here, not ${describe(value, path)}`)
)

export const string: Shape<string> = leaf("a string", (value, path) =>
	typeof value === "string" ? value : refuse(path, `a string, not ${describe(value, path)}`)
)

export const nonEmptyString: Shape<string> = leaf("a nonempty string", (value, path) => {
	const text = string.parse(value, path)
	return text.length > 0 ? text : refuse(path, "a nonempty string")
})

export const boolean: Shape<boolean> = leaf("a boolean", (value, path) =>
	typeof value === "boolean" ? value : refuse(path, `a boolean, not ${describe(value, path)}`)
)

export const finiteNumber: Shape<number> = leaf("a finite number", (value, path) =>
	typeof value === "number" && Number.isFinite(value)
		? value
		: refuse(path, `a finite number, not ${describe(value, path)}`)
)

/**
 * A finite number with the one zero (ir/carriers.ts CanonicalFloat): -0 is refused, so a decoded float literal is in
 * its one form, as the canonical serializer, which writes -0 as 0, and every constructor leave it.
 */
export const canonicalFloat: Shape<CanonicalFloat> = leaf(
	"a finite number other than -0",
	(value, path) =>
		typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
			? canonicalZero(value)
			: refuse(path, `a finite number other than -0, not ${describe(value, path)}`)
)

export const integer: Shape<number> = leaf("a safe integer", (value, path) =>
	typeof value === "number" && Number.isSafeInteger(value)
		? value
		: refuse(path, `a safe integer, not ${describe(value, path)}`)
)

export const nonNegativeInteger: Shape<number> = leaf(
	"a nonnegative safe integer",
	(value, path) => {
		const n = integer.parse(value, path)
		return n >= 0 ? n : refuse(path, "a nonnegative integer")
	}
)

export const positiveInteger: Shape<number> = leaf("a positive safe integer", (value, path) => {
	const n = integer.parse(value, path)
	return n > 0 ? n : refuse(path, "a positive integer")
})

export const bigint: Shape<bigint> = leaf("a bigint", (value, path) =>
	typeof value === "bigint" ? value : refuse(path, `a bigint, not ${describe(value, path)}`)
)

export const literalsShape = <const L extends ReadonlyArray<string | number | boolean>>(
	values: L
): Shape<L[number]> => {
	const expected = values.map((v) => JSON.stringify(v)).join(" | ")
	const members: ReadonlyArray<unknown> = values
	/** Membership by includes (SameValueZero) in the very list L types. */
	const isMember = (value: unknown): value is L[number] => members.includes(value)
	return leaf(expected, (value, path) =>
		isMember(value)
			? value
			: refuse(
					path,
					`one of ${expected}, not ${typeof value === "string" ? JSON.stringify(value) : describe(value, path)}`
				)
	)
}

/**
 * A brand applied to a decoded string by the brand's constructor (core/ids.ts): the position holds an identifier of
 * that kind.
 */
export const branded = <B extends string>(
	brand: (value: string) => B,
	shape: Shape<string>
): Shape<B> =>
	plain({
		expected: shape.expected,
		parse: (value, path) => brand(shape.parse(value, path)),
		/** A brand is the decoded string itself, so a string its own decoded form is one of the brand's. */
		conform: (value, path): value is B => conforms(shape, value, path),
		conformFields: notInPlace
	})

export const refine = <A>(
	shape: Shape<A>,
	test: (value: A) => boolean,
	expected: string
): Shape<A> =>
	plain({
		expected,
		parse: (value, path) => {
			const out = shape.parse(value, path)
			return test(out) ? out : refuse(path, expected)
		},
		/** The test reads the value itself, which is its own decoded form once the shape conforms it. */
		conform: (value, path): value is A =>
			conforms(shape, value, path) && (test(value) || refuse(path, expected)),
		conformFields: notInPlace
	})

/**
 * A decoded value whose parts agree with each other, which `audit` checks over the decoded value: it refuses (refuse) at
 * the path of the first part that breaks the agreement, naming that part, and returns otherwise.
 */
export const audited = <A>(shape: Shape<A>, audit: (value: A, path: Path) => void): Shape<A> =>
	plain({
		expected: shape.expected,
		parse: (value, path) => {
			const out = shape.parse(value, path)
			audit(out, path.keys)
			return out
		},
		/** The audit reads the value itself, as refine's test does. */
		conform: (value, path): value is A => {
			if (!conforms(shape, value, path)) {
				return false
			}
			audit(value, path.keys)
			return true
		},
		conformFields: notInPlace
	})

/**
 * A decoded value normalized into its internal form: the boundary's one place to fill a documented default, so no
 * consumer re-defaults it. The result is frozen like every decoded value.
 */
export const normalized = <A, B>(shape: Shape<A>, normalize: (value: A) => B): Shape<B> =>
	plain({
		expected: shape.expected,
		parse: (value, path) => Object.freeze(normalize(shape.parse(value, path))),
		/** A normalized value is the decode of its input, never shown its own decoded form in place: decode it. */
		conform: "decoded",
		conformFields: notInPlace
	})

/**
 * A value of a fixed set of interned instances, decoded to the one instance its parts name, so equal values are one
 * value. A value is its own decoded form exactly when it is that instance.
 */
export const interned = <P, A extends object>(
	parts: Shape<P>,
	instance: (parts: P) => A
): Shape<A> =>
	plain({
		expected: parts.expected,
		parse: (value, path) => instance(parts.parse(value, path)),
		conform: (value, path): value is A => instance(parts.parse(value, path)) === value,
		conformFields: notInPlace
	})

/** Freezes `value` and answers true: what a container's conform does once every member is its own decoded form. */
const frozen = (value: object): boolean => {
	Object.freeze(value)
	return true
}

/** The first index below the array's length that holds no element, or undefined when there is none. */
const firstHole = (items: ReadonlyArray<unknown>): number | undefined => {
	for (let i = 0; i < items.length; i++) {
		if (!(i in items)) {
			return i
		}
	}
	return undefined
}

/** The array decoders below are built from these parts, which plain completes once, at the outside. */
const arrayOf = <A>(item: Shape<A>): ShapeParts<ReadonlyArray<A>> => ({
	expected: `an array of ${item.expected}`,
	parse: (value, path) => {
		const read = readArray(value, path)
		if (read.kind === "other") {
			return refuse(path, `an array, not ${describe(value, path)}`)
		}
		if (read.kind === "hole") {
			return path.at(read.at, () => refuse(path, "an array element, not a hole"))
		}
		return within(read.container, path, () =>
			Object.freeze(read.items.map((child, i) => path.at(i, () => item.parse(child, path))))
		)
	},
	/** The decoded copy is a plain array, so an array of another prototype is not its own decoded form. */
	conform: (value, path): value is ReadonlyArray<A> => {
		if (!Array.isArray(value)) {
			return refuse(path, `an array, not ${describe(value, path)}`)
		}
		const items: ReadonlyArray<unknown> = value
		const hole = firstHole(items)
		if (hole !== undefined) {
			return path.at(hole, () => refuse(path, "an array element, not a hole"))
		}
		if (Object.getPrototypeOf(items) !== Array.prototype) {
			return false
		}
		return conformWithin(
			items,
			path,
			() =>
				items.every((child, i) => path.at(i, () => conforms(item, child, path))) && frozen(items)
		)
	},
	conformFields: notInPlace
})

/** A length check, which is what the nonempty tuple type records. */
const isNonEmpty = <A>(values: ReadonlyArray<A>): values is readonly [A, ...Array<A>] =>
	values.length > 0

const nonEmptyOf = <A>(
	inner: ShapeParts<ReadonlyArray<A>>,
	expected: string,
	capability: string
): ShapeParts<readonly [A, ...Array<A>]> => ({
	expected,
	parse: (value, path) => {
		const out = inner.parse(value, path)
		return isNonEmpty(out) ? out : refuse(path, capability)
	},
	conform: (value, path): value is readonly [A, ...Array<A>] =>
		conforms(inner, value, path) && (value.length > 0 || refuse(path, capability)),
	conformFields: notInPlace
})

const distinctOf = <A>(
	item: Shape<A>,
	key: (a: A) => string,
	what: string
): ShapeParts<ReadonlyArray<A>> => {
	const inner = arrayOf(item)
	/** Refuses the first item whose key repeats an earlier one's. */
	const seenAt = (seen: Set<string>, a: A, path: DecodePath, i: number): void => {
		const k = key(a)
		if (seen.has(k)) {
			path.at(i, () => refuse(path, `distinct ${what}; ${JSON.stringify(k)} repeats`))
		}
		seen.add(k)
	}
	return {
		expected: `an array of distinct ${what}`,
		parse: (value, path) => {
			const out = inner.parse(value, path)
			const seen = new Set<string>()
			for (const [i, a] of out.entries()) {
				seenAt(seen, a, path, i)
			}
			return out
		},
		/** The keys are read from the items themselves, each its own decoded form once the array conforms. */
		conform: (value, path): value is ReadonlyArray<A> => {
			if (!conforms(inner, value, path)) {
				return false
			}
			const seen = new Set<string>()
			for (const [i, a] of value.entries()) {
				seenAt(seen, a, path, i)
			}
			return true
		},
		conformFields: notInPlace
	}
}

export const array = <A>(item: Shape<A>): Shape<ReadonlyArray<A>> => plain(arrayOf(item))

export const nonEmptyArray = <A>(item: Shape<A>): Shape<readonly [A, ...Array<A>]> =>
	plain(nonEmptyOf(arrayOf(item), `a nonempty array of ${item.expected}`, "a nonempty array"))

/**
 * An array of exactly `n` items, built into its tuple by `of`: a count other than `n` is refused before any item is
 * decoded.
 */
const sized = <A, T>(
	item: Shape<A>,
	n: number,
	of: (items: ReadonlyArray<A>) => T | undefined
): Shape<T> => {
	const inner = arrayOf(item)
	const expected = n === 0 ? "an empty array" : `an array of exactly ${n} ${item.expected}`
	return plain({
		expected,
		parse: (value, path) => {
			const length = readAt(path, () => (Array.isArray(value) ? value.length : n))
			if (length !== n) {
				return refuse(path, `${expected}, not ${length}`)
			}
			return of(inner.parse(value, path)) ?? refuse(path, expected)
		},
		/**
		 * No item shape accepts undefined, so `of` builds its tuple of any n items the array conforms: a frozen array of
		 * the same items.
		 */
		conform: (value, path): value is T => {
			const length = Array.isArray(value) ? value.length : n
			if (length !== n) {
				return refuse(path, `${expected}, not ${length}`)
			}
			return conforms(inner, value, path)
		},
		conformFields: notInPlace
	})
}

const noItems: readonly [] = Object.freeze([] as const)

export const empty = <A>(item: Shape<A>): Shape<readonly []> => sized(item, 0, () => noItems)

export const single = <A>(item: Shape<A>): Shape<readonly [A]> =>
	sized(item, 1, ([a]) => (a === undefined ? undefined : Object.freeze([a] as const)))

export const pairShape = <A>(item: Shape<A>): Shape<readonly [A, A]> =>
	sized(item, 2, ([a, b]) =>
		a === undefined || b === undefined ? undefined : Object.freeze([a, b] as const)
	)

export const tripleShape = <A>(item: Shape<A>): Shape<readonly [A, A, A]> =>
	sized(item, 3, ([a, b, c]) =>
		a === undefined || b === undefined || c === undefined
			? undefined
			: Object.freeze([a, b, c] as const)
	)

/** An array whose elements are pairwise distinct under `key`. */
export const uniqueArray = <A>(
	item: Shape<A>,
	key: (a: A) => string,
	what: string
): Shape<ReadonlyArray<A>> => plain(distinctOf(item, key, what))

/** A nonempty array whose elements are pairwise distinct under `key`. */
export const nonEmptyUniqueArray = <A>(
	item: Shape<A>,
	key: (a: A) => string,
	what: string
): Shape<readonly [A, ...Array<A>]> =>
	plain(
		nonEmptyOf(
			distinctOf(item, key, what),
			`a nonempty array of distinct ${what}`,
			`at least one of ${what}`
		)
	)

export const uniqueStrings = (what: string, item: Shape<string>): Shape<ReadonlyArray<string>> =>
	uniqueArray(item, (s) => s, what)

/** Distinct identifiers of one brand, each decoded by `item` (a branded shape). */
export const uniqueIds = <B extends string>(
	what: string,
	item: Shape<B>
): Shape<ReadonlyArray<B>> => uniqueArray(item, (s) => s, what)

export const nonEmptyUniqueStrings = (what: string): Shape<readonly [string, ...Array<string>]> =>
	plain(
		nonEmptyOf(
			distinctOf(nonEmptyString, (s) => s, what),
			`a nonempty array of distinct ${what}`,
			`at least one ${what}`
		)
	)

/** A plain object used as a map from nonempty names to values. */
export const recordShape = <A>(
	item: Shape<A>,
	keyShape: Shape<string>
): Shape<Readonly<Record<string, A>>> =>
	plain({
		expected: `an object of ${item.expected}`,
		parse: (value, path) => {
			const read = readObject(value, path)
			if (read.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			const fields = read.copy
			return within(read.container, path, () => {
				const out: Record<string, A> = {}
				for (const key of Object.keys(fields)) {
					setOwn(
						out,
						key,
						path.at(key, () => {
							keyShape.parse(key, path)
							const child = fields[key]
							return child === undefined
								? refuse(path, "a value, not undefined")
								: item.parse(child, path)
						})
					)
				}
				return Object.freeze(out)
			})
		},
		/** The decoded copy holds the string keys alone, so an object with a symbol key is not its own decoded form. */
		conform: (value, path): value is Readonly<Record<string, A>> => {
			if (!isPlainObject(value)) {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			if (Object.getOwnPropertySymbols(value).length > 0) {
				return false
			}
			return conformWithin(
				value,
				path,
				() =>
					Object.keys(value).every((key) =>
						path.at(key, () => {
							keyShape.parse(key, path)
							const child = value[key]
							return child === undefined
								? refuse(path, "a value, not undefined")
								: conforms(item, child, path)
						})
					) && frozen(value)
			)
		},
		conformFields: notInPlace
	})

type Simplify<T> = { [K in keyof T]: T[K] }
type StructOf<R, O> = Simplify<
	{ readonly [K in keyof R & string]: R[K] } & { readonly [K in keyof O & string]?: O[K] }
>

type StatedOf<R, U, O> = Simplify<
	{ readonly [K in keyof R & string]: R[K] } & {
		readonly [K in keyof U & string]: U[K] | undefined
	} & {
		readonly [K in keyof O & string]?: O[K]
	}
>

/** A struct's field names, which a tagged union reads directly from the object it decodes. */
interface StructNames {
	readonly names: ReadonlyArray<string>
	readonly isField: (key: string) => boolean
}

/**
 * Refuses a property the struct does not name. A property named `skip`, a tagged union's discriminator, is not the
 * struct's and is passed over.
 */
const checkStructKeys = (
	parts: StructNames,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): void => {
	for (const key of Object.keys(value)) {
		if (key !== skip && !parts.isField(key)) {
			unknownKey(parts, path, key)
		}
	}
}

const unknownKey = (parts: StructNames, path: DecodePath, key: string): never =>
	path.at(key, () =>
		refuse(path, `no property ${JSON.stringify(key)}; expected ${parts.names.join(", ")}`)
	)

/**
 * checkStructKeys for conform, every discriminator in `skip` passed over: a struct read from a value of nested tagged
 * unions passes over each union's discriminator, as each union's copy of the value leaves it out.
 */
const conformKeys = (
	parts: StructNames,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: ReadonlyArray<string>
): void => {
	for (const key of Object.keys(value)) {
		if (!skip.includes(key) && !parts.isField(key)) {
			unknownKey(parts, path, key)
		}
	}
}

/**
 * What a struct's decoded copy holds for a member the value leaves out (or states undefined): a required member is
 * refused, a stated one is stated undefined, an optional one is left out.
 */
type Absent = "refused" | "stated" | "optional"

/**
 * Whether the decoded copy of `value` holds what `value` does for the member `key` it leaves out (or states undefined,
 * or names as a discriminator in `skip`): a required member is refused there.
 */
const absentConforms = (
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	key: string,
	skipped: boolean,
	absent: Absent
): boolean => {
	if (absent === "refused") {
		return path.at(key, () => refuse(path, `the required property ${JSON.stringify(key)}`))
	}
	const own = !skipped && Object.hasOwn(value, key)
	return absent === "stated" ? own : !own
}

/**
 * conform of a struct's members of one kind, in the struct's order, read from `value` itself, a discriminator in
 * `skip` counted absent: false at the first member whose decoded form is not itself or that the decoded copy holds
 * otherwise (a stated member left out, an optional one stated undefined).
 */
const conformMembers = <G>(
	shapes: ShapesOf<G>,
	keys: ReadonlyArray<keyof G & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: ReadonlyArray<string>,
	absent: Absent
): boolean => {
	for (const key of keys) {
		const skipped = skip.includes(key)
		const child = skipped ? undefined : value[key]
		const shown =
			child === undefined
				? absentConforms(value, path, key, skipped, absent)
				: path.at(key, () => conforms(shapes[key], child, path))
		if (!shown) {
			return false
		}
	}
	return true
}

const noSkip: ReadonlyArray<string> = Object.freeze([])

/**
 * conform of a struct whose members `members` reads: the object checks parse makes, then the members inside the
 * value's place on the path, and the value frozen.
 */
const conformStruct = (
	parts: StructNames,
	value: unknown,
	path: DecodePath,
	members: (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: ReadonlyArray<string>
	) => boolean
): boolean => {
	if (!isPlainObject(value)) {
		return refuse(path, `a plain object, not ${describe(value, path)}`)
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		refuse(path, "an object without symbol keys")
	}
	conformKeys(parts, value, path, noSkip)
	return conformWithin(value, path, () => members(value, path, noSkip) && frozen(value))
}

/**
 * A struct's record, filled by a loop that sets every key of its key list: the one site of the fact that a struct's key
 * list (stringKeys, the own keys of the record of shapes its type is built from) is every key of that record. No type
 * of an array of keys says it covers a record type, so the filled record is checked complete.
 */
const filled = <T>(keys: ReadonlyArray<keyof T & string>, out: Partial<T>): T => {
	const complete = (o: Partial<T>): o is T => keys.every((key) => Object.hasOwn(o, key))
	if (!complete(out)) {
		throw defect("struct: every key of its key list was set")
	}
	return out
}

/**
 * The required fields of `value` decoded in the struct's order; a field named `skip` counts as absent and is refused.
 */
const readRequired = <R>(
	shapes: ShapesOf<R>,
	keys: ReadonlyArray<keyof R & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): { readonly [K in keyof R & string]: R[K] } => {
	const out: { [K in keyof R & string]?: R[K] } = {}
	for (const key of keys) {
		setOwn(
			out,
			key,
			path.at(key, () => {
				const child = key === skip ? undefined : value[key]
				return child === undefined
					? refuse(path, `the required property ${JSON.stringify(key)}`)
					: shapes[key].parse(child, path)
			})
		)
	}
	return filled<{ readonly [K in keyof R & string]: R[K] }>(keys, out)
}

/** The optional fields of `value` that are present, in the struct's order; a field named `skip` counts as absent. */
const readOptional = <O>(
	shapes: ShapesOf<O>,
	keys: ReadonlyArray<keyof O & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): { readonly [K in keyof O & string]?: O[K] } => {
	const out: { [K in keyof O & string]?: O[K] } = {}
	for (const key of keys) {
		const child = key === skip ? undefined : value[key]
		if (child !== undefined) {
			setOwn(
				out,
				key,
				path.at(key, () => shapes[key].parse(child, path))
			)
		}
	}
	return out
}

/**
 * The stated fields of `value`, in the struct's order, each undefined where the value leaves it out or names the
 * struct's `skip`.
 */
const readStated = <U>(
	shapes: ShapesOf<U>,
	keys: ReadonlyArray<keyof U & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): { readonly [K in keyof U & string]: U[K] | undefined } => {
	const out: { [K in keyof U & string]?: U[K] | undefined } = {}
	for (const key of keys) {
		const child = key === skip ? undefined : value[key]
		setOwn(
			out,
			key,
			child === undefined ? undefined : path.at(key, () => shapes[key].parse(child, path))
		)
	}
	return filled<{ readonly [K in keyof U & string]: U[K] | undefined }>(keys, out)
}

/** A strict object of required fields only, no other property. */
export const struct = <R>(
	required: ShapesOf<R>
): Shape<NoInfer<Simplify<{ readonly [K in keyof R & string]: R[K] }>>> => structWith(required, {})

/**
 * A strict object: every required field present, each optional field absent or valid, no other property. An optional
 * field is one a JavaScript-authored input may leave out; the decoded value leaves it out too.
 */
export const structWith = <R, O>(
	required: ShapesOf<R>,
	optional: ShapesOf<O>
): Shape<NoInfer<StructOf<R, O>>> => {
	const requiredKeys = stringKeys(required)
	const optionalKeys = stringKeys(optional)
	const parts: StructNames = {
		names: [...requiredKeys, ...optionalKeys],
		isField: (key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)
	}
	const read = (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: string | undefined
	) => {
		const req = readRequired(required, requiredKeys, value, path, skip)
		return { ...req, ...readOptional(optional, optionalKeys, value, path, skip) }
	}
	const members = (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: ReadonlyArray<string>
	): boolean =>
		conformMembers(required, requiredKeys, value, path, skip, "refused") &&
		conformMembers(optional, optionalKeys, value, path, skip, "optional")
	return {
		expected: `an object with ${parts.names.length === 0 ? "no fields" : parts.names.join(", ")}`,
		parse: (value, path) => {
			const object = readObject(value, path)
			if (object.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			if (object.symbols) {
				refuse(path, "an object without symbol keys")
			}
			checkStructKeys(parts, object.copy, path, undefined)
			return within(object.container, path, () => Object.freeze(read(object.copy, path, undefined)))
		},
		fields: (value, path, skip) => {
			checkStructKeys(parts, value, path, skip)
			return read(value, path, skip)
		},
		conform: (value, path): value is StructOf<R, O> => conformStruct(parts, value, path, members),
		conformFields: (value, path, skip) => {
			conformKeys(parts, value, path, skip)
			return members(value, path, skip)
		}
	}
}

/**
 * A strict object like structWith whose `stated` fields an input may leave out but whose decoded value states every
 * one, undefined where the input leaves it out: an absence parsed once at the boundary into a property every
 * consumer reads, never into a missing one.
 */
export const structStated = <R, U, O>(
	required: ShapesOf<R>,
	stated: ShapesOf<U>,
	optional: ShapesOf<O>
): Shape<NoInfer<StatedOf<R, U, O>>> => {
	const requiredKeys = stringKeys(required)
	const statedKeys = stringKeys(stated)
	const optionalKeys = stringKeys(optional)
	const parts: StructNames = {
		names: [...requiredKeys, ...statedKeys, ...optionalKeys],
		isField: (key) =>
			Object.hasOwn(required, key) || Object.hasOwn(stated, key) || Object.hasOwn(optional, key)
	}
	const read = (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: string | undefined
	) => ({
		...readRequired(required, requiredKeys, value, path, skip),
		...readStated(stated, statedKeys, value, path, skip),
		...readOptional(optional, optionalKeys, value, path, skip)
	})
	const members = (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: ReadonlyArray<string>
	): boolean =>
		conformMembers(required, requiredKeys, value, path, skip, "refused") &&
		conformMembers(stated, statedKeys, value, path, skip, "stated") &&
		conformMembers(optional, optionalKeys, value, path, skip, "optional")
	return {
		expected: `an object with ${parts.names.length === 0 ? "no fields" : parts.names.join(", ")}`,
		parse: (value, path) => {
			const object = readObject(value, path)
			if (object.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			if (object.symbols) {
				refuse(path, "an object without symbol keys")
			}
			checkStructKeys(parts, object.copy, path, undefined)
			return within(object.container, path, () => Object.freeze(read(object.copy, path, undefined)))
		},
		fields: (value, path, skip) => {
			checkStructKeys(parts, value, path, skip)
			return read(value, path, skip)
		},
		conform: (value, path): value is StatedOf<R, U, O> =>
			conformStruct(parts, value, path, members),
		conformFields: (value, path, skip) => {
			conformKeys(parts, value, path, skip)
			return members(value, path, skip)
		}
	}
}

/** One case of a tagged union: the discriminator, then the case's fields. */
type TaggedCase<T extends string, M, K extends keyof M> = Simplify<{ readonly [P in T]: K } & M[K]>
type TaggedOf<T extends string, M> = { [K in keyof M & string]: TaggedCase<T, M, K> }[keyof M &
	string]

/**
 * The one-key object `{ [key]: value }`, typed by its key: TypeScript types a computed key of a generic type as any
 * string, so the object is minted as the record it is.
 */
const singleton = <const T extends string, V>(key: T, value: V): Readonly<Record<T, V>> =>
	nominal<Readonly<Record<string, V>>, Readonly<Record<T, V>>>()({ [key]: value })

/** A union discriminated by the string property `key`; each case decodes the object without that property. */
export const tagged = <const T extends string, M extends Readonly<Record<string, object>>>(
	key: T,
	cases: ShapesOf<M>
): Shape<TaggedOf<T, M>> => {
	const tags = Object.keys(cases)
	const isTag = (tag: string): tag is keyof M & string => Object.hasOwn(cases, tag)
	/**
	 * `value` is the caller's object, which stands on the path; `copy` is what was read of it, which the case decodes.
	 */
	const parseCase = <K extends keyof M & string>(
		tag: K,
		value: object,
		copy: Readonly<Record<string, unknown>>,
		path: DecodePath
	): { [P in K]: TaggedCase<T, M, P> }[K] => {
		const shape = cases[tag]
		const discriminator = singleton(key, tag)
		return within(value, path, () =>
			Object.freeze({ ...discriminator, ...shape.fields(copy, path, key) })
		)
	}
	const unknownTag = (path: DecodePath): never =>
		path.at(key, () => refuse(path, `one of ${tags.map((t) => JSON.stringify(t)).join(" | ")}`))
	/**
	 * The conformance of the case `value`'s discriminator names, read from `value` itself; an unknown discriminator is
	 * refused.
	 */
	const fieldsOf = (tag: keyof M & string) => cases[tag].conformFields
	const caseFields = (value: Readonly<Record<string, unknown>>, path: DecodePath) => {
		const tag = value[key]
		if (typeof tag !== "string" || !isTag(tag)) {
			return unknownTag(path)
		}
		return fieldsOf(tag)
	}
	const ownSkip: ReadonlyArray<string> = Object.freeze([key])
	return plain({
		expected: `an object with ${key} one of ${tags.join(", ")}`,
		parse: (value, path) => {
			const object = readObject(value, path)
			if (object.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			const tag = object.copy[key]
			if (typeof tag !== "string" || !isTag(tag)) {
				return unknownTag(path)
			}
			return parseCase(tag, object.container, object.copy, path)
		},
		/** The decoded copy holds the string keys alone, so an object with a symbol key is not its own decoded form. */
		conform: (value, path): value is TaggedOf<T, M> => {
			if (!isPlainObject(value)) {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			if (Object.getOwnPropertySymbols(value).length > 0) {
				return false
			}
			const fields = caseFields(value, path)
			return conformWithin(value, path, () => fields(value, path, ownSkip) && frozen(value))
		},
		/**
		 * As the case of another tagged union, read from the same value with that union's discriminator passed over.
		 */
		conformFields: (value, path, skip) => {
			const fields = caseFields(value, path)
			return fields(value, path, [...skip, key])
		}
	})
}

/** `run`'s result, or the Mismatch it throws, so a union can try its next alternative; any other throw propagates. */
const attempt = <A>(run: () => A): Result.Result<A, Mismatch> => {
	try {
		return Result.ok(run())
	} catch (caught) {
		if (caught instanceof Mismatch) {
			return Result.err(caught)
		}
		throw caught
	}
}

/** The first alternative that accepts the value; `expected` describes them all on failure. */
export const unionShape = <const M extends ReadonlyArray<unknown>>(
	...shapes: ShapesOf<M>
): Shape<M[number]> => {
	const members: ReadonlyArray<Shape<M[number]>> = shapes
	const expected = members.map((s) => s.expected).join(" or ")
	return plain({
		expected,
		parse: (value, path) => {
			for (const shape of members) {
				const out = attempt(() => shape.parse(value, path))
				if (out.ok) {
					return out.value
				}
			}
			return refuse(path, expected)
		},
		/**
		 * The first alternative whose conformance does not refuse decides, as the first whose decode does not refuse is
		 * the decode.
		 */
		conform: (value, path): value is M[number] => {
			for (const shape of members) {
				const shown = attempt(() => conforms(shape, value, path))
				if (shown.ok) {
					return shown.value
				}
			}
			return refuse(path, expected)
		},
		conformFields: notInPlace
	})
}

/**
 * A node that has a source location once decoded: the input's own `loc` (which `shape` decodes as an optional field),
 * or, when the input states none, the node's path in the value being decoded, under the decode's subject ("query
 * description at stage.arms[0]"). It is the boundary's one place to locate a Description node, so no consumer
 * re-defaults a location.
 */
export const located = <A extends object>(
	shape: Shape<A>
): Shape<A & { readonly loc: SourceLoc }> => {
	const locate = (out: A, path: DecodePath): A & { readonly loc: SourceLoc } => ({
		...out,
		loc: keptLoc(
			("loc" in out ? parseSourceLoc(out.loc) : undefined) ?? SourceLoc(path.subject, path.keys)
		)
	})
	return {
		expected: shape.expected,
		parse: (value, path) => Object.freeze(locate(shape.parse(value, path), path)),
		fields: (value, path, skip) => locate(shape.fields(value, path, skip), path),
		/** A located node is a Description's, decoded at the boundary and never shown its own decoded form in place. */
		conform: "decoded",
		conformFields: notInPlace
	}
}

/** Recursion: the shape is looked up when first used. */
export const lazy = <A>(expected: string, thunk: () => Shape<A>): Shape<A> => {
	let cached: Shape<A> | undefined
	return plain({
		expected,
		parse: (value, path) => {
			cached ??= thunk()
			return cached.parse(value, path)
		},
		conform: (value, path): value is A => {
			cached ??= thunk()
			return conforms(cached, value, path)
		},
		conformFields: notInPlace
	})
}

/**
 * A value implementing the canonical protocol with the given tag, parsed from its payload into the carrier `parse`
 * makes of a payload its grammar admits: the IR holds its literals parsed, whichever reviver its decode was given. A
 * value is its own decoded form exactly when it is already that carrier, which spells its payload from the fields that
 * payload parses back to (ir/carriers.ts); any other value carrying the payload, such as scalar/values' Money, decodes
 * to the carrier, so conformWith gives what decodeWith gives.
 */
export const canonicalParsed = <A>(
	tag: string,
	parse: (payload: string) => A | undefined,
	expected: string
): Shape<A> => {
	const parsed = (value: unknown, path: DecodePath): A => {
		const encoded = readAt(path, () => taggedValueOf(value))
		if (encoded === undefined) {
			return refuse(path, `${expected}, not ${describe(value, path)}`)
		}
		return (encoded.tag === tag ? parse(encoded.payload) : undefined) ?? refuse(path, expected)
	}
	return plain({
		expected,
		parse: parsed,
		conform: (value, path): value is A => {
			const carrier: unknown = Object.getPrototypeOf(parsed(value, path))
			const own: unknown = Object.getPrototypeOf(value)
			return carrier === own
		},
		conformFields: notInPlace
	})
}

/** A value implementing the canonical protocol with the given tag, kept as is (it is already an owned value). */
export const canonicalTagged = (
	tag: string,
	check: (payload: string) => boolean,
	expected: string
): Shape<Canonicalizable> =>
	leaf(expected, (value, path) => {
		const encoded = readAt(path, () => taggedValueOf(value))
		const canonical = readAt(
			path,
			():
				| { readonly kind: "canonical"; readonly value: Canonicalizable }
				| { readonly kind: "other" } =>
				isCanonicalizable(value) ? { kind: "canonical", value } : { kind: "other" }
		)
		if (encoded === undefined || canonical.kind === "other") {
			return refuse(path, `${expected}, not ${describe(value, path)}`)
		}
		if (encoded.tag !== tag || !check(encoded.payload)) {
			return refuse(path, expected)
		}
		return canonical.value
	})
