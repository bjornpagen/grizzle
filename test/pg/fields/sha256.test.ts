/**
 * A SHA-256 digest field, the sha256 carrier, on PostgreSQL 19: 32 bytes under the installation's digest domain, a key
 * over it admitted, written and read back through a served Db.
 *
 * 1. A case draws distinct paths, the empty path, short paths and paths past a B-tree entry (btreeMaxItemSize), and
 *    writes each as a medium keyed by its digest, Sha256.ofText of the path, one fact per apply or all in one batched
 *    insert, whose member array carries each digest as its one text, `\x` and its hex. Every write is accepted, the
 *    key's index holding each digest, a path no index entry could hold among them; every medium reads back at its
 *    digest, each digest a fresh array of the bytes written; a query whose parameter is a digest finds each medium's
 *    path; a medium written again at a stored digest is refused on the key, witnessed by the digest's bytes; and
 *    PostgreSQL stores each digest as SHA-256 of its path's UTF-8, `sha256(convert_to(path, 'UTF8'))`, of its length.
 * 2. A value of any other length is no digest: a direct writer's insert of one into a digest column is refused by the
 *    digest domain's CHECK (23514). grizzle's own door refuses one before any statement, sha256Value, which no typed
 *    call can state (test/unit/values/identity.test.ts admits a digest of its length alone).
 *
 * Oracle: the drawn paths and the digests written; PostgreSQL's own sha256 over the path's UTF-8, and its octet_length.
 *
 * Features: the vocabulary Feature (sha256.fixtures.ts), each path's class and each path a digest is written by.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	Digests,
	type Drawn,
	digestLength,
	digestsInstall,
	digestsTemplate,
	type Feature,
	type LengthFeature,
	Media,
	mediumOf,
	notes,
	space,
	wrongLength
} from "#test/pg/fields/sha256.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { probe } from "#test/support/pg/physical/checks.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A digest's bytes as hex, a failure where a value read back is no array of bytes. */
const hexOf = (value: unknown): string => {
	if (!(value instanceof Uint8Array)) {
		return assert.fail(`a digest reads back as its bytes, not ${Formatter.format(value)}`)
	}
	return value.toHex()
}

/**
 * A digest written through a served Db reads back as its bytes, a key over it holds paths past any index entry, a
 * parameter of it finds its row, and PostgreSQL stores SHA-256 of the path's UTF-8.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDigestRoundTripsAKeyOverItHoldsAnyPathAndAParameterOfItFindsItsRow = property.explore(
	space,
	{
		needs: { fixture: Substrate.fresh(digestsTemplate) },
		situations: [
			"the empty path",
			"a path past a B-tree entry",
			"many media in one batched insert",
			"one medium per apply"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(d: Drawn) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* openedIn(Digests, {}, digestsInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
								const media = Arr.map(d.paths, mediumOf)
								const byDigest = Order.mapInput(Order.String, (m: { readonly digest: unknown }) =>
									hexOf(m.digest)
								)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const batches = d.batched ? [media] : Arr.map(media, (m) => [m])
									for (const batch of batches) {
										const outcome = yield* writeAnswerOf(
											db.workload.store.once({ params: {}, facts: { insert: { Media: batch } } })
										)
										assert.equal(outcome.kind, "accepted", "every medium is written at its digest")
									}
									const stored = yield* rowsOf(db.workload.media.once({ params: {}, facts: {} }))
									const read = Arr.sort(stored, byDigest)
									assert.deepEqual(
										Arr.map(read, (row) => [hexOf(row.digest), row.path, row.size]),
										Arr.map(Arr.sort(media, byDigest), (m) => [m.digest.toHex(), m.path, m.size]),
										"every medium reads back at the digest written"
									)
									assert.ok(
										Arr.every(
											read,
											(row) =>
												row.digest instanceof Uint8Array &&
												row.digest.byteOffset === 0 &&
												row.digest.byteLength === row.digest.buffer.byteLength
										),
										"every digest read back is an array over a buffer of its own"
									)
									for (const m of media) {
										const found = yield* rowsOf(
											db.workload.byDigest.once({ params: { digest: m.digest }, facts: {} })
										)
										assert.deepEqual(
											Arr.map(found, (row) => row.path),
											[m.path],
											"a digest parameter finds its medium's path"
										)
									}
									const first = defined(media[0], "a stored medium")
									const again = yield* writeAnswerOf(
										db.workload.store.once({
											params: {},
											facts: {
												insert: { Media: [{ ...first, size: first.size + media.length }] }
											}
										})
									)
									if (again.kind !== "refused") {
										return assert.fail(`a medium at a stored digest is refused, not ${again.kind}`)
									}
									if (again.witness.kind === "key") {
										assert.equal(
											hexOf(again.witness.values["digest"]),
											first.digest.toHex(),
											"the refusal is witnessed by the stored digest's bytes"
										)
									}
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
								const owner = yield* s.session(ownerSession())
								const digest = names.column(Media, "digest")
								const path = names.column(Media, "path")
								const rows = yield* owner.values(
									`SELECT pg_catalog.encode(${digest}, 'hex'), ${digest} = pg_catalog.sha256(pg_catalog.convert_to(${path}, 'UTF8')), pg_catalog.octet_length(${digest}) = pg_catalog.octet_length(pg_catalog.sha256(''::bytea)) FROM ${names.table(Media)} ORDER BY 1`,
									[]
								)
								assert.deepEqual(
									Arr.map(rows, (row) => Arr.map(row, (cell) => String(cell))),
									Arr.map(
										Arr.sort(
											Arr.map(media, (m) => m.digest.toHex()),
											Order.String
										),
										(hex) => [hex, "true", "true"]
									),
									"PostgreSQL stores each digest as SHA-256 of its path's UTF-8, of its length"
								)
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the digests written, and PostgreSQL's sha256 over each path's UTF-8 and its octet_length"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: '\t\tcase "sha256":\n\t\t\treturn ["wire"]',
				replacement: '\t\tcase "sha256":\n\t\t\treturn ["text"]',
				why: "The hex rendering restored on the delivery: a digest's result text is byteaout's `\\x` and hex, which the bytes' wire decoder reads as other bytes, so no medium reads back at its digest."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tsha256: (v) => sha256Text(v),",
				replacement: "\tsha256: (v) => sha256Text(v.subarray(1)),",
				why: "A digest's parameter text drops its first byte, so PostgreSQL is sent 31 bytes, which the digest domain refuses: no medium is written."
			}
		]
	}
)

/**
 * A value of any length but SHA-256's is refused by the digest domain from a direct writer.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aValueOfAnotherLengthIsRefusedByTheDigestDomain = property.explore(wrongLength, {
	needs: { fixture: Substrate.rolledBack(digestsTemplate) },
	situations: ["a shorter value", "a longer value"] satisfies ReadonlyArray<Reached<LengthFeature>>,
	check:
		({ fixture }, c: Case<LengthFeature>) =>
		(length: number) =>
			Effect.gen(function* () {
				c.note(length < digestLength ? "a shorter value" : "a longer value")
				const held = yield* fixture
				const names = namesOf(held.value.installed)
				const direct = yield* probe(
					held.bare,
					`INSERT INTO ${names.table(Media)} (${names.column(Media, "digest")}, ${names.column(Media, "path")}, ${names.column(Media, "size")}) VALUES (pg_catalog.decode($1::text, 'hex'), 'x', 0)`,
					[new Uint8Array(length).toHex()]
				)
				assert.equal(
					direct.kind === "refused" ? direct.code : direct.kind,
					"23514",
					`a direct writer's value of ${length} bytes is refused by the digest domain's CHECK`
				)
			}),
	oracle: {
		kind: "specification",
		name: "SHA-256's digest length: a value of any other is no digest"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/ledger.ts",
			original: "lit.int(sha256Octets, types.integer)",
			replacement: 'call("octet_length", [{ kind: "domainValue" }])',
			why: "The digest domain's CHECK dropped, `octet_length(VALUE) = octet_length(VALUE)`, which holds of every bytea: a direct writer's value of another length is stored."
		}
	]
})
