/** What union-probe.test.ts reads: its schema, its box and the statements of a case's write. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * Each session's attempts, each attempt's snapshot of its variables, and the assertions that replace a snapshot's
 * value, as edullm's ledger holds them: an outcome in force is a snapshot no assertion replaced, or an assertion.
 */
const Attempt = relation("Attempt", { session: pg.integer, attempt: pg.integer }, [
	"session",
	"attempt"
])
const fields = {
	session: pg.integer,
	attempt: pg.integer,
	variable: pg.integer,
	value: pg.integer
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
const sessions = { session: pg.integer } as const

/**
 * How the write reads the outcomes in force: by the session of each of the call's sessions, or beside every session's
 * attempts, which no value of the call restricts.
 */
export type Joined = "by the call's sessions" | "beside every attempt"

export interface Box {
	readonly joined: Joined
}

export const boxGen: Gen<Box> = element<Box>([
	{ joined: "by the call's sessions" },
	{ joined: "beside every attempt" }
])

/** The member: the outcomes in force at the call's sessions, or at every stored attempt. */
const memberOf = (box: Box) =>
	query(Written).rule((r) => {
		const { session, attempt, variable, value } = v(inForce, "outcome")
		switch (box.joined) {
			case "by the call's sessions":
				return r
					.match(r.relation("sittings", sessions), { session })
					.match(inForce, { session, attempt, variable, value })
					.find({ session, attempt, variable, value })
			case "beside every attempt":
				return r
					.match(Attempt, { session, attempt })
					.match(inForce, { session, attempt, variable, value })
					.find({ session, attempt, variable, value })
		}
	})

/** The session the call names: the write's `sittings`. */
const named = query(Written).rule((r) => r.find({ session: r.param("session", pg.integer) }))

const reality = realityWrite(succeeded(testArtifacts(Written, testCompile)))

/** The case's write: the member recorded, its sittings bound to the call's `session` where it reads them. */
const changesOf = (box: Box) => {
	const write = ChangeSet.empty(Written).insert(Recorded, memberOf(box))
	switch (box.joined) {
		case "by the call's sessions":
			return write.bind({ sittings: named })
		case "beside every attempt":
			return write
	}
}

/** The text of each statement the case's write sends. */
export const statementsOf = (box: Box): ReadonlyArray<string> =>
	Arr.map(
		succeeded(
			compileWrite(checking(Written), descOf(changesOf(box)), reality),
			"the case's write compiles"
		).artifact.statements,
		(s) => s.spec.sql
	)

/** How many times `sql` scans `table` of the schema. */
export const scans = (sql: string, table: "snapshot" | "assertion" | "attempt"): number =>
	Str.split(`"union_probe_write"."${table}" AS`)(sql).length - 1
