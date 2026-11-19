/** What the property of take-form.test.ts reads: its schema and template, its space and its readings of a plan. */

import { increasing, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, pipe, String as Str } from "effect"
import type { Plan } from "#adapter/types/db.ts"
import { findNodes, type PlanNode } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { lateralParentMax } from "#compiler/lower/shapes/index.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { seededFixtureTemplate } from "#test/pg/reads/support.ts"
import { volumeFill } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export const Account = relation("Account", { id: uuid }, ["id"])
export const Entry = relation("Entry", { account: uuid, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])
export const Latest = relation("Latest", { account: uuid, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])
export const Takes = schema("Takes", [Account, Entry, Latest], [])

const accounts = 2000
const entriesPerAccount = 30

/** How many of each account's entries the take keeps: its k. */
export const taken = 2

/** A deterministic uuid of account `n`. */
export const uid = (n: number): Uuid =>
	`00000001-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const uidSql = (n: string): string =>
	`('00000001-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`

export type FormFeature =
	| "the LATERAL form for few parents"
	| "the whole-relation form for many parents"

/** What every case installs: Takes, its full world's workload holding nothing, the ChangeSet loaded by the case. */
export const takesInstall = { label: "takeform", programs: {} } as const

/**
 * Takes installed once per member, its accounts and their entries filled and analyzed (reads/support.ts
 * seededFixtureTemplate), where the search filled and analyzed them once before its cases: a clone keeps the
 * template's rows and its statistics, and each case rolls back what it writes.
 */
export const takesTemplate = seededFixtureTemplate(import.meta, Takes, takesInstall, (generated) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const names = generated.installed.installation.names
		const table = (r: string) => printObjectName(names.relation(r))
		const column = (r: string, f: string) => quoteIdent(names.column(r, f))
		yield* volumeFill(s.admin, [
			{
				tables: [{ table: table("Account"), columns: [[column("Account", "id"), uidSql("g")]] }],
				rows: accounts,
				conflicts: "refused"
			},
			{
				tables: [
					{
						table: table("Entry"),
						columns: [
							[column("Entry", "account"), uidSql(`g % ${accounts}`)],
							[column("Entry", "seq"), `(g / ${accounts})::int8`],
							[column("Entry", "amount"), "(g % 53)::int8"]
						]
					}
				],
				rows: accounts * entriesPerAccount,
				conflicts: "refused"
			}
		])
		yield* s.admin.query(
			`VACUUM (ANALYZE) ${Arr.join(Arr.map(["Account", "Entry", "Latest"], table), ", ")}`,
			[]
		)
	})
)

/** Distinct accounts, a set by construction, of `size`. */
const parentsOf = (size: Readonly<{ min: number; max: number }>) =>
	increasing(0, accounts - 1, size)

/**
 * A case's parents: at most the choice's threshold, lateralParentMax for a named relation parameter, whose every fact
 * is one parent (lower/shapes/take chooseTakeShape), or more, each half of the drawn cases; the case holds the write's
 * threshold to it, where the search read the threshold off the loaded write before drawing.
 */
export const parentsGen = oneOf([
	parentsOf({ min: 1, max: lateralParentMax }),
	parentsOf({ min: lateralParentMax + 1, max: 2 * lateralParentMax + 1 })
])

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

/** Whether a plan reads Entry, by its table or an index of it, at its root or beneath. */
const readsEntry = (plan: Plan): boolean =>
	((plan.on.kind === "relation" || plan.on.kind === "index") && plan.on.relation === "Entry") ||
	Arr.some(plan.children, readsEntry)

/**
 * Whether a plan ranks Entry's rows: a WindowAgg node over a read of Entry, the whole-relation form's row_number. The
 * insert's met rows (sql/ast.ts FromSource `metRows`) are a window over the statement's own CTEs, which reads no
 * Entry row.
 */
export const ranked = (plan: Plan): boolean =>
	(plan.node === "WindowAgg" && readsEntry(plan)) || Arr.some(plan.children, ranked)
