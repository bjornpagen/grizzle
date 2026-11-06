/**
 * The Family IR (ir/family.ts): a family is ordered exactly when its index is a field, and counted exactly when its
 * index is a drawn law column, whatever else the family holds.
 *
 * The oracle is the definition: `orderOf` reads the index's arm and nothing else. The box, exhausted: each index arm,
 * under each members kind and with and without a fold.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { identity, identifierOf, parseDeclaredName } from "#compiler/core/identity.ts"
import { type Family, orderOf } from "#compiler/ir/family.ts"
import type { LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"

const int8: ScalarType = { carrier: "int8", caps: capabilitiesOf("int8"), contract: undefined }

const fieldOf = (name: string, position: number): LawField => ({
	name,
	type: int8,
	desc: { kind: "pg", type: "bigint" },
	column: identifierOf(identity.column(succeeded(parseDeclaredName(name)))),
	position,
	writing: { kind: "drawn" }
})

/** The ordinary relations a family's owner and member are, as the checker resolves them. */
const checked = checking({
	name: "Families",
	relations: [
		relation("Owner", { id: f.uuid, count: f.drawn }, ["id"]),
		relation("Member", { id: f.uuid, owner: f.uuid, at: f.drawn }, ["id"])
	],
	statements: [],
	extends: undefined
} satisfies SchemaDesc)

const relationOf = (name: string): RelationInfo =>
	defined(checked.relations.get(name), `the checked relation ${name}`)

const at = fieldOf("at", 1)
const lawIndex = identifierOf(identity.lawColumn({ kind: "index", owner: "Owner", count: "count" }))
const copy = identifierOf(identity.lawColumn({ kind: "copy", owner: "Owner", count: "count" }))

/** One case: the index's arm, the members' kind, and whether the family folds. */
interface Shape {
	readonly index: "field" | "law"
	readonly members: "every" | "tree"
	readonly folds: boolean
}

const shapes: Gen<Shape> = (s) => ({
	index: s.draw(element(["field", "law"] as const)),
	members: s.draw(element(["every", "tree"] as const)),
	folds: s.draw(element([false, true] as const))
})

const familyOf = (shape: Shape): Family => {
	const owner = relationOf("Owner")
	const member = relationOf("Member")
	const index: NativeColumn =
		shape.index === "field" ? { kind: "field", field: at } : { kind: "law", column: lawIndex }
	return {
		id: { owner: "Owner", count: "count" },
		owner,
		count: fieldOf("count", 1),
		member,
		group: [{ member: fieldOf("owner", 0), owner: fieldOf("id", 0) }],
		index,
		copy,
		members:
			shape.members === "every"
				? { kind: "every" }
				: {
						kind: "tree",
						root: fieldOf("root", 2),
						start: fieldOf("start", 3),
						end: fieldOf("end", 4),
						parentStart: copy
					},
		axes: { owner: [], predecessor: [], last: [] },
		folds: shape.folds
			? [
					{
						monoid: "count",
						where: [],
						step: { kind: "one" },
						planes: [
							{
								before: { kind: "law", column: copy },
								after: { kind: "law", column: copy },
								end: fieldOf("count", 1),
								identity: { kind: "int", value: 0n }
							}
						]
					}
				]
			: []
	}
}

describe("the Family IR", () => {
	it.effect("orders a family by its index's arm alone", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/family-order",
					generator: shapes,
					literal: Formatter.format,
					limit: 8,
					coverage: requiredInSpace<"ordered" | "counted">(["ordered", "counted"]),
					caseHang,
					box: "each index arm, members kind and fold",
					oracle: { kind: "specification", name: "orderOf's definition" }
				},
				(shape: Shape, c: Case<"ordered" | "counted">) =>
					Effect.sync(() => {
						const order = orderOf(familyOf(shape))
						assert.equal(order, shape.index === "field" ? "ordered" : "counted")
						c.note(order)
					})
			)
		)
	)
})
