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

    return (
        <Card>
            <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">{t("Privacy Score")}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
                <div className={`text-3xl font-bold ${getStatusConfig(ups).color}`}>
                    {ups}
                </div>
                <Progress value={progressUps} className="h-1.5 mt-2" />
            </CardContent>
        </Card>
    );
}
