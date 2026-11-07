import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/ir/carriers.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { exactVectorText, normOf, normTolerance, vectorInVerdict } from "#test/pg/vector/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, faulted, nonEmpty, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"

const Embedding = relation("Embedding", { id: uuid, value: pg.vector(4), raw: pg.vector(4) }, [
	"id"
])
const Store = schema("VectorStore", { Embedding }, [])

/** A relation keyed by a vector: its key's B-tree index compares by pgvector's equality. */
const Point = relation("Point", { at: pg.vector(2), label: pg.integer }, ["at"])
const Points = schema("VectorPoints", { Point }, [])

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const embeddingType = (): ScalarType => scalarOf({ kind: "vector", dimensions: 4 }, {})

const lowest = cosineNormMin.value
const highest = cosineNormMax.value

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

const vectorColumns = nonEmpty(
	Arr.filter(
		Rec.keys(Embedding.fields),
		(name) =>
			succeeded(describeField(Embedding.fields[name], SourceLoc(name, []))).scalar.carrier ===
			"vector"
	),
	"Embedding's vector columns"
)

const storedGen: Gen<StoredSketch> = (source) => {
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
type StoredFeature =
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
const pointGen: Gen<readonly [number, number]> = (source) => {
	const x = source.draw(element([-0, 0, 1, -1, 0.5]))
	const y = source.draw(element(x === 0 ? [1, -1, 0.5] : [-0, 0, 1, -1]))
	return [x, y] as const
}

/** A vector's text with each component as drawn, -0 spelled with its sign. */
const spelled = (xs: ReadonlyArray<number>): string =>
	`[${Arr.join(
		Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : String(x))),
		","
	)}]`

/** Whether two vectors are one value: equal components, -0 equal to 0, as binary32 compares them. */
const sameVector = (a: readonly [number, number], b: readonly [number, number]): boolean =>
	a[0] === b[0] && a[1] === b[1]

/** What a key's insert met: a vector stored, or one refused as an exact repeat or as another spelling of a stored one. */
type KeyFeature = "a distinct vector stored" | "an exact repeat refused" | "a twin spelling refused"

layer(Substrate.layer)("vector storage", (it) => {
	it.effect(
		"the norm CHECK, pgvector's input checks and the codec refuse the same vectors, and admit the bounds",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const world = fullWorld(Store)
					const store = yield* install(Store, {
						ambient: ordinarySession,
						label: "vstore",
						logins: [world.server],
						extensions: []
					})
					const names = namesOf(store)
					const table = names.table(Embedding)
					const writer = yield* s.session({
						...worldSession(store.world(world.app)),
						label: "writer"
					})
					const codec = codecOf(embeddingType(), emptyCodebook)
					/** A unit vector, admitted by every check: the other column's value. */
					const unit = "[1,0,0,0]"
					let row = 0
					return yield* explore(
						{
							suite: "pg/vector/storage/input",
							draw: drawn(storedGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "pgvector's input and the column's norm CHECK, against a model of pgvector's checks and the norm"
							},
							coverage: required<StoredFeature>(
								[
									"admitted at a bound",
									"admitted inside",
									"refused by the norm CHECK",
									"refused as malformed",
									"refused past binary32",
									"the other column"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						({ column, components }, k) =>
							Effect.gen(function* () {
								row++
								const values = Arr.map(vectorColumns, (name) =>
									name === column ? exactVectorText(components) : unit
								)
								const insert = writer.values(
									`INSERT INTO ${table} ("id", ${Arr.join(
										Arr.map(vectorColumns, (name) => names.column(Embedding, name)),
										", "
									)}) VALUES ($1::text::uuid, ${Arr.join(
										Arr.map(vectorColumns, (_, i) => `$${i + 2}::text::"vector_ext"."vector"(4)`),
										", "
									)})`,
									[id(row), ...values]
								)
								if (column !== Arr.headNonEmpty(vectorColumns)) {
									k.note("the other column")
								}
								const input = vectorInVerdict(components, Option.some(4))
								if (input !== "admitted") {
									k.note(input === "22003" ? "refused past binary32" : "refused as malformed")
									yield* expectSqlstate(insert, input)
									return
								}
								const host = Vector.make(Float32Array.from(components), 4)
								const norm = normOf(components)
								const inside = norm >= lowest && norm <= highest
								const encoded = codec.encode(host)
								if (!inside) {
									k.note("refused by the norm CHECK")
									const e = yield* expectConstraint(
										insert,
										names.normCheck(Embedding, column),
										"23514"
									)
									assert.equal(e.code, "23514")
									faulted(encoded, "vectorNorm", "the codec refuses what the CHECK refuses")
									return
								}
								k.note(
									norm === lowest || norm === highest ? "admitted at a bound" : "admitted inside"
								)
								yield* insert
								const text = succeeded(encoded)
								const [first] = yield* s.admin.queryValues(
									`SELECT "vector_ext"."vector_norm"(${names.column(Embedding, column)})::text, ${names.column(Embedding, column)}::text FROM ${table} WHERE "id" = $1::text::uuid`,
									[id(row)]
								)
								const [native, stored] = defined(first, "the stored row")
								assert.ok(
									Math.abs(Number(native) - norm) <= normTolerance(4, norm),
									`vector_norm ${String(native)}, the host's ${norm}`
								)
								const read = strictRead(embeddingType(), String(stored))
								if (Result.isFailure(read) || !isVector(read.success)) {
									return assert.fail(`the strict reader refused ${String(stored)}`)
								}
								assert.equal(
									succeeded(codec.encode(read.success)),
									text,
									"what pgvector stores reads back as the codec's text of the host vector"
								)
							})
					)
				})
			)
	)

	it.effect(
		"a vector key holds one fact per value: two spellings of one vector collide on it, and distinct vectors do not",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const world = fullWorld(Points)
					const store = yield* install(Points, {
						ambient: ordinarySession,
						label: "vkeys",
						logins: [world.server],
						extensions: []
					})
					const names = namesOf(store)
					const table = names.table(Point)
					const key = names.fieldConstraint(Point, "pk", ["at"])
					const writer = yield* s.session({
						...worldSession(store.world(world.app)),
						label: "writer"
					})
					return yield* explore(
						{
							suite: "pg/vector/storage/key",
							draw: drawn(array(pointGen, { min: 1, max: 6 })),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "a vector's value is its binary32 components, -0 equal to 0"
							},
							coverage: required<KeyFeature>(
								["a distinct vector stored", "an exact repeat refused", "a twin spelling refused"],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(points, k) =>
							Effect.gen(function* () {
								yield* s.admin.query(`DELETE FROM ${table}`, [])
								const stored: Array<readonly [number, number]> = []
								for (const [label, at] of points.entries()) {
									const insert = writer.values(
										`INSERT INTO ${table} ("at", "label") VALUES ($1::text::"vector_ext"."vector"(2), $2::text::int4)`,
										[spelled(at), String(label)]
									)
									const earlier = Arr.findFirst(stored, (other) => sameVector(other, at))
									if (Option.isNone(earlier)) {
										yield* insert
										stored.push(at)
										k.note("a distinct vector stored")
										continue
									}
									yield* expectConstraint(insert, key, "23505")
									k.note(
										spelled(earlier.value) === spelled(at)
											? "an exact repeat refused"
											: "a twin spelling refused"
									)
								}
							})
					)
				})
			)
	)
})
