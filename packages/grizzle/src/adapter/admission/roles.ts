import { Array as Arr, Option, pipe, String as Str } from "effect"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import {
	C,
	databaseSettings,
	type DefaultGrant,
	type DefaultPrivilegesExpectation,
	type ExpectedPolicy,
	privilegeFamilies,
	type PrivilegeFamily,
	privilegeFamilyNames,
	type RoleExpectation
} from "#compiler/plan/catalog.ts"
import { emitCatalog } from "#compiler/plan/common.ts"

/**
 * The settings, privileges, attributes, memberships, members, policies and row security statements both admissions
 * run, and their comparison with what the target snapshot installs (compiler/deploy/admission/roles.ts): Db.open's for
 * the opened role and its login, the drift check's for every login and role the snapshot creates.
 *
 * Every statement is a catalog read, a catalog-read AST the engine prints (sql/catalog.ts), whose cells are never NULL.
 * The privileges statement takes the expected
 * privileges as four parallel text[] parameters (family, object, column, type) and answers only the differences:
 * PostgreSQL resolves each expected object to its OID, and a column to its number, judges what the role holds on every
 * object of the judged schemas through has_*_privilege (its own grants, PUBLIC's and every role it inherits from), a
 * column's privilege beside its table's as has_column_privilege where the table's has_table_privilege does not already
 * hold, and the two sets meet by OID. An expected object that does not resolve is a privilege the role does not hold.
 *
 * A PostgreSQL text[] literal of `values`, each element double-quoted with its backslashes and quotes escaped, so any
 * text, an identifier among them, is one element: the adapter's one text[] encoder.
 */
export const textArray = (values: Iterable<string>): string =>
	`{${Arr.join(
		Arr.map(
			[...values],
			(v) => `"${pipe(Str.replaceAll("\\", "\\\\")(v), Str.replaceAll('"', '\\"'))}"`
		),
		","
	)}}`

/** Where a stored setting applies: the database's own default, the role's own, or the role's in this database alone. */
const settingScopes = ["database", "role", "roleInDatabase"] as const
export type SettingScope = (typeof settingScopes)[number]

interface StoredSetting {
	readonly scope: SettingScope
	readonly parameter: string
	readonly value: string
}

const noOid = C.literal(0n, "oid")
const settingRows = C.from("pg_db_role_setting", "d")
const settingTexts = C.fromFunction(
	C.call("unnest", [settingRows.col("setconfig")]),
	"s",
	["setting"],
	true
)

/** The stored settings `which` selects, one `name=value` per row with its scope. */
const storedSettings = (which: C.CatalogExpr): CatalogQuery<StoredSetting> => ({
	sql: emitCatalog(
		C.query(
			[
				C.caseWhen(
					[
						{ when: C.eq(settingRows.col("setrole"), noOid), result: C.text("database") },
						{ when: C.eq(settingRows.col("setdatabase"), noOid), result: C.text("role") }
					],
					C.text("roleInDatabase")
				),
				C.asText(settingTexts.col("setting"))
			],
			[C.crossJoin(settingRows.item, settingTexts.item)],
			which
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

const ofDatabase = C.and([
	C.eq(settingRows.col("setrole"), noOid),
	C.eq(settingRows.col("setdatabase"), C.currentDatabaseOid())
])

/** The stored settings of the current database. */
export const databaseSettingsQuery: CatalogQuery<StoredSetting> = storedSettings(ofDatabase)

/** The stored settings of the current database and of the role $1. */
export const settingsQuery: CatalogQuery<StoredSetting> = storedSettings(
	C.or([
		ofDatabase,
		C.and([
			C.eq(settingRows.col("setrole"), C.roleOid(C.param(1, "text"))),
			C.inList(settingRows.col("setdatabase"), [noOid, C.currentDatabaseOid()])
		])
	])
)

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

/** What a scope requires: its settings, and whether it holds exactly those or holds them among others. */
interface ScopeRequirement {
	readonly settings: ReadonlyMap<string, string>
	readonly holds: "exactly" | "among others"
}

/**
 * Every difference between the stored settings of `scope` and what it requires: a required setting missing or at
 * another value, and in a scope that holds exactly its settings, any other one.
 */
const scopeDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	scope: SettingScope,
	want: ScopeRequirement
): ReadonlyArray<SettingDifference> => {
	const out: Array<SettingDifference> = []
	const have = new Map(
		Arr.map(
			Arr.filter(stored, (s) => s.scope === scope),
			(s) => [s.parameter, s.value]
		)
	)
	for (const [parameter, value] of want.settings) {
		const observed = have.get(parameter)
		if (observed === undefined) {
			out.push({ kind: "missing", scope, parameter, value })
		} else if (observed !== value) {
			out.push({ kind: "differs", scope, parameter, expected: value, observed })
		}
	}
	if (want.holds === "exactly") {
		for (const [parameter, value] of have) {
			if (!want.settings.has(parameter)) {
				out.push({ kind: "unexpected", scope, parameter, value })
			}
		}
	}
	return out
}

/**
 * The database holds the installation's defaults among others: its other defaults, a deadlock_timeout or a
 * statement_timeout, are the database owner's, which neither check judges. A fact of the database, judged once
 * whatever roles the snapshot creates.
 */
export const databaseDifferences = (
	stored: ReadonlyArray<StoredSetting>
): ReadonlyArray<SettingDifference> =>
	scopeDifferences(stored, "database", { settings: databaseSettings, holds: "among others" })

/**
 * The role's own defaults are exactly the snapshot's, and the role holds none in this database alone, which would take
 * precedence over its own at login.
 */
export const roleDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	expectation: RoleExpectation
): ReadonlyArray<SettingDifference> => [
	...scopeDifferences(stored, "role", { settings: expectation.settings, holds: "exactly" }),
	...scopeDifferences(stored, "roleInDatabase", { settings: new Map(), holds: "exactly" })
]

/** Every difference in every scope Db.open judges for `expectation`'s role: the database's and the role's. */
export const settingDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	expectation: RoleExpectation
): ReadonlyArray<SettingDifference> => [
	...databaseDifferences(stored),
	...roleDifferences(stored, expectation)
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
	C.fromFunction(C.call("unnest", [typesArray(family)]), "p", ["t"], false)

/**
 * Every privilege the role holds on the judged schemas $2, the other schemas $3, and each object of the judged schemas
 * of a family, as `(family, oid, column, type)`, the column empty but for a column's privilege.
 */
const heldArms = (): readonly [C.CatalogCore, ...Array<C.CatalogCore>] => {
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
		C.core(
			[C.text("schema"), n.col("oid"), none, schema.col("t")],
			[C.crossJoin(n.item, schema.item)],
			C.and([
				C.or([
					C.any(n.col("nspname"), C.arrayParam(2, "text")),
					C.any(n.col("nspname"), C.arrayParam(3, "text"))
				]),
				C.call("has_schema_privilege", [granteeOid(), n.col("oid"), schema.col("t")])
			])
		),
		C.core(
			[C.text("table"), c.col("oid"), none, table.col("t")],
			[C.crossJoin(c.item, table.item)],
			C.and([
				inJudged(c.col("relnamespace")),
				C.inList(c.col("relkind"), privilegedRelations),
				C.call("has_table_privilege", [granteeOid(), c.col("oid"), table.col("t")])
			])
		),
		C.core(
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
				C.call("has_column_privilege", [
					granteeOid(),
					c.col("oid"),
					a.col("attnum"),
					column.col("t")
				]),
				C.not(C.call("has_table_privilege", [granteeOid(), c.col("oid"), column.col("t")]))
			])
		),
		C.core(
			[C.text("sequence"), c.col("oid"), none, sequence.col("t")],
			[C.crossJoin(c.item, sequence.item)],
			C.and([
				inJudged(c.col("relnamespace")),
				C.eq(c.col("relkind"), C.letter("S")),
				C.call("has_sequence_privilege", [granteeOid(), c.col("oid"), sequence.col("t")])
			])
		),
		C.core(
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
				C.call("has_type_privilege", [granteeOid(), t.col("oid"), type.col("t")])
			])
		),
		C.core(
			[C.text("function"), f.col("oid"), none, fn.col("t")],
			[C.crossJoin(f.item, fn.item)],
			C.and([
				inJudged(f.col("pronamespace")),
				C.call("has_function_privilege", [granteeOid(), f.col("oid"), fn.col("t")])
			])
		)
	]
}

/**
 * The relation of an expected privilege `e`, found through the catalog by its schema and name: admission reads a role's
 * privileges as its login, which holds no USAGE on the role's schema, where a lookup by qualified name is refused.
 */
const relationOid = (e: C.CatalogSource): C.CatalogExpr => {
	const c = C.from("pg_class", "c")
	const n = C.from("pg_namespace", "n")
	return C.scalar(
		C.query(
			[c.col("oid")],
			[C.join(c.item, n.item, C.eq(n.col("oid"), c.col("relnamespace")))],
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
				result: C.cast(C.call("to_regnamespace", [e.col("object")]), "oid")
			},
			{ when: C.text("table"), result: relationOid(e) },
			{ when: C.text("column"), result: relationOid(e) },
			{ when: C.text("sequence"), result: relationOid(e) },
			{ when: C.text("type"), result: C.cast(C.call("to_regtype", [e.col("object")]), "oid") },
			{
				when: C.text("function"),
				result: C.cast(C.call("to_regprocedure", [e.col("object")]), "oid")
			}
		],
		undefined
	)

/** A held object `h` as PostgreSQL names it, a column's after its relation's and a dot. */
const heldName = (h: C.CatalogSource): C.CatalogExpr => {
	const named = (type: "regnamespace" | "regtype" | "regprocedure" | "regclass"): C.CatalogExpr =>
		C.asText(C.cast(h.col("oid"), type))
	return C.caseOf(
		h.col("family"),
		[
			{ when: C.text("schema"), result: named("regnamespace") },
			{ when: C.text("type"), result: named("regtype") },
			{ when: C.text("function"), result: named("regprocedure") },
			{
				when: C.text("column"),
				result: C.concat([
					named("regclass"),
					C.text("."),
					C.call("quote_ident", [h.col("attname")])
				])
			}
		],
		named("regclass")
	)
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
			C.call("unnest", [C.arrayParam(4, "text")]),
			C.call("unnest", [C.arrayParam(5, "text")]),
			C.call("unnest", [C.arrayParam(6, "text")]),
			C.call("unnest", [C.arrayParam(7, "text")]),
			C.call("unnest", [C.arrayParam(8, "text")]),
			C.call("unnest", [C.arrayParam(9, "text")])
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
				["family", "object", "attname", "privilege", "oid"],
				C.query(
					[e.col("family"), e.col("object"), e.col("attname"), e.col("privilege"), resolvedOid(e)],
					[e.item],
					undefined
				)
			)
		],
		C.union([
			C.core(
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
									C.call("quote_ident", [x.col("attname")])
								])
							}
						],
						x.col("object")
					),
					x.col("privilege")
				],
				[x.item],
				C.notExists(C.anyRow([h.item], samePrivilege(h, x)))
			),
			C.core(
				[C.text("unexpected"), h.col("family"), heldName(h), h.col("privilege")],
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
	row: ([kindText, familyText, object, privilege]) => {
		const kind =
			kindText === "missing" ? "missing" : kindText === "unexpected" ? "unexpected" : undefined
		const family = Arr.findFirst(privilegeFamilyNames, (f) => f === familyText)
		return kind === undefined ||
			Option.isNone(family) ||
			object === undefined ||
			privilege === undefined
			? undefined
			: { kind, family: family.value, object, privilege }
	}
}

/** The privileges statement's parameters for `expectation`'s role. */
export const privilegesParams = (expectation: RoleExpectation): ReadonlyArray<string> => [
	expectation.role,
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
	C.asText(C.call("bool_or", [members.col("inherit_option")])),
	C.asText(C.call("bool_or", [members.col("set_option")])),
	C.asText(C.call("bool_or", [members.col("admin_option")]))
]

const granted = C.from("pg_roles", "g")

/** The roles the role $1 is granted, each with its options over every grant. */
export const membershipsQuery: CatalogQuery<HeldGrant> = {
	sql: emitCatalog(
		C.select({
			...C.core(
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
			...C.core(
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
				C.asText(roles.col("rolreplication")),
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
 * NOINHERIT, a theory role NOLOGIN, and neither is SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS.
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
	want("REPLICATION", a.replication, false)
	want("BYPASSRLS", a.bypassRls, false)
	return out
}

/**
 * Row security of the tables $2 of the installed schema $1: each table that exists, whether row security is enabled
 * and whether it is forced.
 */
interface TableSecurity {
	readonly table: string
	readonly enabled: boolean
	readonly forced: boolean
}

const classes = C.from("pg_class", "c")
const namespaces = C.from("pg_namespace", "n")
const classesInSchemas = C.join(
	classes.item,
	namespaces.item,
	C.eq(namespaces.col("oid"), classes.col("relnamespace"))
)

export const rowSecurityQuery: CatalogQuery<TableSecurity> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(classes.col("relname")),
				C.asText(classes.col("relrowsecurity")),
				C.asText(classes.col("relforcerowsecurity"))
			],
			[classesInSchemas],
			C.and([
				C.eq(namespaces.col("nspname"), C.param(1, "text")),
				C.any(classes.col("relname"), C.arrayParam(2, "text"))
			])
		)
	),
	what: "a table's row security",
	row: ([table, enabled, forced]) => {
		const e = flag(enabled)
		const f = flag(forced)
		return table === undefined || e === undefined || f === undefined
			? undefined
			: { table, enabled: e, forced: f }
	}
}

/**
 * Each table the role writes through a query entry whose row security is not enabled, or forced, or that is missing.
 */
export const rowSecurityDifferences = (
	held: ReadonlyArray<TableSecurity>,
	expectation: RoleExpectation
): ReadonlyArray<{ readonly table: string; readonly observed: string }> =>
	Arr.flatMap(expectation.secured, (table) => {
		const t = Arr.findFirst(held, (h) => h.table === table)
		const observed = Option.isNone(t)
			? Option.some("no such table")
			: !t.value.enabled
				? Option.some("disabled")
				: t.value.forced
					? Option.some("forced")
					: Option.none()
		return Option.isNone(observed) ? [] : [{ table, observed: observed.value }]
	})

const policies = C.from("pg_policy", "p")

/** The policies naming the role $1 on the tables of the installed schema $2, each by its table and name. */
export const policiesQuery: CatalogQuery<ExpectedPolicy> = {
	sql: emitCatalog(
		C.query(
			[C.asText(classes.col("relname")), C.asText(policies.col("polname"))],
			[
				C.join(
					C.join(policies.item, classes.item, C.eq(classes.col("oid"), policies.col("polrelid"))),
					namespaces.item,
					C.eq(namespaces.col("oid"), classes.col("relnamespace"))
				)
			],
			C.and([
				C.eq(namespaces.col("nspname"), C.param(2, "text")),
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
 * The owner's default privileges granted to anyone but the owner, the installation's schemas the last parameter (as
 * text[]) and the owner, when the snapshot names one, the first: in every schema, its global entry of each kind or,
 * for functions and types, PostgreSQL's own defaults where it has none (acldefault; the other kinds' grant nobody else
 * anything); in each schema, the entries that add to those.
 */
export const defaultPrivilegesQuery = (
	expectation: DefaultPrivilegesExpectation
): CatalogQuery<StoredDefaultGrant> => {
	const [owner, schemas] =
		expectation.owner.kind === "named"
			? ([C.param(1, "text"), C.arrayParam(2, "text")] as const)
			: ([C.currentUser, C.arrayParam(1, "text")] as const)
	const r = C.from("pg_roles", "r")
	const o = C.fromCte("o", "o")
	const d = C.from("pg_default_acl", "d")
	const n = C.from("pg_namespace", "n")
	const t = C.fromValues([[C.letter("f")], [C.letter("T")]], "t", ["k"])
	const a = C.fromCte("acls", "a")
	const x = C.fromFunction(
		C.call("aclexplode", [a.col("acl")]),
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
							C.core(
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
										C.call("acldefault", [t.col("k"), o.col("oid")])
									])
								],
								[C.crossJoin(o.item, t.item)],
								undefined
							),
							C.core(
								[C.text(""), d.col("defaclobjtype"), d.col("defaclacl")],
								[C.join(d.item, o.item, owned)],
								C.and([global, C.notInList(d.col("defaclobjtype"), C.letters(["f", "T"]))])
							),
							C.core(
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
							C.asText(C.call("pg_get_userbyid", [x.col("grantee")]))
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

/** The default privileges statement's parameters: the owner the snapshot names, if any, then the schemas. */
export const defaultPrivilegesParams = (
	expectation: DefaultPrivilegesExpectation
): ReadonlyArray<string> => [
	...(expectation.owner.kind === "named" ? [expectation.owner.role] : []),
	textArray(expectation.schemas)
]

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
