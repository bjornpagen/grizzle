import { Array as Arr, Option, Record as Rec } from "effect"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import {
	type AddWinsOutcome,
	type AppliedOutcome,
	applyAddWins,
	type Draws,
	type Fact,
	integerOf,
	type OracleState,
	oracleState,
	type SequenceState
} from "#test/support/oracle/addwins.ts"
import { elementAt, entryOf } from "#test/support/oracle/pick.ts"
import {
	evaluateSource,
	generates,
	isFact,
	isGenerated,
	oracleChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { fitsField } from "#test/support/oracle/write/domain.ts"
import { keyOf, type WFacts } from "#test/support/oracle/write/facts.ts"
import {
	columnOf,
	isImmediate,
	oracleSchemaOf,
	relationIn,
	serialColumns,
	type WContainment,
	type WGroup,
	type WRelation,
	type WriteLawNames
} from "#test/support/oracle/write/schema.ts"

/**
 * One refusal the realization may report: a law and the key values a witness may carry for it (empty for a law whose
 * violation PostgreSQL reports only in prose).
 */
export interface AcceptableRefusal {
	readonly law: LawId
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	/** Identities (keyOf over `fields`) of the key values that violate the law. */
	readonly keys: ReadonlySet<string>
	/** The violating facts those keys are taken from. */
	readonly violators: ReadonlyArray<Fact>
	/** Whether a witness may carry no key: a native violation outside the insert protocol's own rows. */
	readonly keyless: boolean
}

/**
 * The TransientFailures a lone writer of a case may meet: a generated addition into a relation draws a serial value a
 * stored fact already holds, so its insert raises a unique violation on a key holding the serial field, the attempt
 * fails with GeneratedSerialUnique, and the next attempt draws past the value. Each such stored value can fail at most
 * one attempt, since every attempt's draws advance the sequence for good. Every other TransientFailure needs a
 * concurrent transaction, which a write case has none of.
 */
export interface Collisions {
	/** The installed constraints of the keys holding a serial field, which a GeneratedSerialUnique names. */
	readonly constraints: ReadonlySet<ConstraintName>
	/** The stored serial values the sequences have not passed: how many attempts may fail. */
	readonly values: number
}

export type Expected =
	| {
			readonly kind: "applied"
			readonly outcome: AppliedOutcome
			readonly initial: OracleState
			/**
			 * `<relation>.<field>` to the identity sequence's position after the change's explicit values, which is
			 * its position after the change for a relation without generated additions.
			 */
			readonly sequences: ReadonlyMap<string, SequenceState>
			/** The relations the change makes generated additions to (see GeneratedDraws). */
			readonly draws: ReadonlyMap<string, GeneratedDraws>
			/** Per relation the change generates into, the TransientFailures its draws may meet. */
			readonly collisions: ReadonlyMap<string, Collisions>
			/**
			 * The expectation under a realization's own draws: each generated addition taking the serial values of the
			 * fact of `committed`, by relation, whose other fields it holds (the facts that realization committed for
			 * its generated additions). Which stored or removed facts the draws repeat, and with them the outcome and
			 * its counts, are the draws'.
			 */
			readonly pin: (committed: ReadonlyMap<string, ReadonlyArray<Fact>>) => Expected
	  }
	| {
			readonly kind: "rejected"
			readonly refusals: ReadonlyArray<AcceptableRefusal>
			readonly initial: OracleState
			/** The draws a rejected change makes before its refusal may meet them too. */
			readonly collisions: ReadonlyMap<string, Collisions>
	  }
	| {
			readonly kind: "outsideDomain"
			readonly refusals: ReadonlyArray<AcceptableRefusal>
			readonly initial: OracleState
			readonly collisions: ReadonlyMap<string, Collisions>
	  }
	| {
			/**
			 * A parameter passed outside the field it is declared at (unboundParams): the bind refuses the whole ChangeSet
			 * with EncodingFailure refinedValue at one such parameter's slot, before any SQL, so the initial state stays.
			 */
			readonly kind: "unbound"
			/** The names of the parameters passed outside their fields, one of which the refusal's slot names. */
			readonly params: ReadonlySet<string>
			readonly initial: OracleState
			readonly collisions: ReadonlyMap<string, Collisions>
	  }

/**
 * A relation's generated additions: its serial fields with each sequence's position before the first value drawn, and
 * the identities of the expected final state's facts the additions made. Their serial values are the calculator's
 * draws, which the realization may make otherwise (harness.ts compares them up to renaming).
 */
export interface GeneratedDraws {
	readonly fields: ReadonlyArray<{ readonly field: string; readonly before: SequenceState }>
	readonly generated: ReadonlySet<string>
}

/**
 * Whether `value` is one nextval can return from `s` onward: past last_value, or last_value itself on a sequence
 * never called.
 */
const freshPast = (s: SequenceState, value: bigint): boolean =>
	value > s.lastValue || (value === s.lastValue && !s.isCalled)

export interface ExpectContext {
	readonly group: WGroup
	readonly laws: WriteLawNames
}

/** The relation and fields of a key law or a projected key's law. */
const keyFields = (
	group: WGroup,
	relation: string,
	law: LawId,
	laws: WriteLawNames
): { readonly fields: ReadonlyArray<string>; readonly primary: boolean } => {
	const r = relationIn(group, relation)
	if (laws.primaryKey(relation) === law) {
		return { fields: r.primaryKey, primary: true }
	}
	const k = Arr.findFirst(r.keys, (x) => laws.key(relation, x) === law)
	if (Option.isSome(k)) {
		return { fields: k.value, primary: false }
	}
	const projected = Option.getOrThrowWith(
		Arr.findFirst(
			group.projectedKeys,
			(x) => x.relation === relation && laws.projectedKey(relation, x.fields).law === law
		),
		() => new Error(`${law} is no key or projected key of ${relation}`)
	)
	return { fields: projected.fields, primary: false }
}

/** Same-key pairs among the enumerated additions of each stratum, which host normalization refuses. */
const hostRefusals = (ctx: ExpectContext, c: WChangeSet): ReadonlyArray<AcceptableRefusal> =>
	Arr.flatMap(c.strata, (stratum) =>
		Arr.flatMap(ctx.group.relations, (relation) => {
			const added = Arr.flatMap(stratum, (m) =>
				m.relation === relation.name && m.op !== "delete" && m.source.kind === "array"
					? m.source.facts
					: []
			)
			const serial = new Set(Arr.map(serialColumns(relation), (col) => col.name))
			return Arr.flatMap([relation.primaryKey, ...relation.keys], (fields) =>
				sameKeyRefusals(
					ctx,
					relation,
					fields,
					Arr.some(fields, (f) => serial.has(f))
						? Arr.filter(added, (f) => !isGenerated(relation, f))
						: added
				)
			)
		})
	)

/** The refusal of the distinct facts among `added` that share a value of the key `fields`, if any do. */
const sameKeyRefusals = (
	ctx: ExpectContext,
	relation: WRelation,
	fields: ReadonlyArray<string>,
	added: ReadonlyArray<Fact>
): ReadonlyArray<AcceptableRefusal> => {
	const byKey = new Map<string, Map<string, Fact>>()
	for (const f of added) {
		const k = keyOf(relation, fields, f)
		const set = byKey.get(k) ?? new Map<string, Fact>()
		set.set(
			keyOf(
				relation,
				Arr.map(relation.columns, (col) => col.name),
				f
			),
			f
		)
		byKey.set(k, set)
	}
	const clashing = Arr.filter([...byKey], ([, facts]) => facts.size > 1)
	const keys = new Set(Arr.map(clashing, ([k]) => k))
	if (keys.size === 0) {
		return []
	}
	const law =
		fields === relation.primaryKey
			? ctx.laws.primaryKey(relation.name)
			: ctx.laws.key(relation.name, fields)
	return [
		{
			law,
			relation: relation.name,
			fields,
			keys,
			violators: Arr.flatMap(clashing, ([, facts]) => [...facts.values()]),
			keyless: false
		}
	]
}

/**
 * The parameters a ChangeSet passes outside the field each is declared at (domain.ts fitsField): a head parameter at
 * its target's column, a filter's at its source's column, a scope's at its relation's column, and a relation
 * parameter's facts at their relation's columns. The bind checks every parameter against its declared type, the
 * field's pattern included, so one outside refuses the whole ChangeSet with EncodingFailure refinedValue before any
 * SQL, whatever its stratum and whether or not its source holds a row.
 */
const unboundParams = (ctx: ExpectContext, c: WChangeSet): ReadonlySet<string> => {
	const params = c.params
	const outsideAt = (relation: WRelation, column: string, param: string): ReadonlyArray<string> =>
		fitsField(columnOf(relation, column).kind, params[param]) ? [] : [param]
	const factOutside = (relation: WRelation, fact: unknown): boolean =>
		isFact(fact) &&
		Arr.some(
			relation.columns,
			(col) => Rec.has(fact, col.name) && !fitsField(col.kind, fact[col.name])
		)
	const factsOutside = (relation: WRelation, param: string): ReadonlyArray<string> => {
		const facts = params[param]
		return Arr.isArray(facts) && Arr.some(facts, (fact) => factOutside(relation, fact))
			? [param]
			: []
	}
	return new Set(
		Arr.flatMap(c.strata, (members) =>
			Arr.flatMap(members, (m): ReadonlyArray<string> => {
				const target = relationIn(ctx.group, m.relation)
				const source = m.source
				switch (source.kind) {
					case "array":
						return []
					case "project": {
						const from = relationIn(ctx.group, source.from)
						return [
							...(source.filter === undefined
								? []
								: outsideAt(from, source.filter.column, source.filter.param)),
							...Arr.flatMap(Rec.toEntries(source.head), ([field, term]) =>
								term.kind === "param" ? outsideAt(target, field, term.param) : []
							)
						]
					}
					case "param":
						return factsOutside(target, source.param)
					case "scoped":
						return [
							...outsideAt(target, source.scope.column, source.scope.param),
							...factsOutside(target, source.exclude)
						]
					case "top":
						return factsOutside(relationIn(ctx.group, source.from), source.parents)
				}
			})
		)
	)
}

/**
 * The domain refusals of a stratum that adds a fact holding a value its field's domain refuses: the law of each column's
 * domain that a described member other than a deletion breaks, where its facts, evaluated against the state before
 * the stratum, hold a stored value read into a column whose domain refuses it (domain.ts fitsField), a wider text read
 * into a narrower one. A parameter is never one: the bind refuses a parameter outside its field first
 * (unboundParams). A domain's violation is reported by the domain PostgreSQL names, the law it enforces, with no key.
 * A deletion never breaks one: its member is carried as the comparison reads it, so an outside value matches no fact,
 * which the add-wins calculator already predicts.
 */
const domainRefusals = (
	ctx: ExpectContext,
	members: WChangeSet["strata"][number],
	params: ParamMap,
	state: OracleState
): ReadonlyArray<AcceptableRefusal> =>
	Arr.flatMap(members, (m) => {
		if (m.op === "delete" || m.source.kind !== "project") {
			return []
		}
		const target = relationIn(ctx.group, m.relation)
		const facts = evaluateSource(ctx.group, target, m.source, params, state)
		return Arr.flatMap(target.columns, (col): ReadonlyArray<AcceptableRefusal> => {
			const outside = Arr.some(facts, (fact) => !fitsField(col.kind, fact[col.name]))
			return outside
				? [
						{
							law: ctx.laws.textDomain(target.name, col.name),
							relation: target.name,
							fields: [],
							keys: new Set(),
							violators: [],
							keyless: true
						}
					]
				: []
		})
	})

/** The foreign-key violations of `containments` in a state: a contained tuple naming no target fact. */
const foreignKeyRefusals = (
	ctx: ExpectContext,
	containments: ReadonlyArray<WContainment>,
	state: OracleState
): ReadonlyArray<AcceptableRefusal> => {
	const out: Array<AcceptableRefusal> = []
	for (const c of containments) {
		const source = relationIn(ctx.group, c.from.relation)
		const target = relationIn(ctx.group, c.to.relation)
		const present = new Set(
			Arr.map([...entryOf(state.relations, target.name, "the state's relations").values()], (f) =>
				keyOf(target, c.to.fields, f)
			)
		)
		const missing = Arr.filter(
			[...entryOf(state.relations, source.name, "the state's relations").values()],
			(f) => !present.has(keyOf(source, c.from.fields, f))
		)
		if (missing.length === 0) {
			continue
		}
		out.push({
			law: ctx.laws.foreignKey(source.name, c.from.fields),
			relation: source.name,
			fields: c.from.fields,
			keys: new Set(),
			violators: [],
			keyless: true
		})
	}
	return out
}

/**
 * Per relation `c` generates into, the stored serial values its draws may meet (see Collisions): the initial facts'
 * values on a key's serial field that the field's sequence has not passed. Explicit values the change writes advance
 * the sequence past themselves before any value is drawn, so only stored ones can collide.
 */
const collisionsOf = (
	ctx: ExpectContext,
	c: WChangeSet,
	initial: OracleState
): ReadonlyMap<string, Collisions> => {
	const out = new Map<string, Collisions>()
	for (const relation of ctx.group.relations) {
		if (
			!Arr.some(c.strata, (s) =>
				Arr.some(s, (m) => m.relation === relation.name && generates(relation, m))
			)
		) {
			continue
		}
		const keys = [relation.primaryKey, ...relation.keys]
		const keyed = Arr.filter(serialColumns(relation), (col) =>
			Arr.some(keys, (k) => k.includes(col.name))
		)
		const values = Arr.reduce(keyed, 0, (n, col) => {
			const position = entryOf(initial.sequences, `${relation.name}.${col.name}`, "the sequences")
			const stored = entryOf(
				initial.relations,
				relation.name,
				"the initial state's relations"
			).values()
			const reached = Arr.filter(
				Arr.map([...stored], (fact) => integerOf(fact[col.name], col.name)),
				(v) => freshPast(position, v)
			)
			return n + new Set(reached).size
		})
		const holding = Arr.filter(keys, (k) => Arr.some(keyed, (col) => k.includes(col.name)))
		out.set(relation.name, {
			constraints: new Set(
				Arr.map(holding, (k) =>
					k === relation.primaryKey
						? ctx.laws.primaryKeyConstraint(relation.name)
						: ctx.laws.keyConstraint(relation.name, k)
				)
			),
			values
		})
	}
	return out
}

/**
 * What a generated ChangeSet must do, by definition.
 *
 * The brute-force side of the three-way write oracle, which compares db.apply, brute-force add-wins and the
 * conservative realization:
 *
 * 1. The add-wins calculator (test/support/oracle/addwins.ts) applies the strata in order, each the transition
 *    S' = (S \ D) ∪ A with put as the described deletion of its keys' occupants plus an insertion, and checks every
 *    declared key after each stratum, a projected key among them: keys are immediate, so a stratum whose
 *    transition breaks one is refused there, before any later stratum and before COMMIT.
 * 2. An immediate foreign key (a containment into a pure set, schema.ts isImmediate) is checked at every statement, and
 *    a stratum orders its statements so that a lawful transition never breaks one between them (write/frontend
 *    schedule.ts): it is judged at the end of each stratum, like a key.
 * 3. When every stratum keeps those, the group's deferred foreign keys are judged against the final state: a contained
 *    tuple with no target fact is refused at COMMIT with that law.
 *
 * A foreign key's witness carries no key, because PostgreSQL reports the key only in its message. A refusal may name
 * any law the realization can meet first, because which statement fails first is a scheduling choice left to the
 * compiler: every key law and immediate foreign key the first refused stratum breaks, and every key law a same-key
 * pair among the enumerated additions of any stratum breaks, which host normalization refuses before any SQL. Laws are
 * accepted exactly when every violation query evaluated by brute force is empty where it is judged.
 *
 * Before any of these, the bind: host normalization refuses a same-key pair among the enumerated additions first,
 * then a parameter passed outside the field it is declared at refuses the whole ChangeSet with EncodingFailure
 * refinedValue before any SQL (unboundParams). A stratum that adds a fact holding a stored value its field's domain
 * refuses, a described member reading a wider text into a narrower field, is refused there by the domain's law, or
 * meets a law of the stratum first. A refused change leaves the initial state.
 *
 * The expected result of applying `c` to `facts`, each identity sequence where `sequences` states it, and every other
 * past the stored values, where a migration that loaded them leaves it: its generated additions drawn as the add-wins
 * calculator draws them, and, applied, the same expectation under the draws a realization made (Expected's `pin`).
 */
export const expectChangeSet = (
	ctx: ExpectContext,
	facts: WFacts,
	c: WChangeSet,
	sequences: Readonly<Record<string, SequenceState>>
): Expected => expectUnder(ctx, facts, c, sequences, { kind: "sequences" })

/**
 * expectChangeSet with the generated additions taking their serial values as `draws` says (addwins.ts Draws).
 *
 * Each stratum's end, in order: the first one that adds outside a domain, or breaks a key or an immediate foreign
 * key, refuses the change.
 */
const expectUnder = (
	ctx: ExpectContext,
	facts: WFacts,
	c: WChangeSet,
	sequences: Readonly<Record<string, SequenceState>>,
	draws: Draws
): Expected => {
	const schema = oracleSchemaOf(ctx.group, ctx.laws)
	const initial = oracleState(schema, facts, sequences)
	const collisions = collisionsOf(ctx, c, initial)
	const host = hostRefusals(ctx, c)
	const immediate = Arr.filter(ctx.group.containments, (x) => isImmediate(ctx.group, x))
	const rejected = (refusals: ReadonlyArray<AcceptableRefusal>): Expected => ({
		kind: "rejected",
		refusals: [...host, ...refusals],
		initial,
		collisions
	})
	const unbound = unboundParams(ctx, c)
	if (unbound.size > 0) {
		return host.length > 0
			? rejected([])
			: { kind: "unbound", params: unbound, initial, collisions }
	}
	/** The domains' refusals lead, then the host's and the stratum's. */
	const outsideDomain = (
		domains: ReadonlyArray<AcceptableRefusal>,
		refusals: ReadonlyArray<AcceptableRefusal>
	): Expected => ({
		kind: "outsideDomain",
		refusals: [...domains, ...host, ...refusals],
		initial,
		collisions
	})
	/** The key laws a refused stratum's transition breaks, each with the key values a witness may carry for it. */
	const lawRefusals = (
		outcome: Extract<AddWinsOutcome, { readonly kind: "invariant-rejected" }>
	): ReadonlyArray<AcceptableRefusal> => {
		const byLaw = new Map<LawId, { relation: string; keys: Set<string>; violators: Array<Fact> }>()
		for (const v of outcome.violations) {
			const entry = byLaw.get(v.law) ?? {
				relation: v.relation,
				keys: new Set<string>(),
				violators: []
			}
			const { fields } = keyFields(ctx.group, v.relation, v.law, ctx.laws)
			entry.keys.add(keyOf(relationIn(ctx.group, v.relation), fields, v.values))
			entry.violators.push(v.values)
			byLaw.set(v.law, entry)
		}
		const refusals: Array<AcceptableRefusal> = []
		for (const [law, { relation, keys, violators }] of byLaw) {
			const { fields, primary } = keyFields(ctx.group, relation, law, ctx.laws)
			refusals.push({ law, relation, fields, keys, violators, keyless: !primary })
		}
		return refusals
	}
	/**
	 * The end of stratum `index`, from `state`, the last applied prefix's: the refusal it settles on, or the outcome of
	 * the prefix through it.
	 */
	const walkStratum = (
		index: number,
		members: WChangeSet["strata"][number],
		state: OracleState
	): Walk => {
		const prefix: WChangeSet = {
			...c,
			strata: [Arr.headNonEmpty(c.strata), ...c.strata.slice(1, index + 1)]
		}
		const outcome = applyAddWins(schema, initial, oracleChangeSet(ctx.group, prefix), draws)
		const outside = domainRefusals(ctx, members, c.params, state)
		if (outcome.kind === "invariant-rejected") {
			const refusals = [
				...lawRefusals(outcome),
				...foreignKeyRefusals(ctx, immediate, outcome.state)
			]
			return {
				kind: "settled",
				expected: outside.length > 0 ? outsideDomain(outside, refusals) : rejected(refusals)
			}
		}
		const broken = foreignKeyRefusals(ctx, immediate, outcome.state)
		if (outside.length > 0) {
			return { kind: "settled", expected: outsideDomain(outside, broken) }
		}
		if (broken.length > 0) {
			return { kind: "settled", expected: rejected(broken) }
		}
		return { kind: "applied", outcome }
	}
	const walked = Arr.reduce(
		Arr.tailNonEmpty(c.strata),
		walkStratum(0, Arr.headNonEmpty(c.strata), initial),
		(walk, members, i) =>
			walk.kind === "settled" ? walk : walkStratum(i + 1, members, walk.outcome.state)
	)
	if (walked.kind === "settled") {
		return walked.expected
	}
	const applied = walked.outcome
	const deferred = foreignKeyRefusals(ctx, ctx.group.containments, applied.state)
	if (deferred.length > 0) {
		return rejected(deferred)
	}
	const advanced = advancedSequences(ctx.group, c, initial, applied)
	return {
		kind: "applied",
		outcome: applied,
		initial,
		sequences: advanced,
		draws: generatedDraws(ctx.group, c, advanced, applied),
		collisions,
		pin: (committed) => expectUnder(ctx, facts, c, sequences, { kind: "given", facts: committed })
	}
}

/** A walk over a ChangeSet's strata: settled on the first refusing stratum's expectation, or applied through the last. */
type Walk =
	| { readonly kind: "settled"; readonly expected: Expected }
	| { readonly kind: "applied"; readonly outcome: AppliedOutcome }

/**
 * The identity sequences after an applied ChangeSet. Every explicit serial value an insert or a put of any stratum
 * requests advances its sequence when it is at least the next value the sequence would generate: (v, true) >
 * (last_value, is_called), so a sequence never called, whose next value is last_value itself, advances past an equal
 * explicit value (packages/engine/src/write/serial/advance.ts). The add-wins calculator advances by the same
 * comparison; the advance is computed again here on the sequence as PostgreSQL keeps it, which the harness compares. A
 * generated addition supplies no value and advances nothing; its draws follow.
 */
const advancedSequences = (
	group: WGroup,
	c: WChangeSet,
	initial: OracleState,
	outcome: AppliedOutcome
): ReadonlyMap<string, SequenceState> => {
	const out = new Map<string, SequenceState>(initial.sequences)
	/** The state before each stratum, rebuilt from the calculator's per-stratum changes. */
	let relations = new Map(initial.relations)
	for (const [i, members] of c.strata.entries()) {
		const before: OracleState = { relations, sequences: initial.sequences }
		for (const m of members) {
			if (m.op === "delete") {
				continue
			}
			const target = relationIn(group, m.relation)
			for (const fact of Arr.filter(
				evaluateSource(group, target, m.source, c.params, before),
				(f) => !isGenerated(target, f)
			)) {
				advanceExplicit(out, target, fact)
			}
		}
		const next = new Map(relations)
		for (const [name, change] of elementAt(outcome.strata, i, "the per-stratum changes")) {
			const facts = new Map(next.get(name) ?? new Map())
			for (const id of change.removed.keys()) {
				facts.delete(id)
			}
			for (const [id, fact] of change.added) {
				facts.set(id, fact)
			}
			next.set(name, facts)
		}
		relations = next
	}
	return out
}

/** Advances each identity sequence of `target` that an explicit serial value of `fact` reaches past. */
const advanceExplicit = (out: Map<string, SequenceState>, target: WRelation, fact: Fact): void => {
	for (const col of serialColumns(target)) {
		const key = `${target.name}.${col.name}`
		const v = integerOf(fact[col.name], col.name)
		if (freshPast(entryOf(out, key, "the sequences"), v)) {
			out.set(key, { lastValue: v, isCalled: true })
		}
	}
}

/**
 * The relations `c` makes generated additions to, with the sequence positions their draws start from: the positions
 * after every explicit value, since generated additions are drawn in the last stratum only (changeset.ts) and the
 * stratum's explicit values advance the sequences before any value is drawn.
 */
const generatedDraws = (
	group: WGroup,
	c: WChangeSet,
	sequences: ReadonlyMap<string, SequenceState>,
	outcome: AppliedOutcome
): ReadonlyMap<string, GeneratedDraws> => {
	const out = new Map<string, GeneratedDraws>()
	for (const m of Arr.flatten(c.strata)) {
		const target = relationIn(group, m.relation)
		if (!generates(target, m)) {
			continue
		}
		out.set(target.name, {
			fields: Arr.map(serialColumns(target), (col) => ({
				field: col.name,
				before: entryOf(sequences, `${target.name}.${col.name}`, "the sequences")
			})),
			generated: outcome.generated.get(target.name) ?? new Set()
		})
	}
	return out
}
