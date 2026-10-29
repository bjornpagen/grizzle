import { Array as Arr, String as Str } from "effect"
import { type AllenFormula, formulaText } from "#compiler/allen/atoms.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { type AllenMask, emptyAllenMask, fullAllenMask } from "#compiler/allen/mask.ts"

import { regex } from "arkregex"
/**
 * An Allen mask's predicate as SQL text over two span expressions, for the suites that run the shipped table on
 * PostgreSQL itself (test/pg/allen/table.test.ts, test/pg/spans/oracle/reference.test.ts).
 *
 * The formula is the mask's shipped table entry (allen/lower.ts allenFormula) as allen/atoms.ts formulaText writes it
 * over A and B: each literal its range operator between the two spans, a negated one NOT over the operator (a negated
 * equality `<>`), joined by AND and OR, which PostgreSQL binds as the formula's disjunctive normal form. Its A and B
 * become the two span expressions. The empty mask holds of no pair and the full mask of every pair, so they are the
 * constants false and true.
 *
 * A formula over the spans `left` (A) and `right` (B), as SQL.
 */
export const formulaSql = (formula: AllenFormula, left: string, right: string): string =>
	Arr.join(
		Arr.map(Str.split(formulaText(formula), regex("\\b([AB])\\b")), (part, i) =>
			i % 2 === 0 ? part : part === "A" ? left : right
		),
		""
	)

/** A mask over the spans `left` (A) and `right` (B), as SQL. */
export const maskSql = (mask: AllenMask, left: string, right: string): string =>
	mask === emptyAllenMask
		? "false"
		: mask === fullAllenMask
			? "true"
			: formulaSql(allenFormula(mask), left, right)
