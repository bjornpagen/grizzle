import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { type CompileReasonTag, isCompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { admitRegex } from "#compiler/text/field.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { checked } from "#test/types/batch/groups.ts"
import { type Category, type Row, rows } from "#test/types/regex/matrix.ts"
import { jsAccepts } from "#test/unit/text/generators.ts"

import { regex } from "arkregex"
/**
 * The regex inference gate: literal and template inference, widening, malformed patterns and rejected flags behave as
 * matrix.ts states.
 *
 * 1. The matrix becomes one generated program (./program.ts): per row, the str.regex call, the members assigned to the
 *    host type, the outside values refused by it, and where the scan widens, the host type exactly string. The program
 *    typechecks with no diagnostic, and with its directives disarmed raises exactly the refusals they name on exactly
 *    their lines, so a refusal cannot pass for the wrong reason. The type-test batch (test/types/batch) checks it both
 *    ways.
 * 2. At runtime: every member is accepted by ECMAScript (the development oracle) and by the compiler's NFA, every
 *    outside value is rejected by ECMAScript, so the type's refusal is sound, and the compiler's grammar check reaches
 *    the admission the row states. For admitted flags its reason agrees with ECMAScript: MalformedDescription exactly
 *    when ECMAScript reports a syntax error in the source. Any other flags value is MalformedDescription whatever
 *    ECMAScript makes of it, as an argument the types already forbid, and a JavaScript caller passing one throws
 *    MalformedDescription. A call written with literals that the types refuse is never an admitted pattern.
 * 3. Typed authoring requires a literal source and literal flags: the nonLiteral rows call str.regex with
 *    a source typed string, a template with a hole, a union of sources and flags typed "u" | "su", each refused with
 *    TS2345 although the value a JavaScript caller would hold there is admitted, and a literal type read through a
 *    variable still infers.
 *
 * Whether ECMAScript refuses the source or the flags as a syntax error; the development oracle only.
 */
const ecmaSyntaxError = (source: string, flags: string): boolean => {
	const compiled = Result.try(() => new RegExp(source, flags))
	if (Result.isSuccess(compiled)) {
		return false
	}
	if (compiled.failure instanceof SyntaxError) {
		return true
	}
	throw new Error(`RegExp threw no SyntaxError for /${source}/${flags}`, {
		cause: compiled.failure
	})
}

const isAdmittedFlags = (flags: string): flags is RegexFlags => flags === "u" || flags === "su"

/**
 * The compiler's decision: a flags word other than u and su is refused at the description's boundary as malformed
 * structure, and an admitted one is analyzed.
 */
const admissionOf = (row: Row): CompileReasonTag | "admitted" => {
	if (!isAdmittedFlags(row.flags)) {
		return "MalformedDescription"
	}
	const result = analyzeText(row.source, row.flags, SourceLoc("matrix", [row.name]))
	return !result.ok ? result.error.reason._tag : "admitted"
}

/** TS2820 is TS2322 with a member the checker's heuristic suggests: the same refusal. */
const refusal = (key: string): string => Str.replace(regex(":TS2820$"), ":TS2322")(key)

/**
 * One row's membership and admission: the compiler's admission is the row's, a refused literal call is never admitted,
 * a refused flag is MalformedDescription, ECMAScript reports a syntax error exactly where the row is malformed, every
 * member is accepted and every outside value rejected by ECMAScript and, for an admitted row, by the compiler's NFA.
 */
const rowHolds = (row: Row): void => {
	assert.equal(admissionOf(row), row.admission)
	if (row.host.kind === "refused" && row.category !== "nonLiteral") {
		assert.notEqual(row.admission, "admitted")
	}
	if (!isAdmittedFlags(row.flags)) {
		assert.equal(row.admission, "MalformedDescription")
		return
	}
	assert.equal(ecmaSyntaxError(row.source, row.flags), row.admission === "MalformedDescription")
	const flags = row.flags
	for (const member of row.members) {
		assert.equal(jsAccepts(row.source, flags, member), true)
	}
	for (const value of row.outside) {
		assert.equal(jsAccepts(row.source, flags, value), false)
	}
	if (row.admission !== "admitted") {
		return
	}
	const refinement = succeeded(
		analyzeText(row.source, flags, SourceLoc("matrix", [row.name])),
		row.name
	)
	for (const member of row.members) {
		assert.equal(accepts(refinement, member), true)
	}
	for (const value of row.outside) {
		assert.equal(accepts(refinement, value), false)
	}
}

/** Every category of the matrix, each of which the exhaustive check must reach. */
const categories: Arr.NonEmptyReadonlyArray<Category> = [
	"literal",
	"template",
	"widening",
	"length",
	"malformed",
	"flags",
	"outsideFragment",
	"escapes",
	"nonLiteral"
]

layer(NodeServices.layer, { excludeTestServices: true })("ArkRegex inference matrix", (it) => {
	it.effect("typechecks the generated matrix program with no diagnostic", () =>
		Effect.gen(function* () {
			const diagnostics = yield* checked("regex/matrix")
			assert.equal(diagnostics.output, "")
		})
	)

	it.effect("raises exactly the diagnostics the directives name, on exactly their lines", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("regex/matrix-disarmed")
			const refusals = Arr.filter(rows, (row) => row.host.kind === "refused").length
			const outside = Arr.reduce(rows, 0, (n, row) => n + row.outside.length)
			assert.equal(expected.length, refusals + outside)
			const refused: ReadonlyArray<string> = Arr.map(actual, refusal)
			assert.deepEqual(refused, expected)
		})
	)

	it.effect("holds every row's membership and admission", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "types/regex matrix",
					generator: element<Row>(nonEmpty(rows, "the matrix's rows")),
					literal: (row) => Formatter.format(row.name),
					limit: rows.length,
					coverage: requiredInSpace<Category>(categories),
					caseHang
				},
				(row, c) =>
					Effect.sync(() => {
						c.note(row.category)
						rowHolds(row)
					})
			)
		)
	)

	it("throws MalformedDescription for a refused flag from a JavaScript caller", () => {
		const flagRows = Arr.filter(rows, (r) => r.category === "flags")
		assert.equal(
			Arr.some(flagRows, (row) => !ecmaSyntaxError("a", row.flags)),
			true
		)
		assert.equal(
			Arr.some(flagRows, (row) => ecmaSyntaxError("a", row.flags)),
			true
		)
		for (const row of flagRows) {
			const refused = row.admission
			if (refused === "admitted") {
				assert.fail(`${row.name}: a refused flag is never admitted`)
			}
			assert.throws(
				() => admitRegex(row.source, row.flags),
				(error) => isCompileError(error) && error.reason._tag === refused,
				row.name
			)
		}
	})
})
