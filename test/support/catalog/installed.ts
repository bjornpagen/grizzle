import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import { identifierOf, identity, roleIdentity } from "#compiler/core/identity.ts"
import { bookkeepingTables } from "#compiler/deploy/ledger/ledger.ts"
import type { RecordedStatement } from "#compiler/deploy/snapshot/recorded.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { PhysicalKind } from "#compiler/ir/products.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { roleView } from "#compiler/physical/ddl/names.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { roleSeesWhole } from "#compiler/schema/own.ts"
import type { CreateDomain, Expr, GuardFiring, SqlStatement } from "#compiler/sql/ast.ts"
import { declaredSearchPath } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"
import { type Catalog, type CatalogColumn, readCatalog } from "#test/support/catalog/read.ts"
import {
	type ErasureExpectation,
	type ErasureProblem,
	type InstalledFunction,
	type StatedShape,
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
	name: (statement: RecordedStatement) => Option.Option<string>
): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(snapshot.manifest.objects, (o) =>
			o.kind === kind ? Arr.flatMap(o.ddl, (s) => Option.toArray(name(s))) : []
		)
	)

const tableOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createTable" ? Option.some(s.table.name) : Option.none()

const storedTableOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createStoredTable" ? Option.some(s.name.name) : Option.none()

const functionOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createFunction"
		? Option.some(s.name.name)
		: s.kind === "recordedFunction"
			? Option.some(s.header.name.name)
			: Option.none()

/** A function owner's role, by its CREATE ROLE. */
const roleOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createRole" ? Option.some(s.name) : Option.none()

/** A declared function's row type, by its CREATE TYPE. */
const rowTypeOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createRowType" ? Option.some(s.name.name) : Option.none()

/** A declared volatility as pg_proc.provolatile spells it. */
const provolatile = { IMMUTABLE: "i", STABLE: "s", VOLATILE: "v" } as const

const guardTriggerOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createGuardTrigger" ? Option.some(s.name) : Option.none()

const guardedTableOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createGuardTrigger" ? Option.some(s.table.name) : Option.none()

/** The name of an immutability guard's trigger that fires on `on`. */
const immutableTriggerOf =
	(on: GuardFiring) =>
	(s: SqlStatement | RecordedStatement): Option.Option<string> =>
		s.kind === "createImmutableGuardTrigger" && s.on === on ? Option.some(s.name) : Option.none()

const ruleTriggerOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createConstraintTrigger" ? Option.some(s.name) : Option.none()

const captureTriggerOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
	s.kind === "createTransitionTrigger" ? Option.some(s.name) : Option.none()

const rowSecureOf = (s: SqlStatement | RecordedStatement): Option.Option<string> =>
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

/**
 * The tables whose installed statements run each function, by its name: a table's CREATE TABLE and every ALTER TABLE
 * of it a manifest holds, a CHECK's and a generated column's calls among them, and every function a constant those
 * call calls in its body, transitively: a CHECK hoisted into its row function (physical/ddl/row-functions.ts) calls the
 * row function, whose body calls the constants the CHECK reads, and PostgreSQL checks EXECUTE on each as the body runs,
 * against the writer.
 */
const tableCallers = (
	manifest: Installation["manifest"]
): ReadonlyMap<string, ReadonlySet<string>> => {
	const bodies = new Map<string, ReadonlyArray<string>>()
	for (const o of manifest.objects) {
		for (const s of o.ddl) {
			if (s.kind === "createConstant") {
				bodies.set(s.name.name, statementCalls(s))
			}
		}
	}
	const out = new Map<string, Set<string>>()
	for (const o of manifest.objects) {
		for (const s of o.ddl) {
			const table =
				s.kind === "createTable" ? s.table.name : s.kind === "alterTable" ? s.table.name : undefined
			if (table === undefined) {
				continue
			}
			const pending = [...statementCalls(s)]
			const reached = new Set<string>()
			for (let fn = pending.pop(); fn !== undefined; fn = pending.pop()) {
				if (reached.has(fn)) {
					continue
				}
				reached.add(fn)
				for (const called of bodies.get(fn) ?? []) {
					pending.push(called)
				}
			}
			for (const fn of reached) {
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

/** The kinds of constant the installer names a function of (physical/ddl/context.ts addConstant), each recorded with
 * the identity it named the function by (Installation identities). */
type ConstantKind =
	| "closedConstant"
	| "rosterConstant"
	| "rosterLive"
	| "libraryFunction"
	| "rowFunction"

const constantKinds: ReadonlySet<string> = new Set<ConstantKind>([
	"closedConstant",
	"rosterConstant",
	"rosterLive",
	"libraryFunction",
	"rowFunction"
])

const isConstantKind = (kind: string): kind is ConstantKind => constantKinds.has(kind)

/** The kind the installer recorded each function of a constant object as, by the identifier it named it by: what the
 * verifier judges it by, never its language or its shape. */
const recordedKinds = (installation: Installation): ReadonlyMap<string, ConstantKind> =>
	new Map(
		Arr.flatMap(installation.identities, (named) =>
			isConstantKind(named.kind) ? [[named.identifier, named.kind] as const] : []
		)
	)

/** What a CREATE of a row function or a library function states of its shape (verify.ts StatedShape). */
const statedShape = (
	s: Extract<SqlStatement, { readonly kind: "createConstant" }>
): StatedShape => ({
	language: s.language,
	params: Arr.map(s.params, (p) => p.name),
	strict: "strict" in s && s.strict,
	config: s.language === "plpgsql" ? [closedSearchPathConfig] : []
})

/** The closed search_path as pg_proc.proconfig spells a row function's SET clause. */
const closedSearchPathConfig = "search_path=pg_catalog, pg_temp"

/**
 * Each function an installation's constant objects create, as the kind the installer recorded it (`recordedKinds`): a
 * closed relation's constant (`closedClassifier`), a roster's names constant, or its live-codes constant with the
 * domains among the installation's whose CHECK calls it, or a row function or a library function of the shape its
 * CREATE states, with the tables whose CHECKs and generated columns call it. The installation holds each constant's
 * body, which its snapshot records by its header alone. A constant the installer recorded no kind of is grizzle's
 * defect.
 */
const constantsOf = (
	installation: Installation
): ReadonlyArray<readonly [string, InstalledFunction]> => {
	const kinds = recordedKinds(installation)
	const closed = closedClassifier(installation)
	const callers = tableCallers(installation.manifest)
	const domains = Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "domain"
			? Arr.flatMap(o.ddl, (s): ReadonlyArray<CreateDomain> =>
					s.kind === "createDomain" ? [s] : []
				)
			: []
	)
	const checking = (fn: string): ReadonlyArray<string> =>
		Arr.flatMap(domains, (d) =>
			Arr.some(d.constraints, (c) => Arr.contains(callsOf(c.predicate), fn)) ? [d.name.name] : []
		)
	const kindOf = (name: string): ConstantKind =>
		Option.getOrThrowWith(
			Option.fromUndefinedOr(kinds.get(name)),
			() =>
				new Error(`the installation names its constant ${name} by no identity of a constant's kind`)
		)
	return Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "constant"
			? Arr.flatMap(o.ddl, (s): ReadonlyArray<readonly [string, InstalledFunction]> => {
					if (s.kind === "packConstant") {
						return [[s.function.name, closed(s.function.name)]]
					}
					if (s.kind !== "createConstant") {
						return []
					}
					const name = s.name.name
					const kind = kindOf(name)
					switch (kind) {
						case "closedConstant":
							return [[name, closed(name)]]
						case "rosterConstant":
							return [[name, { kind: "names" }]]
						case "rosterLive":
							return [[name, { kind: "live", domains: checking(name) }]]
						case "rowFunction":
						case "libraryFunction":
							return [
								[
									name,
									{
										kind,
										shape: statedShape(s),
										tables: Arr.sort(callers.get(name) ?? [], Order.String)
									}
								]
							]
					}
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
	/** The judged tables' stand-ups (physical/ddl/rules.ts addStandUps), law functions every role writing their table
	 * executes, by name. */
	const standUps = new Set<string>(
		Arr.flatMap(installation.identities, (named) =>
			named.kind === "ruleStandUp" ? [identifierOf(named)] : []
		)
	)
	/** Each trigger the manifest's objects of `kind` create, as `what`. */
	const triggersOf = (
		kind: PhysicalKind,
		name: (s: RecordedStatement) => Option.Option<string>,
		what: InstalledTrigger
	) => Arr.map([...created(snapshot, kind, name)], (trigger) => [trigger, what] as const)
	/** The bookkeeping tables, each of which the snapshot's ledger objects create (deploy/ledger/ledger.ts
	 * bookkeepingTables). */
	const bookkeeping = new Set(Arr.map(bookkeepingTables, (b) => b.name))
	const ledgers = created(snapshot, "ledger", tableOf)
	assert.deepEqual(
		ledgers,
		bookkeeping,
		"the snapshot's ledger objects create the bookkeeping tables"
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
			/** Each query entry's view, by the naming door. */
			const theory = roleIdentity(
				defined(installation.names.levels[r.base.levels.length - 1], `the level of role ${r.name}`),
				parsedName(r.name),
				r.loc
			)
			const roleSchema = identifierOf(identity.roleSchema(theory))
			const barrierViews = Arr.flatMap(Rec.values(r.relations), (e) =>
				e.kind === "world" ? [`${roleSchema}.${identifierOf(roleView(theory, e))}`] : []
			)
			/** The whole view of `relation`, in its level's schema of whole views, by the naming door. */
			const wholeView = (relation: string): string =>
				`${identifierOf(identity.wholeSchema(identifierOf(installation.names.levelOf(relation))))}.${identifierOf(identity.wholeView(parsedName(relation)))}`
			/** Each whole view it reads: a whole entry's over a stored relation, each stored derived relation's it reads
			 * in full (schema/own.ts OwnedRole `wholeDerived`), and each stored canonical relation's its base names
			 * nowhere, an anonymous one's or a level's above its base, whose definition reads only relations it sees whole
			 * (schema/own.ts roleSeesWhole), named by its form (physical/ddl/roles.ts anonymousTables). */
			const seesWhole = roleSeesWhole(r)
			const wholeViews = [
				...Arr.flatMap(Rec.values(r.relations), (e) =>
					e.kind === "whole" && installation.owned.relations[e.name]?.kind === "relation"
						? [wholeView(e.name)]
						: []
				),
				...Arr.flatMap(r.wholeDerived, (relation) =>
					installation.checked.holdings.get(relation)?.kind === "stored"
						? [wholeView(relation)]
						: []
				),
				...Arr.flatMap([...installation.checked.canonical.values()], (c) => {
					if (
						c.holding.kind !== "stored" ||
						Rec.has(r.base.relations, c.subject.name) ||
						!Arr.every(c.subject.reads, seesWhole)
					) {
						return []
					}
					const view = installation.names.canonicalWholeView(c.subject.name)
					return [`${identifierOf(view.schema)}.${identifierOf(view.name)}`]
				})
			]
			return {
				scope: { role: installedRole.role, closedTypes },
				barrierViews,
				queryWorld: barrierViews.length > 0 ? [installedRole.role] : [],
				wholeViews: Arr.map(wholeViews, (view) => [view, installedRole.role] as const)
			}
		})
	)
	return {
		erasure: {
			tables: created(snapshot, "table", tableOf),
			mutable: new Set(
				Arr.flatMap(relations, (r) => (r.kind === "relation" && r.mutable ? [r.ident] : []))
			),
			successors: new Set(
				Arr.flatMap(installation.laws.families, (f) =>
					f.shape.kind !== "tree" && f.owner.mutable
						? [`${installation.names.relation(f.member.name).name}.${f.next}`]
						: []
				)
			),
			storedTables: created(snapshot, "storedTable", storedTableOf),
			bookkeeping,
			heads: created(snapshot, "head", tableOf),
			releasedHeads: new Set(
				Arr.flatMap(Rec.toEntries(snapshot.theory.relations), ([name, r]) =>
					r.kind === "relation"
						? Arr.flatMap(r.fields, (f) =>
								f.writing === "place"
									? [installation.names.head({ kind: "field", relation: name, field: f.name }).name]
									: []
							)
						: []
				)
			),
			foundings: created(snapshot, "founding", tableOf),
			ledger: ledgerTableName,
			guarded: created(snapshot, "isolationTrigger", guardedTableOf),
			functions: new Map<string, InstalledFunction>([
				...functionsOf("refusalFunction", { kind: "refusal" }),
				...functionsOf("borrowFunction", { kind: "borrow" }),
				...functionsOf("isolationFunction", { kind: "isolationGuard" }),
				...functionsOf("ruleJudge", { kind: "rule" }),
				...Arr.map(
					functionsOf("lawFunction", { kind: "rule" }),
					([name, what]) =>
						[name, standUps.has(name) ? ({ kind: "standUp" } as const) : what] as const
				),
				...functionsOf("immutableGuard", { kind: "immutableGuard" }),
				...functionsOf("snapshotGuard", { kind: "snapshotGuard" }),
				...functionsOf("worldFunction", { kind: "world" }),
				...functionsOf("headStamp", { kind: "stamp" }),
				...constantsOf(installation),
				...Arr.flatMap(snapshot.manifest.objects, (o) =>
					o.kind === "declaredFunction"
						? Arr.flatMap(o.ddl, (s): ReadonlyArray<readonly [string, InstalledFunction]> =>
								s.kind === "recordedDeclaredFunction"
									? [
											[
												s.header.name.name,
												{
													kind: "declared",
													volatility: provolatile[s.header.volatility],
													strict: s.header.nullInput === "STRICT",
													path: declaredSearchPath(s.header)
												}
											]
										]
									: []
							)
						: []
				)
			]),
			triggers: new Map<string, InstalledTrigger>([
				...triggersOf("isolationTrigger", guardTriggerOf, "isolation"),
				...triggersOf("immutableTrigger", immutableTriggerOf("rows"), "immutable rows"),
				...triggersOf("immutableTrigger", immutableTriggerOf("truncate"), "immutable truncate"),
				...triggersOf("lawTrigger", ruleTriggerOf, "rule"),
				...triggersOf("lawTrigger", captureTriggerOf, "capture")
			]),
			rowSecure: created(snapshot, "rowSecurity", rowSecureOf),
			logins: new Map(
				Arr.map(
					installation.worlds,
					(l) =>
						[
							l.role,
							{
								roles: new Set(Arr.map(l.roles, (r) => r.role)),
								fenced: new Set(Arr.map(l.fenced, (t) => t.name))
							}
						] as const
				)
			),
			barrierViews: new Set(Arr.flatMap(scoped, (s) => s.barrierViews)),
			queryWorlds: new Set(Arr.flatMap(scoped, (s) => s.queryWorld)),
			wholeViews: new Map(
				Arr.map(
					[
						...Map.groupBy(
							Arr.flatMap(scoped, (s) => s.wholeViews),
							([view]) => view
						)
					],
					([view, held]) => [view, new Set(Arr.map(held, ([, role]) => role))] as const
				)
			),
			closedConstants: Arr.some(
				Rec.values(installation.owned.relations),
				(r) => r.kind === "closedRelation"
			),
			closedTypes: new Map(Arr.map(scoped, (s) => [s.scope.role, s.scope.closedTypes] as const)),
			liveSource: liveSourceOf(snapshot),
			functionOwner: Arr.head([...created(snapshot, "functionOwner", roleOf)]),
			rowTypes: created(snapshot, "rowType", rowTypeOf)
		},
		roles: Arr.map(scoped, (s) => s.scope)
	}
}

/**
 * The live source a snapshot installs (physical/ddl/live.ts): its secret's table, by its CREATE TABLE ... AS, its
 * decoder login, by its CREATE ROLE, and its publication, by its CREATE PUBLICATION; none where its manifest holds
 * none of them.
 */
const liveSourceOf = (snapshot: DeploySnapshot): ErasureExpectation["liveSource"] => {
	const secret = Arr.findFirst(
		Arr.flatMap(snapshot.manifest.objects, (o) => (o.kind === "liveSecret" ? o.ddl : [])),
		(s) => (s.kind === "createLiveSecret" ? Option.some(s.table.name) : Option.none())
	)
	const decoder = Arr.findFirst(
		Arr.flatMap(snapshot.manifest.objects, (o) => (o.kind === "decoder" ? o.ddl : [])),
		(s) => (s.kind === "createRole" ? Option.some(s.name) : Option.none())
	)
	const publication = Arr.findFirst(
		Arr.flatMap(snapshot.manifest.objects, (o) => (o.kind === "publication" ? o.ddl : [])),
		(s) => (s.kind === "createPublication" ? Option.some(s.name) : Option.none())
	)
	return Option.isSome(secret) && Option.isSome(decoder) && Option.isSome(publication)
		? {
				kind: "source",
				secret: secret.value,
				decoder: decoder.value,
				publication: publication.value
			}
		: { kind: "none" }
}

/**
 * One way an installed catalog departs from least privilege on the vector type's reach and its logins' defaults, or an
 * index that is not valid, by the rule it breaks and the catalog facts that break it.
 */
export type ReachProblem =
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

/**
 * Indexes of one table a sound installation never holds together, by their names: two unique indexes of one access
 * method over one column set and predicate (`duplicateKey`), which hold apart the same rows whatever order each lists
 * the columns in (ir/law.ts KeyColumnSet), so one serves every foreign key into the set; or two indexes of one
 * definition (`duplicateIndex`), their columns in one order, each with one direction and class, of one method and
 * predicate, which serve the same probes, the unique one every probe the other does.
 *
 * Any other index beside a unique one over its column set is neither: it is not unique, and its columns stand in
 * another order, so the probes it serves lead with other columns.
 */
export type IndexProblem =
	| {
			readonly kind: "duplicateKey"
			readonly table: string
			readonly indexes: ReadonlyArray<string>
	  }
	| {
			readonly kind: "duplicateIndex"
			readonly table: string
			readonly indexes: ReadonlyArray<string>
	  }

/** Every way an installed catalog departs from the scope its installation declares. */
export type InstalledProblem = ErasureProblem | ReachProblem | IndexProblem

/** An index's definition past its name and uniqueness: its method, its columns in order with their directions and
 * classes, and its predicate, as pg_get_indexdef spells them. */
const definitionOf = (i: Catalog["indexes"][number]): string =>
	Option.match(Str.indexOf(" USING ")(i.definition), {
		onNone: () => assert.fail(`pg_get_indexdef spells the access method of ${i.name}`),
		onSome: (at) => Str.slice(at)(i.definition)
	})

/** The indexes no sound installation holds together (IndexProblem), each group by its table, method, predicate and
 * column set. */
const indexProblems = (catalog: Catalog): ReadonlyArray<IndexProblem> => {
	const groups = new TupleMap<
		ReadonlyArray<string>,
		{ readonly table: string; readonly indexes: Array<Catalog["indexes"][number]> }
	>()
	for (const i of catalog.indexes) {
		const key = [
			i.table,
			i.method,
			Option.getOrElse(i.predicate, () => ""),
			...Arr.sort(i.columns, Order.String)
		]
		const held = groups.get(key)
		if (held === undefined) {
			groups.set(key, { table: i.table, indexes: [i] })
		} else {
			held.indexes.push(i)
		}
	}
	return Arr.flatMap(
		[...groups.values()],
		({ table, indexes: group }): ReadonlyArray<IndexProblem> => {
			const keys = Arr.filter(group, (i) => i.unique)
			const definitions = new TupleMap<readonly [string], Array<string>>()
			for (const i of group) {
				const held = definitions.get([definitionOf(i)])
				if (held === undefined) {
					definitions.set([definitionOf(i)], [i.name])
				} else {
					held.push(i.name)
				}
			}
			return [
				...(keys.length > 1
					? [{ kind: "duplicateKey" as const, table, indexes: Arr.map(keys, (i) => i.name) }]
					: []),
				...Arr.flatMap([...definitions.values()], (names) =>
					names.length > 1 ? [{ kind: "duplicateIndex" as const, table, indexes: names }] : []
				)
			]
		}
	)
}

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

/**
 * The types an insert by `role` names: those of every column of a table it holds INSERT on but a generated one, whose
 * value PostgreSQL computes and no insert carries.
 */
const insertedTypes = (catalog: Catalog, role: string): ReadonlyArray<NamedType> =>
	Arr.flatMap(
		tableColumns(catalog, role, (p) => p === "INSERT"),
		(c) => (c.generation.kind === "computed" ? [] : [c.type])
	)

/** The column types of every view `role` holds SELECT on: its world's, and the whole views of what it holds whole. */
const viewedTypes = (catalog: Catalog, role: string): ReadonlyArray<NamedType> =>
	Arr.flatMap([...catalog.worlds, ...catalog.wholes], (w) =>
		Arr.flatMap(w.relations, (v) =>
			Arr.some(v.grants, (g) => g.grantee === role && g.privilege === "SELECT")
				? Arr.map(v.columns, (c) => c.type)
				: []
		)
	)

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
 * lc_numeric and lc_time at C.UTF-8, generic plans always (plan_cache_mode at force_generic_plan), and the search
 * path of pg_catalog and the session's temporary schema alone, a list PostgreSQL stores with its schemas bare. Nothing
 * else: jit and lc_messages are the database owner's.
 */
const fixedDefaults: ReadonlyArray<string> = [
	"DateStyle=ISO, YMD",
	"bytea_output=hex",
	"extra_float_digits=1",
	"lc_monetary=C.UTF-8",
	"lc_numeric=C.UTF-8",
	"lc_time=C.UTF-8",
	"plan_cache_mode=force_generic_plan",
	"search_path=pg_catalog, pg_temp"
]

/** The search setting grizzle pins, strict-order iterative scans, stored the same way. */
const searchDefaults: ReadonlyArray<string> = Arr.map(
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
	const loginProblems = Arr.flatMap([...scope.erasure.logins], ([login, { roles }]) => [
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
 * - the erasure ledger's shape rules (verify.ts): only the authored tables, the stored derived relations' tables,
 *   the refusal function, the isolation guard and each table's guard trigger, the snapshot guard every login executes,
 *   the law functions and law triggers, the worlds' functions, and PostgreSQL's
 *   internal foreign-key triggers; the worlds' schemas of their query entries' views, each security_barrier, and the
 *   levels' schemas of whole views, each plain and granted exactly to the roles holding its relation whole; row
 *   security and policies exactly where a world writes through a query entry; no UPDATE on an immutable relation, no
 *   TRUNCATE, no sequence, MAINTAIN only to a login fencing the table, nothing to a world on a stored derived
 *   relation's table, no PUBLIC grant,
 *   nothing granted to a login beyond what admission and a Db transaction take as it, nothing granted on a domain,
 *   nothing inherited beyond a role's own privileges, no elevated
 *   or undeclared role; no index is invalid; and no table holds two unique indexes of one method over one column set
 *   and predicate, or two indexes of one definition (IndexProblem);
 * - the vector type, by a derivation of its own: a world's role holds USAGE on a schema outside the installation exactly
 *   when a column it reads (of the views it reads, or of its whole closed relations' payloads) or a column of a table it
 *   inserts into is, or rests through the schema's domains on, that schema's `vector`, so it can name the type a search
 *   binds; and each login stores exactly the fixed defaults (`search_path = pg_catalog, pg_temp`,
 *   `extra_float_digits = 1`, `bytea_output = hex` and lc_monetary, lc_numeric and lc_time at C.UTF-8) plus, exactly
 *   when one of its roles
 *   names the vector type, `hnsw.iterative_scan = strict_order` (check/approximate/policy.ts), which PostgreSQL applies
 *   at login and never on SET ROLE.
 *
 * The derivation reads the catalog's own grants and types; the declaration supplies only what the catalog cannot show:
 * which closed relations a world holds, from the installation's owned logins and closed templates. Which object is which is read from the manifest's object kinds.
 *
 * Every way the installed catalog departs from its scope; none for a sound installation. An index that is not valid, as
 * a failed concurrent build leaves one, serves no query and supplies no constraint, so no installation holds one.
 */
export const checkInstalled = (
	catalog: Catalog,
	scope: InstalledScope
): ReadonlyArray<InstalledProblem> => [
	...verifyErasure(catalog, scope.erasure),
	...vectorProblems(catalog, scope),
	...Arr.flatMap(catalog.indexes, (i) => unless(i.valid, { kind: "invalidIndex", index: i.name })),
	...indexProblems(catalog)
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
