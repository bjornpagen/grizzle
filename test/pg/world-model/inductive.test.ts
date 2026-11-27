/**
 * The worlds invariants, checked inductively: rather than reaching states by walks of actions, a case draws a state
 * directly (an installation, the documents base's own, one with an editor beside, or one whose visits hold a roster's
 * handles (installsGen), a lawful reality the owner loads,
 * half the time with a document at its bound of shares, Db sessions of any roles of any logins with any claims their tokens
 * carry, those Dbs' reads spread over the logins' pooled connections, a pool of one connection per login half the
 * time, so its Dbs of every role share it, and then a direct writer with any current role of its login and any claims,
 * malformed ones among them, set for the transaction or the session; or a migration past the Dbs' snapshot, completed
 * or stopped half-applied, which leaves them stale and its drafted snapshot one an open may name; or a lead's moves,
 * which build a state one action before what it reaches: a transaction begun in the shape a pending feature needs, one
 * statement in or one delete in, a Db one apply in, a Db opened, or a derived relation a Db left stale (drive/suite.ts
 * inductiveLeads)), brings the real system to it, and
 * then performs ONE action drawn there, valid or invalid, aimed where a steered turn aims the case at a required
 * situation no case reached yet that the state offers (drive/suite.ts aimsAt, steeredOnce), what its turn aimed it at
 * resolved as it was drawn (inductive.fixtures.ts inductiveSpace).
 * The observation must be one the worlds model allows, and the state the model enters must keep every invariant and be
 * the real system's: its stored relations and every open session's probe. An action from any such state that breaks an
 * invariant is a counterexample no reachable-states search needs to find a path to.
 *
 * The setup's actions are driven and checked like any other, but they note nothing: what a case reached is its one
 * action. Each case runs in a database of its own: a case within its database (inductive.fixtures.ts Reach) of a fixed
 * installation clones that installation's template, and every other case installs its own.
 */
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	inductiveNeeds,
	inductiveSpace,
	inductiveWorld,
	installOf,
	poolSizeOf,
	reachedPlan,
	setupOf,
	situations,
	startOf
} from "#test/pg/world-model/inductive.fixtures.ts"
import { runStep } from "#test/support/worlds/drive/index.ts"
import {
	drawAction,
	type LeadMove,
	leadOf,
	moveAction,
	stage,
	unnoted
} from "#test/support/worlds/drive/suite.ts"
import type { ModelState, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Every invariant holds after one action from any generated state. Its budget is its own: its required situations need
 * more steered cases than the runner's 200, 384 at it.
 */
export const inductive = property.explore(inductiveSpace, {
	needs: inductiveNeeds,
	situations,
	oracle: {
		kind: "second-implementation",
		name: "the worlds model (test/support/worlds/model) over a drawn state: the one action's allowed observations, the stored relations, every open session's probe and every invariant"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original: '\t\t\treturn "ENABLE ROW LEVEL SECURITY"',
			replacement: '\t\t\treturn "DISABLE ROW LEVEL SECURITY"',
			why: "Every table's ENABLE ROW LEVEL SECURITY is printed as DISABLE (sql/print.ts printAlterTableAction), so no relation's row security keeps a world to its own facts; the installed-catalog check finds it at the installation."
		},
		{
			file: "packages/engine/src/deploy/ledger/ledger.ts",
			original: '\t\t\ttargetAs(localSetting(claimsSettingName, 3), "c3")',
			replacement:
				'\t\t\ttargetAs(call("set_config", [lit.text(claimsSettingName, types.text), param(3, types.text), lit.bool(false)]), "c3")',
			why: "A Db's claims set for the session, not the transaction, so a pooled connection holds them between transactions; the driver's probe fails."
		}
	],
	show: Formatter.format,
	budget: { runs: 64, steered: 640 },
	check: (resources, c: Case<WorldFeature>) => (sketch) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { ic, realities, action: aimed, pending } = startOf(sketch)
				const setup = setupOf(ic.plan)
				const poolSize = poolSizeOf(ic)
				const world = yield* inductiveWorld(resources, ic, poolSize)
				const staged = yield* stage(world, installOf(ic), c.draw, realities)
				const planned = yield* Effect.reduce(
					setup,
					(): ModelState => staged.start,
					(state, action, index) =>
						Effect.map(runStep(world, state, action, index, unnoted), (stepped) => stepped.next)
				)
				reachedPlan(planned, ic.plan)
				const moves: ReadonlyArray<LeadMove> =
					ic.plan.after.kind === "led"
						? leadOf(situations, ic.weights, planned, pending, c.draw)
						: []
				const reached = yield* Effect.reduce(
					moves,
					(): ModelState => planned,
					(state, move, index) =>
						Effect.map(
							runStep(world, state, moveAction(c.draw, state, move), setup.length + index, unnoted),
							(stepped) => stepped.next
						)
				)
				const action = drawAction(c.draw, reached, aimed)
				yield* runStep(world, reached, action, setup.length + moves.length, c)
			})
		)
})
