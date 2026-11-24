/** What the property of lookup-entries.test.ts reads: its space, its model of a lookup's entry and each case's schema. */

import { defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	element,
	type Gen,
	int,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { EntryRole } from "#compiler/core/identity.ts"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { AccessUse, IndexRequest } from "#compiler/ir/products.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { keyBuilder, onBuilder } from "#compiler/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { requesting } from "#test/unit/physical/fixtures.ts"
import {
	btreeTupleBytes,
	type Datum,
	datumOf,
	Kind,
	keyFieldDescriptor,
	keyFieldGen,
	type KeyFieldSketch,
	ownValue,
	postgresBtreeMaxItem
} from "#test/unit/schema/representability.fixtures.ts"

/**
 * The uses a workload's B-tree request is drawn under, each with what it does with its keys: a lookup binds each by
 * equality; a range binds every key but its last, which it reads in its order; a prefix search every key but its last,
 * a prefix of which it matches; a page and a take seek bind a prefix of its keys, those its equalities fix, and read
 * every key after it in its order.
 */
const uses = [
	"equality lookup",
	"range",
	"prefix search",
	"page seek",
	"take seek"
] as const satisfies ReadonlyArray<AccessUse>

type Use = (typeof uses)[number]

/**
 * A case: the request's keys, each a field of R drawn over pg_type's sizes (a fixed-width type, numeric(p, s), a text
 * bounded by its pattern or a contract, or of no byte bound), its use, and whether R declares a candidate key over the
 * same fields, refused where it could outgrow BTMaxItemSize.
 */
export interface LookupSketch {
	readonly fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch>
	readonly use: Use
	/** How many of its keys, from the first, it binds by equality (AccessPath `fixed`), as its use allows. */
	readonly fixed: number
	readonly keyed: boolean
}

/** How many of `keys` keys a request of `use` binds by equality: a seek's drawn prefix, before at least one it orders. */
const fixedGen =
	(use: Use, keys: number): Gen<number> =>
	(source) => {
		switch (use) {
			case "equality lookup":
				return keys
			case "range":
			case "prefix search":
				return keys - 1
			case "page seek":
			case "take seek":
				return source.draw(int(0, keys - 1))
		}
	}

const drawnGen: Gen<LookupSketch> = (source) => {
	const [first, ...rest] = source.draw(array(keyFieldGen, { min: 1, max: 4 }))
	const fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch> = [first ?? { kind: "wildcard" }, ...rest]
	const use = source.draw(element(uses))
	return {
		fields,
		use,
		fixed: source.draw(fixedGen(use, fields.length)),
		keyed: source.draw(boolean)
	}
}

/**
 * A seek whose fixed prefix leads with a text of no byte bound, then any keys it fixes or orders: no entry holds the
 * fixed text, and R declares no digest of it to seek by, so the request is refused naming it.
 */
const seekGen: Gen<LookupSketch> = (source) => {
	const others = source.draw(array(keyFieldGen, { min: 1, max: 3 }))
	const fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch> = [{ kind: "wildcard" }, ...others]
	const use = source.draw(element(["page seek", "take seek"] as const))
	return { fields, use, fixed: source.draw(int(1, fields.length - 1)), keyed: false }
}

/**
 * A request whose last key is a text of an octet bound past what its entry leaves it beside its other keys, which it
 * reads in its order or matches a prefix of under `use`.
 */
const pastGen =
	(use: Use): Gen<LookupSketch> =>
	(source) => {
		const others = source.draw(array(keyFieldGen, { min: 0, max: 2 }))
		const last: KeyFieldSketch = { kind: "octet contract", bytes: source.draw(int(2700, 2800)) }
		const fields = Arr.append(others, last)
		return { fields, use, fixed: source.draw(fixedGen(use, fields.length - 1)), keyed: false }
	}

/**
 * A range over numerics, of the widest precision a field takes, whose entry outgrows BTMaxItemSize where the equalities
 * it may leave out are too few to bring it under: refused for its bytes, its ordered numeric named.
 */
const numericsGen: Gen<LookupSketch> = (source) => {
	const count = source.draw(int(6, 8))
	const fields = Array.from({ length: count }, (): KeyFieldSketch => ({
		kind: "numeric",
		precision: source.draw(int(900, 1000)),
		scale: 0
	}))
	const widest: KeyFieldSketch = { kind: "numeric", precision: 1000, scale: 0 }
	const all = Arr.append(fields, widest)
	return { fields: all, use: "page seek", fixed: 0, keyed: false }
}

/**
 * An equality lookup over two bounded texts whose entries fit alone and pass BTMaxItemSize together, beside any keys of
 * fixed width: the index leaves the wider out, a filter beside it, and holds the rest.
 */
const wideGen: Gen<LookupSketch> = (source) => {
	const others = source.draw(
		array(element([{ kind: "fixed", type: "integer" } as const]), { min: 0, max: 2 })
	)
	const fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch> = [
		{ kind: "octet contract", bytes: source.draw(int(1400, 1600)) },
		{ kind: "octet contract", bytes: source.draw(int(1400, 1600)) },
		...others
	]
	return { fields, use: "equality lookup", fixed: fields.length, keyed: false }
}

export const lookupGen: Aimed<LookupSketch, LookupFeature> = aimed(
	weighted([
		[5, drawnGen],
		[1, wideGen]
	]),
	[
		["refused naming an ordered text", pastGen("page seek")],
		["refused naming a prefixed text", pastGen("prefix search")],
		["refused naming an ordered numeric", numericsGen],
		["a seek's fixed text refused undigested", seekGen]
	]
)

/** What each use does with a key past those it binds by equality, stated from the use alone. */
const pastRole: Readonly<Record<Use, EntryRole>> = {
	"equality lookup": "equality",
	range: "order",
	"prefix search": "prefix",
	"page seek": "order",
	"take seek": "order"
}

/** What each of a request's keys is to its entry: an equality for each it fixes, then its use's (`pastRole`). */
const rolesOf = (s: LookupSketch): ReadonlyArray<EntryRole> =>
	Array.from({ length: s.fields.length }, (_, at) => (at < s.fixed ? "equality" : pastRole[s.use]))

/**
 * The model's verdict on the request's created index, restated from PostgreSQL's B-tree item limit (BTMaxItemSize,
 * 2,704 bytes) and pg_type's sizes, every key as itself in any order (`btreeTupleBytes`): a request that binds a text of
 * no byte bound by equality is refused naming each such text, since no entry holds one and R declares no digest of it to
 * seek by (README "Keys and indexes"; KeyFault `undigestedText`), and it binds none of R's keys; where its keys fit an entry,
 * every key; otherwise each key it binds by equality left out, the widest first (a key of no byte bound widest of all),
 * the first of two as wide, until the rest fit, each left out a filter beside the index. One it reads in its order or
 * matches a prefix of stays: one of no byte bound is refused as unbounded, and an entry those still overfill is
 * refused naming its varlenas among them, or for its bytes where it holds none. A request left no key is refused by
 * the widest it binds.
 */
type LookupVerdict =
	| { readonly kind: "undigested"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "installed"; readonly held: ReadonlyArray<number> }
	| { readonly kind: "unbounded" }
	| { readonly kind: "ordered"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "entry" }

/** A key's width where the index leaves keys out: its datum's bytes, a key of no byte bound the widest of all. */
const widthOf = (d: Datum | undefined): number => d?.bytes ?? Number.POSITIVE_INFINITY

export const lookupVerdict = (s: LookupSketch): LookupVerdict => {
	const roles = rolesOf(s)
	const own = Arr.map(s.fields, datumOf)
	const undigested = Arr.flatMap(s.fields, (f, i) =>
		roles[i] === "equality" && f.kind === "wildcard" ? [fieldName(i)] : []
	)
	if (undigested.length > 0) {
		return { kind: "undigested", fields: undigested }
	}
	const fits = (held: ReadonlyArray<number>): boolean => {
		const datums = Arr.map(held, (i) => own[i])
		const bounded = Arr.filter(datums, (d): d is Datum => d !== undefined)
		return bounded.length === datums.length && btreeTupleBytes(bounded) <= postgresBtreeMaxItem
	}
	let held: ReadonlyArray<number> = Arr.map(s.fields, (_, i) => i)
	while (!fits(held)) {
		const equalities = Arr.filter(held, (i) => roles[i] === "equality")
		const [first, ...rest] = equalities
		if (first === undefined) {
			break
		}
		const widest = Arr.reduce(rest, first, (w, i) => (widthOf(own[i]) > widthOf(own[w]) ? i : w))
		held = Arr.filter(held, (i) => i !== widest)
	}
	if (held.length > 0 && fits(held)) {
		return { kind: "installed", held }
	}
	const blame =
		held.length > 0
			? held
			: [
					Arr.reduce(
						Arr.map(s.fields, (_, i) => i),
						0,
						(w, i) => (widthOf(own[i]) > widthOf(own[w]) ? i : w)
					)
				]
	if (Arr.some(blame, (i) => own[i] === undefined)) {
		return { kind: "unbounded" }
	}
	const ordered = Arr.flatMap(blame, (i) =>
		roles[i] !== "equality" && !defined(own[i], "a bounded key").fixed ? [fieldName(i)] : []
	)
	return ordered.length > 0 ? { kind: "ordered", fields: ordered } : { kind: "entry" }
}

/** Whether a candidate key over the drawn fields fits its entry, every field as itself in any order. */
export const keyAdmitted = (s: LookupSketch): boolean => {
	const own = Arr.map(s.fields, datumOf)
	const bounded = Arr.filter(own, (d): d is Datum => d !== undefined)
	return bounded.length === own.length && btreeTupleBytes(bounded) <= postgresBtreeMaxItem
}

/** The name of R's field at `i`, a key of the request. */
export const fieldName = (i: number): string => `k${i}`

/** R, its key `id` and a field for each drawn key, and the candidate key over them where the case draws one, owned. */
export const lookupSchema = (s: LookupSketch) => {
	const fields = Rec.fromEntries(
		Arr.map(s.fields, (f, i) => [fieldName(i), keyFieldDescriptor(f, i)])
	)
	const names = Rec.keys(fields)
	const R = relation("R", { id: Id, ...fields }, ["id"], [])
	return ownValue(
		schema("Lookups", [Kind, R], s.keyed ? [keyBuilder(onBuilder(R, names))] : [], [])
	)
}

/** The case's one access request, over R's drawn fields in their order, under its use. */
const lookupRequest = (s: LookupSketch): IndexRequest => ({
	relation: "R",
	keys: Arr.map(s.fields, (_, i) => ({
		expr: fieldName(i),
		dir: "asc" as const,
		opclass: defaultOpclass
	})),
	method: "btree",
	fixed: s.fixed,
	role: "access",
	use: s.use
})

/**
 * The installation of the case's schema with its request, stated twice, as two programs that read alike contribute it
 * (the workload extension): the index created for the first serves the second, by the keys that fit its entry where it
 * leaves some out.
 */
export const installLookup = (s: LookupSketch) => {
	const owned = succeeded(lookupSchema(s), "the case's schema owned")
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting([lookupRequest(s), lookupRequest(s)])]
	})
}

export type LookupFeature =
	| "every key held"
	| "an equality left out"
	| "a text of no bound refused undigested"
	| "an ordered key held beside a filter"
	| "refused naming an ordered text"
	| "refused naming a prefixed text"
	| "refused naming an ordered numeric"
	| "refused as unbounded"
	| "served by the key's index"
	| "a seek's fixed text refused undigested"
