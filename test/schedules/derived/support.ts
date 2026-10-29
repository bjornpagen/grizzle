import { type Gen, int } from "@grizzle/testing/gen"
import { Array as Arr, Effect, Layer, Option, pipe, type Scope, String as Str } from "effect"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	installDerived,
	type Opened,
	type OracleFixtureFailed
} from "#test/pg/derived/oracle/harness.ts"
import { type Names, namesOf, roleNamesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type GrizzleActor, grizzleActor } from "#test/support/schedules/actors.ts"
import { type Retried, retried } from "#test/support/schedules/grizzle.ts"
import { type ExploreEnv, exploreEnv } from "#test/support/schedules/interleave.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

const derivedNames = ["StudentWeekly", "StudentTotal", "WeekBusy"] as const
type DerivedName = (typeof derivedNames)[number]

/**
 * Shared setup for the db.refresh schedules.
 *
 * The fixture is a shape of derived levels over one base relation, Sitting: two derived relations at level 1,
 * StudentWeekly (sittings and passes per student and week) and StudentTotal (sittings per student), and WeekBusy at
 * level 2 (students per week, over StudentWeekly). It installs under a fresh schema name with these roles:
 *
 * - `refresher` and `refresher2`, two grizzle refreshers in the login `server`, each a Db opened through a DbLayer of
 *   its own exactly as an application opens one. A grizzle actor's steps are db.refresh operations; the barrier watches
 *   the backend of the one session its Db's pool holds (the harness's `grizzleActor`), resolved one Db at a time, since
 *   both are sessions of one login;
 * - in the login `psql`, which direct sessions log in as before they take on their role:
 *   - `holder`, a third refresher that a raw session takes on: inside an open transaction its
 *     REFRESH MATERIALIZED VIEW CONCURRENTLY holds the view's EXCLUSIVE lock, which is how a schedule parks a grizzle
 *     refresh behind another refresher at a point it chooses;
 *   - `writer`, a direct SQL writer of Sitting, which also reads StudentWeekly;
 *   - `reader`, which reads the views.
 *
 * A world role reads a derived relation through its own view of it, in its own schema (`seen`); the holder refreshes,
 * and the judge reads, the installation's materialized view (`view`).
 *
 * grizzle makes one attempt per call, so a refresh operation retries a TransientFailure on the caller's side, as an
 * application does (the harness's `retried`), and its judge states the refusal history. What a refresh must leave is
 * each named view fresh (`freshSql`), never the statements it ran, and what a reader sees of a view is the host model
 * of its definition over the sittings of the snapshot the view was refreshed at (`weeklyRows`, `totalRows`,
 * `busyRows`).
 *
 * A schedule's sittings are a fixed shape, the one its window needs, relabeled by drawn labels (`labelsGen`): where the
 * students' and sittings' uuids start and how far the weeks shift. Each schedule is a planted property over them.
 *
 * The derived-levels shape under the declared name `name`, with its worlds (see the header).
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
			const { id, student, week, passed } = v(Sitting)
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
			const { id, student } = v(Sitting)
			return r.match(Sitting, { id, student }).find({ student, total: r.count() })
		})
	)
	const Level1 = schema.extend(Edu, { StudentWeekly, StudentTotal }, [])
	const WeekBusy = derived(
		"WeekBusy",
		query(Level1).rule((r) => {
			const { student, week } = v(StudentWeekly)
			return r.match(StudentWeekly, { student, week }).find({ week, students: r.count() })
		})
	)
	const Reports = schema.extend(Level1, { WeekBusy }, [])
	const refresh = derivedNames
	const refresher = role(Reports, "refresher", Reports.relations, { refresh })
	const refresher2 = role(Reports, "refresher2", Reports.relations, { refresh })
	const holder = role(Reports, "holder", Reports.relations, { refresh })
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

/** The uuids' last group holds 48 bits; a schedule numbers its students and sittings below 0x100. */
export const labelsGen: Gen<Labels> = (source) => ({
	student: source.draw(int(0, 0xffff_ffff)),
	sitting: source.draw(int(0, 0xffff_ffff)),
	week: source.draw(int(-9999, 9999))
})

const uuidOf = (n: number) =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** A sitting of the shape: its number, its student's number, its week before the shift, and whether it passed. */
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
export const initial: ReadonlyArray<Sat> = [
	sat(1, 1, 1, true),
	sat(2, 1, 1, false),
	sat(3, 1, 2, true),
	sat(4, 2, 1, true)
]

/** The labeled values of a shape's numbers. */
const labeled = (labels: Labels) => ({
	student: (n: number) => uuidOf(labels.student + n),
	sitting: (n: number) => uuidOf(labels.sitting + n),
	week: (w: number) => labels.week + w
})

type Row = ReadonlyArray<string>

/**
 * The host model of each view as the text rows its query (`weekly`, `studentTotals`, `weekBusy`) reads: StudentWeekly
 * counts each student's sittings and passes per week, StudentTotal each student's sittings, and WeekBusy the students
 * StudentWeekly holds per week.
 */
const grouped = <T, K>(
	items: ReadonlyArray<T>,
	keyOf: (item: T) => K,
	same: (a: K, b: K) => boolean
) => {
	const groups: Array<{ readonly key: K; readonly members: Array<T> }> = []
	for (const item of items) {
		const key = keyOf(item)
		const group = Arr.findFirst(groups, (g) => same(g.key, key))
		if (Option.isSome(group)) {
			group.value.members.push(item)
		} else {
			groups.push({ key, members: [item] })
		}
	}
	return groups
}

export const weeklyRows = (labels: Labels, sats: ReadonlyArray<Sat>): ReadonlyArray<Row> => {
	const l = labeled(labels)
	return Arr.map(
		grouped(
			sats,
			(s) => [s.who, s.week] as const,
			(a, b) => a[0] === b[0] && a[1] === b[1]
		),
		(g) => [
			l.student(g.key[0]),
			String(l.week(g.key[1])),
			String(g.members.length),
			String(Arr.filter(g.members, (s) => s.passed).length)
		]
	)
}

export const totalRows = (labels: Labels, sats: ReadonlyArray<Sat>): ReadonlyArray<Row> =>
	Arr.map(
		grouped(
			sats,
			(s) => s.who,
			(a, b) => a === b
		),
		(g) => [labeled(labels).student(g.key), String(g.members.length)]
	)

export const busyRows = (labels: Labels, sats: ReadonlyArray<Sat>): ReadonlyArray<Row> =>
	Arr.map(
		grouped(
			Arr.map(
				grouped(
					sats,
					(s) => [s.who, s.week] as const,
					(a, b) => a[0] === b[0] && a[1] === b[1]
				),
				(g) => g.key[1]
			),
			(week) => week,
			(a, b) => a === b
		),
		(g) => [String(labeled(labels).week(g.key)), String(g.members.length)]
	)

/** The two grizzle refreshers. */
export type Refresher = "refresher" | "refresher2"

/** A derived relation's view as one reader reads it, schema-qualified and quoted. */
type ViewOf = (name: DerivedName) => string

export interface Fixture {
	readonly labels: Labels
	readonly opened: Opened
	readonly f: ReturnType<typeof build>
	readonly env: ExploreEnv
	/** The installation's names of the base relation and the derived relations. */
	readonly names: Names
	/** The materialized view of a derived relation and the base table, schema-qualified and quoted. */
	readonly view: ViewOf
	readonly sittings: string
	/** The direct roles, as a direct actor takes each on. */
	readonly direct: {
		readonly holder: SubstrateWorld
		readonly writer: SubstrateWorld
		readonly reader: SubstrateWorld
	}
	/** The view each direct reader reads a derived relation through: its role's own, schema-qualified and quoted. */
	readonly seen: { readonly writer: ViewOf; readonly reader: ViewOf }
	/** The grizzle refreshers as schedule actors, each resolved once. */
	readonly refreshers: { readonly [I in Refresher]: GrizzleActor }
	/** A refresher's refresh operation, retried on the caller's side. */
	readonly refresh: (
		refresher: Refresher,
		...relations: ReadonlyArray<DerivedName>
	) => Effect.Effect<Retried<void>, ApplyError>
	readonly owner: (...sql: ReadonlyArray<string>) => Effect.Effect<void, SqlError>
}

/** Installs the fixture with the initial sittings, labeled, and opens the two grizzle refreshers. */
export const open = (
	labels: Labels
): Effect.Effect<
	Fixture,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack | OpenError,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const l = labeled(labels)
		const facts = {
			Sitting: Arr.map(initial, (x) => ({
				id: l.sitting(x.n),
				student: l.student(x.who),
				week: l.week(x.week),
				passed: x.passed
			}))
		}
		const declared = build("Edu")
		const opened = yield* installDerived(declared.Reports, facts, "dsched", [
			declared.server,
			declared.psql
		])
		const f = build(opened.installed.declared)
		const server = opened.installed.as(f.server).role
		/**
		 * Each refresher's Db through a DbLayer of its own, as an application opens it, and its actor: the one session
		 * of the login beside the refreshers resolved before it.
		 */
		const refresherDb = yield* Db.open(f.server.roles.refresher, {}).pipe(
			Effect.provideContext(yield* Layer.build(loginLayer(opened.installed, f.server)))
		)
		const first = yield* grizzleActor("refresher", server, [])
		const refresher2Db = yield* Db.open(f.server.roles.refresher2, {}).pipe(
			Effect.provideContext(yield* Layer.build(loginLayer(opened.installed, f.server)))
		)
		const refreshers = {
			refresher: first,
			refresher2: yield* grizzleActor("refresher2", server, [first.pid])
		}
		const env = yield* exploreEnv(s)
		const values = {
			StudentWeekly: f.StudentWeekly,
			StudentTotal: f.StudentTotal,
			WeekBusy: f.WeekBusy
		}
		const refresh = (
			refresher: Refresher,
			...relations: Arr.NonEmptyReadonlyArray<DerivedName>
		) => {
			const named = Arr.map(relations, (r) => values[r])
			switch (refresher) {
				case "refresher":
					return retried(refresherDb.refresh(...named))
				case "refresher2":
					return retried(refresher2Db.refresh(...named))
			}
		}
		const names = namesOf(opened.installed)
		return {
			labels,
			opened,
			f,
			env,
			names,
			view: (name) => opened.view(name),
			sittings: names.table(f.Sitting),
			direct: {
				holder: opened.installed.world(f.holder),
				writer: opened.installed.world(f.writer),
				reader: opened.installed.world(f.reader)
			},
			seen: {
				writer: (name) => roleNamesOf(opened.installed, f.writer).view(name),
				reader: (name) => roleNamesOf(opened.installed, f.reader).view(name)
			},
			refreshers,
			refresh,
			owner: (...sql) => Effect.forEach(sql, (x) => s.admin.query(x, []), { discard: true })
		}
	})

/**
 * `SELECT 't'` when the view holds exactly its definition's rows (its conservative lowering), 'f'
 * otherwise, as multisets.
 */
export const freshSql = (o: Fixture, name: DerivedName): string => {
	const { sql, columns } = o.opened.definition(name)
	const stored = `SELECT ${Arr.join(o.opened.columns(name), ", ")} FROM ${o.view(name)} AS "r1"`
	const defined = `SELECT ${Arr.join(
		Arr.map(columns, (c) => `"r1".${quoteIdent(c)}`),
		", "
	)} FROM (${sql}) AS "r1"`
	return `SELECT (count(*) = 0)::text AS "fresh" FROM ((${stored} EXCEPT ALL ${defined}) UNION ALL (${defined} EXCEPT ALL ${stored})) AS "d"`
}

export const refreshSql = (o: Fixture, name: DerivedName, concurrently: boolean): string =>
	`REFRESH MATERIALIZED VIEW${concurrently ? " CONCURRENTLY" : ""} ${o.view(name)}`

export const addSitting = (o: Fixture, x: Sat): string => {
	const l = labeled(o.labels)
	const column = (field: "id" | "student" | "week" | "passed") => o.names.column(o.f.Sitting, field)
	return `INSERT INTO ${o.sittings} (${column("id")}, ${column("student")}, ${column("week")}, ${column("passed")}) VALUES ('${l.sitting(x.n)}'::uuid, '${l.student(x.who)}'::uuid, ${l.week(x.week)}::int4, ${x.passed}::bool)`
}

export const dropSitting = (o: Fixture, x: Sat): string =>
	`DELETE FROM ${o.sittings} WHERE ${o.names.column(o.f.Sitting, "id")} = '${labeled(o.labels).sitting(x.n)}'::uuid`

/**
 * The text rows of each view read through `view`, as its host model states them (`weeklyRows`, `totalRows`,
 * `busyRows`).
 */
export const studentTotals = (o: Fixture, view: ViewOf): string =>
	`SELECT "r1".${o.names.column(o.f.StudentTotal, "student")}::text, "r1".${o.names.column(o.f.StudentTotal, "total")}::text FROM ${view("StudentTotal")} AS "r1"`

export const weekBusy = (o: Fixture, view: ViewOf): string =>
	`SELECT "r1".${o.names.column(o.f.WeekBusy, "week")}::text, "r1".${o.names.column(o.f.WeekBusy, "students")}::text FROM ${view("WeekBusy")} AS "r1"`

export const weekly = (o: Fixture, view: ViewOf): string =>
	`SELECT "r1".${o.names.column(o.f.StudentWeekly, "student")}::text, "r1".${o.names.column(o.f.StudentWeekly, "week")}::text, "r1".${o.names.column(o.f.StudentWeekly, "sittings")}::text, "r1".${o.names.column(o.f.StudentWeekly, "passes")}::text FROM ${view("StudentWeekly")} AS "r1"`
