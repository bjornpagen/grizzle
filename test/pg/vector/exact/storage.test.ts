import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, Result, String as Str } from "effect"
import { cosineNormMax, cosineNormMin } from "#compiler/ir/carriers.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, faulted, refused, succeeded } from "#test/support/assert.ts"
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

/**
 * The zero, a tiny and a huge norm, and the binary32 neighbours just past each bound: vectors outside the cosine
 * domain, each with the row number it is tried at. The database refuses each on the vector column, and the codec
 * refuses each first, on the host.
 */
const outside: Arr.NonEmptyReadonlyArray<readonly [row: number, value: string]> = Arr.map(
	Arr.make(
		"[0,0,0,0]",
		`[${lowest / 4},0,0,0]`,
		`[${Math.fround(lowest * (1 - 2 ** -24))},0,0,0]`,
		`[${highest * 2},0,0,0]`,
		`[${highest * (1 + 2 ** -23)},0,0,0]`,
		"[1e30,1e30,0,0]"
	),
	(value, i) => [10 + i, value] as const
)

/** Input pgvector itself refuses, with the SQLSTATE it refuses it with. */
const malformed: Arr.NonEmptyReadonlyArray<readonly [input: string, sqlstate: "22000" | "22003"]> =
	[
		["[1,0,0]", "22000"],
		["[1,0,0,0,0]", "22000"],
		["[NaN,1,0,0]", "22000"],
		["[Infinity,1,0,0]", "22000"],
		["[1,1e39,0,0]", "22003"]
	]

/** A vector refused, by its text. */
type RefusedFeature = `refused ${string}`

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
					/** A unit vector, admitted by every check: the raw column's value where the test is about `value`. */
					const unit = "[1,0,0,0]"
					/** A row whose `value` is the vector under test, beside a raw column holding `raw`. */
					const insert = (n: number, value: string, raw: string) =>
						writer.values(
							`INSERT INTO ${table} ("id", "value", "raw") VALUES ($1::text::uuid, $2::text::"vector_ext"."vector"(4), $3::text::"vector_ext"."vector"(4))`,
							[id(n), value, raw]
						)

					const codec = codecOf(embeddingType(), emptyCodebook)
					yield* exhaust(
						{
							suite: "pg/vector/storage/norm",
							generator: element(outside),
							literal: ([, value]: readonly [number, string]) => value,
							limit: outside.length,
							coverage: requiredInSpace<RefusedFeature>(
								Arr.map(outside, ([, value]): RefusedFeature => `refused ${value}`)
							),
							caseHang
						},
						([row, value], k) =>
							Effect.gen(function* () {
								const e = yield* expectConstraint(
									insert(row, value, unit),
									names.normCheck(Embedding, "value"),
									"23514"
								)
								assert.equal(e.code, "23514")
								const read = strictRead(embeddingType(), value)
								if (Result.isFailure(read)) {
									return assert.fail(`the strict reader refused ${value}: ${read.failure}`)
								}
								const host = read.success
								if (!isVector(host)) {
									return assert.fail(`the strict reader read ${value} as no vector`)
								}
								faulted(codec.encode(host), "vectorNorm", value)
								k.note(`refused ${value}`)
							})
					)

					/**
					 * Both bounds are admitted, by the CHECK and by the codec; four components of half the least norm have
					 * the least norm.
					 */
					const admitted = [
						[lowest, 0, 0, 0],
						[highest, 0, 0, 0],
						[0, -highest, 0, 0],
						[lowest / 2, lowest / 2, lowest / 2, lowest / 2],
						[0.6, 0.8, 0, 0]
					]
					for (const [i, xs] of admitted.entries()) {
						const text = codec.encode(Vector.make(Float32Array.from(xs), 4))
						if (!text.ok) {
							throw new Error(
								`codec refused ${Arr.join(
									Arr.map(xs, (x) => String(x)),
									","
								)}`
							)
						}
						yield* insert(100 + i, text.value, unit)
					}
					const norms = yield* s.admin.queryValues(
						`SELECT "vector_ext"."vector_norm"("value")::text FROM ${table} WHERE "id" IN ('${id(100)}', '${id(101)}', '${id(103)}') ORDER BY "id"`,
						[]
					)
					assert.deepEqual(
						Arr.map(norms, (row) => Arr.map(row, Number)),
						[[lowest], [highest], [lowest]]
					)

					/** Every vector column has the cosine domain: the zero vector is refused on the other column too. */
					const raw = yield* expectConstraint(
						insert(200, "[1,0,0,0]", "[0,0,0,0]"),
						names.normCheck(Embedding, "raw"),
						"23514"
					)
					assert.equal(raw.code, "23514")

					const inputs = yield* exhaust(
						{
							suite: "pg/vector/storage/input",
							generator: element(malformed),
							literal: ([bad]: readonly [string, string]) => bad,
							limit: malformed.length,
							coverage: requiredInSpace<RefusedFeature>(
								Arr.map(malformed, ([bad]): RefusedFeature => `refused ${bad}`)
							),
							caseHang
						},
						([bad, sqlstate], k) =>
							Effect.gen(function* () {
								yield* expectSqlstate(insert(300, bad, unit), sqlstate)
								k.note(`refused ${bad}`)
							})
					)
					/**
					 * Vector.from is the explicit boundary: a vector of the field's dimensions passes when its norm is in the
					 * domain, and is refused otherwise.
					 */
					const refinedFrom = Vector.from(Vector.make(Float32Array.of(3, 4, 0, 0), 4), 4)
					assert.equal(Vector.norm(succeeded(refinedFrom)), 5)
					refused(Vector.from(Vector.make(Float32Array.of(0, 0, 0, 0), 4), 4), "vectorNorm")
					return inputs
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
