import React, { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Badge } from "@/components/ui/badge"
import { useDetectorLogs, useActivityLogs, useSiteCache, useAppState, useSettings } from "@/lib/useStorage"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatCard } from "@/components/ui/stat-card"
import {
  ShieldUser,
  OctagonAlert,
  Target,
  Cookie,
  Eye,
  FileText,
  Lock,
  Key,
  Activity,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { isThreatLog } from "@/lib/risk-utils"

// ─── Semantic color palette (detector-aware) ───────────────────────────────
// Using standard shadcn theme colors
const DETECTOR_COLORS: Record<string, string> = {
  tracking:    "var(--chart-1)",
  cookies:     "var(--chart-2)",
  inputs:      "var(--chart-3)",
  reputation:  "var(--chart-4)",
  policy:      "var(--chart-5)",
}

const DETECTOR_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tracking:    Activity,
  cookies:     Cookie,
  inputs:      Key,
  reputation:  ShieldUser,
  policy:      FileText,
}

const DETECTOR_LABELS: Record<string, string> = {
  tracking:    "Tracking",
  cookies:     "Cookies",
  inputs:      "Input Fields",
  reputation:  "Reputation",
  policy:      "Privacy Policy",
}

// WSS bucket color palette (mirrors the safety badge semantics used
// elsewhere in the app: excellent/good = success, fair = warning,
// poor = alert, critical = destructive)
const WSS_COLORS: Record<string, string> = {
  Critical:  "var(--destructive)",
  Poor:      "var(--alert)",
  Fair:      "var(--warning)",
  Good:      "var(--success)",
  Excellent: "var(--success)",
}

// PII sensitivity colors
const PII_COLORS: Record<string, string> = {
  HIGH:   "var(--destructive)",
  MEDIUM: "var(--warning)",
  LOW:    "var(--muted-foreground)",
}

// Chart configs
const getActivityConfig = (t: any): ChartConfig => ({
  events: { label: t("Events Detected"), color: "var(--primary)" }
})

const leaderboardConfig = {
  count: { label: "Threats Blocked", color: "var(--primary)" }
} satisfies ChartConfig

const getPieChartConfig = (t: any): ChartConfig => ({
  tracking:    { label: t("Tracking"),    color: DETECTOR_COLORS.tracking },
  cookies:     { label: t("Cookies"),     color: DETECTOR_COLORS.cookies },
  inputs:      { label: t("Input Fields"), color: DETECTOR_COLORS.inputs },
  reputation:  { label: t("Reputation"),  color: DETECTOR_COLORS.reputation },
  policy:      { label: t("Privacy Policy"), color: DETECTOR_COLORS.policy },
})

const getWssConfig = (t: any): ChartConfig => ({
  count: { label: t("Sites"), color: "var(--primary)" }
})

const toLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ─── Small helper components ────────────────────────────────────────────────

function EmptyState({ icon: Icon, title, description }: { icon: React.ComponentType<{ className?: string }>; title: string; description: string }) {
    const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
      <div className="p-3 rounded-full bg-muted/50">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{description}</p>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function RankingsPage() {
  const { t } = useTranslation()
  const rawLogs = useDetectorLogs()
  // Only actual privacy findings count as "threats" — every page visit
  // otherwise produces one routine (often "all clear") log per detector.
  const logs = useMemo(() => rawLogs.filter(l => l.detector !== 'permissions' && isThreatLog(l)), [rawLogs])
  const piiLogs = useActivityLogs()
  const { sites } = useSiteCache()
  const settings = useSettings()

  const [timeRange, setTimeRange] = useState("1d")

  // ── 1. Hero KPIs ────────────────────────────────────────────────────────
  const heroStats = useMemo(() => {
    const totalThreats = logs.length

    // Top offender: domain with most log entries
    const domainCounts: Record<string, number> = {}
    logs.forEach(log => { domainCounts[log.domain] = (domainCounts[log.domain] || 0) + 1 })
    const topOffender = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    const totalPii = piiLogs.length

    const avgWSS = sites.length > 0
      ? Math.round(sites.reduce((sum, [_, d]) => sum + d.wss, 0) / sites.length)
      : null

    // Today vs yesterday for threats
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 86400000
    const todayThreats = logs.filter(l => l.timestamp >= startOfToday).length
    const yesterdayThreats = logs.filter(l => l.timestamp >= startOfYesterday && l.timestamp < startOfToday).length
    const threatTrend = yesterdayThreats === 0
      ? "—"
      : `${todayThreats >= yesterdayThreats ? "+" : ""}${Math.round(((todayThreats - yesterdayThreats) / yesterdayThreats) * 100)}%`
    const threatDirection = todayThreats >= yesterdayThreats ? "up" : "down"

    return { totalThreats, topOffender, totalPii, avgWSS, threatTrend, threatDirection }
  }, [logs, piiLogs, sites])

  // ── 2. Activity Chart (AreaChart) ─────────────────────────────────────
  const activityData = useMemo(() => {
    const daysToSubtract = timeRange === "1d" ? 1 : timeRange === "7d" ? 7 : 30
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    if (timeRange === "1d") {
      const formatHour = (h: number) => `${h % 12 || 12}:00 ${h >= 12 ? "PM" : "AM"}`
      const hours: Record<string, number> = {}
      for (let i = 0; i < 24; i++) hours[formatHour(i)] = 0
      logs.forEach(log => {
        const d = new Date(log.timestamp)
        if (d.getTime() >= today.getTime()) {
          const hourStr = formatHour(d.getHours())
          if (hours[hourStr] !== undefined) hours[hourStr]++
        }
      })
      return Object.entries(hours).map(([date, events]) => ({ date, events }))
    }

    const days: Record<string, number> = {}
    for (let i = daysToSubtract - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      days[d.toLocaleDateString(undefined, { month: "short", day: "numeric" })] = 0
    }
    const cutoff = today.getTime() - (daysToSubtract - 1) * 86400000
    logs.forEach(log => {
      const d = new Date(log.timestamp)
      if (d.getTime() >= cutoff) {
        const key = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
        if (days[key] !== undefined) days[key]++
      }
    })
    return Object.entries(days).map(([date, events]) => ({ date, events }))
  }, [logs, timeRange])

  // ── 3. Top Offenders ─────────────────────────────────────────────────
  const leaderboardData = useMemo(() => {
    const domainCounts: Record<string, number> = {}
    logs.forEach(log => {
      domainCounts[log.domain] = (domainCounts[log.domain] || 0) + 1
    })
    const sorted = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    const total = sorted.reduce((s, [_, c]) => s + c, 0)
    return sorted.map(([domain, count]) => ({
      domain,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      fill: "var(--primary)",
    }))
  }, [logs])

  // ── 4. Threat Categories (Pie) ────────────────────────────────────────
  const categoryData = useMemo(() => {
    const counts: Record<string, number> = {
      tracking: 0, cookies: 0, inputs: 0, reputation: 0, policy: 0
    }
    logs.forEach(log => { if (counts[log.detector] !== undefined) counts[log.detector]++ })
    return Object.entries(counts)
      .filter(([_, count]) => count > 0)
      .map(([name, value]) => ({ name, value, fill: DETECTOR_COLORS[name] }))
  }, [logs])

  const totalCategoryEvents = categoryData.reduce((s, d) => s + d.value, 0)

  // ── 5. Risk Breakdown Table ───────────────────────────────────────────
  const riskBreakdown = useMemo(() => {
    const stats: Record<string, { sum: number; count: number; events: number }> = {
      tracking:    { sum: 0, count: 0, events: 0 },
      cookies:     { sum: 0, count: 0, events: 0 },
      inputs:      { sum: 0, count: 0, events: 0 },
      reputation:  { sum: 0, count: 0, events: 0 },
      policy:      { sum: 0, count: 0, events: 0 },
    }
    logs.forEach(log => {
      if (stats[log.detector]) {
        stats[log.detector].sum += log.score
        stats[log.detector].count++
        stats[log.detector].events++
      }
    })
    return Object.entries(stats).map(([detector, data]) => {
      const avgSafety = data.count > 0 ? Math.round(data.sum / data.count) : 100
      const riskLevel =
        avgSafety >= 80 ? "Low" :
        avgSafety >= 50 ? "Medium" :
        avgSafety >= 20 ? "High" : "Critical"
      return { detector, avgSafety, events: data.events, riskLevel }
    }).sort((a, b) => {
      const order = ['tracking', 'cookies', 'inputs', 'reputation', 'policy']
      const indexA = order.indexOf(a.detector)
      const indexB = order.indexOf(b.detector)
      // If not in order list, push to end
      const posA = indexA === -1 ? 999 : indexA
      const posB = indexB === -1 ? 999 : indexB
      return posA - posB
    })
  }, [logs])

  // ── 6. PII / Sensitive Data ───────────────────────────────────────────
  const piiData = useMemo(() => {
    const counts: Record<string, { count: number; sensitivity: string; sites: Set<string> }> = {}
    piiLogs.forEach(log => {
      const label = log.fieldType
      if (!counts[label]) counts[label] = { count: 0, sensitivity: log.sensitivity, sites: new Set() }
      counts[label].count++
      counts[label].sites.add(log.site)
    })
    return Object.entries(counts)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([type, data]) => ({
        type,
        count: data.count,
        sensitivity: data.sensitivity,
        siteCount: data.sites.size,
        fill: PII_COLORS[data.sensitivity] ?? PII_COLORS.LOW,
      }))
  }, [piiLogs])

  // ── 7. WSS Distribution ───────────────────────────────────────────────
  const wssData = useMemo(() => {
    const bins = { Critical: 0, Poor: 0, Fair: 0, Good: 0, Excellent: 0 }
    sites.forEach(([_, data]) => {
      const score = data.wss
      if (score < 20) bins.Critical++
      else if (score < 40) bins.Poor++
      else if (score < 60) bins.Fair++
      else if (score < 80) bins.Good++
      else bins.Excellent++
    })
    const total = Object.values(bins).reduce((s, v) => s + v, 0)
    return Object.entries(bins).map(([category, count]) => ({
      category,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      fill: WSS_COLORS[category],
    }))
  }, [sites])

  const wssTotalSites = sites.length

  return (
    <div className="flex flex-col gap-4 md:gap-6 @container/main">

      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("Rankings & Stats")}</h1>
        <p className="text-muted-foreground mt-2">
          {t("In-depth analytics and gamified rankings of your privacy data.")}
        </p>
      </div>

      {/* ── Hero KPI Row ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <StatCard
          title={t("Total Threats Blocked")}
          value={heroStats.totalThreats.toLocaleString()}
          subtitle={t("Detected privacy risk events")}
          trend={{
            direction: heroStats.threatDirection as "up" | "down",
            value: heroStats.threatTrend,
            isPositive: heroStats.threatDirection === "down",
          }}
        />
        <StatCard
          title={t("Top Offender")}
          value={heroStats.topOffender ? heroStats.topOffender.replace(/^www\./, "") : "—"}
          subtitle={heroStats.topOffender ? t("Most threats from one domain") : t("No data yet")}
        />
        <StatCard
          title={t("PII Exposures")}
          value={heroStats.totalPii.toLocaleString()}
          subtitle={t("Sensitive field entries detected")}
        />
        <StatCard
          title={t("Avg. Site Safety")}
          value={heroStats.avgWSS !== null ? `${heroStats.avgWSS}/100` : "—"}
          subtitle={
            heroStats.avgWSS !== null
              ? heroStats.avgWSS >= 80 ? t("Excellent — keep it up!")
              : heroStats.avgWSS >= 60 ? t("Good — room to improve")
              : heroStats.avgWSS >= 40 ? t("Fair — some risky sites")
              : t("Poor — avoid sensitive actions")
              : t("Visit some websites first")
          }
        />
      </div>

      {/* ── Main 2-col grid ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">

        {/* 1. Activity Volume, full width, AreaChart */}
        <Card className="col-span-1 md:col-span-2 @container/card">
          <CardHeader className="relative">
            <CardTitle>{t("Activity Volume")}</CardTitle>
            <CardDescription>
              <span className="@[540px]/card:block hidden">
                {t("Volume of privacy risks detected")}{" "}
                {timeRange === "1d" ? t("today") : timeRange === "7d" ? t("over the last 7 days") : t("over the last 30 days")}
              </span>
              <span className="@[540px]/card:hidden">
                {timeRange === "1d" ? t("Today") : timeRange === "7d" ? t("Last 7 days") : t("Last 30 days")}
              </span>
            </CardDescription>
            <div className="absolute right-4 top-4">
              <ToggleGroup
                type="single"
                value={timeRange}
                onValueChange={val => val && setTimeRange(val)}
                variant="outline"
                className="@[767px]/card:flex hidden"
              >
                <ToggleGroupItem value="1d" className="h-8 px-2.5">{t("Today")}</ToggleGroupItem>
                <ToggleGroupItem value="7d" className="h-8 px-2.5">{t("Last 7 days")}</ToggleGroupItem>
                <ToggleGroupItem value="30d" className="h-8 px-2.5">{t("Last 30 days")}</ToggleGroupItem>
              </ToggleGroup>
              <Select value={timeRange} onValueChange={setTimeRange}>
                <SelectTrigger className="@[767px]/card:hidden flex w-40" aria-label="Select a time range">
                  <SelectValue placeholder={t("Last 7 days")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">{t("Today")}</SelectItem>
                  <SelectItem value="7d">{t("Last 7 days")}</SelectItem>
                  <SelectItem value="30d">{t("Last 30 days")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {activityData.every(d => d.events === 0) ? (
              <EmptyState icon={Activity} title={t("No activity yet")} description={t("Threats will appear here as you browse the web.")} />
            ) : (
              <ChartContainer config={getActivityConfig(t)} className="h-56 w-full">
                <AreaChart data={activityData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillEvents" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickMargin={8} minTickGap={30} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickMargin={8} allowDecimals={false} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                  <Area dataKey="events" type="monotone" fill="url(#fillEvents)" stroke="var(--primary)" strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* 2. Top Offenders Leaderboard, full width */}
        <Card className="col-span-1 md:col-span-2">
          <CardHeader>
            <CardTitle>{t("Top Offenders Leaderboard")}</CardTitle>
            <CardDescription>{t("Domains responsible for the most privacy threats across all categories")}</CardDescription>
          </CardHeader>
          <CardContent>
            {leaderboardData.length === 0 ? (
              <EmptyState icon={Target} title={t("No threats recorded yet")} description={t("Leaderboard will populate as you visit websites.")} />
            ) : (
              <div className="space-y-3">
                {leaderboardData.map((entry, i) => {
                  return (
                    <div key={entry.domain} className="flex items-center gap-3">
                      {/* Rank */}
                      <span className="text-sm w-4 text-center text-muted-foreground flex-shrink-0 font-medium">
                        {i + 1}.
                      </span>
                      {/* Domain */}
                      <div className="flex items-center gap-2 w-40 flex-shrink-0">
                        <span className="text-sm font-medium truncate" title={entry.domain}>
                          {entry.domain.replace(/^www\./, "")}
                        </span>
                      </div>
                      {/* Progress bar */}
                      <div className="flex-1 relative">
                        <div
                          className="h-7 rounded-md transition-all duration-500 bg-primary"
                          style={{
                            width: `${Math.max(entry.pct, 4)}%`,
                            opacity: 1 - i * 0.15,
                          }}
                        />
                      </div>
                      {/* Stats */}
                      <div className="flex items-center gap-3 flex-shrink-0 text-right">
                        <span className="text-sm font-bold tabular-nums">{entry.count}</span>
                        <span className="text-xs text-muted-foreground tabular-nums w-8">
                          {entry.pct}%
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 3. Threat Categories, half width, color-coded pie */}
        <Card>
          <CardHeader>
            <CardTitle>{t("Threat Categories")}</CardTitle>
            <CardDescription>{t("Distribution of threats by detector type")}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center items-center pb-0">
            {categoryData.length === 0 ? (
              <EmptyState icon={ShieldUser} title={t("No threats detected yet")} description={t("Category breakdown will appear after browsing.")} />
            ) : (
              <ChartContainer config={getPieChartConfig(t)} className="h-72 w-full">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Pie
                    data={categoryData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={95}
                    stroke="var(--background)"
                    strokeWidth={2}
                    paddingAngle={2}
                  >
                    {categoryData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill="var(--primary)" fillOpacity={1 - index * 0.15} />
                    ))}
                  </Pie>
                  {/* Center label */}
                  <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle">
                    <tspan x="50%" dy="-0.25em" className="fill-foreground text-2xl font-bold">
                      {totalCategoryEvents}
                    </tspan>
                    <tspan x="50%" dy="1.4em" className="fill-muted-foreground text-[11px]">
                      {t("total events")}
                    </tspan>
                  </text>
                </PieChart>
              </ChartContainer>
            )}
            {/* Legend */}
            {categoryData.length > 0 && (
              <div className="sr-only">
                {categoryData.map(d => `${d.name}: ${d.value}`).join(", ")}
              </div>
            )}
          </CardContent>
          {categoryData.length > 0 && (
            <div className="px-6 pb-4 flex flex-wrap gap-x-4 gap-y-1.5 justify-center">
              {categoryData.map((d, index) => (
                <div key={d.name} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 bg-primary" style={{ opacity: 1 - index * 0.15 }} />
                  <span className="text-xs text-muted-foreground">{t(DETECTOR_LABELS[d.name] || d.name)}</span>
                  <span className="text-xs font-semibold tabular-nums">{d.value}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 4. Risk Breakdown Table */}
        <Card>
          <CardHeader>
            <CardTitle>{t("Risk Breakdown by Category")}</CardTitle>
            <CardDescription>{t("Avg. safety score and event count per threat detector")}</CardDescription>
          </CardHeader>
          <CardContent>
            {riskBreakdown.every(r => r.events === 0) ? (
              <EmptyState icon={ShieldUser} title={t("All clear")} description={t("Risk breakdown will appear after browsing.")} />
            ) : (
              <div className="space-y-3">
                {riskBreakdown.map(row => {
                  const Icon = DETECTOR_ICONS[row.detector] ?? Activity
                  return (
                    <div key={row.detector} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                          <span className="text-sm font-medium">{t(DETECTOR_LABELS[row.detector] || row.detector)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {row.events > 0 ? `${row.events} ${t("events")}` : t("No data")}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-xs px-1.5 py-0"
                          >
                            {t(row.riskLevel)}
                          </Badge>
                        </div>
                      </div>
                      {/* Safety score bar */}
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn("h-full rounded-full transition-all duration-500 bg-primary", row.events > 0 ? "opacity-80" : "opacity-20")}
                            style={{
                              width: `${row.events > 0 ? row.avgSafety : 100}%`,
                            }}
                          />
                        </div>
                        <span className={cn("text-xs font-semibold tabular-nums w-12 text-right", row.events > 0 ? "text-foreground" : "text-muted-foreground")}>
                          {row.events > 0 ? `${row.avgSafety}/100` : "—"}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 5. Sensitive Data Targeted, half width */}
        <Card>
          <CardHeader>
            <CardTitle>{t("Sensitive Data Targeted")}</CardTitle>
            <CardDescription>{t("Types of personal info most frequently entered on tracked sites")}</CardDescription>
          </CardHeader>
          <CardContent>
            {piiData.length === 0 ? (
              <EmptyState
                icon={Lock}
                title={t("No PII detections recorded")}
                description={
                  settings?.enablePIIDetection === false
                    ? t("Enable PII detection in settings to track sensitive form entries.")
                    : t("No sensitive form entries have been detected yet.")
                }
              />
            ) : (
              <div className="space-y-3">
                {piiData.map((entry, index) => (
                  <div key={entry.type} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0 bg-primary"
                          style={{ opacity: 1 - index * 0.2 }}
                        />
                        <span className="text-sm font-medium">{toLabel(t(entry.type))}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {entry.siteCount} {entry.siteCount === 1 ? t("site") : t("sites")}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums ml-2">
                          {entry.count}×
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500 bg-primary"
                        style={{
                          width: `${Math.max((entry.count / (piiData[0]?.count || 1)) * 100, 4)}%`,
                          opacity: 1 - index * 0.2,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 6. WSS Distribution, half width, color-coded bins */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>{t("Web Safety Score Distribution")}</CardTitle>
                <CardDescription>{t("Safety ratings across all sites you've visited")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {wssTotalSites === 0 ? (
              <EmptyState icon={ShieldUser} title={t("No sites analyzed yet")} description={t("Visit some websites and TraceGuard will score them here.")} />
            ) : (
              <ChartContainer config={getWssConfig(t)} className="h-56 w-full">
                <BarChart data={wssData} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="category" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickMargin={8} tickFormatter={(val) => t(val)} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickMargin={8} allowDecimals={false} />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)" }}
                    content={<ChartTooltipContent
                      hideIndicator
                      className="min-w-[100px] w-[100px]"
                      labelFormatter={(label) => t(label)}
                      formatter={(value) => [
                        `${value} ${value === 1 ? t("site") : t("sites")}`,
                        ""
                      ]}
                    />}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {wssData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                    <LabelList
                      dataKey="count"
                      position="top"
                      formatter={(val: number) => val > 0 ? `${val} ${val === 1 ? t("site") : t("sites")}` : ""}
                      className="fill-muted-foreground text-[11px] font-medium"
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
