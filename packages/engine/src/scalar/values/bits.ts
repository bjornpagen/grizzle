/**
 * A set over a roster that states its roster, which Bits.of makes: a Set of the roster's handles holding the roster's
 * name. One roster's handles spell those of another roster that shares their names, so every door that admits a set at
 * a roster's field, a literal's and a parameter's, holds a set that states its roster to that field's; a Set of no
 * roster states none and is read by its names alone. It is a Set the caller owns, which every boundary copies, and its
 * roster is frozen with it.
 */
export class RosterSet<H extends string> extends Set<H> {
	readonly roster: string

	constructor(roster: string, handles: Iterable<H>) {
		super(handles)
		this.roster = roster
		Object.freeze(this)
	}
}

/** The roster a set states, the name of the roster Bits.of made it over; undefined for a Set of no roster. */
export const statedRoster = (set: ReadonlySet<unknown>): string | undefined =>
	set instanceof RosterSet ? set.roster : undefined
