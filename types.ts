export type UltronView =
  | 'chat'
  | 'device-control'
  | 'tools'
  | 'file-analyzer'
  | 'coding-agent'
  | 'deep-research'
  | 'workspace'
  | 'memory'
  | 'web-browser'
  | 'agents';

export interface AttachedFile {
  name: string;
  type: string; // e.g. 'application/pdf', 'image/png', 'text/plain', etc.
  size: number;
  dataUrl?: string; // Base64 data URL for images and PDFs
  textContent?: string; // Extracted text content for TXT, MD, CSV, Code, DOCX
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachedImage?: string;
  attachedFile?: AttachedFile;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  searchSources?: Array<{ title: string; url: string }>;
  // Optional read-only fields preserved solely for compatibility with previously saved chat history
  generatedImageUrl?: string;
  imagePrompt?: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  mode: 'pro' | 'plus' | 'thinking';
  agentId?: string;
}

export interface GoogleUser {
  id: string;
  uid?: string;
  name: string;
  email: string;
  picture?: string;
  emailVerified?: boolean;
  providerId?: string;
}

export interface ToolCall {
  name: string;
  args: string;
}

export interface ToolResult {
  toolName: string;
  result: string;
  status: 'success' | 'error';
}

export interface ApiSettings {
  provider: 'gemini' | 'groq' | 'deepseek' | 'openai';
  apiKey: string;
  model: string;
  speechEnabled: boolean;
  autoInterrupt: boolean;
  responseMode: 'pro' | 'plus' | 'thinking';
  voiceLang: 'hi-IN' | 'en-US';
  speechRate: number; // 0.8, 1.0, 1.2
  speechPitch: number; // 0.45 - 0.58 for authoritative male Ultron voice
  searchEnabled: boolean;
  memoryEnabled: boolean;
  theme: 'dark' | 'light';
  wakeWordEnabled?: boolean;
  wakeWordPhrase?: string;
  backgroundListeningEnabled?: boolean;
}

export interface UserMemory {
  id: string;
  fact: string;
  category?: string;
  enabled?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface WorkspaceItem {
  id: string;
  type: 'note' | 'document' | 'task' | 'draft';
  folder: string;
  title: string;
  content: string;
  completed?: boolean;
  tags: string[];
  updatedAt: number;
}

export type AgentToolKey = 'web_search' | 'device_control' | 'code' | 'files' | 'writing';

export interface CustomAgent {
  id: string;
  name: string;
  avatar: string;
  description: string;
  instructions: string;
  model: string;
  responseStyle: 'balanced' | 'concise' | 'detailed' | 'creative' | 'technical';
  tools: AgentToolKey[];
  isDefault?: boolean;
  updatedAt: number;
}

export interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  extractedText: string;
  summary?: string;
  updatedAt: number;
}

export interface CodingFile {
  path: string;
  language: string;
  content: string;
}

export interface CodingProject {
  id: string;
  title: string;
  language: string;
  files: CodingFile[];
  summary: string;
  runInstructions?: string;
  updatedAt: number;
}

export type SubscriptionTier = 'free' | 'pro' | 'vip';

export interface SubscriptionInfo {
  plan: SubscriptionTier;
  billingCycle: 'monthly' | 'yearly';
  startDate?: string;
  expiryDate?: string;
  autoRenew: boolean;
}
