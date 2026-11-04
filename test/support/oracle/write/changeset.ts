import { array, boolean, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm as swarmOf, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order, Record as Rec, Stream } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { Decimal } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { Fact as RelationFact } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/index.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import type { ParamMap, ParamValue, Source } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { HeadShape } from "#compiler/types/query/terms.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	type MemberInput,
	type ReadBackInput
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { argumentsOf, isList } from "#test/support/list.ts"
import {
	type Fact,
	factsOf,
	OracleChangeSet,
	type OracleState
} from "#test/support/oracle/addwins.ts"
import { elementAt, recordEntryOf } from "#test/support/oracle/pick.ts"
import {
	coercedSpelling,
	printValue,
	sameBase,
	typeInfo,
	valueIdentity
} from "#test/support/oracle/write/domain.ts"

import {
	factKey,
	poolValue,
	type RowSketch,
	resolveRow,
	rowSketchGen,
	type WFacts
} from "#test/support/oracle/write/facts.ts"

import {
	columnOf,
	isImmediate,
	type Planted,
	plantedOf,
	relationIn,
	serialColumns,
	type WContainment,
	type WGroup,
	type WRelation,
	type WRelationValue,
	type WSchemaValue
} from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"

export type MemberOp = "insert" | "delete" | "put"

type HeadTerm =
	| { readonly kind: "var"; readonly column: string }
	| { readonly kind: "param"; readonly param: string }

type WSource =
	| { readonly kind: "array"; readonly facts: ReadonlyArray<Fact>; readonly stream: boolean }
	| {
			readonly kind: "project"
			readonly from: string
			readonly filter: { readonly column: string; readonly param: string } | undefined
			/**
			 * One term per field of the member's relation; an insert's head may leave out the serial field, a generated
			 * addition.
			 */
			readonly head: Readonly<Record<string, HeadTerm>>
	  }
	| { readonly kind: "param"; readonly param: string }
	| {
			readonly kind: "scoped"
			readonly scope: { readonly column: string; readonly param: string }
			/** The relation parameter whose keys the deletion leaves alone. */
			readonly exclude: string
	  }
	| {
			readonly kind: "top"
			readonly from: string
			readonly on: string
			readonly parents: string
			readonly k: number
	  }

/** The kind of a member's source, which a member's feature names beside its op. */
export type WSourceKind = WSource["kind"]

interface WMember {
	readonly op: MemberOp
	readonly relation: string
	readonly source: WSource
}

export type ReadSource = "added" | "removed" | "state"

/**
 * What a read-back attaches to each row: nothing, or, stated "one", the target fact of a deferred containment out of the
 * read's relation, which a read inside the write's transaction reads back as an Option (see the header).
 */
type WParent =
	| { readonly kind: "none" }
	| { readonly kind: "one"; readonly containment: WContainment }

/** The slot an attached read-back delivers its parent in, which no generated field (a to d) is named. */
export const parentSlot = "parent"

interface WRead {
	readonly name: string
	readonly relation: string
	readonly source: ReadSource
	readonly parent: WParent
}

/**
 * How the ChangeSet's parameters reach its statements: passed to the call, or closed by ChangeSet.bind with each
 * relation parameter as its array or as a Stream of its facts.
 */
export type Binding = "passed" | "bound" | "bound as streams"

/** Which entry point applies the ChangeSet. */
export type Entry = "apply" | "compile"

/**
 * Generated ChangeSets of one group.
 *
 * A generated ChangeSet is one to three strata (more than one only through ChangeSet.sequence), each of
 * insert, delete and put members, and up to three read-backs. A member is one of:
 *
 * - an array of facts, the enumerated member that is a relation parameter. Its facts are biased toward
 *   the cases add-wins and the counts must get right: exact copies of stored facts,
 *   a stored key with a fresh payload, copies and key variants of facts an earlier member names (a fact both added and
 *   deleted, two puts of one key, a put and an insert of one key), fresh facts and repeats within one member;
 * - a projection: a described member reading one relation of the group, optionally filtered by one equality against
 *   a parameter, whose head gives each target field either a variable of a source field of the same base type or a
 *   parameter. Over its own relation with the key fields kept it is the shape a described put on a
 *   mutable relation realizes as UPDATE ... FROM; a head that fixes a key field to a parameter folds
 *   several facts onto one key, which the in-statement same-key check refuses;
 * - a parameter member: the facts of a relation parameter of the target's heading, a described member that reads no
 *   stored relation;
 * - the reread pair: a put of a relation parameter beside a deletion of every fact of the relation within a scope
 *   whose key is not in that parameter, the shape a MERGE realizes on a mutable relation;
 * - a top member, planted only: the first k facts by key of a relation, per value of one of its columns that a
 *   relation parameter names, a take bound to the parameter's rows, whose statement chooses its form by the
 *   parameter's distinct fact count.
 *
 * An insert into a relation with identity columns may be a generated addition, which omits every serial field and
 * takes fresh values from the identity sequences: an enumerated fact without them (the empty fact, when every field is
 * an identity column), a copy of an earlier one, which equals it and so is one requested addition, or a projection
 * whose head leaves the serial fields out. Generated additions are drawn only in the last stratum, after any explicit
 * values earlier strata advance the sequences past, so no member reads a generated value and the values appear only in
 * the relation's own serial fields, where the harness compares them up to renaming (harness.ts).
 *
 * Every choice among a list is a pick (test/support/pick.ts), an integer in 0..0xffff that selects without modulo
 * skew and shrinks toward the list's first element.
 *
 * An enumerated member may be given as a Stream of its facts instead of an array, the ChangeSet may close its
 * parameters with ChangeSet.bind (its relation parameters as arrays or as Streams) and be applied with no parameters
 * of the caller's, and the case may apply it through db.compile(changes).apply(params) instead of db.apply: each
 * means the same ChangeSet, so the expectation is the same.
 *
 * A read-back of a relation with a deferred containment out of it may attach, stated "one", the containment's target
 * fact to each row, which a read inside the write's transaction reads back as an Option: it runs
 * before COMMIT has checked the deferred laws, so a row may name a target the write removed or never added. Its head
 * is known only at run time, so it is built through the query builder's untyped core (query/build/index.ts
 * queryOver), the entry a JavaScript caller's description goes through.
 *
 * A planted case writes the planted group (schema.ts Planted) instead: a fixed ChangeSet over facts planted beside the
 * drawn ones, each realizing an outcome the drawn population meets too rarely to rely on (PlantedArm).
 *
 * Each member, read-back and parameter is plain data (`WChangeSet`), from which `buildChangeSet` builds the ChangeSet
 * value through the real builders and `oracleChangeSet` the add-wins calculator's ChangeSet, its described members
 * evaluated against the state before their stratum by definition.
 */
export interface WChangeSet {
	readonly group: number
	readonly strata: Arr.NonEmptyReadonlyArray<ReadonlyArray<WMember>>
	readonly reads: ReadonlyArray<WRead>
	/** Scalar parameters by name, and relation parameters as arrays of facts. */
	readonly params: ParamMap
	readonly binding: Binding
	readonly entry: Entry
}

/** Whether a fact of `relation` omits its serial fields: a generated addition. */
export const isGenerated = (relation: WRelation, fact: Fact): boolean => {
	const serial = serialColumns(relation)
	return serial.length > 0 && Arr.every(serial, (c) => !Rec.has(fact, c.name))
}

/** Whether a member makes generated additions: an enumerated fact or a head without the serial fields. */
export const generates = (relation: WRelation, m: WMember): boolean => {
	const serial = serialColumns(relation)
	if (m.op !== "insert" || serial.length === 0) {
		return false
	}
	if (m.source.kind === "array") {
		return Arr.some(m.source.facts, (f) => isGenerated(relation, f))
	}
	const head = m.source.kind === "project" ? m.source.head : undefined
	return head !== undefined && Arr.every(serial, (c) => !Rec.has(head, c.name))
}

interface FactPick {
	/**
	 * 0, 1 fresh, or in a relation with a candidate key a fresh fact holding a stored fact's candidate key (an earlier
	 * member's when nothing is stored); 2, 3 a stored fact; 4 a stored key with a fresh payload; 5 an earlier member's
	 * fact; 6 its key with a fresh payload; 7 fresh. On an insert into a relation with identity columns in the last
	 * stratum, 0, 1 and 7 are a generated addition instead (see the header).
	 */
	readonly mode: number
	readonly pick: number
	readonly row: RowSketch
	/**
	 * How the fact spells each field's value: as it is, or a spelling that coerces to the same stored value
	 * (domain.ts coercedSpelling), so a copy of a stored fact is still an exact repeat.
	 */
	readonly spell: ReadonlyArray<number>
}

interface MemberSketch {
	readonly op: number
	readonly relation: number
	/** 0-4 array, 5-7 projection, 8 parameter member, 9 the reread pair. */
	readonly source: number
	readonly facts: ReadonlyArray<FactPick>
	/** A projection reads its own relation, or another of the group. */
	readonly from: { readonly other: boolean; readonly relation: number }
	readonly filter: { readonly on: boolean; readonly column: number; readonly value: number }
	/**
	 * Per target field: 0-3 a variable (preferring the same field), 4 a parameter; the variable's or the parameter's
	 * pick, and the parameter's spelling. On the first serial field of an insert's head in the last stratum, 2-4 leave
	 * every serial field out: a generated addition.
	 */
	readonly head: ReadonlyArray<{
		readonly term: number
		readonly value: number
		readonly spell: number
	}>
}

interface ReadSketch {
	readonly relation: number
	readonly source: number
	/**
	 * Whether the read attaches a deferred containment's target, and which; and whether a read of the removed facts
	 * clears the containment's target and source in the last stratum, so every removed fact's parent is gone.
	 */
	readonly parent: { readonly on: boolean; readonly containment: number; readonly clear: boolean }
}

/**
 * The fixed ChangeSets a planted case writes on the planted group (schema.ts Planted), each over facts planted beside
 * the drawn ones (plantedFacts) and realizing one outcome:
 * - "parent present": the change adds three parent facts and a child fact naming each, and reads the added child facts
 *   attaching, stated "one", their parents, each present;
 * - "parent absent": the stored facts hold a parent fact and a child fact naming it, which the change deletes, and it
 *   reads the removed child facts attaching their parents, each gone;
 * - "parent violated": the change adds a child fact naming no parent fact, which breaks the deferred containment at
 *   COMMIT, and reads the added child facts attaching their parents;
 * - "capacity overfilled": the stored facts hold a selected capped fact, which fills its capacity's bound of one, and
 *   the change adds a second at the same b, refused by the capacity;
 * - "scoped merge": a put of a relation parameter beside the deletion of every fact of the mutable relation in a scope
 *   whose key is not in that parameter, which the compiler realizes as one MERGE; the stored facts hold a fact the put
 *   changes and one the deletion removes;
 * - "toast repeat": the same MERGE putting a stored fact holding a TOAST-sized text, exactly as stored, beside the
 *   deletion of a scope no fact holds, which changes nothing;
 * - "toast change": an enumerated put on the mutable relation alone, an ON CONFLICT DO UPDATE, of a stored fact's key
 *   with the TOAST-sized text that differs from the stored one in its last code point alone, which changes it;
 * - "described put": a put on the mutable relation of its own facts at one b, their keys kept and their text a
 *   parameter, an UPDATE ... FROM;
 * - "wider member": an insert into the narrow relation of the wide one's facts, the wide text read into the narrow
 *   field, where a stored wide fact holds a text past the narrow domain, which refuses it;
 * - "wider deletion": a deletion from the narrow relation of the wide one's facts, which removes the stored narrow fact
 *   a stored wide fact equals, while a wide text past the narrow domain matches no fact;
 * - "candidate repeated": the change adds a keyed fact at a stored fact's candidate key, refused by that key;
 * - "immediate violated": the change adds a member naming no fact of the pure set, refused at its statement by the
 *   immediate containment;
 * - "serial collision": a generated addition to the serialized relation, whose identity sequence starts behind a
 *   stored fact holding its first value, so the realization draws that value, collides, and draws again;
 * - "lagging identical": the same lagging sequence, setval(seq, k, false) at the stored key k, and one stratum that
 *   deletes the stored fact at k beside a generated addition of its other fields, which draws k after the deletion:
 *   the fact the stratum removes and adds back is identical, so delta.added and delta.removed, both read back, hold
 *   neither (write/delta/net.ts stratumChange, a set difference);
 * - "lagging differing": the same, the generated addition's other field differing, so the read-backs hold one
 *   removal and one addition;
 * - "lagging repeat": a generated addition into the numbered relation, whose identity column lies outside its key, of a
 *   stored fact's key, its sequence lagging at that fact's identity value: the realization draws the stored fact
 *   again, its plain INSERT meets it at the key, and the change is refused there, as a draw of any fresh value would
 *   be; the stored fact never stands in for the addition;
 * - "lagging retried": the lagging identical deletion beside a second generated addition, a stored fact at the
 *   sequence's second value: the realization's draws meet that fact, the attempt fails with GeneratedSerialUnique and
 *   the next draws past both stored values, so neither addition repeats the deleted fact, which the calculator's own
 *   draws may; the outcome is judged under the realization's draws (expect.ts Expected's pin);
 * - "lagging put": a described put of the tallied relation's own facts, an UPDATE ... FROM that changes nothing, its
 *   sequence lagging behind the stored keys: a put names complete facts, so it advances the sequence past their
 *   serial values whatever statement realizes it;
 * - "lagging referenced": a deletion of an issued fact a holding references beside a generated addition into issued,
 *   whose lagging sequence could draw the deleted fact's value: the deletion meets the immediate containment at its
 *   own statement, so the change is refused, as with any fresh value; no draw re-creates the referenced fact first;
 * - "relation parameters": an insert and a deletion of the keyed relation, each a relation parameter's facts;
 * - "typmod cast": an insert into the rounded relation of a precise fact, its numeric(12, 4) read into numeric(5, 2)
 *   and rounded by the cast;
 * - "coerced repeat": an insert of a stored rounded fact spelled as a decimal that rounds to its value at its typmod,
 *   which changes nothing;
 * - "anchored deletion": a deletion of the keyed facts whose b a parameter names, described over the keyed relation
 *   itself, so the DELETE's target plays the member's match (write/delete/anchor.ts);
 * - "single statement": an insert into the parent relation of the keyed facts whose b a parameter names beside the
 *   anchored deletion of those facts, two writes of distinct relations whose stratum one snapshot suffices for, one
 *   statement (write/program/single.ts) where the insert's member reads the relation the deletion writes;
 * - "single statement refused": an insert into the keyed relation of a fact repeating a stored candidate key beside an
 *   insert into the parent relation, one statement, refused by the candidate key with its witness;
 * - "take per parent": an insert into the parent relation of the first two child facts by key of each parent a
 *   relation parameter names, a take bound to the parameter's rows, sent in its LATERAL form, since the parameter's
 *   distinct facts are fewer than lateralParentMax (its whole-relation form is test/pg/write/take-form's);
 * - "take per one parent": the same insert for the first parent alone.
 * The sequential realization of a stratum of several statements is "relation parameters", an insert and a deletion of
 * one relation.
 */
export const plantedArms = [
	"parent present",
	"parent absent",
	"parent violated",
	"capacity overfilled",
	"scoped merge",
	"toast repeat",
	"toast change",
	"described put",
	"wider member",
	"wider deletion",
	"candidate repeated",
	"immediate violated",
	"serial collision",
	"lagging identical",
	"lagging differing",
	"lagging repeat",
	"lagging retried",
	"lagging put",
	"lagging referenced",
	"relation parameters",
	"typmod cast",
	"coerced repeat",
	"anchored deletion",
	"single statement",
	"single statement refused",
	"take per parent",
	"take per one parent"
] as const
export type PlantedArm = (typeof plantedArms)[number]

/**
 * Whether a planted arm's identity sequences start behind the stored values, at 1 and never called (harness.ts
 * ResolvedCase): the arms whose generated addition draws a stored key.
 */
export const plantedBehind = (arm: PlantedArm): boolean =>
	arm === "serial collision" ||
	arm === "lagging identical" ||
	arm === "lagging differing" ||
	arm === "lagging repeat" ||
	arm === "lagging retried" ||
	arm === "lagging put" ||
	arm === "lagging referenced"

export interface ChangeSetSketch {
	readonly strata: Arr.NonEmptyReadonlyArray<ReadonlyArray<MemberSketch>>
	readonly reads: ReadonlyArray<ReadSketch>
	/** The case's swarm (@grizzle/testing/swarm) over writeFeatures. */
	readonly swarm: Swarm<WriteFeature>
}

/**
 * The features a ChangeSet's swarm turns on, off or thins: each kind of member source beyond an enumerated array, more
 * than one stratum, read-backs, the MERGE near misses of the reread pair, coerced spellings, a projection's parameter
 * spelling a text longer than its field's domain admits, Stream members and parameters, ChangeSet.bind, db.compile,
 * and unit additions: into a relation whose every field is an identity, a described generated addition of no field,
 * whose query holds several rows, beside the enumerated `[{}]` in the same stratum, one new fact in all.
 */
const writeFeatures = [
	"projections",
	"paramMembers",
	"reread",
	"nearMisses",
	"strata",
	"reads",
	"coercion",
	"outsideDomain",
	"streams",
	"bind",
	"compiled",
	"unitAdditions"
] as const
type WriteFeature = (typeof writeFeatures)[number]

const fourPicks = array(pickGen, { min: 4, max: 4 })

const factPickGen: Gen<FactPick> = (source) => ({
	mode: source.draw(int(0, 7)),
	pick: source.draw(pickGen),
	row: source.draw(rowSketchGen),
	spell: source.draw(fourPicks)
})

const headTermGen: Gen<MemberSketch["head"][number]> = (source) => ({
	term: source.draw(int(0, 4)),
	value: source.draw(pickGen),
	spell: source.draw(pickGen)
})

const memberSketchGen: Gen<MemberSketch> = (source) => ({
	op: source.draw(int(0, 2)),
	relation: source.draw(pickGen),
	source: source.draw(int(0, 9)),
	facts: source.draw(array(factPickGen, { min: 0, max: 3 })),
	from: { other: source.draw(boolean), relation: source.draw(pickGen) },
	filter: { on: source.draw(boolean), column: source.draw(pickGen), value: source.draw(pickGen) },
	head: source.draw(array(headTermGen, { min: 4, max: 4 }))
})

/**
 * Between `min` and `max` strata of up to three members each: a stratum of no member is one a ChangeSet keeps (union
 * aligns strata by position), so it has its own weight.
 */
const strataGen = (
	min: number,
	max: number
): Gen<Arr.NonEmptyReadonlyArray<ReadonlyArray<MemberSketch>>> =>
	map(array(array(memberSketchGen, { min: 0, max: 3 }), { min, max }), (strata) =>
		nonEmpty(strata, "a ChangeSet sketch's strata")
	)

const readSketchGen: Gen<ReadSketch> = (source) => ({
	relation: source.draw(pickGen),
	source: source.draw(int(0, 2)),
	parent: {
		on: source.draw(boolean),
		containment: source.draw(pickGen),
		clear: source.draw(boolean)
	}
})

export const changeSetSketchGen: Gen<ChangeSetSketch> = (source) => ({
	strata: source.draw(
		weighted([
			[3, strataGen(1, 1)],
			[2, strataGen(2, 3)]
		])
	),
	reads: source.draw(array(readSketchGen, { min: 0, max: 3 })),
	swarm: source.draw(swarmOf(writeFeatures))
})

const ops: Arr.NonEmptyReadonlyArray<MemberOp> = ["insert", "delete", "put"]
const readSources: Arr.NonEmptyReadonlyArray<ReadSource> = ["added", "removed", "state"]

/** The element a pick selects from a list a generator built. */
const at = <A>(items: ReadonlyArray<A>, pick: number): A =>
	pickFrom(nonEmpty(items, "a generated list"), pick)

/**
 * The keys a planted arm's own facts take: negative, so no drawn fact, whose values come from the domain's small
 * non-negative pools (domain.ts typeInfo), holds them, and a perturbation's copies relabel
 * them to positive ones. A parent and the child naming it share one.
 */
const armKey = -1
const otherKey = -2
const thirdKey = -3

/**
 * A planted fact's values: the wide text's value within the narrow domain and one past it; the unbounded text's first
 * TOAST-sized value and the two TOAST-sized ones that differ in their last code point alone; a numeric(12, 4) value
 * numeric(5, 2) rounds; a numeric(5, 2) value and a decimal that rounds to it at that typmod, half away from zero; and
 * the first value a serial sequence draws.
 */
const planted = {
	narrowText: elementAt(typeInfo.text6.values, 1, "the wide text's values"),
	pastNarrow: elementAt(typeInfo.text6.values, 2, "the wide text's values"),
	toastSized: elementAt(typeInfo.memo.values, 2, "the unbounded text's values"),
	toastBefore: elementAt(typeInfo.memo.values, 3, "the unbounded text's values"),
	toastAfter: elementAt(typeInfo.memo.values, 4, "the unbounded text's values"),
	preciseValue: elementAt(typeInfo["numeric(12, 4)"].values, 2, "the numeric(12, 4) values"),
	roundedValue: elementAt(typeInfo["numeric(5, 2)"].values, 1, "the numeric(5, 2) values"),
	roundsToIt: Decimal.of("1.495"),
	firstSerial: elementAt(typeInfo.serial.values, 0, "the serial values"),
	secondSerial: elementAt(typeInfo.serial.values, 1, "the serial values")
} as const

/**
 * The facts each planted arm plants beside the drawn ones `stored`, by relation.
 *
 * A fact at the sequence's first value, where no drawn fact holds it already.
 *
 * A fact at the sequence's first value, where no drawn fact holds it already.
 */
const plantedFactsOf = (
	p: Planted,
	arm: PlantedArm,
	stored: WFacts
): ReadonlyArray<readonly [WRelation, ReadonlyArray<Fact>]> => {
	const wide: readonly [WRelation, ReadonlyArray<Fact>] = [
		p.wide,
		[
			{ a: armKey, b: planted.narrowText },
			{ a: otherKey, b: planted.pastNarrow }
		]
	]
	switch (arm) {
		case "parent present":
		case "parent violated":
		case "immediate violated":
			return []
		case "parent absent":
			return [
				[p.parent, [{ a: armKey, b: 0 }]],
				[p.child, [{ a: armKey, b: armKey }]]
			]
		case "capacity overfilled":
			return [[p.capped, [{ a: armKey, b: armKey, c: true }]]]
		case "scoped merge":
			return [
				[
					p.merged,
					[
						{ a: armKey, b: armKey, c: "" },
						{ a: otherKey, b: armKey, c: "" }
					]
				]
			]
		case "toast repeat":
			return [[p.merged, [{ a: armKey, b: armKey, c: planted.toastSized }]]]
		case "toast change":
			return [[p.merged, [{ a: armKey, b: armKey, c: planted.toastBefore }]]]
		case "described put":
			return [[p.merged, [{ a: armKey, b: armKey, c: "" }]]]
		case "wider member":
			return [wide]
		case "wider deletion":
			return [wide, [p.narrow, [{ a: armKey, b: planted.narrowText }]]]
		case "candidate repeated":
		case "relation parameters":
			return [[p.keyed, [{ a: armKey, b: armKey }]]]
		case "serial collision":
		case "lagging identical":
		case "lagging differing":
			return Arr.some(
				recordEntryOf(stored, p.serialized.name, "the stored facts"),
				(f) => f["a"] === planted.firstSerial
			)
				? []
				: [[p.serialized, [{ a: planted.firstSerial, b: armKey }]]]
		case "lagging repeat":
			return [[p.numbered, [{ a: armKey, b: planted.firstSerial }]]]
		case "lagging retried": {
			/** A fact at each of the sequence's first two values, where no drawn fact holds it already. */
			const held = recordEntryOf(stored, p.serialized.name, "the stored facts")
			const position = (a: unknown, b: number): ReadonlyArray<Fact> =>
				Arr.some(held, (f) => f["a"] === a) ? [] : [{ a, b }]
			return [
				[
					p.serialized,
					[...position(planted.firstSerial, armKey), ...position(planted.secondSerial, otherKey)]
				]
			]
		}
		case "lagging put":
			return Arr.some(
				recordEntryOf(stored, p.tallied.name, "the stored facts"),
				(f) => f["a"] === planted.firstSerial
			)
				? []
				: [[p.tallied, [{ a: planted.firstSerial, b: armKey }]]]
		case "lagging referenced": {
			/**
			 * Issued facts at the sequence's first two values, where no drawn fact holds them already, and a holding of the
			 * second.
			 */
			const held = recordEntryOf(stored, p.issued.name, "the stored facts")
			const position = (a: unknown): ReadonlyArray<Fact> =>
				Arr.some(held, (f) => f["a"] === a) ? [] : [{ a }]
			return [
				[p.issued, [...position(planted.firstSerial), ...position(planted.secondSerial)]],
				[p.holding, [{ a: armKey, b: planted.secondSerial }]]
			]
		}
		case "typmod cast":
			return [[p.precise, [{ a: armKey, b: planted.preciseValue }]]]
		case "coerced repeat":
			return [[p.rounded, [{ a: armKey, b: planted.roundedValue }]]]
		case "anchored deletion":
			return [
				[
					p.keyed,
					[
						{ a: armKey, b: armKey },
						{ a: otherKey, b: otherKey }
					]
				]
			]
		case "single statement":
		case "single statement refused":
			return [[p.keyed, [{ a: armKey, b: armKey }]]]
		case "take per parent":
		case "take per one parent":
			return [
				[p.parent, Arr.map([armKey, otherKey, thirdKey], (a) => ({ a, b: 0 }))],
				[
					p.child,
					[
						{ a: -10, b: armKey },
						{ a: -11, b: armKey },
						{ a: -12, b: armKey },
						{ a: -20, b: otherKey },
						{ a: -21, b: otherKey }
					]
				]
			]
	}
}

/** The stored facts a planted case writes from: the drawn ones and those its arm plants. */
export const plantedFacts = (group: WGroup, stored: WFacts, arm: PlantedArm): WFacts => {
	const out: Record<string, ReadonlyArray<Fact>> = { ...stored }
	for (const [relation, facts] of plantedFactsOf(plantedOf(group), arm, stored)) {
		out[relation.name] = [...recordEntryOf(stored, relation.name, "the stored facts"), ...facts]
	}
	return out
}

/** A value of b other than `x`. */
const otherThan = (x: unknown): number => (x === armKey ? otherKey : armKey)

/** A described member of `relation` reading `from`, filtered where `filter` says, its head `head`. */
const described = (
	op: MemberOp,
	relation: WRelation,
	from: WRelation,
	filter: { readonly column: string; readonly param: string } | undefined,
	head: Readonly<Record<string, HeadTerm>>
): WMember => ({
	op,
	relation: relation.name,
	source: { kind: "project", from: from.name, filter, head }
})

/** A head term reading the source's field `column`. */
const own = (column: string): HeadTerm => ({ kind: "var", column })

const fromParam = (op: MemberOp, relation: WRelation, param: string): WMember => ({
	op,
	relation: relation.name,
	source: { kind: "param", param }
})

const enumerated = (op: MemberOp, relation: WRelation, facts: ReadonlyArray<Fact>): WMember => ({
	op,
	relation: relation.name,
	source: { kind: "array", facts, stream: false }
})

/**
 * The ChangeSet a planted arm realizes on the planted group (PlantedArm), over `stored`, the facts the case writes from
 * (plantedFacts).
 */
export const plantedChangeSet = (group: WGroup, arm: PlantedArm, stored: WFacts): WChangeSet => {
	const p = plantedOf(group)
	const attached = (from: ReadSource): ReadonlyArray<WRead> => [
		{
			name: "read0",
			relation: p.child.name,
			source: from,
			parent: { kind: "one", containment: p.containment }
		}
	]
	const changeSet = (
		members: ReadonlyArray<WMember>,
		reads: ReadonlyArray<WRead>,
		params: ParamMap
	): WChangeSet => ({
		group: group.index,
		strata: [members],
		reads,
		params,
		binding: "passed",
		entry: "apply"
	})
	/**
	 * A put of the relation parameter rp0 on the mutable relation beside the deletion of its facts whose b is p1 and whose
	 * key rp0 does not hold: one MERGE.
	 */
	const scopedMerge = (put: ReadonlyArray<Fact>, scope: number): WChangeSet =>
		changeSet(
			[
				fromParam("put", p.merged, "rp0"),
				{
					op: "delete",
					relation: p.merged.name,
					source: { kind: "scoped", scope: { column: "b", param: "p1" }, exclude: "rp0" }
				}
			],
			[],
			{ rp0: put, p1: scope }
		)
	/**
	 * The lagging arms: the stored serialized fact at the sequence's first value deleted beside a generated addition of
	 * its other field, `b` as given, read back through delta.added and delta.removed.
	 */
	const lagging = (b: (stored: unknown) => ReadonlyArray<unknown>): WChangeSet => {
		const position = Arr.findFirst(
			recordEntryOf(stored, p.serialized.name, "the stored facts"),
			(f) => f["a"] === planted.firstSerial
		)
		if (Option.isNone(position)) {
			throw new Error("the planted group holds no serialized fact at its sequence's first value")
		}
		const read = (name: string, source: ReadSource): WRead => ({
			name,
			relation: p.serialized.name,
			source,
			parent: { kind: "none" }
		})
		return changeSet(
			[
				enumerated("delete", p.serialized, [position.value]),
				enumerated(
					"insert",
					p.serialized,
					Arr.map(b(position.value["b"]), (x) => ({ b: x }))
				)
			],
			[read("read0", "added"), read("read1", "removed")],
			{}
		)
	}
	const widened = (op: MemberOp): WMember =>
		described(op, p.narrow, p.wide, undefined, { a: own("a"), b: own("b") })
	/** The deletion of the keyed facts whose b is p0, described over the keyed relation itself. */
	const anchored = described(
		"delete",
		p.keyed,
		p.keyed,
		{ column: "b", param: "p0" },
		{ a: own("a"), b: own("b") }
	)
	switch (arm) {
		case "parent present":
			return changeSet(
				[
					enumerated(
						"insert",
						p.parent,
						Arr.map([armKey, otherKey, thirdKey], (a) => ({ a, b: 0 }))
					),
					enumerated(
						"insert",
						p.child,
						Arr.map([armKey, otherKey, thirdKey], (a) => ({ a, b: a }))
					)
				],
				attached("added"),
				{}
			)
		case "parent absent":
			return changeSet(
				[
					enumerated("delete", p.child, [{ a: armKey, b: armKey }]),
					enumerated("delete", p.parent, [{ a: armKey, b: 0 }])
				],
				attached("removed"),
				{}
			)
		case "parent violated":
			return changeSet(
				[enumerated("insert", p.child, [{ a: armKey, b: otherKey }])],
				attached("added"),
				{}
			)
		case "capacity overfilled":
			return changeSet(
				[enumerated("insert", p.capped, [{ a: otherKey, b: armKey, c: true }])],
				[],
				{}
			)
		case "scoped merge":
			return scopedMerge([{ a: armKey, b: armKey, c: "x" }], armKey)
		case "toast repeat":
			return scopedMerge([{ a: armKey, b: armKey, c: planted.toastSized }], otherKey)
		case "toast change":
			return changeSet(
				[enumerated("put", p.merged, [{ a: armKey, b: armKey, c: planted.toastAfter }])],
				[],
				{}
			)
		case "described put":
			return changeSet(
				[
					described(
						"put",
						p.merged,
						p.merged,
						{ column: "b", param: "p0" },
						{ a: own("a"), b: own("b"), c: { kind: "param", param: "p1" } }
					)
				],
				[],
				{ p0: armKey, p1: "y" }
			)
		case "wider member":
			return changeSet([widened("insert")], [], {})
		case "wider deletion":
			return changeSet([widened("delete")], [], {})
		case "candidate repeated":
			return changeSet([enumerated("insert", p.keyed, [{ a: otherKey, b: armKey }])], [], {})
		case "immediate violated":
			return changeSet([enumerated("insert", p.member, [{ a: armKey, b: otherKey }])], [], {})
		case "serial collision":
			return changeSet([enumerated("insert", p.serialized, [{ b: armKey }])], [], {})
		case "lagging identical":
			return lagging((b) => [b])
		case "lagging differing":
			return lagging((b) => [otherThan(b)])
		case "lagging repeat":
			return changeSet([enumerated("insert", p.numbered, [{ a: armKey }])], [], {})
		case "lagging retried":
			return lagging((b) => [b, otherThan(b)])
		case "lagging referenced":
			return changeSet(
				[
					enumerated("delete", p.issued, [{ a: planted.secondSerial }]),
					enumerated("insert", p.issued, [{}])
				],
				[],
				{}
			)
		case "lagging put":
			return changeSet(
				[described("put", p.tallied, p.tallied, undefined, { a: own("a"), b: own("b") })],
				[],
				{}
			)
		case "relation parameters":
			return changeSet(
				[fromParam("insert", p.keyed, "rp0"), fromParam("delete", p.keyed, "rp1")],
				[],
				{
					rp0: [{ a: otherKey, b: otherKey }],
					rp1: [{ a: armKey, b: armKey }]
				}
			)
		case "typmod cast":
			return changeSet(
				[
					described(
						"insert",
						p.rounded,
						p.precise,
						{ column: "a", param: "p0" },
						{ a: own("a"), b: own("b") }
					)
				],
				[],
				{ p0: armKey }
			)
		case "coerced repeat":
			return changeSet(
				[enumerated("insert", p.rounded, [{ a: armKey, b: planted.roundsToIt }])],
				[],
				{}
			)
		case "anchored deletion":
			return changeSet([anchored], [], { p0: armKey })
		case "single statement":
			return changeSet(
				[
					described(
						"insert",
						p.parent,
						p.keyed,
						{ column: "b", param: "p0" },
						{ a: own("a"), b: own("b") }
					),
					anchored
				],
				[],
				{ p0: armKey }
			)
		case "single statement refused":
			return changeSet(
				[
					enumerated("insert", p.keyed, [{ a: otherKey, b: armKey }]),
					enumerated("insert", p.parent, [{ a: armKey, b: 0 }])
				],
				[],
				{}
			)
		case "take per parent":
			return changeSet(
				[
					{
						op: "insert",
						relation: p.parent.name,
						source: { kind: "top", from: p.child.name, on: "b", parents: "rp0", k: 2 }
					}
				],
				[],
				{ rp0: Arr.map([armKey, otherKey, thirdKey], (b) => ({ b })) }
			)
		case "take per one parent":
			return changeSet(
				[
					{
						op: "insert",
						relation: p.parent.name,
						source: { kind: "top", from: p.child.name, on: "b", parents: "rp0", k: 2 }
					}
				],
				[],
				{ rp0: [{ b: armKey }] }
			)
	}
}

/**
 * Resolves a sketch against a group and its stored facts. The sketch's swarm thins its features place by place, each
 * place a decision of the case drawn as the resolution meets it, so a ChangeSet is resolved once, where its case is
 * drawn.
 */
export const resolveChangeSet =
	(group: WGroup, stored: WFacts, sketch: ChangeSetSketch): Gen<WChangeSet> =>
	(source) => {
		const swarm = sketch.swarm
		const kept = (feature: WriteFeature): boolean => source.draw(keep(swarm, feature))
		const params: Record<string, ParamValue> = {}
		let nextParam = 0
		const scalar = (value: ParamValue): string => {
			const name = `p${nextParam++}`
			params[name] = value
			return name
		}
		const relationParam = (facts: ReadonlyArray<Fact>): string => {
			const name = `rp${nextParam++}`
			params[name] = facts
			return name
		}
		/** Facts named by earlier members, by relation, and the generated additions earlier members named. */
		const named = new Map<string, Array<Fact>>()
		const namedGenerated = new Map<string, Array<Fact>>()
		const drawn: Arr.NonEmptyReadonlyArray<ReadonlyArray<MemberSketch>> =
			weightOf(swarm, "strata") > 0 ? sketch.strata : [Arr.headNonEmpty(sketch.strata)]
		/** Generated additions are drawn in the last stratum only (see the header). */
		const last = drawn.length - 1
		/** A fact as the picks spell it: each numeric value canonical or coerced to the same stored value. */
		const spelled = (relation: WRelation, fact: Fact, spell: ReadonlyArray<number>): Fact => {
			if (!kept("coercion")) {
				return fact
			}
			const out: Record<string, unknown> = { ...fact }
			for (const [i, c] of relation.columns.entries()) {
				if (Rec.has(out, c.name)) {
					out[c.name] = coercedSpelling(c.kind, out[c.name], spell[i] ?? 0)
				}
			}
			return out
		}
		const factOf = (relation: WRelation, p: FactPick, generated: boolean): Fact =>
			spelled(relation, drawnFact(relation, p, generated), p.spell)
		/** Half the picks copy an earlier generated addition, which equals it: one requested addition. */
		const drawnFact = (relation: WRelation, p: FactPick, generated: boolean): Fact => {
			const fresh = resolveRow(relation, p.row)
			const serial = new Set(Arr.map(serialColumns(relation), (c) => c.name))
			if (generated && (p.mode <= 1 || p.mode === 7) && serial.size > 0) {
				const earlier = namedGenerated.get(relation.name) ?? []
				if (pickIndex(p.pick, 2) === 1 && earlier.length > 0) {
					return at(earlier, p.row.target)
				}
				const partial = Rec.fromEntries(
					Arr.filter(Rec.toEntries(fresh), ([field]) => !serial.has(field))
				)
				namedGenerated.set(relation.name, [...earlier, partial])
				return partial
			}
			const storedFacts = stored[relation.name] ?? []
			const earlier = named.get(relation.name) ?? []
			const withKeyOf = (keyed: Fact, key: ReadonlyArray<string>): Fact => {
				for (const k of key) {
					fresh[k] = keyed[k]
				}
				return fresh
			}
			switch (p.mode) {
				case 0:
				case 1: {
					const holders = storedFacts.length > 0 ? storedFacts : earlier
					if (relation.keys.length === 0 || holders.length === 0) {
						return fresh
					}
					const key = at(relation.keys, p.row.target)
					const twin = withKeyOf(at(holders, p.pick), key)
					/**
					 * At a primary key no stored or earlier fact holds, where the pools allow one, so the candidate key
					 * alone collides: its primary key fields outside the candidate key move through their pools.
					 */
					const held = new Set(Arr.map([...storedFacts, ...earlier], (f) => factKey(relation, f)))
					/** The twin with its primary key fields outside the candidate key moved through their pools by `shift`. */
					const shifted = (shift: number): Fact => {
						const moved: Record<string, unknown> = { ...twin }
						for (const k of Arr.filter(relation.primaryKey, (f) => !key.includes(f))) {
							const i = Option.getOrThrowWith(
								Arr.findFirstIndex(relation.columns, (c) => c.name === k),
								() => new Error(`${relation.name} has no primary key field ${k}`)
							)
							moved[k] = poolValue(
								relation,
								i,
								elementAt(p.row.values, i % p.row.values.length, "the row sketch's values"),
								shift
							)
						}
						return moved
					}
					const moved = Arr.findFirst(
						Arr.makeBy(8, (shift) => shift),
						(shift) => {
							const candidate = shifted(shift)
							return held.has(factKey(relation, candidate)) ? Option.none() : Option.some(candidate)
						}
					)
					return Option.getOrElse(moved, () => twin)
				}
				case 2:
				case 3:
					return storedFacts.length > 0 ? at(storedFacts, p.pick) : fresh
				case 4:
					return storedFacts.length > 0
						? withKeyOf(at(storedFacts, p.pick), relation.primaryKey)
						: fresh
				case 5:
					return earlier.length > 0 ? at(earlier, p.pick) : fresh
				case 6:
					return earlier.length > 0 ? withKeyOf(at(earlier, p.pick), relation.primaryKey) : fresh
				default:
					return fresh
			}
		}
		/** Remembers the complete facts a member names; a generated addition is no fact a later member could name. */
		const remember = (relation: WRelation, facts: ReadonlyArray<Fact>) => {
			const list = named.get(relation.name) ?? []
			appendAll(
				list,
				Arr.filter(facts, (f) => !isGenerated(relation, f))
			)
			named.set(relation.name, list)
		}
		/** A near miss's further fact of `relation` beside the put, as an enumerated insert. */
		const nearMissInsert = (relation: WRelation, m: MemberSketch): ReadonlyArray<WMember> => {
			const extra = Arr.map(m.facts, (p) => factOf(relation, { ...p, mode: 7 }, false))
			remember(relation, extra)
			return [
				{
					op: "insert",
					relation: relation.name,
					source: { kind: "array", facts: extra, stream: kept("streams") }
				}
			]
		}
		/** The facts of a relation parameter: distinct keys, so the parameter carries no same-key pair of its own. */
		const paramFacts = (
			relation: WRelation,
			picks: ReadonlyArray<FactPick>
		): ReadonlyArray<Fact> => {
			const out: Array<Fact> = []
			const keys = new Set<string>()
			for (const p of picks) {
				const f = factOf(relation, p, false)
				const k = factKey(relation, f)
				if (keys.has(k)) {
					continue
				}
				keys.add(k)
				out.push(f)
			}
			return out
		}
		/**
		 * A projection member. One `outside` its target's domain gives every text field outside a put's kept key a
		 * parameter spelling a wide text's value of more than three code points, which the field's domain refuses, and reads
		 * a relation holding stored facts where the group has one (its target first), so its facts are not empty.
		 */
		const project = (
			target: WRelation,
			m: MemberSketch,
			op: MemberOp,
			generated: boolean,
			outside: boolean
		): WSource => {
			const held = Arr.filter(
				group.relations,
				(r) => recordEntryOf(stored, r.name, "the stored facts").length > 0
			)
			const drawnFrom = m.from.other ? at(group.relations, m.from.relation) : target
			const from = ((): WRelation => {
				if (!outside || held.includes(drawnFrom)) {
					return drawnFrom
				}
				if (held.includes(target)) {
					return target
				}
				const [first] = held
				return first ?? drawnFrom
			})()
			const filterColumn = at(from.columns, m.filter.column)
			const filter = m.filter.on
				? {
						column: filterColumn.name,
						param: scalar(at(typeInfo[filterColumn.kind].values, m.filter.value))
					}
				: undefined
			const head: Record<string, HeadTerm> = {}
			/** A generated addition's head leaves every serial field out, as its first serial field's term says. */
			const serial = serialColumns(target)
			const [serialFirst] = serial
			const firstSerialAt = Arr.findFirstIndex(target.columns, (c) => c.name === serialFirst?.name)
			const omitsSerial =
				generated &&
				op === "insert" &&
				Option.exists(firstSerialAt, (at) => elementAt(m.head, at, "a member's head").term >= 2)
			for (const [i, c] of target.columns.entries()) {
				const h = elementAt(m.head, i, "a member's head")
				if (omitsSerial && Arr.some(serial, (x) => x.name === c.name)) {
					continue
				}
				const candidates = Arr.filter(from.columns, (s) => sameBase(s.kind, c.kind))
				const same =
					from === target ? Arr.findFirst(candidates, (s) => s.name === c.name) : Option.none()
				/** A put over its own relation keeps its key fields most of the time: UPDATE ... FROM's shape. */
				const keepKey =
					op === "put" && Option.isSome(same) && target.primaryKey.includes(c.name) && h.term < 4
				if (keepKey) {
					head[c.name] = { kind: "var", column: same.value.name }
				} else if (outside && c.kind === "text") {
					head[c.name] = {
						kind: "param",
						param: scalar(
							elementAt(
								typeInfo.text6.values,
								2 + pickIndex(h.value, 2),
								"the wide text's values past three code points"
							)
						)
					}
				} else if (h.term < 3 && Option.isSome(same)) {
					head[c.name] = { kind: "var", column: same.value.name }
				} else if (h.term < 4 && candidates.length > 0) {
					head[c.name] = { kind: "var", column: at(candidates, h.value).name }
				} else {
					head[c.name] = {
						kind: "param",
						param: scalar(
							kept("coercion")
								? coercedSpelling(c.kind, at(typeInfo[c.kind].values, h.value), h.spell)
								: at(typeInfo[c.kind].values, h.value)
						)
					}
				}
			}
			return { kind: "project", from: from.name, filter, head }
		}
		const strata: Arr.NonEmptyArray<Array<WMember>> = Arr.map(drawn, (members, index) => {
			const out: Array<WMember> = []
			for (const m of members) {
				const relation = at(group.relations, m.relation)
				const op = elementAt(ops, m.op, "the member ops")
				const generated = op === "insert" && index === last
				/**
				 * A relation parameter of a heading with an identity field is not generated: an explicit serial value
				 * travels in an enumerated or described complete fact.
				 */
				const plain = serialColumns(relation).length === 0
				if (m.source >= 9 && plain && kept("reread")) {
					const facts = paramFacts(relation, m.facts)
					remember(relation, facts)
					const input = relationParam(facts)
					const scopeColumn = at(relation.columns, m.filter.column)
					const scope = {
						column: scopeColumn.name,
						param: scalar(at(typeInfo[scopeColumn.kind].values, m.filter.value))
					}
					/**
					 * A near miss of the MERGE proof (a deletion that is exactly "every fact of r in a scope whose key is not in
					 * the put input", and nothing else added to r), which must be realized by separate statements, or by a
					 * MERGE only where it still means the same: the deletion excludes the keys of another relation parameter
					 * (its facts reversed, the last dropped), or the stratum adds a further fact to r beside the put.
					 */
					const miss = kept("nearMisses") ? m.op : 0
					const other =
						miss === 1
							? relationParam(Arr.reverse([...facts]).slice(0, Math.max(0, facts.length - 1)))
							: input
					out.push({ op: "put", relation: relation.name, source: { kind: "param", param: input } })
					out.push({
						op: "delete",
						relation: relation.name,
						source: { kind: "scoped", scope, exclude: other }
					})
					appendAll(out, miss === 2 ? nearMissInsert(relation, m) : [])
					continue
				}
				if (m.source === 8 && plain && kept("paramMembers")) {
					const facts = paramFacts(relation, m.facts)
					remember(relation, facts)
					out.push({
						op,
						relation: relation.name,
						source: { kind: "param", param: relationParam(facts) }
					})
					continue
				}
				/**
				 * A unit addition (see `writeFeatures`): the described one reads the first relation holding several stored
				 * facts, else the target itself, its head of no field the unit relation's one fact per row it reads.
				 */
				if (
					generated &&
					serialColumns(relation).length === relation.columns.length &&
					kept("unitAdditions")
				) {
					const several = Arr.filter(
						group.relations,
						(r) => recordEntryOf(stored, r.name, "the stored facts").length > 1
					)
					const [from] = several
					out.push({
						op,
						relation: relation.name,
						source: {
							kind: "project",
							from: from === undefined ? relation.name : from.name,
							filter: undefined,
							head: {}
						}
					})
					out.push({
						op,
						relation: relation.name,
						source: { kind: "array", facts: [{}], stream: kept("streams") }
					})
					continue
				}
				/** A member adding to a relation with a text field may be a projection outside that field's domain. */
				const outside =
					op !== "delete" &&
					Arr.some(relation.columns, (c) => c.kind === "text") &&
					kept("outsideDomain")
				if (outside || (m.source >= 5 && m.source <= 7 && kept("projections"))) {
					out.push({
						op,
						relation: relation.name,
						source: project(relation, m, op, generated, outside)
					})
					continue
				}
				const facts = Arr.map(m.facts, (p) => factOf(relation, p, generated))
				remember(relation, facts)
				out.push({
					op,
					relation: relation.name,
					source: { kind: "array", facts, stream: kept("streams") }
				})
			}
			return out
		})
		const reads: Array<WRead> = []
		/**
		 * The deferred containments, whose target a read of their source may attach: an immediate one targets a pure set,
		 * whose attached child would find no field.
		 */
		const deferred = Arr.filter(group.containments, (x) => !isImmediate(group, x))
		const addRead = (r: ReadSketch): void => {
			/**
			 * A read attaching a parent reads the source of a deferred containment, the facts it removed where it clears.
			 */
			const attached =
				r.parent.on && deferred.length > 0 ? at(deferred, r.parent.containment) : undefined
			const relation =
				attached === undefined ? at(group.relations, r.relation).name : attached.from.relation
			const source =
				attached !== undefined && r.parent.clear
					? "removed"
					: elementAt(readSources, r.source, "the read-back sources")
			if (Arr.some(reads, (x) => x.relation === relation && x.source === source)) {
				return
			}
			const parent: WParent =
				attached === undefined ? { kind: "none" } : { kind: "one", containment: attached }
			reads.push({ name: `read${reads.length}`, relation, source, parent })
			/**
			 * A read of the removed facts attaching their parents may clear the containment's target, then its source, in
			 * the last stratum: each removed fact's parent is then absent, and a source fact the stratum keeps or adds
			 * violates the deferred containment.
			 */
			const lastStratum = Arr.lastNonEmpty(strata)
			if (parent.kind === "one" && source === "removed" && r.parent.clear) {
				for (const cleared of [parent.containment.to.relation, parent.containment.from.relation]) {
					const of = relationIn(group, cleared)
					lastStratum.push({
						op: "delete",
						relation: of.name,
						source: {
							kind: "project",
							from: of.name,
							filter: undefined,
							head: Rec.fromEntries(Arr.map(of.columns, (c) => [c.name, own(c.name)] as const))
						}
					})
				}
			}
		}
		for (const r of weightOf(swarm, "reads") > 0 ? sketch.reads : []) {
			addRead(r)
		}
		const binding: Binding = kept("bind")
			? kept("streams")
				? "bound as streams"
				: "bound"
			: "passed"
		return {
			group: group.index,
			strata,
			reads,
			params,
			binding,
			entry: kept("compiled") ? "compile" : "apply"
		}
	}

/**
 * The facts a delta makes present or absent, as a source a read-back matches. A Source is a phantom type, which the
 * runtime's delta source value has by construction (core/phantom.ts).
 */
const deltaSource = (
	d: DeltaValue,
	side: "added" | "removed",
	relation: WRelationValue
): Source<RelationFact<WRelationValue>> => d[side](relation)

/**
 * The ChangeSet value and the parameters its call passes, built by the real builders over the schema value `schema` and
 * its relation values. A generated ChangeSet's members are known only at run time, so it is built through the runtime
 * ChangeSet, which takes members as a JavaScript caller passes them and checks them; each described member is a query
 * of the typed builder. A bound ChangeSet closes every parameter, so its call passes none.
 */
export interface Built {
	readonly changes: ChangeSetValue
	readonly params: ParamMap
}

export const buildChangeSet = (
	schema: WSchemaValue,
	relations: Readonly<Record<string, WRelationValue>>,
	group: WGroup,
	c: WChangeSet
): Built => {
	const rel = (name: string): WRelationValue => {
		const r = relations[name]
		if (r === undefined) {
			throw new Error(`no relation value ${name}`)
		}
		return r
	}
	/** The descriptor of a relation's column, which a parameter compared with or written into it is declared with. */
	const descriptorOf = (relation: string, column: string): FieldBase =>
		field(rel(relation).fields, column)
	const field = <T>(vars: Readonly<Record<string, T>>, column: string): T => {
		const term = vars[column]
		if (term === undefined) {
			throw new Error(`no variable for ${column}`)
		}
		return term
	}
	const bindAll = <T>(relation: WRelation, vars: Readonly<Record<string, T>>): Record<string, T> =>
		Rec.fromEntries(Arr.map(relation.columns, (col) => [col.name, field(vars, col.name)]))
	const sourceValue = (target: WRelation, source: WSource): MemberInput => {
		switch (source.kind) {
			case "array":
				return source.stream ? Stream.fromIterable(source.facts) : source.facts
			case "project": {
				const from = relationIn(group, source.from)
				const filter = source.filter
				return query(schema).rule((r) => {
					const vars = v(rel(from.name), "from")
					const matched = r.match(rel(from.name), bindAll(from, vars))
					const q =
						filter === undefined
							? matched
							: matched.where(
									r.eq(
										field(vars, filter.column),
										r.param(filter.param, descriptorOf(from.name, filter.column))
									)
								)
					const head: HeadShape = {}
					for (const col of target.columns) {
						const t = source.head[col.name]
						if (t !== undefined) {
							head[col.name] =
								t.kind === "var"
									? field(vars, t.column)
									: r.param(t.param, descriptorOf(target.name, col.name))
						}
					}
					return q.find(head)
				})
			}
			case "param":
				return query(schema).rule((r) => {
					const vars = v(rel(target.name), "target")
					const all = bindAll(target, vars)
					return r.match(r.relation(source.param, rel(target.name)), all).find(all)
				})
			case "scoped":
				return query(schema).rule((r) => {
					const vars = v(rel(target.name), "target")
					const all = bindAll(target, vars)
					const key: Readonly<Record<string, (typeof vars)[string]>> = Rec.fromEntries(
						Arr.map(target.primaryKey, (k) => [k, field(vars, k)])
					)
					return r
						.match(rel(target.name), all)
						.where(
							r.eq(
								field(vars, source.scope.column),
								r.param(source.scope.param, descriptorOf(target.name, source.scope.column))
							)
						)
						.where(r.not(r.relation(source.exclude, rel(target.name)), key))
						.find(all)
				})
			case "top": {
				/**
				 * Its head is known only at run time, so it is built through the untyped core, as attachedReadBack is.
				 */
				const from = relationIn(group, source.from)
				const termOf = (terms: Readonly<Record<string, unknown>>, name: string): unknown => {
					const term = terms[name]
					if (term === undefined) {
						throw new Error(`no term for ${name}`)
					}
					return term
				}
				const first = queryOver(schema)
					.rule((r: RuleValue): FinishedValue => {
						const vars = varsOver(rel(from.name), "from")
						/** The parent's column is fixed to the parameter, so the head carries the other columns. */
						const others = Rec.fromEntries(
							Arr.map(
								Arr.filter(from.columns, (col) => col.name !== source.on),
								(col) => [col.name, termOf(vars, col.name)]
							)
						)
						return r
							.match(rel(from.name), {
								...others,
								[source.on]: r.param("parent", descriptorOf(from.name, source.on))
							})
							.find(others)
					})
					.orderBy(...argumentsOf(Arr.map(from.primaryKey, (k) => [k, "asc"])))
					.take(source.k)
				return queryOver(schema).rule((r: RuleValue): FinishedValue => {
					const named = r.relation(source.parents, {
						[source.on]: descriptorOf(from.name, source.on)
					})
					const parent = termOf(varsOver(rel(from.name), "parent"), source.on)
					const top = first.bind({ parent })
					const vars = varsOver(top, "top")
					const others = Rec.fromEntries(
						Arr.map(
							Arr.filter(from.columns, (col) => col.name !== source.on),
							(col) => [col.name, termOf(vars, col.name)]
						)
					)
					return r
						.match(named, { [source.on]: parent })
						.match(top, others)
						.find(
							Rec.fromEntries(
								Arr.map(target.columns, (col) => [
									col.name,
									termOf({ ...others, [source.on]: parent }, col.name)
								])
							)
						)
				})
			}
		}
	}
	const strata = Arr.map(c.strata, (members) => {
		let value: ChangeSetValue = ChangeSet.empty(schema)
		for (const m of members) {
			value = value[m.op](rel(m.relation), sourceValue(relationIn(group, m.relation), m.source))
		}
		return value
	})
	const [first, ...rest] = strata
	let value: ChangeSetValue = Arr.reduce(rest, first, (acc, stratum) =>
		ChangeSet.sequence(acc, stratum)
	)
	for (const read of c.reads) {
		const relation = relationIn(group, read.relation)
		const sourceOf = (d: DeltaValue) =>
			read.source === "state" ? rel(relation.name) : deltaSource(d, read.source, rel(relation.name))
		const parent = read.parent
		const readBack: ReadBackInput =
			parent.kind === "none"
				? (d) =>
						query(schema).rule((r) => {
							const all = bindAll(relation, v(rel(relation.name), "relation"))
							return r.match(sourceOf(d), all).find(all)
						})
				: (d) => attachedReadBack(schema, rel, group, relation, sourceOf(d), parent.containment)
		value = value.read(read.name, readBack)
	}
	if (c.binding === "passed") {
		return { changes: value, params: c.params }
	}
	const bound: Record<string, unknown> = {}
	for (const [name, x] of Rec.toEntries(c.params)) {
		bound[name] = c.binding === "bound as streams" && isList(x) ? Stream.fromIterable(x) : x
	}
	return { changes: value.bind(bound), params: {} }
}

/**
 * A read-back of `relation`'s facts in `source` attaching, stated "one", the target fact of `containment` at each row's
 * contained fields: its fields outside the referenced key. Built through the untyped core (see the header), whose
 * attachment child receives the parent row's variables by field name.
 */
const attachedReadBack = (
	schema: WSchemaValue,
	rel: (name: string) => WRelationValue,
	group: WGroup,
	relation: WRelation,
	source: unknown,
	containment: WContainment
): QueryValue => {
	const target = relationIn(group, containment.to.relation)
	const termOf = (terms: Readonly<Record<string, unknown>>, name: string): unknown => {
		const term = terms[name]
		if (term === undefined) {
			throw new Error(`no term for ${name}`)
		}
		return term
	}
	return queryOver(schema)
		.rule((r: RuleValue): FinishedValue => {
			const vars = varsOver(rel(relation.name), "relation")
			const all = Rec.fromEntries(Arr.map(relation.columns, (c) => [c.name, termOf(vars, c.name)]))
			return r.match(source, all).find(all)
		})
		.attach(
			parentSlot,
			(row: Readonly<Record<string, unknown>>) =>
				queryOver(schema).rule((r: RuleValue): FinishedValue => {
					const vars = varsOver(rel(target.name), "target")
					const bindings: Record<string, unknown> = {}
					const head: Record<string, unknown> = {}
					for (const c of target.columns) {
						const i = containment.to.fields.indexOf(c.name)
						if (i >= 0) {
							bindings[c.name] = termOf(
								row,
								elementAt(containment.from.fields, i, "the contained fields")
							)
						} else {
							bindings[c.name] = termOf(vars, c.name)
							head[c.name] = termOf(vars, c.name)
						}
					}
					return r.match(rel(target.name), bindings).find(head)
				}),
			"one"
		)
}

const equalOn = (relation: WRelation, column: string, a: unknown, b: unknown): boolean => {
	const kind = columnOf(relation, column).kind
	return valueIdentity(kind, a) === valueIdentity(kind, b)
}

/** A relation parameter's value: the facts the case binds it to, each a record of field values. */
export const isFact = (value: unknown): value is Fact =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const factsParam = (params: ParamMap, name: string): ReadonlyArray<Fact> => {
	const value = params[name]
	if (!isList(value)) {
		throw new Error(`the relation parameter ${name} is no list of facts`)
	}
	return Arr.map(value, (fact: unknown) => {
		if (!isFact(fact)) {
			throw new Error(`the relation parameter ${name} holds a value that is no fact`)
		}
		return fact
	})
}

/** A described member's facts, by definition, against `state`, the state before its stratum. */
export const evaluateSource = (
	group: WGroup,
	target: WRelation,
	source: WSource,
	params: ParamMap,
	state: OracleState
): ReadonlyArray<Fact> => {
	switch (source.kind) {
		case "array":
			return source.facts
		case "project": {
			const from = relationIn(group, source.from)
			const filter = source.filter
			const kept =
				filter === undefined
					? factsOf(state, from.name)
					: Arr.filter(factsOf(state, from.name), (fact) =>
							equalOn(from, filter.column, fact[filter.column], params[filter.param])
						)
			return Arr.map(kept, (fact): Fact =>
				Rec.fromEntries(
					Arr.flatMap(target.columns, (c) => {
						const t = source.head[c.name]
						return t === undefined
							? []
							: [[c.name, t.kind === "var" ? fact[t.column] : params[t.param]] as const]
					})
				)
			)
		}
		case "param":
			return factsParam(params, source.param)
		case "scoped": {
			const excluded = new Set(
				Arr.map(factsParam(params, source.exclude), (f) => factKey(target, f))
			)
			return Arr.filter(
				factsOf(state, target.name),
				(f) =>
					equalOn(
						target,
						source.scope.column,
						f[source.scope.column],
						params[source.scope.param]
					) && !excluded.has(factKey(target, f))
			)
		}
		case "top": {
			/** The planted top members order an int4 key, which compares as a number. */
			const from = relationIn(group, source.from)
			const [key, ...more] = from.primaryKey
			if (key === undefined || more.length > 0) {
				throw new Error(`a top member over ${from.name}: one key column`)
			}
			const parents = Arr.map(factsParam(params, source.parents), (p) => p[source.on])
			return Arr.reduce(
				Arr.filter(factsOf(state, from.name), (f) =>
					Arr.some(parents, (p) => equalOn(from, source.on, f[source.on], p))
				),
				new Map<unknown, Array<Fact>>(),
				(groups, f) => {
					const value = Option.getOrThrowWith(
						Arr.findFirst(parents, (p) => equalOn(from, source.on, f[source.on], p)),
						() => new Error("a kept fact matches no parent")
					)
					const byParent = groups.get(value) ?? []
					byParent.push(f)
					groups.set(value, byParent)
					return groups
				}
			)
				.values()
				.flatMap((byParent) =>
					Arr.sort(
						byParent,
						Order.mapInput(Order.Number, (f: Fact) => Number(f[key]))
					).slice(0, source.k)
				)
				.toArray()
		}
	}
}

/** The add-wins calculator's ChangeSet: the same strata and members, described members as functions of the state. */
export const oracleChangeSet = (group: WGroup, c: WChangeSet): OracleChangeSet => {
	const strata = Arr.map(c.strata, (members) => {
		let value = OracleChangeSet.empty()
		for (const m of members) {
			const target = relationIn(group, m.relation)
			const facts =
				m.source.kind === "array"
					? m.source.facts
					: (state: OracleState) => evaluateSource(group, target, m.source, c.params, state)
			value = value[m.op](m.relation, facts)
		}
		return value
	})
	const [first, ...rest] = strata
	return rest.length === 0 ? first : OracleChangeSet.sequence(first, ...argumentsOf(rest))
}

/** A printable form of a ChangeSet, for failure reports. */
export const printFact = (fact: Fact): string =>
	`{ ${Arr.join(
		Arr.map(Rec.toEntries(fact), ([k, x]) => `${k}: ${printValue(x)}`),
		", "
	)} }`

const printSource = (s: WSource): string => {
	switch (s.kind) {
		case "array":
			return `${s.stream ? "Stream " : ""}[${Arr.join(Arr.map(s.facts, printFact), ", ")}]`
		case "project":
			return `project ${s.from}${s.filter === undefined ? "" : ` where ${s.filter.column} = $${s.filter.param}`} find { ${Arr.join(
				Arr.map(
					Rec.toEntries(s.head),
					([k, t]) => `${k}: ${t.kind === "var" ? t.column : `$${t.param}`}`
				),
				", "
			)} }`
		case "param":
			return `param $${s.param}`
		case "scoped":
			return `scoped where ${s.scope.column} = $${s.scope.param} and key not in $${s.exclude}`
		case "top":
			return `first ${s.k} of ${s.from} by key per ${s.on} in $${s.parents}`
	}
}

export const printChangeSet = (c: WChangeSet): string =>
	Arr.join(
		[
			...Arr.map(c.strata, (members, i) =>
				Arr.join(
					[
						`stratum ${i}:`,
						...Arr.map(members, (m) => `  ${m.op} ${m.relation} ${printSource(m.source)}`)
					],
					"\n"
				)
			),
			...Arr.map(
				c.reads,
				(r) =>
					`read ${r.name}: ${r.source} ${r.relation}${r.parent.kind === "one" ? ` attaching ${r.parent.containment.to.relation} by ${Arr.join(r.parent.containment.from.fields, ", ")} as one` : ""}`
			),
			`params: { ${Arr.join(
				Arr.map(
					Rec.toEntries(c.params),
					([k, x]) =>
						`${k}: ${
							isList(x)
								? `[${Arr.join(
										Arr.map(x, (f) => (isFact(f) ? printFact(f) : printValue(f))),
										", "
									)}]`
								: printValue(x)
						}`
				),
				", "
			)} }`,
			`parameters ${c.binding}, through ${c.entry}`
		],
		"\n"
	)

export const printFacts = (facts: WFacts): string =>
	Arr.join(
		Arr.map(
			Rec.toEntries(facts),
			([r, list]) => `${r}: [${Arr.join(Arr.map(list, printFact), ", ")}]`
		),
		"\n"
	)
