/** What streamed.test.ts reads: its schema, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { installWrites, openFull } from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	check,
	contained,
	counted,
	fin,
	fold,
	key,
	Monoid,
	on,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { pgCluster } from "#test/support/env.ts"
import { member } from "#test/support/served-db.ts"
import { openSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Text = str.bytes(512, str.regex("^.*$", "su"))

/** Nodes of documents, wide, keyed (doc, path, at) and by seq, as edullm's qti.node and learning-commons' standards. */
const Wide = relation(
	"Wide",
	{ doc: pg.bigint, path: Text, at: pg.bigint, seq: pg.bigint, body: Text },
	["doc", "path", "at"]
)

/** An area and its counted members, members facts of their own, as learning-commons' GuidanceArea and Guideline. */
const Area = relation("Area", { area: pg.bigint, members: drawn(natural) }, ["area"])

const Member = relation("Member", { member: pg.bigint, area: pg.bigint }, ["member"])

/**
 * qti-pie's Node and Attribute, cut down: a tree per document, each node with what it needs, `need`, as a node's governor
 * requires its slots, and a counted family of Marks, facts of their own naming their node by its document and its
 * `start`, which the walk draws, whose values fold into the node's `weight`, as Attribute's slots into Node.attrs (AL2);
 * `Enough` holds every node to its need, as AL3 holds a node's attrs to its required slots. A package's every node
 * that needs a mark holds one, so the call is accepted; one whose marks fall short is refused by Enough, which
 * PostgreSQL checks itself, and the refusal's witness is that node's key, which the host finds among its share's rows.
 */
const Node = relation(
	"Node",
	{
		doc: pg.bigint,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		need: pg.bigint,
		marks: drawn(natural),
		weight: accumulated(pg.bigint, 0n)
	},
	["doc", "start"]
)

const Mark = relation("Mark", { doc: pg.bigint, start: natural, name: pg.bigint, v: pg.bigint }, [
	"doc",
	"start",
	"name"
])

const nodeMarks = counted(on(Mark, "doc", "start"), fin(Node, "marks"))

/** A relation every call of the case's insertAll names with no facts, as learning-commons' parts name every other. */
const Note = relation("Note", { id: pg.bigint }, ["id"])

/**
 * A document every wide node lies in, contained by its doc (`contained`), and whose root, its own `path` and `at`, is a
 * wide node of it: the two containments close a cycle of foreign keys, so both are deferred (laws/model/model.ts
 * Deferral, a key on a cycle), and a node of a document the call states none of is refused at COMMIT, its witness the
 * node its diagnosis finds unmatched.
 */
const Doc = relation("Doc", { doc: pg.bigint, title: Text, path: Text, at: pg.bigint }, ["doc"])

const build = (name: string) =>
	schema(
		name,
		[Wide, Area, Member, Note, Doc, Node, Mark],
		[
			key(on(Wide, "seq")),
			counted(on(Member, "area"), fin(Area, "members")),
			tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] }),
			nodeMarks,
			fold(
				nodeMarks,
				Monoid.sum,
				on(Mark, "doc", "start", "v"),
				on(Node, "doc", "start", "weight")
			),
			check("Enough", Node, (n) => n.ge(n.weight, n.need)),
			contained(on(Wide, "doc"), on(Doc, "doc")),
			contained(on(Doc, "doc", "path", "at"), on(Wide, "doc", "path", "at"))
		]
	)

/**
 * A case: how many wide facts one call inserts and how wide each body is, how many areas and members each, and what the
 * call states besides: every fact once, its first fact again as its last (a repeat across shares), its first fact
 * stored before the call and stated again as its last (a stored fact repeated across shares), its last fact at its
 * first's seq with its own key (a pair across shares, refused on the seq key), or two last facts of one key and two
 * bodies, which the host's key law refuses as it binds the last share that holds them, after every share before it
 * was sent (a share the host refuses): the call's one read of its facts judges each fact alone, and a share's bind its
 * facts' keys; or a wide node of a document the call states no Doc of, which the containment of nodes in their
 * documents, deferred on its cycle with the documents' roots, refuses at COMMIT (a COMMIT the deferred containment
 * refuses); or a tree's node whose marks fall short of its need, which Enough refuses as AL3 refused qti-pie's
 * import, its witness the node (a node its marks fall short of). Every case writes each document's tree, of `nodes`
 * nodes, every node marked as it needs.
 */
export interface Streamed {
	readonly facts: number
	readonly body: number
	readonly areas: number
	readonly members: number
	readonly nodes: number
	readonly shape:
		| "distinct"
		| "repeated"
		| "stored"
		| "paired"
		| "hostRefused"
		| "unmatched"
		| "short"
}

export const streamedGen: Gen<Streamed> = (s) => ({
	facts: s.draw(int(6000, 10000)),
	body: s.draw(int(200, 400)),
	areas: s.draw(int(20, 60)),
	members: s.draw(int(1, 40)),
	nodes: s.draw(int(1, 12)),
	shape: s.draw(
		element([
			"distinct",
			"repeated",
			"stored",
			"paired",
			"hostRefused",
			"unmatched",
			"short"
		] as const)
	)
})

export type StreamedFeature =
	| "every fact once"
	| "a fact repeated across shares"
	| "a stored fact repeated across shares"
	| "a pair refused across shares"
	| "a later share the host refuses"
	| "a COMMIT the deferred containment refuses"
	| "a node its marks fall short of"

/**
 * The settings that turn pg_stat_statements on in the case's database alone, every statement a backend that connects
 * after them runs (warm-pool.fixtures.ts `tracked`), so a case counts the Db transactions a call begins.
 */
const tracked = ["compute_query_id = 'on'", "pg_stat_statements.track = 'all'"] as const

/** Wide fact `i`: document i mod 7, a long path, at i, seq i. */
const wideOf = (c: Streamed, i: number) => ({
	doc: BigInt(i % 7),
	path: `document/${Str.padStart(6, "0")(String(i % 997))}/${Str.repeat(120)("p")}`,
	at: BigInt(i),
	seq: BigInt(i),
	body: `${Str.repeat(c.body)("b")}${String(i)}`
})

/**
 * Document `doc`'s tree as an insert nests it: a root and `nodes - 1` children under it, so its starts run 0 to
 * nodes - 1 in pre-order, each node needing its own start, which its marks meet (`marksOf`).
 */
const treeOf = (c: Streamed, doc: number) => ({
	doc: BigInt(doc),
	need: 0n,
	children: Arr.map(
		Array.from({ length: c.nodes - 1 }, (_, i) => i + 1),
		(start) => ({ need: BigInt(start), children: [] })
	)
})

/**
 * Document `doc`'s marks, facts of their own as an import states a document's attributes: each node of its tree marked
 * once at its start, the mark's value its need; in a short case, the last document's last node's value one below it.
 */
const marksOf = (c: Streamed, doc: number, last: boolean) =>
	Arr.map(
		Array.from({ length: c.nodes }, (_, start) => start),
		(start) => ({
			doc: BigInt(doc),
			start: BigInt(start),
			name: 0n,
			v: BigInt(c.shape === "short" && last && start === c.nodes - 1 ? start - 1 : start)
		})
	)

/** The call's wide facts as its shape states them. */
const widesOf = (c: Streamed) => {
	const facts = Arr.map(
		Array.from({ length: c.facts }, (_, i) => i),
		(i) => wideOf(c, i)
	)
	switch (c.shape) {
		case "distinct":
		case "unmatched":
		case "short":
			return facts
		case "repeated":
		case "stored":
			return [...facts, wideOf(c, 0)]
		case "paired":
			return [...facts, { ...wideOf(c, c.facts), seq: 0n }]
		case "hostRefused":
			return [
				...facts,
				{ ...wideOf(c, c.facts), body: "first" },
				{ ...wideOf(c, c.facts), body: "second" }
			]
	}
}

/**
 * One case on a fresh installation: the call's facts inserted through the Db's served change member (adapter/db/
 * handles.ts applyChange), which draws them in shares of whole groups and sends each as a flight of the call's one
 * transaction (adapter/apply/run.ts runWriteShares). It answers what one execution of every fact answers: accepted with
 * every distinct fact added once, each area its members counted, a repeat added once; or, for a pair across shares,
 * refused, storing nothing.
 */
export const runStreamed = (c: Streamed, k: Case<StreamedFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			for (const setting of tracked) {
				yield* substrate.admin.query(
					`ALTER DATABASE ${quoteIdent(substrate.database)} SET ${setting}`,
					[]
				)
			}
			/**
			 * How many Db transactions the case's database began so far: its prologue's calls, each the guard's, read on the
			 * owner database, which holds pg_stat_statements' view, as every role's statements' reader.
			 */
			const statistics = yield* openSession(substrate.cluster, {
				database: pgCluster.owner,
				credentials: substrate.owner,
				label: "streamed statistics"
			})
			yield* statistics.values(
				"SELECT pg_catalog.set_config('role', 'pg_read_all_stats', false)",
				[]
			)
			const transactions = Effect.map(
				statistics.values(
					"SELECT coalesce(sum(s.calls), 0)::int8::text FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text AND s.toplevel AND s.query LIKE '%__snapshot_guard%'",
					[substrate.database]
				),
				(rows) => Number(rows[0]?.[0] ?? 0)
			)
			const fx = yield* installWrites(build("Streamed"), "streamed", {
				programs: {},
				logins: () => []
			})
			const S = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const served = yield* db.serve({
				load: ChangeSet.empty(S).insertAll({
					Wide: [],
					Area: [],
					Member: [],
					Note: [],
					Doc: [],
					Node: [],
					Mark: []
				})
			})
			const wides = widesOf(c)
			const areas = Arr.map(
				Array.from({ length: c.areas }, (_, i) => i + 1),
				(area) => ({ area: BigInt(area) })
			)
			const members = Arr.flatMap(
				Array.from({ length: c.areas }, (_, i) => i + 1),
				(area) =>
					Arr.map(
						Array.from({ length: ((area * 7) % c.members) + 1 }, (_, i) => i + 1),
						(i) => ({
							member: BigInt(area * 1000 + i),
							area: BigInt(area)
						})
					)
			)
			const call = member(served, "load")
			if (call.shape !== "write") {
				return assert.fail("the load member writes")
			}
			const load = (facts: {
				readonly Wide: ReadonlyArray<unknown>
				readonly Area: ReadonlyArray<unknown>
				readonly Member: ReadonlyArray<unknown>
				readonly Doc: ReadonlyArray<unknown>
				readonly Node: ReadonlyArray<unknown>
				readonly Mark: ReadonlyArray<unknown>
			}) => writeAnswerOf(call.once({ params: {}, facts: { insert: { ...facts, Note: [] } } }))
			/** Every document a wide fact lies in, 0 to 6, each rooted at wide fact `d`, a node of document `d`. */
			const docs = Arr.map(
				Array.from({ length: 7 }, (_, d) => d),
				(d) => ({
					doc: BigInt(d),
					title: `document ${String(d)}`,
					path: wideOf(c, d).path,
					at: BigInt(d)
				})
			)
			/** Every document's tree and its marks, as a package's import states them. */
			const trees = Arr.map(docs, (_, d) => treeOf(c, d))
			const marks = Arr.flatMap(docs, (_, d) => marksOf(c, d, d === docs.length - 1))
			const none = yield* load({ Wide: [], Area: [], Member: [], Doc: [], Node: [], Mark: [] })
			assert.ok(
				"kind" in none && none.kind === "unchanged",
				`${Formatter.format({ ...c })}: a call of no facts changes nothing, ${Formatter.format(none)}`
			)
			if (c.shape === "stored") {
				const first = yield* load({
					Wide: [wideOf(c, 0)],
					Area: [],
					Member: [],
					Doc: Arr.take(docs, 1),
					Node: [],
					Mark: []
				})
				assert.ok("kind" in first && first.kind === "accepted", "the stored fact is stored first")
			}
			/** An unmatched case's wide node of a document the call states no Doc of, which the deferred containment refuses
			 * at COMMIT. */
			const stray = c.shape === "unmatched" ? [{ ...wideOf(c, c.facts), doc: 7n }] : []
			const before = yield* transactions
			const outcome = yield* load({
				Wide: [...wides, ...stray],
				Area: areas,
				Member: members,
				Doc: docs,
				Node: trees,
				Mark: marks
			})
			const sent = (yield* transactions) - before
			const stored = yield* substrate.admin.queryValues(
				`SELECT (SELECT count(*) FROM ${fx.table("Wide")})::text, (SELECT count(*) FROM ${fx.table("Member")})::text, (SELECT coalesce(sum(members), 0) FROM ${fx.table("Area")})::text, (SELECT count(*) FROM ${fx.table("Area")} a WHERE a.members <> (SELECT count(*) FROM ${fx.table("Member")} m WHERE m.area = a.area))::text`,
				[]
			)
			if (
				c.shape === "paired" ||
				c.shape === "hostRefused" ||
				c.shape === "unmatched" ||
				c.shape === "short"
			) {
				assert.ok(
					"kind" in outcome && outcome.kind !== "accepted" && outcome.kind !== "unchanged",
					`${Formatter.format({ ...c })}: the call is refused, ${Formatter.format(outcome)}`
				)
				assert.deepEqual(
					stored,
					[["0", "0", "0", "0"]],
					`${Formatter.format({ ...c })}: the refused call stores nothing, none of the shares sent before its refusal`
				)
				if (c.shape === "unmatched") {
					assert.ok(
						"witness" in outcome && outcome.witness.kind !== "unreproduced",
						`${Formatter.format({ ...c })}: the COMMIT refusal names the node its diagnosis found unmatched, ${Formatter.format(outcome)}`
					)
				}
				if (c.shape === "short") {
					assert.deepEqual(
						"witness" in outcome ? outcome.witness : undefined,
						{
							kind: "key",
							relation: "Node",
							values: { doc: BigInt(docs.length - 1), start: BigInt(c.nodes - 1) }
						},
						`${Formatter.format({ ...c })}: Enough's refusal names the node its marks fall short of, its share's row, ${Formatter.format(outcome)}`
					)
				}
				assert.equal(
					sent,
					c.shape === "unmatched" ? 2 : 1,
					`${Formatter.format({ ...c })}: the refused call is its one transaction, its refusal its answer, never sent again, and at COMMIT one rolled-back draw of its shares for the witness`
				)
				k.note(
					c.shape === "paired"
						? "a pair refused across shares"
						: c.shape === "hostRefused"
							? "a later share the host refuses"
							: c.shape === "unmatched"
								? "a COMMIT the deferred containment refuses"
								: "a node its marks fall short of"
				)
				return
			}
			const counts = "counts" in outcome ? outcome.counts : []
			const addedOf = (relation: string) =>
				Option.getOrUndefined(Arr.findFirst(counts, (n) => n.relation === relation))?.added
			assert.ok(
				"kind" in outcome && outcome.kind === "accepted",
				`${Formatter.format({ ...c })}: the call is accepted, ${Formatter.format(outcome)}`
			)
			assert.deepEqual(
				[addedOf("Wide"), addedOf("Area"), addedOf("Member")],
				[
					BigInt(c.shape === "stored" ? c.facts - 1 : c.facts),
					BigInt(c.areas),
					BigInt(members.length)
				],
				`${Formatter.format({ ...c })}: every distinct fact is added once, ${Formatter.format(counts)}`
			)
			assert.deepEqual(
				stored,
				[[String(c.facts), String(members.length), String(members.length), "0"]],
				`${Formatter.format({ ...c })}: the tables hold every fact once, each area its members counted`
			)
			k.note(
				c.shape === "repeated"
					? "a fact repeated across shares"
					: c.shape === "stored"
						? "a stored fact repeated across shares"
						: "every fact once"
			)
		})
	)
