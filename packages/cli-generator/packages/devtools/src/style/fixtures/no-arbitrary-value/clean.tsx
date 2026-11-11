export function ThemeValueFixture() {
	return (
		<div className="bg-primary/80 p-4 rounded-md shadow-md">
			<span className="rounded-[var(--radius-md)] text-[length:var(--text-sm)]" />
			<span className="bg-(--color-primary) border-(length:--spacing-hairline) z-(--z-overlay)" />
			<span className="data-[size=sm]:p-2 has-data-[slot=fixture]:pb-0 [&_svg]:size-4 aria-[expanded=true]:p-2" />
		</div>
	)
}
