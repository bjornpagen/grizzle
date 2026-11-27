/**
 * A place (ir/instant.ts PlaceHead), as the schema declares it and as a ChangeSet writes it: the classifier
 * (analysis/theory/instants.ts placeOf) admits a place last in its relation's primary key after its group, unordered or
 * ordered by another field under a key within the group and that field, and refuses every other as PlaceRefused, naming
 * the key the group and the field would be; a place's order is read by a migration alone, so an unordered place
 * installs and writes exactly as its twin ordered by a field; a write (write/frontend/instants.ts stampsOf) stamps a
 * place an insert leaves out, and refuses a put of its relation, a delete but one of whole groups, every field its rows
 * state a field of the place's group (write/frontend/instants.ts Removal), a family owner's among them, a place whose
 * group the same insert stamps, and a place stamped in two strata, and an insert stating one is refused as no member
 * head holds a field grizzle writes (check/member.ts).
 *
 * The boxes, exhausted: Session(child, item, n, stage, note) with n a place unordered or by `stage`, `when` or `n`, keyed
 * (child, item, n), (child, item, note), (n, child, item) or (child, n, item), beside the keys (child, item, stage),
 * (child, item), (child, note) and (item, stage, note) or none, its verdict README's rule (places.fixtures.ts
 * refusalOf); twins of a group of one or two fields keyed by the group and their order field or the group alone; and a
 * schema of Stage's clock, Session's place, its stage a reference to Stage's clock, and Mark's place within a group
 * holding Mark's own clock, and Turn's place, the owner of its moves' sequence, each write case one ChangeSet built as
 * a JavaScript caller builds it
 * (write/changeset/value.ts), so the shapes the types refuse are reached too.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
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
	type StampedNestingFeature,
	stampedNestingFeatures,
	stampedNestingGen,
	stampedNestingOf,
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
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original: '\t\t\tcase "place":\n\t\t\t\treturn lit.int(0, types.bigint)\n',
				replacement:
					'\t\t\tcase "place":\n\t\t\t\treturn head.order.kind === "by" ? lit.int(0, types.bigint) : lit.int(1, types.bigint)\n',
				why: "An unordered place's head starts its group at 1, not 0, so a group's first row would hold 1 and leave 0 a gap: its stamp function differs from the ordered place's, and the property fails."
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

/** A ChangeSet stamps a place its insert leaves out and writes its relation by insert, and by a delete of whole groups alone, each refusal naming its rule. */
export const aChangeSetStampsAPlaceItsInsertLeavesOutAndWritesItsRelationByInsertAndByDeletesOfWholeGroupsAloneEachRefusalNamingItsRule =
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
		box: "Session's place beside Stage's clock, Mark's place within a group its own clock stamps and Turn's place owning its moves, each case one ChangeSet inserting Session from host rows or a query leaving its place out or stating it, putting or deleting it, deleting whole groups of Session or of Turn by fields of their groups, deleting Turn's rows, inserting Mark, or inserting Session in two strata",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: '\t\tif (op !== "insert") {\n\t\t\treturn placeRefused(',
				replacement: "\t\tif (false) {\n\t\t\treturn placeRefused(",
				why: "A put or a delete may write a place's relation, which would state a place or leave a gap, so both compile where the rule refuses them."
			},
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: '\t\tif (op === "delete" && removes === "groups") {\n',
				replacement: "\t\tif (false) {\n",
				why: "Every delete of a place's relation is refused, whole groups and all, so the deletes of Session's whole groups are refused where the rule admits them."
			},
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: '\tif (place !== undefined && removes === "rows") {\n',
				replacement: "\tif (false) {\n",
				why: "A family owner's delete of rows of its place's groups goes unrefused, leaving a gap, so the delete of Turn's rows compiles where the rule refuses it."
			},
			{
				file: "packages/engine/src/check/member.ts",
				original: '\t\tcase "accumulated":\n\t\tcase "place":\n\t\t\treturn false\n',
				replacement:
					'\t\tcase "place":\n\t\t\treturn true\n\t\tcase "accumulated":\n\t\t\treturn false\n',
				why: "A member head may hold a place, so the insert stating its place is not refused as its heading's mismatch, and the property fails."
			}
		]
	})

/** A stamped nesting is one statement that writes its owner and every member, its head stamped by one CTE that every row it carries joins. */
export const aStampedNestingIsOneStatementWritingItsOwnerAndEveryMemberItsHeadStampedByOneCte =
	property.exhaust(finite(stampedNestingGen), {
		needs: {},
		situations: [
			"one sequence of members",
			"members two deep and two sequences"
		] satisfies ReadonlyArray<Reached<StampedNestingFeature>>,
		check: (_, k: Case<StampedNestingFeature>) => (c) =>
			Effect.gen(function* () {
				k.noteAll(stampedNestingFeatures(c))
				const nested = stampedNestingOf(c)
				const artifacts = succeeded(
					testArtifacts(nested.schema, testCompile),
					"the nesting's artifacts"
				)
				const [compiled, counts] = yield* callCounts(
					Effect.sync(() =>
						compileWrite(
							checking(nested.schema),
							descOf(nested.changeSet()),
							realityWrite(artifacts)
						)
					),
					{
						stamps: { file: "packages/engine/src/write/insert/stamp.ts", name: "headStampsCte" },
						programs: {
							file: "packages/engine/src/write/program/compile.ts",
							name: "familyProgram"
						}
					}
				)
				const written = succeeded(compiled, "the stamped nesting's insert compiles")
				assert.deepEqual(
					Arr.flatMap(written.artifact.steps, (step) => {
						switch (step.kind) {
							case "write":
							case "single":
								return [[step.kind]]
							case "familyWrite":
								return [
									Arr.dedupe(
										Arr.sort(
											Arr.flatMap(step.parts, (p) =>
												p.rows === "facts" ? [String(p.relation)] : []
											),
											Order.String
										)
									)
								]
							case "carrier":
							case "readBack":
							case "check":
								return []
						}
					}),
					[Arr.sort(nested.relations, Order.String)],
					"one family statement inserts the owner and every member, and no other statement writes"
				)
				assert.equal(
					counts.stamps,
					counts.programs,
					"each build of the write's family statements stamps the head by one CTE, each child probed once, which every row that carries it joins"
				)
			}),
		oracle: {
			kind: "specification",
			name: "README's Places: a nesting's stamp is computed once, by the one statement that writes every row carrying it"
		},
		box: "an owner keyed by its group and a place, its one sequence of members, or members two deep and a second sequence, each member carrying the owner's stamp in its group",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\t\tconst joined = sets.filter((x) => [...heads].some((h) => x.heads.has(h)))\n",
				replacement: "\t\t\t\tconst joined = sets.filter(() => false)\n",
				why: "The members' additions are statements of their own, after the owner's: each stamps the head again, reading the owner's row it now holds, so the head is probed twice at each child and a member's stamp is its owner's plus one; the program holds two writing statements and two stamps' CTEs."
			},
			{
				file: "packages/engine/src/write/family/nesting.ts",
				original:
					"\t\t\t...family.group.flatMap((g) => (g.owner.name === s.field.name ? [g.member] : [])),\n",
				replacement: "\t\t\t...family.group.flatMap(() => []),\n",
				why: "No member carries its owner's stamp, so the walk sends a member's stamped group field it never filled and the members are their own statement's, apart from the owner's stamp."
			}
		]
	})
