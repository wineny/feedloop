// AG Studio theme for Refund Studio — every UI value points at Feedloop's own tokens (globals.css), so Studio
// reads as part of the app: white cards on the 2%-off canvas, hairline borders, coral accent.
// Chart colours are hex, not CSS variables: charts draw on canvas and are not guaranteed to re-read variables.

import { studioTheme } from 'ag-studio';

const v = (name: string) => `var(--${name})`;
const line = (name: string) => ({ width: 1, color: v(name) });

/** Coral first (the brand), then calm neutrals and status colours — 10 slots, the chart palette size. */
export const STUDIO_CHART_COLORS = [
  // Series take colours in label order: Bug / UX, Feature request, Not classified yet, Other.
  '#D13A2D', // primary-600 — Bug / UX
  '#3F4A5A', // slate — Feature request
  '#F6A7A4', // primary-300 — Not classified yet
  '#A39D9B', // faint — Other
  '#d97706', // warning-600
  '#16a34a', // success-600
  '#2563eb', // info
  '#9E291F', // primary-700
  '#6E6968', // muted-foreground
  '#fbbf24', // warning-400
];

const palette = Object.fromEntries(
  STUDIO_CHART_COLORS.flatMap((color, i) => [
    [`chartPaletteFills${i + 1}Color`, color],
    [`chartPaletteStrokes${i + 1}Color`, color],
  ]),
);

export const feedloopStudioTheme = studioTheme.withParams({
  fontFamily: v('font-family-sans'),
  fontSize: 14,
  textColor: v('foreground'),
  foregroundColor: v('foreground'),
  subtleTextColor: v('muted-foreground'),
  backgroundColor: v('card'),
  borderColor: v('border'),
  accentColor: v('primary'),
  iconColor: v('muted-foreground'),
  rowHoverColor: v('muted'),

  // The canvas is the page's own background; widgets are the app's cards.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: v('canvas'),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: v('canvas'),
  studioCanvasPadding: 16,
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: v('font-family-sans'),

  studioWidgetBackgroundColor: v('card'),
  studioWidgetBorder: line('border'),
  studioWidgetBorderRadius: 16,
  studioWidgetPadding: 12,
  studioWidgetTitleFontFamily: v('font-family-sans'),
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: v('foreground'),
  studioWidgetSubtitleFontFamily: v('font-family-sans'),
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: v('muted-foreground'),
  studioWidgetCaptionFontFamily: v('font-family-sans'),
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: v('muted-foreground'),
  studioWidgetResizeBorderColor: v('primary'),

  studioPanelContainerBackgroundColor: v('card'),
  studioPanelContainerBorder: line('border'),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: v('border'),
  studioPanelDividerActiveColor: v('primary'),
  studioPanelSectionBorderColor: v('border'),
  studioPanelHeaderFontFamily: v('font-family-sans'),
  studioPanelHeaderFontWeight: 600,
  studioPanelChevronButtonHoverBackgroundColor: v('primary-tint'),
  studioPanelChevronButtonHoverColor: v('primary'),
  studioToggleButtonActiveBackgroundColor: v('primary-tint'),
  studioToggleButtonActiveBorderColor: v('primary'),
  studioToggleButtonActiveColor: v('primary'),

  gridFontFamily: v('font-family-sans'),
  gridFontSize: 13,
  gridCellTextColor: v('foreground'),
  gridHeaderBackgroundColor: v('muted'),
  gridHeaderTextColor: v('muted-foreground'),
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 12,
  gridRowHeight: 38,
  gridRowBorder: line('border'),
  gridHeaderRowBorder: line('border'),
  gridPinnedRowBorder: line('border'),
  gridRowHoverColor: v('muted'),
  gridWrapperBorder: false,

  chartFontFamily: v('font-family-sans'),
  chartTextColor: v('foreground'),
  chartSubtleTextColor: v('muted-foreground'),
  chartAxisLineColor: v('border'),
  chartGridLineColor: v('border'),
  ...palette,
});
