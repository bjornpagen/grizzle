import { Array as Arr, Effect, Order, pipe, Result, String as Str } from "effect"
import {
	attributeDifferences,
	attributesQuery,
	databaseDifferences,
	databaseSettingsQuery,
	defaultPrivilegeDifferences,
	defaultPrivilegesParams,
	defaultPrivilegesQuery,
	type MembershipDifference,
	memberDifferences,
	membershipDifferences,
	membershipsQuery,
	membersQuery,
	type PrivilegeDifference,
	policiesQuery,
	policyDifferences,
	privilegesParams,
	privilegesQuery,
	roleDifferences,
	type SettingDifference,
	settingsQuery,
	textArray
} from "#adapter/admission/roles.ts"
import { toResult } from "#adapter/engine.ts"
import type { CatalogRowRefused } from "#adapter/errors/failures.ts"
import type { BatchOutcome, BatchStatement, Flight, Uncommitting } from "#adapter/wire/batch.ts"
import { type CatalogQuery, catalogRow, catalogRows, outcomeRows } from "#adapter/wire/statement.ts"
import {
	type AstHooks,
	C,
	defaultPrivilegesExpectations,
	emptyNameMap,
	identityHooks,
	judgedSchemas,
	manifestRoles,
	type ManifestStatement,
	manifestStatements,
	roleExpectation,
	transformCreateIndex,
	transformStatement
} from "#compiler/plan/catalog.ts"
import {
	type CompileError,
	emit,
	emitCatalog,
	type EmittedText,
	nominal,
	type NonEmptyReadonlyArray,
	type ParamText,
	quoteIdent,
	sha256Hex,
	type SqlStatement,
	type TypeSchema
} from "#compiler/plan/common.ts"
import type { DeploySnapshot, LedgerState } from "#compiler/plan/migration.ts"
import { textParam } from "#compiler/plan/read.ts"

/**
 * The drift check: the installed schema against the target snapshot, judged by PostgreSQL, after `grizzle migrate`.
 *
 * A hand-edited migration may change how a state is reached, never the state: edits are allowed, drift is not. The
 * apply runner runs this check after every apply, also when nothing was pending, so `grizzle migrate` on an up-to-date
 * database is the drift check of a deployed one.
 *
 * What an object is, PostgreSQL alone spells. In one transaction that the runner rolls back (driftTransaction), the
 * check creates a scratch schema for the installed schema and for each role's schema, replays into them the manifest's
 * object statements with each installed schema renamed to its scratch one (no role, membership, grant, default
 * privilege, database default, extension or query runs there; a policy names its installed role), and reads each pair
 * of schemas through one description statement: every relation, column, constraint, domain constraint, type,
 * function, trigger, statistics object, row security policy and rewrite rule, each keyed by its kind and its names
 * (quote_ident, so a key is injective) and described by PostgreSQL's own deparse (pg_get_constraintdef,
 * pg_get_indexdef, pg_get_functiondef, pg_get_triggerdef, pg_get_viewdef, pg_get_statisticsobjdef, pg_get_expr and
 * format_type) with its owner and its state: an index not valid, a trigger not enabled, row security on a table. The
 * two descriptions are compared key by key: a key only the snapshot's has is missing, one only the installed schema's
 * has is unexpected, and a key both have with two definitions is both. Deparsed text is compared only with deparsed
 * text from the same server, so no model of PostgreSQL's deparser exists anywhere. A column and a statistics object's
 * column list are read so that the attribute order a migrated table differs from a fresh one by never enters a
 * description: columns are keyed by name, and statistics columns listed by name.
 *
 * An IMMUTABLE function is one of the installation's constants (a roster's names, a closed relation's packed cells),
 * and grizzle installs no other: a constant is named by its content's digest, so its key already says what it holds,
 * and it is described by its owner and its result type alone, never by its body, which for a closed relation runs to
 * many kilobytes. A constant the snapshot names is installed or missing by its key; one only the database holds, as a
 * migration that did not drop a replaced constant leaves, is unexpected by its key.
 *
 * The scratch name is `grizzle_admission_` and 24 hex digits of the schema name's SHA-256: lower case, no keyword, so
 * PostgreSQL never quotes it, and a description of the scratch schema reads as the installed schema's once each
 * occurrence of the scratch name is replaced by the installed name as PostgreSQL prints it (quote_ident), and each
 * occurrence quoted, as grizzle's printer writes every identifier into a function body, by the quoted installed name.
 * Nothing of the scratch schema ever commits, and nothing in it refers to the installed schema, so it takes no lock on
 * an installed object: the replay's every name is absolute, a relation a regclass value names included (sql/ast.ts
 * RegclassRef), and the move renames each. The migration identity may create a schema, since its first migration
 * creates the installed one. The transaction reads under the closed search path (sql/ast.ts closedSearchPath), so a
 * deparse spells pg_catalog's names bare and every other schema's qualified, each spelling an injective function of the
 * object it names.
 *
 * Beside the objects: the database holds the defaults the snapshot sets, the owner's default privileges grant no one
 * but the owner anything beyond PostgreSQL's own defaults the snapshot's revokes leave, everywhere and in each schema
 * the installation holds (a default privilege of the owner's is a privilege on whatever a later migration creates; the
 * empty snapshot alters none and owns nothing, so it judges no one's), every login and role the snapshot creates
 * exists with its attributes (a login LOGIN NOINHERIT, a role NOLOGIN, neither SUPERUSER, CREATEDB, CREATEROLE,
 * REPLICATION or BYPASSRLS), each one's settings, privileges, memberships, members and policies are exactly the
 * snapshot's (roles.ts, the statements Db.open runs for its own login and role), every extension the snapshot creates
 * lives in the schema it names, and the ledger's latest complete target is the snapshot's with no folder partial
 * (ledgerMismatches). A grant to a role the snapshot does not create is not drift, unless it makes that role a member
 * of a login or theory role beyond what the snapshot grants: then something besides the login acts through it.
 *
 * Every read is a catalog-read AST the engine prints (sql/catalog.ts). Every value read is text and never NULL: a
 * description's parts are joined by concat_ws, which leaves out a part the object lacks and returns text in any case.
 *
 * A fact the snapshot requires and the database lacks (`missing`), or one the database holds and the snapshot does
 * not (`unexpected`).
 */
export interface DriftMismatch {
	readonly kind: "missing" | "unexpected"
	readonly fact: string
}

/** The drift check's transaction: one snapshot for every read, the scratch installation beside them, rolled back. */
export const driftTransaction: Uncommitting = { access: "readWrite", end: "ROLLBACK" }

/**
 * The hex digits of a scratch schema's name after `grizzle_admission_`: the leading ones of the schema name's SHA-256.
 *
 * @formatConstant a scratch schema's name: grizzle_admission_ and 24 lowercase hex digits
 */
const scratchDigestHex = 24

/** The scratch schema a schema's expected objects are deparsed in: the schema of the replayed types, too. */
const scratchSchema = (schema: string): TypeSchema =>
	scratchTypes(`grizzle_admission_${pipe(sha256Hex(schema), Str.slice(0, scratchDigestHex))}`)

const scratchTypes = nominal<string, TypeSchema>()

/** Whether the object `oid` of the catalog `catalog` is no extension's member. */
const notExtensionMember = (catalog: C.CatalogRelation, oid: C.CatalogExpr): C.CatalogExpr => {
	const x = C.from("pg_depend", "x")
	return C.notExists(
		C.anyRow(
			[x.item],
			C.and([
				C.eq(x.col("classid"), C.catalogRegclass(catalog)),
				C.eq(x.col("objid"), oid),
				C.eq(x.col("deptype"), C.letter("e"))
			])
		)
	)
}

/** `text` and `value`, joined: NULL where the value is, so concat_ws leaves the part out. */
const labelled = (text: string, value: C.CatalogExpr): C.CatalogExpr =>
	C.concat([C.text(text), value])

const owner = (oid: C.CatalogExpr): C.CatalogExpr =>
	labelled("owner ", C.asText(C.call("pg_get_userbyid", [oid])))

/** A name as PostgreSQL quotes it. */
const quoted = (name: C.CatalogExpr): C.CatalogExpr => C.call("quote_ident", [C.asText(name)])

/** A collation as `<schema>.<name>`; no row, and so no part of the description, for none. */
const collationOf = (oid: C.CatalogExpr): C.CatalogExpr => {
	const co = C.from("pg_collation", "co")
	const cn = C.from("pg_namespace", "cn")
	return C.scalar(
		C.query(
			[
				C.concat([
					C.text("collation "),
					quoted(cn.col("nspname")),
					C.text("."),
					quoted(co.col("collname"))
				])
			],
			[C.join(co.item, cn.item, C.eq(cn.col("oid"), co.col("collnamespace")))],
			C.eq(co.col("oid"), oid)
		)
	)
}

/** The parts of a description joined by `; `; concat_ws leaves out a part that is absent. */
const parts = (items: NonEmptyReadonlyArray<C.CatalogExpr>): C.CatalogExpr =>
	C.call("concat_ws", [C.text("; "), ...items])

/** A key's parts: its kind, then the schema the keys spell ($2) and each name, quoted as PostgreSQL quotes it. */
const keyParts = (
	kind: string,
	names: NonEmptyReadonlyArray<C.CatalogExpr>
): NonEmptyReadonlyArray<C.CatalogExpr> => [
	C.text(`${kind} `),
	C.call("quote_ident", [C.param(2, "text")]),
	...Arr.flatMap(names, (n) => [C.text("."), quoted(n)])
]

const keyOf = (kind: string, names: NonEmptyReadonlyArray<C.CatalogExpr>): C.CatalogExpr =>
	C.concat(keyParts(kind, names))

/** A CASE of WHENs alone: NULL, and so no part of the description, where none holds. */
const when = (condition: C.CatalogExpr, then: C.CatalogExpr): C.CatalogExpr =>
	C.caseWhen([{ when: condition, result: then }], undefined)

/** The schema read is $1. */
const inSchema = (n: C.CatalogSource): C.CatalogExpr => C.eq(n.col("nspname"), C.param(1, "text"))

/** `from` joined to its namespace `n` by `namespace`. */
const inNamespace = (
	from: C.CatalogFrom,
	n: C.CatalogSource,
	namespace: C.CatalogExpr
): C.CatalogFrom => C.join(from, n.item, C.eq(n.col("oid"), namespace))

/**
 * Each object of a schema with its description, two text columns: $1 the schema read, $2 the schema the keys spell.
 *
 * A view's or materialized view's own _RETURN rule is its definition, described with the view.
 *
 * A NOT NULL constraint is its column's `not null`, whatever its name, which a renamed table keeps from before.
 *
 * A statistics object's columns by name: PostgreSQL keeps them in column order (stxkeys), which differs between a
 * migrated table, whose retyped column was added last, and a fresh one.
 */
const descriptionSelect = (): C.CatalogSelect => {
	const n = C.from("pg_namespace", "n")
	const c = C.from("pg_class", "c")
	const a = C.from("pg_attribute", "a")
	const k = C.from("pg_constraint", "k")
	const t = C.from("pg_type", "t")
	const p = C.from("pg_proc", "p")
	const g = C.from("pg_trigger", "g")
	const x = C.from("pg_statistic_ext", "x")
	const policy = C.from("pg_policy", "p")
	const rule = C.from("pg_rewrite", "r")
	const relationKinds = C.letters(["r", "p", "m", "v", "S", "f", "c", "i", "I"])
	const notValid = (): C.CatalogExpr => {
		const i = C.from("pg_index", "i")
		return C.scalar(
			C.query(
				[C.text("not valid")],
				[i.item],
				C.and([
					C.eq(i.col("indexrelid"), c.col("oid")),
					C.not(C.and([i.col("indisvalid"), i.col("indisready"), i.col("indislive")]))
				])
			)
		)
	}
	const sequence = (): C.CatalogExpr => {
		const q = C.from("pg_sequence", "q")
		return C.scalar(
			C.query(
				[
					C.concat([
						C.text("as "),
						C.call("format_type", [q.col("seqtypid"), C.literal(-1n, "integer")]),
						C.text(" increment "),
						C.asText(q.col("seqincrement")),
						C.text(" minimum "),
						C.asText(q.col("seqmin")),
						C.text(" maximum "),
						C.asText(q.col("seqmax")),
						C.text(" cache "),
						C.asText(q.col("seqcache")),
						C.caseWhen([{ when: q.col("seqcycle"), result: C.text(" cycle") }], C.text(""))
					])
				],
				[q.item],
				C.eq(q.col("seqrelid"), c.col("oid"))
			)
		)
	}
	const ownedBy = (): C.CatalogExpr => {
		const d = C.from("pg_depend", "d")
		const o = C.from("pg_class", "o")
		const oa = C.from("pg_attribute", "a")
		return C.scalar(
			C.select({
				...C.core(
					[
						C.concat([
							C.text("owned by "),
							quoted(o.col("relname")),
							C.text("."),
							quoted(oa.col("attname"))
						])
					],
					[
						C.join(
							C.join(d.item, o.item, C.eq(o.col("oid"), d.col("refobjid"))),
							oa.item,
							C.and([
								C.eq(oa.col("attrelid"), d.col("refobjid")),
								C.eq(oa.col("attnum"), d.col("refobjsubid"))
							])
						)
					],
					C.and([
						C.eq(c.col("relkind"), C.letter("S")),
						C.eq(d.col("classid"), C.catalogRegclass("pg_class")),
						C.eq(d.col("objid"), c.col("oid")),
						C.eq(d.col("refclassid"), C.catalogRegclass("pg_class")),
						C.inList(d.col("deptype"), C.letters(["a", "i"]))
					])
				),
				orderBy: [o.col("relname"), oa.col("attname")],
				limit: 1
			})
		)
	}
	const columnDefault = (): C.CatalogExpr => {
		const d = C.from("pg_attrdef", "d")
		return C.scalar(
			C.query(
				[
					C.concat([
						C.caseOf(
							a.col("attgenerated"),
							[
								{ when: C.letter("s"), result: C.text("generated stored as ") },
								{ when: C.letter("v"), result: C.text("generated virtual as ") }
							],
							C.text("default ")
						),
						C.call("pg_get_expr", [d.col("adbin"), d.col("adrelid")])
					])
				],
				[d.item],
				C.and([C.eq(d.col("adrelid"), a.col("attrelid")), C.eq(d.col("adnum"), a.col("attnum"))])
			)
		)
	}
	const statisticsColumns = (): C.CatalogExpr => {
		const u = C.fromFunction(C.call("unnest", [x.col("stxkeys")]), "u", ["n"], false)
		const sa = C.from("pg_attribute", "a")
		return C.scalar(
			C.query(
				[labelled("on ", C.joinedSet(C.collateC(quoted(sa.col("attname"))), C.text(", ")))],
				[
					C.join(
						u.item,
						sa.item,
						C.and([C.eq(sa.col("attrelid"), x.col("stxrelid")), C.eq(sa.col("attnum"), u.col("n"))])
					)
				],
				undefined
			)
		)
	}
	const statisticsTable = (): C.CatalogExpr => {
		const r = C.from("pg_class", "r")
		return C.scalar(
			C.query(
				[labelled("from ", quoted(r.col("relname")))],
				[r.item],
				C.eq(r.col("oid"), x.col("stxrelid"))
			)
		)
	}
	const policyRoles = (): C.CatalogExpr => {
		const o = C.fromFunction(C.call("unnest", [policy.col("polroles")]), "o", ["role"], false)
		const roleName = C.asText(C.call("pg_get_userbyid", [o.col("role")]))
		return C.scalar(
			C.query(
				[labelled("to ", C.joinedSet(C.collateC(C.call("quote_ident", [roleName])), C.text(", ")))],
				[o.item],
				undefined
			)
		)
	}
	const notComposite = (): C.CatalogExpr => {
		const r = C.from("pg_class", "r")
		return C.notExists(
			C.anyRow(
				[r.item],
				C.and([C.eq(r.col("oid"), t.col("typrelid")), C.ne(r.col("relkind"), C.letter("c"))])
			)
		)
	}
	const notArray = (): C.CatalogExpr => {
		const e = C.from("pg_type", "e")
		return C.notExists(C.anyRow([e.item], C.eq(e.col("typarray"), t.col("oid"))))
	}
	const relations = inNamespace(c.item, n, c.col("relnamespace"))
	return C.union([
		C.core(
			[
				C.concat([C.text("schema "), C.call("quote_ident", [C.param(2, "text")])]),
				parts([owner(n.col("nspowner"))])
			],
			[n.item],
			inSchema(n)
		),
		C.core(
			[
				keyOf("relation", [c.col("relname")]),
				parts([
					labelled("kind ", C.asText(c.col("relkind"))),
					owner(c.col("relowner")),
					C.caseOf(
						c.col("relpersistence"),
						[
							{ when: C.letter("u"), result: C.text("unlogged") },
							{ when: C.letter("t"), result: C.text("temporary") }
						],
						undefined
					),
					labelled("options ", C.asText(c.col("reloptions"))),
					when(c.col("relrowsecurity"), C.text("row security")),
					when(c.col("relforcerowsecurity"), C.text("forced row security")),
					C.caseWhen(
						[
							{
								when: C.inList(c.col("relkind"), C.letters(["m", "v"])),
								result: labelled("as ", C.call("pg_get_viewdef", [c.col("oid"), C.bool(false)]))
							},
							{
								when: C.inList(c.col("relkind"), C.letters(["i", "I"])),
								result: C.call("pg_get_indexdef", [c.col("oid")])
							}
						],
						undefined
					),
					notValid(),
					sequence(),
					ownedBy()
				])
			],
			[relations],
			C.and([
				inSchema(n),
				C.inList(c.col("relkind"), relationKinds),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.core(
			[
				keyOf("column", [c.col("relname"), a.col("attname")]),
				parts([
					C.call("format_type", [a.col("atttypid"), a.col("atttypmod")]),
					collationOf(a.col("attcollation")),
					when(a.col("attnotnull"), C.text("not null")),
					C.caseOf(
						a.col("attidentity"),
						[
							{ when: C.letter("a"), result: C.text("generated always as identity") },
							{ when: C.letter("d"), result: C.text("generated by default as identity") }
						],
						undefined
					),
					columnDefault()
				])
			],
			[
				inNamespace(
					C.join(a.item, c.item, C.eq(c.col("oid"), a.col("attrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([
				inSchema(n),
				C.inList(c.col("relkind"), C.letters(["r", "p", "f"])),
				C.gt(a.col("attnum"), C.literal(0n, "smallint")),
				C.not(a.col("attisdropped")),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.core(
			[
				keyOf("constraint", [c.col("relname"), k.col("conname")]),
				C.call("pg_get_constraintdef", [k.col("oid")])
			],
			[
				inNamespace(
					C.join(k.item, c.item, C.eq(c.col("oid"), k.col("conrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([
				inSchema(n),
				C.notInList(k.col("contype"), C.letters(["n", "t"])),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.core(
			[
				keyOf("domain constraint", [t.col("typname"), k.col("conname")]),
				C.call("pg_get_constraintdef", [k.col("oid")])
			],
			[
				inNamespace(
					C.join(k.item, t.item, C.eq(t.col("oid"), k.col("contypid"))),
					n,
					t.col("typnamespace")
				)
			],
			C.and([inSchema(n), notExtensionMember("pg_type", t.col("oid"))])
		),
		C.core(
			[
				keyOf("type", [t.col("typname")]),
				parts([
					labelled("kind ", C.asText(t.col("typtype"))),
					owner(t.col("typowner")),
					when(
						C.eq(t.col("typtype"), C.letter("d")),
						labelled("over ", C.call("format_type", [t.col("typbasetype"), t.col("typtypmod")]))
					),
					collationOf(t.col("typcollation")),
					when(t.col("typnotnull"), C.text("not null")),
					labelled(
						"default ",
						C.call("pg_get_expr", [t.col("typdefaultbin"), C.literal(0n, "oid")])
					)
				])
			],
			[inNamespace(t.item, n, t.col("typnamespace"))],
			C.and([inSchema(n), notComposite(), notArray(), notExtensionMember("pg_type", t.col("oid"))])
		),
		C.core(
			[
				C.concat([
					...keyParts("function", [p.col("proname")]),
					C.text("("),
					C.call("pg_get_function_identity_arguments", [p.col("oid")]),
					C.text(")")
				]),
				parts([
					owner(p.col("proowner")),
					C.caseWhen(
						[
							{
								when: C.eq(p.col("provolatile"), C.letter("i")),
								result: labelled(
									"constant returning ",
									C.call("format_type", [p.col("prorettype"), C.literal(-1n, "integer")])
								)
							},
							{
								when: C.inList(p.col("prokind"), C.letters(["f", "p"])),
								result: C.call("pg_get_functiondef", [p.col("oid")])
							}
						],
						labelled("kind ", C.asText(p.col("prokind")))
					)
				])
			],
			[inNamespace(p.item, n, p.col("pronamespace"))],
			C.and([inSchema(n), notExtensionMember("pg_proc", p.col("oid"))])
		),
		C.core(
			[
				keyOf("trigger", [c.col("relname"), g.col("tgname")]),
				parts([
					C.call("pg_get_triggerdef", [g.col("oid"), C.bool(false)]),
					when(
						C.ne(g.col("tgenabled"), C.letter("O")),
						labelled("enabled ", C.asText(g.col("tgenabled")))
					)
				])
			],
			[
				inNamespace(
					C.join(g.item, c.item, C.eq(c.col("oid"), g.col("tgrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([inSchema(n), C.not(g.col("tgisinternal"))])
		),
		C.core(
			[
				keyOf("statistics", [x.col("stxname")]),
				parts([
					owner(x.col("stxowner")),
					labelled("kinds ", C.asText(x.col("stxkind"))),
					statisticsColumns(),
					labelled(
						"expressions ",
						C.asText(C.call("pg_get_statisticsobjdef_expressions", [x.col("oid")]))
					),
					statisticsTable()
				])
			],
			[inNamespace(x.item, n, x.col("stxnamespace"))],
			inSchema(n)
		),
		C.core(
			[
				keyOf("policy", [c.col("relname"), policy.col("polname")]),
				parts([
					labelled("command ", C.asText(policy.col("polcmd"))),
					C.caseWhen(
						[{ when: policy.col("polpermissive"), result: C.text("permissive") }],
						C.text("restrictive")
					),
					labelled(
						"using ",
						C.call("pg_get_expr", [policy.col("polqual"), policy.col("polrelid")])
					),
					labelled(
						"check ",
						C.call("pg_get_expr", [policy.col("polwithcheck"), policy.col("polrelid")])
					),
					policyRoles()
				])
			],
			[
				inNamespace(
					C.join(policy.item, c.item, C.eq(c.col("oid"), policy.col("polrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			inSchema(n)
		),
		C.core(
			[
				keyOf("rule", [c.col("relname"), rule.col("rulename")]),
				C.call("pg_get_ruledef", [rule.col("oid"), C.bool(false)])
			],
			[
				inNamespace(
					C.join(rule.item, c.item, C.eq(c.col("oid"), rule.col("ev_class"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([
				inSchema(n),
				C.ne(rule.col("rulename"), C.literal("_RETURN", "name")),
				notExtensionMember("pg_class", c.col("oid"))
			])
		)
	])
}

const descriptions: CatalogQuery<readonly [string, string]> = {
	sql: emitCatalog(descriptionSelect()),
	what: "an object's key and its description",
	row: ([key, description]) =>
		key === undefined || description === undefined ? undefined : [key, description]
}

/** A name as PostgreSQL prints it. */
const quotedIdent: CatalogQuery<string> = {
	sql: emitCatalog(C.query([C.call("quote_ident", [C.param(1, "text")])], [], undefined)),
	what: "a quoted name",
	row: ([printed]) => printed
}

const extensions = C.from("pg_extension", "e")
const extensionNamespaces = C.from("pg_namespace", "n")

/** The schema an extension lives in: one row, none when it is not installed. */
const extensionSchema: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query(
			[C.asText(extensionNamespaces.col("nspname"))],
			[inNamespace(extensions.item, extensionNamespaces, extensions.col("extnamespace"))],
			C.eq(extensions.col("extname"), C.param(1, "text"))
		)
	),
	what: "a schema name",
	row: ([schema]) => schema
}

/**
 * The hooks that move every name qualified by an installed schema to its scratch schema (sql/transform.ts): an object
 * name, a relation a regclass value names, a named type, a qualified function, an extension operator and an
 * extension's schema. A collation is pg_catalog's, which is never a grizzle schema (PostgreSQL reserves the pg_ prefix).
 */
const scratchHooks = (scratchOf: ReadonlyMap<string, TypeSchema>): AstHooks => {
	const moved = (schema: string): string => scratchOf.get(schema) ?? schema
	const movedTypes = (schema: TypeSchema): TypeSchema => scratchOf.get(schema) ?? schema
	return {
		...identityHooks,
		objectName: (n) => ({ ...n, schema: moved(n.schema) }),
		typeRef: (t) => (t.kind === "named" ? { ...t, schema: movedTypes(t.schema) } : t),
		functionRef: (f) => ({ ...f, schema: moved(f.schema) }),
		expr: (e) =>
			e.kind === "binary" && e.schema !== undefined ? { ...e, schema: moved(e.schema) } : e,
		extension: (x) => ({ ...x, schema: moved(x.schema) })
	}
}

/**
 * What a manifest statement runs in the scratch schemas: an object of an installed schema, built in its scratch one,
 * each installed schema created as its scratch one and an index built in the transaction, never concurrently; nothing
 * for a role, a membership, a grant, a default privilege, a database default, an extension, a comment or a query.
 */
const inScratch = (
	s: ManifestStatement,
	scratchOf: ReadonlyMap<string, TypeSchema>
): ReadonlyArray<SqlStatement> => {
	const hooks = scratchHooks(scratchOf)
	switch (s.kind) {
		case "createSchema":
			return [{ ...s, name: scratchOf.get(s.name) ?? s.name }]
		case "createIndex":
			return [{ ...transformCreateIndex(s, hooks), concurrently: false }]
		case "createTable":
		case "alterTable":
		case "createDomain":
		case "createConstant":
		case "packConstant":
		case "createMaterializedView":
		case "createView":
		case "createPolicy":
		case "createFunction":
		case "createGuardTrigger":
		case "createConstraintTrigger":
		case "createStatistics":
			return [transformStatement(s, hooks)]
		case "alterDatabaseDefault":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "grant":
		case "grantColumns":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "comment":
		case "select":
			return []
	}
}

/** The texts that build the snapshot's objects in the scratch schemas, in the manifest's order. */
const scratchStatements = (
	statements: ReadonlyArray<ManifestStatement>,
	scratchOf: ReadonlyMap<string, TypeSchema>
): Result.Result<ReadonlyArray<EmittedText>, CompileError> => {
	const texts: Array<EmittedText> = []
	for (const d of Arr.flatMap(statements, (s) => inScratch(s, scratchOf))) {
		const e = emit(d, emptyNameMap)
		if (!e.ok) {
			return Result.fail(e.error)
		}
		texts.push(e.value.text)
	}
	return Result.succeed(texts)
}

/**
 * A text deparsed in the scratch schemas as it reads in the installed ones: each scratch name quoted, as grizzle's
 * printer writes it into a function body, becomes the quoted installed name, and each scratch name bare, as PostgreSQL
 * prints it, becomes the installed name as PostgreSQL prints it (`printed`, from quote_ident). A scratch name is
 * `grizzle_admission_` and a digest, so no scratch name holds another.
 */
const fromScratch =
	(
		names: ReadonlyArray<{
			readonly scratch: string
			readonly schema: string
			readonly printed: string
		}>
	) =>
	(text: string): string =>
		Arr.reduce(names, text, (t, n) =>
			pipe(
				t,
				Str.replaceAll(quoteIdent(n.scratch), quoteIdent(n.schema)),
				Str.replaceAll(n.scratch, n.printed)
			)
		)

/**
 * The installed descriptions against the snapshot's: each key only one side has, and each key whose descriptions
 * differ, as the snapshot's missing and the installed one unexpected.
 */
const compareDescriptions = (
	expected: ReadonlyMap<string, string>,
	installed: ReadonlyMap<string, string>
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	const fact = (key: string, description: string) => `${key} as ${description}`
	for (const [key, want] of expected) {
		const have = installed.get(key)
		if (have === want) {
			continue
		}
		out.push({ kind: "missing", fact: fact(key, want) })
		if (have !== undefined) {
			out.push({ kind: "unexpected", fact: fact(key, have) })
		}
	}
	for (const [key, have] of installed) {
		if (!expected.has(key)) {
			out.push({ kind: "unexpected", fact: fact(key, have) })
		}
	}
	return out
}

/** A setting difference as facts, `at` where it applies. */
const settingFacts = (d: SettingDifference, at: string): ReadonlyArray<DriftMismatch> => {
	const fact = (value: string) => `${at} setting ${d.parameter}=${value}`
	switch (d.kind) {
		case "missing":
			return [{ kind: "missing", fact: fact(d.value) }]
		case "unexpected":
			return [{ kind: "unexpected", fact: fact(d.value) }]
		case "differs":
			return [
				{ kind: "missing", fact: fact(d.expected) },
				{ kind: "unexpected", fact: fact(d.observed) }
			]
	}
}

const privilegeFact = (d: PrivilegeDifference, role: string): DriftMismatch => ({
	kind: d.kind,
	fact: `role ${role} privilege ${d.privilege} on ${d.family} ${d.object}`
})

/**
 * A membership's or a member's facts, `what` naming the pair: one the snapshot grants is held exactly WITH INHERIT FALSE,
 * SET TRUE and no ADMIN; one beyond it is reported for what it opens (roles.ts membershipDifferences,
 * memberDifferences).
 */
const membershipFacts = (d: MembershipDifference, what: string): ReadonlyArray<DriftMismatch> => {
	switch (d.kind) {
		case "missing":
			return [{ kind: "missing", fact: `${what} with inherit false, set true` }]
		case "options":
			return [
				{ kind: "missing", fact: `${what} with inherit false, set true` },
				{ kind: "unexpected", fact: `${what} with other options` }
			]
		case "unexpected":
			return [{ kind: "unexpected", fact: what }]
	}
}

const command = (sql: EmittedText): BatchStatement => ({ sql, params: [] })

/** A catalog statement's place in a flight: its rows read back from the flight's outcomes, at the position it was sent
 * at, captured when it was sent (Sending), so no reader counts positions. */
interface Slot<Row> {
	readonly rows: (
		outcomes: ReadonlyArray<BatchOutcome>
	) => Result.Result<ReadonlyArray<Row>, CatalogRowRefused>
	readonly row: (outcomes: ReadonlyArray<BatchOutcome>) => Result.Result<Row, CatalogRowRefused>
}

/** Where in a flight a run of commands sits: its first statement's position and how many it sent. */
export interface FlightSpan {
	readonly from: number
	readonly count: number
}

/** A flight's statements as they are sent, in order: a command, whose outcome nothing reads, a run of commands, whose
 * span the flight's failure is located by, or a catalog query, read through the slot it is sent into. */
interface Sending {
	readonly statements: ReadonlyArray<BatchStatement>
	readonly command: (sql: EmittedText) => void
	readonly commands: (texts: ReadonlyArray<EmittedText>) => FlightSpan
	readonly query: <Row>(query: CatalogQuery<Row>, params: ReadonlyArray<ParamText>) => Slot<Row>
}

const sending = (): Sending => {
	const statements: Array<BatchStatement> = []
	const sent = (statement: BatchStatement): number => statements.push(statement) - 1
	return {
		statements,
		command: (sql) => {
			sent(command(sql))
		},
		commands: (texts) => {
			const from = statements.length
			for (const sql of texts) {
				sent(command(sql))
			}
			return { from, count: texts.length }
		},
		query: (query, params) => {
			const at = sent({ sql: query.sql, params })
			return {
				rows: (outcomes) => catalogRows(query, outcomeRows(outcomes, at)),
				row: (outcomes) => catalogRow(query, outcomeRows(outcomes, at))
			}
		}
	}
}

/**
 * The mismatches of a flight by fact. Each is found once: a description by its key, the database's settings once, and
 * every other fact by its role or extension.
 */
const sorted = (mismatches: ReadonlyArray<DriftMismatch>): ReadonlyArray<DriftMismatch> =>
	Arr.sort(mismatches, Order.Struct({ fact: Order.String, kind: Order.String }))

/** The drift check's statements, and where in them the replay that builds the snapshot beside the schema sits. */
export interface DriftFlight {
	readonly flight: Flight<ReadonlyArray<DriftMismatch>, CatalogRowRefused>
	readonly replay: FlightSpan
}

/**
 * The drift check of `snapshot`'s schema as statements of driftTransaction, in order, each read through the slot it is
 * sent into (Sending): the closed search path first (sql/ast.ts closedSearchPath), against which every description is
 * spelled, since PostgreSQL's deparsers spell a name bare exactly when the path finds it first; each installed schema's
 * name as PostgreSQL prints it, the installed schema's first and then each role's; the replay, whose statements name
 * every object absolutely; each schema's installed and scratch descriptions; then each extension's schema, the
 * database's settings, the owner's default privileges (none for the empty snapshot, which alters no default), and each
 * login's and role's login, settings, privileges, memberships and policies.
 */
export const driftFlight = (snapshot: DeploySnapshot): Result.Result<DriftFlight, CompileError> =>
	Result.gen(function* () {
		const schema = snapshot.schema
		const statements = yield* toResult(manifestStatements(snapshot))
		const schemas = judgedSchemas(statements, schema)
		const scratchOf = new Map(Arr.map(schemas, (s) => [s, scratchSchema(s)] as const))
		const replay = yield* scratchStatements(statements, scratchOf)
		const createdExtensions = Arr.flatMap(statements, (s) =>
			s.kind === "createExtension" ? [s] : []
		)
		const roles = Arr.map(manifestRoles(statements), (role) =>
			roleExpectation(statements, schema, role)
		)
		const flight = sending()
		flight.command(emitCatalog(C.setClosedSearchPath))
		const printed = Arr.map(schemas, (s) => ({
			schema: s,
			slot: flight.query(quotedIdent, [textParam(s)])
		}))
		const replayed = flight.commands(replay)
		const described = Arr.map(schemas, (s) => ({
			installed: flight.query(descriptions, [textParam(s), textParam(s)]),
			expected: flight.query(descriptions, [textParam(scratchSchema(s)), textParam(s)])
		}))
		const extensionSchemas = Arr.map(createdExtensions, (x) => ({
			extension: x,
			slot: flight.query(extensionSchema, [textParam(x.name)])
		}))
		const database = flight.query(databaseSettingsQuery, [])
		const defaults = Arr.map(defaultPrivilegesExpectations(statements, schema), (expectation) => ({
			expectation,
			slot: flight.query(defaultPrivilegesQuery(expectation), defaultPrivilegesParams(expectation))
		}))
		const roleReads = Arr.map(roles, (r) => ({
			expectation: r,
			attributes: flight.query(attributesQuery, [textParam(r.role)]),
			settings: flight.query(settingsQuery, [textParam(r.role)]),
			privileges: flight.query(privilegesQuery, privilegesParams(r)),
			memberships: flight.query(membershipsQuery, [textParam(r.role)]),
			members: flight.query(membersQuery, [textParam(r.role), textParam(schema)]),
			policies: flight.query(policiesQuery, [
				textParam(r.role),
				textArray(Arr.map(snapshot.levels, (l) => l.schema))
			])
		}))
		return {
			replay: replayed,
			flight: {
				statements: flight.statements,
				read: (outcomes) =>
					Effect.fromResult(
						Result.gen(function* () {
							const names: Array<{ scratch: string; schema: string; printed: string }> = []
							for (const p of printed) {
								names.push({
									scratch: scratchSchema(p.schema),
									schema: p.schema,
									printed: yield* p.slot.row(outcomes)
								})
							}
							const rename = fromScratch(names)
							const out: Array<DriftMismatch> = []
							for (const d of described) {
								const installed = yield* d.installed.rows(outcomes)
								const expected = yield* d.expected.rows(outcomes)
								const mismatches = compareDescriptions(
									new Map(Arr.map(expected, ([k, e]) => [rename(k), rename(e)])),
									new Map(installed)
								)
								for (const mismatch of mismatches) {
									out.push(mismatch)
								}
							}
							for (const { extension: x, slot } of extensionSchemas) {
								const at = yield* slot.rows(outcomes)
								if (!at.includes(x.schema)) {
									out.push({ kind: "missing", fact: `extension ${x.name} in schema ${x.schema}` })
								}
							}
							for (const d of databaseDifferences(yield* database.rows(outcomes))) {
								for (const fact of settingFacts(d, "database")) {
									out.push(fact)
								}
							}
							for (const { expectation, slot } of defaults) {
								const owned = yield* slot.rows(outcomes)
								for (const d of defaultPrivilegeDifferences(owned, expectation)) {
									out.push({ kind: d.kind, fact: `default privilege ${d.grant}` })
								}
							}
							for (const read of roleReads) {
								const r = read.expectation
								for (const d of attributeDifferences(yield* read.attributes.rows(outcomes), r)) {
									out.push({ kind: "missing", fact: `role ${r.role} ${d.expected}` })
									if (d.attribute !== "existence") {
										out.push({ kind: "unexpected", fact: `role ${r.role} ${d.observed}` })
									}
								}
								for (const d of roleDifferences(yield* read.settings.rows(outcomes), r)) {
									const scope =
										d.scope === "roleInDatabase" ? `role ${r.role} in database` : `role ${r.role}`
									for (const fact of settingFacts(d, scope)) {
										out.push(fact)
									}
								}
								for (const d of yield* read.privileges.rows(outcomes)) {
									out.push(privilegeFact(d, r.role))
								}
								for (const d of membershipDifferences(yield* read.memberships.rows(outcomes), r)) {
									for (const fact of membershipFacts(d, `role ${r.role} membership in ${d.role}`)) {
										out.push(fact)
									}
								}
								for (const d of memberDifferences(yield* read.members.rows(outcomes), r)) {
									for (const fact of membershipFacts(d, `role ${r.role} member ${d.role}`)) {
										out.push(fact)
									}
								}
								for (const d of policyDifferences(yield* read.policies.rows(outcomes), r)) {
									out.push({
										kind: d.kind,
										fact: `policy ${d.policy.name} on ${d.policy.table} naming role ${r.role}`
									})
								}
							}
							return sorted(out)
						})
					)
			}
		}
	})

/** The ledger's facts: its latest complete target is the snapshot's, and no folder is partial. */
export const ledgerMismatches = (
	snapshot: DeploySnapshot,
	state: LedgerState
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	if (state.latest !== snapshot.fingerprint) {
		out.push({ kind: "missing", fact: `ledger latest ${snapshot.fingerprint}` })
		out.push({ kind: "unexpected", fact: `ledger latest ${state.latest}` })
	}
	if (state.partial !== undefined) {
		out.push({ kind: "unexpected", fact: `ledger partial ${state.partial.folder}` })
	}
	return out
}
