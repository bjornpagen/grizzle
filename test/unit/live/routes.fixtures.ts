/** What the properties of routes.test.ts read: its spaces, models and helpers. */

import { Result as Answered, Array as Arr, Effect, Formatter, String as Str } from "effect"
import { served } from "#adapter/public/layer.ts"
import { httpRoutes } from "#http/index.ts"
import { assert } from "#test/support/assert.ts"
import { type LawLevel } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	clockedReadName,
	compiledLogin,
	drawnLogin,
	type DrawnSchema,
	roleName,
	type RoleShape
} from "#test/support/served-login.ts"

export type Feature =
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
 * ChangeSet `<role>change<i>`, each read `<role>read<place>`, and a clocked read `<role>clock` (clockedReadName), read at
 * its call's instant.
 */
const expectedRoutes = (
	shapes: Arr.NonEmptyReadonlyArray<RoleShape>
): ReadonlyArray<ExpectedRoute> =>
	Arr.flatMap(shapes, (shape, place) => {
		const role = roleName(place)
		const programs = [
			...Arr.map(shape.changes, (_, i) => `${role}change${i}`),
			...Arr.map(shape.reads, (read) => `${role}read${read.place}`),
			...(shape.clocked ? [clockedReadName(place)] : [])
		]
		return Arr.map(programs, (program) => ({
			line: `POST /${loginName}/${role}/${program}`,
			login: loginName,
			role,
			program
		}))
	})

export const routesOf = (
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
