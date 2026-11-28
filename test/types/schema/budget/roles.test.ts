/**
 * A role's type cost against the base its level extends (schema/budget/roles.ts): the derived relations of the level
 * a full role is over, and the laws over them, each program checked alone over a base of `small` relations and over
 * one of `large`, with a full role over the level and its readers, and without them, its control, as edullm's pantry
 * opens its author role over Qti, a level of derived relations over QtiBase.
 *
 * Properties: instantiations per derived relation of the role's level, and per law over a derived relation, are
 * invariant in the size of the base. The role and its readers add exactly as many instantiations to the program over
 * twice as many derived relations, or twice as many laws, over the large base as over the small one: (R − C)(large, 2k)
 * − (R − C)(large, k) = (R − C)(small, 2k) − (R − C)(small, k), R the program with the role and C its control. The role
 * holds no derived relation (each a live view), and keeps no law over one, but its type reads every relation of its
 * level and every law: which it holds (FullBaseOf, UnheldOf) and which it keeps (KeptStatements). A derived relation
 * holds its definition, a query over the base, so a test of it, or of a statement naming it, that the checker
 * instantiates whole costs more over the larger base, by every relation it walks, for each relation or law the second
 * program adds. The control pays what using the level costs anywhere (roles.ts), so the difference is the role's. And
 * every program typechecks with no diagnostic. Oracle: the compiler's own counts and diagnostics
 * (test/support/types/batch/measured.ts), compared across the two bases.
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { roleDimensions } from "#test/types/schema/budget/roles.dictionary.ts"
import { roleCost, roleDimensionName } from "#test/types/schema/budget/roles.ts"

/** A full role costs as many instantiations for each derived relation of its level, and each law over one, over the large base as over the small one. */
export const cost = costGate(roleDimensions, {
	box: "every dimension of a full role's level: its derived relations, its laws over them",
	name: roleDimensionName,
	measure: roleCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two bases" },
	kills: []
})
