"use client"

import React, { createContext, useContext, useEffect, useRef, useState } from "react"
import { Lock, Key, ShieldUser, AlertCircle, OctagonAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { deriveKeyFromPassword, generateSalt, exportKey, verifySaltUniqueness } from "@/lib/crypto"
import { storage } from "@/lib/storage"
import { captureError } from "@/lib/diagnostics"

import PrivacyPolicyPage from "@/components/traceguard/pages/privacy-policy"
import { useTranslation } from "react-i18next";

type AuthState = "loading" | "setup" | "locked" | "unlocked"

interface AuthContextType {
  authState: AuthState
  unlock: (password: string) => Promise<boolean>
  setup: (password: string, name: string) => Promise<boolean>
  lock: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error("useAuth must be used within AuthProvider")
  return context
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const { t } = useTranslation();
  const [authState, setAuthState] = useState<AuthState>("loading")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [userName, setUserName] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false)
  const [backoffSeconds, setBackoffSeconds] = useState(0)
  const failedAttemptsRef = useRef(0)

  const checkAuth = async () => {
    try {
      const local = await chrome.storage.local.get<{ cryptoSalt?: number[]; validator?: string }>(["cryptoSalt", "validator"])
      if (!local.cryptoSalt || !local.validator) {
        setAuthState("setup")
        return
      }

      const session = await chrome.storage.session.get("cryptoKeyHex")
      if (session.cryptoKeyHex) {
        setAuthState("unlocked")
      } else {
        setAuthState("locked")
      }
    } catch (error) {
      // Fail closed. Treating an unreadable vault as "no vault yet" used to show
      // the account-creation screen over an existing vault, where creating a new
      // one replaces the salt and validator and strands every encrypted entry.
      captureError('ui', error, 'auth_check_failed')
      setError(t("Could not read your vault settings. Your data is untouched. Reload the extension to try again."))
      setAuthState("locked")
    }
  }

  useEffect(() => {
    checkAuth()
    
    // Listen for alarms or messages that might lock the vault
    const listener = (changes: any, namespace: string) => {
      // chrome.storage.onChanged reports each key as { oldValue, newValue },
      // so a removal has newValue === undefined (never the key === undefined).
      if (namespace === "session" && changes.cryptoKeyHex?.newValue === undefined) {
        // Key was removed from session (e.g. by auto-lock)
        checkAuth()
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])



  const setup = async (pwd: string, name: string) => {
    setLoading(true)
    setError("")
    try {
      // Generate a new salt
      const salt = generateSalt()
      if (!verifySaltUniqueness(salt)) {
        throw new Error(t("Cryptographic salt validation failed. Please try again."))
      }
      const saltArray = Array.from(salt)
      
      // Derive key
      const key = await deriveKeyFromPassword(pwd, salt)
      const keyHex = await exportKey(key)
      
      // Create a validator hash to check the password later without storing it
      // We'll just encrypt a known string "TraceGuardValidator"
      const encoder = new TextEncoder()
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encryptedValidator = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode("TraceGuardValidator")
      )
      
      const combined = new Uint8Array(iv.length + encryptedValidator.byteLength)
      combined.set(iv, 0)
      combined.set(new Uint8Array(encryptedValidator), iv.length)
      const validatorBase64 = btoa(String.fromCharCode(...combined))

      // Save salt and validator to disk
      await chrome.storage.local.set({ 
        cryptoSalt: saltArray,
        validator: validatorBase64,
        userName: name
      })

      // Save key to memory
      await chrome.storage.session.set({ cryptoKeyHex: keyHex })
      
      setPassword("")
      setConfirmPassword("")
      setAuthState("unlocked")
      return true
    } catch (err: any) {
      setError(err.message || t("Setup failed"))
      return false
    } finally {
      setLoading(false)
    }
  }

  const unlock = async (pwd: string) => {
    setLoading(true)
    setError("")
    try {
      const local = await chrome.storage.local.get<{ cryptoSalt?: number[]; validator?: string }>(["cryptoSalt", "validator"])
      if (!local.cryptoSalt || !local.validator) {
        setError(t("Vault not set up"))
        setLoading(false)
        return false
      }
      const salt = new Uint8Array(local.cryptoSalt)
      
      const key = await deriveKeyFromPassword(pwd, salt)
      
      // Verify password by decrypting the validator
      const binary = atob(local.validator)
      const combined = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i)
      
      const iv = combined.slice(0, 12)
      const ciphertext = combined.slice(12)
      
      try {
        const decryptedBuffer = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          ciphertext
        )
        const decoder = new TextDecoder()
        if (decoder.decode(decryptedBuffer) !== "TraceGuardValidator") {
          throw new Error("Invalid password")
        }
      } catch (e) {
        throw new Error("Invalid password")
      }

      // Valid! Save to session
      const keyHex = await exportKey(key)
      await chrome.storage.session.set({ cryptoKeyHex: keyHex })
      
      // Notify background to flush buffers
      chrome.runtime.sendMessage({ type: "UNLOCK_VAULT" })
      
      failedAttemptsRef.current = 0
      setPassword("")
      setAuthState("unlocked")
      return true
    } catch (err: any) {
      // Progressive backoff: slows down brute-force attempts from the UI.
      // Show a live countdown so the wait never looks like a frozen button.
      failedAttemptsRef.current += 1
      const waitMs = Math.min(30000, 500 * failedAttemptsRef.current)
      const totalSeconds = Math.ceil(waitMs / 1000)
      setBackoffSeconds(totalSeconds)
      setError(totalSeconds > 1
        ? t("Too many attempts — retrying in {{seconds}}s", { seconds: totalSeconds })
        : t("Incorrect Master Password"))
      const startedAt = Date.now()
      await new Promise<void>((resolve) => {
        const tick = () => {
          const remaining = Math.max(0, Math.ceil((waitMs - (Date.now() - startedAt)) / 1000))
          setBackoffSeconds(remaining)
          if (remaining <= 0) resolve()
          else setTimeout(tick, 200)
        }
        tick()
      })
      setBackoffSeconds(0)
      setError(t("Incorrect Master Password"))
      return false
    } finally {
      setLoading(false)
    }
  }

  const lock = async () => {
    await chrome.storage.session.remove("cryptoKeyHex")
    setPassword("")
    setAuthState("locked")
  }

  const resetVault = async () => {
    await storage.clearAll()
    setPassword('')
    setError('')
    setAuthState('setup')
  }

  if (authState === "loading") {
    return <div className="flex h-screen items-center justify-center bg-background"><ShieldUser className="h-8 w-8 animate-pulse text-foreground" /></div>
  }

  if (authState === "setup") {
    if (showPrivacyPolicy) {
      return (
        <div className="flex min-h-screen flex-col bg-background">
          <div className="p-6">
            <Button variant="outline" onClick={() => setShowPrivacyPolicy(false)}>
              {t("← Back to Setup")}</Button>
          </div>
          <div className="flex-1 overflow-auto">
            <PrivacyPolicyPage />
          </div>
        </div>
      )
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-6 md:p-10">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex aspect-square size-8 items-center justify-center mx-auto mb-2">
              <ShieldUser className="size-6 text-foreground" />
            </div>
            <CardTitle className="text-xl">{t("Secure Your Vault")}</CardTitle>
            <CardDescription>
              {t("Create a Master Password to encrypt your privacy logs.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => {
              e.preventDefault()
              if (password !== confirmPassword) {
                setError(t("Passwords do not match"))
                return
              }
              if (password.length < 10) {
                setError(t("Password must be at least 10 characters"))
                return
              }
              if (!/[A-Z]/.test(password)) {
                setError(t("Password must contain at least one uppercase letter"))
                return
              }
              if (!/[0-9]/.test(password)) {
                setError(t("Password must contain at least one number"))
                return
              }
              if (!/[^A-Za-z0-9]/.test(password)) {
                setError(t("Password must contain at least one special character (!@#$%...)")) 
                return
              }
              if (userName.trim().length === 0) {
                setError(t("Name is required"))
                return
              }
              setup(password, userName.trim())
            }}>
              <div className="grid gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="setup-name">{t("What should we call you?")}</Label>
                  <Input
                    id="setup-name"
                    type="text"
                    placeholder={t("Your name")}
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="setup-password">{t("Master Password")}</Label>
                  <PasswordInput
                    id="setup-password"
                    placeholder={t("Enter password")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    required
                  />
                  {password.length > 0 && (() => {
                    const checks = [
                      password.length >= 10,
                      /[A-Z]/.test(password),
                      /[0-9]/.test(password),
                      /[^A-Za-z0-9]/.test(password),
                    ];
                    const strength = checks.filter(Boolean).length;
                    const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500'];
                    const labels = [t('Weak'), t('Fair'), t('Good'), t('Strong')];
                    return (
                      <div className="space-y-1">
                        <div className="flex gap-1">
                          {colors.map((color, i) => (
                            <div
                              key={i}
                              className={`h-1 flex-1 rounded-full transition-all ${i < strength ? color : 'bg-muted'}`}
                            />
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("Strength:")}{labels[strength - 1] ?? t('Very weak')} {t("— min 10 chars, uppercase, number & special character required")}</p>
                      </div>
                    );
                  })()}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="setup-confirm">{t("Confirm Password")}</Label>
                  <PasswordInput
                    id="setup-confirm"
                    placeholder={t("Confirm password")}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>
                {error && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <span>{error}</span>
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? t("Encrypting...") : t("Create Vault")}
                </Button>
              </div>
            </form>
            <div className="mt-4 text-balance text-center text-xs text-muted-foreground [&_button]:underline [&_button]:underline-offset-4 hover:[&_button]:text-primary">
              {t("Before continuing, please review our ")}<button type="button" onClick={() => setShowPrivacyPolicy(true)}>{t("Privacy Policy")}</button>.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (authState === "locked") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-6 md:p-10">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex aspect-square size-8 items-center justify-center mx-auto mb-2">
              <ShieldUser className="size-6 text-foreground" />
            </div>
            <CardTitle className="text-xl">{t("Vault Locked")}</CardTitle>
            <CardDescription>
              {t("Enter your Master Password to access your privacy logs.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => {
              e.preventDefault()
              unlock(password)
            }}>
              <div className="grid gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="locked-password">{t("Master Password")}</Label>
                  <PasswordInput
                    id="locked-password"
                    placeholder={t("Enter password")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    autoFocus
                    required
                  />
                </div>
                {error && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <span>{error}</span>
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={loading || backoffSeconds > 0 || !password}>
                  <Key className="mr-2 h-4 w-4" />
                  {backoffSeconds > 0
                    ? t("Retrying in {{seconds}}s", { seconds: backoffSeconds })
                    : loading ? t("Unlocking...") : t("Unlock Vault")}
                </Button>
              </div>
            </form>
            <div className="mt-4 text-balance text-center text-xs text-muted-foreground [&_button]:underline [&_button]:underline-offset-4 hover:[&_button]:text-primary">
              {t("Forgot password?")}{" "}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    disabled={loading}
                  >
                    {t("Reset vault")}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("Reset vault?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("Reset TraceGuard to factory defaults? This permanently deletes ALL data and you'll create a new Master Password.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={resetVault}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t("Delete Data")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <AuthContext.Provider value={{ authState, unlock, setup, lock }}>{children}</AuthContext.Provider>
}
