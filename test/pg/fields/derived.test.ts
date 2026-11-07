import { layer } from "@effect/vitest"
import {
	accepted,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	runProgram,
	type Step,
	took,
	type Verdict
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, int, subset } from "@grizzle/testing/gen"
import { agree, type Disagreement, exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { type Swarm, swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result, type Scope, Struct } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { scalarReader } from "#compiler/codec/read.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, generated, pg } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnyRole,
	closed,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { type ClosedReadNode, evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { apply, kept, noFurther, openMigrator, reviewedSource } from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import {
	codeAt,
	type Declaration,
	historyGen,
	holesOf,
	liveHandleGen,
	liveOf,
	liveSubsetGen,
	type RosterHistory,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { type Version, workloadOf } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { type CatalogResult, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import type { SqlError } from "#test/support/pg.ts"
import { checking, owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Credentials, RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * Generated fields on PostgreSQL 19rc1: STORED generated columns, run as programs of a commands machine whose model
 * predicts every verdict (testing doctrine, rule 11).
 *
 * The relation R holds a caller's key, a closed id `tier` over the roster Tier and two sets over it, a and b, and up to
 * four generated fields, each one of its kind's expressions:
 * - k, a count: |a|, |b|, |a ∪ b| or |a ∩ b|;
 * - s, a set: a ∪ b, a ∩ b, a − b, b − a, or a ∪ L, a ∩ L or a − L, L a literal set operand, Bits.of(Tier, …) of the
 *   live handles at even declared positions (markedOf), which takes a's type, so its bits are the handles' codes; or
 *   {tier} or a ∪ {tier}, the singleton of the row's tier, Compute.singleton(tier), whose one bit is the tier's code;
 * - w, C.at over Weight, a closed relation keyed by a Tier with two integer payloads: Weight.at("w", tier) or
 *   Weight.at("v", tier);
 * - p, C.row over Pair, a closed relation keyed by two Tiers: Pair.row(tier), it ∪ a, or it ∩ {tier}, whether the
 *   tier pairs with itself.
 *
 * Tier is drawn by A8's generator (test/support/closed/generate.ts historyGen) and installed through its history, so
 * most cases meet a roster whose codes have holes, where a set's bit i is code i and not a handle's declared position;
 * rows, Weight's keys and Pair's pairs are drawn from its live handles by the same module. Weight holds every live
 * handle or some of them, so C.at meets keys it holds no tuple at, which read NULL and which the column's NOT NULL
 * refuses with 23502 (fin.md §17; OPEN-U5). The installation declares some generated fields from the start, so a short
 * program meets a closed read over rows. The commands:
 *
 * - **write:** the writer inserts a row of caller values and PostgreSQL computes every generated column, or refuses
 *   the row with 23502 naming w's column where w reads a key Weight does not hold;
 * - **supply:** a direct writer supplies a generated column, by an INSERT or an UPDATE, and PostgreSQL refuses it with
 *   428C9, changing nothing;
 * - **add, change, drop:** a generated field is added, given another expression, or dropped (a declared drop), each a
 *   migration drafted from the snapshot before it as `grizzle generate` drafts it and applied by the real runner. A
 *   changed expression migrates in place by SET EXPRESSION: the column keeps its attnum, which a drop and an add would
 *   not;
 * - **closed rows:** Weight's and Pair's rows change, and every generated column reading them holds the new rows'
 *   values: a STORED column is computed only when it is written, so the migration must re-express each one;
 * - a migration under which w would read a key Weight does not hold, adding w or changing the rows, is refused with
 *   23502 naming w's column. The runner applies a folder file by file, so the files before the refused one stay applied
 *   and the folder is unfinished; a data step deletes the rows that read the absent key, and the same folder applied
 *   again resumes and completes;
 * - **regenerate:** no change drafts nothing, so a generated field's expression is one snapshot text.
 *
 * After every step the installation is the model's: R's columns are its caller's fields and exactly the model's
 * generated fields, each STORED (attgenerated 's'), and every row's caller values are the model's. The oracles are two
 * second implementations of each generation expression: the host evaluator (scalar/compute/evaluate.ts) over the
 * checked schema's expression of the field, its closed reads answered from the model's rows of Weight and Pair, and a
 * naive model of the expression the model chose, over plain Sets. PostgreSQL's stored value of every generated column
 * of every row must agree with both, and with the reference evaluator (test/support/oracle/evaluate/catalog.ts) where
 * the expression reads no closed relation, and PostgreSQL is the judge of every refusal.
 *
 * Each case's commands are a swarm drawn per case (rule 7); the all-off draw is guarded by keeping `write`, which
 * applies in every state, always on. While no witness has added w over a row at a key Weight lacks, or written a row
 * under one of the singleton expressions at a tier whose code is no position, half the steered cases are aimed at one of
 * them (aimedRun). Bound: programs of three to eight steps, or an aimed write at each live handle, over a roster of two
 * to four handles after up to two migrations of its history.
 */

/** The roster the sets range over, the relation that holds them, and the closed relations its fields read. */
const tierName = parsedName("Tier")
const relationName = parsedName("R")
const weightName = parsedName("Weight")
const pairName = parsedName("Pair")

/** The caller's fields of R, in declaration order. */
const callerFields = ["id", "tier", "a", "b"] as const

/** The generated fields a model may hold, in name order. */
const generatedNames = ["k", "p", "s", "w"] as const

type GeneratedName = (typeof generatedNames)[number]

const countExprs = ["|a|", "|b|", "|a ∪ b|", "|a ∩ b|"] as const
const pairExprs = ["Pair.row(tier)", "Pair.row(tier) ∪ a", "Pair.row(tier) ∩ {tier}"] as const
const setExprs = [
	"a ∪ b",
	"a ∩ b",
	"a − b",
	"b − a",
	"a ∪ L",
	"a ∩ L",
	"a − L",
	"{tier}",
	"a ∪ {tier}"
] as const

/** The set expressions whose second operand is the literal set L. */
const literalExprs: ReadonlyArray<SetExpr> = ["a ∪ L", "a ∩ L", "a − L"]

/** The expressions that hold the singleton of the row's tier. */
const singletonExprs = ["{tier}", "a ∪ {tier}", "Pair.row(tier) ∩ {tier}"] as const
const weightExprs = ['Weight.at("w", tier)', 'Weight.at("v", tier)'] as const

type CountExpr = (typeof countExprs)[number]
type PairExpr = (typeof pairExprs)[number]
type SetExpr = (typeof setExprs)[number]
type WeightExpr = (typeof weightExprs)[number]
type SingletonExpr = (typeof singletonExprs)[number]
type Expr = CountExpr | PairExpr | SetExpr | WeightExpr

/** A generated field as a command names it, with an expression of its kind. */
type FieldChoice =
	| { readonly name: "k"; readonly expr: CountExpr }
	| { readonly name: "p"; readonly expr: PairExpr }
	| { readonly name: "s"; readonly expr: SetExpr }
	| { readonly name: "w"; readonly expr: WeightExpr }

/** The model's generated fields: each one's expression, or undefined where R holds none of that name. */
interface Generated {
	readonly k: CountExpr | undefined
	readonly p: PairExpr | undefined
	readonly s: SetExpr | undefined
	readonly w: WeightExpr | undefined
}

const noGenerated: Generated = { k: undefined, p: undefined, s: undefined, w: undefined }

/** A row as the caller writes it: its key, a live handle and two sets of live handles. */
interface Row {
	readonly id: number
	readonly tier: string
	readonly a: ReadonlyArray<string>
	readonly b: ReadonlyArray<string>
}

/** Weight's rows, a payload pair at some live handles, and Pair's, pairs of live handles. */
interface ClosedRows {
	readonly weight: ReadonlyArray<{ readonly tier: string; readonly w: number; readonly v: number }>
	readonly pair: ReadonlyArray<{ readonly from: string; readonly to: string }>
}

/** No row of either closed relation. */
const noClosedRows: ClosedRows = { weight: [], pair: [] }

/** The model: the roster, the closed relations' rows, R's rows in key order and its generated fields. */
interface Model {
	readonly tier: RosterState
	readonly closedRows: ClosedRows
	readonly rows: ReadonlyArray<Row>
	/** The key the next row written takes: one past every key a row was written at, so no key is written twice. */
	readonly nextId: number
	readonly generated: Generated
}

/** Each command's parameters. */
interface Params {
	readonly write: {
		readonly tier: string
		readonly a: ReadonlyArray<string>
		readonly b: ReadonlyArray<string>
	}
	readonly supply: { readonly name: GeneratedName; readonly statement: "insert" | "update" }
	readonly add: FieldChoice
	readonly change: FieldChoice
	readonly drop: { readonly name: GeneratedName }
	readonly "closed rows": ClosedRows
	readonly regenerate: Readonly<Record<string, never>>
}

/** What the model refuses: a writer's value for a generated column, and a written row whose w reads an absent key. */
type Refusal = "generated always" | "absent key"

type Feature =
	| "a roster with a hole"
	| "a row written"
	| "a row written under a literal set operand"
	| "a row written under {tier} at a tier whose code is no position"
	| "a row written under a ∪ {tier} at a tier whose code is no position"
	| "a row written under Pair.row(tier) ∩ {tier} at a tier that pairs with itself and whose code is no position"
	| "a write refused at an absent key"
	| "an insert supplying a generated column refused"
	| "an update of a generated column refused"
	| "a generated field added over rows"
	| "an addition refused at an absent key"
	| "a generated field re-expressed over rows"
	| "a generated field dropped"
	| "closed rows changed under a closed read"
	| "closed rows refused at an absent key"
	| "nothing drafted"

/**
 * What a row written under each singleton expression reaches, at a tier whose code is no position, where its value holds
 * the tier's bit: always, but for it ∩ {tier} only where the tier pairs with itself (holdsTier).
 */
const singletonFeatures: Readonly<Record<SingletonExpr, Feature>> = {
	"{tier}": "a row written under {tier} at a tier whose code is no position",
	"a ∪ {tier}": "a row written under a ∪ {tier} at a tier whose code is no position",
	"Pair.row(tier) ∩ {tier}":
		"a row written under Pair.row(tier) ∩ {tier} at a tier that pairs with itself and whose code is no position"
}

const commandNames = Struct.keys<Record<keyof Params, unknown>>({
	write: 0,
	supply: 0,
	add: 0,
	change: 0,
	drop: 0,
	"closed rows": 0,
	regenerate: 0
})

/** `xs`, which the command drawing from it keeps nonempty. */
const nonEmptyOf = <A>(xs: ReadonlyArray<A>, what: string): readonly [A, ...Array<A>] => {
	if (!Arr.isReadonlyArrayNonEmpty(xs)) {
		throw new Error(`the harness draws ${what} only where one exists`)
	}
	return xs
}

/** The generated fields R holds in a model, in name order. */
const presentNames = (g: Generated): ReadonlyArray<GeneratedName> =>
	Arr.filter(generatedNames, (name) => g[name] !== undefined)

const absentNames = (g: Generated): ReadonlyArray<GeneratedName> =>
	Arr.filter(generatedNames, (name) => g[name] === undefined)

/** The model's generated fields after `choice`, added or re-expressed. */
const withChoice = (g: Generated, choice: FieldChoice): Generated => {
	switch (choice.name) {
		case "k":
			return { ...g, k: choice.expr }
		case "p":
			return { ...g, p: choice.expr }
		case "s":
			return { ...g, s: choice.expr }
		case "w":
			return { ...g, w: choice.expr }
	}
}

const without = (g: Generated, name: GeneratedName): Generated => {
	switch (name) {
		case "k":
			return { ...g, k: undefined }
		case "p":
			return { ...g, p: undefined }
		case "s":
			return { ...g, s: undefined }
		case "w":
			return { ...g, w: undefined }
	}
}

/** An expression of `exprs` other than `other`. */
const otherThan = <E extends Expr>(exprs: ReadonlyArray<E>, other: E | undefined): Gen<E> =>
	element(
		nonEmptyOf(
			Arr.filter(exprs, (e) => e !== other),
			"another expression"
		)
	)

/** A choice for the field `name`, of an expression of its kind other than the one it holds, if it holds one. */
const choiceGen =
	(name: GeneratedName, g: Generated): Gen<FieldChoice> =>
	(source) => {
		switch (name) {
			case "k":
				return { name, expr: source.draw(otherThan(countExprs, g.k)) }
			case "p":
				return { name, expr: source.draw(otherThan(pairExprs, g.p)) }
			case "s":
				return { name, expr: source.draw(otherThan(setExprs, g.s)) }
			case "w":
				return { name, expr: source.draw(otherThan(weightExprs, g.w)) }
		}
	}

/**
 * Rows of Weight and Pair over the live handles of `state`: every handle weighed or some of them, so C.at meets both a
 * relation that holds every key a row can name and one that lacks some; and some pairs.
 */
const closedRowsGen =
	(state: RosterState): Gen<ClosedRows> =>
	(source) => {
		const live = liveOf(state)
		const weighed = source.draw(boolean)
			? live
			: source.draw(subset(live, { min: 0, max: live.length }))
		const pairs = Arr.flatMap(live, (from) => Arr.map(live, (to) => ({ from, to })))
		return {
			weight: Arr.map(weighed, (tier) => ({
				tier,
				w: source.draw(int(0, 3)),
				v: source.draw(int(-2, 2))
			})),
			pair: source.draw(subset(pairs, { min: 0, max: pairs.length }))
		}
	}

/** The rows of `m` whose tier w, where R holds it, reads at a key Weight holds no tuple at. */
const absentRows = (m: Model): ReadonlyArray<Row> =>
	m.generated.w === undefined
		? []
		: Arr.filter(m.rows, (row) => !Arr.some(m.closedRows.weight, (x) => x.tier === row.tier))

/**
 * A migration to `next`: accepted, its rows less those whose tier w would read at a key Weight does not hold, which
 * PostgreSQL refuses until a data step deletes them (migrateTo).
 */
const migrationVerdict = (next: Model): Verdict<Model, Refusal> => {
	const absent = new Set(Arr.map(absentRows(next), (row) => row.id))
	return accepted({ ...next, rows: Arr.filter(next.rows, (row) => !absent.has(row.id)) })
}

/** The machine over the model. */
const machine = (initial: Model): Machine<Model, Params, Refusal> => ({
	initial,
	commands: {
		write: {
			weight: 3,
			applies: () => true,
			parameters: (m) => (source) => ({
				tier: source.draw(liveHandleGen(m.tier)),
				a: source.draw(liveSubsetGen(m.tier)),
				b: source.draw(liveSubsetGen(m.tier))
			}),
			judge: (m, p) => {
				const row: Row = { id: m.nextId, ...p }
				return absentRows({ ...m, rows: [row] }).length > 0
					? refused("absent key")
					: accepted({ ...m, rows: [...m.rows, row], nextId: m.nextId + 1 })
			}
		},
		supply: {
			weight: 2,
			applies: (m) => presentNames(m.generated).length > 0,
			parameters: (m) => (source) => ({
				name: source.draw(element(nonEmptyOf(presentNames(m.generated), "a generated field"))),
				statement:
					m.rows.length > 0 ? source.draw(element(["insert", "update"] as const)) : "insert"
			}),
			judge: () => refused("generated always")
		},
		add: {
			weight: 3,
			applies: (m) => absentNames(m.generated).length > 0,
			parameters: (m) => (source) =>
				source.draw(
					choiceGen(
						source.draw(element(nonEmptyOf(absentNames(m.generated), "an absent field"))),
						m.generated
					)
				),
			judge: (m, p) => migrationVerdict({ ...m, generated: withChoice(m.generated, p) })
		},
		change: {
			weight: 2,
			applies: (m) => presentNames(m.generated).length > 0,
			parameters: (m) => (source) =>
				source.draw(
					choiceGen(
						source.draw(element(nonEmptyOf(presentNames(m.generated), "a generated field"))),
						m.generated
					)
				),
			judge: (m, p) => migrationVerdict({ ...m, generated: withChoice(m.generated, p) })
		},
		drop: {
			weight: 1,
			applies: (m) => presentNames(m.generated).length > 0,
			parameters: (m) => (source) => ({
				name: source.draw(element(nonEmptyOf(presentNames(m.generated), "a generated field")))
			}),
			judge: (m, p) => accepted({ ...m, generated: without(m.generated, p.name) })
		},
		"closed rows": {
			weight: 2,
			applies: () => true,
			parameters: (m) => closedRowsGen(m.tier),
			judge: (m, p) => migrationVerdict({ ...m, closedRows: p })
		},
		regenerate: {
			weight: 1,
			applies: () => true,
			parameters: () => constant({}),
			judge: (m) => accepted(m)
		}
	}
})

/** A model's built version: its schema value and login, and the writer role. */
interface Built {
	readonly version: Version
	readonly writer: AnyRole
}

/**
 * The model as a schema under `name`, the roster declared as `declaration`: Tier, Weight and Pair, and R with its
 * caller's fields and the model's generated fields, each the expression the model chose; `writer` writes R whole, the
 * one role of the login `desk`.
 */
const builtOf = (name: string, m: Model, declaration: Declaration): Built => {
	const Tier = closed(tierName, declaration)
	const Weight = closed.relation(
		weightName,
		{ tier: closedId(Tier), w: pg.integer, v: pg.integer },
		["tier"],
		m.closedRows.weight
	)
	const Pair = closed.relation(
		pairName,
		{ from: closedId(Tier), to: closedId(Tier) },
		["from", "to"],
		m.closedRows.pair
	)
	const g = m.generated
	const R = relation.generated(
		relationName,
		{ id: pg.integer, tier: closedId(Tier), a: bits(Tier), b: bits(Tier) },
		["id"],
		(r) => {
			const countOf = (expr: CountExpr) => {
				switch (expr) {
					case "|a|":
						return Compute.cardinality(r.a)
					case "|b|":
						return Compute.cardinality(r.b)
					case "|a ∪ b|":
						return Compute.cardinality(Compute.union(r.a, r.b))
					case "|a ∩ b|":
						return Compute.cardinality(Compute.intersection(r.a, r.b))
				}
			}
			const setOf = (expr: SetExpr) => {
				switch (expr) {
					case "a ∪ b":
						return Compute.union(r.a, r.b)
					case "a ∩ b":
						return Compute.intersection(r.a, r.b)
					case "a − b":
						return Compute.difference(r.a, r.b)
					case "b − a":
						return Compute.difference(r.b, r.a)
					case "a ∪ L":
						return Compute.union(r.a, Bits.of(Tier, markedOf(m.tier)))
					case "a ∩ L":
						return Compute.intersection(r.a, Bits.of(Tier, markedOf(m.tier)))
					case "a − L":
						return Compute.difference(r.a, Bits.of(Tier, markedOf(m.tier)))
					case "{tier}":
						return Compute.singleton(r.tier)
					case "a ∪ {tier}":
						return Compute.union(r.a, Compute.singleton(r.tier))
				}
			}
			const pairOf = (expr: PairExpr) => {
				switch (expr) {
					case "Pair.row(tier)":
						return Pair.row(r.tier)
					case "Pair.row(tier) ∪ a":
						return Compute.union(Pair.row(r.tier), r.a)
					case "Pair.row(tier) ∩ {tier}":
						return Compute.intersection(Pair.row(r.tier), Compute.singleton(r.tier))
				}
			}
			const weightOf = (expr: WeightExpr) => {
				switch (expr) {
					case 'Weight.at("w", tier)':
						return Weight.at("w", r.tier)
					case 'Weight.at("v", tier)':
						return Weight.at("v", r.tier)
				}
			}
			return {
				...(g.k === undefined ? {} : { k: generated(pg.bigint, countOf(g.k)) }),
				...(g.p === undefined ? {} : { p: generated(bits(Tier), pairOf(g.p)) }),
				...(g.s === undefined ? {} : { s: generated(bits(Tier), setOf(g.s)) }),
				...(g.w === undefined ? {} : { w: generated(pg.integer, weightOf(g.w)) })
			}
		}
	)
	const stored: Record<string, AnyRelation> = { R }
	const declared: Record<string, AnyRelation | AnyClosed> = { Tier, Weight, Pair, ...stored }
	const base = schema(name, declared, [])
	const writer = role(base, "writer", stored, { write: ["R"], refresh: [] })
	return { version: { schema: base, logins: [login(base, "desk", [writer])] }, writer }
}

/**
 * The generated fields a case's installation declares from the start: each present or not, with an expression of its
 * kind, so a short program meets a closed read over rows without first adding the field that makes it. w is present a
 * quarter of the time, so most programs that add it add it over rows already written, some at keys Weight lacks.
 */
const generatedGen: Gen<Generated> = (source) => ({
	k: source.draw(boolean) ? source.draw(element(countExprs)) : undefined,
	p: source.draw(boolean) ? source.draw(element(pairExprs)) : undefined,
	s: source.draw(boolean) ? source.draw(element(setExprs)) : undefined,
	w: source.draw(boolean) && source.draw(boolean) ? source.draw(element(weightExprs)) : undefined
})

/** The model a case starts from: the roster its history reached, the drawn closed rows and generated fields, no row. */
const initialOf = (
	history: RosterHistory,
	closedRows: ClosedRows,
	generated: Generated
): Model => ({
	tier: history.state,
	closedRows,
	rows: [],
	nextId: 0,
	generated
})

/** A case: the roster's history, the closed relations' first rows, the first generated fields, and the program. */
interface Run {
	readonly history: RosterHistory
	readonly closedRows: ClosedRows
	readonly generated: Generated
	readonly program: Program<Params>
}

/**
 * A case as drawn: the roster's history, the closed rows over its live handles and the first generated fields, a swarm
 * over the commands with `write`, which applies in every state, kept on (the all-off draw's guard), and a program of
 * three to eight steps.
 */
const runGen: Gen<Run> = (source) => {
	const history = source.draw(
		historyGen(tierName, { handles: { min: 2, max: 4 }, migrations: { min: 0, max: 2 } })
	)
	const closedRows = source.draw(closedRowsGen(history.state))
	const generated = source.draw(generatedGen)
	const drawnSwarm = source.draw(swarm(nonEmptyOf(commandNames, "a command")))
	const guarded: Swarm<keyof Params> = { ...drawnSwarm, write: drawnSwarm.write ?? 1 }
	return {
		history,
		closedRows,
		generated,
		program: source.draw(
			program(machine(initialOf(history, closedRows, generated)), { min: 3, max: 8 }, guarded)
		)
	}
}

/**
 * A run aimed at an addition over a key Weight lacks: Weight holds every live handle but one, w is no first generated
 * field, and the program only writes rows and adds fields, so a row at the lacking handle may come before w is added.
 */
const lackingSwarm: Swarm<keyof Params> = { write: 1, add: 1 }

const lackingRunGen: Gen<Run> = (source) => {
	const history = source.draw(
		historyGen(tierName, { handles: { min: 2, max: 4 }, migrations: { min: 0, max: 2 } })
	)
	const drawnRows = source.draw(closedRowsGen(history.state))
	const lacking = source.draw(element(liveOf(history.state)))
	const closedRows: ClosedRows = {
		weight: Arr.map(
			Arr.filter(liveOf(history.state), (tier) => tier !== lacking),
			(tier) => ({ tier, w: source.draw(int(0, 3)), v: source.draw(int(-2, 2)) })
		),
		pair: drawnRows.pair
	}
	const generated: Generated = { ...source.draw(generatedGen), w: undefined }
	return {
		history,
		closedRows,
		generated,
		program: source.draw(
			program(machine(initialOf(history, closedRows, generated)), { min: 3, max: 8 }, lackingSwarm)
		)
	}
}

/** The singleton expression `expr` as the generated field that holds it. */
const singletonChoice = (expr: SingletonExpr): FieldChoice => {
	switch (expr) {
		case "{tier}":
		case "a ∪ {tier}":
			return { name: "s", expr }
		case "Pair.row(tier) ∩ {tier}":
			return { name: "p", expr }
	}
}

/**
 * A run aimed at a row written under the singleton expression `expr` at a tier whose code is no position: the roster
 * migrates once at least, R declares `expr` from the start and w not, Pair pairs every live handle with itself, and the
 * program writes a row at each live handle, so a row is written at every handle a hole before it shifted.
 */
const singletonRunGen =
	(expr: SingletonExpr): Gen<Run> =>
	(source) => {
		const history = source.draw(
			historyGen(tierName, { handles: { min: 2, max: 4 }, migrations: { min: 1, max: 2 } })
		)
		const live = liveOf(history.state)
		const drawnRows = source.draw(closedRowsGen(history.state))
		const closedRows: ClosedRows = {
			weight: drawnRows.weight,
			pair: [
				...Arr.filter(drawnRows.pair, (x) => x.from !== x.to),
				...Arr.map(live, (tier) => ({ from: tier, to: tier }))
			]
		}
		const generated = withChoice(
			{ ...source.draw(generatedGen), w: undefined },
			singletonChoice(expr)
		)
		return {
			history,
			closedRows,
			generated,
			program: Arr.map(live, (tier): Step<Params> => ({
				command: "write",
				parameters: {
					tier,
					a: source.draw(liveSubsetGen(history.state)),
					b: source.draw(liveSubsetGen(history.state))
				}
			}))
		}
	}

/** What a steered case may be aimed at: an addition refused at an absent key, or a singleton expression's feature. */
type Aim = "absent key" | SingletonExpr

/** The feature each aim's run is aimed at. */
const aimFeatures: Readonly<Record<Aim, Feature>> = {
	"absent key": "an addition refused at an absent key",
	...singletonFeatures
}

/**
 * The run a witness makes: its drawn one, or, while some aim's feature no witness has reached (Case.steering), half the
 * time a run aimed at one of them.
 */
const aimedRun = (run: Run, c: Case<Feature>): Run => {
	const aims = Arr.filter(Struct.keys(aimFeatures), (aim) =>
		Option.exists(c.steering, (unreached) => unreached.has(aimFeatures[aim]))
	)
	if (!Arr.isReadonlyArrayNonEmpty(aims) || !c.draw(boolean)) {
		return run
	}
	const aim = c.draw(element(aims))
	return c.draw(aim === "absent key" ? lackingRunGen : singletonRunGen(aim))
}

/**
 * The installation a case migrates: the declared name its schema is built under, the owner's session that reads it,
 * and the credentials of its owner login, which every migration runs as.
 */
interface Installed {
	readonly declared: string
	readonly owner: RawSession
	readonly ownerLogin: Credentials
}

/**
 * The real system a program runs against: every folder applied so far, the snapshot the last one reached, and the
 * physical names of the version it installed, which name the columns of the fields that version declares.
 */
interface System {
	readonly m: Installed
	readonly writer: RawSession
	previous: Previous
	names: PhysicalNames
	folders: Array<FolderSource>
	drafts: number
}

/** The snapshot the system's last folder reached: the installation's, once its first version is installed. */
const snapshotOf = (sys: System): DeploySnapshot => {
	if (sys.previous.kind !== "snapshot") {
		return assert.fail("the system holds an installed version")
	}
	return sys.previous.snapshot
}

/**
 * A version's complete installation under the declared name `declared`, its logins' worlds among it, compiled as
 * `grizzle generate` compiles it (physical/complete.ts completeInstallOptions) with the codes drafted for it. It is
 * compiled directly, not through the oracle's planRealInstall, whose structural audit refuses the closed constants'
 * pack until RS narrows it (orchestrator, 2026-11-05).
 */
const installationOf = (
	version: Version,
	declared: string,
	codes: Codebook,
	owner: string
): Installation => {
	const owned = owning(version.schema)
	const logins = Arr.map(version.logins, (l) =>
		succeeded(ownLogin(defined(loginDescOf(l), `login ${l.name}, built by login(...)`)))
	)
	return succeeded(
		compileInstallation(owned, {
			...completeInstallOptions(
				owned,
				identity.schema(parsedSchemaName(declared)),
				logins,
				workloadOf(version).extensions,
				codes
			),
			owner
		}),
		`the installation of ${declared}`
	)
}

/** What a real step fails with: a statement of the harness, a migration the model says applies, or an oracle's split. */
type StepError = SqlError | MigrateError | TransactionRolledBack | Disagreement

/** The drops a roster's declaration declares after the one before it: each handle it no longer holds live. */
const removedHandles = (before: Declaration, after: Declaration): Declarations => ({
	renames: [],
	drops: Arr.map(
		Arr.filter(before, (h) => !after.includes(h)),
		(handle): Named => ({ kind: "handle", roster: tierName, handle })
	)
})

/** The next draft from the system's snapshot to `built`, declaring `declared`, its codes drafted as the CLI drafts them. */
const draftNext = (sys: System, built: Built, declared: Declarations) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const previous = sys.previous
		const codes = succeeded(
			draftCodes(built.version.schema, previous, declared),
			"a version keeps the roster's codes"
		)
		const workload = workloadOf(built.version)
		const installation = installationOf(built.version, sys.m.declared, codes, substrate.owner.role)
		sys.drafts += 1
		const drafted = generate({
			previous,
			installation,
			name: `step_${sys.drafts}`,
			timestamp: draftedAt(sys.drafts),
			workload: workload.draft,
			declared
		})
		if (!drafted.ok) {
			return assert.fail(`the next migration drafts: ${drafted.error.message}`)
		}
		const g: GenerateResult = drafted.value
		return { g, names: installation.names }
	})

/** Applies the system's folders and then `next`, as the installation's owner login. */
const applyWith = (sys: System, next: ReadonlyArray<FolderSource>, snapshot: DeploySnapshot) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, sys.m.ownerLogin)
		return yield* apply(migrator, { snapshot, folders: [...sys.folders, ...next] }, noFurther)
	})

/**
 * A migration to `proposed`, the model a command proposes, declaring `declared`, drafted and applied, after which the
 * system holds `after`. Where w would read a key Weight does not hold for some rows, PostgreSQL refuses it first with
 * 23502 naming w's column; grizzle's runner applies a folder file by file, so the files before the refused one stay
 * applied and the ledger holds the folder unfinished. The data step then deletes those rows, as an operator's would,
 * and the same folder applied again resumes and completes: the model's `after` holds the other rows.
 */
const migrateTo = (sys: System, proposed: Model, after: Model, declared: Declarations) =>
	Effect.gen(function* () {
		const { g, names } = yield* draftNext(
			sys,
			builtOf(sys.m.declared, proposed, liveOf(proposed.tier)),
			declared
		)
		const folder = reviewedSource(g, kept)
		const absent = absentRows(proposed)
		if (Arr.isReadonlyArrayNonEmpty(absent)) {
			const failure = yield* Effect.match(applyWith(sys, [folder], g.snapshot), {
				onFailure: (e): MigrateError | undefined => e,
				onSuccess: () => undefined
			})
			if (failure === undefined) {
				sys.names = names
				const held = yield* sys.m.owner.values(
					`SELECT ${columnOf(sys, "tier")}::text, ${columnOf(sys, "w")}::text FROM ${tableOf(sys)} ORDER BY ${columnOf(sys, "id")}`,
					[]
				)
				return assert.fail(
					`the migration applied, though w reads a key Weight does not hold: R's (tier code, w) are ${Formatter.format(held)}`
				)
			}
			const server = failure.server
			if (server.by !== "server") {
				return assert.fail(`the server reports the failure: ${failure.message}`)
			}
			assert.deepEqual(
				{ sqlstate: String(server.error.sqlstate), column: String(server.error.column) },
				{ sqlstate: notNullViolation, column: names.column(relationName, "w") },
				"the migration fails with 23502 naming w's column"
			)
			yield* sys.m.owner.query(
				`DELETE FROM ${tableOf(sys)} WHERE ${columnOf(sys, "id")} IN (${Arr.join(
					Arr.map(absent, (row) => `${row.id}`),
					", "
				)})`,
				[]
			)
		}
		yield* applyWith(sys, [folder], g.snapshot)
		sys.folders.push(folder)
		sys.previous = fromSnapshot(g.snapshot)
		sys.names = names
		yield* sameAsModel(sys, after)
		return took
	})

/** R and its columns as SQL text. */
const tableOf = (sys: System): string => printObjectName(sys.names.relation(relationName))
const columnName = (sys: System, field: string): string => sys.names.column(relationName, field)
const columnOf = (sys: System, field: string): string => quoteIdent(columnName(sys, field))

/** A column of R as the catalog holds it: its name, "stored" where PostgreSQL generates it STORED, and its attnum. */
interface Column {
	readonly name: string
	readonly writing: string
	readonly attnum: number
}

/** R's live columns, in attnum order. */
const columnsOf = (sys: System) =>
	Effect.map(
		sys.m.owner.values(
			`SELECT a.attname::text, CASE a.attgenerated WHEN 's' THEN 'stored' WHEN '' THEN 'written' ELSE a.attgenerated::text END, a.attnum::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
			[tableOf(sys)]
		),
		(rows) =>
			Arr.map(rows, (r): Column => ({
				name: String(r[0]),
				writing: String(r[1]),
				attnum: Number(r[2])
			}))
	)

/** The closed id's, the set's, the count's and the weight's types over the model's roster: the codecs'. */
const codeType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "closedId", roster: state.closed }, { [state.closed]: liveOf(state) })
const setType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "bits", roster: state.closed }, { [state.closed]: liveOf(state) })
const countType: ScalarType = scalarOf({ kind: "pg", type: "bigint" }, {})
const weightType: ScalarType = scalarOf({ kind: "pg", type: "integer" }, {})

/** A value as the oracles compare it: a set by its handles in one order, an integer as a bigint. */
const comparable = (value: unknown): unknown => {
	if (value instanceof Set) {
		return Arr.sort(Arr.map(Arr.fromIterable(value), String), Order.String)
	}
	return typeof value === "number" ? BigInt(value) : value
}

/** Pair's completions of `from`: the handles it pairs `from` with. */
const pairedWith = (rows: ClosedRows, from: string): ReadonlySet<string> =>
	Object.freeze(new Set(Arr.flatMap(rows.pair, (x) => (x.from === from ? [x.to] : []))))

/**
 * Whether a singleton expression's value at `tier` holds the tier: always, but for it ∩ {tier} only where the tier pairs
 * with itself.
 */
const holdsTier = (expr: SingletonExpr, tier: string, rows: ClosedRows): boolean => {
	switch (expr) {
		case "{tier}":
		case "a ∪ {tier}":
			return true
		case "Pair.row(tier) ∩ {tier}":
			return pairedWith(rows, tier).has(tier)
	}
}

/** The naive model of a generated field's expression over a row: plain Sets of handles, their sizes and Weight's rows. */
const naive = (expr: Expr, row: Row, rows: ClosedRows, marked: ReadonlySet<string>): unknown => {
	const a = new Set(row.a)
	const b = new Set(row.b)
	const union = new Set([...row.a, ...row.b])
	const both = new Set(Arr.filter(row.a, (h) => b.has(h)))
	const weighed = Arr.findFirst(rows.weight, (x) => x.tier === row.tier)
	switch (expr) {
		case "|a|":
			return BigInt(a.size)
		case "|b|":
			return BigInt(b.size)
		case "|a ∪ b|":
			return BigInt(union.size)
		case "|a ∩ b|":
			return BigInt(both.size)
		case "a ∪ b":
			return comparable(union)
		case "a ∩ b":
			return comparable(both)
		case "a − b":
			return comparable(new Set(Arr.filter(row.a, (h) => !b.has(h))))
		case "b − a":
			return comparable(new Set(Arr.filter(row.b, (h) => !a.has(h))))
		case "a ∪ L":
			return comparable(new Set([...row.a, ...marked]))
		case "a ∩ L":
			return comparable(new Set(Arr.filter(row.a, (h) => marked.has(h))))
		case "a − L":
			return comparable(new Set(Arr.filter(row.a, (h) => !marked.has(h))))
		case "{tier}":
			return comparable(new Set([row.tier]))
		case "a ∪ {tier}":
			return comparable(new Set([...row.a, row.tier]))
		case "Pair.row(tier)":
			return comparable(pairedWith(rows, row.tier))
		case "Pair.row(tier) ∪ a":
			return comparable(new Set([...pairedWith(rows, row.tier), ...row.a]))
		case "Pair.row(tier) ∩ {tier}":
			return comparable(new Set(Arr.filter([...pairedWith(rows, row.tier)], (h) => h === row.tier)))
		case 'Weight.at("w", tier)':
			return Option.getOrUndefined(Option.map(weighed, (x) => BigInt(x.w)))
		case 'Weight.at("v", tier)':
			return Option.getOrUndefined(Option.map(weighed, (x) => BigInt(x.v)))
	}
}

/**
 * L, the literal set the literal expressions meet: the roster's live handles at even declared positions, the first
 * among them, so over a roster with holes its handles' codes are not their positions.
 */
const markedOf = (state: RosterState): ReadonlyArray<string> =>
	Arr.filter(liveOf(state), (_, i) => i % 2 === 0)

/** The reference evaluator's value, which an expression over a row's own fields always has. */
const referenceValue = (result: CatalogResult, what: string): CarrierValue =>
	Result.isSuccess(result)
		? result.success
		: assert.fail(`${what}: ${Formatter.format(result.failure)}`)

/** A row's caller values as the host evaluator reads its columns: exact carriers. */
const hostRow = (row: Row): ReadonlyMap<string, CarrierValue> =>
	new Map<string, CarrierValue>([
		["id", BigInt(row.id)],
		["tier", row.tier],
		["a", Object.freeze(new Set(row.a))],
		["b", Object.freeze(new Set(row.b))]
	])

/**
 * The model's closed relations as the host evaluator reads them: C.at's cell of Weight, an integer at a tier it holds,
 * and C.row's set of Pair, the completions of a tier.
 */
const closedReader =
	(rows: ClosedRows) =>
	(read: ClosedReadNode, args: ReadonlyArray<CarrierValue>): CarrierValue | undefined => {
		const [key] = args
		if (typeof key !== "string") {
			return undefined
		}
		if (read.relation === pairName && read.kind === "closedRow") {
			return pairedWith(rows, key)
		}
		const weighed = Arr.findFirst(rows.weight, (x) => x.tier === key)
		if (read.relation !== weightName || read.kind !== "closedAt" || Option.isNone(weighed)) {
			return undefined
		}
		return read.field === "w"
			? BigInt(weighed.value.w)
			: read.field === "v"
				? BigInt(weighed.value.v)
				: undefined
	}

/**
 * The installation is the model's: R's columns are its caller's fields and exactly the model's generated ones, each
 * STORED; each row's caller values are the model's; and each generated column of each row holds what the host
 * evaluator computes from the checked schema's expression of that field over the row and the model's closed rows, and
 * what the naive model does.
 */
const sameAsModel = (sys: System, model: Model) =>
	Effect.gen(function* () {
		const present = presentNames(model.generated)
		const columns = yield* columnsOf(sys)
		assert.deepEqual(
			Arr.sort(
				Arr.map(columns, (c) => `${c.name} ${c.writing}`),
				Order.String
			),
			Arr.sort(
				[
					...Arr.map(callerFields, (f) => `${columnName(sys, f)} written`),
					...Arr.map(present, (f) => `${columnName(sys, f)} stored`)
				],
				Order.String
			),
			"R's columns are its caller's fields and exactly the model's generated fields, each STORED"
		)
		const codes = codebookOf(snapshotOf(sys))
		const codeCodec = scalarReader(codeType(model.tier), codes)
		const setCodec = scalarReader(setType(model.tier), codes)
		const storedCodec = (name: GeneratedName) => {
			switch (name) {
				case "k":
					return scalarReader(countType, codes)
				case "p":
				case "s":
					return setCodec
				case "w":
					return scalarReader(weightType, codes)
			}
		}
		const fields = [...callerFields, ...present]
		const rows = yield* sys.m.owner.values(
			`SELECT ${Arr.join(
				Arr.map(fields, (f) => `${columnOf(sys, f)}::text`),
				", "
			)} FROM ${tableOf(sys)} ORDER BY ${columnOf(sys, "id")}`,
			[]
		)
		const checked = checking(builtOf(sys.m.declared, model, liveOf(model.tier)).version.schema)
		const info = defined(checked.relations.get(relationName), "R is checked")
		const closedRead = closedReader(model.closedRows)
		assert.equal(rows.length, model.rows.length, "R holds the model's rows")
		for (const [i, raw] of rows.entries()) {
			const text = (at: number): OutputText =>
				outputText(String(defined(raw[at], `column ${at} of row ${i}`)))
			const row = defined(model.rows[i], `the model's row ${i}`)
			assert.deepEqual(
				{
					id: Number(text(0)),
					tier: codeCodec.convert(text(1)),
					a: comparable(setCodec.convert(text(2))),
					b: comparable(setCodec.convert(text(3)))
				},
				{
					id: row.id,
					tier: row.tier,
					a: comparable(new Set(row.a)),
					b: comparable(new Set(row.b))
				},
				`row ${i} holds the model's caller values`
			)
			const host = hostRow(row)
			for (const [j, name] of present.entries()) {
				const expr = defined(model.generated[name], `the model's ${name}`)
				const field = Option.getOrUndefined(Arr.findFirst(info.fields, (f) => f.name === name))
				const writing = defined(field, `R's checked field ${name}`).writing
				if (writing.kind !== "generated") {
					return assert.fail(`${name} is a generated field of the checked schema`)
				}
				const table = predicateTable(writing.expr)
				const evaluated = succeeded(
					evaluateTable(
						table.exprs,
						table.root,
						{ value: undefined, column: (ref) => host.get(ref.name), closed: closedRead },
						ProgramPatterns.of(tablePatterns(table))
					),
					`the host evaluates ${name} over row ${i}`
				)
				const reference =
					name === "k" || name === "s"
						? [
								[
									"the reference evaluator",
									comparable(
										referenceValue(
											evaluate(writing.expr, {
												kind: "row",
												column: (ref) => host.get(ref.name),
												param: () => undefined,
												regexMember: patternMember
											}),
											`the reference evaluates ${name} over row ${i}`
										)
									)
								] as const
							]
						: []
				yield* agree(
					[
						[
							"PostgreSQL's stored value",
							comparable(storedCodec(name).convert(text(callerFields.length + j)))
						],
						["the host evaluator", comparable(evaluated)],
						["the naive model", naive(expr, row, model.closedRows, new Set(markedOf(model.tier)))],
						...reference
					],
					exact
				)
			}
		}
	})

/**
 * PostgreSQL's refusal of a writer's value for a generated column: 428C9, generated_always (errcodes.txt; rewriteHandler.c
 * rewriteTargetListIU, "cannot insert a non-DEFAULT value into column" and "column can only be updated to DEFAULT").
 */
const generatedAlways = "428C9"

/** PostgreSQL's refusal of NULL in a NOT NULL column: 23502, not_null_violation (errcodes.txt). */
const notNullViolation = "23502"

/** A value of the type of generated field `name` over a roster of `size` codes, which its column refuses whatever it is. */
const valueFor = (size: number, name: GeneratedName): string => {
	switch (name) {
		case "k":
			return "0::bigint"
		case "p":
		case "s":
			return `X'${hexOfText(setText(size, []))}'::bit(${wholeDigits(size)})`
		case "w":
			return "0::integer"
	}
}

/** The server's SQLSTATE and the column it names, of a statement's failure. */
const serverFields = (e: SqlError) =>
	e.reason._tag === "ServerError"
		? { code: e.reason.fields.code, column: Option.getOrUndefined(e.reason.fields.column) }
		: { code: undefined, column: undefined }

/** Each command run on the real system. */
const real = (
	sys: System,
	note: (f: Feature) => void
): Real<Model, Params, Refusal, StepError, Substrate | Scope.Scope> => ({
	write: (p, before, after, verdict) =>
		Effect.gen(function* () {
			const n = sizeOf(before.tier)
			const code = (h: string): number => defined(codeAt(before.tier, h), "a live handle")
			yield* sys.writer.begin
			const failure = yield* Effect.match(
				sys.writer.query(
					`INSERT INTO ${tableOf(sys)} (${Arr.join(
						Arr.map(callerFields, (f) => columnOf(sys, f)),
						", "
					)}) VALUES ($1::integer, $2::smallint, $3::text::bit(${wholeDigits(n)}), $4::text::bit(${wholeDigits(n)}))`,
					[
						before.nextId,
						code(p.tier),
						setText(n, Arr.map(p.a, code)),
						setText(n, Arr.map(p.b, code))
					]
				),
				{ onFailure: (e): SqlError | undefined => e, onSuccess: () => undefined }
			)
			if (verdict.kind === "accepted") {
				assert.equal(failure, undefined, `the row is written: ${failure?.message ?? ""}`)
				yield* sys.writer.commit
				note("a row written")
				if (after.generated.s !== undefined && literalExprs.includes(after.generated.s)) {
					note("a row written under a literal set operand")
				}
				if (codeAt(after.tier, p.tier) !== liveOf(after.tier).indexOf(p.tier)) {
					for (const expr of singletonExprs) {
						if (
							(after.generated.s === expr || after.generated.p === expr) &&
							holdsTier(expr, p.tier, after.closedRows)
						) {
							note(singletonFeatures[expr])
						}
					}
				}
				yield* sameAsModel(sys, after)
				return took
			}
			yield* sys.writer.rollback
			note("a write refused at an absent key")
			assert.deepEqual(
				serverFields(defined(failure, "the row is refused")),
				{ code: notNullViolation, column: columnName(sys, "w") },
				"a row whose tier Weight does not hold is refused with 23502 naming w's column"
			)
			yield* sameAsModel(sys, before)
			return refused("absent key")
		}),
	supply: (p, before) =>
		Effect.gen(function* () {
			const n = sizeOf(before.tier)
			const empty = `X'${hexOfText(setText(n, []))}'::bit(${wholeDigits(n)})`
			const statement =
				p.statement === "insert"
					? `INSERT INTO ${tableOf(sys)} (${Arr.join(
							Arr.map([...callerFields, p.name], (f) => columnOf(sys, f)),
							", "
						)}) VALUES (${before.nextId}, 0::smallint, ${empty}, ${empty}, ${valueFor(n, p.name)})`
					: `UPDATE ${tableOf(sys)} SET ${columnOf(sys, p.name)} = ${valueFor(n, p.name)}`
			note(
				p.statement === "insert"
					? "an insert supplying a generated column refused"
					: "an update of a generated column refused"
			)
			yield* sys.writer.begin
			const failure = yield* Effect.match(sys.writer.query(statement, []), {
				onFailure: (e): SqlError | undefined => e,
				onSuccess: () => undefined
			})
			yield* sys.writer.rollback
			const error = defined(failure, `PostgreSQL refuses the ${p.statement} of ${p.name}`)
			assert.equal(
				serverFields(error).code,
				generatedAlways,
				`the ${p.statement} of ${p.name} is refused as generated_always: ${error.message}`
			)
			yield* sameAsModel(sys, before)
			return refused("generated always")
		}),
	add: (p, before, after) =>
		Effect.gen(function* () {
			const proposed = { ...before, generated: withChoice(before.generated, p) }
			if (before.rows.length > 0) {
				note(
					absentRows(proposed).length > 0
						? "an addition refused at an absent key"
						: "a generated field added over rows"
				)
			}
			return yield* migrateTo(sys, proposed, after, noDeclarations)
		}),
	change: (p, before, after) =>
		Effect.gen(function* () {
			if (before.rows.length > 0) {
				note("a generated field re-expressed over rows")
			}
			const attnumOf = (cs: ReadonlyArray<Column>): number | undefined =>
				Option.getOrUndefined(Arr.findFirst(cs, (c) => c.name === columnName(sys, p.name)))?.attnum
			const was = yield* columnsOf(sys)
			const answer = yield* migrateTo(
				sys,
				{ ...before, generated: withChoice(before.generated, p) },
				after,
				noDeclarations
			)
			const now = yield* columnsOf(sys)
			assert.equal(
				attnumOf(now),
				defined(attnumOf(was), `${p.name} has a column`),
				`${p.name} is re-expressed in place, by SET EXPRESSION: its column keeps its attnum`
			)
			return answer
		}),
	drop: (p, before, after) =>
		Effect.gen(function* () {
			note("a generated field dropped")
			return yield* migrateTo(
				sys,
				{ ...before, generated: without(before.generated, p.name) },
				after,
				{
					renames: [],
					drops: [{ kind: "field", relation: relationName, field: parsedName(p.name) }]
				}
			)
		}),
	"closed rows": (p, before, after) =>
		Effect.gen(function* () {
			const proposed = { ...before, closedRows: p }
			if (
				before.rows.length > 0 &&
				(before.generated.w !== undefined || before.generated.p !== undefined)
			) {
				note(
					absentRows(proposed).length > 0
						? "closed rows refused at an absent key"
						: "closed rows changed under a closed read"
				)
			}
			return yield* migrateTo(sys, proposed, after, noDeclarations)
		}),
	regenerate: (_p, before) =>
		Effect.gen(function* () {
			note("nothing drafted")
			const { g } = yield* draftNext(
				sys,
				builtOf(sys.m.declared, before, liveOf(before.tier)),
				noDeclarations
			)
			assert.deepEqual(
				{ change: g.change, files: g.folder.files.length, fingerprint: g.snapshot.fingerprint },
				{ change: "none", files: 0, fingerprint: snapshotOf(sys).fingerprint },
				"a draft with no change drafts nothing: a generated field's expression is one snapshot text"
			)
			return took
		})
})

layer(Substrate.layer)("generated fields on PostgreSQL 19rc1", (it) => {
	it.effect(
		"every generated column holds what the host evaluator computes from its row, PostgreSQL refuses a writer's value for one and an absent key, and a changed expression migrates in place",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/fields/derived",
						draw: drawn(runGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a roster with a hole",
								"a row written",
								"a row written under a literal set operand",
								"a row written under {tier} at a tier whose code is no position",
								"a row written under a ∪ {tier} at a tier whose code is no position",
								"a row written under Pair.row(tier) ∩ {tier} at a tier that pairs with itself and whose code is no position",
								"a write refused at an absent key",
								"an insert supplying a generated column refused",
								"an update of a generated column refused",
								"a generated field added over rows",
								"an addition refused at an absent key",
								"a generated field re-expressed over rows",
								"a generated field dropped",
								"closed rows changed under a closed read",
								"closed rows refused at an absent key",
								"nothing drafted"
							],
							{ cases: 96, sense: notesOnly }
						),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 4,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the host evaluator and a naive model of each generation expression, against PostgreSQL's stored values; PostgreSQL's verdicts against the model's"
						}
					},
					(drawnRun, kase) =>
						Effect.scoped(
							Effect.gen(function* () {
								const run = aimedRun(drawnRun, kase)
								if (holesOf(run.history.state).length > 0) {
									kase.note("a roster with a hole")
								}
								const initial = initialOf(run.history, run.closedRows, run.generated)
								const declarations = run.history.declarations
								/**
								 * The roster's history first; the closed rows, over the last declaration's handles, and the first
								 * generated fields only at the end.
								 */
								const versionOf = (name: string, declaration: Declaration, at: number): Built =>
									builtOf(
										name,
										at === declarations.length - 1
											? initial
											: { ...initial, closedRows: noClosedRows, generated: noGenerated },
										declaration
									)
								const substrate = yield* Substrate
								const declared = yield* substrate.schema({ create: false, label: "fields_derived" })
								const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
								const ambient = yield* ambientOwner(ordinarySession, [
									identifierOf(identity.schema(parsedSchemaName(declared)))
								])
								const builds = Arr.map(declarations, (d, i) => versionOf(declared, d, i))
								const first = Arr.headNonEmpty(builds)
								const installed = installationOf(
									first.version,
									declared,
									succeeded(
										draftCodes(first.version.schema, fromEmpty, noDeclarations),
										"the first version's codes"
									),
									substrate.owner.role
								)
								const installing: System = {
									m: { declared, owner, ownerLogin: ambient.credentials },
									writer: owner,
									previous: fromEmpty,
									names: installed.names,
									folders: [],
									drafts: 0
								}
								for (const [i, built] of builds.entries()) {
									const { g, names } = yield* draftNext(
										installing,
										built,
										i === 0
											? noDeclarations
											: removedHandles(
													defined(declarations[i - 1], "the declaration before"),
													defined(declarations[i], "the version's declaration")
												)
									)
									const folder = reviewedSource(g, kept)
									yield* applyWith(installing, [folder], g.snapshot)
									installing.folders.push(folder)
									installing.previous = fromSnapshot(g.snapshot)
									installing.names = names
								}
								const last = installationOf(
									Arr.lastNonEmpty(builds).version,
									declared,
									codebookOf(snapshotOf(installing)),
									substrate.owner.role
								)
								const desk = defined(
									Arr.findFirst(last.worlds, (l) => l.name === "desk").pipe(Option.getOrUndefined),
									"the installation's login desk"
								)
								const writerRole = defined(
									Arr.findFirst(desk.roles, (r) => r.name === "writer").pipe(Option.getOrUndefined),
									"desk's role writer"
								)
								const deskLogin = yield* substrate.login(desk.role)
								const writer = yield* substrate.session({
									...worldSession({ login: deskLogin, role: writerRole.role }),
									label: "writer"
								})
								const sys: System = { ...installing, writer }
								yield* sameAsModel(sys, initial)
								yield* runProgram(
									machine(initial),
									real(sys, (f) => kase.note(f)),
									run.program
								)
							})
						)
				)
			)
	)
})
