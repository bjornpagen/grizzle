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
import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
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
	needs: { tx: Substrate.transaction },
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/representability.test.ts acceptsTheWidestFact
	 * @unit cases
	 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
	 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
	 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524 (a
	 *   property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
	 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
	 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log, kills4.log,
	 *   v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on cassowary, uncommitted
	 * @observed 2026-11-23 03:12 to 04:36 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
	 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and verified
	 *   on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory family of two
	 *   PostgreSQL 19 members
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 150, 29 and 25,
	 *   steered 150
	 * @result runs 150 (pre-conversion): the schema/representability.ts kill fails floor case 7; runs 29 (a floor of
	 *   eight): killed, its situations reached on the floor, 37 cases in all where f1bf91a2f's gate ran 188; runs 25 (a
	 *   floor of seven): it survives
	 * @decision runs 29, the fewest whose floor holds case 7. steered stays its pre-conversion 150: the phase stops once
	 *   every required situation is reached, so a green run spends only its need, none here, and the cap only bounds a
	 *   run whose situation went unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 29, steered: 150 },
	situations: ["accepted key", "key at the computed maximum"] satisfies ReadonlyArray<
		Reached<ReprFeature>
	>,
	check:
		({ tx }, k: Case<ReprFeature>) =>
		(sketch) =>
			Effect.gen(function* () {
				const held = yield* tx
				const schema = yield* held.schema("repr")
				const session = held.connection
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
					yield* session.query(`CREATE SCHEMA "${schema}"`, [])
					yield* session.query(ddl, [])
					yield* session.query(
						insert,
						Arr.map(fields, (f, i) => widestValue(f, sketch.salt + i))
					)
				})
				const outcome = yield* Effect.result(run)
				succeeded(
					outcome,
					`the compiler accepts the key (${Arr.join(
						Arr.map(fields, (f) => columnSql(f)),
						", "
					)}) at ${layout.value.btreeBytes} bytes, but PostgreSQL refuses its widest fact\n${ddl}`
				)
			}).pipe(Effect.scoped),
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
