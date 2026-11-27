/** What the properties of native.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, assertVariant, nonEmpty } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, element, type Gen } from "@bjornpagen/testing/gen"
import type { Need, Case, Oracle } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import {
	type MutationStatement as FamilyStatement,
	type Program,
	programGen,
	run
} from "#test/support/families/mutate.ts"
import {
	type Breach,
	breachesOf,
	type Constraint,
	type Families,
	type FamilyRow,
	familyViolations,
	type Shape,
	SHAPES,
	type Stored,
	storedOf,
	theorem
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
import { type HostFact, type HostValue, violations } from "#test/support/laws/model.ts"
import {
	type Explored,
	exploredGen,
	finBoxGen,
	type Pair,
	type PairKind,
	unbrokenOf,
	type Variant
} from "#test/support/native/generate.ts"
import {
	immediateReferences,
	type NativeConstraint,
	type NativeInstallation,
	nativeInstallation,
	type NativeMatch,
	type NativeRow,
	type NativeState,
	type NativeStatement,
	type NativeViolation,
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
	phiHolds,
	predTerm,
	RELATIONS,
	type Relations,
	type Row,
	type Rule,
	RULE_KINDS,
	type RuleKind,
	ruleText,
	SPAN_RELATIONS,
	spanLawsOf,
	type SpanRule,
	type SpanRuleKind,
	spanRuleText,
	type State
} from "#test/support/native/schemas.ts"

export const relations = RELATIONS

/** A schema compiled: both readings, and the native model's installation of its law model. */
interface Installed {
	readonly schema: Compiled
	readonly installation: NativeInstallation
}

/** The installation of `laws` over `declared`, both readings and the native model's, compiled under `label`. */
export const install = (
	label: string,
	declared: Relations,
	laws: ReadonlyArray<Law>
): Installed => {
	const schema = compiled(declared, laws)
	const installation = nativeInstallation(schema.model)
	if (Result.isFailure(installation)) {
		throw new Error(
			`the native model does not evaluate ${label}: ${Formatter.format(installation.failure)}`
		)
	}
	return { schema, installation: installation.success }
}

/** The installation of the laws `rules` state over the suite's relations, compiled for the case or box carrying it. */
export const installRules = (rules: ReadonlyArray<Rule>): Installed =>
	install(Arr.join(Arr.map(rules, ruleText), " + "), relations, Arr.flatMap(rules, lawsOf))

/** A rule of the box with its installation, compiled once before the box is enumerated. */
export interface RuleEntry {
	readonly rule: Rule
	readonly installed: Installed
}

/** A span rule of the span box with its installation, compiled once before the box is enumerated. */
export interface SpanEntry {
	readonly rule: SpanRule
	readonly installed: Installed
}

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
export const brokenIn = (installed: Installed, state: State): ReadonlySet<LawId> =>
	new Set(
		Arr.map(violations(installed.schema.host, installed.schema.hostStateOf(state)), (v) => v.law)
	)

const lawsText = (laws: Iterable<LawId>): string => Arr.join([...laws], ", ") || "none"

/**
 * One state judged: every law it breaks is refused by a constraint discharging that law, and every constraint it
 * breaks discharges a law it breaks.
 */
export const judgeState = <F extends string>(
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
export const judgeWrites = <F extends string>(
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
export const judgePuts = <F extends string>(
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
export const judgePut = <F extends string>(
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

export type RuleFeature = RuleKind | Verdict

/** The oracle of the state and transaction suites: the laws' meaning, read from each statement by the host. */
export const HOST_ORACLE: Oracle = {
	kind: "second-implementation",
	name: "the host law model's violation of each law, over the states the native model evaluates the installed natives on"
}

/** The oracle of the fin suites: the family theorem's model of the lowering, beside the host law model. */
export const FAMILY_ORACLE: Oracle = {
	kind: "specification",
	name: "the family theorem and its constraints (test/support/families/theorem.ts), and the host law model"
}

/** The oracle of grizzle's own families: the family model, which states each constraint's moment, and the theorem. */
export const LEMMA_ORACLE: Oracle = {
	kind: "specification",
	name: "the family model's run of each transaction and its constraints (test/support/families/mutate.ts, theorem.ts)"
}

export type SpanFeature = SpanRuleKind | Verdict

/**
 * What the explored schemas note: each rule kind, verdict and variant, and a rule accepted with a row on every side its
 * laws read (holdsEverySide), an acceptance no empty side makes vacuous, so a law's constraints see rows to compare when
 * the state is inserted, removed and put.
 */
export type ExploredFeature = RuleKind | Verdict | Variant | "accepted with a row on every side"

/** A part of a relation a law reads: its rows, or the rows its selection holds of. */
type Read = Readonly<{ relation: string; where: Option.Option<Phi> }>

/** The parts of relations a law reads: a key's side, a containment's or a mirrors' two, a check's relation under its selection. */
const readsOf = (law: Law): ReadonlyArray<Read> => {
	switch (law.kind) {
		case "key":
			return [law.side]
		case "contained":
		case "mirrors":
			return [law.left, law.right]
		case "check":
			return [{ relation: law.relation, where: Option.some(law.phi) }]
	}
}

/** Whether `state` holds a row on every side `rule`'s laws read, each in its selection. */
export const holdsEverySide = (rule: Rule, state: State): boolean =>
	Arr.every(Arr.flatMap(lawsOf(rule), readsOf), (read) =>
		Arr.some(state[read.relation] ?? [], (row) =>
			Option.match(read.where, { onNone: () => true, onSome: (phi) => phiHolds(phi, row) })
		)
	)

/** The rule kinds the explored schemas pair with their verdict, accepted and refused: every kind but natural fields. */
export const PAIRED_KINDS: ReadonlyArray<RuleKind> = Arr.filter(
	RULE_KINDS,
	(kind) => kind !== "natural fields"
)

/**
 * The explored schemas, aimed: a case whose turn aims at a paired kind accepted, or accepted with a row on every side,
 * is drawn as a schema of that rule alone over a state no variant breaks (unbrokenOf), where a lawful state of it is
 * drawn; a schema of up to three rules, each state broken by its swarm's variants, rarely is.
 */
export const exploredSpace: Aimed<Explored, ExploredFeature> = aimed(
	exploredGen,
	Arr.flatMap(PAIRED_KINDS, (kind) =>
		Arr.map(
			["accepted", "accepted with a row on every side"] as const,
			(accepted) => [[kind, accepted], unbrokenOf(kind)] as const
		)
	)
)

/** The relations of the fin lemma's lowering in today's language: an owner counting its family's rows. */
export const FIN: Relations = {
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
			["next", "natural"]
		],
		key: ["id"]
	}
}

const g = fieldTerm("g")

const at = fieldTerm("at")

const next = fieldTerm("next")

/** The owners that hold a member: their count above 0. */
const holding: Phi = { kind: "compare", op: "gt", field: "n", value: 0 }

/** The members no member follows: each its own successor. */
const ownSuccessor: Phi = { kind: "fields", op: "eq", left: "next", right: "at" }

/**
 * The fin lemma's four constraints stated as laws, each with the family theorem's name for the constraint that holds
 * it: the slot key (g, at); the holding, F(g) ⊆ O(id) where n > 0, so no row names no owner or an owner of no member;
 * the last slot, O(id, pred(n)) ⊆ F(g, at) where next = at, the owner's last member one no member follows; and the
 * closure, F(g, pred(at), at) ⊆ F(g, at, next), each row's predecessor one whose successor it is. Together they hold a
 * row past the count to a predecessor at n − 1 whose successor the last slot holds at n − 1, which refuses it.
 */
const FIN_LAWS: ReadonlyArray<readonly [Constraint, Law]> = [
	["key", { kind: "key", side: over("F", [g, at]) }],
	[
		"holding",
		{ kind: "contained", left: over("F", [g]), right: overWhere("O", [fieldTerm("id")], holding) }
	],
	[
		"last",
		{
			kind: "contained",
			left: over("O", [fieldTerm("id"), predTerm("n")]),
			right: overWhere("F", [g, at], ownSuccessor)
		}
	],
	[
		"closure",
		{
			kind: "contained",
			left: over("F", [g, predTerm("at"), at]),
			right: over("F", [g, at, next])
		}
	]
]

/** The fin lemma's installation, compiled once by each suite that judges it, before its search. */
const finInstallation = (): Installed =>
	install(
		"the fin lemma",
		FIN,
		Arr.map(FIN_LAWS, ([, law]) => law)
	)

/** A family state as the two relations store it: each owner with its count, each row with its group, index and
 * successor. */
export const finState = (stored: Stored): State => ({
	O: Arr.map([...stored.owners], ([id, count]): Row => ({ id, n: count, live: true })),
	F: Arr.map(stored.rows, (r): Row => ({ id: r.member, g: r.group, at: r.at, next: r.next }))
})

/** Whether every row's successor is the one its slot and its owner's count draw: the slot after it below the count,
 * its own slot elsewhere. */
const drawnSuccessors = (stored: Stored): boolean =>
	Arr.every(stored.rows, (r) => {
		const count = stored.owners.get(r.group) ?? 0
		return r.next === (r.at + 1 < count ? r.at + 1 : r.at)
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

export type FinFeature =
	| Verdict
	| "the theorem holds"
	| `breach ${Breach["kind"]}`
	| `violates ${Constraint}`

/**
 * A family state judged three ways: the host law model's broken laws are exactly the laws of the constraints the
 * family theorem's own model of the lowering finds broken, and the native model refuses them as the state judge
 * requires; where every successor is drawn from its slot and its owner's count, the installation accepts exactly the
 * states the theorem holds of.
 */
export const judgeFamily = (installed: Installed, stored: Stored, c: Case<FinFeature>): void => {
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
	const members = new Set(Arr.map(stored.rows, (r) => r.member))
	if (drawnSuccessors(stored) && members.size === stored.rows.length) {
		assert.equal(
			broken.size === 0,
			breaches.length === 0,
			"where every successor is drawn, the installation accepts exactly the families the theorem holds of"
		)
	}
	if (Result.isSuccess(theorem(stored))) {
		c.note("the theorem holds")
	}
}

export const programs: Gen<Program> = (source) =>
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
	/** ‹s›, each member's successor. */
	readonly next: string
}

/**
 * grizzle's own family, ordered or counted: Owner(id, n) counts its members Member(id, g), ordered(on(Member, g, at),
 * fin(Owner, n)) or counted(on(Member, g), fin(Owner, n)), n and an ordered member's at drawn naturals.
 */
const familyInstalled = (shape: Shape): FamilyInstalled => {
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
		bases: []
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
	return {
		installation: installation.success,
		index:
			family.shape.index.kind === "field"
				? family.shape.index.field.name
				: family.shape.index.column,
		next: family.next
	}
}

/** Each family shape's installation, which a search compiles once before its cases run. */
type FamiliesInstalled = { readonly [S in Shape]: FamilyInstalled }

const familiesInstalled = (): FamiliesInstalled => ({
	ordered: familyInstalled("ordered"),
	counted: familyInstalled("counted")
})

const int = (n: number): bigint => BigInt(n)

/** A family state as its two tables store it, each member writing its group, its index and its successor. */
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
						[fam.next, int(r.next)]
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
		next: numberAt(row, fam.next),
		member: numberAt(row, "id")
	}))
})

/** A family statement as SQL over the two tables: a count's update reaches no member, and a member's successor is set
 * by its own statement. */
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
							[fam.next, int(r.next)]
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
				set: new Map([
					[fam.index, int(statement.at)],
					[fam.next, int(statement.next)]
				])
			}
		case "successor":
			return {
				kind: "update",
				relation: "Member",
				where: keyed(statement.member),
				set: new Map([[fam.next, int(statement.next)]])
			}
	}
}

/**
 * The family theorem's name for the constraint a native violation reports: the member's key is its identity, its
 * UNIQUEs the slot key, and its three foreign keys the owner axis, its holding reference, and the last and predecessor
 * axes; a counted index's CHECK keeps it a natural, which the model's index always is. The owner's own keys hold
 * whatever a family writes, so they have no name there.
 */
const lemmaName = (k: NativeConstraint): string => {
	switch (k.kind) {
		case "PrimaryKey":
			return k.relation === "Member" ? "identity" : "the owner's key"
		case "Unique":
			return k.relation === "Member" ? "key" : "the owner's key"
		case "TableCheck":
			return "the index's domain"
		case "ForeignKey":
			return k.relation === "Member" ? (k.target === "Owner" ? "holding" : "closure") : "last"
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
			...Arr.map(stored.rows, (r) => `row ${r.member} ${r.group} ${r.at} ${r.next}`)
		],
		(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	)

export type FamilyFeature =
	| Shape
	| "committed"
	| "refused at a statement"
	| "refused at commit"
	| `refused by ${Constraint}`
	| "a count update"
	| "the theorem holds"
	| `breach ${Breach["kind"]}`

/**
 * The constraints the installation breaks against the family model's: the laws they report are exactly the laws of the
 * lemma's constraints the model finds broken, and the installation breaks exactly those.
 */
const judgeBroken = (
	fam: FamilyInstalled,
	broken: ReadonlyArray<NativeViolation>,
	modelled: ReadonlyArray<Constraint>
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
	assert.deepEqual(
		names,
		new Set<string>(modelled),
		"the installation breaks exactly the constraints the family model breaks"
	)
}

/**
 * One transaction of family statements, run on grizzle's installation by the native model and by the family model
 * (test/support/families/mutate.ts run), which states when PostgreSQL checks each of the lemma's constraints: both
 * commit, to one state, or both refuse at one statement or at COMMIT, with one set of constraints broken there.
 */
export const judgeFamilyTransaction = (
	fam: FamilyInstalled,
	shape: Shape,
	before: Families,
	statements: ReadonlyArray<FamilyStatement>,
	c: Case<FamilyFeature>
): void => {
	const expected = run(shape, before, statements)
	const verdict = transact(
		fam.installation,
		familyNative(fam, storedOf(before)),
		Arr.map(statements, (st) => familyStatement(fam, st))
	)
	c.note(shape)
	if (Arr.some(statements, (st) => st.kind === "count")) {
		c.note("a count update")
		c.pair(shape, "a count update")
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
				Arr.map(expected.violations, (v) => v.constraint)
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
 * where every successor is drawn from its slot and its owner's count, it is accepted exactly when the theorem holds.
 */
export const judgeFamilyState = (
	fam: FamilyInstalled,
	shape: Shape,
	stored: Stored,
	c: Case<FamilyFeature>
): void => {
	const broken = stateViolations(fam.installation, familyNative(fam, stored))
	judgeBroken(
		fam,
		broken,
		Arr.map(familyViolations(stored), (v) => v.constraint)
	)
	const breaches = breachesOf(stored)
	for (const b of breaches) {
		c.note(`breach ${b.kind}`)
	}
	if (
		drawnSuccessors(stored) &&
		new Set(Arr.map(stored.rows, (r) => r.member)).size === stored.rows.length
	) {
		assert.equal(
			broken.length === 0,
			breaches.length === 0,
			"where every successor is drawn, the installation accepts exactly the families the theorem holds of"
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

/** One statement of a schema: its text in canonical form, the law the compiler gives it, and the law as stated. */
interface Held {
	readonly form: string
	readonly law: LawId
	readonly stated: Law
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
		return Arr.zipWith(forms, ids, (form, id): Held => ({ form, law: id, stated: law }))
	})

/**
 * Whether every state that breaks `law` breaks `other` too: two keys at one side's terms, every fact `law` selects one
 * `other` selects (selectedWithin), so two facts `law` holds apart are two facts `other` holds apart. No state breaks
 * such a law alone, so none needs a constraint of its own: its UNIQUE reports the key it implies beside it
 * (laws/model/model.ts #implyingKey). Two laws of any other kind are never so judged.
 */
const breaksWith = (law: Law, other: Law): boolean =>
	law.kind === "key" &&
	other.kind === "key" &&
	law.side.relation === other.side.relation &&
	law.side.terms.length === other.side.terms.length &&
	Arr.every(
		Arr.zip(law.side.terms, other.side.terms),
		([t, u]) => t.kind === u.kind && t.field === u.field
	) &&
	Option.match(other.side.where, {
		onNone: () => true,
		onSome: (wider) =>
			Option.match(law.side.where, {
				onNone: () => Arr.every(factsOf([wider]), (fact) => phiHolds(wider, fact)),
				onSome: (narrower) => selectedWithin(narrower, wider)
			})
	})

/** Whether every fact `narrower` holds of `wider` holds of too, over every fact of the fields they read (factsOf). */
const selectedWithin = (narrower: Phi, wider: Phi): boolean =>
	Arr.every(
		factsOf([narrower, wider]),
		(fact) => !phiHolds(narrower, fact) || phiHolds(wider, fact)
	)

/** The fields a selection reads as numbers and as booleans, and the literals it compares a number with. */
interface SelectionReads {
	readonly numbers: ReadonlyArray<string>
	readonly booleans: ReadonlyArray<string>
	readonly literals: ReadonlyArray<number>
}

/** What `phi` reads (SelectionReads). */
const selectionReads = (phi: Phi): SelectionReads => {
	switch (phi.kind) {
		case "compare":
		case "literalFirst":
			return { numbers: [phi.field], booleans: [], literals: [phi.value] }
		case "fields":
			return { numbers: [phi.left, phi.right], booleans: [], literals: [] }
		case "is":
			return { numbers: [], booleans: [phi.field], literals: [] }
		case "between":
			return { numbers: [phi.field], booleans: [], literals: [phi.low, phi.high] }
		case "in":
			return { numbers: [phi.field], booleans: [], literals: phi.values }
		case "and":
		case "or": {
			const left = selectionReads(phi.left)
			const right = selectionReads(phi.right)
			return {
				numbers: [...left.numbers, ...right.numbers],
				booleans: [...left.booleans, ...right.booleans],
				literals: [...left.literals, ...right.literals]
			}
		}
		case "not":
			return selectionReads(phi.arg)
	}
}

/**
 * Every fact over the fields `phis` read, each number field over the integers from k below the least literal to k
 * above the greatest (0 among them), k the number fields' count, and each boolean field either way: every order of the
 * number fields among themselves and the literals is one of these facts', so a selection holds of some integer fact
 * exactly when it holds of one of these.
 */
const factsOf = (phis: ReadonlyArray<Phi>): ReadonlyArray<HostFact> => {
	const reads = Arr.map(phis, selectionReads)
	const numbers = Arr.dedupe(Arr.flatMap(reads, (r) => r.numbers))
	const booleans = Arr.dedupe(Arr.flatMap(reads, (r) => r.booleans))
	const literals = Arr.flatMap(reads, (r) => r.literals)
	const low = Arr.reduce(literals, 0, (a, b) => Math.min(a, b)) - numbers.length
	const high = Arr.reduce(literals, 0, (a, b) => Math.max(a, b)) + numbers.length
	const values: ReadonlyArray<HostValue> = Array.from({ length: high - low + 1 }, (_, i) => low + i)
	const domains: ReadonlyArray<readonly [string, ReadonlyArray<HostValue>]> = [
		...Arr.map(numbers, (field) => [field, values] as const),
		...Arr.map(booleans, (field) => [field, [false, true]] as const)
	]
	const none: ReadonlyArray<HostFact> = [{}]
	return Arr.reduce(domains, none, (facts, [field, domain]) =>
		Arr.flatMap(facts, (fact) => Arr.map(domain, (v): HostFact => ({ ...fact, [field]: v })))
	)
}

/** The names of an installation's constraints, sorted. */
const constraintNames = (installed: Installed): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(installed.installation.constraints, (k) => k.name),
		(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	)

export type PairFeature =
	| PairKind
	| Verdict
	| "two laws over selections of one relation"
	| "a comparison stated in both orientations"
	| "a law of a pair refused alone"

/** The oracle of the pair suite: the canonical form read off the drawn selections, and the laws' meaning. */
export const PAIR_ORACLE: Oracle = {
	kind: "specification",
	name: "ownership's canonical form of each drawn statement (lawForms), and the host law model's violation of each law over the states the native model evaluates"
}

/**
 * A pair of rules of one kind over selections of one relation, judged on their schema. Two statements are one law
 * exactly when they are one in canonical form; each two distinct laws the pair's positions pair are each discharged by
 * a constraint of its own, which a state breaking it alone is refused by, but a law no state breaks alone (breaksWith),
 * which a constraint discharges; a rule restated installs the constraints of the rule alone; and the schema accepts a
 * state, and each order of its writes, exactly when its laws hold.
 */
export const judgePair = (p: Pair, c: Case<PairFeature>): void => {
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
	for (const [a, b] of Arr.flatMap(apart, ([a, b]) => [[a, b] as const, [b, a] as const])) {
		if (breaksWith(a.stated, b.stated)) {
			assert.ok(
				Arr.some(installed.installation.constraints, (k) => k.laws.includes(a.law)),
				`the law ${a.law}, which no state breaks without ${b.law}, has no constraint: ${Arr.join(constraintNames(installed), ", ")}`
			)
		} else {
			assert.ok(
				Arr.some(
					installed.installation.constraints,
					(k) => k.laws.includes(a.law) && !k.laws.includes(b.law)
				),
				`the law ${a.law} has no constraint of its own beside ${b.law}'s: ${Arr.join(constraintNames(installed), ", ")}`
			)
		}
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

export const familyBoxGen: Gen<readonly [Shape, Stored]> = (source) => [
	source.draw(element(SHAPES)),
	source.draw(finBoxGen)
]

export const VERDICTS: NonEmptyReadonlyArray<Verdict> = [
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

export const installed = finInstallation()

/** What the search built once before its cases (installed), now once per worker: every case on it reads them. */
export const finNeed = {
	key: "test/unit/laws/native.fixtures.ts finNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const installed = finInstallation()
		return Effect.succeed(installed)
	})
} as const satisfies Need<unknown>

/** What the search built once before its cases (installed), now once per worker: every case on it reads them. */
export const familiesStateNeed = {
	key: "test/unit/laws/native.fixtures.ts familiesStateNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const installed = familiesInstalled()
		return Effect.succeed(installed)
	})
} as const satisfies Need<unknown>

/** What the search built once before its cases (installed), now once per worker: every case on it reads them. */
export const familiesNeed = {
	key: "test/unit/laws/native.fixtures.ts familiesNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const installed = familiesInstalled()
		return Effect.succeed(installed)
	})
} as const satisfies Need<unknown>
