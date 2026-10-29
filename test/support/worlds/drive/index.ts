import type { Case } from "@grizzle/testing/explore"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Predicate,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { sameValues, valueText } from "#test/pg/laws/families/model.ts"
import type { RealWorld } from "#test/support/worlds/execute/index.ts"
import { featuresOf } from "#test/support/worlds/features.ts"
import { invalidKindsOf } from "#test/support/worlds/generate/classify.ts"
import { invariantsOf } from "#test/support/worlds/model/invariants.ts"
import { driftOf } from "#test/support/worlds/model/session/catalog.ts"
import { loginGone, sessionAt } from "#test/support/worlds/model/session/state.ts"
import {
	adoptStored,
	expectedProbe,
	hiddenTokens,
	observedNext,
	settle,
	step
} from "#test/support/worlds/model/step.ts"

import type {
	Action,
	ClaimsSetting,
	Defect,
	DirectStatement,
	EntryOp,
	HostFact,
	ModelState,
	Observation,
	Outcome,
	Probe,
	Token,
	ViewFilter,
	WorldFeature
} from "#test/support/worlds/model/types.ts"

const ProbeSchema = Schema.Union([
	Schema.Struct({ transaction: Schema.Literal("aborted") }),
	Schema.Struct({
		transaction: Schema.Literals(["idle", "in-transaction"]),
		currentUser: Schema.String,
		claims: Schema.String
	})
])

const InvariantSchema = Schema.Struct({
	invariant: Schema.Literals([
		"laws-hold",
		"no-hidden-value",
		"claims-end-with-transaction",
		"role-ends-with-transaction",
		"login-isolation",
		"deleted-means-gone",
		"least-privilege"
	]),
	detail: Schema.String
})

/** A relation whose stored facts differ from the model's: the model's facts it lacks, and the facts it holds besides. */
const StoredSchema = Schema.Struct({
	relation: Schema.String,
	missing: Schema.Array(Schema.String),
	extra: Schema.Array(Schema.String)
})

/** Where a program and the model parted: the state a program starts from, or the action at an index of the program. */
const WhereSchema = Schema.Union([
	Schema.TaggedStruct("start", {}),
	Schema.TaggedStruct("step", { index: Schema.Int, action: Schema.String })
])

/**
 * How the real system left the model: an observation no branch of the action allows (the allowed ones and the
 * observed one, as Formatter prints them), a value hidden from the acting session in what grizzle answered, the two
 * artifacts of one read answering differently, a session
 * whose connection is not in the state the model claims, a model state that breaks an invariant, or stored facts other
 * than the model's.
 */
const DivergenceSchema = Schema.Union([
	Schema.TaggedStruct("observation", {
		allowed: Schema.Array(Schema.String),
		observed: Schema.String,
		because: Schema.Array(Schema.String)
	}),
	Schema.TaggedStruct("leak", {
		field: Schema.Literals(["message", "detail", "hint", "where", "notice", "witness"]),
		token: Schema.String
	}),
	Schema.TaggedStruct("artifacts", {}),
	Schema.TaggedStruct("probe", {
		session: Schema.Int,
		expected: ProbeSchema,
		observed: ProbeSchema
	}),
	Schema.TaggedStruct("invariant", { violations: Schema.NonEmptyArray(InvariantSchema) }),
	Schema.TaggedStruct("stored", { relations: Schema.NonEmptyArray(StoredSchema) })
])

type Divergence = typeof DivergenceSchema.Type
type Where = typeof WhereSchema.Type
type StoredDivergence = typeof StoredSchema.Type

const whereText = (where: Where): string =>
	where._tag === "start" ? "the program's start state" : `action ${where.index} (${where.action})`

const listed = (texts: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(texts) ? Arr.join(texts, ", ") : "nothing"

const divergenceText = (d: Divergence): string => {
	switch (d._tag) {
		case "observation":
			return `observed ${d.observed}${Arr.isReadonlyArrayNonEmpty(d.because) ? ` (${Arr.join(d.because, "; ")})` : ""}, but the model allows only ${Arr.join(d.allowed, " | ")}`
		case "leak":
			return `the ${d.field} carries ${d.token}, a value hidden from the acting session`
		case "artifacts":
			return "the optimized and the conservative artifact of one read answered differently"
		case "probe":
			return `session ${d.session} probes ${Formatter.format(d.observed)}, but the model claims ${Formatter.format(d.expected)}`
		case "invariant":
			return `the model's state breaks ${Arr.join(
				Arr.map(d.violations, (v) => `${v.invariant} (${v.detail})`),
				", "
			)}`
		case "stored":
			return Arr.join(
				Arr.map(
					d.relations,
					(r) =>
						`${r.relation} as stored lacks ${listed(r.missing)} and holds besides ${listed(r.extra)}`
				),
				"; "
			)
	}
}

/**
 * The real world left the worlds model: at the program's start or at one of its actions, the real system answered
 * what no branch of the model allows, showed a hidden value, stored other facts or entered another session state than
 * the model claims, or the model's own state broke an invariant. Its message states the divergence.
 */
export class ModelMismatch extends Schema.TaggedError<
	ModelMismatch,
	{ readonly brand: unique symbol }
>()("ModelMismatch", { where: WhereSchema, divergence: DivergenceSchema }) {
	override get message(): string {
		return `the real world left the worlds model at ${whereText(this.where)}: ${divergenceText(this.divergence)}`
	}
}

/** Whether an action names a session that sends no statement of its own: the direct holder, or a session not a Db's. */
const quietSession = (state: ModelState, holder: number, session: number): boolean =>
	session === holder || state.sessions[session]?.kind !== "db"

/**
 * Whether a serial driver can perform `action` in `state` without waiting on another session's transaction. A direct
 * session holds its transaction, and every lock its statements took, from its direct-begin to its direct-end; while it
 * does, the only actions that never wait behind it are its own, catalog reads (opening a Db, a drift with nothing
 * pending: one that resumes pending folders is a migration), a Db's read
 * (SERIALIZABLE snapshots never wait on row locks), a close, and any action on a session that sends no statement. A
 * write, a refresh, a migration, a catalog change or a second direct transaction could wait on the holder's locks,
 * which only a concurrent driver resolves.
 */
export const serial = (state: ModelState, action: Action): boolean =>
	Option.match(
		Arr.findFirstIndex(state.sessions, (s) => s.kind === "direct"),
		{
			onNone: () => true,
			onSome: (holder) => {
				switch (action.kind) {
					case "open-db":
					case "read":
					case "close":
					case "direct":
					case "direct-end":
						return true
					case "drift":
						return state.migrations.kind === "applied"
					case "apply":
					case "refresh":
					case "interrupt":
						return quietSession(state, holder, action.session)
					case "wild":
						return (
							action.at.kind !== "session" ||
							action.at.call === "read" ||
							quietSession(state, holder, action.at.session)
						)
					case "direct-begin":
					case "migrate":
					case "tamper":
						return false
				}
			}
		}
	)

/**
 * Whether a program may go on with `action` in `state`: a serial driver can perform it (`serial`), and the catalog is
 * still within the contract. A tamper that changed what a world can do (a policy, a grant, row security, a membership,
 * an attribute, a setting: one drift reports) puts every later call outside the README's contract, so a program goes
 * on only by opening a Db, which admission refuses, or by asking drift.
 */
const drivable = (state: ModelState, action: Action): boolean =>
	serial(state, action) &&
	(!Arr.isReadonlyArrayNonEmpty(driftOf(state.install, state.tampered)) ||
		action.kind === "open-db" ||
		action.kind === "drift")

const factTexts = (fact: HostFact): ReadonlyArray<string> => Arr.map(Rec.values(fact), valueText)

/** Every primitive a value of a token's payload holds, as text, however deep. */
const payloadTexts = (value: unknown): ReadonlyArray<string> => {
	if (Predicate.isString(value)) {
		return [value]
	}
	if (Predicate.isNumber(value) || Predicate.isBigInt(value) || Predicate.isBoolean(value)) {
		return [String(value)]
	}
	if (Arr.isArray(value)) {
		return Arr.flatMap(value, payloadTexts)
	}
	if (Predicate.isReadonlyObject(value)) {
		return Arr.flatMap(Reflect.ownKeys(value), (key) => payloadTexts(value[key]))
	}
	return []
}

const tokenTexts = (token: Token): ReadonlyArray<string> => {
	switch (token.kind) {
		case "none":
			return []
		case "live":
		case "stale":
			return payloadTexts(token.payload)
		case "wild":
			return [token.text]
	}
}

const claimsTexts = (setting: ClaimsSetting): ReadonlyArray<string> => {
	switch (setting.kind) {
		case "facts":
			return Arr.flatMap(Rec.values(setting.facts), factTexts)
		case "malformed":
			return [setting.text]
	}
}

const filterTexts = (filter: ViewFilter): ReadonlyArray<string> =>
	filter.kind === "raise-on" ? [valueText(filter.value)] : []

const statementTexts = (statement: DirectStatement): ReadonlyArray<string> => {
	switch (statement.kind) {
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "truncate":
		case "prepare":
		case "execute-prepared":
			return []
		case "set-claims":
			return claimsTexts(statement.setting)
		case "select-view":
		case "select-table":
			return filterTexts(statement.filter)
		case "insert":
		case "insert-on-conflict":
			return factTexts(statement.fact)
		case "merge-delete":
			return Arr.flatMap(statement.keys, factTexts)
		case "delete":
			return factTexts(statement.key)
		case "update":
			return [...factTexts(statement.key), ...factTexts(statement.set)]
		case "call":
			return Arr.map(statement.args, valueText)
		case "setval":
			return [String(statement.value)]
	}
}

const opTexts = (op: EntryOp): ReadonlyArray<string> => Arr.flatMap(op.facts, factTexts)

/**
 * What an action hands the real system that could name a fact: its token's payload, the facts and keys it writes, the
 * claims it sets and the arguments it passes. An error may quote what its statement submitted, so a token among them
 * is no leak.
 */
export const submittedTexts = (action: Action): ReadonlyArray<string> => {
	switch (action.kind) {
		case "open-db":
			return tokenTexts(action.token)
		case "apply":
			return Arr.flatMap(action.strata, (stratum) => Arr.flatMap(stratum, opTexts))
		case "direct":
			return statementTexts(action.statement)
		case "read":
		case "refresh":
		case "close":
		case "direct-begin":
		case "direct-end":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return []
	}
}

/** Who an action acts as: a session (one the model holds, or the one an open would mint), or the owner. */
type Acting = { readonly kind: "session"; readonly session: number } | { readonly kind: "owner" }

const actingOf = (state: ModelState, action: Action): Acting => {
	switch (action.kind) {
		case "read":
		case "apply":
		case "refresh":
		case "close":
		case "direct":
		case "direct-end":
		case "interrupt":
			return { kind: "session", session: action.session }
		case "wild":
			return {
				kind: "session",
				session: action.at.kind === "session" ? action.at.session : state.sessions.length
			}
		case "open-db":
		case "direct-begin":
			return { kind: "session", session: state.sessions.length }
		case "migrate":
		case "tamper":
		case "drift":
			return { kind: "owner" }
	}
}

/**
 * What a direct session's transaction sent before an action on it, every statement of it: a refusal at its COMMIT
 * judges them, and may quote what they were given. A Db's session sends nothing between its calls.
 */
const sentTexts = (state: ModelState, session: number): ReadonlyArray<string> => {
	const held = sessionAt(state, session)
	return held?.kind === "direct" ? Arr.flatMap(held.sent, statementTexts) : []
}

/**
 * The tokens hidden from whoever an action acts as, less those the action submits and, on a direct session, those its
 * transaction sent before it. An action on a session is judged against that session's world; an open, or a wild value
 * handed where a session is opened, against the session it would open, which sees nothing before it opens (the model
 * hides every token of reality from a session not yet in its state); a migration, a catalog change and drift act as the
 * owner, who sees everything.
 */
const hiddenFor = (state: ModelState, action: Action): ReadonlySet<string> => {
	const acting = actingOf(state, action)
	switch (acting.kind) {
		case "owner":
			return new Set()
		case "session": {
			const submitted = [...submittedTexts(action), ...sentTexts(state, acting.session)]
			return new Set(
				Arr.filter(
					[...hiddenTokens(state, acting.session)],
					(token) => !Arr.some(submitted, Str.includes(token))
				)
			)
		}
	}
}

const sameProbe = (expected: Probe, observed: Probe): boolean =>
	expected.transaction === "aborted"
		? observed.transaction === "aborted"
		: observed.transaction !== "aborted" &&
			expected.transaction === observed.transaction &&
			expected.currentUser === observed.currentUser &&
			expected.claims === observed.claims

/** The facts of `of` that `among` lacks, compared field by field as PostgreSQL spells their values. */
const lacking = (
	of: ReadonlyArray<HostFact>,
	among: ReadonlyArray<HostFact>
): ReadonlyArray<HostFact> =>
	Arr.filter(of, (fact) => !Arr.some(among, (other) => sameValues(fact, other)))

/** Every relation whose stored facts differ from the model's, as sets, with what each side lacks. */
const storedDivergences = (
	relations: ReadonlyArray<string>,
	modelled: (relation: string) => ReadonlyArray<HostFact>,
	stored: (relation: string) => ReadonlyArray<HostFact>
): ReadonlyArray<StoredDivergence> =>
	Arr.flatMap(relations, (relation) => {
		const model = modelled(relation)
		const real = stored(relation)
		const missing = lacking(model, real)
		const extra = lacking(real, model)
		return Arr.isReadonlyArrayNonEmpty(missing) || Arr.isReadonlyArrayNonEmpty(extra)
			? [
					{
						relation,
						missing: Arr.map(missing, (f) => Formatter.format(f)),
						extra: Arr.map(extra, (f) => Formatter.format(f))
					}
				]
			: []
	})

/**
 * Checks that the real system is in the state the model claims (Turso's step 5), and returns the model's state with
 * the serial values PostgreSQL drew adopted (the model predicts no identity draw): the model's state keeps every
 * invariant; every base relation and every derived relation, read as the owner, holds exactly the model's facts; and
 * every session the model holds open probes exactly as the model expects of it.
 */
const checkState = (
	world: RealWorld,
	state: ModelState,
	where: Where
): Effect.Effect<ModelState, ModelMismatch> =>
	Effect.gen(function* () {
		const violations = invariantsOf(state)
		if (Arr.isReadonlyArrayNonEmpty(violations)) {
			return yield* ModelMismatch.make({ where, divergence: { _tag: "invariant", violations } })
		}
		const stored = yield* Effect.orDie(world.stored)
		const adopted = adoptStored(state, stored)
		const differing = [
			...storedDivergences(
				Arr.map(state.install.base.relations, (r) => r.name),
				(relation) => adopted.reality.get(relation) ?? [],
				(relation) => stored.reality.get(relation) ?? []
			),
			...storedDivergences(
				Arr.map(state.install.base.derived, (d) => d.name),
				(relation) => adopted.derived[relation] ?? [],
				(relation) => stored.derived[relation] ?? []
			)
		]
		if (Arr.isReadonlyArrayNonEmpty(differing)) {
			return yield* ModelMismatch.make({
				where,
				divergence: { _tag: "stored", relations: differing }
			})
		}
		for (const [session, held] of adopted.sessions.entries()) {
			if (held.kind === "closed" || (held.kind === "db" && loginGone(adopted, held))) {
				continue
			}
			const expected = expectedProbe(adopted, session)
			const observed = yield* world.probe(session)
			if (!sameProbe(expected, observed)) {
				return yield* ModelMismatch.make({
					where,
					divergence: { _tag: "probe", session, expected, observed }
				})
			}
		}
		return adopted
	})

/**
 * Checks that the real system is in the state a program starts from (checkState), and returns that state with the
 * stored serial values adopted.
 */
export const checkStart = (
	world: RealWorld,
	start: ModelState
): Effect.Effect<ModelState, ModelMismatch> => checkState(world, start, { _tag: "start" })

/** Whether the real system answered with a defect: what no branch of the model can ever allow. */
const isDefect = (observed: Observation): observed is Defect =>
	observed.kind === "leak" || observed.kind === "artifacts-disagree"

const defectDivergence = (defect: Defect): Divergence => {
	switch (defect.kind) {
		case "leak":
			return { _tag: "leak", field: defect.field, token: defect.token }
		case "artifacts-disagree":
			return { _tag: "artifacts" }
	}
}

/**
 * One action performed: what the real system answered, the index of the branch nature chose among the action's, and
 * the state the model enters.
 */
export interface Stepped {
	readonly observation: Outcome
	readonly branch: number
	readonly next: ModelState
}

/**
 * Every feature the driver notes of an action's outcome in the state it ran in: the invalid kinds its inputs are, and
 * the feature map's features of it. A suite aims its draws at its required features through this reading.
 */
export const notedOf = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<WorldFeature> => [
	...Arr.map(invalidKindsOf(state, action), (kind): WorldFeature => `invalid:${kind}`),
	...featuresOf(state, action, observation)
]

/**
 * Performs one action on the real world and returns the model's branch nature chose: the model allows the action's
 * branches; the real system performs it, judged for leaks against the tokens hidden from whoever acts; a defect (a
 * leak, two artifacts of one read disagreeing) is a mismatch, since no branch can allow one, and of every other answer
 * the first branch whose outcome it is (step.ts observedNext) is the one nature chose, its state holding each identity
 * draw the answer showed as the value shown, none matching being a mismatch. The real system's state is runStep's to
 * check: a schedule judging an action while another session holds locks the owner's read would wait behind checks it
 * once they are released.
 */
export const judged = (
	world: RealWorld,
	state: ModelState,
	action: Action,
	index: number
): Effect.Effect<Stepped, ModelMismatch> =>
	Effect.gen(function* () {
		const where: Where = { _tag: "step", index, action: Formatter.format(action) }
		const branches = step(state, action)
		const { observation: observed, because } = yield* world.performed(
			action,
			hiddenFor(state, action)
		)
		if (isDefect(observed)) {
			return yield* ModelMismatch.make({ where, divergence: defectDivergence(observed) })
		}
		/**
		 * A landing whose outcome is the observed one's kind completes under the executor's names for its current
		 * installation, the one it landed; one of another kind is never the branch nature chose.
		 */
		const taken = Arr.findFirst(branches, (b, branch) =>
			b.observation.kind === observed.kind
				? Option.map(
						Option.fromUndefinedOr(
							observedNext(
								settle(b, () => world.names),
								observed
							)
						),
						(next) => ({ branch, next })
					)
				: Option.none()
		)
		if (Option.isNone(taken)) {
			return yield* ModelMismatch.make({
				where,
				divergence: {
					_tag: "observation",
					allowed: Arr.map(branches, (b) => Formatter.format(b.observation)),
					observed: Formatter.format(observed),
					because
				}
			})
		}
		return { observation: observed, branch: taken.value.branch, next: taken.value.next }
	})

/**
 * What the driver notes of a case: the features of each action it performs. A property's Case is one; setup the
 * driver checks without noting (drive/suite.ts unnoted) is another.
 */
export type Noting = Pick<Case<WorldFeature>, "noteAll">

/**
 * Performs one action on the real world and the model side by side (judged) and returns the state the model enters. A
 * migration's new installation is read back from the real world, whose compiler-derived names the model cannot mint.
 * The real system must then be in the branch's state (checkState). The case notes the action's invalid kinds and its
 * features in the state it ran in.
 *
 * The action must be drivable in the state (`drivable`): a serial driver performing an action that waits on a direct
 * session's transaction would hang, and an action after a tamper outside the contract has no meaning the model gives,
 * so either is the caller's defect.
 */
export const runStep = (
	world: RealWorld,
	state: ModelState,
	action: Action,
	index: number,
	c: Noting
): Effect.Effect<Stepped, ModelMismatch> =>
	Effect.gen(function* () {
		const where: Where = { _tag: "step", index, action: Formatter.format(action) }
		if (!drivable(state, action)) {
			return yield* Effect.die(
				new Error(
					`${whereText(where)} is no action a program may go on with: it waits on the open direct transaction, or follows a tamper outside the contract`
				)
			)
		}
		const taken = yield* judged(world, state, action, index)
		const next = yield* checkState(world, taken.next, where)
		c.noteAll(notedOf(state, action, taken.observation))
		return { ...taken, next }
	})
