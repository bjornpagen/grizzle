/**
 * A roster's Description crosses the compiler's boundary as data (program/schema.ts parseSchemaInput): a schema's
 * Description that no builder registered, as a worker or a JavaScript author hands it in, is decoded by its shape
 * (ir/desc.ts relationDescShape) into the Description the builders made. A roster's Description is an ordered
 * roster's, its name and handles, or an unordered one's, which states its order too (ir/desc.ts statedRosterOrders), and
 * both decode.
 *
 * The box, exhausted: each roster order, ordered and unordered, with one, two or three handles, alone in its schema or
 * beside a relation holding a closed id of it, each schema's Description as its builder recorded it, which the
 * boundary decodes as data, as it decodes a description no builder made. Property: it decodes, and the decoded Description is the builder's, field for field. Oracle: the builder's
 * own Description, which the decoder must give back whole.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"

/** A cell of the box: a roster's order, its handles, and whether a relation holds a closed id of it. */
interface RosterCell {
	readonly order: "ordered" | "unordered"
	readonly handles: readonly [string, ...Array<string>]
	readonly held: boolean
}

type RosterFeature = "an ordered roster" | "an unordered roster" | "a closed id of a roster"

const handleSets: readonly [
	readonly [string, ...Array<string>],
	...Array<readonly [string, ...Array<string>]>
] = [["a"], ["b", "a"], ["c", "a", "b"]]

/** The schema of a cell, built by the public builders. */
const schemaOf = (cell: RosterCell) => {
	const roster =
		cell.order === "ordered"
			? closed.ordered("Kind", cell.handles)
			: closed.unordered("Kind", cell.handles)
	return cell.held
		? schema(
				"RosterInput",
				[roster, relation("Thing", { id: int4, sort: closedId(roster) }, ["id"])],
				[]
			)
		: schema("RosterInput", [roster], [])
}

/** A roster's Description, ordered or unordered, decodes at the compiler's boundary into the one its builder made. */
export const aRostersDescriptionOfEitherOrderDecodesAtTheCompilersBoundaryIntoTheOneItsBuilderMade =
	property.exhaust(
		finite((source): RosterCell => ({
			order: source.draw(element(["ordered", "unordered"] as const)),
			handles: source.draw(element(handleSets)),
			held: source.draw(element([false, true] as const))
		})),
		{
			box: "each roster order, ordered and unordered, with one, two or three handles, alone in its schema or beside a relation holding a closed id of it",
			needs: {},
			situations: [
				"an ordered roster",
				"an unordered roster",
				"a closed id of a roster"
			] satisfies ReadonlyArray<Reached<RosterFeature>>,
			check: (_, c: Case<RosterFeature>) => (cell) =>
				Effect.sync(() => {
					c.note(cell.order === "ordered" ? "an ordered roster" : "an unordered roster")
					if (cell.held) {
						c.note("a closed id of a roster")
					}
					const built = defined(schemaDescOf(schemaOf(cell)), "a built schema's Description")
					const decoded = parseSchemaInput(built)
					if (!decoded.ok) {
						return assert.fail(
							`a ${cell.order} roster's Description does not decode: ${decoded.error.message}`
						)
					}
					assert.deepEqual(
						decoded.value.desc.relations,
						built.relations,
						`a ${cell.order} roster's Description decodes into its builder's`
					)
				}),
			oracle: {
				kind: "specification",
				name: "the builder's own Description, which the decoder gives back whole, an unordered roster's order among it"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/desc.ts",
					original: "\t\t\t{ ...loc, order: S.literalsShape(statedRosterOrders) }",
					replacement: "\t\t\tloc",
					why: "The decoder's roster shape states no order, as it did: an unordered roster's Description, which states its order, is refused as MalformedDescription at its `order`."
				}
			]
		}
	)
