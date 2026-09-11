import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { getStatusConfig } from "@/lib/risk-utils"

export function ScoreRing({ ups }: { ups: number }) {
    const { t } = useTranslation();
    const [progressUps, setProgressUps] = useState(0);

    useEffect(() => {
        const timer = setTimeout(() => setProgressUps(ups), 100);
        return () => clearTimeout(timer);
    }, [ups]);

    // Same rule as the dashboard ring: the band color is carried by the gauge
    // and the chip, and the number stays `foreground`. The colored digits this
    // used to render were the one thing the two surfaces disagreed about, and
    // `text-warning` and `text-success` were below contrast on the light card.
    const status = getStatusConfig(ups);

    return (
        <Card>
            <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">{t("Privacy Score")}</CardTitle>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-foreground ${status.bgColor}`}>
                    {t(status.label)}
                </span>
            </CardHeader>
            <CardContent className="p-4 pt-0">
                <div className="text-3xl font-bold text-foreground">
                    {ups}
                </div>
                <Progress
                    value={progressUps}
                    className="h-2 mt-2"
                    indicatorStyle={{ backgroundColor: status.gauge }}
                />
            </CardContent>
        </Card>
    );
}
