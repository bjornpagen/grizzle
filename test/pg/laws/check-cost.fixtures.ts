/** What check-cost.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import {
	findNodes,
	type PlanNode,
	parsePlan,
	planNodes,
	rowsTouched
} from "#bench/harness/explain.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { violationCheck } from "#compiler/deploy/render/sql.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { fillStatement } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import {
	type FromSource,
	isSetQuery,
	nameKey,
	type OperandSelect,
	type Select,
	selectColumns,
	type SelectCore
} from "#compiler/sql/ast.ts"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"
import { printObjectName, printStatement, sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { identityHooks, transformQuery } from "#compiler/sql/transform.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

/** A package's elements, by package, document and place, each of a kind, as pantry stores QTI content. */
const Node = relation(
	"Node",
	{
		pkg: pg.integer,
		path: pg.integer,
		at: pg.integer,
		kind: pg.integer,
		tag: pg.integer,
		grp: pg.integer,
		band: pg.integer
	},
	["pkg", "path", "at"]
)

/** A declaration, at the element that declares it. */
const Decl = relation(
	"Decl",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, w: pg.integer },
	["pkg", "path", "at"]
)

/** A declared variable's identifier, at the element that declares it, as QTI's DeclarationIdentifier. */
const Dcl = relation(
	"Dcl",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, ident: pg.integer },
	["pkg", "path", "at"]
)

/** A declaration's cardinality, at its element, as QTI's DeclarationCardinality. */
const Card = relation(
	"Card",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, card: pg.integer },
	["pkg", "path", "at"]
)

/** A declaration's base type, at its element, as QTI's DeclarationBaseType. */
const Typed = relation(
	"Typed",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, base: pg.integer },
	["pkg", "path", "at"]
)

/** A binding at an element, of an attribute, naming a variable its document declares, as QTI's BoundVariable. */
const Bind = relation(
	"Bind",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, attr: pg.integer, ident: pg.integer },
	["pkg", "path", "at"]
)

/**
 * Every element of a declaring kind, 1 or 2, is a declaration's: the rule the judge holds, as QTI's
 * __node_kind_in_declaration, whose check a migration runs over every row once. And every element of tag, group and
 * band 5 is one's, a selection over three columns that every element holds alike, which PostgreSQL estimates as the
 * product of the three, as QTI's __attribute_lexical_document_type_kind_name_in, whose name, kind and document type
 * it estimated at one row of 15,035. Node and Decl are mutable in their document's unit, so both containments are
 * judged whole (laws/model/plan.ts containmentDischarge), their check the violation query over every row the box
 * bounds, where over immutable relations the judge would probe them key by key.
 */
const Base = schema(
	"CheckCost",
	[Node, Decl, Dcl, Card, Typed, Bind],
	[
		unit("Doc", { pkg: pg.integer, path: pg.integer }),
		mutable(Node),
		mutable(Decl),
		contained(
			on(
				select(Node, (n) => n.or(n.eq(n.kind, 1), n.eq(n.kind, 2))),
				"pkg",
				"path",
				"at"
			),
			on(Decl, "pkg", "path", "at")
		),
		contained(
			on(
				select(Node, (n) => n.and(n.eq(n.tag, 5), n.eq(n.grp, 5), n.eq(n.band, 5))),
				"pkg",
				"path",
				"at"
			),
			on(Decl, "pkg", "path", "at")
		)
	]
)

/** Each declared element with its declaration's weight: Node joined to Decl at its place, as QTI's ChoiceNode. */
const Declared = derived(
	"Declared",
	query(Base).rule((r) => {
		const { pkg, path, at, kind } = v(Node, "n")
		const { w } = v(Decl, "d")
		return r
			.match(Node, { pkg, path, at, kind })
			.match(Decl, { pkg, path, at, w })
			.find({ pkg, path, at, kind, w })
	})
)

/** Each declared name beside its cardinality, by its document, its place witnessed: as QTI's DeclarationName. */
const CardName = derived(
	"CardName",
	query(Base).rule((r) => {
		const { pkg, path, at, ident } = v(Dcl, "d")
		const { card } = v(Card, "c")
		return r
			.match(Dcl, { pkg, path, at, ident })
			.match(Card, { pkg, path, at, card })
			.find({ pkg, path, ident, card })
	})
)

/** Each declared name beside its base type, by its document, its place witnessed: as QTI's TypedDeclarationName. */
const TypedName = derived(
	"TypedName",
	query(Base).rule((r) => {
		const { pkg, path, at, ident } = v(Dcl, "d")
		const { base } = v(Typed, "t")
		return r
			.match(Dcl, { pkg, path, at, ident })
			.match(Typed, { pkg, path, at, base })
			.find({ pkg, path, ident, base })
	})
)

/**
 * And no two declared elements of one document and kind share a weight: a key over a join of two stored relations
 * whose terms read both, as QTI's __choice_node_key_package_path_kind_identifier, whose check derived choice ⋈ node
 * twice when it was a self-join of the side. Declared delivers Doc's unit at its places, (pkg, path, at), wider than
 * Doc's key, so the installation stores it (`storedDerived`) and its key is its table's unique index, which its fill and
 * its upkeep's INSERT fire, its cost the fill's. And no declared name of a document has two cardinalities, however many
 * places declare it: a key over CardName, which delivers (pkg, path) alone, Doc's whole key, so it is read live and its
 * key is a rule the judge holds, as QTI's One base, a key over KnownOperandBase, each operator's operand bases with the
 * operand's place projected away, whose check is the side read once, grouped by the key, its facts counted.
 */
const Mid = schema.extend(
	[Base],
	"CheckCost_1",
	[Declared, CardName, TypedName],
	[key(on(Declared, "pkg", "path", "kind", "w")), key(on(CardName, "pkg", "path", "ident"))]
)

/** Each binding beside its variable's cardinality and base type, by its place: as QTI's BindingBaseTypeNode. */
const Fit = derived(
	"Fit",
	query(Mid).rule((r) => {
		const { pkg, path, at, attr, ident } = v(Bind, "b")
		const { card } = v(CardName, "c")
		const { base } = v(TypedName, "t")
		return r
			.match(Bind, { pkg, path, at, attr, ident })
			.match(CardName, { pkg, path, ident, card })
			.match(TypedName, { pkg, path, ident, base })
			.find({ pkg, path, at, attr, card, base })
	})
)

/**
 * And a binding of attribute 1 names a variable of base type 1: a check over a join of two derived relations, each a
 * projection of a join that witnesses the declaration's place, as QTI's BindingFit over BindingBaseTypeNode, whose
 * check read DeclarationName and TypedDeclarationName each as a query of its own, joined by PostgreSQL's estimates of
 * them, 102 rows of 61,093, by a nested loop over one's rows for each of the other's: 1,165,329,900 pairs thrown away,
 * 193 s over zero violations.
 */
const Checked = schema.extend(
	[Mid],
	"CheckCost_2",
	[Fit],
	[check("Fit", Fit, (f) => f.or(f.ne(f.attr, 1), f.eq(f.base, 1)))]
)

/**
 * The relations each derived relation of the box matches, an entry at each occurrence its rule reads one: what a law over
 * it reads as the schema declares it (`storedReadsOf`), and what its fill reads where it is stored (`fillReadsOf`).
 */
const declaredReads: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	[Declared.name, [Node.name, Decl.name]],
	[CardName.name, [Dcl.name, Card.name]],
	[TypedName.name, [Dcl.name, Typed.name]],
	[Fit.name, [Bind.name, CardName.name, TypedName.name]]
])

/**
 * The derived relations of the box the installation stores (analysis/derived/storage.ts), in name order: Declared alone,
 * whose head delivers Doc's unit at (pkg, path, at), wider than Doc's key, so its upkeep re-derives the places a write
 * touched. CardName, TypedName and Fit deliver (pkg, path) alone, Doc's whole key, so each upkeep would re-derive a
 * whole document at every write of it, and each is read live, by its definition.
 */
const storedDerived: ReadonlyArray<string> = [Declared.name]

/** The stored relations `relation` reads as the box declares it, one at each occurrence: itself where it is stored. */
const storedReadsOf = (relation: string): ReadonlyArray<string> => {
	const read = declaredReads.get(relation)
	return read === undefined || storedDerived.includes(relation)
		? [relation]
		: Arr.flatMap(read, storedReadsOf)
}

/** The stored relations the fill of the stored relation `relation` reads, one at each occurrence: its definition's. */
const fillReadsOf = (relation: string): ReadonlyArray<string> =>
	Arr.flatMap(
		defined(declaredReads.get(relation), `${relation}, a derived relation of the box`),
		storedReadsOf
	)

/** The schema installed through its first migration, its tables empty. */
export const checkCostTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "check cost",
	content: { schema: Checked.name, logins: [] },
	versions: [{ schema: Checked, logins: [], declarations: noDeclarations }],
	options: {
		label: "check_cost",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * How the elements are laid out: `spread`, the i-th of n at package i mod 7, document i mod 13 and place i, every
 * second of a declaring kind; `documents`, packages of 20 documents of 50 elements, every 25th and every 31st of a
 * declaring kind.
 */
const layouts = ["spread", "documents"] as const

/** The sizes of the box, in elements, each twice the one before. */
const sizes = [500, 1000, 2000, 4000, 8000, 16000] as const

export interface CheckCase {
	readonly layout: (typeof layouts)[number]
	readonly size: (typeof sizes)[number]
}

/** The box: every layout at every size. */
export const checkCaseGen: Gen<CheckCase> = (s) => ({
	layout: s.draw(element(layouts)),
	size: s.draw(element(sizes))
})

export type CheckFeature = "a law that holds" | "a violation found"

/**
 * The elements of `c` as one INSERT's SELECT over generate_series's i: package, document, place, kind, and its tag,
 * group and band, each i mod 20.
 */
const elementsOf = (c: CheckCase): string => {
	switch (c.layout) {
		case "spread":
			return `SELECT i % 7, i % 13, i, i % 4, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(1, ${c.size}) AS g(i)`
		case "documents":
			return `SELECT i / 1000, (i / 50) % 20, i % 50, CASE WHEN i % 25 = 0 THEN 1 WHEN i % 31 = 0 THEN 2 ELSE 3 + i % 5 END, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(0, ${c.size - 1}) AS g(i)`
	}
}

/**
 * The declarations and bindings of `c`, each one INSERT's SELECT over generate_series's i, of one table: documents of 50
 * elements, size / 50 of them, each its own path, 20 documents to a package where `documents` lays them out one after
 * the other and 7 packages where `spread` deals the elements round the documents; places 0 to 9 of a document declare
 * variables 0 to 9, each of cardinality 1 and base type 1, and places 10 to 49 bind one, of attribute place mod 3. Each
 * binding names one declaration of its document, and every one is lawful: base type 1.
 */
const declarationsOf = (
	c: CheckCase
): Readonly<Record<"dcl" | "card" | "typed" | "bind", string>> => {
	const docs = c.size / 50
	const place = c.layout === "documents" ? "i % 50" : `i / ${docs}`
	const doc = c.layout === "documents" ? "i / 50" : `i % ${docs}`
	const pkg = c.layout === "documents" ? `${doc} / 20` : `${doc} % 7`
	const series = `FROM (SELECT ${pkg} AS pkg, ${doc} AS path, ${place} AS at FROM pg_catalog.generate_series(0, ${c.size - 1}) AS g(i)) AS e`
	return {
		dcl: `SELECT pkg, path, at, at ${series} WHERE at < 10`,
		card: `SELECT pkg, path, at, 1 ${series} WHERE at < 10`,
		typed: `SELECT pkg, path, at, 1 ${series} WHERE at < 10`,
		bind: `SELECT pkg, path, at, at % 3, at % 10 ${series} WHERE at >= 10`
	}
}

/** The columns of a derived table a core reads, as `<alias>.<column>`, where its query is a set; none for any other source. */
const setColumns = (source: FromSource): ReadonlyArray<string> =>
	source.kind === "derived" && isSetQuery(source.query)
		? Arr.map(selectColumns(source.query), (column) => `${source.alias}.${column}`)
		: []

/**
 * The deduplications of `query` that a set makes needless: each SELECT DISTINCT whose every source is a derived table of
 * a set, and whose targets read every column of each as it is, so that no two rows it reads deliver one row.
 */
const needlessDeduplications = (query: OperandSelect): ReadonlyArray<SelectCore> => {
	const needless: Array<SelectCore> = []
	transformQuery(query, {
		...identityHooks,
		core: (c) => {
			const sources = Arr.flatMap(c.from, (item) =>
				item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (step) => step.source)] : [item]
			)
			const read = new Set(
				Arr.flatMap(c.targets, (t) =>
					t.expr.kind === "column" && t.expr.table !== undefined
						? [`${t.expr.table}.${t.expr.column}`]
						: []
				)
			)
			if (
				c.distinct === true &&
				sources.length > 0 &&
				Arr.every(sources, (source) => {
					const columns = setColumns(source)
					return columns.length > 0 && Arr.every(columns, (column) => read.has(column))
				})
			) {
				needless.push(c)
			}
			return c
		}
	})
	return needless
}

/**
 * The statements PostgreSQL plans for a check's block, from its text, each as PL/pgSQL plans it: a PERFORM as the
 * SELECT whose keyword it replaces, for every row (pl_exec.c exec_stmt_perform), an IF's condition as SELECT
 * <condition> (exec_eval_expr), an EXISTS sublink in it for its first row. FOUND, the probe's own flag, reads no table.
 * Each statement of the block is one line of its text (sql/print.ts proceduralBlock), a compound one holding its body,
 * so a line is read as the statements its terminators end, each ended where PostgreSQL's scanner reads a semicolon.
 */
const plannedStatements = (text: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(text, "\n"), (line) => {
		const lexemes = lexemesOf(line).lexemes
		const ends: ReadonlyArray<number> = Arr.filterMap(lexemes, (l) =>
			l.kind === "terminator" ? Result.succeed(l.start) : Result.failVoid
		)
		const starts: ReadonlyArray<number> = [0, ...Arr.map(ends, (end) => end + 1)]
		return Arr.flatMap(Arr.zip(starts, ends), ([start, end]: readonly [number, number]) => {
			const statement = Str.trim(Str.slice(start, end)(line))
			if (Str.startsWith("PERFORM ")(statement)) {
				return [`SELECT ${Str.slice("PERFORM ".length)(statement)}`]
			}
			const then: Lexeme | undefined = Arr.findFirst(
				lexemes,
				(l) => l.start > start && l.start < end && l.kind === "word" && l.upper === "THEN"
			).pipe(Option.getOrUndefined)
			if (!Str.startsWith("IF ")(statement) || then === undefined) {
				return []
			}
			const condition = Str.slice("IF ".length)(Str.trim(Str.slice(start, then.start)(line)))
			return condition === "FOUND" ? [] : [`SELECT ${condition}`]
		})
	})

/**
 * The rows a plan's sequential rescans of small tables touch: each Seq Scan PostgreSQL runs once per row of a node
 * above it (more than one loop) whose own estimated cost, a whole table's read, is at most `probeCost`, what an index
 * probe of one row costs it at least, the index's leaf page and the table's page, each a random page (costsize.c
 * cost_index over genericcostestimate, twice random_page_cost): PostgreSQL rescans a table by a sequential scan per row
 * only where reading all of it costs no more than that probe, a table of a page or two, and such a rescan touches the
 * table's rows once per outer row, which its plan's work holds beside the rows it reads. A sequential rescan of any
 * larger table, which no estimate makes cheaper than a probe, adds nothing here, so a plan that reads a large table
 * again for each row of another still passes the bound only where its rows read do.
 */
const smallTableRescans = (plan: PlanNode, probeCost: number): number =>
	Arr.reduce(Arr.fromIterable(planNodes(plan)), 0, (sum, n) =>
		n.nodeType === "Seq Scan" && n.actualLoops > 1 && n.totalCost <= probeCost
			? sum + (n.actualRows + n.rowsRemovedByFilter) * n.actualLoops
			: sum
	)

/** The plan PostgreSQL runs `statement` by, explained with ANALYZE, which runs it: an explained write writes. */
const explainedPlan = (connection: PgConnection, statement: string) =>
	Effect.map(
		connection.queryValues(
			`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${statement}`,
			[]
		),
		(explained) => succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
	)

/** What a plan is held to (`holdsTheBound`): the rows of the tables, and what an index probe of one row costs at least. */
interface Bound {
	readonly rows: number
	readonly probeCost: number
}

/**
 * Holds one plan PostgreSQL ran, `what`'s, to the bound (runCheck): it reads each table by at most one plan node per
 * occurrence `reads` holds of it, the node that writes a fill's table, its INSERT's ModifyTable, reading none of it, and
 * touches at most its nodes times the rows of the tables and the rows its rescans of tables no larger than an index probe
 * touch (`smallTableRescans`).
 */
const holdsTheBound = (
	plan: PlanNode,
	reads: ReadonlyArray<string>,
	bound: Bound,
	what: string
): void => {
	const nodes = Arr.fromIterable(planNodes(plan)).length
	const touched = rowsTouched(plan)
	const rescans = smallTableRescans(plan, bound.probeCost)
	assert.ok(
		touched <= nodes * bound.rows + rescans,
		`${what} touches ${touched} rows, past its ${nodes} nodes times the ${bound.rows} rows it reads and the ${rescans} its rescans of tables no larger than an index probe read, ${Formatter.format(Arr.map(Arr.fromIterable(planNodes(plan)), (n) => n.nodeType))}`
	)
	const scans = Arr.flatMap(
		findNodes(
			plan,
			(n) =>
				Option.isSome(n.relation) &&
				n.nodeType !== "Bitmap Index Scan" &&
				n.nodeType !== "ModifyTable"
		),
		(n) => Option.toArray(n.relation)
	)
	for (const table of Arr.dedupe(scans)) {
		const read = Arr.filter(scans, (t) => t === table).length
		const at = Arr.filter(reads, (t) => t === table).length
		assert.ok(
			read <= at,
			`${what} reads ${table} by ${read} plan nodes, past the ${at} occurrences it reads it at`
		)
	}
}

/**
 * A stored relation's fill, as the migration that creates its table runs it, into the table empty, once every row its
 * definition reads is written (physical/derived/objects.ts fillStatement, deploy/diff/diff.ts view): the relation, its
 * table, the INSERT's query and text, and the laws its table's natives hold, every law the installation's constraint map
 * reads under one of the table's constraints (ir/products.ts ConstraintLaws), which its INSERT fires.
 */
interface StoredFill {
	readonly relation: string
	readonly table: { readonly schema: string; readonly name: RelationIdent }
	readonly query: Select
	readonly text: string
	readonly natives: ReadonlyArray<LawId>
}

/** The fill of each derived relation `installation` stores (StoredFill), in name order. */
const storedFills = (installation: Installation): ReadonlyArray<StoredFill> => {
	const creates = Arr.flatMap(installation.statements, (s) =>
		s.kind === "createStoredTable" ? [s] : []
	)
	const stored = Arr.sort(
		Arr.flatMap(Arr.fromIterable(installation.checked.holdings), ([relation, holding]) =>
			holding.kind === "stored" ? [relation] : []
		),
		Str.Order
	)
	return Arr.map(stored, (relation) => {
		const table = installation.names.relation(relation)
		const fill = fillStatement(
			defined(
				Arr.findFirst(creates, (create) => nameKey(create.name) === nameKey(table)).pipe(
					Option.getOrUndefined
				),
				`the stored table of ${relation}`
			)
		)
		return {
			relation,
			table,
			query: fill.query,
			text: printStatement(fill),
			natives: Arr.dedupe(
				Arr.flatten(Rec.values(installation.constraintToLaw.tables[table.name] ?? {}))
			)
		}
	})
}

/**
 * One case in its one transaction, which the case's end rolls back: the elements of `c` loaded with the triggers off,
 * a declaration at each of a declaring kind or of tag 5, weighed by its place, the tables analyzed; then, as the
 * migration that creates them runs them, each stored relation's fill (`storedFills`), explained with ANALYZE, which runs
 * it, and each rule's check, as the migration that adds the rule runs it (deploy/render/sql.ts violationCheck), each
 * statement it plans explained with ANALYZE, and the block run. A law the installation holds by a native of a stored
 * relation's table, Declared's key, has no check of its own: its migration's cost is the fill's, which the table's
 * unique index refuses at the first row that breaks the key. Every plan, a fill's and a check's, reads each table by one
 * node per occurrence its law or definition reads it at as the box declares it, so it derives no relation twice, and
 * handles each row it reads a bounded number of times: its rows touched (bench/harness/explain.ts rowsTouched, every row
 * each node handled over all its loops, a join's examined pairs among them) at most its nodes times the rows of the
 * tables and the rows its sequential rescans of tables no larger than an index probe touch (`smallTableRescans`), since
 * a filter, a projection, a deduplication, a hash, a sort and a merge pass each row of their input once, and an anti join
 * over sets passes each outer row once and meets each inner row once in its hash or merge. A plan that reads a set again
 * for each row of another, a nested loop over a materialized set, handles the product of the two, past the bound once the
 * outer holds more rows than the plan has nodes. The fill and the blocks raise nothing; then, the stored tables emptied
 * as their migration found them, with one element of a declaring kind and of tag, group and band 5 and no declaration
 * added, two declared elements of one document and kind of one weight, a name its document declares at two places of
 * two cardinalities, and a binding of attribute 1 to a variable of base type 2, each block raises SQLSTATE 23000 under
 * its law's identity and Declared's fill raises 23505 under its key's, the constraint the installation maps to it.
 */
export const runCheck = (
	migrated: Installed,
	connection: PgConnection,
	c: CheckCase,
	k: Case<CheckFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(migrated)
		const nodeTable = names.table(Node)
		const declTable = names.table(Decl)
		const declared = declarationsOf(c)
		const tables = {
			dcl: names.table(Dcl),
			card: names.table(Card),
			typed: names.table(Typed),
			bind: names.table(Bind)
		}
		const all = [nodeTable, declTable, tables.dcl, tables.card, tables.typed, tables.bind]
		for (const sql of [
			...Arr.map(all, (t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`),
			`INSERT INTO ${nodeTable} ${elementsOf(c)}`,
			`INSERT INTO ${declTable} SELECT pkg, path, at, at FROM ${nodeTable} WHERE kind IN (1, 2) OR tag = 5`,
			`INSERT INTO ${tables.dcl} ${declared.dcl}`,
			`INSERT INTO ${tables.card} ${declared.card}`,
			`INSERT INTO ${tables.typed} ${declared.typed}`,
			`INSERT INTO ${tables.bind} ${declared.bind}`,
			...Arr.map(all, (t) => `ANALYZE ${t}`)
		]) {
			yield* connection.query(sql, [])
		}
		const counted = yield* connection.queryValues(
			`SELECT ${Arr.join(
				Arr.map(all, (t) => `(SELECT pg_catalog.count(*) FROM ${t})`),
				" + "
			)}`,
			[]
		)
		const costs = yield* connection.queryValues(
			"SELECT pg_catalog.current_setting('random_page_cost')::pg_catalog.float8",
			[]
		)
		const bound: Bound = {
			rows: Number(defined(counted[0]?.[0], "the tables' count")),
			probeCost: 2 * Number(defined(costs[0]?.[0], "random_page_cost"))
		}
		const installation = migrated.installation
		const fills = storedFills(installation)
		assert.deepEqual<ReadonlyArray<string>>(
			Arr.map(fills, (f) => f.relation),
			storedDerived,
			"the box's stored relations, as the installation infers them"
		)
		const checks = lawChecks(installation)
		assert.equal(checks.rules.length, 4, "the schema's four rules")
		/**
		 * The occurrences of each table a rule reads as the box declares it, each rule of the box a unit-local one: each of
		 * its sides' relations, a derived one by the relations its rule matches where it is live (`storedReadsOf`), never
		 * the reads of the compiled check (WholeRule reads, walked from the violation query the check is), which count a
		 * side read twice twice.
		 */
		const occurrences = (law: LawId): ReadonlyArray<string> => {
			const rule = defined(
				Arr.findFirst(installation.laws.rules, (r) => r.law.id === law).pipe(Option.getOrUndefined),
				`${law}, a rule of the box`
			).rule
			if (rule.kind !== "whole") {
				return assert.fail(`${law}: a unit-local rule, judged whole`)
			}
			const sides = rule.law.kind === "contained" ? [rule.law.from, rule.law.to] : [rule.law.side]
			return Arr.map(
				Arr.flatMap(sides, (side) => storedReadsOf(side.relation)),
				(relation) => installation.names.relation(relation).name
			)
		}
		for (const fill of fills) {
			assert.equal(
				fill.natives.length,
				1,
				`${fill.relation}'s key, the one law its table's natives hold`
			)
			assert.equal(
				needlessDeduplications(fill.query).length,
				0,
				`${fill.relation}: the fill deduplicates no set it reads whole`
			)
			const plan = yield* explainedPlan(connection, fill.text)
			holdsTheBound(
				plan,
				Arr.map(
					fillReadsOf(fill.relation),
					(relation) => installation.names.relation(relation).name
				),
				bound,
				`${Formatter.format(c)}: ${fill.relation}'s fill`
			)
		}
		for (const rule of checks.rules) {
			assert.equal(
				needlessDeduplications(rule.query).length,
				0,
				`${rule.law}: the check deduplicates no set it reads whole`
			)
		}
		const blocks = Arr.map(checks.rules, (rule) => ({
			law: rule.law,
			text: sqlText(SourceLoc("check-cost", []), (out) =>
				writeDoBlock(out, violationCheck(rule.law, rule.query))
			)
		}))
		for (const { law, text } of blocks) {
			const planned = plannedStatements(text)
			assert.equal(planned.length, 1, "a check plans one statement over the tables")
			for (const statement of planned) {
				const plan = yield* explainedPlan(connection, statement)
				holdsTheBound(plan, occurrences(law), bound, `${Formatter.format(c)}: ${law}'s check`)
			}
			yield* connection.query(text, [])
		}
		k.note("a law that holds")
		for (const sql of [
			...Arr.map(fills, (f) => `TRUNCATE ${printObjectName(f.table)}`),
			`INSERT INTO ${nodeTable} VALUES (1000000, 0, 0, 1, 5, 5, 5), (1000000, 0, 1, 1, 0, 0, 0), (1000000, 0, 2, 1, 0, 0, 0)`,
			`INSERT INTO ${declTable} VALUES (1000000, 0, 1, 7), (1000000, 0, 2, 7)`,
			`INSERT INTO ${tables.dcl} VALUES (1000000, 0, 0, 0), (1000000, 0, 1, 0)`,
			`INSERT INTO ${tables.card} VALUES (1000000, 0, 0, 1), (1000000, 0, 1, 2)`,
			`INSERT INTO ${tables.typed} VALUES (1000000, 0, 0, 2)`,
			`INSERT INTO ${tables.bind} VALUES (1000000, 0, 10, 1, 0)`
		]) {
			yield* connection.query(sql, [])
		}
		for (const fill of fills) {
			const refused = yield* Effect.flip(connection.query(fill.text, []))
			const fields = pgErrorFields(refused)
			assert.equal(
				fields?.code,
				"23505",
				`${Formatter.format(c)}: ${fill.relation}'s fill refuses the two declared elements at one key`
			)
			assert.deepEqual<ReadonlyArray<LawId> | undefined>(
				fields?.constraint === undefined
					? undefined
					: lawsOfConstraint(
							installation.constraintToLaw,
							{ kind: "table", name: fill.table.name },
							fields.constraint
						),
				fill.natives,
				`${Formatter.format(c)}: under its key's identity`
			)
		}
		for (const { law, text } of blocks) {
			const refused = yield* Effect.flip(connection.query(text, []))
			const fields = pgErrorFields(refused)
			assert.equal(
				fields?.code,
				"23000",
				`${Formatter.format(c)}: the check refuses the undeclared element`
			)
			assert.equal(fields?.constraint, law, `${Formatter.format(c)}: under the law's identity`)
		}
		k.note("a violation found")
	})
