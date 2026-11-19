/** What the properties of refresh.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"

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
 */
export const build = (name: string) => {
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
export const calls: Gen<Arr.NonEmptyReadonlyArray<Named>> = (source) => [
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
export const unbuilt: ReadonlyArray<Refused> = [
	"base relation",
	"a string",
	"look-alike",
	"a getter"
]

export const viewsOf = (names: ReadonlyArray<Named>): ReadonlyArray<View> =>
	Arr.flatMap(names, (n) => {
		const r = resolved(n)
		return r.kind === "view" ? [r.view] : []
	})

export const refusalsOf = (names: ReadonlyArray<Named>): ReadonlyArray<Refused> =>
	Arr.flatMap(names, (n) => {
		const r = resolved(n)
		return r.kind === "refused" ? [r.refused] : []
	})

/** The value a member names for a name. */
export const passed = (f: Fixture, n: Named): unknown => {
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
export const levelOrder: ReadonlyArray<View> = ["StudentWeekly", "WeekBusy"]

/** What raised a refresh's failure: the server by its SQLSTATE; any other outcome as itself. */
export const raisedOf = (outcome: Result.Result<unknown, unknown>): unknown => {
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

export type RefreshFeature =
	| `refused: ${Refused}`
	| "refreshed plain"
	| "refreshed concurrently"
	| "named against level order"
	| "named twice"
	| "an unpopulated input"

export const declared = build("Edu")

/** What the search built once before its cases (leases, model), now once per worker: every case on it reads them. */
export const leasesNeed = {
	key: "test/pg/derived/refresh/refresh.fixtures.ts leasesNeed",
	open: Effect.sync(() => {
		/** The Db's context over a pool that counts its leases: a refresh leases one session. */
		const leases = { count: 0 }
		/** The model: the views populated so far. */
		const model = new Set<View>()
		return Effect.succeed({ leases, model })
	})
} as const satisfies Need<unknown>
