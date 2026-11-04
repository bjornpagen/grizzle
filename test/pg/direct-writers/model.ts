import type { Case } from "@grizzle/testing/explore"
import { array, boolean, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import {
	Array as Arr,
	Effect,
	Option,
	Record as Rec,
	Result,
	Schema,
	type Scope,
	String as Str
} from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { Expr, Insert, SqlStatement } from "#compiler/sql/ast.ts"
import { and, col, eq, lit, simpleSelect } from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { type OracleState, oracleState, type SequenceState } from "#test/support/oracle/addwins.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { OracleTable } from "#test/support/oracle/install/model.ts"
import { elementAt, indices } from "#test/support/oracle/pick.ts"
import { isSerialKind, typeInfo, type TypeKind } from "#test/support/oracle/write/domain.ts"
import {
	type Fact,
	type FactsSketch,
	factsSketchGen,
	keyOf,
	poolValue,
	type RowSketch,
	resolveFacts,
	resolveRow,
	rowSketchGen,
	type WFacts
} from "#test/support/oracle/write/facts.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { readGroup, resetGroup, type WriteTarget } from "#test/support/oracle/write/run.ts"
import {
	isImmediate,
	oracleSchemaOf,
	relationIn,
	serialColumns,
	type WGroup,
	type WRelation
} from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { pgErrorFields, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

const statementKinds = [
	"insert",
	"insert without overriding",
	"insert generated",
	"insert missing a field",
	"delete",
	"update payload",
	"update identity",
	"truncate"
] as const
type StatementKind = (typeof statementKinds)[number]

interface StatementSketch {
	readonly kind: number
	readonly relation: number
	/** 0 a fresh fact, 1 a copy of a stored one, 2 a stored key with a fresh payload. */
	readonly mode: number
	readonly pick: number
	readonly row: RowSketch
	/**
	 * 0 every value tame, 1 a refined text past its bound, 2 a numeric past its precision, 3 a handle outside the
	 * roster.
	 */
	readonly wild: number
}

/**
 * The level a transaction begins at: SERIALIZABLE, or a planted level below it, whose writes grizzle's guard refuses.
 */
export const levels = [
	"serializable",
	"read committed",
	"repeatable read",
	"read uncommitted"
] as const
export type Level = (typeof levels)[number]

/** A transaction's BEGIN at its level. */
const beginAt = (level: Level): string => `BEGIN ISOLATION LEVEL ${Str.toUpperCase(level)}`

/** Most cases run at SERIALIZABLE, the level every direct writer must use; one in eight is planted below it. */
export const levelGen: Gen<Level> = weighted<Level>([
	[21, constant("serializable")],
	[1, constant("read committed")],
	[1, constant("repeatable read")],
	[1, constant("read uncommitted")]
])

export interface DirectCase {
	readonly group: number
	readonly facts: FactsSketch
	readonly behind: boolean
	readonly level: Level
	readonly immediate: boolean
	/**
	 * Whether the case breaks one of its group's foreign keys, when the group has one: none, a breaking statement before
	 * the drawn ones, or the breaking statement alone, so no later statement's refusal comes first and a deferred key's
	 * violation reaches the end of the transaction. The pick chooses the foreign key and the fact.
	 */
	readonly breaks: Breaks
	readonly statements: ReadonlyArray<StatementSketch>
}

export type Breaks =
	| { readonly kind: "none" }
	| { readonly kind: "first" | "alone"; readonly pick: number; readonly row: RowSketch }

/**
 * A quarter of the cases break a foreign key, half of those with the breaking statement alone. Over 50 drawn runs (226
 * to 286 cases) 80 to 113 cases are on a group with a deferred key, so a run expects about ten deferred breaks alone,
 * split between COMMIT and SET CONSTRAINTS; drawn statements after a break are mostly refused at a statement first.
 */
const breaksGen: Gen<Breaks> = weighted<Breaks>([
	[3, constant({ kind: "none" })],
	[
		1,
		(source) => ({
			kind: source.draw(element(["first", "alone"] as const)),
			pick: source.draw(pickGen),
			row: source.draw(rowSketchGen)
		})
	]
])

const statementSketchGen: Gen<StatementSketch> = (source) => ({
	kind: source.draw(int(0, statementKinds.length - 1)),
	relation: source.draw(pickGen),
	mode: source.draw(int(0, 2)),
	pick: source.draw(pickGen),
	row: source.draw(rowSketchGen),
	wild: source.draw(int(0, 3))
})

export const directCaseGen: Gen<DirectCase> = (source) => ({
	group: source.draw(pickGen),
	/** Up to five stored facts per relation slot, the write oracle's own bound (oracle/write/harness.ts). */
	facts: source.draw(factsSketchGen(5)),
	behind: source.draw(boolean),
	level: source.draw(levelGen),
	immediate: source.draw(boolean),
	breaks: source.draw(breaksGen),
	/** One to three statements, the transactions the header describes. */
	statements: source.draw(array(statementSketchGen, { min: 1, max: 3 }))
})

/** One statement as the model and the writer see it. */
type Statement =
	| {
			readonly kind: "insert"
			readonly relation: WRelation
			readonly fact: Fact
			readonly overriding: boolean
	  }
	| { readonly kind: "insert generated"; readonly relation: WRelation; readonly fact: Fact }
	| { readonly kind: "delete"; readonly relation: WRelation; readonly fact: Fact }
	| {
			readonly kind: "update"
			readonly relation: WRelation
			readonly key: Fact
			/** The fields the UPDATE sets, each with its value: at least one, as a SET clause holds. */
			readonly set: Arr.NonEmptyReadonlyArray<readonly [field: string, value: unknown]>
	  }
	| { readonly kind: "truncate"; readonly relation: WRelation }

/**
 * What a failure names beside its SQLSTATE: one of the constraints a violation of the violated laws is raised under (a
 * key's, a foreign key's or a capacity's partial UNIQUE index, as the installation names them), the table the guard
 * refused a write to, or nothing the model judges.
 */
type Named =
	| { readonly kind: "nothing" }
	| { readonly kind: "constraints"; readonly constraints: ReadonlySet<ConstraintName> }
	| { readonly kind: "table"; readonly relation: string }

/** What a statement, or the transaction's end, did: succeeded, or failed with a SQLSTATE and what it names. */
type Answer =
	| { readonly kind: "ok" }
	| { readonly kind: "error"; readonly sqlstate: string; readonly named: Named }

type Failure = Extract<Answer, { readonly kind: "error" }>

const ok: Answer = { kind: "ok" }
const nothing: Named = { kind: "nothing" }
const error = (sqlstate: string, named: Named): Failure => ({ kind: "error", sqlstate, named })
const violating = (sqlstate: string, constraints: Iterable<ConstraintName>): Failure =>
	error(sqlstate, { kind: "constraints", constraints: new Set(constraints) })

/** The guard's refusal of a write below SERIALIZABLE, naming the relation's table. */
const belowSerializable = (relation: WRelation, level: Level): Answer =>
	level === "serializable" ? ok : error("25000", { kind: "table", relation: relation.name })

/**
 * The prediction: the step that fails, by its index (the statements, then SET CONSTRAINTS when immediate, then
 * COMMIT), and its answer; or the committed state.
 */
type Prediction =
	| { readonly kind: "fails"; readonly at: number; readonly answer: Failure }
	| { readonly kind: "commits"; readonly state: OracleState }

const wildText = "abcd"
const wildNumeric = "1000"
const wildHandle = "H9"

/** The column kind each wild sketch value targets: none, a refined text, a typmod numeric, an enum. */
const wildKinds = [undefined, "text", "numeric(3, 0)", "enum"] as const

/**
 * The statement a sketch draws on a group and its stored facts. A wild statement draws its relation among the group's
 * relations holding a column of its wild kind, so each kind of refusal is reached whenever the group has such a column.
 */
const resolveStatement = (
	group: WGroup,
	stored: WFacts,
	s: StatementSketch
): Statement | undefined => {
	const [first, ...rest] = group.relations
	if (first === undefined) {
		return undefined
	}
	const wildKind = wildKinds[s.wild]
	const [holder, ...holders] =
		wildKind === undefined
			? []
			: Arr.filter(group.relations, (r) => Arr.some(r.columns, (c) => c.kind === wildKind))
	const relation = pickFrom(
		holder === undefined ? [first, ...rest] : [holder, ...holders],
		s.relation
	)
	const kind: StatementKind = elementAt(statementKinds, s.kind, "the statement kinds")
	const facts = stored[relation.name] ?? []
	const storedFact = facts.length === 0 ? undefined : facts[pickIndex(s.pick, facts.length)]
	const fresh: Record<string, unknown> = resolveRow(relation, s.row)
	const drawnFact = (): Record<string, unknown> => {
		if (s.mode === 1 && storedFact !== undefined) {
			return { ...storedFact }
		}
		if (s.mode === 2 && storedFact !== undefined) {
			for (const k of relation.primaryKey) {
				fresh[k] = storedFact[k]
			}
			return fresh
		}
		return fresh
	}
	const wilded = (fact: Fact): Fact => {
		const out: Record<string, unknown> = { ...fact }
		const target =
			wildKind === undefined
				? Option.none()
				: Arr.findFirst(relation.columns, (c) => c.kind === wildKind)
		if (Option.isSome(target)) {
			out[target.value.name] = s.wild === 1 ? wildText : s.wild === 2 ? wildNumeric : wildHandle
		}
		return out
	}
	const serial = serialColumns(relation)
	switch (kind) {
		case "insert":
			return { kind: "insert", relation, fact: wilded(drawnFact()), overriding: true }
		case "insert without overriding":
			return {
				kind: "insert",
				relation,
				fact: wilded(drawnFact()),
				overriding: serial.length === 0
			}
		case "insert missing a field": {
			const [left, ...others] = Arr.filter(relation.columns, (c) => !isSerialKind(c.kind))
			if (left === undefined) {
				return undefined
			}
			const out = pickFrom([left, ...others], s.pick)
			const fact = Rec.fromEntries(
				Arr.filter(Rec.toEntries(wilded(drawnFact())), ([f]) => f !== out.name)
			)
			return { kind: "insert", relation, fact, overriding: true }
		}
		case "insert generated": {
			if (serial.length === 0) {
				return { kind: "insert", relation, fact: wilded(drawnFact()), overriding: true }
			}
			const generated = Rec.fromEntries(
				Arr.filter(Rec.toEntries(drawnFact()), ([f]) => !Arr.some(serial, (c) => c.name === f))
			)
			return { kind: "insert generated", relation, fact: wilded(generated) }
		}
		case "delete":
			return { kind: "delete", relation, fact: storedFact ?? drawnFact() }
		case "update payload": {
			const payload = Arr.filter(
				relation.columns,
				(c) => !relation.primaryKey.includes(c.name) && !serial.includes(c)
			)
			if (!Arr.isReadonlyArrayNonEmpty(payload) || storedFact === undefined) {
				return undefined
			}
			const set = wilded(Rec.fromEntries(Arr.map(payload, (c) => [c.name, fresh[c.name]])))
			const key = Rec.fromEntries(Arr.map(relation.primaryKey, (k) => [k, storedFact[k]]))
			return {
				kind: "update",
				relation,
				key,
				set: Arr.map(payload, (c): readonly [string, unknown] => [c.name, set[c.name]])
			}
		}
		case "update identity": {
			const [identity] = serial
			if (identity === undefined || storedFact === undefined) {
				return undefined
			}
			const key = Rec.fromEntries(Arr.map(relation.primaryKey, (k) => [k, storedFact[k]]))
			return { kind: "update", relation, key, set: [[identity.name, fresh[identity.name]]] }
		}
		case "truncate":
			return { kind: "truncate", relation }
	}
}

/**
 * A statement that breaks one of the group's foreign keys, immediate or deferred: the deletion of the target fact a
 * stored source fact references, or, when no source fact is stored, an insert of a fresh source fact whose reference,
 * its first field shifted along its value pool, names no target fact. None for a group without a foreign key, or when
 * every shift names a target fact (a target holding every value of a small pool).
 */
const breakingStatement = (
	group: WGroup,
	stored: WFacts,
	pick: number,
	row: RowSketch
): ReadonlyArray<Statement> => {
	const [first, ...rest] = group.containments
	if (first === undefined) {
		return []
	}
	const c = pickFrom([first, ...rest], pick)
	const source = relationIn(group, c.from.relation)
	const target = relationIn(group, c.to.relation)
	const targets = stored[target.name] ?? []
	const sources = stored[source.name] ?? []
	const referenced = sources.length === 0 ? undefined : sources[pickIndex(pick, sources.length)]
	if (referenced !== undefined) {
		const key = keyOf(source, c.from.fields, referenced)
		const named = Arr.findFirst(targets, (f) => keyOf(target, c.to.fields, f) === key)
		if (Option.isNone(named)) {
			throw new Error(`a stored ${source.name} fact names no ${target.name} fact`)
		}
		return [{ kind: "delete", relation: target, fact: named.value }]
	}
	const present = new Set(Arr.map(targets, (f) => keyOf(target, c.to.fields, f)))
	const [column, at] = Option.getOrThrow(
		Arr.findFirstWithIndex(source.columns, (candidate) => candidate.name === c.from.fields[0])
	)
	const fresh = resolveRow(source, row)
	const picked = elementAt(row.values, at % row.values.length, "the row sketch's values")
	const shifted = Arr.map(indices(typeInfo[column.kind].values.length), (shift): Fact => ({
		...fresh,
		[column.name]: poolValue(source, at, picked, shift)
	}))
	return Option.match(
		Arr.findFirst(shifted, (fact) => !present.has(keyOf(source, c.from.fields, fact))),
		{
			onNone: () => [],
			onSome: (dangling): ReadonlyArray<Statement> => [
				{ kind: "insert", relation: source, fact: dangling, overriding: true }
			]
		}
	)
}

/** Where PostgreSQL meets each wild value (see the header): the parser, the planner, or the row it builds. */
const wildFaults = [
	{ stage: "parse", kind: "enum", value: wildHandle, sqlstate: "22P02" },
	{ stage: "plan", kind: "numeric(3, 0)", value: wildNumeric, sqlstate: "22003" },
	{ stage: "row", kind: "text", value: wildText, sqlstate: "23514" }
] as const
type Stage = (typeof wildFaults)[number]["stage"]

/** The refusal of a wild value `fact` holds that PostgreSQL meets at `stage`, before any law. */
const wildFault = (relation: WRelation, fact: Fact, stage: Stage): Answer => {
	for (const w of wildFaults) {
		if (
			w.stage === stage &&
			Arr.some(relation.columns, (c) => c.kind === w.kind && fact[c.name] === w.value)
		) {
			return error(w.sqlstate, nothing)
		}
	}
	return ok
}

/** The first refusal among a statement's stages, given in the order PostgreSQL meets them. */
const firstFault = (stages: ReadonlyArray<Answer>): Answer => {
	for (const a of stages) {
		if (a.kind === "error") {
			return a
		}
	}
	return ok
}

/**
 * The column kinds a refined text domain types: a bounded pattern (oracle/write/domain.ts fieldOf), whose CHECK,
 * `(<membership>) IS TRUE` (packages/engine/src/physical/ddl/domains.ts), refuses NULL.
 */
const isRefinedText = (kind: TypeKind): boolean => kind === "text" || kind === "text6"

/**
 * Whether an inserted row leaves a field NULL: a field the INSERT does not list, an identity column apart. PostgreSQL
 * coerces each such NULL to its column's type as it builds the row, so a refined text's domain refuses it, 23514,
 * before any column's NOT NULL is checked, 23502.
 */
const nullField = (relation: WRelation, fact: Fact): Answer => {
	const left = Arr.filter(relation.columns, (c) => !isSerialKind(c.kind) && !Rec.has(fact, c.name))
	if (Arr.some(left, (c) => isRefinedText(c.kind))) {
		return error("23514", nothing)
	}
	return left.length > 0 ? error("23502", nothing) : ok
}

const identityOf = (relation: WRelation, fact: Fact): string =>
	keyOf(
		relation,
		Arr.map(relation.columns, (c) => c.name),
		fact
	)

/**
 * The constraints `fact` would violate entering `relation`'s facts `others`: its keys' and its capacities' partial
 * UNIQUE indexes.
 */
const uniqueLaws = (
	t: WriteTarget,
	group: WGroup,
	relation: WRelation,
	others: ReadonlyArray<Fact>,
	fact: Fact
): ReadonlyArray<ConstraintName> => {
	const laws: Array<ConstraintName> = []
	const occupied = (fields: ReadonlyArray<string>, among: ReadonlyArray<Fact>) =>
		Arr.some(among, (o) => keyOf(relation, fields, o) === keyOf(relation, fields, fact))
	if (occupied(relation.primaryKey, others)) {
		laws.push(t.laws.primaryKeyConstraint(relation.name))
	}
	for (const k of relation.keys) {
		if (occupied(k, others)) {
			laws.push(t.laws.keyConstraint(relation.name, k))
		}
	}
	for (const c of group.capacities) {
		if (
			c.source.relation === relation.name &&
			fact[c.source.selector] === true &&
			occupied(
				c.source.fields,
				Arr.filter(others, (o) => o[c.source.selector] === true)
			)
		) {
			laws.push(t.laws.capacity(relation.name, c.source.fields).index)
		}
	}
	return laws
}

/** The foreign keys `containments` a state breaks, by their constraints. */
const brokenReferences = (
	t: WriteTarget,
	group: WGroup,
	state: ReadonlyMap<string, ReadonlyArray<Fact>>,
	immediate: boolean
): ReadonlyArray<ConstraintName> => {
	const checked = Arr.filter(group.containments, (c) => isImmediate(group, c) === immediate)
	return Arr.flatMap(checked, (c) => {
		const source = Arr.findFirst(group.relations, (r) => r.name === c.from.relation)
		const target = Arr.findFirst(group.relations, (r) => r.name === c.to.relation)
		if (Option.isNone(source) || Option.isNone(target)) {
			return []
		}
		const present = new Set(
			Arr.map(state.get(target.value.name) ?? [], (f) => keyOf(target.value, c.to.fields, f))
		)
		const dangling = Arr.some(
			state.get(source.value.name) ?? [],
			(f) => !present.has(keyOf(source.value, c.from.fields, f))
		)
		return dangling ? [t.laws.foreignKeyConstraint(source.value.name, c.from.fields)] : []
	})
}

/** What a transaction holds between its statements: each relation's facts and each identity sequence's state. */
interface Held {
	readonly facts: ReadonlyMap<string, ReadonlyArray<Fact>>
	readonly sequences: ReadonlyMap<string, SequenceState>
}

/** The failure of statement `at`, or what the transaction holds after it. */
type Step =
	| { readonly kind: "fails"; readonly at: number; readonly answer: Failure }
	| { readonly kind: "held"; readonly held: Held }

/** One statement of a transaction begun at `level`, from what the transaction holds before it. */
const predictStep = (
	t: WriteTarget,
	group: WGroup,
	level: Level,
	held: Held,
	at: number,
	s: Statement
): Step => {
	const r = s.relation
	const serial = serialColumns(r)
	const current = held.facts.get(r.name) ?? []
	const withFacts = (facts: ReadonlyArray<Fact>): Step => ({
		kind: "held",
		held: { facts: new Map(held.facts).set(r.name, facts), sequences: held.sequences }
	})
	switch (s.kind) {
		case "truncate":
			return { kind: "fails", at, answer: error("42501", nothing) }
		case "update": {
			const set = Rec.fromEntries(s.set)
			/** The fact the UPDATE matches, with its position among the current facts. */
			const matched = Arr.findFirstWithIndex(
				current,
				(f) => keyOf(r, r.primaryKey, f) === keyOf(r, r.primaryKey, s.key)
			)
			/**
			 * A domain's CHECK runs as a row is built, so an UPDATE that matches no row (one an earlier statement
			 * deleted) meets none; the parser, the rewriter, the planner and the executor's privilege check run
			 * whatever it matches.
			 */
			const fault = firstFault([
				wildFault(r, set, "parse"),
				Arr.some(serial, (c) => Rec.has(set, c.name)) ? error("428C9", nothing) : ok,
				wildFault(r, set, "plan"),
				r.mutable ? ok : error("42501", nothing),
				belowSerializable(r, level),
				Option.isNone(matched) ? ok : wildFault(r, set, "row")
			])
			if (fault.kind === "error") {
				return { kind: "fails", at, answer: fault }
			}
			if (Option.isNone(matched)) {
				return { kind: "held", held }
			}
			const [old, i] = matched.value
			const next = { ...old, ...set }
			const others = Arr.flatMap(current, (f, j) => (j === i ? [] : [f]))
			const laws = uniqueLaws(t, group, r, others, next)
			return laws.length > 0
				? { kind: "fails", at, answer: violating("23505", laws) }
				: withFacts([...others, next])
		}
		case "insert": {
			const fault = firstFault([
				wildFault(r, s.fact, "parse"),
				serial.length > 0 && !s.overriding ? error("428C9", nothing) : ok,
				wildFault(r, s.fact, "plan"),
				belowSerializable(r, level),
				wildFault(r, s.fact, "row"),
				nullField(r, s.fact)
			])
			if (fault.kind === "error") {
				return { kind: "fails", at, answer: fault }
			}
			const laws = uniqueLaws(t, group, r, current, s.fact)
			return laws.length > 0
				? { kind: "fails", at, answer: violating("23505", laws) }
				: withFacts([...current, s.fact])
		}
		case "insert generated": {
			const fault = firstFault([
				wildFault(r, s.fact, "parse"),
				wildFault(r, s.fact, "plan"),
				belowSerializable(r, level),
				wildFault(r, s.fact, "row"),
				nullField(r, s.fact)
			])
			if (fault.kind === "error") {
				return { kind: "fails", at, answer: fault }
			}
			const sequences = new Map(held.sequences)
			const fact: Record<string, unknown> = { ...s.fact }
			for (const c of serial) {
				const key = `${r.name}.${c.name}`
				const seq = sequences.get(key) ?? { lastValue: 1n, isCalled: false }
				const value = seq.isCalled ? seq.lastValue + 1n : seq.lastValue
				sequences.set(key, { lastValue: value, isCalled: true })
				fact[c.name] = typeInfo[c.kind].spec.carrier === "int8" ? value : Number(value)
			}
			const laws = uniqueLaws(t, group, r, current, fact)
			return laws.length > 0
				? { kind: "fails", at, answer: violating("23505", laws) }
				: {
						kind: "held",
						held: { facts: new Map(held.facts).set(r.name, [...current, fact]), sequences }
					}
		}
		case "delete": {
			/** A DELETE matching no row still fires the guard, a statement trigger. */
			const failed = belowSerializable(r, level)
			if (failed.kind === "error") {
				return { kind: "fails", at, answer: failed }
			}
			const id = identityOf(r, s.fact)
			return withFacts(Arr.filter(current, (f) => identityOf(r, f) !== id))
		}
	}
}

/** The model's prediction for `statements` from `initial`, in a transaction begun at `level`. */
const predict = (
	t: WriteTarget,
	group: WGroup,
	initial: OracleState,
	statements: ReadonlyArray<Statement>,
	level: Level
): Prediction => {
	let held: Held = {
		facts: new Map(
			Arr.map(group.relations, (r) => [
				r.name,
				[...(initial.relations.get(r.name)?.values() ?? [])]
			])
		),
		sequences: new Map(initial.sequences)
	}
	for (const [at, s] of statements.entries()) {
		const step = predictStep(t, group, level, held, at, s)
		if (step.kind === "fails") {
			return step
		}
		held = step.held
		const broken = brokenReferences(t, group, held.facts, true)
		if (broken.length > 0) {
			return { kind: "fails", at, answer: violating("23503", broken) }
		}
	}
	const deferred = brokenReferences(t, group, held.facts, false)
	if (deferred.length > 0) {
		return { kind: "fails", at: statements.length, answer: violating("23503", deferred) }
	}
	const factsOf = (r: WRelation): ReadonlyArray<Fact> => held.facts.get(r.name) ?? []
	const relations = new Map(
		Arr.map(
			group.relations,
			(r) => [r.name, new Map(Arr.map(factsOf(r), (f) => [identityOf(r, f), f]))] as const
		)
	)
	return { kind: "commits", state: { relations, sequences: held.sequences } }
}

/**
 * The typed literal of a value in a column.
 *
 * A handle outside the roster is its text typed by the column's enum, for PostgreSQL's input function to refuse
 * (22P02): literalFor refuses it on the host.
 */
const literalOf = (table: OracleTable, field: string, value: unknown): Expr => {
	const column = Arr.findFirst(table.columns, (c) => c.field === field)
	if (Option.isNone(column)) {
		throw new Error(`${table.relation} has no column ${field}`)
	}
	if (value === wildHandle) {
		return {
			kind: "literal",
			value: { kind: "text", value: wildHandle },
			type: column.value.type.sql
		}
	}
	const expr = literalFor(column.value.type, value, `${table.relation}.${field}`)
	if (Result.isFailure(expr)) {
		throw new Error(`no literal of ${String(value)} in ${table.relation}.${field}`)
	}
	return expr.success
}

const columnOf = (table: OracleTable, field: string): string => {
	const column = Arr.findFirst(table.columns, (c) => c.field === field)
	if (Option.isNone(column)) {
		throw new Error(`${table.relation} has no column ${field}`)
	}
	return column.value.column
}

/** Every field of `fact` equal to its value, the WHERE of an exact DELETE or a keyed UPDATE: true for no field. */
const matching = (table: OracleTable, fact: Fact): Expr => {
	const parts = Arr.map(Rec.toEntries(fact), ([f, x]) =>
		eq(col("r1", columnOf(table, f)), literalOf(table, f, x))
	)
	return Arr.isReadonlyArrayNonEmpty(parts) ? and(parts) : lit.bool(true)
}

/**
 * A statement's SQL, built as a typed AST and emitted.
 *
 * An INSERT of no field lists no column, so every column takes its default: the one row of no column of a SELECT of
 * no target. An INSERT that leaves out a relation's one field so stores NULL there; one into a relation whose every
 * field is an identity column stores each column's next value.
 */
const sqlOf = (t: WriteTarget, s: Statement): string => {
	if (s.kind === "truncate") {
		return `TRUNCATE ${t.laws.table(s.relation.name)}`
	}
	const table = t.installed.plan.tables[s.relation.name]
	if (table === undefined) {
		throw new Error(`no table for ${s.relation.name}`)
	}
	/** The INSERT of a fact's fields, SYSTEM VALUE overriding its identity columns where `overriding`. */
	const inserted = (fact: Fact, overriding: boolean): Insert => {
		const fields = Rec.keys(fact)
		return Arr.isReadonlyArrayNonEmpty(fields)
			? {
					kind: "insert",
					with: undefined,
					table: table.name,
					alias: undefined,
					columns: Arr.map(fields, (f) => columnOf(table, f)),
					overriding: overriding ? "SYSTEM VALUE" : undefined,
					source: { kind: "values", rows: [Arr.map(fields, (f) => literalOf(table, f, fact[f]))] },
					onConflict: undefined,
					returning: []
				}
			: {
					kind: "insert",
					with: undefined,
					table: table.name,
					alias: undefined,
					columns: [],
					overriding: undefined,
					source: { kind: "query", query: simpleSelect([], [], undefined) },
					onConflict: undefined,
					returning: []
				}
	}
	const ast = ((): SqlStatement => {
		switch (s.kind) {
			case "insert":
				return inserted(s.fact, s.overriding && serialColumns(s.relation).length > 0)
			case "insert generated":
				return inserted(s.fact, false)
			case "delete":
				return {
					kind: "delete",
					table: table.name,
					alias: "r1",
					where: matching(table, s.fact),
					with: undefined,
					using: [],
					returning: []
				}
			case "update":
				return {
					kind: "update",
					table: table.name,
					alias: "r1",
					set: Arr.map(s.set, ([f, x]) => ({
						column: columnOf(table, f),
						value: literalOf(table, f, x)
					})),
					where: matching(table, s.key),
					with: undefined,
					from: [],
					returning: []
				}
		}
	})()
	const emitted = emit(ast, emptyNameMap, unmetered)
	if (!emitted.ok) {
		throw new Error(`the statement does not emit: ${emitted.error.message}`)
	}
	return emitted.value.text
}

/** What the writer met: the failing step and its SQLSTATE, constraint and table, or a commit. */
type Met =
	| {
			readonly kind: "fails"
			readonly at: number
			readonly sqlstate: string
			readonly constraint: ConstraintName | undefined
			readonly table: Option.Option<string>
	  }
	| { readonly kind: "commits" }

const runDirect = (
	writer: PsqlWriter,
	level: Level,
	sqls: ReadonlyArray<string>
): Effect.Effect<Met, CaseFailed> =>
	Effect.gen(function* () {
		yield* writer.run(beginAt(level))
		for (const [at, sql] of sqls.entries()) {
			const ran = yield* Effect.result(writer.run(sql))
			if (!Result.isFailure(ran)) {
				continue
			}
			const fields = pgErrorFields(ran.failure)
			yield* Effect.ignore(writer.rollback)
			if (fields === undefined) {
				return yield* Effect.die(ran.failure)
			}
			const met: Met = {
				kind: "fails",
				at,
				sqlstate: fields.code,
				constraint: fields.constraint,
				table: fields.table
			}
			return met
		}
		const committed = yield* Effect.result(writer.commit)
		const commits: Met = { kind: "commits" }
		if (Result.isSuccess(committed)) {
			return commits
		}
		const fields = pgErrorFields(committed.failure)
		if (Schema.is(TransactionRolledBack)(committed.failure) || fields === undefined) {
			return yield* Effect.die(committed.failure)
		}
		const met: Met = {
			kind: "fails",
			at: sqls.length,
			sqlstate: fields.code,
			constraint: fields.constraint,
			table: fields.table
		}
		return met
	}).pipe(
		Effect.catchTags({
			PsqlProcessError: (e) => Effect.die(e),
			PsqlStatementError: (e) => Effect.die(e)
		})
	)

/**
 * What a case reaches: each statement kind it runs, its level, a commit, and each native error at the time it is raised.
 */
export type DirectFeature =
	| `statement ${string}`
	| `level ${Level}`
	| "committed"
	| `${string} at a statement`
	| `${string} at COMMIT`
	| `${string} at SET CONSTRAINTS`

/** The identities of `r`'s facts among `relations`, as the model spells them. */
const identitiesIn = (
	r: WRelation,
	relations: ReadonlyMap<string, ReadonlyMap<string, Fact>>
): ReadonlyArray<string> =>
	Arr.map([...(relations.get(r.name)?.values() ?? [])], (f) => identityOf(r, f))

/** The first relation of `group` whose identities among `relations` are not exactly the ones `want` names. */
const firstChanged = (
	group: WGroup,
	want: (r: WRelation) => ReadonlySet<string>,
	relations: ReadonlyMap<string, ReadonlyMap<string, Fact>>
): Option.Option<WRelation> =>
	Arr.findFirst(group.relations, (r) => {
		const wanted = want(r)
		const got = identitiesIn(r, relations)
		return got.length !== wanted.size || !Arr.every(got, (id) => wanted.has(id))
	})

/**
 * The direct-writer model: a direct SQL writer needs nothing extra, as a model over generated schemas.
 *
 * A psql child logs in over verify-full TLS as the login of a generated write schema, takes on its role `writer`
 * (test/support/oracle/write/schema.ts: keys, candidate keys, deferred and immediate foreign keys, at-most-one
 * capacities, identity columns, refined text, typmod numerics, mutable and immutable relations) and runs one
 * transaction of one to three statements, each built as a typed SQL AST (packages/engine/src/sql/ast.ts) over typed literals
 * and emitted: an INSERT of a complete fact (with OVERRIDING SYSTEM VALUE on an identity column, or without it), a
 * generated INSERT that leaves the identity columns to their sequences, an INSERT that leaves out a field, an exact
 * DELETE, an UPDATE of a fact's payload, an UPDATE of an identity column, and a TRUNCATE; an inserted or updated value
 * may be wild (a text past its refinement's bound, a numeric past its precision, a handle outside the roster). A case
 * on a group with a foreign key may open with a statement that breaks it, or be that statement alone: the deletion of
 * a target fact a stored source fact references, or, with no source fact stored, an insert of a source fact that
 * references no target fact; an immediate key refuses it at once, a deferred one at COMMIT or at SET CONSTRAINTS. The
 * transaction runs at SERIALIZABLE, and may set its constraints IMMEDIATE after its last statement; a planted case begins
 * it below SERIALIZABLE (READ COMMITTED, REPEATABLE READ or READ UNCOMMITTED), which grizzle's guard refuses.
 *
 * The model predicts every statement's outcome and when the transaction fails, from the host state alone:
 *
 * - each statement's refusals in the order PostgreSQL meets them: a handle outside the roster, 22P02, as the parser
 *   reads the enum literal; an explicit value into an identity column without OVERRIDING SYSTEM VALUE, and any UPDATE
 *   of one, 428C9, in the rewriter; a numeric past its precision, 22003, as the planner folds its typmod coercion; an
 *   UPDATE of an immutable relation, and any TRUNCATE, by privilege at executor start, 42501 (immutability is
 *   privilege, and TRUNCATE is granted to no one); then, below SERIALIZABLE, the table's guard trigger, a BEFORE
 *   statement trigger that fires whatever rows the statement matches, 25000 naming the table; then a refined text past
 *   its bound, 23514, by its domain's CHECK as the row is built, so never by an UPDATE that matches no row;
 * - a field left out of an INSERT, an identity column apart, is NULL, at the statement: a refined text's domain refuses
 *   it by its CHECK, `(<membership>) IS TRUE`, 23514, as the row is built, and every other column by its NOT NULL,
 *   23502: no field is nullable. An INSERT that leaves out a relation's one field is DEFAULT VALUES;
 * - a fact at an occupied primary key, candidate key or capacity's partial unique index is 23505 at the statement, an
 *   exact repeat included, under the constraint of one of the violated laws: a key's constraint and a capacity's
 *   partial UNIQUE index as the installation names them;
 * - an immediate foreign key (into a pure set) is 23503 at its statement, a deferred one at COMMIT, or at the SET
 *   CONSTRAINTS that makes it immediate, judged on the transaction's state there;
 * - a generated INSERT draws the next value of each identity sequence, so a sequence behind a stored value collides
 *   on the key at once (no retry: a direct writer is not grizzle);
 * - otherwise the transaction commits, and the committed state and sequences are the model's.
 *
 * A failed statement rolls the transaction back, and the state stays the initial one.
 *
 * Runs one case on the run's installation and writer; fails with the case and both answers on any disagreement.
 *
 * Nothing a failed transaction did stays.
 */
export const runDirectCase = (
	t: WriteTarget,
	writer: PsqlWriter,
	c: DirectCase,
	note: Case<DirectFeature>["note"]
): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const [first, ...rest] = t.schema.groups
		if (first === undefined) {
			return yield* Effect.die(new Error("a write schema of no group"))
		}
		const group = pickFrom([first, ...rest], c.group)
		const stored = resolveFacts(group, c.facts)
		const sequences: Readonly<Record<string, SequenceState>> = c.behind
			? Rec.fromEntries(
					Arr.flatMap(group.relations, (r) =>
						Arr.map(serialColumns(r), (column): readonly [string, SequenceState] => [
							`${r.name}.${column.name}`,
							{ lastValue: 1n, isCalled: false }
						])
					)
				)
			: {}
		const initial = oracleState(oracleSchemaOf(group, t.laws), stored, sequences)
		const drawnStatements = Arr.flatMap(c.statements, (s) => {
			const resolved = resolveStatement(group, stored, s)
			return resolved === undefined ? [] : [resolved]
		})
		const statements = ((): ReadonlyArray<Statement> => {
			switch (c.breaks.kind) {
				case "none":
					return drawnStatements
				case "first":
					return [
						...breakingStatement(group, stored, c.breaks.pick, c.breaks.row),
						...drawnStatements
					]
				case "alone":
					return breakingStatement(group, stored, c.breaks.pick, c.breaks.row)
			}
		})()
		if (statements.length === 0) {
			return
		}
		const sqls = [
			...Arr.map(statements, (s) => sqlOf(t, s)),
			...(c.immediate ? ["SET CONSTRAINTS ALL IMMEDIATE"] : [])
		]
		const predicted = predict(t, group, initial, statements, c.level)
		yield* Effect.orDie(resetGroup(t, group, stored, initial))
		const met = yield* runDirect(writer, c.level, sqls)
		note(`level ${c.level}`)
		const state = yield* Effect.orDie(readGroup(t, group))
		for (const s of statements) {
			note(
				`statement ${s.kind}${s.kind === "insert" && !s.overriding ? " without overriding" : ""}${s.kind === "insert" && nullField(s.relation, s.fact).kind === "error" ? " missing a field" : ""}`
			)
		}
		const report = (why: string) =>
			CaseFailed.make({
				report: Arr.join(
					[
						why,
						...Arr.map(sqls, (sql, i) => `  ${i}: ${sql}`),
						`predicted ${JSON.stringify(predicted.kind === "fails" ? { at: predicted.answer.sqlstate, step: predicted.at, named: predicted.answer.named.kind === "constraints" ? [...predicted.answer.named.constraints] : predicted.answer.named } : "commits")}`,
						`met ${JSON.stringify(met)}`
					],
					"\n"
				)
			})
		if (predicted.kind === "commits") {
			if (met.kind !== "commits") {
				return yield* report("the model commits, the writer failed")
			}
			note("committed")
			const committed = predicted.state
			const changed = firstChanged(
				group,
				(r) => new Set(committed.relations.get(r.name)?.keys() ?? []),
				state.relations
			)
			if (Option.isSome(changed)) {
				return yield* report(`the committed ${changed.value.name} is not the model's`)
			}
			const drifted = Arr.findFirst([...committed.sequences], ([key, seq]) => {
				const got = state.sequences.get(key)
				return got === undefined || got.lastValue !== seq.lastValue || got.isCalled !== seq.isCalled
			})
			if (Option.isSome(drifted)) {
				return yield* report(`the sequence ${drifted.value[0]} is not the model's`)
			}
			return
		}
		if (met.kind !== "fails") {
			return yield* report("the model fails, the writer committed")
		}
		/**
		 * A deferred violation fails at the step after the statements: SET CONSTRAINTS when the transaction makes its
		 * constraints immediate, COMMIT otherwise.
		 */
		const at = predicted.at
		if (met.at !== at || met.sqlstate !== predicted.answer.sqlstate) {
			return yield* report(`the writer failed at step ${met.at} with ${met.sqlstate}`)
		}
		const named = predicted.answer.named
		switch (named.kind) {
			case "nothing":
				break
			case "constraints":
				if (met.constraint === undefined || !named.constraints.has(met.constraint)) {
					return yield* report(
						`the writer's ${met.sqlstate} names ${String(met.constraint)}, no violated law`
					)
				}
				break
			case "table": {
				const table = t.installed.plan.tables[named.relation]
				if (table === undefined) {
					return yield* Effect.die(new Error(`no table for ${named.relation}`))
				}
				if (!Option.contains(met.table, table.name.name)) {
					return yield* report(
						`the writer's ${met.sqlstate} names the table ${Option.getOrElse(met.table, () => "none")}, not ${table.name.name}`
					)
				}
				break
			}
		}
		note(
			`${met.sqlstate} at ${at === statements.length ? (c.immediate ? "SET CONSTRAINTS" : "COMMIT") : "a statement"}`
		)
		const left = firstChanged(
			group,
			(r) => new Set(identitiesIn(r, initial.relations)),
			state.relations
		)
		if (Option.isSome(left)) {
			return yield* report(`the failed transaction left ${left.value.name} changed`)
		}
	})
