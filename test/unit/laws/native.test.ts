import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, nondecreasing, subset } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { violations } from "#test/pg/laws/families/model.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type NativeConstraint,
	type Duplicate,
	type NativeInstallation,
	type NativeStatement,
	type NativeViolation,
	nativeInstallation,
	nullUseOf,
	immediateReferences,
	stateViolations,
	transact
} from "#test/support/native/model.ts"
import {
	compiled,
	type Compiled,
	type Law,
	lawsOf,
	nativeRow,
	nativeState,
	type Phi,
	phiFields,
	RELATIONS,
	type Relations,
	type Row,
	RULE_KINDS,
	type Rule,
	type RuleKind,
	ruleText,
	type State,
	hostState
} from "#test/support/native/schemas.ts"

/**
 * The native constraints grizzle installs mean what its laws mean. Three readings of one schema meet here: the host
 * law model (test/pg/laws/families/model.ts) reads each statement's meaning; the native model
 * (test/support/native/model.ts) evaluates the native objects the law model installs, UNIQUE NULLS DISTINCT, FOREIGN
 * KEY … MATCH SIMPLE immediate or deferred, CHECK, the generated law columns and the contract domains, with
 * PostgreSQL's semantics; and test/pg holds PostgreSQL itself to the same states. Oracle: the host law model, a second
 * implementation of the laws' meaning, never the compiler's.
 *
 * Over every state, every law the host model finds broken is refused by a constraint that discharges it, and every
 * constraint the state breaks discharges a law it breaks, so the installation accepts a state exactly when every law
 * holds. Over every transaction from a committed state, each order a writer may send its statements in (one per table
 * and change, a table's removals before its additions, and each immediate reference's target added before and removed
 * after its source) commits exactly when the state it leaves is lawful, and a refusal names a law broken at that
 * moment.
 */

const relations = RELATIONS

/** A schema compiled once per suite: both readings and the native model's installation. */
interface Installed {
	readonly schema: Compiled
	readonly installation: NativeInstallation
}

const installations = new Map<string, Installed>()

/** The installation of `laws` over `over`, compiled once under `label`. */
const installedOf = (label: string, over: Relations, laws: ReadonlyArray<Law>): Installed => {
	const known = installations.get(label)
	if (known !== undefined) {
		return known
	}
	const schema = compiled(over, laws)
	const installation = nativeInstallation(schema.model)
	if (Result.isFailure(installation)) {
		throw new Error(
			`the native model does not evaluate ${label}: ${Formatter.format(installation.failure)}`
		)
	}
	const made = { schema, installation: installation.success }
	installations.set(label, made)
	return made
}

const installedRules = (rules: ReadonlyArray<Rule>): Installed =>
	installedOf(Arr.join(Arr.map(rules, ruleText), " + "), relations, Arr.flatMap(rules, lawsOf))

/** A statement of a transaction as the suite writes it: an INSERT of rows, or a DELETE of rows equal to these. */
interface Write {
	readonly kind: NativeStatement["kind"]
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
	return {
		kind: w.kind,
		relation: w.relation,
		rows: Arr.map(w.rows, (row) => nativeRow(spec, row))
	}
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
	| "a key refusal a broken key implies"

/** The laws a state breaks, by the host law model. */
const brokenIn = (installed: Installed, on: Relations, state: State): ReadonlySet<LawId> =>
	new Set(Arr.map(violations(installed.schema.host, hostState(on, state)), (v) => v.law))

const lawsText = (laws: Iterable<LawId>): string => Arr.join([...laws], ", ") || "none"

const sameDuplicate = (a: Duplicate, b: Duplicate): boolean =>
	a.relation === b.relation && a.first === b.first && a.second === b.second

/**
 * Whether a key's refusal is implied by a broken law's: every pair of rows it holds equal, a key of a broken law holds
 * equal too, so a write it refuses breaks that law. A generated UNIQUE that a reference's target needs (a superkey, a
 * selected target's law column) discharges the containment it serves, and refuses only duplicates of the relation's
 * own key.
 */
const impliedBy = (
	v: NativeViolation,
	refused: ReadonlyArray<NativeViolation>,
	broken: ReadonlySet<LawId>
): boolean =>
	v.duplicates.length > 0 &&
	Arr.every(v.duplicates, (d) =>
		Arr.some(
			refused,
			(w) =>
				w !== v &&
				Arr.some(w.laws, (law) => broken.has(law)) &&
				Arr.some(w.duplicates, (e) => sameDuplicate(d, e))
		)
	)

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
	const broken = brokenIn(installed, on, state)
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
		const own = Arr.some(v.laws, (law) => broken.has(law))
		const implied = !own && impliedBy(v, refused, broken)
		assert.ok(
			own || implied,
			`the ${v.kind} ${v.constraint} refuses the state, and none of its laws (${lawsText(v.laws)}) is broken; the laws broken: ${lawsText(broken)}`
		)
		if (implied) {
			c.note("a key refusal a broken key implies")
		}
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
	const lawful = brokenIn(installed, on, after).size === 0
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
				const at =
					verdict.at.kind === "commit"
						? after
						: Arr.reduce(order.slice(0, verdict.at.index + 1), before, appliedWrite)
				const broken = brokenIn(installed, on, at)
				for (const v of verdict.violations) {
					assert.ok(
						Arr.some(v.laws, (law) => broken.has(law)) || impliedBy(v, verdict.violations, broken),
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

/** The value a box gives a field it does not vary. */
const FIXED: Readonly<Record<string, Row>> = {
	Owner: { id: 0, rank: 0, live: true, slots: 0 },
	Item: { id: 0, owner: 0, code: 0, live: true, at: 0 },
	Profile: { owner: 0 },
	Seat: { owner: 0 }
}

type Value = number | boolean

/** The values a box gives each field it varies. */
const VALUES: Readonly<Record<string, Readonly<Record<string, NonEmptyReadonlyArray<Value>>>>> = {
	Owner: { id: [0, 1], rank: [0, 1], live: [true, false], slots: [0, 1] },
	Item: { owner: [0, 1], code: [0, 1], live: [true, false], at: [0, 1, 2] },
	Profile: { owner: [0, 1] },
	Seat: { owner: [0, 1] }
}

/** The natural fields' box reaches below zero, where the contract refuses, and pred is undefined. */
const NATURAL_VALUES: Readonly<
	Record<string, Readonly<Record<string, NonEmptyReadonlyArray<Value>>>>
> = { Owner: { slots: [-1, 0] }, Item: { at: [-1, 0, 1] } }

/** How many rows a box holds of each relation: at most two owners and three of every other relation. */
const ROWS: Readonly<Record<string, number>> = { Owner: 2, Item: 3, Profile: 2, Seat: 2 }

/** A relation's box: the fields it varies with their values, and how many rows it holds. */
interface RelationBox {
	readonly relation: string
	readonly varies: ReadonlyArray<readonly [field: string, values: NonEmptyReadonlyArray<Value>]>
	readonly rows: number
}

/** The fields a rule's sides and checks read, by relation. */
const readsOf = (laws: ReadonlyArray<Law>): ReadonlyMap<string, ReadonlySet<string>> => {
	const reads = new Map<string, Set<string>>()
	const add = (relation: string, fields: ReadonlyArray<string>) => {
		const of = reads.get(relation) ?? new Set<string>()
		for (const field of fields) {
			of.add(field)
		}
		reads.set(relation, of)
	}
	for (const law of laws) {
		const sides =
			law.kind === "key" ? [law.side] : law.kind === "check" ? [] : [law.left, law.right]
		for (const side of sides) {
			add(side.relation, [
				...Arr.map(side.terms, (t) => t.field),
				...(side.where._tag === "Some" ? phiFields(side.where.value) : [])
			])
		}
		if (law.kind === "check") {
			add(law.relation, phiFields(law.phi))
		}
	}
	return reads
}

/**
 * A rule's box: each relation its laws read, varying exactly the fields they read (an Owner its id besides), every
 * other field fixed; the natural-fields rule varies each natural field below zero, and mirrors over Item's ids lets a
 * Profile name any of the three.
 */
const boxOf = (r: Rule): ReadonlyArray<RelationBox> => {
	const reads =
		r.rule === "natural fields"
			? new Map([
					["Owner", new Set(["slots"])],
					["Item", new Set(["at"])]
				])
			: readsOf(lawsOf(r))
	return Arr.map([...reads], ([relation, fields]): RelationBox => {
		const domain =
			r.rule === "natural fields" ? (NATURAL_VALUES[relation] ?? {}) : (VALUES[relation] ?? {})
		const varied = relation === "Owner" ? new Set([...fields, "id"]) : fields
		return {
			relation,
			varies: Arr.flatMap([...varied], (field) => {
				const values =
					r.rule === "mirrors over a selected side" && relation === "Profile"
						? [0, 1, 2]
						: domain[field]
				return values === undefined || (field === "id" && relation === "Item")
					? []
					: [[field, nonEmpty([...values])] as const]
			}),
			rows:
				r.rule === "mirrors over a selected side" && relation === "Profile"
					? 3
					: (ROWS[relation] ?? 0)
		}
	})
}

/** Every row a box's relation may hold, each varied field at each of its values, every other at its fixed value. */
const universeOf = (box: RelationBox): ReadonlyArray<Row> =>
	Arr.reduce(box.varies, [FIXED[box.relation] ?? {}], (rows, [field, values]) =>
		Arr.flatMap(rows, (row) => Arr.map(values, (v): Row => ({ ...row, [field]: v })))
	)

/**
 * A box's rows of one relation. Item's ids are its rows' positions, so its states are the multisets of its varied
 * fields, and its last row may repeat the first's id, the primary key's breach; every other relation's states are the
 * sets of its universe's rows, an Owner's primary key breached by two rows of one id.
 */
const boxRowsGen = (box: RelationBox): Gen<ReadonlyArray<Row>> => {
	const universe = universeOf(box)
	if (box.relation !== "Item") {
		return subset(universe, { min: 0, max: box.rows })
	}
	return (source) => {
		const at = source.draw(nondecreasing(0, universe.length - 1, { min: 0, max: box.rows }))
		const repeated = at.length >= 2 && source.draw(boolean)
		return Arr.map(at, (u, i): Row => ({
			...universe[u],
			id: repeated && i === at.length - 1 ? 0 : i
		}))
	}
}

const boxStateGen =
	(boxes: ReadonlyArray<RelationBox>): Gen<State> =>
	(source) =>
		Rec.fromEntries(Arr.map(boxes, (box) => [box.relation, source.draw(boxRowsGen(box))]))

const live: Phi = { kind: "is", field: "live", value: true }
const coded: Phi = { kind: "compare", op: "gt", field: "code", value: 0 }

/** Each rule with the selections the box draws it with: a boolean field, comparisons, connectives, BETWEEN and IN. */
const BOX_RULES: NonEmptyReadonlyArray<Rule> = [
	{ rule: "a key over fields" },
	...Arr.map(
		[
			live,
			coded,
			{ kind: "and", left: live, right: coded },
			{ kind: "or", left: live, right: { kind: "compare", op: "eq", field: "code", value: 0 } },
			{ kind: "not", arg: { kind: "compare", op: "eq", field: "code", value: 1 } }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a key over a selected side", phi })
	),
	{ rule: "a key over a pred term" },
	...Arr.map(
		[
			live,
			{ kind: "compare", op: "ge", field: "at", value: 2 },
			{ kind: "in", field: "at", values: [0, 2] }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a key over a selected pred term", phi })
	),
	{ rule: "a containment" },
	{ rule: "a containment into a superkey" },
	...Arr.map(
		[
			live,
			coded,
			{ kind: "fields", op: "lt", left: "code", right: "owner" }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a containment from a selected side", phi })
	),
	...Arr.map(
		[
			live,
			{ kind: "compare", op: "gt", field: "rank", value: 0 },
			{ kind: "or", left: live, right: { kind: "compare", op: "gt", field: "rank", value: 0 } },
			{ kind: "and", left: { kind: "compare", op: "eq", field: "rank", value: 1 }, right: live }
		] satisfies ReadonlyArray<Phi>,
		(psi): Rule => ({ rule: "a containment into a selected side", psi })
	),
	...Arr.map(
		[live, { kind: "compare", op: "gt", field: "rank", value: 0 }] satisfies ReadonlyArray<Phi>,
		(psi): Rule => ({ rule: "a containment between selected sides", phi: live, psi })
	),
	{ rule: "a closure under pred" },
	...Arr.map(
		[live, { kind: "between", field: "at", low: 0, high: 1 }] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a closure under pred over a selected side", phi })
	),
	{ rule: "a cycle" },
	{ rule: "mirrors over whole relations" },
	...Arr.map([live, coded] satisfies ReadonlyArray<Phi>, (phi): Rule => ({
		rule: "mirrors over a selected side",
		phi
	})),
	...Arr.map(
		[
			coded,
			{ kind: "or", left: live, right: { kind: "compare", op: "eq", field: "code", value: 0 } },
			{ kind: "between", field: "at", low: 0, high: 1 }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a row check", phi })
	),
	{ rule: "natural fields" }
]

/** A box case: one rule, with its selections, and one state of its box. */
interface BoxCase {
	readonly rule: Rule
	readonly state: State
}

const boxGen: Gen<BoxCase> = (source) => {
	const rule = source.draw(element(BOX_RULES))
	return { rule, state: source.draw(boxStateGen(boxOf(rule))) }
}

type RuleFeature = RuleKind | Verdict

const boxLiteral = (b: BoxCase): string => `${ruleText(b.rule)}: ${Formatter.format(b.state)}`

/** The box's size, counted by the library. */
const BOX_CASES = 60_000

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
						/**
						 * A proof inside the box: every rule of the partial-projection lowering with each of its selections, over
						 * every state of at most two Owner rows and three of every other relation, each varying exactly the
						 * fields its laws read over two or three values (Item's ids its positions, its last row may repeat the
						 * first's), every other field fixed.
						 */
						limit: BOX_CASES,
						coverage: requiredInSpace<RuleFeature>([
							...RULE_KINDS,
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
						]),
						caseHang
					},
					(b, c) =>
						Effect.sync(() => {
							c.note(b.rule.rule)
							const installed = installedRules([b.rule])
							const broken = judgeState(installed, relations, b.state, c)
							judgeWrites(installed, relations, b.state, broken.size === 0, c)
						})
				)
			)
	)
})
