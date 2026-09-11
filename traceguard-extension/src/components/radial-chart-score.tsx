import * as React from "react"
import { TrendingUp, TrendingDown, Activity } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useAppState, useScoreHistory } from "@/lib/useStorage"
import { getStatusConfig } from "@/lib/risk-utils"

// Ring geometry inside a 200x200 viewBox. Sized so the band fills the card the
// way the old radial chart did, with room for the number in the middle.
const RING_CENTER = 100
const RING_RADIUS = 82
const RING_STROKE = 18

// `pathLength` normalizes any circle to 100 units, so the score maps straight
// onto `strokeDashoffset` with no 2 * PI * r arithmetic.
const RING_PATH_LENGTH = 100

// The progress stroke ends in a rounded cap. At 100 the cap crosses the 12
// o'clock seam instead of butting against the start, which is how an Apple
// Fitness ring closes. The faint shadow is what makes that crossing legible:
// without it the cap and the start of the arc are the same color. Widen the
// offset, or drop this line, to change how pronounced the overlap looks.
const RING_SHADOW = "drop-shadow(0 1px 1px oklch(0 0 0 / 0.28))"

export function RadialChartScore({ timeRange = "30d" }: { timeRange?: string }) {
  const { t } = useTranslation()
  const state = useAppState()
  const history = useScoreHistory()
  const targetScore = !state ? 0 : (state.ups ?? 100)

  const [currentScore, setCurrentScore] = React.useState(0)

  React.useEffect(() => {
    const timer = setTimeout(() => setCurrentScore(targetScore), 100)
    return () => clearTimeout(timer)
  }, [targetScore])

  let days = 30;
  if (timeRange === "1d") days = 1;
  else if (timeRange === "7d") days = 7;

  const targetDate = new Date();
  targetDate.setHours(0, 0, 0, 0);
  if (days > 1) {
    targetDate.setDate(targetDate.getDate() - days);
  }

  // Anchor the change at the score the user had when the window STARTED (the
  // last recorded point before it), matching the area chart's series. Using
  // the first entry INSIDE the window would misattribute mid-window movement
  // to the window's start (e.g. a drop at 2pm would look like "no change").
  const beforeWindow = (history || []).filter(h => h.timestamp < targetDate.getTime())
  const anchorScore = beforeWindow.length > 0 ? beforeWindow[beforeWindow.length - 1].ups : 100

  const scoreChange = currentScore - anchorScore
  const isUp = scoreChange >= 0

  const timeText = timeRange === "1d" ? t("today") : timeRange === "7d" ? t("this week") : t("this month")

  // The band color lives on the gauge, never on the digits. The number is the
  // value, and `foreground` is the one token that passes contrast in both
  // themes, so the two surfaces that show it (this card and the side panel)
  // agree instead of drifting.
  const status = getStatusConfig(targetScore)
  const hasData = !!history && history.length > 0

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="items-center pb-0">
        <CardTitle>{t("Privacy Score")}</CardTitle>
        {hasData ? (
          // The band as a word as well as a color, so the score does not rely on
          // hue alone to communicate (WCAG 1.4.1). The tint carries the color
          // and the text stays `foreground`, which is why this passes contrast
          // on both themes without touching the shared status tokens.
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-foreground ${status.bgColor}`}>
            {t(status.label)}
          </span>
        ) : (
          <CardDescription>{t("Overall protection")}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex-1 pb-0 flex items-center justify-center">
        {history && history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full w-full gap-3 text-center pb-6">
            <div className="p-3 rounded-full bg-muted/50">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t("No data yet")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("Your privacy score will appear here.")}</p>
            </div>
          </div>
        ) : (
          <div className="relative mx-auto aspect-square w-full max-w-[250px]">
            {/* The ring is decoration: the score and its band are read as text
                from the number below and the header chip, so it is hidden from
                assistive technology rather than announced twice. */}
            <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90" aria-hidden="true">
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={RING_STROKE}
                className="stroke-muted"
              />
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                pathLength={RING_PATH_LENGTH}
                strokeDasharray={`${RING_PATH_LENGTH} ${RING_PATH_LENGTH}`}
                strokeDashoffset={RING_PATH_LENGTH - currentScore}
                style={{
                  stroke: status.gauge,
                  filter: RING_SHADOW,
                  // A CSS transition rather than a chart library animation, so
                  // the global prefers-reduced-motion rule actually stops it.
                  transition: "stroke-dashoffset 1500ms ease-out, stroke 300ms ease-out",
                }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-4xl font-bold text-foreground">{Math.ceil(currentScore)}</span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
          </div>
        )}
      </CardContent>
      {hasData && (
        <CardFooter className="flex-col gap-2 text-sm">
          <div className="flex items-center justify-center gap-2 font-medium leading-none text-center">
            {scoreChange === 0
              ? `${t("Score is stable")} ${timeText}`
              : `${t("Trending")} ${isUp ? t('up') : t('down')} ${t("by")} ${Math.ceil(Math.abs(scoreChange))} ${t("pts")} ${timeText}`}
            {isUp ? <TrendingUp className="h-4 w-4 shrink-0" /> : <TrendingDown className="h-4 w-4 shrink-0" />}
          </div>
          <div className="leading-none text-muted-foreground text-center">
            {t("Showing current privacy score")}
          </div>
        </CardFooter>
      )}
    </Card>
  )
}
