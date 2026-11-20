/** What the property of rule-image.test.ts reads: its schema and template, its space, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { parsePlan, type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { judgedStatementsOf, plannedQueryOf } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { postgresBtreeMaxItem } from "#test/unit/schema/representability.fixtures.ts"

/**
 * edullm's pantry in small: the attributes of the elements of documents of packages, keyed by their element and name,
 * each holding its `value`, a text of no byte bound, as an attribute's normalized value is (alt text, style and data-*
 * values carry no QTI bound); ObjectIdentifier, the derived selection of each item's and test's root `identifier`; and
 * the ledger's item sessions, each held to an identifier of its package by a rule over that query (qti-database's
 * ledger.ts), its `item` a text of 2,700 bytes at most, which no B-tree entry holds as itself beside its package, as a
 * pantry text bounded only by its widest value is. The rule's probe of a written session reads Attribute by (package,
 * name, kind, value), and of a deleted attribute ItemSession by (package, item): every document of a package holds one
 * identifier, so the rows that share a probe's other columns are a package's identifiers, and only `value`, or `item`,
 * tells one from another. Each probe's entry, every column as itself, could outgrow a B-tree entry, so its index holds
 * each text it binds by equality by its image, the package's among them.
 */
const Short = str.bytes(64, str.regex("^.*$", "su"))
const Free = str.regex("^.*$", "su")
const Wide = str.bytes(2700, Free)
const Kind = closed.ordered("ImageKind", ["item", "test", "element"])
const Name = closed.ordered("ImageName", ["identifier", "title", "class"])

const Attribute = relation(
	"Attribute",
	{
		package: Short,
		path: Short,
		start: pg.integer,
		name: closedId(Name),
		kind: closedId(Kind),
		value: Free
	},
	["package", "path", "start", "name"]
)
const ItemSession = relation("ItemSession", { id: pg.integer, package: Short, item: Wide }, ["id"])

const Base = schema("rule_image", [Kind, Name, Attribute, ItemSession], [])
const ObjectIdentifier = derived(
	"ObjectIdentifier",
	query(Base).rule((r) => {
		const { kind, package: pkg, path, start, value } = v(Attribute, "a")
		return r
			.match(Attribute, { kind, name: "identifier", package: pkg, path, start, value })
			.where(r.or(r.eq(kind, "item"), r.eq(kind, "test")))
			.find({ identifier: value, package: pkg, path, start })
	})
)
const imageSchema = schema.extend(
	Base,
	"rule_image_1",
	[ObjectIdentifier],
	[contained(on(ItemSession, "package", "item"), on(ObjectIdentifier, "package", "identifier"))]
)

/**
 * A reader of the identifiers, as qti-database's learner reads a package's items: its one entry, Identifiers, the query
 * of each item's and test's root identifier, which hides every other attribute, so its view is a security barrier, into
 * which PostgreSQL passes a reader's condition only where it is leakproof.
 */
const Reader = role(
	imageSchema,
	"reader",
	{
		Identifiers: query(imageSchema).rule((r) => {
			const { kind, package: pkg, path, start, value } = v(Attribute, "a")
			return r
				.match(Attribute, { kind, name: "identifier", package: pkg, path, start, value })
				.where(r.or(r.eq(kind, "item"), r.eq(kind, "test")))
				.find({ package: pkg, path, start, value })
		})
	},
	{ write: [], refresh: [] }
)
const desk = login(imageSchema, "desk", [Reader])

/** The reader's read of the documents whose identifier is `value` in package `pkg`, through its query entry. */
const readOf = (pkg: string, value: string) =>
	query(Reader).rule((r) => {
		const { path } = v(Reader.relations.Identifiers, "i")
		return r.match(Reader.relations.Identifiers, { package: pkg, path, value }).find({ path })
	})

export const imageTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule image",
	content: { schema: imageSchema.name, logins: ["desk: a reader of the identifiers"] },
	versions: [{ schema: imageSchema, logins: [desk], declarations: noDeclarations }],
	options: {
		label: "rule_image",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * The lengths a value is drawn at, in bytes: a few, as an item's short identifier; 433, the single string value of the
 * correct response of a production AlphaTest item, past pantry's interim bound of 428 bytes; and 2,700, `item`'s bound,
 * which as itself is past every B-tree entry (BTMaxItemSize, 2,704 bytes, its 8-byte header and 4-byte varlena header
 * beside it). One document's value is the empty text whatever the lengths (`valueSql`).
 */
const valueLengths = [8, 433, 2700] as const

/**
 * The most bytes of a text an index entry holds as itself alone: BTMaxItemSize less the index tuple's 8-byte header and
 * the text's 4-byte varlena header (representability.fixtures.ts postgresBtreeMaxItem).
 */
const loneTextBytes = postgresBtreeMaxItem - 12

/**
 * A case: the packages stored, each one's documents and stored sessions, the lengths of its values, the sessions
 * written.
 */
export interface Stored {
	readonly packages: number
	readonly documents: number
	readonly lengths: Arr.NonEmptyReadonlyArray<(typeof valueLengths)[number]>
	readonly stored: number
	readonly sessions: number
}

/**
 * A few packages of a hundred and fifty documents and more, each with hundreds of stored sessions: a package's
 * identifiers and sessions outnumber what any one probe matches, and each table spans tens of pages, which a lookup
 * through an index reads two or three of.
 */
export const storedGen: Gen<Stored> = (s) => {
	const first = s.draw(element(valueLengths))
	const more = s.draw(int(0, 2))
	return {
		packages: s.draw(int(2, 4)),
		documents: s.draw(int(150, 250)),
		lengths: [first, ...Arr.map(indices(more), () => s.draw(element(valueLengths)))],
		stored: s.draw(int(400, 800)),
		sessions: s.draw(int(5, 20))
	}
}

export type ImageFeature =
	| "a value past a B-tree entry"
	| "values of one length"
	| "a read through a query entry"
	| "a session one byte off its identifier refused"

/**
 * The document whose value document `d`'s identifier holds, as SQL over `d`: d + 1 holds d's where d is a multiple of
 * 10, so a probe matches two rows there; every other document holds its own.
 */
const sharedSql = (d: string): string => `(${d}) - (${d}) % 2 * ((${d}) % 10 = 1)::int`

/**
 * The value of the identifier of the documents that hold document `x`'s (`sharedSql`), as SQL over `x`, of `length`
 * bytes: x's number, then hex digits of md5s of it, which no compression shrinks much.
 */
const valueSql = (x: string, length: number): string =>
	`left(lpad((${x})::text, 6, '0') || (SELECT string_agg(md5((${x})::text || '/' || g), '') FROM generate_series(1, ${Math.ceil(length / 32)}) AS g(g)), ${length})`

/** The document whose identifier is the empty text, a value as any other. */
const emptyDocument = 2

/** The session's tables a query reads, its deltas: every table of pg_temp a FROM of it names. */
const sessionTablesOf = (query: OperandSelect): ReadonlyArray<string> => {
	const named: Array<string> = []
	new Transform({
		...identityHooks,
		fromSource: (source) => {
			if (
				source.kind === "table" &&
				typeof source.table !== "string" &&
				source.table.schema === "pg_temp"
			) {
				named.push(source.table.name)
			}
			return source
		}
	}).select(query)
	return named
}

/** The rows a scan reads a loop: its output and what its filters removed. */
const rowsOf = (n: PlanNode): number =>
	n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck

/**
 * The table a plan node reads rows of, when it scans one: a sequential, index, index-only, bitmap heap or TID scan's
 * relation. A bitmap index scan's entries are its heap scan's rows, but those that rolled-back cases left in the
 * database's indexes besides, which no visible row answers.
 */
const scannedOf = (n: PlanNode): Option.Option<string> =>
	n.nodeType !== "Bitmap Index Scan" && Str.endsWith(" Scan")(n.nodeType)
		? n.relation
		: Option.none()

/** What one scan of a stored table read, a loop, beside the most rows one lookup of its table matches. */
interface Read {
	readonly table: string
	readonly node: string
	readonly index: string | undefined
	readonly loops: number
	readonly rows: number
	readonly buffers: number
	readonly most: number
}

/**
 * The planner settings each case explains its probes under: the hash and merge joins and the materialization of a
 * nested loop's inner side off, so PostgreSQL reads every join by a nested loop that runs its inner side again for each
 * outer row, which it plans as a lookup at that row's values where an index serves one (test/support/oracle/perturb.ts
 * plannerSettings). At a case's few hundred identifiers PostgreSQL would read a negation's inner side whole, every
 * identifier once, hashed or materialized, which says nothing of a lookup; at edullm's scale, analyzed, it plans the
 * lookup itself: on PostgreSQL 19rc2 over 100,000 identifiers of 50 packages, analyzed, the ledger's probe is a nested
 * loop anti join reading one row a loop through the image's index, with every setting at its default. So the property
 * is of the lookups, over analyzed tables, as autovacuum leaves a stored one.
 */
const lookups = [
	"SET LOCAL enable_hashjoin = off",
	"SET LOCAL enable_mergejoin = off",
	"SET LOCAL enable_material = off"
] as const

/**
 * One case in its one transaction, which the case's end rolls back: `packages` packages of `documents` documents, each
 * a root of an item or a test whose identifier, title and an element's class are attributes, loaded with the captures
 * off, and analyzed; then, through the captures, `sessions` sessions each of a stored identifier, and
 * the deletion of an identifier no session holds, and the judge run (SET CONSTRAINTS ALL IMMEDIATE), which leaves its
 * deltas holding those rows. Each query the judge raises on is then explained over them: every scan of Attribute or
 * ItemSession reads, a loop, at most the rows one lookup's every equality matches, its value's among them, and those
 * its image's hash collides with, the most rows of one package and name, or one package, that share a value's image;
 * never a package's identifiers, which an index of the bounded columns alone reads, every one at each lookup.
 */
export const runImaged = (
	installed: Installed,
	connection: PgConnection,
	stored: Stored,
	c: Case<ImageFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const attribute = names.table(Attribute)
		const session = names.table(ItemSession)
		const a = (f: "package" | "path" | "start" | "name" | "kind" | "value") =>
			names.column(Attribute, f)
		const s = (f: "id" | "package" | "item") => names.column(ItemSession, f)
		const attributeColumns = Arr.join(
			Arr.map(["package", "path", "start", "name", "kind", "value"] as const, a),
			", "
		)
		const length = (d: string) =>
			`(ARRAY[${Arr.join(Arr.map(stored.lengths, String), ", ")}])[(${d}) % ${stored.lengths.length} + 1]`
		const value = (d: string) => {
			const x = sharedSql(d)
			return `CASE WHEN ${x} = ${emptyDocument} THEN '' ELSE CASE ${length(x)} ${Arr.join(
				Arr.map(Arr.dedupe(stored.lengths), (n) => `WHEN ${n} THEN ${valueSql(x, n)}`),
				" "
			)} END END`
		}
		const documents = `generate_series(1, ${stored.packages}) AS p(p), generate_series(0, ${stored.documents - 1}) AS d(d)`
		const pkg = (p: string) => `'package/' || (${p})`
		const path = (d: string) => `'document/' || (${d})`
		const root = (d: string) => `(${d}) % 2`
		const loaded = [
			`ALTER TABLE ${attribute} DISABLE TRIGGER USER`,
			`INSERT INTO ${attribute} (${attributeColumns}) SELECT ${pkg("p")}, ${path("d")}, 0, 0, ${root("d")}, ${value("d")} FROM ${documents}`,
			`INSERT INTO ${attribute} (${attributeColumns}) SELECT ${pkg("p")}, ${path("d")}, 0, 1, ${root("d")}, 'title ' || d FROM ${documents}`,
			`INSERT INTO ${attribute} (${attributeColumns}) SELECT ${pkg("p")}, ${path("d")}, 1, 2, 2, 'c' FROM ${documents}`,
			`ALTER TABLE ${attribute} ENABLE TRIGGER USER`,
			`ALTER TABLE ${session} DISABLE TRIGGER USER`,
			`INSERT INTO ${session} (${s("id")}, ${s("package")}, ${s("item")}) SELECT ${stored.sessions} + k, ${pkg(`1 + k % ${stored.packages}`)}, ${value(`k % ${stored.documents}`)} FROM generate_series(0, ${stored.stored * stored.packages - 1}) AS k(k)`,
			`ALTER TABLE ${session} ENABLE TRIGGER USER`,
			`ANALYZE ${attribute}`,
			`ANALYZE ${session}`
		]
		/**
		 * Written session k holds the identifier of document 3k of package 1 + k mod packages; the identifier of document
		 * 1 of package 1, which document 0 shares, is deleted.
		 */
		const written = [
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${session} (${s("id")}, ${s("package")}, ${s("item")}) SELECT k, ${pkg(`1 + k % ${stored.packages}`)}, ${value(`3 * k % ${stored.documents}`)} FROM generate_series(0, ${stored.sessions - 1}) AS k(k)`,
			`DELETE FROM ${attribute} WHERE ${a("package")} = ${pkg("1")} AND ${a("path")} = ${path("1")} AND ${a("name")} = 0`,
			"SET CONSTRAINTS ALL IMMEDIATE",
			...lookups
		]
		for (const sql of [...loaded, ...written]) {
			yield* connection.query(sql, [])
		}
		/**
		 * The most rows one lookup of each table matches with the rows its image's hash collides with (the header): every
		 * lookup of Attribute binds an identifier of an item or a test, and of ItemSession its package and item.
		 */
		const [bounds] = yield* connection.queryValues(
			`SELECT (SELECT max(n) FROM (SELECT count(*) AS n FROM ${attribute} WHERE ${a("name")} = 0 AND ${a("kind")} IN (0, 1) GROUP BY ${a("package")}, pg_catalog.md5(${a("value")})) AS g)::text, coalesce((SELECT max(n) FROM (SELECT count(*) AS n FROM ${session} GROUP BY ${s("package")}, pg_catalog.md5(${s("item")})) AS g), 0)::text`,
			[]
		)
		const bound = new Map([
			[attribute, Number(bounds?.[0])],
			[session, Number(bounds?.[1])]
		])

		/** The judged queries whose every delta the write stood up: those the judge ran. */
		const temporary = yield* connection.queryValues(
			"SELECT relname::text FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.pg_my_temp_schema()",
			[]
		)
		const standing = new Set(Arr.map(temporary, (row) => String(row[0])))
		const queries = Arr.filter(judgedStatementsOf(installed.installation), (q) =>
			Arr.every(sessionTablesOf(q.query), (t) => standing.has(t))
		)
		assert.ok(queries.length > 0, "the judge ran a query it raises on")
		/**
		 * Every scan of Attribute or ItemSession `sql` makes, explained as it runs, each within its table's bound; the
		 * scans, for a read that must make one.
		 */
		const within = (sql: string, what: string) =>
			Effect.gen(function* () {
				const explained = yield* connection.queryValues(
					`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${sql}`,
					[]
				)
				const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
				const read = Arr.flatMap([...planNodes(plan)], (n): ReadonlyArray<Read> => {
					const bounded = Option.flatMap(scannedOf(n), (table) =>
						Option.map(
							Option.fromUndefinedOr(bound.get(`${quoteIdent(names.schema)}.${quoteIdent(table)}`)),
							(most) => ({ table, most })
						)
					)
					return Option.isSome(bounded)
						? [
								{
									...bounded.value,
									node: n.nodeType,
									index: Option.getOrUndefined(n.index),
									loops: n.actualLoops,
									rows: rowsOf(n),
									buffers: (n.buffers.sharedHit + n.buffers.sharedRead) / Math.max(1, n.actualLoops)
								}
							]
						: []
				})
				assert.ok(
					Arr.every(read, (r) => r.rows <= r.most),
					`${Formatter.format(stored)}: each scan of Attribute and ItemSession ${what} makes reads, a loop, at most the rows one lookup's equalities and its image's collisions match, beside ${stored.documents} identifiers of each package: ${Formatter.format(read)}`
				)
				return read
			})
		for (const judged of queries) {
			yield* within(plannedQueryOf(judged), "the judge's query")
		}
		/** The reader's read through its query entry of the documents of package 2 that hold document 5's identifier. */
		const [stored5] = yield* connection.queryValues(
			`SELECT ${a("value")} FROM ${attribute} WHERE ${a("package")} = ${pkg("2")} AND ${a("path")} = ${path("5")} AND ${a("name")} = 0`,
			[]
		)
		const template = succeeded(
			compileTemplate(readOf("package/2", String(stored5?.[0])), undefined, {
				...testCompile,
				installation: identity.schema(parsedSchemaName(installed.declared))
			}),
			"the reader's read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the reader's read is one statement")
		const through = yield* within(statement.sql, "the reader's read through its query entry")
		assert.ok(through.length > 0, "the reader's read reads Attribute")
		c.note("a read through a query entry")
		/**
		 * A session of package 1 whose item is document 4's identifier with its last character changed holds no
		 * identifier of its package: the model refuses it, and so must the judge, whose probe finds no row by the image of
		 * a text no stored identifier is (23503, a containment's).
		 */
		const near = `(SELECT overlay(${a("value")} placing (CASE WHEN right(${a("value")}, 1) = 'a' THEN 'b' ELSE 'a' END) from char_length(${a("value")})) FROM ${attribute} WHERE ${a("package")} = ${pkg("1")} AND ${a("path")} = ${path("4")} AND ${a("name")} = 0)`
		yield* connection.query("SAVEPOINT near", [])
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
		yield* connection.query(
			`INSERT INTO ${session} (${s("id")}, ${s("package")}, ${s("item")}) VALUES (${stored.sessions + stored.stored * stored.packages}, ${pkg("1")}, ${near})`,
			[]
		)
		const missed = yield* Effect.flip(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		assert.equal(
			pgErrorFields(missed)?.code,
			"23503",
			`${Formatter.format(stored)}: a session one byte off a stored identifier is refused by the containment`
		)
		yield* connection.query("ROLLBACK TO SAVEPOINT near", [])
		c.note("a session one byte off its identifier refused")
		if (Arr.some(stored.lengths, (n) => n > loneTextBytes)) {
			c.note("a value past a B-tree entry")
		}
		if (Arr.dedupe(stored.lengths).length === 1) {
			c.note("values of one length")
		}
	})
