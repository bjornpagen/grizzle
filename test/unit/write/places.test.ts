/**
 * A place (ir/instant.ts Place), as the schema declares it and as a ChangeSet writes it: the classifier
 * (analysis/theory/instants.ts placeOf) admits a place last in its relation's primary key after its group, ordered by
 * `by`, another field, under a key within the group and `by`, and refuses every other as PlaceRefused, naming the key
 * the group and `by` would be; a write (write/frontend/instants.ts stampsOf) stamps a place an insert leaves out, and
 * refuses a put or a delete of its relation, a place whose group the same insert stamps, and a place stamped in two
 * strata, and an insert stating one is refused as no member head holds a field grizzle writes (check/member.ts).
 *
 * The boxes, exhausted: Session(child, item, n, stage, note) with n a place by `stage`, `when` or `n`, keyed (child,
 * item, n), (child, item, stage), (n, child, item) or (child, n, item), beside the keys (child, item, stage), (child,
 * item), (child, stage) and (item, stage, note) or none; and a schema of Stage's clock, Session's place, its stage a
 * reference to Stage's clock, and Mark's place within a group holding Mark's own clock, each write case one ChangeSet
 * built as a JavaScript caller builds it (write/changeset/value.ts), so the shapes the types refuse are reached too.
 *
 * Properties, per case, against the rule stated over the case (places.fixtures.ts, each case with its verdict): the
 * schema compiles with its place, or is refused at it by its rule; the ChangeSet compiles, or is refused as
 * PlaceRefused at the relation's place by its rule.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	type PlaceSchemaFeature,
	placeSchemaGen,
	placeSchemaOf,
	type PlaceWriteFeature,
	Placed,
	placeWriteGen,
	schemaFeatureOf,
	writeFeatureOf
} from "#test/unit/write/places.fixtures.ts"

/** A place stands last in its primary key after its group, ordered by another field under a key within the group and it, and every other declaration is refused by its rule. */
export const aPlaceStandsLastInItsPrimaryKeyAfterItsGroupOrderedByAnotherFieldUnderAKeyWithinTheGroupAndItAndEveryOtherDeclarationIsRefusedByItsRule =
	property.exhaust(finite(placeSchemaGen), {
		needs: {},
		situations: [
			"a place",
			"outsideKey",
			"groupless",
			"notLast",
			"byUnknown",
			"byItself",
			"byUnkeyed"
		] satisfies ReadonlyArray<Reached<PlaceSchemaFeature>>,
		check: (_, k: Case<PlaceSchemaFeature>) => (c) =>
			Effect.sync(() => {
				k.note(schemaFeatureOf(c))
				const built = testArtifacts(placeSchemaOf(c), testCompile)
				if (c.refusal === undefined) {
					const artifacts = succeeded(built, `${c.name} compiles`)
					assert.deepEqual(
						Arr.map([...artifacts.laws.theory.instants.places.values()], (p) => ({
							relation: String(p.relation),
							field: p.field.name,
							group: Arr.map(p.child, (f) => f.name),
							by: p.by.name
						})),
						[{ relation: "Session", field: "n", group: ["child", "item"], by: c.by }],
						`${c.name}'s place, its group and its by`
					)
					return
				}
				const reason = refused(built, "PlaceRefused", `${c.name} is refused`).reason
				if (reason._tag === "PlaceRefused") {
					assert.deepEqual(
						{ relation: reason.relation, field: reason.field, rule: reason.rule },
						{ relation: "Session", field: "n", rule: c.refusal },
						`${c.name}'s refusal names its place and its rule`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rules of how a schema declares a place, stated per case (places.fixtures.ts schemaCases)"
		},
		box: "Session's place n by stage, when or n, keyed (child, item, n), (child, item, stage), (n, child, item) or (child, n, item), beside keys within or outside its group and by",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\tif (at !== r.primaryFields.length - 1) {\n",
				replacement: "\tif (false) {\n",
				why: "A place may stand before another field of its key, so (child, n, item) compiles where the rule refuses it, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original:
					"\tconst keyed = [r.primaryFields, ...r.keyFields].some((k) => k.every((f) => within.has(f.name)))\n",
				replacement: "\tconst keyed = true\n",
				why: "A place's group and by need hold no key, so a migration would number a group's stored rows in no total order, and the case ordered by no key compiles where the rule refuses it."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\tif (by.name === field.name) {\n",
				replacement: "\tif (false) {\n",
				why: "A place may be ordered by itself, the column the migration adds, so its case compiles where the rule refuses it."
			}
		]
	})

/** A ChangeSet stamps a place its insert leaves out and writes its relation by insert alone, each refusal naming its rule. */
export const aChangeSetStampsAPlaceItsInsertLeavesOutAndWritesItsRelationByInsertAloneEachRefusalNamingItsRule =
	property.exhaust(finite(placeWriteGen), {
		needs: {},
		situations: [
			"compiled",
			"stated",
			"written",
			"groupStamped",
			"stampedApart"
		] satisfies ReadonlyArray<Reached<PlaceWriteFeature>>,
		check: (_, k: Case<PlaceWriteFeature>) => (c) =>
			Effect.sync(() => {
				k.note(writeFeatureOf(c.verdict))
				const compiled = compileWrite(
					checking(Placed),
					descOf(c.changeSet()),
					realityWrite(succeeded(testArtifacts(Placed, testCompile), "the schema's artifacts"))
				)
				if (c.verdict.kind === "compiled") {
					succeeded(compiled, `${c.name} compiles`)
					return
				}
				if (c.verdict.kind === "stated") {
					refused(compiled, "DescribedHeadingMismatch", `${c.name} is refused`)
					return
				}
				const reason = refused(compiled, "PlaceRefused", `${c.name} is refused`).reason
				if (reason._tag === "PlaceRefused") {
					assert.deepEqual(
						{ relation: reason.relation, field: reason.field, rule: reason.rule },
						{ relation: c.verdict.relation, field: "n", rule: c.verdict.rule },
						`${c.name}'s refusal names its place and its rule`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rules of how a write writes a place, stated per case (places.fixtures.ts writeCases)"
		},
		box: "Session's place beside Stage's clock and Mark's place within a group its own clock stamps, each case one ChangeSet inserting Session from host rows or a query leaving its place out or stating it, putting or deleting it, inserting Mark, or inserting Session in two strata",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: '\t\tif (op !== "insert") {\n\t\t\treturn placeRefused(',
				replacement: "\t\tif (false) {\n\t\t\treturn placeRefused(",
				why: "A put or a delete may write a place's relation, which would state a place or leave a gap, so both compile where the rule refuses them."
			},
			{
				file: "packages/engine/src/check/member.ts",
				original: '\t\tcase "retirement":\n\t\tcase "place":\n\t\t\treturn false\n',
				replacement:
					'\t\tcase "place":\n\t\t\treturn true\n\t\tcase "retirement":\n\t\t\treturn false\n',
				why: "A member head may hold a place, so the insert stating its place is not refused as its heading's mismatch, and the property fails."
			}
		]
	})
