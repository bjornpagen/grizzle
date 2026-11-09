import { Array as Arr } from "effect"
import type {
	ServedConstructor,
	ServedLogin,
	ServedRole,
	ServedRoles
} from "#adapter/types/layer.ts"
import { type AnyLogin, builtMark, defect, trusted } from "#compiler/plan/common.ts"

/**
 * served(file, name): a login's served workload, as an application holds it, and the tokens of its roles.
 *
 * `grizzle generate` writes each login's workload as `migrations/<schema>/served/<login>.json`, and the application
 * imports it (`import file from "./migrations/qti/served/app.json" with { type: "json" }`) or reads and parses it, then
 * serves it as its login's type: `served<typeof App>(file, "app")`. The type is the login's alone, `import type`, so
 * no schema module is evaluated; the name is L's, which the layer checks the file against when it is built
 * (ServedLoginRefused). grizzle trusts its own file: `grizzle check` holds every committed file to the compile of the
 * snapshot it was written under, and every Db's prologue guards the database with the file's fingerprint.
 *
 * served reads nothing of the file but its roles' names, each a token Db.open takes, and its login's PostgreSQL role
 * (roleNameOf); DbLayer.make reads the rest, once, when the layer is built.
 *
 * The members of a served file's JSON value served reads: its base's declared name, its login's PostgreSQL role, and
 * its roles' names. Each is a plain string of the file's JSON form, which grizzle's names never escape (a declared name
 * and a role name never begin with `~`).
 */
interface ServedHead {
	readonly base: string
	readonly role: string
	readonly roles: ReadonlyArray<{ readonly name: string }>
}

/** The token of the role `role` of the served login `login` over the base `base`. */
const servedRole = <R, P>(base: string, login: string, role: string): ServedRole<R, P> =>
	Object.freeze({ ...builtMark, kind: "servedRole", base, login, role })

/**
 * The one site of the fact that the record of tokens served builds, one under each of the file's role names, is
 * ServedRoles<L>, a mapped type over L's roles: L has no runtime value, and a record built key by key is beyond what
 * TypeScript checks against a mapped type. Its check is the part a runtime can read: the record's own keys are exactly
 * the file's role names. The file is L's: the layer refuses one of another login (ServedLoginRefused), and `grizzle
 * check` holds it to L's compile.
 */
const isServedRoles = <L>(roles: object, names: ReadonlyArray<string>): roles is ServedRoles<L> =>
	Reflect.ownKeys(roles).length === names.length &&
	Arr.every(names, (name) => Reflect.has(roles, name))

/** served(file, name) (see the header). */
export const served: ServedConstructor = <L extends AnyLogin>(
	file: unknown,
	name: NoInfer<L["name"]>
): ServedLogin<L> => {
	const head = trusted<ServedHead>(file)
	const roles: Record<string, ServedRole<unknown, unknown>> = {}
	const names = Arr.map(head.roles, (role) => role.name)
	for (const role of names) {
		roles[role] = servedRole(head.base, name, role)
	}
	Object.freeze(roles)
	if (!isServedRoles<L>(roles, names)) {
		throw defect("served builds one token under each of its file's role names")
	}
	return Object.freeze({ ...builtMark, kind: "servedLogin", name, base: head.base, roles, file })
}

/**
 * roleNameOf(login): the PostgreSQL role a served login logs in as, which its file names: what a platform names the
 * login's password or IAM credential by. It reads the one member of the file and evaluates no schema.
 */
export const roleNameOf = <L>(login: ServedLogin<L>): string =>
	trusted<Pick<ServedHead, "role">>(login.file).role
