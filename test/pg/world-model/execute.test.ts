import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { unnoted } from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	EntrySpec,
	HostFact,
	HostState,
	InstallSpec
} from "#test/support/worlds/model/types.ts"

/**
 * What no drawn base reaches, on the documents installation (test/support/worlds/model/bases/docs.ts): a context field
 * typed by a contract, decoded from the token and read through a world, its claim outside the contract refused at
 * stage token once admission passed (README "Security model"), each step judged by the worlds model; and the executor's
 * leak scan, the oracle every worlds suite's "no hidden value" rests on, reporting a hidden token a refusal spells.
 */
const orgs = [
	"0a1e0001-7c3e-4a1b-9d2f-0e5c7a9b3d1f",
	"0a1e0002-7c3e-4a1b-9d2f-0e5c7a9b3d1f"
] as const

const reality: HostState = new Map<string, ReadonlyArray<HostFact>>([
	["Org", [{ id: orgs[0], plan: 1 }]],
	["Doc", [{ id: "0d0c0001-7c3e-4a1b-9d2f-0e5c7a9b3d1f", org: orgs[0], owner: "u_ann", words: 0 }]],
	["Share", []],
	["Note", []]
])

/** The documents installation's Plan contract, which the Org relation's plan field holds. */
const plan = { kind: "contract", name: "Plan", bits: 32, min: 0, max: 9 } as const

/** The member's organizations on the plan its token's `l` claim names: a context field of a contract, read by a query. */
const planOrgs: EntrySpec = {
	kind: "query",
	rules: [
		{
			matches: [
				{
					source: { kind: "ordinary", name: "Org" },
					fields: {
						id: { kind: "var", name: "org" },
						plan: { kind: "context", context: "Level", field: "plan" }
					}
				}
			],
			negations: [],
			comparisons: [],
			head: { org: { kind: "var", name: "org" } }
		}
	]
}

/** The documents installation with a context `Level` of one contract field, read by the member's PlanOrgs. */
const planInstall: InstallSpec = {
	...docsInstall,
	base: {
		...docsInstall.base,
		contexts: [
			...docsInstall.base.contexts,
			{
				name: "Level",
				claim: { kind: "object", key: "l" },
				fields: [{ name: "plan", domain: plan }]
			}
		]
	},
	roles: Arr.map(docsInstall.roles, (r) =>
		r.name === "member" ? { ...r, entries: { ...r.entries, PlanOrgs: planOrgs } } : r
	)
}

/** A member's open whose `l` claim names a plan. */
const memberAt = (level: number): Action => ({
	kind: "open-db",
	role: { kind: "own", role: "member" },
	token: {
		kind: "live",
		payload: { sub: "u_ann", t: { org: orgs[0], seats: 5 }, l: { plan: level } }
	},
	snapshot: "current"
})

layer(Substrate.layer, { excludeTestServices: true })(
	"the worlds model: what no drawn base reaches",
	(it) => {
		it.effect(
			"a context field of a contract is decoded from the token and read, and a claim outside it is refused at token",
			() =>
				Effect.gen(function* () {
					const world = yield* realize(planInstall, ordinarySession)
					yield* world.reset(reality)
					const start = yield* checkStart(world, initialState(planInstall, world.names, reality))
					const opened = yield* runStep(world, start, memberAt(1), 0, unnoted)
					const read = yield* runStep(
						world,
						opened.next,
						{ kind: "read", session: 0, relation: "PlanOrgs", via: { kind: "execute" } },
						1,
						unnoted
					)
					assert.deepEqual(
						read.observation,
						{ kind: "rows", rows: [{ org: orgs[0] }] },
						"the organization on the claimed plan"
					)
					const outside = yield* runStep(world, read.next, memberAt(plan.max + 3), 2, unnoted)
					assert.equal(
						outside.observation.kind,
						"open-refused",
						"a plan outside the contract opens no Db"
					)
				}),
			300_000
		)

		it.effect(
			"the leak scan reports a hidden token a refusal spells",
			() =>
				Effect.gen(function* () {
					const world = yield* realize(docsInstall, ordinarySession)
					yield* world.reset(reality)
					const begun = yield* world.perform(
						{
							kind: "direct-begin",
							login: "web",
							isolation: "serializable",
							start: { current: { kind: "login" }, claims: { kind: "none" } }
						},
						new Set()
					)
					assert.equal(begun.kind, "opened", "the direct writer's transaction begins")
					const table = defined(world.names.tables["Org"], "Org's table")
					const observed = yield* world.perform(
						{
							kind: "direct",
							session: 0,
							statement: { kind: "insert", relation: "Org", fact: { id: orgs[1], plan: 1 } }
						},
						new Set([table])
					)
					assert.deepEqual(
						observed,
						{ kind: "leak", field: "message", token: table },
						"the refusal names the table"
					)
				}),
			300_000
		)
	}
)
