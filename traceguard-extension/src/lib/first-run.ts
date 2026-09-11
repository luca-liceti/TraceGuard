/**
 * =============================================================================
 * FIRST-RUN REDIRECT
 * =============================================================================
 *
 * On a fresh install the vault (master password) hasn't been created yet.
 * Instead of squeezing the account-creation form into a small surface (the
 * 360px popup or the side panel), the extension opens the full dashboard tab,
 * which shows the "Secure Your Vault" page, so the user creates their account
 * there.
 *
 * Both the popup and the side panel share this check: they are the two
 * surfaces that open when the user clicks the toolbar icon.
 * =============================================================================
 */

/**
 * Checks whether the vault exists (same check AuthProvider uses: no
 * `cryptoSalt`/`validator` in storage means no vault yet). When it does not
 * exist, opens the dashboard tab hosting the account-creation page.
 *
 * @returns true when the user was redirected (first run, no vault yet).
 */
export async function redirectToDashboardIfFirstRun(): Promise<boolean> {
    const local = await chrome.storage.local.get(['cryptoSalt', 'validator']);
    if (local.cryptoSalt && local.validator) return false;
    const dashboardUrl = chrome.runtime.getURL('src/dashboard/index.html');
    // Reuse an already-open dashboard tab instead of stacking a new one on
    // every toolbar click while the vault hasn't been created yet.
    const existing = await chrome.tabs.query({ url: `${dashboardUrl}*` });
    if (existing.length > 0 && existing[0].id !== undefined) {
        await chrome.tabs.update(existing[0].id, { active: true });
        if (existing[0].windowId !== undefined) {
            await chrome.windows.update(existing[0].windowId, { focused: true });
        }
    } else {
        await chrome.tabs.create({ url: dashboardUrl });
    }
    return true;
}
