/** What the properties of normalize.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { array, element, int, shuffled } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Option, Order, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { CodecFault, EncodingFailure } from "#compiler/core/errors.ts"
import { hasProperties } from "#compiler/core/record.ts"
import type { LiteralBound, MessageBound } from "#compiler/ir/products.ts"
import { strataAt, type StratumAt } from "#compiler/ir/stratum.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { type Normalization, normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type {
	EnumeratedInput,
	MemberSlot,
	WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import { decideBinding } from "#compiler/write/program/decide.ts"
import { bareRecord, succeeded } from "#test/support/assert.ts"
import { lawIdOf, lawNamesOf } from "#test/support/kernel/naming.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type AddWinsOutcome,
	applyAddWins,
	OracleChangeSet,
	type OracleRelation,
	type OracleSchema,
	oracleState
} from "#test/support/oracle/addwins.ts"
import { type FactTexts, identityOrder } from "#test/support/oracle/delta.ts"
import { codesOf, compiled, cs, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** Pair(k, v, c): primary key k, candidate key c. */
const Pair = relation("Pair", { k: pg.integer, v: pg.integer, c: pg.integer }, ["k"])

const pairC = key(on(Pair, "c"))

/** The schema of Pair, with its candidate key on c, mutable inside the unit of its k. */
const Small = schema("Small", [Pair], [pairC, unit("Ks", { k: pg.integer }), mutable(Pair)])

type Category = "put" | "delete" | "insert"

/** An enumerated input's member slots by the category of the facts each carries, and the operation that writes them. */
const categorized = (
	input: EnumeratedInput
): ReadonlyArray<{
	readonly category: Category
	readonly op: "put" | "delete" | "insert"
	readonly slot: MemberSlot
}> => {
	switch (input.kind) {
		case "single": {
			const op = input.act.op
			return [{ category: op, op, slot: input.slot }]
		}
		case "nested":
			return [{ category: "insert", op: "insert", slot: input.slot }]
	}
}

/** A case's strata that hold a member, each at its position among them: the strata its write runs, which a ChangeSet
 * numbers its slot groups by (StratumAt), an empty stratum being the identity it drops. */
const occupiedOf = (strata: ReadonlyArray<ReadonlyArray<Member>>) =>
	strataAt(Arr.filter(strata, (members) => members.length > 0))

/** The facts of the slot of a category on a relation in a stratum: a put's, a deletion's or an insertion's.
 *
 * No slot of `op` on the relation holds no fact; normalization sets every slot there is. */
const slotFacts = (
	n: Extract<Normalization, { readonly kind: "normalized" }>,
	frontend: WriteFrontend,
	stratum: StratumAt,
	category: Category,
	relationName: string
) => {
	const slot = Arr.findFirst(
		Arr.flatMap(frontend.slots, (g) =>
			g.stratum === stratum && g.relation.name === relationName
				? Arr.flatMap(g.inputs, categorized)
				: []
		),
		(s) => s.category === category
	)
	return Option.isNone(slot)
		? []
		: defined(n.slots.get(slot.value.slot.slot), `the normalized slot ${slot.value.slot.slot}`)
				.facts
}

const specOf = (relationValue: { readonly name: string }, field: string) => {
	const frontend = compiled(Small, cs(Small))
	const c = Option.fromUndefinedOr(frontend.schema.relations.get(relationValue.name)).pipe(
		Option.flatMap((r) => Arr.findFirst(r.heading, (h) => h.name === field))
	)
	if (Option.isNone(c)) {
		throw new Error(field)
	}
	return scalarCodec(c.value.type, codesOf(Small)).spec
}

const oracleSchema: OracleSchema = {
	relations: [
		{
			name: "Pair",
			heading: Arr.map(["k", "v", "c"], (f) => ({ name: f, spec: specOf(Pair, f) })),
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Pair), fields: ["k"] },
			keys: [{ law: lawIdOf(Small, pairC), fields: ["c"] }],
			projectedKeys: []
		} satisfies OracleRelation
	]
}

const small = int(1, 3)

type PairFact = { readonly k: number; readonly v: number; readonly c: number }

/** How a member's facts travel: an array, or a Stream the runtime collects whole. */
type Transport = "array" | "stream"

/** A drawn member: an operation of the change set on Pair, its facts, and how they travel. */
interface Member {
	readonly op: "insert" | "put" | "delete"
	readonly facts: ReadonlyArray<PairFact>
	readonly transport: Transport
}

const pairFact = (source: Source): PairFact => ({
	k: source.draw(small),
	v: source.draw(int(1, 2)),
	c: source.draw(small)
})

const transport = element(["array", "stream"] as const)

export const memberGen = (source: Source): Member => ({
	op: source.draw(element(["insert", "put", "delete"] as const)),
	facts: source.draw(array(pairFact, { min: 0, max: 3 })),
	transport: source.draw(transport)
})

const membersGen = array(memberGen, { min: 0, max: 4 })

/** One to three strata of members. */
const strataGen = array(membersGen, { min: 1, max: 3 })

/** Pair's values of k and of c. */
const pairValues = [1, 2, 3] as const

/** A lawful initial state, distinct k and distinct c by construction: as many of each, each drawn once. */
const initial = (source: Source): ReadonlyArray<PairFact> => {
	const ks = source.draw(shuffled(pairValues, { min: 0, max: pairValues.length }))
	const cs = source.draw(shuffled(pairValues, { min: ks.length, max: ks.length }))
	return Arr.map(Arr.zip(ks, cs), ([k, c]) => ({ k, v: source.draw(int(1, 2)), c }))
}

/** A case: a lawful initial state and one to three strata of members. */
export const caseGen = (source: Source) => [source.draw(initial), source.draw(strataGen)] as const

/**
 * A case aimed at a later stratum restating an earlier one's key: a lawful initial state and two strata, each adding
 * one Pair fact by an insert or a put, the second at the first's k with the other v, so it states that key otherwise.
 */
export const restatingGen = (source: Source) => {
	const first = source.draw(pairFact)
	const second: PairFact = { k: first.k, v: 3 - first.v, c: source.draw(small) }
	const adding = (fact: PairFact): Member => ({
		op: source.draw(element(["insert", "put"] as const)),
		facts: [fact],
		transport: source.draw(transport)
	})
	return [source.draw(initial), [[adding(first)], [adding(second)]]] as const
}

/**
 * A case aimed at a fact one stratum both deletes and adds: a lawful initial state and one stratum that deletes a Pair
 * fact and inserts or puts it again, each member an array or a Stream, which normalization nets to the addition.
 */
export const nettingGen = (source: Source) => {
	const fact = source.draw(pairFact)
	const member = (op: "insert" | "put" | "delete"): Member => ({
		op,
		facts: [fact],
		transport: source.draw(transport)
	})
	return [
		source.draw(initial),
		[[member("delete"), member(source.draw(element(["insert", "put"] as const)))]]
	] as const
}

/** Facts as a member carries them: the array itself, or a Stream of it. */
const sent = (
	facts: ReadonlyArray<unknown>,
	how: Transport
): ReadonlyArray<unknown> | Stream.Stream<unknown> =>
	how === "array" ? facts : Stream.fromIterable(facts)

/** A stratum's members added to a ChangeSet in turn, each an array or a Stream of its facts. */
export const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
	Arr.reduce(members, cs(Small), (changes, m) => changes[m.op](Pair, sent(m.facts, m.transport)))

/**
 * The longest prefix of `members` whose ChangeSet normalizes, the empty one at least: the ChangeSet a fault is planted
 * in, so nothing but the fault refuses it, by construction.
 */
export const normalizingPrefix = (members: ReadonlyArray<Member>) =>
	Effect.gen(function* () {
		for (let length = members.length; length > 0; length -= 1) {
			const prefix = Arr.take(members, length)
			const { result } = yield* normalizedOf(stratumOf(prefix))
			if (result.ok && result.value.kind === "normalized") {
				return prefix
			}
		}
		return []
	})

/** The strata sequenced. */
const changeSetOf = (strata: ReadonlyArray<ReadonlyArray<Member>>): ChangeSetValue => {
	const [first, ...rest] = Arr.map(strata, stratumOf)
	return Arr.reduce(rest, defined(first, "a first stratum"), (a, b) => ChangeSet.sequence(a, b))
}

/** The strata as the oracle's ChangeSet. */
const oracleOf = (strata: ReadonlyArray<ReadonlyArray<Member>>): OracleChangeSet => {
	const [first, ...rest] = Arr.map(strata, (members) =>
		Arr.reduce(members, OracleChangeSet.empty(), (raw, m) => raw[m.op]("Pair", m.facts))
	)
	return OracleChangeSet.sequence(defined(first, "a first stratum"), ...argumentsOf(rest))
}

/**
 * A normalization's result, its failure a codec's: no ChangeSet these cases draw is past the message bound, so a bound
 * here is the case's own error.
 */
const withinBounds = (
	result: Engine.Result<Normalization, EncodingFailure | LiteralBound | MessageBound>
): Engine.Result<Normalization, EncodingFailure> => {
	if (result.ok) {
		return result
	}
	const failure = result.error
	if (failure._tag !== "EncodingFailure") {
		throw new Error(`a drawn ChangeSet refused as too large: ${failure._tag}`)
	}
	return Engine.err(failure)
}

/** A ChangeSet compiled over Small and normalized with its members collected as the runtime collects them. */
export const normalizedOf = (changes: ChangeSetValue) =>
	Effect.gen(function* () {
		const frontend = compiled(Small, changes)
		const binding = decideBinding(frontend)
		const prepared = prepareBinding(
			binding,
			frontend.codes,
			closedTableOf(frontend.schema),
			new CompilePatterns()
		)
		const facts = yield* collectInputs(binding.groups, parsedOf(changes).inputs)
		return {
			frontend,
			result: withinBounds(
				normalizeChangeSet(
					prepared.groups,
					{ fill: prepared.fill, codes: frontend.codes, columns: prepared.columns },
					prepared.evaluate,
					facts,
					inForce(bindFrame)
				)
			)
		}
	})

const sameOutcome = (a: AddWinsOutcome, b: AddWinsOutcome): void => {
	assert.equal(a.kind, b.kind)
	if (a.kind === "invariant-rejected" || b.kind === "invariant-rejected") {
		assert.equal(a.kind === "invariant-rejected" && a.law, b.kind === "invariant-rejected" && b.law)
		return
	}
	assert.deepEqual(a.counts, b.counts)
	const facts = (o: typeof a) =>
		Arr.sort(
			Arr.map(
				[...o.state.relations],
				([r, s]) => [r, Arr.sort([...s.keys()], identityOrder)] as const
			),
			Order.mapInput(Order.String, ([r]: readonly [string, ReadonlyArray<FactTexts>]) => r)
		)
	assert.deepEqual(facts(a), facts(b))
}

const pairText = (f: unknown): string => {
	if (!hasProperties(f)) {
		throw new Error("a Pair fact is a record")
	}
	return `${String(f["k"])},${String(f["v"])},${String(f["c"])}`
}

/** The structural rules of normalization over Pair in each stratum, which add-wins equivalence alone cannot see: a fact
 * left both put and deleted means the same under S' = (S minus D) union A, yet the realization would delete it and put
 * it back, counting both. The slots hold exactly the raw sets after collapse (each operation's facts one set), the put
 * owning a fact an insert also requests, and additions winning over deletions: so the deletions are disjoint from the
 * additions and no fact is both inserted and put. */
const slotInvariants = (
	frontend: WriteFrontend,
	result: Extract<Normalization, { readonly kind: "normalized" }>,
	strata: ReadonlyArray<ReadonlyArray<Member>>
): void => {
	for (const [s, ms] of occupiedOf(strata)) {
		const raw = (op: string): ReadonlySet<string> =>
			new Set(Arr.flatMap(ms, (m: Member) => (m.op === op ? Arr.map(m.facts, pairText) : [])))
		const [rawInsert, rawPut, rawDelete] = [raw("insert"), raw("put"), raw("delete")]
		const slot = (category: "put" | "delete" | "insert") =>
			Arr.map(slotFacts(result, frontend, s, category, "Pair"), pairText)
		const [insert, put, del] = [slot("insert"), slot("put"), slot("delete")]
		for (const list of [insert, put, del]) {
			assert.equal(new Set(list).size, list.length)
		}
		assert.deepEqual(
			Arr.filter(insert, (f) => put.includes(f)),
			[]
		)
		assert.deepEqual(
			Arr.filter(del, (f) => insert.includes(f) || put.includes(f)),
			[]
		)
		assert.deepEqual(Arr.sort([...put], Order.String), Arr.sort([...rawPut], Order.String))
		assert.deepEqual(
			Arr.sort([...insert], Order.String),
			Arr.sort(
				Arr.filter([...rawInsert], (f) => !rawPut.has(f)),
				Order.String
			)
		)
		assert.deepEqual(
			Arr.sort([...del], Order.String),
			Arr.sort(
				Arr.filter([...rawDelete], (f) => !rawInsert.has(f) && !rawPut.has(f)),
				Order.String
			)
		)
	}
}

/** What a case reaches: strata, Streams, a refusal, a key a later stratum restates differently, admitted, and a fact
 * one stratum both deletes and adds. */
export type NormalizeFeature =
	| "two strata"
	| "three strata"
	| "a Stream member"
	| "refused by a key"
	| "two deletions at one key, normalized"
	| "a later stratum restates an earlier stratum's key"
	| "a fact a stratum both deletes and adds, netted"

/** Pair's key laws, by the field each compares. */
const pairKeys = {
	k: lawNamesOf(Small).primaryKeyLaw(Pair),
	c: lawIdOf(Small, pairC)
} as const

/** The key laws of Pair two distinct facts one stratum deletes share a value of. */
const deletedAtOneKey = (strata: ReadonlyArray<ReadonlyArray<Member>>) =>
	Arr.dedupe(
		Arr.flatMap(strata, (ms) => {
			const deleted = Arr.dedupeWith(
				Arr.flatMap(ms, (m) => (m.op === "delete" ? m.facts : [])),
				(f, g) => pairText(f) === pairText(g)
			)
			return Arr.flatMap(["k", "c"] as const, (field) =>
				Arr.some(deleted, (f, i) => Arr.some(deleted, (g, j) => i !== j && f[field] === g[field]))
					? [pairKeys[field]]
					: []
			)
		})
	)

/** Whether a later stratum adds a Pair fact at the key of a different one an earlier stratum adds. */
const restated = (strata: ReadonlyArray<ReadonlyArray<Member>>): boolean => {
	const added = Arr.map(strata, (ms) => Arr.flatMap(ms, (m) => (m.op !== "delete" ? m.facts : [])))
	return Arr.some(added, (early, s) =>
		Arr.some(added.slice(s + 1), (late) =>
			Arr.some(early, (f) => Arr.some(late, (g) => g.k === f.k && pairText(g) !== pairText(f)))
		)
	)
}

/** Whether a stratum deletes a Pair fact it also inserts or puts, which its normalization nets to the addition. */
const netted = (strata: ReadonlyArray<ReadonlyArray<Member>>): boolean =>
	Arr.some(strata, (ms) => {
		const pairs = (added: boolean) =>
			new Set(
				Arr.flatMap(ms, (m) => ((m.op !== "delete") === added ? Arr.map(m.facts, pairText) : []))
			)
		const added = pairs(true)
		return Arr.some([...pairs(false)], (f) => added.has(f))
	})

/** The property over one case (see the header). */
export const normalizes = (
	start: ReadonlyArray<PairFact>,
	strata: ReadonlyArray<ReadonlyArray<Member>>,
	c: Case<NormalizeFeature>
) =>
	Effect.gen(function* () {
		if (strata.length >= 2) {
			c.note(strata.length === 2 ? "two strata" : "three strata")
		}
		if (Arr.some(Arr.flatten(strata), (m) => m.transport === "stream")) {
			c.note("a Stream member")
		}
		const state = oracleState(oracleSchema, { Pair: start })
		const expected = applyAddWins(oracleSchema, state, oracleOf(strata))
		const { frontend, result } = yield* normalizedOf(changeSetOf(strata))
		const normalization = succeeded(result, "a ChangeSet of admitted facts normalizes")
		if (normalization.kind === "keyConflict") {
			c.note("refused by a key")
			assert.equal(expected.kind, "invariant-rejected", "the add-wins meaning rejects it too")
			const empty = oracleState(oracleSchema, {})
			assert.ok(
				Arr.some(strata, (ms) => {
					const alone = applyAddWins(oracleSchema, empty, oracleOf([ms]))
					return (
						alone.kind === "invariant-rejected" &&
						Arr.some(alone.violations, (v) => v.law === normalization.law)
					)
				}),
				"the refusal's law is one a stratum's own facts violate whatever the state"
			)
			return
		}
		assertVariant(normalization, "kind", "normalized", "Small has no generated field to refuse")
		if (deletedAtOneKey(strata).length > 0) {
			c.note("two deletions at one key, normalized")
		}
		if (strata.length >= 2 && restated(strata)) {
			c.note("a later stratum restates an earlier stratum's key")
		}
		if (netted(strata)) {
			c.note("a fact a stratum both deletes and adds, netted")
		}
		slotInvariants(frontend, normalization, strata)
		const rebuilt = Arr.map(occupiedOf(strata), ([s]) =>
			Arr.reduce(
				Arr.filter(frontend.slots, (g) => g.stratum === s),
				OracleChangeSet.empty(),
				(raw, group) =>
					Arr.reduce(Arr.flatMap(group.inputs, categorized), raw, (acc, { op, slot }) =>
						acc[op](group.relation.name, normalization.slots.get(slot.slot)?.facts ?? [])
					)
			)
		)
		sameOutcome(
			applyAddWins(
				oracleSchema,
				state,
				OracleChangeSet.sequence(OracleChangeSet.empty(), ...argumentsOf(rebuilt))
			),
			expected
		)
	})

/** A fact no relation admits, planted among valid members (see the header). */
export type Fault = "a NULL field" | "a field its relation lacks" | "a field its fact lacks"

export const faults: Arr.NonEmptyReadonlyArray<Fault> = [
	"a NULL field",
	"a field its relation lacks",
	"a field its fact lacks"
]

/** The fault a planted fact is refused with: a NULL by the null ban, any other shape by factShape. */
export const faultOf = (fault: Fault): CodecFault =>
	fault === "a NULL field" ? "nullValue" : "factShape"

/** The planted member: one fact carrying the fault, under a drawn operation where the fault allows one. */
export const plantedGen =
	(fault: Fault) =>
	(source: Source): ((changes: ChangeSetValue) => ChangeSetValue) => {
		const op = source.draw(element(["insert", "put", "delete"] as const))
		const k = source.draw(small)
		const c = source.draw(small)
		switch (fault) {
			case "a NULL field":
				return (changes) => changes[op](Pair, [{ k, v: null, c }])
			case "a field its relation lacks":
				return (changes) => changes[op](Pair, [{ k, v: 1, c, x: 1 }])
			case "a field its fact lacks":
				return (changes) => changes[op](Pair, [bareRecord({ k, c })])
		}
	}
