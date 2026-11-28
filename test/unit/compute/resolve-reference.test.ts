/**
 * Text.resolveReference, the target of a reference resolved against a base as RFC 3986 §5.2 defines it, typed and
 * lowered as a check lowers it and evaluated on the host (scalar/compute/evaluate.ts) and by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts).
 *
 * - Property: over RFC 3986 §5.4's 42 examples and drawn bases and references (uri.fixtures.ts), each text typed by
 *   the pattern of its own value, so its type bounds it at its own bytes: the host's value of the lowered term is
 *   @bjornpagen/grizzle-text's resolveReference of the two texts, RFC 3986 read by other means
 *   (test/support/oracle/evaluate/uri.ts) and the reference evaluator's, and the example's target where it is one; the
 *   term's type bounds it within its operands' bytes and the `/` a merge adds, which a base of an authority and an empty
 *   path against a relative path reaches exactly; a query holds the term over those bounded texts, and refuses it over
 *   texts of no bound, since the SQL builds the target by concatenation.
 *
 * Oracle: a second implementation of RFC 3986 §5.2 (Appendix B's expression, §5.2.4's rules as patterns), and the RFC's
 * own examples.
 *
 * Features: each component a reference states, a dot segment, a `..` past the root, an undefined query against a
 * base's, the RFC's example base, the RFC's examples, and a target at its bound.
 */

import { codePoints } from "@bjornpagen/grizzle-text/text"
import { resolveReference } from "@bjornpagen/grizzle-text/uri"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { textBoundsOf } from "#compiler/ir/scalar.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	testPg
} from "#test/support/unit/compute/support.ts"
import {
	escaped,
	type Row,
	textColumn,
	values,
	variable
} from "#test/support/unit/compute/text.fixtures.ts"
import {
	referenceCaseGen,
	rfcExamples,
	type UriFeature
} from "#test/support/unit/text/uri.fixtures.ts"

type ResolveFeature = UriFeature | "one of the RFC's examples" | "a target at its bound"

/** A case: a base, a reference, the situations it reaches, and its target where it is one of the RFC's examples. */
interface ResolveCase {
	readonly base: string
	readonly reference: string
	readonly features: ReadonlyArray<ResolveFeature>
	readonly target: string | undefined
}

/**
 * A relative path of no dot segment against a base of an authority, an empty path and no query: the merge begins the
 * path with `/`, and every byte of either text is the target's, so it is at its type's bound.
 */
const mergedAtBound: Gen<ResolveCase> = (source) => ({
	base: source.draw(element(["http://a", "foo://a:80", "s://", "http://é"] as const)),
	reference: source.draw(element(["g", "g/h", "g;x?y#s", "é/😀", "g?"] as const)),
	features: ["a reference with a relative path"],
	target: undefined
})

/** One of the RFC's examples, a drawn reference against a drawn base, or a merge that reaches its bound. */
const resolveCase: Gen<ResolveCase> = weighted<ResolveCase>([
	[
		1,
		(source) => ({ ...source.draw(element(rfcExamples)), features: ["one of the RFC's examples"] })
	],
	[3, (source) => ({ ...source.draw(referenceCaseGen), target: undefined })],
	[1, mergedAtBound]
])

/** A text column whose pattern is `value` alone, so its type bounds it at exactly its own bytes. */
const exactly = (value: string): LeafBinding => ({
	kind: "column",
	type: testPg.regex(`^${Arr.join(Arr.map(codePoints(value), escaped), "")}$`, "u").scalar
})

const resolved: ExprDesc = {
	kind: "compute",
	fn: "resolveReference",
	args: [variable("b"), variable("r")]
}

/** Text.resolveReference is RFC 3986's target of every reference against every base, within the bound its type states. */
export const computeResolveReferenceIsRFC3986sTargetOfEveryReferenceAgainstEveryBaseWithinTheBoundItsTypeStates =
	property.explore(resolveCase, {
		needs: {},
		situations: [
			"a reference with a scheme",
			"a reference with an authority",
			"a reference with an empty path",
			"a reference with an absolute path",
			"a reference with a relative path",
			"a dot segment",
			"a .. past the root",
			"an undefined query against a base's",
			"the RFC's example base",
			"one of the RFC's examples",
			"a target at its bound"
		] satisfies ReadonlyArray<Reached<ResolveFeature>>,
		check:
			(_, k: Case<ResolveFeature>) =>
			({ base, reference, features, target }) =>
				Effect.sync(() => {
					for (const feature of features) {
						k.note(feature)
					}
					const label = `${Formatter.format(reference)} against ${Formatter.format(base)}`
					const bounded = { b: exactly(base), r: exactly(reference) }
					const lowered = succeeded(
						lowerWith("check", resolved, bounded, false, baseParams),
						label
					).root
					const row: Row = new Map([
						["b", base],
						["r", reference]
					])
					const { host, reference: modelled } = values(lowered.expr, row)
					const expected = resolvedReference(base, reference)
					assert.equal(
						host,
						resolveReference(base, reference),
						`the host's is grizzle-text's: ${label}`
					)
					assert.equal(host, expected, `the host's is RFC 3986's: ${label}`)
					assert.equal(modelled, expected, `the reference evaluator's is RFC 3986's: ${label}`)
					if (target !== undefined) {
						assert.equal(host, target, `the RFC's target: ${label}`)
					}
					const bound = textBoundsOf(lowered.nominal)?.bytes
					const bytes = utf8Length(expected)
					assert.ok(
						bound !== undefined && bytes <= bound,
						`the target's ${bytes} bytes within its type's bound ${String(bound)}: ${label}`
					)
					if (bytes === bound) {
						k.note("a target at its bound")
					}
					succeeded(
						lowerWith("query", resolved, bounded, false, baseParams),
						`a query over bounded texts: ${label}`
					)
					const error = refused(
						lowerWith("query", resolved, { b: textColumn, r: textColumn }, false, baseParams),
						"UnsupportedOperation",
						`a query over unbounded texts: ${label}`
					)
					assert.ok(
						Str.includes("resolveReference in a query")(error.message),
						`refused for its concatenation: ${error.message}`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "RFC 3986 read by other means (Appendix B's expression, §5.2.4's rules as patterns), and its §5.4 examples"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\treturn (args) => Result.ok(resolveReference(hostOf("text", a(args)), hostOf("text", b(args))))',
				replacement:
					'\t\t\treturn (args) => Result.ok(resolveReference(hostOf("text", b(args)), hostOf("text", a(args))))',
				why: "The host resolves the base against the reference; the host's value is not RFC 3986's target."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\t\t: baseBytes + referenceBytes + mergedSlashBytes",
				replacement: "\t\t\t\t: baseBytes + referenceBytes",
				why: "The type leaves out the `/` a merge adds, so a relative reference against a base of an authority and an empty path resolves past its type's bound."
			}
		]
	})
