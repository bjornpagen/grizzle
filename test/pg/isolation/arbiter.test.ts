import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int } from "@grizzle/testing/gen"
import { pctSchedule } from "@grizzle/testing/interleave"
import { agree, type Equivalence, exact, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import type { RoleCertificate } from "#compiler/analysis/isolation/certify.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import {
	check,
	counted,
	fin,
	fold,
	key,
	login,
	Monoid,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	type CallInput,
	callStatements,
	type Certifier,
	hostRefused,
	type InstalledShape,
	installShape,
	type IsolationRace,
	raceMoves,
	type RaceCall,
	runIsolationRace,
	stateSql
} from "#test/pg/isolation/support/race.ts"
import { defined } from "#test/support/assert.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, exploreEnv, type Strategy } from "#test/support/schedules/interleave.ts"
import type { RaceTxn } from "#test/support/schedules/serial.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The insert protocol's two arbitrations against PostgreSQL 19 (write/insert/protocol.ts Arbitration): a role served at
 * READ COMMITTED arbitrates its inserts at the arbiter key, DO SELECT, and probes every other object; one served at
 * SERIALIZABLE arbitrates every object, ON CONFLICT DO NOTHING with no target, and classifies only the requested facts its
 * INSERT met, its immutable family's members drawn from their group's base (write/family/scan.ts GroupState). The shape is
 * pantry's import in small: a Doc with a second declared key, and an immutable Invoice whose counted family of Lines is
 * written whole with it, the Invoice's total their CHECKed sum.
 *
 * - Writers of disjoint keys: two or three sessions, each holding its transaction open across every other's statements,
 *   commit every call at READ COMMITTED and hold no SIRead lock; at SERIALIZABLE every SIRead lock they hold is on an
 *   index of Invoice, the relation Line's foreign key references and its counted family's owner, at one of two reads:
 *   PostgreSQL's own foreign key check (ri_triggers.c ri_FastPathCheck under the transaction snapshot), and the owner
 *   INSERT's probe at its key, which proposes only Invoices no stored row holds (write/insert/statement.ts Proposal
 *   `unstored`), since PostgreSQL judges a proposed row by every CHECK before an arbiter meets its key (19rc1
 *   nodeModifyTable.c ExecInsert). Each lock is a page, or the whole index where it holds no entry yet (nbtsearch.c
 *   _bt_first locks an empty index whole). A race of Docs alone, which neither read reaches, holds no SIRead lock and
 *   meets no 40001; a 40001 a race of Invoices meets is at those reads, noted.
 * - Writers of shared keys: every race of calls over a few keys, at the level generate certifies the importer at and at
 *   SERIALIZABLE, is one some serial order of the same calls explains (support/race.ts runIsolationRace): READ
 *   COMMITTED promises that only where generate certifies it.
 * - One history, two forms: the same calls run one after another give the same rows, the same refusals and the same
 *   state at either level.
 */

const Doc = relation("Doc", { id: uuid, slug: pg.integer, title: pg.integer }, ["id"])
const Invoice = relation(
	"Invoice",
	{ id: uuid, amount: pg.integer, lines: drawnField(natural), total: accumulated(pg.integer, 0) },
	["id"]
)
const Line = relation("Line", { invoice: uuid, n: pg.integer, amount: pg.integer }, [
	"invoice",
	"n"
])
const invoiceLines = counted(on(Line, "invoice"), fin(Invoice, "lines"))

/** The import shape under the name `name`: the role `importer`, with its members `doc` and `post`. */
const importShape = (name: string) => {
	const relations = { Doc, Invoice, Line } as const
	const base = schema(name, relations, [
		key(on(Doc, "slug")),
		invoiceLines,
		fold(invoiceLines, Monoid.sum, on(Line, "invoice", "amount"), on(Invoice, "id", "total")),
		check("Settled", Invoice, (i) => i.eq(i.total, i.amount))
	])
	const importer = role(base, "importer", relations, { insert: ["Doc", "Invoice", "Line"] })
	const mine = importer.relations
	const doc = ChangeSet.empty(importer).insert(
		mine.Doc,
		query(importer).rule((r) =>
			r.find({
				id: r.param("id", uuid),
				slug: r.param("slug", pg.integer),
				title: r.param("title", pg.integer)
			})
		)
	)
	const post = ChangeSet.empty(importer).insert(mine.Invoice, []).insert(mine.Line, [])
	return {
		schema: base,
		roles: { importer },
		login: login(base, "app", [importer], { workload: [workload(importer, { doc, post })] })
	}
}

/** The certificate a race at `level` states for the importer. */
const certificateAt = (level: Isolation): RoleCertificate =>
	level === "readCommitted"
		? { level }
		: {
				level,
				reasons: [
					{
						condition: "facts",
						member: undefined,
						statement: undefined,
						relation: undefined,
						detail: "the race runs the importer SERIALIZABLE"
					}
				]
			}

/** Every role of the shape at `level`: the certificates an installation holds for a race at that level. */
const atLevel = (level: Isolation): Certifier => ({
	kind: "stated",
	roles: [{ login: "app", role: "importer", certificate: certificateAt(level) }]
})

/** A uuid of the races' pool. */
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

/** A call before its session is named, with the keys it writes at. */
interface CallSketch {
	readonly kind: "doc" | "post" | "lines"
	readonly member: "doc" | "post"
	readonly input: CallInput
	readonly keys: ReadonlyArray<string>
}

const docCall = (id: number, slug: number, title: number): CallSketch => ({
	kind: "doc",
	member: "doc",
	input: { kind: "params", params: { id: uuidOf(id), slug, title } },
	keys: [`doc ${id}`, `slug ${slug}`]
})

const postCall = (id: number, amounts: ReadonlyArray<number>, amount: number): CallSketch => ({
	kind: "post",
	member: "post",
	keys: [`invoice ${id}`],
	input: {
		kind: "facts",
		facts: {
			insert: {
				Invoice: [{ id: uuidOf(id), amount }],
				Line: Arr.map(amounts, (a, n) => ({ invoice: uuidOf(id), n, amount: a }))
			}
		},
		params: {}
	}
})

/** Lines of the Invoice `id` sent alone, its Invoice none of the call's facts. */
const linesCall = (id: number, lines: ReadonlyArray<readonly [number, number]>): CallSketch => ({
	kind: "lines",
	member: "post",
	keys: [`invoice ${id}`],
	input: {
		kind: "facts",
		facts: {
			insert: {
				Invoice: [],
				Line: Arr.map(lines, ([n, amount]) => ({ invoice: uuidOf(id), n, amount }))
			}
		},
		params: {}
	}
})

/** A post of the Invoice `id` whose amount is its Lines' sum plus what `off` draws: 0 settles it, 1 the CHECK refuses. */
const postedOff =
	(id: number, off: Gen<number>): Gen<CallSketch> =>
	(s) => {
		const amounts = s.draw(array(element([1, 2, 3]), { min: 0, max: 3 }))
		const sum = Arr.reduce(amounts, 0, (a, b) => a + b)
		return postCall(id, amounts, sum + s.draw(off))
	}

/** A post whose amount is its Lines' sum, or, drawn, one off it, which the CHECK refuses. */
const posted = (id: number): Gen<CallSketch> => postedOff(id, element([0, 0, 0, 1]))

/** A race of disjoint keys: two or three calls, the i-th at keys no other names, Docs only or any. */
interface DisjointRace {
	readonly docsOnly: boolean
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
}

const disjointRaces: Gen<DisjointRace> = (s) => {
	const docsOnly = s.draw(element([true, false]))
	const count = s.draw(int(2, 3))
	const calls = upTo(count, (i): CallSketch =>
		docsOnly || s.draw(element([true, false]))
			? docCall(10 + i, 10 + i, s.draw(int(0, 1)))
			: s.draw(posted(20 + i))
	)
	return { docsOnly, calls: nonEmptyList(calls, "a race's calls") }
}

/** A race of shared keys: two or three calls over two Docs, two slugs and two Invoices, from a stored Doc or none. */
interface SharedRace {
	readonly initial: "empty" | "doc"
	readonly calls: Arr.NonEmptyReadonlyArray<CallSketch>
}

const sharedCall: Gen<CallSketch> = (s) => {
	switch (s.draw(element(["doc", "post", "lines"] as const))) {
		case "doc":
			return docCall(s.draw(int(1, 2)), s.draw(int(1, 2)), s.draw(int(0, 1)))
		case "post":
			return s.draw(posted(s.draw(int(3, 4))))
		case "lines":
			return linesCall(
				s.draw(int(3, 4)),
				Arr.dedupeWith(
					s.draw(
						array((t) => [t.draw(int(0, 3)), t.draw(element([1, 2, 3]))] as const, {
							min: 1,
							max: 2
						})
					),
					(a, b) => a[0] === b[0]
				)
			)
	}
}

const sharedRaces: Gen<SharedRace> = (s) => ({
	initial: s.draw(element(["empty", "doc"] as const)),
	calls: nonEmptyList(s.draw(array(sharedCall, { min: 2, max: 3 })), "a race's calls")
})

/**
 * The history a witness runs: its drawn one, or, while an unsettled invoice's refusal is pending, the drawn one after a
 * post the CHECK refuses, its Invoice one no fact of the initial state holds.
 */
const aimedHistory = (drawnHistory: SharedRace, c: Case<SerialFeature>): SharedRace =>
	Option.exists(c.steering, (pending) => pending.names("an unsettled invoice refused"))
		? { ...drawnHistory, calls: [c.draw(postedOff(3, constant(1))), ...drawnHistory.calls] }
		: drawnHistory

const initialOf = (race: SharedRace) =>
	race.initial === "doc" ? { Doc: [{ id: uuidOf(1), slug: 1, title: 0 }] } : {}

const raceOf = (race: SharedRace): IsolationRace => {
	const [first, ...rest] = Arr.map(race.calls, (c, i): RaceCall => ({
		session: `s${i}`,
		role: "importer",
		member: c.member,
		input: c.input
	}))
	return { initial: initialOf(race), calls: [defined(first, "a call"), ...rest] }
}

/** Every order where a race makes few moves; past that, a PCT schedule of depth 3 the case draws. */
const exhaustiveMoves = 6

const strategyOf =
	<F extends string>(c: Case<F>) =>
	(txns: ReadonlyArray<RaceTxn<never>>): Strategy => {
		const moves = raceMoves(txns)
		return moves <= exhaustiveMoves
			? every
			: {
					kind: "pct",
					nature: c,
					schedule: c.draw(
						pctSchedule(
							nonEmptyList(
								Arr.map(txns, (t) => t.session),
								"a race's sessions"
							),
							3,
							moves
						)
					)
				}
	}

/** A SIRead lock a race's sessions hold, read from pg_locks: its kind, its relation's name, and whether that relation
 * is an index of a relation some foreign key references, which in the import shape is Invoice alone. */
interface SireadLock {
	readonly kind: string
	readonly relation: string
	readonly referenced: boolean
}

const sireadLocksSql = `SELECT l.locktype, c.relname, EXISTS (
	SELECT 1 FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_constraint AS f ON f.confrelid = i.indrelid AND f.contype = 'f'
	WHERE i.indexrelid = l.relation
)::text
FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relation
WHERE l.mode = 'SIReadLock' AND l.pid = ANY ($1::int4[])
ORDER BY 2, 1`

const levelSql = (level: Isolation): string =>
	`SET TRANSACTION ISOLATION LEVEL ${level === "readCommitted" ? "READ COMMITTED" : "SERIALIZABLE"}`

/** What one call showed: each statement's SQLSTATE where it failed, then its COMMIT's, none where all succeeded. */
const failureOf = (outcomes: ReadonlyArray<ScheduleOutcome>): string | undefined => {
	for (const o of outcomes) {
		if (o._tag === "PgError") {
			return o.fields.code
		}
		if (o._tag === "RolledBack" || o._tag === "Failed") {
			return o._tag
		}
	}
	return undefined
}

/**
 * Runs a race of disjoint keys over `s`: every session begins at `level`, each sends its call's statements one at a time
 * in turn with the others', so every transaction is open across every other's statements, the SIRead locks are read
 * while all are open, and each commits in turn. Each call's failure, and the locks.
 */
const runDisjoint = (s: InstalledShape, race: DisjointRace, level: Isolation) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* Effect.provideService(replaceMigrated(s.installed, {}), Substrate, substrate)
			const env = yield* exploreEnv(substrate)
			const role = defined(s.shape.roles["importer"], "the importer")
			const sessions = Arr.map(race.calls, (_, i) => `s${i}`)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(
						sessions,
						(name) => [name, { kind: "psql" as const, as: s.installed.world(role) }] as const
					)
				)
			)
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, { session: `s${i}`, role: "importer", member: c.member, input: c.input })
			)
			const outcomes = Arr.map(sessions, (): Array<ScheduleOutcome> => [])
			const actorOf = (i: number) => defined(actors[`s${i}`], `session s${i}`)
			for (const [i] of sessions.entries()) {
				const begun = yield* actorOf(i).perform({ _tag: "Begin" })
				const leveled = yield* actorOf(i).perform({ _tag: "Sql", sql: levelSql(level) })
				defined(outcomes[i], "a session's outcomes").push(begun, leveled)
			}
			const longest = Arr.reduce(sent, 0, (most, statements) => Math.max(most, statements.length))
			for (let step = 0; step < longest; step++) {
				for (const [i, statements] of sent.entries()) {
					const sql = statements[step]
					if (sql !== undefined && failureOf(defined(outcomes[i], "outcomes")) === undefined) {
						const outcome = yield* actorOf(i).perform({ _tag: "Sql", sql })
						defined(outcomes[i], "a session's outcomes").push(outcome)
					}
				}
			}
			const pids = Arr.map(sessions, (_, i) => actorOf(i).pid)
			const rows = yield* env.observer.queryValues(sireadLocksSql, [pids])
			const locks = Arr.map(rows, (row): SireadLock => ({
				kind: textOfValue(row[0]) ?? "",
				relation: textOfValue(row[1]) ?? "",
				referenced: textOfValue(row[2]) === "true"
			}))
			for (const [i] of sessions.entries()) {
				const own = defined(outcomes[i], "a session's outcomes")
				const ended = yield* actorOf(i).perform(
					failureOf(own) === undefined ? { _tag: "Commit" } : { _tag: "Rollback" }
				)
				own.push(ended)
			}
			return { failures: Arr.map(outcomes, failureOf), locks }
		})
	)

/**
 * Runs `calls` over `s` one after another, each in its own transaction at `level` from the stored facts `initial`: each
 * call's failure, its SQLSTATE and DETAIL, none where it committed, and the state they leave, every stored row by its
 * table's name in the schema.
 */
const runSerial = (
	s: InstalledShape,
	initial: ReturnType<typeof initialOf>,
	calls: ReadonlyArray<CallSketch>,
	level: Isolation
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* Effect.provideService(replaceMigrated(s.installed, initial), Substrate, substrate)
			const env = yield* exploreEnv(substrate)
			const role = defined(s.shape.roles["importer"], "the importer")
			const { serial } = yield* openActors(substrate, {
				serial: { kind: "psql", as: s.installed.world(role) }
			})
			const shown: Array<string> = []
			for (const c of calls) {
				const statements = yield* callStatements(s, {
					session: "serial",
					role: "importer",
					member: c.member,
					input: c.input
				})
				const begun = yield* serial.perform({ _tag: "Begin" })
				const leveled = yield* serial.perform({ _tag: "Sql", sql: levelSql(level) })
				const outcomes: Array<ScheduleOutcome> = [begun, leveled]
				for (const sql of statements) {
					if (failureOf(outcomes) === undefined) {
						const outcome = yield* serial.perform({ _tag: "Sql", sql })
						outcomes.push(outcome)
					}
				}
				const failed = Arr.findFirst(outcomes, (o) => o._tag !== "Ok")
				const refusedByHost = Arr.headNonEmpty(statements) === hostRefused
				const ended = yield* serial.perform(
					Option.isNone(failed) ? { _tag: "Commit" } : { _tag: "Rollback" }
				)
				outcomes.push(ended)
				shown.push(
					refusedByHost
						? "refused by the host"
						: Option.match(
								Arr.findFirst(outcomes, (o) => o._tag !== "Ok"),
								{
									onNone: () => "committed",
									onSome: (o) =>
										o._tag === "PgError"
											? Str.startsWith("23")(o.fields.code)
												? `refused ${o.fields.code === "23514" ? "by a CHECK" : "by a key or an axis"}`
												: o.fields.code
											: o._tag
								}
							)
				)
			}
			const rows = yield* env.observer.queryValues(stateSql(s.names), [])
			const state = Arr.sort(
				Arr.map(rows, (row): string => {
					const table = textOfValue(row[0]) ?? ""
					const name = Arr.lastNonEmpty(Str.split(".")(table))
					return `${name} ${textOfValue(row[1]) ?? ""}`
				}),
				Str.Order
			)
			return { shown, state }
		})
	)

/** Two runs of one history agree: the same outcome for each call, in order, and the same state, sorted. */
const sameHistory: Equivalence<{
	readonly shown: ReadonlyArray<string>
	readonly state: ReadonlyArray<string>
}> = (left, right) =>
	Option.orElse(ordered(exact)(left.shown, right.shown), () =>
		ordered(exact)(left.state, right.state)
	)

type DisjointFeature =
	| "docs only"
	| "an invoice posted"
	| "three sessions"
	| "a CHECK refused"
	| "40001 at an Invoice's index"

type SharedFeature = "a stored Doc" | "two calls at one key" | "three sessions"

type SerialFeature =
	| "an exact repeat"
	| "a key or axis refusal"
	| "an unsettled invoice refused"
	| "lines sent alone"

const runs = 8

layer(Substrate.layer, { excludeTestServices: true })(
	"the insert protocol's arbitrations",
	(it) => {
		it.effect("writers of disjoint keys SIRead-lock Invoice's indexes alone, Docs none", (ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const shapes = {
							readCommitted: yield* installShape(importShape, atLevel("readCommitted")),
							serializable: yield* installShape(importShape, atLevel("serializable"))
						}
						return yield* explore(
							{
								oracle: {
									kind: "specification",
									name: "no SIRead lock but at an Invoice index, none and no 40001 for Docs alone"
								},
								suite: "pg/isolation/arbiter-disjoint",
								draw: drawn(disjointRaces),
								literal: Formatter.format,
								coverage: required<DisjointFeature>(
									["docs only", "an invoice posted", "three sessions"],
									{ cases: runs, sense: notesOnly }
								),
								kept: [],
								runs,
								shrink: { kind: "bounded", candidates: 40 },
								concurrency: 1,
								steerEvery: runs,
								caseHang
							},
							(race, c) =>
								Effect.gen(function* () {
									c.note(race.docsOnly ? "docs only" : "an invoice posted")
									if (race.calls.length === 3) {
										c.note("three sessions")
									}
									const rc = yield* runDisjoint(shapes.readCommitted, race, "readCommitted")
									const ser = yield* runDisjoint(shapes.serializable, race, "serializable")
									const refused = (f: string | undefined) => f === "23514" || f === "23000"
									if (Arr.some(rc.failures, refused)) {
										c.note("a CHECK refused")
									}
									const problems = [
										...Arr.map(rc.locks, (l) => `READ COMMITTED holds ${l.kind} ${l.relation}`),
										...Arr.flatMap(rc.failures, (f, i) =>
											f !== undefined && !refused(f) ? Arr.of(`READ COMMITTED s${i}: ${f}`) : []
										),
										...Arr.flatMap(ser.locks, (l) =>
											!race.docsOnly && l.referenced && (l.kind === "page" || l.kind === "relation")
												? []
												: Arr.of(`SERIALIZABLE holds ${l.kind} ${l.relation}`)
										),
										...Arr.flatMap(ser.failures, (f, i) =>
											f === undefined || refused(f) || (f === "40001" && !race.docsOnly)
												? []
												: Arr.of(`SERIALIZABLE s${i}: ${f}`)
										),
										...Arr.flatMap(rc.failures, (f, i) =>
											refused(f) !== refused(ser.failures[i])
												? Arr.of(`s${i} refused at one level alone`)
												: []
										)
									]
									if (Arr.some(ser.failures, (f) => f === "40001")) {
										c.note("40001 at an Invoice's index")
									}
									if (Arr.isReadonlyArrayNonEmpty(problems)) {
										return yield* Effect.die(new Error(Arr.join(problems, "\n")))
									}
								})
						)
					})
				)
			)
		)

		it.effect(
			"every race over shared keys is serial at generate's level and at SERIALIZABLE",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const shapes = [
								yield* installShape(importShape, { kind: "generate" }),
								yield* installShape(importShape, atLevel("serializable"))
							]
							return yield* explore(
								{
									oracle: { kind: "specification", name: "a serial order of the same calls" },
									suite: "pg/isolation/arbiter-shared",
									draw: drawn(sharedRaces),
									literal: Formatter.format,
									coverage: required<SharedFeature>(["a stored Doc", "two calls at one key"], {
										cases: runs,
										sense: notesOnly
									}),
									kept: [],
									runs,
									shrink: { kind: "bounded", candidates: 40 },
									concurrency: 1,
									steerEvery: runs,
									caseHang
								},
								(race, c) => {
									if (race.initial === "doc") {
										c.note("a stored Doc")
									}
									if (race.calls.length === 3) {
										c.note("three sessions")
									}
									if (
										Arr.some(race.calls, (a, i) =>
											Arr.some(
												race.calls,
												(b, j) => i < j && Arr.some(a.keys, (k) => b.keys.includes(k))
											)
										)
									) {
										c.note("two calls at one key")
									}
									return Effect.forEach(
										shapes,
										(s) =>
											Effect.scoped(
												runIsolationRace(s, raceOf(race), strategyOf(c), () => undefined)
											),
										{ discard: true }
									)
								}
							)
						})
					)
				)
		)

		it.effect("one history gives the same rows, refusals and state at either level", (ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const shapes = {
							readCommitted: yield* installShape(importShape, atLevel("readCommitted")),
							serializable: yield* installShape(importShape, atLevel("serializable"))
						}
						return yield* explore(
							{
								oracle: { kind: "specification", name: "the READ COMMITTED form's outcomes" },
								suite: "pg/isolation/arbiter-serial",
								draw: drawn((s): SharedRace => ({
									initial: s.draw(element(["empty", "doc"] as const)),
									calls: nonEmptyList(
										s.draw(array(sharedCall, { min: 1, max: 5 })),
										"a history's calls"
									)
								})),
								literal: Formatter.format,
								coverage: required<SerialFeature>(
									[
										"an exact repeat",
										"a key or axis refusal",
										"an unsettled invoice refused",
										"lines sent alone"
									],
									{ cases: runs, sense: notesOnly }
								),
								kept: [],
								runs,
								shrink: { kind: "bounded", candidates: 40 },
								concurrency: 1,
								steerEvery: runs,
								caseHang
							},
							(drawnHistory, c) =>
								Effect.gen(function* () {
									const history = aimedHistory(drawnHistory, c)
									const initial = initialOf(history)
									const rc = yield* runSerial(
										shapes.readCommitted,
										initial,
										history.calls,
										"readCommitted"
									)
									const ser = yield* runSerial(
										shapes.serializable,
										initial,
										history.calls,
										"serializable"
									)
									for (const shown of rc.shown) {
										if (shown === "refused by a CHECK" || shown === "refused by the host") {
											c.note("an unsettled invoice refused")
										}
										if (shown === "refused by a key or an axis") {
											c.note("a key or axis refusal")
										}
									}
									if (Arr.some(history.calls, (call) => call.kind === "lines")) {
										c.note("lines sent alone")
									}
									if (
										Arr.some(history.calls, (a, i) =>
											Arr.some(
												history.calls,
												(b, j) => i < j && Option.isNone(exact(a.input, b.input))
											)
										)
									) {
										c.note("an exact repeat")
									}
									yield* agree(
										[
											["READ COMMITTED", rc],
											["SERIALIZABLE", ser]
										],
										sameHistory
									)
								})
						)
					})
				)
			)
		)
	}
)
