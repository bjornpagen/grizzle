import { Array as Arr, Option, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import {
	type AddWinsOutcome,
	type AppliedOutcome,
	applyAddWins,
	type Fact,
	type OracleState,
	oracleState
} from "#test/support/oracle/addwins.ts"
import { entryOf } from "#test/support/oracle/pick.ts"
import {
	evaluateSource,
	isFact,
	oracleChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { fitsField, narrowText } from "#test/support/oracle/write/domain.ts"
import { keyOf, type WFacts } from "#test/support/oracle/write/facts.ts"
import {
	columnOf,
	isImmediate,
	oracleSchemaOf,
	relationIn,
	type WContainment,
	type WGroup,
	type WRelation,
	type WriteLawNames
} from "#test/support/oracle/write/schema.ts"
import {
	type OrderMember,
	type OrderSchema,
	type StratumOrder,
	stratumOrder,
	unorderable
} from "#test/support/stratum-order.ts"

/** A key law's violations: its relation and fields, the facts that violate it, and their keys at its fields. */
export interface Violations {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	/** Identities (keyOf over `fields`) of the key values that violate the law. */
	readonly keys: ReadonlySet<string>
	/** The violating facts those keys are taken from. */
	readonly violators: Arr.NonEmptyReadonlyArray<Fact>
}

/**
 * The witness a realization's refusal by one law may carry:
 * - key: a violating key of the law, which host normalization and the insert protocol's own rows state;
 * - keyOrUnreported: a violating key, or none, a native violation of a candidate or projected key outside the insert
 *   protocol's own rows;
 * - unreported: none, an immediate foreign key's or a domain's, whose violation PostgreSQL reports only in prose.
 */
export type AcceptableRefusal =
	| { readonly kind: "key"; readonly violations: Violations }
	| { readonly kind: "keyOrUnreported"; readonly violations: Violations }
	| { readonly kind: "unreported" }

/** The refusals a realization may report, each law once with the one witness it may carry. */
export type AcceptableRefusals = ReadonlyMap<LawId, AcceptableRefusal>

/**
 * The laws a domain's refusal of a stratum may name, with no key (Refused): a described member adds a stored value its
 * column's domain refuses, and PostgreSQL names the domain, never the column, so the refusal names the pattern law of
 * every column the domain types in the tables its statement writes: `every` where that is one law, `some` where they
 * are several. The statement writes the target of a member that adds a refused value, and maybe the stratum's other
 * targets beside it.
 */
export interface DomainRefusal {
	/** Each relation the stratum writes, with the pattern laws of the columns the domain types in it. */
	readonly typed: ReadonlyMap<string, ReadonlyArray<LawId>>
	/** The relations a described member of the stratum adds a refused value to. */
	readonly refusing: ReadonlySet<string>
}

export type Expected =
	| {
			/**
			 * A stratum whose writes the immediate keys and foreign keys order in a cycle (`unorderableStrata`), which no
			 * order of its statements keeps: the ChangeSet is refused when it compiles (UnorderableStratum), before any of
			 * it runs.
			 */
			readonly kind: "unorderable"
			readonly strata: Arr.NonEmptyReadonlyArray<CyclicStratum>
	  }
	| {
			readonly kind: "applied"
			readonly outcome: AppliedOutcome
			readonly initial: OracleState
	  }
	| {
			readonly kind: "rejected"
			readonly refusals: AcceptableRefusals
			readonly initial: OracleState
	  }
	| {
			/** A stratum that adds a value outside its domain: refused by the domain or by a law it meets first. */
			readonly kind: "outsideDomain"
			readonly domain: DomainRefusal
			readonly refusals: AcceptableRefusals
			readonly initial: OracleState
	  }
	| {
			/**
			 * A parameter passed outside the field it is declared at, read by any stratum (unboundParams): the admission
			 * the first statement a call sends carries (write/program/admission.ts) binds every such parameter before any
			 * other placeholder of it, so PostgreSQL refuses the value there, ExecutionFailure with reason ParamRejected at
			 * one such parameter, before any statement runs and so before any law of any stratum; the initial state
			 * stays.
			 */
			readonly kind: "unbound"
			/** The names of the parameters passed outside their fields, one of which the refusal names. */
			readonly params: ReadonlySet<string>
			readonly initial: OracleState
	  }

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

/**
 * Same-key pairs among the enumerated additions of each stratum, which host normalization refuses before any SQL, so
 * before the admission refuses a parameter outside its field (unboundParams), with the key's law and a violating key.
 * Deletions are judged at no key: of two deleted facts at one key at most one is stored, and the other's deletion
 * changes nothing. Each law once, its violations every stratum's.
 */
const hostRefusals = (ctx: ExpectContext, c: WChangeSet): AcceptableRefusals => {
	const clashes = Arr.flatMap(c.strata, (stratum) =>
		Arr.flatMap(ctx.group.relations, (relation) => {
			const listed = Arr.flatMap(stratum, (m) =>
				m.relation === relation.name && m.op !== "delete" && m.source.kind === "array"
					? m.source.facts
					: []
			)
			return Arr.flatMap(keysOf(relation), (key) => sameKeyViolations(ctx, relation, key, listed))
		})
	)
	const byLaw = new Map<LawId, Violations>()
	for (const [law, violations] of clashes) {
		const held = byLaw.get(law)
		byLaw.set(
			law,
			held === undefined
				? violations
				: {
						...held,
						keys: new Set([...held.keys, ...violations.keys]),
						violators: Arr.appendAll(held.violators, violations.violators)
					}
		)
	}
	return new Map(
		Arr.map([...byLaw], ([law, violations]): readonly [LawId, AcceptableRefusal] => [
			law,
			{ kind: "key", violations }
		])
	)
}

/** A key of a relation and which it is: its primary key, or one of its candidate keys. */
type RelationKey = Readonly<{ kind: "primary" | "candidate"; fields: ReadonlyArray<string> }>

/** A relation's keys, its primary key first, each carrying which it is. */
const keysOf = (relation: WRelation): ReadonlyArray<RelationKey> => [
	{ kind: "primary", fields: relation.primaryKey },
	...Arr.map(relation.keys, (fields): RelationKey => ({ kind: "candidate", fields }))
]

/** The key's law and its violations by the distinct facts among `added` that share a value of it, if any do. */
const sameKeyViolations = (
	ctx: ExpectContext,
	relation: WRelation,
	key: RelationKey,
	added: ReadonlyArray<Fact>
): ReadonlyArray<readonly [LawId, Violations]> => {
	const { fields } = key
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
	const violators = Arr.flatMap(clashing, ([, facts]) => [...facts.values()])
	if (!Arr.isReadonlyArrayNonEmpty(violators)) {
		return []
	}
	const law =
		key.kind === "primary"
			? ctx.laws.primaryKey(relation.name)
			: ctx.laws.key(relation.name, fields)
	return [
		[
			law,
			{
				relation: relation.name,
				fields,
				keys: new Set(Arr.map(clashing, ([k]) => k)),
				violators
			}
		]
	]
}

/**
 * The parameters `members` pass outside the field each is declared at (domain.ts fitsField): a head parameter at its
 * target's column, a filter's at its source's column, a scope's at its relation's column, and a relation parameter's
 * facts at their relation's columns. Nothing on the host checks a parameter's pattern: PostgreSQL checks it by the
 * parameter's own pattern domain as it binds the admission the first statement a call sends carries
 * (write/program/admission.ts), which binds every parameter of every stratum that may hold a value outside it, whether
 * or not its source holds a row, after every host refusal (hostRefusals) and before any other placeholder of that
 * statement and any statement runs.
 */
const unboundParams = (
	ctx: ExpectContext,
	members: ReadonlyArray<WChangeSet["strata"][number][number]>,
	params: ParamMap
): ReadonlySet<string> => {
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
				case "equal":
					return Arr.flatMap(source.fields, (f) =>
						f.equaled.kind === "param" ? outsideAt(target, f.column, f.equaled.param) : []
					)
			}
		})
	)
}

/**
 * The domain refusal of a stratum (DomainRefusal), refusing where a described member other than a deletion adds facts,
 * evaluated against the state before the stratum, holding a stored value read into a column whose domain refuses it
 * (domain.ts fitsField), a wider text read into a narrower one. A parameter is never one: its own pattern domain refuses
 * it as PostgreSQL binds it (unboundParams). A deletion never adds one: its member is carried as the comparison reads
 * it, so an outside value matches no fact, which the add-wins calculator already predicts. The one domain is the
 * narrow text's (domain.ts narrowText).
 */
const domainRefusal = (
	ctx: ExpectContext,
	members: WChangeSet["strata"][number],
	params: ParamMap,
	state: OracleState
): DomainRefusal => ({
	typed: new Map(
		Arr.map(members, (m) => {
			const target = relationIn(ctx.group, m.relation)
			return [
				target.name,
				Arr.flatMap(target.columns, (col) =>
					narrowText(col.kind) ? [ctx.laws.patternLaw(target.name, col.name)] : []
				)
			] as const
		})
	),
	refusing: new Set(
		Arr.flatMap(members, (m) => {
			if (m.op === "delete" || m.source.kind !== "project") {
				return []
			}
			const target = relationIn(ctx.group, m.relation)
			const facts = evaluateSource(ctx.group, target, m.source, params, state)
			return Arr.some(target.columns, (col) =>
				Arr.some(facts, (fact) => !fitsField(col.kind, fact[col.name]))
			)
				? [target.name]
				: []
		})
	)
})

/** The refusals of laws whose violation PostgreSQL reports only in prose, each witnessed by no key. */
const unreportedBy = (
	laws: ReadonlyArray<LawId>
): ReadonlyArray<readonly [LawId, AcceptableRefusal]> =>
	Arr.map(laws, (law) => [law, { kind: "unreported" }])

/**
 * The laws of `containments` a state breaks, each with its violations: the facts of its source whose contained tuple
 * names no target fact, by their primary key.
 */
const brokenContainments = (
	ctx: ExpectContext,
	containments: ReadonlyArray<WContainment>,
	state: OracleState
): ReadonlyArray<readonly [LawId, Violations]> =>
	Arr.flatMap(containments, (c) => {
		const source = relationIn(ctx.group, c.from.relation)
		const target = relationIn(ctx.group, c.to.relation)
		const present = new Set(
			Arr.map([...entryOf(state.relations, target.name, "the state's relations").values()], (f) =>
				keyOf(target, c.to.fields, f)
			)
		)
		const violators = Arr.filter(
			[...entryOf(state.relations, source.name, "the state's relations").values()],
			(f) => !present.has(keyOf(source, c.from.fields, f))
		)
		return Arr.isReadonlyArrayNonEmpty(violators)
			? [
					[
						ctx.laws.containment(source.name, c.from.fields),
						{
							relation: source.name,
							fields: source.primaryKey,
							keys: new Set(Arr.map(violators, (f) => keyOf(source, source.primaryKey, f))),
							violators
						}
					] as const
				]
			: []
	})

/** The laws of `containments` a state breaks (brokenContainments). */
const brokenForeignKeys = (
	ctx: ExpectContext,
	containments: ReadonlyArray<WContainment>,
	state: OracleState
): ReadonlyArray<LawId> => Arr.map(brokenContainments(ctx, containments, state), ([law]) => law)

/** A stratum of a ChangeSet whose writes the keys order in a cycle: its place among the strata, and its order. */
export interface CyclicStratum {
	readonly stratum: number
	readonly order: StratumOrder
}

/**
 * A group as a stratum's order reads it (stratum-order.ts): where each relation's facts meet, at the primary key where
 * a field lies outside it, else, a pure set's, at a candidate or projected key of it, else nowhere, no key the oracle
 * draws being implied by the primary key (schema.ts resolveRelation, resolveGroup); and the immediate containments
 * (schema.ts isImmediate).
 */
const orderSchemaOf = (group: WGroup): OrderSchema => ({
	relations: Arr.map(group.relations, (r) => ({
		name: r.name,
		meeting: Arr.some(r.columns, (col) => !r.primaryKey.includes(col.name))
			? "key"
			: r.keys.length > 0 || Arr.some(group.projectedKeys, (k) => k.relation === r.name)
				? "unique"
				: "nowhere"
	})),
	references: Arr.flatMap(group.containments, (c) =>
		isImmediate(group, c) ? [{ from: c.from.relation, to: c.to.relation }] : []
	)
})

/** The strata of `c` whose writes the keys order in a cycle (`CyclicStratum`), none where every stratum orders. */
export const unorderableStrata = (group: WGroup, c: WChangeSet): ReadonlyArray<CyclicStratum> => {
	const schema = orderSchemaOf(group)
	return Arr.flatMap(c.strata, (members, stratum) => {
		const order = stratumOrder(
			schema,
			Arr.map(members, (m): OrderMember => ({ relation: m.relation, op: m.op }))
		)
		return unorderable(order) ? [{ stratum, order }] : []
	})
}

/**
 * What a generated ChangeSet must do, by definition.
 *
 * The brute-force side of the three-way write oracle, which compares db.apply, brute-force add-wins and the
 * conservative realization:
 *
 * 0. A stratum whose writes the immediate keys and foreign keys order in a cycle (`unorderableStrata`) is refused when
 *    the ChangeSet compiles (write/frontend/schedule.ts), before any of it runs.
 * 1. The add-wins calculator (test/support/oracle/addwins.ts) applies the strata in order, each the transition
 *    S' = (S \ D) ∪ A with put as the described deletion of its keys' occupants plus an insertion, and checks every
 *    declared key after each stratum, a projected key among them: keys are immediate, so a stratum whose
 *    transition breaks one is refused there, before any later stratum and before COMMIT.
 * 2. An immediate foreign key (a containment into a pure set, schema.ts isImmediate) is checked at every statement, and
 *    a stratum orders its statements so that a lawful transition never breaks one between them (write/frontend
 *    schedule.ts): it is judged at the end of each stratum, like a key.
 * 3. When every stratum keeps those, the group's deferred foreign keys are judged against the final state: a contained
 *    tuple with no target fact is refused at COMMIT with that law, witnessed by the primary key of a fact whose tuple
 *    names none, which the shell reads by the key's witness query (write/unmatched.ts) where PostgreSQL states it
 *    only in its message, the writer reading every relation whole.
 *
 * An immediate foreign key's witness carries no key, because PostgreSQL reports the key only in its message. A refusal may name
 * any law the realization can meet first, because which statement fails first is a scheduling choice left to the
 * compiler: every key law and immediate foreign key the first refused stratum breaks. Laws are accepted exactly when
 * every violation query evaluated by brute force is empty where it is judged.
 *
 * Before any of these, host normalization refuses a same-key pair among the enumerated additions of any stratum, with
 * that key's law and a violating key (hostRefusals), before any SQL. Then the admission the first statement a call
 * sends carries (write/program/admission.ts) refuses a parameter passed outside the field it is declared at, whichever
 * stratum reads it, ExecutionFailure with reason ParamRejected, as that statement is bound, before any statement runs
 * (unboundParams), so no law of any stratum answers first (README, Contracts and patterns). A stratum that adds a fact holding a
 * stored value its field's domain refuses, a described member
 * reading a wider text into a narrower field, is refused there by the domain, naming the laws of the columns it types
 * in the tables its statement writes (DomainRefusal), or meets a law of the stratum first. A refused change leaves the
 * initial state.
 *
 * The expected result of applying `c` to `facts`, or its refusal as it compiles, where a stratum's writes the keys order
 * in a cycle.
 */
export const expectChangeSet = (ctx: ExpectContext, facts: WFacts, c: WChangeSet): Expected => {
	const unorderable = unorderableStrata(ctx.group, c)
	return Arr.isReadonlyArrayNonEmpty(unorderable)
		? { kind: "unorderable", strata: unorderable }
		: expectUnder(ctx, facts, c)
}

/**
 * expectChangeSet's expectation of an orderable ChangeSet.
 *
 * The host's normalization, before any SQL; then the admission the flight's first statement a call sends carries, its
 * placeholders bound before any other (write/program/admission.ts); then each stratum's end, in order, the first one
 * that adds outside a domain, or breaks a key or an immediate foreign key, refusing the change.
 */
const expectUnder = (ctx: ExpectContext, facts: WFacts, c: WChangeSet): Expected => {
	const schema = oracleSchemaOf(ctx.group, ctx.laws)
	const initial = oracleState(schema, facts)
	const host = hostRefusals(ctx, c)
	if (host.size > 0) {
		return { kind: "rejected", refusals: host, initial }
	}
	const unbound = unboundParams(ctx, Arr.flatten(c.strata), c.params)
	if (unbound.size > 0) {
		return { kind: "unbound", params: unbound, initial }
	}
	const immediate = Arr.filter(ctx.group.containments, (x) => isImmediate(ctx.group, x))
	const rejected = (refusals: ReadonlyArray<readonly [LawId, AcceptableRefusal]>): Expected => ({
		kind: "rejected",
		refusals: new Map(refusals),
		initial
	})
	/** The domain's refusal, or one by a law of the stratum. */
	const outsideDomain = (
		domain: DomainRefusal,
		refusals: ReadonlyArray<readonly [LawId, AcceptableRefusal]>
	): Expected => ({
		kind: "outsideDomain",
		domain,
		refusals: new Map(refusals),
		initial
	})
	/**
	 * The key laws a refused stratum's transition breaks, each with its violations: a primary key's witness carries a
	 * violating key, a candidate or projected key's one or none.
	 */
	const lawRefusals = (
		outcome: Extract<AddWinsOutcome, { readonly kind: "invariant-rejected" }>
	): ReadonlyArray<readonly [LawId, AcceptableRefusal]> => {
		const byLaw = new Map<
			LawId,
			{ readonly relation: string; readonly violators: Arr.NonEmptyArray<Fact> }
		>()
		for (const v of outcome.violations) {
			const held = byLaw.get(v.law)
			if (held === undefined) {
				byLaw.set(v.law, { relation: v.relation, violators: [v.values] })
			} else {
				held.violators.push(v.values)
			}
		}
		return Arr.map(
			[...byLaw],
			([law, { relation, violators }]): readonly [LawId, AcceptableRefusal] => {
				const { fields, primary } = keyFields(ctx.group, relation, law, ctx.laws)
				const r = relationIn(ctx.group, relation)
				const violations: Violations = {
					relation,
					fields,
					keys: new Set(Arr.map(violators, (f) => keyOf(r, fields, f))),
					violators
				}
				return [
					law,
					primary ? { kind: "key", violations } : { kind: "keyOrUnreported", violations }
				]
			}
		)
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
		const outcome = applyAddWins(schema, initial, oracleChangeSet(ctx.group, prefix))
		const outside = domainRefusal(ctx, members, c.params, state)
		if (outcome.kind === "invariant-rejected") {
			const refusals = [
				...lawRefusals(outcome),
				...unreportedBy(brokenForeignKeys(ctx, immediate, outcome.state))
			]
			return {
				kind: "settled",
				expected: outside.refusing.size > 0 ? outsideDomain(outside, refusals) : rejected(refusals)
			}
		}
		const broken = unreportedBy(brokenForeignKeys(ctx, immediate, outcome.state))
		if (outside.refusing.size > 0) {
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
	const deferred = brokenContainments(ctx, ctx.group.containments, applied.state)
	if (deferred.length > 0) {
		return rejected(
			Arr.map(deferred, ([law, violations]) => [law, { kind: "key", violations }] as const)
		)
	}
	return { kind: "applied", outcome: applied, initial }
}

/** A walk over a ChangeSet's strata: settled on the first refusing stratum's expectation, or applied through the last. */
type Walk =
	| { readonly kind: "settled"; readonly expected: Expected }
	| { readonly kind: "applied"; readonly outcome: AppliedOutcome }
