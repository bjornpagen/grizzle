/**
 * The replication protocol commands the leader of an installation's live source sends on its decoder login's
 * replication connection (`replication=database`), and the one SQL query it reads its stream's deadline with there,
 * printed here and nowhere else. A replication command takes no bind
 * parameter, and its slot's name is the installation's live source stem under the role space a layer reads at load
 * (core/identity.ts roleInSpace), so the runtime prints each once its slot is named. Migrate's variables filler
 * (deploy/render/variables.ts resolveVariables), the one door of every drafted role-spaced text, reads the SQL lexer,
 * which no runtime module loads, so no drafted text with a variable reaches the runtime.
 */
import { nominal } from "#compiler/core/brand.ts"
import * as Result from "#compiler/core/result.ts"
import type { LiveTextRefused } from "#compiler/live/notify.ts"

declare const replicationCommandBrand: unique symbol

/**
 * A text sent alone as a simple Query on a replication connection: a replication protocol command, or the SQL query of
 * the stream's deadline (senderTimeoutQuery), which a walsender of a database runs between its commands. Minted only
 * here.
 */
export type ReplicationCommand = string & { readonly [replicationCommandBrand]: true }

const command = nominal<string, ReplicationCommand>()

/**
 * The version of pgoutput's protocol the leader reads: 1, whose messages every later version keeps, with no streaming
 * of a transaction in progress and no two-phase commit, so each decoded transaction arrives whole at its commit.
 *
 * @formatConstant pgoutput's logical replication protocol, version 1
 */
const protocolVersion = "1"

/** An identifier, double-quoted, each `"` in it doubled. */
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A string literal, single-quoted, each `'` in it doubled. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/**
 * The bits of an LSN's high half, as `X/Y` writes it: PostgreSQL's 64-bit WAL position, its two 32-bit halves in hex.
 *
 * @formatConstant pg_lsn's text: two 32-bit halves
 */
const lsnHalfBits = 32n

/** A WAL position as its `X/Y` text: its high and low 32 bits, each in uppercase hex. */
const lsnText = (lsn: bigint): string =>
	`${(lsn >> lsnHalfBits).toString(16).toUpperCase()}/${BigInt.asUintN(Number(lsnHalfBits), lsn).toString(16).toUpperCase()}`

/**
 * CREATE_REPLICATION_SLOT <slot> LOGICAL pgoutput (SNAPSHOT 'nothing'): the installation's slot, permanent, of
 * PostgreSQL's own output plugin, exporting no snapshot, since no stream reads its first rows through one.
 */
export const createSlotCommand = (slot: string): ReplicationCommand =>
	command(`CREATE_REPLICATION_SLOT ${quoted(slot)} LOGICAL pgoutput (SNAPSHOT 'nothing')`)

/**
 * START_REPLICATION SLOT <slot> LOGICAL <from> (...): the slot's decoded changes from the WAL position `from`, 0 for
 * the position the slot last confirmed, over the publication `publication`, in pgoutput's protocol version 1 with the
 * transactional messages the installation announces.
 */
export const startCommand = (slot: string, publication: string, from: bigint): ReplicationCommand =>
	command(
		`START_REPLICATION SLOT ${quoted(slot)} LOGICAL ${lsnText(from)} (proto_version ${literal(protocolVersion)}, publication_names ${literal(quoted(publication))}, messages 'true')`
	)

/**
 * The SQL query of the replication session's own wal_sender_timeout, which the leader reads before START_REPLICATION:
 * pg_settings states an integer setting in its base unit, this one's milliseconds, so the query answers one row of one
 * cell where its unit is `ms`, and none where it is any other (parseSenderDeadline reads the cell).
 */
export const senderTimeoutQuery: ReplicationCommand = command(
	"SELECT setting FROM pg_catalog.pg_settings WHERE name = 'wal_sender_timeout' AND unit = 'ms'"
)

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
 * The deadline senderTimeoutQuery's cell states (SenderDeadline): the timeout's milliseconds, as PostgreSQL's integer
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
