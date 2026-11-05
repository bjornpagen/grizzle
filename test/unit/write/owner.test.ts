import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	counted,
	fin,
	fold,
	key,
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
import { assert, assertVariant, refused, succeeded } from "#test/support/assert.ts"
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

/** S1 with a candidate key beside its primary key, which every insert's probe judges. */
const Coded = relation(
	"Coded",
	{ id: uuid, code: pg.bigint, n: drawn(natural), t: accumulated(pg.bigint, 0n) },
	["id"]
)
const CodedM = relation("CodedM", { o: uuid, id: uuid, x: pg.bigint }, ["o", "id"])
const codedFam = counted(on(CodedM, "o"), fin(Coded, "n"))
const S2 = schema("S2", { Coded, CodedM }, [
	codedFam,
	fold(codedFam, Monoid.sum, on(CodedM, "o", "x"), on(Coded, "id", "t")),
	key(on(Coded, "code")),
	mutable(Coded)
])

/** An owner keyed WITHOUT OVERLAPS, with a counted family and a sum fold. */
const Inv = relation(
	"Inv",
	{
		org: uuid,
		period: span(pg.integer),
		cap: pg.bigint,
		n: drawn(natural),
		total: accumulated(pg.bigint, 0n)
	},
	["org", "period"]
)
const InvLine = relation(
	"InvLine",
	{ org: uuid, period: span(pg.integer), id: uuid, x: pg.bigint },
	["id"]
)
const invLines = counted(on(InvLine, "org", "period"), fin(Inv, "n"))
const S3 = schema("S3", { Inv, InvLine }, [
	invLines,
	fold(invLines, Monoid.sum, on(InvLine, "org", "period", "x"), on(Inv, "org", "period", "total")),
	mutable(Inv)
])

/** S1 with its owner immutable: its family is fixed when the owner is inserted. */
const Fixed = relation(
	"Fixed",
	{ id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const FixedM = relation("FixedM", { o: uuid, id: uuid, x: pg.bigint }, ["o", "id"])
const fixedFam = counted(on(FixedM, "o"), fin(Fixed, "n"))
const S4 = schema("S4", { Fixed, FixedM }, [
	fixedFam,
	fold(fixedFam, Monoid.sum, on(FixedM, "o", "x"), on(Fixed, "id", "total")),
	mutable(FixedM)
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

/** A write over `schemaValue` compiled as the platform capture compiles it, or its refusal. */
const compileFor = (schemaValue: unknown, name: string) => {
	const owned = owning(schemaValue)
	const names: WriteNames = succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			installation: identity.schema(parsedSchemaName(name))
		})
	).names
	const artifacts = succeeded(testArtifacts(schemaValue, testCompile))
	return (value: unknown) =>
		compileWrite(checking(schemaValue), descOf(value), {
			names,
			reads: names,
			claims: { kind: "facts", present: new Set<string>() },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived
		})
}

/** A compiled write over `schemaValue`, as the platform capture compiles it. */
const compiledFor = (schemaValue: unknown, name: string) => {
	const compile = compileFor(schemaValue, name)
	return (value: unknown): CompiledWrite => succeeded(compile(value))
}

const s1 = compiledFor(S1, "s1")
const s2 = compiledFor(S2, "s2")
const s3 = compiledFor(S3, "s3")
const chain = compiledFor(Chain, "chain")

/** Every statement text of a program's optimized artifact. */
const texts = (program: CompiledWrite): ReadonlyArray<string> =>
	Arr.map(program.artifacts.optimized.statements, (s) => s.spec.sql)

/** Binds an S2 write and checks that it binds. */
const bindsS2 = (value: unknown) =>
	Effect.gen(function* () {
		const program = s2(value)
		const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
		const bound = succeeded(
			bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
		)
		assertVariant(bound, "kind", "bound", "the owner's facts bind")
	})

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

	it.effect("inserts an owner with a candidate key, its probe naming carried fields only", () =>
		bindsS2(ChangeSet.empty(S2).insert(Coded, [{ id: uuidOf(1), code: 7n }]))
	)

	it.effect("puts an owner with a candidate key, its probe naming carried fields only", () =>
		bindsS2(ChangeSet.empty(S2).put(Coded, [{ id: uuidOf(1), code: 7n }]))
	)

	it("puts and deletes owners read from one relation parameter, matching on the fields facts carry", () => {
		const value = ChangeSet.empty(S1)
			.put(
				O,
				query(S1).rule((r) => {
					const caps = r.relation("caps", { id: uuid, cap: pg.bigint })
					const { id, cap } = v(O, "o")
					return r.match(caps, { id, cap }).find({ id, cap })
				})
			)
			.delete(
				O,
				query(S1).rule((r) => {
					const caps = r.relation("caps", { id: uuid, cap: pg.bigint })
					const { id, cap } = v(O, "o")
					return r.match(O, { id, cap }).where(r.not(caps, { id })).find({ id, cap })
				})
			)
		const program = s1(value)
		assert.ok(texts(program).length > 0, "the put and the delete compile")
	})

	it.effect("refuses a deleted owner fact that carries a drawn field, never reading it", () =>
		Effect.gen(function* () {
			const value = ChangeSet.empty(S1).delete(O, [{ id: uuidOf(1), cap: 2n, n: 0n, total: 0n }])
			const program = s1(value)
			const members = yield* collectInputs(program.frontend, parsedOf(value).inputs)
			refused(
				bindWrite(program, { members, params: {}, transport: inForce(bindFrame) }),
				"factShape",
				"a deletion's facts carry the written fields only"
			)
		})
	)

	it("puts an owner keyed WITHOUT OVERLAPS in place, never deleting and re-inserting it", () => {
		const value = ChangeSet.empty(S3).put(Inv, [
			{ org: uuidOf(1), period: { start: 0, end: 10 }, cap: 3n }
		])
		const all = texts(s3(value))
		assert.equal(
			Arr.filter(all, (t) => Str.includes('UPDATE "')(t)).length,
			1,
			"the put updates the owner in place"
		)
		assert.ok(
			Arr.every(all, (t) => !Str.includes("DELETE FROM")(t)),
			"the put deletes no owner, whose deletion would trip its members' owner axis"
		)
	})

	it.effect(
		"refuses an append to an immutable owner the stratum does not insert, statically and at bind, by one sentence",
		() =>
			Effect.gen(function* () {
				const statically = ChangeSet.empty(S4).insert(FixedM, [
					{ o: uuidOf(1), id: uuidOf(2), x: 1n }
				])
				const thrown = refused(
					compileFor(S4, "s4")(statically),
					"UnsupportedOperation",
					"an append to an owner no insert of the stratum names is refused at compile"
				).message
				const atBind = ChangeSet.empty(S4)
					.insert(Fixed, [{ id: uuidOf(3) }])
					.insert(FixedM, [{ o: uuidOf(1), id: uuidOf(2), x: 1n }])
				const program = compiledFor(S4, "s4")(atBind)
				const members = yield* collectInputs(program.frontend, parsedOf(atBind).inputs)
				const atRun = refused(
					bindWrite(program, { members, params: {}, transport: inForce(bindFrame) }),
					"UnsupportedOperation",
					"an append to an owner the stratum does not insert is refused before any SQL"
				)
				const rule =
					"an immutable owner's family is fixed when its owner is inserted; declare mutable(Fixed) to change it"
				const head =
					"an insert into FixedM, a member of the family Fixed.n of the immutable Fixed, appending to"
				assert.ok(Str.includes(rule)(thrown), "the static refusal states the rule")
				assert.ok(Str.includes(head)(thrown), "the static refusal names the write")
				assert.ok(Str.includes(rule)(atRun.message), "the run time's refusal states the same rule")
				assert.ok(Str.includes(head)(atRun.message), "the run time's refusal names the same write")
				assert.ok(
					Str.includes(
						`the owner Fixed with key (${uuidOf(1)}), which this stratum does not insert`
					)(atRun.message),
					"the run time's refusal names the owner it found"
				)
			})
	)
})
