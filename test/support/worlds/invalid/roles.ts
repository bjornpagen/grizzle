import { constant, element, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { roleNames } from "#test/support/worlds/generate/install.ts"
import type { BoundaryArms, Variant } from "#test/support/worlds/invalid/kinds.ts"
import type { InstallSpec, LoginSpec, RoleRef } from "#test/support/worlds/model/types.ts"

/**
 * Role names no installation holds and none ever held, each one `role(...)` builds: a case variant of a real role,
 * padding, quoting, a separator, the PUBLIC pseudo-role, and a name past PostgreSQL's 63 bytes. `Db.open` takes a role
 * value, so these are the names a JavaScript caller can hand it.
 */
export const nonexistentNames = (install: InstallSpec): Arr.NonEmptyReadonlyArray<string> => {
	const [first] = install.roles
	return [
		"zeta",
		Str.toUpperCase(first.name),
		` ${first.name}`,
		`${first.name}"`,
		`${first.name};`,
		"public",
		"PUBLIC",
		Str.repeat(70)("r")
	]
}

/**
 * Role names a direct writer may spell that no role value carries, since `role(...)` refuses them: one holding a NUL,
 * and the empty name.
 */
const unbuildableNames = (install: InstallSpec): ReadonlyArray<string> => [
	`${install.roles[0].name}\u0000`,
	""
]

/**
 * The role names the harness gives roles that this installation does not hold: a role an earlier installation of the
 * run held and a migration dropped, as far as the state can tell.
 */
export const droppedNames = (install: InstallSpec): ReadonlyArray<string> =>
	Arr.filter(roleNames, (name) => !Arr.some(install.roles, (r) => r.name === name))

/** Who names a role: `Db.open`, whose layer is the role's own login's, or a direct writer logged in as a login. */
export type Namer = { readonly kind: "open" } | { readonly kind: "login"; readonly login: string }

/** The roles a namer holds as its own, and those of every other login. */
const rolesOf = (
	install: InstallSpec,
	namer: Namer
): { readonly own: Arr.NonEmptyReadonlyArray<string>; readonly others: ReadonlyArray<string> } => {
	switch (namer.kind) {
		case "open": {
			const all = knownNonEmpty(
				Arr.map(install.roles, (r) => r.name),
				"the roles"
			)
			return { own: all, others: install.logins.length > 1 ? all : [] }
		}
		case "login": {
			const login = Option.getOrThrowWith(
				Arr.findFirst(install.logins, (l) => l.name === namer.login),
				() => new Error(`the installation has no login ${namer.login}`)
			)
			return {
				own: login.roles,
				others: Arr.flatMap(
					Arr.filter(install.logins, (l) => l.name !== namer.login),
					(l: LoginSpec) => l.roles
				)
			}
		}
	}
}

/** A stale or wild variant of the names given, none when there are none. */
const variantOf = (
	invalid: "role:other-login" | "role:dropped",
	names: ReadonlyArray<string>
): ReadonlyArray<Variant<RoleRef>> => {
	const [first, ...rest] = names
	return first === undefined
		? []
		: [
				{
					invalid,
					gen: map(element([first, ...rest]), (role): RoleRef =>
						invalid === "role:dropped" ? { kind: "dropped", role } : { kind: "other-login", role }
					)
				}
			]
}

/**
 * The roles a namer names: its own login's (live), another login's or a dropped one (stale), and one that never
 * existed or the owner (wild); a direct writer may also spell a name no role value carries. For `Db.open` every role is its own login's in that login's layer, and other-login opens
 * it in another login's layer.
 */
export const roleArms = (install: InstallSpec, namer: Namer): BoundaryArms<RoleRef> => {
	const { own, others } = rolesOf(install, namer)
	const [firstOwn, ...moreOwn] = own
	const [firstName, ...moreNames] = nonexistentNames(install)
	const spelled = namer.kind === "login" ? unbuildableNames(install) : []
	return {
		live: map(element([firstOwn, ...moreOwn]), (role): RoleRef => ({ kind: "own", role })),
		stale: [
			...variantOf("role:other-login", others),
			...variantOf("role:dropped", droppedNames(install))
		],
		wild: [
			{
				invalid: "role:nonexistent",
				gen: map(element([firstName, ...moreNames, ...spelled]), (name): RoleRef => ({
					kind: "nonexistent",
					name
				}))
			},
			{ invalid: "role:owner", gen: constant<RoleRef>({ kind: "owner" }) }
		]
	}
}
