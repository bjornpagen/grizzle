/**
 * A rule's probe of a text its entry cannot hold as itself, of no byte bound or wider than the entry leaves it, reads its
 * rows as a point lookup: the index the engine creates for it holds each text it binds by equality by the text's image,
 * md5(text), in its place (schema/representability.ts entryImages), and the probe states the images' equality beside
 * the texts' (sql/image.ts). On PostgreSQL 19, over a few packages of a hundred documents and more, each holding one
 * identifier of 8, 433 or 2,700 bytes, analyzed, the ledger's containment of item sessions in an item's identifier, a
 * value of no byte bound, probes Attribute by (package, name, kind, value) and ItemSession by (package, item), its item
 * bounded at 2,700 bytes, the rows that share a lookup's other columns a package's identifiers; a session one byte off
 * a stored identifier is refused; and a reader's read through its query entry, a security barrier, by package and
 * identifier (rule-image.fixtures.ts).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { imageTemplate, runImaged, storedGen } from "#test/pg/laws/rule-image.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Each scan a rule's probe makes of a stored table reads, a loop, at most the rows its lookup's every equality matches
 * and those its image's hash collides with, however many rows share its bounded columns.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfATextOfNoByteBoundReadsItsRowsAsAPointLookup = property.explore(storedGen, {
	needs: { substrate: Substrate.rolledBack(imageTemplate) },
	situations: [
		"a value past a B-tree entry",
		"values of one length",
		"a read through a query entry",
		"a session one byte off its identifier refused"
	],
	check:
		({ substrate }, c) =>
		(stored) =>
			Effect.gen(function* () {
				const { connection, value } = yield* substrate
				yield* runImaged(value, connection, stored, c)
			}),
	oracle: {
		kind: "universal",
		name: "bound: each scan of a stored table a rule's probe makes reads at most, a loop, the rows one lookup's equalities match and its image's collisions, its output and its filters' removals together; and the containment's model refusing a session whose item no identifier of its package is"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/image.ts",
			original: "\t\t\t? [c, eq(imageOf(c.left), imageOf(c.right))]",
			replacement: "\t\t\t? [c]",
			why: "A probe states a text's equality alone, never its image's: the index holds the image, which no condition of the probe matches, so PostgreSQL reads the lookup through the index's bounded columns alone, (kind, name, package), filtering every identifier of the package a loop."
		},
		{
			file: "packages/engine/src/schema/representability.ts",
			original: "(fits ? undefined : imageIn(kind, c))",
			replacement: "(fits || c.datum !== undefined ? undefined : imageIn(kind, c))",
			why: "Only a text of no byte bound held by its image, as every index held before: the probe of a deleted attribute asks for an index over (package, item), its 2,700-byte item past its package, which no B-tree entry holds, refused as UnrepresentableKey where the template installs."
		},
		{
			file: "packages/engine/src/sql/image.ts",
			original: 'export const imageOf = (text: Expr): Expr => call("md5", [text])',
			replacement:
				'export const imageOf = (text: Expr): Expr => call("upper", [call("md5", [text])])',
			why: "The image is a text function PostgreSQL marks no leakproof, upper(md5(text)), as hashtextextended is: the judge's probes still read the index, but the reader's equality of images stays above its query entry's security barrier, so its read reaches Attribute through the index's bounded columns alone, every identifier of the package."
		}
	]
})
