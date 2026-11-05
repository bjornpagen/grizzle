import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations, Named, Step } from "#compiler/deploy/diff/plan.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import {
	codebookOf,
	codebookUnder,
	emptySnapshot,
	noWorkload
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { draftCodebook, type RosterRenames, reorderRefusal } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { closed, f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/**
 * Declared renames and drops, drafted with no database: every pair of operations (a rename, a drop, an addition) over
 * at most three names, on relations, on the fields of one relation and on a roster's handles, each operation declared
 * or, a named invalid variant, its declaration left out, exhausted.
 *
 * The oracle is a model of declared identities: it applies the operations to the previous names, predicts the target's
 * names, and predicts the verdict, accepted exactly when every name the previous schema holds and the target lacks is
 * declared renamed or dropped, refused otherwise with UndeclaredDrop naming the first such name in the previous
 * snapshot's order. An accepted draft is checked against the model: its snapshot holds exactly the target's names; a
 * declared rename of a relation is a chain of renames in its Setup taking the old table to the target's; a declared
 * drop is drafted, a relation's as its drop; and a renamed handle keeps its code, the codes read back from the
 * snapshot.
 */

/** The names a dimension's operations range over: the box's bound of three. */
const names = ["a", "b", "c"] as const
type Name = (typeof names)[number]

type Dimension = "relation" | "field" | "handle"

/** One operation on the previous names, and whether the draft declares it (a rename's or a drop's; an addition needs
 * none). */
type Operation =
	| { readonly kind: "rename"; readonly from: Name; readonly to: Name; readonly declared: boolean }
	| { readonly kind: "drop"; readonly name: Name; readonly declared: boolean }
	| { readonly kind: "add"; readonly name: Name }

interface Box {
	readonly dimension: Dimension
	readonly operations: ReadonlyArray<Operation>
}

type Feature = `${Dimension} ${Operation["kind"] | Verdict["kind"]}`

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"relation rename",
	"relation drop",
	"relation add",
	"relation accepted",
	"relation undeclared",
	"relation unsupported",
	"field rename",
	"field drop",
	"field add",
	"field accepted",
	"field undeclared",
	"field unsupported",
	"handle rename",
	"handle drop",
	"handle add",
	"handle accepted",
	"handle undeclared",
	"handle unsupported",
	"handle reordered"
]

/** The names each dimension starts from. */
const start: ReadonlyArray<Name> = ["a", "b"]

/** The names after an operation, an identity per name: a rename moves one, a drop ends one, an addition starts one. */
const after = (held: ReadonlyArray<Name>, op: Operation): ReadonlyArray<Name> => {
	switch (op.kind) {
		case "rename":
			return Arr.map(held, (n) => (n === op.from ? op.to : n))
		case "drop":
			return Arr.filter(held, (n) => n !== op.name)
		case "add":
			return [...held, op.name]
	}
}

/** Every operation valid on `held`, by construction: a rename or drop of a held name, a rename or addition to a free
 * one, each declared or not. A roster keeps a handle, so a dimension of handles drops only one of two. */
const operationsOn = (
	dimension: Dimension,
	held: ReadonlyArray<Name>
): Arr.NonEmptyReadonlyArray<Gen<Operation>> => {
	const free = Arr.filter(names, (n) => !Arr.contains(held, n))
	const out: Array<Gen<Operation>> = []
	for (const from of held) {
		for (const to of free) {
			out.push((source) => ({ kind: "rename", from, to, declared: source.draw(boolean) }))
		}
		if (dimension !== "handle" || held.length >= 2) {
			out.push((source) => ({ kind: "drop", name: from, declared: source.draw(boolean) }))
		}
	}
	for (const n of free) {
		out.push(() => ({ kind: "add", name: n }))
	}
	if (!Arr.isReadonlyArrayNonEmpty(out)) {
		return assert.fail("a held name or a free one stands")
	}
	return out
}

/** A box: a dimension and one or two operations, each drawn valid on the names the earlier left. */
const boxGen: Gen<Box> = (source) => {
	const dimension = source.draw(element(["relation", "field", "handle"] as const))
	const first = source.draw(source.draw(element(operationsOn(dimension, start))))
	const more = source.draw(boolean)
	if (!more) {
		return { dimension, operations: [first] }
	}
	const second = source.draw(source.draw(element(operationsOn(dimension, after(start, first)))))
	return { dimension, operations: [first, second] }
}

/** What the model predicts of a box: the draft accepted; refused as UndeclaredDrop naming `name`; refused as
 * UnsupportedOperation, a declaration naming what the previous snapshot and the target do not hold as it says; or,
 * for handles, refused as declared out of their codes' order. */
type Verdict =
	| { readonly kind: "accepted" }
	| { readonly kind: "undeclared"; readonly name: Name }
	| { readonly kind: "unsupported" }
	| { readonly kind: "reordered" }

/** The declared renames, from the previous name to the target's. */
const declaredRenames = (box: Box): ReadonlyMap<Name, Name> =>
	new Map(
		Arr.flatMap(box.operations, (op): ReadonlyArray<readonly [Name, Name]> =>
			op.kind === "rename" && op.declared ? [[op.from, op.to]] : []
		)
	)

const declaredDrops = (box: Box): ReadonlySet<Name> =>
	new Set(Arr.flatMap(box.operations, (op) => (op.kind === "drop" && op.declared ? [op.name] : [])))

/**
 * The model's verdict. A previous name is kept when the target holds the name its declared rename gives it, or its
 * own; one the target does not keep must be declared dropped. A declaration is checked first: a rename from a name the
 * previous schema does not hold or to one the target does not, or two of one name, and then a drop of a name the
 * previous schema does not hold or the target keeps, is unsupported. A handle keeps its code across a
 * declared rename, and a handle the target declares under a name the previous roster held live keeps that one's code,
 * any other taking the next code in declared order: codes out of declared order are a reorder.
 */
const verdictOf = (box: Box): Verdict => {
	const target = Arr.reduce(box.operations, start, after)
	const renames = declaredRenames(box)
	const drops = declaredDrops(box)
	const renameOps = Arr.flatMap(box.operations, (op) =>
		op.kind === "rename" && op.declared ? [op] : []
	)
	if (
		Arr.some(renameOps, (op) => !Arr.contains(start, op.from) || !Arr.contains(target, op.to)) ||
		new Set(Arr.map(renameOps, (op) => op.from)).size < renameOps.length
	) {
		return { kind: "unsupported" }
	}
	if (box.dimension === "handle") {
		const was = new Map(Arr.map(start, (h, code) => [h, code] as const))
		const renamedFrom = new Map(Arr.map([...renames], ([from, to]) => [to, from] as const))
		let next = start.length
		const codes = Arr.map(target, (h) => {
			const from = renamedFrom.get(h)
			const kept = from !== undefined ? was.get(from) : renames.has(h) ? undefined : was.get(h)
			if (kept !== undefined) {
				return kept
			}
			next += 1
			return next - 1
		})
		if (Arr.some(codes, (code, i) => i > 0 && code < (codes[i - 1] ?? code))) {
			return { kind: "reordered" }
		}
		const live = new Set(codes)
		const holed = Option.getOrUndefined(
			Arr.findFirst(start, (h) => !live.has(was.get(h) ?? -1) && !drops.has(h))
		)
		if (holed !== undefined) {
			return { kind: "undeclared", name: holed }
		}
		return Arr.some([...drops], (d) => !Arr.contains(start, d) || live.has(was.get(d) ?? -1))
			? { kind: "unsupported" }
			: { kind: "accepted" }
	}
	const keptAs = (n: Name): Name => renames.get(n) ?? n
	const lost = Option.getOrUndefined(
		Arr.findFirst(start, (n) => !Arr.contains(target, keptAs(n)) && !drops.has(n))
	)
	if (lost !== undefined) {
		return { kind: "undeclared", name: lost }
	}
	return Arr.some(
		[...drops],
		(d) => !Arr.contains(start, d) || renames.has(d) || Arr.contains(target, d)
	)
		? { kind: "unsupported" }
		: { kind: "accepted" }
}

const upper = (n: Name): string => Str.toUpperCase(n)

/** The schema of a dimension's names: relations named by them, fields of one relation, or a roster's handles. */
const descOf = (dimension: Dimension, held: ReadonlyArray<Name>): SchemaDesc => {
	switch (dimension) {
		case "relation":
			return {
				name: "Renames",
				relations: Arr.map(held, (n) => relation(upper(n), { id: f.uuid }, ["id"])),
				statements: [],
				extends: undefined
			}
		case "field":
			return {
				name: "Renames",
				relations: [
					relation(
						"P",
						{ id: f.uuid, ...Rec.fromEntries(Arr.map(held, (n) => [n, f.integer] as const)) },
						["id"]
					)
				],
				statements: [],
				extends: undefined
			}
		case "handle":
			return {
				name: "Renames",
				relations: [closed("R", held)],
				statements: [],
				extends: undefined
			}
	}
}

/** A dimension's name as a declaration names it. */
const namedOf = (dimension: Dimension, n: Name): Named => {
	switch (dimension) {
		case "relation":
			return { kind: "relation", relation: parsedName(upper(n)) }
		case "field":
			return { kind: "field", relation: parsedName("P"), field: parsedName(n) }
		case "handle":
			return { kind: "handle", roster: parsedName("R"), handle: n }
	}
}

/** The draft's declarations: each declared rename and drop. */
const declarationsOf = (box: Box): Declarations => ({
	renames: Arr.flatMap(box.operations, (op) =>
		op.kind === "rename" && op.declared
			? [{ from: namedOf(box.dimension, op.from), to: namedOf(box.dimension, op.to) }]
			: []
	),
	drops: Arr.flatMap(box.operations, (op) =>
		op.kind === "drop" && op.declared ? [namedOf(box.dimension, op.name)] : []
	)
})

/** The handle renames the codes are drafted under, as the shell maps them (RosterRenames). */
const rosterRenamesOf = (box: Box): RosterRenames =>
	box.dimension !== "handle"
		? new Map()
		: new Map([
				[
					parsedName("R"),
					new Map(
						Arr.flatMap(box.operations, (op): ReadonlyArray<readonly [string, string]> =>
							op.kind === "rename" && op.declared ? [[op.from, op.to]] : []
						)
					)
				]
			])

/** A schema's draft from `previous`, as `grizzle generate` makes it under `declared`. */
const draft = (
	previous: DeploySnapshot,
	desc: SchemaDesc,
	declared: Declarations,
	renames: RosterRenames
) => {
	const owned = owning(desc)
	const codes = draftCodebook(codebookUnder(previous, declared), renames, rostersOf(owned))
	if (!codes.ok) {
		return Result.fail(reorderRefusal(codes.error))
	}
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, owned.installation, [], [], codes.value)
		)
	)
	const drafted = draftMigration({
		previous,
		installation,
		workload: noWorkload,
		declared,
		abandoned: []
	})
	return drafted.ok ? Result.succeed(drafted.value) : Result.fail(drafted.error)
}

/** The previous installation of a dimension: its starting names drafted from the empty snapshot. */
const previousOf = (dimension: Dimension): DeploySnapshot => {
	const first = draft(
		emptySnapshot({ schemaName: "Renames", schema: "renames" }),
		descOf(dimension, start),
		{ renames: [], drops: [] },
		new Map()
	)
	if (Result.isFailure(first)) {
		return assert.fail(`the starting names draft: ${first.failure.message}`)
	}
	return first.success.snapshot
}

/** Every statement a plan's steps run, in order. */
const statementsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(steps, (s): ReadonlyArray<SqlStatement> =>
		s.draft.kind === "statement"
			? [s.draft.statement]
			: s.draft.kind === "confirm"
				? s.draft.keep
				: []
	)

/** Where the chain of table renames a plan runs takes the table named `from`. */
const renamedThrough = (statements: ReadonlyArray<SqlStatement>, from: string): string =>
	Arr.reduce(statements, from, (at, s) =>
		s.kind === "rename" && s.object === "TABLE" && s.name.name === at ? s.to : at
	)

/** The table of a relation name, through the naming door. */
const tableOf = (n: Name): string => identifierOf(identity.table(parsedName(upper(n))))

const judge = (box: Box, note: (feature: Feature) => void): void => {
	for (const op of box.operations) {
		note(`${box.dimension} ${op.kind}`)
	}
	const previous = previousOf(box.dimension)
	const target = Arr.reduce(box.operations, start, after)
	const drafted = draft(
		previous,
		descOf(box.dimension, target),
		declarationsOf(box),
		rosterRenamesOf(box)
	)
	const verdict = verdictOf(box)
	note(`${box.dimension} ${verdict.kind}`)
	const at = Formatter.format(box)
	if (verdict.kind !== "accepted") {
		if (Result.isSuccess(drafted)) {
			return assert.fail(`${at}: the model refuses it, ${verdict.kind}, and the draft drafts`)
		}
		const reason = drafted.failure.reason
		switch (verdict.kind) {
			case "undeclared":
				assert.equal(reason._tag, "UndeclaredDrop", `${at}: refused as an undeclared drop`)
				if (reason._tag === "UndeclaredDrop") {
					assert.deepEqual(
						reason.dropped,
						namedOf(box.dimension, verdict.name),
						`${at}: naming the first`
					)
				}
				return
			case "unsupported":
			case "reordered":
				assert.equal(reason._tag, "UnsupportedOperation", `${at}: refused as unsupported`)
				return
		}
	}
	if (Result.isFailure(drafted)) {
		return assert.fail(`${at}: a fully declared draft drafts: ${drafted.failure.message}`)
	}
	const { snapshot, plan } = drafted.success
	const statements = statementsOf(plan.steps)
	switch (box.dimension) {
		case "relation": {
			const relations = Arr.sort(Rec.keys(snapshot.theory.relations), Order.String)
			assert.deepEqual(
				relations,
				Arr.sort(Arr.map(target, upper), Order.String),
				"the snapshot holds the target's relations"
			)
			for (const op of box.operations) {
				if (op.kind === "rename" && op.declared) {
					assert.equal(
						renamedThrough(statements, tableOf(op.from)),
						tableOf(op.to),
						`${Formatter.format(box)}: the renames take ${op.from}'s table to ${op.to}'s`
					)
				}
			}
			return
		}
		case "field": {
			const p = snapshot.theory.relations["P"]
			assert.deepEqual(
				p?.kind === "relation"
					? Arr.sort(
							Arr.map(p.fields, (x) => x.name),
							Order.String
						)
					: [],
				Arr.sort(["id", ...target], Order.String),
				"the snapshot holds the target's fields"
			)
			return
		}
		case "handle": {
			const was = codebookOf(previous).rosters.get(parsedName("R"))?.codes ?? []
			const now = codebookOf(snapshot).rosters.get(parsedName("R"))?.codes ?? []
			for (const op of box.operations) {
				if (op.kind !== "rename" || !op.declared) {
					continue
				}
				const code = Arr.findFirstIndex(
					was,
					(c: CodeSlot) => c.kind === "live" && c.handle === op.from
				)
				assert.deepEqual(
					Option.flatMap(code, (i) => Option.fromUndefinedOr(now[i])),
					Option.some<CodeSlot>({ kind: "live", handle: op.to }),
					"a renamed handle keeps its code"
				)
			}
			return
		}
	}
}

describe("declared renames and drops", () => {
	it.effect(
		"draft exactly the model's identities for every pair of renames, drops and additions over three names, refusing every drop no declaration names",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/renames",
						generator: boxGen,
						literal: Formatter.format,
						limit: 4_000,
						box: "every one or two operations (a rename, a drop, an addition, each rename and drop declared or not) over the names a, b, c, from a and b, on relations, on one relation's fields and on a roster's handles",
						oracle: {
							kind: "second-implementation",
							name: "a model of declared identities predicting the target's names and every verdict"
						},
						coverage: requiredInSpace<Feature>(FEATURES),
						caseHang
					},
					(box, c) => Effect.sync(() => judge(box, (feature) => c.note(feature)))
				)
			)
	)
})
