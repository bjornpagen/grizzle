/**
 * Declared renames through grizzle's migrations, on PostgreSQL 19rc1 (W4.Q5a, D9): every rename and drop a migration
 * makes is declared (`--rename R=S`, `--rename R.f=R.g`, `--rename Roster#old=new`, `--drop`), so nothing guesses
 * whether a drop and an addition are one rename. A declared rename is drafted as a rename and migrates the stored data
 * with it; an undeclared drop is refused at the draft, naming what it drops.
 *
 * - **PostgreSQL as the judge, over a model of declared identities:** a relation renamed keeps its table (its OID) and
 *   every row; a field renamed keeps its column (its attribute number) and every value; a handle renamed keeps its
 *   code, so a stored row of the old handle reads as the new one; a field dropped undeclared is refused before any
 *   statement, naming the field, and declared, migrates with the column gone.
 *
 * The rename heuristic's suite this file held (candidates, offers and choices) is culled with the heuristic: dead
 * representation (testing doctrine, "Culling"), its contract now this file's and A4's unit model's
 * (test/unit/deploy/renames.test.ts).
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { codebookOf, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	ownedBy,
	compile,
	draftedAt,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A relation's table and a field's column, as the naming door names them. */
const tableOf = (relation: string): string => identifierOf(identity.table(parsedName(relation)))
const columnOf = (field: string): string => identifierOf(identity.column(parsedName(field)))

/** What a test reads between versions, as the owner, by the version's index. */
type Observed = Array<ReadonlyArray<ReadonlyArray<unknown>>>

const values = (
	session: RawSession,
	sql: string
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>> => Effect.orDie(session.values(sql, []))

const rename = (
	from: Declarations["renames"][number]["from"],
	to: Declarations["renames"][number]["to"]
): Declarations => ({
	renames: [{ from, to }],
	drops: []
})

layer(Substrate.layer)(
	"declared renames through grizzle's migrations on PostgreSQL 19rc1",
	(it) => {
		it.effect("a relation renamed by declaration keeps its table and every row", () =>
			Effect.gen(function* () {
				const observed: Observed = []
				let schemaName = ""
				yield* migrated({
					label: "rename_relation",
					schemaName: { kind: "unique" },
					first: (name) => {
						schemaName = name
						return {
							schema: schema(name, { R: relation("R", { id: pg.int4, x: pg.int4 }, ["id"]) }, []),
							logins: []
						}
					},
					later: [
						(name) => ({
							schema: schema(name, { S: relation("S", { id: pg.int4, x: pg.int4 }, ["id"]) }, []),
							logins: []
						})
					],
					apply: { kind: "noPlaceholders" },
					register: false,
					declared: (v) =>
						v === 1
							? rename(
									{ kind: "relation", relation: parsedName("R") },
									{ kind: "relation", relation: parsedName("S") }
								)
							: noDeclarations,
					observe: Option.some((v: number, owner: RawSession) =>
						Effect.gen(function* () {
							const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
							const table = `${quoteIdent(schemaIdent)}.${quoteIdent(tableOf(v === 0 ? "R" : "S"))}`
							if (v === 0) {
								yield* Effect.orDie(owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", []))
								yield* Effect.orDie(
									owner.query(
										`INSERT INTO ${table} (${quoteIdent(columnOf("id"))}, ${quoteIdent(columnOf("x"))}) VALUES (1, 7)`,
										[]
									)
								)
								yield* Effect.orDie(owner.query("COMMIT", []))
							}
							const read = yield* values(
								owner,
								`SELECT '${table}'::regclass::oid::int8::text, ${quoteIdent(columnOf("x"))}::text FROM ${table}`
							)
							observed.push(read)
						})
					)
				})
				const [before, after] = observed
				assert.deepEqual(
					after,
					before,
					"the renamed table is the same table, its OID and its row kept"
				)
			})
		)

		it.effect("a field renamed by declaration keeps its column and every value", () =>
			Effect.gen(function* () {
				const observed: Observed = []
				let schemaName = ""
				yield* migrated({
					label: "rename_field",
					schemaName: { kind: "unique" },
					first: (name) => {
						schemaName = name
						return {
							schema: schema(name, { R: relation("R", { id: pg.int4, x: pg.int4 }, ["id"]) }, []),
							logins: []
						}
					},
					later: [
						(name) => ({
							schema: schema(name, { R: relation("R", { id: pg.int4, y: pg.int4 }, ["id"]) }, []),
							logins: []
						})
					],
					apply: { kind: "noPlaceholders" },
					register: false,
					declared: (v) =>
						v === 1
							? rename(
									{ kind: "field", relation: parsedName("R"), field: parsedName("x") },
									{ kind: "field", relation: parsedName("R"), field: parsedName("y") }
								)
							: noDeclarations,
					observe: Option.some((v: number, owner: RawSession) =>
						Effect.gen(function* () {
							const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
							const table = `${quoteIdent(schemaIdent)}.${quoteIdent(tableOf("R"))}`
							const column = columnOf(v === 0 ? "x" : "y")
							if (v === 0) {
								yield* Effect.orDie(owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", []))
								yield* Effect.orDie(
									owner.query(
										`INSERT INTO ${table} (${quoteIdent(columnOf("id"))}, ${quoteIdent(column)}) VALUES (1, 7)`,
										[]
									)
								)
								yield* Effect.orDie(owner.query("COMMIT", []))
							}
							const read = yield* values(
								owner,
								`SELECT a.attnum::int4::text, r.v FROM pg_catalog.pg_attribute AS a, LATERAL (SELECT ${quoteIdent(column)}::text AS v FROM ${table}) AS r WHERE a.attrelid = '${table}'::regclass AND a.attname = '${column}'`
							)
							observed.push(read)
						})
					)
				})
				const [before, after] = observed
				assert.deepEqual(
					after,
					before,
					"the renamed column keeps its attribute number and its value"
				)
			})
		)

		it.effect(
			"a handle renamed by declaration keeps its code, so a stored row of the old handle reads as the new",
			() =>
				Effect.gen(function* () {
					const observed: Observed = []
					let schemaName = ""
					const before = closed("Kind", ["a", "b"])
					const after = closed("Kind", ["a", "c"])
					const m = yield* migrated({
						label: "rename_handle",
						schemaName: { kind: "unique" },
						first: (name) => {
							schemaName = name
							return {
								schema: schema(
									name,
									{ Kind: before, R: relation("R", { id: pg.int4, k: closedId(before) }, ["id"]) },
									[]
								),
								logins: []
							}
						},
						later: [
							(name) => ({
								schema: schema(
									name,
									{ Kind: after, R: relation("R", { id: pg.int4, k: closedId(after) }, ["id"]) },
									[]
								),
								logins: []
							})
						],
						apply: { kind: "noPlaceholders" },
						register: false,
						declared: (v) =>
							v === 1
								? rename(
										{ kind: "handle", roster: parsedName("Kind"), handle: "b" },
										{ kind: "handle", roster: parsedName("Kind"), handle: "c" }
									)
								: noDeclarations,
						observe: Option.some((v: number, owner: RawSession) =>
							Effect.gen(function* () {
								const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
								const table = `${quoteIdent(schemaIdent)}.${quoteIdent(tableOf("R"))}`
								if (v === 0) {
									yield* Effect.orDie(owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", []))
									yield* Effect.orDie(
										owner.query(
											`INSERT INTO ${table} (${quoteIdent(columnOf("id"))}, ${quoteIdent(columnOf("k"))}) VALUES (1, 1)`,
											[]
										)
									)
									yield* Effect.orDie(owner.query("COMMIT", []))
								}
								const read = yield* values(
									owner,
									`SELECT ${quoteIdent(columnOf("k"))}::int4::text FROM ${table}`
								)
								observed.push(read)
							})
						)
					})
					const [stored, kept] = observed
					assert.deepEqual(kept, stored, "the stored code is unchanged")
					const codec = defined(
						codebookOf(m.snapshot).rosters.get(parsedName("Kind")),
						"the snapshot's codes of Kind"
					)
					assert.equal(
						codec.codeOf.get("c"),
						1,
						"the renamed handle holds the old handle's code, so the stored row reads as it"
					)
					assert.equal(codec.codeOf.get("b"), undefined, "the old handle is gone")
				})
		)

		it.effect(
			"an undeclared drop is refused at the draft naming the field, and a declared one migrates",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const m = yield* migrated({
						label: "drop_field",
						schemaName: { kind: "unique" },
						first: (name) => ({
							schema: schema(name, { R: relation("R", { id: pg.int4, x: pg.int4 }, ["id"]) }, []),
							logins: []
						}),
						later: [],
						apply: { kind: "noPlaceholders" },
						register: false,
						declared: () => noDeclarations,
						observe: Option.none()
					})
					const dropped = schema(m.declared, { R: relation("R", { id: pg.int4 }, ["id"]) }, [])
					const draft = (declared: Declarations) =>
						generate({
							installation: compile(dropped, { ...asDrafted, owner: ownedBy(s.owner.role) }),
							timestamp: draftedAt(2),
							previous: fromSnapshot(m.snapshot),
							workload: noWorkload,
							declared,
							name: "step_2"
						})
					const undeclared = draft(noDeclarations)
					assert.ok(!undeclared.ok, "an undeclared drop is refused")
					assert.ok(
						Str.includes("R.x")(undeclared.error.message) ||
							(Str.includes("R")(undeclared.error.message) &&
								Str.includes("x")(undeclared.error.message)),
						`the refusal names the field it drops: ${undeclared.error.message}`
					)
					const declared = draft({
						renames: [],
						drops: [{ kind: "field", relation: parsedName("R"), field: parsedName("x") }]
					})
					assert.ok(declared.ok, "a declared drop drafts")
					const later = yield* migrated({
						label: "drop_field_declared",
						schemaName: { kind: "unique" },
						first: (name) => ({
							schema: schema(name, { R: relation("R", { id: pg.int4, x: pg.int4 }, ["id"]) }, []),
							logins: []
						}),
						later: [
							(name) => ({
								schema: schema(name, { R: relation("R", { id: pg.int4 }, ["id"]) }, []),
								logins: []
							})
						],
						apply: { kind: "noPlaceholders" },
						register: false,
						declared: (v) =>
							v === 1
								? {
										renames: [],
										drops: [{ kind: "field", relation: parsedName("R"), field: parsedName("x") }]
									}
								: noDeclarations,
						observe: Option.none()
					})
					const live = yield* s.admin.queryValues(
						`SELECT count(*)::int4 FROM pg_catalog.pg_attribute WHERE attrelid = '${quoteIdent(later.schema)}.${quoteIdent(tableOf("R"))}'::regclass AND attnum > 0 AND NOT attisdropped`,
						[]
					)
					assert.equal(
						Number(Arr.getUnsafe(Arr.getUnsafe(live, 0), 0)),
						1,
						"the declared drop leaves the key alone"
					)
				})
		)
	}
)
