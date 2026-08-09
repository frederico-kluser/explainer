#!/usr/bin/env node

/**
 * electron-builder `afterPack` hook — flips Electron Fuses on the packaged
 * binary to harden it against runtime tampering / debugging.
 *
 * Why afterPack: it runs AFTER the app is packed but BEFORE code signing, so
 * mutating the binary here keeps the eventual signature valid (on macOS we also
 * pass `resetAdHocDarwinSignature` so electron-builder re-signs cleanly).
 *
 * Fuses applied (all part of the DevTools / inspection lockdown):
 *   - EnableNodeCliInspectArguments=false   → blocks --inspect / --inspect-brk
 *   - EnableNodeOptionsEnvironmentVariable=false → blocks NODE_OPTIONS injection
 *   - RunAsNode=false                       → app can't be relaunched as plain Node
 *   - OnlyLoadAppFromAsar=true              → only run code from app.asar
 *   - EnableEmbeddedAsarIntegrityValidation=true → verify app.asar hash
 *
 * Native modules shipped via `asarUnpack` (node-llama-cpp, @nut-tree,
 * uiohook-napi, sharp, node-mac-permissions) still load normally — OnlyLoadApp
 * FromAsar only governs the app's JS, and unpacked .node files are referenced
 * from the asar. If a native module ever fails to load after enabling the ASAR
 * fuses, set ENABLE_ASAR_FUSES=0 to ship only the inspection fuses.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/fuses
 */

const path = require('path');
const fs = require('fs');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * Resolve the path to the Electron binary inside the packed output directory.
 * macOS: pass the `.app` bundle (@electron/fuses resolves the inner binary).
 * Windows/Linux: the executable name comes from electron-builder's
 * `executableName` (falling back to the product name).
 */
function resolveElectronBinary(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  const executableName =
    packager.platformSpecificBuildOptions.executableName || productFilename;

  if (electronPlatformName === 'darwin') {
    const candidate = path.join(appOutDir, `${productFilename}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }

  const candidates =
    electronPlatformName === 'win32'
      ? [`${executableName}.exe`, `${productFilename}.exe`]
      : [executableName, productFilename];

  for (const name of candidates) {
    const candidate = path.join(appOutDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `[flip-fuses] Could not find Electron binary in ${appOutDir} ` +
      `(tried: ${candidates.join(', ')})`
  );
}

module.exports = async function afterPack(context) {
  const electronBinaryPath = resolveElectronBinary(context);
  const isMac = context.electronPlatformName === 'darwin';
  const enableAsarFuses = process.env.ENABLE_ASAR_FUSES !== '0';

  console.log(`[flip-fuses] Hardening ${electronBinaryPath}`);

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    // Lock down debugging / alternate execution modes.
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    // ASAR integrity (can be disabled via ENABLE_ASAR_FUSES=0 if a native
    // module fails to load).
    [FuseV1Options.OnlyLoadAppFromAsar]: enableAsarFuses,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: enableAsarFuses,
    // Re-sign the macOS binary after mutating it so the signature stays valid.
    resetAdHocDarwinSignature: isMac
  });

  console.log('[flip-fuses] Fuses applied successfully');
};
