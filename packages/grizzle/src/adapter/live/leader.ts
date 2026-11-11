import { Array as Arr, Clock, Data, Deferred, Effect, Result } from "effect"
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
	connectReplication,
	connectSession,
	type LoginConnection,
	type ReplicationFailure,
	type ReplicationSession,
	type Session,
	type UnreadableRows
} from "#adapter/wire/session.ts"
import type { EmittedText, Param, Prepared } from "#compiler/plan/common.ts"
import {
	batchesOf,
	createSlotCommand,
	defect,
	type LiveSecret,
	type Notification,
	parseLiveSecret,
	sealBatch,
	sealNonce,
	sealNonceBytes,
	startCommand,
	textArrayParam,
	textParam
} from "#compiler/plan/runtime.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * The installation's leader, as each process of it runs for it (live/listen.ts starts one at a live read's register when
 * none runs): its candidacy holds two sessions of the decoder login, a replication connection, which waits in the
 * installation's advisory lock and, once granted it, streams the slot's changes, so the lock is released when that
 * connection ends and another process's candidacy takes it at once; and an ordinary session, for the statements a
 * walsender does not run mid-stream. No two leaders run: the lock is the leadership.
 *
 * Leading, where no slot stands, or one stands invalidated, it fans out `invalidated`, since a slot made now holds no
 * change from before it, so a live read registered over an earlier slot must end, then makes the slot, which fails
 * where an invalidated one still stands; then streams the slot from the position it last confirmed. Each transaction arrives whole at its commit (live/pgoutput.ts, live/changes.ts), and a round takes every
 * transaction that arrived while the round before it ran, so rounds are paced by the stream and the fan-out alone:
 *
 * 1. visible: which of the round's transactions every snapshot taken now sees, so a key is sent only once a read begun
 *    after it arrives sees its change; the transactions up to the first one not yet visible are sent, and it and every
 *    one after go back to wait for the next round, which runs at once;
 * 2. fanout: their notifications, in commit order, each once, as batches sealed under the installation's secret with a
 *    fresh random nonce each (engine live/notify.ts batchesOf, sealBatch), in one transaction whose COMMIT sends them;
 * 3. confirm: only once that COMMIT answered, a Standby Status Update of the last transaction sent, which the slot
 *    confirms, so a leader that stops between the two sends a round again, whose keys mark again, and loses none. A
 *    keepalive the server sent once every transaction before it was sent confirms its position too, so WAL of tables no
 *    live program reads is not held; one that asks a reply is answered by the next round.
 *
 * A stream the server refuses checks the slot: one that no longer stands, invalidated or dropped, is fanned out as
 * `invalidated`, which ends every live read of the installation. A candidacy ends at its first failure, of a
 * connection, a session, the server, the stream or a round, which it answers with; it never runs again by itself.
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
	| UnreadableRows
	| MessageUnreadable
	| ChangesUnroutable
	| SecretUnreadable

/** The process's candidacy for the installation's leader failed for `reason`, so its live reads end. */
export class LeaderFailed extends Data.TaggedError("LeaderFailed")<{
	readonly reason: LeaderReason
}> {
	override get message(): string {
		return `the installation's live leader in this process failed: ${this.reason.message}`
	}
}

/** The secret table's cell is no secret. */
export class SecretUnreadable extends Data.TaggedError("SecretUnreadable") {
	override get message(): string {
		return "the installation's live secret is no AES-256 key"
	}
}

/**
 * What a candidacy runs with: the decoder login's connection, its sessions' control texts, the installation's live
 * source, its slot under the installation's role space, and its live tables.
 */
export interface Candidacy {
	readonly decoder: LoginConnection
	readonly session: ServedSession
	readonly source: Extract<ServedLive, { readonly kind: "source" }>
	readonly slot: string
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
			return Effect.die(defect("a flight of one statement answered it"))
		}
		return Result.isFailure(answer)
			? Effect.fail(answer.failure)
			: Effect.succeed(answer.success.rows)
	})

/** The first cell of the first row of an answer: a statement of one value's. */
export const onlyCell = (rows: ReadonlyArray<ReadonlyArray<string>>): string | undefined =>
	rows[0]?.[0]

/** PostgreSQL's output text of true, the one the statements answering a boolean answer with. */
export const trueText = "t"

/** The secret table's cell, read as the installation's secret. */
export const secretOf = (
	rows: ReadonlyArray<ReadonlyArray<string>>
): Effect.Effect<LiveSecret, SecretUnreadable> => {
	const cell = onlyCell(rows)
	const secret = cell === undefined ? undefined : parseLiveSecret(cell)
	return secret?.ok === true ? Effect.succeed(secret.value) : Effect.fail(new SecretUnreadable())
}

/** A fresh random nonce for one sealed payload. */
const freshNonce = Effect.sync(() => {
	const nonce = sealNonce(SecureRandom.randomBytesUnsafe(sealNonceBytes))
	if (!nonce.ok) {
		throw defect("randomBytes answered a nonce of sealNonceBytes bytes")
	}
	return nonce.value
})

/** The transaction a round's fanout runs in: its NOTIFYs are sent at its COMMIT. */
const fanoutTransaction: Transaction = {
	access: "readWrite",
	isolation: "readCommitted",
	end: "COMMIT"
}

/** The milliseconds from the Unix epoch to PostgreSQL's, 2000-01-01, which a status update's clock counts from. */
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
 * Each CopyData of the stream, read the moment it arrives (see the header): an XLogData's message read into the
 * stream's transactions, a keepalive's position kept and its reply owed where it asks one; a CopyData no format reads
 * fails the stream.
 */
const receiver =
	(delivered: Delivered, reader: ReturnType<typeof transactionReader>) =>
	(chunk: Uint8Array): void => {
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
		const taken = delivered.transactions.splice(0)
		if (Arr.isReadonlyArrayNonEmpty(taken)) {
			const visibleRows = yield* alone(
				leading.session,
				statement(leading.candidacy.source.visible, [
					textArrayParam(Arr.map(taken, (transaction) => String(transaction.xid)))
				])
			)
			const visible = new Set<string>()
			for (const [xid, seen] of visibleRows) {
				if (xid !== undefined && seen === trueText) {
					visible.add(xid)
				}
			}
			const sent = Arr.takeWhile(taken, (transaction) => visible.has(String(transaction.xid)))
			delivered.transactions.unshift(...taken.slice(sent.length))
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
 * The slot streamed from the position it last confirmed; a stream the server refuses checks the slot, and one that no
 * longer stands is fanned out as `invalidated` before the refusal ends the candidacy.
 */
const streamed = (
	leading: Leading,
	replication: ReplicationSession,
	delivered: Delivered
): Effect.Effect<never, LeaderReason> => {
	const { candidacy } = leading
	const reader = transactionReader(candidacy.tables, candidacy.source.publication, leading.secret)
	return Effect.catchTag(
		replication.stream(
			startCommand(candidacy.slot, candidacy.source.publication, 0n),
			receiver(delivered, reader)
		),
		"ServerError",
		(refused) =>
			Effect.flatMap(
				alone(leading.session, statement(candidacy.source.check, [textParam(candidacy.slot)])),
				(rows) =>
					onlyCell(rows) === trueText
						? Effect.fail(refused)
						: Effect.flatMap(fanout(leading, [{ kind: "invalidated" }]), () => Effect.fail(refused))
			)
	)
}

/**
 * One candidacy (see the header): its two sessions, the lock waited for on the replication connection, the slot made
 * where none stands and `invalidated` fanned out for it, the secret read, then the stream and its rounds, until either
 * fails.
 */
export const candidacy = (running: Candidacy): Effect.Effect<never, LeaderReason> =>
	Effect.scoped(
		Effect.gen(function* () {
			const connection = { ...running.decoder, controls: running.session }
			const replication = yield* connectReplication(connection)
			const session = yield* connectSession(connection)
			yield* replication.simple(running.source.lock)
			const slot = textParam(running.slot)
			const checked = yield* alone(session, statement(running.source.check, [slot]))
			const standing = onlyCell(checked)
			const secret = yield* Effect.flatMap(
				alone(session, statement(running.source.secret, [])),
				secretOf
			)
			const leading: Leading = { session, candidacy: running, secret }
			if (standing !== trueText) {
				yield* fanout(leading, [{ kind: "invalidated" }])
				yield* replication.simple(createSlotCommand(running.slot))
			}
			const delivered: Delivered = {
				transactions: [],
				keepalive: undefined,
				received: 0,
				replyOwed: false,
				failure: undefined,
				waiting: undefined
			}
			return yield* Effect.raceFirst(
				streamed(leading, replication, delivered),
				rounds(leading, replication, delivered)
			)
		})
	)
