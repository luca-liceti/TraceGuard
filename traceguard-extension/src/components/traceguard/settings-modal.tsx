/**
 * =============================================================================
 * SETTINGS PAGE - User Preferences and Data Management
 * =============================================================================
 * 
 * WHAT THIS FILE DOES:
 * This is the main settings page where users can customize TraceGuard's
 * behavior and manage their stored data.
 * 
 * SETTINGS TABS:
 * 
 * 1. APPEARANCE TAB
 *    - Theme: Light/Dark/System mode
 *    - Display Mode: Popup vs Side Panel
 * 
 * 2. PRIVACY TAB
 *    - PII Detection: Toggle personal info monitoring
 *    - Tracker Blocking: Future feature (coming soon)
 *    - Safety Threshold: Alert level for risky sites (0-100)
 * 
 * 3. NOTIFICATIONS TAB
 *    - Alert Level: Silent/Balanced/Aggressive notification modes
 * 
 * 4. DATA TAB
 *    - Data Retention: How long to keep logs (7-90 days)
 *    - Storage Usage: Visual display of storage used
 *    - Clear Actions: Delete activity logs, reset score
 *    - Danger Zone: Factory reset option
 * 
 * 5. ABOUT TAB
 *    - Version info and extension description
 * 
 * FEATURES:
 *    - Changes are tracked and require manual save
 *    - Reset to defaults option
 *    - Storage usage monitoring
 *    - Danger zone with confirmation dialogs
 * =============================================================================
 */

"use client"

import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useAppState, useSettings } from "@/lib/useStorage"
import { ExportDataDialog } from "./export-data-dialog"
import { ImportDataDialog } from "./import-data-dialog"
import { storage } from "@/lib/storage"
import { getErrorLog, clearErrorLog, type ErrorLogEntry } from "@/lib/error-log"
import {
    clearSessionEvents,
    copyDiagnosticsToClipboard,
    refreshSessionEvents,
    setDevMode,
    subscribeEvents,
    type DiagnosticEvent,
} from "@/lib/diagnostics"
import { toast } from '@/components/ui/toast'
import {
    Bell,
    Database,
    Save,
    RotateCcw,
    Trash2,
    AlertTriangle,
    Palette,
    HardDrive,
    Info,
    Copy,
    Download,
    Upload,
    List,
    ShieldUser,
    OctagonAlert
} from "lucide-react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useTheme } from "@/components/theme-provider"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useSettingsModal } from "./settings-context"


// Validates a bare domain (e.g. example.com, sub.example.co.uk). Rejects
// whitespace, ports, paths, and other junk that would silently never match.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})+$/i;

function isValidDomain(value: string): boolean {
    return DOMAIN_PATTERN.test(value);
}


// Setting item component for consistent styling
function SettingItem({
    label,
    description,
    controlId,
    children
}: {
    label: string
    description?: string
    /** Optional id linking this label to its control via htmlFor */
    controlId?: string
    children: React.ReactNode
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
            <div className="space-y-0.5 flex-1 min-w-0">
                <Label htmlFor={controlId} className="text-base font-medium">{label}</Label>
                {description && (
                    <p className="text-sm text-muted-foreground break-words">{description}</p>
                )}
            </div>
            <div className="flex-shrink-0">
                {children}
            </div>
        </div>
    )
}

// Slider component for consistency
function SettingSlider({
    label,
    description,
    value,
    min,
    max,
    step,
    unit,
    onChange,
}: {
    label: string
    description: string
    value: number
    min: number
    max: number
    step: number
    unit: string
    onChange: (value: number) => void
}) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
                <div className="space-y-0.5 min-w-0">
                    <Label className="text-base font-medium">{label}</Label>
                    <p className="text-sm text-muted-foreground break-words">{description}</p>
                </div>
                <Badge variant="secondary" className="font-mono shrink-0">
                    {value} {unit}
                </Badge>
            </div>
            <input
                id={label.toLowerCase().replace(/\s+/g, '-') + '-slider'}
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                aria-label={`${label}: ${value} ${unit}`}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={value}
                aria-valuetext={`${value} ${unit}`}
                className="w-full h-2 bg-secondary rounded-md appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                <span>{min} {unit}</span>
                <span>{max} {unit}</span>
            </div>
        </div>
    )
}

export function SettingsModal() {
    const { t } = useTranslation()
    const state = useAppState()
    const settings = useSettings()
    const { setTheme: applyTheme } = useTheme()
    const { isSettingsOpen, setSettingsOpen, activeTab, setActiveTab } = useSettingsModal()

    const [hasChanges, setHasChanges] = useState(false)
    const [discardOpen, setDiscardOpen] = useState(false)
    const [storageInfo, setStorageInfo] = useState({ bytesInUse: 0, quota: 0 })
    const [manifestVersion, setManifestVersion] = useState("1.0.0")
    const [schemaVersion, setSchemaVersion] = useState(1)

    // Local state for settings
    const [themeLocal, setThemeLocal] = useState(settings?.theme || "system")
    const [notificationLevel, setNotificationLevel] = useState(settings?.notificationLevel || "balanced")
    const [logRetentionDays, setLogRetentionDays] = useState(settings?.logRetentionDays || 30)
    const [databaseRefreshDays, setDatabaseRefreshDays] = useState(settings?.databaseRefreshDays || 7)
    const [wssThreshold, setWssThreshold] = useState(settings?.wssThreshold || 50)
    const [enabled, setEnabled] = useState(settings?.enabled ?? true)
    const [enablePIIDetection, setEnablePIIDetection] = useState(settings?.enablePIIDetection ?? true)
    const [enableCloudTosdr, setEnableCloudTosdr] = useState(settings?.enableCloudTosdr ?? false)
    const [displayMode, setDisplayMode] = useState(settings?.displayMode || "popup")
    // Legacy "Never" (0) behaved exactly like "On Browser Close" (-1): both
    // simply skip the idle timer, and session storage clears on browser close
    // either way. Normalize any stored 0 to -1 and drop the redundant option.
    const [autoLockTimeout, setAutoLockTimeout] = useState(
        settings?.autoLockTimeout === 0 ? -1 : (settings?.autoLockTimeout ?? -1)
    )
    const [whitelist, setWhitelist] = useState<string[]>(settings?.whitelist || [])
    const [blacklist, setBlacklist] = useState<string[]>(settings?.blacklist || [])
    const [errorLog, setErrorLog] = useState<ErrorLogEntry[]>([])
    const [devMode, setDevModeLocal] = useState(settings?.devMode === true)
    const [sessionEvents, setSessionEvents] = useState<DiagnosticEvent[]>([])
    const [exportOpen, setExportOpen] = useState(false)
    const [importOpen, setImportOpen] = useState(false)

    // Fetch manifest version
    useEffect(() => {
        const manifest = chrome.runtime.getManifest()
        setManifestVersion(manifest.version)
    }, [])

    // Fetch schema version from storage
    useEffect(() => {
        chrome.storage.local.get<{ schemaVersion?: number }>('schemaVersion').then((result) => {
            setSchemaVersion(result.schemaVersion || 1)
        })
    }, [])

    // Fetch storage usage
    useEffect(() => {
        const updateStorageInfo = async () => {
            setStorageInfo(await storage.getStorageUsage())
        }

        updateStorageInfo()
        const interval = setInterval(updateStorageInfo, 5000)
        return () => clearInterval(interval)
    }, [])

    // Load the local-only error log for the diagnostics panel
    useEffect(() => {
        getErrorLog().then(setErrorLog)
    }, [])

    // Live developer-mode stream: subscribe for new events and pull in whatever
    // the service worker, content script, or another view already recorded.
    useEffect(() => {
        const unsubscribe = subscribeEvents(setSessionEvents)
        void refreshSessionEvents()
        return unsubscribe
    }, [])

    // Sync local state with stored settings when they load
    useEffect(() => {
        if (settings) {
            setThemeLocal(settings.theme || "system")
            setNotificationLevel(settings.notificationLevel || "balanced")
            setLogRetentionDays(settings.logRetentionDays || 30)
            setDatabaseRefreshDays(settings.databaseRefreshDays || 7)
            setWssThreshold(settings.wssThreshold || 50)
            setEnabled(settings.enabled ?? true)
            setEnablePIIDetection(settings.enablePIIDetection ?? true)
            setEnableCloudTosdr(settings.enableCloudTosdr ?? false)
            setDisplayMode(settings.displayMode || "popup")
            setAutoLockTimeout(settings.autoLockTimeout === 0 ? -1 : (settings.autoLockTimeout ?? -1))
            setWhitelist(settings.whitelist || [])
            setBlacklist(settings.blacklist || [])
            setDevModeLocal(settings.devMode === true)
            setDevMode(settings.devMode === true)
        }
    }, [settings])

    if (!state || !settings) return <div className="p-4">{t("Loading...")}</div>

    const handleChange = () => {
        setHasChanges(true)
    }

    const saveSettings = async () => {
        const updatedSettings = {
            ...settings,
            theme: themeLocal,
            notificationLevel,
            enabled,
            logRetentionDays,
            databaseRefreshDays: databaseRefreshDays as 1 | 3 | 7 | 14 | 30,
            wssThreshold,
            enablePIIDetection,
            enableCloudTosdr,
            displayMode,
            autoLockTimeout,
            whitelist,
            blacklist,
            devMode,
        }

        await chrome.storage.local.set({ settings: updatedSettings })
        applyTheme(themeLocal)

        chrome.runtime.sendMessage({
            type: 'SETTINGS_CHANGED',
            settings: updatedSettings
        })

        setHasChanges(false)
        toast.add({
            type: 'success',
            title: t('Settings Saved'),
            description: t('Your preferences have been updated successfully.'),
        })
    }

    const resetSettings = async () => {
        const defaultPreferences = {
            theme: "system" as const,
            notificationLevel: "balanced" as const,
            enabled: true,
            logRetentionDays: 30,
            databaseRefreshDays: 7 as const,
            wssThreshold: 50,
            enablePIIDetection: true,
            enableCloudTosdr: false,
            displayMode: "popup" as const,
            autoLockTimeout: -1,
            devMode: false,
        }

        // Apply defaults to local state
        setThemeLocal(defaultPreferences.theme)
        applyTheme(defaultPreferences.theme)
        setNotificationLevel(defaultPreferences.notificationLevel)
        setEnabled(defaultPreferences.enabled)
        setLogRetentionDays(defaultPreferences.logRetentionDays)
        setDatabaseRefreshDays(defaultPreferences.databaseRefreshDays)
        setWssThreshold(defaultPreferences.wssThreshold)
        setEnablePIIDetection(defaultPreferences.enablePIIDetection)
        setEnableCloudTosdr(defaultPreferences.enableCloudTosdr)
        setDisplayMode(defaultPreferences.displayMode)
        setAutoLockTimeout(defaultPreferences.autoLockTimeout)
        setDevModeLocal(defaultPreferences.devMode)
        setDevMode(defaultPreferences.devMode)

        // Merge defaults with existing settings to preserve other data (whitelist, blacklist, etc.)
        const newSettings = {
            ...settings,
            ...defaultPreferences
        }

        await chrome.storage.local.set({ settings: newSettings })

        chrome.runtime.sendMessage({
            type: 'SETTINGS_CHANGED',
            settings: newSettings
        })

        setHasChanges(false)
        toast.add({
            type: 'info',
            title: t('Settings Reset'),
            description: t('Preferences restored to default values.'),
        })
    }

    const clearActivityLogs = async () => {
        // Canonical path: removes keys so encrypted fields are never replaced
        // by plaintext sentinels. The AlertDialog is the single confirmation.
        await storage.clearActivityLogs()
        toast.add({
            type: 'success',
            title: t('Activity Logs Cleared'),
            description: t('All logged events have been removed.'),
        })
    }

    const resetPrivacyScore = async () => {
        await storage.resetScore()
        toast.add({
            type: 'success',
            title: t('Privacy Score Reset'),
            description: t('Your UPS has been reset to 100.'),
        })
    }

    const clearAllData = async () => {
        await storage.clearAll()
        toast.add({
            type: 'success',
            title: t('All Data Cleared'),
            description: t('Extension data has been reset. Reloading...'),
        })
        setTimeout(() => window.location.reload(), 2000)
    }


    const exportData = () => {
        setExportOpen(true)
    }

    const storagePercentage = storageInfo.quota > 0
        ? Math.min(100, (storageInfo.bytesInUse / storageInfo.quota) * 100)
        : 0

    const exportErrorLog = async () => {
        try {
            const entries = await getErrorLog()
            const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `traceguard-errors-${new Date().toISOString().split('T')[0]}.json`
            a.click()
            URL.revokeObjectURL(url)
        } catch {
            toast.add({ type: 'error', title: t('Could not export error log.'), priority: 'high' })
        }
    }

    const clearErrorLogs = async () => {
        await clearErrorLog()
        setErrorLog([])
    }

    const clearSessionLog = async () => {
        await clearSessionEvents()
    }

    const copyDiagnostics = async () => {
        const { copied } = await copyDiagnosticsToClipboard()
        toast.add(copied
            ? { type: 'success', title: t('Diagnostics copied to clipboard.') }
            : { type: 'error', title: t('Could not copy diagnostics.'), priority: 'high' })
    }

    return (
        <>
            <Dialog
                open={isSettingsOpen}
                onOpenChange={(open) => {
                    // Never close silently while there are unsaved changes -
                    // ask first (the confirm dialog below resolves the choice).
                    if (!open && hasChanges) {
                        setDiscardOpen(true)
                        return
                    }
                    setSettingsOpen(open)
                }}
            >
            <DialogContent
                className="max-w-4xl p-0 overflow-hidden gap-0 bg-background border shadow-2xl h-[600px] flex flex-col"
                onEscapeKeyDown={(e) => {
                    if (hasChanges) {
                        e.preventDefault()
                        setDiscardOpen(true)
                    }
                }}
                onInteractOutside={(e) => {
                    if (hasChanges) {
                        e.preventDefault()
                        setDiscardOpen(true)
                    }
                }}
            >
                <DialogTitle className="sr-only">{t("Settings")}</DialogTitle>
                <DialogDescription className="sr-only">{t("Configure TraceGuard preferences")}</DialogDescription>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 h-[600px] w-full">
                    {/* Sidebar Navigation */}
                    <div className="w-[240px] flex flex-col border-r bg-muted/10 h-full">
                        <div className="p-4 py-6">
                            <h2 className="text-xl font-bold tracking-tight">{t("Settings")}</h2>
                        </div>
                        <TabsList className="flex flex-col h-full w-full justify-start items-stretch space-y-1 bg-transparent p-3 pt-0">
                            <TabsTrigger value="appearance" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <Palette className="h-4 w-4" />
                                {t("Appearance")}
                            </TabsTrigger>
                            <TabsTrigger value="privacy" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <ShieldUser className="h-4 w-4" />
                                {t("Privacy")}
                            </TabsTrigger>
                            <TabsTrigger value="notifications" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <Bell className="h-4 w-4" />
                                {t("Notifications")}
                            </TabsTrigger>
                            <TabsTrigger value="domain-lists" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <OctagonAlert className="h-4 w-4" />
                                {t("Allow/Block")}
                            </TabsTrigger>
                            <TabsTrigger value="data" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <Database className="h-4 w-4" />
                                {t("Data")}
                            </TabsTrigger>
                            <TabsTrigger value="about" className="justify-start gap-2 px-3 py-2 data-[state=active]:bg-muted">
                                <Info className="h-4 w-4" />
                                {t("About")}
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 flex flex-col relative h-full">
                        <div className="flex-1 overflow-y-auto p-6 scroll-smooth space-y-6">
                            {/* Save Changes Bar - At Top */}
                            {hasChanges && (
                                <div className="border-b border-primary/50 bg-background/95 backdrop-blur sticky top-0 z-10">
                                    <div className="py-3 px-4">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2 text-sm">
                                                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                                                <span className="text-muted-foreground">{t("You have unsaved changes")}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button variant="ghost" size="sm" onClick={resetSettings}>
                                                    <RotateCcw className="mr-2 h-4 w-4" />
                                                    {t("Reset")}
                                                </Button>
                                                <Button size="sm" onClick={saveSettings}>
                                                    <Save className="mr-2 h-4 w-4" />
                                                    {t("Save Changes")}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                {/* Appearance Tab */}
                <TabsContent value="appearance" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">
                            {t("Appearance")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("Customize how TraceGuard looks and opens")}
                        </p>
                    </div>
                    <Separator />
                    <div className="space-y-4">
                        <SettingItem
                            label={t("Theme")}
                            description={t("Choose between light, dark, or system theme")}
                        >
                            <Select
                                value={themeLocal}
                                onValueChange={(value) => {
                                    setThemeLocal(value as 'light' | 'dark' | 'system')
                                    handleChange()
                                }}
                            >
                                <SelectTrigger className="w-[150px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="system">{t("System")}</SelectItem>
                                    <SelectItem value="light">{t("Light")}</SelectItem>
                                    <SelectItem value="dark">{t("Dark")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingItem>

                        <SettingItem
                            label={t("Display Mode")}
                            description={t("How TraceGuard opens when you click the extension icon")}
                        >
                            <Select
                                value={displayMode}
                                onValueChange={(value) => {
                                    setDisplayMode(value as 'popup' | 'sidebar')
                                    handleChange()
                                }}
                            >
                                <SelectTrigger className="w-[150px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="popup">{t("Popup")}</SelectItem>
                                    <SelectItem value="sidebar">{t("Side Panel")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingItem>
                    </div>
                </TabsContent>

                {/* Privacy Tab */}
                <TabsContent value="privacy" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">
                            {t("Privacy")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("Configure privacy detection features and alerts")}
                        </p>
                    </div>
                    <Separator />
                    <div className="space-y-4">
                        <SettingItem
                            label={t("Extension Enabled")}
                            description={t("Pause TraceGuard to stop analyzing and recording browsing activity")}
                            controlId="enabled-toggle"
                        >
                            <Switch
                                id="enabled-toggle"
                                checked={enabled}
                                onCheckedChange={(checked) => {
                                    setEnabled(checked)
                                    handleChange()
                                }}
                            />
                        </SettingItem>

                        <SettingItem
                            label={t("PII Detection")}
                            description={t("Monitor when you enter personal information on websites")}
                            controlId="pii-detection-toggle"
                        >
                            <Switch
                                id="pii-detection-toggle"
                                checked={enablePIIDetection}
                                onCheckedChange={(checked) => {
                                    setEnablePIIDetection(checked)
                                    handleChange()
                                }}
                            />
                        </SettingItem>

                        <SettingItem
                            label={t("Live rating updates")}
                            description={t("Fetch the latest ratings from tosdr.org when our local data is stale. Sends the current site's domain to tosdr.org.")}
                            controlId="cloud-tosdr-toggle"
                        >
                            <Switch
                                id="cloud-tosdr-toggle"
                                checked={enableCloudTosdr}
                                onCheckedChange={(checked) => {
                                    setEnableCloudTosdr(checked)
                                    handleChange()
                                }}
                            />
                        </SettingItem>

                        <SettingItem
                            label={t("Vault Auto-Lock")}
                            description={t("When should your privacy vault automatically lock?")}
                        >
                            <Select
                                value={autoLockTimeout.toString()}
                                onValueChange={(value) => {
                                    setAutoLockTimeout(Number(value))
                                    handleChange()
                                }}
                            >
                                <SelectTrigger className="w-[180px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="-1">{t("On Browser Close")}</SelectItem>
                                    <SelectItem value="1">{t("After 1 Minute")}</SelectItem>
                                    <SelectItem value="5">{t("After 5 Minutes")}</SelectItem>
                                    <SelectItem value="15">{t("After 15 Minutes")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingItem>

                        <SettingSlider
                            label={t("Safety Threshold")}
                            description={t("Get alerts when a site's safety score is below this value")}
                            value={wssThreshold}
                            min={0}
                            max={100}
                            step={5}
                            unit=""
                            onChange={(value) => {
                                setWssThreshold(value)
                                handleChange()
                            }}
                        />

                    </div>
                </TabsContent>

                {/* Notifications Tab */}
                <TabsContent value="notifications" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">
                            {t("Notifications")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("Control when and how you receive security alerts")}
                        </p>
                    </div>
                    <Separator />
                    <div className="space-y-4">
                        <SettingItem
                            label={t("Alert Level")}
                            description={
                                notificationLevel === "silent"
                                    ? t("You won't receive any notifications")
                                    : notificationLevel === "balanced"
                                        ? t("Notified for high-risk sites and critical PII events")
                                        : t("Notified for all site changes and tracker detections")
                            }
                        >
                            <Select
                                value={notificationLevel}
                                onValueChange={(value) => {
                                    setNotificationLevel(value as 'silent' | 'balanced' | 'aggressive')
                                    handleChange()
                                }}
                            >
                                <SelectTrigger className="w-[150px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="silent">{t("Silent")}</SelectItem>
                                    <SelectItem value="balanced">{t("Balanced")}</SelectItem>
                                    <SelectItem value="aggressive">{t("Aggressive")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingItem>
                    </div>
                </TabsContent>

                {/* Domain Lists Tab */}
                <TabsContent value="domain-lists" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">{t("Allow/Block Sites")}</h3>
                        <p className="text-sm text-muted-foreground">{t("Manage explicit exceptions for website tracking and safety")}</p>
                    </div>
                    <Separator />
                    
                    <div className="space-y-6">
                        <div className="space-y-4">
                            <h4 className="text-sm font-medium">{t("Allowed Sites (Whitelist)")}</h4>
                            <p className="text-sm text-muted-foreground">{t("These sites will never trigger privacy alerts or be blocked.")}</p>
                            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                                <Input 
                                    id="add-whitelist" 
                                    placeholder={t("e.g. example.com")} 
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const val = e.currentTarget.value.trim().toLowerCase();
                                            if (val && !isValidDomain(val)) {
                                                toast.add({ type: "error", title: t("Invalid domain"), description: t("Please enter a valid domain (e.g., example.com)"), priority: "high" });
                                            } else if (val && !whitelist.includes(val)) {
                                                setWhitelist([...whitelist, val]);
                                                handleChange();
                                            }
                                            e.currentTarget.value = '';
                                        }
                                    }}
                                />
                                <Button size="sm" onClick={() => {
                                    const input = document.getElementById('add-whitelist') as HTMLInputElement;
                                    const val = input.value.trim().toLowerCase();
                                    if (val && !isValidDomain(val)) {
                                        toast.add({ type: "error", title: t("Invalid domain"), description: t("Please enter a valid domain (e.g., example.com)"), priority: "high" });
                                    } else if (val && !whitelist.includes(val)) {
                                        setWhitelist([...whitelist, val]);
                                        handleChange();
                                    }
                                    input.value = '';
                                }}>{t("Add")}</Button>
                            </div>
                            <div className="rounded-md border max-h-40 overflow-y-auto">
                                {whitelist.length === 0 ? (
                                    <div className="p-4 text-center text-sm text-muted-foreground">{t("No allowed sites")}</div>
                                ) : (
                                    <ul className="divide-y">
                                        {whitelist.map(domain => (
                                            <li key={domain} className="flex items-center justify-between p-2 px-3 text-sm">
                                                <span>{domain}</span>
                                                <Button variant="ghost" size="icon" aria-label={`${t("Delete")}: ${domain}`} className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => {
                                                    setWhitelist(whitelist.filter(d => d !== domain));
                                                    handleChange();
                                                }}>
                                                    <Trash2 className="h-3 w-3" />
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>

                        <Separator />

                        <div className="space-y-4">
                            <h4 className="text-sm font-medium">{t("Blocked Sites (Blacklist)")}</h4>
                            <p className="text-sm text-muted-foreground">{t("These sites will always trigger high-risk alerts.")}</p>
                            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                                <Input 
                                    id="add-blacklist" 
                                    placeholder={t("e.g. badsite.com")} 
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const val = e.currentTarget.value.trim().toLowerCase();
                                            if (val && !isValidDomain(val)) {
                                                toast.add({ type: "error", title: t("Invalid domain"), description: t("Please enter a valid domain (e.g., example.com)"), priority: "high" });
                                            } else if (val && !blacklist.includes(val)) {
                                                setBlacklist([...blacklist, val]);
                                                handleChange();
                                            }
                                            e.currentTarget.value = '';
                                        }
                                    }}
                                />
                                <Button size="sm" onClick={() => {
                                    const input = document.getElementById('add-blacklist') as HTMLInputElement;
                                    const val = input.value.trim().toLowerCase();
                                    if (val && !isValidDomain(val)) {
                                        toast.add({ type: "error", title: t("Invalid domain"), description: t("Please enter a valid domain (e.g., example.com)"), priority: "high" });
                                    } else if (val && !blacklist.includes(val)) {
                                        setBlacklist([...blacklist, val]);
                                        handleChange();
                                    }
                                    input.value = '';
                                }}>{t("Add")}</Button>
                            </div>
                            <div className="rounded-md border max-h-40 overflow-y-auto">
                                {blacklist.length === 0 ? (
                                    <div className="p-4 text-center text-sm text-muted-foreground">{t("No blocked sites")}</div>
                                ) : (
                                    <ul className="divide-y">
                                        {blacklist.map(domain => (
                                            <li key={domain} className="flex items-center justify-between p-2 px-3 text-sm">
                                                <span>{domain}</span>
                                                <Button variant="ghost" size="icon" aria-label={`${t("Delete")}: ${domain}`} className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => {
                                                    setBlacklist(blacklist.filter(d => d !== domain));
                                                    handleChange();
                                                }}>
                                                    <Trash2 className="h-3 w-3" />
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* Data Tab */}
                <TabsContent value="data" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">{t("Data")}</h3>
                        <p className="text-sm text-muted-foreground">{t("Manage your data storage, exports, and deletions")}</p>
                    </div>
                    <Separator />
                    
                    <div className="space-y-4">
                        <SettingSlider
                            label={t("Data Retention")}
                            description={t("Old activity logs will be automatically deleted after this period")}
                            value={logRetentionDays}
                            min={7}
                            max={90}
                            step={1}
                            unit={t("days")}
                            onChange={(value) => {
                                setLogRetentionDays(value)
                                handleChange()
                            }}
                        />

                        <SettingItem
                            label={t("Database Refresh")}
                            description={t("Check for tracker and ToS;DR database updates on this schedule")}
                        >
                            <Select value={String(databaseRefreshDays)} onValueChange={(value) => {
                                setDatabaseRefreshDays(Number(value) as 1 | 3 | 7 | 14 | 30)
                                handleChange()
                            }}>
                                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="1">{t("1 day")}</SelectItem>
                                    <SelectItem value="3">{t("3 days")}</SelectItem>
                                    <SelectItem value="7">{t("7 days")}</SelectItem>
                                    <SelectItem value="14">{t("14 days")}</SelectItem>
                                    <SelectItem value="30">{t("30 days")}</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingItem>

                        {/* Storage Usage */}
                        <div className="rounded-lg border p-4">
                            <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
                                <div className="space-y-0.5 min-w-0">
                                    <Label className="text-base font-medium flex items-center gap-2">
                                        <HardDrive className="h-4 w-4 text-muted-foreground" />
                                        {t("Storage Used")}
                                    </Label>
                                </div>
                                <span className="text-sm text-muted-foreground shrink-0">
                                    {(storageInfo.bytesInUse / 1024 / 1024).toFixed(2)} {t("MB")}{storageInfo.quota > 0 ? ` ${t("of")} ${(storageInfo.quota / 1024 / 1024).toFixed(0)} ${t("MB")}` : ""}
                                </span>
                            </div>
                            {storageInfo.quota > 0 && <Progress value={storagePercentage} className="h-2" />}
                        </div>
                    </div>
                    
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                             <div className="space-y-0.5 flex-1 min-w-0">
                                 <Label className="text-base font-medium">{t("Export Data")}</Label>
                                 <p className="text-sm text-muted-foreground break-words">{t("Export a JSON backup of all your data (optionally password-protected)")}</p>
                             </div>
                             <div className="flex-shrink-0 flex flex-wrap gap-2">
                                 <Button variant="outline" onClick={() => setImportOpen(true)}>
                                     <Upload className="mr-2 h-4 w-4" />
                                     {t("Import")}
                                 </Button>
                                 <Button variant="outline" onClick={exportData}>
                                     <Download className="mr-2 h-4 w-4" />
                                     {t("Export to JSON")}
                                 </Button>
                             </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                             <div className="space-y-0.5 flex-1 min-w-0">
                                 <Label className="text-base font-medium">{t("Clear Data")}</Label>
                                 <p className="text-sm text-muted-foreground break-words">{t("Remove specific data from the extension")}</p>
                             </div>
                             <div className="flex-shrink-0 flex flex-wrap gap-2">
                                 <AlertDialog>
                                     <AlertDialogTrigger asChild>
                                         <Button variant="outline">
                                             <Trash2 className="mr-2 h-4 w-4" />
                                             {t("Clear Activity Logs")}
                                         </Button>
                                     </AlertDialogTrigger>
                                     <AlertDialogContent>
                                         <AlertDialogHeader>
                                             <AlertDialogTitle>{t("Clear Activity Logs?")}</AlertDialogTitle>
                                             <AlertDialogDescription>
                                                 {t("This will delete all of your recorded browsing activity logs. Your overall privacy score will remain intact.")}
                                             </AlertDialogDescription>
                                         </AlertDialogHeader>
                                         <AlertDialogFooter>
                                             <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                             <AlertDialogAction onClick={clearActivityLogs}>{t("Continue")}</AlertDialogAction>
                                         </AlertDialogFooter>
                                     </AlertDialogContent>
                                 </AlertDialog>
                                 <AlertDialog>
                                     <AlertDialogTrigger asChild>
                                         <Button variant="outline">
                                             <RotateCcw className="mr-2 h-4 w-4" />
                                             {t("Reset Privacy Score")}
                                         </Button>
                                     </AlertDialogTrigger>
                                     <AlertDialogContent>
                                         <AlertDialogHeader>
                                             <AlertDialogTitle>{t("Reset Privacy Score?")}</AlertDialogTitle>
                                             <AlertDialogDescription>
                                                 {t("This will reset your privacy score back to 100 and clear your historical score data. Activity logs will not be deleted.")}
                                             </AlertDialogDescription>
                                         </AlertDialogHeader>
                                         <AlertDialogFooter>
                                             <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                             <AlertDialogAction onClick={resetPrivacyScore}>{t("Continue")}</AlertDialogAction>
                                         </AlertDialogFooter>
                                     </AlertDialogContent>
                                 </AlertDialog>
                             </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/50 p-4">
                             <div className="space-y-0.5 flex-1 min-w-0">
                                 <Label className="text-base font-medium text-destructive flex items-center gap-2">
                                     <AlertTriangle className="h-4 w-4" />
                                     {t("Danger Zone")}
                                 </Label>
                                 <p className="text-sm text-muted-foreground break-words">{t("Irreversible actions that will delete your data")}</p>
                             </div>
                             <div className="flex-shrink-0">
                                 <AlertDialog>
                                     <AlertDialogTrigger asChild>
                                         <Button variant="destructive">
                                             <Trash2 className="mr-2 h-4 w-4" />
                                             {t("Delete All Data")}
                                         </Button>
                                     </AlertDialogTrigger>
                                     <AlertDialogContent>
                                         <AlertDialogHeader>
                                             <AlertDialogTitle>{t("Are you absolutely sure?")}</AlertDialogTitle>
                                             <AlertDialogDescription>
                                                 {t("This action cannot be undone. This will permanently delete your account, activity logs, settings, and remove your data from the local device.")}
                                             </AlertDialogDescription>
                                         </AlertDialogHeader>
                                         <AlertDialogFooter>
                                             <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                             <AlertDialogAction onClick={clearAllData} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("Delete Data")}</AlertDialogAction>
                                         </AlertDialogFooter>
                                     </AlertDialogContent>
                                 </AlertDialog>
                             </div>
                        </div>
                    </div>
                </TabsContent>

                {/* About Tab */}
                <TabsContent value="about" className="space-y-6 mt-0">
                    <div>
                        <h3 className="text-lg font-medium">{t("About TraceGuard")}</h3>
                        <p className="text-sm text-muted-foreground">{t("Information about TraceGuard Privacy Extension")}</p>
                    </div>
                    <Separator />
                    <div className="rounded-lg border p-4 space-y-4">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <p className="text-muted-foreground text-xs">{t("Version")}</p>
                                <p className="font-mono font-medium">{manifestVersion}</p>
                            </div>
                            <div>
                                <p className="text-muted-foreground text-xs">{t("Schema")}</p>
                                <p className="font-mono font-medium">v{schemaVersion}</p>
                            </div>
                        </div>
                        <Separator />
                        <p className="text-sm text-muted-foreground">
                            {t("TraceGuard keeps a local journal of trackers, cookies, and privacy scores so you can review and improve your browsing habits. Everything stays on your device unless you enable Live rating updates, which checks tosdr.org for fresh ratings when our local data is stale.")}
                        </p>
                    </div>

                    <div className="rounded-lg border p-4 space-y-3">
                        <Label className="text-base font-medium flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                            {t("Diagnostics")}
                        </Label>
                        <div className="flex items-start justify-between gap-4">
                            <div className="space-y-1">
                                <Label htmlFor="dev-mode" className="text-sm font-medium">{t("Developer mode")}</Label>
                                <p className="text-sm text-muted-foreground break-words">
                                    {t("Developer mode captures detailed diagnostics for troubleshooting. It is off by default, stays on this device, and is cleared when the browser closes. Use it only when you understand what is being logged.")}
                                </p>
                            </div>
                            <Switch
                                id="dev-mode"
                                checked={devMode}
                                onCheckedChange={(checked) => {
                                    // Apply immediately so the log starts filling
                                    // right away; persisted with the other settings.
                                    setDevModeLocal(checked)
                                    setDevMode(checked)
                                    handleChange()
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={copyDiagnostics}>
                                <Copy className="mr-2 h-3 w-3" />
                                {t("Copy diagnostics")}
                            </Button>
                            {sessionEvents.length > 0 && (
                                <Button variant="ghost" size="sm" onClick={clearSessionLog}>
                                    {t("Clear")}
                                </Button>
                            )}
                        </div>
                        {devMode && (
                            sessionEvents.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("No events recorded.")}</p>
                            ) : (
                                <div className="rounded-md border max-h-40 overflow-y-auto divide-y">
                                    {sessionEvents.slice(-80).reverse().map((entry) => (
                                        <div key={entry.id} className="p-2 text-xs">
                                            <span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                                            <p className="font-medium break-words">
                                                [{entry.level}] {entry.area}/{entry.event}: {entry.message}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )
                        )}
                        <Separator />
                        <p className="text-sm text-muted-foreground break-words">
                            {t("Recent errors are stored locally on this device to help troubleshoot. They never leave your browser.")}
                        </p>
                        {errorLog.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("No errors recorded.")}</p>
                        ) : (
                            <>
                                <div className="rounded-md border max-h-40 overflow-y-auto divide-y">
                                    {errorLog.map((entry, i) => (
                                        <div key={i} className="p-2 text-xs">
                                            <span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span>
                                            <p className="font-medium break-words">{entry.message}</p>
                                            {entry.context && <p className="text-muted-foreground break-all">{entry.context}</p>}
                                        </div>
                                    ))}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline" size="sm" onClick={exportErrorLog}>
                                        <Download className="mr-2 h-3 w-3" />
                                        {t("Export error log")}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={clearErrorLogs}>
                                        {t("Clear")}
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                </TabsContent>
                        </div>
                    </div>
                </Tabs>
            </DialogContent>
            </Dialog>

            <ExportDataDialog open={exportOpen} onOpenChange={setExportOpen} />
            <ImportDataDialog open={importOpen} onOpenChange={setImportOpen} />

            {/* Discard-unsaved-changes confirmation */}
            <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("Discard unsaved changes?")}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("Your unsaved settings changes will be lost if you close.")}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("Keep editing")}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                setDiscardOpen(false)
                                setHasChanges(false)
                                setSettingsOpen(false)
                            }}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {t("Discard changes")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}
