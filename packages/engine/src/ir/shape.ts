import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	isCanonicalizable,
	type Path,
	Refusal,
	taggedValueOf
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { isCapturedStack, parseSourceLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type CanonicalFloat, canonicalZero } from "#compiler/ir/carriers.ts"

export type { Path }

/**
 * A place in a value: the key of its last step and the place that step was taken from, back to the root, which is no
 * place at all (undefined). Taking a step is one cell, so a place is kept as it stands, never copied.
 */
interface Place {
	readonly key: string | number
	readonly from: Place | undefined
}

/** The keys of the steps to `place` from the root, in order. */
const keysTo = (place: Place | undefined): Path => {
	const keys: Array<string | number> = []
	for (let at = place; at !== undefined; at = at.from) {
		keys.push(at.key)
	}
	return keys.toReversed()
}

/**
 * What a decode refused, at the place it refused it: a mismatch, which a union's next alternative may repair, or an
 * abort, which none can (a cycle, a read that throws).
 */
interface Refused {
	readonly kind: "mismatch" | "abort"
	readonly place: Place | undefined
	readonly capability: string
}

/**
 * Internal control flow: the one value every refusal throws, unwinding the decode's steps to the union trying its next
 * alternative or to decodeWith, each of which reads what was refused from the decode's path (DecodePath.refuse). It is
 * built once, so a refusal builds no error and captures no stack. It never escapes this module's exported functions.
 */
class Unwinding extends Error {
	override readonly name = "Unwinding"
	override readonly message = "a decode unwinding for its refusal"
	override readonly stack = ""
	override readonly cause = undefined
}

const unwinding = new Unwinding()

/**
 * The path of the value a decode is reading, from the root: one per decode, onto which each container steps to a child
 * while it reads that child, so a refusal keeps where it happened as one cell (Place) and spells the keys only when it
 * is reported. The step is taken back when the child's read ends, whether it returns or throws.
 */
class DecodePath {
	#place: Place | undefined = undefined

	/** The refusal the decode is unwinding for (refuse), until a union or decodeWith takes it. */
	#refused: Refused | undefined = undefined

	/** What the decode decodes: the label of the location `located` gives a node its input leaves unlocated. */
	readonly subject: string

	/**
	 * The containers on the path of the decode, so a value already on it is refused as a cycle, and one that two others
	 * share is read once under each.
	 */
	readonly onPath = new Set<object>()

	/**
	 * The objects the decode answered as they are rather than as copies it built: an interned instance, which a value is
	 * its own decoded form at only by being (conformWith).
	 */
	readonly asIs = new WeakSet<object>()

	constructor(subject: string) {
		this.subject = subject
	}

	/** Where the decode is. */
	get place(): Place | undefined {
		return this.#place
	}

	/** The keys from the root to the value. */
	get keys(): Path {
		return keysTo(this.#place)
	}

	/** `step` run on the child at `key`. */
	*at<A>(key: string | number, step: Step<A>): Step<A> {
		const from = this.#place
		this.#place = { key, from }
		try {
			return yield* step
		} finally {
			this.#place = from
		}
	}

	/** Unwinds the decode for `refused`, which the union trying its next alternative or decodeWith takes. */
	refuse(refused: Refused): never {
		this.#refused = refused
		throw unwinding
	}

	/** Whether the decode is unwinding for a mismatch, which a union's next alternative may repair. */
	get mismatched(): boolean {
		return this.#refused?.kind === "mismatch"
	}

	/** The refusal the decode is unwinding for, taken: the decode goes on, or ends with it. */
	taken(): Refused {
		const refused = defined(this.#refused, "a decode unwinds only for a refusal it recorded")
		this.#refused = undefined
		return refused
	}
}

/**
 * A step the driver runs on its own stack rather than inside the step that waits on it (deferred): its generator,
 * which keeps what the step answers for the waiting step to read once the driver resumes it.
 */
interface Task {
	readonly run: Generator<Task, void, void>
}

/**
 * A decode in progress: a generator that returns its answer. A shape reads its parts by delegating to their steps
 * (yield*), and a reference to a shape (ref) yields its part's step to the driver as a Task instead, so the call stack grows
 * with the nesting of the shapes' own definitions and never with the value's.
 */
type Step<A> = Generator<Task, A, void>

/** A decode in progress, whose answer is the decoded value. */
type Decoding<A> = Step<A>

/** A step the driver runs to its end on its own stack, keeping its answer. */
class Deferred<A> implements Task {
	readonly run: Generator<Task, void, void>
	#answer: { readonly value: A } | undefined

	constructor(step: Step<A>) {
		this.run = this.#kept(step)
	}

	*#kept(step: Step<A>): Generator<Task, void, void> {
		this.#answer = { value: yield* step }
	}

	/** What the step answered: the driver ran it to its end before it resumed the step that reads this. */
	get answer(): A {
		return defined(this.#answer, "a deferred step ran to its end before its answer is read").value
	}
}

/** `step`, run by the driver on its own stack, its answer handed back once it ends: how ref reads its shape's part. */
function* deferred<A>(step: Step<A>): Step<A> {
	const task = new Deferred(step)
	yield task
	return task.answer
}

/** A deferred step the driver has started, and the step that waits on it. */
interface Frame {
	readonly run: Generator<Task, void, void>
	readonly waiting: Frame | undefined
}

/** What a step threw, for the step that waits on it. */
interface Thrown {
	readonly error: unknown
}

/**
 * The answer of `step`, run on a stack of frames on the heap: every Task a frame yields is run to its end before that
 * frame resumes, and what one throws is thrown into the frame waiting on it, so a union still tries its next
 * alternative and every key and container a step pushed leaves the path, however deep the value.
 */
const drive = <A>(step: Step<A>): A => {
	const root = new Deferred(step)
	let frame: Frame = { run: root.run, waiting: undefined }
	let thrown: Thrown | undefined
	for (;;) {
		let next: IteratorResult<Task, void>
		try {
			next = thrown === undefined ? frame.run.next() : frame.run.throw(thrown.error)
		} catch (error) {
			if (frame.waiting === undefined) {
				throw error
			}
			frame = frame.waiting
			thrown = { error }
			continue
		}
		thrown = undefined
		if (next.done !== true) {
			frame = { run: next.value.run, waiting: frame }
		} else if (frame.waiting === undefined) {
			return root.answer
		} else {
			frame = frame.waiting
		}
	}
}

/**
 * Structural decoders for the Description boundary and the IR.
 *
 * The compiler rejects malformed runtime descriptions even when they appear to have the expected TypeScript type, so
 * every Description and every IR value therefore has a Shape: a decoder from unknown input to an owned, frozen copy, or
 * a MalformedDescription naming the path of the first offending value. A Shape is written beside the interface it
 * decodes and annotated with it, so the type checker keeps the two in step.
 *
 * Shapes are strict: an object with a property its shape does not name is refused, so a misspelled optional field is
 * an error rather than a silently ignored one. No shape accepts null, which exists at no layer.
 *
 * An in-memory value can be cyclic, which its text or JSON form cannot be, and either can be nested to any depth. A
 * decode reads every recursive part on a stack on the heap (Step), so no depth of value deepens the call stack, and
 * refuses a container that holds itself as cyclic, so the in-memory path fails exactly where the text path does.
 *
 * Decoding is idempotent: every container shape returns a fresh frozen copy built only from its fields' decoded values,
 * and every check it makes reads only the decoded value, so decoding that copy again with the same shape accepts it and
 * yields an equal fresh copy, key order included. A shape recognises its own output only through `recognized`, which
 * answers an object it decoded before as that object; every other decode reads the whole value.
 */
export interface Shape<A> {
	/** What the shape accepts, for diagnostics. */
	readonly expected: string
	/** Decodes `value` found at `path`, refusing the first mismatch on the path (refuse). Only `decodeWith` ends on it. */
	readonly parse: (value: unknown, path: DecodePath) => Decoding<A>
	/**
	 * What a tagged union's case reads of `value`, the property `skip` (the union's discriminator) passed over: a
	 * struct's fields read from `value` itself, the same checks in the same order as `parse` makes after its object
	 * checks (the struct shapes and a located struct); any other shape's parse of a copy without `skip` (plain).
	 */
	readonly fields: (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: string
	) => Decoding<A>
}

/** One shape per property of R: the fields of a struct, the cases of a tagged union, the members of a union. */
export type ShapesOf<R> = { readonly [K in keyof R]: Shape<R[K]> }

/** The keys of a record of shapes, in its order, each a key of the shapes' type, which Object.keys types as any string. */
const stringKeys = <R>(shapes: ShapesOf<R>): ReadonlyArray<keyof R & string> =>
	Object.keys(shapes).filter((key): key is keyof R & string => Object.hasOwn(shapes, key))

export const malformedAt = (subject: string, path: Path, capability: string): CompileError =>
	malformedDescription(SourceLoc(subject, path), capability)

/** A shape but for what a tagged union's case reads of it (fields): the parts plain completes. */
type ShapeParts<A> = Omit<Shape<A>, "fields">

/**
 * A shape that is no struct, whose fields as a tagged union's case are its parse of a copy without the discriminator:
 * the copy is a fresh object, so the caller's value stands on the path for it.
 */
export const plain = <A>(shape: ShapeParts<A>): Shape<A> => ({
	...shape,
	fields: function* (value, path, skip) {
		const rest: Record<string, unknown> = {}
		for (const k of Object.keys(value)) {
			if (k !== skip) {
				setOwn(rest, k, value[k])
			}
		}
		return yield* shape.parse(rest, path)
	}
})

/** Refuses the value at `path` as a mismatch: it is not what `capability` names. */
export const refuse = (path: DecodePath, capability: string): never =>
	path.refuse({ kind: "mismatch", place: path.place, capability })

/** Refuses the child at `key` of the value at `path`. */
const refuseAt = (path: DecodePath, key: string | number, capability: string): never =>
	path.refuse({ kind: "mismatch", place: { key, from: path.place }, capability })

/**
 * Refuses the value at `path` as no alternative can repair (a cycle, a read that throws): a union does not try its next
 * alternative on it, so it reaches decodeWith unchanged, naming what the value had to be.
 */
const abort = (path: DecodePath, what: string): never =>
	path.refuse({ kind: "abort", place: path.place, capability: what })

/**
 * `step` over the container `value` at `path`, inside its place on the path: refused as a cycle when `value` is already
 * on it, so a container that holds itself is refused where it meets itself, while one two others share is read once
 * under each. Every container a shape decodes is read through here.
 */
function* within<A>(value: object, path: DecodePath, step: Step<A>): Step<A> {
	if (path.onPath.has(value)) {
		abort(path, "an acyclic value")
	}
	path.onPath.add(value)
	try {
		return yield* step
	} finally {
		path.onPath.delete(value)
	}
}

/**
 * Runs the decode `step` makes over `path`, as a Result. The path's subject names what is being decoded in the error
 * location ("query description at arms[0].head.total").
 */
const decodeOn = <A>(step: () => Step<A>, path: DecodePath): Result.Result<A, CompileError> => {
	try {
		return Result.ok(drive(step()))
	} catch (caught) {
		if (caught === unwinding) {
			const refused = path.taken()
			return Result.err(malformedAt(path.subject, keysTo(refused.place), refused.capability))
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
): Result.Result<A, CompileError> => {
	const path = new DecodePath(what)
	return decodeOn(() => shape.parse(value, path), path)
}

/**
 * `value` decoded by `shape` as the part at `keys` of a value decoded under the subject `what` (decodeWith): its
 * refusal is the one a decode of that whole value gives there, at the same location, and a node it leaves unlocated is
 * located at its place in that value. A builder decodes a caller's part this way where it places it in a Description
 * it builds from parts already decoded.
 */
export const decodeAt = <A>(
	shape: Shape<A>,
	value: unknown,
	what: string,
	keys: Path
): Result.Result<A, CompileError> => {
	const path = new DecodePath(what)
	const stepAt = (from: number): Step<A> => {
		const key = keys[from]
		return key === undefined ? shape.parse(value, path) : path.at(key, stepAt(from + 1))
	}
	return decodeOn(() => stepAt(0), path)
}

/**
 * The decoded form of `value`, a value of the decoded type that this package's own code built: what decodeWith gives
 * for it, up to key order. A value that is its own decoded form (ownForm) is kept as it is, frozen throughout; any other
 * is its decoded copy. A refusal, at the first offending value in parse's order as decodeWith names it, is the
 * builder's defect, never a refusal of anyone's input.
 */
export const conformWith = <A>(shape: Shape<A>, value: A, what: string): A => {
	const path = new DecodePath(what)
	const decoded = decodeOn(() => shape.parse(value, path), path)
	if (!decoded.ok) {
		throw defect(`a value this package built has its shape: ${decoded.error.message}`)
	}
	return ownForm(value, decoded.value, path.asIs) ? value : decoded.value
}

/**
 * Whether `value` is its own decoded form `decoded`, its copy under one decode, `asIs` the objects that decode answered
 * as they are; when it is, every array and plain object in it is frozen. It is when every container in it holds what the
 * copy's container at its place holds, key order aside: an array of Array's own prototype with the same items; a plain
 * object with no symbol key and the same own keys, each with the same member, so a member stated undefined that the
 * copy leaves out, or one the copy states and the value leaves out, is not. A primitive, or an object the decode
 * answered as it is (an interned instance), is the copy's member exactly when it is that very member; an object of
 * another prototype is a carrier the decode parsed from its canonical payload (canonicalParsed), whose own decoded form
 * is a value of the same class, since a carrier spells its payload from what the payload parses back to. A value the
 * decode accepted holds no cycle, so the walk ends; the pairs still to compare wait on a stack on the heap.
 */
const ownForm = (value: unknown, decoded: unknown, asIs: WeakSet<object>): boolean => {
	const pending: Array<readonly [unknown, unknown]> = [[value, decoded]]
	const containers: Array<object> = []
	for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
		const [own, copy] = pair
		if (Object.is(own, copy)) {
			continue
		}
		if (typeof own !== "object" || own === null || typeof copy !== "object" || copy === null) {
			return false
		}
		if (asIs.has(copy)) {
			return false
		}
		if (isList(copy)) {
			if (
				!isList(own) ||
				Object.getPrototypeOf(own) !== Array.prototype ||
				own.length !== copy.length
			) {
				return false
			}
			containers.push(own)
			for (const [i, item] of copy.entries()) {
				pending.push([own[i], item])
			}
		} else if (isPlainObject(copy)) {
			if (!isPlainObject(own) || Object.getOwnPropertySymbols(own).length > 0) {
				return false
			}
			const keys = Object.keys(copy)
			if (Object.keys(own).length !== keys.length) {
				return false
			}
			containers.push(own)
			for (const key of keys) {
				if (!Object.hasOwn(own, key)) {
					return false
				}
				pending.push([own[key], copy[key]])
			}
		} else if (Object.getPrototypeOf(own) !== Object.getPrototypeOf(copy)) {
			return false
		}
	}
	for (const container of containers) {
		Object.freeze(container)
	}
	return true
}

/**
 * Reads the caller's value at `path`. A read runs the caller's code (a proxy's traps, a getter), and its throw refuses
 * the value there (core/host.ts hostRead), which no union alternative repairs. Every read of a value being decoded goes
 * through here, so a throw anywhere else in a decode is the decoder's own and escapes decodeWith as the defect it is.
 */
const unreadable = (): string => "a value whose reading throws nothing: no refusing proxy or getter"
const readAt = <A>(path: DecodePath, read: () => A): A => {
	const r = hostRead(unreadable, () => Result.ok(read()))
	return r.ok ? r.value : abort(path, r.error)
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
 * A source location as a decode keeps it: frozen with its path and site, so a value holding one is frozen throughout. A
 * path or call site already frozen is shared, since it cannot change, and so is a captured stack, which captureLoc
 * froze. A node built from parts already decoded keeps its location by it, as a decode of the node would.
 */
export const keptLoc = (loc: SourceLoc): SourceLoc =>
	Object.freeze({
		path: Object.isFrozen(loc.path) ? loc.path : Object.freeze(loc.path.slice()),
		label: loc.label,
		site:
			loc.site === undefined || isCapturedStack(loc.site) || Object.isFrozen(loc.site)
				? loc.site
				: Object.freeze({ ...loc.site })
	})

/** A SourceLoc, kept: excluded from identity, retained for diagnostics. */
export const sourceLoc: Shape<SourceLoc> = plain({
	expected: "a source location",
	parse: function* (value, path) {
		return (
			readAt(path, () => {
				const loc = parseSourceLoc(value)
				return loc === undefined ? undefined : keptLoc(loc)
			}) ?? refuse(path, "a source location")
		)
	}
})

/** A shape of a value that is no container, read by `read` at once: its decode hands the value itself back. */
const leaf = <A>(expected: string, read: (value: unknown, path: DecodePath) => A): Shape<A> =>
	plain({
		expected,
		parse: function* (value, path) {
			return read(value, path)
		}
	})

/** A property no value states: as a stated field it decodes to undefined, and any value there is refused. */
export const nothing: Shape<never> = leaf("no value", (value, path) =>
	refuse(path, `no value here, not ${describe(value, path)}`)
)

const text = (value: unknown, path: DecodePath): string =>
	typeof value === "string" ? value : refuse(path, `a string, not ${describe(value, path)}`)

export const string: Shape<string> = leaf("a string", text)

export const nonEmptyString: Shape<string> = leaf("a nonempty string", (value, path) => {
	const read = text(value, path)
	return read.length > 0 ? read : refuse(path, "a nonempty string")
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

const safeInteger = (value: unknown, path: DecodePath): number =>
	typeof value === "number" && Number.isSafeInteger(value)
		? value
		: refuse(path, `a safe integer, not ${describe(value, path)}`)

export const integer: Shape<number> = leaf("a safe integer", safeInteger)

export const nonNegativeInteger: Shape<number> = leaf(
	"a nonnegative safe integer",
	(value, path) => {
		const n = safeInteger(value, path)
		return n >= 0 ? n : refuse(path, "a nonnegative integer")
	}
)

export const positiveInteger: Shape<number> = leaf("a positive safe integer", (value, path) => {
	const n = safeInteger(value, path)
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
		parse: function* (value, path) {
			return brand(yield* shape.parse(value, path))
		}
	})

export const refine = <A>(
	shape: Shape<A>,
	test: (value: A) => boolean,
	expected: string
): Shape<A> =>
	plain({
		expected,
		parse: function* (value, path) {
			const out = yield* shape.parse(value, path)
			return test(out) ? out : refuse(path, expected)
		}
	})

/**
 * A decoded value whose parts agree with each other, which `audit` checks over the decoded value: it refuses (its
 * `refuseAt`) at the keys, under the value, of the first part that breaks the agreement, naming that part, and returns
 * otherwise.
 */
export const audited = <A>(
	shape: Shape<A>,
	audit: (value: A, refuseAt: (keys: Path, capability: string) => never) => void
): Shape<A> =>
	plain({
		expected: shape.expected,
		parse: function* (value, path) {
			const out = yield* shape.parse(value, path)
			audit(out, (keys, capability) =>
				path.refuse({
					kind: "mismatch",
					place: keys.reduce<Place | undefined>((from, key) => ({ key, from }), path.place),
					capability
				})
			)
			return out
		}
	})

/**
 * A decoded value normalized into its internal form: the boundary's one place to fill a documented default, so no
 * consumer re-defaults it. The result is frozen like every decoded value.
 */
export const normalized = <A, B>(shape: Shape<A>, normalize: (value: A) => B): Shape<B> =>
	plain({
		expected: shape.expected,
		parse: function* (value, path) {
			return Object.freeze(normalize(yield* shape.parse(value, path)))
		}
	})

/**
 * A value of a fixed set of interned instances, decoded to the one instance its parts name, so equal values are one
 * value. The decode answers the instance as it is, so a value is its own decoded form exactly when it is that instance.
 */
export const interned = <P, A extends object>(
	parts: Shape<P>,
	instance: (parts: P) => A
): Shape<A> =>
	plain({
		expected: parts.expected,
		parse: function* (value, path) {
			const one = instance(yield* parts.parse(value, path))
			path.asIs.add(one)
			return one
		}
	})

/**
 * `shape`, answering an object it decoded before as that very object. A decoded value is a fixed point of its shape at
 * any place: every check reads only the value, and every located node already carries its location. So a value built
 * around parts the shape already decoded is read only in its new parts, with the refusals and the result a whole
 * decode gives, and its decoded parts are shared rather than copied. The shape registers its own outputs alone, in a
 * WeakMap, which holds nothing alive and is never enumerated.
 */
export const recognized = <A extends object>(shape: Shape<A>): Shape<A> => {
	const outputs = new WeakMap<object, A>()
	return plain({
		expected: shape.expected,
		parse: function* (value, path) {
			const known = typeof value === "object" && value !== null ? outputs.get(value) : undefined
			if (known !== undefined) {
				return known
			}
			const out = yield* shape.parse(value, path)
			outputs.set(out, out)
			return out
		}
	})
}

/** The decoded items of an array, in order, frozen. */
function* itemsOf<A>(
	item: Shape<A>,
	items: ReadonlyArray<unknown>,
	path: DecodePath
): Decoding<ReadonlyArray<A>> {
	const out: Array<A> = []
	for (const [i, child] of items.entries()) {
		out.push(yield* path.at(i, item.parse(child, path)))
	}
	return Object.freeze(out)
}

/** The array decoders below are built from these parts, which plain completes once, at the outside. */
const arrayOf = <A>(item: Shape<A>): ShapeParts<ReadonlyArray<A>> => ({
	expected: `an array of ${item.expected}`,
	parse: function* (value, path) {
		const read = readArray(value, path)
		if (read.kind === "other") {
			return refuse(path, `an array, not ${describe(value, path)}`)
		}
		if (read.kind === "hole") {
			return refuseAt(path, read.at, "an array element, not a hole")
		}
		return yield* within(read.container, path, itemsOf(item, read.items, path))
	}
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
	parse: function* (value, path) {
		const out = yield* inner.parse(value, path)
		return isNonEmpty(out) ? out : refuse(path, capability)
	}
})

/** The first item of `items` whose key repeats an earlier one's: its index and the capability it refuses. */
const firstRepeat = <A>(
	items: ReadonlyArray<A>,
	key: (a: A) => string,
	what: string
): { readonly at: number; readonly capability: string } | undefined => {
	const seen = new Set<string>()
	for (const [at, a] of items.entries()) {
		const k = key(a)
		if (seen.has(k)) {
			return { at, capability: `distinct ${what}; ${JSON.stringify(k)} repeats` }
		}
		seen.add(k)
	}
	return undefined
}

const distinctOf = <A>(
	item: Shape<A>,
	key: (a: A) => string,
	what: string
): ShapeParts<ReadonlyArray<A>> => {
	const inner = arrayOf(item)
	return {
		expected: `an array of distinct ${what}`,
		/** Refuses the first item whose key repeats an earlier one's. */
		parse: function* (value, path) {
			const out = yield* inner.parse(value, path)
			const repeat = firstRepeat(out, key, what)
			return repeat === undefined ? out : refuseAt(path, repeat.at, repeat.capability)
		}
	}
}

/**
 * Items already decoded, held to distinct keys as a decode of their list (uniqueArray) holds it: the refusal a decode of
 * `subject` gives at the first item, under `path`, whose key repeats an earlier one's, or none.
 */
export const repeatedAt = <A>(
	subject: string,
	path: Path,
	items: ReadonlyArray<A>,
	key: (a: A) => string,
	what: string
): CompileError | undefined => {
	const repeat = firstRepeat(items, key, what)
	return repeat === undefined
		? undefined
		: malformedAt(subject, [...path, repeat.at], repeat.capability)
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
		parse: function* (value, path) {
			const length = readAt(path, () => (Array.isArray(value) ? value.length : n))
			if (length !== n) {
				return refuse(path, `${expected}, not ${length}`)
			}
			return of(yield* inner.parse(value, path)) ?? refuse(path, expected)
		}
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

/** A record member's key and value: the key read by `keyShape`, then the value by `item`. */
function* recordMember<A>(
	item: Shape<A>,
	keyShape: Shape<string>,
	key: string,
	child: unknown,
	path: DecodePath
): Decoding<A> {
	yield* keyShape.parse(key, path)
	return child === undefined
		? refuse(path, "a value, not undefined")
		: yield* item.parse(child, path)
}

/** A record's decoded members, in its key order, frozen. */
function* recordMembers<A>(
	item: Shape<A>,
	keyShape: Shape<string>,
	fields: Readonly<Record<string, unknown>>,
	path: DecodePath
): Decoding<Readonly<Record<string, A>>> {
	const out: Record<string, A> = {}
	for (const key of Object.keys(fields)) {
		setOwn(out, key, yield* path.at(key, recordMember(item, keyShape, key, fields[key], path)))
	}
	return Object.freeze(out)
}

/** A plain object used as a map from nonempty names to values. */
export const recordShape = <A>(
	item: Shape<A>,
	keyShape: Shape<string>
): Shape<Readonly<Record<string, A>>> =>
	plain({
		expected: `an object of ${item.expected}`,
		parse: function* (value, path) {
			const read = readObject(value, path)
			if (read.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			return yield* within(read.container, path, recordMembers(item, keyShape, read.copy, path))
		}
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
			refuseAt(path, key, `no property ${JSON.stringify(key)}; expected ${parts.names.join(", ")}`)
		}
	}
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
function* readRequired<R>(
	shapes: ShapesOf<R>,
	keys: ReadonlyArray<keyof R & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): Decoding<{ readonly [K in keyof R & string]: R[K] }> {
	const out: { [K in keyof R & string]?: R[K] } = {}
	for (const key of keys) {
		const child = key === skip ? undefined : value[key]
		if (child === undefined) {
			refuseAt(path, key, `the required property ${JSON.stringify(key)}`)
		}
		setOwn(out, key, yield* path.at(key, shapes[key].parse(child, path)))
	}
	return filled<{ readonly [K in keyof R & string]: R[K] }>(keys, out)
}

/** The optional fields of `value` that are present, in the struct's order; a field named `skip` counts as absent. */
function* readOptional<O>(
	shapes: ShapesOf<O>,
	keys: ReadonlyArray<keyof O & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): Decoding<{ readonly [K in keyof O & string]?: O[K] }> {
	const out: { [K in keyof O & string]?: O[K] } = {}
	for (const key of keys) {
		const child = key === skip ? undefined : value[key]
		if (child !== undefined) {
			setOwn(out, key, yield* path.at(key, shapes[key].parse(child, path)))
		}
	}
	return out
}

/**
 * The stated fields of `value`, in the struct's order, each undefined where the value leaves it out or names the
 * struct's `skip`.
 */
function* readStated<U>(
	shapes: ShapesOf<U>,
	keys: ReadonlyArray<keyof U & string>,
	value: Readonly<Record<string, unknown>>,
	path: DecodePath,
	skip: string | undefined
): Decoding<{ readonly [K in keyof U & string]: U[K] | undefined }> {
	const out: { [K in keyof U & string]?: U[K] | undefined } = {}
	for (const key of keys) {
		const child = key === skip ? undefined : value[key]
		setOwn(
			out,
			key,
			child === undefined ? undefined : yield* path.at(key, shapes[key].parse(child, path))
		)
	}
	return filled<{ readonly [K in keyof U & string]: U[K] | undefined }>(keys, out)
}

/**
 * A strict object's shape from how it reads its fields: the object checks, then its fields inside the value's place
 * on the path, as parse; and its fields alone, the discriminator passed over, as a tagged union's case.
 */
const structShape = <S>(
	parts: StructNames,
	read: (
		value: Readonly<Record<string, unknown>>,
		path: DecodePath,
		skip: string | undefined
	) => Decoding<S>
): Shape<S> => ({
	expected: `an object with ${parts.names.length === 0 ? "no fields" : parts.names.join(", ")}`,
	parse: function* (value, path) {
		const object = readObject(value, path)
		if (object.kind === "other") {
			return refuse(path, `a plain object, not ${describe(value, path)}`)
		}
		if (object.symbols) {
			refuse(path, "an object without symbol keys")
		}
		checkStructKeys(parts, object.copy, path, undefined)
		return Object.freeze(yield* within(object.container, path, read(object.copy, path, undefined)))
	},
	fields: function* (value, path, skip) {
		checkStructKeys(parts, value, path, skip)
		return yield* read(value, path, skip)
	}
})

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
	return structShape<StructOf<R, O>>(
		{
			names: [...requiredKeys, ...optionalKeys],
			isField: (key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)
		},
		function* (value, path, skip) {
			const req = yield* readRequired(required, requiredKeys, value, path, skip)
			return { ...req, ...(yield* readOptional(optional, optionalKeys, value, path, skip)) }
		}
	)
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
	return structShape<StatedOf<R, U, O>>(
		{
			names: [...requiredKeys, ...statedKeys, ...optionalKeys],
			isField: (key) =>
				Object.hasOwn(required, key) || Object.hasOwn(stated, key) || Object.hasOwn(optional, key)
		},
		function* (value, path, skip) {
			const req = yield* readRequired(required, requiredKeys, value, path, skip)
			const sta = yield* readStated(stated, statedKeys, value, path, skip)
			return { ...req, ...sta, ...(yield* readOptional(optional, optionalKeys, value, path, skip)) }
		}
	)
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
	/** The case `tag` names, decoded from `copy`, what was read of the caller's object: the discriminator, then its fields. */
	const caseOf = function* <K extends keyof M & string>(
		tag: K,
		copy: Readonly<Record<string, unknown>>,
		path: DecodePath
	): Decoding<{ [P in K]: TaggedCase<T, M, P> }[K]> {
		const discriminator = singleton(key, tag)
		return Object.freeze({ ...discriminator, ...(yield* cases[tag].fields(copy, path, key)) })
	}
	return plain({
		expected: `an object with ${key} one of ${tags.join(", ")}`,
		/** The caller's object stands on the path; the case decodes what was read of it. */
		parse: function* (value, path) {
			const object = readObject(value, path)
			if (object.kind === "other") {
				return refuse(path, `a plain object, not ${describe(value, path)}`)
			}
			const tag = object.copy[key]
			if (typeof tag !== "string" || !isTag(tag)) {
				return refuseAt(path, key, `one of ${tags.map((t) => JSON.stringify(t)).join(" | ")}`)
			}
			return yield* within(object.container, path, caseOf(tag, object.copy, path))
		}
	})
}

/**
 * `step`'s answer, or the mismatch it refuses, taken off `path`, so a union can try its next alternative; an abort and
 * any other throw propagate.
 */
function* attempt<A>(step: Step<A>, path: DecodePath): Step<Result.Result<A, Refused>> {
	try {
		return Result.ok(yield* step)
	} catch (caught) {
		if (caught === unwinding && path.mismatched) {
			return Result.err(path.taken())
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
		parse: function* (value, path) {
			for (const shape of members) {
				const out = yield* attempt(shape.parse(value, path), path)
				if (out.ok) {
					return out.value
				}
			}
			return refuse(path, expected)
		}
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
		parse: function* (value, path) {
			return Object.freeze(locate(yield* shape.parse(value, path), path))
		},
		fields: function* (value, path, skip) {
			return locate(yield* shape.fields(value, path, skip), path)
		}
	}
}

/**
 * A reference to a shape declared later in its module, or in a module this one imports in a cycle, which is how a
 * recursive shape names itself: `shape` names that declaration, and is read at each parse, never while the modules
 * are evaluated. Each value it reads is decoded on the driver's stack (deferred), so a value nested through it to any
 * depth never deepens the call stack.
 */
export const ref = <A>(expected: string, shape: () => Shape<A>): Shape<A> =>
	plain({
		expected,
		parse: function* (value, path) {
			return yield* deferred(shape().parse(value, path))
		}
	})

/**
 * A value implementing the canonical protocol with the given tag, parsed from its payload into the carrier `parse`
 * makes of a payload its grammar admits: the IR holds its literals parsed, whichever reviver its decode was given. A
 * carrier spells its payload from the fields that payload parses back to (ir/carriers.ts), so a value already of the
 * carrier's class is its own decoded form (conformWith), and any other value carrying the payload, such as
 * scalar/values' Money, decodes to the carrier.
 */
export const canonicalParsed = <A>(
	tag: string,
	parse: (payload: string) => A | undefined,
	expected: string
): Shape<A> =>
	leaf(expected, (value, path) => {
		const encoded = readAt(path, () => taggedValueOf(value))
		if (encoded === undefined) {
			return refuse(path, `${expected}, not ${describe(value, path)}`)
		}
		return (encoded.tag === tag ? parse(encoded.payload) : undefined) ?? refuse(path, expected)
	})

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
