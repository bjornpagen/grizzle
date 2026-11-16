/**
 * What a failure report says of the error a property ended with (test/support/message.ts): a CompileError by its
 * reason, location and sentence, a collision's other location and an artifact's path, wherever it was found; a tagged failure or defect by its tag and every field, down
 * the chain of its causes and through its fields; and an end that is no Error, or an Error of no message, by what it
 * is.
 *
 * Oracle: the specification of a report, each fact it must state, checked as text the report contains: the drawn
 * words are four to ten lowercase letters, which no fixed text of a report holds in that form by chance alone.
 *
 * Features: a prose refusal, a collision and a malformed artifact, found within a value; a cause that is tagged,
 * fieldless, a plain Error or none, in the chain or in a field; an end that is undefined, a text, an object or an Error
 * of no message.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { compileReasonText, within } from "#compiler/core/errors.ts"
import { formatLoc, formatPath } from "#compiler/core/loc.ts"
import { containsText, refusalLoc } from "#test/support/assert.ts"
import { messageOf } from "#test/support/message.ts"
import {
	type At,
	compileErrorGen,
	compileErrorOf,
	type CompileErrorSketch,
	type End,
	endGen,
	innerGen,
	innerOf,
	type InnerSketch,
	innerStated,
	Statement,
	type TaggedSketch,
	word
} from "#test/unit/kernel/message.fixtures.ts"

/** A failure's message states a CompileError by its reason, location and sentence, a collision's other location and an artifact's path. */
export const aFailuresMessageStatesACompileErrorByItsReasonLocationAndSentenceACollisionsOtherLocationAndAnArtifactsPath =
	property.explore(compileErrorGen, {
		needs: {},
		situations: ["prose", "collision", "artifact", "found within a value"] satisfies ReadonlyArray<
			Reached<CompileErrorSketch["kind"] | "found within a value">
		>,
		check: (_, c: Case<CompileErrorSketch["kind"] | "found within a value">) => (k) =>
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
					containsText(stated, formatLoc(reason.other), "the message states the other location")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the reason's tag, its location formatted, its sentence (compileReasonText) and a collision's other location, each in the report"
		},
		kept: [],
		kills: []
	})

/** A failure's message states a tagged failure by its tag and every field, down the chain of its causes and through its fields. */
export const aFailuresMessageStatesATaggedFailureByItsTagAndEveryFieldDownTheChainOfItsCausesAndThroughItsFields =
	property.explore(
		(source): TaggedSketch => ({
			stage: source.draw(word),
			file: source.draw(word),
			line: source.draw(int(-1000, 1000)),
			inner: source.draw(innerGen),
			at: source.draw(element<At>(["the chain", "a field"]))
		}),
		{
			needs: {},
			situations: [
				"caused: tagged",
				"caused: fieldless",
				"caused: error",
				"caused: none",
				"inner in the chain",
				"inner in a field"
			] satisfies ReadonlyArray<Reached<`caused: ${InnerSketch["kind"]}` | `inner in ${At}`>>,
			check: (_, c: Case<`caused: ${InnerSketch["kind"]}` | `inner in ${At}`>) => (k) =>
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
				}),
			oracle: {
				kind: "specification",
				name: "the tag, every field and every cause's facts, each in the report"
			},
			kept: [],
			kills: []
		}
	)

/** A failure's message states an end that is no Error, or an Error of no message, by what it is. */
export const aFailuresMessageStatesAnEndThatIsNoErrorOrAnErrorOfNoMessageByWhatItIs =
	property.explore(endGen, {
		needs: {},
		situations: [
			"ended with undefined",
			"ended with text",
			"ended with object",
			"ended with empty Error"
		] satisfies ReadonlyArray<Reached<`ended with ${End["kind"]}`>>,
		check: (_, c: Case<`ended with ${End["kind"]}`>) => (end) =>
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
			}),
		oracle: { kind: "specification", name: "the end's own formatting, in the report" },
		kept: [],
		kills: []
	})
