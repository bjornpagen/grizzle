import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, pipe, Result, String as Str } from "effect"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, refused, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"

const Embedding = relation("Embedding", { id: uuid, value: pg.vector(4), raw: pg.vector(4) }, [
	"id"
])
const Store = schema("VectorStore", { Embedding }, [])

const id = (n: number): string =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const embeddingType = (): ScalarType => scalarOf({ kind: "vector", dimensions: 4 }, {})

/**
 * The zero, a tiny and a huge norm: vectors outside the cosine domain, each with the row number it is tried at. The
 * database refuses each on the vector column, and the codec refuses each first, on the host.
 */
const outside: Arr.NonEmptyReadonlyArray<readonly [row: number, value: string]> = Arr.map(
	[
		"[0,0,0,0]",
		`[${2 ** -18},0,0,0]`,
		`[${Math.fround(2 ** -16 * (1 - 2 ** -24))},0,0,0]`,
		"[65537,0,0,0]",
		`[${2 ** 16 + 2 ** -7},0,0,0]`,
		"[1e30,1e30,0,0]"
	] as const,
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

/** How long one storage case may run. */
const caseHang = Duration.minutes(2)

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

					const codec = codecOf(embeddingType())
					yield* exhaust(
						{
							suite: "pg/vector/storage/norm",
							generator: element(outside),
							literal: ([, value]: readonly [number, string]) => value,
							limit: outside.length,
							features: features<RefusedFeature>(
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
					 * Both bounds are admitted, by the CHECK and by the codec; four components of 2^-17 have norm 2^-16.
					 */
					const admitted = [
						[2 ** -16, 0, 0, 0],
						[65536, 0, 0, 0],
						[0, -65536, 0, 0],
						[2 ** -17, 2 ** -17, 2 ** -17, 2 ** -17],
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
					assert.deepEqual(norms, [["1.52587890625e-05"], ["65536"], ["1.52587890625e-05"]])

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
							features: features<RefusedFeature>(
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
					 * The codec admits any vector of the column's dimensions, whatever model produced it, and refuses other
					 * dimensions before any SQL.
					 */
					const other = codec.encode(Vector.make(Float32Array.of(1, 0, 0, 0), 4))
					assert.equal(succeeded(other), "[1,0,0,0]")
					faulted(codec.encode(Vector.make(Float32Array.of(1, 0, 0), 3)), "vectorDimensions")
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
})
