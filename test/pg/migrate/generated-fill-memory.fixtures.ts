/** What the property of generated-fill-memory.test.ts reads: its schema, its sizes and its measurement. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import {
	accumulated,
	drawn as drawnField,
	generated,
	natural,
	pg
} from "#compiler/public/fields.ts"
import { counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Member's stored generated fields over `x`, beside the one over `cheap`: qti.attribute holds 104 at its C18 fill, each
 * a tree PostgreSQL 19 parses again for every row the fill writes.
 *
 * @formatConstant the generated fields over `x` of Member, a table of many generation expressions
 */
const generatedFields = 48

/** The sizes of the box, each a multiple of the smallest, n: n, 2n and 4n owners, each with one member. */
export const scales = [1, 2, 4] as const

export type Scale = (typeof scales)[number]

/** The owners of the smallest size, n: 2n and 4n follow. */
export const smallest = 1000

/** Member: its key, its group g, the folded `x`, `cheap`, and generated fields over `x` and over `cheap`, the cheapest
 * of them the one reading `cheap` alone. */
const member = () =>
	relation.generated(
		"Member",
		{ member: pg.integer, g: pg.integer, x: pg.integer, cheap: pg.integer },
		["member"],
		(r) => ({
			...Rec.fromEntries(
				Array.from(
					{ length: generatedFields },
					(_, i) => [`g${i}`, generated(pg.integer, r.x)] as const
				)
			),
			byCheap: generated(pg.integer, r.cheap)
		})
	)

/** The first version: Owner and its members, no family. */
const plain = (name: string) =>
	schema(name, [relation("Owner", { id: pg.integer }, ["id"]), member()], [])

/** The second version: Member counted under Owner by g, which the backfill draws, each member's index among them, a
 * column a generated one reads (its predecessor). */
const counting = (name: string) => {
	const Owner = relation("Owner", { id: pg.integer, n: drawnField(natural) }, ["id"])
	const Member = member()
	return schema(name, [Owner, Member], [counted(on(Member, "g"), fin(Owner, "n"))])
}

/** The third version: the counted family folded by sum of x, the fold's hidden accumulators on Member the columns its
 * backfill writes, as C18's fill wrote qti.attribute's, which no generated column reads. */
const folding = (name: string) => {
	const Owner = relation(
		"Owner",
		{ id: pg.integer, n: drawnField(natural), end: accumulated(pg.integer, 0) },
		["id"]
	)
	const Member = member()
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema(
		name,
		[Owner, Member],
		[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))]
	)
}

const namesOf = (declared: string) => {
	const schemaIdent = quoteIdent(identifierOf(identity.schema(parsedSchemaName(declared))))
	return {
		table: (r: string) =>
			`${schemaIdent}.${quoteIdent(identifierOf(identity.table(parsedName(r))))}`,
		column: (f: string) => quoteIdent(identifierOf(identity.column(parsedName(f))))
	}
}

/** No placeholder: the backfill draws every column the second version adds. */
const noValue = (placeholder: Placeholder): string => {
	throw new Error(
		`a placeholder of ${placeholder.table.name}, where the backfill draws every column`
	)
}

/** What one size's backfill of Member held: the rows it wrote and ExecutorState's bytes as its statement ended. */
export interface Held {
	readonly members: number
	readonly bytes: number
	/** The fold's backfill's UPDATE of Member, as the folder holds it. */
	readonly update: string
}

/**
 * One size's fold backfill: the first version installed with `owners` owners, each with one member, the second
 * migrated over them, then the third by the real runner, its Structure file holding, around the fold's backfill UPDATE
 * of Member, a statement-level trigger that reads the size of the UPDATE's ExecutorState (pg_backend_memory_contexts)
 * as PostgreSQL ends it (AfterTriggerEndQuery runs before ExecutorEnd frees it), then drops itself.
 */
export const heldAt = (owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const allocated = yield* substrate.schema({ create: true, label: "fill_probe" })
			const probeSchema = quoteIdent(allocated)
			const probed = `${probeSchema}.${quoteIdent("probed")}`
			const probe = `${probeSchema}.${quoteIdent("probe")}`
			yield* substrate.superuser(`CREATE TABLE ${probed} (bytes bigint NOT NULL)`)
			yield* substrate.superuser(
				`CREATE FUNCTION ${probe}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN INSERT INTO ${probed} (bytes) SELECT max(total_bytes) FROM pg_catalog.pg_backend_memory_contexts WHERE name = 'ExecutorState'; RETURN NULL; END $$`
			)
			const state = { declared: "", update: "" }
			const edit = (version: number, file: { readonly name: string; readonly text: string }) => {
				if (version !== 2 || !Str.endsWith("-structure.sql")(file.name)) {
					return file.text
				}
				const { table } = namesOf(state.declared)
				const update = defined(
					Arr.findFirst(splitStatements(file.text), (s) =>
						Str.includes(`UPDATE ${table("Member")} AS `)(s)
					).pipe(Option.getOrUndefined),
					"the third version's Structure file holds the fold's backfill UPDATE of Member"
				)
				state.update = update
				const trigger = `CREATE TRIGGER fill_probe AFTER UPDATE ON ${table("Member")} FOR EACH STATEMENT EXECUTE FUNCTION ${probe}();\n\n`
				const drop = `;\n\nDROP TRIGGER fill_probe ON ${table("Member")};`
				const [head, ...tail] = Str.split(`${update};`)(file.text)
				if (tail.length !== 1) {
					throw new Error(
						"the fold's backfill UPDATE of Member stands once in its Structure file, ended by its semicolon"
					)
				}
				return Arr.join([head, trigger, update, drop, ...tail], "")
			}
			yield* migrated({
				label: "generated_fill",
				schemaName: { kind: "unique" },
				first: (name) => {
					state.declared = name
					return { schema: plain(name), logins: [] }
				},
				later: [
					(name) => ({ schema: counting(name), logins: [] }),
					(name) => ({ schema: folding(name), logins: [] })
				],
				apply: { kind: "reviewed", value: noValue, edit },
				declared: () => noDeclarations,
				observe: Option.some((version: number, owner) =>
					version === 0
						? Effect.gen(function* () {
								const { table, column } = namesOf(state.declared)
								yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
								yield* owner.query(
									`INSERT INTO ${table("Owner")} (${column("id")}) SELECT i FROM pg_catalog.generate_series(1, ${owners}) AS i`,
									[]
								)
								yield* owner.query(
									`INSERT INTO ${table("Member")} (${column("member")}, ${column("g")}, ${column("x")}, ${column("cheap")}) SELECT i, i, i, i FROM pg_catalog.generate_series(1, ${owners}) AS i`,
									[]
								)
								yield* owner.query("COMMIT", [])
							})
						: Effect.void
				)
			})
			const bytes = yield* substrate.superuserRead((rows) =>
				rows(`SELECT bytes::text FROM ${probed}`)
			)
			const [first, ...rest] = bytes
			if (first === undefined || rest.length > 0) {
				throw new Error(
					`the fold's backfill UPDATE of Member ends once, and its probe reads ${bytes.length} times`
				)
			}
			return {
				members: owners,
				bytes: Number(Arr.getUnsafe(first, 0)),
				update: state.update
			} satisfies Held
		})
	)
