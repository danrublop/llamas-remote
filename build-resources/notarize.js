// electron-builder afterSign hook: submit the signed mac app to Apple's notary service.
//
// This is a NO-OP unless APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID are present,
// so unsigned local/CI builds (no Apple Developer credentials) still succeed — they just
// aren't notarized. Add those three as GitHub Actions secrets to enable notarization; see
// RELEASING.md. Notarization is required for a hardened-runtime app to open without the
// Gatekeeper right-click-to-open dance, and for electron-updater to install updates.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization (unsigned build).');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] Submitting ${appName}.app to Apple notary service…`);
  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] Notarization complete.');
};
