/**
 * What the property of storage.test.ts reads: the definitions of the box, the holding the installation infers of each,
 * the holding the rule restated gives, and the relations a read and a write of it compile to read.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import type { UnitLocalityCondition } from "#compiler/core/causes.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { servedQuery } from "#compiler/ir/derived.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { Fn, Logic, Num, Type } from "#compiler/public/compute.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, type SelfSource, v } from "#compiler/public/query.ts"
import {
	closed,
	derived,
	fn,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"

/**
 * A document's places, keyed by its document first, a link from a place to a place of any document, ranked by a
 * natural, and a note at a place, whose text has no byte bound: the document is the unit a stored relation over them
 * stands in, (document, place) the widest one.
 */
const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
const Link = relation(
	"Link",
	{ doc: pg.integer, at: pg.integer, toDoc: pg.integer, toAt: pg.integer, rank: natural },
	["doc", "at"]
)
const Note = relation("Note", { doc: pg.integer, at: pg.integer, body: str.regex("^.*$", "su") }, [
	"doc",
	"at"
])
/**
 * A place's marks, each by its number under the place, keyed by the document, the place and the number: a relation
 * the unit of the place reads at a prefix of its key, as ledger's TestMoment is read at its sitting.
 */
const Mark = relation("Mark", { doc: pg.integer, at: pg.integer, n: pg.integer, v: pg.integer }, [
	"doc",
	"at",
	"n"
])
const Kind = closed.ordered("Kind", ["first", "second"])

/** An immutable function, a stable one, and an immutable one whose body calls the stable one. */
const pure = fn("pure", {
	calls: [],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT x + 1`
})
const drifting = fn("drifting", {
	calls: [],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "stable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT x + 1`
})
const wrapped = fn("wrapped", {
	calls: [drifting],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT drifting(x)`
})

/**
 * A derived relation's definition:
 *
 * - `projection`: every place, by its document and place, Doc's own rows (LiveReason `copy`);
 * - `renamed`: the places of a value at least 0, a selection, no copy, its unit delivered under other names;
 * - `by document`: each document's values, which deliver the document and drop the place;
 * - `self-placed`: each document's value at the place its own number names, Doc read at its whole key through that
 *   equality, the document's variable binding both its fields: den's Requested, a root's own scope at Scope(root, root);
 * - `hidden`: the values of at least 0 alone, which deliver no unit;
 * - `counted by document`: each document's count of places;
 * - `counted across documents`: each value's count of places, over every document;
 * - `joined across documents`: each link with the value at the place it names, in another document;
 * - `negated within`: each place no link leaves;
 * - `negated across`: each link whose target place is absent, a negation of another document;
 * - `immutable call`, `stable call`, `call of a stable call`: each place with a function of its value;
 * - `cast value`: each place with its value cast, a column no table of the base holds, which a reader looks it up by:
 *   edullm's NamedDeclaration, a declaration's identifier a cast of its attribute's text, which the judge of
 *   PlacedVariableRefDeclaration's reference rule read by filtering every identifier attribute of a document per key;
 * - `interior count`: each document's count of places, counted in an interior stage of the rule that reads it: ledger's
 *   ItemDuration, an interior stage being the closed sub-query an import of its arms is;
 * - `literal arm`: a union of each place at rank 0n, a bare literal its position types, and each link's place at its
 *   rank, a natural: edullm's assembledPartRows, a test document's parts at instance 0n beside its instances' parts;
 * - `unrepresentable`: each place's note text, from two arms, so no key narrower than its whole heading is proven and
 *   its one key holds a text of no byte bound;
 * - `closed alone`: a closed relation's handles, no relation a write changes;
 * - `marked place`: each mark with its place's value, the mark's own place binding Doc's whole key: rooted at the mark;
 * - `first mark`: each place's value beside its mark 0 of a value at least 0, Mark's whole key held by the place and a
 *   literal its condition's conjunct equates the number to: pantry's attribute of a name, read at its element's place
 *   and the name a conjunct of `namedIn` holds;
 * - `unmarked place`: each place no mark of it stands at, Mark negated at a prefix of its key, a probe of one row:
 *   metis's Active, a sitting no closing event of it stands at;
 * - `marks of either value`: a union of the values of each place's marks numbered below 5 and of those numbered 5 or
 *   more, each arm Mark read at the place alone: rooted arm by arm, no arm's number binding the other's, as metis's AssignmentStatus, a union of four arms over a sitting's events;
 * - `next mark`: each mark with the least mark of its place after it, the place's marks read at the place and a range
 *   for each mark: a successor, one probe of Mark's order after the mark (ledger's presentedSpans, the least moment of a
 *   sitting after each presentation);
 * - `next number's mark`: each mark beside the mark numbered one more, a computed equality binding the second's number
 *   (ledger's SittingOrder, a candidate session's suspension beside the next session's visit);
 * - `marked before another`: each mark a later mark of its place follows, the later one an existence test (metis's
 *   laterReports);
 * - `latest mark beside each`: each mark beside its place's latest mark's value, the latest number an imported fold's
 *   at the place (ledger's latestMoments under presentPieces);
 * - `mark pairs`: each pair of marks of a place, both numbers delivered, which no root binds: a product;
 * - `reachable places`: the places a document reaches from its place 0 back along its links, a recursion at the
 *   document, live under no founded unit, which no write's delta keeps (grizzle's stored Hops, as it was).
 */
export type Shape =
	| "projection"
	| "renamed"
	| "by document"
	| "self-placed"
	| "hidden"
	| "counted by document"
	| "counted across documents"
	| "joined across documents"
	| "negated within"
	| "negated across"
	| "immutable call"
	| "stable call"
	| "call of a stable call"
	| "cast value"
	| "interior count"
	| "literal arm"
	| "unrepresentable"
	| "closed alone"
	| "marked place"
	| "next mark"
	| "first mark"
	| "unmarked place"
	| "marks of either value"
	| "next number's mark"
	| "marked before another"
	| "latest mark beside each"
	| "mark pairs"
	| "reachable places"

const shapes = [
	"projection",
	"renamed",
	"by document",
	"self-placed",
	"hidden",
	"counted by document",
	"counted across documents",
	"joined across documents",
	"negated within",
	"negated across",
	"immutable call",
	"stable call",
	"call of a stable call",
	"cast value",
	"interior count",
	"literal arm",
	"unrepresentable",
	"closed alone",
	"marked place",
	"next mark",
	"first mark",
	"unmarked place",
	"marks of either value",
	"next number's mark",
	"marked before another",
	"latest mark beside each",
	"mark pairs",
	"reachable places"
] as const satisfies ReadonlyArray<Shape>

/** Whether every relation is closed, or Doc is open: mutable, written in place inside its unit. */
type Mutability = "closed" | "Doc open"

/**
 * A unit the base declares: `document`, keyed by the document, which every relation of the base sits in; or `place`,
 * keyed by the document and the place, which they sit in too, a unit wider than a definition that drops the place.
 */
export type DeclaredUnit = "document" | "place"

/** The unit the base declares: none, or one of the two. */
export type Declared = "none" | DeclaredUnit

/**
 * Doc's keys: its primary key alone, or v too, a key of its own, so a head that delivers v determines the document and
 * the place of its fact through Doc, a head hiding them (analysis/theory/unit.ts HiddenUnit).
 */
export type Keys = "primary" | "v too"

/**
 * A case: a shape over the base, every relation closed under any declared unit or none, or Doc open, which is open only
 * inside a declared unit, and Doc's keys.
 */
export type StorageCase =
	| {
			readonly shape: Shape
			readonly mutability: "closed"
			readonly declared: Declared
			readonly keys: Keys
	  }
	| {
			readonly shape: Shape
			readonly mutability: "Doc open"
			readonly declared: DeclaredUnit
			readonly keys: Keys
	  }

export const storageCase: Gen<StorageCase> = (s) => {
	const shape = s.draw(element(shapes))
	const keys = s.draw(element<Keys>(["primary", "v too"]))
	switch (s.draw(element<Mutability>(["closed", "Doc open"]))) {
		case "closed":
			return {
				shape,
				mutability: "closed",
				declared: s.draw(element<Declared>(["none", "document", "place"])),
				keys
			}
		case "Doc open":
			return {
				shape,
				mutability: "Doc open",
				declared: s.draw(element<DeclaredUnit>(["document", "place"])),
				keys
			}
	}
}

/**
 * Where the installation keeps a derived relation's rows: `stored`, its table's unit fields and the declared unit it
 * sits in, with its fields carrying that unit's key; `frozen`, stored and frozen at the installation, its definition
 * reading no relation a program writes; or `live`, by the condition of unit-locality its definition lacks, or because
 * its table could not hold its rows.
 */
export type Holding =
	| {
			readonly kind: "stored"
			readonly fields: ReadonlyArray<string>
			readonly declared: { readonly unit: string; readonly fields: ReadonlyArray<string> }
			/** What bounds its upkeep (analysis/derived/storage.ts UpkeepBound): its unit's key, or its delta form. */
			readonly bound: "unit" | "delta"
	  }
	| { readonly kind: "frozen" }
	| {
			readonly kind: "live"
			readonly lacks:
				| UnitLocalityCondition
				| "unboundedUpkeep"
				| "recursion"
				| "representability"
				| "copy"
	  }

/** Each shape's own verdict before its declared unit (`holdingOf`): the unit its definition delivers, whether its table
 * could hold its rows and how its reads bound its upkeep there (`Reads`); a recursion at the unit it delivers, which no
 * unit of the box founds, so it is live at any declared unit it sits in; the condition of unit-locality it lacks; or
 * `copy`, Doc's own rows projected onto a key of Doc with no condition stated, live whatever the unit. */
type Local =
	| {
			readonly kind: "local"
			readonly fields: ReadonlyArray<string>
			readonly representable: boolean
			readonly reads: Reads
	  }
	| { readonly kind: "recursive"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "lacks"; readonly lacks: UnitLocalityCondition }
	| { readonly kind: "frozen" }
	| { readonly kind: "copy" }

/**
 * How a definition's reads bound its upkeep at its unit (analysis/derived/storage.ts deltaBounded): `keyed`, every read
 * of a relation at a key of it the unit's variables bind, so its upkeep reads one row of each at a key; `rooted`, some
 * read, its root, binding with the unit's variables a key of every other read, one after another (analysis/theory/unit.ts
 * unitRooted), which bounds the upkeep of a unit wider than the declared one, its re-derivation of the keys a write
 * touched reading the root's rows and one row of each other relation for each; or `unrooted`, neither. Where its reads
 * bound none, its delta form bounds it or nothing does (`Delta`).
 */
type Reads =
	| { readonly kind: "keyed" }
	| { readonly kind: "rooted" | "unrooted"; readonly delta: Delta }

/**
 * A definition's delta form, which bounds its upkeep where its unit bounds none (analysis/theory/upkeep.ts deltaBoundOf):
 * `checked`, each fact a write gains read from the rows it wrote outward and each fact it withdraws read at the fact or
 * from its table at more than its unit's fields, an existence test of one occurrence read by a seek (each document's
 * values, a place of each at the document and the value), stored; `monotone`, its arms negating nothing, so a write that
 * removes no row only gains facts, stored where every relation it holds is closed and live for its upkeep where it holds
 * Doc open, whose served deletes withdraw facts no read at the fact finds (no shape of the box over Doc); or `none`, an
 * arm reading a fold's groups or a definition of several rules as a query, live for its upkeep.
 */
export type Delta = "checked" | "monotone" | "none"

/** The width of the key of every relation of the box but Mark, (doc, at): a unit key of that width holds the key of each. */
const holdersKeyWidth = 2

/** A definition unit-local at `fields` whose every read is keyed there (`Reads` `keyed`). */
const keyedAt = (fields: ReadonlyArray<string>): Local => ({
	kind: "local",
	fields,
	representable: true,
	reads: { kind: "keyed" }
})

/** A definition unit-local at `fields`, its reads rooted there or not and keyed nowhere, of delta form `delta`. */
const unkeyedAt = (
	fields: ReadonlyArray<string>,
	rooted: "rooted" | "unrooted",
	delta: Delta
): Local => ({ kind: "local", fields, representable: true, reads: { kind: rooted, delta } })

/** A definition unit-local at `fields` reading relations keyed (doc, at) alone: its every read keyed where its unit is
 * the place, and rooted at the document, of delta form `delta` there. */
const local = (fields: ReadonlyArray<string>, delta: Delta): Local =>
	fields.length >= holdersKeyWidth ? keyedAt(fields) : unkeyedAt(fields, "rooted", delta)

const ownVerdict: { readonly [S in Shape]: Local } = {
	projection: { kind: "copy" },
	renamed: keyedAt(["document", "place"]),
	"by document": local(["doc"], "checked"),
	"self-placed": keyedAt(["doc"]),
	hidden: { kind: "lacks", lacks: "hidden" },
	"counted by document": local(["doc"], "none"),
	"counted across documents": { kind: "lacks", lacks: "aggregate" },
	"joined across documents": { kind: "lacks", lacks: "split" },
	"negated within": keyedAt(["doc", "at"]),
	"negated across": { kind: "lacks", lacks: "negation" },
	"immutable call": keyedAt(["doc", "at"]),
	"stable call": { kind: "lacks", lacks: "call" },
	"call of a stable call": { kind: "lacks", lacks: "call" },
	"cast value": keyedAt(["doc", "at"]),
	"interior count": local(["doc"], "none"),
	"literal arm": keyedAt(["doc", "at"]),
	unrepresentable: {
		kind: "local",
		fields: ["doc", "at"],
		representable: false,
		reads: { kind: "keyed" }
	},
	"closed alone": { kind: "frozen" },
	"marked place": unkeyedAt(["doc", "at"], "rooted", "checked"),
	"next mark": unkeyedAt(["doc", "at"], "rooted", "none"),
	"first mark": keyedAt(["doc", "at"]),
	"unmarked place": keyedAt(["doc", "at"]),
	"marks of either value": unkeyedAt(["doc", "at"], "rooted", "monotone"),
	"next number's mark": unkeyedAt(["doc", "at"], "rooted", "checked"),
	"marked before another": unkeyedAt(["doc", "at"], "rooted", "monotone"),
	"latest mark beside each": unkeyedAt(["doc", "at"], "rooted", "none"),
	"mark pairs": unkeyedAt(["doc", "at"], "unrooted", "checked"),
	"reachable places": { kind: "recursive", fields: ["doc"] }
}

/**
 * The shapes whose head delivers v and hides the place, or the document and the place: where v is a key of Doc, the
 * head determines them through it, so each is unit-local at (doc, at), its table holding its head and the fields it
 * hides beside it (analysis/theory/unit.ts withUnitHeads), and its own verdict is that unit.
 */
const determinedByV: ReadonlySet<Shape> = new Set<Shape>(["hidden", "by document"])

/**
 * The case's own verdict (`ownVerdict`), the unit a head determines through Doc's key on v where v is one; where v is
 * one, each document's values are Doc's own rows projected onto that key, a copy of Doc.
 */
const ownOf = (c: StorageCase): Local =>
	c.keys !== "v too" || !determinedByV.has(c.shape)
		? ownVerdict[c.shape]
		: c.shape === "by document"
			? { kind: "copy" }
			: keyedAt(["doc", "at"])

/** Each declared unit's name and key, its fields. */
const declaredUnits = {
	document: { unit: "Document", key: ["doc"] },
	place: { unit: "Place", key: ["doc", "at"] }
} as const

/**
 * The rule (analysis/derived/storage.ts), restated: a definition whose rows are Doc's own, projected onto a key of Doc
 * with no condition stated (`projection`, and each document's values where v is a key), is live as a copy of
 * Doc, whatever unit is declared; a definition that reads no relation a write changes, every function
 * it calls immutable, is stored frozen at the installation, whatever unit is declared; any other is unit-local at the
 * widest unit its head delivers, or hides and determines through a key of Doc (`determinedByV`), every match binding
 * the unit to the rule's variables, every negation correlated at them, every aggregate grouping by them and every
 * function it calls immutable throughout,
 * or live by the first of these it lacks at the narrowest unit, the document; it sits in one declared unit whose key
 * leads its own, whether Doc is closed or open, its fields carrying that unit's key its first, or is live for its
 * borrow; it is live for its recursion, which no unit of the box founds; its upkeep is bounded (`upkeepBound`) by its
 * unit, or by its delta form, or it is live for its upkeep; and it is stored where its table holds its rows, live
 * otherwise.
 */
export const holdingOf = (c: StorageCase): Holding => {
	const own = ownOf(c)
	if (own.kind === "copy") {
		return { kind: "live", lacks: "copy" }
	}
	if (own.kind === "lacks") {
		return { kind: "live", lacks: own.lacks }
	}
	if (own.kind === "frozen") {
		return own
	}
	if (c.declared === "none") {
		return { kind: "live", lacks: "borrow" }
	}
	const declared = declaredUnits[c.declared]
	if (declared.key.length > own.fields.length) {
		return { kind: "live", lacks: "borrow" }
	}
	if (own.kind === "recursive") {
		return { kind: "live", lacks: "recursion" }
	}
	const bound = upkeepBound(c, own, declared.key.length)
	if (bound === undefined) {
		return { kind: "live", lacks: "unboundedUpkeep" }
	}
	return own.representable
		? {
				kind: "stored",
				fields: own.fields,
				declared: { unit: declared.unit, fields: own.fields.slice(0, declared.key.length) },
				bound
			}
		: { kind: "live", lacks: "representability" }
}

/**
 * What bounds the upkeep of a case unit-local at `own` inside a declared unit of `width` key fields (`holdingOf`): its
 * unit (`unit`), where its reads are keyed there (no unit of the box is sealed), or rooted at a unit wider than the
 * declared one, whose upkeep re-derives the keys a write touched alone; else its delta form (`delta`, `deciding`), where
 * it is checked or monotone over closed relations, Mark always and Doc unless open; else nothing, its upkeep
 * re-deriving the whole declared unit, or each relation's rows at the key for each row of another.
 */
const upkeepBound = (
	c: StorageCase,
	own: Extract<Local, { readonly kind: "local" }>,
	width: number
): "unit" | "delta" | undefined => {
	const delta = deciding(own, width)
	if (delta === undefined) {
		return "unit"
	}
	return delta === "checked" ||
		(delta === "monotone" && (c.mutability === "closed" || holderOf(c.shape) === "Mark"))
		? "delta"
		: undefined
}

/** The delta form that decides the upkeep of a definition unit-local at `own` inside a declared unit of `width` key
 * fields, where its reads bound none there (`Reads`); none where they do. */
const deciding = (
	own: Extract<Local, { readonly kind: "local" }>,
	width: number
): Delta | undefined => {
	const reads = own.reads
	return reads.kind === "keyed" || (reads.kind === "rooted" && own.fields.length > width)
		? undefined
		: reads.delta
}

/** The delta form that decides a case's upkeep (`deciding`), where it is unit-local inside its declared unit and its
 * reads bound no upkeep there; none otherwise. */
export const decidingDelta = (c: StorageCase): Delta | undefined => {
	const own = ownOf(c)
	return own.kind === "local" && c.declared !== "none"
		? deciding(own, declaredUnits[c.declared].key.length)
		: undefined
}

/** The shapes whose definition reads Mark alone, of the relations a write changes. */
const markOnly: ReadonlySet<Shape> = new Set<Shape>([
	"next mark",
	"marks of either value",
	"next number's mark",
	"marked before another",
	"latest mark beside each",
	"mark pairs"
])

/** A relation the shape's definition reads, which a write of it changes: Mark where it reads Mark alone, else Doc. */
export const holderOf = (shape: Shape): string => (markOnly.has(shape) ? "Mark" : "Doc")

/** The name of the case's derived relation. */
export const derivedName = "Held"

/** The derived relation of shape `shape` over `base`, its definition stated in its arm. */
const derivedOf = (shape: Shape, base: ReturnType<typeof baseOf>) => {
	switch (shape) {
		case "projection":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, v: x })
				})
			)
		case "renamed":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r
						.match(Doc, { doc, at, v: x })
						.where(r.ge(x, 0))
						.find({ document: doc, place: at, v: x })
				})
			)
		case "by document":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, v: x })
				})
			)
		case "self-placed":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at: doc, v: x }).find({ doc, v: x })
				})
			)
		case "hidden":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).where(r.ge(x, 0)).find({ v: x })
				})
			)
		case "counted by document":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at } = v(Doc, "d")
					return r.match(Doc, { doc, at }).find({ doc, places: r.count() })
				})
			)
		case "counted across documents":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ v: x, places: r.count() })
				})
			)
		case "joined across documents":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, toDoc, toAt } = v(Link, "l")
					const { v: x } = v(Doc, "d")
					return r
						.match(Link, { doc, at, toDoc, toAt })
						.match(Doc, { doc: toDoc, at: toAt, v: x })
						.find({ doc, at, v: x })
				})
			)
		case "negated within":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r
						.match(Doc, { doc, at, v: x })
						.where(r.not(Link, { doc, at }))
						.find({ doc, at, v: x })
				})
			)
		case "negated across":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, toDoc } = v(Link, "l")
					return r
						.match(Link, { doc, at, toDoc })
						.where(r.not(Doc, { doc: toDoc, at }))
						.find({ doc, at })
				})
			)
		case "immutable call":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(pure, { x }) })
				})
			)
		case "stable call":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(drifting, { x }) })
				})
			)
		case "call of a stable call":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(wrapped, { x }) })
				})
			)
		case "cast value":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r
						.match(Doc, { doc, at, v: x })
						.find({ doc, at, identifier: Type.cast(x, pg.bigint) })
				})
			)
		case "interior count":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const counts = r.interior((s) => {
						const { doc, at } = v(Doc, "d")
						return s.match(Doc, { doc, at }).find({ doc, places: s.count() })
					})
					const { doc, places } = v(counts, "counts")
					return r.match(counts, { doc, places }).find({ doc, places })
				})
			)
		case "literal arm":
			return derived(
				derivedName,
				query(base)
					.rule((r) => {
						const { doc, at } = v(Doc, "d")
						return r.match(Doc, { doc, at }).find({ doc, at, rank: 0n })
					})
					.rule((r) => {
						const { doc, at, rank } = v(Link, "l")
						return r.match(Link, { doc, at, rank }).find({ doc, at, rank })
					})
			)
		case "unrepresentable":
			return derived(
				derivedName,
				query(base)
					.rule((r) => {
						const { doc, at, body } = v(Note, "n")
						return r.match(Note, { doc, at, body }).find({ doc, at, body })
					})
					.rule((r) => {
						const { doc, at, body } = v(Note, "linked")
						return r.match(Note, { doc, at, body }).where(r.ge(at, 0)).find({ doc, at, body })
					})
			)
		case "closed alone":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { id } = v(Kind, "k")
					return r.match(Kind, { id }).find({ id })
				})
			)
		case "marked place":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n } = v(Mark, "m")
					const { v: x } = v(Doc, "d")
					return r
						.match(Mark, { doc, at, n })
						.match(Doc, { doc, at, v: x })
						.find({ doc, at, n, v: x })
				})
			)
		case "next mark":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n } = v(Mark, "m")
					const { n: next } = v(Mark, "after")
					return r
						.match(Mark, { doc, at, n })
						.match(Mark, { doc, at, n: next })
						.where(r.gt(next, n))
						.find({ doc, at, n, end: r.min(next) })
				})
			)
		case "next number's mark":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n, v: x } = v(Mark, "this")
					const { n: following, v: y } = v(Mark, "following")
					return r
						.match(Mark, { doc, at, n, v: x })
						.match(Mark, { doc, at, n: following, v: y })
						.where(r.eq(following, Num.add(n, 1)))
						.find({ doc, at, n, v: x, w: y })
				})
			)
		case "marked before another":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n } = v(Mark, "earlier")
					const { n: later } = v(Mark, "later")
					return r
						.match(Mark, { doc, at, n })
						.match(Mark, { doc, at, n: later })
						.where(r.gt(later, n))
						.find({ doc, at, n })
				})
			)
		case "latest mark beside each": {
			const latest = query(base).rule((r) => {
				const { doc, at, n } = v(Mark, "latestNumber")
				return r.match(Mark, { doc, at, n }).find({ doc, at, n: r.max(n) })
			})
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n, v: x } = v(Mark, "each")
					const { n: last } = v(latest, "latest")
					const { v: y } = v(Mark, "latestMark")
					return r
						.match(Mark, { doc, at, n, v: x })
						.match(latest, { doc, at, n: last })
						.match(Mark, { doc, at, n: last, v: y })
						.find({ doc, at, n, v: x, w: y })
				})
			)
		}
		case "mark pairs":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n } = v(Mark, "first")
					const { n: second } = v(Mark, "second")
					return r
						.match(Mark, { doc, at, n })
						.match(Mark, { doc, at, n: second })
						.find({ doc, at, n, second })
				})
			)
		case "reachable places": {
			const reached = { doc: pg.integer, at: pg.integer }
			return derived(
				derivedName,
				query(base).recursive("Reached", {
					row: reached,
					base: [
						(r) => {
							const { doc, at } = v(Doc, "origin")
							return r.match(Doc, { doc, at }).where(r.eq(at, 0)).find({ doc, at })
						}
					],
					rec: [
						(r, self: SelfSource<typeof reached>) => {
							const s = v(self, "s")
							const l = v(Link, "l")
							return r
								.match(self, { doc: s.doc, at: s.at })
								.match(Link, { doc: s.doc, at: l.at, toDoc: s.doc, toAt: s.at })
								.find({ doc: s.doc, at: l.at })
						}
					]
				})
			)
		}
		case "marks of either value":
			return derived(
				derivedName,
				query(base)
					.rule((r) => {
						const { doc, at, n, v: x } = v(Mark, "low")
						return r.match(Mark, { doc, at, n, v: x }).where(r.lt(n, 5)).find({ doc, at, w: x })
					})
					.rule((r) => {
						const { doc, at, n, v: x } = v(Mark, "high")
						return r.match(Mark, { doc, at, n, v: x }).where(r.ge(n, 5)).find({ doc, at, w: x })
					})
			)
		case "unmarked place":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r
						.match(Doc, { doc, at, v: x })
						.where(r.not(Mark, { doc, at }))
						.find({ doc, at, v: x })
				})
			)
		case "first mark":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					const { n: held, v: y } = v(Mark, "first")
					return r
						.match(Doc, { doc, at, v: x })
						.match(Mark, { doc, at, n: held, v: y })
						.where(Logic.and([Logic.eq(held, 0), Logic.ge(y, 0)]))
						.find({ doc, at, v: x, w: y })
				})
			)
	}
}

/** The unit of the document, and the unit of the document and its place. */
const documentUnit = unit("Document", { doc: pg.integer })
const placeUnit = unit("Place", { doc: pg.integer, at: pg.integer })

/** Each declared unit's statement. */
const unitStatements = { document: documentUnit, place: placeUnit } as const

/** The base: the documents, the links, the notes, the closed relation and the functions, a unit declared, Doc open
 * inside it and v a key of Doc where the case says. */
const baseOf = (c: StorageCase) =>
	schema(
		"StorageInference",
		[Doc, Link, Note, Mark, Kind, pure, drifting, wrapped],
		[
			...(c.mutability === "Doc open"
				? [mutable(Doc), unitStatements[c.declared]]
				: c.declared === "none"
					? []
					: [unitStatements[c.declared]]),
			...(c.keys === "v too" ? [key(on(Doc, "v"))] : [])
		]
	)

/**
 * The case's schema, the base and above it the derived relation of its shape, and a read of its every row: one rule
 * matching it, each field of its heading bound to a variable and delivered under its own name.
 */
export const storageSchemaOf = (c: StorageCase) => {
	const base = baseOf(c)
	const held = derivedOf(c.shape, base)
	const fields = Rec.keys<string, unknown>(held.heading)
	const read = decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: Arr.map(fields, (field) => ({ id: field, origin: { relation: derivedName, field } })),
				matches: [
					{
						source: { kind: "relation", name: derivedName },
						bindings: Rec.fromEntries(
							Arr.map(fields, (field) => [field, { kind: "var" as const, var: field }] as const)
						)
					}
				],
				where: [],
				head: Rec.fromEntries(
					Arr.map(fields, (field) => [field, { kind: "var" as const, var: field }] as const)
				),
				interiors: [],
				attach: []
			}
		]
	})
	return { top: schema.extend([base], "StorageInferenceTop", [held], []), read }
}

/** The holding the compile states (`Holding`): the derived relation's stored unit, or why it is live. */
export const holdingStated = (artifacts: SchemaArtifacts): Holding | `other ${string}` => {
	const holding = artifacts.laws.checked.holdings.get(derivedName)
	if (holding === undefined) {
		return "other no holding"
	}
	switch (holding.kind) {
		case "stored": {
			const unit = holding.relation.unit
			return unit.kind === "installation"
				? { kind: "frozen" }
				: {
						kind: "stored",
						fields: unit.fields,
						declared: { unit: unit.declared.unit, fields: unit.declared.fields },
						bound: holding.bound
					}
		}
		case "live":
			return {
				kind: "live",
				lacks:
					holding.why.kind === "notUnitLocal"
						? holding.why.lacks.condition
						: holding.why.kind === "unboundedUpkeep" ||
							  holding.why.kind === "recursion" ||
							  holding.why.kind === "copy"
							? holding.why.kind
							: "representability"
			}
	}
}

/**
 * The relations a query checked over the artifacts' checked schema reads as its lowering reads it (ir/derived.ts
 * servedQuery), by name, by a statement of a write that writes the relations `written`: each derived relation whose
 * table serves the read (analysis/schema.ts CheckedSchema serves) by its table, every other through its definition.
 */
export const readsOf = (
	artifacts: SchemaArtifacts,
	desc: InferredQuery,
	written: ReadonlySet<string>
): ReadonlySet<string> => {
	const schema = artifacts.laws.checked
	const checked = succeeded(
		checkQuery(schema, desc, {
			read: "rows",
			label: "a read of the derived relation",
			clock: noClock,
			session: new CheckSession(schema.patterns)
		}),
		"the checker admits the read"
	)
	const served = servedQuery(checked, schema.rows(written))
	return new Set(
		Arr.flatMap(topoOrder(served.dag), (node) => (node.kind === "Base" ? [node.relation] : []))
	)
}
