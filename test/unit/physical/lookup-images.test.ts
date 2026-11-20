/**
 * A lookup's B-tree entry and a key's hold their texts by the one rule every B-tree entry grizzle installs follows
 * (schema/representability.ts entryImages), each by its own kind's image (core/identity.ts TextImage): over a relation R
 * whose fields are drawn over pg_type's sizes, a workload's request over them under a drawn use, and, where a case draws
 * one, a candidate key over the same fields:
 *
 * - the request's created index holds by its image, md5, exactly the texts it binds by equality wider than the image or
 *   of no byte bound, wherever its entry, every key as itself, could outgrow BTMaxItemSize, and every other key as
 *   itself: a text it reads in its order or matches a prefix of stays itself;
 * - an entry that still holds a text of no bound is refused as unbounded, and one still past the limit is refused naming
 *   the ordered and prefixed texts it holds as themselves (KeyFault `orderedText`), or for its bytes where it holds none;
 * - each image key is created as md5 of its column, the leakproof image a lookup's condition passes a role's query entry
 *   by, and each text the key holds by its image is held by SHA-256, the collision-resistant one a key's uniqueness rests
 *   on: every entry's image is its kind's;
 * - every field the created index holds by its image is one its relation's statements state the image's equality of
 *   (InstallNames `imaged`, schema/representability.ts relationImages).
 *
 * Oracle: PostgreSQL's B-tree item limit and pg_type's sizes and alignments, restated (representability.fixtures.ts),
 * each kind's image restated from why it is that image.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	fieldName,
	installLookup,
	keyAdmitted,
	type LookupFeature,
	lookupGen,
	lookupSchema,
	lookupVerdict
} from "#test/unit/physical/lookup-images.fixtures.ts"

/** The image each kind of entry holds a text by, restated from why: a key's must resist collisions, a lookup's must be leakproof. */
const kindImage = { key: "textDigest", lookup: "md5" } as const

/** A lookup's index and a key hold their texts by the one rule of every B-tree entry, each by its own kind's image, and every image a lookup's index holds is one its relation's statements state. Its budget is the runner's: a new property, with no suite before it to carry a count from. */
export const aLookupsEntryHoldsTheTextsItBindsByEqualityByItsMd5WhereItCouldOutgrowAnEntryItsOrderedTextsAsThemselvesAndAKeyByItsDigest =
	property.explore(lookupGen, {
		needs: {},
		situations: [
			"every key as itself",
			"an equality held by its image",
			"a text of no bound held by its image",
			"an ordered text held as itself beside an image",
			"refused naming an ordered text",
			"refused naming a prefixed text",
			"refused for its bytes",
			"refused as unbounded",
			"a key holding a text by its digest",
			"served by the key's index"
		] satisfies ReadonlyArray<Reached<LookupFeature>>,
		check: (_, c: Case<LookupFeature>) => (s) =>
			Effect.sync(() => {
				if (s.keyed && !keyAdmitted(s)) {
					refused(
						lookupSchema(s),
						"UnrepresentableKey",
						"a key past the limit for its other fields"
					)
					return
				}
				const verdict = lookupVerdict(s)
				const installed = installLookup(s)
				switch (verdict.kind) {
					case "unbounded": {
						const fault = refused(installed, "UnrepresentableKey").reason
						assert.ok(
							fault._tag === "UnrepresentableKey" && fault.fault.kind === "unboundedText",
							"an ordered text of no bound refused as unbounded"
						)
						c.note("refused as unbounded")
						return
					}
					case "ordered": {
						const fault = refused(installed, "UnrepresentableKey").reason
						assert.ok(fault._tag === "UnrepresentableKey" && fault.fault.kind === "orderedText")
						assert.deepEqual(
							Arr.map(fault.fault.columns, (col) => col.field),
							[...verdict.fields],
							"the refusal names the ordered and prefixed texts held as themselves"
						)
						c.noteAll(
							Arr.map(fault.fault.columns, (col) =>
								col.role === "order"
									? "refused naming an ordered text"
									: "refused naming a prefixed text"
							)
						)
						return
					}
					case "entry": {
						const fault = refused(installed, "UnrepresentableKey").reason
						assert.ok(
							fault._tag === "UnrepresentableKey" && fault.fault.kind === "btreeEntry",
							"refused for its bytes"
						)
						c.note("refused for its bytes")
						return
					}
					case "installed":
						break
				}
				const installation = succeeded(installed, "the case's installation")
				const created = Arr.filter(
					installation.indexes,
					(x) => x.relation === "R" && x.index.kind === "created"
				)
				const keyImages: ReadonlyArray<string> = Arr.flatMap(installation.laws.natives, (n) =>
					n.namespace === "column" && n.object.relation.name === "R" && n.plan.kind === "image"
						? [n.plan.image]
						: []
				)
				assert.ok(
					Arr.every(keyImages, (image) => image === kindImage.key),
					"a key holds each text by its kind's image, SHA-256's digest"
				)
				if (keyImages.length > 0) {
					c.note("a key holding a text by its digest")
				}
				const [index, ...others] = created
				if (index === undefined) {
					assert.ok(
						s.keyed && Arr.every(verdict.imaged, (imaged) => !imaged),
						"only the key's own index, holding every column as itself, serves the request"
					)
					c.note("served by the key's index")
					return
				}
				assert.equal(others.length, 0, "one index created for the one request")
				const imagedFields = Arr.flatMap(index.keys, (k) =>
					k.column.kind === "image" && k.column.of.kind === "field" ? [k.column.of.field] : []
				)
				assert.deepEqual(
					Arr.sort(imagedFields, Order.String),
					Arr.sort(
						Arr.flatMap(verdict.imaged, (imaged, i) => (imaged ? [fieldName(i)] : [])),
						Order.String
					),
					"the created index holds by its image exactly the equality texts the model images"
				)
				const imageKeys = Arr.flatMap(installation.statements, (st) =>
					st.kind === "createIndex" && st.name === index.index.name
						? Arr.filter(st.keys, (k) => k.key.kind === "expr")
						: []
				)
				assert.equal(imageKeys.length, imagedFields.length, "an expression key per image")
				assert.ok(
					Arr.every(
						imageKeys,
						(k) =>
							k.key.kind === "expr" &&
							k.key.expr.kind === "call" &&
							k.key.expr.fn.kind === "builtin" &&
							k.key.expr.fn.name === kindImage.lookup
					),
					"each image key is its kind's image, md5 of its column"
				)
				const table = installation.names.relation("R")
				assert.ok(
					Arr.every(imagedFields, (field) =>
						installation.names.imaged.has({ table, column: installation.names.column("R", field) })
					),
					"every field the index holds by its image is one R's statements state the image's equality of"
				)
				const unbounded = Arr.some(
					s.fields,
					(f, i) => f.kind === "wildcard" && verdict.imaged[i] === true
				)
				c.note(
					imagedFields.length === 0
						? "every key as itself"
						: unbounded
							? "a text of no bound held by its image"
							: "an equality held by its image"
				)
				if (
					imagedFields.length > 0 &&
					Arr.some(index.keys, (k) => k.column.kind !== "image") &&
					s.use !== "equality lookup"
				) {
					c.note("an ordered text held as itself beside an image")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "BTMaxItemSize and pg_type's sizes and alignments, restated, an equality's text held by md5's 32 digits where the entry could outgrow it, and each kind's image restated from why"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					'export const entryImage = Object.freeze({ key: "textDigest", lookup: "md5" } as const satisfies {',
				replacement:
					'export const entryImage = Object.freeze({ key: "md5", lookup: "textDigest" } as const satisfies {',
				why: "The two images swapped: a key holds its texts by md5, whose collisions are constructible, and a lookup by SHA-256, which no leakproof function reads from a text, so a role's query entry reads the lookup's every row."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: '\t\troles[at] === "equality" &&',
				replacement: "\t\ttrue &&",
				why: "A text a lookup reads in its order or matches a prefix of held by its image, which keeps no order: a page or a range read through the index reads its entries in md5's order."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\t\t\treturn [...every("equality").slice(1), request.use === "prefix search" ? "prefix" : "order"]',
				replacement: '\t\t\treturn every("equality")',
				why: "A range's last key read as an equality: its text held by its image, whose order is no range's."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original:
					'\treturn ordered.length === 0\n\t\t? entry\n\t\t: Result.err({\n\t\t\t\tkind: "orderedText",',
				replacement:
					'\treturn ordered.length >= 0\n\t\t? entry\n\t\t: Result.err({\n\t\t\t\tkind: "orderedText",',
				why: "An index past the limit for the ordered texts it holds as themselves refused for its bytes alone, never naming the texts whose byte bound is the law it breaks."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original:
					'\tconst images = entryImages(\n\t\t"lookup",\n\t\theld.map((h) => h.column)\n\t)',
				replacement: '\tconst images = held.map((h) => entryImages("lookup", [h.column])[0])',
				why: "A relation's images decided field by field, each alone in its entry: a text an index holds by its image only beside its other columns is one no statement states the image of, so PostgreSQL reads the index by its other columns alone."
			}
		]
	})
