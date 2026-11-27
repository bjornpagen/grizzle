/**
 * A missed index is an internal compiler error at every write a login serves (packages/engine/src/physical/access/seeks.ts
 * judgeSeeks): generate compiles each ChangeSet before the installation it is served beside plans its indexes, so each
 * served write keeps its statements' seek program (packages/engine/src/write/program/served.ts ServableWrite `seeks`),
 * read off their ASTs before they go, and generate's served step judges it at the installation's tables and views
 * (packages/grizzle/src/adapter/served/compile.ts servedEntry), every read through the role's view of its relation read
 * as the table PostgreSQL expands it into. The bound: a write's seek of k rows at a binding an index's leading run holds
 * is O(k log n); with none it reads its table, O(n), at every call.
 *
 * The box: a roster Kind, R(k, v, kind) keyed by k and mutable, and Tag(r, label) keyed by r; the login `app` of one
 * role over every relation whole, writing R and inserting Tag, serving a drawn set of change members: an insert of R
 * and of Tag, a put of R from a relation parameter, a delete of R's rows at a value of v and at a key, and a read-back of
 * every R with its tag and of one Tag at its key.
 *
 * Oracle: the specification. Generate serves every member at the installation it drafts; each member's served program
 * seeks at least what its semantics read (served-seeks.fixtures.ts `specified`): a write of a relation at its key, a
 * delete at a field at that field through the role's view and at the keys of the rows it found, a read-back of Tag at
 * its key; and with the indexes serving any of its seeks dropped from the installation, as an extraction that missed
 * them would leave it, generate's served step refuses as a missed index naming a write whose seek no index left serves
 * (served-seeks.fixtures.ts `seekServed`).
 *
 * Features: each member kind served; a refusal where a key's index is dropped, and where the index a delete at a field
 * asked is.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	caseGen,
	drafted,
	type MemberKind,
	memberName,
	seekServed,
	specified,
	spelled,
	tableOf,
	withoutIndexes
} from "#test/unit/cli/served-seeks.fixtures.ts"

type Feature =
	| MemberKind
	| "a write refused where its key's index is dropped"
	| "a write refused where the index a delete at a field asked is dropped"

/** Every served write's seeks are covered at the installation generate drafts, and one no index serves is refused. */
export const everyServedWritesSeeksAreCoveredAndOneNoIndexServesIsRefusedAtGenerate =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"insertR",
			"insertTag",
			"putR",
			"deleteAtV",
			"deleteAtK",
			"readBackTagged",
			"readBackOne",
			"a write refused where its key's index is dropped",
			"a write refused where the index a delete at a field asked is dropped"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 16, steered: 64 },
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				const d = yield* drafted(c)
				const served = yield* d.serve(d.targets)
				assert.equal(served, undefined, "generate serves every write at the installation it drafts")
				const drops = new Set<string>()
				for (const kind of c.members) {
					notes.note(kind)
					const seeks = d.seeksAt(kind, d.targets)
					const made = new Set(Arr.map(seeks, spelled))
					for (const s of specified[kind]) {
						assert.ok(
							made.has(spelled(s)),
							`the write ${kind} seeks ${spelled(s)} (it seeks ${Arr.join([...made], ", ")})`
						)
					}
					for (const s of seeks) {
						const table = tableOf(d.targets, s.relation)
						for (const i of table.indexes) {
							if (seekServed({ ...table, indexes: [i] }, s.bound)) {
								drops.add(i.name)
							}
						}
					}
				}
				for (const drop of drops) {
					const without = withoutIndexes(d.targets, new Set([drop]))
					const unserved = Arr.filter(c.members, (kind) =>
						Arr.some(
							d.seeksAt(kind, without),
							(s) => !seekServed(tableOf(without, s.relation), s.bound)
						)
					)
					const refusal = yield* d.serve(without)
					if (!Arr.isReadonlyArrayNonEmpty(unserved)) {
						assert.equal(
							refusal,
							undefined,
							`with ${drop} dropped every write's seek is still served`
						)
						continue
					}
					const named = defined(
						refusal,
						`with ${drop} dropped generate refuses a write of ${Arr.join(unserved, ", ")}`
					)
					assert.ok(
						Arr.some(unserved, (kind) =>
							Str.includes(`missed index: the write ${memberName(kind)} of role a0 of login app`)(
								named
							)
						),
						`with ${drop} dropped generate refuses a write of ${Arr.join(unserved, ", ")} as a missed index: ${named}`
					)
					notes.note(
						Str.includes("_pk_")(drop)
							? "a write refused where its key's index is dropped"
							: "a write refused where the index a delete at a field asked is dropped"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the seeks each member's semantics read, every one served at the installation generate drafts, and a write whose seek no index left serves refused as a missed index"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/served.ts",
				original: "\t\tseeks: seekProgram(statementAsts),\n",
				replacement: "\t\tseeks: seekProgram([]),\n",
				why: "A served write keeps no seek program: generate judges none of a write's seeks, and a delete at a field no index serves is served to scan its table at every call."
			},
			{
				file: "packages/engine/src/write/program/served.ts",
				original: "\t\tseeks: seekProgram(statementAsts),\n",
				replacement:
					'\t\tseeks: seekProgram(artifact.statements.filter((s) => s.step.kind !== "readBack").flatMap((s) => (s.forms.kind === "chosen" ? [s.ast, s.forms.large.ast] : [s.ast]))),\n',
				why: "A write's read-backs are left out of its program: a read-back of Tag at each R's key is judged at no index."
			},
			{
				file: "packages/engine/src/physical/access/seeks.ts",
				original: "\t\t\t.toSorted((x, y) => compareStrings(x.field, y.field))\n",
				replacement:
					"\t\t\t.toSorted((x, y) => compareStrings(x.field, y.field))\n\t\t\t.slice(1)\n",
				why: "A served write's request leaves out a column its seek binds: a delete at R's v asks no index at v, and generate refuses the write as a missed index, as an extraction that never asked the binding its statement prints did (curriculumHistories' publish)."
			},
			{
				file: "packages/grizzle/src/adapter/served/compile.ts",
				original: "\tfor (const [name, role] of changes) {\n",
				replacement: "\tfor (const [name, role] of new Map<string, never>()) {\n",
				why: "Generate's served step judges no write: a write's seek no index serves is served, a scan of its table found only where the file runs."
			}
		]
	})
