import { z } from 'zod';
import { getAdminStore } from '../db/admin-store.js';
import type { RetrievalProfile } from './admin-platform-config.js';

const CHAT_PROFILE_AREA = 'chat-profiles';
const CHAT_MANAGEMENT_CONFIG_AREA = 'chat-management-config';
const DEFAULT_KEY = 'default';

export type PromptHistoryScope = 'current_session' | 'current_user_active_sessions';
export type RetrievalHistoryMode = 'current_message' | 'current_session_questions' | 'current_session_questions_and_answers';

export interface ChatProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  defaultForChat: boolean;
  experimental: boolean;
  promptHistoryScope: PromptHistoryScope;
  promptHistoryTurns: number;
  retrievalHistoryMode: RetrievalHistoryMode;
  retrievalHistoryTurns: number;
  maxPromptHistoryChars: number;
  maxRetrievalHistoryChars: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatManagementConfig {
  defaultChatProfileId: string;
}

export interface ChatProfileSummary {
  id: string;
  name: string;
  promptHistoryScope: PromptHistoryScope;
  promptHistoryTurns: number;
  retrievalHistoryMode: RetrievalHistoryMode;
  retrievalHistoryTurns: number;
  experimental: boolean;
}

export interface ChatProfileStatus {
  values: ChatManagementConfig;
  selectedProfile?: ChatProfile;
  chatProfiles: ChatProfile[];
}

const idSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/);

const chatProfileInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  defaultForChat: z.boolean().optional(),
  experimental: z.boolean().optional(),
  promptHistoryScope: z.enum(['current_session', 'current_user_active_sessions']).optional(),
  promptHistoryTurns: z.number().int().min(0).max(20).optional(),
  retrievalHistoryMode: z.enum(['current_message', 'current_session_questions', 'current_session_questions_and_answers']).optional(),
  retrievalHistoryTurns: z.number().int().min(0).max(12).optional(),
  maxPromptHistoryChars: z.number().int().min(0).max(80000).optional(),
  maxRetrievalHistoryChars: z.number().int().min(0).max(12000).optional(),
}).strict();

const chatManagementConfigSchema = z.object({
  defaultChatProfileId: idSchema,
}).strict();

function nowIso(): string {
  return new Date().toISOString();
}

function chatProfileIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || `chat_profile_${Date.now()}`;
}

function summarizeChatProfile(profile: ChatProfile): ChatProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    promptHistoryScope: profile.promptHistoryScope,
    promptHistoryTurns: profile.promptHistoryTurns,
    retrievalHistoryMode: profile.retrievalHistoryMode,
    retrievalHistoryTurns: profile.retrievalHistoryTurns,
    experimental: profile.experimental,
  };
}

function normalizeChatProfile(profile: ChatProfile): ChatProfile {
  return {
    ...profile,
    description: profile.description ?? '',
    enabled: profile.enabled !== false,
    defaultForChat: Boolean(profile.defaultForChat),
    experimental: Boolean(profile.experimental),
    promptHistoryScope: profile.promptHistoryScope ?? 'current_session',
    promptHistoryTurns: Math.max(0, Math.min(Number(profile.promptHistoryTurns ?? 4), 20)),
    retrievalHistoryMode: profile.retrievalHistoryMode ?? 'current_message',
    retrievalHistoryTurns: Math.max(0, Math.min(Number(profile.retrievalHistoryTurns ?? 4), 12)),
    maxPromptHistoryChars: Math.max(0, Math.min(Number(profile.maxPromptHistoryChars ?? 12000), 80000)),
    maxRetrievalHistoryChars: Math.max(0, Math.min(Number(profile.maxRetrievalHistoryChars ?? 1200), 12000)),
  };
}

export function getDefaultChatProfiles(): ChatProfile[] {
  const now = nowIso();
  const base = (
    id: string,
    name: string,
    description: string,
    patch: Partial<ChatProfile>
  ): ChatProfile => normalizeChatProfile({
    id,
    name,
    description,
    enabled: true,
    defaultForChat: false,
    experimental: false,
    promptHistoryScope: 'current_session',
    promptHistoryTurns: 4,
    retrievalHistoryMode: 'current_message',
    retrievalHistoryTurns: 4,
    maxPromptHistoryChars: 12000,
    maxRetrievalHistoryChars: 1200,
    createdAt: now,
    updatedAt: now,
    ...patch,
  });

  return [
    base(
      'chat_current_session',
      'Current session prompt',
      'Use the current chat session in the LLM prompt; retrieval searches only the current user message.',
      { defaultForChat: true }
    ),
    base(
      'chat_followup_questions',
      'Follow-up questions',
      'Use the current chat session in the prompt and add recent user questions from this session to the retrieval query.',
      { retrievalHistoryMode: 'current_session_questions' }
    ),
    base(
      'chat_followup_full',
      'Follow-up questions and answers',
      'Use the current chat session in the prompt and add recent user questions and assistant answers to the retrieval query.',
      { retrievalHistoryMode: 'current_session_questions_and_answers' }
    ),
    base(
      'chat_active_sessions_prompt_experimental',
      'Active sessions prompt',
      'Experimental: add recent active sessions of the same user to the LLM prompt; retrieval still searches only the current message.',
      {
        enabled: false,
        experimental: true,
        promptHistoryScope: 'current_user_active_sessions',
        promptHistoryTurns: 8,
        retrievalHistoryMode: 'current_message',
        maxPromptHistoryChars: 24000,
      }
    ),
  ];
}

export const DEFAULT_CHAT_MANAGEMENT_CONFIG: ChatManagementConfig = {
  defaultChatProfileId: 'chat_current_session',
};

export async function getChatProfiles(): Promise<ChatProfile[]> {
  const stored = await getAdminStore().getJson<ChatProfile[]>(CHAT_PROFILE_AREA, DEFAULT_KEY);
  const defaults = getDefaultChatProfiles();
  if (!stored || stored.length === 0) return defaults;

  const normalizedStored = stored.map(normalizeChatProfile);
  const storedIds = new Set(normalizedStored.map((profile) => profile.id));
  const missingDefaults = defaults.filter((profile) => !storedIds.has(profile.id));
  return [...normalizedStored, ...missingDefaults];
}

export async function getChatManagementConfig(): Promise<ChatManagementConfig> {
  const stored = await getAdminStore().getJson<Partial<ChatManagementConfig>>(CHAT_MANAGEMENT_CONFIG_AREA, DEFAULT_KEY);
  const parsed = chatManagementConfigSchema.parse({
    ...DEFAULT_CHAT_MANAGEMENT_CONFIG,
    ...(stored ?? {}),
  });
  const profiles = await getChatProfiles();
  if (!profiles.some((profile) => profile.id === parsed.defaultChatProfileId && profile.enabled)) {
    return DEFAULT_CHAT_MANAGEMENT_CONFIG;
  }
  return parsed;
}

export async function getChatProfileStatus(): Promise<ChatProfileStatus> {
  const [values, chatProfiles] = await Promise.all([
    getChatManagementConfig(),
    getChatProfiles(),
  ]);
  return {
    values,
    selectedProfile: chatProfiles.find((profile) => profile.id === values.defaultChatProfileId),
    chatProfiles,
  };
}

export async function setChatManagementConfig(input: unknown, actor?: string): Promise<ChatManagementConfig> {
  const parsed = chatManagementConfigSchema.parse(input);
  const profiles = await getChatProfiles();
  if (!profiles.some((profile) => profile.id === parsed.defaultChatProfileId && profile.enabled)) {
    throw new Error(`Chat profile not found or disabled: ${parsed.defaultChatProfileId}`);
  }
  await getAdminStore().setJson(CHAT_MANAGEMENT_CONFIG_AREA, DEFAULT_KEY, parsed, {
    actor,
    action: 'chat-management.config.update',
    entityType: 'chat-management',
  });
  return parsed;
}

export async function upsertChatProfile(input: unknown, actor?: string): Promise<ChatProfile> {
  const parsed = chatProfileInputSchema.parse(input);
  const profiles = await getChatProfiles();
  const now = nowIso();
  const id = parsed.id ?? chatProfileIdFromName(parsed.name);
  const existing = profiles.find((profile) => profile.id === id);
  const profile = normalizeChatProfile({
    id,
    name: parsed.name,
    description: parsed.description ?? existing?.description ?? '',
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    defaultForChat: parsed.defaultForChat ?? existing?.defaultForChat ?? false,
    experimental: parsed.experimental ?? existing?.experimental ?? false,
    promptHistoryScope: parsed.promptHistoryScope ?? existing?.promptHistoryScope ?? 'current_session',
    promptHistoryTurns: parsed.promptHistoryTurns ?? existing?.promptHistoryTurns ?? 4,
    retrievalHistoryMode: parsed.retrievalHistoryMode ?? existing?.retrievalHistoryMode ?? 'current_message',
    retrievalHistoryTurns: parsed.retrievalHistoryTurns ?? existing?.retrievalHistoryTurns ?? 4,
    maxPromptHistoryChars: parsed.maxPromptHistoryChars ?? existing?.maxPromptHistoryChars ?? 12000,
    maxRetrievalHistoryChars: parsed.maxRetrievalHistoryChars ?? existing?.maxRetrievalHistoryChars ?? 1200,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  const updatedProfiles = [
    ...profiles.filter((item) => item.id !== id).map((item) => ({
      ...item,
      defaultForChat: profile.defaultForChat ? false : item.defaultForChat,
    })),
    profile,
  ].sort((a, b) => a.name.localeCompare(b.name));

  await getAdminStore().setJson(CHAT_PROFILE_AREA, DEFAULT_KEY, updatedProfiles, {
    actor,
    action: existing ? 'chat-profile.update' : 'chat-profile.create',
    entityType: CHAT_PROFILE_AREA,
  });

  if (profile.defaultForChat && profile.enabled) {
    await setChatManagementConfig({ defaultChatProfileId: profile.id }, actor);
  }
  return profile;
}

export async function restoreDefaultChatProfiles(actor?: string): Promise<ChatProfile[]> {
  const defaults = getDefaultChatProfiles();
  await getAdminStore().setJson(CHAT_PROFILE_AREA, DEFAULT_KEY, defaults, {
    actor,
    action: 'chat-profile.restore-defaults',
    entityType: CHAT_PROFILE_AREA,
  });
  await setChatManagementConfig(DEFAULT_CHAT_MANAGEMENT_CONFIG, actor);
  return defaults;
}

export function legacyChatProfileIdForRetrievalProfile(profile: RetrievalProfile | undefined): string | undefined {
  if (!profile) return undefined;
  if (profile.chatProfileId) return profile.chatProfileId;
  return profile.config.chatRetrievalQueryMode === 'history_augmented'
    ? 'chat_followup_full'
    : undefined;
}

export async function resolveChatProfileForRetrievalProfile(
  profile: RetrievalProfile | undefined
): Promise<ChatProfile> {
  const [profiles, managementConfig] = await Promise.all([
    getChatProfiles(),
    getChatManagementConfig(),
  ]);
  const requestedId = legacyChatProfileIdForRetrievalProfile(profile) ?? managementConfig.defaultChatProfileId;
  const requested = profiles.find((item) => item.id === requestedId && item.enabled);
  const fallback = profiles.find((item) => item.id === managementConfig.defaultChatProfileId && item.enabled)
    ?? profiles.find((item) => item.id === DEFAULT_CHAT_MANAGEMENT_CONFIG.defaultChatProfileId)
    ?? getDefaultChatProfiles()[0];
  return requested ?? fallback;
}

export async function summarizeChatProfileForRetrievalProfile(
  profile: RetrievalProfile
): Promise<ChatProfileSummary | undefined> {
  const profiles = await getChatProfiles();
  const id = legacyChatProfileIdForRetrievalProfile(profile) ?? (await getChatManagementConfig()).defaultChatProfileId;
  const chatProfile = profiles.find((item) => item.id === id);
  return chatProfile ? summarizeChatProfile(chatProfile) : undefined;
}
