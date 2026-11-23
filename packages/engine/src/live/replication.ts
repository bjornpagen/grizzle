/**
 * The replication protocol commands the leader of an installation's live source sends on its decoder login's
 * replication connection (`replication=database`), each printed once at generate into the login's served file
 * (program/live.ts servedLiveOf) and nowhere else. A walsender reads simple Queries alone, so a command takes no bind
 * parameter, and the one thing in it no generate knows is its slot's name: the installation's live source stem under
 * the role space a layer reads at load (core/identity.ts roleInSpace), as the decoder login it connects as is. So a
 * command is served as its text around that one name (served/forms.ts SlotCommand), and the runtime fills it once its
 * layer names the slot (slotCommand), quoting it as generate quotes every identifier. Migrate's variables filler
 * (deploy/render/variables.ts resolveVariables), the one door of every drafted role-spaced text, reads the SQL lexer,
 * which no runtime module loads, so no drafted text with a variable reaches the runtime.
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { LiveTextRefused } from "#compiler/live/notify.ts"

declare const replicationCommandBrand: unique symbol

/** A replication protocol command, sent alone as a simple Query on a replication connection. Minted only here. */
export type ReplicationCommand = string & { readonly [replicationCommandBrand]: true }

const command = nominal<string, ReplicationCommand>()

/** A replication command's text around the slot's quoted name: served/forms.ts SlotCommand's shape. */
interface SlotText {
	readonly before: string
	readonly after: string
}

/**
 * The version of pgoutput's protocol the leader reads: 1, whose messages every later version keeps, with no streaming
 * of a transaction in progress and no two-phase commit, so each decoded transaction arrives whole at its commit.
 *
 * @formatConstant pgoutput's logical replication protocol, version 1
 */
const protocolVersion = "1"

/**
 * The pgoutput options every stream starts with besides its publication (startTemplate), closed: protocol version 1
 * alone, so the stream carries no logical message, which any role of the database may emit, and every change it
 * carries is a published table's. The type admits no other option, `messages` and `streaming` among them, on purpose:
 * no installation's change is a message, and the leader's confirmation of a keepalive's position
 * (adapter/live/leader.ts, (a) to (d)) rests on each transaction being written whole while its COMMIT record is
 * processed, which streaming transactions in progress (a `streaming` option, protocol 2 and later) breaks, so an option
 * added here meets that argument first.
 */
interface StreamOptions {
	readonly proto_version: typeof protocolVersion
}

const streamOptions: StreamOptions = { proto_version: protocolVersion }

/**
 * CREATE_REPLICATION_SLOT <slot> LOGICAL pgoutput (SNAPSHOT 'nothing'): the installation's slot, permanent, of
 * PostgreSQL's own output plugin, exporting no snapshot, since no stream reads its first rows through one.
 */
export const createSlotTemplate: SlotText = {
	before: "CREATE_REPLICATION_SLOT ",
	after: " LOGICAL pgoutput (SNAPSHOT 'nothing')"
}

/**
 * START_REPLICATION SLOT <slot> LOGICAL 0/0 (...): the slot's decoded changes from the position it last confirmed, which
 * 0/0 asks for, over the publication `publication`, in pgoutput's protocol version 1 (streamOptions).
 */
export const startTemplate = (publication: string): SlotText => ({
	before: "START_REPLICATION SLOT ",
	after: ` LOGICAL 0/0 (proto_version ${quoteString(streamOptions.proto_version)}, publication_names ${quoteString(quoteIdent(publication))})`
})

/** The served command `template` over the slot `slot` (served/forms.ts SlotCommand). */
export const slotCommand = (template: SlotText, slot: string): ReplicationCommand =>
	command(`${template.before}${quoteIdent(slot)}${template.after}`)

/**
 * A replication stream's deadline, its walsender's own wal_sender_timeout: half of it after the last message its
 * reader sent, the walsender sends a keepalive that asks a reply, and the whole of it after, it ends the connection;
 * so a reader that answers each keepalive hears from the server, a change or a keepalive, within the timeout, and a
 * stream silent that long is no longer connected. `none` where the timeout is 0, which disables both, so a silence says
 * nothing.
 */
export type SenderDeadline =
	| { readonly kind: "none" }
	| { readonly kind: "after"; readonly millis: number }

const noDeadline: SenderDeadline = { kind: "none" }

const zero = 0x30

const nine = 0x39

/** Whether `text` is a non-negative integer as PostgreSQL's output writes one: decimal digits, the first no 0 but a lone one. */
const isCount = (text: string): boolean => {
	if (text.length === 0 || (text.length > 1 && text.charCodeAt(0) === zero)) {
		return false
	}
	for (let at = 0; at < text.length; at += 1) {
		const unit = text.charCodeAt(at)
		if (unit < zero || unit > nine) {
			return false
		}
	}
	return true
}

/**
 * The deadline the live source's sender timeout query's cell states (served/forms.ts ServedLive `senderTimeout`) (SenderDeadline): the timeout's milliseconds, as PostgreSQL's integer
 * output writes them, 0 `none`; any other text is refused.
 */
export const parseSenderDeadline = (
	cell: string
): Result.Result<SenderDeadline, LiveTextRefused> => {
	const millis = Number(cell)
	if (!isCount(cell) || !Number.isSafeInteger(millis)) {
		return Result.err({
			text: cell,
			expected: "a count of milliseconds: decimal digits, the first no 0 but a lone one"
		})
	}
	return Result.ok(millis === 0 ? noDeadline : { kind: "after", millis })
}

/**
 * A snapshot as the live leader reads it (served/forms.ts ServedLive `snapshot`, pg_current_snapshot): its horizon, its
 * xmax, the first transaction id it holds unended, and the ids below the horizon it holds running, its xip, each a
 * 64-bit id.
 */
export interface Snapshot {
	readonly horizon: bigint
	readonly running: ReadonlySet<bigint>
}

/** The text of pg_snapshot's output (xid8funcs.c pg_snapshot_out). */
const snapshotExpected = "pg_snapshot's text: xmin:xmax:xip,... of decimal transaction ids"

/** The ids of a list `a,b,...` of decimal transaction ids, none where it is empty, or none at all where one is no id. */
const transactionIds = (list: string): ReadonlyArray<bigint> | undefined => {
	if (list.length === 0) {
		return []
	}
	const ids: Array<bigint> = []
	for (const id of list.split(",")) {
		if (!isCount(id)) {
			return undefined
		}
		ids.push(BigInt(id))
	}
	return ids
}

/**
 * The snapshot pg_snapshot's output text `xmin:xmax:xip,...` states (Snapshot), each id decimal as PostgreSQL's integer
 * output writes one; any other text is refused.
 */
export const parseSnapshot = (cell: string): Result.Result<Snapshot, LiveTextRefused> => {
	const [xmin, xmax, xip, ...rest] = cell.split(":")
	const running = xip === undefined ? undefined : transactionIds(xip)
	if (
		xmin === undefined ||
		xmax === undefined ||
		running === undefined ||
		rest.length > 0 ||
		!isCount(xmin) ||
		!isCount(xmax)
	) {
		return Result.err({ text: cell, expected: snapshotExpected })
	}
	return Result.ok({ horizon: BigInt(xmax), running: new Set(running) })
}

/**
 * Where a committed transaction stands in a snapshot, as PostgreSQL's XidInMVCCSnapshot places it: `seen`, below its
 * horizon and not running in it, so every snapshot taken after it sees the transaction's commit too; `running`, below
 * its horizon and held running, its commit not yet visible to it; `ahead`, at or past its horizon, an id it holds
 * unended whatever its running set says.
 */
export type Placement = "seen" | "running" | "ahead"

/**
 * Where the transaction of 32-bit id `xid`, as pgoutput's Begin carries it, stands in `snapshot` (Placement). Its full
 * id is the one of those low 32 bits nearest the snapshot's horizon, `(int32) (xid - xmax)` from it as transam.h's
 * TransactionIdPrecedes compares them, since PostgreSQL keeps every id it still compares within 2^31 of the next one.
 */
export const placement = (snapshot: Snapshot, xid: number): Placement => {
	const full = snapshot.horizon + BigInt.asIntN(32, BigInt(xid) - snapshot.horizon)
	if (full >= snapshot.horizon) {
		return "ahead"
	}
	return snapshot.running.has(full) ? "running" : "seen"
}
