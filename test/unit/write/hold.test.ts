/**
 * A write over a retirable unit holds every group it touches before it touches it (write/hold/stated.ts heldUnits,
 * write/schedule/plan.ts placeHolds, write/hold/statement.ts buildHold): a ChangeSet that reads or writes a body, or
 * reads the header's retirement field, at a group it does not state is refused when it compiles (UnheldGroup); one that
 * states every group it touches calls the unit's hold once, before every statement that names a body's table, with
 * every member slot of a body and every parameter that states a group.
 *
 * The box, constructed: a unit of Root (its retirement field `retired`), Step and Claim, both grouped by `root`, Claim
 * contained in Step; Other and Seen beside it. One stratum of one to three members drawn from: Root inserted from an
 * array; Step or Claim inserted, put or deleted from an array; Step inserted from a query over Other whose head binds
 * `root` to the parameter `g`, to a variable a conjunct pins to `g`, or to Other's id; Other inserted from a query that
 * matches Step with `root` bound to `g`, pinned to `g`, joined to Other's id, or left out; Seen inserted from a query that
 * matches Root binding its retirement field, at `g` or at Other's id, or not binding it; and a read-back of Step at `g`,
 * of Step joined to Other, of Step's added delta (where at most one member writes Step: a delta two statements make is
 * no read-back's, ReadBackCrossesStatements), or none.
 *
 * Oracle: the rule restated over the drawing. Each member and read-back touches the unit or not, and states the groups
 * it touches or not: an array of a body states them; a query states them where `root`, Root's `id` for its retirement
 * field, is bound to `g` or pinned to it; a delta reads nothing stored; Root and Other written touch nothing. The
 * ChangeSet is refused exactly where some touch is unstated, naming one of them (its relation and why); otherwise it
 * holds exactly where something touches the unit, in one statement that reads each body array's member slot, through
 * its placeholders or the carrier the slot is staged in where two statements read it (write/program/slot-carriers.ts),
 * and binds `g` where a parameter states a group, before every statement that names Step's or Claim's table, and no member
 * slot of a body any other statement reads is missing from it. Where it inserts Root, Root's insert precedes the hold,
 * so the group it creates is open when the hold locks it (write/frontend/schedule.ts UnitOrder); but where a member
 * reads Root's retirement field, that read sees the stratum's starting state, so it runs before Root's insert, and the
 * hold, before it, precedes Root's insert too.
 *
 * Features: refused unbound, refused written, refused for a retirement read; held by a body array, by `g`, by a pinned
 * variable, for a retirement read, for a read-back; held after Root's insert; held before Root's insert, for a
 * retirement read; nothing held.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { slotsRead } from "#test/support/slot-carriers.ts"
import {
	compiledOf,
	drawnGen,
	type HoldFeature,
	isBody,
	modelOf,
	objectsOf,
	tableOf,
	whyField
} from "#test/unit/write/hold.fixtures.ts"

/**
 * A write over a retirable unit is refused at a group it does not state, and otherwise holds every group it touches
 * before it touches it.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/write/hold.test.ts:402 at 8cad5bce, its runs and its coverage's cases).
 */
export const aWriteOverARetirableUnitIsRefusedAtAGroupItDoesNotStateAndOtherwiseHoldsEveryGroupItTouchesBeforeItTouchesIt =
	property.explore(drawnGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"refused: unbound",
			"refused: written",
			"refused: a retirement read",
			"held by a body array",
			"held by g",
			"held by a pinned variable",
			"held for a retirement read",
			"held for a read-back",
			"held after Root's insert",
			"held before Root's insert, for a retirement read",
			"nothing held"
		] satisfies ReadonlyArray<Reached<HoldFeature>>,
		check: (_, c: Case<HoldFeature>) => (d) =>
			Effect.sync(() => {
				const model = modelOf(d)
				const program = compiledOf(d)
				if (Arr.isReadonlyArrayNonEmpty(model.unstated)) {
					if (program.ok) {
						return assert.fail(
							`compiled, as the model holds an unstated touch: ${Formatter.format(model.unstated)}`
						)
					}
					const reason = program.error.reason
					if (reason._tag !== "UnheldGroup") {
						return assert.fail(`refused as ${reason._tag}, not UnheldGroup`)
					}
					assert.equal(reason.header, "Root")
					const why = reason.why
					const field = whyField(why)
					assert.ok(
						Arr.some(
							model.unstated,
							(u) => u.relation === reason.relation && u.why === why.kind && u.field === field
						),
						`${reason.relation} ${why.kind} ${String(field)} is one of ${Formatter.format(model.unstated)}`
					)
					c.note(
						reason.relation === "Root"
							? "refused: a retirement read"
							: why.kind === "written"
								? "refused: written"
								: "refused: unbound"
					)
					return
				}
				const artifact = succeeded(program, "the ChangeSet compiles").artifact
				const statements = artifact.statements
				const holds = Arr.filter(statements, (s) => s.step.kind === "hold")
				if (!model.touches) {
					assert.deepEqual(holds, [], "nothing touches the unit, so nothing holds it")
					c.note("nothing held")
					return
				}
				assert.equal(holds.length, 1, "one hold of the unit")
				const hold = defined(holds[0], "the hold")
				assert.ok(
					hold.step.kind === "hold" && hold.step.header === "Root",
					"the hold of Root's unit"
				)
				const bodies = [tableOf("Step"), tableOf("Claim")]
				const touching = Arr.filter(statements, (s) =>
					Arr.some(objectsOf(s), (o) => bodies.includes(o))
				)
				for (const s of touching) {
					assert.ok(
						hold.index < s.index,
						`the hold at ${hold.index} precedes statement ${s.index}, which names a body's table`
					)
				}
				if (model.header !== "none") {
					const root = tableOf("Root")
					const inserted = Arr.filter(
						statements,
						(s) => s.step.kind === "write" && s.step.relation === "Root"
					)
					assert.ok(Arr.isReadonlyArrayNonEmpty(inserted), `Root's insert (${root})`)
					for (const s of inserted) {
						assert.equal(
							s.index < hold.index,
							model.header === "beforeHold",
							`Root's insert at ${s.index} ${model.header === "beforeHold" ? "precedes" : "follows"} the hold at ${hold.index} (${root})`
						)
					}
					c.note(
						model.header === "beforeHold"
							? "held after Root's insert"
							: "held before Root's insert, for a retirement read"
					)
				}
				const slots = hold.spec.paramSlots
				const params = Arr.dedupe(
					Arr.flatMap(slots, (s): ReadonlyArray<string> => (s.kind === "scalar" ? [s.param] : []))
				)
				assert.deepEqual(params, model.byParam ? ["g"] : [], "the parameters stating a group")
				const members = slotsRead(artifact, hold)
				assert.deepEqual(
					Arr.sort(Arr.dedupe(Arr.map([...members.values()], (s) => s.relation)), Order.String),
					Arr.sort([...model.slots], Order.String),
					"the body arrays stating a group"
				)
				for (const s of statements) {
					for (const slot of slotsRead(artifact, s).values()) {
						if (isBody(slot.relation)) {
							assert.ok(
								members.has(slot.slot),
								`statement ${s.index} reads ${slot.relation}'s slot ${slot.slot}, which the hold reads`
							)
						}
					}
				}
				if (model.slots.size > 0) {
					c.note("held by a body array")
				}
				if (
					Arr.some(
						d.members,
						(m) => (m.kind === "read" || m.kind === "written") && m.bind === "pinned"
					)
				) {
					c.note("held by a pinned variable")
				}
				if (model.byParam) {
					c.note("held by g")
				}
				if (Arr.some(d.members, (m) => m.kind === "retirement" && m.bind === "param")) {
					c.note("held for a retirement read")
				}
				if (d.readBack === "param") {
					c.note("held for a read-back")
				}
			}),
		oracle: { kind: "specification", name: "the hold rule restated over the drawing" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					'\t\treturn [...placed.slice(0, at), { kind: "hold", hold }, ...placed.slice(at)]',
				replacement: "\t\treturn placed",
				why: "No hold placed (write/schedule/plan.ts placeHolds)."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					'\t\treturn [...placed.slice(0, at), { kind: "hold", hold }, ...placed.slice(at)]',
				replacement:
					'\t\treturn [...placed.slice(0, at + 1), { kind: "hold", hold }, ...placed.slice(at + 1)]',
				why: "The hold placed after the first statement that touches the unit."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original: "\t\t\t\tif (touch !== header && !follows(header, touch)) {",
				replacement:
					"\t\t\t\tif (touch !== header && !follows(header, touch) && units.length < 0) {",
				why: "No edge from a header's insertion to the statements touching its unit (write/frontend/schedule.ts)."
			}
		]
	})
