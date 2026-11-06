import { describe, it } from "@effect/vitest"
import { runProgram } from "@grizzle/testing/commands"
import { type Case, drawn, exhaust, explore, type Oracle } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { assert, assertVariant, nonEmpty } from "#test/support/assert.ts"
import {
	applied,
	machineOf,
	type MutationStatement as FamilyStatement,
	type Program,
	programGen,
	realOf,
	run
} from "#test/support/families/mutate.ts"
import {
	type Breach,
	breachesOf,
	type Constraint,
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored,
	storedOf,
	theorem,
	familyViolations
} from "#test/support/families/theorem.ts"
import {
	counted,
	relation as descRelation,
	f,
	fin,
	on,
	ordered,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { violations } from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type BoxCase,
	boxGen,
	SPAN_BOX_CASES,
	type SpanBoxCase,
	spanBoxGen,
	type Explored,
	exploredGen,
	FIN_BOX_CASES,
	finBoxGen,
	PAIR_KINDS,
	type Pair,
	type PairKind,
	pairGen,
	VARIANTS,
	type Variant
} from "#test/support/native/generate.ts"
import {
	immediateReferences,
	type NativeConstraint,
	type NativeInstallation,
	type NativeMatch,
	type NativeRow,
	type NativeState,
	type NativeStatement,
	type NativeViolation,
	nativeInstallation,
	nullUseOf,
	stateViolations,
	transact
} from "#test/support/native/model.ts"
import {
	type Compiled,
	compiled,
	fieldTerm,
	holdsComparison,
	type Law,
	lawForms,
	lawSelections,
	lawsOf,
	nativeRow,
	nativeState,
	over,
	overWhere,
	type Phi,
	predTerm,
	RELATIONS,
	type Relations,
	type Row,
	RULE_KINDS,
	type Rule,
	type RuleKind,
	ruleText,
	SPAN_RELATIONS,
	SPAN_RULE_KINDS,
	spanLawsOf,
	type SpanRule,
	type SpanRuleKind,
	spanRuleText,
	type State
} from "#test/support/native/schemas.ts"

/**
 * The native constraints grizzle installs mean what its laws mean. Three readings of one schema meet here: an oracle
 * of the laws' meaning; the native model (test/support/native/model.ts), which evaluates the native objects the law
 * model installs with PostgreSQL's semantics (UNIQUE NULLS DISTINCT and WITHOUT OVERLAPS, FOREIGN KEY … MATCH SIMPLE
 * and PERIOD, immediate or deferred, ON UPDATE CASCADE, CHECK, generated and drawn law columns, contract domains); and
 * PostgreSQL itself, at the pg tier. The oracle is never the compiler: the host law model (test/support/laws/model.ts)
 * for partial projections, keys, containments, span keys and coverage, and for a family the family model
 * (test/support/families), which states when PostgreSQL checks each of the lemma's constraints, and the theorem.
 *
 * Over every state, every law the host model finds broken is refused by a constraint that discharges it, and every
 * constraint the state breaks discharges a law it breaks, so the installation accepts a state exactly when every law
 * holds. Over every transaction from a committed state, each order a writer may send its statements in (one per table
 * and change, a table's removals before its additions, and each immediate reference's target added before and removed
 * after its source) commits exactly when the state it leaves is lawful, and a refusal names a law broken at that
 * moment. A family's transactions, its count's update cascading into its members' drawn copies, commit or are refused
 * where the family model says, at the same statement or at COMMIT, reporting the laws of the constraints it finds broken.
 */

const relations = RELATIONS

/** A schema compiled once per suite: both readings and the native model's installation. */
interface Installed {
	readonly schema: Compiled
	readonly installation: NativeInstallation
}

const installations = new Map<string, Installed>()

/** The installation of `laws` over `declared`, both readings and the native model's, compiled under `label`. */
const install = (label: string, declared: Relations, laws: ReadonlyArray<Law>): Installed => {
	const schema = compiled(declared, laws)
	const installation = nativeInstallation(schema.model)
	if (Result.isFailure(installation)) {
		throw new Error(
			`the native model does not evaluate ${label}: ${Formatter.format(installation.failure)}`
		)
	}
	return { schema, installation: installation.success }
}

/** The installation of `laws` over `declared`, compiled once under `label`. */
const installedOf = (label: string, declared: Relations, laws: ReadonlyArray<Law>): Installed => {
	const known = installations.get(label)
	if (known !== undefined) {
		return known
	}
	const made = install(label, declared, laws)
	installations.set(label, made)
	return made
}

const installedRules = (rules: ReadonlyArray<Rule>): Installed =>
	installedOf(Arr.join(Arr.map(rules, ruleText), " + "), relations, Arr.flatMap(rules, lawsOf))

/** A statement of a transaction as the suite writes it: an INSERT of rows, or a DELETE of rows equal to these. */
interface Write {
	readonly kind: "insert" | "delete"
	readonly relation: string
	readonly rows: NonEmptyReadonlyArray<Row>
}

const sameRow = (a: Row, b: Row): boolean =>
	Rec.keys(a).length === Rec.keys(b).length && Arr.every(Rec.keys(a), (k) => a[k] === b[k])

const appliedWrite = (state: State, w: Write): State => {
	const current = state[w.relation] ?? []
	return {
		...state,
		[w.relation]:
			w.kind === "insert"
				? [...current, ...w.rows]
				: Arr.filter(current, (row) => !Arr.some(w.rows, (gone) => sameRow(row, gone)))
	}
}

const statementOf = (on: Relations, w: Write): NativeStatement => {
	const spec = on[w.relation]
	if (spec === undefined) {
		throw new Error(`a write to ${w.relation}, which the schema does not declare`)
	}
	const rows = Arr.map(w.rows, (row) => nativeRow(spec, row))
	return w.kind === "insert"
		? { kind: "insert", relation: w.relation, rows }
		: { kind: "delete", relation: w.relation, where: rows }
}

/**
 * Every order a writer may send `writes` in: a linear extension of the order a relation's removals take before its
 * additions, and each immediate reference's target is added before its source and removed after it. When the
 * references order the writes both ways, no writer can satisfy them and any order is one it may send, so the writes'
 * own order stands for them.
 */
const ordersOf = (
	installation: NativeInstallation,
	writes: ReadonlyArray<Write>
): NonEmptyReadonlyArray<ReadonlyArray<Write>> => {
	const references = immediateReferences(installation)
	const before = (a: Write, b: Write): boolean =>
		(a.relation === b.relation && a.kind === "delete" && b.kind === "insert") ||
		Arr.some(
			references,
			(r) =>
				(a.kind === "insert" &&
					b.kind === "insert" &&
					a.relation === r.to &&
					b.relation === r.from) ||
				(a.kind === "delete" && b.kind === "delete" && a.relation === r.from && b.relation === r.to)
		)
	const orders: Array<ReadonlyArray<Write>> = []
	const extend = (placed: ReadonlyArray<Write>, rest: ReadonlyArray<Write>): void => {
		if (rest.length === 0) {
			orders.push(placed)
			return
		}
		for (const [i, w] of rest.entries()) {
			if (!Arr.some(rest, (other, j) => j !== i && before(other, w))) {
				extend([...placed, w], Arr.remove(rest, i))
			}
		}
	}
	extend([], writes)
	const [first, ...more] = orders
	return first === undefined ? [writes] : [first, ...more]
}

/** The features every suite notes. */
type Verdict =
	| "accepted"
	| "refused"
	| `refused by ${NativeConstraint["kind"]}`
	| "refused at a statement"
	| "refused at commit"
	| "rows a NULL holds apart"
	| "a reference a NULL skips"
	| "a put"
	| "a removal"

/** The laws a state breaks, by the host law model. */
const brokenIn = (installed: Installed, state: State): ReadonlySet<LawId> =>
	new Set(
		Arr.map(violations(installed.schema.host, installed.schema.hostStateOf(state)), (v) => v.law)
	)

const lawsText = (laws: Iterable<LawId>): string => Arr.join([...laws], ", ") || "none"

/**
 * One state judged: every law it breaks is refused by a constraint discharging that law, and every constraint it
 * breaks discharges a law it breaks.
 */
const judgeState = <F extends string>(
	installed: Installed,
	on: Relations,
	state: State,
	c: Case<F | Verdict>
): ReadonlySet<LawId> => {
	const broken = brokenIn(installed, state)
	const native = nativeState(on, state)
	const refused = stateViolations(installed.installation, native)
	for (const law of broken) {
		assert.ok(
			Arr.some(refused, (v) => v.laws.includes(law)),
			`the law ${law} is broken and no constraint of it refuses the state; the constraints broken: ${Arr.join(
				Arr.map(refused, (v) => `${v.kind} ${v.constraint}`),
				", "
			)}`
		)
	}
	for (const v of refused) {
		assert.ok(
			Arr.some(v.laws, (law) => broken.has(law)),
			`the ${v.kind} ${v.constraint} refuses the state, and none of its laws (${lawsText(v.laws)}) is broken; the laws broken: ${lawsText(broken)}`
		)
		c.note(`refused by ${v.kind}`)
	}
	c.note(refused.length === 0 ? "accepted" : "refused")
	const nulls = nullUseOf(installed.installation, native)
	if (nulls.distinctNulls) {
		c.note("rows a NULL holds apart")
	}
	if (nulls.skippedReference) {
		c.note("a reference a NULL skips")
	}
	return broken
}

/**
 * A transaction from the committed `before`, in every order a writer may send its writes: it commits exactly when the
 * state its writes leave is lawful, to that state, and a refusal names a law broken where it is refused.
 */
const judgeTransaction = <F extends string>(
	installed: Installed,
	on: Relations,
	before: State,
	writes: ReadonlyArray<Write>,
	c: Case<F | Verdict>
): void => {
	const after = Arr.reduce(writes, before, appliedWrite)
	const lawful = brokenIn(installed, after).size === 0
	for (const order of ordersOf(installed.installation, writes)) {
		const sent = Arr.join(
			Arr.map(order, (w) => `${w.kind} ${w.relation}`),
			", "
		)
		const verdict = transact(
			installed.installation,
			nativeState(on, before),
			Arr.map(order, (w) => statementOf(on, w))
		)
		switch (verdict.kind) {
			case "committed":
				assert.ok(lawful, `a transaction sent as ${sent} commits to a state that breaks a law`)
				break
			case "refused": {
				assert.ok(
					!lawful,
					`a transaction sent as ${sent} leaves a lawful state, and is refused ${verdict.at.kind === "commit" ? "at COMMIT" : `at its statement ${verdict.at.index}`} by ${Arr.join(
						Arr.map(verdict.violations, (v) => `${v.kind} ${v.constraint}`),
						", "
					)}`
				)
				const moment =
					verdict.at.kind === "commit"
						? after
						: Arr.reduce(order.slice(0, verdict.at.index + 1), before, appliedWrite)
				const broken = brokenIn(installed, moment)
				for (const v of verdict.violations) {
					assert.ok(
						Arr.some(v.laws, (law) => broken.has(law)),
						`a transaction sent as ${sent} is refused by the ${v.kind} ${v.constraint}, none of whose laws is broken there`
					)
				}
				c.note(verdict.at.kind === "commit" ? "refused at commit" : "refused at a statement")
				break
			}
		}
	}
}

/** The writes that insert a state into empty tables: one INSERT per relation that holds rows. */
const insertsOf = (on: Relations, state: State): ReadonlyArray<Write> =>
	Arr.flatMap(Rec.keys(on), (relation): ReadonlyArray<Write> => {
		const [first, ...rest] = state[relation] ?? []
		return first === undefined ? [] : [{ kind: "insert", relation, rows: [first, ...rest] }]
	})

const deletesOf = (on: Relations, state: State): ReadonlyArray<Write> =>
	Arr.map(insertsOf(on, state), (w): Write => ({ ...w, kind: "delete" }))

/**
 * A state's transactions: inserted into empty tables, in every order; and, when it is lawful, deleted again in every
 * order.
 */
const judgeWrites = <F extends string>(
	installed: Installed,
	on: Relations,
	state: State,
	lawful: boolean,
	c: Case<F | Verdict>
): void => {
	judgeTransaction(installed, on, {}, insertsOf(on, state), c)
	if (lawful) {
		judgeTransaction(installed, on, state, deletesOf(on, state), c)
		c.note("a removal")
	}
}

/** A row's twin: the same row with one field changed, which a put of its key writes in its place. */
const twinOf = (row: Row, field: string): Row => {
	const v = row[field]
	return {
		...row,
		[field]:
			typeof v === "boolean"
				? !v
				: typeof v === "number"
					? v + 1
					: v === undefined
						? 0
						: { start: v.start + 1, end: v.end + 1 }
	}
}

/** The fields outside a relation's primary key: the ones a put may change. */
const payloadOf = (on: Relations, relation: string): ReadonlyArray<string> => {
	const spec = on[relation]
	return spec === undefined
		? []
		: Arr.flatMap(spec.fields, ([field]) => (spec.key.includes(field) ? [] : [field]))
}

/** A put of one row's twin at its key: a DELETE and an INSERT of its table, which a reference into it sees in passing. */
const putOf = (relation: string, row: Row, field: string): ReadonlyArray<Write> => [
	{ kind: "delete", relation, rows: [row] },
	{ kind: "insert", relation, rows: [twinOf(row, field)] }
]

/** Every put on a lawful state: each row of each relation replaced by its twin at each field outside its key. */
const judgePuts = <F extends string>(
	installed: Installed,
	on: Relations,
	state: State,
	c: Case<F | Verdict>
): void => {
	for (const relation of Rec.keys(on)) {
		for (const row of state[relation] ?? []) {
			for (const field of payloadOf(on, relation)) {
				judgeTransaction(installed, on, state, putOf(relation, row, field), c)
				c.note("a put")
			}
		}
	}
}

/**
 * A put on a lawful state: one row, drawn, replaced by its twin at the same key, as one DELETE and one INSERT of its
 * table, which a reference into that table sees in passing.
 */
const judgePut = <F extends string>(
	installed: Installed,
	on: Relations,
	state: State,
	c: Case<F | Verdict>
): void => {
	const puttable = Arr.filter(
		Rec.keys(on),
		(relation) => (state[relation] ?? []).length > 0 && payloadOf(on, relation).length > 0
	)
	if (!Arr.isReadonlyArrayNonEmpty(puttable)) {
		return
	}
	const relation = c.draw(element(puttable))
	const row = c.draw(element(nonEmpty([...(state[relation] ?? [])])))
	const field = c.draw(element(nonEmpty([...payloadOf(on, relation)])))
	judgeTransaction(installed, on, state, putOf(relation, row, field), c)
	c.note("a put")
}

type RuleFeature = RuleKind | Verdict

const boxLiteral = (b: BoxCase): string => `${ruleText(b.rule)}: ${Formatter.format(b.state)}`

/** The box's size, counted by the library's own enumeration. */
const BOX_CASES = 9_645

/** The oracle of the state and transaction suites: the laws' meaning, read from each statement by the host. */
const HOST_ORACLE: Oracle = {
	kind: "second-implementation",
	name: "the host law model's violation of each law, over the states the native model evaluates the installed natives on"
}

/** The oracle of the fin suites: the family theorem's model of the lowering, beside the host law model. */
const FAMILY_ORACLE: Oracle = {
	kind: "specification",
	name: "the family theorem and its constraints (test/support/families/theorem.ts), and the host law model"
}

/** The oracle of grizzle's own families: the family model, which states each constraint's moment, and the theorem. */
const LEMMA_ORACLE: Oracle = {
	kind: "specification",
	name: "the family model's run of each transaction and its constraints (test/support/families/mutate.ts, theorem.ts)"
}

const spanInstalled = (r: SpanRule): Installed =>
	installedOf(spanRuleText(r), SPAN_RELATIONS, spanLawsOf(r))

type SpanFeature = SpanRuleKind | Verdict

const spanLiteral = (b: SpanBoxCase): string =>
	`${spanRuleText(b.rule)}: ${Formatter.format(b.state)}`

type ExploredFeature = RuleKind | Verdict | Variant

const exploredLiteral = (e: Explored): string =>
	`${Arr.join(Arr.map(e.rules, ruleText), " + ")}: ${Formatter.format(e.state)}`

/** The relations of the fin lemma's lowering in today's language: an owner counting its family's rows. */
const FIN: Relations = {
	O: {
		fields: [
			["id", "int"],
			["n", "natural"],
			["live", "boolean"]
		],
		key: ["id"]
	},
	F: {
		fields: [
			["id", "int"],
			["g", "int"],
			["at", "natural"],
			["n", "natural"]
		],
		key: ["id"]
	}
}

const g = fieldTerm("g")
const at = fieldTerm("at")
const n = fieldTerm("n")
const below: Phi = { kind: "fields", op: "lt", left: "at", right: "n" }

/**
 * The fin lemma's four constraints stated as laws, each with the family theorem's name for the constraint that holds
 * it: the slot key (g, at); the copy of the owner's count, (g, n) ⊆ O(id, n); the bound at < n; the last slot,
 * O(id, pred(n)) ⊆ F(g, at); and the closure below the copy, F(g, pred(at)) where at < n ⊆ F(g, at).
 */
const FIN_LAWS: ReadonlyArray<readonly [Constraint, Law]> = [
	["key", { kind: "key", side: over("F", [g, at]) }],
	["copy", { kind: "contained", left: over("F", [g, n]), right: over("O", [fieldTerm("id"), n]) }],
	["bound", { kind: "check", name: "bound", relation: "F", phi: below }],
	[
		"last",
		{
			kind: "contained",
			left: over("O", [fieldTerm("id"), predTerm("n")]),
			right: over("F", [g, at])
		}
	],
	[
		"closure",
		{
			kind: "contained",
			left: overWhere("F", [g, predTerm("at")], below),
			right: over("F", [g, at])
		}
	]
]

const finInstalled = (): Installed =>
	installedOf(
		"the fin lemma",
		FIN,
		Arr.map(FIN_LAWS, ([, law]) => law)
	)

/** A family state as the two relations store it: each owner with its count, each row with its group, index and copy. */
const finState = (stored: Stored): State => ({
	O: Arr.map([...stored.owners], ([id, count]): Row => ({ id, n: count, live: true })),
	F: Arr.map(stored.rows, (r): Row => ({ id: r.member, g: r.group, at: r.at, n: r.copy }))
})

/** The law of each constraint the family theorem names: its identity is the family relation's primary key. */
const finLawOf = (installed: Installed): ((constraint: Constraint) => LawId) => {
	const laws = installed.schema.statementLaws
	return (constraint) => {
		if (constraint === "identity") {
			return installed.schema.primaryKey("F")
		}
		const position = Arr.findFirstIndex(FIN_LAWS, ([name]) => name === constraint)
		const law = Option.flatMap(position, (i) => Option.fromNullishOr(laws[i]?.[0]))
		if (Option.isNone(law)) {
			throw new Error(`the fin lemma states no law for the ${constraint} constraint`)
		}
		return law.value
	}
}

type FinFeature =
	| Verdict
	| "the theorem holds"
	| `breach ${Breach["kind"]}`
	| `violates ${Constraint}`

/**
 * A family state judged three ways: the host law model's broken laws are exactly the laws of the constraints the
 * family theorem's own model of the lowering finds broken, and the native model refuses them as the state judge
 * requires; where every copy is its owner's count, the installation accepts exactly the states the theorem holds of.
 */
const judgeFamily = (installed: Installed, stored: Stored, c: Case<FinFeature>): void => {
	const broken = judgeState(installed, FIN, finState(stored), c)
	const lawOf = finLawOf(installed)
	const modelled = familyViolations(stored)
	assert.deepEqual(
		new Set(Arr.map(modelled, (v) => lawOf(v.constraint))),
		new Set(broken),
		"the laws the host breaks are the laws of the constraints the family model breaks"
	)
	for (const v of modelled) {
		c.note(`violates ${v.constraint}`)
	}
	const breaches = breachesOf(stored)
	for (const b of breaches) {
		c.note(`breach ${b.kind}`)
	}
	const copied = Arr.every(stored.rows, (r) => stored.owners.get(r.group) === r.copy)
	const members = new Set(Arr.map(stored.rows, (r) => r.member))
	if (copied && members.size === stored.rows.length) {
		assert.equal(
			broken.size === 0,
			breaches.length === 0,
			"where every copy is its owner's count, the installation accepts exactly the families the theorem holds of"
		)
	}
	if (Result.isSuccess(theorem(stored))) {
		c.note("the theorem holds")
	}
}

const programs: Gen<Program> = (source) =>
	source.draw(
		programGen(source.draw(element(SHAPES)), {
			families: { owners: { min: 0, max: 2 }, long: { min: 3, max: 4 } },
			steps: { min: 1, max: 6 }
		})
	)

/** A family's lowering as the native model reads it: its installation and the drawn columns its rows write. */
interface FamilyInstalled {
	readonly installation: NativeInstallation
	/** The member's index: its field when ordered, the drawn ‹i› when counted. */
	readonly index: string
	/** ‹n›, the owner's count each member copies. */
	readonly copy: string
}

const familyInstallations = new Map<Shape, FamilyInstalled>()

/**
 * grizzle's own family, ordered or counted: Owner(id, n) counts its members Member(id, g), ordered(on(Member, g, at),
 * fin(Owner, n)) or counted(on(Member, g), fin(Owner, n)), n and an ordered member's at drawn naturals.
 */
const familyInstalled = (shape: Shape): FamilyInstalled => {
	const known = familyInstallations.get(shape)
	if (known !== undefined) {
		return known
	}
	const desc: SchemaDesc = {
		name: "Natives",
		relations: [
			descRelation("Owner", { id: f.integer, n: f.drawn }, ["id"]),
			descRelation(
				"Member",
				shape === "ordered"
					? { id: f.integer, g: f.integer, at: f.drawn }
					: { id: f.integer, g: f.integer },
				["id"]
			)
		],
		statements: [
			shape === "ordered"
				? ordered(on("Member", ["g", "at"]), fin("Owner", "n"))
				: counted(on("Member", ["g"]), fin("Owner", "n"))
		],
		extends: undefined
	}
	const model = lawNamesOf(desc).model
	const installation = nativeInstallation(model)
	if (Result.isFailure(installation)) {
		throw new Error(
			`the native model does not evaluate the ${shape} family: ${Formatter.format(installation.failure)}`
		)
	}
	const [family, ...more] = model.families
	if (family === undefined || more.length > 0) {
		throw new Error(`the ${shape} family's schema holds one family, not ${model.families.length}`)
	}
	const made = {
		installation: installation.success,
		index: family.index.kind === "field" ? family.index.field.name : family.index.column,
		copy: family.copy
	}
	familyInstallations.set(shape, made)
	return made
}

const int = (n: number): bigint => BigInt(n)

/** A family state as its two tables store it, each member writing its group, its index and its copy of the count. */
const familyNative = (fam: FamilyInstalled, stored: Stored): NativeState =>
	new Map([
		[
			"Owner",
			Arr.map(
				[...stored.owners],
				([id, count]): NativeRow =>
					new Map([
						["id", int(id)],
						["n", int(count)]
					])
			)
		],
		[
			"Member",
			Arr.map(
				stored.rows,
				(r): NativeRow =>
					new Map([
						["id", int(r.member)],
						["g", int(r.group)],
						[fam.index, int(r.at)],
						[fam.copy, int(r.copy)]
					])
			)
		]
	])

const numberAt = (row: NativeRow, column: string): number => {
	const v = row.get(column)
	if (typeof v !== "bigint") {
		throw new Error(`a family row holds no integer at ${column}`)
	}
	return Number(v)
}

/** A stored family state read back from its tables. */
const familyStored = (fam: FamilyInstalled, state: NativeState): Stored => ({
	owners: new Map(
		Arr.map(state.get("Owner") ?? [], (row) => [numberAt(row, "id"), numberAt(row, "n")] as const)
	),
	rows: Arr.map(state.get("Member") ?? [], (row): FamilyRow => ({
		group: numberAt(row, "g"),
		at: numberAt(row, fam.index),
		copy: numberAt(row, fam.copy),
		member: numberAt(row, "id")
	}))
})

/** A family statement as SQL over the two tables: a count's update cascades into the copies along the owner axis. */
const familyStatement = (fam: FamilyInstalled, statement: FamilyStatement): NativeStatement => {
	const keyed = (id: number): NativeMatch => new Map([["id", int(id)]])
	switch (statement.kind) {
		case "create":
			return {
				kind: "insert",
				relation: "Owner",
				rows: [
					new Map([
						["id", int(statement.owner)],
						["n", int(statement.count)]
					])
				]
			}
		case "drop":
			return { kind: "delete", relation: "Owner", where: [keyed(statement.owner)] }
		case "count":
			return {
				kind: "update",
				relation: "Owner",
				where: keyed(statement.owner),
				set: new Map([["n", int(statement.count)]])
			}
		case "insert":
			return {
				kind: "insert",
				relation: "Member",
				rows: Arr.map(
					statement.rows,
					(r): NativeRow =>
						new Map([
							["id", int(r.member)],
							["g", int(r.group)],
							[fam.index, int(r.at)],
							[fam.copy, int(r.copy)]
						])
				)
			}
		case "delete":
			return { kind: "delete", relation: "Member", where: Arr.map(statement.members, keyed) }
		case "move":
			return {
				kind: "update",
				relation: "Member",
				where: keyed(statement.member),
				set: new Map([[fam.index, int(statement.at)]])
			}
	}
}

/**
 * The family theorem's name for the constraint a native violation reports: the member's key is its identity, its
 * UNIQUE the slot key, its CHECK the bound, and its three foreign keys the owner, last and predecessor axes. The
 * owner's own keys hold whatever a family writes, so they have no name there.
 */
const lemmaName = (k: NativeConstraint): string => {
	switch (k.kind) {
		case "PrimaryKey":
			return k.relation === "Member" ? "identity" : "the owner's key"
		case "Unique":
			return k.relation === "Member" ? "key" : "the owner's key"
		case "TableCheck":
			return "bound"
		case "ForeignKey":
			return k.relation === "Member" ? (k.target === "Owner" ? "copy" : "closure") : "last"
		case "WithoutOverlaps":
		case "PeriodForeignKey":
		case "Domain":
			return k.kind
	}
}

const constraintOf = (v: NativeViolation, constraints: ReadonlyArray<NativeConstraint>): string => {
	const k = Arr.findFirst(constraints, (c) => c.name === v.constraint)
	if (Option.isNone(k)) {
		throw new Error(`a violation of ${v.constraint}, which the installation does not hold`)
	}
	return lemmaName(k.value)
}

const sortedRows = (stored: Stored): ReadonlyArray<string> =>
	Arr.sort(
		[
			...Arr.map([...stored.owners], ([o, n]) => `owner ${o} ${n}`),
			...Arr.map(stored.rows, (r) => `row ${r.member} ${r.group} ${r.at} ${r.copy}`)
		],
		(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	)

type FamilyFeature =
	| Shape
	| "committed"
	| "refused at a statement"
	| "refused at commit"
	| `refused by ${Constraint}`
	| "a count's cascade"
	| "an unrestricted closure beside the bound"
	| "the theorem holds"
	| `breach ${Breach["kind"]}`

/**
 * The constraints the installation breaks against the family model's: the laws they report are exactly the laws of the
 * lemma's constraints the model finds broken, and the installation breaks every one of those. The lemma restricts its
 * closure to indices below the copy, which the bound makes vacuous for a family that mirrors its slots (fin.md §5.2), so
 * the installation's closure, unrestricted, may refuse a row beyond the count too, and only where the bound does.
 */
const judgeBroken = (
	fam: FamilyInstalled,
	broken: ReadonlyArray<NativeViolation>,
	modelled: ReadonlyArray<Constraint>,
	c: Case<FamilyFeature>
): void => {
	const constraints = fam.installation.constraints
	const names = new Set(Arr.map(broken, (v) => constraintOf(v, constraints)))
	const lawsOfName = (name: string): ReadonlyArray<LawId> =>
		Arr.flatMap(constraints, (k) => (lemmaName(k) === name ? k.laws : []))
	assert.deepEqual(
		new Set(Arr.flatMap(broken, (v) => v.laws)),
		new Set(Arr.flatMap(modelled, lawsOfName)),
		"the installation's refusals report the laws of the constraints the family model breaks"
	)
	for (const name of modelled) {
		assert.ok(
			names.has(name),
			`the installation breaks the ${name} constraint the family model breaks`
		)
	}
	const extra = Arr.filter([...names], (name) => !Arr.some(modelled, (m) => m === name))
	if (extra.length > 0) {
		assert.deepEqual(
			extra,
			["closure"],
			"beyond the family model's, the installation breaks its unrestricted closure alone"
		)
		assert.ok(
			Arr.some(modelled, (m) => m === "bound"),
			"and only where the bound refuses the row"
		)
		c.note("an unrestricted closure beside the bound")
	}
}

/**
 * One transaction of family statements, run on grizzle's installation by the native model and by the family model
 * (test/support/families/mutate.ts run), which states when PostgreSQL checks each of the lemma's constraints: both
 * commit, to one state, or both refuse at one statement or at COMMIT, with one set of constraints broken there.
 */
const judgeFamilyTransaction = (
	shape: Shape,
	before: Families,
	statements: ReadonlyArray<FamilyStatement>,
	c: Case<FamilyFeature>
): void => {
	const fam = familyInstalled(shape)
	const expected = run(shape, before, statements)
	const verdict = transact(
		fam.installation,
		familyNative(fam, storedOf(before)),
		Arr.map(statements, (st) => familyStatement(fam, st))
	)
	c.note(shape)
	if (Arr.some(statements, (st) => st.kind === "count")) {
		c.note("a count's cascade")
		c.pair(shape, "a count's cascade")
	}
	switch (expected.kind) {
		case "committed":
			assertVariant(
				verdict,
				"kind",
				"committed",
				"the installation commits what the family model commits"
			)
			assert.deepEqual(
				sortedRows(familyStored(fam, verdict.state)),
				sortedRows(storedOf(expected.after)),
				"to the families the family model commits to"
			)
			c.note("committed")
			return
		case "refused": {
			assertVariant(
				verdict,
				"kind",
				"refused",
				"the installation refuses what the family model refuses"
			)
			assert.deepEqual(
				verdict.at,
				expected.moment.kind === "commit"
					? { kind: "commit" }
					: { kind: "statement", index: expected.moment.index },
				"at the moment the family model refuses it"
			)
			judgeBroken(
				fam,
				verdict.violations,
				Arr.map(expected.violations, (v) => v.constraint),
				c
			)
			for (const v of expected.violations) {
				c.note(`refused by ${v.constraint}`)
				c.pair(shape, `refused by ${v.constraint}`)
			}
			c.note(expected.moment.kind === "commit" ? "refused at commit" : "refused at a statement")
		}
	}
}

/**
 * A family state judged on grizzle's installation: the constraints it breaks are exactly the family model's, and,
 * where every copy is its owner's count, it is accepted exactly when the theorem holds.
 */
const judgeFamilyState = (shape: Shape, stored: Stored, c: Case<FamilyFeature>): void => {
	const fam = familyInstalled(shape)
	const broken = stateViolations(fam.installation, familyNative(fam, stored))
	judgeBroken(
		fam,
		broken,
		Arr.map(familyViolations(stored), (v) => v.constraint),
		c
	)
	const breaches = breachesOf(stored)
	for (const b of breaches) {
		c.note(`breach ${b.kind}`)
	}
	const copied = Arr.every(stored.rows, (r) => stored.owners.get(r.group) === r.copy)
	if (copied && new Set(Arr.map(stored.rows, (r) => r.member)).size === stored.rows.length) {
		assert.equal(
			broken.length === 0,
			breaches.length === 0,
			"where every copy is its owner's count, the installation accepts exactly the families the theorem holds of"
		)
	}
	if (breaches.length === 0) {
		c.note("the theorem holds")
	}
	c.note(shape)
}

/** A pair's relations, and its two rules' laws, the first's and the second's. */
interface PairLaws {
	readonly on: Relations
	readonly first: ReadonlyArray<Law>
	readonly second: ReadonlyArray<Law>
}

const pairLaws = (p: Pair): PairLaws => {
	switch (p.on) {
		case "items":
			return { on: relations, first: lawsOf(p.first), second: lawsOf(p.second) }
		case "spans":
			return { on: SPAN_RELATIONS, first: spanLawsOf(p.first), second: spanLawsOf(p.second) }
	}
}

const pairLiteral = (p: Pair): string => {
	const rules =
		p.on === "items"
			? [ruleText(p.first), ruleText(p.second)]
			: [spanRuleText(p.first), spanRuleText(p.second)]
	return `${p.stated}: ${Arr.join(rules, " | ")}: ${Formatter.format(p.state)}`
}

/** One statement of a schema: its text in canonical form, and the law the compiler gives it. */
interface Held {
	readonly form: string
	readonly law: LawId
}

/**
 * Each statement of `laws`, in the order Reading states them, the installation compiled from them at its `from`-th law
 * onward.
 */
const heldOf = (
	installed: Installed,
	laws: ReadonlyArray<Law>,
	from: number
): ReadonlyArray<Held> =>
	Arr.flatMap(laws, (law, i) => {
		const forms = lawForms(law)
		const ids = installed.schema.statementLaws[from + i] ?? []
		assert.equal(ids.length, forms.length, `the compiler gives each statement of ${forms[0]} a law`)
		return Arr.zipWith(forms, ids, (form, id): Held => ({ form, law: id }))
	})

/** The names of an installation's constraints, sorted. */
const constraintNames = (installed: Installed): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(installed.installation.constraints, (k) => k.name),
		(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	)

type PairFeature =
	| PairKind
	| Verdict
	| "two laws over selections of one relation"
	| "a comparison stated in both orientations"
	| "a law of a pair refused alone"

/** The oracle of the pair suite: the canonical form read off the drawn selections, and the laws' meaning. */
const PAIR_ORACLE: Oracle = {
	kind: "specification",
	name: "ownership's canonical form of each drawn statement (lawForms), and the host law model's violation of each law over the states the native model evaluates"
}

/**
 * A pair of rules of one kind over selections of one relation, judged on their schema. Two statements are one law
 * exactly when they are one in canonical form; each two distinct laws the pair's positions pair are each discharged by
 * a constraint of its own, which a state breaking it alone is refused by; a rule restated installs the constraints of
 * the rule alone; and the schema accepts a state, and each order of its writes, exactly when its laws hold.
 */
const judgePair = (p: Pair, c: Case<PairFeature>): void => {
	const { on, first, second } = pairLaws(p)
	const installed = install(pairLiteral(p), on, [...first, ...second])
	const ones = heldOf(installed, first, 0)
	const others = heldOf(installed, second, first.length)
	const held = [...ones, ...others]
	for (const [i, a] of held.entries()) {
		for (const b of held.slice(i + 1)) {
			assert.equal(
				a.law === b.law,
				a.form === b.form,
				a.form === b.form
					? `${a.form} is one statement in canonical form, and the compiler gives it two laws, ${a.law} and ${b.law}`
					: `${a.form} and ${b.form} are two laws, and the compiler gives both the law ${a.law}`
			)
		}
	}
	const apart = Arr.filter(Arr.zip(ones, others), ([a, b]) => a.law !== b.law)
	const directions = Arr.flatMap(apart, ([a, b]) => [
		[a.law, b.law] as const,
		[b.law, a.law] as const
	])
	for (const [law, other] of directions) {
		assert.ok(
			Arr.some(
				installed.installation.constraints,
				(k) => k.laws.includes(law) && !k.laws.includes(other)
			),
			`the law ${law} has no constraint of its own beside ${other}'s: ${Arr.join(constraintNames(installed), ", ")}`
		)
	}
	c.note(p.kind)
	switch (p.stated) {
		case "apart":
			if (apart.length > 0) {
				c.note("two laws over selections of one relation")
				c.pair(p.kind, "two laws over selections of one relation")
			}
			break
		case "restated":
			assert.deepEqual(
				constraintNames(installed),
				constraintNames(install(`${pairLiteral(p)}, its first rule alone`, on, first)),
				"a rule restated installs the constraints of the rule alone"
			)
			if (Arr.some(Arr.flatMap(first, lawSelections), holdsComparison)) {
				c.note("a comparison stated in both orientations")
			}
			break
	}
	const broken = judgeState(installed, on, p.state, c)
	const refused = stateViolations(installed.installation, nativeState(on, p.state))
	for (const [law, other] of directions) {
		if (broken.has(law) && !broken.has(other)) {
			assert.ok(
				Arr.some(refused, (v) => v.laws.includes(law) && !v.laws.includes(other)),
				`the state breaks ${law} and not ${other}, and no constraint of ${law}'s own refuses it: ${Arr.join(
					Arr.map(refused, (v) => `${v.kind} ${v.constraint}`),
					", "
				)}`
			)
			c.note("a law of a pair refused alone")
		}
	}
	judgeWrites(installed, on, p.state, broken.size === 0, c)
}

const familyBoxGen: Gen<readonly [Shape, Stored]> = (source) => [
	source.draw(element(SHAPES)),
	source.draw(finBoxGen)
]

const VERDICTS: NonEmptyReadonlyArray<Verdict> = [
	"accepted",
	"refused",
	"refused by PrimaryKey",
	"refused by Unique",
	"refused by ForeignKey",
	"refused by TableCheck",
	"refused by Domain",
	"refused at a statement",
	"refused at commit",
	"rows a NULL holds apart",
	"a reference a NULL skips",
	"a removal"
]

describe("the native constraints grizzle installs", () => {
	it.effect(
		"accept every state of a rule's box exactly when its laws hold, each broken law refused by its own constraint, in every order a writer sends",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/native/box",
						generator: boxGen,
						literal: boxLiteral,
						limit: BOX_CASES,
						box: "every rule of the partial-projection lowering with each of its selections, over every state of at most two Owner rows and three of every other relation, each varying the fields its laws read over two or three values",
						oracle: HOST_ORACLE,
						coverage: requiredInSpace<RuleFeature>([...RULE_KINDS, ...VERDICTS, "a put"]),
						caseHang
					},
					(b, c) =>
						Effect.sync(() => {
							c.note(b.rule.rule)
							const installed = installedRules([b.rule])
							const broken = judgeState(installed, relations, b.state, c)
							judgeWrites(installed, relations, b.state, broken.size === 0, c)
							if (broken.size === 0) {
								judgePuts(installed, relations, b.state, c)
							}
						})
				)
			)
	)

	it.effect(
		"accept a drawn schema's states exactly when its laws hold, over selections of the whole predicate language, puts included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/laws/native/explored",
						draw: drawn(exploredGen),
						oracle: HOST_ORACLE,
						literal: exploredLiteral,
						coverage: required<ExploredFeature>(
							[
								...RULE_KINDS,
								...VERDICTS,
								"a put",
								...VARIANTS,
								...Arr.flatMap(RULE_KINDS, (kind): ReadonlyArray<readonly [RuleKind, Verdict]> =>
									kind === "natural fields"
										? []
										: [
												[kind, "accepted"],
												[kind, "refused"]
											]
								)
							],
							{ cases: 2_000, sense: notesOnly }
						),
						kept: [],
						runs: 1_000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(e, c) =>
						Effect.sync(() => {
							const installed = installedRules(e.rules)
							for (const variant of e.applied) {
								c.note(variant)
							}
							const broken = judgeState(installed, relations, e.state, c)
							for (const r of e.rules) {
								c.note(r.rule)
								c.pair(r.rule, broken.size === 0 ? "accepted" : "refused")
							}
							judgeWrites(installed, relations, e.state, broken.size === 0, c)
							if (broken.size === 0) {
								judgePut(installed, relations, e.state, c)
							}
						})
				)
			)
	)

	it.effect(
		"hold the fin lemma's laws exactly as the family theorem's constraints, over every state of one owner's first four slots",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/native/fin-box",
						generator: finBoxGen,
						literal: Formatter.format,
						limit: FIN_BOX_CASES,
						box: "no owner or an owner of count 0 to 3, over its first four slots, each holding no row, one or two, every copy the count",
						oracle: FAMILY_ORACLE,
						coverage: requiredInSpace<FinFeature>([
							"the theorem holds",
							"breach twice",
							"breach orphan",
							"breach beyond",
							"breach gap",
							"violates key",
							"violates bound",
							"violates copy",
							"violates last",
							"violates closure",
							"refused by ForeignKey",
							"refused by TableCheck",
							"refused by Unique",
							"refused at commit",
							"refused at a statement",
							"a removal"
						]),
						caseHang
					},
					(stored, c) =>
						Effect.sync(() => {
							const installed = finInstalled()
							judgeFamily(installed, stored, c)
							const state = finState(stored)
							judgeWrites(installed, FIN, state, brokenIn(installed, state).size === 0, c)
						})
				)
			)
	)

	it.effect(
		"hold the fin lemma's laws on every state a family program's statements leave, lawful, breaking and misordered",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/laws/native/fin-programs",
						draw: drawn(programs),
						oracle: FAMILY_ORACLE,
						literal: Formatter.format,
						coverage: required<FinFeature>(
							[
								"the theorem holds",
								"breach twice",
								"breach orphan",
								"breach beyond",
								"breach gap",
								"violates identity",
								"violates key",
								"violates bound",
								"violates copy",
								"violates last",
								"violates closure"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) => {
						const installed = finInstalled()
						const every = (before: Families, statements: ReadonlyArray<FamilyStatement>) =>
							Effect.sync(() => {
								for (const stored of Arr.scan(statements, storedOf(before), applied)) {
									judgeFamily(installed, stored, c)
								}
							})
						return runProgram(
							machineOf(p.shape, p.families, p.forms),
							realOf({
								lawful: (_form, m, before) => every(before, m.statements),
								breaking: (_form, m, before) => every(before, m.statements),
								misordered: (m, before) => every(before, m.statements)
							}),
							p.steps
						)
					}
				)
			)
	)
	it.effect(
		"hold grizzle's own families, ordered and counted, as the family theorem's constraints, over every state of one owner's first four slots",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/native/family-box",
						generator: familyBoxGen,
						literal: Formatter.format,
						limit: SHAPES.length * FIN_BOX_CASES,
						box: "each shape, ordered and counted, with no owner or an owner of count 0 to 3, over its first four slots, each holding no row, one or two, every copy the count",
						oracle: LEMMA_ORACLE,
						coverage: requiredInSpace<FamilyFeature>([
							"ordered",
							"counted",
							"the theorem holds",
							"breach twice",
							"breach orphan",
							"breach beyond",
							"breach gap",
							"an unrestricted closure beside the bound"
						]),
						caseHang
					},
					([shape, stored], c) => Effect.sync(() => judgeFamilyState(shape, stored, c))
				)
			)
	)

	it.effect(
		"run every family program's transactions on grizzle's own families as the family model runs them: drawn copies, the count's cascade and each axis's deferral",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/laws/native/family-programs",
						draw: drawn(programs),
						oracle: LEMMA_ORACLE,
						literal: Formatter.format,
						coverage: required<FamilyFeature>(
							[
								"ordered",
								"counted",
								"committed",
								"refused at a statement",
								"refused at commit",
								"a count's cascade",
								"refused by identity",
								"refused by key",
								"refused by bound",
								"refused by copy",
								"refused by last",
								"refused by closure",
								["ordered", "refused by closure"],
								["counted", "refused by closure"],
								["ordered", "a count's cascade"],
								["counted", "a count's cascade"]
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) => {
						const every = (before: Families, statements: ReadonlyArray<FamilyStatement>) =>
							Effect.sync(() => {
								judgeFamilyTransaction(p.shape, before, statements, c)
								for (const stored of Arr.scan(statements, storedOf(before), applied)) {
									judgeFamilyState(p.shape, stored, c)
								}
							})
						return runProgram(
							machineOf(p.shape, p.families, p.forms),
							realOf({
								lawful: (_form, m, before) => every(before, m.statements),
								breaking: (_form, m, before) => every(before, m.statements),
								misordered: (m, before) => every(before, m.statements)
							}),
							p.steps
						)
					}
				)
			)
	)
	it.effect(
		"accept every state of a span rule's box exactly when its laws hold: keys WITHOUT OVERLAPS over fields and law columns, and PERIOD foreign keys from and into selected sides",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/native/span-box",
						generator: spanBoxGen,
						literal: spanLiteral,
						limit: SPAN_BOX_CASES,
						box: "every span rule over at most two rows of Visit and of Shift, each varying the fields its laws read, its owner over two values and its span over two adjacent halves and their whole",
						oracle: HOST_ORACLE,
						coverage: requiredInSpace<SpanFeature>([
							...SPAN_RULE_KINDS,
							"accepted",
							"refused",
							"refused by WithoutOverlaps",
							"refused by PeriodForeignKey",
							"refused at a statement",
							"refused at commit",
							"a put",
							"a removal"
						]),
						caseHang
					},
					(b, c) =>
						Effect.sync(() => {
							c.note(b.rule.rule)
							const installed = spanInstalled(b.rule)
							const broken = judgeState(installed, SPAN_RELATIONS, b.state, c)
							judgeWrites(installed, SPAN_RELATIONS, b.state, broken.size === 0, c)
							if (broken.size === 0) {
								judgePuts(installed, SPAN_RELATIONS, b.state, c)
							}
						})
				)
			)
	)

	it.effect(
		"keep two laws over selections of one relation apart, each refused by its own constraint, and install a rule stated in both orientations as one law",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/laws/native/pairs",
						draw: drawn(pairGen),
						oracle: PAIR_ORACLE,
						literal: pairLiteral,
						coverage: required<PairFeature>(
							[
								...PAIR_KINDS,
								...Arr.map(PAIR_KINDS, (kind): readonly [PairFeature, PairFeature] => [
									kind,
									"two laws over selections of one relation"
								]),
								"two laws over selections of one relation",
								"a comparison stated in both orientations",
								"a law of a pair refused alone"
							],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) => Effect.sync(() => judgePair(p, c))
				)
			)
	)
})
