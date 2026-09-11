import * as React from "react"
import { TrendingUp, TrendingDown, Activity } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  Label,
  PolarGrid,
  PolarRadiusAxis,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
} from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ChartConfig, ChartContainer } from "@/components/ui/chart"
import { useAppState, useScoreHistory } from "@/lib/useStorage"

const chartConfig = {
  visitors: {
    label: "Score",
  },
  score: {
    label: "Score",
    color: "var(--primary)",
  },
} satisfies ChartConfig

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
  
  const chartData = [
    { name: "score", visitors: currentScore, fill: "var(--color-score)" },
  ]
  
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

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="items-center pb-0">
        <CardTitle>{t("Privacy Score")}</CardTitle>
        <CardDescription>{t("Overall protection")}</CardDescription>
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
          <ChartContainer
            config={chartConfig}
            className="mx-auto aspect-square w-full max-w-[250px]"
          >
            <RadialBarChart
              data={chartData}
              startAngle={90}
              endAngle={-270}
              innerRadius={80}
              outerRadius={110}
            >
              <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
              <PolarGrid
                gridType="circle"
                radialLines={false}
                stroke="none"
                className="first:fill-muted last:fill-background"
                polarRadius={[86, 74]}
              />
              <RadialBar 
                dataKey="visitors" 
                background 
                cornerRadius={10} 
                isAnimationActive={true}
                animationDuration={1500}
                animationEasing="ease-out"
              />
              <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      return (
                        <text
                          x={viewBox.cx}
                          y={viewBox.cy}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          <tspan
                            x={viewBox.cx}
                            y={viewBox.cy}
                            className="fill-foreground text-4xl font-bold"
                          >
                            {Math.ceil(chartData[0].visitors)}
                          </tspan>
                          <tspan
                            x={viewBox.cx}
                            y={(viewBox.cy || 0) + 24}
                            className="fill-muted-foreground"
                          >
                            / 100
                          </tspan>
                        </text>
                      )
                    }
                  }}
                />
              </PolarRadiusAxis>
            </RadialBarChart>
          </ChartContainer>
        )}
      </CardContent>
      {(history && history.length > 0) && (
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
