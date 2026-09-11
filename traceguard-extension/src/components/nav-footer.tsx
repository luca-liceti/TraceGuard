"use client"

import { useTranslation } from "react-i18next"
import { toast } from "@/components/ui/toast"
import { useNavigate } from "react-router-dom"
import {
  Bug,
  Check,
  ChevronsUpDown,
  ExternalLink,
  Globe,
  HelpCircle,
  Lock,
  Settings,
  Shield,
} from "lucide-react"

import { openIssues } from "@/lib/support"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useSettingsModal } from "@/components/traceguard/settings-context"
import { useAuth } from "@/components/traceguard/auth-provider"

export function NavFooter({ user }: { user: { name: string, email: string } }) {
  const { isMobile } = useSidebar()
  const { t, i18n } = useTranslation()
  const { setSettingsOpen } = useSettingsModal()
  const { lock } = useAuth()
  const navigate = useNavigate()

  const languages = [
    { code: "en", name: "English (United States)" },
    { code: "fr", name: "Français (France)" },
    { code: "de", name: "Deutsch (Deutschland)" },
    { code: "es", name: "Español (España)" },
  ]

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src="" alt={user.name} />
                <AvatarFallback className="rounded-lg bg-muted text-foreground">
                  {user.name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight ml-2">
                <span className="truncate font-semibold">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "top"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings className="mr-2 size-4" />
                {t("Settings")}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Globe className="mr-2 size-4" />
                  <span>{t("Language")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    {languages.map((lang) => (
                      <DropdownMenuItem
                        key={lang.code}
                        onClick={() => {
                          const oldLanguage = i18n.language;
                          i18n.changeLanguage(lang.code);
                          const toastId = toast.add({
                            description: t("Language changed successfully."),
                            actionProps: {
                              children: t("Undo"),
                              onClick: () => {
                                i18n.changeLanguage(oldLanguage);
                                toast.close(toastId);
                              },
                            },
                          });
                        }}
                      >
                        <span>{lang.name}</span>
                        {i18n.language === lang.code && (
                          <Check className="ml-auto size-4 text-primary" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => navigate('/help')}>
                <HelpCircle className="mr-2 size-4" />
                {t("Help & Documentation")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/privacy-policy')}>
                <Shield className="mr-2 size-4" />
                {t("Privacy policy")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openIssues()}>
                <Bug className="mr-2 size-4" />
                {t("Report an Issue")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => lock()}>
              <Lock className="mr-2 size-4" />
              {t("Lock Extension")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
