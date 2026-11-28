/**
 * Adding a counted family with a fold to populated relations, on PostgreSQL 19 (rows-first §6): A4's backfill data
 * step draws every member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of the
 * count, and each fold plane's before and after as running sums in ‹i› order, and the owner's count and end; VALIDATE
 * then proves every native over the backfilled rows.
 *
 * - **A second implementation:** the reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order states every backfilled value of a family, each owner's tag is what its members' copy holds, and for a tree
 *   the direct pre-order numbering of each tree under its root value (test/support/families/tree.ts) states every
 *   node's slot, count, interval, fold and parent's kind; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** the migration commits, and no constraint of the installation is left NOT VALID.
 *
 * The spaces, generated: one to three owners whose members fall among them in any counts, so a backfill meets empty
 * families, families of one (the first slot the last) and families whose predecessor chain the running sum must close;
 * member keys drawn apart and written out of their order, and each member's value; and the same family with each
 * owner's tag copied onto its members along the owner axis, or without. And one or two trees of one to five nodes,
 * keyed by their root value (doc, page) and start, each under its own root value, two of which may share a doc or a
 * page, stored lawful by a direct writer, then folded by count over each node's children, and each node's parent's
 * kind copied down the parent axis, the root its own, both added by the migration. And members stored by a vector key
 * that the migration which keys them by their group and a new drawn index keeps as a field, renames or drops, declared:
 * its backfill orders and joins the stored members by that key at the extension's operators, the dropped one's column
 * standing until the migration's removals.
 *
 * Features: an empty family, a family of one and of several, members written out of their key order, tags copied or
 * not; two trees, a root alone, a node of several children, a grandchild; and each fate of a vector key. Each pending situation is aimed at by a case constructed to reach it (a leading owner of a
 * drawn size, keys written from the highest down, a fixed tree shape, a fixed fate), never by filtering draws.
 *
 * A stored index is data: an ordered family whose owner is re-keyed keeps each member's stored index (README "A stored
 * index is data"). A case stores one or two ordered families over one owner, keyed by an int4 id, each family's
 * members in a drawn stored order (keys drawn apart, so mostly out of the stored order), the first folded by sum of x
 * into named accumulators, the second folded or not; then migrates to an owner keyed by one to three fields of drawn
 * types (text, int8, uuid), each member's group re-pointed to them, the old id and group dropped, as declared. The
 * reviewer's data step, written before each placeholder's DROP DEFAULT as its line asks, gives each owner its new key and
 * each member its group by a weighted fate the case's swarm draws per family: each member stays with its owner;
 * members move between owners (a regroup, one member moved by construction); or members move and the migration
 * declares the family's index dropped (`--drop M.at`), drawing it anew.
 *
 * - **A second implementation:** the reference fold of each owner's members after the data step, in their stored
 *   order, or in their member key's where the index is declared dropped, states each member's index, before and
 *   after, and each owner's count and end; what the migration leaves must be exactly that.
 * - **PostgreSQL as the judge:** a regroup that leaves some owner's kept indices other than 0 … n − 1 is refused in
 *   the re-key's folder, naming the law of that family or of its fold (migrate's StatementFailed or FileCommitRefused
 *   `law`, the laws the compiled target names); any other case commits, no constraint left NOT VALID.
 *
 * Features: two ordered families on one owner, a fold over a kept order out of member-key order, a regroup refused
 * and a regroup redrawn as declared, each aimed at by a re-key constructed to reach it.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	after,
	before,
	copyAfter,
	copyBefore,
	declaredMigratedOver,
	type Family,
	familyAims,
	type FamilyFeature,
	familyFeatures,
	familyGen,
	type StoredForest,
	forestFeatures,
	forestGen,
	foldExpectedOf,
	foldRowsOf,
	migratedOver,
	type MonoidSeat,
	monoidSeats,
	ownersOf,
	type Rekey,
	rekeyAims,
	rekeyed,
	type RekeyFeature,
	rekeyFeatures,
	rekeyGen,
	rowsOf,
	seatAims,
	type SeatFamily,
	seatFamilyGen,
	seatSpec,
	SPEC,
	treeAfter,
	treeAims,
	treeBefore,
	type TreeFeature,
	vectorFates,
	vectorKeyAims,
	vectorKeyed,
	type VectorKeyedFamily,
	vectorKeyedGen,
	type VectorKeyFeature,
	vectorKeyFeatures,
	type WrittenMember
} from "#test/pg/migrate/backfill.fixtures.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { numbered } from "#test/support/families/tree.ts"
import { byMember, foldRead, foldSeatOf } from "#test/support/pg/fin/folds.ts"
import { seatOfInstalled } from "#test/support/pg/fin/installed.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** Backfilling a counted family with a fold on PostgreSQL 19 draw every hidden index, copy, accumulator, count and end of populated families in key order, each owner's tag along the owner axis, and VALIDATE every native. */
export const populatedFamilies = property.explore(aimed(familyGen, familyAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"an empty family",
		"a family of one",
		"a family of several",
		"members written out of their key order",
		"tags copied",
		"a fold without a copy"
	] satisfies ReadonlyArray<Reached<FamilyFeature>>,
	/** Its pre-conversion budget: runs 3, coverage cases 12 (backfill.test.ts at bf4f43bb). */
	budget: { runs: 3, steered: 12 },
	check:
		({ substrate }, c: Case<FamilyFeature>) =>
		(family: Family) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					c.noteAll(familyFeatures(family))
					const families = ownersOf(family)
					const m = yield* migratedOver(
						"backfill",
						family.copied ? copyBefore : before,
						family.copied ? copyAfter : after,
						[
							{
								relation: "Owner",
								rows: Arr.map(families, (f) =>
									family.copied ? { id: f.owner, tag: f.tag } : { id: f.owner }
								)
							},
							{
								relation: "Member",
								rows: Arr.map(family.members, (mb) => ({ member: mb.member, g: mb.g, x: mb.x }))
							}
						]
					)
					const seat = yield* seatOfInstalled(m, ["Owner", "Member"], "backfill")
					const f = foldSeatOf(
						{ ...SPEC, schema: (family.copied ? copyAfter : after)(m.declared) },
						seat
					)
					const read = yield* foldRead(f)
					const expected = foldStoredOf(
						SPEC.monoid,
						Arr.map(families, (o) => ({
							owner: o.owner,
							members: Arr.map(
								Arr.sort(
									o.members,
									Order.mapInput(Order.Number, (mb: WrittenMember) => mb.member)
								),
								(mb) => ({ member: mb.member, x: BigInt(mb.x), selected: true })
							)
						}))
					)
					assert.deepEqual(
						read,
						byMember(expected),
						"the backfill draws the reference fold of each family in key order"
					)
					if (!family.copied) {
						return
					}
					const tagged = yield* rowsOf(m.declared, "Member", ["member", "ownerTag"])
					assert.deepEqual(
						tagged,
						Arr.sort(
							Arr.map(
								family.members,
								(mb) => `${mb.member} ${defined(family.tags[mb.g], "its owner's tag")}`
							),
							Order.String
						),
						"each member holds its owner's tag"
					)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the reference fold of each owner's members in key order, and each owner's tag on its members"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: '\t\t\t\t\t\tlit.int(1n, types.bigint)\n\t\t\t\t\t)\n\t\t\t\t: col("m", index),',
			replacement: '\t\t\t\t\t\tlit.int(0n, types.bigint)\n\t\t\t\t\t)\n\t\t\t\t: col("m", index),',
			why: "A family's backfilled index counts from 1; the counted family's values disagree with the reference fold."
		}
	]
})

/** Backfilling a fold of every operation on PostgreSQL 19 draws each member's before and after and each owner's count and end of populated families as the reference fold does in key order: a count over a selection, max over int4 and over a closed id, or over an ordered and a counted family and twos, every one the served scan run from slot 0. */
export const everyMonoid = property.explore(aimed(seatFamilyGen, seatAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: Arr.map(monoidSeats, (seat) => seat.label),
	budget: { runs: 12, steered: 24 },
	check:
		({ substrate }, c: Case<MonoidSeat["label"]>) =>
		({ seat, family }: SeatFamily) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					c.note(seat.label)
					const spec = seatSpec(seat)
					const m = yield* migratedOver(
						"monoids",
						seat.before,
						seat.after,
						foldRowsOf(spec, family)
					)
					const installed = yield* seatOfInstalled(m, ["Owner", "Member"], "backfill")
					const read = yield* foldRead(
						foldSeatOf({ ...spec, schema: seat.after(m.declared) }, installed)
					)
					assert.deepEqual(
						read,
						byMember(foldExpectedOf(spec, family)),
						`the backfill draws the reference ${seat.label} of each family in key order`
					)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the reference fold of each owner's members in key order (test/support/families/fold.ts), exact"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/ir/monoid.ts",
			original: '\t\taggregate: "sum",',
			replacement: '\t\taggregate: "max",',
			why: "Add accumulates by max (ir/monoid.ts accumulations): a count over two selected members draws one, not two."
		},
		{
			file: "packages/engine/src/ir/monoid.ts",
			original: '\t\taggregate: "bit_or",',
			replacement: '\t\taggregate: "bit_and",',
			why: "A union accumulates by bit_and (ir/monoid.ts accumulations): or and twos draw the codes every member sets, not some."
		},
		{
			file: "packages/engine/src/ir/monoid.ts",
			original: '\t\taggregate: "max",',
			replacement: '\t\taggregate: "min",',
			why: "The greater accumulates by min (ir/monoid.ts accumulations): max draws the least step."
		},
		{
			file: "packages/engine/src/ir/monoid.ts",
			original: '\t\t{ fn: "union", delta: "met" }',
			replacement: '\t\t{ fn: "union", delta: "step" }',
			why: "twos' second plane takes the union of the member's set, not its meet with the ones before it (ir/monoid.ts): its twos plane draws every code set once."
		}
	]
})

/** Backfilling a counted family with a fold on PostgreSQL 19 draw a count fold over each node's siblings, the root its one admitted state, and each parent copy, the root its own, over a stored keyed forest, each tree's rows by its own root value. */
export const keyedForest = property.explore(aimed(forestGen, treeAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"two trees",
		"a root alone",
		"a node of several children",
		"a grandchild"
	] satisfies ReadonlyArray<Reached<TreeFeature>>,
	/** Its pre-conversion budget: runs 3, coverage cases 12 (backfill.test.ts at bf4f43bb). */
	budget: { runs: 3, steered: 12 },
	check:
		({ substrate }, c: Case<TreeFeature>) =>
		(forest: StoredForest) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					c.noteAll(forestFeatures(forest))
					const rows = numbered(forest.trees)
					const m = yield* migratedOver("backfilltree", treeBefore, treeAfter, [
						{
							relation: "Node",
							rows: Arr.map(rows, (r) => {
								const [doc, page] = r.root
								return {
									doc: Number(doc),
									page: `'${page}'`,
									parent: r.parent,
									at: r.at,
									children: r.children,
									start: r.start,
									end: r.end,
									kind: r.kind,
									"‹s›": r.next
								}
							})
						}
					])
					const migratedRows = yield* rowsOf(m.declared, "Node", [
						"doc",
						"page",
						"start",
						"parent",
						"at",
						"children",
						"end",
						"before",
						"after",
						"total",
						"parentKind"
					])
					assert.deepEqual(
						migratedRows,
						Arr.sort(
							Arr.map(rows, (r) =>
								Arr.join(
									Arr.map(
										[
											...r.root,
											r.start,
											r.parent,
											r.at,
											r.children,
											r.end,
											r.at,
											r.at + 1,
											r.children,
											r.parentKind
										],
										String
									),
									" "
								)
							),
							Order.String
						),
						"each tree's stored numbering kept, NP's lawful count fold, each parent's kind in its own tree"
					)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the direct pre-order numbering of each tree under its root value, NP's lawful count fold, and each parent's kind"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original:
				'\t\t\t\t\ttargetKey: groupAt(family, "member", "t"),\n\t\t\t\t\ttargetWhere: conjunction(nonRoot(names, family, "t")),\n\t\t\t\t\tsourceKey: groupAt(family, "owner", "s"),',
			replacement:
				'\t\t\t\t\ttargetKey:\n\t\t\t\t\t\tfamily.members.kind === "tree"\n\t\t\t\t\t\t\t? groupAt(family, "member", "t").slice(-1)\n\t\t\t\t\t\t\t: groupAt(family, "member", "t"),\n\t\t\t\t\ttargetWhere: conjunction(nonRoot(names, family, "t")),\n\t\t\t\t\tsourceKey:\n\t\t\t\t\t\tfamily.members.kind === "tree"\n\t\t\t\t\t\t\t? groupAt(family, "owner", "s").slice(-1)\n\t\t\t\t\t\t\t: groupAt(family, "owner", "s"),',
			why: "A copy along a tree's parent is drawn from the node at the parent's start under any root value; two trees sharing a start disagree with the pre-order reference."
		},
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: '\t\t\t\tgroup: mapNonEmpty(parent, (p) => col("r", p)),',
			replacement:
				'\t\t\t\tgroup: mapNonEmpty(parent, () => col("r", parent[parent.length - 1] ?? parent[0])),',
			why: "A fold over a tree's siblings is partitioned by their parent's start alone; two trees sharing a start disagree with the pre-order reference."
		}
	]
})

/** Backfilling a counted family with a fold on PostgreSQL 19 order and join members stored by a vector key the migration keeps, renames or drops at the extension's operators, and draw every index, count and end in that key's order. */
export const vectorKey = property.explore(aimed(vectorKeyedGen, vectorKeyAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"the key kept",
		"the key renamed",
		"the key dropped",
		"a family of several",
		"members written out of their key order"
	] satisfies ReadonlyArray<Reached<VectorKeyFeature>>,
	/** Its pre-conversion budget: runs 3, coverage cases 12 (backfill.test.ts at bf4f43bb). */
	budget: { runs: 3, steered: 12 },
	check:
		({ substrate }, c: Case<VectorKeyFeature>) =>
		(f: VectorKeyedFamily) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					c.noteAll(vectorKeyFeatures(f))
					const fate = vectorFates[f.fate]
					const owners = upTo(f.owners, (owner) => owner)
					const m = yield* declaredMigratedOver(
						"backfillvector",
						vectorKeyed,
						fate.after,
						fate.declared,
						[
							{ relation: "Owner", rows: Arr.map(owners, (id) => ({ id })) },
							{
								relation: "Member",
								rows: Arr.map(f.members, (mb) => ({
									member: `'[${mb.member},0]'`,
									g: mb.g,
									x: mb.x
								}))
							}
						]
					)
					const ownedInKeyOrder = (owner: number) =>
						Arr.sort(
							Arr.filter(f.members, (mb) => mb.g === owner),
							Order.mapInput(Order.Number, (mb: WrittenMember) => mb.member)
						)
					const members = yield* rowsOf(m.declared, "Member", ["g", "at", "x"])
					const owning = yield* rowsOf(m.declared, "Owner", ["id", "n", "end"])
					assert.deepEqual(
						members,
						Arr.sort(
							Arr.flatMap(owners, (owner) =>
								Arr.map(ownedInKeyOrder(owner), (mb, at) => `${owner} ${at} ${mb.x}`)
							),
							Order.String
						),
						"each member's index is its place in its owner's vector key order"
					)
					assert.deepEqual(
						owning,
						Arr.sort(
							Arr.map(owners, (owner) => {
								const mine = ownedInKeyOrder(owner)
								return `${owner} ${mine.length} ${Arr.reduce(mine, 0, (sum, mb) => sum + mb.x)}`
							}),
							Order.String
						),
						"each owner counts its members and sums their x"
					)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "each owner's members in the order of their vector key [k, 0], k's, numbered from 0 and summed"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: "\tif (!own.some((c) => added.has(c))) {",
			replacement: "\tif (own.length > 0) {",
			why: "Members keyed anew are ordered by their new key, not the one their rows were distinct by; a vector key's fate disagrees with the reference."
		}
	]
})

/** Backfilling a counted family with a fold on PostgreSQL 19 keep each ordered member's stored index across a re-key of its owner, run its fold in that kept order, refuse a data step that leaves an owner's kept indices other than 0 … n − 1, and draw anew an index the migration declares dropped. */
export const rekeyedOrder = property.explore(aimed(rekeyGen, rekeyAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"two ordered families on one owner",
		"a fold over a kept order out of member-key order",
		"a regroup refused",
		"a regroup redrawn as declared"
	] satisfies ReadonlyArray<Reached<RekeyFeature>>,
	/** Its pre-conversion budget: runs 3, coverage cases 12 (backfill.test.ts at bf4f43bb). */
	budget: { runs: 3, steered: 12 },
	check:
		({ substrate }, c: Case<RekeyFeature>) =>
		(r: Rekey) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					c.noteAll(rekeyFeatures(r))
					yield* rekeyed(r)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the reference fold of each owner's members after the data step, in their stored order or, declared dropped, their member key's; and the family's or its fold's law refusing exactly where an owner's kept indices are not 0 … n − 1"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original:
				"\t\t\t\t\treturn (restated !== undefined && canonicalEquals(restated, f.writing)) ||\n\t\t\t\t\t\tsameSequence(previous, installation, now.name, field.name, f.writing)",
			replacement:
				"\t\t\t\t\treturn restated !== undefined && canonicalEquals(restated, f.writing)",
			why: "A re-pointed family's index is drawn again in member-key order, sameSequence no longer keeping it, so the kept order is lost."
		},
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: '\t\t\t\t: col("m", index),',
			replacement:
				'\t\t\t\t: binary("-", over("row_number", [], window(partition, key.map((k) => col("m", k)), false)), lit.int(1n, types.bigint)),',
			why: "The folds over a kept index run in member-key order."
		},
		{
			file: "test/support/install-migrate.ts",
			original: "\t\t\t\ttimestamp: draftedAt(at.step),\n",
			replacement: "\t\t\t\ttimestamp: draftedAt(at.step + 1),\n",
			why: "The history drafts each version a second late on the tests' clock: the refusal is in the re-key's folder, drafted at ordinal 2, which the property no longer finds at ordinal 1."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original: "\t\t\t\t\t\tfieldTaken(d.relation, f) ||\n\t\t\t\t\t\tdrawnAnew(d.relation, f))",
			replacement: "\t\t\t\t\t\tfieldTaken(d.relation, f))",
			why: "`--drop M.at` beside a declared M.at is refused."
		}
	]
})
