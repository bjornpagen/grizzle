import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import * as EngineResult from "@bjornpagen/grizzle-text/base/result"
import type { ReadonlyTupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { ExecutionFailure } from "#adapter/errors/execution.ts"
import { ParamRejected } from "#adapter/errors/failures.ts"
import type { CompiledProgram } from "#adapter/served/forms.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import type { MemberParamSlot } from "#compiler/lower/conservative/types.ts"
import { compileParsed, parsedChange } from "#compiler/plan/change.ts"
import { parseRole, SourceLoc } from "#compiler/plan/common.ts"
import { role, wholeEntriesOf, wholeWritesOf } from "#compiler/public/schema.ts"
import type { WriteStepResult } from "#compiler/runtime/write/steps.ts"
import { factIdentity } from "#compiler/scalar/values/identity.ts"
import type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"
import type { AmbientFeature } from "#test/support/ambient.ts"
import { inputArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeChange } from "#test/support/conservative.ts"
import { messageOf } from "#test/support/message.ts"
import type { AppliedOutcome, Fact, OracleState } from "#test/support/oracle/addwins.ts"
import {
	type FactsByTexts,
	factSetOf,
	type FactTexts,
	identitySetOf
} from "#test/support/oracle/delta.ts"
import { CurrentRestorage } from "#test/support/oracle/gen/restorage.ts"
import {
	complementOf,
	CurrentPerturbation,
	printPerturbation
} from "#test/support/oracle/perturb.ts"
import { entryOf } from "#test/support/oracle/pick.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import {
	type WBinding,
	buildChangeSet,
	type ChangeSetSketch,
	changeSetSketchGen,
	isFact,
	type MemberOp,
	type PlantedArm,
	parentSlot,
	plantedChangeSet,
	plantedFacts,
	printChangeSet,
	printFact,
	printFacts,
	type ReadSource,
	resolveChangeSet,
	type WChangeSet,
	type WSourceKind
} from "#test/support/oracle/write/changeset.ts"

import {
	isNumericKind,
	isToastSized,
	sameBase,
	type TypeKind,
	typeInfo
} from "#test/support/oracle/write/domain.ts"

import {
	type AcceptableRefusal,
	type AcceptableRefusals,
	type DomainRefusal,
	type Expected,
	expectChangeSet,
	type Violations
} from "#test/support/oracle/write/expect.ts"

import {
	type FactsSketch,
	factsSketchGen,
	keyOf,
	multiplyWriteFacts,
	resolveFacts,
	restoredWriteFacts,
	type WFacts
} from "#test/support/oracle/write/facts.ts"

import {
	applyWith,
	type GroupState,
	type OutcomeWitness,
	type WriteOutcome,
	programOf,
	readGroup,
	resetGroup,
	type Statistics,
	type WriteTarget
} from "#test/support/oracle/write/run.ts"

import {
	intoCandidateKey,
	isImmediate,
	printGroup,
	relationIn,
	type WBuiltSchema,
	type WContainment,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { slotCarriers, slotsRead } from "#test/support/slot-carriers.ts"
import { holdsCycle, printOrder } from "#test/support/stratum-order.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/** The items joined by `separator`, or `none` when there is no item. */
const listed = (items: ReadonlyArray<string>, separator: string, none: string): string =>
	items.length === 0 ? none : Arr.join(items, separator)

/** One drawn write case of a run. */
export interface WriteCase {
	/** The group the case writes, a pick among the run's drawn groups. */
	readonly group: number
	readonly facts: FactsSketch
	readonly changes: ChangeSetSketch
}

export const writeCaseGen: Gen<WriteCase> = (source) => ({
	group: source.draw(pickGen),
	facts: source.draw(factsSketchGen(5)),
	changes: source.draw(changeSetSketchGen)
})

/**
 * The planted cases of a run whose schema holds the planted group: one per arm (changeset.ts plantedArms), each from
 * these drawn facts of the planted group with those its arm plants beside them.
 */
export interface PlantedCases {
	readonly facts: FactsSketch
}

export const plantedCasesGen: Gen<PlantedCases> = (source) => ({
	facts: source.draw(factsSketchGen(5))
})

/**
 * A case resolved: whether it was drawn or is a planted arm, the group it writes, the facts it starts from, and its
 * ChangeSet.
 */
export interface ResolvedCase {
	readonly origin:
		| { readonly kind: "drawn" }
		| { readonly kind: "planted"; readonly arm: PlantedArm }
	readonly group: WGroup
	readonly facts: WFacts
	readonly changes: WChangeSet
}

/**
 * A resolved case as its run applies it (`settledCase`): its ChangeSet with every read-back its compile refuses as
 * crossing statements left out, and whether one was.
 */
export interface SettledCase extends ResolvedCase {
	readonly dropped: boolean
}

/**
 * A drawn case, on the drawn group it picks: the planted group is written by planted cases alone, so the drawn
 * population keeps every case. Its ChangeSet's swarm thins as the resolution meets each place, so the case draws those
 * decisions (changeset.ts resolveChangeSet).
 */
export const drawnCase =
	(schema: WSchema, wc: WriteCase): Gen<ResolvedCase> =>
	(source) => {
		const [first, ...rest] = Arr.filter(schema.groups, (g) => g.role === "drawn")
		if (first === undefined) {
			throw new Error("a write schema of no drawn group")
		}
		const group = pickFrom([first, ...rest], wc.group)
		const facts = resolveFacts(group, wc.facts)
		return {
			origin: { kind: "drawn" },
			group,
			facts,
			changes: source.draw(resolveChangeSet(group, facts, wc.changes))
		}
	}

/** A planted case of `arm` on the planted group, from the drawn facts `facts`. */
export const plantedCase = (group: WGroup, arm: PlantedArm, facts: FactsSketch): ResolvedCase => {
	const stored = plantedFacts(group, resolveFacts(group, facts), arm)
	return {
		origin: { kind: "planted", arm },
		group,
		facts: stored,
		changes: plantedChangeSet(group, arm)
	}
}

/** A failed case, with its printable form. */
export class CaseFailed extends Data.TaggedError("CaseFailed")<{ readonly report: string }> {
	override get message(): string {
		return this.report
	}
}

/** What kind of law refused a case. */
type RefusalFeature =
	| "refused by a primary key"
	| "refused by a candidate key"
	| "refused by an immediate foreign key"
	| "refused at COMMIT by a containment"
	| "refused by a projected key"

/**
 * Every feature a write case notes through its Case: the shapes it drew, what the compiler and the database decided,
 * and the run's statistics.
 */
export type WriteOracleFeature =
	| AmbientFeature
	| `strata:${number}`
	| `${MemberOp} ${WSourceKind}`
	| `read ${ReadSource}`
	| `parameters ${WBinding}`
	| `put target ${PutChoice["target"]}`
	| `outcome ${AppliedOutcome["kind"]}`
	| `statistics ${Statistics}`
	| RefusalFeature
	| "single-statement stratum"
	| "a single statement refused by a law"
	| "sequential stratum of several writes"
	| "anchored deletion"
	| "delete equal by a literal"
	| "a member slot staged"
	| "a staged slot an exact deletion excepts"
	| "a staged slot beside another slot of its heading"
	| "two staged slots of one heading"
	| "a staged slot a put's halves read"
	| "two members of one relation in one stratum"
	| "a member reads a relation its stratum writes"
	| "numeric cast between typmods"
	| "mutable relation"
	| "immediate containment"
	| "deferred containment"
	| "reference into a candidate key"
	| "projected key"
	| "flight logged"
	| "outcome invariant-rejected"
	| "toast-sized input"
	| "toast-sized no-change"
	| "toast-sized accepted"
	| "delta read-backs of one heading's field names over other types"
	| "described member wider than its field"
	| "a deletion described wider than its field"
	| "outcome outside a domain"
	| "outcome refused at bind"
	| "a stated-one read-back with its parent present"
	| "a stated-one read-back with its parent absent"
	| "a stated-one read-back over a deferred containment that the write violates"
	| "facts reordered on a second reading"
	| "a fact respelled on a second reading"
	| "a read-back refused as crossing statements"
	| "an unorderable stratum refused"
	| "an addition a later stratum removes"
	| "a deletion meeting nowhere unordered beside an addition"

const identityOf = (group: WGroup, relation: string, fact: unknown): FactTexts => {
	const r = relationIn(group, relation)
	const admitted = factIdentity(
		Arr.map(r.columns, (c) => ({ name: c.name, spec: typeInfo[c.kind].spec })),
		fact
	)
	if (!admitted.ok) {
		const { fault, field } = admitted.error
		throw new Error(
			`${relation}: a fact is inadmissible, ${fault}${field === undefined ? "" : ` at ${field}`}`
		)
	}
	return admitted.value.texts
}

const printSet = (facts: Iterable<Fact>): string =>
	`[${Arr.join(Arr.map([...facts], printFact), ", ")}]`

const sameIdentities = (a: ReadonlyTupleSet<FactTexts>, b: ReadonlyTupleSet<FactTexts>): boolean =>
	a.size === b.size && Arr.every([...a], (x) => b.has(x))

const printOutcome = (o: Result.Result<WriteOutcome, unknown>): string => {
	if (Result.isFailure(o)) {
		const e = o.failure
		const tag =
			typeof e === "object" && e !== null && "_tag" in e && typeof e._tag === "string"
				? e._tag
				: undefined
		return `failure ${tag ?? "?"} ${Formatter.format(e)}`
	}
	const v = o.success
	switch (v.kind) {
		case "invariant-rejected":
			return `invariant-rejected ${v.refused.kind} of ${Arr.join(v.refused.laws, ", ")} witness ${
				v.witness.kind === "key"
					? `${v.witness.relation} ${printFact(v.witness.values)}`
					: v.witness.kind
			}`
		case "no-change":
			return `no-change reads ${Arr.join(
				Arr.map(Rec.toEntries(v.reads), ([n, rows]) => `${n}=${printSet(rows)}`),
				" "
			)}`
		case "accepted":
			return `accepted counts ${Arr.join(
				Arr.map(v.counts, (c) => `${c.relation}(+${c.added} -${c.deleted} put ${c.put})`),
				" "
			)} reads ${Arr.join(
				Arr.map(Rec.toEntries(v.reads), ([n, rows]) => `${n}=${printSet(rows)}`),
				" "
			)}`
		case "outside-world":
			return `outside-world ${v.relation}`
	}
}

/** The problems of a key witness of `law` against its violations: a key of its relation at its fields that violates it. */
const keyProblems = (
	group: WGroup,
	law: LawId,
	violations: Violations,
	w: Extract<OutcomeWitness, { readonly kind: "key" }>
): ReadonlyArray<string> => {
	const fields = Arr.sort(Rec.keys(w.values), Order.String)
	if (
		w.relation !== violations.relation ||
		Arr.join(fields, ",") !== Arr.join(Arr.sort([...violations.fields], Order.String), ",")
	) {
		return [
			`the witness key ${w.relation} ${printFact(w.values)} is not ${violations.relation}(${Arr.join(violations.fields, ", ")})`
		]
	}
	return violations.keys.has(
		keyOf(relationIn(group, violations.relation), violations.fields, w.values)
	)
		? []
		: [`the witness key ${printFact(w.values)} is no violating key of ${law}`]
}

/** The problems of a refusal's witness against the one witness its law may carry. */
const witnessProblems = (
	group: WGroup,
	law: LawId,
	refusal: AcceptableRefusal,
	w: OutcomeWitness
): ReadonlyArray<string> => {
	switch (refusal.kind) {
		case "key":
			return w.kind === "key"
				? keyProblems(group, law, refusal.violations, w)
				: [`the witness of ${law} is ${w.kind}, where it names a key`]
		case "keyOrUnreported":
			return w.kind === "key" ? keyProblems(group, law, refusal.violations, w) : []
		case "unreported":
			return w.kind === "key"
				? [
						`the witness of ${law} names ${w.relation} ${printFact(w.values)}, where its violation is native and names no key`
					]
				: []
	}
}

/** A read-back row's own fact, its attached parent left out. */
const withoutParent = (row: Fact): Fact =>
	Rec.fromEntries(Arr.filter(Rec.toEntries(row), ([k]) => k !== parentSlot))

/** The facts a read-back defines over an applied outcome: the final state's facts of its relation, or its delta's. */
/**
 * Whether a stratum of the expected change adds a fact a later stratum removes, read off the oracle's per-stratum
 * changes (addwins.ts AppliedOutcome strata): the change's counts net the pair away (delta.ts netStrata), as the
 * realization's must (core/zset.ts addInto, runtime/write/net.ts outcomeCounts).
 */
const addedThenRemoved = (outcome: AppliedOutcome): boolean =>
	Arr.some(outcome.strata, (stratum, at) =>
		Arr.some([...stratum], ([relation, delta]) =>
			Arr.some([...delta.added.keys()], (identity) =>
				Arr.some(outcome.strata.slice(at + 1), (later) =>
					Option.exists(Option.fromNullishOr(later.get(relation)), (d) => d.removed.has(identity))
				)
			)
		)
	)

const expectedReadFacts = (want: AppliedOutcome, read: WChangeSet["reads"][number]): FactsByTexts =>
	read.source === "state"
		? (want.state.relations.get(read.relation) ?? factSetOf([]))
		: (want.delta.get(read.relation)?.[read.source] ?? factSetOf([]))

/** The target fact `facts` hold at a row's contained fields, by its positional key. */
const parentOf = (
	group: WGroup,
	containment: WContainment,
	row: Fact,
	facts: Iterable<Fact>
): Fact | undefined => {
	const source = relationIn(group, containment.from.relation)
	const target = relationIn(group, containment.to.relation)
	const at = keyOf(source, containment.from.fields, row)
	for (const f of facts) {
		if (keyOf(target, containment.to.fields, f) === at) {
			return f
		}
	}
	return undefined
}

/** The problems of an attached read-back's parents (see the header) against the committed state. */
const parentProblems = (
	group: WGroup,
	name: string,
	containment: WContainment,
	rows: ReadonlyArray<Fact>,
	state: GroupState
): ReadonlyArray<string> => {
	const target = relationIn(group, containment.to.relation)
	const others = Arr.map(
		Arr.filter(target.columns, (c) => !containment.to.fields.includes(c.name)),
		(c) => c.name
	)
	const committed = [...entryOf(state.relations, target.name, "the committed relations").values()]
	return Arr.flatMap(rows, (row) => {
		const parent = row[parentSlot]
		const held = parentOf(group, containment, row, committed)
		const label = `read-back ${name}: the row ${printFact(withoutParent(row))}`
		if (!Option.isOption(parent)) {
			return [`${label} holds no Option in ${parentSlot}`]
		}
		if (held === undefined) {
			return Option.isSome(parent)
				? [`${label} attaches a parent the committed state does not hold`]
				: []
		}
		if (Option.isNone(parent)) {
			return [`${label} attaches none, the committed state holds ${printFact(held)}`]
		}
		const child = parent.value
		return !isFact(child) ||
			Rec.keys(child).length !== others.length ||
			!Arr.every(others, (f) => Rec.has(child, f)) ||
			keyOf(target, others, child) !== keyOf(target, others, held)
			? [`${label} attaches a parent other than the committed ${printFact(held)}`]
			: []
	})
}

/** The laws an expectation's refusals allow, for a failure report. */
const lawsOf = (refusals: AcceptableRefusals): string => Arr.join([...refusals.keys()], ", ")

/** A refusal's laws as its outcome names them, and how grizzle decided them, for a failure report. */
const printRefused = (o: Extract<WriteOutcome, { readonly kind: "invariant-rejected" }>): string =>
	`${o.refused.kind} of ${Arr.join(o.refused.laws, ", ")}`

/**
 * The problems of a refusal with `o`'s laws against the refusals by a law of the stratum an expectation allows: each a
 * law decided (`every`, or the CHECK PostgreSQL tried `first`), every law it names one of them, and its witness one its
 * first law's refusal may carry. No law of the stratum is one of several an object discharges, so `some` is none.
 */
const refusalProblems = (
	group: WGroup,
	refusals: AcceptableRefusals,
	o: Extract<WriteOutcome, { readonly kind: "invariant-rejected" }>
): ReadonlyArray<string> => {
	if (o.refused.kind === "some") {
		return [`refused with ${printRefused(o)}, expected a decided one of ${lawsOf(refusals)}`]
	}
	const [law] = o.refused.laws
	const first = refusals.get(law)
	const unexpected = Arr.filter(o.refused.laws, (l) => !refusals.has(l))
	return first === undefined || Arr.isReadonlyArrayNonEmpty(unexpected)
		? [`refused with ${Arr.join(unexpected, ", ")}, expected one of ${lawsOf(refusals)}`]
		: witnessProblems(group, law, first, o.witness)
}

/**
 * The problems of a refusal with `o`'s laws against the domain's (DomainRefusal): the laws it names are those of the
 * columns the domain types in some of the tables the stratum writes, each such table's every one, among them the
 * target of a member that adds a refused value; `every` where that is one law and `some` where several; and no key.
 */
const domainProblems = (
	domain: DomainRefusal,
	o: Extract<WriteOutcome, { readonly kind: "invariant-rejected" }>
): ReadonlyArray<string> => {
	const named = new Set<LawId>(o.refused.laws)
	const written = Arr.filter([...domain.typed], ([, laws]) => Arr.some(laws, (l) => named.has(l)))
	const whole =
		Arr.every(written, ([, laws]) => Arr.every(laws, (l) => named.has(l))) &&
		Arr.every([...named], (l) => Arr.some(written, ([, laws]) => laws.includes(l)))
	const decided = named.size === 1 ? "every" : "some"
	return [
		...(whole
			? []
			: [
					`refused with ${printRefused(o)}, not every law the domain types in some of the tables the stratum writes: ${Formatter.format([...domain.typed])}`
				]),
		...(Arr.some(written, ([relation]) => domain.refusing.has(relation))
			? []
			: [
					`refused with ${printRefused(o)}, naming no table a member adds a value outside the domain to: ${Arr.join([...domain.refusing], ", ")}`
				]),
		...(o.refused.kind === decided
			? []
			: [`refused with ${printRefused(o)}, where the domain's ${named.size} laws are ${decided}`]),
		...(o.witness.kind === "key"
			? [
					`the witness of the domain's refusal names ${o.witness.relation} ${printFact(o.witness.values)}, where it names no key`
				]
			: [])
	]
}

/** A relation's counts as an accepted outcome reports them. */
type Counts = Extract<WriteOutcome, { readonly kind: "accepted" }>["counts"][number]

/** The problems of the database's counts `got` against the oracle's `want`, relation by relation. */
const countProblems = (
	got: ReadonlyArray<Counts>,
	want: ReadonlyArray<Counts>
): ReadonlyArray<string> => {
	const db = new Map(Arr.map(got, (x) => [x.relation, x]))
	const oracle = new Map(Arr.map(want, (x) => [x.relation, x]))
	return Arr.flatMap([...new Set([...db.keys(), ...oracle.keys()])], (relation) => {
		const g = db.get(relation)
		const e = oracle.get(relation)
		if (g === undefined || e === undefined) {
			return [
				`counts name ${relation} on one side only (db ${g !== undefined}, oracle ${e !== undefined})`
			]
		}
		return g.added !== e.added || g.deleted !== e.deleted || g.put !== e.put
			? [
					`counts of ${relation}: db +${g.added} -${g.deleted} put ${g.put}, oracle +${e.added} -${e.deleted} put ${e.put}`
				]
			: []
	})
}

/**
 * The problems of an outcome against a parameter PostgreSQL refuses as the admission the first statement a call sends
 * carries binds it, before any statement runs: ExecutionFailure with reason ParamRejected at one of `params`, a scalar parameter or a
 * field of a relation parameter's, by the parameter's name its place holds, never a law's refusal.
 */
const unboundProblems = (
	expected: Extract<Expected, { readonly kind: "unbound" }>,
	outcome: Result.Result<WriteOutcome, unknown>
): ReadonlyArray<string> => {
	const params = [...expected.params]
	if (Result.isSuccess(outcome)) {
		return [
			`expected ParamRejected at one of ${Arr.join(params, ", ")}, got ${outcome.success.kind}`
		]
	}
	const failure = outcome.failure
	const param =
		failure instanceof ExecutionFailure && failure.reason instanceof ParamRejected
			? failure.reason.param
			: undefined
	return param !== undefined && Arr.contains(params, param.name)
		? []
		: [
				`expected ParamRejected at one of ${Arr.join(params, ", ")}, got ${Formatter.format(failure)}`
			]
}

/**
 * The problems of a ChangeSet's compile against strata whose writes the keys order in a cycle: refused with
 * UnorderableStratum, naming a cycle of one of them (`holdsCycle`).
 */
const unorderableProblems = (
	expected: Extract<Expected, { readonly kind: "unorderable" }>,
	entry: Result.Result<CompiledProgram, CompileError>
): ReadonlyArray<string> => {
	if (Result.isSuccess(entry)) {
		return ["the ChangeSet compiles"]
	}
	const reason = entry.failure.reason
	if (reason._tag !== "UnorderableStratum") {
		return [`the ChangeSet does not compile: ${entry.failure.message}`]
	}
	return Arr.some(expected.strata, (s) => holdsCycle(s.order, reason.cycle))
		? []
		: [
				`refused naming the cycle ${Arr.join(
					Arr.map(reason.cycle, (w) => `${w.op} ${w.relation}`),
					", then "
				)}, no cycle of the strata's keys`
			]
}

/** The problems of one side's outcome and committed state against the expectation. */
export const judgeWrite = (
	group: WGroup,
	c: WChangeSet,
	expected: Expected,
	outcome: Result.Result<WriteOutcome, unknown>,
	state: GroupState
): ReadonlyArray<string> => {
	const problems: Array<string> = []
	const stateIs = (want: OracleState, label: string) => {
		for (const r of group.relations) {
			const got = identitySetOf(state.relations.get(r.name)?.keys() ?? [])
			const exp = identitySetOf((want.relations.get(r.name) ?? factSetOf([])).keys())
			if (!sameIdentities(got, exp)) {
				problems.push(
					`${label} ${r.name}: committed ${printSet(state.relations.get(r.name)?.values() ?? [])}, expected ${printSet(want.relations.get(r.name)?.values() ?? [])}`
				)
			}
		}
	}
	if (expected.kind === "unorderable") {
		problems.push(`expected the compile to refuse, got ${printOutcome(outcome)}`)
		return problems
	}
	if (expected.kind === "unbound") {
		appendAll(problems, unboundProblems(expected, outcome))
		stateIs(expected.initial, "after a parameter's refusal the initial state stays:")
		return problems
	}
	if (expected.kind === "outsideDomain") {
		const laws = lawsOf(expected.refusals)
		if (Result.isFailure(outcome)) {
			problems.push(`expected a domain's law or one of ${laws}, got ${printOutcome(outcome)}`)
		} else if (outcome.success.kind !== "invariant-rejected") {
			problems.push(`expected a domain's law or one of ${laws}, got ${outcome.success.kind}`)
		} else {
			const byDomain = domainProblems(expected.domain, outcome.success)
			const byLaw = refusalProblems(group, expected.refusals, outcome.success)
			if (Arr.isReadonlyArrayNonEmpty(byDomain) && Arr.isReadonlyArrayNonEmpty(byLaw)) {
				appendAll(problems, [...byDomain, ...byLaw])
			}
		}
		stateIs(expected.initial, "after a domain's refusal the initial state stays:")
		return problems
	}
	if (Result.isFailure(outcome)) {
		problems.push(`an operational failure: ${printOutcome(outcome)}`)
		return problems
	}
	const o = outcome.success
	if (expected.kind === "rejected") {
		if (o.kind !== "invariant-rejected") {
			problems.push(
				`expected invariant-rejected with one of ${lawsOf(expected.refusals)}, got ${o.kind}`
			)
		} else {
			appendAll(problems, refusalProblems(group, expected.refusals, o))
		}
		stateIs(expected.initial, "after a refusal the initial state stays:")
		return problems
	}
	const want = expected.outcome
	if (o.kind !== want.kind) {
		problems.push(`expected ${want.kind}, got ${o.kind}`)
	}
	if (o.kind === "invariant-rejected" || o.kind === "outside-world") {
		return problems
	}
	if (o.kind === "accepted" && want.kind === "accepted") {
		appendAll(problems, countProblems(o.counts, want.counts))
	}
	for (const read of c.reads) {
		const delivered = o.reads[read.name]
		if (delivered === undefined) {
			problems.push(`read-back ${read.name} is missing`)
			continue
		}
		const rows = read.parent.kind === "one" ? Arr.map(delivered, withoutParent) : delivered
		const ids = Arr.map(rows, (row) => identityOf(group, read.relation, row))
		if (identitySetOf(ids).size !== ids.length) {
			problems.push(`read-back ${read.name} repeats a row: ${printSet(rows)}`)
		}
		const expectedFacts = expectedReadFacts(want, read)
		if (!sameIdentities(identitySetOf(ids), identitySetOf(expectedFacts.keys()))) {
			problems.push(
				`read-back ${read.name} (${read.source} ${read.relation}): db ${printSet(rows)}, oracle ${printSet(expectedFacts.values())}`
			)
		}
		if (read.parent.kind === "one") {
			appendAll(
				problems,
				parentProblems(group, read.name, read.parent.containment, delivered, state)
			)
		}
	}
	stateIs(want.state, "final state:")
	return problems
}

/** Whether two outcomes' counts agree, relation by relation. */
const sameCounts = (a: AppliedOutcome["counts"], b: AppliedOutcome["counts"]): boolean =>
	a.length === b.length &&
	Arr.every(a, (x) =>
		Option.exists(
			Arr.findFirst(b, (c) => c.relation === x.relation),
			(y) => y.added === x.added && y.deleted === x.deleted && y.put === x.put
		)
	)

/** A relation's counts, as a failure report prints them. */
const printCounts = (counts: AppliedOutcome["counts"]): string =>
	Arr.join(
		Arr.map(counts, (c) => `${c.relation}(+${c.added} -${c.deleted} put ${c.put})`),
		" "
	)

/** One database reading of a case: its name in a report, and its outcome. */
type Reading = readonly [name: string, outcome: Result.Result<WriteOutcome, unknown>]

/** Two database readings agree exactly on an applied outcome: its kind and every relation's counts. */
const agreement = ([aName, a]: Reading, [bName, b]: Reading): ReadonlyArray<string> => {
	if (Result.isFailure(a) || Result.isFailure(b)) {
		return []
	}
	const x = a.success
	const y = b.success
	if (x.kind !== y.kind) {
		return [`${aName} ${x.kind}, ${bName} ${y.kind}`]
	}
	return x.kind === "accepted" && y.kind === "accepted" && !sameCounts(x.counts, y.counts)
		? [`${aName} counts ${printCounts(x.counts)}, ${bName} counts ${printCounts(y.counts)}`]
		: []
}

/**
 * What kind of law refused, or none for a law no declaration of the group names, which the judge reports as no
 * acceptable refusal.
 */
const refusalKind = (t: WriteTarget, group: WGroup, law: LawId): Option.Option<RefusalFeature> =>
	Option.orElse(
		Arr.findFirst(group.relations, (r): Option.Option<RefusalFeature> =>
			t.laws.primaryKey(r.name) === law
				? Option.some("refused by a primary key")
				: Arr.some(r.keys, (k) => t.laws.key(r.name, k) === law)
					? Option.some("refused by a candidate key")
					: Option.none()
		),
		() =>
			Option.orElse(
				Arr.findFirst(group.containments, (c): Option.Option<RefusalFeature> =>
					t.laws.containment(c.from.relation, c.from.fields) === law
						? Option.some(
								isImmediate(group, c)
									? "refused by an immediate foreign key"
									: "refused at COMMIT by a containment"
							)
						: Option.none()
				),
				() =>
					Arr.some(
						group.projectedKeys,
						(k) => t.laws.projectedKey(k.relation, k.fields).law === law
					)
						? Option.some("refused by a projected key")
						: Option.none()
			)
	)

/**
 * The features of a case's shapes, before it runs.
 *
 * A described member reading a relation its own stratum writes reads the state before the stratum's writes.
 *
 * A projection that reads a numeric of one typmod into another, so the value is rounded by the cast into the
 * relation's type before the write compares it; and one that reads the wide text into the narrow text, whose domain
 * refuses a value outside it, a deletion's comparison among them.
 */
const noteShapes = (group: WGroup, c: WChangeSet, note: Case<WriteOracleFeature>["note"]): void => {
	note(`strata:${c.strata.length}`)
	for (const s of c.strata) {
		for (const m of s) {
			note(`${m.op} ${m.source.kind}`)
			if (
				m.source.kind === "equal" &&
				Arr.some(m.source.fields, (f) => f.equaled.kind === "literal")
			) {
				note("delete equal by a literal")
			}
		}
		const relations = Arr.map(s, (m) => m.relation)
		if (new Set(relations).size < relations.length) {
			note("two members of one relation in one stratum")
		}
		if (Arr.some(s, (m) => m.source.kind === "project" && relations.includes(m.source.from))) {
			note("a member reads a relation its stratum writes")
		}
	}
	for (const r of c.reads) {
		note(`read ${r.source}`)
	}
	const members = c.strata.flat()
	/**
	 * Each field a projecting member's head reads from a column, as it is or by a cast: the member's op and both
	 * columns' kinds.
	 */
	const described = Arr.flatMap(members, (m) => {
		if (m.source.kind !== "project") {
			return []
		}
		const target = relationIn(group, m.relation)
		const from = relationIn(group, m.source.from)
		return Arr.flatMap(Rec.toEntries(m.source.head), ([field, term]) =>
			term.kind !== "param"
				? Option.toArray(
						Option.map(
							Option.all({
								to: Arr.findFirst(target.columns, (col) => col.name === field),
								source: Arr.findFirst(from.columns, (col) => col.name === term.column)
							}),
							({ to, source }) => ({ op: m.op, to: to.kind, source: source.kind })
						)
					)
				: []
		)
	})
	for (const { op, to, source } of described) {
		if (isNumericKind(to) && to !== source && sameBase(to, source)) {
			note("numeric cast between typmods")
		}
		if (source === "text6" && to === "text") {
			note("described member wider than its field")
		}
		if (source === "text6" && to === "text" && op === "delete") {
			note("a deletion described wider than its field")
		}
	}
	for (const r of group.relations) {
		if (r.mutable) {
			note("mutable relation")
		}
	}
	for (const x of group.containments) {
		note(isImmediate(group, x) ? "immediate containment" : "deferred containment")
		if (intoCandidateKey(group, x)) {
			note("reference into a candidate key")
		}
	}
	note(`parameters ${c.binding}`)
	if (group.projectedKeys.length > 0) {
		note("projected key")
	}
}

/**
 * The facts a member's input spells: an enumerated member's, or a relation parameter's. A projection's values come
 * from stored facts, and its parameters are scalars.
 */
const inputFacts = (
	c: WChangeSet,
	source: WChangeSet["strata"][number][number]["source"]
): ReadonlyArray<unknown> => {
	if (source.kind === "array") {
		return source.facts
	}
	if (source.kind !== "param") {
		return []
	}
	const p = c.params[source.param]
	return Arr.isArray(p) ? p : []
}

/** The values a ChangeSet's inputs spell, each with the kind of the column it is spelled for. */
const inputValues = (
	group: WGroup,
	c: WChangeSet
): ReadonlyArray<{ readonly kind: TypeKind; readonly value: unknown }> =>
	Arr.flatMap(Arr.flatten(c.strata), (m) => {
		const r = relationIn(group, m.relation)
		return Arr.flatMap(inputFacts(c, m.source), (fact) =>
			isFact(fact)
				? Arr.flatMap(r.columns, (col) =>
						Rec.has(fact, col.name) ? [{ kind: col.kind, value: fact[col.name] }] : []
					)
				: []
		)
	})

/**
 * Whether a staged member slot of `artifact` (write/program/slot-carriers.ts) is read through its carrier by a deletion
 * of `mode` and by an insertion: an exact deletion excepting the slot's facts, its stratum's additions, beside their
 * insert (D EXCEPT A, delete/exact.ts), or a put's displacing deletion beside its insert half.
 */
const stagedBeside = (
	artifact: WriteArtifact,
	mode: Extract<WriteStepResult, { readonly kind: "delete" }>["mode"]
): boolean => {
	const readers = (result: (r: WriteStepResult) => boolean) =>
		Arr.filter(artifact.statements, (st) => st.step.kind === "write" && result(st.step.result))
	const deletions = readers((r) => r.kind === "delete" && r.mode === mode)
	const insertions = readers((r) => r.kind === "insert")
	return Arr.some([...slotCarriers(artifact).values()], (slot) => {
		const reads = (st: ArtifactStatement) => slotsRead(artifact, st).has(slot.slot)
		return Arr.some(deletions, reads) && Arr.some(insertions, reads)
	})
}

/**
 * Whether a staged member slot of `artifact` (write/program/slot-carriers.ts) has a sibling: another slot the program
 * reads whose heading has its field names and types, so its carrier must be filled from its own slot's arrays and no
 * other's.
 */
const stagedBesideItsHeading = (artifact: WriteArtifact): boolean => {
	const read = Arr.flatMap(artifact.statements, (st) => [...slotsRead(artifact, st).values()])
	const alike = (a: MemberParamSlot, b: MemberParamSlot): boolean =>
		a.columns.length === b.columns.length &&
		Arr.every(b.columns, (c) =>
			Arr.some(a.columns, (k) => k.name === c.name && sameScalarType(k.type, c.type))
		)
	return Arr.some([...slotCarriers(artifact).values()], (staged) =>
		Arr.some(read, (other) => other.slot !== staged.slot && alike(staged, other))
	)
}

/**
 * Whether two staged member slots of `artifact` have one heading's field names and types (the planted arm "twin
 * replaces"): each carrier must hold its own slot's facts, which differ, so a fill from the other's slot is read back.
 */
const stagedTwins = (artifact: WriteArtifact): boolean => {
	const staged = [...slotCarriers(artifact).values()]
	return Arr.some(staged, (a) =>
		Arr.some(
			staged,
			(b) =>
				a.slot !== b.slot &&
				a.columns.length === b.columns.length &&
				Arr.every(b.columns, (c) =>
					Arr.some(a.columns, (k) => k.name === c.name && sameScalarType(k.type, c.type))
				)
		)
	)
}

/**
 * The realizations a program's optimized artifact chose (schedule/plan.ts): a stratum as one statement, a stratum of
 * several write statements in sequence, a deletion anchored on its own relation (write/delete/anchor.ts), and a member
 * slot two statements read staged into a carrier (write/program/slot-carriers.ts), one an exact deletion excepts beside
 * its insert or a put's both halves read among them, one beside another slot of its heading, and two staged slots of
 * one heading.
 */
const realizationsOf = (program: CompiledWrite): ReadonlyArray<WriteOracleFeature> => {
	const artifact = program.artifact
	const steps = artifact.steps
	const writes = new Map<number, number>()
	for (const step of steps) {
		if (step.kind === "write") {
			writes.set(step.stratum, (writes.get(step.stratum) ?? 0) + 1)
		}
	}
	const anchored = Arr.some(
		program.plan.steps,
		(step) =>
			(step.kind === "write" && step.op === "anchoredDelete") ||
			(step.kind === "single" && Arr.some(step.writes, (w) => w.op === "anchoredDelete"))
	)
	return [
		...(Arr.some(steps, (step) => step.kind === "single")
			? ["single-statement stratum" as const]
			: []),
		...(Arr.some([...writes.values()], (n) => n >= 2)
			? ["sequential stratum of several writes" as const]
			: []),
		...(anchored ? ["anchored deletion" as const] : []),
		...(slotCarriers(artifact).size > 0 ? ["a member slot staged" as const] : []),
		...(stagedBeside(artifact, "exact")
			? ["a staged slot an exact deletion excepts" as const]
			: []),
		...(stagedBeside(artifact, "displacing") ? ["a staged slot a put's halves read" as const] : []),
		...(stagedBesideItsHeading(artifact)
			? ["a staged slot beside another slot of its heading" as const]
			: []),
		...(stagedTwins(artifact) ? ["two staged slots of one heading" as const] : [])
	]
}

/** What a case expects, for its failure report. */
const printExpected = (expected: Expected): string => {
	switch (expected.kind) {
		case "unorderable":
			return `UnorderableStratum, the keys ordering ${Arr.join(
				Arr.map(expected.strata, (s) => `stratum ${s.stratum}: ${printOrder(s.order)}`),
				"; "
			)}`
		case "applied":
			return expected.outcome.kind
		case "rejected":
			return `invariant-rejected by one of ${lawsOf(expected.refusals)}`
		case "outsideDomain":
			return `invariant-rejected by a domain's law or one of ${lawsOf(expected.refusals)}`
		case "unbound":
			return `ParamRejected at one of ${Arr.join([...expected.params], ", ")}`
	}
}

/** What a case read back: its group and the read-backs its write ran, none where its ChangeSet is refused as it
 * compiles. */
export interface Ran {
	readonly group: WGroup
	readonly reads: WChangeSet["reads"]
}

/**
 * The three-way write harness: writes compare three ways (db.apply, brute-force add-wins, conservative realization).
 *
 * A write case is a drawn group of the run's schema, the group's initial facts, and one ChangeSet, each a sketch of plain numbers resolved against it (schema.ts, facts.ts, changeset.ts), the schema's
 * and the ChangeSet's swarm thinning drawn from the case's tape as the resolution meets each place, so a shrink of the
 * tape shrinks every part of a failing case at once and the shrunk case stays valid. A planted case writes the
 * planted group instead, one of the fixed ChangeSets of changeset.ts PlantedArm over its drawn facts and those the arm
 * plants. `runCase` applies the ChangeSet three ways and compares:
 *
 * - db.apply, the optimized artifact, with every put target the compiler chooses for the relation's mutability and the
 *   member's shape;
 * - the conservative realization of the same compiled program, every put the DELETE-then-insert
 *   pair and every delta a comparison of states, so each mutable put target the optimized side chose must agree with
 *   DELETE + INSERT in final state, counts and deltas;
 * - the brute-force add-wins result (expect.ts).
 *
 * A ChangeSet with a stratum whose writes the immediate keys and foreign keys order in a cycle (expect.ts
 * unorderableStrata) applies nothing: its compile must refuse it with UnorderableStratum, naming a cycle of that
 * stratum's keys, and the case ends there, noting that refusal alone, since none of the shapes it drew ran.
 *
 * The optimized side is applied as the compiled ChangeSet's one transaction on a served Db's context (test/support/
 * served-role.ts runEntry), with the parameters passed to the call or closed by ChangeSet.bind (changeset.ts): each is
 * the same ChangeSet, so both must give the oracle's outcome.
 *
 * Each database side starts from the same reset state and must give the oracle's outcome: `accepted` with the netted
 * counts per written relation or `no-change`, each with every read-back equal as a set to its definition over the final
 * state and the netted deltas, and the committed state the oracle's final state; or
 * `invariant-rejected` with a law the realization may meet first and a key-only witness of that law, leaving the
 * initial state committed; or, when a stratum adds a value its field's domain refuses, `invariant-rejected` with the
 * domain's laws, keyless, as the adapter classifies the violation by the domain PostgreSQL names: every law the domain
 * types in the tables its statement writes, `some` of them where they are several (expect.ts DomainRefusal); or a law
 * the realization meets first, with the initial state committed. A read-back that attaches, stated "one", the target of a
 * deferred containment reads each row's parent as an Option: Option.some of the target fact the committed state holds
 * at the row's contained fields (its fields outside the referenced key), or Option.none when it holds none; a write
 * that violates that containment is refused at COMMIT with its law, never a defect of the read-back. The two database
 * sides must also agree with each other exactly on an applied outcome.
 *
 * Then the case is read a second time, by the three invariance relations: its facts stored otherwise through a fresh
 * reset, each relation's facts in another order and one value in its next spelling (../gen/restorage.ts, written by
 * the owner's SERIALIZABLE reset as a direct writer), and the side db.apply runs applied again under the complement of
 * the case's planner settings (../perturb.ts complementOf). The facts are the same, so it must give the oracle's
 * outcome again and agree exactly with its first reading. The conservative realization is the oracle's baseline, not
 * an answer an application receives, so only db.apply's side is read again.
 *
 * Every case notes its features through its Case (@bjornpagen/testing/explore): the shapes it drew and what the compiler
 * and the database decided, so the suite fails when its population stops reaching one.
 *
 * Runs one case three ways (see the header); fails with the printable case on any disagreement.
 *
 * Every statement of each artifact, in the order it runs, passes the kernel's structural audit.
 *
 * The single-flight property judged a logged flight: a logger that recorded nothing would leave it
 * vacuous.
 */
/**
 * `rc` with every read-back its compile refuses as crossing statements (ReadBackCrossesStatements) left out, and whether
 * one was (SettledCase): a read-back reads each delta side inside the one statement that makes it whole, or carried out
 * of that statement to the end of the write (write/schedule/plan.ts placeReadBacks), so one naming a side no one
 * statement makes whole is refused; the conservative realization's state comparison, the oracle, knows no statement, so
 * the case judges every other read-back, riding or carried. Each ChangeSet is compiled as a served compile compiles it,
 * over the run's declared schema `built` (its artifacts as a fresh installation's, test/support/compile.ts
 * testArtifacts), before any installation: the run's installation drafts its login's workload from the settled
 * ChangeSets as `grizzle generate` drafts it, which refuses a crossing read-back as the case's own compile does, so no
 * ChangeSet the workload holds is one generate refuses (run.ts installTarget).
 */
export const settledCase = (
	built: WBuiltSchema,
	compile: OfflineCompile,
	rc: ResolvedCase
): SettledCase => {
	const settle = (changes: WChangeSet, dropped: boolean): SettledCase => {
		const compiled = compile(
			buildChangeSet(built.value, built.relations, rc.group, changes).changes
		)
		if (compiled.ok || compiled.error.reason._tag !== "ReadBackCrossesStatements") {
			return { ...rc, changes, dropped }
		}
		const read = compiled.error.reason.read
		return settle({ ...changes, reads: Arr.filter(changes.reads, (r) => r.name !== read) }, true)
	}
	return settle(rc.changes, false)
}

/** A ChangeSet value compiled before any installation, its refusal or none (`offlineCompile`). */
export type OfflineCompile = (changes: unknown) => EngineResult.Result<unknown, CompileError>

/**
 * The run's writer over its declared schema `built`, the role the run's login serves (run.ts installTarget), compiling a
 * ChangeSet as a served compile compiles it, over the role's artifacts as a fresh installation's (test/support/compile.ts
 * inputArtifacts), at SERIALIZABLE, the level its compile states (adapter/served/forms.ts writeEntry), for no context:
 * what settles a case's read-backs before its run is installed (`settledCase`).
 */
export const offlineCompile = (built: WBuiltSchema): OfflineCompile => {
	const writer = role(
		built.value,
		"writer",
		wholeEntriesOf(built.value),
		wholeWritesOf(built.value)
	)
	const prepared = EngineResult.flatMap(
		parseRole(writer, SourceLoc("the write oracle's writer", [])),
		(input) =>
			EngineResult.map(inputArtifacts(input, testCompile), (artifacts) => ({ input, artifacts }))
	)
	return (changes) =>
		EngineResult.flatMap(prepared, ({ input, artifacts }) =>
			EngineResult.flatMap(parsedChange(input, changes), (change) =>
				compileParsed(artifacts, change, new Set(), "serializable", noClock, transactionClock)
			)
		)
}

export const runCase = (
	t: WriteTarget,
	rc: SettledCase,
	note: Case<WriteOracleFeature>["note"]
): Effect.Effect<Ran, CaseFailed | CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const { origin, group, facts: drawn } = rc
		/** Notes `feature` when the case reaches it. */
		const noteIf = (reached: boolean, feature: WriteOracleFeature): void => {
			if (reached) {
				note(feature)
			}
		}
		/**
		 * The initial state the case runs from: the drawn facts, repeated under fresh keys when the case's plan
		 * perturbation multiplies them (../perturb.ts); the ChangeSet was drawn over the facts as generated.
		 */
		const perturbation = yield* CurrentPerturbation
		const facts: WFacts = multiplyWriteFacts(group, drawn, perturbation.multiplier)
		const c = rc.changes
		noteIf(rc.dropped, "a read-back refused as crossing statements")
		const { changes, params } = buildChangeSet(t.value, t.built.relations, group, c)
		const header = () =>
			Arr.join(
				[
					...(origin.kind === "planted" ? [`the planted arm "${origin.arm}"`] : []),
					printGroup(group),
					"facts:",
					printFacts(drawn),
					"changes:",
					printChangeSet(c)
				],
				"\n"
			)
		const expected = expectChangeSet({ group, laws: t.laws }, facts, c)
		const entry = programOf(t, changes)
		if (expected.kind === "unorderable") {
			const refused = unorderableProblems(expected, entry)
			if (Arr.isReadonlyArrayNonEmpty(refused)) {
				return yield* new CaseFailed({
					report: Arr.join([header(), `expected: ${printExpected(expected)}`, ...refused], "\n")
				})
			}
			note("an unorderable stratum refused")
			return { group, reads: [] }
		}
		noteShapes(group, c, note)
		if (Result.isFailure(entry)) {
			return yield* new CaseFailed({
				report: `${header()}\nthe ChangeSet does not compile: ${entry.failure.message}`
			})
		}
		const { program } = entry.success
		const baseline = conservativeChange(entry.success, t.ctx)
		if (!baseline.ok) {
			return yield* new CaseFailed({
				report: `${header()}\nthe ChangeSet's conservative realization does not compile: ${baseline.error.message}`
			})
		}
		const entries = { optimized: entry.success, conservative: baseline.value } as const
		const problems: Array<string> = []
		for (const artifact of ["optimized", "conservative"] as const) {
			const audited = yield* Effect.result(
				Effect.try({
					try: () => {
						checkedStatements(
							Arr.map(entries[artifact].program.artifact.statements, (st) => st.ast),
							`${artifact} write statement`
						)
					},
					catch: messageOf
				})
			)
			if (Result.isFailure(audited)) {
				problems.push(audited.failure)
			}
		}
		for (const realization of realizationsOf(program)) {
			note(realization)
		}
		const outcomes: Array<Result.Result<WriteOutcome, unknown>> = []
		for (const artifact of ["optimized", "conservative"] as const) {
			yield* resetGroup(t, group, facts)
			const applied = yield* applyWith(t, entries[artifact].entry, changes, params, perturbation)
			const state = yield* readGroup(t, group)
			outcomes.push(applied.outcome)
			if (applied.flights > 0) {
				note("flight logged")
			}
			for (const p of judgeWrite(group, c, expected, applied.outcome, state)) {
				problems.push(`${artifact}: ${p}`)
			}
			if (problems.length > 0) {
				problems.push(`${artifact} outcome: ${printOutcome(applied.outcome)}`)
			}
		}
		const [optimized, conservative, ...others] = outcomes
		if (optimized !== undefined && conservative !== undefined && others.length === 0) {
			appendAll(problems, agreement(["optimized", optimized], ["conservative", conservative]))
		}
		/**
		 * The second reading: the facts stored otherwise through a fresh reset, another order and one value in its next
		 * spelling, and the side db.apply runs applied again under the complement of the case's plan. Its answer is a
		 * function of the facts, so it gives the oracle's outcome again and agrees exactly with its first reading.
		 */
		const restorage = yield* CurrentRestorage
		const restored = restoredWriteFacts(group, facts, restorage)
		noteIf(restored.reordered, "facts reordered on a second reading")
		noteIf(restored.respelled, "a fact respelled on a second reading")
		const secondPlan = complementOf(perturbation)
		yield* resetGroup(t, group, restored.facts)
		const again = yield* applyWith(t, entry.success.entry, changes, params, secondPlan)
		const againState = yield* readGroup(t, group)
		const readAgain = `optimized, read again over its facts stored otherwise (${restored.reordered ? "reordered" : "in their order"}, ${restored.respelled ? "one value respelled" : "no value respelled"}), ${printPerturbation(secondPlan)}`
		const againProblems = [
			...judgeWrite(group, c, expected, again.outcome, againState),
			...(optimized === undefined
				? []
				: agreement(["optimized", optimized], ["optimized read again", again.outcome]))
		]
		for (const p of againProblems) {
			problems.push(`${readAgain}: ${p}`)
		}
		if (againProblems.length > 0) {
			problems.push(`${readAgain} outcome: ${printOutcome(again.outcome)}`)
		}
		for (const choice of program.choices) {
			note(`put target ${choice.target}`)
		}
		/**
		 * A stated-one read-back, each row it defines with its parent present or absent in the final state, and one over
		 * a deferred containment a refused write violates.
		 */
		const attached = Arr.flatMap(c.reads, (read) =>
			read.parent.kind === "one" ? [{ read, containment: read.parent.containment }] : []
		)
		if (expected.kind === "applied") {
			const readRows = Arr.flatMap(attached, ({ read, containment }) =>
				Arr.map([...expectedReadFacts(expected.outcome, read).values()], (row) => ({
					containment,
					row
				}))
			)
			for (const { containment, row } of readRows) {
				const target = entryOf(
					expected.outcome.state.relations,
					containment.to.relation,
					"the final state's relations"
				)
				note(
					parentOf(group, containment, row, target.values()) === undefined
						? "a stated-one read-back with its parent absent"
						: "a stated-one read-back with its parent present"
				)
			}
		}
		if (expected.kind === "rejected" || expected.kind === "outsideDomain") {
			if (
				Arr.some(attached, ({ containment: x }) =>
					expected.refusals.has(t.laws.containment(x.from.relation, x.from.fields))
				)
			) {
				note("a stated-one read-back over a deferred containment that the write violates")
			}
		}
		if (expected.kind === "applied") {
			note(`outcome ${expected.outcome.kind}`)
			if (origin.kind === "planted" && origin.arm === "deletion meeting nowhere") {
				note("a deletion meeting nowhere unordered beside an addition")
			}
			noteIf(addedThenRemoved(expected.outcome), "an addition a later stratum removes")
		} else if (expected.kind === "outsideDomain") {
			note("outcome outside a domain")
		} else if (expected.kind === "unbound") {
			note("outcome refused at bind")
		} else {
			note("outcome invariant-rejected")
			if (Arr.some(program.artifact.steps, (step) => step.kind === "single")) {
				note("a single statement refused by a law")
			}
			const metKind = Option.flatMap(Arr.head(outcomes), (met) =>
				Result.isSuccess(met) && met.success.kind === "invariant-rejected"
					? refusalKind(t, group, Arr.headNonEmpty(met.success.refused.laws))
					: Option.none()
			)
			if (Option.isSome(metKind)) {
				note(metKind.value)
			}
		}
		/** A TOAST-sized payload among the inputs, and such a case changing nothing or accepted. */
		const values = inputValues(group, c)
		const unchanged = expected.kind === "applied" && expected.outcome.kind === "no-change"
		if (Arr.some(values, (x) => isToastSized(x.value))) {
			note("toast-sized input")
			if (unchanged) {
				note("toast-sized no-change")
			}
			if (expected.kind === "applied" && expected.outcome.kind === "accepted") {
				note("toast-sized accepted")
			}
		}
		if (problems.length > 0) {
			return yield* new CaseFailed({
				report: Arr.join(
					[
						header(),
						`put targets: ${listed(
							Arr.map(program.choices, (x) => `${x.relation} ${x.target} (${x.reason})`),
							", ",
							"none"
						)}`,
						`expected: ${printExpected(expected)}`,
						...problems
					],
					"\n"
				)
			})
		}
		return { group, reads: c.reads }
	})
