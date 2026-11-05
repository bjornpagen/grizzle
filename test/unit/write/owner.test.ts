import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * An owner of counted families as rows-first writes it (rows-first.md §1, §3), through the whole program: an owner of
 * counted families alone is inserted on the plain path, its counts at 0 and its ends at their starts, since no
 * sequence of its nests; a relation that is both a counted family's member and a counted family's owner is inserted as
 * a member, its own family empty; and a put of an owner updates the fields its facts carry in place and inserts the
 * rest at their starts, its families left as they are, never a deletion and a re-insert.
 *
 * The oracle is the specification, read off each statement's text: which columns an UPDATE sets and which an INSERT
 * writes at its starts. A WITHOUT OVERLAPS owner and the commands machine of the whole write algebra are the §8
 * machine's (test/unit/write/commands.test.ts).
 */

const O = relation(
	"O",
	{ id: uuid, cap: pg.bigint, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const M = relation("M", { o: uuid, id: uuid, x: pg.bigint }, ["o", "id"])
const fam = counted(on(M, "o"), fin(O, "n"))
const S1 = schema("S1", { O, M }, [
	fam,
	fold(fam, Monoid.sum, on(M, "o", "x"), on(O, "id", "total")),
	mutable(O)
])

const A = relation("A", { id: uuid, bs: drawn(natural) }, ["id"])
const B = relation("B", { a: uuid, id: uuid, cs: drawn(natural) }, ["id"])
const C = relation("C", { b: uuid, id: uuid }, ["id"])
const Chain = schema("Chain", { A, B, C }, [
	counted(on(B, "a"), fin(A, "bs")),
	counted(on(C, "b"), fin(B, "cs")),
	mutable(A),
	mutable(B)
])

/** A compiled write over `schemaValue`, as the platform capture compiles it. */
const compiledFor = (schemaValue: unknown, name: string) => {
	const owned = owning(schemaValue)
	const names: WriteNames = succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			installation: identity.schema(parsedSchemaName(name))
		})
	).names
	const artifacts = succeeded(testArtifacts(schemaValue, testCompile))
	return (value: unknown): CompiledWrite =>
		succeeded(
			compileWrite(checking(schemaValue), descOf(value), {
				names,
				reads: names,
				claims: { kind: "facts", present: new Set<string>() },
				world: { kind: "reality" },
				laws: artifacts.laws,
				derived: artifacts.derived
			})
		)
}

const s1 = compiledFor(S1, "s1")
const chain = compiledFor(Chain, "chain")

/** Every statement text of a program's optimized artifact. */
const texts = (program: CompiledWrite): ReadonlyArray<string> =>
	Arr.map(program.artifacts.optimized.statements, (s) => s.spec.sql)

describe("an owner of counted families, rows first", () => {
	it.effect("puts an owner by updating the fields its facts carry, its families untouched", () =>
		Effect.gen(function* () {
			const value = ChangeSet.empty(S1).put(O, [{ id: uuidOf(1), cap: 2n }])
			const program = s1(value)
			const all = texts(program)
			const updates = Arr.filter(all, (t) => Str.includes('UPDATE "')(t))
			assert.equal(updates.length, 1, "the put updates the owner in place, once")
			for (const t of updates) {
				assert.ok(Str.includes('SET "cap" =')(t), "the update sets the field its facts carry")
				assert.ok(!Str.includes('"n" =')(t), "the update sets no count")
				assert.ok(!Str.includes('"total" =')(t), "the update sets no end")
			}
			const inserts = Arr.filter(all, (t) => Str.includes('INSERT INTO "')(t))
			assert.equal(inserts.length, 1, "the put inserts the facts no row holds")
			for (const t of inserts) {
				assert.ok(
					Str.includes('("id", "cap", "n", "total")')(t),
					"the insert writes the count and the end"
				)
				assert.ok(
					Str.includes("0::bigint, 0::bigint")(t),
					"a fresh owner's count is 0 and its end its start"
				)
			}
			assert.ok(
				Arr.every(all, (t) => !Str.includes("DELETE FROM")(t)),
				"the put deletes no owner"
			)
			const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
			const bound = succeeded(
				bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
			)
			assertVariant(bound, "kind", "bound", "the owner's facts bind")
		})
	)

	it.effect("inserts an owner of counted families alone on the plain path, at its starts", () =>
		Effect.gen(function* () {
			const value = ChangeSet.empty(S1)
				.insert(O, [{ id: uuidOf(1), cap: 2n }])
				.insert(M, [{ o: uuidOf(1), id: uuidOf(2), x: 5n }])
			const program = s1(value)
			const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
			const bound = succeeded(
				bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
			)
			assertVariant(bound, "kind", "bound", "an owner and its member bind")
			assertVariant(
				bound.flights,
				"kind",
				"write",
				"an append to an owner the changeset inserts reads nothing first"
			)
		})
	)

	it.effect(
		"inserts a counted member that owns a counted family as a member, its family empty",
		() =>
			Effect.gen(function* () {
				const value = ChangeSet.empty(Chain)
					.insert(A, [{ id: uuidOf(1) }])
					.insert(B, [{ a: uuidOf(1), id: uuidOf(2) }])
					.insert(C, [{ b: uuidOf(2), id: uuidOf(3) }])
				const program = chain(value)
				const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
				const bound = succeeded(
					bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
				)
				assertVariant(bound, "kind", "bound", "a chain of counted families binds")
			})
	)

	it.effect("puts every owner of a chain of counted families in place", () =>
		Effect.gen(function* () {
			const value = ChangeSet.empty(Chain)
				.put(A, [{ id: uuidOf(1) }])
				.put(B, [{ a: uuidOf(1), id: uuidOf(2) }])
			const program = chain(value)
			const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
			const bound = succeeded(
				bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
			)
			assertVariant(bound, "kind", "bound", "puts of a chain's owners bind")
		})
	)
})
