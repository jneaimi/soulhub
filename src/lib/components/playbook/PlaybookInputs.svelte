<script lang="ts">
	interface PlaybookInput {
		id: string;
		type: string;
		description?: string;
		required?: boolean;
		default?: string | number;
		options?: string[];
	}

	let { inputs = [], values = $bindable({}) } = $props<{
		inputs: PlaybookInput[];
		values: Record<string, string | number>;
	}>();
</script>

{#if inputs.length > 0}
	<section>
		<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Inputs</h2>
		<div class="border border-hub-border rounded-lg p-4 space-y-3">
			{#each inputs as inp}
				<div>
					<label for="input-{inp.id}" class="block text-xs text-hub-muted mb-1">
						{inp.id}
						{#if inp.required}
							<span class="text-hub-danger">*</span>
						{/if}
						{#if inp.description}
							<span class="text-hub-dim ml-1">-- {inp.description}</span>
						{/if}
					</label>
					{#if inp.type === 'text'}
						<textarea
							id="input-{inp.id}"
							bind:value={values[inp.id]}
							rows="3"
							class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50 resize-y"
							placeholder={inp.description || inp.id}
						></textarea>
					{:else if inp.type === 'select' && inp.options}
						<select
							id="input-{inp.id}"
							bind:value={values[inp.id]}
							class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text focus:outline-none focus:border-hub-info/50"
						>
							<option value="">Select...</option>
							{#each inp.options as opt}
								<option value={opt}>{opt}</option>
							{/each}
						</select>
					{:else if inp.type === 'number'}
						<input
							id="input-{inp.id}"
							type="number"
							bind:value={values[inp.id]}
							class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50"
							placeholder={inp.description || inp.id}
						/>
					{:else}
						<input
							id="input-{inp.id}"
							type="text"
							bind:value={values[inp.id]}
							class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50"
							placeholder={inp.description || inp.id}
						/>
					{/if}
				</div>
			{/each}
		</div>
	</section>
{/if}
