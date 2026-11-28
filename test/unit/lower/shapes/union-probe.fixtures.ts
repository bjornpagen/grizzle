/** What union-probe.test.ts reads: its schema, its box and the statements of a case's write. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"

/**
 * Each session's attempts, each attempt's snapshot of its variables, and the assertions that replace a snapshot's
 * value, as edullm's ledger holds them: an outcome in force is a snapshot no assertion replaced, or an assertion.
 */
const Attempt = relation("Attempt", { session: int4, attempt: int4, opened: int4 }, [
	"session",
	"attempt"
])
const fields = {
	session: int4,
	attempt: int4,
	variable: int4,
	value: int4
} as const
const Snapshot = relation("Snapshot", fields, ["session", "attempt", "variable"])
const Assertion = relation("Assertion", fields, ["session", "attempt", "variable"])
/** The outcomes the write records. */
const Recorded = relation("Recorded", fields, ["session", "attempt", "variable"])
const Written = schema("UnionProbeWrite", [Attempt, Snapshot, Assertion, Recorded], [])

/** The outcomes in force: each attempt's snapshot no assertion replaced, and every assertion, one union of two rules. */
const inForce = query(Written)
	.rule((r) => {
		const { session, attempt, variable, value } = v(Snapshot, "snapshot")
		return r
			.match(Snapshot, { session, attempt, variable, value })
			.where(r.not(Assertion, { session, attempt, variable }))
			.find({ session, attempt, variable, value })
	})
	.rule((r) => {
		const { session, attempt, variable, value } = v(Assertion, "assertion")
		return r.match(Assertion, { session, attempt, variable, value }).find({
			session,
			attempt,
			variable,
			value
		})
	})

/** The sessions a write reads, a relation parameter of the call. */
const sessions = { session: int4 } as const

/**
 * How the case reads the outcomes in force: a write at the call's sessions, a relation parameter; a write of the outcomes
 * in force of the call's latest attempts, beside them, two reads the call's sessions restrict; a write beside every
 * stored attempt, which no value of the call restricts; or a workload's read beside every stored attempt.
 */
export type Joined =
	| "written at the call's sessions"
	| "written at the call's latest attempts"
	| "written beside every attempt"
	| "read beside every attempt"

export interface Box {
	readonly joined: Joined
}

export const boxGen: Gen<Box> = element<Box>([
	{ joined: "written at the call's sessions" },
	{ joined: "written at the call's latest attempts" },
	{ joined: "written beside every attempt" },
	{ joined: "read beside every attempt" }
])

/** The outcomes in force at the call's sessions. */
const atSessions = query(Written).rule((r) => {
	const { session, attempt, variable, value } = v(inForce, "outcome")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(inForce, { session, attempt, variable, value })
		.find({ session, attempt, variable, value })
})

/**
 * The outcomes in force of the sessions a reader names, `sessions`, a relation parameter: the union of `inForce`, each
 * rule over the named sessions alone.
 */
const inForceOf = query(Written)
	.rule((r) => {
		const { session, attempt, variable, value } = v(Snapshot, "snapshot")
		return r
			.match(r.relation("sessions", sessions), { session })
			.match(Snapshot, { session, attempt, variable, value })
			.where(r.not(Assertion, { session, attempt, variable }))
			.find({ session, attempt, variable, value })
	})
	.rule((r) => {
		const { session, attempt, variable, value } = v(Assertion, "assertion")
		return r
			.match(r.relation("sessions", sessions), { session })
			.match(Assertion, { session, attempt, variable, value })
			.find({ session, attempt, variable, value })
	})

/** The latest attempt of each of the call's sessions, a fold over the call's `sittings`. */
const latestOf = query(Written).rule((r) => {
	const { session, attempt, opened } = v(Attempt, "attempt")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Attempt, { session, attempt, opened })
		.find({ session, attempt: r.max(attempt) })
})

/** The sessions of the call's latest attempts, by their key. */
const latestSessionOf = query(Written).rule((r) => {
	const latest = latestOf.bind({ sittings: r.relation("sittings", sessions) })
	const { session, attempt } = v(latest, "latest")
	return r.match(latest, { session, attempt }).find({ session })
})

/**
 * The outcomes in force of the call's latest attempts, as edullm's grade admission reads its values in force: the union
 * bound to the latest attempts' sessions (a bound import whose relation parameter is bound to another bound import of
 * the call's `sittings`), beside the latest attempts, a fold over them. Each read the call's sessions restrict.
 */
const atLatest = query(Written).rule((r) => {
	const latest = latestOf.bind({ sittings: r.relation("sittings", sessions) })
	const outcomes = inForceOf.bind({
		sessions: latestSessionOf.bind({ sittings: r.relation("sittings", sessions) })
	})
	const { session, attempt } = v(latest, "latest")
	const { variable, value } = v(outcomes, "outcome")
	return r
		.match(latest, { session, attempt })
		.match(outcomes, { session, attempt, variable, value })
		.find({ session, attempt, variable, value })
})

/** Every stored attempt's outcomes in force, each with when the attempt opened, which only Attempt holds. */
const besideAttempts = query(Written).rule((r) => {
	const { session, attempt, variable, value } = v(inForce, "outcome")
	const { opened } = v(Attempt, "attempt")
	return r
		.match(Attempt, { session, attempt, opened })
		.match(inForce, { session, attempt, variable, value })
		.find({ session, attempt, variable, value: opened })
})

/** The session the call names: the write's `sittings`. */
const named = query(Written).rule((r) => r.find({ session: r.param("session", int4) }))

/**
 * The sessions of the attempts opened at the call's value: the write's `sittings`, sessions stored rows hold, so no value
 * of the call is a session and the union is read at the key set they give it. A session the call names is a parameter
 * the region holds its column at, which each arm reads at directly (lower/optimize/propagate), no key set.
 */
const openedAt = query(Written).rule((r) => {
	const { session, attempt } = v(Attempt, "attempt")
	return r.match(Attempt, { session, attempt, opened: r.param("opened", int4) }).find({ session })
})

const reality = realityWrite(succeeded(testArtifacts(Written, testCompile)))

/** The text of each statement `write` sends. */
const writeOf = (write: unknown): ReadonlyArray<string> =>
	Arr.map(
		succeeded(compileWrite(checking(Written), descOf(write), reality), "the case's write compiles")
			.artifact.statements,
		(s) => s.spec.sql
	)

/** The text of each statement the case sends: its write's, or its read's optimized statements. */
export const statementsOf = (box: Box): ReadonlyArray<string> => {
	switch (box.joined) {
		case "written at the call's sessions":
			return writeOf(
				ChangeSet.empty(Written).insert(Recorded, atSessions).bind({ sittings: openedAt })
			)
		case "written at the call's latest attempts":
			return writeOf(ChangeSet.empty(Written).insert(Recorded, atLatest).bind({ sittings: named }))
		case "written beside every attempt":
			return writeOf(ChangeSet.empty(Written).insert(Recorded, besideAttempts))
		case "read beside every attempt":
			return Arr.map(
				succeeded(
					compileTemplate(besideAttempts, undefined, testCompile),
					"the case's read compiles"
				).optimized,
				(s) => s.sql
			)
	}
}

/** How many times `sql` scans `table` of the schema. */
export const scans = (sql: string, table: "snapshot" | "assertion" | "attempt"): number =>
	Str.split(`"union_probe_write"."${table}" AS`)(sql).length - 1
