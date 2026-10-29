import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { array, element, int, map, oneOf, uniqueArray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import {
	type MemberFacts,
	type Normalization,
	normalizeChangeSet
} from "#compiler/write/normalize/normalize.ts"
import { assert, contains, defined, bareRecord, refused, succeeded } from "#test/support/assert.ts"
import { lawIdOf, lawNamesOf } from "#test/support/kernel/naming.ts"
import {
	type AddWinsOutcome,
	applyAddWins,
	loadedSequences,
	OracleChangeSet,
	type OracleRelation,
	type OracleSchema,
	oracleState
} from "#test/support/oracle/addwins.ts"
import { compiled, cs, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/** Pair(k, v, c): primary key k, candidate key c. Gen(id serial, k, w): primary key id, candidate key k.
 *
 * Host normalization of enumerated members,
 * pinned by examples and checked against the brute-force add-wins calculator: a
 * refusal before SQL is a ChangeSet the add-wins meaning rejects with that key law, and a normalized ChangeSet means
 * exactly what the one it came from means. */
const Pair = relation("Pair", { k: pg.integer, v: pg.integer, c: pg.integer }, ["k"])
const Gen = relation("Gen", { id: pg.bigserial, k: pg.integer, w: pg.integer }, ["id"])
const pairC = key(Pair, ["c"])
const genK = key(Gen, ["k"])
const Small = schema("Small", { Pair, Gen }, [pairC, genK])

const inputsOf = (changes: unknown): MemberFacts => {
	const out = new Map<string, Iterable<unknown>>()
	for (const [slot, input] of parsedOf(changes).inputs) {
		if (input.kind === "array") {
			out.set(slot, input.facts)
		}
	}
	return out
}

const run = (
	changes: unknown
): { readonly frontend: WriteFrontend; readonly result: Normalization } => {
	const frontend = compiled(Small, changes)
	const r = succeeded(normalizeChangeSet(frontend, inputsOf(changes)))
	return { frontend, result: r }
}

/** The facts of the slot of a category on a relation: a put's, a deletion's, an insertion's of complete facts, or a
 * generated addition's.
 *
 * No slot of `op` on the relation holds no fact; normalization sets every slot there is. */
const slotFacts = (
	n: Normalization,
	frontend: WriteFrontend,
	category: "put" | "delete" | "insert" | "generated",
	relationName: string
) => {
	if (n.kind !== "normalized") {
		throw new Error(`refused: ${n.relation} ${Arr.join(n.fields, ",")}`)
	}
	const slot = Arr.findFirst(
		Arr.flatMap(frontend.slots, (g) => (g.relation.name === relationName ? g.slots : [])),
		(s) =>
			(s.op === "insert" ? (s.serial === "generated" ? "generated" : "insert") : s.op) === category
	)
	return Option.isNone(slot)
		? []
		: defined(n.slots.get(slot.value.slot), `the normalized slot ${slot.value.slot}`).facts
}

describe("collapse", () => {
	it("makes equal generated additions one requested addition", () => {
		const { frontend, result } = run(
			cs(Small).insert(Gen, [
				{ k: 1, w: 1 },
				{ k: 1, w: 1 }
			])
		)
		assert.deepEqual(slotFacts(result, frontend, "generated", "Gen"), [bareRecord({ k: 1, w: 1 })])
		assert.deepEqual(slotFacts(result, frontend, "insert", "Gen"), [])
	})
})

describe("same-key refusal before SQL", () => {
	it("judges each stratum alone: a later stratum may replace what an earlier one added", () => {
		const { result } = run(
			ChangeSet.sequence(
				cs(Small).insert(Pair, [{ k: 1, v: 1, c: 1 }]),
				cs(Small).put(Pair, [{ k: 1, v: 2, c: 1 }])
			)
		)
		assert.equal(result.kind, "normalized")
	})
})

describe("admission", () => {
	it("refuses a null field, an extra field and an addition that omits some serial fields but not all", () => {
		const normalized = (changes: unknown) =>
			normalizeChangeSet(compiled(Small, changes), inputsOf(changes))
		refused(normalized(cs(Small).insert(Pair, [{ k: 1, v: null, c: 1 }])), "nullValue")
		refused(normalized(cs(Small).insert(Pair, [{ k: 1, v: 1, c: 1, x: 1 }])), "factShape")
		refused(normalized(cs(Small).delete(Gen, [bareRecord({ k: 1, w: 1 })])), "factShape")
		const Two = relation("Two", { a: pg.bigserial, b: pg.serial, n: pg.integer }, ["a"])
		const changes = cs(schema("TwoS", { Two }, [])).insert(Two, [{ a: 1n, n: 1 }])
		const frontend = compiled(schema("TwoS", { Two }, []), changes)
		refused(normalizeChangeSet(frontend, inputsOf(changes)), "factShape")
	})
})

describe("Stream members", () => {
	it.live("are collected up to the cap and normalized like arrays", () =>
		Effect.gen(function* () {
			const changes = cs(Small).insert(
				Pair,
				Stream.fromIterable([
					{ k: 1, v: 1, c: 1 },
					{ k: 1, v: 1, c: 1 }
				])
			)
			const frontend = compiled(Small, changes)
			const inputs = parsedOf(changes).inputs
			const collected = yield* collectInputs(frontend, inputs, recordsetMaxRows)
			const r = succeeded(normalizeChangeSet(frontend, collected))
			assert.deepEqual(slotFacts(r, frontend, "insert", "Pair"), [bareRecord({ k: 1, v: 1, c: 1 })])
			/** A cap below the Stream's two facts, passed as the cap's own parameter, refuses it before any SQL. */
			const over = yield* Effect.flip(collectInputs(frontend, inputs, 1))
			assert.equal(over._tag, "InputTooLarge")
		})
	)
})

const specOf = (relationValue: { readonly name: string }, field: string) => {
	const frontend = compiled(Small, cs(Small))
	const c = Option.fromUndefinedOr(frontend.schema.relations.get(relationValue.name)).pipe(
		Option.flatMap((r) => Arr.findFirst(r.heading, (h) => h.name === field))
	)
	if (Option.isNone(c)) {
		throw new Error(field)
	}
	return scalarCodec(c.value.type).spec
}

const oracleSchema: OracleSchema = {
	relations: [
		{
			name: "Gen",
			heading: Arr.map(["id", "k", "w"], (f) => ({ name: f, spec: specOf(Gen, f) })),
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Gen), fields: ["id"] },
			keys: [{ law: lawIdOf(Small, genK), fields: ["k"] }],
			serial: ["id"],
			partialKeys: []
		} satisfies OracleRelation,
		{
			name: "Pair",
			heading: Arr.map(["k", "v", "c"], (f) => ({ name: f, spec: specOf(Pair, f) })),
			primaryKey: { law: lawNamesOf(Small).primaryKeyLaw(Pair), fields: ["k"] },
			keys: [{ law: lawIdOf(Small, pairC), fields: ["c"] }],
			partialKeys: [],
			serial: []
		} satisfies OracleRelation
	]
}

const small = int(1, 3)
type PairFact = { readonly k: number; readonly v: number; readonly c: number }
type GenFact =
	| { readonly k: number; readonly w: number }
	| { readonly id: bigint; readonly k: number; readonly w: number }
/** A drawn member: an operation of the change set on one relation and its facts. */
type Member =
	| {
			readonly op: "insert" | "put" | "delete"
			readonly relation: "Pair"
			readonly facts: ReadonlyArray<PairFact>
	  }
	| { readonly op: "insert"; readonly relation: "Gen"; readonly facts: ReadonlyArray<GenFact> }

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

const members = array(
	oneOf<Member>([
		(source) => ({
			op: source.draw(element(["insert", "put", "delete"] as const)),
			relation: "Pair",
			facts: source.draw(array(pairFact, { min: 0, max: 3 }))
		}),
		(source) => ({
			op: "insert",
			relation: "Gen",
			facts: source.draw(array(genFact, { min: 0, max: 3 }))
		})
	]),
	{ min: 0, max: 4 }
)

/** A lawful initial state: distinct k and distinct c. */
const initial = map(
	uniqueArray(pairFact, (f) => f.k, { min: 0, max: 3 }, 20),
	(fs) => Arr.dedupeWith(fs, (f, g) => f.c === g.c)
)

const sameOutcome = (a: AddWinsOutcome, b: AddWinsOutcome): void => {
	assert.equal(a.kind, b.kind)
	if (a.kind === "invariant-rejected" || b.kind === "invariant-rejected") {
		assert.equal(
			a.kind === "invariant-rejected" && b.kind === "invariant-rejected" && a.law,
			b.kind === "invariant-rejected" && b.law
		)
		return
	}
	assert.deepEqual(a.counts, b.counts)
	const facts = (o: typeof a) =>
		Arr.sort(
			Arr.map(
				[...o.state.relations],
				([r, s]) => [r, Arr.sort([...s.keys()], Order.String)] as const
			),
			Order.mapInput(Order.String, ([r]: readonly [string, ReadonlyArray<string>]) => r)
		)
	assert.deepEqual(facts(a), facts(b))
}

/** The structural rules of normalization over Pair, which add-wins equivalence alone cannot see: a fact left both put
 * and deleted means the same under S' = (S minus D) union A, yet the realization would delete it and put it back,
 * counting both. The slots hold exactly the raw sets after collapse (each operation's facts one set), the put owning
 * a fact an insert also requests, and additions winning over deletions: so the deletions are disjoint from the
 * additions and no fact is both inserted and put. */
type RawMember = {
	readonly op: string
	readonly relation: string
	readonly facts: ReadonlyArray<unknown>
}

const pairText = (f: unknown): string => {
	if (!hasProperties(f)) {
		throw new Error("a Pair fact is a record")
	}
	return `${String(f["k"])},${String(f["v"])},${String(f["c"])}`
}

const slotInvariants = (
	frontend: WriteFrontend,
	result: Normalization,
	ms: ReadonlyArray<RawMember>
): void => {
	if (result.kind !== "normalized") {
		return
	}
	const raw = (op: string) => {
		const members = Arr.filter(ms, (m) => m.op === op && m.relation === "Pair")
		return new Set(Arr.flatMap(members, (m) => Arr.map(m.facts, pairText)))
	}
	const [rawInsert, rawPut, rawDelete] = [raw("insert"), raw("put"), raw("delete")]
	const slot = (category: "put" | "delete" | "insert") =>
		Arr.map(slotFacts(result, frontend, category, "Pair"), pairText)
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

describe("normalization against the add-wins meaning", () => {
	it.effect(
		"refuses only what add-wins rejects with that key law, and keeps the meaning of what it passes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/normalize-5003",
						draw: drawn((source) => [source.draw(initial), source.draw(members)] as const),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([start, ms]) =>
						Effect.sync(() => {
							let changes: ChangeSetValue = cs(Small)
							let raw = OracleChangeSet.empty()
							for (const m of ms) {
								changes = changes[m.op](m.relation === "Pair" ? Pair : Gen, m.facts)
								raw = raw[m.op](m.relation, m.facts)
							}
							const state = oracleState(oracleSchema, { Pair: start }, loadedSequences)
							const expected = applyAddWins(oracleSchema, state, raw, { kind: "sequences" })
							const { frontend, result } = run(changes)
							if (result.kind === "keyConflict") {
								assert.equal(expected.kind, "invariant-rejected")
								if (expected.kind === "invariant-rejected") {
									contains(
										Arr.map(expected.violations, (v) => v.law),
										result.law
									)
								}
								return
							}
							slotInvariants(frontend, result, ms)
							let normalized = OracleChangeSet.empty()
							for (const group of frontend.slots) {
								for (const slot of group.slots) {
									const facts = result.slots.get(slot.slot)?.facts ?? []
									normalized = normalized[slot.op](group.relation.name, facts)
								}
							}
							sameOutcome(
								applyAddWins(oracleSchema, state, normalized, { kind: "sequences" }),
								expected
							)
						})
				)
			)
	)
})
