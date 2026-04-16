<script lang="ts">
	/**
	 * +page.svelte - Main chat interface
	 * SSE client + sidebar + message list + input
	 */
	import { onMount, tick } from 'svelte';
	import MessageRenderer from '$lib/components/MessageRenderer.svelte';

	interface GraphPoint {
		x: number;
		y: number;
	}
	interface GraphData {
		title?: string;
		type?: 'function' | 'diagram';
		memberId?: string;
		diagramType?: string;
		points: GraphPoint[];
	}
	interface ActiveDraftState {
		draftId: string;
		status: string;
		revisionIndex: number;
		schema: unknown;
		assumptions: string[];
		ambiguities: string[];
	}
	interface ChatMessage {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphData[] | string | null;
		schemaData?: unknown;
		schemaVersion?: string | null;
		imageData?: string | null;
		usedModels?: string[] | string | null;
		draftId?: string | null;
		createdAt?: string;
		isStreaming?: boolean;
	}
	interface Chat {
		id: string;
		title: string;
		updatedAt: string;
		isPinned: boolean;
		modelPreference: string;
		isPublic: boolean;
	}
	type ThemeMode = 'light' | 'dark';

	let { data }: { data: import('./$types').PageData } = $props();

	let chats = $state<Chat[]>([]);
	let activeChatId = $state<string | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let inputValue = $state('');
	let isLoading = $state(false);
	let statusMessage = $state('');
	let sidebarOpen = $state(true);
	let isMobileView = $state(false);
	let mobileToolsOpen = $state(false);
	let inputSettingsOpen = $state(false);
	let hasViewportInit = false;
	let messagesEnd: HTMLDivElement | undefined = $state();
	let inputEl: HTMLTextAreaElement | undefined = $state();
	let fileInputEl: HTMLInputElement | undefined = $state();
	let inputSettingsMenuEl: HTMLDivElement | undefined = $state();

	let editingChatId = $state<string | null>(null);
	let editingTitle = $state('');

	let isSharing = $state(false);
	let copySuccess = $state(false);

	let pinnedChats = $derived(chats.filter((c) => c.isPinned));
	let otherChats = $derived(chats.filter((c) => !c.isPinned));
	let activeChat = $derived(chats.find((c) => c.id === activeChatId));

	let selectedImage = $state<{ base64: string; mimeType: string } | null>(null);
	let schemaCheckEnabled = $state(false);
	let schemeDebugEnabled = $state(false);
	let activeDraft = $state<ActiveDraftState | null>(null);
	let revisionNotes = $state('');
	let showRevisionBox = $state(false);
	let isSchemaActionLoading = $state(false);
	let themeMode = $state<ThemeMode>('light');
	let welcomeGreeting = $state('Над чем работаем сегодня?');

	const THEME_STORAGE_KEY = 'coworker-theme';

	function resolveDisplayName(): string | null {
		const rawName = data.user?.name?.trim();
		if (rawName) {
			return rawName.split(/\s+/)[0];
		}
		const rawEmail = data.user?.email?.trim();
		if (!rawEmail) return null;
		const localPart = rawEmail.split('@')[0]?.trim();
		return localPart || null;
	}

	function pickWelcomeGreeting() {
		const name = resolveDisplayName();
		const withName = name
			? [`С возвращением, ${name}`, `Что разберем сегодня, ${name}?`, `Готовы продолжить, ${name}?`]
			: [];
		const generic = ['Над чем работаем сегодня?', 'Какую задачу решаем сегодня?'];
		const variants = [...withName, ...generic];
		const randomIndex = Math.floor(Math.random() * variants.length);
		welcomeGreeting = variants[randomIndex];
	}

	function setTheme(theme: ThemeMode, persist = true) {
		themeMode = theme;
		if (typeof document !== 'undefined') {
			document.documentElement.dataset.theme = theme;
			document.documentElement.style.colorScheme = theme;
			const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
			if (themeMeta) {
				themeMeta.setAttribute('content', theme === 'dark' ? '#1c1a19' : '#f9f8f6');
			}
		}
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent('coworker-theme-change', { detail: { theme } }));
		}
		if (persist && typeof localStorage !== 'undefined') {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		}
	}

	function toggleTheme() {
		setTheme(themeMode === 'dark' ? 'light' : 'dark');
	}

	onMount(() => {
		pickWelcomeGreeting();
		const viewportQuery = window.matchMedia('(max-width: 900px)');
		const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
		const currentDomTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
		const initialTheme: ThemeMode =
			savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : currentDomTheme;
		setTheme(initialTheme, false);

		const applyViewportMode = () => {
			const mobileNow = viewportQuery.matches;
			if (!hasViewportInit) {
				isMobileView = mobileNow;
				sidebarOpen = !mobileNow;
				hasViewportInit = true;
				return;
			}
			if (mobileNow === isMobileView) return;
			isMobileView = mobileNow;
			if (mobileNow) {
				sidebarOpen = false;
				isSharing = false;
				inputSettingsOpen = false;
			} else {
				sidebarOpen = true;
				mobileToolsOpen = false;
			}
		};

		const onViewportChange = () => applyViewportMode();
		const onDocumentPointerDown = (event: PointerEvent) => {
			if (!inputSettingsOpen) return;
			const target = event.target as Node | null;
			if (target && inputSettingsMenuEl?.contains(target)) return;
			inputSettingsOpen = false;
		};
		const onWindowKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				inputSettingsOpen = false;
			}
		};

		applyViewportMode();

		if (typeof viewportQuery.addEventListener === 'function') {
			viewportQuery.addEventListener('change', onViewportChange);
		} else {
			viewportQuery.addListener(onViewportChange);
		}
		window.addEventListener('orientationchange', onViewportChange);
		window.addEventListener('resize', onViewportChange);
		document.addEventListener('pointerdown', onDocumentPointerDown);
		window.addEventListener('keydown', onWindowKeyDown);

		void (async () => {
			await loadChats();
			if (chats.length > 0) {
				await selectChat(chats[0].id);
			}
		})();

		return () => {
			if (typeof viewportQuery.removeEventListener === 'function') {
				viewportQuery.removeEventListener('change', onViewportChange);
			} else {
				viewportQuery.removeListener(onViewportChange);
			}
			window.removeEventListener('orientationchange', onViewportChange);
			window.removeEventListener('resize', onViewportChange);
			document.removeEventListener('pointerdown', onDocumentPointerDown);
			window.removeEventListener('keydown', onWindowKeyDown);
		};
	});

	async function loadChats() {
		try {
			const res = await fetch('/api/chats');
			if (res.ok) chats = await res.json();
		} catch (e) {
			console.error('Failed to load chats', e);
		}
	}

	async function createPersistedChat() {
		try {
			const res = await fetch('/api/chats', { method: 'POST' });
			if (res.ok) {
				const chat = await res.json();
				chats = [chat, ...chats];
				await selectChat(chat.id);
			}
		} catch (e) {
			console.error('Failed to create chat', e);
		}
	}

	async function startNewChat() {
		activeChatId = null;
		messages = [];
		activeDraft = null;
		showRevisionBox = false;
		revisionNotes = '';
		statusMessage = '';
		isSharing = false;
		copySuccess = false;
		editingChatId = null;
		editingTitle = '';
		inputSettingsOpen = false;
		mobileToolsOpen = false;
		pickWelcomeGreeting();

		if (isMobileView) {
			sidebarOpen = false;
		}

		await tick();
		inputEl?.focus();
	}

	async function deleteChat(id: string) {
		if (!confirm('Удалить этот чат?')) return;
		try {
			const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' });
			if (res.ok) {
				chats = chats.filter((c) => c.id !== id);
				if (activeChatId === id) {
					activeChatId = null;
					messages = [];
					activeDraft = null;
					pickWelcomeGreeting();
				}
			}
		} catch (e) {
			console.error('Failed to delete chat', e);
		}
	}

	async function pinChat(chat: Chat) {
		try {
			const res = await fetch(`/api/chats/${chat.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ isPinned: !chat.isPinned })
			});
			if (res.ok) {
				const updated = await res.json();
				chats = chats.map((c) => (c.id === chat.id ? updated : c));
			}
		} catch (e) {
			console.error('Failed to pin chat', e);
		}
	}

	function startEditing(chat: Chat) {
		editingChatId = chat.id;
		editingTitle = chat.title;
	}

	async function saveTitle() {
		if (!editingChatId || !editingTitle.trim()) {
			editingChatId = null;
			return;
		}
		try {
			const res = await fetch(`/api/chats/${editingChatId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: editingTitle })
			});
			if (res.ok) {
				const updated = await res.json();
				chats = chats.map((c) => (c.id === editingChatId ? updated : c));
			}
		} catch (e) {
			console.error('Failed to rename chat', e);
		} finally {
			editingChatId = null;
		}
	}

	async function togglePublic() {
		if (!activeChatId || !activeChat) return;
		const newStatus = !activeChat.isPublic;
		try {
			const res = await fetch(`/api/chats/${activeChatId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ isPublic: newStatus })
			});
			if (res.ok) {
				const updated = await res.json();
				chats = chats.map((c) => (c.id === activeChatId ? updated : c));
			}
		} catch (e) {
			console.error('Failed to toggle public status', e);
		}
	}

	function copyShareLink() {
		const url = `${window.location.origin}/shared/${activeChatId}`;
		navigator.clipboard.writeText(url).then(() => {
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2000);
		});
	}

	async function updateModelPreference(preference: string) {
		if (!activeChatId) return;
		try {
			const res = await fetch(`/api/chats/${activeChatId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ modelPreference: preference })
			});
			if (res.ok) {
				const updated = await res.json();
				chats = chats.map((c) => (c.id === activeChatId ? updated : c));
			}
		} catch (e) {
			console.error('Failed to update model preference', e);
		}
	}

	async function selectChat(chatId: string) {
		if (activeChatId === chatId) return;
		activeChatId = chatId;
		messages = [];
		activeDraft = null;
		showRevisionBox = false;
		revisionNotes = '';
		inputSettingsOpen = false;
		await loadMessages(chatId);
		if (messages.length === 0) {
			pickWelcomeGreeting();
		}
		if (isMobileView) {
			sidebarOpen = false;
			isSharing = false;
		}
	}

	function parseMaybeJson(value: unknown): unknown {
		if (typeof value !== 'string') return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}

	async function hydrateDraftStateFromMessage(messageDraftId: string | null | undefined) {
		if (!messageDraftId) {
			activeDraft = null;
			return;
		}
		try {
			const res = await fetch(`/api/schema/${messageDraftId}`);
			if (!res.ok) {
				activeDraft = null;
				return;
			}
			const payload = await res.json();
			if (payload.status !== 'AWAITING_REVIEW' || !payload.currentSchema) {
				activeDraft = null;
				showRevisionBox = false;
				return;
			}
			activeDraft = {
				draftId: payload.draftId,
				status: payload.status,
				revisionIndex: payload.revisionCount,
				schema: payload.currentSchema,
				assumptions: Array.isArray(payload.latestRevision?.assumptions)
					? payload.latestRevision.assumptions.filter((item: unknown) => typeof item === 'string')
					: [],
				ambiguities: []
			};
		} catch {
			activeDraft = null;
		}
	}

	async function loadMessages(chatId: string) {
		try {
			const res = await fetch(`/api/chat?chatId=${chatId}`);
			if (res.ok) {
				const data = await res.json();
				messages = data.map((m: any) => ({
					...m,
					graphData: typeof m.graphData === 'string' ? JSON.parse(m.graphData) : m.graphData,
					schemaData: parseMaybeJson(m.schemaData),
					schemaVersion: typeof m.schemaVersion === 'string' ? m.schemaVersion : null,
					usedModels: typeof m.usedModels === 'string' ? JSON.parse(m.usedModels) : m.usedModels,
					draftId: m.draftId ?? null
				}));
				const latestDraftMessage = [...messages]
					.reverse()
					.find((m) => m.draftId && m.role === 'ASSISTANT');
				await hydrateDraftStateFromMessage(latestDraftMessage?.draftId);
				await scrollToBottom();
			}
		} catch (e) {
			console.error('Failed to load messages', e);
		}
	}

	async function scrollToBottom() {
		await tick();
		messagesEnd?.scrollIntoView({ behavior: 'smooth' });
	}

	function handleFileChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (event) => {
			const base64 = (event.target?.result as string).split(',')[1];
			selectedImage = { base64, mimeType: file.type };
		};
		reader.readAsDataURL(file);
	}

	function removeImage() {
		selectedImage = null;
		if (fileInputEl) fileInputEl.value = '';
	}

	function focus(node: HTMLInputElement) {
		node.focus();
	}

	async function logout() {
		const res = await fetch('/api/auth/logout', { method: 'POST' });
		if (res.ok) {
			window.location.href = '/login';
		}
	}

	function generateSafeId() {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
		return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}

	async function deleteMessage(msgId: string) {
		if (!confirm('Удалить это сообщение?')) return;
		try {
			const res = await fetch(`/api/messages/${msgId}`, { method: 'DELETE' });
			if (res.ok) {
				messages = messages.filter((m) => m.id !== msgId);
			}
		} catch (e) {
			console.error('Failed to delete message', e);
		}
	}

	let abortController: AbortController | null = null;

	function cancelGeneration() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
	}

	async function parseErrorMessage(res: Response): Promise<string> {
		try {
			const text = await res.text();
			if (text && /<html[\s>]/i.test(text)) {
				return `HTTP ${res.status}: upstream timeout or proxy error`;
			}
			return text || `HTTP ${res.status}`;
		} catch {
			return `HTTP ${res.status}`;
		}
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	async function waitForSchemaSolveResult(draftId: string, chatId: string): Promise<void> {
		const startedAt = Date.now();
		const timeoutMs = 8 * 60_000;

		while (Date.now() - startedAt < timeoutMs) {
			const res = await fetch(`/api/schema/${draftId}`);
			if (res.ok) {
				const payload = await res.json();
				const status = typeof payload.status === 'string' ? payload.status : '';

				if (status === 'SOLVED') {
					await loadMessages(chatId);
					await loadChats();
					return;
				}
				if (status === 'FAILED' || status === 'CANCELED') {
					await loadMessages(chatId);
					await loadChats();
					throw new Error(`Solve finished with status: ${status}`);
				}
			}

			await sleep(1500);
		}

		throw new Error('Solve is taking too long. Please wait a bit and refresh chat messages.');
	}

	async function startSchemaCheckFlow(
		text: string,
		imageData: { base64: string; mimeType: string } | null
	) {
		if (!activeChatId) return;
		statusMessage = 'Building initial scheme...';
		isSchemaActionLoading = true;
		try {
			const res = await fetch('/api/schema/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chatId: activeChatId,
					message: text,
					imageData,
					mode: 'schema_check'
				})
			});
			if (!res.ok) {
				throw new Error(await parseErrorMessage(res));
			}
			const payload = await res.json();
			activeDraft = {
				draftId: payload.draftId,
				status: payload.status,
				revisionIndex: payload.revisionIndex,
				schema: payload.schema,
				assumptions: payload.assumptions ?? [],
				ambiguities: payload.ambiguities ?? []
			};
			showRevisionBox = false;
			revisionNotes = '';
			await loadMessages(activeChatId);
			await loadChats();
		} finally {
			isSchemaActionLoading = false;
			statusMessage = '';
		}
	}

	async function submitSchemaRevision() {
		if (!activeDraft || !activeChatId) return;
		const notes = revisionNotes.trim();
		if (!notes || isSchemaActionLoading || isLoading) return;
		statusMessage = 'Applying scheme revisions...';
		isSchemaActionLoading = true;
		try {
			const res = await fetch(`/api/schema/${activeDraft.draftId}/revise`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ notes })
			});
			if (!res.ok) {
				throw new Error(await parseErrorMessage(res));
			}
			const payload = await res.json();
			activeDraft = {
				draftId: payload.draftId,
				status: payload.status,
				revisionIndex: payload.revisionIndex,
				schema: payload.schema,
				assumptions: payload.assumptions ?? [],
				ambiguities: payload.ambiguities ?? []
			};
			revisionNotes = '';
			showRevisionBox = false;
			await loadMessages(activeChatId);
		} catch (err) {
			console.error('Schema revision failed:', err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			isSchemaActionLoading = false;
			statusMessage = '';
		}
	}

	async function confirmDraftAndSolve() {
		if (!activeDraft || !activeChatId || isSchemaActionLoading || isLoading) return;
		statusMessage = 'Solving using approved scheme...';
		isSchemaActionLoading = true;
		const draftId = activeDraft.draftId;
		const chatId = activeChatId;
		try {
			const res = await fetch(`/api/schema/${draftId}/confirm`, { method: 'POST' });
			if (!res.ok) {
				throw new Error(await parseErrorMessage(res));
			}
			const payload = await res.json();
			if (payload.status === 'SOLVED') {
				activeDraft = null;
				showRevisionBox = false;
				revisionNotes = '';
				await loadMessages(chatId);
				await loadChats();
				return;
			}
			activeDraft = null;
			showRevisionBox = false;
			revisionNotes = '';
			statusMessage = 'Solve started. Waiting for result...';
			await waitForSchemaSolveResult(draftId, chatId);
		} catch (err) {
			console.error('Schema confirm failed:', err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			isSchemaActionLoading = false;
			statusMessage = '';
		}
	}

	async function sendMessage() {
		const text = inputValue.trim();
		if (!text || isLoading || isSchemaActionLoading) return;

		if (activeDraft && activeDraft.status === 'AWAITING_REVIEW') {
			statusMessage = 'Confirm or revise the current scheme before sending a new task.';
			return;
		}

		if (!activeChatId) await createPersistedChat();
		if (!activeChatId) return;

		const imageData = selectedImage;
		selectedImage = null;
		if (fileInputEl) fileInputEl.value = '';
		inputValue = '';
		if (isMobileView) mobileToolsOpen = false;

		if (schemaCheckEnabled) {
			try {
				await startSchemaCheckFlow(text, imageData);
			} catch (err) {
				console.error('Schema check start failed:', err);
				alert(err instanceof Error ? err.message : String(err));
				statusMessage = '';
			}
			return;
		}

		isLoading = true;
		statusMessage = '';

		const userMsg: ChatMessage = {
			id: generateSafeId(),
			role: 'USER',
			content: text,
			imageData: imageData ? JSON.stringify(imageData) : null,
			createdAt: new Date().toISOString()
		};
		messages = [...messages, userMsg];

		const assistantId = generateSafeId();
		const assistantPlaceholder: ChatMessage = {
			id: assistantId,
			role: 'ASSISTANT',
			content: '',
			isStreaming: true
		};
		messages = [...messages, assistantPlaceholder];
		await scrollToBottom();

		try {
			abortController = new AbortController();
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chatId: activeChatId,
					message: text,
					imageData
				}),
				signal: abortController.signal
			});

			if (!res.ok || !res.body) {
				throw new Error(`HTTP ${res.status}: network error or blocked request`);
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6).trim();
					if (payload === '[DONE]') break;

					try {
						const event = JSON.parse(payload) as {
							type: string;
							message?: string;
							content?: string;
							graphData?: GraphData[];
							schemaData?: unknown;
							schemaVersion?: string;
							usedModels?: string[];
						};

						if (event.type === 'status') {
							statusMessage = event.message ?? '';
						} else if (event.type === 'result') {
							messages = messages.map((m) =>
								m.id === assistantId
									? {
											...m,
											content: event.content ?? '',
											graphData: event.graphData ?? null,
											schemaData: event.schemaData ?? null,
											schemaVersion: event.schemaVersion ?? null,
											usedModels: event.usedModels ?? null,
											isStreaming: false
										}
									: m
							);
							statusMessage = '';
							await loadChats();
							await scrollToBottom();
						} else if (event.type === 'error') {
							messages = messages.map((m) =>
								m.id === assistantId
									? { ...m, content: `Error: ${event.message}`, isStreaming: false }
									: m
							);
							statusMessage = '';
							await scrollToBottom();
						}
					} catch {
						// ignore malformed SSE line
					}
				}
			}
		} catch (chatError) {
			if (chatError instanceof Error && chatError.name === 'AbortError') {
				console.log('Request aborted by user');
				messages = messages.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m));
			} else {
				console.error('Chat error:', chatError);
				messages = messages.map((m) =>
					m.id === assistantId
						? {
								...m,
								content: `Network error: ${chatError instanceof Error ? chatError.message : String(chatError)}`,
								isStreaming: false
							}
						: m
				);
			}
		} finally {
			isLoading = false;
			statusMessage = '';
			abortController = null;
			await scrollToBottom();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function autoResize() {
		if (!inputEl || typeof window === 'undefined') return;
		const computed = window.getComputedStyle(inputEl);
		const lineHeight = Number.parseFloat(computed.lineHeight) || 21;
		const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
		const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
		const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
		const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
		const maxRows = 5;
		const chromeHeight =
			paddingTop +
			paddingBottom +
			(computed.boxSizing === 'border-box' ? borderTop + borderBottom : 0);
		const maxHeight = Math.round(lineHeight * maxRows + chromeHeight);

		inputEl.style.height = 'auto';
		const nextHeight = Math.min(inputEl.scrollHeight, maxHeight);
		inputEl.style.height = `${nextHeight}px`;
		inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
	}

	$effect(() => {
		inputValue;
		autoResize();
	});

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (!file) continue;
				const reader = new FileReader();
				reader.onload = (event) => {
					const base64 = (event.target?.result as string).split(',')[1];
					selectedImage = { base64, mimeType: file.type };
				};
				reader.readAsDataURL(file);
				e.preventDefault();
				break;
			}
		}
	}

	function toggleMobileTools() {
		mobileToolsOpen = !mobileToolsOpen;
		if (mobileToolsOpen) {
			inputSettingsOpen = false;
		}
	}
</script>

<div class="app-shell">
	<button
		class="sidebar-backdrop"
		class:visible={isMobileView && sidebarOpen}
		onclick={() => {
			sidebarOpen = false;
			isSharing = false;
		}}
		aria-label="Закрыть меню"
		title="Закрыть меню"
	></button>

	<!-- в”Ђв”Ђ Sidebar в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ -->
	<aside
		class="sidebar"
		class:collapsed={!sidebarOpen}
		class:mobile-drawer={isMobileView}
		class:open={sidebarOpen}
	>
		<div class="sidebar-header">
			<div class="logo">
				<img src="/pwa-192x192.png" alt="Koworker Logo" class="logo-icon" />
				<span class="logo-text">Koworker</span>
			</div>
			<button class="icon-btn" onclick={() => (sidebarOpen = !sidebarOpen)} title="Свернуть">
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M21 3H3M21 12H3M21 21H3" />
				</svg>
			</button>
		</div>

		<button class="new-chat-btn" onclick={startNewChat}>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
			>
				<path d="M12 5v14M5 12h14" />
			</svg>
			Новый чат
		</button>

		<div class="sidebar-content">
			{#if pinnedChats.length > 0}
				<div class="chat-section-label">Закрепленные</div>
				<div class="chat-list pinned">
					{#each pinnedChats as chat (chat.id)}
						{@render chatItem(chat)}
					{/each}
				</div>
			{/if}

			<div class="chat-section-label">{pinnedChats.length > 0 ? 'Все чаты' : 'Чаты'}</div>
			<div class="chat-list">
				{#if chats.length === 0}
					<div class="chat-list-empty">Нет чатов. Создайте первый!</div>
				{/if}
				{#each otherChats as chat (chat.id)}
					{@render chatItem(chat)}
				{/each}
			</div>
		</div>

		{#snippet chatItem(chat: Chat)}
			<div class="chat-item-wrapper" class:active={chat.id === activeChatId}>
				<button class="chat-item" onclick={() => selectChat(chat.id)}>
					<svg
						class="chat-icon"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
					{#if editingChatId === chat.id}
						<input
							type="text"
							class="edit-title-input"
							bind:value={editingTitle}
							onkeydown={(e) => e.key === 'Enter' && saveTitle()}
							onblur={saveTitle}
							use:focus
						/>
					{:else}
						<span class="chat-title">{chat.title}</span>
					{/if}
				</button>

				<div class="chat-actions">
					<button
						class="action-btn"
						onclick={() => pinChat(chat)}
						title={chat.isPinned ? 'Открепить' : 'Закрепить'}
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill={chat.isPinned ? 'currentColor' : 'none'}
							stroke="currentColor"
							stroke-width="2"
						>
							<path
								d="M21 10V8l-2.09-.41A3 3 0 0 1 17 4.68V3h-1v1.68a3 3 0 0 1-1.91 2.91L12 8v2l2.09.41A3 3 0 0 1 16 13.32V15h1v-1.68a3 3 0 0 1 1.91-2.91L21 10zM12 15h10M16.5 15v6"
							/>
						</svg>
					</button>
					<button class="action-btn" onclick={() => startEditing(chat)} title="Переименовать">
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
						</svg>
					</button>
					<button class="action-btn delete" onclick={() => deleteChat(chat.id)} title="Удалить">
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path
								d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
							/>
						</svg>
					</button>
				</div>
			</div>
		{/snippet}

		<div class="sidebar-footer">
			{#if data.user}
				<div class="user-info">
					<a href="/account" class="user-details-link">
						<div class="user-details">
							<span class="user-name">{data.user.name || 'Пользователь'}</span>
							<span class="user-email">{data.user.email}</span>
						</div>
					</a>
					<button class="logout-btn" onclick={logout} title="Выйти">
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
						</svg>
					</button>
				</div>
			{/if}
		</div>
	</aside>

	<!-- в”Ђв”Ђ Main в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ -->
	<main class="chat-main">
		<!-- Header -->
		<header class="chat-header">
			{#if isMobileView || !sidebarOpen}
				<button class="icon-btn" onclick={() => (sidebarOpen = true)} title="Открыть меню">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<path d="M21 3H3M21 12H3M21 21H3" />
					</svg>
				</button>
			{/if}
			<div class="header-title">
				<h1>{activeChat?.title || 'Новый диалог'}</h1>
			</div>
			<div class="header-status" class:active={isLoading || isSchemaActionLoading}>
				{#if isLoading || isSchemaActionLoading}
					<span class="typing-indicator">
						<span></span><span></span><span></span>
					</span>
				{/if}
			</div>
			<div class="model-selector">
				<button
					class="icon-btn theme-toggle-btn"
					onclick={toggleTheme}
					title={themeMode === 'dark' ? 'Включить светлую тему' : 'Включить темную тему'}
					aria-label={themeMode === 'dark' ? 'Включить светлую тему' : 'Включить темную тему'}
				>
					{#if themeMode === 'dark'}
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<circle cx="12" cy="12" r="4"></circle>
							<path
								d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
							></path>
						</svg>
					{:else}
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<path d="M12 3a7 7 0 1 0 9 9 9 9 0 1 1-9-9z"></path>
						</svg>
					{/if}
				</button>

				{#if activeChatId}
					<div class="share-container">
						<button
							class="icon-btn share-btn"
							onclick={() => (isSharing = !isSharing)}
							title="Поделиться чатом"
							aria-label="Поделиться чатом"
							class:active={isSharing}
						>
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							>
								<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />
							</svg>
						</button>

						{#if isSharing}
							<div class="share-menu">
								<div class="share-menu-header">
									<span>Публичный доступ</span>
									<button
										class="toggle-switch"
										class:on={activeChat?.isPublic}
										onclick={togglePublic}
										aria-label="Переключить публичный доступ"
										title="Переключить публичный доступ"
									></button>
								</div>

								{#if activeChat?.isPublic}
									<div class="share-link-box">
										<input
											type="text"
											readonly
											value={`${window.location.origin}/shared/${activeChatId}`}
										/>
										<button
											class="copy-btn"
											onclick={copyShareLink}
											title="Копировать ссылку"
											aria-label="Копировать ссылку"
										>
											{#if copySuccess}
												<span>✓</span>
											{:else}
												<svg
													width="14"
													height="14"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
												>
													<rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path
														d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
													/>
												</svg>
											{/if}
										</button>
									</div>
									<p class="share-hint">
										Любой, у кого есть ссылка, сможет просматривать этот чат.
									</p>
								{:else}
									<p class="share-hint">
										Включите публичный доступ, чтобы создать ссылку на этот чат.
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<select
					value={activeChat?.modelPreference || 'auto'}
					onchange={(e) => updateModelPreference(e.currentTarget.value)}
					class="model-select desktop-only"
					disabled={isLoading || isSchemaActionLoading}
				>
					<option value="auto">✨ Авто-режим</option>
					<optgroup label="Gemini 3.1">
						<option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Умная)</option>
						<option value="gemini-3.1-flash-preview">Gemini 3.1 Flash (Быстрая)</option>
						<option value="gemini-3.1-flash-lite-preview"
							>Gemini 3.1 Flash-Lite (Самая быстрая)</option
						>
					</optgroup>
					<optgroup label="Gemini 3.0">
						<option value="gemini-3-pro-preview">Gemini 3.0 Pro</option>
						<option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
					</optgroup>
					<optgroup label="Gemini 2.5">
						<option value="gemini-2.5-pro">Gemini 2.5 Pro (Умная)</option>
						<option value="gemini-2.5-flash">Gemini 2.5 Flash (Быстрая)</option>
						<option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (Самая быстрая)</option>
					</optgroup>
				</select>
			</div>
		</header>

		<!-- Messages area -->
		<div class="messages-area" id="messages-area">
			{#if messages.length === 0}
				<div class="welcome-screen">
					<div class="welcome-hero">
						<h2>{welcomeGreeting}</h2>
					</div>
				</div>
			{:else}
				<div class="messages-list">
					{#each messages as msg (msg.id)}
						<div
							class="message-wrapper"
							class:user={msg.role === 'USER'}
							class:assistant={msg.role === 'ASSISTANT'}
						>
							{#if msg.role === 'ASSISTANT'}
								<div class="avatar assistant-avatar">AI</div>
							{/if}

							<div
								class="message-bubble"
								class:user-bubble={msg.role === 'USER'}
								class:assistant-bubble={msg.role === 'ASSISTANT'}
							>
								{#if msg.isStreaming && !msg.content}
									<!-- Typing dots -->
									<div class="typing-dots">
										<span></span><span></span><span></span>
									</div>
									{#if statusMessage}
										<div class="status-text">{statusMessage}</div>
									{/if}
								{:else if msg.role === 'USER'}
									{#if msg.imageData}
										{@const img = JSON.parse(msg.imageData)}
										<img
											src={`data:${img.mimeType};base64,${img.base64}`}
											alt="Uploaded task"
											class="user-uploaded-img"
										/>
									{/if}
									<p class="user-text">{msg.content}</p>
								{:else}
									<MessageRenderer message={msg} schemeDebug={schemeDebugEnabled} />
									{#if msg.isStreaming && statusMessage}
										<div class="status-text streaming">{statusMessage}</div>
									{/if}
								{/if}
							</div>

							{#if msg.role === 'USER'}
								<div class="avatar user-avatar">Вы</div>
							{/if}

							{#if !msg.isStreaming}
								<button
									class="delete-msg-btn"
									onclick={() => deleteMessage(msg.id)}
									title="Удалить сообщение"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
									>
										<path
											d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
										/>
									</svg>
								</button>
							{/if}
						</div>
					{/each}
					<div bind:this={messagesEnd}></div>
				</div>
			{/if}
		</div>

		<!-- Input area -->
		<div class="input-area">
			{#if statusMessage && (isLoading || isSchemaActionLoading)}
				<div class="status-bar">
					<span class="status-spinner"></span>
					{statusMessage}
				</div>
			{/if}

			{#if activeDraft}
				<div class="schema-review-card">
					<div class="schema-review-header">
						<div>
							<strong>Schema review is active</strong>
							<div class="schema-revision-meta">Revision #{activeDraft.revisionIndex}</div>
						</div>
						<div class="schema-actions">
							<button
								class="schema-action-btn primary"
								onclick={confirmDraftAndSolve}
								disabled={isLoading || isSchemaActionLoading}
							>
								Confirm scheme
							</button>
							<button
								class="schema-action-btn"
								onclick={() => (showRevisionBox = !showRevisionBox)}
								disabled={isLoading || isSchemaActionLoading}
							>
								{showRevisionBox ? 'Hide edit' : 'Revise scheme'}
							</button>
						</div>
					</div>

					{#if activeDraft.assumptions.length > 0}
						<div class="schema-list-block">
							<div class="schema-list-title">Assumptions</div>
							<ul>
								{#each activeDraft.assumptions as assumption}
									<li>{assumption}</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if activeDraft.ambiguities.length > 0}
						<div class="schema-list-block">
							<div class="schema-list-title">Ambiguities</div>
							<ul>
								{#each activeDraft.ambiguities as ambiguity}
									<li>{ambiguity}</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if showRevisionBox}
						<div class="schema-revision-box">
							<textarea
								bind:value={revisionNotes}
								rows="3"
								placeholder="Describe what should be corrected in the scheme..."
								disabled={isLoading || isSchemaActionLoading}
							></textarea>
							<div class="schema-revision-actions">
								<button
									class="schema-action-btn primary"
									onclick={submitSchemaRevision}
									disabled={!revisionNotes.trim() || isLoading || isSchemaActionLoading}
								>
									Submit revision
								</button>
								<button
									class="schema-action-btn"
									onclick={() => {
										showRevisionBox = false;
										revisionNotes = '';
									}}
									disabled={isLoading || isSchemaActionLoading}
								>
									Cancel
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<div class="input-options desktop-options">
				<div class="input-settings" bind:this={inputSettingsMenuEl}>
					<button
						class="input-settings-btn"
						onclick={() => (inputSettingsOpen = !inputSettingsOpen)}
						disabled={isLoading || isSchemaActionLoading}
					>
						<span>Режимы</span>
						<span class="input-settings-chevron" class:open={inputSettingsOpen}>⌄</span>
					</button>
					{#if inputSettingsOpen}
						<div class="input-settings-panel">
							<label class="schema-toggle">
								<input
									type="checkbox"
									bind:checked={schemaCheckEnabled}
									disabled={isLoading ||
										isSchemaActionLoading ||
										(!!activeDraft && activeDraft.status === 'AWAITING_REVIEW')}
								/>
								<span>Проверка схемы</span>
							</label>
							<label class="schema-toggle">
								<input
									type="checkbox"
									bind:checked={schemeDebugEnabled}
									disabled={isLoading || isSchemaActionLoading}
								/>
								<span>Scheme debug</span>
							</label>
						</div>
					{/if}
				</div>
			</div>

			<div class="mobile-tools-row">
				<button
					class="mobile-tools-toggle"
					onclick={toggleMobileTools}
					disabled={isLoading || isSchemaActionLoading}
				>
					<span>Режимы и модель</span>
					<span class="mobile-tools-chevron" class:open={mobileToolsOpen}>⌄</span>
				</button>
			</div>

			{#if mobileToolsOpen}
				<div class="mobile-tools-sheet">
					<div class="mobile-tools-grid">
						<label class="schema-toggle">
							<input
								type="checkbox"
								bind:checked={schemaCheckEnabled}
								disabled={isLoading ||
									isSchemaActionLoading ||
									(!!activeDraft && activeDraft.status === 'AWAITING_REVIEW')}
							/>
							<span>Проверка схемы</span>
						</label>
						<label class="schema-toggle">
							<input
								type="checkbox"
								bind:checked={schemeDebugEnabled}
								disabled={isLoading || isSchemaActionLoading}
							/>
							<span>Scheme debug</span>
						</label>
					</div>

					<label class="mobile-model-label" for="mobile-model-select">Модель</label>
					<select
						id="mobile-model-select"
						value={activeChat?.modelPreference || 'auto'}
						onchange={(e) => updateModelPreference(e.currentTarget.value)}
						class="model-select mobile-model-select"
						disabled={isLoading || isSchemaActionLoading}
					>
						<option value="auto">✨ Авто-режим</option>
						<optgroup label="Gemini 3.1">
							<option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Умная)</option>
							<option value="gemini-3.1-flash-preview">Gemini 3.1 Flash (Быстрая)</option>
							<option value="gemini-3.1-flash-lite-preview"
								>Gemini 3.1 Flash-Lite (Самая быстрая)</option
							>
						</optgroup>
						<optgroup label="Gemini 3.0">
							<option value="gemini-3-pro-preview">Gemini 3.0 Pro</option>
							<option value="gemini-3-flash-preview">Gemini 3.0 Flash</option>
						</optgroup>
						<optgroup label="Gemini 2.5">
							<option value="gemini-2.5-pro">Gemini 2.5 Pro (Умная)</option>
							<option value="gemini-2.5-flash">Gemini 2.5 Flash (Быстрая)</option>
							<option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (Самая быстрая)</option>
						</optgroup>
					</select>
				</div>
			{/if}

			<div class="input-container">
				<!-- File upload button -->
				<button
					class="attach-btn"
					onclick={() => fileInputEl?.click()}
					disabled={isLoading || isSchemaActionLoading}
					title="Прикрепить фото задачи"
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<path
							d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
						/>
					</svg>
				</button>

				<input
					type="file"
					accept="image/*"
					hidden
					bind:this={fileInputEl}
					onchange={handleFileChange}
				/>

				<div class="input-wrapper">
					{#if selectedImage}
						<div class="image-preview">
							<img
								src={`data:${selectedImage.mimeType};base64,${selectedImage.base64}`}
								alt="Preview"
							/>
							<button class="remove-img-btn" onclick={removeImage}>×</button>
						</div>
					{/if}
					<textarea
						id="main-input"
						bind:this={inputEl}
						bind:value={inputValue}
						oninput={autoResize}
						onkeydown={handleKeydown}
						onpaste={handlePaste}
						placeholder="Опишите задачу или прикрепите фото..."
						rows="1"
						disabled={isLoading || isSchemaActionLoading}
						class="message-input"
					></textarea>
				</div>

				{#if isLoading}
					<button class="send-btn stop-btn" onclick={cancelGeneration} title="Остановить генерацию">
						<span class="stop-icon"></span>
					</button>
				{:else}
					<button
						class="send-btn"
						onclick={sendMessage}
						disabled={!inputValue.trim() ||
							isSchemaActionLoading ||
							(!!activeDraft && activeDraft.status === 'AWAITING_REVIEW')}
						title="Отправить"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
						>
							<path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
						</svg>
					</button>
				{/if}
			</div>
		</div>
	</main>
</div>

<style>
	.app-shell {
		display: flex;
		gap: 0;
		height: 100dvh;
		min-height: 100svh;
		padding: calc(0.72rem + env(safe-area-inset-top)) calc(0.72rem + env(safe-area-inset-right))
			calc(0.72rem + env(safe-area-inset-bottom)) calc(0.72rem + env(safe-area-inset-left));
		overflow: hidden;
		background: var(--bg-base);
		position: relative;
		isolation: isolate;
	}

	@supports not (height: 100dvh) {
		.app-shell {
			height: 100vh;
		}
	}

	.sidebar,
	.chat-main {
		animation: panelIn 0.36s ease;
	}

	.sidebar-backdrop {
		position: fixed;
		inset: 0;
		border: none;
		background: rgba(0, 0, 0, 0.44);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--transition-base);
		z-index: 95;
	}

	.sidebar-backdrop.visible {
		opacity: 1;
		pointer-events: auto;
	}

	.sidebar {
		width: var(--sidebar-width);
		min-width: var(--sidebar-width);
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-right: 0;
		border-radius: var(--radius-2xl) 0 0 var(--radius-2xl);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: none;
		transition:
			width var(--transition-base),
			min-width var(--transition-base),
			opacity var(--transition-base),
			transform var(--transition-base),
			border-color var(--transition-base);
		will-change: transform;
		position: relative;
		z-index: 40;
	}

	.sidebar:not(.mobile-drawer).collapsed {
		width: 0;
		min-width: 0;
		opacity: 0;
		border-width: 0;
		box-shadow: none;
		overflow: hidden;
		pointer-events: none;
		transform: translateX(-10px);
	}

	.sidebar.mobile-drawer {
		position: fixed;
		top: calc(0.65rem + env(safe-area-inset-top));
		bottom: calc(0.65rem + env(safe-area-inset-bottom));
		left: calc(0.65rem + env(safe-area-inset-left));
		width: min(86vw, 330px);
		min-width: min(86vw, 330px);
		border: 1px solid var(--border-subtle);
		border-right: 1px solid var(--border-subtle);
		border-radius: var(--radius-xl);
		z-index: 115;
		transform: translateX(-112%);
		pointer-events: none;
		box-shadow: var(--shadow-md);
	}

	.sidebar.mobile-drawer.open {
		transform: translateX(0);
		pointer-events: auto;
	}

	.sidebar.mobile-drawer.collapsed {
		opacity: 1;
		pointer-events: auto;
		border-width: 1px;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.25rem 1.2rem 1rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}

	.logo-icon {
		width: 1.75rem;
		height: 1.75rem;
		object-fit: contain;
	}

	.logo-text {
		font-family: var(--font-serif);
		font-size: 1.18rem;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--text-primary);
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.1rem;
		height: 2.1rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			color var(--transition-fast),
			border-color var(--transition-fast),
			transform var(--transition-fast);
	}

	.icon-btn:hover {
		background: var(--bg-elevated);
		border-color: var(--border-subtle);
		color: var(--text-primary);
		transform: translateY(-1px);
	}

	.icon-btn.active {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent-primary) 42%, transparent);
		color: var(--accent-primary);
	}

	.new-chat-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin: 1rem 1rem 0.72rem;
		padding: 0.72rem 1rem;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		color: var(--text-secondary);
		font-size: 0.84rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast),
			transform var(--transition-fast),
			opacity var(--transition-fast);
		box-shadow: none;
	}

	.new-chat-btn:hover {
		background: var(--bg-elevated);
		border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-subtle));
		color: var(--text-primary);
		opacity: 1;
		transform: translateY(-1px);
	}

	.new-chat-btn:active {
		transform: translateY(0);
	}

	.sidebar-content {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 0.6rem;
	}

	.chat-list {
		overflow-y: auto;
		padding: 0 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.chat-list.pinned {
		margin-bottom: 0.45rem;
	}

	.chat-list-empty {
		padding: 0.75rem 0.8rem;
		border: 1px dashed var(--border-subtle);
		border-radius: var(--radius-md);
		font-size: 0.8rem;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--bg-card) 68%, transparent);
	}

	.chat-section-label {
		padding: 1rem 1.06rem 0.45rem;
		font-size: 0.66rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.11em;
	}

	.chat-item-wrapper {
		display: flex;
		align-items: center;
		padding-right: 0.42rem;
		border-radius: var(--radius-md);
		transition: background-color var(--transition-fast);
	}

	.chat-item-wrapper:hover {
		background: color-mix(in srgb, var(--bg-elevated) 90%, transparent);
	}

	.chat-item-wrapper.active {
		background: color-mix(in srgb, var(--accent-primary) 16%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
	}

	.chat-item {
		display: flex;
		align-items: center;
		gap: 0.56rem;
		flex: 1;
		padding: 0.58rem 0.7rem;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 0.83rem;
		text-align: left;
		cursor: pointer;
		min-width: 0;
	}

	.chat-item-wrapper.active .chat-item {
		color: var(--text-primary);
	}

	.chat-icon {
		flex-shrink: 0;
	}

	.chat-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chat-actions {
		display: flex;
		gap: 0.2rem;
		opacity: 0;
		transition: opacity var(--transition-fast);
	}

	.chat-item-wrapper:hover .chat-actions,
	.chat-item-wrapper.active .chat-actions {
		opacity: 1;
	}

	.action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		background: transparent;
		color: var(--text-muted);
		border-radius: var(--radius-xs);
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			color var(--transition-fast);
	}

	.action-btn:hover {
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.action-btn.delete:hover {
		color: var(--error);
	}

	.edit-title-input {
		width: 100%;
		background: var(--bg-card);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 48%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-primary);
		font-size: 0.83rem;
		padding: 0.25rem 0.45rem;
		outline: none;
	}

	.sidebar-footer {
		padding: 0.85rem;
		border-top: 1px solid var(--border-subtle);
		background: transparent;
	}

	.user-info {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.56rem;
		padding: 0.72rem 0.76rem;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		margin-bottom: 0.7rem;
	}

	.user-details {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.user-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.user-email {
		font-size: 0.7rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.user-details-link {
		text-decoration: none;
		flex: 1;
		min-width: 0;
		display: block;
	}

	.user-details-link:hover .user-name {
		text-decoration: underline;
	}

	.logout-btn {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.28rem;
		border-radius: var(--radius-sm);
		transition:
			background-color var(--transition-fast),
			color var(--transition-fast),
			border-color var(--transition-fast);
	}

	.logout-btn:hover {
		background: var(--bg-elevated);
		border-color: var(--border-subtle);
		color: var(--text-primary);
	}

	.chat-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: 0 var(--radius-2xl) var(--radius-2xl) 0;
		box-shadow: none;
	}

	.sidebar:not(.mobile-drawer).collapsed + .chat-main {
		border-radius: var(--radius-2xl);
	}

	.chat-header {
		display: flex;
		align-items: center;
		gap: 0.72rem;
		padding: calc(0.68rem + env(safe-area-inset-top)) calc(1.32rem + env(safe-area-inset-right))
			0.68rem calc(1.32rem + env(safe-area-inset-left));
		min-height: calc(var(--header-height) + env(safe-area-inset-top));
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-card) 90%, var(--bg-surface));
		flex-shrink: 0;
	}

	.header-title {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.header-title h1 {
		font-size: clamp(1.15rem, 0.7vw + 1rem, 1.34rem);
		font-weight: 600;
		line-height: 1.12;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.header-status {
		display: flex;
		align-items: center;
		opacity: 0;
		transition: opacity var(--transition-base);
	}

	.header-status.active {
		opacity: 1;
	}

	.model-selector {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
	}

	.theme-toggle-btn,
	.share-btn {
		border-color: var(--border-subtle);
		background: var(--bg-card);
	}

	.theme-toggle-btn:hover,
	.share-btn:hover {
		border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
		color: var(--accent-primary);
	}

	.model-select {
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: 0.74rem;
		font-weight: 600;
		padding: 0.44rem 0.68rem;
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			color var(--transition-fast),
			background-color var(--transition-fast);
		font-family: var(--font-sans);
		outline: none;
	}

	.model-select:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent-primary) 52%, transparent);
		color: var(--text-primary);
	}

	.model-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.model-select optgroup {
		background: var(--bg-surface);
		color: var(--text-muted);
		font-style: normal;
		font-weight: 700;
	}

	.model-select option {
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.messages-area {
		flex: 1;
		overflow-y: auto;
		padding: clamp(1.15rem, 2.2vw, 2rem)
			calc(clamp(1.15rem, 2.2vw, 2rem) + env(safe-area-inset-right)) 1.4rem
			calc(clamp(1.15rem, 2.2vw, 2rem) + env(safe-area-inset-left));
		scroll-behavior: smooth;
	}

	.welcome-screen {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: min(56vh, 420px);
		padding: clamp(2.2rem, 5vw, 3.4rem) 0.85rem;
		animation: fadeInUp 0.44s ease;
	}

	.welcome-hero {
		text-align: center;
		max-width: 900px;
	}

	.welcome-hero h2 {
		font-size: clamp(2.1rem, 4.2vw, 3.15rem);
		font-weight: 500;
		line-height: 1.12;
		margin: 0;
		color: var(--text-primary);
		text-wrap: balance;
	}

	.messages-list {
		display: flex;
		flex-direction: column;
		gap: 1.45rem;
		max-width: 930px;
		margin: 0 auto;
	}

	.message-wrapper {
		display: flex;
		gap: 0.78rem;
		align-items: flex-start;
		animation: fadeInUp 0.3s ease;
		position: relative;
	}

	.message-wrapper.user {
		flex-direction: row-reverse;
	}

	.delete-msg-btn {
		opacity: 0;
		transition:
			opacity var(--transition-fast),
			color var(--transition-fast),
			background-color var(--transition-fast);
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0.26rem;
		border-radius: var(--radius-xs);
		margin-top: 0.44rem;
	}

	.delete-msg-btn:hover {
		color: var(--error);
		background: var(--bg-elevated);
	}

	.message-wrapper:hover .delete-msg-btn {
		opacity: 0.95;
	}

	.avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.64rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.assistant-avatar {
		background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent-primary) 36%, transparent);
		color: var(--accent-secondary);
		font-family: var(--font-serif);
	}

	.user-avatar {
		background: var(--bg-card);
		border: 1px solid var(--border-medium);
		color: var(--text-secondary);
		font-family: var(--font-serif);
	}

	.message-bubble {
		max-width: min(79%, 800px);
		padding: 0.82rem 1rem;
		border-radius: var(--radius-lg);
		line-height: 1.72;
	}

	.user-bubble {
		background: var(--user-bubble);
		color: var(--text-primary);
		border: 1px solid var(--border-subtle);
		border-bottom-right-radius: var(--radius-xs);
		box-shadow: var(--shadow-sm);
	}

	.user-bubble ::selection {
		background: var(--accent-soft);
		color: var(--text-primary);
	}

	.assistant-bubble {
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-bottom-left-radius: var(--radius-xs);
	}

	.user-text {
		margin: 0;
		white-space: pre-wrap;
		font-size: 0.92rem;
		line-height: 1.62;
	}

	.status-text {
		font-size: 0.76rem;
		color: var(--text-muted);
		margin-top: 0.55rem;
		display: flex;
		align-items: center;
		gap: 0.42rem;
	}

	.status-text.streaming::before {
		content: '';
		width: 0.38rem;
		height: 0.38rem;
		background: var(--accent-primary);
		border-radius: 999px;
		animation: pulse-soft 1.1s infinite;
		display: inline-block;
	}

	.typing-dots,
	.typing-indicator {
		display: inline-flex;
		gap: 0.28rem;
		align-items: center;
		padding: 0.2rem 0;
	}

	.typing-dots span,
	.typing-indicator span {
		width: 0.36rem;
		height: 0.36rem;
		background: var(--accent-primary);
		border-radius: 999px;
		animation: typing-dot 1.2s infinite;
	}

	.typing-dots span:nth-child(2),
	.typing-indicator span:nth-child(2) {
		animation-delay: 0.2s;
	}

	.typing-dots span:nth-child(3),
	.typing-indicator span:nth-child(3) {
		animation-delay: 0.4s;
	}

	.input-area {
		padding: 0.88rem calc(1.25rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom)) calc(1.25rem + env(safe-area-inset-left));
		border-top: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-card) 92%, var(--bg-surface));
		flex-shrink: 0;
		position: sticky;
		bottom: 0;
		z-index: 22;
	}

	.status-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.78rem;
		color: var(--accent-secondary);
		margin-bottom: 0.55rem;
		padding: 0 0.26rem;
	}

	.schema-review-card {
		margin-bottom: 0.78rem;
		padding: 0.78rem;
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		box-shadow: var(--shadow-sm);
	}

	.schema-review-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.72rem;
	}

	.schema-review-header strong {
		font-family: var(--font-serif);
		font-weight: 600;
	}

	.schema-revision-meta {
		font-size: 0.74rem;
		color: var(--text-muted);
	}

	.schema-actions {
		display: flex;
		gap: 0.45rem;
	}

	.schema-action-btn {
		border: 1px solid var(--border-medium);
		background: var(--bg-elevated);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.38rem 0.78rem;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			opacity var(--transition-fast),
			transform var(--transition-fast);
	}

	.schema-action-btn.primary {
		background: var(--accent-gradient);
		color: #fff8f1;
		border-color: color-mix(in srgb, var(--accent-primary) 62%, transparent);
	}

	.schema-action-btn:hover:not(:disabled) {
		opacity: 0.94;
		border-color: color-mix(in srgb, var(--accent-primary) 52%, transparent);
		transform: translateY(-1px);
	}

	.schema-action-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.schema-list-block {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.schema-list-title {
		font-family: var(--font-serif);
		font-size: 0.86rem;
		font-weight: 600;
		margin-bottom: 0.26rem;
		color: var(--text-primary);
	}

	.schema-list-block ul {
		margin: 0;
		padding-left: 1rem;
	}

	.schema-list-block li {
		margin: 0.15rem 0;
	}

	.schema-revision-box {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.schema-revision-box textarea {
		background: var(--bg-input);
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		padding: 0.58rem 0.65rem;
		font-size: 0.82rem;
		line-height: 1.5;
		resize: vertical;
		outline: none;
	}

	.schema-revision-box textarea:focus {
		border-color: color-mix(in srgb, var(--accent-primary) 48%, transparent);
	}

	.schema-revision-actions {
		display: flex;
		gap: 0.5rem;
	}

	.input-options {
		display: flex;
		justify-content: flex-start;
		gap: 0.5rem;
		margin-bottom: 0.55rem;
		padding: 0 0.12rem;
		flex-wrap: wrap;
	}

	.input-settings {
		position: relative;
	}

	.input-settings-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.36rem 0.62rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--bg-card);
		color: var(--text-secondary);
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			color var(--transition-fast);
	}

	.input-settings-btn:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
		color: var(--text-primary);
		background: var(--bg-elevated);
	}

	.input-settings-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.input-settings-chevron {
		font-size: 0.93rem;
		line-height: 1;
		transition: transform var(--transition-fast);
	}

	.input-settings-chevron.open {
		transform: rotate(180deg);
	}

	.input-settings-panel {
		position: absolute;
		left: 0;
		bottom: calc(100% + 0.5rem);
		min-width: 220px;
		padding: 0.64rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		z-index: 50;
	}

	.schema-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.44rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
		user-select: none;
	}

	.schema-toggle input {
		accent-color: var(--accent-primary);
	}

	.mobile-tools-row {
		display: none;
		margin-bottom: 0.5rem;
	}

	.mobile-tools-toggle {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.48rem 0.7rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-secondary);
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
	}

	.mobile-tools-chevron {
		font-size: 0.95rem;
		line-height: 1;
		transition: transform var(--transition-fast);
	}

	.mobile-tools-chevron.open {
		transform: rotate(180deg);
	}

	.mobile-tools-sheet {
		margin-bottom: 0.56rem;
		padding: 0.68rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.mobile-tools-grid {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.mobile-model-label {
		font-size: 0.73rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.mobile-model-select {
		width: 100%;
	}

	.input-container {
		display: flex;
		align-items: flex-end;
		gap: 0.72rem;
		background: var(--bg-card);
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-xl);
		padding: 0.5rem 0.74rem;
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			background-color var(--transition-fast);
	}

	.input-container:focus-within {
		border-color: color-mix(in srgb, var(--accent-primary) 58%, transparent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}

	.attach-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.2rem;
		height: 2.2rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		border-radius: 999px;
		cursor: pointer;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			transform var(--transition-fast);
		flex-shrink: 0;
		margin-bottom: 0.16rem;
	}

	.attach-btn:hover:not(:disabled) {
		background: var(--bg-elevated);
		border-color: var(--border-subtle);
		color: var(--accent-primary);
		transform: rotate(12deg);
	}

	.input-wrapper {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.image-preview {
		position: relative;
		width: fit-content;
		padding-top: 0.45rem;
	}

	.image-preview img {
		max-width: 124px;
		max-height: 124px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-subtle);
		object-fit: cover;
	}

	.remove-img-btn {
		position: absolute;
		top: -2px;
		right: -8px;
		width: 1.3rem;
		height: 1.3rem;
		background: var(--error);
		color: white;
		border: none;
		border-radius: 999px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		box-shadow: var(--shadow-sm);
	}

	.user-uploaded-img {
		max-width: 100%;
		max-height: 300px;
		border-radius: var(--radius-md);
		margin-bottom: 0.55rem;
		display: block;
		cursor: zoom-in;
		border: 1px solid var(--border-subtle);
	}

	.status-spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 2px solid var(--accent-primary);
		border-top-color: transparent;
		border-radius: 999px;
		animation: spin 0.8s linear infinite;
		flex-shrink: 0;
	}

	.message-input {
		flex: 0 0 auto;
		width: 100%;
		background: transparent;
		border: none;
		outline: none;
		color: var(--text-primary);
		font-size: 0.92rem;
		line-height: 1.55;
		resize: none;
		min-height: 24px;
		max-height: none;
		padding: 0.23rem 0;
		overflow-y: hidden;
		scrollbar-gutter: stable;
	}

	.message-input::placeholder {
		color: var(--text-muted);
	}

	.message-input:disabled {
		opacity: 0.5;
	}

	.send-btn {
		width: 2.35rem;
		height: 2.35rem;
		min-width: 2.35rem;
		border: 1px solid color-mix(in srgb, var(--accent-primary) 60%, transparent);
		border-radius: 999px;
		background: var(--accent-gradient);
		color: #fff8f1;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			opacity var(--transition-fast),
			transform var(--transition-fast),
			box-shadow var(--transition-fast);
		box-shadow: var(--shadow-glow);
		margin-bottom: 0.16rem;
	}

	.send-btn:hover:not(:disabled) {
		opacity: 0.94;
		transform: translateY(-1px);
	}

	.send-btn:active:not(:disabled) {
		transform: translateY(0);
	}

	.send-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
		box-shadow: none;
	}

	.stop-btn {
		background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-card));
		color: var(--accent-primary);
		border-color: color-mix(in srgb, var(--accent-primary) 36%, transparent);
		box-shadow: none;
	}

	.stop-icon {
		width: 0.65rem;
		height: 0.65rem;
		background: currentColor;
		border-radius: 2px;
		display: inline-block;
	}

	.share-container {
		position: relative;
	}

	.share-menu {
		position: absolute;
		top: calc(100% + 0.55rem);
		right: 0;
		width: 286px;
		background: var(--bg-card);
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-lg);
		padding: 0.88rem;
		box-shadow: var(--shadow-md);
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 0.72rem;
		animation: scaleIn 0.2s ease;
	}

	.share-menu-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.83rem;
		font-weight: 600;
	}

	.toggle-switch {
		width: 2.2rem;
		height: 1.22rem;
		background: var(--bg-elevated);
		border: 1px solid var(--border-medium);
		border-radius: 999px;
		position: relative;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.toggle-switch::after {
		content: '';
		position: absolute;
		left: 2px;
		top: 2px;
		width: 0.8rem;
		height: 0.8rem;
		background: var(--text-muted);
		border-radius: 999px;
		transition: all var(--transition-fast);
	}

	.toggle-switch.on {
		background: color-mix(in srgb, var(--accent-primary) 24%, var(--bg-elevated));
		border-color: color-mix(in srgb, var(--accent-primary) 54%, transparent);
	}

	.toggle-switch.on::after {
		left: 16px;
		background: var(--accent-primary);
	}

	.share-link-box {
		display: flex;
		gap: 0.5rem;
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 0.25rem;
	}

	.share-link-box input {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		font-size: 0.74rem;
		color: var(--text-secondary);
		padding: 0.26rem;
		min-width: 0;
	}

	.copy-btn {
		width: 1.75rem;
		height: 1.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-xs);
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.copy-btn:hover {
		background: var(--bg-card);
		border-color: color-mix(in srgb, var(--accent-primary) 44%, transparent);
		color: var(--accent-primary);
	}

	.share-hint {
		font-size: 0.72rem;
		color: var(--text-muted);
		line-height: 1.42;
		margin: 0;
	}

	@media (max-width: 1200px) {
		.sidebar {
			width: 282px;
			min-width: 282px;
		}

		.messages-list {
			max-width: 100%;
		}
	}

	@media (max-width: 1024px) {
		.message-bubble {
			max-width: 86%;
		}
	}

	@media (max-width: 900px) {
		.app-shell {
			padding: calc(0.58rem + env(safe-area-inset-top)) calc(0.58rem + env(safe-area-inset-right))
				calc(0.58rem + env(safe-area-inset-bottom)) calc(0.58rem + env(safe-area-inset-left));
			gap: 0;
		}

		.chat-main {
			border-radius: var(--radius-xl);
		}

		.chat-header {
			gap: 0.5rem;
		}

		.share-menu {
			right: 0;
		}
	}

	@media (max-width: 768px) {
		.desktop-only,
		.desktop-options {
			display: none;
		}

		.mobile-tools-row {
			display: block;
		}

		.app-shell {
			padding: max(0px, env(safe-area-inset-top)) max(0px, env(safe-area-inset-right))
				max(0px, env(safe-area-inset-bottom)) max(0px, env(safe-area-inset-left));
			gap: 0;
		}

		.sidebar,
		.chat-main {
			border-radius: 0;
			box-shadow: none;
		}

		.chat-main {
			width: 100%;
		}

		.chat-header {
			padding: max(0px, env(safe-area-inset-top)) calc(0.82rem + env(safe-area-inset-right)) 0.52rem
				calc(0.82rem + env(safe-area-inset-left));
			min-height: calc(57px + env(safe-area-inset-top));
		}

		.header-title h1 {
			font-size: 1.04rem;
		}

		.messages-area {
			padding: 0.82rem calc(0.76rem + env(safe-area-inset-right)) 0.86rem
				calc(0.76rem + env(safe-area-inset-left));
		}

		.welcome-screen {
			min-height: 46vh;
			padding: 1.24rem 0.35rem;
		}

		.welcome-hero h2 {
			font-size: 1.72rem;
		}

		.messages-list {
			gap: 0.85rem;
		}

		.message-wrapper,
		.message-wrapper.user {
			flex-direction: column;
			gap: 0.34rem;
		}

		.message-wrapper.user .message-bubble {
			margin-left: auto;
		}

		.avatar {
			display: none;
		}

		.message-bubble {
			max-width: 95%;
			padding: 0.68rem 0.84rem;
		}

		.delete-msg-btn {
			opacity: 0.72;
			position: absolute;
			right: 0;
			top: 0;
			margin-top: 0;
		}

		.schema-review-card {
			padding: 0.64rem;
			gap: 0.52rem;
		}

		.schema-review-header {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.44rem;
		}

		.schema-actions,
		.schema-revision-actions {
			width: 100%;
			display: grid;
			grid-template-columns: 1fr;
			gap: 0.45rem;
		}

		.input-area {
			padding: 0.58rem calc(0.76rem + env(safe-area-inset-right))
				calc(0.74rem + env(safe-area-inset-bottom)) calc(0.76rem + env(safe-area-inset-left));
		}

		.input-container {
			gap: 0.52rem;
			padding: 0.44rem 0.56rem;
			border-radius: var(--radius-lg);
		}

		.attach-btn,
		.send-btn {
			width: 2.1rem;
			height: 2.1rem;
			min-width: 2.1rem;
		}

		.message-input {
			font-size: 0.87rem;
		}

		.share-menu {
			width: min(312px, calc(100vw - 1rem));
		}
	}

	@media (max-width: 480px) {
		.chat-header {
			padding-right: calc(0.58rem + env(safe-area-inset-right));
			padding-left: calc(0.58rem + env(safe-area-inset-left));
		}

		.header-title h1 {
			font-size: 0.94rem;
		}

		.schema-toggle {
			font-size: 0.72rem;
		}

		.share-menu {
			right: -0.15rem;
		}
	}

	@keyframes scaleIn {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(-8px);
		}

		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}
</style>
