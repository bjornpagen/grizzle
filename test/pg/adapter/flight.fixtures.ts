/** What the properties of flight.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { constant, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { CaseSpace } from "#test/support/flight/cases.ts"
import {
	type Failure,
	type FlightCase,
	type FrameName,
	frameWrites,
	type InterruptionPoint,
	type Observation,
	type Planned
} from "#test/support/flight/model.ts"
import { testSql } from "#test/support/sql.ts"

/** The kinds the server answers on demand. */
export const space: CaseSpace = { failures: ["refused", "doomed", "hold"], serverFaults: false }

/** A transaction that cannot write, a read's, answers its doomed statements' rows instead. */
export const expressible = (c: FlightCase): FlightCase => {
	const call = c.call
	if (frameWrites(call.frame)) {
		return c
	}
	const reading = (planned: Planned): Planned =>
		planned.kind === "doomed" ? { kind: "rows", label: planned.label } : planned
	return { ...c, call: { ...call, statements: Arr.map(call.statements, reading) } }
}

/** The labels of the statements whose SQL writes: each alone, and each in a transaction that can write. */
export const writing = (c: FlightCase): ReadonlySet<string> => {
	const framed = frameWrites(c.call.frame) ? c.call.statements : []
	return new Set(
		Arr.map(
			c.call.kind === "framed" ? framed : [...c.call.alone, ...framed],
			(planned) => planned.label
		)
	)
}

/** The SQL of each planned statement over the fixture's tables. */
export const sqlOver =
	(schema: string, c: FlightCase) =>
	(planned: Planned): EmittedText => {
		const table = `${schema}."t"`
		const writes = writing(c).has(planned.label)
		const label = planned.label
		switch (planned.kind) {
			case "rows":
				return testSql(
					writes
						? `INSERT INTO ${table} ("label", "ref") VALUES ('${label}', 1) RETURNING "label"`
						: `SELECT '${label}'::text AS "label"`
				)
			case "doomed":
				return testSql(
					`INSERT INTO ${table} ("label", "ref") VALUES ('${label}', -1) RETURNING "label"`
				)
			case "refused":
				return testSql(`SELECT ${schema}."refuse"('${planned.sqlstate}') AS "${label}"`)
			case "hold":
				return testSql(`SELECT '${label}'::text AS "label" FROM pg_catalog.pg_sleep(60)`)
			case "nullCell":
			case "late":
			case "stuck":
			case "fatal":
			case "lose":
				throw new Error(`the server cannot be made to answer a ${planned.kind} statement on demand`)
		}
	}

/** What a case reached on both sides: where it was interrupted, how it ended, and what the interruption did. */
export type ScriptedFeature =
	| "cancel sent"
	| "committed after an interruption"
	| `interrupted ${Exclude<InterruptionPoint, "none">}`
	| `ending ${Failure["tag"]}`
	| `call ${FlightCase["call"]["kind"]} ${FrameName}`

export const situations: Arr.NonEmptyReadonlyArray<ScriptedFeature> = [
	"call framed readCommittedWrite",
	"call alongside rollback",
	"interrupted in flight",
	"interrupted awaiting COMMIT",
	"interrupted draining",
	"cancel sent",
	"ending BatchRefused",
	"ending CommitRefused",
	"committed after an interruption"
]

/**
 * Planted: a write's flight whose COMMIT is refused, and one interrupted while it awaits a COMMIT that commits. Each is
 * a write's flight, its prologue, BEGIN and COMMIT answered.
 */
const writeFlight = (statements: ReadonlyArray<Planned>): FlightCase => ({
	call: { kind: "framed", frame: "write", prologue: { kind: "answered" }, statements },
	begin: "answered",
	commit: "answered"
})

/** The run's observation with what committed as a set: the server's table has no order. */
export const asSet = (observation: Observation): Observation => ({
	...observation,
	committed: Arr.sort(observation.committed, Order.String)
})

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const flightCases: ReadonlyArray<{
	readonly why: string
	readonly value: FlightCase
	readonly reaches: ReadonlyArray<ScriptedFeature>
}> = [
	{
		why: "a write's flight whose statement dooms its COMMIT",
		value: writeFlight([
			{ kind: "rows", label: "s0" },
			{ kind: "doomed", label: "s1" }
		]),
		reaches: ["ending CommitRefused", "interrupted awaiting COMMIT"]
	},
	{
		why: "a write's flight interrupted while it awaits a COMMIT that commits",
		value: writeFlight([{ kind: "rows", label: "s0" }]),
		reaches: ["interrupted awaiting COMMIT", "committed after an interruption"]
	},
	{
		why: "an alongside call whose end waits in its second flight for a first flight the gate holds: interrupted in its first, the client has sent fewer queries than the call's layout",
		value: {
			call: {
				kind: "alongside",
				frame: "rollback",
				alone: [{ kind: "rows", label: "a0" }],
				statements: [{ kind: "rows", label: "s0" }]
			},
			begin: "answered",
			commit: "answered"
		},
		reaches: ["call alongside rollback", "interrupted in flight"]
	}
]

/** The property's aims (flight): each kept case's value at every situation it reaches. */
export const flightAims: ReadonlyArray<readonly [Reached<ScriptedFeature>, Gen<FlightCase>]> =
	Arr.flatMap(flightCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
