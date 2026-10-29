import { nominal } from "#compiler/core/brand.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"

/**
 * An Allen mask: bit flags over the thirteen basic relations between two spans.
 *
 * The bit order is the declared order of allenRelations, from before = bit 0 to finishedBy = bit 12. It is fixed: the
 * offline table is indexed by it, a QueryDescription carries a mask as this number, and a change would silently
 * reinterpret every stored description.
 *
 * A mask is any subset of the thirteen relations, so there are 2^13 = 8192 masks. ALLEN's named members are masks;
 * `ALLEN.after | ALLEN.metBy` is a valid mask, and in TypeScript it is a plain number, so `complement` and `converse`
 * take `AllenMask | number` and check the thirteen-bit range at run time.
 */
export type AllenMask = number & { readonly [allenMaskBrand]: true }
declare const allenMaskBrand: unique symbol

const allenMaskLimit = 0x1fff
/** A thirteen-bit integer, -0 included: what a caller may write for a mask. */
const inMaskRange = (value: number): boolean =>
	Number.isInteger(value) && value >= 0 && value <= allenMaskLimit
/**
 * The brand's one mint, unchecked like every brand: the compiler builds a mask only from parseAllenMask's admitted
 * value, a relation's bit, or the bitwise operations of masks, which stay within the thirteen bits and never give -0.
 */
export const AllenMask = nominal<number, AllenMask>()
/**
 * The one parse of a caller's value into a mask: a thirteen-bit integer, -0 read as the empty mask; undefined for
 * every other value.
 */
export const parseAllenMask = (value: unknown): AllenMask | undefined =>
	typeof value === "number" && inMaskRange(value)
		? AllenMask(Object.is(value, -0) ? 0 : value)
		: undefined

/** The thirteen basic relations in bit order. */
export const allenRelations = [
	"before",
	"meets",
	"overlaps",
	"starts",
	"during",
	"finishes",
	"equals",
	"after",
	"metBy",
	"overlappedBy",
	"startedBy",
	"contains",
	"finishedBy"
] as const
export type AllenRelation = (typeof allenRelations)[number]

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
export const allenPlaces: {
	readonly [R in AllenRelation]: { readonly [E in SpanEndpoint]: AllenPlace }
} = {
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
}

/** The place of each of B's endpoints among B's endpoints. */
const endpointPlace: { readonly [E in SpanEndpoint]: AllenPlace } = { lower: 1, upper: 3 }

/**
 * How a point at `place` among B's endpoints compares with B's `endpoint`: negative below it, zero at it, positive
 * above it.
 */
export const placeOrder = (place: AllenPlace, endpoint: SpanEndpoint): number =>
	place - endpointPlace[endpoint]

/** The place of a point among A's endpoints, from how A's lower and upper endpoints compare with it. */
const placeAmong = (lowerOrder: number, upperOrder: number): AllenPlace =>
	lowerOrder > 0 ? 0 : lowerOrder === 0 ? 1 : upperOrder > 0 ? 2 : upperOrder === 0 ? 3 : 4

/**
 * The relation whose places these are. The defect stays: that the thirteen place pairs are every pair two nonempty
 * spans can have is a fact of allenPlaces the type system cannot see, checked once per relation at module load.
 */
const relationAt = (lower: AllenPlace, upper: AllenPlace): AllenRelation => {
	const found = allenRelations.find(
		(r) => allenPlaces[r].lower === lower && allenPlaces[r].upper === upper
	)
	if (found === undefined) {
		throw defect(`a relation at places ${lower} and ${upper}`)
	}
	return found
}

/**
 * The converse of a relation: swapping the operands maps a pair in relation r to the converse of r. B's endpoints are
 * placed among A's by how A's endpoints compare with each of them.
 */
const converseOf = (r: AllenRelation): AllenRelation => {
	const { lower, upper } = allenPlaces[r]
	const place = (b: SpanEndpoint): AllenPlace =>
		placeAmong(placeOrder(lower, b), placeOrder(upper, b))
	return relationAt(place("lower"), place("upper"))
}

export const allenConverseRelation: Readonly<Record<AllenRelation, AllenRelation>> = {
	before: converseOf("before"),
	meets: converseOf("meets"),
	overlaps: converseOf("overlaps"),
	starts: converseOf("starts"),
	during: converseOf("during"),
	finishes: converseOf("finishes"),
	equals: converseOf("equals"),
	after: converseOf("after"),
	metBy: converseOf("metBy"),
	overlappedBy: converseOf("overlappedBy"),
	startedBy: converseOf("startedBy"),
	contains: converseOf("contains"),
	finishedBy: converseOf("finishedBy")
}

/** The mask of all thirteen relations, which holds for every pair of spans and emits no predicate. */
export const fullAllenMask = AllenMask(allenMaskLimit)
export const emptyAllenMask = AllenMask(0)

export const allenBit = (relation: AllenRelation): AllenMask =>
	AllenMask(1 << allenRelations.indexOf(relation))

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
		"an Allen mask is an integer in [0, 8191], a set of the thirteen basic relations"
	)
}

/** The union of the given relations' bits. */
export const allenMaskOf = (...relations: ReadonlyArray<AllenRelation>): AllenMask => {
	let mask = 0
	for (const relation of relations) {
		mask |= allenBit(relation)
	}
	return AllenMask(mask)
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

interface AllenNamespace {
	readonly before: AllenMask
	readonly meets: AllenMask
	readonly overlaps: AllenMask
	readonly starts: AllenMask
	readonly during: AllenMask
	readonly finishes: AllenMask
	readonly equals: AllenMask
	readonly after: AllenMask
	readonly metBy: AllenMask
	readonly overlappedBy: AllenMask
	readonly startedBy: AllenMask
	readonly contains: AllenMask
	readonly finishedBy: AllenMask
	/** The nine relations sharing a point: `&&`. */
	readonly intersects: AllenMask
	/** equals | contains | startedBy | finishedBy: `@>`. */
	readonly covers: AllenMask
	/** equals | during | starts | finishes: `<@`. */
	readonly within: AllenMask
	/** before | meets: `<<`. */
	readonly precedes: AllenMask
	complement(mask: AllenMask | number): AllenMask
	converse(mask: AllenMask | number): AllenMask
}

/** The public ALLEN constants. `ALLEN.overlaps` is the basic relation, distinct from `ALLEN.intersects`. */
export const ALLEN: AllenNamespace = Object.freeze({
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
	intersects: allenMaskOf(
		"overlaps",
		"overlappedBy",
		"starts",
		"startedBy",
		"during",
		"contains",
		"finishes",
		"finishedBy",
		"equals"
	),
	covers: allenMaskOf("equals", "contains", "startedBy", "finishedBy"),
	within: allenMaskOf("equals", "during", "starts", "finishes"),
	precedes: allenMaskOf("before", "meets"),
	complement: (mask: AllenMask | number): AllenMask =>
		complementMask(checkedMask(mask, "complement")),
	converse: (mask: AllenMask | number): AllenMask => converseMask(checkedMask(mask, "converse"))
})
