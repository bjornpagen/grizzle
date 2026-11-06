import type { Stream } from "effect"
import { indices } from "#compiler/core/array.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { attachment, merge, type RecordField, type RowDecoder } from "#compiler/core/decoder.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defined } from "#compiler/core/invariant.ts"
import { labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Order from "#compiler/core/order.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
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
import type { Family } from "#compiler/ir/family.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import * as S from "#compiler/ir/shape.ts"
import { inReservedSpace, slotSpelling } from "#compiler/ir/slots.ts"
import { schemaInfo } from "#compiler/query/build/heading.ts"
import { isOrderedValue, isQueryValue, labelledQueryDesc } from "#compiler/query/build/query.ts"
import { buildLoc, isCallback } from "#compiler/query/build/scope.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { isPlainRecord, malformed, orThrow, requireName } from "#compiler/schema/protocol.ts"
import { named, record } from "#compiler/schema/record.ts"
import type {
	ChangeSetConstructor,
	ChangeSet as ChangeSetOf,
	Delta,
	ReadName
} from "#compiler/types/changeset/changeset.ts"
import type { ParamMap, ParamValue, Simplify } from "#compiler/types/core/phantom.ts"
import type { Decoders, OrderedBase, QueryBase } from "#compiler/types/query/query.ts"
import {
	type BuiltOver,
	builtOverOf,
	higherOver,
	isLevelOver,
	levelOf,
	overName
} from "#compiler/write/changeset/levels.ts"
import { type DeltaValue, delta, memberRelation } from "#compiler/write/delta/source.ts"

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
 * What tells two values bound under one name apart: the value's canonical text, read once when bind takes it, or
 * opaque for a value that has none, a Stream, which is equal to no other value and has no canonical order.
 */
type BoundKey = { readonly kind: "text"; readonly text: string } | { readonly kind: "opaque" }

/** A parameter bind closed: the name it had when bound, its value, and the value's key. */
interface BoundParam {
	readonly origin: string
	readonly value: ParamValue
	readonly key: BoundKey
}

/** The key of a bound value (`BoundKey`). */
const boundKey = (value: ParamValue): BoundKey => {
	const text = encode(value, everyProperty)
	return text.ok ? { kind: "text", text: text.value } : { kind: "opaque" }
}

/** Private parameters by origin, then by key: every text in code-unit order, then the opaque ones as the sort found
 * them. */
const boundOrder: Order.Comparator<BoundParam> = Order.combineAll([
	Order.mapInput(Order.compareStrings, (p: BoundParam) => p.origin),
	(a: BoundParam, b: BoundParam) =>
		a.key.kind === "text" && b.key.kind === "text"
			? Order.compareStrings(a.key.text, b.key.text)
			: Order.compareNumbers(a.key.kind === "text" ? 0 : 1, b.key.kind === "text" ? 0 : 1)
])

interface ChangeSetState {
	readonly schema: unknown
	readonly over: BuiltOver
	readonly strata: ReadonlyArray<ReadonlyArray<MemberState>>
	readonly reads: ReadonlyArray<ReadBackState>
	/** The parameters bind closed, by their private names. */
	readonly bound: ReadonlyMap<string, BoundParam>
	/** Their values, by private name. */
	readonly values: ReadonlyMap<string, ParamValue>
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

/** A read-back: a function from the change's Delta to a query or ordered query, which is checked. */
export type ReadBackInput = (delta: DeltaValue) => unknown

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
 * db.compile): the schema or role it was built over, which a level is matched by, its
 * Description, the host inputs of its array and Stream members by the slot their member names, and the values bind
 * closed by the private parameter names the Description's `bindings` lists. */
export interface ParsedChangeSet {
	/** The schema value it was built over, and what that value is. */
	readonly schema: unknown
	readonly over: BuiltOver
	readonly desc: ChangeSetDesc
	readonly inputs: ReadonlyMap<string, ChangeSetInput>
	readonly values: ReadonlyMap<string, ParamValue>
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
	over: BuiltOver,
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
		schema: overName(over),
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
	/** The kept private parameter of each origin and key text, by name. */
	const keyed = new Map<string, Map<string, string>>()
	for (const [name, param] of scope.bound) {
		if (param.key.kind === "opaque") {
			kept.set(name, param)
			continue
		}
		const texts = keyed.get(param.origin) ?? new Map<string, string>()
		keyed.set(param.origin, texts)
		const same = texts.get(param.key.text)
		if (same === undefined) {
			texts.set(param.key.text, name)
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
const make = <S, P, W extends string, Rd>(
	schema: unknown,
	over: BuiltOver,
	strata: ReadonlyArray<ReadonlyArray<MemberState>>,
	reads: ReadonlyArray<ReadBackState>,
	boundParams: ReadonlyMap<string, BoundParam>,
	decoder: RowDecoder<Rd>
): ChangeSetOf<S, P, W, Rd> & SchemaMember => {
	const scope = canonicalBindings({ strata, reads, bound: boundParams })
	const canonical = Object.freeze(scope.strata)
	const bound: ReadonlyMap<string, BoundParam> = scope.bound
	const { desc, inputs } = describe(over, canonical, scope.reads, bound)
	const state: ChangeSetState = Object.freeze({
		schema,
		over,
		strata: canonical,
		reads: Object.freeze([...scope.reads]),
		bound,
		values: new Map([...bound].map(([name, param]) => [name, param.value])),
		desc,
		inputs
	})
	const value: ChangeSetOf<S, P, W, Rd> & SchemaMember = {
		...builtMark,
		schema,
		reads: decoder,
		insert: (relation, facts) => addMember(state, decoder, "insert", relation, facts),
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

/** The schema a query value was written over, which must be a level of the ChangeSet's. */
const requireLevel = (query: unknown, over: BuiltOver, label: string): void => {
	const written = levelOf(queryState(query)?.schema.value)
	if (written === undefined) {
		throw malformed(label, "a query built by query(S) over a schema or a role")
	}
	const level = isLevelOver(written, over)
	if (!level.ok) {
		throw level.error
	}
	if (!level.value) {
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
	if (isQueryValue(facts)) {
		requireLevel(facts, state.over, label)
		const query = labelledQueryDesc(facts, label)
		if (query === undefined) {
			throw malformed(label, "a query built by query(S)")
		}
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
	if (isOrderedValue(facts)) {
		throw malformed(
			label,
			"a member that is a Query, not an Ordered: take(k) closes an ordered query back into a set"
		)
	}
	throw malformed(label, "a member: an array of facts, a Stream of facts, or a query")
}

const addMember = <S, P, W extends string, Rd>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	op: MemberOp,
	relation: unknown,
	facts: MemberInput
): ChangeSetOf<S, P, W, Rd> & SchemaMember => {
	const label = `ChangeSet.${op}`
	const name = memberRelation(relation, state.over, label)
	const loc = buildLoc(`${op} ${name}`, [])
	const member = memberState(state, op, name, loc, facts, label)
	/** The member's parameters are free: a private parameter of that name moves out of its way. */
	const scope = release(state, member.kind === "query" ? member.params : new Set())
	const last = scope.strata.length - 1
	const strata = scope.strata.map((s, i) => (i === last ? withMember(s, i, member) : s))
	return make(state.schema, state.over, strata, scope.reads, scope.bound, decoder)
}

/** The records of the read-backs before it and of this one, under its name: the rows of its query's immediate decoder,
 * every one of them (read inside the write transaction, so a stated "one" reads back as an Option). */
type WithRead<Rd, Name extends string, IHead> = Simplify<
	Rd & { readonly [K in Name]: ReadonlyArray<IHead> }
>

const addRead = <S, P, W extends string, Rd, const Name extends string, IHead>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	nameArg: ReadName<Name, Rd>,
	readBack: (delta: Delta<S>) => Decoders<unknown, IHead>
): ChangeSetOf<S, P, W, WithRead<Rd, Name, IHead>> & SchemaMember => {
	const label = "ChangeSet.read"
	const name = requireName(nameArg, label, "a read-back name")
	if (state.reads.some((r) => r.name === name)) {
		throw malformed(label, `distinct read-back names; ${JSON.stringify(name)} repeats`)
	}
	if (!isCallback(readBack)) {
		throw malformed(label, "a read-back: a function from the change's Delta to a query")
	}
	const q = readBack(delta<S>(state.over, schemaInfo(state.schema)))
	if (!isQueryValue(q) && !isOrderedValue(q)) {
		throw malformed(label, "a read-back callback that returns a query or an ordered query")
	}
	requireLevel(q, state.over, label)
	const query = labelledQueryDesc(q, label)
	if (query === undefined) {
		throw malformed(label, "a read-back query built by query(S)")
	}
	const immediate: RowDecoder<IHead> = q.immediate
	const params = queryParamNames(query)
	const loc = labeledChildLoc(buildLoc(label, [name]), "query", `read ${name}`)
	const scope = release(state, params)
	return make(
		state.schema,
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

/** A JavaScript caller's value, read as unknown: grizzle has no NULL. */
const absent = (value: unknown): boolean => value === undefined || value === null

/** The values come from the typed bind, ParamArg<Params>, each a ParamValue by construction, whose type
 * alone states a bound Stream's channels; a JavaScript caller's argument that is no record, or a NULL value, is refused.
 * The caller's map, and each array of facts in it, is read once through hostRead: a getter or proxy trap that throws
 * refuses it, and nothing after the read runs the caller's code.
 *
 * A free name is no private one, so the bound parameter keeps its name until make() makes it canonical. */
const bindParams = <S, W extends string, Rd>(
	state: ChangeSetState,
	decoder: RowDecoder<Rd>,
	params: ParamMap
): ChangeSetOf<S, unknown, W, Rd> & SchemaMember => {
	const label = "ChangeSet.bind"
	const read = hostRead(
		malformed(label, "a record of parameter values whose reading throws nothing"),
		() =>
			isPlainRecord(params)
				? Result.ok(
						Object.entries(params).map(([name, value]): readonly [string, ParamValue] => [
							name,
							isList(value) ? Object.freeze(value.map(frozenFact)) : value
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
	return make(state.schema, state.over, state.strata, state.reads, bound, decoder)
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

/** The higher of two states' schemas, as value and Description. */
const higher = (
	label: string,
	a: Pick<ChangeSetState, "schema" | "over">,
	b: Pick<ChangeSetState, "schema" | "over">
): Pick<ChangeSetState, "schema" | "over"> => {
	const which = higherOver(a.over, b.over)
	if (!which.ok) {
		throw which.error
	}
	if (which.value === "neither") {
		throw malformed(
			label,
			"ChangeSets over levels of one schema; neither schema is a level of the other"
		)
	}
	return which.value === "a" ? a : b
}

/** ChangeSet.empty(S). */
const emptyOf = <S>(
	schema: unknown,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S> & SchemaMember => {
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
	return make<S, unknown, never, unknown>(
		schema,
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
	readonly top: Pick<ChangeSetState, "schema" | "over">
	readonly x: Scope
	readonly y: Scope
	readonly bound: Map<string, BoundParam>
	readonly decoder: RowDecoder<Simplify<R1 & R2>>
} => {
	if (extra.length > 0) {
		throw malformed(label, `${label}(a, b): two arguments`)
	}
	const top = higher(label, stateOf(a, label), stateOf(b, label))
	const { a: x, b: y, bound } = combine(stateOf(a, label), stateOf(b, label))
	return { top, x, y, bound, decoder: merge(a.reads, b.reads) }
}

/** ChangeSet.union(a, b): the commutative combination, strata position by position. */
const unionOf = <S, P, W extends string, R1, R2>(
	a: ReadsMember<R1>,
	b: ReadsMember<R2>,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Simplify<R1 & R2>> & SchemaMember => {
	const label = "ChangeSet.union"
	const { top, x, y, bound, decoder } = combined(label, a, b, extra)
	const n = Math.max(x.strata.length, y.strata.length)
	const strata = canonicalStrata(
		indices(n).map((i) => [...(x.strata[i] ?? []), ...(y.strata[i] ?? [])])
	)
	const reads = distinctReads(label, [...x.reads, ...y.reads])
	return make(top.schema, top.over, strata, reads, bound, decoder)
}

/** ChangeSet.sequence(a, b): b evaluated against the state a produced, its strata after a's. */
const sequenceOf = <S, P, W extends string, R1, R2>(
	a: ReadsMember<R1>,
	b: ReadsMember<R2>,
	extra: ReadonlyArray<unknown>
): ChangeSetOf<S, P, W, Simplify<R1 & R2>> & SchemaMember => {
	const label = "ChangeSet.sequence"
	const { top, x, y, bound, decoder } = combined(label, a, b, extra)
	const reads = distinctReads(label, [...x.reads, ...y.reads])
	return make(
		top.schema,
		top.over,
		canonicalStrata([...x.strata, ...y.strata]),
		reads,
		bound,
		decoder
	)
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

/** An addition split along its relation's families: its own fields, and each family's member additions in order. */
export interface NestedAddition {
	readonly relation: string
	/** The fact's own fields: every field but its families' count fields and the fields grizzle draws or accumulates. */
	readonly fact: Readonly<Record<string, unknown>>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<NestedAddition>
	}>
}

/** An addition whose shape breaks at `path`: the count fields and member positions from the addition down. */
export interface ChangeSetRefusal {
	readonly fault: Extract<ValueFault, "factShape">
	readonly path: ReadonlyArray<string | number>
}

/** A fact found while splitting, with where its result goes: its slot, and its families' member slots in order. */
interface Split {
	readonly relation: string
	readonly own: Readonly<Record<string, unknown>>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<number>
	}>
}

/**
 * A position in an addition: the step from its parent's position, a count field or a member's position, and that
 * parent; the addition itself has none. Each position is one cell over its parent's, so the walk allocates nothing per
 * level of depth, and only a refusal spells its path out (`pathOf`).
 */
interface PathStep {
	readonly parent: PathStep | undefined
	readonly step: string | number
}

/** The count fields and member positions from the addition down to `at`. */
const pathOf = (at: PathStep | undefined): ReadonlyArray<string | number> => {
	const steps: Array<string | number> = []
	for (let p = at; p !== undefined; p = p.parent) {
		steps.push(p.step)
	}
	return steps.toReversed()
}

/** What splitting a fact of one relation reads off `families`: the families it owns, and their count fields, which
 * hold its members' arrays. */
interface RelationSplit {
	readonly owned: ReadonlyArray<Family>
	readonly counts: ReadonlySet<string>
}

/** How a fact of `relation` splits along `families`. */
const relationSplit = (relation: string, families: ReadonlyArray<Family>): RelationSplit => {
	const owned = families.filter((f) => f.owner.name === relation)
	return { owned, counts: new Set(owned.map((f) => f.count.name)) }
}

/** A caller's fact read once as a plain record, or factShape for anything else, a throwing getter among them. */
const factRecord = (
	value: unknown
): Result.Result<Readonly<Record<string, unknown>>, ChangeSetRefusal["fault"]> =>
	hostRead<Readonly<Record<string, unknown>>, ChangeSetRefusal["fault"]>("factShape", () =>
		isPlainRecord(value) ? Result.ok(Object.freeze({ ...value })) : Result.err("factShape")
	)

/**
 * The addition `fact` of `relation` split along `families`: each family whose owner is the fact's relation holds its
 * members as an array at the owner's count field, each member a fact of the family's member relation, split alike, so
 * a tree's nodes nest to any depth. The walk is iterative, with no limit on the depth, and linear in the facts it
 * reads: each fact is read once, its position is one cell over its owner's, and each relation's split is computed once.
 * A fact that is no plain record, or a count field that holds no array, is refused as factShape at its path. Each fact
 * keeps every field it states but its count fields, so one it states beyond the fields its caller writes, a field
 * grizzle draws or accumulates among them, reaches its level's normalizer, which admits exactly those and refuses it as
 * factShape, as a deletion's fact stating one is: dropped here, its value would be lost unsaid. Encoding them is the
 * program's, with the installation's codes.
 */
export const encodeAddition = (
	relation: string,
	fact: unknown,
	families: ReadonlyArray<Family>
): Result.Result<NestedAddition, ChangeSetRefusal> => {
	const relationSplits = new Map<string, RelationSplit>()
	const splitOf = (name: string): RelationSplit => {
		const known = relationSplits.get(name)
		if (known !== undefined) {
			return known
		}
		const split = relationSplit(name, families)
		relationSplits.set(name, split)
		return split
	}
	const splits: Array<Split | undefined> = [undefined]
	const pending: Array<{
		readonly relation: string
		readonly value: unknown
		readonly at: PathStep | undefined
		readonly slot: number
	}> = [{ relation, value: fact, at: undefined, slot: 0 }]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const read = factRecord(next.value)
		if (!read.ok) {
			return Result.err({ fault: read.error, path: pathOf(next.at) })
		}
		const { owned, counts } = splitOf(next.relation)
		const own = Object.freeze(
			Object.fromEntries(Object.entries(read.value).filter(([name]) => !counts.has(name)))
		)
		const groups: Array<{ readonly family: FamilyId; readonly members: ReadonlyArray<number> }> = []
		for (const family of owned) {
			const at: PathStep = { parent: next.at, step: family.count.name }
			const members = read.value[family.count.name]
			if (!isList(members)) {
				return Result.err({ fault: "factShape", path: pathOf(at) })
			}
			const list: ReadonlyArray<unknown> = members
			const slots = list.map((member, position) => {
				const slot = splits.length
				splits.push(undefined)
				pending.push({
					relation: family.member.name,
					value: member,
					at: { parent: at, step: position },
					slot
				})
				return slot
			})
			groups.push({ family: family.id, members: slots })
		}
		splits[next.slot] = { relation: next.relation, own, families: groups }
	}
	const built: Array<NestedAddition | undefined> = splits.map(() => undefined)
	for (let slot = splits.length - 1; slot >= 0; slot -= 1) {
		const split = defined(splits[slot], "every slot the walk reserved is split")
		built[slot] = Object.freeze({
			relation: split.relation,
			fact: split.own,
			families: Object.freeze(
				split.families.map((g) =>
					Object.freeze({
						family: g.family,
						members: Object.freeze(
							g.members.map((m) => defined(built[m], "a member's slot follows its owner's"))
						)
					})
				)
			)
		})
	}
	return Result.ok(defined(built[0], "the addition's own slot"))
}
