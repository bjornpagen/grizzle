/** What output-sequential.test.ts's property reads: drawn response bodies, their media types and output settings. */

import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Sink,
	Stdio,
	Stream,
	String as Str
} from "effect"
import {
	Force,
	MaxRecordBytes,
	OutputPath,
	Raw,
	writeResponse
} from "#runtime-src/runtime/output.ts"

/** How a media type's body is written: framed as NDJSON or JSON-seq records, or as received; text or binary. */
type Kind = Readonly<{ codec: "ndjson" | "jsonseq" | "none"; text: boolean }>

/** The media types a response may carry, with how design 4.6 writes each. */
const MEDIA: Arr.NonEmptyReadonlyArray<readonly [string | undefined, Kind]> = [
	["application/x-ndjson", { codec: "ndjson", text: true }],
	["application/ndjson", { codec: "ndjson", text: true }],
	["application/x-ndjson; charset=utf-8", { codec: "ndjson", text: true }],
	["application/jsonl", { codec: "ndjson", text: true }],
	["application/json-seq", { codec: "jsonseq", text: true }],
	["application/geo+json-seq", { codec: "jsonseq", text: true }],
	["application/json", { codec: "none", text: true }],
	["text/plain", { codec: "none", text: true }],
	["application/x-ndjson-v2", { codec: "none", text: false }],
	["application/octet-stream", { codec: "none", text: false }],
	[undefined, { codec: "none", text: false }]
]

/** A record as tokens: compact, it is their concatenation; written, a space may sit between any two. */
type Tokens = ReadonlyArray<string>

const scalar: Gen<Tokens> = map(
	element(["1", "2.50", "9007199254740993", '"a"', '"x y"', "true", "null"]),
	(token) => [token]
)

const recordGen: Gen<Readonly<{ tokens: Tokens; spaced: boolean }>> = (s) => {
	const items = s.draw(array(scalar, { min: 0, max: 3 }))
	const tokens = s.draw(
		weighted<Tokens>([
			[
				2,
				constant([
					"{",
					'"a"',
					":",
					...Arr.flatten(Arr.take(items, 1)),
					...(items.length > 0 ? [] : ["1"]),
					"}"
				])
			],
			[
				2,
				constant([
					"[",
					...Arr.flatMap(items, (item, at) => (at === 0 ? item : [",", ...item])),
					"]"
				])
			],
			[
				1,
				constant(
					Arr.flatten(Arr.take(items, 1)).length > 0 ? Arr.flatten(Arr.take(items, 1)) : ["0"]
				)
			]
		])
	)
	return { tokens, spaced: s.draw(element([false, true])) }
}

/** A drawn write: the media type, its records, `--raw`, `--max-record-bytes`, a terminal, `--output`, a stdout that breaks. */
export type Written = Readonly<{
	media: readonly [string | undefined, Kind]
	records: ReadonlyArray<Readonly<{ tokens: Tokens; spaced: boolean }>>
	raw: boolean
	maxRecordBytes: Option.Option<number>
	terminal: boolean
	output: boolean
	breaksAfter: Option.Option<number>
}>

const writtenOf =
	(medias: Gen<readonly [string | undefined, Kind]>): Gen<Written> =>
	(s) => ({
		media: s.draw(medias),
		records: s.draw(array(recordGen, { min: 1, max: 4 })),
		raw: s.draw(
			weighted([
				[3, constant(false)],
				[1, constant(true)]
			])
		),
		maxRecordBytes: s.draw(
			weighted([
				[3, constant(Option.none<number>())],
				[1, map(int(6, 30), Option.some)]
			])
		),
		terminal: s.draw(element([false, true])),
		output: s.draw(
			weighted([
				[4, constant(false)],
				[1, constant(true)]
			])
		),
		breaksAfter: s.draw(
			weighted([
				[5, constant(Option.none<number>())],
				[1, map(int(1, 2), Option.some)]
			])
		)
	})

const writtenGen: Gen<Written> = writtenOf(element(MEDIA))

const recordText = (record: Written["records"][number]): string =>
	Arr.join(record.tokens, record.spaced ? " " : "")

const compactText = (record: Written["records"][number]): string => Arr.join(record.tokens, "")

/** The body's text: NDJSON lines, or JSON-seq records each after U+001E, for a media type framed either way or neither. */
const bodyText = (written: Written): string =>
	written.media[1].codec === "jsonseq"
		? Arr.join(
				Arr.map(written.records, (record) => `\u001E${recordText(record)}\n`),
				""
			)
		: Arr.join(
				Arr.map(written.records, (record) => `${recordText(record)}\n`),
				""
			)

/** What a write leaves: where its bytes went and how it ended. */
export type Outcome = Readonly<{ stdout: string; file: Option.Option<string>; ended: string }>

const encoder = new TextEncoder()

const brokenPipe = PlatformError.systemError({
	_tag: "Unknown",
	cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
	method: "stdout",
	module: "Stdio"
})

/** Writes the drawn response through writeResponse, under the drawn settings, in the case's own directory. */
export const writtenIn = (dir: ScratchDir, written: Written) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const fs = yield* FileSystem.FileSystem
			const target = path.join(dir, "out.jsonl")
			const out: Array<string> = []
			const decoder = new TextDecoder()
			let writes = 0
			const stdout = () =>
				Sink.forEachArray((chunks: ReadonlyArray<string | Uint8Array>) =>
					Effect.suspend(() => {
						writes += 1
						const broken = Option.exists(written.breaksAfter, (after) => writes > after)
						if (broken) {
							return Effect.fail(brokenPipe)
						}
						for (const chunk of chunks) {
							out.push(typeof chunk === "string" ? chunk : decoder.decode(chunk))
						}
						return Effect.void
					})
				)
			const context = yield* Layer.build(
				Layer.mergeAll(
					Stdio.layerTest({ stdout, stdoutIsTerminal: Effect.succeed(written.terminal) }),
					Layer.succeed(OutputPath, written.output ? Option.some(target) : Option.none()),
					Layer.succeed(Force, false),
					written.raw ? Layer.succeed(Raw, true) : Layer.empty,
					Option.match(written.maxRecordBytes, {
						onNone: () => Layer.empty,
						onSome: (bound) => Layer.succeed(MaxRecordBytes, bound)
					})
				)
			)
			const chunks = Arr.map(Arr.fromIterable(bodyText(written)), (character) =>
				encoder.encode(character)
			)
			const exit = yield* Effect.exit(
				writeResponse({ bytes: Stream.fromIterable(chunks), mediaType: written.media[0] }).pipe(
					Effect.provideContext(context)
				)
			)
			const exists = yield* Effect.orDie(fs.exists(target))
			const content = exists ? yield* Effect.orDie(fs.readFileString(target)) : ""
			const file = exists ? Option.some(content) : Option.none()
			const outcome: Outcome = {
				stdout: Arr.join(out, ""),
				file,
				ended: Exit.match(exit, {
					onSuccess: () => "written",
					onFailure: (cause) =>
						Option.match(Cause.findErrorOption(cause), {
							onNone: () => "a defect",
							onSome: (error) =>
								error._tag === "ResponseStreamError"
									? `${error._tag} ${error.reason} ${error.itemIndex ?? -1}`
									: error._tag
						})
				})
			}
			return outcome
		})
	)

/**
 * What design 4.6 writes: a sequential body (not under `--raw`) one compact line per record, each record bounded by
 * `--max-record-bytes` (the lines before a longer one written, then recordTooLarge at its index); any other body, and a
 * sequential one under `--raw`, the bytes received; to the `--output` file when given, else to stdout, where a binary
 * body to a terminal is refused before it is read; a stdout that breaks (EPIPE) ends the write as a success with what it
 * took.
 */
export const expectedOf = (written: Written): Outcome => {
	const [, kind] = written.media
	const framed = kind.codec !== "none" && !written.raw
	const tooLarge = framed
		? Arr.findFirstIndex(written.records, (record) =>
				Option.exists(
					written.maxRecordBytes,
					(bound) => encoder.encode(recordText(record)).length > bound
				)
			)
		: Option.none()
	const lines = Option.match(tooLarge, {
		onNone: () => written.records,
		onSome: (at) => Arr.take(written.records, at)
	})
	const bytes = framed
		? Arr.join(
				Arr.map(lines, (record) => `${compactText(record)}\n`),
				""
			)
		: bodyText(written)
	const ended = Option.match(tooLarge, {
		onNone: () => "written",
		onSome: (at) => `ResponseStreamError recordTooLarge ${at}`
	})
	if (written.output) {
		return { stdout: "", file: Option.isSome(tooLarge) ? Option.none() : Option.some(bytes), ended }
	}
	if (!kind.text && written.terminal) {
		return { stdout: "", file: Option.none(), ended: "UsageError" }
	}
	return { stdout: bytes, file: Option.none(), ended }
}

/** The outcome read for comparison: a stdout that broke keeps a prefix of the bytes, so only that it is one is judged. */
export const comparable = (written: Written, outcome: Outcome, expected: Outcome): Outcome =>
	Option.isSome(written.breaksAfter) && !written.output && expected.ended !== "UsageError"
		? {
				...outcome,
				stdout: Str.startsWith(outcome.stdout)(expected.stdout) ? expected.stdout : outcome.stdout,
				ended: outcome.ended === "written" ? expected.ended : outcome.ended
			}
		: outcome

export type WrittenFeature =
	| "an NDJSON body framed"
	| "a JSON-seq body framed"
	| "a media type with parameters"
	| "a +json-seq suffix"
	| "a text body as received"
	| "a binary body as received"
	| "--raw on a sequential body"
	| "a record past --max-record-bytes"
	| "a binary body refused at a terminal"
	| "sequential lines at a terminal"
	| "--output"
	| "a stdout that breaks"

export const writtenFeatures = (
	written: Written,
	expected: Outcome
): ReadonlyArray<WrittenFeature> => {
	const [mediaType, kind] = written.media
	const when = (holds: boolean, feature: WrittenFeature): ReadonlyArray<WrittenFeature> =>
		holds ? [feature] : []
	return [
		...when(kind.codec === "ndjson" && !written.raw, "an NDJSON body framed"),
		...when(kind.codec === "jsonseq" && !written.raw, "a JSON-seq body framed"),
		...when(
			mediaType !== undefined && Str.includes(";")(mediaType),
			"a media type with parameters"
		),
		...when(
			mediaType !== undefined && Str.endsWith("+json-seq")(mediaType) && !written.raw,
			"a +json-seq suffix"
		),
		...when(kind.codec === "none" && kind.text, "a text body as received"),
		...when(kind.codec === "none" && !kind.text && !written.terminal, "a binary body as received"),
		...when(kind.codec !== "none" && written.raw, "--raw on a sequential body"),
		...when(
			Str.startsWith("ResponseStreamError")(expected.ended),
			"a record past --max-record-bytes"
		),
		...when(expected.ended === "UsageError", "a binary body refused at a terminal"),
		...when(
			kind.codec !== "none" && written.terminal && !written.output,
			"sequential lines at a terminal"
		),
		...when(written.output, "--output"),
		...when(Option.isSome(written.breaksAfter) && !written.output, "a stdout that breaks")
	]
}

const media = (at: number): readonly [string | undefined, Kind] => Arr.getUnsafe(MEDIA, at)

/** Writes, aimed at each pending situation by a write built to reach it. */
export const aimedWrites: Aimed<Written, WrittenFeature> = aimed(writtenGen, [
	[
		"an NDJSON body framed",
		map(writtenGen, (drawn): Written => ({ ...drawn, media: media(0), raw: false }))
	],
	[
		"a JSON-seq body framed",
		map(writtenGen, (drawn): Written => ({ ...drawn, media: media(4), raw: false }))
	],
	[
		"a media type with parameters",
		map(writtenGen, (drawn): Written => ({ ...drawn, media: media(2) }))
	],
	[
		"a +json-seq suffix",
		map(writtenGen, (drawn): Written => ({ ...drawn, media: media(5), raw: false }))
	],
	["a text body as received", map(writtenGen, (drawn): Written => ({ ...drawn, media: media(7) }))],
	[
		"a binary body as received",
		map(writtenGen, (drawn): Written => ({ ...drawn, media: media(9), terminal: false }))
	],
	[
		"--raw on a sequential body",
		map(writtenGen, (drawn): Written => ({
			...drawn,
			media: media(0),
			raw: true,
			records: [...drawn.records, { tokens: ["[", "1", ",", '"x y"', "]"], spaced: true }]
		}))
	],
	[
		"a record past --max-record-bytes",
		map(writtenGen, (drawn): Written => ({
			...drawn,
			media: media(0),
			raw: false,
			maxRecordBytes: Option.some(6),
			records: [...drawn.records, { tokens: ["[", '"x y"', ",", "1", "]"], spaced: true }]
		}))
	],
	[
		"a binary body refused at a terminal",
		map(writtenGen, (drawn): Written => ({
			...drawn,
			media: media(9),
			terminal: true,
			output: false
		}))
	],
	[
		"sequential lines at a terminal",
		map(writtenGen, (drawn): Written => ({
			...drawn,
			media: media(0),
			terminal: true,
			output: false
		}))
	],
	["--output", map(writtenGen, (drawn): Written => ({ ...drawn, output: true }))],
	[
		"a stdout that breaks",
		map(writtenGen, (drawn): Written => ({
			...drawn,
			media: media(0),
			terminal: false,
			output: false,
			breaksAfter: Option.some(1)
		}))
	]
])
