import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import plugin from "#oxlint/plugin.ts"

RuleTester.describe = describe
RuleTester.it = it

/** The imports every case starts from, so each name resolves as it does in a real test file. */
const HEADER = `import { Array as Arr, Cause, Clock, DateTime, Duration, Effect, Equal, Exit, Formatter, HashMap, HashSet, Inspectable, Option, Order, Predicate, Random, Record, Result, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { describe, flakyTest, it, layer } from "@effect/vitest"
import { assertEquals, assertExitSuccess, assertFalse, assertInclude, assertMatch, assertNone, assertSome, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { expect, test } from "vitest"
import assert from "node:assert"
import { agree, exact, multiset, set } from "@superstarter/testing/oracle"
import { exhaust } from "@superstarter/testing/explore"
import { element } from "@superstarter/testing/gen"
`

const tester = new RuleTester({
	languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } }
})

/** A case its rule leaves alone, named by its body. */
const valid = (body: string): RuleTester.ValidTestCase => ({
	name: body,
	code: `${HEADER}${body}\n`
})

/** A case its rule reports `count` times under its one message, named by its body. */
const invalid = (body: string, messageId: string, count: number): RuleTester.InvalidTestCase => ({
	name: body,
	code: `${HEADER}${body}\n`,
	errors: Arr.replicate({ messageId }, count)
})

tester.run("no-ordered-unordered", plugin.rules["no-ordered-unordered"], {
	valid: [
		valid('agree([["set", [...new Set(ids)]], ["list", ids]], multiset(exact))'),
		valid('agree([["keys", Object.keys(record)], ["expected", ["a", "b"]]], set(exact))'),
		valid("deepStrictEqual(Arr.sort([...new Set(ids)], Order.Number), [1, 2, 3])"),
		valid("const items = [1, 2]\ndeepStrictEqual([...items], [1, 2])"),
		valid("deepStrictEqual(Arr.fromIterable(chunk), [1, 2])"),
		valid("deepStrictEqual(Array.from({ length: 3 }, (_, index) => index), [0, 1, 2])"),
		valid("strictEqual(Object.keys(record).length, 2)"),
		valid("strictEqual(HashSet.size(HashSet.make(1, 2)), 2)")
	],
	invalid: [
		invalid("deepStrictEqual([...new Set([3, 1, 2])], [3, 1, 2])", "unordered", 1),
		invalid("const seen = new Set(ids)\ndeepStrictEqual([...seen], ids)", "unordered", 1),
		invalid('expect(Object.keys(record)).toEqual(["a", "b"])', "unordered", 1),
		invalid("expect(Object.values(totals)).not.toEqual([1])", "unordered", 1),
		invalid("assert.deepStrictEqual(Array.from(index.values()), [1, 2])", "unordered", 1),
		invalid("deepStrictEqual(Arr.fromIterable(HashSet.make(1, 2)), [1, 2])", "unordered", 1),
		invalid('assert.deepEqual(Arr.fromIterable(cache.keys()), ["a"])', "unordered", 1),
		invalid('assertEquals(Record.keys(scores), ["ada", "grace"])', "unordered", 1),
		invalid("expect([...byId.entries()]).toStrictEqual(entries)", "unordered", 1),
		invalid(
			'deepStrictEqual({ names: HashMap.toValues(byName) }, { names: ["a"] })',
			"unordered",
			1
		)
	]
})

tester.run("no-error-prose", plugin.rules["no-error-prose"], {
	valid: [
		valid('strictEqual(error._tag, "TodoNotFound")'),
		valid("deepStrictEqual(error, new TodoNotFound({ id }))"),
		valid("strictEqual(left.message, right.message)"),
		valid('expect(() => parse("")).toThrow(ParseFailure)'),
		valid('strictEqual(String(count), "3")'),
		valid("assertMatch(slug, /^[a-z]+$/)")
	],
	invalid: [
		invalid('strictEqual(error.message, "todo not found")', "errorProse", 1),
		invalid('expect(failure.message).toBe("boom")', "errorProse", 1),
		invalid("assertMatch(Cause.pretty(cause), /TodoNotFound/)", "errorProse", 1),
		invalid('assertInclude(String(error), "not found")', "errorProse", 1),
		invalid('strictEqual(err.toString(), "Error: boom")', "errorProse", 1),
		invalid('strictEqual(Formatter.format(defect), "boom")', "errorProse", 1),
		invalid("const text = error.message\nassert.match(text, /boom/)", "errorProse", 1),
		invalid('expect(() => parse("")).toThrow("empty input")', "errorProse", 1),
		invalid('expect(() => parse("")).toThrowError(/empty/)', "errorProse", 1),
		invalid('await expect(promise).rejects.toThrow("boom")', "errorProse", 1),
		invalid('assert.throws(() => parse(""), { message: "empty input" })', "errorProse", 1),
		invalid('expect(result.error).toHaveProperty("message", "boom")', "errorProse", 1)
	]
})

tester.run("no-serialized-comparison", plugin.rules["no-serialized-comparison"], {
	valid: [
		valid('agree([["stored", stored], ["read", read]], exact)'),
		valid(`strictEqual(spanName, \`superstarter.\${operation}\`)`),
		valid('strictEqual(render(todo), "buy milk")'),
		valid('strictEqual(String(error), "Error: boom")'),
		valid("strictEqual(`plain`, value)"),
		valid("const same = first === second"),
		valid("const big = String(size) + unit")
	],
	invalid: [
		invalid("strictEqual(JSON.stringify(todo), JSON.stringify(expected))", "serialized", 1),
		invalid("const same = JSON.stringify(first) === JSON.stringify(second)", "serialized", 1),
		invalid('if (String(id) !== "42") {\n\tfail()\n}', "serialized", 1),
		invalid('strictEqual(String(id), "42")', "serialized", 1),
		invalid('expect(Formatter.format(value)).toBe("{ a: 1 }")', "serialized", 1),
		invalid(`strictEqual(\`\${point.x},\${point.y}\`, "1,2")`, "serialized", 1),
		invalid('assert.equal(total.toString(), "10")', "serialized", 1),
		invalid("const json = JSON.stringify(state)\nassertEquals(json, saved)", "serialized", 1),
		invalid("deepStrictEqual(rendered, Inspectable.toStringUnknown(value))", "serialized", 1)
	]
})

tester.run("no-example-table", plugin.rules["no-example-table"], {
	valid: [
		valid(
			'it.effect("adds one", () => exhaust({ name: "adds", space: element([1, 2, 3]) }, (input) => check(input)))'
		),
		valid(
			'it("sums", () => {\n\tconst inputs = generate(size)\n\tfor (const input of inputs) {\n\t\tcheck(input)\n\t}\n})'
		),
		valid("const helper = () => {\n\tfor (const value of [1, 2]) {\n\t\tuse(value)\n\t}\n}"),
		valid(
			'it("runs", () => {\n\tconst run = () => {\n\t\tfor (const value of [1, 2]) {\n\t\t\tuse(value)\n\t\t}\n\t}\n\trun()\n})'
		),
		valid('it.each(rowsOf(size))("case", (row) => check(row))'),
		valid(
			'it.effect("checks every mode", () =>\n\texplore(spec, (value) =>\n\t\tEffect.sync(() => {\n\t\t\tfor (const mode of ["read", "write"]) {\n\t\t\t\tcheck(mode, value)\n\t\t\t}\n\t\t})\n\t)\n)'
		)
	],
	invalid: [
		invalid(
			'it.each([[1, 2], [2, 3]])("adds one to %i", (input, output) => {\n\tstrictEqual(input + 1, output)\n})',
			"exampleTable",
			1
		),
		invalid('it.effect.each([1, 2])("runs %i", (n) => Effect.void)', "exampleTable", 1),
		invalid('describe.each([{ a: 1 }])("suite", () => {})', "exampleTable", 1),
		invalid('test.for([1, 2])("case %i", (n) => {})', "exampleTable", 1),
		invalid(
			`it.each\`\n\ta | b\n\t\${1} | \${2}\n\`("adds", ({ a, b }) => {\n\tstrictEqual(a + 1, b)\n})`,
			"exampleTable",
			1
		),
		invalid(
			'const cases = [{ input: 1, output: 2 }] as const\nit.each(cases)("case", ({ input, output }) => {\n\tstrictEqual(input + 1, output)\n})',
			"exampleTable",
			1
		),
		invalid(
			'it("adds one", () => {\n\tfor (const [input, output] of [[1, 2], [2, 3]]) {\n\t\tstrictEqual(input + 1, output)\n\t}\n})',
			"exampleTable",
			1
		),
		invalid(
			'it.effect("adds one", () =>\n\tEffect.gen(function* () {\n\t\tfor (const input of [1, 2]) {\n\t\t\tyield* check(input)\n\t\t}\n\t})\n)',
			"exampleTable",
			1
		),
		invalid(
			'const inputs = [1, 2]\ndescribe("parse", () => {\n\tfor (const input of inputs) {\n\t\tit("parses", () => check(input))\n\t}\n})',
			"exampleTable",
			1
		)
	]
})

tester.run("no-boolean-assert", plugin.rules["no-boolean-assert"], {
	valid: [
		valid("assertSome(found, 1)"),
		valid("assertExitSuccess(exit, 1)"),
		valid("assertNone(found)"),
		valid('strictEqual(error._tag, "TodoNotFound")'),
		valid("assertTrue(isPrime(7))"),
		valid("expect(value).toBe(true)"),
		valid("strictEqual(flag, false)"),
		valid('assert.ok(!Equal.equals(left, right), "equal contents are canonically equal")'),
		valid("assertTrue(left === right, describe(left, right))"),
		valid('strictEqual(Option.isSome(found), true, "every inserted id is found")'),
		valid('expect(Exit.isSuccess(exit), "the retried set succeeds").toBe(true)')
	],
	invalid: [
		invalid("assertTrue(Option.isSome(found))", "booleanAssert", 1),
		invalid("assertTrue(Exit.isSuccess(exit))", "booleanAssert", 1),
		invalid("assertFalse(Exit.isFailure(exit))", "booleanAssert", 1),
		invalid("assert.ok(Result.isFailure(result))", "booleanAssert", 1),
		invalid("assert(left === right)", "booleanAssert", 1),
		invalid("expect(Option.isNone(found)).toBe(true)", "booleanAssert", 1),
		invalid("expect(todo.done === true).toBeTruthy()", "booleanAssert", 1),
		invalid('assertTrue(Predicate.isTagged(error, "TodoNotFound"))', "booleanAssert", 1),
		invalid('assertTrue(Predicate.isTagged("TodoNotFound")(error))', "booleanAssert", 1),
		invalid("strictEqual(Equal.equals(left, right), true)", "booleanAssert", 1),
		invalid("const succeeded = Exit.isSuccess(exit)\nassertTrue(succeeded)", "booleanAssert", 1),
		invalid("assertTrue(!Option.isSome(found))", "booleanAssert", 1)
	]
})

tester.run("no-fixed-seed", plugin.rules["no-fixed-seed"], {
	valid: [
		valid("explore(spec, property)"),
		valid("Run.of({ seed, source, replay, fuzz })"),
		valid("Run.of({ ...run, seed: run.seed })"),
		valid("wordsOf(caseSeed(stream, index))"),
		valid("const options = { size: 3 }"),
		valid("const sketch = { seed: 42, moves: 3 }"),
		valid('explore({ name: "sorts", seed: 42 }, property)')
	],
	invalid: [
		invalid('const run = Run.of({ seed: 41, source: "environment" })', "fixedSeed", 1),
		invalid("program.pipe(Random.withSeed(7))", "fixedSeed", 1),
		invalid('Random.withSeed(program, "fixed")', "fixedSeed", 1),
		invalid("wordsOf(1234)", "fixedSeed", 1),
		invalid("const SEED = 99\nconst run = Run.of({ seed: SEED })", "fixedSeed", 1),
		invalid("const run = Run.of({ seed: -1 })", "fixedSeed", 1)
	]
})

tester.run("no-sleep-wait", plugin.rules["no-sleep-wait"], {
	valid: [
		valid('const step = TestClock.adjust("1 second")'),
		valid("const fact = awaitFact(isReady)"),
		valid("const repeated = effect.pipe(Effect.repeat(Schedule.recurs(3)))"),
		valid("const second = Duration.seconds(1)")
	],
	invalid: [
		invalid('const wait = Effect.sleep("100 millis")', "sleep", 1),
		invalid('const delayed = effect.pipe(Effect.delay("1 second"))', "sleep", 1),
		invalid("await new Promise((resolve) => setTimeout(resolve, 50))", "sleep", 1),
		invalid("const poll = setInterval(check, 10)", "sleep", 1),
		invalid('const repeated = effect.pipe(Effect.repeat(Schedule.spaced("1 second")))', "sleep", 1),
		invalid(
			'const retried = effect.pipe(Effect.retry(Schedule.exponential("10 millis")))',
			"sleep",
			1
		),
		{
			name: "await wait(10), wait being node's setTimeout from timers/promises",
			code: `import { setTimeout as wait } from "node:timers/promises"\n${HEADER}await wait(10)\n`,
			errors: [{ messageId: "sleep" }]
		}
	]
})

tester.run("no-wall-clock-verdict", plugin.rules["no-wall-clock-verdict"], {
	valid: [
		valid("const epoch = new Date(0)"),
		valid('const step = TestClock.adjust("1 second")'),
		valid('const parsed = DateTime.makeUnsafe("2026-01-01")'),
		valid('const later = Date.parse("2026-01-01")')
	],
	invalid: [
		invalid("const started = performance.now()", "wallClock", 1),
		invalid("const now = Date.now()", "wallClock", 1),
		invalid("const today = new Date()", "wallClock", 1),
		invalid("const stamp = Date()", "wallClock", 1),
		invalid("const millis = Clock.currentTimeMillis", "wallClock", 1),
		invalid("const nanos = Clock.currentTimeNanos", "wallClock", 1),
		invalid("const now = DateTime.now", "wallClock", 1),
		invalid("const now = DateTime.nowUnsafe()", "wallClock", 1),
		invalid("const elapsed = process.hrtime.bigint()", "wallClock", 1)
	]
})

tester.run("no-retry-or-concurrency", plugin.rules["no-retry-or-concurrency"], {
	valid: [
		valid('it.effect("deterministic", () => Effect.void)'),
		valid('layer(TodoLayer)("todos", (it) => {\n\tit.effect("reads", () => Effect.void)\n})'),
		valid('describe("suite", { concurrent: false }, () => {})'),
		valid('it("bounded", { timeout: 1000 }, () => {})'),
		valid('const fibers = Effect.forEach(tasks, run, { concurrency: "unbounded" })'),
		valid("const options = { retry: 3 }")
	],
	invalid: [
		invalid(
			'it.effect("eventually", () => flakyTest(check, "5 seconds"))',
			"retryOrConcurrency",
			1
		),
		invalid("const eventually = it.flakyTest(check)", "retryOrConcurrency", 1),
		invalid('it("flaky", { retry: 3 }, () => {})', "retryOrConcurrency", 1),
		invalid('test("flaky", () => {}, { retry: 2 })', "retryOrConcurrency", 1),
		invalid('it.effect("flaky", () => Effect.void, { retry: 1 })', "retryOrConcurrency", 1),
		invalid(
			'const options = { retry: 3 }\nit("flaky", options, () => {})',
			"retryOrConcurrency",
			1
		),
		invalid('it.concurrent("fast", () => {})', "retryOrConcurrency", 1),
		invalid('describe.concurrent("suite", () => {})', "retryOrConcurrency", 1),
		invalid('test.concurrent.each([1])("case", () => {})', "retryOrConcurrency", 1),
		invalid('describe("suite", { concurrent: true }, () => {})', "retryOrConcurrency", 1),
		invalid('layer(TodoLayer, { concurrent: true })("todos", (it) => {})', "retryOrConcurrency", 1),
		invalid(
			'it.layer(TodoLayer, { concurrent: true })("todos", (it) => {})',
			"retryOrConcurrency",
			1
		)
	]
})
