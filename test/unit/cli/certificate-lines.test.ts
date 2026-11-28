/**
 * generate's report of a role's level (packages/grizzle/src/cli/run.ts levelLines), under which each SERIALIZABLE
 * role says why it is: a line per reason it fails by itself, with its condition, where it fails it (the role, a
 * relation, a member's write of one, or a statement of a member's flight with the relation it reads or writes), its
 * detail and its condition's fix (cli/refusals.ts isolationFix); or, where it fails none of its own, a line per role that
 * runs SERIALIZABLE and gives it one, to fix that role first, with the count of each condition it gives. Every count
 * of the role's line has its lines: the lines of its condition, or its givers' counts of it, summed.
 *
 * The box: the certificates the certifier gives the main certify search's drawn installations
 * (test/support/unit/analysis/isolation/certify.fixtures.ts caseGen, verdictsOf), every role of each. Oracle: the certificate each report is of, read back from its lines.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { isolationFix } from "#cli/refusals.ts"
import { levelLines } from "#cli/run.ts"
import {
	type IsolationCondition,
	type IsolationReason,
	reasonsOf
} from "#compiler/core/certificate.ts"
import {
	caseGen,
	inputOf,
	verdictsOf
} from "#test/support/unit/analysis/isolation/certify.fixtures.ts"

/** What a report under a role reads like. */
type LinesFeature =
	| "a role read committed"
	| "a role serializable by reasons of its own"
	| "a role serializable by reasons roles that run serializable give it"
	| "a role given reasons by two roles"
	| "a statement's reason"
	| "a relation's reason"

/** The count of each condition a line states, `laws 3, absence 1`, by condition. */
const countsOf = (text: string): ReadonlyMap<string, number> =>
	new Map(
		Arr.map(Str.split(", ")(text), (part) => {
			const [condition, count] = Str.split(" ")(part)
			return [defined(condition, "a condition"), Number(defined(count, "its count"))] as const
		})
	)

/** The count of each condition among `reasons`, by condition. */
const countsIn = (reasons: ReadonlyArray<IsolationReason>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	for (const r of reasons) {
		counts.set(r.condition, (counts.get(r.condition) ?? 0) + 1)
	}
	return counts
}

/** `counts` as sorted entries, which two maps of the same counts compare equal by. */
const sortedCounts = (
	counts: ReadonlyMap<string, number>
): ReadonlyArray<readonly [string, number]> =>
	Arr.sort(
		[...counts],
		Order.mapInput(Order.String, ([condition]: readonly [string, number]) => condition)
	)

/**
 * Under each SERIALIZABLE role generate prints a line per reason of its own, with its condition, place, detail and fix,
 * or a line per role that gives it one, to fix that role first, and every count of the role's line has its lines.
 *
 * Budget: the runner's default.
 */
export const underEachSerializableRoleGeneratePrintsALinePerReasonOfItsOwnWithItsFixOrALinePerRoleThatGivesItOneToFixFirstAndEveryCountHasItsLines =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a role read committed",
			"a role serializable by reasons of its own",
			"a role serializable by reasons roles that run serializable give it",
			"a role given reasons by two roles",
			"a statement's reason",
			"a relation's reason"
		] satisfies ReadonlyArray<Reached<LinesFeature>>,
		check: (_, k: Case<LinesFeature>) => (c) =>
			Effect.sync(() => {
				for (const v of verdictsOf(c.sketch, inputOf(c.sketch).relations)) {
					const head = `login ${v.login}, role ${v.role}`
					const lines = levelLines(v)
					if (v.certificate.level === "readCommitted") {
						assert.deepEqual(lines, [`${head}: read committed`], `${head}'s line`)
						k.note("a role read committed")
						continue
					}
					const why = v.certificate.why
					const [first, ...under] = lines
					const opened = `${head}: serializable (`
					assert.ok(
						first !== undefined && Str.startsWith(opened)(first) && Str.endsWith(")")(first),
						`${head}'s line: ${first}`
					)
					const counts = countsOf(Str.slice(opened.length, -1)(first))
					assert.deepEqual(
						sortedCounts(counts),
						sortedCounts(countsIn(reasonsOf(why))),
						`${head}'s line counts each condition of its reasons`
					)
					if (why.kind === "own") {
						k.note("a role serializable by reasons of its own")
						assert.equal(under.length, why.reasons.length, `${head}: a line per reason of its own`)
						const stated = new Map<IsolationCondition, number>()
						for (const [i, r] of why.reasons.entries()) {
							const line = defined(under[i], `${head}'s line of reason ${i}`)
							const place =
								r.at.kind === "statement"
									? `member ${r.at.member}, statement ${r.at.statement}, relation ${r.at.relation}`
									: r.at.kind === "member"
										? `member ${r.at.member}, relation ${r.at.relation}`
										: r.at.kind === "relation"
											? `relation ${r.at.relation}`
											: "the role"
							k.note(r.at.kind === "statement" ? "a statement's reason" : "a relation's reason")
							assert.ok(
								Str.startsWith(`  ${r.condition}, ${place}: `)(line),
								`${head}: reason ${i}'s line names its condition and where: ${line}`
							)
							assert.ok(
								Str.includes(r.detail)(line) &&
									Str.endsWith(`; ${isolationFix[r.condition]}`)(line),
								`${head}: reason ${i}'s line states its detail and its condition's fix: ${line}`
							)
							stated.set(r.condition, (stated.get(r.condition) ?? 0) + 1)
						}
						assert.deepEqual(
							sortedCounts(stated),
							sortedCounts(counts),
							`${head}: each count of its line has as many lines of its condition`
						)
						continue
					}
					k.note("a role serializable by reasons roles that run serializable give it")
					if (why.by.length > 1) {
						k.note("a role given reasons by two roles")
					}
					assert.equal(
						under.length,
						why.by.length,
						`${head}: a line per role that gives it a reason`
					)
					const summed = new Map<string, number>()
					for (const [i, g] of why.by.entries()) {
						const line = defined(under[i], `${head}'s line of giver ${i}`)
						const opening = `  fix login ${g.login}, role ${g.role} first (`
						assert.ok(
							Str.startsWith(opening)(line) && Str.endsWith(")")(line),
							`${head}: giver ${i}'s line tells which role to fix first: ${line}`
						)
						const given = countsOf(Str.slice(opening.length, -1)(line))
						assert.deepEqual(
							sortedCounts(given),
							sortedCounts(countsIn(g.reasons)),
							`${head}: giver ${i}'s line counts each condition it gives`
						)
						for (const [condition, count] of given) {
							summed.set(condition, (summed.get(condition) ?? 0) + count)
						}
					}
					assert.deepEqual(
						sortedCounts(summed),
						sortedCounts(counts),
						`${head}: each count of its line is its givers' counts of it, summed`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the certificate each report is of, its reasons or its givers read back from its lines"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/run.ts",
				original: "\t\t\t\t...whyLines(role.certificate.why)\n",
				replacement: "",
				why: "A SERIALIZABLE role's line alone, its counts with no line under them (edullm's report: counts only); the search fails."
			},
			{
				file: "packages/grizzle/src/cli/run.ts",
				original: '\twhy.kind === "own"\n',
				replacement: '\twhy.kind === "own" || why.kind === "given"\n',
				why: "Reasons other roles give printed as a role's own, a line per reason where one line per giver says to fix it first; the search fails."
			},
			{
				file: "packages/grizzle/src/cli/run.ts",
				original: `; \${isolationFix[r.condition]}`,
				replacement: "",
				why: "A reason's line with no fix; the search fails."
			}
		]
	})
