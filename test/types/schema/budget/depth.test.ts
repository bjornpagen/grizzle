/**
 * A chain of levels' type cost by its depth (schema/budget/depth.ts): two uniform chains, of module constants and of
 * functions read by ReturnType, and qti-pie's chain as pantry and the ledger stack it, the kept case of consumer
 * evidence (TYPECOST, 2026-11-27: ledger's typecheck at 64 checkers, 15.3 GB, each checker deriving the chain again),
 * each checked alone at n, 2n and 4n levels above its root.
 *
 * Properties: every program typechecks with no diagnostic; its types, the checker's memory, grow linearly in its depth,
 * the levels from 2n to 4n making no more than twice those from n to 2n; and its instantiations, which grow by a term
 * for each relation and level below each extension (a hit of the type cache that makes no type; depth.ts states the
 * gap), hold their second difference at its measured value. Oracle: the compiler's own counts, compared across the
 * depths.
 */
import { costGate } from "#test/types/batch/measured.ts"
import { depthShapes } from "#test/types/schema/budget/depth.dictionary.ts"
import { depthCost } from "#test/types/schema/budget/depth.ts"

/**
 * The kill: a level copies every relation of the levels below it, each a type of its own, where its list's names are
 * checked against theirs (DeclaredOnce), so each level makes a type for each relation below it.
 */
const kills = Object.freeze([
	{
		file: "packages/engine/src/types/schema/schema.ts",
		original: "> = MembersTyped<Relations> & ClashRefused<Relations, Clashing<Relations, Below>>",
		replacement:
			"> = MembersTyped<Relations> &\n\tClashRefused<\n\t\tRelations,\n\t\t| Clashing<Relations, Below>\n\t\t| ({ readonly [N in keyof Below]: { readonly copy: Below[N] } }[keyof Below] extends never ? never : never)\n\t>",
		why: "Each level copies every relation of the levels below it into a type of its own as its list's names are checked against theirs: a chain of module constants at 8, 16 and 32 levels makes types with a second difference of 1,324 where 172 are measured, every program still clean and the engine's declarations built; the property fails."
	}
])

/** Each chain's types grow linearly in its depth, and its instantiations' quadratic term is no larger than measured. */
export const depth = costGate(depthShapes, {
	box: "two uniform chains and qti-pie's chain, each at n, 2n and 4n levels above its root",
	name: (shape) => shape.name,
	measure: depthCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, compared across the depths"
	},
	kills
})
