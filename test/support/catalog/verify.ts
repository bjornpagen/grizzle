import { Array as Arr, Equal, Option, Order, String as Str } from "effect"
import type {
	Catalog,
	CatalogGrant,
	CatalogMembership,
	CatalogPublishedTable
} from "#test/support/catalog/read.ts"

/**
 * What a function of the installation is, by the object that installs it, which decides how it is installed and who
 * may execute it: a world's function (a writable query entry's filter function, key probe or unique probe), a serial
 * field's advance function, moving the identity sequence of `table`, the refusal function, the snapshot guard, the
 * isolation guard, a rule over a query's trigger function, or a constant: a roster's names constant, which the roster domain `domain`'s CHECK reads; a
 * roster's live-codes constant, derived from the names constant `names` and read by the bits domain `domain`'s CHECK;
 * or a closed relation's or a side's constant, named by its content's digest.
 */
export type InstalledFunction =
	| { readonly kind: "world" }
	| { readonly kind: "advance"; readonly table: string }
	| { readonly kind: "refusal" }
	| { readonly kind: "snapshotGuard" }
	| { readonly kind: "isolationGuard" }
	| { readonly kind: "rule" }
	| { readonly kind: "names"; readonly domain: string }
	| { readonly kind: "live"; readonly domain: string }
	| {
			/** A closed relation's constant, the relation's own when `declared`, read by the CHECKs and generated columns
			 * of `tables`. */
			readonly kind: "closedConstant"
			readonly declared: boolean
			readonly tables: ReadonlyArray<string>
	  }

/**
 * What a trigger of the installation is: the isolation guard a guarded table carries, or a rule over a query's deferred
 * constraint trigger on a table its query reads.
 */
const installedTriggers = ["isolation", "rule"] as const

export type InstalledTrigger = (typeof installedTriggers)[number]

export interface ErasureExpectation {
	/** The authored stored relations' table names. */
	readonly tables: ReadonlySet<string>
	/** The table names of the mutable relations: the only ones a non-owner role may UPDATE. */
	readonly mutable: ReadonlySet<string>
	/** The materialized views of the derived relations. */
	readonly views: ReadonlySet<string>
	/** The migrations ledger's table: the one table beside the authored ones, which every login reads. */
	readonly ledger: string
	/**
	 * The tables carrying the isolation guard: the ledger's, and each authored table some role writes at SERIALIZABLE or
	 * no role writes (physical/ddl/isolation.ts addIsolationTrigger); a table whose every writer is certified READ
	 * COMMITTED carries none.
	 */
	readonly guarded: ReadonlySet<string>
	/** Every function the installation includes, by its name, as what it is. */
	readonly functions: ReadonlyMap<string, InstalledFunction>
	/** Every trigger the installation includes but PostgreSQL's internal ones, by its name, as what it is. */
	readonly triggers: ReadonlyMap<string, InstalledTrigger>
	/** The tables some world's entry narrows: the only ones with row security, and the only ones with policies. */
	readonly rowSecure: ReadonlySet<string>
	/** Each login, by its PostgreSQL role. */
	readonly logins: ReadonlyMap<string, ExpectedLogin>
	/** Each world role's refreshed materialized views: the only MAINTAIN it holds. */
	readonly refreshes: ReadonlyMap<string, ReadonlySet<string>>
	/** The query entries' views, `<world schema>.<view>`: the only security_barrier views. */
	readonly barrierViews: ReadonlySet<string>
	/**
	 * Whether the schema declares a closed relation, whose constants (each `__constant_<digest>`, named by its content)
	 * the installation holds besides the rosters'.
	 */
	readonly closedConstants: boolean
	/**
	 * The installation's live source (physical/ddl/live.ts): none, or its secret's table, which the decoder login alone
	 * reads, the decoder login, which holds USAGE on the schema and SELECT on the secret and nothing else, and its
	 * publication, the one publication of a table of the installation, which publishes its footprint tables and, where
	 * the ledger stands, the ledger.
	 */
	readonly liveSource:
		| { readonly kind: "none" }
		| {
				readonly kind: "source"
				readonly secret: string
				readonly decoder: string
				readonly publication: string
		  }
}

/**
 * One login of the installation: its worlds' roles, each also its world's schema, and the tables it fences
 * (physical/ddl/roles.ts InstalledLogin `fenced`), on each of which it holds MAINTAIN, the one privilege it holds on an
 * authored table.
 */
export interface ExpectedLogin {
	readonly roles: ReadonlySet<string>
	readonly fenced: ReadonlySet<string>
}

/** An object of the installation a problem names: a relation is a table or a materialized view of the schema. */
export type CatalogObject =
	| { readonly kind: "schema"; readonly name: string }
	| { readonly kind: "relation"; readonly name: string }
	| { readonly kind: "column"; readonly relation: string; readonly column: string }
	| { readonly kind: "sequence"; readonly name: string }
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
	| { readonly kind: "decoderLacks"; readonly object: CatalogObject; readonly privilege: string }
	| { readonly kind: "strangerPublished"; readonly publication: string; readonly table: string }
	| { readonly kind: "ledgerUnpublished"; readonly publication: string }
	| { readonly kind: "guardCount"; readonly table: string; readonly count: number }
	| { readonly kind: "misowned"; readonly object: CatalogObject; readonly owner: string }
	| { readonly kind: "rowSecurityUnneeded"; readonly table: string }
	| { readonly kind: "rowSecurityMissing"; readonly table: string }
	| { readonly kind: "rowSecurityForced"; readonly table: string }
	| { readonly kind: "domainNotNull"; readonly domain: string }
	| { readonly kind: "notSecurityDefiner"; readonly function: string }
	| { readonly kind: "searchPathUnfixed"; readonly function: string }
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
	| { readonly kind: "malformedRuleTrigger"; readonly trigger: string; readonly table: string }
	| { readonly kind: "enumLabels"; readonly count: number }
	| {
			/** A constant installed otherwise than as one: a function of arguments, VOLATILE or STABLE, SECURITY DEFINER,
			 * with a SET clause (which keeps PostgreSQL from inlining it), or not owned by the owner. */
			readonly kind: "constantShape"
			readonly function: string
			readonly reason: string
	  }
	| {
			/** A constant whose EXECUTE holders are not exactly the world roles whose USAGE, views or other constants call
			 * it: PostgreSQL checks EXECUTE on a function a domain's CHECK or a view calls against the invoker. */
			readonly kind: "constantExecutors"
			readonly function: string
			readonly missing: ReadonlyArray<string>
			readonly extra: ReadonlyArray<string>
	  }
	| {
			/** A roster's or a set's domain whose one CHECK does not read exactly its constant. */
			readonly kind: "domainCheckCalls"
			readonly domain: string
			readonly expected: string
			readonly calls: ReadonlyArray<ReadonlyArray<string>>
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

/** pg_trigger.tgtype's row-level bit, which a rule's trigger sets. */
const ruleTriggerLevel = 1

/** pg_trigger.tgtype's BEFORE and INSTEAD OF bits, neither of which a rule's AFTER trigger sets. */
const beforeOrInstead = 2 + 64

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
 * Every grant on an object of the installation: the schema, its relations and their columns, sequences, domains and
 * functions, and each world's schema and views.
 */
const heldGrants = (catalog: Catalog): ReadonlyArray<HeldGrant> => [
	...on({ kind: "schema", name: catalog.schema }, catalog.schemaGrants),
	...Arr.flatMap(catalog.tables, (t) => [
		...on({ kind: "relation", name: t.name }, t.grants),
		...columnGrants(t)
	]),
	...Arr.flatMap(catalog.sequences, (q) => on({ kind: "sequence", name: q.name }, q.grants)),
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

/** Whether `g` is a login's MAINTAIN on a table it fences, which its fenced writes lock before their snapshot. */
const fenceGrant = (login: ExpectedLogin, g: HeldGrant): boolean =>
	g.privilege === "MAINTAIN" && g.object.kind === "relation" && login.fenced.has(g.object.name)

/**
 * Every grant names the owner, a world role holding only what its object allows, or a login holding what admission and
 * a Db transaction take as the login (`forLogins`: USAGE on the schema, SELECT on the ledger, EXECUTE on the snapshot
 * guard, nothing elsewhere) and MAINTAIN on each table it fences (fenceGrant); PUBLIC holds nothing.
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
		const login = j.expect.logins.get(g.grantee)
		if (login !== undefined) {
			return unless(forLogins.has(g.privilege) || fenceGrant(login, g), {
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
 * table it expects (an authored relation's or the migrations ledger, carrying exactly one isolation guard when it is
 * guarded and none otherwise) or one it does not, or a relation of a kind grizzle never installs.
 */
const standingProblems = (j: Judging, t: Table): ReadonlyArray<ErasureProblem> => {
	if (t.kind === "m") {
		return unless(j.expect.views.has(t.name), { kind: "undeclaredView", view: t.name })
	}
	if (t.kind !== "r") {
		return [{ kind: "foreignRelation", relation: t.name, relkind: t.kind }]
	}
	if (!j.expect.tables.has(t.name) && t.name !== j.expect.ledger && !isSecret(j, t)) {
		return [{ kind: "unexpectedTable", table: t.name }]
	}
	const count = Arr.filter(
		j.catalog.triggers,
		(g) => g.table === t.name && j.expect.triggers.get(g.name) === "isolation"
	).length
	return unless(count === (j.expect.guarded.has(t.name) ? 1 : 0), {
		kind: "guardCount",
		table: t.name,
		count
	})
}

/**
 * What a non-owner's grant on a relation or a column of it confers: no TRUNCATE, UPDATE only when mutable, MAINTAIN
 * only to a refresher of the view or a login fencing the table (fenceGrant).
 */
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
		const login = j.expect.logins.get(g.grantee)
		return unless(
			j.expect.refreshes.get(g.grantee)?.has(t.name) === true ||
				(login !== undefined && fenceGrant(login, g)),
			{
				kind: "maintainBeyondRefresh",
				view: t.name,
				grantee: g.grantee
			}
		)
	}
	return []
}

/** Whether `t` is the live source's secret table. */
const isSecret = (j: Judging, t: Table): boolean =>
	j.expect.liveSource.kind === "source" && t.kind === "r" && t.name === j.expect.liveSource.secret

/** Whether `g` is the decoder login's SELECT on the secret, its one grant on a relation. */
const decoderReads = (j: Judging, t: Table, g: HeldGrant): boolean =>
	isSecret(j, t) &&
	j.expect.liveSource.kind === "source" &&
	g.grantee === j.expect.liveSource.decoder &&
	g.privilege === "SELECT"

/** What a world role may hold on `t`: nothing on the secret, a materialized view's or a table's privileges otherwise. */
const worldPrivileges = (j: Judging, t: Table): ReadonlySet<string> => {
	if (isSecret(j, t)) {
		return allowed.none
	}
	return t.kind === "m" ? allowed.view : allowed.table
}

const tableProblems = (j: Judging, t: Table): ReadonlyArray<ErasureProblem> => {
	const relation: CatalogObject = { kind: "relation", name: t.name }
	const ledger = t.kind === "r" && t.name === j.expect.ledger
	const held = on(relation, t.grants)
	const own = Arr.filter(held, (g) => !decoderReads(j, t, g))
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
		...grantProblems(j, own, worldPrivileges(j, t), ledger ? allowed.ledger : allowed.none),
		...grantProblems(j, columns, allowed.column, allowed.none),
		...(ledger ? loginLacks(j, relation, t.grants, "SELECT") : []),
		...unless(!isSecret(j, t) || Arr.some(held, (g) => decoderReads(j, t, g)), {
			kind: "decoderLacks",
			object: relation,
			privilege: "SELECT"
		}),
		...Arr.flatMap([...own, ...columns], (g) => conferredProblems(j, t, g))
	]
}

/** Whether `p` is the migrations ledger, in the root's schema. */
const isLedger = (j: Judging, p: CatalogPublishedTable): boolean =>
	p.schema === j.catalog.schema && p.table === j.expect.ledger

/**
 * What the database's publications publish of the installation: only the live source's publication publishes a table
 * of it, and only an authored table or the ledger, never the secret; and where the ledger stands, that publication
 * publishes it, so every migration applied reaches the leader.
 */
const publicationProblems = (j: Judging): ReadonlyArray<ErasureProblem> => {
	const source = j.expect.liveSource
	const sourcePublishes = (p: CatalogPublishedTable): boolean =>
		source.kind === "source" &&
		p.publication === source.publication &&
		(j.expect.tables.has(p.table) || isLedger(j, p))
	const stranger = Arr.flatMap(j.catalog.publishedTables, (p) =>
		unless(sourcePublishes(p), {
			kind: "strangerPublished",
			publication: p.publication,
			table: `${p.schema}.${p.table}`
		})
	)
	if (source.kind === "none") {
		return stranger
	}
	const ledgerStands = Arr.some(
		j.catalog.tables,
		(t) => t.kind === "r" && t.name === j.expect.ledger
	)
	return [
		...stranger,
		...unless(
			!ledgerStands ||
				Arr.some(
					j.catalog.publishedTables,
					(p) => p.publication === source.publication && isLedger(j, p)
				),
			{ kind: "ledgerUnpublished", publication: source.publication }
		)
	]
}

/** Every login holds MAINTAIN on each table it fences, which must stand. */
const fenceProblems = (j: Judging): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap([...j.expect.logins], ([login, { fenced }]) =>
		Arr.flatMap([...fenced], (table) =>
			unless(
				Arr.some(
					j.catalog.tables,
					(t) =>
						t.kind === "r" &&
						t.name === table &&
						Arr.some(t.grants, (g) => g.grantee === login && g.privilege === "MAINTAIN")
				),
				{
					kind: "loginLacks",
					object: { kind: "relation", name: table },
					login,
					privilege: "MAINTAIN"
				}
			)
		)
	)

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
 * A SECURITY DEFINER function grizzle installs, owned by the owner, its search_path fixed: a world's function is STABLE
 * and executable by one role; every other is VOLATILE, and is an advance
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
		...unless(f.volatility === "v", { kind: "volatility", function: f.name, required: "VOLATILE" })
	]
	const declared = j.expect.functions.get(f.name)
	const expected: InstalledFunction | undefined =
		declared ??
		(j.expect.closedConstants && Str.startsWith("__constant_")(f.name)
			? { kind: "closedConstant", declared: false, tables: [] }
			: undefined)
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
		case "isolationGuard":
		case "rule":
			return [...definer, ...grantProblems(j, held, allowed.none, allowed.none)]
		case "names":
		case "live":
		case "closedConstant":
			return [
				...constantShapeProblems(j, f),
				...grantProblems(j, held, allowed.function, allowed.none),
				...constantExecutorProblems(j, f, expected)
			]
	}
}

/**
 * A constant is a SQL function of no argument, IMMUTABLE, owned by the owner, neither SECURITY DEFINER nor carrying a
 * SET clause, so PostgreSQL inlines it and folds a call of it at plan time (sql/ast.ts CreateConstant).
 */
const constantShapeProblems = (j: Judging, f: Fn): ReadonlyArray<ErasureProblem> => {
	const shape = (holds: boolean, reason: string) =>
		unless(holds, { kind: "constantShape", function: f.name, reason })
	return [
		...shape(f.owner === j.owner, `owned by ${f.owner}`),
		...shape(f.args === "", `of arguments (${f.args})`),
		...shape(f.volatility === "i", `of volatility ${f.volatility}`),
		...shape(!f.securityDefiner, "SECURITY DEFINER"),
		...shape(f.config.length === 0, `with SET ${Arr.join(f.config, ", ")}`)
	]
}

/** The world roles holding `privilege` on the domain named `domain`. */
const domainHolders = (j: Judging, domain: string, privilege: string): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(j.catalog.domains, (d) =>
			d.name === domain
				? Arr.flatMap(d.grants, (g) =>
						g.privilege === privilege && j.worldRoles.has(g.grantee) ? [g.grantee] : []
					)
				: []
		)
	)

/** The world roles whose views call the function `name`: each world's role is its schema's name. */
const viewCallers = (j: Judging, name: string): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(j.catalog.worlds, (w) =>
			Arr.some(w.relations, (v) => Arr.contains(v.calls, name)) ? [w.name] : []
		)
	)

/** The world roles that insert into or update any of `tables`, whose CHECKs PostgreSQL evaluates as the invoker. */
const tableWriters = (j: Judging, tables: ReadonlyArray<string>): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(j.catalog.tables, (t) =>
			t.kind === "r" && Arr.contains(tables, t.name)
				? Arr.flatMap([...t.grants, ...t.columnGrants], (g) =>
						(g.privilege === "INSERT" || g.privilege === "UPDATE") && j.worldRoles.has(g.grantee)
							? [g.grantee]
							: []
					)
				: []
		)
	)

/**
 * The tables of the schema with a column whose type rests on the domain `domain`, the domain itself or one based on it
 * down its chain: a write of one coerces into the domain, which runs its CHECK as the invoker, a generated column's
 * included.
 */
const tablesOn = (j: Judging, domain: string): ReadonlyArray<string> => {
	const bases = new Map<string, string>(
		Arr.flatMap(j.catalog.domains, (d) =>
			j.catalog.levels.includes(d.base.schema) ? [[d.name, d.base.name] as const] : []
		)
	)
	const restsOn = (name: string): boolean =>
		name === domain ||
		Option.match(Option.fromUndefinedOr(bases.get(name)), {
			onNone: () => false,
			onSome: restsOn
		})
	return Arr.flatMap(j.catalog.tables, (t) =>
		Arr.some(t.columns, (c) => j.catalog.levels.includes(c.type.schema) && restsOn(c.type.name))
			? [t.name]
			: []
	)
}

/** The world roles holding EXECUTE on the function `name`. */
const executorsOf = (j: Judging, name: string): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(j.catalog.functions, (f) =>
			f.name === name
				? Arr.flatMap(f.grants, (g) =>
						g.privilege === "EXECUTE" && j.worldRoles.has(g.grantee) ? [g.grantee] : []
					)
				: []
		)
	)

/**
 * EXECUTE on a constant goes exactly to the world roles that call it as invokers (§3.12, "Role views"): a live
 * constant's, a hex literal that calls nothing, to the holders of USAGE on its bits domain, whose CHECK calls it, and the
 * roles that insert into or update a table with a column whose type rests on that domain (`tablesOn`), a generated
 * column's of a containment selected by a set among them, which no field of the writer's relations need type; a names
 * constant's to the holders of USAGE on its roster domain, the writers of the tables on it alike, and the roles whose
 * views decode a closed id through it; a declared closed relation's own constant's to every world role, since
 * a role holds every closed relation of its base but a roster (analysis/schema.ts CheckedSchema) and its queries' closed
 * reads call the relation's constants as the invoker; and any closed constant's to the roles whose views call it and
 * the roles that insert into or update a table whose CHECK or generated column calls it, a law's CHECK alone reading
 * a constant of no declared relation.
 */
const constantExecutorProblems = (
	j: Judging,
	f: Fn,
	expected: Extract<InstalledFunction, { readonly kind: "names" | "live" | "closedConstant" }>
): ReadonlyArray<ErasureProblem> => {
	const required = new Set<string>(viewCallers(j, f.name))
	switch (expected.kind) {
		case "live":
		case "names":
			for (const r of [
				...domainHolders(j, expected.domain, "USAGE"),
				...tableWriters(j, tablesOn(j, expected.domain))
			]) {
				required.add(r)
			}
			break
		case "closedConstant":
			if (expected.declared) {
				for (const r of j.worldRoles) {
					required.add(r)
				}
			}
			for (const r of tableWriters(j, expected.tables)) {
				required.add(r)
			}
			break
	}
	const held = executorsOf(j, f.name)
	const missing = Arr.sort(
		Arr.filter([...required], (r) => !held.has(r)),
		Order.String
	)
	const extra = Arr.sort(
		Arr.filter([...held], (r) => !required.has(r)),
		Order.String
	)
	return unless(missing.length === 0 && extra.length === 0, {
		kind: "constantExecutors",
		function: f.name,
		missing,
		extra
	})
}

/** A roster's and a set's domain has one CHECK, which calls exactly its constant (pg_depend). */
const rosterDomainProblems = (j: Judging): ReadonlyArray<ErasureProblem> =>
	Arr.flatMap([...j.expect.functions], ([name, f]) => {
		if (f.kind !== "names" && f.kind !== "live") {
			return []
		}
		const domain = Arr.findFirst(j.catalog.domains, (d) => d.name === f.domain)
		const calls = Option.match(domain, {
			onNone: () => [],
			onSome: (d) => Arr.map(d.constraints, (c) => c.calls)
		})
		return unless(calls.length === 1 && Arr.every(calls, (c) => c.length === 1 && c[0] === name), {
			kind: "domainCheckCalls",
			domain: f.domain,
			expected: name,
			calls
		})
	})

/**
 * Every trigger is enabled, and is PostgreSQL's internal foreign-key trigger, the isolation guard (running the isolation
 * guard function), or a rule over a query's trigger: a row constraint trigger AFTER its events, DEFERRABLE INITIALLY
 * DEFERRED, running a rule function. No other trigger exists.
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
	if (expected === "rule") {
		return [
			...enabled,
			...unless(
				t.constraint &&
					t.deferrable &&
					t.deferred &&
					(t.type & ruleTriggerLevel) === ruleTriggerLevel &&
					(t.type & beforeOrInstead) === 0 &&
					j.expect.functions.get(t.function)?.kind === "rule",
				{ kind: "malformedRuleTrigger", trigger: t.name, table: t.table }
			)
		]
	}
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
	return [...enabled, { kind: "foreignTrigger", trigger: t.name, table: t.table }]
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
	const login = j.expect.logins.get(r.name)
	if (login !== undefined) {
		return [
			...elevated,
			...unless(r.login, { kind: "loginCannotLogIn", role: r.name }),
			...unless(!r.inherit, { kind: "loginInherits", role: r.name }),
			...membershipProblems(r.name, "memberOf", r.memberOf, login.roles, noSetRole),
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
		Arr.flatMap([...j.expect.logins], ([login, { roles }]) => (roles.has(r.name) ? [login] : []))
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
 * - only authored tables, the migrations ledger and the live source's secret exist, plus the materialized views of
 *   declared derived relations; no plain view, foreign table, or other type beyond domains and row types, and no
 *   pg_enum row: a roster is a smallint domain;
 * - the only functions are the refusal function, the isolation guard, the snapshot guard and each serial field's
 *   advance function, owned by the owner, SECURITY DEFINER, VOLATILE, with `search_path = pg_catalog, pg_temp`; the
 *   worlds' functions (each writable query entry's filter function and key and unique probes), owned by the owner,
 *   SECURITY DEFINER, STABLE, with the same search_path; and the constants, each named by its content's digest, a SQL function of no
 *   argument, IMMUTABLE, owned by the owner, neither SECURITY DEFINER nor carrying a SET clause: a roster's names
 *   constant, the live-codes constant derived from it, and a closed relation's constants. EXECUTE goes to no one on
 *   the isolation guard, to world roles alone on the refusal function, to exactly the logins on the snapshot guard,
 *   which every Db transaction calls as its login, to the one role whose entry it serves on a world's function, on an
 *   advance function to exactly the world roles that insert into its table, and on a constant to exactly the world
 *   roles that call it as invokers: through USAGE on a domain whose CHECK reads it, a view that decodes through it, or
 *   another constant derived from it;
 * - a roster's domain and a set's domain each have one CHECK, which calls exactly their constant;
 * - the only triggers are the isolation guard and PostgreSQL's internal foreign-key triggers, enabled;
 * - every table the installation expects, the authored relations' and the migrations ledger, carries exactly one
 *   isolation guard trigger, BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT, running the isolation
 *   guard function, and the database defaults every transaction to SERIALIZABLE: README "Transactions and concurrency":
 *   "The first migration makes it the database's default" and "a write below it on a grizzle table is refused". A table it does not expect is drift
 *   in itself, reported once as such, never judged as a grizzle table;
 * - the grant shape: PUBLIC holds nothing on any schema object; a login holds exactly USAGE on the schema, SELECT on the
 *   migrations ledger and EXECUTE on the snapshot guard, which Db.open's admission and every Db transaction take as the
 *   login, and MAINTAIN on each table it fences, which its fenced writes lock before their snapshot; the live
 *   source's decoder login holds exactly USAGE on the schema and SELECT on the live secret, which its listeners and its
 *   leader read; and every other grant is the owner's or a world's role's; no role but the owner holds UPDATE, of the
 *   table or of a column, on an immutable relation (immutable by default is pinned) or TRUNCATE on any relation
 *   (TRUNCATE fires no row trigger and would bypass the laws); a table grants only SELECT, INSERT, DELETE and UPDATE,
 *   a materialized view SELECT and MAINTAIN, the latter to exactly the roles that refresh it, a column SELECT, INSERT
 *   and UPDATE, the schema and a domain USAGE, and an identity sequence nothing: a write moves it through the advance
 *   function;
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
		worldRoles: new Set(Arr.flatMap([...expect.logins.values()], (login) => [...login.roles]))
	}
	const schema: CatalogObject = { kind: "schema", name: catalog.schema }
	const held = heldGrants(catalog)
	const declaredRoles = new Set([...expect.logins.keys(), ...j.worldRoles])
	const schemaHeld = on(schema, catalog.schemaGrants)
	const decoderUses = (g: HeldGrant): boolean =>
		expect.liveSource.kind === "source" &&
		g.grantee === expect.liveSource.decoder &&
		g.privilege === "USAGE"
	return [
		...grantProblems(
			j,
			Arr.filter(schemaHeld, (g) => !decoderUses(g)),
			allowed.usage,
			allowed.usage
		),
		...unless(expect.liveSource.kind === "none" || Arr.some(schemaHeld, decoderUses), {
			kind: "decoderLacks",
			object: schema,
			privilege: "USAGE"
		}),
		...loginLacks(j, schema, catalog.schemaGrants, "USAGE"),
		...Arr.flatMap(catalog.tables, (t) => tableProblems(j, t)),
		...refresherProblems(j),
		...publicationProblems(j),
		...fenceProblems(j),
		...Arr.flatMap(catalog.sequences, (q) =>
			grantProblems(j, on({ kind: "sequence", name: q.name }, q.grants), allowed.none, allowed.none)
		),
		...unless(catalog.enumLabels === 0, { kind: "enumLabels", count: catalog.enumLabels }),
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
		...rosterDomainProblems(j),
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
