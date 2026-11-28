/**
 * A level's type cost (schema/budget/levels.ts), as edullm's ledger reads its Delivery level and qti-database its
 * assignment level, through ReturnType of the function that builds it (TS2589 at `DeliveryLevel = ReturnType<typeof
 * deliveryOf>` once Delivery held 711 relations and P4-RESULT's derived relations, a statement's five million
 * instantiations): a base of relations, and a level over it of derived relations reading a chain of eight queries over
 * queries, each derived relation under a check, at two base sizes and two derived counts.
 *
 * Properties: every program typechecks with no diagnostic, a level of 100 derived relations over 1,000 base relations
 * among them, past Delivery's size. A further base relation costs a level as many instantiations under 100 derived
 * relations as under 50, so the level grows with its base and with its derived relations apart, never with their
 * product; and so does what the ReturnType read costs beyond the level's value's type. A derived relation's type that
 * held its definition's query held the whole base, which the checker instantiated again for each derived relation
 * wherever it instantiated the level. Oracle: the compiler's own counts and diagnostics (test/support/types/batch/measured.ts),
 * compared across the corners.
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { levelCorners } from "#test/types/schema/budget/levels.dictionary.ts"
import { levelCost } from "#test/types/schema/budget/levels.ts"

/**
 * The kills: each form that made a level cost its base once for each derived relation, put back. The definition's query
 * held under the view's level; the definition's head read by a match of the whole query; its parameters decided by a
 * test whose result is the query.
 */
const kills = Object.freeze([
	{
		file: "packages/engine/src/types/derived/derived.ts",
		original:
			'export type DefinitionLevel<Q> = SchemaLevel<PhantomOf<Q>["schema" & keyof PhantomOf<Q>]>',
		replacement:
			'export type DefinitionLevel<Q> = SchemaLevel<PhantomOf<Q>["schema" & keyof PhantomOf<Q>]> &\n\tPhantom<{ readonly definition: Q }>',
		why: "A derived relation's view holds its definition's query under its level (an alias over the query keeps it in its argument): the checker instantiates the whole base again for each derived relation wherever it instantiates the level, so a level costs its base once for each derived relation (edullm's TS2589 at DeliveryLevel)."
	},
	{
		file: "packages/engine/src/types/query/query.ts",
		original: 'export type HeadOf<Q> = DecodedBy<Q["rows" & keyof Q]>',
		replacement:
			"export type HeadOf<Q> = Q extends { readonly rows: RowDecoder<infer H> } ? DecodedBy<RowDecoder<H>> : never",
		why: "A query's head is read by a match of the whole query against its rows decoder: the match instantiates the query, its base with it, so each derived relation's definition check costs every base relation."
	},
	{
		file: "packages/engine/src/types/derived/derived.ts",
		original: "\tReadsNoParams<Q> extends false\n\t\t? never",
		replacement: "\tNoParams<Q> extends never\n\t\t? never",
		why: "A definition's parameters are decided by a test whose result is the definition itself (NoParams): the test of the query instantiates it, its base with it, so each derived relation's definition check costs every base relation."
	}
])

/** A level, and its ReturnType read, cost its base and its derived relations apart, never their product. */
export const cost = costGate(levelCorners, {
	box: "the corners of base size and derived count a level is measured at",
	name: (corners) => corners.name,
	measure: levelCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts and diagnostics, compared across the corners"
	},
	kills
})
