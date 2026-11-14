/**
 * Plan properties of the optimized lowering on PostgreSQL 19 (the R04, R17, R20 and R22 mechanisms).
 *
 * The fixture (fixture.ts) is installed by the fresh-install compiler, filled to pinned sizes and VACUUM ANALYZEd once
 * per test. Each query is compiled by compileQuery (packages/engine/src/program) for the `snapshot` context, and the
 * statements the runtime sends are planned with EXPLAIN (FORMAT JSON), under ANALYZE where a property counts rows, and
 * read by the tree's one EXPLAIN decoder (bench/harness/explain.ts). The properties are the contract; the plan's node
 * order, index names and costs are the planner's:
 *
 * - every take of 1 to 50 over a retained primary key (Posting's, Item's or Account's), ordered by it either way,
 *   deduplicates nothing and sorts nothing and never scans its relation sequentially, while the same statement with
 *   the redundant DISTINCT the elision removed, and the conservative artifact, which deduplicates at every boundary,
 *   each deduplicate, by a Unique node over ordered rows or by a hashed Aggregate, whichever the planner costs lower
 *   (R17: removing it is the observable effect);
 * - a take bound to the rows of a small relation parameter, over drawn parent sets, reads entries in proportion to the
 *   parents times k (at most k + 1 per parent) and never scans entry sequentially (R20);
 * - a pipelined attachment's take of a drawn bound and direction over parent rows the facts do not bound reads entry in
 *   one scan, once (R20);
 * - a relation parameter joined to a keyed relation, over drawn id sets with repeats and absent ids, reads Item only
 *   by index probes, never sequentially, as the arrays the template carries, whose estimate is the input's length
 *   (R22);
 * - a sum or a count over (id, account, amount) folds the scan in one grouping step with no deduplication, while one
 *   over the distinct (account, amount) values deduplicates its contributions first;
 * - a query whose discriminator stays a literal never scans its relation sequentially, under a generic and a custom
 *   prepared plan alike, over drawn parameters (R04: generic and custom plans are tested separately).
 *
 * Oracle: each mechanism's specification, judged on PostgreSQL's own plan of the statement the runtime sends: the
 * grouping steps, scans, loops and rows read it reports.
 *
 * Features: each keyed relation in each direction, each direction of a pipelined take, each fold of each binding, and
 * each query under each plan cache mode. The lateral take and the relation parameter's probe hold for every drawn
 * input; a drawn input's shape is no situation of theirs.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): plans-take-deduplicated (every take starts DISTINCT),
 * plans-lateral-unbounded (a LATERAL take reads with no LIMIT), plans-pipelined-lateral (a take over every group goes
 * LATERAL, one scan per parent), plans-relparam-text-arrays (a relation input's arrays are sent as text),
 * plans-fold-deduplicated (every match region starts DISTINCT) and plans-probe-keys-off (no selection key is probed).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, increasing, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import {
	type EstimatedNode,
	explainStatementWith,
	findNodes,
	groupingSteps,
	type PlanNode,
	parsePlan,
	parsePlanTree,
	planNodes
} from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import {
	Account,
	Entry,
	factSql,
	Item,
	Note,
	Plans,
	Posting,
	relationNames,
	sizes,
	Task,
	uid
} from "#test/pg/plans/fixture.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type TemplateDeclarations,
	declaredOf,
	installationSql,
	paramTexts,
	programAsts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { isList } from "#test/support/list.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { owning } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The relations keyed by one id the plan fixture fills past a page: a take over their key reads it in key order. */
type Keyed = "Posting" | "Item" | "Account"

/** The first `k` facts of a keyed relation by id, in `direction`: a take over the retained primary key. */
const firstBy = (relation: Keyed, direction: Direction, k: number): unknown => {
	switch (relation) {
		case "Posting":
			return query(Plans)
				.rule((r) => {
					const { id } = v(Posting, "posting")
					return r.match(Posting, { id }).find({ id })
				})
				.orderBy(["id", direction])
				.take(k)
		case "Item":
			return query(Plans)
				.rule((r) => {
					const { id } = v(Item, "item")
					return r.match(Item, { id }).find({ id })
				})
				.orderBy(["id", direction])
				.take(k)
		case "Account":
			return query(Plans)
				.rule((r) => {
					const { id } = v(Account, "account")
					return r.match(Account, { id }).find({ id })
				})
				.orderBy(["id", direction])
				.take(k)
	}
}

/** A take: its relation, its direction and its bound. */
interface TakeCase {
	readonly relation: Keyed
	readonly direction: Direction
	readonly k: number
}

const takeCaseGen: Gen<TakeCase> = (source) => ({
	relation: source.draw(element<Keyed>(["Posting", "Item", "Account"])),
	direction: source.draw(element(directions)),
	k: source.draw(int(1, 50))
})

/** How many entries per account the lateral take takes. */
const firstCount = 2

/** An account's first `firstCount` entries by seq, bound to each account of a relation parameter. */
const firstEntries = query(Plans)
	.rule((r) => {
		const { seq, amount } = v(Entry, "entry")
		return r
			.match(Entry, { account: r.param("account", Entry.fields.account), seq, amount })
			.find({ seq, amount })
	})
	.orderBy(["seq", "asc"])
	.take(firstCount)

const entriesPerAccount = query(Plans).rule((r) => {
	const wanted = r.relation("accounts", { id: Account.fields.id })
	const { id: account } = v(Account, "account")
	const top = firstEntries.bind({ account })
	const { seq, amount } = v(top, "top")
	return r.match(wanted, { id: account }).match(top, { seq, amount }).find({ account, seq, amount })
})

/** The items whose ids a relation parameter lists. */
const itemsById = query(Plans).rule((r) => {
	const wanted = r.relation("ids", { id: Item.fields.id })
	const { id, amount } = v(Item, "item")
	return r.match(wanted, { id }).match(Item, { id, amount }).find({ id, amount })
})

/** Whether an aggregate's match binds Posting's key, so its rows are distinct already, or its values only, staged. */
type Bound = "the key" | "the values"

/** What an aggregate folds per account: the amounts' sum, or the bindings' count. */
type Fold = "sum" | "count"

/**
 * The fold per account over Posting: of every posting, its match binding the key (id, account, amount), or of the
 * distinct (account, amount) values, a stage matched whole.
 */
const foldOf = (bound: Bound, fold: Fold): unknown => {
	switch (`${fold} of ${bound}` as const) {
		case "sum of the key":
			return query(Plans).rule((r) => {
				const { id, account, amount } = v(Posting, "posting")
				return r.match(Posting, { id, account, amount }).find({ account, total: r.sum(amount) })
			})
		case "count of the key":
			return query(Plans).rule((r) => {
				const { id, account, amount } = v(Posting, "posting")
				return r.match(Posting, { id, account, amount }).find({ account, total: r.count() })
			})
		case "sum of the values":
			return query(Plans).rule((r) => {
				const amounts = r.interior((inner) => {
					const { account, amount } = v(Posting, "posting")
					return inner.match(Posting, { account, amount }).find({ account, amount })
				})
				const { account, amount } = v(amounts, "amounts")
				return r.match(amounts, { account, amount }).find({ account, total: r.sum(amount) })
			})
		case "count of the values":
			return query(Plans).rule((r) => {
				const amounts = r.interior((inner) => {
					const { account, amount } = v(Posting, "posting")
					return inner.match(Posting, { account, amount }).find({ account, amount })
				})
				const { account, amount } = v(amounts, "amounts")
				return r.match(amounts, { account, amount }).find({ account, total: r.count() })
			})
	}
}

/** A drawn aggregate: what its match binds and what it folds. */
interface FoldCase {
	readonly bound: Bound
	readonly fold: Fold
}

/**
 * The open note of a ticket, and the automatic task of an account: each selected by a literal the partial index's
 * predicate names.
 */
const openNote = query(Plans).rule((r) => {
	const { id } = v(Note, "note")
	return r
		.match(Note, { id, ticket: r.param("ticket", Note.fields.ticket), open: true })
		.find({ id })
})

const automaticTask = query(Plans).rule((r) => {
	const { id } = v(Task, "task")
	return r
		.match(Task, { id, account: r.param("account", Task.fields.account), kind: "Automatic" })
		.find({ id })
})

/**
 * Each account with its first `k` entries by seq in `direction` attached. Its parents read no approximate search, so it
 * is a pipelined attachment over the delivered parent keys, whose take chooses its form per execution.
 */
const accountsWithFirstEntries = (direction: Direction, k: number) =>
	query(Plans)
		.rule((r) => {
			const { id, name } = v(Account, "account")
			return r.match(Account, { id, name }).find({ id, name })
		})
		.attach(
			"first",
			(parent) =>
				query(Plans)
					.rule((r) => {
						const { seq, amount } = v(Entry, "entry")
						return r
							.match(Entry, { account: parent.id, seq, amount })
							.find({ seq, amount, seqAgain: seq, amountAgain: amount, seqThird: seq })
					})
					.orderBy(["seq", direction])
					.take(k),
			"array"
		)

const compiled = (q: unknown, schema: string): OracleTemplate => {
	const r = compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schema))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/** What paramTexts normalizes the relation inputs of `template`, compiled from `q` as `compiled` compiles it, under. */
const declared = (q: unknown, template: OracleTemplate): TemplateDeclarations =>
	declaredOf(template, q, undefined, testCompile)

const only = <A>(xs: ReadonlyArray<A>, what: string): A => {
	const [x, ...rest] = xs
	if (x === undefined || rest.length > 0) {
		throw new Error(`expected one ${what}, found ${xs.length}`)
	}
	return x
}

/** The statement with DISTINCT on the core of its bounded query, the SELECT that carries the LIMIT. */
const withDistinctBound = (ast: Select): Select => {
	const visit = (value: unknown): unknown => {
		if (isList(value)) {
			return Arr.map(value, visit)
		}
		if (!hasProperties(value)) {
			return value
		}
		const out: Record<string, unknown> = {}
		for (const [k, x] of Rec.toEntries(value)) {
			out[k] = visit(x)
		}
		if (value["kind"] === "select" && value["limit"] !== undefined) {
			const body = out["body"]
			if (!hasProperties(body) || body["kind"] !== "core") {
				throw new Error("a bounded query over one core")
			}
			out["body"] = { ...body, distinct: true }
		}
		return out
	}
	return trusted<Select>(visit(ast))
}

/** Every node of an estimated plan, the root first. */
const estimatedNodes = (plan: EstimatedNode): ReadonlyArray<EstimatedNode> =>
	planNodes(plan).toArray()

const nodeTypes = (plan: EstimatedNode): ReadonlyArray<string> =>
	Arr.map(estimatedNodes(plan), (n) => n.nodeType)

/** The nodes of a plan that scan `relation` sequentially. */
const sequentialScans = (plan: EstimatedNode, relation: string): ReadonlyArray<EstimatedNode> =>
	Arr.filter(
		estimatedNodes(plan),
		(n) => n.nodeType === "Seq Scan" && Option.contains(n.relation, relation)
	)

/** The scans of `relation` in a plan that ran: every node that reads its rows (a Bitmap Index Scan only yields TIDs). */
const scansOf = (plan: PlanNode, relation: string): ReadonlyArray<PlanNode> =>
	findNodes(
		plan,
		(n) => Option.contains(n.relation, relation) && n.nodeType !== "Bitmap Index Scan"
	)

/** Rows a plan that ran read from `relation`, over every loop of every scan: output plus what filters removed. */
const rowsReadOf = (plan: PlanNode, relation: string): number =>
	Arr.reduce(
		scansOf(plan, relation),
		0,
		(sum, n) =>
			sum + (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	)

const analyze = (sql: string, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			explainStatementWith(sql, { serialize: { kind: "off" }, wal: false }),
			params
		)
		return succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN ANALYZE plan").plan
	})

const estimate = (sql: string, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(`EXPLAIN (FORMAT JSON) ${sql}`, params)
		return succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
	})

layer(Substrate.layer)("plan properties of the optimized lowering", (it) => {
	/**
	 * Each test installs its own copy under its own schema, which the test's scope drops: the fixture is a few
	 * seconds of generate_series and VACUUM ANALYZE, and no test sees another's session state.
	 *
	 * VACUUM cannot run inside a transaction block: one autocommit statement per table.
	 */
	const fixture = Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "plans" })
		const owned = owning(Plans)
		const installation = compileInstallation(owned, {
			...installOptions(owned, s.owner.role),
			levels: [identity.schema(parsedSchemaName(schema))]
		})
		if (!installation.ok) {
			return yield* Effect.die(new Error(installation.error.message))
		}
		const names = installation.value.names
		const table = (relation: string) => printObjectName(names.relation(relation))
		yield* transaction(s.admin, [
			...installationSql(installation.value, s.database),
			...factSql({
				table,
				kinds: defined(names.codes.rosters.get(parsedName("Kind")), "the codes of Kind")
			})
		])
		for (const relation of relationNames) {
			yield* s.admin.query(`VACUUM (ANALYZE) ${table(relation)}`, [])
		}
		return { schema, relation: (name: string) => names.relation(name).name }
	})

	it.effect(
		"a retained-PK ordered take deduplicates and sorts nothing, where the unelided forms deduplicate",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { schema, relation } = yield* fixture
					return yield* exhaust(
						{
							suite: "pg/plans/retained-take",
							generator: takeCaseGen,
							literal: Formatter.format,
							box: "every take of 1 to 50 of Posting, Item and Account, ordered by its key either way",
							oracle: {
								kind: "specification",
								name: "R17: a take over a retained key needs no deduplication, which the unelided forms keep"
							},
							coverage: requiredInSpace<`${Keyed} ${Direction}`>([
								"Posting asc",
								"Posting desc",
								"Item asc",
								"Item desc",
								"Account asc",
								"Account desc"
							]),
							caseHang,
							concurrency: 1
						},
						(c, k) =>
							Effect.gen(function* () {
								const q = firstBy(c.relation, c.direction, c.k)
								const template = compiled(q, schema)
								const optimized = only(template.optimized, "optimized statement")
								const plan = yield* estimate(
									optimized.sql,
									paramTexts(optimized, {}, declared(q, template))
								)
								assert.deepEqual(
									groupingSteps(nodeTypes(plan)),
									[],
									"the take deduplicates nothing"
								)
								assert.equal(nodeTypes(plan).includes("Sort"), false)
								assert.deepEqual(sequentialScans(plan, relation(c.relation)), [])
								const redundant = withDistinctBound(
									only(programAsts(template.programs.optimized), "program statement")
								)
								const kept = yield* estimate(printStatement(redundant), [])
								assert.notDeepEqual(
									groupingSteps(nodeTypes(kept)),
									[],
									"the elided DISTINCT deduplicates"
								)
								const conservative = only(template.conservative, "conservative statement")
								const plain = yield* estimate(
									conservative.sql,
									paramTexts(conservative, {}, declared(q, template))
								)
								assert.notDeepEqual(
									groupingSteps(nodeTypes(plain)),
									[],
									"the conservative artifact deduplicates"
								)
								k.note(`${c.relation} ${c.direction}`)
							})
					)
				})
			)
	)

	it.effect(
		"a take bound to a small relation parameter reads entries in proportion to parents times k, never sequentially",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { schema, relation } = yield* fixture
					const template = compiled(entriesPerAccount, schema)
					const spec = only(template.optimized, "optimized statement")
					const entry = relation("Entry")
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "R20: a take bound to a small parent set reads at most k + 1 entries per parent, never sequentially"
							},
							suite: "pg/plans/lateral-take",
							/** One to eight distinct accounts of the fixture, a set, drawn by its ascending members. */
							draw: drawn(increasing(0, sizes.accounts - 1, { min: 1, max: 8 })),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 20,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(parents) =>
							Effect.gen(function* () {
								const accounts = Arr.map(parents, (n) => ({ id: uid(1, n) }))
								const plan = yield* analyze(
									spec.sql,
									paramTexts(spec, { accounts }, declared(entriesPerAccount, template))
								)
								assert.deepEqual(
									findNodes(
										plan,
										(n) => n.nodeType === "Seq Scan" && Option.contains(n.relation, entry)
									),
									[]
								)
								assert.ok(
									rowsReadOf(plan, entry) <= (firstCount + 1) * parents.length,
									`${rowsReadOf(plan, entry)} entries read for ${parents.length} parents`
								)
							})
					)
				})
			)
	)

	it.effect(
		"a pipelined attachment's take over parent rows the facts do not bound reads entry in one scan, once",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { schema, relation } = yield* fixture
					return yield* explore(
						{
							suite: "pg/plans/pipelined-take",
							draw: drawn(
								(source) =>
									[
										source.draw(element(directions)),
										source.draw(int(1, sizes.entriesPerAccount + 2))
									] as const
							),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "R20: a take per delivered parent over unbounded parents is one scan of its relation"
							},
							coverage: required<Direction>(directions, { cases: 8, sense: notesOnly }),
							kept: [],
							runs: 6,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						([direction, k], cx) =>
							Effect.gen(function* () {
								const q = accountsWithFirstEntries(direction, k)
								const template = compiled(q, schema)
								if (
									!Arr.some(
										flight(template.programs.optimized.roots),
										(s) => s.role.kind === "attachment"
									)
								) {
									return yield* Effect.die(new Error("the attachment part"))
								}
								/**
								 * The read's one statement: its rows part reads accounts alone, so every scan of entry is the
								 * take's.
								 */
								const statement = only(template.optimized, "the optimized statement")
								const plan = yield* analyze(
									statement.sql,
									paramTexts(statement, {}, declared(q, template))
								)
								const scans = scansOf(plan, relation("Entry"))
								assert.equal(scans.length, 1, "one scan of entry")
								assert.equal(
									only(scans, "scan of entry").actualLoops,
									1,
									"entry scanned once, not once per parent"
								)
								cx.note(direction)
							})
					)
				})
			)
	)

	it.effect(
		"a relation-parameter join reads Item only by index probes, as the arrays the template carries",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { schema, relation } = yield* fixture
					const template = compiled(itemsById, schema)
					const spec = only(template.optimized, "optimized statement")
					const item = relation("Item")
					/** Every scan of Item is an index scan with an index condition: a probe by the key. */
					const probesOnly = (plan: EstimatedNode, transport: string) => {
						const scans = Arr.filter(estimatedNodes(plan), (n) => Option.contains(n.relation, item))
						assert.ok(scans.length > 0, `${transport}: Item is read`)
						for (const n of scans) {
							assert.ok(
								n.nodeType === "Bitmap Heap Scan"
									? Option.isSome(n.recheckCond)
									: Option.isSome(n.indexCond),
								`${transport}: ${n.nodeType} reads Item without an index condition`
							)
						}
						assert.equal(
							nodeTypes(plan).includes("Seq Scan"),
							false,
							`${transport}: no sequential scan`
						)
					}
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "R22: a relation parameter joined to a keyed relation reads it by index probes alone"
							},
							suite: "pg/plans/relparam-probe",
							/** Ids of the fixture's items, repeats included, and ids past it that name no item. */
							draw: drawn(array(int(0, sizes.items + 999), { min: 1, max: 12 })),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 20,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnIds) =>
							Effect.gen(function* () {
								const ids = Arr.map(drawnIds, (n) => ({ id: uid(6, n) }))
								const plan = yield* estimate(
									spec.sql,
									paramTexts(spec, { ids }, declared(itemsById, template))
								)
								probesOnly(plan, "arrays")
							})
					)
				})
			)
	)

	it.effect(
		"an aggregate over a base key folds in one step, and one over distinct (account, amount) values deduplicates first",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { schema } = yield* fixture
					return yield* exhaust(
						{
							suite: "pg/plans/folds",
							generator: (source): FoldCase => ({
								bound: source.draw(element<Bound>(["the key", "the values"])),
								fold: source.draw(element<Fold>(["sum", "count"]))
							}),
							literal: Formatter.format,
							box: "a sum and a count per account, of a match binding Posting's key and of its distinct values",
							oracle: {
								kind: "specification",
								name: "a fold over a base key's bindings reads distinct rows; one over values deduplicates them first"
							},
							coverage: requiredInSpace<`${Fold} of ${Bound}`>([
								"sum of the key",
								"sum of the values",
								"count of the key",
								"count of the values"
							]),
							caseHang,
							concurrency: 1
						},
						(c, k) =>
							Effect.gen(function* () {
								const statement = only(
									compiled(foldOf(c.bound, c.fold), schema).optimized,
									"optimized statement"
								)
								const plan = yield* estimate(statement.sql, [])
								if (c.bound === "the key") {
									assert.deepEqual(
										groupingSteps(nodeTypes(plan)),
										["Aggregate"],
										"one fold, nothing deduplicated"
									)
								} else {
									assert.equal(
										groupingSteps(nodeTypes(plan)).length,
										2,
										"a deduplication, then the fold"
									)
								}
								k.note(`${c.fold} of ${c.bound}`)
							})
					)
				})
			)
	)

	it.effect(
		"a query whose discriminator is a literal never scans its relation sequentially, under generic and custom plans",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema, relation } = yield* fixture
					const queries = [
						{
							label: "openNote",
							q: openNote,
							relation: relation("Note"),
							param: "ticket",
							family: 4,
							size: sizes.tickets
						},
						{
							label: "automaticTask",
							q: automaticTask,
							relation: relation("Task"),
							param: "account",
							family: 1,
							size: sizes.accounts
						}
					] as const
					const indices = [0, 1] as const
					const modes = ["force_generic_plan", "force_custom_plan"] as const
					type PartialCase = {
						readonly query: (typeof indices)[number]
						readonly mode: (typeof modes)[number]
						readonly value: number
					}
					type PartialFeature = `${(typeof queries)[number]["label"]} ${(typeof modes)[number]}`
					const partialCase: Gen<PartialCase> = (source) => ({
						query: source.draw(element(indices)),
						mode: source.draw(element(modes)),
						value: source.draw(int(0, 1999))
					})
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "R04: a read whose discriminator is a literal never scans its relation sequentially, under either plan cache mode"
							},
							suite: "pg/plans/partial-index",
							draw: drawn(partialCase),
							literal: Formatter.format,
							coverage: required<PartialFeature>(
								[
									"openNote force_generic_plan",
									"openNote force_custom_plan",
									"automaticTask force_generic_plan",
									"automaticTask force_custom_plan"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, cx) =>
							Effect.gen(function* () {
								const chosen = elementAt(queries, c.query, "the drawn query")
								const template = compiled(chosen.q, schema)
								const spec = only(template.optimized, "optimized statement")
								const texts = paramTexts(
									spec,
									{ [chosen.param]: uid(chosen.family, c.value % (2 * chosen.size)) },
									declared(chosen.q, template)
								)
								const session = yield* s.session({
									...ownerSession(),
									label: `plans_${chosen.label}`
								})
								yield* session.query(`SET plan_cache_mode = ${c.mode}`, [])
								yield* session.query(`PREPARE p AS ${spec.sql}`, [])
								const args = Arr.join(
									Arr.map(texts, (text) => `'${Str.replaceAll("'", "''")(text)}'`),
									", "
								)
								const rows = yield* session.values(`EXPLAIN (FORMAT JSON) EXECUTE p(${args})`, [])
								const plan = succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
								assert.deepEqual(
									sequentialScans(plan, chosen.relation),
									[],
									`${chosen.label} ${c.mode}`
								)
								cx.note(`${chosen.label} ${c.mode}`)
							})
					)
				})
			)
	)
})
