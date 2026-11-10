import { Array as Arr } from "effect"
import type { FenceStep } from "#adapter/wire/batch.ts"
import { type Driven, drive, type Timing } from "#test/support/flight/drive.ts"
import {
	beginRefusal,
	callOf,
	expected,
	type Failure,
	type FlightCase,
	fatalStates,
	fenceRefusal,
	flightPrologue,
	type Interruption,
	type Observation,
	observed,
	type Planned,
	plannedOf,
	prologueRefusal,
	type SqlOf,
	type StepAnswer,
	stepAnswer,
	type Value
} from "#test/support/flight/model.ts"

import {
	refusedAnswer,
	rows,
	type ScriptedSession,
	sentSql,
	type StatementAnswer,
	scriptedSession
} from "#test/support/flight/scripted.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/** What a planned statement answers on the scripted server: its label is its one row. */
const answerOf = (planned: Planned): StatementAnswer => {
	switch (planned.kind) {
		case "rows":
			return rows([[planned.label]])
		case "doomed":
			return { _tag: "doomed", rows: [[planned.label]] }
		case "refused":
			return refusedAnswer(planned.sqlstate)
		case "fatal":
			return {
				_tag: "fatal",
				error: serverError({ ...nothingReported, sqlstate: planned.sqlstate })
			}
		case "nullCell":
		case "hold":
		case "late":
		case "stuck":
		case "lose":
			return { _tag: planned.kind }
	}
}

/** The planned statement of each SQL text the case sends. */
export const plannedBySql = (c: FlightCase, sqlOf: SqlOf): ReadonlyMap<string, Planned> =>
	new Map(Arr.map(plannedOf(c.call), (planned) => [sqlOf(planned), planned]))

/**
 * What a prologue step answers on the scripted server, the lock or the guard's statement: the lock no row, the guard's
 * one row when it takes on the role.
 */
const prologueAnswerOf = (step: FenceStep, answer: StepAnswer): StatementAnswer => {
	switch (answer) {
		case "answered":
			return step === "lock" ? rows([]) : rows([["", flightPrologue.role, flightPrologue.claims]])
		case "refused":
			return refusedAnswer(prologueRefusal)
		case "migrating":
		case "migrated":
			return refusedAnswer(fenceRefusal(step, answer))
		case "fatal":
			return { _tag: "fatal", error: serverError({ ...nothingReported, sqlstate: fatalStates[0] }) }
		case "lost":
			return { _tag: "lose" }
	}
}

/**
 * A stepped scripted session that answers the case: each statement as its plan says, and the prologue's two
 * statements, whose SQL none of the case's has, as the case's prologue answer says; past a cancelled statement, the
 * server runs `afterCancel` queries before a destroyed connection's end reaches it.
 */
const sessionOf = (c: FlightCase, sqlOf: SqlOf, afterCancel: number): ScriptedSession => {
	const bySql = plannedBySql(c, sqlOf)
	const call = c.call
	return scriptedSession(
		{
			statement: (query) => {
				const sql = sentSql(query)
				const planned = bySql.get(sql)
				if (planned !== undefined) {
					return answerOf(planned)
				}
				if (call.kind === "framed" && sql === flightPrologue.fence.text.sql) {
					return prologueAnswerOf("lock", stepAnswer(call.prologue, "lock"))
				}
				if (call.kind === "framed" && sql === flightPrologue.enter.text.sql) {
					return prologueAnswerOf("guard", stepAnswer(call.prologue, "guard"))
				}
				throw new Error(`the case sends no statement ${sql}`)
			},
			begin: () =>
				c.begin === "refused"
					? serverError({ ...nothingReported, sqlstate: beginRefusal })
					: undefined,
			commit: () => (c.commit === "lost" ? "lose" : undefined)
		},
		{ delivery: "stepped", afterCancel }
	)
}

export interface ScriptedRun {
	readonly session: ScriptedSession
	readonly driven: Driven<Value, Failure>
}

/**
 * One run of a flight case on a scripted session (scripted.ts), driven at a timing (drive.ts), and what it observed.
 */
export const runScripted = (c: FlightCase, timing: Timing, sqlOf: SqlOf): ScriptedRun => {
	const session = sessionOf(c, sqlOf, timing.afterCancel)
	return {
		session,
		driven: drive(session, callOf(session, c.call, sqlOf, flightPrologue), timing)
	}
}

/**
 * The run's observation and the model's prediction of it, or undefined for a run that blocked without an
 * interruption. `labelOf` reads a committed statement's SQL back as its label. The prologue enters a role and writes
 * nothing, so what the run committed is the case's statements, as the model states it.
 */
export const observationsOf = (
	c: FlightCase,
	run: ScriptedRun,
	labelOf: (sql: string) => string
):
	| {
			readonly model: Observation
			readonly run: Observation
			readonly interruption: Interruption
	  }
	| undefined => {
	const driven = run.driven
	if (driven.kind === "blocked") {
		return undefined
	}
	const session = run.session
	const interruption = { at: driven.interruptedAt }
	const flight = session.flights()[0]
	return {
		model: expected(c, flight?.delivered ?? [], flight?.made ?? [], interruption),
		run: observed(
			driven.exit,
			Arr.map(
				Arr.filter(
					session.committed(),
					(sql) => sql !== flightPrologue.fence.text.sql && sql !== flightPrologue.enter.text.sql
				),
				labelOf
			),
			session.state() !== "open",
			session.cancels()
		),
		interruption
	}
}
