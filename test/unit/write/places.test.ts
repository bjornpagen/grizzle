/**
 * A place (ir/instant.ts PlaceHead), as the schema declares it and as a ChangeSet writes it: the classifier
 * (analysis/theory/instants.ts placeOf) admits a place last in its relation's primary key after its group, unordered or
 * ordered by another field under a key within the group and that field, and refuses every other as PlaceRefused, naming
 * the key the group and the field would be; a place's order is read by a migration alone, so an unordered place
 * installs and writes exactly as its twin ordered by a field; a write (write/frontend/instants.ts stampsOf) stamps a
 * place an insert leaves out, and refuses a put or a delete of its relation, a place whose group the same insert
 * stamps, and a place stamped in two strata, and an insert stating one is refused as no member head holds a field
 * grizzle writes (check/member.ts).
 *
 * The boxes, exhausted: Session(child, item, n, stage, note) with n a place unordered or by `stage`, `when` or `n`, keyed
 * (child, item, n), (child, item, note), (n, child, item) or (child, n, item), beside the keys (child, item, stage),
 * (child, item), (child, note) and (item, stage, note) or none, its verdict README's rule (places.fixtures.ts
 * refusalOf); twins of a group of one or two fields keyed by the group and their order field or the group alone; and a
 * schema of Stage's clock, Session's place, its stage a reference to Stage's clock, and Mark's place within a group
 * holding Mark's own clock, each write case one ChangeSet built as a JavaScript caller builds it
 * (write/changeset/value.ts), so the shapes the types refuse are reached too.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	installedAndWritten,
	type OrderedPlaceFeature,
	orderedPlaceFeatures,
	orderedPlaceGen,
	orderedPlaceTwins,
	type PlaceSchemaFeature,
	placeSchemaGen,
	placeSchemaOf,
	type PlaceWriteFeature,
	Placed,
	placeWriteGen,
	refusalOf,
	schemaFeatureOf,
	writeFeatureOf
} from "#test/unit/write/places.fixtures.ts"

/** A place stands last in its primary key after its group, unordered or ordered by another field under a key within the group and it, and every other declaration is refused by its rule. */
export const aPlaceStandsLastInItsPrimaryKeyAfterItsGroupUnorderedOrOrderedByAnotherFieldUnderAKeyWithinTheGroupAndItAndEveryOtherDeclarationIsRefusedByItsRule =
	property.exhaust(finite(placeSchemaGen), {
		needs: {},
		situations: [
			"a place",
			"an unordered place",
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
				const refusal = refusalOf(c)
				if (refusal === undefined) {
					const artifacts = succeeded(built, "the case compiles")
					assert.deepEqual(
						Arr.map([...artifacts.laws.theory.instants.places.values()], (p) => ({
							relation: String(p.relation),
							field: p.field.name,
							group: Arr.map(p.child, (f) => f.name),
							order:
								p.order.kind === "unordered"
									? { kind: "unordered" }
									: { kind: "by", by: p.order.field.name }
						})),
						[{ relation: "Session", field: "n", group: ["child", "item"], order: c.order }],
						"the case's place, its group and its order"
					)
					return
				}
				const reason = refused(built, "PlaceRefused", "the case is refused").reason
				if (reason._tag === "PlaceRefused") {
					assert.deepEqual(
						{ relation: reason.relation, field: reason.field, rule: reason.rule },
						{ relation: "Session", field: "n", rule: refusal },
						"the case's refusal names its place and its rule"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rules of how a schema declares a place, README's Places (places.fixtures.ts refusalOf)"
		},
		box: "Session's place n, unordered or by stage, when or n, keyed (child, item, n), (child, item, note), (n, child, item) or (child, n, item), beside keys within or outside its group and stage or none",
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
				original: "\t\t\tconst keyed = [r.primaryFields, ...r.keyFields].some((k) =>\n",
				replacement: "\t\t\tconst keyed = true || [r.primaryFields, ...r.keyFields].some((k) =>\n",
				why: "A place's group and by need hold no key, so a migration would number a group's stored rows in no total order, and the case ordered by no key compiles where the rule refuses it."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\t\tif (by.name === field.name) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A place may be ordered by itself, the column the migration adds, so its case compiles where the rule refuses it."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: '\t\tcase "unordered":\n\t\t\treturn placed({ kind: "unordered" })\n',
				replacement: '\t\tcase "unordered":\n\t\t\treturn refused({ kind: "byUnknown", by: "" })\n',
				why: "A place that states no order is refused as one ordered by no field, so every unordered case that the rule admits is refused, and the property fails."
			}
		]
	})

/** A place that states no order compiles and stamps exactly as one ordered by a field: the same installation and the same write, its order read by a migration alone. */
export const aPlaceThatStatesNoOrderCompilesAndStampsExactlyAsOneOrderedByAField = property.exhaust(
	finite(orderedPlaceGen),
	{
		needs: {},
		situations: [
			"a place over a group of one field",
			"a place over a group of two fields",
			"keyed by its group and order",
			"keyed by its group"
		] satisfies ReadonlyArray<Reached<OrderedPlaceFeature>>,
		check: (_, k: Case<OrderedPlaceFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(orderedPlaceFeatures(c))
				const twins = orderedPlaceTwins(c)
				const by = installedAndWritten(twins.by)
				const unordered = installedAndWritten(twins.unordered)
				assert.deepEqual(
					unordered.installed,
					by.installed,
					"the unordered place installs as the ordered one: every drafted statement alike"
				)
				assert.deepEqual(
					unordered.written,
					by.written,
					"the unordered place's insert is the ordered one's: every statement and step alike"
				)
			}),
		oracle: {
			kind: "specification",
			name: "README's Places: a place's order is read by the migration that adds it to stored rows alone, so its twin ordered by a field installs and writes alike"
		},
		box: "a relation of a group of one or two fields, its place and an ordering field, keyed by the group and the field or by the group alone, unordered beside ordered",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/insert/stamp.ts",
				original:
					'\t\t\t\tcase "place":\n\t\t\t\t\treturn { kind: "coalesce", args: [next, lit.int(0, types.bigint)] }\n',
				replacement:
					'\t\t\t\tcase "place":\n\t\t\t\t\treturn counted.order.kind === "by" ? { kind: "coalesce", args: [next, lit.int(0, types.bigint)] } : next\n',
				why: "An unordered place's insert stamps one past its group's greatest place with no first place, so a group's first row would hold NULL: its insert differs from the ordered place's, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: '\t\tcase "unordered":\n\t\t\treturn placed({ kind: "unordered" })\n',
				replacement: '\t\tcase "unordered":\n\t\t\treturn undefined\n',
				why: "A place that states no order is no place, so its insert leaves its column out with nothing to stamp it: the unordered twin writes what the ordered one does not, and the property fails."
			}
		]
	}
)

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
