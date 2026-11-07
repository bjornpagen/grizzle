import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { InteriorDesc } from "#compiler/ir/desc.ts"
import type { VarRef } from "#compiler/ir/open.ts"
import type { ScalarEnv } from "#compiler/scalar/registry.ts"
import type { WrittenOver } from "#compiler/schema/level.ts"

/** A builder location: the label, the path under it (empty at the label itself) and the user's call site. */
export const buildLoc = (label: string, path: ReadonlyArray<string | number>): SourceLoc =>
	captureLoc(label, path)

/**
 * What a query knows about the schema it is written over: the schema value, when the query was built by query(S), what
 * it is written over (schema/level.ts WrittenOver), which a rule that matches the query must be over a level above, and
 * the field environment that resolves a closed reference's roster by name.
 */
export interface SchemaInfo {
	readonly value: unknown
	readonly over: WrittenOver
	readonly env: ScalarEnv
}

/**
 * Hygiene for the query builder.
 *
 * A rule's variables, its interior stages and an attachment's parent variables are scoped, and the Description names
 * them only by spelling. While a rule is being built, the expressions of its clauses name each by a reference object
 * instead (ir/open.ts Open), which records the scope it belongs to:
 *
 * - a variable v minted records the build and the rule callback it was minted in, or that it was minted in an
 *   attachment child outside its rules, whose rules adopt it; the call to v that minted it, its scope, which carries
 *   the name v was given; and its field, origin and call site. The object is its identity, so each call to v mints
 *   fresh variables, however the calls are made;
 * - an interior stage records the rule callback that describes it, and its id "i<n>" in that rule, in creation order;
 * - a parent variable records its attachment child, and the parent's column it reads.
 *
 * Builders run synchronously, so each scope (a build, a rule callback, an attachment child) knows whether it is
 * running. `find` spells every reference of its rule (rule.ts finishRule): each variable by its scope's name and its
 * field, `<name>.<field>`, unique within the rule since a rule holds one scope of each name (two are
 * DuplicateIdentity), and listed in RuleDesc.vars with their origins in order of first use, so building one query
 * twice gives one Description; an interior stage by its id; a parent variable by its bare column, its attachment kept
 * among the rule's pending ones, which the attachment checks are its own when its child returns (attach.ts runAttach).
 * No reference reaches a Description.
 *
 * Spelling is where capture is refused. A variable of an enclosing rule callback still running that reaches an inner
 * rule (an interior stage, an imported query, an attachment child built inside the callback) would otherwise be read by
 * the inner rule as a variable of its own, silently decorrelating it; correlation goes through `Q.bind` or an
 * attachment's parent variables, never through capture, so such a use is refused. So is a variable both rules would
 * adopt, one minted in an attachment child outside its rules or in a rule that has finished, when one rule encloses the
 * other: each rule records the variables it uses, and a rule refuses one that an enclosing or nested rule also uses
 * (`sharedVariable`). Sibling rules may each adopt a variable minted outside them. A variable belongs to the build that
 * minted it, the run of the outermost callback the builder starts while none is running with every callback that runs
 * inside it: carried out of its build into another, it is refused, never adopted. v outside every rule callback is
 * refused (query.ts varsOver): no schema would type its variables. An interior stage is spelled only in the rule that
 * describes it, and a parent variable only in the top-level rules of its attachment's own child while that child runs:
 * one used outside it, or in an interior stage, an imported query or a nested attachment's child, is refused.
 *
 * The running build is this module's one piece of state: the dynamic scope a call to the free function `v`, and a
 * nested rule callback, read the innermost running rule from. It lives only for the dynamic extent of its outermost
 * callback: every frame is left, and the build ended, however a callback exits, so a throwing callback leaves nothing
 * behind, and nothing here is a cache.
 *
 * One invocation of a rule callback: a builder arm, a recursive arm, an interior stage.
 */
export interface RuleContext {
	/**
	 * The innermost rule callback running when this one started: the rule whose callback builds this rule, as an
	 * interior stage, an imported query, a recursive arm or an attachment child. Rules nested this way must not share a
	 * variable (see `sharedVariable`).
	 */
	readonly parent: RuleContext | undefined
	readonly schema: SchemaInfo
	/** The recursive definition whose `self` this arm may match, for a recursive arm. */
	readonly selfToken: object | undefined
	/** The variables this rule's finished clauses use. */
	readonly used: Set<VarRef>
	/** The variables the finished rules nested in this one use, at any depth. */
	readonly usedBelow: Set<VarRef>
	/** The interior stages described with r.interior, in creation order: the n-th is "i<n>". */
	readonly interiors: Array<InteriorDesc>
	/** Whether this rule's callback is running now. */
	active: boolean
}

/** One attachment child being built: whether its callback is running now. */
export interface AttachScope {
	active: boolean
}

/** A callback running now: a rule callback or an attachment child. */
type Frame = { readonly rule: RuleContext } | { readonly attach: AttachScope }

/**
 * A build: the callbacks running now, innermost last, rule callbacks and attachment children interleaved as they nest;
 * and whether it is running, which it is from its outermost callback's start to its end.
 */
interface Build {
	readonly frames: Array<Frame>
	active: boolean
}

/**
 * The build running now, none between builds. A callback the builder runs while none is running starts a build, which
 * ends when that callback returns, however it exits.
 */
let running: Build | undefined

/** The callbacks running now, innermost last: none between builds. */
const runningFrames = (): ReadonlyArray<Frame> => (running === undefined ? [] : running.frames)

/** A build started now and ended, with its running, when `scope` is disposed. */
const startBuild = (scope: DisposableStack): Build => {
	const build: Build = { frames: [], active: true }
	running = build
	scope.defer(() => {
		build.active = false
		running = undefined
	})
	return build
}

/**
 * Runs `body` with `frame` as the innermost running callback, its scope active, in the running build or, between
 * builds, in a build it starts; the frame is left, its scope inactive and a build it started ended, however body exits.
 */
const withFrame = <A>(frame: Frame, body: () => A): A => {
	using scope = new DisposableStack()
	const build = running ?? startBuild(scope)
	const entered = "rule" in frame ? frame.rule : frame.attach
	build.frames.push(frame)
	entered.active = true
	scope.defer(() => {
		entered.active = false
		build.frames.pop()
	})
	return body()
}

export const newRuleContext = (schema: SchemaInfo, selfToken: object | undefined): RuleContext => ({
	parent: innermostRule(runningFrames()),
	schema,
	selfToken,
	used: new Set(),
	usedBelow: new Set(),
	interiors: [],
	active: false
})

/** Runs `body` with `ctx` as the innermost active rule callback; the frame is left however body exits. */
export const withRule = <A>(ctx: RuleContext, body: () => A): A => withFrame({ rule: ctx }, body)

export const newAttachScope = (): AttachScope => ({ active: false })

/** Runs `body` with `scope` as the innermost running callback; the frame is left however body exits. */
export const withAttach = <A>(scope: AttachScope, body: () => A): A =>
	withFrame({ attach: scope }, body)

/** The innermost running rule callback among `frames`, wherever it is: the schema a source's fields are typed under. */
const innermostRule = (frames: ReadonlyArray<Frame>): RuleContext | undefined => {
	for (let i = frames.length - 1; i >= 0; i--) {
		const frame = frames[i]
		if (frame !== undefined && "rule" in frame) {
			return frame.rule
		}
	}
	return undefined
}

/**
 * Where a call to v mints: the running build its variables belong to; the schema of the innermost running rule
 * callback, which types them; and their owner (ir/open.ts VarRef): the innermost running callback when it is a rule
 * callback, or "adopted" inside an attachment child but outside any of its rules, where a variable belongs to no rule
 * yet and the child's rules adopt it, not the rule whose Finished the child is attached to. None outside every rule
 * callback, where no schema would type them.
 */
interface MintSite {
	readonly build: Build
	readonly schema: SchemaInfo
	readonly owner: RuleContext | "adopted"
}

export const mintSite = (): MintSite | undefined => {
	if (running === undefined) {
		return undefined
	}
	const frames = running.frames
	const enclosing = innermostRule(frames)
	if (enclosing === undefined) {
		return undefined
	}
	const top = frames[frames.length - 1]
	return {
		build: running,
		schema: enclosing.schema,
		owner: top !== undefined && "rule" in top ? top.rule : "adopted"
	}
}

/**
 * A variable a finished rule uses is shared with a nested rule when a rule it encloses, or a rule enclosing it, uses
 * the same variable: one that neither minted (a variable minted in an attachment child outside its rules, or in a
 * rule that has since finished), or one the other rule minted. In the Description each rule would spell it as a variable of its own, two
 * unrelated variables, so the inner rule would be silently decorrelated. Sibling rules (two arms, two
 * interior stages of one rule) enclose neither each other and may each adopt one variable minted outside them.
 */
export const sharedVariable = (ctx: RuleContext, ref: VarRef): boolean => {
	if (ctx.usedBelow.has(ref)) {
		return true
	}
	for (let up = ctx.parent; up !== undefined; up = up.parent) {
		if (up.used.has(ref)) {
			return true
		}
	}
	return false
}

/** Records the variables a finished rule uses, against it and every rule enclosing it. */
export const recordVariables = (ctx: RuleContext, refs: Iterable<VarRef>): void => {
	for (const ref of refs) {
		ctx.used.add(ref)
		for (let up = ctx.parent; up !== undefined; up = up.parent) {
			up.usedBelow.add(ref)
		}
	}
}

/**
 * Checks the builder makes of what a JavaScript caller passes. Each narrows by the check it performs:
 * any function may be called with any arguments and returns some value; an array's elements and an object's string
 * keys are values of unknown type.
 */
type Callback = (...args: ReadonlyArray<unknown>) => unknown
export const isCallback = (value: unknown): value is Callback => typeof value === "function"
export const isObjectRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

/**
 * The relation variables over a source come from, which their origin names in the Description: a relation's, a closed
 * or derived relation's; none for every other source.
 */
export type SourceOrigin =
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "none" }

export const noOrigin: SourceOrigin = Object.freeze({ kind: "none" })

export const relationOrigin = (relation: string): SourceOrigin =>
	Object.freeze({ kind: "relation", relation })
