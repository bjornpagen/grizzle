import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
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
 * A put or a delete names each row by its relation's primary key, and a family's edit names each member by it, so a
 * primary key holding a field grizzle writes names no row a caller can state: a sequence's member keyed by its owner
 * and its drawn index is refused, by the write and the key (UnstatedKey), when the ChangeSet is compiled, where its
 * facts used to reach the host's same-key check and the family's edit without the index, an internal invariant. The
 * control: the same family over a member keyed by an id its caller writes, whose put and delete compile and bind; and
 * the sequence's own insert, nested under its owner, which draws the index.
 */

const Owner = relation("Owner", { id: uuid, n: drawn(natural) }, ["id"])
/** A sequence's member keyed by its owner and its drawn index. */
const Slot = relation("Slot", { owner: uuid, at: drawn(natural), x: pg.bigint }, ["owner", "at"])
const Indexed = schema("Indexed", { Owner, Slot }, [
	ordered(on(Slot, "owner", "at"), fin(Owner, "n")),
	mutable(Owner),
	mutable(Slot)
])
/** The same sequence over a member keyed by an id its caller writes. */
const Line = relation("Line", { id: uuid, owner: uuid, at: drawn(natural), x: pg.bigint }, ["id"])
const Identified = schema("Identified", { Owner, Line }, [
	ordered(on(Line, "owner", "at"), fin(Owner, "n")),
	mutable(Owner),
	mutable(Line)
])

const compileOver = (schemaValue: unknown, value: unknown) =>
	compileWrite(
		checking(schemaValue),
		descOf(value),
		realityWrite(succeeded(testArtifacts(schemaValue, testCompile)))
	)

/** The writes that name a row by its key. */
const ops = ["put", "delete"] as const
type Op = (typeof ops)[number]

/** A ChangeSet over `schemaValue` that writes `facts` of `target` as `op` says. */
const writing = (op: Op, schemaValue: unknown, target: unknown, facts: ReadonlyArray<unknown>) =>
	op === "put"
		? ChangeSet.empty(schemaValue).put(target, facts)
		: ChangeSet.empty(schemaValue).delete(target, facts)

type Situation =
	| `${Op} of a member keyed by its index: refused`
	| `${Op} of a member keyed by an id: bound`

describe("a write that names rows by a primary key", () => {
	it.effect(
		"refuses a put or a delete whose primary key holds a field grizzle writes, naming the write, the key and the field, and binds it over a key its caller writes",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/unstated-key",
						generator: element(ops),
						literal: Formatter.format,
						limit: ops.length,
						coverage: requiredInSpace<Situation>(
							Arr.flatMap(ops, (op): Arr.NonEmptyReadonlyArray<Situation> => [
								`${op} of a member keyed by its index: refused`,
								`${op} of a member keyed by an id: bound`
							])
						),
						caseHang
					},
					(op, c) =>
						Effect.gen(function* () {
							const unstated = writing(op, Indexed, Slot, [{ owner: uuidOf(1), x: 1n }])
							const reason = refused(
								compileOver(Indexed, unstated),
								"UnstatedKey",
								"no fact of Slot states its index, which its key holds"
							).reason
							if (reason._tag !== "UnstatedKey") {
								return assert.fail("an UnstatedKey")
							}
							assert.deepEqual(
								{
									op: reason.op,
									relation: reason.relation,
									key: reason.key,
									unstated: reason.unstated
								},
								{ op, relation: "Slot", key: ["owner", "at"], unstated: ["at"] },
								"the refusal names the write, the relation, its key and the field no fact states"
							)
							const write = Arr.findFirst(
								Arr.getUnsafe(descOf(unstated).strata, 0).members,
								(m) => m.op === op && m.relation === "Slot"
							)
							if (Option.isNone(write)) {
								return assert.fail("the ChangeSet writes Slot")
							}
							assert.deepEqual(reason.at, write.value.loc, "the refusal is at the write")
							c.note(`${op} of a member keyed by its index: refused`)

							const stated = writing(op, Identified, Line, [
								{ id: uuidOf(2), owner: uuidOf(1), x: 1n }
							])
							const program = succeeded(compileOver(Identified, stated))
							const members = yield* collectInputs(program.frontend, parsedOf(stated).inputs)
							const bound = succeeded(
								bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
							)
							assertVariant(
								bound,
								"kind",
								"bound",
								"a member named by an id its caller writes binds"
							)
							c.note(`${op} of a member keyed by an id: bound`)
						})
				)
			)
	)

	it.effect(
		"compiles and binds the sequence's insert nested under its owner, which draws the index",
		() =>
			Effect.gen(function* () {
				const nested = ChangeSet.empty(Indexed).insert(Owner, [
					{ id: uuidOf(1), n: [{ x: 1n }, { x: 2n }] }
				])
				const program = succeeded(compileOver(Indexed, nested))
				const members = yield* collectInputs(program.frontend, parsedOf(nested).inputs)
				const bound = succeeded(
					bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
				)
				assertVariant(bound, "kind", "bound", "the nested sequence binds")
			})
	)
})
