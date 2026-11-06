/**
 * A table's attribute numbers on PostgreSQL 19rc1, at the bound and one past it (W6.AT): PostgreSQL never reuses a
 * dropped column's attribute number, and refuses a table past 1600 of them, live and dropped together, with 54011
 * (heap.c, MaxHeapAttributeNumber). grizzle's snapshot records each table's attribute numbers ever used, so its draft
 * refuses an ADD COLUMN past that limit, naming the relation and saying to recreate it, exactly where PostgreSQL would
 * refuse the statement.
 *
 * - **PostgreSQL as the judge, over the box of the bound:** a table migrated through grizzle to exactly 1600 attribute
 *   numbers (a first version of 800 columns, then every one but the key dropped, declared, and 800 new ones added)
 *   commits and holds them; one more column is refused by grizzle's draft as an unsupported operation at the relation,
 *   before any statement is sent, and the same ADD COLUMN sent raw by the owner is refused by PostgreSQL with 54011.
 */
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
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
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** PostgreSQL's limit on a table's attribute numbers, live and dropped (htup_details.h MaxHeapAttributeNumber). */
const maxAttributes = tableMaxColumns.value

/** The columns of a version: `prefix0 … prefix(n − 1)`, each int2, beside the key. */
const columnsOf = (prefix: string, n: number): ReadonlyArray<string> =>
	Arr.makeBy(n, (i) => `${prefix}${i}`)

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

/** Where a case stands against the bound: on it, or one attribute number past it. */
type Place = "on the bound" | "one past the bound"

const places = ["on the bound", "one past the bound"] as const satisfies ReadonlyArray<Place>

layer(Substrate.layer)(
	"a table's attribute numbers through grizzle's migrations on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"a table migrated to exactly 1600 attribute numbers holds them, and one more is refused by grizzle's draft and by PostgreSQL raw",
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
						return yield* exhaust(
							{
								suite: "pg/migrate/attnums",
								generator: element(places),
								literal: Formatter.format,
								limit: places.length,
								coverage: requiredInSpace<Place>(places),
								caseHang,
								box: "a table's attribute numbers on PostgreSQL's bound and one past it",
								oracle: {
									kind: "postgresql",
									name: "PostgreSQL's own attribute numbers and its 54011 past MaxHeapAttributeNumber"
								}
							},
							(place: Place, c: Case<Place>) =>
								Effect.gen(function* () {
									c.note(place)
									if (place === "on the bound") {
										const [count] = yield* s.admin.queryValues(
											`SELECT max(attnum)::int4 FROM pg_catalog.pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0`,
											[]
										)
										assert.equal(Number(count?.[0]), maxAttributes, "the migrated table holds 1600")
										return
									}
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
									const refusal = refused(past, "UnsupportedOperation")
									assert.deepEqual(
										refusalLoc(refusal).path,
										["Wide"],
										"the refusal names the relation"
									)
									const raw = yield* attempt(m.owner, [`ALTER TABLE ${table} ADD COLUMN c0 int2`])
									assert.ok(
										raw.kind === "refused" && raw.fields.code === "54011",
										"PostgreSQL refuses the same ADD COLUMN with 54011"
									)
								})
						)
					})
				)
		)
	}
)
