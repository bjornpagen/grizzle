/**
 * A ChangeSet's composition rebuilds only what its naming changes (write/changeset/value.ts combine, canonicalParts):
 * union and sequence name their two parts' private parameters as one scope's, each part renamed once, straight to the
 * names it ends with, so bindings of one origin and one key are one parameter whatever names the parts gave them, and a
 * part's member is rebuilt only where a name it reads changes; and a rename shares every part it leaves as it was
 * (ir/desc.ts renameQueryParams, ParamRenaming), its imports never walked. Where a combination renamed each part's
 * clashing names out of the other's way and then named the whole again, and every rename copied the member's whole
 * Description graph, imports included, decoded once more, metis's programs, unions and sequences of parts each bound to
 * its sittings, digested 16.8 million frozen parts as its modules loaded, every renamed copy held by an exported
 * ChangeSet, past V8's largest hash table, and its generate died.
 *
 * The box: parts each inserting the visits of their sittings, bound to one guard, through a chain of 1, 2 or 4
 * imports and under 1 or 4 conditions that read no sittings.
 *
 * Properties: every union of a tower of 2 to 8 parts, left-deep or balanced, binding one query under one name rebuilds
 * no member and binds the one name; a sequence of two parts, whose bindings are two inputs, united with a part binding
 * the query its first part binds, under whatever name the sequence gave it, binds the sequence's names and rebuilds
 * none of the sequence's members, either way round; and a sequence of two parts, one of which its naming renames,
 * builds as many containers whatever the depth of their chains and the number of their conditions: the renamed member's
 * containers on the way to its renamed use, never its imports or the parts its renaming leaves. Oracle: specification,
 * every member state and container the parts hold carried by reference. Kills: each part released out of the other's
 * names before the whole is named, as the combination was; a renaming that walks its imports; a renaming that rebuilds
 * every part.
 *
 * Features: a left-deep tower, a balanced one; the sequence first, the part first; a chain 1, 2 and 4 deep; 1 and 4
 * conditions.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	boundNames,
	builtContainers,
	membersOf,
	partOf,
	rebuiltMembers,
	type Tower,
	unionsOf
} from "#test/unit/write/changeset/composition.fixtures.ts"

const towers = ["left-deep", "balanced"] as const satisfies ReadonlyArray<Tower>

/** Every union of a tower of parts binding one query under one name rebuilds no member. */
export const aUnionOfPartsBindingOneQueryUnderOneNameRebuildsNoMember = property.exhaust(
	finite(
		(source) => [source.draw(element(towers)), source.draw(element([2, 3, 5, 8] as const))] as const
	),
	{
		needs: {},
		situations: ["a left-deep tower", "a balanced tower"],
		check:
			(_, c: Case<"a left-deep tower" | "a balanced tower">) =>
			([tower, n]) =>
				Effect.sync(() => {
					c.note(tower === "left-deep" ? "a left-deep tower" : "a balanced tower")
					const parts = Array.from({ length: n }, (_, i) => partOf(i, 1, 1))
					for (const [at, { union, of }] of unionsOf(tower, parts).entries()) {
						assert.equal(
							rebuiltMembers(union, of),
							0,
							`union ${at + 1} of ${n} parts rebuilds no member`
						)
						assert.deepEqual(boundNames(union), ["sittings"], `union ${at + 1} binds the one name`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "every member state of a union one of its parts', carried by reference"
		},
		box: "towers of 2, 3, 5 and 8 parts, left-deep and balanced, each part bound to one guard under one name",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original: "\tconst { parts, bound } = canonicalParts([a, b])\n",
				replacement:
					"\tconst { parts, bound } = canonicalParts([release(a, new Set([...usedParams(b), ...b.bound.keys()])), b])\n",
				why: "Each part released out of the other's names before the whole is named, as the combination was: a union of parts binding one query under one name renames one part's binding out of the way and names it back, rebuilding every member of that part each time."
			}
		]
	}
)

/**
 * A sequence's binding united with a part's binding of the same query before the same stratum is one parameter, under
 * whatever name the sequence gave it: the union binds the sequence's names, and the sequence's members are carried.
 */
export const aUnionMergesOneQueryBoundBeforeOneStratumUnderWhateverNameEachPartGaveIt =
	property.exhaust(
		finite((source) => source.draw(element([true, false] as const))),
		{
			needs: {},
			situations: ["the sequence first", "the part first"],
			check: (_, c: Case<"the sequence first" | "the part first">) => (sequenceFirst) =>
				Effect.sync(() => {
					c.note(sequenceFirst ? "the sequence first" : "the part first")
					const sequence = ChangeSet.sequence(partOf(0, 1, 1), partOf(1, 1, 1))
					const part = partOf(2, 1, 1)
					const union = sequenceFirst
						? ChangeSet.union(sequence, part)
						: ChangeSet.union(part, sequence)
					assert.deepEqual(
						Arr.sort(boundNames(union), Order.String),
						Arr.sort(boundNames(sequence), Order.String),
						"the union binds the sequence's names"
					)
					const held = new Set(membersOf(union))
					assert.ok(
						Arr.every(membersOf(sequence), (m) => held.has(m)),
						"the union carries every member of the sequence"
					)
				}),
			oracle: {
				kind: "specification",
				name: "one parameter for one origin and key, the sequence's members carried by reference"
			},
			box: "a sequence of two parts bound to one guard, united with a third part bound to it before the sequence's first stratum, either way round",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: "\tconst { parts, bound } = canonicalParts([a, b])\n",
					replacement:
						"\tconst { parts, bound } = canonicalParts([release(a, new Set([...usedParams(b), ...b.bound.keys()])), b])\n",
					why: "Each part released out of the other's names before the whole is named: the sequence's binding of the clashing name is renamed out of the part's way, its members rebuilt, before the naming merges the two bindings of one key."
				}
			]
		}
	)

/** The depths and conditions of the parts a sequence renames. */
const shapes = [
	[1, 1],
	[2, 1],
	[4, 1],
	[1, 4],
	[4, 4]
] as const

/**
 * A sequence of two parts both bound to the guard, two inputs, so its naming renames one part's binding: the
 * containers it builds are as many whatever the parts' chains and conditions, the renamed member's containers on the
 * way to its renamed use alone.
 */
export const aRenamedPartSharesEveryPartItsRenamingLeaves = property.exhaust(
	finite((source) => source.draw(element(shapes))),
	{
		needs: {},
		situations: [
			"a chain 1 deep",
			"a chain 2 deep",
			"a chain 4 deep",
			"1 condition",
			"4 conditions"
		],
		check:
			(
				_,
				c: Case<
					"a chain 1 deep" | "a chain 2 deep" | "a chain 4 deep" | "1 condition" | "4 conditions"
				>
			) =>
			([depth, conditions]) =>
				Effect.sync(() => {
					c.note(depth === 1 ? "a chain 1 deep" : depth === 2 ? "a chain 2 deep" : "a chain 4 deep")
					c.note(conditions === 1 ? "1 condition" : "4 conditions")
					const built = (d: number, w: number): number => {
						const a = partOf(0, d, w)
						const b = partOf(1, d, w)
						return builtContainers(ChangeSet.sequence(a, b), [a, b])
					}
					assert.equal(
						built(depth, conditions),
						built(1, 1),
						`a sequence of parts with chains ${depth} deep under ${conditions} conditions builds what the smallest does`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a rename builds only the containers on the way to its renamed uses"
		},
		box: "sequences of two parts bound to one guard, their chains 1, 2 and 4 deep, under 1 and 4 conditions",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\tsuper(spelling, unwalkedImports)\n",
				replacement: "\t\tsuper(spelling, new Map())\n",
				why: "A renaming that walks its imports: every import of the renamed member is copied, so a deeper chain builds more."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\treturn holdsSame(old, fresh) ? old : inKeyOrderOf(old, fresh)\n",
				replacement: "\t\treturn fresh\n",
				why: "A renaming that rebuilds every part of the renamed member's own namespace: more conditions build more."
			}
		]
	}
)
