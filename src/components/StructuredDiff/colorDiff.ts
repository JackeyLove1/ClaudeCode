import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

type NativeColorDiffModule = {
  ColorDiff?: unknown
  ColorFile?: unknown
  getSyntaxTheme?: (themeName: string) => SyntaxTheme | null
}

export type SyntaxTheme = Record<string, unknown>
export type ColorModuleUnavailableReason = 'env' | 'missing'

/* eslint-disable @typescript-eslint/no-require-imports */
const nativeModule: NativeColorDiffModule = (() => {
  try {
    return require('color-diff-napi') as NativeColorDiffModule
  } catch {
    return {}
  }
})()
/* eslint-enable @typescript-eslint/no-require-imports */

function hasNativeModule(): boolean {
  return (
    typeof nativeModule.ColorDiff !== 'undefined' &&
    typeof nativeModule.ColorFile !== 'undefined' &&
    typeof nativeModule.getSyntaxTheme === 'function'
  )
}

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return hasNativeModule() ? null : 'missing'
}

export function expectColorDiff(): unknown | null {
  return getColorModuleUnavailableReason() === null
    ? nativeModule.ColorDiff ?? null
    : null
}

export function expectColorFile(): unknown | null {
  return getColorModuleUnavailableReason() === null
    ? nativeModule.ColorFile ?? null
    : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? nativeModule.getSyntaxTheme?.(themeName) ?? null
    : null
}
