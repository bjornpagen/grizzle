/** What the property of stored-admission.test.ts reads: the definitions of the box, and the verdict each states. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { UnitLocalityCondition } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { StoredUnit } from "#compiler/ir/unit.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, fn, mutable, relation, schema, unit } from "#compiler/public/schema.ts"

/**
 * A document's places, keyed by its document first, and a link from a place to a place of any document: the document
 * is the unit a stored relation over them stands in, (document, place) the widest one.
 */
const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
const Link = relation(
	"Link",
	{ doc: pg.integer, at: pg.integer, toDoc: pg.integer, toAt: pg.integer },
	["doc", "at"]
)
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
 * A stored relation's definition:
 *
 * - `projection`: every place, by its document and place;
 * - `renamed`: the same, its unit delivered under other names;
 * - `by document`: each document's values, which deliver the document and drop the place;
 * - `hidden`: the values alone, which deliver no unit;
 * - `counted by document`: each document's count of places;
 * - `counted across documents`: each value's count of places, over every document;
 * - `joined across documents`: each link with the value at the place it names, in another document;
 * - `negated within`: each place no link leaves;
 * - `negated across`: each link whose target place is absent, a negation of another document;
 * - `immutable call`, `stable call`, `call of a stable call`: each place with a function of its value;
 * - `closed alone`: a closed relation's handles, no stored relation.
 */
export type Shape =
	| "projection"
	| "renamed"
	| "by document"
	| "hidden"
	| "counted by document"
	| "counted across documents"
	| "joined across documents"
	| "negated within"
	| "negated across"
	| "immutable call"
	| "stable call"
	| "call of a stable call"
	| "closed alone"

const shapes = [
	"projection",
	"renamed",
	"by document",
	"hidden",
	"counted by document",
	"counted across documents",
	"joined across documents",
	"negated within",
	"negated across",
	"immutable call",
	"stable call",
	"call of a stable call",
	"closed alone"
] as const satisfies ReadonlyArray<Shape>

/** Whether every relation is immutable, or Doc is mutable: open, written in place inside its unit. */
type Mutability = "immutable" | "Doc mutable"

/**
 * A unit the base declares: `document`, keyed by the document, which Doc and Link both sit in; or `place`, keyed by the
 * document and the place, which they sit in too, a unit wider than a definition that drops the place.
 */
export type DeclaredUnit = "document" | "place"

/** The unit the base declares: none, or one of the two. */
export type Declared = "none" | DeclaredUnit

/**
 * A case: a shape over the base, every relation immutable under any declared unit or none, or Doc mutable, which is
 * open only inside a declared unit.
 */
export type StoredCase =
	| { readonly shape: Shape; readonly mutability: "immutable"; readonly declared: Declared }
	| { readonly shape: Shape; readonly mutability: "Doc mutable"; readonly declared: DeclaredUnit }

export const storedCase: Gen<StoredCase> = (s) => {
	const shape = s.draw(element(shapes))
	switch (s.draw(element<Mutability>(["immutable", "Doc mutable"]))) {
		case "immutable":
			return {
				shape,
				mutability: "immutable",
				declared: s.draw(element<Declared>(["none", "document", "place"]))
			}
		case "Doc mutable":
			return {
				shape,
				mutability: "Doc mutable",
				declared: s.draw(element<DeclaredUnit>(["document", "place"]))
			}
	}
}

/**
 * What a stored relation's admission decides: its unit's fields and the declared unit it sits in, with its fields
 * carrying that unit's key; or the condition of unit-locality it lacks.
 */
export type Verdict =
	| {
			readonly kind: "admitted"
			readonly fields: ReadonlyArray<string>
			readonly declared: { readonly unit: string; readonly fields: ReadonlyArray<string> }
	  }
	| { readonly kind: "refused"; readonly lacks: UnitLocalityCondition }

/** Each shape's verdict before its declared unit (`verdictOf`): the unit its definition delivers, or what it lacks. */
type Local =
	| { readonly kind: "local"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "refused"; readonly lacks: UnitLocalityCondition }

const ownVerdict: { readonly [S in Shape]: Local } = {
	projection: { kind: "local", fields: ["doc", "at"] },
	renamed: { kind: "local", fields: ["document", "place"] },
	"by document": { kind: "local", fields: ["doc"] },
	hidden: { kind: "refused", lacks: "hidden" },
	"counted by document": { kind: "local", fields: ["doc"] },
	"counted across documents": { kind: "refused", lacks: "aggregate" },
	"joined across documents": { kind: "refused", lacks: "split" },
	"negated within": { kind: "local", fields: ["doc", "at"] },
	"negated across": { kind: "refused", lacks: "negation" },
	"immutable call": { kind: "local", fields: ["doc", "at"] },
	"stable call": { kind: "refused", lacks: "call" },
	"call of a stable call": { kind: "refused", lacks: "call" },
	"closed alone": { kind: "refused", lacks: "noUnit" }
}

/** Each declared unit's name and key, its fields. */
const declaredUnits = {
	document: { unit: "Document", key: ["doc"] },
	place: { unit: "Place", key: ["doc", "at"] }
} as const

/**
 * The rule (analysis/theory/unit.ts storedUnit; d11-design.md §2), restated: a definition that reads no stored relation
 * lacks a unit; any other is unit-local at the widest unit its head delivers, every match binding the unit to the
 * rule's variables, every negation correlated at them, every aggregate grouping by them and every function it calls
 * immutable throughout, or refused by the first of these it lacks at the narrowest unit, the document; and admitted
 * where every relation it reads sits in one declared unit whose key leads its own, Doc open or not, its fields carrying
 * that unit's key its first, else refused for its borrow.
 */
export const verdictOf = (c: StoredCase): Verdict => {
	const local = ownVerdict[c.shape]
	if (local.kind === "refused") {
		return local
	}
	if (c.declared === "none") {
		return { kind: "refused", lacks: "borrow" }
	}
	const declared = declaredUnits[c.declared]
	return declared.key.length > local.fields.length
		? { kind: "refused", lacks: "borrow" }
		: {
				kind: "admitted",
				fields: local.fields,
				declared: { unit: declared.unit, fields: local.fields.slice(0, declared.key.length) }
			}
}

/** The name of the case's stored relation. */
export const storedName = "Stored"

/** The stored relation of shape `shape` over `base`, its definition stated in its arm. */
const storedOf = (shape: Shape, base: ReturnType<typeof baseOf>) => {
	switch (shape) {
		case "projection":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, v: x })
				})
			)
		case "renamed":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ document: doc, place: at, v: x })
				})
			)
		case "by document":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, v: x })
				})
			)
		case "hidden":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ v: x })
				})
			)
		case "counted by document":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at } = v(Doc, "d")
					return r.match(Doc, { doc, at }).find({ doc, places: r.count() })
				})
			)
		case "counted across documents":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ v: x, places: r.count() })
				})
			)
		case "joined across documents":
			return derived.stored(
				storedName,
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
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r
						.match(Doc, { doc, at, v: x })
						.where(r.not(Link, { doc, at }))
						.find({ doc, at, v: x })
				})
			)
		case "negated across":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, toDoc } = v(Link, "l")
					return r
						.match(Link, { doc, at, toDoc })
						.where(r.not(Doc, { doc: toDoc, at }))
						.find({ doc, at })
				})
			)
		case "immutable call":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(pure, { x }) })
				})
			)
		case "stable call":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(drifting, { x }) })
				})
			)
		case "call of a stable call":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ doc, at, w: Fn.call(wrapped, { x }) })
				})
			)
		case "closed alone":
			return derived.stored(
				storedName,
				query(base).rule((r) => {
					const { id } = v(Kind, "k")
					return r.match(Kind, { id }).find({ id })
				})
			)
	}
}

/** The unit of the document, and the unit of the document and its place. */
const documentUnit = unit("Document", { doc: pg.integer })
const placeUnit = unit("Place", { doc: pg.integer, at: pg.integer })

/** Each declared unit's statement. */
const unitStatements = { document: documentUnit, place: placeUnit } as const

/** The base: the documents, the links, the closed relation and the functions, a unit declared and Doc mutable inside it
 * where the case says. */
const baseOf = (c: StoredCase) =>
	schema(
		"StoredAdmission",
		[Doc, Link, Kind, pure, drifting, wrapped],
		c.mutability === "Doc mutable"
			? [mutable(Doc), unitStatements[c.declared]]
			: c.declared === "none"
				? []
				: [unitStatements[c.declared]]
	)

/** The case's schema: the base, and above it the stored relation of its shape. */
export const storedSchemaOf = (c: StoredCase) => {
	const base = baseOf(c)
	return schema.extend([base], "StoredAdmissionTop", [storedOf(c.shape, base)], [])
}

/** The verdict a compile states (`Verdict`): the stored unit's fields where it compiled, or the condition of a
 * notUnitLocal refusal; any other refusal by its tag. */
export const verdictStated = (
	compiled:
		| { readonly ok: true; readonly stored: StoredUnit | undefined }
		| { readonly ok: false; readonly error: CompileError }
): Verdict | `other ${string}` => {
	if (compiled.ok) {
		return compiled.stored === undefined
			? "other compiled with no stored unit"
			: {
					kind: "admitted",
					fields: compiled.stored.fields,
					declared: { unit: compiled.stored.declared.unit, fields: compiled.stored.declared.fields }
				}
	}
	const reason = compiled.error.reason
	return reason._tag === "DerivedRefused" && reason.cause.kind === "notUnitLocal"
		? { kind: "refused", lacks: reason.cause.lacks.condition }
		: `other ${reason._tag}`
}
