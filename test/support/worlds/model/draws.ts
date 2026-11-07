import { Array as Arr, Option, Record as Rec } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import {
	type Drawn,
	isDrawn,
	type SendableFact,
	sameValue,
	sendableFact
} from "#test/support/laws/model.ts"
import { factKeySet } from "#test/support/worlds/model/host.ts"
import { factsIn, relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	HostFact,
	HostState,
	HostValue,
	ModelState
} from "#test/support/worlds/model/types.ts"

/**
 * The values an identity default draws, which the model cannot predict. A fact the caller leaves a serial field out of
 * holds a draw there (families/model.ts Drawn): an integer of the field's type that repeats no stored value (README
 * "Direct SQL access": a later generated value never repeats a stored one), equal to no other value. The
 * real system shows it when a statement returns the fact, a read reads it, or a commit stores it; the model binds the
 * draw to the value shown and holds that value from then on, so a draw is any value of its identity's range, the same
 * value wherever the case meets it, and two draws are never one value.
 *
 * Each identity draws from a range of its own (identityFloor), where the harness sets its sequence before every case,
 * above every value a pool holds or a writer names, so the model judges a draw exactly before the real system shows
 * it: past every value at or below its range's top, since the values of its range the case holds are earlier draws of
 * its identity and its sequence never moves back (every writer advances past the serial values it writes), below every
 * value past the top, and equal to none but itself; two draws of distinct identities order by their ranges. Binding
 * holds the value shown to its draw's range (bindValue).
 */

/** How many values an identity's range holds: far more than any case draws. */
export const identitySpan = 2 ** 24

/**
 * The value a serial field's identity starts past, which the harness sets its sequence to before every case
 * (worlds/execute reset), so it draws from the next value to this one plus identitySpan: the k-th serial field of the
 * base, relations then fields in declaration order, starts past (k + 1) * identitySpan, above every pool value and
 * below the next identity's range. A worlds migration keeps the base's relations, so a field keeps its range. A base
 * with more serial fields than a 32-bit identity's ranges hold is no base the worlds model runs.
 */
export const identityFloor = (base: BaseSpec, relation: string, field: string): number => {
	const serials = Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f) =>
			f.domain.kind === "serial" ? [{ relation: r.name, field: f.name }] : []
		)
	)
	const at = Arr.findFirstIndex(serials, (s) => s.relation === relation && s.field === field)
	if (Option.isNone(at)) {
		throw new Error(`${relation}.${field} is no serial field of the base ${base.name}`)
	}
	const floor = (at.value + 1) * identitySpan
	if (floor + identitySpan > 2 ** 31 - 1) {
		throw new Error(
			`the base ${base.name} has more serial fields than a 32-bit identity's ranges hold`
		)
	}
	return floor
}

/** The value each draw the real system has shown is, by draw. */
export type Binding = ReadonlyMap<number, number>

/** The binding of an observation that shows no draw. */
export const unbound: Binding = new Map()

/** The draws a fact holds. */
const drawsOf = (fact: HostFact): ReadonlyArray<Drawn> => Arr.filter(Rec.values(fact), isDrawn)

/** The draws the facts of a relation state hold. */
const drawsIn = (state: HostState): ReadonlyArray<Drawn> =>
	Arr.flatMap([...state.values()].flat(), drawsOf)

/**
 * The first draw no value of the state holds: one past every draw of reality, the derived relations and every direct
 * writer's view, where a fact holding a draw the real system has not shown lives.
 */
export const nextDraw = (state: ModelState): number =>
	maxOf(
		Arr.map(
			[
				...drawsIn(state.reality),
				...Arr.flatMap(Rec.values(state.derived).flat(), drawsOf),
				...Arr.flatMap(state.sessions, (s) => (s.kind === "direct" ? drawsIn(s.view) : []))
			],
			(d) => d.draw
		),
		0
	) + 1

/** Whether a fact holds a value an identity drew and the real system has not shown. */
export const holdsDraw = (fact: HostFact): boolean => drawsOf(fact).length > 0

/**
 * The facts of a relation a writer can name, as it sends them: every one but those holding a draw the real system has
 * not shown, whose value no writer has seen (families/model.ts sendableFact).
 */
export const nameableFacts = (state: HostState, relation: string): ReadonlyArray<SendableFact> =>
	Arr.flatMap(factsIn(state, relation), (f) => {
		const sent = sendableFact(f)
		return sent === undefined ? [] : [sent]
	})

/** A fact with its serial fields' draws, and the first draw after them. */
interface DrewFact {
	readonly fact: HostFact
	readonly next: number
}

/**
 * A fact of a relation with each serial field the caller left out holding a draw, numbered from `first` in field order.
 */
export const withSerial = (
	base: BaseSpec,
	relation: string,
	fact: HostFact,
	first: number
): DrewFact => {
	let next = first
	const out: Record<string, HostValue> = { ...fact }
	for (const f of relationSpecOf(base, relation)?.fields ?? []) {
		if (f.domain.kind === "serial" && !Rec.has(fact, f.name)) {
			out[f.name] = {
				kind: "drawn",
				draw: next,
				ceiling: identityFloor(base, relation, f.name) + identitySpan
			}
			next += 1
		}
	}
	return { fact: out, next }
}

/** Facts with their serial fields' draws, and the first draw after them. */
interface Drew {
	readonly facts: ReadonlyArray<HostFact>
	readonly next: number
}

/** Facts of a relation, each with its serial fields' draws (withSerial), numbered from `first` in fact order. */
export const withSerials = (
	base: BaseSpec,
	relation: string,
	facts: ReadonlyArray<HostFact>,
	first: number
): Drew => {
	let next = first
	const drawn = Arr.map(facts, (fact) => {
		const drew = withSerial(base, relation, fact, next)
		next = drew.next
		return drew.fact
	})
	return { facts: drawn, next }
}

/**
 * The binding extending `binding` under which a model value is the value the real system showed, or none: a draw
 * binds an integer of its range that no other draw is, or meets the value it is bound to; any other value meets the
 * value it is. A value the binding already gives is returned as the binding itself, so a caller can tell a meeting
 * that binds nothing new.
 */
const bindValue = (
	expected: HostValue,
	observed: HostValue,
	binding: Binding
): Binding | undefined => {
	if (!isDrawn(expected)) {
		return sameValue(expected, observed) ? binding : undefined
	}
	if (
		typeof observed !== "number" ||
		observed <= expected.ceiling - identitySpan ||
		observed > expected.ceiling
	) {
		return undefined
	}
	const held = binding.get(expected.draw)
	if (held !== undefined) {
		return held === observed ? binding : undefined
	}
	return Arr.some([...binding.values()], (v) => v === observed)
		? undefined
		: new Map(binding).set(expected.draw, observed)
}

/** The binding extending `binding` under which a model fact is a fact the real system showed, field by field. */
const bindFact = (
	expected: HostFact,
	observed: HostFact,
	binding: Binding
): Binding | undefined => {
	const fields = Rec.keys(expected)
	if (fields.length !== Rec.keys(observed).length) {
		return undefined
	}
	let met: Binding | undefined = binding
	for (const field of fields) {
		const e = expected[field]
		const o = observed[field]
		met = met === undefined || e === undefined || o === undefined ? undefined : bindValue(e, o, met)
	}
	return met
}

/** What a search does with a binding it reached: the binding it accepts, extended or not, or none. */
export type Rest = (binding: Binding) => Binding | undefined

/** One item meeting one candidate under a binding, which hands every binding they meet under to `rest`. */
export type Meet<A, B> = (
	item: A,
	candidate: B,
	binding: Binding,
	rest: Rest
) => Binding | undefined

/** A model fact meeting a fact the real system showed (bindFact). */
export const factMeets: Meet<HostFact, HostFact> = (expected, observed, binding, rest) => {
	const met = bindFact(expected, observed, binding)
	return met === undefined ? undefined : rest(met)
}

/**
 * The binding extending `binding` under which each item meets a candidate of its own, items in order and candidates
 * tried in order, that `rest` then accepts; none when no choice of candidates does. A candidate an item meets is
 * consumed, so no two items meet one candidate: the items meet as many candidates as they are, never fewer. An item
 * that met a candidate binding nothing new meets only candidates equal to that one, so once `rest` refuses that, no
 * other is tried.
 */
export const everyMeets = <A, B>(
	items: ReadonlyArray<A>,
	candidates: ReadonlyArray<B>,
	meet: Meet<A, B>,
	binding: Binding,
	rest: Rest
): Binding | undefined => {
	const [item, ...more] = items
	if (item === undefined) {
		return rest(binding)
	}
	for (const [at, candidate] of candidates.entries()) {
		const reached = { unchanged: false }
		const done = meet(item, candidate, binding, (met) => {
			reached.unchanged = met === binding
			return everyMeets(more, candidates.toSpliced(at, 1), meet, met, rest)
		})
		if (done !== undefined || reached.unchanged) {
			return done
		}
	}
	return undefined
}

/** Whether a list of facts the real system showed holds no fact twice, each fact by every field and its value. */
export const distinctFacts = (facts: ReadonlyArray<HostFact>): boolean =>
	factKeySet(facts).size === facts.length

/**
 * The binding extending `binding` under which two lists of facts hold the same facts as keyed sets, which `rest`
 * accepts: the real system showed each fact once, and each model fact meets a fact it showed of its own, as many as
 * it showed. A delivery that repeats a fact is no set, so it agrees with no model, whatever the model holds.
 */
export const bindFacts = (
	expected: ReadonlyArray<HostFact>,
	observed: ReadonlyArray<HostFact>,
	binding: Binding,
	rest: Rest
): Binding | undefined =>
	expected.length === observed.length && distinctFacts(observed)
		? everyMeets(expected, observed, factMeets, binding, rest)
		: undefined

/**
 * Whether every draw the binding gives is a value its column holds nowhere else, as an identity's draw never repeats a
 * stored value: in reality and in each direct writer's view, no fact of the relation a draw lives in holds the draw's
 * value at the field the draw lives at.
 */
export const fresh = (state: ModelState, binding: Binding): boolean =>
	Arr.every(
		[state.reality, ...Arr.flatMap(state.sessions, (s) => (s.kind === "direct" ? [s.view] : []))],
		(place) =>
			Arr.every([...place.values()], (facts) =>
				Arr.every(facts, (fact) =>
					Arr.every(Rec.toEntries(fact), ([field, v]) => {
						const value = isDrawn(v) ? binding.get(v.draw) : undefined
						return value === undefined || !Arr.some(facts, (other) => other[field] === value)
					})
				)
			)
	)

const boundFact = (fact: HostFact, binding: Binding): HostFact =>
	holdsDraw(fact) ? Rec.map(fact, (v) => (isDrawn(v) ? (binding.get(v.draw) ?? v) : v)) : fact

const boundState = (state: HostState, binding: Binding): HostState =>
	new Map(
		Arr.map([...state], ([relation, facts]) => [
			relation,
			Arr.map(facts, (f) => boundFact(f, binding))
		])
	)

/**
 * The state with each draw the binding gives held as its value, wherever a fact holds it: reality, the derived
 * relations and every direct writer's view.
 */
export const bound = (state: ModelState, binding: Binding): ModelState => ({
	...state,
	reality: boundState(state.reality, binding),
	derived: Rec.map(state.derived, (facts) => Arr.map(facts, (f) => boundFact(f, binding))),
	sessions: Arr.map(state.sessions, (s) =>
		s.kind === "direct" ? { ...s, view: boundState(s.view, binding) } : s
	)
})
