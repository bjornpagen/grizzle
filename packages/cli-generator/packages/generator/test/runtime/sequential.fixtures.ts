/** What the properties of sequential.test.ts read: drawn NDJSON and JSON-seq bodies, and the records they frame as. */

import {
	type Aimed,
	aimed,
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	recursive,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Option,
	Order,
	Ref,
	Stream,
	String as Str
} from "effect"
import { jsonSeqRecords, ndjsonRecords } from "#runtime-src/runtime/sequential.ts"

const encoder = new TextEncoder()

const RS = "\u001E"

/** A JSON text as tokens: the compact text is their concatenation, a rendering puts whitespace between them. */
type Tokens = ReadonlyArray<string>

/** Number literals as a server writes them: past 2^53, with trailing zeros, exponents and signs, kept byte for byte. */
const NUMBERS: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"1",
	"-12",
	"9007199254740993",
	"1.50",
	"-1.5e+3",
	"2e10",
	"0.000",
	"-0"
]

/** Characters of a string's body as written: escapes kept as escapes, a raw U+2028, wide and astral characters. */
const STRING_PARTS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	" ",
	'\\"',
	"\\\\",
	"\\u0009",
	"\\ud800",
	" ",
	"é",
	"😀",
	"\\n",
	"x"
]

const stringToken: Gen<string> = map(
	string(characterOf(STRING_PARTS), { min: 0, max: 6 }),
	(body) => `"${body}"`
)

const scalarTokens: Gen<Tokens> = oneOf<Tokens>([
	map(element(NUMBERS), (text) => [text]),
	map(stringToken, (text) => [text]),
	map(element(["true", "false", "null"]), (text) => [text])
])

const joinedWith = (open: string, close: string, items: ReadonlyArray<Tokens>): Tokens => [
	open,
	...Arr.flatMap(items, (item, at) => (at === 0 ? item : [",", ...item])),
	close
]

/** A JSON text up to three levels deep, as tokens. */
const valueTokens: Gen<Tokens> = recursive<Tokens>(
	scalarTokens,
	(inner) =>
		oneOf<Tokens>([
			map(array(inner, { min: 0, max: 3 }), (items) => joinedWith("[", "]", items)),
			map(
				array((s) => [s.draw(stringToken), ":", ...s.draw(inner)], { min: 0, max: 3 }),
				(members) => joinedWith("{", "}", members)
			)
		]),
	3
)

/** Whitespace between two tokens of a record. */
const gap = (lineFeeds: boolean): Gen<string> =>
	weighted([
		[6, constant("")],
		[2, constant(" ")],
		[1, constant("\t")],
		[1, constant(lineFeeds ? "\n  " : " \t ")]
	])

/**
 * A record of a sequential body: valid JSON as tokens and the whitespace drawn between them; one the compactor would
 * change; one cut short inside an open container; or, in JSON-seq, text after a record's closing LF.
 */
export type SeqRecord =
	| Readonly<{ kind: "valid"; tokens: Tokens; gaps: ReadonlyArray<string> }>
	| Readonly<{ kind: "malformed"; text: string }>
	| Readonly<{ kind: "cut"; text: string }>
	| Readonly<{ kind: "stray"; text: string }>

/** Records the compactor would change: an unopened close, a raw tab in a string, values apart only by whitespace. */
const malformed: Gen<SeqRecord> = map(
	oneOf<string>([
		constant("]"),
		map(element(["x", "é"]), (inner) => `{"a":"${inner}\ty"}`),
		map(element(NUMBERS), (number) => `${number} 2`),
		constant('{"a":1} {"b":2}')
	]),
	(text): SeqRecord => ({ kind: "malformed", text })
)

const validOf =
	(lineFeeds: boolean, values: Gen<Tokens>): Gen<SeqRecord> =>
	(s) => {
		const tokens = s.draw(values)
		return {
			kind: "valid",
			tokens,
			gaps: Array.from({ length: Math.max(0, tokens.length - 1) }, () =>
				s.draw(gap(lineFeeds && tokens.length > 1))
			)
		}
	}

/** A container cut before its close: a string or a container left open. */
const cut: Gen<SeqRecord> = map(
	oneOf<string>([constant('{"a":"b'), constant('{"a":[1,2'), constant("[1,"), constant('["x')]),
	(text): SeqRecord => ({ kind: "cut", text })
)

/** A drawn body: its framing, its records in order, the bound on a record, and where its bytes are cut into chunks. */
export type Body = Readonly<{
	framing: "ndjson" | "jsonseq"
	records: ReadonlyArray<SeqRecord>
	bound: number
	cuts: ReadonlyArray<number>
	noise: ReadonlyArray<number>
	lead: boolean
	terminators: ReadonlyArray<"\n" | "\r\n">
}>

const recordOf = (lineFeeds: boolean, framing: Body["framing"]): Gen<SeqRecord> =>
	weighted<SeqRecord>([
		[12, validOf(lineFeeds, valueTokens)],
		[1, malformed],
		[1, cut],
		...(framing === "jsonseq"
			? [[1, map(element(NUMBERS), (text): SeqRecord => ({ kind: "stray", text }))] as const]
			: [])
	])

const bodyOf =
	(
		framings: Gen<Body["framing"]>,
		records: (framing: Body["framing"]) => Gen<ReadonlyArray<SeqRecord>>
	): Gen<Body> =>
	(s) => {
		const framing = s.draw(framings)
		const drawn = s.draw(records(framing))
		return {
			framing,
			records: drawn,
			bound: s.draw(int(24, 96)),
			cuts: s.draw(array(int(0, 1000), { min: 0, max: 4 })),
			noise: s.draw(array(int(0, 3), { min: drawn.length, max: drawn.length })),
			lead: s.draw(
				weighted([
					[3, constant(false)],
					[1, constant(true)]
				])
			),
			terminators: s.draw(
				array(
					weighted([
						[3, constant<"\n" | "\r\n">("\n")],
						[1, constant<"\n" | "\r\n">("\r\n")]
					]),
					{
						min: drawn.length,
						max: drawn.length
					}
				)
			)
		}
	}

const framing: Gen<Body["framing"]> = element<Body["framing"]>(["ndjson", "jsonseq"])

const drawnRecords = (framingOf: Body["framing"]): Gen<ReadonlyArray<SeqRecord>> =>
	array(recordOf(framingOf === "jsonseq", framingOf), { min: 0, max: 5 })

/** The record's text as written. */
const writtenOf = (record: SeqRecord): string => {
	switch (record.kind) {
		case "valid":
			return Arr.join(
				Arr.map(
					record.tokens,
					(token, at) => `${at === 0 ? "" : (record.gaps[at - 1] ?? "")}${token}`
				),
				""
			)
		case "malformed":
		case "cut":
		case "stray":
			return record.text
	}
}

const utf8 = (text: string): number => encoder.encode(text).length

/** The blank text a body puts after a record: nothing, spaces, a tab, or (NDJSON) a blank line. */
const noiseOf = (body: Body, at: number): string => {
	const kind = body.records[at + 1]?.kind === "stray" ? 0 : (body.noise[at] ?? 0)
	if (body.framing === "ndjson") {
		return ["", " \t\n", "\n", "  \r\n"][kind] ?? ""
	}
	return ["", " ", `${RS}${RS}`, `${RS} \n`][kind] ?? ""
}

/** The body's text: its records framed as the framing writes them, with blank text between them. */
const textOf = (body: Body): string => {
	if (body.framing === "ndjson") {
		return `${body.lead ? " \n" : ""}${Arr.join(
			Arr.map(
				body.records,
				(record, at) => `${writtenOf(record)}${body.terminators[at] ?? "\n"}${noiseOf(body, at)}`
			),
			""
		)}`
	}
	return `${body.lead ? " \r\n" : ""}${Arr.join(
		Arr.map(body.records, (record, at) =>
			record.kind === "stray"
				? `${record.text}\n`
				: `${RS}${writtenOf(record)}${record.kind === "cut" ? "" : (body.terminators[at] ?? "\n")}${noiseOf(body, at)}`
		),
		""
	)}`
}

/** What framing gives: the records emitted in order, then the failure that ended the stream, if any. */
export type Framed = Readonly<{
	records: ReadonlyArray<string>
	failure: Option.Option<readonly [string, number]>
}>

/**
 * What the specification frames a body as: each valid record compacted (its tokens with no whitespace between them),
 * in order, until the first record that fails. A record past the bound (its UTF-8 bytes as written, its terminator not
 * counted) fails as recordTooLarge, one the compactor would change as invalidFraming, one cut short as truncated;
 * text after a JSON-seq record's closing LF fails as invalidFraming at the next record's index. Blank lines, empty
 * JSON-seq records and leading whitespace take no index.
 */
export const expectedOf = (body: Body): Framed => {
	const records: Array<string> = []
	for (const [position, record] of body.records.entries()) {
		const index = records.length
		const fail = (reason: string): Framed => ({
			records,
			failure: Option.some([reason, index] as const)
		})
		if (record.kind === "stray") {
			return fail("invalidFraming")
		}
		const carriageReturn =
			body.framing === "jsonseq" && body.terminators[position] === "\r\n" ? 1 : 0
		if (utf8(writtenOf(record)) + carriageReturn > body.bound) {
			return fail("recordTooLarge")
		}
		switch (record.kind) {
			case "malformed":
				return fail("invalidFraming")
			case "cut":
				return fail("truncated")
			case "valid":
				records.push(Arr.join(record.tokens, ""))
		}
	}
	return { records, failure: Option.none() }
}

/** The body's bytes, cut into chunks at each of `cuts` (thousandths of its length). */
const chunksOf = (body: Body): ReadonlyArray<Uint8Array> => {
	const bytes = encoder.encode(textOf(body))
	const at = Arr.dedupe(
		Arr.sort(
			Arr.map(body.cuts, (one) => Math.floor((one * bytes.length) / 1000)),
			Order.Number
		)
	)
	const bounds = [0, ...at, bytes.length]
	return Arr.map(Arr.zip(Arr.dropRight(bounds, 1), Arr.drop(bounds, 1)), ([from, to]) =>
		bytes.subarray(from, to)
	)
}

/** What the runtime frames the body's chunks as. */
export const actualOf = (body: Body) =>
	Effect.gen(function* () {
		const emitted = yield* Ref.make<ReadonlyArray<string>>([])
		const framer =
			body.framing === "ndjson" ? ndjsonRecords(body.bound) : jsonSeqRecords(body.bound)
		const exit = yield* Effect.exit(
			Stream.fromIterable(chunksOf(body)).pipe(
				framer,
				Stream.runForEach((record) => Ref.update(emitted, Arr.append(record)))
			)
		)
		const records = yield* Ref.get(emitted)
		const framed: Framed = {
			records,
			failure: Exit.match(exit, {
				onSuccess: (): Option.Option<readonly [string, number]> => Option.none(),
				onFailure: (cause) =>
					Option.map(
						Cause.findErrorOption(cause),
						(error) => [error.reason, error.itemIndex ?? -1] as const
					)
			})
		}
		return framed
	})

export type BodyFeature =
	| "NDJSON"
	| "JSON-seq"
	| "a number past 2^53"
	| "an escape kept as written"
	| "a raw U+2028"
	| "whitespace inside a record"
	| "a line feed inside a JSON-seq record"
	| "a CRLF terminator"
	| "a blank line or an empty record"
	| "leading whitespace"
	| "a record split across chunks"
	| "a record exactly at the bound"
	| "a record one byte past the bound"
	| "a wide character in a bounded record"
	| "a record the compactor would change"
	| "a record cut short"
	| "text after a JSON-seq record"

export const bodyFeatures = (body: Body): ReadonlyArray<BodyFeature> => {
	const when = (holds: boolean, feature: BodyFeature): ReadonlyArray<BodyFeature> =>
		holds ? [feature] : []
	const valid = Arr.flatMap(body.records, (record) => (record.kind === "valid" ? [record] : []))
	const written = Arr.map(valid, writtenOf)
	const compact = Arr.map(valid, (record) => Arr.join(record.tokens, ""))
	const chunks = chunksOf(body)
	return [
		body.framing === "ndjson" ? "NDJSON" : "JSON-seq",
		...when(Arr.some(compact, Str.includes("9007199254740993")), "a number past 2^53"),
		...when(
			Arr.some(compact, (text) => Str.includes("\\u")(text) || Str.includes('\\"')(text)),
			"an escape kept as written"
		),
		...when(Arr.some(compact, Str.includes(" ")), "a raw U+2028"),
		...when(
			Arr.some(written, (text, at) => text !== Arr.getUnsafe(compact, at)),
			"whitespace inside a record"
		),
		...when(
			body.framing === "jsonseq" && Arr.some(written, Str.includes("\n")),
			"a line feed inside a JSON-seq record"
		),
		...when(
			Arr.some(body.terminators, (terminator) => terminator === "\r\n") &&
				Arr.isReadonlyArrayNonEmpty(body.records),
			"a CRLF terminator"
		),
		...when(
			Arr.some(body.noise, (kind) => kind >= 2) && Arr.isReadonlyArrayNonEmpty(body.records),
			"a blank line or an empty record"
		),
		...when(body.lead, "leading whitespace"),
		...when(
			chunks.length > 1 && Arr.isReadonlyArrayNonEmpty(body.records),
			"a record split across chunks"
		),
		...when(
			Arr.some(written, (text) => utf8(text) === body.bound),
			"a record exactly at the bound"
		),
		...when(
			Arr.some(body.records, (record) => utf8(writtenOf(record)) === body.bound + 1),
			"a record one byte past the bound"
		),
		...when(
			Arr.some(written, (text) => utf8(text) > text.length && utf8(text) > body.bound - 4),
			"a wide character in a bounded record"
		),
		...when(
			Arr.some(body.records, (record) => record.kind === "malformed"),
			"a record the compactor would change"
		),
		...when(
			Arr.some(body.records, (record) => record.kind === "cut"),
			"a record cut short"
		),
		...when(
			Arr.some(body.records, (record) => record.kind === "stray"),
			"text after a JSON-seq record"
		)
	]
}

/** A string record of `bytes` UTF-8 bytes as written: quotes around `x`s, or wide characters where `wide`. */
const sizedString = (bytes: number, wide: boolean): SeqRecord => {
	const inner = wide
		? `${Str.repeat(Math.floor((bytes - 2) / 2))("é")}${Str.repeat((bytes - 2) % 2)("x")}`
		: Str.repeat(bytes - 2)("x")
	return { kind: "valid", tokens: [`"${inner}"`], gaps: [] }
}

/** A body of drawn records with one more appended, built by `last` from the body's bound. */
const withLast =
	(framings: Gen<Body["framing"]>, last: (bound: number) => Gen<SeqRecord>): Gen<Body> =>
	(s) => {
		const base = s.draw(
			bodyOf(framings, (framingOf) =>
				array(validOf(framingOf === "jsonseq", valueTokens), { min: 0, max: 2 })
			)
		)
		const appended = s.draw(last(base.bound))
		return {
			...base,
			records: [...base.records, appended],
			noise: [...base.noise, 0],
			terminators: [...base.terminators, "\n"]
		}
	}

/** One to four records, valid but for what the aim adds. */
const someRecords = (framingOf: Body["framing"]): Gen<ReadonlyArray<SeqRecord>> =>
	array(validOf(framingOf === "jsonseq", valueTokens), { min: 1, max: 4 })

const validRecord = (tokens: Tokens, gaps: ReadonlyArray<string>): SeqRecord => ({
	kind: "valid",
	tokens,
	gaps
})

/** Bodies of drawn records, aimed at each pending situation by a body built to reach it. */
export const bodies: Aimed<Body, BodyFeature> = aimed(bodyOf(framing, drawnRecords), [
	["NDJSON", bodyOf(constant<Body["framing"]>("ndjson"), drawnRecords)],
	["JSON-seq", bodyOf(constant<Body["framing"]>("jsonseq"), drawnRecords)],
	[
		"a number past 2^53",
		withLast(framing, () =>
			constant(validRecord(["{", '"a"', ":", "9007199254740993", "}"], [" ", "", " ", ""]))
		)
	],
	[
		"an escape kept as written",
		withLast(framing, () => constant(validRecord(["[", '"\\"x\\ud800"', "]"], ["", ""])))
	],
	["a raw U+2028", withLast(framing, () => constant(validRecord(['"a\u2028b"'], [])))],
	[
		"whitespace inside a record",
		withLast(framing, () => constant(validRecord(["[", "1", ",", "2", "]"], [" ", " ", "\t", " "])))
	],
	[
		"a line feed inside a JSON-seq record",
		withLast(constant<Body["framing"]>("jsonseq"), () =>
			constant(validRecord(["{", '"a"', ":", "1", "}"], ["\n  ", "", " ", "\n"]))
		)
	],
	[
		"a CRLF terminator",
		map(bodyOf(framing, someRecords), (body): Body => ({
			...body,
			terminators: Arr.map(body.terminators, () => "\r\n")
		}))
	],
	[
		"a blank line or an empty record",
		map(bodyOf(framing, someRecords), (body): Body => ({
			...body,
			noise: Arr.map(body.noise, () => 2)
		}))
	],
	[
		"leading whitespace",
		map(bodyOf(framing, someRecords), (body): Body => ({ ...body, lead: true }))
	],
	[
		"a record split across chunks",
		map(bodyOf(framing, someRecords), (body): Body => ({ ...body, cuts: [500] }))
	],
	[
		"a record exactly at the bound",
		withLast(framing, (bound) => constant(sizedString(bound, false)))
	],
	[
		"a record one byte past the bound",
		withLast(framing, (bound) => constant(sizedString(bound + 1, false)))
	],
	[
		"a wide character in a bounded record",
		withLast(framing, (bound) => constant(sizedString(bound + 1, true)))
	],
	["a record the compactor would change", withLast(framing, () => malformed)],
	["a record cut short", withLast(framing, () => cut)],
	[
		"text after a JSON-seq record",
		withLast(constant<Body["framing"]>("jsonseq"), () =>
			map(element(NUMBERS), (text): SeqRecord => ({ kind: "stray", text }))
		)
	]
])

/** JSON-seq records each in a chunk of its own, ending at its LF, for the order of pulls and records. */
export type Paced = ReadonlyArray<SeqRecord>

export const paced: Gen<Paced> = array(validOf(false, valueTokens), { min: 1, max: 5 })

const pacedChunk = (record: SeqRecord): string => `${RS}${writtenOf(record)}\n`

/**
 * What the specification says a paced body's framing does: each record is emitted as its LF arrives, before the next
 * chunk is pulled: pull 0, record 0, pull 1, record 1, and so on.
 */
export const pacedExpected = (records: Paced): ReadonlyArray<string> =>
	Arr.flatMap(records, (record, at) => [
		`pull ${at}`,
		record.kind === "valid" ? Arr.join(record.tokens, "") : ""
	])

/** What the framing does with a paced body: each pull of a chunk and each record emitted, in order. */
export const pacedActual = (records: Paced) =>
	Effect.gen(function* () {
		const log = yield* Ref.make<ReadonlyArray<string>>([])
		const chunks = Arr.map(records, pacedChunk)
		const body = Stream.paginate(0, (at: number) =>
			Effect.as(Ref.update(log, Arr.append(`pull ${at}`)), [
				[encoder.encode(chunks[at] ?? "")],
				at + 1 < chunks.length ? Option.some(at + 1) : Option.none()
			] as const)
		)
		yield* Stream.runForEach(jsonSeqRecords(4096)(body), (record) =>
			Ref.update(log, Arr.append(record))
		)
		return yield* Ref.get(log)
	})
