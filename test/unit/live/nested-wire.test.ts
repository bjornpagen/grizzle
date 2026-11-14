/**
 * A nested insert's wire (live/member.ts memberShape, over runtime/write/nesting.ts NestingData), over drawn schemas of
 * trees, ordered and counted families nested in each other, folds and copies (test/support/families/fill.ts), each
 * served by a login of one role whose workload holds one ChangeSet inserting every relation an instance of the schema
 * inserts, its array members the call's, as `grizzle generate` compiles it, with no database:
 *
 * - Every nesting the write compiler accepts projects to a wire: where the login's compile accepts the ChangeSet
 *   (adapter/served/compile.ts snapshotCompiled), its projection into the served file holds its wire, or refuses it as
 *   a member no served file holds (UnservedMember), the compiler's own refusal to serve it, and never as a CompileError.
 * - The wire's exact parse reads back what its encode writes (live/codec.ts parseInput, encodeInput): a drawn
 *   instance's facts, each nested to any depth under its count fields, encode to JSON the parse reads back as those
 *   facts, which encode to that JSON again.
 *
 * Oracle: the write compiler's acceptance of the ChangeSet, and the codec's own encode of each drawn instance.
 *
 * Features: a nested input with no top level (a tree's roots, whose own level stands at the tree's root), a nested
 * input with a top level, a tree's nodes nested under their root; rated: a write no served file holds, whose wire the
 * property does not reach.
 *
 * Plants (~/.cache/grizzle-release/LIVE-NEST/plants): nest-top-level (a nested input's own level found as the one at the
 * top, so a tree's roots refuse), nest-tree-members-at-root (a tree's members read at its roots' level).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { rating, required } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { servedEntryOf, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { encodeInput, type ParsedInput, parseInput } from "#compiler/live/codec.ts"
import type { WireFacts } from "#compiler/live/shape.ts"
import type { WireScalar } from "#compiler/live/wire.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"

type Feature =
	| "a nested input with no top level"
	| "a nested input with a top level"
	| "a tree's nodes nested under their root"
	| "a write no served file holds"

interface NestCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
}

const caseGen: Gen<NestCase> = (source) => {
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

const property = (c: NestCase, note: (feature: Feature) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { spec, rows } = c
		const built = buildFill(spec)
		const value = built.rename("Nest")
		const inserted = insertedRelations(spec)
		const change = insertAll(value, built, inserted)
		const writer = role(value, "writer", wholeEntriesOf(value), { write: writableNamesOf(value) })
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
				snapshotCompiled({ login: served, owned }, snapshot)
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
					Arr.flatMap(entry.success.file.roles, (r) => r.members),
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
		const json = encodeInput(input, call)
		const parsed = parseInput(input, json)
		assert.ok(
			parsed.ok,
			`the wire parses the JSON its encode writes\n${Formatter.format(parsed)}\n${Formatter.format(json)}`
		)
		assert.deepEqual(parsed.value, call, "the parse reads back the facts the encode wrote")
		assert.deepEqual(encodeInput(input, parsed.value), json, "the parsed facts encode as they did")
		if (
			Arr.some(rows, (row) =>
				Arr.some(row.memberOf, (m) => spec.families[m.family]?.kind === "tree")
			)
		) {
			note("a tree's nodes nested under their root")
		}
	})

describe("a nested insert's wire", () => {
	it.effect("projects every nesting the write compiler accepts, and round-trips its facts", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/live/nested-wire",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: rating(
						required<Feature>(
							[
								"a nested input with no top level",
								"a nested input with a top level",
								"a tree's nodes nested under their root"
							],
							{ cases: 120, sense: notesOnly }
						),
						["a write no served file holds"]
					),
					kept: [],
					runs: 60,
					shrink: boundedShrink(200),
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					oracle: {
						kind: "specification",
						name: "the write compiler's acceptance of the ChangeSet and the codec's own encode of each drawn instance"
					}
				},
				(c, at) => property(c, (feature) => at.note(feature))
			)
		)
	)
})
