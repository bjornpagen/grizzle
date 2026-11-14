import type { Case } from "@bjornpagen/testing/explore"
import type { Reached } from "@bjornpagen/testing/features"
import { array, constant, element, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import { agree } from "@bjornpagen/testing/oracle"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { type ConstraintLaws, constraintLaw } from "#compiler/ir/products.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	type HostFact,
	type HostLaw,
	type HostSchema,
	type HostState,
	expect as hostExpect,
	isSpan,
	needs,
	type HostOp,
	pinned,
	projection,
	relationOf,
	rowsDifference,
	type HostSide,
	selected,
	type Sendable,
	type SendableFact,
	sendableFact,
	stateRows,
	type HostValue,
	type Violation,
	violations
} from "#test/support/laws/model.ts"

import { defined } from "#test/support/assert.ts"
import type { ClosedField } from "#test/support/closed/stored.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import {
	type CaseSketch,
	type Domains,
	familyStepSketchGen,
	redrawStride,
	lawfulStateSketchGen,
	type OwnerView,
	ownerView,
	resolveStep,
	type StepSketch,
	stepSwarmGen,
	valuePicks,
	withSupports
} from "#test/support/laws/support.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { pickFrom, pickGen, pickIndex, pickOf, pickSpan } from "#test/support/pick.ts"
import {
	type PgErrorFields,
	pgErrorFields,
	reportedOwnerOf
} from "#test/support/substrate/errors.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { meetingOf } from "#test/support/worlds/model/session/laws.ts"

/**
 * What a direct case notes: each statement's kind, and beside it an UPDATE that moves a referred fact, a fact's
 * references or a fact into a referring side's selection (Moving); how each transaction ended, alone and with each such
 * UPDATE in it; and the schema it ran on.
 */
export type DirectFeature =
	| "statement insert"
	| "statement delete"
	| "statement update payload"
	| "statement update key"
	| Moving
	| "refused by privilege"
	| `refused at a statement by a ${HostLaw["kind"]}`
	| "refused at COMMIT"
	| "refused at COMMIT by a foreign key"
	| "committed"
	| `schema ${string}`

/**
 * An UPDATE that moves a fact other facts refer to to another key, a fact's references to other values, or a fact into
 * the selection of a side that refers (a parent into an armed handle, a source into its selector).
 */
export type Moving =
	| "statement rekey of a referred fact"
	| "statement move of a referring fact"
	| "statement selection of a referring fact"

/**
 * A transaction's UPDATE of a stored fact, in one of seven modes, named. Each mode that moves a fact has a twin, one
 * aimed at a commit and one at a refusal at COMMIT, since the suite requires both endings of each move, and draws only
 * among the moves its aim allows: of a fact of a relation that may be updated, to a key no other fact holds.
 *
 * - fields: which relation and which of its facts as the transaction stands there, which non-empty set of its fields it
 *   sets (a pick over the sets) and the picks their values come from;
 * - linked: the same, of a relation that refers, with the fields one of its references runs through set to a fact it
 *   refers to, and its selector's values (which reference, which fact);
 * - dangling: the same, with those fields set to values no fact it may refer to holds (which reference, which values);
 * - carried: which of the facts something refers to by their key moves to which key no fact of its relation holds
 *   (its target), with what refers to it moved after it, and what refers to that in turn, each to a key no fact holds;
 * - referred: the same rekey, alone, so what refers to it is left without it;
 * - selected: which fact a referring side's selector does not pick moves into it, with the facts that referred to it
 *   under the selection it leaves deleted before it and the facts it then needs inserted after it (drawn by its picks);
 * - entered: the same move into the selection, alone.
 *
 * `at` places it among the transaction's member statements.
 */
const updateModes = [
	"fields",
	"linked",
	"dangling",
	"carried",
	"referred",
	"selected",
	"entered"
] as const
type UpdateMode = (typeof updateModes)[number]
interface UpdateSketch {
	readonly mode: UpdateMode
	readonly relation: number
	readonly index: number
	readonly fields: number
	readonly values: ReadonlyArray<number>
	readonly link: number
	readonly target: number
	readonly at: number
}

interface TransactionSketch {
	readonly members: StepSketch
	readonly updates: ReadonlyArray<UpdateSketch>
}

/**
 * A direct case: which of the family's schemas it runs on, by its index among them, the steps of its initial state,
 * and its transactions, each member's op kind and fact modes as the case's step swarm chose them.
 */
export interface DirectCase {
	readonly variant: number
	readonly initial: CaseSketch
	readonly transactions: ReadonlyArray<TransactionSketch>
}

/** An UPDATE sketch whose mode `mode` draws. */
const updateSketchOf =
	(mode: Gen<UpdateMode>): Gen<UpdateSketch> =>
	(source) => ({
		mode: source.draw(mode),
		relation: source.draw(pickGen),
		index: source.draw(pickGen),
		fields: source.draw(pickGen),
		values: source.draw(array(pickGen, { min: 6, max: 6 })),
		link: source.draw(pickGen),
		target: source.draw(pickGen),
		at: source.draw(pickGen)
	})

const updateSketchGen = updateSketchOf(element(updateModes))

/**
 * A planted UPDATE, placed before the transaction's members: the first stored fact of `relation`, as the transaction
 * stands there, with the fields `set` names set to its values (the "fields" mode, its picks drawn from the domains).
 */
export const plantedUpdate = (
	host: HostSchema,
	domains: Domains,
	relation: string,
	set: Readonly<Record<string, HostValue>>
): UpdateSketch => {
	const fields = Arr.map(relationOf(host, relation).fields, (f) => f.name)
	const index = Option.getOrThrowWith(
		Arr.findFirstIndex(host.relations, (r) => r.name === relation),
		() => new Error(`no relation ${relation}`)
	)
	const drawn = Arr.filter(fields, (f) => f in set)
	const mask = Arr.reduce(fields, 0, (m, f, i) => (f in set ? m | (1 << i) : m))
	return {
		mode: "fields",
		relation: pickOf(index, host.relations.length),
		index: 0,
		fields: pickOf(mask - 1, 2 ** fields.length - 1),
		values: valuePicks(domains, relation, drawn, set),
		link: 0,
		target: 0,
		at: 0
	}
}

/** No members, or no updates: a transaction of updates alone, or of members alone. */
const none: ReadonlyArray<never> = []

/**
 * Two transactions in three update nothing: an UPDATE of an immutable relation ends its transaction at once.
 */
const updatesGen: Gen<ReadonlyArray<UpdateSketch>> = weighted([
	[2, constant(none)],
	[1, array(updateSketchGen, { min: 1, max: 3 })]
])

/**
 * Direct cases over `variants` schemas: the schema drawn evenly, so every schema of a family meets its share of the
 * cases, then the case's step swarm, then its initial state's steps and its transactions under it. A transaction's
 * members are one step's (support.ts familyStepSketchGen: drawn, filled, supported, unlinked and near), or none: a
 * transaction of updates alone.
 */
export const directCaseGen =
	(variants: number): Gen<DirectCase> =>
	(source) => {
		const variant = source.draw(int(0, variants - 1))
		const steps = source.draw(stepSwarmGen)
		const members: Gen<StepSketch> = oneOf([familyStepSketchGen(steps), constant(none)])
		const transaction: Gen<TransactionSketch> = (inner) => ({
			members: inner.draw(members),
			updates: inner.draw(updatesGen)
		})
		return {
			variant,
			initial: source.draw(lawfulStateSketchGen(steps)),
			transactions: source.draw(array(transaction, { min: 1, max: 4 }))
		}
	}

/**
 * The ending of each move a direct suite requires, with the twin mode aimed at it. A drawn case meets that mode where
 * its state holds a fact for the mode to move only now and then, so a witness plants it while the ending is pending
 * (aimedCase).
 */
const aims: ReadonlyArray<readonly [Reached<DirectFeature>, UpdateMode]> = [
	[["statement update key", "committed"], "carried"],
	[["statement rekey of a referred fact", "refused at COMMIT"], "referred"],
	[["statement move of a referring fact", "committed"], "carried"],
	[["statement move of a referring fact", "refused at COMMIT"], "dangling"],
	[["statement selection of a referring fact", "committed"], "selected"],
	[["statement selection of a referring fact", "refused at COMMIT"], "entered"]
]

/**
 * The case a witness runs: its drawn one, or, where its turn aims at the ending of a move `aims` names (Case.steering),
 * the drawn one with one more transaction, an UPDATE of the mode aimed at it alone, drawn from the case's tape.
 */
export const aimedCase = (k: DirectCase, c: Case<DirectFeature>): DirectCase => {
	const pending = Option.getOrUndefined(c.steering)
	return Option.match(
		Arr.findFirst(aims, ([situation]) => pending?.aimed(situation) === true),
		{
			onNone: () => k,
			onSome: ([, mode]) => ({
				...k,
				transactions: [
					...k.transactions,
					{ members: none, updates: [c.draw(updateSketchOf(constant(mode)))] }
				]
			})
		}
	)
}

/** A direct writer's statement, resolved against the state the transaction has reached. */
type Statement =
	| { readonly kind: "insert"; readonly relation: string; readonly fact: HostFact }
	| { readonly kind: "delete"; readonly relation: string; readonly fact: HostFact }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly from: HostFact
			readonly to: HostFact
			readonly set: ReadonlyArray<string>
	  }

/** An UPDATE among a writer's statements. */
type UpdateStatement = Extract<Statement, { readonly kind: "update" }>

/** A rekey of a referred fact, and the UPDATEs that carry what refers to it after it. */
interface Rekey {
	readonly rekey: UpdateStatement
	readonly carried: ReadonlyArray<UpdateStatement>
}

/** The element a pick selects from a list, or none from an empty one. */
const pickIn = <A>(list: ReadonlyArray<A>, pick: number): Option.Option<A> => {
	const [first, ...rest] = list
	return first === undefined ? Option.none() : Option.some(pickFrom([first, ...rest], pick))
}

const factsOf = (state: HostState, relation: string): ReadonlyArray<HostFact> =>
	state.get(relation) ?? []

const withFacts = (state: HostState, relation: string, facts: ReadonlyArray<HostFact>): HostState =>
	new Map([...state, [relation, facts]])

/**
 * The state after one statement, as PostgreSQL runs it: an INSERT adds its row whatever its key, a DELETE removes the
 * rows equal to its fact, an UPDATE replaces the row at its fact's key.
 */
const after = (host: HostSchema, state: HostState, st: Statement): HostState => {
	const relation = relationOf(host, st.relation)
	const all = Arr.map(relation.fields, (f) => f.name)
	const facts = factsOf(state, st.relation)
	switch (st.kind) {
		case "insert":
			return withFacts(state, st.relation, [...facts, st.fact])
		case "delete":
			return withFacts(
				state,
				st.relation,
				Arr.filter(facts, (f) => projection(f, all) !== projection(st.fact, all))
			)
		case "update": {
			const at = projection(st.from, relation.key)
			return withFacts(
				state,
				st.relation,
				Arr.map(facts, (f) => (projection(f, relation.key) === at ? st.to : f))
			)
		}
	}
}

/** A family step's operations as statements, each resolved against the state the earlier ones reach. */
const memberStatements = (
	host: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): ReadonlyArray<Statement> => {
	const out: Array<Statement> = []
	let reached = state
	const push = (st: Statement) => {
		out.push(st)
		reached = after(host, reached, st)
	}
	for (const op of ops) {
		for (const fact of op.facts) {
			const statements: ReadonlyArray<Statement> =
				op.kind === "put"
					? putStatements(host, reached, op.relation, fact)
					: [{ kind: op.kind, relation: op.relation, fact }]
			for (const st of statements) {
				push(st)
			}
		}
	}
	return out
}

/**
 * A put of `fact` as statements against `state`: an INSERT where no fact is at its key, and an UPDATE of its payload
 * where one is, but none where the relation has no field outside its key, whose fact at that key is `fact` itself.
 */
const putStatements = (
	host: HostSchema,
	state: HostState,
	relationName: string,
	fact: HostFact
): ReadonlyArray<Statement> => {
	const relation = relationOf(host, relationName)
	return Option.match(
		Arr.findFirst(
			factsOf(state, relationName),
			(f) => projection(f, relation.key) === projection(fact, relation.key)
		),
		{
			onNone: (): ReadonlyArray<Statement> => [{ kind: "insert", relation: relationName, fact }],
			onSome: (stored): ReadonlyArray<Statement> => {
				const set = Arr.filter(
					Arr.map(relation.fields, (f) => f.name),
					(f) => !relation.key.includes(f)
				)
				return set.length === 0
					? []
					: [{ kind: "update", relation: relationName, from: stored, to: fact, set }]
			}
		}
	)
}

/**
 * The references a fact of `relation` makes through the laws: a containment's or a coverage's side it needs a fact
 * of.
 */
const referencesOf = (
	host: HostSchema,
	relation: string
): ReadonlyArray<{ readonly from: HostSide; readonly to: HostSide }> =>
	Arr.filter(
		Arr.flatMap(host.laws, (l) => needs(l)),
		(r) => r.from.relation === relation
	)

/**
 * Every fact of `state` some fact refers to through a law (a target of its containment or coverage), with its
 * relation.
 */
const referredFacts = (
	host: HostSchema,
	state: HostState
): ReadonlyArray<{ readonly relation: string; readonly fact: HostFact }> =>
	Arr.flatMap(host.relations, (r) =>
		Arr.flatMap(factsOf(state, r.name), (fact) =>
			Arr.some(host.relations, (s) => referring(host, state, s.name, fact, r.name))
				? [{ relation: r.name, fact }]
				: []
		)
	)

/** Whether a fact of `source` in `state` refers to `fact` of `relation` through a law. */
const referring = (
	host: HostSchema,
	state: HostState,
	source: string,
	fact: HostFact,
	relation: string
): boolean =>
	Arr.some(
		referencesOf(host, source),
		(ref) =>
			ref.to.relation === relation &&
			selected(fact, ref.to.selection) &&
			Arr.some(
				factsOf(state, source),
				(g) =>
					selected(g, ref.from.selection) &&
					projection(g, ref.from.fields) === projection(fact, ref.to.fields)
			)
	)

/**
 * The UPDATEs that carry the facts of `state` referring to `fact` of `relation` to `to`, its new key: one per referring
 * fact but `fact` itself, setting every field it refers to `fact` through to the value `to` holds there. A reference
 * whose referred fields the move leaves as they were carries nothing.
 */
const carriedReferrers = (
	host: HostSchema,
	state: HostState,
	relation: string,
	fact: HostFact,
	to: HostFact
): ReadonlyArray<UpdateStatement> => {
	const key = relationOf(host, relation).key
	return Arr.flatMap(host.relations, (source) =>
		Arr.flatMap(factsOf(state, source.name), (referrer): ReadonlyArray<UpdateStatement> => {
			const refs = Arr.filter(
				referencesOf(host, source.name),
				(ref) =>
					ref.to.relation === relation &&
					selected(fact, ref.to.selection) &&
					selected(referrer, ref.from.selection) &&
					projection(referrer, ref.from.fields) === projection(fact, ref.to.fields) &&
					projection(to, ref.to.fields) !== projection(fact, ref.to.fields)
			)
			if (
				refs.length === 0 ||
				(source.name === relation && projection(referrer, key) === projection(fact, key))
			) {
				return []
			}
			const moved: Record<string, HostValue> = { ...referrer }
			for (const ref of refs) {
				for (const [i, field] of ref.from.fields.entries()) {
					const toField = defined(ref.to.fields[i], `the field ${field} pairs with`)
					moved[field] = defined(to[toField], `${relation}'s ${toField}`)
				}
			}
			return [
				{
					kind: "update",
					relation: source.name,
					from: referrer,
					to: moved,
					set: Arr.dedupe(Arr.flatMap(refs, (ref) => ref.from.fields))
				}
			]
		})
	)
}

/**
 * The UPDATEs that carry what refers to `fact` of `relation` to `to`, its new key, and what refers to each carried fact
 * whose key moves with it in turn, each fact carried once, in the order a breadth-first walk from `fact` meets them: a
 * group closed under reference, so a rekey in a cycle of references moves the whole cycle.
 */
const carriedGroup = (
	host: HostSchema,
	state: HostState,
	relation: string,
	fact: HostFact,
	to: HostFact
): ReadonlyArray<UpdateStatement> => {
	const identityOf = (r: string, f: HostFact) =>
		`${r}\u0000${projection(f, relationOf(host, r).key)}`
	const carried = new Set([identityOf(relation, fact)])
	const out: Array<UpdateStatement> = []
	const pending: Array<Pick<UpdateStatement, "relation" | "from" | "to">> = [
		{ relation, from: fact, to }
	]
	for (let moved = pending.shift(); moved !== undefined; moved = pending.shift()) {
		for (const st of carriedReferrers(host, state, moved.relation, moved.from, moved.to)) {
			if (carried.has(identityOf(st.relation, st.from))) {
				continue
			}
			carried.add(identityOf(st.relation, st.from))
			out.push(st)
			if (rekeys(host, st)) {
				pending.push(st)
			}
		}
	}
	return out
}

/**
 * The DELETEs of the facts of `state` that refer to `fact` of `relation` through a reference whose target side selects
 * `fact` but not `to`, the fact it moves to: what the move would leave without the fact they need.
 */
const strandedReferrers = (
	host: HostSchema,
	state: HostState,
	relation: string,
	fact: HostFact,
	to: HostFact
): ReadonlyArray<Statement> => {
	const key = relationOf(host, relation).key
	return Arr.flatMap(host.relations, (source) =>
		Arr.flatMap(factsOf(state, source.name), (referrer): ReadonlyArray<Statement> =>
			(source.name === relation && projection(referrer, key) === projection(fact, key)) ||
			!Arr.some(
				referencesOf(host, source.name),
				(ref) =>
					ref.to.relation === relation &&
					selected(fact, ref.to.selection) &&
					!selected(to, ref.to.selection) &&
					selected(referrer, ref.from.selection) &&
					projection(referrer, ref.from.fields) === projection(fact, ref.to.fields)
			)
				? []
				: [{ kind: "delete", relation: source.name, fact: referrer }]
		)
	)
}

/** The fact `from` with `fields` set to the values `values` picks from their domains. */
const drawnOver = (
	domains: Domains,
	relation: string,
	from: HostFact,
	fields: ReadonlyArray<string>,
	values: ReadonlyArray<number>
): Record<string, HostValue> => {
	const to: Record<string, HostValue> = { ...from }
	for (const [i, field] of fields.entries()) {
		const domain = defined(domains[relation]?.[field], `the domain of ${relation}.${field}`)
		to[field] = Option.getOrThrow(
			pickIn(domain, defined(values[i % values.length], "a value pick"))
		)
	}
	return to
}

/** Every assignment of `fields` its relation's domains draw, the last field's values varying fastest. */
const tuplesOf = (
	domains: Domains,
	relation: string,
	fields: ReadonlyArray<string>
): ReadonlyArray<HostFact> => {
	const unit: ReadonlyArray<HostFact> = [{}]
	return Arr.reduce(fields, unit, (tuples, field) =>
		Arr.flatMap(tuples, (tuple) =>
			Arr.map(
				defined(domains[relation]?.[field], `the domain of ${relation}.${field}`),
				(x): HostFact => ({ ...tuple, [field]: x })
			)
		)
	)
}

/**
 * Whether an UPDATE moves its fact as `state` lets it: its relation is mutable, and no other fact of it holds the key
 * it moves its fact to.
 */
const movesFreely = (host: HostSchema, state: HostState, st: UpdateStatement): boolean => {
	const relation = relationOf(host, st.relation)
	const own = projection(st.from, relation.key)
	const at = projection(st.to, relation.key)
	return (
		relation.mutable &&
		Arr.every(factsOf(state, st.relation), (f) => {
			const held = projection(f, relation.key)
			return held !== at || held === own
		})
	)
}

/**
 * The values an UPDATE writes to make a fact of `ref`'s referring side refer through it: the side's selector values,
 * and at the fields it refers through either the values a fact of the side it refers to holds there, as the transaction
 * stands there (linked), or values its domains draw that no such fact holds (dangling); none when there are none.
 */
const pointing = (
	domains: Domains,
	state: HostState,
	ref: { readonly from: HostSide; readonly to: HostSide },
	mode: "linked" | "dangling",
	pick: number
): Option.Option<HostFact> => {
	const referred = Arr.filter(factsOf(state, ref.to.relation), (f) => selected(f, ref.to.selection))
	const at: ReadonlyArray<HostFact> =
		mode === "linked"
			? Arr.map(referred, (target) =>
					Rec.fromEntries(
						Arr.map(ref.from.fields, (field, i) => {
							const toField = defined(ref.to.fields[i], `the field ${field} pairs with`)
							return [field, defined(target[toField], `${ref.to.relation}'s ${toField}`)] as const
						})
					)
				)
			: Arr.filter(
					tuplesOf(domains, ref.from.relation, ref.from.fields),
					(values) =>
						!Arr.some(
							referred,
							(f) => projection(f, ref.to.fields) === projection(values, ref.from.fields)
						)
				)
	return Option.map(pickIn(at, pick), (values) => ({ ...pinned(ref.from.selection), ...values }))
}

/**
 * An UPDATE sketch resolved against `state`: its UPDATE, with the UPDATEs of the facts a carried rekey moves, or the
 * DELETEs of the facts a selected fact leaves stranded and the INSERTs of what it then needs, or nothing when there is
 * no fact for it to update or no key for a rekey to move it to.
 */
const resolveUpdate = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	u: UpdateSketch
): ReadonlyArray<Statement> => {
	const mode = u.mode
	if (mode === "referred" || mode === "carried") {
		/**
		 * Each referred fact's rekeys to a key no fact of its relation holds that move what refers to it, each with the
		 * UPDATEs that carry what refers to it, every one of which moves freely.
		 */
		const movable = Arr.flatMap(referredFacts(host, state), ({ relation, fact }) => {
			const key = relationOf(host, relation).key
			const [first, ...rest] = Arr.flatMap(
				Arr.filter(
					tuplesOf(domains, relation, key),
					(destination) => projection(destination, key) !== projection(fact, key)
				),
				(destination: HostFact): ReadonlyArray<Rekey> => {
					const to = { ...fact, ...destination }
					const rekey: UpdateStatement = { kind: "update", relation, from: fact, to, set: key }
					const carried = carriedGroup(host, state, relation, fact, to)
					return Arr.isReadonlyArrayNonEmpty(carried) &&
						Arr.every([rekey, ...carried], (st) => movesFreely(host, state, st))
						? [{ rekey, carried }]
						: []
				}
			)
			return first === undefined ? [] : [[first, ...rest] as const]
		})
		return Option.match(pickIn(movable, u.index), {
			onNone: (): ReadonlyArray<Statement> => [],
			onSome: (destinations) => {
				const { rekey, carried } = pickFrom(destinations, u.target)
				return mode === "carried" ? [rekey, ...carried] : [rekey]
			}
		})
	}
	if (mode === "entered" || mode === "selected") {
		const references = Arr.flatMap(host.laws, needs)
		const unselected = Arr.flatMap(references, (ref) =>
			ref.from.selection.kind === "every" || !relationOf(host, ref.from.relation).mutable
				? []
				: Arr.map(
						Arr.filter(
							factsOf(state, ref.from.relation),
							(fact) => !selected(fact, ref.from.selection)
						),
						(fact) => ({ ref, fact })
					)
		)
		return Option.match(pickIn(unselected, u.index), {
			onNone: (): ReadonlyArray<Statement> => [],
			onSome: ({ ref, fact }) => {
				const to = { ...fact, ...pinned(ref.from.selection) }
				const update: Statement = {
					kind: "update",
					relation: ref.from.relation,
					from: fact,
					to,
					set: Rec.keys(pinned(ref.from.selection))
				}
				if (mode === "entered") {
					return [update]
				}
				const stranded = strandedReferrers(host, state, ref.from.relation, fact, to)
				const [, ...supports] = withSupports(
					host,
					domains,
					after(
						host,
						Arr.reduce(stranded, state, (s, st) => after(host, s, st)),
						update
					),
					[{ relation: ref.from.relation, fact: to }],
					(k) => Arr.map(u.values, (p, i) => (p + k * (i + 1) * redrawStride) % pickSpan)
				)
				return [
					...stranded,
					update,
					...Arr.map(supports, (w): Statement => ({
						kind: "insert",
						relation: w.relation,
						fact: w.fact
					}))
				]
			}
		})
	}
	/** A linked or dangling update moves a fact of a relation that refers and may be updated, a fields update any fact. */
	const relations =
		mode === "fields"
			? host.relations
			: Arr.filter(
					host.relations,
					(r) => r.mutable && Arr.isReadonlyArrayNonEmpty(referencesOf(host, r.name))
				)
	return Option.toArray(
		Option.flatMap(pickIn(relations, u.relation), (relation) =>
			Option.map(pickIn(factsOf(state, relation.name), u.index), (from): Statement => {
				const fields = Arr.map(relation.fields, (f) => f.name)
				/** A non-empty set of the fields, by the bits of a pick in [1, 2^n). */
				const mask = 1 + pickIndex(u.fields, 2 ** fields.length - 1)
				const drawn = Arr.flatMap(fields, (field, i) => (((mask >> i) & 1) === 1 ? [field] : []))
				const to = drawnOver(domains, relation.name, from, drawn, u.values)
				/** A linked or dangling update also writes the fields that make it refer through a picked reference. */
				const links =
					mode === "fields"
						? []
						: Arr.flatMap(
								Option.toArray(pickIn(referencesOf(host, relation.name), u.link)),
								(ref) =>
									Arr.flatMap(
										Option.toArray(pointing(domains, state, ref, mode, u.target)),
										(values) => Rec.toEntries(values)
									)
							)
				const linked: Array<string> = []
				for (const [field, x] of links) {
					to[field] = x
					linked.push(field)
				}
				return {
					kind: "update",
					relation: relation.name,
					from,
					to,
					set: Arr.filter(fields, (f) => drawn.includes(f) || linked.includes(f))
				}
			})
		)
	)
}

/**
 * A transaction's statements: its members', with each UPDATE placed among them at its own position and resolved against
 * the state the statements before it reach.
 */
const resolveTransaction = (
	host: HostSchema,
	domains: Domains,
	state: HostState,
	t: TransactionSketch
): ReadonlyArray<Statement> => {
	const members = memberStatements(host, state, resolveStep(host, domains, state, t.members))
	const slots = Arr.map(t.updates, (u) => ({ u, at: pickIndex(u.at, members.length + 1) }))
	const out: Array<Statement> = []
	let reached = state
	const push = (st: Statement): void => {
		out.push(st)
		reached = after(host, reached, st)
	}
	/** An UPDATE's statements, resolved against the state the statements before it reach. */
	const place = (u: UpdateSketch): void => {
		for (const st of resolveUpdate(host, domains, reached, u)) {
			push(st)
		}
	}
	for (let i = 0; i <= members.length; i++) {
		for (const { u } of Arr.filter(slots, (slot) => slot.at === i)) {
			place(u)
		}
		const member = members[i]
		if (member !== undefined) {
			push(member)
		}
	}
	return out
}

/**
 * The SQLSTATE a law refuses with at the statement that breaks it, or none for a law checked at COMMIT, as the one
 * classifier of where a law is met says (worlds/model/session/laws.ts meetingOf): a key, a span key and a row check at
 * once, a foreign key at once when the installation declares it immediate, and every other law at COMMIT.
 */
const immediateSqlstate = (host: HostSchema, law: HostLaw): Option.Option<string> => {
	const meeting = meetingOf(host, law)
	return meeting.at === "statement" ? Option.some(meeting.sqlstate) : Option.none()
}

/**
 * What a transaction must do: be refused at a statement, by privilege or by an immediate law, or at COMMIT by a law,
 * or commit.
 */
type Expected =
	| { readonly kind: "privilege"; readonly at: number }
	| { readonly kind: "statement"; readonly at: number; readonly laws: ReadonlyArray<HostLaw> }
	| {
			readonly kind: "commit"
			readonly violations: ReadonlyArray<Violation>
			readonly before: HostState
			readonly after: HostState
	  }
	| { readonly kind: "committed"; readonly state: HostState }

const expected = (
	host: HostSchema,
	state: HostState,
	statements: ReadonlyArray<Statement>
): Expected => {
	let reached = state
	for (const [at, st] of statements.entries()) {
		if (st.kind === "update" && !relationOf(host, st.relation).mutable) {
			return { kind: "privilege", at }
		}
		reached = after(host, reached, st)
		const broken = Arr.flatMap(violations(host, reached), (v) =>
			Arr.filter(host.laws, (l) => l.law === v.law && Option.isSome(immediateSqlstate(host, l)))
		)
		if (broken.length > 0) {
			return { kind: "statement", at, laws: broken }
		}
	}
	const all = violations(host, reached)
	return all.length > 0
		? { kind: "commit", violations: all, before: state, after: reached }
		: { kind: "committed", state: reached }
}

/** A value as a literal at its column: a closed id as its handle's code, which its column stores. */
const literal = (closed: ClosedField | undefined, x: Sendable): string => {
	if (isSpan(x)) {
		return `int4range(${x.start}, ${x.end})`
	}
	if (typeof x !== "string") {
		return String(x)
	}
	return closed === undefined ? `'${Str.replaceAll("'", "''")(x)}'` : closed.literal(x)
}

/** A statement as the direct writer sends it, on the tables and closed ids of the owner's view. */
const sqlOf = (host: HostSchema, owner: OwnerView, st: Statement): string => {
	const relation = relationOf(host, st.relation)
	const table = (name: string) => owner.table(relationOf(host, name))
	const column = (field: string): string => {
		const f = Arr.findFirst(relation.fields, (x) => x.name === field)
		if (Option.isNone(f)) {
			throw new Error(`${relation.name} has no field ${field}`)
		}
		return quoteIdent(f.value.column)
	}
	/** A fact as the writer sends it (sendableFact): a families case draws no identity value, so none holds a draw. */
	const sent = (fact: HostFact): SendableFact => {
		const named = sendableFact(fact)
		if (named === undefined) {
			throw new Error(`a ${relation.name} fact holding a draw, which no families case draws`)
		}
		return named
	}
	const spelled = (fact: SendableFact, field: string): string => {
		const x = fact[field]
		if (x === undefined) {
			throw new Error(`${relation.name} fact without ${field}`)
		}
		return literal(owner.closed(relation.name, field), x)
	}
	/** The row of `fact` at `fields`, as a WHERE matches it. */
	const row = (fact: SendableFact, fields: ReadonlyArray<string>) =>
		`(${Arr.join(Arr.map(fields, column), ", ")}) = (${Arr.join(
			Arr.map(fields, (f) => spelled(fact, f)),
			", "
		)})`
	const all = Arr.map(relation.fields, (f) => f.name)
	switch (st.kind) {
		case "insert": {
			const fact = sent(st.fact)
			return `INSERT INTO ${table(st.relation)} (${Arr.join(Arr.map(all, column), ", ")}) VALUES (${Arr.join(
				Arr.map(all, (f) => spelled(fact, f)),
				", "
			)})`
		}
		case "delete":
			return `DELETE FROM ${table(st.relation)} WHERE ${row(sent(st.fact), all)}`
		case "update": {
			const to = sent(st.to)
			return `UPDATE ${table(st.relation)} SET ${Arr.join(
				Arr.map(st.set, (f) => `${column(f)} = ${spelled(to, f)}`),
				", "
			)} WHERE ${row(sent(st.from), relation.key)}`
		}
	}
}

/** How a transaction ended: committed, or refused at a statement or at COMMIT with PostgreSQL's error fields. */
type Ended =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly fields: PgErrorFields; readonly at: RefusedAt }

/** Where a refusal was raised: at the statement of an index, or at COMMIT. */
type RefusedAt =
	| { readonly kind: "statement"; readonly index: number }
	| { readonly kind: "commit" }

/**
 * The host law a reported constraint names, if any: a native constraint's, under the table or domain PostgreSQL reports
 * it on, as the installation maps it. Every law is native (fin.md §7), so a constraint beside no owner names none.
 */
const lawOfConstraint = (
	host: HostSchema,
	laws: ConstraintLaws,
	fields: PgErrorFields
): Option.Option<HostLaw> => {
	const constraint = fields.constraint
	if (constraint === undefined) {
		return Option.none()
	}
	const owner = reportedOwnerOf(fields)
	if (owner === undefined) {
		return Option.none()
	}
	const native = constraintLaw(laws, owner, constraint)
	return Arr.findFirst(host.laws, (l) => l.law === native)
}

/**
 * A refusal judged against what the transaction must do, by its SQLSTATE, where it was raised and its constraint: the
 * feature it reached, or the first way it departs.
 */
const judgeRefusal = (
	host: HostSchema,
	laws: ConstraintLaws,
	e: Expected,
	fields: PgErrorFields,
	at: RefusedAt
): Result.Result<ReadonlyArray<DirectFeature>, string> => {
	const problem = (text: string) => Result.fail(text)
	switch (e.kind) {
		case "committed":
			return problem(`expected the transaction to commit, got ${fields.code} ${fields.message}`)
		case "privilege":
			return at.kind !== "statement" || at.index !== e.at || fields.code !== "42501"
				? problem(
						`expected 42501 at statement ${e.at}, got ${fields.code} ${fields.message} ${Formatter.format(at)}`
					)
				: Result.succeed(["refused by privilege"])
		case "statement": {
			if (at.kind !== "statement" || at.index !== e.at) {
				return problem(
					`expected a refusal at statement ${e.at}, got ${fields.code} ${Formatter.format(at)}`
				)
			}
			const law = lawOfConstraint(host, laws, fields)
			const met = Arr.findFirst(e.laws, (l) => Option.isSome(law) && l.law === law.value.law)
			if (Option.isNone(met)) {
				return problem(
					`refused by ${String(fields.constraint)}, none of ${Formatter.format(Arr.map(e.laws, (l) => l.law))}`
				)
			}
			return Option.match(immediateSqlstate(host, met.value), {
				onNone: () => problem(`${met.value.law} is no law checked at its statement`),
				onSome: (code) =>
					fields.code === code
						? Result.succeed([`refused at a statement by a ${met.value.kind}` as const])
						: problem(`${met.value.law} refused with ${fields.code}`)
			})
		}
		case "commit": {
			if (at.kind !== "commit") {
				return problem(`expected a refusal at COMMIT, got ${fields.code} ${Formatter.format(at)}`)
			}
			const raised = lawOfConstraint(host, laws, fields)
			const violation = Arr.findFirst(
				e.violations,
				(v) => Option.isSome(raised) && v.law === raised.value.law
			)
			if (Option.isNone(violation)) {
				return problem(
					`refused by ${String(fields.constraint)}, none of ${Formatter.format(e.violations)}`
				)
			}
			return fields.code === "23503"
				? Result.succeed(["refused at COMMIT by a foreign key"])
				: problem(`${violation.value.law} refused at COMMIT with ${fields.code}`)
		}
	}
}

/** Whether a statement is an UPDATE that moves its fact to another key. */
const rekeys = (host: HostSchema, st: Statement): boolean => {
	if (st.kind !== "update") {
		return false
	}
	const key = relationOf(host, st.relation).key
	return projection(st.from, key) !== projection(st.to, key)
}

/**
 * Each statement's features, judged on the state before it: its kind, and for an UPDATE whether it moves a fact some
 * fact refers to to another key, or a referring fact's references to other values.
 */
const statementFeatures = (
	host: HostSchema,
	state: HostState,
	statements: ReadonlyArray<Statement>
): ReadonlyArray<DirectFeature> => {
	const out: Array<DirectFeature> = []
	let reached = state
	for (const st of statements) {
		const features: ReadonlyArray<DirectFeature> =
			st.kind === "update" ? updateFeatures(host, reached, st) : [`statement ${st.kind}`]
		appendAll(out, features)
		reached = after(host, reached, st)
	}
	return out
}

/**
 * An UPDATE's features on the state before it: whether it moves a fact some fact refers to to another key, or a
 * referring fact's references to other values or into a selection.
 */
const updateFeatures = (
	host: HostSchema,
	state: HostState,
	st: UpdateStatement
): ReadonlyArray<DirectFeature> => {
	const refs = referencesOf(host, st.relation)
	const moves = Arr.some(
		refs,
		(ref) =>
			selected(st.from, ref.from.selection) &&
			projection(st.from, ref.from.fields) !== projection(st.to, ref.from.fields)
	)
	const selects = Arr.some(
		refs,
		(ref) => !selected(st.from, ref.from.selection) && selected(st.to, ref.from.selection)
	)
	return [
		rekeys(host, st) ? "statement update key" : "statement update payload",
		...(rekeys(host, st) &&
		Arr.some(host.relations, (r) => referring(host, state, r.name, st.from, st.relation))
			? ["statement rekey of a referred fact" as const]
			: []),
		...(moves ? ["statement move of a referring fact" as const] : []),
		...(selects ? ["statement selection of a referring fact" as const] : [])
	]
}

const isMoving = (f: DirectFeature): f is Moving =>
	f === "statement rekey of a referred fact" ||
	f === "statement move of a referring fact" ||
	f === "statement selection of a referring fact"

/**
 * Runs a SERIALIZABLE transaction's statements, each logged: the first failing statement ends it with a ROLLBACK,
 * and otherwise COMMIT ends it. A failure that is no server error is a defect of the harness.
 */
/** How a transaction settled as the model judges it: committed to the state it reaches, or refused as expected. */
type Settled =
	| { readonly kind: "committed"; readonly state: HostState }
	| {
			readonly kind: "refused"
			readonly ends: ReadonlyArray<DirectFeature>
			readonly atCommit: boolean
	  }

/** A transaction's outcome judged against the expectation: how it settled, or the problem. */
const settled = (
	host: HostSchema,
	laws: ConstraintLaws,
	e: Expected,
	outcome: Ended
): Result.Result<Settled, string> => {
	if (outcome.kind === "committed") {
		return e.kind === "committed"
			? Result.succeed({ kind: "committed", state: e.state })
			: Result.fail(`expected ${Formatter.format(e)}, but the transaction committed`)
	}
	return Result.map(judgeRefusal(host, laws, e, outcome.fields, outcome.at), (ends): Settled => ({
		kind: "refused",
		ends,
		atCommit: outcome.at.kind === "commit"
	}))
}

const refused = (error: unknown, at: RefusedAt): Effect.Effect<Ended> => {
	const fields = pgErrorFields(error)
	return fields === undefined ? Effect.die(error) : Effect.succeed({ kind: "refused", fields, at })
}

const runTransaction = (
	writer: RawSession,
	statements: ReadonlyArray<string>,
	log: Array<string>
): Effect.Effect<Ended> =>
	Effect.gen(function* () {
		yield* Effect.orDie(writer.begin)
		for (const [index, sql] of statements.entries()) {
			log.push(sql)
			const ran = yield* Effect.result(writer.query(sql, []))
			if (Result.isFailure(ran)) {
				yield* Effect.orDie(writer.rollback)
				return yield* refused(ran.failure, { kind: "statement", index })
			}
		}
		log.push("COMMIT")
		const committed = yield* Effect.result(writer.commit)
		return Result.isFailure(committed)
			? yield* refused(committed.failure, { kind: "commit" })
			: { kind: "committed" }
	})

/**
 * The lawful state a case starts from: its initial steps, each resolved on the host and kept when the host accepts it.
 */
const initialState = (host: HostSchema, domains: Domains, sketch: CaseSketch): HostState => {
	let state: HostState = new Map(Arr.map(host.relations, (r) => [r.name, []]))
	for (const step of sketch) {
		const e = hostExpect(host, state, resolveStep(host, domains, state, step))
		if (e.kind === "accepted" || e.kind === "no-change") {
			state = e.state
		}
	}
	return state
}

/**
 * A direct SQL writer over the law-bearing families: a direct SQL writer needs nothing extra to keep the laws.
 *
 * A case of a family's schema starts from a lawful state, drawn as a short family case whose steps the host accepts,
 * most of them storing lawful referring groups or facts a referring side's selection does not pick (support.ts
 * lawfulStateSketchGen), and loaded as the owner, and runs up to four transactions as `direct`, the identity every
 * family grants its writes, each SERIALIZABLE and each a list of single-row statements:
 *
 * - an INSERT of a fact, a DELETE of a stored fact by its whole row, and an UPDATE of a stored fact's payload by its key,
 *   from a family step's members (support.ts resolveStep: drawn, stored, linked and sibling facts, filled groups,
 *   supported groups and the deletion of a needed fact, a put being the UPDATE of its payload, or the INSERT of a fact
 *   no stored fact holds the key of);
 * - an UPDATE of a stored fact by its key that sets a drawn set of its fields, its key's and its references' among
 *   them, to drawn values; or links it (the fields a law refers through set to a fact the law refers to, as the
 *   transaction stands there, with the law's selector values); or moves a fact some fact refers to to another key,
 *   alone or with the facts that refer to it carried after it; or moves a fact into a referring side's selection,
 *   deleting what needed it where it stood before it and inserting what it then needs after it. So a direct writer
 *   rekeys a parent, moves a child to another parent and flips a selector, which no ChangeSet grizzle writes does. The
 *   rekey of a referred fact, alone and carried, and the supported selection are modes of their own, since a drawn set
 *   of fields rarely makes any of them.
 *
 * The host model (model.ts) judges each statement on the state the transaction has reached:
 *
 * - an UPDATE of an immutable relation is refused by privilege, 42501, at the statement (immutability is privilege);
 * - a statement whose state breaks an immediate law is refused at the statement under the constraint of one of the
 *   broken laws, on the table a native law's identity names, under the name it names (`<table>.<constraint>`): a key
 *   23505, a span key 23P01, a row check 23514, a foreign key the installation declares immediate 23503 (meetingOf);
 * - otherwise COMMIT fails exactly when the final state breaks a law: a foreign key, a containment's or a coverage's,
 *   with 23503 under the constraint of one of the broken laws;
 * - a refused transaction leaves the state it started from, a committed one the host's final state, read as the owner.
 *
 * Runs one direct case on an installation from its initial state, its writer in `direct`, the world of the schema's
 * direct writers; the first departure fails it with the transactions' log. Each statement's kind is noted, and each
 * transaction's ending through `ended`.
 */
export const runDirect = (
	installed: Installed,
	direct: SubstrateWorld,
	host: HostSchema,
	domains: Domains,
	k: DirectCase,
	c: Case<DirectFeature>,
	ended: (f: DirectFeature) => void
): Effect.Effect<void, CaseFailed, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const s = yield* Substrate
			const owner = yield* ownerView(host, installed)
			let state = initialState(host, domains, k.initial)
			yield* Effect.orDie(
				transaction(s.admin, [
					`TRUNCATE ${Arr.join(
						Arr.map(host.relations, (r) => owner.table(r)),
						", "
					)}`,
					...Arr.flatMap(host.relations, (r) =>
						Arr.map(factsOf(state, r.name), (f) =>
							sqlOf(host, owner, { kind: "insert", relation: r.name, fact: f })
						)
					)
				])
			)
			const writer: RawSession = yield* Effect.orDie(
				s.session({ ...worldSession(direct), label: "direct" })
			)
			const log: Array<string> = [`initial ${Formatter.format(stateRows(host, state))}`]
			const fail = (problem: string) =>
				new CaseFailed({ report: `${Arr.join(log, "\n  ")}\n  ${problem}` })
			/** Notes how a transaction settled: what it ended in, and what its moves and rekeys met. */
			const noteSettled = (
				v: Settled,
				statements: ReadonlyArray<Statement>,
				moving: ReadonlyArray<Moving>
			): void => {
				switch (v.kind) {
					case "committed":
						ended("committed")
						if (Arr.some(statements, (st) => rekeys(host, st))) {
							c.pair("statement update key", "committed")
						}
						for (const m of moving) {
							c.pair(m, "committed")
						}
						return
					case "refused":
						for (const f of v.ends) {
							ended(f)
						}
						if (v.atCommit) {
							c.note("refused at COMMIT")
						}
						for (const m of v.atCommit ? moving : []) {
							c.pair(m, "refused at COMMIT")
						}
				}
			}
			for (const t of k.transactions) {
				const statements = resolveTransaction(host, domains, state, t)
				const e = expected(host, state, statements)
				const reached = statementFeatures(host, state, statements)
				c.noteAll(reached)
				const moving = Arr.filter(reached, isMoving)
				const outcome = yield* runTransaction(
					writer,
					Arr.map(statements, (st) => sqlOf(host, owner, st)),
					log
				)
				log.push(
					`  expected ${e.kind}, got ${outcome.kind === "committed" ? "committed" : `${outcome.fields.code} ${Formatter.format(outcome.at)}`}`
				)
				const verdict = settled(host, installed.installation.constraintToLaw, e, outcome)
				if (Result.isFailure(verdict)) {
					return yield* fail(verdict.failure)
				}
				noteSettled(verdict.success, statements, moving)
				if (verdict.success.kind === "committed") {
					state = verdict.success.state
				}
				const stored = yield* Effect.orDie(owner.read)
				const hosted = stateRows(host, state)
				yield* Effect.mapError(
					agree(
						[
							["postgresql", stored],
							["host", hosted]
						],
						rowsDifference
					),
					(disagreement) =>
						fail(
							`${disagreement.message}\n  postgresql: ${Formatter.format(stored)}\n  host: ${Formatter.format(hosted)}`
						)
				)
			}
		})
	)
