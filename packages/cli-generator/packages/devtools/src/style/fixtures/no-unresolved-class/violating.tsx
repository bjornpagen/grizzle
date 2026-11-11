import { cva } from "class-variance-authority"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { cn } from "#style/fixtures/support/cn.ts"

const sizes = cva("inline-flex", {
	variants: {
		size: {
			sm: "h-7 gap-1",
			lg: "h-9 gap-huge" // violation
		}
	},
	compoundVariants: [{ size: "sm", class: "px-tiny" }] // violation
})

const muted = twMerge(clsx("text-muted-foregrund")) // violation

const LABELS = { quiet: "text-xs", loud: "text-xxl" } as const // violation

const panel = { className: "rounded-hugeish" } // violation

const TONES: Readonly<Record<"calm" | "loud", string>> = {
	calm: "text-muted-foreground",
	loud: "text-shouting" // violation
}

export function decorate(element: HTMLElement) {
	element.classList.add("flex", "gap-bogus") // violation
	element.classList.toggle("hidden", Boolean(panel))
	element.setAttribute("class", "p-bogus") // violation
	element.setAttribute("aria-label", "p-bogus")
	element.className = "m-bogus" // violation
}

export function UnresolvedFixture({
	active,
	className = "text-bogus" // violation
}: Readonly<{ active: boolean; className?: string }>) {
	const titleClass = active ? "flex-1 line-thru" : "flex-1" // violation
	return (
		<div
			className="flex p-huge" // violation
		>
			<span
				className={cn("items-center", "bg-prmary")} // violation
			/>
			<span className={sizes({ size: "sm" })} />
			<span
				className={sizes({ size: "lg", className: "w-bogus" })} // violation
			/>
			<span className={titleClass} />
			<span className={TONES[active ? "calm" : "loud"]} />
			<span className={cn(muted, LABELS.loud, className)} />
		</div>
	)
}
