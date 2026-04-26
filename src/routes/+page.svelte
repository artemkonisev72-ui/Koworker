<script lang="ts">
	/**
	 * +page.svelte - Main chat interface
	 * SSE client + sidebar + message list + input
	 */
	import { onMount, tick } from 'svelte';
	import MessageRenderer from '$lib/components/MessageRenderer.svelte';
	import type { GraphData } from '$lib/graphs/types.js';
	import { clientSandbox, ClientSandboxError } from '$lib/client/sandbox/index.js';
	import {
		canDeleteMessage,
		dedupeMessagesById,
		isTempMessageId,
		reconcileMessageId
	} from '$lib/chat/reconcile.js';
	interface ActiveDraftState {
		draftId: string;
		status: string;
		revisionIndex: number;
		schema: unknown;
		schemeDescription: string;
		assumptions: string[];
		ambiguities: string[];
	}
	interface ChatMessage {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphData[] | string | null;
		exactAnswers?: unknown;
		schemaData?: unknown;
		schemaDescription?: string | null;
		schemaVersion?: string | null;
		imageData?: string | null;
		usedModels?: string[] | string | null;
		draftId?: string | null;
		createdAt?: string;
		isStreaming?: boolean;
		isOptimistic?: boolean;
		persistedId?: string | null;
	}
	interface Chat {
		id: string;
		title: string;
		updatedAt: string;
		isPinned: boolean;
		modelPreference: string;
		isPublic: boolean;
		isProcessing?: boolean;
		processingKind?: string | null;
		processingStatus?: string | null;
	}
	type ChatProcessingKind = 'chat' | 'schema_start' | 'schema_revise' | 'schema_confirm' | null;
	interface ChatProcessingState {
		isBusy: boolean;
		kind: ChatProcessingKind;
		statusMessage: string;
		placeholderId: string | null;
	}
	type ThemeMode = 'light' | 'dark';
	const DEFAULT_MODEL_PREFERENCE = 'gemini-3.1-flash-lite-preview';
	const MODEL_OPTIONS = [
		{ value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-lite' },
		{ value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
		{
			value: 'openrouter:google/gemini-3.1-flash-lite-preview',
			label: 'Gemini 3.1 Flash-lite (openrouter)'
		},
		{
			value: 'openrouter:google/gemini-3.1-pro-preview',
			label: 'Gemini 3.1 Pro (openrouter)'
		}
	] as const;

	let { data }: { data: import('./$types').PageData } = $props();

	let chats = $state<Chat[]>([]);
	let activeChatId = $state<string | null>(null);
	let messagesByChatId = $state<Record<string, ChatMessage[]>>({});
	let draftsByChatId = $state<Record<string, ActiveDraftState | null>>({});
	let processingByChatId = $state<Record<string, ChatProcessingState>>({});
	let messageLoadVersionByChatId = $state<Record<string, number>>({});
	let abortableChatIds = $state<Record<string, boolean>>({});
	let inputValue = $state('');
	let sidebarOpen = $state(true);
	let isMobileView = $state(false);
	let hasViewportInit = false;
	let messagesEnd: HTMLDivElement | undefined = $state();
	let inputEl: HTMLTextAreaElement | undefined = $state();
	let fileInputEl: HTMLInputElement | undefined = $state();

	let editingChatId = $state<string | null>(null);
	let editingTitle = $state('');
	let chatSearchQuery = $state('');

	let isSharing = $state(false);
	let copySuccess = $state(false);

	let pinnedChats = $derived(chats.filter((c) => c.isPinned));
	let otherChats = $derived(chats.filter((c) => !c.isPinned));
	let normalizedChatSearchQuery = $derived(chatSearchQuery.trim().toLowerCase());
	let filteredPinnedChats = $derived.by(() => {
		const query = normalizedChatSearchQuery;
		if (!query) return pinnedChats;
		return pinnedChats.filter((chat) => chat.title.toLowerCase().includes(query));
	});
	let filteredOtherChats = $derived.by(() => {
		const query = normalizedChatSearchQuery;
		if (!query) return otherChats;
		return otherChats.filter((chat) => chat.title.toLowerCase().includes(query));
	});
	let hasFilteredChats = $derived(filteredPinnedChats.length + filteredOtherChats.length > 0);
	let activeChat = $derived(chats.find((c) => c.id === activeChatId));
	let messages = $derived(activeChatId ? messagesByChatId[activeChatId] ?? [] : []);
	let activeDraft = $derived(activeChatId ? draftsByChatId[activeChatId] ?? null : null);
	let isChatEmpty = $derived(messages.length === 0);
	let activeDraftReviewKey = $derived(
		activeDraft ? `${activeDraft.draftId}:${activeDraft.revisionIndex}` : null
	);
	let activeChatProcessing = $derived(
		activeChatId
			? processingByChatId[activeChatId] ?? {
					isBusy: false,
					kind: null,
					statusMessage: '',
					placeholderId: null
				}
			: {
					isBusy: false,
					kind: null,
					statusMessage: '',
					placeholderId: null
				}
	);
	let hasAnyProcessing = $derived(
		Object.values(processingByChatId).some((processing) => processing?.isBusy)
	);
	let busyChat = $derived(
		chats.find((chat) => processingByChatId[chat.id]?.isBusy) ??
			chats.find((chat) => chat.isProcessing)
	);
	let isLoading = $derived(activeChatProcessing.isBusy && activeChatProcessing.kind === 'chat');
	let isSchemaActionLoading = $derived(
		activeChatProcessing.isBusy &&
			activeChatProcessing.kind !== null &&
			activeChatProcessing.kind !== 'chat'
	);
	let statusMessage = $derived(activeChatProcessing.statusMessage);
	let canCancelActiveGeneration = $derived(
		Boolean(activeChatId && abortableChatIds[activeChatId])
	);
	let selectedImage = $state<{ base64: string; mimeType: string } | null>(null);
	let schemaCheckEnabledByChatId = $state<Record<string, boolean>>({});
	let schemaCheckEnabledForNewChat = $state(false);
	let schemaCheckEnabled = $derived(
		activeChatId ? Boolean(schemaCheckEnabledByChatId[activeChatId]) : schemaCheckEnabledForNewChat
	);
	let schemaCheckToggleDisabled = $derived(
		hasAnyProcessing || Boolean(activeDraft && activeDraft.status === 'AWAITING_REVIEW')
	);
	let revisionNotes = $state('');
	let showRevisionBox = $state(false);
	let schemaReviewExpanded = $state(true);
	let lastSchemaReviewKey = $state<string | null>(null);
	let selectedModelPreference = $state(DEFAULT_MODEL_PREFERENCE);
	let isModelMenuOpen = $state(false);
	let modelPickerEl: HTMLDivElement | undefined = $state();
	let modelMenuEl: HTMLDivElement | undefined = $state();
	let modelMenuDirection = $state<'down' | 'up'>('down');
	let modelMenuMaxHeight = $state<number | null>(null);
	let themeMode = $state<ThemeMode>('light');
	let welcomeGreeting = $state('Над чем работаем сегодня?');
	let messageLoadSequence = 0;

	const abortControllersByChatId = new Map<string, AbortController>();

	const THEME_STORAGE_KEY = 'coworker-theme';
	const PROCESSING_POLL_INTERVAL_MS = 2000;

	function idleProcessingState(): ChatProcessingState {
		return {
			isBusy: false,
			kind: null,
			statusMessage: '',
			placeholderId: null
		};
	}

	function getProcessingState(chatId: string | null | undefined): ChatProcessingState {
		if (!chatId) return idleProcessingState();
		return processingByChatId[chatId] ?? idleProcessingState();
	}

	function setMessagesForChat(chatId: string, nextMessages: ChatMessage[]) {
		messagesByChatId = {
			...messagesByChatId,
			[chatId]: dedupeMessagesById(nextMessages)
		};
	}

	function patchMessagesForChat(
		chatId: string,
		updater: (currentMessages: ChatMessage[]) => ChatMessage[]
	) {
		setMessagesForChat(chatId, updater(messagesByChatId[chatId] ?? []));
	}

	function setDraftState(chatId: string, nextDraft: ActiveDraftState | null) {
		draftsByChatId = {
			...draftsByChatId,
			[chatId]: nextDraft
		};
	}

	function setProcessingState(chatId: string, nextState: ChatProcessingState) {
		processingByChatId = {
			...processingByChatId,
			[chatId]: nextState
		};
		chats = chats.map((chat) =>
			chat.id === chatId
				? {
						...chat,
						isProcessing: nextState.isBusy,
						processingKind: nextState.kind,
						processingStatus: nextState.statusMessage || null
					}
				: chat
		);
	}

	function patchProcessingState(
		chatId: string,
		updater: (currentState: ChatProcessingState) => ChatProcessingState
	) {
		setProcessingState(chatId, updater(getProcessingState(chatId)));
	}

	function setProcessingActive(chatId: string, patch: Partial<ChatProcessingState>) {
		patchProcessingState(chatId, (currentState) => ({
			...currentState,
			isBusy: true,
			kind: patch.kind ?? currentState.kind,
			statusMessage: patch.statusMessage ?? currentState.statusMessage,
			placeholderId:
				patch.placeholderId !== undefined ? patch.placeholderId : currentState.placeholderId
		}));
	}

	function clearProcessingState(chatId: string) {
		setProcessingState(chatId, idleProcessingState());
		abortControllersByChatId.delete(chatId);
		abortableChatIds = {
			...abortableChatIds,
			[chatId]: false
		};
		removeProcessingPlaceholder(chatId);
	}

	function setMessageLoadVersion(chatId: string, version: number) {
		messageLoadVersionByChatId = {
			...messageLoadVersionByChatId,
			[chatId]: version
		};
	}

	function getBusyChatTitle(): string {
		return busyChat?.title || 'другом чате';
	}

	function canSubmitMessages(): boolean {
		if (!hasAnyProcessing) return true;
		alert(`Дождитесь завершения обработки в чате "${getBusyChatTitle()}".`);
		return false;
	}

	function setSchemaCheckForChat(chatId: string, enabled: boolean) {
		schemaCheckEnabledByChatId = {
			...schemaCheckEnabledByChatId,
			[chatId]: enabled
		};
	}

	function setSchemaCheckEnabledForCurrentContext(enabled: boolean) {
		if (!activeChatId) {
			schemaCheckEnabledForNewChat = enabled;
			return;
		}
		setSchemaCheckForChat(activeChatId, enabled);
	}

	function toggleSchemaCheckMode() {
		if (schemaCheckToggleDisabled) return;
		setSchemaCheckEnabledForCurrentContext(!schemaCheckEnabled);
	}

	function toggleSchemaReviewPanel() {
		schemaReviewExpanded = !schemaReviewExpanded;
	}

	function toggleSchemaRevisionBox() {
		schemaReviewExpanded = true;
		showRevisionBox = !showRevisionBox;
	}

	function removeProcessingPlaceholder(chatId: string) {
		const processingState = getProcessingState(chatId);
		if (!processingState.placeholderId) return;
		patchMessagesForChat(chatId, (currentMessages) =>
			currentMessages.filter(
				(message) =>
					message.id !== processingState.placeholderId ||
					(!message.isStreaming && !message.isOptimistic)
			)
		);
	}

	function ensureProcessingPlaceholder(chatId: string, explicitPlaceholderId?: string | null) {
		const processingState = getProcessingState(chatId);
		const placeholderId =
			explicitPlaceholderId ?? processingState.placeholderId ?? `processing-${chatId}`;
		const currentMessages = messagesByChatId[chatId] ?? [];
		if (currentMessages.some((message) => message.id === placeholderId || message.isStreaming)) {
			if (processingState.placeholderId !== placeholderId) {
				patchProcessingState(chatId, (currentState) => ({
					...currentState,
					placeholderId
				}));
			}
			return placeholderId;
		}

		const placeholder: ChatMessage = {
			id: placeholderId,
			role: 'ASSISTANT',
			content: '',
			isStreaming: true,
			isOptimistic: true,
			createdAt: new Date().toISOString()
		};

		setMessagesForChat(chatId, [...currentMessages, placeholder]);
		patchProcessingState(chatId, (currentState) => ({
			...currentState,
			placeholderId
		}));
		return placeholderId;
	}

	function syncProcessingStateFromChats(previousChats: Chat[], nextChats: Chat[]) {
		const previousBusyByChatId = new Map(previousChats.map((chat) => [chat.id, Boolean(chat.isProcessing)]));

		for (const chat of nextChats) {
			const serverProcessing = Boolean(chat.isProcessing);
			if (serverProcessing) {
				const placeholderId = ensureProcessingPlaceholder(chat.id);
				setProcessingState(chat.id, {
					isBusy: true,
					kind:
						(chat.processingKind as ChatProcessingKind | null | undefined) ??
						getProcessingState(chat.id).kind,
					statusMessage: chat.processingStatus ?? getProcessingState(chat.id).statusMessage,
					placeholderId
				});
				continue;
			}

			const wasBusy = previousBusyByChatId.get(chat.id) ?? getProcessingState(chat.id).isBusy;
			clearProcessingState(chat.id);
			if (wasBusy) {
				void loadMessages(chat.id);
			}
		}
	}

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
			} else {
				sidebarOpen = true;
			}
		};

		const onViewportChange = () => {
			applyViewportMode();
			if (isModelMenuOpen) {
				void refreshModelMenuLayout();
			}
		};
		const onWindowPointerDown = (event: PointerEvent) => {
			if (!isModelMenuOpen) return;
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (modelPickerEl?.contains(target)) return;
			isModelMenuOpen = false;
			modelMenuMaxHeight = null;
		};
		const onWindowKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && isModelMenuOpen) {
				isModelMenuOpen = false;
				modelMenuMaxHeight = null;
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
		window.addEventListener('pointerdown', onWindowPointerDown);
		window.addEventListener('keydown', onWindowKeyDown);

		void (async () => {
			await loadChats();
			await startNewChat();
		})();

		return () => {
			if (typeof viewportQuery.removeEventListener === 'function') {
				viewportQuery.removeEventListener('change', onViewportChange);
			} else {
				viewportQuery.removeListener(onViewportChange);
			}
			window.removeEventListener('orientationchange', onViewportChange);
			window.removeEventListener('resize', onViewportChange);
			window.removeEventListener('pointerdown', onWindowPointerDown);
			window.removeEventListener('keydown', onWindowKeyDown);
		};
	});

	$effect(() => {
		if (typeof window === 'undefined' || !hasAnyProcessing) return;
		const pollId = window.setInterval(() => {
			void loadChats();
		}, PROCESSING_POLL_INTERVAL_MS);
		return () => {
			window.clearInterval(pollId);
		};
	});

	$effect(() => {
		if (hasAnyProcessing && isModelMenuOpen) {
			isModelMenuOpen = false;
			modelMenuMaxHeight = null;
		}
	});

	$effect(() => {
		const reviewKey = activeDraftReviewKey;
		if (!reviewKey) {
			if (lastSchemaReviewKey !== null) {
				lastSchemaReviewKey = null;
			}
			if (!schemaReviewExpanded) {
				schemaReviewExpanded = true;
			}
			return;
		}
		if (reviewKey !== lastSchemaReviewKey) {
			lastSchemaReviewKey = reviewKey;
			schemaReviewExpanded = true;
		}
	});

	async function loadChats() {
		try {
			const res = await fetch('/api/chats');
			if (res.ok) {
				const nextChats = (await res.json()) as Chat[];
				const previousChats = chats;
				chats = nextChats;
				syncProcessingStateFromChats(previousChats, nextChats);
			}
		} catch (e) {
			console.error('Failed to load chats', e);
		}
	}

	async function createPersistedChat() {
		try {
			const enableSchemaCheckInCreatedChat = !activeChatId
				? schemaCheckEnabledForNewChat
				: Boolean(schemaCheckEnabledByChatId[activeChatId]);
			const res = await fetch('/api/chats', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ modelPreference: currentModelPreference() })
			});
			if (res.ok) {
				const chat = await res.json();
				chats = [chat, ...chats];
				setSchemaCheckForChat(chat.id, enableSchemaCheckInCreatedChat);
				await selectChat(chat.id);
			}
		} catch (e) {
			console.error('Failed to create chat', e);
		}
	}

	async function startNewChat() {
		activeChatId = null;
		showRevisionBox = false;
		revisionNotes = '';
		isModelMenuOpen = false;
		modelMenuMaxHeight = null;
		isSharing = false;
		copySuccess = false;
		editingChatId = null;
		editingTitle = '';
		schemaCheckEnabledForNewChat = false;
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
				const { [id]: _removedMessages, ...restMessages } = messagesByChatId;
				messagesByChatId = restMessages;
				const { [id]: _removedDraft, ...restDrafts } = draftsByChatId;
				draftsByChatId = restDrafts;
				const { [id]: _removedProcessing, ...restProcessing } = processingByChatId;
				processingByChatId = restProcessing;
				const { [id]: _removedSchemaCheck, ...restSchemaCheck } = schemaCheckEnabledByChatId;
				schemaCheckEnabledByChatId = restSchemaCheck;
				abortControllersByChatId.delete(id);
				const { [id]: _removedAbortable, ...restAbortable } = abortableChatIds;
				abortableChatIds = restAbortable;
				if (activeChatId === id) {
					activeChatId = null;
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

	function normalizeModelPreference(preference: string | null | undefined): string {
		if (typeof preference !== 'string') return DEFAULT_MODEL_PREFERENCE;
		const normalized = preference.trim();
		if (normalized === 'auto') return DEFAULT_MODEL_PREFERENCE;
		return MODEL_OPTIONS.some((option) => option.value === normalized)
			? normalized
			: DEFAULT_MODEL_PREFERENCE;
	}

	function currentModelPreference(): string {
		return normalizeModelPreference(selectedModelPreference);
	}

	function modelLabelByPreference(preference: string): string {
		const normalizedPreference = normalizeModelPreference(preference);
		return (
			MODEL_OPTIONS.find((option) => option.value === normalizedPreference)?.label ??
			MODEL_OPTIONS[0].label
		);
	}

	async function refreshModelMenuLayout() {
		if (!isModelMenuOpen || !modelPickerEl || typeof window === 'undefined') return;
		await tick();

		const triggerEl = modelPickerEl.querySelector<HTMLButtonElement>('.model-picker-trigger');
		if (!triggerEl) return;

		const triggerRect = triggerEl.getBoundingClientRect();
		const viewportHeight = window.innerHeight;
		const menuContentHeight = modelMenuEl?.scrollHeight ?? 240;
		const safeMargin = 8;
		const menuGap = 6;
		const availableBelow = viewportHeight - triggerRect.bottom - safeMargin;
		const availableAbove = triggerRect.top - safeMargin;
		const neededHeight = Math.min(menuContentHeight, 300);
		const openUp = availableBelow < neededHeight && availableAbove > availableBelow;
		const availableOnSide = openUp ? availableAbove : availableBelow;

		modelMenuDirection = openUp ? 'up' : 'down';
		modelMenuMaxHeight = Math.max(120, Math.min(340, Math.floor(availableOnSide - menuGap)));
	}

	function toggleModelMenu() {
		if (hasAnyProcessing) return;
		if (isModelMenuOpen) {
			isModelMenuOpen = false;
			modelMenuMaxHeight = null;
			return;
		}
		modelMenuDirection = 'down';
		isModelMenuOpen = true;
		void refreshModelMenuLayout();
	}

	async function pickModelOption(preference: string) {
		isModelMenuOpen = false;
		modelMenuMaxHeight = null;
		if (normalizeModelPreference(preference) === currentModelPreference()) return;
		await updateModelPreference(preference);
	}

	async function updateModelPreference(preference: string) {
		const normalizedPreference = normalizeModelPreference(preference);
		selectedModelPreference = normalizedPreference;
		console.log('[ModelPreference:UI] update requested', {
			chatId: activeChatId,
			currentPreference: currentModelPreference(),
			nextPreference: normalizedPreference
		});
		if (!activeChatId) {
			console.log('[ModelPreference:UI] update stored locally: no active chat yet');
			return;
		}
		chats = chats.map((c) =>
			c.id === activeChatId ? { ...c, modelPreference: normalizedPreference } : c
		);
		try {
			const res = await fetch(`/api/chats/${activeChatId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ modelPreference: normalizedPreference })
			});
			if (res.ok) {
				const updated = await res.json();
				chats = chats.map((c) => (c.id === activeChatId ? updated : c));
				selectedModelPreference = normalizeModelPreference(updated.modelPreference);
				console.log('[ModelPreference:UI] update saved', {
					chatId: activeChatId,
					requestedPreference: normalizedPreference,
					savedPreference: selectedModelPreference
				});
			} else {
				console.warn('[ModelPreference:UI] update failed', {
					chatId: activeChatId,
					requestedPreference: normalizedPreference,
					status: res.status
				});
				await loadChats();
			}
		} catch (e) {
			console.error('Failed to update model preference', e);
			await loadChats();
		}
	}

	async function selectChat(chatId: string) {
		if (activeChatId === chatId) return;
		const selectedChat = chats.find((c) => c.id === chatId);
		selectedModelPreference = normalizeModelPreference(
			selectedChat?.modelPreference || DEFAULT_MODEL_PREFERENCE
		);
		isModelMenuOpen = false;
		modelMenuMaxHeight = null;
		activeChatId = chatId;
		showRevisionBox = false;
		revisionNotes = '';
		ensureProcessingPlaceholder(chatId);
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

	async function hydrateDraftStateFromMessage(
		chatId: string,
		messageDraftId: string | null | undefined,
		requestVersion: number
	) {
		if (!messageDraftId) {
			if (messageLoadVersionByChatId[chatId] === requestVersion) {
				setDraftState(chatId, null);
			}
			return;
		}
		try {
			const res = await fetch(`/api/schema/${messageDraftId}`);
			if (!res.ok) {
				if (messageLoadVersionByChatId[chatId] === requestVersion) {
					setDraftState(chatId, null);
				}
				return;
			}
			const payload = await res.json();
			if (payload.status !== 'AWAITING_REVIEW' || !payload.currentSchema) {
				if (messageLoadVersionByChatId[chatId] === requestVersion) {
					setDraftState(chatId, null);
				}
				showRevisionBox = false;
				return;
			}
			if (messageLoadVersionByChatId[chatId] !== requestVersion) return;
			setDraftState(chatId, {
				draftId: payload.draftId,
				status: payload.status,
				revisionIndex: payload.revisionCount,
				schema: payload.currentSchema,
				schemeDescription:
					typeof payload.currentSchemeDescription === 'string'
						? payload.currentSchemeDescription
						: typeof payload.latestRevision?.schemeDescription === 'string'
							? payload.latestRevision.schemeDescription
							: '',
				assumptions: Array.isArray(payload.latestRevision?.assumptions)
					? payload.latestRevision.assumptions.filter((item: unknown) => typeof item === 'string')
					: [],
				ambiguities: Array.isArray(payload.latestRevision?.ambiguities)
					? payload.latestRevision.ambiguities.filter((item: unknown) => typeof item === 'string')
					: []
			});
		} catch {
			if (messageLoadVersionByChatId[chatId] === requestVersion) {
				setDraftState(chatId, null);
			}
		}
	}

	async function loadMessages(chatId: string) {
		const requestVersion = messageLoadSequence + 1;
		messageLoadSequence = requestVersion;
		setMessageLoadVersion(chatId, requestVersion);
		try {
			const res = await fetch(`/api/chat?chatId=${chatId}`);
			if (res.ok) {
				const data = await res.json();
				if (messageLoadVersionByChatId[chatId] !== requestVersion) return;
				const nextMessages = data.map((m: any) => ({
					...m,
					graphData: typeof m.graphData === 'string' ? JSON.parse(m.graphData) : m.graphData,
					exactAnswers: parseMaybeJson(m.exactAnswers),
					schemaData: parseMaybeJson(m.schemaData),
					schemaDescription: typeof m.schemaDescription === 'string' ? m.schemaDescription : null,
					schemaVersion: typeof m.schemaVersion === 'string' ? m.schemaVersion : null,
					usedModels: typeof m.usedModels === 'string' ? JSON.parse(m.usedModels) : m.usedModels,
					draftId: m.draftId ?? null
				}));
				setMessagesForChat(chatId, nextMessages);
				if (getProcessingState(chatId).isBusy) {
					ensureProcessingPlaceholder(chatId);
				}
				const latestDraftMessage = [...nextMessages]
					.reverse()
					.find((m) => m.draftId && m.role === 'ASSISTANT');
				await hydrateDraftStateFromMessage(chatId, latestDraftMessage?.draftId, requestVersion);
				if (activeChatId === chatId) {
					await scrollToBottom();
				}
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

	function patchMessageById(chatId: string, messageId: string, patch: Partial<ChatMessage>) {
		patchMessagesForChat(chatId, (currentMessages) =>
			currentMessages.map((message) =>
				message.id === messageId
					? {
							...message,
							...patch
						}
					: message
			)
		);
	}

	function applyMessageIdReconciliation(
		chatId: string,
		currentId: string,
		persistedId: string | null | undefined
	): string {
		if (!persistedId || currentId === persistedId) return currentId;
		patchMessagesForChat(chatId, (currentMessages) =>
			reconcileMessageId(currentMessages, currentId, persistedId)
		);
		patchProcessingState(chatId, (currentState) => ({
			...currentState,
			placeholderId:
				currentState.placeholderId === currentId ? persistedId : currentState.placeholderId
		}));
		return persistedId;
	}

	function appendOptimisticExchange(
		chatId: string,
		text: string,
		imageData: { base64: string; mimeType: string } | null
	) {
		const userTempId = generateSafeId();
		const assistantTempId = generateSafeId();

		const userMessage: ChatMessage = {
			id: userTempId,
			role: 'USER',
			content: text,
			imageData: imageData ? JSON.stringify(imageData) : null,
			createdAt: new Date().toISOString(),
			isOptimistic: true
		};

		const assistantPlaceholder: ChatMessage = {
			id: assistantTempId,
			role: 'ASSISTANT',
			content: '',
			isStreaming: true,
			isOptimistic: true,
			createdAt: new Date().toISOString()
		};

		setMessagesForChat(chatId, [
			...(messagesByChatId[chatId] ?? []),
			userMessage,
			assistantPlaceholder
		]);
		setProcessingActive(chatId, {
			placeholderId: assistantTempId
		});
		return { userTempId, assistantTempId };
	}

	async function deleteMessage(msgId: string) {
		if (!confirm('Удалить это сообщение?')) return;
		const targetMessage = messages.find((message) => message.id === msgId);
		if (targetMessage && !canDeleteMessage(targetMessage)) {
			alert('Сообщение еще не сохранено. Попробуйте удалить через пару секунд.');
			return;
		}
		if (isTempMessageId(msgId)) {
			alert('Сообщение еще не сохранено. Попробуйте удалить через пару секунд.');
			return;
		}
		try {
			const res = await fetch(`/api/messages/${msgId}`, { method: 'DELETE' });
			if (res.ok) {
				if (activeChatId) {
					await loadMessages(activeChatId);
				}
				await loadChats();
				return;
			}
			alert(await parseErrorMessage(res));
		} catch (e) {
			console.error('Failed to delete message', e);
			alert('Не удалось удалить сообщение. Проверьте соединение и попробуйте снова.');
		}
	}

	function cancelGeneration() {
		if (!activeChatId) return;
		const controller = abortControllersByChatId.get(activeChatId);
		if (controller) {
			controller.abort();
			abortControllersByChatId.delete(activeChatId);
			abortableChatIds = {
				...abortableChatIds,
				[activeChatId]: false
			};
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

	async function submitSandboxResult(payload: {
		requestId: string;
		ok: boolean;
		stdout?: string;
		error?: string;
		errorKind?: string;
	}): Promise<void> {
		await fetch('/api/sandbox/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
	}

	function classifySandboxClientError(error: unknown): { message: string; errorKind: string } {
		if (error instanceof ClientSandboxError) {
			return { message: error.message, errorKind: error.kind };
		}
		if (error instanceof Error) {
			return { message: error.message, errorKind: 'unknown' };
		}
		return { message: String(error), errorKind: 'unknown' };
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	function setDraftStateFromPayload(chatId: string, payload: Record<string, any>) {
		setDraftState(chatId, {
			draftId: payload.draftId,
			status: payload.status,
			revisionIndex: payload.revisionIndex,
			schema: payload.schema,
			schemeDescription: typeof payload.schemeDescription === 'string' ? payload.schemeDescription : '',
			assumptions: Array.isArray(payload.assumptions) ? payload.assumptions : [],
			ambiguities: Array.isArray(payload.ambiguities) ? payload.ambiguities : []
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
					clearProcessingState(chatId);
					await loadMessages(chatId);
					await loadChats();
					return;
				}
				if (status === 'FAILED' || status === 'CANCELED') {
					clearProcessingState(chatId);
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
		chatId: string,
		text: string,
		imageData: { base64: string; mimeType: string } | null,
		optimisticExchange: { userTempId: string; assistantTempId: string }
	) {
		const modelPreference = currentModelPreference();
		console.log('[ModelPreference:UI] schema start submit', {
			chatId,
			modelPreference,
			messageLength: text.length,
			hasImage: Boolean(imageData)
		});
		setProcessingActive(chatId, {
			kind: 'schema_start',
			statusMessage: 'Building initial scheme...',
			placeholderId: optimisticExchange.assistantTempId
		});
		try {
			const res = await fetch('/api/schema/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chatId,
					message: text,
					imageData,
					modelPreference,
					mode: 'schema_check'
				})
			});
			if (!res.ok) {
				throw new Error(await parseErrorMessage(res));
			}
			const payload = await res.json();
			const persistedUserId =
				typeof payload.userMessageId === 'string' ? payload.userMessageId : null;
			const persistedAssistantId =
				typeof payload.assistantMessage?.id === 'string' ? payload.assistantMessage.id : null;
			const resolvedUserId = applyMessageIdReconciliation(
				chatId,
				optimisticExchange.userTempId,
				persistedUserId
			);
			const resolvedAssistantId = applyMessageIdReconciliation(
				chatId,
				optimisticExchange.assistantTempId,
				persistedAssistantId
			);
			patchMessageById(chatId, resolvedUserId, { isOptimistic: false });
			patchMessageById(chatId, resolvedAssistantId, {
				content: typeof payload.assistantMessage?.content === 'string' ? payload.assistantMessage.content : '',
				schemaData: payload.schema ?? null,
				schemaDescription:
					typeof payload.schemeDescription === 'string' ? payload.schemeDescription : null,
				isStreaming: false,
				isOptimistic: false
			});
			setDraftStateFromPayload(chatId, payload);
			showRevisionBox = false;
			revisionNotes = '';
			clearProcessingState(chatId);
			await loadMessages(chatId);
			await loadChats();
		} finally {
			if (!getProcessingState(chatId).isBusy) {
				removeProcessingPlaceholder(chatId);
			}
		}
	}

	async function submitSchemaRevision() {
		if (!activeDraft || !activeChatId) return;
		const notes = revisionNotes.trim();
		if (!notes || isSchemaActionLoading || isLoading || hasAnyProcessing) return;
		setProcessingActive(activeChatId, {
			kind: 'schema_revise',
			statusMessage: 'Applying scheme revisions...'
		});
		ensureProcessingPlaceholder(activeChatId);
		try {
			const res = await fetch(`/api/schema/${activeDraft.draftId}/revise`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ notes, modelPreference: currentModelPreference() })
			});
			if (!res.ok) {
				throw new Error(await parseErrorMessage(res));
			}
			const payload = await res.json();
			setDraftStateFromPayload(activeChatId, payload);
			revisionNotes = '';
			showRevisionBox = false;
			await loadMessages(activeChatId);
			await loadChats();
		} catch (err) {
			console.error('Schema revision failed:', err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			clearProcessingState(activeChatId);
		}
	}

	async function confirmDraftAndSolve() {
		if (!activeDraft || !activeChatId || isSchemaActionLoading || isLoading || hasAnyProcessing) return;
		setProcessingActive(activeChatId, {
			kind: 'schema_confirm',
			statusMessage: 'Solving using approved scheme...'
		});
		ensureProcessingPlaceholder(activeChatId);
		const draftId = activeDraft.draftId;
		const chatId = activeChatId;
		try {
			const res = await fetch(`/api/schema/${draftId}/confirm/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ modelPreference: currentModelPreference() })
			});
			if (!res.ok || !res.body) {
				throw new Error(await parseErrorMessage(res));
			}

			setDraftState(chatId, null);
			showRevisionBox = false;
			revisionNotes = '';
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let receivedResult = false;

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
							requestId?: string;
							code?: string;
							timeoutMs?: number;
						};

						if (event.type === 'status') {
							setProcessingActive(chatId, {
								kind: 'schema_confirm',
								statusMessage: event.message ?? '',
								placeholderId: getProcessingState(chatId).placeholderId
							});
						} else if (event.type === 'sandbox_request') {
							const requestId = typeof event.requestId === 'string' ? event.requestId : '';
							const code = typeof event.code === 'string' ? event.code : '';
							if (!requestId || !code) continue;

							void (async () => {
								let resultPayload:
									| { requestId: string; ok: true; stdout: string }
									| { requestId: string; ok: false; error: string; errorKind: string };
								try {
									const execution = await clientSandbox.execute(code, {
										timeoutMs: event.timeoutMs
									});
									resultPayload = {
										requestId,
										ok: true,
										stdout: execution.stdout
									};
								} catch (sandboxError) {
									const normalized = classifySandboxClientError(sandboxError);
									resultPayload = {
										requestId,
										ok: false,
										error: normalized.message,
										errorKind: normalized.errorKind
									};
								}

								try {
									await submitSandboxResult(resultPayload);
								} catch (postError) {
									console.error('Failed to send schema sandbox result:', postError);
								}
							})();
						} else if (event.type === 'result') {
							receivedResult = true;
							setSchemaCheckForChat(chatId, false);
							await loadMessages(chatId);
							await loadChats();
							clearProcessingState(chatId);
							return;
						} else if (event.type === 'error') {
							throw new Error(event.message ?? 'Schema solve failed');
						}
					} catch (streamError) {
						throw streamError;
					}
				}
			}

			if (!receivedResult) {
				throw new Error('Schema solve stream ended without result');
			}
		} catch (err) {
			console.error('Schema confirm failed:', err);
			await loadMessages(chatId);
			await loadChats();
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			if (!chats.find((chat) => chat.id === chatId)?.isProcessing) {
				clearProcessingState(chatId);
			}
		}
	}

	async function sendMessage() {
		const text = inputValue.trim();
		if (!text) return;
		if (!canSubmitMessages()) return;
		if (isLoading || isSchemaActionLoading) return;
		const modelPreference = currentModelPreference();

		if (activeDraft && activeDraft.status === 'AWAITING_REVIEW') {
			alert('Confirm or revise the current scheme before sending a new task.');
			return;
		}

		if (!activeChatId) await createPersistedChat();
		if (!activeChatId) return;
		const originChatId = activeChatId;
		console.log('[ModelPreference:UI] send submit', {
			chatId: originChatId,
			modelPreference,
			schemaCheckEnabled,
			messageLength: text.length,
			hasImage: Boolean(selectedImage)
		});

		const imageData = selectedImage;
		selectedImage = null;
		if (fileInputEl) fileInputEl.value = '';
		inputValue = '';

		const optimisticExchange = appendOptimisticExchange(originChatId, text, imageData);
		await scrollToBottom();

		if (schemaCheckEnabled) {
			try {
				await startSchemaCheckFlow(originChatId, text, imageData, optimisticExchange);
			} catch (err) {
				console.error('Schema check start failed:', err);
				alert(err instanceof Error ? err.message : String(err));
				patchMessageById(originChatId, optimisticExchange.assistantTempId, {
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					isStreaming: false,
					isOptimistic: false
				});
				clearProcessingState(originChatId);
				await loadMessages(originChatId);
			}
			if (activeChatId === originChatId) {
				await scrollToBottom();
			}
			return;
		}

		setProcessingActive(originChatId, {
			kind: 'chat',
			statusMessage: '',
			placeholderId: optimisticExchange.assistantTempId
		});
		let userMessageId = optimisticExchange.userTempId;
		let assistantMessageId = optimisticExchange.assistantTempId;

		try {
			const abortController = new AbortController();
			abortControllersByChatId.set(originChatId, abortController);
			abortableChatIds = {
				...abortableChatIds,
				[originChatId]: true
			};
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chatId: originChatId,
					message: text,
					imageData,
					modelPreference
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
							userMessageId?: string;
							messageId?: string;
							content?: string;
							graphData?: GraphData[];
							exactAnswers?: unknown;
							schemaData?: unknown;
							schemaDescription?: string;
							schemaVersion?: string;
							usedModels?: string[];
							requestId?: string;
							code?: string;
							timeoutMs?: number;
							attempt?: number;
						};

						if (event.type === 'ack') {
							userMessageId = applyMessageIdReconciliation(
								originChatId,
								userMessageId,
								event.userMessageId ?? null
							);
							patchMessageById(originChatId, userMessageId, { isOptimistic: false });
						} else if (event.type === 'status') {
							setProcessingActive(originChatId, {
								kind: 'chat',
								statusMessage: event.message ?? '',
								placeholderId: assistantMessageId
							});
						} else if (event.type === 'sandbox_request') {
							const requestId = typeof event.requestId === 'string' ? event.requestId : '';
							const code = typeof event.code === 'string' ? event.code : '';
							if (!requestId || !code) continue;

							void (async () => {
								let resultPayload:
									| { requestId: string; ok: true; stdout: string }
									| { requestId: string; ok: false; error: string; errorKind: string };
								try {
									const execution = await clientSandbox.execute(code, {
										timeoutMs: event.timeoutMs
									});
									resultPayload = {
										requestId,
										ok: true,
										stdout: execution.stdout
									};
								} catch (sandboxError) {
									const normalized = classifySandboxClientError(sandboxError);
									resultPayload = {
										requestId,
										ok: false,
										error: normalized.message,
										errorKind: normalized.errorKind
									};
								}

								try {
									await submitSandboxResult(resultPayload);
								} catch (postError) {
									console.error('Failed to send sandbox result:', postError);
								}
							})();
						} else if (event.type === 'result') {
							assistantMessageId = applyMessageIdReconciliation(
								originChatId,
								assistantMessageId,
								event.messageId ?? null
							);
							patchMessageById(originChatId, assistantMessageId, {
								content: event.content ?? '',
								graphData: event.graphData ?? null,
								exactAnswers: event.exactAnswers ?? null,
								schemaData: event.schemaData ?? null,
								schemaDescription: event.schemaDescription ?? null,
								schemaVersion: event.schemaVersion ?? null,
								usedModels: event.usedModels ?? null,
								isStreaming: false,
								isOptimistic: false
							});
							clearProcessingState(originChatId);
							await loadChats();
							if (activeChatId === originChatId) {
								await scrollToBottom();
							}
						} else if (event.type === 'error') {
							patchMessageById(originChatId, assistantMessageId, {
								content: `Error: ${event.message}`,
								isStreaming: false,
								isOptimistic: false
							});
							clearProcessingState(originChatId);
							if (activeChatId === originChatId) {
								await scrollToBottom();
							}
						}
					} catch {
						// ignore malformed SSE line
					}
				}
			}
		} catch (chatError) {
			if (chatError instanceof Error && chatError.name === 'AbortError') {
				console.log('Request aborted by user');
				patchMessageById(originChatId, assistantMessageId, {
					isStreaming: false,
					isOptimistic: false
				});
			} else {
				console.error('Chat error:', chatError);
				patchMessageById(originChatId, assistantMessageId, {
					content: `Network error: ${chatError instanceof Error ? chatError.message : String(chatError)}`,
					isStreaming: false,
					isOptimistic: false
				});
			}
		} finally {
			abortControllersByChatId.delete(originChatId);
			abortableChatIds = {
				...abortableChatIds,
				[originChatId]: false
			};
			clearProcessingState(originChatId);
			if (isTempMessageId(userMessageId) || isTempMessageId(assistantMessageId)) {
				await loadMessages(originChatId);
			}
			if (activeChatId === originChatId) {
				await scrollToBottom();
			}
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
			<div class="sidebar-search">
				<svg
					class="sidebar-search-icon"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7"></circle>
					<path d="M21 21l-4.35-4.35"></path>
				</svg>
				<input
					type="text"
					class="sidebar-search-input"
					bind:value={chatSearchQuery}
					placeholder="Поиск чатов"
					aria-label="Поиск чатов"
				/>
				{#if chatSearchQuery}
					<button
						type="button"
						class="sidebar-search-clear"
						onclick={() => (chatSearchQuery = '')}
						title="Очистить поиск"
						aria-label="Очистить поиск"
					>
						×
					</button>
				{/if}
			</div>

			{#if chats.length === 0}
				<div class="chat-list">
					<div class="chat-list-empty">Нет чатов. Создайте первый!</div>
				</div>
			{:else if !hasFilteredChats}
				<div class="chat-list">
					<div class="chat-list-empty">Ничего не найдено</div>
				</div>
			{:else}
				{#if filteredPinnedChats.length > 0}
					<div class="chat-section-label">Закрепленные</div>
					<div class="chat-list pinned">
						{#each filteredPinnedChats as chat (chat.id)}
							{@render chatItem(chat)}
						{/each}
					</div>
				{/if}

				{#if filteredOtherChats.length > 0}
					<div class="chat-section-label">{filteredPinnedChats.length > 0 ? 'Все чаты' : 'Чаты'}</div>
					<div class="chat-list">
						{#each filteredOtherChats as chat (chat.id)}
							{@render chatItem(chat)}
						{/each}
					</div>
				{/if}
			{/if}
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
						{#if chat.isProcessing}
							<span class="chat-processing-marker" title={chat.processingStatus ?? 'Идет обработка'}>
								<span></span><span></span><span></span>
							</span>
						{/if}
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
							<path d="M8 4h8v3l2 2v1h-5v5l-1 1-1-1v-5H6V9l2-2z" />
							<path d="M12 16v4" />
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
		{#snippet composerCard()}
			<div class="composer-card">
				<div class="input-toolbar">
					<button
						type="button"
						class="schema-check-btn"
						class:active={schemaCheckEnabled}
						onclick={toggleSchemaCheckMode}
						disabled={schemaCheckToggleDisabled}
						aria-pressed={schemaCheckEnabled}
						aria-label={schemaCheckEnabled ? 'Проверка схемы включена' : 'Проверка схемы выключена'}
						title="Включить или выключить проверку схемы для текущего чата"
					>
						<span class="schema-check-title">Проверка схемы</span>
						<span class="schema-check-indicator" aria-hidden="true"></span>
					</button>

					<div class="model-picker composer-model-select" bind:this={modelPickerEl}>
						<button
							type="button"
							class="model-picker-trigger"
							onclick={toggleModelMenu}
							disabled={hasAnyProcessing}
							aria-haspopup="listbox"
							aria-expanded={isModelMenuOpen}
							title="Выбор модели"
						>
							<span class="model-picker-label">
								{modelLabelByPreference(currentModelPreference())}
							</span>
							<svg
								class="model-picker-chevron"
								class:open={isModelMenuOpen}
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
							>
								<path d="M6 9l6 6 6-6" />
							</svg>
						</button>

						{#if isModelMenuOpen}
							<div
								bind:this={modelMenuEl}
								class="model-picker-menu"
								class:model-picker-menu-up={modelMenuDirection === 'up'}
								style:max-height={modelMenuMaxHeight ? `${modelMenuMaxHeight}px` : undefined}
								role="listbox"
								aria-label="Выбор модели"
							>
								{#each MODEL_OPTIONS as option (option.value)}
									<button
										type="button"
										class="model-picker-option"
										class:selected={option.value === currentModelPreference()}
										onclick={() => pickModelOption(option.value)}
										role="option"
										aria-selected={option.value === currentModelPreference()}
									>
										<span>{option.label}</span>
										{#if option.value === currentModelPreference()}
											<svg
												class="model-picker-check"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.2"
												aria-hidden="true"
											>
												<path d="M20 6L9 17l-5-5" />
											</svg>
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<div class="input-container">
					<button
						class="attach-btn"
						onclick={() => fileInputEl?.click()}
						disabled={hasAnyProcessing}
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
							disabled={hasAnyProcessing}
							class="message-input"
						></textarea>
					</div>

					{#if canCancelActiveGeneration}
						<button class="send-btn stop-btn" onclick={cancelGeneration} title="Остановить генерацию">
							<span class="stop-icon"></span>
						</button>
					{:else}
						<button
							class="send-btn"
							onclick={sendMessage}
							disabled={!inputValue.trim() ||
								hasAnyProcessing ||
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
		{/snippet}

		{#snippet schemaReviewPanel()}
			{#if activeDraft}
				<div class="schema-review-card" class:collapsed={!schemaReviewExpanded}>
					<div class="schema-review-header">
						<div class="schema-review-heading">
							<strong>Schema review is active</strong>
							<div class="schema-revision-meta">Revision #{activeDraft.revisionIndex}</div>
						</div>

						<div class="schema-review-header-actions">
							{#if schemaReviewExpanded}
								<div class="schema-actions">
									<button
										class="schema-action-btn primary"
										onclick={confirmDraftAndSolve}
										disabled={hasAnyProcessing}
									>
										Confirm scheme
									</button>
									<button
										class="schema-action-btn"
										onclick={toggleSchemaRevisionBox}
										disabled={hasAnyProcessing}
									>
										{showRevisionBox ? 'Hide edit' : 'Revise scheme'}
									</button>
								</div>
							{/if}

							<button
								type="button"
								class="schema-review-toggle"
								onclick={toggleSchemaReviewPanel}
								aria-expanded={schemaReviewExpanded}
								aria-label={schemaReviewExpanded
									? 'Свернуть панель проверки схемы'
									: 'Развернуть панель проверки схемы'}
								title={schemaReviewExpanded ? 'Свернуть' : 'Развернуть'}
							>
								<svg
									class="schema-review-chevron"
									class:expanded={schemaReviewExpanded}
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
						</div>
					</div>

					{#if schemaReviewExpanded}
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
									disabled={hasAnyProcessing}
								></textarea>
								<div class="schema-revision-actions">
									<button
										class="schema-action-btn primary"
										onclick={submitSchemaRevision}
										disabled={!revisionNotes.trim() || hasAnyProcessing}
									>
										Submit revision
									</button>
									<button
										class="schema-action-btn"
										onclick={() => {
											showRevisionBox = false;
											revisionNotes = '';
										}}
										disabled={hasAnyProcessing}
									>
										Cancel
									</button>
								</div>
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		{/snippet}

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
			<div class="header-status" class:active={activeChatProcessing.isBusy}>
				{#if activeChatProcessing.isBusy}
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
			</div>
		</header>

		<!-- Messages area -->
		<div class="messages-area" class:empty={isChatEmpty} id="messages-area">
			{#if isChatEmpty}
				<div class="welcome-screen">
					<div class="welcome-composer-shell">
						<div class="welcome-hero">
							<h2>{welcomeGreeting}</h2>
						</div>
						{@render composerCard()}
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
									<MessageRenderer message={msg} />
									{#if msg.isStreaming && statusMessage}
										<div class="status-text streaming">{statusMessage}</div>
									{/if}
								{/if}
							</div>

							{#if msg.role === 'USER'}
								<div class="avatar user-avatar">Вы</div>
							{/if}

							{#if !msg.isStreaming && !msg.isOptimistic}
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

		{#if !isChatEmpty}
			<!-- Input area -->
			<div class="input-area">
				<div class="composer-shell">
					{@render schemaReviewPanel()}
					{@render composerCard()}
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.app-shell {
		display: flex;
		gap: 0;
		height: 100dvh;
		min-height: 100svh;
		padding: max(0px, env(safe-area-inset-top)) max(0px, env(safe-area-inset-right))
			max(0px, env(safe-area-inset-bottom)) max(0px, env(safe-area-inset-left));
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
		border: none;
		border-right: 1px solid var(--border-subtle);
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
		padding: 0.46rem 1.18rem;
		min-height: var(--header-height);
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

	.sidebar-search {
		position: relative;
		margin: 0 1rem 0.7rem;
		display: flex;
		align-items: center;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0.42rem 0.7rem;
		gap: 0.44rem;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.sidebar-search:focus-within {
		border-color: color-mix(in srgb, var(--accent-primary) 44%, transparent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}

	.sidebar-search-icon {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.sidebar-search-input {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		color: var(--text-primary);
		font-size: 0.79rem;
		min-width: 0;
	}

	.sidebar-search-input::placeholder {
		color: var(--text-muted);
	}

	.sidebar-search-clear {
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-muted);
		width: 1.3rem;
		height: 1.3rem;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		font-size: 0.9rem;
		line-height: 1;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			color var(--transition-fast);
	}

	.sidebar-search-clear:hover {
		background: var(--bg-elevated);
		border-color: var(--border-subtle);
		color: var(--text-primary);
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

	.chat-processing-marker {
		display: inline-flex;
		align-items: center;
		gap: 0.18rem;
		margin-left: auto;
		padding-left: 0.2rem;
		flex-shrink: 0;
	}

	.chat-processing-marker span {
		width: 0.26rem;
		height: 0.26rem;
		border-radius: 999px;
		background: var(--accent-primary);
		opacity: 0.45;
		animation: typing-dot 1.2s infinite;
	}

	.chat-processing-marker span:nth-child(2) {
		animation-delay: 0.18s;
	}

	.chat-processing-marker span:nth-child(3) {
		animation-delay: 0.36s;
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
		border: none;
		border-radius: 0 0 var(--radius-2xl) 0;
		box-shadow: none;
	}

	.sidebar:not(.mobile-drawer).collapsed + .chat-main {
		border-radius: 0 0 var(--radius-2xl) var(--radius-2xl);
	}

	.chat-header {
		display: flex;
		align-items: center;
		gap: 0.72rem;
		padding: calc(0.48rem + env(safe-area-inset-top)) calc(1.18rem + env(safe-area-inset-right))
			0.46rem calc(1.18rem + env(safe-area-inset-left));
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
		font-size: clamp(1.08rem, 0.62vw + 0.96rem, 1.24rem);
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

	.model-picker {
		position: relative;
	}

	.model-picker-trigger {
		width: 100%;
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
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
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
		font-family: var(--font-sans);
		outline: none;
	}

	.model-picker-trigger:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent-primary) 52%, transparent);
		color: var(--text-primary);
	}

	.model-picker-trigger:focus-visible {
		border-color: color-mix(in srgb, var(--accent-primary) 52%, transparent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}

	.model-picker-trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.model-picker-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}

	.model-picker-chevron {
		flex-shrink: 0;
		transition: transform var(--transition-fast);
	}

	.model-picker-chevron.open {
		transform: rotate(180deg);
	}

	.model-picker-menu {
		position: absolute;
		top: calc(100% + 0.38rem);
		right: 0;
		width: max-content;
		min-width: 100%;
		max-width: min(430px, 82vw);
		padding: 0.28rem;
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
		background: var(--bg-card);
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		z-index: 40;
		animation: scaleIn 0.16s ease;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}

	.model-picker-menu.model-picker-menu-up {
		top: auto;
		bottom: calc(100% + 0.38rem);
	}

	.model-picker-option {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.4rem 0.5rem;
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			color var(--transition-fast);
	}

	.model-picker-option:hover {
		background: var(--bg-elevated);
		border-color: var(--border-subtle);
		color: var(--text-primary);
	}

	.model-picker-option.selected {
		color: var(--accent-primary);
		background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card));
		border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
	}

	.model-picker-check {
		flex-shrink: 0;
	}

	.messages-area {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		padding: clamp(1.15rem, 2.2vw, 2rem)
			calc(clamp(1.15rem, 2.2vw, 2rem) + env(safe-area-inset-right))
			calc(1.4rem + env(safe-area-inset-bottom)) calc(clamp(1.15rem, 2.2vw, 2rem) + env(safe-area-inset-left));
		scroll-behavior: smooth;
	}

	.messages-area.empty {
		justify-content: center;
	}

	.welcome-screen {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100%;
		padding: clamp(1.8rem, 4vw, 3rem) 0.85rem;
		animation: fadeInUp 0.44s ease;
	}

	.welcome-composer-shell {
		width: min(100%, 760px);
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.welcome-hero {
		width: 100%;
		text-align: center;
	}

	.welcome-hero h2 {
		font-size: clamp(1.9rem, 3.6vw, 2.9rem);
		font-weight: 500;
		line-height: 1.08;
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
		padding: 0.72rem calc(1.2rem + env(safe-area-inset-right))
			calc(0.86rem + env(safe-area-inset-bottom)) calc(1.2rem + env(safe-area-inset-left));
		border-top: none;
		background: transparent;
		flex-shrink: 0;
	}

	.composer-shell {
		width: min(100%, 930px);
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0.78rem;
	}

	.composer-card {
		padding: 0.72rem 0.82rem 0.76rem;
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-xl);
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			background-color var(--transition-fast);
	}

	.composer-card:focus-within {
		border-color: color-mix(in srgb, var(--accent-primary) 58%, transparent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}

	.schema-review-card {
		padding: 0.78rem;
		border: 1px solid var(--border-medium);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		box-shadow: var(--shadow-sm);
	}

	.schema-review-card.collapsed {
		gap: 0;
	}

	.schema-review-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.72rem;
	}

	.schema-review-heading {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		min-width: 0;
	}

	.schema-review-header strong {
		font-family: var(--font-serif);
		font-weight: 600;
	}

	.schema-review-header-actions {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		margin-left: auto;
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

	.schema-review-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			color var(--transition-fast);
		flex-shrink: 0;
	}

	.schema-review-toggle:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
		color: var(--text-primary);
		background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-elevated));
	}

	.schema-review-chevron {
		transition: transform var(--transition-fast);
	}

	.schema-review-chevron.expanded {
		transform: rotate(180deg);
	}

	.input-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.65rem;
		margin-bottom: 0.64rem;
		padding: 0 0.08rem;
	}

	.schema-check-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.38rem 0.66rem;
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

	.schema-check-btn:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
		color: var(--text-primary);
		background: var(--bg-elevated);
	}

	.schema-check-btn.active {
		border-color: color-mix(in srgb, var(--accent-primary) 52%, transparent);
		color: var(--accent-primary);
		background: color-mix(in srgb, var(--accent-primary) 11%, var(--bg-card));
	}

	.schema-check-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.schema-check-title {
		white-space: nowrap;
	}

	.schema-check-indicator {
		--schema-dot-color: var(--error);
		width: 0.58rem;
		height: 0.58rem;
		border-radius: 999px;
		background: var(--schema-dot-color);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--schema-dot-color) 18%, transparent);
		animation: schemaDotPulse 1.6s ease-in-out infinite;
		flex-shrink: 0;
	}

	.schema-check-btn.active .schema-check-indicator {
		--schema-dot-color: #2ea66b;
	}

	.composer-model-select {
		min-width: 220px;
		max-width: 280px;
	}

	.input-container {
		display: flex;
		align-items: flex-end;
		gap: 0.72rem;
		background: transparent;
		border: none;
		border-radius: 0;
		padding: 0;
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
			padding: max(0px, env(safe-area-inset-top)) max(0px, env(safe-area-inset-right))
				max(0px, env(safe-area-inset-bottom)) max(0px, env(safe-area-inset-left));
			gap: 0;
		}

		.chat-main {
			border-radius: 0 0 var(--radius-xl) 0;
		}

		.chat-header {
			gap: 0.5rem;
		}

		.share-menu {
			right: 0;
		}
	}

	@media (max-width: 768px) {
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
			border-left: 1px solid var(--border-subtle);
		}

		.chat-header {
			padding: max(0px, env(safe-area-inset-top)) calc(0.76rem + env(safe-area-inset-right)) 0.38rem
				calc(0.76rem + env(safe-area-inset-left));
			min-height: calc(50px + env(safe-area-inset-top));
		}

		.header-title h1 {
			font-size: 1rem;
		}

		.messages-area {
			padding: 0.82rem calc(0.76rem + env(safe-area-inset-right)) 0.86rem
				calc(0.76rem + env(safe-area-inset-left));
		}

		.welcome-screen {
			padding: 1.1rem 0.35rem;
		}

		.welcome-composer-shell {
			gap: 0.82rem;
		}

		.welcome-hero h2 {
			font-size: 1.64rem;
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
			align-items: stretch;
			gap: 0.52rem;
		}

		.schema-review-header-actions {
			width: 100%;
			flex-direction: column-reverse;
			align-items: stretch;
			margin-left: 0;
			gap: 0.45rem;
		}

		.schema-review-toggle {
			align-self: flex-end;
		}

		.schema-actions,
		.schema-revision-actions {
			width: 100%;
			display: grid;
			grid-template-columns: 1fr;
			gap: 0.45rem;
		}

		.input-area {
			padding: 0.56rem calc(0.76rem + env(safe-area-inset-right))
				calc(0.72rem + env(safe-area-inset-bottom)) calc(0.76rem + env(safe-area-inset-left));
		}

		.composer-shell {
			gap: 0.62rem;
		}

		.composer-card {
			padding: 0.56rem 0.58rem 0.6rem;
			border-radius: var(--radius-lg);
		}

		.input-toolbar {
			gap: 0.5rem;
			margin-bottom: 0.5rem;
		}

		.schema-check-btn {
			flex: 1 1 100%;
			justify-content: space-between;
		}

		.composer-model-select {
			flex: 1 1 100%;
			max-width: none;
			width: 100%;
		}

		.composer-model-select .model-picker-menu {
			left: 0;
			right: 0;
			width: auto;
			max-width: none;
		}

		.input-container {
			gap: 0.52rem;
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

		.schema-check-btn {
			padding: 0.34rem 0.56rem;
		}

		.schema-check-title {
			font-size: 0.72rem;
		}

		.schema-check-indicator {
			width: 0.52rem;
			height: 0.52rem;
		}

		.share-menu {
			right: -0.15rem;
		}
	}

	@keyframes schemaDotPulse {
		0% {
			transform: scale(0.92);
			opacity: 0.74;
		}

		50% {
			transform: scale(1.08);
			opacity: 1;
		}

		100% {
			transform: scale(0.92);
			opacity: 0.74;
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
