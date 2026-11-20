/**
 * A call's facts drawn as shares of whole groups (`callShares`), each share a call of its own facts through the
 * write's one bind, so the host holds one share's facts, normalized and encoded, never every fact of the call: the
 * statements of a share are sent, then its facts are dropped and the next share is drawn, all in the call's one
 * transaction (apply/run.ts runWriteShares).
 *
 * A share holds whole groups. A group is what one host fill reads across facts: an owner a stratum's appends count and
 * every member of its counted families the call states (binding.ts FreshStratum, CountedFamily), keyed by the owner's
 * key as each member's group fields name it, a relation that is both a member and an owner joining its two families'
 * groups into one; every other fact is a group of its own, its nested rows, an ordered family's members and a tree's
 * nodes, with it. So every count, end, slot and fresh group the host draws reads the facts of one share, as it reads
 * the call's. A group past a share's bytes is a share of its own.
 *
 * Only a write every statement of which its facts feed is drawn so: a call of no facts sends no statement but its family
 * statements, which over no member and no nested row insert and recount nothing (`sendsAlone`; the bind's own `needs`,
 * ir/needs.ts), its members insert, its one stratum, and no relation parameter, so a share's statements are the call's
 * statements over that share's facts alone. Every other write is bound whole.
 */
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import type { HostCall } from "#adapter/apply/run.ts"
import type { FlightWrite } from "#compiler/plan/change.ts"
import { isRecord } from "#compiler/plan/runtime.ts"

/** The slots of a family's owner and members, and how a fact of each names its group. */
interface FamilySlots {
	readonly member: ReadonlyArray<string>
	readonly owner: ReadonlyArray<string>
	readonly memberFields: ReadonlyArray<string>
	readonly ownerFields: ReadonlyArray<string>
	readonly id: number
}

/**
 * The bytes a caller's value takes on the host, as a share counts it: a text's code units, a binary value's bytes, a
 * scalar's eight, and a container's elements, each field's name with it.
 */
export const valueBytes = (value: unknown): number => {
	if (typeof value === "string") {
		return value.length + 1
	}
	if (value instanceof Uint8Array) {
		return value.byteLength + 1
	}
	if (Arr.isArray(value)) {
		return Arr.reduce(value, 1, (sum, element) => sum + valueBytes(element))
	}
	if (value instanceof Set) {
		let sum = 1
		for (const element of value) {
			sum += valueBytes(element)
		}
		return sum
	}
	if (isRecord(value)) {
		let sum = 1
		for (const [name, field] of Rec.toEntries(value)) {
			sum += name.length + valueBytes(field)
		}
		return sum
	}
	return 8
}

/** A value of a group field as text, by its kind, so a text and a number of one spelling are two groups. */
const keyText = (value: unknown): string =>
	typeof value === "string"
		? `s${value}`
		: typeof value === "bigint"
			? `n${String(value)}`
			: typeof value === "number"
				? `d${String(value)}`
				: typeof value === "boolean"
					? `b${String(value)}`
					: `o${String(value)}`

/** A fact's group key under a family: the family, then each of its group fields' values. */
const groupKey = (family: number, fact: unknown, fields: ReadonlyArray<string>): string => {
	let key = String(family)
	for (const field of fields) {
		const value = isRecord(fact) && Rec.has(fact, field) ? fact[field] : undefined
		key += `\u0000${keyText(value)}`
	}
	return key
}

/** The counted families a write's fresh strata draw, each with the slots of its owner and of its members. */
const familySlots = (program: FlightWrite): ReadonlyArray<FamilySlots> => {
	const slotsOf = (relation: string): ReadonlyArray<string> =>
		Arr.flatMap(program.binding.members, (m) => (m.relation === relation ? [m.slot] : []))
	return Arr.map(
		Arr.flatMap(program.binding.fresh, (stratum) => stratum.counted),
		(family, id) => ({
			id,
			member: slotsOf(family.member),
			owner: slotsOf(family.owner),
			memberFields: Arr.map(family.group, (g) => g.member.name),
			ownerFields: Arr.map(family.group, (g) => g.owner.name)
		})
	)
}

/**
 * Whether a write's call of no facts, its statements but `skip` sent, sends a statement its facts do not feed: any but a
 * family statement, which an insert's members and nested rows alone feed, so over none it inserts and recounts nothing
 * (write/family/additions.ts), though the flight sends it with every call. A statement of a query member, which reads
 * stored rows and no fact of the call, is one, and would run once a share.
 */
export const sendsAlone = (program: FlightWrite, skip: ReadonlySet<number>): boolean =>
	Arr.some(program.statements, (s) => !skip.has(s.index) && s.step.kind !== "familyWrite")

/** Whether a write's facts may be drawn in shares (see the header), `alone` whether its call of no facts sends a statement. */
const drawable = (program: FlightWrite, alone: boolean): boolean =>
	!alone &&
	program.binding.members.length > 0 &&
	Arr.every(program.binding.members, (m) => m.op === "insert" && m.kind === "array") &&
	new Set(Arr.map(program.binding.members, (m) => m.stratum)).size === 1 &&
	Arr.every(program.params, (p) => p.kind !== "relation")

/** A union-find over group keys: each key's root, and the union of two keys' groups. */
const unionFind = () => {
	const parent = new Map<string, string>()
	const root = (key: string): string => {
		let at = key
		for (let next = parent.get(at); next !== undefined && next !== at; next = parent.get(at)) {
			at = next
		}
		parent.set(key, at)
		return at
	}
	return {
		root,
		union: (a: string, b: string): void => {
			const ra = root(a)
			const rb = root(b)
			if (ra !== rb) {
				parent.set(rb, ra)
			}
		}
	}
}

/** A share's facts of each member slot, every slot of the write named, none it draws no fact of empty. */
type ShareFacts = Map<string, Array<unknown>>

/**
 * The call's facts as shares of whole groups within `bytes` each (see the header), in the members' order and each
 * slot's facts' order, the family groups first; or none where the write is no drawable one or its facts fit one share,
 * which the call binds whole. `alone` says whether the write's call of no facts sends a statement (`sendsAlone`).
 */
export const callShares = (
	program: FlightWrite,
	call: HostCall,
	bytes: number,
	alone: boolean
): Iterable<HostCall> | undefined => {
	if (!drawable(program, alone)) {
		return undefined
	}
	const slots = Arr.map(program.binding.members, (m) => m.slot)
	const factsOf = (slot: string): ReadonlyArray<unknown> => {
		const given = call.members.get(slot)
		return given === undefined ? [] : Arr.isArray(given) ? given : Arr.fromIterable(given)
	}
	const given = new Map(Arr.map(slots, (slot) => [slot, factsOf(slot)] as const))
	let total = 0
	for (const facts of given.values()) {
		for (const fact of facts) {
			total += valueBytes(fact)
			if (total > bytes) {
				break
			}
		}
		if (total > bytes) {
			break
		}
	}
	if (total <= bytes) {
		return undefined
	}
	const families = familySlots(program)
	const grouped = new Set(Arr.flatMap(families, (f) => [...f.member, ...f.owner]))
	/** Each grouped slot's facts' groups, by the union of their families' keys. */
	const groups = unionFind()
	for (const family of families) {
		for (const slot of family.member) {
			for (const fact of given.get(slot) ?? []) {
				groups.root(groupKey(family.id, fact, family.memberFields))
			}
		}
	}
	for (const slot of grouped) {
		const keysOf = (fact: unknown): ReadonlyArray<string> =>
			Arr.flatMap(families, (f) => [
				...(f.member.includes(slot) ? [groupKey(f.id, fact, f.memberFields)] : []),
				...(f.owner.includes(slot) ? [groupKey(f.id, fact, f.ownerFields)] : [])
			])
		for (const fact of given.get(slot) ?? []) {
			const [first, ...rest] = keysOf(fact)
			for (const key of rest) {
				if (first !== undefined) {
					groups.union(first, key)
				}
			}
		}
	}
	/** Each grouped slot's fact positions by group, the groups numbered in their first fact's order. */
	const numbers = new Map<string, number>()
	const byGroup = new Map<string, Int32Array>()
	const ofGroup = new Map<string, Int32Array>()
	for (const slot of grouped) {
		const facts = given.get(slot) ?? []
		const ids = new Int32Array(facts.length)
		for (const [at, fact] of facts.entries()) {
			const key = Option.match(
				Arr.findFirst(families, (f) => f.member.includes(slot) || f.owner.includes(slot)),
				{
					onNone: () => "",
					onSome: (f) =>
						groupKey(f.id, fact, f.member.includes(slot) ? f.memberFields : f.ownerFields)
				}
			)
			const root = groups.root(key)
			const known = numbers.get(root)
			const id = known ?? numbers.size
			if (known === undefined) {
				numbers.set(root, id)
			}
			ids[at] = id
		}
		const order = Int32Array.from(indicesSorted(ids))
		ofGroup.set(slot, ids)
		byGroup.set(slot, order)
	}
	return {
		[Symbol.iterator]: function* () {
			const empty = (): ShareFacts => new Map(Arr.map(slots, (slot) => [slot, []] as const))
			let share = empty()
			let held = 0
			let count = 0
			const flush = function* () {
				if (count === 0) {
					return
				}
				yield { params: call.params, bound: call.bound, members: share }
				share = empty()
				held = 0
				count = 0
			}
			const add = (slot: string, fact: unknown): void => {
				share.get(slot)?.push(fact)
				held += valueBytes(fact)
				count += 1
			}
			/** Each grouped slot's next position in its group order: its facts are drawn a group at a time. */
			const cursors = new Map(Arr.map([...grouped], (slot) => [slot, 0] as const))
			for (let group = 0; group < numbers.size; group++) {
				let size = 0
				for (const slot of grouped) {
					const order = byGroup.get(slot) ?? new Int32Array()
					const ids = ofGroup.get(slot) ?? new Int32Array()
					const slotFacts = given.get(slot) ?? []
					for (let at = cursors.get(slot) ?? 0; at < order.length; at++) {
						const position = order[at] ?? 0
						if (ids[position] !== group) {
							break
						}
						size += valueBytes(slotFacts[position])
					}
				}
				if (held > 0 && held + size > bytes) {
					yield* flush()
				}
				for (const slot of grouped) {
					const order = byGroup.get(slot) ?? new Int32Array()
					const ids = ofGroup.get(slot) ?? new Int32Array()
					const slotFacts = given.get(slot) ?? []
					let at = cursors.get(slot) ?? 0
					for (; at < order.length; at++) {
						const position = order[at] ?? 0
						if (ids[position] !== group) {
							break
						}
						add(slot, slotFacts[position])
					}
					cursors.set(slot, at)
				}
			}
			for (const slot of slots) {
				if (grouped.has(slot)) {
					continue
				}
				for (const fact of given.get(slot) ?? []) {
					const size = valueBytes(fact)
					if (held > 0 && held + size > bytes) {
						yield* flush()
					}
					add(slot, fact)
				}
			}
			yield* flush()
		}
	}
}

/** The positions 0 … ids.length − 1 ordered by their ids, each id's positions in order (a counting sort). */
const indicesSorted = (ids: Int32Array): Int32Array => {
	let most = -1
	for (const id of ids) {
		most = Math.max(most, id)
	}
	const starts = new Int32Array(most + 2)
	for (const id of ids) {
		starts[id + 1] = (starts[id + 1] ?? 0) + 1
	}
	for (let id = 1; id < starts.length; id++) {
		starts[id] = (starts[id] ?? 0) + (starts[id - 1] ?? 0)
	}
	const out = new Int32Array(ids.length)
	for (const [at, id] of ids.entries()) {
		const to = starts[id] ?? 0
		out[to] = at
		starts[id] = to + 1
	}
	return out
}

/**
 * Each share of a call (`callShares`) bound by `bind` and then sent by `send`, one at a time: a share is drawn and bound
 * only once the one before it has been sent, so the host holds one share's bound facts, its statements' parameters
 * among them, and the sends' answers, never every share's. The answers are in the shares' order.
 */
export const eachShare = <B, A, E, R>(
	shares: Iterable<HostCall>,
	bind: (call: HostCall) => Effect.Effect<B, E, R>,
	send: (bound: B, index: number) => Effect.Effect<A, E, R>
): Effect.Effect<ReadonlyArray<A>, E, R> =>
	Effect.gen(function* () {
		const answers: Array<A> = []
		let index = 0
		for (const share of shares) {
			const bound = yield* bind(share)
			const answer = yield* send(bound, index)
			answers.push(answer)
			index += 1
		}
		return answers
	})
