/**
 * Types for the explainer Electron APIs exposed to the renderer (window.api).
 *
 * The authoritative Window augmentation lives in frontend/src/types/electron.d.ts
 * (it is what the renderer code imports). This file only re-declares the shape
 * so the preload script itself type-checks against the same contract.
 *
 * Keep in sync with frontend/src/types/electron.d.ts.
 */

// Re-use the same types the frontend declares; if the frontend file isn't
// visible to the node tsconfig, the inline versions below serve as fallbacks.

interface AppSettings {
  version: number;
  apiKeys: {
    openai: { key: string; validationStatus: 'idle' | 'valid' | 'invalid' };
    openaiAdmin: { key: string; validationStatus: 'idle' | 'valid' | 'invalid' };
    openrouter?: { key: string; validationStatus: 'idle' | 'valid' | 'invalid' };
    deepseek?: { key: string; validationStatus: 'idle' | 'valid' | 'invalid' };
  };
  language: 'pt-BR' | 'en';
  theme: 'light' | 'dark' | 'system';
  updatedAt: number;
}

interface ElectronAPI {
  settings: {
    get: () => Promise<{ success: boolean; data?: AppSettings; error?: string }>;
    saveApiKey: (key: string, provider?: string) => Promise<{ success: boolean; error?: string }>;
    removeApiKey: (provider?: string) => Promise<{ success: boolean; error?: string }>;
    validateApiKey: (
      key: string,
      provider?: string
    ) => Promise<{ success: boolean; data?: { valid: boolean; error?: string }; error?: string }>;
    set: (patch: Record<string, unknown>) => Promise<{ success: boolean; data?: AppSettings; error?: string }>;
  };
  app: {
    platform: string;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  isElectron: boolean;
}

// NOTE: the global Window augmentation is intentionally NOT repeated here.
// frontend/src/types/electron.d.ts owns it; two ambient declarations of the
// same member would produce a TS2717 merge error.
