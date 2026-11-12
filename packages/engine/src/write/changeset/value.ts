import type { Stream } from "effect"
import { indices } from "#compiler/core/array.ts"
import {
	type CanonicalObject,
	type CanonicalToken,
	canonicalOf,
	canonicalTokens,
	compareCanonicalTokens,
	everyProperty,
	type Outside
} from "#compiler/core/canonical.ts"
import { attachment, merge, type RecordField, type RowDecoder } from "#compiler/core/decoder.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defined } from "#compiler/core/invariant.ts"
import { captureLoc, labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Order from "#compiler/core/order.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	type ChangeSetDesc,
	decodeDesc,
	descText,
	type MemberDesc,
	type QueryDesc,
	queryParamNames,
	type ReadBackDesc,
	renameQueryParams
} from "#compiler/ir/desc.ts"
import * as S from "#compiler/ir/shape.ts"
import { inReservedSpace, slotSpelling } from "#compiler/ir/slots.ts"
import { schemaInfo } from "#compiler/query/build/heading.ts"
import { isCallback } from "#compiler/query/build/scope.ts"
import { isOrdered, publicDesc, queryState } from "#compiler/query/build/state.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { isLevelOver, type Level } from "#compiler/schema/level.ts"
import { malformed, orThrow, requireName } from "#compiler/schema/protocol.ts"
import { named, record } from "#compiler/schema/record.ts"
import type {
	ChangeSetConstructor,
	ChangeSet as ChangeSetOf,
	Delta,
	ReadName,
	Strata,
	Stratum
} from "#compiler/types/changeset/changeset.ts"
import type { ParamMap, ParamValue, Simplify } from "#compiler/types/core/phantom.ts"
import type { Decoders, OrderedBase, QueryBase } from "#compiler/types/query/query.ts"
import {
	type BuiltOver,
	builtOverOf,
	higherOver,
	overName
} from "#compiler/write/changeset/levels.ts"
import { delta, memberRelation, memberRelationNamed } from "#compiler/write/delta/source.ts"

export type MemberOp = MemberDesc["op"]

/**
 * One member as the value holds it, with its Description, `desc`, which the ChangeSet's Description holds as it is:
 * built from parts already decoded when the member is made, and again only when a rename changes its query or its
 * stratum or Stream position changes its slot.
 */
type MemberState =
	| {
			readonly kind: "array"
			readonly op: MemberOp
			readonly relation: string
			readonly facts: ReadonlyArray<unknown>
			/** The input its facts travel as (`arraySlot`). */
			readonly slot: string
			readonly desc: MemberDesc
	  }
	| {
			readonly kind: "stream"
			readonly op: MemberOp
			readonly relation: string
			readonly stream: Stream.Stream<unknown>
			/** The input it travels as (`streamSlot`). */
			readonly slot: string
			readonly desc: MemberDesc
	  }
	| {
			readonly kind: "query"
			readonly op: MemberOp
			readonly relation: string
			readonly query: QueryDesc
			/** The canonical identity text of the query, which orders and deduplicates query members. */
			readonly text: string
			readonly params: ReadonlySet<string>
			readonly desc: MemberDesc
	  }

/** A read-back as the value holds it, with its Description, which the ChangeSet's Description holds as it is. */
interface ReadBackState {
	readonly name: string
	readonly query: QueryDesc
	readonly params: ReadonlySet<string>
	readonly loc: SourceLoc
	readonly desc: ReadBackDesc
}

/**
 * What tells two values bound under one name apart: the value's canonical tokens (core/canonical.ts canonicalTokens),
 * read once when bind takes it, its canonical text's tokens and never that text, so a value whose texts sum past the
 * longest string is keyed as any other; or opaque for a value that has none, a Stream or a vector with a component
 * that is not finite, which is equal to no other value and has no canonical order.
 */
type BoundKey =
	| { readonly kind: "tokens"; readonly tokens: ReadonlyArray<CanonicalToken> }
	| { readonly kind: "opaque" }

/** A parameter bind closed: the name it had when bound, its value, and the value's key. */
interface BoundParam {
	readonly origin: string
	readonly value: ParamValue
	readonly key: BoundKey
}

/** The key of a bound value (`BoundKey`). */
const boundKey = (value: ParamValue): BoundKey => {
	const tokens = canonicalTokens(value, everyProperty)
	return tokens.ok ? { kind: "tokens", tokens: tokens.value } : { kind: "opaque" }
}

/** Private parameters by origin, then by key: every canonical text in code-unit order (compareCanonicalTokens), then
 * the opaque ones as the sort found them. */
const boundOrder: Order.Comparator<BoundParam> = Order.combineAll([
	Order.mapInput(Order.compareStrings, (p: BoundParam) => p.origin),
	(a: BoundParam, b: BoundParam) =>
		a.key.kind === "tokens" && b.key.kind === "tokens"
			? compareCanonicalTokens(a.key.tokens, b.key.tokens)
			: Order.compareNumbers(a.key.kind === "tokens" ? 0 : 1, b.key.kind === "tokens" ? 0 : 1)
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
	/** The array and Stream inputs, by the slot their member's Description names. */
	readonly inputs: ReadonlyMap<string, ChangeSetInput>
}

/** The host input of one array or Stream member, by slot. */
export type ChangeSetInput =
	| { readonly kind: "array"; readonly facts: ReadonlyArray<unknown> }
	| { readonly kind: "stream"; readonly stream: Stream.Stream<unknown> }

/** A member argument: an array of facts, a Stream of facts with no error or requirement channel, or a
 * query value; an ordered value is refused with its own diagnostic. A Stream's channels are types no run-time check
 * can see, so a Stream member is admitted only at this type. A JavaScript caller passing anything else is refused. */
export type MemberInput = ReadonlyArray<unknown> | Stream.Stream<unknown> | QueryBase | OrderedBase

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
 * non-enumerable `desc`, and holds the host inputs its array and Stream members carry, outside the Description and
 * outside template identity:
 *
 * - Canonical. Within a stratum the array members of one operation on one relation are one member, their facts
 *   concatenated (the codec deduplicates them); query members are deduplicated by their canonical
 *   Description; Stream members keep their order. Members are sorted by relation, operation and kind, so a ChangeSet
 *   built in any order of its members has one Description, and each array or Stream member's slot is named by its
 *   canonical position, `member[stratum,op,relation]` and `member[stratum,op,relation,k]` for the k-th Stream.
 * - Sealed. Every value is frozen; the facts of an array member are copied and frozen when the member is added, so a
 *   caller mutating its array afterwards changes nothing.
 * - Strata. insert, delete and put add to the last stratum; union combines strata position by position, and sequence
 *   concatenates them. An empty stratum is kept, because union aligns strata by position.
 * - Levels. A ChangeSet is built over a schema or a role (`BuiltOver`). Members and read-backs may be written
 *   over any level of it, a full role's base among a role's; union and sequence are over the highest of their
 *   arguments' schemas and refuse schemas of which neither is a level of the other. A ChangeSet over a role writes the
 *   role's relations: its whole ordinary entries and its query entries (`writableRelation`).
 * - Read-backs. read(name, callback) calls the callback once with a Delta; its query or ordered
 *   query is the read-back. Read-back names are distinct across the whole ChangeSet, strata and unions included. The
 *   value carries `reads`, the decoder of the outcome's record of read-backs: under each name an attachment of the
 *   read-back query's immediate decoder delivering every row (`record` over named parts), merged with
 *   the decoders of the read-backs before it, and of the ChangeSets union and sequence combine.
 * - Parameters. A ChangeSet's free parameters are one namespace, the union of its members' and read-backs'
 *   parameters. bind closes every one of them with a value, hygienically, as Query.bind closes an import's:
 *   a bound parameter leaves the namespace. Its uses keep a name of their own, private to
 *   the ChangeSet, which the Description lists under `bindings` and by which its value travels beside the
 *   Description. A member or read-back added later, or a ChangeSet combined with this one, whose parameter has the
 *   bound name needs a separate, free parameter, so the private names are renamed out of its way first (release), and
 *   two ChangeSets that bind one name to different values combine into two private parameters. Private parameters of
 *   one name bound to equal values are one parameter, and a private name is canonical (canonicalBindings): named in
 *   the order of the names they were bound under and then of their values' canonical texts, each its own name when no
 *   free parameter and no private one named before it has it, otherwise that name, `#` and the least index that is
 *   free. So the names, and with them the Description, follow from the values and never from the order the members
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
	delete(relation: unknown, facts: MemberInput): ChangeSetValue
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

/** A Stream argument, by the identifier every Stream value carries (Effect's `Stream.TypeId`, which `Stream.isStream`
 * tests), read without loading Effect. Its channels are types no run-time check can see (`MemberInput`). */
const isStreamInput = (value: MemberInput): value is Stream.Stream<unknown> => {
	/** A JavaScript caller can pass anything, null included, so the identifier is looked for on the unknown value. */
	const given: unknown = value
	return (
		((typeof given === "object" && given !== null) || typeof given === "function") &&
		"~effect/Stream" in given
	)
}

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
 * Description, the host inputs of its array and Stream members by the slot their member names, and the values bind
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

const kindRank: Readonly<Record<MemberState["kind"], number>> = { array: 0, stream: 1, query: 2 }

/** The group of a member: its op and relation. An op is a word without a colon, so the first colon ends it. */
const groupKey = (m: MemberState): string => `${m.op}:${m.relation}`

/** The order of a canonical stratum's members: by relation, operation and kind, then a query member by its text. */
const memberOrder: Order.Comparator<MemberState> = Order.combineAll([
	Order.mapInput(Order.compareStrings, (m: MemberState) => m.relation),
	Order.mapInput(Order.compareStrings, (m: MemberState) => m.op),
	Order.mapInput(Order.compareNumbers, (m: MemberState) => kindRank[m.kind]),
	(a: MemberState, b: MemberState) =>
		a.kind === "query" && b.kind === "query" ? Order.compareStrings(a.text, b.text) : 0
])

/** The canonical form of one stratum's members (see `ChangeSetValue`).
 *
 * A stable sort: Streams of one group keep their order. */
const canonicalStratum = (members: ReadonlyArray<MemberState>): ReadonlyArray<MemberState> => {
	const arrays = new Map<string, Extract<MemberState, { kind: "array" }>>()
	/** Equal query members are one: the first of each operation, relation and text. */
	const queries: Array<Extract<MemberState, { kind: "query" }>> = []
	const texts = new Map<string, Set<string>>()
	const streams: Array<MemberState> = []
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
			case "stream":
				streams.push(m)
				break
			case "query": {
				const seen = texts.get(group) ?? new Set<string>()
				texts.set(group, seen)
				if (!seen.has(m.text)) {
					seen.add(m.text)
					queries.push(m)
				}
			}
		}
	}
	return Object.freeze([...arrays.values(), ...streams, ...queries].toSorted(memberOrder))
}

/**
 * The `s`-th canonical stratum with one member more, canonical again, as canonicalStratum would make it: the member
 * after every member that sorts with or before it, which merges an array member into its group's, keeps a query member
 * equal to one before it out, and places a Stream after its group's earlier Streams, at their count.
 */
const withMember = (
	stratum: ReadonlyArray<MemberState>,
	s: number,
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
	if (sameGroup && before.kind === "query" && m.kind === "query" && before.text === m.text) {
		return stratum
	}
	let earlier = 0
	for (let at = low - 1; m.kind === "stream" && at >= 0; at--) {
		const other = defined(stratum[at], "a member of the stratum")
		if (other.kind !== "stream" || groupKey(other) !== groupKey(m)) {
			break
		}
		earlier++
	}
	const member = m.kind === "stream" ? atSlot(m, streamSlot(s, m.op, m.relation, earlier)) : m
	return Object.freeze(stratum.toSpliced(low, 0, member))
}

/** The slot of a stratum's array members of one op and relation, which are one input (`EnumeratedInput` spells
 * it). */
export const arraySlot = (stratum: number, op: MemberOp, relation: string): string =>
	slotSpelling("member", stratum, op, "array", relation)

/** The slot of the `stream`-th Stream member of one op and relation in a stratum: each Stream is its own input. */
export const streamSlot = (
	stratum: number,
	op: MemberOp,
	relation: string,
	stream: number
): string => slotSpelling("member", stratum, op, `stream${stream}`, relation)

/** A source location as a Description keeps it (shape.ts sourceLoc): frozen, so a Description holding it is. */
const keptLoc = (loc: SourceLoc): SourceLoc =>
	orThrow(S.decodeWith(S.sourceLoc, loc, "ChangeSet member location"))

/** The Description of an array or Stream member at `slot`, its location kept. */
const enumeratedDesc = (
	kind: "array" | "stream",
	op: MemberOp,
	relation: string,
	slot: string,
	loc: SourceLoc
): MemberDesc => Object.freeze({ op, relation, member: Object.freeze({ kind, slot }), loc })

/** The Description of a query member, its query a decoded Description and its location kept. */
const queryMemberDesc = (
	op: MemberOp,
	relation: string,
	query: QueryDesc,
	loc: SourceLoc
): MemberDesc =>
	Object.freeze({ op, relation, member: Object.freeze({ kind: "query", query }), loc })

/** An array or Stream member at `slot`: itself when it is there already. */
const atSlot = <M extends Extract<MemberState, { readonly kind: "array" | "stream" }>>(
	m: M,
	slot: string
): M =>
	m.slot === slot
		? m
		: { ...m, slot, desc: enumeratedDesc(m.kind, m.op, m.relation, slot, m.desc.loc) }

/**
 * The members of the `s`-th canonical stratum, each at the slot its place names: an array member at its op's and
 * relation's, the k-th Stream of an op and relation at its k.
 */
const placed = (members: ReadonlyArray<MemberState>, s: number): ReadonlyArray<MemberState> => {
	const streamCount = new Map<string, number>()
	return Object.freeze(
		members.map((m): MemberState => {
			if (m.kind === "array") {
				return atSlot(m, arraySlot(s, m.op, m.relation))
			}
			if (m.kind === "query") {
				return m
			}
			const group = groupKey(m)
			const k = streamCount.get(group) ?? 0
			streamCount.set(group, k + 1)
			return atSlot(m, streamSlot(s, m.op, m.relation, k))
		})
	)
}

/** Strata canonical and placed, each stratum's members at the slots their places name. */
const canonicalStrata = (
	strata: ReadonlyArray<ReadonlyArray<MemberState>>
): ReadonlyArray<ReadonlyArray<MemberState>> =>
	Object.freeze(strata.map((members, s) => placed(canonicalStratum(members), s)))

/**
 * The Description and the inputs of a state's placed strata and read-backs: its members' and read-backs' own
 * Descriptions, which are decoded parts and parts this module minted (an op, a relation the ChangeSet's schema
 * declares, a slot, a kept location), so the Description is what its decoder would give and none of it is read again.
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
			inputs.set(m.slot, Object.freeze({ kind: "array", facts: m.facts }))
		} else if (m.kind === "stream") {
			inputs.set(m.slot, Object.freeze({ kind: "stream", stream: m.stream }))
		}
	}
	const desc: ChangeSetDesc = Object.freeze({
		strata: Object.freeze(
			strata.map((members) => Object.freeze({ members: Object.freeze(members.map((m) => m.desc)) }))
		),
		reads: Object.freeze(
			reads
				.toSorted(Order.mapInput(Order.compareStrings, (r: ReadBackState) => r.name))
				.map((r) => r.desc)
		),
		bindings: Object.freeze([...bound.keys()].toSorted(Order.compareStrings))
	})
	if ([...usedParams({ strata, reads })].some(inReservedSpace)) {
		orThrow(decodeDesc("changeSet", desc))
	}
	return { desc, inputs }
}

/** The part of a state that holds parameters. */
type Scope = Pick<ChangeSetState, "strata" | "reads" | "bound">

/** Every parameter name the members and read-backs use, free or private, in canonical walk order. */
const usedParams = (scope: Pick<Scope, "strata" | "reads">): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const p of scope.strata.flatMap((stratum) =>
		stratum.flatMap((m) => (m.kind === "query" ? [...m.params] : []))
	)) {
		out.add(p)
	}
	for (const r of scope.reads) {
		for (const p of r.params) {
			out.add(p)
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

/** A query with the parameters `rename` maps renamed, decoded as a Description holds it. */
const renamedQuery = (query: QueryDesc, rename: ReadonlyMap<string, string>): QueryDesc =>
	orThrow(decodeDesc("query", renameQueryParams(query, rename)))

const renameMember = (m: MemberState, rename: ReadonlyMap<string, string>): MemberState => {
	if (m.kind !== "query" || ![...m.params].some((p) => rename.has(p))) {
		return m
	}
	const query = renamedQuery(m.query, rename)
	return {
		...m,
		query,
		text: identityText(query),
		params: queryParamNames(query),
		desc: queryMemberDesc(m.op, m.relation, query, m.desc.loc)
	}
}

const renameRead = (r: ReadBackState, rename: ReadonlyMap<string, string>): ReadBackState => {
	if (![...r.params].some((p) => rename.has(p))) {
		return r
	}
	const query = renamedQuery(r.query, rename)
	return {
		...r,
		query,
		params: queryParamNames(query),
		desc: Object.freeze({ name: r.name, query })
	}
}

/** The scope with its uses of the names `rename` maps renamed, and its private parameters with them. The images are
 * distinct and none is a name of the scope `rename` leaves in place. */
const renameScope = (scope: Scope, rename: ReadonlyMap<string, string>): Scope => {
	if (rename.size === 0) {
		return scope
	}
	const bound = new Map<string, BoundParam>()
	for (const [name, param] of scope.bound) {
		bound.set(rename.get(name) ?? name, param)
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

/** Two scopes combined: each one's private parameters renamed out of the other's names, then their bindings joined. The
 * free parameters of the two stay one namespace. */
const combine = (
	a: Scope,
	b: Scope
): { readonly a: Scope; readonly b: Scope; readonly bound: Map<string, BoundParam> } => {
	const names = (x: Scope) => new Set([...usedParams(x), ...x.bound.keys()])
	const left = release(a, names(b))
	const right = release(b, names(left))
	return { a: left, b: right, bound: new Map([...left.bound, ...right.bound]) }
}

/**
 * The canonical private names of a scope (see `ChangeSetValue`): private parameters of one origin and one key merged
 * (`BoundKey`), then each named in turn in the order of their origins and keys (`boundOrder`), its origin when no free
 * parameter and no private one named before it has that name, otherwise the origin, `#` and the least index that is
 * free. The names follow from the free parameters and the bound values alone, never from the order the members were
 * built or combined in; only private parameters of one origin bound to opaque values keep the order the scope holds
 * them in.
 */
const canonicalBindings = (scope: Scope): Scope => {
	if (scope.bound.size === 0) {
		return scope
	}
	const merges = new Map<string, string>()
	const kept = new Map<string, BoundParam>()
	/** The kept private parameter of each origin and key, by name. */
	const keyed = new Map<string, TupleMap<ReadonlyArray<CanonicalToken>, string>>()
	for (const [name, param] of scope.bound) {
		if (param.key.kind === "opaque") {
			kept.set(name, param)
			continue
		}
		const keys = keyed.get(param.origin) ?? new TupleMap<ReadonlyArray<CanonicalToken>, string>()
		keyed.set(param.origin, keys)
		const same = keys.get(param.key.tokens)
		if (same === undefined) {
			keys.set(param.key.tokens, name)
			kept.set(name, param)
		} else {
			merges.set(name, same)
		}
	}
	const merged = renameScope({ strata: scope.strata, reads: scope.reads, bound: kept }, merges)
	const taken = new Set(freeParams(merged))
	const canonical = new Map<string, string>()
	for (const [name, param] of [...merged.bound].toSorted(
		Order.mapInput(boundOrder, ([, p]: readonly [string, BoundParam]) => p)
	)) {
		const image = freshName(param.origin, taken)
		taken.add(image)
		if (image !== name) {
			canonical.set(name, image)
		}
	}
	return renameScope(merged, canonical)
}

const distinctReads = (
	label: string,
	reads: ReadonlyArray<ReadBackState>
): ReadonlyArray<ReadBackState> => {
	const names = new Set<string>()
	for (const r of reads) {
		if (names.has(r.name)) {
			throw malformed(label, `distinct read-back names; ${JSON.stringify(r.name)} repeats`)
		}
		names.add(r.name)
	}
	return reads
}

/** The ChangeSet value of a state and its read-backs' decoder, built under its public type ChangeSet<S, P, W, Rd>,
 * which the literal is checked against. The schema, parameters and writes are phantoms no runtime value holds, and the
 * value holds the brand and the decoder. Each member is implemented under its contextual signature:
 * its result is the value of the state it makes, whose phantoms are the ones the signature names (each builder below
 * takes them from its contextual result type), and whose decoder is this one, or for read this one merged with the new
 * read-back's. */
const make = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	over: BuiltOver,
	strata: ReadonlyArray<ReadonlyArray<MemberState>>,
	reads: ReadonlyArray<ReadBackState>,
	boundParams: ReadonlyMap<string, BoundParam>,
	decoder: RowDecoder<Rd>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const scope = canonicalBindings({ strata, reads, bound: boundParams })
	const canonical = Object.freeze(scope.strata)
	const bound: ReadonlyMap<string, BoundParam> = scope.bound
	const { desc, inputs } = describe(canonical, scope.reads, bound)
	const state: ChangeSetState = Object.freeze({
		over,
		strata: canonical,
		reads: Object.freeze([...scope.reads]),
		bound,
		values: new Map([...bound].map(([name, param]) => [name, param.value])),
		opaque: [...bound]
			.flatMap(([name, param]) => (param.key.kind === "opaque" ? [name] : []))
			.toSorted(Order.compareStrings),
		desc,
		inputs
	})
	const value: ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember = {
		...builtMark,
		schema: over.value,
		reads: decoder,
		insert: (relation, facts) => addMember(state, decoder, "insert", relation, facts),
		insertAll: (rows) => addInserts(state, decoder, rows),
		delete: (relation, facts) => addMember(state, decoder, "delete", relation, facts),
		put: (relation, facts) => addMember(state, decoder, "put", relation, facts),
		read: (name, readBack) => addRead(state, decoder, name, readBack),
		bind: (params) => bindParams(state, decoder, params)
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
			`a query over a level of the ChangeSet's schema ${overName(over)}; it is written over a schema that is none of its levels`
		)
	}
}

const frozenFact = (fact: unknown): unknown =>
	isPlainRecord(fact) ? Object.freeze({ ...fact }) : fact

const identityText = (desc: QueryDesc): string => {
	const text = descText(desc)
	if (!text.ok) {
		throw text.error
	}
	return text.value
}

/** The member state of `facts` as a member of `op` into `name` in the last stratum: an array of facts, a Stream of
 * facts, or a query of the ChangeSet's level; anything else is refused. An array or Stream member is made at the slot
 * its stratum alone names, its Stream position among the stratum's (`placed`) set when the ChangeSet is made. */
const memberState = (
	state: ChangeSetState,
	op: MemberOp,
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
			facts: Object.freeze(facts.map(frozenFact)),
			slot,
			desc: enumeratedDesc("array", op, name, slot, keptLoc(loc))
		}
	}
	if (isStreamInput(facts)) {
		const slot = streamSlot(last, op, name, 0)
		return {
			kind: "stream",
			op,
			relation: name,
			stream: facts,
			slot,
			desc: enumeratedDesc("stream", op, name, slot, keptLoc(loc))
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
		const text = identityText(query)
		return {
			kind: "query",
			op,
			relation: name,
			query,
			text,
			params: queryParamNames(query),
			desc: queryMemberDesc(op, name, query, keptLoc(loc))
		}
	}
	throw malformed(label, "a member: an array of facts, a Stream of facts, or a query")
}

/** The scope with `member` in its last stratum. The member's parameters are free: a private parameter of that name moves
 * out of its way. */
const scopeWith = (scope: Scope, member: MemberState): Scope => {
	const released = release(scope, member.kind === "query" ? member.params : new Set())
	const last = released.strata.length - 1
	return {
		strata: released.strata.map((s, i) => (i === last ? withMember(s, i, member) : s)),
		reads: released.reads,
		bound: released.bound
	}
}

const addMember = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	op: MemberOp,
	relation: unknown,
	facts: MemberInput
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = `ChangeSet.${op}`
	const name = memberRelation(relation, state.over, label)
	const member = memberState(state, op, name, captureLoc(`${op} ${name}`, []), facts, label)
	const scope = scopeWith(state, member)
	return make(state.over, scope.strata, scope.reads, scope.bound, decoder)
}

/** The record from a JavaScript caller, read once through hostRead: its own string keys and their members, in its
 * order. A getter or proxy trap that throws, a value that is no plain record, and a symbol key, which no insert of the
 * record's would write, refuse it. */
const insertRows = (
	rows: Readonly<Record<string, MemberInput>>,
	label: string
): ReadonlyArray<readonly [string, MemberInput]> => {
	const read = hostRead(
		() => malformed(label, "a record of members by relation name whose reading throws nothing"),
		() =>
			isPlainRecord(rows) && Object.getOwnPropertySymbols(rows).length === 0
				? Result.ok(Object.entries(rows))
				: Result.err(malformed(label, "a record of members by relation name, with no symbol key"))
	)
	if (!read.ok) {
		throw read.error
	}
	return read.value
}

/** insertAll: each key's members inserted as insert inserts them, in the record's order, into one ChangeSet made once. */
const addInserts = <S, P, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	rows: Readonly<Record<string, MemberInput>>
): ChangeSetOf<S, P, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.insertAll"
	const scope = insertRows(rows, label).reduce<Scope>((at, [key, facts]) => {
		const name = memberRelationNamed(key, state.over, label)
		return scopeWith(
			at,
			memberState(state, "insert", name, captureLoc(`insert ${name}`, []), facts, label)
		)
	}, state)
	return make(state.over, scope.strata, scope.reads, scope.bound, decoder)
}

/** The records of the read-backs before it and of this one, under its name: the rows of its query's immediate decoder,
 * every one of them (read inside the write transaction, so a stated "one" reads back as an Option). */
type WithRead<Rd, Name extends string, IHead> = Simplify<
	Rd & { readonly [K in Name]: ReadonlyArray<IHead> }
>

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
	decoder: RowDecoder<Rd>,
	nameArg: ReadName<Name, Rd>,
	readBack: (delta: Delta<S>) => Decoders<unknown, IHead>
): ChangeSetOf<S, P, W, WithRead<Rd, Name, IHead>, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.read"
	const name = requireName(nameArg, label, "a read-back name")
	if (state.reads.some((r) => r.name === name)) {
		throw malformed(label, `distinct read-back names; ${JSON.stringify(name)} repeats`)
	}
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
	const scope = release(state, params)
	return make(
		state.over,
		scope.strata,
		[...scope.reads, { name, query, params, loc, desc: Object.freeze({ name, query }) }],
		scope.bound,
		merge(
			decoder,
			record(
				named<Name, RecordField<ReadonlyArray<IHead>>>(
					nameArg,
					attachment<IHead, "array">(immediate, "array")
				)
			)
		)
	)
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

/** The values come from the typed bind, ParamArg<Params>, each a ParamValue by construction, whose type
 * alone states a bound Stream's channels; a JavaScript caller's argument that is no record, or a NULL value, is refused.
 * The caller's map, and each value in it, is read once through hostRead into the value the ChangeSet owns (owned): a
 * getter or proxy trap that throws refuses it, and nothing after the read runs the caller's code.
 *
 * A free name is no private one, so the bound parameter keeps its name until make() makes it canonical. */
const bindParams = <S, W extends string, Rd, Done extends Strata, Last extends Stratum, A>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	params: ParamMap
): ChangeSetOf<S, unknown, W, Rd, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.bind"
	const read = hostRead(
		() => malformed(label, "a record of parameter values whose reading throws nothing"),
		() =>
			isPlainRecord(params)
				? Result.ok(
						Object.entries(params).map(([name, value]): readonly [string, ParamValue] => [
							name,
							owned(value, ownedBound)
						])
					)
				: Result.err(malformed(label, "a record of parameter values"))
	)
	if (!read.ok) {
		throw read.error
	}
	const free = freeParams(state)
	const bound = new Map(state.bound)
	for (const [name, value] of read.value) {
		if (!free.has(name)) {
			throw malformed(
				label,
				`a value only for a free parameter of the ChangeSet; ${JSON.stringify(name)} is none of them`
			)
		}
		if (absent(value)) {
			throw malformed(label, `a value for ${name}: grizzle has no NULL`)
		}
		bound.set(name, { origin: name, value, key: boundKey(value) })
	}
	for (const name of free) {
		if (!bound.has(name)) {
			throw malformed(label, `a value for every parameter of the ChangeSet; ${name} is missing`)
		}
	}
	return make(state.over, state.strata, state.reads, bound, decoder)
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

/** What union and sequence read of a ChangeSet beside its state: the decoder of its read-backs. */
interface ReadsMember<R> {
	readonly reads: RowDecoder<R>
}

/** The higher of two states' levels. */
const higher = (label: string, a: BuiltOver, b: BuiltOver): BuiltOver => {
	const which = higherOver(a, b)
	if (which === "neither") {
		throw malformed(
			label,
			"ChangeSets over levels of one schema; neither schema is a level of the other"
		)
	}
	return which === "a" ? a : b
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
			"a schema built by schema(...) or schema.extend(...), or a role built by role(...)"
		)
	}
	return make<S, unknown, never, unknown, Done, Last, unknown>(
		over,
		[[]],
		[],
		new Map<string, BoundParam>(),
		record({})
	)
}

/** The states of two ChangeSets combined, a refusal of more arguments, and the higher of their schemas; then their
 * decoders merged, read once each argument is known to be a ChangeSet. */
const combined = <R1, R2>(
	label: string,
	a: ReadsMember<R1>,
	b: ReadsMember<R2>,
	extra: ReadonlyArray<unknown>
): {
	readonly top: BuiltOver
	readonly x: Scope
	readonly y: Scope
	readonly bound: Map<string, BoundParam>
	readonly decoder: RowDecoder<Simplify<R1 & R2>>
} => {
	if (extra.length > 0) {
		throw malformed(label, `${label}(a, b): two arguments`)
	}
	const top = higher(label, stateOf(a, label).over, stateOf(b, label).over)
	const { a: x, b: y, bound } = combine(stateOf(a, label), stateOf(b, label))
	return { top, x, y, bound, decoder: merge(a.reads, b.reads) }
}

/** ChangeSet.union(a, b): the commutative combination, strata position by position. */
const unionOf = <S, P, W extends string, R1, R2, Done extends Strata, Last extends Stratum, A>(
	a: ReadsMember<R1>,
	b: ReadsMember<R2>,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Simplify<R1 & R2>, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.union"
	const { top, x, y, bound, decoder } = combined(label, a, b, extra)
	const n = Math.max(x.strata.length, y.strata.length)
	const strata = canonicalStrata(
		indices(n).map((i) => [...(x.strata[i] ?? []), ...(y.strata[i] ?? [])])
	)
	const reads = distinctReads(label, [...x.reads, ...y.reads])
	return make(top, strata, reads, bound, decoder)
}

/** ChangeSet.sequence(a, b): b evaluated against the state a produced, its strata after a's. */
const sequenceOf = <S, P, W extends string, R1, R2, Done extends Strata, Last extends Stratum, A>(
	a: ReadsMember<R1>,
	b: ReadsMember<R2>,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Simplify<R1 & R2>, never, Done, Last, A> & SchemaMember => {
	const label = "ChangeSet.sequence"
	const { top, x, y, bound, decoder } = combined(label, a, b, extra)
	const reads = distinctReads(label, [...x.reads, ...y.reads])
	return make(top, canonicalStrata([...x.strata, ...y.strata]), reads, bound, decoder)
}

/** The constructor namespace, the public value itself: each constructor implemented under its
 * ChangeSetConstructor signature, over the schema and the ChangeSets its arguments are (ChangeSetConstructor in
 *). */
const constructors: ChangeSetConstructor = {
	empty: (schema, ...extra: ReadonlyArray<unknown>) => emptyOf(schema, extra),
	union: (a, b, ...extra: ReadonlyArray<unknown>) => unionOf(a, b, extra),
	sequence: (a, b, ...extra: ReadonlyArray<unknown>) => sequenceOf(a, b, extra)
}
export const ChangeSet: ChangeSetConstructor = Object.freeze(constructors)

/** The constructors for a JavaScript caller, whose schema and ChangeSets are known only at run time: the same values,
 * under the view (ChangeSetValue). */
interface ChangeSetOver {
	empty(schema: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
	union(a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
	sequence(a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ChangeSetValue
}

const over: ChangeSetOver = {
	empty: (schema, ...extra) => emptyOf(schema, extra),
	union: (a, b, ...extra) =>
		unionOf(
			changeSetArgument(a, "ChangeSet.union"),
			changeSetArgument(b, "ChangeSet.union"),
			extra
		),
	sequence: (a, b, ...extra) =>
		sequenceOf(
			changeSetArgument(a, "ChangeSet.sequence"),
			changeSetArgument(b, "ChangeSet.sequence"),
			extra
		)
}
export const changeSetOver: ChangeSetOver = Object.freeze(over)
