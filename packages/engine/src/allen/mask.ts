import { type AllenRelation, allenMaskMax, allenRelations } from "#compiler/core/allen.ts"
import { nominal } from "#compiler/core/brand.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"

/**
 * An Allen mask: bit flags over the thirteen basic relations between two spans.
 *
 * The bit order is the declared order of allenRelations (core/allen.ts), from before = bit 0 to finishedBy = bit 12.
 * It is fixed: the offline table is indexed by it, a QueryDescription carries a mask as this number, and a change would
 * silently reinterpret every stored description.
 *
 * A mask is any subset of the thirteen relations, so there are 2^13 = 8192 masks. ALLEN's named members are masks;
 * `ALLEN.after | ALLEN.metBy` is a valid mask, and in TypeScript it is a plain number, so `complement` and `converse`
 * take `AllenMask | number` and check the thirteen-bit range at run time.
 *
 * Its relations are a phantom, Rs: exactly the relations a named member, its converse or its complement holds for,
 * which the types read where a mask decides what a predicate states (an equals mask is an equality, query/rule.ts
 * allen); every relation where the types do not know them, a mask the engine computes or a plain number's.
 */
export type AllenMask<Rs extends AllenRelation = AllenRelation> = number & {
	readonly [allenMaskBrand]: true
	readonly [allenMaskRelations]?: Rs
}
declare const allenMaskBrand: unique symbol
declare const allenMaskRelations: unique symbol

/** The relations a mask's type names: every relation for a plain number, whose relations the types do not know. */
export type AllenRelationsOf<M> = M extends AllenMask<infer Rs> ? Rs : AllenRelation

/** Whether a mask's type names exactly the one relation R. */
export type HoldsExactly<M, R extends AllenRelation> = [AllenRelationsOf<M>] extends [R]
	? [R] extends [AllenRelationsOf<M>]
		? true
		: false
	: false

/**
 * The brand's one mint, unchecked like every brand: the compiler builds a mask only from parseAllenMask's admitted
 * value, a relation's bit, or the bitwise operations of masks, which stay within the thirteen bits and never give -0.
 */
export const AllenMask = nominal<number, AllenMask>()

/** The mint of a mask of exactly the relations Rs, which its bits are. */
const maskOver = <Rs extends AllenRelation>(mask: AllenMask): AllenMask<Rs> =>
	nominal<number, AllenMask<Rs>>()(mask)

/** A thirteen-bit integer, -0 included: what a caller may write for a mask. */
const inMaskRange = (value: number): boolean =>
	Number.isInteger(value) && value >= 0 && value <= allenMaskMax
/**
 * The one parse of a caller's value into a mask: a thirteen-bit integer, -0 read as the empty mask; undefined for
 * every other value.
 */
export const parseAllenMask = (value: unknown): AllenMask | undefined =>
	typeof value === "number" && inMaskRange(value)
		? AllenMask(Object.is(value, -0) ? 0 : value)
		: undefined

/**
 * Where a point lies among the two endpoints of a span B = [b0, b1): 0 before b0, 1 at b0, 2 strictly between them, 3
 * at b1, 4 after b1. B's own endpoints are places 1 and 3.
 */
export type AllenPlace = 0 | 1 | 2 | 3 | 4

/** A span's two endpoints. */
export type SpanEndpoint = "lower" | "upper"

/**
 * What every relation is, the one statement of the thirteen: the places of A's endpoints a0 and a1 among B's, for two
 * nonempty half-open spans A = [a0, a1) and B = [b0, b1). Since a0 < a1, the lower place is at most the upper one and
 * the two share only a place between endpoints (0, 2 or 4), so these thirteen pairs are every pair of places two spans
 * can have: the relations are disjoint and exhaustive by construction. Everything else the compiler knows of a
 * relation is derived from its places: its converse below, the relations an endpoint comparison holds for
 * (endpoints.ts), and through those the relations each range operator holds for (atoms.ts), which the offline table
 * is generated from.
 */
export const allenPlaces = {
	before: { lower: 0, upper: 0 },
	meets: { lower: 0, upper: 1 },
	overlaps: { lower: 0, upper: 2 },
	starts: { lower: 1, upper: 2 },
	during: { lower: 2, upper: 2 },
	finishes: { lower: 2, upper: 3 },
	equals: { lower: 1, upper: 3 },
	after: { lower: 4, upper: 4 },
	metBy: { lower: 3, upper: 4 },
	overlappedBy: { lower: 2, upper: 4 },
	startedBy: { lower: 1, upper: 4 },
	contains: { lower: 0, upper: 4 },
	finishedBy: { lower: 0, upper: 3 }
} as const satisfies {
	readonly [R in AllenRelation]: { readonly [E in SpanEndpoint]: AllenPlace }
}

/** The place of each of B's endpoints among B's endpoints. */
const endpointPlace = { lower: 1, upper: 3 } as const satisfies {
	readonly [E in SpanEndpoint]: AllenPlace
}

/**
 * How a point at `place` among B's endpoints compares with B's `endpoint`: negative below it, zero at it, positive
 * above it.
 */
export const placeOrder = (place: AllenPlace, endpoint: SpanEndpoint): number =>
	place - endpointPlace[endpoint]

/** The places below each place, the order placeOrder's sign reads. */
interface PlacesBelow {
	readonly 0: never
	readonly 1: 0
	readonly 2: 0 | 1
	readonly 3: 0 | 1 | 2
	readonly 4: 0 | 1 | 2 | 3
}
type Places = typeof allenPlaces
type EndpointPlaces = typeof endpointPlace

/**
 * The place of B's endpoint at place E among A's endpoints at places L and U: before A's lower endpoint, at it, between
 * the two, at the upper one, or after it, by how each of A's endpoints compares with it (placeOrder).
 */
type PlaceAmong<
	L extends AllenPlace,
	U extends AllenPlace,
	E extends AllenPlace
> = E extends PlacesBelow[L]
	? 0
	: L extends E
		? 1
		: E extends PlacesBelow[U]
			? 2
			: U extends E
				? 3
				: 4

/** The relation whose places are L and U: every pair two nonempty spans can have is one relation's (allenPlaces). */
type RelationAt<L, U> = {
	[R in AllenRelation]: Places[R] extends { readonly lower: L; readonly upper: U } ? R : never
}[AllenRelation]

/**
 * The converse of each relation of Rs: swapping the operands maps a pair in relation r to the converse of r, whose places
 * are B's endpoints placed among A's.
 */
export type ConverseOf<Rs extends AllenRelation> = Rs extends AllenRelation
	? RelationAt<
			PlaceAmong<Places[Rs]["lower"], Places[Rs]["upper"], EndpointPlaces["lower"]>,
			PlaceAmong<Places[Rs]["lower"], Places[Rs]["upper"], EndpointPlaces["upper"]>
		>
	: never

/**
 * The relations a complement holds for: the others of a mask's known relations, every relation where they are unknown,
 * which a mask of every relation is read as too.
 */
type ComplementOf<Rs extends AllenRelation> = AllenRelation extends Rs
	? AllenRelation
	: Exclude<AllenRelation, Rs>

/** The converse of each relation, which its places give (ConverseOf): the type admits that one alone. */
export const allenConverseRelation: { readonly [R in AllenRelation]: ConverseOf<R> } = {
	before: "after",
	meets: "metBy",
	overlaps: "overlappedBy",
	starts: "startedBy",
	during: "contains",
	finishes: "finishedBy",
	equals: "equals",
	after: "before",
	metBy: "meets",
	overlappedBy: "overlaps",
	startedBy: "starts",
	contains: "during",
	finishedBy: "finishes"
}

/** The mask of all thirteen relations, which holds for every pair of spans and emits no predicate. */
export const fullAllenMask = AllenMask(allenMaskMax)
export const emptyAllenMask = AllenMask(0)

export const allenBit = <R extends AllenRelation>(relation: R): AllenMask<R> =>
	maskOver<R>(AllenMask(1 << allenRelations.indexOf(relation)))

/** The relations a predicate holds for: the union of the bits of the relations it accepts. */
export const allenMaskWhere = (holds: (relation: AllenRelation) => boolean): AllenMask => {
	let mask = 0
	for (const [bit, relation] of allenRelations.entries()) {
		if (holds(relation)) {
			mask |= 1 << bit
		}
	}
	return AllenMask(mask)
}

/**
 * The builders' throwing admission of a mask: a value outside the thirteen bits from a JavaScript caller is a malformed
 * argument the documented type does not admit as a mask. `complement` and `converse` run it on what a JavaScript caller
 * may pass.
 */
export const checkedMask = (value: unknown, operation: string): AllenMask => {
	const mask = parseAllenMask(value)
	if (mask !== undefined) {
		return mask
	}
	throw malformedDescription(
		SourceLoc(`ALLEN.${operation}`, []),
		`an Allen mask is an integer in [0, ${allenMaskMax}], a set of the thirteen basic relations`
	)
}

/** The union of the given relations' bits. */
export const allenMaskOf = <const Rs extends AllenRelation>(
	relations: ReadonlyArray<Rs>
): AllenMask<Rs> => {
	let mask = 0
	for (const relation of relations) {
		mask |= allenBit(relation)
	}
	return maskOver<Rs>(AllenMask(mask))
}

/** The relations a mask does not contain. */
export const complementMask = (mask: AllenMask): AllenMask => AllenMask(fullAllenMask ^ mask)

/** The relations both masks contain: the mask of a conjunction. */
export const intersectMasks = (a: AllenMask, b: AllenMask): AllenMask => AllenMask(a & b)

/** The relations either mask contains: the mask of a disjunction. */
export const uniteMasks = (a: AllenMask, b: AllenMask): AllenMask => AllenMask(a | b)

/** The mask holding for (B, A) exactly when `mask` holds for (A, B): each relation replaced by its converse. */
export const converseMask = (mask: AllenMask): AllenMask => {
	let out = 0
	for (const [bit, relation] of allenRelations.entries()) {
		if ((mask & (1 << bit)) !== 0) {
			out |= allenBit(allenConverseRelation[relation])
		}
	}
	return AllenMask(out)
}

/** The public ALLEN constants. `ALLEN.overlaps` is the basic relation, distinct from `ALLEN.intersects`. */
export const ALLEN = Object.freeze({
	before: allenBit("before"),
	meets: allenBit("meets"),
	overlaps: allenBit("overlaps"),
	starts: allenBit("starts"),
	during: allenBit("during"),
	finishes: allenBit("finishes"),
	equals: allenBit("equals"),
	after: allenBit("after"),
	metBy: allenBit("metBy"),
	overlappedBy: allenBit("overlappedBy"),
	startedBy: allenBit("startedBy"),
	contains: allenBit("contains"),
	finishedBy: allenBit("finishedBy"),
	/** The nine relations sharing a point: `&&`. */
	intersects: allenMaskOf([
		"overlaps",
		"overlappedBy",
		"starts",
		"startedBy",
		"during",
		"contains",
		"finishes",
		"finishedBy",
		"equals"
	]),
	/** equals | contains | startedBy | finishedBy: `@>`. */
	covers: allenMaskOf(["equals", "contains", "startedBy", "finishedBy"]),
	/** equals | during | starts | finishes: `<@`. */
	within: allenMaskOf(["equals", "during", "starts", "finishes"]),
	/** before | meets: `<<`. */
	precedes: allenMaskOf(["before", "meets"]),
	complement: <M extends AllenMask | number>(
		mask: M
	): AllenMask<ComplementOf<AllenRelationsOf<M>>> =>
		maskOver<ComplementOf<AllenRelationsOf<M>>>(complementMask(checkedMask(mask, "complement"))),
	converse: <M extends AllenMask | number>(mask: M): AllenMask<ConverseOf<AllenRelationsOf<M>>> =>
		maskOver<ConverseOf<AllenRelationsOf<M>>>(converseMask(checkedMask(mask, "converse")))
})
