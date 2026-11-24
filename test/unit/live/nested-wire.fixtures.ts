/** What the properties of nested-wire.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Gen } from "@bjornpagen/testing/gen"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { servedEntryOf, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { encodeInput, type ParsedInput, parseInput } from "#compiler/live/codec.ts"
import type { WireFacts } from "#compiler/live/shape.ts"
import type { WireScalar } from "#compiler/live/wire.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, wholeWritesOf } from "#compiler/public/schema.ts"
import { ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import { servedFile } from "#compiler/served/json.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import {
	admittedFillSpecGen,
	buildFill,
	type FillSpec,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	relationName
} from "#test/support/families/fill.ts"

export type Feature =
	| "a nested input with no top level"
	| "a nested input with a top level"
	| "a tree's nodes nested under their root"
	| "a write no served file holds"

interface NestCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
}

export const caseGen: Gen<NestCase> = (source) => {
	const spec = source.draw(admittedFillSpecGen({ relations: 4, families: 4, copies: 2 }))
	return { spec, rows: source.draw(instanceGen(spec)) }
}

/** The name the case's ChangeSet has in its role's workload. */
const member = "nest"

/** Whether relation `r` of `spec` is the relation of a tree, whose inserted rows are its roots. */
const isTree = (spec: FillSpec, r: number): boolean =>
	Arr.some(spec.families, (f) => f.kind === "tree" && f.member === r)

/** Whether relation `r` of `spec` owns an ordered family, whose members its inserted rows nest. */
const ownsOrdered = (spec: FillSpec, r: number): boolean =>
	Arr.some(spec.families, (f) => f.kind === "ordered" && f.owner === r)

/** A ChangeSet over `value` inserting each relation of `inserted` of `built`, its facts the call's. */
const insertAll = (
	value: unknown,
	built: ReturnType<typeof buildFill>,
	inserted: ReadonlyArray<number>
): ChangeSetValue =>
	Arr.reduce(inserted, ChangeSet.empty(value), (cs, r) =>
		cs.insert(defined(built.relations[relationName(r)], `the relation ${relationName(r)}`), [])
	)

/** The call's input of an instance: no parameters, and under each array member's op and relation, its facts. */
const callOf = (
	facts: ReadonlyArray<WireFacts<WireScalar>>,
	byRelation: ReadonlyMap<string, ReadonlyArray<unknown>>
): ParsedInput => ({
	params: {},
	facts: Rec.fromEntries(
		Arr.map(
			Arr.dedupe(Arr.map(facts, (f) => f.op)),
			(op) =>
				[
					op,
					Rec.fromEntries(
						Arr.map(
							Arr.filter(facts, (f) => f.op === op),
							(f) =>
								[
									f.relation,
									defined(byRelation.get(f.relation), `the facts of ${f.relation}`)
								] as const
						)
					)
				] as const
		)
	)
})

/**
 * One case's claims: where the login's compile accepts its ChangeSet, its projection holds its wire or refuses it as a
 * member no served file holds, and the wire's parse reads back what its encode writes of the case's instance.
 */
export const nestingHolds = (c: NestCase, note: (feature: Feature) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { spec, rows } = c
		const built = buildFill(spec)
		const value = built.rename("Nest")
		const inserted = insertedRelations(spec)
		const change = insertAll(value, built, inserted)
		const writer = role(value, "writer", wholeEntriesOf(value), wholeWritesOf(value))
		const served = defined(
			builtLogin(
				login(value, "server", [writer], { workload: [workload(value, { [member]: change })] })
			),
			"a login built by login(...)"
		)
		const base = succeeded(ownBuilt(served.base), "the login's base")
		const owned = succeeded(ownLoginOver(served, base), "the login over its base")
		const compiled = yield* Effect.result(
			Effect.flatMap(compiledSnapshot(served, base, firstCodebook(rostersOf(base))), (snapshot) =>
				snapshotCompiled({ login: served, owned }, snapshot, transactionClock)
			)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		const entry = yield* Effect.result(servedEntryOf(compiled.success))
		if (Answered.isFailure(entry)) {
			assert.equal(
				entry.failure.error._tag,
				"UnservedMember",
				`a ChangeSet the write compiler accepts projects to a wire, or is one no served file holds\n${Formatter.format(entry.failure)}`
			)
			note("a write no served file holds")
			return
		}
		for (const r of inserted) {
			if (isTree(spec, r)) {
				note("a nested input with no top level")
			} else if (ownsOrdered(spec, r)) {
				note("a nested input with a top level")
			}
		}
		const input = defined(
			Option.getOrUndefined(
				Arr.findFirst(
					Arr.flatMap(
						succeeded(servedFile(jsonOf(entry.success.text)), "the served file").roles,
						(r) => r.members
					),
					(m) => m.name === member
				)
			),
			"the served ChangeSet"
		).wire.member.input
		assert.ok(input.kind === "call", "a ChangeSet's input is a call's")
		const facts = instanceFacts(spec, rows)
		const call = callOf(
			input.facts,
			new Map(Arr.map(inserted, (r) => [relationName(r), facts.get(r) ?? []] as const))
		)
		const json = succeeded(encodeInput(input, call), "the encode of a drawn instance's facts")
		const parsed = parseInput(input, json)
		assert.ok(
			parsed.ok,
			`the wire parses the JSON its encode writes\n${Formatter.format(parsed)}\n${Formatter.format(json)}`
		)
		assert.deepEqual(parsed.value, call, "the parse reads back the facts the encode wrote")
		assert.deepEqual(
			succeeded(encodeInput(input, parsed.value), "the encode of the parsed facts"),
			json,
			"the parsed facts encode as they did"
		)
		if (
			Arr.some(rows, (row) =>
				Arr.some(row.memberOf, (m) => spec.families[m.family]?.kind === "tree")
			)
		) {
			note("a tree's nodes nested under their root")
		}
	})
