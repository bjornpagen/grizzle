import * as Arr from "effect/Array"
import * as Formatter from "effect/Formatter"
import type {
	DecoderLogin,
	ServedConstructor,
	ServedDecoder,
	ServedLogin,
	ServedRole,
	ServedRoles
} from "#adapter/types/layer.ts"
import type { AnyLogin, AnyRole, Isolation } from "#compiler/plan/common.ts"
import {
	builtMark,
	CompileError,
	defect,
	roleInSpace,
	malformedDescription,
	type RoleInstallation,
	rolePrefixFaultText,
	roleSpaceOf,
	SourceLoc,
	servedFile
} from "#compiler/plan/runtime.ts"
import type { ServedLive } from "#compiler/plan/serve.ts"

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
 * served reads the file once, through the one reader of a served file's JSON value (served/json.ts servedFile), which
 * rebuilds every value JSON cannot hold and takes every other member as it is: no code reads the file's JSON form but
 * that reader. The login holds the file read, whose roles' names are each a token Db.open takes, each with the level
 * generate certified its writes at, whose login's PostgreSQL role names its credential (roleNameOf), and whose live
 * source names the installation's decoder login; DbLayer.make loads the rest from it, once, when the layer is built.
 */

/** The token of the role `role` of the served login `login` over the base `base`, its writes begun at `isolation`. */
const servedRole = <R, P>(
	base: string,
	login: string,
	role: string,
	isolation: Isolation
): ServedRole<R, P> =>
	Object.freeze({ ...builtMark, kind: "servedRole", base, login, role, isolation })

/** The decoder of a served login that serves no read. */
const noDecoder: ServedDecoder = Object.freeze({ kind: "none" })

/** The decoder login the file of the served login `login` names: its live source's stem, none where it holds none. */
const decoderOf = (login: string, live: ServedLive): ServedDecoder => {
	switch (live.kind) {
		case "none":
			return noDecoder
		case "source":
			return Object.freeze({ ...builtMark, kind: "decoderLogin", login, stem: live.stem })
	}
}

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
	const read = servedFile(file)
	const roles: Record<string, ServedRole<unknown, unknown>> = {}
	const names = Arr.map(read.roles, (role) => role.name)
	for (const role of read.roles) {
		roles[role.name] = servedRole(read.base, name, role.name, role.isolation)
	}
	Object.freeze(roles)
	if (!isServedRoles<L>(roles, names)) {
		throw defect("served builds one token under each of its file's role names")
	}
	return Object.freeze({
		...builtMark,
		kind: "servedLogin",
		name,
		base: read.base,
		roles,
		decoder: decoderOf(name, read.live),
		file: read
	})
}

/** A value's stem, where its refusal is reported, and whether it is a login's or a role's (roleNameOf). */
interface Stemmed {
	readonly stem: string
	readonly at: SourceLoc
	readonly of: "login" | "role"
}

/** The stem `named` carries: a served login's, its file's; a decoder login's, the file's live source's; a login's or a
 * role's, as login(...) or role(...) computed it, whose refusal it throws. */
const stemmed = <L>(named: AnyLogin | AnyRole | ServedLogin<L> | DecoderLogin): Stemmed => {
	if (named.kind === "servedLogin") {
		return { stem: named.file.role, at: SourceLoc(`login ${named.name}`, []), of: "login" }
	}
	if (named.kind === "decoderLogin") {
		return {
			stem: named.stem,
			at: SourceLoc(`the decoder login of login ${named.login}`, []),
			of: "login"
		}
	}
	if (!named.stem.ok) {
		throw named.stem.error
	}
	return {
		stem: named.stem.value,
		at: SourceLoc(`${named.kind} ${named.name}`, []),
		of: named.kind
	}
}

/**
 * roleNameOf(named, installation): the PostgreSQL role an installation installs for a login, a role, a served login or
 * the decoder login a served login names, the one function that names one: the stem the value carries (a login's or a
 * role's, computed as login(...) or role(...) built it; a served login's, its file's; a decoder login's, its file's live
 * source's), under the installation's role prefix (core/identity.ts roleInSpace), as migrate creates it and a layer's
 * pool logs in. A login's is the one that logs in: the role a password is set on, `rds_iam` is granted to and an IAM
 * signer names. A decoder login's, `roleNameOf(WebServed.decoder, connection)` once its kind is `decoderLogin`, is the
 * one LiveSource.layer logs in as, whose password is the layer's. A role's is the one a direct SQL writer's `SET ROLE`
 * names. The installation is the connection, or any part of it (`{}` for one without a role prefix). It reads the stem
 * and evaluates no schema, so the runtime entry loads none of the compiler. It throws CompileError for a login's or a
 * role's name the naming door refused (MalformedDescription, RoleNameTooLong), for a role prefix it refuses
 * (MalformedDescription), and for a role the prefix takes past PostgreSQL's 63 bytes (RoleNameTooLong).
 */
export const roleNameOf = <L>(
	named: AnyLogin | AnyRole | ServedLogin<L> | DecoderLogin,
	installation: RoleInstallation
): string => {
	const { stem, at, of } = stemmed(named)
	const space = roleSpaceOf(installation.rolePrefix)
	if (!space.ok) {
		throw malformedDescription(
			SourceLoc("roleNameOf", []),
			`the role prefix ${Formatter.format(installation.rolePrefix)}, used verbatim, as ${rolePrefixFaultText(space.error)}`
		)
	}
	const role = roleInSpace(space.value, stem)
	if (!role.ok) {
		throw CompileError.make({ _tag: "RoleNameTooLong", at, of, ...role.error })
	}
	return role.value
}
