/**
 * A range overload in a served file reads back as itself. An overload over a span (ir/expr.ts rangeOp) is one instance
 * per code and carrier, which the registry and the host evaluator know it by (scalar/compute/registry.ts nativeOp), so
 * a served write whose expressions read one, a CHECK's upper(span) among them, is judged on the host as the compile
 * judges it only where the file's reader answers that instance (served/json.ts `~op:`).
 *
 * Over every overload, each code over each span carrier, a box of 17 × 3: a served file holding it, written by
 * servedText, spells it `~op:<code>:<carrier>`; the JSON value an import of that file yields, read by servedFile, holds
 * that very instance; and the file read back writes as the same text again.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { type RangeOpCode, rangeOp, rangeOpCodes } from "#compiler/ir/expr.ts"
import { type SpanCarrier, spanCarriers } from "#compiler/ir/scalar.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type Overload = readonly [RangeOpCode, SpanCarrier]

type Feature = `over ${SpanCarrier}`

const overloadGen: Gen<Overload> = (source) =>
	[source.draw(element(rangeOpCodes)), source.draw(element(spanCarriers))] as const

/**
 * A served file holding `op` as its member `probe` and nothing besides, no roster among them: the writer walks a file's
 * members as values of any shape, so one member is a file it writes.
 */
const fileHolding = (op: unknown): ServedFile =>
	trusted<ServedFile>({ rosters: new Map(), probe: op })

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
							const text = succeeded(servedText(fileHolding(op)), "the file's text")
							assert.ok(Str.includes(`"${tag}"`)(text), `the overload writes as ${tag}`)
							const read = succeeded(servedFile(trustedJson<unknown>(text)), "the file read back")
							assert.ok(probeOf(read) === op, `${tag} reads back as the overload's one instance`)
							assert.equal(
								succeeded(servedText(read), "the file read back, written again"),
								text,
								`the file holding ${tag}, read back, writes as itself again`
							)
							c.note(`over ${carrier}`)
						})
				)
			)
	)
})
