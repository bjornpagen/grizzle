/**
 * The reads of families and trees through grizzle's installed indexes, on PostgreSQL 19 (fin.md §11, "Plan audits",
 * trees.md §3, §5): the export, every subtree's descendants and every family's members are an index or range scan of
 * the index grizzle installs for them, with no sort, no sequential scan and no recursion, and return exactly the rows
 * the parent links say they should.
 *
 * The reads, each over a planted, vacuumed load and each planned custom or generic as the search draws (R04), of a row
 * drawn at every depth below the root alike and of an owner drawn among them all. A row's ancestors are no such read:
 * `start <= n.start AND end > n.start` reads every row before it in pre-order, so for a row late in it the planner
 * rightly scans the table, and no index grizzle installs serves it.
 *
 * Both plans are a served read's: every statement of a served workload is a named prepared statement
 * (core/prepared.ts), which PostgreSQL plans custom for its first five executions on a session and may plan generic
 * from its sixth (PostgreSQL 19 plancache.c choose_custom_plan), so an application's read of a tree or a family runs on
 * either.
 *
 * - **the export**, `WHERE doc = $1 ORDER BY start`: one scan of an index led by (r, start), the tree's primary key
 *   (T1) or the owner axis's target superkey (r, start, children), reading each row once; the primary key itself is
 *   (r, start), the identity and the document order at once (T1), as the installed catalog shows;
 * - **descendants** of a row, `start > n.start AND start < n.end`: a range scan of such an index reading exactly them;
 * - **an ordered family's members**, `WHERE g = $1 ORDER BY at`: a scan of the family key UNIQUE (g, at), or of its
 *   successor key UNIQUE (g, ‹p›), each led by the group, reading exactly its members, whether the planner sorts them
 *   after a bitmap scan or reads them in order.
 *
 * - **Oracles:** EXPLAIN's plan shape (bench/harness/explain.ts), its index named by the installed catalog's role
 *   (installed.ts), never by an allocated name; and each read's rows against the tree's parent links
 *   (families/tree.ts descendantsOf) or the family as written, a second implementation that reads no interval.
 */
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { explain, explainServerStatement, type PlanMode } from "#bench/harness/explain.ts"
import { constraintOf as familyConstraintOf, familySeatIn } from "#test/pg/fin/family.ts"
import { type Catalogued, sameRoles, seatIn } from "#test/pg/fin/installed.ts"
import {
	byDepth,
	load,
	type PlanFeature,
	planFacts,
	planned,
	plansFamily,
	planSituations,
	plansTree,
	probes,
	rows,
	startOf,
	subjectOf
} from "#test/pg/fin/plans.fixtures.ts"
import { nativesOf, RELATIONS } from "#test/pg/fin/tree.ts"
import { descendantsOf } from "#test/support/families/tree.ts"
import { pickFrom } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Its search budget: the fewest cases a run spends at which every kill it declares is killed and every situation it
 * requires reached. A kill's trial runs the witnesses alone, its kept cases, its floor stream of ⌈runs / 4⌉ cases and its
 * steered phase while a situation is unreached, all fixed by the property's identity and its floor, so runs within one
 * floor draw the same witnesses, and a run adds `runs` rotating cases.
 *
 * @limitKind measured
 * @owner grizzle's test/pg/fin/plans.test.ts
 * @unit independent cases (runs) and steered cases
 * @scope one run of familyAndTreeReadsGoThroughGrizzlesInstalledIndexesWithNoSortSequentialScanOrRecursion
 * @evidence `~/.cache/grizzle/CULL-FIN-tools/measure.sh r<runs> <runs> 200 <files>` over test/pg/fin's counted,
 *   lemmas, fold, plans and counted-set at runs 1, 4, 8, 16 and 32, the steered cases capped at 200, each a
 *   `toolchain-test run` of the files that ran the kills of every property it passed; uncommitted logs
 *   ~/.cache/grizzle/CULL-FIN-tools/measure-r{1,4,8,16,32}.log
 * @observed 2026-11-23 03:50 to 04:26 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 200 to 520 from other lanes;
 *   PostgreSQL 19.0 (scripts/pg/pin.env) as the lane's in-memory family; Node 26.13.1; grizzle f87b2aaab with lane
 *   CULL-FIN's cull of test/pg/fin; TEST_SEED=2219874524
 * @workload the property with its kill, the owner axis's reverse index over its copy of the count (3adc7e172)
 * @result steered cases to reach every required situation: 128 at a floor of one case (runs 1, 4), 128 at two (runs 8),
 *   80 at four (runs 16), 32 at eight (runs 32); the kill killed at every budget, no failure
 * @decision a floor of eight spends the fewest, 69 cases a run and its kept case at runs 29, the fewest runs with that
 *   floor, against 130 at a floor of one (runs 1), 135 at two (runs 5) and 97 at four (runs 13); the steered cap the 32
 *   it needs. Floors of three, five, six and seven and past eight are unmeasured; it ran 72 cases at runs 32, steered 64
 * @revalidate a change of the property, its space, its situations or the code its cases run, which moves its witnesses;
 *   a red that reaches no situation (FeaturesUnreached) or a kill that survives
 */
const plansBudget = { runs: 29, steered: 32 } as const

/**
 * Read a tree in document order with no sort, each subtree's descendants by a range scan of T1's index, and a family's
 * members by its key, with no sequential scan and no recursion, each case on clones of its own of the planted tree and
 * family.

 */
export const familyAndTreeReadsGoThroughGrizzlesInstalledIndexesWithNoSortSequentialScanOrRecursion =
	property.explore(probes, {
		needs: { tree: Substrate.fresh(plansTree), family: Substrate.fresh(plansFamily) },
		situations: planSituations,
		check:
			({ tree, family: familyNeed }, cx: Case<PlanFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.gen(function* () {
						const treeSeat = yield* tree
						const familySeat = yield* familyNeed
						const trees = yield* seatIn(treeSeat, RELATIONS, "plans tree")
						const family = yield* familySeatIn("ordered", familySeat, "plans family ordered")
						const f = family.seat
						const fc = (relation: string, role: string) => f.column(relation, role)
						assert.ok(
							Arr.some(
								trees.constraints,
								(c: Catalogued) => c.kind === "primary" && deepEquals(c.columns, ["doc", "start"])
							),
							"the tree's primary key is (doc, start) in that order, its identity in document order (T1)"
						)
						/** Every index of the tree in document order: each led by its root field, then its start, the primary
						 * key (T1) among them, and the owner axis's target superkey (doc, start, children), which serves alike. */
						const inOrder = Arr.map(
							Arr.filter(
								trees.constraints,
								(c: Catalogued) =>
									nativesOf(c).includes("document order") ||
									(c.columns[0] === "doc" && c.columns[1] === "start")
							),
							(c) => c.name
						)
						const key = Option.getOrThrow(
							Arr.findFirst(f.constraints, (c: Catalogued) =>
								Option.contains(familyConstraintOf(family, c), "key")
							)
						).name
						/** The indexes a family's members are read by: its key (g, at), and its successor key (g, ‹p›),
						 * which the predecessor axis's reverse probe reads, both led by the group. */
						const byGroup = [
							key,
							...Arr.map(
								Arr.filter(
									f.constraints,
									(c: Catalogued) =>
										c.kind === "unique" &&
										c.relation === "Member" &&
										sameRoles(c.columns, ["g", "‹gen at›"])
								),
								(c) => c.name
							)
						]
						const t = (role: string) => trees.column("Node", role)
						const mode: PlanMode = sketch.generic ? "generic" : "custom"
						const read = sketch.read
						const subjectAt = (depth: number, pick: number) => {
							const row = pickFrom(defined(byDepth[depth], `the rows at depth ${depth}`), pick)
							return { row, subject: subjectOf(row, depth) }
						}
						const session = read.kind === "a family's members" ? f.session : trees.session
						const probe = (() => {
							switch (read.kind) {
								case "the export":
									return {
										name: `the export, ${mode} plan` as const,
										sql: `SELECT ${t("start")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 ORDER BY ${t("start")}`,
										params: ["0"]
									}
								case "descendants": {
									const { row, subject } = subjectAt(read.depth, read.pick)
									return {
										name: `the descendants of ${subject}, ${mode} plan` as const,
										sql: `SELECT ${t("start")} FROM ${trees.table("Node")} WHERE ${t("doc")} = $1::int4 AND ${t("start")} > $2::int8 AND ${t("start")} < $3::int8`,
										params: ["0", String(row.start), String(row.end)]
									}
								}
								case "a family's members":
									return {
										name: `a family's members, ${mode} plan` as const,
										sql: `SELECT ${fc("Member", "member")} FROM ${f.table("Member")} WHERE ${fc("Member", "g")} = $1::int4 ORDER BY ${fc("Member", "at")}`,
										params: [String(read.owner)]
									}
							}
						})()
						const name: PlanFeature = probe.name
						const e =
							mode === "custom"
								? yield* explain(session, probe.sql, probe.params, planned)
								: yield* explainServerStatement(
										session,
										probe.sql,
										probe.params,
										"generic",
										planned
									)
						const facts = planFacts(e.plan)
						const [only, ...more] = facts.indexes
						assert.ok(
							only !== undefined &&
								more.length === 0 &&
								(read.kind === "a family's members"
									? byGroup.includes(only)
									: inOrder.includes(only)),
							`${name} reads its index alone, one in its order: ${Formatter.format(facts.indexes)}`
						)
						assert.equal(facts.seqScans, 0, `${name} scans nothing sequentially`)
						assert.deepEqual(facts.recursive, [], `${name} does not recurse`)
						const answered = yield* session.values(probe.sql, probe.params)
						const got = Arr.map(answered, (r) => Number(r[0]))
						switch (read.kind) {
							case "the export":
								assert.equal(facts.sorts, 0, `${name} sorts nothing`)
								assert.equal(facts.read, load.tree, `${name} reads each row once`)
								assert.deepEqual(
									got,
									Arr.map(rows, (r) => startOf(r.id)),
									`${name} is the pre-order`
								)
								break
							case "descendants": {
								const { row } = subjectAt(read.depth, read.pick)
								assert.equal(facts.read, row.end - row.start - 1, `${name} reads exactly them`)
								assert.deepEqual(
									Arr.sort(got, Order.Number),
									Arr.sort(Arr.map(descendantsOf(rows, row.id), startOf), Order.Number),
									`${name} are the rows under it by their parent links`
								)
								break
							}
							case "a family's members":
								assert.equal(facts.read, load.members, `${name} reads exactly its members`)
								assert.deepEqual(
									got,
									Arr.map(
										upTo(load.members, (i) => i),
										(a) => read.owner * load.members + a
									),
									`${name} come in slot order`
								)
								break
						}
						cx.note(name)
					})
				),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN's plan shape: T1's or the family key's index alone, no Sort, no Seq Scan, no recursive node; each read's rows against the tree's parent links or the family as written"
		},
		show: Formatter.format,
		budget: plansBudget,
		kept: [
			{
				token: ReplayToken(
					"test/pg/fin/plans.test.ts#familyAndTreeReadsGoThroughGrizzlesInstalledIndexesWithNoSortSequentialScanOrRecursion:-:0.2.0"
				),
				reason:
					"a family's members read by a custom plan, red at 3adc7e172 where the planner read them through the owner axis's reverse index (g, ‹n›), fixed by 9ebfb08ca",
				since: "2026-11-14"
			}
		],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\t\t\t\t\t{ relation: member, base: extendNonEmpty(group, [copy]), keyed: memberGroup },",
				replacement:
					"\t\t\t\t\t\t\t{ relation: member, base: extendNonEmpty(group, [copy]), keyed: extendNonEmpty(group, [copy]) },",
				why: "An ordered family's owner axis plans its reverse index over every referencing column, its copy of the count among them, as at 3adc7e172: the index (g, ‹n›) it adds, which this property's red there found the planner reading a family's members through (fixed by 9ebfb08ca), stands beside the family key."
			}
		]
	})
