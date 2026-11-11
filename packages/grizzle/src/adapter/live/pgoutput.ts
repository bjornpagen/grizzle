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
		return this.#view.getUint8(this.#take(1, what))
	}

	int16(what: string): number {
		return this.#view.getInt16(this.#take(2, what))
	}

	int32(what: string): number {
		return this.#view.getInt32(this.#take(4, what))
	}

	uint32(what: string): number {
		return this.#view.getUint32(this.#take(4, what))
	}

	uint64(what: string): bigint {
		return this.#view.getBigUint64(this.#take(8, what))
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
			case 0x6e:
				cells.push({ kind: "null" })
				break
			case 0x75:
				cells.push({ kind: "unchanged" })
				break
			case 0x74:
				cells.push({ kind: "text", text: reader.text(reader.int32("a text's length"), "a text") })
				break
			default:
				throw new MessageUnreadable({ at: "a column's kind, n, u or t" })
		}
	}
	return cells
}

const newTag = 0x4e
const keyTag = 0x4b
const oldTag = 0x4f

/** The new tuple, tagged N. */
const newTuple = (reader: Reader, what: string): Tuple => {
	if (reader.byte(what) !== newTag) {
		throw new MessageUnreadable({ at: what })
	}
	return tupleOf(reader)
}

/** An old image tagged `tag`, K or O, the byte before it. */
const oldImage = (reader: Reader, tag: number, what: string): OldImage => {
	if (tag !== keyTag && tag !== oldTag) {
		throw new MessageUnreadable({ at: what })
	}
	return { whole: tag === oldTag, tuple: tupleOf(reader) }
}

/** The flag of a Relation message's column that marks it a key column of the relation's replica identity. */
const keyFlag = 1

/** A Relation message's columns: each column's flags, name, type and modifier, its name and key flag kept. */
const columnsOf = (reader: Reader): ReadonlyArray<Column> => {
	const count = reader.int16("a relation's column count")
	const columns: Array<Column> = []
	for (let column = 0; column < count; column += 1) {
		const flags = reader.byte("a column's flags")
		columns.push({ name: reader.string("a column's name"), key: (flags & keyFlag) !== 0 })
		reader.skip(8, "a column's type and modifier")
	}
	return columns
}

/** One message from its bytes, its tag first (see the header). */
const messageOf = (reader: Reader): Message => {
	const tag = reader.byte("a message's tag")
	switch (tag) {
		case 0x42: {
			reader.skip(16, "a Begin's final LSN and timestamp")
			return { kind: "begin", xid: reader.uint32("a Begin's xid") }
		}
		case 0x43: {
			reader.skip(9, "a Commit's flags and commit LSN")
			const endLsn = reader.uint64("a Commit's end LSN")
			reader.skip(8, "a Commit's timestamp")
			return { kind: "commit", endLsn }
		}
		case 0x52: {
			const relation = reader.uint32("a Relation's OID")
			const namespace = reader.string("a Relation's namespace")
			const name = reader.string("a Relation's name")
			reader.skip(1, "a Relation's replica identity")
			return { kind: "relation", relation, namespace, name, columns: columnsOf(reader) }
		}
		case 0x49: {
			const relation = reader.uint32("an Insert's OID")
			return { kind: "insert", relation, next: newTuple(reader, "an Insert's N") }
		}
		case 0x55: {
			const relation = reader.uint32("an Update's OID")
			const image = reader.byte("an Update's K, O or N")
			if (image === newTag) {
				return { kind: "update", relation, previous: undefined, next: tupleOf(reader) }
			}
			const previous = oldImage(reader, image, "an Update's K, O or N")
			return { kind: "update", relation, previous, next: newTuple(reader, "an Update's N") }
		}
		case 0x44: {
			const relation = reader.uint32("a Delete's OID")
			const image = reader.byte("a Delete's K or O")
			return { kind: "delete", relation, previous: oldImage(reader, image, "a Delete's K or O") }
		}
		case 0x54: {
			const count = reader.int32("a Truncate's relation count")
			reader.skip(1, "a Truncate's options")
			const relations: Array<number> = []
			for (let at = 0; at < count; at += 1) {
				relations.push(reader.uint32("a Truncate's OID"))
			}
			return { kind: "truncate", relations }
		}
		case 0x4d: {
			reader.skip(9, "a Message's flags and LSN")
			const prefix = reader.string("a Message's prefix")
			const content = reader.text(reader.int32("a Message's length"), "a Message's content")
			return { kind: "message", prefix, content }
		}
		case 0x4f: {
			reader.skip(8, "an Origin's commit LSN")
			reader.string("an Origin's name")
			return { kind: "skipped" }
		}
		case 0x59: {
			reader.skip(4, "a Type's OID")
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
				case 0x77:
					reader.skip(24, "an XLogData's positions and clock")
					return { kind: "xlog", data: chunk.subarray(25) }
				case 0x6b: {
					const walEnd = reader.uint64("a keepalive's position")
					reader.skip(8, "a keepalive's clock")
					const replyRequested = reader.byte("a keepalive's reply flag") === 1
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

/** The size of a Standby Status Update: its tag, four 64-bit fields and its reply flag. */
const statusBytes = 34

/**
 * A Standby Status Update (r): `flushed` as the position written, flushed and applied, which the slot confirms, and
 * the clock `micros`, microseconds since 2000-01-01, no reply asked.
 */
export const standbyStatus = (flushed: bigint, micros: bigint): Uint8Array => {
	const bytes = new Uint8Array(statusBytes)
	const view = new DataView(bytes.buffer)
	view.setUint8(0, 0x72)
	view.setBigUint64(1, flushed)
	view.setBigUint64(9, flushed)
	view.setBigUint64(17, flushed)
	view.setBigInt64(25, micros)
	view.setUint8(33, 0)
	return bytes
}
