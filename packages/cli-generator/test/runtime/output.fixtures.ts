/**
 * What output.test.ts's properties read: scenes of recorded values echoed in a text, error bodies cut into chunks,
 * invalid flag values, failures no error class of design 7.1 renders, and `--output` targets meeting `send`, each with
 * the print the design says it leaves.
 */

import {
	type Aimed,
	aimed,
	array,
	characterOf,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Redacted,
	Runtime,
	Stdio,
	Stream,
	String as Str
} from "effect"
import { CliError } from "effect/cli"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ApiResponseError, OutputError, TransportError } from "#runtime-src/domain/errors.ts"
import * as Auth from "#runtime-src/runtime/auth.ts"
import type { Credential } from "#runtime-src/runtime/auth.ts"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import { Transport } from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import {
	ClientPolicy,
	dryRunSetting,
	Force,
	finalCatch,
	type OperationMeta,
	OutputPath,
	readErrorBody,
	renderError,
	send,
	valueFreeFormatter
} from "#runtime-src/runtime/output.ts"
import {
	encoder,
	runCredentialsLayer,
	type ScrubEntry,
	scrub
} from "#runtime-src/runtime/redact.ts"
import { mapClientError } from "#runtime-src/runtime/response.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import { appendingTo } from "#test/support/stdio.ts"

/** The prefix the final catch reads its error format under; no case sets `OUTPUT_ERROR_FORMAT`, so every print is text. */
const PREFIX = "OUTPUT"

/** What the final catch left: how the run ended, the error it ended with, and what it printed on stderr. */
type Caught = Readonly<{
	exit: Exit.Exit<unknown, unknown>
	error: Option.Option<unknown>
	stderr: string
}>

/**
 * Runs `program` inside the final catch with `recorded` as the caller's values to scrub, an empty run record and an
 * environment that sets nothing, and answers what it printed on stderr.
 */
const caughtBy = <A, E>(
	program: Effect.Effect<A, E, Stdio.Stdio>,
	recorded: ReadonlyArray<ScrubEntry>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const err: Array<string> = []
			const context = yield* Layer.build(
				Layer.mergeAll(
					Stdio.layerTest({ stderr: appendingTo(err) }),
					ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
					runCredentialsLayer
				)
			)
			const exit = yield* Effect.exit(
				finalCatch(recorded, { envPrefix: PREFIX })(program).pipe(Effect.provideContext(context))
			)
			const caught: Caught = {
				exit,
				error: Exit.isFailure(exit) ? Option.some(Cause.squash(exit.cause)) : Option.none(),
				stderr: Arr.join(err, "")
			}
			return caught
		})
	)

/** The exit code a run ends with: 0 for a success, else its error's. */
const exitCodeOf = (caught: Caught): number =>
	Option.match(caught.error, { onNone: () => 0, onSome: Runtime.getErrorExitCode })

/** Whether the runtime would print the run's error again: false once the final catch printed it, and for a success. */
const reportedOf = (caught: Caught): boolean =>
	Option.exists(caught.error, Runtime.getErrorReported)

/** The `_tag` of a run's error: the class it stands as. */
const tagOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
		? error._tag
		: typeof error

/** The class a run's error stands as, or `none` for a success. */
const standsAs = (caught: Caught): string =>
	Option.match(caught.error, { onNone: () => "none", onSome: tagOf })

/**
 * Characters a print strips (design 7.4): C0 but LF and TAB (SOH, ESC), DEL, C1 (NEL), format characters (the soft
 * hyphen, a zero-width space, a bidi override) and the line separator. Lone surrogates are stripped too but have no UTF-8
 * form, so an error body, which arrives as bytes, never carries one.
 */
const STRIPPED: Arr.NonEmptyReadonlyArray<string> = [
	"\u0001",
	"\u001B",
	"\u007F",
	"\u0085",
	"\u00AD",
	"\u200B",
	"\u202E",
	"\u2028"
]

/** The design's strip of `text`: every character of STRIPPED gone, the rest kept in order. */
const stripped = (text: string): string =>
	Arr.join(
		Arr.filter(Arr.fromIterable(text), (character) => !Arr.contains(STRIPPED, character)),
		""
	)

/**
 * Characters a recorded value holds beside stripped ones: upper-case letters and digits no fixed word of a print and no
 * placeholder spells three of in a row, so a value of three or more of them is found only where an echo put it.
 */
const VALUE_CHARS: Arr.NonEmptyReadonlyArray<string> = ["A", "B", "C", "D", "1", "2"]

/** Characters of the plain text between echoes: none a value holds, so plain text never joins a form. */
const PLAIN_CHARS: Arr.NonEmptyReadonlyArray<string> = ["x", "y", " ", ";", "-", "{", "}"]

/** The scheme each recorded value's placeholder names, by its place among the scene's values. */
export type Label = "bearerAuth" | "tokenAuth" | "keyAuth" | "emptyAuth"

/** A recorded value: a bearer credential of its scheme, its one form the value as sent. */
export type Recorded = Readonly<{ label: Label; value: string }>

/**
 * How the scene's first two values relate: apart; overlapping (the first's end is the second's start, `x+y` and
 * `y+z`); or nested (the first begins the second, `x+y` and `x+y+z`). Related values echo together as `x+y+z`.
 */
export type Relation = "apart" | "overlapping" | "nested"

/** A piece of a text: plain words, an echo of a recorded value maybe split by a stripped character, or two related values echoed together. */
export type Piece =
	| Readonly<{ kind: "plain"; text: string }>
	| Readonly<{ kind: "echo"; of: Recorded; split: Option.Option<readonly [number, string]> }>
	| Readonly<{ kind: "joined"; text: string }>

/** A text a server or a person sent holding the run's recorded values, and where its bytes are cut into chunks. */
export type Scene = Readonly<{
	relation: Relation
	recorded: ReadonlyArray<Recorded>
	pieces: ReadonlyArray<Piece>
	cuts: ReadonlyArray<number>
}>

/** The scrub entries the scene's values are, as `send` records a bearer credential. */
const entriesOf = (scene: Scene): ReadonlyArray<Credential> =>
	Arr.map(scene.recorded, (recorded): Credential => ({
		definition: { kind: "http", scheme: "bearer" },
		scheme: recorded.label,
		value: Redacted.make(recorded.value)
	}))

/** The text a piece is: an echo split puts its character after a share, in thousandths, of the value's inner places. */
const pieceText = (piece: Piece): string => {
	switch (piece.kind) {
		case "plain":
		case "joined":
			return piece.text
		case "echo":
			return Option.match(piece.split, {
				onNone: () => piece.of.value,
				onSome: ([at, character]) => {
					const place = 1 + Math.floor((at * (piece.of.value.length - 1)) / 1000)
					return `${Str.slice(0, place)(piece.of.value)}${character}${Str.slice(place)(piece.of.value)}`
				}
			})
	}
}

/** The text the scene's pieces make. */
const textOf = (scene: Scene): string => Arr.join(Arr.map(scene.pieces, pieceText), "")

/** A character range of a text a form covers, and the placeholder that replaces it. */
type Covered = Readonly<{ start: number; end: number; label: Label }>

/** Every start of `form` in `text`, overlapping ones included, by trying each place in turn. */
const startsIn = (text: string, form: string): ReadonlyArray<number> =>
	Arr.filter(
		Array.from({ length: Math.max(0, text.length - form.length + 1) }, (_, at) => at),
		(at) => Str.startsWith(form, at)(text)
	)

const earliestThenLongest = Order.combine(
	Order.mapInput(Order.Number, (range: Covered) => range.start),
	Order.mapInput(Order.flip(Order.Number), (range: Covered) => range.end)
)

/** Ranges sorted earliest first, the longest first at one start, merged where they overlap or touch. */
const runsOf = (ranges: ReadonlyArray<Covered>): ReadonlyArray<Covered> => {
	const none: ReadonlyArray<Covered> = []
	return Arr.reduce(Arr.sort(ranges, earliestThenLongest), none, (merged, range) =>
		Option.match(Arr.last(merged), {
			onNone: () => [range],
			onSome: (last) =>
				range.start <= last.end
					? [...Arr.dropRight(merged, 1), { ...last, end: Math.max(last.end, range.end) }]
					: [...merged, range]
		})
	)
}

/**
 * The design's scrub (7.5, recheck N1) of `text` by the forms each value is matched in: every occurrence of every
 * non-empty form, ranges that overlap or touch merged into one run under the placeholder of its earliest range, the
 * longest of those at one start, the first recorded among equal ones.
 */
const scrubbedBy = (
	text: string,
	recorded: ReadonlyArray<Recorded>,
	formsOf: (value: string) => ReadonlyArray<string>
): string => {
	const runs = runsOf(
		Arr.flatMap(recorded, (one) =>
			Arr.flatMap(formsOf(one.value), (form) =>
				form === ""
					? []
					: Arr.map(startsIn(text, form), (start): Covered => ({
							start,
							end: start + form.length,
							label: one.label
						}))
			)
		)
	)
	const before = Arr.zip([0, ...Arr.map(runs, (run) => run.end)], runs)
	return Arr.join(
		[
			...Arr.map(
				before,
				([from, run]) => `${Str.slice(from, run.start)(text)}<redacted:${run.label}>`
			),
			Option.match(Arr.last(runs), {
				onNone: () => text,
				onSome: (last) => Str.slice(last.end)(text)
			})
		],
		""
	)
}

/**
 * What the scene's text prints as, by design 7.4 and 7.5: `scrubbed`, the scrub alone, every value as sent replaced;
 * `printed`, a print's scrub around the strip, which scrubs the text as sent, strips it, and scrubs again with each
 * value both as sent and stripped, so a value a stripped character split is found, and a placeholder already printed is
 * never merged with an echo the second pass finds.
 */
const printedOf = (scene: Scene) => {
	const scrubbed = scrubbedBy(textOf(scene), scene.recorded, (value) => [value])
	return {
		scrubbed,
		printed: scrubbedBy(stripped(scrubbed), scene.recorded, (value) => [value, stripped(value)])
	}
}

/** The scene's text's bytes cut at its cut points, each a share in thousandths of the bytes' length. */
const bytesOf = (scene: Scene): Readonly<{ bytes: Uint8Array; at: ReadonlyArray<number> }> => {
	const bytes = encoder.encode(textOf(scene))
	return {
		bytes,
		at: Arr.dedupe(
			Arr.sort(
				Arr.map(scene.cuts, (cut) => Math.floor((cut * bytes.length) / 1000)),
				Order.Number
			)
		)
	}
}

/** Bytes cut at the given offsets into the chunks of a stream. */
const chunked = (bytes: Uint8Array, at: ReadonlyArray<number>): Stream.Stream<Uint8Array> => {
	const bounds = [0, ...at, bytes.length]
	return Stream.fromIterable(
		Arr.map(Arr.zip(Arr.dropRight(bounds, 1), Arr.drop(bounds, 1)), ([from, to]) =>
			bytes.subarray(from, to)
		)
	)
}

/** Whether any offset falls inside a UTF-8 sequence: before a byte that continues one. */
const cutsInside = (bytes: Uint8Array, at: ReadonlyArray<number>): boolean => {
	const all = Arr.fromIterable(bytes)
	return Arr.some(at, (cut) =>
		Option.exists(Arr.get(all, cut), (byte) => byte >= 0x80 && byte < 0xc0)
	)
}

/**
 * Every print path the scene's text takes: the scrub alone; an error body read across the scene's chunks; an API
 * response error's request id line and body; a transport error's URL; a defect's line; and a parse error's report,
 * which quotes the option the person typed.
 */
export const printsOf = (scene: Scene) =>
	Effect.gen(function* () {
		const text = textOf(scene)
		const entries = entriesOf(scene)
		const { bytes, at } = bytesOf(scene)
		const read = yield* readErrorBody(chunked(bytes, at), entries)
		const api = renderError(
			new ApiResponseError({
				body: text,
				matched: "401",
				operation: "users.get",
				requestId: text,
				status: 401
			}),
			entries,
			false
		)
		const transport = renderError(
			new TransportError({ reason: "connect", url: text }),
			entries,
			false
		)
		const defect = yield* caughtBy(Effect.die(text), entries)
		const parse = yield* caughtBy(
			Effect.fail(CliError.UnrecognizedOption.make({ option: `--${text}`, suggestions: [] })),
			entries
		)
		return {
			scrubbed: scrub(text, entries),
			read,
			api: Arr.drop(Str.split("\n")(api), 1),
			transport,
			defect: defect.stderr,
			parse: parse.stderr
		}
	})

/** What design 7.4 says each print path prints: the scrub's text, else the print's, framed as each path frames it. */
export const expectedPrintsOf = (scene: Scene) => {
	const { scrubbed, printed } = printedOf(scene)
	return {
		scrubbed,
		read: printed,
		api: [`Request ID: ${printed}`, printed],
		transport: `Error: request to ${printed} failed: connect`,
		defect: `Error: ${printed}\ninternal error, please report\n`,
		parse: `\nERROR\n  Unrecognized flag: --${printed}\n`
	}
}

export type SceneFeature =
	| "forms that overlap"
	| "a value beginning a longer one"
	| "echoes that touch"
	| "an empty value recorded"
	| "an echo split by a stripped character"
	| "a value holding a stripped character"
	| "a split echo after a whole one"
	| "a cut inside a character"

const isWhole = (piece: Piece): boolean =>
	piece.kind === "joined" || (piece.kind === "echo" && Option.isNone(piece.split))

const isSplit = (piece: Piece): boolean => piece.kind === "echo" && Option.isSome(piece.split)

/** The situations a scene reaches, read from how it was built. */
export const sceneFeatures = (scene: Scene): ReadonlyArray<SceneFeature> => {
	const joined = Arr.some(scene.pieces, (piece) => piece.kind === "joined")
	const { bytes, at } = bytesOf(scene)
	const facts: ReadonlyArray<readonly [boolean, SceneFeature]> = [
		[joined && scene.relation === "overlapping", "forms that overlap"],
		[joined && scene.relation === "nested", "a value beginning a longer one"],
		[
			Arr.some(
				Arr.zip(scene.pieces, Arr.drop(scene.pieces, 1)),
				([one, next]) => isWhole(one) && isWhole(next)
			),
			"echoes that touch"
		],
		[Arr.some(scene.recorded, (one) => one.value === ""), "an empty value recorded"],
		[Arr.some(scene.pieces, isSplit), "an echo split by a stripped character"],
		[
			Arr.some(
				scene.pieces,
				(piece) => piece.kind === "echo" && stripped(piece.of.value) !== piece.of.value
			),
			"a value holding a stripped character"
		],
		[
			Arr.some(
				scene.pieces,
				(piece, place) => isSplit(piece) && Arr.some(Arr.take(scene.pieces, place), isWhole)
			),
			"a split echo after a whole one"
		],
		[cutsInside(bytes, at), "a cut inside a character"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

/** Every situation a scene can reach, each required. */
export const SCENE_SITUATIONS: ReadonlyArray<SceneFeature> = [
	"forms that overlap",
	"a value beginning a longer one",
	"echoes that touch",
	"an empty value recorded",
	"an echo split by a stripped character",
	"a value holding a stripped character",
	"a split echo after a whole one",
	"a cut inside a character"
]

const valueGen = (min: number, max: number): Gen<string> =>
	string(characterOf(VALUE_CHARS), { min, max })

/** A value part that may hold a stripped character after its first character. */
const holdingGen: Gen<string> = (s) => {
	const core = s.draw(valueGen(3, 12))
	return Option.match(s.draw(option(element(STRIPPED))), {
		onNone: () => core,
		onSome: (character) => `${Str.slice(0, 1)(core)}${character}${Str.slice(1)(core)}`
	})
}

/** The parts related values are made of: `x` (which may hold a stripped character), `y` and `z`. */
type Parts = Readonly<{ x: string; y: string; z: string }>

const partsGen: Gen<Parts> = (s) => ({
	x: s.draw(holdingGen),
	y: s.draw(valueGen(1, 6)),
	z: s.draw(valueGen(3, 12))
})

/** Recorded values, the first two always there. */
type RecordedValues = readonly [Recorded, Recorded, ...ReadonlyArray<Recorded>]

/** The scene's recorded values: the first two by their relation, then a third and an empty one if drawn. */
const recordedOf = (
	relation: Relation,
	parts: Parts,
	third: Option.Option<string>,
	empty: boolean
): RecordedValues => {
	const { x, y, z } = parts
	const second = ((): string => {
		switch (relation) {
			case "apart":
				return z
			case "overlapping":
				return `${y}${z}`
			case "nested":
				return `${x}${y}${z}`
		}
	})()
	const first: Recorded = { label: "bearerAuth", value: `${x}${y}` }
	return [
		first,
		{ label: "tokenAuth", value: second },
		...Option.match(third, {
			onNone: (): ReadonlyArray<Recorded> => [],
			onSome: (value): ReadonlyArray<Recorded> => [{ label: "keyAuth", value }]
		}),
		...(empty ? [{ label: "emptyAuth" as const, value: "" }] : [])
	]
}

/** The piece two related values echo as together: `x+y+z`, which holds the first and the second, overlapping or nested. */
const joinedOf = (parts: Parts): Piece => ({
	kind: "joined",
	text: `${parts.x}${parts.y}${parts.z}`
})

const plainGen: Gen<Piece> = (s) => ({
	kind: "plain",
	text: s.draw(
		string(
			weighted<string>([
				[6, characterOf(PLAIN_CHARS)],
				[1, characterOf(STRIPPED)]
			]),
			{ min: 1, max: 6 }
		)
	)
})

const splitGen: Gen<Option.Option<readonly [number, string]>> = option(
	(s) => [s.draw(int(0, 999)), s.draw(element(STRIPPED))] as const
)

/** An echo of one of the values, which are never empty, maybe split. */
const echoGen =
	(echoed: Arr.NonEmptyReadonlyArray<Recorded>): Gen<Piece> =>
	(s) => ({ kind: "echo", of: s.draw(element(echoed)), split: s.draw(splitGen) })

const relationGen: Gen<Relation> = element<Relation>(["apart", "overlapping", "nested"])

const cutsGen: Gen<ReadonlyArray<number>> = array(int(0, 999), { min: 0, max: 4 })

/** A scene: related values, a third maybe, an empty one maybe, and a text of plain words and echoes cut anywhere. */
const scenes: Gen<Scene> = (s) => {
	const relation = s.draw(relationGen)
	const parts = s.draw(partsGen)
	const third = s.draw(option(valueGen(3, 12)))
	const [first, second, ...rest] = recordedOf(
		relation,
		parts,
		third,
		s.draw(element([false, true]))
	)
	const echoed: Arr.NonEmptyReadonlyArray<Recorded> = [
		first,
		second,
		...Arr.filter(rest, (one) => one.value !== "")
	]
	const piece =
		relation === "apart"
			? weighted<Piece>([
					[3, plainGen],
					[4, echoGen(echoed)]
				])
			: weighted<Piece>([
					[3, plainGen],
					[4, echoGen(echoed)],
					[1, (): Piece => joinedOf(parts)]
				])
	return {
		relation,
		recorded: [first, second, ...rest],
		pieces: [...s.draw(array(piece, { min: 0, max: 7 })), s.draw(echoGen(echoed))],
		cuts: s.draw(cutsGen)
	}
}

/** A scene of the given relation and parts, with no third value, whose pieces are built from its first two values. */
const sceneWith =
	(
		relation: Relation,
		partsOf: Gen<Parts>,
		empty: boolean,
		piecesOf: (
			first: Recorded,
			second: Recorded,
			parts: Parts,
			s: Parameters<Gen<Piece>>[0]
		) => ReadonlyArray<Piece>
	): Gen<Scene> =>
	(s) => {
		const parts = s.draw(partsOf)
		const recorded = recordedOf(relation, parts, Option.none(), empty)
		const [first, second] = recorded
		return { relation, recorded, pieces: piecesOf(first, second, parts, s), cuts: s.draw(cutsGen) }
	}

/** Parts whose `x` holds a soft hyphen after its first character. */
const holdingParts: Gen<Parts> = map(partsGen, (parts) => ({
	...parts,
	x: `${Str.slice(0, 1)(parts.x)}\u00AD${Str.slice(1)(parts.x)}`
}))

const whole = (of: Recorded): Piece => ({ kind: "echo", of, split: Option.none() })

const splitEcho = (of: Recorded, s: Parameters<Gen<Piece>>[0]): Piece => ({
	kind: "echo",
	of,
	split: Option.some([s.draw(int(0, 999)), s.draw(element(STRIPPED))] as const)
})

/** The share, in thousandths, that cuts a text of `length` bytes after its first byte. */
const afterFirstByte = (length: number): number => Math.ceil(1000 / length)

/** Scenes, aimed at each pending situation by one built to reach it. */
export const aimedScenes: Aimed<Scene, SceneFeature> = aimed(scenes, [
	[
		"forms that overlap",
		sceneWith("overlapping", partsGen, false, (_first, _second, parts, s) => [
			s.draw(plainGen),
			joinedOf(parts)
		])
	],
	[
		"a value beginning a longer one",
		sceneWith("nested", partsGen, false, (_first, _second, parts, s) => [
			joinedOf(parts),
			s.draw(plainGen)
		])
	],
	[
		"echoes that touch",
		sceneWith("apart", partsGen, false, (first, second) => [whole(first), whole(second)])
	],
	[
		"an empty value recorded",
		sceneWith("apart", partsGen, true, (_first, second, _parts, s) => [
			s.draw(plainGen),
			whole(second)
		])
	],
	[
		"an echo split by a stripped character",
		sceneWith("apart", partsGen, false, (first, _second, _parts, s) => [splitEcho(first, s)])
	],
	[
		"a value holding a stripped character",
		sceneWith("apart", holdingParts, false, (first) => [whole(first)])
	],
	[
		"a split echo after a whole one",
		sceneWith("apart", partsGen, false, (first, _second, _parts, s) => [
			whole(first),
			splitEcho(first, s)
		])
	],
	[
		"a cut inside a character",
		map(
			sceneWith("apart", partsGen, false, (first) => [
				{ kind: "plain", text: "\u202E" },
				whole(first)
			]),
			(scene): Scene => ({ ...scene, cuts: [afterFirstByte(encoder.encode(textOf(scene)).length)] })
		)
	]
])

/** A body made of one unit repeated, and the size of the chunks it is read in, in bytes. */
export type Body = Readonly<{ unit: string; times: number; chunk: number }>

/** Characters a body holds: ASCII, a two-byte and a four-byte character, none a print strips and no line break. */
const BODY_CHARS: Arr.NonEmptyReadonlyArray<string> = ["a", "y", " ", "{", "}", "é", "🔑"]

/** The length of the long bodies output.test.ts's examples printed and read whole, in characters. */
const LONG = 100_000

/** The chunk size of the longest read those examples made, in bytes. */
const LARGEST_CHUNK = 7000

const bodyText = (body: Body): string => Str.repeat(body.times)(body.unit)

const bodies: Gen<Body> = (s) => ({
	unit: s.draw(string(characterOf(BODY_CHARS), { min: 1, max: 8 })),
	times: s.draw(int(1, 4000)),
	chunk: s.draw(int(1, LARGEST_CHUNK))
})

/** A recorded value no body holds, as a run that sent a credential records it: its scrub must leave the body as it is. */
const BODY_RECORDED: ReadonlyArray<ScrubEntry> = [
	{
		definition: { kind: "http", scheme: "bearer" },
		scheme: "bearerAuth",
		value: Redacted.make("TOKEN-NOT-IN-ANY-BODY")
	}
]

/** The body's bytes, and the offsets its chunks of its chunk size start at after the first. */
const bodyBytes = (body: Body): Readonly<{ bytes: Uint8Array; at: ReadonlyArray<number> }> => {
	const bytes = encoder.encode(bodyText(body))
	const chunks = Math.ceil(bytes.length / body.chunk)
	return {
		bytes,
		at: Array.from({ length: chunks - 1 }, (_, place) => (place + 1) * body.chunk)
	}
}

/** What the body leaves: read as an error body across its chunks, and printed as an API response error's body. */
export const bodyPrintsOf = (body: Body) =>
	Effect.gen(function* () {
		const { bytes, at } = bodyBytes(body)
		const read = yield* readErrorBody(chunked(bytes, at), BODY_RECORDED)
		const rendered = renderError(
			new ApiResponseError({
				body: bodyText(body),
				matched: "404",
				operation: "users.get",
				status: 404
			}),
			BODY_RECORDED,
			false
		)
		return { read, printed: Arr.drop(Str.split("\n")(rendered), 1) }
	})

/** What design 7.4 says: the body read to its end and decoded whole, and printed whole, however long. */
export const expectedBodyOf = (body: Body) => ({ read: bodyText(body), printed: [bodyText(body)] })

export type BodyFeature =
	| "a body read in one chunk"
	| "a body read in many chunks"
	| "a character cut between chunks"
	| "a body of 100,000 characters or more"

export const bodyFeatures = (body: Body): ReadonlyArray<BodyFeature> => {
	const { bytes, at } = bodyBytes(body)
	const facts: ReadonlyArray<readonly [boolean, BodyFeature]> = [
		[Arr.isReadonlyArrayEmpty(at), "a body read in one chunk"],
		[Arr.isReadonlyArrayNonEmpty(at), "a body read in many chunks"],
		[cutsInside(bytes, at), "a character cut between chunks"],
		[bodyText(body).length >= LONG, "a body of 100,000 characters or more"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

export const BODY_SITUATIONS: ReadonlyArray<BodyFeature> = [
	"a body read in one chunk",
	"a body read in many chunks",
	"a character cut between chunks",
	"a body of 100,000 characters or more"
]

/** Bodies, aimed at each pending situation by one built to reach it. */
export const aimedBodies: Aimed<Body, BodyFeature> = aimed(bodies, [
	[
		"a body read in one chunk",
		map(bodies, (body) => ({ ...body, times: 1, chunk: LARGEST_CHUNK }))
	],
	["a body read in many chunks", map(bodies, (body) => ({ ...body, times: 200, chunk: 7 }))],
	[
		"a character cut between chunks",
		map(bodies, (body) => ({ unit: "é", times: body.times + 1, chunk: 1 }))
	],
	[
		"a body of 100,000 characters or more",
		map(bodies, (body) => ({ ...body, unit: "y", times: LONG }))
	]
])

/** An invalid value the parser refused: of a flag or an argument, its name, the text typed, and what was expected. */
export type Invalid = Readonly<{
	kind: "flag" | "argument"
	option: string
	value: string
	expected: "quoting the value" | "naming a type"
}>

/** Characters of the value a person typed, a credential's canary among them, which no print may show. */
const TYPED_CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"C",
	"A",
	"N",
	"R",
	"Y",
	"5",
	'"',
	"'",
	" ",
	"-"
]

const invalids: Gen<Invalid> = (s) => ({
	kind: s.draw(element<"flag" | "argument">(["flag", "argument"])),
	option: s.draw(string(characterOf(["a", "b", "o", "r", "t", "-"]), { min: 1, max: 10 })),
	value: `CANARY${s.draw(string(characterOf(TYPED_CHARS), { min: 0, max: 8 }))}`,
	expected: s.draw(element<Invalid["expected"]>(["quoting the value", "naming a type"]))
})

const invalidValueOf = (invalid: Invalid) =>
	CliError.InvalidValue.make({
		expected:
			invalid.expected === "quoting the value"
				? `Expected a port, got "${invalid.value}"`
				: "Expected: integer",
		kind: invalid.kind,
		option: invalid.option,
		value: invalid.value
	})

/** Every print of the invalid value: the value-free formatter's three, and the final catch's, alone and inside help. */
export const invalidPrintsOf = (invalid: Invalid) =>
	Effect.gen(function* () {
		const error = invalidValueOf(invalid)
		const help = CliError.ShowHelp.make({ commandPath: ["cli"], errors: [error] })
		const alone = yield* caughtBy(Effect.fail(error), [])
		const inHelp = yield* caughtBy(Effect.fail(help), [])
		return {
			formatError: valueFreeFormatter.formatError(error),
			formatErrors: valueFreeFormatter.formatErrors([error]),
			formatCliError: valueFreeFormatter.formatCliError(error),
			alone: { stderr: alone.stderr, standsAs: standsAs(alone), reported: reportedOf(alone) },
			inHelp: {
				stderr: inHelp.stderr,
				standsAs: standsAs(inHelp),
				exitCode: exitCodeOf(inHelp),
				reported: reportedOf(inHelp)
			}
		}
	})

/**
 * What design 7.5 (SM-3) says: an invalid value prints its kind and name, never the text typed or what was expected,
 * which can quote it; the final catch prints it once, so the error stands as itself, printed, help exiting 1.
 */
export const expectedInvalidOf = (invalid: Invalid) => {
	const subject =
		invalid.kind === "flag" ? `flag --${invalid.option}` : `argument <${invalid.option}>`
	const message = `Invalid value for ${subject}. Run with --help for usage.`
	const section = `\nERROR\n  ${message}`
	return {
		formatError: section,
		formatErrors: section,
		formatCliError: message,
		alone: { stderr: `${section}\n`, standsAs: "InvalidValue", reported: false },
		inHelp: { stderr: `${section}\n`, standsAs: "ShowHelp", exitCode: 1, reported: false }
	}
}

export type InvalidFeature = `${Invalid["kind"]}, expected ${Invalid["expected"]}`

export const invalidFeatures = (invalid: Invalid): ReadonlyArray<InvalidFeature> => [
	`${invalid.kind}, expected ${invalid.expected}`
]

export const INVALID_SITUATIONS: ReadonlyArray<InvalidFeature> = [
	"flag, expected quoting the value",
	"flag, expected naming a type",
	"argument, expected quoting the value",
	"argument, expected naming a type"
]

/** Invalid values, aimed at each kind and expectation while it is pending. */
export const aimedInvalids: Aimed<Invalid, InvalidFeature> = aimed(
	invalids,
	Arr.flatMap(["flag", "argument"] as const, (kind) =>
		Arr.map(
			["quoting the value", "naming a type"] as const,
			(expected) =>
				[
					`${kind}, expected ${expected}` as const,
					map(invalids, (invalid): Invalid => ({ ...invalid, kind, expected }))
				] as const
		)
	)
)

/** What a failure no class names is: a text, an object with a message, or a value with none. */
export type Unnamed = "a text" | "an object with a message" | "a value with none"

/**
 * A failure the final catch meets that design 7.1's rendered classes leave to it alone: an output error, a client
 * error that is no transport failure, a failure no class names (a text, an object with a message, a value with none),
 * and help with no parse error.
 */
export type Other =
	| Readonly<{ kind: "an output error"; reason: "exists" | "write" }>
	| Readonly<{ kind: "a client error that is no transport failure" }>
	| Readonly<{ kind: "a failure no class names"; failure: Unnamed }>
	| Readonly<{ kind: "help with no parse error"; path: ReadonlyArray<string> }>

export const others: FiniteSpace<Other> = finite(
	oneOf<Other>([
		(s): Other => ({
			kind: "an output error",
			reason: s.draw(element<"exists" | "write">(["exists", "write"]))
		}),
		(): Other => ({ kind: "a client error that is no transport failure" }),
		(s): Other => ({
			kind: "a failure no class names",
			failure: s.draw(element<Unnamed>(["a text", "an object with a message", "a value with none"]))
		}),
		(s): Other => ({
			kind: "help with no parse error",
			path: s.draw(element<ReadonlyArray<string>>([[], ["cli"]]))
		})
	])
)

/** The URL a client error that is no transport failure names: a request whose body could not be encoded. */
const ENCODED = "https://api.example.test/pets"

/** A failure no class names, as a program fails with it: a text, an object with a message, or a number. */
type UnnamedFailure = string | Readonly<{ message: string }> | number

/** A failure no class names, as the program fails with it. */
const unnamedOf = (failure: Unnamed): UnnamedFailure => {
	switch (failure) {
		case "a text":
			return "plain failure"
		case "an object with a message":
			return { message: "a message" }
		case "a value with none":
			return 42
	}
}

/** The line the final catch prints for a failure no class names: its text, its message, or "unknown failure". */
const unnamedLine = (failure: Unnamed): string => {
	switch (failure) {
		case "a text":
			return "plain failure"
		case "an object with a message":
			return "a message"
		case "a value with none":
			return "unknown failure"
	}
}

const failureOf = (
	other: Other
): Effect.Effect<never, OutputError | TransportError | UnnamedFailure | CliError.ShowHelp> => {
	switch (other.kind) {
		case "an output error":
			return Effect.fail(new OutputError({ path: "out.json", reason: other.reason }))
		case "a client error that is no transport failure":
			return Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.EncodeError({ request: HttpClientRequest.get(ENCODED) })
				})
			).pipe(Effect.catchTag("HttpClientError", mapClientError))
		case "a failure no class names":
			return Effect.fail(unnamedOf(other.failure))
		case "help with no parse error":
			return Effect.fail(CliError.ShowHelp.make({ commandPath: other.path, errors: [] }))
	}
}

/** How the final catch ended the run: the class the error stands as, its exit code, whether it is printed, stderr. */
export const otherCaughtOf = (other: Other) =>
	Effect.map(caughtBy(failureOf(other), []), (caught) => ({
		standsAs: standsAs(caught),
		exitCode: exitCodeOf(caught),
		reported: reportedOf(caught),
		stderr: caught.stderr
	}))

/**
 * What design 7.1 and 7.4 say: an output error prints its `Error:` line once and exits 5; a client error that is no transport
 * failure is a defect, its description printed with "internal error, please report", exiting 70; so is a failure no
 * class names, by its text or its message, else as an unknown failure; help with no parse error prints nothing here
 * and stands as itself, exiting 0.
 */
export const expectedOtherOf = (other: Other) => {
	const internal = (line: string) => ({
		standsAs: "InternalError",
		exitCode: 70,
		reported: false,
		stderr: `Error: ${line}\ninternal error, please report\n`
	})
	switch (other.kind) {
		case "an output error":
			return {
				standsAs: "OutputError",
				exitCode: 5,
				reported: false,
				stderr: `Error: cannot write out.json: ${other.reason}\n`
			}
		case "a client error that is no transport failure":
			return internal(`Encode error (GET ${ENCODED})`)
		case "a failure no class names":
			return internal(unnamedLine(other.failure))
		case "help with no parse error":
			return { standsAs: "ShowHelp", exitCode: 0, reported: false, stderr: "" }
	}
}

export type OtherFeature = Other["kind"]

export const OTHER_SITUATIONS: ReadonlyArray<OtherFeature> = [
	"an output error",
	"a client error that is no transport failure",
	"a failure no class names",
	"help with no parse error"
]

/**
 * An `--output` target meeting `send`: there before the run or not, `--force`, `--dry-run`, and whether another
 * process makes the target while the request runs.
 */
export type Targeting = Readonly<{
	present: boolean
	force: boolean
	dryRun: boolean
	raced: boolean
}>

export const targetings: FiniteSpace<Targeting> = finite((s) => ({
	present: s.draw(element([false, true])),
	force: s.draw(element([false, true])),
	dryRun: s.draw(element([false, true])),
	raced: s.draw(element([false, true]))
}))

const created: OperationMeta = {
	media: { request: [], responses: { "201": ["application/json"] } },
	method: "POST",
	operationId: "widgets-create",
	pathTemplate: "/widgets",
	security: []
}

/** The body the scripted server answers every request with. */
const ANSWER = '{"id":"w1"}'

/** What a run left: how it ended, how many requests reached the server, the target's text and the directory's names. */
export type Targeted = Readonly<{
	ended: string
	requests: number
	target: Option.Option<string>
	names: ReadonlyArray<string>
}>

/**
 * Runs `send` once with `--output <dir>/out.json` against a scripted client that counts the requests it receives,
 * making the target first when the case races, and answers 201 with ANSWER.
 */
export const targetedIn = (dir: ScratchDir, targeting: Targeting) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const target = path.join(dir, "out.json")
			if (targeting.present) {
				yield* Effect.orDie(fs.writeFileString(target, "keep"))
			}
			const requests = { count: 0 }
			const client = HttpClient.make((sent) =>
				Effect.gen(function* () {
					requests.count += 1
					if (targeting.raced) {
						yield* Effect.orDie(fs.writeFileString(target, "racer"))
					}
					return HttpClientResponse.fromWeb(
						sent,
						new Response(ANSWER, { headers: { "content-type": "application/json" }, status: 201 })
					)
				})
			)
			const context = yield* Layer.build(
				Layer.mergeAll(
					BaseUrl.layer(
						{
							boundOrigins: ["https://api.example.com"],
							defaultServer: 0,
							servers: [{ url: "https://api.example.com", variables: {} }]
						},
						PREFIX
					),
					Auth.layer({ schemes: {} }, PREFIX, []),
					ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
					Layer.succeed(FileSystem.FileSystem, fs),
					Layer.succeed(Path.Path, path),
					Stdio.layerTest({}),
					Input.stdinClaimLayer,
					runCredentialsLayer,
					Layer.succeed(Transport, {
						certified: Option.none(),
						plain: { direct: client, environment: client }
					}),
					Layer.succeed(ClientPolicy, { binName: "example", version: "1.2.3" }),
					Layer.succeed(OutputPath, Option.some(target)),
					Layer.succeed(Force, targeting.force),
					Layer.succeed(dryRunSetting, targeting.dryRun),
					Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
					Layer.succeed(BaseUrl.serverSetting, Option.none()),
					Layer.succeed(BaseUrl.serverVariableSetting, []),
					Layer.succeed(Auth.allowCredentialsForBaseUrl, false)
				)
			)
			const request = Serialize.request("POST", {
				headers: [],
				path: Serialize.path("/widgets", []),
				query: []
			})
			const exit = yield* Effect.exit(
				request.pipe(Effect.flatMap(send(created, Option.none())), Effect.provideContext(context))
			)
			const exists = yield* Effect.orDie(fs.exists(target))
			const content = exists
				? yield* Effect.asSome(Effect.orDie(fs.readFileString(target)))
				: Option.none()
			const names = yield* Effect.orDie(fs.readDirectory(dir))
			const targeted: Targeted = {
				ended: Exit.match(exit, {
					onSuccess: () => "written",
					onFailure: (cause) =>
						Option.match(Cause.findErrorOption(cause), {
							onNone: () => "a defect",
							onSome: (error) =>
								error._tag === "OutputError" ? `OutputError ${error.reason}` : error._tag
						})
				}),
				requests: requests.count,
				target: content,
				names: Arr.sort(names, Order.String)
			}
			return targeted
		})
	)

/**
 * What design 13.1 (HB4) says: `--dry-run` sends nothing and refuses nothing; an existing target without `--force` is
 * refused before any request is sent, so the server never acts on a request whose answer would be discarded, and left
 * as it was; otherwise the one request is sent and its answer replaces the target, unless the target was made while the
 * request ran and there is no `--force`, which refuses it at the link and leaves what was made. No temp file remains.
 */
export const expectedTargetedOf = (targeting: Targeting): Targeted => {
	const before = targeting.present ? Option.some("keep") : Option.none()
	const namesOf = (target: Option.Option<string>) => (Option.isSome(target) ? ["out.json"] : [])
	if (targeting.dryRun) {
		return { ended: "written", requests: 0, target: before, names: namesOf(before) }
	}
	if (targeting.present && !targeting.force) {
		return { ended: "OutputError exists", requests: 0, target: before, names: namesOf(before) }
	}
	if (targeting.raced && !targeting.force) {
		return {
			ended: "OutputError exists",
			requests: 1,
			target: Option.some("racer"),
			names: ["out.json"]
		}
	}
	return { ended: "written", requests: 1, target: Option.some(ANSWER), names: ["out.json"] }
}

export type TargetFeature =
	| "dry run"
	| "refused before sending"
	| "refused at the link"
	| "replaced by --force"
	| "written fresh"

export const targetFeatures = (targeting: Targeting): ReadonlyArray<TargetFeature> => {
	if (targeting.dryRun) {
		return ["dry run"]
	}
	if (targeting.present && !targeting.force) {
		return ["refused before sending"]
	}
	if (targeting.raced && !targeting.force) {
		return ["refused at the link"]
	}
	return [targeting.present || targeting.raced ? "replaced by --force" : "written fresh"]
}

export const TARGET_SITUATIONS: ReadonlyArray<TargetFeature> = [
	"dry run",
	"refused before sending",
	"refused at the link",
	"replaced by --force",
	"written fresh"
]
