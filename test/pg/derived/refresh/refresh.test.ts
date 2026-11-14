import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { ExecutionFailure, OpenError } from "#adapter/errors/execution.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { refreshMember } from "#compiler/program/workload/value.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The fixture's shape under the declared name `name`.
 *
 * A workload's refresh member, refresh(...relations), on PostgreSQL 19: what it names, resolved where it is built and
 * where the login's served file is compiled, and what its handle runs.
 *
 * The fixture is one base relation, two derived relations over it at level 1 and a third at level 2 that reads the
 * first. It is installed by the fresh-install compiler with the derived relation extension under a fresh schema name,
 * and rebuilt under that name so that its login's served file names the installed login. The role `partial` holds the
 * base relation and those two whole, and its refresh list is the level-2 relation and the level-1 relation it reads,
 * declared in that order; the other level-1 relation is outside it.
 *
 * Every member naming up to three of: the two in-scope relations, the relation outside the scope, the base relation, a
 * derived relation named like an in-scope one with another definition, a string, a JavaScript look-alike of an
 * in-scope relation and a look-alike holding a getter, is checked against the stated rules, in enumeration order on
 * one installation, against a model of which views are populated:
 *
 * - a value derived.materialized(...) did not build (the base relation, a string, either look-alike) is refused by
 *   refresh(...) itself, a CompileError MalformedDescription thrown where the member is built;
 * - a materialized derived relation the role may not refresh (outside its refresh list, or another relation under an
 *   in-scope one's name) is refused by the compile of the login's served file, at the member, so nothing is refreshed;
 * - otherwise the member's one session runs one refresh statement per relation named, a relation named twice once, in
 *   level order whatever order the member names them, each plain while its view is unpopulated and concurrent once it
 *   is populated, and exactly the named views are populated after it; a level-2 view whose input is unpopulated and
 *   not named is PostgreSQL's 55000, and nothing is refreshed.
 *
 * What a refresh writes and its races are the derived oracle's and the schedule suites'.
 *
 * Plants (main's test phase): derived-refresh-level-order.patch, derived-refresh-named-twice.patch,
 * derived-refresh-report-concurrently.patch.
 */
const build = (name: string) => {
	const Sitting = relation(
		"Sitting",
		{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
		["id"]
	)
	const Edu = schema(name, [Sitting], [])
	const weekly = query(Edu).rule((r) => {
		const { id, student, week, passed } = v(Sitting, "sitting")
		return r.match(Sitting, { id, student, week, passed }).find({
			student,
			week,
			sittings: r.count(),
			passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
		})
	})
	const StudentWeekly = derived.materialized("StudentWeekly", weekly)
	const WeekSittings = derived.materialized(
		"WeekSittings",
		query(Edu).rule((r) => {
			const { id, week } = v(Sitting, "sitting")
			return r.match(Sitting, { id, week }).find({ week, sittings: r.count() })
		})
	)
	const Level1 = schema.extend(Edu, `${name}_1`, [StudentWeekly, WeekSittings], [])
	const busy = query(Level1).rule((r) => {
		const { student, week } = v(StudentWeekly, "studentWeekly")
		return r.match(StudentWeekly, { student, week }).find({ week, students: r.count() })
	})
	const WeekBusy = derived.materialized("WeekBusy", busy)
	const Reports = schema.extend(Level1, `${name}_2`, [WeekBusy], [])
	const partial = role(
		Reports,
		"partial",
		{ Sitting, StudentWeekly, WeekBusy },
		{ refresh: ["WeekBusy", "StudentWeekly"] }
	)
	const server = login(Reports, "server", [partial])
	/** A derived relation named like one of Reports' with another definition: not Reports' relation. */
	const Impostor = derived.materialized(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week } = v(Sitting, "sitting")
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

/** What a member may name: the in-scope views, or something refresh(...) or the compile refuses. The level-2 view comes
 * first, so the first member naming it alone meets its unpopulated input. */
type Named = "WeekBusy" | "StudentWeekly" | Refused
/** What refresh(...) refuses where the member is built: a value derived.materialized(...) did not build. */
type Unbuilt = "base relation" | "a string" | "look-alike" | "a getter"
/** What the compile of the served file refuses: a materialized derived relation the role may not refresh. */
type Unlisted = "outside the scope" | "another definition"
type Refused = Unbuilt | Unlisted

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

/** A member: one name, then up to two more, enumerated a first name at a time, each with every shorter tail first. */
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
		: { kind: "refused", refused: n }

/** The names refresh(...) refuses where the member is built. */
const unbuilt: ReadonlyArray<Refused> = ["base relation", "a string", "look-alike", "a getter"]

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

/** The value a member names for a name. */
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

/** What raised a refresh's failure: the server by its SQLSTATE; any other outcome as itself. */
const raisedOf = (outcome: Result.Result<unknown, unknown>): unknown => {
	if (Result.isSuccess(outcome)) {
		return outcome.success
	}
	const failure = outcome.failure
	if (!(failure instanceof ExecutionFailure)) {
		return failure
	}
	const reason = failure.reason
	switch (reason._tag) {
		case "CompileError":
			return { by: "compiler", stage: "compile" }
		case "ServerError":
			return { by: "server", sqlstate: reason.sqlstate }
		case "TemporaryRefused":
			return { by: "server", sqlstate: reason.error.sqlstate }
		case "InputTooLarge":
		case "UnreadableAnswer":
		case "ParamRejected":
			return reason
	}
}

type RefreshFeature =
	| `refused: ${Refused}`
	| "refreshed plain"
	| "refreshed concurrently"
	| "named against level order"
	| "named twice"
	| "an unpopulated input"

layer(Substrate.layer, { excludeTestServices: true })("a refresh member", (it) => {
	it.effect(
		"is refused where it is built or compiled unless it names in-scope derived relations of the schema, and otherwise refreshes exactly what it names, once each, in level order, plain until populated",
		(t) =>
			searched(
				t,
				Effect.gen(function* () {
					const s = yield* Substrate
					const declared = build("Edu")
					const installed = yield* install(declared.Reports, {
						ambient: ordinarySession,
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
					return yield* withServedDb(installed, f.server.roles.partial, {}, ({ ctx, load }) =>
						Effect.gen(function* () {
							/** The Db's context over a pool that counts its leases: a refresh leases one session. */
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
									box: "every member naming one to three of the two in-scope relations, the relation outside the scope, the base relation, another definition under an in-scope name, a string and two look-alikes, in every order, on one installation",
									oracle: {
										kind: "specification",
										name: "refresh(...)'s stated rules: refused where it is built or compiled unless it names in-scope derived relations, else one statement per relation in level order, plain until populated, against a model of the populated views"
									},
									suite: "derived/refresh",
									generator: calls,
									literal: Formatter.format,
									caseHang,
									coverage: requiredInSpace<RefreshFeature>([
										"refused: outside the scope",
										"refused: base relation",
										"refused: another definition",
										"refused: a string",
										"refused: look-alike",
										"refused: a getter",
										"refreshed plain",
										"refreshed concurrently",
										"named against level order",
										"named twice",
										"an unpopulated input"
									]),
									concurrency: 1
								},
								(names, c) =>
									Effect.gen(function* () {
										const refusals = refusalsOf(names)
										const listed = viewsOf(names)
										const views = Arr.filter(levelOrder, (view) => listed.includes(view))
										const built = Result.try({
											try: () => refreshMember(Arr.map(names, (n) => passed(f, n))),
											catch: (error) => error
										})
										if (Arr.some(refusals, (r) => unbuilt.includes(r))) {
											assert.ok(
												Result.isFailure(built),
												`refresh(...) builds ${Arr.join(names, ", ")}`
											)
											assert.ok(isCompileError(built.failure), String(built.failure))
											assert.equal(built.failure.reason._tag, "MalformedDescription")
											for (const r of refusals) {
												c.note(`refused: ${r}`)
											}
										} else {
											const loaded = yield* Effect.result(
												load({ r: succeeded(built, "a refresh member of materialized relations") })
											)
											if (refusals.length > 0) {
												assert.ok(
													Result.isFailure(loaded),
													`the compile admits ${Arr.join(names, ", ")}`
												)
												const refused = loaded.failure
												assert.ok(!(refused instanceof OpenError), Formatter.format(refused))
												assert.deepEqual(refused.place, {
													kind: "program",
													role: "partial",
													program: "r"
												})
												for (const r of refusals) {
													c.note(`refused: ${r}`)
												}
											} else {
												const refresh = member(succeeded(loaded, "the refresh member"), "r")
												assertVariant(refresh, "kind", "refresh", "a refresh member")
												const before = leases.count
												const outcome = yield* Effect.result(
													Effect.scoped(runRefresh(counting, refresh.refresh))
												)
												const leased = leases.count - before
												if (
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
												}
											}
										}
										const populatedViews = yield* populated
										assert.deepEqual(populatedViews, [
											["StudentWeekly", model.has("StudentWeekly")],
											["WeekBusy", model.has("WeekBusy")],
											["WeekSittings", false]
										])
									})
							)
						})
					)
				})
			)
	)
})
