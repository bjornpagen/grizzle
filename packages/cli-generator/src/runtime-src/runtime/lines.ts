import { Array as Arr } from "effect"

const lineFeed = 0x0a

const carriageReturn = 0x0d

/**
 * One line a chunk ended: its bytes, without the line end, and the offset in the chunk just past the line end.
 */
export interface EndedLine {
	readonly bytes: Uint8Array
	readonly end: number
}

/**
 * A reader of the lines of bytes that arrive in chunks, as an event stream (WHATWG HTML) and NDJSON end them: LF, CR
 * and CRLF each end a line, a CRLF split across chunks included. A line's bytes are joined once it ends, so a line
 * reads the same whatever the chunks, and its reader decodes it whole: LF and CR are ASCII, never part of a UTF-8
 * multi-byte sequence, so no line end cuts a character.
 */
export interface LineReader {
	/** The lines a chunk ends, in order. */
	readonly step: (chunk: Uint8Array) => ReadonlyArray<EndedLine>
	/** How many bytes of the line not yet ended have arrived. */
	readonly pending: () => number
	/** The first `count` bytes of the line not yet ended, or fewer when fewer have arrived. */
	readonly head: (count: number) => Uint8Array
	/** The bytes of the line not yet ended, which the body's end leaves unended. */
	readonly rest: () => Uint8Array
}

/**
 * The pieces of a line that crossed chunk ends and the piece that ends it, as one array.
 */
export const joined = (pieces: ReadonlyArray<Uint8Array>, last: Uint8Array): Uint8Array => {
	if (pieces.length === 0) {
		return last
	}

	const line = new Uint8Array(
		Arr.reduce(pieces, last.length, (length, piece) => length + piece.length)
	)
	let offset = 0
	for (const piece of [...pieces, last]) {
		line.set(piece, offset)
		offset += piece.length
	}

	return line
}

/**
 * The first `count` bytes of the pieces of a line, or fewer when the pieces hold fewer.
 */
const leading = (pieces: ReadonlyArray<Uint8Array>, count: number): Uint8Array => {
	const head = new Uint8Array(count)
	let filled = 0
	for (const piece of pieces) {
		const taken = piece.subarray(0, count - filled)
		head.set(taken, filled)
		filled += taken.length
	}

	return head.subarray(0, filled)
}

/**
 * The first line end at or after `from`: the first CR or LF, or -1.
 */
const lineEnd = (chunk: Uint8Array, from: number): number => {
	const feed = chunk.indexOf(lineFeed, from)
	const ret = chunk.indexOf(carriageReturn, from)

	return feed === -1 || (ret !== -1 && ret < feed) ? ret : feed
}

/**
 * Build the reader of one body's lines (LineReader), before its first chunk.
 */
export const lineReader = (): LineReader => {
	const pieces: Array<Uint8Array> = []
	const state = { afterCarriageReturn: false, pending: 0 }

	return {
		head: (count) => leading(pieces, count),
		pending: () => state.pending,
		rest: () => joined(pieces, new Uint8Array(0)),
		step: (chunk) => {
			const lines: Array<EndedLine> = []
			let position = state.afterCarriageReturn && chunk[0] === lineFeed ? 1 : 0
			state.afterCarriageReturn &&= chunk.length === 0
			while (position < chunk.length) {
				const stop = lineEnd(chunk, position)
				if (stop === -1) {
					pieces.push(chunk.subarray(position))
					state.pending += chunk.length - position

					return lines
				}

				const bytes = joined(pieces, chunk.subarray(position, stop))
				pieces.length = 0
				state.pending = 0
				const returned = chunk[stop] === carriageReturn
				state.afterCarriageReturn = returned && stop + 1 === chunk.length
				position = stop + (returned && chunk[stop + 1] === lineFeed ? 2 : 1)
				lines.push({ bytes, end: position })
			}

			return lines
		}
	}
}
