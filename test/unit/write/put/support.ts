import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import type * as Result from "#compiler/core/result.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	check,
	contained,
	counted,
	fin,
	key,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import {
	type CompiledWrite,
	type CompileWriteOptions,
	compileWrite
} from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** Shared fixtures for the put, read-back, scheduling and WriteProgram tests: a small schema whose
 * relations cover every put target (immutable and mutable relations, a serial key, a serial field outside the key, a
 * candidate key, a key over a field outside the primary key, a counted family with a check on its count, a pure set),
 * its installed names, and ChangeSet builders over it. */
const label = str.regex("^[a-z]{1,8}$")

/** Item is immutable, the pinned default; Stock is its mutable twin. */
export const Item = relation("Item", { id: uuid, label, qty: pg.bigint }, ["id"])
export const Stock = relation("Stock", { id: uuid, label, qty: pg.bigint }, ["id"])
/** A mutable relation keyed by a serial field: an explicit key value is written with OVERRIDING SYSTEM VALUE. */
export const Seat = relation("Seat", { no: pg.bigserial, label }, ["no"])
/** A mutable relation with a candidate key outside its primary key. */
export const Code = relation("Code", { id: uuid, code: label }, ["id"])
/** A mutable pure set. */
export const Pair = relation("Pair", { a: uuid, b: label }, ["a", "b"])
/** A mutable relation with a serial field outside its key. */
export const Counter = relation("Counter", { name: label, n: pg.bigint, seq: pg.serial }, ["name"])
/** An immutable relation referencing Stock: a put on Stock can replace a referenced row, so the reference is deferred
 * and its check is a deferred event of each Line fact. */
const Line = relation("Line", { id: uuid, stock: uuid }, ["id"])
/** A mutable relation keyed on a field outside its primary key: at most one Task per Worker, a key over Task's worker
 * (fin.md §6, at most one). */
const Worker = relation("Worker", { id: uuid }, ["id"])
const Task = relation("Task", { id: uuid, worker: uuid }, ["id"])
/** Every Crew has one or two Hands: Hand a counted family of Crew over its drawn count, and a check on the count
 * (fin.md §6, a count in [lo, hi]). */
export const Crew = relation("Crew", { id: uuid, hands: drawn(natural) }, ["id"])
export const Hand = relation("Hand", { id: uuid, crew: uuid, label }, ["id"])

const shopRelations = {
	Item,
	Stock,
	Seat,
	Code,
	Pair,
	Counter,
	Line,
	Worker,
	Task,
	Crew,
	Hand
} as const

const shopLaws = [
	mutable(Stock),
	mutable(Seat),
	mutable(Code),
	mutable(Pair),
	mutable(Counter),
	mutable(Task),
	mutable(Hand),
	key(on(Code, "code")),
	contained(on(Line, "stock"), on(Stock, "id")),
	contained(on(Task, "worker"), on(Worker, "id")),
	key(on(Task, "worker")),
	contained(on(Hand, "crew"), on(Crew, "id")),
	counted(on(Hand, "crew"), fin(Crew, "hands")),
	check("OneOrTwoHands", Crew, (r) => r.hands.between(1n, 2n))
] as const

const Shop = schema("Shop", shopRelations, shopLaws)

/**
 * The Shop with Crew mutable: a Hand's delete then shrinks a stored Crew's family, which the Shop's immutable Crew keeps
 * fixed from its insert.
 */
const MutableCrewShop = schema("Shop", shopRelations, [...shopLaws, mutable(Crew)])

export const shopChangeSet = (): ChangeSetValue => ChangeSet.empty(Shop)
export const mutableCrewChangeSet = (): ChangeSetValue => ChangeSet.empty(MutableCrewShop)

/** How a test compiles a put of the Shop: which contexts the Db holds a fact of, every one for reality. shopCompile
 * states that, and a test spreads it with what it changes. */
export type ShopCompile = Pick<CompileWriteOptions, "claims">
export const shopCompile: ShopCompile = { claims: { kind: "every" } }

/** A Shop's write compiler, and its write oracle's baseline of a write it compiled. */
interface ShopWriter {
	readonly write: (
		value: unknown,
		options: ShopCompile
	) => Result.Result<CompiledWrite, CompileError>
	readonly conservative: (program: CompiledWrite) => Result.Result<CompiledWrite, CompileError>
}

/**
 * The write compiler of a Shop: its names as installed under the schema `shop`, the keys of its views as its artifacts
 * know them, and the reality it writes.
 */
const shopWriter = (s: typeof Shop | typeof MutableCrewShop): ShopWriter => {
	const owned = owning(s)
	const names: WriteNames = succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			levels: [identity.schema(parsedSchemaName("shop"))]
		})
	).names
	const artifacts = succeeded(testArtifacts(s, testCompile))
	return {
		write: (value: unknown, options: ShopCompile) =>
			compileWrite(checking(s), descOf(value), {
				names,
				reads: names,
				claims: options.claims,
				world: { kind: "reality" },
				laws: artifacts.laws,
				derived: artifacts.derived
			}),
		/** The write oracle's baseline of a write of the Shop (write/program/compile.ts conservativeWrite). */
		conservative: (program: CompiledWrite) => conservativeWrite(program, { names, reads: names })
	}
}

/** A write of the Shop compiled, or the compiler's refusal of it. */
const shopWrite = shopWriter(Shop)
const mutableCrewWrite = shopWriter(MutableCrewShop)

export const shopCompiled = (value: unknown, options: ShopCompile): CompiledWrite =>
	succeeded(shopWrite.write(value, options))

export const mutableCrewCompiled = (value: unknown, options: ShopCompile): CompiledWrite =>
	succeeded(mutableCrewWrite.write(value, options))

/** A compiled write of the Shop, or of the mutable-crew Shop, with its conservative realization as its artifact. */
export const shopConservative = (program: CompiledWrite): CompiledWrite =>
	succeeded(shopWrite.conservative(program))

export const mutableCrewConservative = (program: CompiledWrite): CompiledWrite =>
	succeeded(mutableCrewWrite.conservative(program))

/** The facts of a relation parameter `name` of a relation's heading, put as they are: a described put that reads no
 * stored relation. */
export const stockFromParam = (relationValue: unknown, name: string): QueryValue =>
	query(Shop).rule((r: RuleValue) => {
		const { id, label: l, qty } = v(relationValue, "relationValue")
		return r
			.match(r.relation(name, relationValue), { id, label: l, qty })
			.find({ id, label: l, qty })
	})

/** Every Stock fact with label `from` moved to label `to`: a described put that reads only existing keys. */
export const relabel = (from: string, to: string): QueryValue =>
	query(Shop).rule((r: RuleValue) => {
		const { id, qty } = v(Stock, "stock")
		return r.match(Stock, { id, label: from, qty }).find({ id, label: to, qty })
	})
