import { failureText } from "@bjornpagen/testing/failure"
import { Array as Arr } from "effect"
import { Cause, Effect, Exit, Option, Result } from "effect"
import type { ConnectionLost, DriverFailure, TransactionFate } from "#adapter/errors/failures.ts"
import {
	type Alongside,
	type BatchOutcome,
	type BatchStatement,
	type FenceStep,
	type FlightFailure,
	type Frame,
	enterOf,
	excludesNothing,
	oneShotStatement,
	type Prologue,
	preparedStatement,
	prologueOf,
	readFrame,
	runAlongside,
	runFramed,
	type Transaction,
	type Uncommitting,
	writeFrame
} from "#adapter/wire/batch.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type { Interruption } from "#test/support/flight/drive.ts"
import type { PgStatement } from "#test/support/pg.ts"
import { textsOfParams } from "#test/support/wire.ts"

import { type Answer, controlText, type WireQuery, type Session } from "#adapter/wire/session.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { prepared } from "#compiler/core/prepared.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import {
	headTable,
	type LedgerStatements,
	ledgerStatements,
	ledgerTable
} from "#compiler/deploy/ledger/ledger.ts"
import { servedSession } from "#compiler/program/served.ts"

import {
	digestDomainDdl,
	ledgerTableName,
	snapshotGuardDdl,
	snapshotGuardName
} from "#compiler/physical/ddl/ledger.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import { emit, costChosen } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import {
	type Delivered,
	type Rows,
	type SentFlight,
	sentSql
} from "#test/support/flight/scripted.ts"

/** What a statement does on the server (scripted.ts): its label is its identity in the case. */
export type Planned =
	| {
			readonly kind: "rows" | "doomed" | "nullCell" | "hold" | "late" | "stuck" | "lose"
			readonly label: string
	  }
	| { readonly kind: "refused" | "fatal"; readonly label: string; readonly sqlstate: string }

export type StatementKind = Planned["kind"]

/**
 * The schema whose ledger a framed call's prologue fences on: the server check installs the ledger and its snapshot
 * guard there, with one complete folder whose target is `flightSnapshot`.
 */
const flightSchema = "grizzle_flight"

/** A digest's hex as the ledger's digest columns take it (physical/ddl/ledger.ts digestOfHex): the SHA-256 of `text`. */
const digestHexOf = (text: string): string => sha256Hex(new TextEncoder().encode(text))

/** The snapshot every framed call's Db was admitted at: a fingerprint, as the ledger's target column holds one. */
const flightSnapshot = SchemaFingerprint(digestHexOf("flight-snapshot"))

/**
 * The frames a call is sent in: a read; every write at SERIALIZABLE; a change of a role generate certified READ
 * COMMITTED; and an EXPLAIN, which rolls back; each as the call's role.
 */
const frameNames = ["read", "write", "readCommittedWrite", "rollback"] as const
export type FrameName = (typeof frameNames)[number]

/** The frames statements alone run in front of: those that commit nothing (wire/batch.ts Uncommitting). */
export type AlongsideFrame = Exclude<FrameName, "write" | "readCommittedWrite">

/** The transaction of each frame statements alone run in front of. */
const alongsideTransactions: { readonly [F in AlongsideFrame]: Uncommitting } = {
	read: { access: "readOnly", end: "COMMIT" },
	rollback: { access: "readWrite", isolation: "serializable", end: "ROLLBACK" }
}

const frameOf = (name: FrameName, prologue: Prologue): Frame => {
	switch (name) {
		case "read":
			return readFrame(prologue, noAdvice)
		case "write":
			return writeFrame(prologue, "serializable", excludesNothing, noAdvice)
		case "readCommittedWrite":
			return writeFrame(prologue, "readCommitted", excludesNothing, noAdvice)
		case "rollback":
			return {
				access: "readWrite",
				isolation: "serializable",
				end: "ROLLBACK",
				prologue,
				exclusion: excludesNothing,
				advice: noAdvice
			}
	}
}

/**
 * The statements that install a framed call's fence in `schema`, run by the server check's administrator: the digest
 * domain the ledger's digest columns are typed by, the ledger, its head and the snapshot guard, as an installation's
 * Setup creates them (physical/ddl/ledger.ts digestDomainDdl, deploy/ledger/ledger.ts); one complete folder of no file
 * whose target is `flightSnapshot`, recorded by the apply runner's own statements (ledgerStatements recordFolder,
 * recordHead); and what `grantee`,
 * the role the checked sessions log in as, needs to take the fence: USAGE on the schema, SELECT on the ledger and
 * EXECUTE on the guard.
 */
export const fenceSql = (schema: string, grantee: string): ReadonlyArray<PgStatement> => {
	const [guard, revoke] = snapshotGuardDdl(schema)
	const text = (statement: SqlStatement): string => {
		const e = emit(statement, emptyNameMap, costChosen)
		if (!e.ok) {
			throw new Error(`the fence's DDL: ${e.error.message}`)
		}
		return e.value.text
	}
	const statements = ledgerStatements(schema)
	if (!statements.ok) {
		throw new Error(`the ledger statements of ${schema}: ${statements.error.message}`)
	}
	const ledger = `${quoteIdent(schema)}.${quoteIdent(ledgerTableName)}`
	const role = quoteIdent(grantee)
	const alone = (sql: string): PgStatement => ({ sql, params: [] })
	return [
		alone(text(digestDomainDdl(schema))),
		alone(text(ledgerTable(schema))),
		alone(text(headTable(schema))),
		alone(text(guard)),
		alone(text(revoke)),
		{
			sql: statements.value.recordFolder.text,
			params: [
				"20261023000000_flight",
				digestHexOf("flight-source"),
				flightSnapshot,
				0,
				digestHexOf("flight")
			]
		},
		{
			sql: statements.value.recordHead.text,
			params: ["20261023000000_flight", flightSnapshot, 0, 0]
		},
		alone(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${role}`),
		alone(`GRANT SELECT ON ${ledger} TO ${role}`),
		alone(
			`GRANT EXECUTE ON FUNCTION ${quoteIdent(schema)}.${quoteIdent(snapshotGuardName)}(text) TO ${role}`
		)
	]
}

/**
 * The prologue of a Db of `role` with `claims` at `snapshot` over a schema's ledger statements, as a layer builds it
 * (pool/registry.ts).
 */
export const ledgerPrologue = (
	ledger: Pick<LedgerStatements, "fence" | "enter">,
	role: string,
	claims: string,
	snapshot: SchemaFingerprint
): Prologue =>
	prologueOf(
		{ fence: prepared(ledger.fence.text), enter: prepared(ledger.enter.text) },
		role,
		claims,
		snapshot
	)

/** The prologue of a framed call over the fence `fenceSql` installs in `schema`. */
export const prologueIn = (schema: string): Prologue => {
	const ledger = ledgerStatements(schema)
	if (!ledger.ok) {
		throw new Error(`the ledger statements of ${schema}: ${ledger.error.message}`)
	}
	return ledgerPrologue(ledger.value, "none", "", flightSnapshot)
}

/**
 * The prologue of every scripted framed call: the fence on `flightSchema`'s ledger at `flightSnapshot`, then the role
 * `none`, which every session may take on, so the server check's raw session runs the real prologue as itself, over
 * the fence it installs in its own schema (prologueIn); no claims.
 */
export const flightPrologue: Prologue = prologueIn(flightSchema)

/** The frames of the scripted framed calls, behind flightPrologue. */
const frames: { readonly [F in FrameName]: Frame } = {
	read: frameOf("read", flightPrologue),
	write: frameOf("write", flightPrologue),
	readCommittedWrite: frameOf("readCommittedWrite", flightPrologue),
	rollback: frameOf("rollback", flightPrologue)
}

/** Whether a frame's transaction can write: its access as the frame begins it, a read's read only. */
export const frameWrites = (name: FrameName): boolean => frames[name].access === "readWrite"

/**
 * How a step of the prologue fails: refused for a reason of no fence's, the fence's refusal (the lock's 55P03 or the
 * guard's 55Z02, a migration running; the guard's 55Z01, another snapshot), FATAL, or the connection lost.
 */
export type PrologueFault = "refused" | FenceFault | "fatal" | "lost"

/** The fence's refusal, as the model names it: a migration running or stopped part-way, or another snapshot. */
type FenceFault = "migrating" | "migrated"

/** What the server answers the prologue: both its steps answer, or the first that does not fails as its fault says. */
export type PrologueAnswer =
	| { readonly kind: "answered" }
	| { readonly kind: "fault"; readonly step: FenceStep; readonly fault: PrologueFault }

/** What one step of the prologue answers under `answer`: a step after the one that faults never runs. */
export type StepAnswer = "answered" | PrologueFault

export const stepAnswer = (answer: PrologueAnswer, step: FenceStep): StepAnswer =>
	answer.kind === "fault" && answer.step === step ? answer.fault : "answered"

/** The SQL text a case sends for each of its planned statements. */
export type SqlOf = (planned: Planned) => EmittedText

export type Call =
	| {
			readonly kind: "framed"
			readonly frame: FrameName
			readonly prologue: PrologueAnswer
			readonly statements: ReadonlyArray<Planned>
	  }
	| {
			readonly kind: "alongside"
			readonly frame: AlongsideFrame
			readonly alone: Arr.NonEmptyReadonlyArray<Planned>
			readonly statements: ReadonlyArray<Planned>
	  }

export interface FlightCase {
	readonly call: Call
	readonly begin: "answered" | "refused"
	/** COMMIT answers, or the connection is lost before it runs. */
	readonly commit: "answered" | "lost"
}

/** Every statement of a call, in the order the flight sends them. */
export const plannedOf = (call: Call): ReadonlyArray<Planned> =>
	call.kind === "framed" ? call.statements : [...call.alone, ...call.statements]

/** What one query of the flight is. */
export type Slot =
	| { readonly role: "alone"; readonly planned: Planned }
	| { readonly role: "begin" }
	| { readonly role: "prologue"; readonly step: FenceStep; readonly answer: StepAnswer }
	| { readonly role: "statement"; readonly planned: Planned }
	| { readonly role: "end" }

/**
 * The queries the call sends, in order: a framed call with no statement still sends its frame, BEGIN, the prologue and
 * the end, so it meets the fence.
 */
export const layoutOf = (call: Call): Arr.NonEmptyReadonlyArray<Slot> => {
	const statements = Arr.map(call.statements, (planned): Slot => ({ role: "statement", planned }))
	if (call.kind === "alongside") {
		return Arr.appendAll(
			Arr.map(call.alone, (planned): Slot => ({ role: "alone", planned })),
			[{ role: "begin" } satisfies Slot, ...statements, { role: "end" } satisfies Slot]
		)
	}
	return [
		{ role: "begin" },
		{ role: "prologue", step: "lock", answer: stepAnswer(call.prologue, "lock") },
		{ role: "prologue", step: "guard", answer: stepAnswer(call.prologue, "guard") },
		...statements,
		{ role: "end" }
	]
}

/**
 * BEGIN as PostgreSQL reads it for `frame`: a read SERIALIZABLE READ ONLY, a write at its level.
 */
const beginText = (frame: Transaction): string => {
	if (frame.access === "readOnly") {
		return "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"
	}
	switch (frame.isolation) {
		case "serializable":
			return "BEGIN ISOLATION LEVEL SERIALIZABLE"
		case "readCommitted":
			return "BEGIN ISOLATION LEVEL READ COMMITTED"
	}
}

/**
 * How the flight frames a call, query by query: BEGIN's and the end's texts and each statement's SQL exactly, and the
 * prologue by what it sets, the call role's name and claims, as its parameters; its text is the adapter's.
 */
export type Framed =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "prologue"; readonly params: ReadonlyArray<string> }

/** One query of a flight in `frame` as framingOf states it. */
const framedSlot = (frame: Transaction, slot: Slot, sqlOf: SqlOf): Framed => {
	switch (slot.role) {
		case "begin":
			return { kind: "text", text: beginText(frame) }
		case "prologue":
			return {
				kind: "prologue",
				params: textsOfParams(
					slot.step === "lock" ? flightPrologue.fence.params : enterOf(frames.read).params
				)
			}
		case "end":
			return { kind: "text", text: frame.end }
		case "alone":
		case "statement":
			return { kind: "text", text: sqlOf(slot.planned) }
	}
}

/**
 * Each flight of a call as framingOf states it, by whether it sends its transaction's end (sendsEnd): a framed call's
 * one flight; statements alone in front of a transaction (runAlongside) send theirs and the transaction's BEGIN and
 * statements in a first flight, and its end in a second where it sends it.
 */
export const framingOf = (
	call: Call,
	sqlOf: SqlOf,
	endSent: boolean
): ReadonlyArray<ReadonlyArray<Framed>> => {
	const frame = frames[call.frame]
	const framed = Arr.map(layoutOf(call), (slot) => framedSlot(frame, slot, sqlOf))
	if (call.kind === "framed") {
		return [framed]
	}
	const opening = framed.slice(0, -1)
	return endSent ? [opening, framed.slice(-1)] : [opening]
}

/**
 * Whether an alongside call sends its transaction's end, from its first flight's answers once it has drained, as
 * runAlongside decides it: where the transaction stands open, BEGIN having run and the connection standing, no query of
 * the first flight having failed or ended the session; never where BEGIN did not run, or the first flight ended the
 * session, whose connection's end ended the transaction, since an ended session sends nothing.
 */
const sendsEnd = (
	call: Extract<Call, { readonly kind: "alongside" }>,
	first: ReadonlyArray<Delivered | undefined>
): boolean => {
	/** BEGIN follows the statements alone (layoutOf). */
	const begun = first[call.alone.length]?.answer._tag
	return (
		(begun === "result" || begun === "unreadable") &&
		!Arr.some(first, (d) => d?.answer._tag === "failed" || d?.answer._tag === "terminated")
	)
}

/**
 * The end of a transaction a call never sent (sendsEnd): the answer its second flight would have carried, which no
 * server made, read as the lost connection's, and delivered after every answer, so an interruption came before it.
 */
const unsentEnd: Delivered = { answer: { _tag: "failed" }, ordinal: Number.POSITIVE_INFINITY }

/**
 * A call's answers by its layout's positions (layoutOf) over every flight it sent, and whether it sends its
 * transaction's end, as the model decides it: a framed call's one flight's, its end among them; an alongside call's
 * first flight's, then, where it sends its end (sendsEnd), its second's one answer, the end's, and otherwise the end
 * unsent (unsentEnd), which the server never made.
 */
export const callAnswers = (
	call: Call,
	flights: ReadonlyArray<SentFlight>
): {
	readonly delivered: ReadonlyArray<Delivered | undefined>
	readonly made: ReadonlyArray<Answer | undefined>
	readonly endSent: boolean
} => {
	const [first, second] = flights
	if (call.kind === "framed" || first === undefined) {
		return { delivered: first?.delivered ?? [], made: first?.made ?? [], endSent: true }
	}
	const endSent = sendsEnd(call, first.delivered)
	return endSent && second !== undefined
		? {
				delivered: [...first.delivered, ...second.delivered],
				made: [...first.made, ...second.made],
				endSent
			}
		: {
				delivered: [...first.delivered, unsentEnd],
				made: [...first.made, undefined],
				endSent
			}
}

/**
 * A sent query as framingOf states it: a control's text, a statement's SQL, and the prologue's two statements, whose
 * SQL none of the call's statements has, by their parameters.
 */
export const framedOf =
	(call: Call, sqlOf: SqlOf): ((query: WireQuery) => Framed) =>
	(query: WireQuery): Framed => {
		if (query._tag === "control") {
			return { kind: "text", text: controlText(servedSession, query.control) }
		}
		const sql = sentSql(query)
		const known = Arr.some(plannedOf(call), (planned) => sqlOf(planned) === sql)
		return known
			? { kind: "text", text: sql }
			: { kind: "prologue", params: textsOfParams(query.params) }
	}

/** A failure of the wire as plain data, compared structurally. */
export type Failure =
	| {
			readonly tag: "BatchRefused" | "StaleName"
			readonly index: number
			readonly sqlstate: string
	  }
	| { readonly tag: "CommitRefused" | "PrologueRefused"; readonly sqlstate: string }
	| { readonly tag: "StaleSnapshot"; readonly reason: FenceFault; readonly sqlstate: string }
	| { readonly tag: "AdviceUnloaded" }
	| { readonly tag: "CommitLost" }
	| { readonly tag: "ConnectionLost"; readonly operation: string; readonly sqlstate: string | null }
	| { readonly tag: "DriverFailure"; readonly operation: string }
	| { readonly tag: "UnreadableAnswer"; readonly index: number; readonly fate: TransactionFate }
	| { readonly tag: "InputTooLarge"; readonly statement: number; readonly bytes: number }

export type AloneResult =
	| { readonly kind: "rows"; readonly rows: Rows }
	| { readonly kind: "refused"; readonly sqlstate: string }

export type FramedResult =
	| { readonly kind: "outcomes"; readonly rows: ReadonlyArray<Rows> }
	| { readonly kind: "failure"; readonly failure: Failure }

export type Value =
	| { readonly kind: "outcomes"; readonly rows: ReadonlyArray<Rows> }
	| {
			readonly kind: "alongside"
			readonly alone: ReadonlyArray<AloneResult>
			readonly framed: FramedResult
	  }

export type Ending =
	| { readonly kind: "value"; readonly value: Value }
	| { readonly kind: "failure"; readonly failure: Failure }
	| { readonly kind: "interrupted" }

const failureData = (failure: FlightFailure | ConnectionLost | DriverFailure): Failure => {
	switch (failure._tag) {
		case "BatchRefused":
			return { tag: failure._tag, index: failure.index, sqlstate: failure.failure.sqlstate }
		case "CommitRefused":
		case "PrologueRefused":
			return { tag: failure._tag, sqlstate: failure.failure.sqlstate }
		case "StaleSnapshot":
			return {
				tag: failure._tag,
				reason: failure.reason._tag === "Migrating" ? "migrating" : "migrated",
				sqlstate: failure.error.sqlstate
			}
		case "AdviceUnloaded":
			return { tag: "AdviceUnloaded" }
		case "CommitLost":
			return { tag: "CommitLost" }
		case "ConnectionLost":
			return {
				tag: "ConnectionLost",
				operation: failure.operation,
				sqlstate: failure.ended.by === "server" ? failure.ended.error.sqlstate : null
			}
		case "DriverFailure":
			return { tag: "DriverFailure", operation: failure.operation }
		case "UnreadableAnswer":
			return { tag: "UnreadableAnswer", index: failure.index, fate: failure.fate }
		case "InputTooLarge": {
			const bound = failure.bound
			return bound.kind === "message"
				? { tag: "InputTooLarge", statement: bound.statement, bytes: bound.bytes }
				: { tag: "InputTooLarge", statement: -1, bytes: -1 }
		}
	}
}

const outcomeRows = (outcomes: ReadonlyArray<BatchOutcome>): ReadonlyArray<Rows> =>
	Arr.map(outcomes, (o) => o.rows)

const alongsideValue = (ran: Alongside<undefined, never>): Value => {
	/** The transaction's outcomes over its two flights: the first's, then the second's, which carries its end alone. */
	const framed = Result.flatMap(ran.framed, (opened) =>
		Result.flatMap(opened.made, (made) =>
			Result.map(made.second, (second) => [...opened.first, ...second])
		)
	)
	return {
		kind: "alongside",
		alone: Arr.map(ran.alone, (r): AloneResult =>
			Result.isSuccess(r)
				? { kind: "rows", rows: r.success.rows }
				: { kind: "refused", sqlstate: r.failure.sqlstate }
		),
		framed: Result.isSuccess(framed)
			? { kind: "outcomes", rows: outcomeRows(framed.success) }
			: { kind: "failure", failure: failureData(framed.failure) }
	}
}

/**
 * The call on `session`, a framed one behind `prologue`, its value and failure as plain data. A framed call is a Db's,
 * whose statements a served login sends named; statements alongside a transaction are admission's, sent one-shot.
 */
export const callOf = (
	session: Session,
	call: Call,
	sqlOf: SqlOf,
	prologue: Prologue
): Effect.Effect<Value, Failure> => {
	const frame = frameOf(call.frame, prologue)
	const served = (planned: Planned): BatchStatement =>
		preparedStatement(prepared(sqlOf(planned)), [])
	const oneShot = (planned: Planned): BatchStatement => oneShotStatement(sqlOf(planned), [])
	if (call.kind === "framed") {
		return Effect.mapBoth(runFramed(session, frame, Arr.map(call.statements, served)), {
			onSuccess: (outcomes): Value => ({ kind: "outcomes", rows: outcomeRows(outcomes) }),
			onFailure: failureData
		})
	}
	return Effect.mapBoth(
		runAlongside(
			session,
			Arr.map(call.alone, oneShot),
			Arr.map(call.statements, oneShot),
			() => Result.succeed({ statements: [], value: undefined }),
			alongsideTransactions[call.frame]
		),
		{
			onSuccess: alongsideValue,
			onFailure: failureData
		}
	)
}

/** The ending an exit reports: its value, its failure, or the interruption alone. */
const endingOf = (exit: Exit.Exit<Value, Failure>): Ending => {
	if (Exit.isSuccess(exit)) {
		return { kind: "value", value: exit.value }
	}
	const cause = exit.cause
	const failure = Cause.findErrorOption(cause)
	if (Option.isSome(failure)) {
		return { kind: "failure", failure: failure.value }
	}
	if (Cause.hasInterrupts(cause)) {
		return { kind: "interrupted" }
	}
	throw new Error(`the call died: ${failureText(cause)}`)
}

/** What a call left behind, as the model predicts it and as a run observes it. */
export interface Observation {
	readonly ending: Ending
	/** The labels of the statements that committed, in commit order. */
	readonly committed: ReadonlyArray<string>
	readonly retired: boolean
	readonly cancelled: boolean
}

interface Judged {
	readonly ending: Exclude<Ending, { readonly kind: "interrupted" }>
	readonly retired: boolean
}

const fails = (failure: Failure, retired: boolean): Judged => ({
	ending: { kind: "failure", failure },
	retired
})

const succeeds = (value: Value): Judged => ({ ending: { kind: "value", value }, retired: false })

/**
 * A statement alone: its result, its unreadable rows (it committed at its own Sync), its refusal, or a session the
 * server or the transport ended.
 */
const judgeAlone = (answer: Answer): Judged => {
	switch (answer._tag) {
		case "result":
			return succeeds({ kind: "outcomes", rows: [answer.outcome.rows] })
		case "unreadable":
			return fails({ tag: "UnreadableAnswer", index: 0, fate: "committed" }, false)
		case "refused":
			return fails({ tag: "BatchRefused", index: 0, sqlstate: answer.error.sqlstate }, false)
		case "terminated":
			return fails(
				{ tag: "ConnectionLost", operation: "query", sqlstate: answer.error.sqlstate },
				true
			)
		case "failed":
			return fails({ tag: "ConnectionLost", operation: "query", sqlstate: null }, true)
	}
}

/**
 * What a transaction did, from BEGIN's, its statements' and its end's answers: BEGIN refused, so none ran; a statement
 * refused, so it aborted; its end's answer once every statement ran, readably or not; unknown once an answer that would
 * say failed to come.
 */
const fateOf = (begin: Answer, statements: ReadonlyArray<Answer>, end: Answer): TransactionFate => {
	switch (begin._tag) {
		case "refused":
		case "terminated":
			return "noTransaction"
		case "failed":
			return "unknown"
		case "result":
		case "unreadable":
			break
	}
	for (const answer of statements) {
		switch (answer._tag) {
			case "refused":
			case "terminated":
				return "aborted"
			case "failed":
				return "unknown"
			case "result":
			case "unreadable":
				break
		}
	}
	switch (end._tag) {
		case "result":
			return end.outcome.command === "COMMIT" ? "committed" : "rolledBack"
		case "unreadable":
			return end.command === "COMMIT" ? "committed" : "rolledBack"
		case "refused":
			return "rolledBack"
		case "terminated":
		case "failed":
			return "unknown"
	}
}

/**
 * Why the fence refused a prologue step, by the SQLSTATE it answered: the lock's 55P03 and the guard's 55Z02, a
 * migration running; the guard's 55Z01, another snapshot; undefined for any other refusal, and for a fenced write's
 * lock, which no fence refuses (docs/operations.md "Deploying").
 */
const fenceOf = (step: FenceStep, sqlstate: string): FenceFault | undefined => {
	switch (step) {
		case "lock":
			return sqlstate === lockNotAvailable ? "migrating" : undefined
		case "exclude":
			return undefined
		case "guard":
			return sqlstate === guardMigrating
				? "migrating"
				: sqlstate === guardMigrated
					? "migrated"
					: undefined
	}
}

/**
 * A transaction from BEGIN's, its prologue's (none for the login's), its statements' and its end's answers: the first
 * query answered neither with a result nor with an unreadable one decides; once none did, a statement's unreadable rows
 * are UnreadableAnswer at the first.
 */
const judgeTransaction = (
	begin: Answer,
	prologue: ReadonlyArray<{ readonly step: FenceStep; readonly answer: Answer }>,
	statements: ReadonlyArray<Answer>,
	end: Answer,
	frame: Transaction,
	endSent: boolean
): { readonly result: FramedResult; readonly retired: boolean } => {
	/** A transaction whose end its call never sent, the connection lost before it, commits nothing. */
	const commits = frame.end === "COMMIT" && endSent
	const failure = (f: Failure, retired: boolean) => ({
		result: { kind: "failure", failure: f } as const,
		retired
	})
	const lostQuery = (sqlstate: string | null) =>
		failure({ tag: "ConnectionLost", operation: "query", sqlstate }, true)
	const lost = () => (commits ? failure({ tag: "CommitLost" }, true) : lostQuery(null))
	switch (begin._tag) {
		case "result":
		case "unreadable":
			break
		case "refused":
			return failure(
				{ tag: "ConnectionLost", operation: "begin", sqlstate: begin.error.sqlstate },
				true
			)
		case "terminated":
			return lostQuery(begin.error.sqlstate)
		case "failed":
			return lost()
	}
	for (const { step, answer } of prologue) {
		switch (answer._tag) {
			case "result":
			case "unreadable":
				continue
			case "refused": {
				const sqlstate = answer.error.sqlstate
				const reason = fenceOf(step, sqlstate)
				return failure(
					reason === undefined
						? { tag: "PrologueRefused", sqlstate }
						: { tag: "StaleSnapshot", reason, sqlstate },
					false
				)
			}
			case "terminated":
				return lostQuery(answer.error.sqlstate)
			case "failed":
				return lost()
		}
	}
	const rows: Array<Rows> = []
	/** The statements that ran and answered rows the client cannot read, in order. */
	const unreadable: Array<number> = []
	for (const [index, answer] of statements.entries()) {
		switch (answer._tag) {
			case "result":
				rows.push(answer.outcome.rows)
				break
			case "unreadable":
				unreadable.push(index)
				break
			case "refused":
				return failure({ tag: "BatchRefused", index, sqlstate: answer.error.sqlstate }, false)
			case "terminated":
				return lostQuery(answer.error.sqlstate)
			case "failed":
				return lost()
		}
	}
	/** Nothing decided: the statements' rows, or the first unreadable statement with what the transaction did. */
	const undecided = () => {
		const [first] = unreadable
		return first === undefined
			? { result: { kind: "outcomes", rows } as const, retired: false }
			: failure(
					{ tag: "UnreadableAnswer", index: first, fate: fateOf(begin, statements, end) },
					false
				)
	}
	switch (end._tag) {
		case "result":
			return !commits || end.outcome.command === "COMMIT"
				? undecided()
				: failure({ tag: "CommitLost" }, true)
		case "unreadable":
			return commits ? failure({ tag: "CommitLost" }, true) : undecided()
		case "refused":
			return commits
				? failure({ tag: "CommitRefused", sqlstate: end.error.sqlstate }, false)
				: failure({ tag: "DriverFailure", operation: "rollback" }, true)
		case "terminated":
			return commits ? failure({ tag: "CommitLost" }, true) : lostQuery(end.error.sqlstate)
		case "failed":
			return lost()
	}
}

/**
 * Where an interruption came: none, or before the completed call; while a statement the call waits for was in flight
 * (a statement alone, a transaction's last statement or BEGIN when it has none, or for statements alone in front of
 * a transaction, both its flights, or its first alone where that decided the call); while a write awaited COMMIT's
 * answer, every statement answered; or while the flight drained after a refusal decided it.
 */
export type InterruptionPoint = "none" | "in flight" | "awaiting COMMIT" | "draining"

export const interruptionPoint = (
	call: Call,
	delivered: ReadonlyArray<Delivered | undefined>,
	interruption: Interruption
): InterruptionPoint => {
	const at = interruption.at
	if (at === undefined) {
		return "none"
	}
	const layout = layoutOf(call)
	const beginAt = Arr.findFirstIndex(layout, (slot) => slot.role === "begin")
	const endAt = layout.length - 1
	/**
	 * Whether an alongside call's first flight decided it before its end (runAlongside Next): an answer alone it cannot
	 * read or a lost connection, BEGIN refused, or a statement's refusal or lost connection, after which the wait for its
	 * end, where it sends one, cancels nothing.
	 */
	const firstDecides =
		call.kind === "alongside" &&
		Arr.some(layout.slice(0, endAt), (slot, index) => {
			const tag = delivered[index]?.answer._tag
			switch (slot.role) {
				case "alone":
					return tag !== "result" && tag !== "refused"
				case "begin":
				case "statement":
					return tag !== "result" && tag !== "unreadable"
				case "prologue":
				case "end":
					return false
			}
		})
	const awaited =
		call.kind === "alongside"
			? firstDecides
				? endAt - 1
				: endAt
			: Option.isNone(beginAt)
				? 0
				: endAt - 1
	const ordinal = (index: number): number => {
		const d = delivered[index]
		if (d === undefined) {
			throw new Error(`the flight completed with no answer delivered at ${index}`)
		}
		return d.ordinal
	}
	if (at < ordinal(awaited)) {
		return "in flight"
	}
	const statementsAnswered = Arr.every(layout, (slot, index) => {
		const tag = delivered[index]?.answer._tag
		return slot.role === "end" || tag === "result" || tag === "unreadable"
	})
	return frames[call.frame].end === "COMMIT" && statementsAnswered ? "awaiting COMMIT" : "draining"
}

/**
 * What the fuzzers note of a run: how it ended, its retirement, where the interruption came, the call's form, and what
 * its flight met.
 */
export type FlightFeature =
	| "ending value"
	| "ending interrupted"
	| `ending ${Failure["tag"]}`
	| "retired"
	| `interrupted ${Exclude<InterruptionPoint, "none">}`
	| `call ${Call["kind"]} ${FrameName}`
	| "cancel sent"
	| "committed after an interruption"
	| "drained by its destruction"
	| "blocked without an interruption"
	| "begin refused"
	| `prologue ${FenceStep} ${PrologueFault}`
	| "statement refused"

/**
 * Flights as values, and the contract they keep (packages/grizzle/src/adapter/wire/batch.ts; docs/errors-and-concurrency.md "Errors and outcomes" and "Transactions and concurrency"), as a
 * model the unit fuzzer (test/unit/adapter/batch.test.ts) and the server check (test/pg/adapter/flight.test.ts) share.
 *
 * A case is a call and what the server does with each statement of it: a Db's flight framed as a read, a write or an
 * EXPLAIN's rollback (runFramed), whose prologue takes on the Db's role right after BEGIN, or the login's statements
 * alone in front of a transaction (runAlongside, admission's form), which has no prologue; each statement answers rows,
 * rows that doom the transaction at COMMIT, a row with a NULL cell, a refusal, a FATAL report or a lost connection, or
 * runs until a CancelRequest (a hold, or one that finishes late), or, on a server no CancelRequest reaches, until the
 * connection is destroyed (stuck); BEGIN
 * may be refused, the prologue may be refused, answer FATAL or lose the connection, and the connection may be lost
 * before COMMIT runs.
 *
 * The model reads what the server answered, query by query, and when the interruption came, and says what the call
 * must report. Without an interruption, the first query of the transaction the server answered neither with a result
 * nor with an unreadable one decides: a refused statement is BatchRefused at its index among the caller's statements
 * and nothing commits; a prologue step the fence refuses is StaleSnapshot and one refused otherwise PrologueRefused,
 * nothing ran and the session stays; a refused BEGIN is
 * ConnectionLost and retires the session; a refusal at COMMIT is CommitRefused; a lost connection or a FATAL report
 * retires the session, as CommitLost once COMMIT was sent and no refusal decided the transaction first, and still
 * retires it when a refusal decided before the connection ended; a statement alone meets no COMMIT. A statement that
 * ran and answered a NULL cell decides nothing: once nothing else decided, the call is UnreadableAnswer at the first
 * such statement, with what its transaction did. With an interruption:
 *
 * - the exit is the interruption exactly when the call had not completed when it came;
 * - the session is retired as interrupted and sends CancelRequests, round after round, exactly when a statement the call
 *   waits for was still in flight, and keeps its connection until the server has ended the flight, which runs the rest
 *   of the flight past the statement a CancelRequest stopped; otherwise it is retired only as the answers say;
 * - a statement on a server no CancelRequest reaches (stuck) is severed: the connection is destroyed at the round
 *   whose request was unreached, and the exit is the interruption, the outcome unknown;
 * - what commits is all of a transaction or none of it, as the server's answer to COMMIT says, whatever the
 *   interruption: an answer the destroyed connection never delivered is still what the server did;
 * - the server ends idle, and a session not retired ends healthy, with nothing owed.
 *
 * The model's observation of a run: the case, the answers the client was delivered by pipeline position (every one,
 * since a call completes only once its flight drains), the answers the server made, which a severed connection never
 * delivered, and when the interruption came.
 */
export const expected = (
	c: FlightCase,
	delivered: ReadonlyArray<Delivered | undefined>,
	made: ReadonlyArray<Answer | undefined>,
	interruption: Interruption,
	endSent: boolean
): Observation => {
	const layout = layoutOf(c.call)
	const at = (index: number): Delivered => {
		const d = delivered[index]
		if (d === undefined) {
			throw new Error(`the flight completed with no answer delivered at ${index}`)
		}
		return d
	}
	const answers = Arr.map(layout, (_slot, index) => at(index).answer)
	const frame = frames[c.call.frame]
	const beginAt = Arr.findFirstIndex(layout, (slot) => slot.role === "begin")
	const endAt = layout.length - 1
	/** The flight lost its connection: a query it sent failed, or the server ended the session. */
	const lostConnection = Arr.some(
		endSent ? answers : answers.slice(0, -1),
		(a) => a._tag === "failed" || a._tag === "terminated"
	)
	/** The ending and the retirement the answers alone decide. */
	const judged = ((): Judged => {
		const first = Arr.headNonEmpty(answers)
		if (Option.isNone(beginAt)) {
			return judgeAlone(first)
		}
		const begin = answers[beginAt.value]
		const end = answers[endAt]
		if (begin === undefined || end === undefined) {
			throw new Error("a transaction's flight has its BEGIN and its end")
		}
		/** A framed call's prologue, its two steps, follows BEGIN; the login's transaction has none. */
		const prologue = Arr.flatMap(layout, (slot, index) => {
			const answer = answers[index]
			return slot.role === "prologue" && answer !== undefined ? [{ step: slot.step, answer }] : []
		})
		const firstStatement = beginAt.value + 1 + prologue.length
		const transaction = judgeTransaction(
			begin,
			prologue,
			answers.slice(firstStatement, endAt),
			end,
			frame,
			endSent
		)
		const framed = transaction.result
		if (c.call.kind === "framed") {
			return framed.kind === "outcomes"
				? { ending: { kind: "value", value: framed }, retired: transaction.retired }
				: { ending: framed, retired: transaction.retired }
		}
		const alone: Array<AloneResult> = []
		for (const answer of answers.slice(0, beginAt.value)) {
			switch (answer._tag) {
				case "result":
					alone.push({ kind: "rows", rows: answer.outcome.rows })
					break
				case "refused":
					alone.push({ kind: "refused", sqlstate: answer.error.sqlstate })
					break
				case "terminated":
					return fails(
						{ tag: "ConnectionLost", operation: "query", sqlstate: answer.error.sqlstate },
						true
					)
				case "unreadable":
					return fails(
						lostConnection
							? { tag: "ConnectionLost", operation: "query", sqlstate: null }
							: { tag: "DriverFailure", operation: "query" },
						true
					)
				case "failed":
					return fails({ tag: "ConnectionLost", operation: "query", sqlstate: null }, true)
			}
		}
		if (
			framed.kind === "failure" &&
			(framed.failure.tag === "ConnectionLost" || framed.failure.tag === "DriverFailure")
		) {
			return { ending: framed, retired: transaction.retired }
		}
		return {
			ending: { kind: "value", value: { kind: "alongside", alone, framed } },
			retired: transaction.retired
		}
	})()
	/** The answers' own retirement stands first; a lost connection retires the session whatever decided. */
	const retired: boolean = judged.retired || lostConnection

	/** The query ran on the server: it made a result, readable or not, whether or not the client read it. */
	const serverRanAt = (index: number): boolean => {
		const tag = made[index]?._tag
		return tag === "result" || tag === "unreadable"
	}
	/**
	 * What committed, as the server made it: each statement alone that ran; a transaction's statements all at once when
	 * COMMIT answered COMMIT; and, when BEGIN was refused, each of its statements that ran, on its own.
	 */
	const closing = made[endAt]
	const transactionCommitted =
		frame.end === "COMMIT" && closing?._tag === "result" && closing.outcome.command === "COMMIT"
	const committed = Arr.flatMap(layout, (slot, index): ReadonlyArray<string> => {
		if (
			slot.role === "begin" ||
			slot.role === "prologue" ||
			slot.role === "end" ||
			!serverRanAt(index)
		) {
			return []
		}
		if (
			slot.role === "alone" ||
			Option.isNone(beginAt) ||
			!serverRanAt(beginAt.value) ||
			transactionCommitted
		) {
			return [slot.planned.label]
		}
		return []
	})

	const point = interruptionPoint(c.call, delivered, interruption)
	if (point === "none" || interruption.at === undefined) {
		return { ending: judged.ending, committed, retired, cancelled: false }
	}
	const inFlight = point === "in flight"
	return {
		ending: { kind: "interrupted" },
		committed,
		retired: inFlight || retired,
		cancelled: inFlight
	}
}

/** The observation of a run of a call over its session. */
export const observed = (
	exit: Exit.Exit<Value, Failure>,
	committed: ReadonlyArray<string>,
	retired: boolean,
	cancels: number
): Observation => ({
	ending: endingOf(exit),
	committed,
	retired,
	cancelled: cancels > 0
})

/** The SQLSTATEs a drawn refusal carries: none a stale name, none that ends the session. */
export const refusalStates = [
	"23505",
	"23000",
	"40001",
	"40P01",
	"22012",
	"42501",
	"40Z01"
] as const

/** The SQLSTATEs of a FATAL report: an administrator's shutdown or a crash's. */
export const fatalStates = ["57P01", "57P02"] as const

/** The SQLSTATE of a refused BEGIN: a read-only server refusing SERIALIZABLE. */
export const beginRefusal = "25006"

/** What a refused prologue answers: the role is no role the session may take on. */
export const prologueRefusal = "22023"

/** The fence's refusals: the lock's NOWAIT, the guard's unfinished folder, and the guard's other snapshot. */
const lockNotAvailable = "55P03"
const guardMigrating = "55Z02"
const guardMigrated = "55Z01"

/** The SQLSTATE a prologue step answers for a fence's fault. */
export const fenceRefusal = (step: FenceStep, fault: FenceFault): string =>
	step === "lock" ? lockNotAvailable : fault === "migrating" ? guardMigrating : guardMigrated
