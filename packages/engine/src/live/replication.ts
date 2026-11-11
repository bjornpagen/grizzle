/**
 * The replication protocol commands the leader of an installation's live source sends on its decoder login's
 * replication connection (`replication=database`), printed here and nowhere else. A replication command takes no bind
 * parameter, and its slot's name is the installation's live source stem under the role space a layer reads at load
 * (core/identity.ts roleInSpace), so the runtime prints each once its slot is named. Migrate's variables filler
 * (deploy/render/variables.ts resolveVariables), the one door of every drafted role-spaced text, reads the SQL lexer,
 * which no runtime module loads, so no drafted text with a variable reaches the runtime.
 */
import { nominal } from "#compiler/core/brand.ts"

declare const replicationCommandBrand: unique symbol

/** A replication protocol command, sent as a simple query on a replication connection. Minted only here. */
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
