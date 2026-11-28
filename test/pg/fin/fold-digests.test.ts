/**
 * Concat folds whose sides name their running texts' SHA-256 digests, on PostgreSQL 19 (ir/family.ts FoldCarrier): an
 * ordered family of a document's lines and a tree of nodes stepped by a selection, every piece and running text a text
 * of no bound, so running texts and ends of thousands of bytes, past PostgreSQL's 2,704-byte B-tree entry, ride the
 * axes by their digests.
 *
 * - **A second implementation:** the README's concat fold, each before the concatenation of the pieces before its slot
 *   (of its parent's stepped children, on the tree), each after its before and its piece where the fold steps it, each
 *   end its last member's after or the empty text; and each digest node:crypto's SHA-256 of its text, a second
 *   implementation of grizzle's and PostgreSQL's. What grizzle's own write of the documents and trees leaves must be
 *   exactly that, read back through grizzle's reads.
 * - **PostgreSQL as the judge of the chain:** a direct SQL writer, the installation's owner, copies one stored document
 *   and its lines under a fresh id, in a transaction checked as its commit would check it and rolled back, with one
 *   junk text or none: the copy itself commits; a member's before and after both off its predecessor's after, its own
 *   CHECK holding, is refused by an axis's foreign key over the digests, 23503; a first member's before off the empty
 *   text, and an empty owner's end, by the fold's pin, 23514; an owner's end off its last member's after by an axis's
 *   foreign key. Each refusal's constraint serves the fold's law, beside its family's where an axis carries both, and
 *   is read from PostgreSQL's catalog: the axis's foreign key over the digests, or the pin's CHECK.
 *
 * The space, generated: one to three documents of zero to four pieces and zero to two trees of at most three levels,
 * each piece empty, a few letters of one to four UTF-8 bytes, or a run of a thousand to three thousand code points of
 * one of them; each tree node stepped or not; and the document the writer copies with its junk.
 *
 * Features: a running text, an end and a node's string value past the B-tree entry; an unstepped node; an empty
 * family; each junk.
 */
import { assert, deepEquals } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	copyId,
	Digests,
	digestsInstall,
	digestsTemplate,
	docFact,
	docId,
	docDigested,
	docRows,
	type Feature,
	type Junk,
	lineDigested,
	nodeDigested,
	pastEntry,
	rowSet,
	sketchGen,
	treeFact,
	treeId,
	treeRows
} from "#test/pg/fin/fold-digests.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { attemptChecked, refusalText } from "#test/support/substrate.ts"
import { reportedOwnerOf } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The SQLSTATE a junk is refused with, and the kind of constraint that refuses it; none for a lawful copy. */
const dueOf = (
	junk: Junk
): Option.Option<{ readonly code: string; readonly kind: "foreign" | "check" }> => {
	switch (junk.kind) {
		case "none":
			return Option.none()
		case "a member's running texts off its predecessor's":
		case "an owner's end off its last member's after":
			return Option.some({ code: "23503", kind: "foreign" })
		case "a first member's before off the empty text":
		case "an empty owner's end off the empty text":
			return Option.some({ code: "23514", kind: "check" })
	}
}

/**
 * Concat folds whose sides name their running texts' digests store exactly the README's fold of every piece, with its
 * digests, for running texts past the B-tree entry, and PostgreSQL refuses every junk running text by the fold's axes or
 * pins.
 */
export const concatFoldsCarriedByTheirDigestsStoreTheREADMEsFoldOfTextsPastTheBTreeEntryAndPostgreSQLRefusesEveryJunkRunningTextByTheFoldsAxesOrPins =
	property.explore(sketchGen, {
		needs: { digests: Substrate.fresh(digestsTemplate) },
		situations: [
			"a running text past the B-tree entry",
			"an owner's end past the B-tree entry",
			"a tree node's string value past the B-tree entry",
			"an unstepped node",
			"an empty family",
			"none",
			"a member's running texts off its predecessor's",
			"a first member's before off the empty text",
			"an owner's end off its last member's after",
			"an empty owner's end off the empty text"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ digests }, cx: Case<Feature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* digests
						const opened = yield* openedIn(Digests, {}, digestsInstall, taken)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(opened.served.login.roles.app, {})
							const docs = yield* writeAnswerOf(
								db.workload.insertDocs.once({
									params: {},
									facts: { insert: { Doc: Arr.map(sketch.docs, docFact) } }
								})
							)
							assert.ok(
								docs._tag === "accepted",
								`the documents are accepted, not ${Formatter.format(docs)}`
							)
							if (Arr.isReadonlyArrayNonEmpty(sketch.trees)) {
								const trees = yield* writeAnswerOf(
									db.workload.insertNodes.once({
										params: {},
										facts: { insert: { Node: Arr.map(sketch.trees, treeFact) } }
									})
								)
								assert.ok(
									trees._tag === "accepted",
									`the trees are accepted, not ${Formatter.format(trees)}`
								)
							}
							const modelDocs = Arr.map(sketch.docs, (pieces, i) => docRows(pieces, docId(i)))
							const modelLines = Arr.flatMap(modelDocs, (d) => d.lines)
							const modelNodes = Arr.flatMap(sketch.trees, (root, i) => treeRows(root, treeId(i)))
							const digests = yield* Layer.build(Digest.layerWebCrypto)
							const digested = yield* Effect.all({
								docs: Effect.forEach(modelDocs, (d) => docDigested(d.doc)),
								lines: Effect.forEach(modelLines, lineDigested),
								nodes: Effect.forEach(modelNodes, nodeDigested)
							}).pipe(Effect.provideContext(digests))
							const readDocs = yield* rowsOf(db.workload.docs.once({ params: {}, facts: {} }))
							const readLines = yield* rowsOf(db.workload.lines.once({ params: {}, facts: {} }))
							const readNodes = yield* rowsOf(db.workload.nodes.once({ params: {}, facts: {} }))
							const storedDocs = Arr.map(readDocs, (d) => ({
								id: d.id,
								n: String(d.n),
								text: d.text,
								textDigest: Hex.encode(d.textDigest)
							}))
							const storedLines = Arr.map(readLines, (l) => ({
								doc: l.doc,
								at: String(l.at),
								piece: l.piece,
								before: l.before,
								after: l.after,
								beforeDigest: Hex.encode(l.beforeDigest),
								afterDigest: Hex.encode(l.afterDigest)
							}))
							const storedNodes = Arr.map(readNodes, (n) => ({
								doc: n.doc,
								start: String(n.start),
								piece: n.piece,
								stepped: String(n.stepped),
								before: n.before,
								after: n.after,
								beforeDigest: Hex.encode(n.beforeDigest),
								afterDigest: Hex.encode(n.afterDigest),
								text: n.text,
								textDigest: Hex.encode(n.textDigest)
							}))
							assert.ok(
								deepEquals(rowSet(storedDocs), rowSet(digested.docs)),
								`every document's end and its digest are the fold's: ${Formatter.format(storedDocs)}`
							)
							assert.ok(
								deepEquals(rowSet(storedLines), rowSet(digested.lines)),
								"every line's running texts and their digests are the fold's"
							)
							assert.ok(
								deepEquals(rowSet(storedNodes), rowSet(digested.nodes)),
								"every node's running texts, string value and their digests are the fold's"
							)
							if (Arr.some(modelLines, (l) => pastEntry(l.after))) {
								cx.note("a running text past the B-tree entry")
							}
							if (Arr.some(modelDocs, (d) => pastEntry(d.doc.text))) {
								cx.note("an owner's end past the B-tree entry")
							}
							if (Arr.some(modelNodes, (n) => pastEntry(n.text))) {
								cx.note("a tree node's string value past the B-tree entry")
							}
							if (Arr.some(modelNodes, (n) => n.stepped === "false")) {
								cx.note("an unstepped node")
							}
							if (Arr.some(sketch.docs, Arr.isReadonlyArrayEmpty)) {
								cx.note("an empty family")
							}
							const { doc, junk } = sketch.copied
							cx.note(junk.kind)
							const names = opened.installed.names
							const session = yield* taken.substrate.session({
								...ownerSession(),
								label: "fold digests"
							})
							const table = (relation: string): string => printObjectName(names.relation(relation))
							const col = (relation: string, field: string): string =>
								quoteIdent(names.column(relation, field))
							/** Every column of a table a writer writes, by PostgreSQL's catalog: all but the generated ones. */
							const written = (relation: string) =>
								Effect.map(
									session.values(
										"SELECT a.attname::text FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum",
										[table(relation)]
									),
									Arr.map((row) => quoteIdent(String(Arr.getUnsafe(row, 0))))
								)
							const docColumns = yield* written("Doc")
							const lineColumns = yield* written("Line")
							const junkEnd =
								junk.kind === "an owner's end off its last member's after" ||
								junk.kind === "an empty owner's end off the empty text"
							const docValue = (c: string): string =>
								c === col("Doc", "id")
									? `'${copyId}'::uuid`
									: c === col("Doc", "text") && junkEnd
										? `${c} || 'z'`
										: c
							const junkSlot = ((): number | undefined => {
								switch (junk.kind) {
									case "a member's running texts off its predecessor's":
										return junk.slot
									case "a first member's before off the empty text":
										return 0
									case "none":
									case "an owner's end off its last member's after":
									case "an empty owner's end off the empty text":
										return undefined
								}
							})()
							const junked = (value: string, junkValue: string): string =>
								junkSlot === undefined
									? value
									: `CASE WHEN ${col("Line", "at")} = ${junkSlot} THEN ${junkValue} ELSE ${value} END`
							const lineValue = (c: string): string => {
								if (c === col("Line", "doc")) {
									return `'${copyId}'::uuid`
								}
								if (c === col("Line", "before")) {
									return junked(c, `${c} || 'z'`)
								}
								if (c === col("Line", "after")) {
									return junked(c, `${col("Line", "before")} || 'z' || ${col("Line", "piece")}`)
								}
								return c
							}
							const copied = yield* attemptChecked(
								session,
								[
									`INSERT INTO ${table("Doc")} (${Arr.join(docColumns, ", ")}) SELECT ${Arr.join(Arr.map(docColumns, docValue), ", ")} FROM ${table("Doc")} WHERE ${col("Doc", "id")} = '${docId(doc)}'::uuid`,
									`INSERT INTO ${table("Line")} (${Arr.join(lineColumns, ", ")}) SELECT ${Arr.join(Arr.map(lineColumns, lineValue), ", ")} FROM ${table("Line")} WHERE ${col("Line", "doc")} = '${docId(doc)}'::uuid`
								],
								Effect.void
							)
							const due = dueOf(junk)
							if (Option.isNone(due)) {
								assert.equal(
									copied.kind,
									"committed",
									`a lawful copy of a stored document commits, not ${copied.kind === "refused" ? refusalText(copied.fields) : copied.kind}`
								)
								return
							}
							if (copied.kind !== "refused") {
								return assert.fail(`${junk.kind} is refused`)
							}
							assert.equal(
								copied.fields.code,
								due.value.code,
								`${junk.kind} is refused with ${due.value.code}, not ${refusalText(copied.fields)}`
							)
							const owner = reportedOwnerOf(copied.fields)
							const constraint = copied.fields.constraint
							const laws =
								owner === undefined || constraint === undefined
									? undefined
									: lawsOfConstraint(
											opened.installed.installation.constraintToLaw,
											owner,
											constraint
										)
							const foldLaws = Arr.flatMap(opened.installed.installation.laws.theory.laws, (l) =>
								l.detail.kind === "fold" ? [l.id] : []
							)
							assert.ok(
								laws !== undefined && Arr.some(laws, (l) => Arr.contains(foldLaws, l)),
								`${junk.kind} is refused by a constraint serving a fold's law, not ${refusalText(copied.fields)}`
							)
							const kinds = yield* session.values(
								"SELECT c.contype::text, coalesce((SELECT string_agg(a.attname::text, ',') FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)), '') FROM pg_catalog.pg_constraint c WHERE c.conname = $1",
								[constraint]
							)
							const [kind, columns] = Arr.getUnsafe(kinds, 0)
							assert.equal(
								kind,
								due.value.kind === "foreign" ? "f" : "c",
								`${junk.kind} is refused by a ${due.value.kind} constraint`
							)
							if (due.value.kind === "foreign") {
								const digests = [
									names.column("Line", "beforeDigest"),
									names.column("Doc", "textDigest")
								]
								assert.ok(
									Arr.some(Str.split(String(columns), ","), (c) =>
										Arr.contains<string>(digests, c)
									),
									`${junk.kind} is refused by an axis over the digests, not one over ${String(columns)}`
								)
							}
						}).pipe(withLayer(opened.served.layer))
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the README's concat fold of each sequence with node:crypto's SHA-256 of each text, and PostgreSQL's verdict on each direct copy"
		},
		budget: { runs: 8, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original: "\t\t\tbefore: before.digest,\n\t\t\tafter: after.digest,",
				replacement: "\t\t\tbefore: after.digest,\n\t\t\tafter: before.digest,",
				why: "The predecessor axis pairs each member's after's digest with its predecessor's before's: a lawful write of a family of two members is refused by the axis; the property fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t\tif (axis === "last" && sameNativeColumn(p.from, fieldColumn(plane.end))) {\n\t\t\t\t\treturn { from: fieldColumn(c.end), to: fieldColumn(c.after) }\n\t\t\t\t}',
				replacement: "",
				why: "The last axis pairs the owner's end text with its last member's after text: the schema's unbounded end is refused for its axis key and no case installs; the property fails."
			}
		]
	})
