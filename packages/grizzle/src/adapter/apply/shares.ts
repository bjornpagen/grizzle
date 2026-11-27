/**
 * A call's facts drawn as shares of whole groups (`drawShares`), each share a call of its own facts through the
 * write's one bind, so the host holds one share's facts, normalized and encoded, never every fact of the call: the
 * statements of a share are sent, then its facts are dropped and the next share is drawn, all in the call's one
 * transaction (apply/run.ts runWriteShares).
 *
 * A share holds whole groups. A group is what one host fill reads across facts: an owner a stratum's appends count and
 * every member of its counted families the call states (binding.ts FreshStratum, CountedFamily), keyed by the pairs of
 * the family's group that every fact holding one of its owner's or members' rows names by a field of its own
 * (binding.ts FamilyShares): an owner's own fact by its key fields, and a tree's root, whose fact holds every node of
 * the tree, by its root fields alone, since a node's `start` is drawn by the walk, never stated. A relation that is both
 * a member and an owner joins its two families' groups into one; every other fact is a group of its own, its nested
 * rows, an ordered family's members and a tree's nodes, with it. So every count, end, slot and fresh group the host
 * draws reads the facts of one share, as it reads the call's. A group past a share's bytes is a share of its own.
 *
 * Only a write every statement of which its facts feed is drawn so: a call of no facts sends no statement but its family
 * statements, which over no member and no nested row insert and recount nothing (`sendsAlone`; the bind's own `needs`,
 * ir/needs.ts), its members insert, its one stratum, and no relation parameter, so a share's statements are the call's
 * statements over that share's facts alone. Every other write is bound whole.
 *
 * A call is read once before any share of it is drawn: every slot's facts by the write's own readers, as its bind reads
 * them (runtime/write/read-call.ts readCall), its first refusal the bind's, at its slot. Its shares' bytes and groups
 * are the read's, and each share, or the whole call where it is bound whole after all, is the read's arrays of its facts,
 * whose bind takes the reads and reads no fact again; nothing after the read reflects on a caller's fact.
 */
import { Array as Arr, Effect, Result } from "effect"
import type { HostCall } from "#adapter/apply/run.ts"
import { toResult } from "#adapter/engine.ts"
import type { FlightWrite } from "#compiler/plan/change.ts"
import type { EncodingFailure } from "#compiler/plan/common.ts"
import { drawableShape, readCall, type SlotReads } from "#compiler/plan/runtime.ts"

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

/** Fact `at`'s group key under a family, as the call's read found it: the family's key, then the values of the fields
 * that name its group in the fact (binding.ts GroupHolder). */
const groupKey = (
	family: string,
	reads: SlotReads,
	at: number,
	fields: ReadonlyArray<string>
): string => {
	let key = family
	for (const field of fields) {
		key += `\u0000${keyText(reads.field(at, field))}`
	}
	return key
}

/**
 * A slot whose facts hold rows of a counted family's owner or member, and the fields of a fact that name the family's
 * group there (binding.ts GroupHolder), under the family's key.
 */
interface FamilyHolder {
	readonly family: string
	readonly fields: ReadonlyArray<string>
}

/** Each slot whose facts hold rows of a counted family a write's fresh strata draw, by its name, with each family's
 * holder it is, in the families' order, a slot of both an owner's and a member's rows twice. */
const holdersBySlot = (program: FlightWrite): ReadonlyMap<string, ReadonlyArray<FamilyHolder>> => {
	const out = new Map<string, Array<FamilyHolder>>()
	for (const stratum of program.binding.fresh) {
		for (const [family, shares] of stratum.shares) {
			for (const holder of [...shares.members, ...shares.owners]) {
				out.getOrInsertComputed(holder.slot, () => []).push({ family, fields: holder.fields })
			}
		}
	}
	return out
}

/**
 * Whether a write's call of no facts, its statements but `skip` sent, sends a statement its facts do not feed: any but a
 * family statement, which an insert's members and nested rows alone feed, so over none it inserts and recounts nothing
 * (write/family/additions.ts), though the flight sends it with every call. A statement of a query member, which reads
 * stored rows and no fact of the call, is one, and would run once a share.
 */
export const sendsAlone = (program: FlightWrite, skip: ReadonlySet<number>): boolean =>
	Arr.some(program.statements, (s) => !skip.has(s.index) && s.step.kind !== "familyWrite")

/**
 * Whether a write's facts may be drawn in shares (see the header): its shape (runtime/write/binding.ts drawableShape), and `alone`
 * false, its call of no facts sending no statement.
 */
const drawable = (program: FlightWrite, alone: boolean): boolean =>
	!alone && drawableShape(program.binding.members, program.params)

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

/** The positions 0 … n − 1 of a slot of `n` facts. */
const positions = (n: number): Array<number> => Array.from({ length: n }, (_, at) => at)

/** What a share takes of each member slot: its facts' positions in the slot, every slot of the write named. */
type ShareAts = Map<string, Array<number>>

/**
 * A call as its write binds it (`drawShares`): `whole`, the call bound whole, its facts the read's where the call was
 * read (its bind takes the reads), else the caller's, which a write no share is drawn of binds as it reads any; and
 * `shares`, its shares, none where it is bound whole.
 */
export interface DrawnShares {
	readonly whole: HostCall
	readonly shares: Iterable<HostCall> | undefined
}

/**
 * The call's facts as shares of whole groups within `bytes` each (see the header), in the members' order and each
 * slot's facts' order, the family groups first: none where the write is no drawable one, which the call binds whole as
 * the caller gave it, or where its facts fit one share, which it binds whole as the read took it; or the first refusal
 * the read meets. `alone` says whether the write's call of no facts sends a statement (`sendsAlone`).
 */
export const drawShares = (
	program: FlightWrite,
	call: HostCall,
	bytes: number,
	alone: boolean
): Result.Result<DrawnShares, EncodingFailure> => {
	if (!drawable(program, alone)) {
		return Result.succeed({ whole: call, shares: undefined })
	}
	return Result.map(toResult(readCall(program.prepared, program.codes, call.members)), (read) =>
		sharesOf(program, call, read, bytes)
	)
}

/** The read call `read`'s shares within `bytes` each (`drawShares`). */
const sharesOf = (
	program: FlightWrite,
	call: HostCall,
	read: ReadonlyMap<string, SlotReads>,
	bytes: number
): DrawnShares => {
	const slots = Arr.map(program.binding.members, (m) => m.slot)
	const readOf = (slot: string): SlotReads | undefined => read.get(slot)
	const callOf = (ats: ShareAts): HostCall => ({
		params: call.params,
		bound: call.bound,
		members: new Map(
			Arr.map(slots, (slot) => [slot, readOf(slot)?.take(ats.get(slot) ?? []) ?? []] as const)
		)
	})
	const countOf = (slot: string): number => readOf(slot)?.count ?? 0
	const bytesOf = (slot: string, at: number): number => readOf(slot)?.bytes(at) ?? 0
	const whole = callOf(new Map(Arr.map(slots, (slot) => [slot, positions(countOf(slot))] as const)))
	let total = 0
	for (const slot of slots) {
		for (let at = 0; at < countOf(slot); at++) {
			total += bytesOf(slot, at)
		}
	}
	if (total <= bytes) {
		return { whole, shares: undefined }
	}
	const holders = holdersBySlot(program)
	const grouped = new Set(holders.keys())
	/** Each grouped fact's group keys, under every family whose member or owner rows its slot's facts hold, in the
	 * families' order. */
	const keysOf = (slot: string, reads: SlotReads, at: number): ReadonlyArray<string> =>
		Arr.map(holders.get(slot) ?? [], (h) => groupKey(h.family, reads, at, h.fields))
	/** Each grouped slot's facts' groups, by the union of their families' keys. */
	const groups = unionFind()
	const keys = new Map<string, ReadonlyArray<ReadonlyArray<string>>>()
	for (const slot of grouped) {
		const reads = readOf(slot)
		const slotKeys =
			reads === undefined ? [] : Arr.map(positions(reads.count), (at) => keysOf(slot, reads, at))
		keys.set(slot, slotKeys)
		for (const [first, ...rest] of slotKeys) {
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
		const slotKeys = keys.get(slot) ?? []
		const ids = new Int32Array(slotKeys.length)
		for (const [at, factKeys] of slotKeys.entries()) {
			const root = groups.root(factKeys[0] ?? "")
			const known = numbers.get(root)
			const id = known ?? numbers.size
			if (known === undefined) {
				numbers.set(root, id)
			}
			ids[at] = id
		}
		ofGroup.set(slot, ids)
		byGroup.set(slot, Int32Array.from(indicesSorted(ids)))
	}
	return {
		whole,
		shares: {
			[Symbol.iterator]: function* () {
				const empty = (): ShareAts => new Map(Arr.map(slots, (slot) => [slot, []] as const))
				let share = empty()
				let held = 0
				let count = 0
				const flush = function* () {
					if (count === 0) {
						return
					}
					yield callOf(share)
					share = empty()
					held = 0
					count = 0
				}
				const add = (slot: string, at: number, size: number): void => {
					share.get(slot)?.push(at)
					held += size
					count += 1
				}
				/** Each grouped slot's next position in its group order: its facts are drawn a group at a time. */
				const cursors = new Map(Arr.map([...grouped], (slot) => [slot, 0] as const))
				for (let group = 0; group < numbers.size; group++) {
					let size = 0
					for (const slot of grouped) {
						const order = byGroup.get(slot) ?? new Int32Array()
						const ids = ofGroup.get(slot) ?? new Int32Array()
						for (let at = cursors.get(slot) ?? 0; at < order.length; at++) {
							const position = order[at] ?? 0
							if (ids[position] !== group) {
								break
							}
							size += bytesOf(slot, position)
						}
					}
					if (held > 0 && held + size > bytes) {
						yield* flush()
					}
					for (const slot of grouped) {
						const order = byGroup.get(slot) ?? new Int32Array()
						const ids = ofGroup.get(slot) ?? new Int32Array()
						let at = cursors.get(slot) ?? 0
						for (; at < order.length; at++) {
							const position = order[at] ?? 0
							if (ids[position] !== group) {
								break
							}
							add(slot, position, bytesOf(slot, position))
						}
						cursors.set(slot, at)
					}
				}
				for (const slot of slots) {
					if (grouped.has(slot)) {
						continue
					}
					for (let at = 0; at < countOf(slot); at++) {
						const size = bytesOf(slot, at)
						if (held > 0 && held + size > bytes) {
							yield* flush()
						}
						add(slot, at, size)
					}
				}
				yield* flush()
			}
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
 * Each share of a call (`drawShares`) bound by `bind` and then sent by `send`, one at a time: a share is drawn and bound
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
