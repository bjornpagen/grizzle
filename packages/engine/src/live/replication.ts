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
import { nominal } from "#compiler/core/brand.ts"
import * as Result from "#compiler/core/result.ts"
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

/** An identifier, double-quoted, each `"` in it doubled. */
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A string literal, single-quoted, each `'` in it doubled. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

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
 * 0/0 asks for, over the publication `publication`, in pgoutput's protocol version 1 with the transactional messages
 * the installation announces.
 */
export const startTemplate = (publication: string): SlotText => ({
	before: "START_REPLICATION SLOT ",
	after: ` LOGICAL 0/0 (proto_version ${literal(protocolVersion)}, publication_names ${literal(quoted(publication))}, messages 'true')`
})

/** The served command `template` over the slot `slot` (served/forms.ts SlotCommand). */
export const slotCommand = (template: SlotText, slot: string): ReplicationCommand =>
	command(`${template.before}${quoted(slot)}${template.after}`)

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
