import { utf8Chunks, utf8Text, type Json } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { Effect, Option, Result, Stream } from "effect"
import { isJson } from "#model/json-tree.ts"
import { parseJson } from "#runtime/json.ts"
import {
	anything,
	integer,
	member,
	members,
	optionalMember,
	type Reader,
	refine,
	string,
	struct
} from "#runtime/read.ts"

/**
 * What a generated CLI printed or sent, read back by a test: its output's text, a JSON text's value, and the one line
 * `--error-format json` prints. A test reads these through this module alone, so each format has one reader here.
 */

/** Why a test reads a generated CLI's bytes as UTF-8 text. */
const WHY = "a generated CLI writes and sends text in UTF-8"

/**
 * The text a generated CLI wrote to stdout or stderr, or a request body it sent, as UTF-8 reads it. Bytes that are no
 * UTF-8 fail the case: the CLI writes text, and grizzle-text's decoder neither strips a byte order mark nor patches a
 * malformed sequence, so the text is the bytes' own.
 */
export const printedText = (bytes: Uint8Array): string => defined(utf8Text(bytes), WHY)

/**
 * The text a generated CLI writes, chunk by chunk as it writes it, read by one UTF-8 reader across the chunks, so a
 * sequence a chunk boundary cuts is read whole with the next chunk. Its last chunk is the reader's end, empty; bytes
 * that are no UTF-8, or a sequence the last chunk leaves cut, fail the case as printedText's do.
 */
export const printedChunks = <E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<string, E, R> =>
	Stream.suspend(() => {
		const reader = utf8Chunks()
		return Stream.concat(
			Stream.map(bytes, (chunk) => defined(reader.chunk(chunk), WHY)),
			Stream.fromEffect(Effect.sync(() => defined(reader.end(), WHY)))
		)
	})

/** A JSON text's value; none when the text is no JSON text, or spells a number too large for a double. */
export const printedJson = (text: string): Option.Option<Json> =>
	Option.filter(Result.getSuccess(parseJson(text)), isJson)

/**
 * The `{"error":{...}}` object `--error-format json` prints, member by member as the runtime's ErrorFields writes them
 * (runtime-src/runtime/output.ts jsonLine): its kind and message always; the error body as `body` or, for a failure
 * event whose data is JSON, that data as `data`; the API error's matched response key, status, request id and capped
 * `Retry-After` in seconds; the operation of the classes that carry one. A member it holds that the runtime never
 * writes makes the line no error line.
 */
export type PrintedError = Readonly<{
	body: Option.Option<string>
	data: Option.Option<Json>
	kind: string
	matched: Option.Option<string>
	message: string
	operation: Option.Option<string>
	requestId: Option.Option<string>
	retryAfter: Option.Option<number>
	status: Option.Option<number>
}>

/** A member that holds any JSON value. */
const json: Reader<Json> = refine(anything, isJson, "a JSON value")

/** The error object's members, the runtime's and no other. */
const printedError: Reader<PrintedError> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				body: optionalMember(object, "body", string),
				data: optionalMember(object, "data", json),
				kind: member(object, "kind", string),
				matched: optionalMember(object, "matched", string),
				message: member(object, "message", string),
				operation: optionalMember(object, "operation", string),
				requestId: optionalMember(object, "requestId", string),
				retryAfter: optionalMember(object, "retryAfter", integer),
				status: optionalMember(object, "status", integer)
			},
			false
		)
	)

/** The one line: an object of the single member `error`. */
const errorLine: Reader<PrintedError> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(object, { error: member(object, "error", printedError) }, false),
			(line) => line.error
		)
	)

/** A stderr line's error object when the line is one `--error-format json` prints, none for every other line. */
export const errorLineOf = (line: string): Option.Option<PrintedError> =>
	Option.flatMap(Result.getSuccess(parseJson(line)), (value) => Result.getSuccess(errorLine(value)))
