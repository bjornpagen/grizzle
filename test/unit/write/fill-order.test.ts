import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, filter, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { normalizeChangeSet } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { role } from "#compiler/schema/world.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, deepEquals, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	type Axis,
	besides,
	buildFill,
	copyNamed,
	countedFilled,
	type FamilyKind,
	familyNamed,
	type FillSpec,
	type FollowUp,
	fillSpecGen,
	followUpGen,
	followUpMembers,
	fullInstance,
	type InstanceRow,
	mutableOrDrawn,
	insertedRelations,
	type Planted,
	plantedGen,
	instanceFacts,
	instanceGen,
	relationName,
	type CopySource,
	type SourceClass,
	type SpecWrite,
	type StaleSpec,
	sourceClassOf,
	sourcesFor,
	uuidOfRow,
	verdictOf,
	type WritesVerdict,
	writesVerdict,
	writtenRows
} from "#test/support/families/fill.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A schema `grizzle generate` accepts is one every write of fills, and one it refuses is one no write could: the fill
 * order (analysis/theory/fill.ts) is decided when the schema compiles, and the host's filler (runtime/write/fill.ts)
 * fills by it.
 *
 * Over drawn schemas of relations, trees, ordered and counted families nested in each other, folds over them, copies
 * riding their owner, predecessor and last axes and reading entering columns, columns that wait on a sequence's
 * members, fold ends, counts and other copies (test/support/families/fill.ts):
 *
 * - **The schema compiles exactly where the reference model admits it** (fill.ts `verdictOf`, a second implementation of
 *   the fill order over the specification's own names), and a refusal is the one the model names: UnwritableRelation
 *   for sequences nesting each other; UnfillableField for a copy whose
 *   source its row fills after it, naming the copy's relation, field, family, axis and source as the specification
 *   states them, for a cause the model gives. A counted family's member that is also an ordered family's member, a
 *   tree's node or a sequence's owner is admitted. The schema compiles as `grizzle generate` compiles it: its artifacts
 *   and its installation.
 * - **Every write program of its full role compiles over an admitted schema**: one ChangeSet inserting an instance of
 *   every relation a caller inserts (a sequence's members nested under their owners, a counted family's members by
 *   their group keys), which also binds, its family reads finding nothing stored; and each relation's own insert, put
 *   and delete wherever the README's rules admit them (an immutable owner's family fixed when it is inserted, a tree
 *   written whole, a sequence's members nested, and a family's member that owns a sequence written only nested).
 * - **The nested write fills what the reference writer fills** (fill.ts `writtenRows`): every field of every nested row
 *   the insert writes, a tree's to any depth, its interval, index, counts, fold ends and copies among them, but the
 *   counts, ends and copies a counted family's own fill writes later, a nested counted member's among them.
 * - **A later write compiles wherever its refills can be written** (fill.ts `writesVerdict`, a second implementation
 *   of analysis/theory/refill.ts): each relation's own insert, put and delete the rules admit, and a drawn follow-up
 *   over the stored instance (an owner's put beside appends to its families), compile, every value they leave stale
 *   drawn again by a refill of its family; only a refill that would update an immutable relation's rows in place is
 *   refused, StaleDerivedRead naming one the reference names. The stale box exhausts every path a change takes to a
 *   stale value: an owner's put through one copy or two, and an edit of a family whose owner is a member, a tree node
 *   or the owner a copy reads, to each kind of value drawn only when its row is written; each compiles, the same put
 *   from a query is refused (StaleDerivedRead, `query`, grizzle never seeing the query's rows), and a role that leaves
 *   out one relation a refill writes or reads is refused (OutsideRole) naming exactly it.
 *
 * The planted bug: a copy's source read with no regard to when its row fills it (analysis/theory/fill.ts `ownerLater`
 * and `readLater` admitting every source) admits schemas the model refuses, which the witnesses reach on every seed.
 */

type FillSituation =
	| "admitted"
	| "refused: sequences nesting each other"
	| "refused: a copy of a column filled after its members"
	| "refused: a copy of a column a counted family fills"
	| "refused: copies at a tree's root in a cycle"
	| "admitted: a tree owning an ordered family"
	| "admitted: a tree owning a counted family"
	| "admitted: a counted family of nested owners"
	| "admitted: a counted member that is an ordered family's"
	| "admitted: a counted member that is a tree's node"
	| "admitted: a counted member that owns a sequence"
	| "admitted: a counted fold stepping a sequence's copy of its owner's"
	| "admitted: a copy along a counted family of a column after a sequence"
	| "admitted: a copy of a sibling sequence's end"
	| "refused: copies of each other's ends along sibling sequences"
	| "admitted: a copy of a tree's end"
	| "admitted: a nesting three deep"
	| "written: a follow-up over the stored instance"
	| "refilled: a value through a copy after a put"
	| "refilled: a value through a copy after an edit"
	| "refused: a refill reading another refill's change"
	| "refused: a member's own write reaching another family's value"
	| "refilled: a predecessor copy"
	| "refilled: a last copy"
	| "refused: a refill of a tree's values"
	| "refilled: a copy of an owner an edit re-places"
	| "compiled: a put beneath an immutable owner, which re-places nothing"
	| "refused: the write a refill starts from, beside a plain put named first"
	| "refilled: a fold over a copy"
	| "refused: a refill of an immutable relation's rows"
	| "refused: a put from a query that a refill would draw"
	| "refused: a role that does not hold a relation a refill writes or reads"
	| "compiled: a role that holds every relation a refill writes and reads"

/** A compilation's refusal; none when it compiled. */
const refusalOf = (
	result:
		| { readonly ok: true; readonly value: unknown }
		| {
				readonly ok: false
				readonly error: CompileError
		  }
): CompileError | undefined => (result.ok ? undefined : result.error)

/** The relation value of relation `r` of a built specification. */
const relationOf = (built: ReturnType<typeof buildFill>, r: number) =>
	defined(built.relations[relationName(r)], `the relation ${relationName(r)}`)

/** A ChangeSet over `value` inserting each relation of `facts`, in the specification's relation order. */
const insertAll = (
	value: unknown,
	built: ReturnType<typeof buildFill>,
	facts: ReadonlyMap<number, ReadonlyArray<unknown>>,
	inserted: ReadonlyArray<number>
): ChangeSetValue =>
	Arr.reduce(inserted, ChangeSet.empty(value), (cs, r) =>
		cs.insert(relationOf(built, r), facts.get(r) ?? [])
	)

/** The situations a value the reference finds stale reaches: the path its change takes and the kind of value. */
const staleNotes = (spec: FillSpec, stale: StaleSpec): ReadonlyArray<FillSituation> => {
	const reader = defined(spec.families[stale.family], "a refilled family")
	const at = relationName(reader.member)
	return [
		stale.from === "refill"
			? assert.fail(
					"a written verdict leaves no value a refill's own change makes stale: the reference refuses it"
				)
			: stale.changed.by === "put"
				? "refilled: a value through a copy after a put"
				: stale.changed.relation === at
					? assert.fail(
							"a written verdict leaves no value an edit's recount reaches in its own relation: the reference refuses it"
						)
					: "refilled: a value through a copy after an edit",
		...((): ReadonlyArray<FillSituation> => {
			switch (stale.reader.kind) {
				case "predecessor":
					return ["refilled: a predecessor copy"]
				case "last":
					return ["refilled: a last copy"]
				case "tree":
					return assert.fail(
						"a written verdict leaves no tree's value stale: the reference refuses it"
					)
				case "owner":
					return ["refilled: a copy of an owner an edit re-places"]
				case "fold":
					return Arr.some(spec.steps, (s) => s.family === stale.family)
						? ["refilled: a fold over a copy"]
						: []
			}
		})()
	]
}

/**
 * A compiled ChangeSet of `writes` judged against the reference's verdict (fill.ts `writesVerdict`): compiled where it
 * is written, noting every value it refills; else refused with StaleDerivedRead naming a refill of an immutable
 * relation's rows the reference names, refills on a cycle the reference finds, a tree whose values the reference
 * finds stale, a refill whose own change a value reads, or a family member's own write reaching a value grizzle
 * refills only from a plain relation's put, at the write a refused refill's path starts from.
 */
const judged = (
	spec: FillSpec,
	refusal: CompileError | undefined,
	verdict: WritesVerdict,
	label: string,
	note: (situation: FillSituation) => void
): void => {
	if (verdict.kind === "written") {
		assert.equal(refusal?.reason, undefined, `${label} compiles`)
		for (const stale of verdict.stale) {
			for (const situation of staleNotes(spec, stale)) {
				note(situation)
			}
		}
		return
	}
	const reason = defined(refusal, `${label} is refused`).reason
	assert.equal(reason._tag, "StaleDerivedRead", label)
	if (reason._tag !== "StaleDerivedRead") {
		return
	}
	const named = reason
	assert.ok(
		Arr.some(
			verdict.origins,
			(w) => relationName(w.relation) === named.member && w.op === named.op
		),
		`${label}: the refusal names the write a refused refill's path starts from, one of ${Formatter.format(verdict.origins)}, not ${named.op} ${named.member}`
	)
	const cause = reason.cause
	switch (verdict.kind) {
		case "refused":
			assert.equal(cause.kind, "immutable", `${label}: a refill of an immutable relation's rows`)
			if (cause.kind === "immutable") {
				assert.ok(
					verdict.immutable.includes(cause.relation),
					`an immutable relation the reference finds a refill updates, not ${cause.relation}: ${Formatter.format(verdict.immutable)}`
				)
			}
			note("refused: a refill of an immutable relation's rows")
			return
		case "cycle":
			assert.equal(cause.kind, "cycle", `${label}: refills that reach a family they refill again`)
			if (cause.kind === "cycle") {
				const onCycle = Arr.map(verdict.cycle, (k) => familyNamed(spec, k))
				assert.ok(
					Arr.every(cause.refills, (f) =>
						Arr.some(onCycle, (g) => g.owner === f.owner && g.count === f.count)
					),
					`refills on a cycle the reference finds: ${Formatter.format(cause.refills)} among ${Formatter.format(onCycle)}`
				)
			}
			return
		case "tree":
			assert.equal(cause.kind, "tree", `${label}: a refill of a tree's values`)
			if (cause.kind === "tree") {
				const tree = cause.tree
				assert.ok(
					Arr.some(verdict.trees, (k) => {
						const named = familyNamed(spec, k)
						return named.owner === tree.owner && named.count === tree.count
					}),
					`a tree whose values the reference finds stale, not ${Formatter.format(tree)}: ${Formatter.format(Arr.map(verdict.trees, (k) => familyNamed(spec, k)))}`
				)
			}
			note("refused: a refill of a tree's values")
			return
		case "chained":
			assert.equal(cause.kind, "chained", `${label}: a refill reading another refill's change`)
			if (cause.kind === "chained") {
				const from = cause.refill
				assert.ok(
					Arr.some(verdict.refills, (k) => {
						const named = familyNamed(spec, k)
						return named.owner === from.owner && named.count === from.count
					}),
					`a family the writes refill, not ${Formatter.format(from)}: ${Formatter.format(Arr.map(verdict.refills, (k) => familyNamed(spec, k)))}`
				)
			}
			note("refused: a refill reading another refill's change")
			return
		case "edit":
			assert.equal(
				cause.kind,
				"edit",
				`${label}: a member's own write reaching another family's value`
			)
			if (cause.kind === "edit") {
				const reached = cause.family
				assert.ok(
					Arr.some(verdict.families, (k) => {
						const named = familyNamed(spec, k)
						return named.owner === reached.owner && named.count === reached.count
					}),
					`a family the reference finds a member's write reaches, not ${Formatter.format(reached)}: ${Formatter.format(Arr.map(verdict.families, (k) => familyNamed(spec, k)))}`
				)
			}
			note("refused: a member's own write reaching another family's value")
	}
}

/** Whether the README's rules admit a write of relation `r` by `op`, which then must compile. */
const ruleAdmits = (spec: FillSpec, r: number, op: "insert" | "put" | "delete"): boolean => {
	const families = spec.families
	const tree = Arr.some(families, (f) => f.kind === "tree" && f.member === r)
	const ordered = Arr.some(families, (f) => f.kind === "ordered" && f.member === r)
	const immutableOwner = Arr.some(
		families,
		(f) => f.member === r && f.kind !== "tree" && !defined(spec.relations[f.owner]).mutable
	)
	const owns = Arr.some(families, (f) => f.owner === r)
	/** The relations an insert of r writes: r, and every sequence's member its nesting reaches. */
	const written = new Set([r])
	for (const at of written) {
		for (const f of families) {
			if (f.owner === at && f.kind !== "counted") {
				written.add(f.member)
			}
		}
	}
	const nestedFixed = Arr.some(
		families,
		(f) =>
			f.kind === "counted" &&
			f.member !== r &&
			written.has(f.member) &&
			!written.has(f.owner) &&
			!defined(spec.relations[f.owner]).mutable
	)
	const nestsUnderMember =
		Arr.some(families, (f) => f.member === r) &&
		Arr.some(families, (f) => f.owner === r && f.kind !== "counted")
	switch (op) {
		case "insert":
			return !ordered && !immutableOwner && !nestedFixed
		case "put":
			return !tree && !nestsUnderMember && (!owns || defined(spec.relations[r]).mutable)
		case "delete":
			return !tree && !nestsUnderMember && !immutableOwner
	}
}

/**
 * The relations a write's refills need, by the reference: those they rewrite in place, each refilled family's members,
 * and those their reads pass, every relation each stale value's change passes on its way.
 */
const neededBy = (
	spec: FillSpec,
	stale: ReadonlyArray<StaleSpec>
): { readonly writes: ReadonlySet<string>; readonly reads: ReadonlySet<string> } => ({
	writes: new Set(
		Arr.map(stale, (s) =>
			relationName(defined(spec.families[s.family], "a refilled family").member)
		)
	),
	reads: new Set(Arr.flatMap(stale, (s) => s.passed))
})

/** A put's rows from a query over `value`: the rows of a relation parameter, which the host never sees. */
const restated = (value: ReturnType<ReturnType<typeof buildFill>["rename"]>) =>
	query(value).rule((r) => {
		const rows = r.relation("rows", { id: uuid, v: pg.bigint })
		const row = v(rows, "row")
		return r.match(rows, { id: row.id, v: row.v }).find({ id: row.id, v: row.v })
	})

/**
 * A specification's refilling writes held to their guards: each put and delete the rules admit whose refills the
 * reference finds compiles, and
 * - a put of a relation no family has as a member, from a query instead, is refused (StaleDerivedRead, `query`): the
 *   host never sees the query's rows, so it cannot draw what their change leaves stale;
 * - under a role that holds every relation of the specification but one other than the written one, whole and in its
 *   write list, it is refused (OutsideRole) naming exactly that relation where its refills write it (a write) or their
 *   reads pass it (a read), and compiles where they need it not.
 */
const guards = (spec: FillSpec, note: (situation: FillSituation) => void): void => {
	const built = buildFill(spec)
	const value = built.rename("Fill")
	const artifacts = succeeded(testArtifacts(value, testCompile), "the specification's artifacts")
	const options = realityWrite(artifacts)
	const checked = checking(value)
	/** A relation no family has, whose put changes nothing a refill reads: named first beside a refused write, it is
	 * never the write the refusal names. */
	const plain = Arr.findFirstIndex(
		spec.relations,
		(_, p) => !Arr.some(spec.families, (f) => f.owner === p || f.member === p)
	)
	for (const [r] of spec.relations.entries()) {
		for (const op of ["put", "delete"] as const) {
			const refused = writesVerdict(spec, [{ relation: r, op }])
			if (Option.isNone(plain) || !ruleAdmits(spec, r, op) || refused.kind === "written") {
				continue
			}
			const p = plain.value
			const beside = ChangeSet.empty(value).put(relationOf(built, p), [])
			judged(
				spec,
				refusalOf(
					compileWrite(
						checked,
						descOf(
							op === "put"
								? beside.put(relationOf(built, r), [])
								: beside.delete(relationOf(built, r), [])
						),
						options
					)
				),
				writesVerdict(spec, [
					{ relation: p, op: "put" },
					{ relation: r, op }
				]),
				`a put of ${relationName(p)} named before a ${op} of ${relationName(r)}`,
				note
			)
			note("refused: the write a refill starts from, beside a plain put named first")
		}
	}
	for (const [r] of spec.relations.entries()) {
		for (const op of ["put", "delete"] as const) {
			const verdict = writesVerdict(spec, [{ relation: r, op }])
			if (!ruleAdmits(spec, r, op) || verdict.kind !== "written" || verdict.stale.length === 0) {
				continue
			}
			const relation = relationOf(built, r)
			const written = relationName(r)
			if (op === "put" && !Arr.some(spec.families, (f) => f.member === r)) {
				const queried = ChangeSet.empty(value).put(relation, restated(value))
				const reason = defined(
					refusalOf(compileWrite(checked, descOf(queried), options)),
					`a put of ${written} from a query is refused`
				).reason
				assert.equal(reason._tag, "StaleDerivedRead", `a put of ${written} from a query`)
				if (reason._tag === "StaleDerivedRead") {
					assert.equal(
						reason.cause.kind,
						"query",
						"a put from a query, whose rows grizzle never sees"
					)
				}
				note("refused: a put from a query that a refill would draw")
			}
			const needed = neededBy(spec, verdict.stale)
			for (const [x] of spec.relations.entries()) {
				const left = relationName(x)
				if (left === written) {
					continue
				}
				const held = Arr.filter(Rec.keys(built.relations), (name) => name !== left)
				const app = role(
					value,
					"refill",
					Rec.fromEntries(Arr.map(held, (name) => [name, defined(built.relations[name])] as const)),
					{ write: held }
				)
				const roleArtifacts = succeeded(testArtifacts(app, testCompile), "the role's artifacts")
				const world = roleArtifacts.world
				if (world.kind !== "role") {
					return assert.fail("a role's artifacts hold its world")
				}
				const cs =
					op === "put"
						? ChangeSet.empty(app).put(relation, [])
						: ChangeSet.empty(app).delete(relation, [])
				const refusal = refusalOf(
					compileWrite(world.checked, descOf(cs), {
						names: roleArtifacts.names,
						reads: roleArtifacts.reads,
						claims: { kind: "facts", present: new Set<string>() },
						world: { kind: "role", names: world.names },
						laws: roleArtifacts.laws,
						derived: roleArtifacts.derived,
						level: "serializable"
					})
				)
				const label = `a ${op} of ${written} under a role leaving out ${left}`
				const access = needed.writes.has(left)
					? "write"
					: needed.reads.has(left)
						? "read"
						: undefined
				if (access === undefined) {
					assert.equal(refusal?.reason, undefined, `${label} compiles`)
					note("compiled: a role that holds every relation a refill writes and reads")
					continue
				}
				const reason = defined(refusal, `${label} is refused`).reason
				assert.equal(reason._tag, "OutsideRole", label)
				if (reason._tag === "OutsideRole") {
					assert.equal(reason.access.kind, access, `${label}: a ${access}`)
					assert.ok(
						reason.access.kind !== "wholeBase" && reason.access.relation === left,
						`${label}: names ${left}`
					)
				}
				note("refused: a role that does not hold a relation a refill writes or reads")
			}
		}
	}
}

/**
 * The property over one specification and one instance of it: see the module's header. It notes the verdict and the
 * shapes an admitted specification holds.
 */
const property = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	followUp: Option.Option<FollowUp>,
	note: (situation: FillSituation) => void
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const built = buildFill(spec)
		const value = built.rename("Fill")
		const verdict = verdictOf(spec)
		const artifacts = testArtifacts(value, testCompile)
		const installation = artifacts.ok
			? refusalOf(
					compileInstallation(owning(value), {
						...installOptions(owning(value), "owner"),
						levels: [identity.schema(parsedSchemaName("fill"))]
					})
				)
			: undefined
		const refusal = artifacts.ok ? installation : artifacts.error
		switch (verdict.kind) {
			case "unwritable": {
				const reason = defined(refusal, "a schema no write fills is refused").reason
				assert.equal(reason._tag, "UnwritableRelation", Formatter.format(spec))
				if (reason._tag === "UnwritableRelation") {
					assert.equal(reason.cause.kind, "nestingCycle", "sequences nesting each other")
					note("refused: sequences nesting each other")
				}
				return
			}
			case "unfillable": {
				const reason = defined(refusal, "a schema with a copy no write fills is refused").reason
				assert.equal(reason._tag, "UnfillableField", Formatter.format(spec))
				if (reason._tag !== "UnfillableField") {
					return
				}
				const refused = Arr.findFirst(
					verdict.copies,
					(c) => copyNamed(spec, c.copy).field === reason.field
				)
				assert.ok(Option.isSome(refused), `a copy the model refuses, not ${reason.field}`)
				if (Option.isNone(refused)) {
					return
				}
				const named = copyNamed(spec, refused.value.copy)
				assert.equal(reason.relation, named.relation, "the copy's relation")
				assert.deepEqual(reason.family, named.family, "the copy's family")
				assert.ok(
					refused.value.later.includes(reason.later.kind),
					`a cause the model gives copy ${named.field}: ${Arr.join(refused.value.later, ", ")}, not ${reason.later.kind}`
				)
				if (reason.axis !== "row") {
					assert.equal(reason.axis, named.axis, "the copy's axis")
					assert.deepEqual(reason.source, named.source, "the column the copy reads")
				}
				if (
					reason.later.kind === "afterMembers" &&
					reason.axis === "owner" &&
					sourceClassOf(spec, refused.value.copy) === "after another family"
				) {
					note("refused: copies of each other's ends along sibling sequences")
				}
				note(
					reason.later.kind === "afterMembers"
						? "refused: a copy of a column filled after its members"
						: reason.later.kind === "cycle"
							? "refused: copies at a tree's root in a cycle"
							: "refused: a copy of a column a counted family fills"
				)
				return
			}
			case "admitted":
				break
		}
		assert.equal(
			refusal?.reason,
			undefined,
			`a schema the model admits compiles: ${Formatter.format(spec)}`
		)
		if (!artifacts.ok) {
			return
		}
		note("admitted")
		const options = realityWrite(artifacts.value)
		const checked = checking(value)
		const inserted = insertedRelations(spec)
		const facts = instanceFacts(spec, rows)
		const all = insertAll(value, built, facts, inserted)
		const program = compileWrite(checked, descOf(all), options)
		assert.equal(refusalOf(program)?.reason, undefined, "the instance's insert compiles")
		if (!program.ok) {
			return
		}
		const members = yield* collectInputs(program.value.binding.groups, parsedOf(all).inputs)
		const write = runnableWrite(program.value, program.value.frontend.codes)
		const bound = bindWrite(write, {
			members,
			params: {},
			transport: inForce(bindFrame)
		})
		if (!bound.ok || bound.value.kind !== "bound") {
			return assert.fail(
				`the instance binds to statements, not ${bound.ok ? bound.value.kind : Formatter.format(bound.error)}`
			)
		}
		const flights = bound.value.flights
		const writes =
			flights.kind === "write"
				? { ok: true as const, value: flights.chunks }
				: Result.map(flights.writes(Arr.map(flights.reads, () => [])), (written) => written.chunks)
		if (!writes.ok) {
			return assert.fail(
				`the instance's family writes plan from reads that find nothing stored, not ${Formatter.format(writes.error)}`
			)
		}
		const chunks = writes.value
		for (const statement of write.flight.statements) {
			const sent = chunks(statement, inForce(bindFrame))
			if (!sent.ok) {
				return assert.fail(`every statement's rows, not ${Formatter.format(sent.error)}`)
			}
		}
		const expected = writtenRows(spec, rows)
		const byUuid = new Map(Arr.map(rows, (row) => [uuidOfRow(row.id), row] as const))
		const normalized = succeeded(
			normalizeChangeSet(
				write.flight.prepared.groups,
				{ fill: write.flight.prepared.fill, codes: write.flight.codes },
				members,
				inForce(bindFrame)
			)
		)
		if (normalized.kind !== "normalized") {
			return assert.fail(`the instance normalizes, not ${Formatter.format(normalized)}`)
		}
		for (const byRelation of normalized.nested.values()) {
			for (const [name, nested] of byRelation) {
				for (const row of nested.values()) {
					const id = row.fact["id"]
					const instanceRow = typeof id === "string" ? byUuid.get(id) : undefined
					const want = defined(
						instanceRow === undefined ? undefined : expected.get(instanceRow.id),
						`a nested row of ${name} the instance holds`
					)
					for (const [field, wanted] of Rec.toEntries(want)) {
						if (field === "g" || countedFilled(spec, defined(instanceRow).relation, field)) {
							continue
						}
						assert.equal(
							row.fact[field],
							wanted,
							`${name}.${field} of ${String(id)}, as the reference writer fills it`
						)
					}
				}
			}
		}
		for (const [r] of spec.relations.entries()) {
			const one = (cs: ChangeSetValue, op: SpecWrite["op"]): void =>
				judged(
					spec,
					refusalOf(compileWrite(checked, descOf(cs), options)),
					writesVerdict(spec, [{ relation: r, op }]),
					`a ${op} of ${relationName(r)} the rules admit`,
					note
				)
			const relation = relationOf(built, r)
			const own = facts.get(r) ?? []
			if (ruleAdmits(spec, r, "insert") && inserted.includes(r)) {
				one(ChangeSet.empty(value).insert(relation, own), "insert")
			}
			if (ruleAdmits(spec, r, "put")) {
				one(ChangeSet.empty(value).put(relation, []), "put")
			}
			if (ruleAdmits(spec, r, "delete")) {
				one(ChangeSet.empty(value).delete(relation, []), "delete")
			}
		}
		if (Option.isSome(followUp)) {
			const followed = followUpMembers(spec, rows, followUp.value)
			const follow = Arr.reduce(followed, ChangeSet.empty(value), (cs, m) => {
				const relation = relationOf(built, m.relation)
				switch (m.op) {
					case "insert":
						return cs.insert(relation, m.facts)
					case "put":
						return cs.put(relation, m.facts)
					case "delete":
						return cs.delete(relation, m.facts)
				}
			})
			const written = writesVerdict(
				spec,
				Arr.map(followed, (m) => ({ relation: m.relation, op: m.op }))
			)
			judged(
				spec,
				refusalOf(compileWrite(checked, descOf(follow), options)),
				written,
				`the follow-up ${Formatter.format(followed)}`,
				note
			)
			if (written.kind === "written") {
				note("written: a follow-up over the stored instance")
			}
		}
		const kindsOf = (r: number): ReadonlyArray<FamilyKind> =>
			Arr.flatMap(spec.families, (f) => (f.owner === r ? [f.kind] : []))
		for (const [r] of spec.relations.entries()) {
			const owned = kindsOf(r)
			if (owned.includes("tree") && owned.includes("ordered")) {
				note("admitted: a tree owning an ordered family")
			}
			if (owned.includes("tree") && owned.includes("counted")) {
				note("admitted: a tree owning a counted family")
			}
		}
		if (
			Arr.some(
				spec.families,
				(f) =>
					f.kind === "counted" &&
					Arr.some(spec.families, (s) => s.kind !== "counted" && s.member === f.owner)
			)
		) {
			note("admitted: a counted family of nested owners")
		}
		for (const counted of Arr.filter(spec.families, (f) => f.kind === "counted")) {
			for (const s of spec.families) {
				if (s.kind === "ordered" && s.member === counted.member) {
					note("admitted: a counted member that is an ordered family's")
				}
				if (s.kind === "tree" && s.member === counted.member) {
					note("admitted: a counted member that is a tree's node")
				}
				if (s.kind !== "counted" && s.owner === counted.member) {
					note("admitted: a counted member that owns a sequence")
				}
			}
		}
		for (const step of spec.steps) {
			const along = defined(spec.families[defined(spec.copies[step.copy]).family])
			if (defined(spec.families[step.family]).kind === "counted" && along.kind !== "counted") {
				note("admitted: a counted fold stepping a sequence's copy of its owner's")
			}
		}
		for (const [j, copy] of spec.copies.entries()) {
			const family = defined(spec.families[copy.family])
			const sourceClass = sourceClassOf(spec, j)
			if (family.kind === "counted" && sourceClass === "after another family") {
				note("admitted: a copy along a counted family of a column after a sequence")
			}
			if (
				family.kind !== "counted" &&
				copy.axis === "owner" &&
				sourceClass === "after another family"
			) {
				note("admitted: a copy of a sibling sequence's end")
			}
			if (copy.source.kind === "end") {
				note("admitted: a copy of a tree's end")
			}
		}
		const depth = (r: number, seen: ReadonlySet<number>): number =>
			Arr.reduce(
				Arr.filter(
					spec.families,
					(f) => f.kind === "ordered" && f.owner === r && !seen.has(f.member)
				),
				1,
				(d, f) => Math.max(d, 1 + depth(f.member, new Set([...seen, f.member])))
			)
		if (Arr.some(spec.relations, (_, r) => depth(r, new Set([r])) >= 3)) {
			note("admitted: a nesting three deep")
		}
	})

const fillSituations: Arr.NonEmptyReadonlyArray<FillSituation> = [
	"admitted",
	"refused: sequences nesting each other",
	"refused: a copy of a column filled after its members",
	"refused: a copy of a column a counted family fills",
	"refused: copies at a tree's root in a cycle",
	"admitted: a tree owning an ordered family",
	"admitted: a tree owning a counted family",
	"admitted: a counted family of nested owners",
	"admitted: a counted member that is an ordered family's",
	"admitted: a counted member that is a tree's node",
	"admitted: a counted member that owns a sequence",
	"admitted: a counted fold stepping a sequence's copy of its owner's",
	"admitted: a copy along a counted family of a column after a sequence",
	"admitted: a copy of a sibling sequence's end",
	"refused: copies of each other's ends along sibling sequences",
	"admitted: a copy of a tree's end",
	"admitted: a nesting three deep",
	"written: a follow-up over the stored instance"
]

/**
 * A drawn specification, its relations all made mutable or left as drawn, an instance of it, and a follow-up over the
 * stored instance or none: a follow-up needs a mutable owner, which a relation is only now and then as drawn.
 */
/**
 * The shapes the engine once refused (UnfillableField, a column no fill reaches) where the reference admits them: R0 is
 * the member of a sequence, an ordered family of R2 or a tree of its own, and of R1's counted family, whose sum fold
 * steps R0's copy along the sequence's owner axis of a caller's `v` or a generated `g`. The walk fills the copy on
 * entering R0, and the counted family completes the row afterwards, as it completes any row the walk left.
 */
const stepsOfSequenceCopies: ReadonlyArray<{ readonly note: string; readonly sketch: FillCase }> =
	Arr.map(
		[
			{
				note: "an ordered family's copy of a caller's v",
				family: { kind: "ordered", owner: 2, member: 0, fold: "none" },
				source: "caller"
			},
			{
				note: "a tree's copy of its parent's caller v",
				family: { kind: "tree", owner: 0, member: 0, fold: "none" },
				source: "caller"
			},
			{
				note: "a tree's copy of its parent's generated g",
				family: { kind: "tree", owner: 0, member: 0, fold: "none" },
				source: "generated"
			}
		] as const,
		({ note, family, source }) => {
			const relation = { generated: false, mutable: false }
			const spec: FillSpec = {
				relations: [
					{ ...relation, generated: source === "generated" },
					relation,
					...(family.kind === "ordered" ? [relation] : [])
				],
				families: [family, { kind: "counted", owner: 1, member: 0, fold: "sum" }],
				copies: [{ family: 0, axis: "owner", source: { kind: source } }],
				steps: [{ family: 1, copy: 0 }]
			}
			return {
				note: `a counted fold stepping its member's copy along a sequence's owner axis: ${note}`,
				sketch: { spec, rows: fullInstance(spec), followUp: Option.none() }
			}
		}
	)

const caseGen: Gen<FillCase> = (source) => {
	const spec = source.draw(mutableOrDrawn(fillSpecGen({ relations: 4, families: 4, copies: 3 })))
	const rows = source.draw(instanceGen(spec))
	return { spec, rows, followUp: source.draw(followUpGen(spec, rows)) }
}

/** A case of the drawn schemas' suite: a specification, an instance of it, and a follow-up over it or none. */
interface FillCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly followUp: Option.Option<FollowUp>
}

/**
 * A case over a planted specification (fill.ts `plantedGen`) beside an admitted drawn one (`besides`), with an instance
 * and a follow-up drawn as any case's.
 */
const plantedCaseGen =
	(planted: Planted): Gen<FillCase> =>
	(source) => {
		const base = source.draw(
			filter(
				mutableOrDrawn(fillSpecGen({ relations: 3, families: 3, copies: 2 })),
				(s) => verdictOf(s).kind === "admitted",
				16
			)
		)
		const spec = besides(base, source.draw(plantedGen(planted)))
		const rows = source.draw(instanceGen(spec))
		return { spec, rows, followUp: source.draw(followUpGen(spec, rows)) }
	}

/** The situations a drawn specification reaches only now and then, each with the shape a witness plants to reach it
 * while it is pending. */
const aims: ReadonlyArray<readonly [FillSituation, Planted]> = [
	[
		"admitted: a copy along a counted family of a column after a sequence",
		"counted copy of an end"
	],
	["admitted: a copy of a sibling sequence's end", "sibling's end"],
	["refused: copies of each other's ends along sibling sequences", "siblings' ends"],
	["admitted: a counted member that is an ordered family's", "counted ordered member"],
	["admitted: a counted member that is a tree's node", "counted tree node"],
	["admitted: a counted member that owns a sequence", "counted sequence owner"],
	[
		"admitted: a counted fold stepping a sequence's copy of its owner's",
		"counted step of a sequence's copy"
	],
	["admitted: a tree owning an ordered family", "tree with an ordered family"],
	["admitted: a tree owning a counted family", "tree with a counted family"],
	["admitted: a counted family of nested owners", "counted family of a nested owner"],
	["admitted: a copy of a tree's end", "copy of a tree's end"],
	["admitted: a nesting three deep", "nesting three deep"]
]

/** The case a witness runs: its drawn one, or, while a situation `aims` plants is pending, a planted one. */
const aimedCase = (drawnCase: FillCase, c: Case<FillSituation>): FillCase => {
	const pending = Option.getOrUndefined(c.steering)
	const aim = Arr.findFirst(aims, ([situation]) => pending?.has(situation) === true)
	return Option.isNone(aim) ? drawnCase : c.draw(plantedCaseGen(aim.value[1]))
}

/**
 * The exhausted box: one family of each kind, its owner a top relation, a nested one (an ordered member of a parent)
 * or a tree's node, and one copy along each of its axes reading each kind of column its target row holds, every other
 * relation and family there only to hold the copied column: another sequence's count or fold, a counted family's
 * count or fold, the family's own fold, an index, a tree's interval, or another copy.
 */
type SourceKind =
	| "caller"
	| "generated"
	| "sequence count"
	| "counted count"
	| "index"
	| "start"
	| "end"
	| "sequence fold"
	| "counted fold"
	| "own fold"
	| "copy"

interface Shape {
	readonly family: FamilyKind
	readonly owner: "top" | "nested" | "tree node"
	readonly axis: Axis
	readonly source: SourceKind
}

const shapeGen: Gen<Shape> = (source) => ({
	family: source.draw(element(["ordered", "counted", "tree"] as const)),
	owner: source.draw(element(["top", "nested", "tree node"] as const)),
	axis: source.draw(element(["owner", "predecessor", "last"] as const)),
	source: source.draw(
		element([
			"caller",
			"generated",
			"sequence count",
			"counted count",
			"index",
			"start",
			"end",
			"sequence fold",
			"counted fold",
			"own fold",
			"copy"
		] as const)
	)
})

/**
 * The specification of a shape, or none where it holds no such copy: relation 0 the parent of a nested owner, 1 the
 * owner (a tree's relation for a tree or a tree node), 2 the member, 3 the relation of the source row's other
 * sequence, 4 that of its counted family. The copy is the last; a copy of a copy reads the first, which copies the
 * source row's owner's `v` along the source row's own family's owner axis.
 */
const shapeSpec = (shape: Shape): FillSpec | undefined => {
	if (shape.family === "tree" && shape.owner !== "tree node") {
		return undefined
	}
	if (shape.family === "counted" && shape.axis !== "owner") {
		return undefined
	}
	const relations = Arr.makeBy(5, (r) => ({
		generated: r === 1 || r === 2,
		mutable: false
	}))
	const families: Array<FillSpec["families"][number]> = []
	if (shape.owner === "nested") {
		families.push({ kind: "ordered", owner: 0, member: 1, fold: "none" })
	}
	if (shape.owner === "tree node" && shape.family !== "tree") {
		families.push({ kind: "tree", owner: 1, member: 1, fold: "none" })
	}
	const f = families.length
	const tree = shape.family === "tree"
	families.push({
		kind: shape.family,
		owner: 1,
		member: tree ? 1 : 2,
		fold: shape.source === "own fold" ? "sum" : "none"
	})
	const row = shape.axis === "owner" ? 1 : tree ? 1 : 2
	if (shape.source === "sequence count" || shape.source === "sequence fold") {
		families.push({
			kind: "ordered",
			owner: row,
			member: 3,
			fold: shape.source === "sequence fold" ? "sum" : "none"
		})
	}
	if (shape.source === "counted count" || shape.source === "counted fold") {
		families.push({
			kind: "counted",
			owner: row,
			member: 4,
			fold: shape.source === "counted fold" ? "sum" : "none"
		})
	}
	const other = families.length - 1
	const holder = Option.getOrUndefined(
		Arr.findFirst(families, (x) => x.member === row && x.kind !== "counted")
	)
	const firstCopy =
		shape.source === "copy" && holder !== undefined
			? [
					{
						family: families.indexOf(holder),
						axis: "owner" as const,
						source: { kind: "caller" } as const
					}
				]
			: []
	const wanted: CopySource | undefined = (() => {
		switch (shape.source) {
			case "caller":
				return { kind: "caller" }
			case "generated":
				return { kind: "generated" }
			case "sequence count":
			case "counted count":
				return { kind: "count", family: other }
			case "sequence fold":
			case "counted fold":
				return { kind: "fold", family: other }
			case "own fold":
				return { kind: "fold", family: f }
			case "index":
				return Option.match(
					Arr.findFirstIndex(families, (x) => x.member === row && x.kind !== "counted"),
					{
						onNone: () => undefined,
						onSome: (sequence): CopySource => ({ kind: "index", family: sequence })
					}
				)
			case "start":
				return { kind: "start" }
			case "end":
				return { kind: "end" }
			case "copy":
				return firstCopy.length === 0 ? undefined : { kind: "copy", copy: 0 }
		}
	})()
	if (wanted === undefined) {
		return undefined
	}
	const spec: FillSpec = {
		relations: [defined(relations[0]), ...Arr.drop(relations, 1)],
		families,
		copies: [...firstCopy, { family: f, axis: shape.axis, source: wanted }],
		steps: []
	}
	const offered = sourcesFor(spec, f, shape.axis, firstCopy.length)
	return Arr.some(offered, (s) => deepEquals(s, wanted)) ? spec : undefined
}

/** A copy's situation in the box: its axis, its family's kind, its source's class, and whether a write fills it. */
type BoxSituation = `${Axis} copy along ${"a sequence" | "a counted family"} of ${SourceClass}: ${
	| "filled"
	| "refused"}`

const boxSituations: Arr.NonEmptyReadonlyArray<BoxSituation> = [
	"owner copy along a sequence of entering: filled",
	"owner copy along a sequence of after its own family: refused",
	"owner copy along a sequence of after another family: filled",
	"owner copy along a sequence of counted count: refused",
	"owner copy along a sequence of counted end: refused",
	"owner copy along a counted family of entering: filled",
	"owner copy along a counted family of after another family: filled",
	"owner copy along a counted family of counted count: refused",
	"owner copy along a counted family of counted end: refused",
	"predecessor copy along a sequence of entering: filled",
	"predecessor copy along a sequence of after another family: filled",
	"predecessor copy along a sequence of counted count: refused",
	"predecessor copy along a sequence of counted end: refused",
	"last copy along a sequence of entering: filled",
	"last copy along a sequence of after another family: filled",
	"last copy along a sequence of counted count: refused",
	"last copy along a sequence of counted end: refused"
]

/**
 * The stale box: every path a change takes to a value drawn only when its row is written, to every kind of such value.
 * Each relation holds `g` and is mutable.
 *
 * - `put through a copy`: R0 owns an ordered family of R1, whose owner copy reads R0's `v` or `g`, and a value along
 *   that family reads the copy; R0's put changes it.
 * - `put through two copies`: R1 owns an ordered family of R2 too, which copies R1's copy along its owner axis, and a
 *   value along it reads that copy.
 * - `edit of a member owner`: R0 owns an ordered family of R1 and R1 one of R2, and a value along the first reads R1's
 *   count of the second, its fold's end, or its last copy of R2's `v`; R2's put or delete edits it.
 * - `edit of a tree node`: R0 is a tree's relation and owns an ordered family of R1, and a value along the tree reads a
 *   node's count of that family, its fold's end or its last copy; R1's put or delete edits it.
 * - `edit through a copy`: R0 owns ordered families of R1 and of R2, R2's owner copy reads R0's count of R1's, and a
 *   value along R2's reads that copy; R1's put or delete edits it.
 * - `re-placed owner`: R0 owns an ordered family of R1, and R1 a counted family of R2 whose owner copy reads R1's `v`,
 *   `g` or index; R1's put or delete re-places R1's rows, deleting and inserting them again, which no cascade follows,
 *   so the copy itself is the value drawn again.
 * - `put beneath a fixed owner`: R0, immutable, owns an ordered family of R1, and R1 a counted family of R2, immutable
 *   too, whose owner copy reads R1's `v`; R1's put re-places nothing, an immutable owner's family being fixed, so the
 *   copy is carried by its cascade and nothing is drawn again, though a refill of R2 would be refused.
 * - `second-order refusal`: R0 has no family. R1 owns an ordered family of R2, whose sum steps R2's copy of R1's `v` or
 *   `g`, and a counted family of R3, an immutable relation, whose sum steps R3's copy of the first family's end. R1's put
 *   refills the first family, whose refill changes the end the second's members copy, a refill of an immutable
 *   relation's rows, refused at R1's put beside a put of R0, which every order of the ChangeSet's writes puts first.
 * - `chained refill`: the second-order refusal's families over a mutable R3: the first family's refill changes the end
 *   the second's members copy, a value that reads what a refill itself changes, which grizzle does not refill in turn,
 *   refused at R1's put beside a put of R0.
 *
 * The value is a predecessor copy, a last copy, along a tree's owner axis a node's copy of its parent's, or, after a
 * put, a sum fold stepping the copy, which the member row's own CHECK judges.
 */
type StalePath =
	| "put through a copy"
	| "put through two copies"
	| "edit of a member owner"
	| "edit of a tree node"
	| "edit through a copy"
	| "re-placed owner"
	| "put beneath a fixed owner"
	| "second-order refusal"
	| "chained refill"

interface StaleShape {
	readonly path: StalePath
	readonly reader: Axis | "step"
	readonly source: "caller" | "generated" | "count" | "fold" | "last copy" | "index"
}

const staleShapeGen: Gen<StaleShape> = (source) => ({
	path: source.draw(
		element([
			"put through a copy",
			"put through two copies",
			"edit of a member owner",
			"edit of a tree node",
			"edit through a copy",
			"re-placed owner",
			"put beneath a fixed owner",
			"second-order refusal",
			"chained refill"
		] as const)
	),
	reader: source.draw(element(["predecessor", "last", "owner", "step"] as const)),
	source: source.draw(
		element(["caller", "generated", "count", "fold", "last copy", "index"] as const)
	)
})

/** The specification of a stale shape, or none where the path reads no such column or the axis carries none. */
const staleSpec = (shape: StaleShape): FillSpec | undefined => {
	const relation = { generated: true, mutable: true }
	const relations: FillSpec["relations"] = [relation, relation, relation]
	if (shape.path === "second-order refusal" || shape.path === "chained refill") {
		return shape.reader === "step" && (shape.source === "caller" || shape.source === "generated")
			? {
					relations: [
						relation,
						relation,
						relation,
						{ ...relation, mutable: shape.path === "chained refill" }
					],
					families: [
						{ kind: "ordered", owner: 1, member: 2, fold: "sum" },
						{ kind: "counted", owner: 1, member: 3, fold: "sum" }
					],
					copies: [
						{
							family: 0,
							axis: "owner",
							source: shape.source === "generated" ? { kind: "generated" } : { kind: "caller" }
						},
						{ family: 1, axis: "owner", source: { kind: "fold", family: 0 } }
					],
					steps: [
						{ family: 0, copy: 0 },
						{ family: 1, copy: 1 }
					]
				}
			: undefined
	}
	if (shape.path === "put beneath a fixed owner") {
		return shape.reader === "owner" && shape.source === "caller"
			? {
					relations: [{ ...relation, mutable: false }, relation, { ...relation, mutable: false }],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 1, member: 2, fold: "none" }
					],
					copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
					steps: []
				}
			: undefined
	}
	if (shape.path === "re-placed owner") {
		return shape.reader === "owner" &&
			(shape.source === "caller" || shape.source === "generated" || shape.source === "index")
			? {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 1, member: 2, fold: "none" }
					],
					copies: [
						{
							family: 1,
							axis: "owner",
							source:
								shape.source === "index"
									? { kind: "index", family: 0 }
									: shape.source === "generated"
										? { kind: "generated" }
										: { kind: "caller" }
						}
					],
					steps: []
				}
			: undefined
	}
	const put = shape.path === "put through a copy" || shape.path === "put through two copies"
	const source = shape.source
	if (source === "index" || put !== (source === "caller" || source === "generated")) {
		return undefined
	}
	if (
		(shape.reader === "owner" && shape.path !== "edit of a tree node") ||
		(shape.reader === "step" && !put)
	) {
		return undefined
	}
	/** The axis a copy reader rides, a step's being none: its fold steps the copy instead. */
	const axis: Axis = shape.reader === "step" ? "owner" : shape.reader
	const ownerSource: CopySource =
		source === "generated" ? { kind: "generated" } : { kind: "caller" }
	const fold = source === "fold" ? "sum" : "none"
	const lastCopy = source === "last copy"
	const edited = (family: number, copy: number): CopySource => {
		switch (source) {
			case "fold":
				return { kind: "fold", family }
			case "last copy":
				return { kind: "copy", copy }
			case "caller":
			case "generated":
			case "count":
				return { kind: "count", family }
		}
	}
	const spec = ((): FillSpec | undefined => {
		switch (shape.path) {
			case "put through a copy":
				return shape.reader === "step"
					? {
							relations,
							families: [{ kind: "ordered", owner: 0, member: 1, fold: "sum" }],
							copies: [{ family: 0, axis: "owner", source: ownerSource }],
							steps: [{ family: 0, copy: 0 }]
						}
					: {
							relations,
							families: [{ kind: "ordered", owner: 0, member: 1, fold: "none" }],
							copies: [
								{ family: 0, axis: "owner", source: ownerSource },
								{ family: 0, axis, source: { kind: "copy", copy: 0 } }
							],
							steps: []
						}
			case "put through two copies":
				return {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{
							kind: "ordered",
							owner: 1,
							member: 2,
							fold: shape.reader === "step" ? "sum" : "none"
						}
					],
					copies: [
						{ family: 0, axis: "owner", source: ownerSource },
						{
							family: 1,
							axis: "owner",
							source: shape.reader === "step" ? ownerSource : { kind: "copy", copy: 0 }
						},
						...(shape.reader === "step"
							? []
							: [{ family: 1, axis, source: { kind: "copy", copy: 1 } } as const])
					],
					steps: shape.reader === "step" ? [{ family: 1, copy: 1 }] : []
				}
			case "edit of a member owner":
				return {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "ordered", owner: 1, member: 2, fold }
					],
					copies: [
						...(lastCopy ? [{ family: 1, axis: "last", source: { kind: "caller" } } as const] : []),
						{ family: 0, axis, source: edited(1, 0) }
					],
					steps: []
				}
			case "edit of a tree node":
				return {
					relations,
					families: [
						{ kind: "tree", owner: 0, member: 0, fold: "none" },
						{ kind: "ordered", owner: 0, member: 1, fold }
					],
					copies: [
						...(lastCopy ? [{ family: 1, axis: "last", source: { kind: "caller" } } as const] : []),
						{ family: 0, axis, source: edited(1, 0) }
					],
					steps: []
				}
			case "edit through a copy":
				return shape.source === "count"
					? {
							relations,
							families: [
								{ kind: "ordered", owner: 0, member: 1, fold: "none" },
								{ kind: "ordered", owner: 0, member: 2, fold: "none" }
							],
							copies: [
								{ family: 1, axis: "owner", source: { kind: "count", family: 0 } },
								{ family: 1, axis, source: { kind: "copy", copy: 0 } }
							],
							steps: []
						}
					: undefined
		}
	})()
	return spec !== undefined &&
		Arr.every(spec.copies, (c, j) =>
			Arr.some(sourcesFor(spec, c.family, c.axis, j), (s) => deepEquals(s, c.source))
		)
		? spec
		: undefined
}

/**
 * The refills the box requires: every path's, every kind of value refilled, a put from a query refused, and a role
 * refused for each relation a refill writes or reads it leaves out, and compiled where it leaves out none.
 */
const staleSituations: Arr.NonEmptyReadonlyArray<FillSituation> = [
	"refilled: a value through a copy after a put",
	"refused: a member's own write reaching another family's value",
	"refilled: a value through a copy after an edit",
	"refilled: a predecessor copy",
	"refilled: a last copy",
	"refused: a refill of a tree's values",
	"refused: a refill reading another refill's change",
	"refilled: a copy of an owner an edit re-places",
	"compiled: a put beneath an immutable owner, which re-places nothing",
	"refilled: a fold over a copy",
	"refused: the write a refill starts from, beside a plain put named first",
	"refused: a put from a query that a refill would draw",
	"refused: a role that does not hold a relation a refill writes or reads",
	"compiled: a role that holds every relation a refill writes and reads"
]

/**
 * The sibling box: an owner R0 of two sequences, a tree on R0 or an ordered family of R1, then an ordered family of R2,
 * each ending in a fold or in a last copy of its members' `v`, and a copy along one sequence's owner axis of the
 * other's end, or along each one's of the other's. The walk fills the sequence whose end a copy reads first, so one
 * copy is filled, and two that read each other's end are refused, since no order fills either sequence first.
 */
interface Siblings {
	readonly first: "tree" | "ordered"
	readonly end: "fold" | "last copy"
	readonly reads:
		| "the first reads the second"
		| "the second reads the first"
		| "each reads the other"
}

const siblingsGen: Gen<Siblings> = (source) => ({
	first: source.draw(element(["tree", "ordered"] as const)),
	end: source.draw(element(["fold", "last copy"] as const)),
	reads: source.draw(
		element([
			"the first reads the second",
			"the second reads the first",
			"each reads the other"
		] as const)
	)
})

/** The specification of a sibling shape (`Siblings`). */
const siblingsSpec = (shape: Siblings): FillSpec => {
	const relation = { generated: false, mutable: false }
	const fold = shape.end === "fold" ? "sum" : "none"
	const lasts: ReadonlyArray<FillSpec["copies"][number]> =
		shape.end === "last copy"
			? [
					{ family: 0, axis: "last", source: { kind: "caller" } },
					{ family: 1, axis: "last", source: { kind: "caller" } }
				]
			: []
	const endOf = (f: number): CopySource =>
		shape.end === "fold" ? { kind: "fold", family: f } : { kind: "copy", copy: f }
	const reads = (f: number, other: number): FillSpec["copies"][number] => ({
		family: f,
		axis: "owner",
		source: endOf(other)
	})
	return {
		relations: [relation, relation, relation],
		families: [
			shape.first === "tree"
				? { kind: "tree", owner: 0, member: 0, fold }
				: { kind: "ordered", owner: 0, member: 1, fold },
			{ kind: "ordered", owner: 0, member: 2, fold }
		],
		copies: [
			...lasts,
			...(shape.reads === "the second reads the first" ? [] : [reads(0, 1)]),
			...(shape.reads === "the first reads the second" ? [] : [reads(1, 0)])
		],
		steps: []
	}
}

/** A sibling shape's situation: what reads what, and whether the reference's walk fills it. */
type SiblingSituation = `${Siblings["reads"]}: ${"filled" | "refused"}`

const siblingSituations: Arr.NonEmptyReadonlyArray<SiblingSituation> = [
	"the first reads the second: filled",
	"the second reads the first: filled",
	"each reads the other: refused"
]

describe("the fill order: a schema generate accepts is one every write of fills", () => {
	it.effect(
		"drawn schemas compile exactly where the reference model admits them, and then write",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/fill-order",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<FillSituation>(fillSituations, { cases: 240, sense: notesOnly }),
						kept: Arr.map(stepsOfSequenceCopies, ({ note, sketch }) => ({
							note,
							sketch,
							draws: "",
							reaches: [
								"admitted",
								"admitted: a counted fold stepping a sequence's copy of its owner's"
							]
						})),
						runs: 100,
						shrink: boundedShrink(400),
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the reference model of the fill order and the reference writer (families/fill.ts)"
						}
					},
					(drawnCase, c) => {
						const { spec, rows, followUp } = aimedCase(drawnCase, c)
						return property(spec, rows, followUp, (s) => c.note(s))
					}
				)
			)
	)

	it.effect(
		"every copy kind along every axis, under owners of every standing, compiles exactly where the model admits it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fill-order-box",
						generator: shapeGen,
						literal: Formatter.format,
						limit: 400,
						box: "one family of each kind under a top, a nested or a tree-node owner, one copy along each axis of each column kind its target row holds, and the instance of every count at its most",
						oracle: {
							kind: "second-implementation",
							name: "the reference model of the fill order and the reference writer (families/fill.ts)"
						},
						coverage: requiredInSpace<BoxSituation>(boxSituations),
						caseHang
					},
					(shape, c) =>
						Effect.gen(function* () {
							const spec = shapeSpec(shape)
							if (spec === undefined) {
								return
							}
							const j = spec.copies.length - 1
							const copy = defined(spec.copies[j])
							const verdict = verdictOf(spec)
							const refused =
								verdict.kind === "unfillable" && Arr.some(verdict.copies, (x) => x.copy === j)
							const counted = defined(spec.families[copy.family]).kind === "counted"
							const situation: BoxSituation = `${copy.axis} copy along ${counted ? "a counted family" : "a sequence"} of ${sourceClassOf(spec, j)}: ${refused ? "refused" : "filled"}`
							c.note(situation)
							yield* property(spec, fullInstance(spec), Option.none(), () => undefined)
						})
				)
			)
	)

	it.effect(
		"every path a change takes to a value drawn only when its row is written is refilled, refused only from a query or for a role that does not hold it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fill-order-stale",
						generator: staleShapeGen,
						literal: Formatter.format,
						limit: 216,
						box: "an owner's put through one copy or two, and an edit of a family of a member owner, of a tree node or of the owner a copy reads, to a predecessor copy, a last copy, a tree's copy or a sum fold stepping the copy, and a put or a delete re-placing an ordered family's member whose counted members copy its v, g or index, over mutable relations holding g; a put of an immutable owner's member whose immutable counted members copy its v, which re-places nothing; a refill's refill of an immutable relation's rows, and of a mutable one's, which reads what the first refill changes, each write named after a plain put; each put from a query too, and each write under a role leaving out each relation in turn",
						oracle: {
							kind: "second-implementation",
							name: "the reference's refills (families/fill.ts writesVerdict, refillsOf)"
						},
						coverage: requiredInSpace<FillSituation>(staleSituations),
						caseHang
					},
					(shape, c) =>
						Effect.gen(function* () {
							const spec = staleSpec(shape)
							if (spec === undefined) {
								return
							}
							yield* property(spec, fullInstance(spec), Option.none(), (s) => c.note(s))
							if (shape.path === "put beneath a fixed owner") {
								c.note("compiled: a put beneath an immutable owner, which re-places nothing")
							}
							guards(spec, (s) => c.note(s))
						})
				)
			)
	)

	it.effect(
		"a copy of a sibling sequence's end is filled after that sibling, and two that read each other's are refused",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fill-order-siblings",
						generator: siblingsGen,
						literal: Formatter.format,
						limit: 12,
						box: "an owner of a tree or an ordered family and an ordered family, each ending in a fold or a last copy, with a copy along one's owner axis of the other's end, or along each one's",
						oracle: {
							kind: "second-implementation",
							name: "the reference model of the fill order and the reference writer (families/fill.ts)"
						},
						coverage: requiredInSpace<SiblingSituation>(siblingSituations),
						caseHang
					},
					(shape, c) =>
						Effect.gen(function* () {
							const spec = siblingsSpec(shape)
							const refused = verdictOf(spec).kind !== "admitted"
							c.note(`${shape.reads}: ${refused ? "refused" : "filled"}`)
							yield* property(spec, fullInstance(spec), Option.none(), () => undefined)
						})
				)
			)
	)
})
