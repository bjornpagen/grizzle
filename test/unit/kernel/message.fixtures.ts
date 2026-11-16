/** What the properties of message.test.ts read: its spaces, models and helpers. */

import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Array as Arr, Data, Option, String as Str } from "effect"
import {
	type Artifact,
	CompileError,
	malformedArtifact,
	prose,
	type ProseTag
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"

/** A tagged failure whose message is empty, and a server error it may be caused by. */
class Server extends Data.TaggedError("Server")<{
	readonly sqlstate: string
	readonly constraint: string | undefined
}> {}

/** A tagged failure with no field at all, which a plain rendering would show as `new Error("")`. */
class Released extends Data.TaggedError("Released") {}

export class Statement extends Data.TaggedError("Statement")<{
	readonly stage: string
	readonly file: string
	readonly line: number
	readonly cause: unknown
	/** A record holding an error, as a ReadError's `raised` holds its acquisition's cause. */
	readonly raised: { readonly cause: unknown }
}> {}

/** Words a report prints as they are, so a field's value is found in it as drawn. */
export const word = matching(regex("^[a-z][a-z0-9]{3,9}$"))

/** The error a failure is caused by, as data: a tagged one with fields, a fieldless one, a plain Error, or none. */
export type InnerSketch =
	| { readonly kind: "tagged"; readonly sqlstate: string; readonly constraint: string | undefined }
	| { readonly kind: "fieldless" }
	| { readonly kind: "error"; readonly text: string }
	| { readonly kind: "none" }

export const innerGen: Gen<InnerSketch> = weighted<InnerSketch>([
	[
		1,
		(source) => ({
			kind: "tagged",
			sqlstate: source.draw(matching(regex("^[0-9A-Z]{5}$"))),
			constraint: Option.getOrUndefined(source.draw(option(word)))
		})
	],
	[1, constant<InnerSketch>({ kind: "fieldless" })],
	[1, map(word, (text): InnerSketch => ({ kind: "error", text }))],
	[1, constant<InnerSketch>({ kind: "none" })]
])

/** The error an inner sketch stands for, made afresh. */
export const innerOf = (inner: InnerSketch): unknown => {
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
export const innerStated = (inner: InnerSketch): ReadonlyArray<string> => {
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
export type At = "the chain" | "a field"

export interface TaggedSketch {
	readonly stage: string
	readonly file: string
	readonly line: number
	readonly inner: InnerSketch
	readonly at: At
}

/** What a case ended with that carries no message: a value that is no Error, or an Error whose message is empty. */
export type End =
	| { readonly kind: "undefined" }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "object"; readonly value: { readonly n: number; readonly w: string } }
	| { readonly kind: "empty Error"; readonly code: string }

export const endGen: Gen<End> = weighted<End>([
	[1, constant<End>({ kind: "undefined" })],
	[1, map(word, (value): End => ({ kind: "text", value }))],
	[
		1,
		(source): End => ({
			kind: "object",
			value: { n: source.draw(int(-(2 ** 31), 2 ** 31 - 1)), w: source.draw(word) }
		})
	],
	[1, map(word, (code): End => ({ kind: "empty Error", code }))]
])

/** A path into a value: words and indices. */
const pathGen: Gen<ReadonlyArray<string | number>> = array(
	weighted<string | number>([
		[1, word],
		[1, int(0, 9)]
	]),
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
	"canonical",
	"fingerprint"
]

/**
 * A CompileError as data: a located refusal stated as a sentence, a collision of two locations, or an artifact
 * malformed at a path; and the path of a value it is found within, none when it is reported where it was made.
 */
export type CompileErrorSketch = (
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

export const compileErrorGen: Gen<CompileErrorSketch> = (source) => {
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

export const compileErrorOf = (k: CompileErrorSketch): CompileError => {
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
