/** What the properties of two-flights.test.ts read: its spaces, models and helpers. */

import { constant, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Data } from "effect"
import { type PreparedStatement, preparedStatement } from "#adapter/wire/batch.ts"
import { prepared } from "#compiler/core/prepared.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { testSql } from "#test/support/sql.ts"

/** The failure a case's making of its writes fails with. */
export class WritesUnmade extends Data.TaggedError("WritesUnmade")<{ readonly writes: number }> {}

type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "read"; readonly at: number }
	| { readonly kind: "write"; readonly at: number }
	| { readonly kind: "making" }
	| { readonly kind: "commit" }

interface TwoFlights {
	readonly reads: number
	readonly writes: number
	readonly fault: Fault
}

export const readSql = (at: number): string => `select ${at} as read`

export const writeSql = (at: number): string => `select ${at} as write`

/** A read of the first flight, its text named as a write's family reads are (apply/run.ts runWrite). */
export const read = (sql: string): PreparedStatement =>
	preparedStatement(prepared(testSql(sql)), [])

/** A write of the second flight, a served write's statement, its text named. */
export const write = (sql: string): PreparedStatement =>
	preparedStatement(prepared(testSql(sql)), [])

/** Every fault a case of these counts can carry: none, a read or a write refused, the making, COMMIT. */
const faultOf = (reads: number, writes: number): Gen<Fault> =>
	oneOf<Fault>([
		constant({ kind: "none" }),
		map(int(0, reads - 1), (at): Fault => ({ kind: "read", at })),
		...(writes > 0 ? [map(int(0, writes - 1), (at): Fault => ({ kind: "write", at }))] : []),
		constant({ kind: "making" }),
		constant({ kind: "commit" })
	])

/** The box: one or two reads, zero to two writes, and every fault the counts can carry. */
export const twoFlights: Gen<TwoFlights> = (source) => {
	const reads = source.draw(int(1, 2))
	const writes = source.draw(int(0, 2))
	return { reads, writes, fault: source.draw(faultOf(reads, writes)) }
}

export type Situation = Fault["kind"] | "no write" | "two reads"

/** What the contract says a case ends as (see the header). */
type Verdict =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly index: number }
	| { readonly kind: "unmade" }
	| { readonly kind: "commitRefused" }

export const expected = (c: TwoFlights): Verdict => {
	switch (c.fault.kind) {
		case "none":
			return { kind: "committed" }
		case "read":
			return { kind: "refused", index: c.fault.at }
		case "write":
			return { kind: "refused", index: c.reads + c.fault.at }
		case "making":
			return { kind: "unmade" }
		case "commit":
			return { kind: "commitRefused" }
	}
}

export const serialization = Object.freeze(serverError({ ...nothingReported, sqlstate: "40001" }))

/** The statement a case's server refuses, none for a fault no statement's. */
export const refusedSql = (fault: Fault): string | undefined => {
	switch (fault.kind) {
		case "read":
			return readSql(fault.at)
		case "write":
			return writeSql(fault.at)
		case "none":
		case "making":
		case "commit":
			return undefined
	}
}
