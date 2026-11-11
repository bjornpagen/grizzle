/**
 * The scripted session (test/support/flight/scripted.ts) against PostgreSQL, so the double the unit fuzzer trusts
 * (test/unit/adapter/batch.test.ts) cannot drift from the server: the same flight cases, restricted to what the server
 * can be made to answer on demand, run on the scripted session and on a real one, and the two must observe the same.
 *
 * On the server, a statement's rows are an INSERT ... RETURNING of its label, or a SELECT of it inside a read's
 * transaction, which cannot write; a doomed statement inserts a row whose deferred reference has no target, so its
 * transaction's COMMIT, or its own Sync when it runs alone, is refused 23503; a refused one calls a function that raises
 * its SQLSTATE; a held one sleeps until a CancelRequest stops it. BEGIN is always answered and COMMIT's connection
 * kept: a refused BEGIN, a FATAL report and a lost connection are the server's and the network's faults, out of scope.
 *
 * Each case runs uninterrupted when it can complete, and interrupted after every number of answers. The tap's gate
 * holds the server's bytes after the k-th ReadyForQuery, so the call has read exactly k answers; the server is let do
 * all it can, until it has answered every query or sleeps in a held statement; and the call is interrupted, which it
 * takes at once. A call that cancels retires its session as it takes the interruption, before its one CancelRequest,
 * after which it destroys its connection (batch.ts), and nothing the server answers here retires a session sooner. So
 * the gate lets the rest through once a retired session's CancelRequest has reached the server, when the destroyed
 * connection reads nothing more, and at once when the session is not retired, when no CancelRequest can follow. The
 * scripted session is driven the same way: k answers, then the interruption.
 *
 * The observations compared are the ending, what committed, the retirement, and whether a CancelRequest was sent. A
 * call interrupted with a statement in flight sends one CancelRequest and then destroys its connection (README "No
 * server-side timeouts"), so the server runs none, some or all of the queries left after the statement it stopped
 * before it notices the connection gone, a race between the backend and the client: the scripted session is run at
 * each number of them from none to all (scripted.ts afterCancel), and the server must agree with one, every field
 * exact.
 *
 * Features: a read-committed write frame, each interruption point, a CancelRequest sent, each refused ending, and a
 * write committed after an interruption.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): flight-cancel-after-commit.patch (a CancelRequest sent while COMMIT is
 * awaited), interrupt-no-cancel.patch.
 */
import { layer } from "@effect/vitest"
import { type Case, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order } from "effect"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { until } from "#test/pg/adapter/support.ts"
import { type CaseSpace, caseGen } from "#test/support/flight/cases.ts"
import { runAlone } from "#test/support/pg.ts"

import {
	callOf,
	type Failure,
	fenceSql,
	type FlightCase,
	type FrameName,
	type InterruptionPoint,
	interruptionPoint,
	layoutOf,
	type Observation,
	observed,
	type Planned,
	prologueIn
} from "#test/support/flight/model.ts"
import {
	observationsOf,
	plannedBySql,
	runScripted,
	type ScriptedRun
} from "#test/support/flight/run.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { backendCount, tappedSession } from "#test/support/wire-tap.ts"

/** The kinds the server answers on demand. */
const space: CaseSpace = { failures: ["refused", "doomed", "hold"], serverFaults: false }

/** A read's transaction cannot write, so its doomed statements answer their rows instead. */
const expressible = (c: FlightCase): FlightCase => {
	const call = c.call
	if (call.frame !== "read") {
		return c
	}
	const reading = (planned: Planned): Planned =>
		planned.kind === "doomed" ? { kind: "rows", label: planned.label } : planned
	return { ...c, call: { ...call, statements: Arr.map(call.statements, reading) } }
}

/** The labels of the statements whose SQL writes: every one but a read's transaction's. */
const writing = (c: FlightCase): ReadonlySet<string> =>
	new Set(
		Arr.map(
			c.call.kind === "framed"
				? c.call.frame === "read"
					? []
					: c.call.statements
				: [...c.call.alone, ...(c.call.frame === "read" ? [] : c.call.statements)],
			(planned) => planned.label
		)
	)

/** The SQL of each planned statement over the fixture's tables. */
const sqlOver =
	(schema: string, c: FlightCase) =>
	(planned: Planned): EmittedText => {
		const table = `${schema}."t"`
		const writes = writing(c).has(planned.label)
		const label = planned.label
		switch (planned.kind) {
			case "rows":
				return testSql(
					writes
						? `INSERT INTO ${table} ("label", "ref") VALUES ('${label}', 1) RETURNING "label"`
						: `SELECT '${label}'::text AS "label"`
				)
			case "doomed":
				return testSql(
					`INSERT INTO ${table} ("label", "ref") VALUES ('${label}', -1) RETURNING "label"`
				)
			case "refused":
				return testSql(`SELECT ${schema}."refuse"('${planned.sqlstate}') AS "${label}"`)
			case "hold":
				return testSql(`SELECT '${label}'::text AS "label" FROM pg_catalog.pg_sleep(60)`)
			case "nullCell":
			case "late":
			case "stuck":
			case "fatal":
			case "lose":
				throw new Error(`the server cannot be made to answer a ${planned.kind} statement on demand`)
		}
	}

/** What a case reached on both sides: where it was interrupted, how it ended, and what the interruption did. */
type FlightFeature =
	| "cancel sent"
	| "race cut short"
	| "committed after an interruption"
	| `interrupted ${Exclude<InterruptionPoint, "none">}`
	| `ending ${Failure["tag"]}`
	| `call ${FlightCase["call"]["kind"]} ${FrameName}`

const situations: Arr.NonEmptyReadonlyArray<FlightFeature> = [
	"call framed readCommittedWrite",
	"interrupted in flight",
	"interrupted awaiting COMMIT",
	"interrupted draining",
	"cancel sent",
	"ending BatchRefused",
	"ending CommitRefused",
	"committed after an interruption"
]

/**
 * Planted: a write's flight whose COMMIT is refused, and one interrupted while it awaits a COMMIT that commits. Each is
 * a write's flight, its prologue, BEGIN and COMMIT answered.
 */
const writeFlight = (statements: ReadonlyArray<Planned>): FlightCase => ({
	call: { kind: "framed", frame: "write", prologue: { kind: "answered" }, statements },
	begin: "answered",
	commit: "answered"
})

const flightKept: ReadonlyArray<Kept<FlightCase, FlightFeature>> = [
	{
		note: "a write's flight whose statement dooms its COMMIT",
		sketch: writeFlight([
			{ kind: "rows", label: "s0" },
			{ kind: "doomed", label: "s1" }
		]),
		draws: "",
		reaches: ["ending CommitRefused", "interrupted awaiting COMMIT"]
	},
	{
		note: "a write's flight interrupted while it awaits a COMMIT that commits",
		sketch: writeFlight([{ kind: "rows", label: "s0" }]),
		draws: "",
		reaches: ["interrupted awaiting COMMIT", "committed after an interruption"]
	}
]

/** The run's observation with what committed as a set: the server's table has no order. */
const asSet = (observation: Observation): Observation => ({
	...observation,
	committed: Arr.sort(observation.committed, Order.String)
})

/** The search: the fixture's tables and the fence installed once, then every case compared. */
const flightSuite = Effect.gen(function* () {
	const s = yield* Substrate
	const raw = yield* s.schema(freshSchema)
	const schema = quoteIdent(raw)
	for (const sql of fenceSql(raw, s.owner.role)) {
		yield* s.admin.query(sql, [])
	}
	const prologue = prologueIn(raw)
	yield* s.admin.query(`CREATE TABLE ${schema}."p" ("k" int4 PRIMARY KEY)`, [])
	yield* s.admin.query(`INSERT INTO ${schema}."p" ("k") VALUES (1)`, [])
	yield* s.admin.query(
		`CREATE TABLE ${schema}."t" ("label" text PRIMARY KEY, "ref" int4 NOT NULL REFERENCES ${schema}."p" DEFERRABLE INITIALLY DEFERRED)`,
		[]
	)
	yield* s.admin.query(
		`CREATE FUNCTION ${schema}."refuse"(code text) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE = code; END$$`,
		[]
	)
	const table = `${schema}."t"`

	/**
	 * The case on a real session, interrupted after `k` answers unless k is undefined.
	 *
	 * No CancelRequest's connection outlives the call.
	 */
	const onServer = (c: FlightCase, k: number | undefined) =>
		Effect.scoped(
			Effect.gen(function* () {
				const sqlOf = sqlOver(schema, c)
				yield* s.admin.query(`TRUNCATE ${table}`, [])
				const tapped = yield* tappedSession({
					cluster: s.cluster,
					database: s.database,
					role: s.owner.role,
					password: s.owner.password
				})
				const session = tapped.session
				const backend = yield* runAlone(
					session,
					oneShotStatement(testSql("SELECT pg_catalog.pg_backend_pid()::text"), [])
				)
				const pid = Number(backend.rows[0]?.[0])
				const mark = tapped.mark()
				if (k !== undefined) {
					tapped.gate.hold(k, { kind: "type", type: "Z" })
				}
				const fiber = yield* Effect.forkChild(callOf(session, c.call, sqlOf, prologue))
				if (k !== undefined) {
					const held = yield* Effect.raceFirst(
						Effect.as(tapped.gate.holding, true),
						Effect.as(Fiber.await(fiber), false)
					)
					if (held) {
						const queries = layoutOf(c.call).length
						yield* until(
							Effect.gen(function* () {
								if (backendCount(tapped.since(mark), "Z") >= queries) {
									return true
								}
								const rows = yield* s.admin.queryValues(
									"SELECT coalesce(wait_event::text, '') FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
									[pid]
								)
								return rows[0]?.[0] === "PgSleep"
							})
						)
						/**
						 * The fork starts at once, so the call has taken the interruption when it returns: a call that
						 * cancels has retired its session, and the gate holds until its CancelRequest has reached the
						 * server; any other awaits the drain, with nothing to send.
						 */
						const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), {
							startImmediately: true
						})
						if (session.state() !== "open") {
							yield* until(Effect.sync(() => tapped.cancelsEnded() > 0))
						}
						tapped.gate.release()
						yield* Fiber.join(interrupting)
					}
				}
				const exit = yield* Fiber.await(fiber)
				yield* until(Effect.sync(() => tapped.cancelsEnded() === tapped.cancels()))
				const committed = yield* s.admin.queryValues(
					`SELECT "label" FROM ${table} ORDER BY "label"`,
					[]
				)
				return observed(
					exit,
					Arr.map(committed, ([label]) => String(label)),
					session.state() !== "open",
					tapped.cancels()
				)
			})
		)

	/**
	 * One timing of a case on both sides: the server must agree with the scripted session at one way its race past a
	 * cancelled statement ends (afterCancel), each scripted race run from none of the queries left after that statement
	 * to all of them, where it is no longer cut short. Every field is exact at that value; a flight no CancelRequest
	 * stopped has one race.
	 *
	 * A call that completed before k answers is the uninterrupted run; one that blocked before them is the run
	 * of a smaller k.
	 */
	const compare = (c: FlightCase, k: number | undefined, cx: Case<FlightFeature>) =>
		Effect.gen(function* () {
			const sqlOf = sqlOver(schema, c)
			const bySql = plannedBySql(c, sqlOf)
			const writes = writing(c)
			const races: Array<{
				readonly run: ScriptedRun
				readonly observations: NonNullable<ReturnType<typeof observationsOf>>
				readonly scripted: Observation
			}> = []
			for (let afterCancel = 0; ; afterCancel++) {
				const run = runScripted(c, { interruptAfter: k, afterCancel }, sqlOf)
				const observations = observationsOf(c, run, (sql) => bySql.get(sql)?.label ?? sql)
				if (observations === undefined) {
					return { blocked: true, at: undefined }
				}
				const scripted: Observation = asSet({
					...observations.run,
					committed: Arr.filter(observations.run.committed, (label) => writes.has(label))
				})
				races.push({ run, observations, scripted })
				if (!run.session.cutShort()) {
					break
				}
			}
			const at = races[0]?.observations.interruption.at
			if (k !== undefined && (at === undefined || at < k)) {
				return { blocked: false, at }
			}
			const serverRows = yield* onServer(c, k)
			const server = asSet(serverRows)
			const agreed = Arr.findFirst(races, (race) => Option.isNone(exact(race.scripted, server)))
			if (Option.isNone(agreed)) {
				return yield* Effect.die(
					new Error(
						`server disagrees with scripted at every way its race ends: ${Formatter.format(server)} is none of ${Formatter.format(Arr.map(races, (race) => race.scripted))}\ninterrupted after ${k ?? "no"} answers`
					)
				)
			}
			const { run, observations, scripted } = agreed.value
			cx.note(`call ${c.call.kind} ${c.call.frame}`)
			if (run.session.cutShort()) {
				cx.note("race cut short")
			}
			const point = interruptionPoint(
				c.call,
				run.session.flights()[0]?.delivered ?? [],
				observations.interruption
			)
			if (point !== "none") {
				cx.note(`interrupted ${point}`)
			}
			if (point !== "none" && scripted.committed.length > 0) {
				cx.note("committed after an interruption")
			}
			if (scripted.cancelled) {
				cx.note("cancel sent")
			}
			if (scripted.ending.kind === "failure") {
				cx.note(`ending ${scripted.ending.failure.tag}`)
			}
			return { blocked: false, at }
		})

	return yield* explore(
		{
			oracle: {
				kind: "postgresql",
				name: "a real session interrupted at each answer, against the scripted session at each way its race ends"
			},
			suite: "pg/adapter/flight",
			draw: sketched(caseGen(space), expressible),
			literal: Formatter.format,
			coverage: required<FlightFeature>(situations, { cases: 200, sense: notesOnly }),
			kept: flightKept,
			runs: 25,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		(c, cx) =>
			Effect.gen(function* () {
				yield* compare(c, undefined, cx)
				for (let k = 0; ; k++) {
					const ran = yield* compare(c, k, cx)
					if (ran.blocked || ran.at === undefined || ran.at < k) {
						return
					}
				}
			})
	)
})

layer(Substrate.layer, { excludeTestServices: true })(
	"the scripted session against PostgreSQL",
	(it) => {
		it.effect(
			"observes what the server observes for every flight and interruption point the server can be made to show",
			(ctx) => searched(ctx, flightSuite)
		)
	}
)
