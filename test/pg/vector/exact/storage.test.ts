/**
 * Vector storage on PostgreSQL 19 and the pinned pgvector.
 *
 * - Input: the column's norm CHECK, pgvector's input checks and the codec refuse the same vectors, components past
 *   binary32, non-finite, of a norm outside the cosine domain, and admit the domain's bounds.
 * - Key: a relation keyed by a vector holds one fact per value: two spellings of one vector collide on its key, and
 *   distinct vectors do not.
 *
 * Oracle: PostgreSQL itself, pgvector's input and the column's CHECK against a model of both; and a vector's value is
 * its binary32 components, -0 equal to 0.
 *
 * Features: each refusal and each admitted bound, a collision and distinct vectors.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { Vector } from "#compiler/public/fields.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import {
	codec,
	Embedding,
	embeddingType,
	highest,
	id,
	type KeyFeature,
	lowest,
	Point,
	pointGen,
	pointsTemplate,
	pointsWorld,
	sameVector,
	spelled,
	type StoredFeature,
	storedGen,
	storeTemplate,
	unit,
	vectorColumns,
	world
} from "#test/pg/vector/exact/storage.fixtures.ts"
import { exactVectorText, normOf, normTolerance, vectorInVerdict } from "#test/pg/vector/support.ts"
import { assert, defined, faulted, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/**
 * Vector storage the norm CHECK, pgvector's input checks and the codec refuse the same vectors, and admit the bounds.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/vector/exact/storage.test.ts at d8eed1786).
 */
export const vectorStorageTheNormCHECKPgvectorsInputChecksAndTheCodecRefuseTheSameVectorsAndAdmitTheBounds =
	property.explore(storedGen, {
		needs: { store: Substrate.seat(storeTemplate) },
		situations: [
			"admitted at a bound",
			"admitted inside",
			"refused by the norm CHECK",
			"refused as malformed",
			"refused past binary32",
			"the other column"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		check:
			({ store: seated }, k: Case<StoredFeature>) =>
			({ column, components }) =>
				Effect.gen(function* () {
					const { substrate: s, value: store } = yield* seated
					const names = namesOf(store)
					const table = names.table(Embedding)
					const writer = yield* s.session({
						...worldSession(store.world(world.app)),
						label: "writer"
					})

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
						[id(1), ...values]
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
						const e = yield* expectConstraint(insert, names.normCheck(Embedding, column), "23514")
						assert.equal(e.code, "23514")
						faulted(encoded, "vectorNorm", "the codec refuses what the CHECK refuses")
						return
					}
					k.note(norm === lowest || norm === highest ? "admitted at a bound" : "admitted inside")
					yield* insert
					const text = succeeded(encoded)
					const [first] = yield* s.admin.queryValues(
						`SELECT "vector_ext"."vector_norm"(${names.column(Embedding, column)})::text, ${names.column(Embedding, column)}::text FROM ${table} WHERE "id" = $1::text::uuid`,
						[id(1)]
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
				}),
		oracle: {
			kind: "postgresql",
			name: "pgvector's input and the column's norm CHECK, against a model of pgvector's checks and the norm"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * Vector storage a vector key holds one fact per value: two spellings of one vector collide on it, and distinct vectors do not.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/vector/exact/storage.test.ts at d8eed1786).
 */
export const vectorStorageAVectorKeyHoldsOneFactPerValueTwoSpellingsOfOneVectorCollideOnItAndDistinctVectorsDoNot =
	property.explore(array(pointGen, { min: 1, max: 6 }), {
		needs: { points: Substrate.seat(pointsTemplate) },
		situations: [
			"a distinct vector stored",
			"an exact repeat refused",
			"a twin spelling refused"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check:
			({ points: seated }, k: Case<KeyFeature>) =>
			(points) =>
				Effect.gen(function* () {
					const { substrate: s, value: store } = yield* seated
					const names = namesOf(store)
					const table = names.table(Point)
					const key = names.fieldConstraint(Point, "pk", ["at"])
					const writer = yield* s.session({
						...worldSession(store.world(pointsWorld.app)),
						label: "writer"
					})
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
				}),
		oracle: {
			kind: "second-implementation",
			name: "a vector's value is its binary32 components, -0 equal to 0"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})
