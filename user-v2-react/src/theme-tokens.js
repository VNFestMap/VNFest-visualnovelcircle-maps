/* ═══════════════════════════════════════════════════════════
   VNFest Theme Tokens
   Centralized design tokens matching CSS --seed-* variables.
   Used by Ant Design ConfigProvider for JS-side theming.
   ═══════════════════════════════════════════════════════════ */

import { theme as antTheme } from 'antd';

export const lightTokens = {
  primary: '#e74c3c',
  primaryDim: '#c0392b',
  bg: '#f5f5f5',
  surface: '#ffffff',
  surface2: '#f0f0f0',
  surface3: '#e8e8e8',
  text: '#1a1a1a',
  textBright: '#000000',
  muted: '#666666',
  soft: '#999999',
  border: 'rgba(0,0,0,0.06)',
  borderStrong: 'rgba(0,0,0,0.12)',
  amber: '#b87d1e',
  green: '#2d8f63',
  danger: '#c73545',
  overlay: 'rgba(0,0,0,0.03)',
  overlayHover: 'rgba(0,0,0,0.06)',
  avatarBg: '#e8e8e8',
  avatarFg: 'rgba(0,0,0,0.3)',
  inputBg: '#f5f5f5',
};

export const darkTokens = {
  primary: '#ff6b5c',
  primaryDim: '#e74c3c',
  bg: '#0f0f10',
  surface: '#1a1a1c',
  surface2: '#232325',
  surface3: '#2c2c2e',
  text: '#f0f0f0',
  textBright: '#ffffff',
  muted: '#9a9a9a',
  soft: '#6b7280',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  amber: '#e6ac52',
  green: '#57c089',
  danger: '#f05a68',
  overlay: 'rgba(255,255,255,0.04)',
  overlayHover: 'rgba(255,255,255,0.08)',
  avatarBg: '#2c2c2e',
  avatarFg: 'rgba(255,255,255,0.3)',
  inputBg: 'rgba(255,255,255,0.04)',
};

export const sharedTokens = {
  fontFamily: "'Jost', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif",
  fontSize: 14,
  borderRadius: 12,
  controlHeight: 38,
  tagRadius: 20,
  buttonRadius: 8,
  inputRadius: 8,
};

/**
 * Build Ant Design theme config for the given mode.
 * @param {boolean} isDark
 */
export function buildTheme(isDark) {
  const t = isDark ? darkTokens : lightTokens;
  const primaryRgb = isDark ? '255,107,92' : '231,76,60';

  return {
    token: {
      colorPrimary: t.primary,
      borderRadius: sharedTokens.borderRadius,
      fontFamily: sharedTokens.fontFamily,
      fontSize: sharedTokens.fontSize,
      colorBgContainer: t.surface,
      colorBgElevated: t.surface2,
      colorBgLayout: t.bg,
      colorBorder: t.border,
      colorBorderSecondary: t.border,
      colorText: t.text,
      colorTextSecondary: t.muted,
      colorTextTertiary: t.soft,
      colorSuccess: t.green,
      colorWarning: t.amber,
      colorError: t.danger,
      controlHeight: sharedTokens.controlHeight,
    },
    algorithm: isDark ? antTheme.darkAlgorithm : undefined,
    components: {
      Menu: {
        itemBg: 'transparent',
        itemSelectedBg: `rgba(${primaryRgb},0.08)`,
        itemSelectedColor: t.primary,
        itemHoverBg: t.overlay,
        itemHoverColor: t.text,
        itemBorderRadius: 10,
        itemColor: t.muted,
      },
      Card: {
        borderRadiusLG: sharedTokens.borderRadius,
        colorBgContainer: t.surface,
        colorBorderSecondary: t.border,
      },
      Button: {
        borderRadius: 9999,
        borderRadiusSM: 9999,
        borderRadiusLG: 9999,
        controlHeight: sharedTokens.controlHeight,
      },
      Input: {
        borderRadius: sharedTokens.inputRadius,
        colorBgContainer: t.inputBg,
        colorBorder: t.borderStrong,
        activeBorderColor: t.primary,
        hoverBorderColor: t.overlayHover,
      },
      Tag: { borderRadiusSM: sharedTokens.tagRadius },
      Progress: {
        defaultColor: t.primary,
        remainingColor: t.overlay,
      },
    },
  };
}
