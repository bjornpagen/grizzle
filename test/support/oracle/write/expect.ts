import { Array as Arr, Option, Record as Rec } from "effect"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import type { ReadonlyTupleSet } from "#compiler/core/tuple-map.ts"
import type { FactIdentity } from "#compiler/scalar/values/identity.ts"
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
import { identitySetOf } from "#test/support/oracle/delta.ts"
import { elementAt, entryOf } from "#test/support/oracle/pick.ts"
import {
	evaluateSource,
	generates,
	isFact,
	isGenerated,
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
	serialColumns,
	type WContainment,
	type WGroup,
	type WRelation,
	type WriteLawNames
} from "#test/support/oracle/write/schema.ts"

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
 * - unreported: none, a foreign key's or a domain's, whose violation PostgreSQL reports only in prose.
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
			readonly refusals: AcceptableRefusals
			readonly initial: OracleState
			/** The draws a rejected change makes before its refusal may meet them too. */
			readonly collisions: ReadonlyMap<string, Collisions>
	  }
	| {
			/** A stratum that adds a value outside its domain: refused by the domain or by a law it meets first. */
			readonly kind: "outsideDomain"
			readonly domain: DomainRefusal
			readonly refusals: AcceptableRefusals
			readonly initial: OracleState
			readonly collisions: ReadonlyMap<string, Collisions>
	  }
	| {
			/**
			 * A stratum reading a parameter passed outside the field it is declared at (unboundParams): PostgreSQL refuses
			 * the value as it binds the first statement reading it, ExecutionFailure with reason ParamRejected at one such
			 * parameter, or a law of the stratum refuses a statement before it, so the initial state stays.
			 */
			readonly kind: "unbound"
			/** The names of the parameters passed outside their fields, one of which the refusal names. */
			readonly params: ReadonlySet<string>
			/** The laws of the stratum a statement before the parameter's may be refused by instead. */
			readonly refusals: AcceptableRefusals
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
	readonly generated: ReadonlyTupleSet<FactIdentity>
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

/**
 * Same-key pairs among the enumerated additions of each stratum, which host normalization refuses before any SQL, once
 * every parameter the bind reads is inside its field (unboundParams), with the key's law and a violating key, a
 * generated addition on the keys holding no serial field. Deletions are judged at no key: of two deleted facts at one
 * key at most one is stored, and the other's deletion changes nothing. At a key holding no serial field, a generated addition and a complete one that agrees
 * with it at every field it states are one fact (README: a row that leaves its serial fields out is the fact its other
 * fields state, and one a stratum both inserts and puts is the put's), as the insert's statement, after the complete
 * one's, meets that row at its arbiter and changes nothing. Each law once, its violations every stratum's.
 */
const hostRefusals = (ctx: ExpectContext, c: WChangeSet): AcceptableRefusals => {
	const clashes = Arr.flatMap(c.strata, (stratum) =>
		Arr.flatMap(ctx.group.relations, (relation) => {
			const listed = Arr.flatMap(stratum, (m) =>
				m.relation === relation.name && m.op !== "delete" && m.source.kind === "array"
					? m.source.facts
					: []
			)
			const serial = new Set(Arr.map(serialColumns(relation), (col) => col.name))
			return Arr.flatMap(keysOf(relation), (key) =>
				sameKeyViolations(
					ctx,
					relation,
					key,
					Arr.some(key.fields, (f) => serial.has(f))
						? Arr.filter(listed, (f) => !isGenerated(relation, f))
						: listed
				)
			)
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

/**
 * The key's law and its violations by the distinct facts among `added` that share a value of it, if any do: a generated
 * fact and a complete one agreeing at every field the generated one states are one fact (`hostRefusals`).
 */
const sameKeyViolations = (
	ctx: ExpectContext,
	relation: WRelation,
	key: RelationKey,
	added: ReadonlyArray<Fact>
): ReadonlyArray<readonly [LawId, Violations]> => {
	const { fields } = key
	const serial = new Set(Arr.map(serialColumns(relation), (col) => col.name))
	const stated = Arr.flatMap(relation.columns, (col) => (serial.has(col.name) ? [] : [col.name]))
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
	/** The distinct facts of one key's value: each complete one, and each generated one no complete one agrees with at
	 * every field it states. */
	const distinct = (facts: ReadonlyMap<string, Fact>): ReadonlyMap<string, Fact> => {
		const complete = Arr.filter([...facts.values()], (f) => !isGenerated(relation, f))
		return new Map(
			Arr.filter(
				[...facts],
				([, f]) =>
					!isGenerated(relation, f) ||
					!Arr.some(complete, (c) => keyOf(relation, stated, c) === keyOf(relation, stated, f))
			)
		)
	}
	const clashing = Arr.filter(
		Arr.map([...byKey], ([k, facts]) => [k, distinct(facts)] as const),
		([, facts]) => facts.size > 1
	)
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
 * The parameters a stratum's `members` pass outside the field each is declared at (domain.ts fitsField): a head
 * parameter at its target's column, a filter's at its source's column, a scope's at its relation's column, and a
 * relation parameter's facts at their relation's columns. Nothing on the host checks a parameter's pattern: PostgreSQL
 * checks it as it binds the first statement reading it, by the parameter's own pattern domain, whether or not its
 * source holds a row, after every host refusal (hostRefusals) and every statement before it.
 */
const unboundParams = (
	ctx: ExpectContext,
	members: WChangeSet["strata"][number],
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

/** The laws of `containments` a state breaks: a contained tuple naming no target fact. */
const brokenForeignKeys = (
	ctx: ExpectContext,
	containments: ReadonlyArray<WContainment>,
	state: OracleState
): ReadonlyArray<LawId> =>
	Arr.flatMap(containments, (c) => {
		const source = relationIn(ctx.group, c.from.relation)
		const target = relationIn(ctx.group, c.to.relation)
		const present = new Set(
			Arr.map([...entryOf(state.relations, target.name, "the state's relations").values()], (f) =>
				keyOf(target, c.to.fields, f)
			)
		)
		return Arr.some(
			[...entryOf(state.relations, source.name, "the state's relations").values()],
			(f) => !present.has(keyOf(source, c.from.fields, f))
		)
			? [ctx.laws.foreignKey(source.name, c.from.fields)]
			: []
	})

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
		const keys = keysOf(relation)
		const keyed = Arr.filter(serialColumns(relation), (col) =>
			Arr.some(keys, (k) => k.fields.includes(col.name))
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
		const holding = Arr.filter(keys, (k) => Arr.some(keyed, (col) => k.fields.includes(col.name)))
		out.set(relation.name, {
			constraints: new Set(
				Arr.map(holding, (k) =>
					k.kind === "primary"
						? ctx.laws.primaryKeyConstraint(relation.name)
						: ctx.laws.keyConstraint(relation.name, k.fields)
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
 * compiler: every key law and immediate foreign key the first refused stratum breaks. Laws are accepted exactly when
 * every violation query evaluated by brute force is empty where it is judged.
 *
 * Before any of these, host normalization refuses a same-key pair among the enumerated additions of any stratum, with
 * that key's law and a violating key (hostRefusals), before any SQL. A stratum reading a parameter passed outside the
 * field it is declared at is refused by PostgreSQL as it binds it, ExecutionFailure with reason ParamRejected, or by a
 * law of the stratum a statement before it meets (unboundParams). A stratum that adds a fact holding a stored value its field's domain refuses, a described member
 * reading a wider text into a narrower field, is refused there by the domain, naming the laws of the columns it types
 * in the tables its statement writes (DomainRefusal), or meets a law of the stratum first. A refused change leaves the
 * initial state.
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
	if (host.size > 0) {
		return { kind: "rejected", refusals: host, initial, collisions }
	}
	const immediate = Arr.filter(ctx.group.containments, (x) => isImmediate(ctx.group, x))
	const rejected = (refusals: ReadonlyArray<readonly [LawId, AcceptableRefusal]>): Expected => ({
		kind: "rejected",
		refusals: new Map(refusals),
		initial,
		collisions
	})
	/** The domain's refusal, or one by a law of the stratum. */
	const outsideDomain = (
		domain: DomainRefusal,
		refusals: ReadonlyArray<readonly [LawId, AcceptableRefusal]>
	): Expected => ({
		kind: "outsideDomain",
		domain,
		refusals: new Map(refusals),
		initial,
		collisions
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
		const outcome = applyAddWins(schema, initial, oracleChangeSet(ctx.group, prefix), draws)
		const outside = domainRefusal(ctx, members, c.params, state)
		const unbound = unboundParams(ctx, members, c.params)
		if (unbound.size > 0) {
			return {
				kind: "settled",
				expected: {
					kind: "unbound",
					params: unbound,
					refusals: new Map(
						outcome.kind === "invariant-rejected"
							? [
									...lawRefusals(outcome),
									...unreportedBy(brokenForeignKeys(ctx, immediate, outcome.state))
								]
							: unreportedBy(brokenForeignKeys(ctx, immediate, outcome.state))
					),
					initial,
					collisions
				}
			}
		}
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
	const deferred = brokenForeignKeys(ctx, ctx.group.containments, applied.state)
	if (deferred.length > 0) {
		return rejected(unreportedBy(deferred))
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
			generated: outcome.generated.get(target.name) ?? identitySetOf([])
		})
	}
	return out
}
