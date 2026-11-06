import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Effect, Option, Record as Rec, Result, Stream, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { CompileError, type CompileReason } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contractOf } from "#compiler/ir/scalar.ts"
import { pg } from "#compiler/public/fields.ts"
import { Money } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import {
	changeSetDesc,
	changeSetOver,
	type MemberInput,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import {
	Budget,
	Cents,
	Kind,
	Ledger,
	Other,
	Pair,
	Reader,
	Reports,
	Task,
	Ticket,
	Twin,
	Work,
	Writer
} from "#test/support/agreement/changeset-schema.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import { checking } from "#test/support/policy.ts"

/**
 * The ChangeSet population: ChangeSets drawn over Work (./changeset-schema.ts), each read twice, as TypeScript source
 * for one program the type tier checks and through the engine's JavaScript view (the ChangeSet facade, compileWrite over
 * reality and over the applying role, and bindWrite over the facts), which builds, compiles and binds it as db.apply
 * does. The engine is the oracle:
 *
 * - a ChangeSet, and its application through a role's Db, typechecks exactly when the engine builds, compiles and
 *   binds it: a refused case stands under a directive, which the type-test batch disarms;
 * - the Refusal a refused case's directive names is the engine's reason (claimOf);
 * - an admitted ChangeSet's parameters, writes, read-backs and schema are the engine's, and its application's error,
 *   success and service channels are ApplyError, the ApplyOutcome of its read-backs, and none, each asserted exactly.
 *
 * A case is a valid ChangeSet by construction with at most one planted fault, so the one line the case is written on
 * raises at most the one diagnostic its directive names: a read-back name repeated by read, union or sequence, a
 * closed relation written, a described member's head that is no fact of its relation or writes an exact value into a
 * plain field, a member fact that is no fact of its relation, a fold over a delta reading no key, ChangeSets over
 * schemas that are no levels of one another, a role that does not write the relation, a parameter left unbound. The
 * floor's witnesses (changeSetWitnesses), the same in every run, reach every fault and every construct.
 */

type RelName = "Task" | "Budget" | "Ticket" | "Pair" | "Ledger"
const relNames: Arr.NonEmptyReadonlyArray<RelName> = ["Task", "Budget", "Ticket", "Pair", "Ledger"]
const relations = { Task, Budget, Ticket, Pair, Ledger } as const

/** A value a case writes: its source and the value the engine's reading builds. */
interface Lit {
	readonly text: string
	readonly value: unknown
}

const uuidLit = (n: number): Lit => {
	const text = `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`
	return { text: jsonText(text), value: text }
}

/** A field of a written relation: its name, whether it is a serial, its key, values of its type and one outside it. */
interface FieldInfo {
	readonly name: string
	readonly serial: boolean
	readonly key: boolean
	readonly values: Arr.NonEmptyReadonlyArray<Lit>
	readonly bad: Lit
}

const uuids: Arr.NonEmptyReadonlyArray<Lit> = [uuidLit(1), uuidLit(2)]
const cents: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "Cents(5n)", value: Cents(5n) },
	{ text: "Cents(0n)", value: Cents(0n) }
]
const plainNumber: Lit = { text: "1", value: 1 }
const bigints: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "1n", value: 1n },
	{ text: "2n", value: 2n }
]

const fieldsOf: { readonly [R in RelName]: Arr.NonEmptyReadonlyArray<FieldInfo> } = {
	Task: [
		{ name: "id", serial: false, key: true, values: uuids, bad: plainNumber },
		{ name: "account", serial: false, key: false, values: uuids, bad: plainNumber },
		{
			name: "kind",
			serial: false,
			key: false,
			values: [
				{ text: '"Automatic"', value: "Automatic" },
				{ text: '"Manual"', value: "Manual" }
			],
			bad: { text: '"Paused"', value: "Paused" }
		}
	],
	Budget: [
		{ name: "task", serial: false, key: true, values: uuids, bad: plainNumber },
		{ name: "cents", serial: false, key: false, values: cents, bad: { text: "5n", value: 5n } }
	],
	Ticket: [
		{ name: "id", serial: true, key: true, values: bigints, bad: plainNumber },
		{ name: "account", serial: false, key: false, values: uuids, bad: plainNumber },
		{ name: "amount", serial: false, key: false, values: cents, bad: { text: "5n", value: 5n } }
	],
	Pair: [
		{ name: "a", serial: true, key: true, values: bigints, bad: plainNumber },
		{
			name: "b",
			serial: true,
			key: false,
			values: [{ text: "1", value: 1 }],
			bad: { text: "1n", value: 1n }
		},
		{ name: "note", serial: false, key: false, values: uuids, bad: plainNumber }
	],
	Ledger: [
		{ name: "id", serial: false, key: true, values: bigints, bad: plainNumber },
		{
			name: "balance",
			serial: false,
			key: false,
			values: [{ text: "5n", value: 5n }],
			bad: plainNumber
		},
		{
			name: "fee",
			serial: false,
			key: false,
			values: [{ text: "Money.of(5n)", value: Money.of(5n) }],
			bad: { text: "5n", value: 5n }
		}
	]
}

/** The faults a case may plant, one at most, each a swarm feature; and the constructs it may use. */
const changeSetFaults = [
	"a read-back name repeated by read",
	"a read-back name repeated by union",
	"a read-back name repeated by sequence",
	"a closed relation written",
	"a head with a field its relation lacks",
	"a head without a field",
	"a head literal outside its field",
	"an exact value into a plain field",
	"a fact with a field its relation lacks",
	"a fact without a field",
	"an addition with some of its serials",
	"a fact literal outside its field",
	"two facts sharing a key",
	"a fold over a delta reading no key",
	"ChangeSets over unrelated schemas",
	"a role that does not write the relation",
	"a parameter left unbound"
] as const
type ChangeSetFault = (typeof changeSetFaults)[number]

const changeSetFeatures = [
	...changeSetFaults,
	"insert",
	"delete",
	"put",
	"array member",
	"stream member",
	"described member",
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
	"applied"
] as const
type ChangeSetFeature = (typeof changeSetFeatures)[number]

/** The Refusals the ChangeSet facade, its compilation and its binding name, by the engine's reason (claimOf). */
const refusalNotes = {
	"read-back names are distinct: this ChangeSet already has a read-back of this name":
		"refused: a read name",
	"read-back names are distinct: the ChangeSets share a read-back name":
		"refused: a shared read name",
	"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes":
		"refused: a closed relation",
	"the query's head is not a fact of the relation": "refused: a head",
	"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast":
		"refused: an exact value",
	"a member fact is not a fact of the relation": "refused: a member fact",
	"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values":
		"refused: a fold",
	"the ChangeSets' schemas are not levels of one another": "refused: unrelated schemas",
	"a ChangeSet writes only relations its role's write list names": "refused: a write list",
	"two facts of one relation share a key with different values; a key names one fact":
		"refused: a shared key"
} as const
type ChangeSetRefusal = keyof typeof refusalNotes
type RefusalNote = (typeof refusalNotes)[ChangeSetRefusal]
export const changeSetRefusals: Arr.NonEmptyReadonlyArray<RefusalNote> = [
	"refused: a read name",
	"refused: a shared read name",
	"refused: a closed relation",
	"refused: a head",
	"refused: an exact value",
	"refused: a member fact",
	"refused: a fold",
	"refused: unrelated schemas",
	"refused: a write list",
	"refused: a shared key"
]

/** What a case reached: its constructs and fault, the engine's verdict, and the Refusal its directive names. */
export type ChangeSetNote =
	| ChangeSetFeature
	| "admitted"
	| "refused"
	| "refused: structurally"
	| RefusalNote

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
			readonly kind: "array" | "stream"
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

interface ReadSpec {
	readonly name: string
	readonly source: "added" | "removed" | "state"
	readonly relation: RelName
	/** The fields its match binds and its head delivers, or a count over the facts it matches. */
	readonly fold: "none" | "keyed" | "unkeyed"
	readonly fields: Arr.NonEmptyReadonlyArray<string>
}

interface BuiltSpec {
	readonly kind: "built"
	readonly level: Level
	readonly members: ReadonlyArray<MemberSpec>
	readonly reads: ReadonlyArray<ReadSpec>
	/** The values ChangeSet.bind closes its parameters with, if it binds them. */
	readonly bind: ReadonlyArray<readonly [string, Lit]> | undefined
}

type ChangeSpec =
	| BuiltSpec
	| { readonly kind: "union" | "sequence"; readonly a: ChangeSpec; readonly b: ChangeSpec }

/** How a case's ChangeSet is applied: by a role's Db, through apply or compile, with its arguments. */
interface ApplySpec {
	readonly role: "Writer" | "Reader"
	readonly entry: "apply" | "compile"
	readonly args: ReadonlyArray<readonly [string, Lit]>
}

interface CaseSpec {
	readonly change: ChangeSpec
	readonly apply: ApplySpec | undefined
	readonly fault: ChangeSetFault | undefined
}

/** One case's drawing: its swarm, the source its decisions come from, the constructs it reached and its names. */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<ChangeSetFeature>
	#params = 0
	#reads = 0
	readonly reached = new Set<ChangeSetFeature>()

	constructor(source: Source, drawn: Swarm<ChangeSetFeature>) {
		this.#source = source
		this.#swarm = drawn
	}

	keep(feature: ChangeSetFeature): boolean {
		const kept = this.#source.draw(keep(this.#swarm, feature))
		if (kept) {
			this.reached.add(feature)
		}
		return kept
	}

	note(feature: ChangeSetFeature): void {
		this.reached.add(feature)
	}

	choose<O extends ChangeSetFeature>(options: Arr.NonEmptyReadonlyArray<O>): O {
		const chosen = this.#source.draw(swarmChoice(this.#swarm, options))
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
	if (fault === "a fact without a field") {
		const dropped = Arr.findFirst(written, (f) => !f.serial)
		return Option.isNone(dropped) ? base : Arr.filter(base, ([name]) => name !== dropped.value.name)
	}
	if (fault === "an addition with some of its serials") {
		return Arr.filter(base, ([name]) => name !== "b")
	}
	if (fault === "a fact literal outside its field") {
		const [first, ...rest] = base
		return first === undefined ? base : [[first[0], fieldInfo(relation, first[0]).bad], ...rest]
	}
	return base
}

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
		if (f.key || f.serial || f.name === "balance") {
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
		if (fault === "a head literal outside its field") {
			const target = Arr.findFirst(written, (f) => !f.key && !f.serial)
			return Option.isNone(target)
				? head
				: Arr.map(head, ([name, term]) =>
						name === target.value.name
							? ([name, { kind: "literal", lit: target.value.bad }] as const)
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
	"a fact without a field",
	"an addition with some of its serials",
	"a fact literal outside its field"
]
const headFaults: ReadonlyArray<ChangeSetFault> = [
	"a head with a field its relation lacks",
	"a head without a field",
	"a head literal outside its field",
	"an exact value into a plain field"
]

/** A member: its operation and relation, then its facts, enumerated or as a Stream, or its description. */
const memberOf = (d: Drawing, fault: ChangeSetFault | undefined): MemberSpec => {
	if (fault === "a closed relation written") {
		return {
			kind: "array",
			op: "insert",
			relation: "Kind",
			facts: [[["id", { text: '"Automatic"', value: "Automatic" }]]]
		}
	}
	const op =
		fault === "an addition with some of its serials"
			? "insert"
			: d.choose(["insert", "delete", "put"] as const)
	const relation: RelName =
		fault === "an addition with some of its serials"
			? "Pair"
			: fault === "two facts sharing a key"
				? "Task"
				: fault === "an exact value into a plain field"
					? "Ledger"
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
	const kind = d.keep("stream member") ? "stream" : "array"
	d.note(kind === "stream" ? "stream member" : "array member")
	const planted = fault !== undefined && Arr.contains(factFaults, fault) ? fault : undefined
	if (fault === "two facts sharing a key") {
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
	const extra = d.from([0, 1]) === 1 ? [factOf(d, op, relation, undefined, 1)] : []
	return { kind, op, relation, facts: [factOf(d, op, relation, planted, 0), ...extra] }
}

/** A read-back of a written relation's added or removed facts, or of a relation's state, or a count over them. */
const readOf = (
	d: Drawing,
	name: string,
	written: ReadonlyArray<RelName>,
	fault: ChangeSetFault | undefined
): ReadSpec => {
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
	"a closed relation written"
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

/**
 * A ChangeSet over `level` with up to two members and two read-backs, the first read-back named `readName` where one
 * is given, carrying `fault` where it is a member's or a read-back's.
 */
const builtOf = (
	d: Drawing,
	level: Level,
	fault: ChangeSetFault | undefined,
	readName: string | undefined
): BuiltSpec => {
	if (level === "Other" || level === "Twin") {
		return { kind: "built", level, members: [], reads: [], bind: undefined }
	}
	const memberFault = fault !== undefined && Arr.contains(memberFaults, fault) ? fault : undefined
	const unbound = fault === "a parameter left unbound"
	const count =
		memberFault !== undefined || unbound || fault === "a role that does not write the relation"
			? d.from([1, 2])
			: d.from([0, 1, 1, 2])
	const members = Arr.map(Arr.range(1, count), (i): MemberSpec => {
		if (i === 1 && unbound) {
			return describedWithParam(d)
		}
		return memberOf(d, i === 1 ? memberFault : undefined)
	})
	const written = Arr.flatMap(members, (m): ReadonlyArray<RelName> =>
		m.relation === "Kind" ? [] : [m.relation]
	)
	const repeated = fault === "a read-back name repeated by read"
	const folded = fault === "a fold over a delta reading no key"
	const readCount = repeated
		? 2
		: readName !== undefined || folded
			? d.from([1, 2])
			: d.from([0, 0, 1, 2])
	const names = Arr.map(Arr.range(1, readCount), (i) =>
		i === 1 && readName !== undefined ? readName : repeated && i === 2 ? "r0" : d.readName()
	)
	const reads = Arr.map(names, (name, i) =>
		readOf(d, name, written, i === 0 && folded ? fault : undefined)
	)
	const built: BuiltSpec = { kind: "built", level, members, reads, bind: undefined }
	const values = paramValuesOf(built)
	return Arr.isReadonlyArrayNonEmpty(values) && !unbound && d.keep("bind")
		? { ...built, bind: values }
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

/** A case's ChangeSet: one built over Work or its extension, or a union or sequence of two. */
const changeOf = (d: Drawing, fault: ChangeSetFault | undefined): ChangeSpec => {
	const applied =
		fault === "a role that does not write the relation" || fault === "a parameter left unbound"
	const level = (): Level => (!applied && d.keep("over an extension") ? "Reports" : "Work")
	if (
		fault === "a read-back name repeated by union" ||
		fault === "a read-back name repeated by sequence"
	) {
		const name = d.readName()
		return {
			kind: fault === "a read-back name repeated by union" ? "union" : "sequence",
			a: builtOf(d, level(), undefined, name),
			b: builtOf(d, level(), undefined, name)
		}
	}
	if (fault === "ChangeSets over unrelated schemas") {
		const kind = d.choose(["union", "sequence"] as const)
		const other = d.from(["Other", "Twin"] as const)
		return d.from([0, 1]) === 0
			? {
					kind,
					a: builtOf(d, "Work", undefined, undefined),
					b: builtOf(d, other, undefined, undefined)
				}
			: {
					kind,
					a: builtOf(d, other, undefined, undefined),
					b: builtOf(d, "Work", undefined, undefined)
				}
	}
	const combined = d.keep("union") ? "union" : d.keep("sequence") ? "sequence" : undefined
	if (
		combined === undefined ||
		(fault !== undefined && fault !== "a role that does not write the relation")
	) {
		return builtOf(d, level(), fault, undefined)
	}
	return {
		kind: combined,
		a: builtOf(d, level(), undefined, undefined),
		b: builtOf(d, level(), undefined, undefined)
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

/** One case: at most one fault, then its ChangeSet, then, where its level is Work, its application. */
const caseOver = (d: Drawing): CaseSpec => {
	const fault = d.from([0, 1]) === 1 ? d.choose(changeSetFaults) : undefined
	const change = changeOf(d, fault)
	const applies =
		fault === "a role that does not write the relation" ||
		fault === "a parameter left unbound" ||
		d.keep("applied")
	if (
		!applies ||
		levelOf(change) !== "Work" ||
		(fault !== undefined &&
			fault !== "a role that does not write the relation" &&
			fault !== "a parameter left unbound")
	) {
		return { change, apply: undefined, fault }
	}
	d.note("applied")
	const free = freeParams(change)
	const writes = Arr.some(builtsOf(change), (b) => Arr.isReadonlyArrayNonEmpty(b.members))
	const role = fault === "a role that does not write the relation" && writes ? "Reader" : "Writer"
	const entry =
		fault === "a parameter left unbound" ? "apply" : d.from(["apply", "apply", "compile"] as const)
	const args = fault === "a parameter left unbound" ? free.slice(1) : free
	return { change, apply: { role, entry, args }, fault }
}

/** The source of a case's ChangeSet and its application, with the names it uses. */
class Rendering {
	readonly uses = new Set<
		"Compute" | "Stream" | "Money" | "pg" | Level | RelName | "Kind" | "Cents"
	>()

	lit(l: Lit): string {
		if (Str.startsWith("Cents(")(l.text)) {
			this.uses.add("Cents")
		}
		if (Str.startsWith("Money.")(l.text)) {
			this.uses.add("Money")
		}
		return l.text
	}

	fact(f: ReadonlyArray<readonly [string, Lit]>): string {
		return `{ ${Arr.join(
			Arr.map(f, ([n, l]) => `${n}: ${this.lit(l)}`),
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

	member(m: MemberSpec): string {
		this.uses.add(m.relation)
		switch (m.kind) {
			case "array":
				return `.${m.op}(${m.relation}, [${Arr.join(
					Arr.map(m.facts, (f) => this.fact(f)),
					", "
				)}])`
			case "stream":
				this.uses.add("Stream")
				return `.${m.op}(${m.relation}, Stream.make(${Arr.join(
					Arr.map(m.facts, (f) => this.fact(f)),
					", "
				)}))`
			case "query": {
				const params = Arr.map(m.params, (p) => {
					if (p.field === undefined) {
						this.uses.add("pg")
					}
					return `const ${p.name} = r.param(${jsonText(p.name)}, ${p.field === undefined ? "pg.bigint" : `${m.relation}.fields.${p.field}`}); `
				})
				const record = (fields: ReadonlyArray<readonly [string, HeadTerm]>): string =>
					`{ ${Arr.join(
						Arr.map(fields, ([n, t]) => `${n}: ${this.term(t)}`),
						", "
					)} }`
				return `.${m.op}(${m.relation}, query(Work).rule((r) => { const s = v(${m.relation}, "s"); ${Arr.join(params, "")}return r.match(${m.relation}, ${record(m.match)}).find(${record(m.head)}) }))`
			}
		}
	}

	read(rd: ReadSpec): string {
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
		const bind =
			c.bind === undefined
				? ""
				: `.bind({ ${Arr.join(
						Arr.map(c.bind, ([n, l]) => `${n}: ${this.lit(l)}`),
						", "
					)} })`
		return `ChangeSet.empty(${c.level})${Arr.join(
			Arr.map(c.members, (m) => this.member(m)),
			""
		)}${Arr.join(
			Arr.map(c.reads, (rd) => this.read(rd)),
			""
		)}${bind}`
	}

	args(a: ReadonlyArray<readonly [string, Lit]>): string {
		return `{ ${Arr.join(
			Arr.map(a, ([n, l]) => `${n}: ${this.lit(l)}`),
			", "
		)} }`
	}
}

const levels = { Work, Reports, Other, Twin } as const
const closedRelations = { ...relations, Kind } as const

/** The engine's reading of a ChangeSet: the same construct, built by the facade and the query builder's view. */
const buildChange = (c: ChangeSpec): unknown => {
	if (c.kind !== "built") {
		return c.kind === "union"
			? changeSetOver.union(buildChange(c.a), buildChange(c.b))
			: changeSetOver.sequence(buildChange(c.a), buildChange(c.b))
	}
	const withMembers = Arr.reduce(c.members, changeSetOver.empty(levels[c.level]), (cs, m) => {
		const target = closedRelations[m.relation]
		const facts = (f: ReadonlyArray<readonly [string, Lit]>) =>
			Rec.fromEntries(Arr.map(f, ([n, l]) => [n, l.value] as const))
		switch (m.kind) {
			case "array":
				return written(cs, m.op, target, Arr.map(m.facts, facts))
			case "stream":
				return written(cs, m.op, target, Stream.fromIterable(Arr.map(m.facts, facts)))
			case "query":
				return written(cs, m.op, target, describedQuery(m))
		}
	})
	const withReads = Arr.reduce(c.reads, withMembers, (cs, rd) =>
		cs.read(rd.name, (delta: DeltaValue) => readQuery(rd, delta))
	)
	return c.bind === undefined
		? withReads
		: withReads.bind(Rec.fromEntries(Arr.map(c.bind, ([n, l]) => [n, l.value] as const)))
}

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
	Ledger: Ledger.fields
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
			: Str.includes("closed relation")(reason.what)
				? {
						kind: "refusal",
						refusal:
							"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes"
					}
				: Str.includes("levels of one schema")(reason.what)
					? { kind: "refusal", refusal: "the ChangeSets' schemas are not levels of one another" }
					: Str.startsWith("a literal of")(reason.what)
						? { kind: "refusal", refusal: "the query's head is not a fact of the relation" }
						: { kind: "prose", why: `the engine: ${oneLine(reason.what)}` }
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
}

/** Where a refusal lands: the ChangeSet's one line, or its application's. */
type Verdict =
	| { readonly kind: "admitted"; readonly admitted: Admitted }
	| {
			readonly kind: "refused"
			readonly at: "change" | "apply"
			readonly claim: Claim
			readonly code: string
	  }

/** The host type a value of the engine's type has, as the program spells it. */
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
			return "string"
		case "code":
			return Arr.join(
				Arr.map(t.roster.handles, (h) => jsonText(h)),
				" | "
			)
		case "bits":
		case "range4":
		case "range8":
		case "vector":
			return `unknown /* ${t.carrier} */`
	}
}

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

/** The world a role's Db compiles a ChangeSet in: its checked world and its compile options. */
const roleWorldOf = (name: "Writer" | "Reader") => {
	const artifacts = testArtifacts(name === "Writer" ? Writer : Reader, testCompile)
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
	const members = Effect.runSync(collectInputs(program.frontend, parsed.inputs))
	const params = { ...args, ...Rec.fromEntries([...parsed.values]) }
	return bindWrite(program, { members, params, transport: inForce(bindFrame) })
}

const codeOf = (spec: CaseSpec): string =>
	spec.fault === "a fold over a delta reading no key" ? "TS2322" : "TS2345"

/** The engine's verdict on a case: built, compiled over reality, bound, then compiled for the applying role. */
const verdictOf = (spec: CaseSpec): Verdict => {
	const code = codeOf(spec)
	const built = Result.try(() => buildChange(spec.change))
	if (Result.isFailure(built)) {
		return refusedAt("change", built.failure, spec, code)
	}
	const reality = realityOf(levelOf(spec.change))
	const desc = changeSetDesc(built.success)
	if (desc === undefined) {
		throw new Error("a ChangeSet the facade built has no Description")
	}
	const program = compileWrite(reality.checked, desc, reality.options)
	if (!program.ok) {
		return refusedAt("change", program.error, spec, code)
	}
	const args = Rec.fromEntries(
		Arr.map(spec.apply?.args ?? freeParams(spec.change), ([n, l]) => [n, l.value] as const)
	)
	const encoded = bound(program.value, built.success, args)
	if (!encoded.ok) {
		const failure = encoded.error
		if (failure instanceof CompileError) {
			return refusedAt("change", failure, spec, code)
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
		const world = roleWorldOf(spec.apply.role)
		const applied = compileWrite(world.checked, desc, world.options)
		if (!applied.ok) {
			return refusedAt("apply", applied.error, spec, code)
		}
	}
	const free = new Set(Arr.map(freeParams(spec.change), ([n]) => n))
	return {
		kind: "admitted",
		admitted: {
			params: Arr.flatMap(program.value.params, (p) =>
				p.kind === "scalar" && free.has(p.name)
					? [
							[
								p.name,
								`ParamType<${hostText(p.type)}, ${jsonText(carrierSql[p.type.carrier])}>`
							] as const
						]
					: []
			),
			writes: Arr.dedupe(Arr.flatMap(desc.strata, (s) => Arr.map(s.members, (m) => m.relation))),
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
	readonly verdict: Verdict
	readonly uses: ReadonlySet<string>
	readonly notes: ReadonlySet<ChangeSetNote>
}

interface Drawn {
	readonly spec: CaseSpec
	readonly reached: ReadonlySet<ChangeSetFeature>
}

const drawnGen: Gen<Drawn> = (source) => {
	const d = new Drawing(source, source.draw(swarm(changeSetFeatures)))
	return { spec: caseOver(d), reached: d.reached }
}

const caseOf = ({ spec, reached }: Drawn): ChangeSetCase => {
	const rendering = new Rendering()
	const change = rendering.change(spec.change)
	const args = spec.apply === undefined ? "" : rendering.args(spec.apply.args)
	const verdict = verdictOf(spec)
	const notes = new Set<ChangeSetNote>(reached)
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
			notes.add(m.op)
		}
	}
	return { spec, change, args, verdict, uses: rendering.uses, notes }
}

/**
 * The situations the floor's witnesses reach: every construct and fault, each construct admitted, and each fault
 * refused, but a key two facts share, whose Refusal the types state only where the facts' literal types differ.
 */
export const changeSetRequired: ReadonlyArray<Reached<ChangeSetNote>> = [
	...changeSetFeatures,
	...Arr.map(
		Arr.filter(changeSetFeatures, (f) => !Arr.contains(changeSetFaults, f)),
		(f) => [f, "admitted"] as const
	),
	...Arr.map(changeSetFaults, (f) => [f, "refused"] as const)
]

/** The cases the run's own stream draws. */
export const changeSetCount = 160

const changeSetLabel = "types/changeset agreement"

const caseGen: Gen<ChangeSetCase> = (source) => caseOf(drawnGen(source))

/** What a case reached: its notes, and each construct with its verdict. */
const reachedBy = (c: ChangeSetCase): ReadonlyArray<Reached<ChangeSetNote>> => [
	...c.notes,
	...Arr.flatMap([...c.notes], (n): ReadonlyArray<Reached<ChangeSetNote>> =>
		Arr.contains(changeSetFeatures, n)
			? [[n, c.verdict.kind === "admitted" ? "admitted" : "refused"]]
			: []
	)
]

/** The floor's witnesses, the same in every run, the only cases that meet the required situations. */
export const changeSetWitnesses = () =>
	floorPopulation(changeSetLabel, caseGen, changeSetCount, reachedBy)

const changeSetCases = (seed: number): ReadonlyArray<ChangeSetCase> => [
	...changeSetWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(changeSetLabel)), changeSetCount)
]

/** The modules the program imports, each spelled as an import specifier relative to the program's directory. */
interface ChangeSetEntries {
	readonly changeset: string
	readonly compute: string
	readonly fields: string
	readonly query: string
	readonly types: string
	readonly phantom: string
	readonly typesPhantom: string
	readonly field: string
	readonly db: string
	readonly outcome: string
	readonly agreement: string
}

export const changeSetEntriesFrom = (entry: (path: string) => string): ChangeSetEntries => ({
	changeset: entry("packages/engine/src/public/changeset.ts"),
	compute: entry("packages/engine/src/public/compute.ts"),
	fields: entry("packages/engine/src/public/fields.ts"),
	query: entry("packages/engine/src/public/query.ts"),
	types: entry("packages/engine/src/types/changeset/changeset.ts"),
	phantom: entry("packages/engine/src/core/phantom.ts"),
	typesPhantom: entry("packages/engine/src/types/core/phantom.ts"),
	field: entry("packages/engine/src/types/fields/field.ts"),
	db: entry("packages/grizzle/src/adapter/types/db.ts"),
	outcome: entry("packages/grizzle/src/index.ts"),
	agreement: entry("test/support/agreement/changeset-schema.ts")
})

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
					`export type R${i} = Expect<Equals<ReadsOf<typeof c${i}>, ${Arr.isReadonlyArrayNonEmpty(v.admitted.reads) ? reads : "{}"}>>`,
					`export type S${i} = Expect<Equals<SchemaOf<typeof c${i}>, typeof ${levelOf(c.spec.change)}>>`
				]
			: []
	const apply = c.spec.apply
	if (apply === undefined) {
		return Arr.join([...change, ...assertions, ""], "\n")
	}
	const call = apply.entry === "apply" ? `db.apply(c${i}, ${c.args})` : `db.compile(c${i})`
	const channels =
		v.kind === "admitted"
			? apply.entry === "apply"
				? [
						`export type E${i} = [Expect<Equals<Effect.Error<ReturnType<typeof a${i}>>, ApplyError>>, Expect<Equals<Effect.Success<ReturnType<typeof a${i}>>, ApplyOutcome<${Arr.isReadonlyArrayNonEmpty(v.admitted.reads) ? reads : "{}"}>>>, Expect<Equals<Effect.Services<ReturnType<typeof a${i}>>, never>>]`
					]
				: [
						`export type E${i} = [Expect<Equals<Effect.Error<ReturnType<typeof a${i}>>, CompileError>>, Expect<Equals<Effect.Services<ReturnType<typeof a${i}>>, Scope.Scope>>]`
					]
			: []
	return Arr.join(
		[
			...change,
			...assertions,
			`export const a${i} = (db: DbOf<typeof ${apply.role}, unknown>) =>`,
			...directiveOf(v, "apply"),
			`\t${call}`,
			...channels,
			""
		],
		"\n"
	)
}

/** The program over the run's cases: one module, each case a block. */
export const changeSetModules = (
	entries: ChangeSetEntries,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = changeSetCases(seed)
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const schemaNames = Arr.filter(
		[
			"Work",
			"Reports",
			"Other",
			"Twin",
			"Kind",
			"Task",
			"Budget",
			"Ticket",
			"Pair",
			"Ledger",
			"Cents",
			"Writer",
			"Reader"
		],
		(n) => uses.has(n) || n === "Work" || n === "Writer" || n === "Reader" || n === "Cents"
	)
	return [
		{
			file: "index.ts",
			source: Arr.join(
				[
					"// Generated by test/support/agreement/changesets.ts: the ChangeSet type/engine agreement.",
					'import type { Effect, Scope } from "effect"',
					...(uses.has("Stream") ? ['import { Stream } from "effect"'] : []),
					`import { ChangeSet } from ${jsonText(entries.changeset)}`,
					...(uses.has("Compute") ? [`import { Compute } from ${jsonText(entries.compute)}`] : []),
					`import { type CalendarDate, type Decimal, Money, pg, type Uuid } from ${jsonText(entries.fields)}`,
					`import { type ParamsOf, type ParamType, query, v } from ${jsonText(entries.query)}`,
					`import type { ReadsOf, WritesOf } from ${jsonText(entries.types)}`,
					`import type { Phantom } from ${jsonText(entries.phantom)}`,
					`import type { Invariant } from ${jsonText(entries.typesPhantom)}`,
					`import type { Infer } from ${jsonText(entries.field)}`,
					`import type { DbOf } from ${jsonText(entries.db)}`,
					`import type { ApplyError, ApplyOutcome, CompileError } from ${jsonText(entries.outcome)}`,
					`import { ${Arr.join(schemaNames, ", ")} } from ${jsonText(entries.agreement)}`,
					"",
					"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"type Expect<T extends true> = T",
					"type SchemaOf<C> = C extends Phantom<{ readonly schema: Invariant<infer S> }> ? S : never",
					"export type Hosts = [CalendarDate, Decimal, Money, Uuid, Infer<typeof Cents>, typeof pg]",
					"",
					...Arr.map(cases, blockOf)
				],
				"\n"
			)
		}
	]
}
