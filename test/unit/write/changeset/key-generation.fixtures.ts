/** What the properties of key-generation.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { array, element, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { columnKey, columnKeyOf } from "#compiler/ir/law.ts"
import type { LiteralBound, MessageBound } from "#compiler/ir/products.ts"
import { strataAt } from "#compiler/ir/stratum.ts"
import { Num } from "#compiler/public/compute.ts"
import { drawn, generated, natural, int4 } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema, tree, unit } from "#compiler/public/schema.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import type { Cells } from "#compiler/runtime/write/cells.ts"
import { type Normalization, normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { EnumeratedInput, MemberSlot } from "#compiler/write/frontend/compile.ts"
import { decideBinding } from "#compiler/write/program/decide.ts"
import { succeeded } from "#test/support/assert.ts"
import { cellAt } from "#test/support/cells.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
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

/** The classes of Bucket's key generation: m is a's remainder modulo them. */
const classes = 3

/**
 * Bucket(a, b, v), its primary key (b, m), m the key generation `a mod classes`: no injective generation, so two facts
 * whose reads (a, b) differ meet at one key whenever their a agree modulo the classes, the pair a key over the reads
 * holds apart. Its key leads with b, a field its caller writes, so Bucket sits in the unit of its b, mutable inside it.
 */
const Bucket = relation.generated("Bucket", { a: int4, b: int4, v: int4 }, ["b", "m"], (r) => ({
	m: generated(int4, Num.mod(r.a, classes))
}))

/** The schema of Bucket alone, mutable inside the unit of its b. */
const Keyed = schema("Keyed", [Bucket], [unit("Bs", { b: int4 }), mutable(Bucket)])

/** A fact of Bucket as its caller states it: its written fields, no key generation. */
type BucketFact = { readonly a: number; readonly b: number; readonly v: number }

/** A fact of Bucket as the model holds it: its written fields and its key generation, filled by the model. */
type FilledFact = BucketFact & { readonly m: number }

/** The model's key generation, a second implementation of `a mod classes` (PostgreSQL's integer remainder, which
 * JavaScript's agrees with on every nonnegative a drawn here). */
const generationOf = (a: number): number => a % classes

/** A fact filled by the model (FilledFact). */
const filledOf = (fact: BucketFact): FilledFact => ({ ...fact, m: generationOf(fact.a) })

/** An operation of the change set on Bucket. */
type Op = "insert" | "put" | "delete"

/** A drawn member: an operation, its facts, and none of a Stream: the transport is normalize.test.ts's to vary. */
interface Member {
	readonly op: Op
	readonly facts: ReadonlyArray<BucketFact>
}

/** Each a of two values in each class, so a class holds facts their a tells apart: 0 up to twice the classes. */
const span = 2 * classes
const aGen = int(0, span - 1)

/** A b or a v: two values, the fewest at which two facts agree at it or differ. */
const smallGen = int(1, 2)

/** The other a of `a`'s class. */
const otherOf = (a: number): number => (a + classes) % span

const factGen = (source: Source): BucketFact => ({
	a: source.draw(aGen),
	b: source.draw(smallGen),
	v: source.draw(smallGen)
})

const opGen = element(["insert", "put", "delete"] as const)

const memberGen = (source: Source): Member => ({
	op: source.draw(opGen),
	facts: source.draw(array(factGen, { min: 0, max: 3 }))
})

/** One to three strata of up to four members. */
const strataGen = array(array(memberGen, { min: 0, max: 4 }), { min: 1, max: 3 })

/** A lawful initial state: facts at distinct keys (b, m), by the model's fill, each key's first drawn fact kept. */
const initial = (source: Source): ReadonlyArray<BucketFact> =>
	Arr.dedupeWith(source.draw(array(factGen, { min: 0, max: 4 })), (f, g) =>
		sameKey(filledOf(f), filledOf(g))
	)

/** Whether two filled facts are at one key of Bucket's primary key (b, m). */
const sameKey = (f: FilledFact, g: FilledFact): boolean => f.m === g.m && f.b === g.b

/** A case: a lawful initial state and one to three strata of members. */
export const caseGen = (source: Source) => [source.draw(initial), source.draw(strataGen)] as const

/**
 * A case aimed at two additions of one stratum at one key their reads tell apart: a fact, and another of its a's class
 * at the same b, each added by an insert or a put.
 */
export const collidingGen = (source: Source) => {
	const first = source.draw(factGen)
	const second: BucketFact = { a: otherOf(first.a), b: first.b, v: source.draw(smallGen) }
	const adding = (fact: BucketFact): Member => ({
		op: source.draw(element(["insert", "put"] as const)),
		facts: [fact]
	})
	return [source.draw(initial), [[adding(first), adding(second)]]] as const
}

/**
 * A case aimed at a fact one stratum both deletes and adds, with another of its key's class deleted beside it: two
 * deletions at one key normalized, and the addition netting its own fact's.
 */
export const nettingGen = (source: Source) => {
	const fact = source.draw(factGen)
	const other: BucketFact = { a: otherOf(fact.a), b: fact.b, v: fact.v }
	const deleting: Member = { op: "delete", facts: [fact, other] }
	const adding: Member = { op: source.draw(element(["insert", "put"] as const)), facts: [fact] }
	return [source.draw(initial), [[deleting, adding]]] as const
}

/** A stratum's members added to a ChangeSet in turn. */
const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
	Arr.reduce(members, cs(Keyed), (changes, m) => changes[m.op](Bucket, m.facts))

/** The strata that hold a member, each at its position among them: the strata the write runs (StratumAt). */
const occupiedOf = (strata: ReadonlyArray<ReadonlyArray<Member>>) =>
	strataAt(Arr.filter(strata, (members) => members.length > 0))

/** The strata sequenced. */
const changeSetOf = (strata: ReadonlyArray<ReadonlyArray<Member>>): ChangeSetValue => {
	const [first, ...rest] = Arr.map(strata, stratumOf)
	return Arr.reduce(rest, defined(first, "a first stratum"), (a, b) => ChangeSet.sequence(a, b))
}

/** The strata as the oracle's ChangeSet, every fact filled by the model first. */
const oracleOf = (strata: ReadonlyArray<ReadonlyArray<Member>>): OracleChangeSet => {
	const [first, ...rest] = Arr.map(strata, (members) =>
		Arr.reduce(members, OracleChangeSet.empty(), (raw, m) =>
			raw[m.op]("Bucket", Arr.map(m.facts, filledOf))
		)
	)
	return OracleChangeSet.sequence(defined(first, "a first stratum"), ...argumentsOf(rest))
}

/** A field of Bucket's codec spec, as the installation's codes encode it. */
const specOf = (field: string) => {
	const frontend = compiled(Keyed, cs(Keyed))
	const column = Option.fromUndefinedOr(frontend.schema.relations.get(Bucket.name)).pipe(
		Option.flatMap((r) => Arr.findFirst(r.heading, (h) => h.name === field))
	)
	if (Option.isNone(column)) {
		throw new Error(field)
	}
	return scalarCodec(column.value.type, codesOf(Keyed)).spec
}

/** Bucket as the add-wins calculator holds it: every field, the key generation among them, and its primary key over
 * b and the key generation, which the model's filled facts are judged at. */
const oracleSchema: OracleSchema = {
	relations: [
		{
			name: "Bucket",
			heading: Arr.map(["a", "b", "m", "v"], (f) => ({ name: f, spec: specOf(f) })),
			primaryKey: { law: lawNamesOf(Keyed).primaryKeyLaw(Bucket), fields: ["b", "m"] },
			keys: [],
			projectedKeys: []
		} satisfies OracleRelation
	]
}

/** An enumerated input's member slots, with the operation that writes their facts. */
const slotsOf = (
	input: EnumeratedInput
): ReadonlyArray<{ readonly op: Op; readonly slot: MemberSlot }> => {
	switch (input.kind) {
		case "single": {
			return [{ op: input.act.op, slot: input.slot }]
		}
		case "nested":
			return [{ op: "insert", slot: input.slot }]
	}
}

/** A normalization's result, its failure a codec's: no case here is past the message bound. */
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

/**
 * A ChangeSet compiled over `schemaValue` and normalized with its members collected as the runtime collects them, with
 * its front end and the column index its nested rows are laid out by.
 */
const normalizedIn = (schemaValue: FixtureSchema, changes: ChangeSetValue) =>
	Effect.sync(() => {
		const frontend = compiled(schemaValue, changes)
		const binding = decideBinding(frontend)
		const prepared = prepareBinding(
			binding,
			frontend.codes,
			closedTableOf(frontend.schema),
			new CompilePatterns()
		)
		const facts = collectInputs(binding.groups, parsedOf(changes).inputs)
		return {
			frontend,
			columns: prepared.columns,
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

/** Two add-wins outcomes agree: their kind, their law where both reject, and else their counts and final states. */
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

/** A normalized slot's fact read back as the model's filled fact: its written fields and its key generation. */
const filledFact = (f: unknown): FilledFact => {
	if (!hasProperties(f)) {
		throw new Error("a Bucket fact is a record")
	}
	const field = (name: string): number => {
		const value = f[name]
		if (typeof value !== "number") {
			throw new Error(`a Bucket fact's ${name} is an integer, not ${String(value)}`)
		}
		return value
	}
	return { a: field("a"), b: field("b"), v: field("v"), m: field("m") }
}

/** What a case reaches. */
export type KeyGenerationFeature =
	| "two strata"
	| "refused at a key its reads tell apart"
	| "two deletions at one key, normalized"
	| "a fact a stratum both deletes and adds, netted"
	| "an insert and a put of one fact"

/** The additions of each stratum, model-filled, the facts its same-key checks judge. */
const additionsOf = (members: ReadonlyArray<Member>): ReadonlyArray<FilledFact> =>
	Arr.flatMap(members, (m) => (m.op === "delete" ? [] : Arr.map(m.facts, filledOf)))

/** Whether two facts are one fact: equal at every written field. */
const sameFact = (f: BucketFact, g: BucketFact): boolean =>
	f.a === g.a && f.b === g.b && f.v === g.v

/**
 * The property over one case: normalization refuses exactly where the add-wins meaning of the model's filled facts
 * rejects by Bucket's primary key whatever the state, its witness the filled key (b, m) two of one stratum's additions
 * share; and where it passes, every slot holds each fact with its key generation filled as the model fills it, and the
 * ChangeSet its slots state means what the one it came from means, so its netting is the model's.
 */
export const fillsFirst = (
	start: ReadonlyArray<BucketFact>,
	strata: ReadonlyArray<ReadonlyArray<Member>>,
	c: Case<KeyGenerationFeature>
) =>
	Effect.gen(function* () {
		if (strata.length >= 2) {
			c.note("two strata")
		}
		const state = oracleState(oracleSchema, { Bucket: Arr.map(start, filledOf) })
		const expected = applyAddWins(oracleSchema, state, oracleOf(strata))
		const { frontend, result } = yield* normalizedIn(Keyed, changeSetOf(strata))
		const normalization = succeeded(result, "a ChangeSet of admitted facts normalizes")
		if (normalization.kind === "keyConflict") {
			assert.equal(
				expected.kind,
				"invariant-rejected",
				"the add-wins meaning of the filled facts rejects it too"
			)
			assert.equal(normalization.law, lawNamesOf(Keyed).primaryKeyLaw(Bucket))
			const values = normalization.witness.values
			const conflicting = Arr.filter(strata, (ms) => {
				const added = additionsOf(ms)
				return Arr.some(added, (f, i) =>
					Arr.some(
						added,
						(g, j) =>
							i !== j &&
							sameKey(f, g) &&
							!sameFact(f, g) &&
							values["m"] === f.m &&
							values["b"] === f.b
					)
				)
			})
			assert.ok(
				conflicting.length > 0,
				`the witness ${Formatter.format(values)} is the filled key two additions of one stratum share`
			)
			if (
				Arr.some(conflicting, (ms) =>
					Arr.some(additionsOf(ms), (f) =>
						Arr.some(additionsOf(ms), (g) => f.a !== g.a && sameKey(f, g))
					)
				)
			) {
				c.note("refused at a key its reads tell apart")
			}
			return
		}
		assertVariant(
			normalization,
			"kind",
			"normalized",
			"a key generation of a nonnull integer has a value"
		)
		for (const ms of strata) {
			const deleted = Arr.flatMap(ms, (m) => (m.op === "delete" ? m.facts : []))
			if (
				Arr.some(deleted, (f, i) =>
					Arr.some(
						deleted,
						(g, j) => i !== j && !sameFact(f, g) && sameKey(filledOf(f), filledOf(g))
					)
				)
			) {
				c.note("two deletions at one key, normalized")
			}
			const added = Arr.flatMap(ms, (m) => (m.op === "delete" ? [] : m.facts))
			if (Arr.some(deleted, (f) => Arr.some(added, (g) => sameFact(f, g)))) {
				c.note("a fact a stratum both deletes and adds, netted")
			}
			const of = (op: Op) => Arr.flatMap(ms, (m) => (m.op === op ? m.facts : []))
			if (Arr.some(of("insert"), (f) => Arr.some(of("put"), (g) => sameFact(f, g)))) {
				c.note("an insert and a put of one fact")
			}
		}
		const rebuilt = Arr.map(occupiedOf(strata), ([s]) =>
			Arr.reduce(
				Arr.filter(frontend.slots, (g) => g.stratum === s),
				OracleChangeSet.empty(),
				(raw, group) =>
					Arr.reduce(Arr.flatMap(group.inputs, slotsOf), raw, (acc, { op, slot }) => {
						const facts = Arr.map(normalization.slots.get(slot.slot)?.facts ?? [], filledFact)
						for (const f of facts) {
							assert.equal(
								f.m,
								generationOf(f.a),
								`the ${op} slot holds ${Formatter.format(f)} filled`
							)
						}
						return acc[op](group.relation.name, facts)
					})
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

/**
 * Owner(a, b, members drawn), its primary key (m, b), m = `a mod classes` its key generation, and Line(m, b, at, body),
 * the ordered family of Owner over the owner's key: Line's group (m, b) is a plain copy of its owner's filled key, which
 * the nesting's walk fills from the owner's generation before it copies it (INTERFACE §3 form b).
 */
const Owner = relation.generated(
	"Owner",
	{ a: int4, b: int4, members: drawn(natural) },
	["m", "b"],
	(r) => ({ m: generated(int4, Num.mod(r.a, classes)) })
)

const Line = relation("Line", { m: int4, b: int4, at: drawn(natural), body: int4 }, [
	"m",
	"b",
	"at"
])

/** The schema of Owner and its family of Lines. */
const Lines = schema(
	"Lines",
	[Owner, Line],
	[ordered(on(Line, "m", "b", "at"), fin(Owner, "members"))]
)

/** An owner fact as its caller states it: its written fields and its members' bodies, in slot order. */
interface OwnerFact {
	readonly a: number
	readonly b: number
	readonly bodies: ReadonlyArray<number>
}

const ownerGen = (source: Source): OwnerFact => ({
	a: source.draw(aGen),
	b: source.draw(smallGen),
	bodies: source.draw(array(smallGen, { min: 0, max: 2 }))
})

/** One to three strata, each one nested insert of up to three owner facts. */
export const nestedCaseGen = array(array(ownerGen, { min: 0, max: 3 }), { min: 1, max: 3 })

/** A stratum aimed at two owners at one key their reads tell apart: an owner, and another of its a's class at its b. */
export const nestedCollidingGen = (source: Source): ReadonlyArray<ReadonlyArray<OwnerFact>> => {
	const first = source.draw(ownerGen)
	const second: OwnerFact = {
		a: otherOf(first.a),
		b: first.b,
		bodies: source.draw(array(smallGen, { min: 0, max: 2 }))
	}
	return [[first, second]]
}

/** Whether two owner facts are one fact: equal at their written fields and at every member, in slot order. */
const sameOwner = (f: OwnerFact, g: OwnerFact): boolean =>
	f.a === g.a &&
	f.b === g.b &&
	f.bodies.length === g.bodies.length &&
	Arr.every(f.bodies, (x, i) => x === g.bodies[i])

/** The owner facts as a caller states a nested insert of them. */
const statedOwners = (owners: ReadonlyArray<OwnerFact>) =>
	Arr.map(owners, (o) => ({ a: o.a, b: o.b, members: Arr.map(o.bodies, (body) => ({ body })) }))

/** The strata as one ChangeSet, a nested insert of Owner each. */
const nestedChangeSetOf = (strata: ReadonlyArray<ReadonlyArray<OwnerFact>>): ChangeSetValue => {
	const [first, ...rest] = Arr.map(strata, (owners) =>
		cs(Lines).insert(Owner, statedOwners(owners))
	)
	return Arr.reduce(rest, defined(first, "a first stratum"), (a, b) => ChangeSet.sequence(a, b))
}

/** Lines in one order, by their texts. */
const rowOrder = Order.mapInput(Order.String, (row: ReadonlyArray<unknown>) =>
	Arr.join(Arr.map(row, String), ",")
)

/** What a nested case reaches. */
export type NestedKeyFeature =
	| "two strata"
	| "an owner stated twice"
	| "two owners at one key their reads tell apart"
	| "an owner with members"

/**
 * The nested property over one case: each stratum's nested insert is refused exactly where two owner facts of it that
 * are not one fact share the filled key (a mod classes, b), by Owner's primary key, its witness that key; and where
 * none do, each stratum's Lines are every distinct owner's members, each holding its owner's filled key, copied, at its
 * slot.
 */
export const nestingFillsFirst = (
	strata: ReadonlyArray<ReadonlyArray<OwnerFact>>,
	c: Case<NestedKeyFeature>
) =>
	Effect.gen(function* () {
		if (strata.length >= 2) {
			c.note("two strata")
		}
		const distinct = Arr.map(strata, (owners) => Arr.dedupeWith(owners, sameOwner))
		if (Arr.some(Arr.zip(strata, distinct), ([owners, kept]) => owners.length > kept.length)) {
			c.note("an owner stated twice")
		}
		if (Arr.some(distinct, (owners) => Arr.some(owners, (o) => o.bodies.length > 0))) {
			c.note("an owner with members")
		}
		/** Each owner of a stratum sharing its filled key with another of it, the key and whether the two tell apart
		 * their reads. */
		const conflicts = Arr.flatMap(distinct, (owners) =>
			Arr.flatMap(owners, (o, i) => {
				const at = Arr.filter(
					owners,
					(p, j) => i !== j && generationOf(p.a) === generationOf(o.a) && p.b === o.b
				)
				return at.length === 0
					? []
					: [{ m: generationOf(o.a), b: o.b, apart: Arr.some(at, (p) => p.a !== o.a) }]
			})
		)
		const { columns, result } = yield* normalizedIn(Lines, nestedChangeSetOf(strata))
		const normalization = succeeded(result, "a nested insert of admitted facts normalizes")
		if (normalization.kind === "keyConflict") {
			if (Arr.some(conflicts, (k) => k.apart)) {
				c.note("two owners at one key their reads tell apart")
			}
			assert.equal(normalization.law, lawNamesOf(Lines).primaryKeyLaw(Owner))
			const values = normalization.witness.values
			assert.ok(
				Arr.some(conflicts, (k) => values["m"] === k.m && values["b"] === k.b),
				`the witness ${Formatter.format(values)} is the filled key two owners of one stratum share`
			)
			return
		}
		assertVariant(
			normalization,
			"kind",
			"normalized",
			"a key generation of a nonnull integer has a value"
		)
		assert.deepEqual(conflicts, [], "no two owners of one stratum share a filled key")
		for (const [s, owners] of strataAt(distinct)) {
			const rows = Arr.flatMap([...(normalization.nested.get(s) ?? [])], ([name, lines]) =>
				name === Line.name ? lines : []
			)
			const field = (row: { readonly values: Cells }, name: string): unknown =>
				cellAt(columns, { relation: Line.name, values: row.values }, columnKeyOf(name))
			const held = Arr.sort(
				Arr.map(rows, (row) => [
					field(row, "m"),
					field(row, "b"),
					field(row, "at"),
					field(row, "body")
				]),
				rowOrder
			)
			const expected = Arr.sort(
				Arr.flatMap(owners, (o) =>
					Arr.map(o.bodies, (body, at) => [generationOf(o.a), o.b, BigInt(at), body])
				),
				rowOrder
			)
			assert.deepEqual(
				held,
				expected,
				"each Line holds its owner's filled key, copied, at its slot"
			)
		}
	})

/**
 * Node(k, p, label), a tree of itself keyed by (k, d, start), d = `p mod classes` its key generation, its root fields
 * (k, d): a self-family whose members' group holds the relation's own key generation (INTERFACE §3 form a), so each
 * node states its own p and the walk generates its d from it, never copying its parent's; its foreign key and its
 * key's CHECK prove the two agree, the statement's to refuse.
 */
const Node = relation.generated(
	"Node",
	{
		k: int4,
		p: int4,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		label: int4
	},
	["k", "d", "start"],
	(r) => ({ d: generated(int4, Num.mod(r.p, classes)) })
)

/** The schema of the tree of Nodes. */
const Trees = schema(
	"Trees",
	[Node],
	[tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["k", "d"] })]
)

/** A node as its tree's fact states it: its p and its label, its children leaves. */
interface StatedNode {
	readonly p: number
	readonly label: number
}

/** A tree as its fact states it: its root's k, p and label, and the root's children, in slot order. */
interface TreeFact {
	readonly k: number
	readonly root: StatedNode
	readonly children: ReadonlyArray<StatedNode>
}

const stated = (source: Source): StatedNode => ({
	p: source.draw(aGen),
	label: source.draw(smallGen)
})

const treeGen = (source: Source): TreeFact => ({
	k: source.draw(smallGen),
	root: source.draw(stated),
	children: source.draw(array(stated, { min: 0, max: 2 }))
})

/** One to three strata, each one nested insert of up to three trees. */
export const treeCaseGen = array(array(treeGen, { min: 0, max: 3 }), { min: 1, max: 3 })

/** A stratum aimed at two trees at one filled root key their roots' p tell apart: a tree, and another whose root's p
 * is the other of its class. */
export const treeCollidingGen = (source: Source): ReadonlyArray<ReadonlyArray<TreeFact>> => {
	const first = source.draw(treeGen)
	const second: TreeFact = {
		k: first.k,
		root: { p: otherOf(first.root.p), label: source.draw(smallGen) },
		children: source.draw(array(stated, { min: 0, max: 2 }))
	}
	return [[first, second]]
}

/**
 * A row of Node as the model fills it, in pre-order: its key (k, d, start), its p, and every column the walk draws, its
 * successor among its siblings among them (`next`, the family's ‹s›, write/family/statements.ts RowLayout): a root's
 * its own slot, 0, a child's the slot after it below its parent's count and its own at the last, so two nodes at one
 * key, one its parent's last child and one not, are two rows.
 */
type NodeRow = {
	readonly k: number
	readonly d: number
	readonly start: bigint
	readonly p: number
	readonly label: number
	readonly parent: bigint
	readonly at: bigint
	readonly children: bigint
	readonly end: bigint
	readonly next: bigint
}

/** A tree's rows as the model fills them: the root at start 0, its parent itself, each child a leaf after it, each d
 * generated from the node's own p. */
const treeRows = (t: TreeFact): ReadonlyArray<NodeRow> => [
	{
		k: t.k,
		d: generationOf(t.root.p),
		start: 0n,
		p: t.root.p,
		label: t.root.label,
		parent: 0n,
		at: 0n,
		children: BigInt(t.children.length),
		end: BigInt(t.children.length + 1),
		next: 0n
	},
	...Arr.map(t.children, (c, i) => ({
		k: t.k,
		d: generationOf(c.p),
		start: BigInt(i + 1),
		p: c.p,
		label: c.label,
		parent: 0n,
		at: BigInt(i),
		children: 0n,
		end: BigInt(i + 2),
		next: BigInt(i + 1 < t.children.length ? i + 1 : i)
	}))
]

/** Whether two trees are one fact. */
const sameTree = (f: TreeFact, g: TreeFact): boolean =>
	f.k === g.k &&
	f.root.p === g.root.p &&
	f.root.label === g.root.label &&
	f.children.length === g.children.length &&
	Arr.every(Arr.zip(f.children, g.children), ([x, y]) => x.p === y.p && x.label === y.label)

/** Whether two rows are at one key of Node's primary key. */
const sameNodeKey = (r: NodeRow, s: NodeRow): boolean =>
	r.k === s.k && r.d === s.d && r.start === s.start

/** Whether two rows are one row: one at every column. */
const sameRow = (r: NodeRow, s: NodeRow): boolean =>
	sameNodeKey(r, s) &&
	r.p === s.p &&
	r.label === s.label &&
	r.parent === s.parent &&
	r.at === s.at &&
	r.children === s.children &&
	r.end === s.end &&
	r.next === s.next

/** The trees as a caller states a nested insert of them. */
const statedTrees = (trees: ReadonlyArray<TreeFact>) =>
	Arr.map(trees, (t) => ({
		k: t.k,
		p: t.root.p,
		label: t.root.label,
		children: Arr.map(t.children, (c) => ({ p: c.p, label: c.label, children: [] }))
	}))

/** The strata as one ChangeSet, a nested insert of Node's trees each. */
const treeChangeSetOf = (strata: ReadonlyArray<ReadonlyArray<TreeFact>>): ChangeSetValue => {
	const [first, ...rest] = Arr.map(strata, (trees) => cs(Trees).insert(Node, statedTrees(trees)))
	return Arr.reduce(rest, defined(first, "a first stratum"), (a, b) => ChangeSet.sequence(a, b))
}

/** What a tree case reaches. */
export type TreeKeyFeature =
	| "two strata"
	| "a tree stated twice"
	| "a node whose key generation is not its root's"
	| "two trees at one filled key their reads tell apart"

/** Node's rows in one order, by their columns' texts in the order they are listed. */
const nodeOrder = Order.mapInput(Order.String, (r: Readonly<Record<string, unknown>>) =>
	Arr.join(Arr.map(Rec.values(r), String), ",")
)

/**
 * The tree property over one case: each stratum's nested insert is refused, by Node's primary key, exactly where two of
 * its distinct trees share a filled key, the root's or a node's, and their rows there differ, its witness that key; and
 * where none do, its rows are every distinct tree's, as the model fills them, each node's d generated from its own p,
 * and one row of two trees' that are one row, the stratum's rows a set (two such nodes under roots of other keys are
 * the statement's to refuse, at the tree's foreign key).
 */
export const treeFillsFirst = (
	strata: ReadonlyArray<ReadonlyArray<TreeFact>>,
	c: Case<TreeKeyFeature>
) =>
	Effect.gen(function* () {
		if (strata.length >= 2) {
			c.note("two strata")
		}
		const distinct = Arr.map(strata, (trees) => Arr.dedupeWith(trees, sameTree))
		if (Arr.some(Arr.zip(strata, distinct), ([trees, kept]) => trees.length > kept.length)) {
			c.note("a tree stated twice")
		}
		if (
			Arr.some(distinct, (trees) =>
				Arr.some(trees, (t) =>
					Arr.some(t.children, (n) => generationOf(n.p) !== generationOf(t.root.p))
				)
			)
		) {
			c.note("a node whose key generation is not its root's")
		}
		/**
		 * Each row of a stratum's distinct trees that meets another tree's at its filled key where the two trees are
		 * refused: two roots meeting, two trees whose facts differ, or two other rows that differ; and whether the rows
		 * met there tell their reads apart.
		 */
		const conflicts = Arr.flatMap(distinct, (trees) => {
			const rows = Arr.map(trees, treeRows)
			return Arr.flatMap(rows, (mine, i) =>
				Arr.flatMap(mine, (r) => {
					const met = Arr.flatMap(rows, (theirs, j) =>
						i === j ? [] : Arr.filter(theirs, (o) => sameNodeKey(r, o))
					)
					return met.length > 0 && (r.start === 0n || Arr.some(met, (o) => !sameRow(r, o)))
						? [{ row: r, apart: Arr.some(met, (o) => o.p !== r.p) }]
						: []
				})
			)
		})
		const { frontend, columns, result } = yield* normalizedIn(Trees, treeChangeSetOf(strata))
		/** The tree's successor of each node, a column of its rows no field names (NodeRow `next`). */
		const tree = Arr.findFirst(frontend.laws.families, (f) => f.member.name === Node.name)
		if (Option.isNone(tree)) {
			throw new Error("the tree of Node")
		}
		const successor = columnKey({ kind: "law", column: tree.value.next })
		const normalization = succeeded(result, "a nested insert of admitted trees normalizes")
		if (normalization.kind === "keyConflict") {
			if (Arr.some(conflicts, (k) => k.apart)) {
				c.note("two trees at one filled key their reads tell apart")
			}
			assert.equal(normalization.law, lawNamesOf(Trees).primaryKeyLaw(Node))
			const values = normalization.witness.values
			assert.ok(
				Arr.some(
					conflicts,
					({ row }) =>
						values["k"] === row.k && values["d"] === row.d && values["start"] === row.start
				),
				`the witness ${Formatter.format(values)} is a filled key two trees of one stratum meet at`
			)
			return
		}
		assertVariant(
			normalization,
			"kind",
			"normalized",
			"a key generation of a nonnull integer has a value"
		)
		assert.deepEqual(conflicts, [], "no two trees of one stratum meet at a filled key")
		for (const [s, trees] of strataAt(distinct)) {
			const rows = Arr.flatMap([...(normalization.nested.get(s) ?? [])], ([name, nodes]) =>
				name === Node.name ? nodes : []
			)
			const field = (row: { readonly values: Cells }, name: string): unknown =>
				cellAt(columns, { relation: Node.name, values: row.values }, columnKeyOf(name))
			const held = Arr.sort(
				Arr.map(rows, (row) => ({
					k: field(row, "k"),
					d: field(row, "d"),
					start: field(row, "start"),
					p: field(row, "p"),
					label: field(row, "label"),
					parent: field(row, "parent"),
					at: field(row, "at"),
					children: field(row, "children"),
					end: field(row, "end"),
					next: cellAt(columns, { relation: Node.name, values: row.values }, successor)
				})),
				nodeOrder
			)
			assert.deepEqual(
				held,
				Arr.sort(Arr.dedupeWith(Arr.flatMap(trees, treeRows), sameRow), nodeOrder),
				"each node holds its root's k and the d its own p generates, at its place"
			)
		}
	})
