/**
 * Writers below SERIALIZABLE are refused (README, "Direct SQL access"): every grizzle table's statement guard raises
 * 25000, naming the table, for a write in a transaction below SERIALIZABLE, before the statement writes a row, so the
 * transaction commits nothing; at SERIALIZABLE the guard admits the same statement.
 *
 * Property: for every planted direct writer, the model's outcome, exhaustively over the writer's level (READ
 * UNCOMMITTED, READ COMMITTED, REPEATABLE READ, and SERIALIZABLE as the control), its role (a world role taken on
 * through its login, or the schema's owner), its statement (an INSERT, an UPDATE, a DELETE of a stored fact, a zero-row
 * DELETE, a TRUNCATE, a MERGE that inserts and deletes or updates) and its relation (the immutable Item, the mutable
 * Note):
 * - a privilege the role lacks refuses first, at every level, since PostgreSQL checks privileges before any trigger
 *   fires: a world role's TRUNCATE (granted to no one) and its UPDATE of an immutable relation are 42501;
 * - otherwise, below SERIALIZABLE, 25000 with the table's schema and name, and COMMIT answers ROLLBACK;
 * - otherwise the statement applies, and its COMMIT commits what the model's state says.
 * The state is read back after each case, so a refusal that wrote anyway, or a control that was refused, fails. Oracle:
 * the README's refusal table, as a total table over the named cases (expectationOf). TRUNCATE is planted on Note alone:
 * Ref's foreign key into Item refuses a TRUNCATE of Item (0A000) before any trigger, whatever the level.
 */

import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { Item, Note, type Opened, open } from "#test/schedules/write/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { type DirectActor, openActors } from "#test/support/schedules/actors.ts"
import { begin, beginBelow, check, commit, schedule, sql } from "#test/support/schedules/build.ts"
import { meets, misses, ok, rolledBack, rowSet } from "#test/support/schedules/match.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { type Expectation, type ScheduleOutcome } from "#test/support/schedules/types.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Level = BelowSerializable | "serializable"
type Role = "execution" | "owner"
type StatementKind = "insert" | "update" | "delete" | "zero-row delete" | "truncate" | "merge"
type Target = "Item" | "Note"

interface BelowCase {
	readonly level: Level
	readonly role: Role
	readonly statement: StatementKind
	readonly target: Target
}

const levels: Arr.NonEmptyReadonlyArray<Level> = [
	"read uncommitted",
	"read committed",
	"repeatable read",
	"serializable"
]
const roles: Arr.NonEmptyReadonlyArray<Role> = ["execution", "owner"]
const statementKinds: Arr.NonEmptyReadonlyArray<StatementKind> = [
	"insert",
	"update",
	"delete",
	"zero-row delete",
	"truncate",
	"merge"
]
const targets: Arr.NonEmptyReadonlyArray<Target> = ["Item", "Note"]

/** The relations a TRUNCATE is planted on: Note alone (see the header). */
const truncated: Arr.NonEmptyReadonlyArray<Target> = ["Note"]

const cases: Arr.NonEmptyReadonlyArray<BelowCase> = Arr.flatMap(levels, (level) =>
	Arr.flatMap(roles, (role) =>
		Arr.flatMap(statementKinds, (statement) =>
			Arr.map(statement === "truncate" ? truncated : targets, (target): BelowCase => ({
				level,
				role,
				statement,
				target
			}))
		)
	)
)

/** Every named case, as a generator the exhaustive check enumerates whole: the same space as `cases`. */
const belowCaseGen: Gen<BelowCase> = (source) => {
	const level = source.draw(element(levels))
	const role = source.draw(element(roles))
	const statement = source.draw(element(statementKinds))
	const target = source.draw(element(statement === "truncate" ? truncated : targets))
	return { level, role, statement, target }
}

/** Each relation holds one fact at key 1, labelled "a", before every case. */
type Rows = ReadonlyArray<readonly [string, string]>
const stored: Rows = [["1", "a"]]

/** What a case's statement must do: refused by a privilege, refused by the guard, or applied, leaving these rows. */
type Expected =
	| { readonly kind: "privilege" }
	| { readonly kind: "guard" }
	| { readonly kind: "applies"; readonly rows: Rows }

/** The rows a statement leaves of the relation it writes. */
const appliedRows = (c: BelowCase): Rows => {
	switch (c.statement) {
		case "insert":
			return [...stored, ["2", "b"]]
		case "update":
			return [["1", "z"]]
		case "delete":
		case "truncate":
			return []
		case "zero-row delete":
			return stored
		case "merge":
			return c.target === "Item" ? [] : [["1", "z"]]
	}
}

/** The README's table (see the header). */
const expectationOf = (c: BelowCase): Expected => {
	const privileged =
		c.role === "execution" &&
		(c.statement === "truncate" || (c.statement === "update" && c.target === "Item"))
	if (privileged) {
		return { kind: "privilege" }
	}
	if (c.level !== "serializable") {
		return { kind: "guard" }
	}
	return { kind: "applies", rows: appliedRows(c) }
}

const statementOf = (o: Opened, c: BelowCase): string => {
	const r = c.target === "Item" ? Item : Note
	const t = o.names.table(r)
	const id = o.names.column(r, "id")
	const label = o.names.column(r, "label")
	switch (c.statement) {
		case "insert":
			return `INSERT INTO ${t} (${id}, ${label}) VALUES (2, 'b')`
		case "update":
			return `UPDATE ${t} SET ${label} = 'z' WHERE ${id} = 1`
		case "delete":
			return `DELETE FROM ${t} WHERE ${id} = 1`
		case "zero-row delete":
			return `DELETE FROM ${t} WHERE ${id} = 9`
		case "truncate":
			return `TRUNCATE ${t}`
		case "merge":
			return `MERGE INTO ${t} AS t USING (VALUES (1, 'z')) AS s (id, label) ON t.${id} = s.id WHEN MATCHED THEN ${c.target === "Item" ? "DELETE" : `UPDATE SET ${label} = s.label`} WHEN NOT MATCHED THEN INSERT (${id}, ${label}) VALUES (s.id, s.label)`
	}
}

/** 25000 naming the written table, by its schema and name. */
const guardRefusal =
	(o: Opened, c: BelowCase): Expectation<ScheduleOutcome> =>
	(outcome) => {
		const shown =
			outcome._tag === "PgError" ? `${outcome.fields.code} ${outcome.fields.message}` : outcome._tag
		if (outcome._tag !== "PgError" || outcome.fields.code !== "25000") {
			return misses(shown, "expected 25000")
		}
		const table = o.names.tableIdent(c.target === "Item" ? Item : Note)
		return Option.contains(outcome.fields.schema, o.names.schema) &&
			Option.contains(outcome.fields.table, table)
			? meets(shown)
			: misses(shown, `expected the refusal to name ${o.names.schema}.${table}`)
	}

const privilegeRefusal: Expectation<ScheduleOutcome> = (outcome) =>
	outcome._tag === "PgError" && outcome.fields.code === "42501"
		? meets(outcome.fields.message)
		: misses(outcome._tag, "expected 42501, a privilege the role lacks")

type BelowFeature = `${Level} ${Role} ${StatementKind} ${Target}`

layer(Substrate.layer, { excludeTestServices: true })("writers below SERIALIZABLE", (it) => {
	it.effect(
		"are refused with 25000 naming the table, after any privilege refusal, and commit nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* open
					const actors: Readonly<Record<Role, DirectActor>> = yield* Effect.map(
						openActors(s, {
							execution: { kind: "raw", as: o.rig.direct },
							owner: { kind: "raw", as: s.owner }
						}),
						(opened) => ({ execution: opened.execution, owner: opened.owner })
					)
					const rowsOf = (r: typeof Item | typeof Note) =>
						`SELECT ${o.names.column(r, "id")}::text, ${o.names.column(r, "label")}::text FROM ${o.names.table(r)}`
					return yield* exhaust(
						{
							suite: "schedules/write/below",
							generator: belowCaseGen,
							literal: Formatter.format,
							limit: cases.length,
							coverage: requiredInSpace<BelowFeature>(
								Arr.map(
									cases,
									(c): BelowFeature => `${c.level} ${c.role} ${c.statement} ${c.target}`
								)
							),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								k.note(`${c.level} ${c.role} ${c.statement} ${c.target}`)
								yield* o.rig.replace(
									Arr.map(
										[Item, Note],
										(r) =>
											`INSERT INTO ${o.names.table(r)} (${o.names.column(r, "id")}, ${o.names.column(r, "label")}) VALUES (1, 'a')`
									)
								)
								const expected = expectationOf(c)
								const written: Rows = expected.kind === "applies" ? expected.rows : stored
								yield* runSchedule(
									o.rig.env,
									schedule(`${c.level} ${c.role} ${c.statement} ${c.target}`, [
										c.level === "serializable" ? begin("w") : beginBelow("w", c.level),
										sql(
											"w",
											statementOf(o, c),
											expected.kind === "privilege"
												? privilegeRefusal
												: expected.kind === "guard"
													? guardRefusal(o, c)
													: ok()
										),
										commit("w", expected.kind === "applies" ? ok() : rolledBack()),
										check(rowsOf(Item), rowSet(c.target === "Item" ? written : stored)),
										check(rowsOf(Note), rowSet(c.target === "Note" ? written : stored))
									]),
									{ direct: { w: actors[c.role] }, grizzle: {} }
								)
							})
					)
				})
			)
	)
})
