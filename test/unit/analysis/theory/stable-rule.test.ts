/**
 * A rule over a query whose violation reads a stable value is refused (analysis/theory/theory.ts ruleViolation): a
 * stable function's value, or a conversion that reads a setting of its session (int4 to money reads lc_monetary), can
 * change with no write, so the rule's verdict can turn with nothing written, which neither its judge, reading the units
 * or the deltas a transaction wrote, nor the migration's check over its rows sees. STOREDDERIVED found a unit-local rule
 * calling a STABLE function compiled, as did one its probes judge.
 *
 * Property: over every case of the box, the rule's violation queries, written as generate writes them, are refused
 * exactly where the rule reads a stable value, the refusal naming the rule, and written where every value it reads is
 * immutable.
 *
 * The box: A(id, n, x) and W(wid), immutable, so the check is judged whole over the units a transaction wrote, or
 * mutable, each in a unit of its own, so its probes judge it; D, A's rows at an id W holds with a value of x and of n
 * computed in D's head, or compared in a condition of D's rule; the value a declared function's call, immutable or
 * stable, or a conversion of the integer to money; a check over D.
 *
 * Oracle: the volatility each value states, a declared function's its declaration's and a conversion's PostgreSQL's
 * (pg_proc.provolatile of int4_cash, 's').
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, judged } from "#test/unit/analysis/theory/stable-rule.fixtures.ts"

/** A rule whose violation reads a stable value is refused, whichever way it is judged. */
export const aRuleOverAQueryIsRefusedExactlyWhereItsViolationReadsAStableValueWholeOrProbed =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"an immutable function",
			"a stable function",
			"a conversion to money",
			"in the head",
			"in the condition",
			"judged by whole",
			"judged by probes"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c) => (drawn) => Effect.sync(() => judged(drawn, (f) => c.note(f))),
		oracle: {
			kind: "specification",
			name: "each value's volatility: a declared function's declaration, a conversion's pg_proc.provolatile"
		},
		box: "three values (an immutable or a stable function's call, a conversion to money) in D's head or its rule's condition, the check judged whole or by its probes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\t\tif (readsStable(read.dag)) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A rule's violation is written whatever it reads, as before: the check over a stable function's value, or over a conversion to money, compiles, judged whole or by its probes, and the property fails."
			}
		]
	})
