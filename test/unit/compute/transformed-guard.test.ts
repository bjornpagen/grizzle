/**
 * Compute's text transforms (collapse, a translation, lowerAscii, replaceWhitespace, a cast into the text's own type)
 * as a guard and a cast read their images, each property stated in full at its own description below:
 *
 * - A guard over a transformed text proves a partial operation exactly when the transform's image and the guard's
 *   pattern together lie inside the operation's form. Oracle: language inclusion of the image as README states it.
 * - A chain of transforms cast into a byte-bounded text compiles exactly when its language lies inside the target's
 *   pattern and its bytes within the target's bound, every image evaluated on the host within the bound. Oracle: each
 *   step's language and bytes as README states them, by a dynamic program over counts of characters and bytes.
 *
 * Features: each route admitted and refused, for the guard and for the byte cast.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined } from "#test/support/assert.ts"
import { checkedIn } from "#test/support/policy.ts"
import {
	boundedTargets,
	byteCaseSpace,
	type ByteFeature,
	byteRoutes,
	bytesOf,
	caseGen,
	castUnder,
	chained,
	type Feature,
	formOf,
	hostChain,
	hostStep,
	imageOf,
	installsStored,
	isTranslating,
	kindsOver,
	languageSource,
	lettersIn,
	longestWithin,
	mapOf,
	mostOf,
	nfaOf,
	operandLanguage,
	operandPattern,
	projected,
	relationOf,
	routes,
	stepped,
	typedWithin
} from "#test/unit/compute/transformed-guard.fixtures.ts"
import { jsMatcher } from "#test/unit/text/generators.ts"

/** A guard over a transformed text proves a partial operation exactly when the transform's image and the guard's pattern together lie inside its form. Its budget is its suite's before it was a property (test/unit/compute/transformed-guard.test.ts at 4ca3036a): 800 runs and 800 steered cases. */
export const aGuardOverATransformedTextProvesAPartialOperationExactlyWhenTheTransformsImageAndTheGuardsPatternTogetherLieInsideItsForm =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 800, steered: 800 },
		situations: Arr.flatMap(routes, (r): Arr.NonEmptyReadonlyArray<Feature> => [
			`${r} admitted`,
			`${r} refused`
		]) satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, run: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				if (!analyzeText([{ source: c.guard, flags: "u" }], SourceLoc("guard", [])).ok) {
					return
				}
				const image = imageOf(c.transform)
				const checked = checkedIn(schema("Transformed", [relationOf(c)], []))
				run.note(`${c.transform.kind} ${checked.ok ? "admitted" : "refused"}`)
				if (!analyzeText([{ source: c.guard, flags: "u" }, image], SourceLoc("guard", [])).ok) {
					assert.ok(
						!checked.ok && checked.error.reason._tag === "UnsupportedOperation",
						`${Formatter.format(c)}: a guard no image value matches is refused`
					)
					return
				}
				const verdict = inclusion(
					[nfaOf(c.guard, "u"), nfaOf(image.source, image.flags)],
					[nfaOf(formOf(c.operation), "u")]
				).kind
				const label = `${Formatter.format(c)}: ${verdict}`
				if (verdict === "bounded") {
					assert.ok(!checked.ok && checked.error.reason._tag === "ResourceBound", label)
					return
				}
				assert.equal(
					checked.ok,
					verdict === "included",
					`${label}, ${checked.ok ? "admitted" : checked.error.message}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "language inclusion of the guard's pattern and the transform's image of every text, as README states it, in the operation's form"
		},
		kept: [],
		kills: []
	})

/** A transformed text's byte bound admits a cast into a bounded text exactly when the bound its operations prove and their language fit it. Its budget is its suite's before it was a property (test/unit/compute/transformed-guard.test.ts at 4ca3036a): 400 runs and 800 steered cases. */
export const aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt =
	property.explore(byteCaseSpace, {
		needs: {},
		budget: { runs: 400, steered: 800 },
		situations: [
			...Arr.flatMap(byteRoutes, (r): Arr.NonEmptyReadonlyArray<ByteFeature> => [
				`${r} admitted`,
				`${r} refused`
			]),
			"a translation to wider characters",
			"fewer characters than bytes",
			"a refusal by the bound alone",
			"a refusal by the pattern alone",
			"an admission at its bound",
			"a chain of two",
			["collapse admitted", "an admission by a guard of its bytes alone"]
		] satisfies ReadonlyArray<Reached<ByteFeature>>,
		check: (_, run: CaseOf<ByteFeature>) => (c) =>
			Effect.sync(() => {
				const operand = operandPattern(c.operand)
				const OperandText = str.bytes(
					c.operand.bytes,
					regexField<string>(operand.source, [operand.flags])
				)
				const first = typedWithin(operandLanguage(c.operand), c.operand.bytes)
				const [head] = c.steps
				const steps = Arr.scan(c.steps, { typed: first, widened: false, fewer: false }, (s, step) =>
					stepped(s.typed, step, first)
				)
				const typed = Arr.lastNonEmpty(steps).typed
				for (const s of steps) {
					if (s.widened) {
						run.note("a translation to wider characters")
					}
					if (s.fewer) {
						run.note("fewer characters than bytes")
					}
				}
				if (c.steps.length === 2) {
					run.note("a chain of two")
				}
				const high =
					c.guard.kind === "bytes" ? Math.max(0, typed.bytes + c.guard.slack) : typed.bytes
				const bound = Math.min(typed.bytes, high)
				const target = defined(boundedTargets[c.target.pattern])
				const bytes = Math.max(0, bound + c.target.slack)
				const TargetText = str.bytes(bytes, regexField<string>(target.source, [target.flags]))
				const checked = checkedIn(
					schema(
						"Bounded",
						[
							relation.generated("R", { id: uuid, t: OperandText }, ["id"], (r) => ({
								n: generatedField(
									TargetText,
									castUnder(c.guard, chained(c.steps, r.t), high, TargetText),
									[]
								)
							}))
						],
						[]
					)
				)
				const route = Arr.lastNonEmpty(c.steps).kind
				run.note(`${route} ${checked.ok ? "admitted" : "refused"}`)
				installsStored(c.steps, OperandText, TargetText)
				const verdict = inclusion(
					[nfaOf(languageSource(typed.language), "u")],
					[nfaOf(target.source, target.flags)]
				).kind
				const longest = longestWithin(typed.language, bound)
				const label = `${Formatter.format(c)}: ${verdict} within ${bound} bytes, its longest text ${longest}, cast into ${bytes}`
				if (verdict === "bounded") {
					assert.ok(!checked.ok && checked.error.reason._tag === "ResourceBound", label)
					return
				}
				assert.equal(
					checked.ok,
					verdict === "included" && longest <= bytes,
					`${label}, ${checked.ok ? "admitted" : checked.error.message}`
				)
				if (!checked.ok) {
					assert.equal(checked.error.reason._tag, "PartialOperation", label)
					if (verdict === "included") {
						run.note("a refusal by the bound alone")
					} else if (longest <= bytes) {
						run.note("a refusal by the pattern alone")
					}
				} else {
					if (bound === bytes) {
						run.note("an admission at its bound")
					}
					if (longestWithin(typed.language, typed.bytes) > bytes) {
						run.pair(`${route} admitted`, "an admission by a guard of its bytes alone")
					}
				}
				const kinds = kindsOver(
					lettersIn(first.language),
					isTranslating(head) ? mapOf(head) : new Map<number, number>()
				)
				const most = mostOf(kinds, first.bytes, first.chars)
				if (isTranslating(head)) {
					assert.equal(
						bytesOf(hostStep(head, most.witness, most.witness)),
						defined(steps[1]).typed.bytes,
						`${label}: the first translation's widest image takes its bound`
					)
				}
				for (const value of [most.witness, ...Arr.map(c.values, (v) => projected(c.operand, v))]) {
					const image = hostChain(c.steps, value)
					assert.ok(
						bytesOf(image) <= typed.bytes,
						`${label}: ${Formatter.format(value)} becomes ${Formatter.format(image)}, within the bound`
					)
					if (checked.ok && bytesOf(image) <= bound) {
						assert.ok(
							bytesOf(image) <= bytes && jsMatcher(target.source, target.flags)(image),
							`${label}: ${Formatter.format(image)} is of the target`
						)
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "each step's language as README states it, its bytes by a dynamic program over counts of characters and bytes, inclusion in the target, and the chain evaluated by hand on the host"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/compute/transformed-guard.test.ts#aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt:-:6.5.0.0.0.1.5.0.0.0.0"
				),
				reason:
					"qti-pie's key: lowerAscii(collapse(x)) over x of at most 2587 bytes, stored in a generated field of that type, which the collapse and the case fold each keep within x's bound",
				since: "2026-11-08"
			},
			{
				token: ReplayToken(
					"test/unit/compute/transformed-guard.test.ts#aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt:-:0.1.1.4.1.8.0.0.1.5.0.2.0.0"
				),
				reason:
					"a pin run's draw: lowerAscii(collapse(x)) over x of at most 1 byte of spaces and euro signs, whose every value collapses to the empty text, cast into text of no byte",
				since: "2026-11-09"
			},
			{
				token: ReplayToken(
					"test/unit/compute/transformed-guard.test.ts#aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt:-:0.1.1.4.1.a.0.0.0.0.2.0.0"
				),
				reason:
					"a full run's draw: collapse(x) over x of at most 1 byte of spaces and U+1F600, whose every value collapses to the empty text, cast into text of no byte",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/compute/transformed-guard.test.ts#aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt:-:0.4.1.9.0.0.0.0.0.2.0.0"
				),
				reason:
					"collapse(x) over x of at most 4 bytes of euro signs, each of 3 bytes, so no value takes 4, cast into text of 3 bytes",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/compute/transformed-guard.test.ts#aTransformedTextsByteBoundAdmitsACastIntoABoundedTextExactlyWhenTheBoundItsOperationsProveAndTheirLanguageFitIt:-:0.1.0.0.0.1.2.2.4.0.8.0.0.2.0.0"
				),
				reason:
					'a full run\'s draw: translate(collapse(x), " a", "éa") over x of at most 1 byte of every character, whose collapse holds no space, so the translation keeps 1 byte and a cast 1 byte below it is refused; an oracle that reads the bounded collapse\'s middle where its count leaves it no room bounds it at 2 and refuses the cast into 1 byte',
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\t: this.restate(node, this.collapseType(text, analysis, at), node.actual, node.facts)",
				replacement: "\t\t\t: { ...node, nominal: this.collapseType(text, analysis, at) }",
				why: "Collapse writes its language over the term after settle, `{ ...node, nominal: collapseType(...) }`, which drops the bound a guard of its byte count gives each occurrence of it in the branch; the byte cast property fails where that guard alone admits the cast."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\ttext.byteBound,",
				replacement: "\t\t\tundefined,",
				why: "A collapse carries no byte bound, so a cast of it is refused where the bound fits; the byte cast property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/lower.ts",
				original:
					'\treturn longest.kind === "within" && longest.bytes <= octets ? premise(longest.bytes) : undefined',
				replacement:
					'\treturn longest.kind === "within" && bound <= octets ? premise(longest.bytes) : undefined',
				why: "A cast compares its operand's bound, not the longest text of its language within it, so it is refused where a collapse drops what the bound leaves room for; the byte cast property fails."
			}
		]
	})
