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
 * - Keys: each relation's are, as sets of fields, every key PostgreSQL enforces over its fields alone, by the
 *   specification's names (fill.ts keyOfRelation, groupFieldsOf): its primary key, `id` or a tree's (`d<f>`, `d<f>p`,
 *   `start`); an ordered family's member slot, its group then `i<f>`; each owner's owner-axis target, its key then
 *   `n<f>`, a tree's own (`d<f>`, `d<f>p`, `start`, `n<f>`) among them. A counted family's member slot and a tree's are
 *   over a law column, so no key of the relation.
 * - Counted groups: a second implementation over the specification's own names: each relation's are, for each family
 *   it is the member of whose owner is immutable (a tree's owner its own relation), the family's group fields, and none
 *   for any other.
 * - References: each relation's are, as a multiset, the foreign keys each family it is in holds, by the
 *   specification's names, each target's fields without its law columns: an ordered or counted family's member
 *   references its owner's target, its key then `n<f>`, ON UPDATE CASCADE, and its own slot, which its owner's last
 *   member references too, its group and `i<f>` for an ordered family and its group alone for a counted one, whose
 *   index is a law column; a tree's relation references its own target (`d<f>`, `d<f>p`, `start`, `n<f>`) and twice
 *   its own slot and end past its guarded parent (`d<f>`, `d<f>p`, `i<f>`, `end`); every reference but an owner axis
 *   NO ACTION.
 * - Roles: one fact for each role, in order, its privileges grantedPrivileges' answer for its own input, and its
 *   members memberFacts' answers for its members in order, every variant of each.
 *
 * Features: an immutable and a mutable owner's family, an immutable tree, a role with no change member, a member of
 * several variants, a relation some trigger law reads, a member's reference to its owner.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { caseGen, type Feature, run } from "#test/unit/program/isolation/input.fixtures.ts"

/** Isolation facts give one fact for every relation and every member, each its builder's answer, every key enforced over fields and the counted groups of immutable owners. Its budget is its suite's before it was a property (test/unit/program/isolation/input.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const isolationFactsGiveOneFactForEveryRelationAndEveryMemberEachItsBuildersAnswerEveryKeyEnforcedOverFieldsAndTheCountedGroupsOfImmutableOwners =
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
			}
		]
	})
