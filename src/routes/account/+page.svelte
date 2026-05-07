<script lang="ts">
	import { resolve } from '$app/paths';

	let { data, form } = $props();
	let billingBusy = $state(false);
	let billingMessage = $state('');

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

	async function logout() {
		const res = await fetch('/api/auth/logout', { method: 'POST' });
		if (res.ok) {
			window.location.href = '/login';
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

<div class="account-container">
	<div class="account-card">
		<header class="account-header">
			<a href={resolve('/')} class="back-link">
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
				Назад к чату
			</a>
			<h1>Личный кабинет</h1>
		</header>

		<div class="profile-section">
			<div class="profile-avatar">
				{data.user?.name?.[0] || data.user?.email?.[0] || '?'}
			</div>
			<div class="profile-info">
				<h2>{data.user?.name || 'Пользователь'}</h2>
				<p>{data.user?.email}</p>
			</div>
		</div>

		<div class="account-details">
			<div class="detail-item">
				<span class="label">Электронная почта</span>
				<span class="value">{data.user?.email}</span>
			</div>
			<div class="detail-item">
				<span class="label">ID пользователя</span>
				<span class="value">{data.user?.id}</span>
			</div>
			<div class="detail-item">
				<span class="label">Статус почты</span>
				<span class={`value ${data.user?.emailVerifiedAt ? 'status-active' : 'status-pending'}`}>
					{data.user?.emailVerifiedAt ? 'Подтверждена' : 'Не подтверждена'}
				</span>
			</div>
		</div>

		<section class="billing-section">
			<div class="billing-heading">
				<h2>Тариф и использование</h2>
				<span class="billing-plan">{data.billing?.subscription?.plan?.name ?? 'Free'}</span>
			</div>
			<div class="usage-grid">
				<div>
					<span>Период</span>
					<strong
						>{formatDate(data.billing?.subscription?.currentPeriodStart)} – {formatDate(
							data.billing?.subscription?.currentPeriodEnd
						)}</strong
					>
				</div>
				<div>
					<span>AI-бюджет</span>
					<strong
						>{formatCuFromUsd(data.billing?.usage?.usedUsd)} / {formatCuFromUsd(
							data.billing?.usage?.includedUsd
						)}</strong
					>
				</div>
				<div>
					<span>Остаток</span>
					<strong>{formatCuFromUsd(data.billing?.usage?.remainingUsd)}</strong>
				</div>
			</div>

			{#if billingMessage}
				<div class="form-message error">{billingMessage}</div>
			{/if}

			<a class="pricing-link" href={resolve('/pricing')}>Выбрать или изменить тариф</a>

			{#if data.billing?.subscription?.plan?.code !== 'free'}
				<button
					class="secondary-btn billing-cancel"
					type="button"
					disabled={billingBusy || data.billing?.subscription?.cancelAtPeriodEnd}
					onclick={cancelSubscription}
				>
					{data.billing?.subscription?.cancelAtPeriodEnd
						? 'Автопродление отключено'
						: 'Отключить автопродление'}
				</button>
			{/if}
		</section>

		<form method="POST" action="?/updateName" class="account-form">
			<h2>Никнейм</h2>
			{#if form?.action === 'updateName' && form?.message}
				<div class={form?.success ? 'form-message success' : 'form-message error'}>
					{form.message}
				</div>
			{/if}
			<div class="form-group">
				<label for="name">Никнейм</label>
				<input
					type="text"
					id="name"
					name="name"
					value={form?.action === 'updateName'
						? (form?.name ?? data.user?.name ?? '')
						: (data.user?.name ?? '')}
					maxlength="80"
					required
				/>
			</div>
			<button class="secondary-btn" type="submit">Сохранить никнейм</button>
		</form>

		<form method="POST" action="?/requestPasswordReset" class="account-form">
			<h2>Пароль</h2>
			{#if form?.action === 'requestPasswordReset' && form?.message}
				<div class={form?.success ? 'form-message success' : 'form-message error'}>
					{form.message}
				</div>
			{/if}
			<p class="form-note">Ссылка для смены пароля придёт на вашу электронную почту.</p>
			<p class="form-note">Письмо может прийти в папку "Спам".</p>
			<button class="secondary-btn" type="submit">Сменить пароль</button>
		</form>

		<button class="logout-btn" onclick={logout}>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
			</svg>
			Выйти из системы
		</button>
	</div>
</div>

<style>
	.account-container {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		max-height: 100dvh;
		overflow-y: auto;
		background: var(--bg-base);
		padding: calc(1.5rem + env(safe-area-inset-top)) calc(1.5rem + env(safe-area-inset-right))
			calc(1.5rem + env(safe-area-inset-bottom)) calc(1.5rem + env(safe-area-inset-left));
	}

	.account-card {
		width: 100%;
		max-width: 560px;
		max-height: calc(100dvh - 3rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
		overflow-y: auto;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}

	.account-card:focus-within {
		scroll-behavior: smooth;
	}

	.account-header {
		margin-bottom: 2.5rem;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.85rem;
		margin-bottom: 1.5rem;
		transition: color var(--transition-fast);
	}

	.back-link:hover {
		color: var(--text-primary);
	}

	.account-header h1 {
		font-size: 1.75rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.profile-section {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding-bottom: 2rem;
		border-bottom: 1px solid var(--border-subtle);
		margin-bottom: 2rem;
	}

	.profile-avatar {
		width: 64px;
		height: 64px;
		min-width: 64px;
		flex: 0 0 64px;
		aspect-ratio: 1;
		background: var(--accent-primary);
		color: var(--bg-base);
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.profile-info {
		min-width: 0;
	}

	.profile-info h2 {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 0.25rem;
		overflow-wrap: anywhere;
	}

	.profile-info p {
		color: var(--text-secondary);
		font-size: 0.95rem;
		overflow-wrap: anywhere;
	}

	.account-details {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: 2.5rem;
	}

	.billing-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding-bottom: 1.8rem;
		margin-bottom: 1.8rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.billing-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.billing-heading h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1.05rem;
		font-weight: 700;
	}

	.billing-plan {
		color: var(--accent-primary);
		font-size: 0.84rem;
		font-weight: 800;
	}

	.usage-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.usage-grid div {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 0;
		border-bottom: 1px dashed var(--border-subtle);
	}

	.usage-grid span {
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.usage-grid strong {
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.pricing-link {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 46px;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		background: var(--accent-primary);
		color: var(--bg-base);
		text-decoration: none;
		font-size: 0.9rem;
		font-weight: 800;
		transition: opacity var(--transition-fast);
	}

	.pricing-link:hover {
		opacity: 0.9;
	}

	.billing-cancel:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.billing-cancel {
		background: transparent;
		color: var(--text-primary);
		border: 1px solid var(--border-subtle);
	}

	.detail-item {
		display: grid;
		grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
		align-items: start;
		gap: 1rem;
		padding: 0.75rem 0;
		border-bottom: 1px dashed var(--border-subtle);
	}

	.detail-item .label {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.detail-item .value {
		min-width: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
		text-align: right;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.status-active {
		color: #10b981 !important;
	}
	.status-pending {
		color: #f59e0b !important;
	}

	.account-form {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding-bottom: 1.8rem;
		margin-bottom: 1.8rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.account-form h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1.05rem;
		font-weight: 700;
	}

	.form-message {
		padding: 0.75rem;
		border-radius: var(--radius-md);
		font-size: 0.86rem;
		line-height: 1.4;
	}

	.form-message.success {
		background: rgba(16, 185, 129, 0.12);
		border: 1px solid rgba(16, 185, 129, 0.35);
		color: #065f46;
	}

	.form-message.error {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.35);
		color: #991b1b;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.form-group label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.form-group input {
		padding: 0.75rem 1rem;
		background: var(--bg-base);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-size: 0.95rem;
		transition: border-color var(--transition-fast);
	}

	.form-group input:focus {
		outline: none;
		border-color: var(--accent-primary);
	}

	.form-note {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.88rem;
		line-height: 1.45;
	}

	.secondary-btn {
		width: 100%;
		padding: 0.9rem 1rem;
		background: var(--accent-primary);
		color: var(--bg-base);
		border: none;
		border-radius: var(--radius-md);
		font-weight: 700;
		cursor: pointer;
		transition: opacity var(--transition-fast);
	}

	.secondary-btn:hover {
		opacity: 0.9;
	}

	.logout-btn {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 1rem;
		background: transparent;
		color: #ef4444;
		border: 1px solid #ef4444;
		border-radius: var(--radius-md);
		font-weight: 600;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.logout-btn:hover {
		background: #ef4444;
		color: white;
	}

	@keyframes fadeInUp {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (max-width: 640px) {
		.account-container {
			align-items: stretch;
			padding: calc(0.75rem + env(safe-area-inset-top)) calc(0.75rem + env(safe-area-inset-right))
				calc(0.75rem + env(safe-area-inset-bottom)) calc(0.75rem + env(safe-area-inset-left));
		}

		.account-card {
			max-width: none;
			max-height: calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
			padding: 1.35rem;
			border-radius: var(--radius-xl);
		}

		.account-header {
			margin-bottom: 1.65rem;
		}

		.back-link {
			margin-bottom: 1rem;
			font-size: 0.86rem;
		}

		.account-header h1 {
			font-size: clamp(1.55rem, 9vw, 2.35rem);
			line-height: 1.05;
		}

		.profile-section {
			gap: 0.9rem;
			padding-bottom: 1.45rem;
			margin-bottom: 1.45rem;
		}

		.profile-avatar {
			width: 56px;
			height: 56px;
			min-width: 56px;
			flex-basis: 56px;
			font-size: 1.28rem;
		}

		.profile-info h2 {
			font-size: 1.15rem;
			line-height: 1.18;
		}

		.profile-info p {
			font-size: 0.9rem;
			line-height: 1.35;
		}

		.account-details {
			gap: 0;
			margin-bottom: 2rem;
		}

		.usage-grid {
			grid-template-columns: 1fr;
			gap: 0;
		}

		.detail-item {
			grid-template-columns: 1fr;
			gap: 0.28rem;
			padding: 0.78rem 0;
		}

		.detail-item .label,
		.detail-item .value {
			font-size: 0.88rem;
			line-height: 1.35;
		}

		.detail-item .value {
			text-align: left;
		}

		.account-form {
			gap: 0.78rem;
			padding-bottom: 1.45rem;
			margin-bottom: 1.45rem;
		}

		.account-form h2 {
			font-size: 1rem;
		}

		.form-group input,
		.secondary-btn,
		.logout-btn {
			min-height: 48px;
		}
	}

	@media (max-width: 380px) {
		.account-card {
			padding: 1.1rem;
		}

		.profile-section {
			align-items: flex-start;
		}

		.profile-avatar {
			width: 48px;
			height: 48px;
			min-width: 48px;
			flex-basis: 48px;
			font-size: 1.08rem;
		}
	}
</style>
