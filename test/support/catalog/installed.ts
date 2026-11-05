import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { PhysicalKind } from "#compiler/ir/products.ts"
import { roleIdentity, roleView } from "#compiler/physical/ddl/names.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { CreateDomain, Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { assert } from "#test/support/assert.ts"
import { type Catalog, type CatalogGrant, readCatalog } from "#test/support/catalog/read.ts"
import {
	type ErasureExpectation,
	type ErasureProblem,
	type InstalledFunction,
	type InstalledTrigger,
	verifyErasure
} from "#test/support/catalog/verify.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A type by its schema and name. */
interface NamedType {
	readonly schema: string
	readonly name: string
}

/**
 * What one world's role's whole rosters justify beyond its privileges: each roster's domain, which a query casts a
 * code to.
 */
export interface RoleScope {
	readonly role: string
	readonly closedTypes: ReadonlyArray<NamedType>
}

export interface InstalledScope {
	readonly erasure: ErasureExpectation
	readonly roles: ReadonlyArray<RoleScope>
}

/** The names the statements of the manifest's objects of `kind` create. */
const created = (
	snapshot: DeploySnapshot,
	kind: PhysicalKind,
	name: (statement: SqlStatement) => Option.Option<string>
): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(snapshot.manifest.objects, (o) =>
			o.kind === kind ? Arr.flatMap(o.ddl, (s) => Option.toArray(name(s))) : []
		)
	)

const tableOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createTable" ? Option.some(s.table.name) : Option.none()

const viewOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createMaterializedView" ? Option.some(s.name.name) : Option.none()

const functionOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createFunction" ? Option.some(s.name.name) : Option.none()

const guardTriggerOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createGuardTrigger" ? Option.some(s.name) : Option.none()

const rowSecureOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "enableRowSecurity")
		? Option.some(s.table.name)
		: Option.none()

/** The functions an expression calls, by name. */
const callsOf = (e: Expr): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "call" && x.fn.kind === "qualified") {
				out.push(x.fn.name)
			}
			return x
		}
	})
	return out
}

/**
 * The constants the manifest's constant objects create, each as what it is: a names constant (it returns name[]) and a
 * live-codes constant (it returns bit varying from a subquery over a names constant), each with the domain whose CHECK
 * calls it among the manifest's domains; every other, a pack or a dictionary, a closed relation's constant.
 */
const constantsOf = (
	snapshot: DeploySnapshot
): ReadonlyArray<readonly [string, InstalledFunction]> => {
	const domains = Arr.flatMap(snapshot.manifest.objects, (o) =>
		o.kind === "domain"
			? Arr.flatMap(o.ddl, (s): ReadonlyArray<CreateDomain> =>
					s.kind === "createDomain" ? [s] : []
				)
			: []
	)
	const checking = (fn: string): string =>
		Option.getOrThrowWith(
			Arr.findFirst(domains, (d) =>
				Arr.some(d.constraints, (c) => Arr.contains(callsOf(c.predicate), fn))
			),
			() => new Error(`the manifest's constant ${fn} is read by no domain's CHECK`)
		).name.name
	return Arr.flatMap(snapshot.manifest.objects, (o) =>
		o.kind === "constant"
			? Arr.flatMap(o.ddl, (s): ReadonlyArray<readonly [string, InstalledFunction]> => {
					if (s.kind === "packConstant") {
						return [[s.function.name, { kind: "closedConstant" }]]
					}
					if (s.kind !== "createConstant") {
						return []
					}
					const name = s.name.name
					if (s.returns.kind === "builtin" && s.returns.name === "name" && s.returns.array) {
						return [[name, { kind: "names", domain: checking(name) }]]
					}
					const [names] = callsOf(s.body)
					return s.body.kind === "subquery" && names !== undefined
						? [[name, { kind: "live", names, domain: checking(name) }]]
						: [[name, { kind: "closedConstant" }]]
				})
			: []
	)
}

/**
 * The scope an installation and its snapshot declare: the erasure expectation and each world's role's closed whole
 * relations.
 */
export const installedScope = (
	installation: Installation,
	snapshot: DeploySnapshot
): InstalledScope => {
	const relations = Rec.values(snapshot.theory.relations)
	/** Each function the manifest's objects of `kind` create, as `what`. */
	const functionsOf = (kind: PhysicalKind, what: InstalledFunction) =>
		Arr.map([...created(snapshot, kind, functionOf)], (name) => [name, what] as const)
	/** Each trigger the manifest's objects of `kind` create, as `what`. */
	const triggersOf = (
		kind: PhysicalKind,
		name: (s: SqlStatement) => Option.Option<string>,
		what: InstalledTrigger
	) => Arr.map([...created(snapshot, kind, name)], (trigger) => [trigger, what] as const)
	const ledger = Option.getOrThrowWith(
		Arr.head([...created(snapshot, "ledger", tableOf)]),
		() => new Error("the snapshot's manifest holds no migrations ledger")
	)
	const scoped = Arr.flatMap(installation.settings.logins, (login) =>
		Arr.map(login.roles, (r) => {
			const installedRole = Option.getOrThrowWith(
				Option.flatMap(
					Arr.findFirst(installation.worlds, (l) => l.name === login.name),
					(l) => Arr.findFirst(l.roles, (w) => w.name === r.name)
				),
				() => new Error(`the installation names no role ${r.name}`)
			)
			const closedTypes = Arr.flatMap(Rec.values(r.relations), (entry): ReadonlyArray<NamedType> =>
				entry.kind === "whole" &&
				Option.exists(Rec.get(snapshot.theory.relations, entry.name), (x) => x.kind === "closed")
					? [installation.names.rosterDomain(parsedName(entry.name))]
					: []
			)
			/** Each refreshed derived relation's materialized view, by the snapshot's theory. */
			const refreshed = Arr.map(r.refresh, (name) =>
				Option.getOrThrowWith(
					Option.flatMap(Rec.get(snapshot.theory.relations, name), (relation) =>
						relation.kind === "derived" ? Option.some(relation.ident) : Option.none()
					),
					() => new Error(`the snapshot holds no derived relation ${name}`)
				)
			)
			/** Each query entry's view, by the naming door. */
			const theory = roleIdentity(installation.settings.installation, parsedName(r.name), r.loc)
			const barrierViews = Arr.flatMap(Rec.values(r.relations), (e) =>
				e.kind === "world" ? [`${installedRole.schema}.${identifierOf(roleView(theory, e))}`] : []
			)
			return {
				scope: { role: installedRole.role, closedTypes },
				refreshes: [installedRole.role, new Set(refreshed)] as const,
				barrierViews
			}
		})
	)
	return {
		erasure: {
			tables: created(snapshot, "table", tableOf),
			mutable: new Set(
				Arr.flatMap(relations, (r) => (r.kind === "relation" && r.mutable ? [r.ident] : []))
			),
			views: created(snapshot, "materializedView", viewOf),
			ledger,
			functions: new Map<string, InstalledFunction>([
				...functionsOf("refusalFunction", { kind: "refusal" }),
				...functionsOf("isolationFunction", { kind: "isolationGuard" }),
				...functionsOf("snapshotGuard", { kind: "snapshotGuard" }),
				...functionsOf("worldFunction", { kind: "world" }),
				...constantsOf(snapshot),
				...Arr.flatMap(Rec.toEntries(snapshot.theory.relations), ([name, r]) =>
					r.kind === "relation"
						? Arr.flatMap(r.fields, (f) =>
								f.writing === "serial"
									? [
											[
												identifierOf(identity.advance(name, f.name)),
												{ kind: "advance", table: r.ident }
											] as const
										]
									: []
							)
						: []
				)
			]),
			triggers: new Map<string, InstalledTrigger>(
				triggersOf("isolationTrigger", guardTriggerOf, "isolation")
			),
			rowSecure: created(snapshot, "rowSecurity", rowSecureOf),
			logins: new Map(
				Arr.map(
					installation.worlds,
					(l) => [l.role, new Set(Arr.map(l.roles, (r) => r.role))] as const
				)
			),
			refreshes: new Map(Arr.map(scoped, (s) => s.refreshes)),
			barrierViews: new Set(Arr.flatMap(scoped, (s) => s.barrierViews)),
			closedConstants: Arr.some(
				Rec.values(installation.owned.relations),
				(r) => r.kind === "closedRelation"
			)
		},
		roles: Arr.map(scoped, (s) => s.scope)
	}
}

/** A type of the schema a role's USAGE is judged on: a domain, the one kind of type grizzle installs. */
export interface SchemaType {
	readonly kind: "domain"
	readonly name: string
}

/**
 * One way an installed catalog departs from least privilege on types and on the vector type's reach, or an index that
 * is not valid, by the rule it breaks and the catalog facts that break it.
 */
export type ReachProblem =
	| { readonly kind: "usageBeyondScope"; readonly role: string; readonly type: SchemaType }
	| { readonly kind: "usageMissing"; readonly role: string; readonly type: SchemaType }
	| {
			readonly kind: "foreignSchemaGrant"
			readonly role: string
			readonly schema: string
			readonly privilege: string
	  }
	| { readonly kind: "vectorUsageMissing"; readonly role: string; readonly schema: string }
	| {
			readonly kind: "loginForeignGrant"
			readonly login: string
			readonly schema: string
			readonly privilege: string
	  }
	| { readonly kind: "loginDefaultExtra"; readonly login: string; readonly setting: string }
	| { readonly kind: "loginDefaultMissing"; readonly login: string; readonly setting: string }
	| { readonly kind: "invalidIndex"; readonly index: string }

/** Every way an installed catalog departs from the scope its installation declares. */
export type InstalledProblem = ErasureProblem | ReachProblem

/** The problem, unless the rule holds. */
const unless = (holds: boolean, problem: ReachProblem): ReadonlyArray<ReachProblem> =>
	holds ? [] : [problem]

/** The column types of every table `role` holds a privilege `privilege` admits on, of the table or of a column. */
const tableTypes = (
	catalog: Catalog,
	role: string,
	privilege: (p: string) => boolean
): ReadonlyArray<NamedType> =>
	Arr.flatMap(catalog.tables, (t) =>
		Arr.some([...t.grants, ...t.columnGrants], (g) => g.grantee === role && privilege(g.privilege))
			? Arr.map(t.columns, (c) => c.type)
			: []
	)

/** The column types of every view of `role`'s world. */
const viewedTypes = (catalog: Catalog, role: string): ReadonlyArray<NamedType> =>
	Arr.flatMap(catalog.worlds, (w) =>
		w.name === role ? Arr.flatMap(w.relations, (v) => Arr.map(v.columns, (c) => c.type)) : []
	)

/**
 * The problems of least privilege on types: every USAGE a role holds on a domain of the schema that its table
 * privileges and its roster reads do not need, and every such domain of its views, of the tables it inserts into and
 * of its roster reads it holds no USAGE on.
 */
const usageProblems = (
	catalog: Catalog,
	roles: ReadonlyArray<RoleScope>
): ReadonlyArray<ReachProblem> => {
	const bases = new Map<string, string>(
		Arr.flatMap(catalog.domains, (d) =>
			d.base.schema === catalog.schema ? [[d.name, d.base.name] as const] : []
		)
	)
	/** A type of the schema with every base its domains rest on. */
	const restsOn = (name: string, seen: ReadonlySet<string>): ReadonlyArray<string> =>
		seen.has(name)
			? []
			: [
					name,
					...Arr.flatMap(Option.toArray(Option.fromUndefinedOr(bases.get(name))), (base) =>
						restsOn(base, new Set([...seen, name]))
					)
				]
	/** The types of the schema among `types`, each with the bases its domains rest on. */
	const closure = (types: ReadonlyArray<NamedType>): ReadonlySet<string> =>
		new Set(
			Arr.flatMap(types, (t) => (t.schema === catalog.schema ? restsOn(t.name, new Set()) : []))
		)
	return Arr.flatMap(catalog.roles, (role) => {
		const reads = [
			...Arr.flatMap(roles, (r) => (r.role === role.name ? r.closedTypes : [])),
			...viewedTypes(catalog, role.name)
		]
		const needed = closure([...reads, ...tableTypes(catalog, role.name, () => true)])
		const bound = closure([...reads, ...tableTypes(catalog, role.name, (p) => p === "INSERT")])
		const judged = (
			type: SchemaType,
			grants: ReadonlyArray<CatalogGrant>
		): ReadonlyArray<ReachProblem> => {
			const holds = Arr.some(grants, (g) => g.grantee === role.name && g.privilege === "USAGE")
			return [
				...unless(!holds || needed.has(type.name), {
					kind: "usageBeyondScope",
					role: role.name,
					type
				}),
				...unless(holds || !bound.has(type.name), { kind: "usageMissing", role: role.name, type })
			]
		}
		return Arr.flatMap(catalog.domains, (d) => judged({ kind: "domain", name: d.name }, d.grants))
	})
}

/**
 * The schema outside the installation whose `vector` a column type is or rests on through the schema's domains, none
 * for any other type.
 */
const vectorSchemaOf = (catalog: Catalog, type: NamedType): Option.Option<string> => {
	const bases = new Map<string, NamedType>(
		Arr.map(catalog.domains, (d) => [d.name, d.base] as const)
	)
	const walk = (t: NamedType, seen: ReadonlySet<string>): Option.Option<string> => {
		if (t.schema !== catalog.schema) {
			return t.name === "vector" ? Option.some(t.schema) : Option.none()
		}
		if (seen.has(t.name)) {
			return Option.none()
		}
		return Option.flatMap(Option.fromUndefinedOr(bases.get(t.name)), (base) =>
			walk(base, new Set([...seen, t.name]))
		)
	}
	return walk(type, new Set())
}

/**
 * Each login's fixed defaults, `name=value` as pg_db_role_setting stores them: float text in shortest round-trip form
 * (only when extra_float_digits is positive), lc_monetary, lc_numeric and lc_time at C.UTF-8, and the search path of
 * pg_catalog and the session's temporary schema alone, a list PostgreSQL stores with its schemas bare. Nothing else:
 * jit and lc_messages are the database owner's.
 */
export const fixedDefaults: ReadonlyArray<string> = [
	"extra_float_digits=1",
	"lc_monetary=C.UTF-8",
	"lc_numeric=C.UTF-8",
	"lc_time=C.UTF-8",
	"search_path=pg_catalog, pg_temp"
]

/** The search setting grizzle pins, strict-order iterative scans, stored the same way. */
export const searchDefaults: ReadonlyArray<string> = Arr.map(
	searchPolicySettings,
	(s) => `${s.parameter}=${s.value}`
)

/** A login stores exactly the fixed defaults, and the search policy's parameters exactly when one of its roles searches. */
const loginDefaultProblems = (
	login: string,
	config: ReadonlyArray<string>,
	searches: boolean
): ReadonlyArray<ReachProblem> => {
	const expected = [...fixedDefaults, ...(searches ? searchDefaults : [])]
	return [
		...Arr.flatMap(config, (setting) =>
			unless(Arr.contains(expected, setting), { kind: "loginDefaultExtra", login, setting })
		),
		...Arr.flatMap(expected, (setting) =>
			unless(Arr.contains(config, setting), { kind: "loginDefaultMissing", login, setting })
		)
	]
}

/**
 * The problems of the vector type's reach: each role's USAGE on a schema outside the installation against the vector
 * columns it reads and writes, and each login's defaults against its roles' reach.
 */
const vectorProblems = (catalog: Catalog, scope: InstalledScope): ReadonlyArray<ReachProblem> => {
	/** Each role's reached schemas: those whose vector type a column it reads or a table it inserts into rests on. */
	const reached = new Map(
		Arr.map(scope.roles, ({ role, closedTypes }) => {
			const types = [
				...closedTypes,
				...viewedTypes(catalog, role),
				...tableTypes(catalog, role, (p) => p === "INSERT")
			]
			return [
				role,
				new Set(Arr.flatMap(types, (t) => Option.toArray(vectorSchemaOf(catalog, t))))
			] as const
		})
	)
	const roleProblems = Arr.flatMap([...reached], ([role, schemas]) => {
		const held = Arr.filter(catalog.foreignGrants, (g) => g.grantee === role)
		return [
			...Arr.flatMap(held, (g) =>
				unless(g.privilege === "USAGE" && schemas.has(g.schema), {
					kind: "foreignSchemaGrant",
					role,
					schema: g.schema,
					privilege: g.privilege
				})
			),
			...Arr.flatMap([...schemas], (schema) =>
				unless(
					Arr.some(held, (g) => g.schema === schema && g.privilege === "USAGE"),
					{ kind: "vectorUsageMissing", role, schema }
				)
			)
		]
	})
	const loginProblems = Arr.flatMap([...scope.erasure.logins], ([login, roles]) => [
		...Arr.flatMap(catalog.foreignGrants, (g) =>
			unless(g.grantee !== login, {
				kind: "loginForeignGrant",
				login,
				schema: g.schema,
				privilege: g.privilege
			})
		),
		...Option.match(
			Arr.findFirst(catalog.roles, (r) => r.name === login),
			{
				onNone: () => [],
				onSome: (installed) =>
					loginDefaultProblems(
						login,
						installed.config,
						Arr.some([...reached], ([role, schemas]) => roles.has(role) && schemas.size > 0)
					)
			}
		)
	])
	return [...roleProblems, ...loginProblems]
}

/**
 * The installed-catalog checker: the posture every installation grizzle deploys must hold, read from the live catalog
 * after every install or apply.
 *
 * Rule: a suite that installs or migrates a schema reads its catalog (read.ts) and checks it against the scope its
 * installation and its snapshot declare; the checker must find nothing. It holds two kinds of rule:
 *
 * - the erasure ledger's shape rules (verify.ts): only the authored tables, the derived relations' materialized views,
 *   the refusal function, the isolation guard and each table's guard trigger, the snapshot guard every login executes,
 *   the law functions and law triggers, the serial fields' advance functions, the worlds' functions, and PostgreSQL's
 *   internal foreign-key triggers; the worlds' schemas of views, security_barrier exactly where a query entry's; row
 *   security and policies exactly where a world writes through a query entry; no UPDATE on an immutable relation, no
 *   TRUNCATE, no privilege on a sequence, MAINTAIN only to a refresher, no PUBLIC grant, nothing granted to a login
 *   beyond what admission and a Db transaction take as it, nothing inherited beyond a role's own privileges, no elevated
 *   or undeclared role; and no index is invalid;
 * - least privilege on types, by a derivation of its own: a world's role may hold USAGE on an enum or a domain of the
 *   schema only when its own privileges or its whole closed relations need the type. The types it needs are the types
 *   of every column of every table or materialized view it holds a privilege on, of a column of one, and of every view
 *   of its world, and, for each closed relation its world holds whole, the relation's enum and the types of its
 *   payload, each with the bases its domains rest on. The installer's grants are never consulted, so a grant beyond the
 *   scope is found however the installer derived it. The bound holds from below as well: a role holds USAGE on every
 *   such type of its world's views, of the tables it inserts into and of its whole closed relations, which its programs
 *   name when they bind a value of the type;
 * - the vector type, by the same derivation: a world's role holds USAGE on a schema outside the installation exactly
 *   when a column it reads (of its world's views, or of its whole closed relations' payloads) or a column of a table it
 *   inserts into is, or rests through the schema's domains on, that schema's `vector`, so it can name the type a search
 *   binds; and each login stores exactly the fixed defaults (`search_path = pg_catalog, pg_temp`,
 *   `extra_float_digits = 1` and lc_monetary, lc_numeric and lc_time at C.UTF-8) plus, exactly when one of its roles
 *   names the vector type, `hnsw.iterative_scan = strict_order` (check/approximate/policy.ts), which PostgreSQL applies
 *   at login and never on SET ROLE.
 *
 * The derivation reads the catalog's own grants and types; the declaration supplies only what the catalog cannot show:
 * which closed relations a world holds and which derived relations it refreshes, from the installation's owned logins
 * and closed templates, and which serial fields a stored relation has, from the snapshot's theory. Which object is
 * which is read from the manifest's object kinds.
 *
 * Every way the installed catalog departs from its scope; none for a sound installation. An index that is not valid, as
 * a failed concurrent build leaves one, serves no query and supplies no constraint, so no installation holds one.
 */
export const checkInstalled = (
	catalog: Catalog,
	scope: InstalledScope
): ReadonlyArray<InstalledProblem> => [
	...verifyErasure(catalog, scope.erasure),
	...usageProblems(catalog, scope.roles),
	...vectorProblems(catalog, scope),
	...Arr.flatMap(catalog.indexes, (i) => unless(i.valid, { kind: "invalidIndex", index: i.name }))
]

/**
 * The checker over the catalog an install reached, against the scope of its installation at its snapshot: the hook a
 * suite's install runs (test/support/install-migrate.ts), so every installation holds the posture whatever the suite
 * tests. It reads through the substrate's owner connection, so the installation must live in the substrate's database.
 */
export const checkInstallation = (installed: Installed): Effect.Effect<void, never, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		assert.equal(
			installed.database,
			substrate.database,
			"the installed-catalog checker reads the substrate's own database"
		)
		const read = yield* Effect.orDie(readCatalog(substrate.admin, installed.schema))
		assert.ok(read.kind === "present", `the installed schema ${installed.schema} is absent`)
		assert.deepEqual(
			checkInstalled(read.catalog, installedScope(installed.installation, installed.snapshot)),
			[],
			`the installed-catalog checker over ${installed.schema}`
		)
	})
