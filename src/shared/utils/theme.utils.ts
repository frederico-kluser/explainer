/**
 * PURE theme utilities — shared between main and renderers.
 *
 * This is where the `mode → effective theme` resolution and, most importantly,
 * the WINDOW BACKGROUND COLOR per theme live.
 *
 * Why the color lives here: the `backgroundColor` of the BrowserWindow must
 * match the CSS background of the app exactly, otherwise there is a flash of
 * the wrong color before React mounts. With two themes that stopped being a
 * constant and became a pair, so both colors live in a single module.
 *
 * @module shared/utils/theme.utils
 */

import type { AppThemeMode, ResolvedTheme } from '../types/theme.types';

/** Accepted modes (single source — the Zod boundary and the store normalize read from here). */
export const APP_THEME_MODES: readonly AppThemeMode[] = ['system', 'light', 'dark'];

/** Default mode for a fresh install: follow the operating system. */
export const DEFAULT_THEME_MODE: AppThemeMode = 'system';

/**
 * Background of the overlay-window style per theme (kept from the quiet-que
 * module for parity — the explainer currently has no overlay window).
 */
export const OVERLAY_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#16181d',
  light: '#ffffff'
};

/**
 * Background of the MAIN window per theme (the BrowserWindow `backgroundColor`
 * exists so there is no white/black flash before React mounts). Must match the
 * app's surface color.
 */
export const APP_WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0e0f13',
  light: '#f6f7f9'
};

/** True if the value is a valid theme mode (boundary guard). */
export function isAppThemeMode(value: unknown): value is AppThemeMode {
  return typeof value === 'string' && (APP_THEME_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the effective theme. 'system' delegates to the OS
 * (`systemPrefersDark`); 'light'/'dark' are explicit and ignore the OS.
 */
export function resolveTheme(mode: AppThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

/** Overlay-window background for an already resolved theme. */
export function overlayBackgroundFor(resolved: ResolvedTheme): string {
  return OVERLAY_BACKGROUND[resolved];
}

/** Main-window background for an already resolved theme. */
export function appWindowBackgroundFor(resolved: ResolvedTheme): string {
  return APP_WINDOW_BACKGROUND[resolved];
}
