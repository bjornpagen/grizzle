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

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { rangeOp } from "#compiler/ir/expr.ts"
import { spanCarriers } from "#compiler/ir/scalar.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined, jsonOf } from "#test/support/chunked.ts"
import {
	type Feature,
	fileHolding,
	overloadGen,
	probeOf
} from "#test/unit/served/overloads.fixtures.ts"

/** A range overload in a served file reads back as its one instance, which the registry knows it by, and writes as itself again. */
export const aRangeOverloadInAServedFileReadsBackAsItsOneInstanceWhichTheRegistryKnowsItByAndWritesAsItselfAgain =
	property.exhaust(finite(overloadGen), {
		needs: {},
		situations: Arr.map(spanCarriers, (c): Feature => `over ${c}`) satisfies ReadonlyArray<
			Reached<Feature>
		>,
		check:
			(_, c: Case<Feature>) =>
			([code, carrier]) =>
				Effect.sync(() => {
					const op = rangeOp(code, carrier)
					const tag = `~op:${code}:${carrier}`
					const text = succeeded(servedText(fileHolding(op)), "the file's text")
					assert.ok(Str.includes(`"${tag}"`)(joined(text)), `the overload writes as ${tag}`)

					const read = succeeded(servedFile(jsonOf(text)), "the file read back")
					assert.ok(probeOf(read) === op, `${tag} reads back as the overload's one instance`)
					assert.equal(
						joined(succeeded(servedText(read), "the file read back, written again")),
						joined(text),
						`the file holding ${tag}, read back, writes as itself again`
					)
					c.note(`over ${carrier}`)
				}),
		oracle: {
			kind: "specification",
			name: "ir/expr.ts rangeOp, the overload's one instance"
		},
		box: "every range overload, each code over each span carrier",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/served/json.ts",
				original: "\t\t\tout[key] = this.value(record[key], within)",
				replacement: "\t\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/served/json.ts:673 in <module>: `out[key] = this.value(record[key], within)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
