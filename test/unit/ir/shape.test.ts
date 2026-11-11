/**
 * The structural decoders (ir/shape.ts) over a small shape of points, lists and marks, every one a decoder the
 * Description boundary and the IR are built from.
 *
 * - Broken: a live value decodes into an equal fresh copy, and one broken at one site is refused there, by its place's
 *   label and path, or passed over where the break is no break.
 * - Idempotent: decoding a decoded value again gives an equal fresh copy, key order included.
 * - Record keys: `__proto__` is an ordinary key of a record.
 * - Unreadable: a proxy or a throwing getter is refused at its path.
 * - Defects: a decoder's own defect escapes decodeWith as itself, at every site.
 * - Refinements: exactly the distinct nonempty names, the nonempty lists and the safe and positive integers pass.
 * - Depth and cycles: a value nested at any depth decodes without deepening the call stack, and one that holds itself is
 *   refused where it meets itself.
 *
 * Oracles: each break's site, the decode's own idempotence, the refinements' definitions, and the value's construction.
 *
 * Features: each break, each decoded form, an own __proto__ key, each unreadable site, each defect site, each
 * refinement admitted and refused, depths within and past a small stack, each cycle length and form.
 *
 * Plants: ir-shape-refusal-at-parent (a field's refusal placed at its container), ir-shape-frozen-passed-through (a
 * frozen value returned as decoded), ir-shape-proto-assigned (__proto__ assigned as the prototype),
 * ir-shape-read-unguarded (a throwing read escapes), ir-shape-defect-swallowed (a decoder's defect refused as malformed),
 * ir-shape-zero-positive (zero taken as positive), ir-shape-deferred-inline (a recursive part read on the call stack),
 * ir-shape-cycle-unrefused (a container that holds itself decoded until the stack overflows).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
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
} from "@grizzle/testing/gen"
import { type Drawn, passed, wild } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import * as S from "#compiler/ir/shape.ts"
import {
	assert,
	nonEmpty,
	type Place,
	placeOf,
	refusalLoc,
	refused,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen, pickOf } from "#test/support/pick.ts"

const point = S.structWith({ x: S.integer }, { label: S.nonEmptyString })
const points = S.array(point)
/**
 * A case whose own optional field is named like the discriminator, of a text no tag of the case is: the decode reads
 * that member as the discriminator, so a field read in its place would refuse it.
 */
const mark = S.structWith(
	{},
	{ kind: S.refine(S.string, (text) => text !== "mark", "a text other than the case's tag") }
)
const shape = S.tagged("kind", { point, list: S.struct({ items: points }), mark })

/**
 * A live value of `shape`: a point, its label stated or not, a list of them, or the case that names a field like the
 * discriminator.
 */
const integer = int(-(2 ** 31), 2 ** 31 - 1)

const pointGen: Gen<{ readonly x: number; readonly label?: string }> = oneOf<{
	readonly x: number
	readonly label?: string
}>([
	(source) => ({ x: source.draw(integer) }),
	(source) => ({
		x: source.draw(integer),
		label: source.draw(string(codePoint(0x20, 0x7e), { min: 1, max: 4 }))
	})
])

const liveGen: Gen<unknown> = oneOf<unknown>([
	map(pointGen, (p) => ({ kind: "point", ...p })),
	map(array(pointGen, { min: 0, max: 4 }), (items) => ({ kind: "list", items })),
	constant({ kind: "mark" })
])

type Path = ReadonlyArray<string | number>

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** The own enumerable string keys of a plain object, as Object.keys lists them. */
const keysOf = (fields: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
	Rec.keys(fields)

/** Every path of a plain value a member can be replaced at: the root first, then each member's, depth first. */
const sitesOf = (value: unknown): readonly [Path, ...Array<Path>] => {
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
const edited = (value: unknown, path: Path, edit: (member: unknown) => unknown): unknown => {
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
const placeAt = (path: Path): Place => ({ label: "v", path })

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
type Break =
	| "null"
	| "unknown key"
	| "symbol key refused"
	| "symbol key passed over"
	| "hole"
	| "unknown tag"
	| "missing member"
	| "class instance"
type Outcome = { readonly kind: "refused"; readonly at: Path } | { readonly kind: "passed over" }
interface Broken {
	readonly break: Break
	readonly value: unknown
	readonly outcome: Outcome
}

const refusedAt = (at: Path): Outcome => ({ kind: "refused", at })

/** Every way to break `live` at one of its sites, by kind: only the kinds the value has a site for. */
const breaksOf = (live: unknown): ReadonlyArray<Arr.NonEmptyReadonlyArray<Broken>> => {
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
type Decoded = "a list of points" | "a point" | "a mark"

type UnreadableFeature =
	| "proxy at the root"
	| "proxy nested"
	| "throwing getter at the root"
	| "throwing getter nested"

/** A decoder's own throw: one decoder step that throws `defect`, and a value its base shape accepts. */
class Defect extends Data.Error<{ readonly site: string }> {}
type DefectKind = "normalize" | "refine" | "brand"
type DefectSite =
	| "the root"
	| "an array item"
	| "a struct field"
	| "a union's first alternative"
	| "a tagged case"

const defective = (
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
const placed = (
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
				shape: S.tagged("kind", { a: S.struct({ n: inner.shape }) }),
				value: { kind: "a", n: inner.value }
			}
	}
}

/**
 * Planted: every break of a list of one labelled point, which holds a site of every kind, its picks the break's group
 * among the kinds and its first site there, since a drawn value and pick meet some breaks a few times a run.
 */
const plantedLive: unknown = { kind: "list", items: [{ x: 1, label: "a" }] }
const breakNames: Arr.NonEmptyReadonlyArray<Break> = [
	"null",
	"unknown key",
	"symbol key refused",
	"symbol key passed over",
	"hole",
	"unknown tag",
	"missing member",
	"class instance"
]

const plantedBreak = (
	name: Break
): { readonly live: unknown; readonly kind: number; readonly site: number } => {
	const groups = breaksOf(plantedLive)
	for (const [g, group] of groups.entries()) {
		const j = Arr.findFirstIndex(group, (b) => b.break === name)
		if (Option.isSome(j)) {
			return {
				live: plantedLive,
				kind: pickOf(g, groups.length),
				site: pickOf(j.value, group.length)
			}
		}
	}
	throw new Error(`the planted value has no site for ${name}`)
}

describe("shapes", () => {
	it.effect(
		"decode a live value into an equal fresh copy, and refuse one broken at one site, naming that site",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each break's own site, compared by its label and path"
						},
						suite: "unit/ir/shape-broken",
						literal: Formatter.format,
						draw: drawn((source) => ({
							live: source.draw(liveGen),
							kind: source.draw(pickGen),
							site: source.draw(pickGen)
						})),
						kept: Arr.map(breakNames, (name) => ({
							note: name,
							sketch: plantedBreak(name),
							draws: "",
							reaches: [name]
						})),
						runs: 300,
						shrink: completeShrink,
						coverage: required<Break>(breakNames, { cases: 300, sense: notesOnly }),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ live, kind, site }, c) =>
						Effect.sync(() => {
							const decoded = succeeded(S.decodeWith(shape, live, "v"))
							assert.deepEqual<unknown>(decoded, structuredClone(live))
							const broken = pickFrom(
								pickFrom(nonEmpty(breaksOf(live), "a live value's breaks"), kind),
								site
							)
							c.note(broken.break)
							const result = S.decodeWith(shape, broken.value, "v")
							if (broken.outcome.kind === "passed over") {
								assert.deepEqual(succeeded(result), decoded)
							} else {
								assert.deepEqual(
									placeOf(refusalLoc(refused(result, "MalformedDescription"))),
									placeAt(broken.outcome.at)
								)
							}
						})
				)
			)
	)

	it.effect("decode a decoded value again into an equal fresh copy, key order included", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "decode ∘ decode = decode, a fresh copy, key order included"
					},
					suite: "unit/ir/shape-idempotent",
					literal: Formatter.format,
					draw: drawn(liveGen),
					runs: 100,
					shrink: completeShrink,
					coverage: required<Decoded>(["a list of points", "a point", "a mark"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(live, c) =>
					Effect.sync(() => {
						const out = succeeded(S.decodeWith(shape, live, "v"))
						c.note(
							out.kind === "point" ? "a point" : out.kind === "list" ? "a list of points" : "a mark"
						)
						const again = succeeded(S.decodeWith(shape, out, "v"))
						assert.notEqual(again, out)
						assert.deepEqual(again, out)
						assert.deepEqual(keysOf({ ...again }), keysOf({ ...out }))
					})
			)
		)
	)

	it.effect("keep __proto__ an ordinary key of a record", (ctx) => {
		const keyGen = oneOf([
			constant("__proto__"),
			element(["constructor", "toString", "a"]),
			string(codePoint(0x20, 0x7e), { min: 1, max: 4 })
		])
		/**
		 * A record's entries: up to five distinct keys, drawn alone, so uniqueArray moves a repeated key among keys alone,
		 * and then each key's integer. A key drawn beside its value would have uniqueArray step through the value's 2^32
		 * integers, which the key never reads, before it reached another key.
		 */
		const entriesGen: Gen<ReadonlyArray<readonly [string, number]>> = (source) => {
			const keys = source.draw(uniqueArray(keyGen, (key) => key, { min: 0, max: 5 }))
			return Arr.map(keys, (key) => [key, source.draw(integer)] as const)
		}
		return searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "a record's entries are its own keys, __proto__ an ordinary one"
					},
					suite: "unit/ir/shape-record-keys",
					literal: Formatter.format,
					draw: drawn(entriesGen),
					runs: 100,
					shrink: completeShrink,
					coverage: required<"an own __proto__ key">(["an own __proto__ key"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(entries, c) =>
					Effect.sync(() => {
						if (Arr.some(entries, ([key]) => key === "__proto__")) {
							c.note("an own __proto__ key")
						}
						/** Record.fromEntries, which is Object.fromEntries, defines each key as an own property, as JSON.parse does. */
						const input = Rec.fromEntries(entries)
						const out = succeeded(
							S.decodeWith(S.recordShape(S.integer, S.nonEmptyString), input, "v")
						)
						unorderedEqual(Rec.toEntries(out), Rec.toEntries(input))
						assert.equal(Object.getPrototypeOf(out), Object.prototype)
					})
			)
		)
	})

	it.effect("refuse a value whose reading throws, at its path", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "a read that throws is refused at its path"
					},
					suite: "unit/ir/shape-unreadable",
					literal: Formatter.format,
					draw: drawn((source) => ({
						live: source.draw(liveGen),
						site: source.draw(pickGen),
						wild: source.draw(
							map(wild(["proxy", "throwing-getter"]), (w): Drawn<never, never> => ({
								kind: "wild",
								wild: w
							}))
						)
					})),
					runs: 200,
					shrink: completeShrink,
					coverage: required<UnreadableFeature>(
						["proxy at the root", "proxy nested", "throwing getter nested"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ live, site, wild: drawnWild }, c) =>
					Effect.sync(() => {
						const path = pickFrom(sitesOf(live), site)
						const kind =
							drawnWild.kind === "wild" && drawnWild.wild.kind === "proxy"
								? "proxy"
								: "throwing getter"
						c.note(`${kind} ${path.length === 0 ? "at the root" : "nested"}`)
						const refusal = refused(
							S.decodeWith(
								shape,
								edited(live, path, () => passed(drawnWild)),
								"v"
							),
							"MalformedDescription"
						)
						assert.deepEqual(placeOf(refusalLoc(refusal)), placeAt(path))
					})
			)
		)
	)

	it.effect("let a decoder's own defect escape", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: "each kind of decoder defect at each site a shape decodes",
					oracle: {
						kind: "specification",
						name: "a decoder's own defect escapes decodeWith as itself"
					},
					suite: "unit/ir/shape-defect-escapes",
					literal: Formatter.format,
					generator: (source) =>
						[
							source.draw(element<DefectKind>(["normalize", "refine", "brand"])),
							source.draw(
								element<DefectSite>([
									"the root",
									"an array item",
									"a struct field",
									"a union's first alternative",
									"a tagged case"
								])
							)
						] as const,
					limit: 15,
					coverage: requiredInSpace<DefectSite>([
						"the root",
						"an array item",
						"a struct field",
						"a union's first alternative",
						"a tagged case"
					]),
					caseHang
				},
				([kind, site], c) =>
					Effect.sync(() => {
						c.note(site)
						const defect = new Defect({ site: `a ${kind} defect in ${site}` })
						const { shape: decoder, value } = placed(site, defective(kind, defect))
						assert.throws(
							() => S.decodeWith(decoder, value, "v"),
							(e) => e === defect
						)
					})
			)
		)
	)

	it.effect(
		"accept exactly the distinct nonempty names, the nonempty lists and the safe and positive integers",
		(ctx) => {
			const numberGen = oneOf([
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
				integer,
				weighted([
					[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
					[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
				])
			])
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "distinct nonempty names, nonempty lists, safe and positive integers"
						},
						suite: "unit/ir/shape-refinements",
						literal: Formatter.format,
						draw: drawn((source) => ({
							names: source.draw(array(element(["", "a", "b", "c"]), { min: 0, max: 4 })),
							list: source.draw(array(integer, { min: 0, max: 3 })),
							n: source.draw(numberGen)
						})),
						runs: 200,
						shrink: completeShrink,
						coverage: required<
							| "names accepted"
							| "a repeated name refused"
							| "an empty name refused"
							| "an empty list refused"
							| "an integer refused"
							| "a positive integer refused"
							| "a positive integer accepted"
						>(
							[
								"names accepted",
								"a repeated name refused",
								"an empty name refused",
								"an empty list refused",
								"an integer refused",
								"a positive integer refused",
								"a positive integer accepted"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ names, list, n }, c) =>
						Effect.sync(() => {
							const distinct = new Set(names).size === names.length
							const nonempty = Arr.every(names, (name) => name.length > 0)
							const decodedNames = S.decodeWith(
								S.uniqueStrings("names", S.nonEmptyString),
								names,
								"v"
							)
							if (distinct && nonempty) {
								c.note("names accepted")
								assert.deepEqual(succeeded(decodedNames), names)
							} else {
								c.note(nonempty ? "a repeated name refused" : "an empty name refused")
								refused(decodedNames, "MalformedDescription")
							}
							const decodedList = S.decodeWith(S.nonEmptyArray(S.integer), list, "v")
							if (list.length > 0) {
								assert.deepEqual<ReadonlyArray<number>>(succeeded(decodedList), list)
							} else {
								c.note("an empty list refused")
								refused(decodedList, "MalformedDescription")
							}
							const safe = Number.isSafeInteger(n)
							const integer = S.decodeWith(S.integer, n, "v")
							if (safe) {
								assert.equal(succeeded(integer), n)
							} else {
								c.note("an integer refused")
								refused(integer, "MalformedDescription")
							}
							const positive = S.decodeWith(S.positiveInteger, n, "v")
							if (safe && n > 0) {
								c.note("a positive integer accepted")
								assert.equal(succeeded(positive), n)
							} else {
								c.note("a positive integer refused")
								refused(positive, "MalformedDescription")
							}
						})
				)
			)
		}
	)
})

/** A chain of links to an end: a recursive tagged union, each link a container of its own. */
type Chain = { readonly kind: "end" } | { readonly kind: "link"; readonly next: Chain }
const chainShape: S.Shape<Chain> = S.ref("a chain", () => chainBody)

/** The decoder chainShape refers to (S.ref). */
const chainBody: S.Shape<Chain> = S.tagged("kind", {
	end: S.struct({}),
	link: S.struct({ next: chainShape })
})

/** Arrays inside arrays around an integer: a recursive union whose first alternative refuses every array. */
type Nested = number | ReadonlyArray<Nested>
const nestedShape: S.Shape<Nested> = S.ref("a nested array", () => nestedBody)

/** The decoder nestedShape refers to (S.ref). */
const nestedBody: S.Shape<Nested> = S.unionShape(S.integer, S.array(nestedShape))

/** The two recursive shapes, read through the shape of any value. */
type Form = "chain" | "nested array"
const formShape = (form: Form): S.Shape<unknown> => (form === "chain" ? chainShape : nestedShape)

/** The step each container of a form takes to the next. */
const stepOf = (form: Form): string | number => (form === "chain" ? "next" : 0)

/** `depth` containers of a form, the innermost around its end. */
const built = (form: Form, depth: number): unknown => {
	let v: unknown = form === "chain" ? { kind: "end" } : 1
	for (let i = 0; i < depth; i++) {
		v = form === "chain" ? { kind: "link", next: v } : [v]
	}
	return v
}

/** How many containers a decoded value of a form nests, counted down its one path. */
const depthOf = (form: Form, value: unknown): number => {
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

/** `length` containers of a form, each holding the next and the last holding the one `back` below the root: the root. */
const cyclic = (form: Form, length: number, back: number): unknown => {
	if (form === "chain") {
		const links = Arr.map(indices(length), (): Record<string, unknown> => ({ kind: "link" }))
		for (const [i, link] of links.entries()) {
			link["next"] = links[i + 1] ?? links[back]
		}
		return links[0]
	}
	const arrays = Arr.map(indices(length), (): Array<unknown> => [])
	for (const [i, items] of arrays.entries()) {
		items.push(arrays[i + 1] ?? arrays[back])
	}
	return arrays[0]
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
const containers: Gen<number> = weighted([
	[3, int(1, smallStackRecursion)],
	[2, int(smallStackRecursion + 1, 10_000)],
	[1, int(10_001, 100_000)]
])

const formGen = element<Form>(["chain", "nested array"])

/** What a nested or cyclic value's case reached: its form, and its containers against the small stack. */
type NestingFeature =
	| Form
	| "no container"
	| "within a small stack's recursion"
	| "past a small stack's recursion"
	| "a cycle back to its root"
	| "a cycle back to its last container"
	| "a cycle back to a container between"

const depthFeature = (n: number): NestingFeature =>
	n === 0
		? "no container"
		: n > smallStackRecursion
			? "past a small stack's recursion"
			: "within a small stack's recursion"

describe("a value nested through a recursive shape", () => {
	it.effect("decode at any depth, the call stack no deeper for it: a fresh copy decoded", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/shape-depth",
					literal: Formatter.format,
					draw: drawn(
						(source) =>
							[
								source.draw(
									weighted([
										[1, constant(0)],
										[6, containers]
									])
								),
								source.draw(formGen)
							] as const
					),
					runs: 12,
					shrink: completeShrink,
					coverage: required<NestingFeature>(
						[
							"chain",
							"nested array",
							"no container",
							"within a small stack's recursion",
							"past a small stack's recursion"
						],
						{ cases: 40, sense: notesOnly }
					),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					oracle: {
						kind: "specification",
						name: "the value's own construction: its form and its depth"
					}
				},
				([depth, form], c) =>
					Effect.sync(() => {
						c.note(form)
						c.note(depthFeature(depth))
						const value = built(form, depth)
						const decoded = succeeded(S.decodeWith(formShape(form), value, "v"))
						assert.equal(depthOf(form, decoded), depth)
						assert.equal(
							decoded === value,
							depth === 0 && form === "nested array",
							"every container decodes to a fresh copy, and an integer to itself"
						)
					})
			)
		)
	)

	it.effect(
		"refuse a value that holds itself as a cycle where it meets itself, however long the cycle",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/shape-cycle",
						literal: Formatter.format,
						/** A cycle through drawn containers, back to its root, its last or one between. */
						draw: drawn((source) => {
							const length = source.draw(containers)
							return [
								length,
								source.draw(
									weighted([
										[1, constant(0)],
										[1, constant(length - 1)],
										[1, int(0, length - 1)]
									])
								),
								source.draw(formGen)
							] as const
						}),
						runs: 12,
						shrink: completeShrink,
						coverage: required<NestingFeature>(
							[
								"chain",
								"nested array",
								"within a small stack's recursion",
								"past a small stack's recursion",
								"a cycle back to its root",
								"a cycle back to its last container",
								"a cycle back to a container between"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the cycle's own construction: the path from its root back to itself"
						}
					},
					([length, back, form], c) =>
						Effect.sync(() => {
							c.note(form)
							c.note(depthFeature(length))
							c.note(
								back === 0
									? "a cycle back to its root"
									: back === length - 1
										? "a cycle back to its last container"
										: "a cycle back to a container between"
							)
							const value = cyclic(form, length, back)
							const refusal = refused(
								S.decodeWith(formShape(form), value, "v"),
								"MalformedDescription"
							)
							assert.deepEqual(
								refusalLoc(refusal).path,
								Arr.map(indices(length), () => stepOf(form))
							)
						})
				)
			)
	)
})
