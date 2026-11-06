/**
 * Dependent-sum keys through grizzle's migrations on PostgreSQL 19rc1: a change to a dependent space is a constant
 * replacement, and the codes its slots are stay stable under declared renames.
 *
 * One installation is migrated through four versions of a slotted closed relation Last, keyed by (version, parent, at)
 * with `at` a slot of fin(Model, "positions"), and of its product twin LastProduct, keyed by the same fields as closed
 * ids. Each is read by the containment CHECK of a stored probe relation (Step into Last, StepProduct into
 * LastProduct). After each version the test reads, from PostgreSQL's catalog, the functions each CHECK depends on, and
 * the probe rows; then writes the next probe rows:
 *
 * - **v0:** Model counts 1 slot for (v0, k0) and 2 for (v0, k1); Last holds (v0, k0, p0) and (v0, k1, p1), which the
 *   probes store;
 * - **v1, a count grows:** Model counts 2 for (v0, k0) and Last gains (v0, k0, p1). Every constant of Last is new (its
 *   cells, its owner functions), the CHECK reads the new ones, the stored rows are kept, the new slot is admitted and the
 *   slot past the new count refused;
 * - **v2, a declared rename:** Position's p1 is renamed q1, which keeps its code: the CHECK reads exactly v1's functions,
 *   and every stored row is kept;
 * - **v3, the slot roster grows:** Position appends p3 with no count changing. A dependent space reads its slots'
 *   counts, never its slot roster's size, so the CHECK on Step reads exactly v2's functions; the product twin's key
 *   space grows with the roster, so its constant is new.
 *
 * Oracle: the versions' declarations, the codes a rename keeps (D1) and the content addressing of constants (a
 * constant's name digests what it installs), against PostgreSQL's catalog and verdicts.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Result } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { closedId, natural, pg, slot } from "#compiler/public/fields.ts"
import { closed, contained, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A relation's table and a field's column, as the naming door names them. */
const tableOf = (relationName: string): string =>
	identifierOf(identity.table(parsedName(relationName)))
const columnOf = (field: string): string => identifierOf(identity.column(parsedName(field)))

const Version = closed("Version", ["v0"])
const Kind = closed("Kind", ["k0", "k1"])

/** One version: Position's handles, Model's counts for (v0, k0) and (v0, k1), and Last's rows' slots. */
interface Stage {
	readonly positions: readonly [string, ...Array<string>]
	readonly counts: readonly [bigint, bigint]
	readonly rows: ReadonlyArray<readonly ["k0" | "k1", string]>
}

const stages: ReadonlyArray<Stage> = [
	{
		positions: ["p0", "p1", "p2"],
		counts: [1n, 2n],
		rows: [
			["k0", "p0"],
			["k1", "p1"]
		]
	},
	{
		positions: ["p0", "p1", "p2"],
		counts: [2n, 2n],
		rows: [
			["k0", "p0"],
			["k0", "p1"],
			["k1", "p1"]
		]
	},
	{
		positions: ["p0", "q1", "p2"],
		counts: [2n, 2n],
		rows: [
			["k0", "p0"],
			["k0", "q1"],
			["k1", "q1"]
		]
	},
	{
		positions: ["p0", "q1", "p2", "p3"],
		counts: [2n, 2n],
		rows: [
			["k0", "p0"],
			["k0", "q1"],
			["k1", "q1"]
		]
	}
]

/** The schema of a version under the declared name `name`. */
const schemaAt = (name: string, stage: Stage) => {
	const Position = closed("Position", stage.positions)
	const Model = closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		[
			{ version: "v0", parent: "k0", positions: stage.counts[0] },
			{ version: "v0", parent: "k1", positions: stage.counts[1] }
		]
	)
	const owner = { version: closedId(Version), parent: closedId(Kind) }
	const rows = Arr.map(stage.rows, ([parent, at]) => ({ version: "v0" as const, parent, at }))
	const Last = closed.relation(
		"Last",
		{ ...owner, at: slot(closedId(Position), fin(Model, "positions")) },
		["version", "parent", "at"],
		rows
	)
	const LastProduct = closed.relation(
		"LastProduct",
		{ ...owner, at: closedId(Position) },
		["version", "parent", "at"],
		rows
	)
	const probe = {
		id: pg.int4,
		version: closedId(Version),
		parent: closedId(Kind),
		at: closedId(Position)
	}
	const Step = relation("Step", probe, ["id"])
	const StepProduct = relation("StepProduct", probe, ["id"])
	return schema(name, { Version, Kind, Position, Model, Last, LastProduct, Step, StepProduct }, [
		contained(on(Step, "version", "parent", "at"), on(Last, "version", "parent", "at")),
		contained(
			on(StepProduct, "version", "parent", "at"),
			on(LastProduct, "version", "parent", "at")
		)
	])
}

/** What a version reads: the functions each probe's CHECK depends on, and each probe's rows. */
interface Observed {
	readonly step: ReadonlyArray<string>
	readonly stepProduct: ReadonlyArray<string>
	readonly rows: ReadonlyArray<string>
}

const values = (session: RawSession, sql: string) => Effect.orDie(session.values(sql, []))

layer(Substrate.layer)("dependent keys through grizzle's migrations on PostgreSQL 19rc1", (it) => {
	it.effect(
		"a changed count replaces every constant of its space, and a rename or a grown slot roster replaces none",
		() =>
			Effect.gen(function* () {
				const observed: Array<Observed> = []
				const verdicts: Array<ReadonlyArray<Option.Option<string>>> = []
				let schemaName = ""
				yield* migrated({
					label: "fin_migrations",
					schemaName: { kind: "unique" },
					first: (name) => {
						schemaName = name
						return { schema: schemaAt(name, defined(stages[0])), logins: [] }
					},
					later: Arr.map(stages.slice(1), (stage) => (name: string) => ({
						schema: schemaAt(name, stage),
						logins: []
					})),
					apply: { kind: "noPlaceholders" },
					register: false,
					declared: (v): Declarations =>
						v === 2
							? {
									renames: [
										{
											from: { kind: "handle", roster: parsedName("Position"), handle: "p1" },
											to: { kind: "handle", roster: parsedName("Position"), handle: "q1" }
										}
									],
									drops: []
								}
							: noDeclarations,
					observe: Option.some((v: number, owner: RawSession) =>
						Effect.gen(function* () {
							const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
							const table = (r: string) => `${quoteIdent(schemaIdent)}.${quoteIdent(tableOf(r))}`
							const reads = (r: string) =>
								Effect.map(
									values(
										owner,
										`SELECT p.proname::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid WHERE c.conrelid = '${table(r)}'::regclass AND c.contype = 'c' ORDER BY 1`
									),
									(rows) => Arr.map(rows, (row) => String(row[0]))
								)
							const insert = (r: string, id: number, parent: number, at: number) =>
								Effect.map(
									Effect.result(
										owner.query(
											`INSERT INTO ${table(r)} (${Arr.join(
												Arr.map(["id", "version", "parent", "at"], (f) => quoteIdent(columnOf(f))),
												", "
											)}) VALUES (${id}, 0::smallint, ${parent}::smallint, ${at}::smallint)`,
											[]
										)
									),
									(r) =>
										Result.match(r, {
											onSuccess: () => Option.none<string>(),
											onFailure: (e) =>
												Option.some(
													e.reason._tag === "ServerError" ? e.reason.fields.code : e.reason.message
												)
										})
								)
							const attempts =
								v === 0
									? [
											[1, 0, 0],
											[2, 1, 1]
										]
									: v === 1
										? [
												[3, 0, 1],
												[4, 0, 2]
											]
										: []
							const verdict: Array<Option.Option<string>> = []
							for (const [id, parent, at] of attempts) {
								const one = yield* insert("Step", defined(id), defined(parent), defined(at))
								verdict.push(one)
								yield* insert("StepProduct", defined(id), defined(parent), defined(at))
							}
							verdicts.push(verdict)
							const step = yield* reads("Step")
							const stepProduct = yield* reads("StepProduct")
							const stored = yield* values(
								owner,
								`SELECT ${quoteIdent(columnOf("id"))}::text || ':' || ${quoteIdent(columnOf("parent"))}::text || ':' || ${quoteIdent(columnOf("at"))}::text FROM ${table("Step")} ORDER BY 1`
							)
							observed.push({ step, stepProduct, rows: Arr.map(stored, (row) => String(row[0])) })
						})
					)
				})
				const v0 = defined(observed[0])
				const v1 = defined(observed[1])
				const v2 = defined(observed[2])
				const v3 = defined(observed[3])
				assert.deepEqual(verdicts[0], [Option.none(), Option.none()], "v0's rows are Last's keys")
				assert.deepEqual(
					verdicts[1],
					[Option.none(), Option.some("23514")],
					"v1 admits the grown count's new slot and refuses the slot past it"
				)
				assert.ok(v0.step.length >= 3, "Step's CHECK reads Last's cells and its owner functions")
				assert.ok(
					Arr.every(v1.step, (fn) => !v0.step.includes(fn)),
					"a grown count replaces every constant of the space: its cells, bases and counts"
				)
				assert.deepEqual(
					v2.step,
					v1.step,
					"a declared rename keeps every code, so every constant stands"
				)
				assert.deepEqual(
					v3.step,
					v2.step,
					"a grown slot roster changes no count, so the dependent space stands"
				)
				assert.notDeepEqual(
					v3.stepProduct,
					v2.stepProduct,
					"a grown roster widens the product's key space"
				)
				assert.deepEqual(
					v1.rows,
					["1:0:0", "2:1:1", "3:0:1"],
					"the stored rows are kept, and the new slot's"
				)
				assert.deepEqual(v3.rows, v1.rows, "the rename and the growth keep every stored row")
			})
	)
})
