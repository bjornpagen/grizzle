import { boolean, constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { Array as Arr, Record } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { isResidual } from "#test/pg/laws/families/model.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import type { Variant } from "#test/support/worlds/invalid/kinds.ts"
import { rowSecured } from "#test/support/worlds/model/session/catalog.ts"
import { writtenNamed } from "#test/support/worlds/model/session/writes.ts"
import type {
	BaseSpec,
	CatalogPerturbation,
	FieldSpec,
	LawIds,
	ModelState,
	RelationSpec,
	RoleSpec,
	TablePrivilege,
	TriggerRef,
	WorldFunction
} from "#test/support/worlds/model/types.ts"
import { definedWorldFunctions } from "#test/support/worlds/privileges.ts"

const privileges: Arr.NonEmptyReadonlyArray<TablePrivilege> = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE"
]

const attributes = [
	"SUPERUSER",
	"BYPASSRLS",
	"CREATEROLE",
	"CREATEDB",
	"REPLICATION",
	"LOGIN",
	"INHERIT"
] as const

/** One of a non-empty list's values, or none to draw when it is empty. */
const among = <A>(items: ReadonlyArray<A>): Gen<A> | undefined => {
	const [first, ...rest] = items
	return first === undefined ? undefined : element([first, ...rest])
}

/** A draw made into another value by `f`, or none to draw when there is no draw. */
const through = <A, B>(gen: Gen<A> | undefined, f: (value: A) => B): Gen<B> | undefined =>
	gen === undefined ? undefined : map(gen, f)

/** Every law identity of the installation: each primary key's and each declared law's. */
export const lawIdsOf = (state: ModelState): Arr.NonEmptyReadonlyArray<LawId> =>
	knownNonEmpty(
		[...Record.values(state.names.primaryKeys), ...Arr.flatMap(state.names.laws, identitiesOf)],
		"the installation's law identities"
	)

/** Every identity one declared law carries: its own, or an alternatives law's arms and reverse. */
const identitiesOf = (ids: LawIds): ReadonlyArray<LawId> => {
	switch (ids.kind) {
		case "key":
		case "spanKey":
		case "check":
		case "contained":
		case "covered":
		case "capacity":
			return [ids.law]
		case "alternatives":
			return [...Record.values(ids.arms), ids.reverse]
	}
}

/**
 * Every function a direct writer may try to call: the installation's own, and a function for every law, native ones
 * included.
 */
export const worldFunctionsOf = (state: ModelState): Arr.NonEmptyReadonlyArray<WorldFunction> => {
	const base = state.install.base
	const queries = Arr.flatMap(state.install.roles, (role) =>
		Arr.flatMap(Record.toEntries(role.entries), ([entry, spec]) =>
			spec.kind === "query" ? [{ role: role.name, entry }] : []
		)
	)
	return knownNonEmpty(
		[
			...Arr.map(queries, (q): WorldFunction => ({ kind: "filter", role: q.role, entry: q.entry })),
			...Arr.map(queries, (q): WorldFunction => ({
				kind: "key-probe",
				role: q.role,
				entry: q.entry,
				key: 0
			})),
			...Arr.flatMap(base.relations, (r) =>
				Arr.flatMap(r.fields, (f): ReadonlyArray<WorldFunction> =>
					f.domain.kind === "serial" ? [{ kind: "advance", relation: r.name, field: f.name }] : []
				)
			),
			...Arr.map(lawIdsOf(state), (law): WorldFunction => ({ kind: "law", law }))
		],
		"the installation's functions"
	)
}

/**
 * The identities of the laws the installation enforces by its own function and triggers: the residual ones. A native law
 * is a constraint, with no function or trigger to perturb.
 */
const residualLawIds = (state: ModelState): ReadonlyArray<LawId> => [
	...new Set(Arr.flatMap(state.host.laws, (l) => (isResidual(l) ? [l.law] : [])))
]

/** Every function the installation defines, which a perturbation may redefine: a native law's is none of them. */
const installedFunctionsOf = (state: ModelState): ReadonlyArray<WorldFunction> => [
	...definedWorldFunctions(state.install),
	...Arr.map(residualLawIds(state), (law): WorldFunction => ({ kind: "law", law }))
]

/** Every trigger the installation defines: each residual law's, and each relation's below-SERIALIZABLE guard. */
const triggersOf = (state: ModelState): Arr.NonEmptyReadonlyArray<TriggerRef> =>
	knownNonEmpty(
		[
			...Arr.map(residualLawIds(state), (law): TriggerRef => ({ kind: "law", law })),
			...Arr.map(state.install.base.relations, (r): TriggerRef => ({
				kind: "isolation-guard",
				relation: r.name
			}))
		],
		"the installation's triggers"
	)

/**
 * The entries that hold a row-security policy: those their role writes into a table with row security, which some
 * role's entry narrows (session/catalog.ts rowSecured). A table no entry narrows has no policy to drop or edit.
 */
const policied = (
	state: ModelState
): ReadonlyArray<{ readonly role: string; readonly entry: string }> =>
	Arr.flatMap(state.install.roles, (r: RoleSpec) =>
		Arr.flatMap(r.write, (entry: string) => {
			const w = writtenNamed(state.install.base, r, entry)
			return w !== undefined && rowSecured(state.install, w.target) ? [{ role: r.name, entry }] : []
		})
	)

/** The entries installed as views: every entry but a whole entry over a closed roster, which programs inline. */
const viewed = (
	state: ModelState
): ReadonlyArray<{ readonly role: string; readonly entry: string }> =>
	Arr.flatMap(state.install.roles, (r: RoleSpec) =>
		Arr.flatMap(
			Record.toEntries(r.entries),
			([entry, spec]): ReadonlyArray<{ readonly role: string; readonly entry: string }> =>
				spec.kind === "whole" &&
				Arr.some(state.install.base.closed, (c) => c.name === spec.relation)
					? []
					: [{ role: r.name, entry }]
		)
	)

/** The fields a column default may be set on: every one but a serial, an identity column that takes no default. */
const defaultable = (
	state: ModelState
): ReadonlyArray<{ readonly relation: string; readonly field: string }> =>
	Arr.flatMap(state.install.base.relations, (r: RelationSpec) =>
		Arr.map(
			Arr.filter(r.fields, (f: FieldSpec) => f.domain.kind !== "serial"),
			(f: FieldSpec) => ({ relation: r.name, field: f.name })
		)
	)

/**
 * Every perturbation kind of the catalog, each over the state's logins, roles, entries, relations, fields, functions
 * and triggers with every option combination of its own, the inert ones (a setting another database holds, an extra
 * membership that confers nothing, row security re-enabled) as much as the refused ones. A kind the installation offers
 * nothing to (no login with a role of its own) is left out.
 */
export const catalogVariants = (state: ModelState): ReadonlyArray<Variant<CatalogPerturbation>> => {
	const install = state.install
	const base = install.base
	const logins = Arr.map(install.logins, (l) => l.name)
	const memberships = Arr.flatMap(install.logins, (l) =>
		Arr.map(l.roles, (role) => ({ login: l.name, role }))
	)
	const roles = Arr.map(install.roles, (r) => r.name)
	const relations = Arr.map(base.relations, (r) => r.name)
	const fields = Arr.flatMap(base.relations, (r) =>
		Arr.map(r.fields, (f) => ({ relation: r.name, field: f.name }))
	)
	const nullable = nullableFields(base)
	const membershipGen = among(memberships)
	const loginGen = among(logins)
	const roleGen = among(roles)
	const relationGen = among(relations)
	const policiedGen = among(policied(state))
	const viewedGen = among(viewed(state))
	const defaultableGen = among(defaultable(state))
	const fieldGen = among(fields)
	const nullableGen = among(nullable)
	const fnGen = among(installedFunctionsOf(state))
	const variants: ReadonlyArray<
		readonly [CatalogPerturbation["kind"], Gen<CatalogPerturbation> | undefined]
	> = [
		[
			"membership-admin",
			through(membershipGen, (m): CatalogPerturbation => ({
				kind: "membership-admin",
				login: m.login,
				role: m.role
			}))
		],
		[
			"membership-inherit",
			through(membershipGen, (m): CatalogPerturbation => ({
				kind: "membership-inherit",
				login: m.login,
				role: m.role
			}))
		],
		[
			"membership-revoked",
			through(membershipGen, (m): CatalogPerturbation => ({
				kind: "membership-revoked",
				login: m.login,
				role: m.role
			}))
		],
		[
			"membership-extra",
			loginGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "membership-extra",
						login: source.draw(loginGen),
						inherit: source.draw(boolean),
						set: source.draw(boolean),
						holds: source.draw(element(["nothing", "a-privilege"] as const))
					})
		],
		[
			"member-extra",
			roleGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "member-extra",
						role: source.draw(roleGen),
						set: source.draw(boolean)
					})
		],
		[
			"role-attribute",
			roleGen === undefined || loginGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "role-attribute",
						role: source.draw(oneOf([roleGen, loginGen])),
						attribute: source.draw(element(attributes))
					})
		],
		[
			"role-setting",
			roleGen === undefined || loginGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "role-setting",
						who: source.draw(
							oneOf<
								| { readonly kind: "login"; readonly login: string }
								| { readonly kind: "role"; readonly role: string }
							>([
								map(loginGen, (login) => ({ kind: "login", login })),
								map(roleGen, (role) => ({ kind: "role", role }))
							])
						),
						scope: source.draw(element(["own", "this-database"] as const)),
						change: source.draw(element(["default-reset", "default-changed", "extra"] as const))
					})
		],
		[
			"database-setting",
			map(
				element(["isolation-changed", "isolation-reset", "owner-setting"] as const),
				(change): CatalogPerturbation => ({ kind: "database-setting", change })
			)
		],
		[
			"row-security",
			relationGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "row-security",
						relation: source.draw(relationGen),
						state: source.draw(element(["disabled", "forced", "enabled"] as const))
					})
		],
		[
			"extra-grant",
			roleGen === undefined || relationGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "extra-grant",
						role: source.draw(roleGen),
						relation: source.draw(relationGen),
						privilege: source.draw(element(privileges))
					})
		],
		[
			"grant-revoked",
			roleGen === undefined || relationGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "grant-revoked",
						role: source.draw(roleGen),
						relation: source.draw(relationGen),
						privilege: source.draw(element(privileges))
					})
		],
		[
			"extra-column-grant",
			roleGen === undefined || fieldGen === undefined
				? undefined
				: (source): CatalogPerturbation => {
						const role = source.draw(roleGen)
						const at = source.draw(fieldGen)
						return {
							kind: "extra-column-grant",
							role,
							relation: at.relation,
							field: at.field,
							privilege: source.draw(element(["SELECT", "INSERT", "UPDATE"] as const))
						}
					}
		],
		[
			"inherited-grant",
			roleGen === undefined || relationGen === undefined
				? undefined
				: (source): CatalogPerturbation => ({
						kind: "inherited-grant",
						role: source.draw(roleGen),
						relation: source.draw(relationGen),
						privilege: source.draw(element(privileges))
					})
		],
		[
			"public-grant",
			through(relationGen, (relation): CatalogPerturbation => ({ kind: "public-grant", relation }))
		],
		[
			"policy-dropped",
			through(policiedGen, (e): CatalogPerturbation => ({ kind: "policy-dropped", ...e }))
		],
		[
			"policy-edited",
			through(policiedGen, (e): CatalogPerturbation => ({ kind: "policy-edited", ...e }))
		],
		[
			"view-redefined",
			through(viewedGen, (e): CatalogPerturbation => ({ kind: "view-redefined", ...e }))
		],
		[
			"function-redefined",
			through(fnGen, (fn): CatalogPerturbation => ({ kind: "function-redefined", fn }))
		],
		[
			"search-path-altered",
			through(fnGen, (fn): CatalogPerturbation => ({ kind: "search-path-altered", fn }))
		],
		[
			"default-privileges",
			map(element(["EXECUTE", "USAGE"] as const), (privilege): CatalogPerturbation => ({
				kind: "default-privileges",
				privilege
			}))
		],
		[
			"column-default",
			through(defaultableGen, (f): CatalogPerturbation => ({ kind: "column-default", ...f }))
		],
		[
			"not-null-dropped",
			through(nullableGen, (f): CatalogPerturbation => ({ kind: "not-null-dropped", ...f }))
		],
		["extra-index", through(fieldGen, (f): CatalogPerturbation => ({ kind: "extra-index", ...f }))],
		["extra-table", constant<CatalogPerturbation>({ kind: "extra-table" })],
		[
			"rewrite-rule",
			through(relationGen, (relation): CatalogPerturbation => ({ kind: "rewrite-rule", relation }))
		],
		[
			"trigger-disabled",
			map(element(triggersOf(state)), (trigger): CatalogPerturbation => ({
				kind: "trigger-disabled",
				trigger
			}))
		]
	]
	return Arr.flatMap(variants, ([kind, gen]) =>
		gen === undefined ? [] : [{ invalid: `catalog:${kind}` as const, gen }]
	)
}

/**
 * The fields whose NOT NULL a person may drop: those outside their relation's primary key, whose NOT NULL PostgreSQL
 * keeps while the key stands (42P16), and other than a serial, an identity column whose NOT NULL PostgreSQL keeps while
 * it is one (42601). A relation that is all key and serial offers none.
 */
const nullableFields = (
	base: BaseSpec
): ReadonlyArray<{ readonly relation: string; readonly field: string }> =>
	Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f) =>
			r.key.includes(f.name) || f.domain.kind === "serial"
				? []
				: [{ relation: r.name, field: f.name }]
		)
	)

/**
 * Every perturbation of the catalog over the state with each option at each value, the entities each kind ranges over
 * cut to their first: the exhaustive box's tamper actions, every option combination of every kind once.
 */
export const enumeratePerturbations = (state: ModelState): ReadonlyArray<CatalogPerturbation> => {
	const install = state.install
	const base = install.base
	const [login] = install.logins
	const role = login.roles[0]
	const [relation] = base.relations
	const field = relation.fields[0].name
	const firstPolicied = Arr.take(policied(state), 1)
	const firstViewed = Arr.take(viewed(state), 1)
	const firstDefaultable = Arr.take(defaultable(state), 1)
	const bools = [false, true] as const
	return [
		{ kind: "membership-admin", login: login.name, role },
		{ kind: "membership-inherit", login: login.name, role },
		{ kind: "membership-revoked", login: login.name, role },
		...Arr.flatMap(bools, (inherit) =>
			Arr.flatMap(bools, (set) =>
				Arr.map(["nothing", "a-privilege"] as const, (holds): CatalogPerturbation => ({
					kind: "membership-extra",
					login: login.name,
					inherit,
					set,
					holds
				}))
			)
		),
		...Arr.map(bools, (set): CatalogPerturbation => ({ kind: "member-extra", role, set })),
		...Arr.flatMap(attributes, (attribute): ReadonlyArray<CatalogPerturbation> => [
			{ kind: "role-attribute", role, attribute },
			{ kind: "role-attribute", role: login.name, attribute }
		]),
		...Arr.flatMap(
			[
				{ kind: "login" as const, login: login.name },
				{ kind: "role" as const, role }
			],
			(who) =>
				Arr.flatMap(["own", "this-database"] as const, (scope) =>
					Arr.map(
						["default-reset", "default-changed", "extra"] as const,
						(change): CatalogPerturbation => ({
							kind: "role-setting",
							who,
							scope,
							change
						})
					)
				)
		),
		...Arr.map(
			["isolation-changed", "isolation-reset", "owner-setting"] as const,
			(change): CatalogPerturbation => ({ kind: "database-setting", change })
		),
		...Arr.map(["disabled", "forced", "enabled"] as const, (s): CatalogPerturbation => ({
			kind: "row-security",
			relation: relation.name,
			state: s
		})),
		...Arr.flatMap(privileges, (privilege): ReadonlyArray<CatalogPerturbation> => [
			{ kind: "extra-grant", role, relation: relation.name, privilege },
			{ kind: "grant-revoked", role, relation: relation.name, privilege },
			{ kind: "inherited-grant", role, relation: relation.name, privilege }
		]),
		...Arr.map(["SELECT", "INSERT", "UPDATE"] as const, (privilege): CatalogPerturbation => ({
			kind: "extra-column-grant",
			role,
			relation: relation.name,
			field,
			privilege
		})),
		{ kind: "public-grant", relation: relation.name },
		...Arr.map(firstPolicied, (e): CatalogPerturbation => ({ kind: "policy-dropped", ...e })),
		...Arr.map(firstPolicied, (e): CatalogPerturbation => ({ kind: "policy-edited", ...e })),
		...Arr.map(firstViewed, (e): CatalogPerturbation => ({ kind: "view-redefined", ...e })),
		...Arr.flatMap(
			Arr.take(installedFunctionsOf(state), 1),
			(fn): ReadonlyArray<CatalogPerturbation> => [
				{ kind: "function-redefined", fn },
				{ kind: "search-path-altered", fn }
			]
		),
		{ kind: "default-privileges", privilege: "EXECUTE" },
		{ kind: "default-privileges", privilege: "USAGE" },
		...Arr.map(firstDefaultable, (f): CatalogPerturbation => ({ kind: "column-default", ...f })),
		...Arr.map(Arr.take(nullableFields(base), 1), (f): CatalogPerturbation => ({
			kind: "not-null-dropped",
			...f
		})),
		{ kind: "extra-index", relation: relation.name, field },
		{ kind: "extra-table" },
		{ kind: "rewrite-rule", relation: relation.name },
		{ kind: "trigger-disabled", trigger: triggersOf(state)[0] }
	]
}
