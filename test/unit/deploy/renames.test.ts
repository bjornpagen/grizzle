/**
 * Declared renames and drops, drafted with no database: every one or two operations (a rename, a drop, an addition)
 * over at most three names, on relations, on the fields of one relation, on a roster's handles and on logins, and every
 * operation on relations beside one or two on logins, each operation declared or, a named invalid variant, its
 * declaration left out, exhausted.
 *
 * The oracle is a model of declared identities: it applies the operations to the previous names, predicts the target's
 * names, and predicts the verdict, accepted exactly when every name the previous schema holds and the target does not
 * keep is declared renamed or dropped, refused otherwise with UndeclaredDrop naming the first such name, a relation's
 * before a login's, in the previous snapshot's order. A name a declared rename takes from a name the previous schema
 * holds and does not rename, as a drop and then a rename onto the dropped name does, ends that name, so its drop is
 * declared though the target holds the name. An accepted draft is checked against the model: its snapshot holds exactly
 * the target's names; a declared rename of a relation is a chain of renames taking the old table to the target's, and
 * of a login a chain of ALTER ROLE ... RENAME taking the old login's role to the target's, which the draft neither
 * creates nor drops; a kept login's role is neither renamed, created nor dropped; a dropped login's role is dropped,
 * and a new login's created; and a renamed handle keeps its code, the codes read back from the snapshot.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): rosters-handle-renames-ignored (a roster's declared handle renames
 * ignored when its codes are drafted).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
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
	emptySnapshot,
	noWorkload,
	rosterFates
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { draftCodebook, type RosterRenames, reorderRefusal } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { login, relation as relationValue, role, schema } from "#compiler/public/schema.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { type OwnedLogin, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { closed, f, field, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { aliasGroups } from "#test/support/kernel/dict.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/** The names a dimension's operations range over: the box's bound of three. */
const names = ["a", "b", "c"] as const
type Name = (typeof names)[number]

type Dimension = "relation" | "field" | "handle" | "login"

/** One operation on the previous names, and whether the draft declares it (a rename's or a drop's; an addition needs
 * none). */
type Operation =
	| { readonly kind: "rename"; readonly from: Name; readonly to: Name; readonly declared: boolean }
	| { readonly kind: "drop"; readonly name: Name; readonly declared: boolean }
	| { readonly kind: "add"; readonly name: Name }

/** One dimension's operations, in order. */
interface Track {
	readonly dimension: Dimension
	readonly operations: ReadonlyArray<Operation>
}

/** A box: one dimension's track, or a relation track beside a login track, the relation's checked first. */
interface Box {
	readonly tracks: readonly [Track] | readonly [Track, Track]
}

/** What the model predicts of a box: the draft accepted; refused as UndeclaredDrop naming `name` of `dimension`;
 * refused as UnsupportedOperation, a declaration naming what the previous snapshot and the target do not hold as it
 * says; or, for handles, refused as declared out of their codes' order. */
type Verdict =
	| { readonly kind: "accepted" }
	| { readonly kind: "undeclared"; readonly dimension: Dimension; readonly name: Name }
	| { readonly kind: "unsupported" }
	| { readonly kind: "reordered" }

type Feature =
	| `${Dimension} ${Operation["kind"] | Verdict["kind"] | "taken"}`
	| `login and relation ${Verdict["kind"]}`

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"relation rename",
	"relation drop",
	"relation add",
	"relation accepted",
	"relation undeclared",
	"relation unsupported",
	"relation taken",
	"field rename",
	"field drop",
	"field add",
	"field accepted",
	"field undeclared",
	"field unsupported",
	"field taken",
	"handle rename",
	"handle drop",
	"handle add",
	"handle accepted",
	"handle undeclared",
	"handle unsupported",
	"handle reordered",
	"login rename",
	"login drop",
	"login add",
	"login accepted",
	"login undeclared",
	"login unsupported",
	"login taken",
	"login and relation accepted",
	"login and relation undeclared",
	"login and relation unsupported"
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

/** A track's names once its operations ran. */
const targetOf = (t: Track): ReadonlyArray<Name> => Arr.reduce(t.operations, start, after)

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

/** A track of one operation, or of one or two, each drawn valid on the names the earlier left. */
const trackGen =
	(dimension: Dimension, most: 1 | 2): Gen<Track> =>
	(source) => {
		const first = source.draw(source.draw(element(operationsOn(dimension, start))))
		if (most === 1 || !source.draw(boolean)) {
			return { dimension, operations: [first] }
		}
		const second = source.draw(source.draw(element(operationsOn(dimension, after(start, first)))))
		return { dimension, operations: [first, second] }
	}

/** A box: one dimension's track of one or two operations, or one operation on relations beside one or two on logins. */
const boxGen: Gen<Box> = (source) => {
	const shape = source.draw(
		element(["relation", "field", "handle", "login", "login and relation"] as const)
	)
	return shape === "login and relation"
		? { tracks: [source.draw(trackGen("relation", 1)), source.draw(trackGen("login", 2))] }
		: { tracks: [source.draw(trackGen(shape, 2))] }
}

/** The declared renames, from the previous name to the target's. */
const declaredRenames = (t: Track): ReadonlyMap<Name, Name> =>
	new Map(
		Arr.flatMap(t.operations, (op): ReadonlyArray<readonly [Name, Name]> =>
			op.kind === "rename" && op.declared ? [[op.from, op.to]] : []
		)
	)

const declaredDrops = (t: Track): ReadonlySet<Name> =>
	new Set(Arr.flatMap(t.operations, (op) => (op.kind === "drop" && op.declared ? [op.name] : [])))

/** The previous names a declared rename takes that no declared rename moves away: each ends where it is taken. */
const takenNames = (t: Track): ReadonlySet<Name> => {
	const renames = declaredRenames(t)
	return new Set(
		Arr.filter([...renames.values()], (to) => Arr.contains(start, to) && !renames.has(to))
	)
}

/** What a track contributes to the verdict, in the order the draft checks it: a declared rename the previous snapshot
 * or the target does not hold as it says; for handles, codes out of declared order; the first previous name the target
 * does not keep that no declaration drops; and a declared drop of a name the target keeps or the previous snapshot
 * lacks. */
interface Faults {
	readonly dimension: Dimension
	readonly rename: boolean
	readonly reordered: boolean
	readonly lost: Name | undefined
	readonly drop: boolean
}

/**
 * The model's faults of one track. A previous name is kept when its declared rename's name is the target's, or when
 * the target holds its own name and no declared rename takes it; one the target does not keep must be declared
 * dropped. A declaration is checked first: a rename from a name the previous schema does not hold or to one the target
 * does not, or two of one name, and then a drop of a name the previous schema does not hold or the target keeps, is
 * unsupported. A handle keeps its code across a declared rename, and a handle the target declares under a name the
 * previous roster held live keeps that one's code, any other taking the next code in declared order: codes out of
 * declared order are a reorder.
 */
const faultsOf = (t: Track): Faults => {
	const target = targetOf(t)
	const renames = declaredRenames(t)
	const drops = declaredDrops(t)
	const renameOps = Arr.flatMap(t.operations, (op) =>
		op.kind === "rename" && op.declared ? [op] : []
	)
	const rename =
		Arr.some(renameOps, (op) => !Arr.contains(start, op.from) || !Arr.contains(target, op.to)) ||
		new Set(Arr.map(renameOps, (op) => op.from)).size < renameOps.length
	if (t.dimension === "handle") {
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
		const live = new Set(codes)
		return {
			dimension: t.dimension,
			rename,
			reordered: Arr.some(codes, (code, i) => i > 0 && code < (codes[i - 1] ?? code)),
			lost: Option.getOrUndefined(
				Arr.findFirst(start, (h) => !live.has(was.get(h) ?? -1) && !drops.has(h))
			),
			drop: Arr.some([...drops], (d) => !Arr.contains(start, d) || live.has(was.get(d) ?? -1))
		}
	}
	const taken = takenNames(t)
	const kept = (n: Name): boolean => renames.has(n) || (Arr.contains(target, n) && !taken.has(n))
	return {
		dimension: t.dimension,
		rename,
		reordered: false,
		lost: Option.getOrUndefined(Arr.findFirst(start, (n) => !kept(n) && !drops.has(n))),
		drop: Arr.some([...drops], (d) => !Arr.contains(start, d) || kept(d))
	}
}

/** A box's tracks, as a list. */
const tracksOf = (box: Box): ReadonlyArray<Track> => box.tracks

/** The model's verdict over a box's tracks, each check across every track before the next. */
const verdictOf = (box: Box): Verdict => {
	const faults = Arr.map(tracksOf(box), faultsOf)
	if (Arr.some(faults, (x) => x.rename)) {
		return { kind: "unsupported" }
	}
	if (Arr.some(faults, (x) => x.reordered)) {
		return { kind: "reordered" }
	}
	for (const x of faults) {
		if (x.lost !== undefined) {
			return { kind: "undeclared", dimension: x.dimension, name: x.lost }
		}
	}
	return Arr.some(faults, (x) => x.drop) ? { kind: "unsupported" } : { kind: "accepted" }
}

const upper = (n: Name): string => Str.toUpperCase(n)

/** The names of a box's track of `dimension` at the start or the target, none for a box without one. */
const heldOf = (box: Box, dimension: Dimension, at: "start" | "target"): ReadonlyArray<Name> =>
	Option.match(
		Arr.findFirst(tracksOf(box), (t) => t.dimension === dimension),
		{ onNone: () => [], onSome: (t) => (at === "start" ? start : targetOf(t)) }
	)

/** What a box drafts at one state: its schema and its logins. */
interface Subject {
	readonly desc: FixtureSchema
	readonly logins: ReadonlyArray<OwnedLogin>
}

/** A box's schema at one state: relations named by its names, fields of one relation, or a roster's handles; or, with
 * a login track, the relation Doc beside the relation track's relations, and each login holding a role of its own over
 * Doc. */
const subjectOf = (box: Box, at: "start" | "target"): Subject => {
	const [only, second] = box.tracks
	if (second === undefined && only.dimension !== "login") {
		const held = heldOf(box, only.dimension, at)
		return { desc: descOf(only.dimension, held), logins: [] }
	}
	const Doc = relationValue("Doc", { id: uuid }, ["id"])
	const stored = Rec.fromEntries(
		Arr.map(
			heldOf(box, "relation", at),
			(n) => [upper(n), relationValue(upper(n), { id: uuid }, ["id"])] as const
		)
	)
	const base = schema("Renames", [...Rec.values(stored), Doc], [])
	return {
		desc: base,
		logins: Arr.map(heldOf(box, "login", at), (n) =>
			succeeded(
				ownLogin(
					defined(
						loginDescOf(login(base, n, [role(base, `r_${n}`, { Doc })])),
						"a login built by login(...)"
					)
				)
			)
		)
	}
}

/** The schema of one dimension's names: relations named by them, fields of one relation, or a roster's handles. */
const descOf = (dimension: Exclude<Dimension, "login">, held: ReadonlyArray<Name>): SchemaDesc => {
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
		case "login":
			return { kind: "login", login: parsedName(n) }
	}
}

/** The draft's declarations: each declared rename and drop of every track. */
const declarationsOf = (box: Box): Declarations => ({
	renames: Arr.flatMap(tracksOf(box), (t) =>
		Arr.flatMap(t.operations, (op) =>
			op.kind === "rename" && op.declared
				? [{ from: namedOf(t.dimension, op.from), to: namedOf(t.dimension, op.to) }]
				: []
		)
	),
	drops: Arr.flatMap(tracksOf(box), (t) =>
		Arr.flatMap(t.operations, (op) =>
			op.kind === "drop" && op.declared ? [namedOf(t.dimension, op.name)] : []
		)
	)
})

/** The handle renames the codes are drafted under, as the shell maps them (RosterRenames). */
const rosterRenamesOf = (box: Box): RosterRenames =>
	Option.match(
		Arr.findFirst(tracksOf(box), (t) => t.dimension === "handle"),
		{
			onNone: () => new Map(),
			onSome: (t) => new Map([[parsedName("R"), declaredRenames(t)]])
		}
	)

/** A subject's draft from `previous`, as `grizzle generate` makes it under `declared`. */
const draft = (
	previous: DeploySnapshot,
	subject: Subject,
	declared: Declarations,
	renames: RosterRenames
) => {
	const owned = owning(subject.desc)
	const rosters = rostersOf(owned)
	const codes = draftCodebook(
		rosterFates(
			previous,
			declared,
			Arr.map(rosters, (r) => r.closed)
		),
		renames,
		rosters
	)
	if (!codes.ok) {
		return Result.fail(reorderRefusal(codes.error))
	}
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), subject.logins, [], codes.value)
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

/** The previous installation of a box: its starting names drafted from the empty snapshot. */
const previousOf = (box: Box): DeploySnapshot => {
	const first = draft(
		emptySnapshot({ schemaName: "Renames", schema: "renames" }),
		subjectOf(box, "start"),
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

/** Where the chain of role renames a plan runs takes the role named `from`. */
const roleThrough = (statements: ReadonlyArray<SqlStatement>, from: string): string =>
	Arr.reduce(statements, from, (at, s) =>
		s.kind === "rename" && s.object === "ROLE" && s.name === at ? s.to : at
	)

/** Whether a plan creates the role `name`. */
const createsRole = (statements: ReadonlyArray<SqlStatement>, name: string): boolean =>
	Arr.some(statements, (s) => s.kind === "createRole" && s.name === name)

/** Whether a plan drops the role `name`. */
const dropsRole = (statements: ReadonlyArray<SqlStatement>, name: string): boolean =>
	Arr.some(statements, (s) => s.kind === "drop" && s.object === "ROLE" && s.name === name)

/** The table of a relation name, through the naming door. */
const tableOf = (n: Name): string => identifierOf(identity.table(parsedName(upper(n))))

/** The role of a login name, through the naming door. */
const roleOf = (n: Name): string =>
	identifierOf(identity.login(identity.schema(parsedSchemaName("Renames")), parsedName(n)))

/** A track's accepted draft against the model. */
const judgeTrack = (
	box: Box,
	t: Track,
	previous: DeploySnapshot,
	snapshot: DeploySnapshot,
	statements: ReadonlyArray<SqlStatement>
): void => {
	const at = Formatter.format(box)
	const target = targetOf(t)
	switch (t.dimension) {
		case "relation": {
			const relations = Arr.sort(Rec.keys(snapshot.theory.relations), Order.String)
			const doc = Arr.some(tracksOf(box), (x) => x.dimension === "login") ? ["Doc"] : []
			assert.deepEqual(
				relations,
				Arr.sort([...Arr.map(target, upper), ...doc], Order.String),
				`${at}: the snapshot holds the target's relations`
			)
			for (const op of t.operations) {
				if (op.kind === "rename" && op.declared) {
					assert.equal(
						renamedThrough(statements, tableOf(op.from)),
						tableOf(op.to),
						`${at}: the renames take ${op.from}'s table to ${op.to}'s`
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
				`${at}: the snapshot holds the target's fields`
			)
			return
		}
		case "handle": {
			const was = codebookOf(previous).rosters.get(parsedName("R"))?.codes ?? []
			const now = codebookOf(snapshot).rosters.get(parsedName("R"))?.codes ?? []
			for (const op of t.operations) {
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
					`${at}: a renamed handle keeps its code`
				)
			}
			return
		}
		case "login": {
			assert.deepEqual(
				Arr.sort(Rec.keys(snapshot.logins), Order.String),
				Arr.sort(target, Order.String),
				`${at}: the snapshot holds the target's logins`
			)
			const renames = declaredRenames(t)
			const taken = takenNames(t)
			/** The target's logins a previous one stands as, renamed or kept. */
			const standing = new Set<Name>()
			for (const n of start) {
				const to = renames.get(n)
				const kept = to === undefined && Arr.contains(target, n) && !taken.has(n)
				if (to !== undefined || kept) {
					const into = to ?? n
					standing.add(into)
					assert.equal(
						roleThrough(statements, roleOf(n)),
						roleOf(into),
						`${at}: ${n}'s role stands as ${into}'s`
					)
					assert.ok(
						!createsRole(statements, roleOf(into)) && !dropsRole(statements, roleOf(into)),
						`${at}: ${into}'s role is neither created nor dropped`
					)
				} else {
					assert.ok(
						dropsRole(statements, roleThrough(statements, roleOf(n))),
						`${at}: the dropped ${n}'s role is dropped`
					)
				}
			}
			for (const m of target) {
				if (!standing.has(m)) {
					assert.ok(createsRole(statements, roleOf(m)), `${at}: the new ${m}'s role is created`)
				}
			}
			return
		}
	}
}

const judge = (box: Box, note: (feature: Feature) => void): void => {
	for (const t of box.tracks) {
		for (const op of t.operations) {
			note(`${t.dimension} ${op.kind}`)
		}
		if (t.dimension !== "handle" && takenNames(t).size > 0) {
			note(`${t.dimension} taken`)
		}
	}
	const previous = previousOf(box)
	const drafted = draft(
		previous,
		subjectOf(box, "target"),
		declarationsOf(box),
		rosterRenamesOf(box)
	)
	const verdict = verdictOf(box)
	const [only, second] = box.tracks
	note(
		second === undefined
			? `${only.dimension} ${verdict.kind}`
			: `login and relation ${verdict.kind}`
	)
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
						namedOf(verdict.dimension, verdict.name),
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
	for (const t of box.tracks) {
		judgeTrack(box, t, previous, snapshot, statements)
	}
}

/** What a case may respell: a relation's name, a field's or a roster's. */
type Respelled = "relation" | "field" | "roster"

/** One name's spellings, before and after, both of one alias group, so of one conversion. */
interface Spelling {
	readonly before: string
	readonly after: string
}

/** A respelling of the relation, its field and the roster of the field's closed ids, each spelled again or kept. */
type Respelling = { readonly [R in Respelled]: Spelling }

/** The dictionary's alias groups: the admitted names grouped by their one conversion. */
const groups = nonEmpty(aliasGroups, "an alias group")

/** Two spellings of one alias group, each drawn from it, the same spelling when both draws agree. */
const spellingOf =
	(group: Arr.NonEmptyReadonlyArray<string>): Gen<Spelling> =>
	(source) => ({ before: source.draw(element(group)), after: source.draw(element(group)) })

/**
 * A respelling: the relation's and the roster's names of two different alias groups, which one namespace holds apart,
 * the field's of any, each spelled twice from its group.
 */
const respellingGen: Gen<Respelling> = (source) => {
	const relationAt = source.draw(int(0, groups.length - 1))
	const rosterAt = (relationAt + source.draw(int(1, groups.length - 1))) % groups.length
	return {
		relation: source.draw(spellingOf(defined(groups[relationAt], "the relation's group"))),
		field: source.draw(spellingOf(source.draw(element(groups)))),
		roster: source.draw(spellingOf(defined(groups[rosterAt], "the roster's group")))
	}
}

/** The relation with its field, a closed id of the roster, each named as `respelling` spells it `at` one side. */
const respelledDesc = (respelling: Respelling, at: keyof Spelling): SchemaDesc => {
	const kind = respelling.roster[at]
	return {
		name: "Renames",
		relations: [
			closed(kind, ["Low", "High"]),
			relation(respelling.relation[at], { id: f.uuid, [respelling.field[at]]: f.closedId(kind) }, [
				"id"
			])
		],
		statements: [],
		extends: undefined
	}
}

/** What a respelling reached: each name it spelled again, and every one of them at once. */
type RespelledFeature = Respelled | "every name respelled"

/** A field the target no longer declares: one its caller writes, or one PostgreSQL generates from its row; and whether
 * its drop is declared. */
interface Gone {
	readonly writing: "caller" | "generated"
	readonly declared: boolean
}

type GoneFeature =
	| "a caller's field refused"
	| "a caller's field dropped"
	| "a generated field dropped"

/** The relation P with the field x of `gone`'s writing beside the caller's n, or without x. */
const goneDesc = (gone: Gone, held: boolean): SchemaDesc => ({
	name: "Renames",
	relations: [
		relation(
			"P",
			held
				? {
						id: f.uuid,
						n: f.integer,
						x: gone.writing === "caller" ? f.integer : f.generated(f.integer, field("n"))
					}
				: { id: f.uuid, n: f.integer },
			["id"]
		)
	],
	statements: [],
	extends: undefined
})

describe("declared renames and drops", () => {
	it.effect(
		"drop a field grizzle draws again with no declaration, and refuse a caller's field's undeclared drop",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/renames-drawn-again",
						generator: (source): Gone => ({
							writing: source.draw(element(["caller", "generated"] as const)),
							declared: source.draw(boolean)
						}),
						literal: Formatter.format,
						box: "a caller's field and a generated one dropped, each declared or not",
						oracle: {
							kind: "specification",
							name: "a generated, drawn or accumulated field holds no caller data, so its drop needs no declaration"
						},
						coverage: requiredInSpace<GoneFeature>([
							"a caller's field refused",
							"a caller's field dropped",
							"a generated field dropped"
						]),
						caseHang
					},
					(gone, c) =>
						Effect.sync(() => {
							const x: Named = { kind: "field", relation: parsedName("P"), field: parsedName("x") }
							const previous = draft(
								emptySnapshot({ schemaName: "Renames", schema: "renames" }),
								{ desc: goneDesc(gone, true), logins: [] },
								{ renames: [], drops: [] },
								new Map()
							)
							if (Result.isFailure(previous)) {
								return assert.fail(`the starting draft: ${previous.failure.message}`)
							}
							const drafted = draft(
								previous.success.snapshot,
								{ desc: goneDesc(gone, false), logins: [] },
								{ renames: [], drops: gone.declared ? [x] : [] },
								new Map()
							)
							if (gone.writing === "caller" && !gone.declared) {
								const reason = Result.isFailure(drafted) ? drafted.failure.reason : undefined
								assert.ok(
									reason?._tag === "UndeclaredDrop",
									"a caller's field dropped undeclared is refused"
								)
								assert.deepEqual(reason.dropped, x, "naming the field")
								c.note("a caller's field refused")
								return
							}
							if (Result.isFailure(drafted)) {
								return assert.fail(`the draft drafts: ${drafted.failure.message}`)
							}
							const p = drafted.success.snapshot.theory.relations["P"]
							const fields: ReadonlyArray<string> =
								p?.kind === "relation" ? Arr.map(p.fields, (y) => y.name) : []
							assert.deepEqual(fields, ["id", "n"], "the field is dropped")
							c.note(
								gone.writing === "caller" ? "a caller's field dropped" : "a generated field dropped"
							)
						})
				)
			)
	)

	it.effect(
		"a relation, a field or a roster respelled to an alike name is one installed object: drafted with no declaration, and nothing dropped",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/renames-respelled",
						draw: drawn(respellingGen),
						literal: Formatter.format,
						coverage: required<RespelledFeature>(
							["relation", "field", "roster", "every name respelled"],
							{ cases: 64, sense: notesOnly }
						),
						kept: [],
						runs: 64,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the naming door installs a declared name as its conversion, so two alike names name one table, column or roster domain"
						}
					},
					(respelling, c) =>
						Effect.sync(() => {
							const respelled = Arr.filter(
								["relation", "field", "roster"] as const,
								(r) => respelling[r].before !== respelling[r].after
							)
							c.noteAll(respelled)
							if (respelled.length === 3) {
								c.note("every name respelled")
							}
							const previous = draft(
								emptySnapshot({ schemaName: "Renames", schema: "renames" }),
								{ desc: respelledDesc(respelling, "before"), logins: [] },
								{ renames: [], drops: [] },
								new Map()
							)
							if (Result.isFailure(previous)) {
								return assert.fail(`the starting draft: ${previous.failure.message}`)
							}
							const drafted = draft(
								previous.success.snapshot,
								{ desc: respelledDesc(respelling, "after"), logins: [] },
								{ renames: [], drops: [] },
								new Map()
							)
							if (Result.isFailure(drafted)) {
								return assert.fail(`the respelled names draft: ${drafted.failure.message}`)
							}
							const drops = Arr.filter(
								statementsOf(drafted.success.plan.steps),
								(st) =>
									st.kind === "drop" ||
									(st.kind === "alterTable" &&
										Arr.some(
											st.actions,
											(a) => a.kind === "dropColumn" || a.kind === "alterColumnType"
										))
							)
							assert.deepEqual(drops, [], "a respelling drops nothing")
						})
				)
			)
	)

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
						box: "every one or two operations (a rename, a drop, an addition, each rename and drop declared or not) over the names a, b, c, from a and b, on relations, on one relation's fields, on a roster's handles and on logins, and every one operation on relations beside one or two on logins",
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
