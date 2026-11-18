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
 *   for sequences nesting each other (`nestingCycle`), or for families, ordered or counted, nesting relations in a cycle
 *   below a unit's root (`unitCycle`, at a root the model finds a cycle below); UnfillableField for a copy whose
 *   source its row fills after it, naming the copy's relation, field, family, axis and source as the specification
 *   states them, for a cause the model gives. A counted family's member that is also an ordered family's member, a
 *   tree's node or a sequence's owner is admitted. The schema compiles as `grizzle generate` compiles it: its artifacts
 *   and its installation.
 * - **Every write program of its full role compiles over an admitted schema**: one ChangeSet inserting an instance of
 *   every relation a caller inserts (a sequence's members nested under their owners, a counted family's members by
 *   their group keys), which also binds, its family reads finding nothing stored; and each relation's own insert, put
 *   and delete wherever the README's rules admit them (an immutable owner's family fixed when it is inserted, a tree
 *   written whole, a sequence's members nested, and a family's member that owns a sequence written only nested). A
 *   delete of a relation that owns a family and is no other family's member removes its rows whole with every row
 *   nested under them, so where a nested relation is a member of a family whose owner it does not remove, it is
 *   refused when it compiles (UnsupportedOperation), as `wholeDeleteRefused` names. Families that nest the relations
 *   below it in a cycle are refused earlier, when the schema compiles (UnwritableRelation `unitCycle`, the reference's
 *   `unitCycleRoots`), so no admitted schema holds one.
 * - **The nested write fills what the reference writer fills** (fill.ts `writtenRows`): every field of every nested row
 *   the insert writes, a tree's to any depth, its interval, index, counts, fold ends and copies among them, but the
 *   counts, ends and copies a counted family's own fill writes later, a nested counted member's among them.
 * - **A later write compiles wherever its refills can be written** (fill.ts `writesVerdict`, a second implementation
 *   of analysis/theory/refill.ts): each relation's own insert, put and delete the rules admit, and a drawn follow-up
 *   over the stored instance (an owner's put beside appends to its families), compile, every value they leave stale
 *   drawn again by a refill of its family; only a refill that would update an immutable relation's rows in place is
 *   refused, StaleDerivedRead naming one the reference names. A write the reference finds written may still be refused
 *   as UnorderableStratum, which no reference of refills models, where the cycle it names is the schema's own: each
 *   of its family statements ordered before the next by an immediate reference or an owner copy of a drawn column the
 *   schema states (fill-order.fixtures.ts orderedBySchema), a certificate read off the schema, never a second
 *   statement of the schedule's order. The stale box exhausts every path a change takes to a
 *   stale value: an owner's put through one copy or two, and an edit of a family whose owner is a member, a tree node
 *   or the owner a copy reads, to each kind of value drawn only when its row is written; each compiles, the same put
 *   from a query is refused (StaleDerivedRead, `query`, grizzle never seeing the query's rows), and a role that leaves
 *   out one relation a refill writes or reads is refused (OutsideRole) naming exactly it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property as propertyOf, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { defined } from "#test/support/assert.ts"
import { fullInstance, sourceClassOf, verdictOf } from "#test/support/families/fill.ts"
import {
	type BoxSituation,
	boxSituations,
	fillDraw,
	type FillSituation,
	fillSituations,
	guards,
	property,
	shapeGen,
	shapeSpec,
	siblingsGen,
	type SiblingSituation,
	siblingSituations,
	siblingsSpec,
	staleShapeGen,
	staleSituations,
	staleSpec
} from "#test/unit/write/fill-order.fixtures.ts"

/**
 * The fill order: a schema generate accepts is one every write of fills drawn schemas compile exactly where the
 * reference model admits them, and then write.
 *
 * Budget: 100 runs and 240 steered cases, what its suite stated before it became a property
 * (test/unit/write/fill-order.test.ts:1575 at 8cad5bce, its runs and its coverage's cases).
 */
export const theFillOrderASchemaGenerateAcceptsIsOneEveryWriteOfFillsDrawnSchemasCompileExactlyWhereTheReferenceModelAdmitsThemAndThenWrite =
	propertyOf.explore(fillDraw, {
		needs: {},
		budget: { runs: 100, steered: 240 },
		situations: fillSituations satisfies ReadonlyArray<Reached<FillSituation>>,
		check:
			(_, c: Case<FillSituation>) =>
			({ spec, rows, followUp }) =>
				property(spec, rows, followUp, (s) => c.note(s)),
		oracle: {
			kind: "second-implementation",
			name: "the reference model of the fill order and the reference writer (families/fill.ts)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/write/fill-order.test.ts#theFillOrderASchemaGenerateAcceptsIsOneEveryWriteOfFillsDrawnSchemasCompileExactlyWhereTheReferenceModelAdmitsThemAndThenWrite:-:0.2.0.8.3.3.0.0.0.3.0.d.0.2.0.0.0.3.2.0.1.0.0.2.1.3.0.2.3.1.0.0.1.0.1.1.1.0.1.0.1.0.0.1.0.0.1.0"
				),
				reason:
					"a follow-up the schedule refuses as UnorderableStratum, its cycle the schema's own: R1's put and R2's insert, R1 naming R2 by an immediate owner axis and R2 copying R1's drawn index and copy",
				since: "2026-11-18"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\tconst need = [...f.group.map((g) => fieldKey(g.owner.name)), ...heldBy(f.owner, to)]",
				replacement:
					"\t\t\tconst need = [...f.group.map((g) => fieldKey(g.owner.name)), columnKey(to)]",
				why: "An owner copy of a generated column of owners the stratum inserts is read from the table after their statement, never from the fields its generation reads, so the kept case of TEST_SEED=2002821052 is refused as UnorderableStratum."
			},
			{
				file: "packages/engine/src/analysis/theory/fill.ts",
				original: "\tfor (const root of roots) {",
				replacement: "\tfor (const root of new Set<string>()) {",
				why: "The schema admits families that nest relations in a cycle below a unit's root (analysis/theory/fill.ts `unwritable` looking at no root), so the reference's UnwritableRelation unitCycle compiles; the kept case of the swarm's shrink fails."
			}
		]
	})

/** The fill order: a schema generate accepts is one every write of fills every copy kind along every axis, under owners of every standing, compiles exactly where the model admits it. */
export const theFillOrderASchemaGenerateAcceptsIsOneEveryWriteOfFillsEveryCopyKindAlongEveryAxisUnderOwnersOfEveryStandingCompilesExactlyWhereTheModelAdmitsIt =
	propertyOf.exhaust(finite(shapeGen), {
		needs: {},
		situations: boxSituations satisfies ReadonlyArray<Reached<BoxSituation>>,
		check: (_, c: Case<BoxSituation>) => (shape) =>
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference model of the fill order and the reference writer (families/fill.ts)"
		},
		box: "one family of each kind under a top, a nested or a tree-node owner, one copy along each axis of each column kind its target row holds, and the instance of every count at its most",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The fill order: a schema generate accepts is one every write of fills every path a change takes to a value drawn only when its row is written is refilled, refused only from a query or for a role that does not hold it. */
export const theFillOrderASchemaGenerateAcceptsIsOneEveryWriteOfFillsEveryPathAChangeTakesToAValueDrawnOnlyWhenItsRowIsWrittenIsRefilledRefusedOnlyFromAQueryOrForARoleThatDoesNotHoldIt =
	propertyOf.exhaust(finite(staleShapeGen), {
		needs: {},
		situations: staleSituations satisfies ReadonlyArray<Reached<FillSituation>>,
		check: (_, c: Case<FillSituation>) => (shape) =>
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference's refills (families/fill.ts writesVerdict, refillsOf)"
		},
		box: "an owner's put through one copy or two, and an edit of a family of a member owner, of a tree node or of the owner a copy reads, to a predecessor copy, a last copy, a tree's copy or a sum fold stepping the copy, and a put or a delete re-placing an ordered family's member whose counted members copy its v, g or index, over mutable relations holding g; a put of an immutable owner's member whose immutable counted members copy its v, which re-places nothing; a refill's refill of an immutable relation's rows, and of a mutable one's, which reads what the first refill changes, each write named after a plain put; each put from a query too, and each write under a role leaving out each relation in turn",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The fill order: a schema generate accepts is one every write of fills a copy of a sibling sequence's end is filled after that sibling, and two that read each other's are refused. */
export const theFillOrderASchemaGenerateAcceptsIsOneEveryWriteOfFillsACopyOfASiblingSequencesEndIsFilledAfterThatSiblingAndTwoThatReadEachOthersAreRefused =
	propertyOf.exhaust(finite(siblingsGen), {
		needs: {},
		situations: siblingSituations satisfies ReadonlyArray<Reached<SiblingSituation>>,
		check: (_, c: Case<SiblingSituation>) => (shape) =>
			Effect.gen(function* () {
				const spec = siblingsSpec(shape)
				const refused = verdictOf(spec).kind !== "admitted"
				c.note(`${shape.reads}: ${refused ? "refused" : "filled"}`)
				yield* property(spec, fullInstance(spec), Option.none(), () => undefined)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference model of the fill order and the reference writer (families/fill.ts)"
		},
		box: "an owner of a tree or an ordered family and an ordered family, each ending in a fold or a last copy, with a copy along one's owner axis of the other's end, or along each one's",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tif (sequence !== undefined && member.op === "insert") {',
				replacement: '\t\t\tif (sequence !== undefined && member.op !== "insert") {',
				why: "Operator mutant (comparison) at packages/engine/src/write/frontend/compile.ts:1321 in compile: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
