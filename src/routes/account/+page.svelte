<script lang="ts">
	import { resolve } from '$app/paths';

	let { data, form } = $props();

	async function logout() {
		const res = await fetch('/api/auth/logout', { method: 'POST' });
		if (res.ok) {
			window.location.href = '/login';
		}
	}
</script>

<div class="account-container">
	<div class="account-card">
		<header class="account-header">
			<a href={resolve('/')} class="back-link">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M19 12H5M12 19l-7-7 7-7"/>
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

		<form method="POST" action="?/updateName" class="account-form">
			<h2>Никнейм</h2>
			{#if form?.action === 'updateName' && form?.message}
				<div class={form?.success ? 'form-message success' : 'form-message error'}>{form.message}</div>
			{/if}
			<div class="form-group">
				<label for="name">Никнейм</label>
				<input
					type="text"
					id="name"
					name="name"
					value={form?.action === 'updateName' ? (form?.name ?? data.user?.name ?? '') : (data.user?.name ?? '')}
					maxlength="80"
					required
				/>
			</div>
			<button class="secondary-btn" type="submit">Сохранить никнейм</button>
		</form>

		<form method="POST" action="?/requestPasswordReset" class="account-form">
			<h2>Пароль</h2>
			{#if form?.action === 'requestPasswordReset' && form?.message}
				<div class={form?.success ? 'form-message success' : 'form-message error'}>{form.message}</div>
			{/if}
			<p class="form-note">Ссылка для смены пароля придёт на вашу электронную почту.</p>
			<p class="form-note">Письмо может прийти в папку "Спам".</p>
			<button class="secondary-btn" type="submit">Сменить пароль</button>
		</form>

		<button class="logout-btn" onclick={logout}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
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
		padding:
			calc(1.5rem + env(safe-area-inset-top))
			calc(1.5rem + env(safe-area-inset-right))
			calc(1.5rem + env(safe-area-inset-bottom))
			calc(1.5rem + env(safe-area-inset-left));
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

	.profile-info h2 {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 0.25rem;
	}

	.profile-info p {
		color: var(--text-secondary);
		font-size: 0.95rem;
	}

	.account-details {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: 2.5rem;
	}

	.detail-item {
		display: flex;
		justify-content: space-between;
		padding: 0.75rem 0;
		border-bottom: 1px dashed var(--border-subtle);
	}

	.detail-item .label {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.detail-item .value {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
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
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
