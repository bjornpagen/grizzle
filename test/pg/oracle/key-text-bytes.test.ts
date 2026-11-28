/**
 * Key text bounded by bytes, against PostgreSQL 19: a text whose contract bounds its octet_length at
 * keyTextBytes(companions) sits in a key beside those companions in any order, its widest value inserting with no
 * "index row size exceeds btree maximum" (54000), and a value one byte longer is refused by the contract's domain CHECK
 * (23514), before any index sees it.
 *
 * Each case draws the key's other fields, uuid, natural, integer, smallint, boolean and a closed id, the order of the
 * key, the text among them, and the text's code points: ASCII, two-byte, CJK and astral, drawn apart enough that no
 * compression shortens them, the last code point of each value of a drawn width, so the bound is met at a multibyte
 * boundary. Each other field is handed to keyTextBytes as its type's descriptor or as a field of that type of any kind a
 * relation holds, which keyTextBytes reads as its declared type: an accumulated or a generated field, drawn(natural), the
 * closed relation's slot; the installed relation declares each of its type.
 *
 * The budget is the room in the worst entry grizzle may plan over the key's columns: one that carries the null bitmap
 * of an index whose hidden law column holds NULL (schema/representability.ts textBytesBeside). The key's own primary
 * key holds no nullable column, so its entry has no bitmap and the budget leaves it eight bytes, the bitmap's MAXALIGNed
 * share, by design. So each case also writes its row at the budget into an entry that does carry the bitmap: a
 * temporary copy of the table, its columns' types and NOT NULLs, with a nullable column left NULL last in a unique
 * index over the key's columns, rolled back. Where every other field of the key comes before the text and lays out
 * with the widest padding the budget counts (each of alignment one, the text aligned past an odd offset), that entry is
 * exactly the most the B-tree holds, so a budget one byte too large fails the insert there (54000). The generator
 * builds that layout on purpose, beside its free draws.
 *
 * Oracle: PostgreSQL itself, its B-tree item limit (54000) and the contract domain's CHECK (23514).
 *
 * Features: the text's place in the key, a closed id beside it, the width of the bounding code point, the tight
 * budget, met in the entry that carries the null bitmap, and each kind of field a companion is handed as.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { domain } from "#compiler/public/fields.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import {
	type BytesFeature,
	caseSpace,
	descriptorOf,
	fieldOf,
	Kind,
	lastWidth,
	textOf,
	textPosition,
	tight,
	utf8,
	widestOf
} from "#test/pg/oracle/key-text-bytes.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

const keyTextKey = Symbol("KeyText")
/**
 * A key's text bounded by keyTextBytes against PostgreSQL's B-tree item limit: a text of exactly keyTextBytes bytes in a
 * key beside its companions is inserted, and one byte more is refused by its domain.
 */
export const exactlyKeyTextBytes = property.explore(caseSpace, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/key-text-bytes.test.ts exactlyKeyTextBytes
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
	 * @workload its witnesses with each of its two kills applied, every kill on workers of its own, and its full run, at
	 *   runs 40, 33, 29 and 1, steered 40
	 * @result runs 40 (pre-conversion): the public/text.ts kill fails steered case 3, the schema/relation.ts kill floor
	 *   case 8; runs 33: both killed; runs 29: steered cases 25 and 3; runs 1: both killed, its situations reached with
	 *   16 steered cases, 18 cases in all where f1bf91a2f's gate ran 66
	 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run: both kills fail a witness there.
	 *   steered stays its pre-conversion 40: the phase stops once every required situation is reached, so a green run
	 *   spends only its need, 16 here, and the cap only bounds a run whose situation went unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 1, steered: 40 },
	situations: [
		"text first",
		"text last",
		"text between",
		"tight budget",
		"a closed id beside it",
		"last code point of 1 bytes",
		"last code point of 2 bytes",
		"last code point of 3 bytes",
		"last code point of 4 bytes",
		"accumulated companion",
		"generated companion",
		"drawn companion",
		"slot companion"
	] satisfies ReadonlyArray<Reached<BytesFeature>>,
	check:
		({ substrate }, k: Case<BytesFeature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const budget = keyTextBytes(Arr.map(c.companions, fieldOf))
					const KeyText = domain<typeof keyTextKey>()("KeyText", str.regex("^.*$", "su"), (v) =>
						Logic.le(Text.octetLength(v), budget)
					)
					const names = [...Arr.map(indices(c.companions.length), (i) => `c${i}`), "t"]
					const fields = Rec.fromEntries([
						...Arr.map(c.companions, (comp, i): readonly [string, FieldBase] => [
							`c${i}`,
							descriptorOf(comp.type)
						]),
						["t", KeyText] as const
					])
					const key = Arr.map(c.order, (p) => defined(names[p], "a key field"))
					const Keyed = relation("Keyed", fields, key, [])
					const installed = yield* install(schema("TextBytes", [Kind, Keyed], [], []), {
						ambient: ordinarySession,
						label: "textbytes",
						extensions: []
					})
					const textAt = textPosition(c)
					k.note(
						textAt === 0
							? "text first"
							: textAt === c.companions.length
								? "text last"
								: "text between"
					)
					if (tight(c)) {
						k.note("tight budget")
					}
					if (Arr.some(c.companions, (comp) => comp.type === "closedId")) {
						k.note("a closed id beside it")
					}
					for (const comp of c.companions) {
						if (comp.reading !== "caller") {
							k.note(`${comp.reading} companion`)
						}
					}
					const substrate = yield* Substrate
					const session = yield* substrate.session({
						...ownerSession(),
						label: "text bytes writer"
					})
					const relationName = installed.names.relation("Keyed")
					const table = `${quoteIdent(relationName.schema)}.${quoteIdent(relationName.name)}`
					const columns = Arr.join(
						Arr.map(names, (n) => quoteIdent(installed.names.column("Keyed", n))),
						", "
					)
					const values = (text: string): string =>
						Arr.join(
							[
								...Arr.map(c.companions, (comp) => widestOf(comp.type)),
								`'${Str.replaceAll("'", "''")(text)}'`
							],
							", "
						)
					const atBudget = textOf(budget, c.widths, c.last, c.salt)
					assert.equal(utf8.encode(atBudget).length, budget, "a text of exactly the budget's bytes")
					const boundary = lastWidth(atBudget)
					if (boundary !== undefined) {
						k.note(`last code point of ${boundary} bytes`)
					}
					const stored = yield* Effect.result(
						session.query(`INSERT INTO ${table} (${columns}) VALUES (${values(atBudget)})`, [])
					)
					assert.equal(
						stored._tag,
						"Success",
						`a text of ${budget} bytes beside ${Formatter.format(c.companions)} in key order ${Formatter.format(key)} is stored: ${stored._tag === "Failure" ? Formatter.format(pgErrorFields(stored.failure)) : ""}`
					)
					const probeIndex = Arr.join(
						[...Arr.map(key, (n) => quoteIdent(installed.names.column("Keyed", n))), "unset"],
						", "
					)
					yield* session.query("BEGIN", [])
					yield* session.query(
						`CREATE TEMPORARY TABLE key_text_probe (LIKE ${table}) ON COMMIT DROP`,
						[]
					)
					yield* session.query("ALTER TABLE key_text_probe ADD COLUMN unset boolean", [])
					yield* session.query(`CREATE UNIQUE INDEX ON key_text_probe (${probeIndex})`, [])
					const probed = yield* Effect.result(
						session.query(
							`INSERT INTO key_text_probe (${columns}) VALUES (${values(atBudget)})`,
							[]
						)
					)
					yield* session.query("ROLLBACK", [])
					assert.equal(
						probed._tag,
						"Success",
						`a text of ${budget} bytes beside ${Formatter.format(c.companions)} and a NULL, in key order ${Formatter.format(key)}, is stored in an entry that carries the null bitmap: ${probed._tag === "Failure" ? Formatter.format(pgErrorFields(probed.failure)) : ""}`
					)
					const past = textOf(budget + 1, c.widths, c.last, c.salt + 1)
					assert.equal(utf8.encode(past).length, budget + 1, "a text one byte past the budget")
					const refused = yield* Effect.result(
						session.query(`INSERT INTO ${table} (${columns}) VALUES (${values(past)})`, [])
					)
					const error = refused._tag === "Failure" ? pgErrorFields(refused.failure) : undefined
					const keyTextDomain = namesOf(installed).contract("KeyText")
					assert.equal(error?.code, "23514", "one byte past the budget is the domain's to refuse")
					assert.equal(
						error?.constraint,
						keyTextDomain.kind === "checked" ? keyTextDomain.constraint : undefined,
						"the contract's domain CHECK refuses it"
					)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "the B-tree item limit, 54000, and the contract domain's CHECK, 23514"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/oracle/key-text-bytes.test.ts#exactlyKeyTextBytes:1b7d.8:0.1.0.0.1.1.0.0.0.0.0"
			),
			reason:
				"an accumulated Id companion, minted under the tests' id key (97c8891645), red on the merged tree while the fixture minted under none",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/public/text.ts",
			original: "\treturn room.value",
			replacement: "\treturn room.value + 1",
			why: "keyTextBytes allows one byte past the room the companions leave (public/text.ts), so the tight case's entry that carries the null bitmap overflows the B-tree item limit (54000)."
		},
		{
			file: "packages/engine/src/schema/relation.ts",
			original: '\t\tcase "slot":\n\t\t\treturn entry.type',
			replacement: '\t\tcase "slot":\n\t\t\treturn value',
			why: "The one reading of a field as its declared type (describeDeclared) misses a slot: a closed relation's slot field is read as itself, a copy of its closed id that no builder registered, so keyTextBytes refuses a slot companion (MalformedDescription) though its type admits it."
		}
	]
})
