/**
 * What a write of large bytes values allocates on the host before any SQL (write/program/bind.ts bindWrite): a member
 * whose binary arrays no Bind message carries is refused from its values' lengths alone (ir/products.ts MessageBound),
 * before any of its bytes is read or copied, and a member that fits is copied once, into its columns' binary arrays,
 * which its every placeholder carries (ir/products.ts KeyedFacts). A case writes a member of facts that all hold one
 * caller's array of 64 MiB in each of their bytes columns, so the caller holds 64 MiB however many facts there are,
 * and the bind's allocation is read as the growth of the process's ArrayBuffer memory across it: a copy the bind
 * holds when it returns, an admission's or an array's, is still allocated then, since nothing runs between.
 *
 * Oracle: the specification: a member whose arrays' bytes, counted from its values' lengths with each statement's own
 * fields and placeholders (write/family/order.ts inForce), pass the longest message PostgreSQL reads is refused, and
 * allocates under one value's length; any other binds, and allocates its arrays' bytes once, within a 64 MiB slack,
 * each of its admitted values the caller's array itself. The memory read bounds what a bind holds from above, so a
 * collection of an earlier case's garbage meanwhile can hide a copy, never invent one; the admitted values' identity
 * holds whatever the collector does. The slack is no number of its own: it is one value's length, the least a second
 * copy of any one value allocates, so a bind under it copied no value twice.
 *
 * Features: a member refused from its lengths, a member bound, two bytes columns.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): bytes-admission-copies, an admission that copies the caller's array,
 * which the identity check and the allocation bound both refuse.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { messageMaxBytes } from "#compiler/core/limits.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/** The one value every fact of a case holds: 64 MiB, so sixteen facts of one column pass a message. */
const valueLength = 64 * 1024 * 1024

const One = relation("One", { id: pg.integer, body: bytes }, ["id"])
const Two = relation("Two", { id: pg.integer, body: bytes, more: bytes }, ["id"])
const Large = schema("BytesMemory", [One, Two], [])

/** A case: the relation written, by its bytes columns, and how many facts the member holds. */
interface Drawn {
	readonly columns: 1 | 2
	readonly facts: number
}

const cases: Gen<Drawn> = (s) => {
	const columns = s.draw(element([1, 2] as const))
	return { columns, facts: s.draw(int(1, columns === 1 ? 20 : 10)) }
}

type Feature = "a member refused from its lengths" | "a member bound" | "two bytes columns"

/** The bytes the member's write statement carries at least: its fixed fields, its placeholders, its binary arrays. */
const carried = (d: Drawn): number => {
	const frame = bindFrame
	const array = byteaHeaderBytes(d.facts) + d.facts * byteaElementBytes(valueLength)
	return frame.statement + (d.columns + 1) * frame.parameter + d.columns * array
}

/** The binary arrays' bytes a bound member holds: one copy of every value. */
const copied = (d: Drawn): number => d.columns * d.facts * valueLength

/**
 * What the bind may allocate beside its one copy of every value (texts, maps, the process's own churn): less than one
 * value's length, the least a second copy of any value allocates.
 */
const slack = valueLength

const notes = (d: Drawn): ReadonlyArray<Feature> => [
	carried(d) > messageMaxBytes.value ? "a member refused from its lengths" : "a member bound",
	...(d.columns === 2 ? (["two bytes columns"] as const) : [])
]

describe("a write of large bytes values", () => {
	it.effect(
		"refuses a member past the message from its lengths alone, allocating none of it, and copies a member that fits once",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const reality = realityWrite(succeeded(testArtifacts(Large, testCompile)))
					const value = new Uint8Array(valueLength).fill(7)
					return yield* explore(
						{
							suite: "unit/write/bytes-memory",
							draw: drawn(cases),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "refused from its lengths with no copy past the message, one copy within it"
							},
							coverage: required<Feature>(
								["a member refused from its lengths", "a member bound", "two bytes columns"],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(d, c) =>
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const facts = upTo(d.facts, (id) =>
									d.columns === 1 ? { id, body: value } : { id, body: value, more: value }
								)
								const change =
									d.columns === 1
										? ChangeSet.empty(Large).insert(One, facts)
										: ChangeSet.empty(Large).insert(Two, facts)
								const program = succeeded(compileWrite(checking(Large), descOf(change), reality))
								const write = runnableWrite(program, program.frontend.codes)
								const members = yield* collectInputs(
									program.binding.groups,
									parsedOf(change).inputs
								)
								const before = process.memoryUsage().arrayBuffers
								const bound = bindWrite(write, {
									members,
									params: {},
									transport: inForce(bindFrame)
								})
								const grown = process.memoryUsage().arrayBuffers - before
								if (carried(d) > messageMaxBytes.value) {
									assert.ok(
										!bound.ok && bound.error._tag === "MessageBound",
										"a member past the message is refused as its MessageBound"
									)
									assert.ok(grown < valueLength, `the refusal allocated ${grown} bytes`)
									return
								}
								assert.ok(bound.ok, "a member within the message binds")
								assert.ok(
									grown < copied(d) + slack,
									`a bound member's ${copied(d)} bytes allocated ${grown}: a second copy of some value`
								)
								const normalized = normalizeChangeSet(
									write.flight.prepared.groups,
									{ fill: write.flight.prepared.fill, codes: write.flight.codes },
									members,
									inForce(bindFrame)
								)
								if (!normalized.ok || normalized.value.kind !== "normalized") {
									return assert.fail("a member within the message normalizes")
								}
								for (const slot of normalized.value.slots.values()) {
									for (const fact of slot.facts) {
										for (const field of d.columns === 1 ? ["body"] : ["body", "more"]) {
											const held = fact[field]
											assert.ok(
												isAdmittedBytes(held) && held.bytes === value,
												"admission holds the caller's array itself, no copy of it"
											)
										}
									}
								}
							})
					)
				})
			)
	)
})
