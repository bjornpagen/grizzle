/** What check-cost.test.ts reads: the schemas, their templates, the spaces, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { folderSource } from "#adapter/migrate/input.ts"
import { findNodes, type PlanNode, planNodes, rowsTouched } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { isCanonicalName } from "#compiler/analysis/derived/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { BoundDraft } from "#compiler/deploy/render/advise.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { statedAdvice } from "#compiler/plan/migration.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
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
	sealed,
	select,
	unit
} from "#compiler/public/schema.ts"
import {
	type FromSource,
	isSetQuery,
	nameKey,
	type OperandSelect,
	selectColumns,
	type SelectCore
} from "#compiler/sql/ast.ts"
import { printObjectName, sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { identityHooks, transformQuery } from "#compiler/sql/transform.ts"
import {
	advisedExplain,
	apart,
	budgetOfPlan,
	draftPlanned,
	fileScope,
	type LawScope,
	lawsHold,
	type PgClassState,
	pgClassStates,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftedAt, fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import type { RolledBack } from "#test/support/substrate/substrate.ts"

/** A package's elements, by package, document and place, each of a kind, as pantry stores QTI content. */
const Node = relation(
	"Node",
	{
		pkg: int4,
		path: int4,
		at: int4,
		kind: int4,
		tag: int4,
		grp: int4,
		band: int4
	},
	["pkg", "path", "at"]
)

/** A declaration, at the element that declares it. */
const Decl = relation("Decl", { pkg: int4, path: int4, at: int4, w: int4 }, ["pkg", "path", "at"])

/** A declared variable's identifier, at the element that declares it, as QTI's DeclarationIdentifier. */
const Dcl = relation("Dcl", { pkg: int4, path: int4, at: int4, ident: int4 }, ["pkg", "path", "at"])

/** A declaration's cardinality, at its element, as QTI's DeclarationCardinality. */
const Card = relation("Card", { pkg: int4, path: int4, at: int4, card: int4 }, [
	"pkg",
	"path",
	"at"
])

/** A declaration's base type, at its element, as QTI's DeclarationBaseType. */
const Typed = relation("Typed", { pkg: int4, path: int4, at: int4, base: int4 }, [
	"pkg",
	"path",
	"at"
])

/** A binding at an element, of an attribute, naming a variable its document declares, as QTI's BoundVariable. */
const Bind = relation("Bind", { pkg: int4, path: int4, at: int4, attr: int4, ident: int4 }, [
	"pkg",
	"path",
	"at"
])

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
		unit("Doc", { pkg: int4, path: int4 }),
		mutable(Node),
		mutable(Decl),
		contained(
			on(
				select(Node, (n) => n.or([n.eq(n.kind, 1), n.eq(n.kind, 2)])),
				"pkg",
				"path",
				"at"
			),
			on(Decl, "pkg", "path", "at")
		),
		contained(
			on(
				select(Node, (n) => n.and([n.eq(n.tag, 5), n.eq(n.grp, 5), n.eq(n.band, 5)])),
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
 * twice when it was a self-join of the side. And no declared name of a document has two cardinalities, however many
 * places declare it: a key over CardName, each declared name beside its cardinality with its place projected away, as
 * QTI's One base, a key over KnownOperandBase. The installation stores Declared, CardName and TypedName, each unit-local
 * in Doc with an upkeep its delta bounds (analysis/derived/storage.ts), so each key is its table's unique index, which
 * its fill and its upkeep's INSERT fire, its migration's cost the fill's.
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
 * 193 s over zero violations. The installation stores Fit too, so the check is its table's CHECK constraint, which its
 * fill fires, reading CardName's and TypedName's tables.
 */
const Checked = schema.extend(
	[Mid],
	"CheckCost_2",
	[Fit],
	[check("Fit", Fit, (f) => f.or([f.ne(f.attr, 1), f.eq(f.base, 1)]))]
)

/**
 * The relations each derived relation of the box matches, an entry at each occurrence its rule reads one: what a law over
 * it reads as the schema declares it, and what its fill reads where it is stored (`readsOf`).
 */
const declaredReads: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	[Declared.name, [Node.name, Decl.name]],
	[CardName.name, [Dcl.name, Card.name]],
	[TypedName.name, [Dcl.name, Typed.name]],
	[Fit.name, [Bind.name, CardName.name, TypedName.name]]
])

/** The schema installed through its first migration, its tables empty. */
export const checkCostTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "check cost",
	content: { schema: Checked.name, logins: [] },
	versions: [{ schema: Checked, declarations: noDeclarations }],
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

export type CheckFeature = "a law that holds" | "a violation found" | `every table ${PgClassState}`

/**
 * Elements `from` to `to` of `c`, from 1, as one INSERT's SELECT over generate_series's i: package, document, place,
 * kind, and its tag, group and band, each i mod 20; `spread` numbers its i from 1, `documents` from 0.
 */
const elementsOf = (c: CheckCase, from: number, to: number): string => {
	switch (c.layout) {
		case "spread":
			return `SELECT i % 7, i % 13, i, i % 4, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(${from}, ${to}) AS g(i)`
		case "documents":
			return `SELECT i / 1000, (i / 50) % 20, i % 50, CASE WHEN i % 25 = 0 THEN 1 WHEN i % 31 = 0 THEN 2 ELSE 3 + i % 5 END, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(${from - 1}, ${to - 1}) AS g(i)`
	}
}

/**
 * The declarations and bindings at elements `from` to `to` of `c`, from 1, each one INSERT's SELECT over
 * generate_series's i, from 0, of one table: documents of 50 elements, size / 50 of them, each its own path, 20
 * documents to a package where `documents` lays them out one after the other and 7 packages where `spread` deals the
 * elements round the documents; places 0 to 9 of a document declare variables 0 to 9, each of cardinality 1 and base
 * type 1, and places 10 to 49 bind one, of attribute place mod 3. Each binding names one declaration of its document,
 * and every one is lawful: base type 1.
 */
const declarationsOf = (
	c: CheckCase,
	from: number,
	to: number
): Readonly<Record<"dcl" | "card" | "typed" | "bind", string>> => {
	const docs = c.size / 50
	const place = c.layout === "documents" ? "i % 50" : `i / ${docs}`
	const doc = c.layout === "documents" ? "i / 50" : `i % ${docs}`
	const pkg = c.layout === "documents" ? `${doc} / 20` : `${doc} % 7`
	const series = `FROM (SELECT ${pkg} AS pkg, ${doc} AS path, ${place} AS at FROM pg_catalog.generate_series(${from - 1}, ${to - 1}) AS g(i)) AS e`
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

/** A table of the installation, by its schema and its name: a relation's, as the installation names it. */
type StoredTable = ReturnType<Installation["names"]["relation"]>

/**
 * What a data step of a migration file is (`DataStep`): a stored relation's fill, the INSERT the migration that creates
 * its table fills it by (physical/derived/objects.ts fillStatement), of `relation` into `table`; or a law's violation
 * check, the DO block the migration that adds the law runs (physical/ddl/recheck.ts violationCheck).
 */
type Step =
	| { readonly kind: "fill"; readonly relation: string; readonly table: StoredTable }
	| { readonly kind: "check"; readonly law: LawId }

/**
 * A data step as its file runs it, bound (deploy/render/advise.ts BoundDraft): what it is (`Step`), the query it reads
 * every row by, the statement PostgreSQL plans of it (a fill's INSERT; a check's probe as PL/pgSQL hands it the planner,
 * sql/print.ts printPlannedQuery `found`), the statement the file sends, and the laws it refuses a violation of under
 * their identity: the natives a fill's INSERT fires, every law the installation's constraint map reads under one of its
 * table's constraints (ir/products.ts ConstraintLaws), or a check's law.
 */
interface DataStep {
	readonly step: Step
	readonly query: OperandSelect
	readonly planned: string
	readonly sent: string
	readonly holds: ReadonlyArray<LawId>
}

/** A data step as a failure names it. */
const stepText = (step: Step): string =>
	step.kind === "fill" ? `${step.relation}'s fill` : `${step.law}'s check`

/**
 * A transactional file of a migration that runs data steps: the advice the runner sets as its transaction's first
 * statement (LedgerStatements `advise`), its folder's meta.json's record of it as the runner reads it
 * (deploy/render/folder.ts statedAdvice), its data steps in its order, and their scope (test/support/advice.ts
 * fileScope): the plans their bound drafts carry, joined and resolved by the installation, its vehicle the advice the
 * runner sets.
 */
interface StepFile {
	readonly set: string
	readonly steps: Arr.NonEmptyReadonlyArray<DataStep>
	readonly scope: LawScope
}

/**
 * The data steps of `migrated`'s one migration, file by file (StepFile), as the runner runs them: the migration drafted
 * again over the template's installation from the empty snapshot, as its build drafted it (install-migrate.ts
 * draftVersion), its files' drafts bound (deploy/render/advise.ts AdvisedFile); each file's advice as the runner reads it
 * from the folder the template applied, every statement of it a recorded one, so the record's advice holds at each.
 */
const stepFiles = (migrated: Installed): ReadonlyArray<StepFile> => {
	const installation = migrated.installation
	const [folder, ...later] = migrated.folders
	assert.equal(later.length, 0, "the template's one migration")
	const meta = succeeded(folderSource(folder).meta, "the applied folder's meta.json")
	const drafted = succeeded(
		generate({
			installation,
			name: "install",
			timestamp: draftedAt(0),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations
		}),
		"the template's migration drafted again"
	)
	const stored = Arr.flatMap(
		Arr.fromIterable(installation.checked.holdings),
		([relation, holding]) => (holding.kind === "stored" ? [relation] : [])
	)
	/** A data step of the box as its file writes it, `planned` what PostgreSQL plans of it (draftPlanned). */
	const stepOf = (d: BoundDraft, planned: string): DataStep => {
		switch (d.kind) {
			case "step": {
				const statement = d.statement
				if (statement.kind !== "fillStored") {
					return assert.fail(`${planned}: a data step of the box is a stored relation's fill`)
				}
				const relation = defined(
					Arr.findFirst(
						stored,
						(r) => nameKey(installation.names.relation(r)) === nameKey(statement.table)
					).pipe(Option.getOrUndefined),
					`the stored relation of ${printObjectName(statement.table)}`
				)
				const table = installation.names.relation(relation)
				return {
					step: { kind: "fill", relation, table },
					query: statement.query,
					planned,
					sent: planned,
					holds: Arr.dedupe(
						Arr.flatten(Rec.values(installation.constraintToLaw.tables[table.name] ?? {}))
					)
				}
			}
			case "violation": {
				const [found] = d.block.body
				return found.kind === "whenFound"
					? {
							step: { kind: "check", law: d.law },
							query: found.query,
							planned,
							sent: sqlText(SourceLoc("check-cost", []), (out) => writeDoBlock(out, d.block)),
							holds: [d.law]
						}
					: assert.fail(`${d.law}: a check probes its violation query`)
			}
			case "statement":
			case "alteration":
			case "fill":
			case "zones":
			case "loss":
			case "confirm":
				return assert.fail(`${planned}: a draft of no data step, which plans nothing`)
		}
	}
	return Arr.flatMap(drafted.files, (file): ReadonlyArray<StepFile> => {
		const steps = Arr.flatMap(file.drafts, (d) =>
			Arr.map(Option.toArray(draftPlanned(d)), (p) => stepOf(d, p.sql))
		)
		if (!Arr.isReadonlyArrayNonEmpty(steps)) {
			return []
		}
		const written = defined(
			Arr.findFirst(folder.files, (f) => f.name === file.file.name).pipe(Option.getOrUndefined),
			`${file.file.name}, a file of the applied folder`
		)
		const stated = statedAdvice(meta, written)
		assert.ok(
			Arr.every(stated.reviewed, (reviewed) => !reviewed),
			`${file.file.name}: every statement a recorded one`
		)
		return [
			{
				set: stated.advice,
				steps,
				scope: fileScope(file, installation.resolve, stated.advice)
			}
		]
	})
}

/** The rows the tables `tables` name, each qualified and quoted, hold now. */
const rowsIn = (connection: PgConnection, tables: ReadonlyArray<string>) =>
	Effect.map(
		connection.queryValues(
			`SELECT ${Arr.join(
				Arr.map(tables, (t) => `(SELECT pg_catalog.count(*) FROM ${t})`),
				" + "
			)}`,
			[]
		),
		(counted) => Number(defined(counted[0]?.[0], "the tables' count"))
	)

/**
 * Holds one plan PostgreSQL ran, `what`'s, to the bound: it reads each table by at most one plan node per occurrence
 * `reads` holds of it, the node that writes a fill's table, its INSERT's ModifyTable, reading none of it, and touches at
 * most its nodes times `rows`, the rows of the tables it reads (bench/harness/explain.ts rowsTouched, every row each node
 * handled over all its loops, a join's examined pairs among them): a filter, a projection, a deduplication, a hash, a
 * sort and a merge pass each row of their input once, a probe meets the rows of its key, and an anti join over sets
 * passes each outer row once and meets each inner row once in its hash or merge. A plan that reads a set again for each
 * row of another, a nested loop over a materialized set, handles the product of the two, past the bound once the outer
 * holds more rows than the plan has nodes.
 */
const holdsTheBound = (
	plan: PlanNode,
	reads: ReadonlyArray<string>,
	rows: number,
	what: string
): void => {
	const nodes = Arr.fromIterable(planNodes(plan))
	const touched = rowsTouched(plan)
	assert.ok(
		touched <= nodes.length * rows,
		`${what} touches ${touched} rows, past its ${nodes.length} nodes times the ${rows} rows it reads, ${Formatter.format(Arr.map(nodes, (n) => n.nodeType))}`
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
 * A violation a case writes into its lawful rows, each law of the box broken alone (`brokenAlone`): its rows, each an
 * INSERT into a table of the box, and the data steps that refuse it, each under its own laws' identity, every other
 * step running clean.
 */
interface Violation {
	readonly label: string
	readonly rows: ReadonlyArray<string>
	readonly refusedBy: (step: Step) => boolean
}

/**
 * What a case's runs of the data steps read beside its rows: the installation, its migration's files of data steps, and
 * the tables each step reads.
 */
interface Steps {
	readonly migrated: Installed
	readonly files: ReadonlyArray<StepFile>
	/** The tables each step reads, one at each occurrence its law or definition reads one. */
	readonly reads: (step: Step) => ReadonlyArray<StoredTable>
}

/**
 * Every file's data steps run over the rows a case stood, as the migration runs them, each file's under the advice the
 * runner sets: the plan laws over its scope (test/support/advice.ts lawsHold, Laws 1 to 3: the advice the record holds is
 * the advice its steps' plans carry, every atom matched in one statement, every bound column an index condition), which
 * then holds that advice in force; then each step: no SELECT DISTINCT of its query reads only sets whose every column its
 * targets keep (`needlessDeduplications`), its planned statement run under the advice by EXPLAIN ANALYZE, generic as
 * every session grizzle opens plans it (advisedExplain), a fill's INSERT filling its table, held to its bound
 * (`holdsTheBound`) over the rows of the tables it reads and to the budget its plan gives (budgetOfPlan, each index read
 * its descents times its height and two pages a row, each whole read its table's pages); and a check's block then run,
 * raising nothing.
 */
const lawfulRuns = (clone: RolledBack<Installed>, steps: Steps, label: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const session: BenchSession = { values: clone.connection.queryValues }
			const superuser = yield* superuserClient(clone.cluster, clone.database, "check cost heights")
			for (const file of steps.files) {
				yield* lawsHold(session, file.scope)
				for (const s of file.steps) {
					const what = `${label}: ${stepText(s.step)}`
					assert.equal(
						needlessDeduplications(s.query).length,
						0,
						`${what} deduplicates no set it reads whole`
					)
					const reads = steps.reads(s.step)
					const rows = yield* rowsIn(clone.connection, Arr.dedupe(Arr.map(reads, printObjectName)))
					const plan = yield* advisedExplain(session, s.planned, [])
					holdsTheBound(
						plan,
						Arr.map(reads, (t) => t.name),
						rows,
						what
					)
					const budget = yield* budgetOfPlan(
						session,
						(sql) => Effect.orDie(superuser.query(sql, [])),
						what,
						plan
					)
					assert.deepEqual(budget, [], `${what} keeps its plan's budget\n${s.planned}`)
					if (s.step.kind === "check") {
						yield* clone.connection.query(s.sent, [])
					}
				}
			}
		})
	)

/**
 * Each violation of `violations` written alone into the rows a case stood, each in a savepoint of its own rolled back
 * after it (test/support/advice.ts apart), the stored tables emptied as the migration that creates them finds them:
 * every file's data steps run in order as the migration sends them, each file's under the advice the runner sets
 * (LedgerStatements `advise`, the runner's own statement), each step its own savepoint, so a refused one leaves the rest
 * to run; the steps the violation names refuse it with SQLSTATE class 23, under exactly the laws they hold (a native's
 * constraint as the installation maps it to its laws, ir/products.ts lawsOfConstraint, a check's the law it raises
 * under), and every other step runs clean.
 */
const brokenAlone = (
	clone: RolledBack<Installed>,
	steps: Steps,
	violations: ReadonlyArray<Violation>,
	label: string
) =>
	Effect.gen(function* () {
		const migrated = steps.migrated
		const advise = succeeded(
			ledgerStatements(identifierOf(identity.schema(parsedSchemaName(migrated.declared)))),
			"the ledger's statements"
		).advise.text
		const filled = Arr.flatMap(steps.files, (f) =>
			Arr.flatMap(f.steps, (s) => (s.step.kind === "fill" ? [s.step.table] : []))
		)
		for (const violation of violations) {
			yield* apart(
				{ values: clone.bare.queryValues },
				"check_cost_violation",
				[],
				Effect.gen(function* () {
					for (const sql of [
						...Arr.map(filled, (table) => `TRUNCATE ${printObjectName(table)}`),
						...violation.rows
					]) {
						yield* clone.connection.query(sql, [])
					}
					for (const file of steps.files) {
						yield* clone.connection.query(advise, [file.set])
						for (const s of file.steps) {
							const what = `${label}, ${violation.label}: ${stepText(s.step)}`
							const ran = yield* Effect.result(clone.connection.query(s.sent, []))
							if (!violation.refusedBy(s.step)) {
								assert.ok(Result.isSuccess(ran), `${what} runs clean`)
								continue
							}
							assert.ok(Result.isFailure(ran), `${what} refuses it`)
							const fields = pgErrorFields(ran.failure)
							assert.ok(
								Str.startsWith("23")(fields?.code ?? ""),
								`${what}: an integrity violation, ${Formatter.format(fields)}`
							)
							assert.deepEqual<ReadonlyArray<string> | undefined>(
								fields?.constraint === undefined
									? undefined
									: s.step.kind === "check"
										? [fields.constraint]
										: lawsOfConstraint(
												migrated.installation.constraintToLaw,
												{ kind: "table", name: s.step.table.name },
												fields.constraint
											),
								s.holds,
								`${what}: under the identity of the laws it holds`
							)
						}
					}
				})
			)
		}
	})

/**
 * The stored relations `relation` reads as the box declares it, one at each occurrence, each by its installed name:
 * itself where `stored` holds it, else the relations its rule matches (`declaredReads`).
 */
const storedReadsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<StoredTable> => {
	const read = declaredReads.get(relation)
	return read === undefined || installation.checked.holdings.get(relation)?.kind === "stored"
		? [installation.names.relation(relation)]
		: Arr.flatMap(read, (r) => storedReadsOf(installation, r))
}

/**
 * The tables a data step of the box reads, one at each occurrence (`Steps` `reads`): a fill's, each relation its
 * definition matches (`declaredReads`), a stored one by its table, a live one by its definition (`storedReadsOf`); a
 * check's, each side of its law, never the reads of the compiled check, which count a side read twice twice.
 */
const checkReads =
	(installation: Installation) =>
	(step: Step): ReadonlyArray<StoredTable> => {
		if (step.kind === "fill") {
			return Arr.flatMap(
				defined(
					declaredReads.get(step.relation),
					`${step.relation}, a derived relation of the box`
				),
				(r) => storedReadsOf(installation, r)
			)
		}
		const rule = defined(
			Arr.findFirst(installation.laws.rules, (r) => r.law.id === step.law).pipe(
				Option.getOrUndefined
			),
			`${step.law}, a rule of the box`
		).rule
		if (rule.kind !== "whole") {
			return assert.fail(`${step.law}: a unit-local rule, judged whole`)
		}
		const sides = rule.law.kind === "contained" ? [rule.law.from, rule.law.to] : [rule.law.side]
		return Arr.flatMap(sides, (side) => storedReadsOf(installation, side.relation))
	}

/**
 * One case in its one transaction, which the case's end rolls back, held in every pg_class state (test/support/advice.ts
 * PgClassState), each within a savepoint rolled back after it (apart): the judge stood up, and the elements of `c`
 * written through the captures, a declaration at each of a declaring kind or of tag 5, weighed by its place, and the
 * declarations and bindings beside them, every table stood in the state (standIn), as a migration's
 * data steps write the rows its checks then read in its one transaction, the judge deferred to a COMMIT the case never
 * reaches; then the data steps of the template's migration run over them (`lawfulRuns`): each stored relation's fill,
 * whose table's natives hold every law over it alone (Declared's and CardName's keys, its unique index, and Fit's check,
 * its CHECK constraint), and each rule's check (deploy/render/sql.ts, BoundDraft `violation`), each held to the plan laws
 * under the advice the runner sets, to its bound and to its budget, the fills and the checks raising nothing; and then
 * each law broken alone (`brokenAlone`): an element of a declaring kind and of tag, group and band 5 that no
 * declaration names, which each check refuses under its law's identity; two declared elements of one document and kind
 * of one weight, which Declared's fill refuses under its key's; a name its document declares at two places of two
 * cardinalities, which CardName's fill refuses under its key's; and a binding of attribute 1 to a variable of base type
 * 2, which Fit's fill refuses under its check's.
 */
export const runCheck = (clone: RolledBack<Installed>, c: CheckCase, k: Case<CheckFeature>) =>
	Effect.gen(function* () {
		const migrated = clone.value
		const installation = migrated.installation
		const connection = clone.connection
		yield* standUpJudge(connection, installation)
		const names = namesOf(migrated)
		const tables = {
			node: names.table(Node),
			decl: names.table(Decl),
			dcl: names.table(Dcl),
			card: names.table(Card),
			typed: names.table(Typed),
			bind: names.table(Bind)
		}
		const files = stepFiles(migrated)
		const fills = Arr.flatMap(files, (f) =>
			Arr.flatMap(f.steps, (s) => (s.step.kind === "fill" ? [s.step.relation] : []))
		)
		assert.deepEqual<ReadonlyArray<string>>(
			Arr.sort(fills, Order.String),
			Arr.sort(
				Arr.flatMap(Arr.fromIterable(installation.checked.holdings), ([relation, holding]) =>
					holding.kind === "stored" ? [relation] : []
				),
				Order.String
			),
			"the migration fills every relation the installation stores"
		)
		const steps: Steps = { migrated, files, reads: checkReads(installation) }
		const violations: ReadonlyArray<Violation> = [
			{
				label:
					"an element of a declaring kind and of tag, group and band 5 that no declaration names",
				rows: [`INSERT INTO ${tables.node} VALUES (1000000, 0, 0, 1, 5, 5, 5)`],
				refusedBy: (step) => step.kind === "check"
			},
			{
				label: "two declared elements of one document and kind of one weight",
				rows: [
					`INSERT INTO ${tables.node} VALUES (1000001, 0, 1, 1, 0, 0, 0), (1000001, 0, 2, 1, 0, 0, 0)`,
					`INSERT INTO ${tables.decl} VALUES (1000001, 0, 1, 7), (1000001, 0, 2, 7)`
				],
				refusedBy: (step) => step.kind === "fill" && step.relation === Declared.name
			},
			{
				label: "a name its document declares at two places of two cardinalities",
				rows: [
					`INSERT INTO ${tables.dcl} VALUES (1000002, 0, 0, 0), (1000002, 0, 1, 0)`,
					`INSERT INTO ${tables.card} VALUES (1000002, 0, 0, 1), (1000002, 0, 1, 2)`
				],
				refusedBy: (step) => step.kind === "fill" && step.relation === CardName.name
			},
			{
				label: "a binding of attribute 1 to a variable of base type 2",
				rows: [
					`INSERT INTO ${tables.dcl} VALUES (1000003, 0, 0, 0)`,
					`INSERT INTO ${tables.card} VALUES (1000003, 0, 0, 1)`,
					`INSERT INTO ${tables.typed} VALUES (1000003, 0, 0, 2)`,
					`INSERT INTO ${tables.bind} VALUES (1000003, 0, 10, 1, 0)`
				],
				refusedBy: (step) => step.kind === "fill" && step.relation === Fit.name
			}
		]
		const run = (statements: ReadonlyArray<string>) =>
			Effect.forEach(statements, (sql) => connection.query(sql, []), { discard: true })
		const stated: Arr.NonEmptyReadonlyArray<string> = [
			tables.node,
			tables.decl,
			tables.dcl,
			tables.card,
			tables.typed,
			tables.bind
		]
		for (const state of pgClassStates) {
			yield* apart(
				{ values: clone.bare.queryValues },
				"check_cost_state",
				stated,
				Effect.gen(function* () {
					yield* standIn(
						{ values: connection.queryValues },
						{
							tables: stated,
							units: c.size,
							load: (from, to) => {
								const declared = declarationsOf(c, from, to)
								return run([
									`INSERT INTO ${tables.node} ${elementsOf(c, from, to)}`,
									`INSERT INTO ${tables.decl} SELECT e.pkg, e.path, e.at, e.at FROM (${elementsOf(c, from, to)}) AS e(pkg, path, at, kind, tag, grp, band) WHERE e.kind IN (1, 2) OR e.tag = 5`,
									`INSERT INTO ${tables.dcl} ${declared.dcl}`,
									`INSERT INTO ${tables.card} ${declared.card}`,
									`INSERT INTO ${tables.typed} ${declared.typed}`,
									`INSERT INTO ${tables.bind} ${declared.bind}`
								])
							}
						},
						state
					)
					const label = `${Formatter.format(c)}, with every table ${state}`
					yield* lawfulRuns(clone, steps, label)
					k.note("a law that holds")
					yield* brokenAlone(clone, steps, violations, label)
					k.note("a violation found")
					k.note(`every table ${state}`)
				})
			)
		}
	})

/**
 * A package's manifest's elements, by package, document and place, each of a kind and under its parent, as pantry's
 * Node: a resource, under the manifest's root, and its metadata, under the resource.
 */
const ManifestNode = relation(
	"ManifestNode",
	{ pkg: int4, path: int4, start: int4, kind: int4, parent: int4 },
	["pkg", "path", "start"]
)

/** The elements of the documents records are read from, each with its parent's kind, as pantry's RecordNode stores them. */
const RecordNode = relation(
	"RecordNode",
	{
		pkg: int4,
		path: int4,
		start: int4,
		kind: int4,
		parent: int4,
		parentKind: int4
	},
	["pkg", "path", "start"]
)

/** An element's attribute, by the element's place and the attribute's name, with the element's kind: pantry's Attribute. */
const Attribute = relation(
	"Attribute",
	{
		pkg: int4,
		path: int4,
		start: int4,
		name: int4,
		kind: int4,
		value: int4
	},
	["pkg", "path", "start", "name"]
)

/** A resource's `href` that resolves in its package, by the resource's place: the path of the entry it names. */
const HrefPath = relation("HrefPath", { pkg: int4, path: int4, start: int4, target: int4 }, [
	"pkg",
	"path",
	"start"
])

/** A document a resource of its package lists, by its package and path, with that resource's type: ResourceDocument. */
const ListedDocument = relation("ListedDocument", { pkg: int4, path: int4, type: int4 }, [
	"pkg",
	"path"
])

/** The kinds of a resource, its metadata and a record, the attribute names `type` and `href`, and two object types. */
const naming = {
	resource: 1,
	metadata: 2,
	record: 3,
	type: 1,
	href: 2,
	item: 8,
	test: 14,
	web: 19
} as const

/**
 * The manifest's relations under the package, sealed at its founding as pantry's Package is, so the installation stores
 * every derived relation over a package's content, each filled by the migration that creates it.
 */
const Manifest = schema(
	"NamingFill",
	[ManifestNode, RecordNode, Attribute, HrefPath, ListedDocument],
	[sealed(unit("Package", { pkg: int4 }))]
)

/** A resource's type, by its place: its `type` attribute's value, as pantry's resourceTypes (attributeCodes). */
const resourceTypes = query(Manifest).rule((r) => {
	const { pkg, path, start, value } = v(Attribute, "typed")
	return r
		.match(Attribute, { kind: naming.resource, name: naming.type, pkg, path, start, value })
		.find({ code: value, pkg, path, start })
})

/**
 * The records that name a document, each with that document, as pantry's namingRecords (qti/queries.ts): a record under
 * a resource's metadata, the resource's type an object's, and the document its `href` lists. Its matches and their
 * bindings are namingRecords' own: the metadata element is the one occurrence that relates the record to its resource,
 * and the `href` the one that relates the resource to its document, so neither is an existence test, each read at the
 * key the other relations carry (lower/optimize/demand/restriction.ts). As existence tests, the record is joined to
 * every typed resource of its document and each to every listed document of its package, the two tests applied to the
 * product: the fill of edullm's QTI copy ran 452 s over its 0 rows, 656,026,169 buffers.
 */
const Named = derived(
	"Named",
	query(Manifest).rule((r) => {
		const { pkg, path, parent: metadata, start: record } = v(RecordNode, "record")
		const { parent: resource } = v(ManifestNode, "metadata")
		const { target: document } = v(HrefPath, "href")
		const { code: type } = v(resourceTypes, "resourceType")
		return r
			.match(RecordNode, {
				kind: naming.record,
				parent: metadata,
				parentKind: naming.metadata,
				pkg,
				path,
				start: record
			})
			.match(ManifestNode, { parent: resource, pkg, path, start: metadata })
			.match(HrefPath, { pkg, path, start: resource, target: document })
			.match(resourceTypes, { code: type, pkg, path, start: resource })
			.match(ListedDocument, { pkg, path: document })
			.where(r.in(type, [naming.item, naming.test]))
			.find({ document, pkg, path, record })
	})
)

const Naming = schema.extend([Manifest], "NamingFill_1", [Named], [])

/**
 * The relations each stored relation's fill reads, one at each occurrence of its definition: the resource types, a
 * closed sub-query over the sealed package's content that Named imports, are a canonical relation the installation
 * stores (analysis/derived/canonical.ts), filled from the attributes, and Named's fill derives its definition from the
 * relations it matches, the resource types from the attributes where the import stands, beside the manifest's records,
 * elements, `href`s and listed documents.
 */
const namingReads =
	(installation: Installation) =>
	(step: Step): ReadonlyArray<StoredTable> =>
		Arr.map(
			step.kind === "fill" && step.relation === Named.name
				? [RecordNode.name, ManifestNode.name, HrefPath.name, Attribute.name, ListedDocument.name]
				: [Attribute.name],
			(relation) => installation.names.relation(relation)
		)

/** The manifest's schema installed through its first migration, its tables empty. */
export const namingFillTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "naming fill",
	content: { schema: Naming.name, logins: [] },
	versions: [{ schema: Naming, declarations: noDeclarations }],
	options: {
		label: "naming_fill",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * How a package's resources stand: `listed`, every resource of an object's type, its `href` resolved and its document
 * listed; `mixed`, every third without a resolved `href`, every fifth of a type no object is, every seventh naming a
 * document its package lists none at.
 */
const namingLayouts = ["listed", "mixed"] as const

export interface NamingCase {
	readonly layout: (typeof namingLayouts)[number]
	readonly packages: 1 | 4
	readonly resources: 16 | 64 | 256
}

/** The box: every layout, at one package and at four, of 16, 64 and 256 resources each. */
export const namingCaseGen: Gen<NamingCase> = (s) => ({
	layout: s.draw(element(namingLayouts)),
	packages: s.draw(element([1, 4] as const)),
	resources: s.draw(element([16, 64, 256] as const))
})

export type NamingFeature =
	| "a record that names its document"
	| "a record that names none"
	| `every table ${PgClassState}`

/** Whether resource `n` of a package names its document: under `mixed`, one whose `href`, type and listing all stand. */
const namesItsDocument = (c: NamingCase, n: number): boolean =>
	c.layout === "listed" || (n % 3 !== 2 && n % 5 !== 4 && n % 7 !== 6)

/** The box's tables, each by its part in a case's rows. */
const namingTables = ["node", "record", "attribute", "href", "listed"] as const
type NamingTable = (typeof namingTables)[number]

/**
 * The rows of resources `from` to `to` of `c`, from 1, each table's one INSERT's SELECT over packages p and resources n,
 * from 0: in each package's manifest, path 0, resource n at place 10n + 1 under the root, its metadata at 10n + 2 and its
 * record at 10n + 3; the resource's `type` and `href` attributes; its resolved `href` to document n + 1; and document
 * n + 1 listed, of the resource's type.
 */
const namingRowsOf = (
	c: NamingCase,
	from: number,
	to: number
): Readonly<Record<NamingTable, string>> => {
	const grid = `FROM pg_catalog.generate_series(1, ${c.packages}) AS p(p), pg_catalog.generate_series(${from - 1}, ${to - 1}) AS g(n)`
	const mixed = c.layout === "mixed"
	const type = mixed
		? `CASE WHEN n % 5 = 4 THEN ${naming.web} WHEN n % 2 = 0 THEN ${naming.item} ELSE ${naming.test} END`
		: `CASE WHEN n % 2 = 0 THEN ${naming.item} ELSE ${naming.test} END`
	return {
		node: `SELECT p, 0, 10 * n + 1, ${naming.resource}, 0 ${grid} UNION ALL SELECT p, 0, 10 * n + 2, ${naming.metadata}, 10 * n + 1 ${grid}`,
		record: `SELECT p, 0, 10 * n + 3, ${naming.record}, 10 * n + 2, ${naming.metadata} ${grid}`,
		attribute: `SELECT p, 0, 10 * n + 1, ${naming.type}, ${naming.resource}, ${type} ${grid} UNION ALL SELECT p, 0, 10 * n + 1, ${naming.href}, ${naming.resource}, n + 1 ${grid}`,
		href: `SELECT p, 0, 10 * n + 1, n + 1 ${grid}${mixed ? " WHERE n % 3 <> 2" : ""}`,
		listed: `SELECT p, n + 1, ${type} ${grid}${mixed ? " WHERE n % 7 <> 6" : ""}`
	}
}

/**
 * One case in its one transaction, which the case's end rolls back, held in every pg_class state (test/support/advice.ts
 * PgClassState), each within a savepoint rolled back after it (apart): the judge stood up, the packages of `c` written
 * through the captures, every table stood in the state (standIn), the judge deferred to a COMMIT the case never reaches;
 * then the data steps of the template's migration run over them (`lawfulRuns`), each stored relation's fill as the
 * migration that creates their tables runs them, the resource types' canonical relation first, then Named's, each held
 * to the plan laws under the advice the runner sets, to its bound and to its budget: each record, its metadata, its
 * resource's `href` and type and the listed document read a bounded number of times, by a lookup of what the steps
 * before it bound, at most a log of the rows each, the fill's work O(n log n) in its records, elements, attributes and
 * documents. Where a record is joined to its resource's type and document by its package alone, the metadata and the
 * `href` tests above, it touches the product of the package's records, resources and documents, past the bound once a
 * package holds more resources than the plan has nodes. And Named's fill holds each record that names a document, and
 * only those.
 */
export const runNamingFill = (
	clone: RolledBack<Installed>,
	c: NamingCase,
	k: Case<NamingFeature>
) =>
	Effect.gen(function* () {
		const migrated = clone.value
		const installation = migrated.installation
		const connection = clone.connection
		yield* standUpJudge(connection, installation)
		const tableOf = namesOf(migrated).table
		const tables: Readonly<Record<NamingTable, string>> = {
			node: tableOf(ManifestNode),
			record: tableOf(RecordNode),
			attribute: tableOf(Attribute),
			href: tableOf(HrefPath),
			listed: tableOf(ListedDocument)
		}
		const files = stepFiles(migrated)
		const fills = Arr.flatMap(files, (f) => f.steps)
		const [types, named, ...more] = Arr.map(fills, (s) => s.step)
		assert.ok(
			types?.kind === "fill" &&
				isCanonicalName(types.relation) &&
				named?.kind === "fill" &&
				named.relation === Named.name &&
				more.length === 0,
			`the box's data steps, as the installation infers its stored relations: the resource types' canonical relation's fill, then Named's, ${Formatter.format(Arr.map(fills, (s) => stepText(s.step)))}`
		)
		const namers = Arr.filter(
			Array.from({ length: c.resources }, (_, n) => n),
			(n) => namesItsDocument(c, n)
		).length
		const stood = Arr.map(namingTables, (t) => tables[t])
		for (const state of pgClassStates) {
			yield* apart(
				{ values: clone.bare.queryValues },
				"naming_fill_state",
				stood,
				Effect.gen(function* () {
					yield* standIn(
						{ values: connection.queryValues },
						{
							tables: stood,
							units: c.resources,
							load: (from, to) => {
								const rows = namingRowsOf(c, from, to)
								return Effect.forEach(
									namingTables,
									(t) => connection.query(`INSERT INTO ${tables[t]} ${rows[t]}`, []),
									{ discard: true }
								)
							}
						},
						state
					)
					const label = `${Formatter.format(c)}, with every table ${state}`
					yield* lawfulRuns(clone, { migrated, files, reads: namingReads(installation) }, label)
					const filled = yield* connection.queryValues(
						`SELECT pg_catalog.count(*) FROM ${printObjectName(named.table)}`,
						[]
					)
					assert.equal(
						Number(defined(filled[0]?.[0], "the fill's count")),
						c.packages * namers,
						`${label}: Named's fill holds each record that names a document`
					)
					k.note("a record that names its document")
					if (namers < c.resources) {
						k.note("a record that names none")
					}
					k.note(`every table ${state}`)
				})
			)
		}
	})
