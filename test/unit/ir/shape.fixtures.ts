/** What the properties of shape.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { CheckoutDir } from "@bjornpagen/testing/checkout"
import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { double } from "@bjornpagen/testing/values"
import { Array as Arr, Cause, Data, Effect, Queue, Record as Rec, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { jsonText } from "#compiler/core/trusted.ts"
import * as S from "#compiler/ir/shape.ts"
import type { Place } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"

/** A point: an integer x and an optional nonempty label. */
const point = S.structWith({ x: S.integer }, { label: S.nonEmptyString })

/** A list of points. */
const points = S.array(point)

/**
 * A case whose own optional field is named like the discriminator, of a text no tag of the case is: the decode reads
 * that member as the discriminator, so a field read in its place would refuse it.
 */
const mark = S.structWith(
	{},
	{ kind: S.refine(S.string, (text) => text !== "mark", "a text other than the case's tag") }
)

/** A point as shape decodes it: its x, and its label where it states one. */
type Point = { readonly x: number; readonly label?: string }

/** What shape decodes: a point, a list of points, or a mark, by kind. */
type Shaped =
	| ({ readonly kind: "point" } & Point)
	| { readonly kind: "list"; readonly items: ReadonlyArray<Point> }
	| { readonly kind: "mark" }

/** The shape every property decodes: a point, a list of points, or a mark, by kind. */
export const shape = S.tagged<Shaped>()("kind", { point, list: S.struct({ items: points }), mark })

/** A 32-bit integer: a point's coordinate, a list's item and a record's value. */
export const int4Gen = int(-(2 ** 31), 2 ** 31 - 1)

/** A point, its label stated or not. */
const pointGen: Gen<{ readonly x: number; readonly label?: string }> = oneOf<{
	readonly x: number
	readonly label?: string
}>([
	(source) => ({ x: source.draw(int4Gen) }),
	(source) => ({
		x: source.draw(int4Gen),
		label: source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 4 }))
	})
])

/**
 * A live value of `shape`: a point, its label stated or not, a list of them, or the case that names a field like the
 * discriminator.
 */
export const liveGen: Gen<unknown> = oneOf<unknown>([
	map(pointGen, (p) => ({ kind: "point", ...p })),
	map(array(pointGen, { min: 0, max: 4 }), (items) => ({ kind: "list", items })),
	constant({ kind: "mark" })
])

/** A path from a value's root to one of its members. */
type Path = ReadonlyArray<string | number>

/** Whether a value is a plain object: an object that is no array. */
const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** The own enumerable string keys of a plain object, as Object.keys lists them. */
export const keysOf = (fields: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
	Rec.keys(fields)

/** Every path of a plain value a member can be replaced at: the root first, then each member's, depth first. */
export const sitesOf = (value: unknown): readonly [Path, ...Array<Path>] => {
	const below = (v: unknown, at: Path): ReadonlyArray<Path> =>
		Arr.isArray(v)
			? Arr.flatMap(v, (item: unknown, i) => [[...at, i], ...below(item, [...at, i])])
			: isObject(v)
				? Arr.flatMap(Rec.toEntries(v), ([key, member]) => [
						[...at, key],
						...below(member, [...at, key])
					])
				: []
	return [[], ...below(value, [])]
}

/** The member of `value` at `path`. */
const memberAt = (value: unknown, path: Path): unknown =>
	Arr.reduce(path, value, (v: unknown, step) =>
		Arr.isArray(v)
			? v[Number(step)]
			: isObject(v)
				? new Map<string | number, unknown>(Rec.toEntries(v)).get(step)
				: v
	)

/** `value` with its member at `path` replaced by `edit` of it, every container on the way a fresh copy. */
export const edited = (value: unknown, path: Path, edit: (member: unknown) => unknown): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return edit(value)
	}
	if (Arr.isArray(value)) {
		return Arr.map(value, (item: unknown, i) => (i === head ? edited(item, rest, edit) : item))
	}
	if (isObject(value)) {
		return Rec.fromEntries(
			Arr.map(
				Rec.toEntries(value),
				([key, member]) => [key, key === head ? edited(member, rest, edit) : member] as const
			)
		)
	}
	return value
}

/** The place of a refusal at `path` of a value decoded as "v": its label and path. */
export const placeAt = (path: Path): Place => ({ label: "v", path })

/** A plain object's own fields in an instance of a class, whose prototype is no plain object's. */
class Instance {
	constructor(fields: object) {
		Object.assign(this, fields)
	}

	/** Its prototype's own method, which no plain object has. */
	label(): string {
		return "a class instance"
	}
}

/**
 * One way to break a live value at one site, and what the decode must answer: a refusal at a path, or, for a symbol
 * key on the tagged root, which a copy of its string keys drops, the live value's decode.
 */
export type Break =
	| "null"
	| "unknown key"
	| "symbol key refused"
	| "symbol key passed over"
	| "hole"
	| "unknown tag"
	| "missing member"
	| "class instance"

/** What the decode of a broken value must answer: a refusal at a path, or the live value's decode. */
type Outcome = { readonly kind: "refused"; readonly at: Path } | { readonly kind: "passed over" }

/** A live value broken one way at one site, and what its decode must answer. */
interface Broken {
	readonly break: Break
	readonly value: unknown
	readonly outcome: Outcome
}

/** A refusal at `at`. */
const refusedAt = (at: Path): Outcome => ({ kind: "refused", at })

/** Every way to break `live` at one of its sites, by kind: only the kinds the value has a site for. */
export const breaksOf = (live: unknown): ReadonlyArray<Arr.NonEmptyReadonlyArray<Broken>> => {
	const sites = sitesOf(live)
	const objects = Arr.flatMap(sites, (path) => {
		const member = memberAt(live, path)
		return isObject(member) ? [{ path, member }] : []
	})
	const arrays = Arr.flatMap(sites, (path) => {
		const member = memberAt(live, path)
		return Arr.isArray(member) ? [{ path, member }] : []
	})
	const replaced = (path: Path, by: unknown) => edited(live, path, () => by)
	const kinds: ReadonlyArray<ReadonlyArray<Broken>> = [
		Arr.map(sites, (p) => ({ break: "null", value: replaced(p, null), outcome: refusedAt(p) })),
		Arr.map(objects, ({ path, member }) => ({
			break: "unknown key",
			value: replaced(path, { ...member, y: 1 }),
			outcome: refusedAt([...path, "y"])
		})),
		Arr.map(objects, ({ path, member }) => ({
			break: path.length === 0 ? "symbol key passed over" : "symbol key refused",
			value: replaced(path, { ...member, [Symbol("s")]: 1 }),
			outcome: path.length === 0 ? { kind: "passed over" } : refusedAt(path)
		})),
		Arr.map(arrays, ({ path, member }) => {
			const holed: Array<unknown> = [...member]
			holed.length = member.length + 1
			return {
				break: "hole",
				value: replaced(path, holed),
				outcome: refusedAt([...path, member.length])
			}
		}),
		[{ break: "unknown tag", value: replaced(["kind"], "circle"), outcome: refusedAt(["kind"]) }],
		Arr.flatMap(objects, ({ path, member }) =>
			Arr.map(
				Arr.filter(keysOf(member), (key) => key !== "label"),
				(key): Broken => ({
					break: "missing member",
					value: replaced(
						path,
						Rec.fromEntries(Arr.filter(Rec.toEntries(member), ([k]) => k !== key))
					),
					outcome: refusedAt([...path, key])
				})
			)
		),
		Arr.map(objects, ({ path, member }) => ({
			break: "class instance",
			value: replaced(path, new Instance(member)),
			outcome: refusedAt(path)
		}))
	]
	return Arr.filter(kinds, Arr.isReadonlyArrayNonEmpty)
}

/** The case a decoded live value is. */
export type Decoded = "a list of points" | "a point" | "a mark"

/** Where a read threw: a proxy or a throwing getter, at the root or nested. */
export type UnreadableFeature =
	| "proxy at the root"
	| "proxy nested"
	| "throwing getter at the root"
	| "throwing getter nested"

/** A decoder's own throw: one decoder step that throws `defect`, and a value its base shape accepts. */
export class Defect extends Data.Error<{ readonly site: string }> {}

/** The decoder step that throws: a normalization, a refinement or a brand. */
export type DefectKind = "normalize" | "refine" | "brand"

/** Where a shape holds the defective decoder. */
export type DefectSite =
	| "the root"
	| "an array item"
	| "a struct field"
	| "a union's first alternative"
	| "a tagged case"

/** A decoder whose step of `kind` throws `defect`, and a value its base shape accepts. */
export const defective = (
	kind: DefectKind,
	defect: Defect
): { readonly shape: S.Shape<unknown>; readonly value: unknown } => {
	const thrown = (): never => {
		throw defect
	}
	switch (kind) {
		case "normalize":
			return { shape: S.normalized(S.integer, thrown), value: 3 }
		case "refine":
			return { shape: S.refine(S.integer, thrown, "an integer its test passes"), value: 3 }
		case "brand":
			return { shape: S.branded(thrown, S.string), value: "s" }
	}
}

/**
 * The defective decoder placed at `site`, and a value that reaches it there. The union's second alternative accepts the
 * value, so a defect taken for a mismatch would be repaired by it.
 */
export const placed = (
	site: DefectSite,
	inner: { readonly shape: S.Shape<unknown>; readonly value: unknown }
): { readonly shape: S.Shape<unknown>; readonly value: unknown } => {
	switch (site) {
		case "the root":
			return inner
		case "an array item":
			return { shape: S.array(inner.shape), value: [inner.value] }
		case "a struct field":
			return { shape: S.struct({ n: inner.shape }), value: { n: inner.value } }
		case "a union's first alternative":
			return { shape: S.unionShape(inner.shape, S.integer, S.string), value: inner.value }
		case "a tagged case":
			return {
				shape: S.tagged<{ readonly kind: "a"; readonly n: unknown }>()("kind", {
					a: S.struct({ n: inner.shape })
				}),
				value: { kind: "a", n: inner.value }
			}
	}
}

/** Every way to break a live value. */
export const breakNames: Arr.NonEmptyReadonlyArray<Break> = [
	"null",
	"unknown key",
	"symbol key refused",
	"symbol key passed over",
	"hole",
	"unknown tag",
	"missing member",
	"class instance"
]

/** A chain of links to an end: a recursive tagged union, each link a container of its own. */
type Chain = { readonly kind: "end" } | { readonly kind: "link"; readonly next: Chain }

/** A chain, decoded through a reference to its body. */
const chainShape: S.Shape<Chain> = S.ref("a chain", () => chainBody)

/** The decoder chainShape refers to (S.ref). */
const chainBody: S.Shape<Chain> = S.tagged<Chain>()("kind", {
	end: S.struct({}),
	link: S.struct({ next: chainShape })
})

/** Arrays inside arrays around an integer: a recursive union whose first alternative refuses every array. */
type Nested = number | ReadonlyArray<Nested>

/** A nested array, decoded through a reference to its body. */
const nestedShape: S.Shape<Nested> = S.ref("a nested array", () => nestedBody)

/** The decoder nestedShape refers to (S.ref). */
const nestedBody: S.Shape<Nested> = S.unionShape(S.integer, S.array(nestedShape))

/** The two recursive shapes, read through the shape of any value. */
type Form = "chain" | "nested array"

/** The recursive shape of a form. */
export const formShape = (form: Form): S.Shape<unknown> =>
	form === "chain" ? chainShape : nestedShape

/** The step each container of a form takes to the next. */
export const stepOf = (form: Form): string | number => (form === "chain" ? "next" : 0)

/** `depth` containers of a form, the innermost around its end. */
export const built = (form: Form, depth: number): unknown => {
	let v: unknown = form === "chain" ? { kind: "end" } : 1
	for (let i = 0; i < depth; i++) {
		v = form === "chain" ? { kind: "link", next: v } : [v]
	}
	return v
}

/** How many containers a decoded value of a form nests, counted down its one path. */
export const depthOf = (form: Form, value: unknown): number => {
	let depth = 0
	for (let v = value; ; depth++) {
		const next: unknown =
			form === "chain" ? (isObject(v) ? v["next"] : undefined) : Arr.isArray(v) ? v[0] : undefined
		if (next === undefined) {
			return depth
		}
		v = next
	}
}

/**
 * The reads of a cycle's links, against the most a decode that refuses the cycle where it meets itself makes: the link
 * of each of its `length` containers once, on the way in, and the link of the one the cycle meets once more, read
 * before that container is refused. A read past them is a decode going round the cycle with no container on its path
 * refused: it throws, which the decode refuses as unreadable, so such a decode ends one read past the cycle, in the
 * memory one pass takes, rather than going round without end.
 */
export class CycleReads {
	readonly most: number
	#made = 0

	constructor(length: number) {
		this.most = length + 1
	}

	/** The reads made so far. */
	get made(): number {
		return this.#made
	}

	/** One read of a link, which answers `next`, or throws once past the most a refusing decode makes. */
	read<A>(next: A): A {
		this.#made++
		if (this.#made > this.most) {
			throw new Error(`a read past the ${this.most} a decode that refuses this cycle makes`)
		}
		return next
	}
}

/**
 * `length` containers of a form, each holding the next and the last holding the one `back` below the root: the root.
 * Each link is an own enumerable getter, read through `reads`, so a plain object or array still holds it.
 */
export const cyclic = (form: Form, length: number, back: number, reads: CycleReads): unknown => {
	const linked = <C extends object>(
		nodes: ReadonlyArray<C>,
		key: string | number
	): C | undefined => {
		for (const [i, container] of nodes.entries()) {
			const next = nodes[i + 1] ?? nodes[back]
			Object.defineProperty(container, key, { enumerable: true, get: () => reads.read(next) })
		}
		return nodes[0]
	}
	return form === "chain"
		? linked(
				Arr.map(indices(length), (): Record<string, unknown> => ({ kind: "link" })),
				"next"
			)
		: linked(
				Arr.map(indices(length), (): Array<unknown> => []),
				0
			)
}

/**
 * The levels a recursion of one frame per container holds on the small stack: at 160 KB, a recursion over a list of
 * 1,000 elements overflows (the testing library's SMALL_STACK).
 */
const smallStackRecursion = 1_000

/**
 * A count of containers: within the levels a recursion holds on the small stack, or past them up to 100,000; a deeper
 * value costs its depth to build and read, so the deepest are drawn the least.
 */
export const containers: Gen<number> = weighted([
	[3, int(1, smallStackRecursion)],
	[2, int(smallStackRecursion + 1, 10_000)],
	[1, int(10_001, 100_000)]
])

/** A form: a chain or a nested array. */
export const formGen = element<Form>(["chain", "nested array"])

/** What a nested or cyclic value's case reached: its form, and its containers against the small stack. */
export type NestingFeature =
	| Form
	| "no container"
	| "within a small stack's recursion"
	| "past a small stack's recursion"
	| "a cycle back to its root"
	| "a cycle back to its last container"
	| "a cycle back to a container between"

/** What a count of containers reached against the small stack: none, within its recursion, or past it. */
export const depthFeature = (n: number): NestingFeature =>
	n === 0
		? "no container"
		: n > smallStackRecursion
			? "past a small stack's recursion"
			: "within a small stack's recursion"

/** Where a record is decoded: in this test process, or in a child Node started as a library consumer's is. */
export type DecodedIn = "this process" | "a consumer's process"

/** What the consumer's child answers a record with: its line, or its exit, with what it wrote on stderr. */
type ConsumerAnswer =
	| { readonly kind: "answer"; readonly line: string }
	| { readonly kind: "exited"; readonly stderr: string }

/**
 * A child Node started in the checkout a worker runs the repository's code from (a worker tree, under a
 * mutant), with no flag, none of the hardened ones (test/support/process.ts hardenedNode), as a library consumer's is
 * (shape-record.child.ts); this Node reads no NODE_OPTIONS, so none reaches it either. It is Node itself, so the
 * worker's guard records what it reads in its own process, where a wrapper (env) ran it under strace. The function it gives hands the child a record's entries on a line
 * and takes its answer from the next line it prints, or its exit. The child ends with the scope it starts in.
 */
const consumerProcess = (checkout: CheckoutDir) =>
	Effect.gen(function* () {
		const requests = yield* Queue.unbounded<string>()
		const answers = yield* Queue.unbounded<ConsumerAnswer>()
		const handle = yield* ChildProcess.make(
			process.execPath,
			[`${import.meta.dirname}/shape-record.child.ts`],
			{
				cwd: checkout,
				extendEnv: true,
				stdin: Stream.encodeText(Stream.fromQueue(requests))
			}
		)
		yield* Effect.forkScoped(
			Effect.orDie(
				Effect.gen(function* () {
					const [, stderr] = yield* Effect.all(
						[
							Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
								Queue.offer(answers, { kind: "answer", line })
							),
							Stream.mkString(Stream.decodeText(handle.stderr))
						],
						{ concurrency: "unbounded" }
					)
					yield* Queue.offer(answers, { kind: "exited", stderr })
				})
			)
		)
		return (entries: ReadonlyArray<readonly [string, number]>) =>
			Effect.andThen(Queue.offer(requests, `${jsonText(entries)}\n`), Queue.take(answers))
	})

/** A number a refinement is tried on: an edge case, a 32-bit integer, or a double, a NaN or an infinity. */
export const numberGen = oneOf([
	element([
		0,
		-0,
		1,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER + 1,
		-Number.MAX_SAFE_INTEGER - 1
	]),
	int4Gen,
	weighted([
		[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
		[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
	])
])

/** A record's key: __proto__, a key of Object.prototype, or printable text. */
const keyGen = oneOf([
	constant("__proto__"),
	element(["constructor", "toString", "a"]),
	string(codePoint(0x20, 0x7e), { min: 1, max: 4 })
])

/** A record's entries: up to five distinct keys, each with its integer. */
export const entriesGen: Gen<ReadonlyArray<readonly [string, number]>> = uniqueArray(
	keyGen,
	(key) => (source) => [key, source.draw(int4Gen)] as const,
	{ min: 0, max: 5 }
)

/** Where a record is decoded: in this process seven times in eight. */
export const decodedIn = weighted<DecodedIn>([
	[7, constant("this process")],
	[1, constant("a consumer's process")]
])

/**
 * A consumer's child process, started once per worker in the worker's checkout (Checkout.dir, the worker tree under a
 * mutant), which every case of the consumer's kind on the worker asks in turn: what the search started once before its
 * cases, now once per worker. The property still needs Checkout.dir, so its kills and mutants run in worker trees.
 */
export const consumerNeed = {
	key: "test/unit/ir/shape.fixtures.ts consumerNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const take = yield* Checkout.dir.open
		const dir = yield* Effect.scoped(take)
		const consumer = yield* consumerProcess(dir)
		return consumer
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/ir/shape.fixtures.ts consumerNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
