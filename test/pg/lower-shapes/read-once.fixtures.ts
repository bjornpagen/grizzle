/** What read-once.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Struct } from "effect"
import { type PlanNode, rowsRead } from "#bench/harness/explain.ts"
import { bool, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import {
	fullWorldRole,
	type PgClassState,
	pgClassStates,
	servedRead,
	servedRun,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"

/**
 * A package's XML, every element of every document one row of one table, as pantry stores QTI content: the package,
 * the document's path (0 its manifest), the element's place and its parent's, its kind, and the value it holds. The
 * manifest's LOM elements are a few of a package's rows, each picked by its kind and its path among the many of its
 * documents' bodies, so PostgreSQL estimates a scan for one kind in the manifests at one row, whatever it reads.
 */
const Node = relation(
	"Node",
	{
		pkg: int4,
		path: int4,
		at: int4,
		parent: int4,
		kind: int4,
		value: int4
	},
	["pkg", "path", "at"]
)

/** A stored package, by its name. */
const Pkg = relation("Pkg", { pkg: int4 }, ["pkg"])

/** A document of a package, by its path, and whether it is an item. */
const Doc = relation("Doc", { pkg: int4, path: int4, item: bool }, ["pkg", "path"])

/** An item document's identifier. */
const Item = relation("Item", { pkg: int4, path: int4, name: int4 }, ["pkg", "path"])

/** The kinds of the manifest's elements, and of a document body's. */
const kind = {
	manifest: 1,
	relation: 2,
	isVersionOf: 3,
	status: 4,
	statusValue: 5,
	classification: 6,
	purpose: 7,
	purposeValue: 8,
	taxonPath: 9,
	source: 10,
	sourceString: 11,
	taxon: 12,
	id: 13,
	resource: 99,
	body: 200
} as const

/** A status value: a package taken away by a deletion version has `gone`. */
const status = { final: 1, gone: 2 } as const

const Stored = schema("ReadOnce", [Pkg, Node, Doc, Item], [])

/**
 * The typed LOM views over the manifests, as pantry's: each package's head (one no other package names as an earlier
 * version), its lifecycle status, and its classification terms (purpose, taxon path source, taxon id), each a join of
 * eight elements of the manifest.
 */
/** The packages a stored manifest names as an earlier version of its own: an `isVersionOf` under a `relation`. */
const supersedes = query(Stored).rule((r) => {
	const { pkg, at } = v(Node, "relation")
	const { at: named, value: earlier } = v(Node, "named")
	return r
		.match(Node, { pkg, path: 0, at, kind: kind.relation })
		.match(Node, { pkg, path: 0, at: named, parent: at, kind: kind.isVersionOf, value: earlier })
		.find({ earlier })
})

const Head = derived(
	"Head",
	query(Stored).rule((r) => {
		const { pkg } = v(Pkg, "pkg")
		const { at } = v(Node, "manifest")
		return r
			.match(Pkg, { pkg })
			.match(Node, { pkg, path: 0, at, kind: kind.manifest })
			.where(r.not(supersedes, { earlier: pkg }))
			.find({ pkg })
	})
)

const Status = derived(
	"Status",
	query(Stored).rule((r) => {
		const { pkg, at } = v(Node, "status")
		const { at: valueAt, value } = v(Node, "value")
		return r
			.match(Node, { pkg, path: 0, at, kind: kind.status })
			.match(Node, { pkg, path: 0, at: valueAt, parent: at, kind: kind.statusValue, value })
			.find({ pkg, status: value })
	})
)

const Classification = derived(
	"Classification",
	query(Stored).rule((r) => {
		const c = v(Node, "classification")
		const p = v(Node, "purpose")
		const pv = v(Node, "purposeValue")
		const tp = v(Node, "taxonPath")
		const s = v(Node, "source")
		const ss = v(Node, "sourceString")
		const t = v(Node, "taxon")
		const i = v(Node, "id")
		const pkg = c.pkg
		return r
			.match(Node, { pkg, path: 0, at: c.at, kind: kind.classification })
			.match(Node, { pkg, path: 0, at: p.at, parent: c.at, kind: kind.purpose })
			.match(Node, {
				pkg,
				path: 0,
				at: pv.at,
				parent: p.at,
				kind: kind.purposeValue,
				value: pv.value
			})
			.match(Node, { pkg, path: 0, at: tp.at, parent: c.at, kind: kind.taxonPath })
			.match(Node, { pkg, path: 0, at: s.at, parent: tp.at, kind: kind.source })
			.match(Node, {
				pkg,
				path: 0,
				at: ss.at,
				parent: s.at,
				kind: kind.sourceString,
				value: ss.value
			})
			.match(Node, { pkg, path: 0, at: t.at, parent: tp.at, kind: kind.taxon })
			.match(Node, { pkg, path: 0, at: i.at, parent: t.at, kind: kind.id, value: i.value })
			.find({ pkg, purpose: pv.value, source: ss.value, id: i.value })
	})
)

const Typed = schema.extend([Stored], "ReadOnce_1", [Head, Status, Classification], [])

/** Each head no deletion version took away, as the ledger's Current. */
const Current = derived(
	"Current",
	query(Typed).rule((r) => {
		const { pkg } = v(Head, "head")
		return r
			.match(Head, { pkg })
			.where(r.not(Status, { pkg, status: status.gone }))
			.find({ pkg })
	})
)

/** Each item of a current package under each term its package states, as the ledger's ItemSet. */
const ItemSet = derived(
	"ItemSet",
	query(Typed).rule((r) => {
		const { pkg } = v(Head, "head")
		const { purpose, source, id } = v(Classification, "term")
		const { path } = v(Doc, "document")
		const { name } = v(Item, "item")
		return r
			.match(Head, { pkg })
			.where(r.not(Status, { pkg, status: status.gone }))
			.match(Classification, { pkg, purpose, source, id })
			.match(Doc, { pkg, path, item: true })
			.match(Item, { pkg, path, name })
			.find({ purpose, source, id, pkg, item: name })
	})
)

const Ledger = schema.extend([Typed], "ReadOnce_2", [Current, ItemSet], [])

/** Each term a current package states, with the package: Current ⋈ Classification. */
const stated = query(Ledger).rule((r) => {
	const { pkg } = v(Current, "current")
	const { purpose, source, id } = v(Classification, "term")
	return r
		.match(Current, { pkg })
		.match(Classification, { pkg, purpose, source, id })
		.find({ purpose, source, id, pkg })
})

/**
 * edullm's `sets`: every term a current package states, how many current packages state it, and how many items its
 * item set holds (an attachment that folds ItemSet by the term).
 */
const sets = query(Ledger)
	.rule((r) => {
		const { purpose, source, id, pkg } = v(stated, "stated")
		return r
			.match(stated, { purpose, source, id, pkg })
			.find({ purpose, source, id, packages: r.count() })
	})
	.attach(
		"items",
		(term) =>
			query(Ledger).rule((r) => {
				const { pkg, item } = v(ItemSet, "member")
				return r
					.match(ItemSet, { purpose: term.purpose, source: term.source, id: term.id, pkg, item })
					.find({ items: r.count() })
			}),
		"array"
	)

/**
 * edullm's `versions`, as its classifications read: every current package with each term it states, an attachment by
 * the package, whose child, eight elements of the manifest joined, one stored relation's range binds by it.
 */
const versions = query(Ledger)
	.rule((r) => {
		const { pkg } = v(Current, "current")
		return r.match(Current, { pkg }).find({ pkg })
	})
	.attach(
		"classifications",
		(head) =>
			query(Ledger).rule((r) => {
				const { purpose, source, id } = v(Classification, "term")
				return r
					.match(Classification, { pkg: head.pkg, purpose, source, id })
					.find({ pkg: head.pkg, purpose, source, id })
			}),
		"array"
	)

/** The ledger installed through its first migration, with a reader login whose workload's indexes `sets` earns. */
export const readOnceTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "read once",
	fixture: Ledger,
	programs: { sets, versions },
	contexts: [],
	label: "read_once",
	ambient: ordinarySession
})

/**
 * A case: how many packages are stored, then how many more, each with its items, every item's body elements and the
 * manifest's resources beside its LOM, how many packages share each idea term (the ideas are as many as the packages
 * over that, so the terms grow with the packages, as a course's topics do with its lessons), every how many-th
 * package a deletion version took away (none at 0), and the pg_class state each load stands the tables in
 * (test/support/advice.ts PgClassState).
 */
export interface ReadOnce {
	readonly packages: number
	readonly more: number
	readonly items: number
	readonly body: number
	readonly resources: number
	readonly share: number
	readonly gone: number
	readonly stats: PgClassState
}

export const readOnceGen: Gen<ReadOnce> = (s) => ({
	packages: s.draw(int(150, 250)),
	more: s.draw(int(300, 500)),
	items: s.draw(int(6, 12)),
	body: s.draw(int(4, 8)),
	resources: s.draw(int(10, 30)),
	share: s.draw(int(3, 6)),
	gone: s.draw(boolean) ? 0 : s.draw(element([3, 5, 7] as const)),
	stats: s.draw(element(pgClassStates))
})

export type ReadOnceFeature =
	| "a package taken away"
	| "every package current"
	| `every table ${PgClassState}`

/** The term every package states first, its last, and its idea: (purpose, source, id). */
const termsOf = (c: ReadOnce, p: number): ReadonlyArray<readonly [number, number, number]> => [
	[0, 100, 1],
	[2, 102, 3],
	[1, 101, 10 + Math.floor(p / c.share)]
]

const isGone = (c: ReadOnce, p: number): boolean => c.gone > 0 && p % c.gone === 0

/**
 * How many times the heads read reads a stored row at most: its classifications read inside each head, as the
 * attachment's child is read per key (lower/shapes/attach), read at most 1.79 times the rows the tables hold in every
 * statistics state, where joined beside the heads' keys they read 4.61 to 7.15 times them in each, and took 4.7 times as
 * long to plan (TEST_SEED=2219874524, 76 reads each, 2026-11-23).
 */
const headsReadsAStoredRow = 2

/** The ledger's stored tables. */
const tablesOf = (installed: Installed): Arr.NonEmptyReadonlyArray<string> => {
	const names = namesOf(installed)
	return [names.table(Pkg), names.table(Node), names.table(Doc), names.table(Item)]
}

/** The statements loading packages `from` to `to`, ordinary writes, as a publish writes them whole. */
const loaded = (
	installed: Installed,
	c: ReadOnce,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const node = names.table(Node)
	const series = `generate_series(${from}, ${to}) AS g(p)`
	const lom = Arr.flatMap([0, 1, 2], (b) => {
		const at = 10 + 10 * b
		const [purpose, source] = [
			[0, 100],
			[2, 102],
			[1, 101]
		][b] ?? [0, 0]
		const id = b === 2 ? `10 + p / ${c.share}` : b === 0 ? "1" : "3"
		return [
			`(p, 0, ${at}, 1, ${kind.classification}, 0)`,
			`(p, 0, ${at + 1}, ${at}, ${kind.purpose}, 0)`,
			`(p, 0, ${at + 2}, ${at + 1}, ${kind.purposeValue}, ${purpose})`,
			`(p, 0, ${at + 3}, ${at}, ${kind.taxonPath}, 0)`,
			`(p, 0, ${at + 4}, ${at + 3}, ${kind.source}, 0)`,
			`(p, 0, ${at + 5}, ${at + 4}, ${kind.sourceString}, ${source})`,
			`(p, 0, ${at + 6}, ${at + 3}, ${kind.taxon}, 0)`,
			`(p, 0, ${at + 7}, ${at + 6}, ${kind.id}, ${id})`
		]
	})
	const statusValue =
		c.gone > 0
			? `CASE WHEN p % ${c.gone} = 0 THEN ${status.gone} ELSE ${status.final} END`
			: `${status.final}`
	return [
		`INSERT INTO ${names.table(Pkg)} SELECT p FROM ${series}`,
		`INSERT INTO ${node} SELECT v.* FROM ${series}, LATERAL (VALUES (p, 0, 1, 0, ${kind.manifest}, 0), (p, 0, 2, 1, ${kind.status}, 0), (p, 0, 3, 2, ${kind.statusValue}, ${statusValue}), ${Arr.join(lom, ", ")}) AS v`,
		`INSERT INTO ${node} SELECT p, 0, 100 + r, 1, ${kind.resource}, r FROM ${series}, generate_series(1, ${c.resources}) AS h(r)`,
		`INSERT INTO ${node} SELECT p, i, b, 0, ${kind.body}, b FROM ${series}, generate_series(1, ${c.items}) AS h(i), generate_series(1, ${c.body}) AS k(b)`,
		`INSERT INTO ${names.table(Doc)} SELECT p, i, true FROM ${series}, generate_series(1, ${c.items}) AS h(i)`,
		`INSERT INTO ${names.table(Doc)} SELECT p, 1000, false FROM ${series}`,
		`INSERT INTO ${names.table(Item)} SELECT p, i, i FROM ${series}, generate_series(1, ${c.items}) AS h(i)`
	]
}

/** The read's answer on the host: each term with its current packages and their items, `[id, purpose, source, packages, items]`. */
const expected = (c: ReadOnce, packages: number): ReadonlyArray<string> => {
	const counts = new Map<string, { packages: number; items: number }>()
	for (const p of Array.from({ length: packages }, (_, i) => 10 + i)) {
		if (isGone(c, p)) {
			continue
		}
		for (const [purpose, source, id] of termsOf(c, p)) {
			const key = `${id} ${purpose} ${source}`
			const was = counts.get(key) ?? { packages: 0, items: 0 }
			counts.set(key, { packages: was.packages + 1, items: was.items + c.items })
		}
	}
	return Arr.sort(
		Arr.map([...counts], ([key, n]) => `${key} ${n.packages} ${n.items}`),
		Order.String
	)
}

/**
 * A plan node that reads rows: a stored relation's scan, as rowsRead counts one (no Bitmap Index Scan), or a scan of a
 * CTE the statement derived once, which rereads every row it holds on each run.
 */
const rowScan = (n: PlanNode): boolean =>
	(Option.isSome(n.relation) && Option.isNone(n.operation) && n.nodeType !== "Bitmap Index Scan") ||
	n.nodeType === "CTE Scan"

/** A plan node where it stands: its parent, and the Gather or Gather Merge above it, if any. */
interface Placed {
	readonly node: PlanNode
	readonly parent: Option.Option<PlanNode>
	readonly gather: Option.Option<PlanNode>
}

/** Every node of `plan` where it stands (Placed), each before its children. */
const placed = (plan: PlanNode): ReadonlyArray<Placed> => {
	const out: Array<Placed> = []
	const visit = (
		node: PlanNode,
		parent: Option.Option<PlanNode>,
		gather: Option.Option<PlanNode>
	): void => {
		out.push({ node, parent, gather })
		const below =
			node.nodeType === "Gather" || node.nodeType === "Gather Merge" ? Option.some(node) : gather
		for (const child of node.children) {
			visit(child, Option.some(node), below)
		}
	}
	visit(plan, Option.none(), Option.none())
	return out
}

/**
 * How many times a scan ran. Under a Gather, each run of the Gather runs the scan once in each of its processes, the
 * leader's and each worker's: a parallel-aware scan the processes share, any other each process's own, as the build of
 * a hash each process makes for itself: its loops over the processes, times the Gather's runs, are its runs, so a scan
 * each process ran once ran as often as the Gather did, and one each process ran for each of its rows ran that often
 * more. Elsewhere a node's loops are its runs.
 */
const runsOf = (p: Placed): number =>
	Option.match(p.gather, {
		onNone: () => p.node.actualLoops,
		onSome: (g) =>
			(p.node.actualLoops * g.actualLoops) /
			(Option.getOrElse(g.workersLaunched, () => 0) + g.actualLoops)
	})

/**
 * A scan that runs more than once, with the rows it handles a run, its output and what its filters removed (each a
 * loop's mean, as EXPLAIN reports it) over every loop of the run, and where it stands.
 */
interface Rerun {
	readonly runs: number
	readonly rows: number
	readonly at: Placed
}

/** Each scan of `plan` that runs more than once (`Rerun`), heaviest first. */
const reruns = (plan: PlanNode): ReadonlyArray<Rerun> =>
	Arr.sort(
		Arr.flatMap(placed(plan), (p): ReadonlyArray<Rerun> => {
			const n = p.node
			const runs = runsOf(p)
			const handled = n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByJoinFilter
			return rowScan(n) && runs > 1 ? [{ runs, rows: (handled * n.actualLoops) / runs, at: p }] : []
		}),
		Order.flip(Order.mapInput(Order.Number, (r: Rerun) => r.rows))
	)

/**
 * A rerun as a report prints it: its runs and rows a run, its node whole but for its children, the runs and workers of
 * the Gather above it, and its parent's join.
 */
const reported = (r: Rerun) => ({
	runs: r.runs,
	rowsARun: r.rows,
	node: Struct.omit(r.at.node, ["children"]),
	gather: Option.map(r.at.gather, (g) => ({
		runs: g.actualLoops,
		workersLaunched: g.workersLaunched
	})),
	parent: Option.map(r.at.parent, (q) => ({
		nodeType: q.nodeType,
		joinType: q.joinType,
		joinFilter: q.joinFilter,
		loops: q.actualLoops
	}))
})

/**
 * The read's one statement run under its carried advice once the plan laws hold over it (test/support/advice.ts
 * servedRun), and its answer: each part's rows as the delivery sends them, the
 * statement's terms with their counts read back by their place.
 */
const measured = (
	installed: Installed,
	connection: PgConnection,
	program: typeof sets | typeof versions
) =>
	Effect.gen(function* () {
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Ledger, []),
			program,
			program === sets ? "the read of the terms" : "the read of the versions"
		)
		const plan = yield* servedRun({ values: connection.queryValues }, read, {})
		const rows = yield* connection.queryValues(read.statement.sql, read.params({}))
		return { plan, rows }
	})

/**
 * The terms of the read's rows, `[id, purpose, source, packages, items]`, from its parts as the delivery lays them out
 * (lower/shapes/index.ts): the part's ordinal, then the term's fields in heading order, and its count of packages in
 * the rows' part; the parent key's fields, then the child's, its count of items last, in the items attachment's.
 */
const answerOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> => {
	const text = (x: unknown): string => (typeof x === "string" ? x : String(x))
	const part = (n: string) => Arr.filter(rows, (r) => text(r[0]) === n)
	const items = new Map<string, string>(
		Arr.map(
			part("1"),
			(r) => [`${text(r[1])} ${text(r[2])} ${text(r[3])}`, text(r[r.length - 1])] as const
		)
	)
	return Arr.sort(
		Arr.map(part("0"), (r) => {
			const key = `${text(r[1])} ${text(r[2])} ${text(r[3])}`
			return `${key} ${text(r[4])} ${items.get(key) ?? "0"}`
		}),
		Order.String
	)
}

/**
 * One case in its one transaction, which the case's end rolls back: `packages` packages loaded by ordinary writes, the
 * tables stood in the case's pg_class state (test/support/advice.ts standIn, a package its unit), the read explained and
 * run; then `more` packages loaded, the tables stood in it again, and the read again. Each time it answers the host's
 * count of every term's current packages and their items, and every scan its plan runs more than once, of a stored
 * relation or of a CTE it derived once, handles fewer rows a run than there are packages: a scan per term, per package
 * or per item reads that one's rows, a few of each table, and a CTE rescanned per term holds the terms. One that reads
 * every package's rows on each run, a derivation run again for each row of another or a derived set scanned whole for
 * each, makes the read's work grow with the square of what it reads. A parallel scan's processes are one run of it
 * (runsOf).
 */
export const runReadOnce = (
	installed: Installed,
	connection: PgConnection,
	c: ReadOnce,
	k: Case<ReadOnceFeature>
) =>
	Effect.gen(function* () {
		const run = (statements: ReadonlyArray<string>) =>
			Effect.forEach(statements, (sql) => connection.query(sql, []), { discard: true })
		const rounds = [
			[10, 9 + c.packages],
			[10 + c.packages, 9 + c.packages + c.more]
		] as const
		const session = { values: connection.queryValues }
		for (const [from, to] of rounds) {
			yield* standIn(
				session,
				{
					tables: tablesOf(installed),
					units: to - from + 1,
					load: (first, last) => run(loaded(installed, c, from + first - 1, from + last - 1))
				},
				c.stats
			)
			const stored = to - 9
			const bounded = (read: string, plan: PlanNode) => {
				const heaviest = reruns(plan)
				assert.ok(
					Arr.every(heaviest, (r) => r.rows < stored),
					`${Formatter.format(c)}: every scan ${read} runs more than once reads fewer rows a run than the ${stored} packages stored, ${Formatter.format(Arr.map(Arr.take(heaviest, 3), reported))}, ${rowsRead(plan)} rows read of stored relations`
				)
			}
			const terms = yield* measured(installed, connection, sets)
			assert.deepEqual(
				answerOf(terms.rows),
				expected(c, stored),
				`${Formatter.format(c)}: the terms read's terms at ${stored} packages`
			)
			bounded("the terms read", terms.plan)
			const heads = yield* measured(installed, connection, versions)
			const current = Arr.filter(
				Array.from({ length: stored }, (_, i) => 10 + i),
				(p) => !isGone(c, p)
			)
			assert.deepEqual(
				[
					Arr.filter(heads.rows, (r) => r[0] === "0").length,
					Arr.filter(heads.rows, (r) => r[0] === "1").length
				],
				[current.length, 3 * current.length],
				`${Formatter.format(c)}: the heads read's current packages and their three terms each at ${stored} packages`
			)
			bounded("the heads read", heads.plan)
			const [held] = yield* connection.queryValues(
				`SELECT (${Arr.join(
					Arr.map(tablesOf(installed), (t) => `(SELECT pg_catalog.count(*) FROM ${t})`),
					" + "
				)})::text`,
				[]
			)
			const storedRows = Number(held?.[0])
			assert.ok(
				rowsRead(heads.plan) <= headsReadsAStoredRow * storedRows,
				`${Formatter.format(c)}: the heads read reads ${rowsRead(heads.plan)} stored rows, at most ${headsReadsAStoredRow} times the ${storedRows} the tables hold`
			)
		}
		k.note(c.gone > 0 ? "a package taken away" : "every package current")
		k.note(`every table ${c.stats}`)
	})
