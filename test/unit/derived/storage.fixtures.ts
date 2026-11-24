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
import { Fn, Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, fn, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"

/**
 * A document's places, keyed by its document first, a link from a place to a place of any document, and a note at a
 * place, whose text has no byte bound: the document is the unit a stored relation over them stands in, (document,
 * place) the widest one.
 */
const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
const Link = relation(
	"Link",
	{ doc: pg.integer, at: pg.integer, toDoc: pg.integer, toAt: pg.integer },
	["doc", "at"]
)
const Note = relation("Note", { doc: pg.integer, at: pg.integer, body: str.regex("^.*$", "su") }, [
	"doc",
	"at"
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
 * - `cast value`: each place with its value cast, a column no table of the base holds, which a reader looks it up by:
 *   edullm's NamedDeclaration, a declaration's identifier a cast of its attribute's text, which the judge of
 *   PlacedVariableRefDeclaration's reference rule read by filtering every identifier attribute of a document per key;
 * - `unrepresentable`: each document's note texts, whose one key, its whole heading, holds a text of no byte bound;
 * - `closed alone`: a closed relation's handles, no relation a write changes.
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
	| "cast value"
	| "unrepresentable"
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
	"cast value",
	"unrepresentable",
	"closed alone"
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
 * A case: a shape over the base, every relation closed under any declared unit or none, or Doc open, which is open only
 * inside a declared unit.
 */
export type StorageCase =
	| { readonly shape: Shape; readonly mutability: "closed"; readonly declared: Declared }
	| { readonly shape: Shape; readonly mutability: "Doc open"; readonly declared: DeclaredUnit }

export const storageCase: Gen<StorageCase> = (s) => {
	const shape = s.draw(element(shapes))
	switch (s.draw(element<Mutability>(["closed", "Doc open"]))) {
		case "closed":
			return {
				shape,
				mutability: "closed",
				declared: s.draw(element<Declared>(["none", "document", "place"]))
			}
		case "Doc open":
			return {
				shape,
				mutability: "Doc open",
				declared: s.draw(element<DeclaredUnit>(["document", "place"]))
			}
	}
}

/**
 * Where the installation keeps a derived relation's rows: `stored`, its table's unit fields and the declared unit it
 * sits in, with its fields carrying that unit's key; or `live`, by the condition of unit-locality its definition lacks,
 * or because its table could not hold its rows.
 */
export type Holding =
	| {
			readonly kind: "stored"
			readonly fields: ReadonlyArray<string>
			readonly declared: { readonly unit: string; readonly fields: ReadonlyArray<string> }
	  }
	| { readonly kind: "live"; readonly lacks: UnitLocalityCondition | "representability" }

/** Each shape's own verdict before its declared unit (`holdingOf`): the unit its definition delivers, whether its table
 * could hold its rows, or the condition of unit-locality it lacks. */
type Local =
	| {
			readonly kind: "local"
			readonly fields: ReadonlyArray<string>
			readonly representable: boolean
	  }
	| { readonly kind: "lacks"; readonly lacks: UnitLocalityCondition }

const local = (fields: ReadonlyArray<string>): Local => ({
	kind: "local",
	fields,
	representable: true
})

const ownVerdict: { readonly [S in Shape]: Local } = {
	projection: local(["doc", "at"]),
	renamed: local(["document", "place"]),
	"by document": local(["doc"]),
	hidden: { kind: "lacks", lacks: "hidden" },
	"counted by document": local(["doc"]),
	"counted across documents": { kind: "lacks", lacks: "aggregate" },
	"joined across documents": { kind: "lacks", lacks: "split" },
	"negated within": local(["doc", "at"]),
	"negated across": { kind: "lacks", lacks: "negation" },
	"immutable call": local(["doc", "at"]),
	"stable call": { kind: "lacks", lacks: "call" },
	"call of a stable call": { kind: "lacks", lacks: "call" },
	"cast value": local(["doc", "at"]),
	unrepresentable: { kind: "local", fields: ["doc"], representable: false },
	"closed alone": { kind: "lacks", lacks: "noUnit" }
}

/** Each declared unit's name and key, its fields. */
const declaredUnits = {
	document: { unit: "Document", key: ["doc"] },
	place: { unit: "Place", key: ["doc", "at"] }
} as const

/**
 * The rule (analysis/derived/storage.ts), restated: a definition that reads no relation a write changes lacks a unit;
 * any other is unit-local at the widest unit its head delivers, every match binding the unit to the rule's variables,
 * every negation correlated at them, every aggregate grouping by them and every function it calls immutable throughout,
 * or live by the first of these it lacks at the narrowest unit, the document; it sits in one declared unit whose key
 * leads its own, whether Doc is closed or open, its fields carrying that unit's key its first, or is live for its
 * borrow; and it is stored where its table holds its rows, live otherwise.
 */
export const holdingOf = (c: StorageCase): Holding => {
	const own = ownVerdict[c.shape]
	if (own.kind === "lacks") {
		return { kind: "live", lacks: own.lacks }
	}
	if (c.declared === "none") {
		return { kind: "live", lacks: "borrow" }
	}
	const declared = declaredUnits[c.declared]
	if (declared.key.length > own.fields.length) {
		return { kind: "live", lacks: "borrow" }
	}
	return own.representable
		? {
				kind: "stored",
				fields: own.fields,
				declared: { unit: declared.unit, fields: own.fields.slice(0, declared.key.length) }
			}
		: { kind: "live", lacks: "representability" }
}

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
					return r.match(Doc, { doc, at, v: x }).find({ document: doc, place: at, v: x })
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
		case "hidden":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, v: x } = v(Doc, "d")
					return r.match(Doc, { doc, at, v: x }).find({ v: x })
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
		case "unrepresentable":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, body } = v(Note, "n")
					return r.match(Note, { doc, at, body }).find({ doc, body })
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
	}
}

/** The unit of the document, and the unit of the document and its place. */
const documentUnit = unit("Document", { doc: pg.integer })
const placeUnit = unit("Place", { doc: pg.integer, at: pg.integer })

/** Each declared unit's statement. */
const unitStatements = { document: documentUnit, place: placeUnit } as const

/** The base: the documents, the links, the notes, the closed relation and the functions, a unit declared and Doc open
 * inside it where the case says. */
const baseOf = (c: StorageCase) =>
	schema(
		"StorageInference",
		[Doc, Link, Note, Kind, pure, drifting, wrapped],
		c.mutability === "Doc open"
			? [mutable(Doc), unitStatements[c.declared]]
			: c.declared === "none"
				? []
				: [unitStatements[c.declared]]
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
		case "stored":
			return {
				kind: "stored",
				fields: holding.relation.unit.fields,
				declared: {
					unit: holding.relation.unit.declared.unit,
					fields: holding.relation.unit.declared.fields
				}
			}
		case "live":
			return {
				kind: "live",
				lacks:
					holding.why.kind === "notUnitLocal" ? holding.why.lacks.condition : "representability"
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
