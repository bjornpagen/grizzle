/**
 * A migration's Validate phase against existing and concurrent rows.
 *
 * A migration that installs or tightens a law validates the complete relevant state before it publishes the law, each
 * law a native constraint validated by PostgreSQL itself, a selected side's containment the foreign key from its STORED
 * generated column. So:
 *
 * - over violating rows, every kind of law refuses with its identity and leaves the rows exactly as they were, never an
 *   automatic deletion; the files before the failing one stay applied, and once the reviewer fixes the rows the apply
 *   resumes at it. The kinds: a candidate key, a row check, a containment and a selected side's one; a contract's
 *   predicate tightened, which is another definition and so another domain, named by its digest, the column converted
 *   to it by its cast with no placeholder, refused with 23514 by that domain's CHECK as the cast judges each stored
 *   value; a text pattern narrowed, which types the field by the narrowed pattern's domain, converted and refused the
 *   same way by that domain's CHECK; and a closed payload outside the narrowed pattern, written into Publish's
 *   validation of the closed facts by the reviewer, refused there with 23514 by the same CHECK, the folder as drafted
 *   then completing. The rows' keys and values are drawn;
 * - a writer racing the migration cannot slip a violation past a selected side's foreign key. The migration to the
 *   selected side's containment, drafted for an installation of v1 holding one worker, races two direct writers, each
 *   inserting one active assignment, of the stored worker or of a worker none holds: its Structure file adds the
 *   foreign key NOT VALID under its locks, which a writer's open insert holds the migration behind and a later writer
 *   waits on, and its validation sees every row committed before it. The property is the law itself, over every point
 *   of that box and every order of the five moves (each writer's insert and COMMIT, and the migration's apply): the
 *   migration succeeds only if no violating row was committed, and is refused otherwise, by the foreign key's
 *   validation with 23503 on the law; a lawful writer commits; a violating writer commits only before the law, and is
 *   refused by it with 23503 otherwise, always when it begins after the migration ended, never when it ended before
 *   the migration began; the rows are exactly the committed writers' and the stored worker, never deleted; and a
 *   transient abort, of a writer or the migration, has a concurrent cause. Each case installs afresh, since a
 *   migration applies once, and the order is drawn decision by decision from the case, which the exhaustion
 *   enumerates.
 *
 * The migrations are drafted by generateMigration from the installed snapshot and applied by applyOnSession, exactly as
 * `grizzle migrate` applies them, as the database owner; each folder is applied with the same files every time,
 * so a resumed apply finds the files it already ran unchanged.
 *
 * Oracle: the specification restated over the data each case constructs to violate every law once, read by the law
 * each refusal names (its constraint through the tightened version's laws, or its domain's CHECK); and, for the race,
 * the law itself over every committed row, judged on each interleaving of the five moves.
 *
 * Features: the race's ends (the migration succeeded, refused by the law or aborted), each waiting on the other, and a
 * violation committed before the law or refused by it.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): validate-rows-unvalidated (a CHECK added NOT VALID over stored rows is
 * never validated) and validate-race-unvalidated (a foreign key added NOT VALID over a table that may hold rows is never
 * validated).
 */

import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, increasing, int, shuffled } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrateError, MigrationPlace, ServerReport } from "#adapter/migrate/errors.ts"
import type { FolderSource, MigrationTarget } from "#adapter/migrate/input.ts"
import { reportedOwner } from "#adapter/witness/keylaw.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type ConstraintLaws, constraintLaw } from "#compiler/ir/products.ts"
import { constraintLawMap } from "#compiler/laws/model/model.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
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
import { folderSource, openMigrator, statementRows } from "#test/pg/migrate/support.ts"
import { keyGen } from "#test/schedules/write/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import {
	type ColumnTextDomain,
	installationNamesOf,
	lawIdOf,
	lawNamesOf,
	type Names,
	namesOf,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftCodes, fromSnapshot, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"
import { type GrizzleActor, openActors } from "#test/support/schedules/actors.ts"
import {
	allowed,
	everyRelation,
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	interleaveStep,
	refusedJudgment,
	runawayInterleavings,
	type Txn
} from "#test/support/schedules/interleave.ts"
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

import { regex } from "arkregex"
const label = str.regex("^[a-z]{0,8}$")
/**
 * The domains a version changes: an assignment's rate, a contract whose predicate the tightened version tightens from
 * 1000 to 100, a domain of its own by its definition, and a desk's code, a text pattern it narrows from seven letters to
 * three, which the closed relation FloorCode's payload shares (a pattern of its own, so its domain is no other field's),
 * each version's pattern a domain of its own.
 */
const domains = (tightened: boolean) => {
	const Rate = contract("Rate", pg.integer, (v) => v.le(tightened ? 100 : 1000))
	const code = tightened ? str.regex("^[a-z]{0,3}$") : str.regex("^[a-z]{0,7}$")
	const Worker = relation("Worker", { id: pg.integer, name: label }, ["id"])
	const Assignment = relation(
		"Assignment",
		{ id: pg.integer, worker: pg.integer, active: pg.boolean, hours: pg.integer, rate: Rate },
		["id"]
	)
	const Desk = relation("Desk", { id: pg.integer, code }, ["id"])
	const Badge = relation("Badge", { id: pg.integer, desk: pg.integer, issued: pg.boolean }, ["id"])
	const Floor = closed("Floor", ["Ground", "Top"])
	const FloorCode = closed.relation(
		"FloorCode",
		{ floor: closedId(Floor), code },
		["floor"],
		[
			{ floor: "Ground", code: "grd" },
			{ floor: "Top", code: "top" }
		]
	)
	return { Worker, Assignment, Desk, Badge, Floor, FloorCode }
}
const relations = Object.freeze(domains(false))
const { Worker, Assignment, Desk, Badge } = Object.freeze(relations)

/**
 * Every version's world is its full world (fullWorld): the role `app`, writing every relation, in
 * the login `server`, which the migration keeps and the racing writers act in.
 */
const v1 = (name: string) => schema(name, relations, [])
/** Every kind of law at once: a candidate key, a row check, a containment and a selected side's one. */
const workerName = key(on(Worker, "name"))
const nonNegative = check("NonNegativeHours", Assignment, (x) => x.ge(x.hours, 0))
const assignmentWorker = contained(on(Assignment, "worker"), on(Worker, "id"))
const issuedDesk = contained(
	on(
		select(Badge, (b) => b.eq(b.issued, true)),
		"desk"
	),
	on(Desk, "id")
)
const tightenedRelations = Object.freeze(domains(true))
const tightened = (name: string) => {
	const r = tightenedRelations
	return schema(name, r, [
		key(on(r.Worker, "name")),
		check("NonNegativeHours", r.Assignment, (x) => x.ge(x.hours, 0)),
		contained(on(r.Assignment, "worker"), on(r.Worker, "id")),
		contained(
			on(
				select(r.Badge, (b) => b.eq(b.issued, true)),
				"desk"
			),
			on(r.Desk, "id")
		)
	])
}
/** A selected side's containment alone. */
const staffing = contained(
	on(
		select(Assignment, (a) => a.eq(a.active, true)),
		"worker"
	),
	on(Worker, "id")
)
const staffed = (name: string) => schema(name, relations, [staffing])

/**
 * A version's complete installation under `schema`, owned by `owner`, with its full world, as `grizzle generate`
 * compiles it.
 */
const withWorld = (
	value: Parameters<typeof fullWorld>[0],
	schemaIdent: string,
	owner: string,
	codes: Codebook
) => {
	const owned = owning(value)
	const server = succeeded(
		ownLogin(defined(loginDescOf(fullWorld(value, {}).server), "a login value"))
	)
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(
				owned,
				[identity.schema(parsedSchemaName(schemaIdent))],
				[server],
				[],
				codes
			),
			owner
		})
	)
}

/** The migrator's backend, the one row pg_backend_pid answers. */
const backendOf = (rows: ReadonlyArray<ReadonlyArray<string>>): number =>
	Number(defined(rows[0]?.[0], "pg_backend_pid's row"))

/** The migrate apply's result. */
type Migrated = Result.Result<unknown, MigrateError>

/** A foreign key installed under `schema` whose law is `refusing`, as the installation's laws map its constraint. */
interface ForeignKeyLaw {
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
			constraintLaw(fk.laws, owner, server.error.constraint) === fk.refusing
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
			constraintLaw(fk.laws, owner, outcome.fields.constraint) === fk.refusing
			? meets(shown)
			: misses(shown, `expected SQLSTATE 23503 on ${fk.refusing}`)
	}

/** Installs v1, seeds it as the owner, and drafts the migration to `next` from the installed snapshot. */
const prepare = (
	next: (name: string) => Parameters<typeof fullWorld>[0],
	seed: (names: Names) => ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const declared = v1("Staff")
		const done = yield* install(declared, {
			ambient: ordinarySession,
			label: "real",
			logins: [fullWorld(declared, {}).server],
			extensions: []
		})
		const names = namesOf(done)
		for (const statement of seed(names)) {
			yield* s.admin.query(statement, [])
		}
		const installation = withWorld(
			next(done.schema),
			done.schema,
			s.owner.role,
			succeeded(draftCodes(next(done.schema), fromSnapshot(done.snapshot), noDeclarations))
		)
		const g = succeeded(
			generate({
				declared: noDeclarations,
				previous: fromSnapshot(done.snapshot),
				installation,
				name: "tighten",
				/**
				 * After the installing folder, whose fixed timestamp is 20261013000000.
				 */
				timestamp: "20261014000000",
				workload: noWorkload
			})
		)
		/** Every folder the schema has, the installing one as it ran, then the new one. */
		const drafted = folderSource(g.folder)
		const target: MigrationTarget = { snapshot: g.snapshot, folders: [...done.folders, drafted] }
		const migrator = yield* openMigrator(s, s.owner)
		const owner = (statement: string) => s.admin.query(statement, [])
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
					r: Badge,
					columns: Arr.map(["id", "desk", "issued"] as const, (f) => names.column(Badge, f))
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
		const writer = done.world(fullWorld(declared, {}).app)
		/** The names of the version the migration installs, under the installed schema. */
		const nextNames = installationNamesOf(installation)
		return { s, done, names, nextNames, g, drafted, target, migrator, owner, contents, writer }
	})

/** The columns of each relation, listed for a positional VALUES. */
const workerColumns = (names: Names) =>
	`${names.column(Worker, "id")}, ${names.column(Worker, "name")}`

const assignmentColumns = (names: Names) =>
	Arr.join(
		Arr.map(["id", "worker", "active", "hours", "rate"] as const, (c) =>
			names.column(Assignment, c)
		),
		", "
	)
const deskColumns = (names: Names) => `${names.column(Desk, "id")}, ${names.column(Desk, "code")}`

/** A refusal by a domain's CHECK as a cast to the domain judges a value: the domain and its constraint, at 23514. */
const domainCheck =
	(domain: ColumnTextDomain) =>
	(server: ServerReport): boolean =>
		server.by === "server" &&
		server.error.sqlstate === "23514" &&
		server.error.dataType === domain.domain &&
		server.error.constraint === domain.constraint

/** A file's text with Ground's payload written out of the narrowed pattern, as the reviewer edits the validation of the
 * closed facts. */
const narrowedPayload = (text: string): string => Str.replaceAll("'grd'", "'grounds'")(text)

/** What a racing writer inserts: an active assignment naming the stored worker, or one naming a worker none holds. */
type WriterKind = "lawful" | "violating"

/** The box the race exhausts: each racing writer's assignment. */
interface Racing {
	readonly w1: WriterKind
	readonly w2: WriterKind
}

const writerKinds = ["lawful", "violating"] as const

const racingGen: Gen<Racing> = (source) => ({
	w1: source.draw(element(writerKinds)),
	w2: source.draw(element(writerKinds))
})

/** The stored worker's id, the id no worker holds, and each writer's assignment's id. */
const storedWorker = 1
const missingWorker = 2
const assignmentOf: Readonly<Record<"w1" | "w2", number>> = { w1: 1, w2: 2 }

/**
 * What a race reached: how the migration ended, a migration that waited on a writer and a writer that waited on the
 * migration, and a violation committed before the law or refused by it.
 */
type RacingFeature =
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
const judgeRacing = (
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

const succeededStep: StepOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

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

layer(Substrate.layer, { excludeTestServices: true })("a migration's Validate phase", (it) => {
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
		return [
			wordOf(defined(x, "a name")),
			wordOf(defined(y, "a name")),
			wordOf(defined(z, "a name"))
		]
	}

	/**
	 * The violating rows: two workers sharing a name, an assignment of negative hours and one naming a worker none
	 * holds, a badge issued at a desk none holds, an assignment's rate inside the old contract and outside the
	 * tightened one, and a desk's code inside the old pattern and outside the narrowed one; the reviewer's fixes; and a
	 * later worker at the shared name.
	 */
	const violationsGen = (source: Source) => ({
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
	interface Refusing {
		readonly law: LawId
		readonly over: "rows" | "a payload"
		readonly reports: (server: ServerReport, place: MigrationPlace) => boolean
		readonly fix: string
	}
	const refusalName = (r: Refusing): string => `${r.law} over ${r.over}`

	/** The cases of the violating rows' rotating stream: each installs its version and applies until every law refused. */
	const violatingRuns = 4

	it.effect(
		"over violating rows every kind of law refuses with its identity and leaves the rows intact",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "every law the constructed data violates refuses once, by its identity, leaving the rows as they were, and holds once fixed"
						},
						suite: "schedules/migrate/validate violating rows",
						draw: drawn(violationsGen),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: violatingRuns,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: violatingRuns,
						caseHang
					},
					(v) =>
						Effect.scoped(
							Effect.gen(function* () {
								const [first, second, missing, later] = v.workers
								const [shared, renamed, fixedName] = v.names
								const [negative, positive] = v.hours
								const [negativeAssignment, orphanAssignment] = v.assignments
								const [desk, coded, laterDesk] = v.desks
								const x = yield* prepare(tightened, (names) => [
									`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${first}, '${shared}'), (${second}, '${shared}')`,
									`INSERT INTO ${names.table(Assignment)} (${assignmentColumns(names)}) VALUES (${negativeAssignment}, ${first}, true, ${negative}, 1), (${orphanAssignment}, ${missing}, false, ${positive}, ${v.rate})`,
									`INSERT INTO ${names.table(Badge)} (${names.column(Badge, "id")}, ${names.column(Badge, "desk")}, ${names.column(Badge, "issued")}) VALUES (${v.badge}, ${desk}, true)`,
									`INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${coded}, '${v.code}')`
								])
								const { names } = x
								const worker = names.table(Worker)
								/** The laws of the tightened version, which is not installed yet. */
								const next = tightened(x.done.schema)
								/**
								 * A table's law by what PostgreSQL names: its constraint or its key's index under the table PostgreSQL
								 * reports, which the tightened version's laws map to it (a candidate key's unique index fails its build in
								 * Indexes with 23505).
								 */
								const tightenedLaws = constraintLawMap(lawNamesOf(next).model.constraints)
								const reportsLaw =
									(id: LawId) =>
									(server: ServerReport): boolean => {
										if (server.by !== "server" || server.error.constraint === undefined) {
											return false
										}
										const owner = reportedOwner(server.error, new Set([names.schema]))
										return (
											owner !== undefined &&
											constraintLaw(tightenedLaws, owner, server.error.constraint) === id
										)
									}
								/**
								 * The narrowed pattern's domain, which types the desk's code and FloorCode's payload in the next version:
								 * one domain, since a pattern has one domain whatever uses it, and a closed relation has no table to name
								 * it by, its payload cast to the domain in Publish's validation of its facts, so Desk's column names it.
								 */
								const codeDomain = x.nextNames.textDomain(Desk, "code")
								const floorDomain = codeDomain
								/** Desk's code's pattern law, which names both of the domain's refusals, over its rows and its payload. */
								const codeLaw = x.nextNames.patternLaw(Desk, "code")
								/** The tightened contract's domain, which types the assignment's rate in the next version. */
								const rateDomain = x.nextNames.contract("Rate")
								if (rateDomain.kind !== "checked") {
									return assert.fail("the tightened contract Rate checks its predicate")
								}
								/**
								 * The reviewer writes Ground's payload out of the narrowed pattern into Publish's validation of the
								 * closed facts; restoring the folder as drafted is the fix. The file the edit changes is the one
								 * validating the closed facts.
								 */
								const drafted = x.drafted
								const payloadFiles = Arr.filter(
									drafted.files,
									(file) => narrowedPayload(file.text) !== file.text
								)
								assert.equal(
									payloadFiles.length,
									1,
									"Publish validates FloorCode's payloads in one file"
								)
								const payloadFile = defined(
									payloadFiles[0],
									"the file validating FloorCode's payloads"
								).name
								/** Whether a refusal is in the file validating the closed facts. */
								const inPayloadFile = (place: MigrationPlace): boolean =>
									(place.kind === "file" || place.kind === "statement") &&
									place.file === payloadFile
								/** The reviewer's data step for each law, which the migration never performs itself. */
								const fixes: ReadonlyArray<Refusing> = [
									{
										law: lawIdOf(next, workerName),
										over: "rows",
										reports: reportsLaw(lawIdOf(next, workerName)),
										fix: `UPDATE ${worker} SET ${names.column(Worker, "name")} = '${renamed}' WHERE ${names.column(Worker, "id")} = ${second}`
									},
									{
										law: lawIdOf(next, nonNegative),
										over: "rows",
										reports: reportsLaw(lawIdOf(next, nonNegative)),
										fix: `UPDATE ${names.table(Assignment)} SET ${names.column(Assignment, "hours")} = ${positive} WHERE ${names.column(Assignment, "id")} = ${negativeAssignment}`
									},
									{
										law: lawIdOf(next, assignmentWorker),
										over: "rows",
										reports: reportsLaw(lawIdOf(next, assignmentWorker)),
										fix: `INSERT INTO ${worker} (${workerColumns(names)}) VALUES (${missing}, '${fixedName}')`
									},
									{
										law: lawIdOf(next, issuedDesk),
										over: "rows",
										reports: reportsLaw(lawIdOf(next, issuedDesk)),
										fix: `INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${desk}, 'abc')`
									},
									{
										law: rateDomain.law,
										over: "rows",
										reports: (server, place) =>
											domainCheck(rateDomain)(server) && !inPayloadFile(place),
										fix: `UPDATE ${names.table(Assignment)} SET ${names.column(Assignment, "rate")} = 100 WHERE ${names.column(Assignment, "id")} = ${orphanAssignment}`
									},
									{
										law: codeLaw,
										over: "rows",
										reports: (server, place) =>
											domainCheck(codeDomain)(server) && !inPayloadFile(place),
										fix: `UPDATE ${names.table(Desk)} SET ${names.column(Desk, "code")} = 'abc' WHERE ${names.column(Desk, "id")} = ${coded}`
									}
								]
								const payloads = Arr.map(x.target.folders, (f): FolderSource =>
									f === drafted
										? {
												...f,
												files: Arr.map(f.files, (file) => ({
													...file,
													text: narrowedPayload(file.text)
												}))
											}
										: f
								)
								const payload: Refusing = {
									law: codeLaw,
									over: "a payload",
									reports: (server, place) =>
										domainCheck(floorDomain)(server) && inPayloadFile(place),
									fix: "restore the folder as drafted"
								}
								let target: MigrationTarget = { snapshot: x.target.snapshot, folders: payloads }
								const refused: Array<string> = []
								for (let round = 0; round <= fixes.length + 1; round++) {
									const before = yield* x.contents
									const result = yield* Effect.result(applyOnSession(x.migrator, [target]))
									if (result._tag === "Success") {
										break
									}
									const e = result.failure
									const server = e.server
									const found = Option.getOrThrowWith(
										Arr.findFirst([...fixes, payload], (f) => f.reports(server, e.place)),
										() =>
											new Error(
												`refused by no law this data violates: ${Formatter.format(server)}: ${e.message}`
											)
									)
									assert.ok(
										!refused.includes(refusalName(found)),
										`refused by a law this data violates, once: ${Formatter.format(server)}: ${e.message}`
									)
									refused.push(refusalName(found))
									const contents = yield* x.contents
									assert.deepEqual(
										contents,
										before,
										`the refusal by ${refusalName(found)} left the rows intact`
									)
									if (found === payload) {
										target = x.target
									} else {
										yield* x.owner(found.fix)
									}
								}
								unorderedEqual(
									refused,
									Arr.map([...fixes, payload], refusalName),
									"every law refused once where the data violates it"
								)
								yield* Effect.result(applyOnSession(x.migrator, [x.target]))
								const violation = yield* Effect.result(
									x.owner(
										`INSERT INTO ${worker} (${workerColumns(names)}) VALUES (${later}, '${shared}')`
									)
								)
								assert.equal(violation._tag, "Failure", "the candidate key is installed")
								const narrowed = yield* Effect.result(
									x.owner(
										`INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${laterDesk}, '${v.code}')`
									)
								)
								assert.equal(narrowed._tag, "Failure", "the narrowed pattern is installed")
							})
						)
				)
			)
	)

	it.effect(
		"a writer racing the migration cannot slip a violation past a selected side's foreign key",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each racing writer's assignment lawful or violating, under every order of the five moves",
						oracle: {
							kind: "specification",
							name: "the selected side's containment over every committed row: the migration succeeds only if no violation committed"
						},
						suite: "schedules/migrate/validate racing writers",
						generator: racingGen,
						literal: Formatter.format,
						coverage: requiredInSpace<RacingFeature>([
							"the migration succeeded",
							"the migration refused by the law",
							"the migration waited on a writer",
							"a writer waited on the migration",
							"a violation committed before the law",
							"a violation refused by the law"
						]),
						caseHang
					},
					(k, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const x = yield* prepare(staffed, (names) => [
									`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${storedWorker}, 'a')`
								])
								const { names } = x
								const fk: ForeignKeyLaw = {
									laws: constraintLawMap(lawNamesOf(staffed(x.done.schema)).model.constraints),
									schema: names.schema,
									refusing: lawIdOf(staffed(x.done.schema), staffing)
								}
								const direct = yield* openActors(x.s, {
									w1: { kind: "raw", as: x.writer },
									w2: { kind: "raw", as: x.writer }
								})
								const pid = yield* Effect.map(
									Effect.orDie(
										statementRows(x.migrator, "SELECT pg_catalog.pg_backend_pid()::text", [])
									),
									backendOf
								)
								const m: GrizzleActor = { name: "m", role: x.s.owner.role, pid }
								const env = yield* exploreEnv(x.s)
								const assignment = names.table(Assignment)
								const insertOf = (w: "w1" | "w2") =>
									`INSERT INTO ${assignment} (${assignmentColumns(names)}) VALUES (${assignmentOf[w]}, ${k[w] === "lawful" ? storedWorker : missingWorker}, true, 8, 1)`
								const migrated = new Map<"m", Migrated>()
								const txns: ReadonlyArray<Txn> = [
									...Arr.map(["w1", "w2"] as const, (w): Txn => ({
										kind: "direct",
										session: w,
										steps: [interleaveStep(insertOf(w), everyRelation)],
										end: "commit",
										after: undefined
									})),
									{
										kind: "grizzle",
										session: "m",
										steps: [
											{
												label: "migrate apply",
												outcome: Effect.map(
													Effect.result(applyOnSession(x.migrator, [x.target])),
													(r) => {
														migrated.set("m", r)
														return succeededStep
													}
												),
												footprint: everyRelation
											}
										],
										after: undefined
									}
								]
								const ids = (sql: string) =>
									Effect.map(env.observer.queryValues(sql, []), (rows) =>
										Arr.map(rows, (row) => String(row[0]))
									)
								yield* exploreInterleavings(
									env,
									{ direct, grizzle: { m } },
									{
										name: "a migration racing two writers",
										txns,
										reset: Effect.void,
										state: { _tag: "Unread" },
										model: (run) =>
											Effect.gen(function* () {
												const stored = {
													assignments: yield* ids(
														`SELECT ${names.column(Assignment, "id")}::text FROM ${assignment}`
													),
													workers: yield* ids(
														`SELECT ${names.column(Worker, "id")}::text FROM ${names.table(Worker)}`
													)
												}
												const judged = judgeRacing(
													k,
													fk,
													defined(migrated.get("m"), "the migration's result"),
													run,
													stored
												)
												if (Result.isFailure(judged)) {
													return refusedJudgment(judged.failure)
												}
												c.noteAll(judged.success)
												return allowed
											}),
										maxInterleavings: runawayInterleavings
									},
									{ kind: "drawn", nature: c }
								)
							})
						)
				)
			)
	)
})
