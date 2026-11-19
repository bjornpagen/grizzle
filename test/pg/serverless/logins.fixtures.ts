/** What the properties of logins.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { rowsOf } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"

export type Login = "web" | "ops"

type RoleName = "reader" | "auditor" | "operator"

export interface Request {
	readonly installation: 0 | 1
	readonly role: RoleName
}

type Program =
	| {
			readonly kind: "drawn requests"
			readonly requests: Arr.NonEmptyReadonlyArray<Request>
			readonly concurrency: number
	  }
	| {
			readonly kind: "a Db per request at volume"
			readonly installation: 0 | 1
			readonly count: number
			readonly concurrency: number
	  }

const requestGen: Gen<Request> = (source) => ({
	installation: source.draw(element([0, 1] as const)),
	role: source.draw(element<RoleName>(["reader", "auditor", "operator"]))
})

export const programGen: Gen<Program> = weighted<Program>([
	[
		3,
		(source) => ({
			kind: "drawn requests",
			requests: [source.draw(requestGen), ...source.draw(array(requestGen, { min: 0, max: 7 }))],
			concurrency: source.draw(int(1, 4))
		})
	],
	[
		1,
		(source) => ({
			kind: "a Db per request at volume",
			installation: source.draw(element([0, 1] as const)),
			count: source.draw(int(24, 64)),
			concurrency: source.draw(int(8, 16))
		})
	]
])

export const loginOf = (r: RoleName): Login => (r === "operator" ? "ops" : "web")

/**
 * The worlds of an installation of Work under its declared name: two logins, three roles, and each role's read of every
 * account's id, a member of its login's workload.
 */
export const worldsOver = (Work: W.WorkNamed<string>) => {
	const reader = role(Work, "reader", { Account: W.Account })
	const auditor = role(Work, "auditor", { Account: W.Account, Task: W.Task })
	const operator = role(Work, "operator", { Account: W.Account })
	const readerAccounts = query(reader).rule((r) => {
		const { id, name } = v(reader.relations.Account, "account")
		return r.match(reader.relations.Account, { id, name }).find({ id })
	})
	const auditorAccounts = query(auditor).rule((r) => {
		const { id, name } = v(auditor.relations.Account, "account")
		return r.match(auditor.relations.Account, { id, name }).find({ id })
	})
	const operatorAccounts = query(operator).rule((r) => {
		const { id, name } = v(operator.relations.Account, "account")
		return r.match(operator.relations.Account, { id, name }).find({ id })
	})
	return {
		web: login(Work, "web", [reader, auditor], {
			workload: [workload(reader, { readerAccounts }), workload(auditor, { auditorAccounts })]
		}),
		ops: login(Work, "ops", [operator], { workload: [workload(operator, { operatorAccounts })] })
	}
}

type Worlds = ReturnType<typeof worldsOver>

/**
 * Every account's id, read by each role's workload member through a Db of the role, opened for this read alone on its
 * served login.
 */
export const readsOf = (web: ServedLogin<Worlds["web"]>, ops: ServedLogin<Worlds["ops"]>) => ({
	reader: Effect.gen(function* () {
		const db = yield* Db.open(web.roles.reader, {})
		const rows = yield* rowsOf(db.workload.readerAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	}),
	auditor: Effect.gen(function* () {
		const db = yield* Db.open(web.roles.auditor, {})
		const rows = yield* rowsOf(db.workload.auditorAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	}),
	operator: Effect.gen(function* () {
		const db = yield* Db.open(ops.roles.operator, {})
		const rows = yield* rowsOf(db.workload.operatorAccounts.once({ params: {}, facts: {} }))
		return Arr.map(rows, (row) => row.id)
	})
})

export type LoginsFeature =
	| "two installations"
	| "two logins of one installation"
	| "two roles of one login"
	| "requests at once"
	| "a login no request opened"
	| "a Db per request at volume"

/** Waits until no backend logs in as `role`: its login's pool released every session. */
export const untilGone = (role: string) =>
	Effect.gen(function* () {
		for (;;) {
			const backends = yield* roleBackends(role)
			if (backends === 0) {
				return
			}
			yield* Effect.yieldNow
		}
	})

export const workAt = (name: string) =>
	schema(name, Rec.values(W.Work.relations), W.Work.statements)

export const accountIds = Arr.sort(
	Arr.map(workFacts.Account, (a) => a.id),
	Order.String
)
