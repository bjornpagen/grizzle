/**
 * Endpoints equal programs: a login's HTTP routes are exactly its served members. Over generated public schemas
 * (test/support/oracle/public), each extended by a drawn law level, and a login drawn over each (test/support/served-login.ts:
 * one or two roles, each writing some relations through ChangeSets and reading some of the case's queries, an ordered
 * one perhaps paged, a role perhaps serving nothing), compiled as `grizzle generate` compiles it with no database and
 * served from its file as an application serves it (served(file, name)):
 *
 * - the route table the handler dispatches on (http httpRoutes) holds exactly one route for every member of every
 *   role's workload, at the request line `POST /<login>/<role>/<program>` by their declared names, naming that login,
 *   role and program, and no other route: none for a role that serves nothing, none for a program the login does not
 *   serve.
 *
 * The oracle is the drawn login itself: the programs each drawn role's workload was built with, by the names the
 * drawing gave them, never the served file the routes are read from.
 *
 * Plant: a route without a program (~/.cache/grizzle-release/LIVE-TESTS/plants/route-without-program.patch): the table
 * holds a route for every role of the file, a role that serves nothing included.
 *
 * Features: a role that serves nothing, a role that serves programs, two roles, a read member, a paged member, a change
 * member.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, String as Str } from "effect"
import { served } from "#adapter/public/layer.ts"
import { httpRoutes } from "#http/index.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	type DrawnSchema,
	loginGen,
	type RoleShape,
	roleName
} from "#test/support/served-login.ts"

type Feature =
	| "a role that serves nothing"
	| "a role that serves programs"
	| "two roles"
	| "a read member"
	| "a paged member"
	| "a change member"

/** The login every drawn login is declared as (test/support/served-login.ts). */
const loginName = "app"

/** One route as the oracle states it: its request line, and the login, role and program it names. */
interface ExpectedRoute {
	readonly line: string
	readonly login: string
	readonly role: string
	readonly program: string
}

/**
 * The routes the drawn login's roles serve, by the names the drawing gave its programs (served-login.ts roleOf): each
 * ChangeSet `<role>change<i>` and each read `<role>read<place>`.
 */
const expectedRoutes = (
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>
): ReadonlyArray<ExpectedRoute> =>
	Arr.flatMap(shapes, (shape, place) => {
		const role = roleName(place)
		const programs = [
			...Arr.map(shape.changes, (_, i) => `${role}change${i}`),
			...Arr.map(shape.reads, (read) => `${role}read${read.place}`)
		]
		return Arr.map(programs, (program) => ({
			line: `POST /${loginName}/${role}/${program}`,
			login: loginName,
			role,
			program
		}))
	})

const routesOf = (
	drawnCase: DrawnSchema,
	level: LawLevel,
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(drawnCase.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const declared = drawnLogin(drawnCase, shapes)
		const compiled = yield* Effect.result(compiledLogin(declared, drawnCase.laws.codes))
		if (Answered.isFailure(compiled)) {
			return
		}
		const file = served(compiled.success.json, loginName)
		const table = httpRoutes([file])
		if (Answered.isFailure(table)) {
			return assert.fail(
				`one login's routes never collide, yet ${Formatter.format(table.failure)} came twice\n${printed()}`
			)
		}
		const actual = Arr.map([...table.success], ([line, route]) => ({
			line,
			login: route.login,
			role: route.role,
			program: route.program
		}))
		const inOrder = (routes: ReadonlyArray<ExpectedRoute>) =>
			Arr.sort(
				Arr.map(routes, (r) => `${r.line} ${r.login} ${r.role} ${r.program}`),
				Str.Order
			)
		assert.deepEqual(
			inOrder(actual),
			inOrder(expectedRoutes(shapes)),
			`the route table is the login's served members\n${printed()}`
		)
		for (const shape of shapes) {
			note(
				Arr.isReadonlyArrayNonEmpty(shape.changes) || Arr.isReadonlyArrayNonEmpty(shape.reads)
					? "a role that serves programs"
					: "a role that serves nothing"
			)
			if (Arr.isReadonlyArrayNonEmpty(shape.changes)) {
				note("a change member")
			}
			for (const read of shape.reads) {
				note(read.paged ? "a paged member" : "a read member")
			}
		}
		if (shapes.length > 1) {
			note("two roles")
		}
	})

describe("the HTTP surface's routes", () => {
	it.effect("are exactly the login's served members, one route each", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the programs each drawn role's workload was built with, by their drawn names"
					},
					suite: "unit/live/routes",
					draw: drawn((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a role that serves nothing",
							"a role that serves programs",
							"two roles",
							"a read member",
							"a paged member",
							"a change member"
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([sketch, level], notes) =>
					Effect.suspend(() => {
						const drawnCase = drawnSchema(notes.draw(resolveCase(sketch)), level)
						return routesOf(drawnCase, level, notes.draw(loginGen(drawnCase)), notes.note)
					})
			)
		)
	)
})
