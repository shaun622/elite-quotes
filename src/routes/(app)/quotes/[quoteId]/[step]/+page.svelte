<script lang="ts">
	import StepShell from '$lib/components/wizard/StepShell.svelte';
	import { STEPS } from '$lib/wizard';
	import Step1Client from './_steps/Step1Client.svelte';
	import StepPlaceholder from './_steps/StepPlaceholder.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Quote #{data.quoteNumber} — Step {data.step} — Elite Walls</title>
</svelte:head>

<StepShell quoteId={data.quoteId} current={data.step} steps={[...STEPS]} quoteNumber={data.quoteNumber}>
	{#if data.step === 1}
		<Step1Client
			quoteId={data.quoteId}
			data={data.data}
			dataHash={data.dataHash}
			versionNumber={data.versionNumber}
			mapboxToken={data.mapboxToken}
		/>
	{:else if data.step === 2}
		<StepPlaceholder
			title="Plan view — draw walls on satellite"
			body="The map drawing surface lands in PR2. You'll search for an Australian property, the boundary loads from the state cadastre WFS, and you draw wall paths over the satellite imagery."
		/>
	{:else if data.step === 3}
		<StepPlaceholder
			title="Elevation — set retained heights"
			body="Per-post Retained Ground Level (RGL) and Natural Ground Level (NGL) editor lands in PR3. Drag post handles to set heights; snaps to the 200 mm panel module. Walls flagged for engineer cert when over postcode-aware thresholds (QLD 1000 mm, NSW 600 mm) or with a surcharge load."
		/>
	{:else if data.step === 4}
		<StepPlaceholder
			title="Materials & options"
			body="Material category selectors (block type, capping, drainage). Auto-populated from wall geometry once Steps 2 + 3 are wired."
		>
			<dl>
				<div><dt>Block type</dt><dd>{data.data.materials.blockType || '—'}</dd></div>
				<div><dt>Capping</dt><dd>{data.data.materials.capping || '—'}</dd></div>
				<div><dt>Drainage</dt><dd>{data.data.materials.drainage || '—'}</dd></div>
			</dl>
		</StepPlaceholder>
	{:else if data.step === 5}
		<StepPlaceholder
			title="Pricing & margin"
			body="Rates × quantities, applied margin, GST. Editable line items land alongside the takeoff in PR4."
		>
			<dl>
				<div><dt>Subtotal</dt><dd>${(data.data.pricing.subtotalCents / 100).toFixed(2)}</dd></div>
				<div><dt>Margin</dt><dd>{data.data.pricing.marginPct}%</dd></div>
				<div><dt>GST</dt><dd>{data.data.pricing.gstPct}%</dd></div>
				<div><dt>Total</dt><dd>${(data.data.pricing.totalCents / 100).toFixed(2)}</dd></div>
			</dl>
		</StepPlaceholder>
	{:else if data.step === 6}
		<StepPlaceholder
			title="Review & export"
			body="Generates the client PDF and the internal installer takeoff (no pricing). PDF rendering ships in PR3. The shareable JSON view at /api/quotes/[id].json is already live."
		>
			<button class="btn-disabled" disabled>Generate PDFs (PR3)</button>
		</StepPlaceholder>
	{/if}
</StepShell>

<style>
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.75rem 1.5rem;
		margin: 1.25rem 0 0;
	}
	dl > div {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.625rem 0.875rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	dt {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		font-weight: 500;
	}
	.btn-disabled {
		margin-top: 1rem;
		padding: 0.625rem 1rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		cursor: not-allowed;
	}
</style>
