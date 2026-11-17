import { btreeMaxItemSize } from "@bjornpagen/grizzle-engine/schema/representability"
/**
 * The key representability bound against PostgreSQL 19: every key the compiler accepts fits a B-tree index entry,
 * at the computed maximum, with the widest values its fields admit.
 *
 * A key is representable when its fields' worst-case B-tree entry stays within PostgreSQL's 2704-byte item limit
 * (schema/representability.ts keyLayout); a key the compiler accepts must never meet "index row size exceeds btree
 * maximum" (54000) on a lawful fact, or a valid write would fail at run time. The property draws composite keys of
 * bounded text (whose bound is four bytes per code point), numeric(p, s) up to the format's precision, uuid and the
 * fixed-width types, sizes the text to the largest length the compiler still accepts beside the other fields when the
 * case asks for the maximum, and inserts the widest fact: text of distinct 4-byte UTF-8 code points, which no
 * compression shortens, numerics of every digit their typmod admits at each base-10000 alignment, the largest uuid
 * and integers. PostgreSQL must accept every such fact into the key's unique index.
 *
 * Text is bounded in each spelling the compiler accepts: its pattern ^.{0,n}$, n within PostgreSQL's repetition limit
 * (regexMaxRepeat), a contract's charLength(value) <= n over the wildcard pattern, or a contract's
 * octetLength(value) <= n over it, which bounds the text's bytes exactly and reaches the item limit at the byte. A key's
 * entry is counted at exact offsets through its fixed-width prefix, so a key whose bounded text comes after fixed-width
 * fields alone is sized to the byte PostgreSQL lays out.
 *
 * Oracle: PostgreSQL itself, the B-tree item limit (54000) of the key's unique index.
 *
 * Features: a key the compiler accepts, and one sized within a word of the item limit.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { indices } from "#compiler/core/array.ts"
import {
	columnSql,
	filled,
	keyGen,
	layoutOf,
	names,
	type ReprFeature,
	widestValue
} from "#test/pg/oracle/representability.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The widest fact of every generated key the compiler accepts is one PostgreSQL's B-tree accepts. */
export const acceptsTheWidestFact = property.explore(keyGen, {
	needs: { substrate: Substrate.installing },
	/** Its pre-conversion budget: runs 150, coverage cases 150 (representability.test.ts:240,262-266 at 41df7b58^). */
	budget: { runs: 150, steered: 150 },
	situations: ["accepted key", "key at the computed maximum"] satisfies ReadonlyArray<
		Reached<ReprFeature>
	>,
	check:
		({ substrate }, k: Case<ReprFeature>) =>
		(sketch) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "repr" })
					const session = yield* s.admin.pin
					const fields = filled(sketch)
					const layout = layoutOf(fields)
					if (!layout.ok) {
						return
					}
					k.note("accepted key")
					if (
						sketch.fill &&
						Arr.some(fields, (f) => f.kind === "text") &&
						layout.value.btreeBytes > btreeMaxItemSize - 8
					) {
						k.note("key at the computed maximum")
					}
					const columns = names(fields)
					const table = `"${schema}"."t"`
					const ddl = `CREATE TABLE ${table} (${Arr.join(
						Arr.map(fields, (f, i) => `"${columns[i]}" ${columnSql(f)} NOT NULL`),
						", "
					)}, PRIMARY KEY (${Arr.join(
						Arr.map(columns, (c) => `"${c}"`),
						", "
					)}))`
					const insert = `INSERT INTO ${table} VALUES (${Arr.join(
						Arr.map(indices(fields.length), (i) => `$${i + 1}`),
						", "
					)})`
					const run = Effect.gen(function* () {
						yield* session.query("BEGIN", [])
						yield* session.query(`CREATE SCHEMA "${schema}"`, [])
						yield* session.query(ddl, [])
						yield* session.query(
							insert,
							Arr.map(fields, (f, i) => widestValue(f, sketch.salt + i))
						)
					}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
					const outcome = yield* Effect.result(run)
					succeeded(
						outcome,
						`the compiler accepts the key (${Arr.join(
							Arr.map(fields, (f) => columnSql(f)),
							", "
						)}) at ${layout.value.btreeBytes} bytes, but PostgreSQL refuses its widest fact\n${ddl}`
					)
				}).pipe(Effect.scoped),
				Substrate,
				substrate
			),
	oracle: { kind: "postgresql", name: "the B-tree item limit of the key's unique index, 54000" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/representability.ts",
			original: '\t\tMath.max(0, lengthBound("charLength", predicate)) * utf8EncodingMaxBytes,',
			replacement: '\t\tMath.max(0, lengthBound("charLength", predicate)) * 3,',
			why: "The byte bound counts three bytes a code point (schema/representability.ts), so a key of four-byte code points at its computed maximum overflows the B-tree item limit."
		}
	]
})
