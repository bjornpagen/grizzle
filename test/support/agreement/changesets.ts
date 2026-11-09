import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { forcedChooser, generate, sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { valuesFromToken } from "@grizzle/testing/tape"
import { Array as Arr, Effect, Option, Record as Rec, Result, Stream, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { changeOps } from "#adapter/db/db.ts"
import { readParams } from "#adapter/reader/params.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { refinedMember } from "#compiler/codec/scalar.ts"
import { CompileError, type CompileReason } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contractOf } from "#compiler/ir/scalar.ts"
import { Bits, Money, pg } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import { insertableNamesOf } from "#compiler/schema/world.ts"
import {
	changeSetDesc,
	changeSetOver,
	type MemberInput,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { isCarried } from "#compiler/write/insert/statement.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf } from "#compiler/write/program/served.ts"
import {
	Bin,
	Budget,
	Cart,
	Cents,
	Chip,
	Clerk,
	Entry,
	Flag,
	Item,
	Kind,
	Ledger,
	Line,
	Node,
	Order,
	Other,
	Pair,
	Pool,
	Reader,
	Reports,
	Tag,
	Task,
	TaskCount,
	Ticket,
	Twin,
	Work,
	Writer
} from "#test/support/agreement/changeset-schema.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import { checking } from "#test/support/policy.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The ChangeSet population: ChangeSets drawn over Work (./changeset-schema.ts), each read twice, as TypeScript source
 * for one program the type tier checks and through the engine's JavaScript view (the ChangeSet facade, compileWrite over
 * reality and over the applying role, and bindWrite over the facts), which builds, compiles and binds it as db.apply
 * does. The engine is the oracle:
 *
 * - a ChangeSet, and its application through a role's Db, typechecks exactly when the engine builds, compiles and
 *   binds it: a refused case stands under a directive, which the type-test batch disarms;
 * - the Refusal a refused case's directive names is the engine's reason (claimOf);
 * - an admitted ChangeSet's parameters, writes, read-backs and schema are the engine's, and so are the rows of each
 *   relation it writes, the fields its caller writes (Written) and those its addition holds (AdditionIn); its
 *   application's error, success and service channels are ApplyError, the ApplyOutcome of its read-backs, and none,
 *   each asserted exactly.
 *
 * The engine is judged too where a stratum puts an owner and inserts it with its members nested (ownerPairings): at
 * one key the two are two rows at that key, which it refuses on the key before any SQL (README Families).
 *
 * A case is a valid ChangeSet by construction with at most one planted fault, so the one line the case is written on
 * raises at most the one diagnostic its directive names: a read-back name repeated by read, union or sequence, a
 * closed or derived relation written, a read-back of a derived relation's delta, a described member's head that is no
 * fact of its relation or writes an exact value into a plain field, a member fact with a field its relation lacks or
 * some of its serials, missing a field or holding a value outside one, two facts an addition, a deletion or a put lists
 * sharing a key with literal payloads that differ, a family's member fact that is no fact of its relation as the
 * nesting takes it (a root field below a tree's root, a field its relation lacks or a drawn one in a nested member, a
 * nested member missing a field, a counted member nested, an accumulated field or a count in a put, a generated field
 * in an insert), a family write the engine cannot plan (a sequence's member written
 * alone or by its row, a tree's row put or deleted, an immutable owner put, a member of an immutable owner's family
 * deleted), a fold over a delta reading no key, ChangeSets over schemas that are no levels of one another, a role that
 * does not write the relation (or a member its insert nests), a parameter left unbound, a compiled ChangeSet read as a
 * query, an argument naming no parameter, ChangeSet.bind given a value that is no record. The floor's witnesses (changeSetWitnesses), the same in every run, each aimed at a requirement, reach every
 * fault and every construct.
 *
 * A built ChangeSet may write its inserts as one insertAll (callsOf): each insert of a relation no insert before it in
 * the call writes, under its relation's name, an appended owner and its members two keys. The engine reads the same
 * call, so every fault an insert's member carries, planted at an insertAll key, is refused there by the engine and by
 * the types alike.
 *
 * One equivalence, brands being type-only: a contract's value written as its bare base value (`cents: 5n`), which the
 * engine checks by value and admits, the types refuse for its missing brand, as the head no fact of its relation.
 *
 * The engine plans a ChangeSet by its strata, which the types hold too (types/changeset Stratum): an append to an
 * immutable owner's family in a stratum that inserts no such owner, which the engine refuses where it compiles, so the
 * types refuse at the application that compiles it; and a family's members written in more than one stratum, refused at
 * the call that makes the second such stratum.
 */

type RelName = "Task" | "Budget" | "Ticket" | "Pair" | "Ledger" | "Tag"
const relNames: Arr.NonEmptyReadonlyArray<RelName> = [
	"Task",
	"Budget",
	"Ticket",
	"Pair",
	"Ledger",
	"Tag"
]
const relations = { Task, Budget, Ticket, Pair, Ledger, Tag } as const

/** A value a case writes: its source and the value the engine's reading builds. */
interface Lit {
	readonly text: string
	readonly value: unknown
}

const uuidLit = (n: number): Lit => {
	const text = `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`
	return { text: jsonText(text), value: text }
}

/**
 * A value outside a field, by its shape: a value of another type, a text outside its roster, a text with fewer than four
 * hyphens at a uuid field, a plain `string`, or a text of another pattern.
 */
interface Outside {
	readonly shape: OutsideShape
	readonly lit: Lit
}

/** A field of a written relation: its name, whether it is a serial, its key, values of its type and ones outside it. */
interface FieldInfo {
	readonly name: string
	readonly serial: boolean
	readonly key: boolean
	readonly values: Arr.NonEmptyReadonlyArray<Lit>
	readonly outside: Arr.NonEmptyReadonlyArray<Outside>
}

const uuids: Arr.NonEmptyReadonlyArray<Lit> = [uuidLit(1), uuidLit(2)]
const cents: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "Cents(5n)", value: Cents(5n) },
	{ text: "Cents(0n)", value: Cents(0n) }
]
const plainNumber: Lit = { text: "1", value: 1 }
const kinds: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: '"Automatic"', value: "Automatic" },
	{ text: '"Manual"', value: "Manual" }
]
const bigints: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "1n", value: 1n },
	{ text: "2n", value: 2n }
]
const textsOf = (texts: Arr.NonEmptyReadonlyArray<string>): Arr.NonEmptyReadonlyArray<Lit> =>
	Arr.map(texts, (t) => ({ text: jsonText(t), value: t }))
const answers = textsOf(["yes", "no"])
const grades = textsOf(["pass", "fail"])

/**
 * The program's `declare const plain: string`: a value whose type is every text, so the engine judges the inhabitant
 * of that type outside every narrower field, which the types refuse with it.
 */
const plainString: Lit = { text: "plain", value: "plain" }
const anotherType = (lit: Lit): Outside => ({ shape: "a value of another type", lit })
const plainOutside: Outside = { shape: "a plain string", lit: plainString }
const uuidOutside: Arr.NonEmptyReadonlyArray<Outside> = [
	anotherType(plainNumber),
	{ shape: "a uuid given a short text", lit: { text: '"0193d8f2"', value: "0193d8f2" } },
	plainOutside
]
const kindOutside: Arr.NonEmptyReadonlyArray<Outside> = [
	{ shape: "a text outside its roster", lit: { text: '"Paused"', value: "Paused" } },
	plainOutside
]
const otherPattern = (lit: Lit): Arr.NonEmptyReadonlyArray<Outside> => [
	{ shape: "another pattern's text", lit },
	plainOutside
]

const fieldsOf: { readonly [R in RelName]: Arr.NonEmptyReadonlyArray<FieldInfo> } = {
	Task: [
		{ name: "id", serial: false, key: true, values: uuids, outside: uuidOutside },
		{ name: "account", serial: false, key: false, values: uuids, outside: uuidOutside },
		{ name: "kind", serial: false, key: false, values: kinds, outside: kindOutside }
	],
	Budget: [
		{ name: "task", serial: false, key: true, values: uuids, outside: uuidOutside },
		{
			name: "cents",
			serial: false,
			key: false,
			values: cents,
			outside: [anotherType(plainNumber)]
		}
	],
	Ticket: [
		{ name: "id", serial: true, key: true, values: bigints, outside: [anotherType(plainNumber)] },
		{ name: "account", serial: false, key: false, values: uuids, outside: uuidOutside },
		{
			name: "amount",
			serial: false,
			key: false,
			values: cents,
			outside: [anotherType(plainNumber)]
		}
	],
	Pair: [
		{ name: "a", serial: true, key: true, values: bigints, outside: [anotherType(plainNumber)] },
		{
			name: "b",
			serial: true,
			key: false,
			values: [{ text: "1", value: 1 }],
			outside: [anotherType({ text: "1n", value: 1n })]
		},
		{ name: "note", serial: false, key: false, values: uuids, outside: uuidOutside }
	],
	Ledger: [
		{ name: "id", serial: false, key: true, values: bigints, outside: [anotherType(plainNumber)] },
		{
			name: "balance",
			serial: false,
			key: false,
			values: [{ text: "5n", value: 5n }],
			outside: [anotherType(plainNumber)]
		},
		{
			name: "fee",
			serial: false,
			key: false,
			values: [{ text: "Money.of(5n)", value: Money.of(5n) }],
			outside: [anotherType({ text: "5n", value: 5n })]
		}
	],
	Tag: [
		{ name: "id", serial: false, key: true, values: uuids, outside: uuidOutside },
		{ name: "kind", serial: false, key: false, values: kinds, outside: kindOutside },
		{
			name: "flags",
			serial: false,
			key: false,
			values: [
				{ text: 'Bits.of(Flag, ["on"])', value: Bits.of(Flag, ["on"]) },
				{ text: "Bits.of(Flag, [])", value: Bits.of(Flag, []) }
			],
			outside: [anotherType(plainNumber)]
		},
		{
			name: "answer",
			serial: false,
			key: false,
			values: answers,
			outside: otherPattern(Arr.headNonEmpty(grades))
		},
		{
			name: "grade",
			serial: false,
			key: false,
			values: grades,
			outside: otherPattern(Arr.headNonEmpty(answers))
		}
	]
}

/** The shapes a value outside its field takes, each a feature of the fault that writes one. */
const outsideShapes = [
	"a value of another type",
	"a text outside its roster",
	"a uuid given a short text",
	"a plain string",
	"another pattern's text"
] as const
type OutsideShape = (typeof outsideShapes)[number]

/**
 * Where a stratum's put of a mutable ordered owner and its insert with its members nested meet: at one key, two rows
 * at that key, since the put leaves the owner's sequence as it is and the insert states it (README Families), which
 * the engine refuses on the key before any SQL; or at different keys, each written.
 */
const ownerPairings = [
	"a put and a nested insert of one owner at one key",
	"a put and a nested insert of one owner at different keys"
] as const
type OwnerPairing = (typeof ownerPairings)[number]

/** The faults a case may plant, one at most, each a swarm feature; and the constructs it may use. */
const changeSetFaults = [
	"a read-back name repeated by read",
	"a read-back name repeated by union",
	"a read-back name repeated by sequence",
	"a closed relation written",
	"a derived relation written",
	"a derived relation's delta read",
	"a head with a field its relation lacks",
	"a head without a field",
	"a head literal outside its field",
	"an exact value into a plain field",
	"a fact with a field its relation lacks",
	"a fact missing a field",
	"a fact value outside its field",
	"an addition with some of its serials",
	"two facts sharing a key",
	"a value missing its brand",
	"a nested root field",
	"a deep root field",
	"a nested field its relation lacks",
	"a nested drawn field",
	"a nested member missing a field",
	"a counted member nested",
	"an accumulated field written",
	"a count written by a put",
	"a generated field supplied",
	"a sequence member written alone",
	"a sequence member edited by its row",
	"a tree row edited",
	"an immutable owner put",
	"a member of an immutable family deleted",
	"an append to an owner its stratum does not insert",
	"a family's members edited in two strata",
	"a drawn count stated in a delete",
	"a fold over a delta reading no key",
	"ChangeSets over unrelated schemas",
	"a role that does not write the relation",
	"a parameter left unbound",
	"a compiled ChangeSet read by execute",
	"a compiled ChangeSet read by get",
	"an argument naming no parameter",
	"a parameter map of a wider type",
	"a bind of a value that is no record"
] as const
type ChangeSetFault = (typeof changeSetFaults)[number]

const changeSetFeatures = [
	...changeSetFaults,
	"insert",
	"delete",
	"put",
	"insertAll",
	"array member",
	"stream member",
	"a widened member",
	"a fact stated twice",
	"described member",
	"family member",
	"nested members",
	"a nested tree",
	"a counted member",
	"a mutable family",
	"an immutable family",
	"an append beside its owner",
	...ownerPairings,
	"a parameter",
	"a narrowed exact value",
	"a head parameter",
	"a head literal",
	"a generated addition",
	"read-back of added facts",
	"read-back of removed facts",
	"read-back of the state",
	"a keyed fold",
	"union",
	"sequence",
	"bind",
	"over an extension",
	"applied",
	"a partial write list",
	"a choice of two ChangeSets applied",
	"a choice of two ChangeSets compiled",
	...outsideShapes
] as const
type ChangeSetFeature = (typeof changeSetFeatures)[number]

/** The Refusals the ChangeSet facade, its compilation and its binding name, by the engine's reason (claimOf). */
const refusalNotes = {
	"read-back names are distinct: this ChangeSet already has a read-back of this name":
		"refused: a read name",
	"read-back names are distinct: the ChangeSets share a read-back name":
		"refused: a shared read name",
	"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes":
		"refused: an ordinary relation",
	"the query's head is not a fact of the relation": "refused: a head",
	"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast":
		"refused: an exact value",
	"a member fact is not a fact of the relation": "refused: a member fact",
	"a sequence's member is written under its owner: nest it in order at the owner's count field":
		"refused: a sequence member",
	"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values":
		"refused: a fold",
	"the ChangeSets' schemas are not levels of one another": "refused: unrelated schemas",
	"a ChangeSet writes only relations its role's write list names": "refused: a write list",
	"two facts of one relation share a key with different values; a key names one fact":
		"refused: a shared key",
	"a compiled ChangeSet applies, and a compiled query reads": "refused: a compiled ChangeSet read",
	"a parameter map names only its program's parameters": "refused: an undeclared parameter",
	"a put or a delete names its rows by their key, and no fact states a key field grizzle writes: key the relation by fields its caller writes":
		"refused: an unstated key",
	"a tree is rewritten whole: insert its root with the whole tree nested": "refused: a tree row",
	"an owner's put updates its row in place, which an immutable owner refuses: declare it mutable to put it":
		"refused: an immutable owner",
	"an immutable owner's family is fixed when its owner is inserted: declare the owner mutable to change it":
		"refused: a fixed family",
	"an immutable owner's family takes an append only beside an insert of its owner in the same stratum: insert the owner with it, or declare it mutable":
		"refused: an append to a stored owner",
	"a ChangeSet writes a family's members in one stratum: each stratum's edits are planned from one read before the ChangeSet's writes":
		"refused: edits in two strata",
	"a served ChangeSet's facts name only the relations of its array members":
		"refused: a served fact's relation"
} as const
type ChangeSetRefusal = keyof typeof refusalNotes
type RefusalNote = (typeof refusalNotes)[ChangeSetRefusal]
export const changeSetRefusals: Arr.NonEmptyReadonlyArray<RefusalNote> = [
	"refused: a read name",
	"refused: a shared read name",
	"refused: an ordinary relation",
	"refused: a head",
	"refused: an exact value",
	"refused: a member fact",
	"refused: a sequence member",
	"refused: a fold",
	"refused: unrelated schemas",
	"refused: a write list",
	"refused: a shared key",
	"refused: a compiled ChangeSet read",
	"refused: an undeclared parameter",
	"refused: an unstated key",
	"refused: a tree row",
	"refused: an immutable owner",
	"refused: a fixed family",
	"refused: an append to a stored owner",
	"refused: edits in two strata",
	"refused: a served fact's relation"
]

/**
 * The facts a served call of an admitted ChangeSet takes through its workload handle (FactsApply): its own array
 * members' facts, which the engine admitted; with one relation's left out, or with a key naming no array member's
 * relation, which the served runtime refuses as the facts' shape; or with one fact carrying a field its relation lacks,
 * judged as the engine judges that ChangeSet with that fact in its member (servedOf).
 */
const servedVariants = [
	"as built",
	"a relation left out",
	"an extra relation",
	"a fact with a field its relation lacks"
] as const
type ServedVariant = (typeof servedVariants)[number]
type ServedNote = `served: ${ServedVariant}`
export const changeSetServed: Arr.NonEmptyReadonlyArray<ServedNote> = [
	"served: as built",
	"served: a relation left out",
	"served: an extra relation",
	"served: a fact with a field its relation lacks"
]

/**
 * The codes a served call's refused facts are reported by: a relation left out fails the facts' constraint, at the
 * argument; a key or a fact FactsCheck refuses, at that key of the facts.
 */
const servedShapeCode = "TS2345"
const servedFactCode = "TS2322"

/** What a case reached: its constructs and fault, the engine's verdict, and the Refusal its directive names. */
export type ChangeSetNote =
	| ChangeSetFeature
	| "admitted"
	| "refused"
	| "refused: structurally"
	| RefusalNote
	| ServedNote

type Op = "insert" | "delete" | "put"
type Level = "Work" | "Reports" | "Other" | "Twin"

/** A field's value in a described member's match or head. */
type HeadTerm =
	| { readonly kind: "var"; readonly field: string }
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "literal"; readonly lit: Lit }
	| { readonly kind: "exact"; readonly field: string; readonly param: string }
	| { readonly kind: "narrowed"; readonly field: string; readonly param: string }

/** A parameter a described member declares: by its field's descriptor, or as a bigint amount. */
interface ParamSpec {
	readonly name: string
	readonly field: string | undefined
}

type MemberSpec =
	| {
			readonly kind: "array" | "stream" | "widened"
			readonly op: Op
			readonly relation: RelName | "Kind"
			readonly facts: Arr.NonEmptyReadonlyArray<ReadonlyArray<readonly [string, Lit]>>
	  }
	| {
			readonly kind: "query"
			readonly op: Op
			readonly relation: RelName
			readonly params: ReadonlyArray<ParamSpec>
			readonly match: ReadonlyArray<readonly [string, HeadTerm]>
			readonly head: ReadonlyArray<readonly [string, HeadTerm]>
	  }
	| {
			readonly kind: "family"
			readonly op: Op
			readonly relation: FamilyRel
			readonly facts: Arr.NonEmptyReadonlyArray<FamilyFact>
	  }
	| {
			/** An insert of a counted family's owners, then of members appended to them, in one stratum. */
			readonly kind: "appended"
			readonly owner: CountedOwner
			readonly owners: Arr.NonEmptyReadonlyArray<FamilyFact>
			readonly members: Arr.NonEmptyReadonlyArray<FamilyFact>
	  }
	| { readonly kind: "derived"; readonly op: Op }

/** Work's families' owners, each immutable or mutable, and their members. */
type OrderedOwner = "Order" | "Cart"
type CountedOwner = "Pool" | "Bin"
const sequenceMembers = { Order: "Line", Cart: "Entry" } as const
const countedMembers = { Pool: "Item", Bin: "Chip" } as const
const mutableOwners: ReadonlyArray<OrderedOwner | CountedOwner> = ["Cart", "Bin"]

/** A relation of Work's families: an owner, an ordered or counted member, or a tree's node. */
type FamilyRel =
	| OrderedOwner
	| CountedOwner
	| (typeof sequenceMembers)[OrderedOwner]
	| (typeof countedMembers)[CountedOwner]
	| "Node"

/** A field of a family member's fact: a value its caller writes, or the rows nested at a count field. */
type FamilyValue =
	| { readonly kind: "value"; readonly lit: Lit }
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<FamilyFact> }
type FamilyFact = ReadonlyArray<readonly [string, FamilyValue]>

/**
 * A read-back: of a written relation's added or removed facts, or of a relation's state, its fields or a count over
 * them; or of a derived relation's delta, which no ChangeSet writes, matched whole into an empty head.
 */
type ReadSpec =
	| {
			readonly kind: "relation"
			readonly name: string
			readonly source: "added" | "removed" | "state"
			readonly relation: RelName
			/** The fields its match binds and its head delivers, or a count over the facts it matches. */
			readonly fold: "none" | "keyed" | "unkeyed"
			readonly fields: Arr.NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "derived"; readonly name: string; readonly source: "added" | "removed" }

interface BuiltSpec {
	readonly kind: "built"
	readonly level: Level
	readonly members: ReadonlyArray<MemberSpec>
	/** Whether its inserts are written as one insertAll (callsOf). */
	readonly grouped: boolean
	readonly reads: ReadonlyArray<ReadSpec>
	/** What ChangeSet.bind is given, if the ChangeSet binds its parameters. */
	readonly bind: Argument | undefined
}

/**
 * A parameter argument: a record of values by name, written in the call or passed through a constant of its own type,
 * which no excess-property check reaches; or, for ChangeSet.bind, a value that is no record, a planted fault.
 */
type Argument =
	| {
			readonly kind: "record" | "variable"
			readonly entries: ReadonlyArray<readonly [string, Lit]>
	  }
	| { readonly kind: "value"; readonly lit: Lit }

type ChangeSpec =
	| BuiltSpec
	| { readonly kind: "union" | "sequence"; readonly a: ChangeSpec; readonly b: ChangeSpec }

/**
 * How a case's ChangeSet is applied: by a role's Db, through apply or compile, with its arguments; or, compiled, read as
 * a query is, by execute or get, or applied through its handle.
 */
interface ApplySpec {
	readonly role: RoleName
	readonly entry: "apply" | "compile" | "execute" | "get" | "compiled apply"
	readonly args: Argument
	/**
	 * Where db.apply or db.compile is given a choice of two ChangeSets, `flip ? c : ChangeSet.sequence(c, choice)`, the
	 * ChangeSet the second branch sequences after the case's own.
	 */
	readonly choice: BuiltSpec | undefined
}

type RoleName = "Writer" | "Clerk" | "Reader"

interface CaseSpec {
	readonly change: ChangeSpec
	readonly apply: ApplySpec | undefined
	readonly fault: ChangeSetFault | undefined
}

/** One case's drawing: its swarm, the source its decisions come from, the constructs it reached and its names. */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<ChangeSetFeature>
	readonly #aim: ReadonlySet<ChangeSetFeature>
	#params = 0
	#reads = 0
	readonly reached = new Set<ChangeSetFeature>()

	/** A drawing aimed at the features `aim` names: a floor witness of a requirement keeps and chooses each of them. */
	constructor(source: Source, drawn: Swarm<ChangeSetFeature>, aim: ReadonlySet<ChangeSetFeature>) {
		this.#source = source
		this.#swarm = drawn
		this.#aim = aim
	}

	/** Whether the drawing is aimed at `feature`. */
	aimed(feature: ChangeSetFeature): boolean {
		return this.#aim.has(feature)
	}

	/** Whether the drawing is aimed at any feature, so it plants a fault only where its aim names one. */
	aiming(): boolean {
		return this.#aim.size > 0
	}

	keep(feature: ChangeSetFeature): boolean {
		const kept = this.wants(feature)
		if (kept) {
			this.reached.add(feature)
		}
		return kept
	}

	/** Whether the drawing keeps `feature`, which the case reaches only once it is noted. */
	wants(feature: ChangeSetFeature): boolean {
		return this.#aim.has(feature) || this.#source.draw(keep(this.#swarm, feature))
	}

	note(feature: ChangeSetFeature): void {
		this.reached.add(feature)
	}

	choose<O extends ChangeSetFeature>(options: Arr.NonEmptyReadonlyArray<O>): O {
		const aimed = Arr.findFirst(options, (o) => this.#aim.has(o))
		const chosen = Option.isSome(aimed)
			? aimed.value
			: this.#source.draw(swarmChoice(this.#swarm, options))
		this.reached.add(chosen)
		return chosen
	}

	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	param(field: string | undefined): ParamSpec {
		const name = `p${this.#params}`
		this.#params += 1
		this.note("a parameter")
		return { name, field }
	}

	readName(): string {
		const name = `r${this.#reads}`
		this.#reads += 1
		return name
	}
}

const fieldInfo = (relation: RelName, name: string): FieldInfo =>
	Option.getOrThrowWith(
		Arr.findFirst(fieldsOf[relation], (f) => f.name === name),
		() => new Error(`${relation} has no field ${name}`)
	)

/** A fact of `relation` as `op` writes it: every field, but an addition may leave out all of its serial fields. */
const factOf = (
	d: Drawing,
	op: Op,
	relation: RelName,
	fault: ChangeSetFault | undefined,
	index: number
): ReadonlyArray<readonly [string, Lit]> => {
	const fields = fieldsOf[relation]
	const generated =
		op === "insert" &&
		fault !== "an addition with some of its serials" &&
		Arr.some(fields, (f) => f.serial) &&
		d.keep("a generated addition")
	const written = Arr.filter(fields, (f) => !(generated && f.serial))
	const base: ReadonlyArray<readonly [string, Lit]> = Arr.map(
		written,
		(f) =>
			[f.name, f.key ? Arr.getUnsafe(f.values, index % f.values.length) : d.from(f.values)] as const
	)
	if (fault === "a fact with a field its relation lacks") {
		return [...base, ["bogus", plainNumber]]
	}
	if (fault === "an addition with some of its serials") {
		return Arr.filter(base, ([name]) => name !== "b")
	}
	const payload = Arr.findFirst(written, (f) => !f.key && !f.serial)
	if (fault === "a fact missing a field" && Option.isSome(payload)) {
		return Arr.filter(base, ([name]) => name !== payload.value.name)
	}
	if (fault === "a fact value outside its field") {
		return Arr.match(outsideTargets(written), {
			onEmpty: () => base,
			onNonEmpty: (targets) => {
				const target = Option.getOrElse(
					Arr.findFirst(targets, (t) => d.aimed(t.outside.shape)),
					() => d.from(targets)
				)
				d.note(target.outside.shape)
				return Arr.map(base, ([name, lit]) =>
					name === target.field ? ([name, target.outside.lit] as const) : ([name, lit] as const)
				)
			}
		})
	}
	return base
}

/** The relations a fact of which may hold a value outside its field of each of `shapes`: with none, every relation. */
const offering = (shapes: ReadonlyArray<OutsideShape>): Arr.NonEmptyReadonlyArray<RelName> =>
	Arr.match(
		Arr.filter(relNames, (r) =>
			Arr.every(shapes, (shape) =>
				Arr.some(outsideTargets(fieldsOf[r]), (t) => t.outside.shape === shape)
			)
		),
		{
			onEmpty: () => {
				throw new Error(`no written relation's field takes ${Arr.join(shapes, " and ")}`)
			},
			onNonEmpty: (offered) => offered
		}
	)

/** The values outside its field a fact's field may be written, each at its field: no key's and no serial's. */
const outsideTargets = (
	fields: ReadonlyArray<FieldInfo>
): ReadonlyArray<{ readonly field: string; readonly outside: Outside }> =>
	Arr.flatMap(fields, (f) =>
		f.key || f.serial ? [] : Arr.map(f.outside, (outside) => ({ field: f.name, outside }))
	)

/**
 * A described member of `relation`: a copy of its facts, each field bound in the match and written in the head as its
 * variable, a key field through a parameter, Ledger's balance raised by a parameter amount under its narrowing guard;
 * an addition into a relation with serial fields may leave all of them to be generated. A planted fault adds a field,
 * drops one, writes a literal outside its field or the raised balance unguarded.
 */
const describedOf = (
	d: Drawing,
	op: Op,
	relation: RelName,
	fault: ChangeSetFault | undefined
): MemberSpec => {
	d.note("described member")
	const fields = fieldsOf[relation]
	const generated =
		op === "insert" && Arr.some(fields, (f) => f.serial) && d.keep("a generated addition")
	const keyParam = d.keep("a parameter") ? d.param(Arr.headNonEmpty(fields).name) : undefined
	const amount =
		relation === "Ledger" &&
		op !== "delete" &&
		(fault === "an exact value into a plain field" || d.keep("a narrowed exact value"))
			? d.param(undefined)
			: undefined
	const bound = (f: FieldInfo): HeadTerm =>
		f.key && keyParam !== undefined
			? { kind: "param", name: keyParam.name }
			: { kind: "var", field: f.name }
	const match = Arr.map(fields, (f) => [f.name, bound(f)] as const)
	const written = Arr.filter(fields, (f) => !(generated && f.serial))
	const headOf = (f: FieldInfo): HeadTerm =>
		f.name === "balance" && amount !== undefined
			? fault === "an exact value into a plain field"
				? { kind: "exact", field: f.name, param: amount.name }
				: { kind: "narrowed", field: f.name, param: amount.name }
			: bound(f)
	const headParam = d.keep("a head parameter")
	const headLiteral = d.keep("a head literal")
	const extraParams: Array<ParamSpec> = []
	const plain = (f: FieldInfo): HeadTerm => {
		if (f.key || f.serial || f.name === "balance" || f.name === "flags") {
			return headOf(f)
		}
		if (headParam && extraParams.length === 0) {
			const p = d.param(f.name)
			extraParams.push(p)
			return { kind: "param", name: p.name }
		}
		return headLiteral ? { kind: "literal", lit: d.from(f.values) } : headOf(f)
	}
	const head = Arr.map(written, (f) => [f.name, plain(f)] as const)
	const planted = ((): ReadonlyArray<readonly [string, HeadTerm]> => {
		if (fault === "a head with a field its relation lacks") {
			const [first] = head
			return first === undefined ? head : [...head, ["extra", first[1]]]
		}
		if (fault === "a head without a field") {
			const dropped = Arr.findFirst(written, (f) => !f.key)
			return Option.isNone(dropped)
				? head
				: Arr.filter(head, ([name]) => name !== dropped.value.name)
		}
		if (fault === "a value missing its brand") {
			const target = Arr.findFirst(written, (f) => f.name === "cents" || f.name === "amount")
			return Option.isNone(target)
				? head
				: Arr.map(head, ([name, term]) =>
						name === target.value.name
							? ([name, { kind: "literal", lit: { text: "5n", value: 5n } }] as const)
							: ([name, term] as const)
					)
		}
		if (fault === "a head literal outside its field") {
			const target = Arr.findFirst(written, (f) => !f.key && !f.serial)
			return Option.isNone(target)
				? head
				: Arr.map(head, ([name, term]) =>
						name === target.value.name
							? ([
									name,
									{ kind: "literal", lit: Arr.headNonEmpty(target.value.outside).lit }
								] as const)
							: ([name, term] as const)
					)
		}
		return head
	})()
	const used = new Set(
		Arr.flatMap([...match, ...planted], ([, t]) =>
			t.kind === "param" ? [t.name] : t.kind === "exact" || t.kind === "narrowed" ? [t.param] : []
		)
	)
	return {
		kind: "query",
		op,
		relation,
		params: Arr.filter(
			[
				...(keyParam === undefined ? [] : [keyParam]),
				...(amount === undefined ? [] : [amount]),
				...extraParams
			],
			(p) => used.has(p.name)
		),
		match,
		head: planted
	}
}

/** The faults a member may carry, by the kind of member that carries it. */
const factFaults: ReadonlyArray<ChangeSetFault> = [
	"two facts sharing a key",
	"a fact with a field its relation lacks",
	"a fact missing a field",
	"a fact value outside its field",
	"an addition with some of its serials"
]
const headFaults: ReadonlyArray<ChangeSetFault> = [
	"a value missing its brand",
	"a head with a field its relation lacks",
	"a head without a field",
	"a head literal outside its field",
	"an exact value into a plain field"
]

/** A member: its operation and relation, then its facts, enumerated or as a Stream, or its description. */
const memberOf = (d: Drawing, fault: ChangeSetFault | undefined, clean: boolean): MemberSpec => {
	if (fault === "a closed relation written") {
		return {
			kind: "array",
			op: "insert",
			relation: "Kind",
			facts: [[["id", { text: '"Automatic"', value: "Automatic" }]]]
		}
	}
	if (fault === "a derived relation written") {
		return { kind: "derived", op: d.choose(["insert", "delete", "put"] as const) }
	}
	const plain =
		d.aimed("described member") ||
		d.aimed("a partial write list") ||
		d.aimed("a generated addition")
	if (fault !== undefined && isFamilyFault(fault)) {
		return plantedFamilyMember(d, fault)
	}
	if (fault === undefined && !plain && d.keep("family member")) {
		return familyMemberOf(d, clean)
	}
	const narrowed = d.aimed("a narrowed exact value")
	const op =
		fault === "an addition with some of its serials"
			? "insert"
			: narrowed
				? d.choose(["insert", "put"] as const)
				: d.choose(["insert", "delete", "put"] as const)
	const relation: RelName =
		fault === "an addition with some of its serials"
			? "Pair"
			: fault === "two facts sharing a key"
				? "Task"
				: fault === "a value missing its brand"
					? d.from(["Budget", "Ticket"] as const)
					: fault === "an exact value into a plain field" || narrowed
						? "Ledger"
						: fault === "a fact value outside its field"
							? d.from(offering(Arr.filter(outsideShapes, (shape) => d.aimed(shape))))
							: d.aimed("a partial write list")
								? d.from(["Task", "Budget"] as const)
								: d.aimed("a generated addition")
									? d.from(["Ticket", "Pair"] as const)
									: d.from(relNames)
	const described =
		fault !== undefined && Arr.contains(headFaults, fault)
			? true
			: fault !== undefined && Arr.contains(factFaults, fault)
				? false
				: d.keep("described member")
	if (described) {
		return describedOf(
			d,
			fault === "an exact value into a plain field" ? "put" : op,
			relation,
			fault
		)
	}
	if (fault === "two facts sharing a key") {
		d.note("array member")
		const first = factOf(d, op, relation, undefined, 0)
		const payload = Arr.findFirst(
			fieldsOf[relation],
			(f) => !f.key && !f.serial && f.values.length > 1
		)
		const second = Arr.map(first, ([n, l]) =>
			Option.isSome(payload) && n === payload.value.name
				? ([n, Arr.getUnsafe(payload.value.values, 1)] as const)
				: ([n, l] as const)
		)
		return { kind: "array", op, relation, facts: [first, second] }
	}
	const planted = fault !== undefined && Arr.contains(factFaults, fault) ? fault : undefined
	const kind =
		planted === undefined &&
		Arr.every(fieldsOf[relation], (f) => !f.serial) &&
		d.keep("a widened member")
			? "widened"
			: d.keep("stream member")
				? "stream"
				: "array"
	if (kind !== "widened") {
		d.note(kind === "stream" ? "stream member" : "array member")
	}
	const first = factOf(d, op, relation, planted, 0)
	const extra =
		planted === undefined && d.keep("a fact stated twice")
			? [first]
			: d.from([0, 1]) === 1
				? [factOf(d, op, relation, undefined, 1)]
				: []
	return { kind, op, relation, facts: [first, ...extra] }
}

/**
 * The faults a family's member fact carries, and the writes of a family's relation the engine cannot plan: a sequence's
 * member written alone or by its row, a tree's row put or deleted, an immutable owner put, a member of an immutable
 * owner's family deleted.
 */
const familyFaults = [
	"a nested root field",
	"a deep root field",
	"a nested field its relation lacks",
	"a nested drawn field",
	"a nested member missing a field",
	"a counted member nested",
	"an accumulated field written",
	"a count written by a put",
	"a generated field supplied",
	"a sequence member written alone",
	"a sequence member edited by its row",
	"a tree row edited",
	"an immutable owner put",
	"a member of an immutable family deleted",
	"an append to an owner its stratum does not insert",
	"a family's members edited in two strata",
	"a drawn count stated in a delete"
] as const satisfies ReadonlyArray<ChangeSetFault>
type FamilyFault = (typeof familyFaults)[number]

/** Whether a fault is one a family's member carries. */
const isFamilyFault = (fault: ChangeSetFault): fault is FamilyFault =>
	Arr.some(familyFaults, (f) => f === fault)

const familyValue = (lit: Lit): FamilyValue => ({ kind: "value", lit })
const nestedRows = (rows: ReadonlyArray<FamilyFact>): FamilyValue => ({ kind: "rows", rows })

/** The ordinals 1 to `count`, none when it is 0. */
const ordinals = (count: number): ReadonlyArray<number> =>
	Arr.filter(Arr.range(1, Math.max(count, 1)), (i) => i <= count)
const labels: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "0", value: 0 },
	{ text: "1", value: 1 }
]
const zero: Lit = { text: "0n", value: 0n }

/**
 * An ordered family's owner with its members nested at its count field, in order, each a quantity; a planted fault
 * gives the first member a field its relation lacks or its drawn index.
 */
const orderOf = (d: Drawing, index: number, fault: ChangeSetFault | undefined): FamilyFact => {
	const planted =
		fault === "a nested field its relation lacks" ||
		fault === "a nested drawn field" ||
		fault === "a nested member missing a field"
	const count = planted || d.aimed("nested members") ? d.from([1, 2]) : d.from([0, 1, 2])
	if (count > 0) {
		d.note("nested members")
	}
	const lines = Arr.map(ordinals(count), (i): FamilyFact => {
		const line: FamilyFact = [["qty", familyValue(d.from(bigints))]]
		return i > 1 || !planted
			? line
			: fault === "a nested member missing a field"
				? []
				: [
						...line,
						fault === "a nested drawn field"
							? ["at", familyValue(zero)]
							: ["note", familyValue(plainNumber)]
					]
	})
	return [
		["id", familyValue(Arr.getUnsafe(uuids, index % uuids.length))],
		["n", nestedRows(lines)]
	]
}

/**
 * A tree, its root with up to two children and a child with a child of its own, every node of a distinct id; a planted
 * fault gives the first child, or the first child's first child, the root field its nesting supplies.
 */
const treeOf = (d: Drawing, fault: ChangeSetFault | undefined): FamilyFact => {
	let next = 0
	const nodeOf = (rooted: boolean, children: ReadonlyArray<FamilyFact>): FamilyFact => {
		next += 1
		return [
			["id", familyValue(uuidLit(next))],
			...(rooted ? [["doc", familyValue(uuidLit(1))] as const] : []),
			["label", familyValue(d.from(labels))],
			["children", nestedRows(children)]
		]
	}
	const nested = fault === "a nested root field"
	const deep = fault === "a deep root field"
	const children = Arr.map(
		ordinals(nested || deep || d.aimed("a nested tree") ? d.from([1, 2]) : d.from([0, 1, 2])),
		(i) => {
			const first = i === 1
			const below = Arr.map(ordinals(deep && first ? 1 : d.from([0, 0, 1])), (j) =>
				nodeOf(deep && first && j === 1, [])
			)
			return nodeOf(nested && first, below)
		}
	)
	if (Arr.isReadonlyArrayNonEmpty(children)) {
		d.note("a nested tree")
	}
	return nodeOf(true, children)
}

/** A counted family's member of `owner`: its value, distinct among a member's facts by their index. */
const countedFact = (owner: Lit, index: number): FamilyFact => [
	["owner", familyValue(owner)],
	["v", familyValue(Arr.getUnsafe(bigints, index % bigints.length))]
]

/** A family's member's written row: its owner's key and its quantity, or its value. */
const keyedRow = (d: Drawing): FamilyFact => [
	["owner", familyValue(d.from(uuids))],
	["qty", familyValue(d.from(bigints))]
]

/** A family member over `relation`, its family noted: a tree's, a mutable owner's, or an immutable owner's. */
const familyOf = (
	d: Drawing,
	op: Op,
	relation: FamilyRel,
	facts: Arr.NonEmptyReadonlyArray<FamilyFact>
): MemberSpec => {
	d.note(
		relation === "Node"
			? "a nested tree"
			: Arr.some(mutableOwners, (o) => o === relation || familyMemberRelation(o) === relation)
				? "a mutable family"
				: "an immutable family"
	)
	return { kind: "family", op, relation, facts }
}

/** A family's member carrying a planted fault: a fact its nesting does not take, or a write the engine cannot plan. */
const plantedFamilyMember = (d: Drawing, fault: FamilyFault): MemberSpec => {
	d.note("family member")
	switch (fault) {
		case "a nested root field":
		case "a deep root field":
			return familyOf(d, "insert", "Node", [treeOf(d, fault)])
		case "a nested field its relation lacks":
		case "a nested drawn field":
		case "a nested member missing a field":
			return familyOf(d, "insert", d.from(["Order", "Cart"] as const), [orderOf(d, 0, fault)])
		case "a counted member nested":
			return familyOf(d, "insert", d.from(["Pool", "Bin"] as const), [
				[
					["id", familyValue(d.from(uuids))],
					["k", nestedRows([[["v", familyValue(d.from(bigints))]]])]
				]
			])
		case "an accumulated field written":
		case "a count written by a put": {
			const owner = d.from(["Cart", "Bin"] as const)
			const field =
				fault === "a count written by a put"
					? ([owner === "Cart" ? "n" : "k", nestedRows([])] as const)
					: ([owner === "Cart" ? "total" : "size", familyValue(zero)] as const)
			return familyOf(d, "put", owner, [[["id", familyValue(d.from(uuids))], field]])
		}
		case "a generated field supplied":
			return familyOf(d, "insert", "Chip", [
				[...countedFact(d.from(uuids), 0), ["next", familyValue({ text: "2n", value: 2n })]]
			])
		case "a sequence member written alone":
			return familyOf(d, "insert", d.from(["Line", "Entry"] as const), [keyedRow(d)])
		case "a sequence member edited by its row":
			return familyOf(d, d.choose(["delete", "put"] as const), d.from(["Line", "Entry"] as const), [
				keyedRow(d)
			])
		case "a tree row edited":
			return familyOf(d, d.choose(["delete", "put"] as const), "Node", [
				[
					["id", familyValue(d.from(uuids))],
					["parent", familyValue(d.from(uuids))],
					["doc", familyValue(d.from(uuids))],
					["label", familyValue(d.from(labels))]
				]
			])
		case "an immutable owner put":
			return familyOf(d, "put", d.from(["Order", "Pool"] as const), [
				[["id", familyValue(d.from(uuids))]]
			])
		case "a member of an immutable family deleted":
			return familyOf(d, "delete", "Item", [countedFact(d.from(uuids), 0)])
		case "an append to an owner its stratum does not insert":
			d.note("a counted member")
			return familyOf(d, "insert", "Item", [countedFact(d.from(uuids), 0)])
		case "a family's members edited in two strata":
			d.note("a counted member")
			return familyOf(d, d.choose(["insert", "delete", "put"] as const), "Chip", [
				countedFact(d.from(uuids), 0)
			])
		case "a drawn count stated in a delete": {
			const owner = d.from(["Order", "Cart", "Pool", "Bin"] as const)
			return familyOf(d, "delete", owner, [
				[
					["id", familyValue(d.from(uuids))],
					[owner === "Order" || owner === "Cart" ? "n" : "k", familyValue(zero)]
				]
			])
		}
	}
}

/**
 * A member of one of Work's families, each over an immutable owner and a mutable one: an ordered family's owner
 * inserted with its members nested, or deleted, and put where it is mutable; a counted family's owner inserted, deleted,
 * and put where it is mutable; a counted member put, inserted where its owner is mutable and beside an insert of its
 * owner where it is not, and deleted where its owner is mutable; or a tree inserted from its root. A counted member is
 * an edit of its family, which a ChangeSet writes in one stratum: a sequence of two cases that write one is refused, so
 * only a case that plants no fault (`clean`) writes one, and no planted fault meets that refusal first.
 */
const familyMemberOf = (d: Drawing, clean: boolean): MemberSpec => {
	d.note("family member")
	const relation = d.aimed("nested members")
		? d.from(["Order", "Cart"] as const)
		: d.aimed("a nested tree")
			? "Node"
			: d.aimed("an append beside its owner")
				? "Item"
				: d.aimed("a counted member")
					? d.from(["Item", "Chip"] as const)
					: d.aimed("a mutable family")
						? d.from(["Cart", "Bin", "Chip"] as const)
						: d.aimed("an immutable family")
							? d.from(["Order", "Pool", "Item"] as const)
							: clean
								? d.from(["Order", "Cart", "Pool", "Bin", "Item", "Chip", "Node"] as const)
								: d.from(["Order", "Cart", "Pool", "Bin", "Node"] as const)
	if (relation === "Node") {
		return familyOf(d, "insert", relation, [treeOf(d, undefined)])
	}
	const op = d.choose(
		relation === "Item"
			? (["insert", "put"] as const)
			: relation === "Order" || relation === "Pool"
				? (["insert", "delete"] as const)
				: (["insert", "delete", "put"] as const)
	)
	const owner = d.from(uuids)
	const facts = Arr.map(Arr.range(1, d.from([1, 2])), (i): FamilyFact => {
		if (relation === "Item" || relation === "Chip") {
			d.note("a counted member")
			return countedFact(owner, i - 1)
		}
		return (relation === "Order" || relation === "Cart") && op === "insert"
			? orderOf(d, i - 1, undefined)
			: [["id", familyValue(Arr.getUnsafe(uuids, (i - 1) % uuids.length))]]
	})
	const written: Arr.NonEmptyReadonlyArray<FamilyFact> = [
		Arr.headNonEmpty(facts),
		...facts.slice(1)
	]
	if (relation === "Item" && op === "insert") {
		d.note("an append beside its owner")
		d.note("an immutable family")
		return {
			kind: "appended",
			owner: "Pool",
			owners: [[["id", familyValue(owner)]]],
			members: written
		}
	}
	return familyOf(d, op, relation, written)
}

/** The member relation of a family's owner. */
const familyMemberRelation = (owner: OrderedOwner | CountedOwner): FamilyRel =>
	owner === "Order" || owner === "Cart" ? sequenceMembers[owner] : countedMembers[owner]

/**
 * A put of the mutable ordered owner beside an insert of it with its members nested, in either order, met as
 * `pairing` says: both at one key, or the put at the first key and the insert at the second, so a union of two such
 * pairs stays at different keys.
 */
const ownerPair = (d: Drawing, pairing: OwnerPairing): Arr.NonEmptyReadonlyArray<MemberSpec> => {
	d.note("family member")
	const shared = d.from([0, 1])
	const [putAt, insertAt]: readonly [number, number] =
		pairing === "a put and a nested insert of one owner at one key" ? [shared, shared] : [0, 1]
	const put = familyOf(d, "put", "Cart", [[["id", familyValue(Arr.getUnsafe(uuids, putAt))]]])
	const insert = familyOf(d, "insert", "Cart", [orderOf(d, insertAt, undefined)])
	return d.from([0, 1]) === 0 ? [put, insert] : [insert, put]
}

/** The keys a stratum's members of the ordered owner `owner` state under `op`: each fact's id, by its literal. */
const ownerKeys = (
	members: ReadonlyArray<MemberSpec>,
	owner: OrderedOwner,
	op: Op
): ReadonlyArray<string> =>
	Arr.flatMap(members, (m) =>
		m.kind === "family" && m.relation === owner && m.op === op
			? Arr.flatMap(m.facts, (fact) =>
					Arr.flatMap(fact, ([name, value]) =>
						name === "id" && value.kind === "value" ? [value.lit.text] : []
					)
				)
			: []
	)

/** Each stratum's members of a ChangeSet: a built's one, a sequence's in turn, a union's aligned position by position. */
const strataOf = (c: ChangeSpec): ReadonlyArray<ReadonlyArray<MemberSpec>> => {
	switch (c.kind) {
		case "built":
			return [c.members]
		case "sequence":
			return [...strataOf(c.a), ...strataOf(c.b)]
		case "union": {
			const a = strataOf(c.a)
			const b = strataOf(c.b)
			const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
			return Arr.map(longer, (members, i) => [...members, ...(shorter[i] ?? [])])
		}
	}
}

/**
 * How each stratum of a ChangeSet that puts the mutable ordered owner and inserts it with its members nested meets
 * them (ownerPairings): at one key where the two state one, else at different keys.
 */
const ownerPairingsOf = (c: ChangeSpec): ReadonlyArray<OwnerPairing> =>
	Arr.flatMap(strataOf(c), (members): ReadonlyArray<OwnerPairing> => {
		const put = ownerKeys(members, "Cart", "put")
		const inserted = ownerKeys(members, "Cart", "insert")
		return !Arr.isReadonlyArrayNonEmpty(put) || !Arr.isReadonlyArrayNonEmpty(inserted)
			? []
			: Arr.some(put, (k) => Arr.contains(inserted, k))
				? ["a put and a nested insert of one owner at one key"]
				: ["a put and a nested insert of one owner at different keys"]
	})

/** A read-back of a written relation's added or removed facts, or of a relation's state, or a count over them. */
const readOf = (
	d: Drawing,
	name: string,
	written: ReadonlyArray<RelName>,
	fault: ChangeSetFault | undefined
): ReadSpec => {
	if (fault === "a derived relation's delta read") {
		const derivedSource = d.choose([
			"read-back of added facts",
			"read-back of removed facts"
		] as const)
		return {
			kind: "derived",
			name,
			source: derivedSource === "read-back of added facts" ? "added" : "removed"
		}
	}
	const delta =
		fault === "a fold over a delta reading no key" ||
		(Arr.isReadonlyArrayNonEmpty(written) && d.from([0, 1, 2]) > 0)
	const relation =
		delta && Arr.isReadonlyArrayNonEmpty(written) ? d.from(written) : d.from(relNames)
	const source = delta
		? d.choose(["read-back of added facts", "read-back of removed facts"] as const)
		: d.choose(["read-back of the state"] as const)
	const fields = fieldsOf[relation]
	const fold =
		fault === "a fold over a delta reading no key"
			? "unkeyed"
			: d.keep("a keyed fold")
				? "keyed"
				: "none"
	const chosen =
		fold === "keyed"
			? Arr.map(
					Arr.filter(fields, (f) => f.key),
					(f) => f.name
				)
			: fold === "unkeyed"
				? Arr.map(
						Arr.filter(fields, (f) => !f.key),
						(f) => f.name
					)
				: Arr.map(fields, (f) => f.name)
	return {
		kind: "relation",
		name,
		source:
			source === "read-back of added facts"
				? "added"
				: source === "read-back of removed facts"
					? "removed"
					: "state",
		relation,
		fold,
		fields: Arr.isReadonlyArrayNonEmpty(chosen) ? chosen : [Arr.headNonEmpty(fields).name]
	}
}

const memberFaults: ReadonlyArray<ChangeSetFault> = [
	...factFaults,
	...headFaults,
	...familyFaults,
	"a closed relation written",
	"a derived relation written"
]

/** The faults a case plants in its one member, which no other member's op may stand beside. */
const soleMemberFaults: ReadonlyArray<ChangeSetFault> = [
	"two facts sharing a key",
	"a derived relation written"
]

/** The value a parameter is bound or passed: one of its field's values, or an amount. */
const paramValue = (relation: RelName, p: ParamSpec): Lit =>
	p.field === undefined
		? { text: "5n", value: 5n }
		: Arr.headNonEmpty(fieldInfo(relation, p.field).values)

/** Each parameter a built ChangeSet declares, with the value bound or passed for it. */
const paramValuesOf = (b: BuiltSpec): ReadonlyArray<readonly [string, Lit]> =>
	Arr.flatMap(b.members, (m) =>
		m.kind === "query" ? Arr.map(m.params, (p) => [p.name, paramValue(m.relation, p)] as const) : []
	)

/** A member of one relation: every member but an appended one, which inserts an owner and its members. */
type Part = Exclude<MemberSpec, { readonly kind: "appended" }>

/** The relation a part writes, by name. */
const partName = (p: Part): string => (p.kind === "derived" ? "TaskCount" : p.relation)

/** The inserts a member makes, each of one relation: an appended member's two, an insert itself, and none else. */
const insertParts = (m: MemberSpec): ReadonlyArray<Part> =>
	m.kind === "appended"
		? [
				{ kind: "family", op: "insert", relation: m.owner, facts: m.owners },
				{ kind: "family", op: "insert", relation: countedMembers[m.owner], facts: m.members }
			]
		: m.op === "insert"
			? [m]
			: []

/** One call of a built ChangeSet: a member's, or one insertAll of parts, each with the position of its member. */
type Call =
	| { readonly kind: "member"; readonly member: MemberSpec }
	| {
			readonly kind: "insertAll"
			readonly entries: Arr.NonEmptyReadonlyArray<{ readonly at: number; readonly part: Part }>
	  }

/**
 * The calls a built ChangeSet is written as, in its members' order: where it is grouped, each member whose inserts write
 * relations no member before it in the insertAll writes is among the insertAll's keys, the call placed where its first
 * member is; every other member is its own call.
 */
const callsOf = (b: BuiltSpec): ReadonlyArray<Call> => {
	const keys = new Set<string>()
	const grouped = Arr.map(b.members, (member) => {
		const parts = b.grouped ? insertParts(member) : []
		if (!Arr.every(parts, (p) => !keys.has(partName(p)))) {
			return { member, parts: [] }
		}
		for (const p of parts) {
			keys.add(partName(p))
		}
		return { member, parts }
	})
	const entries = Arr.flatMap(grouped, ({ parts }, at) => Arr.map(parts, (part) => ({ at, part })))
	return Arr.flatMap(grouped, ({ member, parts }, at): ReadonlyArray<Call> =>
		!Arr.isReadonlyArrayNonEmpty(parts)
			? [{ kind: "member", member }]
			: Arr.isReadonlyArrayNonEmpty(entries) && Arr.headNonEmpty(entries).at === at
				? [{ kind: "insertAll", entries }]
				: []
	)
}

/**
 * A ChangeSet over `level` with up to two members, one to four where its inserts are one insertAll, or, aimed at it, a
 * put and a nested insert of one owner; and up to two read-backs, the first named `readName` where one is given,
 * carrying `fault` where it is a member's or a read-back's.
 */
const builtOf = (
	d: Drawing,
	level: Level,
	fault: ChangeSetFault | undefined,
	readName: string | undefined,
	clean: boolean
): BuiltSpec => {
	if (level === "Other" || level === "Twin") {
		return { kind: "built", level, members: [], grouped: false, reads: [], bind: undefined }
	}
	const memberFault = fault !== undefined && Arr.contains(memberFaults, fault) ? fault : undefined
	const unbound = fault === "a parameter left unbound"
	const grouped = d.wants("insertAll")
	const count =
		memberFault !== undefined && Arr.contains(soleMemberFaults, memberFault)
			? 1
			: grouped
				? d.from([1, 2, 3, 4])
				: memberFault !== undefined ||
					  unbound ||
					  fault === "a role that does not write the relation" ||
					  d.aimed("family member")
					? d.from([1, 2])
					: d.from([0, 1, 1, 2])
	const pairing = Arr.findFirst(ownerPairings, (p) => d.aimed(p))
	const members = Option.isSome(pairing)
		? ownerPair(d, pairing.value)
		: Arr.map(ordinals(count), (i): MemberSpec => {
				if (i === 1 && unbound) {
					return describedWithParam(d)
				}
				return memberOf(d, i === 1 ? memberFault : undefined, clean)
			})
	const written = Arr.flatMap(members, (m): ReadonlyArray<RelName> =>
		(m.kind === "array" || m.kind === "stream" || m.kind === "widened" || m.kind === "query") &&
		m.relation !== "Kind"
			? [m.relation]
			: []
	)
	const repeated = fault === "a read-back name repeated by read"
	const folded =
		fault === "a fold over a delta reading no key" || fault === "a derived relation's delta read"
	const readCount = repeated
		? 2
		: fault === "a derived relation's delta read"
			? 1
			: readName !== undefined || folded
				? d.from([1, 2])
				: d.from([0, 0, 1, 2])
	const names = Arr.map(ordinals(readCount), (i) =>
		i === 1 && readName !== undefined ? readName : repeated && i === 2 ? "r0" : d.readName()
	)
	const reads = Arr.map(names, (name, i) =>
		readOf(d, name, written, i === 0 && folded ? fault : undefined)
	)
	const built: BuiltSpec = { kind: "built", level, members, grouped, reads, bind: undefined }
	if (Arr.some(callsOf(built), (call) => call.kind === "insertAll")) {
		d.note("insertAll")
	}
	if (fault === "a bind of a value that is no record") {
		return { ...built, bind: { kind: "value", lit: { text: "42", value: 42 } } }
	}
	const values = paramValuesOf(built)
	return Arr.isReadonlyArrayNonEmpty(values) && !unbound && d.keep("bind")
		? { ...built, bind: { kind: "record", entries: values } }
		: built
}

/** A described member whose key is a parameter, which a case leaves unbound. */
const describedWithParam = (d: Drawing): MemberSpec => {
	const key = d.param("id")
	return {
		kind: "query",
		op: "put",
		relation: "Task",
		params: [key],
		match: [
			["id", { kind: "param", name: key.name }],
			["account", { kind: "var", field: "account" }],
			["kind", { kind: "var", field: "kind" }]
		],
		head: [
			["id", { kind: "param", name: key.name }],
			["account", { kind: "var", field: "account" }],
			["kind", { kind: "var", field: "kind" }]
		]
	}
}

/** The faults that read a compiled ChangeSet as a compiled query is read. */
const compiledReadFaults: ReadonlyArray<ChangeSetFault> = [
	"a compiled ChangeSet read by execute",
	"a compiled ChangeSet read by get"
]

/** A case's ChangeSet: one built over Work or its extension, or a union or sequence of two. */
const changeOf = (d: Drawing, fault: ChangeSetFault | undefined): ChangeSpec => {
	const clean = fault === undefined
	const applied =
		fault === "a role that does not write the relation" ||
		fault === "a parameter left unbound" ||
		fault === "an append to an owner its stratum does not insert" ||
		fault === "an argument naming no parameter" ||
		fault === "a parameter map of a wider type" ||
		(fault !== undefined && Arr.contains(compiledReadFaults, fault))
	const derivedFault =
		fault === "a derived relation written" || fault === "a derived relation's delta read"
	const level = (): Level =>
		derivedFault || (!applied && d.keep("over an extension")) ? "Reports" : "Work"
	if (
		fault === "a read-back name repeated by union" ||
		fault === "a read-back name repeated by sequence"
	) {
		const name = d.readName()
		return {
			kind: fault === "a read-back name repeated by union" ? "union" : "sequence",
			a: builtOf(d, level(), undefined, name, clean),
			b: builtOf(d, level(), undefined, name, clean)
		}
	}
	if (fault === "ChangeSets over unrelated schemas") {
		const kind = d.choose(["union", "sequence"] as const)
		const other = d.from(["Other", "Twin"] as const)
		return d.from([0, 1]) === 0
			? {
					kind,
					a: builtOf(d, "Work", undefined, undefined, clean),
					b: builtOf(d, other, undefined, undefined, clean)
				}
			: {
					kind,
					a: builtOf(d, other, undefined, undefined, clean),
					b: builtOf(d, "Work", undefined, undefined, clean)
				}
	}
	if (fault === "a family's members edited in two strata") {
		return {
			kind: "sequence",
			a: builtOf(d, level(), fault, undefined, clean),
			b: builtOf(d, level(), fault, undefined, clean)
		}
	}
	const combined = d.keep("union") ? "union" : d.keep("sequence") ? "sequence" : undefined
	if (combined === undefined || (fault !== undefined && !Arr.contains(applicationFaults, fault))) {
		return builtOf(d, level(), fault, undefined, clean)
	}
	return {
		kind: combined,
		a: builtOf(d, level(), undefined, undefined, clean),
		b: builtOf(d, level(), undefined, undefined, clean)
	}
}

/** The level a ChangeSet is over: the higher of a combination's, which are levels of one another. */
const levelOf = (c: ChangeSpec): Level => {
	if (c.kind === "built") {
		return c.level
	}
	const a = levelOf(c.a)
	const b = levelOf(c.b)
	return a === "Reports" || b === "Reports" ? "Reports" : a
}

const builtsOf = (c: ChangeSpec): ReadonlyArray<BuiltSpec> =>
	c.kind === "built" ? [c] : [...builtsOf(c.a), ...builtsOf(c.b)]

/** The parameters a case's ChangeSet leaves free: every one its members declare that no bind closed. */
const freeParams = (c: ChangeSpec): ReadonlyArray<readonly [string, Lit]> =>
	Arr.flatMap(builtsOf(c), (b) => (b.bind === undefined ? paramValuesOf(b) : []))

/** The faults planted in a case's application rather than in its ChangeSet, whatever ChangeSet it applies. */
const applicationFaults: ReadonlyArray<ChangeSetFault> = [
	"a role that does not write the relation",
	"a compiled ChangeSet read by execute",
	"a compiled ChangeSet read by get",
	"an argument naming no parameter",
	"a parameter map of a wider type"
]

/** The relations a member writes as the types read them (WritesOf): its own, and the lines an order's insert nests. */
const memberWrites = (m: MemberSpec): ReadonlyArray<string> => {
	switch (m.kind) {
		case "derived":
			return ["TaskCount"]
		case "family":
			return (m.relation === "Order" || m.relation === "Cart") && m.op === "insert"
				? [m.relation, sequenceMembers[m.relation]]
				: [m.relation]
		case "appended":
			return [m.owner, countedMembers[m.owner]]
		case "array":
		case "stream":
		case "widened":
		case "query":
			return [m.relation]
	}
}

/** The relations the clerk's write list names: no family's member, so an owner's nested insert is outside it. */
const clerkWrites: ReadonlyArray<string> = ["Task", "Budget", "Order", "Cart", "Pool", "Bin"]

/** One case: at most one fault, then its ChangeSet, then, where its level is Work, its application. */
const caseOver = (d: Drawing): CaseSpec => {
	const aimedFault = Arr.findFirst(changeSetFaults, (f) => d.aimed(f))
	const fault = Option.isSome(aimedFault)
		? d.choose([aimedFault.value])
		: !d.aiming() && d.from([0, 1]) === 1
			? d.choose(changeSetFaults)
			: undefined
	const change = changeOf(d, fault)
	const forced =
		fault === "a role that does not write the relation" ||
		fault === "a parameter left unbound" ||
		fault === "an append to an owner its stratum does not insert" ||
		fault === "an argument naming no parameter" ||
		fault === "a parameter map of a wider type" ||
		(fault !== undefined && Arr.contains(compiledReadFaults, fault))
	const applies = forced || d.keep("applied")
	if (!applies || levelOf(change) !== "Work" || (fault !== undefined && !forced)) {
		return { change, apply: undefined, fault }
	}
	d.note("applied")
	const free = freeParams(change)
	const writes = Arr.flatMap(builtsOf(change), (b) => Arr.flatMap(b.members, memberWrites))
	const clerkly = Arr.every(writes, (w) => Arr.contains(clerkWrites, w))
	const entry =
		fault === "a parameter left unbound"
			? "apply"
			: fault === "a compiled ChangeSet read by execute"
				? "execute"
				: fault === "a compiled ChangeSet read by get"
					? "get"
					: fault === "an argument naming no parameter" ||
						  fault === "a parameter map of a wider type"
						? d.from(["apply", "compiled apply"] as const)
						: d.aimed("a choice of two ChangeSets compiled")
							? "compile"
							: d.aimed("a choice of two ChangeSets applied")
								? "apply"
								: d.from(["apply", "apply", "compile"] as const)
	const roleFault =
		fault === "a role that does not write the relation" && Arr.isReadonlyArrayNonEmpty(writes)
	const chosen =
		(fault === undefined || (roleFault && clerkly)) &&
		(entry === "apply"
			? d.keep("a choice of two ChangeSets applied")
			: entry === "compile" && d.keep("a choice of two ChangeSets compiled"))
	const role: RoleName = roleFault
		? chosen
			? "Clerk"
			: clerkly
				? "Reader"
				: d.from(["Reader", "Clerk"] as const)
		: clerkly && d.keep("a partial write list")
			? "Clerk"
			: "Writer"
	if (role === "Clerk") {
		d.note("a partial write list")
	}
	const choice = chosen ? choiceOf(d, role, roleFault) : undefined
	const entries =
		fault === "a parameter left unbound"
			? free.slice(1)
			: fault === "an argument naming no parameter" || fault === "a parameter map of a wider type"
				? [...free, ["x", plainNumber] as const]
				: free
	return {
		change,
		apply: {
			role,
			entry,
			args: { kind: fault === "a parameter map of a wider type" ? "variable" : "record", entries },
			choice
		},
		fault
	}
}

/**
 * The ChangeSet a choice sequences after the case's own in its other branch: one fact's insert, into a relation the
 * role writes, or, where the case plants a write outside its role's write list, into one the clerk does not write.
 */
const choiceOf = (d: Drawing, role: RoleName, outside: boolean): BuiltSpec => {
	const relation =
		role !== "Clerk"
			? d.from(relNames)
			: outside
				? d.from(["Ticket", "Pair", "Ledger", "Tag"] as const)
				: d.from(["Task", "Budget"] as const)
	return {
		kind: "built",
		level: "Work",
		members: [
			{
				kind: "array",
				op: "insert",
				relation,
				facts: [factOf(d, "insert", relation, undefined, 0)]
			}
		],
		grouped: false,
		reads: [],
		bind: undefined
	}
}

/** The source of a case's ChangeSet and its application, with the names it uses. */
class Rendering {
	readonly uses = new Set<
		| "Compute"
		| "Stream"
		| "Money"
		| "pg"
		| Level
		| RelName
		| FamilyRel
		| "Kind"
		| "TaskCount"
		| "Cents"
		| "Bits"
		| "Flag"
		| RoleName
		| "flip"
		| "plain"
	>()

	lit(l: Lit): string {
		if (l === plainString) {
			this.uses.add("plain")
		}
		if (Str.startsWith("Cents(")(l.text)) {
			this.uses.add("Cents")
		}
		if (Str.startsWith("Money.")(l.text)) {
			this.uses.add("Money")
		}
		if (Str.startsWith("Bits.")(l.text)) {
			this.uses.add("Bits")
			this.uses.add("Flag")
		}
		return l.text
	}

	fact(f: ReadonlyArray<readonly [string, Lit]>): string {
		return `{ ${Arr.join(
			Arr.map(f, ([n, l]) => `${n}: ${this.lit(l)}`),
			", "
		)} }`
	}

	familyFact(f: FamilyFact): string {
		return `{ ${Arr.join(
			Arr.map(
				f,
				([n, x]) =>
					`${n}: ${
						x.kind === "value"
							? this.lit(x.lit)
							: `[${Arr.join(
									Arr.map(x.rows, (row) => this.familyFact(row)),
									", "
								)}]`
					}`
			),
			", "
		)} }`
	}

	term(t: HeadTerm): string {
		switch (t.kind) {
			case "var":
				return `s.${t.field}`
			case "param":
				return t.name
			case "literal":
				return this.lit(t.lit)
			case "exact":
				this.uses.add("Compute")
				return `Compute.add(s.${t.field}, ${t.param})`
			case "narrowed":
				this.uses.add("Compute")
				this.uses.add("pg")
				return `Compute.when(Compute.within(Compute.add(s.${t.field}, ${t.param}), -9223372036854775808n, 9223372036854775807n), (g) => Compute.cast(g, pg.bigint), s.${t.field})`
		}
	}

	/** The members a part's call passes: its facts, enumerated or as a Stream, or its description. */
	part(p: Part): string {
		this.uses.add(p.kind === "derived" ? "TaskCount" : p.relation)
		switch (p.kind) {
			case "array":
				return `[${Arr.join(
					Arr.map(p.facts, (f) => this.fact(f)),
					", "
				)}]`
			case "widened":
				return `widen(${p.relation}, [${Arr.join(
					Arr.map(p.facts, (f) => this.fact(f)),
					", "
				)}])`
			case "stream":
				this.uses.add("Stream")
				return `Stream.make(${Arr.join(
					Arr.map(p.facts, (f) => this.fact(f)),
					", "
				)})`
			case "family":
				return `[${Arr.join(
					Arr.map(p.facts, (f) => this.familyFact(f)),
					", "
				)}]`
			case "derived":
				return "[]"
			case "query": {
				const params = Arr.map(p.params, (param) => {
					if (param.field === undefined) {
						this.uses.add("pg")
					}
					return `const ${param.name} = r.param(${jsonText(param.name)}, ${param.field === undefined ? "pg.bigint" : `${p.relation}.fields.${param.field}`}); `
				})
				const record = (fields: ReadonlyArray<readonly [string, HeadTerm]>): string =>
					`{ ${Arr.join(
						Arr.map(fields, ([n, t]) => `${n}: ${this.term(t)}`),
						", "
					)} }`
				return `query(Work).rule((r) => { const s = v(${p.relation}, "s"); ${Arr.join(params, "")}return r.match(${p.relation}, ${record(p.match)}).find(${record(p.head)}) })`
			}
		}
	}

	member(m: MemberSpec): string {
		return m.kind === "appended"
			? Arr.join(
					Arr.map(insertParts(m), (p) => `.insert(${partName(p)}, ${this.part(p)})`),
					""
				)
			: `.${m.op}(${partName(m)}, ${this.part(m)})`
	}

	call(c: Call): string {
		return c.kind === "member"
			? this.member(c.member)
			: `.insertAll({ ${Arr.join(
					Arr.map(c.entries, (e) => `${partName(e.part)}: ${this.part(e.part)}`),
					", "
				)} })`
	}

	read(rd: ReadSpec): string {
		if (rd.kind === "derived") {
			this.uses.add("TaskCount")
			this.uses.add("Reports")
			return `.read(${jsonText(rd.name)}, (delta) => query(Reports).rule((r) => r.match(delta.${rd.source}(TaskCount), {}).find({})))`
		}
		this.uses.add(rd.relation)
		const source = rd.source === "state" ? rd.relation : `delta.${rd.source}(${rd.relation})`
		const bound = Arr.join(
			Arr.map(rd.fields, (f) => `${f}: x.${f}`),
			", "
		)
		const head =
			rd.fold === "none" ? bound : rd.fold === "keyed" ? "n: r.count()" : `${bound}, n: r.count()`
		return `.read(${jsonText(rd.name)}, (${rd.source === "state" ? "" : "delta"}) => query(Work).rule((r) => { const x = v(${source}, "x"); return r.match(${source}, { ${bound} }).find({ ${head} }) }))`
	}

	change(c: ChangeSpec): string {
		if (c.kind !== "built") {
			return `ChangeSet.${c.kind}(${this.change(c.a)}, ${this.change(c.b)})`
		}
		this.uses.add(c.level)
		const bind = c.bind === undefined ? "" : `.bind(${this.args(c.bind)})`
		return `ChangeSet.empty(${c.level})${Arr.join(
			Arr.map(callsOf(c), (call) => this.call(call)),
			""
		)}${Arr.join(
			Arr.map(c.reads, (rd) => this.read(rd)),
			""
		)}${bind}`
	}

	args(a: Argument): string {
		return a.kind === "value"
			? this.lit(a.lit)
			: `{ ${Arr.join(
					Arr.map(a.entries, ([n, l]) => `${n}: ${this.lit(l)}`),
					", "
				)} }`
	}
}

const levels = { Work, Reports, Other, Twin } as const
const closedRelations = { ...relations, Kind } as const
const familyRelations = { Order, Line, Cart, Entry, Pool, Item, Bin, Chip, Node } as const

/** A family member's fact as the facade takes it: each value, and each nested row's fact in its place. */
const familyFactValue = (f: FamilyFact): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(
		Arr.map(
			f,
			([n, x]) => [n, x.kind === "value" ? x.lit.value : Arr.map(x.rows, familyFactValue)] as const
		)
	)

/** The engine's reading of a ChangeSet: the same construct, built by the facade and the query builder's view. */
const buildChange = (c: ChangeSpec): unknown => {
	if (c.kind !== "built") {
		return c.kind === "union"
			? changeSetOver.union(buildChange(c.a), buildChange(c.b))
			: changeSetOver.sequence(buildChange(c.a), buildChange(c.b))
	}
	const withMembers = Arr.reduce(callsOf(c), changeSetOver.empty(levels[c.level]), (cs, call) =>
		call.kind === "insertAll"
			? cs.insertAll(
					Rec.fromEntries(
						Arr.map(call.entries, (e) => [partName(e.part), partInput(e.part)] as const)
					)
				)
			: Arr.reduce(
					call.member.kind === "appended" ? insertParts(call.member) : [call.member],
					cs,
					(at, p) => written(at, p.op, partRelation(p), partInput(p))
				)
	)
	const withReads = Arr.reduce(c.reads, withMembers, (cs, rd) =>
		cs.read(rd.name, (delta: DeltaValue) => readQuery(rd, delta))
	)
	return c.bind === undefined ? withReads : withReads.bind(argumentValue(c.bind))
}

/** The relation value a part names. */
const partRelation = (p: Part): unknown =>
	p.kind === "derived"
		? TaskCount
		: p.kind === "family"
			? familyRelations[p.relation]
			: closedRelations[p.relation]

/** The members a part passes, as the facade takes them: its facts, enumerated or as a Stream, or its query. */
const partInput = (p: Part): MemberInput => {
	const facts = (f: ReadonlyArray<readonly [string, Lit]>) =>
		Rec.fromEntries(Arr.map(f, ([n, l]) => [n, l.value] as const))
	switch (p.kind) {
		case "array":
		case "widened":
			return Arr.map(p.facts, facts)
		case "stream":
			return Stream.fromIterable(Arr.map(p.facts, facts))
		case "query":
			return describedQuery(p)
		case "family":
			return Arr.map(p.facts, familyFactValue)
		case "derived":
			return []
	}
}

/** The value an argument passes: its record of values by name, or the value that is no record. */
const argumentValue = (a: Argument): unknown =>
	a.kind === "value"
		? a.lit.value
		: Rec.fromEntries(Arr.map(a.entries, ([n, l]) => [n, l.value] as const))

/** A ChangeSet with one more member, written by `op`. */
const written = (
	cs: ReturnType<typeof changeSetOver.empty>,
	op: Op,
	target: unknown,
	source: MemberInput
): ReturnType<typeof changeSetOver.empty> =>
	op === "insert"
		? cs.insert(target, source)
		: op === "delete"
			? cs.delete(target, source)
			: cs.put(target, source)

/** The fields' descriptors of each written relation, which a parameter is declared by. */
const descriptors: { readonly [R in RelName]: Readonly<Record<string, unknown>> } = {
	Task: Task.fields,
	Budget: Budget.fields,
	Ticket: Ticket.fields,
	Pair: Pair.fields,
	Ledger: Ledger.fields,
	Tag: Tag.fields
}

const describedQuery = (m: Extract<MemberSpec, { readonly kind: "query" }>) =>
	queryOver(Work).rule((r: RuleValue) => {
		const target = relations[m.relation]
		const s = varsOver(target, "s")
		const params = new Map(
			Arr.map(
				m.params,
				(p) =>
					[
						p.name,
						r.param(p.name, p.field === undefined ? pg.bigint : descriptors[m.relation][p.field])
					] as const
			)
		)
		const term = (t: HeadTerm): unknown => {
			switch (t.kind) {
				case "var":
					return s[t.field]
				case "param":
					return params.get(t.name)
				case "literal":
					return t.lit.value
				case "exact":
					return computeCore.add(s[t.field], params.get(t.param))
				case "narrowed":
					return computeCore.when(
						computeCore.within(
							computeCore.add(s[t.field], params.get(t.param)),
							-9223372036854775808n,
							9223372036854775807n
						),
						(g: unknown) => computeCore.cast(g, pg.bigint),
						s[t.field]
					)
			}
		}
		const record = (fields: ReadonlyArray<readonly [string, HeadTerm]>) =>
			Rec.fromEntries(Arr.map(fields, ([n, t]) => [n, term(t)] as const))
		return r.match(target, record(m.match)).find(record(m.head))
	})

const readQuery = (rd: ReadSpec, delta: DeltaValue): unknown =>
	rd.kind === "derived"
		? queryOver(Reports).rule((r: RuleValue) =>
				r
					.match(rd.source === "added" ? delta.added(TaskCount) : delta.removed(TaskCount), {})
					.find({})
			)
		: relationRead(rd, delta)

const relationRead = (
	rd: Extract<ReadSpec, { readonly kind: "relation" }>,
	delta: DeltaValue
): unknown =>
	queryOver(Work).rule((r: RuleValue) => {
		const target = relations[rd.relation]
		const source =
			rd.source === "state"
				? target
				: rd.source === "added"
					? delta.added(target)
					: delta.removed(target)
		const x = varsOver(source, "x")
		const bound = Rec.fromEntries(Arr.map(rd.fields, (f) => [f, x[f]] as const))
		const head =
			rd.fold === "none"
				? bound
				: rd.fold === "keyed"
					? { n: r.count() }
					: { ...bound, n: r.count() }
		return r.match(source, bound).find(head)
	})

/** What a refused case's directive claims: a Refusal the types name, or a structural refusal in the engine's words. */
type Claim =
	| { readonly kind: "refusal"; readonly refusal: ChangeSetRefusal }
	| { readonly kind: "prose"; readonly why: string }

const oneLine = (text: string): string => Arr.join(Str.split(text, "\n"), " ")

/**
 * The Refusal the types name for a family write the engine's front end cannot plan, by the capability it states
 * (write/frontend/compile.ts); none for any other.
 */
const unplannedOf = (capability: string): ChangeSetRefusal | undefined =>
	Str.includes("a sequence's member is written under its owner")(capability)
		? "a sequence's member is written under its owner: nest it in order at the owner's count field"
		: Str.includes("a tree is rewritten whole")(capability)
			? "a tree is rewritten whole: insert its root with the whole tree nested"
			: Str.includes("the immutable owner of the family")(capability)
				? "an owner's put updates its row in place, which an immutable owner refuses: declare it mutable to put it"
				: Str.startsWith("a delete of")(capability) &&
					  Str.includes("an immutable owner's family is fixed")(capability)
					? "an immutable owner's family is fixed when its owner is inserted: declare the owner mutable to change it"
					: Str.includes("appending to an owner this stratum does not insert")(capability)
						? "an immutable owner's family takes an append only beside an insert of its owner in the same stratum: insert the owner with it, or declare it mutable"
						: Str.startsWith("family members written in more than one stratum")(capability)
							? "a ChangeSet writes a family's members in one stratum: each stratum's edits are planned from one read before the ChangeSet's writes"
							: undefined

/** The Refusal the types name for the engine's reason, the call a repeated read-back name meets telling which. */
const claimOf = (reason: CompileReason, spec: CaseSpec): Claim => {
	if (reason._tag === "MalformedDescription") {
		return Str.includes("distinct read-back names")(reason.what)
			? {
					kind: "refusal",
					refusal:
						spec.change.kind === "built"
							? "read-back names are distinct: this ChangeSet already has a read-back of this name"
							: "read-back names are distinct: the ChangeSets share a read-back name"
				}
			: Str.includes("closed relation")(reason.what) ||
				  Str.includes("derived relation")(reason.what)
				? {
						kind: "refusal",
						refusal:
							"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes"
					}
				: Str.includes("levels of one schema")(reason.what)
					? { kind: "refusal", refusal: "the ChangeSets' schemas are not levels of one another" }
					: Str.startsWith("a literal of")(reason.what)
						? { kind: "refusal", refusal: "the query's head is not a fact of the relation" }
						: Str.startsWith("an operation of the compiled program")(reason.what)
							? {
									kind: "refusal",
									refusal: "a compiled ChangeSet applies, and a compiled query reads"
								}
							: { kind: "prose", why: `the engine: ${oneLine(reason.what)}` }
	}
	if (reason._tag === "UnstatedKey") {
		return {
			kind: "refusal",
			refusal:
				"a put or a delete names its rows by their key, and no fact states a key field grizzle writes: key the relation by fields its caller writes"
		}
	}
	if (reason._tag === "UnsupportedOperation") {
		const refusal = unplannedOf(reason.capability)
		if (refusal !== undefined) {
			return { kind: "refusal", refusal }
		}
	}
	if (reason._tag === "DescribedHeadingMismatch") {
		return Str.startsWith("a member column")(reason.capability)
			? {
					kind: "refusal",
					refusal:
						"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast"
				}
			: { kind: "refusal", refusal: "the query's head is not a fact of the relation" }
	}
	if (reason._tag === "FoldOverProjection") {
		return {
			kind: "refusal",
			refusal:
				"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values"
		}
	}
	if (reason._tag === "OutsideRole") {
		return {
			kind: "refusal",
			refusal: "a ChangeSet writes only relations its role's write list names"
		}
	}
	return { kind: "prose", why: `the engine: ${reason._tag}` }
}

/** What the engine admitted of a case: its free parameters, writes, read-backs and level, as the program spells them. */
interface Admitted {
	readonly params: ReadonlyArray<readonly [string, string]>
	readonly writes: ReadonlyArray<string>
	readonly reads: ReadonlyArray<readonly [string, string]>
	/** Each relation a member writes, with the fields its caller writes and those an addition of it holds. */
	readonly rows: ReadonlyArray<RowShape>
	/** Its array members, as the engine's Description holds them: each one's relation and op. */
	readonly arrays: ReadonlyArray<{ readonly relation: string; readonly op: Op }>
}

/** A written relation's caller-written fields (Written) and the fields its addition in the schema holds (AdditionIn). */
interface RowShape {
	readonly relation: string
	readonly written: ReadonlyArray<string>
	readonly addition: ReadonlyArray<string>
}

/**
 * The row shape of `name`, read off the engine's law model: its fields a caller states (isCarried), and of those, an
 * addition's: less its serial fields, which one arm of an addition leaves out, less a tree's parent, which its nesting
 * supplies, and with the count field of each sequence it owns, at which its members nest.
 */
const rowShapeOf = (laws: ReturnType<typeof realityWrite>["laws"], name: string): RowShape => {
	const relation = laws.relations.get(name)
	if (relation === undefined) {
		throw new Error(`the law model holds no relation ${name}, which a member writes`)
	}
	const heading = relation.relation.heading
	const written = Arr.map(Arr.filter(heading, isCarried), (f) => f.name)
	const omitted = new Set([
		...Arr.flatMap(heading, (f) => (f.writing.kind === "serial" ? [f.name] : [])),
		...Arr.flatMap(laws.families, (f) =>
			isTreeOf(f, name) ? Arr.map(f.group, (g) => g.member.name) : []
		)
	])
	return {
		relation: name,
		written,
		addition: [
			...Arr.filter(written, (f) => !omitted.has(f)),
			...Arr.flatMap(laws.families, (f) =>
				f.owner.name === name && isSequence(f) ? [f.count.name] : []
			)
		]
	}
}

/**
 * Where a refusal lands: the ChangeSet's one line, or its application's.
 */
type Verdict =
	| { readonly kind: "admitted"; readonly admitted: Admitted }
	| {
			readonly kind: "refused"
			readonly at: "change" | "apply"
			readonly claim: Claim
			readonly code: string
	  }

/**
 * The host type a value of the engine's type has, as the program spells it: a pattern's text the inference of its
 * source, as its field's host type is (text/field.ts str.regex).
 */
const hostText = (t: ScalarType): string => {
	const named = contractOf(t)
	if (named !== undefined) {
		return named.name === "Cents" ? "Infer<typeof Cents>" : `unknown /* ${named.name} */`
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "float4":
		case "float8":
			return "number"
		case "int8":
		case "exactInteger":
			return "bigint"
		case "numeric":
			return "Decimal"
		case "money":
		case "exactMoney":
			return "Money"
		case "bool":
			return "boolean"
		case "uuid":
			return "Uuid"
		case "date":
			return "CalendarDate"
		case "text":
			return t.text.regex === "wildcard"
				? "string"
				: Arr.join(
						Arr.map(
							t.text.regex.patterns,
							(p) => `RegexInfer<${jsonText(p.source)}, ${jsonText(p.flags)}>`
						),
						" & "
					)
		case "bytes":
			return "Uint8Array<ArrayBuffer>"
		case "code":
			return Arr.join(
				Arr.map(t.roster.handles, (h) => jsonText(h)),
				" | "
			)
		case "bits":
			return `BitsOf<typeof ${t.roster.closed}>`
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return `unknown /* ${t.carrier} */`
	}
}

/**
 * The ParamType a parameter of the engine's type has, as the program spells it: a closed id's domain is its handles,
 * each branded by its roster, and its language the handles alone; any other's language is its domain.
 */
const paramText = (t: ScalarType): string =>
	t.carrier === "code"
		? `ParamType<${Arr.join(
				Arr.map(
					t.roster.handles,
					(h) => `(${jsonText(h)} & Rostered<${jsonText(t.roster.closed)}>)`
				),
				" | "
			)}, "code", ${hostText(t)}>`
		: `ParamType<${hostText(t)}, ${jsonText(carrierSql[t.carrier])}>`

const refusedAt = (
	at: "change" | "apply",
	thrown: unknown,
	spec: CaseSpec,
	code: string
): Verdict => ({
	kind: "refused",
	at,
	claim:
		thrown instanceof CompileError
			? claimOf(thrown.reason, spec)
			: { kind: "prose", why: `the host: ${oneLine(messageOf(thrown))}` },
	code
})

/** The artifacts and checked schema a level's ChangeSets compile against, over reality. */
const realityOf = (level: Level) => {
	const artifacts = testArtifacts(levels[level], testCompile)
	if (!artifacts.ok) {
		throw artifacts.error
	}
	return { checked: checking(levels[level]), options: realityWrite(artifacts.value) }
}

const roles = { Writer, Clerk, Reader } as const

/** Each level's reality, computed once: every case compiles its ChangeSet against its level's. */
const realities: { readonly [L in Level]: ReturnType<typeof realityOf> } = {
	Work: realityOf("Work"),
	Reports: realityOf("Reports"),
	Other: realityOf("Other"),
	Twin: realityOf("Twin")
}

/** The world a role's Db compiles a ChangeSet in: its checked world and its compile options. */
const roleWorldOf = (name: RoleName) => {
	const artifacts = testArtifacts(roles[name], testCompile)
	if (!artifacts.ok) {
		throw artifacts.error
	}
	const world = artifacts.value.world
	if (world.kind !== "role") {
		throw new Error(`${name}'s artifacts hold no role world`)
	}
	return {
		checked: world.checked,
		options: {
			names: artifacts.value.names,
			reads: artifacts.value.reads,
			claims: { kind: "every" } as const,
			world: { kind: "role", names: world.names } as const,
			laws: artifacts.value.laws,
			derived: artifacts.value.derived
		}
	}
}

/** Each role's world, computed once: every application through a role's Db compiles in its role's. */
const roleWorlds: { readonly [R in RoleName]: ReturnType<typeof roleWorldOf> } = {
	Writer: roleWorldOf("Writer"),
	Clerk: roleWorldOf("Clerk"),
	Reader: roleWorldOf("Reader")
}

/** The facts and arguments of an application, bound as db.apply binds them: the engine's encoding is the oracle. */
const bound = (
	program: CompiledWrite,
	change: unknown,
	args: Readonly<Record<string, unknown>>
) => {
	const parsed = parseChangeSet(change)
	if (parsed === undefined) {
		throw new Error("a ChangeSet the facade built does not parse")
	}
	const members = Effect.runSync(collectInputs(program.binding.groups, parsed.inputs))
	const params = { ...args, ...Rec.fromEntries([...parsed.values]) }
	return bindWrite(program, flightOf(program, program.frontend.codes), {
		members,
		params,
		transport: inForce(bindFrame)
	})
}

/**
 * Whether a member fact holds a value outside its column's refinements (codec/scalar.ts refinedMember): no parameter, so
 * bind passes it, and its column's domain refuses it when the ChangeSet applies.
 */
const outsideItsDomain = (laws: ReturnType<typeof realityWrite>["laws"], c: ChangeSpec): boolean =>
	Arr.some(builtsOf(c), (b) =>
		Arr.some(b.members, (m) => {
			if (m.kind !== "array" && m.kind !== "stream" && m.kind !== "widened") {
				return false
			}
			const relation = laws.relations.get(m.relation)
			if (relation === undefined) {
				throw new Error(`the law model holds no relation ${m.relation}, which a member writes`)
			}
			return Arr.some(relation.relation.heading, (f) => {
				const member = refinedMember(f.type)
				return (
					member !== undefined &&
					Arr.some(m.facts, (fact) =>
						Arr.some(fact, ([name, lit]) => name === f.name && !member(lit.value))
					)
				)
			})
		})
	)

/**
 * The diagnostic a planted fault raises: a fold's head field is a property of an object (TS2322), and so is a member
 * at an insertAll key that its own check refuses, a Stream's under exactOptionalPropertyTypes (TS2375); a Stream
 * member's fact is an argument under exactOptionalPropertyTypes (TS2379), every other an argument (TS2345).
 */
const codeOf = (spec: CaseSpec): string =>
	spec.fault === "a fold over a delta reading no key"
		? "TS2322"
		: keyedFault(spec)
			? streamFirst(spec.change)
				? "TS2375"
				: "TS2322"
			: spec.fault !== undefined && Arr.contains(factFaults, spec.fault) && streamFirst(spec.change)
				? "TS2379"
				: "TS2345"

/**
 * Whether a case's fault is its first member's own, which an insertAll holds at a key: the member's check, refused at
 * its key, rather than its stratum's or its application's.
 */
const keyedFault = (spec: CaseSpec): boolean =>
	spec.change.kind === "built" &&
	spec.fault !== undefined &&
	Arr.contains(memberFaults, spec.fault) &&
	!Arr.contains(stratumFaults, spec.fault) &&
	Arr.some(
		callsOf(spec.change),
		(call) => call.kind === "insertAll" && Arr.some(call.entries, (e) => e.at === 0)
	)

/** The member faults the types refuse where the stratum or the application is checked, never at the member. */
const stratumFaults: ReadonlyArray<ChangeSetFault> = [
	"an append to an owner its stratum does not insert",
	"a family's members edited in two strata"
]

/** Whether a case's first member, which carries a member's planted fault, is a Stream. */
const streamFirst = (c: ChangeSpec): boolean =>
	c.kind === "built" ? c.members[0]?.kind === "stream" : streamFirst(c.a)

/**
 * The operations db.compile's handle of a compiled ChangeSet over `level` offers (changeOps), the shell's oracle of what
 * a compiled ChangeSet does when read as a query: a read refuses before it reads its parameters or reaches the compiled
 * value's apply.
 */
const compiledChange = (level: Level) =>
	changeOps({
		schema: levels[level],
		apply: () => Effect.die(new Error("a compiled ChangeSet read as a query never applies"))
	})

/**
 * The engine's verdict on a case: its own ChangeSet's, and, where its application is given a choice, refused where
 * either branch is, at the call that is given both.
 */
const verdictOf = (spec: CaseSpec): Verdict => {
	const own = verdictOfOne(spec)
	const choice = spec.apply?.choice
	if (own.kind === "refused" || choice === undefined) {
		return own
	}
	const other = verdictOfOne({ ...spec, change: { kind: "sequence", a: spec.change, b: choice } })
	return other.kind === "refused" ? { ...other, at: "apply" } : own
}

/** The engine's verdict on one ChangeSet: built, compiled over reality, bound, then compiled for the applying role. */
const verdictOfOne = (spec: CaseSpec): Verdict => {
	const code = codeOf(spec)
	const built = Result.try(() => buildChange(spec.change))
	if (Result.isFailure(built)) {
		return refusedAt("change", built.failure, spec, code)
	}
	const reality = realities[levelOf(spec.change)]
	const desc = changeSetDesc(built.success)
	if (desc === undefined) {
		throw new Error("a ChangeSet the facade built has no Description")
	}
	const program = compileWrite(reality.checked, desc, reality.options)
	if (!program.ok) {
		return refusedAt(
			spec.fault === "an append to an owner its stratum does not insert" ? "apply" : "change",
			program.error,
			spec,
			code
		)
	}
	const entries =
		spec.apply === undefined || spec.apply.args.kind === "value"
			? freeParams(spec.change)
			: spec.apply.args.entries
	if (
		spec.apply !== undefined &&
		(spec.apply.entry === "apply" || spec.apply.entry === "compiled apply") &&
		Result.isFailure(
			readParams(
				Arr.map(program.value.params, (p) => p.name),
				Rec.fromEntries(Arr.map(entries, ([n]) => [n, 0] as const)),
				"refused"
			)
		)
	) {
		return {
			kind: "refused",
			at: "apply",
			claim: { kind: "refusal", refusal: "a parameter map names only its program's parameters" },
			code
		}
	}
	const args = Rec.fromEntries(Arr.map(entries, ([n, l]) => [n, l.value] as const))
	const encoded = bound(program.value, built.success, args)
	if (!encoded.ok) {
		const failure = encoded.error
		if (failure instanceof CompileError) {
			return refusedAt("change", failure, spec, code)
		}
		if (failure._tag === "LiteralBound" || failure._tag === "MessageBound") {
			throw new Error(`the engine refuses a drawn ChangeSet's input as too large: ${failure._tag}`)
		}
		const place = failure.place
		return place._tag === "Slot" && Arr.some(freeParams(spec.change), ([n]) => n === place.name)
			? {
					kind: "refused",
					at: "apply",
					claim: { kind: "prose", why: `the engine: no value for ${place.name}` },
					code
				}
			: {
					kind: "refused",
					at: "change",
					claim: { kind: "refusal", refusal: "a member fact is not a fact of the relation" },
					code
				}
	}
	if (
		encoded.value.kind !== "invariant-rejected" &&
		Arr.contains(ownerPairingsOf(spec.change), "a put and a nested insert of one owner at one key")
	) {
		throw new Error(
			"the engine binds a put and a nested insert of one owner at one key, two rows at that key it refuses before any SQL"
		)
	}
	if (outsideItsDomain(reality.options.laws, spec.change)) {
		return {
			kind: "refused",
			at: "change",
			claim: { kind: "refusal", refusal: "a member fact is not a fact of the relation" },
			code
		}
	}
	if (encoded.value.kind === "invariant-rejected" && spec.fault === "two facts sharing a key") {
		return {
			kind: "refused",
			at: "change",
			claim: {
				kind: "refusal",
				refusal: "two facts of one relation share a key with different values; a key names one fact"
			},
			code
		}
	}
	if (spec.apply !== undefined) {
		const world = roleWorlds[spec.apply.role]
		const applied = compileWrite(world.checked, desc, world.options)
		if (!applied.ok) {
			return refusedAt("apply", applied.error, spec, code)
		}
		if (spec.apply.entry === "execute" || spec.apply.entry === "get") {
			const ops = compiledChange(levelOf(spec.change))
			const failure =
				spec.apply.entry === "execute"
					? Effect.runSync(Effect.flip(ops.execute({})))
					: Effect.runSync(Effect.flip(ops.get({})))
			return refusedAt(
				"apply",
				failure._tag === "ReadFailure" ? failure.reason : failure,
				spec,
				code
			)
		}
	}
	if (spec.fault === "a value missing its brand") {
		return {
			kind: "refused",
			at: "change",
			claim: { kind: "refusal", refusal: "the query's head is not a fact of the relation" },
			code
		}
	}
	const free = new Set(Arr.map(freeParams(spec.change), ([n]) => n))
	return {
		kind: "admitted",
		admitted: {
			params: Arr.flatMap(program.value.params, (p) =>
				p.kind === "scalar" && free.has(p.name) ? [[p.name, paramText(p.type)] as const] : []
			),
			writes: Arr.dedupe([
				...Arr.flatMap(desc.strata, (st) => Arr.map(st.members, (m) => m.relation)),
				...Arr.flatMap(program.value.frontend.nested, (n) =>
					Arr.map(n.nesting.reached, (r) => r.family.member.name)
				)
			]),
			rows: Arr.map(
				Arr.dedupe(
					Arr.flatMap(builtsOf(spec.change), (b) =>
						Arr.flatMap(b.members, (m) =>
							m.kind === "derived"
								? []
								: m.kind === "appended"
									? [m.owner, countedMembers[m.owner]]
									: [m.relation]
						)
					)
				),
				(name) => rowShapeOf(reality.options.laws, name)
			),
			arrays: Arr.flatMap(desc.strata, (st) =>
				Arr.flatMap(st.members, (m) =>
					m.member.kind === "array" ? [{ relation: m.relation, op: m.op }] : []
				)
			),
			reads: Arr.map(
				program.value.frontend.ir.reads,
				(rd) =>
					[
						rd.name,
						`ReadonlyArray<{ ${Arr.join(
							Arr.map(rd.node.heading, (c) => `readonly ${c.name}: ${hostText(c.type)}`),
							"; "
						)} }>`
					] as const
			)
		}
	}
}

/** One drawn case: its source lines, the engine's verdict, the names it uses and what it reached. */
interface ChangeSetCase {
	readonly spec: CaseSpec
	readonly change: string
	readonly args: string
	/** The source of the ChangeSet a choice sequences after the case's own, where its application is given one. */
	readonly choice: string | undefined
	readonly verdict: Verdict
	/** Its ChangeSet's served calls, admitted with array members of distinct relations (servedOf). */
	readonly served: ReadonlyArray<ServedCall>
	readonly uses: ReadonlySet<string>
	readonly notes: ReadonlySet<ChangeSetNote>
}

/** One served call: the facts it passes, the parameters, and the verdict on it. */
interface ServedCall {
	readonly variant: ServedVariant
	readonly facts: string
	readonly params: string
	readonly verdict: Verdict
}

/** A part whose facts are an array: an array or a widened array of facts, or a family member's facts. */
type ArraySpec =
	| {
			readonly kind: "array" | "widened"
			readonly op: Op
			readonly relation: RelName | "Kind"
			readonly facts: Arr.NonEmptyReadonlyArray<ReadonlyArray<readonly [string, Lit]>>
	  }
	| Extract<Part, { readonly kind: "family" }>

/** A part an array member writes, with the level of the ChangeSet it is a member of, and that member. */
interface ArrayPart {
	readonly level: Level
	readonly member: MemberSpec
	readonly part: ArraySpec
}

/** The parts of a ChangeSet's array members in its members' order: an appended member's two, every other one's own. */
const arrayPartsOf = (c: ChangeSpec): ReadonlyArray<ArrayPart> =>
	Arr.flatMap(builtsOf(c), (b) =>
		Arr.flatMap(b.members, (member) =>
			Arr.flatMap(
				member.kind === "appended" ? insertParts(member) : [member],
				(part): ReadonlyArray<ArrayPart> =>
					part.kind === "family"
						? [{ level: b.level, member, part }]
						: part.kind === "array" || part.kind === "widened"
							? [{ level: b.level, member, part: { ...part, kind: part.kind } }]
							: []
			)
		)
	)

/** The ChangeSet c with the member `from` replaced by `to`. */
const withMember = (c: ChangeSpec, from: MemberSpec, to: MemberSpec): ChangeSpec =>
	c.kind === "built"
		? { ...c, members: Arr.map(c.members, (m) => (m === from ? to : m)) }
		: { ...c, a: withMember(c.a, from, to), b: withMember(c.b, from, to) }

/**
 * A ChangeSet's array parts by relation, in its members' order: the engine holds one relation's array members of one op
 * in one stratum as one member, whose facts are all of theirs.
 */
const arrayGroupsOf = (
	c: ChangeSpec
): ReadonlyArray<readonly [string, Arr.NonEmptyReadonlyArray<ArrayPart>]> =>
	Rec.toEntries(Arr.groupBy(arrayPartsOf(c), (p) => partName(p.part)))

/**
 * The served calls of an admitted ChangeSet whose array members write distinct relations, as a served workload holds
 * one (two of one relation are refused at generate), one of each variant (servedVariants). The facts a call passes are
 * its parts' own, each relation's under its name, every array written as an array; the parameters, those the
 * ChangeSet leaves free.
 */
const servedOf = (
	spec: CaseSpec,
	admitted: Admitted,
	rendering: Rendering
): ReadonlyArray<ServedCall> => {
	const relations = Arr.map(admitted.arrays, (a) => a.relation)
	const groups = arrayGroupsOf(spec.change)
	if (!Arr.isReadonlyArrayNonEmpty(groups) || Arr.dedupe(relations).length !== relations.length) {
		return []
	}
	const drawn = Arr.map(groups, ([relation]) => relation)
	if (drawn.length !== relations.length || !Arr.every(drawn, (r) => relations.includes(r))) {
		throw new Error(
			`the engine's array members ${Arr.join(relations, ", ")} are not the drawn ChangeSet's ${Arr.join(drawn, ", ")}`
		)
	}
	const params = rendering.args({ kind: "record", entries: freeParams(spec.change) })
	const factsOf = (
		of: ReadonlyArray<readonly [string, Arr.NonEmptyReadonlyArray<ArrayPart>]>,
		beside: ReadonlyArray<string>
	): string =>
		`{ ${Arr.join(
			[
				...Arr.map(
					of,
					([relation, parts]) =>
						`${relation}: [${Arr.join(
							Arr.flatMap(parts, ({ part }) =>
								part.kind === "family"
									? Arr.map(part.facts, (f) => rendering.familyFact(f))
									: Arr.map(part.facts, (f) => rendering.fact(f))
							),
							", "
						)}]`
				),
				...beside
			],
			", "
		)} }`
	const asBuilt: ServedCall = {
		variant: "as built",
		facts: factsOf(groups, []),
		params,
		verdict: { kind: "admitted", admitted }
	}
	const leftOut: ServedCall = {
		variant: "a relation left out",
		facts: factsOf(Arr.tailNonEmpty(groups), []),
		params,
		verdict: {
			kind: "refused",
			at: "apply",
			claim: { kind: "prose", why: "the facts leave out an array member's relation" },
			code: servedShapeCode
		}
	}
	const extra = Arr.findFirst(relNames, (r) => !relations.includes(r))
	const extraCall: ReadonlyArray<ServedCall> = Option.isSome(extra)
		? [
				{
					variant: "an extra relation",
					facts: factsOf(groups, [`${extra.value}: []`]),
					params,
					verdict: {
						kind: "refused",
						at: "apply",
						claim: {
							kind: "refusal",
							refusal: "a served ChangeSet's facts name only the relations of its array members"
						},
						code: servedFactCode
					}
				}
			]
		: []
	const target = Arr.findFirst(
		arrayPartsOf(spec.change),
		(p) => p.member.kind === "array" || p.member.kind === "widened"
	)
	const bogusCall: ReadonlyArray<ServedCall> = Option.match(target, {
		onNone: () => [],
		onSome: ({ member }) => {
			if (member.kind !== "array" && member.kind !== "widened") {
				return []
			}
			const [head, ...tail] = member.facts
			const bogus: MemberSpec = { ...member, facts: [[...head, ["bogus", plainNumber]], ...tail] }
			const change = withMember(spec.change, member, bogus)
			const engine = verdictOfOne({
				change,
				apply: undefined,
				fault: "a fact with a field its relation lacks"
			})
			return [
				{
					variant: "a fact with a field its relation lacks",
					facts: factsOf(arrayGroupsOf(change), []),
					params,
					verdict:
						engine.kind === "refused" ? { ...engine, at: "apply", code: servedFactCode } : engine
				}
			]
		}
	})
	return [asBuilt, leftOut, ...extraCall, ...bogusCall]
}

interface Drawn {
	readonly spec: CaseSpec
	readonly reached: ReadonlySet<ChangeSetFeature>
}

/** A case drawn aimed at the features `aim` names: none for a plain draw. */
const drawnGen =
	(aim: ReadonlySet<ChangeSetFeature>): Gen<Drawn> =>
	(source) => {
		const d = new Drawing(source, source.draw(swarm(changeSetFeatures)), aim)
		return { spec: caseOver(d), reached: d.reached }
	}

const caseOf = ({ spec, reached }: Drawn): ChangeSetCase => {
	const rendering = new Rendering()
	const change = rendering.change(spec.change)
	const args = spec.apply === undefined ? "" : rendering.args(spec.apply.args)
	if (spec.apply !== undefined) {
		rendering.uses.add(spec.apply.role)
	}
	const choice = spec.apply?.choice === undefined ? undefined : rendering.change(spec.apply.choice)
	if (choice !== undefined) {
		rendering.uses.add("flip")
	}
	const verdict = verdictOf(spec)
	const served = verdict.kind === "admitted" ? servedOf(spec, verdict.admitted, rendering) : []
	const notes = new Set<ChangeSetNote>(reached)
	for (const call of served) {
		notes.add(`served: ${call.variant}`)
		if (call.verdict.kind === "refused" && call.verdict.claim.kind === "refusal") {
			notes.add(refusalNotes[call.verdict.claim.refusal])
		}
	}
	if (verdict.kind === "admitted") {
		notes.add("admitted")
	} else {
		notes.add("refused")
		notes.add(
			verdict.claim.kind === "refusal"
				? refusalNotes[verdict.claim.refusal]
				: "refused: structurally"
		)
	}
	for (const b of builtsOf(spec.change)) {
		for (const m of b.members) {
			notes.add(m.kind === "appended" ? "insert" : m.op)
		}
	}
	for (const pairing of ownerPairingsOf(spec.change)) {
		notes.add(pairing)
	}
	return { spec, change, args, choice, verdict, served, uses: rendering.uses, notes }
}

/**
 * The faults an insert's member carries, each refused at its insertAll key, by its stratum (an append its owner's
 * insert does not stand beside) or by its application (a role that does not write a key's relation).
 */
const insertAllFaults = [
	"a closed relation written",
	"a derived relation written",
	"a fact with a field its relation lacks",
	"a fact missing a field",
	"a fact value outside its field",
	"an addition with some of its serials",
	"two facts sharing a key",
	"a value missing its brand",
	"a head with a field its relation lacks",
	"a head literal outside its field",
	"a nested root field",
	"a nested field its relation lacks",
	"a counted member nested",
	"a generated field supplied",
	"a sequence member written alone",
	"an append to an owner its stratum does not insert",
	"a role that does not write the relation"
] as const satisfies ReadonlyArray<ChangeSetFault>

/**
 * The situations the floor's witnesses reach: every construct and fault, each construct admitted and each fault
 * refused; a value outside its field in each of its shapes; a key two facts share and a derived relation written, under
 * each op; a derived relation's delta, added and removed; a write outside the role's write list by one branch of a
 * choice of two ChangeSets, applied and compiled; and each fault an insert's member carries, at an insertAll key.
 */
export const changeSetRequired: ReadonlyArray<Reached<ChangeSetNote>> = [
	...changeSetFeatures,
	...Arr.map(
		Arr.filter(
			changeSetFeatures,
			(f) => !Arr.contains(changeSetFaults, f) && !Arr.contains(outsideShapes, f)
		),
		(f) => [f, "admitted"] as const
	),
	...Arr.map(changeSetFaults, (f) => [f, "refused"] as const),
	...Arr.map(outsideShapes, (shape) => ["a fact value outside its field", shape] as const),
	...Arr.map(
		["a choice of two ChangeSets applied", "a choice of two ChangeSets compiled"] as const,
		(choice) => ["a role that does not write the relation", choice] as const
	),
	...Arr.flatMap(["two facts sharing a key", "a derived relation written"] as const, (f) =>
		Arr.map(["insert", "delete", "put"] as const, (op) => [f, op] as const)
	),
	...Arr.map(
		["read-back of added facts", "read-back of removed facts"] as const,
		(source) => ["a derived relation's delta read", source] as const
	),
	...Arr.map(insertAllFaults, (f) => [f, "insertAll"] as const)
]

/** The cases the run's own stream draws. */
export const changeSetCount = 160

const changeSetLabel = "types/changeset agreement"

const caseGen =
	(aim: ReadonlySet<ChangeSetFeature>): Gen<ChangeSetCase> =>
	(source) =>
		caseOf(drawnGen(aim)(source))

/** What a case reached: its notes, each construct with its verdict, and its fault with each of its constructs. */
const reachedBy = (c: ChangeSetCase): ReadonlyArray<Reached<ChangeSetNote>> => {
	const fault = c.spec.fault
	return [
		...c.notes,
		...Arr.flatMap([...c.notes], (n): ReadonlyArray<Reached<ChangeSetNote>> =>
			Arr.contains(changeSetFeatures, n)
				? [
						[n, c.verdict.kind],
						...(fault === undefined || n === fault ? [] : [[fault, n] as const])
					]
				: []
		)
	]
}

/**
 * The features a witness of a requirement is aimed at: the features it names, and what each needs of its case to be
 * drawn at all (a narrowed value a described member, a family's construct a family member, a write list an
 * application). A verdict is no feature: a case aimed at a construct plants no fault, so it is admitted where the
 * engine admits it.
 */
const aimOf = (situation: Reached<ChangeSetNote>): ReadonlySet<ChangeSetFeature> => {
	const named: ReadonlyArray<ChangeSetNote> =
		typeof situation === "string" ? [situation] : situation
	return new Set(
		Arr.flatMap(changeSetFeatures, (f): ReadonlyArray<ChangeSetFeature> =>
			named.includes(f) ? [f, ...(prerequisites[f] ?? [])] : []
		)
	)
}

/** What a construct needs of its case to be drawn at all; a construct this names not needs nothing more. */
const prerequisites: { readonly [F in ChangeSetFeature]?: ReadonlyArray<ChangeSetFeature> } = {
	"a narrowed exact value": ["described member"],
	"a head parameter": ["described member"],
	"a head literal": ["described member"],
	"nested members": ["family member", "insert"],
	"a nested tree": ["family member"],
	"a counted member": ["family member"],
	"a mutable family": ["family member"],
	"an immutable family": ["family member"],
	"an append beside its owner": ["family member", "a counted member", "insert"],
	"a partial write list": ["applied"],
	"a choice of two ChangeSets applied": ["applied", "a partial write list"],
	"a choice of two ChangeSets compiled": ["applied", "a partial write list"],
	"a generated addition": ["insert"],
	insertAll: ["insert"],
	bind: ["described member", "a parameter"]
}

/**
 * The floor's witnesses, the same in every run, the only cases that meet the required situations: for each required
 * situation, a population on its own floor stream aimed at it, with the tally it reached.
 */
export const changeSetWitnesses = () =>
	Arr.map(Arr.dedupeWith(Arr.map(changeSetRequired, aimOf), sameAim), (aim) =>
		floorPopulation(
			`${changeSetLabel} aimed at ${Arr.join([...aim], ", ")}`,
			caseGen(aim),
			aimedCount,
			reachedBy
		)
	)

/** Two aims are one when they name the same features. */
const sameAim = (a: ReadonlySet<ChangeSetFeature>, b: ReadonlySet<ChangeSetFeature>): boolean =>
	a.size === b.size && Arr.every([...a], (f) => b.has(f))

/** The witnesses drawn aimed at one requirement. */
const aimedCount = 2

/**
 * A case a run's own stream drew failing, kept by its tape, the decisions caseGen made for it: every run draws it beside
 * the floor's witnesses and its own cases, the very case while caseGen draws it alike and whatever the tape gives where
 * caseGen changes, which the floor's check then refuses by what the case no longer reaches (`reaches`).
 */
interface KeptCase {
	readonly note: string
	readonly tape: string
	readonly reaches: Arr.NonEmptyReadonlyArray<ChangeSetNote>
}

const keptCases: ReadonlyArray<KeptCase> = [
	{
		note: "a put whose query reads a parameter, applied with none, beside a tree's node inserted at one key twice with different rows: bind judged the key before it read the parameters, so the engine answered invariant-rejected where the types refuse the call (TEST_SEED=3)",
		tape: "10.1.6.1.9.g.f.a.6.1.7.8.4.g.e.1.7.4.b.h.7.8.h.9.e.c.d.a.7.7.a.0.d.e.9.g.2.0.2.a.3.g.9.3.g.8.2.a.c.4.5.2.1.c.9.e.0.7.c.c.d.0.4.7.d.6.4.g.4.c.d.h.h.d.f.7.f.h.2.a.1.8.7.h.1.13.2.2.2.4.1.1.1.1.1.4.0.0.3.1.2.2.0",
		reaches: ["a parameter left unbound", "a nested tree", "insertAll", "insert"]
	},
	{
		note: "a Ledger fact whose money field holds a bare bigint, beside two Budget facts at one key with different cents: normalization judged Budget's key before it admitted Ledger's facts, so the engine answered invariant-rejected where the types refuse the fact (TEST_SEED=34)",
		tape: "8.1.3.0.e.3.a.c.5.h.2.a.b.2.9.a.8.a.4.c.2.e.1.f.2.3.1.h.5.a.1.4.6.d.g.6.2.g.6.c.d.f.b.3.e.c.c.f.6.6.5.8.5.8.b.3.1.e.9.4.3.g.8.6.7.b.1.f.2.3.3.7.8.6.c.f.2.d.a.2.2.e.0.g.1.d.2.3.0.4.1.0.3.4.1.1.1.0.0.0.1.1.1.0.3.0.4.1.1",
		reaches: ["a fact value outside its field", "insertAll", "insert"]
	},
	{
		note: "a union that puts a counted family's mutable owner, deletes one of its members and deletes the owner: the one flight's order gave the member's removals the addition of its rows, so the owner's put preceded them through the owner axis while the owner's delete followed them, and the engine answered UnorderableStratum where the types admit the ChangeSet (TEST_SEED=4145498399)",
		tape: "t.2.c.4.2.0.h.4.b.h.c.3.2.1.h.0.f.b.a.4.a.6.4.e.7.9.0.1.2.3.9.1.4.4.4.9.g.9.0.0.d.b.g.e.1.b.3.3.a.4.1.a.a.8.e.c.6.9.8.3.4.0.1.b.5.1.c.8.3.g.2.g.5.g.h.b.1.1.9.c.f.8.3.g.0.2.2.2.3.2.0.1.0.1.2.2.0.1.5.0.0.0.2.2.1.2.1.1.3.1.0.0.1.3.1.1.0.0.1",
		reaches: ["union", "a counted member", "put", "delete", "admitted"]
	}
]

/** The kept cases, each drawn from its tape, beside what it was kept for. */
export const changeSetKept = (): ReadonlyArray<{
	readonly kept: KeptCase
	readonly drawn: ChangeSetCase
}> =>
	Arr.map(keptCases, (kept) => {
		const values = valuesFromToken(kept.tape)
		return { kept, drawn: generate(caseGen(new Set()), forcedChooser(values, values.length)).value }
	})

const changeSetCases = (seed: number): ReadonlyArray<ChangeSetCase> => [
	...Arr.flatMap(changeSetWitnesses(), (w) => w.values),
	...Arr.map(changeSetKept(), (k) => k.drawn),
	...sample(caseGen(new Set()), rotatingSeed(seed, floorSeed(changeSetLabel)), changeSetCount)
]

/** The ChangeSet program's prelude (test/support/programs/changesets.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/changesets.ts"))

export const changeSetEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

const directiveOf = (v: Verdict, at: "change" | "apply"): ReadonlyArray<string> =>
	v.kind === "refused" && v.at === at
		? [
				v.claim.kind === "refusal"
					? `\t// @ts-expect-error -- ${v.code} refusal: ${v.claim.refusal}`
					: `\t// @ts-expect-error -- ${v.code}: ${v.claim.why}`
			]
		: []

const unionOf = (names: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(names)
		? Arr.join(
				Arr.map(names, (n) => jsonText(n)),
				" | "
			)
		: "never"

/**
 * One case's block: its ChangeSet under its directive and, admitted, the assertions of its parameters, writes,
 * read-backs and level; then its application, under its directive, and, admitted, the assertions of its channels.
 */
const blockOf = (c: ChangeSetCase, i: number): string => {
	const v = c.verdict
	const change = [`export const c${i} =`, ...directiveOf(v, "change"), `\t${c.change}`]
	if (v.kind === "refused" && v.at === "change") {
		return Arr.join([...change, ""], "\n")
	}
	const reads =
		v.kind === "admitted"
			? `{ ${Arr.join(
					Arr.map(v.admitted.reads, ([n, t]) => `readonly ${n}: ${t}`),
					"; "
				)} }`
			: "never"
	const readsText =
		v.kind === "admitted" && Arr.isReadonlyArrayNonEmpty(v.admitted.reads)
			? reads
			: c.spec.change.kind === "built"
				? "unknown"
				: "{}"
	const assertions =
		v.kind === "admitted"
			? [
					`export type K${i} = [Expect<Equals<keyof ParamsOf<typeof c${i}>, ${unionOf(Arr.map(v.admitted.params, ([n]) => n))}>>${Arr.join(
						Arr.map(
							v.admitted.params,
							([n, t]) => `, Expect<Equals<ParamsOf<typeof c${i}>[${jsonText(n)}], ${t}>>`
						),
						""
					)}]`,
					`export type W${i} = Expect<Equals<WritesOf<typeof c${i}>, ${unionOf(v.admitted.writes)}>>`,
					`export type R${i} = Expect<Equals<ReadsOf<typeof c${i}>, ${readsText}>>`,
					`export type S${i} = Expect<Equals<SchemaOf<typeof c${i}>, typeof ${levelOf(c.spec.change)}>>`,
					...(Arr.isReadonlyArrayNonEmpty(v.admitted.rows)
						? [
								`export type V${i} = [${Arr.join(
									Arr.map(
										v.admitted.rows,
										(row) =>
											`Expect<Equals<keyof Written<typeof ${row.relation}>, ${unionOf(row.written)}>>, Expect<Equals<keyof AdditionIn<typeof ${levelOf(c.spec.change)}, typeof ${row.relation}>, ${unionOf(row.addition)}>>`
									),
									", "
								)}]`
							]
						: [])
				]
			: []
	const servedHandle = `WorkloadHandles<typeof Writer, { readonly m: typeof c${i} }>["m"]`
	const served =
		v.kind === "admitted"
			? [
					`export type F${i} = [Expect<Equals<keyof ArraysOf<typeof c${i}>, ${unionOf(Arr.dedupe(Arr.map(v.admitted.arrays, (a) => a.relation)))}>>, Expect<Equals<Parameters<${servedHandle}["apply"]>["length"], ${Arr.isReadonlyArrayNonEmpty(v.admitted.arrays) ? 2 : 1}>>${Arr.join(
						Arr.flatMap(
							c.served.length === 0 ? [] : arrayGroupsOf(c.spec.change),
							([relation, parts]) => {
								const { level, part } = Arr.headNonEmpty(parts)
								return Arr.every(parts, (p) => p.level === level && p.part.op === part.op)
									? [
											`, Expect<Equals<ArraysOf<typeof c${i}>[${jsonText(relation)}]["row"], ${part.op === "insert" ? `AdditionIn<typeof ${level}, typeof ${relation}>` : `Written<typeof ${relation}>`}>>`
										]
									: []
							}
						),
						""
					)}]`,
					...Arr.flatMap(c.served, (call, k) => [
						`export const s${i}_${k} = (h: ${servedHandle}) =>`,
						...directiveOf(call.verdict, "apply"),
						`\th.apply(${call.facts}, ${call.params})`
					])
				]
			: []
	const apply = c.spec.apply
	if (apply === undefined) {
		return Arr.join([...change, ...assertions, ...served, ""], "\n")
	}
	const passed = apply.args.kind === "variable" ? `w${i}` : c.args
	const given =
		c.choice === undefined ? `c${i}` : `flip ? c${i} : ChangeSet.sequence(c${i}, ${c.choice})`
	const call =
		apply.entry === "apply"
			? `db.apply(${given}, ${passed})`
			: apply.entry === "compile"
				? `db.compile(${given})`
				: apply.entry === "compiled apply"
					? `h.apply(${passed})`
					: `h.${apply.entry}(${passed})`
	const handle =
		apply.entry === "apply" || apply.entry === "compile"
			? `db: DbOf<typeof ${apply.role}, unknown>`
			: `h: Compiled<typeof ${apply.role}, typeof c${i}, unknown>`
	const channels =
		v.kind === "admitted"
			? apply.entry === "apply"
				? [
						`export type E${i} = [Expect<Equals<Effect.Error<ReturnType<typeof a${i}>>, ApplyError>>, Expect<Equals<Effect.Success<ReturnType<typeof a${i}>>, ApplyOutcome<${readsText}>>>, Expect<Equals<Effect.Services<ReturnType<typeof a${i}>>, never>>]`
					]
				: apply.entry === "compile"
					? [
							`export type E${i} = [Expect<Equals<Effect.Error<ReturnType<typeof a${i}>>, CompileError>>, Expect<Equals<Effect.Services<ReturnType<typeof a${i}>>, Scope.Scope>>]`
						]
					: []
			: []
	return Arr.join(
		[
			...change,
			...assertions,
			...served,
			...(apply.args.kind === "variable" ? [`export const w${i} = ${c.args} as const`] : []),
			`export const a${i} = (${handle}) =>`,
			...directiveOf(v, "apply"),
			`\t${call}`,
			...channels,
			""
		],
		"\n"
	)
}

/**
 * pantry's import, kept beside the drawn cases: one insertAll over the role's every top-level relation
 * (insertableNamesOf), its rows a record typed as insertAll takes them (InsertAllRowsOf), which its served call then
 * passes as its facts. The engine compiles that ChangeSet for Writer, which writes every one of those relations.
 */
const pantryShape = (): ReadonlyArray<string> => {
	const desc = changeSetDesc(
		changeSetOver
			.empty(Writer)
			.insertAll(Rec.fromEntries(Arr.map(insertableNamesOf(Work), (name) => [name, []] as const)))
	)
	if (desc === undefined) {
		throw new Error("a ChangeSet the facade built has no Description")
	}
	const world = roleWorlds.Writer
	const compiled = compileWrite(world.checked, desc, world.options)
	if (!compiled.ok) {
		throw new Error(
			`the engine refuses pantry's insertAll for Writer: ${messageOf(compiled.error)}`
		)
	}
	return [
		"declare const pantryRows: { readonly [Name in keyof InsertAllRowsOf<typeof Work>]: ReadonlyArray<InsertAllRowsOf<typeof Work>[Name][number]> }",
		"export const pantry = ChangeSet.empty(Writer).insertAll(pantryRows)",
		'export const pantryServed = (h: WorkloadHandles<typeof Writer, { readonly m: typeof pantry }>["m"]) =>',
		"\th.apply(pantryRows, {})"
	]
}

/** The program over the run's cases: one module, each case a block. */
export const changeSetModules = (
	entries: PreludeAt,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = changeSetCases(seed)
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const text = Arr.join(
		[
			"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			...(uses.has("flip") ? ["declare const flip: boolean"] : []),
			...(uses.has("plain") ? ["declare const plain: string"] : []),
			"export const widen = <R>(_relation: R, facts: ReadonlyArray<Written<R>>): ReadonlyArray<Written<R>> => facts",
			"type SchemaOf<C> = C extends Phantom<{ readonly schema: Invariant<infer S> }> ? S : never",
			'export type Hosts = [CalendarDate, Decimal, Money, Uuid, Infer<typeof Cents>, typeof pg, BitsOf<typeof Flag>, Rostered<"Kind">, RegexInfer<"", "u">]',
			"",
			...Arr.map(cases, blockOf),
			...pantryShape()
		],
		"\n"
	)
	return [
		{
			file: "index.ts",
			source: preludeProgram(
				"// Generated by test/support/agreement/changesets.ts: the ChangeSet type/engine agreement.",
				entries,
				text
			)
		}
	]
}
