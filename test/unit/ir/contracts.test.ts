import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import {
	contextAdmits,
	type EvidenceContext,
	evidenceContexts,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import { assert } from "#test/support/assert.ts"

/**
 * The context order, written once: a snapshot read may rely on committed-snapshot facts, a read inside a transaction
 * only on what holds at every statement, and validated-transaction evidence on no execution context yet.
 */
const executions = ["transaction", "snapshot"] as const satisfies ReadonlyArray<TemplateContext>
const admitted = (execution: TemplateContext, context: EvidenceContext): boolean =>
	context === "descriptor" ||
	context === "immediate" ||
	context === "queryLocal" ||
	(context === "committedSnapshot" && execution === "snapshot")

describe("evidence contexts", () => {
	it.effect("admit and refuse evidence as the context order says, over every context", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/evidence-admission",
					generator: (source) =>
						[source.draw(element(executions)), source.draw(element(evidenceContexts))] as const,
					literal: Formatter.format,
					limit: 100,
					coverage: requiredInSpace<"admitted" | "not admitted">(["admitted", "not admitted"]),
					caseHang: Duration.minutes(2)
				},
				([execution, context], c) =>
					Effect.sync(() => {
						const verdict = admitted(execution, context)
						c.note(verdict ? "admitted" : "not admitted")
						assert.equal(
							contextAdmits(execution, context),
							verdict,
							`${execution} admits ${context}`
						)
					})
			)
		)
	)
})
