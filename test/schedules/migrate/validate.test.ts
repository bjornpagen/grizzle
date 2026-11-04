/**
 * A migration's Validate phase against existing and concurrent rows.
 *
 * A migration that installs or tightens a law validates the complete relevant state before it publishes the law: a
 * native constraint through its own validation, a residual law through its full violation query in the Validate
 * transaction that also creates its triggers, under a lock excluding every writer to the participating tables. So:
 *
 * - over violating rows, every kind of law refuses with its identity and leaves the rows exactly as they were, never an
 *   automatic deletion; the files before the failing one stay applied, and once the reviewer fixes the rows the apply
 *   resumes at it. The kinds: a candidate key, a row check, a native containment and a residual one; a contract's
 *   predicate tightened, its domain changed in place, whose VALIDATE refuses with 23514 naming the column it found
 *   violating (PostgreSQL's VALIDATE of a domain constraint names the table and column, never the constraint); a text
 *   pattern narrowed, which types the field by the narrowed pattern's domain, the column converted to it by its cast
 *   with no placeholder, refused with 23514 by that domain's CHECK as the cast judges each stored value; and a closed
 *   payload outside the narrowed pattern, written into Publish's validation of the closed facts by the reviewer,
 *   refused there with 23514 by the same CHECK, the folder as drafted then completing;
 * - a writer racing Validate cannot slip a violation past it: a violating row a writer commits while the migration
 *   waits for it is seen by the full violation query, and a writer that arrives while the Validate transaction holds
 *   its lock waits until the law's triggers are installed, then meets the law at its commit.
 *
 * The migrations are drafted by generateMigration from the installed snapshot and applied by applyOnSession, exactly as
 * `grizzle migrate` applies them, as the database owner; each folder is applied with the same files every time,
 * so a resumed apply finds the files it already ran unchanged. The rows' keys and values are drawn.
 */

import { layer } from "@effect/vitest"
import { filter, type Gen, int } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import type { Source } from "@grizzle/testing/source"
import { Array as Arr, Effect, Formatter, Option, Result, Schema, String as Str } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrateError, MigrationPlace, ServerReport } from "#adapter/migrate/errors.ts"
import type { FolderSource, MigrationTarget } from "#adapter/migrate/input.ts"
import { reportedOwner } from "#adapter/witness/keylaw.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { contract, pg } from "#compiler/public/fields.ts"
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
	installationNamesOf,
	lawIdOf,
	lawNamesOf,
	type Names,
	namesOf,
	parsedSchemaName,
	type TextDomainNames
} from "#test/support/kernel/naming.ts"
import { fromSnapshot, generate } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"
import { type GrizzleActor, openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksOn,
	check as checkRows,
	commit,
	complete,
	op,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import { law, meets, misses, ok, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { type Expectation } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

import { regex } from "arkregex"
const label = str.regex("^[a-z]{0,8}$")
/**
 * The domains a version changes: an assignment's rate, a contract whose predicate the tightened version tightens from
 * 1000 to 100 in place, and a desk's code, a text pattern it narrows from seven letters to three, which the closed
 * relation Floor's payload shares (a pattern of its own, so its domain is no other field's), each version's pattern a
 * domain of its own.
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
	const Floor = closed("Floor", ["Ground", "Top"]).with(
		{ code },
		{ Ground: { code: "grd" }, Top: { code: "top" } }
	)
	return { Worker, Assignment, Desk, Badge, Floor }
}
const relations = domains(false)
const { Worker, Assignment, Desk, Badge, Floor } = relations

/**
 * Every version's world is its full world (fullWorld): the role `app`, writing every relation, in
 * the login `server`, which the migration keeps and the racing writers act in.
 */
const v1 = (name: string) => schema(name, relations, [])
/** Every kind of law at once: a candidate key, a row check, a native containment and a residual one. */
const workerName = key(Worker, ["name"])
const nonNegative = check("NonNegativeHours", Assignment, (x) => x.ge(x.hours, 0))
const assignmentWorker = contained(on(Assignment, "worker"), on(Worker, "id"))
const issuedDesk = contained(on(select(Badge, { issued: true }), "desk"), on(Desk, "id"))
const tightenedRelations = domains(true)
const tightened = (name: string) => {
	const r = tightenedRelations
	return schema(name, r, [
		key(r.Worker, ["name"]),
		check("NonNegativeHours", r.Assignment, (x) => x.ge(x.hours, 0)),
		contained(on(r.Assignment, "worker"), on(r.Worker, "id")),
		contained(on(select(r.Badge, { issued: true }), "desk"), on(r.Desk, "id"))
	])
}
/** A residual law alone. */
const staffing = contained(on(select(Assignment, { active: true }), "worker"), on(Worker, "id"))
const staffed = (name: string) => schema(name, relations, [staffing])

/**
 * A version's complete installation under `schema`, owned by `owner`, with its full world, as `grizzle generate`
 * compiles it.
 */
const withWorld = (value: Parameters<typeof fullWorld>[0], schemaIdent: string, owner: string) => {
	const owned = owning(value)
	const server = succeeded(ownLogin(defined(loginDescOf(fullWorld(value).server), "a login value")))
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(
				owned,
				identity.schema(parsedSchemaName(schemaIdent)),
				[server],
				[]
			),
			owner
		})
	)
}

/** The migrator's backend, the one row pg_backend_pid answers. */
const decodeBackend = (found: unknown) =>
	Effect.orDie(
		Schema.decodeUnknownEffect(Schema.Tuple([Schema.Tuple([Schema.FiniteFromString])]))(found)
	)

/** The migrate apply's result as a step's expectation: it succeeded, or it was refused by `refusing` at Validate. */
type Migrated = Result.Result<unknown, MigrateError>
const migrated: Expectation<Migrated> = (actual) => {
	const shown = Formatter.format(actual)
	return Result.isSuccess(actual) ? meets(shown) : misses(shown, "expected the apply to succeed")
}

const refusedBy =
	(refusing: LawId): Expectation<Migrated> =>
	(actual) => {
		const shown = Formatter.format(actual)
		if (Result.isSuccess(actual)) {
			return misses(shown, `expected the apply refused by ${refusing}`)
		}
		const server = actual.failure.server
		return server.by === "server" &&
			server.error.constraint === refusing &&
			server.error.sqlstate === "23000"
			? meets(shown)
			: misses(shown, `expected the apply refused by ${refusing} with SQLSTATE 23000`)
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
			logins: [fullWorld(declared).server],
			extensions: []
		})
		const names = namesOf(done)
		for (const statement of seed(names)) {
			yield* s.admin.query(statement, [])
		}
		const installation = withWorld(next("Staff"), done.schema, s.owner.role)
		const g = succeeded(
			generate({
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
		/** Every table's rows as text, sorted, as the owner. */
		const contents = Effect.gen(function* () {
			const out: Array<string> = []
			for (const r of [Worker, Assignment, Desk, Badge]) {
				const found = yield* s.admin.queryValues(
					`SELECT t::text FROM ${names.table(r)} AS t ORDER BY t::text`,
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
		const writer = done.world(fullWorld(declared).app)
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

/** A refusal by a text domain's CHECK as a cast to the domain judges a value: the domain and its constraint, at 23514. */
const domainCheck =
	(domain: TextDomainNames) =>
	(server: ServerReport): boolean =>
		server.by === "server" &&
		server.error.sqlstate === "23514" &&
		server.error.dataType === domain.domain &&
		server.error.constraint === domain.constraint

/** A file's text with Ground's payload written out of the narrowed pattern, as the reviewer edits the validation of the
 * closed facts. */
const narrowedPayload = (text: string): string => Str.replaceAll("'grd'", "'grounds'")(text)

/** The column a domain's VALIDATE found violating: its table and column, at 23514. */
const violated =
	(table: string, column: string) =>
	(server: ServerReport): boolean =>
		server.by === "server" &&
		server.error.sqlstate === "23514" &&
		server.error.constraint === undefined &&
		server.error.table === table &&
		server.error.column === column

layer(Substrate.layer, { excludeTestServices: true })("a migration's Validate phase", (it) => {
	/** A value of the name field, and keys apart from one another by construction: a first key and positive gaps. */
	const labelGen = matching(regex("^[a-z]{0,8}$"))
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
	const apart5: Gen<readonly [number, number, number, number, number]> = (source) => {
		const [k, a, b, c] = source.draw(apart4)
		return [k, a, b, c, c + source.draw(gap)]
	}
	const threeLabels: Gen<readonly [string, string, string]> = (source) => [
		source.draw(labelGen),
		source.draw(labelGen),
		source.draw(labelGen)
	]

	/**
	 * The violating rows: two workers sharing a name, an assignment of negative hours and one naming a worker none
	 * holds, a badge issued at a desk none holds, an assignment's rate inside the old contract and outside the
	 * tightened one, and a desk's code inside the old pattern and outside the narrowed one; the reviewer's fixes; and a
	 * later worker at the shared name.
	 */
	const violationsGen = (source: Source) => ({
		workers: source.draw(apart4),
		/** The shared name, the reviewer's rename, and the name of the worker the fix inserts: three apart. */
		names: source.draw(filter(threeLabels, (n) => new Set(n).size === n.length, 100)),
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
	 * A refusal the data earns, by the law it reports and where: a table's law by the constraint PostgreSQL names; a
	 * contract's law over stored rows by the column its VALIDATE found violating, at 23514, which names no constraint;
	 * the narrowed pattern's law by its domain's CHECK a cast names, at 23514, over stored rows in the file converting
	 * the column and over a closed payload in the file validating the closed facts. The pattern's law refuses twice,
	 * once over its rows and once over the payload.
	 */
	interface Refusing {
		readonly law: LawId
		readonly over: "rows" | "a payload"
		readonly reports: (server: ServerReport, place: MigrationPlace) => boolean
		readonly fix: string
	}
	const refusalName = (r: Refusing): string => `${r.law} over ${r.over}`

	it.effect(
		"over violating rows every kind of law refuses with its identity and leaves the rows intact",
		planted("validate/violating rows", violationsGen, [], (v) =>
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
				 * A table's law by what PostgreSQL names: a native one by its constraint or its key's index under the
				 * table PostgreSQL reports, which the tightened version's laws map to it (a candidate key's unique index
				 * fails its build in Indexes with 23505), a residual one by its identity, which its violation check
				 * raises as the constraint.
				 */
				const tightenedLaws = lawNamesOf(next).model.constraintToLaw
				const reportsLaw =
					(id: LawId) =>
					(server: ServerReport): boolean => {
						if (server.by !== "server" || server.error.constraint === undefined) {
							return false
						}
						const owner = reportedOwner(server.error, names.schema)
						return (
							server.error.constraint === id ||
							(owner !== undefined &&
								constraintLaw(tightenedLaws, owner, server.error.constraint) === id)
						)
					}
				/** The narrowed pattern's domain, which types the desk's code and Floor's payload in the next version. */
				const codeDomain = x.nextNames.textDomain(Desk, "code")
				const floorDomain = x.nextNames.textDomain(Floor, "code")
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
				assert.equal(payloadFiles.length, 1, "Publish validates Floor's payloads in one file")
				const payloadFile = defined(payloadFiles[0], "the file validating Floor's payloads").name
				/** Whether a refusal is in the file validating the closed facts. */
				const inPayloadFile = (place: MigrationPlace): boolean =>
					(place.kind === "file" || place.kind === "statement") && place.file === payloadFile
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
						law: names.contract("Rate").law,
						over: "rows",
						reports: violated(names.tableIdent(Assignment), names.columnIdent(Assignment, "rate")),
						fix: `UPDATE ${names.table(Assignment)} SET ${names.column(Assignment, "rate")} = 100 WHERE ${names.column(Assignment, "id")} = ${orphanAssignment}`
					},
					{
						law: codeDomain.law,
						over: "rows",
						reports: (server, place) => domainCheck(codeDomain)(server) && !inPayloadFile(place),
						fix: `UPDATE ${names.table(Desk)} SET ${names.column(Desk, "code")} = 'abc' WHERE ${names.column(Desk, "id")} = ${coded}`
					}
				]
				const payloads = Arr.map(x.target.folders, (f): FolderSource =>
					f === drafted
						? {
								...f,
								files: Arr.map(f.files, (file) => ({ ...file, text: narrowedPayload(file.text) }))
							}
						: f
				)
				const payload: Refusing = {
					law: floorDomain.law,
					over: "a payload",
					reports: (server, place) => domainCheck(floorDomain)(server) && inPayloadFile(place),
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
					assert.deepEqual(
						yield* x.contents,
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
					x.owner(`INSERT INTO ${worker} (${workerColumns(names)}) VALUES (${later}, '${shared}')`)
				)
				assert.equal(violation._tag, "Failure", "the candidate key is installed")
				const narrowed = yield* Effect.result(
					x.owner(
						`INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${laterDesk}, '${v.code}')`
					)
				)
				assert.equal(narrowed._tag, "Failure", "the narrowed pattern is installed")
				return []
			})
		)
	)

	/**
	 * The stored worker; the workers a violation names, the first fixed by the reviewer's data step later; the worker a
	 * writer inserts while Validate holds its lock; and the assignments' keys.
	 */
	const raceGen = (source: Source) => ({
		workers: source.draw(apart5),
		names: source.draw(threeLabels),
		assignments: source.draw(apart3),
		hours: source.draw(int(0, 999))
	})

	it.effect(
		"a writer racing Validate cannot slip a violation past the law's full check and triggers",
		planted(
			"validate/racing writer",
			raceGen,
			[
				"a violation committed while the migration waits is refused by its Validate",
				"a writer arriving during Validate waits for the law and meets it"
			],
			(v) =>
				Effect.gen(function* () {
					const [stored, fixed, second, arriving, never] = v.workers
					const [storedName, fixedName, arrivingName] = v.names
					const [firstAssignment, secondAssignment, lateAssignment] = v.assignments
					const x = yield* prepare(staffed, (names) => [
						`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${stored}, '${storedName}')`
					])
					const { names } = x
					const staffingLaw = lawIdOf(staffed(x.done.schema), staffing)
					const env = yield* exploreEnv(x.s)
					const direct = yield* openActors(x.s, {
						w1: { kind: "psql", as: x.writer },
						w2: { kind: "psql", as: x.writer }
					})
					const [[pid]] = yield* decodeBackend(
						yield* Effect.orDie(
							statementRows(x.migrator, "SELECT pg_catalog.pg_backend_pid()::text", [])
						)
					)
					const m: GrizzleActor = { name: "m", role: x.s.owner.role, pid }
					const actors = { direct, grizzle: { m } }
					const apply = applyOnSession(x.migrator, [x.target])
					const assignment = names.table(Assignment)
					const insertAssignment = (id: number, worker: number) =>
						`INSERT INTO ${assignment} (${assignmentColumns(names)}) VALUES (${id}, ${worker}, true, ${v.hours}, 1)`

					/**
					 * A violating row a writer commits while the migration waits for it is seen by the full violation
					 * query.
					 */
					const committed = yield* runSchedule(
						env,
						schedule("a violation committed while the migration waits is refused by its Validate", [
							begin("w1"),
							sql("w1", insertAssignment(firstAssignment, fixed), ok(), complete),
							op("m", "migrate apply", apply, refusedBy(staffingLaw), blocksOn("w1")),
							commit("w1", ok(), complete),
							awaits("m", complete),
							checkRows(`SELECT count(*)::text FROM ${assignment}`, rows(["1"])),
							sql("w2", insertAssignment(secondAssignment, second), ok(), complete)
						]),
						actors
					)

					yield* x.owner(
						`DELETE FROM ${assignment} WHERE ${names.column(Assignment, "id")} = ${secondAssignment}`
					)
					yield* x.owner(
						`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${fixed}, '${fixedName}')`
					)
					const arrived = yield* runSchedule(
						env,
						schedule("a writer arriving during Validate waits for the law and meets it", [
							begin("w1"),
							sql(
								"w1",
								`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${arriving}, '${arrivingName}')`,
								ok(),
								complete
							),
							op("m", "migrate apply", apply, migrated, blocksOn("w1")),
							begin("w2"),
							sql("w2", insertAssignment(lateAssignment, never), ok(), blocksOn("m")),
							commit("w1", ok(), complete),
							awaits("m", complete),
							awaits("w2", complete),
							commit("w2", law(staffingLaw, "23000"), complete),
							checkRows(
								`SELECT count(*)::text FROM ${assignment} WHERE ${names.column(Assignment, "worker")} = ${never}`,
								rows(["0"])
							)
						]),
						actors
					)
					return [committed, arrived]
				})
		)
	)
})
