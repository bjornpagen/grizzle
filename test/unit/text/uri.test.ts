/**
 * URI reference resolution (packages/text/src/uri.ts resolveReference), RFC 3986 §5.2: the target of a reference read
 * against a base.
 *
 * - Property: over drawn bases (a scheme, an authority or none, a path of drawn segments, a query or none, the RFC's
 *   own example base among them) and drawn references (each of the five components stated or not, a path of `.`,
 *   `..`, empty and named segments, absolute or relative), resolveReference gives the oracle's target. Oracle: a second
 *   implementation, the RFC's text read by other means: Appendix B's own regular expression splits each reference into
 *   its components, §5.2.4's rules A to E rewrite the path by their own patterns over its input buffer, and §5.2.2 and
 *   §5.3 transform and recompose the components.
 *
 * - Property: over the same drawn bases and references, percent-encoded dots among their segments (`%2E`, which is no
 *   dot segment), resolveWithin answers Within exactly when no `..` of the path the resolution walks climbs past its
 *   root, its target then resolveReference's and the oracle's, and AboveBase otherwise, by the count of such climbs.
 *   Oracle: a depth over the walked path's segments, read apart from §5.2.4's rules (oracle/evaluate/uri.ts climbsOf).
 *
 * Features: a reference with a scheme, with an authority, with an empty path, with an absolute path, a relative path,
 * a dot segment, a `..` past the root, an undefined query against a base's, the RFC's example base, a percent-encoded
 * dot.
 */

import { resolveReference, resolveWithin } from "@bjornpagen/grizzle-text/uri"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { climbsOf, resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { referenceCaseGen, type UriFeature } from "#test/support/unit/text/uri.fixtures.ts"

/** resolveReference gives every drawn reference's target against every drawn base as RFC 3986 §5.2 defines it. */
export const resolveReferenceGivesEveryDrawnReferencesTargetAsRFC3986Defines = property.explore(
	referenceCaseGen,
	{
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
			"a percent-encoded dot"
		] satisfies ReadonlyArray<Reached<UriFeature>>,
		check:
			(_, c: Case<UriFeature>) =>
			({ base, reference, features }) =>
				Effect.sync(() => {
					for (const feature of features) {
						c.note(feature)
					}
					assert.equal(
						resolveReference(base, reference),
						resolvedReference(base, reference),
						`${reference} against ${base}`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "RFC 3986 read by other means: Appendix B's expression, §5.2.4's rules as patterns, §5.2.2 and §5.3"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/uri.ts",
				original: '\tconst path = walked(r.path.startsWith("/") ? r.path : merge(b, r.path))',
				replacement:
					'\tconst path = { path: r.path.startsWith("/") ? r.path : merge(b, r.path), climbed: 0 }',
				why: "A relative reference's dot segments are left in its target's path; a reference of `.` or `..` resolves to a path that still holds them."
			}
		]
	}
)

/** resolveWithin is Within exactly when no `..` of the walked path climbs past its root, AboveBase by how many do. */
export const resolveWithinIsWithinExactlyWhenNoDotDotOfTheWalkClimbsPastTheBaseAndAboveBaseByHowManyDo =
	property.explore(referenceCaseGen, {
		needs: {},
		situations: [
			"a reference with a relative path",
			"a dot segment",
			"a .. past the root",
			"a percent-encoded dot"
		] satisfies ReadonlyArray<Reached<UriFeature>>,
		check:
			(_, c: Case<UriFeature>) =>
			({ base, reference, features }) =>
				Effect.sync(() => {
					for (const feature of features) {
						c.note(feature)
					}
					const climbs = climbsOf(base, reference)
					assert.deepEqual(
						resolveWithin(base, reference),
						climbs === 0
							? { _tag: "Within", target: resolvedReference(base, reference) }
							: { _tag: "AboveBase", climbed: climbs },
						`${reference} within ${base}`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "a depth over the walked path's segments, read apart from §5.2.4's rules, and RFC 3986 read by other means"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/uri.ts",
				original: '		if (output === "") {\n\t\t\tclimbed += 1\n\t\t}\n',
				replacement: "",
				why: "A `..` past the root over an empty output is clamped, as the RFC clamps it, and not counted: a reference that climbs above its base resolves Within."
			}
		]
	})
