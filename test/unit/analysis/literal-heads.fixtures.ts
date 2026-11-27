/** What the property of literal-heads.test.ts reads: its uses of a literal-headed column, and each one's installation. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import type { CompileError } from "#compiler/core/errors.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, login, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import type { RelationName } from "#compiler/types/schema/relation.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { frontendOptions } from "#test/support/compile.ts"
import { checking, owning } from "#test/support/policy.ts"
import { cs, descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * Where a column a rule's head fixes at a literal is read after navigation substitutes the literal for it: a selection
 * comparing it first with a literal, by `<` or `<>`; a selection equating it with a column of its own type; a join of
 * it to a stored relation's column; or a check over the derived relation comparing it first.
 */
export const uses = [
	"a selection by lt against a literal",
	"a selection by ne against a literal",
	"a selection by eq against a column",
	"a join to a stored relation",
	"a check comparing it first",
	"a union's literal compared with a natural column",
	"a check over a union's literal",
	"a write member's query over a union's literal",
	"a union's literal beside a channel-bound recursive import",
	"a union selected at its literal beside a channel-bound recursive import"
] as const
export type Use = (typeof uses)[number]

/** The uses that read the union `scoped`. */
type UnionUse = Extract<
	Use,
	"a union's literal compared with a natural column" | "a check over a union's literal"
>

/** The use a write member makes of the union `scoped`. */
type WriteUse = Extract<Use, "a write member's query over a union's literal">

/** The use whose union a whole rule's walk binds to its unit's channels. */
type WalkUse = Extract<
	Use,
	| "a union's literal beside a channel-bound recursive import"
	| "a union selected at its literal beside a channel-bound recursive import"
>

/** The uses that read the one-rule query `fixed`. */
type PlainUse = Exclude<Use, UnionUse | WriteUse | WalkUse>

const label = str.bytes(64, str.regex("^.*$", "su"))

const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["id"])

const Doc = relation("Doc", { id: pg.integer, start: pg.bigint, label }, ["id"])

/** A node of a document: its start, natural, as pantry's Node.start is. */
const Node = relation("Node", { id: pg.integer, start: natural }, ["id"])

const Base = schema("LiteralHeads", [Item, Doc, Node], [])

/**
 * A union whose heading types `scope` natural: one rule fixes it at the literal 0n, the other reads Node.start, as
 * pantry's testReadingRows does with its unsplit and split readings.
 */
const scoped = query(Base)
	.rule((r) => {
		const { id } = v(Item, "item")
		return r.match(Item, { id }).find({ id, scope: 0n })
	})
	.rule((r) => {
		const { id, start } = v(Node, "node")
		return r.match(Node, { id, start }).find({ id, scope: start })
	})

/** A query whose one rule fixes `scope` at the literal 0n and `variable` at the literal "numAttempts". */
const fixed = query(Base).rule((r) => {
	const { id, kind } = v(Item, "item")
	return r.match(Item, { id, kind }).find({ id, scope: 0n, kind, variable: "numAttempts" })
})

/** The derived relation over `fixed` and Doc that reads `fixed`'s literal-headed columns as `use` reads them. */
const readOf = (use: PlainUse) =>
	derived(
		"Read",
		query(Base).rule((r) => {
			const { id, scope, kind, variable } = v(fixed, "fixed")
			const { start, label: text } = v(Doc, "doc")
			const read = r.match(fixed, { id, scope, kind, variable })
			const joined = use === "a join to a stored relation"
			const bound = joined
				? read.match(Doc, { id, start: scope, label: text })
				: read.match(Doc, { id, start, label: text })
			const selected = (() => {
				switch (use) {
					case "a selection by lt against a literal":
						return bound.where(r.lt(scope, 5n))
					case "a selection by ne against a literal":
						return bound.where(r.ne(scope, 3n))
					case "a selection by eq against a column":
						return bound.where(r.eq(variable, text))
					case "a join to a stored relation":
					case "a check comparing it first":
						return bound
				}
			})()
			return selected.find({ id, start: joined ? scope : start, scope })
		})
	)

/** The derived relation over `scoped` and Node that reads `scoped`'s literal-headed column as `use` does. */
const unionReadOf = (use: UnionUse) =>
	derived(
		"Read",
		query(Base).rule((r) => {
			const { id, scope } = v(scoped, "scoped")
			const { start } = v(Node, "node")
			const read = r.match(scoped, { id, scope }).match(Node, { id, start })
			return (
				use === "a check over a union's literal" ? read : read.where(r.eq(scope, start))
			).find({
				id,
				start,
				scope
			})
		})
	)

/**
 * The installation of the schema over Base whose derived relation reads `fixed` as `use` does, with a containment and
 * a check over it, which a writer of Item and Doc probes, so navigation inlines `fixed` into every probe: compiled, or
 * the refusal it meets.
 */
export const installed = (use: Use): Result.Result<unknown, CompileError> =>
	use === "a union's literal beside a channel-bound recursive import" ||
	use === "a union selected at its literal beside a channel-bound recursive import"
		? installedOverWalk(use)
		: use === "a write member's query over a union's literal"
			? writtenOverUnion()
			: use === "a union's literal compared with a natural column" ||
				  use === "a check over a union's literal"
				? installedOverUnion(use)
				: installedOverQuery(use)

/** Where a write member's rows land: a scope and its node's start. */
const Scoped = relation("Scoped", { id: pg.integer, start: natural }, ["id"])

/** Base with Scoped, which the write member inserts into. */
const Written = schema.extend([Base], "LiteralHeadsWritten", [Scoped], [])

/**
 * A ChangeSet whose member inserts into Scoped the rows `scoped` holds at a node of its start, its query compiled as
 * every write member's is, navigated read by read (write/frontend/compile.ts): `scoped` split into its rules, each
 * matched alone, so the rule fixing `scope` at 0n is read beside Node.start.
 */
const writtenOverUnion = (): Result.Result<unknown, CompileError> =>
	compileChangeSet(
		checking(Written),
		descOf(
			cs(Written).insert(
				Scoped,
				query(Written).rule((r) => {
					const { id, scope } = v(scoped, "scoped")
					const { start } = v(Node, "node")
					return r
						.match(scoped, { id, scope })
						.match(Node, { id, start })
						.where(r.eq(scope, start))
						.find({ id, start })
				})
			)
		),
		frontendOptions(Written)
	)

/** The installation of a use that reads `fixed`. */
const installedOverQuery = (use: PlainUse): Result.Result<unknown, CompileError> => {
	const Read = readOf(use)
	const top = schema.extend(
		[Base],
		"LiteralHeadsTop",
		[Read],
		[
			contained(on(Read, "id"), on(Item, "id")),
			use === "a check comparing it first"
				? check("Small", Read, (x) => x.lt(x.scope, 5n))
				: check("Unseven", Read, (x) => x.ne(x.start, 7n))
		]
	)
	return installedAs(
		login(top, "desk", [
			role(top, "writer", { Item, Doc, Node }, { insert: ["Item", "Doc", "Node"] })
		])
	)
}

/** The installation of a use that reads `scoped`. */
const installedOverUnion = (use: UnionUse): Result.Result<unknown, CompileError> => {
	const Read = unionReadOf(use)
	const top = schema.extend(
		[Base],
		"LiteralHeadsTop",
		[Read],
		[
			contained(on(Read, "id"), on(Item, "id")),
			use === "a check over a union's literal"
				? check("Small", Read, (x) => x.lt(x.scope, 5n))
				: check("Unseven", Read, (x) => x.ne(x.start, 7n))
		]
	)
	return installedAs(
		login(top, "desk", [
			role(top, "writer", { Item, Doc, Node }, { insert: ["Item", "Doc", "Node"] })
		])
	)
}

/** The installation of a login's writer: compiled, or the refusal it meets. */
const installedAs = (desk: {
	readonly base: FixtureSchema
}): Result.Result<unknown, CompileError> => {
	const owned = owning(desk.base)
	return Result.flatMap(
		ownLogin(defined(loginDescOf(desk), "a login built by login(...)")),
		(own) =>
			compileInstallation(
				owned,
				completeInstallOptions(
					owned,
					installationsOf(owned),
					[own],
					[],
					firstCodebook(rostersOf(owned))
				)
			)
	)
}

/** A derived relation reading `fixed`, whose head fixes `scope` at 0n, beside Node by `id`, checked by a check of its own. */
const readerOf = <const Name extends string>(name: RelationName<Name>) =>
	derived(
		name,
		query(Base).rule((r) => {
			const { id, scope } = v(fixed, "fixed")
			const { start } = v(Node, "node")
			return r.match(fixed, { id, scope }).match(Node, { id, start }).find({ id, start, scope })
		})
	)

const Read0 = readerOf("Read0")
const Read1 = readerOf("Read1")
const Read2 = readerOf("Read2")

/**
 * An installation of one or of three derived relations, each reading `fixed` and checked, so a writer of Item and Node
 * probes each reader's check, and navigation inlines `fixed` in each and types its head literal at `fixed`'s heading:
 * compiled, or the refusal it meets.
 */
export const installedReaders = (
	readers: "one reader" | "three readers"
): Result.Result<unknown, CompileError> => {
	if (readers === "one reader") {
		const top = schema.extend(
			[Base],
			"LiteralHeadsOne",
			[Read0],
			[check("Small0", Read0, (x) => x.lt(x.scope, 5n))]
		)
		return installedAs(
			login(top, "desk", [
				role(top, "writer", { Item, Doc, Node }, { insert: ["Item", "Doc", "Node"] })
			])
		)
	}
	const top = schema.extend(
		[Base],
		"LiteralHeadsThree",
		[Read0, Read1, Read2],
		[
			check("Small0", Read0, (x) => x.lt(x.scope, 5n)),
			check("Small1", Read1, (x) => x.lt(x.scope, 5n)),
			check("Small2", Read2, (x) => x.lt(x.scope, 5n))
		]
	)
	return installedAs(
		login(top, "desk", [
			role(top, "writer", { Item, Doc, Node }, { insert: ["Item", "Doc", "Node"] })
		])
	)
}

/** A part of a document at its parent's place, keyed by its document first: the unit a rule over a walk is judged in. */
const Part = relation("Part", { doc: pg.integer, start: pg.integer, parent: pg.integer }, [
	"doc",
	"start"
])

/** A part's level, natural. */
const Level = relation("Level", { doc: pg.integer, start: pg.integer, level: natural }, [
	"doc",
	"start"
])

const Parts = schema("LiteralHeadsParts", [Part, Level], [])

/** Every part a document's root reaches, its document carried through every step: a recursion local to the document. */
const descent = query(Parts).recursive("Descent", {
	row: { doc: pg.integer, part: pg.integer },
	base: [
		(r) => {
			const p = v(Part, "p")
			return r
				.match(Part, { doc: p.doc, start: p.start, parent: p.start })
				.find({ doc: p.doc, part: p.start })
		}
	],
	rec: [
		(r, self) => {
			const s = v(self, "s")
			const p = v(Part, "p")
			return r
				.match(self, { doc: s.doc, part: s.part })
				.match(Part, { doc: s.doc, parent: s.part, start: p.start })
				.find({ doc: s.doc, part: p.start })
		}
	]
})

/**
 * A union whose heading types `level` natural: one rule fixes it at the literal 0n for a document's roots, the other
 * reads Level.level of each part the recursion reaches, as pantry's assembledPartRows does with its instance 0n and its
 * instanceParts (qti/overlay-queries/tests.ts).
 */
const leveled = query(Parts)
	.rule((r) => {
		const p = v(Part, "p")
		return r
			.match(Part, { doc: p.doc, start: p.start, parent: p.start })
			.find({ doc: p.doc, part: p.start, level: 0n })
	})
	.rule((r) => {
		const { doc, part } = v(descent, "descent")
		const { level } = v(Level, "level")
		return r
			.match(descent, { doc, part })
			.match(Level, { doc, start: part, level })
			.find({ doc, part, level })
	})

const Leveled = derived("Leveled", leveled)

/**
 * The parts Leveled holds at level 0n, a document's roots: a selection of the union at the literal its first rule's head
 * fixes, as qti's statements of one required fact select a union at the literal one of its rules fixes. A whole rule's
 * statement over it reads the union's walked copy, which reads the recursion at the document's channels, at the
 * literal, typed at the column it binds (analysis/theory/navigate.ts boundInside), the union's.
 */
const Roots = derived(
	"Roots",
	query(Parts).rule((r) => {
		const { doc, part } = v(leveled, "leveled")
		return r.match(leveled, { doc, part, level: 0n }).find({ doc, part })
	})
)

/**
 * The installation of a check over Leveled or Roots, a whole rule judged per document: its walk reads the recursion at
 * the document's channels, so each query it reads that reads the recursion is a copy that reads them, which only its
 * import types. Over Leveled the statement reads the union's copy whole; over Roots it reads the copy at level 0n and
 * types the literal at the copy's heading, read at the union the copy was walked from (WholeRule `definitionOf`):
 * compiled, or the refusal it meets.
 */
const installedOverWalk = (use: WalkUse): Result.Result<unknown, CompileError> => {
	const writer = { insert: ["Part", "Level"] }
	if (use === "a union's literal beside a channel-bound recursive import") {
		const top = schema.extend(
			[Parts],
			"LiteralHeadsWalked",
			[Leveled],
			[check("Shallow", Leveled, (x) => x.lt(x.level, 5n))]
		)
		return installedAs(login(top, "desk", [role(top, "writer", { Part, Level }, writer)]))
	}
	const top = schema.extend(
		[Parts],
		"LiteralHeadsRoots",
		[Roots],
		[check("Placed", Roots, (x) => x.lt(x.part, 1000))]
	)
	return installedAs(login(top, "desk", [role(top, "writer", { Part, Level }, writer)]))
}
