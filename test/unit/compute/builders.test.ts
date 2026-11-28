/**
 * The scalar builders' typing (scalar/compute/builders.ts, scalar/compute/typing.ts) and the boundary where a JavaScript
 * caller's operands meet them.
 *
 * - Typing: every binary builder over every pair of operands, every conditional's two branches and every span function
 *   is typed, or refused as MalformedDescription, exactly as the builders' typing rules say, over the whole box.
 *   Oracle: the typing rules as a checker (nominalOf, hostKindOf, the span's own endpoint).
 * - Wild operands: a literal's type, a cast's target and a literal's value build from a descriptor a builder made and
 *   an int8 bigint, and every wild value is refused as MalformedDescription. Oracle: the boundary's specification.
 *
 * Features: each binary builder typed and refused but an equality, which meets every pair of the box's operands, all of
 * one base carrier, bigint; a conditional typed and refused, each span function typed and refused; live and every wild
 * kind at each site.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, oneOf } from "@bjornpagen/testing/gen"
import { drawnFeature, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { type ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { exactType, sameCarrier } from "#compiler/scalar/compute/types.ts"
import { testPg, testSpan, v } from "#test/support/unit/compute/support.ts"
import {
	binary,
	type BinaryOp,
	boundaryCaseGen,
	type BoundaryFeature,
	type BuilderCase,
	type BuilderFeature,
	cents,
	type Endpoint,
	endpointOf,
	firstOf,
	firsts,
	flag,
	hostKindOf,
	int,
	nominalOf,
	operands,
	otherOf,
	others,
	type SpanFn,
	operandTerms,
	throws,
	typedAs,
	typeOf,
	wrongEndpointOf
} from "#test/unit/compute/builders.fixtures.ts"

/** scalar builders type and refuse operands by the builders' typing rules. */
export const computeBuildersTypeAndRefuseOperandsByTheBuildersTypingRules = property.exhaust(
	finite(
		oneOf<BuilderCase>([
			(source) => ({
				kind: "binary",
				op: source.draw(element<BinaryOp>(["add", "eq", "least", "greatest"])),
				a: source.draw(element(operands)),
				b: source.draw(element(operands))
			}),
			(source) => ({
				kind: "cond",
				first: source.draw(element(firsts)),
				other: source.draw(element(others))
			}),
			(source) => ({
				kind: "span",
				fn: source.draw(element<SpanFn>(["lower", "upper", "width"])),
				endpoint: source.draw(element<Endpoint>(["cents", "integer", "bigint"])),
				descriptor: source.draw(element(["own", "other"] as const)),
				operand: source.draw(element(["span", "no span"] as const))
			})
		])
	),
	{
		needs: {},
		situations: [
			"binary add typed",
			"binary add refused",
			"binary eq typed",
			"binary least typed",
			"binary least refused",
			"binary greatest typed",
			"binary greatest refused",
			"cond typed",
			"cond refused",
			"span lower typed",
			"span lower refused",
			"span upper typed",
			"span upper refused",
			"span width typed",
			"span width refused"
		] satisfies ReadonlyArray<Reached<BuilderFeature>>,
		check: (_, c: Case<BuilderFeature>) => (sketch: BuilderCase) =>
			Effect.sync(() => {
				switch (sketch.kind) {
					case "binary": {
						const [a, b] = [sketch.a, sketch.b]
						const build = () => binary[sketch.op](operandTerms[a], operandTerms[b])
						const meets =
							sketch.op === "eq"
								? sameCarrier(nominalOf[a].scalar, nominalOf[b].scalar)
								: sameScalarType(nominalOf[a].scalar, nominalOf[b].scalar)
						if (!meets) {
							c.note(`binary ${sketch.op} refused`)
							assert.equal(
								throws(build).reason._tag,
								"MalformedDescription",
								`${sketch.op}(${a}, ${b})`
							)
							return
						}
						c.note(`binary ${sketch.op} typed`)
						const built = build()
						if (built === "predicate") {
							return
						}
						const expected =
							sketch.op === "add" ? exactType("exactInteger", 20) : nominalOf[a].scalar
						assert.ok(
							sameScalarType(built, expected),
							`${sketch.op}(${a}, ${b}) typed ${typeLabel(built)}`
						)
						return
					}
					case "cond": {
						const [firstName, otherName] = [sketch.first, sketch.other]
						const [first, other] = [firstOf[firstName], otherOf[otherName]]
						const build = () => computeCore.cond(flag, first.operand, other.operand)
						const meets =
							first.term !== undefined &&
							(other.meets.kind === "typed"
								? sameScalarType(other.meets.type.scalar, first.term.scalar)
								: other.meets.host === hostKindOf(first.term))
						if (first.term === undefined || !meets) {
							c.note("cond refused")
							assert.equal(
								throws(build).reason._tag,
								"MalformedDescription",
								`cond(${firstName}, ${otherName})`
							)
							return
						}
						c.note("cond typed")
						assert.equal(typedAs(build(), first.term), true, `cond(${firstName}, ${otherName})`)
						return
					}
					case "span": {
						const endpoint = endpointOf[sketch.endpoint]
						const operand = sketch.operand === "span" ? v("s", testSpan(endpoint)) : cents
						const descriptor =
							sketch.descriptor === "own" ? endpoint : wrongEndpointOf[sketch.endpoint]
						const build = () => computeCore[sketch.fn](operand, descriptor)
						if (sketch.operand === "no span" || sketch.descriptor === "other") {
							c.note(`span ${sketch.fn} refused`)
							assert.equal(throws(build).reason._tag, "MalformedDescription")
							return
						}
						c.note(`span ${sketch.fn} typed`)
						const built = typeOf(build())
						assert.ok(
							sketch.fn === "width"
								? built.carrier === "exactInteger"
								: sameScalarType(built, endpoint.scalar),
							`${sketch.fn} over a span of ${sketch.endpoint}`
						)
						return
					}
				}
			}),
		oracle: { kind: "specification", name: "the builders' typing rules as a checker" },
		box: "every binary builder over every pair of operands, every conditional's two branches, and every span function over each endpoint, descriptor and operand",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: "\t\tif (span !== undefined && !compatible(span.endpoint, field.scalar)) {",
				replacement: "\t\tif (span === undefined) {",
				why: "A span function takes any endpoint descriptor, its span's own or not; the typing property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\tif (!meets(against, term.nominal) && !refinedPair(against, term.nominal)) {",
				replacement: "\t\tif (!meets(against, term.nominal)) {",
				why: "An equality of two refinements of one base carrier, Cents and EpochDay, or Cents and a bigint, is refused as any comparison of two types is; the typing property fails."
			},
			{
				file: "packages/engine/src/scalar/literal.ts",
				original:
					'\t\tcase "int8":\n\t\t\treturn typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")',
				replacement:
					'\t\tcase "int8":\n\t\t\treturn typeof value === "number" ? Result.ok(BigInt(value)) : typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")',
				why: "A JavaScript number is read as a bigint literal's value; the typing and wild operands properties fail."
			}
		]
	}
)

/** A JavaScript caller's operands build from a descriptor and an int8 literal, and refuse every wild descriptor and value as malformed. Its budget is its suite's before it was a property (test/unit/compute/builders.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const aJavaScriptCallersOperandsBuildFromADescriptorAndAnInt8LiteralAndRefuseEveryWildDescriptorAndValueAsMalformed =
	property.explore(boundaryCaseGen, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: [
			"live",
			...Arr.map(WILD_KINDS, (kind): BoundaryFeature => `wild ${kind}`),
			"site literal type",
			"site cast target",
			"site literal value"
		] satisfies ReadonlyArray<Reached<BoundaryFeature>>,
		check:
			(_, c: Case<BoundaryFeature>) =>
			([d, site]) =>
				Effect.sync(() => {
					c.note(drawnFeature(d))
					c.note(`site ${site}`)
					const x = passed(d)
					const build = (): ScalarTerm => {
						switch (site) {
							case "literal type":
								return computeCore.literal(x, 1n)
							case "cast target":
								return computeCore.cast(int, x)
							case "literal value":
								return computeCore.literal(testPg.bigint, x)
						}
					}
					/**
					 * An int8 literal admits exactly a bigint within int8's range (the literal boundary admits any bigint, and
					 * building the term refuses one outside the range): the wild kind bigint-for-number draws both. No wild
					 * value is a descriptor a builder made.
					 */
					const admitted =
						d.kind === "live" ||
						(site === "literal value" && typeof x === "bigint" && x >= int8Min && x <= int8Max)
					if (admitted) {
						assert.equal(typedAs(build(), testPg.bigint), true)
					} else {
						assert.equal(throws(build).reason._tag, "MalformedDescription")
					}
				}),
		oracle: {
			kind: "specification",
			name: "a descriptor a builder made and an int8 bigint build; every wild value is malformed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/literal.ts",
				original:
					'\t\tcase "int8":\n\t\t\treturn typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")',
				replacement:
					'\t\tcase "int8":\n\t\t\treturn typeof value === "number" ? Result.ok(BigInt(value)) : typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")',
				why: "A JavaScript number is read as a bigint literal's value; the typing and wild operands properties fail."
			}
		]
	})
