import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { serialDraw } from "#compiler/ir/desc.ts"
import type { PhysicalKind } from "#compiler/ir/products.ts"
import { roleIdentity, roleView } from "#compiler/physical/ddl/names.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { CreateDomain, Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Catalog,
	type CatalogColumn,
	type CatalogGrant,
	readCatalog
} from "#test/support/catalog/read.ts"
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

/**
 * Whether a stored relation's serial field draws by an identity, which its advance function moves, as its declared type
 * says (ir/desc.ts serialDraw): an integer's, where a pg.uuidv7 field's `uuidv7()` default has no sequence.
 */
const drawsIdentity = (installation: Installation, relation: string, field: string): boolean => {
	const f = Option.getOrThrowWith(
		Option.flatMap(Rec.get(installation.laws.theory.relations, relation), (r) =>
			Arr.findFirst(r.heading, (c) => c.name === field)
		),
		() => new Error(`the theory holds no field ${relation}.${field}, which the snapshot records`)
	)
	return serialDraw(f.desc) === "identity"
}

const tableOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createTable" ? Option.some(s.table.name) : Option.none()

const viewOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createMaterializedView" ? Option.some(s.name.name) : Option.none()

const functionOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createFunction" ? Option.some(s.name.name) : Option.none()

const guardTriggerOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createGuardTrigger" ? Option.some(s.name) : Option.none()

const guardedTableOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createGuardTrigger" ? Option.some(s.table.name) : Option.none()

const ruleTriggerOf = (s: SqlStatement): Option.Option<string> =>
	s.kind === "createConstraintTrigger" ? Option.some(s.name) : Option.none()

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

/** The functions a statement's expressions call, by name: a CHECK's, a generated column's, a body's. */
const statementCalls = (s: SqlStatement): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformStatement(s, {
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

/** The tables whose installed statements call each function, by its name: a table's CREATE TABLE and every ALTER TABLE
 * of it a manifest holds, a CHECK's and a generated column's calls among them. */
const tableCallers = (
	manifest: Installation["manifest"]
): ReadonlyMap<string, ReadonlySet<string>> => {
	const out = new Map<string, Set<string>>()
	for (const o of manifest.objects) {
		for (const s of o.ddl) {
			const table =
				s.kind === "createTable" ? s.table.name : s.kind === "alterTable" ? s.table.name : undefined
			if (table === undefined) {
				continue
			}
			for (const fn of statementCalls(s)) {
				const known = out.get(fn)
				if (known === undefined) {
					out.set(fn, new Set([table]))
				} else {
					known.add(table)
				}
			}
		}
	}
	return out
}

/**
 * Each closed constant of an installation as the verifier judges its executors: a declared closed relation's own
 * (`declared`: its cells, its key set, a dependent key's owner functions or a dictionary, every function its readers
 * call (ClosedConstant functions), which every world role's queries' closed reads call), or one a
 * law's CHECK alone reads; either with the tables whose CHECKs and generated columns call it.
 */
const closedClassifier = (installation: Installation): ((name: string) => InstalledFunction) => {
	const declared = new Set(
		Arr.flatMap(Rec.values(installation.owned.relations), (r) => {
			if (r.kind !== "closedRelation") {
				return []
			}
			return Arr.map(installation.names.closed(r.name).functions, (f) => f.name)
		})
	)
	const callers = tableCallers(installation.manifest)
	return (name) => ({
		kind: "closedConstant",
		declared: declared.has(name),
		tables: Arr.sort(callers.get(name) ?? [], Order.String)
	})
}

/** Whether a constant's statement creates a names constant (it returns name[]) or a live-codes constant (a hex literal
 * of bit varying; a closed relation's constant is a pack): a roster's, which no closed relation owns. */
const rosterConstant = (s: Extract<SqlStatement, { readonly kind: "createConstant" }>): boolean =>
	(s.returns.kind === "builtin" && s.returns.name === "name" && s.returns.array) ||
	(s.body.kind === "literal" && s.body.value.kind === "bits")

/** Every closed constant an installation's manifest creates, a pack or a dictionary, as `closedClassifier` judges it:
 * what a description-built expectation (catalog/declared.ts), which names no constant, holds of them. */
export const closedConstantsOf = (
	installation: Installation
): ReadonlyArray<readonly [string, InstalledFunction]> => {
	const judged = closedClassifier(installation)
	return Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "constant"
			? Arr.flatMap(o.ddl, (s): ReadonlyArray<readonly [string, InstalledFunction]> =>
					s.kind === "packConstant"
						? [[s.function.name, judged(s.function.name)]]
						: s.kind === "createConstant" && !rosterConstant(s)
							? [[s.name.name, judged(s.name.name)]]
							: []
				)
			: []
	)
}

/**
 * The constants the manifest's constant objects create, each as what it is: a names constant (it returns name[]) and a
 * live-codes constant (it returns bit varying as one hex literal), each with the domain whose CHECK
 * calls it among the manifest's domains; every other, a pack or a dictionary, a closed constant (`closedClassifier`).
 */
const constantsOf = (
	installation: Installation,
	snapshot: DeploySnapshot
): ReadonlyArray<readonly [string, InstalledFunction]> => {
	const closedConstant = closedClassifier(installation)
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
						return [[s.function.name, closedConstant(s.function.name)]]
					}
					if (s.kind !== "createConstant") {
						return []
					}
					const name = s.name.name
					if (s.returns.kind === "builtin" && s.returns.name === "name" && s.returns.array) {
						return [[name, { kind: "names", domain: checking(name) }]]
					}
					return s.body.kind === "literal" && s.body.value.kind === "bits"
						? [[name, { kind: "live", domain: checking(name) }]]
						: [[name, closedConstant(name)]]
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
			const theory = roleIdentity(
				defined(installation.names.levels[r.base.levels.length - 1], `the level of role ${r.name}`),
				parsedName(r.name),
				r.loc
			)
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
			guarded: created(snapshot, "isolationTrigger", guardedTableOf),
			functions: new Map<string, InstalledFunction>([
				...functionsOf("refusalFunction", { kind: "refusal" }),
				...functionsOf("isolationFunction", { kind: "isolationGuard" }),
				...functionsOf("lawFunction", { kind: "rule" }),
				...functionsOf("snapshotGuard", { kind: "snapshotGuard" }),
				...functionsOf("worldFunction", { kind: "world" }),
				...constantsOf(installation, snapshot),
				...Arr.flatMap(Rec.toEntries(snapshot.theory.relations), ([name, r]) =>
					r.kind === "relation"
						? Arr.flatMap(r.fields, (f) =>
								f.writing === "serial" && drawsIdentity(installation, name, f.name)
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
			triggers: new Map<string, InstalledTrigger>([
				...triggersOf("isolationTrigger", guardTriggerOf, "isolation"),
				...triggersOf("lawTrigger", ruleTriggerOf, "rule")
			]),
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

/** The columns of every table `role` holds a privilege `privilege` admits on, of the table or of a column. */
const tableColumns = (
	catalog: Catalog,
	role: string,
	privilege: (p: string) => boolean
): ReadonlyArray<CatalogColumn> =>
	Arr.flatMap(catalog.tables, (t) =>
		Arr.some([...t.grants, ...t.columnGrants], (g) => g.grantee === role && privilege(g.privilege))
			? t.columns
			: []
	)

/** The column types of every table `role` holds any privilege on. */
const heldTypes = (catalog: Catalog, role: string): ReadonlyArray<NamedType> =>
	Arr.map(
		tableColumns(catalog, role, () => true),
		(c) => c.type
	)

/**
 * The types an insert by `role` names: those of every column of a table it holds INSERT on but a generated one, whose
 * value PostgreSQL computes and no insert carries, so a domain only a generated column is typed by needs no USAGE.
 */
const insertedTypes = (catalog: Catalog, role: string): ReadonlyArray<NamedType> =>
	Arr.flatMap(
		tableColumns(catalog, role, (p) => p === "INSERT"),
		(c) => (c.generation.kind === "computed" ? [] : [c.type])
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
		const needed = closure([...reads, ...heldTypes(catalog, role.name)])
		const bound = closure([...reads, ...insertedTypes(catalog, role.name)])
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
 * Each login's fixed defaults, `name=value` as pg_db_role_setting stores them: dates written in ISO 8601's YYYY-MM-DD,
 * float text in shortest round-trip form (only when extra_float_digits is positive), bytea written as hex, lc_monetary,
 * lc_numeric and lc_time at C.UTF-8, and the search path of
 * pg_catalog and the session's temporary schema alone, a list PostgreSQL stores with its schemas bare. Nothing else:
 * jit and lc_messages are the database owner's.
 */
export const fixedDefaults: ReadonlyArray<string> = [
	"DateStyle=ISO, YMD",
	"bytea_output=hex",
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
			const types = [...closedTypes, ...viewedTypes(catalog, role), ...insertedTypes(catalog, role)]
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
 *   `extra_float_digits = 1`, `bytea_output = hex` and lc_monetary, lc_numeric and lc_time at C.UTF-8) plus, exactly
 *   when one of its roles
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
		const read = yield* Effect.orDie(
			readCatalog(substrate.admin, mapNonEmpty(installed.installation.names.levels, identifierOf))
		)
		assert.ok(read.kind === "present", `the installed schema ${installed.schema} is absent`)
		assert.deepEqual(
			checkInstalled(read.catalog, installedScope(installed.installation, installed.snapshot)),
			[],
			`the installed-catalog checker over ${installed.schema}`
		)
	})
