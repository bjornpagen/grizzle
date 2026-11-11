import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { CodecFault, EncodingFailure } from "#compiler/core/errors.ts"
import { hasProperties } from "#compiler/core/record.ts"
import * as Engine from "#compiler/core/result.ts"
import type { LiteralBound, MessageBound } from "#compiler/ir/products.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { type Normalization, normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { FactIdentity } from "#compiler/scalar/values/identity.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type {
	EnumeratedInput,
	MemberSlot,
	WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import { closedTableOf, decideBinding } from "#compiler/write/program/decide.ts"
import {
	assert,
	assertVariant,
	bareRecord,
	defined,
	refused,
	succeeded
} from "#test/support/assert.ts"
import { lawIdOf, lawNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type AddWinsOutcome,
	applyAddWins,
	loadedSequences,
	OracleChangeSet,
	type OracleRelation,
	type OracleSchema,
	oracleState
} from "#test/support/oracle/addwins.ts"
import { identityOrder } from "#test/support/oracle/delta.ts"
import { codesOf, compiled, cs, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/** Pair(k, v, c): primary key k, candidate key c. Gen(id serial, k, w): primary key id, candidate key k. Unit(id
 * serial): a relation whose every field is serial, whose generated additions carry no field, the unit relation. Two(a
 * serial, b serial, n): two serial fields, which an addition carries both or neither of.
 *
 * Host normalization of enumerated members, arrays and Streams alike, over one to three strata, checked against the
 * brute-force add-wins calculator: a refusal before SQL is a ChangeSet the add-wins meaning rejects, by a key law some
 * stratum's own facts violate whatever the state, or a stratum that deletes two facts at one value of a key, which
 * (S minus D) union A never shows, by that key's law; and a normalized ChangeSet means exactly what the one it came from
 * means. A fact no relation admits (a NULL, a field its relation lacks, a deletion without its serial field, an
 * addition with some serial fields and not all) is a planted fault, refused by its own fault before anything else.
 *
 * Oracles: the brute-force add-wins calculator (oracle/addwins.ts, a second implementation) and the fact shape each
 * relation admits (a specification). The initial state is lawful by construction, its k and c each drawn once.
 *
 * Features: two and three strata, a Stream member, a refusal by a key, by a key two deletions share and by a key two
 * generated additions share, a later stratum restating an earlier one's key; each planted fault.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): normalize-deletions-unnetted, normalize-deletions-unkeyed,
 * normalize-extra-field-admitted.
 */
const Pair = relation("Pair", { k: pg.integer, v: pg.integer, c: pg.integer }, ["k"])
const Gen = relation("Gen", { id: pg.bigserial, k: pg.integer, w: pg.integer }, ["id"])
const pairC = key(on(Pair, "c"))
const genK = key(on(Gen, "k"))
const Unit = relation("Unit", { id: pg.bigserial }, ["id"])
const Two = relation("Two", { a: pg.bigserial, b: pg.serial, n: pg.integer }, ["a"])
const Small = schema("Small", { Pair, Gen, Unit, Two }, [pairC, genK])

type Category = "put" | "delete" | "insert" | "generated"

/** An enumerated input's member slots by the category of the facts each carries, and the operation that writes them. */
const categorized = (
	input: EnumeratedInput
): ReadonlyArray<{
	readonly category: Category
	readonly op: "put" | "delete" | "insert"
	readonly slot: MemberSlot
}> => {
	switch (input.kind) {
		case "single":
			return [{ category: input.act.op, op: input.act.op, slot: input.slot }]
		case "nested":
			return [{ category: "insert", op: "insert", slot: input.slot }]
		case "classed":
			return [
				{ category: "insert", op: "insert", slot: input.complete },
				{ category: "generated", op: "insert", slot: input.generated }
			]
	}
}

/** A case's strata that hold a member, each at its position among them: the strata its write runs, which a ChangeSet
 * numbers its slot groups by (StratumAt), an empty stratum being the identity it drops. */
const occupiedOf = (strata: ReadonlyArray<ReadonlyArray<Member>>) =>
	strataAt(Arr.filter(strata, (members) => members.length > 0))

/** The facts of the slot of a category on a relation in a stratum: a put's, a deletion's, an insertion's of complete
 * facts, or a generated addition's.
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
			name: "Gen",
			heading: Arr.map(["id", "k", "w"], (f) => ({ name: f, spec: specOf(Gen, f) })),
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Gen), fields: ["id"] },
			keys: [{ law: lawIdOf(Small, genK), fields: ["k"] }],
			serial: ["id"],
			projectedKeys: []
		} satisfies OracleRelation,
		{
			name: "Pair",
			heading: Arr.map(["k", "v", "c"], (f) => ({ name: f, spec: specOf(Pair, f) })),
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Pair), fields: ["k"] },
			keys: [{ law: lawIdOf(Small, pairC), fields: ["c"] }],
			projectedKeys: [],
			serial: []
		} satisfies OracleRelation,
		{
			name: "Unit",
			heading: [{ name: "id", spec: specOf(Unit, "id") }],
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Unit), fields: ["id"] },
			keys: [],
			projectedKeys: [],
			serial: ["id"]
		} satisfies OracleRelation
	]
}

const small = int(1, 3)
type PairFact = { readonly k: number; readonly v: number; readonly c: number }
type GenFact =
	| { readonly k: number; readonly w: number }
	| { readonly id: bigint; readonly k: number; readonly w: number }
/** A fact of Unit: the one empty fact, a generated addition of no field, or a complete one. */
type UnitFact = Readonly<Record<string, never>> | { readonly id: bigint }

/** How a member's facts travel: an array, or a Stream the runtime collects whole. */
type Transport = "array" | "stream"

/** A drawn member: an operation of the change set on one relation, its facts, and how they travel. */
type Member =
	| {
			readonly op: "insert" | "put" | "delete"
			readonly relation: "Pair"
			readonly facts: ReadonlyArray<PairFact>
			readonly transport: Transport
	  }
	| {
			readonly op: "insert"
			readonly relation: "Gen"
			readonly facts: ReadonlyArray<GenFact>
			readonly transport: Transport
	  }
	| {
			readonly op: "insert"
			readonly relation: "Unit"
			readonly facts: ReadonlyArray<UnitFact>
			readonly transport: Transport
	  }

const pairFact = (source: Source): PairFact => ({
	k: source.draw(small),
	v: source.draw(int(1, 2)),
	c: source.draw(small)
})
const genFact = oneOf<GenFact>([
	(source) => ({ k: source.draw(small), w: source.draw(int(1, 2)) }),
	(source) => ({
		id: source.draw(bigint(1n, 3n)),
		k: source.draw(small),
		w: source.draw(int(1, 2))
	})
])
const unitFact = oneOf<UnitFact>([() => ({}), (source) => ({ id: source.draw(bigint(1n, 3n)) })])

const transport = element(["array", "stream"] as const)

const memberGen = oneOf<Member>([
	(source) => ({
		op: source.draw(element(["insert", "put", "delete"] as const)),
		relation: "Pair",
		facts: source.draw(array(pairFact, { min: 0, max: 3 })),
		transport: source.draw(transport)
	}),
	(source) => ({
		op: "insert",
		relation: "Gen",
		facts: source.draw(array(genFact, { min: 0, max: 3 })),
		transport: source.draw(transport)
	}),
	(source) => ({
		op: "insert",
		relation: "Unit",
		facts: source.draw(array(unitFact, { min: 0, max: 3 })),
		transport: source.draw(transport)
	})
])

const membersGen = array(memberGen, { min: 0, max: 4 })

/** One to three strata of members. */
const strataGen = array(membersGen, { min: 1, max: 3 })

/** Pair's values of k and of c. */
const pairValues = [1, 2, 3] as const

/** A lawful initial state, distinct k and distinct c by construction: as many of each, each drawn once. */
const initial: Gen<ReadonlyArray<PairFact>> = (source) => {
	const ks = source.draw(shuffled(pairValues, { min: 0, max: pairValues.length }))
	const cs = source.draw(shuffled(pairValues, { min: ks.length, max: ks.length }))
	return Arr.map(Arr.zip(ks, cs), ([k, c]) => ({ k, v: source.draw(int(1, 2)), c }))
}

const relationValues = { Pair, Gen, Unit, Two } as const

/** Facts as a member carries them: the array itself, or a Stream of it. */
const sent = (
	facts: ReadonlyArray<unknown>,
	how: Transport
): ReadonlyArray<unknown> | Stream.Stream<unknown> =>
	how === "array" ? facts : Stream.fromIterable(facts)

/** A stratum's members added to a ChangeSet in turn, each an array or a Stream of its facts. */
const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
	Arr.reduce(members, cs(Small), (changes, m) =>
		changes[m.op](relationValues[m.relation], sent(m.facts, m.transport))
	)

/**
 * The longest prefix of `members` whose ChangeSet normalizes, the empty one at least: the ChangeSet a fault is planted
 * in, so nothing but the fault refuses it, by construction.
 */
const normalizingPrefix = (members: ReadonlyArray<Member>) =>
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
		Arr.reduce(members, OracleChangeSet.empty(), (raw, m) => raw[m.op](m.relation, m.facts))
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
const normalizedOf = (changes: ChangeSetValue) =>
	Effect.gen(function* () {
		const frontend = compiled(Small, changes)
		const binding = decideBinding(frontend)
		const prepared = prepareBinding(
			binding,
			frontend.codes,
			closedTableOf(frontend),
			new CompilePatterns()
		)
		const facts = yield* collectInputs(binding.groups, parsedOf(changes).inputs)
		return {
			frontend,
			result: withinBounds(
				normalizeChangeSet(
					prepared.groups,
					{ fill: prepared.fill, codes: frontend.codes },
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
			Order.mapInput(Order.String, ([r]: readonly [string, ReadonlyArray<FactIdentity>]) => r)
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
			new Set(
				Arr.flatMap(ms, (m: Member) =>
					m.op === op && m.relation === "Pair" ? Arr.map(m.facts, pairText) : []
				)
			)
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

/** What a case reaches: strata, Streams, a refusal, and a key a later stratum restates differently, admitted. */
type NormalizeFeature =
	| "two strata"
	| "three strata"
	| "a Stream member"
	| "refused by a key"
	| "refused by a key two deletions share"
	| "refused by a key two generated additions share"
	| "a later stratum restates an earlier stratum's key"

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
				Arr.flatMap(ms, (m) => (m.relation === "Pair" && m.op === "delete" ? m.facts : [])),
				(f, g) => pairText(f) === pairText(g)
			)
			return Arr.flatMap(["k", "c"] as const, (field) =>
				Arr.some(deleted, (f, i) => Arr.some(deleted, (g, j) => i !== j && f[field] === g[field]))
					? [pairKeys[field]]
					: []
			)
		})
	)

/**
 * Whether a stratum adds two generated facts of Gen, different in w, at one k: a pair Gen's key on k holds apart, a key
 * no sequence draws a field of, at which the host compares generated additions too (write/normalize sameKey).
 */
const generatedAtOneK = (strata: ReadonlyArray<ReadonlyArray<Member>>): boolean =>
	Arr.some(strata, (ms) => {
		const generated = Arr.flatMap(ms, (m) =>
			m.relation === "Gen" ? Arr.filter(m.facts, (f) => !("id" in f)) : []
		)
		return Arr.some(generated, (f, i) =>
			Arr.some(generated, (g, j) => i !== j && f.k === g.k && f.w !== g.w)
		)
	})

/** Whether a later stratum adds a Pair fact at the key of a different one an earlier stratum adds. */
const restated = (strata: ReadonlyArray<ReadonlyArray<Member>>): boolean => {
	const added = Arr.map(strata, (ms) =>
		Arr.flatMap(ms, (m) => (m.relation === "Pair" && m.op !== "delete" ? m.facts : []))
	)
	return Arr.some(added, (early, s) =>
		Arr.some(added.slice(s + 1), (late) =>
			Arr.some(early, (f) => Arr.some(late, (g) => g.k === f.k && pairText(g) !== pairText(f)))
		)
	)
}

/** The property over one case (see the header). */
const normalizes = (
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
		const state = oracleState(oracleSchema, { Pair: start }, loadedSequences)
		const expected = applyAddWins(oracleSchema, state, oracleOf(strata), { kind: "sequences" })
		const { frontend, result } = yield* normalizedOf(changeSetOf(strata))
		const normalization = succeeded(result, "a ChangeSet of admitted facts normalizes")
		const deleted = deletedAtOneKey(strata)
		if (normalization.kind === "keyConflict") {
			if (Arr.contains(deleted, normalization.law)) {
				c.note("refused by a key two deletions share")
				return
			}
			c.note("refused by a key")
			if (normalization.law === lawIdOf(Small, genK) && generatedAtOneK(strata)) {
				c.note("refused by a key two generated additions share")
			}
			assert.equal(expected.kind, "invariant-rejected", "the add-wins meaning rejects it too")
			const empty = oracleState(oracleSchema, {}, loadedSequences)
			assert.ok(
				Arr.some(strata, (ms) => {
					const alone = applyAddWins(oracleSchema, empty, oracleOf([ms]), { kind: "sequences" })
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
		assert.deepEqual(
			deleted,
			[],
			"a stratum that deletes two facts at one key is refused by that key"
		)
		assert.equal(
			generatedAtOneK(strata),
			false,
			"a stratum that adds two generated facts of Gen at one k is refused by Gen's key"
		)
		if (strata.length >= 2 && restated(strata)) {
			c.note("a later stratum restates an earlier stratum's key")
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
				OracleChangeSet.sequence(OracleChangeSet.empty(), ...argumentsOf(rebuilt)),
				{ kind: "sequences" }
			),
			expected
		)
	})

/** A fact no relation admits, planted among valid members (see the header). */
type Fault =
	| "a NULL field"
	| "a field its relation lacks"
	| "a deletion without its serial field"
	| "some serial fields and not all"

const faults: Arr.NonEmptyReadonlyArray<Fault> = [
	"a NULL field",
	"a field its relation lacks",
	"a deletion without its serial field",
	"some serial fields and not all"
]

/** The fault a planted fact is refused with: a NULL by the null ban, any other shape by factShape. */
const faultOf = (fault: Fault): CodecFault => (fault === "a NULL field" ? "nullValue" : "factShape")

/** The planted member: one fact carrying the fault, under a drawn operation where the fault allows one. */
const plantedGen =
	(fault: Fault): Gen<(changes: ChangeSetValue) => ChangeSetValue> =>
	(source) => {
		const op = source.draw(element(["insert", "put", "delete"] as const))
		const k = source.draw(small)
		const c = source.draw(small)
		switch (fault) {
			case "a NULL field":
				return (changes) => changes[op](Pair, [{ k, v: null, c }])
			case "a field its relation lacks":
				return (changes) => changes[op](Pair, [{ k, v: 1, c, x: 1 }])
			case "a deletion without its serial field":
				return (changes) => changes.delete(Gen, [bareRecord({ k, w: 1 })])
			case "some serial fields and not all":
				return (changes) => changes.insert(Two, [{ a: BigInt(k), n: c }])
		}
	}

describe("normalization against the add-wins meaning", () => {
	it.effect(
		"refuses only what add-wins rejects with that key law, and keeps the meaning of what it passes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/normalize-5003",
						draw: drawn((source) => [source.draw(initial), source.draw(strataGen)] as const),
						literal: Formatter.format,
						coverage: required<NormalizeFeature>(
							[
								"two strata",
								"three strata",
								"a Stream member",
								"refused by a key",
								"refused by a key two deletions share",
								"refused by a key two generated additions share",
								"a later stratum restates an earlier stratum's key"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "second-implementation", name: "the brute-force add-wins calculator" }
					},
					([start, strata], c) => normalizes(start, strata, c)
				)
			)
	)

	it.effect(
		"refuses a planted fact no relation admits by its own fault, and admits the ChangeSet without it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/normalize-faults",
						draw: drawn(
							(source) =>
								[
									source.draw(array(memberGen, { min: 0, max: 2 })),
									source.draw(element(faults))
								] as const
						),
						literal: Formatter.format,
						coverage: required<Fault>(faults, { cases: 100, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "the fact shape each relation admits" }
					},
					([members, fault], c) =>
						Effect.gen(function* () {
							c.note(fault)
							const plant = c.draw(plantedGen(fault))
							const prefix = yield* normalizingPrefix(members)
							const valid = stratumOf(prefix)
							refused((yield* normalizedOf(plant(valid))).result, faultOf(fault))
						})
				)
			)
	)
})
