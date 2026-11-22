/**
 * Crypto.sha256 on PostgreSQL 19, against the host.
 *
 * 1. The digest over drawn bytes, the empty value, one byte, every byte value, values about a SHA-256 block's 64 bytes,
 *    where its padding takes one block or two, short values and a long one of a few MiB, each as a check and a query
 *    lower it: PostgreSQL's value of the SQL each lowering renders, PostgreSQL's own `sha256(v)`, the oracle, and the
 *    host evaluator's value over the value as a write admits it (scalar/values/bytes.ts AdmittedBytes) are one digest,
 *    its 32 bytes, as many as PostgreSQL's own.
 * 2. An installed Media schema whose Entry stores its bytes `content` and generates `digest`, the pantry's declaration
 *    `generated(sha256, Crypto.sha256(row.content))`; a row check holds `digest` to the digest of `content`; and Page,
 *    an ordered family of an Entry's pages, copies its entry's generated digest along the owner axis, so each nested
 *    insert fills each page's copy on the host from the owner's bytes and PostgreSQL's foreign key, a reference whose
 *    target holds the digest, proves it. Each case inserts entries with their pages nested; every write is accepted;
 *    the digest is a STORED generated column holding PostgreSQL's own `sha256(content)` of each stored value, read back
 *    as the host's digest of the bytes written; a query's head computes the same digest from a read of the bytes;
 *    every page's copy is its entry's digest; and a direct writer's insert that states a digest, even the right one,
 *    is refused by PostgreSQL (428C9), which alone writes a generated column. A ChangeSet's fact that states one is a type error, "a member fact
 *    is not a fact of the relation", and a JavaScript caller's an EncodingFailure (factShape), since an insert holds
 *    only the fields its caller writes: the ChangeSet type/engine agreement's "a generated field supplied" holds both.
 *
 * Features: each class of drawn bytes and each lowering the digest is checked through.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	batch,
	bodyOf,
	byId,
	checkNeed,
	digestsSql,
	Entry,
	hexOf,
	hostDigest,
	Media,
	programs,
	read,
	type SqlFeature,
	sqlNotes,
	type Stored,
	stored,
	type StoredFeature,
	storedNotes,
	type Value
} from "#test/pg/compute/digest.fixtures.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { installed } from "#test/pg/reads/support.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

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

/**
 * Crypto.sha256 on PostgreSQL a generated digest is PostgreSQL's own, read back as the host's, copied into a family by the host through a reference over it, and never written.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/compute/digest.test.ts at 22a8e17e9).
 */
export const computeSha256OnPostgreSQLAGeneratedDigestIsPostgreSQLsOwnReadBackAsTheHostsCopiedIntoAFamilyByTheHostAndNeverWritten =
	property.explore(stored, {
		needs: { substrate: Substrate.installing },
		situations: [
			"an entry of the empty value",
			"an entry with no page",
			"an entry of pages",
			"entries of two values"
		] satisfies ReadonlyArray<Reached<StoredFeature>>,
		check:
			({ substrate }, c: Case<StoredFeature>) =>
			(d: Stored) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							for (const feature of storedNotes(d)) {
								c.note(feature)
							}
							const o = yield* installed(Media, {}, { label: "digest", programs })
							const facts = Arr.map(d.entries, (e, i) => ({
								id: uuidOf(i + 1),
								content: bodyOf(e.value),
								pages: upTo(e.pages, (k) => ({ id: uuidOf(1000 * (i + 1) + k) }))
							}))
							const expected = new Map(
								Arr.map(facts, (f) => [f.id, new AdmittedBytes(f.content).digest] as const)
							)
							const hex = (value: unknown): string => {
								if (!(value instanceof Uint8Array)) {
									return assert.fail(
										`a digest reads back as its bytes, not ${Formatter.format(value)}`
									)
								}
								return value.toHex()
							}
							const stating = defined(facts[0], "an entry whose digest a direct writer states")
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const inserted = yield* writeAnswerOf(
									db.workload.insertEntries.once({
										params: {},
										facts: { insert: { Entry: facts } }
									})
								)
								assert.equal(inserted.kind, "accepted", "every entry and its pages are written")
								const entryRows = yield* rowsOf(db.workload.entries.once({ params: {}, facts: {} }))
								const entries = Arr.sort(entryRows, byId)
								assert.deepEqual(
									Arr.map(entries, (e) => [e.id, hex(e.digest)]),
									Arr.map(Arr.sort(facts, byId), (f) => [
										f.id,
										defined(expected.get(f.id), "an entry's digest")
									]),
									"each entry reads back the host's digest of its bytes"
								)
								const computedRows = yield* rowsOf(
									db.workload.computed.once({ params: {}, facts: {} })
								)
								const computed = Arr.sort(computedRows, byId)
								assert.deepEqual(
									Arr.map(computed, (e) => [e.id, hex(e.computed)]),
									Arr.map(entries, (e) => [e.id, hex(e.digest)]),
									"a query's head computes each entry's digest from a read of its bytes"
								)
								const pages = yield* rowsOf(db.workload.pages.once({ params: {}, facts: {} }))
								assert.equal(
									pages.length,
									Arr.reduce(d.entries, 0, (n, e) => n + e.pages),
									"every page is written"
								)
								for (const page of pages) {
									assert.equal(
										hex(page.entryDigest),
										defined(expected.get(page.entry), "its entry's digest"),
										"a page's copy is its entry's digest, filled on the host from the owner's bytes"
									)
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
							const s = yield* Substrate
							const owner = yield* s.session(ownerSession())
							const names = namesOf(o.installed)
							const content = names.column(Entry, "content")
							const columns = yield* owner.values(
								`SELECT '"' || replace(attname, '"', '""') || '"', attgenerated::text FROM pg_catalog.pg_attribute WHERE attrelid = $1::text::regclass AND attnum > 0 AND NOT attisdropped`,
								[names.table(Entry)]
							)
							for (const name of [names.column(Entry, "digest")]) {
								const generatedAs = Option.getOrUndefined(
									Arr.findFirst(columns, (row) => textCell(row, 0) === name)
								)
								assert.equal(
									textCell(defined(generatedAs, `the column ${name}`), 1),
									"s",
									`${name} is a STORED generated column`
								)
							}
							const rows = yield* owner.values(
								`SELECT ${names.column(Entry, "id")}::text, (${names.column(Entry, "digest")} = pg_catalog.sha256(${content}))::text, (pg_catalog.octet_length(${names.column(Entry, "digest")}) = pg_catalog.octet_length(pg_catalog.sha256(${content})))::text FROM ${names.table(Entry)} ORDER BY ${names.column(Entry, "id")}`,
								[]
							)
							assert.deepEqual(
								Arr.map(rows, (row) => [textCell(row, 0), textCell(row, 1), textCell(row, 2)]),
								Arr.map(rows, (row) => [textCell(row, 0), "true", "true"]),
								"each stored digest is PostgreSQL's own sha256(content), of its length"
							)
							assert.deepEqual(
								Arr.map(rows, (row) => textCell(row, 0)),
								Arr.map(Arr.sort(facts, byId), (f) => f.id),
								"the entries written are stored"
							)
							const pinned = yield* s.admin.pin
							yield* pinned.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
							const stated = yield* probe(
								pinned,
								`INSERT INTO ${names.table(Entry)} (${names.column(Entry, "id")}, ${content}, ${names.column(Entry, "pages")}, ${names.column(Entry, "digest")}) VALUES ($1::uuid, pg_catalog.decode($2::text, 'hex'), 0, pg_catalog.decode($3::text, 'hex'))`,
								[
									uuidOf(999_999),
									hexOf(stating.content),
									defined(expected.get(stating.id), "its digest")
								]
							)
							yield* pinned.query("ROLLBACK", [])
							assert.deepEqual(
								stated.kind === "refused" ? stated.code : stated.kind,
								"428C9",
								"a direct writer that states a digest, even the right one, is refused: PostgreSQL alone writes a generated column"
							)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's sha256(content) of each stored value"
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})
