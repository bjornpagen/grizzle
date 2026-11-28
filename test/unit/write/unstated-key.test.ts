/**
 * A put names each row by its relation's primary key, a delete names each row exactly, at every field a fact carries,
 * the primary key's among them, and a family's edit names each member by its primary key, so a primary key holding a
 * field grizzle writes names no row a caller can state: a put or a delete of a sequence's member
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
 * keys, the generated one among them, Owner and Member mutable inside the units their keys lead with, written by a put or
 * a delete of one to three facts that state every field but the index and `y`. The oracle is the rule itself: the primary key, then each declared key for a put, and the write is
 * refused naming the first that holds the index, the primary key where it does and otherwise one of the declared keys
 * that do, with the index as the field no fact states; with none, the ChangeSet compiles and binds.
 *
 * Features: each primary key and declared key that holds the index, each write, a generated key that refuses nothing.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { fin, mutable, on, ordered, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	boxGen,
	declaredFields,
	expectedOf,
	holdsIndex,
	memberOf,
	Owner,
	sameFields,
	shapes,
	type Situation
} from "#test/unit/write/unstated-key.fixtures.ts"

/** A write that names rows by a primary key refuses a put or a delete whose primary key holds a field grizzle writes, and a put whose declared key does, naming the write, the key and the field, and binds every other. */
export const aWriteThatNamesRowsByAPrimaryKeyRefusesAPutOrADeleteWhosePrimaryKeyHoldsAFieldGrizzleWritesAndAPutWhoseDeclaredKeyDoesNamingTheWriteTheKeyAndTheFieldAndBindsEveryOther =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: [
			"put refused by its primary key",
			"put refused by a declared key",
			"put bound",
			"put bound beside a declared key over a generated field",
			"delete refused by its primary key",
			"delete bound beside a declared key over the index",
			"delete bound"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (box) =>
			Effect.sync(() => {
				const { Member, declared, units } = memberOf(box.primary)
				const Sequence = schema(
					"Sequence",
					[Owner, Member],
					[
						ordered(on(Member, "owner", "at"), fin(Owner, "n")),
						...Arr.map(box.declared, declared),
						...units,
						mutable(Owner),
						mutable(Member)
					]
				)
				const facts = Arr.map(
					upTo(box.facts, (i) => i + 1),
					(n) => ({
						id: uuidOf(n + 1),
						owner: uuidOf(1),
						x: BigInt(n)
					})
				)
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
					const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
					const bound = succeeded(
						bindWrite(flightOf(servableWrite(program), program.frontend.codes, noAdvice), {
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
			}),
		oracle: {
			kind: "specification",
			name: "the first key a write compares that holds the index refuses it, the primary key's first"
		},
		box: "a sequence's member under each of four primary keys, beside every subset of the other three and a key over a generated field declared, put or deleted as one to three facts",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					'\t\t{ kind: "primary", law: primary },\n\t\t...(op === "put" ? declared.map((law) => ({ kind: "declared" as const, law })) : [])',
				replacement: '\t\t{ kind: "primary", law: primary }',
				why: "A put's same-key checks read its primary key alone (write/frontend/compile.ts refuseUnstatedKey), so a declared key holding the index refuses nothing."
			}
		]
	})
