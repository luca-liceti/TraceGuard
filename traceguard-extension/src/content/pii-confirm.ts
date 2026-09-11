/**
 * =============================================================================
 * PII CONFIRMATION CARD - "Is this website safe?" popup
 * =============================================================================
 *
 * When the background worker penalizes PII entry on an *outlier* site (risky
 * WSS, unnecessary data ask, not blacklisted), it asks the user to vouch for
 * the site: a small card in the top-right corner of the page asks whether the
 * site is safe and offers to add it to the allow list.
 *
 * If the user confirms, the domain is added to their whitelist via the
 * background worker, which exempts future PII entries there.
 *
 * PRIVACY: The card only displays the domain and field type - no typed values.
 *
 * STYLING:
 * The card is rendered in a shadow root so the host page's CSS cannot affect
 * it. The colors mirror the dashboard's shadcn theme tokens (globals.css) for
 * both light and dark, and the user's theme preference (light / dark / system)
 * is resolved from extension settings - so the popup looks like a native part
 * of the dashboard in either mode.
 * =============================================================================
 */

import { logEvent } from '../lib/diagnostics';

export interface PIIConfirmData {
    domain: string;
    fieldType: string;
    reason: 'risky' | 'unnecessary' | string;
    message: string;
    siteWSS: number;
    /**
     * Pre-translated strings (localized in the background worker, which
     * already has i18n loaded). Falls back to English when absent so the
     * content script never needs the i18n bundle on every page.
     */
    texts?: {
        title: string;
        dismissLabel: string;
        bodyPrefix: string;
        bodySuffix: string;
        confirm: string;
        notSure: string;
        note: string;
        added: string;
        addedNote: string;
    };
}

const HOST_ID = 'traceguard-pii-confirm-host';

// ---------------------------------------------------------------------------
// THEME - mirrors the shadcn tokens in src/styles/globals.css
// ---------------------------------------------------------------------------

type ThemeName = 'light' | 'dark';

interface ThemePalette {
    cardBg: string;
    cardFg: string;
    border: string;
    mutedBg: string;
    mutedFg: string;
    primaryBg: string;
    primaryFg: string;
    warning: string;
    shadow: string;
}

const PALETTES: Record<ThemeName, ThemePalette> = {
    // :root tokens (globals.css)
    light: {
        cardBg: 'oklch(1 0 0)',
        cardFg: 'oklch(0.145 0 0)',
        border: 'oklch(0.922 0 0)',
        mutedBg: 'oklch(0.97 0 0)',
        mutedFg: 'oklch(0.556 0 0)',
        primaryBg: 'oklch(0.205 0 0)',
        primaryFg: 'oklch(0.985 0 0)',
        warning: 'oklch(0.795 0.184 86.047)', // --warning
        shadow: '0 4px 16px rgba(0, 0, 0, 0.1)',
    },
    // .dark tokens (globals.css)
    dark: {
        cardBg: 'oklch(0.205 0 0)',
        cardFg: 'oklch(0.985 0 0)',
        border: 'oklch(1 0 0 / 10%)',
        mutedBg: 'oklch(0.269 0 0)',
        mutedFg: 'oklch(0.708 0 0)',
        primaryBg: 'oklch(0.922 0 0)',
        primaryFg: 'oklch(0.205 0 0)',
        warning: 'oklch(0.852 0.199 91.936)', // --warning
        shadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
    },
};

/**
 * Resolves the active theme the same way the dashboard does: the user's
 * `settings.theme` (light | dark | system), with `system` following the OS
 * `prefers-color-scheme` preference. Falls back to the OS preference when
 * settings can't be read.
 */
async function resolveTheme(): Promise<ThemeName> {
    const prefersDark = () => {
        try {
            return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
            return false;
        }
    };
    try {
        const { settings } = await chrome.storage.local.get('settings') as { settings?: { theme?: string } };
        const theme = settings?.theme || 'system';
        if (theme === 'light') return 'light';
        if (theme === 'dark') return 'dark';
    } catch {
        // fall through to OS preference
    }
    return prefersDark() ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// CARD
// ---------------------------------------------------------------------------

function buildCard(data: PIIConfirmData, theme: ThemeName): HTMLElement {
    const p = PALETTES[theme];
    const host = document.createElement('div');
    host.id = HOST_ID;

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        :host { all: initial; }
        .tg-card {
            position: fixed;
            top: 16px;
            right: 16px;
            z-index: 2147483647;
            width: 340px;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: ${p.cardBg};
            color: ${p.cardFg};
            border: 1px solid ${p.border};
            border-radius: 0.625rem;
            box-shadow: ${p.shadow};
            padding: 14px 16px;
            animation: tg-slide-in 0.18s ease-out;
        }
        @keyframes tg-slide-in {
            from { transform: translateX(16px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        .tg-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 8px;
        }
        .tg-title-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .tg-title {
            font-size: 14px;
            font-weight: 600;
            margin: 0;
            line-height: 1.3;
        }
        .tg-close {
            background: none;
            border: none;
            color: ${p.mutedFg};
            font-size: 16px;
            line-height: 1;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 0.375rem;
        }
        .tg-close:hover {
            color: ${p.cardFg};
            background: ${p.mutedBg};
        }
        .tg-body {
            font-size: 13px;
            line-height: 1.45;
            color: ${p.mutedFg};
            margin: 8px 0 12px;
        }
        .tg-domain {
            font-weight: 600;
            color: ${p.cardFg};
            word-break: break-all;
        }
        .tg-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
        .tg-btn {
            font-size: 12.5px;
            font-weight: 500;
            border: 1px solid transparent;
            border-radius: 0.5rem;
            padding: 7px 12px;
            cursor: pointer;
            transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
        }
        .tg-btn:disabled { opacity: 0.6; cursor: default; }
        .tg-btn-primary {
            background: ${p.primaryBg};
            color: ${p.primaryFg};
        }
        .tg-btn-primary:hover:not(:disabled) { opacity: 0.9; }
        .tg-btn-secondary {
            background: transparent;
            color: ${p.cardFg};
            border-color: ${p.border};
        }
        .tg-btn-secondary:hover:not(:disabled) { background: ${p.mutedBg}; }
        .tg-note {
            font-size: 11.5px;
            color: ${p.mutedFg};
            margin: 10px 0 0;
            line-height: 1.4;
        }
    `;

    // Inline warning icon (triangle), colored with the theme's --warning token.
    const NS = 'http://www.w3.org/2000/svg';
    const warningIcon = document.createElementNS(NS, 'svg');
    warningIcon.setAttribute('width', '16');
    warningIcon.setAttribute('height', '16');
    warningIcon.setAttribute('viewBox', '0 0 24 24');
    warningIcon.setAttribute('fill', 'none');
    warningIcon.setAttribute('stroke', p.warning);
    warningIcon.setAttribute('stroke-width', '2');
    warningIcon.setAttribute('stroke-linecap', 'round');
    warningIcon.setAttribute('stroke-linejoin', 'round');
    warningIcon.setAttribute('aria-hidden', 'true');
    warningIcon.style.flexShrink = '0';
    warningIcon.style.marginTop = '1px';
    const path1 = document.createElementNS(NS, 'path');
    path1.setAttribute('d', 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z');
    const path2 = document.createElementNS(NS, 'path');
    path2.setAttribute('d', 'M12 9v4');
    const path3 = document.createElementNS(NS, 'path');
    path3.setAttribute('d', 'M12 17h.01');
    warningIcon.append(path1, path2, path3);

    const card = document.createElement('div');
    card.className = 'tg-card';
    card.setAttribute('role', 'alert');

    const header = document.createElement('div');
    header.className = 'tg-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'tg-title-row';

    const text = data.texts ?? {
        title: 'Is this website safe?',
        dismissLabel: 'Dismiss',
        bodyPrefix: 'TraceGuard detected personal info (',
        bodySuffix: ') and this site doesn\u2019t meet our security checks. Make sure it\u2019s the real site before entering anything.',
        confirm: 'It\u2019s safe - add to allow list',
        notSure: 'Not sure',
        note: 'If this is the real site, confirm to skip the penalty and add it to your allow list. Check the address bar carefully - lookalike domains are a common trick.',
        added: '\u2713 Added',
        addedNote: '{{domain}} was added to your allow list. TraceGuard won\u2019t penalize personal info here anymore.',
    };

    const title = document.createElement('p');
    title.className = 'tg-title';
    title.textContent = text.title;

    titleRow.append(warningIcon, title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tg-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', text.dismissLabel);

    header.append(titleRow, closeBtn);

    const body = document.createElement('p');
    body.className = 'tg-body';
    body.append(
        text.bodyPrefix + data.fieldType,
        ' ',
        (() => { const s = document.createElement('span'); s.className = 'tg-domain'; s.textContent = data.domain; return s; })(),
        ' ',
        text.bodySuffix
    );

    const actions = document.createElement('div');
    actions.className = 'tg-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'tg-btn tg-btn-primary';
    confirmBtn.textContent = text.confirm;

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'tg-btn tg-btn-secondary';
    dismissBtn.textContent = text.notSure;

    actions.append(confirmBtn, dismissBtn);

    const note = document.createElement('p');
    note.className = 'tg-note';
    note.textContent = text.note;

    card.append(header, body, actions, note);

    shadow.append(style, card);

    // --- Wire up the actions -------------------------------------------------

    // Tell the background worker how the user answered the card. The penalty
    // decision (exempt vs. penalize) is made once this response is received:
    // confirming vouches for the site, dismissing leaves the entry penalized.
    const notifyBackground = (safe: boolean) => {
        try {
            chrome.runtime.sendMessage({
                type: 'PII_CONFIRM_RESULT',
                domain: data.domain,
                safe,
            }).catch((error) => {
                // The background may be unavailable (e.g. during unload); its
                // confirmation timeout then falls back to penalizing. Expected,
                // so record it as a session warning rather than a bug.
                logEvent('pii', 'warn', 'pii_confirm_result_undeliverable', 'Could not deliver the PII confirmation answer', {
                    error: String(error),
                });
            });
        } catch (error) {
            // chrome.runtime may be missing (e.g. in unit tests) - ignore.
            logEvent('pii', 'debug', 'pii_confirm_runtime_missing', 'chrome.runtime unavailable while answering the card', {
                error: String(error),
            });
        }
    };

    const remove = () => {
        host.remove();
    };

    // Dismissing or closing the card counts as "not sure": the site is NOT
    // vouched for, so the entry is penalized as usual.
    const decline = () => {
        notifyBackground(false);
        remove();
    };

    closeBtn.addEventListener('click', decline);
    dismissBtn.addEventListener('click', decline);

    confirmBtn.addEventListener('click', () => {
        confirmBtn.disabled = true;
        notifyBackground(true);
        confirmBtn.textContent = text.added;
        note.textContent = text.addedNote.replace('{{domain}}', data.domain);
        // Keep the confirmation visible briefly, then dismiss.
        setTimeout(remove, 2000);
    });

    return host;
}

/** Shows the confirmation card, replacing any existing one. */
export async function showPIIConfirmCard(data: PIIConfirmData): Promise<void> {
    hidePIIConfirmCard();
    const theme = await resolveTheme();
    document.body.appendChild(buildCard(data, theme));
}

/** Removes the confirmation card if it's visible. */
export function hidePIIConfirmCard(): void {
    document.getElementById(HOST_ID)?.remove();
}
