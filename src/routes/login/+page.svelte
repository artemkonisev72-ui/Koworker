<script lang="ts">
	let { form } = $props();
</script>

<div class="auth-container">
	<div class="auth-card">
		<header class="auth-header">
			<img src="/favicon.svg" alt="Auth Logo" class="auth-logo" />
			<h1>Koworker</h1>
		</header>

		<form method="POST" class="auth-form">
			{#if form?.message}
				<div class="auth-error">{form.message}</div>
			{/if}

			<div class="form-group">
				<label for="email">Email</label>
				<input
					type="email"
					id="email"
					name="email"
					value={form?.email ?? ''}
					placeholder="name@example.com"
					required
				/>
			</div>

			<div class="form-group">
				<label for="password">Пароль</label>
				<input type="password" id="password" name="password" placeholder="••••••••" required />
			</div>

			<button type="submit" class="auth-submit">Войти</button>
		</form>

		<footer class="auth-footer">
			Нет аккаунта? <a href="/register">Зарегистрироваться</a>
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
		padding: calc(1rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left));
	}
	.auth-card {
		width: 100%;
		max-width: 400px;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.7rem 2.5rem 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}
	.auth-header {
		text-align: center;
		margin-bottom: 2.15rem;
	}
	.auth-logo {
		width: 52px;
		height: 52px;
		object-fit: contain;
		margin: 0 auto 0.7rem;
		display: block;
	}
	.auth-header h1 {
		font-family: var(--font-serif);
		font-size: 2.15rem;
		font-weight: 600;
		letter-spacing: 0;
		color: var(--text-primary);
		margin: 0;
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
