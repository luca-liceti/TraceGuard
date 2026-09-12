import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  LayoutGrid,
  BarChart2,
  Footprints,
  ShieldAlert,
  SlidersHorizontal,
  ShieldUser,
} from "lucide-react"

import { NavMain } from "@/components/nav-main"
import { NavFooter } from "@/components/nav-footer"
import { useLocation } from "react-router-dom"
import { useUserName } from "@/lib/useStorage"
import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar"

// This is the dashboard data
const data = {
  navMain: [
    {
      title: "Overview",
      url: "#/overview",
      icon: LayoutGrid,
      isActive: false,
    },
    {
      title: "Your Footprint",
      url: "#/exposure",
      icon: Footprints,
      isActive: false,
    },
    {
      title: "Rankings & Stats",
      url: "#/rankings",
      icon: BarChart2,
      isActive: false,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const userName = useUserName()
  const [greeting, setGreeting] = React.useState("")
  
  React.useEffect(() => {
    if (userName) {
      const g = [
        t("Welcome back, {{name}} 👋", { name: userName }),
        t("Ready to browse safely, {{name}}?", { name: userName }),
        t("Good to see you, {{name}}", { name: userName })
      ]
      setGreeting(g[Math.floor(Math.random() * g.length)])
    }
  }, [userName])

  const location = useLocation()

  const navItems = React.useMemo(() => {
    return data.navMain.map(item => ({
      ...item,
      isActive: location.pathname.includes(item.url.replace("#", ""))
    }))
  }, [location.pathname])

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              <div className="flex aspect-square size-8 items-center justify-center group-data-[state=expanded]:-ml-2 group-data-[state=expanded]:-mr-2">
                <ShieldUser className="size-6 text-foreground" />
              </div>
              <div className="flex flex-1 items-center text-left text-sm leading-tight">
                <span className="truncate font-semibold text-lg text-foreground">
                  {t("TraceGuard")}
                </span>
                <span className="truncate font-semibold text-lg text-muted-foreground ml-1">
                  {t("Dashboard")}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
      <SidebarFooter>
        {greeting && (
          <div className="px-4 py-2 text-xs text-muted-foreground font-medium animate-in fade-in slide-in-from-bottom-2 duration-500 group-data-[state=collapsed]:hidden">
            {greeting}
          </div>
        )}
        <NavFooter user={{ name: userName || t("User"), email: "TraceGuard Vault" }} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
