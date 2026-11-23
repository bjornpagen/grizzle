/**
 * The term each named term of a conjunction of equalities holds, through any chain of them: the classes the equalities
 * between two named terms join, each anchored at the first term `held` admits that a member is equated with directly,
 * in the equalities' order, else at the first member `held` admits itself. A conjunction's equalities hold together, so
 * every member of a class holds its anchor's value. `nameOf` names a term that stands for a value the equalities may
 * join (a rule's variable, a column of a source), none for any other (a parameter, a literal, a channel), which only
 * anchors. One closure serves every reader of "this term equals that value": the judge's navigation over a rule's
 * conditions (engine analysis/theory/navigate.ts) and the isolation extractor over a statement's (engine
 * program/isolation/extract.ts).
 */
export const equalityClosure = <T>(
	equalities: ReadonlyArray<readonly [T, T]>,
	nameOf: (term: T) => string | undefined,
	held: (term: T) => boolean
): ((name: string) => T | undefined) => {
	const parent = new Map<string, string>()
	const root = (name: string): string => {
		const up = parent.get(name)
		return up === undefined || up === name ? name : root(up)
	}
	for (const [left, right] of equalities) {
		const a = nameOf(left)
		const b = nameOf(right)
		if (a === undefined || b === undefined) {
			continue
		}
		const ra = root(a)
		const rb = root(b)
		if (ra !== rb) {
			parent.set(ra, rb)
		}
	}
	const anchors = new Map<string, T>()
	const anchor = (name: string, term: T): void => {
		if (!anchors.has(root(name))) {
			anchors.set(root(name), term)
		}
	}
	for (const [left, right] of equalities) {
		for (const [named, term] of [
			[left, right],
			[right, left]
		] as const) {
			const name = nameOf(named)
			if (name !== undefined && nameOf(term) === undefined && held(term)) {
				anchor(name, term)
			}
		}
	}
	for (const [left, right] of equalities) {
		for (const side of [left, right]) {
			const name = nameOf(side)
			if (name !== undefined && held(side)) {
				anchor(name, side)
			}
		}
	}
	return (name) => anchors.get(root(name))
}
