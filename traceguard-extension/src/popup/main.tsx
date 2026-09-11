import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import App from '../sidepanel/App'
import { AuthProvider } from '@/components/traceguard/auth-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { useSettings } from '@/lib/useStorage'
import { redirectToDashboardIfFirstRun } from '@/lib/first-run'
import '@/styles/globals.css'
import '@/lib/i18n'
import { installGlobalErrorHandlers, logEvent, setDiagnosticContext, syncDevModeFromSettings } from '@/lib/diagnostics'

// Capture uncaught errors thrown anywhere in the popup context.
installGlobalErrorHandlers()
setDiagnosticContext('popup')
// The popup renders no settings UI of its own, so it has to read the developer
// mode flag itself or every verbose event it records is dropped.
void syncDevModeFromSettings()

function Root() {
    const settings = useSettings();
    const [showPopup, setShowPopup] = useState(false);

    useEffect(() => {
        let cancelled = false;
        redirectToDashboardIfFirstRun()
            .then((redirected) => {
                if (cancelled) return;
                if (redirected) {
                    window.close();
                } else {
                    setShowPopup(true);
                }
            })
            .catch((error) => {
                // If the check fails (e.g. storage unavailable), fall back to
                // the normal popup UI rather than leaving a blank window.
                logEvent('popup', 'warn', 'first_run_check_failed', 'Could not check first-run state', { error: String(error) });
                if (!cancelled) setShowPopup(true);
            });
        return () => { cancelled = true; };
    }, []);

    if (!showPopup) {
        // Blank while we check for first run; popups are transient so the
        // flash is imperceptible.
        return null;
    }

    return (
        <ThemeProvider
            key={settings?.theme || "system"}
            attribute="class"
            defaultTheme={settings?.theme || "system"}
            enableSystem={true}
            disableTransitionOnChange
        >
            <AuthProvider>
                <App />
            </AuthProvider>
        </ThemeProvider>
    );
}

try {
    const rootElement = document.getElementById('root');

    if (!rootElement) {
        console.error('Failed to find root element');
    } else {
        ReactDOM.createRoot(rootElement).render(
            <React.StrictMode>
                <ErrorBoundary>
                    <Root />
                </ErrorBoundary>
            </React.StrictMode>,
        )
    }
} catch (error) {
    console.error('Error mounting popup:', error);
}
