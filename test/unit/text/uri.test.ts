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
 * Features: a reference with a scheme, with an authority, with an empty path, with an absolute path, a relative path,
 * a dot segment, a `..` past the root, an undefined query against a base's, the RFC's example base.
 */

import { resolveReference } from "@bjornpagen/grizzle-text/uri"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { referenceCaseGen, type UriFeature } from "#test/unit/text/uri.fixtures.ts"

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
			"the RFC's example base"
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
				original:
					'\t\tpath: removeDotSegments(r.path.startsWith("/") ? r.path : merge(b, r.path)),',
				replacement: '\t\tpath: r.path.startsWith("/") ? r.path : merge(b, r.path),',
				why: "A relative reference's dot segments are left in its target's path; a reference of `.` or `..` resolves to a path that still holds them."
			}
		]
	}
)
