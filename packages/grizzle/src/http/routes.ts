import { Array as Arr, Result } from "effect"
import type { ServedFile } from "#compiler/plan/serve.ts"

/**
 * The routes of an HTTP handler, as data: one per member of each role of each login it serves, `POST
 * /<login>/<role>/<program>`, every segment a declared name, and nothing else. A login's served file holds its roles,
 * each with its workload's members, so the table is the logins' roles by their members, whether read off the files or
 * off the logins a layer loaded from them, which hold the same roles and members under the same names. A request is
 * answered by the route its request line names, or by the refusal of a call no route serves.
 */

/** A route: the declared names of a login, one of its roles, and one program of that role's workload. */
export interface HttpRoute {
	readonly login: string
	readonly role: string
	readonly program: string
}

/**
 * The request line of a route's one call, its method and target: `POST /<login>/<role>/<program>`. A request is
 * routed by its own (request.ts requestLine), so another method, another path or any query is no route's.
 */
export const routeLine = (route: HttpRoute): string =>
	`POST /${route.login}/${route.role}/${route.program}`

/** A role as the table reads it: its declared name and its workload's members, each named. */
export interface RoutedRole {
	readonly name: string
	readonly members: ReadonlyArray<{ readonly name: string }>
}

/** A login as the table reads it: its declared name and its roles. */
export interface RoutedLogin<Role extends RoutedRole> {
	readonly login: string
	readonly roles: ReadonlyArray<Role>
}

/** One entry of the table: the route, and the role and member it names, as the table was given them. */
export interface RouteOf<Role extends RoutedRole> {
	readonly route: HttpRoute
	readonly role: Role
	readonly member: Role["members"][number]
}

/**
 * The table of `logins`, by request line (routeLine): each login's roles by their members. Two entries of one request
 * line, which only two logins of one name give, since a login's roles and a role's programs are named apart, are
 * refused with the route.
 */
export const routeTable = <Role extends RoutedRole>(
	logins: ReadonlyArray<RoutedLogin<Role>>
): Result.Result<ReadonlyMap<string, RouteOf<Role>>, HttpRoute> => {
	const table = new Map<string, RouteOf<Role>>()
	for (const login of logins) {
		for (const role of login.roles) {
			for (const member of role.members) {
				const route: HttpRoute = { login: login.login, role: role.name, program: member.name }
				const line = routeLine(route)
				if (table.has(line)) {
					return Result.fail(route)
				}
				table.set(line, { route, role, member })
			}
		}
	}
	return Result.succeed(table)
}

/**
 * The routes of `logins`, each a login served(...) built, by request line: each login's roles by their members, as its
 * served file holds them (routeTable), the routes a handler built over the logins serves. Two logins of one name are
 * refused with the route they both give.
 */
export const httpRoutes = (
	logins: ReadonlyArray<{ readonly name: string; readonly file: ServedFile }>
): Result.Result<ReadonlyMap<string, HttpRoute>, HttpRoute> =>
	Result.map(
		routeTable(Arr.map(logins, (login) => ({ login: login.name, roles: login.file.roles }))),
		(table) =>
			new Map(Arr.map(Arr.fromIterable(table), ([line, entry]) => [line, entry.route] as const))
	)
