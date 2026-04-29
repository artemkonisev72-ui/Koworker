<script lang="ts">
	import { resolve } from '$app/paths';

	let { data, form } = $props();

	const tokenStatus = $derived(form?.tokenStatus ?? data.tokenStatus);
	const token = $derived(form?.token ?? data.token);
</script>

<div class="auth-container">
	<div class="auth-card">
		<header class="auth-header">
			<img src="/pwa-192x192.png" alt="Логотип Koworker" class="auth-logo" />
			<h1>Смена пароля</h1>
			<p>Введите новый пароль для аккаунта.</p>
		</header>

		{#if tokenStatus === 'expired'}
			<div class="auth-error">Срок действия ссылки истёк. Запросите новую.</div>
		{:else if tokenStatus === 'invalid'}
			<div class="auth-error">Некорректная ссылка для смены пароля. Запросите новую.</div>
		{:else}
			<form method="POST" class="auth-form">
				{#if form?.message}
					<div class={form?.success ? 'auth-success' : 'auth-error'}>{form.message}</div>
				{/if}

				<input type="hidden" name="token" value={token} />

				<div class="form-group">
					<label for="password">Новый пароль</label>
					<input
						type="password"
						id="password"
						name="password"
						placeholder="••••••••"
						minlength="6"
						maxlength="128"
						required
					/>
				</div>

				<div class="form-group">
					<label for="passwordConfirm">Повторите пароль</label>
					<input
						type="password"
						id="passwordConfirm"
						name="passwordConfirm"
						placeholder="••••••••"
						minlength="6"
						maxlength="128"
						required
					/>
				</div>

				<button type="submit" class="auth-submit">Сохранить пароль</button>
			</form>
		{/if}

		<footer class="auth-footer">
			<a href={resolve('/forgot-password')}>Запросить новую ссылку</a>
			<span aria-hidden="true"> · </span>
			<a href={resolve('/login')}>Войти</a>
		</footer>
	</div>
</div>

<style>
	.auth-container {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		background: var(--bg-base);
		padding:
			calc(1rem + env(safe-area-inset-top))
			calc(1rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom))
			calc(1rem + env(safe-area-inset-left));
	}
	.auth-card {
		width: 100%;
		max-width: 420px;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}
	.auth-header {
		text-align: center;
		margin-bottom: 1.6rem;
	}
	.auth-logo {
		width: 48px;
		height: 48px;
		object-fit: contain;
		margin: 0 auto 0.5rem;
		display: block;
	}
	.auth-header h1 {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}
	.auth-header p {
		color: var(--text-secondary);
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
	}
	.auth-error,
	.auth-success {
		padding: 0.75rem;
		border-radius: var(--radius-md);
		font-size: 0.86rem;
		text-align: center;
		line-height: 1.4;
	}
	.auth-error {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.35);
		color: #991b1b;
	}
	.auth-success {
		background: rgba(16, 185, 129, 0.12);
		border: 1px solid rgba(16, 185, 129, 0.35);
		color: #065f46;
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
	.auth-submit {
		padding: 0.85rem;
		background: var(--accent-primary);
		color: var(--bg-base);
		border: none;
		border-radius: var(--radius-md);
		font-weight: 700;
		cursor: pointer;
		transition: opacity var(--transition-fast);
	}
	.auth-submit:hover {
		opacity: 0.9;
	}
	.auth-footer {
		margin-top: 1.6rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
	.auth-footer a {
		color: var(--text-primary);
		font-weight: 600;
		text-decoration: none;
	}
	.auth-footer a:hover {
		text-decoration: underline;
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
</style>
