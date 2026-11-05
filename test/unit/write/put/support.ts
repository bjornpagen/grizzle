import { identity } from "#compiler/core/identity.ts"
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
const Crew = relation("Crew", { id: uuid, hands: drawn(natural) }, ["id"])
export const Hand = relation("Hand", { id: uuid, crew: uuid, label }, ["id"])

export const Shop = schema(
	"Shop",
	{ Item, Stock, Seat, Code, Pair, Counter, Line, Worker, Task, Crew, Hand },
	[
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
	]
)

const shop = owning(Shop)
const shopNames: WriteNames = succeeded(
	compileInstallation(shop, {
		...installOptions(shop, "owner"),
		installation: identity.schema(parsedSchemaName("shop"))
	})
).names

/** The keys of the Shop's views, as its artifacts know them. */
const shopArtifacts = succeeded(testArtifacts(Shop, testCompile))

export const shopChangeSet = (): ChangeSetValue => ChangeSet.empty(Shop)

/** How a test compiles a put of the Shop: which contexts the Db holds a fact of, every one for reality. shopCompile
 * states that, and a test spreads it with what it changes. */
export type ShopCompile = Pick<CompileWriteOptions, "claims">
export const shopCompile: ShopCompile = { claims: { kind: "every" } }

const shopWrite = (value: unknown, options: ShopCompile) =>
	compileWrite(checking(Shop), descOf(value), {
		names: shopNames,
		reads: shopNames,
		claims: options.claims,
		world: { kind: "reality" },
		laws: shopArtifacts.laws,
		derived: shopArtifacts.derived
	})

export const shopCompiled = (value: unknown, options: ShopCompile): CompiledWrite =>
	succeeded(shopWrite(value, options))

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
