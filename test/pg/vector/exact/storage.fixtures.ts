/** What the properties of storage.test.ts read: its spaces, models and helpers. */

import { array, constant, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { float } from "@bjornpagen/testing/values"
import { Array as Arr, pipe, Record as Rec, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { nonEmpty, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { installedTemplate } from "#test/support/install-migrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"

export const Embedding = relation(
	"Embedding",
	{ id: uuid, value: pg.vector(4), raw: pg.vector(4) },
	["id"]
)

const Store = schema("VectorStore", [Embedding], [])

/** A relation keyed by a vector: its key's B-tree index compares by pgvector's equality. */
export const Point = relation("Point", { at: pg.vector(2), label: pg.integer }, ["at"])

const Points = schema("VectorPoints", [Point], [])

export const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

export const embeddingType = (): ScalarType => scalarOf({ kind: "vector", dimensions: 4 }, {})

export const lowest = cosineNormMin

export const highest = cosineNormMax

/** The largest finite binary32 value. */
const floatMax = Math.fround(3.4028234663852886e38)

/**
 * A component: the norm's bounds and their binary32 neighbours, a quarter of the least norm, values that underflow or
 * overflow binary32, the non-finite ones, -0, and any binary32 value.
 */
const componentGen: Gen<number> = oneOf([
	element([
		0,
		-0,
		1,
		lowest / 2,
		lowest,
		Math.fround(lowest * (1 - 2 ** -24)),
		highest,
		highest * (1 + 2 ** -23),
		highest * 2,
		1e-50,
		1e39,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	]),
	float(-floatMax, floatMax)
])

/**
 * A vector under test, as a writer spells it: its components drawn one by one, all equal (four of half the least norm
 * have the least norm exactly), or one at a bound of the norm and the others zero; of the column's dimensions or one
 * more or fewer; in one of the relation's vector columns, the other holding a unit vector.
 */
interface StoredSketch {
	readonly column: VectorColumn
	readonly components: ReadonlyArray<number>
}

/** The relation's vector columns. */
type VectorColumn = (typeof vectorColumns)[number]

export const vectorColumns = nonEmpty(
	Arr.filter(
		Rec.keys(Embedding.fields),
		(name) =>
			succeeded(describeField(Embedding.fields[name], SourceLoc(name, []))).scalar.carrier ===
			"vector"
	),
	"Embedding's vector columns"
)

export const storedGen: Gen<StoredSketch> = (source) => {
	const length = source.draw(oneOf([constant(4), int(3, 5)]))
	return {
		column: source.draw(element(vectorColumns)),
		components: source.draw(
			oneOf([
				array(componentGen, { min: length, max: length }),
				map(componentGen, (x) => Array.from({ length }, () => x)),
				map(element([lowest, highest, -lowest, -highest]), (bound) =>
					Array.from({ length }, (_, i) => (i === 0 ? bound : 0))
				)
			])
		)
	}
}

/** What a stored vector met: admitted, at a bound or inside, or refused, by the CHECK or by pgvector's input. */
export type StoredFeature =
	| "admitted at a bound"
	| "admitted inside"
	| "refused by the norm CHECK"
	| "refused as malformed"
	| "refused past binary32"
	| "the other column"

/**
 * A key's components: both zeros, so a vector meets its twin spelling, and a few values, never both zero, which the
 * cosine domain refuses.
 */
export const pointGen: Gen<readonly [number, number]> = (source) => {
	const x = source.draw(element([-0, 0, 1, -1, 0.5]))
	const y = source.draw(element(x === 0 ? [1, -1, 0.5] : [-0, 0, 1, -1]))
	return [x, y] as const
}

/** A vector's text with each component as drawn, -0 spelled with its sign. */
export const spelled = (xs: ReadonlyArray<number>): string =>
	`[${Arr.join(
		Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : String(x))),
		","
	)}]`

/** Whether two vectors are one value: equal components, -0 equal to 0, as binary32 compares them. */
export const sameVector = (a: readonly [number, number], b: readonly [number, number]): boolean =>
	a[0] === b[0] && a[1] === b[1]

/** What a key's insert met: a vector stored, or one refused as an exact repeat or as another spelling of a stored one. */
export type KeyFeature =
	| "a distinct vector stored"
	| "an exact repeat refused"
	| "a twin spelling refused"

export const world = fullWorld(Store, {})

export const codec = codecOf(embeddingType(), emptyCodebook)

/** A unit vector, admitted by every check: the other column's value. */
export const unit = "[1,0,0,0]"

/** Store installed once per member with its full world's login (install-migrate.ts installedTemplate). */
export const storeTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "vstore",
	schema: Store,
	options: { ambient: ordinarySession, label: "vstore", logins: [world.server], extensions: [] }
})

/** Points' full world, whose writer each key case takes on. */
export const pointsWorld = fullWorld(Points, {})

/** Points installed once per member with its full world's login (install-migrate.ts installedTemplate). */
export const pointsTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "vkeys",
	schema: Points,
	options: {
		ambient: ordinarySession,
		label: "vkeys",
		logins: [pointsWorld.server],
		extensions: []
	}
})
