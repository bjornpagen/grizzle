/**
 * The Allen mask's format, which every layer that reads a mask shares: the thirteen basic relations between two spans,
 * in bit order, and the greatest mask they give. What a relation is, and every operation on a mask, is allen/mask.ts's.
 */

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
 * The greatest mask, every relation's bit set: 2^13 - 1, one bit per basic relation, the mask format's width, computed
 * from the relations themselves.
 *
 * @formatConstant the mask format's thirteen bits, all set
 */
export const allenMaskMax = 2 ** allenRelations.length - 1
