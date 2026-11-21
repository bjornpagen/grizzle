/**
 * What the property of sequential-media-parity.test.ts reads: response media types from the runtime's own table of
 * sequential types (with each one's `+json-seq` suffix form and a `+xml` near miss) in every spelling a document may
 * use, the codec the generator assigns a declared response key, and the codec the runtime frames a body by.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { boolean, finite, type FiniteSpace } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Sink, Stdio, Stream, String as Str } from "effect"
import { DocumentUri } from "#model/brands.ts"
import { normalizeResponses } from "#normalize/responses.ts"
import { resolve } from "#resolve/index.ts"
import { Force, OutputPath, writeResponse } from "#runtime-src/runtime/output.ts"
import type { SequentialCodec } from "#runtime-src/runtime/sequential.ts"
import { essences } from "#test/runtime/sequential-media-parity.dictionary.ts"
import { holding } from "#test/runtime/serialize.fixtures.ts"

/** A response media type as drawn: an essence and its spelling, upper-cased or not, with a parameter or not. */
export type MediaCase = Readonly<{ essence: string; upper: boolean; parameter: boolean }>

/** Every media type of the table and its suffix forms, in all four spellings. */
export const mediaSpace: FiniteSpace<MediaCase> = finite((source) => ({
	essence: word(essences)(source),
	upper: boolean(source),
	parameter: boolean(source)
}))

/** A case's media type as a document declares it. */
export const spelled = (media: MediaCase): string =>
	`${media.upper ? Str.toUpperCase(media.essence) : media.essence}${media.parameter ? "; charset=utf-8" : ""}`

const entry = DocumentUri.make("file:///spec/openapi.json")

/** The codec the generator assigns a response declared under `mediaType`, none when it assigns none or refuses it. */
export const generatorCodec = (mediaType: string) =>
	Effect.gen(function* () {
		const resolution = yield* resolve({
			document: entry,
			line: "3.1",
			value: {
				info: { title: "t", version: "1" },
				openapi: "3.1.1",
				paths: {
					"/a": {
						get: { responses: { "200": { content: { [mediaType]: {} }, description: "ok" } } }
					}
				}
			}
		})
		const { responses } = yield* normalizeResponses(resolution, "/paths/~1a/get/responses", {
			method: "GET",
			path: "/a"
		})
		return Option.flatMap(
			Arr.findFirst(
				Arr.flatMap(responses, (response) => response.alternatives),
				(alternative) => alternative.mediaType === mediaType
			),
			(alternative) => Option.fromNullishOr(alternative.codec)
		)
	})

/** Each sequential codec's two-record body, and the lines the runtime prints for it when it frames the body so. */
const SAMPLES: ReadonlyArray<readonly [SequentialCodec, string, string]> = [
	["jsonseq", '\u001E{"a": 1}\n\u001E{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
	["ndjson", '{"a": 1}\n\n{"b": [1, 2]}\n', '{"a":1}\n{"b":[1,2]}\n'],
	["sse", "data: one\n\ndata: two\n\n", '{"data":"one"}\n{"data":"two"}\n']
]

/** What the runtime prints for `text` served under the matched key `mediaType`, none when the write fails. */
const printed = (mediaType: string, text: string) =>
	Effect.gen(function* () {
		const captured: Array<Uint8Array> = []
		const keep = (chunk: string | Uint8Array) =>
			Effect.sync(() => {
				captured.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
			})
		const capture = () => Sink.forEach(keep)
		const written = yield* Effect.exit(
			writeResponse({ bytes: Stream.make(new TextEncoder().encode(text)), mediaType }).pipe(
				Effect.provideService(
					Stdio.Stdio,
					Stdio.make({
						args: Effect.succeed([]),
						stdout: capture,
						stderr: capture,
						stdin: Stream.empty
					})
				),
				Effect.provideService(OutputPath, Option.none()),
				Effect.provideService(Force, false)
			)
		)
		return written._tag === "Success"
			? Option.some(new TextDecoder().decode(Buffer.concat(captured)))
			: Option.none()
	})

/** The codec the runtime frames a `mediaType` body by: the one whose sample it prints as that codec's lines, none when it frames none. */
export const runtimeCodec = (mediaType: string) =>
	Effect.map(
		Effect.forEach(SAMPLES, ([codec, body, lines]) =>
			Effect.map(
				printed(mediaType, body),
				(output) => [codec, Option.contains(output, lines)] as const
			)
		),
		(framed) =>
			Option.map(
				Arr.findFirst(framed, ([, frames]) => frames),
				([codec]) => codec
			)
	)

/** The situations a media type reaches. */
export type ParityFeature =
	| SequentialCodec
	| "not sequential"
	| "suffix form"
	| "upper case"
	| "parameter"

/** What a media type reaches, given the codec both sides agree on. */
export const parityFeatures = (
	media: MediaCase,
	codec: Option.Option<SequentialCodec>
): ReadonlyArray<ParityFeature> =>
	holding<ParityFeature>([
		["jsonseq", Option.contains(codec, "jsonseq")],
		["ndjson", Option.contains(codec, "ndjson")],
		["sse", Option.contains(codec, "sse")],
		["not sequential", Option.isNone(codec)],
		["suffix form", Str.endsWith("+json-seq")(media.essence) && Option.isSome(codec)],
		["upper case", media.upper && Option.isSome(codec)],
		["parameter", media.parameter && Option.isSome(codec)]
	])
