/**
 * A table's attribute numbers on PostgreSQL 19rc1, around the bound: PostgreSQL never reuses a dropped
 * column's attribute number, and refuses a table past 1600 of them, live and dropped together, with 54011 (heap.c,
 * MaxHeapAttributeNumber). grizzle's snapshot records each table's attribute numbers ever used, so its draft refuses an
 * ADD COLUMN past that limit, naming the relation and saying to recreate it, exactly where PostgreSQL would refuse the
 * statement.
 *
 * - **PostgreSQL as the judge, over the box of the bound:** a table migrated through grizzle to two attribute numbers
 *   below the bound (a first version of 800 columns, then every one but the key dropped, declared, and 798 new ones
 *   added) holds them all; then every addition of one to four columns is drafted by grizzle and sent raw by the owner
 *   in a transaction rolled back: grizzle's draft refuses it as an unsupported operation at the relation, before any
 *   statement is sent, exactly when PostgreSQL refuses it with 54011.
 *
 * Features: an addition ending below the bound, on it, one past it and further past it.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): attnums-one-past (a draft admits an addition one attribute number past
 * PostgreSQL's bound).
 */
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { tableMaxColumns } from "#compiler/core/limits.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, refusalLoc, refused } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromSnapshot,
	generate,
	noDeclarations,
	ownedBy
} from "#test/support/migrate/kit.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** PostgreSQL's limit on a table's attribute numbers, live and dropped (htup_details.h MaxHeapAttributeNumber). */
const maxAttributes = tableMaxColumns.value

/** The columns of a version: `prefix0 … prefix(n − 1)`, each int2, beside the key. */
const columnsOf = (prefix: string, n: number): ReadonlyArray<string> =>
	upTo(n, (i) => `${prefix}${i}`)

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

/** How many attribute numbers the migrated table leaves below the bound. */
const slack = 2

/** How many columns past the slack an addition reaches at most. */
const past = 2

/** The first version's columns, 799 beside the key: 800 attribute numbers. */
const first = columnsOf("a", maxAttributes / 2 - 1)

/** The second version's: every first column dropped, and 798 new ones: the slack below the bound in all. */
const second = columnsOf("b", maxAttributes / 2 - slack)

/** Where an addition's attribute numbers end against the bound. */
type Place = "below the bound" | "on the bound" | "one past the bound" | "further past the bound"

/** Where the addition of `added` columns to the migrated table ends. */
const placeOf = (added: number): Place => {
	const end = maxAttributes - slack + added
	if (end < maxAttributes) {
		return "below the bound"
	}
	if (end === maxAttributes) {
		return "on the bound"
	}
	return end === maxAttributes + 1 ? "one past the bound" : "further past the bound"
}

layer(Substrate.layer)(
	"a table's attribute numbers through grizzle's migrations on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"a table migrated near 1600 attribute numbers holds them, and grizzle's draft refuses exactly the additions PostgreSQL refuses",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const m = yield* migrated({
							label: "attnums",
							schemaName: { kind: "unique" },
							first: (name) => ({ schema: wide(name, first), logins: [] }),
							later: [(name) => ({ schema: wide(name, second), logins: [] })],
							apply: { kind: "values", value: () => "0" },
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
						return yield* exhaust(
							{
								suite: "pg/migrate/attnums",
								generator: int(1, slack + past),
								literal: Formatter.format,
								coverage: requiredInSpace<Place>([
									"below the bound",
									"on the bound",
									"one past the bound",
									"further past the bound"
								]),
								caseHang,
								box: "every addition of one to four columns to a table two attribute numbers below PostgreSQL's bound",
								oracle: {
									kind: "postgresql",
									name: "PostgreSQL's own attribute numbers and its 54011 past MaxHeapAttributeNumber"
								}
							},
							(added: number, c: Case<Place>) =>
								Effect.gen(function* () {
									c.note(placeOf(added))
									const [count] = yield* s.admin.queryValues(
										`SELECT max(attnum)::int4 FROM pg_catalog.pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0`,
										[]
									)
									assert.equal(
										Number(count?.[0]),
										maxAttributes - slack,
										"the migrated table holds every attribute number it used"
									)
									const columns = columnsOf("c", added)
									const drafted = generate({
										installation: compile(wide(m.declared, [...second, ...columns]), {
											...asDrafted,
											owner: ownedBy(s.owner.role)
										}),
										timestamp: draftedAt(3),
										previous: fromSnapshot(m.snapshot),
										workload: noWorkload,
										declared: noDeclarations,
										name: "step_3"
									})
									yield* m.owner.begin
									const raw = yield* refusalOf(
										m.owner.query(
											`ALTER TABLE ${table} ${Arr.join(
												Arr.map(columns, (column) => `ADD COLUMN ${quoteIdent(column)} int2`),
												", "
											)}`,
											[]
										)
									)
									yield* m.owner.rollback
									assert.equal(
										drafted.ok,
										Option.isNone(raw),
										"grizzle drafts exactly the additions PostgreSQL admits"
									)
									if (drafted.ok) {
										return
									}
									assert.deepEqual(
										refusalLoc(refused(drafted, "UnsupportedOperation")).path,
										["Wide"],
										"the refusal names the relation"
									)
									assert.deepEqual(
										Option.map(raw, (fields) => fields.code),
										Option.some("54011"),
										"PostgreSQL refuses the same addition with 54011"
									)
								})
						)
					})
				)
		)
	}
)
