/**
 * A retirable unit served whole, as den serves its runs: a worker role that inserts every relation of the unit and an
 * application's audits beside it, and a retirer role of its own that retires runs (ChangeSet.retire), each certified
 * READ COMMITTED, the retirer alone holding EXECUTE on the unit's retirement (physical/ddl/roles.ts addWorlds).
 *
 * The box: Flows (retire.fixtures.ts), its login drafted and served as `grizzle generate` does (Served.of over the
 * generated template). A case is an admission of run 1, then one to five calls in order, each drawn from: an admission
 * of run 1 or 2 with one or two of its steps, 0 and 1; a claim of a step's attempt, 0 or 1; an audit, id 1 or 2, of a
 * step; a retirement of one to three runs, repeats among them. Every case starts from no row, and each call is one
 * served call of its role.
 *
 * Oracle: the unit's model (retire.fixtures.ts stepOf), a second implementation: each call's answer, accepted with every
 * written relation's counts (a retired run counts as a put of its header, each row removed with it as a delete),
 * unchanged, or refused (by the hold of a run not open, by a law a worker's row breaks, or, for a retirement, by the
 * Audit containment an audit of a step of a run it retires holds); and after each call the stored rows, each run open or
 * retired, exactly the model's. So a retired run's key never starts a fresh run, a stale worker's claim of a retired
 * run's step is refused, and a retirement removes a run whole or not at all.
 *
 * Features: a run admitted, a step claimed, a step audited, a run retired whole, a retirement of nothing open; a
 * retired run admitted again, a retired run's step claimed, a retirement an audit refuses, each refused.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { isRecord } from "#compiler/core/record.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	type Answer,
	type Call,
	callsGen,
	emptyState,
	type Feature,
	type FlowState,
	featuresOf,
	flowsApp,
	Flows,
	flowsTemplate,
	stepOf
} from "#test/pg/laws/retire.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { type Installed, loadMigrated } from "#test/support/install-migrate.ts"
import { Served } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What a served call answered: an outcome, as the model states one, or a refusal, with whether a law it names is the
 * Audit containment. */
type Got =
	| Exclude<Answer, { readonly kind: "refused" }>
	| { readonly kind: "refused"; readonly audit: boolean }

/** Whether a refusal's laws name the Audit containment, `{ kind: "contained", from: { relation: "Audit" } }`. */
const namesAudit = (refused: unknown): boolean => {
	const laws = isRecord(refused) ? refused["laws"] : undefined
	return (
		Arr.isArray(laws) &&
		Arr.some(laws, (entry: unknown) => {
			const law = isRecord(entry) ? entry["law"] : undefined
			const from = isRecord(law) ? law["from"] : undefined
			return (
				isRecord(law) &&
				law["kind"] === "contained" &&
				isRecord(from) &&
				from["relation"] === "Audit"
			)
		})
	)
}

/** The answer a served call gave, or what it was instead. */
const answerOf = (called: Result.Result<unknown, unknown>): Got | string => {
	if (Result.isFailure(called)) {
		const failure = called.failure
		if (typeof failure !== "object" || failure === null || !("kind" in failure)) {
			return `a failure that is no CallError: ${Formatter.format(failure)}`
		}
		if (failure.kind !== "refused" || !("refused" in failure)) {
			return `a failure other than a refusal: ${Formatter.format(failure)}`
		}
		return { kind: "refused", audit: namesAudit(failure.refused) }
	}
	const outcome = called.success
	if (typeof outcome !== "object" || outcome === null || !("kind" in outcome)) {
		return `an outcome that is none: ${Formatter.format(outcome)}`
	}
	if (outcome.kind === "unchanged") {
		return { kind: "unchanged" }
	}
	if (outcome.kind !== "accepted" || !("counts" in outcome) || !Arr.isArray(outcome.counts)) {
		return `an outcome of no kind the model knows: ${Formatter.format(outcome)}`
	}
	return {
		kind: "accepted",
		counts: Arr.map(outcome.counts, (c: unknown) => {
			const record = typeof c === "object" && c !== null ? c : {}
			const at = (name: string): unknown => (name in record ? Reflect.get(record, name) : undefined)
			return {
				relation: String(at("relation")),
				added: BigInt(String(at("added"))),
				deleted: BigInt(String(at("deleted"))),
				put: BigInt(String(at("put")))
			}
		})
	}
}

/** Whether a call answered as the model does: its kind, an accepted call's every count, and a retirement an audit
 * refuses refused on the Audit containment, which names the relation that blocked it. */
const sameAnswer = (got: Got, want: Answer): boolean => {
	switch (want.kind) {
		case "accepted":
			return (
				got.kind === "accepted" &&
				got.counts.length === want.counts.length &&
				Arr.every(got.counts, (c, at) => {
					const w = Arr.getUnsafe(want.counts, at)
					return (
						c.relation === w.relation &&
						c.added === w.added &&
						c.deleted === w.deleted &&
						c.put === w.put
					)
				})
			)
		case "unchanged":
			return got.kind === "unchanged"
		case "refused":
			return got.kind === "refused" && (want.by !== "audit" || got.audit)
	}
}

/** The stored rows, as the model states them, read as the owner. */
const storedOf = (installed: Installed) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const t = (relation: string) => printObjectName(installed.names.relation(relation))
		const c = (relation: string, field: string) => installed.names.column(relation, field)
		const rows = (sql: string) =>
			Effect.map(substrate.admin.queryValues(sql, []), (rs) =>
				Arr.map(rs, (r) => Arr.map(r, (x) => String(x)))
			)
		const flows = yield* rows(
			`SELECT ${c("Flow", "id")}, ${c("Flow", "retired")} FROM ${t("Flow")}`
		)
		const steps = yield* rows(
			`SELECT ${c("FlowStep", "flow")}, ${c("FlowStep", "step")} FROM ${t("FlowStep")}`
		)
		const claims = yield* rows(
			`SELECT ${c("FlowClaim", "flow")}, ${c("FlowClaim", "step")}, ${c("FlowClaim", "attempt")} FROM ${t("FlowClaim")}`
		)
		const audits = yield* rows(
			`SELECT ${c("Audit", "id")}, ${c("Audit", "flow")}, ${c("Audit", "step")} FROM ${t("Audit")}`
		)
		return {
			flows: Arr.sort(
				Arr.map(flows, ([id, retired]) => `${id}:${retired === "true" ? "retired" : "open"}`),
				Order.String
			),
			steps: Arr.sort(
				Arr.map(steps, (r) => Arr.join(r, ":")),
				Order.String
			),
			claims: Arr.sort(
				Arr.map(claims, (r) => Arr.join(r, ":")),
				Order.String
			),
			audits: Arr.sort(
				Arr.map(audits, ([id, ...at]) => `${id}=${Arr.join(at, ":")}`),
				Order.String
			)
		}
	})

/** The model's state as storedOf reads the stored rows. */
const modelRows = (state: FlowState) => ({
	flows: Arr.sort(
		Arr.map([...state.flows], ([id, run]) => `${id}:${run}`),
		Order.String
	),
	steps: Arr.sort([...state.steps], Order.String),
	claims: Arr.sort([...state.claims], Order.String),
	audits: Arr.sort(
		Arr.map([...state.audits], ([id, at]) => `${id}=${at}`),
		Order.String
	)
})

/** A retirable unit served whole: each call answers as the unit's model does and leaves its rows, its roles certified READ COMMITTED. */
export const aRetirableUnitServedWholeAnswersEachCallAsItsModelDoesAndLeavesItsRowsItsRolesCertifiedREADCOMMITTED =
	property.explore(callsGen, {
		needs: { flows: Served.of(flowsApp(Flows), Substrate.seat(flowsTemplate)) },
		situations: [
			"a run admitted",
			"a step claimed",
			"a step audited",
			"a run retired whole",
			"a retirement of nothing open, unchanged",
			"a retired run admitted again, refused",
			"a retired run's step claimed, refused",
			"a retirement an audit refuses"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 48, steered: 48 },
		check:
			({ flows }, notes: Case<Feature>) =>
			(calls) =>
				Effect.gen(function* () {
					const { substrate, installed, fixture } = yield* flows
					assert.equal(fixture.login.roles.worker.isolation, "readCommitted", "the worker's level")
					assert.equal(
						fixture.login.roles.retirer.isolation,
						"readCommitted",
						"the retirer's level"
					)
					yield* Effect.provideService(loadMigrated(installed, {}), Substrate, substrate)
					yield* Effect.scoped(
						Effect.gen(function* () {
							const worker = yield* Db.open(fixture.login.roles.worker, {})
							const retirer = yield* Db.open(fixture.login.roles.retirer, {})
							const callOf = (call: Call) => {
								switch (call.kind) {
									case "admit":
										return worker.workload.admit.once({
											params: {},
											facts: {
												insert: {
													Flow: [{ id: call.flow }],
													FlowStep: Arr.map(call.steps, (step) => ({ flow: call.flow, step }))
												}
											}
										})
									case "claim":
										return worker.workload.claim.once({
											params: {},
											facts: {
												insert: {
													FlowClaim: [{ flow: call.flow, step: call.step, attempt: call.attempt }]
												}
											}
										})
									case "audit":
										return worker.workload.audit.once({
											params: {},
											facts: {
												insert: { Audit: [{ id: call.id, flow: call.flow, step: call.step }] }
											}
										})
									case "retire":
										return retirer.workload.retire.once({
											params: {},
											facts: { retire: { Flow: Arr.map(call.flows, (id) => ({ id })) } }
										})
								}
							}
							let state = emptyState
							for (const [at, call] of calls.entries()) {
								const next = stepOf(state, call)
								for (const feature of featuresOf(state, call, next.answer)) {
									notes.note(feature)
								}
								const called = yield* Effect.result(callOf(call))
								const got = answerOf(called)
								if (typeof got === "string") {
									return assert.fail(`call ${at}, ${Formatter.format(call)}: ${got}`)
								}
								assert.ok(
									sameAnswer(got, next.answer),
									`call ${at}, ${Formatter.format(call)}, answers ${Formatter.format(got)}, the model ${Formatter.format(next.answer)}`
								)
								state = next.state
								const stored = yield* Effect.provideService(
									storedOf(installed),
									Substrate,
									substrate
								)
								assert.deepEqual(
									stored,
									modelRows(state),
									`the rows after call ${at}, ${Formatter.format(call)}`
								)
							}
						})
					).pipe(withLayer(fixture.layer))
				}),
		oracle: {
			kind: "second-implementation",
			name: "the retirable unit's model: each call's answer and the rows it leaves (retire.fixtures.ts stepOf)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\t\t\t...role.retire.map(",
				replacement: "\t\t\t...[].map(",
				why: "No EXECUTE on a unit's retirement for a role whose retire list names it, so a served retirement fails with 42501."
			},
			{
				file: "packages/engine/src/runtime/write/outcome.ts",
				original: "\t\treturn counts\n\t}\n\tconst by = new Map",
				replacement:
					"\t\treturn counts\n\t}\n\tif (retired.size > 0) {\n\t\treturn counts\n\t}\n\tconst by = new Map",
				why: "A retirement's counts left out of its outcome, which then answers unchanged for a run it retired."
			},
			{
				file: "packages/engine/src/runtime/write/outcome.ts",
				original:
					'\t\tadd(step.header, { ...noCounts, put: defined(groups, "the count of the groups retired") })',
				replacement:
					'\t\tadd(step.header, { ...noCounts, deleted: defined(groups, "the count of the groups retired") })',
				why: "A retired run counted as a delete of its header, which a retirement keeps for good."
			},
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original: "\t\t\t\t\ttargetAs(lit.int(at, types.integer), order),",
				replacement: "\t\t\t\t\ttargetAs(lit.int(-at, types.integer), order),",
				why: "The retirement's counts in reverse order, so its bodies' removed rows are counted under the header and one another."
			},
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original: '\t\t\t[lockOpen(b, unit, params, "UPDATE"), retireLocked(b, unit, params)],',
				replacement: '\t\t\t[lockOpen(b, unit, params, "UPDATE")],',
				why: "A retirement that locks and removes nothing (no RETURN QUERY), so its call fails and no run is retired."
			}
		]
	})
