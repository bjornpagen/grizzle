/**
 * A nested insert's wire (live/member.ts memberShape, over runtime/write/nesting.ts NestingData), over drawn schemas of
 * trees, ordered and counted families nested in each other, folds and copies (test/support/families/fill.ts), each
 * served by a login of one role whose workload holds one ChangeSet inserting every relation an instance of the schema
 * inserts, its array members the call's, as `grizzle generate` compiles it, with no database:
 *
 * - Every nesting the write compiler accepts projects to a wire: where the login's compile accepts the ChangeSet
 *   (adapter/served/compile.ts snapshotCompiled), its projection into the served file holds its wire, or refuses it as
 *   a member no served file holds (UnservedMember), the compiler's own refusal to serve it, and never as a CompileError.
 * - The wire's exact parse reads back what its encode writes (live/codec.ts parseInput, encodeInput): a drawn
 *   instance's facts, each nested to any depth under its count fields, encode to JSON the parse reads back as those
 *   facts, which encode to that JSON again.
 *
 * Oracle: the write compiler's acceptance of the ChangeSet, and the codec's own encode of each drawn instance.
 *
 * Features: a nested input with no top level (a tree's roots, whose own level stands at the tree's root), a nested
 * input with a top level, a tree's nodes nested under their root; rated: a write no served file holds, whose wire the
 * property does not reach.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { caseGen, type Feature, nestingHolds } from "#test/unit/live/nested-wire.fixtures.ts"

/** A nested insert's wire projects every nesting the write compiler accepts, and round-trips its facts. */
export const aNestedInsertsWireProjectsEveryNestingTheWriteCompilerAcceptsAndRoundTripsItsFacts =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a nested input with no top level",
			"a nested input with a top level",
			"a tree's nodes nested under their root"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, at: Case<Feature>) => (c) => nestingHolds(c, (feature) => at.note(feature)),
		oracle: {
			kind: "specification",
			name: "the write compiler's acceptance of the ChangeSet and the codec's own encode of each drawn instance"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/member.ts",
				original:
					"\t\t\t\t{ headings: [scalarHeading(nesting.own)], families: familiesOf(nesting.relation) },",
				replacement:
					"\t\t\t\t{ headings: [scalarHeading(nesting.top)], families: familiesOf(nesting.relation) },",
				why: "A nested input's own level is read by the heading at the top, so a tree's roots refuse."
			},
			{
				file: "packages/engine/src/live/member.ts",
				original:
					"\t\t\t\t\tfamily.owner === relation ? [{ count: family.count, level: at + 1 }] : []",
				replacement:
					'\t\t\t\t\tfamily.owner === relation\n\t\t\t\t\t\t? [{ count: family.count, level: nesting.root.kind === "tree" && family.member === relation ? 0 : at + 1 }]\n\t\t\t\t\t\t: []',
				why: "A tree's members are read at its roots' level."
			}
		]
	})
