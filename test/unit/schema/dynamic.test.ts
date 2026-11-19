/**
 * The dynamic door (public/dynamic.ts): each of its constructors, handed a name typed `string`, makes the value the
 * package root's constructor makes of that name written as a literal, one Description by semantic identity
 * (core/canonical.ts sameContent): the door changes the name's type, never what is declared. The box is every
 * constructor of the door. Oracle: a second implementation, the root's constructor of the same arguments.
 *
 * Features: each constructor of the door.
 */

import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { sameContent } from "#compiler/core/canonical.ts"
import { closed as dynamicClosed, relation as dynamicRelation } from "#compiler/public/dynamic.ts"
import { closedId, generated, pg } from "#compiler/public/fields.ts"
import { closed, relation } from "#compiler/public/schema.ts"
import { relationDescOf } from "#compiler/schema/relation.ts"
import { assert } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { doorConstructors } from "#test/unit/schema/dynamic.dictionary.ts"

type DoorConstructor = (typeof doorConstructors)[number]

/** The roster both closed relations are over, the root's. */
const Kind = closed.ordered("Kind", ["a", "b"])

/**
 * Each constructor's two values: the door's over `runtimeName`, typed `string` as a name read from data is, and the
 * root's over that name as a literal.
 */
const valuesOf = (callee: DoorConstructor, runtimeName: string): readonly [unknown, unknown] => {
	switch (callee) {
		case "relation":
			return [
				dynamicRelation(runtimeName, { id: Id, n: pg.integer }, ["id"]),
				relation("Drawn", { id: Id, n: pg.integer }, ["id"])
			]
		case "relation.generated":
			return [
				dynamicRelation.generated(runtimeName, { id: Id, n: pg.integer }, ["id"], (r) => ({
					m: generated(pg.integer, r.n)
				})),
				relation.generated("Drawn", { id: Id, n: pg.integer }, ["id"], (r) => ({
					m: generated(pg.integer, r.n)
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
					{ kind: closedId(Kind), w: pg.integer },
					["kind"],
					[{ kind: "a", w: 1 }]
				),
				closed.relation(
					"Drawn",
					{ kind: closedId(Kind), w: pg.integer },
					["kind"],
					[{ kind: "a", w: 1 }]
				)
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
			"closed.relation"
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
		box: "every constructor of the dynamic door: relation, relation.generated, closed.ordered, closed.unordered and closed.relation",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: '): AnyRoster => closedBuilder(name, handles, "unordered", extra)',
				replacement: '): AnyRoster => closedBuilder(name, handles, "ordered", extra)',
				why: "The door's closed.unordered declares an ordered roster, whose Description states no order where the root's states unordered."
			}
		]
	})
