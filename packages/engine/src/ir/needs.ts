/**
 * What a write statement's rows, or one part's of a single statement, need of a call's inputs, proved when the write
 * compiles (logical/needs.ts needsOf over a member's query, write/insert/input.ts inputNeeds over a statement's input),
 * so a call whose inputs leave a statement's or a part's rows provably empty sends neither: no statement part, no
 * placeholder of it, no trigger it fires (runtime/write/bind.ts, runtime/write/parted.ts).
 */
import type { ParamId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"

/**
 * An input of a call whose facts a statement's rows may need: a relation parameter the write declares, or one of its
 * member slots, the facts a ChangeSet value states of one action (ir/rel.ts PlaceholderInput, without the relation a
 * member slot fills, which no emptiness reads).
 */
export type NeededInput =
	| { readonly kind: "declared"; readonly param: ParamId }
	| { readonly kind: "member"; readonly slot: ParamId }

/**
 * Alternatives, each a set of inputs every one of which must hold a fact for the rows to exist: a call whose inputs
 * satisfy no alternative writes and returns nothing there (`holds`). No alternative: the rows never exist (`never`).
 * One empty alternative: they may exist whatever the inputs hold (`always`). Each alternative holds each input once, in
 * the order of their ids; none is a superset of another; the alternatives are in the order of their inputs' ids; so one
 * proof has one spelling, whatever order it was proved in.
 */
export type Needs = ReadonlyArray<ReadonlyArray<NeededInput>>

/** Rows that may exist whatever a call's inputs hold. */
export const always: Needs = Object.freeze([Object.freeze([])])

/** Rows that never exist. */
export const never: Needs = Object.freeze([])

/** The id an input is ordered and compared by: its parameter's or its slot's. */
const idOf = (input: NeededInput): ParamId => (input.kind === "declared" ? input.param : input.slot)

/** Rows that exist only where `input` holds a fact. */
export const needing = (input: NeededInput): Needs => Object.freeze([Object.freeze([input])])

/** An alternative's inputs once each, in the order of their ids. */
const normalAlternative = (inputs: ReadonlyArray<NeededInput>): ReadonlyArray<NeededInput> => {
	const byId = new Map(inputs.map((input) => [idOf(input), input] as const))
	return Object.freeze(
		[...byId.entries()].toSorted(([a], [b]) => compareStrings(a, b)).map(([, input]) => input)
	)
}

/** Whether every input of `small` is one of `large`'s, both in id order. */
const within = (small: ReadonlyArray<NeededInput>, large: ReadonlyArray<NeededInput>): boolean => {
	const ids = new Set(large.map(idOf))
	return small.every((input) => ids.has(idOf(input)))
}

/** The alternatives `alternatives` state, in their one spelling (Needs): each normal, none a superset of another. */
const minimal = (alternatives: ReadonlyArray<ReadonlyArray<NeededInput>>): Needs => {
	const normal = alternatives
		.map(normalAlternative)
		.toSorted(
			(a, b) =>
				a.length - b.length ||
				compareStrings(a.map(idOf).join("\u0000"), b.map(idOf).join("\u0000"))
		)
	const kept: Array<ReadonlyArray<NeededInput>> = []
	for (const alternative of normal) {
		if (!kept.some((k) => within(k, alternative))) {
			kept.push(alternative)
		}
	}
	return Object.freeze(kept)
}

/** Rows that exist where any of `needs`' rows may: a union's, whose arms' rows are its rows. */
export const either = (needs: ReadonlyArray<Needs>): Needs => minimal(needs.flat())

/** Rows that exist only where every one of `needs`' rows does: a join's, which holds a row only of a row of each side. */
export const both = (needs: ReadonlyArray<Needs>): Needs =>
	needs.reduce<Needs>(
		(joined, next) => minimal(joined.flatMap((a) => next.map((b) => [...a, ...b]))),
		always
	)

/** Whether rows that need `needs` may exist where `holdsFact` says which inputs hold a fact. */
export const holds = (needs: Needs, holdsFact: (input: NeededInput) => boolean): boolean =>
	needs.some((alternative) => alternative.every(holdsFact))

/**
 * Whether `needs` holds wherever `where` does: each alternative of `where` holds one of `needs`' whole, so wherever a
 * call's inputs satisfy `where`, they satisfy `needs` (`holds`).
 */
export const covers = (needs: Needs, where: Needs): boolean =>
	where.every((alternative) => needs.some((n) => within(n, alternative)))
