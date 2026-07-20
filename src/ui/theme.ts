/**
 * Theme System
 *
 * Color themes for terminal output. Supports dark, light, and system themes.
 */

import { ANSI, fgRGB } from '../utils/ansi.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type ThemeName = 'dark' | 'light' | 'system'

export interface ThemeColors {
  // Primary
  primary: string
  secondary: string
  accent: string

  // Text
  text: string
  textDim: string
  textBright: string
  textInverse: string

  // Status
  success: string
  warning: string
  error: string
  info: string

  // UI
  border: string
  borderDim: string
  background: string
  backgroundAlt: string

  // Syntax
  keyword: string
  string: string
  number: string
  comment: string
  function: string
  variable: string
  type: string
  operator: string

  // Special
  diffAdded: string
  diffRemoved: string
  diffContext: string
  highlight: string
  link: string
}

export interface Theme {
  name: ThemeName
  displayName: string
  isDark: boolean
  colors: ThemeColors
}

// ── Dark Theme ──────────────────────────────────────────────────────────────

export const DARK_THEME: Theme = {
  name: 'dark',
  displayName: 'Dark',
  isDark: true,
  colors: {
    primary: '#D77757',
    secondary: '#5769F7',
    accent: '#9B59B6',
    text: '#E0E0E0',
    textDim: '#888888',
    textBright: '#FFFFFF',
    textInverse: '#000000',
    success: '#4A7C59',
    warning: '#E8A035',
    error: '#E05555',
    info: '#5769F7',
    border: '#444444',
    borderDim: '#333333',
    background: '#1a1a2e',
    backgroundAlt: '#16213e',
    keyword: '#C678DD',
    string: '#98C379',
    number: '#D19A66',
    comment: '#7F848E',
    function: '#61AFEF',
    variable: '#E06C75',
    type: '#E5C07B',
    operator: '#56B6C2',
    diffAdded: '#98C379',
    diffRemoved: '#E06C75',
    diffContext: '#7F848E',
    highlight: '#D77757',
    link: '#61AFEF',
  },
}

// ── Light Theme ─────────────────────────────────────────────────────────────

export const LIGHT_THEME: Theme = {
  name: 'light',
  displayName: 'Light',
  isDark: false,
  colors: {
    primary: '#D77757',
    secondary: '#5769F7',
    accent: '#9B59B6',
    text: '#333333',
    textDim: '#888888',
    textBright: '#000000',
    textInverse: '#FFFFFF',
    success: '#4A7C59',
    warning: '#E8A035',
    error: '#E05555',
    info: '#5769F7',
    border: '#CCCCCC',
    borderDim: '#DDDDDD',
    background: '#FFFFFF',
    backgroundAlt: '#F5F5F5',
    keyword: '#A626A4',
    string: '#50A14F',
    number: '#C18401',
    comment: '#A0A1A7',
    function: '#4078F2',
    variable: '#E45649',
    type: '#C18401',
    operator: '#0184BC',
    diffAdded: '#50A14F',
    diffRemoved: '#E45649',
    diffContext: '#A0A1A7',
    highlight: '#D77757',
    link: '#4078F2',
  },
}

// ── Theme Registry ──────────────────────────────────────────────────────────

export const THEMES: Record<string, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
}

let activeTheme: Theme = DARK_THEME

export function getTheme(name?: ThemeName): Theme {
  if (!name) return activeTheme
  if (name === 'system') {
    return shouldUseDark() ? DARK_THEME : LIGHT_THEME
  }
  return THEMES[name] ?? DARK_THEME
}

export function setTheme(name: ThemeName): Theme {
  activeTheme = getTheme(name)
  return activeTheme
}

export function getActiveTheme(): Theme {
  return activeTheme
}

export function listThemes(): Theme[] {
  return Object.values(THEMES)
}

function shouldUseDark(): boolean {
  // In a real terminal, we'd check the background color
  // For now, default to dark
  return true
}

// ── Color Helpers ───────────────────────────────────────────────────────────

export function color(text: string, hex: string): string {
  return fgRGB(hex) + text + ANSI.RESET
}

export function withThemeColor(text: string, colorKey: keyof ThemeColors): string {
  const theme = getActiveTheme()
  return color(text, theme.colors[colorKey])
}

// ── Convenience ─────────────────────────────────────────────────────────────

export function primary(text: string): string { return withThemeColor(text, 'primary') }
export function secondary(text: string): string { return withThemeColor(text, 'secondary') }
export function success(text: string): string { return withThemeColor(text, 'success') }
export function warning(text: string): string { return withThemeColor(text, 'warning') }
export function error(text: string): string { return withThemeColor(text, 'error') }
export function info(text: string): string { return withThemeColor(text, 'info') }
export function dim(text: string): string { return withThemeColor(text, 'textDim') }
export function bright(text: string): string { return withThemeColor(text, 'textBright') }
