<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();
	let billingBusy = $state(false);
	let billingMessage = $state('');

	const PLAN_COPY: Record<
		string,
		{
			title: string;
			subtitle: string;
			badge?: string;
			features: string[];
			button: string;
		}
	> = {
		free: {
			title: 'Free',
			subtitle: 'Базовый доступ для знакомства.',
			features: [
				'Gemini Flash-lite без расхода CU',
				'Базовый набор возможностей',
				'Можно перейти на платный тариф в любой момент'
			],
			button: 'Текущий тариф'
		},
		pro: {
			title: 'Pro',
			subtitle: 'Оптимально для регулярной учебы и работы.',
			badge: 'Популярный выбор',
			features: [
				'Доступ ко всем моделям',
				'Сотни простых запросов',
				'До нескольких десятков сложных задач'
			],
			button: 'Выбрать Pro'
		},
		ultra: {
			title: 'Ultra',
			subtitle: 'Для интенсивных исследований и сложных задач.',
			features: [
				'Доступ ко всем моделям',
				'Увеличенный CU-бюджет',
				'Приоритетные возможности тарифа'
			],
			button: 'Выбрать Ultra'
		}
	};

	function planCopy(code: string) {
		return PLAN_COPY[code] ?? PLAN_COPY.free;
	}

	function formatRub(value: unknown) {
		const numeric = Number(value ?? 0);
		return `${(Number.isFinite(numeric) ? numeric : 0).toLocaleString('ru-RU')} ₽`;
	}

	function formatCuFromUsd(value: unknown) {
		const numeric = Number(value ?? 0);
		const cu = Math.max(0, Math.round((Number.isFinite(numeric) ? numeric : 0) * 100));
		return `${cu.toLocaleString('ru-RU')} CU`;
	}

	function formatDate(value: unknown) {
		if (!value) return '—';
		const date = new Date(String(value));
		if (Number.isNaN(date.getTime())) return '—';
		return date.toLocaleDateString('ru-RU');
	}

	function formatPeriodEnd() {
		if (data.billing?.subscription?.plan?.code === 'free') return '∞';
		return formatDate(data.billing?.subscription?.currentPeriodEnd);
	}

	async function checkout(planCode: string) {
		billingBusy = true;
		billingMessage = '';
		try {
			const res = await fetch('/api/billing/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					planCode,
					returnUrl: `${window.location.origin}/pricing?billing=return`
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				billingMessage = payload?.message || 'Не удалось создать платеж.';
				return;
			}
			if (payload.confirmationUrl) {
				window.location.href = payload.confirmationUrl;
				return;
			}
			billingMessage = 'Платеж создан.';
		} finally {
			billingBusy = false;
		}
	}

	async function cancelSubscription() {
		billingBusy = true;
		billingMessage = '';
		try {
			const res = await fetch('/api/billing/cancel', { method: 'POST' });
			if (res.ok) {
				window.location.reload();
				return;
			}
			const payload = await res.json().catch(() => ({}));
			billingMessage = payload?.message || 'Не удалось отменить автопродление.';
		} finally {
			billingBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Тарифы — Koworker AI</title>
</svelte:head>

<main class="pricing-page">
	<header class="pricing-header">
		<a href={resolve('/')} class="back-link" aria-label="Вернуться к чату">
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="M19 12H5M12 19l-7-7 7-7" />
			</svg>
			К чату
		</a>
		<div>
			<p class="eyebrow">Подписка Koworker</p>
			<h1>Выберите тариф</h1>
		</div>
	</header>

	<section class="current-strip" aria-label="Текущая подписка">
		<div>
			<span>Текущий тариф</span>
			<strong>{data.billing?.subscription?.plan?.name ?? 'Free'}</strong>
		</div>
		<div>
			<span>Использовано</span>
			<strong>{formatCuFromUsd(data.billing?.usage?.usedUsd)}</strong>
		</div>
		<div>
			<span>Остаток</span>
			<strong>{formatCuFromUsd(data.billing?.usage?.remainingUsd)}</strong>
		</div>
		<div>
			<span>Период до</span>
			<strong>{formatPeriodEnd()}</strong>
		</div>
	</section>

	{#if billingMessage}
		<div class="billing-message">{billingMessage}</div>
	{/if}

	<section class="plans-grid" aria-label="Выбор тарифа">
		{#each data.plans ?? [] as plan}
			{@const copy = planCopy(plan.code)}
			{@const isCurrent = plan.code === data.billing?.subscription?.plan?.code}
			<article class="plan-card" class:featured={plan.code === 'pro'} class:current={isCurrent}>
				{#if copy.badge}
					<div class="plan-badge">{copy.badge}</div>
				{/if}

				<div class="plan-top">
					<h2>{copy.title}</h2>
					<div class="price-line">
						<strong>{formatRub(plan.priceRub)}</strong>
						<span>/мес</span>
					</div>
					<p>{copy.subtitle}</p>
				</div>

				<div class="cu-budget">
					<span>AI-бюджет</span>
					<strong>{formatCuFromUsd(plan.includedUsd)}</strong>
				</div>

				<ul>
					{#each copy.features as feature}
						<li>
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>{feature}</span>
						</li>
					{/each}
				</ul>

				{#if isCurrent}
					<button class="plan-button current-button" type="button" disabled>Текущий тариф</button>
				{:else if Number(plan.priceRubKopecks) > 0}
					<button
						class="plan-button"
						class:primary={plan.code === 'pro'}
						type="button"
						disabled={billingBusy}
						onclick={() => checkout(plan.code)}
					>
						{copy.button}
					</button>
				{:else}
					<button
						class="plan-button ghost"
						type="button"
						disabled={billingBusy || data.billing?.subscription?.plan?.code === 'free'}
						onclick={cancelSubscription}
					>
						Перейти на Free
					</button>
				{/if}
			</article>
		{/each}
	</section>

	{#if data.billing?.subscription?.plan?.code !== 'free'}
		<section class="cancel-panel">
			<div>
				<strong>Автопродление</strong>
				<span>
					{data.billing?.subscription?.cancelAtPeriodEnd
						? 'Отключено. Доступ сохранится до конца периода.'
						: 'Можно отключить, доступ сохранится до конца оплаченного периода.'}
				</span>
			</div>
			<button
				type="button"
				disabled={billingBusy || data.billing?.subscription?.cancelAtPeriodEnd}
				onclick={cancelSubscription}
			>
				{data.billing?.subscription?.cancelAtPeriodEnd
					? 'Уже отключено'
					: 'Отключить автопродление'}
			</button>
		</section>
	{/if}
</main>

<style>
	.pricing-page {
		height: 100dvh;
		min-height: 100dvh;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior-y: contain;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
		background: var(--bg-base);
		color: var(--text-primary);
		padding: calc(2rem + env(safe-area-inset-top)) max(1.2rem, env(safe-area-inset-right))
			calc(2rem + env(safe-area-inset-bottom)) max(1.2rem, env(safe-area-inset-left));
	}

	@supports (height: 100svh) {
		.pricing-page {
			min-height: 100svh;
		}
	}

	.pricing-header {
		width: min(1180px, 100%);
		margin: 0 auto 1.5rem;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1.5rem;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.9rem;
		font-weight: 700;
		padding: 0.65rem 0.85rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-card);
	}

	.pricing-header > div {
		text-align: right;
	}

	.eyebrow {
		margin: 0 0 0.35rem;
		color: var(--accent-primary);
		font-size: 0.78rem;
		font-weight: 900;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-size: clamp(2.2rem, 6vw, 4.6rem);
		line-height: 0.95;
	}

	.current-strip {
		width: min(1180px, 100%);
		margin: 0 auto 1.4rem;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.7rem;
		padding: 0.85rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
	}

	.current-strip div {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		min-width: 0;
	}

	.current-strip span,
	.cu-budget span,
	.cancel-panel span {
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.current-strip strong {
		color: var(--text-primary);
		font-size: 0.98rem;
		overflow-wrap: anywhere;
	}

	.billing-message {
		width: min(1180px, 100%);
		margin: 0 auto 1rem;
		padding: 0.85rem 1rem;
		border-radius: var(--radius-md);
		border: 1px solid rgba(239, 68, 68, 0.35);
		background: rgba(239, 68, 68, 0.1);
		color: #991b1b;
		font-size: 0.9rem;
	}

	.plans-grid {
		width: min(1180px, 100%);
		margin: 0 auto;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: clamp(1rem, 4vw, 2.7rem);
		align-items: stretch;
	}

	.plan-card {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 29rem;
		padding: clamp(1.5rem, 3vw, 2.35rem);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-subtle);
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.plan-card.featured {
		border-color: color-mix(in srgb, var(--accent-primary) 36%, var(--border-subtle));
		box-shadow: var(--shadow-lg);
		transform: translateY(-0.75rem);
	}

	.plan-card.current {
		outline: 2px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
		outline-offset: 3px;
	}

	.plan-badge {
		position: absolute;
		top: -0.9rem;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		padding: 0.38rem 0.85rem;
		border-radius: 999px;
		background: #a3530a;
		color: #fff8f1;
		font-size: 0.72rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.plan-top h2 {
		margin: 0 0 0.15rem;
		color: color-mix(in srgb, var(--text-primary) 86%, #31523f);
		font-size: clamp(1.55rem, 3vw, 2.1rem);
		line-height: 1;
	}

	.price-line {
		display: flex;
		align-items: flex-end;
		gap: 0.38rem;
		margin-bottom: 1.45rem;
	}

	.price-line strong {
		color: var(--text-primary);
		font-size: clamp(2.7rem, 6vw, 4.1rem);
		line-height: 0.95;
		font-weight: 900;
	}

	.price-line span {
		color: var(--text-secondary);
		font-size: 0.96rem;
		font-weight: 800;
		padding-bottom: 0.25rem;
	}

	.plan-top p {
		min-height: 3.1rem;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.96rem;
		line-height: 1.45;
	}

	.cu-budget {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		margin: 1.4rem 0;
		padding: 0.72rem 0;
		border-top: 1px dashed var(--border-subtle);
		border-bottom: 1px dashed var(--border-subtle);
	}

	.cu-budget strong {
		color: var(--accent-primary);
		font-size: 1rem;
		font-weight: 900;
		text-align: right;
	}

	ul {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1rem;
		margin: 0 0 2rem;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: 0.8rem;
		color: var(--text-secondary);
		font-size: 0.95rem;
		line-height: 1.35;
		font-weight: 700;
	}

	li svg {
		flex: 0 0 auto;
		color: color-mix(in srgb, var(--accent-primary) 72%, var(--text-primary));
		margin-top: 0.1rem;
	}

	.plan-button,
	.cancel-panel button {
		width: 100%;
		min-height: 3.15rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.95rem;
		font-weight: 900;
		cursor: pointer;
		transition:
			transform var(--transition-fast),
			opacity var(--transition-fast),
			background var(--transition-fast);
	}

	.plan-button.primary {
		background: #365842;
		border-color: #365842;
		color: #fff8f1;
	}

	.plan-button:hover:not(:disabled),
	.cancel-panel button:hover:not(:disabled) {
		transform: translateY(-1px);
		opacity: 0.94;
	}

	.plan-button:disabled,
	.cancel-panel button:disabled {
		cursor: default;
		opacity: 0.64;
		transform: none;
	}

	.current-button {
		background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card));
		color: var(--accent-primary);
	}

	.cancel-panel {
		width: min(1180px, 100%);
		margin: 1.2rem auto 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
	}

	.cancel-panel div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.25rem;
	}

	.cancel-panel strong {
		color: var(--text-primary);
	}

	.cancel-panel button {
		width: auto;
		min-width: 14rem;
		background: transparent;
	}

	@media (max-width: 920px) {
		.pricing-header {
			flex-direction: column;
		}

		.pricing-header > div {
			text-align: left;
		}

		.current-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.plans-grid {
			grid-template-columns: 1fr;
			gap: 1rem;
		}

		.plan-card,
		.plan-card.featured {
			min-height: auto;
			transform: none;
		}
	}

	@media (max-width: 560px) {
		.pricing-page {
			padding: calc(1rem + env(safe-area-inset-top)) max(0.8rem, env(safe-area-inset-right))
				calc(1rem + env(safe-area-inset-bottom)) max(0.8rem, env(safe-area-inset-left));
		}

		.current-strip {
			grid-template-columns: 1fr;
		}

		.cancel-panel {
			align-items: stretch;
			flex-direction: column;
		}

		.cancel-panel button {
			width: 100%;
			min-width: 0;
		}
	}
</style>
