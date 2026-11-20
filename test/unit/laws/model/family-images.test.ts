/**
 * A family's owner axis carries a text of no byte bound, a group field or a copy of an immutable owner's field its
 * insert fixes, by a copy of its image the member holds in a column grizzle writes, which the axis's ON UPDATE CASCADE
 * rewrites, held to the member's own image of the text by the family's CHECK; a copy of a mutable owner's such text is
 * refused.
 *
 * - The box, exhausted: Doc keyed by its text `path` and its entries, an ordered family's by their drawn index or a
 *   counted family's, grouped by their own `path`; the group text bounded by its pattern or of no bound; a copy of
 *   Doc's `title` on the owner axis, none, bounded or of no bound; Doc mutable, so a put rewrites its title and the
 *   cascade the title's copies, or immutable.
 * - The oracle, the specification (README "A key holds a text of no byte bound by its digest"): PostgreSQL generates a
 *   STORED column no cascade may write (42601), so a text of no bound rides the owner axis by Entry's drawn copy of its
 *   image (laws/model/plan.ts FamilyPlanner `#written`, analysis/theory/families.ts familyImages), never by Entry's
 *   own generated image, and the family's CHECK holds the copy equal to that image, so no write stores a copy that is
 *   not its text's digest; a bounded text rides as itself, with no copy. The cascade rewrites a copy with the image it
 *   holds where the owner's field is one no write rewrites, a key's text or an immutable owner's caller field; a
 *   mutable owner's title a put rewrites, and the cascade would rewrite its image's copy and leave its text, which a
 *   key holds by its image alone, so it is refused (UnsupportedLawFamily). Features: each order, bound, copy and owner
 *   mutability.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	checksEqual,
	type ImageCase,
	imageCases,
	imageCopies,
	type ImageFeature,
	imageSchema,
	ownerAxis,
	ownImage
} from "#test/unit/laws/model/family-images.fixtures.ts"
import { compiledModel } from "#test/unit/laws/model/natives.ts"

/** A family's owner axis carries a text of no byte bound no write rewrites by its member's written copy of its image, which the family's CHECK holds to the text's own image, and refuses a mutable owner's. */
export const aFamilysOwnerAxisCarriesATextOfNoByteBoundNoWriteRewritesByItsMembersWrittenCopyOfItsImageWhichTheFamilysCheckHoldsToTheTextsOwnImageAndRefusesAMutableOwners =
	property.exhaust(imageCases, {
		needs: {},
		situations: [
			"ordered",
			"counted",
			"group bounded",
			"group unbounded",
			"no copy",
			"copy bounded",
			"copy unbounded",
			"mutable",
			"immutable"
		] satisfies ReadonlyArray<Reached<ImageFeature>>,
		check: (_, c: Case<ImageFeature>) => (s: ImageCase) =>
			Effect.sync(() => {
				c.noteAll([
					s.order,
					`group ${s.group}`,
					s.copy === "no copy" ? "no copy" : `copy ${s.copy}`,
					s.owner
				])
				const compiled = compiledModel(imageSchema(s))
				if (s.copy === "unbounded" && s.owner === "mutable") {
					const reason = refused(compiled, "UnsupportedLawFamily").reason
					assert.ok(
						reason._tag === "UnsupportedLawFamily" &&
							Str.startsWith(
								"a family's owner axis that carries a text of no byte bound in its group, or as a copy of an immutable owner's field its insert fixes"
							)(reason.capability),
						"a mutable owner's copied title of no bound refused"
					)
					return
				}
				const model = succeeded(compiled, "a family whose axis carries every text it may")
				const copies = imageCopies(model)
				const columns = Arr.map(ownerAxis(model).columns, (col) =>
					col.kind === "field" ? col.field.name : col.column
				)
				const imaged = [
					...(s.group === "unbounded" ? ["path"] : []),
					...(s.copy === "unbounded" ? ["title"] : [])
				]
				assert.deepEqual(
					Arr.sort([...copies.keys()], Order.String),
					imaged,
					"each carried text of no bound copied once by its image"
				)
				for (const field of ["path", "title"]) {
					const copy = copies.get(field)
					if (copy === undefined) {
						assert.ok(
							(field === "title" && s.copy === "no copy") || columns.includes(field),
							`the owner axis carries the bounded ${field} itself`
						)
						continue
					}
					const own = ownImage(model, field)
					assert.ok(columns.includes(copy), `the owner axis carries ${field}'s written copy`)
					assert.ok(
						!columns.includes(own),
						"and never the generated image, which no cascade writes"
					)
					assert.ok(!columns.includes(field), "a key holds the text by its image alone")
					assert.ok(
						checksEqual(model, copy, own),
						"the family's CHECK holds the copy to the own image"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "README's digest key under PostgreSQL's ban on a cascade into a generated column (42601)"
		},
		box: "an ordered or counted family grouped by a text bounded or of no bound, with no copy, a bounded or an unbounded copy of its owner's title on the owner axis, its owner mutable or immutable",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original:
					"\t\t\treturn image === undefined || target === undefined ? [] : [[target.name, image] as const]",
				replacement: "\t\t\treturn []",
				why: "A family copies no text's image, so its owner axis carries the member's generated image under ON UPDATE CASCADE and is refused as a cascade into a generated column."
			},
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original:
					"\t\t...carried.filter((c) => !shape.owner.mutable && fixedAtInsert(c.owner.writing))",
				replacement: "\t\t...carried.filter((c) => fixedAtInsert(c.owner.writing))",
				why: "A mutable owner's copied title of no bound rides by a copy of its image, which a put's cascade would rewrite and leave the title: admitted where it is refused."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\tconst copy = this.#copies.get(c.column.of.field.name)\n\t\treturn copy === undefined ? c : lawColumn(copy)",
				replacement: "\t\treturn c",
				why: "The owner axis carries the member's generated image in its copy's place, which no cascade writes: the family is refused."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\tthis.#conditionsFor(this.#law.id, member).addImage(copied, generatedImage)",
				replacement: "\t\t\tvoid copied",
				why: "The family's CHECK states no equality of the copy and the image, so a write may store a copy that is not its text's digest."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\tif (onUpdate === "cascade" && generated?.kind === "law" && generated.column.kind === "image") {',
				replacement: "\t\tif (false) {",
				why: "A copied text of no bound is refused as a generated column the cascade writes, which names no bound: the refusal's sentence differs."
			}
		]
	})
