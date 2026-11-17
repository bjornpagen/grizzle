/**
 * Key text bounded by bytes, against PostgreSQL 19: a text whose contract bounds its octet_length at
 * keyTextBytes(companions) sits in a key beside those companions in any order, its widest value inserting with no
 * "index row size exceeds btree maximum" (54000), and a value one byte longer is refused by the contract's domain CHECK
 * (23514), before any index sees it.
 *
 * Each case draws the key's other fields, uuid, natural, integer, smallint, boolean and a closed id, the order of the
 * key, the text among them, and the text's code points: ASCII, two-byte, CJK and astral, drawn apart enough that no
 * compression shortens them, the last code point of each value of a drawn width, so the bound is met at a multibyte
 * boundary.
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
 * Features: the text's place in the key, a closed id beside it, the width of the bounding code point, and the tight
 * budget, met in the entry that carries the null bitmap.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract } from "#compiler/public/fields.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import {
	type BytesFeature,
	caseGen,
	descriptorOf,
	Kind,
	lastWidth,
	textOf,
	textPosition,
	tight,
	utf8,
	widestOf
} from "#test/pg/oracle/key-text-bytes.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A key's text bounded by keyTextBytes against PostgreSQL's B-tree item limit: a text of exactly keyTextBytes bytes in a
 * key beside its companions is inserted, and one byte more is refused by its domain.
 */
export const exactlyKeyTextBytes = property.explore(caseGen, {
	needs: { substrate: Substrate.installing },
	/** Its pre-conversion budget: runs 40, coverage cases 40 (key-text-bytes.test.ts:269,300-303 at 41df7b58^). */
	budget: { runs: 40, steered: 40 },
	situations: [
		"text first",
		"text last",
		"text between",
		"tight budget",
		"a closed id beside it",
		"last code point of 1 bytes",
		"last code point of 2 bytes",
		"last code point of 3 bytes",
		"last code point of 4 bytes"
	] satisfies ReadonlyArray<Reached<BytesFeature>>,
	check:
		({ substrate }, k: Case<BytesFeature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const budget = keyTextBytes(Arr.map(c.companions, descriptorOf))
					const KeyText = contract("KeyText", str.regex("^.*$", "su"), (v) =>
						Compute.octetLength(v).le(budget)
					)
					const names = [...Arr.map(indices(c.companions.length), (i) => `c${i}`), "t"]
					const fields = Rec.fromEntries([
						...Arr.map(c.companions, (comp, i): readonly [string, FieldBase] => [
							`c${i}`,
							descriptorOf(comp)
						]),
						["t", KeyText] as const
					])
					const key = Arr.map(c.order, (p) => defined(names[p], "a key field"))
					const Keyed = relation("Keyed", fields, key, [])
					const installed = yield* install(schema("TextBytes", [Kind, Keyed], [], []), {
						ambient: ordinarySession,
						label: "textbytes",
						logins: [],
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
					if (Arr.contains(c.companions, "closedId")) {
						k.note("a closed id beside it")
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
							[...Arr.map(c.companions, widestOf), `'${Str.replaceAll("'", "''")(text)}'`],
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
					const domain = namesOf(installed).contract("KeyText")
					assert.equal(error?.code, "23514", "one byte past the budget is the domain's to refuse")
					assert.equal(
						error?.constraint,
						domain.kind === "checked" ? domain.constraint : undefined,
						"the contract's domain CHECK refuses it"
					)
				}),
				Substrate,
				substrate
			),
	oracle: {
		kind: "postgresql",
		name: "the B-tree item limit, 54000, and the contract domain's CHECK, 23514"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/public/text.ts",
			original: "\treturn room.value",
			replacement: "\treturn room.value + 1",
			why: "keyTextBytes allows one byte past the room the companions leave (public/text.ts), so the tight case's entry that carries the null bitmap overflows the B-tree item limit (54000)."
		}
	]
})
