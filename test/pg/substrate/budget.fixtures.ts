/** What the property of budget.test.ts reads: its space, the installation it reads through, and its judgments. */

import { array, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Order, Record as Rec, Result } from "effect"
import { query, v } from "#compiler/public/query.ts"
import { login, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"
import { ConnectionBudgetExhausted } from "#test/support/substrate/budget.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

/**
 * One opener of a file's demand: a raw session, a raw session whose login the server refuses (a wrong password), a psql
 * writer, or a pool and the calls it serves at once.
 */
type Demand =
	| { readonly kind: "raw session" }
	| { readonly kind: "refused login" }
	| { readonly kind: "psql writer" }
	| { readonly kind: "pool"; readonly max: number; readonly calls: number }

/** A case: the width of its budget, and the demand it opens under it, in order. */
export interface BudgetCase {
	readonly width: number
	readonly demands: Arr.NonEmptyReadonlyArray<Demand>
}

const demandGen: Gen<Demand> = weighted<Demand>([
	[1, () => ({ kind: "raw session" })],
	[1, () => ({ kind: "refused login" })],
	[1, () => ({ kind: "psql writer" })],
	[
		2,
		(source) => {
			const max = source.draw(int(1, 3))
			return { kind: "pool", max, calls: source.draw(int(1, max)) }
		}
	]
])

export const caseGen: Gen<BudgetCase> = (source) => ({
	width: source.draw(int(1, 4)),
	demands: [source.draw(demandGen), ...source.draw(array(demandGen, { min: 0, max: 4 }))]
})

/**
 * The connections a demand holds once it settles, within the width or past it: a refused login holds none, the permit
 * it drew given back as the server refuses it.
 */
export const demandOf = (demand: Demand): number => {
	switch (demand.kind) {
		case "pool":
			return demand.calls
		case "refused login":
			return 0
		case "raw session":
		case "psql writer":
			return 1
	}
}

export type BudgetFeature =
	| "demand within the width"
	| "demand past the width"
	| "a refused raw session"
	| "a refused login's permit drawn again"
	| "a refused psql writer"
	| "a refused pool call"
	| "a pool's calls split by the width"
	| "several pools"
	| "every kind of opener"

export const budgetFeatures: Arr.NonEmptyReadonlyArray<BudgetFeature> = [
	"demand within the width",
	"demand past the width",
	"a refused raw session",
	"a refused login's permit drawn again",
	"a refused psql writer",
	"a refused pool call",
	"a pool's calls split by the width",
	"several pools",
	"every kind of opener"
]

/** The installation's login and its one role, whose workload reads every account. */
export const worldsOver = (Work: W.WorkNamed<string>) => {
	const reader = role(Work, "reader", { Account: W.Account })
	const accounts = query(reader).rule((r) => {
		const { id, name } = v(reader.relations.Account, "account")
		return r.match(reader.relations.Account, { id, name }).find({ id })
	})
	return login(Work, "web", [reader], { workload: [workload(reader, { accounts })] })
}

/** The case's backends, as pg_stat_activity lists them in the database: all of them, and those waiting on a lock. */
export const backendsQuery = `SELECT count(*)::int4, (count(*) FILTER (WHERE a.wait_event_type = 'Lock'))::int4
FROM pg_catalog.pg_stat_activity AS a
WHERE a.datname = pg_catalog.current_database() AND a.usename = ANY ($1::text[])`

/** The password no role has, which the server refuses at authentication. */
export const wrongPassword = "not-the-password"

/** Whether a session's failure is the server's refusal of its password (28P01). */
export const refusedLogin = (error: unknown): boolean => pgErrorFields(error)?.code === "28P01"

/** Whether an opener's failure is ConnectionBudgetExhausted naming `width`, as a defect. */
export const exhaustedAt = (cause: Cause.Cause<unknown>, width: number): boolean =>
	Result.match(Cause.findDefect(cause), {
		onFailure: () => false,
		onSuccess: (defect) => defect instanceof ConnectionBudgetExhausted && defect.width === width
	})

/** Work (test/support/fixtures/api/work.ts) under the declared name `name`. */
export const workAt = (name: string) =>
	schema(name, Rec.values(W.Work.relations), W.Work.statements)

/** Every account the golden facts hold, by id in order: what every read returns. */
export const accountIds = Arr.sort(
	Arr.map(workFacts.Account, (a) => a.id),
	Order.String
)

/**
 * Work drafted and served as `grizzle generate` drafts it, with its worlds' login, as the search installed it once
 * before its cases: the template every case clones, built once per member, so no case installs the schema again.
 */
export const workTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "budget work",
	content: { schema: "Work", logins: ["the worlds' login over it"], ambient: "ordinary" },
	build: (name) => ({ schema: workAt(name), logins: [worldsOver(workAt(name))] }),
	ambient: ordinarySession
})
