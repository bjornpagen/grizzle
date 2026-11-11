import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { drawn, generated, natural, pg, uuid } from "#compiler/public/fields.ts"
import { fin, key, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A put or a delete names each row by its relation's primary key, and a family's edit names each member by it, so a
 * primary key holding a field grizzle writes names no row a caller can state: a put or a delete of a sequence's member
 * whose primary key holds its drawn index is refused, by the write and the key (UnstatedKey), when the ChangeSet is
 * compiled, where its facts used to reach the host's same-key check and the family's edit without the index, an
 * internal invariant. A put's same-key check compares its facts at every declared key too, the primary key's first,
 * so a declared key holding the index is compared by no fact and refuses a put the same way; a declared key holding
 * `y`, which PostgreSQL generates from `x`, is one the fact determines, which the statement that writes it compares, so
 * it refuses nothing; a delete compares no key before it is sent, so a declared key never refuses one. The sequence's
 * own insert, nested under its owner, which draws the index, is the nested writes' (test/unit/write/nested).
 *
 * The box: a sequence's member, Member (id, owner, at drawn, x, and y generated from x), under each primary key of the
 * written shapes below (a primary key holds no generated field), beside every subset of the other shapes declared as
 * keys, the generated one among them, written by a put or a delete of one to three facts that state every field but the
 * index and `y`. The oracle is the rule itself: the primary key, then each declared key for a put, and the write is
 * refused naming the first that holds the index, the primary key where it does and otherwise one of the declared keys
 * that do, with the index as the field no fact states; with none, the ChangeSet compiles and binds.
 *
 * Features: each primary key and declared key that holds the index, each write, a generated key that refuses nothing.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): unstated-key-primary-only, a put's same-key checks reading its primary
 * key alone.
 */
const Owner = relation("Owner", { id: uuid, n: drawn(natural) }, ["id"])

/** The keys a case declares over Member's written fields, by name: each one's fields in the order it declares them. */
const shapes = {
	"owner and index": ["owner", "at"],
	"x and index": ["x", "at"],
	"id alone": ["id"],
	"owner and x": ["owner", "x"]
} as const
type Shape = keyof typeof shapes

/** A key a case declares: a written shape, or `owner` and the generated `y`. */
type Declared = Shape | "owner and generated y"

/** The fields of a declared key, in the order it declares them. */
const declaredFields = (shape: Declared): ReadonlyArray<string> =>
	shape === "owner and generated y" ? ["owner", "y"] : shapes[shape]

/** The member under the primary key `primary`, and the declared key over it of each shape. */
const memberOf = (primary: Shape) => {
	const Member = relation.generated(
		"Member",
		{ id: uuid, owner: uuid, at: drawn(natural), x: pg.bigint },
		shapes[primary],
		(r) => ({ y: generated(pg.bigint, r.x) })
	)
	const declared = (shape: Declared) => {
		switch (shape) {
			case "owner and index":
				return key(on(Member, "owner", "at"))
			case "x and index":
				return key(on(Member, "x", "at"))
			case "id alone":
				return key(on(Member, "id"))
			case "owner and x":
				return key(on(Member, "owner", "x"))
			case "owner and generated y":
				return key(on(Member, "owner", "y"))
		}
	}
	return { Member, declared }
}

/** A case of the box: the write, Member's primary key, the keys declared beside it in order, and how many facts. */
interface Box {
	readonly op: "put" | "delete"
	readonly primary: Shape
	readonly declared: ReadonlyArray<Declared>
	readonly facts: number
}

/** Every written shape, in the order the record states them. */
const shapeNames: Arr.NonEmptyReadonlyArray<Shape> = nonEmpty(Record.keys(shapes), "a key shape")

const boxGen: Gen<Box> = (source) => {
	const op = source.draw(element(["put", "delete"] as const))
	const primary = source.draw(element(shapeNames))
	const others: ReadonlyArray<Declared> = [
		...Arr.filter(shapeNames, (shape) => shape !== primary),
		"owner and generated y"
	]
	return {
		op,
		primary,
		declared: source.draw(subarray(others)),
		facts: source.draw(int(1, 3))
	}
}

/** The box's tapes: two writes, four primary keys, sixteen subsets of the other four, and three counts of facts. */
const boxCases = 2 * 4 * 16 * 3

/** Whether two keys hold the same fields in the same order. */
const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (field, i) => b[i] === field)

/** Whether a key holds the drawn index. */
const holdsIndex = (shape: Declared): boolean =>
	Arr.some(declaredFields(shape), (field) => field === "at")

/** The refusal the rule names, or none: the primary key first, then, for a put, the declared keys. */
type Expected =
	| Readonly<{ kind: "bound" }>
	| Readonly<{ kind: "primary" }>
	| Readonly<{ kind: "declared"; among: ReadonlyArray<Declared> }>

const expectedOf = (box: Box): Expected => {
	if (holdsIndex(box.primary)) {
		return { kind: "primary" }
	}
	const among = Arr.filter(box.declared, holdsIndex)
	return box.op === "put" && Arr.isReadonlyArrayNonEmpty(among)
		? { kind: "declared", among }
		: { kind: "bound" }
}

type Situation =
	| "put refused by its primary key"
	| "put refused by a declared key"
	| "put bound"
	| "put bound beside a declared key over a generated field"
	| "delete refused by its primary key"
	| "delete bound beside a declared key over the index"
	| "delete bound"

describe("a write that names rows by a primary key", () => {
	it.effect(
		"refuses a put or a delete whose primary key holds a field grizzle writes, and a put whose declared key does, naming the write, the key and the field, and binds every other",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/unstated-key",
						generator: boxGen,
						literal: Formatter.format,
						limit: boxCases,
						box: "a sequence's member under each of four primary keys, beside every subset of the other three and a key over a generated field declared, put or deleted as one to three facts",
						oracle: {
							kind: "specification",
							name: "the first key a write compares that holds the index refuses it, the primary key's first"
						},
						coverage: requiredInSpace<Situation>([
							"put refused by its primary key",
							"put refused by a declared key",
							"put bound",
							"put bound beside a declared key over a generated field",
							"delete refused by its primary key",
							"delete bound beside a declared key over the index",
							"delete bound"
						]),
						caseHang
					},
					(box, c) =>
						Effect.gen(function* () {
							const { Member, declared } = memberOf(box.primary)
							const Sequence = schema("Sequence", { Owner, Member }, [
								ordered(on(Member, "owner", "at"), fin(Owner, "n")),
								...Arr.map(box.declared, declared),
								mutable(Owner),
								mutable(Member)
							])
							const facts = Arr.map(Arr.range(1, box.facts), (n) => ({
								id: uuidOf(n + 1),
								owner: uuidOf(1),
								x: BigInt(n)
							}))
							const value =
								box.op === "put"
									? ChangeSet.empty(Sequence).put(Member, facts)
									: ChangeSet.empty(Sequence).delete(Member, facts)
							const compiled = compileWrite(
								checking(Sequence),
								descOf(value),
								realityWrite(succeeded(testArtifacts(Sequence, testCompile)))
							)
							const expected = expectedOf(box)
							if (expected.kind === "bound") {
								const program = succeeded(compiled, "a write that names its rows by stated fields")
								const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
								const bound = succeeded(
									bindWrite(runnableWrite(program, program.frontend.codes), {
										members,
										params: {},
										transport: inForce(bindFrame)
									})
								)
								assertVariant(bound, "kind", "bound", "a write whose keys hold no index binds")
								c.note(
									box.op === "put"
										? box.declared.includes("owner and generated y")
											? "put bound beside a declared key over a generated field"
											: "put bound"
										: Arr.some(box.declared, holdsIndex)
											? "delete bound beside a declared key over the index"
											: "delete bound"
								)
								return
							}
							const reason = refused(compiled, "UnstatedKey", "a key holds the index").reason
							if (reason._tag !== "UnstatedKey") {
								return assert.fail("an UnstatedKey")
							}
							assert.deepEqual(
								{ op: reason.op, relation: reason.relation, unstated: reason.unstated },
								{ op: box.op, relation: "Member", unstated: ["at"] },
								"the refusal names the write, the relation and the field no fact states"
							)
							const write = Arr.findFirst(
								Arr.getUnsafe(descOf(value).strata, 0).members,
								(m) => m.op === box.op && m.relation === "Member"
							)
							if (Option.isNone(write)) {
								return assert.fail("the ChangeSet writes Member")
							}
							assert.deepEqual(reason.at, write.value.loc, "the refusal is at the write")
							switch (expected.kind) {
								case "primary":
									assert.deepEqual(
										reason.key,
										{ kind: "primary", fields: shapes[box.primary] },
										"the primary key, read first"
									)
									c.note(
										box.op === "put"
											? "put refused by its primary key"
											: "delete refused by its primary key"
									)
									return
								case "declared":
									assert.ok(
										reason.key.kind === "declared" &&
											Arr.some(expected.among, (shape) =>
												sameFields(reason.key.fields, declaredFields(shape))
											),
										`a declared key over the index, not ${Formatter.format(reason.key)}`
									)
									c.note("put refused by a declared key")
									return
							}
						})
				)
			)
	)
})
