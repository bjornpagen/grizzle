import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { parsePlanTree } from "#bench/harness/explain.ts"
import { claimOf, Digest, digestOf, queueSchema, Wanted } from "#bench/queue/support/queue.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf } from "#compiler/write/program/served.ts"
import {
	aims,
	type AnchoredFeature,
	anchoredGen,
	bounded,
	named,
	queueTemplate,
	readByIndex,
	reads,
	type Shape
} from "#test/pg/write/anchored/anchored.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes, paramValues, realityWrite, testArtifacts } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An anchored deletion reads its relation once, by an index condition.
 *
 * Its pre-conversion budget: runs 12, coverage cases 48 (test/pg/write/anchored/anchored.test.ts at d8eed1786).
 */
export const anAnchoredDeletionReadsItsRelationOnceByAnIndexCondition = property.explore(
	aimed(anchoredGen, aims),
	{
		needs: { queue: Substrate.seat(queueTemplate) },
		situations: Arr.map(aims, ([feature]) => feature) satisfies ReadonlyArray<
			Reached<AnchoredFeature>
		>,
		check:
			({ queue }, c: Case<AnchoredFeature>) =>
			({ shape, keys, from, key, params }) =>
				Effect.gen(function* () {
					const { substrate: s, value: o } = yield* queue
					const S = queueSchema(o.schema)
					const names = o.installation.names
					const reality = realityWrite(
						succeeded(
							testArtifacts(S, {
								installation: o.installation.names.installation,
								codes: installedCodes(names.codes)
							})
						)
					)
					const members: { readonly [K in Shape]: unknown } = {
						"the claim's deletion of the Wanted items its pick names": claimOf(S),
						"a deletion of the Wanted items a relation parameter names": ChangeSet.empty(S).delete(
							Wanted,
							query(S).rule((r) => {
								const named = r.relation("keys", { key: Wanted.fields.key })
								const { key, due, attempts } = v(Wanted, "wanted")
								return r
									.match(named, { key })
									.match(Wanted, { key, due, attempts })
									.find({ key, due, attempts })
							})
						),
						"a deletion of the Wanted item a parameter selects": ChangeSet.empty(S).delete(
							Wanted,
							query(S).rule((r) => {
								const { key, due, attempts } = v(Wanted, "wanted")
								return r
									.match(Wanted, { key, due, attempts })
									.where(r.eq(key, r.param("key", Wanted.fields.key)))
									.find({ key, due, attempts })
							})
						)
					}
					const wanted = names.relation("Wanted").name
					/** Each member's ChangeSet compiled against the installation, once: its plan is drawn per case. */
					const compiledOf = (shape: Shape) => {
						const desc = changeSetDesc(members[shape])
						if (desc === undefined) {
							throw new Error(`${shape}: no ChangeSet`)
						}
						const program = compileWrite(checking(S), desc, reality)
						if (!program.ok) {
							throw new Error(`${shape}: ${program.error.message}`)
						}
						return program.value
					}
					const programs = {
						"the claim's deletion of the Wanted items its pick names": compiledOf(
							"the claim's deletion of the Wanted items its pick names"
						),
						"a deletion of the Wanted items a relation parameter names": compiledOf(
							"a deletion of the Wanted items a relation parameter names"
						),
						"a deletion of the Wanted item a parameter selects": compiledOf(
							"a deletion of the Wanted item a parameter selects"
						)
					}

					const numbered = [from, key, ...keys]
					const digestRows = yield* s.admin.queryValues(
						`SELECT ${digestOf("n")} FROM pg_catalog.unnest(ARRAY[${Arr.join(Arr.map(numbered, String), ", ")}]::integer[]) WITH ORDINALITY AS u (n, at) ORDER BY at`,
						[]
					)
					const digests = Arr.map(digestRows, (row) => Digest(String(row[0])))
					const digestOfItem = (at: number) => defined(digests[at], `the digest of item ${at}`)
					const hostParams: Readonly<Record<string, unknown>> = {
						...params,
						from: digestOfItem(0),
						key: digestOfItem(1),
						keys: Arr.map(keys, (_, i) => ({ key: digestOfItem(i + 2) }))
					}
					const program = programs[shape]
					const statements = flightOf(program, names.codes).statements
					/**
					 * Each placeholder from the drawn parameters, as its statement binds it, a relation's normalized once:
					 * the key of Wanted is text, so a relation parameter of keys travels as a binary text[].
					 */
					const declared = { params: program.params, codes: names.codes }
					const found = Arr.findFirst(statements, (st, at) =>
						st.kind === "whole" &&
						st.step.kind === "write" &&
						st.step.relation === Wanted.name &&
						st.step.result.kind === "delete"
							? Option.some({ deletion: st, at })
							: Option.none()
					)
					if (Option.isNone(found)) {
						throw new Error(`${shape}: no deletion of Wanted`)
					}
					const { deletion, at } = found.value
					/** The carriers the deletion reads, made and filled in one transaction, then the deletion planned. */
					const plan = yield* Effect.scoped(
						Effect.gen(function* () {
							const pinned = yield* s.admin.pin
							yield* pinned.query("BEGIN", [])
							for (const st of statements.slice(0, at)) {
								if (
									st.kind === "whole" &&
									(st.step.kind === "carrier" || st.step.kind === "analyze")
								) {
									yield* pinned.query(st.form.text.sql, paramValues(st.form, hostParams, declared))
								}
							}
							const rows = yield* pinned.queryValues(
								`EXPLAIN (FORMAT JSON) ${deletion.form.text.sql}`,
								paramValues(deletion.form, hostParams, declared)
							)
							yield* pinned.query("ROLLBACK", [])
							return succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
						})
					)
					const read = reads(plan, wanted)
					assert.equal(
						read.length,
						1,
						`${shape}: ${Arr.join(
							Arr.map(read, (n) => n.nodeType),
							", "
						)} read Wanted`
					)
					assert.deepEqual(
						Arr.map(
							Arr.filter(read, (n) => !bounded(n)),
							(n) => n.nodeType
						),
						[],
						`${shape}: these nodes read Wanted unbounded`
					)
					c.note(readByIndex(shape))
					if (shape === named) {
						if (keys.length > 1) {
							c.note("a relation parameter of several keys")
						}
						if (keys.length === 0) {
							c.note("a relation parameter of no keys")
						}
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plan of the deletion for the drawn values: one node reads Wanted, bounded by an index condition"
		},
		budget: { runs: 12, steered: 48 },
		kept: [],
		kills: []
	}
)
