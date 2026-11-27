/**
 * How the runner runs a case that never finishes (the runner's inline evaluator, which a search nested in a case runs
 * on, and which evaluates a case as a worker of the pool does): when the search itself is interrupted, every case it
 * started is interrupted or has ended, so the finalizers of each release what it holds (a leased session's open
 * transaction, in the database suites). That a hung case the case deadline stops releases what it holds too, before
 * the hang is reported, is the library's own suite's.
 *
 * The property exhausts the place, in start order, of the case that hangs. Every case holds a resource, counting its
 * acquisition and its release; the hanging case never finishes. The search runs as a fiber of its own, which is
 * interrupted once the hanging case has started; the oracle is the count itself: every acquisition the search made has
 * its release by the time the interruption returns. A case left holding never releases, and the runner's case deadline
 * names it: no clock decides the verdict. The nested search runs under the worker's own runner services (test/support/
 * runner.ts workerCluster), as every nested search does; its property needs none, so no cluster is reached. Features: the hanging case
 * first, and after finished cases.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { inlineRun, searchInline } from "@bjornpagen/testing/inline"
import { type Case, property } from "@bjornpagen/testing/property"
import { fnv1a32 } from "@bjornpagen/testing/random"
import { Deferred, Effect, Fiber } from "effect"
import { workerCluster } from "#test/support/runner.ts"
import { type Held, interruptedGen } from "#test/unit/oracle-runner/case-run.fixtures.ts"

/** A generated suite's cases are interrupted, or have ended, and release what they hold, when the check itself is interrupted. */
export const aGeneratedSuitesCasesAreInterruptedOrHaveEndedAndReleaseWhatTheyHoldWhenTheCheckItselfIsInterrupted =
	property.exhaust(finite(interruptedGen), {
		needs: { cluster: workerCluster },
		situations: ["the first case hangs", "after finished cases"] satisfies ReadonlyArray<
			Reached<Held>
		>,
		check:
			({ cluster }, c: Case<Held>) =>
			(drawnSearch) =>
				Effect.gen(function* () {
					const counts = { started: 0, finished: 0, released: 0 }
					const hung = yield* Deferred.make<void>()
					const holding = (index: number) =>
						Effect.scoped(
							Effect.gen(function* () {
								yield* Effect.acquireRelease(Effect.void, () =>
									Effect.sync(() => {
										counts.released++
									})
								)
								if (index === drawnSearch.hangs) {
									yield* Deferred.succeed(hung, undefined)
									return yield* Effect.never
								}
								yield* Effect.yieldNow
								counts.finished++
							})
						)
					const id = `case-run.test.ts#interrupted/${drawnSearch.hangs}`
					const services = yield* cluster
					const check = yield* Effect.forkChild(
						Effect.provide(
							searchInline(
								property.explore(int(0, 2 ** 31 - 1), {
									needs: {},
									situations: [],
									check: () => () => Effect.suspend(() => holding(counts.started++)),
									oracle: {
										kind: "specification",
										name: "a search planted to hang one case, interrupted from outside"
									},
									kept: [],
									kills: []
								}),
								inlineRun(id, fnv1a32(id))
							),
							services
						)
					)
					yield* Deferred.await(hung)
					yield* Fiber.interrupt(check)
					assert.equal(counts.released, counts.started)
					c.note(counts.finished > 0 ? "after finished cases" : "the first case hangs")
				}),
		oracle: {
			kind: "specification",
			name: "every acquisition of an interrupted search has its release"
		},
		box: "every place of the hanging case among the first six cases the search starts",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/literal.ts",
				original: `if (typeof value !== "bigint") {\n\t\t\t\treturn Result.err(\n\t\t\t\t\t\`a bigint for \${base.carrier === "int8" ? "bigint" : "an exact integer"}; a JavaScript number is not a bigint\`\n\t\t\t\t)\n\t\t\t}\n\t\t\treturn Result.ok({ kind: "int", value })\n\t\tcase "numeric": {\n\t\t\tif (typeof value === "number") {\n\t\t\t\treturn Result.err(\n\t\t\t\t\t"an exact decimal: a Decimal, a bigint or a decimal string, never a JavaScript number"\n\t\t\t\t)\n\t\t\t}\n\t\t\tconst parsed = decimalOfLiteral(value)\n\t\t\tif (!parsed.ok) {\n\t\t\t\treturn Result.err("an exact decimal literal")\n\t\t\t}\n\t\t\t/**\n\t\t\t * Native coercion happens before the value is a value of the type: a literal at\n\t\t\t * numeric(p, s), a contract over one included, rounds half away from zero to scale s as the domain cast does,\n\t\t\t * and only a rounded value that overflows the precision, an infinity, or NaN at scale 0, whose values are\n\t\t\t * integers (ir/carriers.ts isIntegerTypmod), is refused.\n\t\t\t */\n\t\t\tconst { typmod } = base\n\t\t\tif (typmod === undefined) {\n\t\t\t\treturn withinBound(parsed.value, base.bound).ok\n\t\t\t\t\t? Result.ok({ kind: "numeric", value: parsed.value })\n\t\t\t\t\t: Result.err(\n\t\t\t\t\t\t\t\`a value within its computed bound: NaN, an infinity, or a value below 10^\${base.bound.digits} in magnitude of at most \${base.bound.scale} fraction digits\`\n\t\t\t\t\t\t)\n\t\t\t}\n\t\t\tconst { precision, scale } = typmod\n\t\t\tconst coerced = normalizeNumeric(parsed.value, typmod)\n\t\t\tif (!coerced.ok) {\n\t\t\t\treturn Result.err(\n\t\t\t\t\tcoerced.error === "numericInfinity"\n\t\t\t\t\t\t? \`a finite value: numeric(\${precision},\${scale}) cannot hold an infinite value\`\n\t\t\t\t\t\t: coerced.error === "numericNaN"\n\t\t\t\t\t\t\t? \`an integer: numeric(\${precision},\${scale}) holds integers alone, never NaN\`\n\t\t\t\t\t\t\t: \`a value that fits numeric(\${precision},\${scale}) once rounded to its scale\`\n\t\t\t\t)\n\t\t\t}\n\t\t\treturn Result.ok({ kind: "numeric", value: coerced.value })\n\t\t}`,
				replacement: `{    if (typeof value === "number") {     return Result.err(      "an exact decimal: a Decimal, a bigint or a decimal string, never a JavaScript number"     )    }    const parsed = decimalOfLiteral(value)    if (!parsed.ok) {     return Result.err("an exact decimal literal")    }    /**     * Native coercion happens before the value is a value of the type: a literal at     * numeric(p, s), a contract over one included, rounds half away from zero to scale s as the domain cast does,     * and only a rounded value that overflows the precision, an infinity, or NaN at scale 0, whose values are     * integers (ir/carriers.ts isIntegerTypmod), is refused.     */    const { typmod } = base    if (typmod === undefined) {     return withinBound(parsed.value, base.bound).ok      ? Result.ok({ kind: "numeric", value: parsed.value })      : Result.err(        \`a value within its computed bound: NaN, an infinity, or a value below 10^\${base.bound.digits} in magnitude of at most \${base.bound.scale} fraction digits\`       )    }    const { precision, scale } = typmod    const coerced = normalizeNumeric(parsed.value, typmod)    if (!coerced.ok) {     return Result.err(      coerced.error === "numericInfinity"       ? \`a finite value: numeric(\${precision},\${scale}) cannot hold an infinite value\`       : coerced.error === "numericNaN"        ? \`an integer: numeric(\${precision},\${scale}) holds integers alone, never NaN\`        : \`a value that fits numeric(\${precision},\${scale}) once rounded to its scale\`     )    }    return Result.ok({ kind: "numeric", value: coerced.value })   }   case "numeric": if (typeof value !== "bigint") {     return Result.err(      \`a bigint for \${base.carrier === "int8" ? "bigint" : "an exact integer"}; a JavaScript number is not a bigint\`     )    }    return Result.ok({ kind: "int", value })`,
				why: `Operator mutant b39501fcb9 at packages/engine/src/scalar/compute/literal.ts in literalOf: \`if (typeof value !== "bigint") {     return Result.err(      \`a bigint for \${base.carrier === "int8" ? "bigint" : "an exact integer"}; a JavaScript number is not a bigint\`     )    }    return Result.ok({ kind: "int", value })   case "numeric": {    if (typeof value === "number") {     return Result.err(      "an exact decimal: a Decimal, a bigint or a decimal string, never a JavaScript number"     )    }    const parsed = decimalOfLiteral(value)    if (!parsed.ok) {     return Result.err("an exact decimal literal")    }    /**     * Native coercion happens before the value is a value of the type: a literal at     * numeric(p, s), a contract over one included, rounds half away from zero to scale s as the domain cast does,     * and only a rounded value that overflows the precision, an infinity, or NaN at scale 0, whose values are     * integers (ir/carriers.ts isIntegerTypmod), is refused.     */    const { typmod } = base    if (typmod === undefined) {     return withinBound(parsed.value, base.bound).ok      ? Result.ok({ kind: "numeric", value: parsed.value })      : Result.err(        \`a value within its computed bound: NaN, an infinity, or a value below 10^\${base.bound.digits} in magnitude of at most \${base.bound.scale} fraction digits\`       )    }    const { precision, scale } = typmod    const coerced = normalizeNumeric(parsed.value, typmod)    if (!coerced.ok) {     return Result.err(      coerced.error === "numericInfinity"       ? \`a finite value: numeric(\${precision},\${scale}) cannot hold an infinite value\`       : coerced.error === "numericNaN"        ? \`an integer: numeric(\${precision},\${scale}) holds integers alone, never NaN\`        : \`a value that fits numeric(\${precision},\${scale}) once rounded to its scale\`     )    }    return Result.ok({ kind: "numeric", value: coerced.value })   }\` becomes \`{    if (typeof value === "number") {     return Result.err(      "an exact decimal: a Decimal, a bigint or a decimal string, never a JavaScript number"     )    }    const parsed = decimalOfLiteral(value)    if (!parsed.ok) {     return Result.err("an exact decimal literal")    }    /**     * Native coercion happens before the value is a value of the type: a literal at     * numeric(p, s), a contract over one included, rounds half away from zero to scale s as the domain cast does,     * and only a rounded value that overflows the precision, an infinity, or NaN at scale 0, whose values are     * integers (ir/carriers.ts isIntegerTypmod), is refused.     */    const { typmod } = base    if (typmod === undefined) {     return withinBound(parsed.value, base.bound).ok      ? Result.ok({ kind: "numeric", value: parsed.value })      : Result.err(        \`a value within its computed bound: NaN, an infinity, or a value below 10^\${base.bound.digits} in magnitude of at most \${base.bound.scale} fraction digits\`       )    }    const { precision, scale } = typmod    const coerced = normalizeNumeric(parsed.value, typmod)    if (!coerced.ok) {     return Result.err(      coerced.error === "numericInfinity"       ? \`a finite value: numeric(\${precision},\${scale}) cannot hold an infinite value\`       : coerced.error === "numericNaN"        ? \`an integer: numeric(\${precision},\${scale}) holds integers alone, never NaN\`        : \`a value that fits numeric(\${precision},\${scale}) once rounded to its scale\`     )    }    return Result.ok({ kind: "numeric", value: coerced.value })   }   case "numeric": if (typeof value !== "bigint") {     return Result.err(      \`a bigint for \${base.carrier === "int8" ? "bigint" : "an exact integer"}; a JavaScript number is not a bigint\`     )    }    return Result.ok({ kind: "int", value })\`; the property fails (the census, lane TESTPOLICY2).`
			}
		]
	})
