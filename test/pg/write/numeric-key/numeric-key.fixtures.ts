/** What the property of numeric-key.test.ts reads: its schema, its programs, its space and its model. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Decimal, pg } from "#compiler/public/fields.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A key over numerics wider than a B-tree entry holds them by their images, the SHA-256 digest of each one's one text,
 * `trim_scale(x)::text` (core/identity.ts KeyImage `numericDigest`), so the key compares them as numeric's equality
 * does. The schema holds Parent(value, n, payload), keyed by (value, n), `value` a `pg.numeric` of no typmod;
 * Child(id, value, n), whose (value, n) Parent's key contains; and Wide(a, b, c, d, e, f, payload), keyed by its six
 * `pg.numeric(1000, 0)` fields, an entry of six 510-byte numerics past the B-tree item limit. The programs insert each
 * from its facts.
 */

const Parent = relation("Parent", { value: pg.numeric, n: pg.integer, payload: pg.integer }, [
	"value",
	"n"
])

const Child = relation("Child", { id: pg.integer, value: pg.numeric, n: pg.integer }, ["id"])

const Wide1000 = pg.numeric(1000, 0)

const Wide = relation(
	"Wide",
	{
		a: Wide1000,
		b: Wide1000,
		c: Wide1000,
		d: Wide1000,
		e: Wide1000,
		f: Wide1000,
		payload: pg.integer
	},
	["a", "b", "c", "d", "e", "f"]
)

/** The schema of a case under `name`. */
const keysSchema = (name: string) =>
	schema(
		name,
		[Parent, Child, Wide],
		[contained(on(Child, "value", "n"), on(Parent, "value", "n"))]
	)

/** The programs of a schema of `name`: each relation's insertion from its facts. */
export const programsOf = (name: string) => {
	const s = keysSchema(name)
	return {
		insertParent: ChangeSet.empty(s).insert(Parent, []),
		insertChild: ChangeSet.empty(s).insert(Child, []),
		insertWide: ChangeSet.empty(s).insert(Wide, [])
	}
}

/** The installation of the case's schema as a template, which every case clones. */
export const keysTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "numeric_key",
	content: { programs: ["insertParent", "insertChild", "insertWide"] },
	build: (name) => {
		const s = keysSchema(name)
		return { schema: s, logins: [fullWorld(s, programsOf(name)).server] }
	},
	ambient: ordinarySession
})

/** The served world of a case over its installation's declared name. */
export const worldOf = (declared: string) => fullWorld(keysSchema(declared), programsOf(declared))

/** The decimals a key's value is drawn from: small ones, a fraction, numeric's widest integer, NaN and the infinities. */
const valueTexts: ReadonlyArray<string> & Readonly<{ 0: string }> = [
	"0",
	"1.5",
	"-7",
	"0.17",
	"123456789012345678901234567890.000000000000000000001",
	Str.repeat(numericMaxIntegerDigits)("9"),
	"NaN",
	"Infinity",
	"-Infinity"
]

/** A drawn value's Decimal, as the host parses it. */
export const decimalOf = (text: string): Decimal =>
	succeeded(Decimal.fromString(text), "a drawn decimal")

export interface ParentRow {
	readonly value: string
	readonly n: number
	readonly payload: number
}

export interface ChildRow {
	readonly id: number
	readonly value: string
	readonly n: number
}

/** A Wide row: its six fields' digits, each of at most 1,000, and its payload. */
export interface WideRow {
	readonly fields: readonly [bigint, bigint, bigint, bigint, bigint, bigint]
	readonly payload: number
}

export interface KeyCase {
	readonly parents: ReadonlyArray<ParentRow>
	readonly children: ReadonlyArray<ChildRow>
	readonly wide: ReadonlyArray<WideRow>
}

const parentGen: Gen<ParentRow> = (source) => ({
	value: source.draw(element(valueTexts)),
	n: source.draw(int(0, 1)),
	payload: source.draw(int(0, 1))
})

/** 10^999 + k: a 1,000-digit integer, the widest numeric(1000, 0) holds, differing from its kin in its last digit. */
const wideDigit = (k: number): bigint => 10n ** 999n + BigInt(k)

const wideGen: Gen<WideRow> = (source) => ({
	fields: [
		wideDigit(source.draw(int(0, 1))),
		wideDigit(0),
		wideDigit(0),
		wideDigit(0),
		wideDigit(0),
		wideDigit(source.draw(int(0, 1)))
	],
	payload: source.draw(int(0, 1))
})

export const caseGen: Gen<KeyCase> = (source) => ({
	parents: source.draw(array(parentGen, { min: 1, max: 4 })),
	children: Arr.map(source.draw(array(parentGen, { min: 0, max: 3 })), (p, id) => ({
		id,
		value: p.value,
		n: p.n
	})),
	wide: source.draw(array(wideGen, { min: 1, max: 3 }))
})

/** A row's key, as the model compares keys: each value's one text, as numeric's equality compares it. */
const parentKey = (r: { readonly value: string; readonly n: number }): string =>
	`${decimalOf(r.value).text}|${r.n}`

const wideKey = (r: WideRow): string => Arr.join(Arr.map(r.fields, String), "|")

/**
 * The set model of an insertion into an empty relation keyed by `key`: refused where two rows share a key and differ,
 * and otherwise the distinct rows.
 */
const insertion = <R>(
	rows: ReadonlyArray<R>,
	key: (r: R) => string,
	same: (a: R, b: R) => boolean
):
	| { readonly kind: "refused" }
	| { readonly kind: "accepted"; readonly rows: ReadonlyArray<R> } => {
	const byKey = new Map<string, R>()
	for (const r of rows) {
		const held = byKey.get(key(r))
		if (held !== undefined && !same(held, r)) {
			return { kind: "refused" }
		}
		byKey.set(key(r), r)
	}
	return { kind: "accepted", rows: [...byKey.values()] }
}

export const parentModel = (c: KeyCase) =>
	insertion(
		c.parents,
		parentKey,
		(a, b) => parentKey(a) === parentKey(b) && a.payload === b.payload
	)

export const wideModel = (c: KeyCase) =>
	insertion(c.wide, wideKey, (a, b) => wideKey(a) === wideKey(b) && a.payload === b.payload)

/** Whether every child names a stored parent's key, as the containment holds. */
export const childrenContained = (stored: ReadonlyArray<ParentRow>, c: KeyCase): boolean =>
	Arr.every(c.children, (child) => Arr.some(stored, (p) => parentKey(p) === parentKey(child)))

/** A Parent row as the owner reads it back: its value's one text, its n and payload, one text per row. */
export const parentText = (r: ParentRow): string => `${parentKey(r)}|${r.payload}`

/**
 * The value's text with trailing fraction zeros added, another spelling of the same numeric: an integer's `.00`, a
 * fraction's `00`, NaN's lower case, an infinity's as it is; one whose image is the value's only through trim_scale.
 */
export const respelled = (text: string): string =>
	text === "NaN"
		? "nan"
		: Str.includes(".")(text)
			? `${text}00`
			: text === "Infinity" || text === "-Infinity"
				? text
				: `${text}.00`

export type KeyFeature =
	| "a parent of numeric's widest integer"
	| "a parent of NaN"
	| "a parent of an infinity"
	| "parents refused at a shared key"
	| "parents accepted"
	| "a respelled key refused by its image"
	| "children contained through images"
	| "a child of no parent refused"
	| "wide keys accepted, held by images"
	| "wide keys refused at a shared key"

/** The features a case reaches by its draw. */
export const drawnFeatures = (c: KeyCase): ReadonlyArray<KeyFeature> => [
	...(Arr.some(c.parents, (p) => p.value.length > 1000)
		? (["a parent of numeric's widest integer"] as const)
		: []),
	...(Arr.some(c.parents, (p) => p.value === "NaN") ? (["a parent of NaN"] as const) : []),
	...(Arr.some(c.parents, (p) => p.value === "Infinity" || p.value === "-Infinity")
		? (["a parent of an infinity"] as const)
		: [])
]
