/**
 * The migrator under the deltas of the identity cutover, on PostgreSQL 19, run as a commands program over schema
 * versions of a populated installation, against a pure model of the world and its facts.
 *
 * The world is a few relations, each with a payload `x`, keyed by a uuid `id` or by a compound key of two texts and a
 * bigint (`ka`, `kb`, `kc`), each referencing relations before it: by a plain containment, or as the member of an
 * ordered family (with its drawn `at`) or a counted one, its owner's drawn count `n<m>` and, with a sum fold of `x`, its
 * accumulated end `e<m>`; and stored generated columns `g<k>` over `x`, and caller fields `y<k>`. A row's identity is
 * its serial in the model, and every key a row has ever had is a function of it: a uuid numbered by it, or texts of the
 * relation's drawn widths and the serial itself, so a re-key's data mapping, old key to new key, is the model's own.
 *
 * Each command is one delta of the cutover, composed several to a version:
 *
 * - a relation re-keyed from its uuid to the compound key, every relation that references it re-pointed to the new key
 *   (its uuid field dropped, three fields added), the new fields filled by the reviewer's data step; several re-keys in
 *   one version make chains and diamonds of re-keyed references;
 * - a relation re-keyed from its uuid to one text, a manifest identifier's shape, every reference to it keeping its
 *   name and changing its type from the uuid to the text (CONTRACT's `package`), each referencing row's value the
 *   reviewer's correlated read of the re-keyed row's new key through the old uuid;
 * - an ordered family switched to counted: the position goes, the set remains;
 * - an ordered family dropped, its member keeping a plain containment of its owner (Entry losing `at`);
 * - stored generated columns added in bulk to one relation;
 * - a caller field added and filled by a data step, row by row, from the model's function;
 * - a re-key whose texts are past PostgreSQL's B-tree entry limit, which the draft refuses by name, applying nothing.
 *
 * `migrate` first writes a batch of new facts through the login's served file (a ChangeSet of the version installed,
 * ordered members nested under their new owners), then drafts the pending version from the snapshot before it
 * (`grizzle generate`), declaring every dropped uuid field (`--drop`), and reviews it as a person does: each
 * new column's placeholder takes a typed default, and where the marker says, right after the draft's own `SET
 * CONSTRAINTS ALL IMMEDIATE`, the harness writes the data step from the model's mapping: each re-keyed relation's new
 * key from its old one, each referencing row's new fields joined through its old uuid, each filled field row by row;
 * a set-aside reference's fill takes the correlated read of its target's new key. Then the files are checked as
 * `grizzle check` checks them (every marker resolved, every loss decided, no statement controlling the transaction),
 * applied by `grizzle migrate`'s runner, whose admission judges the catalog against the snapshot, with the
 * installed-catalog checker. After every step:
 *
 * - every table of the installation was rewritten at most once by the migration, by PostgreSQL's `table_rewrite`
 *   event trigger (test/support/migrate/rewrites.ts);
 * - the installed catalog is a fresh install's of the version, its worlds included;
 * - every fact the model holds reads back exactly, through the model's identity and key mapping: each key, each
 *   re-pointed reference, each kept position, each count and fold end, each generated and filled value; nothing lost,
 *   nothing invented;
 * - the version's schema drafts no further change from the snapshot the migration reached: it is generated.
 *
 * A re-key past the limit is refused by the draft as UnrepresentableKey over the relation's texts; any other refusal of
 * any step fails the property.
 *
 * Text widths are drawn per re-key: short ones, and widths at the bound grizzle documents for a text beside the other
 * text and four bigints (public/text.ts keyTextBytes), which covers every index the world plans over a re-keyed key
 * (its primary key, an owner's key with a count, a family's own UNIQUEs with an index and a fold's running value), so
 * an index entry near BTMaxItemSize is inside the box; every row of an even serial holds its texts at their full width
 * in four-byte characters no compression shortens, so PostgreSQL itself refuses a key grizzle admits that does not fit.
 * Past the limit, both texts are wider than half of BTMaxItemSize. Widths between the documented bound and the limit
 * are not drawn: grizzle's bound there is its own, which this suite does not restate.
 *
 * Oracle: the world model, a second implementation of what every fact is after each delta, judged by PostgreSQL: the
 * rows it holds, the catalog of a fresh install, and the table_rewrite events it fires.
 *
 * Features: each delta, a reference re-pointed under its own name among them; a re-keyed relation referenced by two
 * relations, and by a re-keyed relation; an ordered family's owner re-keyed and an ordered member re-keyed; ordered to
 * counted with a fold over the family; a dropped position a fold read; a key near BTMaxItemSize admitted and one past
 * it refused; and a version with all six deltas.
 * Each is aimed at by a steered case, drawn over a world that holds every structure, never by filtering draws.
 *
 * The seventh delta, a property of its own over TREEKEY's frozen old-form tree (test/support/migrate/old-form-tree.ts):
 * an id-keyed tree, its parent the parent's id and its root one document field, as grizzle installed trees before
 * da713e04, becomes a keyed tree rooted at a package and a path, its parent drawn as the parent's start, with pantry's
 * Node's shape over its parent copies, which edullm's identity migration drafts: the parent's kind copied along the
 * parent axis under the keyed tree's law, so drawn anew, the grandparent's kind copied from the parent's copy, and a
 * count fold over each node's children whose selection reads both copies, which the backfill draws only after the
 * copies (backfill.ts ordered); and pantry's Instance's shape, the tree's own count `children` also carried along a
 * second family's owner axis (a family over Node by each node's `anchor`, the first node of its count in pre-order,
 * from the anchor's `sites`), which the backfill draws as the tree's count alone (backfill.ts familyCells). One to
 * three documents' trees, each drawn by its parents, are written directly with
 * every drawn value the old form's laws fix; the keyed tree is drafted from the frozen snapshot, `--drop`ping the old
 * id and document, reviewed with the data step that fills each node's new root from its document's uuid, and applied.
 * Each document mapped to its own root keeps every slot, count, interval and fold value, each parent the old parent's
 * start, and holds every copy and turns fold value the keyed tree's laws fix over the same facts, which a fresh install
 * holds (families/tree.ts numbered, the direct pre-order numbering, and turnsOf over it), at a fresh install's catalog, every table rewritten
 * at most once, nothing left to generate; two documents mapped onto one root, a named case of its own weight, are
 * refused at migrate by a law of the keyed tree, its primary key's, its family's or its fold's, read from the compiled
 * installation. The parent drawn anew is read off each root's intervals sorted (backfill.ts parentUpdate), so every
 * statement of the draft's backfill is judged on its SQL AST to read no row once per row of another, neither a
 * subquery reading a row outside it nor a LATERAL source (test/support/migrate/probes.ts). Its features: the old tree
 * keyed, a tree of three levels or more, several old trees each its own root, the refused merge, a fold over the copies
 * selecting a member, a node whose parent's kind is not its grandparent's, a tree's count carried along the anchor
 * family's owner axis from another node, and the shapes whose depths and levels the parent's backfill numbers: a
 * single-node tree, a chain four levels deep, three siblings or more under one parent, and one level under two parents,
 * each aimed at by a steered case that constructs it.
 *
 * Plants (~/.cache/grizzle-release/MIGSTRESS/plants): cutover-fk-keeps-old-key (a re-pointed foreign key keeps the
 * referenced table's old key), cutover-backfill-skips-rows (the family backfill skips a row of each group),
 * cutover-alter-per-column (each added column its own ALTER TABLE, one rewrite per column),
 * cutover-counted-keeps-ordered-index (ordered to counted, or a family dropped, leaves the ordered index `at` its CHECK
 * read), cutover-fold-reads-dropped-position (a family dropped leaves its fold's end on the owner), and
 * cutover-order-renumbered (a re-pointed sequence's stored index drawn again in its members' key order, which
 * a3b86f66 fixed); (~/.cache/grizzle-release/BACKFILLORDER/plants) backfill-fold-before-copies (a tree's fold drawn
 * before the copies its selection reads, as 73c7406e ordered them) and backfill-family-column-copied (a column a family
 * draws also drafted as another family's copy, which the backfill's order refuses as one column of two statements);
 * (~/.cache/grizzle-release/BACKFILLPROBE/plants) parent-correlated-probe (the parent drawn by a correlated max(start)
 * over the tree's rows, one probe per row) and parent-depth-off-by-one (a row's level counting the rows that end at its
 * start as still holding it).
 *
 * The file builds Substrate.isolatedLayer: the rewrite observer's event trigger is the database's.
 */
import { layer } from "@effect/vitest"
import {
	accepted,
	type Command,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	runProgram,
	took
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array as arrayGen,
	boolean,
	element,
	type Gen,
	int,
	parents as parentsGen,
	subset
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { fullSwarm, type Swarm, swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { transactionControl } from "#adapter/migrate/input.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { findMarkers, splitStatements } from "#compiler/plan/migration.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyRelation, type Statement, schema, select } from "#compiler/public/schema.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { generatedField, generatedRelation, relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import { printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	apply,
	checkedAdmission,
	noFurther,
	openMigrator,
	refusal,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { filledSql } from "#test/support/compile.ts"
import { type KeyedRow, numbered, treeOfParents } from "#test/support/families/tree.ts"
import { type Installed, installedOf } from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { type OldFormTree, oldFormTree } from "#test/support/migrate/old-form-tree.ts"
import { perRowReads } from "#test/support/migrate/probes.ts"
import { type Placeholder, readsBack, review } from "#test/support/migrate/review.ts"
import { type RewriteObserver, rewriteObserver } from "#test/support/migrate/rewrites.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import { appliedWith, member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** The most relations a world holds. */
const maxRelations = 4

/** The most stored generated columns a relation holds, and the most a bulk addition adds at once. */
const maxGenerated = 8
const bulk = { min: 2, max: 4 } as const

/** The most caller fields filled by a data step a relation holds. */
const maxFilled = 2

/** The widths of a compound key's two texts, in UTF-8 bytes, and whether they sit at the documented bound. */
interface Widths {
	readonly a: number
	readonly b: number
	readonly near: boolean
}

/** A relation's key: its uuid `id`; the compound (`ka`, `kb`, `kc`) of two texts of its widths and a bigint; or the one
 * text `ki` of its width, a manifest identifier's shape, which a reference holds under the reference's own name. */
type Key =
	| { readonly kind: "uuid" }
	| { readonly kind: "compound"; readonly widths: Widths }
	| { readonly kind: "identifier"; readonly width: number; readonly near: boolean }

/** A key a re-key gives: compound or an identifier. */
type NewKey = Exclude<Key, { readonly kind: "uuid" }>

/** How a relation references one before it: a plain containment, or as the member of the target's ordered or counted
 * family, folded by a sum of its `x` into the target's end or not. */
type Link =
	| { readonly kind: "contained" }
	| { readonly kind: "ordered"; readonly fold: boolean }
	| { readonly kind: "counted"; readonly fold: boolean }

interface Ref {
	readonly target: number
	readonly link: Link
}

/** A relation of the world: its key, its references, how many stored generated columns and filled fields it has. A
 * relation is a member of at most one family, and an ordered family's owner is no ordered member (the harness writes
 * a sequence nested one level under its owner). */
interface Rel {
	readonly key: Key
	readonly refs: ReadonlyArray<Ref>
	readonly generated: number
	readonly filled: number
}

interface World {
	readonly rels: Arr.NonEmptyReadonlyArray<Rel>
}

/** A fact: its serial, the identity every key it ever has is a function of, its payload, and the serial of the row each
 * of its references names, in its relation's reference order. */
interface Fact {
	readonly serial: number
	readonly x: number
	readonly refs: ReadonlyArray<number>
}

/** Facts by relation. */
type Facts = ReadonlyArray<ReadonlyArray<Fact>>

/** One delta a pending version holds, by the relation it changes. */
type Delta =
	| { readonly kind: "re-key"; readonly rel: number; readonly key: NewKey }
	| { readonly kind: "ordered to counted"; readonly rel: number }
	| { readonly kind: "position dropped"; readonly rel: number }
	| { readonly kind: "generated in bulk"; readonly rel: number; readonly count: number }
	| { readonly kind: "data-step field"; readonly rel: number }

/** The model: the world installed, the world the next version declares, every fact stored, the next serial, and the
 * deltas the pending version holds. */
interface Model {
	readonly installed: World
	readonly pending: World
	readonly facts: Facts
	readonly serial: number
	readonly deltas: ReadonlyArray<Delta>
}

const nth = <A>(xs: ReadonlyArray<A>, i: number, what: string): A =>
	defined(xs[i], `${what} ${i} of ${xs.length}`)

const relName = (r: number): string => `R${r}`

/** The family a relation is a member of: its reference's place and the reference, or none. */
const familyOf = (
	rel: Rel
): Option.Option<{ readonly at: number; readonly ref: Ref; readonly fold: boolean }> =>
	Option.flatMap(
		Arr.findFirstIndex(rel.refs, (ref) => ref.link.kind !== "contained"),
		(at) => {
			const ref = nth(rel.refs, at, "reference")
			return ref.link.kind === "contained"
				? Option.none()
				: Option.some({ at, ref, fold: ref.link.fold })
		}
	)

const isOrderedMember = (rel: Rel): boolean =>
	Arr.some(rel.refs, (ref) => ref.link.kind === "ordered")

/** The relations of a world with a key of `kind`. */
const keyedBy = (w: World, kind: Key["kind"]): ReadonlyArray<number> =>
	Arr.filter(indices(w.rels.length), (r) => nth(w.rels, r, "relation").key.kind === kind)

/** The relations of a world that are ordered members. */
const orderedMembers = (w: World): ReadonlyArray<number> =>
	Arr.filter(indices(w.rels.length), (r) => isOrderedMember(nth(w.rels, r, "relation")))

/** The relations that reference `t`, each once. */
const referencersOf = (w: World, t: number): ReadonlyArray<number> =>
	Arr.filter(indices(w.rels.length), (s) =>
		Arr.some(nth(w.rels, s, "relation").refs, (ref) => ref.target === t)
	)

/** The members of the families `t` owns, by member relation, with each one's reference place and fold. */
const ownedBy = (
	w: World,
	t: number
): ReadonlyArray<{ readonly member: number; readonly at: number; readonly link: Link }> =>
	Arr.flatMap(indices(w.rels.length), (m) =>
		Option.match(familyOf(nth(w.rels, m, "relation")), {
			onNone: () => [],
			onSome: (f) => (f.ref.target === t ? [{ member: m, at: f.at, link: f.ref.link }] : [])
		})
	)

const withRel = (w: World, r: number, f: (rel: Rel) => Rel): World => ({
	rels: Arr.map(w.rels, (rel, i) => (i === r ? f(rel) : rel))
})

/** The world with the family of `r` changed by `f`. */
const withLink = (w: World, r: number, f: (link: Link) => Link): World =>
	withRel(w, r, (rel) => ({
		...rel,
		refs: Arr.map(rel.refs, (ref) =>
			ref.link.kind === "contained" ? ref : { ...ref, link: f(ref.link) }
		)
	}))

const hasDelta = (m: Model, kind: Delta["kind"], r: number): boolean =>
	Arr.some(m.deltas, (d) => d.kind === kind && d.rel === r)

const deltasOf = <K extends Delta["kind"]>(
	m: Model,
	kind: K
): ReadonlyArray<Extract<Delta, { readonly kind: K }>> =>
	Arr.filter(m.deltas, (d): d is Extract<Delta, { readonly kind: K }> => d.kind === kind)

/** Any text, which a field bounds by its bytes. */
const anyText = str.regex("^.*$", "su")

const textField = (bytes: number) => str.bytes(bytes, anyText)

/**
 * The widest text, in UTF-8 bytes, that grizzle's documented bound admits beside another text as wide and four bigints
 * (keyTextBytes): the width "near" draws, at which every index the world plans over a compound key fits.
 */
const nearWidth: number = (() => {
	const room = (n: number): number =>
		keyTextBytes([textField(n), pg.bigint, pg.bigint, pg.bigint, pg.bigint])
	let found = 1
	let lo = 1
	let hi = 2704
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2)
		if (mid <= room(mid)) {
			found = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return found
})()

/** Half of BTMaxItemSize, 2,704 bytes: two texts wider than it make a key no B-tree entry holds. */
const halfLimit = 1352

/** The widest one text grizzle's documented bound admits beside four bigints: the width "near" draws for an
 * identifier. */
const nearIdentifier: number = keyTextBytes([pg.bigint, pg.bigint, pg.bigint, pg.bigint])

/** A re-key's widths: short ones, or at the documented bound, each text drawn apart. */
const widthsGen =
	(near: boolean): Gen<Widths> =>
	(source) =>
		near
			? {
					a: nearWidth - source.draw(int(0, 3)),
					b: nearWidth - source.draw(int(0, 3)),
					near: true
				}
			: { a: source.draw(int(16, 64)), b: source.draw(int(16, 64)), near: false }

/**
 * The uuid of a fact of relation `r`: the relation, then its serial scrambled by an odd multiplier modulo 2^32, a
 * bijection that wraps from the second serial on, so the uuids of a relation's facts are in no order of their serials
 * and a sequence renumbered by its members' keys leaves the order the caller wrote.
 */
const uuidOf = (r: number, serial: number): string =>
	`00000000-0000-4000-8000-${pipe(
		(r * 2 ** 32 + (Math.imul(serial, 0x9e_37_79_b1) >>> 0)).toString(16),
		Str.padStart(12, "0")
	)}`

/**
 * A compound key's text of a fact: its prefix alone for an odd serial; for an even serial, exactly `width` UTF-8 bytes,
 * the prefix then four-byte characters of a Park-Miller sequence seeded by the fact, which no compression shortens,
 * then ASCII to the width.
 */
const textOf = (tag: "a" | "b" | "i", r: number, serial: number, width: number): string => {
	const prefix = `${tag}${r}.${serial}.`
	if (serial % 2 === 1) {
		return prefix
	}
	let state =
		(serial * 7919 + r * 104_729 + (tag === "a" ? 1 : tag === "b" ? 2 : 3)) % 2_147_483_647
	const wide = Math.floor((width - prefix.length) / 4)
	const chars = Arr.map(indices(wide), () => {
		state = (state * 48_271) % 2_147_483_647
		return String.fromCodePoint(0x1_00_00 + (state % 0xf_00_00))
	})
	return `${prefix}${Arr.join(chars, "")}${pipe("z", Str.repeat(width - prefix.length - wide * 4))}`
}

/** The value of filled field `k` of a fact. */
const filledOf = (serial: number, k: number): number => (serial * 31 + k * 17) % 1000

/** A key's fields, by name. */
const keyFields = (key: Key): Arr.NonEmptyReadonlyArray<string> =>
	key.kind === "uuid" ? ["id"] : key.kind === "identifier" ? ["ki"] : ["ka", "kb", "kc"]

/** The fields a reference to `t` holds, as `t`'s key is. */
const refFields = (w: World, t: number): Arr.NonEmptyReadonlyArray<string> =>
	nth(w.rels, t, "relation").key.kind === "compound" ? [`p${t}a`, `p${t}b`, `p${t}c`] : [`p${t}`]

/** The key values of a fact of `r`, as text, in key field order. */
const keyValues = (w: World, r: number, serial: number): Arr.NonEmptyReadonlyArray<string> => {
	const key = nth(w.rels, r, "relation").key
	switch (key.kind) {
		case "uuid":
			return [uuidOf(r, serial)]
		case "identifier":
			return [textOf("i", r, serial, key.width)]
		case "compound":
			return [
				textOf("a", r, serial, key.widths.a),
				textOf("b", r, serial, key.widths.b),
				String(serial)
			]
	}
}

/** The fields of a relation's row the model states, in order: key, references, payload, position, owned counts and
 * ends, generated, filled. */
const visibleFields = (w: World, r: number): ReadonlyArray<string> => {
	const rel = nth(w.rels, r, "relation")
	return [
		...keyFields(rel.key),
		...Arr.flatMap(rel.refs, (ref) => refFields(w, ref.target)),
		"x",
		...(isOrderedMember(rel) ? ["at"] : []),
		...Arr.flatMap(ownedBy(w, r), (o) =>
			o.link.kind === "contained" ? [] : [`n${o.member}`, ...(o.link.fold ? [`e${o.member}`] : [])]
		),
		...Arr.map(indices(rel.generated), (k) => `g${k}`),
		...Arr.map(indices(rel.filled), (k) => `y${k}`)
	]
}

/** The members of `m` whose reference at `at` names `serial`, in serial order: a sequence in its order. */
const membersUnder = (facts: Facts, m: number, at: number, serial: number): ReadonlyArray<Fact> =>
	Arr.sort(
		Arr.filter(nth(facts, m, "relation's facts"), (f) => f.refs[at] === serial),
		Order.mapInput(Order.Number, (f: Fact) => f.serial)
	)

/** A fact's row as the model states it: each visible field's text. */
const expectedRow = (w: World, facts: Facts, r: number, fact: Fact): ReadonlyArray<string> => {
	const rel = nth(w.rels, r, "relation")
	const position = Option.match(familyOf(rel), {
		onNone: () => [],
		onSome: (f) =>
			f.ref.link.kind === "ordered"
				? [
						String(
							Arr.findFirstIndex(
								membersUnder(facts, r, f.at, nth(fact.refs, f.at, "family reference")),
								(sibling) => sibling.serial === fact.serial
							).pipe(Option.getOrThrow)
						)
					]
				: []
	})
	return [
		...keyValues(w, r, fact.serial),
		...Arr.flatMap(rel.refs, (ref, j) => keyValues(w, ref.target, nth(fact.refs, j, "reference"))),
		String(fact.x),
		...position,
		...Arr.flatMap(ownedBy(w, r), (o) => {
			if (o.link.kind === "contained") {
				return []
			}
			const members = membersUnder(facts, o.member, o.at, fact.serial)
			return [
				String(members.length),
				...(o.link.fold ? [String(Arr.reduce(members, 0, (sum, m) => sum + m.x))] : [])
			]
		}),
		...Arr.map(indices(rel.generated), () => String(fact.x)),
		...Arr.map(indices(rel.filled), (k) => String(filledOf(fact.serial, k)))
	]
}

/** The world's schema value under `declared`, its relations by index, and its full world: the role `app` holding and
 * writing every relation, in the login `server`. */
const builtOf = (w: World, declared: string) => {
	const values: Array<AnyRelation> = []
	const statements: Array<Statement> = []
	const valueAt = (t: number): AnyRelation => nth(values, t, "relation value")
	for (const [r, rel] of w.rels.entries()) {
		const fields: Record<string, FieldBase> = {}
		switch (rel.key.kind) {
			case "uuid":
				fields["id"] = uuid
				break
			case "identifier":
				fields["ki"] = textField(rel.key.width)
				break
			case "compound":
				fields["ka"] = textField(rel.key.widths.a)
				fields["kb"] = textField(rel.key.widths.b)
				fields["kc"] = pg.bigint
				break
		}
		for (const ref of rel.refs) {
			const target = nth(w.rels, ref.target, "relation")
			switch (target.key.kind) {
				case "uuid":
					fields[`p${ref.target}`] = uuid
					break
				case "identifier":
					fields[`p${ref.target}`] = textField(target.key.width)
					break
				case "compound":
					fields[`p${ref.target}a`] = textField(target.key.widths.a)
					fields[`p${ref.target}b`] = textField(target.key.widths.b)
					fields[`p${ref.target}c`] = pg.bigint
					break
			}
		}
		fields["x"] = pg.integer
		if (isOrderedMember(rel)) {
			fields["at"] = drawnField(natural)
		}
		for (const o of ownedBy(w, r)) {
			if (o.link.kind !== "contained") {
				fields[`n${o.member}`] = drawnField(natural)
				if (o.link.fold) {
					fields[`e${o.member}`] = accumulated(pg.integer, 0)
				}
			}
		}
		for (const k of indices(rel.filled)) {
			fields[`y${k}`] = pg.integer
		}
		const key = keyFields(rel.key)
		values.push(
			rel.generated === 0
				? relation(relName(r), fields, key, [])
				: generatedRelation(
						relName(r),
						fields,
						key,
						(row) =>
							Rec.fromEntries(
								Arr.map(
									indices(rel.generated),
									(k) => [`g${k}`, generatedField(pg.integer, row["x"], [])] as const
								)
							),
						[]
					)
		)
		for (const ref of rel.refs) {
			const here = valueAt(r)
			const there = valueAt(ref.target)
			const by = refFields(w, ref.target)
			const targetKey = keyFields(nth(w.rels, ref.target, "relation").key)
			switch (ref.link.kind) {
				case "contained":
					statements.push(containedBuilder(onBuilder(here, by), onBuilder(there, targetKey)))
					break
				case "ordered":
				case "counted": {
					const slots = finBuilder(there, `n${r}`)
					const family =
						ref.link.kind === "ordered"
							? orderedBuilder(onBuilder(here, [...by, "at"]), slots)
							: countedBuilder(onBuilder(here, by), slots)
					statements.push(family)
					if (ref.link.fold) {
						statements.push(
							foldBuilder(
								family,
								monoids.sum,
								onBuilder(here, [...by, "x"]),
								onBuilder(there, [...targetKey, `e${r}`])
							)
						)
					}
					break
				}
			}
		}
	}
	const relations: Readonly<Record<string, AnyRelation>> = Rec.fromEntries(
		Arr.map(values, (v, r) => [relName(r), v] as const)
	)
	const value = schema(declared, relations, statements)
	return { value, relation: valueAt, world: fullWorld(value, {}) }
}

/** The installation of a version's schema value under the allocated `name`, owned by `owner`, with its login. */
const planned = (built: ReturnType<typeof builtOf>, name: string, owner: string): RealInstallPlan =>
	succeeded(
		planRealInstall(built.value, {
			installation: identity.schema(parsedSchemaName(name)),
			owner,
			logins: [built.world.server],
			extensions: [],
			codes: firstCodebook(rostersOf(owning(built.value))),
			compile: compileInstallation
		}),
		"the installation of a version"
	)

/** The row of a fact as a ChangeSet states it: its caller's fields, a sequence it owns nested at its count, the
 * members' own references to the owner and their positions left to their nesting. */
const factRecord = (
	w: World,
	facts: Facts,
	r: number,
	fact: Fact,
	nestedIn: Option.Option<number>
): Readonly<Record<string, unknown>> => {
	const rel = nth(w.rels, r, "relation")
	const row: Record<string, unknown> = {}
	const key = keyValues(w, r, fact.serial)
	for (const [i, field] of keyFields(rel.key).entries()) {
		row[field] = field === "kc" ? BigInt(fact.serial) : nth(key, i, "key value")
	}
	for (const [j, ref] of rel.refs.entries()) {
		if (Option.contains(nestedIn, j)) {
			continue
		}
		const target = nth(fact.refs, j, "reference")
		const values = keyValues(w, ref.target, target)
		for (const [i, field] of refFields(w, ref.target).entries()) {
			row[field] = i === 2 ? BigInt(target) : nth(values, i, "reference value")
		}
	}
	row["x"] = fact.x
	for (const k of indices(rel.filled)) {
		row[`y${k}`] = filledOf(fact.serial, k)
	}
	for (const o of ownedBy(w, r)) {
		if (o.link.kind === "ordered") {
			row[`n${o.member}`] = Arr.map(membersUnder(facts, o.member, o.at, fact.serial), (m) =>
				factRecord(w, facts, o.member, m, Option.some(o.at))
			)
		}
	}
	return row
}

/** A batch's facts by the relations a ChangeSet inserts at the top: every relation but an ordered member, whose facts
 * its owners' rows nest. */
const insertsOf = (
	w: World,
	all: Facts,
	batch: Facts
): ReadonlyArray<readonly [number, Arr.NonEmptyReadonlyArray<Readonly<Record<string, unknown>>>]> =>
	Arr.flatMap(indices(w.rels.length), (r) => {
		if (isOrderedMember(nth(w.rels, r, "relation"))) {
			return []
		}
		const rows = Arr.map(nth(batch, r, "batch"), (f) => factRecord(w, all, r, f, Option.none()))
		return Arr.isReadonlyArrayNonEmpty(rows) ? [[r, rows] as const] : []
	})

/** Facts and a batch together. */
const withBatch = (facts: Facts, batch: Facts): Facts =>
	Arr.map(facts, (fs, r) => [...fs, ...nth(batch, r, "batch")])

/**
 * A batch of new facts in the installed world, from `serial` on: every relation in order draws some rows, each
 * reference naming a stored or new row of its target, a family member's naming a new row of its owner, a few under
 * each; a relation whose reference has no row to name draws none.
 */
const batchGen =
	(m: Model): Gen<Facts> =>
	(source) => {
		let serial = m.serial
		const added: Array<ReadonlyArray<Fact>> = []
		for (const rel of m.installed.rels) {
			const pool = (t: number): ReadonlyArray<number> =>
				Arr.map([...nth(m.facts, t, "facts"), ...nth(added, t, "batch")], (f) => f.serial)
			const draw = (family: Option.Option<{ readonly at: number; readonly owner: number }>) => {
				const refs: Array<number> = []
				for (const [j, ref] of rel.refs.entries()) {
					const fixed = Option.flatMap(family, (f) =>
						f.at === j ? Option.some(f.owner) : Option.none()
					)
					if (Option.isSome(fixed)) {
						refs.push(fixed.value)
						continue
					}
					const named = pool(ref.target)
					if (!Arr.isReadonlyArrayNonEmpty(named)) {
						return Option.none()
					}
					refs.push(source.draw(element(named)))
				}
				const fact: Fact = { serial: serial++, x: source.draw(int(-9, 9)), refs }
				return Option.some(fact)
			}
			const out: Array<Fact> = []
			const family = familyOf(rel)
			if (Option.isSome(family)) {
				for (const owner of nth(added, family.value.ref.target, "batch")) {
					for (const _ of indices(source.draw(int(0, 2)))) {
						Option.map(draw(Option.some({ at: family.value.at, owner: owner.serial })), (f) =>
							out.push(f)
						)
					}
				}
			} else {
				for (const _ of indices(source.draw(int(0, 3)))) {
					Option.map(draw(Option.none()), (f) => out.push(f))
				}
			}
			added.push(out)
		}
		return added
	}

type Params = {
	readonly "re-key a relation": { readonly rel: number; readonly widths: Widths }
	readonly "re-key a relation to an identifier its references keep their names over": {
		readonly rel: number
		readonly width: number
		readonly near: boolean
	}
	readonly "re-key a relation past BTMaxItemSize": { readonly rel: number; readonly widths: Widths }
	readonly "switch an ordered family to counted": { readonly rel: number }
	readonly "drop an ordered family's position": { readonly rel: number }
	readonly "add stored generated columns in bulk": { readonly rel: number; readonly count: number }
	readonly "add a field filled by a data step": { readonly rel: number }
	readonly migrate: { readonly batch: Facts }
}

type CommandName = keyof Params

const pendingDelta = (m: Model, delta: Delta, pending: World): Model => ({
	...m,
	pending,
	deltas: [...m.deltas, delta]
})

/** The model with `r` re-keyed to `key` in the pending version. */
const reKeyed = (m: Model, r: number, key: NewKey): Model =>
	pendingDelta(
		m,
		{ kind: "re-key", rel: r, key },
		withRel(m.pending, r, (rel) => ({ ...rel, key }))
	)

const generable = (m: Model): ReadonlyArray<number> =>
	Arr.filter(
		indices(m.pending.rels.length),
		(r) =>
			!hasDelta(m, "generated in bulk", r) &&
			nth(m.pending.rels, r, "relation").generated + bulk.max <= maxGenerated
	)

const fillable = (m: Model): ReadonlyArray<number> =>
	Arr.filter(
		indices(m.pending.rels.length),
		(r) =>
			!hasDelta(m, "data-step field", r) && nth(m.pending.rels, r, "relation").filled < maxFilled
	)

/** The machine over a world: its commands, with re-keys drawn near the bound where `near` asks. */
const machineOf = (
	initial: Model,
	near: boolean
): Machine<Model, Params, "UnrepresentableKey"> => ({
	initial,
	commands: {
		"re-key a relation": {
			weight: 3,
			applies: (m) => keyedBy(m.pending, "uuid").length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(
					element(nonEmptyList(keyedBy(m.pending, "uuid"), "a uuid-keyed relation"))
				),
				widths: source.draw(near ? widthsGen(true) : (s) => s.draw(widthsGen(s.draw(boolean))))
			}),
			judge: (m, p) => accepted(reKeyed(m, p.rel, { kind: "compound", widths: p.widths }))
		},
		"re-key a relation to an identifier its references keep their names over": {
			weight: 2,
			applies: (m) => keyedBy(m.pending, "uuid").length > 0,
			parameters: (m) => (source) => {
				const rel = source.draw(
					element(nonEmptyList(keyedBy(m.pending, "uuid"), "a uuid-keyed relation"))
				)
				const atBound = near || source.draw(boolean)
				return {
					rel,
					width: atBound ? nearIdentifier - source.draw(int(0, 3)) : source.draw(int(16, 64)),
					near: atBound
				}
			},
			judge: (m, p) =>
				accepted(reKeyed(m, p.rel, { kind: "identifier", width: p.width, near: p.near }))
		},
		"re-key a relation past BTMaxItemSize": {
			weight: 1,
			applies: (m) => keyedBy(m.pending, "uuid").length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(
					element(nonEmptyList(keyedBy(m.pending, "uuid"), "a uuid-keyed relation"))
				),
				widths: {
					a: halfLimit + source.draw(int(1, 64)),
					b: halfLimit + source.draw(int(1, 64)),
					near: false
				}
			}),
			judge: () => refused("UnrepresentableKey")
		},
		"switch an ordered family to counted": {
			weight: 2,
			applies: (m) => orderedMembers(m.pending).length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(element(nonEmptyList(orderedMembers(m.pending), "an ordered member")))
			}),
			judge: (m, p) =>
				accepted(
					pendingDelta(
						m,
						{ kind: "ordered to counted", rel: p.rel },
						withLink(m.pending, p.rel, (link) => ({
							kind: "counted",
							fold: link.kind !== "contained" && link.fold
						}))
					)
				)
		},
		"drop an ordered family's position": {
			weight: 2,
			applies: (m) => orderedMembers(m.pending).length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(element(nonEmptyList(orderedMembers(m.pending), "an ordered member")))
			}),
			judge: (m, p) =>
				accepted(
					pendingDelta(
						m,
						{ kind: "position dropped", rel: p.rel },
						withLink(m.pending, p.rel, () => ({ kind: "contained" }))
					)
				)
		},
		"add stored generated columns in bulk": {
			weight: 2,
			applies: (m) => generable(m).length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(element(nonEmptyList(generable(m), "a relation to generate over"))),
				count: source.draw(int(bulk.min, bulk.max))
			}),
			judge: (m, p) =>
				accepted(
					pendingDelta(
						m,
						{ kind: "generated in bulk", rel: p.rel, count: p.count },
						withRel(m.pending, p.rel, (rel) => ({ ...rel, generated: rel.generated + p.count }))
					)
				)
		},
		"add a field filled by a data step": {
			weight: 2,
			applies: (m) => fillable(m).length > 0,
			parameters: (m) => (source) => ({
				rel: source.draw(element(nonEmptyList(fillable(m), "a relation to fill a field of")))
			}),
			judge: (m, p) =>
				accepted(
					pendingDelta(
						m,
						{ kind: "data-step field", rel: p.rel },
						withRel(m.pending, p.rel, (rel) => ({ ...rel, filled: rel.filled + 1 }))
					)
				)
		},
		migrate: {
			weight: 2,
			applies: (m) => m.deltas.length > 0,
			parameters: (m) => (source) => ({ batch: source.draw(batchGen(m)) }),
			judge: (m, p) =>
				accepted({
					installed: m.pending,
					pending: m.pending,
					facts: withBatch(m.facts, p.batch),
					serial: m.serial + Arr.reduce(p.batch, 0, (n, fs) => n + fs.length),
					deltas: []
				})
		}
	}
})

/** A world of two to four uuid-keyed relations, each referencing some before it, maybe one of them as a family's
 * member; an ordered family's owner is no ordered member. */
const worldGen: Gen<World> = (source) => {
	const n = source.draw(int(2, maxRelations))
	const rels: Array<Rel> = []
	for (const r of indices(n)) {
		const targets = r === 0 ? [] : source.draw(subset(indices(r), { min: 0, max: Math.min(2, r) }))
		const familyAt =
			Arr.isReadonlyArrayNonEmpty(targets) && source.draw(boolean)
				? Option.some(source.draw(int(0, targets.length - 1)))
				: Option.none()
		const refs = Arr.map(targets, (target, j): Ref => {
			if (!Option.contains(familyAt, j)) {
				return { target, link: { kind: "contained" } }
			}
			const fold = source.draw(boolean)
			const ordered = !isOrderedMember(nth(rels, target, "relation")) && source.draw(boolean)
			return { target, link: ordered ? { kind: "ordered", fold } : { kind: "counted", fold } }
		})
		rels.push({ key: { kind: "uuid" }, refs, generated: source.draw(int(0, 1)), filled: 0 })
	}
	return { rels: nonEmpty(rels, "a world's relations") }
}

/**
 * The world every steered case draws, holding every structure a feature needs: R1 and R2 ordered members of R0 with
 * folds (two sequences, one to switch to counted and one to drop), R2 also referencing R1, and R3 a counted member of R1
 * with a fold that also references R2: R0 and R1 each referenced by two relations, and a diamond R3 → R1 → R0,
 * R3 → R2 → R0.
 */
const richWorld: World = {
	rels: [
		{ key: { kind: "uuid" }, refs: [], generated: 0, filled: 0 },
		{
			key: { kind: "uuid" },
			refs: [{ target: 0, link: { kind: "ordered", fold: true } }],
			generated: 1,
			filled: 0
		},
		{
			key: { kind: "uuid" },
			refs: [
				{ target: 0, link: { kind: "ordered", fold: true } },
				{ target: 1, link: { kind: "contained" } }
			],
			generated: 0,
			filled: 0
		},
		{
			key: { kind: "uuid" },
			refs: [
				{ target: 1, link: { kind: "counted", fold: true } },
				{ target: 2, link: { kind: "contained" } }
			],
			generated: 0,
			filled: 0
		}
	]
}

const initialModel = (w: World): Model => ({
	installed: w,
	pending: w,
	facts: Arr.map(w.rels, () => []),
	serial: 1,
	deltas: []
})

type Feature =
	| "a relation re-keyed"
	| "several relations re-keyed in one migration"
	| "a re-keyed relation referenced by two relations"
	| "a re-keyed relation referenced by a re-keyed relation"
	| "an ordered family's owner re-keyed"
	| "an ordered member re-keyed"
	| "an ordered family switched to counted"
	| "an ordered family with a fold switched to counted"
	| "an ordered family's position dropped"
	| "a dropped position a fold read"
	| "stored generated columns added in bulk to stored rows"
	| "a field filled by a data step over stored rows"
	| "a key near BTMaxItemSize admitted"
	| "a key past BTMaxItemSize refused"
	| "a version with all six deltas"
	| "a reference re-pointed under its own name"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a relation re-keyed",
	"several relations re-keyed in one migration",
	"a re-keyed relation referenced by two relations",
	"a re-keyed relation referenced by a re-keyed relation",
	"an ordered family's owner re-keyed",
	"an ordered member re-keyed",
	"an ordered family switched to counted",
	"an ordered family with a fold switched to counted",
	"an ordered family's position dropped",
	"a dropped position a fold read",
	"stored generated columns added in bulk to stored rows",
	"a field filled by a data step over stored rows",
	"a key near BTMaxItemSize admitted",
	"a key past BTMaxItemSize refused",
	"a version with all six deltas",
	"a reference re-pointed under its own name"
]

/** Whether a version re-keys a relation a relation it re-keys references: delta 4, re-keyed relations chained. */
const chainedReKeys = (m: Model): boolean => {
	const rekeyed = Arr.map(deltasOf(m, "re-key"), (d) => d.rel)
	return Arr.some(rekeyed, (s) =>
		Arr.some(nth(m.pending.rels, s, "relation").refs, (ref) => rekeyed.includes(ref.target))
	)
}

/** The commands that advance a pending feature in a model's state: the delta it needs while the version lacks it,
 * else migrate. */
const aimOf = (f: Feature, m: Model): ReadonlyArray<CommandName> => {
	const lacking = (kind: Delta["kind"], command: CommandName): ReadonlyArray<CommandName> =>
		deltasOf(m, kind).length === 0 ? [command] : []
	const or = (commands: ReadonlyArray<CommandName>): ReadonlyArray<CommandName> =>
		commands.length > 0 ? commands : ["migrate"]
	switch (f) {
		case "a relation re-keyed":
		case "several relations re-keyed in one migration":
		case "a re-keyed relation referenced by two relations":
		case "a re-keyed relation referenced by a re-keyed relation":
		case "an ordered family's owner re-keyed":
		case "an ordered member re-keyed":
		case "a key near BTMaxItemSize admitted":
			return or(deltasOf(m, "re-key").length < 2 ? ["re-key a relation"] : [])
		case "an ordered family switched to counted":
		case "an ordered family with a fold switched to counted":
			return or(lacking("ordered to counted", "switch an ordered family to counted"))
		case "an ordered family's position dropped":
		case "a dropped position a fold read":
			return or(lacking("position dropped", "drop an ordered family's position"))
		case "stored generated columns added in bulk to stored rows":
			return or(lacking("generated in bulk", "add stored generated columns in bulk"))
		case "a field filled by a data step over stored rows":
			return or(lacking("data-step field", "add a field filled by a data step"))
		case "a key past BTMaxItemSize refused":
			return ["re-key a relation past BTMaxItemSize"]
		case "a reference re-pointed under its own name":
			return or(
				Arr.some(deltasOf(m, "re-key"), (d) => d.key.kind === "identifier")
					? []
					: ["re-key a relation to an identifier its references keep their names over"]
			)
		case "a version with all six deltas":
			return or([
				...(chainedReKeys(m) ? [] : (["re-key a relation"] as const)),
				...lacking("ordered to counted", "switch an ordered family to counted"),
				...lacking("position dropped", "drop an ordered family's position"),
				...lacking("generated in bulk", "add stored generated columns in bulk"),
				...lacking("data-step field", "add a field filled by a data step")
			])
	}
}

/** The machine aimed at the pending features: where a command that advances one applies, only those do. */
const aimedAt = (
	base: Machine<Model, Params, "UnrepresentableKey">,
	pending: ReadonlySet<Feature>
): Machine<Model, Params, "UnrepresentableKey"> => {
	const aims = (m: Model): ReadonlySet<CommandName> =>
		new Set(Arr.flatMap([...pending], (f) => aimOf(f, m)))
	const anyAimed = (m: Model): boolean => Arr.some([...aims(m)], (k) => base.commands[k].applies(m))
	const aimed = <K extends CommandName>(k: K): Command<Model, Params[K], "UnrepresentableKey"> => {
		const command = base.commands[k]
		return { ...command, applies: (m) => command.applies(m) && (aims(m).has(k) || !anyAimed(m)) }
	}
	return {
		initial: base.initial,
		commands: {
			"re-key a relation": aimed("re-key a relation"),
			"re-key a relation to an identifier its references keep their names over": aimed(
				"re-key a relation to an identifier its references keep their names over"
			),
			"re-key a relation past BTMaxItemSize": aimed("re-key a relation past BTMaxItemSize"),
			"switch an ordered family to counted": aimed("switch an ordered family to counted"),
			"drop an ordered family's position": aimed("drop an ordered family's position"),
			"add stored generated columns in bulk": aimed("add stored generated columns in bulk"),
			"add a field filled by a data step": aimed("add a field filled by a data step"),
			migrate: aimed("migrate")
		}
	}
}

/** A case: its world and its program. */
interface Cutover {
	readonly world: World
	readonly steps: Program<Params>
}

const deltaCommands: Arr.NonEmptyReadonlyArray<CommandName> = [
	"re-key a relation",
	"re-key a relation to an identifier its references keep their names over",
	"re-key a relation past BTMaxItemSize",
	"switch an ordered family to counted",
	"drop an ordered family's position",
	"add stored generated columns in bulk",
	"add a field filled by a data step"
]

/** The size of a case's program. */
const programSize = { min: 2, max: 14 } as const

/** A case's swarm: the deltas it turns on, and migrate always on, the forced move that applies them. */
const commandSwarm: Gen<Swarm<CommandName>> = (source) => ({
	...source.draw(swarm(deltaCommands)),
	migrate: 3
})

const cutoverGen: Gen<Cutover> = (source) => {
	const world = source.draw(worldGen)
	const drawnSwarm = source.draw(commandSwarm)
	return {
		world,
		steps: source.draw(program(machineOf(initialModel(world), false), programSize, drawnSwarm))
	}
}

/** The steered case: the rich world, its program aimed at the pending features with every command on, so no swarm
 * turns off a delta a pending feature needs. */
const steeredGen =
	(pending: ReadonlySet<Feature>): Gen<Cutover> =>
	(source) => {
		const base = machineOf(
			initialModel(richWorld),
			pending.has("a key near BTMaxItemSize admitted")
		)
		return {
			world: richWorld,
			steps: source.draw(
				program(aimedAt(base, pending), programSize, fullSwarm([...deltaCommands, "migrate"]))
			)
		}
	}

/** What a history runs on: its schema, the folders applied, the snapshot they reached, the installation the next
 * writes are served from, and how many drafts it made. */
interface History {
	readonly declared: string
	readonly schema: string
	readonly owner: string
	folders: Array<FolderSource>
	previous: Previous
	installed: Installed
	steps: number
}

const q = quoteIdent
const column = (field: string): string => q(identifierOf(identity.column(parsedName(field))))
const tableOf = (h: History, r: number): string =>
	`${q(h.schema)}.${q(identifierOf(identity.table(parsedName(relName(r)))))}`

/** The declarations of a version by the model: each re-keyed relation's uuid, and each reference to it, dropped. */
const declarationsOf = (m: Model): Declarations => {
	const drops: Array<Named> = []
	for (const d of deltasOf(m, "re-key")) {
		drops.push({ kind: "field", relation: parsedName(relName(d.rel)), field: parsedName("id") })
		for (const s of d.key.kind === "compound" ? referencersOf(m.installed, d.rel) : []) {
			drops.push({
				kind: "field",
				relation: parsedName(relName(s)),
				field: parsedName(`p${d.rel}`)
			})
		}
	}
	return { renames: [], drops }
}

/** The placeholders a version's draft asks for, by printed table and column, each with its typed default: every caller
 * field it adds to a relation that existed. */
const placeholdersOf = (h: History, m: Model): ReadonlyMap<string, string> => {
	const out = new Map<string, string>()
	const add = (r: number, field: string, value: string) =>
		out.set(`${tableOf(h, r)}\u0000${identifierOf(identity.column(parsedName(field)))}`, value)
	for (const d of deltasOf(m, "re-key")) {
		switch (d.key.kind) {
			case "compound":
				add(d.rel, "ka", "''")
				add(d.rel, "kb", "''")
				add(d.rel, "kc", "0")
				for (const s of referencersOf(m.installed, d.rel)) {
					add(s, `p${d.rel}a`, "''")
					add(s, `p${d.rel}b`, "''")
					add(s, `p${d.rel}c`, "0")
				}
				break
			case "identifier":
				add(d.rel, "ki", "''")
				for (const s of referencersOf(m.installed, d.rel)) {
					add(
						s,
						`p${d.rel}`,
						`(SELECT "r".${column("ki")} FROM ${tableOf(h, d.rel)} AS "r" WHERE "r".${column("id")} = "t".${column(`p${d.rel}`)})`
					)
				}
				break
		}
	}
	for (const d of deltasOf(m, "data-step field")) {
		add(d.rel, `y${nth(m.installed.rels, d.rel, "relation").filled}`, "0")
	}
	return out
}

const placeholderKey = (p: Placeholder): string =>
	`${printObjectName(p.table)}\u0000${p.column.name}`

/** Typed SQL literals of a uuid, a text and a bigint, as the drafts name their types. */
const uuidLiteral = (value: string): string => `${quoteString(value)}::"pg_catalog"."uuid"`
const textLiteral = (value: string): string => `${quoteString(value)}::"pg_catalog"."text"`
const int8Literal = (value: string): string => `${value}::"pg_catalog"."int8"`

/** The literals of a fact's key of `r` in world `w`, in key field order. */
const keyLiterals = (w: World, r: number, serial: number): ReadonlyArray<string> => {
	const values = keyValues(w, r, serial)
	switch (nth(w.rels, r, "relation").key.kind) {
		case "uuid":
			return Arr.map(values, uuidLiteral)
		case "identifier":
			return Arr.map(values, textLiteral)
		case "compound":
			return Arr.map(values, (v, i) => (i === 2 ? int8Literal(v) : textLiteral(v)))
	}
}

/** VALUES of rows, each its literals. */
const valuesOf = (rows: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>): string =>
	`(VALUES ${Arr.join(
		Arr.map(rows, (row) => `(${Arr.join(row, ", ")})`),
		", "
	)})`

/**
 * The reviewer's data step of a version, from the model's mapping, over the facts stored when it runs: each re-keyed
 * relation's new key from its uuid, then each referencing row's new fields joined through its old uuid to the re-keyed
 * row, then each filled field row by row by the key the relation had.
 */
const dataStepOf = (h: History, m: Model): ReadonlyArray<string> => {
	const before = m.installed
	const after = m.pending
	const rekeys = deltasOf(m, "re-key")
	const own = Arr.flatMap(rekeys, (d) => {
		const facts = nth(m.facts, d.rel, "facts")
		if (!Arr.isReadonlyArrayNonEmpty(facts)) {
			return []
		}
		const rows = Arr.map(facts, (f) => [
			uuidLiteral(uuidOf(d.rel, f.serial)),
			...keyLiterals(after, d.rel, f.serial)
		])
		const fields = keyFields(d.key)
		return [
			`UPDATE ${tableOf(h, d.rel)} AS "t" SET ${Arr.join(
				Arr.map(fields, (k, i) => `${column(k)} = "m"."k${i}"`),
				", "
			)} FROM ${valuesOf(rows)} AS "m" ("old", ${Arr.join(
				Arr.map(fields, (_, i) => `"k${i}"`),
				", "
			)}) WHERE "t".${column("id")} = "m"."old";`
		]
	})
	const pointing = Arr.flatMap(rekeys, (d) =>
		Arr.flatMap(d.key.kind === "compound" ? referencersOf(before, d.rel) : [], (s) =>
			nth(m.facts, s, "facts").length === 0
				? []
				: [
						`UPDATE ${tableOf(h, s)} AS "t" SET ${column(`p${d.rel}a`)} = "r".${column("ka")}, ${column(`p${d.rel}b`)} = "r".${column("kb")}, ${column(`p${d.rel}c`)} = "r".${column("kc")} FROM ${tableOf(h, d.rel)} AS "r" WHERE "t".${column(`p${d.rel}`)} = "r".${column("id")};`
					]
		)
	)
	const filled = Arr.flatMap(deltasOf(m, "data-step field"), (d) => {
		const facts = nth(m.facts, d.rel, "facts")
		if (!Arr.isReadonlyArrayNonEmpty(facts)) {
			return []
		}
		const keys = keyFields(nth(before.rels, d.rel, "relation").key)
		const k = nth(before.rels, d.rel, "relation").filled
		const rows = Arr.map(facts, (f) => [
			...keyLiterals(before, d.rel, f.serial),
			`${filledOf(f.serial, k)}::"pg_catalog"."int4"`
		])
		const names = Arr.map(indices(keys.length), (i) => `"k${i}"`)
		return [
			`UPDATE ${tableOf(h, d.rel)} AS "t" SET ${column(`y${k}`)} = "m"."v" FROM ${valuesOf(rows)} AS "m" (${Arr.join(names, ", ")}, "v") WHERE ${Arr.join(
				Arr.map(keys, (key, i) => `"t".${column(key)} = "m"."k${i}"`),
				" AND "
			)};`
		]
	})
	return [...own, ...pointing, ...filled]
}

/** The statement the draft makes every data step follow (the slot structure.immediate), as it spells it. */
const immediate = "SET CONSTRAINTS ALL IMMEDIATE;"

/**
 * A drafted folder with the data step where the placeholder marker says it goes: right after the draft's own
 * `SET CONSTRAINTS ALL IMMEDIATE;`, which follows every table's alteration and every new column's DROP DEFAULT and comes
 * before every set-aside column's fill, the backfill and the constraints that read what the data step writes. A data
 * step the draft gives no such place to is a failure of the property.
 */
const withDataStep = (g: GenerateResult, step: ReadonlyArray<string>): GenerateResult => {
	if (step.length === 0) {
		return g
	}
	const at = (text: string): Option.Option<number> =>
		Arr.findFirstIndex(Str.split(text, "\n"), (l) => Str.trim(l) === immediate)
	assert.ok(
		Arr.some(g.folder.files, (f) => Option.isSome(at(f.text))),
		`the draft ${g.folder.name} drafts no ${immediate} for its data step to follow`
	)
	const files = Arr.map(g.folder.files, (f) =>
		Option.match(at(f.text), {
			onNone: () => f,
			onSome: (end) => {
				const lines = Str.split(f.text, "\n")
				return {
					...f,
					text: Arr.join([...lines.slice(0, end + 1), "", ...step, ...lines.slice(end + 1)], "\n")
				}
			}
		})
	)
	return { ...g, folder: { ...g.folder, files } }
}

/** What `grizzle check` finds in a reviewed folder's files: an undecided loss, a marker left, a statement that controls
 * the transaction. */
const fileFindings = (
	g: GenerateResult,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadonlyArray<string> => [
	...Arr.map(readsBack(g, files), (fault) => Formatter.format(fault)),
	...Arr.flatMap(files, (f) => [
		...Arr.map(findMarkers(f.text), (marker) => `${f.name}:${marker.line}: ${marker.kind} left`),
		...Arr.flatMap(splitStatements(f.text), (statement, i) =>
			Option.match(Option.fromUndefinedOr(transactionControl(statement)), {
				onNone: () => [],
				onSome: (control) => [`${f.name}: statement ${i + 1} is ${control}`]
			})
		)
	])
]

/** Every relation's rows as PostgreSQL holds them, each field as text, against the model's, as multisets. */
const sameRows = (h: History, w: World, facts: Facts, what: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const byRow = Order.mapInput(Order.String, (row: ReadonlyArray<string>) =>
			Arr.join(row, "\u0000")
		)
		for (const r of indices(w.rels.length)) {
			const fields = visibleFields(w, r)
			const read = yield* substrate.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `${column(f)}::"pg_catalog"."text"`),
					", "
				)} FROM ${tableOf(h, r)}`,
				[]
			)
			const actual: ReadonlyArray<ReadonlyArray<string>> = Arr.sort(
				Arr.map(read, (row) =>
					Arr.map(row, (cell) => (typeof cell === "string" ? cell : Formatter.format(cell)))
				),
				byRow
			)
			const expected: ReadonlyArray<ReadonlyArray<string>> = Arr.sort(
				Arr.map(nth(facts, r, "facts"), (f) => expectedRow(w, facts, r, f)),
				byRow
			)
			assert.deepEqual(
				actual,
				expected,
				`${what}: ${relName(r)} (${Arr.join(fields, ", ")}) holds the model's rows`
			)
		}
	})

/** Writes a batch through the installed version's served login: one ChangeSet inserting every relation's new facts at
 * the top, ordered members nested under their owners; it must be accepted. */
const write = (h: History, w: World, all: Facts, batch: Facts) =>
	Effect.gen(function* () {
		const inserts = insertsOf(w, all, batch)
		if (!Arr.isReadonlyArrayNonEmpty(inserts)) {
			return
		}
		const built = builtOf(w, h.declared)
		const changes = Arr.reduce(inserts, changeSetOver.empty(built.value), (cs, [r, rows]) =>
			cs.insert(built.relation(r), rows)
		)
		const facts = {
			insert: Rec.fromEntries(Arr.map(inserts, ([r, rows]) => [relName(r), rows] as const))
		}
		const outcome = yield* withServedDb(h.installed, built.world.server.roles.app, {}, (db) =>
			Effect.flatMap(db.serve({ write: changes }), (ops) =>
				appliedWith(member(ops, "write"), facts, {})
			)
		)
		assert.equal(
			outcome.kind,
			"accepted",
			`step ${h.steps}: the batch's write is not accepted: ${Formatter.format(outcome)}`
		)
	})

/** What a migration reaches, noted as features: by its deltas, over the facts stored when it ran. */
const noteMigration = (m: Model, note: (f: Feature) => void): void => {
	const rekeys = deltasOf(m, "re-key")
	const rekeyed = Arr.map(rekeys, (d) => d.rel)
	const holds = (r: number) => nth(m.facts, r, "facts").length > 0
	if (rekeys.length > 0) {
		note("a relation re-keyed")
	}
	if (rekeys.length > 1) {
		note("several relations re-keyed in one migration")
	}
	if (
		Arr.some(
			rekeys,
			(d) => d.key.kind === "identifier" && Arr.some(referencersOf(m.pending, d.rel), holds)
		)
	) {
		note("a reference re-pointed under its own name")
	}
	for (const r of rekeyed) {
		const referencers = referencersOf(m.pending, r)
		if (referencers.length > 1) {
			note("a re-keyed relation referenced by two relations")
		}
		if (Arr.some(referencers, (s) => rekeyed.includes(s))) {
			note("a re-keyed relation referenced by a re-keyed relation")
		}
		if (Arr.some(ownedBy(m.pending, r), (o) => o.link.kind === "ordered" && holds(o.member))) {
			note("an ordered family's owner re-keyed")
		}
		if (isOrderedMember(nth(m.pending.rels, r, "relation")) && holds(r)) {
			note("an ordered member re-keyed")
		}
	}
	if (
		Arr.some(
			rekeys,
			(d) =>
				(d.key.kind === "compound" ? d.key.widths.near : d.key.near) &&
				Arr.some(nth(m.facts, d.rel, "facts"), (f) => f.serial % 2 === 0)
		)
	) {
		note("a key near BTMaxItemSize admitted")
	}
	const folded = (r: number) =>
		Option.match(familyOf(nth(m.installed.rels, r, "relation")), {
			onNone: () => false,
			onSome: (f) => f.fold
		})
	for (const d of deltasOf(m, "ordered to counted")) {
		note("an ordered family switched to counted")
		if (folded(d.rel)) {
			note("an ordered family with a fold switched to counted")
			note("a dropped position a fold read")
		}
	}
	for (const d of deltasOf(m, "position dropped")) {
		note("an ordered family's position dropped")
		if (folded(d.rel)) {
			note("a dropped position a fold read")
		}
	}
	if (Arr.some(deltasOf(m, "generated in bulk"), (d) => holds(d.rel))) {
		note("stored generated columns added in bulk to stored rows")
	}
	if (Arr.some(deltasOf(m, "data-step field"), (d) => holds(d.rel))) {
		note("a field filled by a data step over stored rows")
	}
	if (
		chainedReKeys(m) &&
		Arr.every(
			["ordered to counted", "position dropped", "generated in bulk", "data-step field"] as const,
			(kind) => deltasOf(m, kind).length > 0
		)
	) {
		note("a version with all six deltas")
	}
}

/**
 * One migration on PostgreSQL: the batch written through the installed version, then the pending version drafted,
 * reviewed with the model's data step, checked, applied under the rewrite observer, and judged: at most one rewrite
 * per table, a fresh install's catalog, the model's rows, and nothing left to generate.
 */
const migration = (
	h: History,
	before: Model,
	after: Model,
	batch: Facts,
	observer: RewriteObserver,
	note: (f: Feature) => void
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* write(h, before.installed, withBatch(before.facts, batch), batch)
			const stored: Model = { ...before, facts: withBatch(before.facts, batch) }
			noteMigration(stored, note)
			h.steps++
			const what = `step ${h.steps}`
			const built = builtOf(after.installed, h.declared)
			const plan = planned(built, h.declared, h.owner)
			const g = succeeded(
				generate({
					previous: h.previous,
					installation: plan.installation,
					name: `step_${h.steps}`,
					timestamp: draftedAt(h.steps),
					workload: noWorkload,
					declared: declarationsOf(stored)
				}),
				`${what} drafts`
			)
			assert.notEqual(g.change, "none", `${what}: the version's deltas draft no change`)
			const expected = placeholdersOf(h, stored)
			const reviewed = review(withDataStep(g, dataStepOf(h, stored)), {
				losses: "written",
				value: (p) =>
					defined(
						expected.get(placeholderKey(p)),
						`${what}: a placeholder of ${printObjectName(p.table)}.${p.column.name}, a field the model does not add`
					)
			})
			assert.deepEqual(
				Arr.sort(
					Arr.flatMap(reviewed.plan, (file) =>
						Arr.flatMap(file.actions, (a) =>
							a.kind === "alteration"
								? Arr.flatMap(a.actions, (sub) =>
										sub.kind === "placeholderColumn"
											? [placeholderKey({ ...sub, table: a.table })]
											: []
									)
								: a.kind === "fill"
									? Arr.map(a.fields, (f) =>
											placeholderKey({
												kind: "placeholderRetype",
												table: a.table,
												column: f.column,
												reason: f.reason
											})
										)
									: []
						)
					),
					Order.String
				),
				Arr.sort([...expected.keys()], Order.String),
				`${what}: the draft asks a value of exactly the caller fields the version adds to stored relations`
			)
			assert.deepEqual(fileFindings(g, reviewed.files), [], `${what}: grizzle check's findings`)
			h.folders.push({ name: g.folder.name, metaText: g.folder.metaText, files: reviewed.files })
			const m = yield* openMigrator(substrate, h.installed.ambientOwner.credentials)
			const { rewrites } = yield* observer.during(
				h.schema,
				apply(
					m,
					{ snapshot: g.snapshot, folders: [...h.folders] },
					checkedAdmission(plan.installation, substrate.admin)
				)
			)
			for (const [table, times] of rewrites) {
				assert.ok(times <= 1, `${what}: the migration rewrites ${table} ${times} times`)
			}
			h.previous = fromSnapshot(g.snapshot)
			h.installed = {
				...h.installed,
				installation: plan.installation,
				plan,
				names: plan.installation.names,
				folders: nonEmpty(h.folders, "a history's folders"),
				snapshot: g.snapshot
			}
			const again = succeeded(
				generate({
					previous: h.previous,
					installation: plan.installation,
					name: `step_${h.steps}_again`,
					timestamp: draftedAt(h.steps),
					workload: noWorkload,
					declared: noDeclarations
				}),
				`${what} drafts again`
			)
			assert.equal(again.change, "none", `${what}: the version drafts a further change`)
			const fresh = yield* substrate.schema({ create: false, label: "cutover_fresh" })
			const freshPlan = planned(built, fresh, h.owner)
			yield* transaction(substrate.admin, filledSql(freshPlan.drafted, substrate.database))
			yield* sameCatalog(plan.installation, freshPlan.installation, what)
			yield* sameRows(h, after.installed, after.facts, what)
		})
	)

/** A re-key past the limit: the draft of the pending version with it is refused as UnrepresentableKey over the
 * relation's two texts, as its own key holds them or a reference to it does, and nothing is applied. */
const pastLimit = (h: History, before: Model, p: Params["re-key a relation past BTMaxItemSize"]) =>
	Effect.sync(() => {
		const world = withRel(before.pending, p.rel, (rel) => ({
			...rel,
			key: { kind: "compound", widths: p.widths }
		}))
		const built = builtOf(world, h.declared)
		const owned = ownedInput(built.value)
		const plan = owned.ok
			? planRealInstall(built.value, {
					installation: identity.schema(parsedSchemaName(h.declared)),
					owner: h.owner,
					logins: [built.world.server],
					extensions: [],
					codes: firstCodebook(rostersOf(owned.value)),
					compile: compileInstallation
				})
			: owned
		if (plan.ok) {
			return took
		}
		const reason = plan.error.reason
		assert.ok(
			reason._tag === "UnrepresentableKey" &&
				((reason.key.includes("ka") && reason.key.includes("kb")) ||
					(reason.key.includes(`p${p.rel}a`) && reason.key.includes(`p${p.rel}b`))),
			`a re-key of ${relName(p.rel)} past the limit is refused otherwise: ${plan.error.message}`
		)
		return refused<"UnrepresentableKey">("UnrepresentableKey")
	})

const real = (
	h: History,
	observer: RewriteObserver,
	note: (f: Feature) => void
): Real<
	Model,
	Params,
	"UnrepresentableKey",
	Effect.Error<ReturnType<typeof migration>>,
	Substrate
> => {
	const modelOnly = () => Effect.succeed(took)
	return {
		"re-key a relation": modelOnly,
		"re-key a relation to an identifier its references keep their names over": modelOnly,
		"re-key a relation past BTMaxItemSize": (p, before) =>
			Effect.tap(pastLimit(h, before, p), (answer) =>
				Effect.sync(() => {
					if (answer.kind === "refused") {
						note("a key past BTMaxItemSize refused")
					}
				})
			),
		"switch an ordered family to counted": modelOnly,
		"drop an ordered family's position": modelOnly,
		"add stored generated columns in bulk": modelOnly,
		"add a field filled by a data step": modelOnly,
		migrate: (p, before, after) =>
			Effect.as(migration(h, before, after, p.batch, observer, note), took)
	}
}

/** A case: the first version installed through its first migration, then the program's steps against the model. */
const history = (c: Cutover, note: (f: Feature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const declared = yield* substrate.schema({ create: false, label: "cutover" })
			const schemaIdent = identifierOf(identity.schema(parsedSchemaName(declared)))
			const owner = substrate.owner.role
			const observer = yield* rewriteObserver(substrate)
			const ambient = yield* ambientOwner(ordinarySession, [schemaIdent])
			const m = yield* openMigrator(substrate, ambient.credentials)
			const built = builtOf(c.world, declared)
			const plan = planned(built, declared, owner)
			const first = succeeded(
				generate({
					previous: fromEmpty,
					installation: plan.installation,
					name: "step_0",
					timestamp: draftedAt(0),
					workload: noWorkload,
					declared: noDeclarations
				}),
				"the first version"
			)
			const folder: FolderSource = {
				name: first.folder.name,
				metaText: first.folder.metaText,
				files: first.folder.files
			}
			yield* apply(
				m,
				{ snapshot: first.snapshot, folders: [folder] },
				checkedAdmission(plan.installation, substrate.admin)
			)
			const installed = yield* installedOf({
				plan,
				declared,
				folders: [folder],
				snapshot: first.snapshot,
				ambientOwner: ambient
			})
			const h: History = {
				declared,
				schema: schemaIdent,
				owner,
				folders: [folder],
				previous: fromSnapshot(first.snapshot),
				installed,
				steps: 0
			}
			yield* runProgram(machineOf(initialModel(c.world), false), real(h, observer, note), c.steps)
		})
	)

/** One old document's tree: its parents as the testing library draws them and each node's kind. */
interface OldDocument {
	readonly parents: ReadonlyArray<number>
	readonly kinds: ReadonlyArray<number>
}

/**
 * A tree case: the old-form forest, one tree per document, and the new root each document maps onto, which the data step
 * fills: each document its own, or two documents onto one, which no keyed tree holds.
 */
interface TreeCase {
	readonly documents: Arr.NonEmptyReadonlyArray<OldDocument>
	readonly roots: Arr.NonEmptyReadonlyArray<number>
}

/** The widths of the keyed tree's root texts, `package` and `path`. */
const rootWidth = 40

const oldDocumentGen: Gen<OldDocument> = (source) => {
	const parents = source.draw(parentsGen({ min: 1, max: 6 }))
	return { parents, kinds: Arr.map(indices(parents.length + 1), () => source.draw(int(0, 3))) }
}

/** One to three documents, each mapped to its own new root, or, as a named case at a weight of its own, the second
 * mapped onto the first's root. */
const treeCaseGen: Gen<TreeCase> = (source) => {
	const documents = source.draw(arrayGen(oldDocumentGen, { min: 1, max: 3 }))
	const own = Arr.map(documents, (_, d) => d)
	const merged = documents.length > 1 && source.draw(int(0, 3)) === 0
	return {
		documents: nonEmpty(documents, "an old forest's documents"),
		roots: nonEmpty(
			merged ? Arr.map(own, (d) => (d === 1 ? 0 : d)) : own,
			"the new root of each document"
		)
	}
}

/** The shapes of a tree whose depths and levels the parent's backfill numbers (backfill.ts parentUpdate). */
type TreeShape =
	| "a single-node tree"
	| "a chain four levels deep"
	| "three siblings or more under one parent"
	| "one level under two parents"

/** The shapes a tree case aims at. */
const treeShapes: ReadonlyArray<TreeShape> = [
	"a single-node tree",
	"a chain four levels deep",
	"three siblings or more under one parent",
	"one level under two parents"
]

/** Each node's depth in a tree of `parents` (treeOfParents's numbering), the root's 0. */
const depthsOf = (parents: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.reduce(parents, [0], (depths: ReadonlyArray<number>, p) => [
		...depths,
		nth(depths, p, "a parent numbered before its child") + 1
	])

/** The shapes a tree of `parents` has. */
const shapesOf = (parents: ReadonlyArray<number>): ReadonlyArray<TreeShape> => {
	const depths = depthsOf(parents)
	const has: Readonly<Record<TreeShape, boolean>> = {
		"a single-node tree": parents.length === 0,
		"a chain four levels deep": Arr.some(depths, (d) => d >= 3),
		"three siblings or more under one parent": Arr.some(
			depths,
			(_, p) => Arr.filter(parents, (q) => q === p).length >= 3
		),
		"one level under two parents": Arr.some(parents, (p, i) =>
			Arr.some(parents, (q, j) => p !== q && depths[i + 1] === depths[j + 1])
		)
	}
	return Arr.filter(treeShapes, (shape) => has[shape])
}

/** A document of `shape` by construction, its kinds drawn: one node; a chain of four to six; a root over three to five
 * children; or a root over two children, each over at least one of the further nodes, so one level holds nodes of two
 * parents. */
const shapedDocumentGen =
	(shape: TreeShape): Gen<OldDocument> =>
	(source) => {
		const parents = ((): ReadonlyArray<number> => {
			switch (shape) {
				case "a single-node tree":
					return []
				case "a chain four levels deep":
					return indices(source.draw(int(3, 5)))
				case "three siblings or more under one parent":
					return Arr.map(indices(source.draw(int(3, 5))), () => 0)
				case "one level under two parents":
					return [
						0,
						0,
						1,
						2,
						...Arr.map(indices(source.draw(int(0, 2))), () => source.draw(int(1, 2)))
					]
			}
		})()
		return { parents, kinds: Arr.map(indices(parents.length + 1), () => source.draw(int(0, 3))) }
	}

/** A tree case aimed at what is pending: a document of each pending shape and, where several trees or a merge are
 * pending, a drawn document beside them; the second document mapped onto the first's root only where a merge is pending
 * and no shape is, since a merge is refused before its rows are read. */
const steeredTreeGen =
	(pending: ReadonlySet<TreeFeature>): Gen<TreeCase> =>
	(source) => {
		const shapes = Arr.filter(treeShapes, (shape) => pending.has(shape))
		const merge = shapes.length === 0 && pending.has("two old trees mapped onto one root, refused")
		const shaped = Arr.map(shapes, (shape) => source.draw(shapedDocumentGen(shape)))
		const documents =
			shaped.length === 0 ||
			merge ||
			(shaped.length === 1 && pending.has("several old trees, each its own root"))
				? [...shaped, source.draw(oldDocumentGen), source.draw(oldDocumentGen)]
				: shaped
		const own = Arr.map(documents, (_, d) => d)
		return {
			documents: nonEmpty(documents, "an old forest's documents"),
			roots: nonEmpty(
				merge ? Arr.map(own, (d) => (d === 1 ? 0 : d)) : own,
				"the new root of each document"
			)
		}
	}

/** Whether a case maps two documents onto one new root. */
const mergesTrees = (c: TreeCase): boolean => new Set(c.roots).size < c.roots.length

/** A document's old tree in pre-order (families/tree.ts numbered), under its document's index as its root value. */
const oldRows = (d: number, doc: OldDocument): ReadonlyArray<KeyedRow> =>
	numbered([{ root: [String(d)], tree: treeOfParents(doc.parents, doc.kinds) }])

/** The uuid of an old document, and of the node at `start` in it. */
const documentId = (d: number): string => uuidOf(3, d + 1)
const nodeId = (d: number, start: number): string => uuidOf(2, d * 1000 + start + 1)

/** A new root's package and path, each its texts. */
const packageOf = (root: number): string => `package-${root}`
const pathOf = (root: number): string => `path/${root}.xml`

/**
 * The old tree's rows as a direct writer inserts them at SERIALIZABLE, every drawn value stated as the old form's laws
 * fix it: a root its own parent at slot 0, ‹n› the parent's count (a root's own), ‹ps› the parent's start (a root's,
 * 0), the parent's kind (a root's own), and the count fold over each node's children: `before` its slot, `after` one
 * more, `total` its count.
 */
const oldInsert = (tree: OldFormTree, c: TreeCase): string => {
	const fields = [
		"id",
		"doc",
		"parent",
		"at",
		"children",
		"start",
		"end",
		"kind",
		"parentKind",
		"before",
		"after",
		"total"
	]
	const rows = Arr.flatMap(c.documents, (doc, d) =>
		Arr.map(oldRows(d, doc), (row) =>
			Arr.join(
				[
					uuidLiteral(nodeId(d, row.start)),
					uuidLiteral(documentId(d)),
					uuidLiteral(nodeId(d, row.parent)),
					int8Literal(String(row.at)),
					int8Literal(String(row.children)),
					int8Literal(String(row.start)),
					int8Literal(String(row.end)),
					`${row.kind}::"pg_catalog"."int4"`,
					`${row.parentKind}::"pg_catalog"."int4"`,
					int8Literal(String(row.at)),
					int8Literal(String(row.at + 1)),
					int8Literal(String(row.children)),
					int8Literal(String(row.copy)),
					int8Literal(String(row.parent))
				],
				", "
			)
		)
	)
	return `INSERT INTO ${q(tree.snapshot.schema)}.${q(tree.columns.table)} (${Arr.join(
		[...Arr.map(fields, column), q(tree.columns.copy), q(tree.columns.parentStart)],
		", "
	)}) VALUES ${Arr.join(
		Arr.map(rows, (row) => `(${row})`),
		", "
	)}`
}

/**
 * The keyed tree the old one becomes: rooted at (package, path), keyed by them and its start, its count fold kept, and
 * pantry's Node's shape over its parent copies (edullm's identity migration): its parent's kind copied along the parent
 * axis, as the old tree copied it, now under the keyed tree's law, so the migration draws it anew, and its grandparent's
 * kind, the parent's own copy, both the root's own; and a count fold over each node's children whose selection reads
 * both copies, the children whose parent's kind is not their grandparent's (`turns`, its planes named), which the
 * migration draws after the copies it reads. And pantry's Instance's shape (tests.ts, `children` held to its
 * TestDocument's `sites`): a second family over Node, counted by the node each names as its `anchor` (`uses`), whose
 * owner axis carries the tree's own count, `children`, from the anchor's `sites`, so one migration draws `children` as
 * the tree's count beside that family's axis.
 */
const keyedTreeOf = () => {
	const Node = relation(
		"Node",
		{
			package: textField(rootWidth),
			path: textField(rootWidth),
			parent: drawnField(natural),
			at: drawnField(natural),
			children: drawnField(natural),
			start: drawnField(natural),
			end: drawnField(natural),
			kind: pg.integer,
			parentKind: accumulated(pg.integer, 0),
			parentParentKind: accumulated(pg.integer, 0),
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n),
			total: accumulated(natural, 0n),
			turnsBefore: accumulated(natural, 0n),
			turnsAfter: accumulated(natural, 0n),
			turns: accumulated(natural, 0n),
			anchor: natural,
			sites: natural,
			uses: drawnField(natural)
		},
		["package", "path", "start"],
		[]
	)
	const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: ["package", "path"]
	})
	return schema("OldTree", { Node }, [
		nodes,
		foldBuilder(
			nodes,
			monoids.count,
			onBuilder(Node, ["package", "path", "parent", "before", "after"]),
			onBuilder(Node, ["package", "path", "start", "total"])
		),
		containedBuilder(
			onBuilder(
				select(Node, (n) => n.gt(n.start, 0n)),
				["package", "path", "parent", "parentKind", "parentParentKind"]
			),
			onBuilder(Node, ["package", "path", "start", "kind", "parentKind"])
		),
		foldBuilder(
			nodes,
			monoids.count,
			onBuilder(
				select(Node, (n) => n.and(n.gt(n.start, 0n), n.ne(n.parentKind, n.parentParentKind))),
				["package", "path", "parent", "turnsBefore", "turnsAfter"]
			),
			onBuilder(Node, ["package", "path", "start", "turns"])
		),
		countedBuilder(onBuilder(Node, ["package", "path", "anchor"]), finBuilder(Node, "uses")),
		containedBuilder(
			onBuilder(Node, ["package", "path", "anchor", "children"]),
			onBuilder(Node, ["package", "path", "start", "sites"])
		)
	])
}

/** The keyed tree's visible fields, in the order the model states them. */
const keyedFields = [
	"package",
	"path",
	"start",
	"parent",
	"at",
	"children",
	"end",
	"kind",
	"parentKind",
	"parentParentKind",
	"before",
	"after",
	"total",
	"turnsBefore",
	"turnsAfter",
	"turns",
	"anchor",
	"sites",
	"uses"
] as const

/**
 * The copies and the turns fold of one document's rows, read off the direct pre-order numbering alone: each row's
 * grandparent's kind its parent's own parentKind (a root's own), whether the turns fold selects it (a member whose
 * parent's kind is not its grandparent's), and its planes, the selected siblings before it and through it in slot
 * order, the root alone at slot 0, its end its selected children.
 */
const turnsOf = (rows: ReadonlyArray<KeyedRow>) => {
	const parentOf = (row: KeyedRow): KeyedRow =>
		defined(
			Option.getOrUndefined(Arr.findFirst(rows, (r) => r.start === row.parent)),
			`the parent of the node at ${row.start}`
		)
	const parentParentKind = (row: KeyedRow): number => parentOf(row).parentKind
	const selected = (row: KeyedRow): boolean =>
		row.start > 0 && row.parentKind !== parentParentKind(row)
	const siblings = (row: KeyedRow): ReadonlyArray<KeyedRow> =>
		row.start === 0 ? [row] : Arr.filter(rows, (r) => r.start > 0 && r.parent === row.parent)
	const selectedThrough = (row: KeyedRow, through: boolean): number =>
		Arr.filter(siblings(row), (r) => selected(r) && (through ? r.at <= row.at : r.at < row.at))
			.length
	return {
		parentParentKind,
		selected,
		before: (row: KeyedRow): number => selectedThrough(row, false),
		after: (row: KeyedRow): number => selectedThrough(row, true),
		end: (row: KeyedRow): number =>
			Arr.filter(rows, (r) => r.start > 0 && r.parent === row.start && selected(r)).length
	}
}

/**
 * The anchor family of one document's rows: each row's anchor, the start of the first row in pre-order whose count is
 * its own, so its `sites` (each row's own count) is the row's count, and each row's `uses`, the rows anchored at it.
 */
const anchorsOf = (rows: ReadonlyArray<KeyedRow>) => {
	const anchor = (row: KeyedRow): number =>
		defined(
			Option.getOrUndefined(Arr.findFirst(rows, (r) => r.children === row.children)),
			`a row of ${row.children} children`
		).start
	return {
		anchor,
		uses: (row: KeyedRow): number => Arr.filter(rows, (r) => anchor(r) === row.start).length
	}
}

/** The model's rows of the keyed tree: each old row under its document's new root, its parent the old parent's start,
 * every slot, count, interval, kind and count fold value as the old tree held it, its copies and turns fold as the
 * direct numbering states them (turnsOf), and its anchor, its sites (its own count) and its uses (anchorsOf). */
const keyedRows = (c: TreeCase): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.flatMap(c.documents, (doc, d) => {
		const root = nth(c.roots, d, "a document's new root")
		const rows = oldRows(d, doc)
		const turns = turnsOf(rows)
		const anchors = anchorsOf(rows)
		return Arr.map(rows, (row) =>
			Arr.map(
				[
					packageOf(root),
					pathOf(root),
					row.start,
					row.parent,
					row.at,
					row.children,
					row.end,
					row.kind,
					row.parentKind,
					turns.parentParentKind(row),
					row.at,
					row.at + 1,
					row.children,
					turns.before(row),
					turns.after(row),
					turns.end(row),
					anchors.anchor(row),
					row.children,
					anchors.uses(row)
				],
				String
			)
		)
	})

/** Whether a case's turns fold selects a member: a node whose parent's kind is not its grandparent's. */
const turnsSelect = (c: TreeCase): boolean =>
	Arr.some(c.documents, (doc, d) => {
		const rows = oldRows(d, doc)
		return Arr.some(rows, turnsOf(rows).selected)
	})

/** The value each placeholder of the keyed tree's new caller fields takes until the data step writes it: the empty text
 * of a root text, 0 of the naturals `anchor` and `sites`. */
const treePlaceholder = (p: Placeholder): string =>
	Arr.some(
		["anchor", "sites"],
		(f) => p.column.name === identifierOf(identity.column(parsedName(f)))
	)
		? "0"
		: "''"

/** Whether a case's anchor family carries some node's count from another node's `sites`. */
const anchorsElsewhere = (c: TreeCase): boolean =>
	Arr.some(c.documents, (doc, d) => {
		const rows = oldRows(d, doc)
		const { anchor } = anchorsOf(rows)
		return Arr.some(rows, (row) => anchor(row) !== row.start)
	})

/** The data step of the tree's migration: each node's new root from its old document's uuid, by the case's map, and
 * each node's anchor and sites from its old id (anchorsOf). */
const treeDataStep = (tree: OldFormTree, c: TreeCase): ReadonlyArray<string> => {
	const table = `${q(tree.snapshot.schema)}.${q(tree.columns.table)}`
	const rows = Arr.map(c.documents, (_, d) => {
		const root = nth(c.roots, d, "a document's new root")
		return [uuidLiteral(documentId(d)), textLiteral(packageOf(root)), textLiteral(pathOf(root))]
	})
	const nodes = Arr.flatMap(c.documents, (doc, d) => {
		const old = oldRows(d, doc)
		const { anchor } = anchorsOf(old)
		return Arr.map(old, (row) => [
			uuidLiteral(nodeId(d, row.start)),
			int8Literal(String(anchor(row))),
			int8Literal(String(row.children))
		])
	})
	return [
		`UPDATE ${table} AS "t" SET ${column("package")} = "m"."k0", ${column("path")} = "m"."k1" FROM ${valuesOf(
			nonEmpty(rows, "the documents' roots")
		)} AS "m" ("old", "k0", "k1") WHERE "t".${column("doc")} = "m"."old";`,
		`UPDATE ${table} AS "t" SET ${column("anchor")} = "m"."a", ${column("sites")} = "m"."s" FROM ${valuesOf(
			nonEmpty(nodes, "the documents' nodes")
		)} AS "m" ("old", "a", "s") WHERE "t".${column("id")} = "m"."old";`
	]
}

type TreeFeature =
	| "an old-form tree keyed by its root and start"
	| "a tree of three levels or more"
	| "several old trees, each its own root"
	| "two old trees mapped onto one root, refused"
	| "a fold over copies along the parent, one hop and two, selecting a member"
	| "a tree's count carried along another family's owner axis from another node"
	| TreeShape

/** What the tree property must reach. */
const treeFeatures: Arr.NonEmptyReadonlyArray<TreeFeature> = [
	"an old-form tree keyed by its root and start",
	"a tree of three levels or more",
	"several old trees, each its own root",
	"two old trees mapped onto one root, refused",
	"a fold over copies along the parent, one hop and two, selecting a member",
	"a tree's count carried along another family's owner axis from another node",
	...treeShapes
]

/** The laws a refused merge may name: the keyed tree's primary key, its family's and its fold's. */
const treeLaws = (installation: Installation): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(installation.laws.theory.primaryKeys, (pk) =>
			pk.relation.name === "Node" ? [pk.law.id] : []
		),
		...Arr.flatMap(installation.laws.families, (family) => [
			family.law,
			...Arr.map(family.folds, (fold) => fold.law)
		])
	])

/**
 * A tree case on PostgreSQL: the old-form tree installed from its frozen first migration, its rows written directly,
 * then the keyed tree drafted from its snapshot, every old field it no longer holds declared dropped, reviewed with the
 * data step, checked, and applied under the rewrite observer. A merge of two trees onto one root is refused at migrate
 * by a law of the keyed tree; any other case migrates to a fresh install's catalog, rewriting each table at most once,
 * every row the model's and nothing left to generate.
 */
const treeHistory = (c: TreeCase, note: (f: TreeFeature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const tree = oldFormTree()
			const owner = substrate.owner.role
			yield* Effect.addFinalizer(() =>
				Effect.orDie(
					substrate.admin.query(`DROP SCHEMA IF EXISTS ${q(tree.snapshot.schema)} CASCADE`, [])
				)
			)
			const observer = yield* rewriteObserver(substrate)
			const m = yield* openMigrator(substrate, substrate.owner)
			yield* apply(m, { snapshot: tree.snapshot, folders: [tree.folder] }, noFurther)
			yield* transaction(substrate.admin, [oldInsert(tree, c)])
			note("an old-form tree keyed by its root and start")
			if (Arr.some(c.documents, (doc) => Arr.some(doc.parents, (p) => p > 0))) {
				note("a tree of three levels or more")
			}
			const value = keyedTreeOf()
			const installation = compile(value, asDrafted)
			const g = succeeded(
				generate({
					previous: fromSnapshot(tree.snapshot),
					installation,
					name: "keyed",
					timestamp: draftedAt(1),
					workload: noWorkload,
					declared: {
						renames: [],
						drops: [
							{ kind: "field", relation: parsedName("Node"), field: parsedName("id") },
							{ kind: "field", relation: parsedName("Node"), field: parsedName("doc") }
						]
					}
				}),
				"the keyed tree drafts"
			)
			assert.deepEqual(
				perRowReads(g.plan.steps),
				[],
				"the keyed tree's backfill reads no row once per row"
			)
			const reviewed = review(withDataStep(g, treeDataStep(tree, c)), {
				losses: "written",
				value: treePlaceholder
			})
			assert.deepEqual(fileFindings(g, reviewed.files), [], "grizzle check's findings")
			const folders: ReadonlyArray<FolderSource> = [
				tree.folder,
				{ name: g.folder.name, metaText: g.folder.metaText, files: reviewed.files }
			]
			const run = observer.during(
				tree.snapshot.schema,
				apply(
					m,
					{ snapshot: g.snapshot, folders: [...folders] },
					checkedAdmission(installation, substrate.admin)
				)
			)
			if (mergesTrees(c)) {
				const laws = treeLaws(installation)
				const { reason } = yield* refusal(run)
				assert.ok(
					(reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused") &&
						reason.law !== undefined &&
						laws.has(reason.law),
					`two old trees mapped onto one root are refused otherwise than by a law of the keyed tree: ${Formatter.format(reason)}`
				)
				note("two old trees mapped onto one root, refused")
				return
			}
			if (c.documents.length > 1) {
				note("several old trees, each its own root")
			}
			const { rewrites } = yield* run
			for (const [table, times] of rewrites) {
				assert.ok(times <= 1, `the keyed tree's migration rewrites ${table} ${times} times`)
			}
			const fresh = yield* substrate.schema({ create: false, label: "cutover_tree_fresh" })
			const freshPlan = succeeded(
				planRealInstall(value, {
					installation: identity.schema(parsedSchemaName(fresh)),
					owner,
					logins: [],
					extensions: [],
					codes: firstCodebook(rostersOf(owning(value))),
					compile: compileInstallation
				}),
				"a fresh install of the keyed tree"
			)
			yield* transaction(substrate.admin, filledSql(freshPlan.drafted, substrate.database))
			yield* sameCatalog(installation, freshPlan.installation, "the keyed tree")
			const read = yield* substrate.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(keyedFields, (f) => `${column(f)}::"pg_catalog"."text"`),
					", "
				)} FROM ${q(tree.snapshot.schema)}.${q(tree.columns.table)}`,
				[]
			)
			const byRow = Order.mapInput(Order.String, (row: ReadonlyArray<string>) =>
				Arr.join(row, "\u0000")
			)
			const actual: ReadonlyArray<ReadonlyArray<string>> = Arr.sort(
				Arr.map(read, (row) =>
					Arr.map(row, (cell) => (typeof cell === "string" ? cell : Formatter.format(cell)))
				),
				byRow
			)
			assert.deepEqual(
				actual,
				Arr.sort(keyedRows(c), byRow),
				`the keyed tree holds the model's rows (${Arr.join(keyedFields, ", ")})`
			)
			if (turnsSelect(c)) {
				note("a fold over copies along the parent, one hop and two, selecting a member")
			}
			if (anchorsElsewhere(c)) {
				note("a tree's count carried along another family's owner axis from another node")
			}
			for (const doc of c.documents) {
				for (const shape of shapesOf(doc.parents)) {
					note(shape)
				}
			}
			const again = succeeded(
				generate({
					previous: fromSnapshot(g.snapshot),
					installation,
					name: "keyed_again",
					timestamp: draftedAt(2),
					workload: noWorkload,
					declared: noDeclarations
				}),
				"the keyed tree drafts again"
			)
			assert.equal(again.change, "none", "the keyed tree drafts a further change")
		})
	)

layer(Substrate.isolatedLayer)("the migrator under the identity cutover's deltas", (it) => {
	it.effect(
		"every migration of a cutover history rewrites each table at most once, reaches a fresh install's catalog, keeps every fact through the model's key mapping and leaves nothing to generate, and a key past BTMaxItemSize is refused by the draft",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the world model and its key mapping, judged by PostgreSQL's rows, a fresh install's catalog and its table_rewrite events"
						},
						suite: "pg/migrate/cutover",
						draw: drawn(cutoverGen),
						literal: Formatter.format,
						coverage: required<Feature>(features, { cases: 32, sense: notesOnly }),
						kept: [],
						runs: 3,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(drawnCase, c: Case<Feature>) =>
						history(
							Option.match(c.steering, {
								onNone: () => drawnCase,
								onSome: (pending) =>
									c.draw(steeredGen(new Set(Arr.filter(features, (f) => pending.has(f)))))
							}),
							(f) => c.note(f)
						)
				)
			)
	)
	it.effect(
		"an old-form tree becomes the keyed tree: every parent the old parent's start, every slot, interval and fold value kept, at a fresh install's catalog with each table rewritten at most once, and two trees mapped onto one root refused by a law of the keyed tree",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the direct pre-order numbering of each old tree under its new root, judged by PostgreSQL's rows, a fresh install's catalog and its table_rewrite events"
						},
						suite: "pg/migrate/cutover-tree",
						draw: drawn(treeCaseGen),
						literal: Formatter.format,
						coverage: required<TreeFeature>(treeFeatures, { cases: 16, sense: notesOnly }),
						kept: [],
						runs: 2,
						shrink: { kind: "bounded", candidates: 30 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(drawnCase, k: Case<TreeFeature>) =>
						treeHistory(
							Option.match(k.steering, {
								onNone: () => drawnCase,
								onSome: (pending) =>
									k.draw(steeredTreeGen(new Set(Arr.filter(treeFeatures, (f) => pending.has(f)))))
							}),
							(f) => k.note(f)
						)
				)
			)
	)
})
