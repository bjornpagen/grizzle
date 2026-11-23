/**
 * Crypto.sha256 on PostgreSQL 19, against the host.
 *
 * The digest over drawn bytes, the empty value, one byte, every byte value, values about a SHA-256 block's 64 bytes,
 * where its padding takes one block or two, short values and a long one of a few MiB, each as a check and a query lower
 * it: PostgreSQL's value of the SQL each lowering renders, PostgreSQL's own `sha256(v)`, the oracle, and the host
 * evaluator's value over the value as a write admits it (scalar/values/bytes.ts AdmittedBytes) are one digest, its 32
 * bytes, as many as PostgreSQL's own.
 *
 * Features: each class of drawn bytes and each lowering the digest is checked through.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	batch,
	bodyOf,
	checkNeed,
	digestsSql,
	hexOf,
	hostDigest,
	read,
	type SqlFeature,
	sqlNotes,
	type Value
} from "#test/pg/compute/digest.fixtures.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Crypto.sha256 on PostgreSQL the host's digest of any bytes is PostgreSQL's sha256(v), its 32 bytes, as a check and a query lower it.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/compute/digest.test.ts at 22a8e17e9).
 */
export const computeSha256OnPostgreSQLTheHostsDigestOfAnyBytesIsPostgreSQLsSha256VAsACheckAndAQueryLowerIt =
	property.explore(batch, {
		needs: { substrate: Substrate.installing, checkNeed },
		situations: [
			"the empty value",
			"one byte",
			"every byte value",
			"a value that pads within its block",
			"a value that pads into a block more",
			"a long value"
		] satisfies ReadonlyArray<Reached<SqlFeature>>,
		check:
			({ substrate, checkNeed }, c: Case<SqlFeature>) =>
			(values: ReadonlyArray<Value>) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const check = yield* checkNeed
						const s = yield* Substrate
						const db = yield* s.session(ownerSession())

						for (const feature of sqlNotes(values)) {
							c.note(feature)
						}
						const bodies = Arr.map(values, bodyOf)
						const rows = yield* db.values(digestsSql(check, read), [Arr.map(bodies, hexOf)])
						assert.equal(rows.length, bodies.length, "a row per value")
						for (const [row, body] of Arr.zip(rows, bodies)) {
							const oracle = textCell(row, 2)
							assert.equal(textCell(row, 0), oracle, "a check's digest is PostgreSQL's")
							assert.equal(textCell(row, 1), oracle, "a query's digest is PostgreSQL's")
							assert.equal(
								textCell(row, 3),
								"true",
								"a check's digest is as many bytes as PostgreSQL's own"
							)
							for (const term of [check, read]) {
								assert.equal(hostDigest(term, body), oracle, "the host's digest is PostgreSQL's")
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's sha256(v)"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original: '\tsql: { kind: "function", name: "sha256", owner: "catalog" },',
				replacement: '\tsql: { kind: "function", name: "sha224", owner: "catalog" },',
				why: "Crypto.sha256 of bytes lowers to SHA-224, so neither lowering's digest is PostgreSQL's sha256 nor 32 bytes long."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\t? (args) => Result.ok(Uint8Array.fromHex(hostOf("bytes", a(args)).digest))',
				replacement:
					'\t\t\t\t? (args) => Result.ok(new TextEncoder().encode(hostOf("bytes", a(args)).digest))',
				why: "The host's digest of bytes is its hex spelling's 64 bytes, the old hex rendering, not PostgreSQL's 32."
			}
		]
	})
