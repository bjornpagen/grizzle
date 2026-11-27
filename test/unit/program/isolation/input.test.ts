/**
 * The isolation facts of an installation are total (program/isolation/input.ts isolationInput): one RelationFacts for
 * every relation its owned schema states and one RoleFacts for every role it is given, each part the answer of the
 * function that owns it, and the keys and counted groups the law model holds.
 *
 * Over drawn schemas of families the reference admits (test/support/families/fill.ts: relations keyed by `id`, a tree's
 * by its root fields and start, ordered and counted families and trees between them, each relation mutable or not,
 * admitted by construction: admittedFillSpecGen, with no copy), compiled to their law model, and drawn roles of drawn
 * change members, each function of the sources a recorder:
 *
 * - Relations: exactly one fact for each relation the owned schema states, by its declared name, and triggerLawsOver
 *   asked once for each, its answer the fact's triggerLaws.
 * - Keys: each relation's are, as sets of columns, every key PostgreSQL enforces, by the specification's names
 *   (fill.ts keyOfRelation, groupFieldsOf), a law column, which the specification does not name, as one of the
 *   relation's law columns: its primary key, `id` or a tree's (`d<f>`, `d<f>p`, `start`); an ordered family's member
 *   slot, its group then `i<f>`, and its predecessor's, its group then a law column; a counted family's two, its group
 *   then its drawn index, and then that index's predecessor, both law columns; a tree's three, its root and its
 *   parent's start under its members' selection, a law column, then `i<f>`, the predecessor of `i<f>`, or `i<f>` and
 *   `end`; the successors the predecessor and last axes reference, the slot's columns then its successor, a law
 *   column, a tree's `end` after it, then a fold's accumulator, a law column, where it folds; and each owner's holding
 *   reference's target, its key with its first field where the count is above 0, a law column, a tree's own (that law
 *   column, `d<f>p`, `start`) among them. A check by a law column's key is so a check by a whole declared key.
 * - Counted groups: a second implementation over the specification's own names: each relation's are, for each family
 *   it is the member of whose owner is immutable (a tree's owner its own relation), the family's group fields, and none
 *   for any other.
 * - References: each relation's are, as a multiset, the foreign keys each family it is in holds, by the
 *   specification's names, each target's columns with its law columns: an ordered or counted family's member
 *   references its owner's holding target, and its own slot and successor, which its owner's last slot references too,
 *   its group, `i<f>` and its successor for an ordered family and its group, its drawn index and its successor for a
 *   counted one, then the fold's accumulator where it folds; a tree's relation references its own holding target and
 *   twice its own slot, successor and end past its guarded parent (`d<f>`, `d<f>p`, the parent's start, `i<f>`, the
 *   successor, `end`, then the fold's accumulator where it folds); every reference NO ACTION, since no family carries a
 *   copy.
 * - Roles: one fact for each role, in order, its privileges grantedPrivileges' answer for its own input, and its
 *   writes served by memberFacts' answers for its members in order, every variant of each, or unknown where it has no
 *   change member, so it writes by direct SQL alone, reading what readableRelations answers for its own input.
 *
 * Features: an immutable and a mutable owner's family, an immutable tree, a role with no change member, a member of
 * several variants, a relation some trigger law reads, a member's reference to its owner.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { caseGen, type Feature, run } from "#test/unit/program/isolation/input.fixtures.ts"

/** Isolation facts give one fact for every relation and every member, each its builder's answer, every key enforced, law columns among them, and the counted groups of immutable owners. Its budget is its suite's before it was a property (test/unit/program/isolation/input.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const isolationFactsGiveOneFactForEveryRelationAndEveryMemberEachItsBuildersAnswerEveryKeyEnforcedLawColumnsAmongThemAndTheCountedGroupsOfImmutableOwners =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"an immutable owner's family",
			"a mutable owner's family",
			"an immutable tree",
			"a role with no change member",
			"a member of several variants",
			"a relation some trigger law reads",
			"a member's reference to its owner"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: CaseOf<Feature>) => (c) => run(c, notes.note),
		oracle: {
			kind: "second-implementation",
			name: "the family specification's own counted groups and enforced keys, and each builder's own answers"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/input.ts",
				original:
					"\t\t\tfamily.owner.mutable ? [] : [[family.member.name, family.group.map((g) => g.member.name)]]",
				replacement: "\t\t\t[[family.member.name, family.group.map((g) => g.member.name)]]",
				why: "A counted group is given for a mutable owner's family too."
			},
			{
				file: "packages/engine/src/program/isolation/input.ts",
				original:
					'\t\t\treturn object.kind === "Unique" ? [[object.relation.name, object.columns.map(columnKey)]] : []',
				replacement:
					'\t\t\treturn object.kind === "Unique" && object.columns.every((c) => c.kind === "field")\n\t\t\t\t? [[object.relation.name, object.columns.map(columnKey)]]\n\t\t\t\t: []',
				why: "A UNIQUE over a law column left out of the keys, as before, so a check by a selected side's or a family slot's law columns binds no whole key (edullm's decideStage)."
			},
			{
				file: "packages/engine/src/program/isolation/input.ts",
				original:
					"\t\t\t\t\tcolumns: object.targetColumns.map(columnKey),\n\t\t\t\t\tonUpdate: object.onUpdate",
				replacement:
					'\t\t\t\t\tcolumns: object.targetColumns.flatMap((c) => (c.kind === "field" ? [c.field.name] : [])),\n\t\t\t\t\tonUpdate: object.onUpdate',
				why: "A foreign key's law columns left out of its referenced columns, so its check by a selected side's or a family slot's key binds no whole key."
			},
			{
				file: "packages/engine/src/program/isolation/input.ts",
				original:
					'\t\t\t\t? { kind: "unknown", readable: sources.readableRelations(model, role.checked) }',
				replacement: '\t\t\t\t? { kind: "unknown", readable: [...relations.keys()] }',
				why: "A role with no change member read as reading every relation regardless of its grants (a17decc0's bound), so a ChangeSet-less writer keeps every writing role SERIALIZABLE, met's and the write races' READ COMMITTED inserters among them."
			}
		]
	})
