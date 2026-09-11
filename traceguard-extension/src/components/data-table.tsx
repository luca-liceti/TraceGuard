"use client"

import * as React from "react"
import {
  ColumnDef,
} from "@tanstack/react-table"
import {
  AlertCircle,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  MoreVerticalIcon,
  PlusIcon,
  DownloadIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react"
import { z } from "zod"
import { format } from "date-fns"
import { toast } from "@/components/ui/toast"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { getGradeTextColor, getSafetyBgColor, getSafetyTextColor } from "@/lib/theme-utils"
import { getSafetyLevel } from "@/lib/risk-utils"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { storage } from "@/lib/storage"
import { downloadJson } from "@/lib/export"
import { ExportDataDialog } from "@/components/traceguard/export-data-dialog"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SiteDetailsPanel } from "@/components/traceguard/site-details-panel"
import { SiteRiskData } from "@/lib/types"
import { DomainGroup } from "@/lib/types"

export const schema = z.object({
  id: z.string().optional(),
  domain: z.string(),
  timestamp: z.number(),
  wss: z.number(),
  safetyLevel: z.string(),
  trackers: z.number(),
  cookies: z.number(),
  inputs: z.string(),
  reputation: z.string(),
  policy: z.string(),
  headersGrade: z.string().optional(),
  fingerprintingAttempts: z.number().optional(),
  details: z.any().optional(),
})

export type SiteVisit = z.infer<typeof schema>

// ── Safety level ordering for worst-case aggregation ────────────────────────
const SAFETY_ORDER: Record<string, number> = {
  Critical: 0,
  Poor: 1,
  Fair: 2,
  Good: 3,
  Excellent: 4,
}

const REPUTATION_ORDER: Record<string, number> = {
  Blacklisted: 0,
  Suspicious: 1,
  Clean: 2,
  Unknown: 3,
}

const GRADE_ORDER: Record<string, number> = {
  F: 0, E: 1, D: 2, C: 3, B: 4, A: 5, 'N/A': -1,
}

/**
 * Converts an array of SiteVisit rows for the same domain into a single
 * aggregated DomainGroup using the agreed-upon worst-case / avg / recency rules.
 */
export function buildDomainGroups(visits: SiteVisit[]): DomainGroup[] {
  const map = new Map<string, SiteVisit[]>()
  for (const v of visits) {
    const arr = map.get(v.domain) ?? []
    arr.push(v)
    map.set(v.domain, arr)
  }

  const groups: DomainGroup[] = []

  for (const [domain, domVisits] of map.entries()) {
    // Sort newest-first so [0] is the most recent visit
    const sorted = [...domVisits].sort((a, b) => b.timestamp - a.timestamp)
    const newest = sorted[0]

    // WSS: average
    const avgWss = Math.round(sorted.reduce((s, v) => s + v.wss, 0) / sorted.length)

    // Safety Level: worst-case
    const worstSafety = sorted.reduce((worst, v) => {
      return (SAFETY_ORDER[v.safetyLevel] ?? 99) < (SAFETY_ORDER[worst] ?? 99)
        ? v.safetyLevel
        : worst
    }, sorted[0].safetyLevel)

    // Trackers: max
    const maxTrackers = Math.max(...sorted.map(v => v.trackers))

    // Cookies: max
    const maxCookies = Math.max(...sorted.map(v => v.cookies))

    // PII: "Yes" if any visit had Yes
    const anyPii = sorted.some(v => v.inputs === "Yes" || v.inputs === "Sì" || v.inputs?.toLowerCase() === "yes")
      ? sorted.find(v => v.inputs === "Yes" || v.inputs === "Sì" || v.inputs?.toLowerCase() === "yes")!.inputs
      : sorted[0].inputs

    // Reputation: worst-case
    const worstReputation = sorted.reduce((worst, v) => {
      return (REPUTATION_ORDER[v.reputation] ?? 99) < (REPUTATION_ORDER[worst] ?? 99)
        ? v.reputation
        : worst
    }, sorted[0].reputation)

    // Policy: most recent
    const latestPolicy = newest.policy

    // Headers: most recent
    const latestHeaders = newest.headersGrade

    // Fingerprinting: max
    const maxFp = sorted.reduce((m, v) => Math.max(m, v.fingerprintingAttempts ?? 0), 0)

    const summary: SiteVisit = {
      id: `group-${domain}`,
      domain,
      timestamp: newest.timestamp,
      wss: avgWss,
      safetyLevel: worstSafety,
      trackers: maxTrackers,
      cookies: maxCookies,
      inputs: anyPii,
      reputation: worstReputation,
      policy: latestPolicy,
      headersGrade: latestHeaders,
      fingerprintingAttempts: maxFp || undefined,
      details: newest.details,
    }

    groups.push({ domain, visitCount: sorted.length, summary, visits: sorted })
  }

  // Sort groups by most recent visit timestamp descending
  groups.sort((a, b) => b.summary.timestamp - a.summary.timestamp)
  return groups
}

// ── Column definitions (shared for both parent and child rows) ───────────────
const getColumns = (t: any): ColumnDef<SiteVisit>[] => [
  {
    accessorKey: "domain",
    header: t("Domain"),
    cell: ({ row }) => <div className="font-medium">{row.getValue("domain")}</div>,
  },
  {
    accessorKey: "timestamp",
    header: t("Visit Time"),
    cell: ({ row }) => {
      return (
        <div className="text-muted-foreground">
          {format(new Date(row.getValue("timestamp")), "MMM d, yyyy HH:mm:ss")}
        </div>
      )
    },
  },
  {
    accessorKey: "safetyLevel",
    header: t("Safety Level"),
    cell: ({ row }) => {
      const level = row.getValue("safetyLevel") as string
      return (
        <Badge variant="secondary" className={`px-2.5 py-0.5 ${getSafetyBgColor(level)} ${getSafetyTextColor(level)}`}>
          {t(level)}
        </Badge>
      )
    },
  },
  {
    accessorKey: "trackers",
    header: t("Trackers"),
    cell: ({ row }) => <div>{row.getValue("trackers")}</div>,
  },
  {
    accessorKey: "cookies",
    header: t("Cookies"),
    cell: ({ row }) => <div>{row.getValue("cookies")}</div>,
  },
  {
    accessorKey: "inputs",
    header: t("PII Risk"),
    cell: ({ row }) => <div>{t(row.getValue("inputs") as string)}</div>,
  },
  {
    accessorKey: "reputation",
    header: t("Reputation"),
    cell: ({ row }) => <div>{t(row.getValue("reputation") as string)}</div>,
  },
  {
    accessorKey: "policy",
    header: t("Policy"),
    cell: ({ row }) => {
      const grade = row.getValue("policy") as string
      return <div className={`font-semibold ${getGradeTextColor(grade)}`}>{t(grade)}</div>
    },
  },
  {
    accessorKey: "headersGrade",
    header: t("Headers"),
    cell: ({ row }) => {
      const grade = row.getValue("headersGrade") as string | undefined
      if (!grade) return <div className="text-muted-foreground text-xs">—</div>
      return <div className={`font-semibold ${getGradeTextColor(grade)}`}>{grade}</div>
    },
  },
  {
    accessorKey: "fingerprintingAttempts",
    header: t("Fingerprinting"),
    cell: ({ row }) => {
      const count = row.getValue("fingerprintingAttempts") as number | undefined
      if (count === undefined || count === null) return <div className="text-muted-foreground text-xs">—</div>
      if (count === 0) return <div>0</div>
      return (
        <Badge variant="secondary" className="text-xs bg-warning/20 text-warning border-transparent">
          {count}
        </Badge>
      )
    },
  },
  {
    id: "actions",
    header: t("Actions"),
    cell: ({ row, table }) => {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex size-8 text-muted-foreground data-[state=open]:bg-muted"
              size="icon"
            >
              <MoreVerticalIcon className="size-4" />
              <span className="sr-only">{t("Open menu")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem onClick={() => (table.options.meta as any)?.onViewDetails(row.original)}>
              {t("View details")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => (table.options.meta as any)?.onExportLog(row.original)}>
              {t("Export")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem 
              className="text-destructive focus:text-destructive"
              onClick={() => (table.options.meta as any)?.onDeleteLog(row.original)}
            >
              {t("Delete log")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  },
]

// ── Grouped row renderer ─────────────────────────────────────────────────────

interface GroupedTableBodyProps {
  groups: DomainGroup[]
  columns: ColumnDef<SiteVisit>[]
  expandedDomains: Set<string>
  onToggle: (domain: string) => void
  onViewDetails: (visit: SiteVisit) => void
  onExportLog: (visit: SiteVisit) => void
  onDeleteLog: (visit: SiteVisit) => void
  t: (key: string, opts?: any) => string
}

function GroupedTableBody({
  groups,
  columns,
  expandedDomains,
  onToggle,
  onViewDetails,
  onExportLog,
  onDeleteLog,
  t,
}: GroupedTableBodyProps) {
  const colCount = columns.length

  if (groups.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={colCount} className="h-24 text-center">
          {t("No logs found.")}
        </TableCell>
      </TableRow>
    )
  }

  return (
    <>
      {groups.map((group) => {
        const isExpanded = expandedDomains.has(group.domain)
        const isMulti = group.visitCount > 1
        const s = group.summary

        return (
          <React.Fragment key={group.domain}>
            {/* ── Parent / Summary Row ─────────────────────────────────── */}
            <TableRow
              className={`transition-colors ${isMulti ? "cursor-pointer hover:bg-muted/60" : ""}`}
              onClick={() => isMulti && onToggle(group.domain)}
              onKeyDown={(e) => {
                if (isMulti && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault()
                  onToggle(group.domain)
                }
              }}
              tabIndex={isMulti ? 0 : undefined}
              role={isMulti ? "button" : undefined}
              aria-expanded={isMulti ? isExpanded : undefined}
            >
              {/* Domain cell with expand toggle */}
              <TableCell>
                <div className="flex items-center gap-2">
                  {isMulti ? (
                    <span
                      className="flex-shrink-0 text-muted-foreground transition-transform duration-200"
                      style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}
                    >
                      <ChevronRightIcon className="size-3.5" />
                    </span>
                  ) : (
                    <span className="flex-shrink-0 w-3.5" />
                  )}
                  <span className="font-medium">{s.domain}</span>
                  {isMulti && (
                    <Badge
                      variant="secondary"
                      className="ml-1 text-[10px] px-1.5 py-0 h-4 font-mono tabular-nums bg-muted text-muted-foreground"
                    >
                      ×{group.visitCount}
                    </Badge>
                  )}
                </div>
              </TableCell>

              {/* Visit Time: most recent */}
              <TableCell>
                <div className="text-muted-foreground text-xs">
                  {format(new Date(s.timestamp), "MMM d, yyyy HH:mm:ss")}
                </div>
              </TableCell>

              {/* Safety Level: worst-case */}
              <TableCell>
                <Badge
                  variant="secondary"
                  className={`px-2.5 py-0.5 ${getSafetyBgColor(s.safetyLevel)} ${getSafetyTextColor(s.safetyLevel)}`}
                >
                  {t(s.safetyLevel)}
                </Badge>
              </TableCell>

              {/* Trackers: max */}
              <TableCell>
                <div className="flex items-center gap-1">
                  <span>{s.trackers}</span>
                  {isMulti && s.trackers > 0 && (
                    <span className="text-[10px] text-muted-foreground">{t("max")}</span>
                  )}
                </div>
              </TableCell>

              {/* Cookies: max */}
              <TableCell>
                <div className="flex items-center gap-1">
                  <span>{s.cookies}</span>
                  {isMulti && s.cookies > 0 && (
                    <span className="text-[10px] text-muted-foreground">{t("max")}</span>
                  )}
                </div>
              </TableCell>

              {/* PII Risk: any Yes wins */}
              <TableCell>
                <div>{t(s.inputs)}</div>
              </TableCell>

              {/* Reputation: worst-case */}
              <TableCell>
                <div>{t(s.reputation)}</div>
              </TableCell>

              {/* Policy: most recent */}
              <TableCell>
                <div className={`font-semibold ${getGradeTextColor(s.policy)}`}>{t(s.policy)}</div>
              </TableCell>

              {/* Headers: most recent */}
              <TableCell>
                {s.headersGrade
                  ? <div className={`font-semibold ${getGradeTextColor(s.headersGrade)}`}>{s.headersGrade}</div>
                  : <div className="text-muted-foreground text-xs">—</div>
                }
              </TableCell>

              {/* Fingerprinting: max */}
              <TableCell>
                {s.fingerprintingAttempts === undefined || s.fingerprintingAttempts === null
                  ? <div className="text-muted-foreground text-xs">—</div>
                  : s.fingerprintingAttempts === 0
                    ? <div>0</div>
                    : (
                      <Badge variant="secondary" className="text-xs bg-warning/20 text-warning border-transparent">
                        {s.fingerprintingAttempts}
                      </Badge>
                    )
                }
              </TableCell>

              {/* Actions */}
              <TableCell onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="flex size-8 text-muted-foreground data-[state=open]:bg-muted"
                      size="icon"
                    >
                      <MoreVerticalIcon className="size-4" />
                      <span className="sr-only">{t("Open menu")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32">
                    <DropdownMenuItem onClick={() => onViewDetails(s)}>
                      {t("View details")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onExportLog(s)}>
                      {t("Export")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDeleteLog(s)}
                    >
                      {t("Delete log")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>

            {/* ── Child / Individual Visit Rows (expanded only) ─────────── */}
            {isMulti && isExpanded && group.visits.map((visit, idx) => (
              <TableRow
                key={visit.id ?? `${visit.domain}-${visit.timestamp}`}
                className="bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                {/* Domain cell with indent + left border accent */}
                <TableCell>
                  <div className="flex items-center gap-2 pl-7">
                    <span className="border-l-2 border-muted-foreground/30 pl-2 text-sm text-muted-foreground">
                      {visit.domain}
                    </span>
                    {idx === 0 && (
                      <Badge className="text-[10px] px-1.5 py-0 h-4 font-medium bg-primary/15 text-primary border-primary/30 hover:bg-primary/15">
                        {t("Latest")}
                      </Badge>
                    )}
                  </div>
                </TableCell>

                {/* Visit time */}
                <TableCell>
                  <div className="text-muted-foreground text-xs">
                    {format(new Date(visit.timestamp), "MMM d, yyyy HH:mm:ss")}
                  </div>
                </TableCell>

                {/* Safety Level */}
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={`px-2 py-0 text-xs ${getSafetyBgColor(visit.safetyLevel)} ${getSafetyTextColor(visit.safetyLevel)}`}
                  >
                    {t(visit.safetyLevel)}
                  </Badge>
                </TableCell>

                {/* Trackers */}
                <TableCell><div className="text-sm">{visit.trackers}</div></TableCell>

                {/* Cookies */}
                <TableCell><div className="text-sm">{visit.cookies}</div></TableCell>

                {/* PII */}
                <TableCell><div className="text-sm">{t(visit.inputs)}</div></TableCell>

                {/* Reputation */}
                <TableCell><div className="text-sm">{t(visit.reputation)}</div></TableCell>

                {/* Policy */}
                <TableCell>
                  <div className={`font-semibold text-sm ${getGradeTextColor(visit.policy)}`}>{t(visit.policy)}</div>
                </TableCell>

                {/* Headers */}
                <TableCell>
                  {visit.headersGrade
                    ? <div className={`font-semibold text-sm ${getGradeTextColor(visit.headersGrade)}`}>{visit.headersGrade}</div>
                    : <div className="text-muted-foreground text-xs">—</div>
                  }
                </TableCell>

                {/* Fingerprinting */}
                <TableCell>
                  {visit.fingerprintingAttempts === undefined || visit.fingerprintingAttempts === null
                    ? <div className="text-muted-foreground text-xs">—</div>
                    : visit.fingerprintingAttempts === 0
                      ? <div className="text-sm">0</div>
                      : (
                        <Badge variant="secondary" className="text-xs bg-warning/20 text-warning border-transparent">
                          {visit.fingerprintingAttempts}
                        </Badge>
                      )
                  }
                </TableCell>

                {/* Actions */}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        className="flex size-8 text-muted-foreground data-[state=open]:bg-muted"
                        size="icon"
                      >
                        <MoreVerticalIcon className="size-4" />
                        <span className="sr-only">{t("Open menu")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-32">
                      <DropdownMenuItem onClick={() => onViewDetails(visit)}>
                        {t("View details")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onExportLog(visit)}>
                        {t("Export")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDeleteLog(visit)}
                      >
                        {t("Delete log")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </React.Fragment>
        )
      })}
    </>
  )
}

// ── Main DataTable component ─────────────────────────────────────────────────

export function DataTable({
  data,
  siteCache = {},
  domainGroups,
}: {
  data: SiteVisit[]
  siteCache?: Record<string, SiteRiskData>
  /** Pre-built domain groups. If omitted, groups are built from `data`. */
  domainGroups?: DomainGroup[]
}) {
  const { t } = useTranslation()
  const columns = React.useMemo(() => getColumns(t), [t])

  // Build groups if not provided
  const groups = React.useMemo<DomainGroup[]>(() => {
    return domainGroups ?? buildDomainGroups(data)
  }, [domainGroups, data])

  // Filter state, we filter groups by domain name
  const [domainFilter, setDomainFilter] = React.useState("")
  const filteredGroups = React.useMemo(() => {
    if (!domainFilter) return groups
    const q = domainFilter.toLowerCase()
    return groups.filter(g => g.domain.toLowerCase().includes(q))
  }, [groups, domainFilter])

  // Pagination (operates on filteredGroups)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(10)
  const pageCount = Math.max(1, Math.ceil(filteredGroups.length / pageSize))
  const pagedGroups = filteredGroups.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)

  // Accordion expand state
  const [expandedDomains, setExpandedDomains] = React.useState<Set<string>>(new Set())
  const allExpandable = pagedGroups.filter(g => g.visitCount > 1).map(g => g.domain)
  const allExpanded = allExpandable.length > 0 && allExpandable.every(d => expandedDomains.has(d))

  const toggleDomain = (domain: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedDomains(new Set())
    } else {
      setExpandedDomains(new Set(allExpandable))
    }
  }

  const [isAddLogOpen, setIsAddLogOpen] = React.useState(false)
  const [exportDataOpen, setExportDataOpen] = React.useState(false)
  const [selectedVisit, setSelectedVisit] = React.useState<SiteVisit | null>(null)
  const [isDetailsOpen, setIsDetailsOpen] = React.useState(false)
  const [highlightSection, setHighlightSection] = React.useState<string | undefined>(undefined)
  const [searchParams, setSearchParams] = useSearchParams()

  React.useEffect(() => {
    const domainToView = searchParams.get('viewSite')
    // Optional deep-link target, e.g. `section=inputs` from a PII notification
    const sectionToView = searchParams.get('section') ?? undefined
    if (!domainToView) return

    // Prefer the journal row, then fall back to the site cache (detector logs
    // are capped at ~200 visits, so a notification for an older site would
    // otherwise silently do nothing).
    const visit = data.find(v => v.domain === domainToView)
    let opened = false
    if (visit) {
      setSelectedVisit(visit)
      opened = true
    } else {
      const cached = siteCache[domainToView]
      if (cached) {
        const levelName = ({
          excellent: "Excellent",
          good: "Good",
          fair: "Fair",
          poor: "Poor",
          critical: "Critical",
        } as const)[getSafetyLevel(cached.wss)]
        setSelectedVisit({
          id: `cached-${domainToView}`,
          domain: domainToView,
          timestamp: typeof cached.lastAnalyzed === 'number' ? cached.lastAnalyzed : Date.now(),
          wss: cached.wss,
          safetyLevel: levelName,
          trackers: cached.enrichedDetails?.trackers?.summary?.total ?? 0,
          cookies: cached.enrichedDetails?.cookies?.summary?.total ?? 0,
          inputs: (cached.detectionDetails?.input?.sensitive ?? 0) > 0 ? "Yes" : "No",
          reputation: cached.breakdown?.reputation === 100
            ? "Clean"
            : cached.breakdown?.reputation === 0 ? "Blacklisted" : "Suspicious",
          policy: cached.detectionDetails?.policy?.grade ?? "N/A",
        })
        opened = true
      }
    }
    if (opened) {
      setHighlightSection(sectionToView)
      setIsDetailsOpen(true)
      searchParams.delete('viewSite')
      searchParams.delete('section')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, data, siteCache, setSearchParams])

  // Reset to first page when filter or page size changes
  React.useEffect(() => { setPageIndex(0) }, [domainFilter, pageSize])

  const handleViewDetails = (visit: SiteVisit) => {
    setSelectedVisit(visit)
    setHighlightSection(undefined)
    setIsDetailsOpen(true)
  }

  const handleAddLogSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const formData = new FormData(form)
    
    const domain = formData.get('domain') as string
    const wss = parseInt(formData.get('wss') as string, 10) || 0
    const trackers = parseInt(formData.get('trackers') as string, 10) || 0
    const cookies = parseInt(formData.get('cookies') as string, 10) || 0
    const reputation = formData.get('reputation') as string || 'Clean'
    const policy = formData.get('policy') as string || 'N/A'
    const inputs = formData.get('inputs') as string || 'No'

    // Create individual detector logs for aggregation. Written through the
    // storage helper so they are encrypted with the vault key like all other
    // logs (never plaintext).
    try {
      const key = await storage.getVaultKey()
      await storage.addDetectorLogs([
        { domain, detector: 'reputation', score: reputation === 'Clean' ? 100 : reputation === 'Suspicious' ? 50 : 0, details: { status: reputation }, message: `Reputation: ${reputation}` },
        { domain, detector: 'policy', score: policy === 'A' ? 100 : policy === 'B' ? 80 : policy === 'C' ? 60 : policy === 'D' ? 40 : policy === 'E' ? 20 : 0, details: { grade: policy }, message: `Policy grade: ${policy}` },
        { domain, detector: 'inputs', score: inputs === 'Yes' ? 0 : 100, details: { sensitive: inputs === 'Yes' ? 1 : 0 }, message: `Sensitive inputs: ${inputs}` },
        { domain, detector: 'tracking', score: Math.max(0, 100 - trackers * 10), details: { trackerCount: trackers }, message: `Trackers: ${trackers}` },
        { domain, detector: 'cookies', score: Math.max(0, 100 - cookies * 5), details: { tracking: cookies }, message: `Tracking cookies: ${cookies}` },
      ], key)

      setIsAddLogOpen(false)
      toast.add({ type: "success", title: t("Log added successfully") })
      form.reset()
    } catch (err) {
      console.error(err)
      toast.add({ type: "error", title: t("Failed to save manual log"), priority: "high" })
    }
  }

  const handleExportSingleLog = async (visit: SiteVisit) => {
    try {
      await downloadJson(
        JSON.stringify(visit, null, 2),
        `traceguard-log-${visit.domain}-${visit.timestamp}.json`
      )
      toast.add({ type: "success", title: t("Log exported successfully") })
    } catch (e) {
      console.error(e)
      toast.add({ type: "error", title: t("Failed to export log"), priority: "high" })
    }
  }

  const handleDeleteLog = async (visit: SiteVisit) => {
    try {
      const key = await storage.getVaultKey()
      const timeWindow = Math.floor(visit.timestamp / 5000) * 5000
      await storage.removeDetectorLogs((log: any) => {
        const logTimeWindow = Math.floor(log.timestamp / 5000) * 5000
        return log.domain === visit.domain && logTimeWindow === timeWindow
      }, key)
      toast.add({ type: "success", title: t("Log deleted successfully") })
    } catch (e) {
      console.error(e)
      toast.add({ type: "error", title: t("Failed to delete log"), priority: "high" })
    }
  }

  return (
    <ErrorBoundary fallback={
      <div className="flex w-full h-64 border rounded-md items-center justify-center text-muted-foreground gap-2">
        <AlertCircle className="h-6 w-6" />
        <p>{t("Failed to load activity logs table")}</p>
      </div>
    }>
    <div className="flex w-full flex-col gap-4">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex flex-1 items-center space-x-2">
          <Input
            placeholder={t("Search domain...")}
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            className="h-8 w-[150px] lg:w-[250px]"
          />
          {/* Expand / Collapse All, only shown when there are multi-visit groups */}
          {allExpandable.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={toggleAll}
              className="h-8 gap-1.5 text-xs text-muted-foreground"
            >
              {allExpanded
                ? <><ChevronsDownUpIcon className="size-3.5" /><span className="hidden sm:inline">{t("Collapse All")}</span></>
                : <><ChevronsUpDownIcon className="size-3.5" /><span className="hidden sm:inline">{t("Expand All")}</span></>
              }
            </Button>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => setExportDataOpen(true)}>
            <DownloadIcon />
            <span className="hidden lg:inline">{t("Export")}</span>
          </Button>
          <Dialog open={isAddLogOpen} onOpenChange={setIsAddLogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <PlusIcon />
                <span className="hidden lg:inline">{t("Add Log")}</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>{t("Add Manual Log")}</DialogTitle>
                <DialogDescription>
                  {t("Manually record a site visit and safety metrics.")}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAddLogSubmit} className="grid gap-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="domain">{t("Domain")}</Label>
                    <Input id="domain" name="domain" placeholder={t("example.com")} required />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="wss">{t("Safety Score")}</Label>
                    <Input id="wss" name="wss" type="number" placeholder="85" min="0" max="100" required />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="trackers">{t("Trackers Detected")}</Label>
                    <Input id="trackers" name="trackers" type="number" placeholder="0" min="0" required />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="cookies">{t("Cookies Detected")}</Label>
                    <Input id="cookies" name="cookies" type="number" placeholder="0" min="0" required />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="reputation">{t("Reputation")}</Label>
                    <Select required defaultValue="Clean" name="reputation">
                      <SelectTrigger id="reputation">
                        <SelectValue placeholder={t("Select")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Clean">{t("Clean")}</SelectItem>
                        <SelectItem value="Suspicious">{t("Suspicious")}</SelectItem>
                        <SelectItem value="Blacklisted">{t("Blacklisted")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="policy">{t("Policy Grade")}</Label>
                    <Select required defaultValue="N/A" name="policy">
                      <SelectTrigger id="policy">
                        <SelectValue placeholder={t("Select")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="A">A</SelectItem>
                        <SelectItem value="B">B</SelectItem>
                        <SelectItem value="C">C</SelectItem>
                        <SelectItem value="D">D</SelectItem>
                        <SelectItem value="E">E</SelectItem>
                        <SelectItem value="N/A">N/A</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="inputs">{t("Sensitive Inputs (PII Risk)")}</Label>
                  <Select required defaultValue="No" name="inputs">
                    <SelectTrigger id="inputs">
                      <SelectValue placeholder={t("Select")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Yes">{t("Yes (Risk Detected)")}</SelectItem>
                      <SelectItem value="No">{t("No (Safe)")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button type="submit">{t("Save log")}</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          {/* ── Export (shared dialog: full backup, optional encryption) ── */}
          <ExportDataDialog open={exportDataOpen} onOpenChange={setExportDataOpen} />
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => {
                const id = (col as any).accessorKey ?? (col as any).id
                const header = typeof col.header === "string" ? col.header : id
                return (
                  <TableHead key={id}>
                    {header}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            <GroupedTableBody
              groups={pagedGroups}
              columns={columns}
              expandedDomains={expandedDomains}
              onToggle={toggleDomain}
              onViewDetails={handleViewDetails}
              onExportLog={handleExportSingleLog}
              onDeleteLog={handleDeleteLog}
              t={t}
            />
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="hidden flex-1 text-sm text-muted-foreground lg:flex">
          {t("Showing {{length}} of {{total}} sites", {
            length: pagedGroups.length,
            total: filteredGroups.length,
          })}
        </div>
        <div className="flex w-full items-center gap-8 lg:w-fit">
          <div className="hidden items-center gap-2 lg:flex">
            <Label htmlFor="rows-per-page" className="text-sm font-medium">
              {t("Rows per page")}
            </Label>
            <Select
              value={`${pageSize}`}
              onValueChange={(value) => setPageSize(Number(value))}
            >
              <SelectTrigger className="w-20 h-8" id="rows-per-page">
                <SelectValue placeholder={pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 30, 40, 50].map((ps) => (
                  <SelectItem key={ps} value={`${ps}`}>{ps}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-fit items-center justify-center text-sm font-medium">
            {t("Page {{index}} of {{count}}", { index: pageIndex + 1, count: pageCount })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => setPageIndex(0)}
              disabled={pageIndex === 0}
            >
              <span className="sr-only">{t("Go to first page")}</span>
              <ChevronsLeftIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPageIndex(i => Math.max(0, i - 1))}
              disabled={pageIndex === 0}
            >
              <span className="sr-only">{t("Go to previous page")}</span>
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPageIndex(i => Math.min(pageCount - 1, i + 1))}
              disabled={pageIndex >= pageCount - 1}
            >
              <span className="sr-only">{t("Go to next page")}</span>
              <ChevronRightIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => setPageIndex(pageCount - 1)}
              disabled={pageIndex >= pageCount - 1}
            >
              <span className="sr-only">{t("Go to last page")}</span>
              <ChevronsRightIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <SiteDetailsPanel
        open={isDetailsOpen}
        onOpenChange={setIsDetailsOpen}
        domain={selectedVisit?.domain ?? ""}
        timestamp={selectedVisit?.timestamp ?? 0}
        wss={selectedVisit?.wss ?? 0}
        safetyLevel={selectedVisit?.safetyLevel ?? ""}
        siteData={selectedVisit ? (siteCache[selectedVisit.domain] ?? null) : null}
        legacyDetails={selectedVisit?.details}
        highlightSection={highlightSection}
      />
    </div>
    </ErrorBoundary>
  )
}
