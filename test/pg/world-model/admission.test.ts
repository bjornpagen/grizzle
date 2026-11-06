import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { admit } from "#adapter/admission/admit.ts"
import { admissionExpectation } from "#adapter/admission/expectation.ts"
import type { ClaimValue } from "#adapter/db/claims.ts"
import { dbContext } from "#adapter/db/context.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, queryTexts } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { uuidToken } from "#test/support/worlds/generate/domain.ts"
import { type EdgeKind, patternEdges } from "#test/support/worlds/invalid/patterns.ts"
import { type TextDomain, textDomain } from "#test/support/worlds/model/text.ts"

/**
 * Db.open's admission judges every refined claim of a Db in its one round trip (README "Connecting"): each claim whose
 * field is refined, by a contract or a pattern, is asked of the domain the installation planned for it, every one in
 * the flight of admission's catalog reads and fence, and admission answers exactly the claims the domain refuses. A
 * refined claim whose domain the installation does not name is no claim admission can judge: Db.open fails with
 * OpenError at stage admission, before any statement, never admitting it unjudged and never as a defect.
 *
 * The installation holds Probe, whose fields are an unrefined uuid and integer, the contract Plan (an integer at most
 * nine) and two patterns whose reading needs PostgreSQL to agree with ECMAScript's: a word class and a dot that is no
 * line terminator, and a negated class, an ASCII digit class and a dot under the `s` flag. Its full role's Db is
 * opened, and admission runs again on a session of its pool whose every message the protocol tap reads, with a drawn
 * list of claims: each of a field's type,
 * Probe's or one of a schema the installation does not hold (a contract and a pattern of its own), its text a canonical
 * integer, an edge string of its pattern (invalid/patterns.ts, each classified by the pattern as JavaScript reads it)
 * or one of its pool. The oracle: with any claim of a foreign refinement, OpenError at stage admission and nothing sent;
 * otherwise one round trip framed as admission's read-only transaction, ending idle, no cancel, and the refused claims
 * exactly those whose value its refinement refuses, in the order given (an integer past nine; a text the pattern, read
 * as ECMAScript reads it, does not match).
 */

/** The first pattern: a word class, which ECMAScript holds to ASCII, and a dot, which no line terminator matches. */
const wordPattern = "^[a-z]\\w{0,3}.$"
const wordDot: TextDomain = textDomain(wordPattern, "u")

/**
 * The second: a negated class, which matches a line terminator and every letter but ASCII's lower case, a digit class
 * ECMAScript holds to ASCII, and a dot that matches every character under the `s` flag.
 */
const markPattern = "^[^a-z]\\d?.{1,2}$"
const marked: TextDomain = textDomain(markPattern, "su")

/** The contract Plan: an integer at most nine. */
const planBound = 9

const Plan = contract("Plan", pg.integer, (x) => x.le(planBound))

const Probe = relation(
	"Probe",
	{
		id: uuid,
		n: pg.integer,
		plan: Plan,
		word: str.regex(wordPattern, "u"),
		mark: str.regex(markPattern, "su")
	},
	["id"]
)

const Probes = schema("Probes", { Probe }, [])

/** A schema the installation does not hold: a contract and a pattern of its own, whose domains it never planned. */
const Grade = contract("Grade", pg.integer, (x) => x.ge(0))
const Elsewhere = relation(
	"Elsewhere",
	{ id: uuid, grade: Grade, tag: str.regex("^q[0-9]{2}$", "u") },
	["id"]
)
const Foreign = schema("Foreign", { Elsewhere }, [])

/** The field types of a relation of compiled artifacts, by field. */
const fieldTypes = (
	heading: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
): ((field: string) => ScalarType) => {
	const types = new Map(Arr.map(heading, (h) => [h.name, h.type] as const))
	return (field) => defined(types.get(field), `the field ${field}`)
}

const foreignType = fieldTypes(
	defined(
		succeeded(testArtifacts(Foreign, testCompile)).derived.schema.relations.get("Elsewhere"),
		"the foreign relation"
	).heading
)

/** One drawn claim: of Probe's fields, with a text, or of a refinement the installation lacks. */
type ClaimSketch =
	| { readonly kind: "unrefined"; readonly field: "id" | "n"; readonly pick: number }
	| { readonly kind: "contract"; readonly value: number }
	| {
			readonly kind: "pattern"
			readonly field: "word" | "mark"
			readonly pick: number
			readonly edge: boolean
	  }
	| { readonly kind: "foreign"; readonly field: "grade" | "tag" }

const claimGen: Gen<ClaimSketch> = weighted<ClaimSketch>([
	[
		1,
		(source) => ({
			kind: "unrefined",
			field: source.draw(element(["id", "n"] as const)),
			pick: source.draw(int(0, 0xffff))
		})
	],
	[3, (source) => ({ kind: "contract", value: source.draw(int(-3, planBound + 3)) })],
	[
		4,
		(source) => ({
			kind: "pattern",
			field: source.draw(element(["word", "mark"] as const)),
			pick: source.draw(int(0, 0xffff)),
			edge: source.draw(
				weighted([
					[3, constant(true)],
					[1, constant(false)]
				])
			)
		})
	],
	[1, (source) => ({ kind: "foreign", field: source.draw(element(["grade", "tag"] as const)) })]
])

const claimsGen: Gen<ReadonlyArray<ClaimSketch>> = array(claimGen, { min: 0, max: 8 })

/** The context and field a drawn claim is reported under: its position, so each claim is told apart. */
const context = "Probe"
const fieldAt = (i: number): string => `f${i}`

/** A pattern's domain by its field. */
const domainOf = (field: "word" | "mark"): TextDomain => (field === "word" ? wordDot : marked)

/** A drawn claim's text and whether its refinement refuses it, as ECMAScript reads a pattern. */
const textOf = (
	sketch: Exclude<ClaimSketch, { readonly kind: "foreign" }>
): {
	readonly text: string
	readonly refused: boolean
	readonly edge: EdgeKind | "pool" | "none"
} => {
	switch (sketch.kind) {
		case "unrefined":
			return {
				text: sketch.field === "id" ? uuidToken(sketch.pick) : String(sketch.pick % 1000),
				refused: false,
				edge: "none"
			}
		case "contract":
			return { text: String(sketch.value), refused: sketch.value > planBound, edge: "none" }
		case "pattern": {
			const domain = domainOf(sketch.field)
			if (!sketch.edge) {
				const value = defined(domain.pool[sketch.pick % domain.pool.length], "a pool value")
				return { text: value, refused: false, edge: "pool" }
			}
			const edges = patternEdges(domain)
			const edge = defined(edges[sketch.pick % edges.length], "an edge")
			return { text: edge.value, refused: !edge.admitted, edge: edge.edge }
		}
	}
}

/** The read-only transaction admission's fence commits in. */
const readFraming = ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", "COMMIT"] as const

type AdmissionFeature =
	| "no claim"
	| "several refined claims in one flight"
	| "a contract's claim admitted"
	| "a contract's claim refused"
	| `a ${"word" | "mark"} claim ${"admitted" | "refused"}`
	| `an edge ${EdgeKind} judged`
	| "a foreign contract's claim refused at admission"
	| "a foreign pattern's claim refused at admission"

layer(Substrate.layer, { excludeTestServices: true })("Db.open's admission of claims", (it) => {
	it.effect(
		"judges every refined claim in its one round trip, and refuses one whose domain the installation lacks",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const o = yield* installed(Probes, {}, { label: "claims", extensions: [] })
						return yield* Effect.gen(function* () {
							const opened = yield* Db.open(o.server.roles.app, {})
							const opener = defined(dbContext(opened), "an opened Db's context")
							const substrate = yield* Substrate
							const tap = makeTap(substrate.cluster)
							const pool = yield* poolFor(o.installed.as(o.server), {
								...defaultPool,
								transport: { kind: "given", transport: tap.transport },
								pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
							})
							yield* Effect.scoped(
								Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
							)
							const probeType = fieldTypes(
								defined(
									opener.artifacts.derived.schema.relations.get("Probe"),
									"the installed relation"
								).heading
							)
							const login = succeeded(ownLogin(defined(loginDescOf(o.server))))
							return yield* explore(
								{
									suite: "pg/world-model/admission",
									draw: drawn(claimsGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "README's one round trip, each refinement read as ECMAScript reads a pattern, and a claim admission cannot judge refused"
									},
									coverage: required<AdmissionFeature>(
										[
											"no claim",
											"several refined claims in one flight",
											"a contract's claim admitted",
											"a contract's claim refused",
											"a word claim admitted",
											"a word claim refused",
											"a mark claim admitted",
											"a mark claim refused",
											"an edge trailing-newline judged",
											"an edge lookalike judged",
											"an edge decomposed judged",
											"an edge carriage-return judged",
											"a foreign contract's claim refused at admission",
											"a foreign pattern's claim refused at admission"
										],
										{ cases: 300, sense: notesOnly }
									),
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 200 },
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(sketches, c) =>
									Effect.gen(function* () {
										const claims: ReadonlyArray<ClaimValue> = Arr.map(
											sketches,
											(sketch, i): ClaimValue =>
												sketch.kind === "foreign"
													? {
															context,
															field: fieldAt(i),
															type: foreignType(sketch.field),
															text: sketch.field === "grade" ? "1" : "q12"
														}
													: {
															context,
															field: fieldAt(i),
															type: probeType(sketch.kind === "contract" ? "plan" : sketch.field),
															text: textOf(sketch).text
														}
										)
										const mark = tap.mark()
										const answer = yield* Effect.result(
											admit(pool, admissionExpectation(opener.artifacts), {
												artifacts: opener.artifacts,
												login,
												role: opener.role,
												snapshot: o.installed.snapshot,
												claims
											})
										)
										const window = tap.since(mark)
										assert.equal(tap.cancels(), 0, "no cancel")
										const foreign = Arr.filter(sketches, (s) => s.kind === "foreign")
										if (Arr.isReadonlyArrayNonEmpty(foreign)) {
											assert.ok(
												Result.isFailure(answer),
												"a claim admission cannot judge is refused"
											)
											const error = answer.failure
											assert.ok(error instanceof OpenError, String(error))
											assert.equal(error.stage, "admission", "refused at stage admission")
											assert.equal(window.roundTrips, 0, "before any statement")
											for (const s of foreign) {
												c.note(
													s.field === "grade"
														? "a foreign contract's claim refused at admission"
														: "a foreign pattern's claim refused at admission"
												)
											}
											return
										}
										assert.ok(Result.isSuccess(answer), `admitted: ${String(answer)}`)
										assert.equal(window.roundTrips, 1, "one round trip")
										assert.deepEqual(queryTexts(window), readFraming, "admission's framing")
										assert.deepEqual(window.backend.at(-1), { type: "Z", status: "I" }, "ends idle")
										const expected = Arr.flatMap(sketches, (s, i) =>
											s.kind !== "foreign" && textOf(s).refused
												? [{ context, field: fieldAt(i) }]
												: []
										)
										assert.deepEqual(answer.success.refusedClaims, expected, "the refused claims")
										const refined = Arr.filter(
											sketches,
											(s) => s.kind === "contract" || s.kind === "pattern"
										)
										if (sketches.length === 0) {
											c.note("no claim")
										}
										if (refined.length >= 2) {
											c.note("several refined claims in one flight")
										}
										for (const s of sketches) {
											if (s.kind === "contract") {
												c.note(
													textOf(s).refused
														? "a contract's claim refused"
														: "a contract's claim admitted"
												)
											}
											if (s.kind === "pattern") {
												const judged = textOf(s)
												c.note(`a ${s.field} claim ${judged.refused ? "refused" : "admitted"}`)
												if (judged.edge !== "pool" && judged.edge !== "none") {
													c.note(`an edge ${judged.edge} judged`)
												}
											}
										}
									})
							)
						}).pipe(Effect.scoped, withLayer(o.layer))
					})
				)
			)
	)
})
