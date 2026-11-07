import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, pipe, type Scope, String as Str } from "effect"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import {
	installDerived,
	type Opened,
	type OracleFixtureFailed
} from "#test/pg/derived/oracle/harness.ts"
import { defined } from "#test/support/assert.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { type Names, namesOf, roleNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type GrizzleActor,
	grizzleActor,
	openActors,
	textOfValue
} from "#test/support/schedules/actors.ts"
import {
	type ExploreEnv,
	every,
	exploreEnv,
	relationsFootprint,
	type Strategy
} from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed,
	type SessionEnd
} from "#test/support/schedules/serial.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate, type TextRows } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

const derivedNames = ["StudentWeekly", "StudentTotal", "WeekBusy"] as const
export type DerivedName = (typeof derivedNames)[number]

/**
 * The derived levels the db.refresh races run on, under the declared name `name`, with its worlds.
 *
 * The shape is one base relation, Sitting, and three derived relations: StudentWeekly (sittings and passes per student
 * and week) and StudentTotal (sittings per student) at level 1, and WeekBusy (students per week, over StudentWeekly) at
 * level 2. Its roles:
 *
 * - `refresher` and `refresher2`, two grizzle refreshers in the login `server`, each a Db opened through a DbLayer of
 *   its own exactly as an application opens one, whose actor is the one session its Db's pool holds;
 * - in the login `psql`, which direct sessions log in as before they take on their role:
 *   - `holder`, a third refresher that a raw session takes on: inside its open transaction a REFRESH MATERIALIZED VIEW
 *     holds the view's lock, so the grizzle refreshers that meet it wait with snapshots taken before they waited;
 *   - `writer`, a direct SQL writer of Sitting, which also reads StudentWeekly;
 *   - `reader`, which reads the views.
 *
 * A world role reads a derived relation through its own view of it, in its own schema; the holder refreshes the
 * installation's materialized view.
 */
const build = (name: string) => {
	const Sitting = relation(
		"Sitting",
		{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
		["id"]
	)
	const Edu = schema(name, { Sitting }, [])
	const StudentWeekly = derived(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week, passed } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student, week, passed }).find({
				student,
				week,
				sittings: r.count(),
				passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
			})
		})
	)
	const StudentTotal = derived(
		"StudentTotal",
		query(Edu).rule((r) => {
			const { id, student } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student }).find({ student, total: r.count() })
		})
	)
	const Level1 = schema.extend(Edu, { StudentWeekly, StudentTotal }, [])
	const WeekBusy = derived(
		"WeekBusy",
		query(Level1).rule((r) => {
			const { student, week } = v(StudentWeekly, "studentWeekly")
			return r.match(StudentWeekly, { student, week }).find({ week, students: r.count() })
		})
	)
	const Reports = schema.extend(Level1, { WeekBusy }, [])
	const refresh = derivedNames
	const refresher = role(Reports, "refresher", wholeEntriesOf(Reports), { refresh })
	const refresher2 = role(Reports, "refresher2", wholeEntriesOf(Reports), { refresh })
	const holder = role(Reports, "holder", wholeEntriesOf(Reports), { refresh })
	const writer = role(Reports, "writer", { Sitting, StudentWeekly }, { write: ["Sitting"] })
	const reader = role(Reports, "reader", { StudentWeekly, StudentTotal, WeekBusy })
	return {
		Sitting,
		StudentWeekly,
		StudentTotal,
		WeekBusy,
		Reports,
		refresher,
		refresher2,
		holder,
		writer,
		reader,
		server: login(Reports, "server", [refresher, refresher2]),
		psql: login(Reports, "psql", [holder, writer, reader])
	}
}

/** Where the students' and the sittings' uuids start, and how far the weeks shift. */
export interface Labels {
	readonly student: number
	readonly sitting: number
	readonly week: number
}

/** The uuids' last group holds 48 bits; a race numbers its students and sittings below 0x100. */
export const labelsGen: Gen<Labels> = (source) => ({
	student: source.draw(int(0, 0xffff_ffff)),
	sitting: source.draw(int(0, 0xffff_ffff)),
	week: source.draw(int(-9999, 9999))
})

const uuidOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** A sitting: its number, its student's number, its week before the shift, and whether it passed. */
export interface Sat {
	readonly n: number
	readonly who: number
	readonly week: number
	readonly passed: boolean
}

export const sat = (n: number, who: number, week: number, passed: boolean): Sat => ({
	n,
	who,
	week,
	passed
})

/** Student 1 sat twice in week 1 (one pass) and once in week 2; student 2 once in week 1. */
export const initialSats: ReadonlyArray<Sat> = [
	sat(1, 1, 1, true),
	sat(2, 1, 1, false),
	sat(3, 1, 2, true),
	sat(4, 2, 1, true)
]

/**
 * The views and the base before a race: the views never refreshed, the base holding `stored`; or the views refreshed
 * over `viewed`, and the base changed to `stored` since.
 */
export type Initial =
	| { readonly kind: "unpopulated"; readonly stored: ReadonlyArray<Sat> }
	| {
			readonly kind: "populated"
			readonly viewed: ReadonlyArray<Sat>
			readonly stored: ReadonlyArray<Sat>
	  }

/** The raw refresher: none, or the view its transaction refreshes and so holds the lock of, and how it ends. */
export type Holder =
	| { readonly kind: "none" }
	| { readonly kind: "holds"; readonly view: DerivedName; readonly end: "commit" | "rollback" }

/** What the base writer's statement does: add sittings, or drop one. */
export type Change =
	| { readonly kind: "add"; readonly sats: Arr.NonEmptyReadonlyArray<Sat> }
	| { readonly kind: "drop"; readonly sat: Sat }

/** The base writer: none, or one transaction that may first read StudentWeekly, then makes its change, and commits. */
export type Writer =
	| { readonly kind: "none" }
	| { readonly kind: "writes"; readonly reads: boolean; readonly change: Change }

/** A grizzle refresher's one db.refresh call: the derived relations it names, in the order it names them. */
export type Call = Arr.NonEmptyReadonlyArray<DerivedName>

/**
 * A race of refreshes: the drawn labels, the initial state, the raw refresher, the grizzle refreshers' calls (the
 * second refresher's, when there are two), the base writer, and whether a reader reads every view in one transaction.
 */
export interface DerivedRace {
	readonly labels: Labels
	readonly initial: Initial
	readonly holder: Holder
	readonly calls: readonly [Call] | readonly [Call, Call]
	readonly writer: Writer
	readonly reader: boolean
}

/** The labeled values of a race's numbers. */
const labeled = (labels: Labels) => ({
	student: (n: number) => uuidOf(labels.student + n),
	sitting: (n: number) => uuidOf(labels.sitting + n),
	week: (w: number) => labels.week + w
})

/** What a derived relation's definition reads: Sitting at level 1, StudentWeekly at level 2. */
const inputOf = (name: DerivedName): string => (name === "WeekBusy" ? "StudentWeekly" : "Sitting")

/**
 * What a race reached: a call that waited on another session's lock, the two calls in flight together, each refusal
 * reason a call met, how each direct session ended, a reader's read issued while a call waited, and the strategy.
 */
export type DerivedFeature =
	| "a call waited"
	| "two calls in flight together"
	| "refused: SerializationFailure"
	| "refused: Deadlock"
	| "refused: ConcurrentRefresh"
	| `${"holder" | "writer" | "reader"} ${"committed" | "rolled back" | "aborted" | "failed"}`
	| "a read while a call waited"
	| "every order"
	| "pct"

/** A refusal reason a call met, as a feature; a reason no refresh meets is none. */
const refusedFeature = (reason: TransientTag): ReadonlyArray<DerivedFeature> => {
	switch (reason) {
		case "SerializationFailure":
			return ["refused: SerializationFailure"]
		case "Deadlock":
			return ["refused: Deadlock"]
		case "ConcurrentRefresh":
			return ["refused: ConcurrentRefresh"]
		case "PutTargetConflict":
		case "GeneratedSerialUnique":
		case "SpanKeyChange":
		case "UnseenOccupant":
		case "StaleStatement":
			return []
	}
}

const endWord = (end: SessionEnd<void>): "committed" | "rolled back" | "aborted" | "failed" => {
	switch (end.kind) {
		case "committed":
		case "answered":
			return "committed"
		case "rolled back":
			return "rolled back"
		case "aborted":
			return "aborted"
		case "failed":
			return "failed"
	}
}

const directSessions = ["holder", "writer", "reader"] as const

/** The features one explained run reached (see DerivedFeature). */
const featuresOf = (e: Explained<void>): ReadonlyArray<DerivedFeature> => {
	const calls = Arr.filter(
		e.run.moves,
		(m) => m.session === "refresher" || m.session === "refresher2"
	)
	const waitedCalls = Arr.filter(calls, (m) => m.observed._tag === "Waited")
	const [first, second] = [e.run.spans["refresher"], e.run.spans["refresher2"]]
	const together =
		first !== undefined &&
		second !== undefined &&
		first.start < second.end &&
		second.start < first.end
	const readWhileWaiting = Arr.some(
		Arr.filter(e.run.moves, (m) => m.session === "reader"),
		(read) =>
			Arr.some(
				waitedCalls,
				(call) =>
					call.issued < read.issued &&
					(call.result._tag === "Unfinished" || read.issued < call.result.at)
			)
	)
	const refusals = Arr.flatMap([...e.ends.values()], (end) =>
		end.kind === "answered" ? end.retried.refused : []
	)
	return [
		...(waitedCalls.length > 0 ? ["a call waited" as const] : []),
		...(together ? ["two calls in flight together" as const] : []),
		...(readWhileWaiting ? ["a read while a call waited" as const] : []),
		...Arr.flatMap(refusals, refusedFeature),
		...Arr.flatMap(directSessions, (session) => {
			const end = e.ends.get(session)
			return end === undefined ? [] : [`${session} ${endWord(end)}` as const]
		})
	]
}

/** An opened race installation: its names, its observer, its direct roles and the grizzle refreshers. */
interface Fixture {
	readonly opened: Opened
	readonly f: ReturnType<typeof build>
	readonly env: ExploreEnv
	readonly names: Names
	readonly refreshers: { readonly refresher: GrizzleActor; readonly refresher2: GrizzleActor }
	readonly refresh: (
		refresher: "refresher" | "refresher2",
		call: Call
	) => Effect.Effect<void, ApplyError>
}

/** Installs the shape with no sitting, and opens the two grizzle refreshers and the observer. */
const open: Effect.Effect<
	Fixture,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack | OpenError,
	Substrate | Scope.Scope
> = Effect.gen(function* () {
	const s = yield* Substrate
	const declared = build("Edu")
	const opened = yield* installDerived(declared.Reports, { Sitting: [] }, "dsched", [
		declared.server,
		declared.psql
	])
	const f = build(opened.installed.declared)
	const server = opened.installed.as(f.server).role
	const refresherContext = yield* Layer.build(loginLayer(opened.installed, f.server))
	const refresherDb = yield* Db.open(f.server.roles.refresher, {}).pipe(
		Effect.provideContext(refresherContext)
	)
	const first = yield* grizzleActor("refresher", server, [])
	const refresher2Context = yield* Layer.build(loginLayer(opened.installed, f.server))
	const refresher2Db = yield* Db.open(f.server.roles.refresher2, {}).pipe(
		Effect.provideContext(refresher2Context)
	)
	const refreshers = {
		refresher: first,
		refresher2: yield* grizzleActor("refresher2", server, [first.pid])
	}
	const values = {
		StudentWeekly: f.StudentWeekly,
		StudentTotal: f.StudentTotal,
		WeekBusy: f.WeekBusy
	}
	return {
		opened,
		f,
		env: yield* exploreEnv(s),
		names: namesOf(opened.installed),
		refreshers,
		refresh: (refresher, call) => {
			const named = Arr.map(call, (r) => values[r])
			const db = refresher === "refresher" ? refresherDb : refresher2Db
			return db.refresh(Arr.headNonEmpty(named), ...argumentsOf(Arr.tailNonEmpty(named)))
		}
	}
})

/** The SQL a race's sessions and its state read run, over one installation, for one race's labels. */
const sqlOf = (o: Fixture, labels: Labels) => {
	const l = labeled(labels)
	const column = (field: "id" | "student" | "week" | "passed") => o.names.column(o.f.Sitting, field)
	const sittings = o.names.table(o.f.Sitting)
	const writerView = (name: DerivedName) => roleNamesOf(o.opened.installed, o.f.writer).view(name)
	const readerView = (name: DerivedName) => roleNamesOf(o.opened.installed, o.f.reader).view(name)
	const weekly = (view: string) =>
		`SELECT 'StudentWeekly'::text AS "relation", "r1".${o.names.column(o.f.StudentWeekly, "student")}::text AS "a", "r1".${o.names.column(o.f.StudentWeekly, "week")}::text AS "b", "r1".${o.names.column(o.f.StudentWeekly, "sittings")}::text AS "c", "r1".${o.names.column(o.f.StudentWeekly, "passes")}::text AS "d" FROM ${view} AS "r1"`
	const totals = (view: string) =>
		`SELECT 'StudentTotal'::text AS "relation", "r1".${o.names.column(o.f.StudentTotal, "student")}::text AS "a", NULL::text AS "b", "r1".${o.names.column(o.f.StudentTotal, "total")}::text AS "c", NULL::text AS "d" FROM ${view} AS "r1"`
	const busy = (view: string) =>
		`SELECT 'WeekBusy'::text AS "relation", NULL::text AS "a", "r1".${o.names.column(o.f.WeekBusy, "week")}::text AS "b", "r1".${o.names.column(o.f.WeekBusy, "students")}::text AS "c", NULL::text AS "d" FROM ${view} AS "r1"`
	const readOf: Readonly<Record<DerivedName, (view: string) => string>> = {
		StudentWeekly: weekly,
		StudentTotal: totals,
		WeekBusy: busy
	}
	const values = (sats: Arr.NonEmptyReadonlyArray<Sat>) =>
		Arr.join(
			Arr.map(
				sats,
				(x) =>
					`('${l.sitting(x.n)}'::uuid, '${l.student(x.who)}'::uuid, ${l.week(x.week)}::int4, ${x.passed}::bool)`
			),
			", "
		)
	const insert = (sats: Arr.NonEmptyReadonlyArray<Sat>) =>
		`INSERT INTO ${sittings} (${column("id")}, ${column("student")}, ${column("week")}, ${column("passed")}) VALUES ${values(sats)}`
	return {
		facts: (sats: ReadonlyArray<Sat>) => ({
			Sitting: Arr.map(sats, (x) => ({
				id: l.sitting(x.n),
				student: l.student(x.who),
				week: l.week(x.week),
				passed: x.passed
			}))
		}),
		change: (change: Change): string =>
			change.kind === "add"
				? insert(change.sats)
				: `DELETE FROM ${sittings} WHERE ${column("id")} = '${l.sitting(change.sat.n)}'::uuid`,
		writerRead: weekly(writerView("StudentWeekly")),
		readerRead: Arr.join(
			Arr.map(derivedNames, (name) => readOf[name](readerView(name))),
			" UNION ALL "
		),
		refresh: (name: DerivedName, how: "concurrently" | "plain" | "with no data") =>
			how === "concurrently"
				? `REFRESH MATERIALIZED VIEW CONCURRENTLY ${o.opened.view(name)}`
				: how === "plain"
					? `REFRESH MATERIALIZED VIEW ${o.opened.view(name)}`
					: `REFRESH MATERIALIZED VIEW ${o.opened.view(name)} WITH NO DATA`,
		populated: (name: DerivedName) =>
			`SELECT c.relispopulated::text FROM pg_catalog.pg_class AS c WHERE c.oid = '${o.opened.view(name)}'::regclass`,
		viewRows: (name: DerivedName) => readOf[name](o.opened.view(name)),
		sittings: `SELECT 'Sitting'::text, "r1".${column("id")}::text, "r1".${column("student")}::text, "r1".${column("week")}::text, "r1".${column("passed")}::text FROM ${sittings} AS "r1"`
	}
}

/** A grizzle call's reach: each named view, and what its definition reads. */
const callFootprint = (call: Call) =>
	relationsFootprint(Arr.flatMap(call, (name) => [name, inputOf(name)]))

/** The moves a race makes when every move runs: a direct transaction's statements and its end, a call's one move. */
const movesOfRace = (txns: ReadonlyArray<RaceTxn<void>>): number =>
	Arr.reduce(txns, 0, (sum, t) => sum + (t.kind === "direct" ? t.statements.length + 1 : 1))

/** The largest race explored in every order; a larger one runs in the order a drawn PCT schedule gives. */
const everyOrderMoves = 6

/** The text rows of a query on the observer. */
const textRows = (o: Fixture, sql: string): Effect.Effect<TextRows, SqlError> =>
	Effect.map(o.env.observer.queryValues(sql, []), (rows) =>
		Arr.map(rows, (row) => Arr.map(row, textOfValue))
	)

/**
 * Runs one race on a fresh installation, every run judged by its serial reference (runSerialRace): the holder's
 * transaction, each call (retried after each TransientFailure until it answers), the writer's and the reader's
 * transactions, each placed in a serial order that respects real time, must show what they showed in the run, and
 * the state the run left (Sitting, and each view's rows or its being unpopulated) must be that order's.
 */
const runDerivedRace = (
	race: DerivedRace,
	c: Case<DerivedFeature>
): Effect.Effect<
	void,
	| OracleFixtureFailed
	| CompileError
	| SqlError
	| TransactionRolledBack
	| OpenError
	| PsqlProcessError
	| SerialRaceFailed,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const o = yield* open
		const sql = sqlOf(o, race.labels)
		const direct = yield* openActors(s, {
			holder: { kind: "raw", as: o.opened.installed.world(o.f.holder) },
			writer: { kind: "raw", as: o.opened.installed.world(o.f.writer) },
			reader: { kind: "raw", as: o.opened.installed.world(o.f.reader) }
		})
		const owner = (statements: ReadonlyArray<string>) =>
			Effect.forEach(statements, (x) => s.admin.query(x, []), { discard: true })
		const reset = Effect.provideService(
			Effect.gen(function* () {
				switch (race.initial.kind) {
					case "unpopulated":
						yield* replaceMigrated(o.opened.installed, sql.facts(race.initial.stored))
						yield* owner(Arr.map(derivedNames, (name) => sql.refresh(name, "with no data")))
						return
					case "populated":
						yield* replaceMigrated(o.opened.installed, sql.facts(race.initial.viewed))
						yield* owner(Arr.map(derivedNames, (name) => sql.refresh(name, "plain")))
						yield* replaceMigrated(o.opened.installed, sql.facts(race.initial.stored))
						return
				}
			}),
			Substrate,
			s
		)
		const state = Effect.gen(function* () {
			const sittings = yield* textRows(o, sql.sittings)
			const rows: Array<ReadonlyArray<string | null>> = [...sittings]
			for (const name of derivedNames) {
				const [flag] = yield* textRows(o, sql.populated(name))
				if (defined(flag, `${name}'s catalog row`)[0] === "true") {
					const viewed = yield* textRows(o, sql.viewRows(name))
					appendAll(rows, viewed)
				} else {
					rows.push([`${name} unpopulated`])
				}
			}
			return rows
		})
		const holder: ReadonlyArray<RaceTxn<void>> =
			race.holder.kind === "none"
				? []
				: [
						{
							kind: "direct",
							session: "holder",
							statements: [
								{
									sql: sql.refresh(
										race.holder.view,
										race.initial.kind === "populated" ? "concurrently" : "plain"
									),
									footprint: relationsFootprint([race.holder.view, inputOf(race.holder.view)])
								}
							],
							end: race.holder.end
						}
					]
		const [firstCall, secondCall] = race.calls
		const first: RaceTxn<void> = {
			kind: "grizzle",
			session: "refresher",
			label: `db.refresh(${Arr.join(firstCall, ", ")})`,
			call: o.refresh("refresher", firstCall),
			footprint: callFootprint(firstCall)
		}
		const second: ReadonlyArray<RaceTxn<void>> =
			secondCall === undefined
				? []
				: [
						{
							kind: "grizzle",
							session: "refresher2",
							label: `db.refresh(${Arr.join(secondCall, ", ")})`,
							call: o.refresh("refresher2", secondCall),
							footprint: callFootprint(secondCall)
						}
					]
		const writer: ReadonlyArray<RaceTxn<void>> =
			race.writer.kind === "none"
				? []
				: [
						{
							kind: "direct",
							session: "writer",
							statements: Arr.append(
								race.writer.reads
									? [{ sql: sql.writerRead, footprint: relationsFootprint(["StudentWeekly"]) }]
									: [],
								{ sql: sql.change(race.writer.change), footprint: relationsFootprint(["Sitting"]) }
							),
							end: "commit"
						}
					]
		const reader: ReadonlyArray<RaceTxn<void>> = race.reader
			? [
					{
						kind: "direct",
						session: "reader",
						statements: [{ sql: sql.readerRead, footprint: relationsFootprint(derivedNames) }],
						end: "commit"
					}
				]
			: []
		const txns: Arr.NonEmptyReadonlyArray<RaceTxn<void>> = [
			first,
			...second,
			...holder,
			...writer,
			...reader
		]
		const moves = movesOfRace(txns)
		const strategy: Strategy =
			moves <= everyOrderMoves
				? every
				: {
						kind: "pct",
						schedule: c.draw(
							pctSchedule(
								Arr.map(txns, (t) => t.session),
								3,
								moves
							)
						),
						nature: c
					}
		c.note(strategy.kind === "every" ? "every order" : "pct")
		yield* runSerialRace(
			o.env,
			{ direct, grizzle: o.refreshers },
			{ name: "a race of refreshes", txns, reset, state },
			strategy,
			(e) => c.noteAll(featuresOf(e))
		)
	})

/** The cases of each race suite's rotating stream; its floor runs a quarter of them. */
const derivedRuns = 4

/**
 * A suite of refresh races: its races drawn from `draw`, the kept races replayed first, and the situations its floor
 * and steered cases must reach.
 */
export const derivedRaceSuite = (spec: {
	readonly file: string
	readonly test: string
	readonly suite: string
	readonly draw: Gen<DerivedRace>
	readonly required: Situations<DerivedFeature>
	readonly kept: ReadonlyArray<Kept<DerivedRace, DerivedFeature>>
}): void => {
	layer(Substrate.layer, { excludeTestServices: true })(spec.file, (it) => {
		it.effect(spec.test, (ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: spec.suite,
						draw: drawn(spec.draw),
						literal: Formatter.format,
						coverage: required<DerivedFeature>(spec.required, {
							cases: derivedRuns,
							sense: notesOnly
						}),
						kept: spec.kept,
						runs: derivedRuns,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: derivedRuns,
						caseHang
					},
					(race, c) => Effect.scoped(runDerivedRace(race, c))
				)
			)
		)
	})
}

/** The sittings a race draws among: numbers 1 to 6, students 1 to 3, weeks 1 and 2. */
const satGen =
	(n: number): Gen<Sat> =>
	(source) =>
		sat(n, source.draw(int(1, 3)), source.draw(int(1, 2)), source.draw(boolean))

const satsGen: Gen<ReadonlyArray<Sat>> = (source) =>
	Arr.map(source.draw(subarray([1, 2, 3, 4, 5, 6])), (n) => source.draw(satGen(n)))

/** A change of the base: one or two sittings numbered 7 and 8 added, or one of `stored` dropped. */
export const changeGen =
	(stored: ReadonlyArray<Sat>): Gen<Change> =>
	(source) => {
		const [first, ...rest] = stored
		const add: Change = {
			kind: "add",
			sats: [source.draw(satGen(7)), ...(source.draw(boolean) ? [source.draw(satGen(8))] : [])]
		}
		return first === undefined || source.draw(boolean)
			? add
			: { kind: "drop", sat: source.draw(element([first, ...rest])) }
	}

/** The initial state: unpopulated views, or views refreshed over one drawn base and the base drawn again. */
export const initialGen =
	(populated: Gen<boolean>): Gen<Initial> =>
	(source) =>
		source.draw(populated)
			? { kind: "populated", viewed: source.draw(satsGen), stored: source.draw(satsGen) }
			: { kind: "unpopulated", stored: source.draw(satsGen) }

/**
 * A call that meets the view `held`: it names `held` or, for WeekBusy, what WeekBusy reads, beside other views drawn;
 * over unpopulated views a call naming WeekBusy names StudentWeekly too, which it reads.
 */
export const callGen =
	(held: DerivedName, initial: Initial): Gen<Call> =>
	(source) => {
		const named: Call = [
			held,
			...source.draw(subarray(Arr.filter(derivedNames, (name) => name !== held)))
		]
		return initial.kind === "unpopulated" &&
			named.includes("WeekBusy") &&
			!named.includes("StudentWeekly")
			? [...named, "StudentWeekly"]
			: named
	}

/** The view a holder holds: any view over populated views, a level 1 view over unpopulated ones. */
export const heldGen = (initial: Initial): Gen<DerivedName> =>
	initial.kind === "populated" ? element(derivedNames) : element(["StudentWeekly", "StudentTotal"])

export const endGen: Gen<"commit" | "rollback"> = element(["commit", "rollback"])
