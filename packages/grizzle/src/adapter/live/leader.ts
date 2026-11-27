import { Array as Arr, Cause, Clock, Data, Deferred, Duration, Effect, Result } from "effect"
import { SecureRandom } from "effect/crypto"
import type {
	BatchFailure,
	ConnectRefusal,
	InputTooLarge,
	ReplicationEnded,
	ServerError
} from "#adapter/errors/failures.ts"
import {
	type ChangesUnroutable,
	type DecodedTransaction,
	type LiveTables,
	transactionReader
} from "#adapter/live/changes.ts"
import {
	decodeMessage,
	type MessageUnreadable,
	standbyStatus,
	streamMessageOf
} from "#adapter/live/pgoutput.ts"
import {
	type ApartFailure,
	type BatchStatement,
	preparedStatement,
	runApart,
	runTransaction,
	type Transaction
} from "#adapter/wire/batch.ts"
import {
	type LoginConnection,
	connectReplication,
	connectSession,
	type ReplicationFailure,
	type ReplicationSession,
	type Session
} from "#adapter/wire/session.ts"
import type { EmittedText, OutputRows, Param, Prepared } from "#compiler/plan/common.ts"
import {
	batchesOf,
	defect,
	type LiveSecret,
	type Notification,
	parseLiveSecret,
	parseSenderDeadline,
	parseSnapshot,
	parseWalPosition,
	placement,
	type ReplicationCommand,
	sealBatch,
	sealNonce,
	sealNonceBytes,
	type SenderDeadline,
	type Snapshot,
	textArrayParam,
	textParam,
	type WalPosition
} from "#compiler/plan/runtime.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * The installation's leader, as each process of it runs for it (live/listen.ts starts one at a live read's register when
 * none runs): its candidacy holds two sessions of the decoder login, a replication connection, which waits in the
 * installation's advisory lock and, once granted it, streams the slot's changes, so the lock is released when that
 * connection ends and another process's candidacy takes it at once; and an ordinary session, for the statements a
 * walsender does not run mid-stream. No two leaders run: the lock is the leadership.
 *
 * Leading, where no slot stands, or one stands invalidated, it fans out `invalidated` of the WAL position its slot check
 * read (live/notify.ts WalPosition), since a slot made now holds no change from before it, so a live read registered
 * over an earlier slot must end, and none registered over the slot it then makes: that slot stands past the position
 * (live/listen.ts heardInvalidation). Then it makes the slot, which fails
 * where an invalidated one still stands. Holding the slot, made or found, it fans out `stands`, which releases every
 * source waiting for the slot (live/listen.ts), a candidacy that made the slot and ended before it said so among them,
 * since the next one says so; then streams the slot from the position it last confirmed. Each transaction arrives whole at its commit (live/pgoutput.ts, live/changes.ts), and a round takes every
 * transaction that arrived while the round before it ran, so rounds are paced by the stream and the fan-out alone:
 *
 * 1. visible: a snapshot taken now (engine live/replication.ts Snapshot), each of the round's transactions placed in it
 *    (placement), so a key is sent only once a read begun after it arrives sees its change; the transactions up to the
 *    first one the snapshot does not see are sent, and it and every one after stay for the next round, which runs at
 *    once. A transaction arrives once its COMMIT record is flushed, before it leaves the proc array (xact.c
 *    RecordTransactionCommit, then ProcArrayEndTransaction), so a snapshot taken meanwhile holds it running, or ahead
 *    of its horizon where no later transaction ended: never seen;
 * 2. fanout: their notifications, in commit order, each once, as batches sealed under the installation's secret with a
 *    fresh random nonce each (engine live/notify.ts batchesOf, sealBatch), in one transaction whose COMMIT sends them;
 * 3. confirm: only once that COMMIT answered, a Standby Status Update of the last transaction sent, which the slot
 *    confirms, so a leader that stops between the two sends a round again, whose keys mark again, and loses none. A
 *    keepalive the server sent once every transaction before it was sent confirms its position too, so WAL of tables no
 *    live program reads is not held; one that asks a reply is answered by the next round.
 *
 * Confirming a keepalive's position never passes a commit no leader fanned out, in this process or another that resumes
 * the slot, by PostgreSQL 19's walsender (src/backend/replication/walsender.c at REL_19_0 5c839a2a):
 * (a) a keepalive's position is the `writePtr` it is given, else `sentPtr` (WalSndKeepalive, :4477), and the one
 *     `writePtr` given is a transaction's skipped as empty under synchronous replication (:1804), which carries nothing
 *     to deliver;
 * (b) a logical walsender advances `sentPtr` only once a whole WAL record is processed
 *     (`LogicalDecodingProcessRecord(...); sentPtr = reader->EndRecPtr`, XLogSendLogical, :3726), and a transaction's
 *     messages, Begin through Commit, are written while its COMMIT record is processed, since the stream carries no
 *     transaction in progress (engine live/replication.ts streamOptions): a keepalive written mid-transaction
 *     (WalSndWriteData's WalSndKeepaliveIfNecessary, :1732) carries the record before that COMMIT, and one written
 *     after it the COMMIT's end, behind every message of the transaction on the one ordered stream;
 * (c) a keepalive is confirmed only once every transaction fully received before it was fanned out
 *     (`progress.sent >= keepalive.after`), and a transaction received in part is not counted, its COMMIT past the
 *     keepalive's position by (b);
 * (d) a slot resumed replays every transaction whose COMMIT lies past its confirmed position, read from its restart
 *     position, which the server holds at or before the oldest running transaction's start, so a transaction cut off in
 *     the middle is sent again whole.
 *
 * A stream the server refuses checks the slot: one that no longer stands, invalidated or dropped, is fanned out as
 * `invalidated`, which ends every live read of the installation. A stream's deadline is the server's own, its
 * replication session's wal_sender_timeout, read before START_REPLICATION (engine live/replication.ts SenderDeadline):
 * a stream that hears nothing, a change or a keepalive, for that long is no longer connected, though no socket said so,
 * so the candidacy ends, and its replication connection with it, and the next process's candidacy takes the lock; a
 * timeout of 0 sets none, and grizzle sets none of its own. A candidacy ends at its first failure, of a connection, a
 * session, the server, the stream, its deadline or a round, which it answers with; it never runs again by itself.
 *
 * Why a candidacy failed.
 */
export type LeaderReason =
	| ConnectRefusal
	| ServerError
	| ApartFailure
	| BatchFailure
	| InputTooLarge
	| ReplicationFailure
	| ReplicationEnded
	| MessageUnreadable
	| ChangesUnroutable
	| SecretUnreadable
	| SenderTimeoutUnreadable
	| ReplicationSilent
	| LeaderDied

/** The process's candidacy for the installation's leader failed for `reason`, so its live reads end. */
export class LeaderFailed extends Data.TaggedError("LeaderFailed")<{
	readonly reason: LeaderReason
}> {
	override get message(): string {
		return `the installation's live leader in this process failed: ${this.reason.message}`
	}
}

/**
 * A candidacy that ended with no failure of its own, `cause` all there is of its end: a defect of grizzle's, which the
 * same candidacy meets again, or its fiber interrupted. Every end of a candidacy is one of its failures or this, so no
 * end leaves the leadership taken (live/listen.ts leading).
 */
export class LeaderDied extends Data.TaggedError("LeaderDied")<{
	readonly cause: Cause.Cause<never>
}> {
	override get message(): string {
		return `the installation's live leader in this process died: ${Cause.pretty(this.cause)}`
	}
}

/** The secret table's cell is no secret. */
export class SecretUnreadable extends Data.TaggedError("SecretUnreadable") {
	override get message(): string {
		return "the installation's live secret is no AES-256 key"
	}
}

/** The replication session's wal_sender_timeout answers no count of milliseconds in the one unit it reads. */
class SenderTimeoutUnreadable extends Data.TaggedError("SenderTimeoutUnreadable") {
	override get message(): string {
		return "the replication session's wal_sender_timeout is no count of milliseconds"
	}
}

/** The replication stream heard nothing, a change or a keepalive, for its deadline, `millis` (SenderDeadline). */
export class ReplicationSilent extends Data.TaggedError("ReplicationSilent")<{
	readonly millis: number
}> {
	override get message(): string {
		return `the installation's replication stream sent nothing for ${this.millis} ms, its session's wal_sender_timeout, within which a connected walsender sends a keepalive`
	}
}

/**
 * What a candidacy runs with: the decoder login's connection, its sessions' control texts, the installation's live
 * source, its slot in the connection's database (engine core/identity.ts liveSlotOf), the source's slot commands filled
 * with it once, where the layer names it (engine live/replication.ts slotCommand), and its live tables, an authored or
 * a stored derived relation's each (live/changes.ts).
 */
export interface Candidacy {
	readonly decoder: LoginConnection
	readonly session: ServedSession
	readonly source: Extract<ServedLive, { readonly kind: "source" }>
	readonly slot: string
	readonly createSlot: ReplicationCommand
	readonly start: ReplicationCommand
	readonly tables: LiveTables
}

/** A served statement of the source's over `params`, its rows kept. */
const statement = (text: Prepared<EmittedText>, params: ReadonlyArray<Param>): BatchStatement =>
	preparedStatement(text, params)

/** One statement alone on `session`: its rows, or the server's refusal of it. */
export const alone = (
	session: Session,
	sent: BatchStatement
): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, ApartFailure | ServerError> =>
	Effect.flatMap(runApart(session, [sent]), (answers) => {
		const [answer] = answers
		if (answer === undefined) {
			return Effect.sync(() => defect("a flight of one statement answered it"))
		}
		return Result.isFailure(answer)
			? Effect.fail(answer.failure)
			: Effect.succeed(answer.success.rows)
	})

/** The first cell of the first row of an answer: a statement of one value's. */
const onlyCell = (rows: ReadonlyArray<ReadonlyArray<string>>): string | undefined => rows[0]?.[0]

/** The secret table's cell, read as the installation's secret. */
export const secretOf = (
	rows: ReadonlyArray<ReadonlyArray<string>>
): Effect.Effect<LiveSecret, SecretUnreadable> => {
	const cell = onlyCell(rows)
	const secret = cell === undefined ? undefined : parseLiveSecret(cell)
	return secret?.ok === true ? Effect.succeed(secret.value) : Effect.fail(new SecretUnreadable())
}

/**
 * What the source's slot check answered (ServedLive `check`): the slot standing at its position, its
 * confirmed_flush_lsn, or none standing, beside the WAL's insert position as the check read it, the position an
 * invalidation names (live/notify.ts WalPosition).
 */
export type SlotCheck =
	| { readonly kind: "stands"; readonly at: WalPosition }
	| { readonly kind: "absent"; readonly now: WalPosition }

/**
 * The slot check's one row, read as SlotCheck: an empty first cell where no slot stands. PostgreSQL answers grizzle's
 * own statement, so its answer is converted, never refused (core/trusted.ts): an answer of another shape is a defect.
 */
export const slotCheckOf = (rows: ReadonlyArray<ReadonlyArray<string>>): SlotCheck => {
	const [standing, now] = rows[0] ?? []
	const position = (text: string | undefined): WalPosition => {
		const read = text === undefined ? undefined : parseWalPosition(text)
		if (read?.ok !== true) {
			defect(`the slot check answers WAL positions, not ${String(text)}`)
		}
		return read.value
	}
	return standing === ""
		? { kind: "absent", now: position(now) }
		: { kind: "stands", at: position(standing) }
}

/**
 * The snapshot statement's one cell, read as a Snapshot (ServedLive `snapshot`). PostgreSQL answers grizzle's own
 * statement, so its answer is converted, never refused (core/trusted.ts): an answer of another shape is a defect.
 */
export const snapshotOf = (rows: ReadonlyArray<ReadonlyArray<string>>): Snapshot => {
	const cell = onlyCell(rows)
	const read = cell === undefined ? undefined : parseSnapshot(cell)
	if (read?.ok !== true) {
		defect(`the snapshot statement answers pg_snapshot's text, not ${String(cell)}`)
	}
	return read.value
}

/** The deadline the source's sender timeout query's answer states (ServedLive `senderTimeout`). */
const deadlineOf = (rows: OutputRows): Effect.Effect<SenderDeadline, SenderTimeoutUnreadable> => {
	const cell = onlyCell(rows)
	const deadline = cell === undefined ? undefined : parseSenderDeadline(cell)
	return deadline?.ok === true
		? Effect.succeed(deadline.value)
		: Effect.fail(new SenderTimeoutUnreadable())
}

const unheard = (): void => undefined

/**
 * `body` under a stream's deadline (SenderDeadline): `body` is given `heard`, which it calls on each message the stream
 * delivers, and it ends with ReplicationSilent once the Clock's monotonic time passes the deadline since the last call,
 * or since it began where none came; under `none` it is `body` alone.
 */
export const deadlined = <E>(
	deadline: SenderDeadline,
	body: (heard: () => void) => Effect.Effect<never, E>
): Effect.Effect<never, E | ReplicationSilent> => {
	switch (deadline.kind) {
		case "none":
			return body(unheard)
		case "after":
			return Effect.clockWith((clock) => {
				const span = Duration.millis(deadline.millis)
				const last = { at: clock.monotonicTimeNanosUnsafe() }
				const silence: Effect.Effect<never, ReplicationSilent> = Effect.forever(
					Effect.suspend(() => {
						const quiet = Duration.nanos(clock.monotonicTimeNanosUnsafe() - last.at)
						return Duration.isGreaterThanOrEqualTo(quiet, span)
							? Effect.fail(new ReplicationSilent({ millis: deadline.millis }))
							: clock.sleep(Duration.subtract(span, quiet))
					})
				)
				return Effect.raceFirst(
					body(() => {
						last.at = clock.monotonicTimeNanosUnsafe()
					}),
					silence
				)
			})
	}
}

/** A fresh random nonce for one sealed payload. */
const freshNonce = Effect.sync(() => {
	const nonce = sealNonce(SecureRandom.randomBytesUnsafe(sealNonceBytes))
	if (!nonce.ok) {
		defect("randomBytes answered a nonce of sealNonceBytes bytes")
	}
	return nonce.value
})

/** The transaction a round's fanout runs in: its NOTIFYs are sent at its COMMIT. */
const fanoutTransaction: Transaction = {
	access: "readWrite",
	isolation: "readCommitted",
	end: "COMMIT"
}

/**
 * The milliseconds from the Unix epoch to PostgreSQL's, midnight on 2000-01-01, which a Standby Status Update's clock
 * counts microseconds from, by "Streaming Replication Protocol"
 * (https://www.postgresql.org/docs/19/protocol-replication.html): "The client's system clock at the time of
 * transmission, as microseconds since midnight on 2000-01-01."
 *
 * @formatConstant PostgreSQL's epoch, 2000-01-01 00:00:00 UTC, in Unix milliseconds
 */
const postgresEpochMillis = 946_684_800_000n

/** A status update confirming `flushed`, its clock the Clock's now. */
const statusNow = (flushed: bigint): Effect.Effect<Uint8Array> =>
	Effect.map(Clock.currentTimeMillis, (millis) =>
		standbyStatus(flushed, (BigInt(millis) - postgresEpochMillis) * 1000n)
	)

/** A leader's ordinary session and what it reads with: the candidacy's texts and the installation's secret. */
interface Leading {
	readonly session: Session
	readonly candidacy: Candidacy
	readonly secret: LiveSecret
}

/** `notifications` fanned out: sealed in batches, sent in one transaction, all at its COMMIT. */
const fanout = (
	leading: Leading,
	notifications: ReadonlyArray<Notification>
): Effect.Effect<void, BatchFailure | InputTooLarge> =>
	Effect.gen(function* () {
		const payloads: Array<string> = []
		for (const batch of batchesOf(notifications)) {
			const nonce = yield* freshNonce
			payloads.push(sealBatch(leading.secret, nonce, batch))
		}
		if (payloads.length === 0) {
			return
		}
		yield* runTransaction(
			leading.session,
			[statement(leading.candidacy.source.fanout, [textArrayParam(payloads)])],
			fanoutTransaction
		)
	})

/**
 * What the stream has delivered that no round has taken: the transactions decoded, in commit order; the position of
 * the last keepalive and how many transactions came before it, which a round confirms once it has sent that many; how
 * many transactions came in all; whether a reply is owed; the failure that ends the stream, its first; and the round
 * waiting for any of them.
 */
interface Delivered {
	readonly transactions: Array<DecodedTransaction>
	keepalive: { readonly walEnd: bigint; readonly after: number } | undefined
	received: number
	replyOwed: boolean
	failure: LeaderReason | undefined
	waiting: Deferred.Deferred<void> | undefined
}

/** The round waiting on `delivered`, resumed. */
const wake = (delivered: Delivered): void => {
	const waiting = delivered.waiting
	if (waiting !== undefined) {
		delivered.waiting = undefined
		Deferred.doneUnsafe(waiting, Effect.void)
	}
}

/** The stream's failure, its first kept. */
const fail = (delivered: Delivered, reason: LeaderReason): void => {
	delivered.failure ??= reason
	wake(delivered)
}

/** Whether a round has anything to do. */
const due = (delivered: Delivered): boolean =>
	delivered.failure !== undefined ||
	delivered.replyOwed ||
	delivered.transactions.length > 0 ||
	delivered.keepalive !== undefined

/** The wait until a round has anything to do. */
const awaitDue = (delivered: Delivered): Effect.Effect<void> =>
	Effect.suspend(() => {
		if (due(delivered)) {
			return Effect.void
		}
		const waiting = Deferred.makeUnsafe<void>()
		delivered.waiting = waiting
		return Deferred.await(waiting)
	})

/**
 * Each CopyData of the stream, read the moment it arrives (see the header): heard, for the stream's deadline, then an
 * XLogData's message read into the stream's transactions, a keepalive's position kept and its reply owed where it asks
 * one; a CopyData no format reads fails the stream.
 */
const receiver =
	(delivered: Delivered, reader: ReturnType<typeof transactionReader>, heard: () => void) =>
	(chunk: Uint8Array): void => {
		heard()
		if (delivered.failure !== undefined) {
			return
		}
		const streamed = streamMessageOf(chunk)
		if (Result.isFailure(streamed)) {
			fail(delivered, streamed.failure)
			return
		}
		const message = streamed.success
		switch (message.kind) {
			case "keepalive":
				delivered.keepalive = { walEnd: message.walEnd, after: delivered.received }
				delivered.replyOwed = delivered.replyOwed || message.replyRequested
				wake(delivered)
				return
			case "xlog": {
				const decoded = Result.flatMap(decodeMessage(message.data), (read) => reader.read(read))
				if (Result.isFailure(decoded)) {
					fail(delivered, decoded.failure)
					return
				}
				if (decoded.success !== undefined) {
					delivered.transactions.push(decoded.success)
					delivered.received += 1
					wake(delivered)
				}
				return
			}
		}
	}

/** The rounds of a leader (see the header), each once the stream has delivered anything, until one fails. */
const rounds = (
	leading: Leading,
	replication: ReplicationSession,
	delivered: Delivered
): Effect.Effect<never, LeaderReason> => {
	const progress = { sent: 0, confirmed: 0n }
	const confirm = (flushed: bigint): Effect.Effect<void> =>
		Effect.map(statusNow(flushed), (status) => {
			progress.confirmed = flushed
			delivered.replyOwed = false
			replication.reply(status)
		})
	const round: Effect.Effect<void, LeaderReason> = Effect.gen(function* () {
		yield* awaitDue(delivered)
		const failure = delivered.failure
		if (failure !== undefined) {
			return yield* failure
		}
		const taken = Arr.copy(delivered.transactions)
		if (Arr.isReadonlyArrayNonEmpty(taken)) {
			const snapshot = yield* Effect.map(
				alone(leading.session, statement(leading.candidacy.source.snapshot, [])),
				snapshotOf
			)
			const sent = Arr.takeWhile(
				taken,
				(transaction) => placement(snapshot, transaction.xid) === "seen"
			)
			delivered.transactions.splice(0, sent.length)
			const last = Arr.last(sent)
			if (last._tag === "Some") {
				yield* fanout(
					leading,
					Arr.flatMap(sent, (transaction) => transaction.notifications)
				)
				progress.sent += sent.length
				yield* confirm(last.value.endLsn)
			}
		}
		const keepalive = delivered.keepalive
		if (keepalive !== undefined && progress.sent >= keepalive.after) {
			delivered.keepalive = undefined
			if (keepalive.walEnd > progress.confirmed) {
				yield* confirm(keepalive.walEnd)
			}
		}
		if (delivered.replyOwed) {
			yield* confirm(progress.confirmed)
		}
	})
	return Effect.forever(round)
}

/**
 * The slot streamed from the position it last confirmed, each message `heard`; a stream the server refuses checks the
 * slot, and one that no longer stands is fanned out as `invalidated` before the refusal ends the candidacy.
 */
const streamed = (
	leading: Leading,
	replication: ReplicationSession,
	delivered: Delivered,
	heard: () => void
): Effect.Effect<never, LeaderReason> => {
	const { candidacy } = leading
	const reader = transactionReader(candidacy.tables, candidacy.source.ledger)
	return Effect.catchTag(
		replication.stream(candidacy.start, receiver(delivered, reader, heard)),
		"ServerError",
		(refused) =>
			Effect.flatMap(
				alone(leading.session, statement(candidacy.source.check, [textParam(candidacy.slot)])),
				(rows) => {
					const check = slotCheckOf(rows)
					return check.kind === "stands"
						? Effect.fail(refused)
						: Effect.flatMap(fanout(leading, [{ kind: "invalidated", before: check.now }]), () =>
								Effect.fail(refused)
							)
				}
			)
	)
}

/**
 * One candidacy (see the header): its two sessions, the lock waited for on the replication connection and its
 * deadline read there, the slot made where none stands and `invalidated` fanned out for it, the secret read, `stands`
 * fanned out, then the stream and its rounds under the deadline, until either fails or the deadline passes.
 */
export const candidacy = (running: Candidacy): Effect.Effect<never, LeaderReason> =>
	Effect.scoped(
		Effect.gen(function* () {
			const connection = { ...running.decoder, controls: running.session }
			const replication = yield* connectReplication(connection)
			const session = yield* connectSession(connection)
			yield* replication.run(running.source.lock)
			const deadline = yield* Effect.flatMap(
				replication.read(running.source.senderTimeout),
				deadlineOf
			)
			const slot = textParam(running.slot)
			const checked = yield* alone(session, statement(running.source.check, [slot]))
			const check = slotCheckOf(checked)
			const secret = yield* Effect.flatMap(
				alone(session, statement(running.source.secret, [])),
				secretOf
			)
			const leading: Leading = { session, candidacy: running, secret }
			if (check.kind === "absent") {
				yield* fanout(leading, [{ kind: "invalidated", before: check.now }])
				yield* replication.run(running.createSlot)
			}
			yield* fanout(leading, [{ kind: "stands" }])
			const delivered: Delivered = {
				transactions: [],
				keepalive: undefined,
				received: 0,
				replyOwed: false,
				failure: undefined,
				waiting: undefined
			}
			return yield* deadlined(deadline, (heard) =>
				Effect.raceFirst(
					streamed(leading, replication, delivered, heard),
					rounds(leading, replication, delivered)
				)
			)
		})
	)
