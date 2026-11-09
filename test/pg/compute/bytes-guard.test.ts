/**
 * A guard of a text's bytes on PostgreSQL 19: a relation whose generated field casts its text into a str.bytes target,
 * under Compute.when(Compute.within(Compute.octetLength(x), low, high), () => Compute.cast(x, target), "") or with no
 * guard, the text's own type drawn of no bound, a pattern's bound, or a byte bound of its own, and the target n bytes
 * of every text.
 *
 * The oracle: the schema compiles exactly when the bytes the guard or the text's own type bounds the text to are at
 * most n, the bounds the case states, four bytes a code point for a pattern's (never the compiler's own reading); a
 * refusal is PartialOperation of the language precondition whose remedy is the guard of the text's bytes at n; and,
 * installed, every drawn text, ASCII to four-byte code points, is inserted, and its generated field holds what the host
 * computes, the text where its bytes lie in the guard's interval and "" elsewhere, which the target's domain holds, so
 * no insert is refused.
 *
 * Planted bug: the guard narrows its text to its interval's low end rather than its high one (lower.ts whenGuard), so a
 * cast whose guard reaches past n compiles.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { codePoints } from "#compiler/core/text.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { assert } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

/** The guard over the cast: the text's bytes within [low, high], or none. */
type Guard =
	| { readonly kind: "within"; readonly low: number; readonly high: number }
	| { readonly kind: "none" }

/** The text's own type: any text, a pattern of at most so many code points, or a byte bound of its own. */
type Source =
	| { readonly kind: "every" }
	| { readonly kind: "upTo"; readonly codePoints: number }
	| { readonly kind: "bytes"; readonly bytes: number }

interface Case {
	readonly source: Source
	readonly guard: Guard
	readonly target: number
	readonly texts: ReadonlyArray<string>
}

type Feature =
	| "a cast under no guard"
	| "refused, naming the bound"
	| "admitted by the guard's bound"
	| "admitted by the text's own bound"
	| "a text the guard holds, stored"
	| "a text the guard keeps out, stored as the other value"

/** One, two, three and four UTF-8 bytes a code point: ASCII, Latin-1, the euro sign and an emoji. */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x7a, 0xe9, 0x20ac, 0x1f600]

const sourceGen: Gen<Source> = weighted<Source>([
	[2, () => ({ kind: "every" })],
	[1, (source) => ({ kind: "upTo", codePoints: source.draw(int(0, 12)) })],
	[1, (source) => ({ kind: "bytes", bytes: source.draw(int(0, 48)) })]
])

const guardGen: Gen<Guard> = weighted<Guard>([
	[
		4,
		(source) => {
			const high = source.draw(int(0, 40))
			return { kind: "within", low: source.draw(int(0, high)), high }
		}
	],
	[1, () => ({ kind: "none" })]
])

const caseGen: Gen<Case> = (source) => ({
	source: source.draw(sourceGen),
	guard: source.draw(guardGen),
	target: source.draw(int(0, 40)),
	texts: source.draw(array(stringsOver(alphabet, 14), { min: 1, max: 12 }))
})

/** The bytes the text's own type bounds it to: four a code point for a pattern's, none for any text. */
const sourceBytes = (s: Source): number => {
	switch (s.kind) {
		case "every":
			return Number.POSITIVE_INFINITY
		case "upTo":
			return 4 * s.codePoints
		case "bytes":
			return s.bytes
	}
}

/** Whether a text is a value of the text's own type. */
const sourceHolds = (s: Source, text: string): boolean => {
	switch (s.kind) {
		case "every":
			return true
		case "upTo":
			return codePoints(text).length <= s.codePoints
		case "bytes":
			return utf8Length(text) <= s.bytes
	}
}

/** The byte counts a case's guard holds of: its interval, or every count where it has none. */
const interval = (g: Guard): readonly [number, number] =>
	g.kind === "within" ? [g.low, g.high] : [0, Number.POSITIVE_INFINITY]

/** Whether compilation must admit the cast: the bytes the guard or the text's own type leaves it are at most n. */
const admitted = (c: Case): boolean =>
	Math.min(sourceBytes(c.source), interval(c.guard)[1]) <= c.target

/** The text's own field. */
const sourceField = (s: Source) => {
	const every = str.regex("^.*$", "su")
	switch (s.kind) {
		case "every":
			return every
		case "upTo":
			return regexField(`^.{0,${s.codePoints}}$`, ["su"])
		case "bytes":
			return str.bytes(s.bytes, every)
	}
}

/**
 * A case's schema: Texts, whose generated field casts its text into n bytes, under the case's guard of the text's
 * bytes with "" elsewhere, or alone. The guard's branch receives the count and casts the text it counts.
 */
const schemaOf = (c: Case) => {
	const Target = str.bytes(c.target, str.regex("^.*$", "su"))
	const Texts = relation.generated(
		"Texts",
		{ id: uuid, n: pg.integer, text: sourceField(c.source) },
		["id"],
		(r) => ({
			stored: generatedField(
				Target,
				c.guard.kind === "within"
					? Compute.when(
							Compute.within(Compute.octetLength(r.text), c.guard.low, c.guard.high),
							() => Compute.cast(r.text, Target),
							""
						)
					: Compute.cast(r.text, Target),
				[]
			)
		})
	)
	return { Texts, value: schema("BytesGuard", { Texts }, []) }
}

/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

layer(Substrate.layer)("a guard of a text's bytes on PostgreSQL 19", (it) => {
	it.effect(
		"admits a cast into str.bytes exactly when the guard's bound is within the target's, and stores what the host computes",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							suite: "pg/compute/bytes-guard",
							oracle: {
								kind: "specification",
								name: "the bounds the case states and the host's guard"
							},
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"a cast under no guard",
									"refused, naming the bound",
									"admitted by the guard's bound",
									"admitted by the text's own bound",
									"a text the guard holds, stored",
									"a text the guard keeps out, stored as the other value"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									if (c.guard.kind === "none") {
										k.note("a cast under no guard")
									}
									const { Texts, value } = schemaOf(c)
									const schemaName = yield* substrate.schema({ create: false, label: "bytes" })
									const compiled = Result.flatMap(ownedInput(value), (owned) =>
										compileInstallation(owned, {
											...installOptions(owned, substrate.owner.role),
											levels: [identity.schema(parsedSchemaName(schemaName))]
										})
									)
									if (!admitted(c)) {
										assert.ok(!compiled.ok, "the cast past the target's bytes is refused")
										const reason = compiled.error.reason
										assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
										assert.equal(reason.precondition, "language")
										assert.deepEqual(reason.guard.remedy, { kind: "octets", bytes: c.target })
										k.note("refused, naming the bound")
										return
									}
									assert.ok(
										compiled.ok,
										`the cast within the target's bytes compiles: ${compiled.ok ? "" : compiled.error.message}`
									)
									k.note(
										sourceBytes(c.source) <= c.target
											? "admitted by the text's own bound"
											: "admitted by the guard's bound"
									)
									const installation = compiled.value
									const names = installationNamesOf(installation)
									const texts = Arr.filter(c.texts, (t) => sourceHolds(c.source, t))
									const pinned = yield* substrate.admin.pin
									const problems = yield* inInstallation(
										pinned,
										installationSql(installation),
										Effect.gen(function* () {
											const refused: Array<string> = []
											for (const [i, text] of texts.entries()) {
												const verdict = yield* probe(
													pinned,
													`INSERT INTO ${names.table(Texts)} (${names.column(Texts, "id")}, ${names.column(Texts, "n")}, ${names.column(Texts, "text")}) VALUES (gen_random_uuid(), $1, $2)`,
													[i, text]
												)
												if (verdict.kind === "refused") {
													refused.push(`${Formatter.format(text)}: ${verdict.code}`)
												}
											}
											const rows = yield* pinned.queryValues(
												`SELECT ${names.column(Texts, "text")}, ${names.column(Texts, "stored")} FROM ${names.table(Texts)} ORDER BY ${names.column(Texts, "n")}`,
												[]
											)
											const [low, high] = interval(c.guard)
											const stored = Arr.flatMap(rows, (row) => {
												const [text, out] = Arr.map(row, String)
												const bytes = utf8Length(text ?? "")
												const held = bytes >= low && bytes <= high
												k.note(
													held
														? "a text the guard holds, stored"
														: "a text the guard keeps out, stored as the other value"
												)
												const expected = held ? text : ""
												return out === expected
													? []
													: [
															`${Formatter.format(text)} stored ${Formatter.format(out)}, not ${Formatter.format(expected)}`
														]
											})
											return [...refused, ...stored]
										})
									)
									assert.deepEqual(problems, [])
								})
							)
					)
				})
			)
	)
})
