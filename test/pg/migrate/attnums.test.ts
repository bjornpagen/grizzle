/**
 * A table's attribute numbers on PostgreSQL 19rc1 (W6.AT): PostgreSQL never reuses a dropped column's attribute
 * number, and refuses a table past 1600 of them, live and dropped together, with 54011 (heap.c, MaxHeapAttributeNumber).
 * grizzle's snapshot records each table's attribute numbers ever used, so its draft refuses an ADD COLUMN past that
 * limit, naming the table and saying to recreate it, exactly where PostgreSQL would refuse the statement.
 *
 * - **PostgreSQL as the judge:** a table migrated through grizzle to exactly 1600 attribute numbers (a first version of
 *   800 columns, then every one but the key dropped, declared, and 800 new ones added) commits; grizzle's next draft
 *   adding one more column is refused before any statement is sent; and the same ADD COLUMN sent raw by the owner is
 *   refused by PostgreSQL with 54011. The boundary is both ways: one column fewer drafts and migrates.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	compile,
	asDrafted,
	ownedBy,
	draftedAt,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** PostgreSQL's limit on a table's attribute numbers, live and dropped (htup_details.h MaxHeapAttributeNumber). */
const maxAttributes = 1600

/** The columns of a version: `prefix0 … prefix(n − 1)`, each int2, beside the key. */
const columnsOf = (prefix: string, n: number): ReadonlyArray<string> =>
	Arr.map(Arr.range(0, n - 1), (i) => `${prefix}${i}`)

/** A wide relation of its key and the given int2 columns. */
const wide = (name: string, columns: ReadonlyArray<string>) =>
	schema(
		name,
		{
			Wide: relation(
				"Wide",
				{ id: pg.int4, ...Rec.fromEntries(Arr.map(columns, (c) => [c, pg.int2] as const)) },
				["id"]
			)
		},
		[]
	)

/** The first version's columns, 799 beside the key: 800 attribute numbers. */
const first = columnsOf("a", maxAttributes / 2 - 1)

/** The second version's: every first column dropped, and 800 new ones: 1600 attribute numbers in all. */
const second = columnsOf("b", maxAttributes / 2)

layer(Substrate.layer)(
	"a table's attribute numbers through grizzle's migrations on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"migrate a table to exactly 1600 attribute numbers, refuse the draft of one more before PostgreSQL's 54011, and see PostgreSQL refuse it raw",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const m = yield* migrated({
						label: "attnums",
						schemaName: { kind: "unique" },
						first: (name) => ({ schema: wide(name, first), logins: [] }),
						later: [(name) => ({ schema: wide(name, second), logins: [] })],
						apply: { kind: "values", value: () => "0" },
						register: false,
						declared: (version) =>
							version === 1
								? {
										renames: [],
										drops: Arr.map(first, (c) => ({
											kind: "field",
											relation: parsedName("Wide"),
											field: parsedName(c)
										}))
									}
								: noDeclarations,
						observe: Option.none()
					})
					const table = `${quoteIdent(m.schema)}.${quoteIdent(m.names.relation("Wide").name)}`
					const [count] = yield* s.admin.queryValues(
						`SELECT max(attnum)::int4 FROM pg_catalog.pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0`,
						[]
					)
					assert.equal(
						Number(count?.[0]),
						maxAttributes,
						"the migrated table holds 1600 attribute numbers"
					)
					const past = generate({
						installation: compile(wide(m.declared, [...second, "c0"]), {
							...asDrafted,
							owner: ownedBy(s.owner.role)
						}),
						timestamp: draftedAt(3),
						previous: fromSnapshot(m.snapshot),
						workload: noWorkload,
						declared: noDeclarations,
						name: "step_3"
					})
					assert.ok(!past.ok, "grizzle's draft of a column past 1600 attribute numbers is refused")
					assert.ok(
						Str.includes("recreate the table")(past.error.message),
						`the refusal says to recreate the table: ${past.error.message}`
					)
					const raw = yield* attempt(m.owner, [`ALTER TABLE ${table} ADD COLUMN c0 int2`])
					assert.ok(
						raw.kind === "refused" && raw.fields.code === "54011",
						"PostgreSQL refuses the same ADD COLUMN with 54011"
					)
				})
		)
	}
)
