/** What the property of lookup-images.test.ts reads: its space, its model of a lookup's entry and each case's schema. */

import { defined } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
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
	textImageDatum,
	isTextSketch,
	Kind,
	keyedDatums,
	keyFieldDescriptor,
	keyFieldGen,
	type KeyFieldSketch,
	ownValue,
	postgresBtreeMaxItem
} from "#test/unit/schema/representability.fixtures.ts"

/**
 * The uses a workload's B-tree request is drawn under, each with what it does with its keys: a lookup binds each by
 * equality; a range binds every key but its last, which it reads in its order; a prefix search every key but its last,
 * a prefix of which it matches; a page and a take seek read every key in its order.
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
 * same fields, whose index holds its texts by SHA-256 where its own entry could outgrow BTMaxItemSize.
 */
export interface LookupSketch {
	readonly fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch>
	readonly use: Use
	readonly keyed: boolean
}

const drawnGen: Gen<LookupSketch> = (source) => {
	const [first, ...rest] = source.draw(array(keyFieldGen, { min: 1, max: 4 }))
	return {
		fields: [first ?? { kind: "wildcard" }, ...rest],
		use: source.draw(element(uses)),
		keyed: source.draw(boolean)
	}
}

/**
 * A request whose last key is a text of an octet bound past what its entry leaves it beside its other keys, each an
 * image's width at most, which it reads in its order or matches a prefix of under `use`.
 */
const pastGen =
	(use: Use): Gen<LookupSketch> =>
	(source) => {
		const others = source.draw(array(keyFieldGen, { min: 0, max: 2 }))
		const last: KeyFieldSketch = { kind: "octet contract", bytes: source.draw(int(2700, 2800)) }
		return { fields: Arr.append(others, last), use, keyed: false }
	}

/**
 * A request over numerics, of the widest precision a field takes, whose entry outgrows BTMaxItemSize with no text in
 * it to hold by an image or to name.
 */
const numericsGen: Gen<LookupSketch> = (source) => {
	const count = source.draw(int(6, 8))
	const fields = Array.from({ length: count }, (): KeyFieldSketch => ({
		kind: "numeric",
		precision: source.draw(int(900, 1000)),
		scale: 0
	}))
	return {
		fields: Arr.append(fields, { kind: "numeric", precision: 1000, scale: 0 }),
		use: source.draw(element(uses)),
		keyed: false
	}
}

export const lookupGen: Aimed<LookupSketch, LookupFeature> = aimed(drawnGen, [
	["refused naming an ordered text", pastGen("page seek")],
	["refused naming a prefixed text", pastGen("prefix search")],
	["refused for its bytes", numericsGen]
])

/** What each use does with its every key but its last, and with its last, stated from the use alone. */
const useRoles: Readonly<Record<Use, { readonly rest: EntryRole; readonly last: EntryRole }>> = {
	"equality lookup": { rest: "equality", last: "equality" },
	range: { rest: "equality", last: "order" },
	"prefix search": { rest: "equality", last: "prefix" },
	"page seek": { rest: "order", last: "order" },
	"take seek": { rest: "order", last: "order" }
}

/** What each of a request's keys is to its entry, stated from its use alone (`useRoles`). */
const rolesOf = (use: Use, keys: number): ReadonlyArray<EntryRole> =>
	Array.from({ length: keys }, (_, at) => (at < keys - 1 ? useRoles[use].rest : useRoles[use].last))

/**
 * The model's verdict on the request's created index, restated from PostgreSQL's B-tree item limit (BTMaxItemSize,
 * 2,704 bytes) and pg_type's sizes: where its keys, each as itself, fit an entry, every key as itself; otherwise every
 * text it binds by equality wider than an image, 32 hexadecimal digits under a varlena header, or of no byte bound, by
 * its image, and every other key as itself. An entry that still holds a text of no bound is refused as unbounded; one
 * still past the limit is refused naming the texts wider than an image it reads in their order or matches a prefix of,
 * where it holds any, and for its bytes otherwise.
 */
type LookupVerdict =
	| { readonly kind: "installed"; readonly imaged: ReadonlyArray<boolean> }
	| { readonly kind: "unbounded" }
	| { readonly kind: "ordered"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "entry" }

export const lookupVerdict = (s: LookupSketch): LookupVerdict => {
	const roles = rolesOf(s.use, s.fields.length)
	const own = Arr.map(s.fields, datumOf)
	const bounded = Arr.filter(own, (d): d is Datum => d !== undefined)
	const fits = bounded.length === own.length && btreeTupleBytes(bounded) <= postgresBtreeMaxItem
	const imaged = Arr.map(s.fields, (f, i) => {
		const datum = own[i]
		return (
			!fits &&
			roles[i] === "equality" &&
			isTextSketch(f) &&
			(datum === undefined || datum.bytes > textImageDatum.bytes)
		)
	})
	const held = Arr.map(own, (d, i) => (imaged[i] === true ? textImageDatum : d))
	const heldBounded = Arr.filter(held, (d): d is Datum => d !== undefined)
	if (heldBounded.length < held.length) {
		return { kind: "unbounded" }
	}
	if (btreeTupleBytes(heldBounded) <= postgresBtreeMaxItem) {
		return { kind: "installed", imaged }
	}
	const ordered = Arr.flatMap(s.fields, (f, i) =>
		roles[i] !== "equality" && isTextSketch(f) && defined(held[i]).bytes > textImageDatum.bytes
			? [fieldName(i)]
			: []
	)
	return ordered.length > 0 ? { kind: "ordered", fields: ordered } : { kind: "entry" }
}

/** Whether a candidate key over the drawn fields has a representable entry, its texts held by SHA-256 where it would outgrow one. */
export const keyAdmitted = (s: LookupSketch): boolean =>
	btreeTupleBytes(Arr.map(keyedDatums(s.fields), (d) => d.datum)) <= postgresBtreeMaxItem

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
	role: "access",
	use: s.use
})

/** The installation of the case's schema with its request, as the workload extension contributes a program's. */
export const installLookup = (s: LookupSketch) => {
	const owned = succeeded(lookupSchema(s), "the case's schema owned")
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting([lookupRequest(s)])]
	})
}

export type LookupFeature =
	| "every key as itself"
	| "an equality held by its image"
	| "a text of no bound held by its image"
	| "an ordered text held as itself beside an image"
	| "refused naming an ordered text"
	| "refused naming a prefixed text"
	| "refused for its bytes"
	| "refused as unbounded"
	| "a key holding a text by its digest"
	| "served by the key's index"
