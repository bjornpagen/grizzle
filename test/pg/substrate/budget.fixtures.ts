/** What the property of budget.test.ts reads: its space, the installation it reads through, and its judgments. */

import { array, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Duration, Order, Record as Rec, Result } from "effect"
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

/**
 * How long one barrier of a case waits for the state it observes before it fails the case with what it last saw: every
 * session of the case ended (its first barrier), every pool call waiting on the holder's lock or refused, and an opener
 * opened within the width or refused past it. Each is reached in milliseconds, so a state that never comes, an opener
 * left waiting for a permit the width never frees (the property's first kill), fails its case here, where it held the
 * case until its hang (trunk at f1bf91a2f: three hours).
 *
 * @limitKind measured
 * @owner grizzle's network tier (test/pg/substrate/budget.test.ts)
 * @unit milliseconds
 * @scope one barrier or opener of one case of test/pg/substrate/budget.test.ts, on the local cluster
 * @evidence the property run by path (TEST_SEED=2219874524) with each barrier's wait timed, performance.now() around
 *   its awaitFact, appended to a file; its samples kept at ~/.cache/grizzle/unitreds-scratch/budget-waits-1.tsv on
 *   cassowary
 * @observed 2026-11-22 06:47 to 06:49 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 94 to 156 from other sessions; the
 *   shared PostgreSQL 19 cluster; grizzle 893cc9611 with this property's barriers
 * @workload 239 barriers over the property's cases and its mutants' first cases: 114 ends of every session, 125 pool
 *   calls waiting or refused
 * @result every session ended within 185.5 ms (mean 24.0), every pool call waiting or refused within 215.3 ms (mean
 *   32.1). Openers were not timed: a refused opener sends nothing, and an opened one opens one connection, as each pool
 *   call that waits does
 * @decision 30,000 ms, about 140 times the most observed, which takes in a network tier's full run loading cassowary
 *   to 340 to 440 (limits.ts hangLimit), three times the measured load, unmeasured; a mutant's case fails within it
 *   instead of the hang limit's hour
 * @revalidate a case red here whose state did come; a change to the budget, the pool or the substrate's sessions; a
 *   PostgreSQL repin; another machine
 */
const barrierWaitMillis = 30_000

/** How long one barrier or opener of a case waits (barrierWaitMillis). */
export const barrierWait = Duration.millis(barrierWaitMillis)

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
