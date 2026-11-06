import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested addition's facts, as a JavaScript caller states them, hold the fields their caller writes at every depth, as
 * its type says (AdditionIn): a fact that states a field grizzle draws or accumulates, or one its relation lacks, is
 * refused before any SQL by its level's normalizer, an EncodingFailure of factShape. The split of an addition along its
 * families (write/changeset/value.ts encodeAddition) keeps every field a fact states but its count fields, where it
 * used to drop a drawn or accumulated field unsaid, its value lost. The box: an owner of an ordered family with a sum
 * fold, inserted with one member nested, the owner stating its accumulated end, the member its drawn index or a field
 * its relation lacks, or neither, the control, which binds.
 */
const Owner = relation(
	"Owner",
	{ id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Item = relation("Item", { owner: uuid, at: drawn(natural), x: pg.bigint }, ["owner", "at"])
const items = ordered(on(Item, "owner", "at"), fin(Owner, "n"))
const Sequenced = schema("Sequenced", { Owner, Item }, [
	items,
	fold(items, Monoid.sum, on(Item, "owner", "x"), on(Owner, "id", "total")),
	mutable(Owner),
	mutable(Item)
])

const shapes = [
	"the owner states its accumulated end",
	"the member states its drawn index",
	"the member states a field its relation lacks",
	"neither"
] as const
type Shape = (typeof shapes)[number]

/** The addition of one owner with one member nested, as `shape` states it. */
const additionOf = (shape: Shape) => {
	const member = { x: 1n }
	const owner = { id: uuidOf(1) }
	switch (shape) {
		case "the owner states its accumulated end":
			return { ...owner, total: 1n, n: [member] }
		case "the member states its drawn index":
			return { ...owner, n: [{ ...member, at: 0n }] }
		case "the member states a field its relation lacks":
			return { ...owner, n: [{ ...member, note: 1 }] }
		case "neither":
			return { ...owner, n: [member] }
	}
}

describe("a nested addition's facts", () => {
	it.effect(
		"bind only the fields their caller writes, refusing a drawn, accumulated or foreign field at any depth",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/nested-facts",
						generator: element(shapes),
						literal: Formatter.format,
						limit: shapes.length,
						coverage: requiredInSpace<Shape>(shapes),
						caseHang
					},
					(shape, c) =>
						Effect.gen(function* () {
							const value = ChangeSet.empty(Sequenced).insert(Owner, [additionOf(shape)])
							const program = succeeded(
								compileWrite(
									checking(Sequenced),
									descOf(value),
									realityWrite(succeeded(testArtifacts(Sequenced, testCompile)))
								)
							)
							const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
							const bound = bindWrite(program, {
								members,
								params: {},
								transport: inForce(bindFrame)
							})
							c.note(shape)
							if (shape === "neither") {
								assertVariant(succeeded(bound), "kind", "bound", "the caller's fields bind")
								return
							}
							const failure = refused(
								bound,
								"factShape",
								"a fact holds the fields its caller writes, refused before any SQL"
							)
							assert.equal(failure._tag, "EncodingFailure", "the caller's input is refused")
						})
				)
			)
	)
})
