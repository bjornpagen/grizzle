/**
 * Type.cast admits exactly the casts the engine has (test/types/compute/casts.ts): over every pair of SQL types of the
 * numeric family, money and the exact carriers, a value of one cast into the other, or into its own, a cell is admitted
 * exactly where the engine compiles it and refused, as no cast PostgreSQL has that grizzle admits, where it does not.
 * Each value proves every precondition a cast has, so the verdict is the cast table's alone. Each pair is a cell of the
 * box; a batch's cells are one program, checked disarmed. Oracle: the engine's compilation of each cell's cast.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { castsBox } from "#test/types/compute/casts.dictionary.ts"
import { castsProgram } from "#test/types/compute/casts.ts"

/** Over every pair of the casts' SQL types, admits exactly the casts the engine compiles. */
export const casts = boxAgreement(finite(word(castsBox)), {
	box: "every pair of smallint, integer, bigint, numeric, real, double precision, money, exact integer and exact money, a constant of the first, or the exact sum of two, cast into the second",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: castsProgram,
	oracle: { kind: "second-implementation", name: "the engine's compilation of each cell's cast" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/scalar.ts",
			original:
				"type RegisteredCastTarget<S> = S extends keyof CastTargetsBySql ? CastTargetsBySql[S] : never",
			replacement:
				'type RegisteredCastTarget<S> = S extends keyof CastTargetsBySql ? Exclude<CastTargetsBySql[S], "exact integer" | "exact money"> : never',
			why: "No cast is typed into an exact carrier, as the types' own list of casts left them out (edullm's PRESENCE-LEDGER: Type.cast of a bigint into exactInteger refused), so the cells of an integer into the exact integer and of money into the exact money are refused where the engine compiles them; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/scalar.ts",
			original:
				"export type CastAdmitted<X, S extends SqlTag, D, F extends SqlTag> = [S] extends [F]",
			replacement:
				"export type CastAdmitted<X, S extends SqlTag, D, F extends SqlTag> = [S] extends [never]",
			why: "A cast within one SQL type is read off the registered casts, which list none into the type itself but numeric's, so the cells of a value cast into its own type are refused where the engine compiles them; the program fails."
		}
	]
})
