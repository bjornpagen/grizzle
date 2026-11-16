import { type Reached } from "@bjornpagen/testing/features"
import { array, characterOf, finite, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Option, Order, Result, String as Str } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import { LayerReleased } from "#adapter/errors/failures.ts"
import { concurrentRefreshPosition } from "#adapter/refresh/detail.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
import {
	populatedParams,
	populatedSql,
	refreshBlock,
	refreshPlan
} from "#adapter/refresh/statements.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { materializedDerived as derivedOver } from "#compiler/schema/relation.ts"
import { assert, defined, refusalLoc, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { scriptedPool, texts } from "#test/support/flight/scripted.ts"
import { atDeclaredName, installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { paramText } from "#test/support/wire.ts"
import {
	A,
	asRefresher,
	B,
	built,
	C,
	type Declared,
	declaredOf,
	definitionOf,
	type Detail,
	detailGen,
	detailText,
	endingCaseGen,
	type EndingFeature,
	expectedEnding,
	readTextArray,
	Refresher,
	reports,
	reportsNames,
	type Requested,
	sessionOf,
	Sitting,
	targetsCaseGen,
	type TargetsFeature,
	type TextArrayFeature,
	type Told,
	told,
	type ValueVerdict
} from "#test/unit/adapter/refresh.fixtures.ts"

/** Db.refresh targets are the named relations once each, in level order then declared order, and a value outside the role or no derived relation of the schema is refused. */
export const dbRefreshTargetsAreTheNamedRelationsOnceEachInLevelOrderThenDeclaredOrderAndAValueOutsideTheRoleOrNoDerivedRelationOfTheSchemaIsRefused =
	property.explore(targetsCaseGen, {
		needs: {},
		situations: [
			"a derived relation of the schema",
			"a look-alike of one",
			"another definition under its name",
			"a derived relation the schema lacks",
			"no derived relation",
			"refreshed in level order",
			"a relation named twice",
			"a later level's relation named first",
			"refused OutsideRole",
			"refused MalformedDescription"
		] satisfies ReadonlyArray<Reached<TargetsFeature>>,
		check: (_, k: Case<TargetsFeature>) => (c) =>
			Effect.sync(() => {
				const b = built(c)
				const artifacts = succeeded(testArtifacts(b.schema, testCompile))
				const names = installationNamesOf(installationOf(b.schema, atDeclaredName))
				const pickOf = (pick: number): Declared =>
					defined(b.declared[pick % b.declared.length], "a derived relation")
				const valueOf = (r: Requested): unknown => {
					switch (r.kind) {
						case "a derived relation of the schema":
							return pickOf(r.pick).value
						case "a look-alike of one": {
							const d = pickOf(r.pick)
							return { kind: "derived", name: d.name, definition: definitionOf(d.n) }
						}
						case "another definition under its name":
							return derivedOver(pickOf(r.pick).name, definitionOf(1_000), [])
						case "a derived relation the schema lacks":
							return derivedOver("Lacking", definitionOf(0), [])
						case "no derived relation":
							switch (r.value) {
								case "a base relation":
									return Sitting
								case "a name":
									return pickOf(0).name
								case "a number":
									return 1
								case "an empty object":
									return {}
							}
					}
				}
				const verdictOf = (r: Requested): ValueVerdict => {
					switch (r.kind) {
						case "a derived relation of the schema":
						case "a look-alike of one": {
							const d = pickOf(r.pick)
							return b.refreshed.has(d.name)
								? { kind: "target", declared: d }
								: { kind: "outside", name: d.name }
						}
						case "another definition under its name":
						case "a derived relation the schema lacks":
						case "no derived relation":
							return { kind: "malformed" }
					}
				}
				const verdicts = Arr.map(c.requested, verdictOf)
				const result = refreshTargets(b.refresher, artifacts, Arr.map(c.requested, valueOf))
				for (const r of c.requested) {
					k.note(r.kind)
				}
				const refusal = Arr.findFirst(verdicts, (v) => v.kind !== "target")
				if (Option.isSome(refusal)) {
					assert.ok(Result.isFailure(result), "a refused value refuses the call")
					const e = result.failure
					assert.equal(formatLoc(refusalLoc(e)), "db.refresh")
					const verdict = refusal.value
					if (verdict.kind === "outside") {
						assert.deepEqual(
							e.reason._tag === "OutsideRole"
								? { role: e.reason.role, access: e.reason.access }
								: e.reason._tag,
							{ role: "refresher", access: { kind: "refresh", relation: verdict.name } }
						)
						k.note("refused OutsideRole")
					} else {
						assert.equal(e.reason._tag, "MalformedDescription")
						k.note("refused MalformedDescription")
					}
					return
				}
				const named = Arr.flatMap(verdicts, (v) => (v.kind === "target" ? [v.declared] : []))
				const expected = Arr.sort(
					Arr.dedupeWith(named, (x, y) => x.name === y.name),
					Order.mapInput(
						Order.Tuple([Order.Number, Order.Number]),
						(d: Declared) => [d.level, d.position] as const
					)
				)
				assert.deepEqual<ReadonlyArray<unknown>>(
					Arr.map(succeeded(result), (t) => ({
						relation: t.relation,
						level: t.level,
						position: t.position,
						view: t.view
					})),
					Arr.map(expected, (d) => ({
						relation: d.name,
						level: d.level,
						position: d.position,
						view: {
							schema: conversionOf(`Level${d.level}`),
							name: names.tableIdent({ name: d.name })
						}
					}))
				)
				k.note("refreshed in level order")
				if (named.length > expected.length) {
					k.note("a relation named twice")
				}
				if (
					Arr.some(named, (d, i) => Arr.some(named.slice(i + 1), (later) => later.level < d.level))
				) {
					k.note("a later level's relation named first")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the refresh order and refusals restated over the drawn levels and refresh list"
		},
		kept: [],
		kills: []
	})

/** Plain or CONCURRENTLY passes the views as one text[] literal PostgreSQL reads back as them, each once, whatever their order. */
export const plainOrCONCURRENTLYPassesTheViewsAsOneTextLiteralPostgreSQLReadsBackAsThemEachOnceWhateverTheirOrder =
	property.explore(
		array(
			string(characterOf(["a", "Z", " ", '"', "\\", ",", "{", "}", "é", "😀"]), {
				min: 0,
				max: 5
			}),
			{ min: 0, max: 4 }
		),
		{
			needs: {},
			situations: [
				"no element",
				"an empty element",
				"an element with a quote",
				"an element with a backslash",
				"an element with a comma or brace",
				"a repeated view"
			] satisfies ReadonlyArray<Reached<TextArrayFeature>>,
			check: (_, c: Case<TextArrayFeature>) => (views) =>
				Effect.sync(() => {
					if (views.length === 0) {
						c.note("no element")
					}
					for (const view of views) {
						if (view === "") {
							c.note("an empty element")
						}
						if (Str.includes('"')(view)) {
							c.note("an element with a quote")
						}
						if (Str.includes("\\")(view)) {
							c.note("an element with a backslash")
						}
						if (regex("[,{}]", "u").test(view)) {
							c.note("an element with a comma or brace")
						}
					}
					if (new Set(views).size < views.length) {
						c.note("a repeated view")
					}
					assert.deepEqual(readTextArray(textArray(views)), views)
					const params = populatedParams("edu", views)
					const [schemaParam, viewsParam] = params
					assert.equal(schemaParam, paramText("edu"))
					const read = readTextArray(defined(viewsParam, "the views parameter"))
					assert.ok(read !== "unread", "the views parameter is no text[] literal")
					unorderedEqual(read, [...new Set(views)], "each view once")
					assert.deepEqual(
						populatedParams("edu", Arr.reverse(views)),
						params,
						"whatever their order"
					)
				}),
			oracle: {
				kind: "universal",
				name: "PostgreSQL's array literal read back is the views, each once, whatever their order"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/codec/recordset.ts",
					original: `\t\t\`{\${values`,
					replacement: `\t\t\`{\${values\n\t\t\t.filter((v) => v !== "")`,
					why: "An empty element is left out of a text[] literal."
				}
			]
		}
	)

/** Plain or CONCURRENTLY names the refused target by its position in refresh order, and nothing else as one. */
export const plainOrCONCURRENTLYNamesTheRefusedTargetByItsPositionInRefreshOrderAndNothingElseAsOne =
	property.exhaust(finite(detailGen), {
		needs: {},
		situations: [
			"a position",
			"no detail",
			"the empty detail",
			"the tag alone",
			"a position with a leading zero",
			"a negative position",
			"a position after another word"
		] satisfies ReadonlyArray<Reached<Detail["kind"]>>,
		check: (_, c: Case<Detail["kind"]>) => (detail) =>
			Effect.sync(() => {
				c.note(detail.kind)
				assert.equal(
					concurrentRefreshPosition(detailText(detail)),
					detail.kind === "a position" ? detail.position : undefined
				)
			}),
		oracle: {
			kind: "specification",
			name: "a DETAIL names a position exactly when the block spelled one"
		},
		box: "every position below a hundred, and every near miss over a digit below ten and words of x and y",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/refresh/detail.ts",
				original: "\treturn isDecimal(digits) ? Number(digits) : undefined",
				replacement: "\treturn /^[0-9]+$/.test(digits) ? Number(digits) : undefined",
				why: "A position with a leading zero is read as a position."
			}
		]
	})

/** How a refresh ends as its one SERIALIZABLE flight's answers say: committed in refresh order, retryable on SERIALIZABLE's refusals and a rewritten view, stale at the fence, unknown when COMMIT may have run, and the server's report otherwise. */
export const howARefreshEndsAsItsOneSERIALIZABLEFlightsAnswersSayCommittedInRefreshOrderRetryableOnSERIALIZABLEsRefusalsAndARewrittenViewStaleAtTheFenceUnknownWhenCOMMITMayHaveRunAndTheServersReportOtherwise =
	property.explore(endingCaseGen, {
		needs: {},
		situations: [
			"refreshed",
			"refreshed CONCURRENTLY",
			"refused at the fence",
			"refused at the role's entry",
			"refused at the populated read",
			"refused at the block",
			"refused at COMMIT",
			"lost at the block",
			"lost at COMMIT",
			"ended by the server",
			"acquisition refused",
			"transient",
			"concurrent refresh",
			"execution",
			"stale",
			"commit unknown",
			"transport"
		] satisfies ReadonlyArray<Reached<EndingFeature>>,
		check: (_, k: Case<EndingFeature>) => (c) =>
			Effect.gen(function* () {
				const targets = succeeded(
					refreshTargets(
						declaredOf(Refresher),
						reports,
						Arr.map(c.named, (name) => (name === "A" ? A : name === "B" ? B : C))
					)
				)
				const populatedViews = Arr.map(c.populated, (name) => reportsNames.tableIdent({ name }))
				const session = sessionOf(c, populatedViews)
				const exit = yield* Effect.exit(
					runRefresh(
						{
							prologue: asRefresher,
							pool: scriptedPool({
								lease:
									c.fault.kind === "acquisition refused"
										? Effect.fail(new LayerReleased())
										: Effect.succeed(session)
							})
						},
						refreshPlan(targets)
					)
				)
				const expected = expectedEnding(c, targets)
				if (Exit.isSuccess(exit)) {
					const ran = Arr.map(exit.value.statements, (s) => [s.relation, s.concurrently] as const)
					assert.deepEqual<Told>({ kind: "refreshed", ran }, expected)
					const [only, ...rest] = session.flights()
					assert.deepEqual(rest, [], "one flight")
					assert.deepEqual(texts(only), [
						"BEGIN ISOLATION LEVEL SERIALIZABLE",
						asRefresher.fence.text.sql,
						asRefresher.enter.text.sql,
						...Arr.map(Arr.dedupe(Arr.map(targets, (t) => t.view.schema)), () => populatedSql),
						refreshBlock(Arr.map(targets, (t) => t.view)),
						"COMMIT"
					])
					k.note("refreshed")
					if (Arr.some(ran, ([, concurrently]) => concurrently)) {
						k.note("refreshed CONCURRENTLY")
					}
					return
				}
				const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
				const ending = told(failure)
				assert.deepEqual(ending, expected)
				assert.deepEqual(session.committed(), [], "a failed refresh commits nothing")
				k.note(ending.kind)
				const fault = c.fault
				switch (fault.kind) {
					case "refused":
						k.note(`refused at ${fault.where}`)
						break
					case "lost":
						k.note(`lost at ${fault.where}`)
						break
					case "ended by the server":
						k.note("ended by the server")
						break
					case "acquisition refused":
						k.note("acquisition refused")
						break
					case "none":
						break
				}
			}),
		oracle: {
			kind: "specification",
			name: "the refresh transaction's endings, restated from run.ts over the fault the server meets"
		},
		kept: [],
		kills: []
	})
