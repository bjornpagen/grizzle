import { firstIndex } from "#compiler/core/array.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type {
	MetaChoice,
	MetaLosses,
	MetaWitness,
	ReadCandidate,
	ReadDecisions,
	ReadLoss,
	ReadOffer
} from "#compiler/deploy/render/folder.ts"

import {
	type StatementToken,
	splitStatements,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"

/** A decision check refuses: a candidate chosen at one statement it marks and kept at another, or written otherwise than
 * it drafts it, or a group the reviewer confirms as one kept in part (`split`); or a candidate chosen without one it
 * depends on (`orphan`): nested in another's alternative chosen while that one is not, which decides a statement the
 * reviewer never took, or chosen without a candidate it requires, a field's rename whose column keeps its rows only
 * under that type's rename; or two chosen candidates that take one removed name away or give one added name twice
 * (`twice`), whose second rename fails once the first ran. */
interface SplitRename {
	readonly kind: "split" | "orphan" | "twice"
	readonly file: string
	/** What is wrong, naming the candidate and the statement. */
	readonly detail: string
}

/** The tokens of each statement text, read once per text however often it is compared. */
const tokensOf = (): ((statement: string) => ReadonlyArray<StatementToken>) => {
	const read = new Map<string, ReadonlyArray<StatementToken>>()
	return (statement) => {
		const known = read.get(statement)
		if (known !== undefined) {
			return known
		}
		const tokens = statementTokens(statement)
		read.set(statement, tokens)
		return tokens
	}
}

/** Each of `candidates` paired with its witness, the candidates numbered as meta.json numbers them: the first statement among its offers'
 * statements, in record order, that no other candidate's offer holds and that no choice keeps (in practice its ALTER
 * ... RENAME), so a reviewed folder holds it exactly when the reviewer chose the candidate; or the first candidate with
 * none, which a draft never offers. */
export const witnessesOf = <C>(
	candidates: ReadonlyArray<C>,
	choices: ReadonlyArray<MetaChoice>
): Result.Result<ReadonlyArray<readonly [C, MetaWitness]>, number> => {
	const tokens = tokensOf()
	const kept = choices.map((choice) => tokens(choice.keep))
	const same = (a: string, b: string): boolean => writtenAs(tokens(a), tokens(b))
	/** Whether only candidate `n`'s offers hold `statement`, and no choice keeps it. */
	const own = (statement: string, n: number): boolean =>
		kept.every((k) => !writtenAs(k, tokens(statement))) &&
		choices.every((choice) =>
			choice.offers.every((o) => o.candidate === n || !o.statements.some((x) => same(x, statement)))
		)
	/** Candidate `n`'s witnesses, in record order. */
	const witnesses = (n: number): ReadonlyArray<MetaWitness> =>
		choices.flatMap((choice, k) =>
			choice.offers
				.filter((o) => o.candidate === n)
				.flatMap((o) =>
					o.statements.flatMap((x, i) => (own(x, n) ? [{ choice: k, statement: i }] : []))
				)
		)
	const out: Array<readonly [C, MetaWitness]> = []
	for (const [n, candidate] of candidates.entries()) {
		const [witness] = witnesses(n)
		if (witness === undefined) {
			return Result.err(n)
		}
		out.push([candidate, witness])
	}
	return Result.ok(out)
}

/** Whether two offers replace a statement with the same statements, in order. */
const sameStatements = (
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
	tokens: (statement: string) => ReadonlyArray<StatementToken>
): boolean =>
	a.length === b.length &&
	a.every((x, i) => {
		const y = b[i]
		return y !== undefined && writtenAs(tokens(x), tokens(y))
	})

/** A folder's files as `grizzle check` reads its decisions: each file's statements, the candidates chosen (those whose
 * witness's file holds the witness), and whether a file holds a statement written as a drafted one. */
interface ReadFiles {
	readonly tokens: (statement: string) => ReadonlyArray<StatementToken>
	readonly heldIn: (file: string) => ReadonlyArray<ReadonlyArray<StatementToken>>
	readonly holds: (held: ReadonlyArray<ReadonlyArray<StatementToken>>, statement: string) => boolean
	readonly chosen: ReadonlySet<ReadCandidate>
}

const readFiles = (
	decisions: ReadDecisions,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadFiles => {
	const tokens = tokensOf()
	const statements = new Map<string, ReadonlyArray<ReadonlyArray<StatementToken>>>(
		files.map((f) => [f.name, splitStatements(f.text).map((x) => statementTokens(x))])
	)
	/** A file meta.json names that the folder does not hold has no statement. */
	const heldIn = (file: string): ReadonlyArray<ReadonlyArray<StatementToken>> =>
		statements.get(file) ?? []
	/** Whether `held` holds a statement written as the drafted `statement`. */
	const holds = (held: ReadonlyArray<ReadonlyArray<StatementToken>>, statement: string): boolean =>
		held.some((s) => writtenAs(tokens(statement), s))
	const chosen = new Set(
		decisions.candidates.filter((c) => holds(heldIn(c.witness.file), c.witness.statement))
	)
	return { tokens, heldIn, holds, chosen }
}

/** What a loss loses, as a refusal names it. */
export const lossText = (loses: MetaLosses): string => {
	switch (loses.kind) {
		case "relation":
			return `the relation ${loses.relation} with its rows`
		case "field":
			return `the field ${loses.relation}.${loses.field} with its values`
		case "schema":
			return `the rows of ${loses.abandoned.map((a) => `the schema ${a.schema} (${a.directory})`).join(" and ")}, which the configuration no longer lists, left behind as ${loses.schema} starts empty`
	}
}

/** How the reviewer decided a loss, read from its file: its statement written in, so the data is lost; left out with a
 * candidate that carries the data chosen, so it is carried; left out with none, unresolved; or written in while a
 * carrier is chosen, decided both ways. A loss in the alternative of a candidate not chosen is no decision: the
 * relation's own loss decides its rows, and the field's statement written in there is an orphan. */
export type LossDecided =
	| { readonly kind: "lost"; readonly loss: ReadLoss }
	| {
			readonly kind: "carried"
			readonly loss: ReadLoss
			readonly by: NonEmptyReadonlyArray<ReadCandidate>
	  }
	| { readonly kind: "unresolved"; readonly loss: ReadLoss }
	| {
			readonly kind: "both"
			readonly loss: ReadLoss
			readonly by: NonEmptyReadonlyArray<ReadCandidate>
	  }
	| { readonly kind: "orphan"; readonly loss: ReadLoss; readonly within: ReadCandidate }

const decideLosses = (decisions: ReadDecisions, read: ReadFiles): ReadonlyArray<LossDecided> =>
	decisions.losses.flatMap((loss): ReadonlyArray<LossDecided> => {
		const held = read.holds(read.heldIn(loss.file), loss.statement)
		if (loss.within.kind === "within" && !read.chosen.has(loss.within.candidate)) {
			return held ? [{ kind: "orphan", loss, within: loss.within.candidate }] : []
		}
		const by = loss.carriers.filter((c) => read.chosen.has(c))
		if (isNonEmpty(by)) {
			return [held ? { kind: "both", loss, by } : { kind: "carried", loss, by }]
		}
		return [held ? { kind: "lost", loss } : { kind: "unresolved", loss }]
	})

/** Every loss of a folder whose meta.json records `decisions`, as the reviewer decided it in `files`. */
export const lossDecisions = (
	decisions: ReadDecisions,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadonlyArray<LossDecided> => decideLosses(decisions, readFiles(decisions, files))

/** The candidates' labels, as a refusal lists them. */
const labels = (candidates: ReadonlyArray<ReadCandidate>): string =>
	candidates.map((c) => c.label).join("; ")

/** The split a loss decision is, when it is decided both ways or written in inside an alternative not chosen. */
const lossSplit = (d: LossDecided): ReadonlyArray<SplitRename> => {
	switch (d.kind) {
		case "lost":
		case "carried":
		case "unresolved":
			return []
		case "both":
			return [
				{
					kind: "split",
					file: d.loss.file,
					detail: `${lossText(d.loss.loses)} is dropped by the statement written in, and carried by ${labels(d.by)}, which is chosen: write the statement in or choose the rename, not both: ${d.loss.statement}`
				}
			]
		case "orphan":
			return [
				{
					kind: "orphan",
					file: d.loss.file,
					detail: `${lossText(d.loss.loses)} is dropped inside ${d.within.label}, which is not chosen: ${d.loss.statement}`
				}
			]
	}
}

/** The split decisions of a folder whose meta.json records `decisions`, read back from its files.
 * A drafted rename candidate leaves the choice to the reviewer: keep the drop and add, or swap in the commented
 * `ALTER ... RENAME`. meta.json records each statement a candidate decides and what each candidate replaces it with,
 * each candidate's witness, and each group the reviewer confirms as one. The decision is data: each candidate is chosen
 * exactly when its witness's file holds its witness, decided once; `grizzle check` then reads the files against those
 * decisions, so a candidate is decided one way in every file, and a group stands whole or is gone whole. Every
 * statement is compared as PostgreSQL's scanner reads it (`writtenAs`), never as text. A loss, a statement that loses
 * stored data, is drafted commented, and decided by the statement itself: written in, the data is lost; left out with a
 * candidate that carries the data chosen, it is carried; left out with none, the loss is unresolved, which
 * `grizzle check` and `grizzle migrate` refuse (`lossDecisions`). Whichever way the reviewer decides, the folder ends at
 * its target snapshot, so nothing after the folder reads the decision.
 * A candidate must be chosen at every statement it marks or at none, since one choice changes what every one of them
 * must do. Choosing it at one and keeping another fails that statement, or leaves the renamed relation without what the
 * kept one creates, and the admission after the migration refuses the catalog once the files committed. Each
 * candidate's decision is read once, from the witness meta.json records for it: it is chosen exactly when the
 * witness's file holds the witness. Every statement a choice decides is then checked against the decisions: kept as
 * drafted when no candidate it offers is chosen, replaced as the offer says when one is, and never decided two ways by
 * two chosen candidates. A chosen candidate's required candidates must be chosen too, and no two chosen candidates
 * rename one removed name or onto one added name (meta.json records what each renames). A group the reviewer confirms
 * under one marker is one decision: its file holds every statement of it as drafted, or none of them. */
export const splitRenames = (
	decisions: ReadDecisions,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): ReadonlyArray<SplitRename> => {
	const read = readFiles(decisions, files)
	const { tokens, heldIn, holds, chosen } = read
	/** A statement a chosen offer writes is that offer's, however like another choice's kept statement its text is: what a
	 * file holds beyond its chosen offers' statements, one held statement taken per statement an offer writes. */
	const unclaimedIn = (file: string): ReadonlyArray<ReadonlyArray<StatementToken>> => {
		const claimed = decisions.choices
			.filter((choice) => choice.file === file)
			.flatMap((choice) => choice.offers.filter((offer) => chosen.has(offer.candidate)))
			.flatMap((offer) => offer.statements)
		let rest = heldIn(file)
		for (const x of claimed) {
			const at = firstIndex(rest, (s) => writtenAs(tokens(x), s))
			if (at !== undefined) {
				rest = rest.toSpliced(at, 1)
			}
		}
		return rest
	}
	/** Each pair of chosen candidates of one kind that renames one removed name, or onto one added name. */
	const picked = [...chosen]
	const twice = picked.flatMap((candidate, i): ReadonlyArray<SplitRename> =>
		picked
			.slice(i + 1)
			.filter(
				(other) =>
					other.renames.kind === candidate.renames.kind &&
					(other.renames.removed === candidate.renames.removed ||
						other.renames.added === candidate.renames.added)
			)
			.map((other) => ({
				kind: "twice",
				file: other.witness.file,
				detail: `${candidate.label} and ${other.label} are both chosen, and rename one name twice: choose at most one rename for each added and each removed name`
			}))
	)
	const unmet = [...chosen].flatMap((candidate): ReadonlyArray<SplitRename> => {
		const missing = candidate.requires.filter((r) => !chosen.has(r))
		return missing.length === 0
			? []
			: [
					{
						kind: "orphan",
						file: candidate.witness.file,
						detail: `${candidate.label} is chosen without ${labels(missing)}, which it requires: ${candidate.witness.statement}`
					}
				]
	})
	/** The candidates every choice offering them is nested in another's alternative: a field's rename inside a relation's.
	 * A nested choice may also offer a candidate decided elsewhere, a type's rename that makes a conversion unnecessary. */
	const nestedOnly = new Set(
		decisions.candidates.filter((candidate) =>
			decisions.choices
				.filter((choice) => choice.offers.some((o) => o.candidate === candidate))
				.every((choice) => choice.within.kind === "within")
		)
	)
	/** Each choice's statement checked against the decisions. A choice nested in a rename's alternative decides a
	 * statement only where that rename is chosen: elsewhere the alternative, and the choice with it, stays commented, and
	 * choosing one of its own candidates is refused. Several chosen candidates decide one statement as one decision when
	 * they decide it the same way: each deletes it, or each replaces it with the same statements. */
	const decided = decisions.choices.flatMap((choice): ReadonlyArray<SplitRename> => {
		const at = (detail: string): SplitRename => ({ kind: "split", file: choice.file, detail })
		if (choice.within.kind === "within" && !chosen.has(choice.within.candidate)) {
			const orphans = choice.offers
				.map((o) => o.candidate)
				.filter((c) => chosen.has(c) && nestedOnly.has(c))
			return orphans.length === 0
				? []
				: [
						{
							kind: "orphan",
							file: choice.file,
							detail: `${labels(orphans)} is chosen inside ${choice.within.candidate.label}, which is not chosen: ${choice.keep}`
						}
					]
		}
		const held = heldIn(choice.file)
		const keptHere = holds(unclaimedIn(choice.file), choice.keep)
		const here = choice.offers.filter((offer: ReadOffer) => chosen.has(offer.candidate))
		if (!isNonEmpty(here)) {
			return keptHere
				? []
				: [
						at(
							`a statement ${labels(choice.offers.map((o) => o.candidate))} decides is neither kept as drafted nor replaced by a chosen candidate: ${choice.keep}`
						)
					]
		}
		const [one, ...others] = here
		if (others.some((o) => !sameStatements(o.statements, one.statements, tokens))) {
			return [
				at(
					`chosen candidates ${labels(here.map((o) => o.candidate))} decide this statement in different ways: ${choice.keep}`
				)
			]
		}
		const { label, witness } = one.candidate
		/** A delete offer has no statements, so only the kept statement's absence is required. */
		const replaced = one.statements.every((x) => holds(held, x))
		return [
			...(keptHere
				? [at(`statement kept, but ${label} is chosen in ${witness.file}: ${choice.keep}`)]
				: []),
			...(replaced
				? []
				: [
						at(
							`${label} is chosen, but this statement is not replaced as its alternative says: ${choice.keep}`
						)
					])
		]
	})
	const confirmed = decisions.confirms.flatMap((group): ReadonlyArray<SplitRename> => {
		const held = heldIn(group.file)
		const kept = group.statements.filter((x) => holds(held, x))
		return kept.length === 0 || kept.length === group.statements.length
			? []
			: [
					{
						kind: "split",
						file: group.file,
						detail: `${kept.length} of the ${group.statements.length} statements confirmed as one decision are kept as drafted, and the others are not: ${group.statements[0]}`
					}
				]
	})
	const losses = decideLosses(decisions, read).flatMap((d) => lossSplit(d))
	return [...unmet, ...twice, ...decided, ...confirmed, ...losses]
}
