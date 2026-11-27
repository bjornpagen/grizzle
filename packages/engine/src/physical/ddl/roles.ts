import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { DerivedRelationAnalysis } from "#compiler/analysis/derived/analyze.ts"
import type { WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import {
	checkedRoleOver,
	type CheckedSchema,
	derivedAnalysis,
	type CheckedEntry,
	type RoleEntry,
	type RoleWorld,
	type RoleWrite
} from "#compiler/analysis/schema.ts"
import { refuse } from "#compiler/analysis/theory/build.ts"
import { withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import type { AdmittedQuery } from "#compiler/check/index.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	conversionOf,
	type Identity,
	identifierOf,
	identity,
	loginIdentity,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { type DerivedRows, noneWritten } from "#compiler/ir/derived.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { Family } from "#compiler/ir/family.ts"
import type {
	ClosedTheoryRelation,
	LawField,
	RelationInfo,
	TheoryRelation
} from "#compiler/ir/law.ts"
import { baseTypeRef, missing } from "#compiler/ir/physical.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { derivedEvidence, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { servedCatalog, wholeViewAliases } from "#compiler/physical/access/catalog.ts"
import {
	type RoleWorldViews,
	roleWorldViews,
	viewColumns,
	type WorldView
} from "#compiler/physical/access/world-views.ts"
import { namesConstant } from "#compiler/physical/ddl/constants.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	emptyUse,
	structuralRegex,
	type TextColumnUse,
	type TypeUse,
	columnDomains,
	usedNodes
} from "#compiler/physical/ddl/domains.ts"
import type { InstalledFunction } from "#compiler/physical/ddl/functions.ts"
import { snapshotGuardFunction } from "#compiler/physical/ddl/ledger.ts"
import {
	type InstallNames,
	levelIn,
	type NamedRole,
	type RoleViewName,
	roleView
} from "#compiler/physical/ddl/names.ts"
import type { StampFunction } from "#compiler/physical/ddl/stamps.ts"

/** A function a role executes beside its statements' own: a head's stamp function, or a declared function its served
 * programs reach. */
/**
 * The stand-up of the rule judge's session tables a write of one relation needs (physical/ddl/rules.ts addStandUps),
 * which every role whose grants let it write the relation executes.
 */
export interface JudgeStandUp {
	readonly node: Node<"validate">
	readonly name: FunctionName
}

type CalledFunction = StampFunction | InstalledFunction | JudgeStandUp

/**
 * What a role holds beside its statements' own objects: EXECUTE on each function it calls, and SELECT and DELETE on the
 * head table of each place of a relation it deletes from, whose deletes delete the heads of the groups they remove
 * (write/insert/stamp.ts placeReleases).
 */
interface Held {
	readonly called: ReadonlyArray<CalledFunction>
	readonly released: ReadonlyArray<{ readonly node: Node<"structure">; readonly table: ObjectName }>
}
import { type LoweredDefinition, lowerDefinition } from "#compiler/physical/derived/definition.ts"
import type { LoginFence, RoleCall, RoleCarriers } from "#compiler/physical/install/extension.ts"
import { enforcement, type Node, type ObjectSpec } from "#compiler/physical/obligations/graph.ts"
import type { HeadStanding } from "#compiler/schema/entry.ts"
import type { OwnedEntry, OwnedLogin, OwnedRole, OwnedWorldEntry } from "#compiler/schema/own.ts"

import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	ColumnPrivilege,
	Expr,
	FunctionName,
	Grant,
	Grantee,
	ObjectName,
	Privilege,
	RoleSetting,
	Select,
	SqlStatement,
	TextSetting,
	TypeSchema
} from "#compiler/sql/ast.ts"
import { nameKey } from "#compiler/sql/ast.ts"
import {
	col,
	lit,
	namedType,
	objectName,
	or,
	param,
	provedSelect,
	qualifiedCall,
	table,
	target
} from "#compiler/sql/build.ts"
import type { Alias } from "#compiler/sql/naming.ts"
import { printExpr, printStartupOptions } from "#compiler/sql/print.ts"
import { borrowFunction } from "#compiler/write/borrow/function.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import {
	filterFields,
	filterReadsOther,
	renderMembership,
	renderProbes
} from "#compiler/write/entry/render.ts"
import { endColumns } from "#compiler/write/family/statements.ts"
import {
	type OutsideProbe,
	probeIdentity,
	probeParams,
	relationUniques
} from "#compiler/write/insert/unique.ts"
import { refusalFunction } from "#compiler/write/refusal.ts"

/**
 * Generic plans, always: plan_cache_mode at force_generic_plan, under which a session plans each statement it prepares
 * once, as PostgreSQL plans a statement it has no values for, and keeps that plan for the session, never planning a
 * call with its values (plancache.c choose_custom_plan). Under the default auto mode a session plans a statement's first
 * five calls with their values and then keeps planning each call whose generic plan its estimate puts above their
 * average: a cold backend paid five plans of a statement and a generic build before it reused one (PERF-COMMIT's metis
 * split at f87b2aaab: the submit's 9.5 MB statement planned in 131 s and 19.9 GB a call, five times, then 72 s for its
 * generic plan; the 880 KB heartbeat five times 0.5 to 1.1 s, then 0.7 s). Every session grizzle opens starts under it,
 * whoever it is: a login's, which stores it beside its other defaults (roleDefaultSettings), and an owner's
 * (ownerStartupOptions). Bjorn approved it in the read-committed cutover (2026-11-23), the one planner setting grizzle
 * pins.
 */
export const genericPlans = {
	parameter: "plan_cache_mode",
	value: "force_generic_plan"
} as const satisfies RoleSetting

/**
 * The fixed login defaults, every login's, each one a grizzle guarantee rests on (sql/ast.ts textParameters): one list,
 * which the installation stores as ALTER ROLE ... SET, admission reads back from the manifest that holds those
 * statements (deploy/admission/roles.ts roleExpectation), and every session of a login's pool sets again at its
 * startup (loginStartupOptions). Every other setting, jit and lc_messages among them, is the database owner's.
 */
export const roleDefaultSettings = [
	{ parameter: "search_path" },
	{ parameter: "extra_float_digits", value: "1" },
	{ parameter: "DateStyle", value: "ISO, YMD" },
	{ parameter: "bytea_output", value: "hex" },
	{ parameter: "lc_monetary", value: "C.UTF-8" },
	{ parameter: "lc_numeric", value: "C.UTF-8" },
	{ parameter: "lc_time", value: "C.UTF-8" },
	genericPlans
] as const satisfies NonEmptyReadonlyArray<RoleSetting>

/**
 * The startup packet's `options` of every session of a login's pool (wire/session.ts): each fixed default at its
 * stored value. The client's own options outrank every default a session starts under, a database's and a role's
 * included, and pg sends them in place of the environment's PGOPTIONS, which it reads only when a client names none.
 */
export const loginStartupOptions: string = printStartupOptions(roleDefaultSettings)

/**
 * The startup packet's `options` of every owner's session (wire/session.ts): the migration identity's, every command
 * line's, the drift check's, the live leader's and a listener's. An owner stores none of a login's
 * defaults and states none of them; it starts under generic plans alone (genericPlans), the one setting every session
 * grizzle opens starts under.
 */
export const ownerStartupOptions: string = printStartupOptions([genericPlans])

/**
 * The search settings as login defaults, for a login one of whose roles can name the vector type: pgvector's
 * strict-order iterative scan and its scan bound (check/approximate/policy.ts hnswPolicy), the two search settings
 * grizzle pins.
 */
export const searchPolicySettings: NonEmptyReadonlyArray<TextSetting> = [
	{ parameter: "hnsw.iterative_scan", value: hnswPolicy.iterativeScan },
	{ parameter: hnswPolicy.maxScanTuples.setting, value: String(hnswPolicy.maxScanTuples.value) }
]

/** The statement that loads the vector library in the migration session, so its `hnsw.*` parameters are known when the
 * login defaults store them: a call of one of its C functions on a vector it parses. */
const vectorLibraryLoad = (vectorSchema: TypeSchema): Select =>
	provedSelect(
		"oneRow",
		[
			target(
				qualifiedCall(
					{ kind: "qualified", schema: vectorSchema, name: "vector_dims", volatility: "IMMUTABLE" },
					[lit.text("[1]", namedType(vectorSchema, "vector", []))]
				)
			)
		],
		[],
		undefined
	)

/** One installed role, by its declared name: its theory role. */
export interface InstalledRole {
	readonly name: string
	readonly role: string
}

/**
 * One installed login, by its declared name: its PostgreSQL role, its roles, in name order, and the tables of the
 * relations it fences (analysis/isolation/certify.ts Fence), on each of which it holds MAINTAIN (addLogin).
 */
export interface InstalledLogin {
	readonly name: string
	readonly role: string
	readonly roles: ReadonlyArray<InstalledRole>
	readonly fenced: ReadonlyArray<ObjectName>
}

export interface WorldsPlan {
	readonly roleDefaults: ReadonlyArray<SqlStatement>
	readonly publicRevokes: ReadonlyArray<SqlStatement>
	/** The logins, in name order. */
	readonly worlds: ReadonlyArray<InstalledLogin>
}

/** A field of a context an installed role reads, typed against the base: what the installation plans a claim's domain
 * for, which Db.open's admission validates the claim against. */
interface ContextField {
	readonly context: string
	readonly field: string
	readonly desc: FieldDesc
	readonly type: ScalarType
	readonly loc: SourceLoc
}

/** Every field of every context `roles` read (`OwnedRole.contexts`), typed against the base, a context's
 * fields in name order. */
export const contextFieldsOf = (
	checked: CheckedSchema,
	roles: ReadonlyArray<OwnedRole>
): Result.Result<ReadonlyArray<ContextField>, CompileError> =>
	catchRefusal(() =>
		roles.flatMap((role) =>
			Object.values(role.contexts).flatMap((context) =>
				Object.entries(context.fields)
					.toSorted(([a], [b]) => compareStrings(a, b))
					.map(([field, desc]): ContextField => {
						const loc = SourceLoc(`context ${context.name} of role ${role.name}`, [])
						return { context: context.name, field, desc, type: checked.fieldType(desc, loc), loc }
					})
			)
		)
	)

/** A role the installation installs, read against the installed schema: the identity its PostgreSQL role is named by,
 * the view each of its relations is named by (names.ts NamedRole views), and its checked schema over the installed base,
 * built once for every reader of the role. */
export interface CheckedRole {
	readonly theory: Identity<"role">
	readonly views: NamedRole["views"]
	readonly checked: CheckedSchema<RoleWorld>
}

/** A login the installation installs, with each of its roles read against the installed schema, in the login's order. */
export interface CheckedLogin {
	readonly login: OwnedLogin
	readonly roles: ReadonlyArray<CheckedRole>
}

/** `role`, named under the installation (names.ts namedRole), read against the installed schema `base`: its identity,
 * then its checked schema over the base. */
export const checkedRole = (
	base: CheckedSchema,
	role: NamedRole
): Result.Result<CheckedRole, CompileError> =>
	Result.map(checkedRoleOver(role.owned, base), (checked) => ({
		theory: role.theory,
		views: role.views,
		checked
	}))

/** Every view column of a query entry a regex refinement types, as a use of its structural text domain: the definition
 * lowering casts such a column to its pattern's domain, so the domain must exist, and
 * it is planned with the schema's others (`planTextDomains`). Every context field an installed role reads that a
 * pattern refines is a use too, placed in use order by its context's and field's conversions, though a context names
 * no object: admission validates its claim against the domain. */
export const worldTextDomainUses = (
	fields: ReadonlyArray<ContextField>,
	roles: ReadonlyArray<CheckedRole>
): ReadonlyArray<TextColumnUse> => {
	const uses: Array<TextColumnUse> = []
	for (const f of fields) {
		const regex = structuralRegex(f.type)
		if (regex === undefined) {
			continue
		}
		uses.push({ regex, table: conversionOf(f.context), column: conversionOf(f.field) })
	}
	for (const { theory, checked } of roles) {
		for (const e of checked.entries) {
			if (e.kind !== "world") {
				continue
			}
			const view = identifierOf(roleView(theory, e.entry))
			for (const c of e.analysis.heading) {
				const regex = structuralRegex(c.type)
				if (regex === undefined) {
					continue
				}
				uses.push({ regex, table: view, column: identifierOf(identity.column(c.name)) })
			}
		}
	}
	return uses
}

/** What the installation of a base's worlds shares: the base checked, the catalog a query entry's definition and a
 * writable entry's membership are lowered against, and the definition's lowering. */
interface WorldsContext {
	readonly checked: CheckedSchema
	/** The schema's installed keys and containments, as every compilation sees them, with the derived relations'
	 * inherited keys; the transaction evidence context both lowerings run in admits only what holds at every statement. */
	readonly catalog: EvidenceCatalog
	readonly lower: (relation: string, query: AdmittedQuery, rows: DerivedRows) => LoweredDefinition
}

const worldsContext = (b: InstallBuilder): WorldsContext => {
	const checked = b.checked
	const catalog = evidenceCatalog({
		laws: b.model,
		views: derivedEvidence(derivedAnalysis(checked), b.model.existence)
	})
	return {
		checked,
		catalog,
		lower: (relation, query, rows) =>
			unwrap(lowerDefinition(relation, query, { names: b.names, catalog, rows }))
	}
}

type WholeEntry = Extract<OwnedEntry, { readonly kind: "whole" }>

/**
 * A role relation as the installation reads it: a whole entry over a stored relation with its theory relation, over a
 * closed relation with its theory relation, over a derived relation with its analysis, or a query entry.
 */
type RoleRelation =
	| {
			readonly kind: "stored"
			readonly entry: WholeEntry
			readonly relation: Extract<TheoryRelation, { readonly kind: "relation" }>
	  }
	| { readonly kind: "closed"; readonly entry: WholeEntry; readonly relation: ClosedTheoryRelation }
	| {
			readonly kind: "derived"
			readonly entry: WholeEntry
			readonly analysis: DerivedRelationAnalysis
	  }
	| { readonly kind: "world"; readonly entry: OwnedWorldEntry; readonly analysis: WorldAnalysis }

/** A writable entry of a role as the installation reads it: the entry over the installed schema's handles, and the
 * relation it writes. */
export interface WrittenEntry {
	readonly write: RoleWrite
	readonly relation: RelationInfo
}

/** A relation of a role as the installation reads it: a whole entry by the kind of the base relation its checked schema
 * holds, the installed schema's own handle or analysis, or a query entry with its analysis. */
const roleRelation =
	(checked: CheckedSchema) =>
	(e: RoleEntry): RoleRelation => {
		if (e.kind === "world") {
			return { kind: "world", entry: e.entry, analysis: e.analysis }
		}
		const r = e.relation
		switch (r.kind) {
			case "relation":
				return { kind: "stored", entry: e.entry, relation: r }
			case "closed":
				return { kind: "closed", entry: e.entry, relation: r.relation }
			case "derived": {
				/** A role holds a derived relation whole only where its base stores it (schema/own.ts OwnedRole `wholeDerived`). */
				const holding = checked.holdings.get(r.name)
				return {
					kind: "derived",
					entry: e.entry,
					analysis: defined(
						holding?.kind === "stored" ? holding.analysis : undefined,
						`the stored analysis of ${r.name}, which a role holds whole`
					)
				}
			}
		}
	}

/** Each writable entry of a role, in name order, with the relation it writes: the role's write list over the installed
 * schema's handles (analysis/schema.ts RoleWrite), which names only relations the installed schema declares. */
export const roleWrites = (world: RoleWorld): ReadonlyArray<WrittenEntry> =>
	[...world.writes.values()].map((write) => ({
		write,
		relation: write.kind === "rows" ? write.writable.target : write.relation
	}))

/** One role relation's view: its CREATE VIEW, the graph objects it reads, and its columns' types. */
interface ViewPlan {
	readonly create: Extract<SqlStatement, { readonly kind: "createView" }>
	readonly reads: ReadonlyArray<Node<"setup" | "structure">>
	readonly heading: ReadonlyArray<HeadingColumn>
}

/** The view of a whole entry: every column of its table, in heading order, each closed id with
 * its decoded column after it, its table named by the alias its relation's whole view's body names it by
 * (physical/access/catalog.ts wholeViewAliases), under which PostgreSQL plans the table in the level that reads the view
 * once it flattens it, and the binding names its read (sql/bind.ts BindView `whole`). */
const wholeView = (
	b: InstallBuilder,
	name: ObjectName,
	relation: string,
	heading: NonEmptyReadonlyArray<HeadingColumn>,
	read: Node<"setup" | "structure"> | undefined,
	aliases: ReadonlyMap<string, Alias>
): ViewPlan => {
	const source = b.names.relation(relation)
	const alias =
		aliases.get(relation) ??
		missing(`physical: the whole view alias of ${relation}, a stored relation of the law model`)
	const columns = viewColumns(
		b.names,
		(of) => b.name(of),
		heading,
		(c) => b.names.column(relation, c.name),
		(c) => col(alias, b.names.column(relation, c.name))
	)
	return {
		create: {
			kind: "createView",
			name,
			columns: mapNonEmpty(columns, (c) => c.name),
			/** Every row and column of what it reads: it hides nothing, so no barrier keeps a reader's quals out. */
			barrier: false,
			query: provedSelect(
				"keyed",
				columns.map((c) => target(c.value)),
				[table(source.schema, source.name, alias)],
				undefined
			)
		},
		reads: read === undefined ? [] : [read],
		heading
	}
}

/**
 * The view of a query entry, named `name`, as its role's world view `view` states it (physical/access/world-views.ts
 * roleWorldViews): its body bound under its view scope, behind a security barrier, the facts of its definition, which
 * hides the others, so a barrier keeps a reader's quals after its own. Each identity its name, its columns and its
 * decoded columns are named by is named at the installation's door here (`b.name`), as every object's is.
 */
const worldViewPlan = (b: InstallBuilder, name: ObjectName, view: WorldView): ViewPlan => {
	if (nameKey(name) !== nameKey(view.binding.name)) {
		return missing(
			`physical: the world view ${name.schema}.${name.name}, which its role's compile named ${view.binding.name.schema}.${view.binding.name.name}`
		)
	}
	const analysis = view.analysis
	const decodes = analysis.heading.some((c) => baseOf(c.type).carrier === "code")
	for (const c of analysis.heading) {
		b.name(identity.column(c.name))
		const field = parseDeclaredName(c.name)
		if (decodes && baseOf(c.type).carrier === "code" && field.ok) {
			b.name(identity.decodedColumn(field.value))
		}
	}
	return {
		create: {
			kind: "createView",
			name,
			columns: view.binding.columns,
			barrier: true,
			query: view.bound
		},
		reads: analysis.reads.flatMap((read) => {
			const object = b.readObject(read)
			return object === undefined ? [] : [object]
		}),
		heading: analysis.heading
	}
}

/** A whole entry over a stored relation or a stored derived relation: one a whole view reads. */
type ViewedWhole = Extract<RoleRelation, { readonly kind: "stored" | "derived" }>

/** The whole view of a relation a whole entry holds, named `name`: its table's every row and column, a stored derived
 * relation's table's among them. */
const wholeViewOf = (
	b: InstallBuilder,
	name: ObjectName,
	r: ViewedWhole,
	aliases: ReadonlyMap<string, Alias>
): ViewPlan => {
	switch (r.kind) {
		case "stored":
			return wholeView(
				b,
				name,
				r.relation.name,
				r.relation.fields,
				b.readObject(r.relation.name),
				aliases
			)
		case "derived":
			return wholeView(
				b,
				name,
				r.entry.relation.name,
				r.analysis.heading,
				b.readObject(r.entry.relation.name),
				aliases
			)
	}
}

/** A relation's whole view as the installation creates it, once, for every role holding the relation whole: its CREATE
 * VIEW, its node, its columns, and its level's schema of whole views, by name and node. */
interface WholeViewObject {
	readonly create: Extract<SqlStatement, { readonly kind: "createView" }>
	readonly node: Node<"publish">
	readonly heading: ReadonlyArray<HeadingColumn>
	readonly schema: { readonly name: string; readonly node: Node<"publish"> }
}

/**
 * The whole views of the installation, by their relations' declared names: one per stored relation or stored derived
 * relation some role of `roles` holds whole, named as that role's names name it (names.ts RoleViewName `whole`), the
 * relation's name in its level's schema of whole views, and one per anonymous canonical relation some role reads
 * (`anonymousTables`), named by its form (names.ts InstallNames canonicalWholeView), created once with that schema,
 * owned by the owner. A whole view
 * is its relation's alone, the same view whichever role holds it: every role holding the relation is granted SELECT on
 * it (addRole), and no other.
 */
const addWholeViews = (
	b: InstallBuilder,
	roles: ReadonlyArray<CheckedRole>
): ReadonlyMap<string, WholeViewObject> => {
	/** The alias each whole view's body names its table by, by the relation's name. */
	const aliases = wholeViewAliases(b.model)
	/** Each whole view by its relation's name: its name, and its plan under the name it is created by. */
	const held = new Map<
		string,
		{
			readonly view: Extract<RoleViewName, { readonly kind: "whole" }>
			readonly plan: (name: ObjectName) => ViewPlan
		}
	>()
	for (const { views, checked } of roles) {
		for (const r of checked.entries.map(roleRelation(checked))) {
			if ((r.kind !== "stored" && r.kind !== "derived") || held.has(r.entry.name)) {
				continue
			}
			const view = views.get(r.entry.name)
			if (view?.kind !== "whole") {
				return missing(`physical: the whole entry ${r.entry.name} is named no whole view`)
			}
			held.set(r.entry.name, { view, plan: (name) => wholeViewOf(b, name, r, aliases) })
		}
		for (const t of anonymousTables(checked)) {
			if (!held.has(t.name)) {
				held.set(t.name, {
					view: b.names.canonicalWholeView(t.name),
					plan: (name) => wholeView(b, name, t.name, t.heading, b.readObject(t.name), aliases)
				})
			}
		}
	}
	const schemas = new Map<string, WholeViewObject["schema"]>()
	const out = new Map<string, WholeViewObject>()
	for (const [relation, { view, plan: planOf }] of [...held].toSorted(([x], [y]) =>
		compareStrings(x, y)
	)) {
		const schemaName = b.name(view.schema)
		const schema = schemas.getOrInsertComputed(schemaName, () => ({
			name: schemaName,
			node: b.add(
				{
					kind: "viewSchema",
					ident: { kind: "schema", name: view.schema },
					ddl: [{ kind: "createSchema", name: schemaName }],
					reasons: [enforcement(`the whole views of ${view.schema.display}`)],
					phase: "publish"
				},
				[]
			)
		}))
		const plan = planOf(objectName(schemaName, b.name(view.name)))
		const own = emptyUse()
		columnDomains(b, plan.heading, own)
		const node = b.add(
			{
				kind: "view",
				ident: { kind: "view", schema: view.schema, name: view.name },
				ddl: [plan.create],
				reasons: [enforcement(`the whole view of ${relation}`)],
				phase: "publish"
			},
			[schema.node, ...plan.reads, ...usedNodes(own)]
		)
		out.set(relation, { create: plan.create, node, heading: plan.heading, schema })
	}
	return out
}

/** A world function: a writable entry's filter function or one of its key and unique probes, its name and its object. */
interface WorldFunction {
	readonly name: FunctionName
	readonly spec: ObjectSpec<"publish">
}

/**
 * The rows of T a writable entry holds, which its policy holds the role's reads and writes of T to: "every" row, for a
 * whole entry and for a query entry whose filter is none, which narrows nothing the role's grants do not; or a
 * "narrowed" set, a query entry's with a filter, whose predicate over T's row is `filter`. `over` is the same predicate
 * over another row, each field of T it `reads` given by `row`: a family's owner rows, by the columns its group and copies
 * pair with those fields (`translated`).
 */
export type Membership =
	| { readonly kind: "every" }
	| {
			readonly kind: "narrowed"
			readonly filter: Expr
			readonly reads: ReadonlyArray<LawField>
			readonly over: (row: (field: LawField) => Expr) => Expr
	  }

const everyRow: Membership = { kind: "every" }

/** What a writable entry's membership is lowered against: the base it is over, checked, and the schema's catalog, the
 * definitions' (WorldsContext). */
export interface MembershipContext {
	readonly checked: CheckedSchema
	readonly catalog: EvidenceCatalog
}

/**
 * The rows of T a role's writable entry `w` holds (Membership): every row for a whole entry and for a query entry whose
 * filter is none; else the narrowed set, whose predicate over a row of T is the entry's membership there
 * (write/entry/render.ts renderMembership) where its filter reads T's row alone, and the role's filter function's call at
 * the fields of T it reads where it reads another relation, which runs as the owner. One construction serves the
 * installation, whose policy on T holds the role to it (`writePlan`, `addPolicy`), and certification, which reads every
 * read of T the role makes under it (program/isolation/member-facts.ts extractNames).
 */
export const entryMembership = (
	names: InstallNames,
	cx: MembershipContext,
	theory: Identity<"role">,
	w: WrittenEntry
): Membership => {
	const e = w.write
	if (e.kind === "whole" || e.writable.filter.kind === "none") {
		return everyRow
	}
	const writable = e.writable
	const relation = w.relation.name
	const tableName = names.relation(relation)
	const column = (field: LawField): string => names.column(relation, field.name)
	const reads = filterFields(writable)
	const fn = identity.filter(theory, e.name).identifier
	const over = (row: (field: LawField) => Expr): Expr =>
		filterReadsOther(writable)
			? qualifiedCall(
					{ kind: "qualified", schema: names.schema, name: fn, volatility: "STABLE" },
					reads.map((f) => row(f))
				)
			: unwrap(
					renderMembership(writable, {
						schema: cx.checked,
						names,
						catalog: cx.catalog,
						row: (f) => row(f)
					})
				)
	return {
		kind: "narrowed",
		filter: over((f) => col(tableName.name, column(f))),
		reads,
		over
	}
}

/**
 * The key and unique probes a role's query entry `w` installs over T (see `addWorlds`), exactly those of T's unique
 * objects (write/insert/unique.ts RelationUniques.probes) its precheck calls (write/entry/precheck.ts). The
 * installation creates each (`writePlan`); certification reads a call of each as its body (program/isolation/member-facts.ts extractNames).
 */
export const entryProbes = (
	model: LawModel,
	w: WrittenEntry & { readonly write: Exclude<RoleWrite, { readonly kind: "whole" }> }
): ReadonlyArray<OutsideProbe> => {
	const uniques = relationUniques(
		defined(
			model.relations.get(w.relation.name),
			"a law model holds the laws of every ordinary relation, a writable entry's among them"
		)
	)
	return uniques.probes
}

/** What one role's writable entry installs on its table: its membership, its filter function when its membership
 * reads another relation, its key and unique probes, and its privileges on the table. */
interface WritePlan {
	readonly membership: Membership
	/** The functions it installs: a query entry's filter function when it has one, then its key and unique probes. */
	readonly functions: ReadonlyArray<WorldFunction>
	readonly grants: ReadonlyArray<SqlStatement>
}

/** Whether a role holds column UPDATE on a head field of its writable entry over a mutable T: only on a free one. A key
 * field is the identity an update matches by, a family's is grizzle's, which a role that writes the family's member
 * holds UPDATE on as its member writer, and a claim-fixed one holds the claim's value in every fact of the world, so the
 * privilege set enforces the world beside the policy's WITH CHECK. */
const takesUpdate: Readonly<Record<HeadStanding, boolean>> = {
	free: true,
	family: false,
	claimFixed: false,
	keyed: false
}

/** The fields of the table a query entry writes that its role may update by its write list, which names an open
 * relation alone: each head field that takes UPDATE (`takesUpdate`) and that PostgreSQL does not compute. */
const updatableFields = (writable: CheckedEntry): ReadonlyArray<LawField> =>
	[...writable.head.values()].flatMap((h) =>
		takesUpdate[h.kind] && h.field.writing.kind !== "generated" ? [h.field] : []
	)

/** What a role's write of one entry holds on the table it writes, in the order a GRANT names them: SELECT and INSERT,
 * then UPDATE and DELETE, which only an entry of the write list holds. */
type EntryPrivileges = readonly [
	"SELECT",
	"INSERT",
	...ReadonlyArray<Exclude<TablePrivilege, "SELECT" | "INSERT">>
]

/**
 * The privileges a role's write of one entry holds on the table it writes, by the entry's mode, the one source its
 * grants are built from (`writePlan`) and certification reads (`grantedPrivileges`). By the insert list, SELECT and
 * INSERT alone. By the write list, which names an open relation alone (schema/own.ts writeClosed), mutable inside a
 * unit, DELETE as well, and UPDATE where it may update a field: a whole entry, or a query entry with an updatable field
 * (`updatableFields`).
 */
const entryPrivileges = (w: WrittenEntry): EntryPrivileges => {
	const write = w.write
	switch (write.mode) {
		case "insert":
			return ["SELECT", "INSERT"]
		case "write":
			return write.kind !== "rows" || isNonEmpty(updatableFields(write.writable))
				? ["SELECT", "INSERT", "UPDATE", "DELETE"]
				: ["SELECT", "INSERT", "DELETE"]
	}
}

const writePlan = (
	b: InstallBuilder,
	cx: WorldsContext,
	role: OwnedRole,
	theory: Identity<"role">,
	w: WrittenEntry
): WritePlan => {
	const e = w.write
	const written = w.relation
	const held = entryPrivileges(w)
	const grantee: NonEmptyReadonlyArray<Grantee> = [{ kind: "role", name: identifierOf(theory) }]
	const grant = (privileges: NonEmptyReadonlyArray<Privilege>, on: Grant["on"]): Grant => ({
		kind: "grant",
		privileges,
		on,
		to: grantee
	})
	if (e.kind === "whole") {
		const r = e.relation
		const tableName = b.names.relation(r.name)
		return {
			membership: everyRow,
			functions: [],
			grants: [
				grant(held, {
					kind: "TABLE",
					names: [tableName]
				})
			]
		}
	}
	const writable = e.writable
	const relation = written.name
	const tableName = b.names.relation(relation)
	const column = (field: LawField): string => b.names.column(relation, field.name)
	const all = written.fields.map(column)
	/** The columns a write names: every field but a generated one, the caller's and those grizzle writes for it (a
	 * family's drawn index and count, a fold's accumulator), then the drawn law columns
	 * grizzle writes. A generated field, which PostgreSQL computes, takes no INSERT or UPDATE. */
	const insertable = [
		...written.fields.filter((f) => f.writing.kind !== "generated").map(column),
		...drawnColumnsOf(b, relation)
	]
	const updatable = held.includes("UPDATE") ? updatableFields(writable).map(column) : []
	const columnGrant = (
		privilege: ColumnPrivilege,
		columns: ReadonlyArray<string>
	): ReadonlyArray<SqlStatement> =>
		isNonEmpty(columns)
			? [{ kind: "grantColumns", privilege, table: tableName, columns, to: identifierOf(theory) }]
			: []
	/** A query entry writes by column grants on its fields alone. */
	const grants: ReadonlyArray<SqlStatement> = [
		...columnGrant("SELECT", all),
		...columnGrant("INSERT", insertable),
		...columnGrant("UPDATE", updatable),
		...(held.includes("DELETE") ? [grant(["DELETE"], { kind: "TABLE", names: [tableName] })] : [])
	]
	/** The entry's probes (see `addWorlds`), exactly those of T's unique objects (write/insert/unique.ts
	 * RelationUniques.probes) an entry's precheck calls: whether T holds a fact that conflicts with the submitted values
	 * at one of its unique objects and lies outside the entry's membership, which the policy's own predicate decides
	 * over that row. One key probe per key of T, at the key's values (overlapping at a span field), and one unique probe
	 * per unique object of T no key subsumes, such as a key over a selected side, at the values of the fields it reads,
	 * within its guards on both sides. Each reads T and what the membership reads as the owner, as one rendering
	 * gives it to the installation and the certifier alike (write/entry/render.ts renderProbes). */
	const bodyOf = unwrap(
		renderProbes(writable, {
			schema: cx.checked,
			names: b.names,
			catalog: cx.catalog,
			dag: b.model.theory.dag,
			table: tableName,
			column
		})
	)
	/** A probe by its identity of its parameters (write/insert/unique.ts probeIdentity, probeParams), each at its base
	 * type, true where a fact of T outside the entry meets them at its object (renderProbes). */
	const probe = (probed: OutsideProbe): WorldFunction => {
		const named = probeIdentity(theory, e.name, probed)
		const what = probed.kind === "key" ? "the keys" : `the unique object ${probed.object.name}`
		const probeIdent = b.name(named)
		const allocated = fieldColumns(probeParams(probed), (f, i) => ({
			column: column(f),
			type: baseTypeRef(b.names, f.type),
			position: i + 1
		}))
		const params = allocated.columns
		const given = (field: LawField): Expr => {
			const p = allocated.of(field)
			return param(p.position, p.type)
		}
		const probeName: FunctionName = {
			schema: b.schema,
			name: probeIdent,
			args: params.map((p) => p.type)
		}
		return {
			name: probeName,
			spec: {
				kind: "worldFunction",
				ident: b.qualified("function", named),
				ddl: [
					{
						kind: "createFunction",
						advice: noAdvice,
						language: "sql",
						name: objectName(b.schema, probeIdent),
						volatility: "STABLE",
						parallel: "UNSAFE",
						security: "DEFINER",
						returns: "boolean",
						params: params.map((p) => ({ name: p.column, type: p.type })),
						body: bodyOf(probed, given)
					},
					{
						kind: "revoke",
						privileges: ["ALL"],
						on: { kind: "FUNCTION", names: [probeName] },
						from: [{ kind: "PUBLIC" }]
					}
				],
				reasons: [enforcement(`${what} of the writable entry ${role.name}.${e.name}`)],
				phase: "publish"
			}
		}
	}
	const probes = entryProbes(b.model, { write: e, relation: written }).map(probe)
	const probeGrants: ReadonlyArray<SqlStatement> = isNonEmpty(probes)
		? [grant(["EXECUTE"], { kind: "FUNCTION", names: mapNonEmpty(probes, (p) => p.name) })]
		: []
	const membership = entryMembership(b.names, cx, theory, w)
	if (!filterReadsOther(writable)) {
		return { membership, functions: probes, grants: [...grants, ...probeGrants] }
	}
	const filterNamed = identity.filter(theory, e.name)
	const fnIdent = b.name(filterNamed)
	/** The fields of T the membership reads, each with its column and its base type, the type the membership reads it
	 * at and the filter function's parameter's. */
	const fields = filterFields(writable).map((field) => ({
		column: column(field),
		type: baseTypeRef(b.names, field.type)
	}))
	const name: FunctionName = { schema: b.schema, name: fnIdent, args: fields.map((f) => f.type) }
	const body = unwrap(
		renderMembership(writable, {
			schema: cx.checked,
			names: b.names,
			catalog: cx.catalog,
			row: (f, position) => param(position + 1, baseTypeRef(b.names, f.type))
		})
	)
	const spec: ObjectSpec<"publish"> = {
		kind: "worldFunction",
		ident: b.qualified("function", filterNamed),
		ddl: [
			{
				kind: "createFunction",
				advice: noAdvice,
				language: "sql",
				name: objectName(b.schema, fnIdent),
				volatility: "STABLE",
				parallel: "UNSAFE",
				security: "DEFINER",
				returns: "boolean",
				params: fields.map((f) => ({ name: f.column, type: f.type })),
				body
			},
			{
				kind: "revoke",
				privileges: ["ALL"],
				on: { kind: "FUNCTION", names: [name] },
				from: [{ kind: "PUBLIC" }]
			}
		],
		reasons: [enforcement(`the writable entry ${role.name}.${e.name}`)],
		phase: "publish"
	}
	return {
		membership,
		functions: [{ name, spec }, ...probes],
		grants: [...grants, grant(["EXECUTE"], { kind: "FUNCTION", names: [name] }), ...probeGrants]
	}
}

/** A role's writable entry as the row security of the table T it writes reads it, or its member writes as their
 * family's owner T's reads them (`translated`): T, the role and its object, what the policy is for, and the membership. */
interface Writer {
	readonly relation: string
	readonly role: Identity<"role">
	readonly roleObject: Node<"publish">
	readonly entry: string
	readonly membership: Membership
}

/** What one role installs beyond its objects: whether it can name the vector type, its writable entries, whose
 * policies wait for every role's (`addRowSecurity`), and its own schema and its query entries' views in it, none where it
 * holds no query entry, which PUBLIC holds nothing on. */
interface RoleOutcome {
	readonly installed: InstalledRole
	readonly vector: boolean
	readonly writers: ReadonlyArray<Writer>
	readonly schemas: ReadonlyArray<string>
	readonly views: ReadonlyArray<ObjectName>
}

/** The drawn law columns of `relation`, in the law model's order: columns the host writes beside the caller's fields. */
const drawnColumnsOf = (b: InstallBuilder, relation: string): ReadonlyArray<string> =>
	b.natives.flatMap(({ object: o }) =>
		o.kind === "LawColumn" && o.value.kind === "drawn" && o.relation.name === relation
			? [o.column]
			: []
	)

/**
 * The owner columns a member's writer selects on its owner beside its key (`OwnerHold`): its count, its ends
 * (`endColumns`), every column its owner axis carries into its members, which an appended or refilled member copies,
 * and every field a generated one among them is computed from (withGenerationInputs).
 */
const ownerReadColumns = (family: Family): ReadonlyArray<LawField> => {
	const out: Array<LawField> = [family.count]
	const add = (f: LawField): void => {
		if (!out.some((g) => g.name === f.name)) {
			out.push(f)
		}
	}
	for (const f of endColumns(family)) {
		add(f)
	}
	for (const pair of family.axes.owner) {
		if (pair.to.kind === "field") {
			add(pair.to.field)
		}
	}
	return withGenerationInputs(family.owner, out)
}

/**
 * What a role that writes a member of a family holds on the family's owner O beyond what its own entries grant, and
 * nothing wider. Apart (`apart`), where the role writes O through no entry: column SELECT on its key, the owner fields
 * the group pairs with, and `ownerReadColumns`: its count, its ends and the fields its owner axis copies into members,
 * which the role writes into its own member rows; and column UPDATE, when O is mutable, on exactly what the recount of
 * each family whose member the role writes in full sets (write/family/additions.ts, removals.ts): its count and
 * `endColumns`, a closed member by its insert list, an open one by its write list (`fullyWrittenBy`). No UPDATE on an
 * immutable O, whose family is fixed when it is inserted, nor for a family whose open member the role names under its
 * insert list, which only adds that member's facts and changes nothing beside them, so its program is refused a recount
 * (write/program/insert-only.ts). None of O's other fields. Recounting (`recounting`), where its insert list names O
 * whole, whose table grant holds SELECT and INSERT and no UPDATE: the same column UPDATE, and no column SELECT, which
 * that table grant holds already, so no grant states a column privilege its table's of the same type holds, a fact the
 * catalog's privileges never state apart (adapter/admission/roles.ts reads a column's privilege only where its table's
 * does not hold). A role that writes O whole otherwise holds all of O already and takes none. `families` are the
 * families of O whose member it writes, in the law model's order; each column list is in O's field order.
 */
export type OwnerHold =
	| {
			readonly kind: "apart"
			readonly owner: RelationInfo
			readonly families: NonEmptyReadonlyArray<Family>
			readonly select: ReadonlyArray<LawField>
			readonly update: ReadonlyArray<LawField>
	  }
	| {
			readonly kind: "recounting"
			readonly owner: RelationInfo
			readonly families: NonEmptyReadonlyArray<Family>
			readonly update: ReadonlyArray<LawField>
	  }

/** The families of one owner a role holds (`heldFamilies`), and how its own grant holds that owner (`OwnerHold`). */
interface HeldFamilies {
	readonly families: NonEmptyReadonlyArray<Family>
	readonly own: OwnerHold["kind"]
}

/** The families whose members a role writes (`written`) and whose owner it does not write whole, a table grant holding
 * the owner then (`writePlan`), grouped by owner, in the law model's order of each owner's first family; but an owner
 * its insert list names whole, whose table grant holds no UPDATE, holds each family of it whose recount it makes here
 * too: a mutable owner's whose member it writes in full (`fullyWrittenBy`). */
const heldFamilies = (
	model: LawModel,
	written: ReadonlyArray<WrittenEntry>
): ReadonlyArray<HeldFamilies> => {
	const writes = new Set(written.map((w) => w.relation.name))
	/** How the role's own grant holds each owner it writes whole: all of it (`covered`), by its write list, or its rows'
	 * insertion alone (`inserted`), by its insert list. */
	const owned = new Map(
		written.flatMap((w) =>
			w.write.kind === "rows"
				? []
				: [[w.relation.name, w.write.mode === "insert" ? "inserted" : "covered"] as const]
		)
	)
	const full = fullyWrittenBy(written)
	const held = (f: Family): boolean => {
		switch (owned.get(f.owner.name)) {
			case undefined:
				return true
			case "covered":
				return false
			case "inserted":
				return f.owner.mutable && full.has(f.member.name)
		}
	}
	const byOwner = new Map<string, NonEmptyReadonlyArray<Family>>()
	for (const f of model.families) {
		if (writes.has(f.member.name) && held(f)) {
			const at = byOwner.get(f.owner.name)
			byOwner.set(f.owner.name, at === undefined ? [f] : appendNonEmpty(at, f))
		}
	}
	return [...byOwner.values()].map((families) => ({
		families,
		own: owned.get(families[0].owner.name) === "inserted" ? "recounting" : "apart"
	}))
}

/**
 * The relations a role writes in full (`written`): each open one by its write list, and each closed one, whose facts its
 * insert list adds, the one way a closed relation is written. An open relation under its insert list is written short
 * of full: the role only adds its facts and changes nothing beside them.
 */
const fullyWrittenBy = (written: ReadonlyArray<WrittenEntry>): ReadonlySet<string> =>
	new Set(
		written.flatMap((w) =>
			w.write.mode === "write" || !w.relation.mutable ? [w.relation.name] : []
		)
	)

/** What a role holds on `owner`, the owner of `held`'s families, `full` the relations it writes in full
 * (`fullyWrittenBy`, `OwnerHold`). */
const holdOn = (owner: RelationInfo, held: HeldFamilies, full: ReadonlySet<string>): OwnerHold => {
	const families = held.families
	const updated = new Set(
		owner.mutable
			? families.flatMap((f) =>
					full.has(f.member.name) ? [f.count.name, ...endColumns(f).map((c) => c.name)] : []
				)
			: []
	)
	const update = owner.fields.filter((field) => updated.has(field.name))
	if (held.own === "recounting") {
		return { kind: "recounting", owner, families, update }
	}
	const selected = new Set(
		families.flatMap((f) => [
			...f.group.map((g) => g.owner.name),
			...ownerReadColumns(f).map((c) => c.name)
		])
	)
	return {
		kind: "apart",
		owner,
		families,
		select: owner.fields.filter((field) => selected.has(field.name)),
		update
	}
}

/** The owners whose members a role writes (`written`), each with what the role holds on it (`OwnerHold`), in the law
 * model's order of their first family, each owner the relation its families name (ir/family.ts Family `owner`), an
 * ordinary relation of the schema. */
export const ownerHolds = (
	model: LawModel,
	written: ReadonlyArray<WrittenEntry>
): ReadonlyArray<OwnerHold> =>
	heldFamilies(model, written).map((held) =>
		holdOn(held.families[0].owner, held, fullyWrittenBy(written))
	)

/**
 * The successor columns a role updates on the members it writes (write/family/written.ts seamUpdate), by member
 * relation: each family's successor ‹s›, no tree's, of a mutable owner the role recounts, whose member it writes in
 * full (`fullyWrittenBy`, the member writer's recount `ownerHolds` grants) or whose owner it writes whole with UPDATE,
 * where the family statements that append to and edit its groups set the successor of each group's member before the
 * slots they draw, the one stored member an append changes, as the recount sets the owner's count; none on a relation
 * the role's own grant holds UPDATE on whole. No field: the member's facts change no more than the owner's do, and a
 * closed member's immutability guard holds every field (physical/ddl/immutable.ts).
 */
export const seamHolds = (
	model: LawModel,
	written: ReadonlyArray<WrittenEntry>
): ReadonlyMap<string, NonEmptyReadonlyArray<string>> => {
	const writes = new Set(written.map((w) => w.relation.name))
	const full = fullyWrittenBy(written)
	const whole = new Set(
		written.flatMap((w) =>
			w.write.kind !== "rows" && entryPrivileges(w).includes("UPDATE") ? [w.relation.name] : []
		)
	)
	const out = new Map<string, NonEmptyReadonlyArray<string>>()
	for (const f of model.families) {
		const member = f.member.name
		const recounts = full.has(member) || whole.has(f.owner.name)
		if (
			f.shape.kind !== "tree" &&
			f.owner.mutable &&
			writes.has(member) &&
			recounts &&
			!whole.has(member)
		) {
			const at = out.get(member)
			out.set(member, at === undefined ? [f.next] : appendNonEmpty(at, f.next))
		}
	}
	return out
}

/**
 * Whether a role holds UPDATE on a column of a relation, as its grants hold it (writePlan, ownerHolds, seamHolds):
 * every column of a relation it writes whole with UPDATE, a table grant; a query entry's updatable fields; an owner
 * hold's count and ends; a member's successors; no column of any other relation. What an UPDATE the role runs may
 * assign, its anchor among them (laws/model/generation.ts).
 */
export const roleUpdates = (
	model: LawModel,
	world: RoleWorld
): ((relation: string, column: string) => boolean) => {
	const written = roleWrites(world)
	const whole = new Set<string>()
	const columns = new Map<string, Set<string>>()
	const hold = (relation: string, fields: ReadonlyArray<LawField>): void => {
		const at = columns.getOrInsertComputed(relation, () => new Set())
		for (const f of fields) {
			at.add(f.column)
		}
	}
	for (const w of written) {
		if (!entryPrivileges(w).includes("UPDATE")) {
			continue
		}
		if (w.write.kind === "rows") {
			hold(w.relation.name, updatableFields(w.write.writable))
		} else {
			whole.add(w.relation.name)
		}
	}
	const full = fullyWrittenBy(written)
	for (const held of heldFamilies(model, written)) {
		const owner = held.families[0].owner
		hold(owner.name, holdOn(owner, held, full).update)
	}
	for (const [member, successors] of seamHolds(model, written)) {
		const at = columns.getOrInsertComputed(member, () => new Set())
		for (const c of successors) {
			at.add(c)
		}
	}
	return (relation, column) => whole.has(relation) || (columns.get(relation)?.has(column) ?? false)
}

/**
 * The table privileges a role holds on each relation of its base, by the relation's name, as its installation grants
 * them: on each relation it writes, its entry's (`entryPrivileges`), and UPDATE where it sets a member's successors
 * (`seamHolds`); on each owner of a family whose member it writes and which it does not write whole, SELECT, and UPDATE
 * where it recounts the owner (`ownerHolds`); a relation written both ways holds both. A column privilege counts as its table's. No other table: the role reads through its views.
 * What certification reads (analysis/isolation/facts.ts RoleFacts.privileges), and a relation's guard with it.
 */
export const grantedPrivileges = (
	model: LawModel,
	checked: CheckedSchema<RoleWorld>
): ReadonlyMap<string, ReadonlySet<TablePrivilege>> => {
	const written = roleWrites(checked.world)
	const held = new Map<string, Set<TablePrivilege>>()
	const hold = (relation: string, privileges: ReadonlyArray<TablePrivilege>): void => {
		const at = held.getOrInsertComputed(relation, () => new Set())
		for (const p of privileges) {
			at.add(p)
		}
	}
	for (const w of written) {
		hold(w.relation.name, entryPrivileges(w))
	}
	for (const member of seamHolds(model, written).keys()) {
		hold(member, ["UPDATE"])
	}
	for (const h of ownerHolds(model, written)) {
		const privileges: Array<TablePrivilege> = []
		if (h.kind === "apart" && isNonEmpty(h.select)) {
			privileges.push("SELECT")
		}
		if (isNonEmpty(h.update)) {
			privileges.push("UPDATE")
		}
		hold(h.owner.name, privileges)
	}
	return held
}

/**
 * The canonical relations a role reads that its base names nowhere (analysis/derived/canonical.ts), an anonymous one or
 * a named one of a level above its base, each through its whole view, by name with their headings, in admission order:
 * each stored one whose table serves the role (analysis/schema.ts CheckedSchema serves), its definition reading only
 * relations the role sees whole (schema/own.ts roleSeesWhole), so its rows are a function of rows the role sees, and a
 * statement of the role reads its table wherever its form stands (ir/derived.ts servedDag). A role that sees a relation
 * one reads narrowed reads none of its table.
 */
export const anonymousTables = (
	checked: CheckedSchema<RoleWorld>
): ReadonlyArray<{
	readonly name: string
	readonly heading: NonEmptyReadonlyArray<HeadingColumn>
}> =>
	[...checked.canonical.values()].flatMap((c) =>
		c.holding.kind === "stored" &&
		!Object.hasOwn(checked.world.role.base.relations, c.subject.name) &&
		checked.serves(c.subject.name, noneWritten)
			? [{ name: c.subject.name, heading: c.holding.analysis.heading }]
			: []
	)

/**
 * Every relation a statement of a role can read, by its declared name, in code-unit order, as its installation grants
 * it: each relation its views read as their owner, a whole entry's relation, a stored derived relation it reads in full
 * among them (analysis/schema.ts CheckedSchema), each anonymous canonical table it reads (`anonymousTables`), and each
 * relation a query entry's definition reads, any other derived
 * relation by the relations its own definition reads, which the role reads in its place; and each relation it holds a
 * table privilege on (grantedPrivileges), what it writes and the owners of the families
 * whose members it writes. Its filter functions and key and unique probes, the one other way it reads, read a relation
 * it writes and its entry's membership, which its view reads. PostgreSQL refuses a statement's read of any other
 * relation with 42501 as its executor starts (ExecCheckPermissions), before it reads a row. What certification reads of
 * a role with no change member (analysis/isolation/facts.ts RoleWrites `readable`); the reads its writes' foreign key
 * checks and rule triggers make as the owner are its writes' own, which certification reads off them.
 */
export const readableRelations = (
	model: LawModel,
	checked: CheckedSchema<RoleWorld>
): ReadonlyArray<string> => {
	const role = checked.world.role
	const whole = new Set([
		...Object.values(role.relations).flatMap((entry) =>
			entry.kind === "whole" ? [entry.relation.name] : []
		),
		...role.wholeDerived.filter((name) => checked.holdings.get(name)?.kind === "stored"),
		...anonymousTables(checked).map((t) => t.name)
	])
	const stored = (name: string): ReadonlyArray<string> => {
		const relation = role.base.relations[name]
		return relation?.kind === "derived" && !whole.has(name)
			? relation.reads.flatMap(stored)
			: [name]
	}
	const viewed = [
		...whole,
		...Object.values(role.relations).flatMap((entry) =>
			entry.kind === "whole" ? [] : entry.reads.flatMap(stored)
		)
	]
	return [...new Set([...viewed, ...grantedPrivileges(model, checked).keys()])].toSorted(
		compareStrings
	)
}

/**
 * The field of a family's owner O that a field of its member reads as, for every member: a group field's paired owner
 * key field, or, for a copy, the field of O the owner axis carries into it. The owner axis's foreign key proves each
 * equal; undefined for any other field of the member.
 */
const ownerPaired = (f: Family, field: LawField): LawField | undefined =>
	f.group.find((g) => g.member.name === field.name)?.owner ??
	f.axes.owner
		.flatMap((p) =>
			p.from.kind === "field" && p.from.field.name === field.name && p.to.kind === "field"
				? [p.to.field]
				: []
		)
		.at(0)

/**
 * A member writer's membership on a family F's member as a predicate over F's owner O's row: the rows of O whose groups
 * it admits, the rows of O its family reads and counts may touch. Every field of the member the membership reads is
 * read as the field of O it pairs with (`ownerPaired`), so the predicate holds of O's row exactly when it holds of every
 * member O's group names, a first append's included. A membership reading any other field of the member is refused: no
 * predicate over O's row alone decides it, and one over O's members misses an owner whose first member is appended.
 */
const translated = (
	names: InstallNames,
	role: OwnedRole,
	entry: string,
	f: Family,
	m: Membership
): Membership => {
	if (m.kind === "every") {
		return everyRow
	}
	const paired = (field: LawField): LawField =>
		ownerPaired(f, field) ??
		refuse(
			"UnsupportedOperation",
			role.loc,
			`the role ${role.name} writes ${f.member.name} through ${entry}, a member of the family ${f.id.owner}.${f.id.count}, whose filter reads ${f.member.name}.${field.name}: a family's reads and count updates of ${f.owner.name} hold to the owners its writer's filter admits, and ${field.name} is neither a group field nor a field ${f.owner.name} copies into its members, so no predicate over ${f.owner.name}'s own row decides it; filter ${f.member.name} by ${f.group.map((g) => g.member.name).join(", ")} or a copy of ${f.owner.name}'s fields`
		)
	const reads = m.reads.map(paired)
	const ownerTable = names.relation(f.owner.name)
	const over = (row: (field: LawField) => Expr): Expr => m.over((field) => row(paired(field)))
	return {
		kind: "narrowed",
		filter: over((field) => col(ownerTable.name, names.column(f.owner.name, field.name))),
		reads,
		over
	}
}

/** The rows of an owner a role's member writes of several of its families may touch: every row when one family's may,
 * else the rows any family's translated membership admits. */
const familyMembership = (ms: NonEmptyReadonlyArray<Membership>): Membership => {
	const narrowed = ms.flatMap((m) => (m.kind === "narrowed" ? [m] : []))
	if (narrowed.length < ms.length || !isNonEmpty(narrowed)) {
		return everyRow
	}
	if (narrowed.length === 1) {
		return narrowed[0]
	}
	const over = (row: (field: LawField) => Expr): Expr =>
		or(mapNonEmpty(narrowed, (m) => m.over(row)))
	return {
		kind: "narrowed",
		filter: or(mapNonEmpty(narrowed, (m) => m.filter)),
		reads: [...new Map(narrowed.flatMap((m) => m.reads).map((f) => [f.name, f])).values()],
		over
	}
}

/**
 * The rows of `hold`'s owner O its role's member writes may touch (`familyMembership`), each family's member written
 * through the entry `writerOf` gives it, its membership translated onto O's row (`translated`): what the role's policy on
 * O holds it to where it writes O through no entry of its own, and what its own entry's membership on O must cover
 * (`covers`). One construction serves the installation (`addRole`) and certification, which reads every read of O the
 * role makes under it (program/isolation/member-facts.ts extractNames).
 */
export const holdMembership = (
	names: InstallNames,
	role: OwnedRole,
	hold: OwnerHold,
	writerOf: (member: string) => { readonly entry: string; readonly membership: Membership }
): Membership =>
	familyMembership(
		mapNonEmpty(hold.families, (f) => {
			const member = writerOf(f.member.name)
			return translated(names, role, member.entry, f, member.membership)
		})
	)

/**
 * Whether a role's own policy on an owner, its entry's membership `own`, already holds the rows its family writes
 * touch, `family`: every row, or the same predicate. Any other pair is refused, because no policy can state it exactly.
 * The own policy alone, being narrower, hides owners the role's members name, so its family reads miss them and its
 * count updates match nothing. A second permissive policy ORed beside it is wider than the entry. PostgreSQL grants
 * columns per role per table, not per policy, so the role would read and update its owner entry's columns on owner
 * rows admitted only through the members' translated filter.
 */
const covers = (own: Membership, family: Membership): boolean =>
	own.kind === "every" ||
	(family.kind === "narrowed" && printExpr(own.filter) === printExpr(family.filter))

/**
 * The constants a role is granted EXECUTE on, with their objects: every one its statements evaluate, transitively
 * through constants' bodies and domains' base types and CHECKs (InstallBuilder.evaluated), since PostgreSQL checks
 * EXECUTE against the invoker. Its statements evaluate the domains its own statements name, those its columns are typed
 * by, which a write's carriers and casts coerce into; every statement on a table it writes or updates an owner's count
 * in, its columns' types and defaults, its CHECKs and generated columns, each cast to a domain in them included, and its
 * indexes' expressions; its policies' predicates; its views' columns, a closed id's decoded name among them; every
 * closed relation's constants, which its queries' closed reads call; every zone roster's names constant, which its
 * queries' Time.wall reads a zone's name from; and every library function the installation installs, which its
 * queries may call.
 */
const roleExecutes = (
	b: InstallBuilder,
	use: TypeUse,
	written: ReadonlyArray<string>,
	policies: ReadonlyArray<Membership>,
	views: ReadonlyArray<SqlStatement>
): ReadonlyArray<{ readonly name: FunctionName; readonly node: Node<"setup"> }> =>
	b.evaluated({
		statements: [...written.flatMap((relation) => b.evaluatedOn(relation)), ...views],
		predicates: policies.flatMap((m) => (m.kind === "narrowed" ? [m.filter] : [])),
		domains: [...use.domains.values()].map((u) => u.name),
		constants: [
			...Object.values(b.owned.relations).flatMap((r) =>
				r.kind === "closedRelation" ? b.names.closed(r.name).functions.map((f) => f.name) : []
			),
			...Object.values(b.owned.relations).flatMap((r) =>
				r.kind === "closed" && r.roster.order === "zones"
					? [namesConstant(b, r.roster.closed).name]
					: []
			),
			...b.library.map((fn) => b.names.library(fn).name)
		]
	})

/** One role's theory role, its schema and query entries' views where it holds a query entry, its filter functions, key
 * and unique probes and grants, and its writable entries, whose policies `addRowSecurity` adds. A whole entry is read
 * through its relation's whole view (`whole`, addWholeViews), which the role is granted SELECT on, with USAGE on its
 * schema. A roster whole entry has no view: its handles are read as codes, typed by its domain, which the role uses. The
 * filter function a policy calls, then the probes, each come after every relation, type and function their statements
 * read. EXECUTE on what the CHECKs call of the domains its carriers' fields are typed by, which the statements filling
 * a carrier cast into (`carried`), is among its grants, and EXECUTE on each function of `held`. */
const addRole = (
	b: InstallBuilder,
	cx: WorldsContext,
	{ theory: named, views: viewNames, checked }: CheckedRole,
	whole: ReadonlyMap<string, WholeViewObject>,
	login: { readonly role: string; readonly object: Node<"publish"> },
	carried: RoleCarriers | undefined,
	{ called: held, released }: Held,
	worldViews: ReadonlyArray<WorldView>
): RoleOutcome => {
	const role = checked.world.role
	const theory = b.name(named)
	const why = [enforcement(`role ${role.name}`)]
	const roleObject = b.add(
		{
			kind: "role",
			ident: { kind: "role", name: named },
			ddl: [{ kind: "createRole", name: theory, login: false }],
			reasons: why,
			phase: "publish"
		},
		[]
	)
	b.add(
		{
			kind: "membership",
			ident: { kind: "membership", name: named },
			ddl: [{ kind: "grantRole", role: theory, to: login.role }],
			reasons: why,
			phase: "publish"
		},
		[roleObject, login.object]
	)

	const use = emptyUse()
	const grants: Array<SqlStatement> = []
	/** The schemas of the role's base's levels, the root's first: its tables, rosters' domains and the installation's
	 * own objects, whichever its statements name, live in them. */
	const levels = b.names.levels.slice(0, role.base.levels.length)
	const after: Array<Node<DeployPhase>> = [
		roleObject,
		...b.levelNodes.slice(0, role.base.levels.length)
	]
	const grantee: NonEmptyReadonlyArray<Grantee> = [{ kind: "role", name: theory }]
	const grant = (privileges: NonEmptyReadonlyArray<Privilege>, on: Grant["on"]): Grant => ({
		kind: "grant",
		privileges,
		on,
		to: grantee
	})

	/** The views it reads, each its relation's whole view or its own query entry's, and the schemas they are in, by name:
	 * each whole view's level's, then its own. */
	const read: Array<ObjectName> = []
	const viewStatements: Array<SqlStatement> = []
	const viewSchemas = new Map<string, Node<"publish">>()
	const queries: Array<Extract<RoleRelation, { readonly kind: "world" }>> = []
	for (const r of checked.entries.map(roleRelation(checked))) {
		switch (r.kind) {
			case "closed":
				columnDomains(b, r.relation.fields, use)
				break
			case "stored":
			case "derived": {
				const view = defined(whole.get(r.entry.name), `the whole view of ${r.entry.name}`)
				columnDomains(b, view.heading, use)
				read.push(view.create.name)
				viewStatements.push(view.create)
				viewSchemas.set(view.schema.name, view.schema.node)
				after.push(view.node)
				break
			}
			case "world":
				queries.push(r)
				break
		}
	}
	/** Each anonymous canonical table the role reads (`anonymousTables`), through its whole view (addWholeViews, names.ts
	 * InstallNames canonicalWholeView), granted SELECT on it, with USAGE on its schema. */
	const anonymous = anonymousTables(checked)
	for (const { name } of anonymous) {
		const view = defined(whole.get(name), `the whole view of ${name}`)
		columnDomains(b, view.heading, use)
		read.push(view.create.name)
		viewStatements.push(view.create)
		viewSchemas.set(view.schema.name, view.schema.node)
		after.push(view.node)
	}
	/** Its own schema, of its query entries' views, which it holds exactly when it holds a query entry. */
	const ownSchema: Array<string> = []
	const ownViews: Array<ObjectName> = []
	if (isNonEmpty(queries)) {
		const schemaNamed = identity.roleSchema(named)
		const schema = b.name(schemaNamed)
		const schemaObject = b.add(
			{
				kind: "viewSchema",
				ident: { kind: "schema", name: schemaNamed },
				ddl: [{ kind: "createSchema", name: schema }],
				reasons: why,
				phase: "publish"
			},
			[]
		)
		viewSchemas.set(schema, schemaObject)
		ownSchema.push(schema)
		for (const r of queries) {
			const name = viewNames.get(r.entry.name)
			if (name?.kind !== "query") {
				return missing(`physical: the query entry ${role.name}.${r.entry.name} is named no view`)
			}
			const plan = worldViewPlan(
				b,
				objectName(schema, b.name(name.name)),
				defined(
					worldViews.find((v) => v.entry === r.entry.name),
					`the world view of ${role.name}.${r.entry.name}`
				)
			)
			const columns = emptyUse()
			columnDomains(b, plan.heading, columns)
			const view = b.add(
				{
					kind: "view",
					ident: { kind: "view", schema: schemaNamed, name: name.name },
					ddl: [plan.create],
					reasons: why,
					phase: "publish"
				},
				[schemaObject, ...plan.reads, ...usedNodes(columns)]
			)
			columnDomains(b, plan.heading, use)
			read.push(plan.create.name)
			ownViews.push(plan.create.name)
			viewStatements.push(plan.create)
			after.push(view)
		}
	}
	appendAll(after, viewSchemas.values())

	const writers: Array<Writer> = []
	const written = roleWrites(checked.world)
	for (const w of written) {
		const plan = writePlan(b, cx, role, named, w)
		const relation = w.relation.name
		columnDomains(b, w.relation.fields, use)
		appendAll(grants, plan.grants)
		after.push(b.table(relation))
		const functions = plan.functions.map((fn) => b.add(fn.spec, [b.schemaNode]))
		appendAll(after, functions)
		writers.push({
			relation,
			role: named,
			roleObject,
			entry: `${role.name}.${w.write.name}`,
			membership: plan.membership
		})
	}
	for (const [member, successors] of seamHolds(b.model, written)) {
		grants.push({
			kind: "grantColumns",
			privilege: "UPDATE",
			table: b.names.relation(member),
			columns: successors,
			to: theory
		})
	}
	const holds = ownerHolds(b.model, written)
	for (const hold of holds) {
		const owner = hold.owner.name
		const ownerTable = b.names.relation(owner)
		const columns = (fields: ReadonlyArray<LawField>): ReadonlyArray<string> =>
			fields.map((field) => b.names.column(owner, field.name))
		const select = hold.kind === "apart" ? columns(hold.select) : []
		const update = columns(hold.update)
		if (isNonEmpty(select)) {
			grants.push({
				kind: "grantColumns",
				privilege: "SELECT",
				table: ownerTable,
				columns: select,
				to: theory
			})
		}
		if (isNonEmpty(update)) {
			grants.push({
				kind: "grantColumns",
				privilege: "UPDATE",
				table: ownerTable,
				columns: update,
				to: theory
			})
		}
		columnDomains(b, hold.update, use)
		after.push(b.table(owner))
		const membership = holdMembership(b.names, role, hold, (member) =>
			defined(
				writers.find((w) => w.relation === member),
				`the writer of ${member}, a member ${role.name} writes`
			)
		)
		const own = writers.find((w) => w.relation === owner)
		if (own === undefined) {
			writers.push({
				relation: owner,
				role: named,
				roleObject,
				entry: `${role.name}'s members of ${owner}'s families`,
				membership
			})
		} else if (!covers(own.membership, membership)) {
			refuse(
				"UnsupportedOperation",
				role.loc,
				`the role ${role.name} writes ${owner} through ${own.entry}, whose filter narrows it, and members of its families ${hold.families.map((f) => `${f.id.owner}.${f.id.count}`).join(", ")}, whose reads and count updates of ${owner} hold to the owners its member writes admit, which ${own.entry}'s filter does not state: one policy holds the role on ${owner}, so filter ${owner} and its members alike, or write the members of ${owner} through another role`
			)
		}
	}
	after.push(b.refusal)
	if (carried !== undefined) {
		columnDomains(b, carried.columns, use)
	}

	const privileges: Array<SqlStatement> = [
		grant(["USAGE"], {
			kind: "SCHEMA",
			names: extendNonEmpty<string>(
				[identifierOf(b.names.levels[0]), ...levels.slice(1).map(identifierOf)],
				[...viewSchemas.keys()]
			)
		})
	]
	if (use.vector) {
		privileges.push(grant(["USAGE"], { kind: "SCHEMA", names: [b.settings.vectorSchema] }))
	}
	if (isNonEmpty(read)) {
		privileges.push(grant(["SELECT"], { kind: "TABLE", names: read }))
	}
	appendAll(privileges, grants)
	privileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))
	privileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [borrowFunction(b.schema)] }))
	const executes = roleExecutes(
		b,
		use,
		[
			...written.map((w) => w.relation.name),
			...holds.flatMap((h) => (isNonEmpty(h.update) ? [h.owner.name] : []))
		],
		writers.map((w) => w.membership),
		viewStatements
	)
	if (isNonEmpty(executes)) {
		privileges.push(
			grant(["EXECUTE"], { kind: "FUNCTION", names: mapNonEmpty(executes, (e) => e.name) })
		)
	}
	if (isNonEmpty(held)) {
		privileges.push(
			grant(["EXECUTE"], { kind: "FUNCTION", names: mapNonEmpty(held, (h) => h.name) })
		)
	}
	if (isNonEmpty(released)) {
		privileges.push(
			grant(["SELECT", "DELETE"], {
				kind: "TABLE",
				names: mapNonEmpty(released, (r) => r.table)
			})
		)
	}
	b.add(
		{
			kind: "privileges",
			ident: { kind: "privileges", name: named },
			ddl: privileges,
			reasons: why,
			phase: "publish"
		},
		[
			...after,
			...usedNodes(use),
			...executes.map((e) => e.node),
			...held.map((h) => h.node),
			...released.map((r) => r.node)
		]
	)
	return {
		installed: { name: role.name, role: theory },
		vector: use.vector,
		writers,
		schemas: ownSchema,
		views: ownViews
	}
}

const addLogin = (
	b: InstallBuilder,
	cx: WorldsContext,
	{ login, roles }: CheckedLogin,
	whole: ReadonlyMap<string, WholeViewObject>,
	carriers: ReadonlyArray<RoleCarriers>,
	fenced: ReadonlyArray<string>,
	held: (role: CheckedRole) => Held,
	worldViews: (role: CheckedRole) => ReadonlyArray<WorldView>
): {
	readonly installed: InstalledLogin
	readonly vector: boolean
	readonly writers: RoleOutcome["writers"]
	readonly schemas: ReadonlyArray<string>
	readonly views: ReadonlyArray<ObjectName>
} => {
	const named = loginIdentity(levelIn(b.names.levels, login.base), login.name, login.loc)
	const role = b.name(named)
	const why = [enforcement(`login ${login.name}`)]
	const roleObject = b.add(
		{
			kind: "role",
			ident: { kind: "role", name: named },
			ddl: [{ kind: "createRole", name: role, login: true }],
			reasons: why,
			phase: "publish"
		},
		[]
	)
	const to: Grant["to"] = [{ kind: "role", name: role }]
	const fencedTables = fenced.map((relation) => b.names.relation(relation))
	const fencedSchemas = [...new Set(fencedTables.map((t) => t.schema))].filter(
		(s) => s !== b.schema
	)
	const maintain: ReadonlyArray<SqlStatement> = isNonEmpty(fencedTables)
		? [{ kind: "grant", privileges: ["MAINTAIN"], on: { kind: "TABLE", names: fencedTables }, to }]
		: []
	b.add(
		{
			kind: "privileges",
			ident: { kind: "privileges", name: named },
			ddl: [
				{
					kind: "grant",
					privileges: ["USAGE"],
					on: { kind: "SCHEMA", names: appendNonEmpty<string>(fencedSchemas, b.schema) },
					to
				},
				{
					kind: "grant",
					privileges: ["EXECUTE"],
					on: { kind: "FUNCTION", names: [snapshotGuardFunction(b.schema)] },
					to
				},
				...maintain
			],
			reasons: why,
			phase: "publish"
		},
		[roleObject, b.schemaNode, b.snapshotGuard, ...fenced.map((relation) => b.table(relation))]
	)
	const outcomes = [...roles]
		.toSorted((x, y) => compareStrings(x.checked.world.role.name, y.checked.world.role.name))
		.map((r) =>
			addRole(
				b,
				cx,
				r,
				whole,
				{ role, object: roleObject },
				carriers.find((c) => c.login === login.name && c.role === r.checked.world.role.name),
				held(r),
				worldViews(r)
			)
		)
	return {
		installed: {
			name: login.name,
			role,
			roles: outcomes.map((o) => o.installed),
			fenced: fencedTables
		},
		vector: outcomes.some((o) => o.vector),
		writers: outcomes.flatMap((o) => o.writers),
		schemas: outcomes.flatMap((o) => o.schemas),
		views: outcomes.flatMap((o) => o.views)
	}
}

/** A writer's policy predicate: TRUE for a writer that holds every row of T, and a narrowed one's membership. */
const predicateOf = (membership: Membership): Expr => {
	switch (membership.kind) {
		case "every":
			return lit.bool(true)
		case "narrowed":
			return membership.filter
	}
}

/** A writer's policy on the table it writes, named for its role and the table: `FOR ALL TO <role> USING (m) WITH CHECK
 * (m)`, m its predicate, after the table, the role and the filter function the predicate calls. */
const addPolicy = (b: InstallBuilder, w: Writer): Node<"publish"> => {
	const named = identity.policy(w.role, w.relation)
	const ddl: SqlStatement = {
		kind: "createPolicy",
		name: b.name(named),
		table: b.names.relation(w.relation),
		role: identifierOf(w.role),
		filter: predicateOf(w.membership)
	}
	return b.add(
		{
			kind: "policy",
			ident: {
				kind: "policy",
				schema: b.names.levelOf(w.relation),
				relation: b.names.relationNamed(w.relation),
				name: named
			},
			ddl: [ddl],
			reasons: [enforcement(`the writable entry ${w.entry}`)],
			phase: "publish"
		},
		[b.table(w.relation), w.roleObject]
	)
}

/** Row security on each table some writer narrows, after every writer's policy on it, and on no other table. Under row
 * security a role with no policy on a table reads and writes none of its rows, so every writer of such a table holds
 * its policy, TRUE for one that holds every row. A table no writer narrows has neither row security nor a policy: each
 * policy would be TRUE, which admits exactly what the role's grants admit, so the grants alone decide its writes. */
const addRowSecurity = (b: InstallBuilder, writers: ReadonlyArray<Writer>): void => {
	const byTable = [...Map.groupBy(writers, (w) => w.relation)].toSorted(([x], [y]) =>
		compareStrings(x, y)
	)
	for (const [relation, on] of byTable) {
		if (on.every((w) => w.membership.kind === "every")) {
			continue
		}
		const policies = on.map((w) => addPolicy(b, w))
		b.add(
			{
				kind: "rowSecurity",
				ident: b.qualifiedOf("rowSecurity", relation, b.names.relationNamed(relation)),
				ddl: [
					{
						kind: "alterTable",
						table: b.names.relation(relation),
						actions: [{ kind: "enableRowSecurity" }]
					}
				],
				reasons: [enforcement(`the writes of ${relation} through filtered query entries`)],
				phase: "publish"
			},
			[b.table(relation), ...policies]
		)
	}
}

/** Worlds: the logins over a schema, their roles, the whole views of the relations they hold whole, each role's schema
 * and query views, grants and policies, the writable entries' filter functions and key and unique probes, the logins'
 * defaults, and the PUBLIC revokes.
 *
 * Every name is minted at the naming door under the installation's identity (`worldNames`): a login's and a role's
 * PostgreSQL roles are cluster-wide. Per login over the base, the Publish phase emits:
 *
 * - `CREATE ROLE <login> LOGIN NOINHERIT`: the one credential of a pool, holding no privilege of its own but
 *   USAGE on the base schema, SELECT on the ledger and EXECUTE on the snapshot guard: the fence Db.open's admission and
 *   every transaction of its Dbs take as the login, the ledger's lock (deploy/ledger/ledger.ts) and the guard
 *   (physical/ddl/ledger.ts); and, for each relation the login fences (`fences`, analysis/isolation/certify.ts Fence),
 *   MAINTAIN on its table and USAGE on its schema: the least privilege that permits the LOCK TABLE ... IN EXCLUSIVE MODE
 *   a fenced write sends as the login before its snapshot (PostgreSQL 19 lockcmds.c LockTableAclCheck), which reads and
 *   changes no row, and whose VACUUM, ANALYZE, CLUSTER and REINDEX block no more than the DELETE its roles hold,
 *   which permits every lock mode;
 * - the login's defaults (`roleDefaultSettings`), as ALTER ROLE ... SET, which PostgreSQL applies at login and never on
 *   SET ROLE, over any default of the database's or the cluster's, and which every session of a login's pool sets
 *   again in its startup options (`loginStartupOptions`): `search_path = pg_catalog, pg_temp` (closedSearchPath), so
 *   no name a login's statement holds resolves through a path anyone else chose, `extra_float_digits = 1` (float text
 *   is shortest round-trip only when it is positive), `DateStyle = 'ISO, YMD'` (date_out writes YYYY-MM-DD, a date's
 *   host text) and lc_monetary, lc_numeric and lc_time at C.UTF-8. For a login
 *   one of whose roles can name the vector type, the strict-order iterative scan too (`searchPolicySettings`): an
 *   `hnsw.*` parameter is a placeholder until the vector library is loaded in the session, and the migration
 *   identity, which is no superuser, may store one only after that (42501 before), so the defaults list a statement
 *   that loads the library, `SELECT <ext>.vector_dims('[1]'::<ext>.vector)`, once, before it. It is the one default
 *   statement that is not an ALTER ROLE: it installs nothing, and a migration runs it whenever it stores a default
 *   after it.
 *
 * Once for the installation (`addWholeViews`): for each stored relation or stored derived relation some role holds whole,
 * its whole view, `__<level>.<relation>`, in its level's schema of whole views, `CREATE SCHEMA __<level>`, each owned
 * by the owner, so it reads reality as the owner: every row and column of its table, which
 * hides nothing, so it is a plain view, which PostgreSQL flattens into the reader's query, pushing its quals to the
 * table's indexes and keeping SSI's read locks to the rows read. A whole view is its relation's alone, the same view
 * whichever role holds it, so it is created once and granted to every role holding the relation whole.
 *
 * Per role of a login:
 *
 * - `CREATE ROLE <role> NOLOGIN`, its theory role, and `GRANT <role> TO <login> WITH INHERIT FALSE, SET
 *   TRUE`: the login acts as the role only after SET ROLE, which each of the role's transactions does first;
 * - where it holds a query entry, its schema, `CREATE SCHEMA <role schema>`, owned by the owner, and in it one view per
 *   query entry, owned by the owner: its definition, lowered by the derived definition lowering (`lowerDefinition`),
 *   which reads a context where it stands, `CREATE VIEW ... WITH (security_barrier)`, so no qual a reader adds runs
 *   before its own and no error such a qual raises shows a row outside it. Every closed id column of a view, a whole
 *   view's or a query entry's, is followed by its decoded column, `<field>_name`, its roster's names constant's element
 *   at the code plus one. A roster whole entry has no view: every query reads a roster's handles as codes;
 * - per writable entry on a table T under row security (below), one policy on T, named for the role and T, `FOR ALL TO
 *   <role> USING (m) WITH CHECK (m)`, where m is the entry's membership (`renderMembership`): TRUE for a whole entry
 *   and for a query entry whose filter is none, and for any other query entry `fixed ∧ w` over T's row, an existence
 *   test of that one row, lowered in the transaction context as a view's definition is, which reads each other
 *   relation by its index at the values the row fixes. A membership that
 *   reads another relation is a function's,
 *   `<schema>.<filter>(<T's fields it reads>) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER`, owned by
 *   the owner, which reads reality, never the role's policies, and which the policy and each write's precheck call. One
 *   that reads none is the policy's own predicate. Either reads T's row by T's table name, `"<table>"."<column>"`,
 *   which no item inside the membership takes (a lowering aliases each of its own r<n>), so no column of
 *   T is read as another relation's column of that name;
 * - per writable query entry, one key probe per key of T, primary and candidate, `<schema>.<key probe>(<the key's fields
 *   at their base types>) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER`, owned by the
 *   owner: whether T holds a fact at the submitted key values (overlapping at a span field) that lies outside the
 *   entry's membership, which the policy's own predicate decides over that row; and one unique probe, alike, per
 *   unique object of T no key subsumes (write/insert/unique.ts OutsideProbe), such as a key over a selected side, over
 *   the fields the object reads: whether such a fact conflicts with the submitted values there, within
 *   the object's predicate. A write's precheck calls each for the facts it submits and refuses a collision with a
 *   hidden fact under the object's law, in the same statement;
 * - its privileges: USAGE on its base's levels' schemas, on the schema of whole views of each relation it holds whole,
 *   on its own schema where it holds one, and on the vector extension's schema when a relation it reads or writes holds
 *   a vector column; on no domain; SELECT on the whole view of each relation it
 *   holds whole and on each of its query entries' views, and on no other view: USAGE on a schema only resolves its
 *   names, and PostgreSQL checks SELECT on each view's own grants, so what a role reads is exactly what it holds. For
 *   each writable entry on T: a whole entry's table SELECT, INSERT and DELETE,
 *   and UPDATE when its relation is mutable, so an UPDATE of an immutable relation is refused by privilege (immutable by
 *   default is pinned); a query entry's column SELECT and INSERT on T's fields (the head's, the fixed ones and those
 *   T's family draws, which are all of them), column UPDATE on its mutable head fields that are neither fixed, nor in a
 *   key, nor drawn by T's family, and DELETE;
 *   EXECUTE on its filter functions and key and unique probes. For each family whose member it writes, on the family's owner O, unless it
 *   writes O whole (`ownerHolds`): column SELECT on O's key, count, ends and the fields its owner axis copies into
 *   members, and, when O is mutable, column UPDATE on what its recount sets, O's count and ends, none on an immutable O, whose family is fixed at insert;
 *   where its insert list names O whole, that column UPDATE alone, its table grant holding SELECT.
 *   EXECUTE on the refusal function, to every role, whatever it writes: a write's statements refuse through it, a
 *   context source refuses an unreadable claims setting through it, and a read-back checks each bare child and option
 *   it delivers through it (lower/conservative/deliver.ts checkedAttachment), on any role, one that writes nothing among
 *   them; PostgreSQL checks EXECUTE on every function of a plan as the plan starts, a branch never taken included, and
 *   the function reads and writes nothing, so holding it confers nothing. EXECUTE on every constant its statements evaluate,
 *   through constants' bodies and domains' base types and CHECKs alike (`roleExecutes`): the domains its relations'
 *   columns and its carriers' fields are typed by (`use.domains`), down a contract's base chain, roster, bits and
 *   structural text domains alike; every statement on a table it writes or updates an owner's count in, its column
 *   types, defaults, CHECKs,
 *   generated columns and index expressions, each cast to a domain in them included; its policies' predicates; its
 *   views' decoded columns; and every closed relation's constants, which its queries' closed reads call, and no other
 *   constant. That source is wider than what the role's statements evaluate: a domain only a column the role reads is
 *   typed by is one no statement of it coerces into; the exact source, were EXECUTE ever held to least privilege, is the
 *   domains the role's compiled statements coerce into (assignment targets, explicit casts, every parameter's type,
 *   scalar ones included, its contexts and its functions' results), read from the statements, never a list of the
 *   schema's facts, which would miss scalar parameters and the casts inside a query. No role holds USAGE on a domain:
 *   PostgreSQL checks it only where a statement creates an object of the type (PostgreSQL 19.0, 2026-11-23: a role
 *   holding none cast into a domain, bound a parameter of it, wrote a column of it, called a function of it and read
 *   its arrays, and was refused only a temporary table and a function naming it, 42501), and a role creates no object
 *   of one: a carrier travels in its transaction's settings (write/carriers), no object. TRUNCATE is granted to no
 *   one, and no role holds a privilege on a base table it does not write or own a member of. No login or role is granted
 *   TEMPORARY, and PUBLIC's, which PostgreSQL gives every database, is the database owner's: grizzle neither relies on it
 *   nor revokes it. EXECUTE on the stamp
 *   function of each head of a relation it holds INSERT on (physical/ddl/stamps.ts addStamps), which each of its inserts
 *   that stamps the head calls; SELECT and DELETE on the head table of each place of a relation it holds DELETE on, which
 *   each of its deletes, removing whole groups, deletes the groups' heads of (write/insert/stamp.ts placeReleases); no
 *   role holds any other privilege on a head's table.
 *
 * Row security is enabled on exactly the tables some role writes through a query entry with a filter, once their
 * policies stand, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; its owner, the migration identity, bypasses it, and FORCE
 * is never used. A role that writes a family's member and not its owner O is one of O's writers there, its membership
 * on the member translated onto O through the group and the copies (`translated`): it reads and updates exactly the
 * owners whose groups its member writes admit, and a filter that reads any other field of the member is refused, as is
 * a narrowed entry on O that is not the members' translated filter. A table every writer of which holds every row has no
 * row security and no policy: each policy would be TRUE, and the grants already decide every write (`addRowSecurity`).
 *
 * For the schema as a whole: REVOKE ALL ... FROM PUBLIC on every level's schema and every schema of views, every table
 * and view and every domain, and each constant in its own object, so PUBLIC holds nothing on any
 * schema object; and
 * default-privilege resets so future objects grant nothing implicitly: ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN
 * SCHEMA <schema> REVOKE ALL ON TABLES and ON SEQUENCES FROM PUBLIC, and, because PostgreSQL adds per-schema default
 * ACLs to the global ones and cannot revoke the built-in PUBLIC EXECUTE on functions and USAGE on types per schema,
 * the global ALTER DEFAULT PRIVILEGES FOR ROLE <owner> REVOKE ALL ON FUNCTIONS and ON TYPES FROM PUBLIC. */
export const addWorlds = (
	b: InstallBuilder,
	stamps: ReadonlyMap<string, ReadonlyArray<StampFunction>>,
	revocable: Revocable,
	checkedLogins: ReadonlyArray<CheckedLogin>,
	carriers: ReadonlyArray<RoleCarriers>,
	calls: {
		readonly calls: ReadonlyArray<RoleCall>
		readonly declared: ReadonlyMap<string, InstalledFunction>
	},
	fences: ReadonlyArray<LoginFence>,
	standUps: ReadonlyMap<string, JudgeStandUp>,
	handed: ReadonlyArray<RoleWorldViews>
): WorldsPlan => {
	const logins = [...checkedLogins].toSorted((x, y) => compareStrings(x.login.name, y.login.name))
	const cx = worldsContext(b)
	const whole = addWholeViews(
		b,
		logins.flatMap((l) => l.roles)
	)
	const roleDefaults: Array<SqlStatement> = []
	const searchDefaults: Array<SqlStatement> = []
	const worlds: Array<InstalledLogin> = []
	const schemas = [...new Set([...whole.values()].map((v) => v.schema.name))]
	const views = [...whole.values()].map((v) => v.create.name)
	const writers: Array<Writer> = []
	for (const login of logins) {
		/** The functions a role calls: the stamp function of each head of a relation its grants let it insert into
		 * (grantedPrivileges), which every insert of the relation that stamps the head calls, the judge's stand-up of each
		 * judged relation its grants let it write (`standUps`), which its session calls before its first write of it, and
		 * each declared function its served programs reach; and the head of each place of a relation its grants let it
		 * delete from, which its deletes delete the removed groups' heads of. */
		const held = ({ checked }: CheckedRole): Held => {
			const role = checked.world.role
			const granted = [...grantedPrivileges(b.model, checked)]
			const called = [
				...granted.flatMap(([relation, privileges]) =>
					privileges.has("INSERT") ? (stamps.get(relation) ?? []) : []
				),
				...granted.flatMap(([relation, privileges]): ReadonlyArray<JudgeStandUp> => {
					const standUp = standUps.get(relation)
					return standUp !== undefined &&
						(privileges.has("INSERT") || privileges.has("UPDATE") || privileges.has("DELETE"))
						? [standUp]
						: []
				}),
				...calls.calls.flatMap((c) =>
					c.login === login.login.name && c.role === role.name
						? [defined(calls.declared.get(c.function), `the declared function ${c.function}`)]
						: []
				)
			]
			const released = granted.flatMap(([relation, privileges]) =>
				privileges.has("DELETE")
					? (stamps.get(relation) ?? []).flatMap((f) =>
							f.released === undefined ? [] : [{ node: f.node, table: f.released }]
						)
					: []
			)
			return { called, released }
		}
		/** A role's world views: the ones its compile computed, which an extension hands over, else computed here by the
		 * one function of the role's world (physical/access/world-views.ts roleWorldViews), once. */
		const worldViews = ({ views, checked }: CheckedRole): ReadonlyArray<WorldView> =>
			handed.find((h) => h.login === login.login.name && h.role === checked.world.role.name)
				?.views ??
			roleWorldViews({
				names: b.names,
				evidence: cx.catalog,
				checked,
				views,
				catalog: servedCatalog(b.model, b.names, [])
			})
		const added = addLogin(
			b,
			cx,
			login,
			whole,
			carriers,
			fences.find((f) => f.login === login.login.name)?.relations ?? [],
			held,
			worldViews
		)
		worlds.push(added.installed)
		appendAll(schemas, added.schemas)
		appendAll(views, added.views)
		appendAll(writers, added.writers)
		const settings = (list: ReadonlyArray<RoleSetting>): ReadonlyArray<SqlStatement> =>
			list.map((setting) => ({
				kind: "alterRole",
				name: added.installed.role,
				action: { kind: "set", setting }
			}))
		appendAll(roleDefaults, settings(roleDefaultSettings))
		if (added.vector) {
			appendAll(searchDefaults, settings(searchPolicySettings))
		}
	}
	addRowSecurity(b, writers)
	if (searchDefaults.length > 0) {
		appendAll(roleDefaults, [vectorLibraryLoad(b.names.vectorSchema), ...searchDefaults])
	}
	return {
		roleDefaults,
		publicRevokes: publicRevokes(b, { ...revocable, schemas, views }),
		worlds
	}
}

/** What PUBLIC is revoked from beside the base schema: the tables and the domains, each in the order the installation
 * added them. A function's own revoke is in its object's statements. */
export interface Revocable {
	readonly tables: ReadonlyArray<ObjectName>
	readonly domains: ReadonlyArray<ObjectName>
}

/** PUBLIC holds no privilege on any schema object, and the owner's future objects grant it nothing: every level's
 * schema, every schema of views, a level's of whole views and a role's of its query entries', every table and view, and
 * every domain. Each default-privilege reset is the
 * current role's, the migration identity's, which owns everything the installation creates. */
const publicRevokes = (
	b: InstallBuilder,
	objects: Revocable & {
		readonly schemas: ReadonlyArray<string>
		readonly views: ReadonlyArray<ObjectName>
	}
): ReadonlyArray<SqlStatement> => {
	const from: NonEmptyReadonlyArray<Grantee> = [{ kind: "PUBLIC" }]
	const out: Array<SqlStatement> = [
		{
			kind: "revoke",
			privileges: ["ALL"],
			on: {
				kind: "SCHEMA",
				names: extendNonEmpty(mapNonEmpty(b.names.levels, identifierOf), objects.schemas)
			},
			from
		}
	]
	const tables = [...objects.tables, ...objects.views]
	if (isNonEmpty(tables)) {
		out.push({ kind: "revoke", privileges: ["ALL"], on: { kind: "TABLE", names: tables }, from })
	}
	const { domains } = objects
	if (isNonEmpty(domains)) {
		out.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "DOMAIN", names: domains },
			from
		})
	}
	for (const level of b.names.levels) {
		for (const on of ["TABLES", "SEQUENCES"] as const) {
			out.push({
				kind: "alterDefaultPrivileges",
				inSchema: identifierOf(level),
				privileges: ["ALL"],
				on,
				from
			})
		}
	}
	for (const on of ["FUNCTIONS", "TYPES"] as const) {
		out.push({
			kind: "alterDefaultPrivileges",
			inSchema: undefined,
			privileges: ["ALL"],
			on,
			from
		})
	}
	return out
}
