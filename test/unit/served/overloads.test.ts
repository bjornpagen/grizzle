/**
 * A range overload in a served file reads back as itself. An overload over a span (ir/expr.ts rangeOp) is one instance
 * per code and carrier, which the registry and the host evaluator know it by (scalar/compute/registry.ts nativeOp), so
 * a served write whose expressions read one, a CHECK's upper(span) among them, is judged on the host as the compile
 * judges it only where the file's reader answers that instance (served/json.ts `~op:`).
 *
 * Over every overload, each code over each span carrier, a box of 17 × 3: the JSON value an import of a served file
 * holding it yields, read by servedFile, holds that very instance; written again by servedText and read back, it is the
 * same instance once more.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { type RangeOpCode, rangeOp, rangeOpCodes } from "#compiler/ir/expr.ts"
import { type SpanCarrier, spanCarriers } from "#compiler/ir/scalar.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type Overload = readonly [RangeOpCode, SpanCarrier]

type Feature = `over ${SpanCarrier}`

const overloadGen: Gen<Overload> = (source) =>
	[source.draw(element(rangeOpCodes)), source.draw(element(spanCarriers))] as const

/** The member `probe` of a served file read back, as the file's value holds it. */
const probeOf = (file: object): unknown => (isRecord(file) ? file["probe"] : undefined)

describe("a range overload in a served file", () => {
	it.effect(
		"reads back as its one instance, which the registry knows it by, and writes as itself again",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/served/overloads",
						generator: overloadGen,
						literal: Formatter.format,
						box: "every range overload, each code over each span carrier",
						oracle: {
							kind: "specification",
							name: "ir/expr.ts rangeOp, the overload's one instance"
						},
						coverage: requiredInSpace<Feature>(Arr.map(spanCarriers, (c): Feature => `over ${c}`)),
						caseHang,
						concurrency: 1
					},
					([code, carrier], c) =>
						Effect.sync(() => {
							const op = rangeOp(code, carrier)
							const tag = `~op:${code}:${carrier}`
							const read = servedFile({
								types: [],
								rosters: {},
								probe: tag,
								"~": ["probe"]
							})
							assert.ok(probeOf(read) === op, `${tag} reads back as the overload's one instance`)
							const text = succeeded(servedText(read))
							assert.ok(Str.includes(`"${tag}"`)(text), `the overload writes as ${tag}`)
							assert.ok(
								probeOf(servedFile(trustedJson<unknown>(text))) === op,
								`${tag} written and read again is the overload's one instance`
							)
							c.note(`over ${carrier}`)
						})
				)
			)
	)
})
