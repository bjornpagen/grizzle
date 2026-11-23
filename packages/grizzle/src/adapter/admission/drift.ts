import type { WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Option, Order, pipe, Result, String as Str } from "effect"
import {
	attributeDifferences,
	attributesQuery,
	databaseSettingsQuery,
	formerDefaultHeld,
	defaultPrivilegeDifferences,
	defaultPrivilegesParams,
	defaultPrivilegesQuery,
	type MembershipDifference,
	memberDifferences,
	type PolicyDifference,
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
import type { CatalogRowRefused, ServerError } from "#adapter/errors/failures.ts"
import { tableExists } from "#adapter/migrate/ledger.ts"
import { apartRow, apartRows } from "#adapter/migrate/session.ts"
import {
	type ApartAnswer,
	type BatchOutcome,
	type BatchStatement,
	oneShotStatement,
	type SecondFlight,
	type Uncommitting
} from "#adapter/wire/batch.ts"
import { type CatalogQuery, catalogRow, catalogRows, outcomeRows } from "#adapter/wire/statement.ts"
import {
	type AstHooks,
	C,
	defaultPrivilegesExpectations,
	identityHooks,
	installedExpectation,
	judgedSchemas,
	manifestRoles,
	roleExpectation,
	type RoleExpectation,
	transformCreateIndex,
	transformStatement
} from "#compiler/plan/catalog.ts"
import {
	CompileError,
	type CreatePublication,
	malformedArtifact,
	emitCatalog,
	emitCommands,
	differenceShown,
	type EmittedText,
	escaped,
	nominal,
	type NonEmptyReadonlyArray,
	type ObjectName,
	type ParamText,
	printObjectName,
	quoteIdent,
	SourceLoc,
	sha256Hex,
	type SqlStatement,
	type TypeSchema,
	wellFormed
} from "#compiler/plan/common.ts"
import {
	decoderLoginOf,
	filledText,
	type GraphIdent,
	identifierOf,
	identity,
	type InstallationNames,
	type InstalledRoleTooLong,
	lex,
	type ManifestStatement,
	manifestStatements,
	parseIdent,
	proofDigests,
	type ProofStatements,
	proofsTableName,
	qualifiedIdent,
	type RecordedSource,
	recordedSources,
	type ReplayedObject,
	replayedOver,
	resolveVariables,
	type VariableFault
} from "#compiler/plan/migration.ts"
import { textParam } from "#compiler/plan/read.ts"
import type { DeploySnapshot, LedgerState } from "#compiler/plan/serve.ts"

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
 * has is unexpected, and a key both have with two definitions differs. Deparsed text is compared only with deparsed
 * text from the same server, so no model of PostgreSQL's deparser exists anywhere. A column and a statistics object's
 * column list are read so that the attribute order a migrated table differs from a fresh one by never enters a
 * description: columns are keyed by name, and statistics columns listed by name.
 *
 * An IMMUTABLE function of a parsed SQL body is one of the installation's constants (a roster's names, a closed
 * relation's packed cells): a constant is named by its content's digest, so its key already says what it holds,
 * and it is described by its owner and its result type alone, never by its body, which for a closed relation runs to
 * many kilobytes. A constant the snapshot names is installed or missing by its key; one only the database holds, as a
 * migration that did not drop a replaced constant leaves, is unexpected by its key.
 *
 * The snapshot records a PL/pgSQL function, a declared function and a constant by its header alone, a function with
 * the digest of its source (snapshot/recorded.ts), so the replay creates each with a stub body (replayedStatement): a
 * constant is described as above, and a function of a string body, PL/pgSQL or a declared one's, by its definition's
 * header alone (plpgsqlHeader), its owner among it, its source held apart to the record's digest, the SHA-256 of
 * pg_proc.prosrc (sourcesQuery). A declared function's row types are relations of kind c, each described with its
 * attributes as a table is with its columns. A source that differs is reported with both
 * digests and the committed migration statement that last defines the function (definitionOf), the text to compare
 * the installed one with.
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
 * snapshot's (roles.ts), every extension the snapshot creates lives in the schema it names, and the ledger's latest
 * complete target is the snapshot's with no folder partial (ledgerMismatches). A grant to a role the snapshot does not
 * create is not drift, unless it makes that role a member of a login or theory role beyond what the snapshot grants:
 * then something besides the login acts through it.
 *
 * Every read is a catalog-read AST the engine prints (sql/catalog.ts). Every value read is text and never NULL: a
 * description's parts are joined by concat_ws, which leaves out a part the object lacks and returns text in any case.
 *
 * A fact the snapshot requires and the database lacks (`missing`), one the database holds and the snapshot does not
 * (`unexpected`), or a key both hold with two values (`differs`): the snapshot's `expected` and the database's
 * `installed`, an object's two descriptions, a setting's two values or the ledger's two latest targets.
 */
export type DriftMismatch =
	| { readonly kind: "missing" | "unexpected"; readonly fact: string }
	| {
			readonly kind: "differs"
			readonly fact: string
			readonly expected: string
			readonly installed: string
	  }
	| {
			/** A PL/pgSQL function whose installed source is not the one the snapshot records: the record's digest, the
			 * installed source's, and the committed statement that last defines the function. */
			readonly kind: "source"
			readonly fact: string
			readonly expected: string
			readonly installed: string
			readonly definedBy: DefinedBy
	  }

/**
 * The committed migration statement that last defines a function: the newest folder's last file holding a statement
 * whose head is CREATE [OR REPLACE] FUNCTION of the function's name (`statement`, counted from 1 in its file, as
 * `grizzle check` counts it); or none, where no committed file holds one (`none`).
 */
export type DefinedBy =
	| {
			readonly kind: "statement"
			readonly folder: string
			readonly file: string
			readonly statement: number
	  }
	| { readonly kind: "none" }

/** A committed migration folder as the drift check reads it: its name and each file's statements, in order. */
export interface DriftFolder {
	readonly name: string
	readonly files: ReadonlyArray<{
		readonly name: string
		readonly statements: ReadonlyArray<string>
	}>
}

/**
 * Whether a statement's head is CREATE [OR REPLACE] FUNCTION of `fn`, as PostgreSQL's scanner reads it (lexer.ts): the
 * statement read up to the first spelling of the name as the printer writes it, where the head ends, never its body.
 */
const createsFunction = (statement: string, fn: ObjectName): boolean => {
	const named = printObjectName(fn)
	const at = Str.indexOf(named)(statement)
	if (Option.isNone(at)) {
		return false
	}
	const tokens = lex(Str.slice(0, at.value + named.length)(statement)).tokens
	const verbs = Arr.join(
		Arr.map(Arr.dropRight(tokens, 3), (t) => (t.kind === "word" ? t.upper : t.kind)),
		" "
	)
	const [schema, dot, name] = Arr.takeRight(tokens, 3)
	return (
		(verbs === "CREATE FUNCTION" || verbs === "CREATE OR REPLACE FUNCTION") &&
		schema?.kind === "quotedIdent" &&
		schema.text === fn.schema &&
		dot?.kind === "punct" &&
		dot.text === "." &&
		name?.kind === "quotedIdent" &&
		name.text === fn.name
	)
}

/** The committed statement that last defines `fn` among `folders`, in creation order (DefinedBy). */
const definitionOf = (folders: ReadonlyArray<DriftFolder>, fn: ObjectName): DefinedBy => {
	for (const folder of Arr.reverse(folders)) {
		for (const file of Arr.reverse(folder.files)) {
			const at = Arr.findLastIndex(file.statements, (statement) => createsFunction(statement, fn))
			if (Option.isSome(at)) {
				return { kind: "statement", folder: folder.name, file: file.name, statement: at.value + 1 }
			}
		}
	}
	return { kind: "none" }
}

/** Where a function is last defined, in words. */
const definedByText = (d: DefinedBy): string => {
	switch (d.kind) {
		case "statement":
			return `last defined by statement ${d.statement} of ${d.folder}/${d.file}`
		case "none":
			return "defined by no committed migration file"
	}
}

/**
 * A mismatch as the report prints it, one line each: its kind and its fact, every control character and line separator
 * escaped as an escape string spells it and each backslash doubled (sql/escape.ts escaped), so nothing in a fact is
 * invisible, moves the cursor or breaks the line; and a key with two values by where they first differ, at which
 * character of how many on each side, and each value around it, never two whole texts.
 */
export const mismatchLine = (m: DriftMismatch): string => {
	switch (m.kind) {
		case "missing":
		case "unexpected":
			return `${m.kind} ${escaped(m.fact)}`
		case "differs": {
			const shown = differenceShown(m.expected, m.installed)
			return `differs ${escaped(m.fact)} from character ${shown.at} (the snapshot's of ${shown.characters.first}, the database's of ${shown.characters.second}): the snapshot's ${shown.first} where the database's is ${shown.second}`
		}
		case "source":
			return `differs ${escaped(m.fact)}: the snapshot's digests to ${m.expected} where the database's digests to ${m.installed}, ${definedByText(m.definedBy)}`
	}
}

/** The drift check's transaction: one snapshot for every read, the scratch installation beside them, rolled back. */
export const driftTransaction: Uncommitting = {
	access: "readWrite",
	isolation: "serializable",
	end: "ROLLBACK"
}

/**
 * The hex digits of a scratch schema's name after `grizzle_admission_`: the leading ones of the schema name's SHA-256.
 *
 * @formatConstant a scratch schema's name: grizzle_admission_ and 24 lowercase hex digits
 */
const scratchDigestHex = 24

/** The scratch schema a schema's expected objects are deparsed in: the schema of the replayed types, too. */
const scratchSchema = (schema: string): TypeSchema =>
	scratchTypes(
		`grizzle_admission_${pipe(sha256Hex(wellFormed(schema)), Str.slice(0, scratchDigestHex))}`
	)

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

/**
 * Whether a function's body is a string, its source `prosrc` (pg_proc.prosrc): a PL/pgSQL function's, and a declared
 * function's of either language, each its text. A constant and a writable entry's world function have an SQL body
 * PostgreSQL parsed, `RETURN <expr>`, which it stores in prosqlbody, its prosrc empty (functioncmds.c
 * interpret_AS_clause).
 */
const stringBodied = (prosrc: C.CatalogExpr): C.CatalogExpr => C.ne(prosrc, C.text(""))

/**
 * A PL/pgSQL function's definition as PostgreSQL deparses it (pg_get_functiondef), its header alone: the definition is
 * its header, `AS `, its source between two dollar-quote tags and a line feed, the tag `$function` and an `x` for each
 * time the source holds one shorter, then `$` (ruleutils.c pg_get_functiondef), so the header is the definition but its
 * last `length(source) + 2 × tag + 1` characters, the tag's length found from the definition's end, where the reversed
 * definition holds `noitcnuf$` behind its line feed, its tag's `$` and the tag's `x`s. A stub replayed in the scratch
 * schema (snapshot/recorded.ts replayedStatement) and the installed function so describe their headers alike, and the
 * source is judged by its digest apart (sourcesQuery).
 */
const plpgsqlHeader = (oid: C.CatalogExpr, source: C.CatalogExpr): C.CatalogExpr => {
	const definition = (): C.CatalogExpr => C.catalogCall("pg_get_functiondef", [oid])
	const tag = C.plus(
		C.catalogCall("strpos", [C.catalogCall("reverse", [definition()]), C.text("noitcnuf$")]),
		C.literal(7n, "integer")
	)
	return C.catalogCall("left", [
		definition(),
		C.minus(
			C.minus(
				C.minus(C.catalogCall("length", [definition()]), C.catalogCall("length", [source])),
				C.times(C.literal(2n, "integer"), tag)
			),
			C.literal(1n, "integer")
		)
	])
}

/** `text` and `value`, joined: NULL where the value is, so concat_ws leaves the part out. */
const labelled = (text: string, value: C.CatalogExpr): C.CatalogExpr =>
	C.concat([C.text(text), value])

const owner = (oid: C.CatalogExpr): C.CatalogExpr =>
	labelled("owner ", C.asText(C.catalogCall("pg_get_userbyid", [oid])))

/** A name as PostgreSQL quotes it. */
const quoted = (name: C.CatalogExpr): C.CatalogExpr =>
	C.catalogCall("quote_ident", [C.asText(name)])

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
	C.catalogCall("concat_ws", [C.text("; "), ...items])

/** A key's parts: its kind, then the schema the keys spell ($2) and each name, quoted as PostgreSQL quotes it. */
const keyParts = (
	kind: string,
	names: NonEmptyReadonlyArray<C.CatalogExpr>
): NonEmptyReadonlyArray<C.CatalogExpr> => [
	C.text(`${kind} `),
	C.catalogCall("quote_ident", [C.param(2, "text")]),
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
/**
 * A manifest identity as physical/obligations/graph.ts spells it: `<kind>:`, the schema the keys spell ($2), then each
 * name as the catalog holds it, a dot before each.
 */
const identOf = (kind: string, names: NonEmptyReadonlyArray<C.CatalogExpr>): C.CatalogExpr =>
	C.concat([
		C.text(`${kind}:`),
		C.param(2, "text"),
		...Arr.flatMap(names, (n) => [C.text("."), C.asText(n)])
	])

/**
 * The identity of the relation `r` as a column, a constraint, a trigger, a policy, a rule, an index or a statistics
 * object lies in it: a table's (a partitioned or foreign one's alike), a view's, a materialized view's, or a row type's
 * (a relation of kind c); none for any other kind, in which nothing lies.
 */
const containerIdent = (r: C.CatalogSource): C.CatalogExpr => {
	const named = (kind: string) => identOf(kind, [r.col("relname")])
	return C.caseOf(
		r.col("relkind"),
		[
			{ when: C.letter("r"), result: named("table") },
			{ when: C.letter("p"), result: named("table") },
			{ when: C.letter("f"), result: named("table") },
			{ when: C.letter("v"), result: named("view") },
			{ when: C.letter("m"), result: named("materializedView") },
			{ when: C.letter("c"), result: named("type") }
		],
		undefined
	)
}

/** The identity of the relation of oid `oid` as something lies in it (containerIdent), by a scalar read. */
const containerOf = (oid: C.CatalogExpr): C.CatalogExpr => {
	const r = C.from("pg_class", "r")
	return C.scalar(C.query([containerIdent(r)], [r.item], C.eq(r.col("oid"), oid)))
}

/**
 * The identity a relation row `c` describes: a relation something lies in by its own (containerIdent); an index by
 * the key or exclusion constraint it backs, which the manifest installs as the constraint (`constraint:<s>.<t>.<k>`),
 * else by its own name (`index:`); a sequence by its own name, `sequence:`, which no manifest identity spells.
 */
const relationIdent = (c: C.CatalogSource): C.CatalogExpr => {
	const backed = (): C.CatalogExpr => {
		const k = C.from("pg_constraint", "k")
		const t = C.from("pg_class", "t")
		return C.scalar(
			C.query(
				[identOf("constraint", [t.col("relname"), k.col("conname")])],
				[C.join(k.item, t.item, C.eq(t.col("oid"), k.col("conrelid")))],
				C.and([
					C.eq(k.col("conindid"), c.col("oid")),
					C.inList(k.col("contype"), C.letters(["p", "u", "x"]))
				])
			)
		)
	}
	const index = (): C.CatalogExpr => C.coalesce([backed(), identOf("index", [c.col("relname")])])
	return C.coalesce([
		containerIdent(c),
		C.caseOf(
			c.col("relkind"),
			[
				{ when: C.letter("i"), result: index() },
				{ when: C.letter("I"), result: index() },
				{ when: C.letter("S"), result: identOf("sequence", [c.col("relname")]) }
			],
			undefined
		)
	])
}

/**
 * The identity of the relation a relation row `c` lies in: an index's, the relation it indexes; a sequence's, the table
 * of the column that owns it, its own where none does; every other relation's, its own (relationIdent).
 */
const relationWithin = (c: C.CatalogSource): C.CatalogExpr => {
	const indexed = (): C.CatalogExpr => {
		const i = C.from("pg_index", "i")
		return C.scalar(
			C.query([containerOf(i.col("indrelid"))], [i.item], C.eq(i.col("indexrelid"), c.col("oid")))
		)
	}
	const owning = (): C.CatalogExpr => {
		const d = C.from("pg_depend", "d")
		return C.scalar(
			C.select({
				...C.catalogCore(
					[containerOf(d.col("refobjid"))],
					[d.item],
					C.and([
						C.eq(d.col("classid"), C.catalogRegclass("pg_class")),
						C.eq(d.col("objid"), c.col("oid")),
						C.eq(d.col("refclassid"), C.catalogRegclass("pg_class")),
						C.inList(d.col("deptype"), C.letters(["a", "i"]))
					])
				),
				orderBy: [d.col("refobjid")],
				limit: 1
			})
		)
	}
	return C.caseOf(
		c.col("relkind"),
		[
			{ when: C.letter("i"), result: indexed() },
			{ when: C.letter("I"), result: indexed() },
			{ when: C.letter("S"), result: C.coalesce([owning(), relationIdent(c)]) }
		],
		relationIdent(c)
	)
}

/**
 * Each fact of a schema's description, four text columns: its key, the identity of the object it describes and of the
 * relation it lies in (the object's own for an object that lies in none), and its description; $1 the schema read, $2
 * the schema the keys and the identities spell. The two identities are the manifest's spellings
 * (physical/obligations/graph.ts), by which an object of the manifest owns the fact (factOwner).
 *
 * A view's or materialized view's own _RETURN rule is its definition, described with the view.
 *
 * A NOT NULL constraint is its column's `not null`, whatever its name, which a renamed table keeps from before.
 *
 * A statistics object's columns by name: PostgreSQL keeps them in column order (stxkeys), which differs between a
 * migrated table, whose retyped column was added last, and a fresh one.
 *
 * A relation's replica identity and its row security are facts of their own, `replica identity <s>.<t>` of a table's
 * or materialized view's and `row security <s>.<t>` of a table's, never parts of the relation's: an object of the
 * manifest sets each (`replicaIdentity:`, `rowSecurity:`), the table's other facts are its own, and so every fact is
 * one object's.
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
						C.catalogCall("format_type", [q.col("seqtypid"), C.literal(-1n, "integer")]),
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
				...C.catalogCore(
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
						C.catalogCall("pg_get_expr", [d.col("adbin"), d.col("adrelid")])
					])
				],
				[d.item],
				C.and([C.eq(d.col("adrelid"), a.col("attrelid")), C.eq(d.col("adnum"), a.col("attnum"))])
			)
		)
	}
	const statisticsColumns = (): C.CatalogExpr => {
		const u = C.fromFunction(C.catalogCall("unnest", [x.col("stxkeys")]), "u", ["n"], false)
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
		const o = C.fromFunction(
			C.catalogCall("unnest", [policy.col("polroles")]),
			"o",
			["role"],
			false
		)
		const roleName = C.asText(C.catalogCall("pg_get_userbyid", [o.col("role")]))
		return C.scalar(
			C.query(
				[
					labelled(
						"to ",
						C.joinedSet(C.collateC(C.catalogCall("quote_ident", [roleName])), C.text(", "))
					)
				],
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
	/** A domain's identity, `domain:`, and any other type's, `type:`. */
	const typeIdent = (of: C.CatalogSource): C.CatalogExpr =>
		C.caseOf(
			of.col("typtype"),
			[{ when: C.letter("d"), result: identOf("domain", [of.col("typname")]) }],
			identOf("type", [of.col("typname")])
		)
	const relations = C.inNamespace(c.item, n, c.col("relnamespace"))
	return C.union([
		C.catalogCore(
			[
				C.concat([C.text("schema "), C.catalogCall("quote_ident", [C.param(2, "text")])]),
				C.concat([C.text("schema:"), C.param(2, "text")]),
				C.concat([C.text("schema:"), C.param(2, "text")]),
				parts([owner(n.col("nspowner"))])
			],
			[n.item],
			inSchema(n)
		),
		C.catalogCore(
			[
				keyOf("relation", [c.col("relname")]),
				relationIdent(c),
				relationWithin(c),
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
					C.caseWhen(
						[
							{
								when: C.inList(c.col("relkind"), C.letters(["m", "v"])),
								result: labelled(
									"as ",
									C.catalogCall("pg_get_viewdef", [c.col("oid"), C.bool(false)])
								)
							},
							{
								when: C.inList(c.col("relkind"), C.letters(["i", "I"])),
								result: C.catalogCall("pg_get_indexdef", [c.col("oid")])
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
		C.catalogCore(
			[
				keyOf("replica identity", [c.col("relname")]),
				identOf("replicaIdentity", [c.col("relname")]),
				containerIdent(c),
				C.asText(c.col("relreplident"))
			],
			[relations],
			C.and([
				inSchema(n),
				C.inList(c.col("relkind"), C.letters(["r", "p", "m"])),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.catalogCore(
			[
				keyOf("row security", [c.col("relname")]),
				identOf("rowSecurity", [c.col("relname")]),
				containerIdent(c),
				parts([
					C.caseWhen(
						[{ when: c.col("relrowsecurity"), result: C.text("enabled") }],
						C.text("disabled")
					),
					when(c.col("relforcerowsecurity"), C.text("forced"))
				])
			],
			[relations],
			C.and([
				inSchema(n),
				C.inList(c.col("relkind"), C.letters(["r", "p"])),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.catalogCore(
			[
				keyOf("column", [c.col("relname"), a.col("attname")]),
				identOf("column", [c.col("relname"), a.col("attname")]),
				containerIdent(c),
				parts([
					C.catalogCall("format_type", [a.col("atttypid"), a.col("atttypmod")]),
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
				C.inNamespace(
					C.join(a.item, c.item, C.eq(c.col("oid"), a.col("attrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([
				inSchema(n),
				C.inList(c.col("relkind"), C.letters(["r", "p", "f", "c"])),
				C.gt(a.col("attnum"), C.literal(0n, "smallint")),
				C.not(a.col("attisdropped")),
				notExtensionMember("pg_class", c.col("oid"))
			])
		),
		C.catalogCore(
			[
				keyOf("constraint", [c.col("relname"), k.col("conname")]),
				identOf("constraint", [c.col("relname"), k.col("conname")]),
				containerIdent(c),
				C.catalogCall("pg_get_constraintdef", [k.col("oid")])
			],
			[
				C.inNamespace(
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
		C.catalogCore(
			[
				keyOf("domain constraint", [t.col("typname"), k.col("conname")]),
				identOf("domain", [t.col("typname")]),
				identOf("domain", [t.col("typname")]),
				C.catalogCall("pg_get_constraintdef", [k.col("oid")])
			],
			[
				C.inNamespace(
					C.join(k.item, t.item, C.eq(t.col("oid"), k.col("contypid"))),
					n,
					t.col("typnamespace")
				)
			],
			C.and([inSchema(n), notExtensionMember("pg_type", t.col("oid"))])
		),
		C.catalogCore(
			[
				keyOf("type", [t.col("typname")]),
				typeIdent(t),
				typeIdent(t),
				parts([
					labelled("kind ", C.asText(t.col("typtype"))),
					owner(t.col("typowner")),
					when(
						C.eq(t.col("typtype"), C.letter("d")),
						labelled(
							"over ",
							C.catalogCall("format_type", [t.col("typbasetype"), t.col("typtypmod")])
						)
					),
					collationOf(t.col("typcollation")),
					when(t.col("typnotnull"), C.text("not null")),
					labelled(
						"default ",
						C.catalogCall("pg_get_expr", [t.col("typdefaultbin"), C.literal(0n, "oid")])
					)
				])
			],
			[C.inNamespace(t.item, n, t.col("typnamespace"))],
			C.and([inSchema(n), notComposite(), notArray(), notExtensionMember("pg_type", t.col("oid"))])
		),
		C.catalogCore(
			[
				C.concat([
					...keyParts("function", [p.col("proname")]),
					C.text("("),
					C.catalogCall("pg_get_function_identity_arguments", [p.col("oid")]),
					C.text(")")
				]),
				identOf("function", [p.col("proname")]),
				identOf("function", [p.col("proname")]),
				parts([
					owner(p.col("proowner")),
					C.caseWhen(
						[
							{
								when: C.and([
									C.eq(p.col("provolatile"), C.letter("i")),
									C.not(stringBodied(p.col("prosrc")))
								]),
								result: labelled(
									"constant returning ",
									C.catalogCall("format_type", [p.col("prorettype"), C.literal(-1n, "integer")])
								)
							},
							{
								when: C.and([C.eq(p.col("prokind"), C.letter("f")), stringBodied(p.col("prosrc"))]),
								result: plpgsqlHeader(p.col("oid"), p.col("prosrc"))
							},
							{
								when: C.inList(p.col("prokind"), C.letters(["f", "p"])),
								result: C.catalogCall("pg_get_functiondef", [p.col("oid")])
							}
						],
						labelled("kind ", C.asText(p.col("prokind")))
					)
				])
			],
			[C.inNamespace(p.item, n, p.col("pronamespace"))],
			C.and([inSchema(n), notExtensionMember("pg_proc", p.col("oid"))])
		),
		C.catalogCore(
			[
				keyOf("trigger", [c.col("relname"), g.col("tgname")]),
				identOf("trigger", [c.col("relname"), g.col("tgname")]),
				containerIdent(c),
				parts([
					C.catalogCall("pg_get_triggerdef", [g.col("oid"), C.bool(false)]),
					when(
						C.ne(g.col("tgenabled"), C.letter("O")),
						labelled("enabled ", C.asText(g.col("tgenabled")))
					)
				])
			],
			[
				C.inNamespace(
					C.join(g.item, c.item, C.eq(c.col("oid"), g.col("tgrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			C.and([inSchema(n), C.not(g.col("tgisinternal"))])
		),
		C.catalogCore(
			[
				keyOf("statistics", [x.col("stxname")]),
				identOf("statistics", [x.col("stxname")]),
				containerOf(x.col("stxrelid")),
				parts([
					owner(x.col("stxowner")),
					labelled("kinds ", C.asText(x.col("stxkind"))),
					statisticsColumns(),
					labelled(
						"expressions ",
						C.asText(C.catalogCall("pg_get_statisticsobjdef_expressions", [x.col("oid")]))
					),
					statisticsTable()
				])
			],
			[C.inNamespace(x.item, n, x.col("stxnamespace"))],
			inSchema(n)
		),
		C.catalogCore(
			[
				keyOf("policy", [c.col("relname"), policy.col("polname")]),
				identOf("policy", [c.col("relname"), policy.col("polname")]),
				containerIdent(c),
				parts([
					labelled("command ", C.asText(policy.col("polcmd"))),
					C.caseWhen(
						[{ when: policy.col("polpermissive"), result: C.text("permissive") }],
						C.text("restrictive")
					),
					labelled(
						"using ",
						C.catalogCall("pg_get_expr", [policy.col("polqual"), policy.col("polrelid")])
					),
					labelled(
						"check ",
						C.catalogCall("pg_get_expr", [policy.col("polwithcheck"), policy.col("polrelid")])
					),
					policyRoles()
				])
			],
			[
				C.inNamespace(
					C.join(policy.item, c.item, C.eq(c.col("oid"), policy.col("polrelid"))),
					n,
					c.col("relnamespace")
				)
			],
			inSchema(n)
		),
		C.catalogCore(
			[
				keyOf("rule", [c.col("relname"), rule.col("rulename")]),
				identOf("rule", [c.col("relname"), rule.col("rulename")]),
				containerIdent(c),
				C.catalogCall("pg_get_ruledef", [rule.col("oid"), C.bool(false)])
			],
			[
				C.inNamespace(
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

/**
 * A fact of a schema's description (descriptionSelect): its key, the identity of the object it describes, the identity
 * of the relation it lies in, and its description.
 */
export interface Fact {
	readonly key: string
	readonly object: string
	readonly within: string
	readonly description: string
}

const descriptions: CatalogQuery<Fact> = {
	sql: emitCatalog(descriptionSelect()),
	what: "a fact's key, its object's and its relation's identities, and its description",
	row: ([key, object, within, description]) =>
		key === undefined || object === undefined || within === undefined || description === undefined
			? undefined
			: { key, object, within, description }
}

/**
 * Every PL/pgSQL function of the schemas $1 names, as three text columns: its schema, its name, and its source's digest,
 * the SHA-256 of pg_proc.prosrc's UTF-8, in lowercase hex, which the snapshot records of each (snapshot/recorded.ts
 * SourceDigest).
 */
const sourcesQuery: CatalogQuery<readonly [string, string, string]> = (() => {
	const n = C.from("pg_namespace", "n")
	const p = C.from("pg_proc", "p")
	return {
		sql: emitCatalog(
			C.query(
				[
					C.asText(n.col("nspname")),
					C.asText(p.col("proname")),
					C.catalogCall("encode", [
						C.catalogCall("sha256", [
							C.catalogCall("convert_to", [p.col("prosrc"), C.literal("UTF8", "name")])
						]),
						C.text("hex")
					])
				],
				[C.inNamespace(p.item, n, p.col("pronamespace"))],
				C.and([
					C.any(n.col("nspname"), C.arrayParam(1, "text")),
					C.eq(p.col("prokind"), C.letter("f")),
					stringBodied(p.col("prosrc")),
					notExtensionMember("pg_proc", p.col("oid"))
				])
			)
		),
		what: "a function's schema, its name and its source's digest",
		row: ([schema, name, source]) =>
			schema === undefined || name === undefined || source === undefined
				? undefined
				: [schema, name, source]
	}
})()

/**
 * Each recorded source that the installed function of its name does not hold: where the installed schema holds exactly
 * one PL/pgSQL function of the name, its source's digest is the record's. One it lacks, or holds twice over, is a
 * missing or unexpected function the descriptions find by its key.
 */
const sourceMismatches = (
	recorded: ReadonlyArray<RecordedSource>,
	installed: ReadonlyArray<readonly [string, string, string]>,
	folders: ReadonlyArray<DriftFolder>
): ReadonlyArray<SourceMismatch> => {
	const byName = Arr.groupBy(installed, ([schema, name]) => `${schema}.${name}`)
	return Arr.flatMap(recorded, (r): ReadonlyArray<SourceMismatch> => {
		const held = byName[`${r.function.schema}.${r.function.name}`] ?? []
		const [only, second] = held
		return only === undefined || second !== undefined || only[2] === r.source
			? []
			: [
					{
						object: qualifiedIdent("function", r.function.schema, r.function.name),
						mismatch: {
							kind: "source",
							fact: `source of function ${printObjectName(r.function)}`,
							expected: r.source,
							installed: only[2],
							definedBy: definitionOf(folders, r.function)
						}
					}
				]
	})
}

/** A recorded source the installed function does not hold (sourceMismatches): the function's manifest identity, and
 * the mismatch the report prints. */
interface SourceMismatch {
	readonly object: string
	readonly mismatch: DriftMismatch
}

/** A name as PostgreSQL prints it. */
const quotedIdent: CatalogQuery<string> = {
	sql: emitCatalog(C.query([C.catalogCall("quote_ident", [C.param(1, "text")])], [], undefined)),
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
			[C.inNamespace(extensions.item, extensionNamespaces, extensions.col("extnamespace"))],
			C.eq(extensions.col("extname"), C.param(1, "text"))
		)
	),
	what: "a schema name",
	row: ([schema]) => schema
}

const replicationSlots = C.from("pg_replication_slots", "s")

/**
 * The replication slots of the current database whose names end in the live source's stem $1 (core/identity.ts
 * identity.liveSource): each one a leader of format 7 or before made, named by its decoder login, where a leader of
 * this grizzle names its slot by the stem, `_` and the database (liveSlotOf), whose name ends in no stem. No mismatch,
 * since a slot is no object of the installation's, but `grizzle upgrade` drops each (upgrade.ts liveObjects).
 */
const formerSlotsQuery: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query(
			[C.asText(replicationSlots.col("slot_name"))],
			[replicationSlots.item],
			C.and([
				C.eq(replicationSlots.col("database"), C.catalogCall("current_database", [])),
				C.eq(
					C.catalogCall("right", [
						C.asText(replicationSlots.col("slot_name")),
						C.catalogCall("length", [C.param(1, "text")])
					]),
					C.param(1, "text")
				)
			])
		)
	),
	what: "a replication slot's name",
	row: ([name]) => name
}

const publications = C.from("pg_publication", "p")
const published = C.from("pg_publication_rel", "r")
const publishedTables = C.from("pg_class", "c")
const publishedSchemas = C.from("pg_namespace", "n")
const publishedColumns = C.from("pg_attribute", "a")

/**
 * The description of the publication $1, the installation's live source's, which no scratch schema can hold, since a
 * publication is the database's: its own row, keyed `publication <name>`, described by the changes it publishes,
 * whether it publishes stored generated columns, and whether it publishes every table or a partition through its root;
 * and each table it publishes, keyed `publication <name> table <schema>.<table>`, described by its column list's
 * columns in byte order, or `whole` for a table published with none. None where no such publication stands.
 */
const publicationQuery: CatalogQuery<readonly [string, string]> = {
	sql: emitCatalog(
		C.union([
			C.catalogCore(
				[
					C.concat([C.text("publication "), C.asText(publications.col("pubname"))]),
					C.catalogCall("concat_ws", [
						C.text(" "),
						C.catalogCall("concat_ws", [
							C.text(","),
							C.caseWhen(
								[{ when: publications.col("pubinsert"), result: C.text("insert") }],
								undefined
							),
							C.caseWhen(
								[{ when: publications.col("pubupdate"), result: C.text("update") }],
								undefined
							),
							C.caseWhen(
								[{ when: publications.col("pubdelete"), result: C.text("delete") }],
								undefined
							),
							C.caseWhen(
								[{ when: publications.col("pubtruncate"), result: C.text("truncate") }],
								undefined
							)
						]),
						C.concat([C.text("generated "), C.asText(publications.col("pubgencols"))]),
						C.concat([C.text("all "), C.asText(publications.col("puballtables"))]),
						C.concat([C.text("root "), C.asText(publications.col("pubviaroot"))])
					])
				],
				[publications.item],
				C.eq(publications.col("pubname"), C.param(1, "name"))
			),
			C.catalogCore(
				[
					C.concat([
						C.text("publication "),
						C.asText(publications.col("pubname")),
						C.text(" table "),
						C.asText(publishedSchemas.col("nspname")),
						C.text("."),
						C.asText(publishedTables.col("relname"))
					]),
					C.coalesce([
						C.scalar(
							C.query(
								[C.joinedSet(C.collateC(C.asText(publishedColumns.col("attname"))), C.text(", "))],
								[publishedColumns.item],
								C.and([
									C.eq(publishedColumns.col("attrelid"), publishedTables.col("oid")),
									C.any(publishedColumns.col("attnum"), published.col("prattrs"))
								])
							)
						),
						C.text("whole")
					])
				],
				[
					C.inNamespace(
						C.join(
							C.join(
								published.item,
								publications.item,
								C.eq(publications.col("oid"), published.col("prpubid"))
							),
							publishedTables.item,
							C.eq(publishedTables.col("oid"), published.col("prrelid"))
						),
						publishedSchemas,
						publishedTables.col("relnamespace")
					)
				],
				C.eq(publications.col("pubname"), C.param(1, "name"))
			)
		])
	),
	what: "a publication's key and its description",
	row: ([key, description]) =>
		key === undefined || description === undefined ? undefined : [key, description]
}

/** The description a CREATE PUBLICATION of the snapshot's states, as publicationQuery reads one back. */
const expectedPublication = (s: CreatePublication): ReadonlyMap<string, string> =>
	new Map([
		[
			`publication ${s.name}`,
			"insert,update,delete,truncate generated s all false root false"
		] as const,
		...Arr.map(
			s.tables,
			(p) =>
				[
					`publication ${s.name} table ${p.table.schema}.${p.table.name}`,
					p.columns.kind === "whole"
						? "whole"
						: Arr.join(Arr.sort(p.columns.columns, Order.String), ", ")
				] as const
		)
	])

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
 * each installed schema created as its scratch one and an index built in the transaction, never concurrently, and a
 * declared function handed over to the function owner in its scratch schema, as in its installed one; nothing for a
 * role, a membership, a grant, a default privilege, a database default, an extension, a comment or a query.
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
		case "stubConstant":
		case "packConstant":
		case "createMaterializedView":
		case "createView":
		case "createPolicy":
		case "createFunction":
		case "createDeclaredFunction":
		case "handOverFunction":
		case "createRowType":
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "createStatistics":
		case "createLiveSecret":
			return [transformStatement(s, hooks)]
		case "createPublication":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "adoptRole":
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

/** The role of `of` `stem` past PostgreSQL's longest identifier under the installation's role prefix, as the
 * snapshot's refusal, IdentifierTooLong. */
const roleTooLong = (
	of: "login" | "role",
	stem: string,
	fault: InstalledRoleTooLong
): CompileError =>
	CompileError.make({
		_tag: "IdentifierTooLong",
		at: SourceLoc("rolePrefix", []),
		declaration: `${of} ${stem}`,
		identifier: fault.role,
		bytes: fault.bytes,
		limit: fault.limit
	})

/** A replayed statement's variable no installation fills, as the snapshot's refusal: a manifest that names a role by
 * no stem, or a role the installation's role prefix makes too long. */
const unfilled = (fault: VariableFault): CompileError =>
	fault.kind === "roleTooLong"
		? roleTooLong("role", fault.name, fault)
		: malformedArtifact("manifest", [], `a role named by its stem, not ${fault.name}`)

/** A statement of the replay: its text and the object of the manifest it builds. */
interface ReplayText {
	readonly object: string
	readonly text: EmittedText
}

/**
 * The texts that build `objects` in the scratch schemas, in the manifest's order, one text a command, as a driver sends
 * a statement of several, each policy's role and each function's owner filled as the installation names it.
 */
const scratchStatements = (
	objects: ReadonlyArray<ReplayedObject>,
	scratchOf: ReadonlyMap<string, TypeSchema>,
	installation: InstallationNames
): Result.Result<ReadonlyArray<ReplayText>, CompileError> => {
	const texts: Array<ReplayText> = []
	for (const o of objects) {
		for (const d of Arr.flatMap(o.statements, (s) => inScratch(s, scratchOf))) {
			const commands = emitCommands(d)
			if (!commands.ok) {
				return Result.fail(commands.error)
			}
			for (const command of commands.value) {
				const filled = filledText(command, (text) => resolveVariables(text, installation))
				if (!filled.ok) {
					return Result.fail(unfilled(filled.error))
				}
				texts.push({ object: o.ident, text: filled.value })
			}
		}
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
 * The installed descriptions against the snapshot's: each key only one side has, missing or unexpected, and each key
 * whose descriptions differ, by its two descriptions.
 */
const compareDescriptions = (
	expected: ReadonlyMap<string, string>,
	installed: ReadonlyMap<string, string>
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	const fact = (key: string, description: string) => `${key} as ${description}`
	for (const [key, want] of expected) {
		const have = installed.get(key)
		if (have === undefined) {
			out.push({ kind: "missing", fact: fact(key, want) })
		} else if (have !== want) {
			out.push({ kind: "differs", fact: key, expected: want, installed: have })
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
				{
					kind: "differs",
					fact: `${at} setting ${d.parameter}`,
					expected: d.expected,
					installed: d.observed
				}
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

const command = (sql: EmittedText): BatchStatement => oneShotStatement(sql, [])

/** A catalog statement's place in a flight: its rows read back from the flight's outcomes, at the position it was sent
 * at, captured when it was sent (Sending), so no reader counts positions. */
interface Slot<Row> {
	readonly rows: (
		outcomes: ReadonlyArray<BatchOutcome>
	) => Result.Result<ReadonlyArray<Row>, CatalogRowRefused>
	readonly row: (outcomes: ReadonlyArray<BatchOutcome>) => Result.Result<Row, CatalogRowRefused>
}

/** Where in its flight the replay sits: its first statement's position, and the object each of its statements builds,
 * in order. */
export interface ReplaySpan {
	readonly from: number
	readonly objects: ReadonlyArray<string>
}

/** A flight's statements as they are sent, in order: a command, whose outcome nothing reads, the replay, whose span the
 * flight's failure is located by, or a catalog query, read through the slot it is sent into. */
interface Sending {
	readonly statements: ReadonlyArray<BatchStatement>
	readonly command: (sql: EmittedText) => void
	readonly replay: (texts: ReadonlyArray<ReplayText>) => ReplaySpan
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
		replay: (texts) => {
			const from = statements.length
			for (const t of texts) {
				sent(command(t.text))
			}
			return { from, objects: Arr.map(texts, (t) => t.object) }
		},
		query: (query, params) => {
			const at = sent(oneShotStatement(query.sql, params))
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

/**
 * A row of the drift check's proofs (deploy/ledger/ledger.ts proofsTable): an object's manifest identity, its proof
 * digest (deploy/admission/proof.ts) and the digest of PostgreSQL's description of it (descriptionDigest).
 */
export interface ProofRow {
	readonly object: string
	readonly ddl: string
	readonly description: string
}

/** The proofs' rows statement of `statements` (proofStatements), each row its three texts as a migrate wrote them. */
const proofRowsQuery = (statements: ProofStatements): CatalogQuery<ProofRow> => ({
	sql: statements.rows.text,
	what: "a proof's object, its proof digest and its description's digest",
	row: ([object, ddl, description]) =>
		object === undefined || ddl === undefined || description === undefined
			? undefined
			: { object, ddl, description }
})

/**
 * The catalog read of whether a schema's proofs' table exists (migrate/ledger.ts tableExists): it does not before the
 * migration that creates it, and then no statement names it, so no refusal of a missing relation is ever read as none.
 */
export const proofsExistRead = (schema: string): BatchStatement =>
	oneShotStatement(tableExists.sql, [textParam(schema), textParam(proofsTableName)])

/** Whether a schema's proofs' table exists, from its catalog read's answer (proofsExistRead). */
export const proofsPresence = (
	exists: ApartAnswer
): Result.Result<"absent" | "present", ServerError | CatalogRowRefused> =>
	Result.map(apartRow(tableExists, exists), (present) => (present ? "present" : "absent"))

/** The read of a schema's proofs' rows, sent only where their catalog read found the table. */
export const proofRowsRead = (statements: ProofStatements): BatchStatement =>
	oneShotStatement(statements.rows.text, [])

/**
 * The proofs by object, from their rows read's answer (proofRowsRead). A row is a fact about the server
 * (deploy/ledger/ledger.ts proofsTable), so reading them apart from the drift check's snapshot loses nothing.
 */
export const heldProofs = (
	statements: ProofStatements,
	rows: ApartAnswer
): Result.Result<ReadonlyMap<string, ProofRow>, ServerError | CatalogRowRefused> =>
	Result.map(
		apartRows(proofRowsQuery(statements), rows),
		(held) => new Map(Arr.map(held, (row) => [row.object, row] as const))
	)

/**
 * What the server says of itself that a description is a function of beside the statements replayed: its version, as a
 * number and as its release names it (19rc1 is no 19.0), the role the check runs as, which owns every object a replay
 * creates and every installed one, and each extension with its version, by name, whose types, operators and classes a
 * deparse may spell.
 */
interface ServerEnvironment {
	readonly versionNumber: string
	readonly version: string
	readonly user: string
	readonly extensions: string
}

const environmentQuery: CatalogQuery<ServerEnvironment> = (() => {
	const x = C.from("pg_extension", "x")
	return {
		sql: emitCatalog(
			C.query(
				[
					C.catalogCall("current_setting", [C.text("server_version_num")]),
					C.catalogCall("current_setting", [C.text("server_version")]),
					C.asText(C.currentUser),
					C.coalesce([
						C.scalar(
							C.query(
								[
									C.joinedSet(
										C.collateC(
											C.concat([
												C.asText(x.col("extname")),
												C.text(" "),
												C.asText(x.col("extversion"))
											])
										),
										C.text(", ")
									)
								],
								[x.item],
								undefined
							)
						),
						C.text("")
					])
				],
				[],
				undefined
			)
		),
		what: "the server's version, its role and its extensions",
		row: ([versionNumber, version, user, extended]) =>
			versionNumber === undefined ||
			version === undefined ||
			user === undefined ||
			extended === undefined
				? undefined
				: { versionNumber, version, user, extensions: extended }
	}
})()

/** Texts as one, each framed by its length, so one text frames exactly one list: texts PostgreSQL and grizzle hold,
 * well-formed (`wellFormed`). */
const framed = (texts: ReadonlyArray<string>): WellFormedText =>
	wellFormed(
		Arr.join(
			Arr.map(texts, (t) => `${t.length}:${t}`),
			""
		)
	)

/**
 * The environment every proof digest digests (deploy/admission/proof.ts): the server's (ServerEnvironment), the text of
 * the statement that describes a schema, and the installation's names, which fill a replayed policy's roles.
 */
const proofEnvironment = (server: ServerEnvironment, installation: InstallationNames): string =>
	sha256Hex(
		framed([
			server.versionNumber,
			server.version,
			server.user,
			server.extensions,
			descriptions.sql,
			installation.database,
			installation.roles.kind === "stems" ? "stems" : `prefixed ${installation.roles.prefix}`
		])
	)

/**
 * Whether PostgreSQL describes an object of each kind of manifest identity, every kind decided here, so a new kind is a
 * type error until it is: the objects a fact names (descriptionSelect), which the drift check owns its facts by, proves
 * and replays, a declared function's row type (`type:`, a composite, its relation and its columns) among them; and the
 * kinds with no description (a role, a membership, a grant, the publication, an extension, and a validation's
 * identity, `other`), which the reads beside the descriptions judge.
 */
const describedKind: { readonly [K in GraphIdent["kind"]]: boolean } = {
	schema: true,
	extension: false,
	role: false,
	membership: false,
	privileges: false,
	publication: false,
	domain: true,
	type: true,
	table: true,
	materializedView: true,
	view: true,
	index: true,
	statistics: true,
	function: true,
	rowSecurity: true,
	replicaIdentity: true,
	column: true,
	constraint: true,
	trigger: true,
	policy: true,
	other: false
}

const isDescribed = (ident: string): boolean => describedKind[parseIdent(ident).kind]

/**
 * The object of the installation a fact is a fact of, among the objects it describes (`described`): the object it
 * describes, where the manifest holds it, else the relation it lies in, where the manifest holds that, as a column its
 * table's CREATE TABLE declares is the table's; none for a fact of nothing the installation creates.
 */
const factOwner = (described: ReadonlySet<string>, f: Fact): string | undefined =>
	described.has(f.object) ? f.object : described.has(f.within) ? f.within : undefined

const byKey: Order.Order<Fact> = Order.Struct({ key: Order.String })

/**
 * The digest of an object's description, its facts in key order, each key and description framed by its length: what
 * the proofs record of what PostgreSQL describes of the object. An object with no fact has the digest of none.
 */
const descriptionDigest = (facts: ReadonlyArray<Fact>): string =>
	sha256Hex(
		framed(
			Arr.flatMap(Arr.sort(facts, byKey), (f: Fact): ReadonlyArray<string> => [
				f.key,
				f.description
			])
		)
	)

/** Facts as compareDescriptions reads them: each key with its description. */
const keyed = (facts: ReadonlyArray<Fact>): ReadonlyMap<string, string> =>
	new Map(Arr.map(facts, (f) => [f.key, f.description] as const))

/**
 * What a migrate records of a drift check that found no drift: nothing, where the proofs hold the check's rows already
 * (`held`); else every row the check found (`record`), each object of the installation PostgreSQL describes by its
 * proof digest and its installed description's digest, in identity order, in place of the ones it read.
 */
export type ProofRecord =
	| { readonly kind: "held" }
	| { readonly kind: "record"; readonly rows: ReadonlyArray<ProofRow> }

/**
 * What a drift check found: every mismatch, by fact; the manifest identity of every object it replayed, in install
 * order (driftCheck); and what a migrate records of its proofs (ProofRecord).
 */
export interface DriftVerdict {
	readonly mismatches: ReadonlyArray<DriftMismatch>
	readonly replayed: ReadonlyArray<string>
	readonly proofs: ProofRecord
	/** What the check found, by object and by role, as `grizzle upgrade` judges a live installation by (DriftFound). */
	readonly found: DriftFound
}

/** A privilege of a role that differs from the snapshot's (roles.ts PrivilegeDifference), with the role. */
export interface RolePrivilege {
	readonly role: string
	readonly difference: PrivilegeDifference
}

/** A policy naming a role that the snapshot creates and the database lacks, or the reverse (roles.ts PolicyDifference). */
export interface RolePolicy {
	readonly role: string
	readonly difference: PolicyDifference
}

/** The facts beside the descriptions (driftCheck's `beside`): every mismatch, the report's, and the ones `grizzle
 * upgrade` reads apart: each PL/pgSQL function whose source differs, by identity, each differing privilege and policy,
 * by role, and every other (`others`): an extension's schema, a publication, a setting, a default privilege, and a
 * role's attributes, memberships and members. */
interface Beside {
	readonly mismatches: ReadonlyArray<DriftMismatch>
	readonly sources: ReadonlySet<string>
	readonly privileges: ReadonlyArray<RolePrivilege>
	readonly policies: ReadonlyArray<RolePolicy>
	readonly others: ReadonlyArray<DriftMismatch>
	readonly formerDefault: boolean
	readonly formerSlots: ReadonlyArray<string>
}

/**
 * What a drift check found, beside its mismatches, as `grizzle upgrade` reads it (adapter/admission/upgrade.ts): the
 * identity of every object of the snapshot PostgreSQL describes, the ones a row of the proofs proves, and the facts
 * compared fact by fact, the replay's renamed to the installed schemas (`expected`) and the database's (`installed`):
 * every fact of each object no row proves, and every fact the database holds that no object of the snapshot owns
 * (factOwner); each function whose source is not the record's; each privilege and policy naming a role that differs;
 * and every other fact beside them that differs.
 */
export interface DriftFound {
	readonly described: ReadonlySet<string>
	readonly proven: ReadonlySet<string>
	readonly expected: ReadonlyArray<Fact>
	readonly installed: ReadonlyArray<Fact>
	readonly sources: ReadonlySet<string>
	readonly privileges: ReadonlyArray<RolePrivilege>
	readonly policies: ReadonlyArray<RolePolicy>
	/** Every other fact beside the descriptions that differs (Beside `others`). */
	readonly others: ReadonlyArray<DriftMismatch>
	/**
	 * Whether the database holds the default an installation of format 7 or before set, default_transaction_isolation
	 * serializable (admission/roles.ts formerDefaultHeld): no mismatch, since grizzle sets no database default and reads
	 * none, but `grizzle upgrade` resets it (upgrade.ts liveObjects).
	 */
	readonly formerDefault: boolean
	/**
	 * The replication slots of the database a leader of format 7 or before made for the installation's live source, each
	 * named by its decoder login (formerSlotsQuery): no mismatch, since a slot is no object of the installation's, but
	 * `grizzle upgrade` drops each, which nothing else drops and which holds its WAL while it stands.
	 */
	readonly formerSlots: ReadonlyArray<string>
}

/**
 * What the drift check's second flight carries: the replay, where it sits among the flight's statements, and how the
 * flight's outcomes read.
 */
export interface DriftReplay {
	readonly replay: ReplaySpan
	readonly read: (
		second: ReadonlyArray<BatchOutcome>
	) => Result.Result<DriftVerdict, CatalogRowRefused>
}

/**
 * The drift check of a snapshot as its two flights (session.ts alongside): `first`, the reads of the installed
 * database, and `after`, the second flight made of the first's outcomes and of the proofs a read beside it found
 * (proofRowsQuery), by object.
 */
export interface DriftCheck {
	readonly first: ReadonlyArray<BatchStatement>
	readonly after: (
		proofs: ReadonlyMap<string, ProofRow>,
		first: ReadonlyArray<BatchOutcome>
	) => Result.Result<SecondFlight<DriftReplay>, CatalogRowRefused | CompileError>
}

/**
 * The drift check of `snapshot`'s schema, installed as `installation` names its roles (deploy/admission/roles.ts
 * installedExpectation), as the statements of driftTransaction's two flights, each read through the slot it is sent
 * into (Sending).
 *
 * The first flight reads the installed database, the snapshot it reads them in being the transaction's: the closed
 * search path first (sql/ast.ts closedSearchPath), against which every description is spelled, since PostgreSQL's
 * deparsers spell a name bare exactly when the path finds it first; the server's environment (ServerEnvironment); each
 * installed schema's name as PostgreSQL prints it, the installed schema's first and then each role's; each schema's
 * installed description; then each PL/pgSQL function's source, each extension's schema, the publications, the
 * database's settings, the owner's default privileges (none for the empty snapshot, which alters no default), and each
 * login's and role's login, settings, privileges, memberships and policies.
 *
 * Between the flights, on the host: each installed fact is its object's (factOwner), and every object the manifest
 * holds of a kind PostgreSQL describes is proven, or not. A proven one has a row of the proofs that holds its proof
 * digest (deploy/admission/proof.ts), under this server's environment, and the digest of its installed description:
 * the description that digest replayed to once, the object installed as it was then. Every other object is unproven:
 * one with no row (the first check, or a new object), one whose proof digest moved (its statements changed, or an
 * object it is created after, or the environment, which every digest digests), and one whose installed description is
 * no longer its row's, an edit by hand among them.
 *
 * The second flight replays every unproven object and every object one is created after (deploy/admission/proof.ts
 * replayedOver) into the scratch schemas, then reads each scratch schema's description. The facts of the unproven
 * objects, and every fact no object of the manifest owns, are compared fact by fact, the scratch ones renamed to the
 * installed schemas (fromScratch): one only the replay has is missing, one only the database has unexpected, one both
 * have with two descriptions differs. A proven object needs no replay, and one replayed only for an unproven one
 * created after it is held to its proof alone: its installed description is the one its proof says it has. So the
 * replay is bounded by the unproven objects and what they are created after, the whole manifest when no row proves
 * anything, and none when every object is proven.
 */
export const driftCheck = (
	snapshot: DeploySnapshot,
	installation: InstallationNames,
	folders: ReadonlyArray<DriftFolder>
): Result.Result<DriftCheck, CompileError> =>
	Result.gen(function* () {
		const schema = snapshot.schema
		const { objects, statements } = yield* toResult(manifestStatements(snapshot))
		const sources = recordedSources(snapshot)
		const schemas = judgedSchemas(statements, schema)
		const scratchOf = new Map(Arr.map(schemas, (s) => [s, scratchSchema(s)] as const))
		const createdExtensions = Arr.flatMap(statements, (s) =>
			s.kind === "createExtension" ? [s] : []
		)
		const roles: Array<RoleExpectation> = []
		const decoder = decoderLoginOf(snapshot.manifest.objects)
		for (const stem of manifestRoles(statements)) {
			const expected = roleExpectation(statements, schema, stem, decoder)
			const installed = installedExpectation(expected, installation.roles)
			if (!installed.ok) {
				return yield* Result.fail(
					roleTooLong(expected.login ? "login" : "role", stem, installed.error)
				)
			}
			roles.push(installed.value)
		}
		const described = new Set(Arr.flatMap(objects, (o) => (isDescribed(o.ident) ? [o.ident] : [])))
		const flight = sending()
		flight.command(emitCatalog(C.setClosedSearchPath))
		const environment = flight.query(environmentQuery, [])
		const printed = Arr.map(schemas, (s) => ({
			schema: s,
			slot: flight.query(quotedIdent, [textParam(s)])
		}))
		const installedFacts = Arr.map(schemas, (s) =>
			flight.query(descriptions, [textParam(s), textParam(s)])
		)
		const installedSources = flight.query(sourcesQuery, [
			textArray(Arr.dedupe(Arr.map(sources, (r) => r.function.schema)))
		])
		const extensionSchemas = Arr.map(createdExtensions, (x) => ({
			extension: x,
			slot: flight.query(extensionSchema, [textParam(x.name)])
		}))
		const publicationReads = Arr.map(
			Arr.flatMap(statements, (s) => (s.kind === "createPublication" ? [s] : [])),
			(s) => ({
				expected: expectedPublication(s),
				slot: flight.query(publicationQuery, [textParam(s.name)])
			})
		)
		const database = flight.query(databaseSettingsQuery, [])
		const formerSlots = flight.query(formerSlotsQuery, [
			textParam(identifierOf(identity.liveSource(schema)))
		])
		const defaults = Arr.map(defaultPrivilegesExpectations(statements, schema), (expectation) => ({
			expectation,
			slot: flight.query(defaultPrivilegesQuery(), defaultPrivilegesParams(expectation))
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
		/** The facts of the installed catalog no row proves, and every fact beside the descriptions, from the first
		 * flight's outcomes. */
		const beside = (first: ReadonlyArray<BatchOutcome>) =>
			Result.gen(function* () {
				/** Every fact beside the descriptions but a source's, a privilege's and a policy's. */
				const out: Array<DriftMismatch> = []
				const privileges: Array<RolePrivilege> = []
				const policies: Array<RolePolicy> = []
				const sourced = sourceMismatches(sources, yield* installedSources.rows(first), folders)
				for (const { extension: x, slot } of extensionSchemas) {
					const at = yield* slot.rows(first)
					if (!at.includes(x.schema)) {
						out.push({ kind: "missing", fact: `extension ${x.name} in schema ${x.schema}` })
					}
				}
				for (const { expected, slot } of publicationReads) {
					for (const mismatch of compareDescriptions(expected, new Map(yield* slot.rows(first)))) {
						out.push(mismatch)
					}
				}
				const formerDefault = formerDefaultHeld(yield* database.rows(first))
				const formerSlotNames = yield* formerSlots.rows(first)
				for (const { expectation, slot } of defaults) {
					const owned = yield* slot.rows(first)
					for (const d of defaultPrivilegeDifferences(owned, expectation)) {
						out.push({ kind: d.kind, fact: `default privilege ${d.grant}` })
					}
				}
				for (const read of roleReads) {
					const r = read.expectation
					for (const d of attributeDifferences(yield* read.attributes.rows(first), r)) {
						out.push({ kind: "missing", fact: `role ${r.role} ${d.expected}` })
						if (d.attribute !== "existence") {
							out.push({ kind: "unexpected", fact: `role ${r.role} ${d.observed}` })
						}
					}
					for (const d of roleDifferences(yield* read.settings.rows(first), r)) {
						const scope =
							d.scope === "roleInDatabase" ? `role ${r.role} in database` : `role ${r.role}`
						for (const fact of settingFacts(d, scope)) {
							out.push(fact)
						}
					}
					for (const d of yield* read.privileges.rows(first)) {
						privileges.push({ role: r.role, difference: d })
					}
					for (const d of membershipDifferences(yield* read.memberships.rows(first), r)) {
						for (const fact of membershipFacts(d, `role ${r.role} membership in ${d.role}`)) {
							out.push(fact)
						}
					}
					for (const d of memberDifferences(yield* read.members.rows(first), r)) {
						for (const fact of membershipFacts(d, `role ${r.role} member ${d.role}`)) {
							out.push(fact)
						}
					}
					for (const d of policyDifferences(yield* read.policies.rows(first), r)) {
						policies.push({ role: r.role, difference: d })
					}
				}
				const found: Beside = {
					mismatches: [
						...Arr.map(sourced, (m) => m.mismatch),
						...out,
						...Arr.map(privileges, (p) => privilegeFact(p.difference, p.role)),
						...Arr.map(policies, (p) => ({
							kind: p.difference.kind,
							fact: `policy ${p.difference.policy.name} on ${p.difference.policy.table} naming role ${p.role}`
						}))
					],
					sources: new Set(Arr.map(sourced, (m) => m.object)),
					privileges,
					policies,
					others: out,
					formerDefault,
					formerSlots: formerSlotNames
				}
				return found
			})
		return {
			first: flight.statements,
			after: (proofs, first) =>
				Result.gen(function* () {
					const names: Array<{ scratch: string; schema: string; printed: string }> = []
					for (const p of printed) {
						names.push({
							scratch: scratchSchema(p.schema),
							schema: p.schema,
							printed: yield* p.slot.row(first)
						})
					}
					const rename = fromScratch(names)
					const installed: Array<Fact> = []
					for (const slot of installedFacts) {
						for (const f of yield* slot.rows(first)) {
							installed.push(f)
						}
					}
					const owned = Arr.groupBy(
						Arr.flatMap(installed, (f) => {
							const by = factOwner(described, f)
							return by === undefined ? [] : [{ by, fact: f }]
						}),
						(o) => o.by
					)
					const proved = yield* toResult(
						proofDigests(
							objects,
							snapshot.manifest.edges,
							proofEnvironment(yield* environment.row(first), installation)
						)
					)
					const rows = Arr.sort(
						Arr.flatMap(proved, ({ object, digest }): ReadonlyArray<ProofRow> =>
							described.has(object.ident)
								? [
										{
											object: object.ident,
											ddl: digest,
											description: descriptionDigest(
												Arr.map(owned[object.ident] ?? [], (o) => o.fact)
											)
										}
									]
								: []
						),
						Order.Struct({ object: Order.String })
					)
					const proves = (row: ProofRow): boolean => {
						const held = proofs.get(row.object)
						return (
							held !== undefined && held.ddl === row.ddl && held.description === row.description
						)
					}
					const unproven = new Set(Arr.flatMap(rows, (row) => (proves(row) ? [] : [row.object])))
					const record: ProofRecord =
						unproven.size === 0 && proofs.size === rows.length
							? { kind: "held" }
							: { kind: "record", rows }
					const replayed = replayedOver(objects, snapshot.manifest.edges, unproven)
					/**
					 * A fact compared fact by fact: an unproven object's, or one no object owns. An object replayed only for one
					 * created after it stands proven, its installed description its proof's.
					 */
					const isCompared = (f: Fact): boolean => {
						const by = factOwner(described, f)
						return by === undefined || unproven.has(by)
					}
					const texts = yield* scratchStatements(replayed, scratchOf, installation)
					const second = sending()
					const replay = second.replay(texts)
					const scratchFacts = Arr.map(schemas, (s) =>
						second.query(descriptions, [textParam(scratchSchema(s)), textParam(s)])
					)
					const besides = yield* beside(first)
					const read = (outcomes: ReadonlyArray<BatchOutcome>) =>
						Result.gen(function* () {
							const expected: Array<Fact> = []
							for (const slot of scratchFacts) {
								for (const f of yield* slot.rows(outcomes)) {
									const renamed = { ...f, key: rename(f.key), description: rename(f.description) }
									if (isCompared(renamed)) {
										expected.push(renamed)
									}
								}
							}
							const compared = Arr.filter(installed, isCompared)
							const verdict: DriftVerdict = {
								mismatches: sorted([
									...compareDescriptions(keyed(expected), keyed(compared)),
									...besides.mismatches
								]),
								replayed: Arr.map(replayed, (o) => o.ident),
								proofs: record,
								found: {
									described,
									proven: new Set(
										Arr.flatMap(rows, (row) => (unproven.has(row.object) ? [] : [row.object]))
									),
									expected,
									installed: compared,
									sources: besides.sources,
									privileges: besides.privileges,
									policies: besides.policies,
									others: besides.others,
									formerDefault: besides.formerDefault,
									formerSlots: besides.formerSlots
								}
							}
							return verdict
						})
					return { statements: second.statements, value: { replay, read } }
				})
		}
	})

/** The ledger's facts: its latest complete target is the snapshot's, and no folder is partial. */
export const ledgerMismatches = (
	snapshot: DeploySnapshot,
	state: LedgerState
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	if (state.latest !== snapshot.fingerprint) {
		out.push({
			kind: "differs",
			fact: "ledger latest",
			expected: snapshot.fingerprint,
			installed: state.latest
		})
	}
	if (state.partial !== undefined) {
		out.push({ kind: "unexpected", fact: `ledger partial ${state.partial.folder}` })
	}
	return out
}
