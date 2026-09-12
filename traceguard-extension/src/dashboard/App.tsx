import React, { Suspense } from 'react'
import { HashRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ThemeProvider, useTheme } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import Layout from "@/components/traceguard/layout"
import { useSettings } from "@/lib/useStorage"
import { AuthProvider } from "@/components/traceguard/auth-provider"
import { resilientLazy } from "@/lib/resilient-lazy"

// Import pages (lazy-loaded so heavy chart/table dependencies only ship when
// their route is actually opened). resilientLazy self-heals when a chunk goes
// stale after an extension update — without it, an open dashboard tab crashes
// with "Failed to fetch dynamically imported module".
const OverviewPage = resilientLazy(() => import("@/components/traceguard/pages/overview"))
const HelpPage = resilientLazy(() => import("@/components/traceguard/pages/help"))
const RankingsPage = resilientLazy(() => import("@/components/traceguard/pages/rankings"))
const ExposurePage = resilientLazy(() => import("@/components/traceguard/pages/exposure"))
const PrivacyPolicyPage = resilientLazy(() => import("@/components/traceguard/pages/privacy-policy"))
import { SettingsProvider, useSettingsModal } from "@/components/traceguard/settings-context"
import { SettingsModal } from "@/components/traceguard/settings-modal"

import { ErrorBoundary } from '@/components/ErrorBoundary'

// Page Wrapper
function PageWrapper({ children }: { children: React.ReactNode }) {
    return (
        <Layout>
            <ErrorBoundary>
                {children}
            </ErrorBoundary>
        </Layout>
    )
}

import { useEffect } from 'react'
import { toast } from "@/components/ui/toast"
import { useTranslation } from "react-i18next"

// Deep-link: open the settings modal (e.g. from a notification) via ?openSettings=privacy.
// Must live inside <Router> because it uses useLocation().
function DeepLinkHandler() {
    const location = useLocation()
    const { setSettingsOpen, setActiveTab } = useSettingsModal()

    useEffect(() => {
        const params = new URLSearchParams(location.search)
        if (params.get('openSettings')) {
            setSettingsOpen(true)
            setActiveTab(params.get('openSettings') || 'privacy')
        }
    }, [location.search])

    return null
}

function AppContent() {
    const { theme } = useTheme()
    const { t } = useTranslation()

    useEffect(() => {
        const handleQuotaExceeded = () => {
            toast.add({
                type: "error",
                title: t("Storage Full"),
                description: t("Couldn't save data — local storage is full. Clear some logs or sites to continue."),
                priority: "high",
            })
        }
        window.addEventListener('QUOTA_EXCEEDED', handleQuotaExceeded)
        
        const messageListener = (msg: any) => {
            if (msg?.type === 'QUOTA_EXCEEDED') handleQuotaExceeded();
        };
        chrome.runtime.onMessage.addListener(messageListener);

        return () => {
            window.removeEventListener('QUOTA_EXCEEDED', handleQuotaExceeded)
            chrome.runtime.onMessage.removeListener(messageListener);
        }
    }, [])

    return (
        <>
            <Toaster />
            <Router>
                <DeepLinkHandler />
                <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">{t("Loading...")}</div>}>
                    <Routes>
                        {/* Default route - redirect to Overview */}
                        <Route path="/" element={<Navigate to="/overview" replace />} />

                        {/* Main Overview (Landing Page) */}
                        <Route path="/overview" element={<PageWrapper><OverviewPage /></PageWrapper>} />

                        {/* Legacy dashboard route - redirect to overview */}
                        <Route path="/dashboard" element={<Navigate to="/overview" replace />} />

                        {/* Footprint ledger */}
                        <Route path="/exposure" element={<PageWrapper><ExposurePage /></PageWrapper>} />

                        {/* Management Pages */}
                        <Route path="/rankings" element={<PageWrapper><RankingsPage /></PageWrapper>} />
                        <Route path="/help" element={<PageWrapper><HelpPage /></PageWrapper>} />
                        <Route path="/privacy-policy" element={<PageWrapper><PrivacyPolicyPage /></PageWrapper>} />
                    </Routes>
                </Suspense>
            </Router>
        </>
    )
}

function App() {
    const settings = useSettings();

    return (
        <ThemeProvider
            key={settings?.theme || "system"}
            attribute="class"
            defaultTheme={settings?.theme || "system"}
            enableSystem={true}
            disableTransitionOnChange
        >
            <AuthProvider>
                <SettingsProvider>
                    <AppContent />
                    <SettingsModal />
                </SettingsProvider>
            </AuthProvider>
        </ThemeProvider>
    )
}

export default App

