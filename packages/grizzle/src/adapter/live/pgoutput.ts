import { Data, Result } from "effect"

/**
 * A logical replication stream as the installation's leader reads it (live/leader.ts): each CopyData of the stream
 * START_REPLICATION opens is an XLogData, which carries one pgoutput message, or a keepalive (streamMessageOf), and the
 * leader answers with Standby Status Updates (standbyStatus), by the formats of PostgreSQL's "Streaming Replication
 * Protocol". Each pgoutput message (decodeMessage) is in protocol version 1 with logical messages and every column sent
 * as its text, the binary option never asked, by the formats of its "Logical Replication Message Formats". Each message
 * is read in one pass over its bytes, and what the leader does not read (an origin, a type, a column's type and
 * modifier, a timestamp) is stepped over.
 *
 * A column of a tuple: SQL NULL, a TOASTed value the change left unchanged and did not send, or its output text.
 */
export type Cell =
	| { readonly kind: "null" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "text"; readonly text: string }

/** A tuple's columns, in its relation's column order. */
export type Tuple = ReadonlyArray<Cell>

/**
 * The image a row had before an update or a delete: `whole`, every column (REPLICA IDENTITY FULL, tagged O), or only
 * its replica identity's key columns (tagged K), every other column sent as NULL, which says nothing of its value.
 */
export interface OldImage {
	readonly whole: boolean
	readonly tuple: Tuple
}

/** A relation's column: its name, and whether it is one of its replica identity's key columns. */
export interface Column {
	readonly name: string
	readonly key: boolean
}

/** One decoded message. */
export type Message =
	| { readonly kind: "begin"; readonly xid: number }
	| { readonly kind: "commit"; readonly endLsn: bigint }
	| {
			readonly kind: "relation"
			readonly relation: number
			readonly namespace: string
			readonly name: string
			readonly columns: ReadonlyArray<Column>
	  }
	| { readonly kind: "insert"; readonly relation: number; readonly next: Tuple }
	| {
			readonly kind: "update"
			readonly relation: number
			readonly previous: OldImage | undefined
			readonly next: Tuple
	  }
	| { readonly kind: "delete"; readonly relation: number; readonly previous: OldImage }
	| { readonly kind: "truncate"; readonly relations: ReadonlyArray<number> }
	| { readonly kind: "message"; readonly prefix: string; readonly content: string }
	| { readonly kind: "skipped" }

/**
 * A message the leader cannot read: a message cut short or longer than its format, a tag or a tuple's column kind
 * outside the format, or a text that is no UTF-8. `at` says what was being read.
 */
export class MessageUnreadable extends Data.TaggedError("MessageUnreadable")<{
	readonly at: string
}> {
	override get message(): string {
		return `a decoded change is no pgoutput message: ${this.at}`
	}
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The widths, in bytes, of the fixed-size fields every format here is made of, each in network byte order, by
 * PostgreSQL's "Message Data Types" (https://www.postgresql.org/docs/19/protocol-message-types.html): Int8 (and Byte1),
 * Int16, Int32 and Int64.
 *
 * @formatConstant the widths of Int8, Int16, Int32 and Int64
 */
const width = { int8: 1, int16: 2, int32: 4, int64: 8 } as const

/**
 * The fields of each pgoutput message the leader steps over, in bytes, by "Logical Replication Message Formats"
 * (https://www.postgresql.org/docs/19/protocol-logicalrep-message-formats.html): a Begin's final LSN and commit
 * timestamp (Int64 each); a Commit's flags (Int8) and commit LSN (Int64) before its end LSN, and its commit timestamp
 * (Int64) after it; a Relation's replica identity setting (Int8), and each of its columns' type OID and type modifier
 * (Int32 each); a Truncate's option bits (Int8); a logical Message's flags (Int8) and LSN (Int64); an Origin's commit
 * LSN (Int64); and a Type's OID (Int32).
 */
const stepped = {
	begin: width.int64 + width.int64,
	commitHead: width.int8 + width.int64,
	commitTail: width.int64,
	replicaIdentity: width.int8,
	columnType: width.int32 + width.int32,
	truncateOptions: width.int8,
	messageHead: width.int8 + width.int64,
	origin: width.int64,
	type: width.int32
} as const

/**
 * The tag byte of each pgoutput message, its first, by "Logical Replication Message Formats"
 * (https://www.postgresql.org/docs/19/protocol-logicalrep-message-formats.html): Byte1 'B', 'C', 'R', 'I', 'U', 'D',
 * 'T', 'M', 'O' and 'Y'.
 *
 * @formatConstant pgoutput's message tags, one ASCII letter each
 */
const messageTag = {
	begin: 0x42,
	commit: 0x43,
	relation: 0x52,
	insert: 0x49,
	update: 0x55,
	delete: 0x44,
	truncate: 0x54,
	message: 0x4d,
	origin: 0x4f,
	type: 0x59
} as const

/**
 * The kind byte of each column of a TupleData, by "Logical Replication Message Formats"
 * (https://www.postgresql.org/docs/19/protocol-logicalrep-message-formats.html): Byte1 'n' for NULL, 'u' for a TOASTed
 * value left unchanged and not sent, 't' for its output text ('b', binary, is sent only where asked, and never is).
 *
 * @formatConstant a TupleData column's kind: 'n', 'u' or 't'
 */
const columnKind = { null: 0x6e, unchanged: 0x75, text: 0x74 } as const

/** A forward reader over one message's bytes, failing with MessageUnreadable past its end. */
class Reader {
	readonly #bytes: Uint8Array
	readonly #view: DataView
	#at = 0

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	}

	#take(size: number, what: string): number {
		const at = this.#at
		if (at + size > this.#bytes.length) {
			throw new MessageUnreadable({ at: what })
		}
		this.#at = at + size
		return at
	}

	byte(what: string): number {
		return this.#view.getUint8(this.#take(width.int8, what))
	}

	int16(what: string): number {
		return this.#view.getInt16(this.#take(width.int16, what))
	}

	int32(what: string): number {
		return this.#view.getInt32(this.#take(width.int32, what))
	}

	uint32(what: string): number {
		return this.#view.getUint32(this.#take(width.int32, what))
	}

	uint64(what: string): bigint {
		return this.#view.getBigUint64(this.#take(width.int64, what))
	}

	skip(size: number, what: string): void {
		this.#take(size, what)
	}

	text(size: number, what: string): string {
		if (size < 0) {
			throw new MessageUnreadable({ at: what })
		}
		const at = this.#take(size, what)
		return utf8.decode(this.#bytes.subarray(at, at + size))
	}

	/** A null-terminated string. */
	string(what: string): string {
		const start = this.#at
		const end = this.#bytes.indexOf(0, start)
		if (end < 0) {
			throw new MessageUnreadable({ at: what })
		}
		this.#at = end + 1
		return utf8.decode(this.#bytes.subarray(start, end))
	}

	/** The message is read whole: a byte past its format is unreadable. */
	done(what: string): void {
		if (this.#at !== this.#bytes.length) {
			throw new MessageUnreadable({ at: what })
		}
	}
}

/** One tuple: its column count, then each column's kind and, for a text, its length and bytes. */
const tupleOf = (reader: Reader): Tuple => {
	const count = reader.int16("a tuple's column count")
	const cells: Array<Cell> = []
	for (let column = 0; column < count; column += 1) {
		const kind = reader.byte("a column's kind")
		switch (kind) {
			case columnKind.null:
				cells.push({ kind: "null" })
				break
			case columnKind.unchanged:
				cells.push({ kind: "unchanged" })
				break
			case columnKind.text:
				cells.push({ kind: "text", text: reader.text(reader.int32("a text's length"), "a text") })
				break
			default:
				throw new MessageUnreadable({ at: "a column's kind, n, u or t" })
		}
	}
	return cells
}

/**
 * The tag byte before each tuple of an Insert, an Update or a Delete, by "Logical Replication Message Formats"
 * (https://www.postgresql.org/docs/19/protocol-logicalrep-message-formats.html): Byte1 'N' for the new tuple, 'K' for
 * an old image of the replica identity's key columns, 'O' for a whole old image.
 *
 * @formatConstant a tuple's tag: 'N', 'K' or 'O'
 */
const tupleTag = { next: 0x4e, key: 0x4b, old: 0x4f } as const

/** The new tuple, tagged N. */
const newTuple = (reader: Reader, what: string): Tuple => {
	if (reader.byte(what) !== tupleTag.next) {
		throw new MessageUnreadable({ at: what })
	}
	return tupleOf(reader)
}

/** An old image tagged `tag`, K or O, the byte before it. */
const oldImage = (reader: Reader, tag: number, what: string): OldImage => {
	if (tag !== tupleTag.key && tag !== tupleTag.old) {
		throw new MessageUnreadable({ at: what })
	}
	return { whole: tag === tupleTag.old, tuple: tupleOf(reader) }
}

/**
 * The flag of a Relation message's column that marks it a key column of the relation's replica identity, by "Logical
 * Replication Message Formats" (https://www.postgresql.org/docs/19/protocol-logicalrep-message-formats.html): "Flags for
 * the column. Currently can be either 0 for no flags or 1 which marks the column as part of the key."
 *
 * @formatConstant a Relation column's key flag, bit 1
 */
const keyFlag = 1

/** A Relation message's columns: each column's flags, name, type and modifier, its name and key flag kept. */
const columnsOf = (reader: Reader): ReadonlyArray<Column> => {
	const count = reader.int16("a relation's column count")
	const columns: Array<Column> = []
	for (let column = 0; column < count; column += 1) {
		const flags = reader.byte("a column's flags")
		columns.push({ name: reader.string("a column's name"), key: (flags & keyFlag) !== 0 })
		reader.skip(stepped.columnType, "a column's type and modifier")
	}
	return columns
}

/** One message from its bytes, its tag first (see the header). */
const messageOf = (reader: Reader): Message => {
	const tag = reader.byte("a message's tag")
	switch (tag) {
		case messageTag.begin: {
			reader.skip(stepped.begin, "a Begin's final LSN and timestamp")
			return { kind: "begin", xid: reader.uint32("a Begin's xid") }
		}
		case messageTag.commit: {
			reader.skip(stepped.commitHead, "a Commit's flags and commit LSN")
			const endLsn = reader.uint64("a Commit's end LSN")
			reader.skip(stepped.commitTail, "a Commit's timestamp")
			return { kind: "commit", endLsn }
		}
		case messageTag.relation: {
			const relation = reader.uint32("a Relation's OID")
			const namespace = reader.string("a Relation's namespace")
			const name = reader.string("a Relation's name")
			reader.skip(stepped.replicaIdentity, "a Relation's replica identity")
			return { kind: "relation", relation, namespace, name, columns: columnsOf(reader) }
		}
		case messageTag.insert: {
			const relation = reader.uint32("an Insert's OID")
			return { kind: "insert", relation, next: newTuple(reader, "an Insert's N") }
		}
		case messageTag.update: {
			const relation = reader.uint32("an Update's OID")
			const image = reader.byte("an Update's K, O or N")
			if (image === tupleTag.next) {
				return { kind: "update", relation, previous: undefined, next: tupleOf(reader) }
			}
			const previous = oldImage(reader, image, "an Update's K, O or N")
			return { kind: "update", relation, previous, next: newTuple(reader, "an Update's N") }
		}
		case messageTag.delete: {
			const relation = reader.uint32("a Delete's OID")
			const image = reader.byte("a Delete's K or O")
			return { kind: "delete", relation, previous: oldImage(reader, image, "a Delete's K or O") }
		}
		case messageTag.truncate: {
			const count = reader.int32("a Truncate's relation count")
			reader.skip(stepped.truncateOptions, "a Truncate's options")
			const relations: Array<number> = []
			for (let at = 0; at < count; at += 1) {
				relations.push(reader.uint32("a Truncate's OID"))
			}
			return { kind: "truncate", relations }
		}
		case messageTag.message: {
			reader.skip(stepped.messageHead, "a Message's flags and LSN")
			const prefix = reader.string("a Message's prefix")
			const content = reader.text(reader.int32("a Message's length"), "a Message's content")
			return { kind: "message", prefix, content }
		}
		case messageTag.origin: {
			reader.skip(stepped.origin, "an Origin's commit LSN")
			reader.string("an Origin's name")
			return { kind: "skipped" }
		}
		case messageTag.type: {
			reader.skip(stepped.type, "a Type's OID")
			reader.string("a Type's namespace")
			reader.string("a Type's name")
			return { kind: "skipped" }
		}
		default:
			throw new MessageUnreadable({ at: "a message's tag" })
	}
}

/** A read of `bytes` by `read`, which reads them whole, or why they are unreadable. */
const readWhole = <A>(
	bytes: Uint8Array,
	read: (reader: Reader) => A
): Result.Result<A, MessageUnreadable> =>
	Result.try({
		try: () => {
			const reader = new Reader(bytes)
			const message = read(reader)
			reader.done("a message's end")
			return message
		},
		catch: (thrown) =>
			thrown instanceof MessageUnreadable
				? thrown
				: new MessageUnreadable({ at: "a text that is no UTF-8" })
	})

/** One pgoutput message from its bytes (see the header), or why it is unreadable. */
export const decodeMessage = (bytes: Uint8Array): Result.Result<Message, MessageUnreadable> =>
	readWhole(bytes, messageOf)

/** One message of a replication stream: an XLogData's pgoutput message's bytes, or a keepalive. */
export type StreamMessage =
	| { readonly kind: "xlog"; readonly data: Uint8Array }
	| { readonly kind: "keepalive"; readonly walEnd: bigint; readonly replyRequested: boolean }

/**
 * The tag byte of each message of the streaming replication protocol the leader reads or sends, its first, by
 * "Streaming Replication Protocol" (https://www.postgresql.org/docs/19/protocol-replication.html): Byte1 'w' for
 * XLogData and 'k' for a primary keepalive, from the server, and 'r' for a Standby Status Update, to it.
 *
 * @formatConstant the streaming replication protocol's message tags, one ASCII letter each
 */
const streamTag = { xlog: 0x77, keepalive: 0x6b, status: 0x72 } as const

/**
 * The fields of an XLogData the leader steps over, in bytes, by "Streaming Replication Protocol"
 * (https://www.postgresql.org/docs/19/protocol-replication.html): the starting point of its WAL data, the current end of
 * WAL on the server and the server's clock, Int64 each, which its tag leads and its data follows.
 */
const xlogHead = width.int64 + width.int64 + width.int64

/**
 * The value of a keepalive's or a status update's last byte that asks the other side to reply at once, by "Streaming
 * Replication Protocol" (https://www.postgresql.org/docs/19/protocol-replication.html): "1 means that the client should
 * reply to this message as soon as possible", 0 that it need not.
 *
 * @formatConstant a replication message's reply flag: 1 asks a reply, 0 does not
 */
const reply = { asked: 1, unasked: 0 } as const

/**
 * One CopyData of a replication stream: XLogData (w), its start and end positions and its clock stepped over and the
 * rest its message; or a primary keepalive (k), the position the server has sent the stream to, its clock stepped
 * over, then whether the server asks a reply at once.
 */
export const streamMessageOf = (
	chunk: Uint8Array
): Result.Result<StreamMessage, MessageUnreadable> =>
	Result.try({
		try: (): StreamMessage => {
			const reader = new Reader(chunk)
			switch (reader.byte("a stream message's tag")) {
				case streamTag.xlog:
					reader.skip(xlogHead, "an XLogData's positions and clock")
					return { kind: "xlog", data: chunk.subarray(width.int8 + xlogHead) }
				case streamTag.keepalive: {
					const walEnd = reader.uint64("a keepalive's position")
					reader.skip(width.int64, "a keepalive's clock")
					const replyRequested = reader.byte("a keepalive's reply flag") === reply.asked
					reader.done("a keepalive's end")
					return { kind: "keepalive", walEnd, replyRequested }
				}
				default:
					throw new MessageUnreadable({ at: "a stream message's tag, w or k" })
			}
		},
		catch: (thrown) =>
			thrown instanceof MessageUnreadable
				? thrown
				: new MessageUnreadable({ at: "a stream message" })
	})

/**
 * The offsets of a Standby Status Update's fields, in bytes, by "Streaming Replication Protocol"
 * (https://www.postgresql.org/docs/19/protocol-replication.html): its tag (Byte1), then the positions written, flushed
 * and applied and the client's clock (Int64 each), then its reply flag (Byte1), its last; each offset is the one before
 * it and that field's width.
 */
const statusWritten = width.int8

const statusFlushed = statusWritten + width.int64

const statusApplied = statusFlushed + width.int64

const statusClock = statusApplied + width.int64

const statusReply = statusClock + width.int64

/** The size of a Standby Status Update, in bytes: its reply flag's offset and width. */
const statusSize = statusReply + width.int8

/**
 * A Standby Status Update (r): `flushed` as the position written, flushed and applied, which the slot confirms, and
 * the clock `micros`, microseconds since 2000-01-01, no reply asked.
 */
export const standbyStatus = (flushed: bigint, micros: bigint): Uint8Array => {
	const bytes = new Uint8Array(statusSize)
	const view = new DataView(bytes.buffer)
	view.setUint8(0, streamTag.status)
	view.setBigUint64(statusWritten, flushed)
	view.setBigUint64(statusFlushed, flushed)
	view.setBigUint64(statusApplied, flushed)
	view.setBigInt64(statusClock, micros)
	view.setUint8(statusReply, reply.unasked)
	return bytes
}
