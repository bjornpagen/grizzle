/**
 * A ChangeSet retires a retirable unit's groups by its retire members (ChangeSet.retire), and nothing else of it reads or
 * writes the unit (write/hold/stated.ts heldUnits, RetiredUnitTouched; write/frontend/compile.ts, its retire slot groups;
 * write/schedule/plan.ts planWrite, its retire steps; write/hold/statement.ts buildRetire).
 *
 * The box, constructed: a unit of Root (its retirement field `retired`), Step and Claim, both grouped by `root`, Claim
 * contained in Step; Other beside it. A ChangeSet over the schema, over a role that inserts Other and retires Root, or
 * over a role that inserts every relation and retires nothing, of one or two strata, each of up to three members drawn
 * from: Root retired from an array or a Stream; Other inserted from an array; Step or Root inserted from an array, a
 * write of the unit; Other inserted from a query matching Step at `g`, or Root's retirement field at `g`, a read of it;
 * and a read-back of Other, of Step at `g`, of Other's, Step's or Root's added delta, or none.
 *
 * Oracle: the rule restated over the drawing. A retire member over a role whose retire list leaves Root out is refused
 * as OutsideRole (`retire`, Root); one beside a write, a read or a delta read of the unit is refused as
 * RetiredUnitTouched, naming one of them by its relation and how. Otherwise the ChangeSet compiles: each stratum holding
 * a retire member retires Root's groups in one statement of its own, the retirement step of its stratum's position
 * among the occupied strata, reading the one slot of its stratum's retire members' groups, which no other statement
 * reads, after every other statement of its stratum and before every statement of a later one; a stratum holding
 * none retires nothing; and no statement holds the unit a ChangeSet retires. A ChangeSet that retires nothing is
 * refused, where it is, for no retirement, and compiles no retirement where it compiles. A read-back of Other's added
 * delta is drawn only beside one member writing Other: a delta two statements make is no read-back's.
 *
 * Features: refused outside the role, refused for a write, a read and a delta of the unit; retired from an array, from a
 * Stream, beside a write of Other, in two strata, over the retirer role; nothing retired.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { succeeded } from "#test/support/assert.ts"
import { slotsRead } from "#test/support/slot-carriers.ts"
import {
	compiledOf,
	drawnGen,
	modelOf,
	occupiedIndex,
	type RetireFeature,
	retireSlot
} from "#test/unit/write/retire.fixtures.ts"

/**
 * A ChangeSet retires a retirable unit's groups in one statement for each stratum that retires them, and is refused
 * where a role does not retire the unit or anything else of it reads or writes the unit.
 *
 * Budget: 400 runs and 400 steered cases, the hold property's beside it (test/unit/write/hold.test.ts), whose box this
 * one's unit is.
 */
export const aChangeSetRetiresAUnitsGroupsInOneStatementForEachStratumThatRetiresThemAndIsRefusedWhereItsRoleDoesNotRetireTheUnitOrAnythingElseOfItReadsOrWritesTheUnit =
	property.explore(drawnGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"refused: outside the role",
			"refused: a write of the unit",
			"refused: a read of the unit",
			"refused: a delta of the unit",
			"retired from an array",
			"retired from a Stream",
			"retired beside a write of Other",
			"retired in two strata",
			"retired over the retirer role",
			"nothing retired"
		] satisfies ReadonlyArray<Reached<RetireFeature>>,
		check: (_, c: Case<RetireFeature>) => (d) =>
			Effect.sync(() => {
				const model = modelOf(d)
				const program = compiledOf(d)
				const retires = Arr.isReadonlyArrayNonEmpty(model.retiring)
				if (retires && d.world === "writer") {
					if (program.ok) {
						return assert.fail("compiled, as the writer role retires nothing")
					}
					const reason = program.error.reason
					assert.ok(
						reason._tag === "OutsideRole" &&
							reason.access.kind === "retire" &&
							reason.access.relation === "Root",
						`refused as OutsideRole retire of Root, not ${Formatter.format(reason)}`
					)
					c.note("refused: outside the role")
					return
				}
				if (retires && Arr.isReadonlyArrayNonEmpty(model.touches)) {
					if (program.ok) {
						return assert.fail(
							`compiled, as the model holds touches of the retired unit: ${Formatter.format(model.touches)}`
						)
					}
					const reason = program.error.reason
					if (reason._tag !== "RetiredUnitTouched") {
						return assert.fail(`refused as ${reason._tag}, not RetiredUnitTouched`)
					}
					assert.equal(reason.header, "Root")
					assert.ok(
						Arr.some(model.touches, (t) => t.relation === reason.relation && t.how === reason.how),
						`${reason.relation} ${reason.how} is one of ${Formatter.format(model.touches)}`
					)
					c.note(
						reason.how === "written"
							? "refused: a write of the unit"
							: reason.how === "read"
								? "refused: a read of the unit"
								: "refused: a delta of the unit"
					)
					return
				}
				if (!retires) {
					if (program.ok) {
						assert.deepEqual(
							Arr.filter(program.value.artifact.statements, (s) => s.step.kind === "retire"),
							[],
							"nothing retires Root"
						)
					} else {
						const reason = program.error.reason
						assert.ok(
							reason._tag !== "RetiredUnitTouched" &&
								!(reason._tag === "OutsideRole" && reason.access.kind === "retire"),
							`a ChangeSet that retires nothing is refused for no retirement: ${Formatter.format(reason)}`
						)
					}
					c.note("nothing retired")
					return
				}
				const artifact = succeeded(program, "the ChangeSet compiles").artifact
				const statements = artifact.statements
				const retirements = Arr.filter(statements, (s) => s.step.kind === "retire")
				assert.deepEqual(
					Arr.filter(statements, (s) => s.step.kind === "hold"),
					[],
					"no statement holds the unit the ChangeSet retires"
				)
				assert.deepEqual(
					Arr.map(retirements, (s): number => (s.step.kind === "retire" ? s.step.stratum : -1)),
					Arr.map(model.retiring, (s) => occupiedIndex(d, s)),
					"one retirement for each stratum that retires, at its position among the occupied strata"
				)
				for (const [at, s] of model.retiring.entries()) {
					const statement = Arr.getUnsafe(retirements, at)
					const step = statement.step
					if (step.kind !== "retire") {
						return assert.fail("a retirement's step")
					}
					assert.equal(step.header, StoredRelationName("Root"))
					assert.deepEqual(
						Arr.sort(step.bodies, Order.String),
						[StoredRelationName("Claim"), StoredRelationName("Step")],
						"the unit's bodies"
					)
					const slot = ParamId(retireSlot(s))
					const read = slotsRead(artifact, statement)
					assert.ok(
						read.size === 1 && read.has(slot),
						`the retirement reads its stratum's retire slot ${slot} alone`
					)
					for (const other of statements) {
						if (other === statement) {
							continue
						}
						assert.ok(
							!slotsRead(artifact, other).has(slot),
							`statement ${other.index} reads no retire slot`
						)
						const stratum = "stratum" in other.step ? other.step.stratum : undefined
						if (stratum === step.stratum) {
							assert.ok(
								other.index < statement.index,
								`statement ${other.index} of its stratum precedes the retirement at ${statement.index}`
							)
						}
						if (stratum !== undefined && stratum > step.stratum) {
							assert.ok(
								other.index > statement.index,
								`statement ${other.index} of a later stratum follows the retirement at ${statement.index}`
							)
						}
					}
				}
				const members = d.strata.flat()
				if (Arr.some(members, (m) => m.kind === "retire" && m.source === "array")) {
					c.note("retired from an array")
				}
				if (Arr.some(members, (m) => m.kind === "retire" && m.source === "stream")) {
					c.note("retired from a Stream")
				}
				if (Arr.some(members, (m) => m.kind === "other")) {
					c.note("retired beside a write of Other")
				}
				if (model.retiring.length > 1) {
					c.note("retired in two strata")
				}
				if (d.world === "retirer") {
					c.note("retired over the retirer role")
				}
			}),
		oracle: { kind: "specification", name: "the retire rule restated over the drawing" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\t\t\t\tretired.stratum === s ? [{ kind: "retire", retired }] : []',
				replacement: "\t\t\t\t[]",
				why: "No retirement placed (write/schedule/plan.ts planWrite)."
			},
			{
				file: "packages/engine/src/write/hold/stated.ts",
				original: "\t\tif (retired.has(place.unit.header)) {",
				replacement: '\t\tif (retired.has(place.unit.header) && how === "delta") {',
				why: "A write or a read of a retired unit admitted beside its retirement (write/hold/stated.ts heldUnits touched)."
			},
			{
				file: "packages/engine/src/write/hold/stated.ts",
				original: '\t\t\t\ttouched(at, place, "delta")',
				replacement: "\t\t\t\tvoid place",
				why: "A delta of a retired unit read beside its retirement, which no statement makes (write/hold/stated.ts heldUnits)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\t\t: world.role.retire.includes(name)",
				replacement: "\t\t\t\t: world.role.retire.includes(name) || name.length > 0",
				why: "A role's retire list ignored: a role that retires nothing retires (write/frontend/compile.ts retiredOf)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: '\t\t\tconst id = ParamId(reservedSlot(s, "retire", header))',
				replacement: '\t\t\tconst id = ParamId(reservedSlot(0, "retire", header))',
				why: "Every stratum's retirement reads the first stratum's slot, so a later stratum retires the first one's groups."
			}
		]
	})
