/**
 * A nested write under a stamped owner (write/family/nesting.ts Nesting `stamps`): an owner whose place its insert leaves
 * out, with its members nested in it, each carrying the owner's key, the place among it, in its group. The walk fills
 * no column its family statement fills (runtime/write/fill.ts StatementFills, NestedLayout `pending`): the place, every
 * member's group field that carries it, and every generated field over one, which PostgreSQL computes as it stores the
 * row; it fills every other column, a member's group fields beside the place, its slot, its copy of an owner's field and
 * the owner's fold over its members' payload, from the rows the host holds. A walk that would read a stamped column, a
 * fold over the members whose carried place or a generated field over it it selects, is refused where the write
 * compiles, as UnfillableField with its source stamped (core/causes.ts FilledLater `stamped`); and two owners of one
 * call in one group, which its statement would stamp one place, meet at the owner's primary key, which the host holds
 * at the place's group (write/normalize/normalize.ts hostChecks), so the write is refused there before any statement.
 *
 * The box, exhausted: members one or two deep under Owner(g, h, s, x, ms, tot), keyed (g, h, s) with `s` a place, its
 * members M1(g, h, s, at, v, cx, ks, gs), each copying the owner's `x` at `cx` and holding `gs`, a generated field over
 * its carried place, and theirs M2(g, h, s, at, bt, w); the owner's sum of its members' `v` over every member, those
 * whose carried place is at least 1, or those whose `gs` is (stamped-nesting.fixtures.ts selections); one owner, two in
 * two groups, or two in one group stated apart; none, one or two members an owner, as many again under each member two
 * deep.
 *
 * Property, per case: the write compiles and binds, every member's row its walk filled holding its owner's group fields,
 * its slot and its copy of the owner's `x`, and leaving its place and the generated field over it to its statement; or
 * it is refused as the rule says. Oracle: the rule over the case (stamped-nesting.fixtures.ts verdictOf), and the
 * members as the case nests them. Its database half, every member carrying its owner's stamp as it is stored, is
 * test/pg/write/stamped-nesting.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import type { JudgedRow } from "#compiler/runtime/write/witness.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	changeSetOf,
	featuresOf,
	ownersOf,
	type StampedCase,
	type StampedFeature,
	stampedGen,
	stampedSchemaOf,
	verdictOf
} from "#test/support/unit/write/stamped-nesting.fixtures.ts"

/** A column of a row the walk filled: its value, or that the write leaves it to its statement. */
const filledAt = (row: JudgedRow, field: string): unknown => {
	const filled = row.filled(columnKeyOf(field))
	return filled.kind === "filled" ? filled.value : "the statement's"
}

/** A member's row as the walk filled it, by what the property holds it to. */
const memberRow = (row: JudgedRow, fields: ReadonlyArray<string>): Record<string, unknown> =>
	Record.fromEntries(Arr.map(fields, (f) => [f, filledAt(row, f)] as const))

/** Rows in one order: by their owner's group, then their slots. */
const ordered = (
	rows: ReadonlyArray<Record<string, unknown>>
): ReadonlyArray<Record<string, unknown>> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.String, (r: Record<string, unknown>) =>
			Arr.join(
				Arr.map(["g", "h", "at", "bt"], (f) => String(r[f])),
				" "
			)
		)
	)

/** The members' rows a case's walk fills, as the case nests them: each M1 its owner's group fields, its slot, its copy of
 * the owner's `x`, its place and the generated field over it its statement's; each M2 its owner's
 * group fields, its owner's slot as its `at`, and its own slot. */
const expectedRows = (c: StampedCase) => {
	const owners = ownersOf(c)
	return {
		M1: Arr.flatMap(owners, (o) =>
			Arr.map(o.members, (_m, at) => ({
				g: o.g,
				h: o.h,
				s: "the statement's",
				at: BigInt(at),
				gs: "the statement's",
				cx: o.x
			}))
		),
		M2: Arr.flatMap(owners, (o) =>
			Arr.flatMap(o.members, (m, at) =>
				Arr.map(m.ws, (_w, bt) => ({
					g: o.g,
					h: o.h,
					s: "the statement's",
					at: BigInt(at),
					bt: BigInt(bt)
				}))
			)
		)
	}
}

/** A nested write under a stamped owner binds every member with its owner's stamp left to its statement, and refuses a fill that reads the stamp. */
export const aNestedWriteUnderAStampedOwnerBindsEveryMemberWithItsOwnersStampLeftToItsStatementAndRefusesAFillThatReadsTheStamp =
	property.exhaust(finite(stampedGen), {
		needs: {},
		situations: [
			"selects every",
			"selects stamp",
			"selects generated",
			"owners one",
			"owners two groups",
			"owners one group",
			"members two deep",
			"no member",
			"bound",
			"unfillable",
			"conflict"
		] satisfies ReadonlyArray<Reached<StampedFeature>>,
		check: (_, k: Case<StampedFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(featuresOf(c))
				const built = stampedSchemaOf(c, "Stamped")
				const artifacts = succeeded(
					testArtifacts(built.schema, testCompile),
					"the case's schema compiles"
				)
				const value = changeSetOf(c, built)
				const compiled = compileWrite(
					checking(built.schema),
					descOf(value),
					realityWrite(artifacts)
				)
				const verdict = verdictOf(c)
				if (verdict.kind === "unfillable") {
					const reason = refused(
						compiled,
						"UnfillableField",
						"the fold that reads the stamp"
					).reason
					if (reason._tag === "UnfillableField") {
						assert.deepEqual(
							{ relation: reason.relation, source: reason.source, later: reason.later },
							{
								relation: "M1",
								source: { relation: "M1", column: columnKeyOf(verdict.source) },
								later: { kind: "stamped" }
							},
							"the member's fold reads the column its statement stamps"
						)
					}
					return
				}
				const program = succeeded(compiled, "the write compiles")
				const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
				const bound = succeeded(
					bindWrite(flightOf(servableWrite(program), program.frontend.codes, noAdvice), {
						members,
						params: {},
						transport: inForce(bindFrame)
					}),
					"the write binds"
				)
				if (verdict.kind === "conflict") {
					assert.equal(bound.kind, "invariant-rejected", "two owners of one group meet at its key")
					if (bound.kind === "invariant-rejected") {
						assert.deepEqual(
							{ described: bound.described, witness: bound.witness },
							{
								described: { kind: "primaryKey", relation: "Owner", fields: ["g", "h", "s"] },
								witness: { kind: "key", relation: "Owner", values: { g: 1, h: 7 } }
							},
							"refused at the owner's primary key, witnessed at the place's group"
						)
					}
					return
				}
				assert.equal(bound.kind, "bound", "the write binds")
				if (bound.kind !== "bound") {
					return
				}
				const rowsOf = (relation: string, fields: ReadonlyArray<string>) =>
					ordered(
						Arr.flatMap(program.binding.nested, (n) =>
							Arr.map(bound.stated.nested(n.stratum, StoredRelationName(relation)), (row) =>
								memberRow(row, fields)
							)
						)
					)
				const expected = expectedRows(c)
				assert.deepEqual(
					{
						M1: rowsOf("M1", ["g", "h", "s", "at", "gs", "cx"]),
						M2: rowsOf("M2", ["g", "h", "s", "at", "bt"])
					},
					{ M1: ordered(expected.M1), M2: ordered(expected.M2) },
					"every member the walk filled holds its owner's group and its slot, its place left to its statement"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the rule over the case (stamped-nesting.fixtures.ts verdictOf), and its members as it nests them"
		},
		box: "members one or two deep under an owner keyed (g, h) and a place, its fold over every member, over a carried place or over a generated field over it, one owner, two in two groups or two in one group, none to two members each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					"\tfor (const c of layout.columns.filter((column) => !pending.has(column.key))) {\n",
				replacement: "\tfor (const c of layout.columns) {\n",
				why: "The walk fills a member's carried place from its owner's, which no row the host fills holds, so every bind under a stamped owner dies of the invariant at filledBefore, den's claim's crash."
			},
			{
				file: "packages/engine/src/write/normalize/normalize.ts",
				original: "\t\tconst stamp = stamped.find((s) => s.field.name === f.name)\n",
				replacement: "\t\tconst stamp = stamped.find(() => false)\n",
				why: "No key over a stamped field is held at its child: the host drops the owner's primary key, so two owners of one group find no key to be refused at, and reads a member's key at its carried place, which no row holds."
			},
			{
				file: "packages/engine/src/write/family/nesting.ts",
				original: '\t\t\t\tif (column.rule.kind === "generated") {\n',
				replacement: "\t\t\t\tif (false) {\n",
				why: "A generated field over the carried place is the walk's to evaluate, so a write whose fill never reads it dies where its nesting compiles."
			}
		]
	})
