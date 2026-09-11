"use client"

import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "@/components/ui/toast"

import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { importAllData, MAX_BACKUP_BYTES } from "@/lib/export"

export function ImportDataDialog({
    open,
    onOpenChange,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const [password, setPassword] = useState("")
    const [fileName, setFileName] = useState("")
    const [error, setError] = useState("")
    const [importing, setImporting] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const reset = () => {
        setPassword("")
        setFileName("")
        setError("")
    }

    const handleFile = async (file: File | undefined) => {
        if (!file) return
        setError("")
        setFileName(file.name)
        if (file.size > MAX_BACKUP_BYTES) {
            setError(t("This backup is too large to import (50 MB limit)."))
            if (fileInputRef.current) fileInputRef.current.value = ""
            return
        }
        setImporting(true)
        try {
            const text = await file.text()
            const restored = await importAllData(text, password.length > 0 ? password : null)
            toast.add({
                type: "success",
                title: t("Data Imported"),
                description: t("Restored {{count}} data group(s) from your backup.", { count: restored.length }),
            })
            onOpenChange(false)
            reset()
        } catch (e) {
            console.error(e)
            setError(e instanceof Error ? e.message : t("Could not import data. Please try again."))
        } finally {
            setImporting(false)
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) reset()
                onOpenChange(next)
            }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("Import Data")}</DialogTitle>
                    <DialogDescription>
                        {t("Restore a TraceGuard JSON backup. Your vault must be unlocked.")}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-2">
                    <div className="grid gap-2">
                        <Label htmlFor="import-file">{t("Backup file")}</Label>
                        <input
                            ref={fileInputRef}
                            id="import-file"
                            type="file"
                            accept="application/json,.json"
                            onChange={(e) => handleFile(e.target.files?.[0])}
                            className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90"
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="import-password">{t("Backup password (if encrypted)")}</Label>
                        <Input
                            id="import-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t("Leave blank for unencrypted backups")}
                            disabled={importing}
                        />
                    </div>

                    {fileName && <p className="text-sm text-muted-foreground">{t("Selected:")} {fileName}</p>}
                    {error && <p className="text-sm text-destructive">{error}</p>}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => {
                            onOpenChange(false)
                            reset()
                        }}
                    >
                        {t("Cancel")}
                    </Button>
                    <Button onClick={() => fileInputRef.current?.click()} disabled={importing}>
                        {t("Choose File")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
