import type { DerivedRelationAnalysis } from "#compiler/analysis/derived/analyze.ts"
import type { WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import {
	checkedRoleOver,
	type CheckedSchema,
	derivedAnalysis,
	type RoleEntry,
	type RoleWorld,
	type RoleWrite
} from "#compiler/analysis/schema.ts"
import { refuse } from "#compiler/analysis/theory/build.ts"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchCompileError, catchRefusal, compareText, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	compareIdentities,
	conversionOf,
	type Identity,
	identifierOf,
	identity,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { Family } from "#compiler/ir/family.ts"
import type {
	ClosedTheoryRelation,
	LawField,
	RelationInfo,
	TheoryRelation
} from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { DeployPhase, LogicalQuery } from "#compiler/ir/products.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf, contractOf, type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import { derivedKeyConstraints, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import type { AdvanceFunctions } from "#compiler/physical/ddl/advance.ts"
import { namesConstant } from "#compiler/physical/ddl/constants.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { structuralRegex, type TextColumnUse } from "#compiler/physical/ddl/domains.ts"
import { snapshotGuardFunction } from "#compiler/physical/ddl/ledger.ts"
import { loginIdentity, missing, roleIdentity, roleView } from "#compiler/physical/ddl/names.ts"
import {
	derivedReading,
	type LoweredDefinition,
	lowerDefinition
} from "#compiler/physical/derived/definition.ts"
import {
	enforcement,
	type Node,
	type ObjectSpec,
	type QualifiedKind
} from "#compiler/physical/obligations/graph.ts"
import type { HeadStanding } from "#compiler/schema/entry.ts"
import type { OwnedEntry, OwnedLogin, OwnedRole, OwnedWorldEntry } from "#compiler/schema/own.ts"

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

import {
	and,
	binary,
	col,
	exists,
	lit,
	namedType,
	not,
	objectName,
	or,
	param,
	provedSelect,
	qualifiedCall,
	simpleSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { nameOf } from "#compiler/sql/constants.ts"
import { printExpr, printStartupOptions } from "#compiler/sql/print.ts"
import { type AstHooks, identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import { filterFields, renderMembership } from "#compiler/write/entry/render.ts"
import { endColumns, ownerReadColumns } from "#compiler/write/family/statements.ts"
import {
	type OutsideProbe,
	probeIdentity,
	probeParams,
	relationUniques,
	withinRow
} from "#compiler/write/insert/unique.ts"
import { refusalFunction } from "#compiler/write/refusal.ts"

/**
 * The fixed login defaults, every login's, each one a grizzle guarantee rests on (sql/ast.ts textParameters): one list,
 * which the installation stores as ALTER ROLE ... SET, admission reads back from the manifest that holds those
 * statements (deploy/admission/roles.ts roleExpectation), and every session of a login's pool sets again at its
 * startup (loginStartupOptions). Every other setting, jit and lc_messages among them, is the database owner's.
 */
export const roleDefaultSettings = [
	{ parameter: "search_path" },
	{ parameter: "extra_float_digits", value: "1" },
	{ parameter: "lc_monetary", value: "C.UTF-8" },
	{ parameter: "lc_numeric", value: "C.UTF-8" },
	{ parameter: "lc_time", value: "C.UTF-8" }
] as const satisfies NonEmptyReadonlyArray<RoleSetting>

/**
 * The startup packet's `options` of every session of a login's pool (wire/session.ts): each fixed default at its
 * stored value. The client's own options outrank every default a session starts under, a database's and a role's
 * included, and pg sends them in place of the environment's PGOPTIONS, which it reads only when a client names none.
 */
export const loginStartupOptions: string = printStartupOptions(roleDefaultSettings)

/**
 * The search setting as a login default, for a login one of whose roles can name the vector type: pgvector's
 * strict-order iterative scan (check/approximate/policy.ts hnswPolicy), the one search setting grizzle pins.
 */
export const searchPolicySettings: NonEmptyReadonlyArray<TextSetting> = [
	{ parameter: "hnsw.iterative_scan", value: hnswPolicy.iterativeScan }
]

/** The statement that loads the vector library in the migration session, so its `hnsw.*` parameters are known when the
 * login defaults store them: a call of one of its C functions on a vector it parses. */
const vectorLibraryLoad = (vectorSchema: TypeSchema): Select =>
	provedSelect(
		"oneRow",
		[
			target(
				qualifiedCall(vectorSchema, "vector_dims", [
					lit.text("[1]", namedType(vectorSchema, "vector", []))
				])
			)
		],
		[],
		undefined
	)

/** One installed role, by its declared name: its theory role and its schema. */
export interface InstalledRole {
	readonly name: string
	readonly role: string
	readonly schema: string
}

/** One installed login, by its declared name: its PostgreSQL role and its roles, in name order. */
export interface InstalledLogin {
	readonly name: string
	readonly role: string
	readonly roles: ReadonlyArray<InstalledRole>
}

export interface WorldsPlan {
	readonly roleDefaults: ReadonlyArray<SqlStatement>
	readonly publicRevokes: ReadonlyArray<SqlStatement>
	/** The logins, in name order. */
	readonly worlds: ReadonlyArray<InstalledLogin>
}

/** A domain columns are typed by: its name, the identity it was minted from, and its object, when the installation
 * creates one. */
interface UsedType {
	readonly name: ObjectName
	readonly identity: Identity<"contractDomain" | "textDomain" | "rosterDomain" | "bitsDomain">
	readonly node: Node<"setup"> | undefined
}

/** The names of `m`'s types, ordered by the identities they were minted from. */
const sortedNames = (m: ReadonlyMap<string, UsedType>): ReadonlyArray<ObjectName> =>
	[...m.values()]
		.toSorted((a, b) => compareIdentities(a.identity, b.identity))
		.map((use) => use.name)

/** The domains columns are typed by, by name, and whether one is a vector. */
interface TypeUse {
	readonly domains: Map<string, UsedType>
	vector: boolean
}

const emptyUse = (): TypeUse => ({ domains: new Map(), vector: false })

/** The domains a column of type `t` names, down a contract's base chain and a span's endpoint: a contract's, a text
 * refinement's, a closed id's roster domain and a set's bits domain. */
const useType = (b: InstallBuilder, t: ScalarType, use: TypeUse): void => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		const name = b.names.contractDomain(contract.name)
		use.domains.set(name.name, {
			name,
			identity: b.names.contractNamed(contract.name),
			node: b.typeNamed(name)
		})
		useType(b, contract.base, use)
		return
	}
	if (t.carrier === "code") {
		const name = b.names.rosterDomain(t.roster.closed)
		use.domains.set(name.name, {
			name,
			identity: identity.rosterDomain(t.roster.closed),
			node: b.typeNamed(name)
		})
	}
	if (t.carrier === "bits") {
		const name = b.names.bitsDomain(t.roster.closed)
		const codec = defined(
			b.names.codes.rosters.get(t.roster.closed),
			"the codebook holds every roster"
		)
		use.domains.set(name.name, {
			name,
			identity: identity.bitsDomain(t.roster.closed, codec.size),
			node: b.typeNamed(name)
		})
	}
	const span = spanOf(t)
	if (span !== undefined) {
		useType(b, span.endpoint, use)
	}
	if (t.carrier === "vector") {
		use.vector = true
	}
	const regex = structuralRegex(t)
	if (regex !== undefined) {
		const name = b.names.textDomain(regex)
		const named = b.names.textNamed(regex)
		if (name !== undefined && named !== undefined) {
			use.domains.set(name.name, { name, identity: named, node: b.typeNamed(name) })
		}
	}
}

/** The types of every column of `heading`. */
const useColumns = (
	b: InstallBuilder,
	heading: ReadonlyArray<HeadingColumn>,
	use: TypeUse
): void => {
	for (const c of heading) {
		useType(b, c.type, use)
	}
}

/** The objects a world object's statements read: every relation, type and function they name that the installation
 * has created so far (a table, a materialized view, a view, a domain, a function, a constant), each once. A world object
 * waits for each, so a change to any of them (a conversion, a rebuild, a recreated view) drops it first and creates it
 * again after (`worldChangesOf`): PostgreSQL refuses to convert, drop or rename what a view, a policy or a function
 * body reads beneath it. A statement's own object is added after its reads, so it is none of them. */
const readsOf = (
	b: InstallBuilder,
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<Node<DeployPhase>> => {
	const read = new Set<Node<DeployPhase>>()
	const note = (kinds: ReadonlyArray<QualifiedKind>, name: ObjectName): void => {
		for (const kind of kinds) {
			const node = b.objectNamed(kind, name)
			if (node !== undefined) {
				read.add(node)
			}
		}
	}
	const hooks: AstHooks = {
		...identityHooks,
		objectName: (name, space) => {
			note(
				space === "relation"
					? ["table", "materializedView", "view"]
					: space === "type"
						? ["domain"]
						: space === "function"
							? ["function"]
							: [],
				name
			)
			return name
		},
		typeRef: (type) => {
			if (type.kind === "named") {
				note(["domain"], { schema: type.schema, name: type.name })
			}
			return type
		},
		functionRef: (fn) => {
			note(["function"], { schema: fn.schema, name: fn.name })
			return fn
		}
	}
	for (const statement of statements) {
		transformStatement(statement, hooks)
	}
	return [...read]
}

/** The serial fields of a stored relation, in heading order. */
const serialFields = (relation: TheoryRelation): ReadonlyArray<string> =>
	relation.fields.filter((c) => c.writing.kind === "serial").map((c) => c.name)

const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
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
					.toSorted(([a], [b]) => compareText(a, b))
					.map(([field, desc]): ContextField => {
						const loc = SourceLoc(`context ${context.name} of role ${role.name}`, [])
						return { context: context.name, field, desc, type: checked.fieldType(desc, loc), loc }
					})
			)
		)
	)

/** A role the installation installs, read against the installed schema: the identity its PostgreSQL role and views are
 * named by, and its checked schema over the installed base, built once for every reader of the role. */
export interface CheckedRole {
	readonly theory: Identity<"role">
	readonly checked: CheckedSchema<RoleWorld>
}

/** A login the installation installs, with each of its roles read against the installed schema, in the login's order. */
export interface CheckedLogin {
	readonly login: OwnedLogin
	readonly roles: ReadonlyArray<CheckedRole>
}

/** `role` read against the installed schema `base`: its identity, refused when its name does not convert, then its
 * checked schema over the base. */
export const checkedRole = (
	base: CheckedSchema,
	installation: Identity<"schema">,
	role: OwnedRole
): Result.Result<CheckedRole, CompileError> =>
	Result.flatMap(
		catchCompileError(() => roleIdentity(installation, role.name, role.loc)),
		(theory) => Result.map(checkedRoleOver(role, base), (checked) => ({ theory, checked }))
	)

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
	readonly lower: (relation: string, query: LogicalQuery) => LoweredDefinition
}

const worldsContext = (b: InstallBuilder): WorldsContext => {
	const checked = b.checked
	const catalog = evidenceCatalog({
		laws: b.model,
		views: derivedKeyConstraints(derivedAnalysis(checked))
	})
	return {
		checked,
		catalog,
		lower: (relation, query) =>
			unwrap(lowerDefinition(relation, query, { names: b.names, catalog }))
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
interface WrittenEntry {
	readonly write: RoleWrite
	readonly relation: RelationInfo
}

/** A relation of a role as the installation reads it: a whole entry by the kind of the base relation its checked schema
 * holds, the installed schema's own handle or analysis, or a query entry with its analysis. */
const roleRelation = (e: RoleEntry): RoleRelation => {
	if (e.kind === "world") {
		return { kind: "world", entry: e.entry, analysis: e.analysis }
	}
	const r = e.relation
	switch (r.kind) {
		case "relation":
			return { kind: "stored", entry: e.entry, relation: r }
		case "closed":
			return { kind: "closed", entry: e.entry, relation: r.relation }
		case "derived":
			return { kind: "derived", entry: e.entry, analysis: r.analysis }
	}
}

/** Each writable entry of a role, in name order, with the relation it writes: the role's write list over the installed
 * schema's handles (analysis/schema.ts RoleWrite), which names only relations the installed schema declares. */
const roleWrites = (checked: CheckedSchema<RoleWorld>): ReadonlyArray<WrittenEntry> =>
	[...checked.world.writes.values()].map((write) => ({
		write,
		relation: write.kind === "whole" ? write.relation : write.writable.target
	}))

/** One role relation's view: its CREATE VIEW, the graph objects it reads, and its columns' types. */
interface ViewPlan {
	readonly create: Extract<SqlStatement, { readonly kind: "createView" }>
	readonly reads: ReadonlyArray<Node<"setup" | "structure">>
	readonly heading: ReadonlyArray<HeadingColumn>
}

/** A view's column and what it reads: a heading column's own value, or the decoded name beside a closed id's. */
interface ViewColumn {
	readonly name: string
	readonly value: Expr
}

/**
 * A view's columns over the heading `heading`, each column `c` read as `read(c)` under its view name `columnName(c)`: each
 * closed id followed by its decoded column, `<field>_name`, the handle its code names, read from its roster's names
 * constant, `(N())[c + 1]::text` (E2, D12). A set has no decoded column (OPEN-4).
 */
const viewColumns = <C extends HeadingColumn>(
	b: InstallBuilder,
	heading: NonEmptyReadonlyArray<C>,
	columnName: (c: C) => string,
	read: (c: C, position: number) => Expr
): NonEmptyReadonlyArray<ViewColumn> => {
	const columns = mapNonEmpty(heading, (c, position): NonEmptyReadonlyArray<ViewColumn> => {
		const own: ViewColumn = { name: columnName(c), value: read(c, position) }
		const base = baseOf(c.type)
		if (base.carrier !== "code") {
			return [own]
		}
		const field = parseDeclaredName(c.name)
		if (!field.ok) {
			return missing(
				`physical: the closed id field ${JSON.stringify(c.name)}, a name ${field.error}`
			)
		}
		return [
			own,
			{
				name: b.name(identity.decodedColumn(field.value)),
				value: nameOf(namesConstant(b, base.roster.closed), own.value)
			}
		]
	})
	return extendNonEmpty(columns[0], columns.slice(1).flat())
}

/** The view of a whole entry: every column of its table or materialized view, in heading order, each closed id with
 * its decoded column after it. */
const wholeView = (
	b: InstallBuilder,
	name: ObjectName,
	relation: string,
	heading: NonEmptyReadonlyArray<HeadingColumn>,
	read: Node<"setup" | "structure"> | undefined
): ViewPlan => {
	const source = b.names.relation(relation)
	const columns = viewColumns(
		b,
		heading,
		(c) => b.names.column(relation, c.name),
		(c) => col("r1", b.names.column(relation, c.name))
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
				[table(source.schema, source.name, "r1")],
				undefined
			)
		},
		reads: read === undefined ? [] : [read],
		heading
	}
}

/** The view of a query entry: its definition, lowered, behind a security barrier. A definition with a closed id in its
 * heading is read as a derived table under generated names (physical/derived/definition.ts readAsDerived), whose every
 * column the view passes on, each closed id with its decoded column after it. */
const worldView = (
	b: InstallBuilder,
	cx: WorldsContext,
	role: OwnedRole,
	name: ObjectName,
	e: OwnedWorldEntry,
	analysis: WorldAnalysis
): ViewPlan => {
	const entry = `${role.name}.${e.name}`
	const lowered = cx.lower(entry, analysis.query)
	const decodes = analysis.heading.some((c) => baseOf(c.type).carrier === "code")
	const reading = decodes
		? unwrap(derivedReading(lowered, `the decoded view of ${entry}`))
		: undefined
	const columns =
		reading === undefined
			? undefined
			: viewColumns(
					b,
					analysis.heading,
					(c) => b.name(identity.column(c.name)),
					(_, position) => reading.read(position)
				)
	return {
		create: {
			kind: "createView",
			name,
			columns:
				columns === undefined
					? mapNonEmpty(analysis.heading, (c) => b.name(identity.column(c.name)))
					: mapNonEmpty(columns, (c) => c.name),
			/** The facts of its definition, which hides the others: a barrier keeps a reader's quals after its own. */
			barrier: true,
			query:
				reading === undefined || columns === undefined
					? lowered.query
					: provedSelect(
							"keyed",
							columns.map((c) => target(c.value)),
							[reading.from],
							undefined
						)
		},
		reads: analysis.reads.flatMap((read) => {
			const object = b.readObject(read)
			return object === undefined ? [] : [object]
		}),
		heading: analysis.heading
	}
}

/** The view of a role relation other than a closed whole entry, with the identity it is named by. */
const viewOf = (
	b: InstallBuilder,
	cx: WorldsContext,
	role: OwnedRole,
	theory: Identity<"role">,
	schema: string,
	r: Exclude<RoleRelation, { readonly kind: "closed" }>
): ViewPlan & { readonly named: Identity<"roleView"> } => {
	const named = roleView(theory, r.entry)
	const name = objectName(schema, b.name(named))
	switch (r.kind) {
		case "stored":
			return {
				named,
				...wholeView(b, name, r.relation.name, r.relation.fields, b.readObject(r.relation.name))
			}
		case "derived":
			return {
				named,
				...wholeView(
					b,
					name,
					r.entry.relation.name,
					r.analysis.heading,
					b.readObject(r.entry.relation.name)
				)
			}
		case "world":
			return { named, ...worldView(b, cx, role, name, r.entry, r.analysis) }
	}
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
type Membership =
	| { readonly kind: "every" }
	| {
			readonly kind: "narrowed"
			readonly filter: Expr
			readonly reads: ReadonlyArray<LawField>
			readonly over: (row: (field: LawField) => Expr) => Expr
	  }

const everyRow: Membership = { kind: "every" }

/** What one role's writable entry installs on its table: its membership, its filter function when its membership
 * reads another relation, its key and unique probes, and its privileges on the table. */
interface WritePlan {
	readonly membership: Membership
	/** The functions it installs: a query entry's filter function when it has one, then its key and unique probes. */
	readonly functions: ReadonlyArray<WorldFunction>
	readonly grants: ReadonlyArray<SqlStatement>
}

/** The alias a probe reads T's row under: r0, the input-row alias the write protocols use, since a lowering numbers its
 * own FROM items from r1, so no item inside the membership takes it. */
const probeRow = "r0"

/** Whether a role holds column UPDATE on a head field of its writable entry over a mutable T: only on a free one. A key
 * field is the identity an update matches by, and a claim-fixed one holds the claim's value in every fact of the world,
 * so the privilege set enforces the world beside the policy's WITH CHECK. */
const takesUpdate: Readonly<Record<HeadStanding, boolean>> = {
	free: true,
	claimFixed: false,
	keyed: false
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
	const grantee: NonEmptyReadonlyArray<Grantee> = [{ kind: "role", name: identifierOf(theory) }]
	const grant = (privileges: NonEmptyReadonlyArray<Privilege>, on: Grant["on"]): Grant => ({
		kind: "grant",
		privileges,
		on,
		to: grantee
	})
	/** EXECUTE on the advance function of each serial field of the relation: no role holds a privilege on
	 * an identity sequence. */
	const advances = serialFields(written).map((field): FunctionName => ({
		...b.names.advance(written.name, field),
		args: [types.bigint]
	}))
	const advanceGrants: ReadonlyArray<SqlStatement> = isNonEmpty(advances)
		? [grant(["EXECUTE"], { kind: "FUNCTION", names: advances })]
		: []
	if (e.kind === "whole") {
		const r = e.relation
		const tableName = b.names.relation(r.name)
		return {
			membership: everyRow,
			functions: [],
			grants: [
				grant(
					r.mutable ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : ["SELECT", "INSERT", "DELETE"],
					{
						kind: "TABLE",
						names: [tableName]
					}
				),
				...advanceGrants
			]
		}
	}
	const writable = e.writable
	const relation = written.name
	const tableName = b.names.relation(relation)
	const column = (field: LawField): string => b.names.column(relation, field.name)
	const all = written.fields.map(column)
	/** The columns a write names: every field but a generated one, the caller's and those grizzle writes for it (a
	 * serial field's explicit value, a family's drawn index and count, a fold's accumulator), then the drawn law columns
	 * grizzle writes (D14). A generated field, which PostgreSQL computes, takes no INSERT or UPDATE. */
	const insertable = [
		...written.fields.filter((f) => f.writing.kind !== "generated").map(column),
		...drawnColumnsOf(b, relation)
	]
	const updatable = written.mutable
		? [...writable.head.values()].flatMap((h) =>
				takesUpdate[h.kind] && h.field.writing.kind !== "generated" ? [column(h.field)] : []
			)
		: []
	const columnGrant = (
		privilege: ColumnPrivilege,
		columns: ReadonlyArray<string>
	): ReadonlyArray<SqlStatement> =>
		isNonEmpty(columns)
			? [{ kind: "grantColumns", privilege, table: tableName, columns, to: identifierOf(theory) }]
			: []
	const grants: ReadonlyArray<SqlStatement> = [
		...columnGrant("SELECT", all),
		...columnGrant("INSERT", insertable),
		...columnGrant("UPDATE", updatable),
		grant(["DELETE"], { kind: "TABLE", names: [tableName] }),
		...advanceGrants
	]
	/** The entry's probes (see `addWorlds`), exactly those of T's unique objects (write/insert/unique.ts
	 * RelationUniques.probes) an entry's precheck calls: whether T holds a fact that conflicts with the submitted values
	 * at one of its unique objects and lies outside the entry's membership, which the policy's own predicate decides
	 * over that row. One key probe per key of T, at the key's values (overlapping at a span field), and one unique probe
	 * per unique object of T no key subsumes, such as a key over a selected side, at the values of the fields it reads,
	 * within its guards on both sides. Each reads T and what the membership reads as the owner. */
	const outside = not({
		kind: "isTrue",
		expr: unwrap(
			renderMembership(writable, {
				schema: cx.checked,
				names: b.names,
				catalog: cx.catalog,
				row: (f) => col(probeRow, column(f))
			})
		)
	})
	/** The context a unique object's guards lower in: the law model's DAG, which holds them, and the installation's
	 * names. A guard reads its row alone, so it takes no parameter. */
	const guardCx = new LowerContext(
		b.model.theory.dag,
		{ names: b.names, params: [], subject: { kind: "query" } },
		dispatchNode
	)
	/** A probed object's guards over one side's values (write/insert/unique.ts withinRow): a declared key's none, since
	 * it holds every fact apart. */
	const within = (probed: OutsideProbe, of: (field: LawField) => Expr): ReadonlyArray<Expr> =>
		probed.kind === "unique" ? withinRow(guardCx, probed.object, of) : []
	/** A probe by its identity of its parameters (write/insert/unique.ts probeIdentity, probeParams), each at its base
	 * type, true where a fact of T outside the entry meets them at its object: within its guards on both sides, equal
	 * at its compared fields, overlapping at its span. */
	const probe = (probed: OutsideProbe): WorldFunction => {
		const named = probeIdentity(theory, e.name, probed)
		const u = probed.object
		const what = probed.kind === "key" ? "the keys" : `the unique object ${u.name}`
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
		const stored = (field: LawField): Expr => col(probeRow, column(field))
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
						language: "sql",
						name: objectName(b.schema, probeIdent),
						volatility: "STABLE",
						parallel: "UNSAFE",
						security: "DEFINER",
						planCacheMode: "force_generic_plan",
						returns: "boolean",
						params: params.map((p) => ({ name: p.column, type: p.type })),
						body: exists(
							simpleSelect(
								[target(lit.bool(true))],
								[table(tableName.schema, tableName.name, probeRow)],
								and(
									appendNonEmpty(
										[
											...within(probed, stored),
											...within(probed, given),
											...u.equal.map((f) => binary("=", stored(f), given(f))),
											...(u.kind === "span" ? [binary("&&", stored(u.span), given(u.span))] : [])
										],
										outside
									)
								)
							)
						)
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
	const probes = relationUniques(
		b.model.relations.get(relation) ??
			refuse(
				"MalformedDescription",
				role.loc,
				`a writable entry over an ordinary relation, not ${relation}`
			)
	).probes.map(probe)
	const probeGrants: ReadonlyArray<SqlStatement> = isNonEmpty(probes)
		? [grant(["EXECUTE"], { kind: "FUNCTION", names: mapNonEmpty(probes, (p) => p.name) })]
		: []
	const filter = writable.filter
	if (filter.kind === "none") {
		return { membership: everyRow, functions: probes, grants: [...grants, ...probeGrants] }
	}
	const reads = filterFields(writable)
	if (!filter.readsOther) {
		const over = (row: (field: LawField) => Expr): Expr =>
			unwrap(
				renderMembership(writable, {
					schema: cx.checked,
					names: b.names,
					catalog: cx.catalog,
					row: (f) => row(f)
				})
			)
		return {
			membership: {
				kind: "narrowed",
				filter: over((f) => col(tableName.name, column(f))),
				reads,
				over
			},
			functions: probes,
			grants: [...grants, ...probeGrants]
		}
	}
	const filterNamed = identity.filter(theory, e.name)
	const fnIdent = b.name(filterNamed)
	/** The fields of T the membership reads, each with its column and its base type, the type the membership reads it
	 * at and the filter function's parameter's. */
	const fields = reads.map((field) => ({
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
				language: "sql",
				name: objectName(b.schema, fnIdent),
				volatility: "STABLE",
				parallel: "UNSAFE",
				security: "DEFINER",
				planCacheMode: "force_generic_plan",
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
	const over = (row: (field: LawField) => Expr): Expr =>
		qualifiedCall(
			b.schema,
			fnIdent,
			reads.map((f) => row(f))
		)
	return {
		membership: {
			kind: "narrowed",
			filter: over((f) => col(tableName.name, column(f))),
			reads,
			over
		},
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
 * policies wait for every role's (`addRowSecurity`), and its schema and views, which PUBLIC holds nothing on. */
interface RoleOutcome {
	readonly installed: InstalledRole
	readonly vector: boolean
	readonly writers: ReadonlyArray<Writer>
	readonly views: ReadonlyArray<ObjectName>
}

/** The objects of the domains `use` holds, each the installation creates. */
const usedNodes = (use: TypeUse): ReadonlyArray<Node<"setup">> =>
	[...use.domains.values()].flatMap((t) => (t.node === undefined ? [] : [t.node]))

/** The drawn law columns of `relation`, in the law model's order: columns the host writes beside the caller's fields. */
const drawnColumnsOf = (b: InstallBuilder, relation: string): ReadonlyArray<string> =>
	b.natives.flatMap(({ object: o }) =>
		o.kind === "LawColumn" && o.value.kind === "drawn" && o.relation.name === relation
			? [o.column]
			: []
	)

/**
 * What a role that writes a member of a family holds on the family's owner O (rows-first.md §2), beside what its own
 * entries grant, and nothing wider. Column SELECT on exactly what the family's read flight reads of O
 * (write/family/statements.ts suffixReadSql): its key, the owner fields the group pairs with, and `ownerReadColumns`:
 * its count, its ends and the fields its owner axis copies into members, which the role writes into its own member rows.
 * Column UPDATE, when O is mutable, on exactly what the family's count statement sets (countStatement): its count and
 * `endColumns`. No UPDATE on an immutable O, whose family is fixed when it is inserted. None of O's other fields. A role
 * that writes O whole holds all of O already and takes none. `families` are the families of O whose member it writes, in
 * the law model's order; each column list is in O's field order.
 */
interface OwnerHold {
	readonly owner: RelationInfo
	readonly families: NonEmptyReadonlyArray<Family>
	readonly select: ReadonlyArray<LawField>
	readonly update: ReadonlyArray<LawField>
}

/** The owners whose members a role writes (`written`), each with what the role holds on it (`OwnerHold`), in the law
 * model's order of their first family. */
const ownerHolds = (
	b: InstallBuilder,
	role: OwnedRole,
	written: ReadonlyArray<WrittenEntry>
): ReadonlyArray<OwnerHold> => {
	const writes = new Set(written.map((w) => w.relation.name))
	const whole = new Set(written.flatMap((w) => (w.write.kind === "whole" ? [w.relation.name] : [])))
	const byOwner = new Map<string, NonEmptyReadonlyArray<Family>>()
	for (const f of b.model.families) {
		if (writes.has(f.member.name) && !whole.has(f.owner.name)) {
			const at = byOwner.get(f.owner.name)
			byOwner.set(f.owner.name, at === undefined ? [f] : appendNonEmpty(at, f))
		}
	}
	return [...byOwner].map(([name, families]): OwnerHold => {
		const owner = (
			b.model.relations.get(name) ??
			refuse(
				"MalformedDescription",
				role.loc,
				`a family owned by an ordinary relation, not ${name}`
			)
		).relation
		const selected = new Set(
			families.flatMap((f) => [
				...f.group.map((g) => g.owner.name),
				...ownerReadColumns(f).map((c) => c.name)
			])
		)
		const updated = new Set(
			owner.mutable
				? families.flatMap((f) => [f.count.name, ...endColumns(f).map((c) => c.name)])
				: []
		)
		return {
			owner,
			families,
			select: owner.fields.filter((field) => selected.has(field.name)),
			update: owner.fields.filter((field) => updated.has(field.name))
		}
	})
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
	b: InstallBuilder,
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
	const ownerTable = b.names.relation(f.owner.name)
	const over = (row: (field: LawField) => Expr): Expr => m.over((field) => row(paired(field)))
	return {
		kind: "narrowed",
		filter: over((field) => col(ownerTable.name, b.names.column(f.owner.name, field.name))),
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
 * The constants a role is granted EXECUTE on, with their objects (InstallBuilder.reached): every one a statement it runs
 * calls, directly or through another constant's body, since PostgreSQL checks EXECUTE against the invoker. Those are the
 * CHECKs of the domains its columns are typed by, which a write and a cast to the domain run; the table it writes, its
 * CHECKs and generated columns; its views' columns, a closed id's decoded name among them; and every closed relation's
 * constants, which its queries' closed reads call.
 */
const roleExecutes = (
	b: InstallBuilder,
	use: TypeUse,
	written: ReadonlyArray<string>,
	views: ReadonlyArray<SqlStatement>
): ReadonlyArray<{ readonly name: FunctionName; readonly node: Node<"setup"> }> => {
	const statements = [
		...[...use.domains.values()].flatMap((t) => (t.node === undefined ? [] : t.node.ddl)),
		...written.flatMap((relation) => b.table(relation).ddl),
		...views
	]
	const closed = Object.values(b.owned.relations).flatMap((r) => {
		if (r.kind !== "closedRelation") {
			return []
		}
		const c = b.names.closed(r.name)
		return [
			c.function.name,
			c.keys.name,
			...c.payload.flatMap((p) => (p.dictionary === undefined ? [] : [p.dictionary.name]))
		]
	})
	return b.reached([...b.callsOf(statements), ...closed])
}

/** One role's theory role, schema, views, filter functions, key and unique probes and grants, and its writable entries,
 * whose policies `addRowSecurity` adds. A roster whole entry has no view: its handles are read as codes, typed by its
 * domain, which the role uses. The filter function a policy calls, then the probes, each come
 * after every relation, type and function their statements read. */
const addRole = (
	b: InstallBuilder,
	cx: WorldsContext,
	{ theory: named, checked }: CheckedRole,
	login: { readonly role: string; readonly object: Node<"publish"> },
	advance: AdvanceFunctions
): RoleOutcome => {
	const role = checked.world.role
	const theory = b.name(named)
	const schemaNamed = identity.roleSchema(named)
	const schema = b.name(schemaNamed)
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
	const schemaObject = b.add(
		{
			kind: "roleSchema",
			ident: { kind: "schema", name: schemaNamed },
			ddl: [{ kind: "createSchema", name: schema, authorization: b.settings.owner }],
			reasons: why,
			phase: "publish"
		},
		[]
	)

	const use = emptyUse()
	const grants: Array<SqlStatement> = []
	const after: Array<Node<DeployPhase>> = [roleObject, b.schemaNode, schemaObject]
	const grantee: NonEmptyReadonlyArray<Grantee> = [{ kind: "role", name: theory }]
	const grant = (privileges: NonEmptyReadonlyArray<Privilege>, on: Grant["on"]): Grant => ({
		kind: "grant",
		privileges,
		on,
		to: grantee
	})

	const views: Array<ObjectName> = []
	const viewStatements: Array<SqlStatement> = []
	for (const r of checked.entries.map(roleRelation)) {
		if (r.kind === "closed") {
			useColumns(b, r.relation.fields, use)
			continue
		}
		const plan = viewOf(b, cx, role, named, schema, r)
		const own = emptyUse()
		useColumns(b, plan.heading, own)
		const view = b.add(
			{
				kind: "view",
				ident: { kind: "view", schema: schemaNamed, name: plan.named },
				ddl: [plan.create],
				reasons: why,
				phase: "publish"
			},
			[schemaObject, ...plan.reads, ...readsOf(b, [plan.create]), ...usedNodes(own)]
		)
		useColumns(b, plan.heading, use)
		views.push(plan.create.name)
		viewStatements.push(plan.create)
		after.push(view)
	}

	const writers: Array<Writer> = []
	const written = roleWrites(checked)
	for (const w of written) {
		const plan = writePlan(b, cx, role, named, w)
		const relation = w.relation.name
		useColumns(b, w.relation.fields, use)
		appendAll(grants, plan.grants)
		appendAll(after, [
			b.table(relation),
			...serialFields(w.relation).flatMap((f) => {
				const fn = advance.get(relation)?.get(f)
				return fn === undefined ? [] : [fn]
			})
		])
		const functions = plan.functions.map((fn) =>
			b.add(fn.spec, [b.schemaNode, ...readsOf(b, fn.spec.ddl)])
		)
		appendAll(after, functions)
		writers.push({
			relation,
			role: named,
			roleObject,
			entry: `${role.name}.${w.write.name}`,
			membership: plan.membership
		})
	}
	const holds = ownerHolds(b, role, written)
	for (const hold of holds) {
		const owner = hold.owner.name
		const ownerTable = b.names.relation(owner)
		const columns = (fields: ReadonlyArray<LawField>): ReadonlyArray<string> =>
			fields.map((field) => b.names.column(owner, field.name))
		const select = columns(hold.select)
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
		useColumns(b, hold.update, use)
		after.push(b.table(owner))
		const membership = familyMembership(
			mapNonEmpty(hold.families, (f) => {
				const member = defined(
					writers.find((w) => w.relation === f.member.name),
					`the writer of ${f.member.name}, a member ${role.name} writes`
				)
				return translated(b, role, member.entry, f, member.membership)
			})
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
	const refuses = role.writes.size > 0 || Object.keys(role.contexts).length > 0
	if (refuses) {
		after.push(b.refusal)
	}

	const refreshed = role.refresh.map((f) => b.names.relation(f))
	for (const f of role.refresh) {
		const view = b.materializedView(f)
		if (view !== undefined) {
			after.push(view)
		}
	}

	const privileges: Array<SqlStatement> = [
		grant(["USAGE"], { kind: "SCHEMA", names: [b.schema, schema] })
	]
	if (use.vector) {
		privileges.push(grant(["USAGE"], { kind: "SCHEMA", names: [b.settings.vectorSchema] }))
	}
	const domains = sortedNames(use.domains)
	if (isNonEmpty(domains)) {
		privileges.push(grant(["USAGE"], { kind: "DOMAIN", names: domains }))
	}
	if (isNonEmpty(views)) {
		privileges.push(grant(["SELECT"], { kind: "TABLE", names: views }))
	}
	if (isNonEmpty(refreshed)) {
		privileges.push(grant(["MAINTAIN"], { kind: "TABLE", names: refreshed }))
	}
	appendAll(privileges, grants)
	if (refuses) {
		privileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))
	}
	const executes = roleExecutes(
		b,
		use,
		[
			...written.map((w) => w.relation.name),
			...holds.flatMap((h) => (isNonEmpty(h.update) ? [h.owner.name] : []))
		],
		viewStatements
	)
	if (isNonEmpty(executes)) {
		privileges.push(
			grant(["EXECUTE"], { kind: "FUNCTION", names: mapNonEmpty(executes, (e) => e.name) })
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
		[...after, ...usedNodes(use), ...executes.map((e) => e.node)]
	)
	return {
		installed: { name: role.name, role: theory, schema },
		vector: use.vector,
		writers,
		views
	}
}

const addLogin = (
	b: InstallBuilder,
	cx: WorldsContext,
	{ login, roles }: CheckedLogin,
	advance: AdvanceFunctions
): {
	readonly installed: InstalledLogin
	readonly vector: boolean
	readonly writers: RoleOutcome["writers"]
	readonly views: ReadonlyArray<ObjectName>
} => {
	const named = loginIdentity(b.settings.installation, login.name, login.loc)
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
	b.add(
		{
			kind: "privileges",
			ident: { kind: "privileges", name: named },
			ddl: [
				{
					kind: "grant",
					privileges: ["USAGE"],
					on: { kind: "SCHEMA", names: [b.schema] },
					to: [{ kind: "role", name: role }]
				},
				{
					kind: "grant",
					privileges: ["EXECUTE"],
					on: { kind: "FUNCTION", names: [snapshotGuardFunction(b.schema)] },
					to: [{ kind: "role", name: role }]
				}
			],
			reasons: why,
			phase: "publish"
		},
		[roleObject, b.schemaNode, b.snapshotGuard]
	)
	const outcomes = [...roles]
		.toSorted((x, y) => compareText(x.checked.world.role.name, y.checked.world.role.name))
		.map((r) => addRole(b, cx, r, { role, object: roleObject }, advance))
	return {
		installed: { name: login.name, role, roles: outcomes.map((o) => o.installed) },
		vector: outcomes.some((o) => o.vector),
		writers: outcomes.flatMap((o) => o.writers),
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
				schema: b.settings.installation,
				relation: b.names.relationNamed(w.relation),
				name: named
			},
			ddl: [ddl],
			reasons: [enforcement(`the writable entry ${w.entry}`)],
			phase: "publish"
		},
		[b.table(w.relation), w.roleObject, ...readsOf(b, [ddl])]
	)
}

/** Row security on each table some writer narrows, after every writer's policy on it, and on no other table. Under row
 * security a role with no policy on a table reads and writes none of its rows, so every writer of such a table holds
 * its policy, TRUE for one that holds every row. A table no writer narrows has neither row security nor a policy: each
 * policy would be TRUE, which admits exactly what the role's grants admit, so the grants alone decide its writes. */
const addRowSecurity = (b: InstallBuilder, writers: ReadonlyArray<Writer>): void => {
	const byTable = [...Map.groupBy(writers, (w) => w.relation)].toSorted(([x], [y]) =>
		compareText(x, y)
	)
	for (const [relation, on] of byTable) {
		if (on.every((w) => w.membership.kind === "every")) {
			continue
		}
		const policies = on.map((w) => addPolicy(b, w))
		b.add(
			{
				kind: "rowSecurity",
				ident: b.qualified("rowSecurity", b.names.relationNamed(relation)),
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

/** Worlds: the logins over a schema, their roles, each role's schema and views, grants and policies, the writable
 * entries' filter functions and key and unique probes, the logins' defaults, and the PUBLIC revokes.
 *
 * Every name is minted at the naming door under the installation's identity (`worldNames`): a login's and a role's
 * PostgreSQL roles are cluster-wide. Per login over the base, the Publish phase emits:
 *
 * - `CREATE ROLE <login> LOGIN NOINHERIT`: the one credential of a pool, holding no privilege of its own but
 *   USAGE on the base schema, SELECT on the ledger and EXECUTE on the snapshot guard: the fence Db.open's admission and
 *   every transaction of its Dbs take as the login, the ledger's lock (deploy/ledger/ledger.ts) and the guard
 *   (physical/ddl/ledger.ts);
 * - the login's defaults (`roleDefaultSettings`), as ALTER ROLE ... SET, which PostgreSQL applies at login and never on
 *   SET ROLE, over any default of the database's or the cluster's, and which every session of a login's pool sets
 *   again in its startup options (`loginStartupOptions`): `search_path = pg_catalog, pg_temp` (closedSearchPath), so
 *   no name a login's statement holds resolves through a path anyone else chose, `extra_float_digits = 1` (float text
 *   is shortest round-trip only when it is positive) and lc_monetary, lc_numeric and lc_time at C.UTF-8. For a login
 *   one of whose roles can name the vector type, the strict-order iterative scan too (`searchPolicySettings`): an
 *   `hnsw.*` parameter is a placeholder until the vector library is loaded in the session, and the migration
 *   identity, which is no superuser, may store one only after that (42501 before), so the defaults list a statement
 *   that loads the library, `SELECT <ext>.vector_dims('[1]'::<ext>.vector)`, once, before it. It is the one default
 *   statement that is not an ALTER ROLE: it installs nothing, and a migration runs it whenever it stores a default
 *   after it.
 *
 * Per role of a login:
 *
 * - `CREATE ROLE <role> NOLOGIN`, its theory role, and `GRANT <role> TO <login> WITH INHERIT FALSE, SET
 *   TRUE`: the login acts as the role only after SET ROLE, which each of the role's transactions does first;
 * - its schema, `CREATE SCHEMA <role schema>`, owned by the owner, and in it one view per role relation, owned by
 *   the owner, so it reads reality as the owner. A query entry's view is its definition, lowered by the derived
 *   definition lowering (`lowerDefinition`), which reads a context where it stands, `CREATE VIEW ... WITH (security_barrier)`, so no qual a reader adds runs before its own
 *   and no error such a qual raises shows a row outside it. A whole entry's view reads every row and column of its
 *   table (or its materialized view) and hides nothing, so it is a plain view, which PostgreSQL flattens into the
 *   reader's query, pushing its quals to the table's indexes and keeping SSI's read locks to the rows read. Every
 *   closed id column of a view is followed by its decoded column, `<field>_name`, its roster's names constant's element
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
 * - its privileges: USAGE on the base schema, on its own schema, on the vector extension's schema when a relation it
 *   reads or writes holds a vector column, and on the domains its relations' columns are typed by, down a contract's
 *   base chain, roster, bits and structural text domains alike, which a write's carriers name;
 *   SELECT on each of its views; MAINTAIN on the materialized view of each derived relation it refreshes, which
 *   REFRESH MATERIALIZED VIEW checks. For each writable entry on T: a whole entry's table SELECT, INSERT and DELETE,
 *   and UPDATE when its relation is mutable, so an UPDATE of an immutable relation is refused by privilege (immutable by
 *   default is pinned); a query entry's column SELECT and INSERT on T's fields (the head's and the fixed ones, which
 *   are all of them), column UPDATE on its mutable head fields that are neither fixed nor in a key, and DELETE;
 *   EXECUTE on the advance function of every serial field of T (`addAdvanceFunctions`), the one way a write moves the field's
 *   identity sequence past explicit values, since no role holds a privilege on a sequence; EXECUTE on its filter
 *   functions and key and unique probes. For each family whose member it writes, on the family's owner O, unless it
 *   writes O whole (`ownerHolds`): column SELECT on what the family's read flight reads, O's key, count, ends and the
 *   fields its owner axis copies into members, and, when O is mutable, column UPDATE on what its count statement
 *   sets, O's count and ends, none on an immutable O, whose family is fixed at insert; USAGE on those fields' domains.
 *   EXECUTE on the refusal function to a role that writes or reads a context: its
 *   context sources refuse an unreadable claims setting through it, and PostgreSQL checks EXECUTE on every function of
 *   a plan as the plan starts, a branch never taken included. EXECUTE on every constant a statement it runs calls,
 *   through constants' bodies (`roleExecutes`): the CHECKs of the domains it holds USAGE on, the CHECKs and generated
 *   columns of the tables it writes or updates an owner's count in, its views' decoded columns, and every closed relation's constants, which its
 *   queries' closed reads call. TRUNCATE is granted to no one, and no role holds a privilege on a base table it does
 *   not write or own a member of.
 *
 * Row security is enabled on exactly the tables some role writes through a query entry with a filter, once their
 * policies stand, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; its owner, the migration identity, bypasses it, and FORCE
 * is never used. A role that writes a family's member and not its owner O is one of O's writers there, its membership
 * on the member translated onto O through the group and the copies (`translated`): it reads and updates exactly the
 * owners whose groups its member writes admit, and a filter that reads any other field of the member is refused, as is
 * a narrowed entry on O that is not the members' translated filter. A table every writer of which holds every row has no
 * row security and no policy: each policy would be TRUE, and the grants already decide every write (`addRowSecurity`).
 *
 * For the schema as a whole: REVOKE ALL ... FROM PUBLIC on the base schema and every role's schema, every table and
 * view, every identity sequence and every domain, and each constant in its own object, so PUBLIC holds nothing on any
 * schema object; and
 * default-privilege resets so future objects grant nothing implicitly: ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN
 * SCHEMA <schema> REVOKE ALL ON TABLES and ON SEQUENCES FROM PUBLIC, and, because PostgreSQL adds per-schema default
 * ACLs to the global ones and cannot revoke the built-in PUBLIC EXECUTE on functions and USAGE on types per schema,
 * the global ALTER DEFAULT PRIVILEGES FOR ROLE <owner> REVOKE ALL ON FUNCTIONS and ON TYPES FROM PUBLIC. */
export const addWorlds = (
	b: InstallBuilder,
	advance: AdvanceFunctions,
	revocable: Revocable,
	checkedLogins: ReadonlyArray<CheckedLogin>
): WorldsPlan => {
	const logins = [...checkedLogins].toSorted((x, y) => compareText(x.login.name, y.login.name))
	const cx = worldsContext(b)
	const roleDefaults: Array<SqlStatement> = []
	const searchDefaults: Array<SqlStatement> = []
	const worlds: Array<InstalledLogin> = []
	const views: Array<ObjectName> = []
	const writers: Array<Writer> = []
	for (const login of logins) {
		const added = addLogin(b, cx, login, advance)
		worlds.push(added.installed)
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
		publicRevokes: publicRevokes(b, {
			...revocable,
			schemas: worlds.flatMap((l) => l.roles.map((r) => r.schema)),
			views
		}),
		worlds
	}
}

/** What PUBLIC is revoked from beside the base schema: the tables with their identity sequences, and the domains, each
 * in the order the installation added them. A function's own revoke is in its object's statements. */
export interface Revocable {
	readonly tables: ReadonlyArray<ObjectName>
	readonly sequences: ReadonlyArray<ObjectName>
	readonly domains: ReadonlyArray<ObjectName>
}

/** PUBLIC holds no privilege on any schema object, and the owner's future objects grant it nothing: the base schema
 * and every role's schema, every table and role view, every identity sequence and domain. */
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
			on: { kind: "SCHEMA", names: [b.schema, ...objects.schemas] },
			from
		}
	]
	const tables = [...objects.tables, ...objects.views]
	if (isNonEmpty(tables)) {
		out.push({ kind: "revoke", privileges: ["ALL"], on: { kind: "TABLE", names: tables }, from })
	}
	const { sequences, domains } = objects
	if (isNonEmpty(sequences)) {
		out.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "SEQUENCE", names: sequences },
			from
		})
	}
	if (isNonEmpty(domains)) {
		out.push({
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "DOMAIN", names: domains },
			from
		})
	}
	/** A migration's resets are the current role's, the migration identity's; a fresh-install script a superuser runs
	 * names the owner (InstallSettings.owner). */
	const forRole = b.settings.owner
	for (const on of ["TABLES", "SEQUENCES"] as const) {
		out.push({
			kind: "alterDefaultPrivileges",
			forRole,
			inSchema: b.schema,
			privileges: ["ALL"],
			on,
			from
		})
	}
	for (const on of ["FUNCTIONS", "TYPES"] as const) {
		out.push({
			kind: "alterDefaultPrivileges",
			forRole,
			inSchema: undefined,
			privileges: ["ALL"],
			on,
			from
		})
	}
	return out
}
