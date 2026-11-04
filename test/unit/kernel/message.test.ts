/**
 * What a failure report says of the error a property ended with (test/support/message.ts): a CompileError, whose
 * message is empty, by its reason, location and capability; a tagged failure or defect by its tag and every field, down
 * the chain of its causes and through its fields; and an end that is no Error, or an Error of no message, by what it
 * is.
 */

import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, map, oneOf, option } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Duration, Effect, Formatter, Option, Schema } from "effect"
import { compileReasonText, malformedDescription } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { assert, containsText, refusalLoc } from "#test/support/assert.ts"
import { messageOf } from "#test/support/message.ts"

/** A tagged failure whose message is empty, and a server error it may be caused by. */
class Server extends Schema.TaggedError<Server, { readonly brand: unique symbol }>()("Server", {
	sqlstate: Schema.String,
	constraint: Schema.UndefinedOr(Schema.String)
}) {}

/** A tagged failure with no field at all, which a plain rendering would show as `new Error("")`. */
class Released extends Schema.TaggedError<Released, { readonly brand: unique symbol }>()(
	"Released",
	{}
) {}

class Statement extends Schema.TaggedError<Statement, { readonly brand: unique symbol }>()(
	"Statement",
	{
		stage: Schema.String,
		file: Schema.String,
		line: Schema.Finite,
		cause: Schema.Unknown,
		/** A record holding an error, as a ReadError's `raised` holds its acquisition's cause. */
		raised: Schema.Struct({ cause: Schema.Unknown })
	}
) {}

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
			return Server.make({ sqlstate: inner.sqlstate, constraint: inner.constraint })
		case "fieldless":
			return Released.make({})
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

describe("a failure's message", () => {
	it("states a CompileError by its reason, location and capability", () => {
		/** Fields no other part of the message spells. */
		const planted = malformedDescription(SourceLoc("location L7", []), "capability C9")
		const stated = messageOf(planted)
		containsText(stated, planted.reason._tag, "the message states the reason")
		containsText(stated, formatLoc(refusalLoc(planted)), "the message states the location")
		containsText(stated, compileReasonText(planted.reason), "the message states the capability")
	})

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
						caseHang: Duration.minutes(2)
					},
					(k, c) =>
						Effect.sync(() => {
							const inner = innerOf(k.inner)
							const failure = Statement.make({
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
					caseHang: Duration.minutes(2)
				},
				(end, c) =>
					Effect.sync(() => {
						c.note(`ended with ${end.kind}`)
						switch (end.kind) {
							case "undefined":
								assert.equal(messageOf(undefined), "a value that is no Error: undefined")
								return
							case "text":
							case "object":
								assert.equal(
									messageOf(end.value),
									`a value that is no Error: ${Formatter.format(end.value)}`
								)
								return
							case "empty Error":
								assert.equal(
									messageOf(Object.assign(new Error(), { code: end.code })),
									`Error {"code":${Formatter.format(end.code)}}`
								)
								return
						}
					})
			)
		)
	)
})
