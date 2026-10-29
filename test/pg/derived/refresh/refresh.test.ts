import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Layer, Result, Schema } from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import { refreshReport } from "#adapter/refresh/index.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/** The fixture's shape under the declared name `name`.
 *
 * db.refresh's resolution of what it names, on PostgreSQL 19 (`and`).
 *
 * The fixture is one base relation, two derived relations over it at level 1 and a third at level 2 that reads the
 * first. It is installed by the fresh-install compiler with the derived relation extension under a fresh schema name,
 * and rebuilt under that name so that Db.open logs in as the installed login (`explains` the
 * rebuild). The role `partial` holds the base relation and those two whole, and its refresh list is the level-2
 * relation and the level-1 relation it reads, declared in that order; the other level-1 relation is outside it.
 *
 * Every call naming up to three of: the two in-scope relations, the relation outside the scope, the base relation, a
 * derived relation named like an in-scope one with another definition, a string, a JavaScript look-alike of an
 * in-scope relation and a look-alike holding a getter, is checked against the stated rules, in enumeration order on
 * one installation, against a model of which views are populated:
 *
 * - a call naming anything but in-scope derived relations of the schema, by value or by a look-alike read as data, is
 *   the ExecutionFailure whose reason is the CompileError, before any SQL: no session is leased, and nothing
 *   named beside it is refreshed;
 * - otherwise one session runs one refresh statement per relation named, a relation named twice once, in level order
 *   whatever order the call names them, each plain while its view is unpopulated and concurrent once it is populated,
 *   and exactly the named views are populated after it; a level-2 view whose input is unpopulated and not named is
 *   PostgreSQL's 55000, and nothing is refreshed.
 *
 * What a refresh writes and its races are the derived oracle's and the schedule suites'. */
const build = (name: string) => {
	const Sitting = relation(
		"Sitting",
		{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
		["id"]
	)
	const Edu = schema(name, { Sitting }, [])
	const weekly = query(Edu).rule((r) => {
		const { id, student, week, passed } = v(Sitting)
		return r.match(Sitting, { id, student, week, passed }).find({
			student,
			week,
			sittings: r.count(),
			passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
		})
	})
	const StudentWeekly = derived("StudentWeekly", weekly)
	const WeekSittings = derived(
		"WeekSittings",
		query(Edu).rule((r) => {
			const { id, week } = v(Sitting)
			return r.match(Sitting, { id, week }).find({ week, sittings: r.count() })
		})
	)
	const Level1 = schema.extend(Edu, { StudentWeekly, WeekSittings }, [])
	const busy = query(Level1).rule((r) => {
		const { student, week } = v(StudentWeekly)
		return r.match(StudentWeekly, { student, week }).find({ week, students: r.count() })
	})
	const WeekBusy = derived("WeekBusy", busy)
	const Reports = schema.extend(Level1, { WeekBusy }, [])
	const partial = role(
		Reports,
		"partial",
		{ Sitting, StudentWeekly, WeekBusy },
		{ refresh: ["WeekBusy", "StudentWeekly"] }
	)
	const server = login(Reports, "server", [partial])
	/** A derived relation named like one of Reports' with another definition: not Reports' relation. */
	const Impostor = derived(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week } = v(Sitting)
			return r.match(Sitting, { id, student, week }).find({ student, week, sittings: r.count() })
		})
	)
	return {
		Sitting,
		StudentWeekly,
		WeekSittings,
		WeekBusy,
		Reports,
		partial,
		server,
		Impostor,
		weekly
	}
}

type Fixture = ReturnType<typeof build>

/** What a call may name: the in-scope views, by value or by a JavaScript look-alike read as data, or something the
 * resolution refuses. The level-2 view comes first, so the first call naming it alone meets its unpopulated input. */
type Named = "WeekBusy" | "StudentWeekly" | "look-alike" | Refused
type Refused =
	| "outside the scope"
	| "base relation"
	| "another definition"
	| "a string"
	| "a getter"

const named = element<Named>([
	"WeekBusy",
	"StudentWeekly",
	"look-alike",
	"outside the scope",
	"base relation",
	"another definition",
	"a string",
	"a getter"
])

/** A call: one name, then up to two more, enumerated a first name at a time, each with every shorter tail first. */
const calls: Gen<Arr.NonEmptyReadonlyArray<Named>> = (source) => [
	source.draw(named),
	...source.draw(array(named, { min: 0, max: 2 }))
]

/** What the resolution makes of a name: the view it refreshes, or its refusal. */
type View = "WeekBusy" | "StudentWeekly"
type Resolved =
	| { readonly kind: "view"; readonly view: View }
	| { readonly kind: "refused"; readonly refused: Refused }

const resolved = (n: Named): Resolved =>
	n === "WeekBusy" || n === "StudentWeekly"
		? { kind: "view", view: n }
		: n === "look-alike"
			? { kind: "view", view: "StudentWeekly" }
			: { kind: "refused", refused: n }

const viewsOf = (names: ReadonlyArray<Named>): ReadonlyArray<View> =>
	Arr.flatMap(names, (n) => {
		const r = resolved(n)
		return r.kind === "view" ? [r.view] : []
	})

const refusalsOf = (names: ReadonlyArray<Named>): ReadonlyArray<Refused> =>
	Arr.flatMap(names, (n) => {
		const r = resolved(n)
		return r.kind === "refused" ? [r.refused] : []
	})

/** The value a caller passes for a name. */
const passed = (f: Fixture, n: Named): unknown => {
	switch (n) {
		case "WeekBusy":
			return f.WeekBusy
		case "StudentWeekly":
			return f.StudentWeekly
		case "look-alike":
			return { kind: "derived", name: "StudentWeekly", definition: f.weekly }
		case "outside the scope":
			return f.WeekSittings
		case "base relation":
			return f.Sitting
		case "another definition":
			return f.Impostor
		case "a string":
			return "StudentWeekly"
		case "a getter":
			return {
				kind: "derived",
				get name() {
					return "StudentWeekly"
				},
				definition: f.weekly
			}
	}
}

/** Level order: the level-1 view before the level-2 view that reads it. */
const levelOrder: ReadonlyArray<View> = ["StudentWeekly", "WeekBusy"]

/** What raised a call's failure: the compiler at its stage, or the server by its SQLSTATE; any other outcome as itself. */
const raisedOf = (outcome: Result.Result<unknown, unknown>): unknown => {
	if (Result.isSuccess(outcome)) {
		return outcome.success
	}
	const failure = outcome.failure
	if (!Schema.is(ExecutionFailure)(failure)) {
		return failure
	}
	const reason = failure.reason
	switch (reason._tag) {
		case "CompileError":
			return { by: "compiler", stage: "compile" }
		case "MissingCapability":
			return { by: "compiler", stage: "capability" }
		case "ServerError":
			return { by: "server", sqlstate: reason.sqlstate }
		case "InputTooLarge":
		case "UnreadableAnswer":
			return reason
	}
}

type RefreshFeature =
	| `refused: ${Refused}`
	| "refreshed plain"
	| "refreshed concurrently"
	| "named against level order"
	| "named twice"
	| "a look-alike refreshed"
	| "an unpopulated input"

layer(Substrate.layer, { excludeTestServices: true })("db.refresh", (it) => {
	it.effect(
		"refuses before any SQL whatever is not an in-scope derived relation of the schema, and otherwise refreshes exactly what it names, once each, in level order, plain until populated",
		(t) =>
			searched(
				t,
				Effect.gen(function* () {
					const s = yield* Substrate
					const declared = build("Edu")
					const installed = yield* install(declared.Reports, {
						extensions: [],
						label: "refresh",
						logins: [declared.server]
					})
					const f = build(installed.declared)
					/** pg_class.relispopulated of each view, read as the owner. */
					const populated = Effect.forEach(
						["StudentWeekly", "WeekBusy", "WeekSittings"] as const,
						(name) =>
							Effect.map(
								s.admin.queryValues(
									"SELECT c.relispopulated FROM pg_catalog.pg_class AS c WHERE c.oid = $1::regclass",
									[printObjectName(installed.names.relation(name))]
								),
								(rows) => [name, rows[0]?.[0] === true] as const
							)
					)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(f.server.roles.partial, {})
						const ctx = dbContext(db)
						if (ctx === undefined) {
							return yield* Effect.die(new Error("the Db has no context"))
						}
						/** The Db's context over a pool that counts its leases: a refusal before any SQL leases none. */
						const leases = { count: 0 }
						const counting = {
							...ctx,
							pool: {
								...ctx.pool,
								lease: Effect.suspend(() => {
									leases.count++
									return ctx.pool.lease
								})
							}
						}
						/** The model: the views populated so far. */
						const model = new Set<View>()
						return yield* exhaust(
							{
								suite: "derived/refresh",
								generator: calls,
								literal: Formatter.format,
								limit: 600,
								caseHang: Duration.minutes(2),
								features: features<RefreshFeature>([
									"refused: outside the scope",
									"refused: base relation",
									"refused: another definition",
									"refused: a string",
									"refused: a getter",
									"refreshed plain",
									"refreshed concurrently",
									"named against level order",
									"named twice",
									"a look-alike refreshed",
									"an unpopulated input"
								])
							},
							(names, c) =>
								Effect.gen(function* () {
									const before = leases.count
									const outcome = yield* Effect.result(
										refreshReport(
											counting,
											Arr.map(names, (n) => passed(f, n))
										)
									)
									const leased = leases.count - before
									const refusals = refusalsOf(names)
									const listed = viewsOf(names)
									const views = Arr.filter(levelOrder, (view) => listed.includes(view))
									if (refusals.length > 0) {
										assert.deepEqual(
											raisedOf(outcome),
											{ by: "compiler", stage: "compile" },
											Arr.join(names, ", ")
										)
										assert.equal(leased, 0, "no session leased before a refusal")
										for (const r of refusals) {
											c.note(`refused: ${r}`)
										}
									} else if (
										views.includes("WeekBusy") &&
										!views.includes("StudentWeekly") &&
										!model.has("StudentWeekly")
									) {
										assert.deepEqual(
											raisedOf(outcome),
											{ by: "server", sqlstate: "55000" },
											"a level-2 view over an unpopulated input"
										)
										c.note("an unpopulated input")
									} else {
										assert.deepEqual(
											Arr.map(succeeded(outcome, Arr.join(names, ", ")).statements, (st) => [
												st.relation,
												st.concurrently
											]),
											Arr.map(views, (view) => [view, model.has(view)]),
											"one statement per named view, in level order, plain until populated"
										)
										assert.equal(leased, 1, "one session")
										for (const view of views) {
											c.note(model.has(view) ? "refreshed concurrently" : "refreshed plain")
											model.add(view)
										}
										if (listed[0] === "WeekBusy" && views.length === 2) {
											c.note("named against level order")
										}
										if (listed.length > views.length) {
											c.note("named twice")
										}
										if (names.includes("look-alike")) {
											c.note("a look-alike refreshed")
										}
									}
									assert.deepEqual(yield* populated, [
										["StudentWeekly", model.has("StudentWeekly")],
										["WeekBusy", model.has("WeekBusy")],
										["WeekSittings", false]
									])
								})
						)
					}).pipe(
						(body) =>
							Effect.flatMap(Layer.build(loginLayer(installed, f.server)), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				})
			)
	)
})
