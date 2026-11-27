/** What held-scope.test.ts reads: its schemas, its reads, a case's stored rows and its run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

const i = pg.integer

/**
 * A learner's item sessions, each of a stage, by the learner and its place; each session's attempts, by their instant;
 * each attempt's mark; and a sitting of a learner's stage, by its own number: magic-sets' ledger, every relation in the
 * learner's unit but the sitting, which names it.
 */
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const ItemSession = relation("ItemSession", { child: i, n: i, stage: i }, ["child", "n"])
const Mark = relation("Mark", { child: i, n: i, at: i, score: i }, ["child", "n", "at"])
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i }, ["sitting"])
const Ledger = schema(
	"HeldScope",
	[Attempt, ItemSession, Mark, Sitting],
	[key(on(ItemSession, "child", "stage", "n")), unit("Learner", { child: i })]
)

/** Each attempt of a stage's session with its mark: a join of stored relations, no computation apart. */
const marked = query(Ledger).rule((r) => {
	const { child, n, at } = v(Attempt, "attempt")
	const { stage } = v(ItemSession, "session")
	const { score } = v(Mark, "mark")
	return r
		.match(Attempt, { child, n, at })
		.match(ItemSession, { child, n, stage })
		.match(Mark, { child, n, at, score })
		.find({ child, stage, n, at, score })
})

/**
 * A sitting with each pair of its stage's sessions that share an instant attached: the attachment's child reads the
 * stage's sessions, then the marked attempts twice, each at a session's place and the first's instant. Both reads of
 * the join arrive at the sitting's child and stage, so the attachment's root holds it once (keys.ts restrictionWalk,
 * context.ts heldEnv); the chain led by the sessions reads each per row at the values before it, a row site that
 * restricts the nodes under the join at the session's place (region chainSites), values of the attachment's own FROM,
 * which the root's WITH does not see. qti-pie's ItemRefSection, its structure nodes held at the test and read by two
 * chain steps at each item ref's values, printed 42P01 so (the helper's c390).
 */
const pairsRead = query(Ledger)
	.rule((r) => {
		const { child, stage } = v(Sitting, "sitting")
		return r.match(Sitting, { sitting: r.param("sitting", i), child, stage }).find({ child, stage })
	})
	.attach(
		"pairs",
		(head) =>
			query(Ledger).rule((r) => {
				const { n } = v(ItemSession, "session")
				const { at, score } = v(marked, "first")
				const { n: next, score: other } = v(marked, "second")
				return r
					.match(ItemSession, { child: head.child, stage: head.stage, n })
					.match(marked, { child: head.child, stage: head.stage, n, at, score })
					.match(marked, { child: head.child, stage: head.stage, n: next, at, score: other })
					.where(r.lt(n, next))
					.find({ n, at, next, score, other })
			}),
		"array"
	)

export const heldScopeTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "held scope",
	content: { schema: Ledger.name, logins: [] },
	versions: [{ schema: Ledger, declarations: noDeclarations }],
	options: {
		label: "held_scope",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A case: the sitting's stage's sessions, each session's attempts, and the instants they fall at. */
export interface ScopeCase {
	readonly sessions: number
	readonly attempts: number
	readonly instants: number
}

export const scopeGen: Gen<ScopeCase> = (s) => ({
	sessions: s.draw(int(2, 4)),
	attempts: s.draw(int(1, 2)),
	instants: s.draw(int(1, 3))
})

export type ScopeFeature = "sessions sharing an instant" | "no two sessions sharing an instant"

/** A session's instants: its attempts', each its own, among `instants` (an attempt's key holds its instant). */
const instantsOf = (c: ScopeCase, n: number): ReadonlyArray<number> =>
	Arr.dedupe(
		Arr.map(
			Array.from({ length: c.attempts }, (_, i) => i + 1),
			(k) => 1 + ((n + k) % c.instants)
		)
	)

/** The pairs the stored rows hold: every two sessions of the stage, the first's place below the second's, at each instant both hold. */
const pairsOf = (c: ScopeCase): number =>
	Arr.flatMap(
		Array.from({ length: c.sessions }, (_, i) => i + 1),
		(n) =>
			Arr.flatMap(
				Arr.filter(
					Array.from({ length: c.sessions }, (_, i) => i + 1),
					(next: number) => next > n
				),
				(next: number) => Arr.filter(instantsOf(c, n), (at) => instantsOf(c, next).includes(at))
			)
	).length

/**
 * The stored rows: learner 1's sitting of stage 0, and learners 1 and 2 each with the case's sessions of stage 0, their
 * attempts and marks, so a read restricted to learner 1 reads none of learner 2's.
 */
const stored = (installed: Installed, c: ScopeCase): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const rows = Arr.flatMap([1, 2], (child) =>
		Arr.flatMap(
			Array.from({ length: c.sessions }, (_, i) => i + 1),
			(n) => Arr.map(instantsOf(c, n), (at) => ({ child, n, at }))
		)
	)
	return [
		`INSERT INTO ${names.table(Sitting)} VALUES (1, 1, 0)`,
		`INSERT INTO ${names.table(ItemSession)} SELECT child, n, 0 FROM generate_series(1, 2) AS c(child), generate_series(1, ${String(c.sessions)}) AS s(n)`,
		...Arr.map(
			rows,
			(r) =>
				`INSERT INTO ${names.table(Attempt)} VALUES (${String(r.child)}, ${String(r.n)}, ${String(r.at)})`
		),
		...Arr.map(
			rows,
			(r) =>
				`INSERT INTO ${names.table(Mark)} VALUES (${String(r.child)}, ${String(r.n)}, ${String(r.at)}, ${String(10 * r.n + r.at)})`
		)
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: the stored rows, then the read of sitting 1 run at
 * PostgreSQL, its attachment holding exactly the pairs of learner 1's sessions that share an instant. A held join's CTE
 * that names a relation of the root's own FROM is refused by PostgreSQL (42P01) before a row is read.
 */
export const runScope = (
	installed: Installed,
	connection: PgConnection,
	c: ScopeCase,
	k: Case<ScopeFeature>
) =>
	Effect.gen(function* () {
		for (const sql of stored(installed, c)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(compileTemplate(pairsRead, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ sitting: 1 },
			declaredOf(template, pairsRead, undefined, options)
		)
		const rows = yield* connection.queryValues(statement.sql, params)
		const pairs = Arr.filter(rows, (row) => row[0] === "1").length
		const expected = pairsOf(c)
		assert.equal(
			pairs,
			expected,
			`${Formatter.format(c)}: the sitting's attachment holds ${String(pairs)} pairs, its sessions sharing an instant ${String(expected)}\n${statement.sql}`
		)
		k.note(expected > 0 ? "sessions sharing an instant" : "no two sessions sharing an instant")
	})

/**
 * A learner's response snapshots, by item, place and instant, and the suspensions of a sitting's candidate sessions, by
 * the session's place: qti-pie's ResponseSnapshot and TestSuspension, every relation in the learner's unit.
 */
const Snapshot = relation("Snapshot", { child: i, item: i, n: i, at: i }, [
	"child",
	"item",
	"n",
	"at"
])
const Suspension = relation("Suspension", { child: i, stage: i, k: i, at: i }, [
	"child",
	"stage",
	"k"
])
const Suspensions = schema("HeldOrder", [Snapshot, Suspension], [unit("Learner", { child: i })])

/** A sitting's suspensions at or after an instant, the import's parameter. */
const suspendedAfter = query(Suspensions).rule((r) => {
	const { child, stage, k, at } = v(Suspension, "suspension")
	return r
		.match(Suspension, { child, stage, k, at })
		.where(r.ge(at, r.param("instant", i)))
		.find({ child, stage, k })
})

/**
 * Each snapshot at a moment of a sitting the call passes in, with each suspension of that sitting at or after the
 * snapshot's instant: the region's chain is led by the moments, a held set, which bind the instant's class first; the
 * suspensions, the import bound at the instant (a correlation reading the region's variable), rank before the
 * snapshots on their declared key, the sitting's two columns where the snapshots' are the child's one; and their
 * correlation reads the instant at the column of the snapshots, the occurrence that binds it first in placement order
 * (match-region regionParts). qti-pie's ledger judge, a test's suspensions compared to a response snapshot's instant
 * placed after them, read so; the chain printed in its rank order named the snapshots' alias before it was in scope.
 */
const suspendedRead = query(Suspensions).rule((r) => {
	const moments = r.relation("moments", { child: i, stage: i, at: i })
	const { item, n } = v(Snapshot, "snapshot")
	const { child, stage, at } = v(moments, "moment")
	const { k } = v(suspendedAfter, "suspended")
	return r
		.match(Snapshot, { child, item, n, at })
		.match(moments, { child, stage, at })
		.match(suspendedAfter.bind({ instant: at }), { child, stage, k })
		.find({ child, item, n, at, k })
})

export const heldOrderTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "held order",
	content: { schema: Suspensions.name, logins: [] },
	versions: [{ schema: Suspensions, declarations: noDeclarations }],
	options: {
		label: "held_order",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: a learner's snapshots, one an item, the item's at the instant one past its number; the sitting's suspensions,
 * the session's at the instant of its place; and the moments the call passes in, at the first snapshots' instants.
 */
export interface OrderCase {
	readonly snapshots: number
	readonly suspensions: number
	readonly moments: number
}

export const orderGen: Gen<OrderCase> = (s) => ({
	snapshots: s.draw(int(1, 3)),
	suspensions: s.draw(int(1, 3)),
	moments: s.draw(int(1, 2))
})

export type OrderFeature = "a suspension after a snapshot" | "no suspension after a snapshot"

/**
 * The rows the stored rows hold for the moments: at each moment's instant `m`, the snapshot of that instant where one
 * is stored, beside each suspension at or after it, a place `k` from `m` to the last.
 */
const suspendedRowsOf = (c: OrderCase): number =>
	Arr.reduce(
		Array.from({ length: c.moments }, (_, i) => i + 2),
		0,
		(total, m) => (m <= c.snapshots + 1 ? total + Math.max(0, c.suspensions - m + 1) : total)
	)

/**
 * The stored rows: learners 1 and 2 each with the case's snapshots and its sitting of stage 0's suspensions, so a read
 * of learner 1's moments reads none of learner 2's.
 */
const storedOrder = (installed: Installed, c: OrderCase): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return [
		`INSERT INTO ${names.table(Snapshot)} SELECT child, item, 1, item + 1 FROM generate_series(1, 2) AS c(child), generate_series(1, ${String(c.snapshots)}) AS s(item)`,
		`INSERT INTO ${names.table(Suspension)} SELECT child, 0, k, k FROM generate_series(1, 2) AS c(child), generate_series(1, ${String(c.suspensions)}) AS s(k)`
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: the stored rows, then the read of learner 1's
 * moments run at PostgreSQL, holding exactly the snapshots at the moments beside the suspensions at or after them. A
 * chain step whose correlation reads an occurrence placed after it is refused by the lowering's statement audit before
 * the read is sent (a relation not in scope), as PostgreSQL would refuse it (42P01).
 */
export const runOrder = (
	installed: Installed,
	connection: PgConnection,
	c: OrderCase,
	k: Case<OrderFeature>
) =>
	Effect.gen(function* () {
		for (const sql of storedOrder(installed, c)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(suspendedRead, undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const moments = Arr.map(
			Array.from({ length: c.moments }, (_, i) => i + 2),
			(at) => ({ child: 1, stage: 0, at })
		)
		const params = paramTexts(
			statement,
			{ moments },
			declaredOf(template, suspendedRead, undefined, options)
		)
		const rows = yield* connection.queryValues(statement.sql, params)
		const expected = suspendedRowsOf(c)
		assert.equal(
			rows.length,
			expected,
			`${Formatter.format(c)}: the read holds ${String(rows.length)} rows, the snapshots at the moments beside the suspensions at or after them ${String(expected)}\n${statement.sql}`
		)
		k.note(expected > 0 ? "a suspension after a snapshot" : "no suspension after a snapshot")
	})
