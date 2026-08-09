/**
 * Theme contract (dark/light) — main ↔ preload ↔ renderer.
 *
 * The mode is a PERSISTED preference (`AppSettings.theme`); the RESOLVED theme
 * is what the UI actually paints. Only the main process can resolve 'system'
 * (via `nativeTheme.shouldUseDarkColors`), so the renderer never reads
 * `prefers-color-scheme` on its own.
 *
 * @module shared/types/theme.types
 */

/** User preference: follow the OS, or force light/dark. */
export type AppThemeMode = 'light' | 'dark' | 'system';

/** Theme actually applied (what the UI paints). Never 'system'. */
export type ResolvedTheme = 'light' | 'dark';
