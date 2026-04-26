<script lang="ts">
	import { resolve } from '$app/paths';

	let { form } = $props();
</script>

<div class="auth-container">
	<div class="auth-card">
		<header class="auth-header">
			<img src="/pwa-192x192.png" alt="Логотип Koworker" class="auth-logo" />
			<h1>Регистрация</h1>
			<p>Создайте аккаунт, чтобы сохранять свои чаты и настройки.</p>
		</header>

		<form method="POST" class="auth-form">
			{#if form?.message}
				<div class="auth-error">{form.message}</div>
			{/if}

			<div class="form-group">
				<label for="name">Имя (необязательно)</label>
				<input type="text" id="name" name="name" placeholder="Иван Иванов" />
			</div>

			<div class="form-group">
				<label for="email">Электронная почта</label>
				<input type="email" id="email" name="email" value={form?.email ?? ''} placeholder="name@example.com" required />
			</div>

			<div class="form-group">
				<label for="password">Пароль</label>
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

			<button type="submit" class="auth-submit">Создать аккаунт</button>
		</form>

		<footer class="auth-footer">
			Уже есть аккаунт? <a href={resolve('/login')}>Войти</a>
		</footer>
	</div>
</div>

<style>
	/* Same styles as login for consistency */
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
		max-width: 400px;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}
	.auth-header {
		text-align: center;
		margin-bottom: 2rem;
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
		font-size: 0.88rem;
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.auth-error {
		padding: 0.75rem;
		background: rgba(0, 0, 0, 0.05);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-size: 0.85rem;
		text-align: center;
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
		margin-top: 0.5rem;
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
		margin-top: 2rem;
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
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
