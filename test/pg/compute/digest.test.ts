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
import { textCell } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Crypto.sha256 on PostgreSQL the host's digest of any bytes is PostgreSQL's sha256(v), its 32 bytes, as a check and a query lower it.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/digest.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/digest.test.ts` at its budget before,
 *   `{ runs: 24, steered: 24 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const computeSha256OnPostgreSQLTheHostsDigestOfAnyBytesIsPostgreSQLsSha256VAsACheckAndAQueryLowerIt =
	property.explore(batch, {
		needs: { tx: Substrate.rolledBack(baseSubstrate), checkNeed },
		situations: [
			"the empty value",
			"one byte",
			"every byte value",
			"a value that pads within its block",
			"a value that pads into a block more",
			"a long value"
		] satisfies ReadonlyArray<Reached<SqlFeature>>,
		check:
			({ tx, checkNeed }, c: Case<SqlFeature>) =>
			(values: ReadonlyArray<Value>) =>
				Effect.gen(function* () {
					const check = yield* checkNeed
					const { session: db } = yield* tx

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
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's sha256(v)"
		},
		budget: { runs: 1, steered: 24 },
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
