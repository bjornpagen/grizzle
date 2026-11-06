/**
 * What a failure report says of the error a property ended with (test/support/message.ts): a CompileError by its
 * reason, location and sentence, a collision's other location and an artifact's path, wherever it was found; a tagged failure or defect by its tag and every field, down
 * the chain of its causes and through its fields; and an end that is no Error, or an Error of no message, by what it
 * is.
 */

import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, option } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import {
	type Artifact,
	CompileError,
	compileReasonText,
	malformedArtifact,
	type ProseTag,
	prose,
	within
} from "#compiler/core/errors.ts"
import { formatLoc, formatPath, SourceLoc } from "#compiler/core/loc.ts"
import { containsText, refusalLoc } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"

/** A tagged failure whose message is empty, and a server error it may be caused by. */
class Server extends Data.TaggedError("Server")<{
	readonly sqlstate: string
	readonly constraint: string | undefined
}> {}

/** A tagged failure with no field at all, which a plain rendering would show as `new Error("")`. */
class Released extends Data.TaggedError("Released") {}

class Statement extends Data.TaggedError("Statement")<{
	readonly stage: string
	readonly file: string
	readonly line: number
	readonly cause: unknown
	/** A record holding an error, as a ReadError's `raised` holds its acquisition's cause. */
	readonly raised: { readonly cause: unknown }
}> {}

/** Words a report prints as they are, so a field's value is found in it as drawn. */
const word = matching(regex("^[a-z][a-z0-9]{3,9}$"))

/** The error a failure is caused by, as data: a tagged one with fields, a fieldless one, a plain Error, or none. */
type InnerSketch =
	| { readonly kind: "tagged"; readonly sqlstate: string; readonly constraint: string | undefined }
	| { readonly kind: "fieldless" }
	| { readonly kind: "error"; readonly text: string }
	| { readonly kind: "none" }

const innerGen: Gen<InnerSketch> = oneOf<InnerSketch>([
	(source) => ({
		kind: "tagged",
		sqlstate: source.draw(matching(regex("^[0-9A-Z]{5}$"))),
		constraint: Option.getOrUndefined(source.draw(option(word)))
	}),
	constant<InnerSketch>({ kind: "fieldless" }),
	map(word, (text): InnerSketch => ({ kind: "error", text })),
	constant<InnerSketch>({ kind: "none" })
])

/** The error an inner sketch stands for, made afresh. */
const innerOf = (inner: InnerSketch): unknown => {
	switch (inner.kind) {
		case "tagged":
			return new Server({ sqlstate: inner.sqlstate, constraint: inner.constraint })
		case "fieldless":
			return new Released()
		case "error":
			return new Error(inner.text)
		case "none":
			return undefined
	}
}

/** The text a report must state of an inner error. */
const innerStated = (inner: InnerSketch): ReadonlyArray<string> => {
	switch (inner.kind) {
		case "tagged":
			return [
				"Server",
				inner.sqlstate,
				...(inner.constraint === undefined ? [] : [inner.constraint])
			]
		case "fieldless":
			return ["Released"]
		case "error":
			return [inner.text]
		case "none":
			return []
	}
}

/** Where the inner error sits: the failure's cause, or a field's record. */
type At = "the chain" | "a field"

interface TaggedSketch {
	readonly stage: string
	readonly file: string
	readonly line: number
	readonly inner: InnerSketch
	readonly at: At
}

/** What a case ended with that carries no message: a value that is no Error, or an Error whose message is empty. */
type End =
	| { readonly kind: "undefined" }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "object"; readonly value: { readonly n: number; readonly w: string } }
	| { readonly kind: "empty Error"; readonly code: string }

const endGen: Gen<End> = oneOf<End>([
	constant<End>({ kind: "undefined" }),
	map(word, (value): End => ({ kind: "text", value })),
	(source): End => ({
		kind: "object",
		value: { n: source.draw(int(-(2 ** 31), 2 ** 31 - 1)), w: source.draw(word) }
	}),
	map(word, (code): End => ({ kind: "empty Error", code }))
])

/** A path into a value: words and indices. */
const pathGen: Gen<ReadonlyArray<string | number>> = array(
	oneOf<string | number>([word, int(0, 9)]),
	{
		min: 0,
		max: 3
	}
)

/** A location: a word for its label and a path. */
const locGen: Gen<SourceLoc> = (source) => SourceLoc(source.draw(word), source.draw(pathGen))

/** The reasons whose one fact is a sentence: the located refusals a builder states in its own words. */
const proseTags: Arr.NonEmptyReadonlyArray<ProseTag> = [
	"MalformedDescription",
	"UnsupportedOperation",
	"UnsupportedLawFamily",
	"MissingDiscriminant",
	"AttachedParentUnbound",
	"AttachedPage",
	"DescribedHeadingMismatch",
	"ContractLiteral"
]

const artifacts: Arr.NonEmptyReadonlyArray<Artifact> = [
	"snapshot",
	"manifest",
	"folder",
	"meta",
	"ledger",
	"cursor",
	"canonical",
	"fingerprint"
]

/**
 * A CompileError as data: a located refusal stated as a sentence, a collision of two locations, or an artifact
 * malformed at a path; and the path of a value it is found within, none when it is reported where it was made.
 */
type CompileErrorSketch = (
	| {
			readonly kind: "prose"
			readonly tag: ProseTag
			readonly at: SourceLoc
			readonly text: string
	  }
	| {
			readonly kind: "collision"
			readonly at: SourceLoc
			readonly other: SourceLoc
			readonly identifier: string
	  }
	| {
			readonly kind: "artifact"
			readonly artifact: Artifact
			readonly at: ReadonlyArray<string | number>
			readonly text: string
	  }
) & { readonly within: ReadonlyArray<string | number> }

const compileErrorGen: Gen<CompileErrorSketch> = (source) => {
	const within = source.draw(pathGen)
	switch (source.draw(element(["prose", "collision", "artifact"] as const))) {
		case "prose":
			return {
				kind: "prose",
				tag: source.draw(element(proseTags)),
				at: source.draw(locGen),
				text: source.draw(word),
				within
			}
		case "collision":
			return {
				kind: "collision",
				at: source.draw(locGen),
				other: source.draw(locGen),
				identifier: source.draw(word),
				within
			}
		case "artifact":
			return {
				kind: "artifact",
				artifact: source.draw(element(artifacts)),
				at: source.draw(pathGen),
				text: source.draw(word),
				within
			}
	}
}

const compileErrorOf = (k: CompileErrorSketch): CompileError => {
	switch (k.kind) {
		case "prose":
			return CompileError.make(prose(k.tag, k.at, k.text))
		case "collision":
			return CompileError.make({
				_tag: "IdentifierCollision",
				at: k.at,
				other: k.other,
				identifier: k.identifier,
				what: "relation",
				declaration: `relation ${k.identifier}`,
				otherDeclaration: `relation ${Str.capitalize(k.identifier)}`
			})
		case "artifact":
			return malformedArtifact(k.artifact, k.at, k.text)
	}
}

describe("a failure's message", () => {
	it.effect(
		"states a CompileError by its reason, location and sentence, a collision's other location and an artifact's path",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/kernel/compile-error-message",
						draw: drawn(compileErrorGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the reason's tag, its location formatted, its sentence (compileReasonText) and a collision's other location, each in the report"
						},
						coverage: required<CompileErrorSketch["kind"] | "found within a value">(
							["prose", "collision", "artifact", "found within a value"],
							{ cases: 80, sense: notesOnly }
						),
						kept: [],
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							c.note(k.kind)
							const made = compileErrorOf(k)
							const error = Arr.isReadonlyArrayNonEmpty(k.within) ? within(made, k.within) : made
							if (Arr.isReadonlyArrayNonEmpty(k.within)) {
								c.note("found within a value")
							}
							const stated = messageOf(error)
							const reason = error.reason
							containsText(stated, reason._tag, "the message states the reason")
							containsText(stated, compileReasonText(reason), "the message states the sentence")
							if (reason._tag === "MalformedArtifact") {
								containsText(stated, reason.artifact, "the message states the artifact")
								if (Arr.isReadonlyArrayNonEmpty(reason.at)) {
									containsText(stated, formatPath(reason.at), "the message states the path")
								}
								return
							}
							containsText(stated, formatLoc(refusalLoc(error)), "the message states the location")
							if (reason._tag === "IdentifierCollision") {
								containsText(
									stated,
									formatLoc(reason.other),
									"the message states the other location"
								)
							}
						})
				)
			)
	)

	it.effect(
		"states a tagged failure by its tag and every field, down the chain of its causes and through its fields",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/kernel/tagged-message",
						draw: drawn((source): TaggedSketch => ({
							stage: source.draw(word),
							file: source.draw(word),
							line: source.draw(int(-1000, 1000)),
							inner: source.draw(innerGen),
							at: source.draw(element<At>(["the chain", "a field"]))
						})),
						literal: Formatter.format,
						coverage: required<`caused: ${InnerSketch["kind"]}` | `inner in ${At}`>(
							[
								"caused: tagged",
								"caused: fieldless",
								"caused: error",
								"caused: none",
								"inner in the chain",
								"inner in a field"
							],
							{ cases: 80, sense: notesOnly }
						),
						kept: [],
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const inner = innerOf(k.inner)
							const failure = new Statement({
								stage: k.stage,
								file: k.file,
								line: k.line,
								cause: k.at === "the chain" ? inner : undefined,
								raised: { cause: k.at === "a field" ? inner : undefined }
							})
							c.note(`caused: ${k.inner.kind}`)
							if (inner !== undefined) {
								c.note(`inner in ${k.at}`)
							}
							const stated = messageOf(failure)
							containsText(stated, "Statement", "the message states the tag")
							containsText(stated, k.stage, "the message states the stage")
							containsText(stated, k.file, "the message states the file")
							containsText(stated, `${k.line}`, "the message states the line")
							for (const text of innerStated(k.inner)) {
								containsText(stated, text, `the message states ${text}`)
							}
						})
				)
			)
	)

	it.effect("states an end that is no Error, or an Error of no message, by what it is", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/kernel/no-error-message",
					draw: drawn(endGen),
					literal: Formatter.format,
					coverage: required<`ended with ${End["kind"]}`>(
						[
							"ended with undefined",
							"ended with text",
							"ended with object",
							"ended with empty Error"
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(end, c) =>
					Effect.sync(() => {
						c.note(`ended with ${end.kind}`)
						switch (end.kind) {
							case "undefined":
								containsText(messageOf(undefined), "undefined")
								return
							case "text":
							case "object":
								containsText(messageOf(end.value), Formatter.format(end.value))
								return
							case "empty Error":
								containsText(messageOf(Object.assign(new Error(), { code: end.code })), end.code)
								return
						}
					})
			)
		)
	)
})
