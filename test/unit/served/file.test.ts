/**
 * A served file reads back as the runtime reads it: a login's compiled file, written by servedText and read by
 * servedFile from the JSON value an import of the file yields, is the file the compile served, member by member (Maps
 * and Sets in order, canonical values by their class and payload, a record's undefined members as absent ones), and a
 * file missing any one member does not read back so.
 *
 * Every file is a real login's, compiled as `grizzle generate` compiles it (test/support/served-login.ts compiledLogin,
 * adapter/served/compile.ts snapshotCompiled then servedEntryOf), with no database:
 *
 * - Logins drawn over generated public schemas extended by their law levels (test/support/oracle/public, laws.ts),
 *   under the level's codes, holes and all: roles that read the case's queries, an ordered one whole or paged
 *   (paged(...)), write relations through ChangeSets, and perhaps a query entry reading a context.
 * - A writer of a generated write schema (test/support/oracle/write) running one drawn ChangeSet as a served call
 *   supplies it, its array members' facts the call's and its other members queries.
 * - A writer of the Search fixture (test/support/fixtures/api/search.ts) running its scoring read-back, its query's
 *   vector parameter closed by ChangeSet.bind over the caller's buffer, which the caller writes again after the bind.
 *
 * Properties, of each file:
 * - Round trip: the file read back is the file written (runtimeDifference finds no member that differs).
 * - Each shape once: no record, array, Map or Set the file's JSON value holds as a value stands at two places (its
 *   members but its rosters, the codebook's own form a load reads first, and its table's entries; within each, a
 *   record's members but its `~` marker, a revived array's items, a Map's keys and values, a Set's members) unless its
 *   canonical text is no longer than a reference to the table's next entry (`"~s:<n>"`). A file is of grizzle's
 *   format (core/format.ts artifactFormat) or no served file: without its format, or of another, it is refused at `format` before anything of it is read. And the table is read whole or not at
 *   all: the file without its table is refused as a malformed served file at `shared` (MalformedArtifact), and with its table cut short of its last entry, which only its members reference,
 *   is refused so too, never read with a reference standing for nothing.
 * - A member dropped: one member of the file's JSON value, drawn among all of them, left out; the file read back differs from the
 *   one written, or the reader refuses it: a member the encoder drops is never one the decoder makes up, and no form
 *   the reader cannot read throws.
 * - A host's read: the file's bytes, written to disk, read back and parsed, as an application reads its committed file;
 *   served (adapter/served/served.ts served), which names the file's roles, its login's role read (roleNameOf), and the
 *   layer over it built with no database (DbLayer.make), which loads it (served/load.ts loadServed).
 * - A stale file: the first SQL text of one program, drawn among those stating one, edited, and the file written as
 *   generate writes one; check's difference finder (served/difference.ts servedDifference), reading both texts as a
 *   layer does, names that program.
 * - A bound vector reads back as the vector bound, bit for bit, -0 as 0, the one zero the codec writes
 *   (core/canonical.ts canonicalOf); a vector with a component that is not finite has no canonical text, and no served
 *   file holds it: the served compile refuses it by its name (served-members.ts opaqueBinding), as its bind read it,
 *   whatever the caller writes to it after.
 *
 * The oracle is the file the compile served, compared as the runtime reads it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, int } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { float, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect } from "effect"
import { documentDimensions } from "#test/support/fixtures/api/search.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { changeSetSketchGen, resolveChangeSet } from "#test/support/oracle/write/changeset.ts"
import { factsSketchGen, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { resolveSchema, schemaSketchGen } from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	type BoundFeature,
	boundTrip,
	type ChangeFeature,
	changeTrip,
	component,
	type Feature,
	float32Max,
	loginTrip,
	servedShape
} from "#test/unit/served/file.fixtures.ts"

/**
 * A served file reads back every drawn login's file as the runtime reads it, and no member is dropped unseen.
 *
 * Budget: its suite's count before the conversion (unit/served/file: 60 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aServedFileReadsBackEveryDrawnLoginsFileAsTheRuntimeReadsItAndNoMemberIsDroppedUnseen =
	property.explore(
		(source) =>
			[
				source.draw(caseSketchGen),
				source.draw(lawLevelGen),
				source.draw(int(0, 1_000_000))
			] as const,
		{
			needs: { dir: Scratch.dir },
			situations: [
				"a shape shared",
				"a file without its table refused",
				"a table cut short refused",
				"a read",
				"a paged read",
				"an attachment",
				"a change",
				"a roster with a hole",
				"an unordered roster served",
				"a dropped member that does not read back",
				"a file a host reads that loads",
				"a stale program named",
				"a list holding a Map"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(resources, notes: Case<Feature>) =>
				([sketch, level, pick]) =>
					Effect.flatMap(resources.dir, (dir) =>
						loginTrip(dir, notes.draw(resolveCase(sketch)), level, pick, notes.draw, notes.note)
					).pipe(Effect.scoped, Effect.orDie),
			oracle: {
				kind: "specification",
				name: "the file the compile served, compared as the runtime reads it"
			},
			budget: { runs: 60, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/served/json.ts",
					original: '\tif (!isFormatOf("served", format)) {',
					replacement: "\tif (false) {",
					why: "A served file of no format, or of another, is read as this grizzle's; the format refusals fail."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\tconst written = shareRepeated([new ServedWriter().record(members)], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),`,
					replacement: `\t\t\tconst unshared = new ServedWriter().record(members)\n\t\t\tconst written = shareRepeated([unshared], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),\n\t\t\t\troles: defined(unshared["roles"], "the roles as the writer wrote them"),`,
					why: "The file's roles are written as the writer wrote them, outside the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: '\t\t\treturn { frame: "M", slots: entries.flatMap(entryOf) }',
					replacement: "\t\t\treturn undefined",
					why: "No Map is ever an entry of the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: "\tif (!isList(shared)) {",
					replacement: "\tif (shared === null) {",
					why: "The reader iterates `shared` without reading it as a list; the table's refusal fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\t\t\t(String(Number(payload)) === payload ? this.#shared[Number(payload)] : undefined) ??\n\t\t\t\t\tunread(\n\t\t\t\t\t\twithin,\n\t\t\t\t\t\t\`a reference to an entry of the file's table read before it, one of \${this.#shared.length}, not ~\${tag}:\${payload}\`\n\t\t\t\t\t)`,
					replacement: "\t\t\t\t\tthis.#shared[Number(payload)]",
					why: "A reference is read as whatever the table holds at its index, an entry not read yet included; the table cut short is read rather than refused."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: '\t\t\t\treturn rosterOf(this.#handles, "unordered", payload, within)',
					replacement: '\t\t\t\treturn rosterOf(this.#handles, "ordered", payload, within)',
					why: "An unordered roster is read back as an ordered one, over its live handles in code order; the round trip fails."
				},
				{
					file: "packages/engine/src/core/canonical.ts",
					original: "\tvalue instanceof Map\n",
					replacement: "\tfalse\n",
					why: "The served file's equality reads a Map as outside the model, so two files of one Map differ at the first member holding one, and check names that member, not the stale program."
				}
			]
		}
	)

/**
 * A served file reads back every served ChangeSet as the runtime reads it, and no member is dropped unseen.
 *
 * Budget: its suite's count before the conversion (unit/served/change: 60 independent cases and 16 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aServedFileReadsBackEveryServedChangeSetAsTheRuntimeReadsItAndNoMemberIsDroppedUnseen =
	property.explore(
		(source) =>
			[
				source.draw(schemaSketchGen),
				source.draw(pickGen),
				source.draw(factsSketchGen(5)),
				source.draw(changeSetSketchGen),
				source.draw(int(0, 1_000_000))
			] as const,
		{
			needs: { dir: Scratch.dir },
			situations: [
				"a shape shared",
				"a file without its table refused",
				"a table cut short refused",
				"a served write",
				"an array member",
				"a query member",
				"a read-back",
				"more than one stratum",
				"a dropped member that does not read back",
				"a file a host reads that loads",
				"a stale program named"
			] satisfies ReadonlyArray<Reached<ChangeFeature>>,
			check:
				(resources, notes: Case<ChangeFeature>) =>
				([schemaSketch, groupPick, factsSketch, changesSketch, pick]) =>
					Effect.gen(function* () {
						const schema = notes.draw(resolveSchema(schemaSketch))
						const [first, ...rest] = Arr.filter(schema.groups, (g) => g.role === "drawn")
						if (first === undefined) {
							return
						}
						const group = pickFrom([first, ...rest], groupPick)
						const c = notes.draw(
							resolveChangeSet(group, resolveFacts(group, factsSketch), changesSketch)
						)
						const dir = yield* resources.dir
						yield* changeTrip(dir, group, schema, servedShape(c), pick, notes.note)
					}).pipe(Effect.scoped, Effect.orDie),
			oracle: {
				kind: "specification",
				name: "the served change forms, compared as the runtime reads them"
			},
			budget: { runs: 60, steered: 16 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\tconst written = shareRepeated([new ServedWriter().record(members)], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),`,
					replacement: `\t\t\tconst unshared = new ServedWriter().record(members)\n\t\t\tconst written = shareRepeated([unshared], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),\n\t\t\t\troles: defined(unshared["roles"], "the roles as the writer wrote them"),`,
					why: "The file's roles are written as the writer wrote them, outside the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: '\t\t\treturn { frame: "M", slots: entries.flatMap(entryOf) }',
					replacement: "\t\t\treturn undefined",
					why: "No Map is ever an entry of the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: "\tif (!isList(shared)) {",
					replacement: "\tif (shared === null) {",
					why: "The reader iterates `shared` without reading it as a list; the table's refusal fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\t\t\t(String(Number(payload)) === payload ? this.#shared[Number(payload)] : undefined) ??\n\t\t\t\t\tunread(\n\t\t\t\t\t\twithin,\n\t\t\t\t\t\t\`a reference to an entry of the file's table read before it, one of \${this.#shared.length}, not ~\${tag}:\${payload}\`\n\t\t\t\t\t)`,
					replacement: "\t\t\t\t\tthis.#shared[Number(payload)]",
					why: "A reference is read as whatever the table holds at its index, an entry not read yet included; the table cut short is read rather than refused."
				}
			]
		}
	)

/**
 * A served file reads back every vector a served ChangeSet binds bit for bit as it was bound, and refuses one that is
 * not finite by name.
 *
 * Budget: its suite's count before the conversion (unit/served/bound-vector: 60 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aServedFileReadsBackEveryVectorAServedChangeSetBindsBitForBitAsItWasBoundAndRefusesOneThatIsNotFiniteByName =
	property.explore(
		(source) =>
			[
				source.draw(array(component, { min: documentDimensions, max: documentDimensions })),
				source.draw(int(0, documentDimensions - 1)),
				source.draw(float(-float32Max, float32Max)),
				source.draw(int(0, 1_000_000)),
				source.draw(uuid(4))
			] as const,
		{
			needs: { dir: Scratch.dir },
			situations: [
				"a vector served bit for bit",
				"a vector component of -0",
				"a vector written after it was bound",
				"a vector that is not finite refused",
				"a vector not finite when bound and finite after",
				"a dropped member that does not read back",
				"a file a host reads that loads"
			] satisfies ReadonlyArray<Reached<BoundFeature>>,
			check:
				(resources, notes: Case<BoundFeature>) =>
				([components, at, later, pick, account]) =>
					Effect.flatMap(resources.dir, (dir) =>
						boundTrip(dir, components, at, later, pick, account, notes.note)
					).pipe(Effect.scoped, Effect.orDie),
			oracle: {
				kind: "specification",
				name: "the vector bound, bit for bit with -0 as 0, or its refusal by name where it is not finite"
			},
			budget: { runs: 60, steered: 16 },
			kept: [
				{
					token: ReplayToken(
						"test/unit/served/file.test.ts#aServedFileReadsBackEveryVectorAServedChangeSetBindsBitForBitAsItWasBoundAndRefusesOneThatIsNotFiniteByName:-:2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason: "a vector bound with NaN and written finite after: its bind read it with no text",
					since: "2026-11-10"
				}
			],
			kills: [
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\tconst written = shareRepeated([new ServedWriter().record(members)], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),`,
					replacement: `\t\t\tconst unshared = new ServedWriter().record(members)\n\t\t\tconst written = shareRepeated([unshared], servedSharing)\n\t\t\tconst wire: RostersWire = Object.fromEntries(\n\t\t\t\tArray.from(rosters, ([roster, codes]) => [roster, rosterWire(codes)])\n\t\t\t)\n\t\t\tconst [root] = written.roots\n\t\t\treturn {\n\t\t\t\t...membersRecord(defined(root, "a served file's members")),\n\t\t\t\troles: defined(unshared["roles"], "the roles as the writer wrote them"),`,
					why: "The file's roles are written as the writer wrote them, outside the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: '\t\t\treturn { frame: "M", slots: entries.flatMap(entryOf) }',
					replacement: "\t\t\treturn undefined",
					why: "No Map is ever an entry of the table; each shape once fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: "\tif (!isList(shared)) {",
					replacement: "\tif (shared === null) {",
					why: "The reader iterates `shared` without reading it as a list; the table's refusal fails."
				},
				{
					file: "packages/engine/src/served/json.ts",
					original: `\t\t\t\t\t(String(Number(payload)) === payload ? this.#shared[Number(payload)] : undefined) ??\n\t\t\t\t\tunread(\n\t\t\t\t\t\twithin,\n\t\t\t\t\t\t\`a reference to an entry of the file's table read before it, one of \${this.#shared.length}, not ~\${tag}:\${payload}\`\n\t\t\t\t\t)`,
					replacement: "\t\t\t\t\tthis.#shared[Number(payload)]",
					why: "A reference is read as whatever the table holds at its index, an entry not read yet included; the table cut short is read rather than refused."
				},
				{
					file: "packages/engine/src/write/program/compile.ts",
					original: '\tb.statements.length === 0 ? "own" : "write"',
					replacement: '\t"write"',
					why: "A ChangeSet of reads alone lowers its read-back to admit nothing, as one after a statement of its write's own, so its flight holds no statement that admits its caller parameters and its compile dies an internal invariant (write/program/admission.ts readBackAdmitted), as the vector ChangeSet's did since PLANONCE folded the admission into the flight."
				}
			]
		}
	)
