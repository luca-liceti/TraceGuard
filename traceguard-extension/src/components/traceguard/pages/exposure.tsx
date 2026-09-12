import React from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useExposureReport } from "@/lib/useStorage"
import { cn } from "@/lib/utils"
import { getSafetyConfig } from "@/lib/risk-utils"
import { categoryLabelKey } from "@/lib/exposure"
import type { ExposureSite, HandoverGroup, SurpriseReason, Watcher } from "@/lib/exposure"
import { Clock, Eye, KeyRound, ShieldCheck } from "lucide-react"

/**
 * FOOTPRINT LEDGER - what you handed over, and who has seen you.
 *
 * Read-only by design: this page states what TraceGuard recorded and nothing
 * more. It cannot see the values typed into a form (only the field type), and it
 * does not claim to stop a site from keeping what it already has. Keeping that
 * honest is the whole point of the page.
 */

/** Count-aware label, so a single tracker never reads "1 trackers". */
function usePlural() {
    const { t } = useTranslation()
    return (count: number, one: string, many: string): string =>
        count === 1 ? t(one, { count }) : t(many, { count })
}

function formatDate(ts: number | null): string | null {
    // A null or non-finite timestamp has no date to show. `toLocaleDateString`
    // returns the string "Invalid Date" instead of throwing, so this guard is
    // what keeps that text out of the UI. No catch is needed, and a silent one
    // would have hidden a bad timestamp rather than showing nothing.
    if (ts === null || !Number.isFinite(ts)) return null
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

/** Every flag is explainable; the UI must show the reason, not just the flag. */
function useReasonLabel() {
    const { t } = useTranslation()
    return (reason: SurpriseReason): string => {
        switch (reason) {
            case 'single-visit': return t("Visited once")
            case 'dormant': return t("Not visited in a long time")
            case 'low-trust': return t("Entered while the site scored low")
            case 'not-recently-visited': return t("Not in your recent sites")
            default: return ''
        }
    }
}

function SiteRow({ site, reasonLabel }: { site: ExposureSite; reasonLabel: (r: SurpriseReason) => string }) {
    const { t } = useTranslation()
    const lastSeen = formatDate(site.lastSeen)

    return (
        <div className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
                <div className="text-sm font-medium truncate">{site.domain}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                    {site.reasons.map(reason => (
                        <Badge
                            key={reason}
                            variant="outline"
                            className={cn(
                                "text-[10px] font-medium shadow-none",
                                "border-warning/30 bg-warning/10 text-warning"
                            )}
                        >
                            {reasonLabel(reason)}
                        </Badge>
                    ))}
                    {lastSeen && (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {t("Last seen {{date}}", { date: lastSeen })}
                        </span>
                    )}
                </div>
            </div>
            {site.wss !== null && (
                <span className={cn("text-sm font-bold shrink-0", getSafetyConfig(site.wss).color)}>
                    {site.wss}
                </span>
            )}
        </div>
    )
}

function HandoverCard({ group, reasonLabel }: { group: HandoverGroup; reasonLabel: (r: SurpriseReason) => string }) {
    const { t } = useTranslation()
    const plural = usePlural()

    return (
        <Card>
            <CardHeader className="p-4 pb-2">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium capitalize">{t(group.fieldType)}</CardTitle>
                    <span className="text-xs text-muted-foreground shrink-0">
                        {plural(group.siteCount, "{{count}} site", "{{count}} sites")}
                    </span>
                </div>
                {group.surprisingCount > 0 && (
                    <CardDescription className="text-xs">
                        {t("{{count}} of these look like ones you may have forgotten", { count: group.surprisingCount })}
                    </CardDescription>
                )}
            </CardHeader>
            <CardContent className="p-4 pt-0 divide-y">
                {group.sites.map(site => (
                    <SiteRow key={site.domain} site={site} reasonLabel={reasonLabel} />
                ))}
            </CardContent>
        </Card>
    )
}

function WatcherRow({ watcher, totalSites }: { watcher: Watcher; totalSites: number }) {
    const { t } = useTranslation()
    const plural = usePlural()

    return (
        <div className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
                <div className="text-sm font-medium truncate">{watcher.organization}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                        {t("On {{count}} of {{total}} sites you visited", {
                            count: watcher.siteCount,
                            total: totalSites,
                        })}
                    </span>
                    {watcher.categories.map(category => (
                        <Badge key={category} variant="outline" className="text-[10px] shadow-none">
                            {t(categoryLabelKey(category))}
                        </Badge>
                    ))}
                </div>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
                {plural(watcher.trackerCount, "{{count}} tracker", "{{count}} trackers")}
            </span>
        </div>
    )
}

export default function ExposurePage() {
    const { t } = useTranslation()
    const { report, isLoading } = useExposureReport()
    const reasonLabel = useReasonLabel()

    return (
        <>
            <div>
                <h1 className="text-3xl font-bold tracking-tight">{t("Your Footprint")}</h1>
                <p className="text-muted-foreground mt-2">
                    {t("What you have handed over, and who has seen you. Built from your own browsing, stored only on this device.")}
                </p>
            </div>

            {isLoading ? (
                <div className="text-sm text-muted-foreground">{t("Loading...")}</div>
            ) : !report.hasData ? (
                <Card>
                    <CardHeader className="flex flex-row items-center gap-2 space-y-0">
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-sm font-medium">{t("Nothing to show yet")}</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                        <CardDescription>
                            {t("This page fills in as you browse. It lists the personal data you enter, the sites that received it, and the companies whose trackers loaded alongside.")}
                        </CardDescription>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 lg:gap-6">
                    {/* What you handed over */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <KeyRound className="h-4 w-4 text-muted-foreground" />
                            <h2 className="text-lg font-semibold">{t("What you have handed over")}</h2>
                        </div>
                        {report.handedOver.length === 0 ? (
                            <Card>
                                <CardContent className="p-4 text-sm text-muted-foreground">
                                    {t("No personal data recorded yet.")}
                                </CardContent>
                            </Card>
                        ) : (
                            report.handedOver.map(group => (
                                <HandoverCard key={group.fieldType} group={group} reasonLabel={reasonLabel} />
                            ))
                        )}
                    </div>

                    {/* Who has seen you */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <h2 className="text-lg font-semibold">{t("Who has seen you")}</h2>
                        </div>
                        <Card>
                            <CardHeader className="p-4 pb-2">
                                <CardDescription className="text-xs">
                                    {t("Tracker companies whose code loaded on the sites you visited, ranked by how much of your browsing they covered.")}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="p-4 pt-0 divide-y">
                                {report.watchers.length === 0 ? (
                                    <p className="py-2 text-sm text-muted-foreground">
                                        {t("No tracker organizations recorded yet.")}
                                    </p>
                                ) : (
                                    report.watchers.map(watcher => (
                                        <WatcherRow
                                            key={watcher.organization}
                                            watcher={watcher}
                                            totalSites={report.totals.sitesVisited}
                                        />
                                    ))
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}
        </>
    )
}
