/**
 * A fold, a union or a join a statement reads at several sites is computed at its sites' keys alone (lower/shapes/share/
 * keys.ts KeyAnalysis, magic sets): a site read once per row of a driver, an attachment's child per parent key, is
 * lowered there at that row's values, each carried into the nodes under it that read them (keys.ts restrictionWalk), a
 * fold's keys below its aggregate; every other site reads one evaluation of it at the DISTINCT union of their keys,
 * LATERAL per key, to which a site read per row adds none. So a read of one child's rows reads that child's rows alone
 * however many children the store holds beside it. Before, a fold read by a head at a sitting's keys and by the head's
 * attachment at each head row was derived whole: the attachment's keys were the head's rows, which read the fold
 * itself, a cycle no order computes first, and the attachment read the whole fold beside each parent key (edullm's
 * latest decision, ~176k buffers a call for any child; reviewOf's LatestAttempt, every attempt's latest derived before
 * the sitting's three were kept). An attachment whose correlation the parameters hold (the constant-column pass reads
 * them in place of the head's columns) has one key, the statement's, and is read per key too (cte-policy
 * keyPrefixBound: a column held at a value that reads no relation is no column to prove).
 *
 * On PostgreSQL 19, a ledger in small (magic-sets.fixtures.ts): each child's sittings of its stages, its item sessions
 * at their stages, their attempts and marks, a few dozen children and then a few hundred; the read of one child's
 * stage's latest attempts, through its sitting or at the parameters, with the marks of the stage's latest attempts
 * attached to each. Each per-key evaluation reads its relations in the order their declared keys prove (cte-policy
 * keyedRegionChain, lower/shapes/region keyedChain): the stage's sessions by (child, stage), then each session's
 * attempts by its key.
 *
 * Oracle: a bound, the read's scans read at most three times the stage's stored rows however many children stand beside
 * it: stored relations' rows and CTE scans' with what their filters removed.
 *
 * The bound holds under any planner statistics of the fold's relations: a case states the attempts' and the item
 * sessions' columns at one value or each its own, or none, so a read whose order PostgreSQL's estimates chose reads what
 * those statements lead it to, every attempt of the child first where they state each attempt its own and every session
 * one; a region held at the statement's parameters is chained by its declared keys as a per-key read is.
 *
 * Features: a read beside a few children and beside many, and under statistics stating each attempt its own and every
 * session one.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Kill, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runStage,
	type StageFeature,
	type StageRead,
	stageGen,
	stageTemplate
} from "#test/pg/lower-shapes/magic-sets.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The bound every read's property holds (runStage). */
const boundOracle =
	"bound: the read's scans read at most three times the stage's stored rows, stored relations' and CTE scans' with what their filters removed, beside a thousand children of one stage and a few dozen of the case's, then a few hundred more, under any statistics and no planner setting"

/** The property over one of the reads (StageRead), its oracle `oracle`, with its kills. */
const stageProperty = (by: StageRead, oracle: string, kills: ReadonlyArray<Kill>) =>
	property.explore(stageGen, {
		needs: { stored: Substrate.rolledBack(stageTemplate) },
		situations: [
			"beside a few children",
			"beside many children",
			"under statistics stating each attempt its own and every session one",
			"under statistics stating each seat's grade its own and every seat one"
		] satisfies ReadonlyArray<Reached<StageFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runStage(value.installed, connection, drawn, c, by)
				}),
		oracle: { kind: "universal", name: oracle },
		kept: [],
		kills
	})

/**
 * A read of one child's stage through its sitting, a fold read by the head at the sitting's child and stage and by its
 * attachment at each head row, reads that stage's rows alone however many children the store holds beside it, each
 * per-key chain led by the stage's sessions.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aFoldReadByAHeadAndByItsAttachmentIsComputedAtTheHeadsKeysSoAReadOfOneChildReadsItsOwnRows =
	stageProperty("sitting", boundOracle, [
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				"\t\treturn perRow === undefined ? readers : readers.filter((r) => !perRow.has(r))\n",
			replacement: "\t\treturn readers\n",
			why: "A site read per parent key adds its keys to the fold's: the attachment's keys are the head's rows, which read the fold, a cycle no order computes first, so the fold is derived whole for every child stored."
		},
		{
			file: "packages/engine/src/lower/shapes/region/index.ts",
			original: "\tif (plan !== undefined && parts.from.length === parts.occurrences.length) {\n",
			replacement: "\tif (false) {\n",
			why: "A per-key region reads its relations in the order PostgreSQL's estimates choose: under statistics stating each attempt its own and every session one, the fold's attempts are read by the child, every stage's, before its stage's sessions bind each, past three times the stage's rows."
		},
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original: '\t\t\t\t\tif (source.kind === "Base") {\n\t\t\t\t\t\tcontinue\n',
			replacement:
				'\t\t\t\t\tif (source.kind === "Base" || source.kind !== "Base") {\n\t\t\t\t\t\tcontinue\n',
			why: "The parent key stops at the attachment's region: the fold it reads is read there as the statement's CTE, a site of its key set, whose keys the head's rows of it give, a cycle, so the fold is derived whole for every child stored."
		},
		{
			file: "test/pg/lower-shapes/magic-sets.fixtures.ts",
			original: "\t\t\t...beside(besideFirst, besideFirst + besideChildren - 1),\n",
			replacement: "",
			why: "No children stored beside the case's, its tables a page or two: PostgreSQL prices a sequential scan of each below a probe by its index and reads every row the store holds, past three times the stage's (205 to 404 rows against bounds of 15 to 27 at ten children), where enable_seqscan and enable_bitmapscan switched off stood in for a store worth planning."
		}
	])

/**
 * A read of one child's stage at the parameters, whose attachment's child holds every column of its correlation at a
 * parameter, reads the child once, at the statement's key, the stage's rows alone however many children the store holds
 * beside it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anAttachmentWhoseCorrelationTheParametersHoldIsReadAtTheStatementsOneKey =
	stageProperty("parameters", boundOracle, [])

/**
 * A read of one child's stage at the parameter child and a literal stage, off its item sessions, whose attachment's
 * child holds every column of its correlation at a value that reads no relation, reads the child once, at the
 * statement's key, the stage's rows alone however many children the store holds beside it: a column held at a value is
 * no column a declared-key prefix must bind (cte-policy keyPrefixBound), and no statement-held class restricts the
 * literal's.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anAttachmentWhoseCorrelationALiteralHoldsIsReadAtTheStatementsOneKey = stageProperty(
	"literal",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original:
				"\t\t\treturn read.length === 0 ? columns.length : keyPrefixLength(node.input, read)\n",
			replacement:
				"\t\t\treturn read.length === columns.length ? keyPrefixLength(node.input, read) : 0\n",
			why: "A column held at a literal is a column no declared-key prefix binds: the attachment's child is co-grouped, derived for every stage of the child, which only the parameter restricts, past three times the stage's rows."
		}
	]
)

/**
 * A child's seats of a course's grade, at the parameters, read with the child's own seats before the grade's, once the
 * course binds the grade: a declared-key prefix holding the call's own value leads one a closed row's value binds
 * (cte-policy keyedRegionChain), so the read is the child's rows alone however many children's seats share the grade,
 * as metis's slot read is the user's own active sittings, never the grade's every sitting.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aPrefixHoldingTheCallsOwnValueLeadsOneAClosedRowBinds = stageProperty(
	"slot",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\t\t\tconst unit = coversUnit(source, closed.bound)\n",
			replacement: "\t\t\tconst unit = false\n",
			why: "No bound field determines a unit's key: once the course binds the grade and track, the seats' two-column grade key outranks the child's seats, read by the user's one-column prefix of their key, and leads, every child's seats of the grade read, past three times the child's rows."
		}
	]
)

/**
 * A child's seats of one grade, at the parameters: the grade and track the parameters hold determine no unit's key, a
 * prefix every child's seats of the grade share, where the child's user determines the child, the seats' unit. The
 * grade's seats are the read's existence test, and the child's own seats, one unit's rows, are read at the user, the
 * test per seat (cte-policy semiJoinDriven, by each side's rank), the child's rows alone however many children's seats
 * hold the grade, never every child's seats of the grade read at their keys.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aParameterThatDeterminesNoUnitDrivesNoUnitsRead = stageProperty("grade", boundOracle, [
	{
		file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
		original: "\t\t\tconst unit = coversUnit(source, closed.bound)\n",
		replacement: "\t\t\tconst unit = at.length > 0 || coversUnit(source, closed.bound)\n",
		why: "Any held value counts as determining a unit's key, a catalog entity's among them: the grade and track parameters rank as the child's seats do and drive them, every child's seats of the grade read at their keys, past three times the child's rows."
	},
	{
		file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
		original: "\t\t!leftLeads(node)\n",
		replacement: "\t\ttrue\n",
		why: "A semi-join's right side drives it whatever its left side's own values bind: the grade's seats drive the child's, every child's seats of the grade read at their keys, past three times the child's rows."
	},
	{
		file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
		original: "\t\t(!restrictedWithin(node.right, node) || leftLeads(node)) &&\n",
		replacement: "\t\t!restrictedWithin(node.right, node) &&\n",
		why: "A right side its parameters restrict stays in a bare EXISTS whatever its left side's values bind: PostgreSQL pulls the test up into a join and reads the grade's every seat first, probing the child's seats once for each, past three times the child's rows."
	}
])

/**
 * The open ones of a range of seats, at the parameters: the flag a parameter holds is a code, a boolean every child's
 * seats share, so it starts no prefix of the flags' key (open, seat), and the range a row function of the parameters
 * yields leads (cte-policy keyedRegionChain), each seat's flag then read at the key, the range's rows alone however many
 * children's seats are open.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aParameterOfACodeStartsNoPrefix = stageProperty("open", boundOracle, [
	{
		file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
		original: "const codeTyped = (type: ScalarType): boolean => fewValued[baseOf(type).carrier]\n",
		replacement:
			"const codeTyped = (type: ScalarType): boolean => fewValued[baseOf(type).carrier] && false\n",
		why: "A code's value starts a prefix as any value does: the open flag leads the flags' key by one column, which outranks the range a row function yields, and every child's open seats are read first, past three times the range's rows."
	}
])

/**
 * A sitting's credit, a row function whose rows argument reads the fold at the sitting row's child and stage, reads that
 * stage's rows alone however many children the store holds beside it: the argument's fold is read once per row, at the
 * row's values, its chain led by the stage's sessions.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallsRowsArgumentBoundAtItsRowReadsTheFoldAtThatRowsKeysAlone = stageProperty(
	"credit",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\tconst outer = region.correlated.filter((c) => readsOuter(c.expr))\n",
			replacement:
				"\tconst outer = region.correlated.filter((c) => readsOuter(c.expr) && false)\n\treturn []\n",
			why: "A correlated region's source is no row site: the argument's fold is the statement's CTE keyed at every sitting's child and stage, computed again inside each row's call, every child's rows read."
		}
	]
)

/**
 * A sitting's credit, a row function whose rows argument reads the fold at the sitting row's child and stage and at its
 * latest time, the fold's aggregate, reads that stage's rows alone however many children the store holds beside it: the
 * fold is read at its grouping keys, and its latest time kept where the fold delivers it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallsRowsArgumentBoundAtAFoldsAggregateReadsTheFoldAtItsGroupingKeys = stageProperty(
	"latest",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/shapes/region/index.ts",
			original:
				"\t\t\t\t\t[site.source, holdsInside(site.source, equalities) ? equalities : noRestriction] as const,\n",
			replacement: "\t\t\t\t\t[site.source, equalities] as const,\n",
			why: "A correlated site holds its whole restriction inside, the fold its aggregate's value too: the fold's lowering finds a restricted column that is none of its grouping keys, an internal invariant, and the read dies."
		}
	]
)

/**
 * A sitting's stage's latest attempts, the sitting read only as an existence test of the head's rows, reads that stage's
 * rows alone however many children the store holds beside it: the test's right side drives the fold's read.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aFoldAHeadReadsBesideAnExistenceTestIsReadAtTheTestsRowsKeys = stageProperty(
	"exists",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\t\trestrictedByValues(node.right) &&\n\t\tkeyPrefixBound(\n",
			replacement: "\t\trestrictedByValues(node.right) && false &&\n\t\tkeyPrefixBound(\n",
			why: "A semi-join is never driven by its right side: the sitting's existence test is a bare EXISTS beside the fold's region, which PostgreSQL reads by its estimates, every attempt of the child first, past three times the stage's rows."
		}
	]
)

/**
 * A sitting with its stage's latest attempts attached, each with its marks attached in turn, reads that stage's rows
 * alone however many children the store holds beside it: the parent key reaches the fold through the inner attachment.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anAttachmentWhoseChildIsAnAttachmentCarriesItsKeyIntoTheInnerParent = stageProperty(
	"nested",
	boundOracle,
	[
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original: '\t\t\tcase "Attach":\n\t\t\t\tdeliver(at, at.parent, equalities, false)\n',
			replacement: '\t\t\tcase "Attach":\n',
			why: "The parent key stops at an attachment: the inner attachment's parent, the fold read at the sitting's keys, reads a fold derived whole for every child stored, beside each key."
		}
	]
)

/**
 * A sitting with each pair of its stage's latest attempts attached, the fold read twice under the attachment, reads that
 * stage's rows alone however many children the store holds beside it: both reads are reached at the one key, and the
 * fold is derived once there, held in the key's query, each read a scan of its rows. Its plan derives the fold once in
 * all, counted by the runs of the scans of its relations (magic-sets.fixtures.ts runStage `derivations`): a fold lowered
 * at each read is derived at each, a second reading of the stage's sessions and attempts that stays within the rows'
 * bound, PostgreSQL reading the second derivation again for each row of the first from a sort it keeps of it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aNodeReadTwiceUnderARowSiteAtOneKeyIsReadAtTheKeyAtBoth = stageProperty(
	"pairs",
	`${boundOracle}; and the fold derived once in all, at the sitting's one key: the fewer runs of the scans of its two relations, the item sessions and their attempts, summed over every loop, one`,
	[
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original: "\t\t\tat.length !== reads.get(node) ||\n",
			replacement: "\t\t\tat.length !== 1 ||\n",
			why: "A node read twice under a row site is reached by neither read: the fold both reads of the pair read is the statement's CTE, derived whole for every child stored."
		},
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				"\t\t\tr.readers.filter((reader) => lowered.has(reader)).length > 1 &&\n\t\t\touterOf(r.node).every((c) => !within.has(c.node))\n",
			replacement: "\t\t\tfalse\n",
			why: "A node read twice under a row site is lowered at each read: the fold is derived at both reads of the pair, the stage's sessions and their attempts read twice for the sitting's one key (two runs of each relation's scans, where held it is one), the second derivation read again for each row of the first from a sort PostgreSQL keeps of it, within three times the stage's rows."
		}
	]
)
