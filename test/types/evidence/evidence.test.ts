import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec } from "effect"
import { type Delivery, licenses } from "#compiler/core/decoder.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { checked } from "#test/types/batch/groups.ts"
import * as evidence from "#test/types/evidence/fixtures/evidence.ts"

/**
 * The type gate over evidence types:
 *
 * 1. The fixtures under ./fixtures typecheck under tsgo with the Effect language service, which proves every positive
 *    assertion over queries built through the public facade: cardinality relative to inputs, pinning by bindings and
 *    by filters, the keys a plain head retains, a computed head term determined by what it reads, a derived relation's
 *    inherited keys, and the delivery every attachment states, read back inside a write transaction
 *    (types/evidence/evidence.ts).
 * 2. Every `// @ts-expect-error -- TSnnnn: reason` directive names the diagnostic its next line raises.
 * 3. The IR licenses every delivery the types let an attachment state: each query of the fixtures' `deliveries` table,
 *    whose entries the fixtures prove equal to the shapes the query's heading and immediate heading state, compiles as
 *    the runtime compiles it (program/compile.ts) to a template whose analyzed DAG delivers each attachment in a shape
 *    that licenses the stated one, in the `snapshot` and `transaction` template contexts (core/decoder.ts licenses). A
 *    decoder binds an attachment only in a delivery the analysis licenses, so a proof the types make the IR must make
 *    too.
 *
 * The delivered shape of each attachment of a fixture query, by attachment name, as the runtime's template analyzes it.
 */
const delivered = (
	value: unknown,
	context: TemplateContext
): Readonly<Record<string, Delivery>> => {
	const template = succeeded(
		compileTemplate(value, undefined, { ...testCompile, context }),
		"the fixture query compiles"
	)
	const attaches = Arr.filter(
		topoOrder(template.analyzed),
		(n): n is NodeOf<"Attach"> => n.kind === "Attach"
	)
	return Rec.fromEntries(Arr.map(attaches, (n) => [n.name, n.delivered]))
}

/** The fixture queries whose deliveries the fixtures state, and the template contexts each is proved in. */
const queryNames = nonEmpty(Rec.keys(evidence.deliveries), "the fixtures' deliveries")

type QueryName = (typeof queryNames)[number]

const contexts = ["snapshot", "transaction"] as const

type Context = (typeof contexts)[number]

layer(NodeServices.layer, { excludeTestServices: true })("evidence types", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			assert.equal((yield* checked("evidence/fixtures")).output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("evidence/disarmed")
			assert.deepEqual(actual, expected)
		})
	)

	it.effect(
		"proves a delivery that licenses every attachment's stated shape, in both template contexts",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "types/evidence deliveries",
						generator: (source) => ({
							name: source.draw(element(queryNames)),
							context: source.draw(element(contexts))
						}),
						literal: Formatter.format,
						limit: queryNames.length * contexts.length,
						features: features<QueryName | Context>([...queryNames, ...contexts]),
						caseHang: Duration.minutes(2)
					},
					({ name, context }, c) =>
						Effect.sync(() => {
							c.note(name)
							c.note(context)
							const queries: Readonly<Record<string, unknown>> = evidence
							const proved = delivered(queries[name], context)
							const stated: Readonly<Record<string, Delivery>> = evidence.deliveries[name][context]
							unorderedEqual(Rec.keys(proved), Rec.keys(stated))
							for (const [attachment, delivery] of Rec.toEntries(stated)) {
								assert.ok(
									licenses(defined(proved[attachment], attachment), delivery),
									`${name} ${context} ${attachment}: the analysis proves ${proved[attachment]}, which does not license ${delivery}`
								)
							}
						})
				)
			)
	)

	it("proves nested's attachment inside its tasks, which the fixtures state as NestedDeliveries", () => {
		const nested = delivered(evidence.nested, "snapshot")
		unorderedEqual(Rec.keys(nested), ["tasks", "note"])
		assert.ok(licenses(defined(nested["tasks"], "tasks"), "array"), "nested tasks")
		assert.ok(licenses(defined(nested["note"], "note"), "option"), "nested note")
	})
})
