import { Array as Arr, Equal, Option, Order } from "effect"
import type { Catalog, CatalogGrant, CatalogMembership } from "#test/support/catalog/read.ts"

/**
 * What a function of the installation is, by the object that installs it, which decides how it is installed and who
 * may execute it: a world's function (a writable query entry's filter function, key probe or unique probe), a serial
 * field's advance function, moving the identity sequence of `table`, the refusal function, the snapshot guard, a law
 * function, or the isolation guard.
 */
export type InstalledFunction =
	| { readonly kind: "world" }
	| { readonly kind: "advance"; readonly table: string }
	| { readonly kind: "refusal" }
	| { readonly kind: "snapshotGuard" }
	| { readonly kind: "law" }
	| { readonly kind: "isolationGuard" }

/** What a trigger of the installation is: a law trigger, or the isolation guard every table carries. */
export type InstalledTrigger = "law" | "isolation"

export interface ErasureExpectation {
	/** The authored stored relations' table names. */
	readonly tables: ReadonlySet<string>
	/** The table names of the mutable relations: the only ones a non-owner role may UPDATE. */
	readonly mutable: ReadonlySet<string>
	/** The materialized views of the derived relations. */
	readonly views: ReadonlySet<string>
	/** The migrations ledger's table: the one table beside the authored ones, which every login reads. */
	readonly ledger: string
	/** Every function the installation includes, by its name, as what it is. */
	readonly functions: ReadonlyMap<string, InstalledFunction>
	/** Every trigger the installation includes but PostgreSQL's internal ones, by its name, as what it is. */
	readonly triggers: ReadonlyMap<string, InstalledTrigger>
	/** The tables some world's entry narrows: the only ones with row security, and the only ones with policies. */
	readonly rowSecure: ReadonlySet<string>
	/** Each login's PostgreSQL role, and its worlds' roles, each also its world's schema. */
	readonly logins: ReadonlyMap<string, ReadonlySet<string>>
	/** Each world role's refreshed materialized views: the only MAINTAIN it holds. */
	readonly refreshes: ReadonlyMap<string, ReadonlySet<string>>
	/** The query entries' views, `<world schema>.<view>`: the only security_barrier views. */
	readonly barrierViews: ReadonlySet<string>
}

/** An object of the installation a problem names: a relation is a table or a materialized view of the schema. */
export type CatalogObject =
	| { readonly kind: "schema"; readonly name: string }
	| { readonly kind: "relation"; readonly name: string }
	| { readonly kind: "column"; readonly relation: string; readonly column: string }
	| { readonly kind: "sequence"; readonly name: string }
	| { readonly kind: "enum"; readonly name: string }
	| { readonly kind: "domain"; readonly name: string }
	| { readonly kind: "function"; readonly name: string }
	| { readonly kind: "world"; readonly name: string }
	| { readonly kind: "view"; readonly world: string; readonly name: string }

/** Which side of a role's memberships a problem reads: the roles it is a member of, or its members. */
export type MembershipSide = "memberOf" | "members"

/**
 * One way an installed catalog departs from the erasure ledger's shape, by the rule it breaks and the catalog facts that
 * break it. A membership problem carries the membership as the side it reads holds it, `role` its other role.
 */
export type ErasureProblem =
	| { readonly kind: "publicHolds"; readonly object: CatalogObject; readonly privilege: string }
	| {
			readonly kind: "loginHolds"
			readonly object: CatalogObject
			readonly login: string
			readonly privilege: string
	  }
	| {
			readonly kind: "loginLacks"
			readonly object: CatalogObject
			readonly login: string
			readonly privilege: string
	  }
	| {
			readonly kind: "strangerHolds"
			readonly object: CatalogObject
			readonly grantee: string
			readonly privilege: string
	  }
	| {
			readonly kind: "roleHolds"
			readonly object: CatalogObject
			readonly role: string
			readonly privilege: string
	  }
	| { readonly kind: "truncate"; readonly relation: string; readonly grantee: string }
	| { readonly kind: "immutableUpdate"; readonly object: CatalogObject; readonly grantee: string }
	| { readonly kind: "maintainBeyondRefresh"; readonly view: string; readonly grantee: string }
	| { readonly kind: "maintainMissing"; readonly view: string; readonly role: string }
	| { readonly kind: "undeclaredView"; readonly view: string }
	| { readonly kind: "foreignRelation"; readonly relation: string; readonly relkind: string }
	| { readonly kind: "unexpectedTable"; readonly table: string }
	| { readonly kind: "guardCount"; readonly table: string; readonly count: number }
	| { readonly kind: "misowned"; readonly object: CatalogObject; readonly owner: string }
	| { readonly kind: "rowSecurityUnneeded"; readonly table: string }
	| { readonly kind: "rowSecurityMissing"; readonly table: string }
	| { readonly kind: "rowSecurityForced"; readonly table: string }
	| { readonly kind: "domainNotNull"; readonly domain: string }
	| { readonly kind: "notSecurityDefiner"; readonly function: string }
	| { readonly kind: "searchPathUnfixed"; readonly function: string }
	| { readonly kind: "planCacheUnfixed"; readonly function: string }
	| {
			readonly kind: "volatility"
			readonly function: string
			readonly required: "STABLE" | "VOLATILE"
	  }
	| {
			readonly kind: "worldFunctionExecutors"
			readonly function: string
			readonly executors: ReadonlyArray<string>
	  }
	| {
			readonly kind: "advanceWithoutInsert"
			readonly function: string
			readonly role: string
			readonly table: string
	  }
	| {
			readonly kind: "insertWithoutAdvance"
			readonly function: string
			readonly role: string
			readonly table: string
	  }
	| { readonly kind: "foreignFunction"; readonly function: string }
	| { readonly kind: "advanceMissing"; readonly function: string; readonly table: string }
	| { readonly kind: "triggerDisabled"; readonly trigger: string; readonly table: string }
	| { readonly kind: "malformedGuard"; readonly table: string }
	| { readonly kind: "foreignTrigger"; readonly trigger: string; readonly table: string }
	| { readonly kind: "triggerNotDeferred"; readonly trigger: string; readonly table: string }
	| {
			readonly kind: "lawTriggerEvents"
			readonly trigger: string
			readonly table: string
			readonly type: number
	  }
	| {
			readonly kind: "lawFunctionExecutors"
			readonly function: string
			readonly triggers: ReadonlyArray<string>
	  }
	| { readonly kind: "isolationDefault" }
	| { readonly kind: "inertPolicy"; readonly policy: string; readonly table: string }
	| { readonly kind: "policyCommand"; readonly policy: string; readonly table: string }
	| {
			readonly kind: "policyRoles"
			readonly policy: string
			readonly table: string
			readonly roles: ReadonlyArray<string>
	  }
	| { readonly kind: "policyPredicates"; readonly policy: string; readonly table: string }
	| { readonly kind: "foreignType"; readonly type: string }
	| { readonly kind: "elevated"; readonly role: string }
	| { readonly kind: "loginCannotLogIn"; readonly role: string }
	| { readonly kind: "loginInherits"; readonly role: string }
	| {
			readonly kind: "membershipOptions"
			readonly role: string
			readonly side: MembershipSide
			readonly membership: CatalogMembership
	  }
	| {
			readonly kind: "membershipBeyond"
			readonly role: string
			readonly side: MembershipSide
			readonly membership: CatalogMembership
	  }
	| {
			readonly kind: "membershipMissing"
			readonly role: string
			readonly side: MembershipSide
			readonly other: string
	  }
	| { readonly kind: "loginDatabaseSetting"; readonly role: string; readonly setting: string }
	| { readonly kind: "worldRoleLogsIn"; readonly role: string }
	| { readonly kind: "worldRoleSetting"; readonly role: string; readonly setting: string }
	| { readonly kind: "undeclaredRole"; readonly role: string }
	| { readonly kind: "inheritsOwner"; readonly role: string }
	| {
			readonly kind: "inheritsPrivilege"
			readonly role: string
			readonly from: string
			readonly object: CatalogObject
			readonly privilege: string
	  }
	| { readonly kind: "roleMissing"; readonly role: string }
	| { readonly kind: "orphanWorld"; readonly world: string }
	| {
			readonly kind: "strayWorldGrant"
			readonly object: CatalogObject
			readonly grantee: string
			readonly privilege: string
	  }
	| { readonly kind: "worldFunction"; readonly world: string; readonly function: string }
	| { readonly kind: "worldType"; readonly world: string; readonly type: string }
	| {
			readonly kind: "worldRelationKind"
			readonly world: string
			readonly relation: string
			readonly relkind: string
	  }
	| { readonly kind: "barrierMissing"; readonly world: string; readonly view: string }
	| { readonly kind: "barrierUnneeded"; readonly world: string; readonly view: string }
	| { readonly kind: "worldMissing"; readonly role: string }
	| { readonly kind: "defaultAclMissing"; readonly objectType: "f" | "T" }
	| {
			readonly kind: "defaultAclPublic"
			readonly schema: Option.Option<string>
			readonly objectType: string
			readonly privilege: string
	  }

/** The problem, unless the rule holds. */
const unless = (holds: boolean, problem: ErasureProblem): ReadonlyArray<ErasureProblem> =>
	holds ? [] : [problem]

/**
 * pg_trigger.tgtype of the isolation guard: statement level, BEFORE (2), INSERT (4), DELETE (8), UPDATE (16) and
 * TRUNCATE (32).
 */
const guardTriggerType = 2 + 4 + 8 + 16 + 32

/** The event bits of pg_trigger.tgtype: INSERT (4), DELETE (8), UPDATE (16) and TRUNCATE (32). */
const triggerEvents = [4, 8, 16, 32] as const

/**
 * A residual law's units as the catalog holds them: every law trigger fires on exactly one event, and every law function
 * is executed by exactly one trigger, a law trigger. A trigger of two events would dispatch on the event at run time
 * and queue what its WHEN cannot filter; a function two triggers share compiles its whole body once per trigger in each
 * backend.
 */
const lawUnitProblems = (j: Judging): ReadonlyArray<ErasureProblem> => {
	const laws = Arr.filter(
		j.catalog.triggers,
		(t) => !t.internal && j.expect.triggers.get(t.name) === "law"
	)
	const executors = new Map<string, Array<string>>()
	for (const t of j.catalog.triggers) {
		if (!t.internal && j.expect.functions.get(t.function)?.kind === "law") {
			const known = executors.get(t.function)
			if (known === undefined) {
				executors.set(t.function, [t.name])
			} else {
				known.push(t.name)
			}
		}
	}
	return [
		...Arr.flatMap(laws, (t) =>
			unless(Arr.filter(triggerEvents, (bit) => (t.type & bit) !== 0).length === 1, {
				kind: "lawTriggerEvents",
				trigger: t.name,
				table: t.table,
				type: t.type
			})
		),
		...Arr.flatMap([...j.expect.functions], ([name, expected]) => {
			const triggers = executors.get(name)
			return expected.kind === "law"
				? unless(triggers?.length === 1, {
						kind: "lawFunctionExecutors",
						function: name,
						triggers: triggers ?? []
					})
				: []
		})
	]
}

const allowed = {
	table: new Set(["SELECT", "INSERT", "DELETE", "UPDATE"]),
	view: new Set(["SELECT", "MAINTAIN"]),
	column: new Set(["SELECT", "INSERT", "UPDATE"]),
	usage: new Set(["USAGE"]),
	function: new Set(["EXECUTE"]),
	ledger: new Set(["SELECT"]),
	none: new Set<string>()
} as const

/** The search path every function grizzle installs fixes. */
const fixedSearchPath = "search_path=pg_catalog, pg_temp"

type Table = Catalog["tables"][number]
type Fn = Catalog["functions"][number]
type Trigger = Catalog["triggers"][number]
type Policy = Catalog["policies"][number]
type Role = Catalog["roles"][number]
type World = Catalog["worlds"][number]

/** A grant on one object of the installation. */
interface HeldGrant extends CatalogGrant {
	readonly object: CatalogObject
}

const on = (object: CatalogObject, grants: ReadonlyArray<CatalogGrant>): ReadonlyArray<HeldGrant> =>
	Arr.map(grants, (g) => ({ object, grantee: g.grantee, privilege: g.privilege }))

const columnGrants = (t: Table): ReadonlyArray<HeldGrant> =>
	Arr.map(t.columnGrants, (g) => ({
		object: { kind: "column", relation: t.name, column: g.column },
		grantee: g.grantee,
		privilege: g.privilege
	}))

/**
 * Every grant on an object of the installation: the schema, its relations and their columns, sequences, enums, domains
 * and functions, and each world's schema and views.
 */
const heldGrants = (catalog: Catalog): ReadonlyArray<HeldGrant> => [
	...on({ kind: "schema", name: catalog.schema }, catalog.schemaGrants),
	...Arr.flatMap(catalog.tables, (t) => [
		...on({ kind: "relation", name: t.name }, t.grants),
		...columnGrants(t)
	]),
	...Arr.flatMap(catalog.sequences, (q) => on({ kind: "sequence", name: q.name }, q.grants)),
	...Arr.flatMap(catalog.enums, (e) => on({ kind: "enum", name: e.name }, e.grants)),
	...Arr.flatMap(catalog.domains, (d) => on({ kind: "domain", name: d.name }, d.grants)),
	...Arr.flatMap(catalog.functions, (f) => on({ kind: "function", name: f.name }, f.grants)),
	...Arr.flatMap(catalog.worlds, (w) => [
		...on({ kind: "world", name: w.name }, w.grants),
		...Arr.flatMap(w.relations, (v) => on({ kind: "view", world: w.name, name: v.name }, v.grants))
	])
]

/** What judging one catalog reads beside the catalog itself. */
interface Judging {
	readonly catalog: Catalog
	readonly expect: ErasureExpectation
	readonly owner: string
	/** Every world's role the expectation declares. */
	readonly worldRoles: ReadonlySet<string>
}

/**
 * Every grant names the owner, a world role holding only what its object allows, or a login holding what admission and
 * a Db transaction take as the login (`forLogins`: USAGE on the schema, SELECT on the ledger, EXECUTE on the snapshot
 * guard, nothing elsewhere); PUBLIC holds nothing.
 */
const grantProblems = (
	j: Judging,
	held: ReadonlyArray<HeldGrant>,
	privileges: ReadonlySet<string>,
	forLogins: ReadonlySet<string>
): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap(held, (g): ReadonlyArray<ErasureProblem> => {
		if (g.grantee === j.owner) {
			return []
		}
		if (g.grantee === "PUBLIC") {
			return [{ kind: "publicHolds", object: g.object, privilege: g.privilege }]
		}
		if (j.expect.logins.has(g.grantee)) {
			return unless(forLogins.has(g.privilege), {
				kind: "loginHolds",
				object: g.object,
				login: g.grantee,
				privilege: g.privilege
			})
		}
		if (!j.worldRoles.has(g.grantee)) {
			return [
				{ kind: "strangerHolds", object: g.object, grantee: g.grantee, privilege: g.privilege }
			]
		}
		return unless(privileges.has(g.privilege), {
			kind: "roleHolds",
			object: g.object,
			role: g.grantee,
			privilege: g.privilege
		})
	})

/** Each login holds what admission and a Db transaction take as the login. */
const loginLacks = (
	j: Judging,
	object: CatalogObject,
	grants: ReadonlyArray<CatalogGrant>,
	privilege: string
): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap([...j.expect.logins.keys()], (login) =>
		unless(
			Arr.some(grants, (g) => g.grantee === login && g.privilege === privilege),
			{ kind: "loginLacks", object, login, privilege }
		)
	)

/**
 * What one catalog relation is to the installation: the materialized view of a declared derived relation or of none, a
 * table it expects (an authored relation's or the migrations ledger, carrying exactly one isolation guard) or one it
 * does not, or a relation of a kind grizzle never installs.
 */
const standingProblems = (j: Judging, t: Table): ReadonlyArray<ErasureProblem> => {
	if (t.kind === "m") {
		return unless(j.expect.views.has(t.name), { kind: "undeclaredView", view: t.name })
	}
	if (t.kind !== "r") {
		return [{ kind: "foreignRelation", relation: t.name, relkind: t.kind }]
	}
	if (!j.expect.tables.has(t.name) && t.name !== j.expect.ledger) {
		return [{ kind: "unexpectedTable", table: t.name }]
	}
	const count = Arr.filter(
		j.catalog.triggers,
		(g) => g.table === t.name && j.expect.triggers.get(g.name) === "isolation"
	).length
	return unless(count === 1, { kind: "guardCount", table: t.name, count })
}

/** What a non-owner's grant on a relation or a column of it confers: no TRUNCATE, UPDATE only when mutable, MAINTAIN only to a refresher. */
const conferredProblems = (j: Judging, t: Table, g: HeldGrant): ReadonlyArray<ErasureProblem> => {
	if (g.grantee === j.owner) {
		return []
	}
	if (g.privilege === "TRUNCATE") {
		return [{ kind: "truncate", relation: t.name, grantee: g.grantee }]
	}
	if (g.privilege === "UPDATE") {
		return unless(j.expect.mutable.has(t.name), {
			kind: "immutableUpdate",
			object: g.object,
			grantee: g.grantee
		})
	}
	if (g.privilege === "MAINTAIN") {
		return unless(j.expect.refreshes.get(g.grantee)?.has(t.name) === true, {
			kind: "maintainBeyondRefresh",
			view: t.name,
			grantee: g.grantee
		})
	}
	return []
}

const tableProblems = (j: Judging, t: Table): ReadonlyArray<ErasureProblem> => {
	const relation: CatalogObject = { kind: "relation", name: t.name }
	const ledger = t.kind === "r" && t.name === j.expect.ledger
	const own = on(relation, t.grants)
	const columns = columnGrants(t)
	return [
		...standingProblems(j, t),
		...unless(t.owner === j.owner, { kind: "misowned", object: relation, owner: t.owner }),
		...unless(
			t.rowSecurity === j.expect.rowSecure.has(t.name),
			t.rowSecurity
				? { kind: "rowSecurityUnneeded", table: t.name }
				: { kind: "rowSecurityMissing", table: t.name }
		),
		...unless(!t.forceRowSecurity, { kind: "rowSecurityForced", table: t.name }),
		...grantProblems(
			j,
			own,
			t.kind === "m" ? allowed.view : allowed.table,
			ledger ? allowed.ledger : allowed.none
		),
		...grantProblems(j, columns, allowed.column, allowed.none),
		...(ledger ? loginLacks(j, relation, t.grants, "SELECT") : []),
		...Arr.flatMap([...own, ...columns], (g) => conferredProblems(j, t, g))
	]
}

/** Every refresher holds MAINTAIN on each materialized view it refreshes. */
const refresherProblems = (j: Judging): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap([...j.expect.refreshes], ([role, views]) =>
		Arr.flatMap([...views], (view) =>
			Option.match(
				Arr.findFirst(j.catalog.tables, (x) => x.kind === "m" && x.name === view),
				{
					onNone: () => [],
					onSome: (t) =>
						unless(
							Arr.some(t.grants, (g) => g.grantee === role && g.privilege === "MAINTAIN"),
							{ kind: "maintainMissing", view, role }
						)
				}
			)
		)
	)

/** An advance function is executable by exactly the roles that insert into its table. */
const advanceProblems = (
	j: Judging,
	f: Fn,
	table: string,
	executors: ReadonlySet<string>
): ReadonlyArray<ErasureProblem> => {
	const installed = Arr.findFirst(j.catalog.tables, (t) => t.kind === "r" && t.name === table)
	const inserts = (role: string) =>
		Option.exists(installed, (t) =>
			Arr.some(
				[...t.grants, ...t.columnGrants],
				(g) => g.grantee === role && g.privilege === "INSERT"
			)
		)
	return [
		...grantProblems(
			j,
			on({ kind: "function", name: f.name }, f.grants),
			allowed.function,
			allowed.none
		),
		...Arr.flatMap([...executors], (role) =>
			unless(inserts(role), { kind: "advanceWithoutInsert", function: f.name, role, table })
		),
		...Arr.flatMap([...j.worldRoles], (role) =>
			unless(!inserts(role) || executors.has(role), {
				kind: "insertWithoutAdvance",
				function: f.name,
				role,
				table
			})
		)
	]
}

/**
 * A SECURITY DEFINER function grizzle installs, owned by the owner, its search_path fixed: a world's function is STABLE,
 * planned generically and executable by one role; every other is VOLATILE, planned per call, and is an advance
 * function, the refusal function (EXECUTE to world roles alone), the snapshot guard (EXECUTE to every login and no
 * role), or the isolation guard or a law function (EXECUTE to no one). A function the installation does not include is foreign, and
 * judged as one that grants EXECUTE to no one.
 */
const functionProblems = (j: Judging, f: Fn): ReadonlyArray<ErasureProblem> => {
	const object: CatalogObject = { kind: "function", name: f.name }
	const held = on(object, f.grants)
	/** The roles that may execute it; PUBLIC is judged by grantProblems. */
	const executors = new Set(
		Arr.flatMap(f.grants, (g) =>
			g.grantee === j.owner || g.grantee === "PUBLIC" ? [] : [g.grantee]
		)
	)
	const installed = [
		...unless(f.owner === j.owner, { kind: "misowned", object, owner: f.owner }),
		...unless(f.securityDefiner, { kind: "notSecurityDefiner", function: f.name }),
		...unless(Arr.contains(f.config, fixedSearchPath), {
			kind: "searchPathUnfixed",
			function: f.name
		})
	]
	const definer = [
		...installed,
		...unless(f.volatility === "v", { kind: "volatility", function: f.name, required: "VOLATILE" }),
		...unless(Arr.contains(f.config, "plan_cache_mode=force_custom_plan"), {
			kind: "planCacheUnfixed",
			function: f.name
		})
	]
	const expected = j.expect.functions.get(f.name)
	if (expected === undefined) {
		return [
			...definer,
			{ kind: "foreignFunction", function: f.name },
			...grantProblems(j, held, allowed.none, allowed.none)
		]
	}
	switch (expected.kind) {
		case "world":
			return [
				...installed,
				...unless(f.volatility === "s", {
					kind: "volatility",
					function: f.name,
					required: "STABLE"
				}),
				...unless(Arr.contains(f.config, "plan_cache_mode=force_generic_plan"), {
					kind: "planCacheUnfixed",
					function: f.name
				}),
				...grantProblems(j, held, allowed.function, allowed.none),
				...unless(executors.size <= 1, {
					kind: "worldFunctionExecutors",
					function: f.name,
					executors: Arr.sort([...executors], Order.String)
				})
			]
		case "advance":
			return [...definer, ...advanceProblems(j, f, expected.table, executors)]
		case "refusal":
			return [...definer, ...grantProblems(j, held, allowed.function, allowed.none)]
		case "snapshotGuard":
			return [
				...definer,
				...grantProblems(j, held, allowed.none, allowed.function),
				...loginLacks(j, object, f.grants, "EXECUTE")
			]
		case "law":
		case "isolationGuard":
			return [...definer, ...grantProblems(j, held, allowed.none, allowed.none)]
	}
}

/**
 * Every trigger is enabled, and is PostgreSQL's internal foreign-key trigger, the isolation guard (running the isolation
 * guard function), or a law trigger: a DEFERRABLE INITIALLY DEFERRED constraint trigger.
 */
const triggerProblems = (j: Judging, t: Trigger): ReadonlyArray<ErasureProblem> => {
	const enabled = unless(t.enabled === "O", {
		kind: "triggerDisabled",
		trigger: t.name,
		table: t.table
	})
	if (t.internal) {
		return enabled
	}
	const expected = j.expect.triggers.get(t.name)
	if (expected === "isolation") {
		return [
			...enabled,
			...unless(
				!t.constraint &&
					t.type === guardTriggerType &&
					j.expect.functions.get(t.function)?.kind === "isolationGuard",
				{ kind: "malformedGuard", table: t.table }
			)
		]
	}
	return [
		...enabled,
		...unless(expected === "law", { kind: "foreignTrigger", trigger: t.name, table: t.table }),
		...unless(t.constraint && t.deferrable && t.deferred, {
			kind: "triggerNotDeferred",
			trigger: t.name,
			table: t.table
		})
	]
}

/**
 * Every policy is on a table with row security, where it is not inert, and is a permissive FOR ALL policy of the one
 * world role it is named after, whose USING and WITH CHECK are one predicate.
 */
const policyProblems = (j: Judging, p: Policy): ReadonlyArray<ErasureProblem> => [
	...unless(j.expect.rowSecure.has(p.table), {
		kind: "inertPolicy",
		policy: p.name,
		table: p.table
	}),
	...unless(p.command === "*" && p.permissive, {
		kind: "policyCommand",
		policy: p.name,
		table: p.table
	}),
	...unless(p.roles.length === 1 && p.roles[0] === p.name && j.worldRoles.has(p.name), {
		kind: "policyRoles",
		policy: p.name,
		table: p.table,
		roles: p.roles
	}),
	...unless(
		Option.exists(p.using, (u) => Option.exists(p.check, (c) => c === u)),
		{ kind: "policyPredicates", policy: p.name, table: p.table }
	)
]

/** A membership of a login in its world's role, seen from either side: SET ROLE to it, nothing inherited through it. */
const exact = (m: CatalogMembership) => !m.inherit && m.set && !m.admin
/** An extra membership of the role opens no SET ROLE path; what it passes on by inheritance is judged on its own. */
const noSetRole = (m: CatalogMembership) => !m.set && !m.admin
/** An extra member acts through the role in no way. */
const inert = (m: CatalogMembership) => !m.inherit && !m.set && !m.admin

/** The memberships of one side: each of `expected` held exactly, every other one `tolerated`. */
const membershipProblems = (
	role: string,
	side: MembershipSide,
	rows: ReadonlyArray<CatalogMembership>,
	expected: ReadonlySet<string>,
	tolerated: (m: CatalogMembership) => boolean
): ReadonlyArray<ErasureProblem> => [
	...Arr.flatMap(rows, (m) =>
		expected.has(m.role)
			? unless(exact(m), { kind: "membershipOptions", role, side, membership: m })
			: unless(tolerated(m), { kind: "membershipBeyond", role, side, membership: m })
	),
	...Arr.flatMap([...expected], (other) =>
		unless(
			Arr.some(rows, (m) => m.role === other),
			{ kind: "membershipMissing", role, side, other }
		)
	)
]

/** What a declared role inherits stays its own: no role it inherits from is the owner or holds what it does not. */
const inheritanceProblems = (
	j: Judging,
	held: ReadonlyArray<HeldGrant>,
	r: Role
): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap(r.inherits, (from) => [
		...unless(from !== j.owner, { kind: "inheritsOwner", role: r.name }),
		...Arr.flatMap(held, (g) =>
			unless(
				g.grantee !== from ||
					Arr.some(
						held,
						(o) =>
							o.grantee === r.name &&
							o.privilege === g.privilege &&
							Equal.equals(o.object, g.object)
					),
				{ kind: "inheritsPrivilege", role: r.name, from, object: g.object, privilege: g.privilege }
			)
		)
	])

const roleProblems = (
	j: Judging,
	held: ReadonlyArray<HeldGrant>,
	r: Role
): ReadonlyArray<ErasureProblem> => {
	const elevated = unless(
		!(r.superuser || r.createRole || r.createDb || r.replication || r.bypassRls),
		{
			kind: "elevated",
			role: r.name
		}
	)
	const worlds = j.expect.logins.get(r.name)
	if (worlds !== undefined) {
		return [
			...elevated,
			...unless(r.login, { kind: "loginCannotLogIn", role: r.name }),
			...unless(!r.inherit, { kind: "loginInherits", role: r.name }),
			...membershipProblems(r.name, "memberOf", r.memberOf, worlds, noSetRole),
			...membershipProblems(r.name, "members", r.members, new Set(), inert),
			...Arr.map(r.databaseConfig, (setting): ErasureProblem => ({
				kind: "loginDatabaseSetting",
				role: r.name,
				setting
			})),
			...inheritanceProblems(j, held, r)
		]
	}
	if (!j.worldRoles.has(r.name)) {
		return [...elevated, { kind: "undeclaredRole", role: r.name }]
	}
	const logins = new Set(
		Arr.flatMap([...j.expect.logins], ([login, roles]) => (roles.has(r.name) ? [login] : []))
	)
	return [
		...elevated,
		...unless(!r.login, { kind: "worldRoleLogsIn", role: r.name }),
		...membershipProblems(r.name, "memberOf", r.memberOf, new Set(), noSetRole),
		...membershipProblems(r.name, "members", r.members, logins, inert),
		...Arr.map([...r.config, ...r.databaseConfig], (setting): ErasureProblem => ({
			kind: "worldRoleSetting",
			role: r.name,
			setting
		})),
		...inheritanceProblems(j, held, r)
	]
}

const worldViewProblems = (
	j: Judging,
	w: World,
	v: World["relations"][number]
): ReadonlyArray<ErasureProblem> => {
	const object: CatalogObject = { kind: "view", world: w.name, name: v.name }
	const barrier = j.expect.barrierViews.has(`${w.name}.${v.name}`)
	return [
		...unless(v.kind === "v", {
			kind: "worldRelationKind",
			world: w.name,
			relation: v.name,
			relkind: v.kind
		}),
		...unless(v.owner === j.owner, { kind: "misowned", object, owner: v.owner }),
		...unless(
			Arr.contains(v.options, "security_barrier=true") === barrier,
			barrier
				? { kind: "barrierMissing", world: w.name, view: v.name }
				: { kind: "barrierUnneeded", world: w.name, view: v.name }
		),
		...Arr.flatMap(v.grants, (g) =>
			unless(g.grantee === j.owner || (g.grantee === w.name && g.privilege === "SELECT"), {
				kind: "strayWorldGrant",
				object,
				grantee: g.grantee,
				privilege: g.privilege
			})
		)
	]
}

/**
 * A world is a schema of its role, owned by the owner, holding only views (a query entry's security_barrier, a whole
 * entry's plain) and granting USAGE on itself and SELECT on its views to its own role alone.
 */
const worldProblems = (j: Judging, w: World): ReadonlyArray<ErasureProblem> => {
	if (!j.worldRoles.has(w.name)) {
		return [{ kind: "orphanWorld", world: w.name }]
	}
	const object: CatalogObject = { kind: "world", name: w.name }
	return [
		...unless(w.owner === j.owner, { kind: "misowned", object, owner: w.owner }),
		...Arr.flatMap(w.grants, (g) =>
			unless(g.grantee === j.owner || (g.grantee === w.name && g.privilege === "USAGE"), {
				kind: "strayWorldGrant",
				object,
				grantee: g.grantee,
				privilege: g.privilege
			})
		),
		...Arr.map(w.functions, (f): ErasureProblem => ({
			kind: "worldFunction",
			world: w.name,
			function: f
		})),
		...Arr.map(w.types, (t): ErasureProblem => ({ kind: "worldType", world: w.name, type: t })),
		...Arr.flatMap(w.relations, (v) => worldViewProblems(j, w, v))
	]
}

/**
 * The owner's default privileges grant PUBLIC nothing on future functions and types: both global entries exist, since
 * PostgreSQL deletes one that returns to the built-in default, and no entry of its names a PUBLIC grant.
 */
const defaultAclProblems = (j: Judging): ReadonlyArray<ErasureProblem> => [
	...Arr.flatMap(["f", "T"] as const, (objectType) =>
		unless(
			Arr.some(
				j.catalog.defaultAcls,
				(d) => d.role === j.owner && Option.isNone(d.schema) && d.objectType === objectType
			),
			{ kind: "defaultAclMissing", objectType }
		)
	),
	...Arr.flatMap(j.catalog.defaultAcls, (d): ReadonlyArray<ErasureProblem> =>
		d.role === j.owner
			? Arr.flatMap(d.grants, (g) =>
					unless(g.grantee !== "PUBLIC", {
						kind: "defaultAclPublic",
						schema: d.schema,
						objectType: d.objectType,
						privilege: g.privilege
					})
				)
			: []
	)
]

/**
 * The erasure-ledger catalog verifier (test/support/catalog).
 *
 * Given an installed catalog and what the schema declares, it lists every way the catalog departs from what a
 * PostgreSQL expert sharing grizzle's opinions would install and from the scope its installation declares, each as the
 * rule it breaks and the facts that break it. Which object is which is the expectation's, read from the installation
 * (installed.ts installedScope, by the manifest's object kinds) or from the naming door (declared.ts), never from a list
 * of names here:
 *
 * - only authored tables and the migrations ledger exist, plus the materialized views of declared derived relations;
 *   no plain view, foreign table, or other type beyond enums, domains and row types;
 * - the only functions are the refusal function, the isolation guard, the snapshot guard, law functions and each serial
 *   field's advance function, owned by the owner, SECURITY DEFINER, VOLATILE, with `search_path = pg_catalog, pg_temp`
 *   and `plan_cache_mode = force_custom_plan`, and the worlds' functions (each writable query entry's filter function
 *   and key and unique probes), owned by the owner, SECURITY DEFINER, STABLE, with the same search_path and
 *   `plan_cache_mode = force_generic_plan`; EXECUTE goes
 *   to no one on a law function or the isolation guard, to world roles alone on the refusal function, to exactly the
 *   logins on the snapshot guard, which every Db transaction calls as its login, to the one role whose entry it serves
 *   on a world's function, and on an advance function to exactly the world roles that insert into its table;
 * - the only triggers are law triggers, deferred constraint triggers, enabled, the isolation guard, and PostgreSQL's
 *   internal foreign-key triggers, enabled;
 * - every table the installation expects, the authored relations' and the migrations ledger, carries exactly one
 *   isolation guard trigger, BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT, running the isolation
 *   guard function, and the database defaults every transaction to SERIALIZABLE: README "Transactions and concurrency":
 *   "The first migration makes it the database's default" and "a write below it on a grizzle table is refused". A table it does not expect is drift
 *   in itself, reported once as such, never judged as a grizzle table;
 * - the grant shape: PUBLIC holds nothing on any schema object; a login holds exactly USAGE on the schema, SELECT on the
 *   migrations ledger and EXECUTE on the snapshot guard, which Db.open's admission and every Db transaction take as the
 *   login, and every other grant is the owner's or a world's role's; no role but the owner holds UPDATE, of the table
 *   or of a column, on an immutable relation (immutable by default is pinned) or TRUNCATE on any relation (TRUNCATE
 *   fires no row trigger and would bypass the laws); a table grants only SELECT, INSERT, DELETE and UPDATE, a
 *   materialized view SELECT and MAINTAIN, the latter to exactly the roles that refresh it, a column SELECT, INSERT and
 *   UPDATE, the schema, an enum and a domain USAGE, and an identity sequence nothing: a write moves it through the
 *   advance function;
 * - row security is enabled exactly on the tables some world's entry narrows, never forced, and only those tables carry
 *   policies: one per world role that writes the table, a permissive FOR ALL policy named after that role, whose USING
 *   and WITH CHECK are one predicate, `true` for a role whose entry holds every row; a table every world writes whole
 *   has neither, its grants alone deciding its writes;
 * - every world `<schema>__<role>` is a schema owned by the owner that holds only views, each owned by the owner, a
 *   query entry's a security_barrier view and a whole entry's a plain one (it hides nothing), and grants USAGE on
 *   itself and SELECT on its views to its own role alone;
 * - every declared login and world role is installed, and none holds an elevated attribute (SUPERUSER, CREATEDB,
 *   CREATEROLE, REPLICATION, BYPASSRLS); every login logs in, inherits nothing by default, stores no setting for this
 *   database alone, is a member of exactly its own worlds' roles, each WITH INHERIT FALSE, SET TRUE and no ADMIN, and
 *   has no member; every world role cannot log in, stores no setting (SET ROLE applies none), is a member of no role,
 *   and has exactly its logins as members, with those options, the owner's membership aside, which PostgreSQL grants
 *   the non-superuser that creates a role. A membership beyond these is tolerated when it opens no SET ROLE path: a
 *   role's extra membership WITH SET FALSE and no ADMIN, as an RDS IAM login holds `rds_iam`, and an extra member WITH
 *   INHERIT FALSE, SET FALSE and no ADMIN. What a declared role holds by inheritance is judged as its effective
 *   privileges, which must stay exactly its own: no role it inherits from is the owner, or holds a privilege on an
 *   object of the installation the declared role does not hold itself;
 * - the owner's default privileges grant PUBLIC nothing on future functions and types: its global entries for both
 *   exist, because PostgreSQL deletes one that returns to the built-in default, and name no PUBLIC grant.
 */
export const verifyErasure = (
	catalog: Catalog,
	expect: ErasureExpectation
): ReadonlyArray<ErasureProblem> => {
	const j: Judging = {
		catalog,
		expect,
		owner: catalog.owner,
		worldRoles: new Set(Arr.flatMap([...expect.logins.values()], (roles) => [...roles]))
	}
	const schema: CatalogObject = { kind: "schema", name: catalog.schema }
	const held = heldGrants(catalog)
	const declaredRoles = new Set([...expect.logins.keys(), ...j.worldRoles])
	return [
		...grantProblems(j, on(schema, catalog.schemaGrants), allowed.usage, allowed.usage),
		...loginLacks(j, schema, catalog.schemaGrants, "USAGE"),
		...Arr.flatMap(catalog.tables, (t) => tableProblems(j, t)),
		...refresherProblems(j),
		...Arr.flatMap(catalog.sequences, (q) =>
			grantProblems(j, on({ kind: "sequence", name: q.name }, q.grants), allowed.none, allowed.none)
		),
		...Arr.flatMap(catalog.enums, (e) =>
			grantProblems(j, on({ kind: "enum", name: e.name }, e.grants), allowed.usage, allowed.none)
		),
		...Arr.flatMap(catalog.domains, (d) => [
			...grantProblems(
				j,
				on({ kind: "domain", name: d.name }, d.grants),
				allowed.usage,
				allowed.none
			),
			...unless(!d.notNull, { kind: "domainNotNull", domain: d.name })
		]),
		...Arr.flatMap(catalog.functions, (f) => functionProblems(j, f)),
		...Arr.flatMap([...expect.functions], ([name, expected]) =>
			expected.kind === "advance"
				? unless(
						Arr.some(catalog.functions, (f) => f.name === name),
						{ kind: "advanceMissing", function: name, table: expected.table }
					)
				: []
		),
		...Arr.flatMap(catalog.triggers, (t) => triggerProblems(j, t)),
		...lawUnitProblems(j),
		...unless(
			Arr.contains(catalog.databaseSettings, "default_transaction_isolation=serializable"),
			{
				kind: "isolationDefault"
			}
		),
		...Arr.flatMap(catalog.policies, (p) => policyProblems(j, p)),
		...Arr.map(catalog.otherTypes, (type): ErasureProblem => ({ kind: "foreignType", type })),
		...Arr.flatMap(catalog.roles, (r) => roleProblems(j, held, r)),
		...Arr.flatMap([...declaredRoles], (role) =>
			unless(
				Arr.some(catalog.roles, (r) => r.name === role),
				{ kind: "roleMissing", role }
			)
		),
		...Arr.flatMap(catalog.worlds, (w) => worldProblems(j, w)),
		...Arr.flatMap([...j.worldRoles], (role) =>
			unless(
				Arr.some(catalog.worlds, (w) => w.name === role),
				{ kind: "worldMissing", role }
			)
		),
		...defaultAclProblems(j)
	]
}
