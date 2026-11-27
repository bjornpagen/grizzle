/** What the properties of validate.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, increasing, int, shuffled } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Record as Rec, Result, String as Str } from "effect"
import type { MigrateError, MigrationPlace, ServerReport } from "#adapter/migrate/errors.ts"
import { reportedOwner } from "#adapter/witness/keylaw.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type ConstraintLaws, lawsOfConstraint } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { guardBracketTexts } from "#compiler/physical/ddl/immutable.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { openMigrator, type TextTarget, writtenTexts } from "#test/pg/migrate/support.ts"
import { keyGen } from "#test/schedules/write/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installFullWorld } from "#test/support/installed.ts"
import {
	type ColumnTextDomain,
	installationNamesOf,
	type Names,
	namesOf,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	draftedAt,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { owning } from "#test/support/policy.ts"
import type { Interleaving } from "#test/support/schedules/interleave.ts"
import {
	describeOutcome,
	describeStepOutcome,
	meets,
	misses
} from "#test/support/schedules/match.ts"
import type { Expectation, ScheduleOutcome, StepOutcome } from "#test/support/schedules/types.ts"
import { reportedOwnerOf } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

const label = str.regex("^[a-z]{0,8}$")

const rateKey = Symbol("Rate")
/**
 * The domains a version changes: an assignment's rate, a contract whose predicate the tightened version tightens from
 * 1000 to 100, a domain of its own by its definition, and a desk's code, a text pattern it narrows from seven letters to
 * three, which the closed relation FloorCode's payload shares (a pattern of its own, so its domain is no other field's),
 * each version's pattern a domain of its own.
 */
const domains = (tightened: boolean) => {
	const Rate = contract<typeof rateKey>()("Rate", pg.integer, (v) =>
		Logic.le(v, tightened ? 100 : 1000)
	)
	const code = tightened ? str.regex("^[a-z]{0,3}$") : str.regex("^[a-z]{0,7}$")
	const Worker = relation("Worker", { id: pg.integer, name: label }, ["id"])
	const Assignment = relation(
		"Assignment",
		{ id: pg.integer, worker: pg.integer, active: pg.boolean, hours: pg.integer, rate: Rate },
		["id"]
	)
	const Desk = relation("Desk", { id: pg.integer, code }, ["id"])
	const ValidatedBadge = relation(
		"ValidatedBadge",
		{ id: pg.integer, desk: pg.integer, issued: pg.boolean },
		["id"]
	)
	const Floor = closed.ordered("Floor", ["Ground", "Top"])
	const FloorCode = closed.relation(
		"FloorCode",
		{ floor: closedId(Floor), code },
		["floor"],
		[
			{ floor: "Ground", code: "grd" },
			{ floor: "Top", code: "top" }
		]
	)
	return { Worker, Assignment, Desk, ValidatedBadge, Floor, FloorCode }
}

const relations = Object.freeze(domains(false))

export const { Worker, Assignment, Desk, ValidatedBadge } = Object.freeze(relations)

/**
 * Every version's world is its full world (fullWorld): the role `app`, writing every relation, in
 * the login `server`, which the migration keeps and the racing writers act in.
 */
const v1 = (name: string) => schema(name, Rec.values(relations), [])

/** Every kind of law at once: a candidate key, a row check, a containment and a selected side's one. */
export const workerName = key(on(Worker, "name"))

export const nonNegative = check("NonNegativeHours", Assignment, (x) => x.ge(x.hours, 0))

export const assignmentWorker = contained(on(Assignment, "worker"), on(Worker, "id"))

export const issuedDesk = contained(
	on(
		select(ValidatedBadge, (b) => b.eq(b.issued, true)),
		"desk"
	),
	on(Desk, "id")
)

const tightenedRelations = Object.freeze(domains(true))

export const tightened = (name: string) => {
	const r = tightenedRelations
	return schema(name, Rec.values(r), [
		key(on(r.Worker, "name")),
		check("NonNegativeHours", r.Assignment, (x) => x.ge(x.hours, 0)),
		contained(on(r.Assignment, "worker"), on(r.Worker, "id")),
		contained(
			on(
				select(r.ValidatedBadge, (b) => b.eq(b.issued, true)),
				"desk"
			),
			on(r.Desk, "id")
		)
	])
}

/** A selected side's containment alone. */
export const staffing = contained(
	on(
		select(Assignment, (a) => a.eq(a.active, true)),
		"worker"
	),
	on(Worker, "id")
)

export const staffed = (name: string) => schema(name, Rec.values(relations), [staffing])

/**
 * A version's complete installation under `schema`, owned by `owner`, with its full world, as `grizzle generate`
 * compiles it.
 */
const withWorld = (
	value: Parameters<typeof fullWorld>[0],
	schemaIdent: string,
	codes: Codebook
) => {
	const owned = owning(value)
	const server = succeeded(
		ownLogin(defined(loginDescOf(fullWorld(value, {}, []).server), "a login value"))
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				[identity.schema(parsedSchemaName(schemaIdent))],
				[server],
				[],
				codes
			)
		)
	)
}

/** The migrator's backend, the one row pg_backend_pid answers. */
export const backendOf = (rows: ReadonlyArray<ReadonlyArray<string>>): number =>
	Number(defined(rows[0]?.[0], "pg_backend_pid's row"))

/** The migrate apply's result. */
export type Migrated = Result.Result<unknown, MigrateError>

/** A foreign key installed under `schema` whose law is `refusing`, as the installation's laws map its constraint. */
export interface ForeignKeyLaw {
	readonly laws: ConstraintLaws
	readonly schema: string
	readonly refusing: LawId
}

/** The apply refused by the foreign key of `fk.refusing`, 23503, which PostgreSQL's validation raised. */
const refusedBy =
	(fk: ForeignKeyLaw): Expectation<Migrated> =>
	(actual) => {
		const shown = Formatter.format(actual)
		if (Result.isSuccess(actual)) {
			return misses(shown, `expected the apply refused by ${fk.refusing}`)
		}
		const server = actual.failure.server
		if (server.by !== "server" || server.error.constraint === undefined) {
			return misses(shown, `expected the apply refused by ${fk.refusing}, by the server`)
		}
		const owner = reportedOwner(server.error, new Set([fk.schema]))
		return server.error.sqlstate === sqlstates.foreignKeyViolation &&
			owner !== undefined &&
			Arr.contains(lawsOfConstraint(fk.laws, owner, server.error.constraint) ?? [], fk.refusing)
			? meets(shown)
			: misses(shown, `expected the apply refused by ${fk.refusing} with SQLSTATE 23503`)
	}

/** A COMMIT refused by the foreign key of `fk.refusing`, 23503, deferred to it. */
const committedPast =
	(fk: ForeignKeyLaw): Expectation<ScheduleOutcome> =>
	(outcome) => {
		const shown = describeOutcome(outcome)
		if (outcome._tag !== "PgError" || outcome.fields.constraint === undefined) {
			return misses(shown, `expected SQLSTATE 23503 on ${fk.refusing}`)
		}
		const owner = reportedOwnerOf(outcome.fields)
		return outcome.fields.code === sqlstates.foreignKeyViolation &&
			owner !== undefined &&
			Arr.contains(lawsOfConstraint(fk.laws, owner, outcome.fields.constraint) ?? [], fk.refusing)
			? meets(shown)
			: misses(shown, `expected SQLSTATE 23503 on ${fk.refusing}`)
	}

/** Installs v1, seeds it as the owner, and drafts the migration to `next` from the installed snapshot. */
export const prepare = (
	next: (name: string) => Parameters<typeof fullWorld>[0],
	seed: (names: Names) => ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const declared = v1("Staff")
		const done = yield* installFullWorld(declared, {}, [], {
			ambient: ordinarySession,
			label: "real"
		})
		const names = namesOf(done)
		for (const statement of seed(names)) {
			yield* s.admin.query(statement, [])
		}
		const installation = withWorld(
			next(done.schema),
			done.schema,
			succeeded(draftCodes(next(done.schema), fromSnapshot(done.snapshot), noDeclarations))
		)
		const g = succeeded(
			generate({
				declared: noDeclarations,
				previous: fromSnapshot(done.snapshot),
				installation,
				name: "tighten",
				/** After the installing folders, on the tests' one clock (migrate/kit.ts draftedAt). */
				timestamp: draftedAt(done.folders.length),
				workload: noWorkload
			})
		)
		/** Every folder the schema has, the installing one as it ran, then the new one. */
		const drafted = writtenTexts(g.folder)
		const target: TextTarget = { snapshot: g.snapshot, folders: [...done.folders, drafted] }
		const migrator = yield* openMigrator(s, s.owner)
		const owner = (statement: string) => s.admin.query(statement, [])
		/**
		 * A person's data step between a refused migration's attempts, as the owner: `statement` in a transaction of its
		 * own inside the one bracket of the closed relations' removals over the installation's schema
		 * (physical/ddl/immutable.ts guardBracketTexts), whose guards refuse its DELETE anywhere else.
		 */
		const dataStep = (statement: string) => {
			const bracket = guardBracketTexts({ kind: "schemas", schemas: [names.schema] })
			return transaction(s.admin, [bracket.before, statement, bracket.after])
		}
		/**
		 * Every table's rows as text, sorted, as the owner: each row's declared fields, which a refusal must leave as they
		 * were, and none of the columns a law adds, such as a selected side's generated term, which a file before the
		 * refused one adds and keeps.
		 */
		const contents = Effect.gen(function* () {
			const out: Array<string> = []
			const declared = [
				{ r: Worker, columns: [names.column(Worker, "id"), names.column(Worker, "name")] },
				{
					r: Assignment,
					columns: Arr.map(["id", "worker", "active", "hours", "rate"] as const, (f) =>
						names.column(Assignment, f)
					)
				},
				{ r: Desk, columns: [names.column(Desk, "id"), names.column(Desk, "code")] },
				{
					r: ValidatedBadge,
					columns: Arr.map(["id", "desk", "issued"] as const, (f) =>
						names.column(ValidatedBadge, f)
					)
				}
			]
			for (const { r, columns } of declared) {
				const fields = Arr.join(
					Arr.map(columns, (c) => `t.${c}`),
					", "
				)
				const found = yield* s.admin.queryValues(
					`SELECT ROW(${fields})::text AS r FROM ${names.table(r)} AS t ORDER BY r`,
					[]
				)
				out.push(
					`${r.name}: ${Arr.join(
						Arr.map(found, (row) => String(row[0])),
						" "
					)}`
				)
			}
			return out
		})
		/** The world a direct writer acts in: the login's credentials and the role `app`. */
		const writer = done.world(fullWorld(declared, {}, []).app)
		/** The names of the version the migration installs, under the installed schema. */
		const nextNames = installationNamesOf(installation)
		return {
			s,
			done,
			names,
			nextNames,
			g,
			drafted,
			target,
			migrator,
			owner,
			dataStep,
			contents,
			writer
		}
	})

/** The columns of each relation, listed for a positional VALUES. */
export const workerColumns = (names: Names) =>
	`${names.column(Worker, "id")}, ${names.column(Worker, "name")}`

export const assignmentColumns = (names: Names) =>
	Arr.join(
		Arr.map(["id", "worker", "active", "hours", "rate"] as const, (c) =>
			names.column(Assignment, c)
		),
		", "
	)

export const deskColumns = (names: Names) =>
	`${names.column(Desk, "id")}, ${names.column(Desk, "code")}`

/**
 * A person's change of one field of one stored row, the reviewer's data step between a refused migration's attempts:
 * the row deleted and inserted again with the field's new value, in one statement, as an immutable relation's rows
 * change, whose guards refuse its UPDATE and its DELETE outside a data step, run inside the bracket of their removals
 * (prepare's dataStep). `columns` is the relation's every stored field, `key` its key column's value, `set` the field and
 * its value's SQL.
 */
export const rewrittenRow = (
	table: string,
	columns: ReadonlyArray<string>,
	key: { readonly column: string; readonly value: string },
	set: { readonly column: string; readonly value: string }
): string => {
	const listed = Arr.join(columns, ", ")
	const selected = Arr.join(
		Arr.map(columns, (c) => (c === set.column ? set.value : c)),
		", "
	)
	return `WITH gone AS (DELETE FROM ${table} WHERE ${key.column} = ${key.value} RETURNING ${listed}) INSERT INTO ${table} (${listed}) SELECT ${selected} FROM gone`
}

/** Each relation's stored fields' columns, in declared order: what a row deleted and inserted again carries. */
export const workerFields = (names: Names): ReadonlyArray<string> =>
	Arr.map(["id", "name"] as const, (c) => names.column(Worker, c))

export const assignmentFields = (names: Names): ReadonlyArray<string> =>
	Arr.map(["id", "worker", "active", "hours", "rate"] as const, (c) => names.column(Assignment, c))

export const deskFields = (names: Names): ReadonlyArray<string> =>
	Arr.map(["id", "code"] as const, (c) => names.column(Desk, c))

/** A refusal by a domain's CHECK as a cast to the domain judges a value: the domain and its constraint, at 23514. */
export const validatedDomainCheck =
	(domain: ColumnTextDomain) =>
	(server: ServerReport): boolean =>
		server.by === "server" &&
		server.error.sqlstate === "23514" &&
		server.error.dataType === domain.domain &&
		server.error.constraint === domain.constraint

/** A file's text with Ground's payload written out of the narrowed pattern, as the reviewer edits the validation of the
 * closed facts. */
export const narrowedPayload = (text: string): string => Str.replaceAll("'grd'", "'grounds'")(text)

/** What a racing writer inserts: an active assignment naming the stored worker, or one naming a worker none holds. */
type WriterKind = "lawful" | "violating"

/** The box the race exhausts: each racing writer's assignment. */
interface Racing {
	readonly w1: WriterKind
	readonly w2: WriterKind
}

const writerKinds = ["lawful", "violating"] as const

export const racingGen: Gen<Racing> = (source) => ({
	w1: source.draw(element(writerKinds)),
	w2: source.draw(element(writerKinds))
})

/** The stored worker's id, the id no worker holds, and each writer's assignment's id. */
export const storedWorker = 1

export const missingWorker = 2

export const assignmentOf: Readonly<Record<"w1" | "w2", number>> = { w1: 1, w2: 2 }

/**
 * What a race reached: how the migration ended, a migration that waited on a writer and a writer that waited on the
 * migration, and a violation committed before the law or refused by it.
 */
export type RacingFeature =
	| "the migration succeeded"
	| "the migration refused by the law"
	| "the migration aborted"
	| "the migration waited on a writer"
	| "a writer waited on the migration"
	| "a violation committed before the law"
	| "a violation refused by the law"

const transient = (code: string): boolean => code === "40001" || code === "40P01"

/** How the migration ended: it succeeded, the law refused it, it was aborted as a transient failure, or otherwise. */
const migrationEnd = (
	fk: ForeignKeyLaw,
	migrated: Migrated
): "succeeded" | "refused by the law" | "aborted" | undefined => {
	if (Result.isSuccess(migrated)) {
		return "succeeded"
	}
	if (refusedBy(fk)(migrated)._tag === "Meets") {
		return "refused by the law"
	}
	const server = migrated.failure.server
	return server.by === "server" && transient(server.error.sqlstate) ? "aborted" : undefined
}

/**
 * The law's judgment of one run (see the racing test): what it reached, or why the run broke the law.
 */
export const judgeRacing = (
	k: Racing,
	fk: ForeignKeyLaw,
	migrated: Migrated,
	run: Interleaving,
	stored: { readonly assignments: ReadonlyArray<string>; readonly workers: ReadonlyArray<string> }
): Result.Result<ReadonlyArray<RacingFeature>, string> => {
	const reached: Array<RacingFeature> = []
	const spanOf = (session: string) => defined(run.spans[session], `${session}'s span`)
	const overlapsAnother = (session: string): boolean =>
		Arr.some(
			Arr.filter(["w1", "w2", "m"] as const, (other) => other !== session),
			(other) =>
				spanOf(other).start < spanOf(session).end && spanOf(session).start < spanOf(other).end
		)
	const migration = migrationEnd(fk, migrated)
	if (migration === undefined) {
		return Result.fail(`the migration failed otherwise: ${Formatter.format(migrated)}`)
	}
	if (migration === "aborted" && !overlapsAnother("m")) {
		return Result.fail("the migration was aborted beside no writer")
	}
	reached.push(`the migration ${migration}`)
	const committed: Array<string> = []
	for (const w of ["w1", "w2"] as const) {
		const result = defined(run.results[w], `${w}'s result`)
		const violating = k[w] === "violating"
		const after = spanOf(w).start > spanOf("m").end && migration !== "aborted"
		const before = spanOf(w).end < spanOf("m").start
		switch (result._tag) {
			case "Committed":
				if (violating && after) {
					return Result.fail(`${w} committed a violation after the migration installed the law`)
				}
				committed.push(String(assignmentOf[w]))
				if (violating) {
					reached.push("a violation committed before the law")
				}
				break
			case "RolledBack":
				return Result.fail(`${w}'s COMMIT answered ROLLBACK`)
			case "Failed": {
				const failure = result.failure
				if (failure._tag !== "PgError") {
					return Result.fail(`${w} failed with ${describeStepOutcome(failure)}`)
				}
				if (transient(failure.fields.code)) {
					if (!overlapsAnother(w)) {
						return Result.fail(`${w} was aborted beside no other session`)
					}
					break
				}
				if (!violating || committedPast(fk)(failure)._tag !== "Meets") {
					return Result.fail(`${w} failed with ${describeStepOutcome(failure)}`)
				}
				if (before) {
					return Result.fail(`${w} met the law before the migration began`)
				}
				reached.push("a violation refused by the law")
				break
			}
		}
		if (violating && after && result._tag !== "Failed") {
			return Result.fail(`${w} arrived after the migration and was not refused by the law`)
		}
	}
	if (
		!unordered(stored.assignments, committed) ||
		!unordered(stored.workers, [String(storedWorker)])
	) {
		return Result.fail(
			`the rows are not what the committed writers left: assignments ${Formatter.format(stored.assignments)}, workers ${Formatter.format(stored.workers)}`
		)
	}
	const violated = Arr.some(
		["w1", "w2"] as const,
		(w) => k[w] === "violating" && committed.includes(String(assignmentOf[w]))
	)
	if (migration === "succeeded" && violated) {
		return Result.fail("the migration installed the law over a violating row a writer committed")
	}
	if (migration === "refused by the law" && !violated) {
		return Result.fail("the migration was refused by the law over no violating row")
	}
	if (Arr.some(run.moves, (m) => m.session === "m" && m.observed._tag === "Waited")) {
		reached.push("the migration waited on a writer")
	}
	if (
		Arr.some(
			run.moves,
			(m) => m.session !== "m" && m.observed._tag === "Waited" && m.observed.on.includes("m")
		)
	) {
		reached.push("a writer waited on the migration")
	}
	return Result.succeed(reached)
}

/** Two lists of texts that hold the same items. */
const unordered = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (x) => b.includes(x))

export const succeededStep: StepOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

/** The words of up to six lowercase letters, the empty one among them: 26^0 + 26^1 + ... + 26^6. */
const wordsUpToSix = Arr.reduce(Arr.range(0, 6), 0, (sum, length) => sum + 26 ** length)

/** The bijective base-26 word of `n`: "" for 0, "a" to "z" for 1 to 26, "aa" for 27, and so on, one word per number. */
const wordOf = (n: number): string => {
	let rest = n
	let word = ""
	while (rest > 0) {
		rest -= 1
		word = `${String.fromCharCode(0x61 + (rest % 26))}${word}`
		rest = Math.floor(rest / 26)
	}
	return word
}

/** A value of the name field, and keys apart from one another by construction: a first key and positive gaps. */
const gap = int(1, 99)

const apart2: Gen<readonly [number, number]> = (source) => {
	const k = source.draw(keyGen)
	return [k, k + source.draw(gap)]
}

const apart3: Gen<readonly [number, number, number]> = (source) => {
	const [k, a] = source.draw(apart2)
	return [k, a, a + source.draw(gap)]
}

const apart4: Gen<readonly [number, number, number, number]> = (source) => {
	const [k, a, b] = source.draw(apart3)
	return [k, a, b, b + source.draw(gap)]
}

/**
 * Three names apart, each a name of the field's pattern: three distinct whole numbers drawn in ascending order and
 * put in a drawn order, each spelled by its bijective base-26 word ("" for 0, "a" to "z", then "aa"), which is one
 * word per number, so the names differ by construction. Words of up to six letters, the most a range of whole
 * numbers spells.
 */
const distinctLabels: Gen<readonly [string, string, string]> = (source) => {
	const [a, b, c] = source.draw(increasing(0, wordsUpToSix - 1, { min: 3, max: 3 }))
	const [x, y, z] = source.draw(shuffled([a, b, c], { min: 3, max: 3 }))
	return [wordOf(defined(x, "a name")), wordOf(defined(y, "a name")), wordOf(defined(z, "a name"))]
}

/**
 * The violating rows: two workers sharing a name, an assignment of negative hours and one naming a worker none
 * holds, a badge issued at a desk none holds, an assignment's rate inside the old contract and outside the
 * tightened one, and a desk's code inside the old pattern and outside the narrowed one; the reviewer's fixes; and a
 * later worker at the shared name.
 */
export const violationsGen = (source: Source) => ({
	workers: source.draw(apart4),
	/** The shared name, the reviewer's rename, and the name of the worker the fix inserts: three apart. */
	names: source.draw(distinctLabels),
	assignments: source.draw(apart2),
	hours: [source.draw(int(-999, -1)), source.draw(int(0, 999))] as const,
	badge: source.draw(keyGen),
	/**
	 * The desk the badge names, which none holds; the desk whose code the narrowed pattern refuses; and a later
	 * one.
	 */
	desks: source.draw(apart3),
	rate: source.draw(int(101, 1000)),
	code: source.draw(matching(regex("^[a-z]{4,7}$")))
})

/**
 * A refusal the data earns, by the law it reports and where: a table's law by the constraint PostgreSQL names; the
 * tightened contract's law by its domain's CHECK a cast names, at 23514, over stored rows in the file converting the
 * column; the narrowed pattern's law the same way, over stored rows in the file converting the column and over a
 * closed payload in the file validating the closed facts. The pattern's law refuses twice, once over its rows and
 * once over the payload.
 */
export interface Refusing {
	readonly law: LawId
	readonly over: "rows" | "a payload"
	readonly reports: (server: ServerReport, place: MigrationPlace) => boolean
	readonly fix: string
}

export const refusalName = (r: Refusing): string => `${r.law} over ${r.over}`

/** The cases of the violating rows' rotating stream: each installs its version and applies until every law refused. */
export const violatingRuns = 4
