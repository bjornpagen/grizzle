import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type CanonicalObject,
	type CanonicalToken,
	canonicalOf,
	canonicalTokens,
	canonicalTokensId,
	compareCanonicalTokens,
	everyProperty,
	type Outside
} from "#compiler/core/canonical.ts"
import {
	attachment,
	decoderOf,
	Named,
	type RecordField,
	type RowDecoder
} from "#compiler/core/decoder.ts"
import type { IdentityDigest } from "#compiler/core/fingerprint.ts"
import { hostRead } from "#compiler/core/host.ts"
import { captureLoc, formatLoc, labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Order from "#compiler/core/order.ts"
import { type Built, builtMark, isBuilt } from "#compiler/core/phantom.ts"
import { hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import { type TextsId, TextsMap, textsId } from "#compiler/core/text.ts"
import {
	type BoundRowsDesc,
	type ChangeSetDesc,
	decodeDesc,
	descIdentity,
	type EqualedDesc,
	equalParamNames,
	type MemberDesc,
	type QueryDesc,
	queryParamNames,
	type ReadBackDesc,
	boundRowsLoc,
	boundRowsQuery,
	type RowsDesc,
	passedThrough,
	renameEqualParams,
	renameQueryParams,
	renameRowsParams,
	rowsParamNames,
	scalarParamNames,
	type WriteOp
} from "#compiler/ir/desc.ts"
import * as S from "#compiler/ir/shape.ts"
import { inReservedSpace, slotSpelling } from "#compiler/ir/slots.ts"
import { schemaInfo } from "#compiler/query/build/heading.ts"
import { queryOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { isCallback } from "#compiler/query/build/scope.ts"
import {
	isOrdered,
	isRowsValue,
	publicDesc,
	queryState,
	rowsSource
} from "#compiler/query/build/state.ts"
import { headValueOf } from "#compiler/query/build/terms.ts"
import { spellRows } from "#compiler/query/build/walk.ts"
import { termExpr } from "#compiler/scalar/compute/term.ts"
import { bareEnv } from "#compiler/scalar/registry.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { highestLevel, isLevelOver, type Level } from "#compiler/schema/level.ts"
import { untypedLiteral } from "#compiler/schema/literal.ts"
import { builderRefusal, malformed, orThrow, requireName } from "#compiler/schema/protocol.ts"
import { recordOf } from "#compiler/schema/record.ts"
import type {
	ChangeSetConstructor,
	ChangeSetOf,
	Delta,
	JointReads,
	ReadName,
	Strata,
	Stratum
} from "#compiler/types/changeset/changeset.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import type { Decoders, OrderedBase, QueryBase } from "#compiler/types/query/query.ts"
import { type BuiltOver, builtOverOf } from "#compiler/write/changeset/levels.ts"
import { delta, memberRelation, memberRelationNamed } from "#compiler/write/delta/source.ts"

/** What any member does: a write member's op, which an array holds. */
type SlotOp = MemberDesc["op"]

/**
 * One member as the value holds it, with its Description, `desc`, which the ChangeSet's Description holds as it is:
 * built from parts already decoded when the member is made, and again only when a rename changes its query or its
 * stratum changes its slot.
 */
type MemberState =
	| {
			readonly kind: "array"
			readonly op: SlotOp
			readonly relation: string
			readonly facts: ReadonlyArray<unknown>
			/** The input its facts travel as (`arraySlot`). */
			readonly slot: string
			readonly desc: MemberDesc
	  }
	| {
			readonly kind: "query"
			readonly op: WriteOp
			readonly relation: string
			readonly query: QueryDesc
			/** The identity digest of the query (ir/desc.ts descIdentity), which orders and deduplicates query members. */
			readonly identity: IdentityDigest
			readonly params: ReadonlySet<string>
			readonly desc: MemberDesc
	  }
	| {
			readonly kind: "equal"
			readonly op: WriteOp
			readonly relation: string
			/** Each field it selects by, and the parameter or literal the field equals. */
			readonly fields: Readonly<Record<string, EqualedDesc>>
			/** The identity digest of its fields, which orders and deduplicates field-equality members. */
			readonly identity: IdentityDigest
			readonly params: ReadonlySet<string>
			readonly desc: MemberDesc
	  }
	| {
			readonly kind: "computed"
			readonly op: "insert"
			readonly relation: string
			/** The fields its stratum's host rows of its relation leave out, one rule finding each one's value
			 * (ir/desc.ts ComputedSourceDesc). */
			readonly query: QueryDesc
			/** The identity digest of the query, which orders and deduplicates computed records. */
			readonly identity: IdentityDigest
			readonly params: ReadonlySet<string>
			readonly desc: MemberDesc
	  }

/**
 * A read-back as the value holds it, with its Description, which the ChangeSet's Description holds as it is: its name,
 * its query, the identity digest of the query (ir/desc.ts descIdentity), which tells two read-backs of one name apart
 * (`readBackSet`), and the field its rows are decoded by in the outcome's record of read-backs, an attachment of the
 * query's immediate decoder delivering every row.
 */
interface ReadBackState {
	readonly name: string
	readonly query: QueryDesc
	readonly identity: IdentityDigest
	readonly params: ReadonlySet<string>
	readonly loc: SourceLoc
	readonly desc: ReadBackDesc
	readonly field: RecordField<ReadonlyArray<unknown>>
}

/**
 * What tells two values bound under one name apart: the value's canonical tokens (core/canonical.ts canonicalTokens),
 * read once when bind takes it, its canonical text's tokens and never that text, so a value whose texts sum past the
 * longest string is keyed as any other, ordered by them and told apart by their identity (canonicalTokensId); or opaque for a value that has none, a Stream or a vector with a component
 * that is not finite, which is equal to no other value and has no canonical order.
 */
type BoundKey =
	| {
			readonly kind: "tokens"
			readonly tokens: ReadonlyArray<CanonicalToken>
			readonly id: TextsId
	  }
	| { readonly kind: "opaque" }

/**
 * A parameter bind closed, by the name it had when bound (`origin`): to a value, with the value's key; or, a relation
 * parameter, to the rows of a query or a bound query (RowsDesc), its bind map read in the ChangeSet's namespace, an
 * input of the call evaluated once before `stratum`, the first stratum of the part it was bound on (ChangeSetDesc
 * `boundRows`, BoundRowsDesc), whose key the canonical naming reads from the scope (`rowsKeys`), since the parameters its
 * bind map reads may be bound in turn.
 */
type BoundParam =
	| {
			readonly kind: "value"
			readonly origin: string
			readonly value: ParamValue
			readonly key: BoundKey
	  }
	| {
			readonly kind: "rows"
			readonly origin: string
			readonly stratum: number
			readonly rows: RowsDesc
	  }

/** The key of a bound value (`BoundKey`). */
const boundKey = (value: ParamValue): BoundKey => {
	const tokens = canonicalTokens(value, everyProperty)
	return tokens.ok
		? { kind: "tokens", tokens: tokens.value, id: canonicalTokensId(tokens.value) }
		: { kind: "opaque" }
}

/**
 * What tells two private parameters of one origin apart where the canonical naming reads them (`canonicalBindings`): a
 * value's key (`BoundKey`), or the identity of bound rows (`rowsKeys`).
 */
type PrivateKey = BoundKey | { readonly kind: "rows"; readonly id: IdentityDigest }

/** A private key's rank among the kinds: values with a canonical text, then bound rows, then opaque values. */
const keyRank = (key: PrivateKey): number =>
	key.kind === "tokens" ? 0 : key.kind === "rows" ? 1 : 2

/** Private parameters by origin, then by key: every canonical text in code-unit order (compareCanonicalTokens), then
 * bound rows by their identity, then the opaque ones as the sort found them. */
interface Keyed {
	readonly origin: string
	readonly key: PrivateKey
}

const boundOrder: Order.Comparator<Keyed> = Order.combineAll([
	Order.mapInput(Order.compareStrings, (p: Keyed) => p.origin),
	(a: Keyed, b: Keyed) =>
		a.key.kind === "tokens" && b.key.kind === "tokens"
			? compareCanonicalTokens(a.key.tokens, b.key.tokens)
			: a.key.kind === "rows" && b.key.kind === "rows"
				? Order.compareStrings(a.key.id, b.key.id)
				: Order.compareNumbers(keyRank(a.key), keyRank(b.key))
])

interface ChangeSetState {
	/** The schema or role value it was built over, as a level (`BuiltOver`). */
	readonly over: BuiltOver
	readonly strata: ReadonlyArray<ReadonlyArray<MemberState>>
	readonly reads: ReadonlyArray<ReadBackState>
	/** The parameters bind closed, by their private names. */
	readonly bound: ReadonlyMap<string, BoundParam>
	/** Their values, by private name. */
	readonly values: ReadonlyMap<string, ParamValue>
	/**
	 * The private names of the values bind read with no canonical text (`BoundKey` opaque), in their order: read once,
	 * when bind took them, so what a caller does to such a value later never gives it one.
	 */
	readonly opaque: ReadonlyArray<string>
	readonly desc: ChangeSetDesc
	/** The array members' facts, by the slot their member's Description names. */
	readonly inputs: ReadonlyMap<string, ChangeSetInput>
}

/** The host input of one array member, its facts, by slot: the facts a served call supplies for it. */
export type ChangeSetInput = ReadonlyArray<unknown>

/** A member argument: an array of facts, or a query value; an ordered value is refused with its own diagnostic. A
 * JavaScript caller passing anything else is refused. */
export type MemberInput = ReadonlyArray<unknown> | QueryBase | OrderedBase

/** What a JavaScript caller sees: a ChangeSet of any schema, parameters, writes and read-backs, each method taking what
 * such a caller may pass. It is a view of the typed values make builds, never a second builder: every
 * ChangeSet is one, since its methods are declared with method syntax, and changeSetOver delivers the typed values
 * themselves under it, for the internal tests and packages that drive the builder over values known only at run time.
 *
 * The ChangeSet value.
 *
 * A ChangeSet is a sealed, canonical, immutable value: insert, delete, put, read and bind return a new value, union is
 * the commutative combination, and sequence is the only source of strata. Its meaning is one add-wins
 * transition per stratum, S' = (S \ D) ∪ A, every member of a stratum evaluated against the state before it; build
 * order never matters within a stratum. The value records a ChangeSetDesc, exposed as its
 * non-enumerable `desc`, and holds the host inputs its array members carry, outside the Description and
 * outside template identity:
 *
 * - Canonical. Within a stratum the array members of one operation on one relation are one member, their facts
 *   concatenated (the codec deduplicates them); query members are deduplicated by their canonical
 *   Description. Members are sorted by relation, operation and kind, so a ChangeSet built in any order of its members
 *   has one Description, and each array member's slot is named by its canonical position, `member[stratum,op,relation]`.
 * - Sealed. Every value is frozen; the facts of an array member are copied and frozen when the member is added, so a
 *   caller mutating its array afterwards changes nothing.
 * - Strata. insert, delete and put add to the last stratum; union combines strata position by position, and sequence
 *   concatenates them. An empty stratum is kept, because union aligns strata by position.
 * - Levels. A ChangeSet is built over a schema or a role (`BuiltOver`). Members and read-backs may be written
 *   over any level of it, a full role's base among a role's; union and sequence are over the highest of their
 *   arguments' schemas and refuse schemas of which neither is a level of the other. A ChangeSet over a role writes the
 *   role's relations: its whole ordinary entries and its query entries (`writableRelation`).
 * - Read-backs. read(name, callback) calls the callback once with a Delta; its query or ordered
 *   query is the read-back. A ChangeSet's read-backs are one set, by name (`readBackSet`): each is read once, after the
 *   whole ChangeSet, every placement of it reading the state after the last stratum and the delta of the whole change
 *   (write/schedule/plan.ts placeReadBacks), so two read-backs of one name over one query, by the query's identity
 *   digest once the private parameters are canonical, are one read-back, whatever strata, unions or reads they came
 *   from, and one name over two queries is refused, naming both. The value carries `reads`, the decoder of the
 *   outcome's record of read-backs, built from the set alone: one record, in name order, under each name an attachment
 *   of the read-back query's immediate decoder delivering every row (`record` over named parts), so it never follows
 *   the order the read-backs were added or combined in.
 * - Parameters. A ChangeSet's free parameters are one namespace, the union of its members', read-backs' and bound
 *   rows' parameters. bind closes the ones it names, hygienically, as Query.bind closes an import's, and leaves the
 *   rest free: a bound parameter leaves the namespace, its uses keeping a name of their own, private to the ChangeSet.
 *   One bound to a value is listed under the Description's `bindings`, its value travelling beside the Description;
 *   a relation parameter bound to a query or a bound query is listed under its `boundRows` with those rows, an input of
 *   the call evaluated once, before the first stratum of the ChangeSet bind was called on, which every member and
 *   read-back that uses it reads by its name (ir/write.ts BoundInput), the query's own parameters joining the namespace:
 *   a binding is scoped to the part it was made on, as a let is to its body, so sequence places a binding of its second
 *   part after the first part's strata, as it places that part's members, and union keeps each where it was. A member or read-back added later, or a ChangeSet combined with this one, whose parameter has the
 *   bound name needs a separate, free parameter, so the private names are renamed out of its way first (release), and
 *   two ChangeSets that bind one name to different values or queries combine into two private parameters. Private
 *   parameters of one name bound to equal values, or to one query reading equal parameters evaluated before one
 *   stratum, are one parameter, and a
 *   private name is canonical (canonicalBindings): those bound to values first, then those bound to rows, each named
 *   in the order of the names they were bound under and then of their values' canonical texts or their rows' identity,
 *   its own name when no free parameter and no private one named before it has it, otherwise that name, `#` and the
 *   least index that is free. So the names, and with them the Description, follow from the values and never from the order the members
 *   were built or combined in, but for values bound under one name that have no canonical text, Streams, which are
 *   named in the order the ChangeSet holds them.
 *
 * A malformed argument from a JavaScript caller, one the TypeScript signatures already forbid, throws CompileError
 * MalformedDescription; every semantic diagnostic, a member head that is not the
 * relation's heading included, is compilation's (frontend/). */
export interface ChangeSetValue extends Built {
	readonly reads: RowDecoder<unknown>
	insert(relation: unknown, facts: MemberInput): ChangeSetValue
	/** A JavaScript caller's record is read once: one that is no plain record, holds a symbol key or throws as it is read
	 * is refused, and so is a key that names no relation the ChangeSet writes. */
	insertAll(rows: Readonly<Record<string, MemberInput>>): ChangeSetValue
	/** insertAll's record, each key's rows an array leaving out the fields `computed` names; a JavaScript
	 * caller's computed fields are a plain record of terms, read once, as deleteWhere's are, naming at least one field. */
	insertAllComputed(
		rows: Readonly<Record<string, MemberInput>>,
		computed: Readonly<Record<string, unknown>>
	): ChangeSetValue
	delete(relation: unknown, facts: MemberInput): ChangeSetValue
	/** A JavaScript caller's record of records is read once, as insertAll's: each key a relation the ChangeSet writes,
	 * each field a parameter or a literal. */
	deleteWhere(
		selections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	): ChangeSetValue
	put(relation: unknown, facts: MemberInput): ChangeSetValue
	/** A read-back from a JavaScript caller may be any value; the builder checks it is a function. */
	read(name: unknown, readBack: unknown): ChangeSetValue
	bind(params: unknown): ChangeSetValue
}

/** The runtime member a ChangeSet has beside its public ones: the schema value it was built over. */
interface SchemaMember {
	readonly schema: unknown
}

/** An array argument, by a check that keeps its members unknown. */
const isFactArray = (value: MemberInput): value is ReadonlyArray<unknown> => Array.isArray(value)

const states = new WeakMap<object, ChangeSetState>()

/** The state of a ChangeSet value, none when the value is not one. */
export const changeSetState = (value: unknown): ChangeSetState | undefined =>
	hasProperties(value) ? states.get(value) : undefined

export const isChangeSetValue = (value: unknown): value is ChangeSetValue =>
	changeSetState(value) !== undefined

/** The Description of a ChangeSet value, none when the value is not one. */
export const changeSetDesc = (value: unknown): ChangeSetDesc | undefined =>
	changeSetState(value)?.desc

/** A ChangeSet value as compiling and applying it read it, taken once where the value enters (db.apply,
 * db.compile): the level of the schema or role it was built over, which a level is matched by, its
 * Description, the host inputs of its array members by the slot their member names, and the values bind
 * closed by the private parameter names the Description's `bindings` lists. */
export interface ParsedChangeSet {
	/** The schema or role value it was built over, and its level. */
	readonly over: BuiltOver
	readonly desc: ChangeSetDesc
	readonly inputs: ReadonlyMap<string, ChangeSetInput>
	readonly values: ReadonlyMap<string, ParamValue>
	/** The private names of its bound values with no canonical text, read at bind (ChangeSetState). */
	readonly opaque: ReadonlyArray<string>
}

/** The parsed ChangeSet of a value, none when the value is not one. */
export const parseChangeSet = (value: unknown): ParsedChangeSet | undefined => changeSetState(value)

const kindRank: Readonly<Record<MemberState["kind"], number>> = {
	array: 0,
	query: 1,
	equal: 2,
	computed: 3
}

/** A member its statement reads the facts of, a query or a field-equality member, or an insert's computed fields, held
 * by its identity digest. */
type Described = Extract<MemberState, { readonly kind: "query" | "equal" | "computed" }>

/** Whether a member is described, so ordered and deduplicated by its identity digest. */
const isDescribed = (m: MemberState): m is Described =>
	m.kind === "query" || m.kind === "equal" || m.kind === "computed"

/** The group of a member: its op and relation. An op is a word without a colon, so the first colon ends it. */
const groupKey = (m: MemberState): string => `${m.op}:${m.relation}`

/** The order of members by their relation's name, a canonical stratum's first. */
const relationOrder = Order.mapInput(
	Order.compareStrings,
	(m: { readonly relation: string }) => m.relation
)

/** The order of a canonical stratum's members: by relation, operation and kind, then a described member by its identity
 * digest, a total order over the digests. */
const memberOrder: Order.Comparator<MemberState> = Order.combineAll([
	relationOrder,
	Order.mapInput(Order.compareStrings, (m: MemberState) => m.op),
	Order.mapInput(Order.compareNumbers, (m: MemberState) => kindRank[m.kind]),
	(a: MemberState, b: MemberState) =>
		isDescribed(a) && isDescribed(b) ? Order.compareStrings(a.identity, b.identity) : 0
])

/** The canonical form of one stratum's members (see `ChangeSetValue`). */
const canonicalStratum = (members: ReadonlyArray<MemberState>): ReadonlyArray<MemberState> => {
	const arrays = new Map<string, Extract<MemberState, { kind: "array" }>>()
	/** Equal described members are one: the first of each operation, relation, kind and identity digest. */
	const described: Array<Described> = []
	const texts = new TextsMap<true>()
	for (const m of members) {
		const group = groupKey(m)
		switch (m.kind) {
			case "array": {
				const seen = arrays.get(group)
				arrays.set(
					group,
					seen === undefined ? m : { ...seen, facts: Object.freeze([...seen.facts, ...m.facts]) }
				)
				break
			}
			case "query":
			case "equal":
			case "computed": {
				const identity = textsId([m.kind, group, m.identity])
				if (!texts.has(identity)) {
					texts.set(identity, true)
					described.push(m)
				}
			}
		}
	}
	return Object.freeze([...arrays.values(), ...described].toSorted(memberOrder))
}

/**
 * The `s`-th canonical stratum with one member more, canonical again, as canonicalStratum would make it: the member
 * after every member that sorts with or before it, which merges an array member into its group's and keeps a query
 * member equal to one before it out.
 */
const withMember = (
	stratum: ReadonlyArray<MemberState>,
	m: MemberState
): ReadonlyArray<MemberState> => {
	let low = 0
	let high = stratum.length
	while (low < high) {
		const middle = Math.floor((low + high) / 2)
		if (memberOrder(defined(stratum[middle], "a member of the stratum"), m) <= 0) {
			low = middle + 1
		} else {
			high = middle
		}
	}
	const before = stratum[low - 1]
	const sameGroup =
		before !== undefined && before.kind === m.kind && groupKey(before) === groupKey(m)
	if (sameGroup && before.kind === "array" && m.kind === "array") {
		return Object.freeze(
			stratum.with(low - 1, { ...before, facts: Object.freeze([...before.facts, ...m.facts]) })
		)
	}
	if (sameGroup && isDescribed(before) && isDescribed(m) && before.identity === m.identity) {
		return stratum
	}
	return Object.freeze(stratum.toSpliced(low, 0, m))
}

/** The slot of a stratum's array members of one op and relation, which are one input (`EnumeratedInput` spells
 * it). */
export const arraySlot = (stratum: number, op: SlotOp, relation: string): string =>
	slotSpelling("member", stratum, op, "array", relation)

/**
 * The members insertAll over `relations`, each a top-level relation of the schema and an array, places in its one
 * stratum, in its canonical order (`memberOrder`, which orders members of one operation and kind by relation alone):
 * each relation with its array's slot, read off the names alone, building no ChangeSet.
 */
export const insertAllSlots = (
	relations: ReadonlyArray<string>
): ReadonlyArray<{ readonly slot: string; readonly relation: string }> =>
	relations
		.map((relation) => ({ slot: arraySlot(0, "insert", relation), relation }))
		.toSorted(relationOrder)

/** A source location as a Description keeps it (shape.ts sourceLoc): frozen, so a Description holding it is. */
const keptLoc = (loc: SourceLoc): SourceLoc =>
	orThrow(S.decodeWith(S.sourceLoc, loc, "ChangeSet member location"))

/** The Description of an array member at `slot`, its location kept. */
const enumeratedDesc = (op: SlotOp, relation: string, slot: string, loc: SourceLoc): MemberDesc =>
	Object.freeze({ op, relation, member: Object.freeze({ kind: "array", slot }), loc })

/** The Description of a query member, its query a decoded Description and its location kept. */
const queryMemberDesc = (
	op: WriteOp,
	relation: string,
	query: QueryDesc,
	loc: SourceLoc
): MemberDesc =>
	Object.freeze({ op, relation, member: Object.freeze({ kind: "query", query }), loc })

/** A field-equality member of `op` on `relation`, its fields decoded parts and its location kept: its Description and
 * the identity digest of its fields, which order and deduplicate it. */
const equalState = (
	op: WriteOp,
	relation: string,
	fields: Readonly<Record<string, EqualedDesc>>,
	loc: SourceLoc
): Extract<MemberState, { readonly kind: "equal" }> => ({
	kind: "equal",
	op,
	relation,
	fields,
	identity: identityOf(fields),
	params: equalParamNames(fields),
	desc: Object.freeze({ op, relation, member: Object.freeze({ kind: "equal", fields }), loc })
})

/** An array member at `slot`: itself when it is there already. */
const atSlot = (
	m: Extract<MemberState, { readonly kind: "array" }>,
	slot: string
): Extract<MemberState, { readonly kind: "array" }> =>
	m.slot === slot ? m : { ...m, slot, desc: enumeratedDesc(m.op, m.relation, slot, m.desc.loc) }

/** The members of the `s`-th canonical stratum, each at the slot its place names: an array member at its op's and
 * relation's. */
const placed = (members: ReadonlyArray<MemberState>, s: number): ReadonlyArray<MemberState> =>
	Object.freeze(
		members.map((m): MemberState =>
			m.kind === "array" ? atSlot(m, arraySlot(s, m.op, m.relation)) : m
		)
	)

/** Strata canonical and placed, each stratum's members at the slots their places name. */
const canonicalStrata = (
	strata: ReadonlyArray<ReadonlyArray<MemberState>>
): ReadonlyArray<ReadonlyArray<MemberState>> =>
	Object.freeze(strata.map((members, s) => placed(canonicalStratum(members), s)))

/**
 * The Description and the inputs of a state's placed strata and read-backs, its read-back set in name order
 * (`readBackSet`): its members' and read-backs' own Descriptions, which are decoded parts and parts this module minted
 * (an op, a relation the ChangeSet's schema declares, a slot, a kept location), so the Description is what its decoder
 * would give and none of it is read again.
 * The one rule over its parameters the builder does not keep by construction is that none is spelled like a member
 * slot a compiled write reserves; a parameter spelled in that space has the whole Description decoded, whose decoder
 * refuses it with the location of the first member whose slot it takes (changeSetDescShape).
 */
const describe = (
	strata: ReadonlyArray<ReadonlyArray<MemberState>>,
	reads: ReadonlyArray<ReadBackState>,
	bound: ReadonlyMap<string, BoundParam>
): { readonly desc: ChangeSetDesc; readonly inputs: ReadonlyMap<string, ChangeSetInput> } => {
	const inputs = new Map<string, ChangeSetInput>()
	for (const m of strata.flat()) {
		if (m.kind === "array") {
			inputs.set(m.slot, m.facts)
		}
	}
	const names = [...bound.keys()].toSorted(Order.compareStrings)
	const desc: ChangeSetDesc = Object.freeze({
		strata: Object.freeze(
			strata.map((members) => Object.freeze({ members: Object.freeze(members.map((m) => m.desc)) }))
		),
		reads: Object.freeze(reads.map((r) => r.desc)),
		bindings: Object.freeze(names.filter((name) => bound.get(name)?.kind === "value")),
		boundRows: Object.freeze(
			Object.fromEntries(
				names.flatMap((name) => {
					const param = bound.get(name)
					return param?.kind === "rows" ? [[name, boundRowsOf(param)] as const] : []
				})
			)
		)
	})
	if ([...usedParams({ strata, reads, bound })].some(inReservedSpace)) {
		orThrow(decodeDesc("changeSet", desc))
	}
	return { desc, inputs }
}

/** A private parameter bound to rows as the Description holds it (BoundRowsDesc): its stratum and its rows. */
const boundRowsOf = (param: Extract<BoundParam, { readonly kind: "rows" }>): BoundRowsDesc =>
	Object.freeze({ stratum: param.stratum, rows: param.rows })

/** The part of a state that holds parameters. */
type Scope = Pick<ChangeSetState, "strata" | "reads" | "bound">

/** A state's scope: its members, read-backs and parameters. */
const scopeOf = (state: ChangeSetState): Scope => ({
	strata: state.strata,
	reads: state.reads,
	bound: state.bound
})

/** Every parameter name the members, read-backs and bound rows use, free or private, in canonical walk order: a bound
 * query's own parameters join the namespace, read by its rows' bind map (rowsParamNames). */
const usedParams = (scope: Scope): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const p of scope.strata.flatMap((stratum) =>
		stratum.flatMap((m) => (isDescribed(m) ? [...m.params] : []))
	)) {
		out.add(p)
	}
	for (const r of scope.reads) {
		for (const p of r.params) {
			out.add(p)
		}
	}
	for (const param of scope.bound.values()) {
		if (param.kind === "rows") {
			for (const p of rowsParamNames(param.rows)) {
				out.add(p)
			}
		}
	}
	return out
}

const freeParams = (scope: Scope): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const p of usedParams(scope)) {
		if (!scope.bound.has(p)) {
			out.add(p)
		}
	}
	return out
}

/** `origin` when it is not taken, otherwise `origin#k` for the least k from 1 that is not. The image is injective in
 * (origin, k), because k has no `#`. */
const freshName = (origin: string, taken: ReadonlySet<string>): string => {
	if (!taken.has(origin)) {
		return origin
	}
	for (let k = 1; ; k++) {
		const candidate = `${origin}#${k}`
		if (!taken.has(candidate)) {
			return candidate
		}
	}
}

/** A member a query describes, its query `query`: its identity, its parameters and its Description with it. */
const withMemberQuery = (
	m: Extract<MemberState, { readonly kind: "query" | "computed" }>,
	query: QueryDesc
): MemberState =>
	m.kind === "computed"
		? computedState(m.relation, query, m.desc.loc)
		: {
				...m,
				query,
				identity: identityOf(query),
				params: queryParamNames(query),
				desc: queryMemberDesc(m.op, m.relation, query, m.desc.loc)
			}

/** A read-back, its query `query`: its identity, its parameters and its Description with it. */
const withReadQuery = (r: ReadBackState, query: QueryDesc): ReadBackState => ({
	...r,
	query,
	identity: identityOf(query),
	params: queryParamNames(query),
	desc: Object.freeze({ name: r.name, query })
})

const renameMember = (m: MemberState, rename: ReadonlyMap<string, string>): MemberState => {
	if (!isDescribed(m) || ![...m.params].some((p) => rename.has(p))) {
		return m
	}
	if (m.kind === "equal") {
		return equalState(m.op, m.relation, renameEqualParams(m.fields, rename), m.desc.loc)
	}
	return withMemberQuery(m, renameQueryParams(m.query, rename))
}

const renameRead = (r: ReadBackState, rename: ReadonlyMap<string, string>): ReadBackState =>
	[...r.params].some((p) => rename.has(p))
		? withReadQuery(r, renameQueryParams(r.query, rename))
		: r

/** The scope with its uses of the names `rename` maps renamed, and its private parameters with them. The images are
 * distinct and none is a name of the scope `rename` leaves in place. */
const renameScope = (scope: Scope, rename: ReadonlyMap<string, string>): Scope => {
	if (rename.size === 0) {
		return scope
	}
	const bound = new Map<string, BoundParam>()
	for (const [name, param] of scope.bound) {
		bound.set(
			rename.get(name) ?? name,
			param.kind === "rows" ? { ...param, rows: renameRowsParams(param.rows, rename) } : param
		)
	}
	return {
		strata: scope.strata.map((stratum) => {
			const renamed = stratum.map((m) => renameMember(m, rename))
			return renamed.every((m, i) => m === stratum[i]) ? stratum : canonicalStratum(renamed)
		}),
		reads: scope.reads.map((r) => renameRead(r, rename)),
		bound
	}
}

/** The scope with every private parameter whose name `avoid` holds renamed to a name neither `avoid` nor the scope
 * holds, so that the free parameters `avoid` names stay separate from the scope's bound ones (hygiene). */
const release = (scope: Scope, avoid: ReadonlySet<string>): Scope => {
	const clashing = [...scope.bound].filter(([p]) => avoid.has(p))
	if (clashing.length === 0) {
		return scope
	}
	const taken = new Set([...avoid, ...usedParams(scope), ...scope.bound.keys()])
	const rename = new Map<string, string>()
	for (const [p, bound] of clashing) {
		const image = freshName(bound.origin, taken)
		taken.add(image)
		rename.set(p, image)
	}
	return renameScope(scope, rename)
}

/**
 * Two scopes combined: their private parameters named as one scope's (`canonicalParts`), each part renamed once to the
 * names it ends with, and their bindings joined, those of one origin and one key one. The free parameters of the two
 * stay one namespace.
 */
const combine = (
	a: Scope,
	b: Scope
): { readonly a: Scope; readonly b: Scope; readonly bound: ReadonlyMap<string, BoundParam> } => {
	const { parts, bound } = canonicalParts([a, b])
	return {
		a: defined(parts[0], "the first part, named"),
		b: defined(parts[1], "the second part, named"),
		bound
	}
}

/**
 * The keys of a scope's private parameters bound to rows (`canonicalBindings`): the identity digest of the binding as the
 * Description holds it (BoundRowsDesc), its stratum and its rows, with each private parameter bound to a value that
 * their bind map reads spelled by its canonical name (`valueImage`), and each one bound to rows spelled by that
 * parameter's own key, so two bindings of one query are one input exactly when they are evaluated before one stratum and
 * read equal parameters, whatever names the rows-bound ones have before the canonical naming chooses theirs. A rows
 * binding reads only parameters bound after it (release moves a private name out of the way of the parameters a later
 * binding's query brings), so the keys are well founded.
 */
const rowsKeys = (
	bound: ReadonlyMap<string, BoundParam>,
	valueImage: ReadonlyMap<string, string>
): ((name: string) => IdentityDigest) => {
	const keys = new Map<string, IdentityDigest>()
	const keyOf = (name: string): IdentityDigest => {
		const known = keys.get(name)
		if (known !== undefined) {
			return known
		}
		const param = bound.get(name)
		if (param?.kind !== "rows") {
			defect(`a private parameter bound to rows, not ${name}`)
		}
		const spelled = new Map(
			[...rowsParamNames(param.rows)].flatMap((p): ReadonlyArray<readonly [string, string]> => {
				const value = valueImage.get(p)
				if (value !== undefined) {
					return [[p, value]]
				}
				return bound.get(p)?.kind === "rows" ? [[p, `\u0000${keyOf(p)}`]] : []
			})
		)
		const key = orThrow(
			descIdentity(boundRowsOf({ ...param, rows: renameRowsParams(param.rows, spelled) }))
		)
		keys.set(name, key)
		return key
	}
	return keyOf
}

/** A private parameter of one of the parts the canonical naming names together (`canonicalParts`): its part, and its name there. */
interface PartPrivate {
	readonly part: number
	readonly name: string
}

/**
 * Private parameters of one kind merged and named (`canonicalParts`): those of one origin and one key are one, the
 * first kept; each kept one is named in turn in the order of their origins and keys (`boundOrder`), its origin when no
 * name `taken` holds has it, otherwise the origin, `#` and the least index that is free, which `taken` then holds. The
 * image of every one, a merged one's its kept one's.
 */
const namedPrivates = (
	privates: ReadonlyArray<{
		readonly id: PartPrivate
		readonly origin: string
		readonly key: PrivateKey
	}>,
	taken: Set<string>
): {
	readonly kept: ReadonlySet<PartPrivate>
	readonly image: ReadonlyMap<PartPrivate, string>
} => {
	const keptOf = new Map<PartPrivate, PartPrivate>()
	const kept: Array<{
		readonly id: PartPrivate
		readonly origin: string
		readonly key: PrivateKey
	}> = []
	/** The kept private parameter of each origin and key. */
	const values = new Map<string, TextsMap<PartPrivate>>()
	const rows = new Map<string, Map<IdentityDigest, PartPrivate>>()
	for (const p of privates) {
		const { key } = p
		if (key.kind === "opaque") {
			kept.push(p)
			continue
		}
		const same =
			key.kind === "tokens"
				? values.getOrInsertComputed(p.origin, () => new TextsMap<PartPrivate>()).get(key.id)
				: rows
						.getOrInsertComputed(p.origin, () => new Map<IdentityDigest, PartPrivate>())
						.get(key.id)
		if (same !== undefined) {
			keptOf.set(p.id, same)
			continue
		}
		kept.push(p)
		if (key.kind === "tokens") {
			values.getOrInsertComputed(p.origin, () => new TextsMap<PartPrivate>()).set(key.id, p.id)
		} else {
			rows
				.getOrInsertComputed(p.origin, () => new Map<IdentityDigest, PartPrivate>())
				.set(key.id, p.id)
		}
	}
	const image = new Map<PartPrivate, string>()
	for (const p of kept.toSorted(boundOrder)) {
		const named = freshName(p.origin, taken)
		taken.add(named)
		image.set(p.id, named)
	}
	for (const [id, same] of keptOf) {
		image.set(id, defined(image.get(same), "a merged private parameter's kept one, named"))
	}
	return { kept: new Set(kept.map((p) => p.id)), image }
}

/**
 * The canonical private names of the parts of one scope (see `ChangeSetValue`), a scope alone or the two a union or a
 * sequence combines: the parts' private parameters bound to values merged and named first (`namedPrivates`), by their
 * values' keys (`BoundKey`), then those bound to rows, by keys that read the values' canonical names (`rowsKeys`, each
 * part's over its own bindings), every name chosen past every part's free parameters, which are one namespace, and the
 * ones chosen before it. Private parameters of one origin and one key are one, whichever parts bind them and under
 * whatever names; each part is renamed once, to the names it ends with, and none of its members is rebuilt but where a
 * name it reads changes (renameScope), so a union of parts binding one query under one name rebuilds none. The names
 * follow from the free parameters, the bound values and the bound rows alone, never from the order the members were
 * built or combined in; only private parameters of one origin bound to opaque values keep the order the parts hold them
 * in. Where a combination renamed each part's clashing private parameters out of the other's way and then named the
 * whole, every member of a part reading a clashing name was rebuilt and its identity digested twice for each union and
 * sequence: metis's tower of programs, each a union or sequence of parts bound to their sittings, digested 16.8 million
 * frozen parts as its modules loaded, each held by an exported ChangeSet, past V8's largest hash table.
 */
const canonicalParts = (
	parts: ReadonlyArray<Scope>
): { readonly parts: ReadonlyArray<Scope>; readonly bound: ReadonlyMap<string, BoundParam> } => {
	const taken = new Set(parts.flatMap((part) => [...freeParams(part)]))
	const ids = parts.map(
		(part, at) => new Map([...part.bound.keys()].map((name) => [name, { part: at, name } as const]))
	)
	const idOf = (at: number, name: string): PartPrivate =>
		defined(ids[at]?.get(name), "a part's private parameter")
	const values = namedPrivates(
		parts.flatMap((part, at) =>
			[...part.bound].flatMap(([name, param]) =>
				param.kind === "value" ? [{ id: idOf(at, name), origin: param.origin, key: param.key }] : []
			)
		),
		taken
	)
	const rows = namedPrivates(
		parts.flatMap((part, at) => {
			const valueImage = new Map(
				[...part.bound].flatMap(([name, param]) =>
					param.kind === "value"
						? [[name, defined(values.image.get(idOf(at, name)), "a value's name")] as const]
						: []
				)
			)
			const rowsKey = rowsKeys(part.bound, valueImage)
			return [...part.bound].flatMap(([name, param]) =>
				param.kind === "rows"
					? [
							{
								id: idOf(at, name),
								origin: param.origin,
								key: { kind: "rows", id: rowsKey(name) } as const
							}
						]
					: []
			)
		}),
		taken
	)
	const named = parts.map((part, at) => {
		const imageOf = (name: string): string =>
			defined(
				values.image.get(idOf(at, name)) ?? rows.image.get(idOf(at, name)),
				"a private parameter's canonical name"
			)
		const rename = new Map(
			[...part.bound.keys()].flatMap((name) => {
				const image = imageOf(name)
				return image === name ? [] : [[name, image] as const]
			})
		)
		const kept = new Map(
			[...part.bound].filter(
				([name]) => values.kept.has(idOf(at, name)) || rows.kept.has(idOf(at, name))
			)
		)
		return renameScope({ strata: part.strata, reads: part.reads, bound: kept }, rename)
	})
	return { parts: named, bound: new Map(named.flatMap((part) => [...part.bound])) }
}

/** The canonical private names of a scope (`canonicalParts`), the scope alone its one part. */
const canonicalBindings = (scope: Scope): Scope =>
	scope.bound.size === 0 ? scope : defined(canonicalParts([scope]).parts[0], "the one part, named")

/** Read-backs by name. */
const readNameOrder = Order.mapInput(Order.compareStrings, (r: ReadBackState) => r.name)

/**
 * A ChangeSet's read-backs as the one set it holds (see `ChangeSetValue`), in name order: a read-back is its name and
 * its query, read once after the whole ChangeSet, so read-backs of one name whose queries have one identity digest
 * are one, the first of them, and one name over two queries is refused by `label`, the read, union or sequence that
 * brought them together, naming both. Read only after the private parameters are canonical (canonicalBindings), so
 * two bindings of one query to equal values are one query, and to different values two.
 */
const readBackSet = (
	label: string,
	reads: ReadonlyArray<ReadBackState>
): ReadonlyArray<ReadBackState> => {
	const byName = new Map<string, ReadBackState>()
	for (const r of reads) {
		const held = byName.get(r.name)
		if (held === undefined) {
			byName.set(r.name, r)
		} else if (held.identity !== r.identity) {
			throw malformed(
				label,
				`one query under each read-back name; ${JSON.stringify(r.name)} reads two: ${formatLoc(held.loc)} and ${formatLoc(r.loc)}`
			)
		}
	}
	return Object.freeze([...byName.values()].toSorted(readNameOrder))
}

/**
 * The decoder of the outcome's record of read-backs, built from the set `reads`, in its name order: one record, each
 * read-back's field under its name. Its type, Rd, is the one the ChangeSet's public signature states for its
 * read-backs (types/changeset ChangeSetOf), each of whose names is one of the set's, its rows those of the query's
 * immediate decoder.
 */
const readsDecoder = <Rd>(reads: ReadonlyArray<ReadBackState>): RowDecoder<Rd> =>
	decoderOf<Rd>(recordOf(reads.map((r) => new Named(r.name, r.field))).form)

/** The ChangeSet value of a state, built under its public type ChangeSet<S, P, W, Rd>, which the literal is checked
 * against: its private parameters made canonical, then its read-backs one set (`readBackSet`, refused by `label`, the
 * builder that made the state), and the decoder of their record built from the set (`readsDecoder`). The schema,
 * parameters, writes and read-backs' records are phantoms no runtime value holds, and the value holds the brand and the
 * decoder. Each member is implemented under its contextual signature: its result is the value of the state it makes,
 * whose phantoms are the ones the signature names (each builder below takes them from its contextual result type).
 * insert, insertAll, delete and put are functions over the ChangeSet they are called on (types/changeset ChangeSet), so
 * they read its state from `this`, and a call on anything else is refused (stateOf). */
const make = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	label: string,
	over: BuiltOver,
	strata: ReadonlyArray<ReadonlyArray<MemberState>>,
	given: ReadonlyArray<ReadBackState>,
	boundParams: ReadonlyMap<string, BoundParam>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const scope = canonicalBindings({ strata, reads: given, bound: boundParams })
	const canonical = Object.freeze(scope.strata)
	const reads = readBackSet(label, scope.reads)
	const bound: ReadonlyMap<string, BoundParam> = scope.bound
	const { desc, inputs } = describe(canonical, reads, bound)
	const state: ChangeSetState = Object.freeze({
		over,
		strata: canonical,
		reads,
		bound,
		values: new Map(
			[...bound].flatMap(([name, param]) =>
				param.kind === "value" ? [[name, param.value] as const] : []
			)
		),
		opaque: [...bound]
			.flatMap(([name, param]) =>
				param.kind === "value" && param.key.kind === "opaque" ? [name] : []
			)
			.toSorted(Order.compareStrings),
		desc,
		inputs
	})
	const value: ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember = {
		...builtMark,
		schema: over.value,
		reads: readsDecoder<Rd>(reads),
		insert(relation, facts) {
			return addMember(stateOf(this, "ChangeSet.insert"), "insert", relation, facts)
		},
		insertAll(rows) {
			return addInserts(stateOf(this, "ChangeSet.insertAll"), rows)
		},
		insertAllComputed(rows, computed) {
			return addInsertsComputed(stateOf(this, "ChangeSet.insertAllComputed"), rows, computed)
		},
		delete(relation, facts) {
			return addMember(stateOf(this, "ChangeSet.delete"), "delete", relation, facts)
		},
		deleteWhere(selections) {
			return addDeletesWhere(stateOf(this, "ChangeSet.deleteWhere"), selections)
		},
		put(relation, facts) {
			return addMember(stateOf(this, "ChangeSet.put"), "put", relation, facts)
		},
		read: (name, readBack) => addRead(state, name, readBack),
		bind: (params) => bindParams(state, params)
	}
	Object.defineProperty(value, "desc", {
		get: () => state.desc,
		enumerable: false,
		configurable: false
	})
	Object.freeze(value)
	states.set(value, state)
	return value
}

/** What a query value was written over, which must be a level of the ChangeSet's. */
const requireLevel = (written: Level, over: BuiltOver, label: string): void => {
	if (!isLevelOver(written, over)) {
		throw malformed(
			label,
			`a query over a level of the ChangeSet's schema ${over.desc.name}; it is written over a schema that is none of its levels`
		)
	}
}

const frozenFact = (fact: unknown): unknown =>
	isPlainRecord(fact) ? Object.freeze({ ...fact }) : fact

/**
 * Whether `facts` is fixed already: frozen, every plain record of it frozen too, as an array decode admitted is (frozen
 * with its rows, program/decode.ts frozen), so nothing of it can change after the ChangeSet holds it.
 */
const fixedFacts = (facts: ReadonlyArray<unknown>): boolean =>
	Object.isFrozen(facts) && facts.every((fact) => !isPlainRecord(fact) || Object.isFrozen(fact))

/**
 * A member's facts as the ChangeSet holds them, fixed from now on: an array fixed already as it is (fixedFacts), shared
 * by reference, so an array decode admitted keeps the reads decode recorded against it for its write
 * (runtime/write/decoded.ts); any other array copied, each plain record a frozen copy of its fields as they are read
 * now.
 */
const heldFacts = (facts: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	fixedFacts(facts) ? facts : Object.freeze(facts.map(frozenFact))

/**
 * The identity digest of a decoded part of a member's Description: a query, or a field-equality member's fields (ir/desc.ts
 * descIdentity), each frozen part it shares with what any ChangeSet, owned schema or navigation read digested once for the
 * process.
 */
const identityOf = (desc: QueryDesc | Readonly<Record<string, EqualedDesc>>): IdentityDigest => {
	const identity = descIdentity(desc)
	if (!identity.ok) {
		throw identity.error
	}
	return identity.value
}

/** The member state of `facts` as a member of `op` into `name` in the last stratum: an array of facts, or a query of
 * the ChangeSet's level; anything else is refused. An array member is made at the slot its stratum alone names. */
const memberState = (
	state: ChangeSetState,
	op: SlotOp,
	name: string,
	loc: SourceLoc,
	facts: MemberInput,
	label: string
): MemberState => {
	const last = state.strata.length - 1
	if (isFactArray(facts)) {
		const slot = arraySlot(last, op, name)
		return {
			kind: "array",
			op,
			relation: name,
			facts: heldFacts(facts),
			slot,
			desc: enumeratedDesc(op, name, slot, keptLoc(loc))
		}
	}
	const built = queryState(facts)
	if (built !== undefined) {
		if (isOrdered(built)) {
			throw malformed(
				label,
				"a member that is a Query, not an Ordered: take(k) closes an ordered query back into a set"
			)
		}
		requireLevel(built.schema.over, state.over, label)
		const query = publicDesc(built, label)
		const identity = identityOf(query)
		return {
			kind: "query",
			op,
			relation: name,
			query,
			identity,
			params: queryParamNames(query),
			desc: queryMemberDesc(op, name, query, keptLoc(loc))
		}
	}
	throw malformed(label, "a member: an array of facts or a query")
}

/** The scope with `member` in its last stratum. The member's parameters are free: a private parameter of that name moves
 * out of its way. */
const scopeWith = (scope: Scope, member: MemberState): Scope => {
	const released = release(scope, isDescribed(member) ? member.params : new Set())
	const last = released.strata.length - 1
	return {
		strata: released.strata.map((s, i) => (i === last ? withMember(s, member) : s)),
		reads: released.reads,
		bound: released.bound
	}
}

const addMember = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	op: SlotOp,
	relation: unknown,
	facts: MemberInput
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = `ChangeSet.${op}`
	const name = memberRelation(relation, state.over, label)
	const member = memberState(state, op, name, captureLoc(`${op} ${name}`, []), facts, label)
	const scope = scopeWith(scopeOf(state), member)
	return make(label, state.over, scope.strata, scope.reads, scope.bound)
}

/** An insert's computed fields on `relation`, its query and its location kept: its state, its identity digest ordering
 * and deduplicating it. */
const computedState = (
	relation: string,
	query: QueryDesc,
	loc: SourceLoc
): Extract<MemberState, { readonly kind: "computed" }> => ({
	kind: "computed",
	op: "insert",
	relation,
	query,
	identity: identityOf(query),
	params: queryParamNames(query),
	desc: Object.freeze({
		op: "insert",
		relation,
		member: Object.freeze({ kind: "computed", query }),
		loc
	})
})

/**
 * The query of an insert's computed fields (ir/desc.ts ComputedSourceDesc), from a JavaScript caller's record of terms,
 * read once: the query of one rule over the ChangeSet's level that matches nothing and finds the record, each term as
 * find admits a head term, so a term holding a variable of another rule is refused there as every captured variable is.
 * A query's head computes its own fields, and a record that names no field computes nothing, which is insertAll's.
 * One query computes every relation's fields the record names (`addInsertsComputed`).
 */
const computedQuery = (
	state: ChangeSetState,
	computed: Readonly<Record<string, unknown>>,
	label: string
): QueryDesc => {
	const fields = recordEntries(computed, label, "a record of computed fields to terms")
	if (fields.length === 0) {
		throw malformed(label, "at least one computed field: insert writes rows that state every field")
	}
	return publicDesc(
		defined(
			queryState(
				queryOver(state.over.value).rule((r: RuleValue) => r.find(Object.fromEntries(fields)))
			),
			"the query of an insert's computed fields"
		),
		label
	)
}

/** A record from a JavaScript caller, read once through hostRead: its own string keys and their values, in its order.
 * A getter or proxy trap that throws, a value that is no plain record, and a symbol key, which no member of the
 * record's would name, refuse it, `what` saying what it is. */
const recordEntries = <V>(
	given: Readonly<Record<string, V>>,
	label: string,
	what: string
): ReadonlyArray<readonly [string, V]> => {
	const read = hostRead(
		() => malformed(label, `${what} whose reading throws nothing`),
		() =>
			isPlainRecord(given) && Object.getOwnPropertySymbols(given).length === 0
				? Result.ok(Object.entries(given))
				: Result.err(malformed(label, `${what}, with no symbol key`))
	)
	if (!read.ok) {
		throw read.error
	}
	return read.value
}

/**
 * A record of members by relation name, read once (`recordEntries`), each key's member as insert adds it, added to the
 * scope by `add` in the record's order, into one ChangeSet made once: insertAll's and insertAllComputed's.
 */
const addRecord = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	rows: Readonly<Record<string, MemberInput>>,
	label: string,
	add: (at: Scope, name: string, member: MemberState, loc: SourceLoc) => Scope
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const scope = recordEntries(rows, label, "a record of members by relation name").reduce<Scope>(
		(at, [key, facts]) => {
			const name = memberRelationNamed(key, state.over, label)
			const loc = captureLoc(`insert ${name}`, [])
			return add(at, name, memberState(state, "insert", name, loc, facts, label), loc)
		},
		scopeOf(state)
	)
	return make(label, state.over, scope.strata, scope.reads, scope.bound)
}

/** insertAll: each key's members inserted as insert inserts them (`addRecord`). */
const addInserts = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	rows: Readonly<Record<string, MemberInput>>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember =>
	addRecord(state, rows, "ChangeSet.insertAll", (at, _name, member) => scopeWith(at, member))

/**
 * insertAllComputed: each key's members inserted as insertAll inserts them (`addRecord`), each an array's, which leaves
 * the computed fields out, beside the computed fields of its stratum's host rows of its relation,
 * every relation computing the one record's query (`computedQuery`), at its member's location.
 */
const addInsertsComputed = <
	S,
	P,
	W extends string,
	Rd,
	Done extends Strata,
	Last extends Stratum,
	A
>(
	state: ChangeSetState,
	rows: Readonly<Record<string, MemberInput>>,
	computed: Readonly<Record<string, unknown>>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.insertAllComputed"
	const query = computedQuery(state, computed, label)
	return addRecord(state, rows, label, (at, name, member, loc) => {
		if (member.kind !== "array") {
			throw malformed(
				label,
				"rows as an array, which leaves the computed fields out: a query's head computes its own fields"
			)
		}
		return scopeWith(scopeWith(at, member), computedState(name, query, keptLoc(loc)))
	})
}

/**
 * What a field-equality member equates one field to, from a JavaScript caller's value: a parameter term, by its name
 * and declared type, or a JavaScript value, a literal whose type the checker reads from the field it meets
 * (schema/literal.ts untypedLiteral, as a head literal's). Any other term, a variable, a scalar term or a typed
 * constant, would read something other than the field's own equality to a value the caller names, and is refused.
 */
const equaledOf = (value: unknown, label: string): EqualedDesc => {
	const expr = termExpr(value)
	if (expr !== undefined) {
		if (expr.kind !== "param") {
			throw malformed(
				label,
				"a parameter (param(name, descriptor)) or a literal: a field-equality member compares each field with a value the caller names, never with a variable or a computed term"
			)
		}
		return Object.freeze({ kind: "param", name: expr.name, type: expr.type })
	}
	if (headValueOf(value) !== undefined) {
		throw malformed(label, "a parameter or a literal, not a head value")
	}
	return Object.freeze({ kind: "literal", value: untypedLiteral(value, label) })
}

/**
 * deleteWhere: under each key a field-equality member, a delete of the facts of the relation the key names whose fields
 * equal what its record equates them to, in the record's order, into one ChangeSet made once. Its fields' names and
 * the relation's are the write front end's to judge, where it knows the member's heading (write/frontend/equal.ts).
 */
const addDeletesWhere = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	selections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.deleteWhere"
	const scope = recordEntries(
		selections,
		label,
		"a record of field equalities by relation name"
	).reduce<Scope>((at, [key, fields]) => {
		const name = memberRelationNamed(key, state.over, label)
		const equaled = Object.freeze(
			Object.fromEntries(
				recordEntries(fields, label, `a record of ${name}'s fields to parameters or literals`).map(
					([field, value]) => [field, equaledOf(value, `${label} ${name}.${field}`)] as const
				)
			)
		)
		return scopeWith(
			at,
			equalState("delete", name, equaled, keptLoc(captureLoc(`delete ${name}`, [])))
		)
	}, scopeOf(state))
	return make(label, state.over, scope.strata, scope.reads, scope.bound)
}

/** The records of the read-backs before it and of this one, under its name: the rows of its query's immediate decoder,
 * every one of them (read inside the write transaction, so a stated "one" reads back as an Option). */
type WithRead<Rd, Name extends string, IHead> = JointReads<
	Rd,
	{ readonly [K in Name]: ReadonlyArray<IHead> }
>

/** read(name, callback): the read-back of the callback's query joins the ChangeSet's set of read-backs, where a
 * read-back of its name over its query may be already, and one of its name over another query refuses it
 * (`readBackSet`). */
const addRead = <
	S,
	P,
	W extends string,
	Rd,
	const Name extends string,
	IHead,
	Done extends Strata,
	Last extends Stratum,
	A
>(
	state: ChangeSetState,
	nameArg: ReadName<Name, Rd, IHead>,
	readBack: (delta: Delta<S>) => Decoders<unknown, IHead>
): ChangeSetOf<S, P, W, WithRead<Rd, Name, IHead>, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.read"
	const name = requireName(nameArg, label, "a read-back name")
	if (!isCallback(readBack)) {
		throw malformed(label, "a read-back: a function from the change's Delta to a query")
	}
	const q = readBack(delta<S>(state.over, schemaInfo(state.over)))
	const built = queryState(q)
	if (built === undefined) {
		throw malformed(label, "a read-back callback that returns a query or an ordered query")
	}
	requireLevel(built.schema.over, state.over, label)
	const query = publicDesc(built, label)
	const immediate: RowDecoder<IHead> = q.immediate
	const params = queryParamNames(query)
	const loc = labeledChildLoc(captureLoc(label, [name]), "query", `read ${name}`)
	const scope = release(scopeOf(state), params)
	const read: ReadBackState = {
		name,
		query,
		identity: identityOf(query),
		params,
		loc,
		desc: Object.freeze({ name, query }),
		field: attachment<IHead, "array">(immediate, "array")
	}
	return make(label, state.over, scope.strata, [...scope.reads, read], scope.bound)
}

/** A value as the ChangeSet owns it: a scalar as it is, and an object as `object` owns it by its canonical reading. */
const owned = <V>(value: V, object: (value: V, read: CanonicalObject | Outside) => V): V => {
	const read = canonicalOf(value)
	return typeof read === "object" ? object(value, read) : value
}

/** A field of a bound fact as the ChangeSet owns it, by its canonical reading: a vector the components it copied. */
const ownedField = (field: unknown, read: CanonicalObject | Outside): unknown => {
	switch (read.kind) {
		case "vector":
			return Vector.branded(read.components)
		case "floatSpecial":
		case "tagged":
		case "array":
		case "record":
		case "outside":
			return field
	}
}

/**
 * A fact of a bound relation's array as the ChangeSet owns it, by its canonical reading: a plain record copied and
 * frozen, each field owned (ownedField); any other value as it is, which no served call holds.
 */
const ownedFact = (fact: unknown, read: CanonicalObject | Outside): unknown => {
	switch (read.kind) {
		case "record":
			return Object.freeze(
				Object.fromEntries(
					Object.entries(read.record).map(([name, field]) => [name, owned(field, ownedField)])
				)
			)
		case "vector":
		case "floatSpecial":
		case "tagged":
		case "array":
		case "outside":
			return fact
	}
}

/**
 * A bound value as the ChangeSet owns it, by its canonical reading (core/canonical.ts canonicalOf): a vector the
 * components its reading copied, -0 held as 0, so a later write to the caller's buffer reaches neither the value's key
 * nor the value a served file holds; an array of facts frozen, each fact owned (ownedFact); and any other value as it
 * is, each immutable or, a Stream and a vector that is not finite, opaque.
 */
const ownedBound = (value: ParamValue, read: CanonicalObject | Outside): ParamValue => {
	switch (read.kind) {
		case "vector":
			return Vector.branded(read.components)
		case "array":
			return Object.freeze(read.items.map((fact) => owned(fact, ownedFact)))
		case "floatSpecial":
		case "tagged":
		case "record":
		case "outside":
			return value
	}
}

/** A JavaScript caller's value, read as unknown: grizzle has no NULL. */
const absent = (value: unknown): boolean => value === undefined || value === null

/** What bind reads of one entry of its caller's map: a parameter's value as the ChangeSet owns it (owned), or a query or
 * a bound query, whose rows a relation parameter is bound to. */
type BindEntry =
	| { readonly kind: "value"; readonly value: ParamValue }
	| { readonly kind: "rows"; readonly value: unknown }

/** The values come from the typed bind, BindArg<S, Params>, each a ParamValue by construction, whose type alone states a
 * bound Stream's channels, or a query or a bound query; a JavaScript caller's argument that is no record, or a NULL
 * value, is refused. The caller's map, and each value in it, is read once through hostRead into the value the
 * ChangeSet owns (owned): a getter or proxy trap that throws refuses it, and nothing after the read runs the caller's
 * code.
 *
 * bind closes the parameters it names; the others stay free, the ChangeSet's to take where it runs. A free name is no
 * private one, so a parameter bound to a value keeps its name until make() makes it canonical. A relation parameter
 * bound to a query or a bound query is closed the same way, a private parameter of the call bound to that query's rows
 * (BoundParam `rows`), every member and read-back that reads it reading it by name, so its rows are one input of the
 * call, evaluated once before this ChangeSet's first stratum, wherever a sequence later places it (ChangeSetDesc
 * `boundRows`, BoundRowsDesc `stratum`); the query's own parameters join the
 * namespace, each private name in their way moved out of it first (release). One the members or read-backs use as a
 * scalar is refused, as a scalar takes one value and rows are any number. */
const bindParams = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	params: Readonly<Record<string, ParamValue | Built>>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.bind"
	const read = hostRead(
		() => malformed(label, "a record of parameter values whose reading throws nothing"),
		() =>
			isPlainRecord(params)
				? Result.ok(
						Object.entries(params).map(([name, value]): readonly [string, BindEntry] => [
							name,
							isBuilt(value)
								? { kind: "rows", value }
								: { kind: "value", value: owned(value, ownedBound) }
						])
					)
				: Result.err(malformed(label, "a record of parameter values"))
	)
	if (!read.ok) {
		throw read.error
	}
	const free = freeParams(scopeOf(state))
	const scalars = scalarParams(state)
	const closed = new Map<string, BoundParam>()
	const levels: [Level, ...Array<Level>] = [state.over]
	for (const [name, entry] of read.value) {
		if (!free.has(name)) {
			throw malformed(
				label,
				`a value only for a free parameter of the ChangeSet; ${JSON.stringify(name)} is none of them`
			)
		}
		if (entry.kind === "rows") {
			if (!isRowsValue(entry.value)) {
				throw malformed(
					`${label} ${name}`,
					"a parameter's value, or a query or a bound query of a relation parameter's rows"
				)
			}
			if (scalars.has(name)) {
				throw builderRefusal(
					`${label} ${name}`,
					"a query binds a relation parameter, whose rows are any number; a scalar parameter takes one value"
				)
			}
			const query = boundRows(entry.value, `${label} ${name}`)
			closed.set(name, { kind: "rows", origin: name, stratum: 0, rows: query.rows })
			levels.push(query.over)
		} else if (absent(entry.value)) {
			throw malformed(label, `a value for ${name}: grizzle has no NULL`)
		} else {
			closed.set(name, {
				kind: "value",
				origin: name,
				value: entry.value,
				key: boundKey(entry.value)
			})
		}
	}
	const top = highestLevel(levels)
	if (top === undefined) {
		throw builderRefusal(
			label,
			"a relation parameter binds a query over a level of the schema it is bound in, or over a schema that schema is a level of"
		)
	}
	/** The parameters the bound queries bring join the namespace: one of the name of a private parameter bound to a
	 * value is that parameter; a private parameter bound to rows moves out of their way, so a parameter a later query
	 * brings is never an earlier input, and the inputs read one another only forward (`rowsKeys`). */
	const brought = new Set(
		[...closed.values()].flatMap((param) =>
			param.kind === "rows"
				? [...rowsParamNames(param.rows)].filter((p) => state.bound.get(p)?.kind === "rows")
				: []
		)
	)
	const scope = release(scopeOf(state), brought)
	return make(
		label,
		top === state.over
			? state.over
			: defined(builtOverOf(top.value), "a query is written over a schema or a role"),
		scope.strata,
		scope.reads,
		new Map([...scope.bound, ...closed])
	)
}

/** The parameters a ChangeSet's members, read-backs and bound rows use as scalars (scalarParamNames), which no query
 * binds. */
const scalarParams = (state: ChangeSetState): ReadonlySet<string> => {
	const out = new Set<string>()
	const add = (names: ReadonlySet<string>) => {
		for (const name of names) {
			out.add(name)
		}
	}
	for (const m of state.strata.flat()) {
		if (m.kind === "query" || m.kind === "computed") {
			add(scalarParamNames(m.query))
		} else if (m.kind === "equal") {
			add(m.params)
		}
	}
	for (const r of state.reads) {
		add(scalarParamNames(r.query))
	}
	for (const [name, param] of state.bound) {
		if (param.kind === "rows") {
			add(scalarParamNames(boundRowsQuery(name, param.rows, boundRowsLoc(name))))
		}
	}
	return out
}

/**
 * The rows a relation parameter of a ChangeSet is bound to (ChangeSet.bind): a bound query's own bind map, or a query's
 * own parameters passed through under their names (ir/desc.ts passedThrough), each joining the ChangeSet's one
 * namespace, where one name is one parameter and its uses agree; and the level it is written over.
 */
const boundRows = (
	value: unknown,
	label: string
): { readonly rows: RowsDesc; readonly over: Level } => {
	const { info, rows } = rowsSource(value, label, bareEnv)
	if (info.scope.kind !== "written") {
		throw malformed(label, "a query or a bound query written over a schema")
	}
	if (queryState(value) === undefined) {
		/** A ChangeSet's bind is in no rule, so a bound query it takes binds no rule's variable. */
		const outside = (): never => {
			throw malformed(label, "a bound query whose bind map reads no rule's variable")
		}
		return {
			rows: spellRows(rows, { var: outside, parent: outside, interior: outside }),
			over: info.scope.over
		}
	}
	const through = passedThrough(rows.query)
	if (through.kind === "untyped") {
		throw malformed(
			label,
			`a bound query, Q.bind({ ... }), for a query whose take is parameter ${through.param}: no use of it states its type`
		)
	}
	return { rows: { kind: "rows", query: rows.query, bind: through.bind }, over: info.scope.over }
}

const stateOf = (value: unknown, label: string): ChangeSetState => {
	const state = changeSetState(value)
	if (state === undefined) {
		throw malformed(label, "a ChangeSet built by ChangeSet.empty(S)")
	}
	return state
}

/** A JavaScript caller's ChangeSet, refused when it is none. */
const changeSetArgument = (value: unknown, label: string): ChangeSetValue => {
	if (!isChangeSetValue(value)) {
		throw malformed(label, "a ChangeSet built by ChangeSet.empty(S)")
	}
	return value
}

/** The higher of two states' levels (schema/level.ts highestLevel): `ChangeSet.union` and `sequence` are over the higher
 * of their arguments' schemas, and schemas of which neither is a level of the other do not combine. The relations a
 * ChangeSet may write are the ordinary relations of every level (`WritableOf`). */
const higher = (label: string, a: BuiltOver, b: BuiltOver): BuiltOver => {
	const top = highestLevel([a, b])
	if (top === undefined) {
		throw malformed(
			label,
			"ChangeSets over levels of one schema; neither schema is a level of the other"
		)
	}
	return top
}

/** ChangeSet.empty(S). */
const emptyOf = <S, Done extends Strata, Last extends Stratum>(
	schema: unknown,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, unknown, never, unknown, never, Done, Last> & SchemaMember => {
	if (extra.length > 0) {
		throw malformed("ChangeSet.empty", "ChangeSet.empty(schema): one argument")
	}
	const over = builtOverOf(schema)
	if (over === undefined) {
		throw malformed(
			"ChangeSet.empty",
			"a schema built by schema(...) or schema.extend(...), a fragment built by fragment(...), or a role built by role(...)"
		)
	}
	return make<S, unknown, never, unknown, Done, Last, unknown>(
		"ChangeSet.empty",
		over,
		[[]],
		[],
		new Map<string, BoundParam>()
	)
}

/** The states of two ChangeSets combined, each one's private parameters renamed out of the other's way (`combine`), a
 * refusal of more arguments, and the higher of their schemas. The second's strata start at the stratum `start` reads off
 * the first, its bindings to rows with them (`placedAt`): union's at the first's first stratum, sequence's after its
 * last. */
const combined = (
	label: string,
	a: unknown,
	b: unknown,
	extra: ReadonlyArray<unknown>,
	start: (first: ChangeSetState) => number
): {
	readonly top: BuiltOver
	readonly x: Scope
	readonly y: Scope
	readonly bound: ReadonlyMap<string, BoundParam>
} => {
	if (extra.length > 0) {
		throw malformed(label, `${label}(a, b): two arguments`)
	}
	const first = stateOf(a, label)
	const second = stateOf(b, label)
	const top = higher(label, first.over, second.over)
	const { a: x, b: y, bound } = combine(scopeOf(first), placedAt(scopeOf(second), start(first)))
	return { top, x, y, bound }
}

/** A scope whose strata start at stratum `start` of a combination: each binding to rows evaluated before the stratum
 * its part's first stratum becomes there, `start` strata later (BoundRowsDesc `stratum`). */
const placedAt = (scope: Scope, start: number): Scope => ({
	...scope,
	bound: new Map(
		[...scope.bound].map(([name, param]) => [
			name,
			param.kind === "rows" ? { ...param, stratum: param.stratum + start } : param
		])
	)
})

/** ChangeSet.union(a, b): the commutative combination, strata position by position, and one set of their read-backs. */
const unionOf = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	label: "ChangeSet.union" | "ChangeSet.over",
	a: unknown,
	b: unknown,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const { top, x, y, bound } = combined(label, a, b, extra, () => 0)
	const n = Math.max(x.strata.length, y.strata.length)
	const strata = canonicalStrata(
		indices(n).map((i) => [...(x.strata[i] ?? []), ...(y.strata[i] ?? [])])
	)
	return make(label, top, strata, [...x.reads, ...y.reads], bound)
}

/**
 * ChangeSet.over(role, cs): `cs` taken over `role`, the empty ChangeSet over the role unioned with it (`unionOf`), so its
 * strata, parameters and read-backs are `cs`'s and the role is the higher of the two: refused where `role` is no role,
 * or `cs`'s schema none of its levels (schema/level.ts isLevelOver), as its type refuses it (types/changeset OverCheck).
 */
const overOf = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	role: unknown,
	cs: unknown,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.over"
	const level = builtOverOf(role)
	if (level?.kind !== "role") {
		throw malformed(label, "a role built by role(...)")
	}
	if (!isLevelOver(stateOf(cs, label).over, level)) {
		throw builderRefusal(label, "ChangeSet.over takes a ChangeSet over a level of its role")
	}
	return unionOf(label, emptyOf(role, []), cs, extra)
}

/** ChangeSet.sequence(a, b): b evaluated against the state a produced, its strata after a's, its bindings to rows with
 * them, each evaluated before b's first stratum, after a's writes, and one set of their read-backs, each read after the
 * last stratum. */
const sequenceOf = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	a: unknown,
	b: unknown,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.sequence"
	const { top, x, y, bound } = combined(label, a, b, extra, (first) => first.strata.length)
	return make(
		label,
		top,
		canonicalStrata([...x.strata, ...y.strata]),
		[...x.reads, ...y.reads],
		bound
	)
}

/** The constructor namespace, the public value itself: each constructor implemented under its
 * ChangeSetConstructor signature, over the schema and the ChangeSets its arguments are (ChangeSetConstructor in
 *). */
const constructors: ChangeSetConstructor = {
	empty: (schema, ...extra: ReadonlyArray<unknown>) => emptyOf(schema, extra),
	union: (a, b, ...extra: ReadonlyArray<unknown>) => unionOf("ChangeSet.union", a, b, extra),
	over: (role, cs, ...extra: ReadonlyArray<unknown>) => overOf(role, cs, extra),
	sequence: (a, b, ...extra: ReadonlyArray<unknown>) => sequenceOf(a, b, extra)
}
export const changeSets: ChangeSetConstructor = Object.freeze(constructors)

/** The constructors for a JavaScript caller, whose schema and ChangeSets are known only at run time: the same values,
 * under the view (ChangeSetValue). */
interface ChangeSetOver {
	empty(schema: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
	union(a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
	over(role: unknown, cs: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
	sequence(a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
}

const over: ChangeSetOver = {
	empty: (schema, ...extra) => emptyOf(schema, extra),
	union: (a, b, ...extra) =>
		unionOf(
			"ChangeSet.union",
			changeSetArgument(a, "ChangeSet.union"),
			changeSetArgument(b, "ChangeSet.union"),
			extra
		),
	over: (role, cs, ...extra) => overOf(role, changeSetArgument(cs, "ChangeSet.over"), extra),
	sequence: (a, b, ...extra) =>
		sequenceOf(
			changeSetArgument(a, "ChangeSet.sequence"),
			changeSetArgument(b, "ChangeSet.sequence"),
			extra
		)
}
export const changeSetOver: ChangeSetOver = Object.freeze(over)
