import { assert } from "@bjornpagen/testing/assert"
/**
 * Primary keys over a key generation, against PostgreSQL 19 (INTERFACE.md of lane GENPK): a generated field the primary
 * key holds, here the SHA-256 of a package entry's path, which no B-tree entry could hold as itself past 2,704 bytes,
 * is written by grizzle and proved by a row CHECK, so the path keys its row through its digest. A write names its rows
 * by their texts: an insert and a put state the path, never the digest, which grizzle fills before it compares any two
 * facts at a key; a delete names its fact by every field it states.
 *
 * The box: StimulusRef, pantry's shape (package, path, start, identifier), keyed by (package, pathDigest, start), its
 * digest the path's; and FoldedRef, the same shape keyed by the digest of the path with its ASCII letters lowered, so
 * two paths that differ in case meet at one key though their texts differ: both mutable, each package's rows one unit. Paths are four short
 * spellings of two stems, and three past PostgreSQL's B-tree entry limit (btreeMaxItemSize + 1 bytes), so a write meets
 * stored rows and itself at every key, by its texts and, in FoldedRef, by its generation alone. A case stores a lawful
 * state, then writes one to three strata, each an insert, a put and a delete of each relation, each of up to two facts
 * near the stored ones: a stored fact, with another identifier, with another path, or fresh.
 *
 * The oracle is a host model keyed by the generations of the texts, computed apart from grizzle (node:crypto's
 * SHA-256 over the UTF-8 of the path or of its ASCII-lowered form): a stratum removes the facts its deletions name
 * exactly and the stored occupant of each put's key, then adds its inserts and puts, identical facts one; two facts left
 * at one key are the primary key's violation, refused with nothing changed; otherwise the rows after it are the
 * model's, each read back with its digest as the model computes it, accepted where it changed a row and unchanged
 * otherwise.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, constant } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	Doc,
	docLines,
	Line,
	type DocRow,
	docPutAfter,
	familyAfter,
	type FamilyBreach,
	familyCaseGen,
	familyRowsOf,
	groupKey,
	nodes,
	setAfter,
	setCaseGen,
	setKey,
	setRowsOf,
	type SetState,
	SetString,
	TreeNode,
	type TreeRow,
	type FlatCase,
	flatAfter,
	flatCaseGen,
	type FlatName,
	flatRelations,
	flatRowsOf,
	type FlatState,
	type FlatWrites,
	GeneratedKeys,
	generatedKeysInstall,
	generatedKeysTemplate,
	FoldedRef,
	keyOf,
	pastEntryLimit,
	StimulusRef
} from "#test/pg/write/generated-pk/generated-pk.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What a flat case reaches. */
type FlatFeature =
	| "accepted"
	| "unchanged"
	| "refused: two texts at one key"
	| "refused: two spellings meet at one generated key"
	| "a put replaces a stored path at its generated key"
	| "a delete stating another spelling removes nothing"
	| "a path past the entry limit stored"
	| "edullm: a stimulus ref whose path is past the entry limit"

/**
 * edullm's case (pantry's StimulusRef, lane GENPK's brief): a stimulus ref of a document whose path is past the B-tree
 * entry limit, inserted, then put with another identifier, then deleted by its texts.
 */
const edullmPath = `items/${Str.repeat(pastEntryLimit)("x")}.xml`
const edullmRef = { package: "p", path: edullmPath, start: 7n, identifier: "i" } as const
const none: FlatWrites = { insert: [], put: [], delete: [] }
const edullmCase: FlatCase = {
	stored: { StimulusRef: new Map(), FoldedRef: new Map() },
	strata: [
		{ StimulusRef: { ...none, insert: [edullmRef] }, FoldedRef: none },
		{ StimulusRef: { ...none, put: [{ ...edullmRef, identifier: "j" }] }, FoldedRef: none },
		{ StimulusRef: { ...none, delete: [{ ...edullmRef, identifier: "j" }] }, FoldedRef: none }
	]
}

/** The texts of a row a flat relation's read gives, as flatRowsOf spells the model's. */
const readRow = (
	r: Readonly<{ package: string; path: string; start: bigint; identifier: string }>,
	digest: Uint8Array
): ReadonlyArray<string> => [r.package, r.path, String(r.start), r.identifier, digest.toHex()]

/** Each flat relation's facts in one stratum's call, as its members take them. */
const factsOf = (strat: Readonly<Record<FlatName, FlatWrites>>) => ({
	insert: {
		StimulusRef: strat.StimulusRef.insert,
		FoldedRef: strat.FoldedRef.insert,
		Doc: [],
		TreeNode: []
	},
	put: { StimulusRef: strat.StimulusRef.put, FoldedRef: strat.FoldedRef.put },
	delete: {
		StimulusRef: strat.StimulusRef.delete,
		FoldedRef: strat.FoldedRef.delete,
		Doc: [],
		TreeNode: []
	}
})

/** The features one applied or refused stratum reaches, beside its outcome's. */
const notesOf = (
	strat: Readonly<Record<FlatName, FlatWrites>>,
	before: Readonly<Record<FlatName, FlatState>>
): ReadonlyArray<FlatFeature> =>
	Arr.flatMap(flatRelations, (name): ReadonlyArray<FlatFeature> => {
		const w = strat[name]
		const stored = [...before[name].values()]
		const replaced = Arr.some(w.put, (p) =>
			Arr.some(stored, (s) => keyOf(name, s) === keyOf(name, p) && s.path !== p.path)
		)
		const missed = Arr.some(w.delete, (d) =>
			Arr.some(stored, (s) => keyOf(name, s) === keyOf(name, d) && s.path !== d.path)
		)
		return [
			...(replaced ? ["a put replaces a stored path at its generated key" as const] : []),
			...(missed ? ["a delete stating another spelling removes nothing" as const] : [])
		]
	})

/**
 * A write names its rows by their texts and meets every other fact at its key generation, the digest PostgreSQL proves:
 * its rows after each stratum are the host model's, keyed by the generations of the texts.
 */
export const aWriteNamesItsRowsByTheirTextsAndMeetsEveryOtherFactAtItsKeyGeneration =
	property.explore(
		aimed(flatCaseGen, [
			["edullm: a stimulus ref whose path is past the entry limit", constant(edullmCase)]
		]),
		{
			needs: { fixture: Substrate.fresh(generatedKeysTemplate) },
			situations: [
				"accepted",
				"unchanged",
				"refused: two texts at one key",
				"refused: two spellings meet at one generated key",
				"a put replaces a stored path at its generated key",
				"a delete stating another spelling removes nothing",
				"a path past the entry limit stored",
				"edullm: a stimulus ref whose path is past the entry limit"
			] satisfies ReadonlyArray<Reached<FlatFeature>>,
			check:
				({ fixture }, cx: Case<FlatFeature>) =>
				(c) =>
					Effect.scoped(
						Effect.flatMap(fixture, (taken) =>
							Effect.provideService(
								Effect.gen(function* () {
									const o = yield* openedIn(GeneratedKeys, {}, generatedKeysInstall, taken)
									const names = namesOf(o.installed)
									return yield* Effect.gen(function* () {
										const db = yield* Db.open(o.served.login.roles.app, {})
										const readFlat = Effect.gen(function* () {
											const refs = yield* rowsOf(
												db.workload.stimulusRefs.once({ params: {}, facts: {} })
											)
											const folded = yield* rowsOf(
												db.workload.foldedRefs.once({ params: {}, facts: {} })
											)
											const sorted = (
												rows: ReadonlyArray<ReadonlyArray<string>>
											): ReadonlyArray<ReadonlyArray<string>> =>
												Arr.sort(rows, Arr.makeOrder(Order.String))
											return {
												StimulusRef: sorted(Arr.map(refs, (r) => readRow(r, r.pathDigest))),
												FoldedRef: sorted(Arr.map(folded, (r) => readRow(r, r.foldDigest)))
											}
										})
										const seeded = yield* writeAnswerOf(
											db.workload.seed.once({
												params: {},
												facts: {
													insert: {
														StimulusRef: [...c.stored.StimulusRef.values()],
														FoldedRef: [...c.stored.FoldedRef.values()],
														Doc: [],
														TreeNode: []
													}
												}
											})
										)
										const empty = c.stored.StimulusRef.size + c.stored.FoldedRef.size === 0
										assert.equal(
											seeded.kind,
											empty ? "unchanged" : "accepted",
											"the stored rows are lawful"
										)
										let state: Readonly<Record<FlatName, FlatState>> = c.stored
										for (const strat of c.strata) {
											const before = yield* readFlat
											for (const name of flatRelations) {
												assert.deepEqual(
													before[name],
													flatRowsOf(name, state[name]),
													`${name}'s rows are the model's`
												)
											}
											const outcomes = {
												StimulusRef: flatAfter("StimulusRef", state.StimulusRef, strat.StimulusRef),
												FoldedRef: flatAfter("FoldedRef", state.FoldedRef, strat.FoldedRef)
											}
											const upserts =
												strat.StimulusRef.delete.length + strat.FoldedRef.delete.length === 0
											const outcome = yield* writeAnswerOf(
												upserts
													? db.workload.upserts.once({
															params: {},
															facts: {
																insert: {
																	StimulusRef: strat.StimulusRef.insert,
																	FoldedRef: strat.FoldedRef.insert
																},
																put: {
																	StimulusRef: strat.StimulusRef.put,
																	FoldedRef: strat.FoldedRef.put
																}
															}
														})
													: db.workload.stratum.once({ params: {}, facts: factsOf(strat) })
											)
											const refusedBy = Arr.filter(
												flatRelations,
												(name) => outcomes[name].kind === "refused"
											)
											const after = yield* readFlat
											if (refusedBy.length > 0) {
												if (outcome.kind !== "refused") {
													return assert.fail(
														`${Formatter.format(strat)} puts two facts at one key of ${Arr.join(refusedBy, ", ")}: refused, not ${outcome.kind}`
													)
												}
												assert.deepEqual(after, before, "a refused write changes nothing")
												const laws = Arr.map(refusedBy, (name) =>
													names.primaryKeyLaw(name === "StimulusRef" ? StimulusRef : FoldedRef)
												)
												const named = Arr.map(refusedEntries(outcome.refused), names.reported)
												assert.ok(
													Arr.some(named, (law) => Arr.contains(laws, law)),
													`the refusal names ${Arr.join(named, ", ")}, the primary key of ${Arr.join(refusedBy, ", ")}`
												)
												const witness = outcome.witness
												if (witness.kind === "key") {
													const name =
														witness.relation === "FoldedRef" ? "FoldedRef" : "StimulusRef"
													const digest =
														name === "FoldedRef"
															? witness.values["foldDigest"]
															: witness.values["pathDigest"]
													const at = outcomes[name]
													assert.ok(
														at.kind === "refused" &&
															digest instanceof Uint8Array &&
															Arr.some(at.keys, Str.includes(digest.toHex())),
														`the witness ${Formatter.format(witness)} names a key two facts of ${name} meet at`
													)
												}
												cx.note(
													Arr.some(refusedBy, (name) => {
														const w = strat[name]
														const added = [...w.insert, ...w.put]
														return Arr.some(added, (a) =>
															Arr.some(
																[...added, ...state[name].values()],
																(b) => keyOf(name, a) === keyOf(name, b) && a.path !== b.path
															)
														)
													})
														? "refused: two spellings meet at one generated key"
														: "refused: two texts at one key"
												)
												return
											}
											const next = {
												StimulusRef:
													outcomes.StimulusRef.kind === "applied"
														? outcomes.StimulusRef.state
														: state.StimulusRef,
												FoldedRef:
													outcomes.FoldedRef.kind === "applied"
														? outcomes.FoldedRef.state
														: state.FoldedRef
											}
											const changed = Arr.some(flatRelations, (name) => {
												const x = outcomes[name]
												return x.kind === "applied" && x.changed
											})
											assert.equal(
												outcome.kind,
												changed ? "accepted" : "unchanged",
												"accepted where the write changed a row"
											)
											for (const name of flatRelations) {
												assert.deepEqual(
													after[name],
													flatRowsOf(name, next[name]),
													`${name}'s rows after the write are the model's`
												)
											}
											cx.note(changed ? "accepted" : "unchanged")
											for (const note of notesOf(strat, state)) {
												cx.note(note)
											}
											if (
												Arr.some(flatRelations, (name) =>
													Arr.some([...next[name].values()], (r) => r.path.length >= pastEntryLimit)
												)
											) {
												cx.note("a path past the entry limit stored")
											}
											if (
												Arr.some([...next.StimulusRef.values()], (r) => r.path === edullmPath) ||
												Arr.some(strat.StimulusRef.delete, (r) => r.path === edullmPath)
											) {
												cx.note("edullm: a stimulus ref whose path is past the entry limit")
											}
											state = next
										}
									}).pipe(Effect.scoped, withLayer(o.served.layer))
								}),
								Substrate,
								taken.substrate
							)
						)
					),
			oracle: {
				kind: "specification",
				name: "a host model keyed by the generations of the texts, node:crypto's SHA-256 of the path or its ASCII-lowered form: deletions by every field, puts displacing at the key, two facts at one key refused"
			},
			show: Formatter.format,
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/normalize.ts",
					original: "\tif (fill.generations.length === 0) {\n\t\treturn Result.ok(stated)\n\t}",
					replacement: "\tif (fill.generations.length >= 0) {\n\t\treturn Result.ok(stated)\n\t}",
					why: "GENPK-B's compare unfilled keys: the host judges and sends a fact before it fills its key generation (runtime/write/normalize.ts filledFacts skipped)."
				},
				{
					file: "packages/engine/src/write/delete/exact.ts",
					original:
						"\t\t\t\t\t\tfactEq({ fields: compared, typeOf, left: stored, right: inCol }, w.names),\n",
					replacement:
						'\t\t\t\t\t\tfactEq({ fields: compared.filter((f) => f.name !== "path"), typeOf, left: stored, right: inCol }, w.names),\n',
					why: "An exact deletion meets a stored fact at its key generation alone, not at the text it states: a delete stating another spelling of a stored path at FoldedRef's folded key generation removes the stored row, where a deletion removes only a fact equal at every field, and the search fails. (A put of FoldedRef is an ON CONFLICT DO UPDATE, write/put/choose.ts, so no displacing deletion meets a folded key generation in this box.)"
				}
			]
		}
	)
/** What a family case reaches. */
type FamilyFeature =
	| "accepted"
	| "unchanged"
	| "a document inserted with lines and notes"
	| "a title put cascades to every line and note"
	| "a document deleted with its members"
	| "a delete stating another title removes nothing"
	| "a tree inserted"
	| "a tree deleted by its root's texts"
	| "refused: a document at a stored key"
	| "refused: a line whose path is not its document's"
	| "refused: a tree at a stored key"
	| "refused: a tree's member whose path is not its root's"
	| "a member path past the entry limit"

/**
 * A family over a key generation groups its members by the owner's digest, a flat member's its own generation over the
 * path it states and a note's the owner's copied as stored, and a tree's by its root's: inserts nest, a title's put
 * cascades to every copy with each member's CHECK holding, an owner's delete takes its members, and a member whose
 * path's digest is not its owner's is refused by the family's owner axis.
 *
 * The box: Doc (package, path, title), keyed by (package, pathDigest), its ordered lines, each stating a path, its own
 * key generation's read, and its ordered notes, which state none and hold the document's digest copied, each member
 * carrying the document's title, and TreeNode, a tree keyed by (package, pathDigest, start) whose every member states
 * its path; paths as the flat property's, past the entry limit among them. A case stores lawful documents and trees,
 * then writes one stratum: new documents with lines and notes nested, a stored document's title put, a stored document
 * deleted by its fields or by another title, a new tree, and a stored tree deleted by its root's package and path. A
 * member states its owner's path five draws in six.
 *
 * The oracle is the host model over the same digests (generated-pk.fixtures.ts familyAfter): a stratum's deletions
 * first, then its inserts; an insert at a stored or another inserted owner's key that differs from it is refused on
 * that owner's primary key, an exact repeat of a stored document, its groups included, is met and changes nothing, and a
 * member whose path's digest is not its owner's is refused on its family's law; otherwise every document, line, note and node after it is the model's, and after
 * the title put, a stratum of its own, each line and note carries its document's title, each digest the model's.
 */
export const aFamilyOverAKeyGenerationGroupsItsMembersByTheOwnersDigest = property.explore(
	familyCaseGen,
	{
		needs: { fixture: Substrate.fresh(generatedKeysTemplate) },
		situations: [
			"accepted",
			"unchanged",
			"a document inserted with lines and notes",
			"a title put cascades to every line and note",
			"a document deleted with its members",
			"a delete stating another title removes nothing",
			"a tree inserted",
			"a tree deleted by its root's texts",
			"refused: a document at a stored key",
			"refused: a line whose path is not its document's",
			"refused: a tree at a stored key",
			"refused: a tree's member whose path is not its root's",
			"a member path past the entry limit"
		] satisfies ReadonlyArray<Reached<FamilyFeature>>,
		check:
			({ fixture }, cx: Case<FamilyFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(GeneratedKeys, {}, generatedKeysInstall, taken)
								const names = namesOf(o.installed)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const sorted = (
										rows: ReadonlyArray<ReadonlyArray<string>>
									): ReadonlyArray<ReadonlyArray<string>> =>
										Arr.sort(rows, Arr.makeOrder(Order.String))
									const readFamilies = Effect.gen(function* () {
										const docs = yield* rowsOf(db.workload.docs.once({ params: {}, facts: {} }))
										const lines = yield* rowsOf(db.workload.lines.once({ params: {}, facts: {} }))
										const notes = yield* rowsOf(db.workload.notes.once({ params: {}, facts: {} }))
										const treeNodes = yield* rowsOf(
											db.workload.treeNodes.once({ params: {}, facts: {} })
										)
										return {
											docs: sorted(
												Arr.map(docs, (d) => [
													d.package,
													d.path,
													String(d.title),
													d.pathDigest.toHex()
												])
											),
											lines: sorted(
												Arr.map(lines, (l) => [
													l.package,
													l.path,
													String(l.at),
													String(l.word),
													String(l.docTitle),
													l.pathDigest.toHex()
												])
											),
											notes: sorted(
												Arr.map(notes, (n) => [
													n.package,
													n.pathDigest.toHex(),
													String(n.at),
													String(n.word),
													String(n.docTitle)
												])
											),
											treeNodes: sorted(
												Arr.map(treeNodes, (t) => [
													t.package,
													t.path,
													String(t.parent),
													String(t.start),
													String(t.label),
													t.pathDigest.toHex()
												])
											)
										}
									})
									const nested = (d: DocRow) => ({
										package: d.package,
										path: d.path,
										title: d.title,
										lines: d.lines,
										notes: d.notes
									})
									const treeOf = (t: TreeRow) => ({
										package: t.package,
										path: t.root.path,
										label: t.root.label,
										children: t.root.children
									})
									const stored = [...c.stored.docs.values()]
									const storedTrees = [...c.stored.trees.values()]
									const seeded = yield* writeAnswerOf(
										db.workload.seed.once({
											params: {},
											facts: {
												insert: {
													StimulusRef: [],
													FoldedRef: [],
													Doc: Arr.map(stored, nested),
													TreeNode: Arr.map(storedTrees, treeOf)
												}
											}
										})
									)
									assert.equal(
										seeded.kind,
										stored.length + storedTrees.length === 0 ? "unchanged" : "accepted",
										"the stored documents and trees are lawful"
									)
									const before = yield* readFamilies
									assert.deepEqual(
										before,
										familyRowsOf(c.stored),
										"the stored rows are the model's"
									)
									const expected = familyAfter(c.stored, c.writes)
									const outcome = yield* writeAnswerOf(
										db.workload.stratum.once({
											params: {},
											facts: {
												insert: {
													StimulusRef: [],
													FoldedRef: [],
													Doc: Arr.map(c.writes.docInserts, nested),
													TreeNode: Arr.map(c.writes.treeInserts, treeOf)
												},
												put: { StimulusRef: [], FoldedRef: [] },
												delete: {
													StimulusRef: [],
													FoldedRef: [],
													Doc: c.writes.docDelete,
													TreeNode: c.writes.treeDelete
												}
											}
										})
									)
									const after = yield* readFamilies
									if (expected.kind === "refused") {
										if (outcome.kind !== "refused") {
											return assert.fail(
												`a stratum breaking ${Arr.join(expected.breaches, ", ")} is refused, not ${outcome.kind}`
											)
										}
										assert.deepEqual(after, before, "a refused write changes nothing")
										const lawOf: Readonly<Record<FamilyBreach, LawId>> = {
											"doc key": names.primaryKeyLaw(Doc),
											"tree key": names.primaryKeyLaw(TreeNode),
											"line axis": names.lawOf(docLines),
											"line key": names.primaryKeyLaw(Line),
											"node axis": names.lawOf(nodes)
										}
										const named = Arr.map(refusedEntries(outcome.refused), names.reported)
										assert.ok(
											Arr.some(expected.breaches, (b) => Arr.contains(named, lawOf[b])),
											`the refusal names ${Arr.join(named, ", ")}, a law of ${Arr.join(expected.breaches, ", ")}`
										)
										const featureOf: Readonly<Record<FamilyBreach, FamilyFeature>> = {
											"doc key": "refused: a document at a stored key",
											"tree key": "refused: a tree at a stored key",
											"line axis": "refused: a line whose path is not its document's",
											"line key": "refused: a line whose path is not its document's",
											"node axis": "refused: a tree's member whose path is not its root's"
										}
										const [only, ...more] = expected.breaches
										if (more.length === 0) {
											cx.note(featureOf[only])
										}
										return
									}
									assert.equal(
										outcome.kind,
										expected.changed ? "accepted" : "unchanged",
										"accepted where the write changed a row"
									)
									assert.deepEqual(
										after,
										familyRowsOf(expected.state),
										"the rows after the write are the model's"
									)
									cx.note(expected.changed ? "accepted" : "unchanged")
									const put = docPutAfter(expected.state, c.writes.docPut)
									const putOutcome = yield* writeAnswerOf(
										db.workload.docPut.once({
											params: {},
											facts: { put: { Doc: c.writes.docPut } }
										})
									)
									assert.equal(
										putOutcome.kind,
										put.changed ? "accepted" : "unchanged",
										"a title put is accepted where it changed a title"
									)
									const afterPut = yield* readFamilies
									assert.deepEqual(
										afterPut,
										familyRowsOf(put.state),
										"the rows after the title put are the model's, every line and note carrying its document's title"
									)
									if (
										Arr.some(c.writes.docInserts, (d) => d.lines.length > 0 && d.notes.length > 0)
									) {
										cx.note("a document inserted with lines and notes")
									}
									if (
										Arr.some(c.writes.docPut, (p) => {
											const was = c.stored.docs.get(groupKey(p.package, p.path))
											return was !== undefined && was.lines.length > 0 && was.notes.length > 0
										})
									) {
										cx.note("a title put cascades to every line and note")
									}
									for (const d of c.writes.docDelete) {
										const was = c.stored.docs.get(groupKey(d.package, d.path))
										if (was !== undefined) {
											cx.note(
												was.title === d.title
													? "a document deleted with its members"
													: "a delete stating another title removes nothing"
											)
										}
									}
									if (c.writes.treeInserts.length > 0) {
										cx.note("a tree inserted")
									}
									if (
										Arr.some(c.writes.treeDelete, (t) =>
											c.stored.trees.has(groupKey(t.package, t.path))
										)
									) {
										cx.note("a tree deleted by its root's texts")
									}
									if (
										Arr.some([...expected.state.docs.values()], (d) =>
											Arr.some(d.lines, (l) => l.path.length >= pastEntryLimit)
										)
									) {
										cx.note("a member path past the entry limit")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a host model of documents, lines, notes and trees over node:crypto's SHA-256 of the paths: deletions first, then puts and inserts, an owner's key and each member's axis judged"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/fill.ts",
				original:
					'\t\tif (field.writing.kind !== "generated" && field.writing.kind !== "keyGenerated") {',
				replacement: '\t\tif (field.writing.kind !== "generated") {',
				why: "A member's digest copied instead of generated: the walk lays out no key generation, so a line's or a node's group takes its owner's digest whatever path it states, and one whose path is not its owner's is refused by its own CHECK, not its family's axis."
			}
		]
	}
)

/** What a ledger case reaches. */
type SetFeature =
	| "accepted"
	| "unchanged"
	| "refused: two weights at one value"
	| "a value past the entry limit stored"
	| "several values of one child's variable"
	| "a whole child deleted"
	| "a child reweighed in place"
	| "a lookup by key heads finds a long value"
	| "a lookup by key heads finds nothing"

/**
 * A set-like ledger relation keyed by its values' digests holds several values of a child's variable, any length, and
 * each write names its rows by their texts: inserts, puts and deletes, a whole child's delete, a described put of the
 * relation's own facts that reweighs a child's rows in place, and a lookup through the key by its heads (child,
 * variable, value), which compares the stored digest with the value's.
 *
 * The box: SetString (child, variable, value, weight), keyed by (child, variable, sha256(value)), edullm's ledger
 * shape with a weight beside the value; values two short texts and two past the entry limit that differ in their last
 * byte; children 1 and 2, variables v and w. A case stores a lawful state, then takes one to three steps, a stratum of
 * up to two inserts, puts and deletes near the stored rows, a whole child's delete, or a child's reweigh to a drawn
 * weight, and after each step looks up one to three drawn key heads.
 *
 * The oracle is the host model keyed by the platform's SHA-256 of the values: a stratum as the flat property's, a
 * child's delete removing its rows, a reweigh setting each of its rows' weights; each lookup finds exactly the model's
 * row at its heads.
 */
export const aSetLikeRelationKeyedByItsValuesDigestsHoldsAndFindsValuesOfAnyLength =
	property.explore(setCaseGen, {
		needs: { fixture: Substrate.fresh(generatedKeysTemplate) },
		situations: [
			"accepted",
			"unchanged",
			"refused: two weights at one value",
			"a value past the entry limit stored",
			"several values of one child's variable",
			"a whole child deleted",
			"a child reweighed in place",
			"a lookup by key heads finds a long value",
			"a lookup by key heads finds nothing"
		] satisfies ReadonlyArray<Reached<SetFeature>>,
		check:
			({ fixture }, cx: Case<SetFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(GeneratedKeys, {}, generatedKeysInstall, taken)
								const names = namesOf(o.installed)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const readSet = Effect.map(
										rowsOf(db.workload.setStrings.once({ params: {}, facts: {} })),
										(rows): ReadonlyArray<ReadonlyArray<string>> =>
											Arr.sort(
												Arr.map(rows, (r) => [
													String(r.child),
													r.variable,
													r.value,
													String(r.weight),
													r.valueDigest.toHex()
												]),
												Arr.makeOrder(Order.String)
											)
									)
									const stored = [...c.stored.values()]
									const seeded = yield* writeAnswerOf(
										db.workload.setSeed.once({
											params: {},
											facts: { insert: { SetString: stored } }
										})
									)
									assert.equal(
										seeded.kind,
										stored.length === 0 ? "unchanged" : "accepted",
										"the stored rows are lawful"
									)
									let state: SetState = c.stored
									for (const step of c.steps) {
										const before = yield* readSet
										assert.deepEqual(
											before,
											setRowsOf(state),
											"the rows before the step are the model's"
										)
										const expected = setAfter(state, step)
										const outcome = yield* writeAnswerOf(
											step.kind === "stratum"
												? db.workload.setStratum.once({
														params: {},
														facts: {
															insert: { SetString: step.writes.insert },
															put: { SetString: step.writes.put },
															delete: { SetString: step.writes.delete }
														}
													})
												: step.kind === "childDelete"
													? db.workload.childDelete.once({
															params: { child: step.child },
															facts: {}
														})
													: db.workload.childReweigh.once({
															params: { child: step.child, weight: step.weight },
															facts: {}
														})
										)
										const after = yield* readSet
										if (expected.kind === "refused") {
											if (outcome.kind !== "refused") {
												return assert.fail(
													`${Formatter.format(step)} puts two weights at one value: refused, not ${outcome.kind}`
												)
											}
											assert.deepEqual(after, before, "a refused write changes nothing")
											const named = Arr.map(refusedEntries(outcome.refused), names.reported)
											assert.ok(
												Arr.contains(named, names.primaryKeyLaw(SetString)),
												`the refusal names ${Arr.join(named, ", ")}, SetString's primary key`
											)
											cx.note("refused: two weights at one value")
											return
										}
										assert.equal(
											outcome.kind,
											expected.changed ? "accepted" : "unchanged",
											"accepted where the step changed a row"
										)
										assert.deepEqual(
											after,
											setRowsOf(expected.state),
											"the rows after the step are the model's"
										)
										cx.note(expected.changed ? "accepted" : "unchanged")
										if (expected.changed && step.kind === "childDelete") {
											cx.note("a whole child deleted")
										}
										if (expected.changed && step.kind === "childReweigh") {
											cx.note("a child reweighed in place")
										}
										state = expected.state
										for (const head of c.lookups) {
											const found = yield* rowsOf(
												db.workload.setByKey.once({
													params: { child: head.child, variable: head.variable, value: head.value },
													facts: {}
												})
											)
											const model = state.get(setKey(head))
											assert.deepEqual(
												Arr.map(found, (r) => [
													String(r.child),
													r.variable,
													r.value,
													String(r.weight)
												]),
												model === undefined
													? []
													: [
															[
																String(model.child),
																model.variable,
																model.value,
																String(model.weight)
															]
														],
												`the lookup at ${Formatter.format(head)} finds the model's row`
											)
											if (model === undefined) {
												cx.note("a lookup by key heads finds nothing")
											} else if (model.value.length >= pastEntryLimit) {
												cx.note("a lookup by key heads finds a long value")
											}
										}
									}
									const rows = [...state.values()]
									if (Arr.some(rows, (r) => r.value.length >= pastEntryLimit)) {
										cx.note("a value past the entry limit stored")
									}
									if (
										Arr.some(rows, (r) =>
											Arr.some(
												rows,
												(x) => x !== r && x.child === r.child && x.variable === r.variable
											)
										)
									) {
										cx.note("several values of one child's variable")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a host model of the ledger keyed by the platform's SHA-256 of each value: strata as the flat model's, a child's delete and reweigh over its rows, each lookup the model's row at its heads"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/normalize.ts",
				original: "\tif (fill.generations.length === 0) {\n\t\treturn Result.ok(stated)\n\t}",
				replacement: "\tif (fill.generations.length >= 0) {\n\t\treturn Result.ok(stated)\n\t}",
				why: "A ledger row's value digest never filled on the host: an insert or a put sends no valueDigest, so no value of any length is stored by its texts."
			}
		]
	})
