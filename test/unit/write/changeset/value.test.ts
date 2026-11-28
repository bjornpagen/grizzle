/**
 * The ChangeSet value's algebra, against a host model of it written from its documented rules (the JSDoc of
 * `ChangeSetValue`):
 *
 * - a ChangeSet is a list of strata, each a bag of members, and a set of read-backs by name, over a level;
 * - insert, delete and put add a member to the last stratum, sequence concatenates strata, union combines them position
 *   by position, and an empty stratum is kept;
 * - within a stratum, the array members of one operation on one relation are one member whose facts are theirs
 *   concatenated, equal query members are one, and the Streams of one operation on one relation keep their order;
 * - every value is sealed: no step changes an earlier value, and an array's facts are copied when it is added;
 * - a member, a read-back, a union and a sequence are over a level: a query over a higher level, a relation of a
 *   higher level, and two levels neither of which is a level of the other are refused;
 * - a ChangeSet's read-backs are one set by name across the whole ChangeSet, read once after it: a read, a union, a
 *   sequence or a fork that brings two of one name over one query together (one shape, bound alike) makes them one,
 *   and one name over two queries is refused; the outcome's decoder of them is one record in name order, the same
 *   whatever order they were built or combined in, as a served file holds it;
 * - bind closes every free parameter with a value, no more and no NULL, and a bound parameter leaves the namespace: a
 *   parameter of its name added later, or brought by a combined ChangeSet, is free and separate.
 *
 * A program of steps over a pool of ChangeSets (property.stateful, a planned machine) is judged step by step: what the real
 * value holds, read back into the model's terms (each query member and read-back recognised as the one its shape and
 * its parameters' values make), must be the model's prediction, with every earlier value's Description unchanged; and
 * the Description must be canonical, the same text as the normal form that builds the model's ChangeSet member by
 * member, unions each stratum's members in model order and sequences the strata. A malformed call from a JavaScript
 * caller is a planted fault on a valid value, refused as MalformedDescription, every kind of it reached.
 *
 * The level check is held to the query compiler's own (querySchema against the ChangeSet's schema, a differential) over
 * the fixtures, each root renamed to a dictionary name other than its own, with a relation added or a statement
 * removed, and the role rebuilt or renamed. Bind reads the caller's map once, held to its specification over live maps
 * and hostile ones (a throwing getter, a proxy) as the map or as a fact.
 *
 * Features: each step kind of the algebra and each planted fault kind (StepFeature); the schema itself, a level, no
 * level, each kind of rename, a relation added, a statement removed, a role rebuilt; a live map, each hostile value as
 * the map and as a fact.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, codePoint, constant, int, map, string } from "@bjornpagen/testing/gen"
import { lsw, passed } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { querySchema } from "#compiler/program/compile.ts"
import { queryInput } from "#compiler/program/input.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { schemaInputOf } from "#test/support/compile.ts"
import { parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	algebraOf,
	type AlgebraFeature,
	type BindFeature,
	commandNames,
	faults,
	hostile,
	type LevelPairFeature,
	levelPairSpace,
	machine,
	malformed,
	note,
	rules,
	withNotes
} from "#test/unit/write/changeset/value.fixtures.ts"

/**
 * The ChangeSet algebra builds the model's ChangeSet at every step, canonical, sealed and refused exactly where the
 * model refuses.
 *
 * Budget: 300 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/value.test.ts:1569 at 8cad5bce, its runs and its coverage's cases).
 */
export const theChangeSetAlgebraBuildsTheModelsChangeSetAtEveryStepCanonicalSealedAndRefusedExactlyWhereTheModelRefuses =
	property.stateful(
		{
			kind: "planned",
			machine,
			mix: constant(fullSwarm(commandNames)),
			real: (_, c: Case<AlgebraFeature>) => Effect.sync(() => algebraOf(c))
		},
		{
			size: { min: 1, max: 20 },
			needs: {},
			budget: { runs: 300, steered: 400 },
			situations: [
				"an array member",
				"a Stream member",
				"a query member",
				"array members merged",
				"a query member deduplicated",
				"two Streams of one group",
				"an empty stratum kept",
				"three strata",
				"a delta read-back",
				"an ordered read-back",
				"two private parameters of one name",
				"a private parameter shared by two uses",
				"tied members, one sharing a private parameter",
				"a free parameter beside a private one of its name",
				"a free parameter spelled like a private name",
				"a union over a higher level",
				"a union of more strata on one side",
				"a read-back repeated over one query",
				"read-backs read out of name order",
				...Arr.map(rules, (rule): AlgebraFeature => `refused: ${rule}`),
				...Arr.map(faults, (fault): AlgebraFeature => `fault: ${fault}`)
			] satisfies ReadonlyArray<Reached<AlgebraFeature>>,
			oracle: {
				kind: "second-implementation",
				name: "a host model of the ChangeSet algebra, and its normal form's Description"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: "\tconst n = Math.max(x.strata.length, y.strata.length)",
					replacement: "\tconst n = Math.min(x.strata.length, y.strata.length)",
					why: "union combines strata only up to the shorter ChangeSet's, dropping the longer one's later strata."
				},
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: "\t\t} else if (held.identity !== r.identity) {",
					replacement: "\t\t} else {",
					why: "the read-back set refuses every repeated name again, two read-backs of one name over one query among them, where the model makes them one (metis's showItem, two programs that each read standing over one query, composed by sequence)."
				},
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: "\tdecoderOf<Rd>(recordOf(reads.map((r) => new Named(r.name, r.field))).form)",
					replacement:
						"\tdecoderOf<Rd>(recordOf(reads.toReversed().map((r) => new Named(r.name, r.field))).form)",
					why: "the outcome's decoder of the read-backs leaves name order, so its record, which a served file holds, no longer follows from the set alone; the Description, sorted by name, is unchanged."
				}
			]
		}
	)

/**
 * The level check admits a query over a schema exactly where the query compiler compiles it against the ChangeSet's
 * schema.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/value.test.ts:1732 at 8cad5bce, its runs and its coverage's cases).
 */
export const theLevelCheckAdmitsAQueryOverASchemaExactlyWhereTheQueryCompilerCompilesItAgainstTheChangeSetsSchema =
	property.explore(levelPairSpace, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"the schema itself",
			"a level",
			"no level",
			"renamed: plain",
			"a relation added",
			"a statement removed",
			"a role rebuilt",
			"role renamed: plain"
		] satisfies ReadonlyArray<Reached<LevelPairFeature>>,
		check:
			(_, c: Case<LevelPairFeature>) =>
			([carried, named]) =>
				Effect.sync(() => {
					const namedSchema = named.kind === "fixture" ? named.subject.schema : named.schema
					const q = query(carried.schema).rule((r: RuleValue) => {
						const vars = v(carried.relation, "relation")
						return r.match(carried.relation, vars).find(vars)
					})
					const input = queryInput(q)
					const compiles = input.ok && querySchema(input.value, schemaInputOf(namedSchema)).ok
					switch (named.kind) {
						case "fixture":
							c.note(
								named.subject === carried ? "the schema itself" : compiles ? "a level" : "no level"
							)
							break
						case "renamed":
							c.note(`renamed: ${named.feature}`)
							break
						case "relation added":
							c.note("a relation added")
							break
						case "statement removed":
							c.note("a statement removed")
							break
						case "role rebuilt":
							c.note("a role rebuilt")
							break
						case "role renamed":
							c.note(`role renamed: ${named.feature}`)
							break
					}
					/** A refusal is a CompileError, never a defect: anything else thrown fails the case. */
					const admitted = catchCompileError(() =>
						ChangeSet.empty(namedSchema).read("r", () => q)
					).ok
					assert.equal(
						admitted,
						compiles,
						`a query over ${carried.label} in a ChangeSet over a ${named.kind} schema`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the query compiler's own level check, querySchema against the ChangeSet's schema"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original:
					"\t}\n\trequireLevel(built.schema.over, state.over, label)\n\tconst query = publicDesc(built, label)",
				replacement: "\t}\n\t{}\n\tconst query = publicDesc(built, label)",
				why: "Operator mutant (statement) at packages/engine/src/write/changeset/value.ts:1011 in addRead: `requireLevel(built.schema.over, state.over, label)` becomes `{}`; the property fails (lane CATCH, grizzle b0d74512)."
			}
		]
	})

/**
 * Bind reads the caller's map once: a map or a fact whose reading throws is refused, a live one bound as a copy.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/value.test.ts:1834 at 8cad5bce, its runs and its coverage's cases).
 */
export const bindReadsTheCallersMapOnceAMapOrAFactWhoseReadingThrowsIsRefusedALiveOneBoundAsACopy =
	property.explore(
		lsw({
			live: (source) => ({
				task: source.draw(map(int(0, 1000), uuidOf)),
				operator: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 8 })),
				notes: source.draw(
					array(lsw({ live: map(int(0, 1000), note), stale: Option.none(), wild: hostile }), {
						min: 0,
						max: 4
					})
				)
			}),
			stale: Option.none(),
			wild: hostile
		}),
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: [
				"a live map",
				"throwing-getter as the map",
				"proxy as the map",
				"throwing-getter as a fact",
				"proxy as a fact"
			] satisfies ReadonlyArray<Reached<BindFeature>>,
			check: (_, c: Case<BindFeature>) => (drawnMap) =>
				Effect.sync(() => {
					if (drawnMap.kind === "wild") {
						c.note(`${drawnMap.wild.kind} as the map`)
						malformed(() => withNotes().bind(passed(drawnMap)))
						return
					}
					const { task, operator, notes } = drawnMap.value
					const wild = Arr.flatMap(notes, (f) => (f.kind === "wild" ? [f.wild.kind] : []))
					if (wild.length > 0) {
						c.noteAll(Arr.map(wild, (kind): BindFeature => `${kind} as a fact`))
						malformed(() =>
							withNotes().bind({ task, operator, notes: Arr.map(notes, (f) => passed(f)) })
						)
						return
					}
					c.note("a live map")
					const facts = Arr.flatMap(notes, (f) => (f.kind === "wild" ? [] : [f.value]))
					const callers = Arr.map(facts, (f) => ({ ...f }))
					const bound = withNotes().bind({ task, operator, notes: callers })
					callers.push(note(1001))
					for (const f of callers) {
						f.note = "changed"
					}
					assert.deepEqual(Rec.fromEntries(parsedOf(bound).values), {
						task,
						operator,
						notes: facts
					})
				}),
			oracle: {
				kind: "specification",
				name: "bind reads the caller's map once: a reading that throws is MalformedDescription, a live map bound as the copy it read"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: '{ kind: "value", value: owned(value, ownedBound) }',
					replacement: '{ kind: "value", value }',
					why: "bind keeps the caller's values as they are, never the copy it read, so a later write to a live map's array reaches the bound value."
				}
			]
		}
	)
