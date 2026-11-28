/**
 * A finiteness guard tests exactly what its subject's type may hold, and a type that holds nothing but finite values is
 * finite by itself (test/types/compute/finite.ts): over the box of every finiteness operation (Num.isFinite, a guarded
 * and an unguarded bigint cast, a cast under Num.within, Num.minScale) over each numeric and float subject (numeric,
 * numeric(10, 2), numeric(18, 0), numeric(19, 0), double precision, a double's numeric), the types refuse exactly the
 * table's cells, under the types' Refusal for an unproved finiteness and by the subject's type where it takes no such
 * operation, and compilation's verdict on each cell, built and compiled beside the program, is the table's: a guard over
 * numeric(p, s) compares its subject with 'NaN' alone, numeric(p, 0) takes no guard and casts into bigint unguarded where
 * its digits fit (18) and is refused for its magnitude alone where they do not (19), which no type reads. Each cell of
 * the box is a case; a batch's cells are one program, checked disarmed. Oracle: what PostgreSQL 19 lets each type hold
 * beyond its finite values (numeric.c apply_typmod_special) and grizzle's numeric(p, 0), which holds no NaN.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { finiteBox } from "#test/types/compute/finite.dictionary.ts"
import { finiteProgram } from "#test/types/compute/finite.ts"

/** Over every finiteness operation and subject, the types and compilation refuse exactly the table's cells. */
export const finiteGuards = boxAgreement(finite(word(finiteBox)), {
	box: "Num.isFinite, a guarded and an unguarded bigint cast, a bigint cast under Num.within and Num.minScale, each over numeric, numeric(10, 2), numeric(18, 0), numeric(19, 0), double precision and a double's numeric",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: finiteProgram,
	oracle: {
		kind: "specification",
		name: "what PostgreSQL 19 lets each type hold beyond its finite values (numeric.c apply_typmod_special), and grizzle's numeric(p, 0), which holds no NaN"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original: '\t\t: [["ne", specials.nan]]',
			replacement: '\t\t: [\n\t\t\t\t["gt", specials.low],\n\t\t\t\t["lt", specials.high]\n\t\t\t]',
			why: "A guard over numeric(p, s) compares its subject with both infinities again, which no numeric(p, s) holds, so compilation refuses Num.isFinite over numeric(10, 2) as a literal its type cannot hold (scalar/compute/literal.ts oppositeLiteralProblem), where the table admits it; the program fails."
		},
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original: '\t\tcarrier === "exactMoney" ||\n\t\tintegerTypmodOf(t) !== undefined\n',
			replacement: '\t\tcarrier === "exactMoney"\n',
			why: "numeric(p, 0) is no longer finite by its type in compilation, so its unguarded bigint cast is refused as an unproved finiteness where the table admits it; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original: "\t\t\t: [V] extends [bigint]\n\t\t\t\t? true\n\t\t\t\t: false",
			replacement: "\t\t\t: [V] extends [bigint]\n\t\t\t\t? false\n\t\t\t\t: false",
			why: "numeric(p, 0) is no longer finite by its type in the types (FiniteByType), so they refuse its unguarded bigint cast and admit its guard, where the table admits the one and refuses the other; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original: "\tFiniteByType<S, V> extends true ? { readonly sql: never } : unknown",
			replacement: "\tunknown",
			why: "Num.isFinite takes a subject its type proves finite (MayBeNonFinite), so the types admit the guard over numeric(18, 0) and numeric(19, 0), which the table refuses by its subject's type; the program fails."
		}
	]
})
