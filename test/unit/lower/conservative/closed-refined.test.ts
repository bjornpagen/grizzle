import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { conservativeMeta, type Heading } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { closed, decodedSchema, f, relation } from "#test/support/fixtures/ir/desc.ts"
import { installationOf, localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"
import { fixtureCodes } from "#test/unit/ir/fixture.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * A Closed source's refined payload delivered by the conservative lowering (lower/conservative/refined.ts Tracer): a
 * roster read with a query-local text payload p0 over the pattern ^[a-z]+$, its rows the node's own, which the
 * lowering emits as base-typed VALUES literals (lower/conservative/closed).
 *
 * - **A literal in the pattern is proved on the host:** every payload literal the pattern's automaton admits is
 *   delivered uncast, whether or not the installation names a domain for the pattern, so a pattern no stored column
 *   carries lowers at all (the audit's floor case at TEST_SEED=3928500770, whose roster K0 carried such a payload).
 * - **A literal outside it is the database's to refuse:** with a domain named for the pattern, the delivered p0 is cast
 *   to it, which PostgreSQL checks for every delivered row; with none, the lowering refuses, naming p0's refinement.
 * - **An empty source claims nothing:** its placeholder rows, under WHERE false, define no delivered value, so it is
 *   delivered uncast.
 *
 * The box: every sequence of zero to two payload values over one in the pattern, one outside it (a capital), each under
 * names with and without the pattern's domain, each the source projected whole or filtered to its rows (a derived table
 * the trace follows). The oracle is the pattern's membership read off the values the case states, never the tracer.
 */
type Value = "abc" | "Abc"

/** The names the case lowers under: production's stand-ins, with no domain for any pattern, or with the domain an
 * installation whose stored column carries the payload's pattern names for it. */
const plain: PhysicalNames = productionNames(
	"Rosters",
	{ kind: "declared" },
	localVectorSchema,
	fixtureCodes
)
const patterned = installationOf(
	decodedSchema({
		name: "Rosters",
		relations: [
			closed("Kind", ["Automatic", "Manual"]),
			relation("Word", { id: f.uuid, word: f.regex("^[a-z]+$", "u") }, ["id"])
		],
		statements: [],
		extends: undefined
	}),
	{ kind: "declared" }
).names.textDomain
const withDomain: PhysicalNames = { ...plain, textDomain: patterned }
/** The installed name of the pattern's domain, which a cast to it spells. */
const domainName = defined(
	T.code.carrier === "text" && T.code.text.regex !== "wildcard"
		? patterned(T.code.text.regex)
		: undefined,
	"the installation names a domain for the payload's pattern"
).name

interface Case {
	readonly payload: ReadonlyArray<Value>
	readonly domain: boolean
	readonly filtered: boolean
}

const payloadGen: Gen<ReadonlyArray<Value>> = element([
	[],
	["abc"],
	["Abc"],
	["abc", "abc"],
	["abc", "Abc"],
	["Abc", "Abc"]
])

const caseGen: Gen<Case> = (source) => ({
	payload: source.draw(payloadGen),
	domain: source.draw(element([false, true])),
	filtered: source.draw(element([false, true]))
})

type Feature =
	| "an in-pattern payload delivered uncast without a domain"
	| "an in-pattern payload delivered uncast beside a domain"
	| "an out-of-pattern payload cast to its domain"
	| "an out-of-pattern payload refused without a domain"
	| "an empty source delivered uncast"

const handles = ["Automatic", "Manual"] as const

const lowered = (c: Case) => {
	const q = new Q()
	const heading: Heading = [
		{ name: "id", type: T.kind },
		{ name: "p0", type: T.code }
	]
	const rows: ReadonlyArray<ReadonlyArray<TypedLiteral>> = Arr.map(c.payload, (value, i) => [
		{ kind: "handle", handle: handles[i] ?? "Automatic" },
		{ kind: "text", value }
	])
	const source = q.closed("K0", heading, rows)
	const over = c.filtered ? q.filter(source, q.lit({ kind: "bool", value: true }, T.bool)) : source
	const root = q.project(
		over,
		[
			["id", "id"],
			["p0", "p0"]
		],
		conservativeMeta
	)
	const query = q.build(root)
	return lowerConservative(conservativeInput(query), {
		names: c.domain ? withDomain : plain,
		params: query.params,
		subject: { kind: "query" }
	})
}

describe("a Closed source's refined payload", () => {
	it.effect(
		"is delivered uncast where the pattern admits every literal, cast to its domain or refused where one is outside",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/conservative/closed-refined",
						generator: caseGen,
						literal: Formatter.format,
						limit: 24,
						box: "zero to two payload values over one in the pattern and one outside, with and without the pattern's domain, projected whole or filtered",
						oracle: {
							kind: "specification",
							name: "the pattern's membership of each value the case states"
						},
						coverage: requiredInSpace<Feature>([
							"an in-pattern payload delivered uncast without a domain",
							"an in-pattern payload delivered uncast beside a domain",
							"an out-of-pattern payload cast to its domain",
							"an out-of-pattern payload refused without a domain",
							"an empty source delivered uncast"
						]),
						caseHang
					},
					(c, seen) =>
						Effect.sync(() => {
							const regex = T.code.carrier === "text" ? T.code.text.regex : undefined
							assert.ok(
								regex !== undefined && regex !== "wildcard",
								"the payload carries a pattern"
							)
							const outside = Arr.some(c.payload, (v) => !patternMember(regex, v))
							assert.equal(outside, Arr.contains(c.payload, "Abc"), "the oracle's membership")
							const r = lowered(c)
							if (outside && !c.domain) {
								seen.note("an out-of-pattern payload refused without a domain")
								refused(r, "UnsupportedOperation", Formatter.format(c))
								assert.ok(
									!r.ok && Str.includes("p0's refinement")(r.error.message),
									`the refusal names p0's refinement: ${r.ok ? "" : r.error.message}`
								)
								return
							}
							const program = succeeded(r, Formatter.format(c))
							const statements = flight(program.roots)
							for (const s of statements) {
								assert.deepEqual(auditStatementViolations(s.ast), [], Formatter.format(c))
							}
							const cast = Arr.some(statements, (s) => Str.includes(domainName)(s.sql.text))
							assert.equal(
								cast,
								outside,
								`p0 is cast to its domain exactly when a literal is outside the pattern: ${Formatter.format(c)}`
							)
							seen.note(
								c.payload.length === 0
									? "an empty source delivered uncast"
									: outside
										? "an out-of-pattern payload cast to its domain"
										: c.domain
											? "an in-pattern payload delivered uncast beside a domain"
											: "an in-pattern payload delivered uncast without a domain"
							)
						})
				)
			)
	)
})
