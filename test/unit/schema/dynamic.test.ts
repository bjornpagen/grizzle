/**
 * The dynamic door (public/dynamic.ts): each of its constructors, derivedName's builders among them, handed a name typed `string`, makes the value the
 * package root's constructor makes of that name written as a literal, one Description by semantic identity
 * (core/canonical.ts sameContent): the door changes the name's type, never what is declared. The box is every
 * constructor of the door. Oracle: a second implementation, the root's constructor of the same arguments.
 *
 * Features: each constructor of the door.
 */

import { assert } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { sameContent } from "#compiler/core/canonical.ts"
import {
	closed as dynamicClosed,
	derivedName as dynamicDerivedName,
	relation as dynamicRelation
} from "#compiler/public/dynamic.ts"
import { closedId, generated, int4 } from "#compiler/public/fields.ts"
import { closed, derivedName, relation } from "#compiler/public/schema.ts"
import { relationDescOf } from "#compiler/schema/relation.ts"
import { Id } from "#test/support/ids.ts"
import { doorConstructors } from "#test/unit/schema/dynamic.dictionary.ts"

type DoorConstructor = (typeof doorConstructors)[number]

/** The roster both closed relations are over, the root's. */
const Kind = closed.ordered("Kind", ["a", "b"])

/** The naming both derivedNames state. */
const naming = Object.freeze({ stem: "Den", path: Object.freeze(["drawn"]) })

/**
 * Each constructor's two values: the door's over `runtimeName`, typed `string` as a name read from data is, and the
 * root's over that name as a literal.
 */
const valuesOf = (callee: DoorConstructor, runtimeName: string): readonly [unknown, unknown] => {
	switch (callee) {
		case "relation":
			return [
				dynamicRelation(runtimeName, { id: Id, n: int4 }, ["id"]),
				relation("Drawn", { id: Id, n: int4 }, ["id"])
			]
		case "relation.generated":
			return [
				dynamicRelation.generated(runtimeName, { id: Id, n: int4 }, ["id"], (r) => ({
					m: generated(int4, r.n)
				})),
				relation.generated("Drawn", { id: Id, n: int4 }, ["id"], (r) => ({
					m: generated(int4, r.n)
				}))
			]
		case "closed.ordered":
			return [dynamicClosed.ordered(runtimeName, ["a", "b"]), closed.ordered("Drawn", ["a", "b"])]
		case "closed.unordered":
			return [
				dynamicClosed.unordered(runtimeName, ["b", "a"]),
				closed.unordered("Drawn", ["b", "a"])
			]
		case "closed.relation":
			return [
				dynamicClosed.relation(
					runtimeName,
					{ kind: closedId(Kind), w: int4 },
					["kind"],
					[{ kind: "a", w: 1 }]
				),
				closed.relation("Drawn", { kind: closedId(Kind), w: int4 }, ["kind"], [{ kind: "a", w: 1 }])
			]
		case "derivedName.relation":
			return [
				dynamicDerivedName(naming).relation(runtimeName, { id: Id, n: int4 }, ["id"]),
				derivedName(naming).relation("Drawn", { id: Id, n: int4 }, ["id"])
			]
		case "derivedName.generated":
			return [
				dynamicDerivedName(naming).generated(runtimeName, { id: Id, n: int4 }, ["id"], (r) => ({
					m: generated(int4, r.n)
				})),
				derivedName(naming).generated("Drawn", { id: Id, n: int4 }, ["id"], (r) => ({
					m: generated(int4, r.n)
				}))
			]
		case "derivedName.unordered":
			return [
				dynamicDerivedName(naming).unordered(runtimeName, ["b", "a"]),
				derivedName(naming).unordered("Drawn", ["b", "a"])
			]
	}
}

/** Each of the door's constructors declares what the root's declares of the same name as a literal. */
export const eachOfTheDynamicDoorsConstructorsDeclaresWhatTheRootsDeclaresOfTheSameNameAsALiteral =
	property.exhaust(finite(word(doorConstructors)), {
		needs: {},
		situations: [
			"relation",
			"relation.generated",
			"closed.ordered",
			"closed.unordered",
			"closed.relation",
			"derivedName.relation",
			"derivedName.generated",
			"derivedName.unordered"
		] satisfies ReadonlyArray<Reached<DoorConstructor>>,
		check: (_, k: Case<DoorConstructor>) => (callee) =>
			Effect.sync(() => {
				k.note(callee)
				const [door, root] = valuesOf(callee, "Drawn")
				assert.ok(
					sameContent(relationDescOf(door, callee), relationDescOf(root, callee)),
					`the door's ${callee} declares what the root's does`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the package root's constructor of the same arguments, its name a literal"
		},
		box: "every constructor of the dynamic door: relation, relation.generated, closed.ordered, closed.unordered and closed.relation, and derivedName's relation, generated and unordered",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: '\t\tnamedClosedBuilder(name, naming, handles, "unordered", extra)',
				replacement: '\t\tnamedClosedBuilder(name, naming, handles, "ordered", extra)',
				why: "The door's closed.unordered declares an ordered roster, whose Description states no order where the root's states unordered."
			},
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: "\t\trelation: ordinaryRelationNamed(admitted),",
				replacement: "\t\trelation: ordinaryRelationNamed(declaredNaming),",
				why: "The door's derivedName drops its naming: its relation is declared where the root's is derived at the stem and path stated."
			}
		]
	})
