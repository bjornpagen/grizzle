import { Array as Arr, Option, String as Str } from "effect"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import {
	C,
	type DefaultGrant,
	type DefaultPrivilegesExpectation,
	type ExpectedPolicy,
	privilegeFamilies,
	type PrivilegeFamily,
	privilegeFamilyNames,
	type RoleExpectation
} from "#compiler/plan/catalog.ts"
import { emitCatalog, type ParamText } from "#compiler/plan/common.ts"
import { textArrayParam, textParam } from "#compiler/plan/read.ts"

/**
 * The settings, privileges, attributes, memberships, members and policies statements the drift check runs for every login
 * and role the snapshot creates, and their comparison with what the target snapshot installs
 * (compiler/deploy/admission/roles.ts).
 *
 * Every statement is a catalog read, a catalog-read AST the engine prints (sql/catalog.ts), whose cells are never NULL.
 * The privileges statement takes the expected
 * privileges as four parallel text[] parameters (family, object, column, type) and answers only the differences:
 * PostgreSQL resolves each expected object to its OID, and a column to its number, judges what the role holds on every
 * object of the judged schemas through has_*_privilege (its own grants, PUBLIC's and every role it inherits from), a
 * column's privilege beside its table's as has_column_privilege where the table's has_table_privilege does not already
 * hold, and the two sets meet by OID. An expected object that does not resolve is a privilege the role does not hold.
 * On the current database it reads the role's own grants alone, from the database's ACL (aclexplode), each of the types
 * a database's family judges: PUBLIC's TEMPORARY, which PostgreSQL gives every database, is the database owner's, so
 * has_database_privilege would find it held by every role.
 *
 * A PostgreSQL text[] parameter of `values`, each element the text carrier's parameter text, double-quoted with its
 * backslashes and quotes escaped, so any text, an identifier among them, is one element (codec/recordset.ts
 * textArrayParam).
 */
export const textArray = (values: Iterable<string>): ParamText => textArrayParam([...values])

/** Where a role's stored setting applies: the role's own, or the role's in this database alone. */
const settingScopes = ["role", "roleInDatabase"] as const
export type SettingScope = (typeof settingScopes)[number]

export interface StoredSetting {
	readonly scope: SettingScope
	readonly parameter: string
	readonly value: string
}

const noOid = C.literal(0n, "oid")
const settingRows = C.from("pg_db_role_setting", "d")
const settingTexts = C.fromFunction(
	C.catalogCall("unnest", [settingRows.col("setconfig")]),
	"s",
	["setting"],
	true
)

/** The stored settings of the role `role` names, its own and its own in the current database, one `name=value` per row
 * with its scope. */
const settingsOf = (role: C.CatalogExpr): CatalogQuery<StoredSetting> => ({
	sql: emitCatalog(
		C.query(
			[
				C.caseWhen(
					[{ when: C.eq(settingRows.col("setdatabase"), noOid), result: C.text("role") }],
					C.text("roleInDatabase")
				),
				C.asText(settingTexts.col("setting"))
			],
			[C.crossJoin(settingRows.item, settingTexts.item)],
			C.and([
				C.eq(settingRows.col("setrole"), C.roleOid(role)),
				C.inList(settingRows.col("setdatabase"), [noOid, C.currentDatabaseOid()])
			])
		)
	),
	what: "a setting's scope and its name=value",
	row: ([scopeText, setting]) => {
		const scope = Arr.findFirst(settingScopes, (s) => s === scopeText)
		if (Option.isNone(scope) || setting === undefined) {
			return undefined
		}
		const at = Str.indexOf("=")(setting)
		return Option.isSome(at) && at.value > 0
			? {
					scope: scope.value,
					parameter: Str.slice(0, at.value)(setting),
					value: Str.slice(at.value + 1)(setting)
				}
			: undefined
	}
})

/** The stored settings of the role $1 (settingsOf): every login's and role's, which the drift check holds to the snapshot's. */
export const settingsQuery: CatalogQuery<StoredSetting> = settingsOf(C.param(1, "text"))

/**
 * The stored settings of the session's own role (settingsOf): the migration identity's, whose own
 * session_preload_libraries decides which libraries its session loads apart from every login's (adapter/migrate/apply.ts).
 */
export const ownSettingsQuery: CatalogQuery<StoredSetting> = settingsOf(C.currentUser)

/**
 * A stored setting against the expected ones of its scope: one the scope requires and lacks, one it holds and does
 * not require, or one it holds at another value.
 */
export type SettingDifference =
	| {
			readonly kind: "missing"
			readonly scope: SettingScope
			readonly parameter: string
			readonly value: string
	  }
	| {
			readonly kind: "unexpected"
			readonly scope: SettingScope
			readonly parameter: string
			readonly value: string
	  }
	| {
			readonly kind: "differs"
			readonly scope: SettingScope
			readonly parameter: string
			readonly expected: string
			readonly observed: string
	  }

/**
 * Every difference between the stored settings of `scope` and the settings it holds exactly, `settings`: one of them
 * missing or at another value, and any other one.
 */
const scopeDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	scope: SettingScope,
	settings: ReadonlyMap<string, string>
): ReadonlyArray<SettingDifference> => {
	const out: Array<SettingDifference> = []
	const have = new Map(
		Arr.map(
			Arr.filter(stored, (s) => s.scope === scope),
			(s) => [s.parameter, s.value]
		)
	)
	for (const [parameter, value] of settings) {
		const observed = have.get(parameter)
		if (observed === undefined) {
			out.push({ kind: "missing", scope, parameter, value })
		} else if (observed !== value) {
			out.push({ kind: "differs", scope, parameter, expected: value, observed })
		}
	}
	for (const [parameter, value] of have) {
		if (!settings.has(parameter)) {
			out.push({ kind: "unexpected", scope, parameter, value })
		}
	}
	return out
}

/**
 * The role's own defaults are exactly the snapshot's, and the role holds none in this database alone, which would take
 * precedence over its own at login.
 */
export const roleDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	expectation: RoleExpectation
): ReadonlyArray<SettingDifference> => [
	...scopeDifferences(stored, "role", expectation.settings),
	...scopeDifferences(stored, "roleInDatabase", new Map())
]

/** A privilege the role should hold and does not, or holds and should not. */
export interface PrivilegeDifference {
	readonly kind: "missing" | "unexpected"
	readonly family: PrivilegeFamily
	/**
	 * The object as the expectation names it (missing) or as PostgreSQL names it (unexpected), with a column
	 * privilege's column after a dot.
	 */
	readonly object: string
	/**
	 * Where the catalog holds the object: its schema and its own name, a relation's for a column's privilege, a
	 * schema's name for a schema's, and none of either for a database's, both empty.
	 */
	readonly schema: string
	readonly name: string
	readonly privilege: string
}

/** The privilege types PostgreSQL defines on a family, as a text[]. */
const typesArray = (family: PrivilegeFamily): C.CatalogExpr =>
	C.array(Arr.map(privilegeFamilies[family], C.text), "text")

/** Whether a namespace is among the judged schemas $2. */
const inJudged = (namespace: C.CatalogExpr): C.CatalogExpr => {
	const s = C.from("pg_namespace", "s")
	return C.exists(
		C.anyRow(
			[s.item],
			C.and([C.eq(s.col("oid"), namespace), C.any(s.col("nspname"), C.arrayParam(2, "text"))])
		)
	)
}

/** The grantee's oid, read from the privileges read's grantee CTE. */
const granteeOid = (): C.CatalogExpr => {
	const r = C.fromCte("grantee", "r")
	return C.scalar(C.query([r.col("oid")], [r.item], undefined))
}

/** The kinds of relation a table privilege applies to. */
const privilegedRelations = C.letters(["r", "p", "m", "v", "f"])

/** The privilege types of a family, one row each, as `p.t`. */
const typesOf = (family: PrivilegeFamily): C.CatalogSource =>
	C.fromFunction(C.catalogCall("unnest", [typesArray(family)]), "p", ["t"], false)

/**
 * Every privilege the role holds on the judged schemas $2, the other schemas $3, and each object of the judged schemas
 * of a family, as `(family, oid, column, type)`, the column empty but for a column's privilege; and each of a database's
 * family the role holds on the current database by a grant of its own (the module's header).
 */
const heldArms = (): readonly [C.CatalogCore, ...Array<C.CatalogCore>] => {
	const d = C.from("pg_database", "d")
	const x = C.fromFunction(
		C.catalogCall("aclexplode", [d.col("datacl")]),
		"x",
		["grantor", "grantee", "privilege_type", "is_grantable"],
		true
	)
	const n = C.from("pg_namespace", "n")
	const c = C.from("pg_class", "c")
	const a = C.from("pg_attribute", "a")
	const t = C.from("pg_type", "t")
	const f = C.from("pg_proc", "f")
	const k = C.from("pg_class", "k")
	const e = C.from("pg_type", "e")
	const none = C.text("")
	const schema = typesOf("schema")
	const table = typesOf("table")
	const column = typesOf("column")
	const sequence = typesOf("sequence")
	const type = typesOf("type")
	const fn = typesOf("function")
	return [
		C.catalogCore(
			[C.text("schema"), n.col("oid"), none, schema.col("t")],
			[C.crossJoin(n.item, schema.item)],
			C.and([
				C.or([
					C.any(n.col("nspname"), C.arrayParam(2, "text")),
					C.any(n.col("nspname"), C.arrayParam(3, "text"))
				]),
				C.catalogCall("has_schema_privilege", [granteeOid(), n.col("oid"), schema.col("t")])
			])
		),
		C.catalogCore(
			[C.text("table"), c.col("oid"), none, table.col("t")],
			[C.crossJoin(c.item, table.item)],
			C.and([
				inJudged(c.col("relnamespace")),
				C.inList(c.col("relkind"), privilegedRelations),
				C.catalogCall("has_table_privilege", [granteeOid(), c.col("oid"), table.col("t")])
			])
		),
		C.catalogCore(
			[C.text("column"), c.col("oid"), C.asText(a.col("attname")), column.col("t")],
			[
				C.crossJoin(
					C.join(
						c.item,
						a.item,
						C.and([
							C.eq(a.col("attrelid"), c.col("oid")),
							C.gt(a.col("attnum"), C.literal(0n, "smallint")),
							C.not(a.col("attisdropped"))
						])
					),
					column.item
				)
			],
			C.and([
				inJudged(c.col("relnamespace")),
				C.inList(c.col("relkind"), privilegedRelations),
				C.catalogCall("has_column_privilege", [
					granteeOid(),
					c.col("oid"),
					a.col("attnum"),
					column.col("t")
				]),
				C.not(C.catalogCall("has_table_privilege", [granteeOid(), c.col("oid"), column.col("t")]))
			])
		),
		C.catalogCore(
			[C.text("sequence"), c.col("oid"), none, sequence.col("t")],
			[C.crossJoin(c.item, sequence.item)],
			C.and([
				inJudged(c.col("relnamespace")),
				C.eq(c.col("relkind"), C.letter("S")),
				C.catalogCall("has_sequence_privilege", [granteeOid(), c.col("oid"), sequence.col("t")])
			])
		),
		C.catalogCore(
			[C.text("type"), t.col("oid"), none, type.col("t")],
			[C.crossJoin(t.item, type.item)],
			C.and([
				inJudged(t.col("typnamespace")),
				C.notExists(
					C.anyRow(
						[k.item],
						C.and([C.eq(k.col("oid"), t.col("typrelid")), C.ne(k.col("relkind"), C.letter("c"))])
					)
				),
				C.notExists(C.anyRow([e.item], C.eq(e.col("typarray"), t.col("oid")))),
				C.catalogCall("has_type_privilege", [granteeOid(), t.col("oid"), type.col("t")])
			])
		),
		C.catalogCore(
			[C.text("function"), f.col("oid"), none, fn.col("t")],
			[C.crossJoin(f.item, fn.item)],
			C.and([
				inJudged(f.col("pronamespace")),
				C.catalogCall("has_function_privilege", [granteeOid(), f.col("oid"), fn.col("t")])
			])
		),
		C.catalogCore(
			[C.text("database"), d.col("oid"), none, C.asText(x.col("privilege_type"))],
			[C.crossJoin(d.item, x.item)],
			C.and([
				C.eq(d.col("oid"), C.currentDatabaseOid()),
				C.eq(x.col("grantee"), granteeOid()),
				C.any(C.asText(x.col("privilege_type")), typesArray("database"))
			])
		)
	]
}

/**
 * The relation of an expected privilege `e`, found through the catalog by its schema and name, which needs no USAGE on
 * the role's schema, as a lookup by qualified name does.
 */
const relationOid = (e: C.CatalogSource): C.CatalogExpr => {
	const c = C.from("pg_class", "c")
	const n = C.from("pg_namespace", "n")
	return C.scalar(
		C.query(
			[c.col("oid")],
			[C.inNamespace(c.item, n, c.col("relnamespace"))],
			C.and([C.eq(n.col("nspname"), e.col("schema")), C.eq(c.col("relname"), e.col("name"))])
		)
	)
}

/**
 * The object an expected privilege `e` names; NULL when nothing of that name exists. A schema, a type of the installed
 * schema and a function of it resolve by their quoted qualified names, which needs no USAGE on a role's schema.
 */
const resolvedOid = (e: C.CatalogSource): C.CatalogExpr =>
	C.caseOf(
		e.col("family"),
		[
			{
				when: C.text("schema"),
				result: C.cast(C.catalogCall("to_regnamespace", [e.col("object")]), "oid")
			},
			{ when: C.text("table"), result: relationOid(e) },
			{ when: C.text("column"), result: relationOid(e) },
			{ when: C.text("sequence"), result: relationOid(e) },
			{
				when: C.text("type"),
				result: C.cast(C.catalogCall("to_regtype", [e.col("object")]), "oid")
			},
			{
				when: C.text("function"),
				result: C.cast(C.catalogCall("to_regprocedure", [e.col("object")]), "oid")
			},
			{ when: C.text("database"), result: C.currentDatabaseOid() }
		],
		undefined
	)

/** The current database's name, quoted as an identifier where it needs it, as a privilege difference names it. */
const databaseName: C.CatalogExpr = C.catalogCall("quote_ident", [
	C.asText(C.catalogCall("current_database", []))
])

/** A held object `h` as PostgreSQL names it, a column's after its relation's and a dot. */
const heldName = (h: C.CatalogSource): C.CatalogExpr => {
	const named = (type: "regnamespace" | "regtype" | "regprocedure" | "regclass"): C.CatalogExpr =>
		C.asText(C.cast(h.col("oid"), type))
	return C.caseOf(
		h.col("family"),
		[
			{ when: C.text("database"), result: databaseName },
			{ when: C.text("schema"), result: named("regnamespace") },
			{ when: C.text("type"), result: named("regtype") },
			{ when: C.text("function"), result: named("regprocedure") },
			{
				when: C.text("column"),
				result: C.concat([
					named("regclass"),
					C.text("."),
					C.catalogCall("quote_ident", [h.col("attname")])
				])
			}
		],
		named("regclass")
	)
}

/**
 * Where the catalog holds a held object `h` (PrivilegeDifference schema and name): its namespace's name, or its own,
 * by its family's catalog; a schema's own name for both; empty for the database, which lives in no schema.
 */
const heldWhere = (h: C.CatalogSource, part: "schema" | "name"): C.CatalogExpr => {
	const n = C.from("pg_namespace", "n")
	const of = (
		catalog: "pg_class" | "pg_type" | "pg_proc",
		namespace: string,
		name: string
	): C.CatalogExpr => {
		const o = C.from(catalog, "o")
		return C.scalar(
			C.query(
				[C.asText(part === "schema" ? n.col("nspname") : o.col(name))],
				[C.join(o.item, n.item, C.eq(n.col("oid"), o.col(namespace)))],
				C.eq(o.col("oid"), h.col("oid"))
			)
		)
	}
	const schema = (): C.CatalogExpr =>
		C.scalar(C.query([C.asText(n.col("nspname"))], [n.item], C.eq(n.col("oid"), h.col("oid"))))
	const relation = (): C.CatalogExpr => of("pg_class", "relnamespace", "relname")
	return C.coalesce([
		C.caseOf(
			h.col("family"),
			[
				{ when: C.text("schema"), result: schema() },
				{ when: C.text("table"), result: relation() },
				{ when: C.text("column"), result: relation() },
				{ when: C.text("sequence"), result: relation() },
				{ when: C.text("type"), result: of("pg_type", "typnamespace", "typname") },
				{ when: C.text("function"), result: of("pg_proc", "pronamespace", "proname") }
			],
			undefined
		),
		C.text("")
	])
}

/** Whether `a` and `b` name one privilege: its family, object, column and type. */
const samePrivilege = (a: C.CatalogSource, b: C.CatalogSource): C.CatalogExpr =>
	C.and([
		C.eq(a.col("family"), b.col("family")),
		C.eq(a.col("oid"), b.col("oid")),
		C.eq(a.col("attname"), b.col("attname")),
		C.eq(a.col("privilege"), b.col("privilege"))
	])

/**
 * The privileges of the role $1 on the judged schemas $2 and the other schemas $3 against the expected ones ($4
 * families, $5 objects, $6 columns, $7 types, $8 schemas, $9 names): every difference, none when they agree.
 */
const privilegesSelect = (): C.CatalogSelect => {
	const r = C.from("pg_roles", "r")
	const u = C.fromRows(
		[
			C.catalogCall("unnest", [C.arrayParam(4, "text")]),
			C.catalogCall("unnest", [C.arrayParam(5, "text")]),
			C.catalogCall("unnest", [C.arrayParam(6, "text")]),
			C.catalogCall("unnest", [C.arrayParam(7, "text")]),
			C.catalogCall("unnest", [C.arrayParam(8, "text")]),
			C.catalogCall("unnest", [C.arrayParam(9, "text")])
		],
		"u",
		["f", "o", "c", "p", "s", "n"]
	)
	const e = C.fromCte("expected", "e")
	const x = C.fromCte("resolved", "x")
	const h = C.fromCte("held", "h")
	return C.withCtes(
		[
			C.cte(
				"grantee",
				["oid"],
				C.query([r.col("oid")], [r.item], C.eq(r.col("rolname"), C.param(1, "text")))
			),
			C.cte("held", ["family", "oid", "attname", "privilege"], C.union(heldArms())),
			C.cte(
				"expected",
				["family", "object", "attname", "privilege", "schema", "name"],
				C.query(
					[u.col("f"), u.col("o"), u.col("c"), u.col("p"), u.col("s"), u.col("n")],
					[u.item],
					undefined
				)
			),
			C.cte(
				"resolved",
				["family", "object", "attname", "privilege", "oid", "schema", "name"],
				C.query(
					[
						e.col("family"),
						e.col("object"),
						e.col("attname"),
						e.col("privilege"),
						resolvedOid(e),
						e.col("schema"),
						e.col("name")
					],
					[e.item],
					undefined
				)
			)
		],
		C.union([
			C.catalogCore(
				[
					C.text("missing"),
					x.col("family"),
					C.caseOf(
						x.col("family"),
						[
							{
								when: C.text("column"),
								result: C.concat([
									x.col("object"),
									C.text("."),
									C.catalogCall("quote_ident", [x.col("attname")])
								])
							},
							{ when: C.text("database"), result: databaseName }
						],
						x.col("object")
					),
					x.col("privilege"),
					x.col("schema"),
					x.col("name")
				],
				[x.item],
				C.notExists(C.anyRow([h.item], samePrivilege(h, x)))
			),
			C.catalogCore(
				[
					C.text("unexpected"),
					h.col("family"),
					heldName(h),
					h.col("privilege"),
					heldWhere(h, "schema"),
					heldWhere(h, "name")
				],
				[h.item],
				C.notExists(C.anyRow([x.item], samePrivilege(x, h)))
			)
		])
	)
}

/** The privileges of the role $1 against the expected ones (privilegesSelect): every difference. */
export const privilegesQuery: CatalogQuery<PrivilegeDifference> = {
	sql: emitCatalog(privilegesSelect()),
	what: "a privilege difference",
	row: ([kindText, familyText, object, privilege, schema, name]) => {
		const kind =
			kindText === "missing" ? "missing" : kindText === "unexpected" ? "unexpected" : undefined
		const family = Arr.findFirst(privilegeFamilyNames, (f) => f === familyText)
		return kind === undefined ||
			Option.isNone(family) ||
			object === undefined ||
			privilege === undefined ||
			schema === undefined ||
			name === undefined
			? undefined
			: { kind, family: family.value, object, schema, name, privilege }
	}
}

/** The privileges statement's parameters for `expectation`'s role. */
export const privilegesParams = (expectation: RoleExpectation): ReadonlyArray<ParamText> => [
	textParam(expectation.role),
	textArray(expectation.schemas),
	textArray(expectation.otherSchemas),
	textArray(Arr.map(expectation.privileges, (p) => p.family)),
	textArray(Arr.map(expectation.privileges, (p) => p.object)),
	textArray(Arr.map(expectation.privileges, (p) => p.column)),
	textArray(Arr.map(expectation.privileges, (p) => p.privilege)),
	textArray(Arr.map(expectation.privileges, (p) => p.schema)),
	textArray(Arr.map(expectation.privileges, (p) => p.name))
]

/**
 * One side of a membership, over every pg_auth_members row of the pair (PostgreSQL keeps one per grantor, so a second
 * grant can add an option the first lacks): the other role, and whether any row inherits, lets the member SET ROLE, or
 * grants ADMIN.
 */
interface HeldGrant {
	readonly role: string
	readonly inherit: boolean
	readonly set: boolean
	readonly admin: boolean
}

const flag = (text: string | undefined): boolean | undefined =>
	text === "true" ? true : text === "false" ? false : undefined

const grantRow = ([role, inherit, set, admin]: ReadonlyArray<string>): HeldGrant | undefined => {
	const i = flag(inherit)
	const st = flag(set)
	const a = flag(admin)
	return role === undefined || i === undefined || st === undefined || a === undefined
		? undefined
		: { role, inherit: i, set: st, admin: a }
}

const members = C.from("pg_auth_members", "m")

/** The other role of a pair, by its name, then the options of the pair's every row, aggregated. */
const grantTargets = (
	other: C.CatalogSource
): readonly [C.CatalogExpr, ...Array<C.CatalogExpr>] => [
	C.asText(other.col("rolname")),
	C.asText(C.catalogCall("bool_or", [members.col("inherit_option")])),
	C.asText(C.catalogCall("bool_or", [members.col("set_option")])),
	C.asText(C.catalogCall("bool_or", [members.col("admin_option")]))
]

const granted = C.from("pg_roles", "g")

/** The roles the role $1 is granted, each with its options over every grant. */
export const membershipsQuery: CatalogQuery<HeldGrant> = {
	sql: emitCatalog(
		C.select({
			...C.catalogCore(
				grantTargets(granted),
				[C.join(members.item, granted.item, C.eq(granted.col("oid"), members.col("roleid")))],
				C.eq(members.col("member"), C.roleOid(C.param(1, "text")))
			),
			groupBy: [granted.col("rolname")]
		})
	),
	what: "a granted role and its options over every grant",
	row: grantRow
}

const member = C.from("pg_roles", "u")

/** The owner of the schema named by `name`, NULL when there is none. */
const schemaOwnerOid = (name: C.CatalogExpr): C.CatalogExpr => {
	const n = C.from("pg_namespace", "n")
	return C.scalar(C.query([n.col("nspowner")], [n.item], C.eq(n.col("nspname"), name)))
}

/**
 * The roles granted the role $1, each with its options over every grant, the owner of the schema $2 aside: when a
 * non-superuser creates a role, PostgreSQL grants the role to its creator WITH ADMIN (and with INHERIT and SET as
 * createrole_self_grant says), and the migration identity that created every login and role of the installation owns
 * every object of it already, so its membership opens nothing.
 */
export const membersQuery: CatalogQuery<HeldGrant> = {
	sql: emitCatalog(
		C.select({
			...C.catalogCore(
				grantTargets(member),
				[C.join(members.item, member.item, C.eq(member.col("oid"), members.col("member")))],
				C.and([
					C.eq(members.col("roleid"), C.roleOid(C.param(1, "text"))),
					C.distinctFrom(members.col("member"), schemaOwnerOid(C.param(2, "text")))
				])
			),
			groupBy: [member.col("rolname")]
		})
	),
	what: "a member and its options over every grant",
	row: grantRow
}

/** A membership or a member the role should have and lacks, holds with other options, or holds and should not. */
export interface MembershipDifference {
	readonly kind: "missing" | "options" | "unexpected"
	readonly role: string
}

/** Whether a grant is held exactly WITH INHERIT FALSE, SET TRUE and no ADMIN, as a login holds its roles. */
const exact = (g: HeldGrant): boolean => !g.inherit && g.set && !g.admin

const grantDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expected: ReadonlyArray<string>,
	tolerated: (g: HeldGrant) => boolean
): ReadonlyArray<MembershipDifference> => {
	const out: Array<MembershipDifference> = []
	for (const role of expected) {
		const found = Arr.findFirst(held, (h) => h.role === role)
		if (Option.isNone(found)) {
			out.push({ kind: "missing", role })
		} else if (!exact(found.value)) {
			out.push({ kind: "options", role })
		}
	}
	for (const h of held) {
		if (!expected.includes(h.role) && !tolerated(h)) {
			out.push({ kind: "unexpected", role: h.role })
		}
	}
	return out
}

/**
 * The role's memberships against the expected ones (compiler/deploy/admission/roles.ts). A role granted beyond them is
 * tolerated WITH SET FALSE and no ADMIN, which opens no SET ROLE path: what it passes on by inheritance the privileges
 * judge, so a role holding nothing in the installation, as the `rds_iam` an RDS IAM login authenticates by, may be
 * inherited, and one passing on any privilege or ownership there is refused by them.
 */
export const membershipDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expectation: RoleExpectation
): ReadonlyArray<MembershipDifference> =>
	grantDifferences(held, expectation.memberships, (g) => !g.set && !g.admin)

/**
 * The role's members against the expected ones: a theory role's login, a login's none. A member beyond them is
 * tolerated WITH INHERIT FALSE, SET FALSE and no ADMIN, so nothing but the login acts through the role; the migration
 * identity's membership is not read (membersQuery).
 */
export const memberDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expectation: RoleExpectation
): ReadonlyArray<MembershipDifference> =>
	grantDifferences(held, expectation.members, (g) => !g.inherit && !g.set && !g.admin)

/** A role's attributes as pg_roles holds them. */
interface RoleAttributes {
	readonly login: boolean
	readonly inherit: boolean
	readonly superuser: boolean
	readonly createDb: boolean
	readonly createRole: boolean
	readonly replication: boolean
	readonly bypassRls: boolean
}

const roles = C.from("pg_roles", "r")

/** The attributes of the role $1: one row, none when it does not exist. */
export const attributesQuery: CatalogQuery<RoleAttributes> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(roles.col("rolcanlogin")),
				C.asText(roles.col("rolinherit")),
				C.asText(roles.col("rolsuper")),
				C.asText(roles.col("rolcreatedb")),
				C.asText(roles.col("rolcreaterole")),
				C.asText(C.holdsReplicationRight(roles)),
				C.asText(roles.col("rolbypassrls"))
			],
			[roles.item],
			C.eq(roles.col("rolname"), C.param(1, "text"))
		)
	),
	what: "a role's attributes",
	row: (cells) => {
		const [login, inherit, superuser, createDb, createRole, replication, bypassRls] = Arr.map(
			cells,
			flag
		)
		return login === undefined ||
			inherit === undefined ||
			superuser === undefined ||
			createDb === undefined ||
			createRole === undefined ||
			replication === undefined ||
			bypassRls === undefined
			? undefined
			: { login, inherit, superuser, createDb, createRole, replication, bypassRls }
	}
}

/**
 * An attribute the role holds otherwise than the snapshot installs it, by its CREATE ROLE spelling: a login is LOGIN
 * NOINHERIT, a theory role NOLOGIN, and neither is SUPERUSER, CREATEDB, CREATEROLE or BYPASSRLS; only the decoder
 * login holds the replication right (RoleExpectation replication), the REPLICATION attribute or, on Amazon RDS, a
 * membership in rds_replication, which grants it there.
 */
export interface AttributeDifference {
	readonly attribute: string
	readonly expected: string
	readonly observed: string
}

export const attributeDifferences = (
	held: ReadonlyArray<RoleAttributes>,
	expectation: RoleExpectation
): ReadonlyArray<AttributeDifference> => {
	const [a] = held
	if (a === undefined) {
		return [{ attribute: "existence", expected: "the role exists", observed: "no such role" }]
	}
	const out: Array<AttributeDifference> = []
	const want = (attribute: string, value: boolean, expected: boolean) => {
		if (value !== expected) {
			out.push({
				attribute,
				expected: expected ? attribute : `NO${attribute}`,
				observed: value ? attribute : `NO${attribute}`
			})
		}
	}
	want("LOGIN", a.login, expectation.login)
	if (expectation.login) {
		want("INHERIT", a.inherit, false)
	}
	want("SUPERUSER", a.superuser, false)
	want("CREATEDB", a.createDb, false)
	want("CREATEROLE", a.createRole, false)
	want("REPLICATION", a.replication, expectation.replication)
	want("BYPASSRLS", a.bypassRls, false)
	return out
}

const classes = C.from("pg_class", "c")
const namespaces = C.from("pg_namespace", "n")
const policies = C.from("pg_policy", "p")

/** The policies naming the role $1 on the tables of the installation's level schemas $2 (text[]), each by its table and
 * name. */
export const policiesQuery: CatalogQuery<ExpectedPolicy> = {
	sql: emitCatalog(
		C.query(
			[C.asText(classes.col("relname")), C.asText(policies.col("polname"))],
			[
				C.inNamespace(
					C.join(policies.item, classes.item, C.eq(classes.col("oid"), policies.col("polrelid"))),
					namespaces,
					classes.col("relnamespace")
				)
			],
			C.and([
				C.any(C.asText(namespaces.col("nspname")), C.arrayParam(2, "text")),
				C.any(C.roleOid(C.param(1, "text")), policies.col("polroles"))
			])
		)
	),
	what: "a policy's table and name",
	row: ([table, name]) => (table === undefined || name === undefined ? undefined : { table, name })
}

/** A policy naming the role that the snapshot installs and the database lacks, or holds and the snapshot does not. */
export interface PolicyDifference {
	readonly kind: "missing" | "unexpected"
	readonly policy: ExpectedPolicy
}

const samePolicy = (a: ExpectedPolicy, b: ExpectedPolicy): boolean =>
	a.table === b.table && a.name === b.name

export const policyDifferences = (
	held: ReadonlyArray<ExpectedPolicy>,
	expectation: RoleExpectation
): ReadonlyArray<PolicyDifference> => [
	...Arr.map(
		Arr.filter(expectation.policies, (p) => !Arr.some(held, (h) => samePolicy(h, p))),
		(policy): PolicyDifference => ({ kind: "missing", policy })
	),
	...Arr.map(
		Arr.filter(held, (h) => !Arr.some(expectation.policies, (p) => samePolicy(h, p))),
		(policy): PolicyDifference => ({ kind: "unexpected", policy })
	)
]

/** pg_default_acl's letter of each kind of object a default privilege applies to. */
const defaultObjectLetters = ["r", "S", "f", "T", "n", "L"] as const

type DefaultObjects = (typeof defaultObjectLetters)[number]

/** Each kind's name in a drift fact. */
const defaultObjects: Readonly<Record<DefaultObjects, string>> = {
	r: "tables",
	S: "sequences",
	f: "functions",
	T: "types",
	n: "schemas",
	L: "large objects"
}

/** A default privilege of the owner's future objects, as the catalog holds it: its scope, kind, grantee and privilege. */
export interface StoredDefaultGrant {
	readonly scope: DefaultGrant["scope"]
	readonly objects: DefaultObjects
	/** `PUBLIC`, or the grantee's name. */
	readonly grantee: string
	readonly privilege: string
}

/** pg_default_acl's letter of each kind ALTER DEFAULT PRIVILEGES names. */
const defaultObjectLetter: Readonly<Record<DefaultGrant["on"], DefaultObjects>> = {
	TABLES: "r",
	SEQUENCES: "S",
	FUNCTIONS: "f",
	TYPES: "T"
}

/**
 * The owner's default privileges granted to anyone but the owner, the owner the current role, the migration identity,
 * and the installation's schemas the one parameter (as text[]): in every schema, its global entry of each kind or,
 * for functions and types, PostgreSQL's own defaults where it has none (acldefault; the other kinds' grant nobody else
 * anything); in each schema, the entries that add to those.
 */
export const defaultPrivilegesQuery = (): CatalogQuery<StoredDefaultGrant> => {
	const owner = C.currentUser
	const schemas = C.arrayParam(1, "text")
	const r = C.from("pg_roles", "r")
	const o = C.fromCte("o", "o")
	const d = C.from("pg_default_acl", "d")
	const n = C.from("pg_namespace", "n")
	const t = C.fromValues([[C.letter("f")], [C.letter("T")]], "t", ["k"])
	const a = C.fromCte("acls", "a")
	const x = C.fromFunction(
		C.catalogCall("aclexplode", [a.col("acl")]),
		"x",
		["grantor", "grantee", "privilege_type", "is_grantable"],
		true
	)
	const global = C.eq(d.col("defaclnamespace"), noOid)
	const owned = C.eq(d.col("defaclrole"), o.col("oid"))
	return {
		sql: emitCatalog(
			C.withCtes(
				[
					C.cte("o", ["oid"], C.query([r.col("oid")], [r.item], C.eq(r.col("rolname"), owner))),
					C.cte(
						"acls",
						["scope", "objects", "acl"],
						C.union([
							C.catalogCore(
								[
									C.text(""),
									t.col("k"),
									C.coalesce([
										C.scalar(
											C.query(
												[d.col("defaclacl")],
												[d.item],
												C.and([owned, global, C.eq(d.col("defaclobjtype"), t.col("k"))])
											)
										),
										C.catalogCall("acldefault", [t.col("k"), o.col("oid")])
									])
								],
								[C.crossJoin(o.item, t.item)],
								undefined
							),
							C.catalogCore(
								[C.text(""), d.col("defaclobjtype"), d.col("defaclacl")],
								[C.join(d.item, o.item, owned)],
								C.and([global, C.notInList(d.col("defaclobjtype"), C.letters(["f", "T"]))])
							),
							C.catalogCore(
								[C.asText(n.col("nspname")), d.col("defaclobjtype"), d.col("defaclacl")],
								[
									C.join(
										C.join(d.item, o.item, owned),
										n.item,
										C.eq(n.col("oid"), d.col("defaclnamespace"))
									)
								],
								C.any(C.asText(n.col("nspname")), schemas)
							)
						])
					)
				],
				C.query(
					[
						a.col("scope"),
						C.asText(a.col("objects")),
						C.caseWhen(
							[{ when: C.eq(x.col("grantee"), noOid), result: C.text("PUBLIC") }],
							C.asText(C.catalogCall("pg_get_userbyid", [x.col("grantee")]))
						),
						C.asText(x.col("privilege_type"))
					],
					[C.crossJoin(C.crossJoin(a.item, x.item), o.item)],
					C.ne(x.col("grantee"), o.col("oid"))
				)
			)
		),
		what: "a default privilege's scope, kind, grantee and privilege",
		row: ([scope, letter, grantee, privilege]) => {
			if (
				scope === undefined ||
				letter === undefined ||
				grantee === undefined ||
				privilege === undefined
			) {
				return undefined
			}
			const objects = Arr.findFirst(defaultObjectLetters, (k) => k === letter)
			return Option.isSome(objects)
				? {
						scope: scope === "" ? { kind: "everywhere" } : { kind: "schema", schema: scope },
						objects: objects.value,
						grantee,
						privilege
					}
				: undefined
		}
	}
}

/** The default privileges statement's parameters: the schemas. */
export const defaultPrivilegesParams = (
	expectation: DefaultPrivilegesExpectation
): ReadonlyArray<ParamText> => [textArray(expectation.schemas)]

/** A default privilege the snapshot leaves and the catalog lacks, or one the catalog holds that it does not leave. */
export interface DefaultPrivilegeDifference {
	readonly kind: "missing" | "unexpected"
	/** The grant as a drift fact names it: `<privilege> on <kind> to <grantee> in <scope>`. */
	readonly grant: string
}

const storedOf = (g: DefaultGrant): StoredDefaultGrant => ({
	scope: g.scope,
	objects: defaultObjectLetter[g.on],
	grantee: g.grantee.kind === "PUBLIC" ? "PUBLIC" : g.grantee.name,
	privilege: g.privilege
})

const grantText = (g: StoredDefaultGrant): string =>
	`${g.privilege} on ${defaultObjects[g.objects]} to ${g.grantee} ${g.scope.kind === "everywhere" ? "in every schema" : `in schema ${g.scope.schema}`}`

/** The owner's stored default privileges against those the snapshot leaves (DefaultPrivilegesExpectation.left). */
export const defaultPrivilegeDifferences = (
	stored: ReadonlyArray<StoredDefaultGrant>,
	expectation: DefaultPrivilegesExpectation
): ReadonlyArray<DefaultPrivilegeDifference> => {
	const held = new Set(Arr.map(stored, grantText))
	const left = new Set(Arr.map(expectation.left, (g) => grantText(storedOf(g))))
	return [
		...Arr.flatMap([...left], (g): ReadonlyArray<DefaultPrivilegeDifference> =>
			held.has(g) ? [] : [{ kind: "missing", grant: g }]
		),
		...Arr.flatMap([...held], (g): ReadonlyArray<DefaultPrivilegeDifference> =>
			left.has(g) ? [] : [{ kind: "unexpected", grant: g }]
		)
	]
}
