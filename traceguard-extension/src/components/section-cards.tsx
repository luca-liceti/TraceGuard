import { TrendingUpIcon, TrendingDownIcon, ShieldIcon, ActivityIcon, GlobeIcon, NetworkIcon, FingerprintIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { StatCard } from "@/components/ui/stat-card"
import { useAppState, useDetectorLogs, useActivityLogs, useSiteCache } from "@/lib/useStorage"
import { SiteRiskData } from "@/lib/types"

export function SectionCards() {
  const { t } = useTranslation()
  const appState = useAppState()
  const detectorLogs = useDetectorLogs()
  const piiLogs = useActivityLogs()
  const { siteCache } = useSiteCache()

  // Calculate today and yesterday boundaries
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000

  // Helper to format trend
  const formatTrend = (today: number, yesterday: number) => {
    if (yesterday === 0) return "—"
    const pct = Math.round(((today - yesterday) / yesterday) * 100)
    return `${today >= yesterday ? "+" : ""}${pct}%`
  }

  // 1. Trackers Detected
  const totalTrackers = appState?.trackersDetected || 0
  const trackersToday = detectorLogs
    .filter(log => log.detector === 'tracking' && log.timestamp >= startOfToday)
    .reduce((sum, log) => sum + (log.details?.trackerCount || 0), 0)
  const trackersYesterday = detectorLogs
    .filter(log => log.detector === 'tracking' && log.timestamp >= startOfYesterday && log.timestamp < startOfToday)
    .reduce((sum, log) => sum + (log.details?.trackerCount || 0), 0)
  const trackersTrend = formatTrend(trackersToday, trackersYesterday)

  // 2. Sites Analyzed
  const totalSites = appState?.sitesAnalyzed || 0
  const sitesToday = new Set(
    detectorLogs
      .filter(log => log.timestamp >= startOfToday)
      .map(log => log.domain)
  ).size
  const sitesYesterday = new Set(
    detectorLogs
      .filter(log => log.timestamp >= startOfYesterday && log.timestamp < startOfToday)
      .map(log => log.domain)
  ).size
  const sitesTrend = formatTrend(sitesToday, sitesYesterday)

  // 3. PII Risk Events
  const totalPii = appState?.piiEventsCount || 0
  const piiToday = piiLogs.filter(log => log.timestamp >= startOfToday).length
  const piiYesterday = piiLogs.filter(log => log.timestamp >= startOfYesterday && log.timestamp < startOfToday).length
  const piiTrend = formatTrend(piiToday, piiYesterday)

  // 4. Safe Browsing Streak (no trend — streak history isn't tracked, so any
  // percentage here would be a misleading proxy)
  const streak = appState?.safeVisitStreak || 0

  // ─── Enriched aggregates from site cache ───────────────────────────────────

  // Helper: get sites analyzed today (have lastAnalyzed >= startOfToday)
  const cacheSitesToday = Object.values(siteCache as Record<string, SiteRiskData>).filter(
    s => {
      const ts = typeof s.lastAnalyzed === 'number' ? s.lastAnalyzed : new Date(s.lastAnalyzed as string).getTime()
      return ts >= startOfToday
    }
  )
  const cacheSitesYesterday = Object.values(siteCache as Record<string, SiteRiskData>).filter(
    s => {
      const ts = typeof s.lastAnalyzed === 'number' ? s.lastAnalyzed : new Date(s.lastAnalyzed as string).getTime()
      return ts >= startOfYesterday && ts < startOfToday
    }
  )

  // 5. Network Requests, aggregate third-party + tracker requests from enriched data
  const netToday = cacheSitesToday.reduce((acc, s) => {
    const summary = s.enrichedDetails?.networkRequests?.summary
    if (!summary) return acc
    return {
      total: acc.total + summary.total,
      thirdParty: acc.thirdParty + summary.thirdParty,
      trackerRequests: acc.trackerRequests + summary.trackerRequests,
      blocked: acc.blocked + summary.blocked,
    }
  }, { total: 0, thirdParty: 0, trackerRequests: 0, blocked: 0 })

  const netYesterday = cacheSitesYesterday.reduce((acc, s) => {
    const summary = s.enrichedDetails?.networkRequests?.summary
    if (!summary) return acc
    return {
      total: acc.total + summary.total,
      thirdParty: acc.thirdParty + summary.thirdParty,
      trackerRequests: acc.trackerRequests + summary.trackerRequests,
      blocked: acc.blocked + summary.blocked,
    }
  }, { total: 0, thirdParty: 0, trackerRequests: 0, blocked: 0 })

  const totalNetRequests = Object.values(siteCache as Record<string, SiteRiskData>).reduce(
    (sum, s) => sum + (s.enrichedDetails?.networkRequests?.summary.thirdParty ?? 0), 0
  )
  const netTrend = formatTrend(netToday.thirdParty, netYesterday.thirdParty)

  // 6. Fingerprinting, aggregate attempts from enriched data
  const fpToday = cacheSitesToday.reduce(
    (sum, s) => sum + (s.enrichedDetails?.fingerprinting?.summary.totalAttempts ?? 0), 0
  )
  const fpYesterday = cacheSitesYesterday.reduce(
    (sum, s) => sum + (s.enrichedDetails?.fingerprinting?.summary.totalAttempts ?? 0), 0
  )
  const totalFp = Object.values(siteCache as Record<string, SiteRiskData>).reduce(
    (sum, s) => sum + (s.enrichedDetails?.fingerprinting?.summary.totalAttempts ?? 0), 0
  )
  const fpTrend = formatTrend(fpToday, fpYesterday)

  return (
    <div className="@xl/main:grid-cols-2 @5xl/main:grid-cols-3 grid grid-cols-1 gap-4">
      <StatCard
        title={t("Trackers Detected")}
        value={totalTrackers.toLocaleString()}
        subtitle={t("Tracking scripts detected")}
        trend={{
          direction: trackersToday >= trackersYesterday ? "up" : "down",
          value: trackersTrend,
          isPositive: trackersToday < trackersYesterday
        }}
      />
      
      <StatCard
        title={t("Sites Analyzed")}
        value={totalSites.toLocaleString()}
        subtitle={t("Unique domains scanned")}
        trend={{
          direction: sitesToday >= sitesYesterday ? "up" : "down",
          value: sitesTrend,
          isPositive: sitesToday >= sitesYesterday
        }}
      />
      
      <StatCard
        title={t("PII Risk Events")}
        value={totalPii.toLocaleString()}
        subtitle={t("Sensitive info entries")}
        trend={{
          direction: piiToday > piiYesterday ? "up" : piiToday < piiYesterday ? "down" : "up",
          value: piiTrend,
          isPositive: piiToday <= piiYesterday
        }}
      />
      
      <StatCard
        title={t("Safe Browsing Streak")}
        value={totalSites === 0 ? "—" : streak.toLocaleString()}
        subtitle={totalSites === 0 ? t("Visit some websites first") : t("Consecutive safe visits")}
      />

      <StatCard
        title={t("Cross-site Network Requests")}
        value={totalNetRequests.toLocaleString()}
        subtitle={t("Cross-site network calls detected")}
        trend={{
          direction: netToday.thirdParty >= netYesterday.thirdParty ? "up" : "down",
          value: netTrend,
          isPositive: netToday.thirdParty < netYesterday.thirdParty
        }}
      />

      <StatCard
        title={t("Fingerprinting Attempts")}
        value={totalFp.toLocaleString()}
        subtitle={t("Canvas, WebGL, audio & more")}
        trend={{
          direction: fpToday >= fpYesterday ? "up" : "down",
          value: fpTrend,
          isPositive: fpToday <= fpYesterday
        }}
      />
    </div>
  )
}

