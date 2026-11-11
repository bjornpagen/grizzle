import { cn } from "#style/fixtures/support/cn.ts"

export function ResolvedFixture({ active }: Readonly<{ active: boolean }>) {
	return (
		<div className="group/fixture peer @container flex hover:bg-primary/80 dark:bg-input/30 rounded-[var(--radius-md)]">
			<span className={cn("text-sm font-black", active && "font-medium", { underline: active })} />
			<span className="[&_svg]:size-4 group-hover/fixture:opacity-50 has-data-[icon=inline-end]:pr-2" />
		</div>
	)
}

export function decorate(element: HTMLElement) {
	element.classList.add("flex", "gap-2")
	element.classList.replace("gap-2", "gap-4")
	element.setAttribute("class", "p-2")
}
