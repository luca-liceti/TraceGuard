import React, { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { DataTable, SiteVisit } from "@/components/data-table"
import { SectionCards } from "@/components/section-cards"
import { RadialChartScore } from "@/components/radial-chart-score"
import { useDetectorLogs, useSiteCache } from "@/lib/useStorage"
import { DetectorType } from "@/lib/types"

export default function OverviewPage() {
  const { t } = useTranslation()
  const detectorLogs = useDetectorLogs()
  const { siteCache } = useSiteCache()
  const [timeRange, setTimeRange] = React.useState("1d")

  const groupedVisits = useMemo(() => {
    const groups = new Map<string, { domain: string; timestamp: number; wss: number; detectors: Record<string, { score: number, details: any }> }>()

    const sortedLogs = [...detectorLogs].sort((a, b) => b.timestamp - a.timestamp)

    for (const log of sortedLogs) {
      const timeWindow = Math.floor(log.timestamp / 5000) * 5000
      const key = `${log.domain}-${timeWindow}`

      if (!groups.has(key)) {
        groups.set(key, {
          domain: log.domain,
          timestamp: log.timestamp,
          wss: 0,
          detectors: {}
        })
      }

      const group = groups.get(key)!
      group.detectors[log.detector] = { score: log.score, details: log.details || {} }
    }

    const weights: Record<string, number> = {
      reputation: 0.30,
      tracking: 0.30,
      cookies: 0.20,
      inputs: 0.15,
      policy: 0.05,
      permissions: 0
    }

    const getSafetyLevel = (wss: number): string => {
      if (wss >= 80) return "Excellent"
      if (wss >= 60) return "Good"
      if (wss >= 40) return "Fair"
      if (wss >= 20) return "Poor"
      return "Critical"
    }

    const visits: SiteVisit[] = []

    for (const group of groups.values()) {
      let totalScore = 0
      let totalWeight = 0

      for (const [detector, data] of Object.entries(group.detectors)) {
        const weight = weights[detector as DetectorType] || 0
        totalScore += data.score * weight
        totalWeight += weight
      }

      // Prefer the canonical WSS from the site cache (computed by the
      // background scorer) so the table always matches the popup/side panel
      // for the same site. Fall back to a local weighted average only for
      // domains the cache no longer holds (e.g. after a cache clear).
      const wss = siteCache[group.domain]?.wss ?? (totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0)
      const safetyLevel = getSafetyLevel(wss)
      
      const cachedDetails = siteCache[group.domain]?.detectionDetails || {};

      const trackingDetails = Object.keys(group.detectors.tracking?.details || {}).length > 0 
        ? group.detectors.tracking?.details 
        : cachedDetails.tracking;

      const cookiesDetails = Object.keys(group.detectors.cookies?.details || {}).length > 0 
        ? group.detectors.cookies?.details 
        : cachedDetails.cookies;
      
      // The activity journal records the page state at navigation time only;
      // forms rendered later by SPAs (e.g. a multi-step signup that asks for
      // an SSN on a later step) appear in the site cache's latest analysis
      // instead. Prefer the fresher cache when it reports sensitive fields the
      // journal missed, so a site's details stay accurate after a re-analysis.
      const journalInputs = group.detectors.inputs?.details;
      const inputsDetails = (journalInputs?.sensitive ?? 0) > 0
        ? journalInputs
        : (cachedDetails.input?.sensitive ?? 0) > 0
          ? cachedDetails.input
          : journalInputs ?? cachedDetails.input;

      const policyDetails = Object.keys(group.detectors.policy?.details || {}).length > 0 
        ? group.detectors.policy?.details 
        : cachedDetails.policy;

      const reputationDetails = Object.keys(group.detectors.reputation?.details || {}).length > 0 && group.detectors.reputation?.details?.status
        ? group.detectors.reputation?.details 
        : { status: group.detectors.reputation?.score === 100 ? 'Clean' : group.detectors.reputation?.score === 0 ? 'Blacklisted' : 'Suspicious' };

      const enriched = siteCache[group.domain]?.enrichedDetails

      const trackersCount = enriched?.trackers?.summary?.total ?? trackingDetails?.trackerCount ?? trackingDetails?.count ?? 0
      const cookiesCount = enriched?.cookies?.summary?.total ?? cookiesDetails?.tracking ?? 0
      const sensitiveInputsCount = inputsDetails?.sensitive ?? 0
      const reputationStatus = reputationDetails?.status ?? "Unknown"
      const policyGrade = policyDetails?.grade ?? "N/A"

      const finalDetails = {
         tracking: { details: trackingDetails },
         cookies: { details: cookiesDetails },
         inputs: { details: inputsDetails },
         policy: { details: policyDetails },
         reputation: { details: reputationDetails }
      }

      const headersGrade = enriched?.headers?.summary?.grade ?? undefined
      const fingerprintingAttempts = enriched?.fingerprinting?.summary?.totalAttempts ?? undefined

      visits.push({
        id: `${group.domain}-${group.timestamp}`,
        domain: group.domain,
        timestamp: group.timestamp,
        wss,
        safetyLevel,
        trackers: trackersCount,
        cookies: cookiesCount,
        inputs: sensitiveInputsCount > 0 ? "Yes" : "No",
        reputation: reputationStatus,
        policy: policyGrade,
        headersGrade,
        fingerprintingAttempts,
        details: finalDetails
      })
    }

    return visits
  }, [detectorLogs, siteCache, t])

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 h-full">
          <RadialChartScore timeRange={timeRange} />
        </div>
        <div className="lg:col-span-2 h-full">
          <ChartAreaInteractive timeRange={timeRange} onTimeRangeChange={setTimeRange} />
        </div>
      </div>
      <SectionCards />
      <DataTable data={groupedVisits} siteCache={siteCache} />
    </>
  )
}
