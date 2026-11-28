/**
 * What a write of large bytes values allocates on the host before any SQL (runtime/write/bind.ts bindWrite): a member
 * whose binary arrays no Bind message carries is refused from its values' lengths alone (ir/products.ts MessageBound),
 * before any of its bytes is read or copied, and a member that fits is copied once, into its columns' binary arrays,
 * which its every placeholder carries (ir/products.ts KeyedFacts). A case writes a member of facts that all hold one
 * caller's array of 1 MiB in each of their bytes columns, so the caller holds 1 MiB however many facts there are,
 * under a transport whose message holds sixteen of them (bytes-memory.fixtures.ts transport), and the bind's allocation
 * is read as the growth of the process's ArrayBuffer memory across it: a copy the bind holds when it returns, an
 * admission's or an array's, is still allocated then, since nothing runs between.
 *
 * Oracle: the specification: a member whose arrays' bytes, counted from its values' lengths with each statement's own
 * fields and placeholders (runtime/write/transport.ts Transport), pass the transport's longest message is refused, and
 * allocates under one value's length; any other binds, and allocates its arrays' bytes once, within a 1 MiB slack,
 * each of its admitted values the caller's array itself. The memory read bounds what a bind holds from above, so a
 * collection of an earlier case's garbage meanwhile can hide a copy, never invent one; the admitted values' identity
 * holds whatever the collector does. The slack is no number of its own: it is one value's length, the least a second
 * copy of any one value allocates, so a bind under it copied no value twice.
 *
 * Features: a member refused from its lengths, a member bound, two bytes columns.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	carried,
	cases,
	copied,
	type Feature,
	Large,
	notes,
	One,
	reality,
	slack,
	transport,
	Two,
	valueLength,
	valueNeed
} from "#test/unit/write/bytes-memory.fixtures.ts"

/**
 * A write of large bytes values refuses a member past the message from its lengths alone, allocating none of it, and
 * copies a member that fits once.
 *
 * Budget: 8 runs and 12 steered cases, what its suite stated before it became a property
 * (test/unit/write/bytes-memory.test.ts:90 at 8cad5bce, its runs and its coverage's cases).
 */
export const aWriteOfLargeBytesValuesRefusesAMemberPastTheMessageFromItsLengthsAloneAllocatingNoneOfItAndCopiesAMemberThatFitsOnce =
	property.explore(cases, {
		needs: { valueNeed },
		budget: { runs: 8, steered: 12 },
		situations: [
			"a member refused from its lengths",
			"a member bound",
			"two bytes columns"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ valueNeed }, c: Case<Feature>) =>
			(d) =>
				Effect.gen(function* () {
					const value = yield* valueNeed
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
					const write = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
					const members = yield* collectInputs(program.binding.groups, parsedOf(change).inputs)
					const before = process.memoryUsage().arrayBuffers
					const bound = bindWrite(write, {
						members,
						params: {},
						transport
					})
					const grown = process.memoryUsage().arrayBuffers - before
					if (carried(d) > transport.messageBytes) {
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
						write.prepared.groups,
						{ fill: write.prepared.fill, codes: write.codes, columns: write.prepared.columns },
						write.prepared.evaluate,
						members,
						transport
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
				}),
		oracle: {
			kind: "specification",
			name: "refused from its lengths with no copy past the message, one copy within it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\treturn new AdmittedBytes(value)",
				replacement: "\treturn new AdmittedBytes(value.slice())",
				why: "An admission that copies the caller's array (scalar/values/bytes.ts admitBytes), which the identity check and the allocation bound both refuse."
			}
		]
	})
