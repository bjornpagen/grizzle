/**
 * The schema vocabulary over the real field descriptors, str.regex and the Compute catalogue:
 * a row check's field terms are typed terms of the term protocol, so Compute arithmetic, casts and charLength compose
 * with them, and ownership accepts the result.
 *
 * The relations are built by the public, typed builders; the checks go through the builder's admission core, which
 * takes the callback as a JavaScript caller passes it, so the refusals below reach it at run time.
 *
 * Oracle: ownership's own acceptance of each composed check, and its refusal of a literal of another host kind or
 * roster and of two contracts of different identity.
 *
 * Features: arithmetic, a cast, charLength and a handle; each refusal.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): contract-identity-nameless (two contracts of different names one
 * identity).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import { closed, key, on, type RowScalars, relation } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { own } from "#compiler/schema/own.ts"
import { schema, schemaDescOf } from "#compiler/schema/schema.ts"
import { checkBuilder } from "#compiler/schema/statements.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const Slug = str.regex("^[a-z]{1,20}$")
const Cents = contract("Cents", pg.bigint, (v) => Compute.ge(v, 0n))
const Kind = closed("Kind", ["a", "b"])
const Account = relation("Account", { id: pg.int4, slug: Slug, bal: Cents, kind: closedId(Kind) }, [
	"id"
])
type Row = RowScalars<typeof Account>

/**
 * Rows a refused callback is written against: what a JavaScript caller assumed the row to be. Their types admit the
 * operands Account's and Pair's real rows refuse; the values are never declared in a schema.
 */
const Loose = relation(
	"Account",
	{ id: pg.int4, slug: Slug, bal: pg.int4, kind: closedId(closed("Kind", ["a", "b", "c"])) },
	["id"]
)
type LooseRow = RowScalars<typeof Loose>
const SamePair = relation("Pair", { a: Cents, b: Cents }, ["a"])
type SamePairRow = RowScalars<typeof SamePair>

/**
 * A check the vocabulary composes: arithmetic over a contract field, a cast to numeric, or charLength and a handle test.
 */
type Composed = "arithmetic" | "a cast" | "charLength and a handle"
/**
 * A check a JavaScript caller writes against the wrong row: a number for a bigint field, a handle off the roster, or two
 * contracts of different identity meeting.
 */
type Refused = "a number for a bigint" | "a handle off the roster" | "two contracts meeting"

describe("row checks over the field registry and Compute", () => {
	it.effect(
		"composes Compute arithmetic, casts and charLength with the row's field terms, and ownership accepts the result",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "ownership of the composed row check" },
						suite: "unit/schema/row-check-compose",
						draw: drawn((source) => ({
							composed: source.draw(
								element<Composed>(["arithmetic", "a cast", "charLength and a handle"])
							),
							n: source.draw(bigint(-1000n, 1000n)),
							bound: source.draw(int(0, 20)),
							handle: source.draw(element(["a" as const, "b" as const]))
						})),
						literal: Formatter.format,
						coverage: required<Composed>(["arithmetic", "a cast", "charLength and a handle"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ composed, n, bound, handle }, c) =>
						Effect.sync(() => {
							c.note(composed)
							const statement =
								composed === "arithmetic"
									? checkBuilder("headroom", Account, (r: Row) =>
											Compute.ge(Compute.add(r.bal, n), n)
										)
									: composed === "a cast"
										? checkBuilder("scaled", Account, (r: Row) =>
												Compute.ge(Compute.numeric(r.bal), `${n}.5`)
											)
										: checkBuilder("short", Account, (r: Row) =>
												Compute.and(Compute.charLength(r.slug).le(bound), r.kind.ne(handle))
											)
							succeeded(
								own(
									defined(
										schemaDescOf(
											schema("bank", { Account, Kind }, [statement, key(on(Account, "slug"))], [])
										)
									)
								)
							)
						})
				)
			)
	)

	it.effect(
		"refuses a row field's literal of another host kind or roster, and two contracts of different identity",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a literal of another host kind or roster, and two contracts of different identity, refused"
						},
						suite: "unit/schema/row-check-refused",
						draw: drawn((source) => ({
							refused: source.draw(
								element<Refused>([
									"a number for a bigint",
									"a handle off the roster",
									"two contracts meeting"
								])
							),
							n: source.draw(int(-1000, 1000))
						})),
						literal: Formatter.format,
						coverage: required<Refused>(
							["a number for a bigint", "a handle off the roster", "two contracts meeting"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ refused, n }, c) =>
						Effect.sync(() => {
							c.note(refused)
							const build = (): unknown => {
								switch (refused) {
									case "a number for a bigint":
										return checkBuilder("bad", Account, (r: LooseRow) =>
											Compute.ge(Compute.add(r.bal, n), 0n)
										)
									case "a handle off the roster":
										return checkBuilder("bad", Account, (r: LooseRow) => r.kind.eq("c"))
									case "two contracts meeting": {
										/** A contract's name is one literal by its type: the other identity is written here. */
										const Pair = relation("Pair", { a: Cents, b: contract("Other", pg.bigint) }, [
											"a"
										])
										return checkBuilder("mixed", Pair, (r: SamePairRow) =>
											Compute.ge(Compute.add(r.a, r.b), 0n)
										)
									}
								}
							}
							assert.throws(build, isCompileError)
						})
				)
			)
	)
})
