/** What the properties of plans.test.ts read: the plans template, the fixtures' queries and the plan readings. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import {
	type EstimatedNode,
	explainStatementWith,
	findNodes,
	type PlanNode,
	parsePlan,
	parsePlanTree,
	planNodes
} from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	Account,
	Entry,
	factFills,
	Item,
	Note,
	Plans,
	Posting,
	relationNames,
	Task
} from "#test/pg/plans/fixture.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type TemplateDeclarations,
	declaredOf,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { isList } from "#test/support/list.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { owning } from "#test/support/policy.ts"
import { filledScriptTemplate, type ScriptInstall } from "#test/support/script-template.ts"
import { volumeFill } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The relations keyed by one id the plan fixture fills past a page: a take over their key reads it in key order. */
export type Keyed = "Posting" | "Item" | "Account"

/** The first `k` facts of a keyed relation by id, in `direction`: a take over the retained primary key. */
export const firstBy = (relation: Keyed, direction: Direction, k: number): unknown => {
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
export interface TakeCase {
	readonly relation: Keyed
	readonly direction: Direction
	readonly k: number
}

export const takeCaseGen: Gen<TakeCase> = (source) => ({
	relation: source.draw(element<Keyed>(["Posting", "Item", "Account"])),
	direction: source.draw(element(directions)),
	k: source.draw(int(1, 50))
})

/** How many entries per account the lateral take takes. */
export const firstCount = 2

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

export const entriesPerAccount = query(Plans).rule((r) => {
	const wanted = r.relation("accounts", { id: Account.fields.id })
	const { id: account } = v(Account, "account")
	const top = firstEntries.bind({ account })
	const { seq, amount } = v(top, "top")
	return r.match(wanted, { id: account }).match(top, { seq, amount }).find({ account, seq, amount })
})

/** The items whose ids a relation parameter lists. */
export const itemsById = query(Plans).rule((r) => {
	const wanted = r.relation("ids", { id: Item.fields.id })
	const { id, amount } = v(Item, "item")
	return r.match(wanted, { id }).match(Item, { id, amount }).find({ id, amount })
})

/** Whether an aggregate's match binds Posting's key, so its rows are distinct already, or its values only, staged. */
export type Bound = "the key" | "the values"

/** What an aggregate folds per account: the amounts' sum, or the bindings' count. */
export type Fold = "sum" | "count"

/**
 * The fold per account over Posting: of every posting, its match binding the key (id, account, amount), or of the
 * distinct (account, amount) values, a stage matched whole.
 */
export const foldOf = (bound: Bound, fold: Fold): unknown => {
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
export interface FoldCase {
	readonly bound: Bound
	readonly fold: Fold
}

/**
 * The open note of a ticket, and the automatic task of an account: each selected by a literal the partial index's
 * predicate names.
 */
export const openNote = query(Plans).rule((r) => {
	const { id } = v(Note, "note")
	return r
		.match(Note, { id, ticket: r.param("ticket", Note.fields.ticket), open: true })
		.find({ id })
})

export const automaticTask = query(Plans).rule((r) => {
	const { id } = v(Task, "task")
	return r
		.match(Task, { id, account: r.param("account", Task.fields.account), kind: "Automatic" })
		.find({ id })
})

/**
 * Each account with its first `k` entries by seq in `direction` attached. Its parents read no approximate search, so it
 * is a pipelined attachment over the delivered parent keys, whose take chooses its form per execution.
 */
export const accountsWithFirstEntries = (direction: Direction, k: number) =>
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

export const compiled = (q: unknown, schema: string): OracleTemplate => {
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
export const declared = (q: unknown, template: OracleTemplate): TemplateDeclarations =>
	declaredOf(template, q, undefined, testCompile)

export const only = <A>(xs: ReadonlyArray<A>, what: string): A => {
	const [x, ...rest] = xs
	if (x === undefined || rest.length > 0) {
		throw new Error(`expected one ${what}, found ${xs.length}`)
	}
	return x
}

/** The statement with DISTINCT on the core of its bounded query, the SELECT that carries the LIMIT. */
export const withDistinctBound = (ast: Select): Select => {
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
export const estimatedNodes = (plan: EstimatedNode): ReadonlyArray<EstimatedNode> =>
	planNodes(plan).toArray()

export const nodeTypes = (plan: EstimatedNode): ReadonlyArray<string> =>
	Arr.map(estimatedNodes(plan), (n) => n.nodeType)

/** The nodes of a plan that scan `relation` sequentially. */
export const sequentialScans = (
	plan: EstimatedNode,
	relation: string
): ReadonlyArray<EstimatedNode> =>
	Arr.filter(
		estimatedNodes(plan),
		(n) => n.nodeType === "Seq Scan" && Option.contains(n.relation, relation)
	)

/** The scans of `relation` in a plan that ran: every node that reads its rows (a Bitmap Index Scan only yields TIDs). */
export const scansOf = (plan: PlanNode, relation: string): ReadonlyArray<PlanNode> =>
	findNodes(
		plan,
		(n) => Option.contains(n.relation, relation) && n.nodeType !== "Bitmap Index Scan"
	)

/** Rows a plan that ran read from `relation`, over every loop of every scan: output plus what filters removed. */
export const rowsReadOf = (plan: PlanNode, relation: string): number =>
	Arr.reduce(
		scansOf(plan, relation),
		0,
		(sum, n) =>
			sum + (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	)

export const analyze = (sql: string, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			explainStatementWith(sql, { serialize: { kind: "off" }, wal: false }),
			params
		)
		return succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN ANALYZE plan").plan
	})

export const estimate = (sql: string, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(`EXPLAIN (FORMAT JSON) ${sql}`, params)
		return succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
	})

/**
 * Plans installed in a schema of its own, its facts filled to the pinned sizes and vacuumed and analyzed, once per
 * member (script-template.ts filledScriptTemplate), where each search installed and filled its own copy before its
 * cases: every case only plans and reads.
 */
export const plansTemplate = filledScriptTemplate({
	declaredIn: import.meta,
	name: "plans",
	label: "plans",
	compile: (schema) => {
		const owned = owning(Plans)
		return succeeded(
			compileInstallation(owned, {
				...installOptions(owned),
				levels: [identity.schema(parsedSchemaName(schema))],
				logins: [oracleOwnedLogin(owned.desc)]
			}),
			"the plans installation"
		)
	},
	fill: (installed) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const names = installed.installation.names
			const table = (relation: string) => printObjectName(names.relation(relation))
			yield* volumeFill(
				s.admin,
				factFills({
					table,
					kinds: defined(names.codes.rosters.get(parsedName("Kind")), "the codes of Kind")
				})
			)
			for (const relation of relationNames) {
				yield* s.admin.query(`VACUUM (ANALYZE) ${table(relation)}`, [])
			}
		})
})

/** A case's schema and its relations' names over its seat of the template. */
export const plansIn = (installed: ScriptInstall) => ({
	schema: installed.schema,
	relation: (name: string) => installed.installation.names.relation(name).name
})

/** A fold case: its fold and what its match binds, Posting's key or its distinct values. */
export const foldCases = (source: Source): FoldCase => ({
	bound: source.draw(element<Bound>(["the key", "the values"])),
	fold: source.draw(element<Fold>(["sum", "count"]))
})

/** The partial-index property's queries, by their place, and the plan cache modes. */
const partialIndices = [0, 1] as const
const modes = ["force_generic_plan", "force_custom_plan"] as const

/** A partial-index case: a query by its place, a plan cache mode, and a literal of the discriminator's domain. */
export interface PartialCase {
	readonly query: (typeof partialIndices)[number]
	readonly mode: (typeof modes)[number]
	readonly value: number
}

export type PartialFeature = `${"openNote" | "automaticTask"} ${(typeof modes)[number]}`

export const partialCase: Gen<PartialCase> = (source) => ({
	query: source.draw(element(partialIndices)),
	mode: source.draw(element(modes)),
	value: source.draw(int(0, 1999))
})
