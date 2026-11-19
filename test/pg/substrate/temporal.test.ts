/**
 * Coverage's lowering (fin.md §7, "Tested on 19rc1, not assumed") against PostgreSQL 19rc2: a span target keyed
 * `UNIQUE (k, r WITHOUT OVERLAPS)` and a source whose `FOREIGN KEY (k, PERIOD r)` requires the union of its key's
 * target spans to cover each of its own, both spans STORED generated columns `CASE WHEN φ THEN int4range(lo, hi) END`,
 * so a row outside φ projects NULL.
 *
 * Oracle: a model of interval-union coverage on the host, the specification turned into a checker. Spans are half-open
 * integer intervals. The target key refuses a non-NULL empty span and two non-NULL spans of one key that overlap, at the
 * row whose insert meets it; a NULL span is never compared. A source row is covered when its span is NULL, or non-empty
 * and inside the union of its key's non-NULL target spans. PostgreSQL must commit exactly what the model commits, and
 * refuse the rest with the SQLSTATE the model names at the moment the FK's deferral puts it.
 *
 * The box (doctrine rule 9): keys 0 and 1, points 0 to 3, so a span is one of the six non-empty intervals over them,
 * the empty one, or NULL; at most three target rows; one source row, since PostgreSQL checks each source row alone.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	type ChangeFeature,
	changeFeature,
	changeGen,
	coverageTemplates,
	type CoverFeature,
	coverGen,
	insertSql,
	judge,
	type KeyFeature,
	keyGen,
	seatIn,
	shrinks,
	targetsOf,
	type Verdict
} from "#test/pg/substrate/temporal.fixtures.ts"
import { covered, isEmpty, keyRefusal, overlaps, type Row } from "#test/pg/substrate/temporal.ts"
import { assert } from "#test/support/assert.ts"
import { attempt, qualified } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Coverage's temporal lowering of fin.md §7 on PostgreSQL 19rc2 refuse in a WITHOUT OVERLAPS key exactly the rows that overlap an earlier row of their key or hold an empty span, never comparing a NULL span.
 */
export const coveragesTemporalLoweringOfFinMd7OnPostgreSQL19rc2RefuseInAWITHOUTOVERLAPSKeyExactlyTheRowsThatOverlapAnEarlierRowOfTheirKeyOrHoldAnEmptySpanNeverComparingANULLSpan =
	property.exhaust(finite(keyGen), {
		needs: { immediate: Substrate.seat(coverageTemplates.immediate) },
		situations: [
			"refused by an overlap",
			"refused by an empty span",
			"two NULL spans of one key admitted",
			"adjacent spans of one key admitted",
			"overlapping spans of two keys admitted"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check:
			({ immediate }, k: Case<KeyFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const taken = yield* immediate
					const seat = yield* seatIn(taken)
					const target = qualified(seat.schema, "target")
					const real = yield* attempt(
						seat.session,
						Arr.isReadonlyArrayNonEmpty(c.rows) ? [insertSql(target, c.rows, 0)] : []
					)
					const model: Verdict = Option.match(keyRefusal(c.rows), {
						onNone: (): Verdict => ({ kind: "committed" }),
						onSome: (code): Verdict => ({
							kind: "refused",
							moment: { kind: "statement", index: 0 },
							code
						})
					})
					yield* judge(real, model, Formatter.format(c))
					if (real.kind === "committed") {
						const pairs = Arr.flatMap(c.rows, (a, i) =>
							Arr.map(c.rows.slice(i + 1), (b) => [a, b] as const)
						)
						if (
							Arr.some(
								pairs,
								([a, b]) => a.k === b.k && a.span.kind === "null" && b.span.kind === "null"
							)
						) {
							k.note("two NULL spans of one key admitted")
						}
						if (
							Arr.some(
								pairs,
								([a, b]) =>
									a.k === b.k &&
									a.span.kind === "span" &&
									b.span.kind === "span" &&
									(a.span.hi === b.span.lo || b.span.hi === a.span.lo)
							)
						) {
							k.note("adjacent spans of one key admitted")
						}
						if (Arr.some(pairs, ([a, b]) => a.k !== b.k && overlaps(a.span, b.span))) {
							k.note("overlapping spans of two keys admitted")
						}
					} else if (model.kind === "refused") {
						k.note(model.code === "23514" ? "refused by an empty span" : "refused by an overlap")
					}
				}),
		oracle: {
			kind: "specification",
			name: "a model of interval-union coverage on the host: its verdict, and the SQLSTATE it names at the moment the deferral puts it"
		},
		box: "every sequence of at most three target rows over keys 0 and 1, each span one of the six non-empty intervals over points 0 to 3, the empty one or NULL",
		kept: [],
		kills: []
	})

/**
 * Coverage's temporal lowering of fin.md §7 on PostgreSQL 19rc2 admit a source span exactly when its key's target spans cover it, immediately or at commit, refusing an empty span and skipping a NULL one.
 */
export const coveragesTemporalLoweringOfFinMd7OnPostgreSQL19rc2AdmitASourceSpanExactlyWhenItsKeysTargetSpansCoverItImmediatelyOrAtCommitRefusingAnEmptySpanAndSkippingANULLOne =
	property.exhaust(finite(coverGen), {
		needs: {
			immediate: Substrate.seat(coverageTemplates.immediate),
			deferred: Substrate.seat(coverageTemplates.deferred)
		},
		situations: [
			"deferred committed a source sent before its targets",
			...Arr.flatMap(["immediate", "deferred"] as const, (d): ReadonlyArray<CoverFeature> => [
				`${d} covered by one span`,
				`${d} covered by a union of spans`,
				`${d} refused across a gap`,
				`${d} refused an empty source span`,
				`${d} skipped a NULL source span`
			])
		] satisfies ReadonlyArray<Reached<CoverFeature>>,
		check:
			({ immediate, deferred }, k: Case<CoverFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const pair = yield* Effect.all([immediate, deferred])
					return yield* Effect.flatMap(Effect.forEach(pair, seatIn), (seats) =>
						Effect.forEach(
							seats,
							(seat) =>
								Effect.gen(function* () {
									const targets = targetsOf(c)
									const targetInsert = Arr.isReadonlyArrayNonEmpty(targets)
										? [insertSql(qualified(seat.schema, "target"), targets, 0)]
										: []
									const sourceInsert = insertSql(qualified(seat.schema, "source"), [c.source], 0)
									/** The deferred FK is sent its source first, as a cascade-fed target's rows arrive after it. */
									const statements =
										seat.deferral === "deferred"
											? [sourceInsert, ...targetInsert]
											: [...targetInsert, sourceInsert]
									const real = yield* attempt(seat.session, statements)
									const ok = covered(targets, c.source)
									const model: Verdict = ok
										? { kind: "committed" }
										: {
												kind: "refused",
												moment:
													seat.deferral === "deferred"
														? { kind: "commit" }
														: { kind: "statement", index: targetInsert.length },
												code: "23503"
											}
									yield* judge(real, model, `${seat.deferral}: ${Formatter.format(c)}`)
									const d = seat.deferral
									if (c.source.span.kind === "null") {
										k.note(`${d} skipped a NULL source span`)
									} else if (isEmpty(c.source.span)) {
										k.note(`${d} refused an empty source span`)
									} else if (!ok) {
										k.note(`${d} refused across a gap`)
									} else {
										const { lo, hi } = c.source.span
										const one = Arr.some(
											targets,
											(t) =>
												t.k === c.source.k &&
												t.span.kind === "span" &&
												t.span.lo <= lo &&
												hi <= t.span.hi
										)
										k.note(one ? `${d} covered by one span` : `${d} covered by a union of spans`)
										if (d === "deferred") {
											k.note("deferred committed a source sent before its targets")
										}
									}
								}),
							{ concurrency: "unbounded", discard: true }
						)
					)
				}),
		oracle: {
			kind: "specification",
			name: "a model of interval-union coverage on the host: its verdict, and the SQLSTATE it names at the moment the deferral puts it"
		},
		box: "every two sets of pairwise disjoint target spans of the box, with a NULL target row beside them or none, and every source row",
		kept: [],
		kills: []
	})

/**
 * Coverage's temporal lowering of fin.md §7 on PostgreSQL 19rc2 commit a change of a referenced target row exactly when the source stays covered and the key stays free of overlaps and empty spans.
 */
export const coveragesTemporalLoweringOfFinMd7OnPostgreSQL19rc2CommitAChangeOfAReferencedTargetRowExactlyWhenTheSourceStaysCoveredAndTheKeyStaysFreeOfOverlapsAndEmptySpans =
	property.exhaust(finite(changeGen), {
		needs: {
			immediate: Substrate.seat(coverageTemplates.immediate),
			deferred: Substrate.seat(coverageTemplates.deferred)
		},
		situations: [
			"immediate delete committed",
			"immediate delete refused 23503",
			"immediate respan committed",
			"immediate respan refused 23503",
			"immediate respan refused 23514",
			"immediate respan refused 23P01",
			"deferred delete refused 23503",
			"deferred respan refused 23503",
			"a shrink that keeps the source covered committed"
		] satisfies ReadonlyArray<Reached<ChangeFeature>>,
		check:
			({ immediate, deferred }, k: Case<ChangeFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const pair = yield* Effect.all([immediate, deferred])
					return yield* Effect.flatMap(Effect.forEach(pair, seatIn), (seats) =>
						Effect.forEach(
							seats,
							(seat) =>
								Effect.gen(function* () {
									const target = qualified(seat.schema, "target")
									const rows = Arr.map(c.targets, (span): Row => ({ k: 0, span }))
									const setup = yield* attempt(seat.session, [
										insertSql(target, rows, 0),
										insertSql(qualified(seat.schema, "source"), [{ k: 0, span: c.source }], 0)
									])
									assert.equal(setup.kind, "committed", "a covering state is admitted")
									const change = c.change
									const after: ReadonlyArray<Row> =
										change.kind === "delete"
											? Arr.filter(rows, (_, i) => i !== change.at)
											: Arr.map(rows, (row, i) =>
													i === change.at ? { k: 0, span: change.span } : row
												)
									const changed =
										change.kind === "delete"
											? `DELETE FROM ${target} WHERE id = ${change.at}`
											: change.span.kind === "null"
												? `UPDATE ${target} SET phi = false WHERE id = ${change.at}`
												: `UPDATE ${target} SET lo = ${change.span.lo}, hi = ${change.span.hi}, phi = true WHERE id = ${change.at}`
									const real = yield* attempt(seat.session, [changed])
									/** The changed row is checked against the others first, then the source against what is left. */
									const keyCode =
										change.kind === "respan"
											? keyRefusal([
													...Arr.filter(rows, (_, i) => i !== change.at),
													{ k: 0, span: change.span }
												])
											: Option.none()
									const model: Verdict = Option.isSome(keyCode)
										? {
												kind: "refused",
												moment: { kind: "statement", index: 0 },
												code: keyCode.value
											}
										: covered(after, { k: 0, span: c.source })
											? { kind: "committed" }
											: {
													kind: "refused",
													moment:
														seat.deferral === "deferred"
															? { kind: "commit" }
															: { kind: "statement", index: 0 },
													code: "23503"
												}
									yield* judge(real, model, `${seat.deferral}: ${Formatter.format(c)}`)
									k.note(changeFeature(seat.deferral, c.change.kind, model))
									if (model.kind === "committed" && shrinks(c)) {
										k.note("a shrink that keeps the source covered committed")
									}
								}),
							{ concurrency: "unbounded", discard: true }
						)
					)
				}),
		oracle: {
			kind: "specification",
			name: "a model of interval-union coverage on the host: its verdict, and the SQLSTATE it names at the moment the deferral puts it"
		},
		box: "every change of one target row of every covering state of the box",
		kept: [],
		kills: []
	})
